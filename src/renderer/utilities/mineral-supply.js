// The Mineral Outlook's supply accounting: what the mines of each site extract, what can leave the site by mass driver, what the ledger shows shipped and received, and what packets are on their way to each destination, kept as separate figures. A mineral dug up at a site goes into that colony's own stockpile; it supplies industry elsewhere only through a mass-driver packet (or a freighter's load, which the save shows only as ledger shipments), and the race's totals take none of those moves as income. Hypothetical deliveries are scenario inputs, never assumed. Evidence: docs/plans/backlog/evidence/AE-054-01.md.

import { TARGET_STATES, driversByColony, targetOf } from './cmc-policy'
import { stockAndInbound } from './colony-minerals'
import { MINERALS, massDriverRateResult } from './minerals'
import { miningSum, orbitalRateResult, surfaceRateResult } from './mineral-outlook'
import { combine, isAvailable, ofRule, registerRule, sumResults, unavailable, valueOrNull } from './provenance'

const SUPPLY_VERSIONS = ['2.7.x']

registerRule({
  id: 'mineralSupply.route',
  versions: SUPPLY_VERSIONS,
  units: 'route',
  verification: 'estimated',
  structure: ['FCT_Population.MassDriverDest, PurchaseCivilianMinerals', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue'],
  note: 'Whether anything a site digs up can leave it by packet. A race that buys the output of a colony\'s civilian complexes sends it straight into a packet bound for the colony\'s mass driver destination; stock above the reserve goes by the colony\'s own drivers. A destination that is stored and still exists keeps the route whoever owns it, wherever it is and whether or not it has a driver: the destination picker offers fewer colonies than a stored destination may be, and only the site\'s drivers set what its stock can send. A packet adds its minerals to the destination\'s stock on arrival, driver or none; a packet bound for a destination that no longer exists is lost. A site with no destination sends nothing by packet; a site with a destination but no driver sends only the civilian output the race buys. A freighter\'s hold is not a packet route: what freighters load shows only as ledger shipments. A packet carries no origin in the save, so an arrival is never assigned to a site.',
})

registerRule({
  id: 'mineralSupply.packetOutput',
  versions: SUPPLY_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_Population.PurchaseCivilianMinerals, MassDriverDest', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue', 'FCT_MineralDeposit.Accessibility'],
  note: 'What the civilian complexes of a colony whose output the race buys dig up a year, which goes into a packet of its own and not into the colony\'s stockpile: the complexes\' share of the colony\'s mining rate. A colony that taxes its complexes, or has no destination, sends no output this way. The rate is today\'s; accessibility falls as a deposit is worked past half.',
})

registerRule({
  id: 'mineralSupply.localStock',
  versions: SUPPLY_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['the site\'s mining rates', 'FCT_Population.PurchaseCivilianMinerals, MassDriverDest'],
  note: 'What the site\'s own mines and orbital miners add a year to the site\'s own stockpile: the extraction less the civilian output that goes straight into a packet. Industry elsewhere does not see it until a driver or a freighter moves it, so extraction at a site is never supply at another colony.',
})

registerRule({
  id: 'mineralSupply.supply',
  versions: SUPPLY_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['the site\'s route', 'FCT_RaceMineralData.Amount, MineralDataType 12'],
  note: 'What leaves the site for a destination colony by a route the save names: 0 where there is no packet route, the civilian output where it ships by packet, and, where the site\'s drivers ship stock, the tonnes the ledger shows them sending over its window. Drivers ship stock above the reserve up to their capacity, so without the ledger that throughput is not known. Freighter loads are not counted: where they go is not recorded.',
})

registerRule({
  id: 'mineralSupply.shipped',
  versions: SUPPLY_VERSIONS,
  units: 't/yr',
  verification: 'confirmed',
  structure: ['FCT_RaceMineralData.Amount, MineralDataType 8, 12, PopulationID, MineralID'],
  note: 'The tonnes the game\'s ledger records a colony sending by mass driver or loading into freighters over its window, annualised: stored values, summed. The ledger records a packet when drivers send stock, not when civilian output goes straight into a packet, and a tonne loaded into a freighter is not a tonne delivered.',
})

registerRule({
  id: 'mineralSupply.received',
  versions: SUPPLY_VERSIONS,
  units: 't/yr',
  verification: 'confirmed',
  structure: ['FCT_RaceMineralData.Amount, MineralDataType 7, 13, PopulationID, MineralID'],
  note: 'The tonnes the game\'s ledger records a colony receiving from mass-driver packets or unloading from freighters over its window, annualised: stored values, summed. A receipt moves minerals between the race\'s own colonies; it is not income to the race.',
})

registerRule({
  id: 'mineralSupply.afterArrival',
  versions: SUPPLY_VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_Population.<mineral>', 'FCT_MassDriverPackets.<mineral>, DestID'],
  note: 'What a colony holds once the packets bound for it have landed: its stock plus what is in flight to it, arithmetic on stored values. A packet in flight is in no colony\'s stock, so it is not available to industry until it arrives; each packet counts for exactly one destination.',
})

registerRule({
  id: 'mineralSupply.cargo',
  versions: SUPPLY_VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_ShipCargo.Amount, CargoTypeID 3, CargoID'],
  note: 'The tonnes of a mineral in the holds of the race\'s ships: stored values, summed. A freighter\'s destination is not recorded, so the cargo supplies no colony until the ledger shows it unloaded; it is still the race\'s own mineral, counted in what the race holds so a haul between colonies changes no total.',
})

registerRule({
  id: 'mineralSupply.scenario',
  versions: SUPPLY_VERSIONS,
  units: 't/yr',
  verification: 'assumed',
  structure: ['a delivery entered on the page'],
  note: 'A hypothetical delivery from a site to a colony, entered on the page. No route, order or packet of the save backs it, and nothing is counted from it until it is entered.',
  assumptions: ['the delivery is a hypothetical input, not a route or a packet the save holds'],
})

// The ledger's entry types of the moves between the race's own colonies.
export const LEDGER_TYPES = Object.freeze({ unloaded: 7, loaded: 8, sent: 12, received: 13 })
const TRANSFER_LIST = Object.values(LEDGER_TYPES)

const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

// Whether a colony has a mass driver: true or false, null when a driver installation's amount or value is not recorded.
const hasDriver = (drivers, gaps) => (known(drivers) && !(gaps > 0) ? Math.floor(drivers + 1e-9) >= 1 : null)

// The minerals aboard ships: `cargo` is the page's read by material id, null for a material whose hold amount is not recorded; a material with no key has none aboard (0), and no read at all is unknown.
const cargoResult = (cargo, materialId) => {
  if (!cargo) {
    return unavailable({ rule: 'mineralSupply.cargo', missing: ['the amount held in the ship cargo holds'] })
  }

  if (!Object.prototype.hasOwnProperty.call(cargo, materialId)) {
    return ofRule({ rule: 'mineralSupply.cargo', value: 0, inputs: { present: ['FCT_ShipCargo'] } })
  }

  return known(cargo[materialId]) ? ofRule({ rule: 'mineralSupply.cargo', value: cargo[materialId], inputs: { present: ['FCT_ShipCargo.Amount'] } }) : unavailable({ rule: 'mineralSupply.cargo', missing: ['the amount held in the ship cargo holds'] })
}

// The results of one mineral at one colony row: its stock and what is in flight to it.
const resultsAt = (colony, packets, materialId) => stockAndInbound(colony, packets, MINERALS.find((item) => item.id === materialId))

const driverText = (where) => `the number of mass drivers or their driver value at ${where}`
const POLICY_COLUMN = 'the colony\'s civilian mineral purchase setting'

// Whether a colony's stored destination is one a packet reaches: true when it names a colony that exists and is not the colony itself, false when it names none, a colony that is gone or the colony itself (a packet to itself lands in its own stock), null when the field is not stored. Owner, system and drivers at the destination are never asked: the destination picker offers fewer colonies than a stored destination may be.
const reachOf = (colony) => {
  const destination = colony.MassDriverDest

  if (!Number.isInteger(destination)) {
    return null
  }

  return destination > 0 && colony.DestinationID !== null && colony.DestinationID !== undefined && destination !== colony.PopulationID
}

// One row per colony of the race: its name, system, destination (and the destination's name, race and system), its drivers and its stock of every mineral.
export const loadSiteRoutes = async (database, { GameID, RaceID }) => {
  const stocks = MINERALS.map((mineral) => `FCT_Population.${mineral.name}`).join(', ')
  const [rows] = await database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.MassDriverDest, ${stocks}, coalesce(VIR_Drivers.Drivers, 0) as Drivers, coalesce(VIR_Drivers.Gaps, 0) as DriverGaps, VIR_Destination.PopulationID as DestinationID, VIR_Destination.PopName as DestinationName, VIR_Destination.RaceID as DestinationRaceID, VIR_Destination.SystemID as DestinationSystemID from FCT_Population left join (${driversByColony(GameID)}) as VIR_Drivers on VIR_Drivers.PopID = FCT_Population.PopulationID left join FCT_Population as VIR_Destination on VIR_Destination.PopulationID = FCT_Population.MassDriverDest and VIR_Destination.GameID = FCT_Population.GameID and FCT_Population.MassDriverDest > 0 where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`)

  return Object.freeze(rows)
}

// The ledger's moves between colonies over the last `windowDays`, one row per colony, mineral and entry type: { PopulationID, MaterialID, MineralDataType, Amount }, with Amount null when any term of the sum is not recorded. A ledger with no entry in the window gives none.
export const loadTransfers = async (database, { GameID, RaceID, windowDays }) => {
  const [rows] = await database.query(`select FCT_RaceMineralData.PopulationID, FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, case when count(FCT_RaceMineralData.Amount) = count(*) then sum(FCT_RaceMineralData.Amount) end as Amount from FCT_RaceMineralData inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID where FCT_RaceMineralData.GameID = ${GameID} and FCT_RaceMineralData.RaceID = ${RaceID} and FCT_RaceMineralData.MineralDataType in (${TRANSFER_LIST.join(', ')}) and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${windowDays * 86400} group by FCT_RaceMineralData.PopulationID, FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType`)

  return Object.freeze(rows)
}

// The moves of `loadTransfers` as the figures read them: `{ table: { [PopulationID]: { [MaterialID]: { [type]: Amount } } }, perYear }`. `perYear` is the factor from the window's tonnes to t/yr (365 over the days the ledger covers), null when the ledger covers no days: every observed figure is then unknown, not 0.
export const transferFlows = (rows, perYear) => {
  const table = {}

  rows.forEach((row) => {
    const colony = (table[row.PopulationID] = table[row.PopulationID] || {})
    const mineral = (colony[row.MaterialID] = colony[row.MaterialID] || {})

    mineral[row.MineralDataType] = Number.isFinite(row.Amount) ? row.Amount : null
  })

  return { table, perYear: known(perYear) && perYear > 0 ? perYear : null }
}

// The tonnes a year of the entry `types` at one colony and mineral, as a result of `rule`: a colony and mineral with no entry of a type moved none of it (0); an entry with no amount, or a ledger that covers no days, is unknown.
const observed = (rule, flows, populationId, materialId, types) => {
  if (!flows || flows.perYear === null) {
    return unavailable({ rule, missing: ['the mineral ledger over the window'] })
  }

  const entry = ((flows.table[populationId] || {})[materialId]) || {}
  const amounts = types.map((type) => (type in entry ? entry[type] : 0))

  if (amounts.includes(null)) {
    return unavailable({ rule, missing: ['the amount the race\'s minerals data records'] })
  }

  return ofRule({ rule, value: amounts.reduce((total, amount) => total + amount, 0) * flows.perYear, inputs: { present: ['FCT_RaceMineralData'] } })
}

const sentOf = (flows, populationId, materialId) => observed('mineralSupply.shipped', flows, populationId, materialId, [LEDGER_TYPES.sent])
const loadedOf = (flows, populationId, materialId) => observed('mineralSupply.shipped', flows, populationId, materialId, [LEDGER_TYPES.loaded])
const receivedOf = (flows, populationId, materialId) => observed('mineralSupply.received', flows, populationId, materialId, [LEDGER_TYPES.received])
const unloadedOf = (flows, populationId, materialId) => observed('mineralSupply.received', flows, populationId, materialId, [LEDGER_TYPES.unloaded])

// How a site's packet route reads, as a result of 'mineralSupply.route' whose value is `{ state, civilian, stock, target, destinationId }`. A stored destination keeps the route while its colony exists, whoever owns it, wherever it is and whether or not it has a driver: only the picker offers fewer, so only the source's drivers decide whether stock ships. `civilian`: the race buys the complexes' output for a destination (the mining rows' `MassDriverExport`); `stock`: 'ships' when the site's drivers send stock above the reserve, 'none' when they cannot, 'unknown' when what decides it is not recorded; `target`: `targetOf`'s verdict on the destination, for display. `state` is 'packets' (civilian output goes by packet), 'driver' (stock goes by the drivers), or 'none' (nothing leaves by packet, whatever the destination field says). A site whose route cannot be told is unavailable. `colony` is the site's row of `loadSiteRoutes`, undefined when it has none.
export const routeResult = ({ colony, civilian, RaceID }) => {
  const target = colony ? targetOf(colony, RaceID) : null
  const reach = colony ? reachOf(colony) : null
  let stock = 'unknown'
  let missing = []

  if (colony) {
    const source = hasDriver(colony.Drivers, colony.DriverGaps)

    if (reach === null) {
      missing = ['the colony\'s mass driver destination']
    } else if (reach === false || source === false) {
      stock = 'none'
    } else if (source === null) {
      missing = [driverText('the site')]
    } else {
      stock = 'ships'
    }
  } else {
    missing = ['the site\'s colony']
  }

  if (stock === 'unknown') {
    if (!civilian || reach === null || !colony) {
      return unavailable({ rule: 'mineralSupply.route', missing })
    }
  }

  const packets = Boolean(civilian) && reach === true
  const destinationId = packets || stock === 'ships' ? colony.MassDriverDest : null
  const state = packets ? 'packets' : stock === 'ships' ? 'driver' : 'none'
  const inputs = missing.length ? { present: ['FCT_Population.PurchaseCivilianMinerals', 'FCT_Population.MassDriverDest'], missing } : { present: ['FCT_Population.MassDriverDest', 'FCT_PopulationInstallations.Amount'] }

  return ofRule({ rule: 'mineralSupply.route', value: { state, civilian: Boolean(civilian), stock, target, destinationId }, inputs })
}

// The mining row with no manned or automated mines: what is left of its rate is the civilian complexes'.
const CIVILIAN_ONLY = { ManualMineCount: 0, AutomatedMineCount: 0 }

// The sites of one mineral: one entry per colony with a mining row (a colony's mines, or the orbital miners assigned to it) on a deposit of `materialId`, most extracted first. `surface` and `orbital` are the rows of mining-data.js; `routes` the rows of `loadSiteRoutes`; `packets` the rows of colony-minerals.js `loadPacketsInFlight` (null when not read); `flows` the `transferFlows` of the ledger's moves. Each site has `extraction` (its mining rate), `packetOutput` (the civilian output that goes straight into a packet), `local` (what it adds to its own stockpile), `supply` (what leaves it for a destination by a route the save names), `capacity` (what its drivers can send, a limit on stock and not a throughput), `sent` and `loaded` (observed, from the ledger), `stock` (its own stockpile of the mineral now) and its `route`. `connection` is 'unconnected' with no packet route, else 'packets', 'driver', or 'unknown'.
export const siteSupply = ({ surface, orbital, navalAdmins, routes, packets = null, RaceID, materialId, flows }) => {
  const routeBy = Object.fromEntries(routes.map((colony) => [colony.PopulationID, colony]))
  const mineral = MINERALS.find((item) => item.id === materialId)
  const groups = new Map()
  const group = (row) => {
    if (!groups.has(row.PopulationID)) {
      groups.set(row.PopulationID, { populationId: row.PopulationID, name: row.PopName, row, surface: [], orbital: [] })
    }

    return groups.get(row.PopulationID)
  }

  surface.filter((row) => row.MaterialID === materialId).forEach((row) => group(row).surface.push(row))
  orbital.filter((row) => row.MaterialID === materialId).forEach((row) => group(row).orbital.push(row))

  const sites = [...groups.values()].map((entry) => {
    const colony = routeBy[entry.populationId]
    const civilian = [...entry.surface, ...entry.orbital].some((row) => Boolean(row.MassDriverExport))
    const route = routeResult({ colony, civilian, RaceID })
    const routed = isAvailable(route) ? route.value : null
    const extraction = miningSum([...entry.surface.map((row) => surfaceRateResult(row, true)), ...entry.orbital.map((row) => orbitalRateResult(row, navalAdmins))])
    const noPackets = ofRule({ rule: 'mineralSupply.packetOutput', value: 0, inputs: { present: ['FCT_Population.PurchaseCivilianMinerals', 'FCT_Population.MassDriverDest'] } })
    const complexes = entry.surface.filter((row) => row.CivilianMineCount > 0)
    const maybeBought = complexes.some((row) => row.PurchaseCivilianMinerals !== 0)
    const policyMissing = complexes.some((row) => row.PurchaseCivilianMinerals === null || row.PurchaseCivilianMinerals === undefined)
    const reach = colony ? reachOf(colony) : null
    let packetOutput = noPackets

    if (routed === null && (civilian || maybeBought)) {
      packetOutput = unavailable({ rule: 'mineralSupply.packetOutput', missing: route.inputs.missing })
    } else if (policyMissing && reach !== false) {
      packetOutput = unavailable({ rule: 'mineralSupply.packetOutput', missing: [POLICY_COLUMN] })
    } else if (routed !== null && routed.state === 'packets') {
      packetOutput = combine({ rule: 'mineralSupply.packetOutput', parts: { civilian: miningSum(entry.surface.map((row) => surfaceRateResult({ ...row, ...CIVILIAN_ONLY }, true))) }, compute: ({ civilian: output }) => output })
    }

    const local = policyMissing ? unavailable({ rule: 'mineralSupply.localStock', missing: [POLICY_COLUMN] }) : combine({ rule: 'mineralSupply.localStock', parts: { extraction, packetOutput }, compute: ({ extraction: dug, packetOutput: shipped }) => dug - shipped })
    const sent = sentOf(flows, entry.populationId, materialId)
    const loaded = loadedOf(flows, entry.populationId, materialId)
    const ships = routed !== null && routed.stock === 'ships'

    let supply
    let capacity

    if (routed === null) {
      supply = unavailable({ rule: 'mineralSupply.supply', missing: route.inputs.missing })
      capacity = unavailable({ rule: 'minerals.massDriverRate', missing: route.inputs.missing })
    } else if (routed.state === 'none') {
      supply = ofRule({ rule: 'mineralSupply.supply', value: 0, inputs: { present: ['FCT_Population.MassDriverDest', 'FCT_PopulationInstallations.Amount'] } })
      capacity = ofRule({ rule: 'minerals.massDriverRate', value: 0, inputs: { present: ['FCT_Population.MassDriverDest', 'FCT_PopulationInstallations.Amount'] } })
    } else {
      const driverPart = ships ? sent : routed.stock === 'none' ? ofRule({ rule: 'mineralSupply.supply', value: 0, inputs: { present: ['FCT_Population.MassDriverDest'] } }) : unavailable({ rule: 'mineralSupply.supply', missing: ['the number of mass drivers or their driver value'] })

      supply = combine({ rule: 'mineralSupply.supply', parts: { packets: packetOutput, drivers: driverPart }, compute: ({ packets: output, drivers: sentByDrivers }) => output + sentByDrivers })
      capacity = ships ? massDriverRateResult(colony.Drivers, colony.DriverGaps) : routed.stock === 'none' ? ofRule({ rule: 'minerals.massDriverRate', value: 0, inputs: { present: ['FCT_Population.MassDriverDest', 'FCT_PopulationInstallations.Amount'] } }) : unavailable({ rule: 'minerals.massDriverRate', missing: ['the number of mass drivers', 'the driver value of a mass driver'] })
    }

    if (policyMissing && reach !== false) {
      supply = unavailable({ rule: 'mineralSupply.supply', missing: [POLICY_COLUMN] })
    }

    const results = colony ? resultsAt(colony, packets, materialId) : null
    const destination = routed && routed.destinationId ? { populationId: routed.destinationId, name: colony.DestinationName || null } : null

    return {
      populationId: entry.populationId,
      name: entry.name,
      row: entry.row,
      mineral: mineral.name,
      route,
      routed,
      connection: routed ? (routed.state === 'none' ? 'unconnected' : routed.state) : 'unknown',
      destination,
      extraction,
      packetOutput,
      local,
      supply,
      capacity,
      sent,
      loaded,
      stock: results ? results.stock : unavailable({ rule: 'minerals.colonyStock', missing: ['the site\'s colony'] }),
    }
  })

  return sites.sort((a, b) => (valueOrNull(b.extraction) ?? -1) - (valueOrNull(a.extraction) ?? -1) || a.name.localeCompare(b.name))
}

// Scenario entries as the page holds them, `{ [PopulationID of a site]: { tonnes: text, destinationId } }`, read into one entry per site with something entered: `state` 'applied' (a non-negative number and a destination), 'incomplete' (a number and no destination) or 'invalid' (not a number, or negative). A blank amount is nothing entered, not 0, and gives no entry.
export const scenarioEntries = (inputs) => Object.entries(inputs || {}).flatMap(([id, input]) => {
  const text = input && input.tonnes !== undefined && input.tonnes !== null ? String(input.tonnes).trim() : ''

  if (!text) {
    return []
  }

  const tonnes = Number(text)
  const destinationId = input.destinationId || null

  if (!Number.isFinite(tonnes) || tonnes < 0) {
    return [{ populationId: Number(id), destinationId, state: 'invalid', result: null }]
  } else if (destinationId === null) {
    return [{ populationId: Number(id), destinationId, state: 'incomplete', result: null }]
  }

  return [{ populationId: Number(id), destinationId, state: 'applied', result: ofRule({ rule: 'mineralSupply.scenario', value: tonnes, inputs: { present: ['the delivery entered'] } }) }]
})

// The sites with their entered scenario: `scenario` is the entry of the site (null with none), `keeps` what the site would still add to its own stockpile a year if that delivery left it (its `local` less the delivery, which may go below 0: the delivery then draws on stock the site holds), and `exceeds` whether the delivery is above what the site adds (null when that is not known).
export const withScenario = (sites, entries) => sites.map((site) => {
  const entry = entries.find((item) => item.populationId === site.populationId) || null
  const applied = entry && entry.state === 'applied' ? entry : null
  const local = valueOrNull(site.local)

  return {
    ...site,
    scenario: entry,
    keeps: applied ? combine({ rule: 'mineralSupply.localStock', parts: { local: site.local, scenario: applied.result }, compute: ({ local: added, scenario }) => added - scenario }) : null,
    exceeds: applied && local !== null ? applied.result.value > local : null,
  }
})

// Whether a colony's observed moves of a mineral include a receipt (a packet landing or a freighter unloading) that is not 0: a receipt that is not recorded counts, as it may be any amount.
const receivesIn = (flows, populationId, materialId) => {
  const entry = ((flows ? flows.table[populationId] : null) || {})[materialId] || {}

  return [LEDGER_TYPES.received, LEDGER_TYPES.unloaded].some((type) => type in entry && entry[type] !== 0)
}

// The colonies a mineral reaches: those a site's route names, those with packets in flight to them and those with an observed receipt or an entered delivery. One entry per colony: `stock` (what it holds), `inbound` (in flight to it, each packet in exactly one entry), `afterArrival` (stock and inbound), `fromSites` (what the sites that name it send it by their routes, `sites` their ids), `received` and `unloaded` (observed, from the ledger), `scenario` (the deliveries entered for it, null with none) and `withScenario` (`fromSites` and the scenario together, null with no scenario). `packets` are the rows of `loadPacketsInFlight`, keyed as they were read, and `lost` the tonnes in packets bound for no colony of the race (a colony it does not have, or a destination the save does not store), which count in transit and supply none.
export const destinationSupply = ({ routes, sites, packets, flows, materialId, entries = [] }) => {
  const routeBy = Object.fromEntries(routes.map((colony) => [colony.PopulationID, colony]))
  const mineral = MINERALS.find((item) => item.id === materialId)
  const applied = entries.filter((entry) => entry.state === 'applied')
  const packetIds = Object.keys(packets || {}).filter((key) => routeBy[key]).map(Number)
  const inFlightOf = (key) => resultsAt({ PopulationID: key }, packets, materialId).inbound
  const ids = new Set([
    ...sites.map((site) => (site.destination ? site.destination.populationId : null)).filter((id) => id !== null),
    ...packetIds.filter((id) => valueOrNull(inFlightOf(id)) !== 0),
    ...Object.keys(flows ? flows.table : {}).map(Number).filter((id) => receivesIn(flows, id, materialId)),
    ...applied.map((entry) => entry.destinationId),
  ])

  const destinations = [...ids].filter((id) => routeBy[id]).map((id) => {
    const colony = routeBy[id]
    const results = resultsAt(colony, packets, materialId)
    const feeding = sites.filter((site) => site.destination && site.destination.populationId === id)
    const fromSites = sumResults({ rule: 'mineralSupply.supply', results: feeding.map((site) => site.supply) })
    const entered = applied.filter((entry) => entry.destinationId === id)
    const scenario = entered.length ? sumResults({ rule: 'mineralSupply.scenario', results: entered.map((entry) => entry.result) }) : null

    return {
      populationId: id,
      name: colony.PopName,
      stock: results.stock,
      inbound: results.inbound,
      afterArrival: combine({ rule: 'mineralSupply.afterArrival', parts: { stock: results.stock, inbound: results.inbound }, compute: ({ stock, inbound }) => stock + inbound }),
      fromSites,
      sites: feeding.map((site) => site.populationId),
      received: receivedOf(flows, id, materialId),
      unloaded: unloadedOf(flows, id, materialId),
      scenario,
      withScenario: scenario ? combine({ rule: 'mineralSupply.scenario', parts: { fromSites, scenario }, compute: (values) => values.fromSites + values.scenario }) : null,
    }
  })

  const lostKeys = Object.keys(packets || {}).filter((key) => !routeBy[key])
  const lost = packets ? sumResults({ rule: 'minerals.inFlight', results: lostKeys.map((key) => inFlightOf(key)) }) : unavailable({ rule: 'minerals.inFlight', missing: ['the mass-driver packets'] })

  return { destinations: destinations.sort((a, b) => (valueOrNull(b.inbound) ?? -1) - (valueOrNull(a.inbound) ?? -1) || a.name.localeCompare(b.name)), lost, mineral: mineral.name }
}

// The race's own position of one mineral across its colonies, its packets and its freighters: `extraction`, `packetOutput` and `local` summed over `sites` (extraction is always the packet output and the local addition, counted once), `stock` over every colony in `routes`, `inFlight` over every packet (`destinations` and `lost`, so a packet is in one of them and no more), `cargo` (aboard ships, assigned to no destination: where a freighter goes is not recorded), `held` (stock, in flight and cargo) and `landed` (every colony's stock after the packets bound for it have landed, plus any packet that lands nowhere and the cargo), which is `held` again: moves between the race's own colonies change no total.
export const empireSupply = ({ routes, sites, destinations, lost, packets, cargo, materialId }) => {
  const stocks = routes.map((colony) => resultsAt(colony, packets, materialId))
  const stock = sumResults({ rule: 'minerals.colonyStock', results: stocks.map((item) => item.stock) })
  const inFlightByColony = stocks.map((item) => item.inbound)
  const inFlight = packets ? sumResults({ rule: 'minerals.inFlight', results: [...inFlightByColony, lost] }) : unavailable({ rule: 'minerals.inFlight', missing: ['the mass-driver packets'] })
  const aboard = cargoResult(cargo, materialId)
  const held = combine({ rule: 'mineralSupply.afterArrival', parts: { stock, inFlight, aboard }, compute: (values) => values.stock + values.inFlight + values.aboard })
  const landed = combine({ rule: 'mineralSupply.afterArrival', parts: { held: sumResults({ rule: 'mineralSupply.afterArrival', results: stocks.map((item) => combine({ rule: 'mineralSupply.afterArrival', parts: { stock: item.stock, inbound: item.inbound }, compute: (values) => values.stock + values.inbound })) }), lost, aboard }, compute: (values) => values.held + values.lost + values.aboard })

  return {
    extraction: miningSum(sites.map((site) => site.extraction)),
    packetOutput: sumResults({ rule: 'mineralSupply.packetOutput', results: sites.map((site) => site.packetOutput) }),
    local: sumResults({ rule: 'mineralSupply.localStock', results: sites.map((site) => site.local) }),
    stock,
    inFlight,
    cargo: aboard,
    held,
    landed,
    destinations: destinations.length,
  }
}

// The whole supply of one mineral: the sites with the entered scenario, the destinations and the race's position. `entries` are `scenarioEntries` of the focused mineral's inputs, of which only those of a site that mines the mineral count. `cargo` is the page's read of minerals aboard ships by material id.
export const mineralSupply = ({ surface, orbital, navalAdmins, routes, packets, cargo, RaceID, materialId, flows, entries = [] }) => {
  const found = siteSupply({ surface, orbital, navalAdmins, routes, packets, RaceID, materialId, flows })
  const counted = entries.filter((entry) => found.some((site) => site.populationId === entry.populationId))
  const sites = withScenario(found, counted)
  const { destinations, lost } = destinationSupply({ routes, sites, packets, flows, materialId, entries: counted })

  return { sites, destinations, lost, empire: empireSupply({ routes, sites, destinations, lost, packets, cargo, materialId }), entries: counted }
}

export const ROUTE_STATES = Object.freeze({
  packets: 'Civilian output ships by packet',
  driver: 'Drivers ship stock',
  none: 'No packet route',
  unknown: 'Route not known',
})

// Why a site has no packet route, in words, from the route's verdict on its destination.
export const noRouteReason = (route) => {
  if (!route || route.state !== 'none') {
    return null
  }

  if (route.target === 'none' || route.target === 'gone' || route.target === 'self') {
    return route.target === 'none' ? 'no destination' : `the destination is ${TARGET_STATES[route.target]}`
  }

  return 'the site has no mass driver'
}
