// The civilian mining complex policy audit of the Mineral Breakdown: per colony of the race whose complexes produce, whether the race buys or taxes their output, where a bought output goes by mass driver, which of the transfer's prerequisites are missing or not known, and what the other choice would change. The purchase and tax rates are game constants the save does not store, held to the version they were reproduced for. Evidence: docs/plans/backlog/evidence/AE-076-01.md.

import { MINERALS, civilianPacketShare, massDriverRateResult, surfaceRate, wholeCapacity } from './minerals'
import { capacityTerms, gateMiningRows, loadOrbitalMining, loadSurfaceMining } from './mining-data'
import { miningSum, orbitalRateResult, surfaceRateResult } from './mineral-outlook'
import { loadNavalAdmins } from './naval-admins'
import { combine, isAvailable, ofRule, registerRule, ruleSupports, sumResults, unavailable } from './provenance'

const POLICY_VERSIONS = ['3.2.x']

registerRule({
  id: 'cmcPolicy.choice',
  versions: POLICY_VERSIONS,
  units: 'choice',
  verification: 'confirmed',
  structure: ['FCT_Population.PurchaseCivilianMinerals', 'FCT_Race.NPR'],
  note: 'The stored choice: 1 buys the complexes\' output for the colony\'s stockpile, 0 taxes the complexes and leaves their output out of it. An NPR keeps the output at no charge whatever is stored. A colony with no stored choice has none.',
})

registerRule({
  id: 'cmcPolicy.production',
  versions: POLICY_VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.CivilianInstallation, MiningProductionValue', 'FCT_Race.MineProduction', 'FCT_SystemBody.RadiationLevel', 'FCT_MineralDeposit.Amount'],
  note: 'The complexes produce, and the choice applies, when their capacity (amount times mining value) comes to at least one whole unit, the race\'s mine production is above 0, radiation leaves production above 0 and the body has a deposit left; otherwise the game neither charges nor pays for them, and the colony gets no row. Every complex colony of the saves it was checked on produces, so the cut-off is not observed.',
})

registerRule({
  id: 'cmcPolicy.output',
  versions: POLICY_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue', 'FCT_Race.MineProduction', 'FCT_MineralDeposit.Accessibility', 'FCT_SystemBody.RadiationLevel', 'FCT_CommanderBonuses.BonusValue'],
  note: 'What the complexes dig a year at each deposit\'s current accessibility: their capacity accumulated from decimal installation amounts and cut to a whole number, times the race\'s mine production, the accessibility, the governor\'s and a quarter of the sector commander\'s mining bonus and the radiation modifier; efficiency, stability and political status do not apply. Each colony that buys and exports in the saves it was checked on shipped exactly this output times the last update\'s length; a year ahead is an estimate, as accessibility falls past half a deposit.',
})

registerRule({
  id: 'cmcPolicy.rates',
  versions: POLICY_VERSIONS,
  units: 'wealth/yr',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount', 'FCT_WealthData.Amount, UseID'],
  note: 'The race pays 250 wealth a year for each complex whose output it buys and collects 125 a year from each complex it taxes; an NPR pays and collects nothing. The save stores no rate: these are the game\'s constants, reproduced to the unit from each colony\'s entry in the wealth ledger (uses 35 and 36) of a save it was checked on, over five updates. A save whose game rules are not known has no rate.',
})

registerRule({
  id: 'cmcPolicy.destination',
  versions: POLICY_VERSIONS,
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_Population.MassDriverDest, RaceID, SystemID'],
  note: 'A bought output ships to the mass driver destination when that colony exists. Destination 0, or a colony that is gone, leaves the output at the source, as the game reads a missing destination as none. A destination of another race, in another system or the colony itself is never one the game offers, and one of another race would hand the minerals to that race. None of the saves it was checked on has a missing or invalid destination, so those cases are not observed.',
})

registerRule({
  id: 'cmcPolicy.drivers',
  versions: POLICY_VERSIONS,
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue'],
  note: 'The game offers destinations only to a colony with a mass driver, and offers only colonies of the race in the same system with a mass driver of their own; without a driver at the source, the stock above the reserve does not ship. Every destination in the saves it was checked on has drivers at both ends, so a missing one is not observed.',
})

registerRule({
  id: 'cmcPolicy.throughput',
  versions: ['3.2.x'],
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_Population mineral stocks and reserves', 'surface and orbital mining rates', 'DIM_PlanetaryInstallation.MassDriverValue, MiningProductionValue'],
  note: 'Bought civilian output tops up each local mineral reserve after other mining; only the remainder ships in its own packet, without the stock drivers\' capacity limit. The comparison uses a one-year estimate at held mining rates, not a known future update schedule or packet arrival.',
  assumptions: ['Current accessibility and mining rates are held for one year. No other stock flows or reserve changes are modelled; actual updates can change the retained share.'],
})

registerRule({
  id: 'cmcPolicy.switch',
  versions: POLICY_VERSIONS,
  units: 'per year',
  verification: 'estimated',
  structure: ['the cmcPolicy.rates constants', 'the cmcPolicy.output estimate'],
  note: 'Hypothetical: what the other choice would change a year, the output gained or given up against the purchase cost and the lost tax together (375 wealth a complex). It needs the rates for the save\'s version and a known output. Nothing here changes the save: the choice is made in the game.',
})

// Wealth a year per complex: what buying its output costs and what taxing it brings in, for the versions `cmcPolicy.rates` holds for.
export const CMC_PURCHASE_COST = 250
export const CMC_TAX_INCOME = 125

export const RATES_MISSING = 'the civilian mining complex purchase and tax rates for the save\'s game version'

// What a colony's choice and export state come to, most pressing first; `order` null sorts an unknown state last.
export const POLICY_STATES = {
  invalid: { order: 0, label: 'Destination invalid', icon: 'mdi-close-octagon-outline', color: 'error' },
  stockpiling: { order: 1, label: 'Piles up here', icon: 'mdi-archive-arrow-down-outline', color: 'warning' },
  prerequisite: { order: 2, label: 'Mass driver missing', icon: 'mdi-transit-connection-variant', color: 'warning' },
  taxed: { order: 3, label: 'Taxed', icon: 'mdi-cash-plus', color: 'warning' },
  acknowledged: { order: 4, label: 'Taxed, acknowledged', icon: 'mdi-check-decagram-outline', color: undefined },
  exporting: { order: 5, label: 'Bought and exported', icon: 'mdi-check-circle-outline', color: 'success' },
  kept: { order: 6, label: 'Kept by the NPR', icon: 'mdi-check', color: undefined },
  unknown: { order: null, label: 'Not known', icon: 'mdi-help-circle-outline', color: undefined },
}

// Where a colony's mass driver points: 'none' (no destination), 'gone' (a colony that no longer exists), 'self', 'foreign' (another race's colony), 'elsewhere' (another system) or 'valid'. 'none' and 'gone' leave a bought output at the source; 'self', 'foreign' and 'elsewhere' are destinations the game never offers.
export const TARGET_STATES = {
  none: 'no destination',
  gone: 'a colony that is gone',
  self: 'the colony itself',
  foreign: 'a colony of another race',
  elsewhere: 'a colony in another system',
  valid: 'a colony of the race in the same system',
}
const STAYS = ['none', 'gone']
const INVALID = ['self', 'foreign', 'elsewhere']

const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const whole = wholeCapacity

const installations = (GameID, condition, columns) => `select FCT_PopulationInstallations.PopID, ${columns} from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID}${condition} group by FCT_PopulationInstallations.PopID`

// Drivers by colony: the driver count (amount times driver value) and how many installation rows have an amount or a driver value not recorded.
const DRIVER_COLUMNS = `sum(case when DIM_PlanetaryInstallation.MassDriverValue > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MassDriverValue else 0 end) as Drivers, sum(case when FCT_PopulationInstallations.Amount is not 0 and DIM_PlanetaryInstallation.MassDriverValue is not 0 and (FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.MassDriverValue is null) then 1 else 0 end) as Gaps, ${capacityTerms('DIM_PlanetaryInstallation.MassDriverValue', 'DIM_PlanetaryInstallation.MassDriverValue > 0')} as DriverTerms`

// The driver count and gaps of every colony of a game, as one row per PopID: the sub-select the policy rows and the Mineral Outlook's site routes read.
export const driversByColony = (GameID) => installations(GameID, '', DRIVER_COLUMNS)

// One row per colony of the race with civilian mining complexes: the stored choice, what decides whether the complexes produce, the colony's drivers and its destination with that colony's race, system and drivers.
const policyQuery = ({ GameID, RaceID }) => `select FCT_Population.PopulationID, FCT_Population.SystemID, ${MINERALS.map((mineral) => `FCT_Population.${mineral.name}, FCT_Population.Reserve${mineral.name}`).join(', ')}, FCT_Population.PurchaseCivilianMinerals, FCT_Population.MassDriverDest, FCT_Race.NPR, FCT_Race.MineProduction, FCT_SystemBody.RadiationLevel, VIR_Civilian.Complexes, VIR_Civilian.ComplexesTerms, VIR_Civilian.CivilianCapacity, VIR_Civilian.CivilianCapacityTerms, VIR_Civilian.Gaps as CivilianGaps, coalesce(VIR_Drivers.Drivers, 0) as Drivers, VIR_Drivers.DriverTerms, coalesce(VIR_Drivers.Gaps, 0) as DriverGaps, (select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount > 0) as Deposits, (select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount is null) as DepositGaps, VIR_Destination.PopulationID as DestinationID, VIR_Destination.PopName as DestinationName, VIR_Destination.RaceID as DestinationRaceID, VIR_Destination.SystemID as DestinationSystemID, coalesce(VIR_DestinationDrivers.Drivers, 0) as DestinationDrivers, VIR_DestinationDrivers.DriverTerms as DestinationDriverTerms, coalesce(VIR_DestinationDrivers.Gaps, 0) as DestinationDriverGaps from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID inner join (${installations(GameID, ' and (DIM_PlanetaryInstallation.CivilianInstallation = 1) is not 0 and (DIM_PlanetaryInstallation.MiningProductionValue > 0) is not 0 and (FCT_PopulationInstallations.Amount > 0) is not 0', `sum(FCT_PopulationInstallations.Amount) as Complexes, ${capacityTerms('1')} as ComplexesTerms, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue) as CivilianCapacity, ${capacityTerms('DIM_PlanetaryInstallation.MiningProductionValue')} as CivilianCapacityTerms, sum(case when FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.CivilianInstallation is null or DIM_PlanetaryInstallation.MiningProductionValue is null then 1 else 0 end) as Gaps`)}) as VIR_Civilian on VIR_Civilian.PopID = FCT_Population.PopulationID left join (${installations(GameID, '', DRIVER_COLUMNS)}) as VIR_Drivers on VIR_Drivers.PopID = FCT_Population.PopulationID left join FCT_Population as VIR_Destination on VIR_Destination.PopulationID = FCT_Population.MassDriverDest and VIR_Destination.GameID = FCT_Population.GameID and FCT_Population.MassDriverDest > 0 left join (${installations(GameID, '', DRIVER_COLUMNS)}) as VIR_DestinationDrivers on VIR_DestinationDrivers.PopID = VIR_Destination.PopulationID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (VIR_Civilian.Complexes > 0 or VIR_Civilian.Gaps > 0)`

// The race's complex colonies (`colonies`, by policyQuery) and the deposit rows of its colonies with civilian capacity (`surface`, mining-data.js `surfaceMiningQuery`, with the Mining bonus left unknown for the `blocked` bonus IDs), for `cmcPolicyRows`.
export const loadCmcPolicy = async (database, { GameID, RaceID, blocked = new Set(), ranks = true }) => {
  const [[colonies], surface, orbital] = await Promise.all([
    database.query(policyQuery({ GameID, RaceID })),
    loadSurfaceMining(database, { GameID, RaceID }),
    loadOrbitalMining(database, { GameID, RaceID }),
  ])
  const navalAdmins = orbital.length ? await loadNavalAdmins(database, { GameID, RaceID, bonusId: 6, share: 'Industrial', ranks, blocked }) : {}

  return Object.freeze({ colonies: Object.freeze(colonies), surface: Object.freeze(gateMiningRows(surface, blocked).filter((row) => whole(row.CivilianMineCount, row.CivilianMineTerms) !== 0)), orbital: Object.freeze(gateMiningRows(orbital, blocked)), navalAdmins })
}

export const NO_CMC_POLICY = Object.freeze({ colonies: Object.freeze([]), surface: Object.freeze([]), orbital: Object.freeze([]), navalAdmins: Object.freeze({}) })

const choiceOf = (row) => {
  if (row.NPR === 1) {
    return 'npr'
  } else if (row.NPR !== 0) {
    return null
  }

  return row.PurchaseCivilianMinerals === 1 ? 'buy' : row.PurchaseCivilianMinerals === 0 ? 'tax' : null
}

const choiceResult = (row, choice) => (choice ? ofRule({ rule: 'cmcPolicy.choice', value: choice, inputs: { present: ['FCT_Population.PurchaseCivilianMinerals', 'FCT_Race.NPR'] } }) : unavailable({ rule: 'cmcPolicy.choice', missing: [row.NPR === 0 || row.NPR === 1 ? 'the colony\'s civilian mineral purchase setting' : 'whether the race is an NPR'] }))

// Whether the complexes produce: true or false, or null while an input that could decide it is not recorded. One condition known to fail settles it as false.
const productionResult = (row) => {
  const capacity = whole(row.CivilianCapacity, row.CivilianCapacityTerms)
  const capacityKnown = known(capacity) && !(row.CivilianGaps > 0)
  const depositsKnown = row.Deposits > 0 || !(row.DepositGaps > 0)
  const conditions = [
    [capacityKnown ? capacity >= 1 : null, 'the number of civilian mining complexes on the colony'],
    [known(row.MineProduction) ? row.MineProduction > 0 : null, 'the race\'s mine production'],
    [known(row.RadiationLevel) ? row.RadiationLevel < 10000 : null, 'the body\'s radiation level'],
    [depositsKnown ? row.Deposits > 0 : null, 'the amount of the deposits'],
  ]
  const present = ['FCT_PopulationInstallations.Amount', 'FCT_Race.MineProduction', 'FCT_SystemBody.RadiationLevel', 'FCT_MineralDeposit.Amount']

  if (conditions.some(([verdict]) => verdict === false)) {
    return ofRule({ rule: 'cmcPolicy.production', value: false, inputs: { present } })
  }

  const missing = conditions.filter(([verdict]) => verdict === null).map(([, column]) => column)

  return missing.length ? unavailable({ rule: 'cmcPolicy.production', missing }) : ofRule({ rule: 'cmcPolicy.production', value: true, inputs: { present } })
}

const OUTPUT_INPUTS = { Amount: 'the amount of the deposit', CivilianMineCount: 'the number of civilian mining complexes on the colony', MineProduction: 'the race\'s mine production', Accessibility: 'the accessibility of the deposit', RadiationModifier: 'the body\'s radiation level', GovernorBonus: 'the value of the commander\'s bonus', SectorBonus: 'the value of the commander\'s bonus' }

const OUTPUT_COLUMNS = { Amount: 'FCT_MineralDeposit.Amount', CivilianMineCount: 'FCT_PopulationInstallations.Amount', MineProduction: 'FCT_Race.MineProduction', Accessibility: 'FCT_MineralDeposit.Accessibility', RadiationModifier: 'FCT_SystemBody.RadiationLevel', GovernorBonus: 'FCT_CommanderBonuses.BonusValue', SectorBonus: 'FCT_CommanderBonuses.BonusValue' }

// What the complexes dig a year over the body's deposits (`deposits`: the colony's `surface` rows). A deposit with nothing left gives nothing; one whose amount is not recorded makes the output unavailable. The colony's own mines are left out: the surface rate is taken with the civilian capacity alone.
const outputResult = (deposits) => {
  if (!deposits.length) {
    return unavailable({ rule: 'cmcPolicy.output', missing: ['the body\'s deposits as the race surveyed them'] })
  }

  const live = deposits.filter((row) => !(Number.isFinite(row.Amount) && row.Amount <= 0))
  const missing = [...new Set(live.flatMap((row) => Object.keys(OUTPUT_COLUMNS).filter((column) => !Number.isFinite(row[column])).map((column) => (row.BonusWithheld && (column === 'GovernorBonus' || column === 'SectorBonus') ? row.BonusWithheld : OUTPUT_INPUTS[column]))))]

  if (missing.length) {
    return unavailable({ rule: 'cmcPolicy.output', missing })
  }

  const tons = live.reduce((total, row) => total + surfaceRate({ ...row, ManualMineCount: 0, ManualMineTerms: null, AutomatedMineCount: 0, AutomatedMineTerms: null }, false), 0)

  return Number.isFinite(tons) ? ofRule({ rule: 'cmcPolicy.output', value: tons, inputs: { present: [...new Set(Object.values(OUTPUT_COLUMNS))] } }) : unavailable({ rule: 'cmcPolicy.output', missing: ['a mining modifier of the colony'] })
}

const complexesOf = (row) => (known(row.Complexes) && !(row.CivilianGaps > 0) ? whole(row.Complexes, row.ComplexesTerms) : null)

// The rate a year for `complexes` at `perComplex`, or unavailable naming the rate when the save's version has none, or the complexes when their count is not recorded.
const rateResult = (complexes, perComplex, version) => {
  if (ruleSupports('cmcPolicy.rates', version) !== true) {
    return unavailable({ rule: 'cmcPolicy.rates', missing: [RATES_MISSING] })
  } else if (complexes === null) {
    return unavailable({ rule: 'cmcPolicy.rates', missing: ['the number of civilian mining complexes on the colony'] })
  }

  return ofRule({ rule: 'cmcPolicy.rates', value: complexes * perComplex, inputs: { present: ['FCT_PopulationInstallations.Amount', 'the purchase and tax rates'] } })
}

// The wealth the choice moves a year now: the purchase cost as a negative, the tax as a positive, 0 for an NPR. Unavailable while it is not known that the complexes produce, as the game charges and pays only for production.
const wealthResult = (choice, complexes, production, version) => {
  if (!choice) {
    return unavailable({ rule: 'cmcPolicy.rates', missing: ['the colony\'s civilian mineral purchase setting'] })
  } else if (!isAvailable(production)) {
    return unavailable({ rule: 'cmcPolicy.rates', missing: production.inputs.missing })
  }

  return rateResult(complexes, { buy: -CMC_PURCHASE_COST, tax: CMC_TAX_INCOME, npr: 0 }[choice], version)
}

// What the other choice would change a year: `{ minerals, wealth }`, minerals in t/yr and wealth per year, each signed. Null for an NPR or a colony with no known choice, which have no other choice to weigh.
const switchResult = (choice, complexes, output, production, version) => {
  if (choice !== 'buy' && choice !== 'tax') {
    return null
  }

  const sign = choice === 'buy' ? -1 : 1

  return combine({
    rule: 'cmcPolicy.switch',
    parts: { production, output, swing: rateResult(complexes, CMC_PURCHASE_COST + CMC_TAX_INCOME, version) },
    compute: ({ output: tons, swing }) => ({ minerals: sign * tons, wealth: -sign * swing }),
  })
}

// Where a colony's mass driver points, as one of the TARGET_STATES keys, or null when the destination or what decides it is not stored. `row` carries the colony's MassDriverDest, PopulationID and SystemID and the destination's DestinationID, DestinationRaceID and DestinationSystemID.
export const targetOf = (row, RaceID) => {
  const destination = row.MassDriverDest

  if (!Number.isInteger(destination)) {
    return null
  } else if (destination <= 0) {
    return 'none'
  } else if (row.DestinationID === null || row.DestinationID === undefined) {
    return 'gone'
  } else if (destination === row.PopulationID) {
    return 'self'
  } else if (!Number.isInteger(row.DestinationRaceID) || !Number.isInteger(row.DestinationSystemID) || !Number.isInteger(row.SystemID)) {
    return null
  } else if (row.DestinationRaceID !== RaceID) {
    return 'foreign'
  }

  return row.DestinationSystemID === row.SystemID ? 'valid' : 'elsewhere'
}

const targetResult = (row, target) => (target ? ofRule({ rule: 'cmcPolicy.destination', value: target, inputs: { present: ['FCT_Population.MassDriverDest', 'FCT_Population.RaceID, SystemID'] } }) : unavailable({ rule: 'cmcPolicy.destination', missing: [Number.isInteger(row.MassDriverDest) ? 'the race or system of the destination colony' : 'the colony\'s mass driver destination'] }))

// Whether a colony has a mass driver: true or false, or null when a driver installation's amount or value is not recorded.
const driverResult = (drivers, gaps, terms, where) => {
  const count = whole(drivers, terms)
  return known(count) && !(gaps > 0) ? ofRule({ rule: 'cmcPolicy.drivers', value: count >= 1, inputs: { present: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue'] } }) : unavailable({ rule: 'cmcPolicy.drivers', missing: [`the number of mass drivers or their driver value at ${where}`] })
}

// Reserve allocation is per mineral, never against an aggregate stockpile: the other surface and orbital mining enters local stock before the civilian share is split.
const shippedResult = (row, deposits, orbital, navalAdmins) => sumResults({
  rule: 'cmcPolicy.throughput',
  results: deposits.filter((deposit) => !(known(deposit.Amount) && deposit.Amount === 0)).map((deposit) => {
    const mineral = MINERALS.find((mineral) => mineral.id === deposit.MaterialID)
    const stock = mineral && row[mineral.name]
    const reserve = mineral && row[`Reserve${mineral.name}`]
    const inputs = { present: ['the colony\'s mineral stock and reserve'] }

    if (!mineral || !known(stock) || !known(reserve)) {
      return unavailable({ rule: 'cmcPolicy.throughput', missing: [`the ${mineral ? mineral.name : 'mineral'} stock and reserve of the colony`] })
    }

    const civilian = surfaceRateResult({ ...deposit, ManualMineCount: 0, ManualMineTerms: null, AutomatedMineCount: 0, AutomatedMineTerms: null }, false)
    const extraction = miningSum([surfaceRateResult(deposit, false), ...orbital.filter((ship) => ship.MaterialID === deposit.MaterialID).map((ship) => orbitalRateResult(ship, navalAdmins))])

    return combine({ rule: 'cmcPolicy.throughput', parts: { civilian, extraction }, compute: (values) => civilianPacketShare({ ...values, stock, reserve }), inputs })
  }),
})

// Annualised bought output remaining after the one-year local-reserve top-up, compared with the separate stock-driver capacity.
const throughputOf = (choice, target, output, capacity, shipped) => {
  if (choice !== 'buy') {
    return { state: choice ? 'unbought' : 'unknown', result: choice ? null : unavailable({ rule: 'cmcPolicy.throughput', missing: ['the colony\'s civilian mineral purchase setting'] }) }
  } else if (STAYS.includes(target)) {
    return { state: 'stays', result: ofRule({ rule: 'cmcPolicy.throughput', value: { shipped: 0 }, inputs: { present: ['FCT_Population.MassDriverDest'] } }) }
  } else if (INVALID.includes(target)) {
    return { state: 'invalid', result: null }
  } else if (target !== 'valid') {
    return { state: 'unknown', result: unavailable({ rule: 'cmcPolicy.throughput', missing: ['the mass driver destination'] }) }
  }

  const result = combine({ rule: 'cmcPolicy.throughput', parts: { output, capacity, shipped }, compute: (values) => values })

  return { state: isAvailable(result) ? (result.value.capacity >= result.value.shipped ? 'within' : 'over') : 'unknown', result }
}

const stateOf = ({ choice, producing, target, source, receiver, throughput, acknowledged }) => {
  if (!choice || producing !== true) {
    return 'unknown'
  } else if (choice === 'npr') {
    return 'kept'
  } else if (choice === 'tax') {
    return acknowledged ? 'acknowledged' : 'taxed'
  } else if (!target) {
    return 'unknown'
  } else if (STAYS.includes(target)) {
    return 'stockpiling'
  } else if (INVALID.includes(target)) {
    return 'invalid'
  } else if (source === false || receiver === false) {
    return 'prerequisite'
  } else if (source === null || receiver === null || throughput.state === 'unknown') {
    return 'unknown'
  }

  return 'exporting'
}

const verdictOf = (result) => (isAvailable(result) ? result.value : null)

// The policy rows: one per complex colony whose complexes produce (or might: production not known), none for one whose complexes produce nothing, which `idle` counts. `RaceID` is the race the colonies belong to; `version` the save's formula version (capabilities.js `loadFormulaVersion`), which decides whether the rates hold; `acknowledged` the PopulationIDs whose taxation is acknowledged as intended.
export const cmcPolicyRows = ({ colonies, surface, orbital = [], navalAdmins = {} }, { RaceID, version, acknowledged = [] }) => {
  const depositsBy = {}
  const acknowledgedIds = new Set(acknowledged)

  surface.forEach((row) => (depositsBy[row.PopulationID] = depositsBy[row.PopulationID] || []).push(row))

  const rows = colonies.map((row) => {
    const production = productionResult(row)

    if (verdictOf(production) === false) {
      return null
    }

    const choice = choiceOf(row)
    const complexes = complexesOf(row)
    const output = complexes === null ? unavailable({ rule: 'cmcPolicy.output', missing: ['the number of civilian mining complexes on the colony'] }) : outputResult(depositsBy[row.PopulationID] || [])
    const target = targetOf(row, RaceID)
    const capacity = massDriverRateResult(row.Drivers, row.DriverGaps, row.DriverTerms)
    const sourceDrivers = driverResult(row.Drivers, row.DriverGaps, row.DriverTerms, 'the source')
    const receiverDrivers = target && !STAYS.includes(target) ? driverResult(row.DestinationDrivers, row.DestinationDriverGaps, row.DestinationDriverTerms, 'the destination') : null
    const source = verdictOf(sourceDrivers)
    const receiver = receiverDrivers ? verdictOf(receiverDrivers) : undefined
    const throughput = throughputOf(choice, target, output, capacity, shippedResult(row, depositsBy[row.PopulationID] || [], orbital.filter((ship) => ship.PopulationID === row.PopulationID), navalAdmins))
    const producing = verdictOf(production)
    const acknowledgeable = choice === 'tax' && producing === true
    const state = stateOf({ choice, producing, target, source, receiver: receiver === undefined ? true : receiver, throughput, acknowledged: acknowledgeable && acknowledgedIds.has(row.PopulationID) })

    return {
      PopulationID: row.PopulationID,
      row,
      production,
      choice,
      choiceResult: choiceResult(row, choice),
      complexes,
      output,
      wealth: wealthResult(choice, complexes, production, version),
      target,
      targetResult: targetResult(row, target),
      destination: target && target !== 'none' ? { PopulationID: row.MassDriverDest, name: row.DestinationName || null } : null,
      capacity,
      sourceDrivers,
      receiverDrivers,
      throughput,
      switch: switchResult(choice, complexes, output, production, version),
      acknowledgeable,
      acknowledged: state === 'acknowledged',
      state,
    }
  })

  return { rows: rows.filter(Boolean), idle: rows.filter((row) => !row).length }
}
