// Checks whole research capacity, automatic allocation and the stored paused/unassigned inventory through public warning reads over a planted in-memory save. Population arithmetic belongs to the shared census suite; these cases retain consumer decisions and reported boundary regressions. No gameplay witness is claimed.
// Run: bun scripts/check-warning-research.js [--no-mutations] [--only=<case>]
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const file = path.resolve(__dirname, '../src/renderer/utilities/warnings/research.js')
const original = fs.readFileSync(file, 'utf8')
const STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} }',
  'lodash/groupBy': 'export default (rows, key) => Object.groupBy(rows, (row) => row[key])',
  'lodash/partition': 'export default (rows, test) => [rows.filter(test), rows.filter((row) => !test(row))]',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

// Only columns consumed by the warning reads are needed; amounts, assignment flags and bonus values are stored independently of the expected figures below.
const fixture = ({ labs = 10, value = 1, assigned = 0, auto = 1, admin = 10, pause = 0, population = 1, npr = 0, special = 0 } = {}) => {
  const raw = new Database(':memory:')

  raw.exec(`
    create table FCT_Race (GameID, RaceID, NoResearchProjects, NPR, SpecialNPRID);
    insert into FCT_Race values (1, 1, 0, ${npr}, ${special});
    create table FCT_Population (PopulationID, PopName, GameID, RaceID, SystemBodyID, SystemID, Population);
    insert into FCT_Population values (1, 'Test colony', 1, 1, 1, 1, ${population});
    create table FCT_PopulationInstallations (PopID, GameID, PlanetaryInstallationID, Amount);
    insert into FCT_PopulationInstallations values (1, 1, 1, ${labs});
    create table DIM_PlanetaryInstallation (PlanetaryInstallationID, ResearchValue);
    insert into DIM_PlanetaryInstallation values (1, ${value});
    create table FCT_ResearchProject (ProjectID, PopulationID, GameID, RaceID, TechID, Facilities, Pause, AssignNew);
    insert into FCT_ResearchProject values (1, 1, 1, 1, 1, ${assigned}, ${pause}, ${auto});
    create table FCT_Commander (CommanderID, GameID, RaceID, CommandType, CommandID);
    insert into FCT_Commander values (1, 1, 1, 7, 1);
    create table FCT_CommanderBonuses (CommanderID, BonusID, BonusValue);
    insert into FCT_CommanderBonuses values (1, 27, ${admin});
    create table FCT_TechSystem (TechSystemID, Name);
    insert into FCT_TechSystem values (1, 'Test research');
    create table FCT_SystemBody (SystemBodyID, PlanetNumber, OrbitNumber, BodyClass, StarID, Xcor, Ycor, GameID);
    insert into FCT_SystemBody values (1, 1, 0, 1, 1, 0, 0, 1);
    create table FCT_Ship (ShipID, GameID, RaceID, ShipClassID, FleetID);
    create table FCT_ShipClass (ShipClassID, ArkShip, GameID);
    create table FCT_Fleet (FleetID, GameID, RaceID, Xcor, Ycor, CivilianFunction, AssignedPopulationID);
    create table FCT_MoveOrders (FleetID, GameID);
    create table FCT_Species (SpeciesID, GameID);
    insert into FCT_Species values (1, 1);
    create table FCT_ShipCargo (ShipID, GameID, CargoTypeID, Amount, SpeciesID);
    create table FCT_ClassComponent (ClassID, ComponentID, NumComponent, GameID);
    create table FCT_ShipDesignComponents (SDComponentID, ComponentValue, ComponentTypeID, SpecialFunction, GameID);
    create table FCT_DamagedComponent (ShipID, ComponentID, Number, GameID);
    create table FCT_SystemBodyName (SystemBodyID, RaceID, Name);
    create table FCT_RaceSysSurvey (SystemID, RaceID, Name);
    create table FCT_Star (StarID, ComponentNumber);
  `)

  return { raw, ctx: { database: { query: (sql) => Promise.resolve([raw.query(sql).all()]) }, GameID: 1, RaceID: 1, count: String, separator: 'Tick' } }
}

const read = async (modules, key, options = {}, plant = () => {}) => {
  const { raw, ctx } = fixture(options)

  try {
    plant(raw)

    return await modules['warnings/research'].checks.find((check) => check.key === key).read(ctx)
  } finally {
    raw.close()
  }
}
// One person in one undamaged standard berth is enough to pass the total-population gate; an empty fleet or damaged berth is not.
const plantArk = (raw) => raw.exec('insert into FCT_Ship values (1, 1, 1, 1, 1); insert into FCT_ShipClass values (1, 1, 1); insert into FCT_Fleet values (1, 1, 1, 0, 0, 0, 1); insert into FCT_ShipCargo values (1, 1, 1, 1, 1); insert into FCT_ClassComponent values (1, 1, 1, 1); insert into FCT_ShipDesignComponents values (1, 1, 17, 7, 0)')

const CASES = [
  {
    name: 'idle-auto',
    run: async (modules) => {
      assert.deepEqual(await read(modules, 'idle-research-labs'), [], 'ten whole labs and AssignNew/admin ten leave zero idle facilities after automatic allocation')
    },
  },
  {
    name: 'idle-processing-gate',
    run: async (modules) => {
      const empty = await read(modules, 'idle-research-labs', { population: 0 })

      assert.deepEqual(empty.map((row) => row.id), ['colony:1'], 'a colony with no surface or orbital population never enters research processing, so ten free labs remain idle')
      assert.equal(empty[0].cells.used, '0', 'the skipped colony receives no predicted automatic allocation despite an eligible project and administration ten')
      assert.ok(!empty[0].unevaluated, 'a known empty colony has a decided idle warning')
      assert.equal((await read(modules, 'idle-research-labs', { npr: 1 }))[0].cells.used, '0', 'non-player races use a different research branch and receive no player-project allocation')
      assert.equal((await read(modules, 'idle-research-labs', { special: 6 }))[0].cells.used, '0', 'Ancient colonies leave the production tick before research')
      assert.ok((await read(modules, 'idle-research-labs', { population: null }))[0].unevaluated, 'unknown surface population is not a known empty colony')
      assert.ok((await read(modules, 'idle-research-labs', { npr: null }))[0].unevaluated, 'unknown race processing status cannot silently apply allocation')
      assert.ok(!(await read(modules, 'idle-research-labs', { population: null, auto: 0 }))[0].unevaluated, 'an unused population input cannot withhold a decided idle count when no project takes new labs')
      assert.ok(!(await read(modules, 'idle-research-labs', { population: 0, admin: null }))[0].unevaluated, 'a skipped colony needs no scientist rating to know that its labs remain idle')
    },
  },
  {
    name: 'census-wiring',
    run: async (modules) => {
      assert.deepEqual(await read(modules, 'idle-research-labs', { population: 0 }, plantArk), [], 'a decided positive census permits automatic assignment and leaves no idle labs')
      const empty = await read(modules, 'idle-research-labs', { population: 0 })
      const unknown = await read(modules, 'idle-research-labs', { population: 0 }, (raw) => { plantArk(raw); raw.exec('update FCT_ShipCargo set Amount = null') })
      const unknownRace = await read(modules, 'idle-research-labs', {}, (raw) => raw.exec('update FCT_Population set RaceID = null'))

      assert.equal(empty[0].cells.used, '0', 'a decided empty census leaves all ten labs idle')
      assert.ok(!empty[0].unevaluated, 'zero population is a decided warning, not missing input')
      assert.ok(unknown[0].unevaluated, 'an undecided census leaves the automatic allocation unknown')
      assert.ok(JSON.stringify(unknown[0]).includes('orbital population'), 'the unknown population gate is named in player words')
      assert.ok(unknownRace[0]?.unevaluated, 'unknown colony race cannot claim selected-race processing from conditional population facts')
      assert.ok((await read(modules, 'idle-research-labs', { population: 0, auto: 0 }, (raw) => raw.exec('update FCT_Population set RaceID = null')))[0]?.unevaluated, 'unknown colony ownership cannot create a definite selected-race warning even when zero population decides that allocation is skipped')
      assert.ok(!(await read(modules, 'idle-research-labs', { population: 0, npr: 1 }, (raw) => { plantArk(raw); raw.exec('update FCT_ShipCargo set Amount = null') }))[0].unevaluated, 'a known non-player exclusion decides processing despite an unknown census')
    },
  },
  {
    name: 'unknown-cargo-category',
    run: async (modules) => {
      const rows = await read(modules, 'idle-research-labs', { population: 0 }, (raw) => { plantArk(raw); raw.exec('update FCT_ShipCargo set CargoTypeID = null') })

      assert.deepEqual(rows.map((row) => row.id), ['colony:1'], 'unknown cargo category can change whether the ten free labs allocate')
      assert.ok(rows[0].unevaluated, 'potential colonists cannot be excluded to create a definite idle warning')
    },
  },
  {
    name: 'readable-cargo-lower-bound',
    run: async (modules) => {
      assert.deepEqual(await read(modules, 'idle-research-labs', { population: 0 }, (raw) => { plantArk(raw); raw.exec('insert into FCT_ShipCargo values (1, 1, 1, null, 1)') }), [], 'one readable person capped by one berth decides allocation despite unreadable extra cargo')
    },
  },
  {
    name: 'decisive-berth-zero',
    run: async (modules) => {
      for (const sql of [
        'update FCT_ShipDesignComponents set ComponentTypeID = 4, SpecialFunction = null',
        'update FCT_ShipDesignComponents set ComponentTypeID = null, SpecialFunction = 0',
        'update FCT_ClassComponent set NumComponent = 0; update FCT_ShipDesignComponents set ComponentValue = null',
        'update FCT_ClassComponent set NumComponent = null; update FCT_ShipDesignComponents set ComponentValue = 0',
      ]) {
        const rows = await read(modules, 'idle-research-labs', { population: 0 }, (raw) => { plantArk(raw); raw.exec(sql) })

        assert.equal(rows[0]?.cells.used, '0', 'a known berth exclusion or zero product leaves no orbital people and no automatic allocation')
        assert.ok(!rows[0].unevaluated, 'a missing sibling cannot obscure a known zero contribution')
      }
    },
  },
  {
    name: 'numeric-intake',
    run: async (modules) => {
      assert.deepEqual(await read(modules, 'idle-research-labs', { admin: 9.9995 }), [], 'the loaded decimal administration bonus rounds to three places before the whole-lab limit: 9.9995 becomes ten')
    },
  },
  {
    name: 'numeric-ranges',
    run: async (modules) => {
      for (const options of [{ labs: 2147483648, auto: 0 }, { admin: 2147483648 }, { assigned: 2147483648 }]) {
        const rows = await read(modules, 'idle-research-labs', options)

        assert.deepEqual(rows.map((row) => row.id), ['colony:1'], 'unsupported whole lab or administration counts remain listed')
        assert.ok(rows[0].unevaluated, 'unsupported counts cannot produce a definite warning')
      }
    },
  },
  {
    name: 'decimal-capacity',
    run: async (modules) => {
      const plant = (raw) => raw.exec('insert into DIM_PlanetaryInstallation values (2, 1); insert into FCT_PopulationInstallations values (1, 1, 2, 0.1)')
      const idle = await read(modules, 'idle-research-labs', { labs: 0.3, value: 3, auto: 0 }, plant)

      assert.deepEqual(idle.map((row) => row.id), ['colony:1'], 'decimal 0.3 times ResearchValue three plus 0.1 supplies one whole idle lab, not zero')
      assert.equal(idle[0].cells.labs, '1', 'idle capacity truncates the exact decimal weighted sum once')
      assert.deepEqual(await read(modules, 'dead-research-projects', { labs: 0.3, value: 3 }, plant), [], 'the same one whole decimal research facility prevents a dead-project warning')
      assert.equal((await read(modules, 'stalled-research-projects', { labs: 0.3, value: 3 }, plant))[0].cells.status, 'No labs assigned', 'one whole decimal facility places the unassigned project in its stored-snapshot inventory')
    },
  },
  {
    name: 'idle-whole',
    run: async (modules) => {
      assert.deepEqual(await read(modules, 'idle-research-labs', { labs: 0.5, auto: 0 }), [], 'half a facility is zero whole research facilities, not idle capacity')

      const combined = await read(modules, 'idle-research-labs', { labs: 0.6, auto: 0 }, (raw) => raw.run('insert into FCT_PopulationInstallations values (1, 1, 1, 0.6)'))
      const weighted = await read(modules, 'idle-research-labs', { labs: 0.6, value: 2, auto: 0 })

      assert.deepEqual(combined.map((row) => row.id), ['colony:1'], 'the combined whole facility is idle')
      assert.deepEqual(weighted.map((row) => row.id), ['colony:1'], 'the weighted whole facility is idle')
      assert.equal(combined[0].cells.labs, '1', 'two amounts of 0.6 supply one whole facility: truncate after summing')
      assert.equal(weighted[0].cells.labs, '1', '0.6 installations of ResearchValue two supply one whole facility')
    },
  },
  {
    name: 'project-whole',
    run: async (modules) => {
      const dead = await read(modules, 'dead-research-projects', { labs: 0.5, auto: 0 })

      assert.deepEqual(dead.map((row) => row.id), ['project:1'], 'half a lab cannot pass the whole-facility research-processing gate')
      assert.equal(dead[0].cells.labs, '0', 'the dead project shows zero effective whole facilities, not a fractional installed amount')
      assert.deepEqual(await read(modules, 'stalled-research-projects', { labs: 0.5, auto: 0 }), [], 'fractional-only facilities belong to dead projects, not the unassigned inventory')
      assert.deepEqual(await read(modules, 'dead-research-projects', { labs: 0.6, value: 2 }), [], 'ResearchValue weights capacity before the whole-facility gate')
      assert.equal((await read(modules, 'stalled-research-projects', { labs: 0.6, value: 2 }))[0].cells.status, 'No labs assigned', 'positive whole capacity preserves the unassigned stored inventory')

      const decimalPlant = (raw) => raw.exec('insert into DIM_PlanetaryInstallation values (2, 1); insert into FCT_PopulationInstallations values (1, 1, 2, 0.1)')

      assert.deepEqual(await read(modules, 'dead-research-projects', { labs: 0.3, value: 3 }, decimalPlant), [], 'D-12: decimal 0.3 times three plus 0.1 supplies a whole lab, so the project is not dead')
    },
  },
  {
    name: 'snapshot',
    run: async (modules) => {
      const check = modules['warnings/research'].checks.find((one) => one.key === 'stalled-research-projects')
      const rows = await read(modules, check.key)

      assert.equal(rows[0].cells.status, 'No labs assigned', 'the ten-lab automatic-allocation example is still an unassigned stored snapshot, not a requires-action diagnosis')
      assert.ok(/stored snapshot/.test(check.rule) && /automatically/.test(check.rule) && !/until the player acts/.test(check.rule), 'the visible rule distinguishes the saved assignment inventory from automatic progress')
      assert.equal((await read(modules, check.key, { pause: 1, assigned: 3 }))[0].cells.status, 'Paused', 'paused is a stored flag even with assigned labs')
    },
  },
  {
    name: 'allocation-limits',
    run: async (modules) => {
      const capped = await read(modules, 'idle-research-labs', { labs: 12, assigned: 1, admin: 3.9 })
      const shared = await read(modules, 'idle-research-labs', { labs: 12, admin: 6 }, (raw) => raw.exec('insert into FCT_ResearchProject values (2, 1, 1, 1, 1, 3, 0, 1); insert into FCT_Commander values (2, 1, 1, 7, 2); insert into FCT_CommanderBonuses values (2, 27, 5)'))

      assert.equal(capped[0].cells.used, '3', 'a 3.9 administration rating permits three assigned facilities, not 3.9 or four')
      assert.equal(shared[0].cells.used, '11', 'twelve total, three stored assignments and eight additional slots leave one idle, independent of project ordering')
      assert.deepEqual(await read(modules, 'idle-research-labs', { pause: 1 }), [], 'automatic allocation includes paused AssignNew projects before the pause test')
    },
  },
  {
    name: 'missing-allocation',
    run: async (modules) => {
      const unknown = await read(modules, 'idle-research-labs', { admin: null })
      const absent = await read(modules, 'idle-research-labs', {}, (raw) => raw.run('delete from FCT_CommanderBonuses'))
      const disabled = await read(modules, 'idle-research-labs', { auto: 0, admin: null })

      assert.ok(unknown[0].unevaluated, 'a stored null administration rating is unknown, not zero room')
      assert.ok(JSON.stringify(unknown[0]).includes('administration limit'), 'the unevaluated row names the allocation input')
      assert.equal(absent[0].cells.used, '0', 'no Research Administration bonus row means a zero rating')
      assert.equal(disabled[0].cells.used, '0', 'a project that does not AssignNew needs no administration input')
      assert.ok(!disabled[0].unevaluated, 'disabled automatic allocation is decidable even without the unused rating')

      const missingType = (raw) => raw.run('insert into FCT_PopulationInstallations values (1, 1, 99, 0.5)')
      const dead = await read(modules, 'dead-research-projects', { labs: 0.5 }, missingType)

      assert.ok(dead[0].unevaluated, 'a known fraction cannot prove presence when an unknown installation could supply a whole facility')
      assert.ok((await read(modules, 'idle-research-labs', { auto: 0 }, missingType))[0].unevaluated, 'unknown installation type prevents an exact idle-capacity claim even beside known labs')
    },
  },
  {
    name: 'zero-installation',
    run: async (modules) => {
      const zero = await read(modules, 'dead-research-projects', { labs: 0 }, (raw) => raw.exec('insert into FCT_PopulationInstallations values (1, 1, 99, 0)'))

      assert.deepEqual(zero.map((row) => row.id), ['project:1'], 'a zero installation amount cannot supply whole research capacity even when its type is missing')
      assert.equal(zero[0].cells.labs, '0', 'zero amount times any supported research value is zero')
      assert.ok(!zero[0].unevaluated, 'an unused installation type cannot obscure the decided dead project')
      assert.ok((await read(modules, 'dead-research-projects', { labs: 0 }, (raw) => raw.exec('insert into FCT_PopulationInstallations values (1, 1, 99, 1)')))[0].unevaluated, 'positive amount with a missing type can still change effective capacity')
    },
  },
  {
    name: 'zero-administration-room',
    run: async (modules) => {
      for (const auto of [null, 0, 1]) {
        const rows = await read(modules, 'idle-research-labs', { auto, admin: 0 })

        assert.deepEqual(rows.map((row) => row.id), ['colony:1'], 'zero administration room leaves all ten labs idle regardless of the automatic-assignment flag')
        assert.equal(rows[0].cells.used, '0', 'enabling automatic assignment cannot allocate a lab without administration room')
        assert.ok(!rows[0].unevaluated, 'the unused automatic-assignment flag cannot obscure a decided zero allocation')
      }

      assert.ok((await read(modules, 'idle-research-labs', { auto: null, admin: 10 }))[0].unevaluated, 'an unknown flag with positive administration room can still change allocation')
    },
  },
  {
    name: 'shared-census-boundary',
    run: () => {
      assert.ok(original.includes("import { loadOrbitalCensus } from '../orbital-census'"), 'the warning consumes the shared population census')
      assert.equal((original.match(/await loadOrbitalCensus\(/g) || []).length, 1, 'the warning loads the census once per read')
      assert.ok(!/\b(?:berthCapacity|cargoPeople|researchEntry|addPeople|minPeople|orbitalLo|orbitalHi|ComponentValue|NumComponent|SpecialFunction)\b|\bFCT_(?:ShipCargo|ClassComponent|DamagedComponent|MoveOrders|Fleet|Ship)\b/.test(original), 'no private orbital census or raw orbital reads remain in the warning; prototype component reads stay allowed')
    },
  },
  {
    name: 'labels',
    run: (modules) => {
      for (const key of ['idleResearchLabs', 'deadResearchProjects', 'stalledResearchProjects']) {
        assert.deepEqual(modules.provenance.getRule(`warnings.${key}`).versions, ['3.2.x'], `${key}: the repaired rule supports the expected formula line`)
      }
    },
  },
]
const FAULTS = [
  { name: 'automatic allocation is omitted', from: 'room.known += availableRoom', to: 'room.known += 0', fails: 'idle-auto' },
  { name: 'the research-processing gate is bypassed', from: 'allOf(population.RaceMatches, counted?.hasPopulation.value, population.NPR === 0 ? 1 : population.NPR === 1 ? 0 : null, isKnownNumber(population.SpecialNPRID) ? population.SpecialNPRID !== 6 : null)', to: '1', fails: 'idle-processing-gate' },
  { name: 'the census input is dropped', from: 'const counted = census.get(population.PopulationID)', to: 'const counted = undefined', fails: 'census-wiring' },
  { name: 'conditional colony race is promoted to selected race', from: 'counted?.raceMatches', to: 'true', fails: 'census-wiring' },
  { name: 'an undecided census is treated as empty', from: 'counted?.hasPopulation.value', to: '(counted?.hasPopulation.value ?? false)', fails: 'unknown-cargo-category' },
  { name: 'a readable census decision is discarded', from: 'counted?.hasPopulation.value', to: 'null', fails: 'readable-cargo-lower-bound' },
  { name: 'a decided empty census is treated as populated', from: 'counted?.hasPopulation.value', to: 'true', fails: 'decisive-berth-zero' },
  { name: 'a zero installation amount creates a type gap', from: 'if (installation.Amount === 0)', to: 'if (false)', fails: 'zero-installation' },
  { name: 'a missing automatic-assignment flag obscures zero room', from: 'if (availableRoom !== 0)', to: 'if (availableRoom !== 0 || !isKnownNumber(project.AssignNew))', fails: 'zero-administration-room' },
  { name: 'idle capacity keeps fractions', from: 'capacity.Labs = wholeCount(capacity.Labs)', to: 'capacity.Labs = decimal.toNumber(capacity.Labs)', fails: 'idle-whole' },
  { name: 'idle capacity ignores ResearchValue weighting', from: 'decimal.multiply(decimal.fromDouble(installation.Amount), value)', to: 'decimal.fromDouble(installation.Amount)', fails: 'idle-whole' },
  { name: 'project capacity keeps fractions', from: 'capacity.Labs = wholeCount(capacity.Labs)', to: 'capacity.Labs = decimal.toNumber(capacity.Labs)', fails: 'project-whole' },
  { name: 'project capacity ignores ResearchValue weighting', from: 'decimal.multiply(decimal.fromDouble(installation.Amount), value)', to: 'decimal.fromDouble(installation.Amount)', fails: 'project-whole' },
  { name: 'research weighted capacity uses binary products and sums', from: 'capacity.Labs = decimal.add(capacity.Labs, decimal.multiply(decimal.fromDouble(installation.Amount), value))', to: 'capacity.Labs = decimal.fromString(String(decimal.toNumber(capacity.Labs) + installation.Amount * installation.ResearchValue))', fails: 'decimal-capacity' },
  { name: 'the dead-project capacity uses binary products and sums', from: 'capacity.Labs = decimal.add(capacity.Labs, decimal.multiply(decimal.fromDouble(installation.Amount), value))', to: 'capacity.Labs = decimal.fromString(String(decimal.toNumber(capacity.Labs) + installation.Amount * installation.ResearchValue))', fails: 'project-whole' },
  { name: 'administration limit keeps fractions', from: 'const availableRoom = isCount(admin) && isCount(project.Facilities) ? Math.max(0, admin - project.Facilities) : null', to: 'const availableRoom = isCount(admin) && isCount(project.Facilities) ? Math.max(0, project.Admin - project.Facilities) : null', fails: 'allocation-limits' },
  { name: 'administration bonus skips three-place loading round', from: 'wholeCount(decimal.round(decimal.fromDouble(project.Admin), 3))', to: 'Math.trunc(project.Admin)', fails: 'numeric-intake' },
  { name: 'unknown administration is read as zero', from: 'population.AllocationGaps = population.ProcessingGaps || (entry !== 0 && room.gaps && used < population.AvailableFacilities)', to: 'population.AllocationGaps = false', fails: 'missing-allocation' },
  { name: 'the inventory implies required player action', from: 'This is an assignment inventory, not a claim that player action is required: the game can assign free labs automatically before research advances.', to: 'It makes no progress until the player acts.', fails: 'snapshot' },
]

const main = async () => {
  const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7)
  const cases = CASES.filter((one) => !only || one.name === only)

  assert.ok(cases.length > 0, 'the selected case exists')

  const load = (source) => loadUtilities(['warnings/research', 'provenance'], { stubs: STUBS, sources: { 'warnings/research': source } })
  const modules = await load(original)

  for (const one of cases) {
    await one.run(modules)
    console.log(`PASS ${one.name}`)
  }

  if (mutating() && !only) {
    for (const fault of FAULTS) {
      const mutant = await load(plantedPatch(file, original, fault.from, fault.to))
      let caught = false

      try {
        await CASES.find((one) => one.name === fault.fails).run(mutant)
      } catch (error) {
        if (error.code !== 'ERR_ASSERTION') {
          throw error
        }

        caught = true
      }

      assert.ok(caught, `the planted fault is caught by a wrong figure: ${fault.name}`)
      console.log(`PASS mutant: ${fault.name}`)
    }
  }

  console.log(`${cases.length} of ${cases.length} research warning checks passed`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
