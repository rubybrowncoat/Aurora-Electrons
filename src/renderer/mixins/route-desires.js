import { mapGetters } from 'vuex'

import { joinLabels, tracked } from '../utilities/load-tracking'

// The read behind the desired routes panel alone, and the words that name it when it fails. The tracked key, the async-computed name and the label key are one string. A page that mounts the panel spreads `DESIRE_LABELS` into its own labels and leaves `DESIRE_INPUTS` out of the reads it waits on, so the page is ready, and its other panels show, whether the read is in flight or failed.
export const DESIRE_LABELS = {
  desireObjects: 'the colonies a desired route can run between',
}

export const DESIRE_INPUTS = Object.keys(DESIRE_LABELS)

const messageOf = (error) => (error && error.message ? error.message : String(error))

// The desired routes of a page that has a `loadErrors` record and wraps its reads in `tracked` (mixins/load-state.js): the player's own records in the scenario repository (utilities/route-desires.js), read against the race's colonies. Nothing here writes the save.
export default {
  data() {
    return {
      // The repository's revision of what was read, bumped by each write the panel reports.
      desireRevision: 0,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'GameTime', 'RaceID']),

    desireResolved() {
      return this.$store.getters['history/campaign']
    },

    desireRepository() {
      return this.desireRecords ? this.desireRecords.repository : null
    },

    desireRepositoryError() {
      return this.desireRecords ? this.desireRecords.error : null
    },

    // The scope the desired routes are read and kept in: the race, the campaign and the branch of the open save.
    desireScope() {
      return this.desireRecords && this.desireRecords.desires ? this.desireRecords.desires.scopeOf({ campaign: this.desireResolved, RaceID: this.RaceID, gameTime: this.GameTime }) : null
    },

    // The colonies as read for the save, game and race shown now: a read that is still running for another save or race leaves the last one in place, and it is not used.
    desireObjectsBundle() {
      const bundle = this.desireObjects

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // What the links are checked against: the open save's colonies for the race shown, with its campaign and branch. Null while they are not read.
    desireContext() {
      const bundle = this.desireObjectsBundle
      const open = this.desireResolved

      if (!bundle || !open || !this.desireScope) {
        return null
      }

      return { objects: bundle.objects, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId }
    },

    desireRead() {
      // eslint-disable-next-line no-unused-expressions
      this.desireRevision + this.$store.state.history.revision

      return this.desireRecords && this.desireRecords.desires ? this.desireRecords.desires.readDesires(this.desireRepository, this.desireScope, this.desireContext) : { entries: [], notes: [], error: null }
    },

    // The state of the read: loading until it is in for the save and race shown, else the words naming the failure with its message.
    desireState() {
      const error = this.loadErrors.desireObjects

      return { loading: error === undefined || (error === null && !this.desireObjectsBundle), failed: error ? joinLabels([DESIRE_LABELS.desireObjects]) : '', error: error || '' }
    },
  },
  methods: {
    retryDesires() {
      this.$asyncComputed.desireObjects.update()
    },

    // The panel wrote or deleted a record: the list reads the repository again.
    desiresChanged() {
      this.desireRevision += 1
    },
  },
  asyncComputed: {
    // The repository of scenario records and the module that reads and keeps the desired routes, loaded with the panel: the repository's module needs the app's settings store and the desired routes' module reads the link rules of the history page, so a page that is read without them still loads, and its required reads never include theirs.
    desireRecords: {
      async get() {
        try {
          const [records, desires] = await Promise.all([import('../utilities/scenario-records'), import('../utilities/route-desires')])

          desires.registerRouteDesires(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), desires, error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: messageOf(error) })
        }
      },
      default: null,
      lazy: true,
    },
    // The race's colonies, with the save, game and race the read was made for. A colony list that cannot be read fails the read: nothing is linked from a guess.
    desireObjects: {
      get: tracked('desireObjects', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID) {
          return null
        }

        const { loadDesireObjects } = await import('../utilities/route-desires')
        const loaded = await loadDesireObjects(database, { GameID, RaceID })

        if (loaded.failed.colony) {
          throw new Error(loaded.failed.colony)
        }

        return Object.freeze({ ...loaded, database })
      }),
      default: null,
      lazy: true,
    },
  },
}
