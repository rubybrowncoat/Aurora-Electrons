import { Model, Sequelize } from 'sequelize'
// import sqlite3 from 'sqlite3'

import { gameTime } from './aurora'

export const resetDatabase = (storagePath) => {
  console.log('## RESETTING ON', storagePath)

  const sequelize = new Sequelize({
    dialect: 'sqlite',
    // dialectModule: sqlite3,

    storage: storagePath,
  })

  class Game extends Model {}
  Game.init({ // INCOMPLETE
    GameID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    DefaultRaceID: Sequelize.INTEGER,
    GameName: Sequelize.STRING,

    StartYear: Sequelize.INTEGER,
    GameTime: Sequelize.DOUBLE,

    CivilianShippingLinesActive: Sequelize.BOOLEAN,

    DateTime: {
      type: Sequelize.VIRTUAL,
      get () {
        return gameTime(this.StartYear, this.GameTime).format('YYYY-MM-DD HH:mm:ss')
      },
      set (_value) {
        throw new Error('Do not try to set the `Date` value!')
      },
    },
  }, {
    sequelize,
    modelName: 'Game',
    tableName: 'FCT_Game',
    timestamps: false,
  })

  class Race extends Model {}
  Race.init({ // INCOMPLETE
    RaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    GameID: Sequelize.INTEGER,
    RaceName: Sequelize.TEXT,
    RaceTitle: Sequelize.TEXT,
    NPR: Sequelize.BOOLEAN,
    SpecialNPRID: Sequelize.INTEGER,
    WealthPoints: Sequelize.REAL,
    PreviousWealth: Sequelize.REAL,
    StartingWealth: Sequelize.REAL,
    AnnualWealth: Sequelize.REAL,
    WealthCreationRate: Sequelize.REAL,

    RaceStartingLevel: Sequelize.INTEGER,
  }, {
    sequelize,
    modelName: 'Race',
    tableName: 'FCT_Race',
    timestamps: false,
  })

  class LogEventType extends Model {}
  LogEventType.init({
    EventTypeID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    Description: Sequelize.TEXT,
    CombatDisplay: Sequelize.INTEGER,
    DamageDisplay: Sequelize.INTEGER,
    AttackEvent: Sequelize.BOOLEAN,
    PlayerInterrupt: Sequelize.BOOLEAN,
    AIInterrupt: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'LogEventType',
    tableName: 'DIM_EventType',
    timestamps: false,
  })

  class LogEventColour extends Model {}
  LogEventColour.init({
    EventTypeID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    RaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    GameID: Sequelize.INTEGER,
    AlertColour: Sequelize.INTEGER,
    TextColour: Sequelize.INTEGER,
  }, {
    sequelize,
    modelName: 'LogEventColour',
    tableName: 'FCT_EventColour',
    timestamps: false,
  })

  class LogEvent extends Model {}
  LogEvent.init({
    GameID: Sequelize.INTEGER,
    RaceID: Sequelize.INTEGER,
    IncrementID: Sequelize.INTEGER,
    SMOnly: Sequelize.BOOLEAN,
    Time: Sequelize.DOUBLE,
    EventType: Sequelize.INTEGER,
    MessageText: Sequelize.TEXT,
    SystemID: Sequelize.INTEGER,
    Xcor: Sequelize.DOUBLE,
    Ycor: Sequelize.DOUBLE,
    IDType: Sequelize.INTEGER,
    PopulationID: Sequelize.INTEGER,
  }, {
    sequelize,
    modelName: 'LogEvent',
    tableName: 'FCT_GameLog',
    timestamps: false,
  })
  LogEvent.removeAttribute('id')

  class AlienRace extends Model {}
  AlienRace.init({
    AlienRaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    ViewRaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    GameID: Sequelize.INTEGER,

    AlienRaceName: Sequelize.TEXT,
    Abbrev: Sequelize.TEXT,

    FixedRelationship: Sequelize.INTEGER,
    ContactStatus: Sequelize.INTEGER,
    CommStatus: Sequelize.INTEGER,
    CommModifier: Sequelize.DOUBLE,
    TradeTreaty: Sequelize.BOOLEAN,
    TechTreaty: Sequelize.BOOLEAN,
    GeoTreaty: Sequelize.BOOLEAN,
    GravTreaty: Sequelize.BOOLEAN,

    ClassThemeID: Sequelize.INTEGER,
    RealClassNames: Sequelize.INTEGER,

    DiplomaticPoints: Sequelize.DOUBLE,
    AlienRaceIntelligencePoints: Sequelize.DOUBLE,

    FirstDetected: Sequelize.DOUBLE,
    CommEstablished: Sequelize.DOUBLE,
  }, {
    sequelize,
    modelName: 'AlienRace',
    tableName: 'FCT_AlienRace',
    timestamps: false,
  })

  class TechSystem extends Model {}
  TechSystem.init({ // INCOMPLETE
    TechSystemID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    GameID: Sequelize.INTEGER,
    RaceID: Sequelize.INTEGER,
    CategoryID: Sequelize.INTEGER,
    TechTypeID: Sequelize.INTEGER,

    Name: Sequelize.TEXT,
    ComponentName: Sequelize.TEXT,
    TechDescription: Sequelize.TEXT,
    DevelopCost: Sequelize.INTEGER,
    AdditionalInfo: Sequelize.DOUBLE,
    AdditionalInfo2: Sequelize.DOUBLE,
    AdditionalInfo3: Sequelize.DOUBLE,
    AdditionalInfo4: Sequelize.DOUBLE,
    Prerequisite1: Sequelize.INTEGER,
    Prerequisite2: Sequelize.INTEGER,
    NoTechScan: Sequelize.BOOLEAN,
    RuinOnly: Sequelize.BOOLEAN,
    AutomaticResearch: Sequelize.BOOLEAN,
    StartingSystem: Sequelize.BOOLEAN,
    ConventionalSystem: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'TechSystem',
    tableName: 'FCT_TechSystem',
    timestamps: false,
  })

  class Population extends Model {}
  Population.init({ // INCOMPLETE
    PopulationID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
    RaceID: Sequelize.INTEGER,
    OriginalRaceID: Sequelize.INTEGER,
    SystemID: Sequelize.INTEGER,
    SystemBodyID: Sequelize.INTEGER,
    TerraformingGasID: Sequelize.INTEGER,
    GroundAttackID: Sequelize.INTEGER,
    SpeciesID: Sequelize.INTEGER,
    GenModSpeciesID: Sequelize.INTEGER,
    FighterDestFleetID: Sequelize.INTEGER,
    SpaceStationDestFleetID: Sequelize.INTEGER,

    //
    PopName: Sequelize.TEXT,
    AcademyOfficers: Sequelize.REAL,
    Capital: Sequelize.BOOLEAN,
    TerraformStatus: Sequelize.INTEGER,
    PurchaseCivilianMinerals: Sequelize.NUMBER,

    // OUT OF ORDER
    FuelStockpile: Sequelize.REAL,
    MaintenanceStockpile: Sequelize.REAL,
    Population: Sequelize.REAL,
    Duranium: Sequelize.REAL,
    Neutronium: Sequelize.REAL,
    Corbomite: Sequelize.REAL,
    Tritanium: Sequelize.REAL,
    Boronide: Sequelize.REAL,
    Mercassium: Sequelize.REAL,
    Vendarite: Sequelize.REAL,
    Sorium: Sequelize.REAL,
    Uridium: Sequelize.REAL,
    Corundium: Sequelize.REAL,
    Gallicite: Sequelize.REAL,
  }, {
    sequelize,
    modelName: 'Population',
    tableName: 'FCT_Population',
    timestamps: false,
  })

  class PopulationInstallation extends Model {}
  PopulationInstallation.init({
    GameID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    PopID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    PlanetaryInstallationID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    Amount: Sequelize.DOUBLE,
  }, {
    sequelize,
    modelName: 'PopulationInstallation',
    tableName: 'FCT_PopulationInstallations',
    timestamps: false,
  })

  class PlanetaryInstallation extends Model {}
  PlanetaryInstallation.init({ // INCOMPLETE
    PlanetaryInstallationID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    Name: Sequelize.STRING,
    CargoPoints: Sequelize.INTEGER,
    CivMove: Sequelize.BOOLEAN,
    DisplayOrder: Sequelize.FLOAT,
  }, {
    sequelize,
    modelName: 'PlanetaryInstallation',
    tableName: 'DIM_PlanetaryInstallation',
    timestamps: false,

    scopes: {
      civilianEconomy: {
        where: {
          CivMove: true,
        },
      },
    },
  })

  class System extends Model {}
  System.init({
    SystemID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
    SystemTypeID: Sequelize.INTEGER,

    SystemNumber: Sequelize.INTEGER,
    Age: Sequelize.DOUBLE,
    AbundanceModifier: Sequelize.INTEGER,
    StarCount: {
      field: 'Stars',
      type: Sequelize.INTEGER,
    },
    JumpPointSurveyPoints: Sequelize.INTEGER,
    DustDensity: Sequelize.INTEGER,
    SolSystem: Sequelize.NUMBER,
    NoSensorChecks: Sequelize.INTEGER,
  }, {
    sequelize,
    modelName: 'System',
    tableName: 'FCT_System',
    timestamps: false,
  })

  class RaceSystemSurvey extends Model {}
  RaceSystemSurvey.init({
    RaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    SystemID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
    ControlRaceID: Sequelize.INTEGER,
    ForeignFleetRaceID: Sequelize.INTEGER,
    SectorID: Sequelize.INTEGER,
    NameThemeID: Sequelize.INTEGER,

    Name: Sequelize.TEXT,
    DangerRating: Sequelize.INTEGER,
    SysTPStatus: Sequelize.BOOLEAN,
    Discovered: Sequelize.TEXT,
    Xcor: Sequelize.INTEGER,
    Ycor: Sequelize.INTEGER,
    ClosedWP: Sequelize.INTEGER,
    SurveyDone: Sequelize.BOOLEAN,
    SelectedBodyXcor: Sequelize.DOUBLE,
    SelectedBodyYcor: Sequelize.DOUBLE,
    KmPerPixel: Sequelize.DOUBLE,
    GeoSurveyDefaultDone: Sequelize.BOOLEAN,
    DiscoveredTime: Sequelize.DOUBLE,
    NoAutoRoute: Sequelize.BOOLEAN,
    MilitaryRestrictedSystem: Sequelize.BOOLEAN,
    SystemValue: Sequelize.INTEGER,
    AutoProtectionStatus: Sequelize.INTEGER,
    MineralSearchFlag: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'RaceSystemSurvey',
    tableName: 'FCT_RaceSysSurvey',
    timestamps: false,
  })

  class Star extends Model {}
  Star.init({
    StarID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
    SystemID: Sequelize.INTEGER,
    StarTypeID: Sequelize.INTEGER,

    Name: Sequelize.TEXT,
    Protostar: Sequelize.INTEGER,
    Xcor: Sequelize.DOUBLE,
    Ycor: Sequelize.DOUBLE,
    Component: Sequelize.INTEGER,
    OrbitingComponent: Sequelize.INTEGER,
    Bearing: Sequelize.DOUBLE,
    Luminosity: Sequelize.DOUBLE,
    OrbitalPeriod: Sequelize.DOUBLE,
    OrbitalDistance: Sequelize.DOUBLE,
    DisasterStatus: Sequelize.INTEGER,
    Eccentricity: Sequelize.DOUBLE,
    EccentricityDirection: Sequelize.DOUBLE,
    MeanOrbitalSpeed: Sequelize.DOUBLE,
    DistanceToOrbitCentre: Sequelize.DOUBLE,
    DistanceToParent: Sequelize.DOUBLE,
    CurrentOrbitalSpeed: Sequelize.DOUBLE,
  }, {
    sequelize,
    modelName: 'Star',
    tableName: 'FCT_Star',
    timestamps: false,
  })

  class SystemBody extends Model {}
  SystemBody.init({
    SystemBodyID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER, //
    SystemID: Sequelize.INTEGER, //
    StarID: Sequelize.INTEGER, //
    ParentBodyID: Sequelize.INTEGER, //
    BodyTypeID: Sequelize.INTEGER, //
    HydroID: Sequelize.INTEGER, //
    RuinID: Sequelize.INTEGER, //
    RuinRaceID: Sequelize.INTEGER, //
    AsteroidBeltID: Sequelize.INTEGER, //
    FixedBodyParentID: Sequelize.INTEGER, //

    Name: Sequelize.TEXT, //
    PlanetNumber: Sequelize.INTEGER, //
    OrbitNumber: Sequelize.INTEGER, //
    TrojanAsteroid: Sequelize.DOUBLE, //
    OrbitalDistance: Sequelize.DOUBLE, //
    Bearing: Sequelize.DOUBLE, //
    BodyClass: Sequelize.INTEGER, //
    // Density: Sequelize.DOUBLE, ??? REPLACED BY WHAT? Radius and Mass?
    Radius: Sequelize.INTEGER, //
    Gravity: Sequelize.DOUBLE, //
    ParentBodyType: Sequelize.INTEGER, //
    Mass: Sequelize.DOUBLE, //
    EscapeVelocity: Sequelize.DOUBLE, //
    Year: Sequelize.DOUBLE, //
    TidalForce: Sequelize.DOUBLE, //
    TidalLock: Sequelize.BOOLEAN, //
    Tilt: Sequelize.INTEGER, //
    Eccentricity: Sequelize.DOUBLE, //
    EccentricityDirection: Sequelize.DOUBLE, // Maybe replaces HeadingInward
    MeanOrbitalSpeed: Sequelize.DOUBLE, //
    CurrentOrbitalSpeed: Sequelize.DOUBLE, //
    DistanceToOrbitCentre: Sequelize.DOUBLE, //
    DistanceToParent: Sequelize.DOUBLE, // Maybe replaces CurrentDistance
    DayValue: Sequelize.DOUBLE, //
    Roche: Sequelize.DOUBLE, //
    TectonicActivity: Sequelize.INTEGER, //
    Ring: Sequelize.BOOLEAN, //
    MagneticField: Sequelize.DOUBLE, //
    BaseTemp: Sequelize.DOUBLE, //
    SurfaceTemp: Sequelize.DOUBLE, //
    HydroExt: Sequelize.DOUBLE, //
    AtmosPress: Sequelize.DOUBLE, //
    Albedo: Sequelize.DOUBLE, //
    GHFactor: Sequelize.DOUBLE, //
    RGE: Sequelize.BOOLEAN, //
    Xcor: Sequelize.DOUBLE, //
    Ycor: Sequelize.DOUBLE, //
    PlanetIcon: Sequelize.TEXT, //
    RadiationLevel: Sequelize.DOUBLE, //
    DustLevel: Sequelize.DOUBLE, //
    AbandonedFactories: Sequelize.INTEGER, //
    DominantTerrain: Sequelize.INTEGER, //
    GroundMineralSurvey: Sequelize.INTEGER, //
    AGHFactor: Sequelize.DOUBLE, //
    FixedBody: Sequelize.BOOLEAN, //
  }, {
    sequelize,
    modelName: 'SystemBody',
    tableName: 'FCT_SystemBody',
    timestamps: false,
  })

  class SystemBodyName extends Model {}
  SystemBodyName.init({
    RaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    SystemBodyID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
    SystemID: Sequelize.INTEGER,

    Name: Sequelize.TEXT,
  }, {
    sequelize,
    modelName: 'SystemBodyName',
    tableName: 'FCT_SystemBodyName',
    timestamps: false,
  })

  class SystemBodySurvey extends Model {}
  SystemBodySurvey.init({
    RaceID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    SystemBodyID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
  }, {
    sequelize,
    modelName: 'SystemBodySurvey',
    tableName: 'FCT_SystemBodySurveys',
    timestamps: false,
  })

  class Fleet extends Model {}
  Fleet.init({ // INCOMPLETE
    FleetID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER, //
    RaceID: Sequelize.INTEGER, //
    SystemID: Sequelize.INTEGER, //
    OrbitBodyID: Sequelize.INTEGER, //
    ParentCommandID: Sequelize.INTEGER, //
    AssignedPopulationID: Sequelize.INTEGER, //
    // SpecialOrderID: Sequelize.INTEGER,
    // SpecialOrderID2: Sequelize.INTEGER,
    EntryJPID: Sequelize.INTEGER, //
    AxisContactID: Sequelize.INTEGER, //
    NPROperationalGroupID: Sequelize.INTEGER, //
    AssignedFormationID: Sequelize.INTEGER, //
    SpecificThreatID: Sequelize.INTEGER, //
    AnchorFleetID: Sequelize.INTEGER, //

    FleetName: Sequelize.TEXT, //
    OrbitDistance: Sequelize.INTEGER, //
    OrbitBearing: Sequelize.DOUBLE, //
    TradeLocation: Sequelize.INTEGER, //
    CivilianFunction: Sequelize.INTEGER, //
    NPRHomeGuard: Sequelize.BOOLEAN, //
    TFTraining: Sequelize.BOOLEAN, //
    Speed: Sequelize.INTEGER, //
    MaxNebulaSpeed: Sequelize.INTEGER, //
    Xcor: Sequelize.DOUBLE, //
    Ycor: Sequelize.DOUBLE, //
    LastXcor: Sequelize.DOUBLE, //
    LastYcor: Sequelize.DOUBLE, //
    LastMoveTime: Sequelize.DOUBLE, //
    IncrementStartX: Sequelize.DOUBLE, //
    IncrementStartY: Sequelize.DOUBLE, //
    CycleMoves: Sequelize.INTEGER, //
    JustDivided: Sequelize.INTEGER, //
    Distance: Sequelize.INTEGER, //
    OffsetBearing: Sequelize.INTEGER, //
    ConditionOne: Sequelize.INTEGER, //
    ConditionTwo: Sequelize.INTEGER, //
    ConditionalOrderOne: Sequelize.INTEGER, //
    ConditionalOrderTwo: Sequelize.INTEGER, //
    AvoidDanger: Sequelize.BOOLEAN, //
    AvoidAlienSystems: Sequelize.BOOLEAN, //
    DisplaySensors: Sequelize.BOOLEAN, //
    DisplayWeapons: Sequelize.BOOLEAN, //
    ShippingLine: Sequelize.INTEGER, //
    UseMaximumSpeed: Sequelize.BOOLEAN, //
    RedeployOrderGiven: Sequelize.BOOLEAN, //
    MaxStandingOrderDistance: Sequelize.INTEGER, //
    NoSurrender: Sequelize.BOOLEAN, //
    AnchorFleetDistance: Sequelize.DOUBLE, //
    AnchorFleetBearingOffset: Sequelize.DOUBLE, //
    GuardNearestHostileContact: Sequelize.BOOLEAN, //
    UseAnchorDestination: Sequelize.BOOLEAN, //
    GuardNearestKnownWarship: Sequelize.BOOLEAN, //
  }, {
    sequelize,
    modelName: 'Fleet',
    tableName: 'FCT_Fleet',
    timestamps: false,
  })

  class GroundUnitFormation extends Model {}
  GroundUnitFormation.init({
    FormationID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    GameID: Sequelize.INTEGER,
    RaceID: Sequelize.INTEGER,
    PopulationID: Sequelize.INTEGER,
    ShipID: Sequelize.INTEGER,
    ParentFormationID: Sequelize.INTEGER,
    AssignedFormationID: Sequelize.INTEGER,
    OriginalTemplateID: Sequelize.INTEGER,
    ReplacementTemplateID: Sequelize.INTEGER,
    OrgLinkID: Sequelize.INTEGER,

    Name: Sequelize.TEXT,
    Abbreviation: Sequelize.TEXT,
    BoardingStatus: Sequelize.INTEGER,
    HideSubUnits: Sequelize.BOOLEAN,
    FieldPosition: Sequelize.INTEGER,
    RequiredRank: Sequelize.INTEGER,
    ActiveSensorsOn: Sequelize.BOOLEAN,
    Civilian: Sequelize.BOOLEAN,
    UseForReplacements: Sequelize.BOOLEAN,
    ReplacementPriority: Sequelize.INTEGER,
    DoNotRecover: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'GroundUnitFormation',
    tableName: 'FCT_GroundUnitFormation',
    timestamps: false,
  })

  class ResearchField extends Model {}
  ResearchField.init({ // INCOMPLETE
    ResearchFieldID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    FieldName: Sequelize.TEXT,
    ShortName: Sequelize.TEXT,
    Abbreviation: Sequelize.TEXT,

    DoNotDisplay: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'ResearchField',
    tableName: 'DIM_ResearchField',
    timestamps: false,
  })

  class AncientConstruct extends Model {}
  AncientConstruct.init({ // INCOMPLETE
    AncientConstructID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    // Direct Relationships
    GameID: Sequelize.INTEGER,
    SystemBodyID: Sequelize.INTEGER,
    AncientConstructTypeID: Sequelize.INTEGER,
    ResearchFieldID: {
      field: 'ResearchField',
      type: Sequelize.INTEGER,
    },

    ResearchBonus: Sequelize.DOUBLE,
    Active: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'AncientConstruct',
    tableName: 'FCT_AncientConstruct',
    timestamps: false,
  })

  class AetherRift extends Model {}
  AetherRift.init({
    // Direct Relationships
    GameID: Sequelize.INTEGER,
    SystemID: Sequelize.INTEGER,

    Xcor: Sequelize.DOUBLE,
    Ycor: Sequelize.DOUBLE,
    Diameter: Sequelize.DOUBLE,
  }, {
    sequelize,
    modelName: 'AetherRift',
    tableName: 'FCT_AetherRift',
    timestamps: false,
  })
  AetherRift.removeAttribute('id')

  class Contact extends Model {}
  Contact.init({
    UniqueID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    ContactID: Sequelize.INTEGER,

    GameID: Sequelize.INTEGER,
    SystemID: Sequelize.INTEGER,

    DetectRaceID: Sequelize.INTEGER,
    ContactRaceID: Sequelize.INTEGER,

    ContactName: Sequelize.TEXT,
    ContactMethod: Sequelize.INTEGER,
    ContactType: Sequelize.INTEGER,
    ContactStrength: Sequelize.DOUBLE,
    ContactNumber: Sequelize.INTEGER,
    Resolution: Sequelize.INTEGER,
    Speed: Sequelize.INTEGER,

    CreationTime: Sequelize.DOUBLE,
    Reestablished: Sequelize.DOUBLE,
    LastUpdate: Sequelize.DOUBLE,
    ContinualContactTime: Sequelize.INTEGER,

    Xcor: Sequelize.DOUBLE,
    Ycor: Sequelize.DOUBLE,
    LastXcor: Sequelize.DOUBLE,
    LastYcor: Sequelize.DOUBLE,
    IncrementStartX: Sequelize.DOUBLE,
    IncrementStartY: Sequelize.DOUBLE,

    Msg: Sequelize.BOOLEAN,
  }, {
    sequelize,
    modelName: 'Contact',
    tableName: 'FCT_Contacts',
    timestamps: false,
  })

  // Relations
  Game.hasMany(Race, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Game.hasMany(AncientConstruct, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Game.hasMany(AetherRift, { foreignKey: 'GameID', sourceKey: 'GameID' })

  Race.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Race.hasMany(Population, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Race.hasMany(RaceSystemSurvey, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Race.hasMany(SystemBodyName, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Race.hasMany(SystemBodySurvey, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Race.hasMany(Fleet, { foreignKey: 'RaceID' })
  Race.hasMany(GroundUnitFormation, { foreignKey: 'RaceID' })
  Race.hasMany(AlienRace, { foreignKey: 'AlienRaceID' })

  LogEventType.hasMany(LogEvent, { foreignKey: 'EventType', sourceKey: 'EventTypeID' })
  LogEventType.hasMany(LogEventColour, { foreignKey: 'EventTypeID', sourceKey: 'EventTypeID' })

  LogEventColour.belongsTo(LogEventType, { foreignKey: 'EventTypeID', sourceKey: 'EventTypeID' })
  LogEventColour.belongsTo(Game, { foreignKey: 'GameID' })
  LogEventColour.belongsTo(Race, { foreignKey: 'RaceID' })

  LogEvent.belongsTo(LogEventType, { foreignKey: 'EventType', sourceKey: 'EventTypeID' })
  LogEvent.belongsTo(Game, { foreignKey: 'GameID' })
  LogEvent.belongsTo(Race, { foreignKey: 'RaceID' })
  LogEvent.belongsTo(Population, { foreignKey: 'PopulationID', sourceKey: 'PopulationID' })
  LogEvent.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })

  AlienRace.belongsTo(Game, { foreignKey: 'GameID' })
  AlienRace.belongsTo(Race, { foreignKey: 'AlienRaceID' })
  AlienRace.belongsTo(Race, { foreignKey: 'ViewRaceID', as: 'ViewRace' })

  Population.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Population.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  Population.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  Population.hasMany(PopulationInstallation, { foreignKey: 'PopID' })
  Population.hasMany(GroundUnitFormation, { foreignKey: 'PopulationID' })
  Population.hasMany(Contact, {
    foreignKey: 'ContactID',
    scope: {
      ContactType: 4,
    },
  })

  PopulationInstallation.belongsTo(Population, { foreignKey: 'PopID' })
  PopulationInstallation.belongsTo(PlanetaryInstallation, { foreignKey: 'PlanetaryInstallationID', sourceKey: 'PlanetaryInstallationID' })

  PlanetaryInstallation.hasMany(PopulationInstallation, { foreignKey: 'PlanetaryInstallationID', sourceKey: 'PlanetaryInstallationID' })

  System.hasMany(Population, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(SystemBody, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(RaceSystemSurvey, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(Star, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(Fleet, { foreignKey: 'SystemID' })
  System.hasMany(AetherRift, { foreignKey: 'SystemID', sourceKey: 'SystemID' })

  RaceSystemSurvey.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  RaceSystemSurvey.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })

  Star.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  Star.hasMany(SystemBody, { foreignKey: 'StarID', sourceKey: 'StarID' })

  SystemBody.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  SystemBody.hasMany(Population, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.hasMany(AncientConstruct, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.hasMany(SystemBodyName, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.hasMany(SystemBodySurvey, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.belongsTo(Star, { foreignKey: 'StarID', sourceKey: 'StarID' })
  SystemBody.hasMany(Fleet, { foreignKey: 'OrbitBodyID' })

  SystemBodyName.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  SystemBodyName.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })

  SystemBodySurvey.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  SystemBodySurvey.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })

  Fleet.belongsTo(Race, { foreignKey: 'RaceID' })
  Fleet.belongsTo(System, { foreignKey: 'SystemID' })
  Fleet.belongsTo(SystemBody, { foreignKey: 'OrbitBodyID' })

  GroundUnitFormation.belongsTo(Population, { foreignKey: 'PopulationID' })
  GroundUnitFormation.belongsTo(Race, { foreignKey: 'RaceID' })

  ResearchField.hasMany(AncientConstruct, { foreignKey: 'ResearchFieldID', sourceKey: 'ResearchFieldID' })

  AncientConstruct.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  AncientConstruct.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  AncientConstruct.belongsTo(ResearchField, { foreignKey: 'ResearchFieldID', sourceKey: 'ResearchFieldID' })

  AetherRift.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  AetherRift.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })

  Contact.belongsTo(Game, { foreignKey: 'GameID' })
  Contact.belongsTo(System, { foreignKey: 'SystemID' })
  Contact.belongsTo(Race, { foreignKey: 'DetectRaceID', as: 'DetectRace' })
  Contact.belongsTo(Race, { foreignKey: 'ContactRaceID', as: 'ContactRace' })

  Contact.belongsTo(Population, { foreignKey: 'ContactID' })
  Contact.addHook('afterFind', (results) => {
    console.log('makeContactVirtualProperty', results.length)

    if (!Array.isArray(results)) {
      results = [results]
    }

    for (const instance of results) {
      if (instance.ContactType === 4 && instance.Population !== undefined) {
        instance.Contact = instance.Population
      }

      delete instance.Population
      delete instance.dataValues.Population
    }
  }, 'makeContactVirtualProperty')

  return sequelize
}
