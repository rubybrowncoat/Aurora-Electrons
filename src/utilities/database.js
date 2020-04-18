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

  class TechSystem extends Model {}
  TechSystem.init({
    TechSystemID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },
    Name: Sequelize.STRING,
    ComponentName: Sequelize.STRING,
    AdditionalInfo: Sequelize.FLOAT,
  }, {
    sequelize,
    modelName: 'techSystem',
    tableName: 'FCT_TechSystem',
    timestamps: false,
  })

  return sequelize
}
