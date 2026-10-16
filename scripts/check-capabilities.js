/*
  Checks the capability preflight (utilities/capabilities.js): what each report reads of a save, and what a save that lacks some of it leaves supported.

  node scripts/check-capabilities.js [--write]

  --write regenerates utilities/capability-reads.js from the renderer's sources (scripts/lib/capability-scan.js). Without it the file is compared with a fresh scan and any difference fails: a page that reads a column the file does not list would otherwise pass the preflight unchecked. Regenerate after changing a page's queries.

  The registry is checked against the page registry (every page that reads the save has an entry, the optional inputs are the ones a page really goes on without, every read built by name or listed without its table has columns in the registry or a stated reason, the lists those columns come from match the pages' own, soft groups exist, every gated route is a report). The preflight runs on the saves named below, opened as the app opens one (read-write mode without creating, through Sequelize), and a fixture that is not there is skipped and said so:
  - the two real saves (AuroraDB.db, saves/AuroraDB_271_skoormit_saved.db): every report supported, the formula version 2.7.x, every lookup row as expected, no diagnostic;
  - older fixtures (2.6-shaped, the pre-2.6 ones): the reports and gates that differ are named, and what stays supported;
  - copies of a 2.7 save in the temp folder, each altered one way: a commander rank column dropped (only /commanders degrades, naming it), a core column dropped (only that report is unsupported), the rank table dropped, a bonus renamed or turned from a rating to a multiplier (the gate fails, the reports it feeds degrade, others stay supported), the component type renamed;
  - the consumers of the result, on the real modules (utilities/commanders.js, mixins/production-modifiers.js, store/capabilities.js, utilities/capabilities.js): a renamed bonus leaves the officer bonuses, the colony capacities and the governor review unknown, no assessment blocks every lookup ID, a failed retry keeps the result of the same copy and a result of another copy is dropped. Each of those checks is run again on a copy of the code with one gate taken out, and must fail there;
  - the Commanders page's own roster queries (taken from its source) run on copies without a rank or age column, on the parts the preflight chose, and fail on the parts of a complete save;
  - what a built-by-name read depends on: each marker of an input stands for its own columns (`Reserve*` for the reserves, a bare `*` for the minerals, and the share its page loads for the command types, `MARKER_USES`, which is compared with the page's own `share: '<name>'`). Copies without FCT_Population.ReserveDuranium, FuelStockpile or MaintenanceStockpile, or without the Industrial, Survey or Tactical share, leave supported every report that does not read the column by name (the readers are derived from the generated reads) and make the others unsupported, naming it; a copy of the code that stands every marker for the whole list of its table must fail those checks. On the copy without ReserveDuranium the Mineral Outlook page's own stockpile read runs and the Minerals page's colony read (which names the reserves) fails;
  - the pages' own wiring (scripts/lib/capability-pages.js): the real script of /lagrange, /commanders and /production run on the capability results of real copies (the unverified lookup rows and missing ship columns withhold the stabilisation ships, the roster's blocked bonuses are unknown and its queries wait for the check, the research read and the colony capacities leave a blocked bonus unknown). Each page is run again with one gate cut out of its script, and a page check must fail there;
  - the file's SHA-256 before and after a preflight on a copy, and that every query the preflight sent was a select.
*/
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const sqlite3 = require('sqlite3')
const { Sequelize } = require('sequelize')
const { loadUtilities } = require('./lib/utilities')
const { scanReads } = require('./lib/capability-scan')
const { chainChecks } = require('./lib/capability-chains')
const { pageChecks } = require('./lib/capability-pages')

const repo = path.resolve(__dirname, '..')
const OPEN_EXISTING = 0x2
const READS_FILE = path.join(repo, 'src', 'renderer', 'utilities', 'capability-reads.js')
const PLANNED_ROUTES = new Set(['/settings', '/about'])

const REAL = [
  { label: 'modded 2.7 save', file: 'AuroraDB.db' },
  { label: 'stock 2.7.1 save', file: 'saves/AuroraDB_271_skoormit_saved.db' },
]

const OLDER = [
  { label: 'G260 base', file: 'AuroraDB_260_base.db' },
  { label: 'G270 base', file: 'AuroraDB_270_base.db' },
  { label: 'Old64 (Pepega)', file: 'AuroraDB_Pepega.db' },
  { label: 'OldDde (Offline Elminster)', file: 'AuroraDB_OfflineElminster.db' },
]

let checks = 0
let failures = 0

const check = (message, condition, detail = '') => {
  checks += 1

  if (condition) {
    console.log(`ok    ${message}`)
  } else {
    failures += 1
    console.error(`FAIL  ${message}${detail ? `: ${detail}` : ''}`)
  }
}

const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// An object key as standard style writes it: bare when it is an identifier, quoted otherwise.
const property = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key))

const readsText = (reads) => Object.entries(reads).sort(([a], [b]) => a.localeCompare(b)).map(([table, columns]) => (columns.length ? `${table}(${[...columns].sort().join(' ')})` : table)).join(' ')

// The text of utilities/capability-reads.js for a scan: an input with no read of the save is left out, a route with no input likewise.
const generated = (scan) => {
  const routes = Object.entries(scan).filter(([, inputs]) => inputs).map(([route, inputs]) => [route, Object.entries(inputs).filter(([, input]) => Object.keys(input.reads).length)]).filter(([, inputs]) => inputs.length)
  const lines = routes.map(([route, inputs]) => `  ${property(route)}: {\n${inputs.map(([key, input]) => `    ${property(key)}: { label: ${quote(input.label)}, reads: ${quote(readsText(input.reads))} },`).join('\n')}\n  },`)

  return `// Generated by \`node scripts/check-capabilities.js --write\` from the pages' own queries: do not edit by hand. Per report (a route of the page registry, or 'shell' for what the app reads outside a page), each input it reads (the page's tracked reads, the warnings page's checks) with its label and the tables and columns its code names, as 'Table(Column Column)'. utilities/capabilities.js adds what the scan cannot see and says which inputs a report cannot do without.\nexport const READS = {\n${lines.join('\n')}\n}\n`
}

const openSave = (file, log) => {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: file, logging: false, dialectOptions: { mode: OPEN_EXISTING } })
  const query = sequelize.query.bind(sequelize)

  sequelize.query = (sql, options) => {
    log.push(sql)

    return query(sql, options)
  }

  return sequelize
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const run = (database, sql) => new Promise((resolve, reject) => {
  database.exec(sql, (error) => (error ? reject(error) : resolve()))
})

// A copy of `source` in the temp folder with `statements` run on it.
const alteredCopy = async (source, name, statements) => {
  const copy = path.join(os.tmpdir(), `ae-capabilities-${process.pid}-${name}.db`)

  fs.copyFileSync(source, copy)

  const database = new sqlite3.Database(copy)

  for (const statement of statements) {
    await run(database, statement)
  }

  await new Promise((resolve) => database.close(resolve))

  return copy
}

const summary = (result) => {
  const counts = { supported: 0, degraded: 0, unsupported: 0 }

  Object.values(result.reports).forEach((report) => {
    counts[report.status] += 1
  })

  return `${counts.supported} supported, ${counts.degraded} degraded, ${counts.unsupported} unsupported`
}

const notSupported = (result) => Object.values(result.reports).filter((report) => report.status !== 'supported')

const failedGates = (result) => [...Object.entries(result.gates.bonuses).map(([id, gate]) => [`bonus ${id}`, gate]), ...Object.entries(result.gates.components).map(([id, gate]) => [`component type ${id}`, gate])].filter(([, gate]) => gate.status === 'unavailable').map(([name]) => name)

const preflightOf = async (capabilities, file) => {
  const log = []
  const database = openSave(file, log)

  try {
    const result = await capabilities.preflight(database)

    return { result, log }
  } finally {
    await database.close()
  }
}

const registryChecks = (capabilities, scan, navigation) => {
  const routes = navigation.PAGES.map((page) => page.route)

  routes.filter((route) => !PLANNED_ROUTES.has(route)).forEach((route) => {
    check(`registry: ${route} has reads`, Boolean(capabilities.INPUTS[route] && capabilities.INPUTS[route].length))
  })

  PLANNED_ROUTES.forEach((route) => check(`registry: ${route} reads nothing of the save and is never gated`, !capabilities.INPUTS[route]))

  const optional = Object.entries(capabilities.INPUTS).flatMap(([route, inputs]) => inputs.filter((input) => input.optional).map((input) => `${route} ${input.key}`))
  const expectedOptional = [...(capabilities.INPUTS['/warnings'] || []).filter((input) => input.key.startsWith('check:')).map((input) => `/warnings ${input.key}`), '/lagrange ships', '/colony-outlook bootstrapSources', '/colony-outlook colonistSources', '/mineral-outlook siteDeposits', '/mineral-outlook deploymentSources', '/finances shippingTax', '/information avoidSystems', '/hauling avoidSystems', '/information handlingSupport', '/hauling handlingSupport']

  check('registry: the optional inputs are the checks of /warnings, the ships of /lagrange, the mine bootstrap and colonist source reads of /colony-outlook, the sites reads of /mineral-outlook, the shipping-line tax read of /finances and the avoid settings\' systems read and the officers\' Logistics read of /information and /hauling, every other input is required', optional.length === expectedOptional.length && expectedOptional.every((name) => optional.includes(name)), optional.join(', '))

  Object.entries(capabilities.INPUTS).forEach(([route, inputs]) => inputs.forEach((input) => {
    Object.entries(input.resolved).forEach(([table, resolved]) => {
      const columns = input.reads[table] || []
      // A table with an entry in `MARKER_COLUMNS` resolves each marker to columns of its list. A table without one (the built-by-name reads of the installations and a few places) has the columns named by the input, in `EXTRA_READS` or by the scan, and a marker's prefix must match one of them.
      const stands = (marker) => (capabilities.MARKER_COLUMNS[table] ? resolved[marker].length > 0 : columns.some((column) => column.length > marker.length - 1 && column.startsWith(marker.slice(0, -1))))

      check(`registry: ${route} ${input.key} names the columns its built-by-name ${table} read stands for`, Object.keys(resolved).every(stands), `${table}(${Object.keys(resolved).join(' ')})`)
    })

    const bare = Object.entries(input.reads).filter(([table, columns]) => !columns.length && !input.tolerated[table]).map(([table]) => table)

    check(`registry: ${route} ${input.key} names a column of every table it reads, or says why not`, bare.length === 0, bare.join(', '))
  }))

  check('registry: MARKER_USES has an entry for each page that loads the naval admin commands of a share, and for no other', Object.keys(capabilities.MARKER_USES).sort().join() === Object.keys(SHARE_SOURCES).sort().join(), Object.keys(capabilities.MARKER_USES).join())

  Object.entries(capabilities.MARKER_USES).forEach(([route, inputs]) => Object.entries(inputs).forEach(([key, tables]) => {
    const input = (capabilities.INPUTS[route] || []).find((entry) => entry.key === key)

    check(`registry: MARKER_USES ${route} ${key} is an input of the report with a bare built-by-name read of each table it lists, which it resolves`, Boolean(input) && Object.keys(tables).every((table) => input.markers[table] && input.markers[table].includes('*') && input.resolved[table]['*'].join() === tables[table].join()), key)

    Object.entries(tables).forEach(([table, columns]) => {
      const listed = capabilities.MARKER_COLUMNS[table] || []

      check(`registry: MARKER_USES ${route} ${key} names columns of ${table} that its built-by-name list holds`, columns.length > 0 && columns.every((column) => listed.includes(column)), columns.join(', '))
    })

    const shares = SHARE_SOURCES[route] ? sharesOf(route) : []

    check(`registry: MARKER_USES ${route} ${key} names the share its page loads (${SHARE_SOURCES[route]})`, tables.DIM_NavalAdminCommandType && shares.join() === [...tables.DIM_NavalAdminCommandType].sort().join(), `${shares.join()} in the source`)
  }))

  const unused = Object.entries(capabilities.INPUTS).flatMap(([route, inputs]) => inputs.filter((input) => (input.markers.DIM_NavalAdminCommandType || []).includes('*') && !(capabilities.MARKER_USES[route] && capabilities.MARKER_USES[route][input.key] && capabilities.MARKER_USES[route][input.key].DIM_NavalAdminCommandType)).map((input) => `${route} ${input.key}`))

  check('registry: every input that builds a command-type share by name has the share its page uses in MARKER_USES, instead of all of them', unused.length === 0, unused.join(', '))

  Object.entries(capabilities.SOFT).forEach(([route, groups]) => {
    const read = new Set((capabilities.INPUTS[route] || []).flatMap((input) => Object.entries(input.reads).flatMap(([table, columns]) => [`${table}.*`, ...columns.map((column) => `${table}.${column}`)])))

    groups.forEach((group) => {
      check(`registry: every field of the ${route} group "${group.key}" is read by the report`, group.fields.every((field) => read.has(field)), group.fields.filter((field) => !read.has(field)).join(', '))
    })
  })

  const gated = new Set([...Object.values(capabilities.BONUS_NAMES), ...Object.values(capabilities.COMPONENT_TYPES)].flatMap((gate) => gate.routes))

  check('registry: every route a lookup gate names is a report', [...gated].every((route) => capabilities.REPORT_ROUTES.includes(route)), [...gated].filter((route) => !capabilities.REPORT_ROUTES.includes(route)).join(', '))
  check('registry: every route of the scan with inputs is a report (or the shell)', Object.keys(scan).filter((route) => scan[route] && Object.keys(scan[route]).length).every((route) => route === 'shell' || capabilities.REPORT_ROUTES.includes(route) || Object.values(scan[route]).every((input) => !Object.keys(input.reads).length)))
}

const realSaveChecks = async (capabilities, save) => {
  const file = path.resolve(repo, save.file)

  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${save.label}: ${save.file} is not there (not run)`)

    return
  }

  const { result } = await preflightOf(capabilities, file)

  console.log(`INFO  ${save.label}: ${result.tables} tables, ${result.columns} columns; ${summary(result)}; formula ${result.formula.status} ${result.formula.value || ''}`)
  check(`${save.label}: every report is supported`, notSupported(result).length === 0, notSupported(result).map((report) => `${report.route} ${report.status} ${JSON.stringify([...report.missing, ...report.degraded])}`).join('; '))
  check(`${save.label}: the shell is supported`, result.shell.status === 'supported', JSON.stringify(result.shell))
  check(`${save.label}: every lookup row reads as expected`, failedGates(result).length === 0, failedGates(result).join(', '))
  check(`${save.label}: the formula version is the stated one, as an assumption`, result.formula.value === capabilities.STATED_FORMULA_VERSION && result.formula.status === 'assumed')
  check(`${save.label}: the commanders soft groups are both whole`, result.reports['/commanders'].groups.rank === true && result.reports['/commanders'].groups.age === true)
}

const olderChecks = async (capabilities, save) => {
  const file = path.resolve(repo, save.file)

  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${save.label}: ${save.file} is not there (not run)`)

    return null
  }

  const { result } = await preflightOf(capabilities, file)

  console.log(`INFO  ${save.label}: ${result.tables} tables, ${result.columns} columns; ${summary(result)}; formula ${result.formula.status}; failed lookups: ${failedGates(result).join(', ') || 'none'}`)
  notSupported(result).forEach((report) => console.log(`INFO  ${save.label}: ${report.route} ${report.status}: ${[...report.missing, ...report.degraded].map((entry) => `${entry.label} (${entry.fields.slice(0, 4).join(', ')}${entry.fields.length > 4 ? `, ${entry.fields.length - 4} more` : ''})`).join('; ')}`))

  return result
}

const alteredChecks = async (capabilities, source) => {
  const copies = []
  const unrelated = (result, ...routes) => Object.values(result.reports).filter((report) => !routes.includes(report.route)).every((report) => report.status === 'supported')
  // The reports other than `route` that are not supported, each only degraded and by an input that names `field` (a report that reads the field for another purpose, such as the naval commands' captains' ranks).
  const alsoReading = (result, route, field) => Object.values(result.reports).filter((report) => report.route !== route && !NAVAL_ADMIN_ROUTES.includes(report.route) && report.status !== 'supported').every((report) => report.status === 'unsupported' && report.missing.every((entry) => entry.fields.includes(field)))
  const NAVAL_ADMIN_ROUTES = ['/production', '/mineral-outlook', '/habitability', '/logistics', '/survey-progress', '/hauling', '/information']
  const SEPARATE = ['/finances', '/routes', '/log', '/propulsion', '/map', '/lagrange', '/technologies', '/designed-tech', '/history', '/intelligence', '/minerals']

  try {
    const rankless = await alteredCopy(source, 'rank', ['alter table FCT_Commander drop column RankID'])
    const coreless = await alteredCopy(source, 'core', ['alter table FCT_Commander drop column RetireStatus'])
    const rankTable = await alteredCopy(source, 'ranks', ['drop table FCT_Ranks'])
    const ageless = await alteredCopy(source, 'age', ['alter table FCT_Species drop column GraduationAge'])
    const renamed = await alteredCopy(source, 'renamed', ["update DIM_CommanderBonusType set Description = 'Mineral Extraction' where BonusID = 6"])
    const terraformRenamed = await alteredCopy(source, 'terraforming', ["update DIM_CommanderBonusType set Description = 'Output' where BonusID = 9"])
    const flipped = await alteredCopy(source, 'flipped', ['update DIM_CommanderBonusType set Percentage = 1 where BonusID = 27'])
    const retyped = await alteredCopy(source, 'component', ["update DIM_ComponentType set TypeDescription = 'Jump Gate Construction' where ComponentTypeID = 29"])
    const noBonusTable = await alteredCopy(source, 'nobonus', ['drop table DIM_CommanderBonusType'])
    const noFormula = await alteredCopy(source, 'formula', ['alter table FCT_Game drop column AncientRelics'])
    const noFinance = await alteredCopy(source, 'finance', ['drop table FCT_WealthData'])
    const noSpecies = await alteredCopy(source, 'species', ['alter table FCT_Commander drop column SpeciesID'])
    const noCrew = await alteredCopy(source, 'crew', ['alter table FCT_Ship drop column CurrentCrew'])
    const noMessage = await alteredCopy(source, 'message', ['alter table FCT_GameLog drop column MessageText'])
    const noMineral = await alteredCopy(source, 'mineral', ['alter table FCT_Population drop column Duranium'])
    const twoRenamed = await alteredCopy(source, 'tworenamed', ["update DIM_CommanderBonusType set Description = 'Output' where BonusID = 5", "update DIM_CommanderBonusType set Description = 'Colonies' where BonusID = 25"])

    copies.push(rankless, coreless, rankTable, ageless, renamed, flipped, retyped, noBonusTable, noFormula, noFinance, noSpecies, noCrew, noMessage, noMineral, twoRenamed)

    const baseline = (await preflightOf(capabilities, source)).result
    const rank = (await preflightOf(capabilities, rankless)).result
    const core = (await preflightOf(capabilities, coreless)).result
    const table = (await preflightOf(capabilities, rankTable)).result
    const age = (await preflightOf(capabilities, ageless)).result
    const rename = (await preflightOf(capabilities, renamed)).result
    const terraform = (await preflightOf(capabilities, terraformRenamed)).result
    const flip = (await preflightOf(capabilities, flipped)).result
    const retype = (await preflightOf(capabilities, retyped)).result
    const noBonus = (await preflightOf(capabilities, noBonusTable)).result
    const formula = (await preflightOf(capabilities, noFormula)).result
    const finance = (await preflightOf(capabilities, noFinance)).result

    check('altered: the unaltered copy supports every report', notSupported(baseline).length === 0 && failedGates(baseline).length === 0)

    const rankReport = rank.reports['/commanders']

    check('altered: FCT_Commander.RankID dropped degrades /commanders, naming the field and the rank group', rankReport.status === 'degraded' && rankReport.missing.length === 0 && rankReport.groups.rank === false && rankReport.groups.age === true && rankReport.degraded.some((entry) => entry.group && entry.key === 'rank' && entry.fields.includes('FCT_Commander.RankID')), JSON.stringify(rankReport))
    check('altered: FCT_Commander.RankID dropped degrades the reports that read the naval admin ranks by the shared group, naming the field and what is left out, and leaves them in service', NAVAL_ADMIN_ROUTES.every((route) => rank.reports[route].status === 'degraded' && rank.reports[route].missing.length === 0 && rank.reports[route].groups.navalRank === false && rank.reports[route].degraded.some((entry) => entry.group && entry.key === 'navalRank' && entry.fields.includes('FCT_Commander.RankID') && /rates|outlook|output/.test(entry.affects))), NAVAL_ADMIN_ROUTES.map((route) => rank.reports[route].status).join())
    check('altered: FCT_Commander.RankID dropped leaves the reports that do not read it supported, and makes the others unsupported only by that read', SEPARATE.every((route) => rank.reports[route].status === 'supported') && alsoReading(rank, '/commanders', 'FCT_Commander.RankID'), notSupported(rank).map((report) => report.route).join(', '))
    check('altered: the formula version and the lookups are unaffected by a rank column', rank.formula.status === 'assumed' && failedGates(rank).length === 0)

    const coreReport = core.reports['/commanders']

    check('altered: FCT_Commander.RetireStatus dropped makes /commanders unsupported, naming the field', coreReport.status === 'unsupported' && coreReport.missing.some((entry) => entry.fields.includes('FCT_Commander.RetireStatus')), JSON.stringify(coreReport.missing))
    check('altered: FCT_Commander.RetireStatus dropped does not make an unrelated report unsupported', ['/finances', '/routes', '/log', '/propulsion', '/map', '/survey-progress', '/lagrange'].every((route) => core.reports[route].status === 'supported'), notSupported(core).map((report) => report.route).join(', '))

    check('altered: FCT_Ranks dropped degrades /commanders by the rank group, naming the table', table.reports['/commanders'].status === 'degraded' && table.reports['/commanders'].degraded.some((entry) => entry.key === 'rank' && entry.fields.includes('FCT_Ranks (table)')) && SEPARATE.every((route) => table.reports[route].status === 'supported'), JSON.stringify(table.reports['/commanders'].degraded))
    check('altered: FCT_Species.GraduationAge dropped degrades /commanders by the age group only', age.reports['/commanders'].status === 'degraded' && age.reports['/commanders'].groups.age === false && age.reports['/commanders'].groups.rank === true && unrelated(age, '/commanders'), JSON.stringify(age.reports['/commanders']))

    check('altered: a renamed bonus (6) fails its lookup instead of mapping silently', failedGates(rename).join() === 'bonus 6' && /Mineral Extraction/.test(rename.gates.bonuses[6].inputs.missing.join()), failedGates(rename).join())
    check('altered: a renamed bonus (6) degrades exactly the reports that read it', Object.values(rename.reports).filter((report) => report.status !== 'supported').map((report) => report.route).sort().join() === [...capabilities.BONUS_NAMES[6].routes].sort().join(), notSupported(rename).map((report) => report.route).join(', '))
    check('altered: a renamed bonus (6) blocks that ID only', [...capabilities.blockedBonuses(rename.gates)].join() === '6')
    check('altered: a renamed Terraforming bonus (9) fails its lookup and degrades exactly /production, /habitability and /commanders', failedGates(terraform).join() === 'bonus 9' && [...capabilities.blockedBonuses(terraform.gates)].join() === '9' && Object.values(terraform.reports).filter((report) => report.status !== 'supported').map((report) => report.route).sort().join() === ['/commanders', '/habitability', '/production'].join(), notSupported(terraform).map((report) => report.route).join(', '))
    check('altered: a renamed Terraforming bonus (9) is named by /habitability with what it leaves out', terraform.reports['/habitability'].degraded.some((entry) => entry.gate && /terraforming/.test(entry.affects)), JSON.stringify(terraform.reports['/habitability'].degraded))
    check('altered: a renamed bonus does not disable /finances', rename.reports['/finances'].status === 'supported')
    check('altered: a rating (27) turned into a multiplier fails its lookup', failedGates(flip).join() === 'bonus 27' && /rating/.test(flip.gates.bonuses[27].inputs.missing.join()), failedGates(flip).join())
    check('altered: a renamed component type (29) degrades /lagrange only', failedGates(retype).join() === 'component type 29' && retype.reports['/lagrange'].status === 'degraded' && unrelated(retype, '/lagrange'), notSupported(retype).map((report) => report.route).join(', '))
    check('altered: DIM_CommanderBonusType dropped fails every bonus lookup, and /commanders (which reads it) is unsupported', failedGates(noBonus).length === Object.keys(capabilities.BONUS_NAMES).length && noBonus.reports['/commanders'].status === 'unsupported')
    check('altered: FCT_Game.AncientRelics dropped makes the formula version unavailable, without touching a report', formula.formula.status === 'unavailable' && formula.formula.inputs.missing.join() === 'FCT_Game.AncientRelics' && notSupported(formula).length === 0, JSON.stringify(formula.formula.inputs))
    const species = (await preflightOf(capabilities, noSpecies)).result
    const crew = (await preflightOf(capabilities, noCrew)).result
    const message = (await preflightOf(capabilities, noMessage)).result
    const mineral = (await preflightOf(capabilities, noMineral)).result
    const two = (await preflightOf(capabilities, twoRenamed)).result

    check('altered: FCT_Commander.SpeciesID dropped degrades /commanders by the age group, naming the join key', species.reports['/commanders'].status === 'degraded' && species.reports['/commanders'].groups.age === false && species.reports['/commanders'].degraded.some((entry) => entry.key === 'age' && entry.fields.includes('FCT_Commander.SpeciesID')), JSON.stringify(species.reports['/commanders']))
    check('altered: FCT_Ship.CurrentCrew dropped leaves /lagrange degraded by its optional ships, naming the field, and not unsupported', crew.reports['/lagrange'].status === 'degraded' && crew.reports['/lagrange'].missing.length === 0 && crew.reports['/lagrange'].degraded.some((entry) => entry.key === 'ships' && entry.fields.includes('FCT_Ship.CurrentCrew')), JSON.stringify(crew.reports['/lagrange']))
    check('altered: FCT_GameLog.MessageText dropped (read through a table alias) makes /log unsupported, naming the field', message.reports['/log'].status === 'unsupported' && message.reports['/log'].missing.some((entry) => entry.fields.includes('FCT_GameLog.MessageText')), JSON.stringify(message.reports['/log']))
    check('altered: FCT_Population.Duranium dropped (a column built by name) makes /mineral-outlook unsupported, naming the field', mineral.reports['/mineral-outlook'].status === 'unsupported' && mineral.reports['/mineral-outlook'].missing.some((entry) => entry.fields.includes('FCT_Population.Duranium')) && mineral.reports['/finances'].status === 'supported', JSON.stringify(mineral.reports['/mineral-outlook'].missing))
    check('altered: two renamed bonuses (5, 25) block those IDs, and the mixin pages and /commanders name what is left out while /minerals is not degraded by them', [...capabilities.blockedBonuses(two.gates)].sort((a, b) => a - b).join() === '5,25' && ['/production', '/colony-outlook', '/logistics', '/mineral-outlook', '/shipyards', '/lagrange', '/commanders'].every((route) => two.reports[route].degraded.some((entry) => entry.gate && /capacity|stabilisation|officer/.test(entry.affects))) && two.reports['/minerals'].status === 'supported', notSupported(two).map((report) => report.route).join(', '))
    check('altered: FCT_WealthData dropped makes /finances unsupported', finance.reports['/finances'].status === 'unsupported' && finance.reports['/finances'].missing.some((entry) => entry.fields.includes('FCT_WealthData (table)')) && finance.reports['/commanders'].status === 'supported', notSupported(finance).map((report) => report.route).join(', '))

    // The preflight never writes: the copy's hash is the same afterwards, and every query was a select.
    const before = sha256(rankless)
    const { log } = await preflightOf(capabilities, rankless)
    const after = sha256(rankless)

    check('immutable: the file hash of a copy is unchanged by a preflight', before === after, `${before} then ${after}`)
    check('immutable: every query the preflight sent is a select', log.length > 0 && log.every((sql) => /^\s*select\b/i.test(sql)), log.filter((sql) => !/^\s*select\b/i.test(sql)).join('; '))
    check('immutable: a retry reads the copy as it is now', (await preflightOf(capabilities, rankless)).result.reports['/commanders'].status === 'degraded')
  } finally {
    copies.forEach((copy) => fs.rmSync(copy, { force: true }))
  }
}

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const CONSUMER_MODULES = ['capabilities', 'commanders', '../mixins/production-modifiers', '../store/capabilities']

const rendererDirectory = path.join(repo, 'src', 'renderer')

// The pages that load the naval admin commands of one share, with the file that names the share (`loadNavalAdmins(..., { share })`): the Colonization Planner's read is in utilities/colonization-data.js, the handling times' of Transport and Hauling in utilities/handling-support.js. `MARKER_USES` gives each of them the share it loads.
const SHARE_SOURCES = {
  '/production': 'pages/production.vue',
  '/mineral-outlook': 'pages/mineral-outlook.vue',
  '/habitability': 'utilities/colonization-data.js',
  '/logistics': 'pages/logistics.vue',
  '/survey-progress': 'pages/survey-progress.vue',
  '/hauling': 'utilities/handling-support.js',
  '/information': 'utilities/handling-support.js',
}

const sharesOf = (route) => [...new Set([...fs.readFileSync(path.join(rendererDirectory, SHARE_SOURCES[route]), 'utf8').matchAll(/\bshare: '(\w+)'/g)].map((match) => match[1]))].sort()

// The lookup rows of a save in which the bonuses `renamed` carry another name (and the component types in `retyped` another description), as `gatesOf` takes them.
const lookupRows = (capabilities, { renamed = [], retyped = [] } = {}) => ({
  bonuses: Object.fromEntries(Object.entries(capabilities.BONUS_NAMES).map(([id, bonus]) => [id, { BonusID: Number(id), Description: renamed.includes(Number(id)) ? `${bonus.name} (renamed)` : bonus.name, Percentage: bonus.percentage ? 1 : 0 }])),
  components: Object.fromEntries(Object.entries(capabilities.COMPONENT_TYPES).map(([id, type]) => [id, { ComponentTypeID: Number(id), TypeDescription: retyped.includes(Number(id)) ? 'Jump Gate Construction' : type.name }])),
})

const LOOKUP_SCHEMA = new Map([['dim_commanderbonustype', new Set(['bonusid', 'description', 'percentage'])], ['dim_componenttype', new Set(['componenttypeid', 'typedescription'])]])

const gatesWith = (capabilities, options) => capabilities.gatesOf(LOOKUP_SCHEMA, lookupRows(capabilities, options))

// A store module over a fake copy of the save: `run(action)` dispatches with a context the way Vuex does, `state` and `getters` are read as a page reads them.
const storeOver = (store, rootState) => {
  const state = store.state()
  const getters = {}
  const commit = (name, payload) => store.mutations[name](state, payload)
  const get = (name) => store.getters[name](state, new Proxy({}, { get: (_target, key) => get(key) }), rootState)

  Object.keys(store.getters).forEach((name) => Object.defineProperty(getters, name, { get: () => get(name) }))

  return { state, getters, run: (action) => store.actions[action]({ commit, rootState }) }
}

// A connection to a copy of a save that can be made to fail the way a locked one does.
const switchable = (file) => {
  const database = openSave(file, [])
  const state = { busy: false }

  return { state, close: () => database.close(), database: { query: (...args) => (state.busy ? Promise.reject(new Error('SQLITE_BUSY: database is locked')) : database.query(...args)) } }
}

// What the consumers of the capability result do with it, run on the real modules: [[statement, held]]. Every statement must hold of the unmutated modules and fail of a module with its gate taken out (`mutationChecks`).
const consumerResults = async (mods, source) => {
  const capabilities = mods.capabilities
  const commanders = mods.commanders
  const mixin = mods['../mixins/production-modifiers']
  const store = mods['../store/capabilities']
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const gates = gatesWith(capabilities, { renamed: [5, 25], retyped: [29] })
  const blocked = capabilities.blockedBonuses(gates)
  const all = Object.keys(capabilities.BONUS_NAMES).map(Number)

  holds('a renamed bonus is blocked, and only that one', [...blocked].sort((a, b) => a - b).join() === '5,25')
  holds('no assessment blocks every bonus ID the planners read, never none', capabilities.blockedBonuses(null).size === all.length && all.every((id) => capabilities.blockedBonuses(null).has(id)))
  holds('a confirmed assessment blocks nothing', capabilities.blockedBonuses(gatesWith(capabilities)).size === 0)

  holds('gateGaps names the renamed lookup row', capabilities.gateGaps(gates, { bonuses: [5] }).join().includes('Production'))
  holds('gateGaps names the retyped component type', capabilities.gateGaps(gates, { components: [29] }).join().includes('Jump Gate Construction'))
  holds('gateGaps is empty when the rows read as expected', capabilities.gateGaps(gatesWith(capabilities), { bonuses: [5, 25], components: [29] }).length === 0)
  holds('gateGaps without an assessment is never empty', capabilities.gateGaps(null, { bonuses: [5] }).length === 1)

  const bonuses = commanders.parseBonuses('5:1.2,25:6,6:1.1', blocked)

  holds('a roster bonus of a blocked ID is unknown, never its stored value', bonuses[5] === null && bonuses[25] === null && bonuses[6] === 1.1)
  holds('a roster chip of a blocked bonus reads as unknown', commanders.formatBonus(25, 6, blocked) !== '6' && commanders.formatBonus(25, 6, new Set()) === '6')

  const ship = { ShipID: 1, ClassName: 'Terraformer', Terraformers: 2, RankRequired: 3 }

  holds('a specialist post that rests on a blocked bonus is unavailable', !isAvailableResult(commanders.specialistPost(ship, new Set([9]))) && isAvailableResult(commanders.specialistPost(ship, new Set())))

  const colony = { PopName: 'Mars', GovernorID: 0, Population: 5, BonusOne: 6, BonusTwo: 0, BonusThree: 0 }
  const admin = (blockedIds) => ({ CommanderID: 7, Name: 'A', CommandType: 0, bonuses: commanders.parseBonuses('6:1.3', blockedIds) })
  const review = (blockedIds) => commanders.governorReview([colony], [admin(blockedIds)], {})

  holds('the governor review ranks an officer on a confirmed bonus', review(new Set()).rows.length === 1)
  holds('the governor review does not rank an officer on a blocked bonus', review(new Set([6])).rows.length === 0)

  const modifiers = { OrdnanceProduction: 2, OverallProductionModifier: 1.5, OrdnanceProductionPower: 3, ShipyardBuildRate: 4, OverallGroundUnitModifier: 6 }
  const gated = mixin.gateModifier(modifiers, new Set([5, 11]))

  holds('a modifier row of a blocked bonus loses that column only', gated.OverallProductionModifier === null && gated.OverallGroundUnitModifier === null && gated.ShipyardBuildRate === 4)
  holds('a modifier row is as read while no bonus is blocked', mixin.gateModifier(modifiers, new Set()).OverallProductionModifier === 1.5)
  holds('a colony capacity with the Production bonus blocked is unavailable and names the lookup', !isAvailableResult(mixin.capacityResult(gated, 'ordnance', new Set([5]))) && mixin.capacityResult(gated, 'ordnance', new Set([5])).inputs.missing.join().includes('bonus 5'))
  holds('a colony capacity is the product while no bonus is blocked', mixin.capacityResult(modifiers, 'ordnance', new Set()).value === 9)
  holds('a colony capacity of a colony the read does not cover is unavailable', !isAvailableResult(mixin.capacityResult(undefined, 'ordnance', new Set())))

  const quiet = console.error
  const connections = [switchable(source), switchable(source), switchable(source)]
  const freshness = { generation: 3 }
  const over = storeOver(store, { database: connections[0].database, freshness })

  console.error = () => {}

  try {
    holds('the store blocks every bonus before any check', over.getters.blockedBonuses.size === all.length)
    await over.run('preflight')
    holds('the store releases the bonuses once the check answered on this copy', over.getters.status === 'ok' && over.getters.blockedBonuses.size === 0)

    connections[1].state.busy = true

    const failed = storeOver(store, { database: connections[1].database, freshness: { generation: 1 } })

    await failed.run('preflight')
    holds('the store blocks every bonus when the first check failed', failed.getters.status === 'failed' && failed.getters.result === null && failed.getters.blockedBonuses.size === all.length)

    const retained = storeOver(store, { database: connections[2].database, freshness: { generation: 5 } })

    await retained.run('preflight')
    connections[2].state.busy = true
    await retained.run('retry')
    holds('a retry that failed keeps the result of the same copy and its lookup gates', retained.getters.status === 'failed' && retained.getters.result !== null && retained.getters.gates !== null && retained.getters.blockedBonuses.size === 0)

    const pending = over.run('retry')

    holds('a check that runs again on the same copy keeps the result of the copy', over.getters.status === 'checking' && over.getters.result !== null)
    await pending
    freshness.generation = 4
    holds('a result of an earlier copy is never returned, and its lookups block every bonus', over.getters.result === null && over.getters.blockedBonuses.size === all.length)
  } finally {
    console.error = quiet
    await Promise.all(connections.map((connection) => connection.close()))
  }

  return results
}

const isAvailableResult = (result) => result.status !== 'unavailable'

// A copy of the utilities, mixins and store folders in the temp folder in which `file` ('utilities/x.js') has `from` replaced by `to`, for a check that its consumers notice a gate taken out.
const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-capabilities-mutant-'))

  ;['utilities', 'mixins', 'store'].forEach((folder) => fs.cpSync(path.join(rendererDirectory, folder), path.join(directory, folder), { recursive: true }))

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    throw new Error(`The mutation of ${file} does not apply: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

const MUTATIONS = [
  ['commanders.js reads a blocked bonus', 'utilities/commanders.js', 'blocked.has(Number(id)) || value === undefined', 'value === undefined'],
  ['the production modifiers ignore a blocked bonus', 'mixins/production-modifiers.js', '(blocked.has(Number(id)) ? { ...gated, [column]: null } : gated)', 'gated'],
  ['the capacity result ignores a blocked bonus', 'mixins/production-modifiers.js', 'const lookup = blocked.has(5) ?', 'const lookup = false ?'],
  ['no assessment releases every bonus', 'utilities/capabilities.js', 'Object.entries(gates ? gates.bonuses : BONUS_NAMES)', 'Object.entries(gates ? gates.bonuses : {})'],
  ['no assessment is read as confirmed lookup rows', 'utilities/capabilities.js', 'if (!gates) {\n    return [UNCONFIRMED]', 'if (!gates) {\n    return []'],
  ['a retry clears the result of the same copy', 'store/capabilities.js', 'if (state.resultGeneration !== generation) {', 'if (true) {'],
  ['the store returns a result of an earlier copy', 'store/capabilities.js', 'return state.resultGeneration === rootState.freshness.generation ? state.result : null', 'return state.result'],
]

// The nodes of a page's script that `wanted(node)` accepts, and the script's text: { script, nodes }.
const scriptNodes = (page, wanted) => {
  const acorn = require(path.join(repo, 'node_modules', 'acorn'))
  const { parse } = require(path.join(repo, 'node_modules', 'vue', 'compiler-sfc'))
  const script = parse({ source: fs.readFileSync(path.join(rendererDirectory, 'pages', page), 'utf8') }).script.content
  const nodes = []
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') {
      return
    }

    if (wanted(node, script)) {
      nodes.push(node)
    }

    Object.values(node).forEach((child) => (Array.isArray(child) ? child.forEach(visit) : visit(child)))
  }

  visit(acorn.parse(script, { ecmaVersion: 'latest', sourceType: 'module' }))

  return { script, nodes }
}

// The roster queries of the Commanders page, as that page builds them: the template literals of its script that take the roster parts (`${parts.*}`), evaluated with the parts, a game and a race.
const rosterTemplates = () => {
  const { script, nodes } = scriptNodes('commanders.vue', (node, text) => node.type === 'TemplateLiteral' && text.slice(node.start, node.end).includes('${parts.'))

  return nodes.map((node) => script.slice(node.start, node.end))
}

const all = (file, sql) => new Promise((resolve, reject) => {
  const database = new sqlite3.Database(file, sqlite3.OPEN_READONLY)

  database.all(sql, (error, rows) => {
    database.close(() => (error ? reject(error) : resolve(rows)))
  })
})

// Runs the page's own roster queries on a copy: { ok, failed: [error], rows: [rows of each] }.
const rosterRun = async (commanders, file, groups) => {
  const [game] = await all(file, 'select GameID, RaceID from FCT_Race where RaceID in (select RaceID from FCT_Commander) limit 1')
  const parts = commanders.rosterParts(groups, game)
  const failed = []
  const rows = []

  for (const template of rosterTemplates()) {
    const sql = vm.compileFunction(`return ${template}`, ['parts', 'SERVING_COMMANDER']).call(game, parts, commanders.SERVING_COMMANDER)

    try {
      rows.push(await all(file, sql))
    } catch (error) {
      failed.push(String(error.message).split('\n')[0])
    }
  }

  return { ok: failed.length === 0, failed, rows }
}

// The consumers of the capability result, on the real modules and, with one gate taken out of a copy of them, on mutants that must fail.
const consumerChecks = async (source) => {
  const mods = await loadUtilities(CONSUMER_MODULES, { stubs: STUBS })
  const results = await consumerResults(mods, source)

  results.forEach(([statement, held]) => check(`consumers: ${statement}`, held))

  for (const [label, file, from, to] of MUTATIONS) {
    const directory = mutatedCopy(file, from, to)

    try {
      const mutants = await loadUtilities(CONSUMER_MODULES, { stubs: STUBS, directory: path.join(directory, 'utilities') })
      const broken = (await consumerResults(mutants, source)).filter(([, held]) => !held).map(([statement]) => statement)

      check(`consumers: a copy of the code in which ${label} fails a consumer check`, broken.length > 0)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }

  return mods
}

// The roster queries of the Commanders page on copies that lack a rank or age column: they run on the parts the preflight chose, and fail on the parts of a save that has everything.
const rosterChecks = async (capabilities, commanders, source) => {
  const copies = []
  const named = (rows, column) => rows.flat().filter((row) => column in row).map((row) => row[column])

  try {
    const baseline = await rosterRun(commanders, source, null)

    check('roster: the page\'s four queries run on an unaltered save', baseline.ok && baseline.rows.length === 4, baseline.failed.join('; '))
    check('roster: an unaltered save returns rank names and ages', named(baseline.rows, 'RankName').some((name) => name !== null) && named(baseline.rows, 'GraduationAge').some((age) => age !== null))

    const cases = [
      ['FCT_Commander.RankID dropped', ['alter table FCT_Commander drop column RankID'], 'RankName'],
      ['FCT_Ranks dropped', ['drop table FCT_Ranks'], 'RankName'],
      ['FCT_Commander.SpeciesID dropped', ['alter table FCT_Commander drop column SpeciesID'], 'GraduationAge'],
      ['FCT_Species.GraduationAge dropped', ['alter table FCT_Species drop column GraduationAge'], 'GraduationAge'],
    ]

    for (const [label, statements, column] of cases) {
      const copy = await alteredCopy(source, `roster-${copies.length}`, statements)

      copies.push(copy)

      const { result } = await preflightOf(capabilities, copy)
      const groups = result.reports['/commanders'].groups
      const ran = await rosterRun(commanders, copy, groups)
      const unguarded = await rosterRun(commanders, copy, null)

      check(`roster: with ${label}, the queries run on the parts the preflight chose and return the group as unknown`, ran.ok && named(ran.rows, column).length > 0 && named(ran.rows, column).every((value) => value === null), ran.failed.join('; '))
      check(`roster: with ${label}, the same queries fail on the parts of a complete save`, !unguarded.ok)
      check(`roster: with ${label}, /commanders is degraded and names the field`, result.reports['/commanders'].status === 'degraded' && result.reports['/commanders'].degraded.some((entry) => entry.group), JSON.stringify(result.reports['/commanders'].degraded.map((entry) => entry.fields)))
    }
  } finally {
    copies.forEach((copy) => fs.rmSync(copy, { force: true }))
  }
}

// The inputs of the scan, as [route, key], that read `table.column` by name: the generated reads list it, or a prefix marker it starts with (`Reserve*`). The app shell is no report.
const readersOf = (scan, table, column) => Object.entries(scan).filter(([route]) => route !== 'shell').flatMap(([route, inputs]) => Object.entries(inputs || {}).filter(([, input]) => [...(input.reads[table] || [])].some((name) => name === column || (name !== '*' && name.endsWith('*') && column.startsWith(name.slice(0, -1))))).map(([key]) => [route, key]))

// The stockpiles the Warnings page's rift check sorts a colony by (utilities/warnings/space.js), which the scan sees as a bare marker: the check and the page, which holds the module's definitions, read each of them.
const riftReaders = (column) => {
  const listed = /const STOCKPILES = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(rendererDirectory, 'utilities', 'warnings', 'space.js'), 'utf8'))

  return listed && listed[1].split(',').map((name) => name.trim().replace(/'/g, '')).includes(column) ? [['/warnings', 'check:dangerous-rifts'], ['/warnings', 'page']] : []
}

// The inputs, as [route, key], that build a share of DIM_NavalAdminCommandType by name on a page that loads that share.
const shareReaders = (scan, share) => Object.keys(SHARE_SOURCES).filter((route) => sharesOf(route).includes(share)).flatMap((route) => Object.entries(scan[route] || {}).filter(([, input]) => [...(input.reads.DIM_NavalAdminCommandType || [])].includes('*')).map(([key]) => [route, key]))

// The status each report has when `readers` lack a column: unsupported when a required input reads it, degraded when only optional ones do.
const expectedStatuses = (capabilities, readers) => {
  const expected = new Map()

  readers.forEach(([route, key]) => {
    if (expected.get(route) !== 'unsupported') {
      expected.set(route, capabilities.isOptional(route, key) ? 'degraded' : 'unsupported')
    }
  })

  return expected
}

// What the preflight says of copies that each lack one column, against the reports whose inputs read it by name: [[statement, held, detail]]. `none` is a column no report reads.
const dependencyResults = async (capabilities, cases) => {
  const results = []
  const holds = (statement, condition, detail = '') => results.push([statement, Boolean(condition), detail])

  for (const { label, file, table, column, readers, none = false, supported = [], unsupported = [] } of cases) {
    const { result } = await preflightOf(capabilities, file)
    const field = `${table}.${column}`
    const expected = expectedStatuses(capabilities, readers)
    const named = (report) => [...report.missing, ...report.degraded].some((entry) => entry.fields.includes(field))
    const wrong = Object.values(result.reports).filter((report) => report.status !== (expected.get(report.route) || 'supported') || (expected.has(report.route) && !named(report)))

    holds(`${label}: exactly the reports whose inputs read it by name are affected, each naming the field, and every other report stays supported`, wrong.length === 0, wrong.map((report) => `${report.route} ${report.status}`).join(', '))
    holds(`${label}: ${none ? 'no report is affected' : 'some reports are affected and not all'}`, none ? expected.size === 0 && notSupported(result).length === 0 : expected.size > 0 && expected.size < Object.keys(result.reports).length, [...expected.keys()].join(', '))

    if (supported.length) {
      holds(`${label}: ${supported.join(', ')} stay supported`, supported.every((route) => result.reports[route].status === 'supported'), supported.map((route) => `${route} ${result.reports[route].status}`).join(', '))
    }

    if (unsupported.length) {
      holds(`${label}: ${unsupported.join(', ')} are unsupported, naming the field`, unsupported.every((route) => result.reports[route].status === 'unsupported' && result.reports[route].missing.some((entry) => entry.fields.includes(field))), unsupported.map((route) => `${route} ${result.reports[route].status}`).join(', '))
    }
  }

  return results
}

// The Mineral Outlook page's stockpile read, as the page builds it: the template literal of its script that takes `completeSums('FCT_Population')`, evaluated with the page's own `completeSums` helper, the minerals, a game and a race.
const stockpileSql = (MINERALS, game) => {
  const { script, nodes } = scriptNodes('mineral-outlook.vue', (node, text) => (node.type === 'VariableDeclarator' && node.id.name === 'completeSums') || (node.type === 'TemplateLiteral' && text.slice(node.start, node.end).includes("completeSums('FCT_Population')")))
  const helper = nodes.find((node) => node.type === 'VariableDeclarator')
  const template = nodes.find((node) => node.type === 'TemplateLiteral')

  return vm.compileFunction(`const completeSums = ${script.slice(helper.init.start, helper.init.end)}\nreturn ${script.slice(template.start, template.end)}`, ['MINERALS']).call(game, MINERALS)
}

// The reads that run in sqlite as they stand on a copy without FCT_Population.ReserveDuranium: the Mineral Outlook page's stockpile read, which builds the minerals only, runs, and the Minerals page's colony read (its STOCK_COLUMNS, which name the reserves) fails.
const sqlChecks = async (source, copy) => {
  const { minerals, 'colony-minerals': colonyMinerals } = await loadUtilities(['minerals', 'colony-minerals'], { stubs: STUBS })
  const [game] = await all(source, 'select GameID, RaceID from FCT_Population limit 1')
  const outlook = stockpileSql(minerals.MINERALS, game)
  const colonies = `select ${colonyMinerals.STOCK_COLUMNS} from FCT_Population where FCT_Population.GameID = ${game.GameID} and FCT_Population.RaceID = ${game.RaceID}`
  const outcome = (file, sql) => all(file, sql).then((rows) => ({ rows }), (error) => ({ error: String(error.message).split('\n')[0] }))
  const whole = await outcome(source, outlook)
  const without = await outcome(copy, outlook)
  const wholeColonies = await outcome(source, colonies)
  const withoutColonies = await outcome(copy, colonies)
  const names = minerals.MINERALS.map((mineral) => mineral.name)

  check('sql: the Mineral Outlook stockpile read (the page\'s own template and helper) runs on a complete save', Boolean(whole.rows) && whole.rows.length === 1 && names.every((name) => name in whole.rows[0]), whole.error)
  check('sql: the Mineral Outlook stockpile read runs on a copy without FCT_Population.ReserveDuranium, as the registry says', Boolean(without.rows) && without.rows.length === 1 && names.every((name) => name in without.rows[0]), without.error)
  check('sql: the colony read of the Minerals page runs on a complete save', Boolean(wholeColonies.rows), wholeColonies.error)
  check('sql: the colony read of the Minerals page (its STOCK_COLUMNS) fails on a copy without FCT_Population.ReserveDuranium, naming the column', Boolean(withoutColonies.error) && withoutColonies.error.includes('ReserveDuranium'), withoutColonies.error || 'it ran')
  // eslint-disable-next-line no-template-curly-in-string
  check('sql: the Minerals page builds its colony read from those STOCK_COLUMNS', scriptNodes('minerals.vue', (node, text) => node.type === 'TemplateLiteral' && text.slice(node.start, node.end).includes('${STOCK_COLUMNS}') && text.slice(node.start, node.end).includes('from FCT_Population')).nodes.length > 0)
}

// A copy of the code in which every marker stands for the whole list of its table, the earlier behaviour: the dependency checks must fail there.
// eslint-disable-next-line no-template-curly-in-string
const UNION = ['markers resolved as the whole list of their table', 'utilities/capabilities.js', 'return used || (MARKER_COLUMNS[table] || []).map((name) => `${marker.slice(0, -1)}${name}`)', "return [...(MARKER_COLUMNS[table] || []), ...(table === 'FCT_Population' ? [...MINERAL_NAMES.map((name) => `Reserve${name}`), 'FuelStockpile', 'MaintenanceStockpile'] : [])]"]

// Copies of a save that each lack one column read by name, and what the preflight makes of each: the reports that do not read it stay supported, and a report that does read it only when the page builds the column by name (a mineral stock, a command-type share) is not made unsupported by a column the page does not use.
const dependencyChecks = async (capabilities, source, scan) => {
  const copies = []
  const unaffected = ['/mineral-outlook', '/logistics', '/habitability', '/production', '/colony-outlook', '/survey-progress']
  const shared = (share) => shareReaders(scan, share)
  const sharing = (share) => Object.keys(SHARE_SOURCES).filter((route) => sharesOf(route).includes(share))
  const cases = [
    { label: 'FCT_Population.ReserveDuranium dropped', table: 'FCT_Population', column: 'ReserveDuranium', readers: readersOf(scan, 'FCT_Population', 'ReserveDuranium'), supported: unaffected, unsupported: ['/minerals', '/hauling'] },
    { label: 'FCT_Population.FuelStockpile dropped', table: 'FCT_Population', column: 'FuelStockpile', readers: [...readersOf(scan, 'FCT_Population', 'FuelStockpile'), ...riftReaders('FuelStockpile')], supported: ['/mineral-outlook', '/habitability', '/minerals', '/hauling', '/survey-progress'], unsupported: ['/logistics', '/production'] },
    { label: 'FCT_Population.MaintenanceStockpile dropped', table: 'FCT_Population', column: 'MaintenanceStockpile', readers: [...readersOf(scan, 'FCT_Population', 'MaintenanceStockpile'), ...riftReaders('MaintenanceStockpile')], supported: ['/mineral-outlook', '/habitability', '/minerals', '/hauling', '/survey-progress', '/production'], unsupported: ['/logistics'] },
    { label: 'DIM_NavalAdminCommandType.Industrial dropped', table: 'DIM_NavalAdminCommandType', column: 'Industrial', readers: shared('Industrial'), supported: ['/survey-progress', '/minerals', '/hauling'], unsupported: sharing('Industrial') },
    { label: 'DIM_NavalAdminCommandType.Survey dropped', table: 'DIM_NavalAdminCommandType', column: 'Survey', readers: shared('Survey'), supported: ['/production', '/mineral-outlook', '/habitability', '/logistics'], unsupported: ['/survey-progress'] },
    { label: 'DIM_NavalAdminCommandType.Logistics dropped', table: 'DIM_NavalAdminCommandType', column: 'Logistics', readers: shared('Logistics'), supported: ['/production', '/mineral-outlook', '/habitability', '/logistics', '/survey-progress'] },
    { label: 'DIM_NavalAdminCommandType.Tactical dropped', table: 'DIM_NavalAdminCommandType', column: 'Tactical', readers: shared('Tactical'), none: true },
  ]

  try {
    for (const entry of cases) {
      entry.file = await alteredCopy(source, `dependency-${copies.length}`, [`alter table ${entry.table} drop column ${entry.column}`])
      copies.push(entry.file)
    }

    const results = await dependencyResults(capabilities, cases)

    results.forEach(([statement, held, detail]) => check(`dependencies: ${statement}`, held, detail))
    check('dependencies: the pages that read the Industrial share are the ones MARKER_USES names, the Survey page reads Survey, and Transport and Hauling read Logistics (their optional handling read only, so the report is degraded)', sharing('Industrial').sort().join() === ['/habitability', '/logistics', '/mineral-outlook', '/production'].join() && sharing('Survey').join() === '/survey-progress' && sharing('Logistics').sort().join() === ['/hauling', '/information'].join() && shared('Logistics').every(([route, key]) => capabilities.isOptional(route, key)))

    const [label, file, from, to] = UNION
    const directory = mutatedCopy(file, from, to)

    try {
      const mutant = (await loadUtilities(['capabilities'], { directory: path.join(directory, 'utilities') })).capabilities
      const broken = (await dependencyResults(mutant, cases)).filter(([, held]) => !held).map(([statement]) => statement)

      console.log(`INFO  a copy of the code with the ${label} fails ${broken.length} of the dependency checks`)
      check(`dependencies: a copy of the code with the ${label} fails a dependency check`, broken.length > 0)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }

    await sqlChecks(source, cases[0].file)
  } finally {
    copies.forEach((copy) => fs.rmSync(copy, { force: true }))
  }
}

// The columns a built-by-name read stands for (`MARKER_COLUMNS`) are the lists the pages build them from: the minerals of utilities/minerals.js, the command-type shares of utilities/naval-admins.js.
const markerChecks = async (capabilities) => {
  const { minerals } = await loadUtilities(['minerals'], { stubs: STUBS })
  const names = minerals.MINERALS.map((mineral) => mineral.name)
  const shares = /const SHARES = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(rendererDirectory, 'utilities', 'naval-admins.js'), 'utf8'))
  const listed = shares ? shares[1].split(',').map((name) => name.trim().replace(/'/g, '')) : []

  ;['FCT_Population', 'FCT_IndustrialProjects', 'FCT_ShipyardTask', 'FCT_MassDriverPackets', 'FCT_ShipDesignComponents'].forEach((table) => check(`registry: the built-by-name columns of ${table} are the minerals`, capabilities.MARKER_COLUMNS[table].join() === names.join()))

  const reserves = (capabilities.INPUTS['/minerals'].find((input) => input.key === 'colonies') || { resolved: {} }).resolved.FCT_Population

  check('registry: a `Reserve*` marker stands for the reserve of each mineral, and the bare marker beside it for the minerals only', Boolean(reserves) && reserves['Reserve*'].join() === names.map((name) => `Reserve${name}`).join() && reserves['*'].join() === names.join(), JSON.stringify(reserves))
  check('registry: the colony stockpiles are no built-by-name column, an input that reads them names them', !capabilities.MARKER_COLUMNS.FCT_Population.includes('FuelStockpile') && !capabilities.MARKER_COLUMNS.FCT_Population.includes('MaintenanceStockpile'))
  check('registry: the built-by-name columns of DIM_NavalAdminCommandType are the command-type shares', listed.length > 0 && capabilities.MARKER_COLUMNS.DIM_NavalAdminCommandType.join() === listed.join() && capabilities.SHARE_NAMES.join() === listed.join(), listed.join())
}

const main = async () => {
  const write = process.argv.includes('--write')
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--write')

  if (unknown.length) {
    console.error(`Unknown argument ${unknown[0]}`)
    process.exit(2)
  }

  const { navigation } = await loadUtilities(['navigation']).then((modules) => ({ navigation: modules.navigation }))
  const scan = scanReads(navigation.PAGES.map((page) => page.route))
  const expected = generated(scan)

  if (write) {
    fs.writeFileSync(READS_FILE, expected)
    console.log(`wrote ${path.relative(repo, READS_FILE)}`)
  } else {
    check('reads: utilities/capability-reads.js matches what the pages read now (node scripts/check-capabilities.js --write regenerates it)', fs.existsSync(READS_FILE) && fs.readFileSync(READS_FILE, 'utf8') === expected)
  }

  const { capabilities } = await loadUtilities(['capabilities'])

  registryChecks(capabilities, scan, navigation)
  await markerChecks(capabilities)

  for (const save of REAL) {
    await realSaveChecks(capabilities, save)
  }

  const older = {}

  for (const save of OLDER) {
    older[save.label] = await olderChecks(capabilities, save)
  }

  const old64 = older['Old64 (Pepega)']
  const g260 = older['G260 base']

  if (old64) {
    check('older: the pre-2.6 shape makes /commanders unsupported and its component type 29 differ', old64.reports['/commanders'].status === 'unsupported' && failedGates(old64).includes('component type 29') && old64.formula.status === 'unavailable')
  }

  if (g260) {
    check('older: a 2.6-shaped save has no formula version, its lookups as expected, and /commanders still readable', g260.formula.status === 'unavailable' && failedGates(g260).length === 0 && g260.reports['/commanders'].status !== 'unsupported')
  }

  const source = path.resolve(repo, 'AuroraDB_270_base.db')

  if (fs.existsSync(source)) {
    await alteredChecks(capabilities, source)
    await dependencyChecks(capabilities, source, scan)
    const mods = await consumerChecks(source)

    await rosterChecks(capabilities, mods.commanders, source)

    // The pages' own wiring of the result (scripts/lib/capability-pages.js): the real script of /lagrange, /commanders and /production on the result of real copies, and on copies of those pages with one gate cut out, which must fail.
    await pageChecks({ mods, stubs: STUBS, source, check, alteredCopy, preflightOf })

    // What the missing naval admin ranks and a blocked Mining bonus leave unknown (scripts/lib/capability-chains.js).
    await chainChecks({ check, stubs: STUBS, source, alteredCopy, mutatedCopy, preflightOf, capabilities })
  } else {
    console.log('SKIP  altered copies: AuroraDB_270_base.db is not there (not run)')
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
