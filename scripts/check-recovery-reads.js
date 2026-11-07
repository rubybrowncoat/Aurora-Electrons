/*
  Checks the recovery reads the 3.1 rules ask for: a wreck that keeps components or minerals after an incomplete salvage stays a wreck of the ledger, a life pod with no crew and officers aboard is read as officer-only, a pod or a wreck tied to a body or a Lagrange point is the same object while its coordinates are rewritten, a status and an observation kept before that are carried to the new names where the object is the one kept and never guessed where it is not, no cargo row of 0 shows, and a ShipID given again is another ship in history and in the snooze records (src/renderer/utilities/recovery-ledger.js, utilities/observations.js, utilities/observation-view.js, utilities/warnings/space.js, utilities/place-data.js, utilities/arks.js, utilities/history-milestones.js, utilities/warnings/snoozes.js, utilities/capabilities.js; components/map/RecoveryLedger.vue; mixins/recovery-ledger.js).

  Run: bun scripts/check-recovery-reads.js [--no-mutations]

  The rules are the game's, written here from the game's rules, never read from the modules, and every case is planted: the migrated fixture (saves/AuroraDB-310-spookyerol-migrated.db, game 141, race 784) holds no life pod, no ordnance, no wreck of the race and no wreck that was salvaged in part, and no save played under 3.1 will be supplied (the owner's decision Q7 of AE-31), so each case is a copy of the fixture held in memory with the rows the game's own loaders and savers read and write:
  - a life pod is a row of FCT_Lifepods with the fourteen columns the game's loader reads and its saver writes, among them OrbitBodyID and OrbitLagrangeID (the body or the Lagrange point it is tied to, 0 for neither) and the crew; an officer aboard is a commander of the race whose stored pod is the pod (`FCT_Commander.LifepodID`) and who is not retired (`RetireStatus` 0), so a retired officer and an officer of another race that the pod holds as a prisoner are not counted;
  - an object tied to a body or a Lagrange point has its coordinates rewritten as that point moves, so the planted copy `moved` is the same save with the same objects and other coordinates;
  - a wreck is a row of FCT_Wrecks with its minerals, its components (FCT_WreckComponents) and its tech (FCT_WreckTech), saved whole by the game; an incomplete salvage clears the tech, loads components from the first row on and lowers each Amount in place (the row stays with an Amount of 0), loads minerals, and returns before the wreck is removed with an Incomplete Salvage event, so the planted copy `partial` is the same wreck with its first rows at 0, the minerals halved, no tech and its Size unchanged, and `complete` is the same save with the wreck removed;
  - a ship is a row of FCT_Ship with its construction time (`FCT_Ship.Constructed`), and a ShipID may come back for another ship after the highest ID is gone: the game takes the larger of the highest FCT_Ship and FCT_AlienShip ShipID when it starts, which keeps an ID a remembered alien hull holds out of reuse and no other.
  The checks:
  - `officer-only`: the ledger reads the active officers of an own pod, says `no crew, 2 officers` for a pod with officers and no crew, leaves a crewed pod and a pod with neither as they were, and `isOfficerOnly` is true for the first only;
  - `pod-anchors`: the fingerprint and the observation signature of a foreign pod and the signature of an own pod tied to a body or a Lagrange point carry the point and no coordinates, so they do not change when the coordinates do; a free pod is still named by its position, and the unanchored text is what it always was;
  - `wreck-anchors`: the same for the wrecks: the Lagrange point is in the fingerprint and the signature of a foreign wreck tied to it, the id of the body a wreck orbits is in it as it always was, and a free wreck is named by its size and, in the signature, its position;
  - `partial-wreck`: a wreck salvaged in part is listed by the ledger with the fingerprint, label and size it had, a status kept for it before the salvage stays held, a status kept for a wreck salvaged in full is gone, the statements of the ledger read no content of a wreck, and the wreck stays in the places and in the known-wrecks warning;
  - `pod-warning`: the lifepod warning gives an officer-only pod its officers and the pod's two weeks as it gives any pod: a pod is expired when the game time is past its creation time plus 1,209,600 seconds and not at that second, whatever it holds;
  - `pod-place`: Route Finder's life pod place says `2 officers only` for a pod with officers and no crew and counts the survivors of any other as it did;
  - `cargo-zero`: a colonist cargo row of 0 is no species of an Ark ship, and no figure of the mineral outlook or of an Ark ship changes for a cargo row of 0, whatever it holds;
  - `ship-reuse`: a milestone linked to a ship stays linked while the ship is the one linked, is missing once it is gone, and is changed (never linked again) when the ID is given to another ship; an alien record of the same ID is no ship of the race; the snooze stamp of the ship changes with the construction time, and the ledger's own wreck, named by its WreckID, does not follow a ShipID given again;
  - `registry`: the two columns the catalogue declared for this item are no longer declared and the generated reads of the ledger name them; the ledger's dialog words the survivors through the module;
  - `legacy-records`: a status kept under the name a foreign pod or a foreign wreck had before it was named by its point (a pod by its position, a wreck at a Lagrange point by an orbit body of 0), planted in a store made as the code before the change made it, is read as held where the object under its id has the old details and no other object of its kind has them, `migrateRecoveryRecords` stores the new name once (so the status stays held when the point moves its coordinates) and writes nothing at a second run, an object that moved or was replaced is mapped by nothing and reads as reused, and objects that share the old details leave the status unverified, with the ambiguity recorded in it once and the name never rewritten;
  - `legacy-observations`: a pod or a wreck tied to a point gives the text it was observed by before beside the text it is observed by now, the digest of each reaches the capture, a span kept under the old digest goes on under the new one (in the recorder, when the same save is read again and in what the page shows), and the span of an object that moved or changed starts again;
  - `legacy-readiness`: the real Vue watcher and computed inputs persist one old pod status in either readiness order, keep it held after its point moves, write nothing on a repeat and keep pending reads and results scoped to their save, race and branch.
  - `legacy-wiring`: the mixin gives the observation both digests, and the observation view compares an object with both.
  Where the game gives no rule the check does not guess it: no figure here is compared with what a played save wrote, because none exists for these cases, and no check claims how long a pod lasts beyond the two weeks the game gives.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const Vue = require('vue')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB-310-spookyerol-migrated.db'
const GAME = 141
const RACE = 784
const OTHER_RACE = 785
const SYSTEM = 21775
const BODY = 1999577
const LAGRANGE = 4242
const LAGRANGE_SOLO = 4243
const SOLO_SPOT = { x: 2222222.4, y: -3333333.6 }
const MINING_CLASS = 63059
const SHIP_TEMPLATE = 195751
const COMMANDER_TEMPLATE = 620687
const WRECK_TEMPLATE = 3
const SPECIES = 753
const ARK_SHIP = 9100501
const ARK_CLASS = 62915

const renderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const FILES = {
  ledger: renderer('utilities', 'recovery-ledger.js'),
  space: renderer('utilities', 'warnings', 'space.js'),
  placeData: renderer('utilities', 'place-data.js'),
  arks: renderer('utilities', 'arks.js'),
  capabilities: renderer('utilities', 'capabilities.js'),
  milestones: renderer('utilities', 'history-milestones.js'),
  snoozes: renderer('utilities', 'warnings', 'snoozes.js'),
  view: renderer('components', 'map', 'RecoveryLedger.vue'),
  observations: renderer('utilities', 'observations.js'),
  observationView: renderer('utilities', 'observation-view.js'),
  mixin: renderer('mixins', 'recovery-ledger.js'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The modules under the names the graph reaches them by, so that every module is one instance.
const UTILITY_NAMES = { ledger: 'recovery-ledger', space: 'warnings/space', placeData: 'place-data', arks: 'arks', capabilities: 'capabilities', milestones: 'history-milestones', snoozes: 'warnings/snoozes', observations: 'observations', mixin: '../mixins/recovery-ledger' }
const OTHER_NAMES = ['scenario-records', 'warnings/index', 'warnings/common', 'deep-links', 'colonization-data', 'capability-reads', 'campaign']

const STUBS = {
  'electron-store': `
    const files = (globalThis.recoveryFiles = globalThis.recoveryFiles || new Map())
    export default class Config {
      constructor({ name }) { this.name = name }
      get store() { return files.get(this.name) || {} }
      set store(value) { files.set(this.name, JSON.parse(JSON.stringify(value))) }
      update(change) { this.store = change(this.store) }
    }
  `,
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  'lodash/groupBy': 'export default (list, key) => list.reduce((groups, item) => { const name = typeof key === \'function\' ? key(item) : item[key]; (groups[name] = groups[name] || []).push(item); return groups }, {})',
  vuex: 'export const mapGetters = () => ({})',
}

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules as shipped, or with edits planted ------------------------------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => {
  const sources = Object.fromEntries(Object.entries(UTILITY_NAMES).filter(([key]) => texts[key] !== undefined).map(([key, name]) => [name, texts[key]]))

  return {
    texts,
    modules: memo(() => loadUtilities([...Object.values(UTILITY_NAMES), ...OTHER_NAMES], { stubs: STUBS, sources })),
  }
}

// ---- The fixture, as in-memory copies --------------------------------------------------------------------------------------
const literal = (value) => (value === null ? 'null' : typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))

// A copy of the row of `table` with `key` equal to `from`, every column kept but those of `over`.
const cloneRow = (database, table, key, from, over) => {
  const names = database.query(`select name from pragma_table_info('${table}')`).all().map((row) => row.name)
  const select = names.map((name) => (Object.prototype.hasOwnProperty.call(over, name) ? literal(over[name]) : `"${name}"`)).join(', ')

  database.run(`insert into ${table} (${names.map((name) => `"${name}"`).join(', ')}) select ${select} from ${table} where ${key} = ${from}`)
}

const IDS = { podOfficers: 9100001, podCrew: 9100002, podMixed: 9100003, podEmpty: 9100004, podAnchor: 9100005, podForeignLagrange: 9100006, podForeignBody: 9100007, podForeignFree: 9100008, podForeignSolo: 9100009, ownWreck: 9100011, foreignLagrange: 9100012, foreignBody: 9100013, wreckSolo: 9100014, wreckFreeTwin: 9100015, lostShip: 9100301, newShip: 9100302, commander: 9100101, fleet: 9100401 }
const CREATED = 1000000
const MOVE = 3000000

// A pod as the game saves it.
const addPod = (database, { id, race = RACE, crew, name, body = 0, lagrange = 0, x = 4000000.4, y = -8000000.6 }) => {
  database.run(`insert into FCT_Lifepods (LifepodID, GameID, RaceID, SpeciesID, SystemID, OrbitBodyID, OrbitLagrangeID, ClassID, ShipName, Crew, Xcor, Ycor, CreationTime, GradePoints) values (${id}, ${GAME}, ${race}, ${SPECIES}, ${SYSTEM}, ${body}, ${lagrange}, ${race === RACE ? MINING_CLASS : 0}, ${literal(name)}, ${crew}, ${x}, ${y}, ${CREATED}, 0)`)
}

// An officer aboard a pod: a commander whose stored pod is the pod.
const addOfficer = (database, { pod, race = RACE, retired = 0 }) => {
  cloneRow(database, 'FCT_Commander', 'CommanderID', COMMANDER_TEMPLATE, { CommanderID: IDS.commander + addOfficer.count++, RaceID: race, LifepodID: pod, RetireStatus: retired })
}
addOfficer.count = 0

// The wreck of the template with its components and its tech, as the game saves a wreck whole.
const addWreck = (database, over) => {
  cloneRow(database, 'FCT_Wrecks', 'WreckID', WRECK_TEMPLATE, over)
  database.run(`insert into FCT_WreckComponents (WreckID, ComponentID, GameID, Amount) select ${over.WreckID}, ComponentID, GameID, Amount from FCT_WreckComponents where WreckID = ${WRECK_TEMPLATE} order by rowid`)
  database.run(`insert into FCT_WreckTech (GameID, WreckID, TechID, Percentage) select GameID, ${over.WreckID}, TechID, Percentage from FCT_WreckTech where WreckID = ${WRECK_TEMPLATE}`)
}

const GROUND = (database) => {
  addPod(database, { id: IDS.podOfficers, crew: 0, name: 'Officers' })
  addOfficer(database, { pod: IDS.podOfficers })
  addOfficer(database, { pod: IDS.podOfficers })
  addOfficer(database, { pod: IDS.podOfficers, retired: 1 })
  addOfficer(database, { pod: IDS.podOfficers, race: OTHER_RACE })
  addPod(database, { id: IDS.podCrew, crew: 12, name: 'Crewed' })
  addPod(database, { id: IDS.podMixed, crew: 5, name: 'Mixed' })
  addOfficer(database, { pod: IDS.podMixed })
  addPod(database, { id: IDS.podEmpty, crew: 0, name: 'Empty' })
  addPod(database, { id: IDS.podAnchor, crew: 3, name: 'Anchor', body: BODY })
  addPod(database, { id: IDS.podForeignLagrange, race: OTHER_RACE, crew: 9, name: 'Foreign', lagrange: LAGRANGE })
  addPod(database, { id: IDS.podForeignBody, race: OTHER_RACE, crew: 9, name: 'Foreign', body: BODY })
  addPod(database, { id: IDS.podForeignFree, race: OTHER_RACE, crew: 9, name: 'Foreign', x: 1234567.4, y: -7654321.6 })
  addWreck(database, { WreckID: IDS.ownWreck, RaceID: RACE, SystemID: SYSTEM, ClassID: MINING_CLASS, ShipID: IDS.lostShip, OrbitBodyID: 0, OrbitLagrangeID: 0 })
  addWreck(database, { WreckID: IDS.foreignLagrange, SystemID: SYSTEM, OrbitBodyID: 0, OrbitLagrangeID: LAGRANGE, ShipID: 0 })
  addWreck(database, { WreckID: IDS.foreignBody, SystemID: SYSTEM, OrbitBodyID: BODY, OrbitLagrangeID: 0, ShipID: 0 })
}

// What an incomplete salvage leaves of a wreck: the tech cleared, the first two component rows loaded to 0 and kept, the rest as they were, half of the minerals; the Size is not touched.
const salvagedInPart = (database, wreck) => {
  database.run(`delete from FCT_WreckTech where WreckID = ${wreck}`)
  database.run(`update FCT_WreckComponents set Amount = 0 where rowid in (select rowid from FCT_WreckComponents where WreckID = ${wreck} order by rowid limit 2)`)
  database.run(`update FCT_Wrecks set Duranium = Duranium / 2, Neutronium = Neutronium / 2 where WreckID = ${wreck}`)
}

const removed = (database, wreck) => {
  database.run(`delete from FCT_WreckComponents where WreckID = ${wreck}`)
  database.run(`delete from FCT_WreckTech where WreckID = ${wreck}`)
  database.run(`delete from FCT_Wrecks where WreckID = ${wreck}`)
}

const SHIP_AT = 5000000
const NEW_SHIP_AT = 9000000

const addShip = (database, { id, constructed, name }) => {
  cloneRow(database, 'FCT_Ship', 'ShipID', SHIP_TEMPLATE, { ShipID: id, ShipName: name, Constructed: constructed })
}

// A remembered hull as the game keeps it (FCT_AlienShip of the viewing race 785 for a ship of the race 784).
const addAlienShip = (database, id) => {
  database.run(`insert into FCT_AlienShip (GameID, AlienRaceID, AlienClassID, ViewRaceID, ShipID, Name, Speed, LastX, LastY, LastSysID, LastContactTime, FirstDetected, Destroyed, DamageTaken, GameTimeDamaged, ShieldDamage, ArmourDamage, PenetratingDamage, Salvaged) values (${GAME}, ${RACE}, 0, ${OTHER_RACE}, ${id}, 'Lost', 0, 0, 0, ${SYSTEM}, ${SHIP_AT}, ${SHIP_AT}, 1, 0, 0, 0, 0, 0, 0)`)
}

// A cargo row as the game saves it.
const cargo = (database, { ship, type, id, amount, species }) => {
  database.run(`insert into FCT_ShipCargo (GameID, ShipID, CargoTypeID, CargoID, Amount, SpeciesID, StartingPop, Neutral) values (${GAME}, ${ship}, ${type}, ${id}, ${amount}, ${species}, 0, 0)`)
}

const PLANTS = {
  pods: (database) => GROUND(database),
  moved: (database) => {
    GROUND(database)
    database.run(`update FCT_Lifepods set Xcor = Xcor + ${MOVE}, Ycor = Ycor + ${MOVE}`)
    database.run(`update FCT_Wrecks set Xcor = Xcor + ${MOVE}, Ycor = Ycor + ${MOVE}`)
  },
  partial: (database) => {
    GROUND(database)
    salvagedInPart(database, IDS.ownWreck)
    salvagedInPart(database, IDS.foreignLagrange)
  },
  complete: (database) => {
    GROUND(database)
    removed(database, IDS.ownWreck)
    removed(database, IDS.foreignLagrange)
  },
  shipFirst: (database) => addShip(database, { id: IDS.lostShip, constructed: SHIP_AT, name: 'Lost' }),
  shipGone: (database) => addAlienShip(database, IDS.lostShip),
  // The wreck of the lost ship and another ship that holds its ID.
  reusedWreck: (database) => {
    GROUND(database)
    addShip(database, { id: IDS.lostShip, constructed: NEW_SHIP_AT, name: 'Reused' })
  },
  shipReused: (database) => {
    addShip(database, { id: IDS.lostShip, constructed: NEW_SHIP_AT, name: 'Reused' })
    addAlienShip(database, IDS.lostShip)
  },
  // An Ark ship of the race (a ship of a class with the Ark flag) with 40,000 colonists of one species, and the same with a colonist cargo row of 0 for a species the save names, one for a species it does not, and a mineral row of 0.
  cargoBase: (database) => {
    cloneRow(database, 'FCT_Ship', 'ShipID', SHIP_TEMPLATE, { ShipID: ARK_SHIP, ShipName: 'Ark', ShipClassID: ARK_CLASS })
    cargo(database, { ship: ARK_SHIP, type: 1, id: 0, amount: 40000, species: SPECIES })
  },
  cargoZero: (database) => {
    PLANTS.cargoBase(database)

    for (const species of [754, 999999]) {
      cargo(database, { ship: ARK_SHIP, type: 1, id: 0, amount: 0, species })
    }

    cargo(database, { ship: SHIP_TEMPLATE, type: 3, id: 9, amount: 0, species: 0 })
  },
  // `pods` and, beside its objects, what a status kept before the points were named is judged against: a foreign pod and a foreign wreck tied to a Lagrange point of their own, whose old names no other object has, and a free wreck that has the old name of the wreck tied to the point in `pods` (a wreck at a Lagrange point was named by an orbit body of 0, as a free one still is).
  legacy: (database) => {
    GROUND(database)
    addPod(database, { id: IDS.podForeignSolo, race: OTHER_RACE, crew: 9, name: 'Foreign', lagrange: LAGRANGE_SOLO, x: SOLO_SPOT.x, y: SOLO_SPOT.y })
    addWreck(database, { WreckID: IDS.wreckSolo, SystemID: SYSTEM, OrbitBodyID: 0, OrbitLagrangeID: LAGRANGE_SOLO, ShipID: 0, Size: 77.5 })
    addWreck(database, { WreckID: IDS.wreckFreeTwin, SystemID: SYSTEM, OrbitBodyID: 0, OrbitLagrangeID: 0, ShipID: 0 })
  },
  legacyMoved: (database) => {
    PLANTS.legacy(database)
    database.run(`update FCT_Lifepods set Xcor = Xcor + ${MOVE}, Ycor = Ycor + ${MOVE}`)
    database.run(`update FCT_Wrecks set Xcor = Xcor + ${MOVE}, Ycor = Ycor + ${MOVE}`)
  },
  base: () => {},
}

let BYTES = null
const COPIES = new Map()

const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)

    addOfficer.count = 0
    PLANTS[name](database)
    COPIES.set(name, database)
  }

  return COPIES.get(name)
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

// The query of the save as the app's database client answers it: `replacements` fill the named parameters of a statement.
const adapterOf = (database) => ({ query: async (sql, options = {}) => [database.query(options.replacements ? sql.replace(/:(\w+)/g, (match, name) => (name in options.replacements ? String(options.replacements[name]) : match)) : sql).all()] })

const ids = { GameID: GAME, RaceID: RACE }

const systemName = () => copyOf('base').query(`select Name from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} and SystemID = ${SYSTEM}`).get().Name

// ---- The checks -------------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

const ledgerOf = async (w) => (await w.modules())['recovery-ledger']

const loadObjects = async (w, copy) => (await ledgerOf(w)).loadRecoveryObjects(adapterOf(copyOf(copy)), ids)

const signaturesOf = async (w, copy) => {
  const ledger = await ledgerOf(w)
  const db = adapterOf(copyOf(copy))

  return new Map([...(await ledger.readLifepodObservations(db, ids)), ...(await ledger.readWreckObservations(db, ids))])
}

const roundedSize = (database, wreck) => Number(database.query(`select Size from FCT_Wrecks where WreckID = ${wreck}`).get().Size.toFixed(6)).toFixed(6)

check('officer-only', 'the ledger reads the active officers of an own pod, words a pod with officers and no crew as officer-only, and leaves a crewed pod and a pod with neither as they were', async (w) => {
  const ledger = await ledgerOf(w)
  const { objects, failed } = await loadObjects(w, 'pods')
  const pods = objects.ownLifepod

  assert.deepEqual(failed, {}, 'every statement is read')
  assert.deepEqual([...pods.keys()].sort((a, b) => a - b), [IDS.podOfficers, IDS.podCrew, IDS.podMixed, IDS.podEmpty, IDS.podAnchor], 'the five own pods')

  const read = (id) => [pods.get(id).crew, pods.get(id).officers]

  assert.deepEqual(read(IDS.podOfficers), [0, 2], 'two active officers: the retired one and the prisoner of another race are not counted')
  assert.deepEqual(read(IDS.podCrew), [12, 0])
  assert.deepEqual(read(IDS.podMixed), [5, 1])
  assert.deepEqual(read(IDS.podEmpty), [0, 0])
  assert.equal(ledger.labelOf(pods.get(IDS.podOfficers)), 'Officers life pods: no crew, 2 officers', 'officers and no crew')
  assert.equal(ledger.labelOf(pods.get(IDS.podCrew)), 'Crewed life pods: 12 crew', 'a crewed pod as it was')
  assert.equal(ledger.labelOf(pods.get(IDS.podMixed)), 'Mixed life pods: 5 crew, 1 officer', 'crew and one officer')
  assert.equal(ledger.labelOf(pods.get(IDS.podEmpty)), 'Empty life pods: 0 crew', 'a pod with neither is not officer-only')
  assert.equal(ledger.labelOf(pods.get(IDS.podOfficers), (number) => `n${number}`), 'Officers life pods: no crew, n2 officers', 'the figures go through the counter')

  assert.deepEqual([IDS.podOfficers, IDS.podCrew, IDS.podMixed, IDS.podEmpty].map((id) => ledger.isOfficerOnly(pods.get(id))), [true, false, false, false])
  assert.equal(ledger.isOfficerOnly(objects.lifepod.get(IDS.podForeignFree)), false, 'a foreign pod holds no officer the race can see')
  assert.equal(ledger.survivorsText({ crew: null, officers: 0 }), 'crew unknown', 'an unknown crew is not 0')
  assert.equal(ledger.survivorsText({ crew: 0, officers: 1 }), 'no crew, 1 officer')

  const rows = ledger.recoveryRows({ objects, entries: [] })

  assert.ok(rows.some((row) => row.key === `ownLifepod:${IDS.podOfficers}` && row.group === 'present' && row.object.officers === 2), 'the officer-only pod is a row of the ledger')
})

check('pod-anchors', 'a pod tied to a body or a Lagrange point is named by the point and not by coordinates the game rewrites, a free pod by its position, and the text of a free pod is what it always was', async (w) => {
  const ledger = await ledgerOf(w)
  const before = await loadObjects(w, 'pods')
  const after = await loadObjects(w, 'moved')
  const fingerprint = (bundle, id) => ledger.RECOVERY_TARGETS.lifepod.fingerprint(bundle.objects.lifepod.get(id))

  assert.equal(fingerprint(before, IDS.podForeignLagrange), `lifepod|${SYSTEM}|lagrange${LAGRANGE}|`, 'the Lagrange point')
  assert.equal(fingerprint(before, IDS.podForeignBody), `lifepod|${SYSTEM}|body${BODY}|`, 'the body')
  assert.equal(fingerprint(before, IDS.podForeignFree), `lifepod|${SYSTEM}|1234567|-7654322|`, 'the position of a free pod, as it was')
  assert.equal(fingerprint(after, IDS.podForeignLagrange), fingerprint(before, IDS.podForeignLagrange), 'the coordinates moved, the point did not')
  assert.equal(fingerprint(after, IDS.podForeignBody), fingerprint(before, IDS.podForeignBody))
  assert.equal(fingerprint(after, IDS.podForeignFree), `lifepod|${SYSTEM}|${1234567 + MOVE}|${-7654322 + MOVE}|`, 'a free pod that is elsewhere is another place')
  assert.equal(ledger.RECOVERY_TARGETS.lifepod.fingerprint({ systemId: 1, orbitBodyId: 5, orbitLagrangeId: 9, x: 1, y: 2, aliasId: null }), 'lifepod|1|body5|', 'a body wins where both are stored')
  assert.equal(ledger.RECOVERY_TARGETS.lifepod.fingerprint({ systemId: 1, orbitBodyId: 0, orbitLagrangeId: 0, x: 1.4, y: 2.6, aliasId: 7 }), 'lifepod|1|1|3|7', 'the stored 0 anchors nothing')

  const signatures = await signaturesOf(w, 'pods')
  const moved = await signaturesOf(w, 'moved')

  assert.equal(signatures.get(IDS.podForeignLagrange), `seen/${SYSTEM}/lagrange${LAGRANGE}/`, 'the signature of a foreign pod at a Lagrange point')
  assert.equal(signatures.get(IDS.podAnchor), `own/${SYSTEM}/body${BODY}/${MINING_CLASS}/${CREATED}/Anchor`, 'the signature of an own pod at a body')
  assert.equal(signatures.get(IDS.podCrew), `own/${SYSTEM}/4000000/-8000001/${MINING_CLASS}/${CREATED}/Crewed`, 'the signature of a free own pod, as it was')
  assert.equal(signatures.get(IDS.podForeignFree), `seen/${SYSTEM}/1234567/-7654322/`)

  for (const id of [IDS.podForeignLagrange, IDS.podForeignBody, IDS.podAnchor]) {
    assert.equal(moved.get(id), signatures.get(id), `pod ${id}: the signature holds while the coordinates move`)
  }

  assert.notEqual(moved.get(IDS.podForeignFree), signatures.get(IDS.podForeignFree), 'a free pod that is elsewhere is another observation')
  assert.notEqual(moved.get(IDS.podCrew), signatures.get(IDS.podCrew), 'a free own pod that is elsewhere is another observation')
})

check('wreck-anchors', 'a foreign wreck tied to a Lagrange point is named by it, the id of the body a wreck orbits is in its fingerprint as it always was, and a free wreck is named by its size and, in the signature, its position', async (w) => {
  const ledger = await ledgerOf(w)
  const before = await loadObjects(w, 'pods')
  const after = await loadObjects(w, 'moved')
  const fingerprint = (bundle, id, type = 'wreck') => ledger.RECOVERY_TARGETS[type].fingerprint(bundle.objects[type].get(id))
  const size = roundedSize(copyOf('base'), WRECK_TEMPLATE)
  const alias = copyOf('base').query(`select AlienClassID from FCT_AlienClass where GameID = ${GAME} and ViewRaceID = ${RACE} and ActualClassID = (select ClassID from FCT_Wrecks where WreckID = ${WRECK_TEMPLATE})`).get()
  const tail = alias ? alias.AlienClassID : ''

  assert.equal(fingerprint(before, IDS.foreignLagrange), `wreck|${SYSTEM}|${size}|lagrange${LAGRANGE}|${tail}`, 'the Lagrange point')
  assert.equal(fingerprint(before, IDS.foreignBody), `wreck|${SYSTEM}|${size}|${BODY}|${tail}`, 'the id of the body, as it was')
  assert.equal(fingerprint(after, IDS.foreignLagrange), fingerprint(before, IDS.foreignLagrange), 'the coordinates moved, the point did not')
  assert.equal(fingerprint(after, IDS.foreignBody), fingerprint(before, IDS.foreignBody))
  assert.equal(fingerprint(before, WRECK_TEMPLATE), `wreck|21805|${size}|0|${tail}`, 'a free wreck of the fixture, as it was')
  assert.equal(ledger.RECOVERY_TARGETS.wreck.fingerprint({ systemId: 1, size: 2, orbitBodyId: 5, orbitLagrangeId: 9, aliasId: null }), 'wreck|1|2.000000|5|', 'a body wins where both are stored')

  const signatures = await signaturesOf(w, 'pods')
  const moved = await signaturesOf(w, 'moved')

  assert.equal(signatures.get(IDS.foreignLagrange), `seen/${SYSTEM}/0/${size}/lagrange${LAGRANGE}/${tail}`, 'the signature at a Lagrange point')
  assert.equal(signatures.get(IDS.foreignBody), `seen/${SYSTEM}/${BODY}/${size}/${tail}`, 'the signature at a body: no coordinates, as it was')
  assert.equal(moved.get(IDS.foreignLagrange), signatures.get(IDS.foreignLagrange), 'the Lagrange anchor holds while the coordinates move')
  assert.equal(moved.get(IDS.foreignBody), signatures.get(IDS.foreignBody))
  assert.notEqual(moved.get(WRECK_TEMPLATE), signatures.get(WRECK_TEMPLATE), 'a free wreck that is elsewhere is another observation')
  assert.equal(signatures.get(IDS.ownWreck), `own/${SYSTEM}/0/${size}/${Math.round(copyOf('base').query(`select Xcor from FCT_Wrecks where WreckID = ${WRECK_TEMPLATE}`).get().Xcor)}/${Math.round(copyOf('base').query(`select Ycor from FCT_Wrecks where WreckID = ${WRECK_TEMPLATE}`).get().Ycor)}/${MINING_CLASS}/${IDS.lostShip}`, 'an own wreck: position, class and ship')
})

const PARTIAL_IDS = [IDS.ownWreck, IDS.foreignLagrange]

check('partial-wreck', 'a wreck salvaged in part keeps its row, fingerprint, label and size in the ledger, in the places and in the known-wrecks warning, a status kept for it before stays held, a status kept for a wreck salvaged in full is gone, and the ledger reads no content of a wreck', async (w) => {
  const { 'recovery-ledger': ledger, 'scenario-records': records, 'place-data': placeData, 'deep-links': links, 'warnings/index': warnings, 'warnings/common': common } = await w.modules()
  const before = await loadObjects(w, 'pods')
  const partial = await loadObjects(w, 'partial')
  const complete = await loadObjects(w, 'complete')
  const kinds = { [IDS.ownWreck]: 'ownWreck', [IDS.foreignLagrange]: 'wreck' }

  for (const id of PARTIAL_IDS) {
    const type = kinds[id]
    const was = before.objects[type].get(id)
    const now = partial.objects[type].get(id)

    assert.ok(now, `wreck ${id}: still listed after an incomplete salvage`)
    assert.equal(ledger.RECOVERY_TARGETS[type].fingerprint(now), ledger.RECOVERY_TARGETS[type].fingerprint(was), `wreck ${id}: the same object`)
    assert.equal(ledger.labelOf(now), ledger.labelOf(was), `wreck ${id}: the same label`)
    assert.equal(now.tons, was.tons, `wreck ${id}: the Size is not changed by a salvage`)
    assert.equal(complete.objects[type].has(id), false, `wreck ${id}: a salvage in full removes the row, so it is not listed`)
    assert.ok(partial.objects[type].size === before.objects[type].size && complete.objects[type].size === before.objects[type].size - 1, 'the other wrecks are as they were')
  }

  const statements = ledger.recoverySql(ids)

  for (const [type, sql] of Object.entries(statements)) {
    assert.ok(!/FCT_WreckComponents|FCT_WreckTech|FCT_Wrecks\.(?:Duranium|Neutronium|Corbomite|Tritanium|Boronide|Mercassium|Vendarite|Sorium|Uridium|Corundium|Gallicite)|FCT_Ship\b|FCT_AlienShip\b/.test(sql), `${type}: no content of a wreck and no ship is read`)
  }

  // A status kept for a wreck, then the save after an incomplete salvage and after a complete one.
  const registry = records.createAdapterRegistry()
  const store = new Map()
  const open = () => ({ get store() { return JSON.parse(JSON.stringify(store.get('c') || {})) }, set store(value) { store.set('c', JSON.parse(JSON.stringify(value))) }, update(change) { this.store = change(this.store) } })

  ledger.registerRecoveryLedger(registry.register)

  let n = 0
  const repository = records.createRepository({ storage: { open, registry: () => ({}), writable: () => Promise.resolve(true) }, adapters: registry, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: () => 1000 + n })
  const scope = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 100000 }
  const contextOf = (bundle) => ({ objects: bundle.objects, GameID: GAME, RaceID: RACE, campaignId: 'c1', branchId: 'b1', branches: null })

  for (const id of PARTIAL_IDS) {
    const kept = await ledger.setStatus(repository, scope, { row: before.objects[kinds[id]].get(id), status: 'acknowledged', context: contextOf(before) })

    assert.equal(kept.ok, true, kept.message)
  }

  const held = ledger.readRecovery(repository, scope, contextOf(partial))
  const gone = ledger.readRecovery(repository, scope, contextOf(complete))

  for (const id of PARTIAL_IDS) {
    const entry = held.entries.find((one) => one.id === id)
    const ended = gone.entries.find((one) => one.id === id)

    assert.equal(entry.state, 'held', `wreck ${id}: the status stays held after an incomplete salvage`)
    assert.equal(ended.state, 'gone', `wreck ${id}: gone once the wreck is`)
    assert.ok(ledger.recoveryRows({ objects: partial.objects, entries: held.entries }).some((row) => row.key === `${kinds[id]}:${id}` && row.group === 'present' && row.status === 'acknowledged'), `wreck ${id}: on its row with the status`)
    assert.ok(ledger.recoveryRows({ objects: complete.objects, entries: gone.entries }).some((row) => row.group === 'gone' && row.id === id), `wreck ${id}: in the list of what is gone`)
  }

  // The places and the warning list wrecks from the rows of FCT_Wrecks alone.
  const wrecksOf = async (copy) => (await placeData.loadSmallPlaces(adapterOf(copyOf(copy)), ids, String)).filter((item) => item.kind === 'wreck')
  const placesBefore = await wrecksOf('pods')
  const placesPartial = await wrecksOf('partial')
  const placesComplete = await wrecksOf('complete')
  const keyOf = (id) => links.place.wreck(id)

  assert.deepEqual(placesPartial.map((item) => [item.key, item.subtitle]), placesBefore.map((item) => [item.key, item.subtitle]), 'the places list the wrecks as before')
  assert.ok(placesBefore.some((item) => item.key === keyOf(IDS.ownWreck)))
  assert.equal(placesComplete.some((item) => item.key === keyOf(IDS.ownWreck)), false)

  const readWarning = async (copy) => warnings.checkByKey['known-wrecks'].read({ GameID: GAME, RaceID: RACE, RaceNPR: false, separator: ',', options: { idleFleetsAtColonies: false, maintenanceThreshold: 100, maintenanceExclusions: [] }, count: common.counter(','), database: adapterOf(copyOf(copy)) })
  const warnBefore = (await readWarning('pods')).map((row) => row.id)
  const warnPartial = (await readWarning('partial')).map((row) => row.id)
  const warnComplete = (await readWarning('complete')).map((row) => row.id)

  assert.ok(warnBefore.includes(`wreck:${IDS.ownWreck}`), 'the warning lists the wreck')
  assert.deepEqual(warnPartial, warnBefore, 'and still lists it after an incomplete salvage')
  assert.equal(warnComplete.includes(`wreck:${IDS.ownWreck}`), false, 'not after a complete one')
})

// ---- Records kept before the points were named -------------------------------------------------------------------------------
// A repository over an in-memory store, with the ledger's adapter registered, as the partial-wreck check makes one.
const newRepository = (records, ledger) => {
  const registry = records.createAdapterRegistry()
  const store = new Map()
  const open = () => ({ get store() { return JSON.parse(JSON.stringify(store.get('c') || {})) }, set store(value) { store.set('c', JSON.parse(JSON.stringify(value))) }, update(change) { this.store = change(this.store) } })
  let n = 0

  ledger.registerRecoveryLedger(registry.register)

  return records.createRepository({ storage: { open, registry: () => ({}), writable: () => Promise.resolve(true) }, adapters: registry, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: () => 1000 + n })
}

// The alias the race knows the template wreck's class by, as the end of a foreign wreck's fingerprint and signature.
const wreckTail = () => {
  const alias = copyOf('base').query(`select AlienClassID from FCT_AlienClass where GameID = ${GAME} and ViewRaceID = ${RACE} and ActualClassID = (select ClassID from FCT_Wrecks where WreckID = ${WRECK_TEMPLATE})`).get()

  return alias ? alias.AlienClassID : ''
}

check('legacy-records', 'a status kept under the name a foreign pod or wreck had before it was named by its point is read as held where the object under its id has the old details and no other has them, the migration stores the new name once so the status stays held when the point moves its coordinates, an object that moved or was replaced is mapped by nothing, and objects that share the old details leave the status unverified with the ambiguity recorded once and the name never rewritten', async (w) => {
  const { 'recovery-ledger': ledger, 'scenario-records': records } = await w.modules()
  const now = await loadObjects(w, 'legacy')
  const moved = await loadObjects(w, 'legacyMoved')
  const size = roundedSize(copyOf('base'), WRECK_TEMPLATE)
  const tail = wreckTail()
  const repository = newRepository(records, ledger)
  const scope = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 100000 }
  const contextOf = (bundle) => ({ objects: bundle.objects, GameID: GAME, RaceID: RACE, campaignId: 'c1', branchId: 'b1', branches: null })
  const twin = `lifepod|${SYSTEM}|4000000|-8000001|`
  // The name the old rule gave each object, written out: a pod by its system and its position, a wreck by its system, size and the id of the body it orbits (0 at a Lagrange point).
  const OLD = {
    solo: ['lifepod', IDS.podForeignSolo, `lifepod|${SYSTEM}|2222222|-3333334|`],
    twinLagrange: ['lifepod', IDS.podForeignLagrange, twin],
    twinBody: ['lifepod', IDS.podForeignBody, twin],
    replaced: ['lifepod', IDS.podForeignFree, `lifepod|${SYSTEM}|1234567|-7654322|99`],
    wreckSolo: ['wreck', IDS.wreckSolo, `wreck|${SYSTEM}|77.500000|0|${tail}`],
    wreckTwin: ['wreck', IDS.foreignLagrange, `wreck|${SYSTEM}|${size}|0|${tail}`],
    wreckBody: ['wreck', IDS.foreignBody, `wreck|${SYSTEM}|${size}|${BODY}|${tail}`],
  }
  const uuids = {}

  for (const [name, [type, id, old]] of Object.entries(OLD)) {
    const kept = await ledger.setStatus(repository, scope, { row: now.objects[type].get(id), status: 'acknowledged', context: contextOf(now) })

    assert.equal(kept.ok, true, kept.message)
    repository.update(scope, kept.record.uuid, kept.record.revision, { links: [{ type, id, fingerprint: old }] })
    uuids[name] = kept.record.uuid
  }

  const listing = () => Object.fromEntries(repository.list(scope, { kind: ledger.RECOVERY_KIND, context: contextOf(now) }).map((item) => [item.record.uuid, item]))
  const readIn = (bundle) => {
    const { entries } = ledger.readRecovery(repository, scope, contextOf(bundle))

    return Object.fromEntries(Object.entries(uuids).map(([name, uuid]) => [name, entries.find((entry) => entry.uuid === uuid)]))
  }
  const statesIn = (bundle) => Object.fromEntries(Object.entries(readIn(bundle)).map(([name, entry]) => [name, entry.state]))
  const noteCount = (item) => item.record.assumptions.filter((text) => /more than one object had the details/.test(text)).length
  const kept = listing()
  const revisions = Object.fromEntries(Object.entries(uuids).map(([name, uuid]) => [name, kept[uuid].record.revision]))

  for (const [name, [, , old]] of Object.entries(OLD)) {
    assert.equal(kept[uuids[name]].links[0].fingerprint, old, `${name}: the store holds the name the old rule gave`)
    assert.equal(noteCount(kept[uuids[name]]), 0, `${name}: no note yet`)
  }

  // Read on the save the statuses were kept from, before anything is migrated.
  assert.deepEqual(statesIn(now), { solo: 'held', twinLagrange: 'unverified', twinBody: 'unverified', replaced: 'reused', wreckSolo: 'held', wreckTwin: 'unverified', wreckBody: 'held' }, 'held where the details are the object\'s alone, unverified where another object has them too, reused where the object under the id is not the one kept')
  assert.equal(readIn(now).solo.link.current, `lifepod|${SYSTEM}|lagrange${LAGRANGE_SOLO}|`, 'read under the new name')
  assert.equal(readIn(now).wreckSolo.link.current, `wreck|${SYSTEM}|77.500000|lagrange${LAGRANGE_SOLO}|${tail}`)
  assert.equal(readIn(now).twinLagrange.link.unverified, true)
  assert.ok(/more than one object/.test(readIn(now).twinLagrange.link.reason), 'with the reason')
  assert.deepEqual(Object.keys(uuids).map((name) => listing()[uuids[name]].record.revision), Object.keys(uuids).map((name) => revisions[name]), 'a read writes nothing')

  const rows = ledger.recoveryRows({ objects: now.objects, entries: ledger.readRecovery(repository, scope, contextOf(now)).entries })

  assert.equal(rows.find((row) => row.key === `lifepod:${IDS.podForeignSolo}`).status, 'acknowledged', 'a carried status is on the object')
  assert.equal(rows.find((row) => row.key === `lifepod:${IDS.podForeignLagrange}`).status, 'pending', 'an unverified status is not applied to either of the objects that share the details')
  assert.ok(rows.some((row) => row.group === 'review' && row.id === IDS.podForeignLagrange), 'it is listed for review')

  // Read on the save where the objects have moved with their points: the old names hold the old coordinates, so a pod is mapped by nothing; a wreck was named by no coordinates and is judged as before.
  assert.deepEqual(statesIn(moved), { solo: 'reused', twinLagrange: 'reused', twinBody: 'reused', replaced: 'reused', wreckSolo: 'held', wreckTwin: 'unverified', wreckBody: 'held' }, 'a pod that moved is another object by the old name')

  const first = await ledger.migrateRecoveryRecords(repository, scope, contextOf(now))

  assert.equal(first.ok, true, first.message)
  assert.deepEqual([...first.carried].sort(), [uuids.solo, uuids.wreckSolo].sort(), 'the two statuses of the objects that are the ones kept are renamed')
  assert.deepEqual([...first.ambiguous].sort(), [uuids.twinLagrange, uuids.twinBody, uuids.wreckTwin].sort(), 'the three that share the old details are recorded')
  assert.deepEqual(first.conflicts, [])
  assert.equal(first.changed, true)

  const after = listing()

  assert.equal(after[uuids.solo].links[0].fingerprint, `lifepod|${SYSTEM}|lagrange${LAGRANGE_SOLO}|`, 'the pod is named by its point')
  assert.equal(after[uuids.wreckSolo].links[0].fingerprint, `wreck|${SYSTEM}|77.500000|lagrange${LAGRANGE_SOLO}|${tail}`, 'the wreck is named by its point')

  for (const name of ['twinLagrange', 'twinBody', 'wreckTwin', 'replaced', 'wreckBody']) {
    assert.equal(after[uuids[name]].links[0].fingerprint, OLD[name][2], `${name}: the name is not rewritten`)
  }

  for (const name of ['twinLagrange', 'twinBody', 'wreckTwin']) {
    assert.equal(noteCount(after[uuids[name]]), 1, `${name}: the ambiguity is recorded once`)
  }

  for (const name of ['replaced', 'wreckBody']) {
    assert.equal(after[uuids[name]].record.revision, revisions[name], `${name}: a status the migration has nothing to say of is not written`)
    assert.equal(noteCount(after[uuids[name]]), 0)
  }

  const second = await ledger.migrateRecoveryRecords(repository, scope, contextOf(now))
  const again = listing()

  assert.deepEqual([second.ok, second.carried, second.conflicts, second.changed], [true, [], [], false], 'a second run has nothing to do')
  assert.deepEqual(Object.keys(uuids).map((name) => again[uuids[name]].record.revision), Object.keys(uuids).map((name) => after[uuids[name]].record.revision), 'and writes nothing')

  for (const name of ['twinLagrange', 'twinBody', 'wreckTwin']) {
    assert.equal(noteCount(again[uuids[name]]), 1, `${name}: the ambiguity is still recorded once`)
  }

  // After the migration: the same on the save of the first read, and the renamed statuses stay held on the save where the points moved the objects.
  assert.deepEqual(statesIn(now), { solo: 'held', twinLagrange: 'unverified', twinBody: 'unverified', replaced: 'reused', wreckSolo: 'held', wreckTwin: 'unverified', wreckBody: 'held' })
  assert.deepEqual(statesIn(moved), { solo: 'held', twinLagrange: 'reused', twinBody: 'reused', replaced: 'reused', wreckSolo: 'held', wreckTwin: 'unverified', wreckBody: 'held' }, 'the pod renamed by its point is the same pod after its coordinates move')
})

check('legacy-observations', 'a pod or a wreck tied to a point gives the text it was observed by before beside the text it is observed by now, the digest of each reaches the capture, a span kept under the old digest goes on under the new one in the recorder, when the same save is read again and in what the page shows, and the span of an object that moved or changed starts again', async (w) => {
  const { 'recovery-ledger': ledger, observations, campaign } = await w.modules()
  const hash = campaign.hashValue
  const size = roundedSize(copyOf('base'), WRECK_TEMPLATE)
  const tail = wreckTail()
  const template = copyOf('base').query(`select Xcor, Ycor from FCT_Wrecks where WreckID = ${WRECK_TEMPLATE}`).get()
  const wreckSpot = `${Math.round(template.Xcor)}/${Math.round(template.Ycor)}`
  const spot = `${SYSTEM}/4000000/-8000001`
  // For each object: the text it is observed by now and, where it differs, the text it was observed by before (a pod by its position, a wreck at a point by its position beside its orbit body of 0), written out from the old rule.
  const expected = new Map([
    [IDS.podForeignLagrange, [`seen/${SYSTEM}/lagrange${LAGRANGE}/`, `seen/${spot}/`]],
    [IDS.podForeignBody, [`seen/${SYSTEM}/body${BODY}/`, `seen/${spot}/`]],
    [IDS.podForeignSolo, [`seen/${SYSTEM}/lagrange${LAGRANGE_SOLO}/`, `seen/${SYSTEM}/2222222/-3333334/`]],
    [IDS.podAnchor, [`own/${SYSTEM}/body${BODY}/${MINING_CLASS}/${CREATED}/Anchor`, `own/${spot}/${MINING_CLASS}/${CREATED}/Anchor`]],
    [IDS.podCrew, [`own/${spot}/${MINING_CLASS}/${CREATED}/Crewed`]],
    [IDS.podForeignFree, [`seen/${SYSTEM}/1234567/-7654322/`]],
    [IDS.foreignLagrange, [`seen/${SYSTEM}/0/${size}/lagrange${LAGRANGE}/${tail}`, `seen/${SYSTEM}/0/${size}/${wreckSpot}/${tail}`]],
    [IDS.wreckSolo, [`seen/${SYSTEM}/0/77.500000/lagrange${LAGRANGE_SOLO}/${tail}`, `seen/${SYSTEM}/0/77.500000/${wreckSpot}/${tail}`]],
    [IDS.foreignBody, [`seen/${SYSTEM}/${BODY}/${size}/${tail}`]],
    [IDS.wreckFreeTwin, [`seen/${SYSTEM}/0/${size}/${wreckSpot}/${tail}`]],
  ])
  const tuplesOf = async (copy) => new Map([...(await ledger.readLifepodObservations(adapterOf(copyOf(copy)), ids)), ...(await ledger.readWreckObservations(adapterOf(copyOf(copy)), ids))].map(([id, ...texts]) => [id, texts]))
  const digestsOf = async (copy) => new Map([...(await observations.readObservations(adapterOf(copyOf(copy)), 'lifepod', ids)).objects, ...(await observations.readObservations(adapterOf(copyOf(copy)), 'wreck', ids)).objects].map(([id, ...hashes]) => [id, hashes]))
  const texts = await tuplesOf('legacy')
  const read = await digestsOf('legacy')

  for (const [id, wanted] of expected) {
    assert.deepEqual(texts.get(id), wanted, `object ${id}: the text of now and, only where it differs, the text of before`)
    assert.deepEqual(read.get(id), wanted.map(hash), `object ${id}: the capture holds the digest of each`)
  }

  const capture = (digests, t, n) => ({ t, n, objects: [...digests].map(([id, hashes]) => [id, ...hashes]) })
  // The record the code before the change made at game time 1000: every object under the digest of its text of before.
  const kept = observations.mergeCapture(null, { t: 1000, n: 7, objects: [...expected].map(([id, wanted]) => [id, hash(wanted[wanted.length - 1])]) }).record
  const open = { t: 2000, n: 8 }
  const id = IDS.podForeignLagrange
  const [digest, earlier] = read.get(id)

  assert.equal(observations.observationOf(kept, id, digest, open).state, 'changed', 'the digest of now alone is not the one the span was kept under')
  assert.equal(observations.observationOf(kept, id, digest, open, earlier).state, 'observed', 'with the digest of before it is')
  assert.equal(observations.observationOf(kept, id, digest, open, earlier).span.first, 1000)
  assert.equal(observations.observationOf(kept, id, digest, open, hash('seen/another')).state, 'changed', 'an earlier digest that is not the one kept carries nothing')
  assert.equal(observations.observationOf(kept, IDS.podForeignFree, read.get(IDS.podForeignFree)[0], open).state, 'observed', 'an object the change did not touch')

  // The recorder: every span goes on under the digest of now.
  const merged = observations.mergeCapture(kept, capture(read, 2000, 8))

  assert.equal(merged.outcome, 'added')

  for (const key of expected.keys()) {
    const span = observations.spanOf(merged.record, key)

    assert.equal(span.first, 1000, `object ${key}: the span goes on`)
    assert.equal(span.last, 2000, `object ${key}: to this capture`)
    assert.equal(span.digest, read.get(key)[0], `object ${key}: under the digest of now`)
    assert.notEqual(span.basis, 'moved', `object ${key}: not marked as moved`)
  }

  const again = observations.mergeCapture(merged.record, capture(read, 2000, 8))

  assert.deepEqual([again.outcome, again.changed], ['again', false], 'the save read again changes nothing')

  const sameSave = observations.mergeCapture(kept, capture(read, 1000, 7))

  assert.equal(sameSave.outcome, 'again', 'the save of the old capture read again')
  assert.equal(observations.spanOf(sameSave.record, id).first, 1000)
  assert.equal(observations.spanOf(sameSave.record, id).digest, digest, 'is read under the digest of now')

  // The points move the objects: the span of an anchored pod goes on, that of a free pod starts again.
  const movedRead = await digestsOf('legacyMoved')
  const later = observations.mergeCapture(merged.record, capture(movedRead, 3000, 9))

  assert.equal(observations.spanOf(later.record, id).first, 1000, 'a pod that moves with its point is still one span')
  assert.equal(observations.spanOf(later.record, id).last, 3000)
  assert.equal(observations.spanOf(later.record, IDS.podForeignFree).basis, 'moved', 'a free pod that is elsewhere starts again')
  assert.equal(observations.spanOf(later.record, IDS.podForeignFree).first, 3000)

  // Moved before its first read under the new name: the details the span was kept with are gone, so it starts again, once.
  const jumped = observations.mergeCapture(kept, capture(movedRead, 2000, 8))

  assert.equal(observations.spanOf(jumped.record, id).first, 2000, 'a pod that moved before its first read under the new name starts again')
  assert.equal(observations.spanOf(jumped.record, id).basis, 'moved')
  assert.equal(observations.observationOf(kept, id, movedRead.get(id)[0], open, movedRead.get(id)[1]).state, 'changed', 'and the page says changed')
})

// Install the actual computed inputs and watcher on Vue 2; only the asynchronous read completions and persistent storage are supplied by the check.
check('legacy-readiness', 'either readiness order persists one old pod status before its point moves, repeat readiness writes nothing, and pending reads and results stay with their save and scope', async (w) => {
  const { 'recovery-ledger': ledger, 'scenario-records': records, '../mixins/recovery-ledger': { default: mixin } } = await w.modules()
  const scope = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 1000 }
  const row = { type: 'lifepod', place: 'lifepod', id: 7, own: false, systemId: 10, systemName: 'Test', x: 1000, y: 2000, orbitBodyId: 0, orbitLagrangeId: 42, aliasId: 3, copies: 1 }
  const oldName = 'lifepod|10|1000|2000|3'
  const newName = 'lifepod|10|lagrange42|3'
  const bundleOf = (database, RaceID = RACE, object = row) => ({ database, GameID: GAME, RaceID, objects: { ownLifepod: new Map(), lifepod: new Map([[7, object]]), ownWreck: new Map(), wreck: new Map() } })
  const contextOf = (scope, object = row) => ({ ...scope, GameID: GAME, objects: bundleOf(null, scope.RaceID, object).objects, branches: null })
  const make = async () => {
    const files = new Map()
    const adapters = records.createAdapterRegistry()
    let writes = 0
    let serial = 0
    let pending = null
    const storage = {
      open: (campaignId) => ({
        get store() { return JSON.parse(JSON.stringify(files.get(campaignId) || {})) },
        update(change) { files.set(campaignId, change(this.store)); writes += 1 },
      }),
      writable: () => pending || Promise.resolve(true),
      registry: () => ({}),
    }

    ledger.registerRecoveryLedger(adapters.register)

    const repository = records.createRepository({ storage, adapters, newId: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}` })
    const seed = async (scope) => {
      const kept = await ledger.setStatus(repository, scope, { row, status: 'acknowledged', context: contextOf(scope) })

      assert.equal(kept.ok, true, kept.message)
      repository.update(scope, kept.record.uuid, kept.record.revision, { links: [{ type: 'lifepod', id: row.id, fingerprint: oldName }] })

      return kept.record.uuid
    }

    return { repository, seed, get writes() { return writes }, delay: (promise) => { pending = promise } }
  }
  const mount = () => new Vue({
    data: { recoveryObjects: null, recoveryRecords: null, database: Object.freeze({}), GameID: GAME, RaceID: RACE, GameTime: scope.gameTime, recoveryResolved: { campaignId: scope.campaignId, branchId: scope.branchId }, recoveryBranches: null, recoveryRevision: 0 },
    computed: Object.fromEntries(Object.entries(mixin.computed).filter(([key]) => ['recoveryRepository', 'recoveryScope', 'recoveryBundle', 'recoveryContext', 'recoveryMigration', 'recoveryRead'].includes(key))),
    watch: Object.fromEntries(Object.entries(mixin.watch).filter(([key]) => key !== 'recoveryPrefix')),
    beforeCreate() { this.$store = { state: { history: { revision: 0 } } } },
    methods: { recoveryChanged: mixin.methods.recoveryChanged },
  })
  // Drain Vue's queue and the migration's asynchronous write permission, without a timer or a replacement migration handler.
  const settle = async () => {
    await Vue.nextTick()
    await new Promise((resolve) => setImmediate(resolve))
    await Vue.nextTick()
  }
  const storedName = (repo, scope, uuid) => repo.read(scope, uuid, { context: contextOf(scope) }).links[0].fingerprint

  for (const order of ['objects-first', 'repository-first']) {
    const kept = await make()
    const uuid = await kept.seed(scope)
    const vm = mount()
    const before = kept.writes
    const objects = () => { vm.recoveryObjects = bundleOf(vm.database) }
    const repository = () => { vm.recoveryRecords = Object.freeze({ repository: kept.repository }) }
    const completions = order === 'objects-first' ? [objects, repository] : [repository, objects]

    try {
      completions[0]()
      await settle()
      assert.equal(kept.writes, before, `${order}: an incomplete input set writes nothing`)
      completions[1]()
      await settle()
      assert.equal(kept.writes, before + 1, `${order}: exactly one persisted rename before movement`)
      assert.equal(storedName(kept.repository, scope, uuid), newName, `${order}: the stored link names the point`)
      assert.equal(vm.recoveryRevision, 1, `${order}: the changed result refreshes the ledger once`)

      vm.recoveryRecords = null
      await settle()
      repository()
      await settle()
      assert.equal(kept.writes, before + 1, `${order}: a second readiness pulse writes nothing`)
      assert.equal(vm.recoveryRevision, 1, `${order}: an unchanged result does not refresh the ledger`)

      vm.database = Object.freeze({})
      vm.GameTime = 2000
      vm.recoveryObjects = bundleOf(vm.database, RACE, { ...row, x: 1500, y: 2500 })
      await settle()
      assert.equal(vm.recoveryRead.entries[0].state, 'held', `${order}: the pod stays held after its point moves`)
      assert.equal(kept.writes, before + 1, `${order}: movement writes nothing more`)
    } finally {
      vm.$destroy()
    }

    for (const change of [{}, { RaceID: OTHER_RACE }, { branchId: 'b2' }, { campaignId: 'c2', branchId: 'b2' }]) {
      const kept = await make()
      const uuid = await kept.seed(scope)
      const next = { ...scope, gameTime: 2000, ...change }
      const other = Object.keys(change).length ? await kept.seed(next) : uuid
      const vm = mount()
      const oldBundle = bundleOf(vm.database)
      const before = kept.writes
      const label = `${order}, switch ${JSON.stringify(change)}`

      try {
        if (order === 'objects-first') {
          vm.recoveryObjects = oldBundle
        } else {
          vm.recoveryRecords = Object.freeze({ repository: kept.repository })
        }

        await settle()
        vm.database = Object.freeze({})
        vm.RaceID = next.RaceID
        vm.GameTime = next.gameTime
        vm.recoveryResolved = { campaignId: next.campaignId, branchId: next.branchId }
        await settle()
        vm.recoveryRecords = Object.freeze({ repository: kept.repository })
        vm.recoveryObjects = oldBundle
        await settle()
        assert.equal(vm.recoveryContext, null, `${label}: the old save's completion is not the new save's context`)
        assert.equal(kept.writes, before, `${label}: readiness never pairs the old objects with the new scope`)
        assert.equal(vm.recoveryRevision, 0, `${label}: no stale result refreshes the ledger`)

        vm.recoveryObjects = bundleOf(vm.database, next.RaceID, { ...row, orbitLagrangeId: 99 })
        await settle()
        assert.equal(kept.writes, before + 1, `${label}: the current save alone migrates once`)
        assert.equal(storedName(kept.repository, next, other), 'lifepod|10|lagrange99|3', `${label}: the new scope uses only its own point`)

        if (other !== uuid) {
          assert.equal(storedName(kept.repository, scope, uuid), oldName, `${label}: the old scope is untouched`)
        }
      } finally {
        vm.$destroy()
      }
    }
  }

  const kept = await make()
  const uuid = await kept.seed(scope)
  const next = { ...scope, campaignId: 'c2', branchId: 'b2', RaceID: OTHER_RACE, gameTime: 2000 }
  const other = await kept.seed(next)
  const vm = mount()
  const before = kept.writes
  let grant

  kept.delay(new Promise((resolve) => { grant = resolve }))

  try {
    vm.recoveryObjects = bundleOf(vm.database)
    vm.recoveryRecords = Object.freeze({ repository: kept.repository })
    await settle()
    assert.equal(kept.writes, before, 'the permission-pending migration has not written')
    vm.database = Object.freeze({})
    vm.RaceID = next.RaceID
    vm.GameTime = next.gameTime
    vm.recoveryResolved = { campaignId: next.campaignId, branchId: next.branchId }
    await settle()
    grant(true)
    await settle()
    assert.equal(storedName(kept.repository, scope, uuid), newName, 'the in-flight operation retains its original scope and objects')
    assert.equal(storedName(kept.repository, next, other), oldName, 'the in-flight operation never writes into the switched scope')
    assert.equal(kept.writes, before + 1, 'the in-flight operation writes only its original rename')
    assert.equal(vm.recoveryRevision, 0, 'a result from the old save does not refresh the new save')
  } finally {
    grant(true)
    vm.$destroy()
  }
})

check('legacy-wiring', 'the mixin gives the observation the digest of each text, and the observation view compares an object with both', (w) => {
  assert.ok(/\[row\.id, hashValue\(signature\), hashValue\(earlier\)\]/.test(w.texts.mixin), 'the page reads the digest of before as well')
  assert.ok(/observationOf\(record, id, digest, open, earlier\)/.test(w.texts.observationView), 'the view compares with it')
})

const GAME_TIME_AT = (seconds) => CREATED + seconds

check('pod-warning', 'the lifepod warning gives an officer-only pod its officers and the pod\'s two weeks as it gives any pod: expired once the game time is past the creation time plus 1,209,600 seconds, whatever the pod holds', async (w) => {
  const { 'warnings/index': warnings, 'warnings/common': common } = await w.modules()
  const read = async (GameTime) => Object.fromEntries((await warnings.checkByKey['active-lifepods'].read({ GameID: GAME, RaceID: RACE, GameTime, RaceNPR: false, separator: ',', options: { idleFleetsAtColonies: false, maintenanceThreshold: 100, maintenanceExclusions: [] }, count: common.counter(','), database: adapterOf(copyOf('pods')) })).map((row) => [row.id, row]))
  const day = 86400
  const at = await read(GAME_TIME_AT(day))
  const names = Object.fromEntries(Object.entries(IDS).filter(([key]) => key.startsWith('pod')).map(([key, id]) => [key, `lifepod:${id}`]))

  assert.deepEqual(Object.keys(at).sort(), [names.podOfficers, names.podCrew, names.podMixed, names.podEmpty, names.podAnchor].sort(), 'the race\'s own five pods, none of another race\'s')
  assert.equal(at[names.podOfficers].cells.crew, 'officers only (2)', 'officers and no crew')
  assert.equal(at[names.podCrew].cells.crew, '12', 'a crewed pod as it was')
  assert.equal(at[names.podMixed].cells.crew, '5 + 1 officer', 'crew and an officer')
  assert.equal(at[names.podEmpty].cells.crew, '0', 'a crew of 0 is kept')
  assert.equal(at[names.podOfficers].cells.remaining.text, '13d', 'the two weeks of any pod, less the day')
  assert.equal(at[names.podOfficers].cells.remaining.text, at[names.podCrew].cells.remaining.text, 'the officer-only pod has the time of the crewed one')
  assert.equal((await read(GAME_TIME_AT(1209599)))[names.podOfficers].cells.remaining.text, '1s')

  for (const [seconds, text, tone] of [[1209600, '0s', undefined], [1209601, 'Expired', 'error']]) {
    const read2 = await read(GAME_TIME_AT(seconds))

    for (const name of [names.podOfficers, names.podCrew, names.podMixed, names.podEmpty]) {
      assert.equal(read2[name].cells.remaining.text, text, `${name} at ${seconds} seconds`)
      assert.equal(read2[name].cells.remaining.tone, tone)
    }
  }
})

check('pod-place', 'Route Finder\'s life pod place says which pod holds only officers and counts the survivors of any other pod as before', async (w) => {
  const { 'place-data': placeData } = await w.modules()
  const items = (await placeData.loadSmallPlaces(adapterOf(copyOf('pods')), ids, String)).filter((item) => item.kind === 'lifepod')
  const subtitles = Object.fromEntries(items.map((item) => [item.name, item.subtitle]))
  const system = systemName()

  assert.equal(subtitles['Life pods: Officers'], `2 officers only in ${system}`, 'officers and no crew')
  assert.equal(subtitles['Life pods: Crewed'], `12 survivors in ${system}`, 'a crewed pod')
  assert.equal(subtitles['Life pods: Mixed'], `5 survivors in ${system}`, 'a pod with crew and an officer counts its crew')
  assert.equal(subtitles['Life pods: Empty'], `0 survivors in ${system}`, 'a pod with neither is not officer-only')
  assert.equal(items.filter((item) => item.subtitle.startsWith('Alien life pods')).length, 3, 'a foreign pod gives no survivors')
})

check('cargo-zero', 'a colonist cargo row of 0 is no species of an Ark ship and no figure of the Ark layer or of the mineral outlook changes for a cargo row of 0, whatever it holds', async (w) => {
  const { arks, 'colonization-data': data } = await w.modules()
  const layerOf = async (copy) => {
    const loaded = await arks.loadArks(adapterOf(copyOf(copy)), ids)

    return { loaded, layer: arks.arkLayer(loaded) }
  }
  const base = await layerOf('cargoBase')
  const zero = await layerOf('cargoZero')
  const ship = (read) => read.layer.ships.find((one) => one.ShipID === ARK_SHIP)
  const species = (read) => ship(read).results.species

  assert.ok(ship(base), 'the planted Ark ship is read')
  assert.equal(zero.loaded.cargo.filter((row) => row.ShipID === ARK_SHIP).length, base.loaded.cargo.filter((row) => row.ShipID === ARK_SHIP).length + 2, 'the planted rows of 0 are in the read')
  assert.equal(species(base).status !== 'unavailable', true, 'the species aboard is named')
  assert.deepEqual(species(base).value.map((entry) => [entry.SpeciesID, entry.name]), [[SPECIES, 'Human']], 'one species aboard')
  assert.deepEqual(species(zero).value, species(base).value, 'no species of 0 people is listed')
  assert.equal(species(zero).status, species(base).status, 'and none makes the species unavailable')
  assert.deepEqual(ship(zero).results.aboard.value, ship(base).results.aboard.value, 'the people aboard are as they were')
  assert.deepEqual(zero.layer.totals.aboardElsewhere.value, base.layer.totals.aboardElsewhere.value)

  const outlook = async (copy) => JSON.parse(JSON.stringify(await data.loadMineralOutlook(adapterOf(copyOf(copy)), { GameID: GAME, RaceID: RACE, ranks: true, blocked: new Set() })))

  assert.deepEqual(await outlook('cargoZero'), await outlook('cargoBase'), 'the mineral outlook is as it was')
})

check('ship-reuse', 'a milestone linked to a ship stays linked while it is the ship, is missing once it is gone and changed when the ID is given to another ship, an alien record of the ID is no ship of the race, and the stamp of the ship follows its construction time while the ledger\'s wreck is named by its WreckID', async (w) => {
  const { 'recovery-ledger': ledger, 'scenario-records': records, 'history-milestones': milestones, 'warnings/snoozes': snoozes } = await w.modules()
  const registry = records.createAdapterRegistry()
  const store = new Map()
  const open = () => ({ get store() { return JSON.parse(JSON.stringify(store.get('c') || {})) }, set store(value) { store.set('c', JSON.parse(JSON.stringify(value))) }, update(change) { this.store = change(this.store) } })

  milestones.registerMilestones(registry.register)

  let n = 0
  const repository = records.createRepository({ storage: { open, registry: () => ({}), writable: () => Promise.resolve(true) }, adapters: registry, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, now: () => 1000 + n })
  const scope = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 20000000 }
  const TREE = { b1: { parent: null, t: null } }
  const contextOf = async (copy) => ({ ...(await milestones.loadObjects(adapterOf(copyOf(copy)), ids)), campaignId: 'c1', branchId: 'b1', branches: TREE })
  const first = await contextOf('shipFirst')

  assert.ok(first.objects.ship.get(IDS.lostShip), 'the ship is read')
  assert.equal(first.objects.ship.get(IDS.lostShip).constructed, SHIP_AT)

  const saved = await milestones.saveMilestone(repository, scope, { t: 6000000, type: 'loss', text: 'The Lost went down', link: { type: 'ship', row: first.objects.ship.get(IDS.lostShip) }, context: first })

  assert.equal(saved.ok, true, saved.message)

  const statusIn = async (copy) => milestones.readMilestones(repository, scope, await contextOf(copy)).entries[0].link

  assert.equal((await statusIn('shipFirst')).status, 'linked', 'the ship that was linked')
  assert.equal((await statusIn('shipGone')).status, 'missing', 'the ship is gone: nothing is bound to the ID, and a remembered alien hull is no ship of the race')
  assert.equal((await statusIn('shipReused')).status, 'changed', 'the ID went to another ship, built later')
  assert.equal((await contextOf('shipReused')).objects.ship.get(IDS.lostShip).name, 'Reused')
  assert.equal((await contextOf('shipGone')).objects.ship.has(IDS.lostShip), false, 'an alien record is no ship of the race')

  const stamps = async (copy, rowIds) => snoozes.readStamps(adapterOf(copyOf(copy)), GAME, rowIds)
  const shipStamp = async (copy) => (await stamps(copy, [`ship:${IDS.lostShip}`])).get(`ship:${IDS.lostShip}`)

  assert.notEqual(await shipStamp('shipFirst'), null, 'a stamp is read for the ship')
  assert.notEqual(await shipStamp('shipFirst'), await shipStamp('shipReused'), 'a ship given the ID again has another stamp, so a snooze of the first does not apply to it')
  assert.equal(await shipStamp('shipGone'), null, 'no stamp for an ID with no ship')

  const wreckKey = `wreck:${IDS.ownWreck}`
  const lost = await loadObjects(w, 'pods')
  const kept = await loadObjects(w, 'reusedWreck')

  assert.equal((await stamps('pods', [wreckKey])).get(wreckKey), `wreck:${IDS.lostShip},${SYSTEM},${MINING_CLASS}`, 'a wreck is stamped by its ShipID, system and class')
  assert.equal(ledger.RECOVERY_TARGETS.ownWreck.fingerprint(lost.objects.ownWreck.get(IDS.ownWreck)), `ownWreck|${SYSTEM}|${MINING_CLASS}|${roundedSize(copyOf('pods'), IDS.ownWreck)}|${IDS.lostShip}`, 'the own wreck of the ledger names its ship')
  assert.equal(ledger.RECOVERY_TARGETS.ownWreck.fingerprint(kept.objects.ownWreck.get(IDS.ownWreck)), ledger.RECOVERY_TARGETS.ownWreck.fingerprint(lost.objects.ownWreck.get(IDS.ownWreck)), 'the wreck is the row it was while another ship holds its ShipID: the ledger keys it by WreckID')
  assert.equal(kept.objects.ownWreck.size, lost.objects.ownWreck.size)
  assert.equal(JSON.stringify([...kept.objects.ownWreck.keys()]), JSON.stringify([...lost.objects.ownWreck.keys()]), 'the same wrecks')
})

// ---- A save played under the 3.2 line ---------------------------------------------------------------------------------------
const PLAYED = { file: 'saves/AuroraDB-320-fetterkrolle-1.db', GameID: 161, RaceID: 909 }

check('played-save', 'a save played under the 3.2 line (8 wrecks of another race, 1 of them in a system the race knows, no life pod, no officer in a pod, no Lagrange anchor) is read by every statement of the ledger, and the wreck is listed with the fingerprint and the observation worked from its own row', async (w) => {
  const { 'recovery-ledger': ledger, 'place-data': placeData, 'warnings/index': warnings, 'warnings/common': common } = await w.modules()
  const database = new Database(path.join(root, PLAYED.file), { readonly: true })

  try {
    const played = { GameID: PLAYED.GameID, RaceID: PLAYED.RaceID }
    const known = `inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Wrecks.SystemID and FCT_RaceSysSurvey.RaceID = ${played.RaceID} and FCT_RaceSysSurvey.GameID = ${played.GameID}`
    const count = (sql) => database.query(sql).get().n
    const bundle = await ledger.loadRecoveryObjects(adapterOf(database), played)
    const rows = database.query(`select FCT_Wrecks.WreckID, FCT_Wrecks.SystemID, FCT_Wrecks.OrbitBodyID, FCT_Wrecks.OrbitLagrangeID, FCT_Wrecks.Size, FCT_Wrecks.Xcor, FCT_Wrecks.Ycor, (select FCT_AlienClass.AlienClassID from FCT_AlienClass where FCT_AlienClass.GameID = ${played.GameID} and FCT_AlienClass.ViewRaceID = ${played.RaceID} and FCT_AlienClass.ActualClassID = FCT_Wrecks.ClassID) as Alias from FCT_Wrecks ${known} where FCT_Wrecks.GameID = ${played.GameID} and FCT_Wrecks.RaceID != ${played.RaceID}`).all()

    assert.equal(count(`select count(*) as n from FCT_Wrecks where GameID = ${played.GameID}`), 8, 'the save holds 8 wrecks')
    assert.equal(count(`select count(*) as n from FCT_Lifepods where GameID = ${played.GameID}`), 0, 'no life pod')
    assert.equal(count(`select count(*) as n from FCT_Commander where GameID = ${played.GameID} and LifepodID > 0`), 0, 'no officer in a pod')
    assert.equal(count(`select count(*) as n from FCT_Wrecks where GameID = ${played.GameID} and OrbitLagrangeID > 0`), 0, 'no wreck at a Lagrange point')
    assert.deepEqual(bundle.failed, {}, 'every statement reads the save')
    assert.equal(rows.length, 1, 'one wreck in a known system')
    assert.deepEqual([...bundle.objects.wreck.keys()], rows.map((row) => row.WreckID), 'the ledger lists it and no other')
    assert.deepEqual([bundle.objects.ownWreck.size, bundle.objects.ownLifepod.size, bundle.objects.lifepod.size], [0, 0, 0])

    const [row] = rows
    const object = bundle.objects.wreck.get(row.WreckID)
    const alias = row.Alias === null ? '' : row.Alias

    assert.equal(ledger.RECOVERY_TARGETS.wreck.fingerprint(object), `wreck|${row.SystemID}|${row.Size.toFixed(6)}|${row.OrbitBodyID}|${alias}`, 'the fingerprint of the wreck')
    assert.equal(object.tons, row.Size * 50, 'the tons')

    const [[id, signature]] = await ledger.readWreckObservations(adapterOf(database), played)

    assert.equal(id, row.WreckID)
    assert.ok(row.OrbitBodyID > 0, 'the played wreck orbits a body')
    assert.equal(signature, ['seen', row.SystemID, row.OrbitBodyID, row.Size.toFixed(6), alias].join('/'), 'the observation of a wreck at a body holds no coordinates')
    assert.deepEqual(await ledger.readLifepodObservations(adapterOf(database), played), [], 'no pod is observed')

    const ctx = { GameID: played.GameID, RaceID: played.RaceID, GameTime: 0, RaceNPR: false, separator: ',', options: { idleFleetsAtColonies: false, maintenanceThreshold: 100, maintenanceExclusions: [] }, count: common.counter(','), database: adapterOf(database) }

    assert.deepEqual(await warnings.checkByKey['active-lifepods'].read(ctx), [], 'no pod to warn of')
    assert.deepEqual((await placeData.loadSmallPlaces(adapterOf(database), played, String)).filter((item) => item.kind === 'lifepod'), [], 'no pod place')
  } finally {
    database.close()
  }
})

check('registry', 'the two columns the catalogue declared for this item are read and no longer declared, and the dialog words the survivors through the module', async (w) => {
  const { capabilities, 'capability-reads': reads } = await w.modules()
  const declared = capabilities.DECLARED

  assert.ok(declared.length > 5, 'the registry is there')
  assert.equal(declared.some((entry) => entry.table === 'FCT_Wrecks' || entry.table === 'FCT_Lifepods'), false, 'neither table is declared any more')

  const text = Object.values(reads.READS).flatMap((group) => Object.entries(group)).filter(([key]) => key === 'recoveryObjects').map(([, value]) => value.reads).join(' ')

  assert.ok(/FCT_Lifepods\([^)]*\bOrbitBodyID\b[^)]*\bOrbitLagrangeID\b/.test(text), 'the ledger reads the two columns of the pod')
  assert.ok(/FCT_Wrecks\([^)]*\bOrbitLagrangeID\b/.test(text), 'and the Lagrange column of the wreck')
  assert.ok(/FCT_Commander\([^)]*\bLifepodID\b[^)]*\bRetireStatus\b/.test(text), 'and the officers of an own pod')
  assert.ok(/survivorsText\(object, this\.count\)/.test(w.texts.view), 'the dialog words the survivors through the module')
})

// ---- The faults and the rewrites ---------------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a retired officer counts as aboard', target: 'ledger', from: ' and FCT_Commander.RetireStatus = 0) as Officers, FCT_Lifepods.CreationTime', to: ') as Officers, FCT_Lifepods.CreationTime', fails: ['officer-only'] },
  { name: 'an officer of another race counts as aboard', target: 'ledger', from: 'FCT_Commander.RaceID = FCT_Lifepods.RaceID and FCT_Commander.LifepodID', to: 'FCT_Commander.LifepodID', fails: ['officer-only'] },
  { name: 'a pod with no crew is officer-only whoever is aboard', target: 'ledger', from: "row.place === 'lifepod' && row.own && row.crew === 0 && row.officers > 0", to: "row.place === 'lifepod' && row.own && row.crew === 0", fails: ['officer-only'] },
  { name: 'a pod of officers is worded as a crew of 0', target: 'ledger', from: "row.crew === 0 && row.officers > 0 ? 'no crew' :", to: "row.crew === 0 && row.officers > 0 ? '0 crew' :", fails: ['officer-only'] },
  { name: 'the officers of the pod are not shown', target: 'ledger', from: 'return row.officers > 0 ? `${crew}, ${count(row.officers)} ${row.officers === 1 ? \'officer\' : \'officers\'}` : crew', to: 'return crew', fails: ['officer-only'] },
  { name: 'a foreign pod is named by its position always', target: 'ledger', from: "['lifepod', present(row.systemId), ...(anchorOf(row) ? [anchorOf(row)] : [spot(row.x), spot(row.y)]), present(row.aliasId)].join('|')", to: "['lifepod', present(row.systemId), spot(row.x), spot(row.y), present(row.aliasId)].join('|')", fails: ['pod-anchors'] },
  { name: 'the observation of a pod follows its coordinates', target: 'ledger', from: 'present(row.systemId), ...(anchorOf(row) ? [anchorOf(row)] : [spot(row.x), spot(row.y)]), present(row.own ? row.classId : row.aliasId)', to: 'present(row.systemId), spot(row.x), spot(row.y), present(row.own ? row.classId : row.aliasId)', fails: ['pod-anchors'] },
  { name: 'a pod at a Lagrange point is no anchor', target: 'ledger', from: ': finite(row.orbitLagrangeId) && row.orbitLagrangeId > 0 ? `lagrange${row.orbitLagrangeId}` : null)', to: ': null)', fails: ['pod-anchors', 'wreck-anchors'] },
  { name: 'the wreck fingerprint ignores the Lagrange point', target: 'ledger', from: ' : anchorOf(row) || present(row.orbitBodyId))', to: ' : present(row.orbitBodyId))', fails: ['wreck-anchors'] },
  { name: 'the wreck fingerprint writes the body with a prefix', target: 'ledger', from: 'const orbitOf = (row) => (finite(row.orbitBodyId) && row.orbitBodyId > 0 ? present(row.orbitBodyId) : anchorOf(row) || present(row.orbitBodyId))', to: 'const orbitOf = (row) => anchorOf(row) || present(row.orbitBodyId)', fails: ['wreck-anchors'] },
  { name: 'the observation of a wreck follows its coordinates at a Lagrange point', target: 'ledger', from: '...(row.orbitBodyId ? [] : anchorOf(row) ? [anchorOf(row)] : [spot(row.x), spot(row.y)])', to: '...(row.orbitBodyId ? [] : [spot(row.x), spot(row.y)])', fails: ['wreck-anchors'] },
  { name: 'a wreck with a component row of 0 is taken as emptied', target: 'ledger', from: 'where FCT_Wrecks.GameID = ${GameID} and FCT_Wrecks.RaceID = ${RaceID} order by FCT_Wrecks.WreckID', to: 'where FCT_Wrecks.GameID = ${GameID} and FCT_Wrecks.RaceID = ${RaceID} and not exists (select 1 from FCT_WreckComponents where FCT_WreckComponents.WreckID = FCT_Wrecks.WreckID and FCT_WreckComponents.Amount = 0) order by FCT_Wrecks.WreckID', fails: ['partial-wreck'] },
  { name: 'the own wreck fingerprint forgets its ship', target: 'ledger', from: "['ownWreck', present(row.systemId), present(row.classId), sizeKey(row.size), present(row.shipId)].join('|')", to: "['ownWreck', present(row.systemId), present(row.classId), sizeKey(row.size)].join('|')", fails: ['ship-reuse'] },
  { name: 'a wreck of a system the race does not know is listed', target: 'ledger', from: 'const KNOWN = (table, { GameID, RaceID }) => `inner join FCT_RaceSysSurvey', to: 'const KNOWN = (table, { GameID, RaceID }) => `left join FCT_RaceSysSurvey', fails: ['played-save'] },
  { name: 'the lifepod warning expires a pod at the second', target: 'space', from: 'if (left < 0) {', to: 'if (left <= 0) {', fails: ['pod-warning'] },
  { name: 'a pod with officers and no crew shows no time', target: 'space', from: 'const remaining = podExpiration(lifepod, GameTime)', to: 'const remaining = lifepod.Crew === 0 && lifepod.Officers > 0 ? null : podExpiration(lifepod, GameTime)', fails: ['pod-warning'] },
  { name: 'the warning shows the crew of an officer-only pod', target: 'space', from: 'return crew === 0 && aboard > 0 ? `officers only (${ctx.count(aboard)})` : aboard > 0', to: 'return aboard > 0', fails: ['pod-warning'] },
  { name: 'the warning counts a retired officer', target: 'space', from: 'FCT_Commander.LifepodID = FCT_Lifepods.LifepodID and FCT_Commander.RetireStatus = 0', to: 'FCT_Commander.LifepodID = FCT_Lifepods.LifepodID', fails: ['pod-warning'] },
  { name: 'the place says nothing of officers', target: 'placeData', from: 'return row.OwnCrew === 0 && officers > 0 ?', to: 'return false ?', fails: ['pod-place'] },
  { name: 'the place counts a retired officer', target: 'placeData', from: 'FCT_Commander.LifepodID = FCT_Lifepods.LifepodID and FCT_Commander.RetireStatus = 0', to: 'FCT_Commander.LifepodID = FCT_Lifepods.LifepodID', fails: ['pod-place'] },
  { name: 'a colonist row of 0 is a species of the ship', target: 'arks', from: 'const held = cargoRows.filter((row) => row.Amount !== 0)', to: 'const held = cargoRows', fails: ['cargo-zero'] },
  { name: 'the construction time is no part of a ship\'s fingerprint', target: 'milestones', from: "fingerprint: (row) => ['ship', present(row.constructed)].join('|'),", to: "fingerprint: (row) => ['ship'].join('|'),", fails: ['ship-reuse'] },
  { name: 'the snooze stamp of a ship is its class alone', target: 'snoozes', from: "columns: Object.freeze(['ShipClassID', 'Constructed'])", to: "columns: Object.freeze(['ShipClassID'])", fails: ['ship-reuse'] },
  { name: 'the catalogue declares the pod columns again', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: "export const DECLARED = Object.freeze([Object.freeze({ item: 'AE-308-06', readBy: 'AE-309-04', table: 'FCT_Lifepods', columns: Object.freeze(['OrbitBodyID', 'OrbitLagrangeID']) }), ", fails: ['registry'] },
  { name: 'the dialog counts the crew alone', target: 'view', from: 'survivorsText(object, this.count)', to: '`${this.count(object.crew)} crew`', fails: ['registry'] },
  { name: 'the migration stores no new name', target: 'ledger', from: 'repository.update(scope, item.record.uuid, item.record.revision, { links: [{ type: stored.type, id: stored.id, fingerprint: carried.fingerprint }] })', to: 'void carried', fails: ['legacy-records'] },
  { name: 'a status kept under an old name is never carried', target: 'ledger', from: "if (stored.status !== 'changed') {", to: "if (stored.status !== 'changed' || stored.status === 'changed') {", fails: ['legacy-records'] },
  { name: 'the old name is not compared with the object under the id', target: 'ledger', from: 'if (!row || legacyFingerprintOf(stored.type, row) !== stored.fingerprint) {', to: 'if (!row) {', fails: ['legacy-records'] },
  { name: 'objects that share the old name are taken as one', target: 'ledger', from: "return alike === 1 ? { state: 'carried', fingerprint: targetOf(stored.type).fingerprint(row) } : { state: 'ambiguous', alike }", to: "return { state: 'carried', fingerprint: targetOf(stored.type).fingerprint(row) }", fails: ['legacy-records'] },
  { name: 'the ambiguity is recorded at every run', target: 'ledger', from: 'if (!recorded) {', to: 'if (true) {', fails: ['legacy-records'] },
  { name: 'the old name of a pod leaves out its second coordinate', target: 'ledger', from: "lifepod: (row) => ['lifepod', present(row.systemId), spot(row.x), spot(row.y), present(row.aliasId)].join('|'),", to: "lifepod: (row) => ['lifepod', present(row.systemId), spot(row.x), present(row.aliasId)].join('|'),", fails: ['legacy-records'] },
  { name: 'the old name of a wreck is the new one', target: 'ledger', from: "wreck: (row) => ['wreck', present(row.systemId), sizeKey(row.size), present(row.orbitBodyId), present(row.aliasId)].join('|'),", to: "wreck: (row) => ['wreck', present(row.systemId), sizeKey(row.size), orbitOf(row), present(row.aliasId)].join('|'),", fails: ['legacy-records'] },
  { name: 'the reader gives no earlier text', target: 'ledger', from: 'return earlier === signature ? [row.id, signature] : [row.id, signature, earlier]', to: 'return [row.id, signature]', fails: ['legacy-observations'] },
  { name: 'the earlier text of a pod has its coordinates turned about', target: 'ledger', from: 'present(row.systemId), spot(row.x), spot(row.y), present(row.own ? row.classId : row.aliasId)', to: 'present(row.systemId), spot(row.y), spot(row.x), present(row.own ? row.classId : row.aliasId)', fails: ['legacy-observations'] },
  { name: 'the earlier text of a wreck at a point drops its position', target: 'ledger', from: '...(row.orbitBodyId ? [] : [spot(row.x), spot(row.y)])', to: '...(row.orbitBodyId ? [] : [])', fails: ['legacy-observations'] },
  { name: 'the capture holds no earlier digest', target: 'observations', from: '...(earlier === undefined ? [] : [hashValue(earlier)])', to: '', fails: ['legacy-observations'] },
  { name: 'the recorder starts a span again for a changed name', target: 'observations', from: 'const carried = Boolean(before) && before[2] !== digest && earlier !== undefined && before[2] === earlier', to: 'const carried = false', fails: ['legacy-observations'] },
  { name: 'the recorder carries a span over for any earlier digest', target: 'observations', from: '&& earlier !== undefined && before[2] === earlier', to: '&& earlier !== undefined', fails: ['legacy-observations'] },
  { name: 'the recorder keeps the old digest when the same save is read again', target: 'observations', from: 'objects[id] = carried ? [before[0], before[1], digest, ...(before[3] ? [before[3]] : [])] : before', to: 'objects[id] = before', fails: ['legacy-observations'] },
  { name: 'the page compares with the digest of now alone', target: 'observations', from: "span.digest === digest || (earlier !== undefined && span.digest === earlier) ? 'observed' : 'changed'", to: "span.digest === digest ? 'observed' : 'changed'", fails: ['legacy-observations'] },
  { name: 'the mixin does not migrate', target: 'mixin', from: 'migrateRecoveryRecords(repository, scope, context).then(', to: 'Promise.resolve({ changed: false }).then(', fails: ['legacy-readiness'] },
  {
    name: 'the mixin migrates on context readiness alone',
    target: 'mixin',
    from: `    recoveryMigration: {
      immediate: true,
      handler(input) {
        if (!input) {
          return
        }

        const { repository, scope, context } = input

        migrateRecoveryRecords(repository, scope, context).then((result) => {
          if (result.changed && this.recoveryMigration === input) {
            this.recoveryChanged()
          }
        })
      },
    },`,
    to: `    recoveryContext: {
      handler(context) {
        if (!context || !this.recoveryRepository || !this.recoveryScope) {
          return
        }

        migrateRecoveryRecords(this.recoveryRepository, this.recoveryScope, context).then((result) => {
          if (result.changed) {
            this.recoveryChanged()
          }
        })
      },
    },`,
    fails: ['legacy-readiness'],
  },
  { name: 'the mixin applies a changed result after switching saves', target: 'mixin', from: 'if (result.changed && this.recoveryMigration === input) {', to: 'if (result.changed) {', fails: ['legacy-readiness'] },
  { name: 'the mixin gives the page one digest', target: 'mixin', from: 'return earlier === signature ? [row.id, hashValue(signature)] : [row.id, hashValue(signature), hashValue(earlier)]', to: 'return [row.id, hashValue(signature)]', fails: ['legacy-wiring'] },
  { name: 'the view compares with the digest of now alone', target: 'observationView', from: '.map(([id, digest, earlier]) => [id, observationOf(record, id, digest, open, earlier)])', to: '.map(([id, digest]) => [id, observationOf(record, id, digest, open)])', fails: ['legacy-wiring'] },
]

// Rewrites that say the same thing: operands of a test turned about, a negation written the other way, a ternary turned about.
const BENIGN = [
  { name: 'the officer-only test with its operands turned about', target: 'ledger', from: "row.place === 'lifepod' && row.own && row.crew === 0 && row.officers > 0", to: "row.officers > 0 && row.place === 'lifepod' && row.own && row.crew === 0" },
  { name: 'the expiry written the other way', target: 'space', from: 'if (left < 0) {', to: 'if (0 > left) {' },
  { name: 'the zero rows dropped by a negated test', target: 'arks', from: 'const held = cargoRows.filter((row) => row.Amount !== 0)', to: 'const held = cargoRows.filter((row) => !(row.Amount === 0))' },
  { name: 'the officers word turned about', target: 'ledger', from: "${row.officers === 1 ? 'officer' : 'officers'}", to: "${row.officers > 1 ? 'officers' : 'officer'}" },
  { name: 'the carry test with its operands turned about', target: 'ledger', from: 'return alike === 1 ? {', to: 'return 1 === alike ? {' },
  { name: 'the earlier digest spread written the other way', target: 'observations', from: '...(earlier === undefined ? [] : [hashValue(earlier)])', to: '...(earlier !== undefined ? [hashValue(earlier)] : [])' },
]
/* eslint-enable no-template-curly-in-string */

// ---- Run ------------------------------------------------------------------------------------------------------------------------
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

const main = async () => {
  if (!fs.existsSync(path.join(root, SAVE))) {
    console.log(`UNSUPPORTED  the fixture ${SAVE} is not there`)

    return true
  }

  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(CHECKS, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith()

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      // The rewrites go onto the faulty source where their text is still there exactly once: a fault may replace the very text a rewrite says again.
      benign.filter((edit) => texts[edit.target].split(edit.from).length === 2).forEach((edit) => {
        texts[edit.target] = patched(FILES[edit.target], texts[edit.target], edit.from, edit.to)
      })

      const world = worldOf(texts)
      const missed = []

      for (const id of fault.fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
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
    closeCopies()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeCopies()
    process.exit(2)
  })
