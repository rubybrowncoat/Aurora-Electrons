import Sequelize, { Model } from 'sequelize'

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

  return sequelize
}
