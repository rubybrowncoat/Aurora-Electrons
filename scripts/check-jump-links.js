/*
  Checks that every read of a jump link goes through a jump point the race has explored, from either end (src/renderer/utilities/jump-graph.js: loadJumpPoints, jumpLinks and loadJumpLinks; the System view's read, utilities/system-jump-points.js, is checked by scripts/check-system-jump-points.js; the naval admin chain of utilities/naval-admins.js; the links of pages/survey-progress.vue and the order read of pages/hauling.vue), and that a charted point the race has not explored keeps its identity with no link.

  Run: bun scripts/check-jump-links.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The expected values are written here from the rule of the game (a race knows the far side of a point it has explored, and an explored point is explored at both ends), in SQL over the save and in a constructed save, never from the module under test:
  - Falryx (artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db, game 141): for each of the seven races the rows of every reader equal the ones the survey rows give. Race 789 (Ancients) has charted 150 points and explored none, so every reader finds 0 links where the charted-only reading drew 44 pairs of systems; race 791 has 84 charted points it has not explored, which the charted-only reading linked 4 times over.
  - A constructed save holds the cases the save does not: a point explored from the far end only, a point whose far point is not charted, one whose far point lies in a system the race does not know, and a far point that is explored but not charted.
  Every planted fault must fail the checks it names by a wrong value, never because a call threw (scripts/lib/fault-credit.js), and each rewrite that says the same thing must leave every check passing.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { runSuite } = require('./lib/suite-runner')
const { HarnessError } = require('./lib/browser-observe')
const { assert, subjectModule, runChecks, judged, caughtAll, notCaught, boundary } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const SAVE = 'artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db'
const GAME = 141
const RACES = [785, 786, 787, 788, 789, 790, 791]
const ANCIENTS = 789
const PLAYER = 791
const UTILITIES = path.join(root, 'src', 'renderer', 'utilities')
const GRAPH = path.join(UTILITIES, 'jump-graph.js')
const ADMINS = path.join(UTILITIES, 'naval-admins.js')
const SURVEY = path.join(root, 'src', 'renderer', 'pages', 'survey-progress.vue')
const HAULING = path.join(root, 'src', 'renderer', 'pages', 'hauling.vue')
const DETAIL = process.argv.includes('--detail')

const STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
}
const LOAD_STATE = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
const memo = (make) => {
  let made = null

  return () => made || (made = make())
}
const VIEW_MODULE = `
  export const oneOf = (values) => (value) => values.includes(value)
  export const tableView = (key, defaults) => ({ key, default: defaults })
  export default (fields) => ({ fields, data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) })
`

// ---------- the expected values, from the survey rows ----------

const adapter = (db) => ({ query: async (sql) => [db.query(sql).all()] })

// The rule of the game, over the raw rows of a race: a point is read when the race has charted it in a system it knows; its link is known when the race has explored it or the point it leads to (charted too); the pairs are the readable points whose far point is readable.
const expectation = (db, raceId, gameId = GAME) => {
  const known = new Set(db.query(`select SystemID from FCT_RaceSysSurvey where RaceID = ${raceId} and GameID = ${gameId}`).all().map((row) => row.SystemID))
  const survey = new Map(db.query(`select WarpPointID, Charted, Explored from FCT_RaceJumpPointSurvey where RaceID = ${raceId}`).all().map((row) => [row.WarpPointID, row]))
  const names = new Map(db.query(`select SystemID, Name from FCT_RaceSysSurvey where RaceID = ${raceId} and GameID = ${gameId}`).all().map((row) => [row.SystemID, row.Name]))
  const points = new Map(db.query(`select WarpPointID, SystemID, WPLink, Xcor, Ycor from FCT_JumpPoint where GameID = ${gameId}`).all().map((row) => [row.WarpPointID, row]))
  const read = new Map([...points].filter(([id, point]) => survey.has(id) && survey.get(id).Charted === 1 && known.has(point.SystemID)))
  const chartedFar = (point) => {
    const far = survey.get(point.WPLink)

    return far && far.Charted === 1 ? far : null
  }
  const linkOf = (point) => (survey.get(point.WarpPointID).Explored === 1 || (chartedFar(point) && chartedFar(point).Explored === 1) ? point.WPLink : null)
  const pairs = (linked) => [...read.values()].filter((point) => read.has(linked(point))).map((point) => `${point.SystemID}>${read.get(linked(point)).SystemID}`).sort()

  return {
    read,
    survey,
    points,
    names,
    known,
    linkOf,
    pairs: pairs(linkOf),
    chartedPairs: pairs((point) => point.WPLink),
  }
}

// The pairs of systems a list of directed pairs joins, each counted once.
const joined = (pairs) => new Set(pairs.map((pair) => pair.split('>').map(Number).sort((a, b) => a - b).join('-'))).size

const pairsOf = (rows) => rows.map((row) => `${row.SystemID}>${row.DestinationID}`).sort()

// The systems a system reaches over the pairs, however many jumps.
const componentOf = (pairs, start) => {
  const reached = new Set([start])
  let grew = true

  while (grew) {
    grew = false
    pairs.forEach((pair) => {
      const [from, to] = pair.split('>').map(Number)

      if (reached.has(from) && !reached.has(to)) {
        reached.add(to)
        grew = true
      }
    })
  }

  return reached
}

// ---------- a constructed save ----------

// Race 1 knows the systems 10 to 15 and not 17. Each pair is two points that lead to each other: 101-102 explored at both ends; 111-112 charted, explored at neither; 121-122 explored at the far end only; 131-132 explored at its own end with the far point not charted; 141-142 explored with the far point in a system the race does not know; 161-162 charted at one end with the far point explored and not charted. Race 2 knows 10 and 11 and has 101 charted, unexplored, with the far point 102 explored.
const FIXTURE_GAME = 1
const POINTS = [[101, 10, 102], [102, 11, 101], [111, 10, 112], [112, 12, 111], [121, 11, 122], [122, 13, 121], [131, 10, 132], [132, 14, 131], [141, 12, 142], [142, 17, 141], [161, 13, 162], [162, 14, 161]]
const NAMES = { 10: 'Alpha', 11: 'Beta', 12: 'Gamma', 13: 'Delta', 14: 'Epsilon', 15: 'Zeta' }
const SURVEYS = [[1, 101, 1, 1], [1, 102, 1, 1], [1, 111, 1, 0], [1, 112, 1, 0], [1, 121, 1, 0], [1, 122, 1, 1], [1, 131, 1, 1], [1, 141, 1, 1], [1, 142, 1, 1], [1, 161, 1, 0], [1, 162, 0, 1], [2, 101, 1, 0], [2, 102, 1, 1]]
const TARGETS = { 1: { read: [101, 102, 111, 112, 121, 122, 131, 141, 161], link: { 101: 102, 102: 101, 111: null, 112: null, 121: 122, 122: 121, 131: 132, 141: 142, 161: null }, pairs: ['10>11', '11>10', '11>13', '13>11'] }, 2: { read: [101, 102], link: { 101: 102, 102: 101 }, pairs: ['10>11', '11>10'] } }

const constructed = () => {
  const db = new Database(':memory:')

  db.run('create table FCT_JumpPoint (WarpPointID integer, GameID integer, SystemID integer, Distance real, Bearing real, WPLink integer, Xcor real, Ycor real, JumpGateStrength integer, JumpGateRaceID integer)')
  db.run('create table FCT_RaceJumpPointSurvey (RaceID integer, GameID integer, WarpPointID integer, Charted integer, Explored integer, MilitaryRestricted integer, IgnoreForDistance integer, Hide integer, AlienUnits integer)')
  db.run('create table FCT_RaceSysSurvey (RaceID integer, GameID integer, SystemID integer, Name text)')
  POINTS.forEach(([id, system, link], at) => db.run(`insert into FCT_JumpPoint values (${id}, ${FIXTURE_GAME}, ${system}, ${at + 1}, ${at}, ${link}, ${at * 1000}, ${at * 10}, ${id === 101 ? 1000 : 0}, ${id === 101 ? 7 : 0})`))
  SURVEYS.forEach(([race, id, charted, explored]) => db.run(`insert into FCT_RaceJumpPointSurvey values (${race}, ${FIXTURE_GAME}, ${id}, ${charted}, ${explored}, 0, 0, 0, 0)`))
  Object.entries(NAMES).forEach(([system, name]) => db.run(`insert into FCT_RaceSysSurvey values (1, ${FIXTURE_GAME}, ${system}, '${name}')`))
  ;[10, 11].forEach((system) => db.run(`insert into FCT_RaceSysSurvey values (2, ${FIXTURE_GAME}, ${system}, '${NAMES[system]}2')`))

  return db
}

// Rows as loadJumpPoints gives them, for the readers that take rows: the explored flag of each end and the link as the save holds it.
const ROWS = (explored, link = true) => [{ WarpPointID: 1, SystemID: 10, WPLink: link ? 2 : null, Explored: explored[0] }, { WarpPointID: 2, SystemID: 11, WPLink: link ? 1 : null, Explored: explored[1] }]

// ---------- the checks ----------

const readPoints = async (mod, db, raceId, gameId) => await mod['jump-graph'].loadJumpPoints(adapter(db), { GameID: gameId, RaceID: raceId })

const identityChecks = {
  id: 'identity',
  name: 'a charted point keeps its identity and has a link only when the race has explored it or the point it leads to',
  run: async ({ mod, save, fixture }) => {
    for (const race of RACES) {
      const expected = expectation(save, race)
      const rows = await readPoints(mod, save, race, GAME)

      assert.deepEqual(rows.map((row) => row.WarpPointID).sort((a, b) => a - b), [...expected.read.keys()].sort((a, b) => a - b), `race ${race}: the points read are the charted ones in known systems`)
      rows.forEach((row) => {
        const point = expected.read.get(row.WarpPointID)

        assert.equal(row.SystemID, point.SystemID, `race ${race}, point ${row.WarpPointID}: its system`)
        assert.equal(row.Xcor, point.Xcor, `race ${race}, point ${row.WarpPointID}: its position`)
        assert.equal(row.Explored, expected.survey.get(row.WarpPointID).Explored, `race ${race}, point ${row.WarpPointID}: its explored flag`)
        assert.equal(row.WPLink, expected.linkOf(point), `race ${race}, point ${row.WarpPointID}: the link it names`)
      })
    }

    const ancients = await readPoints(mod, save, ANCIENTS, GAME)

    assert.equal(ancients.length, 150, 'the Ancients have charted 150 points')
    assert.equal(ancients.filter((row) => row.WPLink !== null).length, 0, 'the Ancients have explored none, so none of the 150 names a link')

    for (const race of [1, 2]) {
      const rows = await readPoints(mod, fixture, race, FIXTURE_GAME)

      assert.deepEqual(rows.map((row) => row.WarpPointID).sort((a, b) => a - b), TARGETS[race].read, `constructed race ${race}: the points read`)
      rows.forEach((row) => assert.equal(row.WPLink, TARGETS[race].link[row.WarpPointID], `constructed race ${race}, point ${row.WarpPointID}: the link it names`))
    }
  },
}

const linksChecks = {
  id: 'links',
  name: 'the links drawn from the points read are the explored ones, and a point explored neither way draws none',
  run: async ({ mod, save, fixture }) => {
    for (const race of RACES) {
      const expected = expectation(save, race)
      const rows = await readPoints(mod, save, race, GAME)

      assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(rows)), expected.pairs, `race ${race}: the links of the points read`)
    }

    const ancients = expectation(save, ANCIENTS)

    assert.equal(ancients.pairs.length, 0, 'the explored rule gives the Ancients 0 links')
    assert.equal(pairsOf(mod['jump-graph'].jumpLinks(await readPoints(mod, save, ANCIENTS, GAME))).length, 0, 'and none is drawn')
    assert.equal(joined(ancients.chartedPairs), 44, 'where reading every charted link gave 44 pairs of systems')

    const player = expectation(save, PLAYER)

    assert.equal(joined(player.chartedPairs) - joined(player.pairs), 4, 'race 791 has 4 pairs of systems in the charted reading that the explored one leaves out')

    for (const race of [1, 2]) {
      assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(await readPoints(mod, fixture, race, FIXTURE_GAME))), TARGETS[race].pairs, `constructed race ${race}: the links`)
    }

    assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(ROWS([0, 0]))), [], 'two points that name each other, explored at neither end, draw no link')
    assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(ROWS([1, 1]))), ['10>11', '11>10'], 'explored at both ends, they draw it from each side')
    assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(ROWS([0, 1]))), ['10>11', '11>10'], 'explored at the far end only, the link is known from each side')
    assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(ROWS([1, 0]))), ['10>11', '11>10'], 'explored at its own end only, the link is known from each side')
    assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks(ROWS([1, 1], false))), [], 'a point that names no link draws none')
    assert.deepEqual(pairsOf(mod['jump-graph'].jumpLinks([{ WarpPointID: 1, SystemID: 10, WPLink: 2, Explored: 1 }])), [], 'a far point that is not read draws none')
  },
}

const directChecks = {
  id: 'direct',
  name: 'the links read straight from the save are the explored ones, the same pairs as the points give',
  run: async ({ mod, save, fixture }) => {
    for (const race of RACES) {
      const expected = expectation(save, race)
      const rows = await mod['jump-graph'].loadJumpLinks(adapter(save), { GameID: GAME, RaceID: race })

      assert.deepEqual(pairsOf(rows), expected.pairs, `race ${race}: the links read from the save`)
    }

    assert.equal((await mod['jump-graph'].loadJumpLinks(adapter(save), { GameID: GAME, RaceID: ANCIENTS })).length, 0, 'the Ancients have explored none, so the save gives them 0 links')

    for (const race of [1, 2]) {
      assert.deepEqual(pairsOf(await mod['jump-graph'].loadJumpLinks(adapter(fixture), { GameID: FIXTURE_GAME, RaceID: race })), TARGETS[race].pairs, `constructed race ${race}: the links read from the save`)
    }
  },
}

const adminChecks = {
  id: 'admins',
  name: 'the systems a naval admin command reaches are those the explored links reach',
  run: async ({ mod, save }) => {
    const expected = expectation(save, PLAYER)
    const commands = Object.values(await mod['naval-admins'].loadNavalAdmins(adapter(save), { GameID: GAME, RaceID: PLAYER, bonusId: 6, share: 'Industrial' }))
    const reach = (system) => componentOf(expected.pairs, system)

    assert.ok(commands.length > 0, 'the player has naval admin commands')
    assert.ok(commands.some((command) => command.Systems.size > 1), 'at least one reaches past its own system')
    commands.filter((command) => command.SystemID != null).forEach((command) => {
      const allowed = reach(command.SystemID)

      ;[...command.Systems].forEach((system) => assert.ok(allowed.has(system), `the command ${command.NavalAdminCommandID} reaches system ${system}, which the explored links do not lead to from system ${command.SystemID}`))
    })
  },
}

const surveyChecks = {
  id: 'survey',
  name: 'the links of the survey page are the explored ones',
  run: async ({ page, save }) => {
    for (const race of [ANCIENTS, PLAYER, 785]) {
      const vm = instantiate(page, { boundary, $store: { getters: {}, state: {} }, database: adapter(save), GameID: GAME, RaceID: race, data: { loadErrors: {} } })
      const links = await vm.runAsync('links')

      assert.deepEqual(pairsOf(links), expectation(save, race).pairs, `race ${race}: the links the page draws`)
    }
  },
}

// The orders of a repeating fleet that cross each charted point of a race, read as the Hauling page reads them: the point an order comes out at is the far point of the link, and only where the link is known. The orders sit in temporary tables of a second connection, over the save as it is.
const HAULING_STORE = { getters: { 'capabilities/result': {}, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} }
const HAULING_FLEET = 900000001

const haulingChecks = {
  id: 'hauling',
  name: 'the orders of the hauling page come out at the far side of a jump point only where the link is known',
  run: async ({ save, hauling }) => {
    const page = await hauling()
    const db = new Database(path.join(root, SAVE), { readonly: true })

    try {
      db.run('create temp table FCT_Fleet as select * from main.FCT_Fleet where 0')
      db.run('create temp table FCT_MoveOrders as select * from main.FCT_MoveOrders where 0')

      for (const race of [ANCIENTS, PLAYER, 785]) {
        const expected = expectation(save, race)
        const sent = []
        const vm = instantiate(page, { $store: HAULING_STORE, database: { query: async (sql) => { sent.push(sql); return [[]] } }, GameID: GAME, RaceID: race, data: { loadErrors: {} } })

        await vm.runAsync('orders')

        const sql = sent.find((text) => /FCT_MoveOrders/.test(text))

        assert.ok(sql, `race ${race}: the page reads the orders`)
        db.run('delete from temp.FCT_Fleet')
        db.run('delete from temp.FCT_MoveOrders')
        db.run(`insert into temp.FCT_Fleet (FleetID, GameID, RaceID, CycleMoves, ShippingLine) values (${HAULING_FLEET}, ${GAME}, ${race}, 1, 0)`)
        ;[...expected.read.values()].forEach((point, at) => db.run(`insert into temp.FCT_MoveOrders (MoveOrderID, GameID, RaceID, FleetID, MoveActionID, MoveOrder, StartSystemID, DestinationType, DestinationID, NewWarpPointID) values (${HAULING_FLEET + 1 + at}, ${GAME}, ${race}, ${HAULING_FLEET}, 1, ${at + 1}, ${point.SystemID}, 1, ${point.WarpPointID}, 0)`))

        const rows = db.query(sql).all()

        assert.equal(rows.length, expected.read.size, `race ${race}: an order for each point the race has charted`)
        rows.forEach((row) => {
          const link = expected.linkOf(expected.points.get(row.DestinationID))

          assert.equal(row.ExitDestinationID, link, `race ${race}, point ${row.DestinationID}: the point the order comes out at`)
          assert.equal(row.ExitSystemID, link == null ? null : expected.points.get(link).SystemID, `race ${race}, point ${row.DestinationID}: the system the order comes out in`)
        })

        if (race === ANCIENTS) {
          assert.ok(rows.length > 0 && rows.every((row) => row.ExitDestinationID == null), 'the race that has explored no point has no order coming out anywhere')
        } else {
          assert.ok(rows.some((row) => row.ExitDestinationID != null), `race ${race}: an order through an explored point comes out at its far side`)
        }
      }
    } finally {
      db.close()
    }
  },
}

const CHECKS = [identityChecks, linksChecks, directChecks, adminChecks, surveyChecks, haulingChecks]

// ---------- the faults and the rewrites ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new HarnessError(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

/* eslint-disable no-template-curly-in-string */
const OLD_LINKS = 'select FCT_JumpPoint.SystemID, VIR_Destination.SystemID as DestinationID from FCT_JumpPoint inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and FCT_RaceJumpPointSurvey.Charted = 1 inner join FCT_JumpPoint as VIR_Destination on VIR_Destination.WarpPointID = FCT_JumpPoint.WPLink inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = VIR_Destination.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID} where FCT_JumpPoint.GameID = ${GameID}'

const FAULTS = [
  { name: 'a charted point names its link whether or not it is explored', file: 'graph', change: swap('case when ${LINK_KNOWN_SQL} then FCT_JumpPoint.WPLink else null end as WPLink', 'FCT_JumpPoint.WPLink'), fails: ['identity'] },
  { name: 'the links of the points read draw a point that is explored at neither end', file: 'graph', change: swap(' && (jumpPoint.Explored || byId[jumpPoint.WPLink].Explored))', ')'), fails: ['links'] },
  { name: 'the links of the points read need the point\'s own end explored', file: 'graph', change: swap('(jumpPoint.Explored || byId[jumpPoint.WPLink].Explored)', 'jumpPoint.Explored'), fails: ['links'] },
  { name: 'the links read from the save include a point that is explored at neither end', file: 'graph', change: swap('where FCT_JumpPoint.GameID = ${GameID} and ${LINK_KNOWN_SQL}`)', 'where FCT_JumpPoint.GameID = ${GameID}`)'), fails: ['direct', 'admins', 'survey'] },
  { name: 'the links read from the save need the point\'s own end explored', file: 'graph', change: swap('where FCT_JumpPoint.GameID = ${GameID} and ${LINK_KNOWN_SQL}`)', 'where FCT_JumpPoint.GameID = ${GameID} and FCT_RaceJumpPointSurvey.Explored = 1`)'), fails: ['direct'] },
  { name: 'the link of a point is known only when its own end is explored', file: 'graph', change: swap('\'(FCT_RaceJumpPointSurvey.Explored = 1 or VIR_FarSurvey.Explored = 1)\'', '\'(FCT_RaceJumpPointSurvey.Explored = 1)\''), fails: ['identity', 'direct'] },
  { name: 'a far point that is not charted counts when it is explored', file: 'graph', change: swap('and VIR_FarSurvey.RaceID = ${RaceID} and VIR_FarSurvey.GameID = FCT_JumpPoint.GameID and VIR_FarSurvey.Charted = 1', 'and VIR_FarSurvey.RaceID = ${RaceID} and VIR_FarSurvey.GameID = FCT_JumpPoint.GameID'), fails: ['identity'] },
  { name: 'the naval admin chain links the points that are charted', file: 'admins', change: swap('const links = await loadJumpLinks(database, { GameID, RaceID })', `const links = await database.query(\`${OLD_LINKS}\`).then(([items]) => items)`), fails: ['admins'] },
  { name: 'the survey page links the points that are charted', file: 'survey', change: swap('return await loadJumpLinks(this.database, { GameID: this.GameID, RaceID: this.RaceID })', `const { GameID, RaceID } = this\n\n        return await this.database.query(\`${OLD_LINKS}\`).then(([items]) => Object.freeze(items))`), fails: ['survey'] },
  { name: 'the hauling page follows the saved link of a transit order whether or not it is explored', file: 'hauling', change: swap('else (case when VIR_ExitSurvey.Explored = 1 or VIR_ExitFar.Explored = 1 then VIR_Exit.WPLink else null end) end', 'else VIR_Exit.WPLink end'), fails: ['hauling'] },
]

// Rewrites that say the same thing: a parenthesised condition with its operands turned about, a where clause with its terms in another order, and a known-link test spelled with coalesce.
const BENIGN = [
  { name: 'the condition of a link in the points read parenthesised, its operands turned about', file: 'graph', change: swap('byId[jumpPoint.WPLink] && (jumpPoint.Explored || byId[jumpPoint.WPLink].Explored)', '(byId[jumpPoint.WPLink]) && ((byId[jumpPoint.WPLink].Explored || jumpPoint.Explored))') },
  { name: 'the where clause of the links read from the save with its terms turned about', file: 'graph', change: swap('where FCT_JumpPoint.GameID = ${GameID} and ${LINK_KNOWN_SQL}`)', 'where ${LINK_KNOWN_SQL} and (FCT_JumpPoint.GameID = ${GameID})`)') },
  { name: 'the known-link test spelled with coalesce', file: 'graph', change: swap('\'(FCT_RaceJumpPointSurvey.Explored = 1 or VIR_FarSurvey.Explored = 1)\'', '\'(coalesce(VIR_FarSurvey.Explored, 0) = 1 or coalesce(FCT_RaceJumpPointSurvey.Explored, 0) = 1)\'') },
  { name: 'the hauling page tests the far end of a transit order before its own', file: 'hauling', change: swap('VIR_ExitSurvey.Explored = 1 or VIR_ExitFar.Explored = 1', 'VIR_ExitFar.Explored = 1 or VIR_ExitSurvey.Explored = 1') },
]
/* eslint-enable no-template-curly-in-string */

const FILES = { graph: GRAPH, admins: ADMINS, survey: SURVEY, hauling: HAULING }

// ---------- a run of the checks over the sources as they are, or with `change` made to one of them ----------

const texts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))
let SAVE_DB = null
let FIXTURE_DB = null

const results = async (variant, ids) => {
  const given = { ...texts }

  if (variant) {
    given[variant.file] = variant.change(texts[variant.file])
  }

  const loaded = await loadUtilities(['jump-graph', 'naval-admins'], { sources: { 'jump-graph': given.graph, 'naval-admins': given.admins } })
  const page = await loadPage('pages/survey-progress', { sources: { 'pages/survey-progress': given.survey, 'utilities/jump-graph': given.graph, 'utilities/naval-admins': given.admins }, stubs: STUBS, modules: { 'mixins/load-state': null, 'mixins/persisted-view': VIEW_MODULE } })
  const hauling = memo(() => loadPage('pages/hauling', { sources: { 'pages/hauling': given.hauling }, modules: { 'mixins/load-state': LOAD_STATE } }))
  const mod = { 'jump-graph': subjectModule(loaded['jump-graph'], 'utility'), 'naval-admins': subjectModule(loaded['naval-admins'], 'utility') }

  SAVE_DB = SAVE_DB || new Database(path.join(root, SAVE), { readonly: true })
  FIXTURE_DB = FIXTURE_DB || constructed()

  return await runChecks(CHECKS.filter(({ id }) => !ids || ids.includes(id)), { mod, save: SAVE_DB, fixture: FIXTURE_DB, page, hauling })
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

  judged(found, 'the sources')
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

// The deadline of a variant, in seconds: it loads the modules and the page once and runs each check over the save.
const DEADLINE = 180

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the readers of jump links as they are', head: true, heading: 'The jump link readers (utilities/jump-graph.js, utilities/naval-admins.js, pages/survey-progress.vue)', deadline: DEADLINE, run: checkHead },
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
    close: async () => {
      ;[SAVE_DB, FIXTURE_DB].forEach((db) => db && db.close())
    },
    control: null,
    setup: DEADLINE,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
