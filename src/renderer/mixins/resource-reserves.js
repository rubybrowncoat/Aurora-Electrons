import { mapGetters } from 'vuex'

import { readRegistry } from '../utilities/campaign'
import { campaignStorage } from '../utilities/history'
import { branchLineage } from '../utilities/history-milestones'
import { joinLabels, tracked } from '../utilities/load-tracking'
import { loadClassMinimums, loadSupplyState } from '../utilities/resource-feeds'
import { loadPacketRows } from '../utilities/msp-supply'
import { loadReserveObjects, readReserves, registerResourceReserves, scopeOf } from '../utilities/resource-reserves'

// The reads behind the reserve panel and the words that name each when it fails. The tracked key, the async-computed name and the label key of a read are one string.
export const RESERVE_LABELS = {
  reserveObjects: 'the colonies, ships and ship classes',
  reserveClasses: 'the ship classes',
  reservePackets: 'the mass-driver packets in flight',
  reserveSupply: 'the colonies\' fuel and maintenance supplies',
  populationProductionModifiers: 'the colonies\' production rates',
}

const messageOf = (error) => (error && error.message ? error.message : String(error))

// The read state of the reserve panel and the records it shows, for a component that mixes in `tracked` reads of its own (it needs a `kind` prop or computed: 'supplies' or 'minerals' for the colonies' reserves, 'fuel' for the reserves of ships and ship classes). Nothing here writes the save: the records live in the scenario repository (utilities/resource-reserves.js).
export default {
  data() {
    return {
      loadErrors: {},
      // The repository's revision of what was read, bumped by each write the panel reports.
      reserveRevision: 0,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID']),

    reserveResolved() {
      return this.$store.getters['history/campaign']
    },

    reserveRepository() {
      return this.reserveRecords ? this.reserveRecords.repository : null
    },

    reserveRepositoryError() {
      return this.reserveRecords ? this.reserveRecords.error : null
    },

    // The scope the records are read and kept in: the race, the campaign and the branch of the open save.
    reserveScope() {
      return scopeOf({ campaign: this.reserveResolved, RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // The branches of the open campaign as the registry holds them, for telling whether a link made on another branch names the same colony here. Null when the registry cannot be read.
    reserveBranches() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision

      const open = this.reserveResolved

      if (!open) {
        return null
      }

      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[open.campaignId])
      } catch (error) {
        return null
      }
    },

    // The kinds of source the panel's records name and its reads load: the colonies, or for fuel the ships and the ship classes.
    reserveTypes() {
      return this.kind === 'fuel' ? ['ship', 'class'] : ['colony']
    },

    // The reads the panel waits on: the packets in flight matter to minerals alone, and so do the colonies' supplies and production rates, which the Logistics page hands to the supplies panel but the Hauling page does not read: the supply production draws on the minerals' stocks. The reserves of ships and classes need no class minimum.
    reserveInputs() {
      return this.kind === 'fuel' ? ['reserveObjects'] : this.kind === 'minerals' ? ['reserveObjects', 'reserveClasses', 'reservePackets', 'reserveSupply', 'populationProductionModifiers'] : ['reserveObjects', 'reserveClasses']
    },

    // The reads as made for the save, game and race shown now: a read that is still running for another save or race leaves the last one in place, and it is not used.
    reserveObjectsBundle() {
      return this.bundleOf(this.reserveObjects)
    },

    reserveClassesBundle() {
      return this.bundleOf(this.reserveClasses)
    },

    reservePacketsBundle() {
      return this.bundleOf(this.reservePackets)
    },

    reserveSupplyBundle() {
      return this.bundleOf(this.reserveSupply)
    },

    // What the links are checked against: the open save's objects of the kinds the panel names (colonies, or ships and ship classes) for the race shown, with its campaign, branch and the campaign's branches. Null while they are not read.
    reserveContext() {
      const bundle = this.reserveObjectsBundle
      const open = this.reserveResolved

      if (!bundle || !open || !this.reserveScope) {
        return null
      }

      return { objects: bundle.objects, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId, branches: this.reserveBranches }
    },

    reserveRead() {
      // eslint-disable-next-line no-unused-expressions
      this.reserveRevision + this.$store.state.history.revision

      return readReserves(this.reserveRepository, this.reserveScope, this.reserveContext)
    },

    // The reads of the panel that failed, each with its message; one that is in flight again keeps its message until it settles.
    reserveFailedKeys() {
      return this.reserveInputs.filter((key) => this.loadErrors[key])
    },

    // The state of the panel's reads: loading until every read is in for the save and race shown (and no read has failed), else the words naming the failed reads with the first message. The panel shows no figure from a read that is in flight or failed.
    reserveState() {
      const failed = this.reserveFailedKeys
      const current = Boolean(this.reserveRecords && this.reserveObjectsBundle && (this.kind === 'fuel' || (this.reserveClassesBundle && (this.kind !== 'minerals' || (this.reservePacketsBundle && this.reserveSupplyBundle && this.loadErrors.populationProductionModifiers === null)))))

      return { loading: failed.length === 0 && !current, failed: joinLabels(failed.map((key) => RESERVE_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
    },
  },
  methods: {
    bundleOf(bundle) {
      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // Reads again the reads that failed.
    retryReserves() {
      this.reserveFailedKeys.forEach((key) => this.$asyncComputed[key].update())
    },

    // The panel wrote or deleted a record: the list reads the repository again.
    reservesChanged() {
      this.reserveRevision += 1
    },
  },
  asyncComputed: {
    // The repository of scenario records, loaded with the panel: its module needs the app's settings store, so a page that is read without it still loads.
    reserveRecords: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerResourceReserves(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: messageOf(error) })
        }
      },
      default: null,
      lazy: true,
    },
    // The race's objects of the kinds the records name (colonies, or ships and ship classes), which a record's source is checked against and picked from. The read carries the save, game and race it was made for.
    reserveObjects: {
      get: tracked('reserveObjects', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID) {
          return null
        }

        return Object.freeze({ ...(await loadReserveObjects(database, { GameID, RaceID }, { types: this.reserveTypes })), database })
      }),
      default: null,
      lazy: true,
    },
    // The ship classes of the race with ships, for the class minimum; the reserves of ships and classes need none.
    reserveClasses: {
      get: tracked('reserveClasses', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID || this.kind === 'fuel') {
          return null
        }

        return Object.freeze({ classes: await loadClassMinimums(database, { GameID, RaceID }), database, GameID, RaceID })
      }),
      default: null,
      lazy: true,
    },
    // The mass-driver packets in flight, read for minerals alone.
    reservePackets: {
      get: tracked('reservePackets', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID || this.kind !== 'minerals') {
          return null
        }

        return Object.freeze({ packets: await loadPacketRows(database, { GameID, RaceID }), database, GameID, RaceID })
      }),
      default: null,
      lazy: true,
    },
    // The colonies' stockpiles of fuel and maintenance supplies and their production, read for minerals alone.
    reserveSupply: {
      get: tracked('reserveSupply', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID || this.kind !== 'minerals') {
          return null
        }

        return Object.freeze({ colonies: await loadSupplyState(database, { GameID, RaceID }), database, GameID, RaceID })
      }),
      default: null,
      lazy: true,
    },
  },
}
