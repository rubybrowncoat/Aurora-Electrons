import { tracked } from '../utilities/load-tracking'
import { registerRule, ofRule, unavailable } from '../utilities/provenance'
import capabilityGates from './capability-gates'

registerRule({
  id: 'production.populationCapacity',
  versions: ['2.7.x'],
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_Race.ConstructionProduction, OrdnanceProduction, FighterProduction, EconomicProdModifier', 'FCT_Population.Efficiency, UnrestPoints', 'FCT_SystemBody.RadiationLevel', 'DIM_PlanetaryInstallation.ConstructionValue, OrdnanceProductionValue, FighterProductionValue', 'FCT_PopulationInstallations.Amount', 'FCT_Commander, FCT_CommanderBonuses', 'FCT_GroundUnitClass.ConstructionRating'],
  note: 'A colony\'s yearly capacity for construction, ordnance or fighters: the race\'s production rate times the installations\' rating times the colony\'s overall modifier (governor and sector bonus, species rate, economy, efficiency, radiation, stability and political status); construction adds the engineer formations\' share. The ordnance figure matched the saved build rate of ordnance projects to within 0.15%; the construction and fighter figures are the same product on other columns and have no saved case. A colony the modifier read does not cover has no figure.',
})

// The columns each capacity multiplies together; a null one leaves the capacity unknown.
const CAPACITY_TERMS = {
  construction: ['ConstructionProduction', 'OverallProductionModifier', 'ConstructionPower', 'EngineerProductionModifier', 'GroundConstructionPower'],
  ordnance: ['OrdnanceProduction', 'OverallProductionModifier', 'OrdnanceProductionPower'],
  fighter: ['FighterProduction', 'OverallProductionModifier', 'FighterProductionPower'],
}

const CAPACITY = {
  construction: (modifiers) => (modifiers.ConstructionProduction * modifiers.OverallProductionModifier * modifiers.ConstructionPower) + (modifiers.ConstructionProduction * modifiers.EngineerProductionModifier * modifiers.GroundConstructionPower),
  ordnance: (modifiers) => modifiers.OrdnanceProduction * modifiers.OverallProductionModifier * modifiers.OrdnanceProductionPower,
  fighter: (modifiers) => modifiers.FighterProduction * modifiers.OverallProductionModifier * modifiers.FighterProductionPower,
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The modifier column each commander bonus ID the query reads goes into. A bonus the save's lookup row does not confirm (`blockedBonuses` of utilities/capabilities.js) leaves its column unknown, so that nothing built on it is given.
export const GATED_COLUMNS = Object.freeze({ 4: 'ShipyardBuildRate', 5: 'OverallProductionModifier', 11: 'OverallGroundUnitModifier' })

// A population's modifier row with the columns of the `blocked` bonuses made null.
export const gateModifier = (modifier, blocked) => Object.entries(GATED_COLUMNS).reduce((gated, [id, column]) => (blocked.has(Number(id)) ? { ...gated, [column]: null } : gated), modifier)

// The result of 'production.populationCapacity' of a population's `modifiers` row (undefined for a colony the read does not cover) and a capacity `kind`: unavailable, naming what is missing, when the row, a column or the commander bonus lookup it needs is not there.
export const capacityResult = (modifiers, kind, blocked) => {
  const terms = CAPACITY_TERMS[kind]
  const lookup = blocked.has(5) ? ['commander bonus 5, Production (the save\'s lookup row is not confirmed)'] : []

  if (!modifiers) {
    return unavailable({ rule: 'production.populationCapacity', missing: ['the colony\'s production modifiers', ...lookup] })
  }

  const missing = terms.filter((term) => !isNumber(modifiers[term]))
  const present = terms.filter((term) => isNumber(modifiers[term]))

  return missing.length || lookup.length ? unavailable({ rule: 'production.populationCapacity', missing: [...missing, ...lookup], present }) : ofRule({ rule: 'production.populationCapacity', value: CAPACITY[kind](modifiers), inputs: { present } })
}

// Per-population production modifiers and the capacity helpers built on them, shared by the Production, Mineral Outlook, Colony Outlook and Logistics pages. The host component provides `database`, `GameID` and `RaceID` (mapGetters), and can list `populationProductionModifiers` among its tracked reads (`loadErrors`).
// `populationCapacityResult(populationId, kind)` ('construction', 'ordnance' or 'fighter') is a provenance result of 'production.populationCapacity': unavailable, naming what is missing, for a colony without a modifier row or with a null column. A caller that sums or shows the figure reads the result, never a 0 for a colony without one.
export default {
  mixins: [capabilityGates],
  methods: {
    populationCapacityResult (populationId, kind) {
      return capacityResult(this.populationProductionModifiers[populationId], kind, this.blockedBonuses)
    },
  },
  asyncComputed: {
    populationProductionModifiers: {
      get: tracked('populationProductionModifiers', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        // The save has no indexes, so every join to FCT_CommanderBonuses builds a temporary one over the whole table. VIR_CommanderBonuses reads it once, pivoted by bonus type, and only for the governors of this race's colonies and of the sectors they lie in; the ground formations are read only for its colonies.
        const [modifiers] = await this.database.query(`with VIR_RacePopulations as materialized (select FCT_Population.PopulationID, FCT_Population.SystemID from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}), VIR_CommanderBonuses as materialized (select FCT_Commander.CommandID, FCT_Commander.CommandType, max(case when FCT_CommanderBonuses.BonusID = 5 then FCT_CommanderBonuses.BonusValue end) as ConstructionBonus, max(case when FCT_CommanderBonuses.BonusID = 4 then FCT_CommanderBonuses.BonusValue end) as ShipbuildingBonus, max(case when FCT_CommanderBonuses.BonusID = 11 then FCT_CommanderBonuses.BonusValue end) as GroundUnitBonus from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID in (4, 5, 11) where FCT_Commander.CommanderType in (2,4) and FCT_Commander.CommandID <> 0 and ((FCT_Commander.CommandType = 3 and FCT_Commander.CommandID in (select VIR_RacePopulations.PopulationID from VIR_RacePopulations)) or (FCT_Commander.CommandType = 4 and FCT_Commander.CommandID in (select FCT_RaceSysSurvey.SectorID from FCT_RaceSysSurvey where FCT_RaceSysSurvey.SystemID in (select VIR_RacePopulations.SystemID from VIR_RacePopulations)))) group by FCT_Commander.CommanderID) select VIR_PopulationModifiers.PopulationID, VIR_PopulationModifiers.PopName, VIR_PopulationModifiers.ShipyardOperations, VIR_PopulationModifiers.MinConstructionPeriod, VIR_PopulationModifiers.FighterProduction, VIR_PopulationModifiers.FighterProductionPower, VIR_PopulationModifiers.OrdnanceProduction, VIR_PopulationModifiers.OrdnanceProductionPower, VIR_PopulationModifiers.ConstructionProduction, VIR_PopulationModifiers.ConstructionPower, VIR_PopulationModifiers.GroundConstructionPower, VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.RadiationProductionModifier as EngineerProductionModifier, VIR_PopulationModifiers.ActualPlanetCommanderConstructionBonus * VIR_PopulationModifiers.ActualSectorCommanderConstructionBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as OverallProductionModifier, VIR_PopulationModifiers.ActualPlanetCommanderShipbuildingBonus * VIR_PopulationModifiers.ActualSectorCommanderShipbuildingBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.ShipBuilding * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as ShipyardBuildRate, VIR_PopulationModifiers.ResearchRateModifier * VIR_PopulationModifiers.Research * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod * VIR_PopulationModifiers.ResearchSpeed as OverallResearchModifier, VIR_PopulationModifiers.GroundFormationConstructionRate * VIR_PopulationModifiers.ActualPlanetCommanderGroundUnitBonus * VIR_PopulationModifiers.ActualSectorCommanderGroundUnitBonus * VIR_PopulationModifiers.ProductionRateModifier * VIR_PopulationModifiers.EconomicProdModifier * VIR_PopulationModifiers.Efficiency * VIR_PopulationModifiers.RadiationProductionModifier * VIR_PopulationModifiers.PoliticalStability * VIR_PopulationModifiers.ProductionMod as OverallGroundUnitModifier, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component from (select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_Population.RaceID, (FCT_Game.ResearchSpeed / 100.0) as ResearchSpeed, FCT_Game.MinConstructionPeriod, FCT_Race.ConstructionProduction, FCT_Race.OrdnanceProduction, FCT_Race.FighterProduction, FCT_Race.Research, FCT_Race.ShipBuilding, FCT_Race.GroundFormationConstructionRate, coalesce(VIR_PlanetProduction.PlanetCommanderConstructionBonus, 1.0) as ActualPlanetCommanderConstructionBonus, coalesce(VIR_PlanetProduction.PlanetCommanderShipbuildingBonus, 1.0) as ActualPlanetCommanderShipbuildingBonus, coalesce(VIR_PlanetProduction.PlanetCommanderGroundUnitBonus, 1.0) as ActualPlanetCommanderGroundUnitBonus, coalesce(VIR_SectorProduction.SectorCommanderConstructionBonus, 1.0) as ActualSectorCommanderConstructionBonus, coalesce(VIR_SectorProduction.SectorCommanderShipbuildingBonus, 1.0) as ActualSectorCommanderShipbuildingBonus, coalesce(VIR_SectorProduction.SectorCommanderGroundUnitBonus, 1.0) as ActualSectorCommanderGroundUnitBonus, FCT_Species.ProductionRateModifier, FCT_Species.ResearchRateModifier, FCT_Race.EconomicProdModifier, FCT_Race.ShipyardOperations, FCT_Population.Efficiency, (1 - (FCT_SystemBody.RadiationLevel / 10000)) as RadiationProductionModifier, (1 - (FCT_Population.UnrestPoints / 100)) as PoliticalStability, DIM_PopPoliticalStatus.ProductionMod, coalesce(VIR_InstallationProduction.ConstructionPower, 0) as ConstructionPower, coalesce(VIR_InstallationProduction.OrdnanceProductionPower, 0) as OrdnanceProductionPower, coalesce(VIR_InstallationProduction.FighterProductionPower, 0) as FighterProductionPower, coalesce(VIR_GroundPopulationConstruction.GroundConstructionPower, 0) as GroundConstructionPower from FCT_Population left join (select VIR_CommanderBonuses.CommandID, VIR_CommanderBonuses.ConstructionBonus as PlanetCommanderConstructionBonus, VIR_CommanderBonuses.ShipbuildingBonus as PlanetCommanderShipbuildingBonus, VIR_CommanderBonuses.GroundUnitBonus as PlanetCommanderGroundUnitBonus from VIR_CommanderBonuses where VIR_CommanderBonuses.CommandType = 3) as VIR_PlanetProduction on VIR_PlanetProduction.CommandID = FCT_Population.PopulationID left join (select VIR_RacePopulations.PopulationID, 1 + (COALESCE(VIR_CommanderBonuses.ConstructionBonus, 1) - 1) * 0.25 as SectorCommanderConstructionBonus, 1 + (COALESCE(VIR_CommanderBonuses.ShipbuildingBonus, 1) - 1) * 0.25 as SectorCommanderShipbuildingBonus, 1 + (COALESCE(VIR_CommanderBonuses.GroundUnitBonus, 1) - 1) * 0.25 as SectorCommanderGroundUnitBonus from VIR_CommanderBonuses inner join FCT_RaceSysSurvey on VIR_CommanderBonuses.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 inner join VIR_RacePopulations on FCT_RaceSysSurvey.SystemID = VIR_RacePopulations.SystemID where VIR_CommanderBonuses.CommandType = 4) as VIR_SectorProduction on VIR_SectorProduction.PopulationID = FCT_Population.PopulationID left join (select FCT_PopulationInstallations.PopID, SUM(DIM_PlanetaryInstallation.ConstructionValue * FCT_PopulationInstallations.Amount) as ConstructionPower, SUM(DIM_PlanetaryInstallation.OrdnanceProductionValue * FCT_PopulationInstallations.Amount) as OrdnanceProductionPower, SUM(DIM_PlanetaryInstallation.FighterProductionValue * FCT_PopulationInstallations.Amount) as FighterProductionPower from DIM_PlanetaryInstallation left join FCT_PopulationInstallations on FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID group by FCT_PopulationInstallations.PopID) as VIR_InstallationProduction on VIR_InstallationProduction.PopID = FCT_Population.PopulationID left join (select FCT_GroundUnitFormation.PopulationID, SUM(VIR_FormationConstruction.FormationConstructionRating * COALESCE(FCT_CommanderBonuses.BonusValue, 1)) as GroundConstructionPower from FCT_GroundUnitFormation left join (select FCT_GroundUnitFormationElement.FormationID, SUM(FCT_GroundUnitFormationElement.Units * FCT_GroundUnitClass.ConstructionRating) as FormationConstructionRating from FCT_GroundUnitFormationElement left join FCT_GroundUnitClass on FCT_GroundUnitFormationElement.ClassID = FCT_GroundUnitClass.GroundUnitClassID where FCT_GroundUnitFormationElement.FormationID in (select FCT_GroundUnitFormation.FormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.PopulationID in (select VIR_RacePopulations.PopulationID from VIR_RacePopulations)) group by FCT_GroundUnitFormationElement.FormationID) as VIR_FormationConstruction on FCT_GroundUnitFormation.FormationID = VIR_FormationConstruction.FormationID left join FCT_Commander on FCT_Commander.CommandID = FCT_GroundUnitFormation.FormationID and FCT_Commander.CommanderType in (1,4) and FCT_Commander.CommandType = 5 left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 5 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_GroundUnitFormation.PopulationID in (select VIR_RacePopulations.PopulationID from VIR_RacePopulations) group by FCT_GroundUnitFormation.PopulationID) as VIR_GroundPopulationConstruction on VIR_GroundPopulationConstruction.PopulationID = FCT_Population.PopulationID left join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join DIM_PopPoliticalStatus on FCT_Population.PoliticalStatus = DIM_PopPoliticalStatus.StatusID left join FCT_Game on FCT_Population.GameID = FCT_Game.GameID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}) as VIR_PopulationModifiers left join FCT_SystemBody on VIR_PopulationModifiers.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and VIR_PopulationModifiers.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on VIR_PopulationModifiers.SystemID = FCT_RaceSysSurvey.SystemID and VIR_PopulationModifiers.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID`)

        return modifiers.reduce((map, modifier) => {
          map[modifier.PopulationID] = gateModifier(modifier, blocked)

          return map
        }, {})
      }),
      default: {},
    },
  },
}
