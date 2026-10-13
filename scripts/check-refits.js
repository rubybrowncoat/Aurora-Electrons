/*
  Checks the directional refit and retool arithmetic (src/renderer/utilities/refits.js) against worked examples and against the refit tasks and retool activities saves hold, read-only.

  node scripts/check-refits.js [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784), the stock 2.7.1 save one folder up (AuroraDB_271_skoormit_saved.db, game 138, race 785) and the other saves that are known to hold a refit task or a retool activity (../AuroraDB.db, game 138, race 785; ../AuroraDB_270_Falryx_date_issue.db, game 141, race 791; AuroraDB_Pepega.db and AuroraDB_TerranFederation.db, whose game and race are read from the save); a save that is not there is reported as not run.

  It proves: the worked examples (an added component, a removal that earns no credit, a size change, A to B against B to A, the one-decimal rounding of a refit's minerals, the retool cost with and without a tooled class, the no-retool test, a yard's eligibility, an unknown figure staying unknown); and, on every save, that each stored refit task's TotalBP and minerals and each stored retool activity's RequiredBP are what the rules give for its two classes, that a stored construction task sits in a yard that takes its class, and that the retool and refit rules agree on the yards' own tooling. A save with no refit task or retool activity is reported as having nothing to compare: the designated stock and modded saves hold none. Any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const MINERALS = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const DEFAULT_SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: '../AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
  { file: '../AuroraDB.db', game: 138, race: 785 },
  { file: '../AuroraDB_270_Falryx_date_issue.db', game: 141, race: 791 },
  { file: 'AuroraDB_Pepega.db', game: null, race: null },
  { file: 'AuroraDB_TerranFederation.db', game: null, race: null },
]
const TOLERANCE = 1e-6

let failures = 0
let checks = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(b))

const parseArguments = (argv) => {
  const saves = []

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  return saves.length ? saves : DEFAULT_SAVES
}

// Sequelize's raw query over a sqlite3 handle: `query(sql, { replacements })` resolves to [rows].
const rawQuery = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
  const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
  const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

  raw.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve([rows])))
})

// A read-only stand-in for the app's database object: `query(sql, { replacements })` resolves to [rows], as Sequelize's raw query does.
const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)
    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)
      return
    }

    resolve({
      file: path.basename(resolved),
      query: rawQuery(raw),
      close: () => raw.close(),
    })
  })
})

const covered = new Set()

const note = (result) => {
  if (result && result.rule) {
    covered.add(typeof result.rule === 'string' ? result.rule : result.rule.id)
  }

  return result
}

const worked = (refits, provenance) => {
  const { classChanges, refitCost, refitTotal, costShare, noRetoolCheck, retoolCost, retoolTime, yardAccepts, yardRetools, refitRate, refitTime, inBand } = refits
  const { isAvailable, valueOrNull, STATUS } = provenance
  const part = (id, cost, minerals = {}) => ({ id, name: `part ${id}`, typeId: 1, cost, minerals: Object.fromEntries(MINERALS.map((name) => [name, minerals[name] ?? 0])) })
  const components = { 1: part(1, 10, { Duranium: 2 }), 2: part(2, 30, { Corbomite: 3 }), 3: part(3, 20, { Uridium: 1 }), 4: part(4, 4, { Duranium: 10 }), 5: part(5, null) }
  const make = (name, sizeHS, cost, counts, extra = {}) => ({ id: name, name, sizeHS, cost, commercial: false, obsolete: false, shippingLine: false, otherRace: false, prototype: false, counts, ...extra })
  const A = make('A', 10, 100, { 1: 2, 2: 1 })
  const B = make('B', 12, 500, { 1: 3, 3: 1 })
  const ab = refitCost(A, B, components, '2.7.1')
  const ba = refitCost(B, A, components, '2.7.1')

  Object.values(ab).forEach((value) => value && value.rule && note(value))
  check('worked: A to B adds one part 1 (10) and one part 3 (20); the lost part 2 earns no credit', near(valueOrNull(ab.added), 30) && ab.changes.filter((change) => change.added > 0).length === 2 && ab.changes.find((change) => change.id === 2).removed === 1)
  check('worked: A to B adds 20% overhead and 2/10 for the size change: 30 x 1.4 = 42', near(valueOrNull(ab.overhead), 6) && near(valueOrNull(ab.surcharge), 6) && near(valueOrNull(ab.total), 42))
  check('worked: B to A is a different figure, 30 x (1.2 + 2/12) = 41', near(valueOrNull(ba.total), 41) && !near(valueOrNull(ba.total), valueOrNull(ab.total)))
  check('worked: the minerals of A to B are the added parts\' (2 Duranium, 1 Uridium)', near(valueOrNull(ab.minerals).Duranium, 2) && near(valueOrNull(ab.minerals).Uridium, 1) && near(valueOrNull(ab.minerals).Corbomite, 0))
  check('worked: a refit of a class to itself costs 0, not unknown', near(valueOrNull(refitCost(A, A, components, '2.7.1').total), 0) && classChanges(A, A, components).length === 0)

  const armourA = make('X', 10, 100, { 4: 10 })
  const armourB = make('Y', 10, 100, { 4: 10.25 })
  check('worked: a refit\'s minerals use each added count at one decimal, 0.25 to 0.2 (midpoint to even): 0.2 x 10 = 2 Duranium', near(valueOrNull(refitCost(armourA, armourB, components, '2.7.1').minerals).Duranium, 2))
  check('worked: its cost uses the unrounded 0.25: 0.25 x 4 x 1.2 = 1.2', near(valueOrNull(refitCost(armourA, armourB, components, '2.7.1').total), 1.2))

  const unknownCost = refitCost(A, make('Z', 10, 100, { 1: 2, 2: 1, 5: 1 }), components, '2.7.1')
  check('worked: an added part with no known cost makes the refit unavailable and names the part', !isAvailable(unknownCost.total) && unknownCost.total.inputs.missing.some((name) => name.includes('part 5')))
  check('worked: an unknown class size makes the refit unavailable, never 0', !isAvailable(refitCost(A, make('S', null, 100, { 1: 2 }), components, '2.7.1').total) && valueOrNull(refitCost(A, make('S', null, 100, { 1: 2 }), components, '2.7.1').total) === null)
  check('worked: a save with no version label gives an estimate with the standing caveat', refitCost(A, B, components, null).total.status === STATUS.ESTIMATED && refitCost(A, B, components, null).total.assumptions.length > 0 && refitCost(A, B, components, '2.7.1').total.status === STATUS.CONFIRMED)

  const share = costShare(ab.total, { name: 'A', cost: 100 })
  check('worked: the share of the source class\'s cost is 42%, of the target\'s 8.4%', near(valueOrNull(share), 42) && near(valueOrNull(costShare(ab.total, { name: 'B', cost: 500 })), 8.4) && !isAvailable(costShare(ab.total, { name: 'N', cost: null })) && !isAvailable(costShare(ab.total, { name: 'Z', cost: 0 })))
  note(share)

  const noRetool = noRetoolCheck(A, B, ab.total, '2.7.1')
  const cheap = make('C', 11, 500, { 1: 2, 2: 1, 3: 0.5 })
  const cheapRefit = refitCost(A, cheap, components, '2.7.1')
  note(noRetool.result)
  check('worked: A to B is within the size band but costs 42 against a limit of 20, so it needs retooling', noRetool.withinSize === true && noRetool.affordable === false && noRetool.ok === false && near(noRetool.limit, 20))
  check('worked: A to a class of 11 that adds 0.5 of part 3 costs 10 x 1.3 = 13 and needs no retooling', near(valueOrNull(cheapRefit.total), 13) && noRetoolCheck(A, cheap, cheapRefit.total, '2.7.1').ok === true)
  check('worked: a class over 120% of the size needs retooling however cheap the refit is', noRetoolCheck(A, make('W', 12.5, 500, { 1: 2, 2: 1 }), refitCost(A, make('W', 12.5, 500, { 1: 2, 2: 1 }), components, '2.7.1').total, '2.7.1').ok === false)
  check('worked: a refit whose cost is unknown leaves the no-retool test unknown (null, not a pass)', noRetoolCheck(A, make('Z', 10, 100, { 5: 1 }), refitCost(A, make('Z', 10, 100, { 5: 1 }), components, '2.7.1').total, '2.7.1').ok === null)

  const priced = retoolCost({ tooling: A, target: B, refit: ab.total, slipways: 2, operations: 0.5, version: '2.7.1' })
  const capped = retoolCost({ tooling: A, target: make('T', 12, 30, {}), refit: ab.total, slipways: 2, operations: 0.5, version: '2.7.1' })
  note(priced.cost)
  check('worked: a retool costs the lesser of the refit and the target\'s cost x (0.5 + 0.25 x slipways) x operations: 42 x 1.0 x 0.5 = 21', priced.kind === 'priced' && near(valueOrNull(priced.cost), 21))
  check('worked: when the target costs less than the refit, its cost is the base: 30 x 1.0 x 0.5 = 15', near(valueOrNull(capped.cost), 15))
  check('worked: a yard with no tooled class retools at once for 0', retoolCost({ tooling: null, target: B, refit: ab.total, slipways: 2, operations: 0.5 }).kind === 'immediate' && near(valueOrNull(retoolCost({ tooling: null, target: B, refit: ab.total, slipways: 2, operations: 0.5 }).cost), 0))
  check('worked: an unknown operations figure leaves the retool unavailable and names it', !isAvailable(retoolCost({ tooling: A, target: B, refit: ab.total, slipways: 2, operations: null }).cost) && retoolCost({ tooling: A, target: B, refit: ab.total, slipways: 2, operations: null }).cost.inputs.missing.some((name) => name.includes('operations')))

  const naval = { type: 1, capacity: 600, slipways: 2 }
  const commercial = { type: 2, capacity: 600, slipways: 2 }
  check('worked: a naval yard of 600 t takes a class of 12 but not 12.1', yardAccepts(naval, B).status === 'ok' && yardAccepts(naval, make('Big', 12.1, 1, {})).status === 'blocked')
  check('worked: a commercial yard takes a commercial class only', yardAccepts(commercial, B).status === 'blocked' && yardAccepts(commercial, make('Merchant', 12, 1, {}, { commercial: true })).status === 'ok')
  check('worked: a repair yard is unsupported, a yard with no type unknown, a missing capacity unknown', yardAccepts({ type: 3, capacity: 600 }, B).status === 'unsupported' && yardAccepts({ type: null, capacity: 600 }, B).status === 'unknown' && yardAccepts({ type: 1, capacity: null }, B).status === 'unknown')
  check('worked: a shipping-line class is never taken', yardAccepts(naval, make('Line', 5, 1, {}, { shippingLine: true })).status === 'blocked')
  note({ rule: 'refit.yardAccepts' })

  const tooledNaval = { type: 1, capacity: 600, slipways: 2, tooledId: 'B' }
  check('worked: a yard cannot be retooled for the class it is tooled for, nor for an obsolete class or one with prototype components', yardRetools(tooledNaval, B).status === 'blocked' && yardRetools(naval, make('Old', 5, 1, {}, { obsolete: true })).status === 'blocked' && yardRetools(naval, make('Proto', 5, 1, {}, { prototype: true })).status === 'blocked' && yardRetools(naval, B).status === 'ok' && yardRetools({ type: 3, capacity: 600 }, B).status === 'unsupported')
  check('worked: a commercial yard is retooled for a commercial class only, and an unknown obsolete flag leaves the retool unknown', yardRetools(commercial, B).status === 'blocked' && yardRetools(commercial, make('Merchant', 12, 1, {}, { commercial: true })).status === 'ok' && yardRetools(naval, make('Maybe', 5, 1, {}, { obsolete: null })).status === 'unknown')
  check('worked: refitTotal agrees with refitCost without the minerals', near(valueOrNull(refitTotal(A, B, components, '2.7.1').total), valueOrNull(ab.total)) && refitTotal(A, B, components, '2.7.1').minerals === undefined)
  const rate = refitRate({ ShipyardBuildRate: 1000, ShipyardOperations: 1 }, B)
  const time = refitTime(ab.total, rate)
  check('worked: a refit\'s time is its cost over the rate (a yard that is not read gives no time)', isAvailable(time) && rate.value > 0 && near(time.value, 42 / rate.value * 365) && !isAvailable(refitTime(ab.total, refitRate(undefined, B))))
  note(time)

  const retoolDays = retoolTime({ ShipyardBuildRate: 1000, ShipyardOperations: 1 }, { type: 1, capacity: 5000, slipways: 2 }, priced.cost)

  check('worked: a retool of 21 BP at 1000 BP a year shared by 2 slipways takes 21 / 1000 x 365 / 2 days; no modifiers row gives no time', isAvailable(retoolDays) && near(retoolDays.value, 21 / 1000 * 365 / 2) && !isAvailable(retoolTime(undefined, { type: 1, capacity: 5000, slipways: 2 }, priced.cost)))

  const unknownTarget = make('U', 10, 100, { 1: null, 2: 1 })
  const unknownSource = make('V', 10, 100, { 1: 2, 2: null })
  const toUnknown = refitCost(A, unknownTarget, components, '2.7.1')
  const fromUnknown = refitCost(unknownSource, B, components, '2.7.1')
  check('worked: a component whose count on the target class is not known leaves the refit total and minerals unavailable, naming the count', !isAvailable(toUnknown.total) && !isAvailable(toUnknown.minerals) && toUnknown.total.inputs.missing.some((name) => name.includes('count of part 1') && name.includes('target')) && toUnknown.minerals.inputs.missing.some((name) => name.includes('count of part 1')))
  check('worked: a component whose count on the source class is not known does the same, naming the source', !isAvailable(fromUnknown.total) && !isAvailable(fromUnknown.minerals) && fromUnknown.total.inputs.missing.some((name) => name.includes('count of part 2') && name.includes('source')))
  check('worked: that change row has no added or removed figure, and the unknown count is not 0', classChanges(A, unknownTarget, components).find((change) => change.id === 1).added === null && classChanges(A, unknownTarget, components).find((change) => change.id === 1).unknown.length === 1 && classChanges(A, unknownTarget, components).find((change) => change.id === 1).removed === null)
  check('worked: a component absent from a class whose counts are given stays a real 0 (the refit adds it)', isAvailable(ab.total) && classChanges(A, B, components).find((change) => change.id === 3).unknown.length === 0 && classChanges(A, B, components).find((change) => change.id === 3).from === 0)
  check('worked: the size window is true, false, and null when a size is not known', inBand(A, make('N', 11, 1, {})) === true && inBand(A, make('F', 13, 1, {})) === false && inBand(A, make('S', null, 1, {})) === null && inBand(make('S', null, 1, {}), A) === null)

  const unknownLine = yardAccepts(naval, make('Line', 5, 1, {}, { shippingLine: null }))
  const unknownOther = yardAccepts(naval, make('Other', 5, 1, {}, { otherRace: null }))
  check('worked: a class whose shipping-line or other-race flag is not known is unknown for a yard, naming the flag, never taken', unknownLine.status === 'unknown' && unknownLine.missing.some((name) => name.includes('shipping')) && unknownOther.status === 'unknown' && unknownOther.missing.some((name) => name.includes('race')))
  check('worked: a known blocker still decides it with a flag unknown', yardAccepts(naval, make('Big', 12.1, 1, {}, { shippingLine: null })).status === 'blocked' && yardAccepts(naval, make('Big', 12.1, 1, {}, { shippingLine: null })).blockers.length === 1)
  check('worked: a class with an unknown prototype flag leaves a retool unknown, a known prototype blocks it', yardRetools(naval, make('Maybe', 5, 1, {}, { prototype: null })).status === 'unknown' && yardRetools(naval, make('Proto', 5, 1, {}, { prototype: true })).status === 'blocked')
}

// The loader over a stand-in database whose rows hold a null component count and a null prototype flag.
const loaderChecks = async (refits) => {
  const classRows = [{ ShipClassID: 1, ClassName: 'P', Size: 10, Cost: 100, Commercial: 0, Obsolete: 0, ClassShippingLineID: 0, OtherRaceClassID: 0 }, { ShipClassID: 2, ClassName: 'Q', Size: 10, Cost: 100, Commercial: 0, Obsolete: 0, ClassShippingLineID: 0, OtherRaceClassID: 0 }, { ShipClassID: 3, ClassName: 'R', Size: 10, Cost: 100, Commercial: 0, Obsolete: 0, ClassShippingLineID: 0, OtherRaceClassID: 0 }]
  const part = (ClassID, ComponentID, NumComponent, Prototype) => ({ ClassID, ComponentID, NumComponent, Name: `part ${ComponentID}`, ComponentTypeID: 1, Cost: 10, Prototype })
  const partRows = [part(1, 7, 2, 0), part(1, 7, null, 0), part(1, 8, 1, 0), part(2, 7, 1, null), part(3, 7, 1, 1), part(3, 8, 1, null)]
  const database = { query: async (sql) => (sql.includes('pragma_table_info') ? [[{ name: 'Prototype' }]] : sql.includes('FCT_ClassComponent') ? [partRows] : [classRows]) }
  const { classes } = await refits.loadRefitClasses(database, { GameID: 1, RaceID: 1 })
  const [p, q, r] = classes

  check('loader: a null component count stays null through the aggregation of a class\'s rows, and a part with a count stays a number', p.counts[7] === null && p.counts[8] === 1 && !(9 in p.counts))
  check('loader: a null prototype flag leaves the class\'s flag null, a true flag wins over a null, a false flag is false', q.prototype === null && r.prototype === true && p.prototype === false)
}

const taskMinerals = (task) => Object.fromEntries(MINERALS.map((name) => [name, typeof task[name] === 'number' ? task[name] : null]))

const raceOperations = async (database, race) => {
  try {
    const [[row]] = await database.query('select ShipyardOperations from FCT_Race where RaceID = :RaceID', { replacements: { RaceID: race } })

    return row && typeof row.ShipyardOperations === 'number' ? row.ShipyardOperations : null
  } catch {
    return null
  }
}

const resolveIds = async (database, save) => {
  if (save.game !== null) {
    return save
  }

  const [rows] = await database.query('select FCT_ShipyardTask.GameID, FCT_ShipyardTask.RaceID, count(*) as Tasks from FCT_ShipyardTask where FCT_ShipyardTask.TaskTypeID in (2, 4) group by FCT_ShipyardTask.GameID, FCT_ShipyardTask.RaceID order by Tasks desc')
  const [retools] = await database.query('select FCT_Shipyard.GameID, FCT_Shipyard.RaceID, count(*) as Tasks from FCT_Shipyard where FCT_Shipyard.TaskType = 7 group by FCT_Shipyard.GameID, FCT_Shipyard.RaceID order by Tasks desc')
  const [first] = [...rows, ...retools]

  return first ? { ...save, game: first.GameID, race: first.RaceID } : null
}

const runSave = async (utilities, save, label) => {
  const { refits, provenance, transport } = utilities
  const database = await openSave(save.file)

  if (!database) {
    console.log(`SKIP  ${label}: ${save.file} is not there (not run)`)
    return
  }

  try {
    const ids = await resolveIds(database, save)

    if (!ids) {
      console.log(`INFO  ${label}: no game and race with a refit task or retool activity could be read (nothing to compare)`)
      return
    }

    const scope = { GameID: ids.game, RaceID: ids.race }
    const version = await transport.loadFormulaVersion(database).catch(() => null)
    const operations = await raceOperations(database, ids.race)
    const { classes, components } = await refits.loadRefitClasses(database, scope)
    const classesById = Object.fromEntries(classes.map((shipClass) => [shipClass.id, shipClass]))
    const tasks = await refits.loadRefitTasks(database, scope).catch((error) => { check(`${label}: refit tasks load`, false, error.message); return [] })
    const retools = await refits.loadRetoolTasks(database, scope).catch((error) => { check(`${label}: retool activities load`, false, error.message); return [] })
    const yards = await refits.loadYards(database, scope).catch((error) => { check(`${label}: yards load`, false, error.message); return [] })

    console.log(`INFO  ${label}: ${database.file} game ${ids.game} race ${ids.race}, version ${version || 'not shown'}, shipyard operations ${operations}, ${classes.length} classes, ${yards.length} yards, ${tasks.length} refit tasks, ${retools.length} retool activities`)

    if (!tasks.length && !retools.length) {
      console.log(`INFO  ${label}: the save holds no refit task and no retool activity: nothing to compare with the rules`)
    }

    for (const task of tasks) {
      const result = refits.checkRefitTask(task, classesById, components, version)
      const tag = `${label}: refit task ${task.ID} (${result.source ? result.source.name : task.SourceClassID} to ${result.target ? result.target.name : task.TargetClassID})`

      if (result.matches === null) {
        console.log(`INFO  ${tag}: not comparable (a class or a figure is missing)`)
        continue
      }

      result.refit && note(result.refit.total)
      check(`${tag}: TotalBP`, result.matches, `stored ${result.stored}, rule ${result.expected}`)

      const minerals = provenance.valueOrNull(result.refit.minerals)
      const stored = taskMinerals(task)
      const differences = minerals ? MINERALS.filter((name) => stored[name] !== null && !near(minerals[name], stored[name])) : ['unavailable']

      note(result.refit.minerals)
      check(`${tag}: minerals`, differences.length === 0, differences.length ? differences.map((name) => `${name} stored ${stored[name]}, rule ${minerals ? minerals[name] : 'n/a'}`).join('; ') : '')
    }

    for (const task of retools) {
      const result = refits.checkRetoolTask(task, classesById, components, operations, version)
      const tag = `${label}: retool of yard ${task.ID} (${result.source ? result.source.name : task.SourceClassID} to ${result.target ? result.target.name : task.TargetClassID}, ${task.Slipways} slipways)`

      if (result.matches === null) {
        console.log(`INFO  ${tag}: not comparable (a class or a figure is missing)`)
        continue
      }

      result.priced && note(result.priced.cost)
      check(`${tag}: RequiredBP`, result.matches, `stored ${result.stored}, rule ${result.expected}, ${provenance.valueOrNull(result.refit.total) >= result.target.cost ? 'priced by the target\'s cost (the refit is not below it)' : 'priced by the refit'}`)
    }

    const [construction] = await database.query('select FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.ClassID from FCT_ShipyardTask where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID and FCT_ShipyardTask.TaskTypeID = 0', { replacements: scope }).catch(() => [[]])
    const yardsById = Object.fromEntries(yards.map((yard) => [yard.id, yard]))
    const outcome = { fits: 0, window: 0, nonTooled: 0, bad: [] }

    construction.forEach((task) => {
      const yard = yardsById[task.ShipyardID]
      const target = classesById[task.ClassID]

      if (!yard || !target) {
        return
      }

      const accepted = refits.yardAccepts(yard, target)

      if (accepted.status === 'blocked') {
        outcome.bad.push(`yard ${yard.id} class ${target.name}: ${accepted.reasons.join(', ')}`)
      } else if (accepted.status === 'ok') {
        outcome.fits++
      }
    })

    if (construction.length) {
      note({ rule: 'refit.yardAccepts' })
      console.log(`INFO  ${label}: ${outcome.fits} of ${construction.length} stored construction tasks are in a yard the capacity and type rule accepts${outcome.bad.length ? `; the others are listed, not failed: ${[...new Set(outcome.bad)].slice(0, 3).join('; ')}` : ''}`)
    } else {
      console.log(`INFO  ${label}: no stored construction task to test the yard rule with`)
    }

    const tooled = yards.filter((yard) => yard.tooledId)
    const offending = []

    construction.forEach((task) => {
      const yard = yardsById[task.ShipyardID]
      const source = yard && yard.tooledId ? classesById[yard.tooledId] : null
      const target = classesById[task.ClassID]

      if (!source || !target || source.id === target.id) {
        return
      }

      const refit = refits.refitCost(source, target, components, version)
      const test = refits.noRetoolCheck(source, target, refit.total, version)

      if (test.ok === false) {
        offending.push(`yard ${yard.id}: ${source.name} tooled, task for ${target.name}`)
      }
    })

    if (tooled.length && construction.length) {
      console.log(`INFO  ${label}: ${offending.length} stored construction tasks at tooled yards are for a class outside the no-retool test${offending.length ? `: ${[...new Set(offending)].slice(0, 3).join('; ')}` : ''}`)
    }
  } finally {
    database.close()
  }
}

const main = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const utilities = await loadUtilities(['refits', 'provenance', 'transport'])

  worked(utilities.refits, utilities.provenance)
  await loaderChecks(utilities.refits)

  for (const [index, save] of saves.entries()) {
    await runSave(utilities, save, `save ${index + 1}`)
  }

  const registered = ['refit.cost', 'refit.minerals', 'refit.share', 'refit.noRetool', 'refit.retool', 'refit.yardAccepts', 'refit.time']

  check('every refit rule is registered and was exercised', registered.every((id) => utilities.provenance.getRule(id) && covered.has(id)), `rules covered: ${[...covered].sort().join(', ')}`)
  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
