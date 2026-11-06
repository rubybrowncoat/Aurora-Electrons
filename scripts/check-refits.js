/*
  Checks the directional refit and retool arithmetic (src/renderer/utilities/refits.js) against worked examples and against the refit tasks and retool activities saves hold, read-only.

  node scripts/check-refits.js [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the fixture of scripts/lib/fixtures.js (the migrated Galactic Shogunate save, game 141, race 784) and the other saves that are known to hold a refit task or a retool activity (saves/AuroraDB_270_Falryx_date_issue.db, game 141, race 791; AuroraDB_TerranFederation.db, whose game and race are read from the save); a save that is not there is reported as not run.

  It proves: the worked examples (an added component, a removal that earns no credit, a size change, A to B against B to A, the one-decimal rounding of a refit's minerals, the retool cost with and without a tooled class, the no-retool test, a yard's eligibility including a Light yard's, which lists every class of the race within its capacity with no tooling and no retool, a refit's source class in the size band of the yard's tooled class and a Light yard asking no band, an unknown figure staying unknown); and, on every save, that each stored refit task's TotalBP and minerals and each stored retool activity's RequiredBP are what the rules give for its two classes, that a stored construction task sits in a yard that takes its class, that the retool and refit rules agree on the yards' own tooling, that every task row carries the stored count of ships it makes, and that each Light yard in the save gives a class of 900 t and of 1,100 t the verdicts its 1,000 t capacity decides. A save with no refit task or retool activity is reported as having nothing to compare: the fixture holds none. Any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { mutating } = require('./lib/no-mutations')
const { plantedPatch } = require('./lib/mutant-source')
const { fixtureSave } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const MINERALS = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const DEFAULT_SAVES = [fixtureSave(), { file: 'saves/AuroraDB_270_Falryx_date_issue.db', game: 141, race: 791 }, { file: 'AuroraDB_TerranFederation.db', game: null, race: null }]
const TOLERANCE = 1e-6

let failures = 0
let checks = 0

// A run of the worked statements under a planted fault records them here instead of printing them, so the fault can be credited only to the statement named for it.
let sink = null

const check = (name, ok, detail = '') => {
  if (sink) {
    sink.push({ name, ok })
    return
  }

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
  const { classChanges, refitCost, refitTotal, costShare, noRetoolCheck, listedNoRetool, retoolCost, retoolTime, yardEligibility, refitRate, refitTime, inBand, sourceWithinBand } = refits
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

  const noRetool = noRetoolCheck(A, B, '2.7.1')
  const cheap = make('C', 11, 500, { 1: 2, 2: 1, 3: 0.5 })
  const cheapRefit = refitCost(A, cheap, components, '2.7.1')
  const W = make('W', 12.5, 500, { 1: 2, 2: 1 })
  note(noRetool.result)
  check('worked: only the class a yard is tooled for needs no retool: a yard tooled for A takes A and needs a retool for B, whatever the refit\'s cost', noRetoolCheck(A, A, '2.7.1').ok === true && noRetool.ok === false)
  check('worked: a class within 80% to 120% of the tooled class\'s size (11 against 10, a refit of 13, under a fifth of the cost) is not admitted, and neither is one at 12.5: the window and the cost share are no test the game makes', near(valueOrNull(cheapRefit.total), 13) && noRetoolCheck(A, cheap, '2.7.1').ok === false && noRetoolCheck(A, W, '2.7.1').ok === false)
  check('worked: the no-retool check\'s size window and cost share are null, never a figure the game does not test', [noRetool, noRetoolCheck(A, cheap, '2.7.1')].every((test) => test.withinSize === null && test.affordable === null && test.limit === null))
  check('worked: a class with no id leaves the no-retool test unknown (null, not a pass)', noRetoolCheck({ ...A, id: null }, B, '2.7.1').ok === null && !isAvailable(noRetoolCheck({ ...A, id: null }, B, '2.7.1').result))

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
  check('worked: a repair yard is ineligible to build or refit, unsupported yard types and a null type are told apart', stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, B) === 'ineligible' && stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, B, 'refit', A) === 'ineligible' && stateOf({ type: 5, capacity: 600, slipways: 1, tasks: 0, tooledId: 'B' }, B) === 'unsupported' && stateOf({ ...tooledB, type: null }, B) === 'unknown' && yardEligibility({ ...tooledB, type: null }, B, 'build', contextOf()).missing.some((name) => name.includes('type')))
  check('worked: an unsupported yard type has no result and names the type, never a guessed rule', !isAvailable(yardEligibility({ ...tooledB, type: 5 }, B, 'build', contextOf()).result) && yardEligibility({ ...tooledB, type: 5 }, B, 'build', contextOf()).result.inputs.missing.some((name) => name.includes('type 5')) && stateOf({ ...tooledB, type: 5, capacity: 5000 }, A) === 'unsupported')
  check('worked: a type that is not known does not hide a known blocker (a capacity too small is ineligible)', stateOf({ ...tooledB, type: null }, make('Big', 12.1, 1, {})) === 'ineligible')
  check('worked: a repair yard repairs a class within its capacity, a commercial one only a commercial class, and it needs no tooling', stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, B, 'repair') === 'capable' && stateOf({ type: 3, capacity: 600, slipways: 1, tasks: 0, tooledId: null }, make('Big', 12.1, 1, {}), 'repair') === 'ineligible' && stateOf({ ...commercial, tooledId: null }, B, 'repair') === 'ineligible' && stateOf({ ...commercial, tooledId: null }, merchant, 'repair') === 'capable' && stateOf({ ...tooledB, tooledId: 'A' }, make('Old', 5, 1, {}, { obsolete: true, prototype: true }), 'repair') === 'capable')
  check('worked: the class a yard is tooled for is offered whatever its other flags, with a note, but never with prototype components', stateOf({ ...naval, tooledId: 'Old' }, make('Old', 5, 1, {}, { obsolete: true, shippingLine: true, otherRace: true }), 'build', null, contextOf(make('Old', 5, 1, {}))) === 'capable' && yardEligibility({ ...naval, tooledId: 'Old' }, make('Old', 5, 1, {}, { obsolete: true }), 'build', contextOf()).notes.length === 1 && yardEligibility({ ...naval, tooledId: 'Old' }, make('Old', 5, 1, {}, { obsolete: true }), 'build', contextOf()).notes[0].includes('obsolete'))

  const tooledA = { ...naval, capacity: 1000, tooledId: 'A' }
  const nearBy = yardEligibility(tooledA, cheap, 'build', contextOf(cheap))
  const needsRetool = yardEligibility(tooledA, B, 'build', contextOf())
  const farSize = W
  const unassigned = yardEligibility({ ...naval, tooledId: null }, B, 'build', contextOf())

  check('worked: a yard tooled for A needs a retool for a class of 11 within the old window and for one of 12.5 outside it alike: the yard offers the class it is tooled for alone', nearBy.state === 'retool' && nearBy.tooling.kind === 'retool' && nearBy.tooling.tooled === A && nearBy.tooling.check.ok === false && near(valueOrNull(nearBy.tooling.refit), 13) && stateOf(tooledA, farSize, 'build', null, contextOf(farSize)) === 'retool' && yardEligibility(tooledA, farSize, 'build', contextOf(farSize)).reasons.some((reason) => reason.includes('only the class it is tooled for')))
  check('worked: the class the yard is tooled for itself is taken, where a class whose refit costs 42 needs a retool', stateOf(tooledA, A, 'build', null, contextOf()) === 'capable' && needsRetool.state === 'retool' && needsRetool.tooling.tooled === A && near(valueOrNull(needsRetool.tooling.refit), 42))
  check('worked: a yard with no tooled class takes any class it may be tooled for after a free retool', unassigned.state === 'retool' && unassigned.tooling.kind === 'unassigned' && unassigned.tooling.tooled === null && stateOf({ ...naval, tooledId: null }, make('Big', 12.1, 1, {})) === 'ineligible')
  check('worked: a yard whose tooled class the save does not give, or does not hold, is unknown for a class it is not tooled for, naming it', stateOf({ ...naval, tooledId: undefined }, A) === 'unknown' && stateOf({ ...naval, tooledId: 'Gone' }, A) === 'unknown' && yardEligibility({ ...naval, tooledId: 'Gone' }, A, 'build', contextOf()).missing.some((name) => name.includes('tooled')))
  check('worked: a tooled class whose cost the save does not give still needs a retool for another class: the no-retool test no longer reads a cost', stateOf({ ...naval, capacity: 1000, tooledId: 'Z' }, cheap, 'build', null, contextOf(make('Z', 10, null, { 1: 2, 2: 1 }), cheap)) === 'retool' && stateOf({ ...naval, capacity: 1000, tooledId: 'Z' }, farSize, 'build', null, contextOf(make('Z', 10, null, { 1: 2, 2: 1 }), farSize)) === 'retool')
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
  const twelve = make('Twelve', 12, 100, { 1: 2, 2: 1 })
  const eighteen = make('Eighteen', 18, 100, { 1: 2 })
  const far = make('Far', 20, 100, { 1: 3 })
  const refitFrom = (yard, source, target, context = contextOf(source, target)) => yardEligibility(yard, target, 'refit', context, source)
  const bandYard = { ...naval, capacity: 6000, tooledId: 'Hundred' }
  const hundred = make('Hundred', 100, 5000, { 1: 4 })
  const fifty = make('Fifty', 50, 1000, { 1: 2 })
  const ninety = make('Ninety', 90, 4000, { 1: 2 })
  const bandAt = (tooledSize, sourceSize) => sourceWithinBand(make('T', tooledSize, 1, {}), make('S', sourceSize, 1, {}))

  check('worked: a refit from A to a class of 11 at a yard tooled for A needs a retool, the target not being the class the yard is tooled for, and the refit time is the page\'s business', refitFrom(tooledA, A, cheap, refitContext).state === 'retool')
  check('worked: a refit\'s source class is measured by the yard\'s capacity and, at a yard with a tooled class, by the size band of that class: a source of 12 hull spaces to a target of 11 at a yard tooled for A of 10 needs the retool for the target, a source of 20 is refused for the band, and a source over the capacity is refused for it', refitFrom({ ...tooledA, capacity: 5000 }, twelve, cheap).state === 'retool' && refitFrom({ ...tooledA, capacity: 5000 }, wide, cheap).state === 'ineligible' && refitFrom({ ...tooledA, capacity: 5000 }, wide, cheap).blockers.some((reason) => reason.includes('source class') && reason.includes('size band')) && refitFrom({ ...tooledA, capacity: 550 }, twelve, cheap).state === 'ineligible' && refitFrom({ ...tooledA, capacity: 550 }, twelve, cheap).blockers.some((reason) => reason.includes('source class') && reason.includes('capacity')))
  check('worked: a naval yard tooled for a 100 hull space class refuses a 50 hull space source for the tooled class\'s size band, naming both sizes', refitFrom(bandYard, fifty, hundred, contextOf(hundred, fifty)).state === 'ineligible' && refitFrom(bandYard, fifty, hundred, contextOf(hundred, fifty)).blockers.some((reason) => reason.includes('size band') && reason.includes('2500 t') && reason.includes('5000 t')))
  check('worked: the same yard takes a 90 hull space source, within the band, naming the band as what admits it', refitFrom(bandYard, ninety, hundred, contextOf(hundred, ninety)).state === 'capable' && refitFrom(bandYard, ninety, hundred, contextOf(hundred, ninety)).reasons.some((reason) => reason.includes('within the size band')))
  check('worked: the band\'s ends are the game\'s own, both included: a 12 hull space tooled class takes a source of 10 and refuses 9.99, a 10 hull space tooled class takes a source of 12.5 and refuses 12.51, and a size the save lacks leaves the band unknown', bandAt(12, 10) === true && bandAt(12, 9.99) === false && bandAt(10, 12.5) === true && bandAt(10, 12.51) === false && bandAt(null, 10) === null && bandAt(10, null) === null)
  check('worked: the refit source band follows the class tooled at the time of the refit: a 12 hull space source inside the band of the yard\'s current 10 hull space class is outside the band of the 20 hull space target it would be retooled for, so it is refused after the retool, naming both sizes', refitFrom(tooledA, twelve, far).state === 'ineligible' && sourceWithinBand(A, twelve) === true && sourceWithinBand(far, twelve) === false && refitFrom(tooledA, twelve, far).blockers.some((reason) => reason.includes('size band') && reason.includes('600 t') && reason.includes('1000 t') && reason.includes('after the retool')))
  check('worked: the reverse holds: an 18 hull space source outside the current 10 hull space class\'s band is inside the 20 hull space target\'s, so the yard is refused now and takes it after the retool, naming the band as what admits it', sourceWithinBand(A, eighteen) === false && sourceWithinBand(far, eighteen) === true && refitFrom(tooledA, eighteen, far).state === 'retool' && refitFrom(tooledA, eighteen, far).reasons.some((reason) => reason.includes('within the size band') && reason.includes('after the retool')))
  check('worked: a source inside both bands needs the retool alone: an 11 hull space source to a 12 hull space target at a yard tooled for a 10 hull space class is inside each class\'s band', sourceWithinBand(A, cheap) === true && sourceWithinBand(B, cheap) === true && refitFrom(tooledA, cheap, B).state === 'retool')
  check('worked: a yard with no tooled class is judged by the band of the class it is given: it refuses the 50 hull space source for a 100 hull space class and takes a 90 hull space one after the free retool', refitFrom({ ...naval, capacity: 6000, tooledId: null }, fifty, hundred, contextOf(hundred, fifty)).state === 'ineligible' && refitFrom({ ...naval, capacity: 6000, tooledId: null }, fifty, hundred, contextOf(hundred, fifty)).blockers.some((reason) => reason.includes('size band') && reason.includes('2500 t') && reason.includes('5000 t')) && refitFrom({ ...naval, capacity: 6000, tooledId: null }, ninety, hundred, contextOf(hundred, ninety)).state === 'retool' && refitFrom({ ...naval, capacity: 6000, tooledId: null }, ninety, hundred, contextOf(hundred, ninety)).tooling.kind === 'unassigned')
  check('worked: a refit from a class over the yard\'s capacity, or at a commercial yard from a military class, is ineligible', refitFrom({ ...tooledA, capacity: 450 }, A, cheap).state === 'ineligible' && refitFrom({ ...commercial, tooledId: 'Merchant' }, A, merchant, contextOf(A, merchant)).state === 'ineligible')
  check('worked: a refit to the same class, or one that costs nothing, is ineligible', refitFrom(tooledA, A, A).state === 'ineligible' && refitFrom({ ...tooledA, tooledId: 'Same' }, A, sameCost, contextOf(A, sameCost)).blockers.some((reason) => reason.includes('costs nothing')))
  check('worked: a refit to a class other than the tooled one needs a retool, and the same refit to the class the yard is tooled for is taken with a source within the band', refitFrom(tooledA, A, B).state === 'retool' && refitFrom({ ...tooledA, tooledId: 'B' }, A, B).state === 'capable' && refitFrom({ ...tooledA, tooledId: 'B' }, twelve, B).state === 'capable')
  check('worked: the source decides a refit a target alone would allow: a source of a shipping line or one over the capacity is refused, so a verdict without the source is not the refit\'s', yardEligibility(tooledA, cheap, 'refit', contextOf(cheap)).state === 'retool' && yardEligibility(tooledA, B, 'refit', contextOf()).state === 'retool' && refitFrom(tooledA, make('Line', 12, 100, { 1: 2 }, { shippingLine: true }), B).state === 'ineligible' && refitFrom({ ...tooledA, capacity: 600 }, make('Over', 12.1, 100, { 1: 2 }), B).blockers.some((reason) => reason.includes('source class') && reason.includes('capacity')) && refitFrom(tooledA, twelve, B).state === 'retool')
  const merchantRefit = make('Merchant', 12, 1, { 1: 3 }, { commercial: true })

  check('worked: a refit across the commercial flag at a naval yard tooled for the target is capable with no blocker: a commercial target is no filter at a naval yard', refitFrom({ ...naval, tooledId: 'Merchant' }, A, merchantRefit, contextOf(A, merchantRefit)).state === 'capable' && refitFrom({ ...naval, tooledId: 'Merchant' }, A, merchantRefit, contextOf(A, merchantRefit)).blockers.length === 0)
  check('worked: a refit whose source is a unknown size, or whose cost cannot be told, is unknown, and the flag of a shipping line source blocks', refitFrom(tooledA, make('S', null, 100, { 1: 2 }), cheap).state === 'unknown' && refitFrom(tooledA, make('Line', 10, 100, { 1: 2 }, { shippingLine: true }), cheap).state === 'ineligible' && refitFrom(tooledA, make('N', 10, 100, { 1: null }), cheap).state === 'unknown')

  const cached = contextOf(cheap)

  yardEligibility(tooledA, cheap, 'build', cached)
  yardEligibility(tooledA, cheap, 'build', cached)
  check('worked: the refits between classes are kept in the cache the caller gives', cached.cache.size === 1 && cached.cache.has('A>C'))

  const lightNaval = { type: 1, capacity: 1000, slipways: 1, tasks: 0, tooledId: 'A' }
  const nineHundred = make('Nine', 18, 500, { 1: 4 })

  check('worked: a 2.7 naval yard of 1000 t still needs tooling for a hull of 900 t, where a light yard of the same capacity lists it', stateOf(lightNaval, nineHundred, 'build', null, contextOf(nineHundred)) === 'retool' && stateOf({ ...lightNaval, type: 4, tooledId: null }, nineHundred, 'build', null, contextOf(nineHundred)) === 'capable')

  const light = { type: 4, capacity: 1000, slipways: 5, tasks: 0, tooledId: null }
  const elevenHundred = make('Eleven', 22, 600, { 1: 4 })
  const lightIn = (yard, target, operation = 'build', source = null, context = contextOf(target, ...(source ? [source] : []))) => yardEligibility(yard, target, operation, context, source)
  const lightNine = lightIn(light, nineHundred)
  const lightEleven = lightIn(light, elevenHundred)
  const lightFormula = { ...contextOf(nineHundred), version: '3.2.0' }
  const listed = listedNoRetool('3.2.0')

  note(lightNine.tooling.check.result)
  check('worked: a light yard of 1000 t lists a class of 900 t without tooling: capable, listed, with a no-retool verdict that holds and asks neither a size window nor a cost limit', lightNine.state === 'capable' && lightNine.tooling.kind === 'listed' && lightNine.tooling.tooled === null && lightNine.tooling.refit === null && lightNine.tooling.check.ok === true && lightNine.tooling.check.withinSize === null && lightNine.tooling.check.affordable === null && lightNine.tooling.check.limit === null && isAvailable(lightNine.tooling.check.result) && lightNine.tooling.check.result.rule.id === 'refit.noRetool' && isAvailable(lightNine.result))
  check('worked: the listed no-retool verdict is the rule\'s own, true with the standing caveat for a save the rule does not cover and without it for the 3.2 line', listed.ok === true && listed.result.assumptions.length === 0 && listedNoRetool(null).result.assumptions.length > 0 && listedNoRetool('3.0.0').result.assumptions.length > 0)
  check('worked: a class of 1100 t is over the 1000 t capacity of a light yard: ineligible, naming the capacity and that a light yard can be neither retooled nor given more capacity', lightEleven.state === 'ineligible' && lightEleven.tooling === null && lightEleven.blockers.some((reason) => reason.includes('capacity')) && lightEleven.blockers.some((reason) => reason.includes('neither retooled nor given more capacity')))
  check('worked: the capacity limit is 20 hull spaces (1000 t) with the limit itself listed: 20 is capable, 20.5 ineligible', lightIn(light, make('Edge', 20, 1, {})).state === 'capable' && lightIn(light, make('Over', 20.5, 1, {})).state === 'ineligible' && lightIn({ ...light, capacity: 1100 }, elevenHundred).state === 'capable')
  check('worked: a light yard ignores the class it is said to be tooled for: a tooled class, a class the save lacks and an unread one all list the 900 t class, where a naval yard with the class missing is unknown', ['A', 'Gone', undefined].every((tooledId) => lightIn({ ...light, tooledId }, nineHundred).state === 'capable' && lightIn({ ...light, tooledId }, nineHundred).tooling.kind === 'listed') && stateOf({ ...naval, tooledId: 'Gone' }, A) === 'unknown')
  check('worked: a light yard does not list an obsolete class, a shipping line\'s, one with prototype components or another race\'s, each ineligible for its own reason', ['obsolete', 'shippingLine', 'prototype', 'otherRace'].every((flag) => lightIn(light, make('F', 18, 1, {}, { [flag]: true })).state === 'ineligible' && lightIn(light, make('F', 18, 1, {}, { [flag]: true })).tooling === null) && lightIn(light, make('F', 18, 1, {}, { otherRace: true })).blockers.some((reason) => reason.includes('another race')) && stateOf(tooledA, make('Other', 11, 1, { 1: 2, 2: 1 }, { otherRace: true })) === 'retool')
  check('worked: a light yard\'s class flag that is not known leaves it unknown, naming the flag, and a known blocker still decides it', ['shippingLine', 'otherRace', 'obsolete'].every((flag) => lightIn(light, make('F', 18, 1, {}, { [flag]: null })).state === 'unknown') && lightIn(light, make('F', 18, 1, {}, { otherRace: null })).missing.some((name) => name.includes('race')) && lightIn(light, make('F', 22, 1, {}, { otherRace: null })).state === 'ineligible' && lightIn({ ...light, capacity: null }, nineHundred).state === 'unknown')
  check('worked: a light yard is busy when every slipway holds a task and capable with one free, and a task count the save lacks leaves it unknown', lightIn({ ...light, tasks: 5 }, nineHundred).state === 'busy' && lightIn({ ...light, tasks: 4 }, nineHundred).state === 'capable' && lightIn({ ...light, tasks: 4 }, nineHundred).slipways.free === 1 && lightIn({ ...light, tasks: null }, nineHundred).state === 'unknown')

  const tiny = make('Tiny', 5, 100, { 1: 2 })
  const huge = make('Huge', 22, 100, { 1: 2 })

  check('worked: a refit at a light yard needs no tooling and no size band: a source of 5 hull spaces for a target of 18 is capable, where the same refit at a naval yard tooled for the target is refused for the band, and a light yard of 6,000 t takes the 50 hull space source its tooled counterpart refuses', lightIn(light, nineHundred, 'refit', tiny).state === 'capable' && lightIn(light, nineHundred, 'refit', tiny).tooling.kind === 'listed' && refitFrom({ ...naval, capacity: 1000, tooledId: 'Nine' }, tiny, nineHundred, contextOf(tiny, nineHundred)).state === 'ineligible' && refitFrom({ ...naval, capacity: 1000, tooledId: 'Nine' }, tiny, nineHundred, contextOf(tiny, nineHundred)).blockers.some((reason) => reason.includes('size band')) && lightIn({ ...light, capacity: 6000 }, hundred, 'refit', fifty).state === 'capable' && lightIn({ ...light, capacity: 6000 }, hundred, 'refit', fifty).tooling.kind === 'listed' && refitFrom(bandYard, fifty, hundred, contextOf(hundred, fifty)).state === 'ineligible')
  check('worked: a refit at a light yard still needs its source within the capacity, and a target over it is refused with its own reason', lightIn(light, nineHundred, 'refit', huge).state === 'ineligible' && lightIn(light, nineHundred, 'refit', huge).blockers.some((reason) => reason.includes('source class') && reason.includes('capacity')) && lightIn(light, elevenHundred, 'refit', tiny).state === 'ineligible' && lightIn(light, nineHundred, 'refit', nineHundred).state === 'ineligible')
  check('worked: a repair at a light yard needs no tooling and a ship within its capacity, the 900 t class is repaired and the 1100 t one is not', lightIn(light, nineHundred, 'repair').state === 'capable' && lightIn(light, nineHundred, 'repair').tooling === null && lightIn(light, elevenHundred, 'repair').state === 'ineligible')
  check('worked: a light yard is decided on the 3.2 line and the 2.7 one, with no standing caveat on the 3.2 line, and unknown for a line the rule does not cover', yardEligibility(light, nineHundred, 'build', lightFormula).state === 'capable' && yardEligibility(light, nineHundred, 'build', lightFormula).result.assumptions.length === 0 && yardEligibility(light, nineHundred, 'build', { ...lightFormula, version: '3.0.0' }).state === 'unknown' && yardEligibility(light, nineHundred, 'build', { ...lightFormula, version: '2.7.1' }).state === 'capable')
  check('worked: a light yard asks no retool of a naval class its capacity fits, so the retool the naval yard needs for the 600 t class B (tooled for A, a refit that costs 42 against 20) is not asked of it', lightIn(light, B).state === 'capable' && yardEligibility(tooledA, B, 'build', contextOf()).state === 'retool')
  check('worked: a game version the rule does not cover is unknown, naming the version, never decided; a save with no version label is decided as an estimate with the standing caveat', stateOf(tooledB, B, 'build', null, { ...contextOf(), version: '3.0.0' }) === 'unknown' && yardEligibility(tooledB, B, 'build', { ...contextOf(), version: '3.0.0' }).missing.some((name) => name.includes('3.0.0')) && yardEligibility(tooledB, B, 'build', { ...contextOf(), version: null }).result.assumptions.length > 0 && yardEligibility(tooledB, B, 'build', contextOf()).result.status === STATUS.ESTIMATED)
  check('worked: an operation the rule does not know is an error', (() => { try { yardEligibility(tooledB, B, 'scrap', contextOf()) } catch (error) { return error instanceof Error } return false })())
  note({ rule: 'refit.yardEligibility' })
  note(yardEligibility(tooledA, A, 'build', contextOf()).result)
  check('worked: refitTotal agrees with refitCost without the minerals', near(valueOrNull(refitTotal(A, B, components, '2.7.1').total), valueOrNull(ab.total)) && refitTotal(A, B, components, '2.7.1').minerals === undefined)
  const rate = refitRate({ ShipyardBuildRate: 1000, ShipyardOperations: 1 }, B)
  const time = refitTime(ab.total, rate)
  check('worked: a refit\'s time is its cost over the rate (a yard that is not read gives no time)', isAvailable(time) && rate.value > 0 && near(time.value, 42 / rate.value * 365) && !isAvailable(refitTime(ab.total, refitRate(undefined, B))))
  const commercialRate = refitRate({ ShipyardBuildRate: 1000, ShipyardOperations: 1 }, merchant)

  check('worked: a refit\'s rate counts a commercial target class\'s size at a quarter, as the class\'s own flag gives it: 515 BP a year against 560 in full at 12 hull spaces', near(valueOrNull(commercialRate), 515) && near(valueOrNull(rate), 560) && valueOrNull(commercialRate) !== valueOrNull(rate))
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

    const [taskRowsStored] = await database.query('select FCT_ShipyardTask.TaskID, FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.TaskTypeID, FCT_ShipyardTask.TotalBP, FCT_ShipyardTask.CompletedBP from FCT_ShipyardTask where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID', { replacements: scope }).catch(() => [[]])
    const rowsOf = yards.flatMap((yard) => (yard.taskRows || []).map((row) => ({ yardId: yard.id, row })))
    const storedById = Object.fromEntries(taskRowsStored.map((row) => [row.TaskID, row]))
    const wrongRows = rowsOf.filter(({ yardId, row }) => { const stored = storedById[row.id]; return !stored || stored.ShipyardID !== yardId || stored.TaskTypeID !== row.taskType || stored.TotalBP !== row.totalBP || stored.CompletedBP !== row.completedBP || row.remaining !== row.totalBP - row.completedBP })
    const inconsistent = yards.filter((yard) => !Array.isArray(yard.taskRows) || yard.taskRows.length !== yard.tasks)

    check(`${label}: every stored task of the race is one task row of its yard, with its type, build points and what is left`, rowsOf.length === taskRowsStored.length && wrongRows.length === 0, `${rowsOf.length} rows against ${taskRowsStored.length} stored; ${wrongRows.slice(0, 3).map(({ row }) => row.id).join(', ')}`)
    check(`${label}: every yard's task rows are as many as its task count`, inconsistent.length === 0, inconsistent.slice(0, 3).map((yard) => `yard ${yard.id}`).join(', '))

    const [storedHulls] = await database.query('select FCT_ShipyardTask.TaskID, FCT_ShipyardTask.NumShips from FCT_ShipyardTask where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID', { replacements: scope }).catch(() => [null])
    const hullsById = storedHulls ? Object.fromEntries(storedHulls.map((row) => [row.TaskID, typeof row.NumShips === 'number' ? row.NumShips : null])) : {}
    const wrongHulls = [...rowsOf.map(({ row }) => ({ id: row.id, hulls: row.hulls })), ...tasks.map((task) => ({ id: task.ID, hulls: task.Hulls }))].filter(({ id, hulls }) => hulls !== (id in hullsById ? hullsById[id] : null))

    check(`${label}: every task row and refit task carries the count of ships its stored task makes (${storedHulls ? `${storedHulls.filter((row) => row.NumShips > 1).length} of ${storedHulls.length} repeat` : 'the save stores none, so unknown'})`, wrongHulls.length === 0, wrongHulls.slice(0, 3).map(({ id, hulls }) => `task ${id}: ${hulls}`).join('; '))

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

    const lightYards = yards.filter((yard) => yard.type === 4)

    if (lightYards.length) {
      const plant = (sizeHS) => ({ ...classes[0], id: `planted-${sizeHS}`, name: `Planted ${sizeHS * 50} t`, sizeHS, commercial: false, obsolete: false, shippingLine: false, otherRace: false, prototype: false })
      const nine = plant(18)
      const eleven = plant(22)
      const planted = { ...context, classesById: { ...classesById, [nine.id]: nine, [eleven.id]: eleven } }
      const flags = ['obsolete', 'shippingLine', 'otherRace', 'prototype']
      const verdict = (yard, shipClass) => refits.yardEligibility(yard, shipClass, 'build', planted)
      const slipwayState = (yard) => (yard.tasks >= yard.slipways ? 'busy' : 'capable')
      const wrongClasses = []

      lightYards.forEach((yard) => classes.forEach((shipClass) => {
        const blocked = flags.some((flag) => shipClass[flag] === true) || shipClass.sizeHS > yard.capacity / 50
        const unknown = !blocked && (flags.some((flag) => shipClass[flag] === null) || shipClass.sizeHS === null)
        const expected = blocked ? 'ineligible' : unknown ? 'unknown' : slipwayState(yard)
        const state = refits.yardEligibility(yard, shipClass, 'build', context).state

        if (state !== expected) {
          wrongClasses.push(`yard ${yard.id} class ${shipClass.name}: ${state}, expected ${expected}`)
        }
      }))

      note(verdict(lightYards[0], nine).result)
      check(`${label}: each of the ${lightYards.length} light yards (${[...new Set(lightYards.map((yard) => `${yard.slipways} slipways of ${yard.capacity} t`))].join(', ')}) lists a planted class of 900 t with no tooling: ${slipwayState(lightYards[0])}, listed, its no-retool verdict holding`, lightYards.every((yard) => verdict(yard, nine).state === slipwayState(yard) && verdict(yard, nine).tooling.kind === 'listed' && verdict(yard, nine).tooling.tooled === null && verdict(yard, nine).tooling.check.ok === true))
      check(`${label}: each light yard refuses a planted class of 1100 t, naming the capacity and that a light yard can be neither retooled nor given more capacity`, lightYards.every((yard) => verdict(yard, eleven).state === 'ineligible' && verdict(yard, eleven).blockers.some((reason) => reason.includes('capacity')) && verdict(yard, eleven).blockers.some((reason) => reason.includes('neither retooled nor given more capacity'))))
      check(`${label}: each of the race's ${classes.length} classes at each light yard is ineligible exactly when a flag or the capacity bars it, unknown when a flag it lacks would decide, else listed`, wrongClasses.length === 0, wrongClasses.slice(0, 3).join('; '))
      console.log(`INFO  ${label}: ${lightYards.length} light yards; the first lists ${classes.filter((shipClass) => verdict(lightYards[0], shipClass).state === slipwayState(lightYards[0])).length} of the ${classes.length} classes (the others are over its ${lightYards[0].capacity} t, obsolete, a shipping line's, another race's or with prototype components)`)
    } else {
      console.log(`INFO  ${label}: the save holds no light yard`)
    }

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

      // The game's list offers the class a yard is tooled for alone, so a stored task for another class is a limit of the model, not a rule to test: a task outlives the retool that changed the yard's class.
      offending.push(`yard ${yard.id}: ${source.name} tooled, task for ${target.name}`)
    })

    if (tooled.length && construction.length) {
      console.log(`INFO  ${label}: ${offending.length} stored construction tasks at tooled yards are for a class other than the one the yard is tooled for (a task outlives a retool)${offending.length ? `: ${[...new Set(offending)].slice(0, 3).join('; ')}` : ''}`)
    }
  } finally {
    database.close()
  }
}

// The faults planted in refits.js, each caught by the worked statement it names: the source is patched in memory and the utilities load from it, so no copy of the folder is made. `fails` is text the failing statement's name holds, and it must match exactly one statement that fails.
const MUTANTS = [
  { name: 'the 80% to 120% window restored in place of the class a yard is tooled for', find: 'const ok = known ? tooling.id === target.id : null', replace: 'const ok = known ? inBand(tooling, target) === true : null', fails: 'a class within 80% to 120% of the tooled class' },
  { name: 'a Light yard made to ask the no-retool test', find: 'return { ok: true, withinSize: null, affordable: null, limit: null, result: envelope({ value: true,', replace: 'return { ok: false, withinSize: null, affordable: null, limit: null, result: envelope({ value: true,', fails: 'lists a class of 900 t without tooling' },
  { name: 'a Light yard\'s class over its capacity taken', find: 'const overCapacity = isNumber(yard.capacity) && isNumber(target.sizeHS) && target.sizeHS > yard.capacity / TONS_PER_HS', replace: 'const overCapacity = false', fails: 'a class of 1100 t is over the 1000 t capacity' },
  { name: 'a commercial target weighted in full in the refit\'s rate', find: 'CommercialModifier: commercialSizeFactor(target.commercial)', replace: 'CommercialModifier: 1', fails: 'a refit\'s rate counts a commercial target class' },
  { name: 'the refit source\'s size band dropped', find: 'const within = sourceWithinBand(tooled, source)', replace: 'const within = true', fails: 'refuses a 50 hull space source for the tooled class' },
  { name: 'the band asked of a light yard', find: 'if (yard.type !== null && yard.type !== SHIPYARD_TYPE.LIGHT) {', replace: 'if (yard.type !== null) {', fails: 'a refit at a light yard needs no tooling and no size band' },
  { name: 'the post-retool band read from the class the yard is tooled for now', find: 'const tooled = afterRetool ? target : tooledClassOf(yard, classesById)', replace: 'const tooled = afterRetool ? (tooledClassOf(yard, classesById) || target) : tooledClassOf(yard, classesById)', fails: 'the refit source band follows the class tooled at the time of the refit' },
  { name: 'the source band skipped once a retool is needed', find: 'const within = sourceWithinBand(tooled, source)', replace: 'const within = afterRetool ? true : sourceWithinBand(tooled, source)', fails: 'the refit source band follows the class tooled at the time of the refit' },
]

const mutationChecks = async () => {
  if (!mutating()) {
    return
  }

  const source = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', 'refits.js'), 'utf8')

  for (const mutant of MUTANTS) {
    let mutated = null

    try {
      mutated = plantedPatch('refits.js', source, mutant.find, mutant.replace)
    } catch (error) {
      check(`mutation caught: ${mutant.name}`, false, `invalid mutant: ${error.message}`)
      continue
    }

    const utilities = await loadUtilities(['refits', 'provenance', 'capabilities'], { sources: { refits: mutated } })
    const results = []

    sink = results

    try {
      worked(utilities.refits, utilities.provenance)
    } catch (error) {
      check(`mutation caught: ${mutant.name}`, false, `the worked cases throw under it: ${error.message}`)
      sink = null
      continue
    } finally {
      sink = null
    }

    const named = results.filter((result) => result.name.includes(mutant.fails))

    check(`mutation caught: ${mutant.name}`, named.length === 1 && named[0].ok === false, named.length === 1 ? 'the named statement fails' : `${named.length} statements match "${mutant.fails}"`)
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

  await mutationChecks()

  const registered = ['refit.cost', 'refit.minerals', 'refit.share', 'refit.noRetool', 'refit.retool', 'refit.yardEligibility', 'refit.time']

  check('every refit rule is registered and was exercised', registered.every((id) => utilities.provenance.getRule(id) && covered.has(id)), `rules covered: ${[...covered].sort().join(', ')}`)
  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
