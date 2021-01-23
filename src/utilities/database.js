import Sequelize, { Model } from 'sequelize'

import dayjs from 'dayjs'

export const resetDatabase = (storagePath) => {
  console.log('## RESETTING ON', storagePath)

  const sequelize = new Sequelize({
    dialect: 'sqlite',
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
    GameTime: Sequelize.FLOAT,

    CivilianShippingLinesActive: Sequelize.BOOLEAN,

    DateTime: {
      type: Sequelize.VIRTUAL,
      get() {
        return dayjs(0).set('year', this.StartYear).set('hour', 0).add(this.GameTime, 'second').format('YYYY-MM-DD HH:mm:ss')
      },
      set(value) {
        throw new Error('Do not try to set the `Date` value!')
      }
    }
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
    RaceTitle: Sequelize.STRING,
    NPR: Sequelize.BOOLEAN,
    ConventionalStart: Sequelize.BOOLEAN,
    WealthPoints: Sequelize.FLOAT,
  }, {
    sequelize,
    modelName: 'Race',
    tableName: 'FCT_Race',
    timestamps: false,

    defaultScope: {
      where: {
        NPR: false,
      },
    },
  })

  class TechSystem extends Model {}
  TechSystem.init({ // INCOMPLETE
    TechSystemID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    Name: Sequelize.STRING,
    ComponentName: Sequelize.STRING,
    AdditionalInfo: Sequelize.FLOAT,
    AdditionalInfo2: Sequelize.FLOAT,
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
    Capital: Sequelize.BOOLEAN,
    Population: Sequelize.REAL,
  }, {
    sequelize,
    modelName: 'Population',
    tableName: 'FCT_Population',
    timestamps: false,
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
    GameID: Sequelize.INTEGER,
    SystemID: Sequelize.INTEGER,
    StarID: Sequelize.INTEGER,
    ParentBodyID: Sequelize.INTEGER,
    BodyTypeID: Sequelize.INTEGER,
    HydroID: Sequelize.INTEGER,
    RuinID: Sequelize.INTEGER,
    RuinRaceID: Sequelize.INTEGER,
    AsteroidBeltID: Sequelize.INTEGER,

    Name: Sequelize.TEXT,
    PlanetNumber: Sequelize.INTEGER,
    OrbitNumber: Sequelize.INTEGER,
    TrojanAsteroid: Sequelize.DOUBLE,
    OrbitalDistance: Sequelize.DOUBLE,
    CurrentDistance: Sequelize.DOUBLE,
    HeadingInward: Sequelize.BOOLEAN,
    Bearing: Sequelize.DOUBLE,
    BodyClass: Sequelize.INTEGER,
    Density: Sequelize.DOUBLE,
    Radius: Sequelize.INTEGER,
    Gravity: Sequelize.DOUBLE,
    ParentBodyType: Sequelize.INTEGER,
    Mass: Sequelize.DOUBLE,
    EscapeVelocity: Sequelize.DOUBLE,
    Year: Sequelize.DOUBLE,
    TidalForce: Sequelize.DOUBLE,
    TidalLock: Sequelize.BOOLEAN,
    Tilt: Sequelize.INTEGER,
    Eccentricity: Sequelize.DOUBLE,
    DayValue: Sequelize.DOUBLE,
    Roche: Sequelize.DOUBLE,
    TectonicActivity: Sequelize.INTEGER,
    Ring: Sequelize.BOOLEAN,
    MagneticField: Sequelize.DOUBLE,
    BaseTemp: Sequelize.DOUBLE,
    SurfaceTemp: Sequelize.DOUBLE,
    HydroExt: Sequelize.DOUBLE,
    AtmosPress: Sequelize.DOUBLE,
    Albedo: Sequelize.DOUBLE,
    GHFactor: Sequelize.DOUBLE,
    RGE: Sequelize.BOOLEAN,
    Xcor: Sequelize.DOUBLE,
    Ycor: Sequelize.DOUBLE,
    PlanetIcon: Sequelize.TEXT,
    RadiationLevel: Sequelize.DOUBLE,
    DustLevel: Sequelize.DOUBLE,
    AbandonedFactories: Sequelize.INTEGER,
    DominantTerrain: Sequelize.INTEGER,
    GroundMineralSurvey: Sequelize.INTEGER,
    AGHFactor: Sequelize.DOUBLE,
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

  class PlanetaryInstallation extends Model {}
  PlanetaryInstallation.init({ // INCOMPLETE
    PlanetaryInstallationID: {
      type: Sequelize.INTEGER,
      primaryKey: true
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

    defaultScope: {
      order: [['DisplayOrder', 'DESC']]
    },
    
    scopes: {
      civilianEconomy: {
        where: {
          CivMove: true,
        },
      },
    }
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


  // Relations
  Game.hasMany(Race, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Game.hasMany(AncientConstruct, { foreignKey: 'GameID', sourceKey: 'GameID' })

  Race.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Race.hasMany(Population, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Race.hasMany(RaceSystemSurvey, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Race.hasMany(SystemBodyName, { foreignKey: 'RaceID', sourceKey: 'RaceID' })

  Population.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Population.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  Population.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })

  System.hasMany(Population, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(SystemBody, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(RaceSystemSurvey, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  System.hasMany(Star, { foreignKey: 'SystemID', sourceKey: 'SystemID' })

  RaceSystemSurvey.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  RaceSystemSurvey.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })

  Star.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  Star.hasMany(SystemBody, { foreignKey: 'StarID', sourceKey: 'StarID' })

  SystemBody.belongsTo(System, { foreignKey: 'SystemID', sourceKey: 'SystemID' })
  SystemBody.hasMany(Population, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.hasMany(AncientConstruct, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.hasMany(SystemBodyName, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  SystemBody.belongsTo(Star, { foreignKey: 'StarID', sourceKey: 'StarID' })

  SystemBodyName.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  SystemBodyName.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })

  AncientConstruct.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  AncientConstruct.belongsTo(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })
  AncientConstruct.belongsTo(ResearchField, { foreignKey: 'ResearchFieldID', sourceKey: 'ResearchFieldID' })

  ResearchField.hasMany(AncientConstruct, { foreignKey: 'ResearchFieldID', sourceKey: 'ResearchFieldID' })

  return sequelize
}
