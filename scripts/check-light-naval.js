/*
  Checks the light naval rules the 3.1 line gives the planners: the captain of a ship of 20 hull spaces or less counts in full where a larger ship's captain counts halved (utilities/survey.js `officerFactor` and `fleetSurveyRate`, utilities/commanders.js `specialistPost` and the Commanders page's ships read), the Industry tab and the Production page name Light Naval capacity (pages/production.vue, utilities/warnings/industry.js, mixins/production-modifiers.js), no read of the removed `FCT_ShipClass.FighterClass` is left, and the landing size stays 10 hull spaces with the verdict for a bayless ship over it left unresolved (utilities/transport.js).

  Run: bun scripts/check-light-naval.js [--no-mutations]

  Every expected figure is written here from the game's rule (`Commander.method_7`: the full stored bonus for a captain of a ship whose class `Size` is at most 20, otherwise 1 + (bonus - 1) / 2; `Ship.method_125`: the survey factor is the science officer's bonus times that, the control component default being the same 20), never read from the module:
  - `factor`: the officer factor at the limit (20 hull spaces, included), a hair under and over it and at the sizes of the fixture's classes, with a science officer, without a captain, with a captain who has no Survey bonus, with a bonus below 1, a captain whose Survey bonus is 1 (or is not stored) leaving the science officer's bonus alone without a class size, the control component default that stays as it was, and a class size that is not a number (null, missing, text, an object) leaving the factor unknown where the captain's bonus is not 1, never the full bonus of a light naval craft;
  - `rate`: a fleet's points a day for a light naval craft, a larger ship and both together, the assumption a rate that rests on a light naval captain's full bonus carries until a save holds a case (it is not a saved case: the game that played the fixture halved every captain's bonus), and a sensor ship whose class size is not stored giving no rate and naming it, while a ship without a captain, a ship whose captain's Survey bonus is 1 (a science officer aboard included) or a ship without a sensor of the kind needs no size and the fleet still rates;
  - `post`: the post and share the Commanders page suggests for a survey ship without a Science Department (the captain at the full share up to 20 hull spaces, half above), the science officer's post and the miner's and terraformer's captain unmoved by size, and a class whose size is not stored unavailable, never read as small;
  - `save`: on the interim 3.1 fixture (scripts/lib/fixtures.js, game 141, race 784) the two survey ships of the class Intrepid (1,220 hull spaces, no survey order, so no saved progress) rate by the half bonus, and on copies whose class is cut to 20, 20.0001 and 10 hull spaces the loader's rows rate by the full bonus at the limit and below and by the half above it, each against the figure worked out here from the commanders' stored bonuses;
  - `page`: the Commanders page's own ships read, taken from its source and run on the same copies, delivers the class size and gives the post and share the size decides;
  - `landing`: the landing size is 10 hull spaces on the line the rule is registered for, where a craft over it with no bays at a colony with no spaceport is blocked, and the 10 hull space limit of the 3.1 source's shuttle branch (`Ship.GetCargoShuttleTransferMultiplier`) does not keep any craft from loading there (the multiplier is positive, `Ship.method_159` counting one bay for none), the light naval limit of 20 moving nothing;
  - `names`: the production type 2 and the idle capacity column read Light Naval, the Industry check of free light naval capacity says so in its title and rule, the capacity rule names installation 35, the Light Naval Factory, and the terms a missing capacity names are light naval ones;
  - `reads`: no source or script reads `FighterClass`, the mission brief check reads `LightNavalUnit`, and the shipped 3.1 fixtures hold `LightNavalUnit` and no `FighterClass`, installation 35 named Light Naval Factory with the rating the capacity reads.
  The fixture holds no survey craft of 20 hull spaces or less, so the light naval cases of `save` are planted into copies; a saved case needs the specimen S7 of AE-310-03, played under 3.1. A save that is not there reads UNSUPPORTED.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const SHIPPED = 'saves/AuroraDB_310_shipped.db'
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
// The class Intrepid: the two survey ships of the fixture, each with a Science Department and a captain, one captain with a Survey bonus of 1.13 and the other with none stored.
const SURVEY_CLASS = 63083
const SURVEY_SPEED = 40
const SURVEY_BONUS = 2
const LIMIT = 20
const NEAR = 1e-9

const FILES = {
  survey: path.join(root, 'src', 'renderer', 'utilities', 'survey.js'),
  commanders: path.join(root, 'src', 'renderer', 'utilities', 'commanders.js'),
  transport: path.join(root, 'src', 'renderer', 'utilities', 'transport.js'),
  industry: path.join(root, 'src', 'renderer', 'utilities', 'warnings', 'industry.js'),
  productionTypes: path.join(root, 'src', 'renderer', 'utilities', 'production-types.js'),
  modifiers: path.join(root, 'src', 'renderer', 'mixins', 'production-modifiers.js'),
  commandersPage: path.join(root, 'src', 'renderer', 'pages', 'commanders.vue'),
  productionPage: path.join(root, 'src', 'renderer', 'pages', 'production.vue'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The packages the utilities import, as the least the checks need of them: no date or numeral is formatted here.
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules and pages as shipped, or with edits planted ------------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => ({
  texts,
  modules: memo(() => loadUtilities(['survey', 'commanders', 'transport', 'warnings/industry', 'production-types', 'provenance', '../mixins/production-modifiers', '../utilities/provenance'], {
    stubs: STUBS,
    sources: { survey: texts.survey, commanders: texts.commanders, transport: texts.transport, 'warnings/industry': texts.industry, 'production-types': texts.productionTypes, '../mixins/production-modifiers': texts.modifiers },
  })),
})

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= NEAR * Math.max(1, Math.abs(a), Math.abs(b))
const value = (result) => (result && result.status !== 'unavailable' ? result.value : null)

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
let CLONES = null

// The saved bytes once, and a copy of them whose survey class has the size given (null: as saved), made in memory so that no file is written.
const clones = () => {
  if (!CLONES) {
    const bytes = fs.readFileSync(path.join(root, SAVE))
    const copy = (size) => {
      const database = Database.deserialize(bytes)

      if (size !== null) {
        database.run(`update FCT_ShipClass set Size = ${size} where ShipClassID = ${SURVEY_CLASS}`)
      }

      return database
    }

    CLONES = { intact: copy(null), limit: copy(LIMIT), over: copy(20.0001), tiny: copy(10) }
  }

  return CLONES
}

const closeClones = () => {
  if (CLONES) {
    Object.values(CLONES).forEach((database) => database.close())
    CLONES = null
  }
}

const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

// What the game's rule needs of each survey ship of the class, by SQL written here and apart from the loader's: the class size, the commanders' stored Survey bonuses (a captain is CommandType 1 and a science officer 10, both commanding the ship) and the class's control components and Science Department. Undamaged: the fixture has no damage to these ships, which `save` asserts.
const oracleRows = (database) => database.query(`select FCT_Ship.ShipID, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.Size,
  (select count(*) from FCT_Commander where FCT_Commander.GameID = ${GAME} and FCT_Commander.CommandType = 1 and FCT_Commander.CommandID = FCT_Ship.ShipID) as Captains,
  (select FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${SURVEY_BONUS} where FCT_Commander.GameID = ${GAME} and FCT_Commander.CommandType = 1 and FCT_Commander.CommandID = FCT_Ship.ShipID) as CaptainBonus,
  (select FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${SURVEY_BONUS} where FCT_Commander.GameID = ${GAME} and FCT_Commander.CommandType = 10 and FCT_Commander.CommandID = FCT_Ship.ShipID) as ScienceBonus,
  (select count(*) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 10) as ControlLines,
  (select count(*) from FCT_ClassComponent where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.ComponentID = 65739) as ScienceLines,
  (select sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = 7) as GeoRating,
  (select count(*) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID) as Damage
from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
where FCT_Ship.GameID = ${GAME} and FCT_Ship.RaceID = ${RACE} and FCT_Ship.ShipClassID = ${SURVEY_CLASS}
order by FCT_Ship.ShipID`).all()

// The factor the rule gives one such ship: the science officer's bonus (the class has the Science Department) times the captain's, in full at the limit or below and halved above, a bonus not stored being 1; a ship without a captain has 1.
const oracleFactor = (row) => {
  if (!row.Captains) {
    return 1
  }

  const captain = row.CaptainBonus ?? 1
  const science = row.ScienceLines > 0 ? row.ScienceBonus ?? 1 : 1

  return science * (row.Size <= LIMIT ? captain : 1 + (captain - 1) / 2)
}

// Points a day of the ship's geological sensors at the fixture's survey speed, no naval admin command in range: rating x factor x crew share x morale (1) x speed x 24 hours.
const oracleRate = (row) => row.GeoRating * oracleFactor(row) * Math.min(1, row.CurrentCrew / row.ClassCrew) * (SURVEY_SPEED / 100) * 24

// ---- Rows the cases are built from ---------------------------------------------------------------------------------
const officer = (overrides = {}) => ({ HasCaptain: true, CaptainBonus: 1.4, HasScienceOfficer: false, ScienceBonus: null, ScienceDepartments: 0, ControlValue: 1, ClassSize: 10, ...overrides })

const sensorShip = (id, size, overrides = {}) => ({ ShipID: id, MothershipID: 0, CurrentCrew: 100, ClassCrew: 100, CrewMorale: 1, GeoValue: 2, GeoDesigned: 2, GravValue: 0, GravDesigned: 0, DamagedLines: 0, ...officer({ CaptainBonus: 1.5, ClassSize: size }), ...overrides })

const postRow = (overrides = {}) => ({ ShipID: 1, ShipName: 'Scout', ClassName: 'Scout', RankRequired: 2, ShipSeniorCO: 0, ClassSize: 10, Terraformers: 0, MiningModules: 0, Harvesters: 0, SciencePosts: 0, GeoSurvey: 2, GravSurvey: 0, ...overrides })

// The Commanders page's ships read, as its source writes it: the template literal after `ships: {` with the game, the race and the class rank columns (`classRank`, of `rosterParts` for a complete save) filled in.
const pageShipsSql = (text, classRank) => {
  const from = text.indexOf('    ships: {\n      get: tracked(\'ships\'')
  const open = text.indexOf('this.database.query(`', from) + 'this.database.query(`'.length
  const close = text.indexOf('`).then(([items])', open)

  if (from < 0 || open < from || close < open) {
    throw new Error('the Commanders page\'s ships read is not where the check looks for it')
  }

  return text.slice(open, close).replace(/\$\{this\.GameID\}/g, String(GAME)).replace(/\$\{this\.RaceID\}/g, String(RACE)).replace(/\$\{parts\.classRank\}/, () => classRank)
}

// A declaration of a page's script, evaluated: the object or array literal after `const <name> = `.
const declared = (text, name, closing) => {
  const start = text.indexOf(`const ${name} = `)

  if (start < 0) {
    throw new Error(`${name} is not declared where the check looks for it`)
  }

  const open = start + `const ${name} = `.length
  const end = text.indexOf(closing, open)

  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${text.slice(open, end + closing.length)})`)))
}

const filesUnder = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === 'node_modules' ? [] : filesUnder(path.join(directory, entry.name))) : /\.(js|vue|ts|mjs)$/.test(entry.name) ? [path.join(directory, entry.name)] : []))

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('factor', 'a captain of a ship of 20 hull spaces or less, the limit included, counts in full and the captain of a larger ship counts halved, with the science officer\'s bonus beside it, a bonus below 1 kept, no captain giving 1, a captain whose Survey bonus is 1 or is not stored leaving the science officer\'s bonus alone without a class size, the control component default left as it was, and a class size that is not a number leaving a bonus that is not 1 unknown, never the full bonus', async (w) => {
  const { survey: s } = await w.modules()
  const at = (size, extra = {}) => s.officerFactor(officer({ ClassSize: size, ...extra }))
  const scientist = { HasScienceOfficer: true, ScienceBonus: 1.3, ScienceDepartments: 1 }

  assert.ok(near(at(2.14039770577343), 1.4), `a probe of 2.14 hull spaces counts its captain in full, not ${at(2.14039770577343)}`)
  assert.ok(near(at(10), 1.4), `10 hull spaces counts in full, not ${at(10)}`)
  assert.ok(near(at(19.9989912747276), 1.4), `the stored size of a 20 hull space class counts in full, not ${at(19.9989912747276)}`)
  assert.ok(near(at(20), 1.4), `the limit itself is included, so 20 counts in full, not ${at(20)}`)
  assert.ok(near(at(20.0001), 1.2), `a hair over the limit halves, 1 + 0.4 / 2, not ${at(20.0001)}`)
  assert.ok(near(at(21), 1.2), `21 hull spaces halves, not ${at(21)}`)
  assert.ok(near(at(1219.99841057646), 1.2), `the fixture's survey ship of 1,220 hull spaces halves, not ${at(1219.99841057646)}`)

  assert.ok(near(at(15, scientist), 1.3 * 1.4), `the science officer's bonus times the full captain's bonus on a light naval craft, not ${at(15, scientist)}`)
  assert.ok(near(at(500, scientist), 1.3 * 1.2), `the science officer's bonus times the half captain's bonus on a larger ship, not ${at(500, scientist)}`)
  assert.ok(near(at(15, { ...scientist, ScienceDepartments: 0 }), 1.4), 'a damaged Science Department leaves the captain alone')

  assert.equal(at(15, { HasCaptain: false, ...scientist }), 1, 'a light naval craft without a captain has a factor of 1, whatever else it has')
  assert.equal(at(500, { HasCaptain: false, ...scientist }), 1, 'a larger ship without a captain has a factor of 1')
  assert.equal(at(15, { CaptainBonus: null }), 1, 'a captain with no Survey bonus counts as 1 on a light naval craft')
  assert.equal(at(500, { CaptainBonus: null }), 1, 'a captain with no Survey bonus counts as 1 on a larger ship')
  assert.ok(near(at(10, { CaptainBonus: 0.9 }), 0.9), `a bonus below 1 is kept in full on a light naval craft, not ${at(10, { CaptainBonus: 0.9 })}`)
  assert.ok(near(at(30, { CaptainBonus: 0.9 }), 0.95), `a bonus below 1 is halved on a larger ship, not ${at(30, { CaptainBonus: 0.9 })}`)

  assert.equal(at(null, { CaptainBonus: 1 }), 1, 'a captain whose Survey bonus is 1 needs no class size: the factor is 1 at every size')
  assert.equal(at(null, { CaptainBonus: null, ...scientist }), 1.3, 'a captain with no Survey bonus stored needs no class size either: the science officer\'s 1.3 stands')
  assert.equal(at(null, { CaptainBonus: 1, ControlValue: 0, ...scientist }), 1.3, 'a bonus of 1 is 1 in full, halved and through the control default alike, so no size decides it')
  assert.equal(at(null, { ...scientist }), null, 'a science officer does not make the factor known without a class size where the captain\'s bonus is not 1')

  assert.ok(near(at(15, { ControlValue: 0 }), 1.4), 'a class of 20 hull spaces or less with no control component counts as having one, so its captain counts in full')
  assert.ok(near(at(20, { ControlValue: 0 }), 1.4), 'the control default includes the limit')
  assert.equal(at(25, { ControlValue: 0 }), 1, 'a larger class with no control component has no captain bonus')
  assert.ok(near(at(25, { ControlValue: 1.9 }), 1.2), 'a larger class with a control component counts its captain halved')

  for (const size of [null, undefined, NaN, '', 'twenty', {}]) {
    assert.equal(at(size), null, `a class size of ${JSON.stringify(size)} leaves the factor unknown, not the full bonus of a light naval craft (${at(size)})`)
  }

  assert.equal(at(null, { HasCaptain: false }), 1, 'a ship without a captain needs no class size: its factor is 1')
  assert.equal(at(null, { ControlValue: 0 }), null, 'the control default rests on the size too, so a class with no control component and no size has no factor')
})

check('rate', 'a fleet\'s points a day count a light naval craft\'s captain in full and a larger ship\'s halved, each ship by its own size, a rate that rests on the full bonus says so while one that does not stays confirmed, a sensor ship whose class size is not stored gives no rate and names it, and a ship without a captain, a ship whose captain\'s Survey bonus is 1 even with a science officer, or a ship without a sensor of the kind needs no size', async (w) => {
  const { survey: s } = await w.modules()
  const scientist = { HasScienceOfficer: true, ScienceBonus: 1.3, ScienceDepartments: 1 }
  const rate = (ships, speed = 100) => s.fleetSurveyRate(ships, 'geo', { speed, admin: 1, version: '2.7.1' })
  const light = rate([sensorShip(1, 10)])
  const limit = rate([sensorShip(1, 20)])
  const over = rate([sensorShip(1, 20.5)])
  const large = rate([sensorShip(1, 500)])
  const both = rate([sensorShip(1, 10), sensorShip(2, 500)])
  const bare = rate([sensorShip(1, 10, { CaptainBonus: null })])
  const slow = rate([sensorShip(1, 10)], 40)

  assert.ok(near(value(light), 2 * 1.5 * 24), `a craft of 10 hull spaces: 2 x 1.5 x 24 points a day, not ${value(light)}`)
  assert.ok(near(value(limit), 2 * 1.5 * 24), `a craft of 20 hull spaces: the limit is included, not ${value(limit)}`)
  assert.ok(near(value(over), 2 * 1.25 * 24), `a ship of 20.5 hull spaces: 2 x 1.25 x 24, not ${value(over)}`)
  assert.ok(near(value(large), 2 * 1.25 * 24), `a ship of 500 hull spaces: 2 x 1.25 x 24, not ${value(large)}`)
  assert.ok(near(value(both), (2 * 1.5 + 2 * 1.25) * 24), `the two ships each by their own size, not ${value(both)}`)
  assert.ok(near(value(bare), 2 * 24), `a light naval captain with no Survey bonus adds nothing, not ${value(bare)}`)
  assert.ok(near(value(slow), 2 * 1.5 * 24 * 0.4), `the survey speed scales a light naval craft's rate, not ${value(slow)}`)

  assert.equal(large.status, 'confirmed', `a larger ship's rate is confirmed by the half bonus, not ${large.status}`)
  assert.equal(bare.status, 'confirmed', `a light naval craft whose captain has no bonus rests on no unchecked rule, not ${bare.status}`)
  assert.equal(light.status, 'estimated', `a light naval craft whose captain has a bonus rests on the game's rule alone, not ${light.status}`)
  assert.ok(light.assumptions.some((text) => /full Survey bonus of the captain of a ship of 20 hull spaces or less/.test(text)), `the rate names the full bonus: ${light.assumptions.join(' | ')}`)
  assert.ok(both.assumptions.some((text) => /full Survey bonus/.test(text)), 'a fleet with a light naval craft among its ships names the full bonus too')
  assert.ok(!large.assumptions.some((text) => /full Survey bonus/.test(text)), 'a larger ship\'s rate names no full bonus')

  const noSize = rate([sensorShip(1, null)])
  const textSize = rate([sensorShip(1, 'twenty')])
  const captainless = rate([sensorShip(1, null, { HasCaptain: false })])
  const neutral = rate([sensorShip(1, null, { CaptainBonus: null, ...scientist })])
  const scientistNoSize = rate([sensorShip(1, null, scientist)])
  const idle = rate([sensorShip(1, 10), { ...sensorShip(2, null), GeoValue: 0, GeoDesigned: 0 }])

  assert.equal(noSize.status, 'unavailable', `a sensor ship whose class size is not stored gives no rate, not a light naval one (${noSize.status})`)
  assert.deepEqual(noSize.inputs.missing, ['a ship\'s class size'], `the rate names the class size it lacks: ${noSize.inputs.missing.join(' | ')}`)
  assert.equal(value(noSize), null, 'an unavailable rate has no figure, never the full bonus read as a small class')
  assert.equal(textSize.status, 'unavailable', `a class size that is not a number gives no rate either (${textSize.status})`)
  assert.ok(near(value(captainless), 2 * 24), `a ship without a captain needs no class size: its 2 rating x 24 hours, not ${value(captainless)}`)
  assert.ok(near(value(neutral), 2 * 1.3 * 24), `a science officer aboard a sensor ship whose captain's Survey bonus is 1 rates without a class size: 2 x 1.3 x 24, not ${value(neutral)}`)
  assert.equal(neutral.status, 'confirmed', `a neutral captain's bonus rests on no unchecked rule, not ${neutral.status}`)
  assert.ok(!neutral.assumptions.some((text) => /full Survey bonus/.test(text)), 'a neutral captain\'s rate names no full bonus')
  assert.equal(scientistNoSize.status, 'unavailable', `the same ship with a captain whose bonus is not 1 gives no rate without a class size (${scientistNoSize.status})`)
  assert.deepEqual(scientistNoSize.inputs.missing, ['a ship\'s class size'], `that rate names the class size it lacks: ${scientistNoSize.inputs.missing.join(' | ')}`)
  assert.ok(near(value(idle), 2 * 1.5 * 24), `a ship with no sensor of the kind needs no class size: the fleet still rates, not ${value(idle)}`)
})

check('post', 'the survey ship without a Science Department has its captain as the post, at the full share up to 20 hull spaces (the limit included) and half above, the science officer\'s post, the miner\'s and the terraformer\'s captain are the same at every size, and a class whose size is not stored has no post for the captain', async (w) => {
  const { commanders: c } = await w.modules()
  const post = (extra) => c.specialistPost(postRow(extra))
  const small = post({ ClassSize: 10 })
  const limit = post({ ClassSize: 20 })
  const over = post({ ClassSize: 20.0001 })
  const large = post({ ClassSize: 1219.99841057646 })

  assert.equal(small.status !== 'unavailable', true, 'a light naval survey ship has a post')
  assert.deepEqual([small.value.post, small.value.bonusId, small.value.share, small.value.label, small.value.level], ['captain', 2, 1, 'Survey', 2], 'the captain of a craft of 10 hull spaces counts in full')
  assert.equal(limit.value.share, 1, 'the limit is included: 20 hull spaces counts in full')
  assert.equal(limit.value.label, 'Survey')
  assert.deepEqual([over.value.post, over.value.share, over.value.label], ['captain', 0.5, 'Survey (half for a captain)'], 'a hair over the limit counts half')
  assert.deepEqual([large.value.share, large.value.label], [0.5, 'Survey (half for a captain)'], 'a ship of 1,220 hull spaces counts half')

  const science = [10, 500].map((size) => post({ ClassSize: size, SciencePosts: 1 }))

  assert.deepEqual(science.map((result) => [result.value.post, result.value.share, result.value.level]), [['science', 1, 1], ['science', 1, 1]], 'the science officer\'s post and share do not follow the size')
  assert.deepEqual([10, 500].map((size) => post({ ClassSize: size, MiningModules: 3 }).value.share), [1, 1], 'a miner\'s captain counts in full at every size')
  assert.deepEqual([10, 500].map((size) => post({ ClassSize: size, Terraformers: 2 }).value.share), [1, 1], 'a terraformer\'s captain counts in full at every size')

  const unknown = [null, undefined, NaN, ''].map((size) => post({ ClassSize: size }))

  unknown.forEach((result) => {
    assert.equal(result.status, 'unavailable', 'a class whose size is not stored has no survey post, not a small ship\'s')
    assert.ok(result.inputs.missing.some((text) => /the size of the class/.test(text)), `it names the size: ${result.inputs.missing.join(' | ')}`)
  })

  assert.equal(post({ ClassSize: null, MiningModules: 3 }).value.post, 'captain', 'a miner without a stored size still has its post: the size matters only to a survey captain')
})

check('save', 'on the fixture the two survey ships of the class Intrepid rate by the half bonus at their 1,220 hull spaces, and on copies whose class is cut to 20, 20.0001 and 10 hull spaces the loader\'s rows give the full bonus at the limit and below and the half above it, each ship\'s factor and fleet rate equal to the figure worked out here from the stored commanders\' bonuses', async (w) => {
  const { survey: s } = await w.modules()
  const copies = clones()
  const cases = [['as saved', copies.intact, 1219.99841057646], ['cut to 20', copies.limit, 20], ['cut to 20.0001', copies.over, 20.0001], ['cut to 10', copies.tiny, 10]]

  for (const [label, database, size] of cases) {
    const oracle = oracleRows(database)
    const rows = (await s.loadSurveyShips(loaderOf(database), { GameID: GAME, RaceID: RACE })).filter((row) => oracle.some((one) => one.ShipID === row.ShipID))

    assert.equal(oracle.length, 2, `${label}: the fixture has two ships of the survey class`)
    assert.ok(oracle.every((row) => row.Damage === 0 && row.ControlLines > 0 && row.ScienceLines === 1), `${label}: the ships are undamaged, with control components and a Science Department, which the worked figures take`)
    assert.equal(rows.length, 2, `${label}: the loader gives both ships`)

    rows.forEach((row) => {
      const expected = oracle.find((one) => one.ShipID === row.ShipID)
      const factor = s.officerFactor(row)
      const rate = s.fleetSurveyRate([row], 'geo', { speed: SURVEY_SPEED, admin: 1, version: '2.7.1' })

      assert.ok(near(row.ClassSize, size), `${label}: the loader's class size ${row.ClassSize} is the stored ${size}`)
      assert.ok(near(factor, oracleFactor(expected)), `${label}: ship ${row.ShipID}'s officer factor ${factor}, worked out ${oracleFactor(expected)}`)
      assert.ok(near(value(rate), oracleRate(expected)), `${label}: ship ${row.ShipID}'s geological rate ${value(rate)} points a day, worked out ${oracleRate(expected)}`)
    })
  }

  const first = (database) => oracleRows(database)[0]
  const half = 1.3 * (1 + 0.13 / 2)
  const full = 1.3 * 1.13

  assert.ok(near(oracleFactor(first(copies.intact)), half), 'the worked factor of the first ship as saved is the science officer\'s 1.3 times the half of 1.13')
  assert.ok(near(oracleFactor(first(copies.limit)), full) && near(oracleFactor(first(copies.tiny)), full), 'the worked factor of the first ship at 20 and 10 hull spaces is 1.3 times the full 1.13')
  assert.ok(near(oracleFactor(first(copies.over)), half), 'the worked factor of the first ship at 20.0001 hull spaces is the half again')
  assert.ok(near(oracleFactor(oracleRows(copies.limit)[1]), 1.3), 'the second ship\'s captain has no stored bonus, so the size changes nothing')
})

check('page', 'the Commanders page\'s own ships read delivers the class size, and with it a survey ship without a Science Department is rated at the full share at 20 hull spaces and half above, on the fixture and on the copies', async (w) => {
  const { commanders: c } = await w.modules()
  const sql = pageShipsSql(w.texts.commandersPage, c.rosterParts(null, { GameID: GAME, RaceID: RACE }).classRank)
  const copies = clones()
  const rowsOf = (database) => database.query(sql).all().filter((row) => row.ClassName === 'Intrepid')
  const unstaffed = (row) => ({ ...row, SciencePosts: 0 })

  for (const [label, database, size, share] of [['as saved', copies.intact, 1219.99841057646, 0.5], ['cut to 20', copies.limit, 20, 1], ['cut to 20.0001', copies.over, 20.0001, 0.5], ['cut to 10', copies.tiny, 10, 1]]) {
    const rows = rowsOf(database)

    assert.equal(rows.length, 2, `${label}: the page reads the two survey ships`)

    rows.forEach((row) => {
      const kept = c.specialistPost(row)
      const stripped = c.specialistPost(unstaffed(row))

      assert.ok(near(row.ClassSize, size), `${label}: the page's read delivers the class size ${row.ClassSize}, stored ${size}`)
      assert.equal(kept.status !== 'unavailable' && kept.value.post, 'science', `${label}: the class has a Science Department, so the science officer holds the post at every size`)
      assert.equal(stripped.status !== 'unavailable' && stripped.value.share, share, `${label}: without a Science Department the captain counts at ${share}, not ${stripped.status === 'unavailable' ? 'nothing' : stripped.value.share}`)
    })
  }
})

check('landing', 'the landing size is 10 hull spaces on the line the rule is registered for (a craft of 10 lands, one over it with no bays at a colony with no spaceport is blocked) and on the 3.1 line the same limit is the source\'s shuttle branch, over which a bayless craft still loads at a colony with no spaceport (its ship term counts one bay), the light naval limit of 20 moving nothing', async (w) => {
  const { transport: t } = await w.modules()
  const colony = t.colonyEndpoint({ PopName: 'Mars', ShuttleCapacity: 0, ServiceNames: '', PopulationID: 7, SystemID: 3 })
  const ship = (size) => ({ ShipName: 'Hauler', ClassName: 'Hauler', Size: size, ShuttleStrength: 0, DesignedShuttleStrength: 0, CurrentCrew: 10, ClassCrew: 10 })
  const verdict = (size, version) => t.shipEligibility(ship(size), colony, version)

  assert.equal(t.landingThreshold('2.7.1'), 10, 'the landing size is 10 hull spaces, not the light naval 20')
  assert.equal(verdict(10, '2.7.1').status, 'permitted', 'a craft of 10 hull spaces, the limit included, lands')
  assert.equal(verdict(10.5, '2.7.1').status, 'blocked', 'a bayless craft of 10.5 hull spaces is blocked at a colony with no spaceport on the line the rule is registered for')
  assert.equal(verdict(15, '2.7.1').status, 'blocked', 'a bayless craft of 15 hull spaces, 750 t, is blocked there too: the light naval limit does not move the landing size')
  assert.equal(verdict(20, '2.7.1').status, 'blocked', 'nor does 20 hull spaces, 1,000 t')

  assert.equal(t.landingThreshold('3.1.x'), 10, 'the shuttle limit of the 3.1 source is 10 hull spaces, not the light naval 20')
  assert.equal(verdict(5, '3.1.x').status, 'permitted', 'a small craft loads at a colony with no spaceport on the 3.1 line')
  assert.equal(verdict(10, '3.1.x').status, 'permitted', 'the limit included')

  for (const size of [10.5, 15, 20]) {
    assert.equal(verdict(size, '3.1.x').status, 'permitted', `a bayless craft of ${size} hull spaces loads at a colony with no spaceport on the 3.1 line, not ${verdict(size, '3.1.x').status}: its ship term counts one bay`)
  }

  const unknown = verdict(15, null)

  assert.equal(t.landingThreshold(null), null, 'a save that states no game rules has no landing size')
  assert.equal(unknown.status, 'unsupported', `a bayless craft over 10 hull spaces gets no verdict when the save states no game rules, not ${unknown.status}`)
  assert.equal(unknown.reasons[0].code, 'landing-unverified', 'the reason is the unverified landing rule')
})

check('names', 'the production type 2 and the idle capacity column read Light Naval, the Industry check names light naval capacity in its title, rule and kind, the capacity rule names installation 35, the Light Naval Factory, and the terms a missing capacity names are light naval ones', async (w) => {
  const modules = await w.modules()
  const industry = modules['warnings/industry']
  const mixin = modules['../mixins/production-modifiers']
  const provenance = modules['../utilities/provenance']
  const types = modules['production-types'].PRODUCTION_TYPE_NAMES
  const columns = declared(w.texts.productionPage, 'CAPACITY_COLUMNS', '\n]')
  const kinds = declared(w.texts.industry, 'PRODUCTION_KINDS', '}')
  const found = industry.checks.find((one) => one.key === 'free-fighter-capacity')
  const rule = provenance.getRule('production.populationCapacity')
  const terms = mixin.capacityResult({ FighterProduction: null, OverallProductionModifier: 1, FighterProductionPower: null }, 'fighter', new Set())

  assert.equal(types[2], 'Light Naval', `the production type 2 reads Light Naval on the Production page, not ${types[2]}`)
  assert.deepEqual({ 0: types[0], 1: types[1], 2: types[2], 3: types[3], 4: types[4] }, { 0: 'Construction', 1: 'Ordnance', 2: 'Light Naval', 3: 'Component', 4: 'Space station' }, 'the other production types are as they were')
  assert.deepEqual(columns.map((column) => column.text), ['Construction', 'Ordnance', 'Light Naval', 'Ground training', 'Research labs', 'Slipways'], 'the idle capacity columns name Light Naval')
  assert.equal(columns.find((column) => column.key === 'fighter').bp, true, 'the Light Naval column is in build points a year')
  assert.equal(kinds.fighter, 'Light Naval', `the Industry tab names the light naval project kind Light Naval, not ${kinds.fighter}`)
  assert.equal(industry.group.title, 'Industry', 'the group is the Industry tab')
  assert.ok(found, 'the Industry tab keeps the check of free light naval capacity under its stored key')
  assert.ok(/light naval/.test(found.title(2)) && !/fighter/i.test(found.title(2)), `the Industry check's title names light naval capacity: ${found.title(2)}`)
  assert.ok(/light naval/.test(found.rule) && !/fighter/i.test(found.rule), `its rule names light naval factories: ${found.rule}`)
  const evidence = modules.provenance.getRule(found.provenance)

  assert.ok(/light naval installations/.test(evidence.note) && !/fighter/i.test(evidence.note), 'its evidence names light naval installations')
  assert.ok(rule.structure.some((text) => /FighterProductionValue \(the Light Naval Factory, installation 35\)/.test(text)), `the capacity rule names installation 35: ${rule.structure.join(' | ')}`)
  assert.ok(/light naval/.test(rule.note) && /installation 35/.test(rule.note) && !/fighter/i.test(rule.note.replace(/FighterProduction(Value)?/g, '')), 'the capacity rule\'s note says light naval and gives the stored column names once')
  assert.deepEqual(terms.inputs.missing, ['the race\'s light naval production', 'the light naval rating of the installations'], 'a missing capacity names the light naval terms')
  assert.deepEqual(declared(w.texts.productionPage, 'CAPACITY_WORDS', '}'), { construction: 'construction', ordnance: 'ordnance', fighter: 'light naval' }, 'the Production page words the capacity kinds, the light naval one by its name and not by the id of its stored columns')
  assert.ok(!/\$\{category\}/.test(w.texts.productionPage), 'no text of the Production page interpolates the capacity id: the idle-capacity note and the share note go through the words')
  assert.ok(/'the construction, ordnance and light naval capacity of the colonies'/.test(w.texts.capabilities) && !/ordnance and fighter capacity/.test(w.texts.capabilities), 'the effect the Production bonus is shown with names light naval capacity')
})

check('reads', 'no source or script reads FighterClass, the mission brief check reads LightNavalUnit, and the shipped 3.1 fixtures hold LightNavalUnit and no FighterClass, installation 35 named Light Naval Factory with the rating the capacity reads', async () => {
  const removed = ['Fighter', 'Class'].join('')
  const own = path.join(root, 'scripts', 'check-light-naval.js')
  const readers = [...filesUnder(path.join(root, 'src')), ...filesUnder(path.join(root, 'scripts'))].filter((file) => file !== own && fs.readFileSync(file, 'utf8').includes(removed))

  assert.deepEqual(readers.map((file) => path.relative(root, file)), [], `no file names the removed column ${removed}`)
  assert.ok(/from FCT_ShipClass where GameID = :GameID and LightNavalUnit = 1/.test(fs.readFileSync(path.join(root, 'scripts', 'check-mission-briefs.js'), 'utf8')), 'the mission brief check reads the light naval flag from LightNavalUnit')

  for (const file of [SAVE, SHIPPED]) {
    const location = path.join(root, file)

    assert.ok(fs.existsSync(location), `the fixture ${file} is there`)

    const database = new Database(location, { readonly: true })
    const columns = database.query('select name from pragma_table_info(\'FCT_ShipClass\') where name in (\'FighterClass\', \'LightNavalUnit\')').all().map((row) => row.name)
    const factory = database.query('select Name, FighterProductionValue from DIM_PlanetaryInstallation where PlanetaryInstallationID = 35').all()

    database.close()
    assert.deepEqual(columns, ['LightNavalUnit'], `${file} holds LightNavalUnit and no ${removed}`)
    assert.deepEqual(factory, [{ Name: 'Light Naval Factory', FighterProductionValue: 1 }], `${file}: installation 35 is the Light Naval Factory and carries the rating the capacity reads`)
  }
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
const OFFICER_TERNARY = 'ship.ClassSize <= LIGHT_NAVAL_SIZE ? bonus : 1 + (bonus - 1) / 2'
const POST_TERNARY = 'return ship.ClassSize <= LIGHT_NAVAL_SIZE ? post({ post: \'captain\', bonusId: SURVEY, label: \'Survey\', share: 1 }) : post({ post: \'captain\', bonusId: SURVEY, label: \'Survey (half for a captain)\', share: 0.5 })'
// A template placeholder of the page's source, written so that the strings of this script hold no placeholder of their own.
const interpolated = (code) => '$' + '{' + code + '}'

const FAULTS = [
  { name: 'a ship whose class size is not stored is read as a light naval craft by the officer factor', target: 'survey', from: 'if (!Number.isFinite(ship.ClassSize)) {', to: 'if (false) {', fails: ['factor', 'rate'] },
  { name: 'the officer factor consults a class size before the captain\'s neutral Survey bonus', target: 'survey', from: '  if (bonus === 1) {\n    return science\n  }\n\n  if (!Number.isFinite(ship.ClassSize)) {\n    return null\n  }', to: '  if (!Number.isFinite(ship.ClassSize)) {\n    return null\n  }\n\n  if (bonus === 1) {\n    return science\n  }', fails: ['factor', 'rate'] },
  { name: 'the light naval limit excludes 20 hull spaces (< for <=) in the officer factor', target: 'survey', from: OFFICER_TERNARY, to: 'ship.ClassSize < LIGHT_NAVAL_SIZE ? bonus : 1 + (bonus - 1) / 2', fails: ['factor', 'rate', 'save'] },
  { name: 'the captain\'s bonus is halved on every ship again, as before the light naval limit', target: 'survey', from: OFFICER_TERNARY, to: '1 + (bonus - 1) / 2', fails: ['factor', 'rate', 'save'] },
  { name: 'the captain\'s bonus counts in full on every ship, the halving above the limit dropped', target: 'survey', from: OFFICER_TERNARY, to: 'bonus', fails: ['factor', 'rate', 'save'] },
  { name: 'the light naval limit of the officer factor is 25 hull spaces', target: 'survey', from: 'const LIGHT_NAVAL_SIZE = 20', to: 'const LIGHT_NAVAL_SIZE = 25', fails: ['factor', 'rate', 'save'] },
  { name: 'the light naval limit of the officer factor is the landing size, 10 hull spaces', target: 'survey', from: 'const LIGHT_NAVAL_SIZE = 20', to: 'const LIGHT_NAVAL_SIZE = 10', fails: ['factor', 'rate', 'save'] },
  { name: 'the control component default is for classes of 10 hull spaces or less', target: 'survey', from: 'const SMALL_CLASS_SIZE = 20', to: 'const SMALL_CLASS_SIZE = 10', fails: ['factor'] },
  { name: 'a rate that rests on a light naval captain\'s full bonus is not marked as an estimate', target: 'survey', from: 'ship.HasCaptain && ship.ClassSize <= LIGHT_NAVAL_SIZE && (ship.CaptainBonus ?? 1) !== 1', to: 'false', fails: ['rate'] },
  { name: 'the Commanders post excludes 20 hull spaces (< for <=) from the full share', target: 'commanders', from: 'return ship.ClassSize <= LIGHT_NAVAL_SIZE ? post(', to: 'return ship.ClassSize < LIGHT_NAVAL_SIZE ? post(', fails: ['post', 'page'] },
  { name: 'the Commanders post gives a survey captain the half share at every size again', target: 'commanders', from: POST_TERNARY, to: 'return post({ post: \'captain\', bonusId: SURVEY, label: \'Survey (half for a captain)\', share: 0.5 })', fails: ['post', 'page'] },
  { name: 'the light naval limit of the Commanders post is 25 hull spaces', target: 'commanders', from: 'const LIGHT_NAVAL_SIZE = 20', to: 'const LIGHT_NAVAL_SIZE = 25', fails: ['post', 'page'] },
  { name: 'a class whose size is not stored is read as a small ship by the Commanders post', target: 'commanders', from: '} else if (!isKnownNumber(ship.ClassSize)) {', to: '} else if (false) {', fails: ['post'] },
  { name: 'the Commanders page\'s ships read leaves the class size out', target: 'commandersPage', from: 'FCT_ShipClass.Size as ClassSize, ', to: '', fails: ['page'] },
  { name: 'the landing size follows the light naval limit, 20 hull spaces', target: 'transport', from: 'const SMALL_CRAFT_SIZE = 10', to: 'const SMALL_CRAFT_SIZE = 20', fails: ['landing'] },
  { name: 'a bayless craft over 10 hull spaces is refused at a colony with no spaceport on the 3.1 line as on the 2.7 line', target: 'transport', from: '} else if (zeroBayBase(version)) {', to: '} else if (false) {', fails: ['landing'] },
  { name: 'the Production page names the production type 2 Fighter again', target: 'productionTypes', from: '[PRODUCTION_TYPE.LIGHT_NAVAL]: \'Light Naval\',', to: '[PRODUCTION_TYPE.LIGHT_NAVAL]: \'Fighter\',', fails: ['names'] },
  { name: 'the idle capacity column reads Fighters again', target: 'productionPage', from: '{ key: \'fighter\', text: \'Light Naval\', bp: true }', to: '{ key: \'fighter\', text: \'Fighters\', bp: true }', fails: ['names'] },
  { name: 'the Industry check is titled free fighter production capacity again', target: 'industry', from: 'with free light naval production capacity', to: 'with free fighter production capacity', fails: ['names'] },
  { name: 'the Industry tab names the type-2 project kind Fighters again', target: 'industry', from: 'const PRODUCTION_KINDS = { ordnance: \'Ordnance\', fighter: \'Light Naval\', construction: \'Construction\' }', to: 'const PRODUCTION_KINDS = { ordnance: \'Ordnance\', fighter: \'Fighters\', construction: \'Construction\' }', fails: ['names'] },
  { name: 'the capacity rule leaves installation 35 out', target: 'modifiers', from: ' (the Light Naval Factory, installation 35)', to: '', fails: ['names'] },
  { name: 'a missing light naval rating is named a fighter rating again', target: 'modifiers', from: 'FighterProductionPower: \'the light naval rating of the installations\'', to: 'FighterProductionPower: \'the fighter rating of the installations\'', fails: ['names'] },
  { name: 'a colony with no light naval capacity is told it has no fighter capacity', target: 'productionPage', from: `The colony has no ${interpolated('CAPACITY_WORDS[category]')} capacity`, to: `The colony has no ${interpolated('category')} capacity`, fails: ['names'] },
  { name: 'a project\'s share is shown as a share of fighter', target: 'productionPage', from: `% of ${interpolated('CAPACITY_WORDS[category]')}`, to: `% of ${interpolated('category')}`, fails: ['names'] },
  { name: 'the words of the light naval capacity kind give the id of its stored columns', target: 'productionPage', from: 'fighter: \'light naval\' }', to: 'fighter: \'fighter\' }', fails: ['names'] },
  { name: 'the Production bonus is shown as moving the fighter capacity', target: 'capabilities', from: 'the construction, ordnance and light naval capacity of the colonies', to: 'the construction, ordnance and fighter capacity of the colonies', fails: ['names'] },
]

// Rewrites that say the same thing: a bonus read with a longhand default, the control default written the other way round, a rank level written with its arguments swapped, a tonnage written as a product, a threshold written as a fraction.
const BENIGN = [
  { name: 'the captain\'s bonus defaulted with an explicit test', target: 'survey', from: 'const bonus = ship.CaptainBonus ?? 1', to: 'const bonus = ship.CaptainBonus === null || ship.CaptainBonus === undefined ? 1 : ship.CaptainBonus' },
  { name: 'the control default written as a larger-than test', target: 'survey', from: '(ship.ClassSize <= SMALL_CLASS_SIZE ? 1 : 0)', to: '(ship.ClassSize > SMALL_CLASS_SIZE ? 0 : 1)' },
  { name: 'the secondary officer\'s level with its arguments swapped', target: 'commanders', from: 'Math.max(1, ship.RankRequired - 1)', to: 'Math.max(ship.RankRequired - 1, 1)' },
  { name: 'a tonnage per hull space written as a quotient', target: 'transport', from: 'const TONNES_PER_HULL_SPACE = 50', to: 'const TONNES_PER_HULL_SPACE = 100 / 2' },
  { name: 'the idle minimum written as a fraction', target: 'productionPage', from: 'const IDLE_MINIMUM = 0.5', to: 'const IDLE_MINIMUM = 1 / 2' },
]

// ---- Run ------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

// The fixtures each check needs: a check whose fixture is not there is left out and said so.
const FIXTURES = { save: [SAVE], page: [SAVE], reads: [SAVE, SHIPPED] }
const absent = (one) => (FIXTURES[one.name] || []).filter((file) => !fs.existsSync(path.join(root, file)))

const main = async () => {
  const available = CHECKS.filter((one) => !absent(one).length)

  CHECKS.filter((one) => absent(one).length).forEach((one) => console.log(`UNSUPPORTED  ${one.name}: the fixture ${absent(one).join(', ')} is not there`))

  const failures = await run(available, worldOf())
  let passed = available.length - failures.length
  let total = available.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    const known = new Set(available.map(({ name }) => name))

    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(available, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith(benign)

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      const world = worldOf(texts)
      const named = fault.fails.filter((id) => known.has(id))
      const missed = []

      for (const id of named) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed, named: named.length }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (!outcome.named) {
        console.log(`FAIL planted fault ${outcome.label}: none of its checks can run here`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    closeClones()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeClones()
    process.exit(2)
  })
