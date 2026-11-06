/*
  Checks the known-wrecks warning of the Warnings page (the `known-wrecks` check of src/renderer/utilities/warnings/space.js): a wreck of another race in a system the race has surveyed is named by the class the race's own intelligence holds for it (`FCT_AlienClass` of the viewing race), or as unknown when it holds none, and never by the real class of the other race (`FCT_ShipClass`), which the game shows only the owner of the wreck. The race's own wreck is named by its class.

  Run: bun scripts/check-warning-wrecks.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The saved game is the migrated Galactic Shogunate save (the fixture of scripts/lib/fixtures.js), read only: the race has 11 wrecks in its surveyed systems, 1 its own and 10 of other races. Foreign wrecks with an alias for the class that differs from the real class and foreign wrecks with no alias are both there, and the check takes the first of each from SQL over the save. The expected names come from SQL over the save, never from the module.

  Every planted fault must fail the check it names by a wrong value, never because a call threw (scripts/lib/fault-credit.js), and each rewrite that says the same thing must leave every check passing. The word for a class that is not known is a text policy: the owner of the rule names it Unknown, and a rewrite that says Unknown class passes.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { runSuite } = require('./lib/suite-runner')
const { patched } = require('./lib/mutant-source')
const { HarnessError, GROUPINGS } = require('./lib/browser-observe')
const { assert, through, runChecks, judged, caughtAll, notCaught } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const DETAIL = process.argv.includes('--detail')
const SPACE = path.join(root, 'src', 'renderer', 'utilities', 'warnings', 'space.js')
const SEPARATOR = GROUPINGS.Tick

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const real = (specifier) => `import { createRequire } from 'node:module'\nexport default ${requireOf(specifier)}`

const STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  'lodash/groupBy': real('lodash/groupBy'),
  'lodash/partition': real('lodash/partition'),
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
}

// ---------- the save ----------

let SAVED = null

const saved = () => {
  if (!SAVED) {
    const file = path.join(root, SAVE)

    if (!fs.existsSync(file)) {
      throw new HarnessError(`the save is not there: ${SAVE}`)
    }

    SAVED = new Database(file, { readonly: true })
  }

  return SAVED
}

const closeSave = () => {
  if (SAVED) {
    SAVED.close()
    SAVED = null
  }

  if (PLANTED) {
    PLANTED.copy.close()
    PLANTED = null
  }
}

// The save held in memory with a wreck and two life pods of the race added, of which one wreck and one pod are tied to a Lagrange point (`OrbitLagrangeID`), as the save holds none: the planted rows the captions of the warnings must state. The pod of the race is the only kind the life pod warning lists.
let PLANTED = null

const planted = () => {
  if (!PLANTED) {
    saved()

    const copy = new Database(fs.readFileSync(path.join(root, SAVE)))
    const [wreck] = copy.query(`select WreckID from FCT_Wrecks where GameID = ${GAME} and coalesce(OrbitBodyID, 0) = 0 and SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE}) order by WreckID limit 1`).all()
    const [system] = copy.query(`select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} order by SystemID limit 1`).all()
    const [{ GameTime }] = copy.query(`select GameTime from FCT_Game where GameID = ${GAME}`).all()

    if (!wreck || !system) {
      throw new HarnessError('the save must hold a wreck tied to no body and a system the race has surveyed')
    }

    copy.run(`update FCT_Wrecks set OrbitLagrangeID = 1 where WreckID = ${wreck.WreckID}`)
    copy.run(`insert into FCT_Lifepods (LifepodID, GameID, RaceID, SystemID, OrbitLagrangeID, ShipName, Crew, CreationTime) values (900000001, ${GAME}, ${RACE}, ${system.SystemID}, 1, 'Tied pod', 4, ${GameTime - 3600}), (900000002, ${GAME}, ${RACE}, ${system.SystemID}, 0, 'Free pod', 2, ${GameTime - 7200})`)
    PLANTED = { copy, wreck: wreck.WreckID, GameTime }
  }

  return PLANTED
}

const adapter = (db) => ({ query: async (sql) => [db.query(sql).all()] })

// What the save says of the wrecks in the systems the race has surveyed, from SQL written here: the owner, the real class name of the owner and the class name the race's own intelligence holds for it (null when it holds none).
const wrecksOf = (db) => db.query(`select FCT_Wrecks.WreckID, FCT_Wrecks.RaceID, FCT_ShipClass.ClassName as RealClass, FCT_AlienClass.ClassName as Alias from FCT_Wrecks left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Wrecks.ClassID left join FCT_AlienClass on FCT_AlienClass.GameID = FCT_Wrecks.GameID and FCT_AlienClass.ViewRaceID = ${RACE} and FCT_AlienClass.ActualClassID = FCT_Wrecks.ClassID where FCT_Wrecks.GameID = ${GAME} and FCT_Wrecks.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE}) order by FCT_Wrecks.WreckID`).all()

// ---------- the checks ----------

const namesChecks = {
  id: 'names',
  name: 'a wreck of the race is named by its class and one of another race by the race\'s alias for its class or as unknown, never by its real class',
  run: async ({ rows, db }) => {
    const wrecks = wrecksOf(db)
    const own = wrecks.filter((wreck) => wreck.RaceID === RACE)
    const foreign = wrecks.filter((wreck) => wreck.RaceID !== RACE)
    const aliased = foreign.find((wreck) => wreck.Alias && wreck.Alias !== wreck.RealClass)
    const unaliased = foreign.find((wreck) => !wreck.Alias)

    if (!aliased || !unaliased || !unaliased.RealClass || !aliased.RealClass) {
      throw new HarnessError('the save must hold a foreign wreck with an alias for its class that differs from its real class and a foreign wreck with none, both of a class with a real name')
    }

    const shown = await rows()

    assert.deepEqual(shown.map((row) => row.id).sort(), wrecks.map((wreck) => `wreck:${wreck.WreckID}`).sort(), 'the warning lists the wrecks of the surveyed systems, each once')
    assert.ok(own.length > 0 && foreign.length > 0, `the save holds wrecks of the race (${own.length}) and of other races (${foreign.length})`)

    const rowOf = (wreck) => shown.find((row) => row.id === `wreck:${wreck.WreckID}`)

    own.forEach((wreck) => {
      const row = rowOf(wreck)

      assert.equal(row.cells.wreck, wreck.RealClass, `the own wreck ${wreck.WreckID} is named by its class`)
      assert.notEqual(row.cells.design, '', `the own wreck ${wreck.WreckID} is marked as the race's`)
    })
    foreign.forEach((wreck) => {
      const row = rowOf(wreck)

      assert.ok(wreck.Alias === wreck.RealClass || row.cells.wreck !== wreck.RealClass, `the wreck ${wreck.WreckID} of another race is named by its real class ${wreck.RealClass}`)
      assert.equal(row.cells.design, '', `the wreck ${wreck.WreckID} of another race is not marked as the race's`)
    })
    assert.equal(rowOf(aliased).cells.wreck, aliased.Alias, `wreck ${aliased.WreckID} is named by the alias of the race`)
    assert.match(rowOf(unaliased).cells.wreck, /^Unknown( class)?$/, `wreck ${unaliased.WreckID} has no alias and is named as unknown`)
  },
}

// A wreck and a life pod tied to a Lagrange point are captioned as lying at one, and the wreck and the pod that are tied to none are not.
const anchoredChecks = {
  id: 'anchored',
  name: 'a wreck or a life pod tied to a Lagrange point is captioned as lying at one, and the save, which holds none, as lying at none',
  run: async ({ rows, wrecks, pods, planted: plantOf }) => {
    const shownWrecks = await wrecks()
    const shownPods = await pods()
    const plant = plantOf()
    const tied = shownWrecks.find((row) => row.id === `wreck:${plant.wreck}`)

    assert.ok(tied && / — at a Lagrange point$/.test(tied.caption), `the wreck tied to a point is captioned as at one: ${tied && tied.caption}`)
    assert.deepEqual(shownWrecks.filter((row) => /Lagrange/.test(row.caption || '')).map((row) => row.id), [`wreck:${plant.wreck}`], 'and no other wreck is')
    assert.ok(/ — at a Lagrange point$/.test(shownPods.find((row) => row.id === 'lifepod:900000001').caption), 'the pod tied to a point is captioned as at one')
    assert.deepEqual(shownPods.filter((row) => /Lagrange/.test(row.caption || '')).map((row) => row.id), ['lifepod:900000001'], 'and the pod tied to none is not')
    assert.ok((await rows()).every((row) => !/Lagrange/.test(row.caption || '')), 'no wreck of the save itself, tied to no point, is captioned as at one')
  },
}

const CHECKS = [namesChecks, anchoredChecks]

// ---------- the faults and the rewrites ----------

const swap = (from, to) => (text) => patched(SPACE, text, from, to)
const then = (...changes) => (text) => changes.reduce((given, change) => change(given), text)

const GATE = 'case when FCT_Wrecks.RaceID = FCT_RaceSysSurvey.RaceID then FCT_ShipClass.ClassName end as OwnClassName'
const UNGATED = 'FCT_ShipClass.ClassName as OwnClassName'
const CELL = "wreck.Owned ? wreck.OwnClassName || 'Unknown class' : wreck.AlienClassName || 'Unknown'"

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a wreck of another race is named by its real class', change: then(swap(GATE, UNGATED), swap(CELL, "wreck.OwnClassName || 'Unknown class'")), fails: ['names'] },
  { name: 'a wreck of another race with no alias falls back to its real class', change: then(swap(GATE, UNGATED), swap(CELL, "wreck.Owned ? wreck.OwnClassName || 'Unknown class' : wreck.AlienClassName || wreck.OwnClassName || 'Unknown'")), fails: ['names'] },
  { name: 'a wreck of the race is named by an alias', change: swap(CELL, "wreck.AlienClassName || 'Unknown'"), fails: ['names'] },
  { name: 'the alias is read from the intelligence of another race', change: swap('FCT_AlienClass.ViewRaceID = ${RaceID}', 'FCT_AlienClass.ViewRaceID != ${RaceID}'), fails: ['names'] },
  { name: 'a wreck of another race is marked as the race\'s', change: swap("(wreck.Owned ? 'Owned' : '')", "'Owned'"), fails: ['names'] },
  { name: 'a wreck of the race is not marked as the race\'s', change: swap("(wreck.Owned ? 'Owned' : '')", "''"), fails: ['names'] },
  { name: 'a wreck tied to a Lagrange point is captioned as in its system', change: swap('wreck.OrbitLagrangeID > 0 ? `${systemText(wreck)} — at a Lagrange point` : systemText(wreck)', 'systemText(wreck)'), fails: ['anchored'] },
  { name: 'every wreck is captioned as at a Lagrange point', change: swap('wreck.OrbitLagrangeID > 0 ?', 'wreck.OrbitLagrangeID >= 0 ?'), fails: ['anchored'] },
  { name: 'the wrecks leave out the Lagrange point they are tied to', change: swap('FCT_Wrecks.SystemID, FCT_Wrecks.OrbitLagrangeID, FCT_Wrecks.Size', 'FCT_Wrecks.SystemID, FCT_Wrecks.Size'), fails: ['anchored'] },
  { name: 'a life pod tied to a Lagrange point is captioned as in its system', change: swap("lifepod.OrbitLagrangeID > 0 ? [lifepod.SystemName, 'at a Lagrange point'].filter(Boolean).join(' — ') : lifepod.SystemName || undefined", 'lifepod.SystemName || undefined'), fails: ['anchored'] },
  { name: 'every life pod is captioned as at a Lagrange point', change: swap('lifepod.OrbitLagrangeID > 0 ?', 'lifepod.OrbitLagrangeID >= 0 ?'), fails: ['anchored'] },
  { name: 'the life pods leave out the Lagrange point they are tied to', change: swap('FCT_Lifepods.SystemID, FCT_Lifepods.OrbitLagrangeID, FCT_Lifepods.ShipName', 'FCT_Lifepods.SystemID, FCT_Lifepods.ShipName'), fails: ['anchored'] },
]

// Rewrites that say the same thing: the owner test in parentheses and another word for a class that is not known.
const BENIGN = [
  { name: 'the owner test of a wreck in parentheses', change: swap(CELL, "(wreck.Owned) ? wreck.OwnClassName || 'Unknown class' : wreck.AlienClassName || 'Unknown'") },
  { name: 'another word for the class of a wreck of another race that is not known', change: swap(CELL, "wreck.Owned ? wreck.OwnClassName || 'Unknown class' : wreck.AlienClassName || 'Unknown class'") },
]
/* eslint-enable no-template-curly-in-string */

// ---------- a run of the checks over the source as it is, or with `change` made to it ----------

const text = fs.readFileSync(SPACE, 'utf8')

const results = async (variant, ids) => {
  const source = variant ? variant.change(text) : text
  const modules = await loadUtilities(['warnings/common', 'warnings/space'], { stubs: STUBS, sources: { 'warnings/space': source } })
  const check = modules['warnings/space'].checks.find((item) => item.key === 'known-wrecks')
  const podCheck = modules['warnings/space'].checks.find((item) => item.key === 'active-lifepods')

  if (!check || !podCheck) {
    throw new HarnessError('the module has no check keyed known-wrecks and none keyed active-lifepods')
  }

  const db = saved()
  const ctx = { GameID: GAME, RaceID: RACE, RaceNPR: false, database: adapter(db), separator: SEPARATOR, count: modules['warnings/common'].counter(SEPARATOR), options: {} }
  let held = null
  const rows = () => {
    held = held || through('the read of the known-wrecks check', () => check.read(ctx))

    return held
  }
  const readOnPlanted = (which, label) => {
    const plant = planted()

    return through(label, () => which.read({ ...ctx, database: adapter(plant.copy), GameTime: plant.GameTime }))
  }
  const memo = (make) => {
    let made = null

    return () => made || (made = make())
  }

  return await runChecks(CHECKS.filter(({ id }) => !ids || ids.includes(id)), { rows, db, wrecks: memo(() => readOnPlanted(check, 'the read of the known-wrecks check over the planted rows')), pods: memo(() => readOnPlanted(podCheck, 'the read of the active-lifepods check over the planted rows')), planted })
}

let checks = 0
let failures = 0

const report = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n         ${detail || 'false'}`}`)
}

const checkHead = async () => {
  const found = await results(null)

  judged(found, 'the source')
  found.forEach((result) => report(result.name, result.ok, result.detail))
}

const checkFault = async (fault) => {
  const found = await results(fault, fault.fails)

  judged(found, fault.name)
  report(`fault caught: ${fault.name}`, caughtAll(found, { name: fault.name }), notCaught(found))

  if (DETAIL) {
    found.forEach((result) => console.log(`         ${result.id}: ${result.ok ? 'holds' : result.detail}`))
  }
}

const checkRewrite = async (rewrite) => {
  const found = await results(rewrite)
  const wrong = judged(found, rewrite.name).map((result) => `${result.id}: ${result.detail}`)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0, wrong.join('; '))
}

// The deadline of a variant, in seconds: it loads the warning modules and reads the wrecks of the save.
const DEADLINE = 120

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the known-wrecks warning over the Skoormit save', head: true, heading: 'The known-wrecks warning (utilities/warnings/space.js)', deadline: DEADLINE, run: checkHead },
  ...(mutating ? FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults', deadline: DEADLINE, run: () => checkFault(fault) })) : []),
  ...(mutating ? BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites that say the same thing', deadline: DEADLINE, run: () => checkRewrite(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    close: async () => closeSave(),
    control: null,
    setup: DEADLINE,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  closeSave()
  process.exit(2)
})
