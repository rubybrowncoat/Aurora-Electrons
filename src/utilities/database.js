import Sequelize, { Model } from 'sequelize'

import dayjs from 'dayjs'

export const resetDatabase = (storagePath) => {
  console.log('## RESETTING ON', storagePath)

  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: storagePath,
  })

  class Game extends Model {}
  Game.init({
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
  Race.init({
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
  TechSystem.init({
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
  Population.init({ // TO COMPLETE
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
  }, {
    sequelize,
    modelName: 'Population',
    tableName: 'FCT_Population',
    timestamps: false,
  })

  class SystemBody extends Model {}
  SystemBody.init({ // TO COMPLETE
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
  }, {
    sequelize,
    modelName: 'SystemBody',
    tableName: 'FCT_SystemBody',
    timestamps: false,
  })

  class PlanetaryInstallation extends Model {}
  PlanetaryInstallation.init({
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

  // Relations
  Game.hasMany(Race, { foreignKey: 'GameID', sourceKey: 'GameID' })

  Race.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Race.hasMany(Population, { foreignKey: 'RaceID', sourceKey: 'RaceID' })

  Population.belongsTo(Race, { foreignKey: 'RaceID', sourceKey: 'RaceID' })
  Population.hasOne(SystemBody, { foreignKey: 'SystemBodyID', sourceKey: 'SystemBodyID' })

  return sequelize
}
