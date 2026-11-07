/*
  Checks the civilian mining summary by system of the Minerals page (src/renderer/utilities/cmc-summary.js and the "Civilian mining by system" panel of src/renderer/pages/minerals.vue).

  bun scripts/check-cmc-summary.js [--no-mutations] [--no-saves]

  The utility is run on systems worked by hand: a candidate body free and one a colony keeps off, a body the race banned, an active colony taxed and one bought, a body with no recorded deposit figure, a body out of reach of its star and one out of reach of its body, a colony whose complexes are not recorded, the 10 million threshold either side, and a system listed only for its complexes.

  The page runs over scripts/lib/page-loader.js: its template is read as text and its script runs the summary computed over the rows shaped like the page's own reads, and the panel is held to its summary sentence, its foot and the marks of its columns.

  The oracle is the game's civilian mining tab (the CMC Potential tab of the Economics window), worked out here from the game's rules and computed from the raw tables beside the page: the systems of the race's surveyed bodies with more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better within reach of their star, and of its colonies holding a complex; for each, the controlling other race, the largest colony in millions, the colonies with a complex, the bodies free and blocked, and the year's tax and purchase figures. Every system of the fixture and of the played save is compared in both directions: the systems listed, the name, control, largest colony, active colonies and wealth against the tab, and the free and blocked bodies against the founding rule the page and the Colonization Planner share (utilities/colonization.js `cmcBlocks`: people, an automated mine, a civilian or ex-civilian complex, a mass driver or orbital miners at work).

  The tab's own body test disagrees with that founding rule: it reads the race's population records alone, counts a record with no orbital mining modules as keeping a complex off, and names neither a mass driver nor a complex. The check proves the disagreement body by body, proves the summary keeps the founding rule, and reports every body where the two differ, so that a system whose counts differ from the tab's is named with its cause.

  The played save's wealth ledger (uses 35 and 36, the tax on civilian mining and the purchase of civilian minerals) is read as a second witness of the purchase rate: over its one-year window the ledger holds no more than the year's cost at the tab's rate.

  Planted cases on a copy of the fixture (the game-shaped cases of the brief): a free body given an empty colony (blocked on the tab, free under the founding rule), one given a mass driver, one given orbital miners at work, a system given a controlling alien race, and two systems given a largest colony below and above 10 million people.

  The panel's switched-off caption is held to the game's own switch: the page's race read is driven with civilian mining at 0 and at 1, and the caption must say the game founds and expands none while the foot promises no appearance.

  Each mutation of the utility or the page must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { fixtureSave } = require('./lib/fixtures')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  summary: path.join(root, 'src', 'renderer', 'utilities', 'cmc-summary.js'),
  page: path.join(root, 'src', 'renderer', 'pages', 'minerals.vue'),
  data: path.join(root, 'src', 'renderer', 'utilities', 'colonization-data.js'),
}
const NAMES = ['cmc-summary', 'provenance']
const SAVES = [
  fixtureSave(),
  { file: 'saves/AuroraDB-320-fetterkrolle-1.db', game: 161, race: 909 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  'lodash/groupBy': 'export default (items, key) => items.reduce((groups, item) => { const name = typeof key === \'function\' ? key(item) : item[key]; (groups[name] = groups[name] || []).push(item); return groups }, {})',
}
// The page reaches the planners' shared modules (through aurora.js and the warnings), which want dates and numerals they never use here.
const PAGE_STUBS = {
  ...STUBS,
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}
const STORE = { getters: { config: { get: () => 'Tick' }, 'capabilities/result': {}, 'capabilities/blockedBonuses': new Set(), 'capabilities/report': () => ({ groups: { navalRank: true } }) }, state: {} }

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const SHORT_LIMIT = Number(process.env.SHORT_LIMIT) || 300
const DROPPED = new Set(['rule', 'inputs', 'assumptions', 'body', 'row'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'page.vue', id: 'page' }).errors.map(String)
}

const PRONOUNS = /\b(I|me|my|you|your|we|our)\b/i
const RELEASE = /\b(?:2\.[67]|3\.[0-2])(?:\.\d+|\.x)?\b/
const PROMISES_APPEARANCE = /\b(?:may|will|can|could) (?:appear|be founded)\b/

// ---------- the systems worked by hand ----------

const deposit = (MaterialID, Amount, Accessibility) => ({ MaterialID, Amount, Accessibility })
const body = (SystemID, deposits, extra = {}) => ({ SystemID, depositList: deposits, complexes: 0, complexGaps: 0, cmcInReach: true, cmcStarInReach: true, cmcBlocked: false, banned: false, ...extra })
const colony = (SystemID, Population, Complexes, extra = {}) => ({ SystemID, Population, Complexes, ComplexGaps: 0, PurchaseCivilianMinerals: 0, ...extra })
const knownSystem = (SystemID, Name, ControllerName = null) => ({ SystemID, Name, ControllerName })

const SYSTEMS = [
  knownSystem(1, 'Alpha'),
  knownSystem(2, 'Beta', 'Adjaran'),
  knownSystem(3, 'Gamma'),
  knownSystem(4, 'Delta'),
  knownSystem(5, 'Epsilon'),
  knownSystem(6, 'Zeta'),
  knownSystem(7, 'Aardvark'),
]
const BODIES = [
  body(7, [deposit(8, 900000, 0.4)]),
  body(1, [deposit(1, 50000, 0.9)]),
  body(1, [deposit(11, 20000, 0.8)], { cmcBlocked: true }),
  body(1, [deposit(1, null, 0.9)]),
  body(1, [deposit(1, 50000, 0.9)], { complexes: 3 }),
  body(1, [deposit(8, 900000, 0.4)]),
  body(2, [deposit(1, 15000, 1)]),
  body(2, [deposit(1, 12000, 0.7)], { banned: true }),
  body(3, [deposit(11, null, null)]),
  body(4, [deposit(1, 50000, 0.9)]),
  body(5, [deposit(1, 50000, 0.9)], { cmcStarInReach: false }),
  body(6, [deposit(1, 50000, 0.9)], { cmcInReach: false }),
]
const COLONIES = [
  colony(1, 25, 3),
  colony(1, 2, 0),
  colony(2, 10, 2, { PurchaseCivilianMinerals: 1 }),
  colony(4, 9.5, 0, { Complexes: null, ComplexGaps: 1 }),
  colony(4, 4, 0, { Complexes: null, ComplexGaps: 1, PurchaseCivilianMinerals: 1 }),
  colony(7, 3, 1, { PurchaseCivilianMinerals: 1 }),
]

const summaryOf = (ctx, over = {}) => ctx.m['cmc-summary'].cmcSummary({ bodies: BODIES, colonies: COLONIES, systems: SYSTEMS, version: '3.2.x', ...over })
const rowOf = (result, name) => result.rows.find((row) => row.name === name)

// ---------- the checks of the utility and the page ----------

const pure = (ctx) => {
  const statements = []
  const add = (name, test) => statements.push([`${name}`, test])
  const summary = summaryOf(ctx)

  add('system: a system is listed for a candidate body or a colony with a complex, and not for a possible body alone or a body out of reach', () => same(summary.rows.map((row) => row.name), ['Aardvark', 'Alpha', 'Beta', 'Delta']) === true && summary.possible === 2 ? true : short([summary.rows.map((row) => row.name), summary.possible]))
  add('counts: active counts the colonies with complexes, available the bodies free to host one and blocked those a colony keeps off or the race banned', () => {
    const alpha = rowOf(summary, 'Alpha')
    const beta = rowOf(summary, 'Beta')
    const eta = rowOf(summary, 'Aardvark')

    return same([alpha.active, alpha.available, alpha.blocked], [1, 1, 1]) === true && same([beta.active, beta.available, beta.blocked], [1, 1, 1]) === true && same([eta.active, eta.available, eta.blocked], [1, 0, 0]) === true ? true : short([alpha, beta, eta])
  })
  add('population: the largest colony of the race in each system in millions, and the other race the survey names as its controller', () => {
    const rows = summary.rows.map((row) => [row.name, row.population, row.controller])

    return same(rows, [['Aardvark', 3, null], ['Alpha', 25, null], ['Beta', 10, 'Adjaran'], ['Delta', 9.5, null]]) === true ? true : short(rows)
  })
  add('threshold: a system needs more than 10 million people to found a complex, so 10 is below it', () => {
    const founds = summary.rows.map((row) => [row.name, row.founds])

    return same(founds, [['Aardvark', false], ['Alpha', true], ['Beta', false], ['Delta', false]]) === true ? true : short(founds)
  })
  add('reach: a body out of reach of its star or of its own orbit is no candidate, and a body carrying a complex is not counted again as a candidate', () => {
    const ids = summary.rows.map((row) => row.SystemID)

    return same(ids, [7, 1, 2, 4]) === true ? true : short(ids)
  })
  add('possible: a Duranium or Gallicite deposit with no recorded amount leaves the body counted apart, in the system\'s caption and in the page\'s total', () => {
    const alpha = rowOf(summary, 'Alpha')

    return alpha.possible === 1 && summary.possible === 2 && alpha.available + alpha.blocked === 2 ? true : short([alpha.possible, summary.possible])
  })
  add('unknown: a colony whose complexes are not recorded leaves the counts and the wealth of its system unknown, never a known figure', () => {
    const delta = rowOf(summary, 'Delta')
    const unknown = (result) => result.status === 'unavailable'

    return [delta.active, delta.available, delta.blocked, delta.income, delta.expenditure].every((value) => value === null) && unknown(delta.countsResult) && unknown(delta.incomeResult) && unknown(delta.expenditureResult) ? true : short(delta)
  })
  add('wealth: the year\'s tax on the complexes of the race and the year\'s cost of buying their output, at 125 and 250 a complex', () => {
    const alpha = rowOf(summary, 'Alpha')
    const beta = rowOf(summary, 'Beta')
    const eta = rowOf(summary, 'Aardvark')

    return same([alpha.income, alpha.expenditure], [375, 0]) === true && same([beta.income, beta.expenditure], [0, 500]) === true && same([eta.income, eta.expenditure], [0, 250]) === true ? true : short([alpha, beta, eta])
  })
  add('wealth: a save whose rules the rates are not known to hold for leaves a taxed complex a dash and a system with none 0, whatever the version', () => {
    const alpha = rowOf(summaryOf(ctx, { version: null }), 'Alpha')
    const free = rowOf(ctx.m['cmc-summary'].cmcSummary({ bodies: [body(1, [deposit(1, 50000, 0.9)])], colonies: [colony(1, 5, 0)], systems: [knownSystem(1, 'Alpha')], version: null }), 'Alpha')

    return alpha.income === null && alpha.expenditure === 0 && free.income === 0 && free.expenditure === 0 ? true : short([alpha, free])
  })
  add('order: the systems come in the order of the tab, by name', () => {
    const names = summaryOf(ctx).rows.map((row) => row.name)

    return same(names, [...names].sort((a, b) => a.localeCompare(b))) === true ? true : short(names)
  })

  return statements
}

const page = (ctx) => {
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const vm = instantiate(ctx.pageOptions, { $store: STORE, data: { bodies: BODIES, colonies: COLONIES, systems: SYSTEMS, formulaVersion: '3.2.x', cmcReach: {} } })
  const direct = summaryOf(ctx)

  add('page: the summary the page shows is the utility\'s, for the bodies, colonies and systems the page holds', () => same(vm.summary, direct))
  add('page: the table has the tab\'s columns, each with the rule of its figure', () => {
    const wanted = ['System', 'Controlling race', 'Largest colony', 'Active', 'Available', 'Blocked', 'Income', 'Expenditure']
    const keys = Object.keys(vm.summaryRules)

    return same(vm.summaryHeaders.map((header) => header.text), wanted) === true && same(keys, ['name', 'controller', 'population', 'active', 'available', 'blocked', 'income', 'expenditure']) === true ? true : short([vm.summaryHeaders, keys])
  })
  add('page: the caption counts the systems and the bodies that could still qualify', () => `${vm.summaryText}`.includes('4 systems') && `${vm.summaryText}`.includes('2 bodies possible') ? true : `${vm.summaryText}`)
  add('page: the game\'s own civilian mining switch reads off at 0 and on at 1, and the panel\'s caption follows it', async () => {
    const switchOf = (AllowCMC) => {
      const database = { query: async () => [[{ MineProduction: 100, MaximumOrbitalMiningDiameter: 0, ComplexMining: 20, AllowCMC }]] }
      const turned = instantiate(ctx.pageOptions, { $store: STORE, database, GameID: 1, RaceID: 1, data: {} })

      return turned.runAsync('race').then(() => turned)
    }
    const off = await switchOf(0)
    const on = await switchOf(1)

    return off.raceRules.AllowCMC === false && on.raceRules.AllowCMC === true && ctx.pageText.includes('v-if="!raceRules.AllowCMC"') ? true : short([off.raceRules, on.raceRules])
  })

  return statements
}

const panel = (ctx) => {
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const text = ctx.pageText
  const start = text.indexOf('<v-card class="panel" data-summary="Compare each system\'s civilian mining potential')
  const end = start < 0 ? -1 : text.indexOf('</v-card>', start)
  const card = start < 0 || end < 0 ? '' : text.slice(start, end)

  add('panel: the summary is a section panel with a sentence of what it shows and a foot that opens with how to use it', () => {
    const summary = /data-summary="([^"]+)"/.exec(card)

    return card.length > 0 && summary && summary[1].length > 20 && card.includes('<div class="panel-foot caption text--secondary">') && card.includes('Use it to ') && !RELEASE.test(card) ? true : short(card.slice(0, 200))
  })
  add('panel: the table shows the summary rows and keeps the tab\'s sort, by name until the reader picks a column', () => card.includes(':items="summary.rows"') && card.includes(':custom-sort="sortNullLast"') && card.includes(':sort-by.sync="summaryTable.sortBy"') && card.includes(':sort-desc.sync="summaryTable.sortDesc"') ? true : short(card.slice(0, 300)))
  add('panel: every column carries its rule\'s mark, and a figure that is not known shows a dash with its mark', () => {
    const script = require('vue/compiler-sfc').parse({ source: text }).script.content

    return card.includes('v-for="(rule, column) in summaryRules"') && card.includes('<provenance-mark :rule="rule" />') && card.includes(':result="item.countsResult"') && /\$\{column\}Result/.test(card) && /summaryRules: \{ name: 'cmcSummary\.system'/.test(script) && !PRONOUNS.test(card.replace(/Use it to/g, '')) ? true : 'the panel or its rules do not match'
  })
  add('panel: the page compiles', () => {
    const errors = templateErrors(text)

    return errors.length === 0 ? true : short(errors)
  })
  add('panel: the panel says the game founds and expands no complex while civilian mining is off, on the race\'s own switch, and its foot promises no appearance', () => {
    const caption = /<div v-if="!raceRules\.AllowCMC"[^>]*data-cmc-off[^>]*>([^<]*)<\/div>/.exec(card)

    if (!caption) {
      return 'the switched-off caption is missing, or not on the race\'s switch'
    }

    const said = caption[1]

    return /\bswitched off\b/.test(said) && /\bfounds\b/.test(said) && /\bexpands none\b/.test(said) && !RELEASE.test(said) && !PRONOUNS.test(said) && !PROMISES_APPEARANCE.test(card) ? true : short({ said, card: card.slice(0, 160) })
  })

  return statements
}

// ---------- the game's tab, ported beside the summary ----------

const REACH_AU = 80
const DURANIUM = 1
const GALLICITE = 11
const COMPLEX = 39
const SECONDS_PER_YEAR = 365 * 24 * 3600

const starReachOf = (stars, points) => {
  const group = (list) => list.reduce((groups, item) => {
    groups[item.SystemID] = [...(groups[item.SystemID] || []), item]

    return groups
  }, {})
  const starsBySystem = group(stars)
  const pointsBySystem = group(points)
  const near = (point) => point.PlanetApoapsis !== null && point.PlanetApoapsis < REACH_AU
  const reach = new Map()

  for (const star of stars) {
    const systemStars = starsBySystem[star.SystemID] || []
    const systemPoints = pointsBySystem[star.SystemID] || []
    const primaryLink = systemPoints.some((point) => point.StarOrbitingComponent === 0 && near(point))
    const own = systemPoints.some((point) => point.StarID === star.StarID && near(point))

    if (star.ComponentNumber === 1) {
      reach.set(star.StarID, true)
    } else if (star.OrbitingComponent === 1) {
      reach.set(star.StarID, (star.Apoapsis !== null && star.Apoapsis < REACH_AU) || (primaryLink && own))
    } else {
      const circled = systemStars.find((other) => other.ComponentNumber === star.OrbitingComponent)
      const linked = systemPoints.some((point) => (point.StarID === star.StarID || (circled && point.StarID === circled.StarID)) && near(point))

      reach.set(star.StarID, !!circled && ((circled.Apoapsis !== null && circled.Apoapsis < REACH_AU) || (primaryLink && linked)))
    }
  }

  return reach
}

// The body's farthest point from its star (a moon's planet orbital distance), not a gas giant.
const bodyInReach = (body, reach, eccentric) => {
  if (!reach) {
    return false
  }

  const apoapsis = eccentric ? body.OrbitalDistance * (1 + (body.Eccentricity || 0)) : body.OrbitalDistance

  if (body.BodyClass === 2) {
    return body.ParentOrbitalDistance !== null && body.ParentOrbitalDistance < REACH_AU
  }

  if (body.BodyClass === 1 && [4, 5].includes(body.BodyTypeID)) {
    return false
  }

  return [1, 3, 5].includes(body.BodyClass) && apoapsis !== null && apoapsis < REACH_AU
}

const grouping = (rows, key) => rows.reduce((groups, row) => groups.set(row[key], [...(groups.get(row[key]) || []), row]), new Map())

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

const openSave = (file, writable = false) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, writable ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ query: (sql) => allRows(raw, sql), close: () => closeRaw(raw), raw })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const runSql = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

// The game's civilian mining tab and the founding rule beside it, from the save's own tables: every system listed with its figures, and the bodies each rule counts. `bodies` carries each candidate body's SystemID and what the two rules make of it.
const oracleOf = async (database, { game, race }) => {
  const [gameRow] = await rowsOf(database, `select StarEccentricity from FCT_Game where GameID = ${game}`)
  const eccentric = gameRow.StarEccentricity !== 0
  const stars = await rowsOf(database, `select StarID, SystemID, ComponentNumber, OrbitingComponent, OrbitalDistance * (1 + Eccentricity) as Apoapsis from FCT_Star where GameID = ${game}`)
  const points = await rowsOf(database, `select FCT_LagrangePoint.SystemID, FCT_LagrangePoint.StarID, FCT_Star.OrbitingComponent as StarOrbitingComponent, FCT_SystemBody.OrbitalDistance * (1 + FCT_SystemBody.Eccentricity) as PlanetApoapsis from FCT_LagrangePoint inner join FCT_Star on FCT_Star.StarID = FCT_LagrangePoint.StarID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_LagrangePoint.PlanetID where FCT_LagrangePoint.GameID = ${game}`)
  const reach = starReachOf(stars, points)
  const surveys = new Set((await rowsOf(database, `select SystemBodyID from FCT_SystemBodySurveys where GameID = ${game} and RaceID = ${race}`)).map((row) => row.SystemBodyID))
  const orbits = new Map((await rowsOf(database, `select SystemBodyID, OrbitalDistance from FCT_SystemBody where GameID = ${game}`)).map((row) => [row.SystemBodyID, row.OrbitalDistance]))
  const bodies = (await rowsOf(database, `select SystemBodyID, SystemID, StarID, ParentBodyID, BodyClass, BodyTypeID, OrbitalDistance, Eccentricity from FCT_SystemBody where GameID = ${game}`)).map((body) => ({ ...body, ParentOrbitalDistance: orbits.has(body.ParentBodyID) ? orbits.get(body.ParentBodyID) : null }))
  const deposits = await rowsOf(database, `select SystemBodyID, MaterialID, Amount, Accessibility from FCT_MineralDeposit where GameID = ${game} and MaterialID in (${DURANIUM}, ${GALLICITE})`)
  const qualifying = new Set(deposits.filter((row) => row.Amount > 10000 && row.Accessibility >= 0.7).map((row) => row.SystemBodyID))
  const surveysRows = await rowsOf(database, `select SystemID, Name, ControlRaceID from FCT_RaceSysSurvey where GameID = ${game} and RaceID = ${race}`)
  const alienNames = Object.fromEntries((await rowsOf(database, `select AlienRaceID, AlienRaceName from FCT_AlienRace where GameID = ${game} and ViewRaceID = ${race}`)).map((row) => [row.AlienRaceID, row.AlienRaceName]))
  const populations = await rowsOf(database, `select PopulationID, RaceID, SystemID, SystemBodyID, Population, PurchaseCivilianMinerals from FCT_Population where GameID = ${game}`)
  const installs = grouping(await rowsOf(database, `select PopID, PlanetaryInstallationID, Amount from FCT_PopulationInstallations where GameID = ${game}`), 'PopID')
  const everyPopulation = new Set(populations.map((row) => row.PopulationID))
  const knownAliens = new Set((await rowsOf(database, `select PopulationID from FCT_AlienPopulation where GameID = ${game} and ViewingRaceID = ${race}`)).map((row) => row.PopulationID))
  const banned = new Set((await rowsOf(database, `select SystemBodyID from FCT_BannedBodies where GameID = ${game} and RaceID = ${race}`)).map((row) => row.SystemBodyID))
  const rawFleets = await rowsOf(database, `select FleetID, RaceID, OrbitBodyID, AssignedPopulationID, Xcor, Ycor from FCT_Fleet where GameID = ${game}`)
  const rawShips = await rowsOf(database, `select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Ship.ShipClassID, FCT_ShipClass.MiningModules from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 where FCT_Ship.GameID = ${game}`)
  const rawLines = await rowsOf(database, 'select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.ComponentTypeID from FCT_ClassComponent left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID in (select ShipClassID from FCT_ShipClass where MiningModules > 0)')
  const rawDamage = await rowsOf(database, `select ShipID, ComponentID, Number from FCT_DamagedComponent where GameID = ${game}`)
  const linesOf = grouping(rawLines, 'ClassID')
  const damageOf = grouping(rawDamage, 'ShipID')
  const shipsOf = grouping(rawShips, 'FleetID')
  const bodyById = new Map(bodies.map((body) => [body.SystemBodyID, body]))

  const modulesOf = (ship) => {
    const lines = linesOf.get(ship.ShipClassID) || []
    const mining = lines.filter((line) => line.ComponentTypeID === 38)
    const damage = damageOf.get(ship.ShipID) || []
    const damaged = (line) => damage.filter((item) => item.ComponentID === line.ComponentID)

    if (lines.some((line) => line.ComponentTypeID === null) || !mining.length || mining.some((line) => line.NumComponent === null || damaged(line).some((item) => item.Number === null))) {
      return ship.MiningModules
    }

    return mining.reduce((total, line) => total + Math.max(line.NumComponent - damaged(line).reduce((sum, item) => sum + item.Number, 0), 0), 0)
  }

  const within = (a, b) => Math.abs(a - b) < 1
  const atColony = (fleet, population) => {
    const body = bodyById.get(population.SystemBodyID)

    if (!body) {
      return false
    }

    return [fleet.Xcor, fleet.Ycor, body.Xcor, body.Ycor].every(Number.isFinite) ? within(fleet.Xcor, body.Xcor) && within(fleet.Ycor, body.Ycor) : fleet.OrbitBodyID === population.SystemBodyID
  }
  // The undamaged orbital mining modules of the fleets of the colony's race at its body, assigned to it or to none.
  const modulesAt = (population) => rawFleets.filter((fleet) => fleet.RaceID === population.RaceID && atColony(fleet, population) && (!(fleet.AssignedPopulationID > 0) || !everyPopulation.has(fleet.AssignedPopulationID) || fleet.AssignedPopulationID === population.PopulationID)).reduce((total, fleet) => total + (shipsOf.get(fleet.FleetID) || []).reduce((sum, ship) => sum + modulesOf(ship), 0), 0)
  const has = (population, id) => (installs.get(population.PopulationID) || []).some((row) => row.PlanetaryInstallationID === id)
  const complexes = (population) => (installs.get(population.PopulationID) || []).filter((row) => row.PlanetaryInstallationID === COMPLEX).reduce((total, row) => total + Math.floor(row.Amount || 0), 0)
  const own = populations.filter((row) => row.RaceID === race)
  const visible = populations.filter((row) => row.RaceID === race || knownAliens.has(row.PopulationID))
  // The tab's own body test: a population record of the race with people, an automated mine or an ex-civilian complex, or with no orbital mining modules at all.
  const tabSecond = new Set(own.filter((population) => population.Population > 0 || has(population, 12) || has(population, 52) || modulesAt(population) === 0).map((population) => population.SystemBodyID))
  // The founding rule the page and the Planner share (colonization.js `cmcBlocks`): people, an automated mine, a mass driver, a civilian or ex-civilian complex, or orbital miners at work.
  const reasonsOf = (population) => [population.Population > 0 ? 'people' : null, has(population, 12) ? 'an automated mine' : null, has(population, 24) ? 'a mass driver' : null, has(population, 39) ? 'a complex' : null, has(population, 52) ? 'an ex-complex' : null, modulesAt(population) > 0 ? 'orbital miners' : null].filter(Boolean)
  const foundingReasons = new Map()

  visible.forEach((population) => {
    const reasons = reasonsOf(population)

    if (reasons.length) {
      foundingReasons.set(population.SystemBodyID, [...new Set([...(foundingReasons.get(population.SystemBodyID) || []), ...reasons])])
    }
  })

  const foundingBlocked = new Set(foundingReasons.keys())
  const active = own.filter((population) => has(population, COMPLEX))
  const activeBodies = new Set(active.map((population) => population.SystemBodyID))
  const source = bodies.filter((body) => surveys.has(body.SystemBodyID) && bodyInReach(body, reach.get(body.StarID), eccentric) && qualifying.has(body.SystemBodyID))
  const grouped = grouping(source.filter((body) => !activeBodies.has(body.SystemBodyID)), 'SystemID')
  const systems = new Map()
  const systemIds = new Set([...source.map((body) => body.SystemID), ...active.map((population) => population.SystemID)])

  for (const systemId of systemIds) {
    const survey = surveysRows.find((row) => row.SystemID === systemId)
    const colonies = own.filter((population) => population.SystemID === systemId)
    const activeColonies = active.filter((population) => population.SystemID === systemId)
    const candidates = grouped.get(systemId) || []
    const tabBlocked = candidates.filter((body) => tabSecond.has(body.SystemBodyID) || banned.has(body.SystemBodyID))
    const foundingFree = candidates.filter((body) => !foundingBlocked.has(body.SystemBodyID) && !banned.has(body.SystemBodyID))
    const population = colonies.length ? Math.max(...colonies.map((row) => row.Population)) : 0
    const sumFor = (buying) => colonies.filter((row) => has(row, COMPLEX) && !!row.PurchaseCivilianMinerals === buying).reduce((total, row) => total + complexes(row) * (buying ? 250 : 125), 0)

    systems.set(systemId, {
      SystemID: systemId,
      name: survey ? survey.Name : '',
      controller: survey && survey.ControlRaceID ? alienNames[survey.ControlRaceID] || null : null,
      population,
      active: activeColonies.length,
      candidates: candidates.length,
      available: foundingFree.length,
      blocked: candidates.length - foundingFree.length,
      tabAvailable: candidates.length - tabBlocked.length,
      tabBlocked: tabBlocked.length,
      income: sumFor(false),
      expenditure: sumFor(true),
      tabOnly: candidates.filter((body) => tabSecond.has(body.SystemBodyID) && !foundingBlocked.has(body.SystemBodyID) && !banned.has(body.SystemBodyID)).map((body) => body.SystemBodyID),
      foundingOnly: candidates.filter((body) => !tabSecond.has(body.SystemBodyID) && foundingBlocked.has(body.SystemBodyID)).map((body) => body.SystemBodyID),
    })
  }

  return { systems, source: source.length, eccentric, foundingReasons }
}

const saveSummary = async (ctx, database, save) => {
  const vm = instantiate(ctx.pageOptions, { $store: STORE, database, GameID: save.game, RaceID: save.race, data: {} })

  for (const name of Object.keys(ctx.pageOptions.asyncComputed)) {
    await vm.runAsync(name)
  }

  return vm.summary
}

const plainRow = (row) => ({ SystemID: row.SystemID, name: row.name, controller: row.controller, population: row.population, active: row.active, available: row.available, blocked: row.blocked, income: row.income, expenditure: row.expenditure })

const saveStatements = async (ctx, save) => {
  const database = await openSave(save.file)
  const label = `${save.file}`
  const statements = []

  if (!database) {
    return { skipped: true, statements }
  }

  const present = (await rowsOf(database, `select RaceID from FCT_Race where GameID = ${save.game} and RaceID = ${save.race}`)).length > 0

  if (!present) {
    console.log(`SKIP  ${label}: game ${save.game} race ${save.race} is not in the file`)
    await database.close()

    return { skipped: true, statements }
  }

  const addSave = (name, test) => statements.push([`${name.slice(0, name.indexOf(':'))}: ${label}:${name.slice(name.indexOf(':') + 1)}`, test])
  const summary = await saveSummary(ctx, database, save)
  const oracle = await oracleOf(database, save)
  const listed = [...oracle.systems.values()].sort((a, b) => a.SystemID - b.SystemID)
  const shown = summary.rows.map(plainRow)
  const ledger = await rowsOf(database, `select UseID, count(*) as Entries, sum(Amount) as Total from FCT_WealthData where GameID = ${save.game} and RaceID = ${save.race} and UseID in (35, 36) group by UseID`)
  const window = (await rowsOf(database, `select min(TimeUsed) as First, max(TimeUsed) as Last from FCT_WealthData where GameID = ${save.game} and RaceID = ${save.race}`))[0]
  const annual = shown.reduce((total, row) => total + row.expenditure, 0)

  addSave('save-tab: the summary lists every system the game\'s tab lists, and no other, with the name, controlling race, active colonies and the year\'s wealth the tab shows', () => {
    const got = shown.map((row) => [row.SystemID, row.name, row.controller, row.active, row.income, row.expenditure]).sort((a, b) => a[0] - b[0])
    const want = listed.map((row) => [row.SystemID, row.name, row.controller, row.active, row.income, row.expenditure])

    return same(got, want) === true ? true : short({ got, want })
  })
  addSave('save-tab: the largest colony of every system is the tab\'s', () => {
    const wrong = listed.map((row) => [row.SystemID, shown.find((item) => item.SystemID === row.SystemID), row]).filter(([_id, item, row]) => !item || !near(item.population, row.population))

    return wrong.length ? short(wrong.slice(0, 4)) : true
  })
  addSave('save-tab: the free and blocked bodies of every system are the founding rule\'s: a colony with people, an automated mine, a mass driver, a civilian or ex-civilian complex, orbital miners at work or a ban keeps a complex off', () => {
    const wrong = listed.map((row) => [row.SystemID, shown.find((item) => item.SystemID === row.SystemID), row]).filter(([_id, item, row]) => !item || item.available !== row.available || item.blocked !== row.blocked || item.available + item.blocked !== row.candidates)

    return wrong.length ? short(wrong.slice(0, 4)) : true
  })
  addSave('save-tab: where the tab\'s own body test differs from the founding rule, the difference is the bodies it misreads, and the summary keeps the founding rule', () => {
    const mismatched = listed.filter((row) => shown.find((item) => item.SystemID === row.SystemID).available !== row.tabAvailable || shown.find((item) => item.SystemID === row.SystemID).blocked !== row.tabBlocked)
    const unexplained = mismatched.filter((row) => row.tabBlocked - shown.find((item) => item.SystemID === row.SystemID).blocked !== row.tabOnly.length - row.foundingOnly.length)

    return unexplained.length ? short(unexplained.slice(0, 4)) : true
  }, listed.filter((row) => row.tabOnly.length || row.foundingOnly.length).map((row) => `${row.name} ${row.tabOnly.length}/${row.foundingOnly.length}`).join(', ') || 'none')
  addSave('save-ledger: the wealth ledger\'s purchase of civilian minerals over its one-year window is positive where complexes stand and no more than the year\'s cost at the tab\'s rate', () => {
    const purchased = ledger.filter((row) => row.UseID === 36)

    if (!purchased.length) {
      return annual === 0 ? true : short({ annual, ledger })
    }

    return window.Last - window.First <= SECONDS_PER_YEAR && purchased.every((row) => row.Total > 0) && purchased.reduce((total, row) => total + row.Total, 0) <= annual ? true : short({ ledger, window, annual })
  }, `${ledger.map((row) => `${row.UseID}: ${row.Total}`).join(', ') || 'no civilian mining line'} against ${annual} a year`)

  await database.close()

  return { skipped: false, statements }
}

// ---------- the planted cases ----------

const PLANTED = ['empty', 'driver', 'orbital', 'control', 'below']

const plantedStatements = async (ctx) => {
  const source = path.resolve(root, SAVES[0].file)
  const statements = []

  if (!fs.existsSync(source)) {
    return { skipped: true, statements }
  }

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-cmc-summary-'))
  const file = path.join(folder, 'AuroraDB-planted.db')

  fs.copyFileSync(source, file)

  const database = await openSave(file, true)

  try {
    const game = SAVES[0].game
    const race = SAVES[0].race
    const before = await oracleOf(database, SAVES[0])
    const [gameRow] = await rowsOf(database, `select StarEccentricity from FCT_Game where GameID = ${game}`)
    const eccentric = gameRow.StarEccentricity !== 0
    const stars = await rowsOf(database, `select StarID, SystemID, ComponentNumber, OrbitingComponent, OrbitalDistance * (1 + Eccentricity) as Apoapsis from FCT_Star where GameID = ${game}`)
    const points = await rowsOf(database, `select FCT_LagrangePoint.SystemID, FCT_LagrangePoint.StarID, FCT_Star.OrbitingComponent as StarOrbitingComponent, FCT_SystemBody.OrbitalDistance * (1 + FCT_SystemBody.Eccentricity) as PlanetApoapsis from FCT_LagrangePoint inner join FCT_Star on FCT_Star.StarID = FCT_LagrangePoint.StarID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_LagrangePoint.PlanetID where FCT_LagrangePoint.GameID = ${game}`)
    const reach = starReachOf(stars, points)
    const orbits = new Map((await rowsOf(database, `select SystemBodyID, OrbitalDistance from FCT_SystemBody where GameID = ${game}`)).map((row) => [row.SystemBodyID, row.OrbitalDistance]))
    const known = new Set((await rowsOf(database, `select SystemID from FCT_RaceSysSurvey where GameID = ${game} and RaceID = ${race}`)).map((row) => row.SystemID))
    const bodies = (await rowsOf(database, `select SystemBodyID, SystemID, StarID, ParentBodyID, BodyClass, BodyTypeID, OrbitalDistance, Eccentricity, Xcor, Ycor from FCT_SystemBody where GameID = ${game}`)).map((body) => ({ ...body, ParentOrbitalDistance: orbits.has(body.ParentBodyID) ? orbits.get(body.ParentBodyID) : null }))
    const populated = new Set((await rowsOf(database, `select distinct SystemBodyID from FCT_Population where GameID = ${game}`)).map((row) => row.SystemBodyID))
    const surveys = new Set((await rowsOf(database, `select SystemBodyID from FCT_SystemBodySurveys where GameID = ${game} and RaceID = ${race}`)).map((row) => row.SystemBodyID))
    const free = bodies.filter((body) => known.has(body.SystemID) && bodyInReach(body, reach.get(body.StarID), eccentric) && !populated.has(body.SystemBodyID) && !surveys.has(body.SystemBodyID))
    const chosen = []

    for (const body of free) {
      if (chosen.length < PLANTED.length && !chosen.some((item) => item.SystemID === body.SystemID)) {
        chosen.push(body)
      }
    }

    const alien = (await rowsOf(database, `select FCT_AlienPopulation.PopulationID, FCT_AlienPopulation.AlienRaceID from FCT_AlienPopulation where FCT_AlienPopulation.GameID = ${game} and FCT_AlienPopulation.ViewingRaceID = ${race} and exists (select 1 from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_AlienPopulation.AlienRaceID and FCT_AlienRace.ViewRaceID = ${race} and FCT_AlienRace.GameID = ${game}) order by FCT_AlienPopulation.PopulationID limit 1`))[0]
    const own = (await rowsOf(database, `select PopulationID from FCT_Population where GameID = ${game} and RaceID = ${race} order by PopulationID limit 1`))[0]
    const miningClass = (await rowsOf(database, `select FCT_ShipClass.ShipClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent from FCT_ShipClass inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = 38 where FCT_ShipClass.GameID = ${game} and FCT_ShipClass.RaceID = ${race} and FCT_ShipClass.MiningModules > 0 order by FCT_ShipClass.ShipClassID limit 1`))[0]
    const fleets = await rowsOf(database, `select FCT_Ship.FleetID, min(FCT_Ship.ShipID) as ShipID from FCT_Ship where FCT_Ship.GameID = ${game} and FCT_Ship.RaceID = ${race} group by FCT_Ship.FleetID order by FCT_Ship.FleetID`)
    const problems = []
    const belowSite = chosen[PLANTED.indexOf('below')]
    const belowPopulation = belowSite ? (before.systems.get(belowSite.SystemID) || { population: 0 }).population : 0

    if (belowPopulation > 0) {
      problems.push(`the below case's system holds ${belowPopulation} million people before the plant`)
    }

    if (chosen.length < PLANTED.length) {
      problems.push(`${chosen.length} free bodies of ${PLANTED.length} wanted of ${free.length}`)
    }

    if (!alien && PLANTED.includes('control')) {
      problems.push('no alien race the race knows to control a system')
    }

    if (!own) {
      problems.push('no colony of the race to copy')
    }

    if (!miningClass || !fleets.length) {
      problems.push('no orbital mining class or fleet to plant')
    }

    const sqlValue = (cell) => (typeof cell === 'string' ? `'${cell.replace(/'/g, "''")}'` : String(cell))
    // A copy of one row of a table with the columns of `over` changed, the template row the one `where` finds first.
    const copyRow = async (table, where, over) => {
      const columns = (await rowsOf(database, `pragma table_info(${table})`)).map((column) => column.name)
      const lacking = Object.keys(over).filter((column) => !columns.includes(column))

      if (lacking.length) {
        problems.push(`${table} has no column ${lacking.join(', ')}`)
      }

      await runSql(database.raw, `insert into ${table} (${columns.join(', ')}) select ${columns.map((column) => (column in over ? sqlValue(over[column]) : column)).join(', ')} from ${table} where ${where} limit 1`)
    }
    const planted = []

    if (!problems.length) {
      let nextId = 900000

      for (const [index, name] of PLANTED.entries()) {
        const body = chosen[index]
        const item = { name, body, populationId: null }

        nextId += 1
        planted.push(item)
        await runSql(database.raw, `insert into FCT_SystemBodySurveys (GameID, RaceID, SystemBodyID) values (${game}, ${race}, ${body.SystemBodyID})`)
        await runSql(database.raw, `insert into FCT_MineralDeposit (GameID, MaterialID, SystemID, SystemBodyID, Amount, Accessibility, HalfOriginalAmount, OriginalAcc) values (${game}, 1, ${body.SystemID}, ${body.SystemBodyID}, 50000, 0.9, 50000, 0.9)`)

        if (name === 'control') {
          await runSql(database.raw, `update FCT_RaceSysSurvey set ControlRaceID = ${alien.AlienRaceID} where GameID = ${game} and RaceID = ${race} and SystemID = ${body.SystemID}`)

          continue
        }

        const people = name === 'below' ? 9 : 0

        item.populationId = nextId
        await copyRow('FCT_Population', `GameID = ${game} and PopulationID = ${own.PopulationID}`, { PopulationID: nextId, RaceID: race, SystemID: body.SystemID, SystemBodyID: body.SystemBodyID, PopName: `Planted ${name}`, Population: people, PurchaseCivilianMinerals: 0, Capital: 0 })

        if (name === 'driver' || name === 'orbital') {
          const [fleet] = fleets

          await runSql(database.raw, `update FCT_Fleet set Xcor = ${body.Xcor}, Ycor = ${body.Ycor}, OrbitBodyID = ${body.SystemBodyID}, AssignedPopulationID = 0, SystemID = ${body.SystemID} where FleetID = ${fleet.FleetID}`)
          await runSql(database.raw, `update FCT_Ship set ShipClassID = ${miningClass.ShipClassID} where ShipID = ${fleet.ShipID}`)
        }

        if (name === 'driver') {
          await runSql(database.raw, `insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount) values (${game}, ${nextId}, 24, 1)`)
        }
      }
    }

    const after = await oracleOf(database, SAVES[0])
    const summary = await saveSummary(ctx, database, SAVES[0])
    const listed = [...after.systems.values()].sort((a, b) => a.SystemID - b.SystemID)
    const shown = new Map(summary.rows.map((row) => [row.SystemID, row]))
    const plantedRow = (item) => shown.get(item.body.SystemID) || null
    const priorFor = (item) => before.systems.get(item.body.SystemID) || { available: 0, blocked: 0 }
    const statement = (name, test) => statements.push([`save-planted: ${name}`, test])

    statement('the copy has what the cases need: a free surveyed body in reach for each case, an alien race the race knows, a colony to copy and an orbital mining class with a fleet', () => (problems.length ? short(problems) : planted.length === PLANTED.length ? true : short(planted.length)))
    statement('every system of the planted copy matches the founding rule for its free and blocked bodies and the tab for the other figures', () => {
      const wrong = listed.map((row) => [row.SystemID, shown.get(row.SystemID), row]).filter(([_id, item, row]) => !item || item.available !== row.available || item.blocked !== row.blocked || item.active !== row.active || !near(item.population, row.population) || item.income !== row.income || item.expenditure !== row.expenditure)

      return wrong.length ? short(wrong.slice(0, 4)) : true
    })
    statement('a free body given an empty colony is blocked on the tab and available under the founding rule', () => {
      const item = planted.find((entry) => entry.name === 'empty')
      const row = plantedRow(item)
      const port = after.systems.get(item.body.SystemID)
      const prior = priorFor(item)

      return row && row.available === prior.available + 1 && row.blocked === prior.blocked && port.tabOnly.includes(item.body.SystemBodyID) ? true : short({ row: row ? [row.available, row.blocked] : null, prior, port: port && [port.available, port.tabAvailable, port.tabOnly, port.foundingOnly] })
    })
    statement('a free body given a mass driver is blocked under the founding rule, on its driver among other colonies', () => {
      const item = planted.find((entry) => entry.name === 'driver')
      const row = plantedRow(item)
      const reasons = after.foundingReasons.get(item.body.SystemBodyID) || []
      const prior = priorFor(item)

      return row && row.blocked === prior.blocked + 1 && reasons.includes('a mass driver') ? true : short({ row: row ? [row.available, row.blocked] : null, reasons, prior })
    })
    statement('a free body with orbital miners at work is blocked under the founding rule and free on the tab', () => {
      const item = planted.find((entry) => entry.name === 'orbital')
      const row = plantedRow(item)
      const port = after.systems.get(item.body.SystemID)
      const reasons = after.foundingReasons.get(item.body.SystemBodyID) || []
      const prior = priorFor(item)

      return row && row.blocked === prior.blocked + 1 && reasons.includes('orbital miners') && port.foundingOnly.includes(item.body.SystemBodyID) ? true : short({ row: row ? [row.available, row.blocked] : null, reasons, port: port && [port.available, port.tabAvailable, port.tabOnly, port.foundingOnly] })
    })
    statement('the system given a controlling race shows that race\'s name in the row', () => {
      const item = planted.find((entry) => entry.name === 'control')
      const row = plantedRow(item)
      const name = after.systems.get(item.body.SystemID).controller

      return row && !!name && row.controller === name ? true : short([row && row.controller, name])
    })
    statement('a system whose largest colony holds 9 million people is below the founding threshold, where the game\'s own largest colony is above it', () => {
      const below = plantedRow(planted.find((entry) => entry.name === 'below'))
      const largest = [...after.systems.values()].sort((a, b) => b.population - a.population)[0]

      return below && below.population === 9 && below.founds === false && largest && largest.population > 10 && shown.get(largest.SystemID).founds === true ? true : short([below && [below.population, below.founds], largest && [largest.population, shown.get(largest.SystemID) && shown.get(largest.SystemID).founds]])
    })

    return { skipped: false, statements }
  } finally {
    await database.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

// ---------- the planted faults ----------

/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'the controlling race dropped', file: 'summary', find: 'controller: row.system ? row.system.ControllerName || null : null,', replace: 'controller: null,', fails: ['population'] },
  { name: 'the largest colony taken from the bodies, not the colonies', file: 'summary', find: 'row.populations.push(colony.Population)', replace: 'row.populations.push(0)', fails: ['population'] },
  { name: 'the founding threshold read as 10 or more, not more than 10', file: 'summary', find: 'founds: population === null ? null : population > 10,', replace: 'founds: population === null ? null : population >= 10,', fails: ['threshold'] },
  { name: 'every colony counted active, not those with complexes', file: 'summary', find: 'if (complexes !== null && complexes > 0) {', replace: 'if (complexes !== null) {', fails: ['counts'] },
  { name: 'a banned body still free', file: 'summary', find: 'keptOff: !!body.cmcBlocked || !!body.banned,', replace: 'keptOff: !!body.cmcBlocked,', fails: ['counts'] },
  { name: 'a colony on the body not blocking it', file: 'summary', find: 'keptOff: !!body.cmcBlocked || !!body.banned,', replace: 'keptOff: !!body.banned,', fails: ['counts'] },
  { name: 'a star out of reach still counted', file: 'summary', find: 'const reachOf = (body) => !!body.cmcInReach && !!body.cmcStarInReach', replace: 'const reachOf = (body) => !!body.cmcInReach', fails: ['reach'] },
  { name: 'a body out of reach of its star still counted', file: 'summary', find: 'const reachOf = (body) => !!body.cmcInReach && !!body.cmcStarInReach', replace: 'const reachOf = (body) => !!body.cmcStarInReach', fails: ['reach'] },
  { name: 'a body whose deposit is not recorded counted as a candidate', file: 'summary', find: 'const couldQualify = (deposit) => !depositReadable(deposit) &&', replace: 'const couldQualify = (deposit) => depositReadable(deposit) &&', fails: ['possible'] },
  { name: 'the bought output taxed', file: 'summary', find: 'entry.choice === \'buy\'), version)', replace: 'entry.choice === \'tax\'), version)', fails: ['wealth'] },
  { name: 'the tax collected at the purchase cost', file: 'summary', find: 'complexes * (colony.PurchaseCivilianMinerals ? CMC_PURCHASE_COST : CMC_TAX_INCOME)', replace: 'complexes * (colony.PurchaseCivilianMinerals ? CMC_PURCHASE_COST : CMC_PURCHASE_COST)', fails: ['wealth'] },
  { name: 'the rates given whatever the save\'s version', file: 'summary', find: 'if (entries.length && ruleSupports(\'cmcSummary.wealth\', version) !== true) {', replace: 'if (false) {', fails: ['wealth'] },
  { name: 'a colony whose complexes are not recorded counted as none', file: 'summary', find: 'const complexesOf = (colony) => (known(colony.Complexes) && !(colony.ComplexGaps > 0) ? whole(Math.max(0, colony.Complexes), colony.ComplexesTerms) : null)', replace: 'const complexesOf = (colony) => (known(colony.Complexes) ? whole(Math.max(0, colony.Complexes), colony.ComplexesTerms) : 0)', fails: ['unknown'] },
  { name: 'a possible body left out of its system\'s caption', file: 'summary', find: 'rows.get(body.SystemID).possible += 1', replace: 'undefined', fails: ['possible'] },
  { name: 'the systems left in the order they were found', file: 'summary', find: 'return { rows: summaryRows.sort(byName), systems: summaryRows.length, possible }', replace: 'return { rows: summaryRows, systems: summaryRows.length, possible }', fails: ['order'] },
  { name: 'a system listed for a possible body alone', file: 'summary', find: 'const listed = [...rows.values()].filter((row) => row.candidates.length > 0 || row.active > 0 || row.activeUnknown)', replace: 'const listed = [...rows.values()].filter((row) => row.candidates.length > 0 || row.active > 0 || row.activeUnknown || row.possible > 0)', fails: ['system'] },
  { name: 'the panel without its summary sentence', file: 'page', find: 'data-summary="Compare each system\'s civilian mining potential and the wealth its complexes move."', replace: 'data-text="Compare each system\'s civilian mining potential and the wealth its complexes move."', fails: ['panel'] },
  { name: 'the panel foot not opening with how to use it', file: 'page', find: 'Use it to see which of the race\'s systems could host a civilian mining complex', replace: 'The summary shows which of the race\'s systems could host a civilian mining complex', fails: ['panel'] },
  { name: 'the table not bound to the summary rows', file: 'page', find: ':items="summary.rows"', replace: ':items="summary.possible"', fails: ['panel'] },
  { name: 'the table not keeping the tab\'s sort', file: 'page', find: ' :sort-by.sync="summaryTable.sortBy" :sort-desc.sync="summaryTable.sortDesc"', replace: '', fails: ['panel'] },
  { name: 'a column without its rule mark', file: 'page', find: "income: 'cmcSummary.wealth', expenditure: 'cmcSummary.wealth' },", replace: 'expenditure: \'cmcSummary.wealth\' },', fails: ['page'] },
  { name: 'the page summary without the colonies', file: 'page', find: 'return cmcSummary({ bodies: this.bodies, colonies: this.colonies, systems: this.systems, version: this.formulaVersion })', replace: 'return cmcSummary({ bodies: this.bodies, colonies: [], systems: this.systems, version: this.formulaVersion })', fails: ['page'] },
  { name: 'the panel without its switched-off caption', file: 'page', find: '<div v-if="!raceRules.AllowCMC" class="selection-bar caption warning--text" data-cmc-off>Civilian mining complexes are switched off for the game: the game founds and expands none, so the figures below show the potential the race\'s bodies hold, not complexes this game creates.</div>', replace: '', fails: ['panel'] },
  { name: 'the foot promising a complex appears whatever the game switch', file: 'page', find: 'Use it to see which of the race\'s systems could host a civilian mining complex', replace: 'Use it to see where a civilian mining complex may appear next', fails: ['panel'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  if (mutant) {
    sources[mutant.file] = patched(path.basename(FILES[mutant.file]), sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const summarySource = { ...(changed('summary') ? { 'cmc-summary': sources.summary } : {}) }
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: summarySource })
  const pageOptions = await loadPage('pages/minerals', { stubs: PAGE_STUBS, sources: { 'pages/minerals': sources.page, ...(changed('summary') ? { 'utilities/cmc-summary': sources.summary } : {}) } })

  return { m: loaded, pageOptions, pageText: sources.page }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

let useSaves = true

const statementsOf = async (ctx, withSaves) => {
  const statements = [...pure(ctx), ...page(ctx), ...panel(ctx)]
  const skipped = []

  if (withSaves && useSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)
      }
    }

    const planted = await plantedStatements(ctx)

    if (planted.skipped) {
      skipped.push(SAVES[0].file)
    } else {
      statements.push(...planted.statements)
    }
  }

  return { statements, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, skipped } = await statementsOf(ctx, true)

  console.log('\nCivilian mining summary by system: the counts of the game\'s civilian mining tab on the systems of the fixture and the played save, and the founding rule\'s bodies')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.some((key) => !key.startsWith('save-') && keys.has(key))).map((mutation) => mutation.name)

  check('mutations: every planted fault names a group of checks that needs no save, so a checkout without the saves still catches it', bare.length ? short(bare) : true)

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }
}

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  const { statements } = await statementsOf(ctx, false)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const named = mutant.fails.filter(present)
  const absent = mutant.fails.filter((key) => !present(key))
  const results = await runStatements(statements, named)
  const missed = named.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      options.saves = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  useSaves = options.saves

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const extra = options.saves ? [] : ['--no-saves']
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
