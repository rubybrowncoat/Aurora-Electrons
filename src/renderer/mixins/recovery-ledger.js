import { mapGetters } from 'vuex'

import { hashValue, readRegistry } from '../utilities/campaign'
import { campaignStorage } from '../utilities/history'
import { branchLineage } from '../utilities/history-milestones'
import { joinLabels, tracked } from '../utilities/load-tracking'
import { observedKinds, readOpenSave, saveObservationChoice } from '../utilities/observations'
import { observationRows, readObservationRecord } from '../utilities/observation-view'
import { loadRecoveryObjects, observationSignature, PLACES, readRecovery, recoveryRows, recoveryTotals, registerRecoveryLedger, scopeOf, TYPE_KEYS } from '../utilities/recovery-ledger'

// The read behind the recovery ledger alone, and the words that name it when it fails. The tracked key, the async-computed name and the label key of a read are one string. A page that mounts the ledger spreads `RECOVERY_LABELS` into its own labels and leaves `RECOVERY_INPUTS` out of the reads it waits on, so the page is ready, and its other panels show, whether the read is in flight or failed.
export const RECOVERY_LABELS = {
  recoveryObjects: 'the life pods and wrecks',
}

export const RECOVERY_INPUTS = Object.keys(RECOVERY_LABELS)

const messageOf = (error) => (error && error.message ? error.message : String(error))

// The kinds of the generic observation (utilities/observations.js) the ledger observes, one for each place, and the kinds of object each holds.
const OBSERVED = Object.freeze({ lifepod: ['ownLifepod', 'lifepod'], wreck: ['ownWreck', 'wreck'] })

// The digests an observation compares for the objects of a place, `[[id, digest]]`, or null when a kind of the place was not read (the objects are then not compared with the record).
const digestsOf = (objects, types) => (types.some((type) => !(objects[type] instanceof Map)) ? null : types.flatMap((type) => [...objects[type].values()].map((row) => [row.id, hashValue(observationSignature(row))])))

// The read state of the recovery ledger and what it shows, for a page that has a `loadErrors` record and wraps its reads in `tracked` (mixins/load-state.js). Nothing here writes the save: the statuses live in the scenario repository (utilities/recovery-ledger.js) and the observation choice in the settings (utilities/observations.js).
export default {
  data() {
    return {
      // The repository's revision of what was read, bumped by each write the ledger reports.
      recoveryRevision: 0,
      // Whether the life pods and the wrecks of the race are observed (the choice of the settings, both kinds together), and why a choice could not be saved.
      recoveryObserveChoice: false,
      recoveryObserveMessage: '',
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID', 'StartYear']),

    recoveryResolved() {
      return this.$store.getters['history/campaign']
    },

    recoveryRepository() {
      return this.recoveryRecords ? this.recoveryRecords.repository : null
    },

    recoveryRepositoryError() {
      return this.recoveryRecords ? this.recoveryRecords.error : null
    },

    // The scope the statuses are read and kept in: the race, the campaign and the branch of the open save.
    recoveryScope() {
      return scopeOf({ campaign: this.recoveryResolved, RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // The branches of the open campaign as the registry holds them, for telling whether a link made on another branch names the same object here. Null when the registry cannot be read.
    recoveryBranches() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision

      const open = this.recoveryResolved

      if (!open) {
        return null
      }

      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[open.campaignId])
      } catch (error) {
        return null
      }
    },

    // The read as made for the save, game and race shown now: a read that is still running for another save or race leaves the last one in place, and it is not used.
    recoveryBundle() {
      const bundle = this.recoveryObjects

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // What the links are checked against: the open save's objects for the race shown, with its campaign, branch and the campaign's branches. Null while the objects are not read.
    recoveryContext() {
      const bundle = this.recoveryBundle
      const open = this.recoveryResolved

      if (!bundle || !open || !this.recoveryScope) {
        return null
      }

      return { objects: bundle.objects, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId, branches: this.recoveryBranches }
    },

    recoveryRead() {
      // eslint-disable-next-line no-unused-expressions
      this.recoveryRevision + this.$store.state.history.revision

      return readRecovery(this.recoveryRepository, this.recoveryScope, this.recoveryContext)
    },

    // The state of the ledger's read: loading until it is in for the save and race shown (and has not failed), else the words naming it with its message. The ledger shows no figure from a read that is in flight or failed.
    recoveryState() {
      const failed = RECOVERY_INPUTS.filter((key) => this.loadErrors[key])
      const current = Boolean(this.recoveryBundle && this.recoveryRecords)

      return { loading: failed.length === 0 && !current, failed: joinLabels(failed.map((key) => RECOVERY_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
    },

    // The observation of the life pods and wrecks is offered for a player race of a settled campaign and branch.
    recoveryObservable() {
      const open = this.recoveryResolved

      return !!open && !!open.campaignId && !!open.branchId && !!this.RaceID && !this.$store.state.RaceNPR
    },

    // The columns of the read for the observation that the save lacks (the capability report's optional input `recoveryObservationRead`): the ledger goes on without the observation, so only the observation is left out.
    recoveryObservationGaps() {
      const report = this.$store.getters['capabilities/report']('/map')
      const entry = report && report.degraded.find((degraded) => degraded.key === 'recoveryObservationRead')

      return entry ? entry.fields : []
    },

    recoveryCanObserve() {
      return this.recoveryObservable && this.recoveryObservationGaps.length === 0
    },

    recoveryObserving() {
      return this.recoveryCanObserve && !!this.recoveryObserveChoice
    },

    // What changes the record the ledger reads: the choice, the branch, the race, and the recorder having written (its pass is asked for at the switch). Null while the race is not observed.
    recoveryObservationKey() {
      const open = this.recoveryResolved

      return this.recoveryObserving ? `${open.campaignId}|${open.branchId}|${this.RaceID}|${this.$store.state.history.revision}` : null
    },

    // The branch's files as they stand, one for each place: { status: 'ok', record } (record null while the race has none), { status: 'unavailable', reason }. Null while the race is not observed. Derived, never copied, so it is the file the recorder last wrote.
    recoveryObservationFiles() {
      const open = this.recoveryResolved

      return this.recoveryObservationKey ? Object.fromEntries(PLACES.map((place) => [place, readObservationRecord(open.campaignId, open.branchId, this.RaceID, place)])) : null
    },

    // Why a record or the open save cannot be compared, empty while they can.
    recoveryObservationNote() {
      const files = this.recoveryObservationFiles
      const bundle = this.recoveryBundle

      if (!files) {
        return ''
      }

      const unreadable = PLACES.find((place) => files[place].status !== 'ok')

      if (unreadable) {
        return `The observation record cannot be read (${files[unreadable].reason}), so no span is shown and nothing is written to it.`
      }

      return bundle && !bundle.open ? 'The game time of the open save could not be read for the observation, so nothing is compared.' : ''
    },

    // What the records say of each object of the open save, by place and id: a Map from id to { state, span }. An object is unread while its record or the open save could not be read.
    recoveryObservationStates() {
      const files = this.recoveryObservationFiles
      const bundle = this.recoveryBundle

      if (!files || !bundle) {
        return null
      }

      return Object.fromEntries(PLACES.map((place) => {
        const objects = bundle.open ? digestsOf(bundle.objects, OBSERVED[place]) : null
        const usable = files[place].status === 'ok' && objects

        return [place, observationRows(usable ? files[place].record : null, usable ? objects : null, usable ? bundle.open : null)]
      }))
    },

    // The ledger's rows and figures, null until the read is in. A kind of object that could not be read is listed in `problems`.
    recoveryView() {
      const state = this.recoveryState
      const bundle = this.recoveryBundle

      if (state.loading || state.failed || !bundle) {
        return null
      }

      const read = this.recoveryRead
      const states = this.recoveryObservationStates
      const rows = recoveryRows({ objects: bundle.objects, entries: read.entries }).map((row) => (row.object && states ? { ...row, observation: states[row.place].get(row.id) || { state: 'unread', span: null } } : row))

      return { rows, totals: recoveryTotals(rows), notes: read.notes, error: read.error, problems: Object.entries(bundle.failed).map(([key, message]) => ({ key, message })) }
    },

    // The campaign and branch that the observation choice and the records belong to.
    recoveryCampaignId() {
      return this.recoveryResolved ? this.recoveryResolved.campaignId : null
    },

    // The key the race's settings are kept under: null before a race is picked or while no campaign is settled.
    recoveryPrefix() {
      return this.$store.getters.racePrefix
    },
  },
  watch: {
    // The choice follows the race and campaign the page shows.
    recoveryPrefix: {
      immediate: true,
      handler(prefix) {
        this.recoveryObserveMessage = ''
        this.recoveryObserveChoice = prefix && this.recoveryCampaignId ? PLACES.every((place) => observedKinds(this.config.store, this.recoveryCampaignId, this.RaceID).includes(place)) : false
      },
    },
  },
  methods: {
    // Reads again the read that failed, or that gave all but a kind of object (a kind that failed is not a failed read and is listed in the view's `problems`).
    retryRecovery() {
      this.$asyncComputed.recoveryObjects.update()
    },

    // The ledger wrote or deleted a status: the list reads the repository again.
    recoveryChanged() {
      this.recoveryRevision += 1
    },

    // Switches the observation of the life pods and the wrecks together, as one choice of the settings for both kinds, and asks the recorder for a pass when it is turned on.
    setRecoveryObserve(on) {
      this.recoveryObserveMessage = ''

      try {
        PLACES.forEach((place) => saveObservationChoice(this.config, this.recoveryCampaignId, this.RaceID, place, !!on))
      } catch (error) {
        this.recoveryObserveMessage = `The choice could not be saved: ${messageOf(error)}`

        return
      }

      this.recoveryObserveChoice = !!on

      if (on) {
        this.$store.commit('history/capture')
      }
    },
  },
  asyncComputed: {
    // The repository of scenario records, loaded with the ledger: its module needs the app's settings store, so a page that is read without it still loads.
    recoveryRecords: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerRecoveryLedger(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: messageOf(error) })
        }
      },
      default: null,
      lazy: true,
    },
    // What the race can see of the life pods and the wrecks in the systems it knows, by kind, and the game time and increments of the open save when the race is observed. The read carries the save, game and race it was made for. A read in which every kind failed fails the read: nothing is listed from a guess.
    recoveryObjects: {
      get: tracked('recoveryObjects', async function () {
        const { database, GameID, RaceID } = this
        const observing = this.recoveryObserving

        if (!database || !GameID || !RaceID) {
          return null
        }

        const loaded = await loadRecoveryObjects(database, { GameID, RaceID })

        if (TYPE_KEYS.every((type) => loaded.failed[type])) {
          throw new Error(loaded.failed[TYPE_KEYS[0]])
        }

        const open = observing ? await readOpenSave(database, { GameID }) : null

        return Object.freeze({ ...loaded, open, database, GameID, RaceID })
      }),
      default: null,
      lazy: true,
    },
  },
}
