/*
  Checks the known jump point infrastructure table (src/renderer/utilities/jump-infrastructure.js and the panel of the Lagrange page that draws it, with the map selection its rows open) against the save in SQL written here, in a browser.

  Run: bun scripts/check-jump-infrastructure.js [--no-mutations] [--no-lacking] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  Two datasets, each with its own oracle, read from the save by SQL written here and never from the module. The fixture (scripts/lib/fixtures.js `FIXTURE`, the race Shogunate of game 141, a save of the present line) is run as it is (a copy of the file, which is never written): the system with gates and the points of the cases are chosen from it by SQL (a gate whose far side the race has charted, a point whose far side is not charted, a point of a known system that the race has not charted), and every case the fixture can exercise runs on it: the rows of the charted points with their numbers, systems, far sides and gates (the race's own), the stabilisation, the minefield and buoy counts and the objects detected as the save has them (none), the probe figure, the whole list once the system is cleared, the link to the map, the side panel, the System view, a point a link names that its system lacks, and the two saves lacking a column. What the fixture cannot exercise is printed as SKIP, with what the save holds counted by SQL (needs tier b): it holds no stabilisation order (move action 64), no salvo of any race, no stationary contact of the race, no gate built by another race or by none recorded and no explored point whose far side is not charted; the cases that need one, and the planted faults and rewrites that need them, run on the recorded campaign. The recorded campaign (artifacts/boscodiogigia-sequential-saves, the race Axis, a save of an earlier release) is a regression input and not a fixture run, and every line it prints says so: scripts/lib/fixtures.js `convertedSave` gives the star's component number under its present name and, for the copy the browser reads, the seven columns the app looks for to accept a save as of the present line (the statements are documented there; the app refuses the recorded save without them), and into the copy the cases the save does not hold are written by SQL here: queued, running and arrived stabilisation orders, a point with two fleets and a fleet with two orders at one point, an order of another race and an order of another kind, gates built by another race and by none recorded, stationary contacts of the race (current, earlier, twice for one object, of its own salvo, moving, of another kind, of another race, in another system, beyond a kilometre) and objects at a point the race has not charted. The rules of the module wait on AE-303-04 and list the earlier line only: the fixture gives them no case of their own for the stabilisation, the objects of the race and the objects detected.
  - module: the rows of every charted point of the race hold the figures SQL gives (the number of the point, its gate, its orders, each count once for each observed object id), a point the race has not charted has no row, a figure the save cannot support is unknown and never 0, and the probe count is never given; the same on a small save written here for the cases of duplicate rows, a salvo of no known design, a point with no position, a missing game time and an order with no time;
  - page: the table of /lagrange?system=<id> draws a row for each charted point of the system and for no other, each row's number, system, far side, gate, stabilisation with its fleets, minefield and buoy counts, probe figure and detected objects as the oracle says (words read back through the module's own tables), gate and stabilisation apart, and the whole list once the system is cleared; a row's link opens the map with the system and the point in the route, the side panel naming that point, and the System view opened from it is told that point;
  - a save lacking a column the infrastructure reads (the speed of the salvos, or the builder of the gates) still draws every point, a gate whose builder is not read as built by none recorded, and every figure that rests on the missing column reads as unknown, never 0;
  - a point a link names that its system does not have is dropped from the route once the map has settled, and is not selected when its own system is picked afterwards.
  Every planted fault is served in place of the module's or the page's file (or run on the module's text) and each must fail the checks it names by a value; the rewrites must leave every check passing and the screen as it was. Table wording is human-reviewed prose: the check reads the words back through the modules' own labels (GATE_TEXT, STABILISATION_TEXT, UNKNOWN_TEXT, DETECTED_ZERO_TEXT and the jump point label of places.js), each matched exactly and in the order the page can tell them apart, and reads the number of the earlier contacts from the element the page gives it, never from its place in a caption.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. It needs Playwright's Chromium (`bunx playwright install chromium` once). Every head and variant runs through scripts/lib/suite-runner.js in a worker that copies the save, starts one page server and one browser and warms them first.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { runSuite } = require('./lib/suite-runner')
const { observe, validate, failureLine, describe, HarnessError, installScreen, readFigure, labelKey, pairedBy } = require('./lib/browser-observe')
const { caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { convertedSave, FIXTURE, fixturePath, fixtureRows } = require('./lib/fixtures')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
// The recorded campaign, a regression input: the save the cases below were first written for, with the game and the race it names.
const CAMPAIGN_SAVE = 'artifacts/boscodiogigia-sequential-saves/AuroraDB 21.06.1973.db'
const IDS = { GameID: 140, RaceID: 784 }
const NAMES = { game: 'Nazi Era', race: 'Axis' }
const TIMEOUT = 120000
const STEP = 45000
const PAGE = 'src/renderer/pages/lagrange.vue'
const MAP = 'src/renderer/pages/map.vue'
const GRAPH = 'src/renderer/utilities/jump-graph.js'
const MODULE = 'src/renderer/utilities/jump-infrastructure.js'
const PLACES = 'src/renderer/utilities/places.js'
const DETAIL = process.argv.includes('--detail')

// The points of the recorded campaign. In system 21756 four gates: 59876 (the race's own, a queued order, an object of its own at it that a contact names), 59879 (a gate with no builder recorded, a contact), 59877 (the race's own, two contacts of one object and one of an earlier time, an order of another race), 59878 (built by another race, an order of another kind). 59907 of system 21768 holds no gate and an order that has arrived with nothing left to do. 60143 of system 21858 holds two fleets and a fleet with two orders. Of system 21792 the point 59967 is not charted by the race.
// 60144 of system 21858 is charted by the race with its far side not charted, and has no name for the system beyond.
const POINT = { queued: 59876, unrecorded: 59879, contacts: 59877, other: 59878, awaiting: 59907, fleets: 60143, unexplored: 60144, uncharted: 59967 }
const SYSTEMS = { gates: 21756, awaiting: 21768, fleets: 21858, uncharted: 21792 }
const SHOWN = [SYSTEMS.gates, SYSTEMS.awaiting, SYSTEMS.fleets, SYSTEMS.uncharted]
const STABILISE = 64
const FLEET = { first: 460100, second: 460101, third: 459992, fourth: 459993 }
const GAME_TIME = 1277161332
const EARLIER = GAME_TIME - 86400

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---------- the save, in SQL written here ----------

const open = (file, mode = sqlite3.OPEN_READONLY) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(raw)))
})
const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
const run = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
const adapter = (raw) => ({ query: async (sql) => [await all(raw, sql)] })

// The columns of a table but its primary key, for the rows written by copying one.
const columnsOf = async (raw, table) => (await all(raw, `pragma table_info(${table})`)).filter((column) => !column.pk).map((column) => column.name)

// An INSERT of a copy of the row of `table` that `where` names, with the columns of `over` (SQL values) put in place.
const copyOf = (table, columns, where, over) => `insert into ${table} (${columns.join(', ')}) select ${columns.map((column) => (column in over ? over[column] : column)).join(', ')} from ${table} where ${where}`

// The statements that write the cases the save does not hold, from what the save says of its own points.
const fixtureStatements = async (file) => {
  const raw = await open(file)

  try {
    const place = async (id) => (await all(raw, `select SystemID as system, Xcor as x, Ycor as y from FCT_JumpPoint where GameID = ${IDS.GameID} and WarpPointID = ${id}`))[0]
    const at = {}

    for (const [key, id] of Object.entries(POINT)) {
      at[key] = await place(id)
      assert.ok(at[key], `the save holds the point ${id}`)
    }

    const orderColumns = await columnsOf(raw, 'FCT_MoveOrders')
    const contactColumns = await columnsOf(raw, 'FCT_Contacts')
    const salvoColumns = await columnsOf(raw, 'FCT_MissileSalvo')
    const [orderOf] = await all(raw, `select MoveOrderID as id from FCT_MoveOrders where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID} and MoveActionID = ${STABILISE}`)
    const [contactOf] = await all(raw, `select UniqueID as id from FCT_Contacts where GameID = ${IDS.GameID} and DetectRaceID = ${IDS.RaceID} and ContactType = 1`)
    const [salvoOf] = await all(raw, `select MissileSalvoID as id from FCT_MissileSalvo where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID} and MissileSpeed = 0`)
    const [own] = await all(raw, `select m.MissileSalvoID as id from FCT_MissileSalvo m inner join FCT_JumpPoint p on p.WarpPointID = ${POINT.queued} where m.GameID = ${IDS.GameID} and m.RaceID = ${IDS.RaceID} and m.MissileSpeed = 0 and m.SystemID = p.SystemID and abs(m.Xcor - p.Xcor) < 1 and abs(m.Ycor - p.Ycor) < 1 order by m.MissileSalvoID`)

    assert.ok(orderOf && contactOf && salvoOf && own, 'the save holds an order, a contact and a stationary salvo of the race to copy, and a salvo of the race at the queued point')

    const order = (point, fleet, arrived, time, over = {}) => copyOf('FCT_MoveOrders', orderColumns, `MoveOrderID = ${orderOf.id}`, { DestinationID: point, FleetID: fleet, Arrived: arrived, TimeRequired: time, MoveActionID: STABILISE, DestinationType: 1, ...over })
    // A contact of the race of the kind a salvo gives, standing still, at `where`'s place or 0.5 km from it; `over` changes the rest.
    const contact = (id, where, over = {}) => copyOf('FCT_Contacts', contactColumns, `UniqueID = ${contactOf.id}`, { ContactID: id, SystemID: where.system, Xcor: where.x + (over.shift || 0), Ycor: where.y, ContactType: 3, Speed: 0, LastUpdate: GAME_TIME, DetectRaceID: IDS.RaceID, ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'shift')) })

    return [
      order(POINT.fleets, FLEET.second, 0, 0),
      order(POINT.queued, FLEET.first, 0, 0),
      order(POINT.awaiting, FLEET.third, 1, 0),
      order(POINT.fleets, FLEET.fourth, 1, 5000),
      order(POINT.contacts, FLEET.first, 1, 7000, { RaceID: 786 }),
      order(POINT.other, FLEET.first, 1, 7000, { MoveActionID: 1 }),
      `update FCT_JumpPoint set JumpGateRaceID = 786 where GameID = ${IDS.GameID} and WarpPointID = ${POINT.other}`,
      `update FCT_JumpPoint set JumpGateRaceID = 0 where GameID = ${IDS.GameID} and WarpPointID = ${POINT.unrecorded}`,
      contact(9000001, at.contacts, { ContactMethod: 2 }),
      contact(9000001, at.contacts, { ContactMethod: 3 }),
      contact(9000002, at.contacts, { LastUpdate: EARLIER }),
      contact(9000003, at.unrecorded, { shift: 0.5 }),
      contact(9000004, { ...at.unrecorded, system: SYSTEMS.awaiting }),
      contact(9000005, at.unrecorded, { shift: 5 }),
      contact(own.id, at.queued),
      contact(9000007, at.uncharted),
      contact(9000008, at.other, { DetectRaceID: 787 }),
      contact(9000009, at.queued, { Speed: 5 }),
      contact(9000010, at.contacts, { ContactType: 4 }),
      copyOf('FCT_MissileSalvo', salvoColumns, `MissileSalvoID = ${salvoOf.id}`, { SystemID: at.uncharted.system, Xcor: at.uncharted.x, Ycor: at.uncharted.y }),
      copyOf('FCT_MissileSalvo', salvoColumns, `MissileSalvoID = ${salvoOf.id}`, { SystemID: at.queued.system, Xcor: at.queued.x + 50, Ycor: at.queued.y }),
    ]
  } finally {
    raw.close()
  }
}

// A copy of the save in a folder of its own, with `statements` run on it.
const saveCopy = async (prefix, statements, from) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(from, file)

  const raw = await open(file, sqlite3.OPEN_READWRITE)

  try {
    for (const statement of statements) {
      await run(raw, statement)
    }
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }

  return { folder, file }
}

// ---------- the datasets ----------

// What the checks read of a dataset: `ids` (GameID, RaceID), `names` (the game and the race as the Empires page lists them), `point` (the points of the cases: queued, unrecorded, contacts, other, awaiting, fleets, unexplored, uncharted; null where the save holds none), `systems` (gates, awaiting, fleets, uncharted), `shown` (the systems the page is shown), `source` (the file the copy the browser reads is made from), `base` and `statements(base)` (the statements written into the copy), `cases` (which of the cases the oracle tells apart the save holds: the checks assert the whole spread of states and counts only where it does) and `missing` (the cases printed as skipped: { name, checks, reason }).
const campaignDataset = () => ({
  key: 'campaign',
  label: 'the recorded campaign (a regression input, not a fixture run)',
  source: convertedSave(CAMPAIGN_SAVE, { line: true }),
  base: convertedSave(CAMPAIGN_SAVE),
  ids: IDS,
  names: NAMES,
  point: POINT,
  systems: SYSTEMS,
  shown: SHOWN,
  cases: { orders: true, salvos: true, contacts: true, builders: true, farUncharted: true },
  statements: fixtureStatements,
  missing: [],
})

// The fixture, as it is: the system, the points and the cases it lacks are found in it by SQL, so that the check holds on the save the fixture stands for and says so when it does not.
const fixtureDataset = () => {
  const ids = { GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId }
  const { GameID, RaceID } = ids
  const { CHARTED } = sqlOf(ids)
  const first = (sql, what) => {
    const [row] = fixtureRows(sql)

    if (!row) {
      throw new HarnessError(`the fixture holds no ${what}`)
    }

    return row
  }
  const count = (sql) => fixtureRows(sql)[0].n
  const charted = (test) => `${CHARTED} and ${test}`
  const farCharted = `p.WPLink in (select WarpPointID from FCT_RaceJumpPointSurvey where GameID = ${GameID} and RaceID = ${RaceID} and Charted = 1)`
  const gates = first(`select p.SystemID as system ${CHARTED} group by p.SystemID having sum(p.JumpGateStrength > 0) > 0 and count(*) >= 4 order by sum(p.JumpGateStrength > 0) desc, count(*) desc, p.SystemID limit 1`, 'system where the race has charted four points or more, one of them with a gate')
  const contacts = first(`select p.WarpPointID as id ${charted(`p.SystemID = ${gates.system} and p.JumpGateStrength > 0 and s.Explored = 1 and ${farCharted} and (select SystemID from FCT_JumpPoint where GameID = ${GameID} and WarpPointID = p.WPLink) in (select SystemID from FCT_RaceSysSurvey where GameID = ${GameID} and RaceID = ${RaceID})`)} order by p.Distance desc, p.WarpPointID desc limit 1`, 'point with a gate in that system, explored, whose far side the race has charted in a system it knows')
  const queued = first(`select p.WarpPointID as id ${charted(`p.SystemID = ${gates.system} and p.WarpPointID <> ${contacts.id}`)} order by p.Distance, p.WarpPointID limit 1`, 'second charted point in that system')
  const unexplored = first(`select p.WarpPointID as id, p.SystemID as system ${charted(`s.Explored = 0 and p.SystemID <> ${gates.system}`)} order by p.SystemID, p.WarpPointID limit 1`, 'charted point whose far side is not charted, in another system')
  const awaiting = first(`select p.WarpPointID as id, p.SystemID as system ${charted(`p.JumpGateStrength = 0 and s.Explored = 1 and p.SystemID not in (${gates.system}, ${unexplored.system})`)} order by p.SystemID, p.WarpPointID limit 1`, 'charted point with no gate, in a third system')
  const uncharted = first(`select u.WarpPointID as id, u.SystemID as system from FCT_JumpPoint u left join FCT_RaceJumpPointSurvey v on v.GameID = u.GameID and v.WarpPointID = u.WarpPointID and v.RaceID = ${RaceID} where u.GameID = ${GameID} and coalesce(v.Charted, 0) = 0 and u.SystemID in (select p.SystemID ${CHARTED}) and u.SystemID not in (${gates.system}, ${unexplored.system}, ${awaiting.system}) order by u.SystemID, u.WarpPointID limit 1`, 'point the race has not charted, in a system where it has charted another')
  const orders = count(`select count(*) as n from FCT_MoveOrders where GameID = ${GameID} and RaceID = ${RaceID} and MoveActionID = ${STABILISE} and DestinationType = 1`)
  const salvos = count(`select count(*) as n from FCT_MissileSalvo where GameID = ${GameID} and RaceID = ${RaceID} and MissileSpeed = 0`)
  const objects = count(`select count(*) as n from FCT_Contacts where GameID = ${GameID} and DetectRaceID = ${RaceID} and ContactType = 3 and Speed = 0`)
  const [gateCounts] = fixtureRows(`select count(*) as charted, coalesce(sum(p.JumpGateStrength > 0), 0) as gates, coalesce(sum(p.JumpGateStrength > 0 and p.JumpGateRaceID = ${RaceID}), 0) as own, coalesce(sum(p.JumpGateStrength > 0 and p.JumpGateRaceID > 0 and p.JumpGateRaceID <> ${RaceID}), 0) as other, coalesce(sum(p.JumpGateStrength > 0 and coalesce(p.JumpGateRaceID, 0) = 0), 0) as unrecorded ${CHARTED}`)
  const farUncharted = count(`select count(*) as n ${charted(`s.Explored = 1 and not ${farCharted}`)}`)
  const cases = { orders: orders > 0, salvos: salvos > 0, contacts: objects > 0, builders: gateCounts.other > 0 && gateCounts.unrecorded > 0, farUncharted: farUncharted > 0 }
  const missing = [
    !cases.orders && { name: 'a stabilisation order', checks: ['m-orders', 'stabilisation', 'distinct'], reason: `the fixture holds ${orders} stabilisation orders of the race (move action ${STABILISE}), so no point is queued, running or awaiting and no fleet is named under one` },
    !cases.salvos && { name: 'a stationary salvo', checks: ['m-counts', 'counts'], reason: `the fixture holds ${salvos} stationary salvos of the race, so every minefield and buoy count is 0` },
    !cases.contacts && { name: 'a contact of a salvo', checks: ['m-detected', 'detected'], reason: `the race holds ${objects} stationary contacts of a salvo in the fixture (it holds contacts of other kinds only), so no object is detected and no earlier contact is counted` },
    !cases.builders && { name: 'a gate built by another race or by none recorded', checks: ['m-gate', 'gate', 'lacking-builders'], reason: `${gateCounts.own} of the ${gateCounts.gates} gates at the ${gateCounts.charted} charted points are built by the race (${gateCounts.other} by another race, ${gateCounts.unrecorded} by none recorded)` },
    !cases.farUncharted && { name: 'a far side explored but not charted', checks: ['name'], reason: `${farUncharted} of the explored points have a far side the race has not charted` },
  ].filter(Boolean)

  return {
    key: 'fixture',
    label: 'the fixture',
    source: fixturePath(),
    base: fixturePath(),
    ids,
    names: { game: FIXTURE.gameName, race: FIXTURE.raceName },
    point: { queued: queued.id, unrecorded: null, contacts: contacts.id, other: null, awaiting: awaiting.id, fleets: null, unexplored: unexplored.id, uncharted: uncharted.id },
    systems: { gates: gates.system, awaiting: awaiting.system, fleets: unexplored.system, uncharted: uncharted.system },
    shown: [...new Set([gates.system, awaiting.system, unexplored.system, uncharted.system])],
    cases,
    statements: async () => [],
    missing,
  }
}

const DATASETS = { fixture: fixtureDataset, campaign: campaignDataset }

// The pieces of SQL the oracle is written from, for the game and the race of a dataset.
const sqlOf = ({ GameID: G, RaceID: R }) => {
  const NEAR = (alias) => `${alias}.SystemID = p.SystemID and abs(${alias}.Xcor - p.Xcor) < 1 and abs(${alias}.Ycor - p.Ycor) < 1`

  return {
    G,
    R,
    NEAR,
    OWN: `select MissileSalvoID from FCT_MissileSalvo where GameID = ${G} and RaceID = ${R} and MissileSpeed = 0`,
    CONTACTS: `GameID = ${G} and DetectRaceID = ${R} and ContactType = 3 and Speed = 0`,
    NOW: `(select GameTime from FCT_Game where GameID = ${G})`,
    CHARTED: `from FCT_JumpPoint p inner join FCT_RaceJumpPointSurvey s on s.GameID = p.GameID and s.WarpPointID = p.WarpPointID and s.RaceID = ${R} where p.GameID = ${G} and s.Charted = 1 and p.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${G} and RaceID = ${R})`,
    SALVOS: (test) => `(select count(distinct m.MissileSalvoID) from FCT_MissileSalvo m inner join FCT_MissileType t on t.GameID = m.GameID and t.MissileID = m.MissileID where m.GameID = ${G} and m.RaceID = ${R} and m.MissileSpeed = 0 and ${NEAR('m')} and ${test})`,
  }
}

// What the save says of each charted point of the race: { points: Map(WarpPointID -> row), systemNames, charted }, one row each with its system, its number among the charted points of the system, the system beyond it, its gate, the state of the orders, the names of the fleets, the stationary salvos of the race by kind and the contacts of the race, the current and the earlier.
const truthOf = async (file, dataset) => {
  const raw = await open(file)
  const { G, R, NEAR, OWN, CONTACTS, NOW, CHARTED, SALVOS } = sqlOf(dataset.ids)

  try {
    const points = await all(raw, `select p.WarpPointID as id, p.SystemID as system, p.WPLink as link, p.JumpGateStrength as strength, p.JumpGateRaceID as builder, s.Explored as explored, row_number() over (partition by p.SystemID order by p.Distance, p.WarpPointID) as number,
      ${SALVOS('t.SecondStageID > 0')} as mines, ${SALVOS('t.SecondStageID = 0')} as buoys,
      (select count(distinct c.ContactID) from FCT_Contacts c where c.${CONTACTS.replace(/ and /g, ' and c.')} and ${NEAR('c')} and c.LastUpdate = ${NOW} and c.ContactID not in (${OWN})) as detected,
      (select count(distinct c.ContactID) from FCT_Contacts c where c.${CONTACTS.replace(/ and /g, ' and c.')} and ${NEAR('c')} and c.LastUpdate <> ${NOW} and c.ContactID not in (${OWN}) and c.ContactID not in (select ContactID from FCT_Contacts where ${CONTACTS} and LastUpdate = ${NOW})) as earlier
      ${CHARTED}`)
    const names = await all(raw, `select SystemID as id, Name as name from FCT_RaceSysSurvey where GameID = ${G} and RaceID = ${R}`)
    const orders = await all(raw, `select o.DestinationID as point, o.FleetID as fleet, f.FleetName as name, o.Arrived as arrived, o.TimeRequired as time from FCT_MoveOrders o left join FCT_Fleet f on f.FleetID = o.FleetID where o.GameID = ${G} and o.RaceID = ${R} and o.MoveActionID = ${STABILISE} and o.DestinationType = 1`)
    const systemNames = new Map(names.map((row) => [row.id, row.name]))
    const charted = new Map(points.map((row) => [row.id, row]))
    const stateOf = (list) => (list.some((order) => order.arrived && order.time > 0) ? 'running' : list.some((order) => order.arrived) ? 'awaiting' : list.length ? 'queued' : 'none')
    const fleetStates = (list) => [...new Set(list.map((order) => order.name))].sort().map((name) => `${name}:${stateOf(list.filter((order) => order.name === name))}`)
    const rows = new Map()

    points.forEach((row) => {
      const list = orders.filter((order) => order.point === row.id)
      const partner = row.explored ? charted.get(row.link) : null

      rows.set(row.id, {
        id: row.id,
        system: row.system,
        systemName: systemNames.get(row.system),
        number: row.number,
        beyond: partner ? systemNames.get(partner.system) : null,
        explored: Boolean(row.explored),
        gate: row.strength > 0 ? (row.builder === R ? 'own' : row.builder > 0 ? 'other' : 'unrecorded') : 'none',
        state: stateOf(list),
        fleets: [...new Set(list.map((order) => order.name))].sort(),
        fleetStates: fleetStates(list),
        mines: row.mines,
        buoys: row.buoys,
        detected: row.detected,
        earlier: row.earlier,
      })
    })

    return { points: rows, systemNames, charted: points.length, dataset }
  } finally {
    raw.close()
  }
}

// ---------- the module ----------

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const loadModules = async (changes = {}) => {
  const sources = {}

  for (const [file, change] of Object.entries(changes)) {
    sources[path.basename(file, '.js')] = change(source(file))
  }

  const { 'jump-infrastructure': infrastructure, 'jump-graph': graph, places } = await loadUtilities(['jump-infrastructure', 'jump-graph', 'places'], { sources })

  return { infrastructure, graph, places }
}

const valueOf = (result) => (result.status === 'unavailable' ? 'unknown' : result.value)

// The small save written here: game 1, race 2, game time 1000; points 1 (gate of the race, system 10), 2 (no gate, system 10, 5000 km out), 3 (a gate with no builder, system 11, no position), 4 (gate not recorded, system 12, far side the point 1), 5 (gate of another race, system 13, whose own salvo and detected salvo have no position), 6 (no gate, system 14, an order with no arrival flag), 7 (no gate, system 15, a detected salvo with no update time), 8 (no gate, system 16, a detected salvo of two rows, one with no update time and one current). Its tables hold only the columns the read names, and some rows twice, as the save may.
const SMALL = [
  'create table FCT_JumpPoint (WarpPointID integer, GameID integer, JumpGateRaceID integer)',
  'insert into FCT_JumpPoint values (1, 1, 2), (2, 1, 0), (3, 1, 0), (4, 1, NULL), (5, 1, 3), (6, 1, 0), (7, 1, 0), (8, 1, 0)',
  'create table FCT_Game (GameID integer, GameTime real)',
  'create table FCT_Fleet (FleetID integer, FleetName text)',
  'create table FCT_MoveOrders (MoveOrderID integer, GameID integer, RaceID integer, FleetID integer, MoveActionID integer, DestinationType integer, DestinationID integer, Arrived integer, TimeRequired real)',
  'create table FCT_MissileType (MissileID integer, GameID integer, SecondStageID integer)',
  'create table FCT_MissileSalvo (MissileSalvoID integer, GameID integer, RaceID integer, MissileID integer, MissileSpeed real, SystemID integer, Xcor real, Ycor real)',
  'create table FCT_Contacts (ContactID integer, GameID integer, DetectRaceID integer, ContactType integer, Speed real, SystemID integer, Xcor real, Ycor real, LastUpdate real)',
  'insert into FCT_Game values (1, 1000)',
  "insert into FCT_Fleet values (10, 'Alpha'), (11, 'Bravo')",
  'insert into FCT_MoveOrders values (1, 1, 2, 10, 64, 1, 1, 1, 500), (1, 1, 2, 10, 64, 1, 1, 1, 500), (2, 1, 2, 10, 64, 1, 1, 0, 0), (3, 1, 2, 11, 64, 1, 2, 0, 0), (4, 1, 2, 11, 64, 1, 2, 1, 0), (5, 1, 3, 10, 64, 1, 1, 1, 500), (6, 1, 2, 10, 217, 1, 1, 1, 500), (7, 1, 2, 10, 64, 2, 1, 1, 500), (8, 1, 2, 11, 64, 1, 4, 1, NULL), (9, 1, 2, 11, 64, 1, 6, NULL, 500)',
  'insert into FCT_MissileType values (70, 1, 7), (71, 1, 0)',
  'insert into FCT_MissileSalvo values (501, 1, 2, 70, 0, 10, 100.5, 100), (501, 1, 2, 70, 0, 10, 100.5, 100), (502, 1, 2, 70, 0, 10, 100, 100.9), (503, 1, 2, 71, 0, 10, 99.2, 100), (504, 1, 2, 71, 0, 10, 101, 100), (505, 1, 2, 70, 5, 10, 100, 100), (506, 1, 3, 70, 0, 10, 100, 100), (507, 1, 2, 70, 0, 11, 100, 100), (508, 1, 2, 70, 0, 10, 5000, 5000), (509, 1, 2, 99, 0, 10, 5000.2, 5000), (510, 1, 2, 70, 0, 13, NULL, 200)',
  'insert into FCT_Contacts values (601, 1, 2, 3, 0, 10, 100, 100, 1000), (601, 1, 2, 3, 0, 10, 100, 100, 1000), (602, 1, 2, 3, 0, 10, 100.2, 100, 500), (503, 1, 2, 3, 0, 10, 99.2, 100, 1000), (603, 1, 3, 3, 0, 10, 100, 100, 1000), (604, 1, 2, 3, 7, 10, 100, 100, 1000), (605, 1, 2, 4, 0, 10, 100, 100, 1000), (606, 1, 2, 3, 0, 10, 5000, 5000, 1000), (607, 1, 2, 3, 0, 10, 100, 100, 1000), (607, 1, 2, 3, 0, 10, 100, 100, 400), (608, 1, 2, 3, 0, 13, NULL, 200, 1000), (609, 1, 2, 3, 0, 15, 400, 400, NULL), (610, 1, 2, 3, 0, 16, 500, 500, NULL), (610, 1, 2, 3, 0, 16, 500, 500, 1000)',
]
const SMALL_POINTS = [
  { WarpPointID: 1, SystemID: 10, WPLink: 99, Distance: 1, Xcor: 100, Ycor: 100, JumpGateStrength: 1000, Explored: 1 },
  { WarpPointID: 2, SystemID: 10, WPLink: 98, Distance: 2, Xcor: 5000, Ycor: 5000, JumpGateStrength: 0, Explored: 0 },
  { WarpPointID: 3, SystemID: 11, WPLink: 97, Distance: 1, Xcor: null, Ycor: null, JumpGateStrength: 1000, Explored: 0 },
  { WarpPointID: 4, SystemID: 12, WPLink: 1, Distance: 1, Xcor: 0, Ycor: 0, JumpGateStrength: null, Explored: 1 },
  { WarpPointID: 5, SystemID: 13, WPLink: 96, Distance: 1, Xcor: 200, Ycor: 200, JumpGateStrength: 1000, Explored: 0 },
  { WarpPointID: 6, SystemID: 14, WPLink: 95, Distance: 1, Xcor: 300, Ycor: 300, JumpGateStrength: 0, Explored: 0 },
  { WarpPointID: 7, SystemID: 15, WPLink: 94, Distance: 1, Xcor: 400, Ycor: 400, JumpGateStrength: 0, Explored: 0 },
  { WarpPointID: 8, SystemID: 16, WPLink: 93, Distance: 1, Xcor: 500, Ycor: 500, JumpGateStrength: 0, Explored: 0 },
]
const SMALL_IDS = { GameID: 1, RaceID: 2 }

// The modules' answers on the real fixture and on the small save.
const observeModule = async (changes) => {
  const { infrastructure, graph } = await loadModules(changes)
  const real = await open(ENV.copy.file)

  try {
    const database = adapter(real)
    const { ids } = ENV.dataset
    const points = await graph.loadJumpPoints(database, ids)
    const facts = await infrastructure.loadJumpInfrastructure(database, ids)
    const builders = await infrastructure.loadJumpBuilders(database, ids)
    const rows = infrastructure.infrastructureRows(points, facts, { RaceID: ids.RaceID, builders })
    const small = await open(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)

    try {
      for (const statement of SMALL) {
        await run(small, statement)
      }

      const smallFacts = await infrastructure.loadJumpInfrastructure(adapter(small), SMALL_IDS)
      const smallBuilders = await infrastructure.loadJumpBuilders(adapter(small), SMALL_IDS)
      const smallRows = infrastructure.infrastructureRows(SMALL_POINTS, smallFacts, { RaceID: 2, builders: smallBuilders })
      const unbuilt = infrastructure.infrastructureRows(SMALL_POINTS, smallFacts, { RaceID: 2 })
      const timeless = infrastructure.infrastructureRows(SMALL_POINTS, { ...smallFacts, gameTime: null }, { RaceID: 2, builders: smallBuilders })
      const withheld = infrastructure.infrastructureRows(SMALL_POINTS, null, { RaceID: 2, missing: ['the save lacks FCT_Contacts.Speed'], builders: smallBuilders })

      return { rows, points: points.map((point) => point.WarpPointID), small: smallRows, unbuilt, timeless, withheld }
    } finally {
      small.close()
    }
  } finally {
    real.close()
  }
}

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.WarpPointID, row]))

// The problems of `rows` set against the oracle's rows by the identity of the point.
const sameRows = (rows, truth) => {
  const { pairs, problems } = pairedBy('the rows', rows, [...truth.points.values()], (row) => String(row.WarpPointID), (row) => String(row.id))

  return { pairs, problems }
}

const MODULE_CHECKS = [
  ['m-charted', 'the rows are the points the race has charted in systems it knows, one each, and a point it has not charted has none', (o, t) => {
    const { problems } = sameRows(o.rows, t)

    return problems.length === 0 && (!t.dataset.point.uncharted || !o.rows.some((row) => row.WarpPointID === t.dataset.point.uncharted)) && (!t.dataset.point.queued || o.points.includes(t.dataset.point.queued)) ? true : short({ problems, rows: o.rows.length, charted: t.charted })
  }],
  ['m-number', 'each row has the number of its point among the charted points of its system, its system, and the system beyond it when its far side is charted too', (o, t) => {
    const wrong = sameRows(o.rows, t).pairs.filter(([truth, row]) => row.number !== truth.number || row.SystemID !== truth.system || (row.beyondSystemID ? t.systemNames.get(row.beyondSystemID) : null) !== truth.beyond).map(([truth, row]) => [truth.id, row.number, truth.number, row.beyondSystemID])

    return wrong.length === 0 || short(wrong.slice(0, 3))
  }],
  ['m-gate', 'the gate of each row is the one the save gives: none, built by the race, built by another race, or built by none recorded, and a builder 0 is never the race\'s own', (o, t) => {
    const wrong = sameRows(o.rows, t).pairs.filter(([truth, row]) => row.gate !== truth.gate).map(([truth, row]) => [truth.id, row.gate, truth.gate])

    return (wrong.length === 0 && (!t.dataset.cases.builders || (o.rows.some((row) => row.gate === 'unrecorded') && o.rows.some((row) => row.gate === 'other')))) || short(wrong.slice(0, 3))
  }],
  ['m-orders', 'the stabilisation of each row is the furthest state of the orders of the race at the point, its fleets named once each, and no order of another race or another kind counts', (o, t) => {
    const wrong = sameRows(o.rows, t).pairs.filter(([truth, row]) => valueOf(row.stabilisation) !== truth.state || JSON.stringify(row.fleets.map((fleet) => `${fleet.FleetName}:${fleet.state}`).sort()) !== JSON.stringify(truth.fleetStates)).map(([truth, row]) => [truth.id, valueOf(row.stabilisation), truth.state, row.fleets.map((fleet) => `${fleet.FleetName}:${fleet.state}`), truth.fleetStates])
    const states = new Set(o.rows.map((row) => valueOf(row.stabilisation)))

    return (wrong.length === 0 && (!t.dataset.cases.orders || ['none', 'queued', 'running', 'awaiting'].every((state) => states.has(state)))) || short({ wrong: wrong.slice(0, 3), states: [...states] })
  }],
  ['m-counts', 'the mines and the buoys of each row are the distinct stationary salvos of the race within a kilometre of the point, by the design\'s second stage, and 0 where there are none', (o, t) => {
    const wrong = sameRows(o.rows, t).pairs.filter(([truth, row]) => valueOf(row.minefields) !== truth.mines || valueOf(row.buoys) !== truth.buoys).map(([truth, row]) => [truth.id, valueOf(row.minefields), truth.mines, valueOf(row.buoys), truth.buoys])

    return (wrong.length === 0 && (!t.dataset.cases.salvos || (o.rows.some((row) => valueOf(row.minefields) > 0) && o.rows.some((row) => valueOf(row.buoys) > 0)))) || short(wrong.slice(0, 3))
  }],
  ['m-detected', 'the objects detected of each row are the distinct stationary salvos the race holds a contact of, once for each object however many contacts, those of its own salvos left out, the earlier ones counted apart', (o, t) => {
    const wrong = sameRows(o.rows, t).pairs.filter(([truth, row]) => valueOf(row.detected) !== truth.detected || row.earlier !== truth.earlier).map(([truth, row]) => [truth.id, valueOf(row.detected), truth.detected, row.earlier, truth.earlier])
    const at = byId(o.rows)

    return (wrong.length === 0 && (!t.dataset.cases.contacts || t.dataset.key !== 'campaign' || (valueOf(at[t.dataset.point.contacts].detected) === 1 && at[t.dataset.point.contacts].earlier === 1 && valueOf(at[t.dataset.point.queued].detected) === 0))) || short(wrong.slice(0, 3))
  }],
  ['m-probes', 'the probe count of every row is unknown, as the save marks no probe', (o) => o.rows.concat(o.small).every((row) => row.probes.status === 'unavailable' && row.probes.value === null) || short(o.rows.filter((row) => row.probes.status !== 'unavailable').slice(0, 2).map((row) => row.probes))],
  ['m-small-counts', 'on the small save each salvo counts once however many rows, a salvo or a contact a kilometre away or more, moving, of another race, in another system or of another kind counts nowhere, and a count of nothing is 0', (o) => {
    const [a, b, , d] = o.small
    const got = [valueOf(a.minefields), valueOf(a.buoys), valueOf(a.detected), a.earlier, valueOf(d.minefields), valueOf(d.buoys), valueOf(d.detected), d.earlier, valueOf(b.detected), b.earlier]
    const want = [2, 1, 2, 1, 0, 0, 0, 0, 1, 0]

    return JSON.stringify(got) === JSON.stringify(want) || short({ got, want })
  }],
  ['m-small-orders', 'on the small save the furthest order of a fleet counts and its fleet once, the fleets of a point are named, and an order that has arrived with no time is unknown at its point only', (o) => {
    const [a, b, c, d] = o.small
    const got = [valueOf(a.stabilisation), a.fleets.map((fleet) => fleet.FleetName), valueOf(b.stabilisation), b.fleets.map((fleet) => fleet.FleetName), valueOf(c.stabilisation), valueOf(d.stabilisation)]
    const want = ['running', ['Alpha'], 'awaiting', ['Bravo'], 'none', 'unknown']

    return JSON.stringify(got) === JSON.stringify(want) || short({ got, want })
  }],
  ['m-small-unknown', 'on the small save a figure the save cannot give is unknown and never 0: a salvo of no known design, a point with no position, a missing game time, and every figure when the save is withheld', (o) => {
    const [a, b, c, d] = o.small
    const got = [valueOf(b.minefields), valueOf(b.buoys), valueOf(c.minefields), valueOf(c.buoys), valueOf(c.detected), c.earlier, valueOf(o.timeless[0].detected), o.timeless[0].earlier, valueOf(o.timeless[0].minefields), ...o.withheld.flatMap((row) => [valueOf(row.stabilisation), valueOf(row.minefields), valueOf(row.buoys), valueOf(row.detected), row.earlier])]
    const want = ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', null, 'unknown', null, 2, ...o.withheld.flatMap(() => ['unknown', 'unknown', 'unknown', 'unknown', null])]
    const named = o.withheld.every((row) => row.minefields.inputs.missing.includes('the save lacks FCT_Contacts.Speed'))

    return (JSON.stringify(got) === JSON.stringify(want) && named && valueOf(a.minefields) === 2 && valueOf(d.stabilisation) === 'unknown') || short({ got, want, named })
  }],
  ['m-small-gates', 'on the small save the gate is read from the strength and the builders alone, a missing strength is not a gate, a gate whose builder is not read is built by none recorded, and the far side of a point is known only when it is explored', (o) => {
    const got = [...o.small.map((row) => row.gate), ...o.withheld.map((row) => row.gate), ...o.unbuilt.map((row) => row.gate), ...o.small.map((row) => row.beyondSystemID)]
    const want = ['own', 'none', 'unrecorded', 'unknown', 'other', 'none', 'none', 'none', 'own', 'none', 'unrecorded', 'unknown', 'other', 'none', 'none', 'none', 'unrecorded', 'none', 'unrecorded', 'unknown', 'unrecorded', 'none', 'none', 'none', null, null, null, 10, null, null, null, null]

    return JSON.stringify(got) === JSON.stringify(want) || short({ got, want })
  }],
  ['m-small-positions', 'on the small save a stationary salvo of the race, or a detected one, in a system that has no position is unknown at every point of the system: the counts that rest on it are unknown with a reason given, never 0', (o) => {
    const e = o.small[4]
    const got = [valueOf(e.minefields), valueOf(e.buoys), valueOf(e.detected), e.earlier]
    const want = ['unknown', 'unknown', 'unknown', null]
    const reasoned = [e.minefields, e.buoys, e.detected].every((result) => result.inputs.missing.length > 0)

    return (JSON.stringify(got) === JSON.stringify(want) && reasoned && valueOf(o.small[0].minefields) === 2 && valueOf(o.small[0].detected) === 2) || short({ got, want, reasoned })
  }],
  ['m-small-arrival', 'on the small save an order with no arrival flag is not a queued one: its point has an unknown stabilisation with a reason given, and the counts there stay known', (o) => {
    const f = o.small[5]
    const got = [valueOf(f.stabilisation), f.fleets.length, valueOf(f.minefields), valueOf(f.detected)]
    const want = ['unknown', 0, 0, 0]
    const reasoned = f.stabilisation.inputs.missing.length > 0

    return (JSON.stringify(got) === JSON.stringify(want) && reasoned) || short({ got, want, reasoned })
  }],
  ['m-small-dates', 'on the small save a detected salvo with no update time is neither current nor earlier: the detected and earlier figures of its point are unknown with a reason given, never 0 and 1, while a salvo whose other rows are dated is classified by them and the points beside it are unaffected', (o) => {
    const [a, , , , , , g, h] = o.small
    const got = [valueOf(g.detected), g.earlier, valueOf(h.detected), h.earlier, valueOf(a.detected), a.earlier, valueOf(g.minefields)]
    const want = ['unknown', null, 1, 0, 2, 1, 0]
    const reasoned = g.detected.inputs.missing.length > 0

    return (JSON.stringify(got) === JSON.stringify(want) && reasoned) || short({ got, want, reasoned })
  }],
]

// ---------- the page ----------

// What the page shows; runs in the page. Only what a player sees: each cell of the table with the point it belongs to and the text it draws, the chip that names the system, and the text of the list's footer.
const readTable = () => {
  const { visible, visibleText } = window.__screen
  const panel = document.querySelector('[data-jump-infrastructure]')
  const chip = panel ? panel.querySelector('.v-chip') : null
  const total = panel ? panel.querySelector('.v-data-footer__pagination [data-jump-total]') : null
  const cells = panel ? [...panel.querySelectorAll('[data-jump-cell]')].map((element) => {
    const text = visibleText(element)
    const figure = element.querySelector('[data-jump-figure]')
    const name = element.querySelector('[data-jump-name]')

    return { id: element.getAttribute('data-jump'), cell: element.getAttribute('data-jump-cell'), text, figure: figure ? visibleText(figure) : null, name: name ? visibleText(name) : null, on: visible(element) || text !== '' }
  }) : []

  return { panel: panel ? visible(panel) : false, chip: chip ? visibleText(chip) : null, total: total ? visibleText(total) : null, cells }
}

// The map after a row's link: the route, the side panel's point and the System view's title and told point.
const readMap = () => {
  const { visible, visibleText } = window.__screen
  const part = (selector) => {
    const element = document.querySelector(selector)

    return element ? { on: visible(element), text: visibleText(element) } : null
  }
  const view = document.querySelector('.system-view')

  return { path: window.$app.$route.path, query: { ...window.$app.$route.query }, name: part('[data-map-point-name]'), label: part('[data-map-point-label]'), far: part('[data-map-point-far]'), mark: part('[data-map-point-mark]'), system: part('[data-map-system-name]'), detail: part('[data-map-point-detail]'), title: part('[data-system-title]'), pointLabel: part('[data-system-point-label]'), pointFar: part('[data-system-point-far]'), pointMark: part('[data-system-point-mark]'), systemName: part('[data-system-name]'), told: view && view.__vue__ ? view.__vue__.jumpPointId : null }
}

const openApp = async (page, url, step, names) => {
  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })
  await installScreen(page)

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${names.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(names.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
}

const rendered = (page) => page.evaluate(async () => { await window.$app.$nextTick() })

// The Lagrange page on `system`, once its table names the system and the page's reads are in. `read` is whether the infrastructure read is expected to have an answer (a save lacking a column of it has none).
const showSystem = async (page, step, system, name, read) => {
  step(`opening /lagrange for ${name}`)
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), `/lagrange?system=${system}`)
  await page.waitForFunction(pageLoading.arrived, `/lagrange?system=${system}`, { timeout: TIMEOUT })
  await page.waitForFunction((wanted) => { const chip = document.querySelector('[data-jump-infrastructure] .v-chip'); return Boolean(chip) && chip.textContent.includes(wanted) }, name, { timeout: TIMEOUT })
  await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT })

  if (read) {
    await page.waitForFunction((both) => { const view = window.$app.$route.matched[0].instances.default; return view.jumpInfrastructure !== null && (!both || view.jumpBuilders !== null) }, read === true, { timeout: TIMEOUT })
  }

  await rendered(page)

  return page.evaluate(readTable)
}

// Everything a player does on the page, and what the screen shows after each step: { systems: { [SystemID]: table }, cleared, map, view }.
const observePage = (browser, url, truth, { map = true, read = true, systems = truth.dataset.shown } = {}) => observe(browser, async ({ page, step }) => {
  const { point, systems: where } = truth.dataset

  await openApp(page, url, step, truth.dataset.names)

  const seen = { systems: {} }

  for (const system of systems) {
    seen.systems[system] = await showSystem(page, step, system, truth.systemNames.get(system), read)
  }

  step('the system is cleared')
  await page.locator('[data-jump-infrastructure] .v-chip .v-chip__close').click({ timeout: STEP })
  await page.waitForFunction(() => { const footer = document.querySelector('[data-jump-infrastructure] .v-data-footer__pagination'); return Boolean(footer) && !document.querySelector('[data-jump-infrastructure] .v-chip') }, null, { timeout: TIMEOUT })
  await rendered(page)
  seen.cleared = await page.evaluate(readTable)

  if (map) {
    step('a link names a point that is not in its system')
    await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), `/map?system=${where.gates}&point=${point.awaiting}`)
    await page.waitForFunction(() => window.$app.$route.path === '/map', null, { timeout: TIMEOUT })
    await page.waitForFunction(() => { const view = window.$app.$route.matched[0].instances.default; return Boolean(view && view.ready) }, null, { timeout: TIMEOUT })
    await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT })
    await page.waitForFunction((system) => window.$app.$route.query.system === system && (!window.$app.$route.query.point || Boolean(document.querySelector('[data-map-point-name]'))), String(where.gates), { timeout: STEP }).catch(() => {})
    await rendered(page)

    const before = await page.evaluate(readMap)

    step('the system the point belongs to is picked on the map')
    await page.evaluate((id) => { const view = window.$app.$route.matched[0].instances.default; view.graph.nodes(':selected').unselect(); view.graph.getElementById(id).select() }, String(where.awaiting))
    await page.waitForFunction((system) => window.$app.$route.query.system === system, String(where.awaiting), { timeout: TIMEOUT })
    await rendered(page)
    seen.rejected = { before, after: await page.evaluate(readMap) }

    await showSystem(page, step, where.gates, truth.systemNames.get(where.gates), read)
    step('the row of a point is opened on the map')
    await page.locator(`[data-jump-cell="map"][data-jump="${point.contacts}"]`).first().click({ timeout: STEP })
    await page.waitForFunction(() => window.$app.$route.path === '/map', null, { timeout: TIMEOUT })
    await page.waitForFunction(() => { const view = window.$app.$route.matched[0].instances.default; return Boolean(view && view.ready) }, null, { timeout: TIMEOUT })
    await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT })
    await page.waitForFunction(() => Boolean(document.querySelector('[data-map-point-name]')) || !window.$app.$route.query.point, null, { timeout: STEP }).catch(() => {})
    await rendered(page)
    seen.map = await page.evaluate(readMap)

    if (seen.map.name && seen.map.name.on) {
      step('the System view is opened from the side panel')
      await page.getByRole('button', { name: 'Show in System view' }).first().click({ timeout: STEP })
      await page.waitForFunction(() => { const title = document.querySelector('[data-system-title]'); return Boolean(title) && Boolean(document.querySelector('.system-view')) }, null, { timeout: STEP }).catch(() => {})
      await rendered(page)
      seen.view = await page.evaluate(readMap)
    }

    step('a point whose far side is not charted is opened on the map')
    await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), `/map?system=${where.fleets}&point=${point.unexplored}`)
    await page.waitForFunction((id) => window.$app.$route.query.point === id && Boolean(document.querySelector('[data-map-point-name]')), String(point.unexplored), { timeout: STEP }).catch(() => {})
    await rendered(page)
    seen.unexplored = await page.evaluate(readMap)
  }

  return seen
})

// The reading of a table's cells: the entries of a cell of one point on screen.
const cellsOf = (table, id, cell) => table.cells.filter((entry) => entry.id === String(id) && entry.cell === cell && entry.on)

// The text of the one element of that cell on screen, or null when none or several are.
const oneText = (table, id, cell) => {
  const entries = cellsOf(table, id, cell)

  return entries.length === 1 ? entries[0].text : null
}

// The name the one element of that cell on screen gives to the system it names, or null when none or several are or it names none.
const oneName = (table, id, cell) => {
  const entries = cellsOf(table, id, cell)

  return entries.length === 1 ? entries[0].name : null
}

const MODULE_FILES = [MODULE, PLACES]

// The words of the modules' own tables, read once from the modules: the Gate and Stabilisation columns, the words for a figure the save cannot give and for a count of 0, and the label of a jump point by its number.
const wordsOf = ({ infrastructure, places }) => ({ gate: { ...infrastructure.GATE_TEXT }, stabilisation: { ...infrastructure.STABILISATION_TEXT }, far: { ...infrastructure.FAR_SIDE_TEXT }, unknown: infrastructure.UNKNOWN_TEXT, zero: infrastructure.DETECTED_ZERO_TEXT, label: places.jumpPointLabel, farUnknown: places.FAR_UNKNOWN_TEXT })

// Whether a cell says the figure is unknown, in the module's own word for it.
const isUnknown = (text) => text !== null && text.trim() === ENV.words.unknown

// The text of an element a page draws for a mark, none when it is not drawn.
const markOf = (part) => (part ? part.text.trim() : '')

// The fleets a text names: the expected list when the text is made of those names and separators only, else the text.
const fleetsRead = (text, expected) => {
  const wanted = new Map()

  expected.forEach((name) => wanted.set(name, (wanted.get(name) || 0) + 1))

  let rest = text
  let exact = true

  ;[...wanted.keys()].sort((a, b) => b.length - a.length).forEach((name) => {
    const parts = rest.split(name)

    exact = exact && parts.length - 1 === wanted.get(name)
    rest = parts.join(' ')
  })

  return exact && rest.replace(/[^\p{L}\p{N}]/gu, '') === '' ? expected : [text]
}

// A figure of a count cell: the number, 'unknown' for the table's word for it, or null for words that are neither.
const countOf = (text) => (text === null ? null : isUnknown(text) ? 'unknown' : readFigure(text, 'None'))
// A figure of the detected cell: the module's word for an unknown figure first, then its word for 0 exactly, then a count.
const detectedOf = (text) => (text !== null && !isUnknown(text) && text.trim() === ENV.words.zero ? 0 : countOf(text))
// The number of the earlier caption: the text of the element the page gives the figure, wherever the words around it stand.
const earlierOf = (entry) => (entry.figure === null ? null : readFigure(entry.figure, 'None'))

const wanted = (t, system) => [...t.points.values()].filter((row) => row.system === system)

// The rows of a system's table set against the oracle's by the identity of the point: [] when each charted point of the system has exactly one row and no row is of another point.
const rowProblems = (table, rows) => pairedBy('the rows', table.cells.filter((entry) => entry.cell === 'name' && entry.on).map((entry) => ({ id: entry.id })), rows, (line) => line.id, (row) => String(row.id)).problems

// Each check below reads the table of every system it was shown for, point by point.
const eachRow = (o, t, test) => {
  const wrong = []

  t.dataset.shown.filter((system) => o.systems[system]).forEach((system) => wanted(t, system).forEach((row) => {
    const problem = test(o.systems[system], row)

    if (problem !== true) {
      wrong.push([row.id, problem])
    }
  }))

  return wrong
}

const verdict = (wrong) => (wrong.length === 0 ? true : short(wrong.slice(0, 4)))

const PAGE_CHECKS = [
  ['rows', 'the table of a system has a row for each point the race has charted there and for no other, and nothing is drawn for a point it has not charted', (o, t) => {
    const { point, systems } = t.dataset
    const problems = t.dataset.shown.flatMap((system) => rowProblems(o.systems[system], wanted(t, system)).map((problem) => [system, ...problem]))
    const stray = t.dataset.shown.filter((system) => o.systems[system].cells.some((entry) => entry.on && entry.id === String(point.uncharted)))

    return (problems.length === 0 && stray.length === 0 && o.systems[systems.gates].panel && wanted(t, systems.gates).length >= 4) || short({ problems, stray })
  }],
  ['name', 'each row names its point by the number the game gives it among the charted points of the system, the system by its name and the far side by the name of the system beyond', (o, t) => verdict(eachRow(o, t, (table, row) => {
    const name = oneText(table, row.id, 'name')
    const number = name === null ? null : name === ENV.words.label(row.number) ? row.number : name
    const system = oneText(table, row.id, 'system')
    const beyond = oneName(table, row.id, 'beyond')
    const fallback = oneText(table, row.id, 'beyond')
    const far = row.beyond === null ? beyond === null && fallback !== null && fallback.trim() === ENV.words.far[row.explored ? 'uncharted' : 'unexplored'] : beyond === row.beyond

    return (number === row.number && system === row.systemName && far) || [name, system, beyond, fallback, row.number, row.systemName, row.beyond]
  }))],
  ['gate', 'the gate of each row is the one the save gives, read back through the module\'s own words', (o, t) => verdict(eachRow(o, t, (table, row) => {
    const key = labelKey(oneText(table, row.id, 'gate') || '', ENV.words.gate)

    return key === row.gate || [oneText(table, row.id, 'gate'), key, row.gate]
  }))],
  ['stabilisation', 'the stabilisation of each row is the state of the race\'s orders there, read back through the module\'s own words, with the fleets named under it and none for a point with no order', (o, t) => verdict(eachRow(o, t, (table, row) => {
    const key = labelKey(oneText(table, row.id, 'stabilisation') || '', ENV.words.stabilisation)
    const fleets = cellsOf(table, row.id, 'fleets')
    const named = fleets.length === 1 ? fleetsRead(fleets[0].text, row.fleets) : []

    return (key === row.state && JSON.stringify(named) === JSON.stringify(row.fleets)) || [oneText(table, row.id, 'stabilisation'), key, row.state, named, row.fleets]
  }))],
  ['distinct', 'a gate and its stabilisation are told apart: a gate with no order of the race reads as a gate and as no order, and a point with no gate and an order that has arrived reads as no gate and as arrived', (o, t) => {
    const read = (id) => {
      const table = o.systems[t.points.get(id).system]

      return { gate: labelKey(oneText(table, id, 'gate') || '', ENV.words.gate), state: labelKey(oneText(table, id, 'stabilisation') || '', ENV.words.stabilisation) }
    }
    const { point } = t.dataset
    const got = [read(point.contacts)]
    const want = [{ gate: 'own', state: 'none' }]

    if (t.dataset.cases.orders) {
      got.push(read(point.awaiting))
      want.push({ gate: 'none', state: 'awaiting' })
    }

    return JSON.stringify(got) === JSON.stringify(want) || short({ got, want })
  }],
  ['counts', 'the minefields and the buoys of each row are the figures SQL gives, 0 where the race has none there', (o, t) => verdict(eachRow(o, t, (table, row) => {
    const mines = countOf(oneText(table, row.id, 'minefields'))
    const buoys = countOf(oneText(table, row.id, 'buoys'))

    return (mines === row.mines && buoys === row.buoys) || [mines, row.mines, buoys, row.buoys]
  }))],
  ['probes', 'the probe count of each row is unknown, never a number', (o, t) => verdict(eachRow(o, t, (table, row) => {
    const probes = countOf(oneText(table, row.id, 'probes'))

    return probes === 'unknown' || [oneText(table, row.id, 'probes')]
  }))],
  ['detected', 'the objects detected of each row are the distinct objects the race holds a current contact of, none detected where there is none, and its earlier contacts are a caption of their own', (o, t) => verdict(eachRow(o, t, (table, row) => {
    const detected = detectedOf(oneText(table, row.id, 'detected'))
    const earlier = cellsOf(table, row.id, 'earlier')
    const caption = earlier.length === 1 ? earlierOf(earlier[0]) : 0

    return (detected === row.detected && (row.earlier > 0 ? caption === row.earlier : earlier.length === 0)) || [oneText(table, row.id, 'detected'), row.detected, earlier.map((entry) => entry.text), row.earlier]
  }))],
  ['listed', 'with the system cleared the list holds every point the race has charted, as many as SQL says', (o, t) => {
    const total = o.cleared.total === null ? null : readFigure(o.cleared.total, 'None')

    return (total !== null && total === t.charted && o.cleared.chip === null) || short({ total: o.cleared.total, chip: o.cleared.chip, charted: t.charted })
  }],
  ['map-select', 'the link of a row opens the map on its system with the point named in the route, and the side panel names that point by its number, its far side and its system, not another point of the system', (o, t) => {
    const row = t.points.get(t.dataset.point.contacts)
    const map = o.map

    return (row.beyond !== null && Boolean(map) && map.path === '/map' && map.query.system === String(row.system) && map.query.point === String(row.id) && map.label !== null && map.label.on && map.label.text === ENV.words.label(row.number) && map.far !== null && map.far.on && map.far.text === row.beyond && (markOf(map.mark) !== '') === (row.gate !== 'none') && map.system !== null && map.system.on && map.system.text === row.systemName && map.name !== null && map.name.on && map.detail !== null && map.detail.on) || short({ map, number: row.number })
  }],
  ['map-view', 'the System view opened from the side panel is titled with the point and is told the point', (o, t) => {
    const row = t.points.get(t.dataset.point.contacts)
    const view = o.view

    return (Boolean(view) && view.pointLabel !== null && view.pointLabel.on && view.pointLabel.text === ENV.words.label(row.number) && view.pointFar !== null && view.pointFar.on && view.pointFar.text === row.beyond && (markOf(view.pointMark) !== '') === (row.gate !== 'none') && markOf(view.pointMark) === markOf(o.map && o.map.mark) && view.systemName !== null && view.systemName.on && view.systemName.text === row.systemName && Number(view.told) === row.id) || short({ title: view && view.title, label: view && view.pointLabel, far: view && view.pointFar, mark: view && view.pointMark, system: view && view.systemName, told: view && view.told })
  }],
  ['map-unexplored', 'the side panel of a point whose far side is not charted names the unexplored marker of the places module as its far side and no system', (o, t) => {
    const row = t.points.get(t.dataset.point.unexplored)
    const map = o.unexplored

    return (row.beyond === null && Boolean(map) && map.path === '/map' && map.query.system === String(row.system) && map.query.point === String(row.id) && map.label !== null && map.label.on && map.label.text === ENV.words.label(row.number) && map.far !== null && map.far.on && map.far.text === ENV.words.farUnknown) || short({ map, beyond: row.beyond })
  }],
  ['map-reject', 'a point a link names that its system does not have is dropped from the route once the map has settled, and does not come back when the point\'s own system is picked on the map afterwards', (o, t) => {
    const row = t.points.get(t.dataset.point.awaiting)
    const { before, after } = o.rejected

    return (before.path === '/map' && before.query.system === String(t.dataset.systems.gates) && before.query.point === undefined && before.name === null && after.query.system === String(row.system) && after.query.point === undefined && after.name === null) || short({ before, after })
  }],
  ['no-errors', 'the page raises no error', (o) => (o.unexpected.length === 0 ? true : short(o.unexpected.slice(0, 3)))],
]

// The save lacking a column the infrastructure reads (`read`: what the page is waited for, see showSystem): the points are drawn and every figure that rests on the missing column is as the save can say it.
const observeLacking = (browser, url, truth, read) => observe(browser, async ({ page, step }) => {
  await openApp(page, url, step, truth.dataset.names)

  return { table: await showSystem(page, step, truth.dataset.systems.gates, truth.systemNames.get(truth.dataset.systems.gates), read) }
})

const LACKING_CHECKS = [
  ['lacking-unknown', 'a save lacking a column the salvos need still draws every point with its gate, and its stabilisation, minefields, buoys and detected objects read as unknown, never 0', (o, t) => {
    const table = o.table
    const rows = wanted(t, t.dataset.systems.gates)
    const wrong = rows.filter((row) => {
      const figures = ['stabilisation', 'minefields', 'buoys', 'probes', 'detected'].map((cell) => oneText(table, row.id, cell))

      return !figures.every((text) => isUnknown(text)) || labelKey(oneText(table, row.id, 'gate') || '', ENV.words.gate) !== row.gate
    }).map((row) => [row.id, ['stabilisation', 'minefields', 'buoys', 'probes', 'detected'].map((cell) => oneText(table, row.id, cell))])

    return (rowProblems(table, rows).length === 0 && wrong.length === 0) || short({ problems: rowProblems(table, rows), wrong: wrong.slice(0, 2) })
  }],
]

const BUILDER_CHECKS = [
  ['lacking-builders', 'a save lacking the column of the gate builder still draws every point: a gate reads as built by none recorded, no gate as no gate, and the stabilisation and the counts are the ones SQL gives', (o, t) => {
    const table = o.table
    const rows = wanted(t, t.dataset.systems.gates)
    const wrong = rows.filter((row) => labelKey(oneText(table, row.id, 'gate') || '', ENV.words.gate) !== (row.gate === 'none' ? 'none' : 'unrecorded') || labelKey(oneText(table, row.id, 'stabilisation') || '', ENV.words.stabilisation) !== row.state || countOf(oneText(table, row.id, 'minefields')) !== row.mines || countOf(oneText(table, row.id, 'buoys')) !== row.buoys).map((row) => [row.id, oneText(table, row.id, 'gate'), row.gate])
    const distinct = !t.dataset.cases.builders || (rows.some((row) => row.gate === 'own') && rows.some((row) => row.gate === 'other'))

    return (rowProblems(table, rows).length === 0 && wrong.length === 0 && distinct) || short({ problems: rowProblems(table, rows), wrong: wrong.slice(0, 2), distinct })
  }],
]

// ---------- the faults and the rewrites ----------

const swap = (from, to, count = 1) => {
  const change = (text) => {
    if (text.split(from).length !== count + 1) {
      throw new Error(`The variant must apply ${count === 1 ? 'exactly once' : `${count} times`} to the file: ${from}`)
    }

    return text.split(from).join(to)
  }

  change.patches = [{ from, to, count }]

  return change
}

/* eslint-disable no-template-curly-in-string */
const MODULE_FAULTS = [
  { name: 'a contact is counted once for each of its rows', file: MODULE, change: swap('contacts.set(contact.ContactID, { ...contact, dated, current })', 'contacts.set(contacts.size, { ...contact, dated, current })'), fails: ['m-detected', 'm-small-counts'] },
  { name: 'the contacts of the race\'s own salvos count as detected objects', file: MODULE, change: swap('facts.contacts.filter((contact) => !own.has(contact.ContactID))', 'facts.contacts.filter(() => true)'), fails: ['m-detected', 'm-small-counts'] },
  { name: 'every contact counts as current', file: MODULE, change: swap('|| (dated && contact.LastUpdate === facts.gameTime)', '|| contact.LastUpdate > 0'), fails: ['m-detected', 'm-small-counts'] },
  { name: 'a salvo of two rows counts twice', file: MODULE, change: swap('own.set(salvo.MissileSalvoID, salvo)', 'own.set(own.size, salvo)'), fails: ['m-small-counts'] },
  { name: 'a buoy counts as a mine', file: MODULE, change: swap('count((salvo) => salvo.SecondStageID > 0)', 'count((salvo) => salvo.SecondStageID >= 0)'), fails: ['m-counts', 'm-small-counts'] },
  { name: 'an object 100 km away is at the point', file: MODULE, change: swap('export const NEAR_KM = 1', 'export const NEAR_KM = 100'), fails: ['m-counts', 'm-small-counts'] },
  { name: 'a salvo of no known design counts as neither kind', file: MODULE, change: swap('const unclassified = mines.filter((salvo) => !Number.isFinite(salvo.SecondStageID))', 'const unclassified = []'), fails: ['m-small-unknown'] },
  { name: 'a gate with no builder recorded is the race\'s own', file: MODULE, change: swap("return builder > 0 ? (builder === RaceID ? 'own' : 'other') : 'unrecorded'", "return builder > 0 && builder !== RaceID ? 'other' : 'own'"), fails: ['m-gate', 'm-small-gates'] },
  { name: 'a gate whose builders are not read is the race\'s own', file: MODULE, change: swap('const builder = builders ? builders[point.WarpPointID] : null', 'const builder = builders ? builders[point.WarpPointID] : RaceID'), fails: ['m-small-gates'] },
  { name: 'a salvo with no position is taken as elsewhere', file: MODULE, change: swap('const unplacedOwn = ownHere.filter((salvo) => !hasPosition(salvo)).length', 'const unplacedOwn = 0'), fails: ['m-small-positions'] },
  { name: 'a detected salvo with no position is taken as elsewhere', file: MODULE, change: swap('const unplacedSeen = inSystem.filter((contact) => !hasPosition(contact)).length', 'const unplacedSeen = 0'), fails: ['m-small-positions'] },
  { name: 'an order with no arrival flag is a queued one', file: MODULE, change: swap('const arrivedKnown = [0, 1, true, false].includes(order.Arrived)', 'const arrivedKnown = true'), fails: ['m-small-arrival'] },
  { name: 'the probes are counted as 0', file: MODULE, change: swap("probes: unavailable({ rule: 'jumpInfrastructure.probes', missing: ['a probe type in the save'] })", "probes: ofRule({ rule: 'jumpInfrastructure.probes', value: 0, inputs: { present: ['the race\\'s ships'] } })"), fails: ['m-probes'] },
  { name: 'the order that is further along gives way to the earlier', file: MODULE, change: swap('STATE_RANK[state] > STATE_RANK[kept.state]', 'STATE_RANK[state] < STATE_RANK[kept.state]'), fails: ['m-orders', 'm-small-orders'] },
  { name: 'a save that cannot be read gives 0 for its counts', file: MODULE, change: swap("facts ? [] : missing.length ? missing : ['the infrastructure of the save']", '[]'), fails: ['m-small-unknown'] },
  { name: 'a missing game time reads every contact as earlier', file: MODULE, change: swap('const timeKnown = Boolean(facts) && Number.isFinite(facts.gameTime)', 'const timeKnown = Boolean(facts)'), fails: ['m-small-unknown'] },
  { name: 'an order not yet at the point is being stabilised', file: MODULE, change: swap("!arrived ? 'queued' : order.TimeRequired > 0", "!arrived ? 'running' : order.TimeRequired > 0"), fails: ['m-orders', 'm-small-orders'] },
  { name: 'the orders of every race are read', file: MODULE, change: swap(' and FCT_MoveOrders.RaceID = ${RaceID}', ''), fails: ['m-orders'] },
  { name: 'the salvos of every race are read', file: MODULE, change: swap('FCT_MissileSalvo.RaceID = ${RaceID} and ', ''), fails: ['m-small-counts'] },
  { name: 'the contacts of every kind are read', file: MODULE, change: swap('and FCT_Contacts.ContactType = 3 and ', 'and '), fails: ['m-detected', 'm-small-counts'] },
  { name: 'the contacts that move are read', file: MODULE, change: swap(' and FCT_Contacts.Speed = 0`', '`'), fails: ['m-detected', 'm-small-counts'] },
  { name: 'the points the race has not charted are read', file: GRAPH, change: swap(' and FCT_RaceJumpPointSurvey.Charted = 1\ninner join FCT_RaceSysSurvey', '\ninner join FCT_RaceSysSurvey'), fails: ['m-charted'] },
  { name: 'a contact with no update time is taken as an earlier one', file: MODULE, change: swap('const undatedSeen = seen.filter((contact) => !contact.dated).length', 'const undatedSeen = 0'), fails: ['m-small-dates'] },
  { name: 'a contact with a dated row beside an undated one stays undated', file: MODULE, change: swap('if (!kept || (dated && (!kept.dated || contact.LastUpdate > kept.LastUpdate))) {', 'if (!kept) {'), fails: ['m-small-dates'] },
]

const PAGE_FAULTS = [
  { name: 'the minefields cell draws the buoys', file: PAGE, change: swap('{{ item.minefieldsText }}', '{{ item.buoysText }}'), fails: ['counts'] },
  { name: 'a figure the save cannot give draws 0', file: PAGE, change: swap('text: value === null ? this.unknownText : known(value)', "text: value === null ? '0' : known(value)"), fails: ['probes'] },
  { name: 'a gate built by the race draws as a gate of another race', file: PAGE, change: swap('gateText: GATE_TEXT[row.gate],', "gateText: GATE_TEXT[row.gate === 'own' ? 'other' : row.gate],"), fails: ['gate'] },
  { name: 'an order on its way draws as being stabilised', file: PAGE, change: swap('const state = figure(row.stabilisation, (value) => STABILISATION_TEXT[value])', "const state = figure(row.stabilisation, (value) => STABILISATION_TEXT[value === 'queued' ? 'running' : value])"), fails: ['stabilisation'] },
  { name: 'the gate column draws the stabilisation', file: PAGE, change: swap('data-jump-cell="gate" :data-jump="item.WarpPointID">{{ item.gateText }}', 'data-jump-cell="gate" :data-jump="item.WarpPointID">{{ item.stabilisationText }}'), fails: ['gate', 'distinct'] },
  { name: 'the gate column is drawn at opacity 0', file: PAGE, change: swap('<span class="text-no-wrap" data-jump-cell="gate"', '<span class="text-no-wrap" style="opacity: 0" data-jump-cell="gate"'), fails: ['gate'] },
  { name: 'the objects detected count the earlier contacts too', file: PAGE, change: swap('(value) => (value === 0 ? DETECTED_ZERO_TEXT : this.count(value))', '(value) => (value + row.earlier === 0 ? DETECTED_ZERO_TEXT : this.count(value + row.earlier))'), fails: ['detected'] },
  { name: 'a count of 0 detected draws another label of the table', file: PAGE, change: swap('(value) => (value === 0 ? DETECTED_ZERO_TEXT : this.count(value))', '(value) => (value === 0 ? GATE_TEXT.none : this.count(value))'), fails: ['detected'] },
  { name: 'the earlier contacts are not drawn', file: PAGE, change: swap("earlierFigure: row.earlier > 0 ? this.count(row.earlier) : ''", "earlierFigure: ''"), fails: ['detected'] },
  { name: 'the earlier contacts draw one more than there are', file: PAGE, change: swap("earlierFigure: row.earlier > 0 ? this.count(row.earlier) : ''", "earlierFigure: row.earlier > 0 ? this.count(row.earlier + 1) : ''"), fails: ['detected'] },
  { name: 'the far side names the system of the point', file: PAGE, change: swap("beyondName: row.beyondSystemID ? systemName(row.beyondSystemID) : ''", "beyondName: row.beyondSystemID ? systemName(row.SystemID) : ''"), fails: ['name'] },
  { name: 'the table lists every system whatever is picked', file: PAGE, change: swap('return this.infrastructureRows.filter((row) => !this.selectedSystemId || row.SystemID === this.selectedSystemId)', 'return this.infrastructureRows'), fails: ['rows'] },
  { name: 'the points the race has not charted are listed', file: GRAPH, change: swap(' and FCT_RaceJumpPointSurvey.Charted = 1\ninner join FCT_RaceSysSurvey', '\ninner join FCT_RaceSysSurvey'), fails: ['rows'] },
  { name: 'the link of a row opens the system without the point', file: PAGE, change: swap(':to="linkTo.map(item.SystemID, item.WarpPointID)"', ':to="linkTo.map(item.SystemID)"'), fails: ['map-select'], map: true },
  { name: 'the map selects the first point of the system whatever the route names', file: MAP, change: swap('entry.jumpPoint.WarpPointID === this.pointId && ', ''), fails: ['map-select'], map: true },
  { name: 'the System view is told no point', file: MAP, change: swap(':jump-point-id="viewedPoint ? viewedPoint.jumpPoint.WarpPointID : null"', ':jump-point-id="null"'), fails: ['map-view'], map: true },
  { name: 'the gate builders are not given to the table', file: PAGE, change: swap('missing: this.infrastructureMissing, builders: this.jumpBuilders }', 'missing: this.infrastructureMissing, builders: null }'), fails: ['gate', 'distinct'] },
  { name: 'a point a link names is kept once the map has settled', file: MAP, change: swap('return this.ready && !this.pendingFocus && this.pointId !== null && !this.selectedPoint', 'return false'), fails: ['map-reject'], map: true },
  { name: 'a point a link names is dropped before the map has applied the link', file: MAP, change: swap('return this.ready && !this.pendingFocus && this.pointId !== null && !this.selectedPoint', 'return this.ready && this.pointId !== null && !this.selectedPoint'), fails: ['map-select'], map: true },
  { name: 'the fleets of a point list one fleet twice and leave another out', file: PAGE, change: swap("fleetsText: state.value === null ? '' : row.fleets.map((fleet) => fleet.FleetName || `Fleet #${fleet.FleetID}`).join(', '),", "fleetsText: state.value === null ? '' : row.fleets.map(() => row.fleets[0].FleetName || `Fleet #${row.fleets[0].FleetID}`).join(', '),"), fails: ['stabilisation'] },
  { name: 'the side panel draws the label of another point', file: MAP, change: swap('{{ selectedPoint.label }}', '{{ selectedPoint.label }}0'), fails: ['map-select'], map: true },
  { name: 'the System view title draws the label of another point', file: MAP, change: swap('{{ viewedPoint.label }}', '{{ viewedPoint.label }}0'), fails: ['map-view'], map: true },
  { name: 'the far side of a row is drawn with a longer name that begins with it', file: PAGE, change: swap("beyondName: row.beyondSystemID ? systemName(row.beyondSystemID) : ''", "beyondName: row.beyondSystemID ? `${systemName(row.beyondSystemID)}x` : ''"), fails: ['name'] },
  { name: 'the side panel draws the far side with a longer name that begins with it', file: MAP, change: swap('{{ selectedPoint.far }}', '{{ selectedPoint.far }}x'), fails: ['map-select'], map: true },
  { name: 'the side panel draws the system with a longer name that begins with it', file: MAP, change: swap('data-map-system-name>{{ panelSystem.Name }}', 'data-map-system-name>{{ panelSystem.Name }}x'), fails: ['map-select'], map: true },
  { name: 'the System view title draws the system with a longer name that begins with it', file: MAP, change: swap('{{ systemDialogName }}</span>', '{{ systemDialogName }}x</span>'), fails: ['map-view'], map: true },
  { name: 'the footer total is drawn with a mark after it', file: PAGE, change: swap('<span data-jump-total>{{ itemsLength }}</span>', '<span data-jump-total>{{ itemsLength }}x</span>'), fails: ['listed'] },
  { name: 'the footer total is one short', file: PAGE, change: swap('<span data-jump-total>{{ itemsLength }}</span>', '<span data-jump-total>{{ itemsLength - 1 }}</span>'), fails: ['listed'] },
  { name: 'the far side of a point not explored names a system in the table', file: PAGE, change: swap("beyondName: row.beyondSystemID ? systemName(row.beyondSystemID) : ''", 'beyondName: systemName(row.beyondSystemID || row.SystemID)'), fails: ['name'] },
  { name: 'the far side of a point not explored names a system in the side panel', file: PLACES, change: swap('systemName(partner.SystemID) : FAR_UNKNOWN_TEXT', 'systemName(partner.SystemID) : systemName(jumpPoint.SystemID)'), fails: ['map-unexplored'], map: true },
  { name: 'the far side of a point with no system draws a system in its place', file: PAGE, change: swap("beyond: row.beyondSystemID ? '' : FAR_SIDE_TEXT[row.explored ? 'uncharted' : 'unexplored'],", 'beyond: row.beyondSystemID ? \'\' : `Beyond: ${systemName(row.SystemID)}`,'), fails: ['name'] },
  { name: 'a far side explored but not charted draws as not explored', file: PAGE, change: swap("FAR_SIDE_TEXT[row.explored ? 'uncharted' : 'unexplored']", "FAR_SIDE_TEXT[row.explored ? 'unexplored' : 'uncharted']"), fails: ['name'] },
  { name: 'the minefields cell is hidden with v-show', file: PAGE, change: swap('<span :class="{ \'text--secondary\': item.minefieldsSort === null }" data-jump-cell="minefields"', '<span v-show="false" :class="{ \'text--secondary\': item.minefieldsSort === null }" data-jump-cell="minefields"'), fails: ['counts'] },
  { name: 'the name and far side of a row sit in a hidden ancestor', file: PAGE, change: swap('<div class="flex-grow-1">\n                  <div class="font-weight-medium" data-jump-cell="name"', '<div class="flex-grow-1" v-show="false">\n                  <div class="font-weight-medium" data-jump-cell="name"'), fails: ['name'] },
  { name: 'the slot of the detected column is not consumed', file: PAGE, change: swap('#[`item.detectedSort`]', '#[`item.detectedCount`]'), fails: ['detected'] },
  { name: 'the slot of the footer text is not consumed', file: PAGE, change: swap('#[`footer.page-text`]', '#[`footer.page-texts`]'), fails: ['listed'] },
  { name: 'the selected point of the side panel sits in a hidden ancestor', file: MAP, change: swap('<div v-if="selectedPoint" class="selected-point" data-map-point>', '<div v-if="selectedPoint" v-show="false" class="selected-point" data-map-point>'), fails: ['map-select'], map: true },
  { name: 'the side panel leaves out the mark of a stabilised point', file: MAP, change: swap('<span data-map-point-mark>{{ selectedPoint.mark }}</span>', '<span data-map-point-mark></span>'), fails: ['map-select'], map: true },
  { name: 'the System view title draws the far side with a longer name that begins with it', file: MAP, change: swap('{{ viewedPoint.far }}', '{{ viewedPoint.far }}x'), fails: ['map-view'], map: true },
  { name: 'the System view title leaves out the mark of a stabilised point', file: MAP, change: swap('<span data-system-point-mark>{{ viewedPoint.mark }}</span>', '<span data-system-point-mark></span>'), fails: ['map-view'], map: true },
]

const PAGE_BENIGN = [
  { name: 'the table\'s page size bound by an explicit value and event', file: PAGE, change: swap(':items-per-page.sync="infrastructureTable.itemsPerPage"', ':items-per-page="infrastructureTable.itemsPerPage" @update:items-per-page="infrastructureTable.itemsPerPage = $event"') },
  { name: 'the chip listening by the longhand of the event', file: PAGE, change: swap('@click:close="selectedSystemId = null"', 'v-on:click:close="selectedSystemId = null"', 2) },
  { name: 'the far side with its qualifier after the name', file: PAGE, words: true, change: swap('Beyond: <span data-jump-name>{{ item.beyondName }}</span>', '<span data-jump-name>{{ item.beyondName }}</span> beyond') },
  { name: 'the zero of the detected objects in other words', file: MODULE, words: true, change: swap("export const DETECTED_ZERO_TEXT = 'None detected'", "export const DETECTED_ZERO_TEXT = 'Nothing detected'") },
  { name: 'the zero of the detected objects with its qualifier first', file: MODULE, words: true, change: swap("export const DETECTED_ZERO_TEXT = 'None detected'", "export const DETECTED_ZERO_TEXT = 'Detected: none'") },
  { name: 'the jump point label of the places in other words', file: PLACES, words: true, map: true, change: swap('export const jumpPointLabel = (number) => `JP${number}`', 'export const jumpPointLabel = (number) => `Point ${number}`') },
  { name: 'the stabilisation drawn under a parenthesised condition', file: PAGE, change: swap('v-if="item.stabilisationText"', 'v-if="(item.stabilisationText)"') },
  { name: 'the unknown word in another word that begins like a word of zero', file: MODULE, words: true, change: swap("export const UNKNOWN_TEXT = 'Unknown'", "export const UNKNOWN_TEXT = 'No data'") },
  { name: 'the earlier contacts with the qualifier before the figure', file: PAGE, words: true, change: swap('<span data-jump-figure>{{ item.earlierFigure }}</span> earlier {{ item.earlierNoun }}</div>', 'Earlier contacts: <span data-jump-figure>{{ item.earlierFigure }}</span></div>') },
  { name: 'the fleets of a point joined by a semicolon', file: PAGE, words: true, change: swap("fleetsText: state.value === null ? '' : row.fleets.map((fleet) => fleet.FleetName || `Fleet #${fleet.FleetID}`).join(', '),", "fleetsText: state.value === null ? '' : row.fleets.map((fleet) => fleet.FleetName || `Fleet #${fleet.FleetID}`).join('; '),") },
  { name: 'the footer total before the range it is of', file: PAGE, change: swap('{{ pageStart }}-{{ pageStop }} of <span data-jump-total>{{ itemsLength }}</span>', '<span data-jump-total>{{ itemsLength }}</span> in all, shown {{ pageStart }}-{{ pageStop }}') },
  { name: 'the marker of a far side not explored in other words', file: PLACES, words: true, map: true, change: swap("export const FAR_UNKNOWN_TEXT = 'Unex'", "export const FAR_UNKNOWN_TEXT = 'Not explored'") },
  { name: 'the words for a far side with no system in other words', file: MODULE, words: true, change: swap("unexplored: 'Unexplored',", "unexplored: 'Not yet explored',") },
]

const PAGE_COMPOSITE_A = { key: 'benign:composite-a', name: 'the composed page rewrites with the map still structurally the same', rewrites: PAGE_BENIGN.filter((_, index) => [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12].includes(index)), map: true, words: true }

const MODULE_BENIGN = [
  { name: 'the time condition of the module parenthesised', file: MODULE, change: swap('const timeKnown = Boolean(facts) && Number.isFinite(facts.gameTime)', 'const timeKnown = (Boolean(facts) && Number.isFinite(facts.gameTime))') },
  { name: 'the builder test of the gate in two conditions', file: MODULE, change: swap("return builder > 0 ? (builder === RaceID ? 'own' : 'other') : 'unrecorded'", "return builder > 0 && builder === RaceID ? 'own' : builder > 0 ? 'other' : 'unrecorded'") },
  { name: 'the arrival flag of an order spelled out', file: MODULE, change: swap('const arrivedKnown = [0, 1, true, false].includes(order.Arrived)', 'const arrivedKnown = order.Arrived === 0 || order.Arrived === 1 || order.Arrived === true || order.Arrived === false') },
  { name: 'the reasons of the unknown figures in other words', file: MODULE, change: (text) => swap('the position of ${unplacedSeen} detected', 'the location of ${unplacedSeen} detected')(swap('the position of ${unplacedOwn} stationary', 'the location of ${unplacedOwn} stationary')(swap('whether an order has arrived, or the time required of one that has', 'whether an order reached its target, or the time required of one that did')(text))) },
]

const LACKING_FAULTS = [
  { name: 'a figure the save cannot give draws 0 where a column is lacking', file: PAGE, change: swap('text: value === null ? this.unknownText : known(value)', "text: value === null ? '0' : known(value)"), fails: ['lacking-unknown'] },
]

const BUILDER_FAULTS = [
  { name: 'a gate whose builder column is lacking is the race\'s own', file: MODULE, change: swap('const builder = builders ? builders[point.WarpPointID] : null', 'const builder = builders ? builders[point.WarpPointID] : RaceID'), fails: ['lacking-builders'] },
]

// The saves lacking a column, by the kind of the variant: the statement that drops it, what the page is waited for, the words naming it, the checks and the faults.
const LACKS = {
  salvos: { key: 'lacking', drop: 'alter table FCT_MissileSalvo drop column MissileSpeed', read: false, label: 'FCT_MissileSalvo.MissileSpeed', checks: LACKING_CHECKS, faults: LACKING_FAULTS },
  builders: { key: 'lacking-builders', drop: 'alter table FCT_JumpPoint drop column JumpGateRaceID', read: 'facts', label: 'FCT_JumpPoint.JumpGateRaceID', checks: BUILDER_CHECKS, faults: BUILDER_FAULTS },
}
/* eslint-enable no-template-curly-in-string */

// The cases a planted fault is only told from the page as it is where the dataset holds them: the figure the fault changes is the same with it and without it when the save holds none of the case. A dataset that lacks one has the fault run on the recorded campaign alone, and the head of the dataset says so.
const NEEDS = {
  orders: ['the order that is further along gives way to the earlier', 'an order not yet at the point is being stabilised', 'the orders of every race are read', 'an order on its way draws as being stabilised', 'the fleets of a point list one fleet twice and leave another out'],
  salvos: ['a buoy counts as a mine', 'an object 100 km away is at the point', 'the minefields cell draws the buoys'],
  contacts: ['a contact is counted once for each of its rows', "the contacts of the race's own salvos count as detected objects", 'every contact counts as current', 'the contacts of every kind are read', 'the contacts that move are read', 'the objects detected count the earlier contacts too', 'the earlier contacts are not drawn', 'the earlier contacts draw one more than there are'],
  builders: ["a gate with no builder recorded is the race's own"],
  farUncharted: ['a far side explored but not charted draws as not explored'],
}

// Puts the cases of NEEDS on the faults that name them: `needs` is the list of cases of a fault.
const applyNeeds = () => {
  const faults = [...MODULE_FAULTS, ...PAGE_FAULTS, ...LACKING_FAULTS, ...BUILDER_FAULTS]

  for (const [key, names] of Object.entries(NEEDS)) {
    for (const name of names) {
      const named = faults.filter((fault) => fault.name === name)

      if (named.length !== 1) {
        throw new HarnessError(`the fault "${name}" that needs the case ${key} is not exactly one of the planted faults`)
      }

      named[0].needs = [...(named[0].needs || []), key]
    }
  }
}

// The checks a fault is judged by on a dataset with the cases `cases`: the checks it names that the run on the dataset holds (the checks of the small save written here are the same on every dataset, and run on the recorded campaign), none when it needs a case the dataset lacks.
const failsOn = (fault, cases) => ((fault.needs || []).every((key) => cases[key]) ? fault.fails.filter((id) => !id.startsWith('m-small-')) : [])

// ---------- the results ----------

// The results of `list` over the observation `o` (and the oracle `t`): { id, name, result, kind }; a check fails by a value (kind 'assertion'); a check that throws stops the run.
const judge = (o, t, list, ids = null) => list.filter(([id]) => !ids || ids.includes(id)).map(([id, name, test]) => {
  let result = null

  try {
    result = test(o, t)
  } catch (error) {
    throw new HarnessError(`the check ${id} threw: ${error && error.message ? error.message : error}`)
  }

  return { id, name, result, kind: result === true ? null : 'assertion' }
})

// The results of the page checks over a record of `observe`: the screens read, or a HarnessError when the record has none and `strict`.
const pageResults = (seen, truth, { ids = null, strict = true, label = 'the observation', list = PAGE_CHECKS } = {}) => {
  validate(seen, label)

  if (unobserved(seen)) {
    if (strict) {
      throw new HarnessError(`${label} did not get through: ${failureLine(seen)}`)
    }

    return list.filter(([id]) => !ids || ids.includes(id)).map(([id, name]) => ({ id, name, result: failureLine(seen), kind: 'unobserved' }))
  }

  return judge({ ...seen.value, unexpected: seen.unexpected }, truth, list, ids)
}

// ---------- the run ----------

let ENV = null
const cleanups = []
let checks = 0
let failures = 0

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

// What a report says of the dataset it ran on: nothing on the recorded campaign (whose reports keep their names), the label of the dataset on the fixture.
const datasetNote = () => (ENV.dataset.key === 'campaign' ? '' : ` (on ${ENV.dataset.label})`)

const reportFault = (fault, results) => {
  report(`fault caught: ${fault.name}${datasetNote()}`, caughtAll(results, { name: fault.name }) ? true : notCaught(results), `fails ${fault.fails.join(', ')}`)

  if (DETAIL) {
    results.forEach(({ id, result }) => console.log(`         ${id}: ${result === true ? 'holds' : result}`))
  }
}

const told = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }

  return seen
}

// The page with `fault` made to it (a file replaced in the page server), read as a player uses it.
const view = async (fault, options = {}) => {
  if (fault) {
    ENV.server.replace(fault.file, fault.change(ENV.original[fault.file]))
  }

  try {
    return told(fault ? 'a variant of the page' : 'the page', await observePage(ENV.chrome, ENV.server.url, ENV.truth, options))
  } finally {
    if (fault) {
      ENV.server.replace(fault.file, null)
    }
  }
}

const moduleView = (fault) => observeModule(fault ? { [fault.file]: fault.change } : {})

// The controls of the readers the checks use: they hold whatever the dataset, and are run on the recorded campaign.
const checkControls = (o) => {
  const control = judge(o, ENV.truth, [['planted', 'a check that fails by its own value', () => 'what was seen']])

  report('control: a check that fails by its own verdict credits a fault named for it, and one that holds does not', caughtAll(control) && !caughtAll(judge(o, ENV.truth, [['holds', 'a check that holds', () => true]])) ? true : 'the credit of a fault does not follow the verdict')

  const words = ENV.words

  try {
    ENV.words = { ...words, unknown: 'No data', zero: 'None detected' }

    const read = [detectedOf('No data'), detectedOf('None detected'), detectedOf('No gate'), detectedOf('3'), countOf('No data'), countOf('0')]

    ENV.words = { ...words, unknown: 'Unknown', zero: 'Detected: none' }

    read.push(detectedOf('Detected: none'), detectedOf('None detected'), detectedOf('Unknown'))

    report('control: the reader of the detected cell takes the module\'s own words, the unknown figure first and then the word of zero exactly: an unknown figure and an unrelated label never read as a zero count, and a zero said in other words does', JSON.stringify(read) === JSON.stringify(['unknown', 0, null, 3, 'unknown', 0, 0, null, 'unknown']) ? true : `read ${JSON.stringify(read)}`)
  } finally {
    ENV.words = words
  }

  const fleets = [fleetsRead('Alpha, Bravo', ['Alpha', 'Bravo']), fleetsRead('Bravo; Alpha', ['Alpha', 'Bravo']), fleetsRead('Alpha, Alpha', ['Alpha', 'Bravo']), fleetsRead('Bravo, Bravo', ['Alpha', 'Bravo']), fleetsRead('Alpha', ['Alpha', 'Bravo']), fleetsRead('Alpha 2, Alpha', ['Alpha', 'Alpha 2']), fleetsRead('Alpha, Alpha', ['Alpha', 'Alpha'])]

  report('control: the reader of the fleets under a stabilisation takes each expected name the number of times it is expected, whatever the separators, and no other text', JSON.stringify(fleets) === JSON.stringify([['Alpha', 'Bravo'], ['Alpha', 'Bravo'], ['Alpha, Alpha'], ['Bravo, Bravo'], ['Alpha'], ['Alpha', 'Alpha 2'], ['Alpha', 'Alpha']]) ? true : `read ${JSON.stringify(fleets)}`)
}

// What the fixture cannot exercise, printed as skipped: each case the save does not hold with the checks left without it, and the planted faults that are run on the recorded campaign alone.
const printSkips = (dataset, where) => {
  for (const lack of dataset.missing) {
    console.log(`SKIP  ${where}: ${lack.name}: needs tier b: ${lack.reason}; no case of it for the checks ${lack.checks.join(', ')}, which still compare each figure with SQL`)
  }

  const faults = [...MODULE_FAULTS, ...PAGE_FAULTS, ...LACKING_FAULTS, ...BUILDER_FAULTS]
  const small = faults.filter((fault) => fault.fails.every((id) => id.startsWith('m-small-')))
  const needing = faults.filter((fault) => !small.includes(fault) && failsOn(fault, dataset.cases).length === 0)

  console.log(`SKIP  ${where}: ${needing.length} of the ${faults.length} planted faults need a case this save does not hold (${[...new Set(needing.flatMap((fault) => fault.needs.filter((key) => !dataset.cases[key])))].join(', ')}) and ${small.length} are judged on the small save written here alone, so they run on the recorded campaign`)
}

const checkHead = async () => {
  const { dataset } = ENV.truth
  const campaign = dataset.key === 'campaign'
  const where = `on ${dataset.label}`
  const o = await observeModule({})

  judge(o, ENV.truth, MODULE_CHECKS.filter(([id]) => campaign || !id.startsWith('m-small-'))).forEach(({ name, result }) => report(`${name} (${where})`, result))

  if (campaign) {
    checkControls(o)
  }

  const seen = await view(null)

  pageResults(seen, ENV.truth, { strict: false, label: `the page ${where}` }).forEach(({ name, result }) => report(`${name} (${where})`, result))

  if (!campaign) {
    console.log(`INFO  ${where}: the tables are read for the systems ${dataset.shown.join(', ')} (the system ${dataset.systems.gates} holds ${wanted(ENV.truth, dataset.systems.gates).length} charted points, ${wanted(ENV.truth, dataset.systems.gates).filter((row) => row.gate !== 'none').length} with a gate); the map cases use the points ${dataset.point.contacts} (a gate whose far side is charted), ${dataset.point.unexplored} (far side not charted) and ${dataset.point.awaiting} (no gate, in another system), and ${dataset.point.uncharted} is a point of a known system that the race has not charted (${ENV.truth.charted} charted points in all)`)
    printSkips(dataset, where)
  }
}

const checkModuleFault = async (fault) => {
  refusePlanting(fault.name)
  reportFault(fault, judge(await moduleView(fault), ENV.truth, MODULE_CHECKS, fault.fails))
}

const checkModuleBenign = async (rewrite) => {
  const wrong = judge(await moduleView(rewrite), ENV.truth, MODULE_CHECKS).filter(({ result }) => result !== true).map(({ id }) => id)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0 ? true : `fails ${wrong.join(', ')}`)
}

const checkFault = async (fault) => {
  refusePlanting(fault.name)
  reportFault(fault, pageResults(await view(fault, { map: Boolean(fault.map) }), ENV.truth, { ids: fault.fails, label: `the page with the fault "${fault.name}"` }))
}

const checkBenign = async (rewrite) => {
  if (unobserved(ENV.baseline)) {
    throw new HarnessError(`the page as it is was not observed, so the rewrite has no screen to be set against: ${failureLine(ENV.baseline)}`)
  }

  const words = ENV.words

  ENV.words = MODULE_FILES.includes(rewrite.file) ? wordsOf(await loadModules({ [rewrite.file]: rewrite.change })) : words

  let seen
  let wrong

  try {
    seen = await view(rewrite, { map: Boolean(rewrite.map) })
    wrong = pageResults(seen, ENV.truth, { label: `the page rewritten as "${rewrite.name}"`, ids: PAGE_CHECKS.map(([id]) => id).filter((id) => rewrite.map || !id.startsWith('map-')) }).filter(({ result }) => result !== true).map(({ id }) => id)
  } finally {
    ENV.words = words
  }

  const shape = (value) => JSON.stringify(Object.values(value.systems).map((table) => table.cells.map((entry) => [entry.id, entry.cell, entry.on])))
  const same = rewrite.words ? shape(seen.value) === shape(ENV.baseline.value) : JSON.stringify(seen.value) === JSON.stringify(ENV.baseline.value)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0 && same ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the screen it draws is not the page\'s')
}

const composeBenign = (rewrites) => {
  const byFile = new Map()

  for (const rewrite of rewrites) {
    const sourceText = ENV.original[rewrite.file]
    const patches = rewrite.change.patches

    if (!Array.isArray(patches) || !patches.length) {
      throw new HarnessError(`the benign rewrite "${rewrite.name}" has no source patch catalog`)
    }

    const individual = patches.reduce((text, patch) => {
      const count = text.split(patch.from).length - 1

      if (count !== patch.count) {
        throw new HarnessError(`the anchor of "${rewrite.name}" occurs ${count} times, expected ${patch.count}: ${patch.from}`)
      }

      return text.split(patch.from).join(patch.to)
    }, sourceText)

    if (individual !== rewrite.change(sourceText)) {
      throw new HarnessError(`the patch catalog for "${rewrite.name}" differs from its original rewrite`)
    }

    byFile.set(rewrite.file, [...(byFile.get(rewrite.file) || []), ...patches.map((patch) => ({ ...patch, name: rewrite.name }))])
  }

  const sources = {}

  for (const [file, patches] of byFile) {
    const sourceText = ENV.original[file]
    const edits = []

    for (const patch of patches) {
      const starts = []
      let at = 0

      while ((at = sourceText.indexOf(patch.from, at)) !== -1) {
        starts.push(at)
        at += patch.from.length
      }

      if (starts.length !== patch.count) {
        throw new HarnessError(`the anchor of "${patch.name}" occurs ${starts.length} times, expected ${patch.count}: ${patch.from}`)
      }

      starts.forEach((start) => edits.push({ start, end: start + patch.from.length, to: patch.to, name: patch.name }))
    }

    const ordered = edits.sort((a, b) => a.start - b.start)

    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index].start < ordered[index - 1].end) {
        throw new HarnessError(`the benign source patches "${ordered[index - 1].name}" and "${ordered[index].name}" overlap in ${file}`)
      }
    }

    sources[file] = [...ordered].reverse().reduce((text, edit) => `${text.slice(0, edit.start)}${edit.to}${text.slice(edit.end)}`, sourceText)
    require('./lib/mutant-source').assertParses(file, sources[file])
  }

  return sources
}

const viewWithSources = async (sources, options = {}) => {
  const applied = []
  const problems = []
  let seen
  let failure = null

  try {
    for (const [file, text] of Object.entries(sources)) {
      applied.push(file)
      ENV.server.replace(file, text)
    }

    seen = told('the page with composed benign rewrites', await observePage(ENV.chrome, ENV.server.url, ENV.truth, options))
  } catch (error) {
    failure = error
  } finally {
    for (const file of applied.reverse()) {
      try {
        ENV.server.replace(file, null)
      } catch (error) {
        problems.push(`${file}: ${error && error.message ? error.message : error}`)
      }
    }
  }

  if (failure && problems.length) {
    throw new HarnessError(`composed benign observation failed: ${failure && failure.message ? failure.message : failure}; cleanup failed: ${problems.join(' | ')}`)
  }

  if (failure) {
    throw failure
  }

  if (problems.length) {
    throw new HarnessError(`composed benign cleanup failed: ${problems.join(' | ')}`)
  }

  return seen
}

const checkPageComposite = async () => {
  if (unobserved(ENV.baseline)) {
    throw new HarnessError(`the page as it is was not observed, so the rewrite has no screen to be set against: ${failureLine(ENV.baseline)}`)
  }

  const rewrites = PAGE_COMPOSITE_A.rewrites
  const sources = composeBenign(rewrites)
  const moduleChanges = Object.fromEntries(Object.entries(sources).filter(([file]) => MODULE_FILES.includes(file)).map(([file, text]) => [file, () => text]))
  const words = ENV.words
  let seen
  let wrong

  try {
    ENV.words = wordsOf(await loadModules(moduleChanges))
    seen = await viewWithSources(sources, { map: true })
    wrong = pageResults(seen, ENV.truth, { label: `the page with ${PAGE_COMPOSITE_A.name}`, list: PAGE_CHECKS }).filter(({ result }) => result !== true).map(({ id }) => id)
  } finally {
    ENV.words = words
  }

  const shape = (value) => JSON.stringify(Object.values(value.systems).map((table) => table.cells.map((entry) => [entry.id, entry.cell, entry.on])))
  const same = shape(seen.value) === shape(ENV.baseline.value)

  report(`variant passes: ${PAGE_COMPOSITE_A.name}${datasetNote()}`, wrong.length === 0 && same ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the page and map structure differs from the head')
}

// A save lacking a column: served from now until the reset after the variant.
const lackingView = async (kind, fault) => {
  const lack = LACKS[kind]

  if (!ENV.lackingFiles[kind]) {
    const lacking = await saveCopy(`ae-jump-infrastructure-lacking-${kind}-`, [...ENV.statements, lack.drop], ENV.dataset.source)

    cleanups.push(async () => fs.rmSync(lacking.folder, { recursive: true, force: true }))
    ENV.lackingFiles[kind] = lacking.file
  }

  await ENV.server.useSave(ENV.lackingFiles[kind])

  if (fault) {
    ENV.server.replace(fault.file, fault.change(ENV.original[fault.file]))
  }

  try {
    return told(`the save lacking ${lack.label}`, await observeLacking(ENV.chrome, ENV.server.url, ENV.truth, lack.read))
  } finally {
    if (fault) {
      ENV.server.replace(fault.file, null)
    }
  }
}

const checkLackingHead = async (kind) => {
  pageResults(await lackingView(kind, null), ENV.truth, { strict: false, label: `the save lacking ${LACKS[kind].label}`, list: LACKS[kind].checks }).forEach(({ name, result }) => report(`${name}${datasetNote()}`, result))
}

const checkLackingFault = async (kind, fault) => {
  refusePlanting(fault.name)
  reportFault(fault, pageResults(await lackingView(kind, fault), ENV.truth, { ids: fault.fails, label: `the save lacking ${LACKS[kind].label} with the fault "${fault.name}"`, list: LACKS[kind].checks }))
}

// What a worker sets up once before its first variant: the copy of the save of its dataset with the cases written into it (the recorded campaign only), the oracle's reading of it, the words of the module's tables, the texts of the files a variant may change, and one page server over the copy, warmed, with one Chromium.
const setUp = async (dataset) => {
  const { startPageServer } = require('./lib/page-server')
  const statements = await dataset.statements(dataset.base)
  const copy = await saveCopy('ae-jump-infrastructure-', statements, dataset.source)

  cleanups.push(async () => fs.rmSync(copy.folder, { recursive: true, force: true }))

  const env = { dataset, statements, copy, truth: await truthOf(copy.file, dataset), words: wordsOf(await loadModules()), original: {}, lackingFiles: {}, baseline: null }

  for (const file of [PAGE, MAP, GRAPH, MODULE, PLACES]) {
    env.original[file] = source(file)
  }

  env.server = await startPageServer({ save: copy.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/lagrange'] })

  console.log(`INFO  the page server warmed on ${dataset.label} in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// The deadlines, in seconds.
const DEADLINES = { head: 300, module: 120, view: 240, setup: 900 + 180 }
const CONTROL_FAULT = 'the minefields cell draws the buoys'

// A variant on the dataset `key`: the dataset is its pool, so that a worker (which keeps one page server, for the one save the page-server middleware is loaded for) runs variants of one dataset only.
const on = (key, variant) => ({ ...variant, pool: key })

const variantsOf = (doMutations, lacking, explicitSelection) => {
  applyNeeds()

  const cases = doMutations ? fixtureDataset().cases : null
  // The faults of a list that the fixture's run judges, each with the checks it is judged by there and the place it has in its list.
  const there = (list) => list.map((fault, index) => ({ fault, index, fails: failsOn(fault, cases) })).filter(({ fails }) => fails.length > 0)
  const pageBenign = doMutations ? explicitSelection ? [
    ...PAGE_BENIGN.map((rewrite, index) => on('campaign', { key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nvariants that say the same thing', deadline: DEADLINES.view, baseline: true, run: () => checkBenign(rewrite) })),
    on('campaign', { key: PAGE_COMPOSITE_A.key, name: `variant passes: ${PAGE_COMPOSITE_A.name}`, heading: '\ncomposed variants that say the same thing', deadline: DEADLINES.view, baseline: true, run: checkPageComposite }),
  ] : [
    on('campaign', { key: PAGE_COMPOSITE_A.key, name: `variant passes: ${PAGE_COMPOSITE_A.name}`, heading: '\ncomposed variants that say the same thing', deadline: DEADLINES.view, baseline: true, run: checkPageComposite }),
    on('campaign', { key: 'benign:4', name: `variant passes: ${PAGE_BENIGN[4].name}`, heading: '\nvariants that say the same thing', deadline: DEADLINES.view, baseline: true, run: () => checkBenign(PAGE_BENIGN[4]) }),
  ] : []
  const moduleBenign = doMutations ? MODULE_BENIGN : []

  return [
    on('fixture', { key: 'head:fixture', name: 'the head on the fixture: the module and the table on the page as they are', head: true, heading: 'The jump point infrastructure table on the fixture (scripts/lib/page-server.js over a copy of the save of scripts/lib/fixtures.js)', deadline: DEADLINES.head, run: checkHead }),
    ...(doMutations ? there(MODULE_FAULTS).map(({ fault, index, fails }) => on('fixture', { key: `fixture-module-fault:${index}`, name: `fault caught: ${fault.name} (on the fixture)`, heading: '\nplanted faults of the module, on the fixture', deadline: DEADLINES.module, run: () => checkModuleFault({ ...fault, fails }) })) : []),
    ...(doMutations ? there(PAGE_FAULTS).map(({ fault, index, fails }) => on('fixture', { key: `fixture-fault:${index}`, name: `fault caught: ${fault.name} (on the fixture)`, heading: '\nplanted faults of the page, on the fixture', deadline: DEADLINES.view, run: () => checkFault({ ...fault, fails }) })) : []),
    ...(doMutations ? [on('fixture', { key: `fixture-${PAGE_COMPOSITE_A.key}`, name: `variant passes: ${PAGE_COMPOSITE_A.name} (on the fixture)`, heading: '\ncomposed variants that say the same thing, on the fixture', deadline: DEADLINES.view, baseline: true, run: checkPageComposite })] : []),
    ...(lacking ? Object.entries(LACKS).map(([kind, lack]) => on('fixture', { key: `fixture-${lack.key}`, name: `the head on the fixture: a save lacking ${lack.label}`, head: true, heading: `\nA save lacking ${lack.label}, on the fixture`, deadline: DEADLINES.view, run: () => checkLackingHead(kind) })) : []),
    ...(lacking && doMutations ? Object.entries(LACKS).flatMap(([kind, lack]) => there(lack.faults).map(({ fault, index, fails }) => on('fixture', { key: `fixture-${lack.key}-fault:${index}`, name: `fault caught: ${fault.name} (on the fixture)`, heading: `\nA save lacking ${lack.label}, on the fixture`, deadline: DEADLINES.view, run: () => checkLackingFault(kind, { ...fault, fails }) }))) : []),
    on('campaign', { key: 'head:campaign', name: 'the head on the recorded campaign: the module and the table on the page as they are (a regression input, not a fixture run)', head: true, heading: '\nThe jump point infrastructure table on the recorded campaign (the cases of the table written into a copy of it)', deadline: DEADLINES.head, run: checkHead }),
    ...(doMutations ? MODULE_FAULTS.map((fault, index) => on('campaign', { key: `module-fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the module', deadline: DEADLINES.module, run: () => checkModuleFault(fault) })) : []),
    ...moduleBenign.map((rewrite, index) => on('campaign', { key: `module-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the module that say the same thing', deadline: DEADLINES.module, run: () => checkModuleBenign(rewrite) })),
    ...(doMutations ? PAGE_FAULTS.map((fault, index) => on('campaign', { key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the page', deadline: DEADLINES.view, run: () => checkFault(fault) })) : []),
    ...pageBenign,
    ...(lacking ? Object.entries(LACKS).map(([kind, lack]) => on('campaign', { key: lack.key, name: `the head: a save lacking ${lack.label}`, head: true, heading: `\nA save lacking ${lack.label}`, deadline: DEADLINES.view, run: () => checkLackingHead(kind) })) : []),
    ...(lacking && doMutations ? Object.entries(LACKS).flatMap(([kind, lack]) => lack.faults.map((fault, index) => on('campaign', { key: `${lack.key}-fault:${index}`, name: `fault caught: ${fault.name}`, heading: `\nA save lacking ${lack.label}`, deadline: DEADLINES.view, run: () => checkLackingFault(kind, fault) }))) : []),
  ]
}

const main = async () => {
  const doMutations = mutating()
  const explicitSelection = process.argv.some((argument) => argument.startsWith('--variants=') || argument.startsWith('--only=') || argument.startsWith('--worker='))
  const totals = await runSuite({
    script: __filename,
    workers: 4,
    inputs: [CAMPAIGN_SAVE, FIXTURE.file],
    variants: variantsOf(doMutations, !process.argv.includes('--no-lacking'), explicitSelection),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      ENV = await setUp(DATASETS[queue[0].pool]())

      if (queue.some((variant) => variant.baseline)) {
        ENV.baseline = await view(null, { map: false })
      }
    },
    afterEach: async () => {
      if (ENV && ENV.server) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      const problems = []

      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch((error) => problems.push(String(error && error.message ? error.message : error).split('\n')[0]))
      }

      if (problems.length) {
        throw new Error(`cleanups failed: ${problems.join(' | ')}`)
      }
    },
    control: doMutations ? { fault: `fault:${PAGE_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'head:campaign', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
