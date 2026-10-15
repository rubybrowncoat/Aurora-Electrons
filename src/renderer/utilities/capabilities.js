// What the opened save supports: which of the tables and columns each report reads it has, and whether the lookup rows the planners key on mean what they expect. A save carries no version label, so structure (the columns a report reads) and meaning (what an ID stands for, the formula version) are checked apart, and neither stands in for the other.
//
// The reads of every report come from utilities/capability-reads.js, written by `node scripts/check-capabilities.js --write` from the pages' own queries, one entry per tracked input (`tracked('<key>', ...)` in a page, a check of the warnings page, the app shell's reads). This module adds what the scan cannot know: the columns a query builds by name or lists without its table (`EXTRA_READS`, `MARKER_COLUMNS`, and `MARKER_USES` where a page uses a known part of what it builds), the reads that guard themselves (`TOLERATED`), which inputs a page can really do without (`OPTIONAL`), the column groups a report can lose without the rest (`SOFT`), and the lookup rows whose meaning is checked (`BONUS_NAMES`, `COMPONENT_TYPES`).
//
// A report is 'supported' (every input it reads is there), 'degraded' (an optional input, a soft column group or a lookup row is not, and each is named) or 'unsupported' (an input it cannot do without is missing). A page holds back its content while any input it tracks fails, so an input is required unless the page really goes on without it. `preflight` only selects: from `pragma_table_xinfo` (so generated and hidden columns count) and the lookup tables, never writing to the save.
import { READS } from './capability-reads'
import { isAvailable, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

export const STATED_FORMULA_VERSION = '2.7.x'

const FORMULA = 'capability.formulaVersion'
const BONUS = 'capability.bonusName'
const COMPONENT = 'capability.componentType'

registerRule({
  id: FORMULA,
  versions: [STATED_FORMULA_VERSION],
  verification: 'assumed',
  structure: ['FCT_Game.AllowCMC', 'FCT_Game.AncientRelics'],
  note: 'A save carries no version label. FCT_Game.AllowCMC and FCT_Game.AncientRelics came with 2.7 and are absent from every 2.6-shaped and older save examined, so a save with both is taken as 2.7.x, the formula version the rules are stated for. That is a fact about the schema, not a verified version.',
})

registerRule({
  id: BONUS,
  versions: ['2.6.x', '2.7.x'],
  verification: 'confirmed',
  structure: ['DIM_CommanderBonusType.BonusID', 'DIM_CommanderBonusType.Description', 'DIM_CommanderBonusType.Percentage'],
  note: 'The commander bonus IDs the planners read were compared with DIM_CommanderBonusType in 2.6, 2.7 and 2.7.1 saves: each stands for the same bonus, a multiplier or a rating, in all of them. A save whose row differs is not mapped.',
})

registerRule({
  id: COMPONENT,
  versions: ['2.6.x', '2.7.x'],
  verification: 'confirmed',
  structure: ['DIM_ComponentType.ComponentTypeID', 'DIM_ComponentType.TypeDescription'],
  note: 'Component type 29 is Jump Point Stabilisation in the 2.6, 2.7 and 2.7.1 saves examined, and Jump Gate Construction in the pre-2.6 ones, so a save whose type differs is not mapped.',
})

// The inputs a page really goes on without, which only degrade its report when a table or column is missing: the checks of the Warnings page (each shows its own failure in place) and the ships of the Lagrange page (its map and saved points do not read them). Every other input is required, as the page holds its content back while one fails.
const OPTIONAL = Object.freeze({
  '/warnings': (key) => key.startsWith('check:'),
  '/lagrange': (key) => key === 'ships',
})

export const isOptional = (route, key) => Boolean(OPTIONAL[route] && OPTIONAL[route](key))

// The ranks of the naval admin commanders decide whether a command's bonus applies down its chain, so a report that reads them keeps its stock figures and leaves only the rates that need the chain unknown (`loadNavalAdmins` takes `ranks`).
const navalRank = (affects) => Object.freeze({ key: 'navalRank', label: 'Naval admin ranks', affects, fields: Object.freeze(['FCT_Commander.RankID', 'FCT_Ranks.*']) })

// The column groups a report can lose without the rest of it. `fields` are 'Table.Column', or 'Table.*' for a whole table that only the group reads. A group's columns still count as missing for the report's inputs, but degrade the report instead of making it unsupported, and the page leaves them out of its queries (`groupsOf`).
export const SOFT = Object.freeze({
  '/commanders': Object.freeze([
    Object.freeze({ key: 'rank', label: 'Officer ranks', affects: 'rank names and levels, the order by rank and the specialist ship suggestions, which need the rank a class requires', fields: Object.freeze(['FCT_Commander.RankID', 'FCT_Ranks.*', 'FCT_ShipClass.RankRequired']) }),
    Object.freeze({ key: 'age', label: 'Officer ages', affects: 'officer ages', fields: Object.freeze(['FCT_Species.*', 'FCT_Commander.SpeciesID']) }),
  ]),
  '/production': Object.freeze([navalRank('the orbital terraforming rates of the colonies, which rest on the ranks of the naval admin commanders')]),
  '/mineral-outlook': Object.freeze([navalRank('the mining rates of the orbital miners, which rest on the ranks of the naval admin commanders')]),
  '/habitability': Object.freeze([navalRank('the mining outlook of the mass-driver colonies, which rests on the ranks of the naval admin commanders')]),
  '/logistics': Object.freeze([navalRank('the fuel output of the Sorium harvesters, which rests on the ranks of the naval admin commanders')]),
  '/survey-progress': Object.freeze([navalRank('the survey rates of the fleets, which rest on the ranks of the naval admin commanders')]),
})

const MINERAL_NAMES = Object.freeze(['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'])
const MINERAL_LIST = MINERAL_NAMES.join(' ')
const STOCKPILES = 'FCT_Population(FuelStockpile MaintenanceStockpile)'
export const SHARE_NAMES = Object.freeze(['Industrial', 'Survey', 'Logistics', 'Engineering', 'CrewTraining', 'Tactical', 'Reaction', 'FleetTraining'])

// The columns a query names by building them (`Table.${name}`, which the generated reads show as a bare `*` or as `prefix*`), by table: a column per mineral, a column per command-type share. A bare `*` stands for these names, a `prefix*` for the prefix before each of them (`Reserve*` for `ReserveDuranium` and the other reserves), and each marker of an input is resolved on its own: an input that builds only the stocks does not read the reserves. A table with no entry here has its built-by-name columns named in `EXTRA_READS`.
export const MARKER_COLUMNS = Object.freeze({
  FCT_Population: MINERAL_NAMES,
  FCT_IndustrialProjects: MINERAL_NAMES,
  FCT_ShipyardTask: MINERAL_NAMES,
  FCT_MassDriverPackets: MINERAL_NAMES,
  FCT_ShipDesignComponents: MINERAL_NAMES,
  DIM_NavalAdminCommandType: SHARE_NAMES,
})

// The columns an input uses of a table whose bare `*` marker stands for more than the page needs: { [route]: { [input]: { [table]: [column] } } }, which replace that marker's list in `MARKER_COLUMNS`. Each page loads the naval admin commands of one share (`loadNavalAdmins(..., { share })`), the Colonization Planner through utilities/colonization-data.js.
export const MARKER_USES = Object.freeze({
  '/production': Object.freeze({ navalAdmins: Object.freeze({ DIM_NavalAdminCommandType: Object.freeze(['Industrial']) }) }),
  '/mineral-outlook': Object.freeze({ navalAdmins: Object.freeze({ DIM_NavalAdminCommandType: Object.freeze(['Industrial']) }) }),
  '/habitability': Object.freeze({ outlook: Object.freeze({ DIM_NavalAdminCommandType: Object.freeze(['Industrial']) }), navalAdmins: Object.freeze({ DIM_NavalAdminCommandType: Object.freeze(['Industrial']) }) }),
  '/logistics': Object.freeze({ navalAdmins: Object.freeze({ DIM_NavalAdminCommandType: Object.freeze(['Industrial']) }) }),
  '/survey-progress': Object.freeze({ navalAdmins: Object.freeze({ DIM_NavalAdminCommandType: Object.freeze(['Survey']) }) }),
})

// Reads the scan of the pages cannot see, as 'Table(Column Column)', added to the generated ones: a query that names its columns without the table, a column built by name through a helper, a column named by a value (`DIM_PlanetaryInstallation.${value}`). An input whose scan finds a table and no column of it needs an entry here, or one in `TOLERATED`.
const EXTRA_READS = Object.freeze({
  shell: Object.freeze({ probe: 'FCT_Game(GameID StartYear GameTime)' }),
  '/production': Object.freeze({
    colonyFacilities: 'DIM_PlanetaryInstallation(ResearchValue GroundTrainingValue)',
    procurementSources: 'FCT_ShipDesignComponents(Size Cost)',
  }),
  '/warnings': Object.freeze({
    page: `DIM_PlanetaryInstallation(ConstructionValue OrdnanceProductionValue FighterProductionValue) ${STOCKPILES}`,
    'check:dangerous-rifts': STOCKPILES,
    'check:free-construction-capacity': 'DIM_PlanetaryInstallation(ConstructionValue)',
    'check:free-ordnance-capacity': 'DIM_PlanetaryInstallation(OrdnanceProductionValue)',
    'check:free-fighter-capacity': 'DIM_PlanetaryInstallation(FighterProductionValue)',
  }),
  '/habitability': Object.freeze({
    gases: 'DIM_Gases(GasID Name BoilingPoint GHGas AntiGHGas Dangerous DangerousLevel)',
    outlook: `FCT_MassDriverPackets(GameID RaceID ${MINERAL_LIST})`,
  }),
  '/logistics': Object.freeze({ colonies: 'FCT_MineralDeposit(SystemBodyID MaterialID Amount GameID)' }),
  '/information': Object.freeze({ shipments: 'FCT_MoveOrders(FleetID DestinationItemID DestinationItemType PopulationID GameID MoveActionID)' }),
  '/designed-tech': Object.freeze({
    categories: 'DIM_ResearchCategories(CategoryID Name)',
    classUsage: 'FCT_Ship(ShipClassID GameID RaceID Destroyed)',
  }),
})

// Reads of an input that guard themselves, so the preflight does not check their columns: { [route]: { [input]: { [table]: why } } }. The table still has to exist.
const TOLERATED = Object.freeze({
  '/production': Object.freeze({
    procurementSources: Object.freeze({
      FCT_Game: 'the component read here skips the save revision (identify: false), and the read that checks it names its columns first (utilities/design-data.js)',
      FCT_Increments: 'the component read here skips the save revision (identify: false), and the read that checks it names its columns first (utilities/design-data.js)',
      FCT_System: 'the component read here skips the system fingerprint (identify: false), and the read that checks it names its columns first (utilities/design-data.js)',
    }),
  }),
  '/warnings': Object.freeze({
    'check:mining-redeployment': Object.freeze({
      FCT_Fleet: 'the fleet speed is read only when the save has the column (warnings/common.js readRedeploymentSites) and is listed as an unknown travel input otherwise; the other columns of the table are read, and so checked, by the mining checks beside it',
    }),
  }),
  '/propulsion': Object.freeze({
    tanks: Object.freeze({
      FCT_Game: 'the save revision read checks the columns it needs first (utilities/design-data.js)',
      FCT_Increments: 'the save revision read checks the columns it needs first (utilities/design-data.js)',
      FCT_System: 'the system fingerprint read checks the columns it needs first (utilities/design-data.js)',
    }),
  }),
  shell: Object.freeze({
    flyout: Object.freeze(Object.fromEntries(['FCT_BannedBodies', 'FCT_GroundUnitTraining', 'FCT_IndustrialProjects', 'FCT_RaceSurveyLocation', 'FCT_ResearchProject', 'FCT_Shipyard', 'FCT_ShipyardTask', 'FCT_SurveyLocation'].map((table) => [table, 'a line of the section flyout is read on hover and left out when its query fails (store/peeks.js)']))),
  }),
})

// The commander bonuses the planners read by ID, with the name the save's DIM_CommanderBonusType holds for each, whether it is a multiplier (`percentage`) or a rating, what a page leaves out when the row differs (`effect`, a text or { default, [route] } texts, on each of `routes`).
const MIXIN_REPORTS = ['/production', '/colony-outlook', '/logistics', '/mineral-outlook', '/shipyards']
const OFFICERS = 'the officer bonuses shown as unknown, and the suggestions and rankings that rest on them'

export const BONUS_NAMES = Object.freeze({
  2: Object.freeze({ name: 'Survey', percentage: true, routes: Object.freeze(['/survey-progress', '/commanders']), effect: Object.freeze({ default: 'the survey rates of the fleets', '/commanders': OFFICERS }) }),
  3: Object.freeze({ name: 'Research', percentage: true, routes: Object.freeze(['/production', '/technologies', '/commanders']), effect: Object.freeze({ '/production': 'the research rates of projects with a scientist', '/technologies': 'the research bonus of the scientists', '/commanders': OFFICERS }) }),
  4: Object.freeze({ name: 'Shipbuilding', percentage: true, routes: Object.freeze(MIXIN_REPORTS), effect: 'the shipyard build rates of the colonies' }),
  5: Object.freeze({ name: 'Production', percentage: true, routes: Object.freeze([...MIXIN_REPORTS, '/lagrange']), effect: Object.freeze({ default: 'the construction, ordnance and fighter capacity of the colonies', '/lagrange': 'the stabilisation ships and the stabilisation times' }) }),
  6: Object.freeze({ name: 'Mining', percentage: true, routes: Object.freeze(['/commanders', '/mineral-outlook', '/habitability', '/logistics', '/minerals']), effect: Object.freeze({ '/commanders': OFFICERS, '/mineral-outlook': 'the mining rates of the colonies and the orbital miners', '/habitability': 'the mineral runway that sets the plan\'s mineral weights', '/logistics': 'the fuel output of the Sorium harvesters', '/minerals': 'the output of the civilian mining policy' }) }),
  8: Object.freeze({ name: 'Population Growth', percentage: true, routes: Object.freeze(['/colony-outlook', '/commanders']), effect: Object.freeze({ default: 'the growth rates of the colonies', '/commanders': OFFICERS }) }),
  9: Object.freeze({ name: 'Terraforming', percentage: true, routes: Object.freeze(['/production', '/habitability', '/commanders']), effect: Object.freeze({ default: 'the terraforming capacity and rates of the colonies, with the commanders and naval admin chain behind them', '/commanders': OFFICERS }) }),
  11: Object.freeze({ name: 'Ground Construction', percentage: true, routes: Object.freeze(MIXIN_REPORTS), effect: 'the ground unit construction rates of the colonies' }),
  25: Object.freeze({ name: 'Colony Administration', percentage: false, routes: Object.freeze(['/commanders']), effect: OFFICERS }),
  27: Object.freeze({ name: 'Research Admin', percentage: false, routes: Object.freeze(['/technologies', '/commanders']), effect: Object.freeze({ '/technologies': 'the labs the scientists may run', '/commanders': OFFICERS }) }),
})

export const COMPONENT_TYPES = Object.freeze({
  29: Object.freeze({ name: 'Jump Point Stabilisation', routes: Object.freeze(['/lagrange']), effect: 'the stabilisation ships and the stabilisation times' }),
})

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

// The generated and extra text of an input as { reads: { [table]: [column] }, markers: { [table]: ['*' or 'prefix*'] } }: a marker stands for columns the scan saw a query build by name.
const parseReads = (text) => {
  const reads = {}
  const markers = {}

  text.split(/\s+(?![^(]*\))/).filter(Boolean).forEach((entry) => {
    const [, table, columns] = /^([A-Za-z0-9_]+)(?:\(([^)]*)\))?$/.exec(entry)
    const names = columns ? columns.split(' ').filter(Boolean) : []

    reads[table] = names.filter((name) => !name.endsWith('*'))

    if (names.some((name) => name.endsWith('*'))) {
      markers[table] = names.filter((name) => name.endsWith('*'))
    }
  })

  return { reads, markers }
}

const merged = (first, second) => {
  const reads = { ...first }

  Object.entries(second).forEach(([table, columns]) => {
    reads[table] = [...new Set([...(reads[table] || []), ...columns])]
  })

  return reads
}

// The columns one marker of an input stands for: the columns `MARKER_USES` gives that input for a bare `*`, else `MARKER_COLUMNS` of the table behind the marker's prefix.
const markerColumns = (route, key, table, marker) => {
  const used = marker === '*' && MARKER_USES[route] && MARKER_USES[route][key] && MARKER_USES[route][key][table]

  return used || (MARKER_COLUMNS[table] || []).map((name) => `${marker.slice(0, -1)}${name}`)
}

const inputOf = (route, key, input) => {
  const generated = parseReads(input.reads)
  const extra = EXTRA_READS[route] && EXTRA_READS[route][key] ? parseReads(EXTRA_READS[route][key]).reads : {}
  const reads = merged(generated.reads, extra)
  const resolved = {}

  Object.entries(generated.markers).forEach(([table, markers]) => {
    resolved[table] = Object.fromEntries(markers.map((marker) => [marker, markerColumns(route, key, table, marker)]))
    reads[table] = [...new Set([...(reads[table] || []), ...Object.values(resolved[table]).flat()])]
  })

  return Object.freeze({ key, label: input.label, reads, markers: generated.markers, resolved, tolerated: (TOLERATED[route] && TOLERATED[route][key]) || {}, optional: isOptional(route, key) })
}

// Every input of every report: { [route]: [{ key, label, reads: { [table]: [column] }, markers, resolved: { [table]: { [marker]: [column] } }, tolerated, optional }] }, the app shell's reads under 'shell'.
export const INPUTS = Object.freeze(Object.fromEntries(Object.entries(READS).map(([route, inputs]) => [route, Object.entries(inputs).map(([key, input]) => inputOf(route, key, input))])))

export const REPORT_ROUTES = Object.freeze(Object.keys(INPUTS).filter((route) => route !== 'shell'))

const GATE_TABLES = Object.freeze({
  DIM_CommanderBonusType: ['BonusID', 'Description', 'Percentage'],
  DIM_ComponentType: ['ComponentTypeID', 'TypeDescription'],
})

const FORMULA_COLUMNS = Object.freeze(['AllowCMC', 'AncientRelics'])

const allTables = () => {
  const tables = new Set(Object.keys(GATE_TABLES))

  Object.values(INPUTS).forEach((inputs) => inputs.forEach((input) => Object.keys(input.reads).forEach((table) => tables.add(table))))
  tables.add('FCT_Game')

  return [...tables].sort()
}

const CHUNK = 100

// The schema query of some tables: one row per column. `pragma_table_xinfo` also lists generated and hidden columns, which a plain `table_info` leaves out. A table the save lacks gives no rows.
const schemaSql = (tables) => tables.map((table) => {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`${table} is not a table name`)
  }

  return `select '${table}' as tbl, name from pragma_table_xinfo('${table}')`
}).join(' union all ')

// { [lower-case table]: Set of lower-case column names } from the rows of `schemaSql`.
export const schemaOf = (rows) => {
  const schema = new Map()

  rows.forEach(({ tbl, name }) => {
    const key = tbl.toLowerCase()

    if (!schema.has(key)) {
      schema.set(key, new Set())
    }

    schema.get(key).add(String(name).toLowerCase())
  })

  return schema
}

const hasTable = (schema, table) => schema.has(table.toLowerCase())

const hasColumn = (schema, table, column) => hasTable(schema, table) && schema.get(table.toLowerCase()).has(column.toLowerCase())

// The formula version of the save as a result of 'capability.formulaVersion': assumed 2.7.x when the save has both 2.7 columns of FCT_Game, unavailable (naming the absent ones) otherwise. Separate from the structure checks: a save can have every column a report reads and still be of another game version.
export const formulaResult = (schema) => {
  const missing = qualified(FORMULA_COLUMNS.filter((column) => !hasColumn(schema, 'FCT_Game', column)), 'FCT_Game')

  return missing.length ? unavailable({ rule: FORMULA, missing, present: qualified(FORMULA_COLUMNS.filter((column) => hasColumn(schema, 'FCT_Game', column)), 'FCT_Game') }) : ofRule({ rule: FORMULA, value: STATED_FORMULA_VERSION, inputs: { present: qualified(FORMULA_COLUMNS, 'FCT_Game') } })
}

// The formula version the save's schema stands for: the stated one ('2.7.x') for a save with both 2.7 columns of FCT_Game, null for any other shape, and the landing rule is then not settled (`landingThreshold`).
export const loadFormulaVersion = async (database) => {
  const [rows] = await database.query(schemaSql(['FCT_Game']))

  return valueOrNull(formulaResult(schemaOf(rows)))
}

// 'Table.Column' of each column; joined by name so that the scan of the pages does not take these for reads of the pages.
const qualified = (columns, table) => columns.map((column) => [table, column].join('.'))

const fieldText = (gap) => (gap.column ? `${gap.table}.${gap.column}` : `${gap.table} (table)`)

// What an input reads that the schema lacks: [{ table, column, columns }], `column` null for a table the save lacks (`columns` the columns read of it).
const gapsOf = (reads, schema) => Object.entries(reads).flatMap(([table, columns]) => {
  if (!hasTable(schema, table)) {
    return [{ table, column: null, columns }]
  }

  return columns.filter((column) => !hasColumn(schema, table, column)).map((column) => ({ table, column, columns: [column] }))
})

const covers = (group, gap) => group.fields.some((field) => {
  const [table, column] = field.split('.')

  return table === gap.table && (column === '*' || (gap.column ? column === gap.column : gap.columns.length > 0 && gap.columns.every((read) => read === column)))
})

const uniqueFields = (gaps) => [...new Set(gaps.map(fieldText))]

const STATUS_ORDER = { supported: 0, degraded: 1, unsupported: 2 }

const worse = (first, second) => (STATUS_ORDER[second] > STATUS_ORDER[first] ? second : first)

const evaluateInputs = (route, schema) => {
  const groups = SOFT[route] || []
  const missing = []
  const degraded = []
  const softFields = new Map(groups.map((group) => [group.key, new Set()]))
  const inputs = INPUTS[route] || []

  inputs.forEach((input) => {
    const gaps = gapsOf(input.reads, schema)

    if (!gaps.length) {
      return
    }

    const hard = []

    gaps.forEach((gap) => {
      const group = groups.find((candidate) => covers(candidate, gap))

      if (group) {
        softFields.get(group.key).add(fieldText(gap))
      } else {
        hard.push(gap)
      }
    })

    if (!hard.length) {
      return
    }

    if (input.optional) {
      degraded.push({ key: input.key, label: input.label, affects: input.label, fields: uniqueFields(hard) })
    } else {
      missing.push({ key: input.key, label: input.label, fields: uniqueFields(hard) })
    }
  })

  groups.forEach((group) => {
    if (softFields.get(group.key).size) {
      degraded.push({ key: group.key, label: group.label, affects: group.affects, fields: [...softFields.get(group.key)], group: true })
    }
  })

  const unchecked = inputs.flatMap((input) => Object.entries(input.tolerated).filter(([table]) => Object.keys(input.reads).includes(table)).map(([table, why]) => ({ key: input.key, label: input.label, table, why })))
  const status = missing.length ? 'unsupported' : degraded.length ? 'degraded' : 'supported'

  return { status, missing, degraded, unchecked, groups: Object.fromEntries(groups.map((group) => [group.key, softFields.get(group.key).size === 0])) }
}

const bonusGate = (id, expected, row, schema) => {
  const missingColumns = qualified(GATE_TABLES.DIM_CommanderBonusType.filter((column) => !hasColumn(schema, 'DIM_CommanderBonusType', column)), 'DIM_CommanderBonusType')

  if (missingColumns.length) {
    return unavailable({ rule: BONUS, missing: missingColumns })
  } else if (!row) {
    return unavailable({ rule: BONUS, missing: [`DIM_CommanderBonusType row ${id} (${expected.name})`] })
  }

  const kind = (value) => (Number(value) === 1 ? 'a multiplier' : 'a rating')
  const problems = []

  if (String(row.Description || '').trim().toLowerCase() !== expected.name.toLowerCase()) {
    problems.push(`bonus ${id} is named "${row.Description}", not "${expected.name}"`)
  }

  if ((Number(row.Percentage) === 1) !== expected.percentage) {
    problems.push(`bonus ${id} is ${kind(row.Percentage)}, not ${expected.percentage ? 'a multiplier' : 'a rating'}`)
  }

  return problems.length ? unavailable({ rule: BONUS, missing: problems }) : ofRule({ rule: BONUS, value: expected.name, inputs: { present: [`DIM_CommanderBonusType row ${id}`] } })
}

const componentGate = (id, expected, row, schema) => {
  const missingColumns = qualified(GATE_TABLES.DIM_ComponentType.filter((column) => !hasColumn(schema, 'DIM_ComponentType', column)), 'DIM_ComponentType')

  if (missingColumns.length) {
    return unavailable({ rule: COMPONENT, missing: missingColumns })
  } else if (!row) {
    return unavailable({ rule: COMPONENT, missing: [`DIM_ComponentType row ${id} (${expected.name})`] })
  }

  return String(row.TypeDescription || '').trim().toLowerCase() === expected.name.toLowerCase() ? ofRule({ rule: COMPONENT, value: expected.name, inputs: { present: [`DIM_ComponentType row ${id}`] } }) : unavailable({ rule: COMPONENT, missing: [`component type ${id} is named "${row.TypeDescription}", not "${expected.name}"`] })
}

// The lookup rows the planners key on, as results: { bonuses: { [bonus ID]: result of 'capability.bonusName' }, components: { [component type ID]: result of 'capability.componentType' } }. A result is unavailable when the row differs from what the planners expect, or the table, column or row is missing, and names why.
export const gatesOf = (schema, rows = {}) => ({
  bonuses: Object.fromEntries(Object.entries(BONUS_NAMES).map(([id, expected]) => [id, bonusGate(id, expected, (rows.bonuses || {})[id], schema)])),
  components: Object.fromEntries(Object.entries(COMPONENT_TYPES).map(([id, expected]) => [id, componentGate(id, expected, (rows.components || {})[id], schema)])),
})

const gateEntries = (gates) => [
  ...Object.entries(gates.bonuses).map(([id, result]) => ({ key: `bonus ${id}`, label: `Commander bonus ${id}, ${BONUS_NAMES[id].name}`, gate: BONUS_NAMES[id], result })),
  ...Object.entries(gates.components).map(([id, result]) => ({ key: `component type ${id}`, label: `Component type ${id}, ${COMPONENT_TYPES[id].name}`, gate: COMPONENT_TYPES[id], result })),
]

// The bonus IDs whose row does not read as the planners expect, as a Set of numbers: what a page leaves its derived figures out for. Without gates (the check has not answered for the copy now open) every ID the planners read is in it: an assessment not made never releases a figure that depends on a lookup row.
export const blockedBonuses = (gates) => new Set(Object.entries(gates ? gates.bonuses : BONUS_NAMES).filter(([, result]) => !gates || !isAvailable(result)).map(([id]) => Number(id)))

const UNCONFIRMED = 'the capability check of the save has not confirmed the lookup rows these figures depend on'

// Why the lookup rows a figure depends on are not confirmed, as a list of texts: [] when every one of `bonuses` (commander bonus IDs) and `components` (component type IDs) reads as expected, what each lookup says it differs in when the check answered, and one text when it has not (`gates` null).
export const gateGaps = (gates, { bonuses = [], components = [] }) => {
  if (!gates) {
    return [UNCONFIRMED]
  }

  const gapsOfGate = (result, id, kind) => (result ? (isAvailable(result) ? [] : result.inputs.missing) : [`${kind} ${id} was not checked`])

  return [...bonuses.flatMap((id) => gapsOfGate(gates.bonuses[id], id, 'commander bonus')), ...components.flatMap((id) => gapsOfGate(gates.components[id], id, 'component type'))]
}

// The save's capabilities from its schema (`schemaOf`) and lookup rows (`rows`: { bonuses, components } keyed by ID): { formula, gates, reports: { [route]: { status, missing, degraded, unchecked, groups } }, shell, tables, columns }.
//  - `missing` are the required inputs with a missing field: [{ key, label, fields }].
//  - `degraded` are the optional inputs and soft groups with a missing field, [{ key, label, affects, fields, group? }], and the lookup rows that differ, as { key, label, affects, fields: [why], gate: true }.
//  - `unchecked` are the reads whose columns the preflight does not check because the read guards itself, [{ key, label, table, why }].
//  - `groups` is { [soft group key]: whether the report has every column of the group }, for a page to choose its queries by.
export const evaluate = (schema, rows = {}) => {
  const gates = gatesOf(schema, rows)
  const entries = gateEntries(gates)
  const reports = {}

  REPORT_ROUTES.forEach((route) => {
    const report = evaluateInputs(route, schema)
    const failed = entries.filter((entry) => (entry.gate.routes.includes(route)) && !isAvailable(entry.result))

    failed.forEach((entry) => {
      report.degraded.push({ key: entry.key, label: entry.label, affects: typeof entry.gate.effect === 'string' ? entry.gate.effect : entry.gate.effect[route] || entry.gate.effect.default, fields: entry.result.inputs.missing, gate: true })
    })

    reports[route] = { route, ...report, status: failed.length ? worse(report.status, 'degraded') : report.status }
  })

  const shell = evaluateInputs('shell', schema)
  const columns = [...schema.values()].reduce((total, set) => total + set.size, 0)

  return { formula: formulaResult(schema), gates, reports, shell: { ...shell, status: shell.status === 'unsupported' ? 'degraded' : shell.status }, tables: schema.size, columns }
}

const asRows = (rows) => (Array.isArray(rows) ? rows : [])

const readGateRows = async (database, schema) => {
  const rows = { bonuses: {}, components: {} }

  if (GATE_TABLES.DIM_CommanderBonusType.slice(0, 2).every((column) => hasColumn(schema, 'DIM_CommanderBonusType', column))) {
    const percentage = hasColumn(schema, 'DIM_CommanderBonusType', 'Percentage') ? 'Percentage' : 'null as Percentage'
    const [bonuses] = await database.query(`select BonusID, Description, ${percentage} from DIM_CommanderBonusType where BonusID in (${Object.keys(BONUS_NAMES).join(', ')})`, { raw: true })

    asRows(bonuses).forEach((row) => {
      rows.bonuses[row.BonusID] = row
    })
  }

  if (GATE_TABLES.DIM_ComponentType.every((column) => hasColumn(schema, 'DIM_ComponentType', column))) {
    const [components] = await database.query(`select ComponentTypeID, TypeDescription from DIM_ComponentType where ComponentTypeID in (${Object.keys(COMPONENT_TYPES).join(', ')})`, { raw: true })

    asRows(components).forEach((row) => {
      rows.components[row.ComponentTypeID] = row
    })
  }

  return rows
}

// Checks the opened save: reads its schema and the lookup rows, and returns `evaluate`'s result. Only selects, and none of it is cached, so a retry reads the copy now open.
export const preflight = async (database) => {
  const tables = allTables()
  const rows = []

  for (let start = 0; start < tables.length; start += CHUNK) {
    const [chunk] = await database.query(schemaSql(tables.slice(start, start + CHUNK)), { raw: true })

    rows.push(...asRows(chunk))
  }

  const schema = schemaOf(rows)

  return evaluate(schema, await readGateRows(database, schema))
}

// What a report's missing and degraded parts say, for a notice: { missing: [{ text, fields }], degraded: [{ text, fields, gate }] }. A missing part is what the report cannot do without, a degraded one what is left out of it, and `fields` what the save lacks (or, for a lookup row, how it differs).
export const describeReport = (report) => ({
  unchecked: report.unchecked.map((entry) => ({ text: entry.label, fields: [entry.table], why: entry.why })),
  missing: report.missing.map((entry) => ({ text: entry.label, fields: entry.fields })),
  degraded: report.degraded.map((entry) => ({ text: entry.gate ? `${entry.label} does not read as expected` : entry.affects, fields: entry.fields, gate: Boolean(entry.gate), effect: entry.gate ? `Left out: ${entry.affects}.` : '' })),
})
