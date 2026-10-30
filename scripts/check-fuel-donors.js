/*
  Checks the donor side of the fuel service (src/renderer/utilities/fuel-donors.js) and the tankers it puts on the Logistics page.

  Run: bun scripts/check-fuel-donors.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  Two parts, each with a head, planted faults and rewrites that say the same thing (scripts/lib/suite-runner.js):
  - `pure`: the donor result and the tanker report over constructed ships, and the SQL of the loader over a constructed save: the gates in the order the game tests them (tanker designation, an undamaged Transfer - Fuel system, a rate above 0, litres above the class minimum, the 20 HS limit of a rate under 20,000 LPH), the first failing gate named, a failing gate winning over an undecided one, the four figures kept apart (stored fuel is never changed by a gate or by a reserve, the class minimum is never folded with the reserve, the surplus is the whole litres above the larger), a class with no system and a class with a rate and no designation read as reasons and not as zero fuel, the tanker totals reconciling to the stored fuel when no surplus exists, and the damage read of a ship (no damage row: every system; a damaged row with no number: not known). The expected values are written here, from the rules, never produced by the module.
  - `page`: /logistics served by scripts/lib/page-server.js over a copy of a save in which ships of each kind have been planted by SQL (a tanker whose class has no transfer system, a class with a rate and no designation, an engine-less empty tanker, a ship whose only transfer system is damaged, one whose damage row has no number, one below the class minimum, one above it by a fraction of a litre, a one-module harvester that is no tanker), read back in Chromium: the stored fuel, class minimum, local reserve and eligible surplus of each tanker and harvester row, set against SQL written here, the totals reconciled to the Fuel stock tile, and the reasons on screen read back through the module's own table of words.
  Every planted fault must fail the checks it names by an assertion, and every rewrite must pass every check.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { runSuite } = require('./lib/suite-runner')
const { fuelServiceTruth } = require('./lib/fuel-service-oracle')
const { checkFuelService } = require('./check-harvesters')
const { observe, validate, HarnessError, settled, installScreen, pairedBy, labelKey, readFigure, rounded } = require('./lib/browser-observe')
const { assert, through, subjectModule, runChecks, judged, caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const MODULE = 'fuel-donors'
const MODULE_FILE = `src/renderer/utilities/${MODULE}.js`
const PAGE_FILE = 'src/renderer/pages/logistics.vue'
const FIGURES_FILE = 'src/renderer/components/logistics/FuelFigures.vue'
const RESERVES_FILE = 'src/renderer/components/logistics/FuelReserves.vue'
const SAVE = 'saves/AuroraDB_270_Falryx_date_issue.db'
const IDS = { GameID: 141, RaceID: 785 }
const NAMES = { game: 'Orphean Concord', race: 'Meacham Clan' }
const TIMEOUT = 120000
// The deadline of a header to announce the sort a click asked for.
const SORT_TIMEOUT = 10000
const DETAIL = process.argv.includes('--detail')
// The page draws litres in groups of three with the apostrophe under the setting the checks start with.
const GROUPING = 'Tick'
// The sizes of the recipients of the rate rule: one inside the limit, the limit itself, a hair over it, one far over.
const RECIPIENT_HS = { inside: 19.744, limit: 20, over: 20.001, far: 39.757 }

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new Error(`The variant must apply exactly once to the source: ${from}`)
  }

  return text.replace(from, () => to)
}

// ---------- the donor result, over constructed ships ----------

// A ship as `loadFuelDonors` gives it: a tanker of the 30,000 LPH class with one undamaged system and fuel above its minimum.
const SHIP = { ShipID: 1, ShipName: 'Tanker', FleetID: 1, FleetName: 'Fleet', SystemID: 1, SystemName: 'Sol', ShipClassID: 1, ClassName: 'Class', Fuel: 1000000, FuelCapacity: 5000000, FuelTanker: 1, MinimumFuel: 100000, RefuellingRate: 30000, EnginePower: 100, Harvesters: 0, Size: 100, TransferSystems: 1, UndamagedTransfer: 1, Harvester: 0 }
const ship = (changes = {}) => ({ ...SHIP, ...changes })

// What the donor of a ship is: [name, the ship's changes, the recipient (left out when none is asked about), { permission, gate, reason }]. Written from the rules of the game: the gates are tested in this order and the first that fails decides; with none failing, the first that cannot be decided leaves the permission unknown.
const GATE_CASES = [
  ['a tanker with a system, a rate and fuel above its minimum can serve', {}, undefined, { permission: 'allowed', gate: null, reason: null }],
  ['a class that is not designated a tanker cannot serve, though it has a system and a rate', { FuelTanker: 0 }, undefined, { permission: 'blocked', gate: 'designation', reason: 'not-designated' }],
  ['a class with a rate and no designation cannot serve, the first gate being the designation', { FuelTanker: 0, RefuellingRate: 90000 }, undefined, { permission: 'blocked', gate: 'designation', reason: 'not-designated' }],
  ['a tanker whose class has no Transfer - Fuel system cannot serve, the gate being the system', { TransferSystems: 0, UndamagedTransfer: 0 }, undefined, { permission: 'blocked', gate: 'system', reason: 'no-system' }],
  ['a tanker with no system and a rate of 0 is stopped at the system, not at the rate', { TransferSystems: 0, UndamagedTransfer: 0, RefuellingRate: 0 }, undefined, { permission: 'blocked', gate: 'system', reason: 'no-system' }],
  ['a tanker whose every system is damaged cannot serve', { TransferSystems: 3, UndamagedTransfer: 0 }, undefined, { permission: 'blocked', gate: 'system', reason: 'system-damaged' }],
  ['a tanker with one of three systems left can serve', { TransferSystems: 3, UndamagedTransfer: 1 }, undefined, { permission: 'allowed', gate: null, reason: null }],
  ['a damaged row with no number leaves the permission unknown at the system', { TransferSystems: 3, UndamagedTransfer: null }, undefined, { permission: 'unknown', gate: 'system', reason: 'damage-unknown' }],
  ['a class whose systems are not in the save leaves the permission unknown at the system', { TransferSystems: null, UndamagedTransfer: null }, undefined, { permission: 'unknown', gate: 'system', reason: 'system-unknown' }],
  ['a class with a rate of 0 cannot serve', { RefuellingRate: 0 }, undefined, { permission: 'blocked', gate: 'rate', reason: 'no-rate' }],
  ['a class whose rate is not in the save leaves the permission unknown at the rate', { RefuellingRate: null }, undefined, { permission: 'unknown', gate: 'rate', reason: 'rate-unknown' }],
  ['a tanker with exactly its minimum aboard has no litres above it', { Fuel: 100000 }, undefined, { permission: 'blocked', gate: 'litres', reason: 'no-surplus' }],
  ['a tanker whose fuel is a fraction above its minimum has no whole litre above it', { Fuel: 100000.9 }, undefined, { permission: 'blocked', gate: 'litres', reason: 'no-surplus' }],
  ['a tanker one litre above its minimum can serve', { Fuel: 100001 }, undefined, { permission: 'allowed', gate: null, reason: null }],
  ['an empty tanker is stopped at the litres, never at an earlier gate it passes', { Fuel: 0 }, undefined, { permission: 'blocked', gate: 'litres', reason: 'no-surplus' }],
  ['fuel that is not in the save leaves the permission unknown at the litres', { Fuel: null }, undefined, { permission: 'unknown', gate: 'litres', reason: 'fuel-unknown' }],
  ['a minimum that is not in the save leaves the permission unknown at the litres', { MinimumFuel: null }, undefined, { permission: 'unknown', gate: 'litres', reason: 'fuel-unknown' }],
  ['a designation that is not in the save leaves the permission unknown at the designation', { FuelTanker: null }, undefined, { permission: 'unknown', gate: 'designation', reason: 'designation-unknown' }],
  ['the designation is tested before the system', { FuelTanker: 0, TransferSystems: 0, UndamagedTransfer: 0 }, undefined, { permission: 'blocked', gate: 'designation', reason: 'not-designated' }],
  ['the system is tested before the rate', { UndamagedTransfer: 0, RefuellingRate: 0 }, undefined, { permission: 'blocked', gate: 'system', reason: 'system-damaged' }],
  ['the rate is tested before the litres', { RefuellingRate: 0, Fuel: 0 }, undefined, { permission: 'blocked', gate: 'rate', reason: 'no-rate' }],
  ['a gate that fails wins over an earlier gate that cannot be decided', { UndamagedTransfer: null, RefuellingRate: 0 }, undefined, { permission: 'blocked', gate: 'rate', reason: 'no-rate' }],
  ['with no gate failing, the first gate that cannot be decided is named', { UndamagedTransfer: null, Fuel: null }, undefined, { permission: 'unknown', gate: 'system', reason: 'damage-unknown' }],
  ['a recipient is not asked about when none is given, even for a low rate', { RefuellingRate: 15000 }, undefined, { permission: 'allowed', gate: null, reason: null }],
  ['a rate under 20,000 LPH serves a recipient inside the limit', { RefuellingRate: 15000 }, { size: RECIPIENT_HS.inside }, { permission: 'allowed', gate: null, reason: null }],
  ['a rate under 20,000 LPH serves a recipient of exactly 20 HS', { RefuellingRate: 15000 }, { size: RECIPIENT_HS.limit }, { permission: 'allowed', gate: null, reason: null }],
  ['a rate under 20,000 LPH does not serve a recipient a hair over 20 HS', { RefuellingRate: 15000 }, { size: RECIPIENT_HS.over }, { permission: 'blocked', gate: 'recipient', reason: 'recipient-too-large' }],
  ['a rate under 20,000 LPH does not serve a recipient of 39.757 HS', { RefuellingRate: 15000 }, { size: RECIPIENT_HS.far }, { permission: 'blocked', gate: 'recipient', reason: 'recipient-too-large' }],
  ['a recipient whose size is not in the save leaves the permission unknown at the recipient', { RefuellingRate: 15000 }, { size: null }, { permission: 'unknown', gate: 'recipient', reason: 'recipient-unknown' }],
  ['a rate of exactly 20,000 LPH serves any recipient', { RefuellingRate: 20000 }, { size: RECIPIENT_HS.far }, { permission: 'allowed', gate: null, reason: null }],
  ['a rate of 30,000 LPH serves any recipient', {}, { size: RECIPIENT_HS.far }, { permission: 'allowed', gate: null, reason: null }],
  ['the litres are tested before the recipient', { RefuellingRate: 15000, Fuel: 0 }, { size: RECIPIENT_HS.far }, { permission: 'blocked', gate: 'litres', reason: 'no-surplus' }],
  ['a recipient that is too large blocks, with no earlier gate undecided hiding it', { RefuellingRate: 15000, UndamagedTransfer: null }, { size: RECIPIENT_HS.far }, { permission: 'blocked', gate: 'recipient', reason: 'recipient-too-large' }],
]

// The order the gates are listed in a result, as the game tests them.
const GATE_ORDER = ['designation', 'system', 'rate', 'litres', 'recipient']

const gateChecks = {
  id: 'gates',
  name: 'the donor result names allowed, blocked or unknown with the first failing gate, in the order the game tests the gates',
  run: ({ mod }) => {
    GATE_CASES.forEach(([name, changes, recipient, wanted]) => {
      const donor = mod.fuelDonor(ship(changes), recipient === undefined ? {} : { recipient })

      assert.deepEqual({ permission: donor.permission, gate: donor.gate, reason: donor.reason }, wanted, name)
      assert.deepEqual(donor.gates.map((gate) => gate.gate), GATE_ORDER, `${name}: the gates are listed in the order the game tests them`)
    })
  },
}

const recipientChecks = {
  id: 'recipient',
  name: 'a rate under 20,000 LPH names the 20 HS recipient limit, and no other rate does',
  run: ({ mod }) => {
    assert.equal(mod.fuelDonor(ship({ RefuellingRate: 15000 })).recipientLimit, 20, 'a low rate names its limit')
    assert.equal(mod.fuelDonor(ship({ RefuellingRate: 19999 })).recipientLimit, 20, 'a rate just under the threshold names its limit')
    assert.equal(mod.fuelDonor(ship({ RefuellingRate: 20000 })).recipientLimit, null, 'the threshold itself has no limit')
    assert.equal(mod.fuelDonor(ship({ RefuellingRate: 0 })).recipientLimit, null, 'a rate of 0 has no limit to name')
    assert.equal(mod.fuelDonor(ship({ RefuellingRate: null })).recipientLimit, null, 'a rate that is not known has no limit to name')
    assert.equal(mod.fuelDonor(ship({ RefuellingRate: 15000 }), { recipient: { size: RECIPIENT_HS.far } }).eligibleSurplus, 0, 'a recipient that is too large gets no litres')
    assert.equal(mod.isLowRate(15000), true, '15,000 LPH is a low rate')
    assert.equal(mod.isLowRate(20000), false, '20,000 LPH is not')
    assert.equal(mod.isLowRate(0), false, 'a rate of 0 is not a low rate')
  },
}

// The four figures of a donor: [name, the ship's changes, the player's reserve, { stored, minimum, playerReserve, eligibleSurplus, heldByReserve }].
const FIGURE_CASES = [
  ['no reserve: the surplus is the whole litres above the class minimum', { Fuel: 1000000.7, MinimumFuel: 100000 }, null, { stored: 1000000.7, minimum: 100000, playerReserve: null, eligibleSurplus: 900000, heldByReserve: 0 }],
  ['a reserve above the minimum lowers the surplus and leaves the class minimum as it is', { Fuel: 1000000.7, MinimumFuel: 100000 }, 400000, { stored: 1000000.7, minimum: 100000, playerReserve: 400000, eligibleSurplus: 600000, heldByReserve: 300000 }],
  ['a reserve below the minimum changes nothing, it is a level and not an addition', { Fuel: 1000000, MinimumFuel: 100000 }, 50000, { stored: 1000000, minimum: 100000, playerReserve: 50000, eligibleSurplus: 900000, heldByReserve: 0 }],
  ['a reserve equal to the minimum holds nothing back', { Fuel: 1000000, MinimumFuel: 100000 }, 100000, { stored: 1000000, minimum: 100000, playerReserve: 100000, eligibleSurplus: 900000, heldByReserve: 0 }],
  ['a reserve above the fuel aboard leaves a surplus of 0 and a ship that is still allowed', { Fuel: 1000000, MinimumFuel: 100000 }, 2000000, { stored: 1000000, minimum: 100000, playerReserve: 2000000, eligibleSurplus: 0, heldByReserve: 900000 }],
  ['a reserve of 0 is a reserve that is set', { Fuel: 1000000, MinimumFuel: 100000 }, 0, { stored: 1000000, minimum: 100000, playerReserve: 0, eligibleSurplus: 900000, heldByReserve: 0 }],
  ['a reserve that is negative is no reserve', { Fuel: 1000000, MinimumFuel: 100000 }, -5, { stored: 1000000, minimum: 100000, playerReserve: null, eligibleSurplus: 900000, heldByReserve: 0 }],
  ['a ship with a damaged system keeps every litre it stores and offers none', { Fuel: 1000000.7, UndamagedTransfer: 0, TransferSystems: 1 }, null, { stored: 1000000.7, minimum: 100000, playerReserve: null, eligibleSurplus: 0, heldByReserve: 0 }],
  ['a class with no system keeps the fuel aboard and the minimum of its class and offers none', { Fuel: 777, TransferSystems: 0, UndamagedTransfer: 0, RefuellingRate: 0, MinimumFuel: 500 }, null, { stored: 777, minimum: 500, playerReserve: null, eligibleSurplus: 0, heldByReserve: 0 }],
  ['a class with a rate and no designation keeps the fuel aboard and offers none', { Fuel: 4500000, FuelTanker: 0, RefuellingRate: 90000 }, null, { stored: 4500000, minimum: 100000, playerReserve: null, eligibleSurplus: 0, heldByReserve: 0 }],
  ['a ship below its class minimum keeps its fuel and has no surplus', { Fuel: 60000, MinimumFuel: 100000 }, 30000, { stored: 60000, minimum: 100000, playerReserve: 30000, eligibleSurplus: 0, heldByReserve: 0 }],
  ['a permission that cannot be decided offers no figure and keeps the stored fuel', { Fuel: 1000000, UndamagedTransfer: null }, 10000, { stored: 1000000, minimum: 100000, playerReserve: 10000, eligibleSurplus: null, heldByReserve: 0 }],
]

const figureChecks = {
  id: 'figures',
  name: 'stored fuel, class minimum, local reserve and eligible surplus are four figures, the stored fuel and the minimum never changed by a gate or a reserve',
  run: ({ mod }) => {
    FIGURE_CASES.forEach(([name, changes, reserve, wanted]) => {
      const donor = mod.fuelDonor(ship(changes), { playerReserve: reserve })

      assert.deepEqual({ stored: donor.stored, minimum: donor.minimum, playerReserve: donor.playerReserve, eligibleSurplus: donor.eligibleSurplus, heldByReserve: donor.heldByReserve }, wanted, name)
    })

    // Whatever gate stops a ship, the fuel aboard and the minimum of its class are what the save holds.
    GATE_CASES.filter(([, changes]) => changes.Fuel === undefined && changes.MinimumFuel === undefined).forEach(([name, changes, recipient]) => {
      const donor = mod.fuelDonor(ship(changes), recipient === undefined ? {} : { recipient })

      assert.equal(donor.stored, SHIP.Fuel, `${name}: the fuel aboard is the fuel the save holds`)
      assert.equal(donor.minimum, SHIP.MinimumFuel, `${name}: the minimum is the class minimum`)
    })
  },
}

// A blocked ship draws a reason in the words of the module's table, and its surplus is never drawn as a bare 0 of litres unless only the minimum stops it.
const reasonChecks = {
  id: 'reasons',
  name: 'a class with no transfer system and a class with a rate and no designation read as a reason and never as zero fuel',
  run: ({ mod }) => {
    const litres = (value) => `<${value}>`
    const texts = (changes, options = {}) => mod.donorTexts(mod.fuelDonor(ship(changes), options), litres)
    const noSystem = texts({ TransferSystems: 0, UndamagedTransfer: 0, RefuellingRate: 0, Fuel: 777 })
    const noDesignation = texts({ FuelTanker: 0, RefuellingRate: 90000, Fuel: 4500000 })
    const damaged = texts({ TransferSystems: 1, UndamagedTransfer: 0 })
    const unknown = texts({ UndamagedTransfer: null })
    const empty = texts({ Fuel: 0 })

    assert.equal(noSystem.reason, mod.REASONS['no-system'], 'the class with no system says why')
    assert.equal(noDesignation.reason, mod.REASONS['not-designated'], 'the class with no designation says why')
    assert.equal(damaged.reason, mod.REASONS['system-damaged'], 'the damaged system says why')
    assert.equal(unknown.reason, mod.REASONS['damage-unknown'], 'the damage with no number says why')
    assert.equal(noSystem.stored, '<777>', 'the class with no system still draws the fuel it holds')
    assert.equal(noDesignation.stored, '<4500000>', 'the class with no designation still draws the fuel it holds')
    assert.ok(noSystem.surplus !== '<0>' && noSystem.surplus !== '<null>', 'the surplus of a class with no system is not a figure of litres')
    assert.ok(noDesignation.surplus !== '<0>' && noDesignation.surplus !== '<null>', 'the surplus of a class with no designation is not a figure of litres')
    assert.ok(damaged.surplus !== '<0>' && damaged.surplus !== '<null>', 'the surplus of a damaged system is not a figure of litres')
    assert.ok(unknown.surplus !== '<0>' && unknown.surplus !== '<null>', 'the surplus of an undecided permission is not a figure of litres')
    assert.equal(empty.surplus, '<0>', 'an empty tanker, stopped only by the minimum, draws 0 litres of surplus')
    assert.equal(empty.reason, mod.REASONS['no-surplus'], 'an empty tanker says that no fuel is above the minimum')
    assert.equal(texts({}).reason, null, 'a tanker that can serve has no reason')
    assert.equal(texts({ RefuellingRate: 15000 }).limit !== null, true, 'a low rate names the limit on recipients')
    assert.equal(/^<\d/.test(texts({}).reserve), false, 'the reserve of a ship with none set is words, not a figure of litres')
    assert.equal(texts({}, { playerReserve: 5 }).reserve, '<5>', 'a reserve that is set is drawn as litres')
    assert.equal(Object.keys(mod.REASONS).length, new Set(Object.values(mod.REASONS)).size, 'every reason has words of its own')
  },
}

// The tanker report: rows with their donor, the counted tankers (the class is designated and has tanks, as the Fuel stock figure counts them) and the totals.
const REPORT_SHIPS = [
  ship({ ShipID: 1, Fuel: 1000, MinimumFuel: 5000 }),
  ship({ ShipID: 2, Fuel: 2500.5, MinimumFuel: 5000 }),
  ship({ ShipID: 3, Fuel: 777, FuelCapacity: 1000, FuelTanker: 0, RefuellingRate: 90000 }),
  ship({ ShipID: 4, Fuel: 50, FuelTanker: 0, RefuellingRate: 0, TransferSystems: 0, UndamagedTransfer: 0, Harvesters: 5, Harvester: 1 }),
  ship({ ShipID: 5, Fuel: 0, FuelCapacity: 0, FuelTanker: 1 }),
  ship({ ShipID: 6, Fuel: 0, MinimumFuel: 100 }),
  ship({ ShipID: 7, Fuel: 300, MinimumFuel: 100, EnginePower: 0 }),
]

const reportChecks = {
  id: 'report',
  name: 'the tanker totals are the fuel aboard of the counted tankers even when no surplus exists, and the ships that cannot serve are listed and not dropped',
  run: ({ mod }) => {
    const report = mod.tankerReport(REPORT_SHIPS, { version: '2.7.x' })
    const counted = report.rows.filter((row) => row.counted).map((row) => row.ShipID)
    const listed = report.rows.filter((row) => row.listed).map((row) => row.ShipID)

    assert.deepEqual(counted, [1, 2, 6, 7], 'the counted tankers are the designated classes with tanks')
    assert.deepEqual(listed, [1, 2, 3, 5, 6, 7], 'a class with a rate and no designation and a tanker with no tanks are listed, a harvester that is no tanker is not')
    assert.equal(report.totals.stored.value, 1000 + 2500.5 + 0 + 300, 'the stored total is the fuel aboard of the counted tankers')
    assert.equal(report.totals.ships, 4, 'four tankers are counted')
    assert.equal(report.totals.empty, 1, 'the tanker with no fuel aboard is counted as empty')
    assert.deepEqual(report.totals.permissions, { allowed: 1, blocked: 3, unknown: 0 }, 'the permissions of the counted tankers')
    assert.equal(report.totals.eligible, 200, 'the eligible surplus is the whole litres above the minimum of the one tanker that can serve')
    assert.equal(report.totals.eligibleUnknown, 0, 'every counted tanker has a decision')
    assert.equal(report.rows.find((row) => row.ShipID === 3).donor.stored, 777, 'the ship with a rate and no designation keeps the fuel it holds')
    assert.equal(report.rows.find((row) => row.ShipID === 7).site, true, 'a ship with no engines is a service site')
    assert.equal(report.rows.find((row) => row.ShipID === 1).site, false, 'a ship with engines is not')

    const noSurplus = mod.tankerReport(REPORT_SHIPS.filter((row) => [1, 2].includes(row.ShipID)))

    assert.equal(noSurplus.totals.stored.value, 3500.5, 'two tankers below their minimum still total the fuel aboard')
    assert.equal(noSurplus.totals.eligible, 0, 'and offer nothing')
    assert.equal(mod.countsAsTanker(ship({ FuelTanker: 1, FuelCapacity: 0 })), false, 'a tanker with no tanks is not counted')
    assert.equal(mod.countsAsTanker(ship({ FuelTanker: 0, RefuellingRate: 90000 })), false, 'a rate with no designation is not counted')
    assert.equal(mod.isServiceShip(ship({ FuelTanker: 0, RefuellingRate: 0, TransferSystems: 0, Harvester: 1 })), false, 'a harvester alone is no service ship')
    assert.equal(mod.isServiceShip(ship({ FuelTanker: 0, RefuellingRate: 0, TransferSystems: 2 })), true, 'a ship that mounts a transfer system is one')

    const reserved = mod.tankerReport(REPORT_SHIPS, { reserveOf: (row) => (row.ShipID === 7 ? 250 : null) })

    assert.equal(reserved.rows.find((row) => row.ShipID === 7).donor.eligibleSurplus, 50, 'the reserve of a ship comes from the reserve it is given')
    assert.equal(reserved.rows.find((row) => row.ShipID === 7).donor.stored, 300, 'and leaves its stored fuel')
    assert.equal(reserved.rows.find((row) => row.ShipID === 2).donor.playerReserve, null, 'a ship without one has none')

    const zeroed = mod.tankerReport(REPORT_SHIPS, { reserveOf: (row) => (row.ShipID === 7 ? 0 : null) })

    assert.equal(zeroed.rows.find((row) => row.ShipID === 7).donor.playerReserve, 0, 'a reserve of 0 is a reserve that is set, not none')
    assert.equal(zeroed.rows.find((row) => row.ShipID === 7).donor.eligibleSurplus, 200, 'and leaves the whole surplus above the minimum')

    const unread = mod.tankerReport(REPORT_SHIPS, { reserveRead: false, reserveOf: (row) => (row.ShipID === 7 ? 250 : null) })
    const unreadSeven = unread.rows.find((row) => row.ShipID === 7)

    assert.equal(unreadSeven.donor.eligibleSurplus, null, 'a ship that may serve has no surplus while its reserve is not read, though a reserve is handed in')
    assert.equal(unreadSeven.donor.playerReserve, null, 'and no reserve')
    assert.equal(unreadSeven.donor.reserveRead, false, 'and says that the reserve is not read')
    assert.equal(unreadSeven.donor.stored, 300, 'its stored fuel stays')
    assert.equal(unreadSeven.donor.permission, 'allowed', 'and its permission stays')
    assert.deepEqual(unread.rows.filter((row) => row.counted && row.donor.permission === 'blocked').map((row) => row.donor.eligibleSurplus), [0, 0, 0], 'a ship the game does not let serve keeps its surplus of 0, whatever the reserve')
    assert.equal(unread.totals.eligible, null, 'the eligible total is not worked out while a reserve is not read')
    assert.equal(unread.totals.eligibleUnknown, 1, 'the one counted ship that may serve is among those with no surplus')
    assert.equal(unread.totals.stored.value, 3800.5, 'the stored total stays')
    assert.deepEqual(unread.totals.permissions, { allowed: 1, blocked: 3, unknown: 0 }, 'and so do the permissions')
    assert.equal(report.rows.every((row) => row.donor.reserveRead === true), true, 'a report made with the reserves read says so')

    const unreadTexts = mod.donorTexts(unreadSeven.donor, (value) => `<${value}>`)

    assert.equal(unreadTexts.reserve, 'Not read', 'the reserve of a ship is worded as not read, never as none set')
    assert.equal(unreadTexts.surplus, 'Not read', 'and so is the surplus of a ship that may serve')
    assert.equal(unreadTexts.stored, '<300>', 'the stored fuel is drawn as it is')

    const aboard = ship({ Fuel: 1000, MinimumFuel: 100 })

    assert.equal(mod.fuelDonor(aboard, { playerReserve: 900 }).eligibleSurplus, 100, 'with the reserve read, 900 L of reserve leaves 100 L above it')
    assert.deepEqual([mod.fuelDonor(aboard, { playerReserve: 900, reserveRead: false }).eligibleSurplus, mod.fuelDonor(aboard, { playerReserve: 900, reserveRead: false }).aboveFloors, mod.fuelDonor(aboard, { playerReserve: 900, reserveRead: false }).heldByReserve], [null, null, null], 'with it not read, no figure above the floors is worked out as if no reserve existed')
    assert.equal(mod.donorTexts(mod.fuelDonor(ship({ UndamagedTransfer: null }), { reserveRead: false }), (value) => `<${value}>`).surplus === 'Not read', false, 'a permission that cannot be decided stays unknown, not not read')
    assert.equal(mod.donorTexts(mod.fuelDonor(ship({ UndamagedTransfer: 0 }), { reserveRead: false }), (value) => `<${value}>`).surplus, mod.donorTexts(mod.fuelDonor(ship({ UndamagedTransfer: 0 })), (value) => `<${value}>`).surplus, 'and a blocked ship reads as it does with the reserve read')

    const sortable = mod.tankerReport([ship({ ShipID: 1, Fuel: 1000, MinimumFuel: 5000 }), ship({ ShipID: 2 }), ship({ ShipID: 3, UndamagedTransfer: null }), ship({ ShipID: 4, FuelTanker: 0 })])

    assert.deepEqual(sortable.rows.map((row) => row.eligibleSurplus), [0, 900000, null, 0], 'each row carries its surplus as a value of its own for a table to sort by: the whole litres, 0 where the ship cannot serve, nothing where it is not known')
    assert.deepEqual(sortable.rows.map((row) => row.eligibleSurplus), sortable.rows.map((row) => row.donor.eligibleSurplus), 'and it is the surplus of the donor result')
    assert.notEqual(mod.roleText(ship({ EnginePower: 0 })), mod.roleText(ship({ FuelTanker: 0 })), 'a tanker has a role of its own, told from a ship that is no tanker')
    assert.notEqual(mod.roleText(ship({ FuelTanker: 1, Harvester: 0 })), mod.roleText(ship({ FuelTanker: 1, Harvester: 1 })), 'a tanker that harvests has a role of its own')
    assert.notEqual(mod.roleText(ship({ EnginePower: 100 })), mod.roleText(ship({ EnginePower: 0 })), 'a ship with no engines is told from one with engines')
    assert.equal(mod.roleText(ship({ FuelTanker: 0, Harvester: 1 })) !== mod.roleText(ship({ FuelTanker: 0, Harvester: 0 })), true, 'a harvester that is no tanker has a role of its own')
  },
}

// ---------- the SQL of the loader, over a constructed save ----------

const open = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(raw)))
})
const run = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
const close = (raw) => new Promise((resolve) => raw.close(resolve))

// The component ids the constructed save uses: a Transfer - Fuel system (type 61), a harvester module (type 32) and an engine (type 8) that is no transfer system.
const COMPONENT = { transfer: 61001, harvester: 32001, engine: 8001, optionalTransfer: 61002 }

// Classes of the constructed save: [id, name, tanker, rate, minimum, capacity, engines, harvesters, [[component, count]]].
const SQL_CLASSES = [
  [1, 'Three systems', 1, 30000, 100, 1000, 10, 0, [[COMPONENT.transfer, 3]]],
  [2, 'No system', 1, 0, 100, 1000, 10, 0, [[COMPONENT.engine, 1]]],
  [3, 'Rate without designation', 0, 90000, 100, 1000, 10, 0, [[COMPONENT.transfer, 1]]],
  [4, 'Count not stored', 1, 30000, 100, 1000, 10, 0, [[COMPONENT.transfer, null]]],
  [5, 'Harvester only', 0, 0, 100, 1000, 10, 4, [[COMPONENT.harvester, 4]]],
  [6, 'No tanks', 1, 30000, 100, 0, 10, 0, [[COMPONENT.transfer, 1]]],
  [7, 'Plain freighter', 0, 0, 0, 1000, 10, 0, [[COMPONENT.engine, 1]]],
  [8, 'Harvester with no tanks', 0, 0, 100, 0, 10, 4, [[COMPONENT.harvester, 1]]],
]

// Ships of the constructed save: [id, class, race, shipping line, fuel], and the damage rows: [ship, component, number].
const SQL_SHIPS = [
  [101, 1, 1, 0, 500], [102, 1, 1, 0, 500], [103, 1, 1, 0, 500], [104, 1, 1, 0, 500], [105, 1, 1, 0, 500],
  [111, 2, 1, 0, 300], [112, 3, 1, 0, 400], [113, 4, 1, 0, 600], [114, 5, 1, 0, 200], [115, 6, 1, 0, 100], [116, 7, 1, 0, 100], [117, 8, 1, 0, 40],
  [121, 1, 2, 0, 500], [122, 1, 1, 1, 500],
]
const SQL_DAMAGE = [[102, COMPONENT.transfer, 1], [103, COMPONENT.transfer, 3], [104, COMPONENT.transfer, null], [105, COMPONENT.engine, 1], [105, COMPONENT.optionalTransfer, 1]]

// What the loader must give for each ship of the constructed save, written from the rules: the systems the class mounts and those the ship has left (null where a count is not stored), and whether it harvests.
const SQL_EXPECTED = {
  101: { TransferSystems: 3, UndamagedTransfer: 3, Harvester: 0 },
  102: { TransferSystems: 3, UndamagedTransfer: 2, Harvester: 0 },
  103: { TransferSystems: 3, UndamagedTransfer: 0, Harvester: 0 },
  104: { TransferSystems: 3, UndamagedTransfer: null, Harvester: 0 },
  105: { TransferSystems: 3, UndamagedTransfer: 3, Harvester: 0 },
  111: { TransferSystems: 0, UndamagedTransfer: 0, Harvester: 0 },
  112: { TransferSystems: 1, UndamagedTransfer: 1, Harvester: 0 },
  113: { TransferSystems: null, UndamagedTransfer: null, Harvester: 0 },
  114: { TransferSystems: 0, UndamagedTransfer: 0, Harvester: 1 },
  115: { TransferSystems: 1, UndamagedTransfer: 1, Harvester: 0 },
  117: { TransferSystems: 0, UndamagedTransfer: 0, Harvester: 1 },
}

// A constructed save with the tables the loader reads; `without` drops a class column a damaged save lacks, `fuelless` leaves the fuel aboard of every ship unstated, `undesignated` makes no class a tanker.
const constructedSave = async ({ without = null, fuelless = false, undesignated = false } = {}) => {
  const raw = await open(':memory:')
  const classColumns = ['ShipClassID integer', 'ClassName text', 'GameID integer', 'RaceID integer', 'FuelTanker integer', 'RefuellingRate integer', 'MinimumFuel real', 'FuelCapacity real', 'EnginePower real', 'Harvesters integer', 'Size real'].filter((column) => !without || column.split(' ')[0] !== without)

  await run(raw, `create table FCT_ShipClass (${classColumns.join(', ')})`)
  await run(raw, 'create table FCT_Ship (ShipID integer, ShipName text, FleetID integer, ShipClassID integer, GameID integer, RaceID integer, ShippingLineID integer, Fuel real)')
  await run(raw, 'create table FCT_Fleet (FleetID integer, FleetName text, SystemID integer)')
  await run(raw, 'create table FCT_RaceSysSurvey (SystemID integer, RaceID integer, GameID integer, Name text)')
  await run(raw, 'create table FCT_ClassComponent (ClassID integer, ComponentID integer, NumComponent real, GameID integer)')
  await run(raw, 'create table FCT_ShipDesignComponents (SDComponentID integer, ComponentTypeID integer)')
  await run(raw, 'create table FCT_DamagedComponent (ShipID integer, ComponentID integer, GameID integer, Number integer)')
  await run(raw, `insert into FCT_ShipDesignComponents values (${COMPONENT.transfer}, 61), (${COMPONENT.optionalTransfer}, 61), (${COMPONENT.harvester}, 32), (${COMPONENT.engine}, 8)`)
  await run(raw, 'insert into FCT_Fleet values (1, \'Fleet\', 7)')
  await run(raw, 'insert into FCT_RaceSysSurvey values (7, 1, 1, \'Sol\')')

  for (const [id, name, tanker, rate, minimum, capacity, engines, harvesters, components] of SQL_CLASSES) {
    const values = { ShipClassID: id, ClassName: `'${name}'`, GameID: 1, RaceID: 1, FuelTanker: undesignated ? 0 : tanker, RefuellingRate: rate, MinimumFuel: minimum, FuelCapacity: capacity, EnginePower: engines, Harvesters: harvesters, Size: 10 }
    const names = Object.keys(values).filter((column) => column !== without)

    await run(raw, `insert into FCT_ShipClass (${names.join(', ')}) values (${names.map((column) => values[column]).join(', ')})`)

    for (const [component, count] of components) {
      await run(raw, `insert into FCT_ClassComponent values (${id}, ${component}, ${count === null ? 'null' : count}, 1)`)
    }
  }

  for (const [id, classId, race, line, fuel] of SQL_SHIPS) {
    await run(raw, `insert into FCT_Ship values (${id}, 'Ship ${id}', 1, ${classId}, 1, ${race}, ${line}, ${fuelless ? 'null' : fuel})`)
  }

  for (const [shipId, component, number] of SQL_DAMAGE) {
    await run(raw, `insert into FCT_DamagedComponent values (${shipId}, ${component}, 1, ${number === null ? 'null' : number})`)
  }

  return raw
}

// The loader of the module over a constructed save, through the adapter of a database whose query answers [rows] (the shape of the page's database).
const loadedFrom = async (mod, options) => {
  const raw = await constructedSave(options)

  try {
    const database = { query: async (sql) => [await all(raw, sql)] }

    return await through('loadFuelDonors', () => mod.loadFuelDonors(database, { GameID: 1, RaceID: 1 }))
  } finally {
    await close(raw)
  }
}

// The reconciliation of scripts/check-harvesters.js (`checkFuelService`, the one run over the saves, with the independent reading of scripts/lib/fuel-service-oracle.js) over a constructed save, with the module under test as the page's own: its report of mismatches, and the independent reading itself.
const reconciledFrom = async (mod, options) => {
  const raw = await constructedSave(options)

  try {
    const report = await through('checkFuelService', () => checkFuelService(raw, { race: { GameID: 1, RaceID: 1 }, ships: [], shape: '2.7' }, { fuelDonors: mod }))

    return { report, truth: await fuelServiceTruth((sql) => all(raw, sql), { GameID: 1, RaceID: 1 }) }
  } finally {
    await close(raw)
  }
}

const assertReconciled = (reconciled, what) => {
  assert.deepEqual(reconciled.report.mismatches, [], `${what}: the reconciliation finds no mismatch between the page's read and the independent reading`)
  assert.equal(reconciled.report.checked > 70, true, `${what}: it compared every figure of every ship`)
}

const sqlChecks = {
  id: 'sql',
  name: 'the loader reads the damage of a ship: no damage row is every system, a damaged row with no number leaves the permission unknown, and only the ships of the race that can serve are read',
  run: async ({ mod }) => {
    const rows = await loadedFrom(mod)
    const ids = rows.map((row) => row.ShipID)

    assert.deepEqual(ids, [101, 102, 103, 104, 105, 111, 112, 113, 114, 115, 117], 'the race\'s own ships that can serve or harvest, whatever their tanks: a freighter, a ship of another race and a shipping line\'s ship are left out')

    Object.entries(SQL_EXPECTED).forEach(([id, wanted]) => {
      const row = rows.find((candidate) => candidate.ShipID === Number(id))

      assert.deepEqual({ TransferSystems: row.TransferSystems, UndamagedTransfer: row.UndamagedTransfer, Harvester: row.Harvester }, wanted, `ship ${id}: the systems it mounts and has left`)
    })

    const donorOf = (id) => mod.fuelDonor(rows.find((row) => row.ShipID === id))

    assert.equal(donorOf(101).permission, 'allowed', 'a ship with no damage row has every system and can serve')
    assert.equal(donorOf(102).permission, 'allowed', 'a ship with two of three systems left can serve')
    assert.equal(donorOf(103).reason, 'system-damaged', 'a ship whose every system is damaged cannot serve')
    assert.equal(donorOf(103).stored, 500, 'and keeps its fuel')
    assert.equal(donorOf(104).permission, 'unknown', 'a damaged row with no number leaves the permission unknown')
    assert.equal(donorOf(104).reason, 'damage-unknown', 'and says why')
    assert.equal(donorOf(105).permission, 'allowed', 'the damage of a component that is no transfer system is not read as damage of one')
    assert.equal(donorOf(111).reason, 'no-system', 'a tanker class with no Transfer - Fuel system reads as a reason')
    assert.equal(donorOf(111).stored, 300, 'and keeps its fuel')
    assert.equal(donorOf(112).reason, 'not-designated', 'a class with a rate and no designation reads as a reason')
    assert.equal(donorOf(113).reason, 'system-unknown', 'a class whose count is not stored leaves the permission unknown')
    assert.equal(rows.find((row) => row.ShipID === 105).Harvester, 0, 'a tanker is no harvester')
    assert.equal(donorOf(117).stored, 40, 'a harvester whose class has no tanks is listed with the fuel it holds')
    assert.equal(donorOf(117).reason, 'not-designated', 'and its reason')
    assert.equal(mod.countsAsTanker(rows.find((row) => row.ShipID === 117)), false, 'and it is not counted as a tanker')
    assert.equal(donorOf(115).stored, 100, 'a tanker class with no tanks is read with the fuel it holds')
    assert.equal(mod.countsAsTanker(rows.find((row) => row.ShipID === 115)), false, 'and is not counted as a tanker')

    const reconciled = await reconciledFrom(mod)

    assertReconciled(reconciled, 'the constructed save')
    assert.deepEqual([104, 113].map((id) => ({ ...reconciled.truth.get(id) })).map(({ systems, left, permission, surplus }) => ({ systems, left, permission, surplus })), [{ systems: 3, left: null, permission: 'unknown', surplus: null }, { systems: null, left: null, permission: 'unknown', surplus: null }], 'the independent reading keeps a damage row with no number, and a class count that is not stored, as unknown and never as 0')
    assertReconciled(await reconciledFrom(mod, { fuelless: true }), 'a save that states no fuel aboard')
    assertReconciled(await reconciledFrom(mod, { undesignated: true }), 'a save with no counted tanker')
  },
}

const columnChecks = {
  id: 'columns',
  name: 'a save without a class column reads the column as not known and never as 0',
  run: async ({ mod }) => {
    const old = await loadedFrom(mod, { without: 'MinimumFuel' })
    const unread = old.find((row) => row.ShipID === 101)

    assert.equal(unread.MinimumFuel, null, 'a class minimum the save lacks is not known')
    assert.equal(mod.fuelDonor(unread).permission, 'unknown', 'a ship whose minimum is not in the save is not decided')
    assert.equal(mod.fuelDonor(unread).eligibleSurplus, null, 'and offers no figure')
    assert.equal(mod.fuelDonor(unread).stored, 500, 'the fuel it holds is still read')
  },
}

const PURE_CHECKS = [gateChecks, recipientChecks, figureChecks, reasonChecks, reportChecks, sqlChecks, columnChecks]

/* eslint-disable no-template-curly-in-string */
const PURE_FAULTS = [
  { name: 'the recipient limit is exclusive, a recipient of exactly 20 HS is refused', change: swap('recipient.size > LOW_RATE_RECIPIENT_HS ? fail', 'recipient.size >= LOW_RATE_RECIPIENT_HS ? fail'), fails: ['gates'] },
  { name: 'a ship whose every system is damaged can still serve', change: swap('ship.UndamagedTransfer <= 0 ? fail(\'system\', \'system-damaged\')', 'ship.UndamagedTransfer < 0 ? fail(\'system\', \'system-damaged\')'), fails: ['gates', 'sql'] },
  { name: 'a damaged row with no number passes the system gate', change: swap('!isNumber(ship.UndamagedTransfer) ? unknown(\'system\', \'damage-unknown\')', '!isNumber(ship.UndamagedTransfer) ? pass(\'system\')'), fails: ['gates', 'sql'] },
  { name: 'the class minimum is drawn as the larger of the minimum and the player\'s reserve', change: swap('const minimum = isNumber(ship.MinimumFuel) ? ship.MinimumFuel : null', 'const minimum = isNumber(ship.MinimumFuel) ? Math.max(ship.MinimumFuel, isNumber(playerReserve) ? playerReserve : 0) : null'), fails: ['figures'] },
  { name: 'a blocked ship has no fuel aboard', change: swap('const stored = isNumber(ship.Fuel) ? ship.Fuel : null', 'const stored = isNumber(ship.Fuel) && permission !== \'blocked\' ? ship.Fuel : null'), fails: ['figures', 'reasons'] },
  { name: 'a class with no transfer system can serve', change: swap('ship.TransferSystems <= 0 ? fail(\'system\', \'no-system\')', 'ship.TransferSystems < 0 ? fail(\'system\', \'no-system\')'), fails: ['gates', 'reasons'] },
  { name: 'a class with a rate counts as designated', change: swap('designated ? pass(\'designation\') : fail(\'designation\', \'not-designated\')', 'designated || ship.RefuellingRate > 0 ? pass(\'designation\') : fail(\'designation\', \'not-designated\')'), fails: ['gates', 'reasons'] },
  { name: 'the whole litres are the next litre up', change: swap('Math.max(0, Math.floor(stored) - Math.max(minimum', 'Math.max(0, Math.ceil(stored) - Math.max(minimum'), fails: ['figures'] },
  { name: 'a gate that cannot be decided wins over a gate that fails', change: swap('const permission = failed ? \'blocked\' : undecided ? \'unknown\' : \'allowed\'', 'const permission = undecided ? \'unknown\' : failed ? \'blocked\' : \'allowed\''), fails: ['gates'] },
  { name: 'a tanker with no tanks is counted in the tanker total', change: swap('Boolean(ship.FuelTanker) && ship.FuelCapacity > 0', 'Boolean(ship.FuelTanker)'), fails: ['report'] },
  { name: 'the stored total counts only the tankers that have a surplus', change: swap('const stored = columnTotal(\'logistics.fuelStock\', counted, ', 'const stored = columnTotal(\'logistics.fuelStock\', counted.filter((row) => row.donor.eligibleSurplus > 0), '), fails: ['report'] },
  { name: 'the damage read ignores the damage rows', change: swap('coalesce((select FCT_DamagedComponent.Number ${DAMAGE_ROWS}), 0)', '0'), fails: ['sql'] },
  { name: 'the transfer system is read as another component type', change: swap('const TRANSFER_FUEL = 61', 'const TRANSFER_FUEL = 60'), fails: ['sql'] },
  { name: 'a class column the save lacks is read as 0', change: swap('(hasClass(name) ? `FCT_ShipClass.${name}` : \'null\')', '(hasClass(name) ? `FCT_ShipClass.${name}` : \'0\')'), fails: ['columns'] },
  { name: 'the surplus of a blocked ship is drawn as 0 litres', change: swap('donor.permission === \'blocked\' && donor.gate !== \'litres\' ? \'Blocked\' : ', ''), fails: ['reasons'] },
  { name: 'a blocked ship has no reason', change: swap('reason: donor.reason ? REASONS[donor.reason] : null,', 'reason: null,'), fails: ['reasons'] },
  { name: 'a low rate names no recipient limit', change: swap('recipientLimit: isLowRate(ship.RefuellingRate) ? LOW_RATE_RECIPIENT_HS : null,', 'recipientLimit: null,'), fails: ['recipient'] },
  { name: 'the loader leaves out the ships of a class with no tanks', change: swap('FCT_Ship.ShippingLineID = 0 and (${ofClass(\'FuelTanker\')}', 'FCT_Ship.ShippingLineID = 0 and ${ofClass(\'FuelCapacity\')} > 0 and (${ofClass(\'FuelTanker\')}'), fails: ['sql'] },
  { name: 'the sort value of a report row reads an unknown surplus as 0', change: swap('eligibleSurplus: donor.eligibleSurplus, role', 'eligibleSurplus: donor.eligibleSurplus === null ? 0 : donor.eligibleSurplus, role'), fails: ['report'] },
  { name: 'a player reserve of 0 litres is taken for no reserve in the donor result', change: swap('isNumber(playerReserve) && playerReserve >= 0 ? playerReserve : null', 'isNumber(playerReserve) && playerReserve > 0 ? playerReserve : null'), fails: ['report'] },
  { name: 'the stored total of tankers that state no fuel is 0', change: (text) => swap('\'the fuel aboard\', \'tankers\')', '\'the fuel aboard\', \'tankers\'))')(swap('const stored = columnTotal(', 'const zeroed = (total) => ({ ...total, value: total.value === null ? 0 : total.value }); const stored = zeroed(columnTotal(')(text)), fails: ['sql'] },
  { name: 'a reserve that is not read is taken for none set in the donor result', change: swap('const unread = reserveRead === false', 'const unread = false'), fails: ['report'] },
  { name: 'the surplus above the floors is worked out while the reserve is not read', change: swap('gameAvailable === null || unread ? null : Math.max(0, Math.floor(stored)', 'gameAvailable === null ? null : Math.max(0, Math.floor(stored)'), fails: ['report'] },
  { name: 'the eligible total is summed whether or not the reserve is read', change: swap('known.length && reserveRead !== false ?', 'known.length ?'), fails: ['report'] },
  { name: 'the tanker report does not hand on whether the reserve is read', change: swap('reserveOf(ship), reserveRead, version', 'reserveOf(ship), version'), fails: ['report'] },
  { name: 'the words of the reserve ignore that it is not read', change: swap('donor.reserveRead === false ? NOT_READ_TEXT : donor.playerReserve === null', 'donor.playerReserve === null'), fails: ['report'] },
  { name: 'the surplus of a ship that may serve is worded as 0 litres while the reserve is not read', change: swap('donor.eligibleSurplus === null ? NOT_READ_TEXT : litres(donor.eligibleSurplus)', 'litres(donor.eligibleSurplus === null ? 0 : donor.eligibleSurplus)'), fails: ['report'] },
]
/* eslint-enable no-template-curly-in-string */

const PURE_BENIGN = [
  { name: 'the condition of the system gate parenthesised', change: swap('ship.TransferSystems <= 0 ? fail(\'system\', \'no-system\')', '(ship.TransferSystems <= 0) ? fail(\'system\', \'no-system\')') },
  { name: 'the low-rate test written with the operands turned about', change: swap('isNumber(rate) && rate > 0 && rate < LOW_RATE_LPH', 'isNumber(rate) && 0 < rate && LOW_RATE_LPH > rate') },
  { name: 'the larger of the minimum and the reserve written with the operands turned about', change: swap('Math.max(minimum, reserve === null ? 0 : reserve)', 'Math.max(reserve === null ? 0 : reserve, minimum)') },
  { name: 'the words of one reason put another way', change: swap('\'Not designated as a tanker\'', '\'The class carries no tanker designation\'') },
  { name: 'the recipient test written as a negated comparison', change: swap('recipient.size > LOW_RATE_RECIPIENT_HS ? fail', '!(recipient.size <= LOW_RATE_RECIPIENT_HS) ? fail') },
  { name: 'the tanker role worded as a fuel tanker', change: swap('tanker: \'Tanker\', harvester', 'tanker: \'Fuel tanker\', harvester') },
]

// ---------- the page, in a browser ----------

// The kinds of ship planted in the copy of the save, each with what the rules say of it: { permission, gate or reason code, surplus: 'number' (the whole litres above the minimum), 'none' (no figure of litres) or 'zero' }.
const KINDS = {
  noSystem: { permission: 'blocked', reason: 'no-system', surplus: 'none', listed: true, counted: true },
  noDesignation: { permission: 'blocked', reason: 'not-designated', surplus: 'none', listed: true, counted: false },
  site: { permission: 'blocked', reason: 'no-surplus', surplus: 'zero', listed: true, counted: true, empty: true, service: true },
  damaged: { permission: 'blocked', reason: 'system-damaged', surplus: 'none', listed: true, counted: true },
  undecided: { permission: 'unknown', reason: 'damage-unknown', surplus: 'none', listed: true, counted: true },
  short: { permission: 'blocked', reason: 'no-surplus', surplus: 'zero', listed: true, counted: true },
  fraction: { permission: 'allowed', reason: null, surplus: 'number', listed: true, counted: true },
  oneModule: { permission: 'blocked', reason: 'not-designated', surplus: 'none', listed: false, counted: false },
  tankless: { permission: 'blocked', reason: 'not-designated', surplus: 'none', listed: false, counted: false },
}

// The statements that make the copy of the save: classes cloned from the save's own (a Lynx, a tanker with one system, and a Hermes, a harvester tanker with one system), ships moved into them, fuel and damage planted. Each cloned class gets an id above the largest.
const cloneClass = (source, id, name, changes, dropTransfer, extra = []) => [
  'drop table if exists temp.VIR_Clone',
  `create temp table VIR_Clone as select * from FCT_ShipClass where ShipClassID = ${source}`,
  `update temp.VIR_Clone set ShipClassID = ${id}, ClassName = '${name}'${changes.length ? `, ${changes.join(', ')}` : ''}`,
  'insert into FCT_ShipClass select * from temp.VIR_Clone',
  'drop table temp.VIR_Clone',
  `insert into FCT_ClassComponent (GameID, ClassID, ComponentID, NumComponent, ChanceToHit, ElectronicCTH) select GameID, ${id}, ComponentID, NumComponent, ChanceToHit, ElectronicCTH from FCT_ClassComponent where ClassID = ${source}${dropTransfer ? ' and ComponentID not in (select SDComponentID from FCT_ShipDesignComponents where ComponentTypeID = 61)' : ''}`,
  ...extra,
]

const plan = async (raw) => {
  const classId = async (name) => (await all(raw, `select ShipClassID as id from FCT_ShipClass where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID} and ClassName = '${name}'`))[0].id
  const shipsOf = async (id) => (await all(raw, `select ShipID as id from FCT_Ship where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID} and ShipClassID = ${id} order by ShipID`)).map((row) => row.id)
  const lynx = await classId('Lynx')
  const hermes = await classId('Hermes')
  const [l1, l2, l3] = await shipsOf(lynx)
  const [h1, h2, h3, h4, h5, h6] = await shipsOf(hermes)
  const [{ top }] = await all(raw, 'select max(ShipClassID) as top from FCT_ShipClass')
  const [{ component }] = await all(raw, `select cc.ComponentID as component from FCT_ClassComponent cc inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where cc.ClassID = ${hermes} and d.ComponentTypeID = 61`)
  const classes = { noSystem: top + 1, noDesignation: top + 2, site: top + 3, oneModule: top + 4, tankless: top + 5 }
  const moves = (id, ids) => ids.map((shipId) => `update FCT_Ship set ShipClassID = ${id} where ShipID = ${shipId}`)
  const statements = [
    `update FCT_Race set NPR = 0 where RaceID = ${IDS.RaceID}`,
    ...cloneClass(lynx, classes.noSystem, 'Probe without a system', ['RefuellingRate = 0'], true),
    ...cloneClass(lynx, classes.noDesignation, 'Probe without a designation', ['FuelTanker = 0', 'RefuellingRate = 90000'], false),
    ...cloneClass(lynx, classes.site, 'Probe without engines', ['EnginePower = 0'], false),
    ...cloneClass(hermes, classes.oneModule, 'Probe one module', ['FuelTanker = 0', 'RefuellingRate = 0', 'Harvesters = 1'], true, [`update FCT_ClassComponent set NumComponent = 1 where ClassID = ${top + 4} and ComponentID in (select SDComponentID from FCT_ShipDesignComponents where ComponentTypeID = 32)`]),
    ...cloneClass(hermes, classes.tankless, 'Probe harvester without tanks', ['FuelTanker = 0', 'RefuellingRate = 0', 'FuelCapacity = 0'], true),
    ...moves(classes.noSystem, [l1]),
    ...moves(classes.noDesignation, [l2]),
    ...moves(classes.site, [l3]),
    ...moves(classes.oneModule, [h5]),
    ...moves(classes.tankless, [h6]),
    `update FCT_Ship set Fuel = 0 where ShipID = ${h6}`,
    `update FCT_Ship set Fuel = 0 where ShipID = ${l3}`,
    `insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${h1}, ${component}, ${IDS.GameID}, 1)`,
    `insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${h2}, ${component}, ${IDS.GameID}, null)`,
    `update FCT_Ship set Fuel = (select MinimumFuel from FCT_ShipClass where ShipClassID = FCT_Ship.ShipClassID) - 1000 where ShipID = ${h3}`,
    `update FCT_Ship set Fuel = (select MinimumFuel from FCT_ShipClass where ShipClassID = FCT_Ship.ShipClassID) + 500.75 where ShipID = ${h4}`,
  ]

  return { statements, kinds: { [l1]: 'noSystem', [l2]: 'noDesignation', [l3]: 'site', [h1]: 'damaged', [h2]: 'undecided', [h3]: 'short', [h4]: 'fraction', [h5]: 'oneModule', [h6]: 'tankless' } }
}

// A copy of the save in a folder of its own with the planted ships, and what SQL written here says of its ships.
const saveCopy = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fuel-donors-'))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await open(file)

  try {
    const planted = await plan(raw)

    for (const statement of planted.statements) {
      await run(raw, statement)
    }

    // The ships the page lists, the tankers it counts and the harvesters, from the tables as they stand: a ship is listed when its class is a tanker or has a rate or mounts a transfer system, counted when it is a tanker with tanks, whatever the tanks of a harvester.
    const ships = await all(raw, `select s.ShipID as id, s.ShipName as name, s.Fuel as fuel, c.MinimumFuel as minimum, c.FuelTanker as tanker, c.FuelCapacity as capacity, c.RefuellingRate as rate, c.Harvesters as harvesters, c.EnginePower as engines, (select count(*) from FCT_ClassComponent cc inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where cc.ClassID = c.ShipClassID and d.ComponentTypeID = 61) as transfers from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.GameID = ${IDS.GameID} and s.RaceID = ${IDS.RaceID} and s.ShippingLineID = 0`)

    // The class each ship is of, from the same tables.
    const classes = new Map((await all(raw, `select s.ShipID as id, s.ShipClassID as classId, c.ClassName as className from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.GameID = ${IDS.GameID} and s.RaceID = ${IDS.RaceID}`)).map((row) => [row.id, row]))

    return { folder, file, kinds: planted.kinds, ships: ships.map((row) => ({ ...row, classId: classes.get(row.id).classId, className: classes.get(row.id).className })) }
  } finally {
    await close(raw)
  }
}

// What each ship the page lists should show, from the rules and the numbers of the save: { id, listed, counted, harvester, permission, reason, surplus ('number' with `litres`, 'zero', 'none'), fuel, minimum, service, empty }.
const oracleOf = (copy) => copy.ships.map((row) => {
  const kind = KINDS[copy.kinds[row.id]] || null
  const litres = Math.floor(row.fuel) - row.minimum
  const base = kind || (litres > 0 ? { permission: 'allowed', reason: null, surplus: 'number' } : { permission: 'blocked', reason: 'no-surplus', surplus: 'zero' })
  const listed = kind ? kind.listed : row.tanker === 1 || row.rate > 0 || row.transfers > 0
  const counted = kind ? kind.counted : row.tanker === 1 && row.capacity > 0

  return { id: row.id, name: row.name, classId: row.classId, className: row.className, listed, counted, tanker: row.tanker === 1, harvester: row.harvesters > 0, permission: base.permission, reason: base.reason, surplus: base.surplus, litres: base.surplus === 'number' ? litres : null, fuel: row.fuel, minimum: row.minimum, service: Boolean(base.service) || row.engines === 0, empty: row.fuel === 0 }
})

// What the page on screen shows; runs in the page through the readers of scripts/lib/browser-observe.js (`installScreen`). Hooks the template carries say what an element is; each part is read with the text it draws and whether it is on screen. Nothing is judged here.
const readScreen = () => {
  const { visible, visibleText, hooked } = window.__screen
  const panel = document.querySelector('[data-donor-panel]')
  const rowsOf = (root, identity, cells) => (root ? [...root.querySelectorAll('tr')].filter((row) => row.querySelector(`[${identity}]`)).map((row) => ({ ship: row.querySelector(`[${identity}]`).getAttribute(identity), on: visible(row), site: row.querySelector('[data-service-site]') ? row.querySelector('[data-service-site]').getAttribute('data-service-site') : null, cells: hooked(row, cells) })) : [])
  // The characters just before and just after an element within its region, from the text a player sees: the text nodes whose parent is on screen, in the raw text they hold, whatever elements wrap them. A hidden sibling is no neighbour. `before` and `after` are the one character beside the element; `beforeNear` and `afterNear` the nearest one that is no space.
  const beside = (element, root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const shown = []

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!element.contains(node) && node.parentElement && visible(node.parentElement)) {
        shown.push(node)
      }
    }

    const text = (nodes) => nodes.map((node) => node.data).join('')
    const before = text(shown.filter((node) => element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING))
    const after = text(shown.filter((node) => element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))

    return { before: before.slice(-1), after: after.slice(0, 1), beforeNear: before.trimEnd().slice(-1), afterNear: after.trimStart().slice(0, 1) }
  }
  const figuresOf = (row) => [...row.querySelectorAll('[data-fuel-figure]')].map((figure) => {
    const value = figure.querySelector('[data-fuel-value]')

    return { role: figure.getAttribute('data-fuel-figure'), on: visible(figure), text: value ? visibleText(value) : '', bounds: value ? beside(value, figure) : null }
  })
  const harvesters = [...document.querySelectorAll('tr')].filter((row) => row.querySelector('[data-harvester-ship]')).map((row) => ({ ship: row.querySelector('[data-harvester-ship]').getAttribute('data-harvester-ship'), on: visible(row), name: hooked(row, 'data-harvester-name'), role: hooked(row, 'data-harvester-role'), permission: hooked(row, 'data-fuel-text'), figures: figuresOf(row) }))

  const recordsRoot = document.querySelector('[data-fuel-records]')
  const fuelRecords = () => ({ none: recordsRoot ? hooked(recordsRoot, 'data-fuel-no-records') : [], lines: recordsRoot ? [...recordsRoot.querySelectorAll('[data-fuel-record]')].map((line) => ({ on: visible(line), applied: line.getAttribute('data-fuel-applied'), type: hooked(line, 'data-fuel-record-type'), name: hooked(line, 'data-fuel-record-name'), amount: hooked(line, 'data-fuel-record-amount') })) : [] })

  return {
    panel: panel ? visible(panel) : false,
    chip: hooked(document.body, 'data-donor-chip'),
    values: hooked(document.body, 'data-donor-value'),
    bounds: [...document.querySelectorAll('[data-donor-value]')].map((element) => ({ role: element.getAttribute('data-donor-value'), ...beside(element, element.closest('[data-donor-total], [data-donor-chip]')) })),
    totals: panel ? hooked(panel, 'data-donor-total') : [],
    rows: rowsOf(panel, 'data-donor-ship', 'data-donor-cell'),
    sites: panel ? hooked(panel, 'data-service-site') : [],
    harvesters,
    fuelRecords: fuelRecords(),
    tile: hooked(document.body, 'data-tile-note'),
  }
}

const prepare = async (page, url, step) => {
  const stored = { logisticsTankersTable: { sortBy: ['Fuel'], sortDesc: [true], itemsPerPage: -1 }, logisticsHarvestersTable: { sortBy: [], sortDesc: false, itemsPerPage: -1 } }

  await page.context().addInitScript((seed) => {
    const key = 'aurora-electrons:config'

    if (!sessionStorage.getItem('aurora-check-seeded')) {
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...seed }))
      sessionStorage.setItem('aurora-check-seeded', '1')
    }
  }, stored)

  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })
  await installScreen(page)

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  step('waiting for the reads that the picking of the race starts')

  await settled(page, { limit: TIMEOUT })

  step('opening /logistics')
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/logistics')
  await page.waitForFunction(pageLoading.arrived, '/logistics', { timeout: TIMEOUT })
  await page.waitForFunction(`document.querySelector('[data-donor-panel] [data-donor-ship]') !== null || !(${pageLoading})()`, null, { timeout: TIMEOUT }).catch(() => {})
  step('waiting for the page to settle')
  await settled(page, { limit: TIMEOUT, loading: pageLoading })
}

// The tanker table sorted by its Eligible surplus column as a player does it: the header above the surplus cells clicked once (ascending) and again (descending), the rows read after each. Empty lists when the table has no surplus cell.
const sortBySurplus = async (page, step) => {
  const index = await page.evaluate(() => {
    const cell = document.querySelector('[data-donor-panel] [data-donor-cell="surplus"]')
    const td = cell ? cell.closest('td') : null

    return td ? [...td.parentElement.children].indexOf(td) : -1
  })

  if (index < 0) {
    return { ascending: [], descending: [] }
  }

  const header = page.locator('[data-donor-panel] thead th').nth(index)
  const sorted = async (direction) => {
    step(`sorting the tankers by the surplus, ${direction}`)
    await header.click()
    await page.waitForFunction(({ column, state }) => document.querySelectorAll('[data-donor-panel] thead th')[column].getAttribute('aria-sort') === state, { column: index, state: direction }, { timeout: SORT_TIMEOUT })

    return (await page.evaluate(readScreen)).rows
  }
  const ascending = await sorted('ascending')

  return { ascending, descending: await sorted('descending') }
}

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The wait after a step of the reserve form: the screen has drawn what the step changed, and the reads that follow it and the reads those start in turn are in.
const settleAfter = (page) => settled(page, { limit: TIMEOUT, loading: pageLoading })

const recordLine = (page, name) => page.locator('[data-fuel-record]').filter({ has: page.locator('[data-fuel-record-name]').filter({ hasText: new RegExp(`^\\s*${escapePattern(name)}\\s*$`) }) })

// The form is closed, or says why it is not: a step that waits on a text a fault could suppress would stop the run instead of judging it.
const formDone = (page) => page.waitForFunction(() => document.querySelector('[data-fuel-form]') === null || document.querySelector('[data-fuel-message]') !== null, null, { timeout: TIMEOUT })

// A reserve kept as a player does it: the record form opened, the kind of source chosen, the source picked from the list by what it is called, the scenario typed, the litres entered and the record kept.
const keepReserve = async (page, step, { type, search, pattern, scenario, amount }) => {
  step(`keeping a reserve of ${amount} L for a ${type}`)
  await page.locator('[data-fuel-new]').click({ timeout: TIMEOUT })
  await page.locator(`[data-fuel-type-option="${type}"]`).click({ timeout: TIMEOUT })
  await page.locator('input[data-fuel-pick]').fill(search, { timeout: TIMEOUT })
  await page.locator('.menuable__content__active .v-list-item').filter({ hasText: pattern }).first().click({ timeout: TIMEOUT })
  await page.locator('input[data-fuel-scenario-pick]').fill(scenario, { timeout: TIMEOUT })
  await page.locator('input[data-fuel-scenario-pick]').press('Enter', { timeout: TIMEOUT })
  await page.locator('input[data-fuel-input]').fill(String(amount), { timeout: TIMEOUT })
  await page.locator('[data-fuel-save]').click({ timeout: TIMEOUT })
  await formDone(page)
  await settleAfter(page)
}

const editReserve = async (page, step, name, amount) => {
  step(`editing the reserve of ${name} to ${amount} L`)
  await recordLine(page, name).locator('[data-fuel-edit]').click({ timeout: TIMEOUT })
  await page.locator('input[data-fuel-input]').fill(String(amount), { timeout: TIMEOUT })
  await page.locator('[data-fuel-save]').click({ timeout: TIMEOUT })
  await formDone(page)
  await settleAfter(page)
}

const clearReserve = async (page, step, name) => {
  step(`clearing the reserve of ${name}`)

  const line = recordLine(page, name)

  await line.locator('[data-fuel-clear]').click({ timeout: TIMEOUT })
  await line.locator('[data-fuel-clear-confirm]').click({ timeout: TIMEOUT })
  await page.waitForFunction(() => document.querySelector('[data-fuel-clear-confirm]') === null, null, { timeout: TIMEOUT })
  await settleAfter(page)
}

// The screen while the reserve records are not read, then the records put back: `loading` is the page before the Fuel panel has reported (the page holds none), `failed` the Fuel panel with a read that failed, set through the panel's own record of failed reads so its readiness and its report follow from it.
const unreadStage = async (page, step, how) => {
  step(`reading the screen while the reserve records are ${how}`)
  await page.evaluate((mode) => {
    const panel = document.querySelector('[data-fuel-reserves]').__vue__
    let vm = panel.$parent

    while (vm && !('fuelReserves' in vm.$data)) {
      vm = vm.$parent
    }

    window.__unread = { panel, vm, loadErrors: panel.loadErrors }

    if (mode === 'loading') {
      vm.fuelReserves = null
    } else {
      panel.loadErrors = { ...panel.loadErrors, reserveObjects: 'planted failure' }
    }
  }, how)
  await settleAfter(page)

  const { rows, values, harvesters } = await page.evaluate(readScreen)

  await page.evaluate(() => {
    const held = window.__unread

    held.panel.loadErrors = held.loadErrors
    held.vm.fuelReserves = held.panel.reserves
  })
  await settleAfter(page)

  return { rows, values, harvesters }
}

// The page as it opens, sorted both ways, then the reserves kept, edited and cleared as a player does it, the screen read after each step: `stages` holds the tanker rows, the totals and the records of each.
const observePage = (browser, url) => observe(browser, async ({ page, step }) => {
  await prepare(page, url, step)
  step('reading the screen')

  const screen = await page.evaluate(readScreen)
  const sorts = await sortBySurplus(page, step)
  const plan = ENV.truth.reserves
  const stages = [screen]
  const read = async () => stages.push(await page.evaluate(readScreen))

  await keepReserve(page, step, { type: 'class', search: plan.className, pattern: new RegExp(`^\\s*${escapePattern(plan.className)}\\s*$`), scenario: plan.scenario, amount: plan.first })
  await read()
  const unread = { loading: await unreadStage(page, step, 'loading'), failed: await unreadStage(page, step, 'failed') }
  await editReserve(page, step, plan.className, plan.second)
  await read()
  await keepReserve(page, step, { type: 'ship', search: plan.shipName, pattern: new RegExp(`^\\s*${escapePattern(plan.shipName)} ·`), scenario: plan.scenario, amount: plan.override })
  await read()
  await clearReserve(page, step, plan.shipName)
  await read()
  await clearReserve(page, step, plan.className)
  await read()

  return { ...screen, sorts, unread, stages: stages.map(({ rows, values, fuelRecords }) => ({ rows, values, fuelRecords })) }
})

// What the reserves of the plan say of one ship at one step: its own reserve holds over its class's, even when it is 0.
const reserveFor = (plan, state, row) => {
  const own = row.id === plan.shipId ? state.ship : null
  const inherited = row.classId === plan.classId ? state.class : null

  return { amount: own !== null ? own : inherited, source: own !== null ? 'ship' : inherited !== null ? 'class' : null }
}

// The surplus the page should draw for a ship under a reserve: the whole litres above the larger of the class minimum and the reserve, 0 where only the minimum stops it, no figure where the permission is not known.
const surplusFor = (row, amount) => (row.surplus === 'number' ? Math.max(0, Math.floor(row.fuel) - Math.max(row.minimum, amount === null ? 0 : amount)) : row.surplus === 'zero' ? 0 : null)

// ---------- the checks of one observation ----------

const verdict = (ok, evidence) => (ok ? true : short(evidence))

// The one entry of a part that is on screen, or null when none is or several are.
const oneOf = (entries) => {
  const on = entries.filter((entry) => entry.on)

  return on.length === 1 ? on[0] : null
}

const cell = (row, role) => {
  const entry = oneOf(row.cells.filter((candidate) => candidate.role === role))

  return entry ? entry.text : null
}

// A figure of litres read whole: "1'234 L" is 1234, a word or a dash is null.
const litresOf = (text) => {
  const match = typeof text === 'string' ? /^(.*) L$/.exec(text) : null

  return match ? readFigure(match[1], GROUPING) : null
}

// A role as the screen words it, read back through the module's own table: { parts: the kinds it names, site } or null when it names no word of the table. Each word is looked for wherever it stands, the longest first and taken out once found, so neither the order of the words nor what joins them is judged.
const roleKinds = (text, words) => {
  if (typeof text !== 'string') {
    return null
  }

  let rest = text
  const named = []

  for (const kind of ['neither', 'site', 'tanker', 'harvester']) {
    if (rest.includes(words[kind])) {
      named.push(kind)
      rest = rest.split(words[kind]).join(' ')
    }
  }

  const parts = named.filter((kind) => kind !== 'site' && kind !== 'neither').sort()

  return named.length === 0 || (named.includes('neither') && parts.length > 0) ? null : { parts, site: named.includes('site') }
}

const linesOf = (entries) => entries.filter((entry) => entry.on)

// The ships of the oracle the tanker table should list, paired with the lines of the screen by the identity each line's hook carries.
const paired = (what, lines, oracle, key = 'ship') => pairedBy(what, linesOf(lines), oracle, (line) => line[key], (row) => String(row.id))

const CHECKS = [
  ['panel', 'the panel of the tankers is on screen with its chip and four totals, each drawn once', (o) => verdict(o.panel && oneOf(o.chip) !== null && ['stored', 'surplus', 'permissions', 'empty'].every((role) => oneOf(o.totals.filter((entry) => entry.role === role)) !== null), { panel: o.panel, chip: o.chip, totals: o.totals.map((entry) => entry.role) })],
  ['totals', 'the stored total is the fuel aboard of the counted tankers and the Fuel stock tile\'s tankers are the same figure, the eligible total, the counts and the permissions follow the ships, each read whole', (o, t) => {
    const counted = t.oracle.filter((row) => row.counted)
    const stored = counted.reduce((sum, row) => sum + row.fuel, 0)
    const eligible = counted.reduce((sum, row) => sum + (row.surplus === 'number' ? row.litres : 0), 0)
    const value = (role) => {
      const entry = oneOf(o.values.filter((candidate) => candidate.role === role))

      return entry ? entry.text : null
    }
    const note = oneOf(o.tile)
    const inTile = note ? /tankers ([^,;]+)(?:,|;|$)/.exec(note.text) : null
    const wanted = { permissions: ['allowed', 'blocked', 'unknown'].map((permission) => counted.filter((row) => row.permission === permission).length), empty: counted.filter((row) => row.empty).length, ships: counted.length }
    const seen = { stored: litresOf(value('stored')), eligible: litresOf(value('eligible')), permissions: ['allowed', 'blocked', 'unknown'].map((role) => readFigure(value(role), GROUPING)), empty: readFigure(value('empty'), GROUPING), ships: readFigure(value('ships'), GROUPING), chip: value('chip'), tile: inTile && inTile[1].trim() }
    // A figure stands alone: the character just before and just after its element is a space, a separator or the edge of its region, never a sign, a letter, a digit or a point that would run into it. The words around it are not judged.
    const roles = ['ships', 'chip', 'stored', 'eligible', 'allowed', 'blocked', 'unknown', 'empty']
    const apart = (character) => /^$|[\s·,;:()]/.test(character)
    const stray = roles.filter((role) => {
      const bounds = o.bounds.filter((entry) => entry.role === role)

      return bounds.length !== 1 || !apart(bounds[0].before) || !apart(bounds[0].after)
    })

    return verdict(seen.stored !== null && Math.abs(seen.stored - stored) <= 0.5 && seen.eligible !== null && Math.abs(seen.eligible - eligible) <= 0.5 && JSON.stringify(seen.permissions) === JSON.stringify(wanted.permissions) && seen.empty === wanted.empty && seen.ships === wanted.ships && seen.chip !== null && seen.chip === seen.tile && stray.length === 0, { seen, stored, eligible, wanted, stray })
  }],
  ['rows', 'the tanker table lists exactly the ships the save says are tankers, have a rate or mount a transfer system, each by its identity', (o, t) => {
    const { problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))

    return verdict(problems.length === 0, problems.slice(0, 3))
  }],
  ['names', 'each line of both tables shows the name of the ship its identity says', (o, t) => {
    const tankers = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const harvesters = paired('the harvester table', o.harvesters, t.oracle.filter((row) => row.harvester))
    const nameOf = (entries) => {
      const entry = oneOf(entries)

      return entry ? entry.text : null
    }
    const shown = [...tankers.pairs.map(([row, line]) => [row, nameOf(line.cells.filter((entry) => entry.role === 'name'))]), ...harvesters.pairs.map(([row, line]) => [row, nameOf(line.name)])]
    const wrong = shown.filter(([row, name]) => name !== row.name).map(([row, name]) => [row.name, name])

    return verdict(tankers.problems.length === 0 && harvesters.problems.length === 0 && wrong.length === 0 && shown.length > 0, { problems: [...tankers.problems, ...harvesters.problems].slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['roles', 'the role each line of both tables shows names the kinds of the ship (a tanker, a harvester, neither) and whether it is a service site, read back through the module\'s own words', (o, t) => {
    const tankers = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const harvesters = paired('the harvester table', o.harvesters, t.oracle.filter((row) => row.harvester))
    const shown = [...tankers.pairs.map(([row, line]) => [row, oneOf(line.cells.filter((entry) => entry.role === 'role'))]), ...harvesters.pairs.map(([row, line]) => [row, oneOf(line.role)])]
    const wrong = shown.filter(([row, entry]) => JSON.stringify(roleKinds(entry && entry.text, t.words.roles)) !== JSON.stringify({ parts: [row.tanker ? 'tanker' : null, row.harvester ? 'harvester' : null].filter(Boolean).sort(), site: row.service })).map(([row, entry]) => [row.name, entry && entry.text])

    return verdict(tankers.problems.length === 0 && harvesters.problems.length === 0 && wrong.length === 0 && shown.some(([row]) => row.service), { problems: [...tankers.problems, ...harvesters.problems].slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['figures', 'each tanker shows its stored fuel, class minimum, local reserve and eligible surplus as four separate figures, each equal to the save\'s numbers, the surplus the whole litres above the minimum', (o, t) => {
    const { pairs, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const wrong = pairs.flatMap(([row, line]) => {
      const stored = litresOf(cell(line, 'stored'))
      const minimum = litresOf(cell(line, 'minimum'))
      const reserve = litresOf(cell(line, 'reserve'))
      const surplus = litresOf(cell(line, 'surplus'))
      const surplusWanted = row.surplus === 'number' ? row.litres : row.surplus === 'zero' ? 0 : null
      const found = [stored === rounded(row.fuel) ? null : ['stored', stored, rounded(row.fuel)], minimum === rounded(row.minimum) ? null : ['minimum', minimum, rounded(row.minimum)], reserve === null ? null : ['reserve', reserve, 'no figure'], surplus === surplusWanted ? null : ['surplus', surplus, surplusWanted]].filter(Boolean)

      return found.map((entry) => [row.name, ...entry])
    })

    return verdict(problems.length === 0 && wrong.length === 0, { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['permission', 'the permission of each tanker is the one the rules give, read back through the module\'s own words', (o, t) => {
    const { pairs, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const wrong = pairs.filter(([row, line]) => labelKey(cell(line, 'permission'), t.words.permissions) !== row.permission).map(([row, line]) => [row.name, cell(line, 'permission'), row.permission])

    return verdict(problems.length === 0 && wrong.length === 0, { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['inventory', 'a ship whose permission is lost for any reason still shows every litre it stores', (o, t) => {
    const { pairs: every, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const pairs = every.filter(([row]) => row.permission !== 'allowed')
    const wrong = pairs.filter(([row, line]) => litresOf(cell(line, 'stored')) !== rounded(row.fuel)).map(([row, line]) => [row.name, cell(line, 'stored'), row.fuel])

    return verdict(problems.length === 0 && pairs.length > 0 && wrong.length === 0, { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4), ships: pairs.length })
  }],
  ['reasons', 'a class with no transfer system, a class with a rate and no designation, a damaged system and a damage with no number each show their reason and no figure of litres for the surplus, read back through the module\'s own words', (o, t) => {
    const { pairs: every, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const pairs = every.filter(([row]) => row.reason !== null)
    const wrong = pairs.flatMap(([row, line]) => {
      const reason = labelKey(cell(line, 'reason'), t.words.reasons)
      const surplus = litresOf(cell(line, 'surplus'))

      return [reason === row.reason ? null : [row.name, 'reason', cell(line, 'reason'), row.reason], row.surplus === 'none' && surplus !== null ? [row.name, 'surplus', cell(line, 'surplus'), 'no figure'] : null].filter(Boolean)
    })
    const kinds = new Set(pairs.map(([row]) => row.reason))

    return verdict(problems.length === 0 && wrong.length === 0 && ['no-system', 'not-designated', 'system-damaged', 'damage-unknown', 'no-surplus'].every((reason) => kinds.has(reason)), { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4), kinds: [...kinds] })
  }],
  ['uncounted', 'a class with a rate and no designation is listed as outside the tanker stock, and the ships in the stock are not marked so', (o, t) => {
    const { pairs, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const wrong = pairs.filter(([row, line]) => (cell(line, 'uncounted') !== null) === row.counted).map(([row]) => row.name)

    return verdict(problems.length === 0 && wrong.length === 0 && pairs.some(([row]) => !row.counted), { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['empty', 'an empty tanker is listed and marked empty, and a tanker with fuel aboard is not', (o, t) => {
    const { pairs, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const wrong = pairs.filter(([row, line]) => (cell(line, 'empty') !== null) !== row.empty).map(([row]) => row.name)

    return verdict(problems.length === 0 && wrong.length === 0 && pairs.some(([row]) => row.empty), { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['sites', 'a ship with no engines is marked a service site and no ship with engines is', (o, t) => {
    const { pairs, problems } = paired('the tanker table', o.rows, t.oracle.filter((row) => row.listed))
    const wrong = pairs.filter(([row, line]) => line.site !== (row.service ? 'yes' : 'no')).map(([row, line]) => [row.name, line.site])

    return verdict(problems.length === 0 && wrong.length === 0 && pairs.some(([row]) => row.service), { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['harvesters', 'each harvester shows the same four separate figures and the permission of the tanker table, the one-module harvester that is no tanker among them and absent from the tanker table', (o, t) => {
    const harvesters = t.oracle.filter((row) => row.harvester)
    const { pairs, problems } = paired('the harvester table', o.harvesters, harvesters)
    const wrong = pairs.flatMap(([row, line]) => {
      const figure = (role) => {
        const entry = oneOf(line.figures.filter((candidate) => candidate.role === role))

        return entry ? litresOf(entry.text) : undefined
      }
      const permission = oneOf(line.permission.filter((entry) => entry.role === 'permission'))
      const surplusWanted = row.surplus === 'number' ? row.litres : row.surplus === 'zero' ? 0 : null
      const found = [figure('stored') === rounded(row.fuel) ? null : ['stored', figure('stored'), rounded(row.fuel)], figure('minimum') === rounded(row.minimum) ? null : ['minimum', figure('minimum'), rounded(row.minimum)], figure('reserve') === null ? null : ['reserve', figure('reserve'), 'no figure'], figure('surplus') === surplusWanted ? null : ['surplus', figure('surplus'), surplusWanted], permission && labelKey(permission.text, t.words.permissions) === row.permission ? null : ['permission', permission && permission.text, row.permission], oneOf(line.role) ? null : ['role', 'not drawn', 'drawn']].filter(Boolean)

      return found.map((entry) => [row.name, ...entry])
    })
    // A figure stands alone: the nearest visible character before and after its value, whatever elements wrap the text around it, is never a digit, a sign or a point that would run into the number. The label's own words are not judged.
    const joined = (character) => /[0-9+\u2212\-.,'\u2019\u00B1]/.test(character)
    const loose = pairs.flatMap(([row, line]) => line.figures.filter((entry) => entry.bounds === null || joined(entry.bounds.beforeNear) || joined(entry.bounds.afterNear)).map((entry) => [row.name, entry.role, entry.bounds]))
    const oneModule = harvesters.find((row) => row.permission === 'blocked' && row.reason === 'not-designated')
    const inTankers = linesOf(o.rows).some((line) => oneModule && line.ship === String(oneModule.id))

    return verdict(problems.length === 0 && wrong.length === 0 && loose.length === 0 && Boolean(oneModule) && !inTankers, { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4), loose: loose.slice(0, 3), oneModule: Boolean(oneModule), inTankers })
  }],
  ['sort', 'the Eligible surplus column sorts the tanker table by the surplus, lowest first and highest first, the tankers whose surplus is not known after every other in both directions', (o, t) => {
    const listed = t.oracle.filter((row) => row.listed)
    const byId = new Map(listed.map((row) => [String(row.id), row]))
    const keyOf = (row) => (row.permission === 'unknown' ? null : row.permission === 'blocked' ? 0 : row.litres)
    const read = (rows) => ({ problems: paired('the tanker table', rows, listed).problems, keys: linesOf(rows).map((line) => (byId.has(line.ship) ? keyOf(byId.get(line.ship)) : undefined)) })
    const ordered = (keys, sign) => {
      const unknown = keys.indexOf(null)
      const known = unknown === -1 ? keys : keys.slice(0, unknown)

      return (unknown === -1 ? [] : keys.slice(unknown)).every((key) => key === null) && known.every((key, index) => index === 0 || sign * (key - known[index - 1]) >= 0)
    }
    const ascending = read(o.sorts.ascending)
    const descending = read(o.sorts.descending)
    const kinds = new Set(ascending.keys.filter((key) => key !== null))

    return verdict(ascending.problems.length === 0 && descending.problems.length === 0 && kinds.size >= 3 && ascending.keys.includes(null) && ordered(ascending.keys, 1) && ordered(descending.keys, -1), { ascending: ascending.keys, descending: descending.keys, problems: [...ascending.problems, ...descending.problems].slice(0, 3) })
  }],
  ['reserves', 'a reserve kept for a ship class shows on every ship of the class and lowers the surplus each can give, a reserve of a ship itself holds over its class\'s even when it is 0, and a reserve cleared returns the ship to none set, each read from the tanker table and the list of records after every step', (o, t) => {
    const plan = t.reserves
    const listed = t.oracle.filter((row) => row.listed)
    const wrong = []
    const problems = []

    if (o.stages.length !== plan.stages.length) {
      return verdict(false, { stages: o.stages.length, wanted: plan.stages.length })
    }

    o.stages.forEach((stage, index) => {
      const state = plan.stages[index]
      const { pairs, problems: unpaired } = paired('the tanker table', stage.rows, listed)

      problems.push(...unpaired.map((problem) => [index, problem]))
      pairs.forEach(([row, line]) => {
        const { amount, source } = reserveFor(plan, state, row)
        const reserve = cell(line, 'reserve')
        const caption = cell(line, 'reserve-source')
        const named = caption !== null && caption.includes(plan.scenario) && (source === 'ship' ? /\bship\b/i.test(caption) && !/\bclass\b/i.test(caption) : /\bclass\b/i.test(caption))
        const surplus = surplusFor(row, amount)
        const found = [
          amount === null ? (reserve === t.words.noReserve ? null : ['reserve', reserve, t.words.noReserve]) : (litresOf(reserve) === amount ? null : ['reserve', reserve, amount]),
          litresOf(cell(line, 'surplus')) === surplus ? null : ['surplus', cell(line, 'surplus'), surplus],
          source === null ? (caption === null ? null : ['source', caption, 'none']) : (named ? null : ['source', caption, `${source}, ${plan.scenario}`]),
        ].filter(Boolean)

        wrong.push(...found.map((entry) => [index, row.name, ...entry]))
      })

      const eligible = oneOf(stage.values.filter((entry) => entry.role === 'eligible'))
      const wantedTotal = t.oracle.filter((row) => row.counted).reduce((sum, row) => sum + (surplusFor(row, reserveFor(plan, state, row).amount) || 0), 0)

      if (!eligible || litresOf(eligible.text) !== wantedTotal) {
        wrong.push([index, 'the eligible total', eligible && eligible.text, wantedTotal])
      }

      const wanted = [state.class === null ? null : { type: 'class', name: plan.className, amount: state.class }, state.ship === null ? null : { type: 'ship', name: plan.shipName, amount: state.ship }].filter(Boolean)
      const lines = stage.fuelRecords.lines.filter((line) => line.on).map((line) => {
        const type = oneOf(line.type)
        const name = oneOf(line.name)
        const amountText = oneOf(line.amount)

        return { type: type === null ? null : /\bclass\b/i.test(type.text) ? 'class' : 'ship', name: name && name.text, amount: amountText && litresOf(amountText.text), applied: line.applied }
      }).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      const expected = wanted.map((entry) => ({ ...entry, applied: 'yes' })).sort((a, b) => a.name.localeCompare(b.name))

      if (JSON.stringify(lines) !== JSON.stringify(expected)) {
        wrong.push([index, 'the records', lines, expected])
      }

      if ((oneOf(stage.fuelRecords.none) !== null) !== (wanted.length === 0)) {
        wrong.push([index, 'the empty note of the records', oneOf(stage.fuelRecords.none) !== null, wanted.length === 0])
      }
    })

    return verdict(problems.length === 0 && wrong.length === 0, { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4) })
  }],
  ['unread', 'while the reserve records are loading and while their read has failed, the surplus of a tanker that may serve, the eligible total and the reserve of tankers and harvesters read as not read and never as if no reserve existed, and the stored fuel, the class minimum and the permission stay', (o, t) => {
    const listed = t.oracle.filter((row) => row.listed)
    const harvesters = t.oracle.filter((row) => row.harvester)
    const stored = t.oracle.filter((row) => row.counted).reduce((sum, row) => sum + row.fuel, 0)
    const surplusRead = (row, text) => (row.surplus === 'number' ? text === t.words.notRead : row.surplus === 'zero' ? litresOf(text) === 0 : text !== t.words.notRead && litresOf(text) === null)
    const wrong = []
    const problems = []
    let tankers = 0
    let harvested = 0

    for (const how of ['loading', 'failed']) {
      const stage = (o.unread || {})[how] || { rows: [], values: [], harvesters: [] }
      const table = paired('the tanker table', stage.rows, listed)
      const crop = paired('the harvester table', stage.harvesters, harvesters)

      problems.push(...table.problems.map((problem) => [how, problem]), ...crop.problems.map((problem) => [how, problem]))
      table.pairs.forEach(([row, line]) => {
        const found = [
          ['reserve', cell(line, 'reserve'), cell(line, 'reserve') === t.words.notRead],
          ['place', cell(line, 'reserve-source'), cell(line, 'reserve-source') === null],
          ['surplus', cell(line, 'surplus'), surplusRead(row, cell(line, 'surplus'))],
          ['stored', cell(line, 'stored'), litresOf(cell(line, 'stored')) === rounded(row.fuel)],
          ['minimum', cell(line, 'minimum'), litresOf(cell(line, 'minimum')) === rounded(row.minimum)],
          ['permission', cell(line, 'permission'), labelKey(cell(line, 'permission'), t.words.permissions) === row.permission],
        ]

        tankers += row.surplus === 'number' ? 1 : 0
        wrong.push(...found.filter(([, , ok]) => !ok).map(([what, text]) => [how, 'tanker', row.name, what, text]))
      })
      crop.pairs.forEach(([row, line]) => {
        const text = (role) => {
          const entry = oneOf(line.figures.filter((candidate) => candidate.role === role))

          return entry ? entry.text : undefined
        }
        const permission = oneOf(line.permission.filter((entry) => entry.role === 'permission'))
        const found = [
          ['reserve', text('reserve'), text('reserve') === t.words.notRead],
          ['surplus', text('surplus'), surplusRead(row, text('surplus'))],
          ['stored', text('stored'), litresOf(text('stored')) === rounded(row.fuel)],
          ['minimum', text('minimum'), litresOf(text('minimum')) === rounded(row.minimum)],
          ['permission', permission && permission.text, Boolean(permission) && labelKey(permission.text, t.words.permissions) === row.permission],
        ]

        harvested += row.surplus === 'number' ? 1 : 0
        wrong.push(...found.filter(([, , ok]) => !ok).map(([what, shown]) => [how, 'harvester', row.name, what, shown]))
      })

      const eligible = oneOf(stage.values.filter((entry) => entry.role === 'eligible'))
      const total = oneOf(stage.values.filter((entry) => entry.role === 'stored'))

      if (!eligible || litresOf(eligible.text) !== null) {
        wrong.push([how, 'the eligible total', eligible && eligible.text, 'no figure'])
      }

      if (!total || litresOf(total.text) === null || Math.abs(litresOf(total.text) - stored) > 0.5) {
        wrong.push([how, 'the stored total', total && total.text, stored])
      }
    }

    return verdict(problems.length === 0 && wrong.length === 0 && tankers > 0 && harvested > 0, { problems: problems.slice(0, 3), wrong: wrong.slice(0, 4), tankers, harvested })
  }],
  ['no-errors', 'the page raises no error', (o) => verdict(o.unexpected.length === 0, o.unexpected.slice(0, 3))],
]

// ---------- the variants of the page ----------

/* eslint-disable no-template-curly-in-string */
const PAGE = PAGE_FILE
const FIGURES = FIGURES_FILE
const REPORT_CALL = 'return tankerReport(this.fuelDonors, { version: this.formulaVersion, reserveRead: Boolean(this.fuelReserves && this.fuelReserves.ready), reserveOf: (ship) => (this.reserveByShip.get(ship.ShipID) || { amount: null }).amount })'

// A planted fault or a rewrite changes one file of the page: `file` and `change` (the text of the file to the text served in its place).
const PAGE_FAULTS = [
  { name: 'the stored fuel cell draws the eligible surplus', file: PAGE, change: swap('data-donor-cell="stored">{{ donorText(item).stored }}', 'data-donor-cell="stored">{{ donorText(item).surplus }}'), fails: ['figures', 'inventory'] },
  { name: 'the class minimum cell draws the local reserve', file: PAGE, change: swap('data-donor-cell="minimum">{{ donorText(item).minimum }}', 'data-donor-cell="minimum">{{ donorText(item).reserve }}'), fails: ['figures'] },
  { name: 'the local reserve cell draws the class minimum', file: PAGE, change: swap('data-donor-cell="reserve">{{ donorText(item).reserve }}', 'data-donor-cell="reserve">{{ donorText(item).minimum }}'), fails: ['figures', 'reserves', 'unread'] },
  { name: 'the surplus of a ship that cannot serve is drawn as a figure of 0 litres', file: PAGE, change: swap('data-donor-cell="surplus">{{ donorText(item).surplus }}', 'data-donor-cell="surplus">{{ item.donor.eligibleSurplus === null ? donorText(item).surplus : exactLitres(item.donor.eligibleSurplus) }}'), fails: ['figures', 'reasons'] },
  { name: 'the reason of a ship that cannot serve is not drawn', file: PAGE, change: swap('<div v-if="donorText(item).reason" class="caption text--secondary" data-donor-cell="reason">', '<div v-if="false" class="caption text--secondary" data-donor-cell="reason">'), fails: ['reasons'] },
  { name: 'the table lists only the ships counted in the tanker stock', file: PAGE, change: swap('this.donorReport.rows.filter((row) => row.listed)', 'this.donorReport.rows.filter((row) => row.counted)'), fails: ['rows', 'figures', 'uncounted'] },
  { name: 'the stored total draws the eligible total', file: PAGE, change: swap('data-donor-value="stored">{{ exactLitres(donorReport.totals.stored.value) }}', 'data-donor-value="stored">{{ exactLitres(donorReport.totals.eligible) }}'), fails: ['totals'] },
  { name: 'the empty mark is never drawn', file: PAGE, change: swap('<div v-if="item.Fuel === 0" class="caption text--secondary" data-donor-cell="empty">', '<div v-if="false" class="caption text--secondary" data-donor-cell="empty">'), fails: ['empty'] },
  { name: 'a ship with no engines is not marked a service site', file: PAGE, change: swap(':data-service-site="item.site ? \'yes\' : \'no\'"', ':data-service-site="\'no\'"'), fails: ['sites'] },
  { name: 'the surplus cell is drawn at opacity 0', file: PAGE, change: swap('data-donor-cell="surplus">{{ donorText(item).surplus }}', 'style="opacity: 0" data-donor-cell="surplus">{{ donorText(item).surplus }}'), fails: ['figures'] },
  { name: 'the damage of the transfer systems is left out of the permission', file: PAGE, change: swap(REPORT_CALL, REPORT_CALL.replace('this.fuelDonors,', 'this.fuelDonors.map((ship) => ({ ...ship, UndamagedTransfer: ship.TransferSystems })),')), fails: ['permission', 'reasons'] },
  { name: 'the tanker table leaves out the empty tankers', file: PAGE, change: swap('this.donorReport.rows.filter((row) => row.listed)', 'this.donorReport.rows.filter((row) => row.listed && row.Fuel > 0)'), fails: ['rows', 'empty'] },
  { name: 'the harvesters carry no role', file: PAGE, change: swap('fuelRole: this.donorByShip.has(row.ShipID) ? this.donorByShip.get(row.ShipID).role : null,', 'fuelRole: null,'), fails: ['harvesters'] },
  { name: 'the harvesters carry no fuel service', file: PAGE, change: swap('fuelDonor: this.donorByShip.has(row.ShipID) ? this.donorByShip.get(row.ShipID).donor : null,', 'fuelDonor: null,'), fails: ['harvesters'] },
  { name: 'the four figures of a harvester draw the class minimum as the surplus', file: FIGURES, change: swap('text: this.texts[figure.key]', 'text: this.texts[figure.key === \'surplus\' ? \'minimum\' : figure.key]'), fails: ['harvesters'] },
  { name: 'the chip counts the ships listed and not the ships in the stock', file: PAGE, change: swap('<span data-donor-value="ships">{{ donorReport.totals.ships }}</span>', '<span data-donor-value="ships">{{ tankerRows.length }}</span>'), fails: ['totals'] },
  { name: 'the stored total is drawn with a minus sign', file: PAGE, change: swap('data-donor-value="stored">{{ exactLitres(donorReport.totals.stored.value) }}', 'data-donor-value="stored">\u2212{{ exactLitres(donorReport.totals.stored.value) }}'), fails: ['totals'] },
  { name: 'the count of the chip is drawn with a minus sign', file: PAGE, change: swap('<span data-donor-value="ships">{{ donorReport.totals.ships }}</span>', '<span data-donor-value="ships">\u2212{{ donorReport.totals.ships }}</span>'), fails: ['totals'] },
  { name: 'the count of the ships that cannot serve is drawn with a stray letter before it', file: PAGE, change: swap('<span data-donor-value="blocked">{{ donorReport.totals.permissions.blocked }}</span>', '<span data-donor-value="blocked">x{{ donorReport.totals.permissions.blocked }}</span>'), fails: ['totals'] },
  { name: 'the stored total is drawn with a minus sign just outside its figure', file: PAGE, change: swap('Stored fuel <span data-donor-value="stored">', 'Stored fuel \u2212<span data-donor-value="stored">'), fails: ['totals'] },
  { name: 'the count of the empty tankers is drawn with a minus sign just outside its figure', file: PAGE, change: swap('<span data-donor-total="empty"> · <span data-donor-value="empty">', '<span data-donor-total="empty"> · \u2212<span data-donor-value="empty">'), fails: ['totals'] },
  { name: 'the count of the chip is drawn with a digit just outside its figure', file: PAGE, change: swap('data-donor-chip><span data-donor-value="ships">', 'data-donor-chip>1<span data-donor-value="ships">'), fails: ['totals'] },
  { name: 'the count of the ships that cannot serve has a stray letter just outside its figure', file: PAGE, change: swap('<span data-donor-value="blocked">', 'x<span data-donor-value="blocked">'), fails: ['totals'] },
  { name: 'a figure of a harvester is drawn with a minus sign just outside its element', file: FIGURES, change: swap('<span class="text-no-wrap" data-fuel-value>', '\u2212<span class="text-no-wrap" data-fuel-value>'), fails: ['harvesters'] },
  { name: 'a figure of a harvester is drawn with a minus sign in an element of its own just before its value', file: FIGURES, change: swap('<span class="text-no-wrap" data-fuel-value>', '<span>\u2212</span><span class="text-no-wrap" data-fuel-value>'), fails: ['harvesters'] },
  { name: 'a figure of a harvester is drawn with a digit in an element of its own just after its value', file: FIGURES, change: swap('{{ figure.text }}</span>', '{{ figure.text }}</span><span>7</span>'), fails: ['harvesters'] },
  { name: 'the tanker table draws another ship\'s name', file: PAGE, change: swap('data-donor-cell="name">{{ item.ShipName }}', 'data-donor-cell="name">Wrong ship'), fails: ['names'] },
  { name: 'the harvester table draws another ship\'s name', file: PAGE, change: swap('data-harvester-name>{{ item.ShipName }}', 'data-harvester-name>Wrong ship'), fails: ['names'] },
  { name: 'the role of a tanker leaves out the service site while the hook keeps it', file: PAGE, change: swap('data-donor-cell="role">{{ item.role }}', 'data-donor-cell="role">{{ item.role.replace(\', service site\', \'\') }}'), fails: ['roles'] },
  { name: 'the role of a harvester leaves out the harvesting', file: PAGE, change: swap('data-harvester-role>{{ item.fuelRole }}', 'data-harvester-role>{{ item.fuelRole.replace(\' and Harvester\', \'\') }}'), fails: ['roles'] },
  { name: 'the page\'s loader leaves out the harvesters of a class with no tanks', file: MODULE_FILE, change: swap('FCT_Ship.ShippingLineID = 0 and (${ofClass(\'FuelTanker\')}', 'FCT_Ship.ShippingLineID = 0 and ${ofClass(\'FuelCapacity\')} > 0 and (${ofClass(\'FuelTanker\')}'), fails: ['harvesters', 'roles'] },
  { name: 'the surplus column sorts by a nested key the comparator never resolves', file: PAGE, change: (text) => swap('<template #[`item.eligibleSurplus`]', '<template #[`item.donor.eligibleSurplus`]')(swap('value: \'eligibleSurplus\', align: \'end\' }', 'value: \'donor.eligibleSurplus\', align: \'end\' }')(text)), fails: ['sort'] },
  { name: 'the sort value of the surplus reads an unknown surplus as 0', file: MODULE_FILE, change: swap('eligibleSurplus: donor.eligibleSurplus, role', 'eligibleSurplus: donor.eligibleSurplus === null ? 0 : donor.eligibleSurplus, role'), fails: ['sort'] },
  { name: 'the sort value of the surplus is the fuel aboard', file: MODULE_FILE, change: swap('eligibleSurplus: donor.eligibleSurplus, role', 'eligibleSurplus: ship.Fuel, role'), fails: ['sort'] },
  { name: 'the reserve of a ship is left out of the reserves the page draws', file: PAGE, change: swap('table ? fuelReserveOf(table, ship) : null', 'table ? fuelReserveOf({ ship: new Map(), class: table.class }, ship) : null'), fails: ['reserves'] },
  { name: 'the reserve of a class never reaches its ships', file: PAGE, change: swap('table ? fuelReserveOf(table, ship) : null', 'table ? fuelReserveOf({ ship: table.ship, class: new Map() }, ship) : null'), fails: ['reserves'] },
  { name: 'a reserve of 0 litres is read as none set', file: PAGE, change: swap('reserveOf: (ship) => (this.reserveByShip.get(ship.ShipID) || { amount: null }).amount', 'reserveOf: (ship) => (this.reserveByShip.get(ship.ShipID) || { amount: null }).amount || null'), fails: ['reserves'] },
  { name: 'the reserve of a class is said to be set on the ship', file: PAGE, change: swap('reserve.source === \'ship\' ? \'ship\' : \'class\'', '\'ship\''), fails: ['reserves'] },
  { name: 'the place of a reserve is not drawn', file: PAGE, change: swap('<div v-if="reserveSourceText(item)"', '<div v-if="false"'), fails: ['reserves'] },
  { name: 'a reserve cleared is not removed', file: RESERVES_FILE, change: swap('const outcome = await deleteReserve(this.repository, this.scope, entry)', 'const outcome = { ok: true }'), fails: ['reserves'] },
  { name: 'a reserve is kept one litre over what was entered', file: RESERVES_FILE, change: swap('reserves: { [FUEL_RESOURCE]: fuel }', 'reserves: { [FUEL_RESOURCE]: fuel + 1 }'), fails: ['reserves'] },
  { name: 'a record of a class is listed as a ship', file: RESERVES_FILE, change: swap('data-fuel-record-type>{{ typeWords[entry.source.type] }}</v-chip>', 'data-fuel-record-type>{{ typeWords.ship }}</v-chip>'), fails: ['reserves'] },
  { name: 'the note that no reserve is kept is never drawn', file: RESERVES_FILE, change: swap('<div v-if="!entries.length" class="caption text--secondary" data-fuel-no-records>', '<div v-if="false" class="caption text--secondary" data-fuel-no-records>'), fails: ['reserves'] },
  { name: 'the reserve of a ship is not given to the donor result', file: MODULE_FILE, change: swap('fuelDonor(ship, { playerReserve: reserveOf(ship), reserveRead, version })', 'fuelDonor(ship, { reserveRead, version })'), fails: ['reserves'] },
  { name: 'the surplus above the floors leaves out the reserve', file: MODULE_FILE, change: swap('Math.max(minimum, reserve === null ? 0 : reserve)', 'minimum'), fails: ['reserves'] },
  { name: 'the page makes its tanker report whether or not the reserve records are read', file: PAGE, change: swap('reserveRead: Boolean(this.fuelReserves && this.fuelReserves.ready), ', ''), fails: ['unread'] },
  { name: 'a failed read of the reserve records is taken for a finished one', file: PAGE, change: swap('reserveRead: Boolean(this.fuelReserves && this.fuelReserves.ready)', 'reserveRead: Boolean(this.fuelReserves)'), fails: ['unread'] },
  { name: 'records the panel has not yet reported are taken for read ones', file: PAGE, change: swap('reserveRead: Boolean(this.fuelReserves && this.fuelReserves.ready)', 'reserveRead: !this.fuelReserves || this.fuelReserves.ready'), fails: ['unread'] },
  { name: 'the tanker report is not told whether the reserve records are read', file: MODULE_FILE, change: swap('reserveOf(ship), reserveRead, version', 'reserveOf(ship), version'), fails: ['unread'] },
  { name: 'the eligible total counts the ships whose reserve is not read', file: MODULE_FILE, change: swap('known.length && reserveRead !== false ?', 'known.length ?'), fails: ['unread'] },
  { name: 'the reserve of a ship is worded as none set while the records are not read', file: MODULE_FILE, change: swap('donor.reserveRead === false ? NOT_READ_TEXT : donor.playerReserve === null', 'donor.playerReserve === null'), fails: ['unread'] },
  { name: 'the surplus of a ship is worded as 0 litres while its reserve is not read', file: MODULE_FILE, change: swap('donor.eligibleSurplus === null ? NOT_READ_TEXT : litres(donor.eligibleSurplus)', 'litres(donor.eligibleSurplus === null ? 0 : donor.eligibleSurplus)'), fails: ['unread'] },
]

const PAGE_BENIGN = [
  { name: 'the retry listened to by the longhand of the event', file: PAGE, change: swap('@retry="retryDonors"', 'v-on:retry="retryDonors"') },
  { name: 'the sort of the tanker table bound by an explicit value and event', file: PAGE, change: swap(':sort-by.sync="tankersTable.sortBy"', ':sort-by="tankersTable.sortBy" @update:sort-by="tankersTable.sortBy = $event"') },
  { name: 'the eligible total written as a suffix to its label', file: PAGE, change: swap('Eligible surplus <span data-donor-value="eligible">{{ exactLitres(donorReport.totals.eligible) }}</span><template', '<span data-donor-value="eligible">{{ exactLitres(donorReport.totals.eligible) }}</span> eligible surplus<template') },
  { name: 'the class of a ship that is outside the tanker stock written in other words', file: PAGE, change: swap('data-donor-cell="uncounted">not in the tanker stock', 'data-donor-cell="uncounted">outside the tanker stock') },
  { name: 'the colour class of the permission parenthesised', file: PAGE, change: swap(':class="item.donor.permission === \'allowed\' ? \'\' : \'text--secondary\'"', ':class="(item.donor.permission === \'allowed\') ? \'\' : \'text--secondary\'"') },
  { name: 'the harvester figures drawn through the longhand of the prop', file: PAGE, change: swap('<fuel-figures v-if="item.fuelDonor" :donor="item.fuelDonor" />', '<fuel-figures v-if="item.fuelDonor" v-bind:donor="item.fuelDonor" />') },
  { name: 'the label of the eligible total hyphenated', file: PAGE, change: swap('Eligible surplus <span data-donor-value="eligible">', 'Service-eligible surplus <span data-donor-value="eligible">') },
  { name: 'a hidden element beside the stored total', file: PAGE, change: swap('Stored fuel <span data-donor-value="stored">{{ exactLitres(donorReport.totals.stored.value) }}</span>', 'Stored fuel <span style="display: none">7</span><span data-donor-value="stored">{{ exactLitres(donorReport.totals.stored.value) }}</span><span style="display: none">7</span>') },
  { name: 'the service site of a tanker named before its kinds', file: PAGE, change: swap('data-donor-cell="role">{{ item.role }}', 'data-donor-cell="role">{{ item.role.endsWith(\', service site\') ? `service site, ${item.role.slice(0, -14)}` : item.role }}') },
  { name: 'the kinds of a harvester in the other order, joined by a plus', file: PAGE, change: swap('data-harvester-role>{{ item.fuelRole }}', 'data-harvester-role>{{ item.fuelRole.split(\' and \').reverse().join(\' + \') }}') },
  { name: 'the label of a harvester figure written without its element', file: FIGURES, change: swap('<span class="text--secondary">{{ figure.label }}</span>', '{{ figure.label }}') },
  { name: 'a hidden sign beside the value of a harvester figure', file: FIGURES, change: swap('<span class="text-no-wrap" data-fuel-value>{{ figure.text }}</span>', '<span style="display: none">\u2212</span><span class="text-no-wrap" data-fuel-value>{{ figure.text }}</span><span style="display: none">7</span>') },
  { name: 'the reserve record bound by an explicit value and event', file: RESERVES_FILE, change: swap('v-model="draft.fuel"', ':value="draft.fuel" @input="draft.fuel = $event"') },
  { name: 'the reserves of the panel listened to by the longhand of the event', file: PAGE, change: swap('@reserves="fuelReserves = $event"', 'v-on:reserves="fuelReserves = $event"') },
  { name: 'the type of a record written after its name', file: RESERVES_FILE, change: swap('<v-chip x-small outlined class="mr-1" data-fuel-record-type>{{ typeWords[entry.source.type] }}</v-chip>\n          <span class="font-weight-medium" data-fuel-record-name>{{ entry.source.name }}</span>', '<span class="font-weight-medium" data-fuel-record-name>{{ entry.source.name }}</span>\n          <v-chip x-small outlined class="mr-1" data-fuel-record-type>{{ typeWords[entry.source.type] }}</v-chip>') },
  { name: 'the note that no reserve is kept put another way', file: RESERVES_FILE, change: swap('No reserve is kept for a ship or a ship class yet.', 'Nothing is kept for any ship or ship class yet.') },
  { name: 'the condition of the place of a reserve parenthesised', file: PAGE, change: swap('<div v-if="reserveSourceText(item)"', '<div v-if="(reserveSourceText(item))"') },
  { name: 'the test that the reserve records are read spelled out', file: PAGE, change: swap('reserveRead: Boolean(this.fuelReserves && this.fuelReserves.ready)', 'reserveRead: this.fuelReserves !== null && this.fuelReserves.ready === true') },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the run ----------

// The reserves the page is driven through, from the planted ship of a fraction of a litre above its minimum and the class it is of: a reserve for the class (and then another figure), a reserve of 0 for the ship itself, then each cleared. `stages` is what each step leaves: the reserve of the class and of the ship, null for none.
const reservePlan = (copy) => {
  const id = Number(Object.keys(copy.kinds).find((key) => copy.kinds[key] === 'fraction'))
  const row = copy.ships.find((ship) => ship.id === id)
  const first = row.minimum + 200
  const second = row.minimum + 100

  return { shipId: row.id, shipName: row.name, classId: row.classId, className: row.className, scenario: 'Convoy', first, second, override: 0, stages: [{ class: null, ship: null }, { class: first, ship: null }, { class: second, ship: null }, { class: second, ship: 0 }, { class: second, ship: null }, { class: null, ship: null }] }
}

let ENV = null
const cleanups = []

// A worker's setup for the page: a copy of the save with the planted ships, the oracle of what each shows, the module's own tables of words, one page server over the copy, warmed, and one Chromium.
const setUp = async () => {
  const { startPageServer } = require('./lib/page-server')
  const copy = await saveCopy()

  cleanups.push(async () => fs.rmSync(copy.folder, { recursive: true, force: true }))

  const { [MODULE]: donors } = await loadUtilities([MODULE])
  const env = { texts: new Map(), originals: { [PAGE_FILE]: fs.readFileSync(path.join(root, PAGE_FILE), 'utf8'), [FIGURES_FILE]: fs.readFileSync(path.join(root, FIGURES_FILE), 'utf8'), [MODULE_FILE]: fs.readFileSync(path.join(root, MODULE_FILE), 'utf8'), [RESERVES_FILE]: fs.readFileSync(path.join(root, RESERVES_FILE), 'utf8') }, truth: { oracle: oracleOf(copy), reserves: reservePlan(copy), words: { permissions: { ...donors.PERMISSION_TEXT }, reasons: { ...donors.REASONS }, roles: { ...donors.ROLE_TEXT }, noReserve: donors.donorTexts(donors.fuelDonor(ship()), (value) => String(value)).reserve } }, baseline: null }

  env.truth.words.notRead = donors.NOT_READ_TEXT

  env.server = await startPageServer({ save: copy.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/logistics'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// The page with `variant` (a { file, change }, null for the page as it is) served and read as a player sees it.
const view = async (variant) => {
  if (variant) {
    ENV.server.replace(variant.file, variant.change(ENV.originals[variant.file]))
  }

  try {
    const seen = await observePage(ENV.chrome, ENV.server.url)

    if (seen.error !== null) {
      console.error(`the page${variant ? ` with "${variant.name}"` : ''} did not get through: ${seen.error}`)
    }

    return seen
  } finally {
    if (variant) {
      ENV.server.replace(variant.file, null)
    }
  }
}

// The results of the checks over the record of an observation: { id, name, ok, kind, threw, detail }. A record with no screen to judge stops the run for a fault or a rewrite, and fails every check of the baseline naming where it stopped.
const pageResults = async (seen, { strict, ids = null, label }) => {
  validate(seen, label)

  const chosen = CHECKS.filter(([id]) => !ids || ids.includes(id))

  if (unobserved(seen)) {
    if (strict) {
      throw new HarnessError(`${label} did not get through: ${seen.error}`)
    }

    return chosen.map(([id, name]) => ({ id, name, ok: false, kind: 'unobserved', threw: false, detail: String(seen.error) }))
  }

  const o = { ...seen.value, unexpected: seen.unexpected }

  const judge = (test) => () => {
    const result = test(o, ENV.truth)

    if (result !== true) {
      assert.fail(result)
    }
  }

  return await runChecks(chosen.map(([id, name, test]) => ({ id, name, run: judge(test) })))
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

const reportFault = (fault, results) => {
  report(`fault caught: ${fault.name}`, caughtAll(results, { name: fault.name }), notCaught(results))

  if (DETAIL) {
    results.forEach((result) => console.log(`         ${result.id}: ${result.ok ? 'holds' : result.detail}`))
  }
}

const reportRewrite = (rewrite, results) => {
  const wrong = results.filter((result) => !result.ok).map((result) => `${result.id}: ${result.detail}`)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0, wrong.join('; '))
}

const checkPageHead = async () => {
  const seen = await view(null)
  const results = await pageResults(seen, { strict: false, label: 'the page' })

  judged(results, 'the page')
  results.forEach((result) => report(result.name, result.ok, result.detail))
}

const checkPageFault = async (fault) => {
  const results = await pageResults(await view(fault), { strict: true, ids: fault.fails, label: `the page with the fault "${fault.name}"` })

  judged(results, fault.name)
  reportFault(fault, results)
}

// A rewrite must pass every check, and so draw what the page as it is draws: the screen read by the worker's setup before the first variant, whichever that is.
const checkPageRewrite = async (rewrite) => {
  const seen = await view(rewrite)
  const results = await pageResults(seen, { strict: true, label: `the page rewritten as "${rewrite.name}"` })

  judged(results, rewrite.name)
  reportRewrite(rewrite, results)
}

// The pure checks over the module as it is, or with `change` made to its source.
const pureResults = async (change, ids) => {
  const sources = change ? { [MODULE]: change(fs.readFileSync(path.join(root, MODULE_FILE), 'utf8')) } : {}
  const loaded = await loadUtilities([MODULE], { sources })
  const mod = subjectModule(loaded[MODULE], 'module')

  return await runChecks(PURE_CHECKS.filter(({ id }) => !ids || ids.includes(id)), { mod })
}

const checkPureHead = async () => {
  const results = await pureResults(null)

  judged(results, 'the module')
  results.forEach((result) => report(result.name, result.ok, result.detail))
}

const checkPureFault = async (fault) => {
  const results = await pureResults(fault.change, fault.fails)

  judged(results, fault.name)
  reportFault(fault, results)
}

const checkPureRewrite = async (rewrite) => {
  const results = await pureResults(rewrite.change)

  judged(results, rewrite.name)
  reportRewrite(rewrite, results)
}

// The deadlines, in seconds: the setup starts and warms the page server once (900 s), a page variant reads the page once (180 s), a pure variant loads one module and runs the cases (120 s).
const DEADLINES = { page: 180, pure: 120, setup: 900 + 180 }
const CONTROL_FAULT = 'the stored fuel cell draws the eligible surplus'

const variantsOf = (mutating) => [
  { key: 'pure', name: 'the head: the donor result, the tanker report and the loader of the module as they are', head: true, heading: 'The donor side of the fuel service (utilities/fuel-donors.js)', deadline: DEADLINES.pure, run: checkPureHead },
  ...(mutating ? PURE_FAULTS.map((fault, index) => ({ key: `pure-fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the module', deadline: DEADLINES.pure, run: () => checkPureFault(fault) })) : []),
  ...(mutating ? PURE_BENIGN.map((rewrite, index) => ({ key: `pure-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the module that say the same thing', deadline: DEADLINES.pure, run: () => checkPureRewrite(rewrite) })) : []),
  { key: 'page', name: 'the head: the Logistics page as it is', head: true, heading: '\nThe tankers and the fuel service of the harvesters on the Logistics page (scripts/lib/page-server.js over a copy of a save)', pool: 'suite', deadline: DEADLINES.page, run: checkPageHead },
  ...(mutating ? PAGE_FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the page', pool: 'suite', deadline: DEADLINES.page, run: () => checkPageFault(fault) })) : []),
  ...(mutating ? PAGE_BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the page that say the same thing', pool: 'suite', deadline: DEADLINES.page, run: () => checkPageRewrite(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.pool === 'suite')) {
        ENV = await setUp()
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
    control: mutating ? { fault: `fault:${PAGE_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'page', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
