/* Industrial demand, effective installations and retained mining claims. Run with bun scripts/check-industry-capacity.js [--no-mutations]. */
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadModules, instantiate } = require('./lib/page-loader')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const MODULE_STUBS = { 'components/charts/theme': 'export const chartTheme = () => ({}); export const flowColor = () => ""; export const withAlpha = (color) => color; export const chartFont = () => ({}); export const seriesIdentity = () => ({ dash: [] })' }
const NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const minerals = (value) => Object.fromEntries(NAMES.map((name) => [name, value]))
const project = (ProjectID, extra = {}) => ({ ProjectID, PopulationID: 1, ProductionType: 0, Percentage: 50, Queue: 0, Pause: 0, Amount: 100, ProdPerUnit: 1, ...minerals(0), Duranium: 1, ...extra })
const withIndustrialDatabase = async (runCase) => {
  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(':memory:')
  const exec = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => error ? reject(error) : resolve()))
  const query = (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => error ? reject(error) : resolve([rows])))

  try {
    await exec(`
      create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, ConstructionValue real, OrdnanceProductionValue real, FighterProductionValue real, GroundTrainingValue real, ResearchValue real);
      create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, Population real, Efficiency real, SystemBodyID integer, SystemID integer);
      create table FCT_PopulationInstallations (PopID integer, PlanetaryInstallationID integer, Amount real, GameID integer);
      create table FCT_IndustrialProjects (ProjectID integer, GameID integer, RaceID integer, PopulationID integer, Queue integer, ProductionType integer, Percentage real, Pause integer, Amount real, ProdPerUnit real, ${NAMES.map((name) => `${name} real`).join(', ')});
      create table FCT_GroundUnitTraining (PopulationID integer, GameID integer, RaceID integer, TaskPercentage real);
      create table FCT_GroundUnitTrainingQueue (PopulationID integer, GameID integer);
      create table FCT_ResearchProject (PopulationID integer, RaceID integer, Facilities real);
      create table FCT_Shipyard (PopulationID integer, RaceID integer, ShipyardID integer, Slipways real);
      create table FCT_ShipyardTask (ShipyardID integer);
      create table FCT_SystemBody (SystemBodyID integer, PlanetNumber integer, OrbitNumber integer, BodyClass integer, StarID integer);
      create table FCT_SystemBodyName (SystemBodyID integer, RaceID integer, Name text);
      create table FCT_RaceSysSurvey (SystemID integer, RaceID integer, Name text);
      create table FCT_Star (StarID integer, ComponentNumber integer);
      insert into DIM_PlanetaryInstallation values (1,1,0,0,0,0),(2,0.5,0,0,0,0),(3,0,1,0,0,0),(4,0,0,1,0,0),(17,0,0,0,7,0),(18,0,0,0,99,0);
      insert into FCT_Population values ${Array.from({ length: 9 }, (_, index) => `(${index + 1},1,1,'Colony ${index + 1}',10,0.5,1,1)`).join(',')};
      insert into FCT_PopulationInstallations values (1,1,0.9,1),(1,17,0.9,1),(2,1,1.5,1),(2,17,1.5,1),(3,2,1.5,1),(4,18,10,1),(5,17,null,1),(6,17,0,1),(7,3,1.5,1),(8,4,0.9,1),(9,4,1.5,1);
    `)
    return await runCase({ query }, exec)
  } finally {
    await new Promise((resolve, reject) => raw.close((error) => error ? reject(error) : resolve()))
  }
}
const CASES = [
  ['retained-decline', (m) => {
    const p = m['utilities/provenance']
    for (const id of ['mineral.depositForecast', 'mineral.stockProjection']) {
      const rule = p.getRule(id)
      assert.deepEqual(rule.versions, ['2.7.x'])
      assert.equal(rule.verification, 'estimated')
      assert.ok(/continuous/.test(rule.note) && /mining capability/.test(rule.note) && /per-increment/.test(rule.note) && /no proven error bound/.test(rule.note))
    }
    const state = m['utilities/minerals'].depositStateAt({ Amount: 50, Accessibility: 1, HalfOriginalAmount: 50, OriginalAcc: 1 }, 1, 0.2)
    assert.ok(Math.abs(state.amount - 49.8003595683885) < 1e-12)
    assert.ok(Math.abs(state.amount - 49.8) > 0.0003)
    const help = JSON.stringify(m['utilities/glossary'].helpFor('/mineral-outlook'))
    assert.ok(/continuous/.test(help) && /no proven error bound/.test(help))
  }],
  ['queue-page-read', async (m) => withIndustrialDatabase(async (database, exec) => {
    for (const row of [project(1), project(2, { Amount: 10 }), project(3, { Percentage: 100, Queue: 1 }), project(4, { Pause: 1 })]) {
      const fields = { ...row, GameID: 1, RaceID: 1 }
      await exec(`insert into FCT_IndustrialProjects (${Object.keys(fields).join(',')}) values (${Object.values(fields).join(',')})`)
    }
    const vm = instantiate(m['pages/mineral-outlook'].default, { database, GameID: 1, RaceID: 1, $store: { getters: { 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }, data: { populationProductionModifiers: { 1: { ConstructionProduction: 100, OverallProductionModifier: 1, ConstructionPower: 1, GroundConstructionPower: 0, MinConstructionPeriod: 15768000 } } } })
    const rows = await vm.runAsync('industrialProjects')
    assert.equal(rows.length, 4)
    assert.equal(rows.find((row) => row.ProjectID === 4).Pause, 1)
    assert.equal(vm.queueDemand.demand.Duranium, 60)
  })],
  ['installation-queries', async (m) => withIndustrialDatabase(async (database) => {
    const vm = instantiate(m['pages/production'].default, { database, GameID: 1, RaceID: 1, $store: { getters: { 'capabilities/report': () => null }, state: {}, dispatch: async () => {} } })
    const rows = await vm.runAsync('colonyFacilities')
    assert.equal(m['utilities/production'].trainingCapacity({ OverallGroundUnitModifier: 10 }, rows.find((row) => row.PopulationID === 2)).value, 10)
    assert.equal(rows.find((row) => row.PopulationID === 4).TrainingFacilities, 0)
    assert.equal(vm.gfccCount(2), 1)
    const read = (key) => m['utilities/warnings/industry'].checks.find((check) => check.key === key).read({ database, GameID: 1, RaceID: 1, count: String })
    const construction = await read('free-construction-capacity')
    assert.deepEqual(construction.map((row) => row.id), ['colony:2'])
    assert.equal(construction[0].cells.installations, '1')
    assert.deepEqual((await read('free-ordnance-capacity')).map((row) => row.id), ['colony:7'])
    assert.deepEqual((await read('free-fighter-capacity')).map((row) => row.id), ['colony:9'])
    const training = await read('idle-ground-training')
    assert.deepEqual(training.map((row) => row.id).sort(), ['colony:2', 'colony:5'])
    assert.equal(training.find((row) => row.id === 'colony:2').cells.staffed, '0.5')
    assert.ok(training.find((row) => row.id === 'colony:5').unevaluated)
  })],
  ['decimal-factory-queries', async (m) => withIndustrialDatabase(async (database, exec) => {
    await exec(`
      delete from FCT_PopulationInstallations;
      delete from FCT_Population;
      delete from DIM_PlanetaryInstallation;
      insert into DIM_PlanetaryInstallation values (1,1,1,1,0,0),(2,0.5,0.5,0.5,0,0),(3,0.9999999999999999,0.9999999999999999,0.9999999999999999,0,0),(4,null,null,null,0,0),${Array.from({ length: 10 }, (_, index) => `(${index + 20},1,1,1,0,0)`).join(',')};
      insert into FCT_Population values ${Array.from({ length: 19 }, (_, index) => `(${index + 1},1,1,'Colony ${index + 1}',10,1,1,1)`).join(',')};
      insert into FCT_PopulationInstallations values (1,1,0.9999999999999999,1),(2,1,0.9,1),(3,1,1,1),(4,1,1.5,1),(5,3,1,1),${Array.from({ length: 10 }, (_, index) => `(6,${index + 20},0.1,1)`).join(',')},(7,1,null,1),(8,4,1,1),(9,1,1,1),(9,4,1,1),(10,1,1,1),(10,2,null,1),(11,1,1,1),(12,1,1,1),(13,1,1,1),(14,1,1,1),(15,1,1,1),(16,1,1,1),(17,4,1,1),(18,999,1,1),(19,2,1.5,1);
    `)
    for (const [key, type] of [['free-construction-capacity', 0], ['free-ordnance-capacity', 1], ['free-fighter-capacity', 2]]) {
      await exec(`
        delete from FCT_IndustrialProjects;
        insert into FCT_IndustrialProjects (ProjectID,GameID,RaceID,PopulationID,Queue,ProductionType,Percentage) values (11,1,1,11,0,${type},null),(12,1,1,12,null,${type},50),(13,1,1,13,0,null,50),(14,1,1,14,0,${type},100),(15,1,1,15,0,${type},99.99997),(16,1,1,16,0,${type},99.9999),(17,1,1,17,0,${type},100);
      `)
      const rows = await m['utilities/warnings/industry'].checks.find((check) => check.key === key).read({ database, GameID: 1, RaceID: 1, count: String })
      const ids = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, ...(type === 0 ? [] : [15]), 16, 18]
      assert.deepEqual(rows.map((row) => row.id), ids.map((id) => `colony:${id}`), key)
      for (const id of [1, 3, 4, 5, 6, 16]) {
        const row = rows.find((row) => row.id === `colony:${id}`)
        assert.equal(row.cells.installations, '1', `${key}: decimal whole category at colony ${id}`)
        assert.ok(!row.unevaluated, `${key}: known capacity at colony ${id}`)
      }
      assert.equal(rows.find((row) => row.id === 'colony:1').cells.free, '100%')
      for (const id of [7, 8, 18]) {
        const row = rows.find((row) => row.id === `colony:${id}`)
        assert.ok(row.unevaluated, `${key}: unread count at colony ${id}`)
        assert.ok(row.cells.installations.result, `${key}: unread count is not zero at colony ${id}`)
      }
      for (const id of [9, 10]) {
        const row = rows.find((row) => row.id === `colony:${id}`)
        assert.ok(!row.unevaluated, `${key}: known subtotal proves productive presence at colony ${id}`)
        assert.ok(row.cells.installations.result, `${key}: productive presence does not fill a count gap at colony ${id}`)
      }
      for (const id of [11, 12, 13]) assert.ok(rows.find((row) => row.id === `colony:${id}`).unevaluated, `${key}: unread project input at colony ${id}`)
    }
  })],
  ['decimal-training-query', async (m) => withIndustrialDatabase(async (database, exec) => {
    await exec(`
      delete from FCT_PopulationInstallations;
      delete from FCT_Population;
      insert into FCT_Population values ${Array.from({ length: 12 }, (_, index) => `(${index + 1},1,1,'Colony ${index + 1}',10,1,1,1)`).join(',')};
      insert into FCT_PopulationInstallations values (1,17,0.9999999999999999,1),(2,17,0.9,1),(3,17,1,1),(4,17,1.5,1),(5,17,null,1),(6,17,1,1),(7,17,1,1),(8,17,1,1),(9,17,1,1),(10,null,1,1),(11,17,1,1),(12,17,1,1);
      update FCT_Population set Population = 0 where PopulationID = 6;
      update FCT_Population set Efficiency = null where PopulationID = 7;
      update FCT_Population set Population = null where PopulationID = 9;
      insert into FCT_GroundUnitTraining values (8,1,1,null),(11,1,1,100),(12,1,1,50);
    `)
    const rows = await m['utilities/warnings/industry'].checks.find((check) => check.key === 'idle-ground-training').read({ database, GameID: 1, RaceID: 1, count: String })
    assert.deepEqual(rows.map((row) => row.id).sort(), [1, 3, 4, 5, 7, 8, 9, 10, 12].map((id) => `colony:${id}`).sort())
    for (const id of [1, 3, 4]) {
      const row = rows.find((row) => row.id === `colony:${id}`)
      assert.equal(row.cells.staffed, '1')
      assert.equal(row.cells.idle, '1')
      assert.ok(!row.unevaluated)
    }
    assert.equal(rows[0].id, 'colony:1')
    assert.equal(rows.find((row) => row.id === 'colony:1').cells.installed, '0.9999999999999999')
    assert.equal(rows.find((row) => row.id === 'colony:4').cells.installed, '1.5')
    assert.equal(rows.find((row) => row.id === 'colony:12').cells.idle, '0.5')
    for (const id of [5, 7, 8, 9, 10]) assert.ok(rows.find((row) => row.id === `colony:${id}`).unevaluated, `unread training input at colony ${id}`)
    assert.ok(rows.find((row) => row.id === 'colony:5').cells.staffed.result)
  })],
  ['effective-training', (m) => {
    const production = m['utilities/production']
    const capacity = production.trainingCapacity({ OverallGroundUnitModifier: 10 }, { TrainingFacilities: 1.5 })
    assert.equal(capacity.value, 10)
    assert.equal(production.trainingCapacity({ OverallGroundUnitModifier: 10 }, { TrainingFacilities: 0.9 }).value, 0)
    const rate = production.trainingRate(capacity, { TaskPercentage: 40 })
    assert.equal(rate.value, 4)
    assert.equal(production.freeCapacity(capacity, { used: 40, missing: [] }).free.value, 6)
    assert.equal(production.finishDays({ rule: 'production.trainingFinish', rate, remaining: -1, remainingName: 'the remaining training' }).result.value, 91.25)
  }],
  ['whole-share-queue', (m) => {
    const demand = m['utilities/minerals'].annualQueueDemand
    const jobs = [project(1), project(2, { Amount: 10 }), project(3, { Percentage: 100, Queue: 1 })]
    assert.equal(demand(jobs, () => 100, () => 15768000).demand.Duranium, 60)
    assert.equal(demand([project(3, { Percentage: 100, Queue: 1 })], () => 100, () => 15768000).demand.Duranium, 0)
    const tiny = [project(1, { Percentage: 100 })]
    assert.equal(demand(tiny, () => 0.00012, () => 15768000).demand.Duranium, 0)
    assert.equal(demand([project(1, { Percentage: 100 })], () => 100, () => 17280000).demand.Duranium, 54.7945)
    assert.equal(demand(jobs, () => 100, () => 31536001).demand.Duranium, 0)
    assert.equal(demand([project(1, { Percentage: 100 })], () => 100, () => 3946215).demand.Duranium, 87.5931)
    assert.ok(demand(jobs, () => 100, () => null).incomplete.Duranium.some((input) => /construction period/.test(input)))
    assert.ok(demand([project(1, { Pause: null })], () => 100, () => 15768000).incomplete.Duranium.some((input) => /pause/.test(input)))
    assert.ok(demand([project(null)], () => 100, () => 15768000).incomplete.Duranium.some((input) => /identity/.test(input)))
  }],
]
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'count an extra increment at a floating horizon boundary', target: 'utilities/minerals', from: 'horizonDays: (cycles - 0.5) * cycleDays', to: 'horizonDays: cycles * cycleDays', fails: 'whole-share-queue' },
  { name: 'start queued work without a completion', target: 'utilities/minerals', from: 'Queue: project.Queue', to: 'Queue: 0', fails: 'whole-share-queue' },
  { name: 'apply an annual rather than per-increment floor', target: 'utilities/minerals', from: '      cycleDays,', to: '      cycleDays: 365,', fails: 'whole-share-queue' },
  { name: 'ignore paused shares and builds', target: 'utilities/minerals', from: 'Paused: Boolean(project.Pause)', to: 'Paused: false', fails: 'queue-page-read' },
  { name: 'default an unread construction period', target: 'utilities/minerals', from: 'periodOf(group[0].PopulationID) : null', to: '(periodOf(group[0].PopulationID) || 31536000) : 31536000', fails: 'whole-share-queue' },
  { name: 'accept an unread project identity', target: 'utilities/minerals', from: "['ProjectID', 'identity'], ", to: '', fails: 'whole-share-queue' },
  { name: 'accept an unread pause flag', target: 'utilities/minerals', from: "['Pause', 'pause state'], ", to: '', fails: 'whole-share-queue' },
  { name: 'use fractional training complexes', target: 'utilities/production', from: 'Math.floor(facilities.TrainingFacilities)', to: 'facilities.TrainingFacilities', fails: 'effective-training' },
  { name: 'read a different installation as a GFCC', target: 'utilities/production', from: 'export const GFCC_INSTALLATION = 17', to: 'export const GFCC_INSTALLATION = 18', fails: 'installation-queries' },
  { name: 'count an unrelated training-value installation', target: 'pages/production', from: 'FCT_PopulationInstallations.PlanetaryInstallationID = ${GFCC_INSTALLATION} then FCT_PopulationInstallations.Amount', to: 'FCT_PopulationInstallations.PlanetaryInstallationID > 0 then FCT_PopulationInstallations.Amount', fails: 'installation-queries' },
  { name: 'lose the saved pause flag in the actual query', target: 'pages/mineral-outlook', from: 'FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause, FCT_IndustrialProjects.Amount', to: 'FCT_IndustrialProjects.Queue, null as Pause, FCT_IndustrialProjects.Amount', fails: 'queue-page-read' },
  { name: 'retain fractional productive factory totals', target: 'utilities/warnings/industry', from: 'wholeCapacity(null, population.CapacityTerms)', to: 'JSON.parse(population.CapacityTerms).reduce((total, term) => total + (term === null ? 0 : Number(term[0]) * Number(term[1])), 0)', fails: 'installation-queries' },
  { name: 'omit factory category weights', target: 'utilities/warnings/industry', from: 'capacityTerms(`DIM_PlanetaryInstallation.${value}`,', to: "capacityTerms('1',", fails: 'installation-queries' },
  { name: 'staff raw rather than whole complexes', target: 'utilities/warnings/industry', from: 'wholeCapacity(population.Installed)', to: 'population.Installed', fails: 'installation-queries' },
  { name: 'truncate binary factory totals before decimal conversion', target: 'utilities/warnings/industry', from: 'wholeCapacity(null, population.CapacityTerms)', to: 'Math.trunc(JSON.parse(population.CapacityTerms).reduce((total, term) => total + (term === null ? 0 : Number(term[0]) * Number(term[1])), 0))', fails: 'decimal-factory-queries' },
  { name: 'truncate binary GFCC amounts before decimal conversion', target: 'utilities/warnings/industry', from: 'wholeCapacity(population.Installed)', to: 'Math.trunc(population.Installed)', fails: 'decimal-training-query' },
]
/* eslint-enable no-template-curly-in-string */
const MODULES = ['utilities/minerals', 'utilities/production', 'utilities/mineral-outlook', 'utilities/provenance', 'utilities/warnings/industry', 'pages/production', 'pages/mineral-outlook', 'utilities/glossary']
const failuresOf = async (m) => {
  const failures = []
  for (const [name, run] of CASES) {
    try { await run(m) } catch (error) { failures.push({ name, message: error.message, assertion: error.code === 'ERR_ASSERTION' }) }
  }
  return failures
}
const main = async () => {
  const head = await failuresOf(await loadModules(MODULES, { stubs: STUBS, modules: MODULE_STUBS }))
  let failures = head.length
  let checks = CASES.length
  CASES.forEach(([name]) => console.log(`${head.some((entry) => entry.name === name) ? 'FAIL' : 'PASS'}  ${name}`))
  head.forEach((entry) => console.log(entry.message))
  for (const fault of mutating() ? FAULTS : []) {
    refusePlanting(fault.name)
    const text = fs.readFileSync(path.join(__dirname, '../src/renderer', `${fault.target}${fault.target.startsWith('pages/') ? '.vue' : '.js'}`), 'utf8')
    const parts = text.split(fault.from)
    assert.equal(parts.length, 2, fault.name)
    const broken = await failuresOf(await loadModules(MODULES, { stubs: STUBS, modules: MODULE_STUBS, sources: { [fault.target]: parts.join(fault.to) } }))
    const caught = !head.length && broken.some((entry) => entry.name === fault.fails && entry.assertion)
    checks++
    if (!caught) failures++
    console.log(`${caught ? 'PASS' : 'FAIL'}  caught ${fault.name}`)
  }
  console.log(`${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}
main().catch((error) => { console.error(error); process.exit(1) })
