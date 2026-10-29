/*
  Checks the known-wrecks warning of the Warnings page (the `known-wrecks` check of src/renderer/utilities/warnings/space.js): a wreck of another race in a system the race has surveyed is named by the class the race's own intelligence holds for it (`FCT_AlienClass` of the viewing race), or as unknown when it holds none, and never by the real class of the other race (`FCT_ShipClass`), which the game shows only the owner of the wreck. The race's own wreck is named by its class.

  Run: bun scripts/check-warning-wrecks.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The saved game is Skoormit (saves/AuroraDB_271_skoormit_saved.db, game 138, race 785), read only: the race has 12 wrecks in its surveyed systems, 10 its own and 2 of another race (wreck 180 with an alias for its class and wreck 169 with none). The expected names come from SQL over the save, never from the module.

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

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const GAME = 138
const RACE = 785
const ALIASED_WRECK = 180
const ALIASED_NAME = 'LÉ Niamh'
const UNALIASED_WRECK = 169
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
    const aliased = foreign.find((wreck) => wreck.WreckID === ALIASED_WRECK)
    const unaliased = foreign.find((wreck) => wreck.WreckID === UNALIASED_WRECK)

    if (!aliased || aliased.Alias !== ALIASED_NAME || !unaliased || unaliased.Alias || !unaliased.RealClass || !aliased.RealClass) {
      throw new HarnessError('the save must hold foreign wreck 180 with an alias for its class and foreign wreck 169 with none, both of a class with a real name')
    }

    const shown = await rows()

    assert.deepEqual(shown.map((row) => row.id).sort(), wrecks.map((wreck) => `wreck:${wreck.WreckID}`).sort(), 'the warning lists the wrecks of the surveyed systems, each once')
    assert.deepEqual([own.length, foreign.length], [10, 2], 'the save holds 10 wrecks of the race and 2 of another race')

    const rowOf = (wreck) => shown.find((row) => row.id === `wreck:${wreck.WreckID}`)

    own.forEach((wreck) => {
      const row = rowOf(wreck)

      assert.equal(row.cells.wreck, wreck.RealClass, `the own wreck ${wreck.WreckID} is named by its class`)
      assert.notEqual(row.cells.design, '', `the own wreck ${wreck.WreckID} is marked as the race's`)
    })
    foreign.forEach((wreck) => {
      const row = rowOf(wreck)

      assert.notEqual(row.cells.wreck, wreck.RealClass, `the wreck ${wreck.WreckID} of another race is named by its real class ${wreck.RealClass}`)
      assert.equal(row.cells.design, '', `the wreck ${wreck.WreckID} of another race is not marked as the race's`)
    })
    assert.equal(rowOf(aliased).cells.wreck, aliased.Alias, 'wreck 180 is named by the alias of the race')
    assert.match(rowOf(unaliased).cells.wreck, /^Unknown( class)?$/, 'wreck 169 has no alias and is named as unknown')
  },
}

const CHECKS = [namesChecks]

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

  if (!check) {
    throw new HarnessError('the module has no check keyed known-wrecks')
  }

  const db = saved()
  const ctx = { GameID: GAME, RaceID: RACE, RaceNPR: false, database: adapter(db), separator: SEPARATOR, count: modules['warnings/common'].counter(SEPARATOR), options: {} }
  let held = null
  const rows = () => {
    held = held || through('the read of the known-wrecks check', () => check.read(ctx))

    return held
  }

  return await runChecks(CHECKS.filter(({ id }) => !ids || ids.includes(id)), { rows, db })
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
