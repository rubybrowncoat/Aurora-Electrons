import { mapGetters } from 'vuex'

import { readRegistry } from '../utilities/campaign'
import { STATION_KIND, loadFleetOrders, loadStationBodies, loadStationObjects, readStations, registerFleetStations, scopeOf, stationBodyIds, stationRows, withBodies } from '../utilities/fleet-stations'
import { campaignStorage } from '../utilities/history'
import { branchLineage } from '../utilities/history-milestones'
import { joinLabels, tracked } from '../utilities/load-tracking'

// The reads behind the fleet stations panel alone, and the words that name each when it fails. The tracked key, the async-computed name and the label key of a read are one string. A page that mounts the panel spreads `STATION_LABELS` into its own labels and leaves `STATION_INPUTS` out of the reads it waits on, so the page is ready, and its other panels show, whether these reads are in flight or failed.
export const STATION_LABELS = {
  stationObjects: 'the fleets, waypoints and colonies',
  stationBodies: 'the bodies the notes name',
  stationOrders: 'the saved orders',
}

export const STATION_INPUTS = Object.keys(STATION_LABELS)

const messageOf = (error) => (error && error.message ? error.message : String(error))

// The read state of the fleet stations panel and what it shows, for a page that has a `loadErrors` record and wraps its reads in `tracked` (mixins/load-state.js). Nothing here writes the save: the notes live in the scenario repository (utilities/fleet-stations.js).
export default {
  data() {
    return {
      // The repository's revision of what was read, bumped by each write the panel reports.
      stationRevision: 0,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID']),

    stationResolved() {
      return this.$store.getters['history/campaign']
    },

    stationRepository() {
      return this.stationRecords ? this.stationRecords.repository : null
    },

    stationRepositoryError() {
      return this.stationRecords ? this.stationRecords.error : null
    },

    // The scope the notes are read and kept in: the race, the campaign and the branch of the open save.
    stationScope() {
      return scopeOf({ campaign: this.stationResolved, RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // The branches of the open campaign as the registry holds them, for telling whether a link made on another branch names the same object here. Null when the registry cannot be read.
    stationBranches() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision

      const open = this.stationResolved

      if (!open) {
        return null
      }

      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[open.campaignId])
      } catch (error) {
        return null
      }
    },

    // The notes read without the save's objects: which bodies they name.
    stationBase() {
      // eslint-disable-next-line no-unused-expressions
      this.stationRevision + this.$store.state.history.revision

      return readStations(this.stationRepository, this.stationScope)
    },

    stationBodyWanted() {
      return stationBodyIds(this.stationBase.entries)
    },

    // The reads as made for the save, game and race shown now: a read that is still running for another save or race leaves the last one in place, and it is not used.
    stationObjectsBundle() {
      const bundle = this.stationObjects

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // The bodies as read for the save, game and race shown, and only when that read asked for every body the notes name now: a read made for other IDs proves nothing about a body it did not ask for, so those links read not checked until their own read is in.
    stationBodiesBundle() {
      const bundle = this.stationBodies

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID && this.stationBodyWanted.every((id) => bundle.requested.has(id)) ? bundle : null
    },

    stationOrdersBundle() {
      const bundle = this.stationOrders

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // What the links are checked against: the open save's objects for the race shown, with its campaign, branch and the campaign's branches. Null while the objects are not read.
    stationContext() {
      const bundle = this.stationObjectsBundle
      const open = this.stationResolved

      if (!bundle || !open || !this.stationScope) {
        return null
      }

      const bodies = this.stationBodiesBundle
      const loaded = withBodies(bundle, bodies ? bodies.bodies : null)

      return { objects: loaded.objects, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId, branches: this.stationBranches }
    },

    stationRead() {
      // eslint-disable-next-line no-unused-expressions
      this.stationRevision + this.$store.state.history.revision

      return readStations(this.stationRepository, this.stationScope, this.stationContext)
    },

    // The reads of the panel that failed, each with its message; one that is in flight again keeps its message until it settles.
    stationFailedKeys() {
      return STATION_INPUTS.filter((key) => this.loadErrors[key])
    },

    // The state of the panel's reads: loading until every read is in for the save and race shown (and no read has failed), else the words naming the failed reads with the first message. The panel shows no figure from a read that is in flight or failed.
    stationState() {
      const failed = this.stationFailedKeys
      const current = Boolean(this.stationObjectsBundle && this.stationBodiesBundle && this.stationOrdersBundle && this.stationRecords)

      return { loading: failed.length === 0 && !current, failed: joinLabels(failed.map((key) => STATION_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
    },

    // The fleets with their notes and the notes that belong to no fleet, null until the reads are in. Kinds of object that could not be read are listed in `problems`.
    stationView() {
      const state = this.stationState

      if (state.loading || state.failed || !this.stationObjectsBundle || !this.stationOrdersBundle) {
        return null
      }

      const read = this.stationRead
      const shown = stationRows({ fleets: this.stationObjectsBundle.objects.fleet, entries: read.entries, orders: this.stationOrdersBundle.orders })

      return { ...shown, notes: read.notes, error: read.error, kind: STATION_KIND, systems: this.stationObjectsBundle.systems, problems: Object.entries(this.stationObjectsBundle.failed).map(([key, message]) => ({ key, message })) }
    },
  },
  methods: {
    // Reads again the reads that failed, and the read of the fleets, waypoints and colonies when it gave all but a kind of them (that read settles when its fleets are in, so a colony, waypoint or system list that failed is not a failed read, and is listed in the view's `problems`).
    retryStations() {
      const partial = this.stationObjectsBundle && Object.keys(this.stationObjectsBundle.failed).length > 0 ? ['stationObjects'] : []

      ;[...new Set([...this.stationFailedKeys, ...partial])].forEach((key) => this.$asyncComputed[key].update())
    },

    // The panel wrote or deleted a note: the list reads the repository again.
    stationsChanged() {
      this.stationRevision += 1
    },
  },
  asyncComputed: {
    // The repository of scenario records, loaded with the panel: its module needs the app's settings store, so a page that is read without it still loads.
    stationRecords: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerFleetStations(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: messageOf(error) })
        }
      },
      default: null,
      lazy: true,
    },
    // The race's fleets, waypoints and colonies and the systems it knows. The read carries the save, game and race it was made for. A fleet list that cannot be read fails the read: nothing is listed from a guess.
    stationObjects: {
      get: tracked('stationObjects', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID) {
          return null
        }

        const loaded = await loadStationObjects(database, { GameID, RaceID })

        if (loaded.failed.fleet) {
          throw new Error(loaded.failed.fleet)
        }

        return Object.freeze({ ...loaded, database })
      }),
      default: null,
      lazy: true,
    },
    // The bodies the notes name as a station. A read that fails is an error, never bodies that are gone.
    stationBodies: {
      get: tracked('stationBodies', async function () {
        const { database, GameID, RaceID } = this
        const bodyIds = this.stationBodyWanted

        if (!database || !GameID || !RaceID) {
          return null
        }

        return Object.freeze({ bodies: await loadStationBodies(database, { GameID, RaceID, bodyIds }), database, GameID, RaceID, requested: new Set(bodyIds) })
      }),
      default: null,
      lazy: true,
    },
    // The move orders saved for the race's fleets.
    stationOrders: {
      get: tracked('stationOrders', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID) {
          return null
        }

        return Object.freeze({ orders: await loadFleetOrders(database, { GameID, RaceID }), database, GameID, RaceID })
      }),
      default: null,
      lazy: true,
    },
  },
}
