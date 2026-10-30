import { Model, Sequelize } from 'sequelize'
// import sqlite3 from 'sqlite3'

import { gameTime } from './aurora'
import { DatabaseRetired, isRetired } from './retired'

// A statement that outlives this has stopped being a read and become a stall: every page waits behind it.
export const QUERY_TIMEOUT_MS = 60000

// How long retiring a database waits for the statement running on it to settle before closing it anyway.
const RETIRE_SETTLE_MS = 5000

// SQLite's open flag for read and write without create (sqlite3's OPEN_READWRITE). Sequelize's default adds OPEN_CREATE, which turned a missing save path (a save deleted or moved while the app watched it) into a new empty file there. Writes stay possible for the Galaxy Map's Save Positions.
const OPEN_EXISTING = 0x2

const guards = new WeakMap()

// The statements that end a transaction. A transaction already begun on a retired database still gets them, so that it ends while the connection is open.
const ENDS_TRANSACTION = /^\s*(commit|rollback)\b/i

// Sequelize's SQLite dialect keeps one connection per instance, and SQLite runs that connection's statements one at a time, so a slow statement holds every later one, from every page, until it ends. Nothing in node-sqlite3 cancels a statement but `interrupt()`. This runs the instance's queries one at a time itself, so it knows which one is running: that one is interrupted and rejected once it passes QUERY_TIMEOUT_MS, and the queue moves on. A transaction's queries have a connection of their own and pass straight through while the database is current; once it is retired, a transaction's next statement is refused (`DatabaseRetired`) except the one that ends it, which runs while the connection is still open, and the retiring waits (bounded) for the open transactions to end before it closes anything.
const guardQueries = (sequelize) => {
  const query = sequelize.query.bind(sequelize)
  const waiting = []
  let running = false
  let retired = false
  let active = null
  const opening = new Set()
  const transactions = new Set()
  // The managed transactions that have not ended, and those the retiring ended itself: their own commit or rollback is then answered as retired without touching the connection, which is closed or about to be. `ending` are those being rolled back by the retiring.
  const open = new Set()
  const cancelled = new Set()
  const ending = new Set()
  // The retiring interrupts the statement that is running, and that statement ends with SQLite's interrupt code (read from the structured error, never its message). Once the database is retired, only that code is taken as the retiring's doing: the one other interrupter, the timeout below, rejects first. Every other error, whenever it arrives, is the save's own and passes on unchanged.
  const interrupted = (error) => [error && error.original, error && error.parent, error].some((source) => Boolean(source) && source.code === 'SQLITE_INTERRUPT')
  const asRetired = (error) => (retired && !isRetired(error) && interrupted(error) ? new DatabaseRetired(error) : error)
  const { connectionManager } = sequelize
  const getConnection = connectionManager.getConnection.bind(connectionManager)

  // Sequelize caches a connection before it has opened and keeps it when the open fails. Left there, the failed handle would answer every later read (each waiting out QUERY_TIMEOUT_MS) and close() would wait on it forever.
  Object.defineProperty(connectionManager, 'getConnection', {
    configurable: true,
    writable: true,
    value: (options) => {
      const before = new Set(Object.values(connectionManager.connections))
      const attempt = getConnection(options)
      const created = Object.entries(connectionManager.connections).find(([, handle]) => !before.has(handle))

      opening.add(attempt)
      attempt.then(() => opening.delete(attempt), () => {
        opening.delete(attempt)

        if (created && connectionManager.connections[created[0]] === created[1]) {
          delete connectionManager.connections[created[0]]
        }
      })

      return attempt
    },
  })

  // A connection that is still opening, or already closed, throws "Database is not open" and has nothing to interrupt.
  const interrupt = (everything) => {
    const { connections } = sequelize.connectionManager

    Object.keys(connections).filter((key) => everything || key === 'default').forEach((key) => {
      try {
        connections[key].interrupt()
      } catch (error) {
        // Nothing is running on it to interrupt.
      }
    })
  }

  const drain = () => {
    if (running || !waiting.length) {
      return
    }

    const { sql, options, resolve, reject } = waiting.shift()
    let finished = false
    // A timed-out statement still settles once interrupted; only the first finish may hand the queue on.
    const finish = () => {
      if (finished) {
        return
      }

      finished = true
      clearTimeout(timer)
      running = false
      drain()
    }
    const timer = setTimeout(() => {
      interrupt(false)
      // The statement names tables and columns, which a notice must not show: it goes to the console.
      console.error('The save took too long to answer a read', String(sql).replace(/\s+/g, ' ').slice(0, 120))
      reject(new Error(`The save took longer than ${QUERY_TIMEOUT_MS / 1000} s to answer and the read was stopped`))
      finish()
    }, QUERY_TIMEOUT_MS)

    running = true
    active = query(sql, options)
    active.then(resolve, (error) => reject(asRetired(error))).then(finish)
  }

  // Not enumerable: Vue would otherwise make the property reactive, and wrapping it again (the smoke test does) would count as the store state being mutated outside a mutation.
  Object.defineProperty(sequelize, 'query', {
    configurable: true,
    writable: true,
    value: (sql, options) => {
      if (options && options.transaction) {
        const { transaction } = options

        if (ending.has(transaction)) {
          return query(sql, options)
        }

        return (retired && !ENDS_TRANSACTION.test(String(sql))) || cancelled.has(transaction) ? Promise.reject(new DatabaseRetired()) : query(sql, options).catch((error) => { throw asRetired(error) })
      }

      if (retired) {
        return Promise.reject(new DatabaseRetired())
      }

      return new Promise((resolve, reject) => {
        waiting.push({ sql, options, resolve, reject })
        drain()
      })
    },
  })

  // A managed transaction (the callback form) is followed until it has ended, and none begins on a retired database.
  const transaction = sequelize.transaction.bind(sequelize)

  Object.defineProperty(sequelize, 'transaction', {
    configurable: true,
    writable: true,
    value: (...args) => {
      if (retired) {
        return Promise.reject(new DatabaseRetired())
      }

      const managed = args.findIndex((argument) => typeof argument === 'function')

      if (managed < 0) {
        return transaction(...args)
      }

      let mine = null
      const work = args[managed]
      const run = transaction(...args.map((argument, index) => (index === managed ? (started) => {
        mine = started
        open.add(started)

        const commit = started.commit.bind(started)
        const rollback = started.rollback.bind(started)

        started.commit = () => (cancelled.has(started) ? Promise.reject(new DatabaseRetired()) : commit())
        started.rollback = () => (cancelled.has(started) && !ending.has(started) ? Promise.reject(new DatabaseRetired()) : rollback())
        started.endForRetiring = rollback

        return work(started)
      } : argument)))
      const ended = Promise.resolve(run).catch(() => {})

      transactions.add(ended)
      ended.then(() => {
        transactions.delete(ended)
        open.delete(mine)
        cancelled.delete(mine)
      })

      return run
    },
  })

  // sqlite3 runs a close only after the open before it succeeds, and a statement on a connection that is still opening can't be interrupted. So retiring first lets the opens and the running statement settle (an open that fails drops its handle above, a transaction's next statement is refused so its callback ends and it rolls back), then closes; each wait is bounded by RETIRE_SETTLE_MS so retiring can't hang.
  guards.set(sequelize, async () => {
    retired = true
    waiting.splice(0).forEach(({ reject }) => reject(new DatabaseRetired()))
    interrupt(true)

    const bounded = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timed out'), RETIRE_SETTLE_MS))])
    const settling = [...opening, ...transactions, ...(running && active ? [active] : [])].map((promise) => promise.catch(() => {}))

    if (settling.length) {
      await bounded(Promise.all(settling))
    }

    // A transaction still suspended after the wait is ended here, through its own connection while that is open, and its later commit or rollback is answered as retired.
    const stranded = [...open].filter((started) => !started.finished)

    stranded.forEach((started) => cancelled.add(started))

    if (stranded.length) {
      await bounded(Promise.all(stranded.map((started) => {
        ending.add(started)

        return started.endForRetiring().catch(() => {}).finally(() => ending.delete(started))
      })))
    }

    if (await bounded(sequelize.close()) === 'timed out') {
      console.warn(`The replaced database didn't close within ${RETIRE_SETTLE_MS / 1000} s`)
    }
  })
}

// Drop a database the app has replaced: its waiting reads are rejected, the statements running on it are interrupted and its connections closed, so the old copy neither keeps working nor holds the file. Never rejects.
export const retireDatabase = async (sequelize) => {
  const retire = sequelize && guards.get(sequelize)

  if (retire) {
    try {
      await retire()
    } catch (error) {
      console.warn('Closing the replaced database failed', error)
    }
  }
}

export const resetDatabase = (storagePath) => {
  console.log('## RESETTING ON', storagePath)

  const sequelize = new Sequelize({
    dialect: 'sqlite',
    // dialectModule: sqlite3,

    storage: storagePath,
    dialectOptions: { mode: OPEN_EXISTING },
  })

  guardQueries(sequelize)

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
    RaceGridSize: Sequelize.INTEGER,
    RaceName: Sequelize.TEXT,
    RaceTitle: Sequelize.TEXT,
    NPR: Sequelize.BOOLEAN,
    SpecialNPRID: Sequelize.INTEGER,
    WealthPoints: Sequelize.REAL,
    PreviousWealth: Sequelize.REAL,
    StartingWealth: Sequelize.REAL,
    AnnualWealth: Sequelize.INTEGER,
    GovTypeID: Sequelize.INTEGER,
    WealthCreationRate: Sequelize.REAL,
    ColonizationSkill: Sequelize.REAL,
    MaximumOrbitalMiningDiameter: Sequelize.INTEGER,

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

  class StarType extends Model {}
  StarType.init({
    StellarTypeID: {
      type: Sequelize.INTEGER,
      primaryKey: true,
    },

    SizeID: Sequelize.INTEGER,
    AgeRangeID: Sequelize.INTEGER,

    SpectralClass: Sequelize.TEXT,
    SpectralNumber: Sequelize.INTEGER,
    Checked: Sequelize.BOOLEAN,
    NotPS: Sequelize.BOOLEAN,
    MaxChance: Sequelize.INTEGER,
    BDMaxChance: Sequelize.INTEGER,
    SizeText: Sequelize.TEXT,
    Luminosity: Sequelize.DOUBLE,
    Mass: Sequelize.DOUBLE,
    Temperature: Sequelize.INTEGER,
    Radius: Sequelize.DOUBLE,
    Red: Sequelize.INTEGER,
    Green: Sequelize.INTEGER,
    Blue: Sequelize.INTEGER,
    MaxChanceOld: Sequelize.INTEGER,
    ExtraJP: Sequelize.INTEGER,
  }, {
    sequelize,
    modelName: 'StarType',
    tableName: 'DIM_StellarType',
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

  Star.belongsTo(Game, { foreignKey: 'GameID', sourceKey: 'GameID' })
  Star.belongsTo(StarType, { sourceKey: 'StarTypeID', targetKey: 'StellarTypeID', foreignKey: 'StarTypeID' })
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
