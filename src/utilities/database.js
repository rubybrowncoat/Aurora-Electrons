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
    modelName: 'game',
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
    modelName: 'race',
    tableName: 'FCT_Race',
    timestamps: false,
  })

  Game.hasMany(Race, { foreignKey: 'GameID', sourceKey: 'GameID', as: 'Races' })
  // Race.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID', as: 'Game' })

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
    modelName: 'techSystem',
    tableName: 'FCT_TechSystem',
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
    modelName: 'planetaryInstallation',
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

  return sequelize
}
