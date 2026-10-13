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
  const { classChanges, refitCost, refitTotal, costShare, noRetoolCheck, retoolCost, retoolTime, yardEligibility, refitRate, refitTime, inBand } = refits
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

  const naval = { type: 1, capacity: 600, slipways: 2, tasks: 0 }
  const commercial = { type: 2, capacity: 600, slipways: 2, tasks: 0 }
  const contextOf = (...shipClasses) => ({ classesById: Object.fromEntries([A, B, ...shipClasses].map((shipClass) => [shipClass.id, shipClass])), components, version: '2.7.1', cache: new Map() })
  const stateOf = (yard, target, operation = 'build', source = null, context = contextOf(target, ...(source ? [source] : []))) => yardEligibility(yard, target, operation, context, source).state
  const merchant = make('Merchant', 12, 1, {}, { commercial: true })
  const tooledB = { ...naval, tooledId: 'B' }

  check('worked: a yard tooled for a class takes it, with the yard\'s own tooling as the reason', stateOf(tooledB, B) === 'capable' && yardEligibility(tooledB, B, 'build', contextOf()).tooling.kind === 'tooled' && yardEligibility(tooledB, B, 'build', contextOf()).result.value === 'capable' && isAvailable(yardEligibility(tooledB, B, 'build', contextOf()).result))
  check('worked: a naval yard of 600 t does not take a class of 12.1, naming the capacity, and a class over the capacity is not offered even when tooled for another', stateOf(tooledB, make('Big', 12.1, 1, {})) === 'ineligible' && yardEligibility(tooledB, make('Big', 12.1, 1, {}), 'build', contextOf()).blockers[0].includes('capacity'))
  check('worked: a commercial yard takes a commercial class only, and its unassigned tooling makes a commercial class a free retool', stateOf({ ...commercial, tooledId: 'Merchant' }, B) === 'ineligible' && stateOf({ ...commercial, tooledId: null }, merchant) === 'retool' && yardEligibility({ ...commercial, tooledId: null }, merchant, 'build', contextOf(merchant)).tooling.kind === 'unassigned' && stateOf({ ...commercial, tooledId: 'Merchant' }, merchant, 'build', null, contextOf(merchant)) === 'capable')
  check('worked: a repair yard is ineligible to build or refit, unsupported yard types and a null type are told apart', stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, B) === 'ineligible' && stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, B, 'refit', A) === 'ineligible' && stateOf({ type: 4, capacity: 600, slipways: 1, tasks: 0, tooledId: 'B' }, B) === 'unsupported' && stateOf({ ...tooledB, type: null }, B) === 'unknown' && yardEligibility({ ...tooledB, type: null }, B, 'build', contextOf()).missing.some((name) => name.includes('type')))
  check('worked: an unsupported yard type has no result and names the type, never a guessed rule', !isAvailable(yardEligibility({ ...tooledB, type: 4 }, B, 'build', contextOf()).result) && yardEligibility({ ...tooledB, type: 4 }, B, 'build', contextOf()).result.inputs.missing.some((name) => name.includes('type 4')) && stateOf({ ...tooledB, type: 4, capacity: 5000 }, A) === 'unsupported')
  check('worked: a type that is not known does not hide a known blocker (a capacity too small is ineligible)', stateOf({ ...tooledB, type: null }, make('Big', 12.1, 1, {})) === 'ineligible')
  check('worked: a repair yard repairs a class within its capacity, a commercial one only a commercial class, and it needs no tooling', stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, B, 'repair') === 'capable' && stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, make('Big', 12.1, 1, {}), 'repair') === 'ineligible' && stateOf({ ...commercial, tooledId: null }, B, 'repair') === 'ineligible' && stateOf({ ...commercial, tooledId: null }, merchant, 'repair') === 'capable' && stateOf({ ...tooledB, tooledId: 'A' }, make('Old', 5, 1, {}, { obsolete: true, prototype: true }), 'repair') === 'capable')
  check('worked: the class a yard is tooled for is offered whatever its other flags, with a note, but never with prototype components', stateOf({ ...naval, tooledId: 'Old' }, make('Old', 5, 1, {}, { obsolete: true, shippingLine: true, otherRace: true }), 'build', null, contextOf(make('Old', 5, 1, {}))) === 'capable' && yardEligibility({ ...naval, tooledId: 'Old' }, make('Old', 5, 1, {}, { obsolete: true }), 'build', contextOf()).notes.length === 1 && yardEligibility({ ...naval, tooledId: 'Old' }, make('Old', 5, 1, {}, { obsolete: true }), 'build', contextOf()).notes[0].includes('obsolete'))

  const tooledA = { ...naval, capacity: 1000, tooledId: 'A' }
  const compatible = yardEligibility(tooledA, cheap, 'build', contextOf(cheap))
  const needsRetool = yardEligibility(tooledA, B, 'build', contextOf())
  const farSize = make('W', 12.5, 500, { 1: 2, 2: 1 })
  const unassigned = yardEligibility({ ...naval, tooledId: null }, B, 'build', contextOf())

  check('worked: a yard tooled for A takes a class of 11 whose refit costs 13 against a limit of 20 without a retool', compatible.state === 'capable' && compatible.tooling.kind === 'compatible' && compatible.tooling.check.ok === true && near(valueOrNull(compatible.tooling.refit), 13))
  check('worked: a class whose refit costs 42 against that limit of 20 needs a retool, and the reason says so', needsRetool.state === 'retool' && needsRetool.tooling.kind === 'retool' && needsRetool.tooling.tooled === A && needsRetool.reasons.some((reason) => reason.includes('fifth')) && near(valueOrNull(needsRetool.tooling.refit), 42))
  check('worked: a class beyond 120% of the tooled size needs a retool however cheap the refit is', stateOf(tooledA, farSize, 'build', null, contextOf(farSize)) === 'retool' && yardEligibility(tooledA, farSize, 'build', contextOf(farSize)).reasons.some((reason) => reason.includes('80% to 120%')))
  check('worked: a yard with no tooled class takes any class it may be tooled for after a free retool', unassigned.state === 'retool' && unassigned.tooling.kind === 'unassigned' && unassigned.tooling.tooled === null && stateOf({ ...naval, tooledId: null }, make('Big', 12.1, 1, {})) === 'ineligible')
  check('worked: a yard whose tooled class the save does not give, or does not hold, is unknown for a class it is not tooled for, naming it', stateOf({ ...naval, tooledId: undefined }, A) === 'unknown' && stateOf({ ...naval, tooledId: 'Gone' }, A) === 'unknown' && yardEligibility({ ...naval, tooledId: 'Gone' }, A, 'build', contextOf()).missing.some((name) => name.includes('tooled')))
  check('worked: a tooled class whose cost is unknown leaves a candidate unknown, a retool filter that fails decides it', stateOf({ ...naval, capacity: 1000, tooledId: 'Z' }, cheap, 'build', null, contextOf(make('Z', 10, null, { 1: 2, 2: 1 }), cheap)) === 'unknown' && stateOf({ ...naval, capacity: 1000, tooledId: 'Z' }, farSize, 'build', null, contextOf(make('Z', 10, null, { 1: 2, 2: 1 }), farSize)) === 'retool')
  check('worked: a class that is obsolete, a shipping line\'s or has prototype components cannot be taken or retooled for, and another race\'s class needs a retool', stateOf(tooledA, make('Old', 11, 1, {}, { obsolete: true })) === 'ineligible' && stateOf(tooledA, make('Line', 11, 1, {}, { shippingLine: true })) === 'ineligible' && stateOf(tooledA, make('Proto', 11, 1, {}, { prototype: true })) === 'ineligible' && stateOf(tooledA, make('Other', 11, 1, { 1: 2, 2: 1 }, { otherRace: true })) === 'retool')

  const busy = yardEligibility({ ...tooledB, tasks: 2 }, B, 'build', contextOf())
  const noTasks = yardEligibility({ ...tooledB, tasks: null }, B, 'build', contextOf())

  check('worked: a yard whose slipways all hold tasks is busy, with a free slipway it is capable, and the free count is slipways less tasks', busy.state === 'busy' && busy.slipways.free === 0 && stateOf({ ...tooledB, tasks: 1 }, B) === 'capable' && yardEligibility({ ...tooledB, tasks: 1 }, B, 'build', contextOf()).slipways.free === 1)
  check('worked: a task count or slipway count the save lacks leaves a capable yard unknown, naming it, not busy and not capable', noTasks.state === 'unknown' && noTasks.missing.some((name) => name.includes('tasks')) && stateOf({ ...tooledB, slipways: null }, B) === 'unknown' && yardEligibility({ ...tooledB, slipways: null }, B, 'build', contextOf()).missing.some((name) => name.includes('slipways')))
  check('worked: a retool verdict stands with every slipway working, with a note', yardEligibility({ ...tooledA, tasks: 2 }, B, 'build', contextOf()).state === 'retool' && yardEligibility({ ...tooledA, tasks: 2 }, B, 'build', contextOf()).notes.some((text) => text.includes('working')))
  check('worked: a retool in progress is a note naming its class and does not change the state', yardEligibility({ ...tooledB, taskType: 7, retoolId: 'A' }, B, 'build', contextOf()).state === 'capable' && yardEligibility({ ...tooledB, taskType: 7, retoolId: 'A' }, B, 'build', contextOf()).notes.some((text) => text.includes('retooled for A')))

  const refitContext = contextOf(cheap)
  const sameCost = make('Same', 10, 100, { 1: 2, 2: 1 })
  const wide = make('Wide', 20, 100, { 1: 2, 2: 1 })
  const refitFrom = (yard, source, target, context = contextOf(source, target)) => yardEligibility(yard, target, 'refit', context, source)

  check('worked: a refit from A to a class of 11 at a yard tooled for A is capable, and the refit time is the page\'s business', refitFrom(tooledA, A, cheap, refitContext).state === 'capable')
  check('worked: a refit from a class outside the window of the class the yard is tooled for is ineligible, naming the window', refitFrom(tooledA, wide, cheap).state === 'ineligible' && refitFrom({ ...tooledA, capacity: 5000 }, wide, cheap).reasons.some((reason) => reason.includes('80% to 120%')))
  check('worked: a refit from a class over the yard\'s capacity, or at a commercial yard from a military class, is ineligible', refitFrom({ ...tooledA, capacity: 450 }, A, cheap).state === 'ineligible' && refitFrom({ ...commercial, tooledId: 'Merchant' }, A, merchant, contextOf(A, merchant)).state === 'ineligible')
  check('worked: a refit to the same class, or one that costs nothing, is ineligible', refitFrom(tooledA, A, A).state === 'ineligible' && refitFrom({ ...tooledA, tooledId: 'Same' }, A, sameCost, contextOf(A, sameCost)).blockers.some((reason) => reason.includes('costs nothing')))
  check('worked: a retool-first refit measures the source against the target\'s window, because the yard is retooled to the target first', refitFrom(tooledA, A, B).state === 'retool' && refitFrom(tooledA, wide, B).state === 'ineligible' && refitFrom({ ...tooledA, tooledId: 'B' }, A, B).state === 'capable')
  check('worked: the source decides a refit the target alone would allow: a yard that needs a retool for the target refuses a source of a shipping line, one over its capacity or outside the target\'s window, so a verdict without the source is not the refit\'s', yardEligibility(tooledA, cheap, 'refit', contextOf(cheap)).state === 'capable' && yardEligibility(tooledA, B, 'refit', contextOf()).state === 'retool' && refitFrom(tooledA, make('Line', 12, 100, { 1: 2 }, { shippingLine: true }), B).state === 'ineligible' && refitFrom({ ...tooledA, capacity: 600 }, make('Over', 12.1, 100, { 1: 2 }), B).blockers.some((reason) => reason.includes('source class') && reason.includes('capacity')) && refitFrom(tooledA, wide, B).state === 'ineligible')
  const merchantRefit = make('Merchant', 12, 1, { 1: 3 }, { commercial: true })

  check('worked: the class window\'s commercial mark is not copied: a refit across commercial flags at a naval yard tooled for the target is capable, with a note', refitFrom({ ...naval, tooledId: 'Merchant' }, A, merchantRefit, contextOf(A, merchantRefit)).state === 'capable' && refitFrom({ ...naval, tooledId: 'Merchant' }, A, merchantRefit, contextOf(A, merchantRefit)).notes.some((text) => text.includes('commercial')))
  check('worked: a refit whose source is a unknown size, or whose cost cannot be told, is unknown, and the flag of a shipping line source blocks', refitFrom(tooledA, make('S', null, 100, { 1: 2 }), cheap).state === 'unknown' && refitFrom(tooledA, make('Line', 10, 100, { 1: 2 }, { shippingLine: true }), cheap).state === 'ineligible' && refitFrom(tooledA, make('N', 10, 100, { 1: null }), cheap).state === 'unknown')

  const cached = contextOf(cheap)

  yardEligibility(tooledA, cheap, 'build', cached)
  yardEligibility(tooledA, cheap, 'build', cached)
  check('worked: the refits between classes are kept in the cache the caller gives', cached.cache.size === 1 && cached.cache.has('A>C'))

  const lightNaval = { type: 1, capacity: 1000, slipways: 1, tasks: 0, tooledId: 'A' }
  const nineHundred = make('Nine', 18, 500, { 1: 4 })

  check('worked: a 2.7 naval yard of 1000 t still needs tooling for a hull of 900 t: no unreleased Light Naval rule is inherited', stateOf(lightNaval, nineHundred, 'build', null, contextOf(nineHundred)) === 'retool' && stateOf({ ...lightNaval, type: 4 }, nineHundred, 'build', null, contextOf(nineHundred)) === 'unsupported')
  check('worked: a game version the rule does not cover is unknown, naming the version, never decided; a save with no version label is decided as an estimate with the standing caveat', stateOf(tooledB, B, 'build', null, { ...contextOf(), version: '3.0.0' }) === 'unknown' && yardEligibility(tooledB, B, 'build', { ...contextOf(), version: '3.0.0' }).missing.some((name) => name.includes('3.0.0')) && yardEligibility(tooledB, B, 'build', { ...contextOf(), version: null }).result.assumptions.length > 0 && yardEligibility(tooledB, B, 'build', contextOf()).result.status === STATUS.ESTIMATED)
  check('worked: an operation the rule does not know is an error', (() => { try { yardEligibility(tooledB, B, 'scrap', contextOf()) } catch (error) { return error instanceof Error } return false })())
  note({ rule: 'refit.yardEligibility' })
  note(compatible.result)
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

  const unknownLine = yardEligibility({ ...naval, tooledId: 'B', tasks: 0 }, make('Line', 5, 1, {}, { shippingLine: null }), 'build', contextOf(B))
  const unknownOther = yardEligibility({ ...naval, tooledId: 'B', tasks: 0 }, make('Other', 11, 1, {}, { otherRace: null }), 'build', contextOf(B))
  check('worked: a class whose shipping-line or other-race flag is not known is unknown for a yard, naming the flag, never taken', unknownLine.state === 'unknown' && unknownLine.missing.some((name) => name.includes('shipping')) && unknownOther.state === 'unknown' && unknownOther.missing.some((name) => name.includes('race')) && !isAvailable(unknownLine.result))
  check('worked: a known blocker still decides it with a flag unknown', yardEligibility(naval, make('Big', 12.1, 1, {}, { shippingLine: null }), 'build', contextOf(B)).state === 'ineligible' && yardEligibility(naval, make('Big', 12.1, 1, {}, { shippingLine: null }), 'build', contextOf(B)).blockers.length === 1)
  check('worked: a class with an unknown prototype flag leaves a tooled class unknown, a known prototype blocks it even at the yard tooled for it', yardEligibility({ ...naval, tooledId: 'Maybe' }, make('Maybe', 5, 1, {}, { prototype: null }), 'build', contextOf(make('Maybe', 5, 1, {}, { prototype: null }))).state === 'unknown' && yardEligibility({ ...naval, tooledId: 'Proto' }, make('Proto', 5, 1, {}, { prototype: true }), 'build', contextOf(make('Proto', 5, 1, {}))).state === 'ineligible')
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
  const { refits, provenance, capabilities } = utilities
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
    const version = await capabilities.loadFormulaVersion(database).catch(() => null)
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
    const [taskCounts] = await database.query('select FCT_ShipyardTask.ShipyardID, count(*) as Tasks from FCT_ShipyardTask group by FCT_ShipyardTask.ShipyardID').catch(() => [[]])
    const tasksOf = Object.fromEntries(taskCounts.map((row) => [row.ShipyardID, row.Tasks]))
    const wrongTasks = yards.filter((yard) => yard.tasks !== (tasksOf[yard.id] || 0))

    check(`${label}: every yard carries the count of its stored tasks (0 for none)`, wrongTasks.length === 0, wrongTasks.slice(0, 3).map((yard) => `yard ${yard.id}: ${yard.tasks} against ${tasksOf[yard.id] || 0}`).join('; '))

    const context = { classesById, components, version, cache: new Map() }
    const tally = Object.fromEntries(['build', 'repair'].map((operation) => [operation, Object.fromEntries(refits.YARD_STATES.map((state) => [state, 0]))]))
    const odd = []

    yards.forEach((yard) => {
      classes.forEach((shipClass) => {
        ['build', 'repair'].forEach((operation) => {
          const result = refits.yardEligibility(yard, shipClass, operation, context)
          const undecided = result.state === 'unknown' || result.state === 'unsupported'

          tally[operation][result.state] = (tally[operation][result.state] || 0) + 1
          note(result.result)

          if (!refits.YARD_STATES.includes(result.state) || undecided === provenance.isAvailable(result.result) || (!result.reasons.length && result.state !== 'capable' && result.state !== 'busy')) {
            odd.push(`yard ${yard.id} class ${shipClass.name} ${operation}: ${result.state}`)
          }
        })
      })
    })

    check(`${label}: every yard and class pair has one known state, with a result that is unavailable exactly when it is unknown or unsupported, and a reason for any state other than capable or busy`, odd.length === 0, odd.slice(0, 3).join('; '))
    ;['build', 'repair'].forEach((operation) => console.log(`INFO  ${label}: ${operation} over ${yards.length} yards and ${classes.length} classes: ${refits.YARD_STATES.map((state) => `${state} ${tally[operation][state]}`).join(', ')}`))

    const misfit = []
    const states = {}

    construction.forEach((task) => {
      const yard = yardsById[task.ShipyardID]
      const target = classesById[task.ClassID]

      if (!yard || !target) {
        return
      }

      const result = refits.yardEligibility(yard, target, 'build', context)

      states[result.state] = (states[result.state] || 0) + 1

      if (yard.tooledId === target.id && target.prototype !== true && ['ineligible', 'retool', 'unsupported'].includes(result.state)) {
        misfit.push(`yard ${yard.id} class ${target.name}: ${result.state} (${result.reasons.join(', ')})`)
      }
    })

    if (construction.length) {
      check(`${label}: a stored construction task at a yard tooled for its class is never ineligible, retool or unsupported`, misfit.length === 0, misfit.slice(0, 3).join('; '))
      console.log(`INFO  ${label}: ${construction.length} stored construction tasks by the yard's state for their class: ${Object.entries(states).map(([state, count]) => `${state} ${count}`).join(', ') || 'none resolved'}`)
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
  const utilities = await loadUtilities(['refits', 'provenance', 'capabilities'])

  worked(utilities.refits, utilities.provenance)
  await loaderChecks(utilities.refits)

  for (const [index, save] of saves.entries()) {
    await runSave(utilities, save, `save ${index + 1}`)
  }

  const registered = ['refit.cost', 'refit.minerals', 'refit.share', 'refit.noRetool', 'refit.retool', 'refit.yardEligibility', 'refit.time']

  check('every refit rule is registered and was exercised', registered.every((id) => utilities.provenance.getRule(id) && covered.has(id)), `rules covered: ${[...covered].sort().join(', ')}`)
  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
