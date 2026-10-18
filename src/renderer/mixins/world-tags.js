// The personal tags of the race's bodies (utilities/world-tags.js) for a page that creates and filters them: the Notebook and the Galaxy Map share one store of tags, so they share this reading of it.
//
// `worldTags` is a mixin. It reads the tags of the open save's campaign, race and branch, checks them against the bodies of the save (the bodies the tags link to and those of the system the host picks from), and keeps, changes and clears a tag. The host declares the tag filter with `tagFilterView(key)` among its own persisted views (mixins/persisted-view.js allows one persisted-view mixin per component) as the field `tagFilter`, a race-scoped view value.
//
// The host defines `tagSystemId`: the SystemID (a number) of the system whose bodies the form offers, or null for none. It shows `<world-tags>` (components/notebook/WorldTags.vue) with `tagShown`, `tagChoices`, `tagSuggestions` and the three actions `tagSave`, `tagRetag` and `tagClear`, and binds the filter with `:value="tagFilterValue" @change="tagFilter = $event"` over `tagOptions`. A stored filter that no tag of this branch has is not applied (`tagFilterValue`) and not overwritten, so the tags that are still being read do not wipe it.
//
// Nothing here writes the save or the map's clusters and borders: the reads are selects and the tags are scenario records.

import { mapGetters } from 'vuex'

import { branchLineage } from '../utilities/history-milestones'
import { ALL_TAGS, bodyIdsOf, clearTag, expectedOf, filterByTag, loadBodies, readTags, registerWorldTags, saveTag, scopeOf, tagChoices, tagOptions, tagSuggestions, tagsBySystem } from '../utilities/world-tags'

// The reads of the tags (the bodies they link to) fail into `tagBodiesRead.error`, which the form and the list show, and the page goes on without them: capability preflight (scripts/lib/capability-scan.js) does not count them among the reads of the page that mixes this in.
export const GUARDED_READS = true

// The persisted view field of the tag the list and the map are filtered to: a choice of `tagOptions`. A host declares it as `tagFilter: tagFilterView('<key>')` in its `persistedView({...})`.
export const tagFilterView = (key) => ({ key, default: ALL_TAGS, scope: 'race' })

export default {
  data() {
    return {
      // The repository's revision of what was read (bumped by each write), and the message of the last action.
      tagRevision: 0,
      tagBusy: false,
      tagMessage: '',
      tagMessageType: 'info',
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID']),

    // The campaign and branch the recorder settled this game to, null until it has.
    tagResolved() {
      return this.$store.getters['history/campaign']
    },

    tagRepository() {
      return this.tagRecords ? this.tagRecords.repository : null
    },

    // The scope the tags are read and kept in: the race, the campaign and the branch of the open save.
    tagScope() {
      return scopeOf({ campaign: this.tagResolved, RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // What a form belongs to: the campaign, the race and the branch. A form is dropped when it changes, and a save from one that did not follow is refused.
    tagScopeKey() {
      const scope = this.tagScope

      return scope ? [scope.campaignId, scope.RaceID, scope.branchId].join('|') : ''
    },

    // The tags read without the save's bodies: which bodies they link to.
    tagBase() {
      // eslint-disable-next-line no-unused-expressions
      this.tagRevision + this.$store.state.history.revision

      return readTags(this.tagRepository, this.tagScope)
    },

    tagBodyIds() {
      return bodyIdsOf(this.tagBase.entries)
    },

    // The bodies as read for the save, game and race shown, and only when that read asked for every body the tags link to now: a read made before the tags were loaded, or for other IDs, proves nothing about a body it did not ask for, so it is not used and those tags read not checked until their own read is in.
    tagBodiesBundle() {
      const bundle = this.tagBodiesRead

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID && this.tagBodyIds.every((id) => bundle.requested.has(id)) ? bundle : null
    },

    // What the links are checked against: the bodies of the open save for the race shown, with its campaign, branch and the campaign's branches. Null while the bodies are not read, or when their read failed.
    tagContext() {
      const bundle = this.tagBodiesBundle
      const open = this.tagResolved

      if (!bundle || !bundle.bodies || !open || !this.tagScope) {
        return null
      }

      return { objects: { body: bundle.bodies }, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId, branches: this.tagBranches }
    },

    tagRead() {
      // eslint-disable-next-line no-unused-expressions
      this.tagRevision + this.$store.state.history.revision

      return readTags(this.tagRepository, this.tagScope, this.tagContext)
    },

    tagEntries() {
      return this.tagRead.entries
    },

    tagOptions() {
      return tagOptions(this.tagEntries)
    },

    // The filter as it applies: the stored choice when this branch has a tag for it, else all of them.
    tagFilterValue() {
      return this.tagOptions.some((option) => option.value === this.tagFilter) ? this.tagFilter : ALL_TAGS
    },

    // The tags the filter lets through.
    tagShown() {
      return filterByTag(this.tagEntries, this.tagFilterValue)
    },

    // The tags the filter lets through by system, `{ [SystemID]: { entries, stale } }`.
    tagSystems() {
      return tagsBySystem(this.tagShown)
    },

    // Every tag by system, whatever the filter says.
    tagAllSystems() {
      return tagsBySystem(this.tagEntries)
    },

    tagSuggestions() {
      return tagSuggestions(this.tagEntries)
    },

    // The bodies of the picked system that a tag can be put on.
    tagChoices() {
      const bundle = this.tagBodiesBundle

      return bundle && bundle.bodies && Number.isInteger(this.tagSystemId) ? tagChoices(bundle.bodies, this.tagSystemId) : []
    },

    // Why tags cannot be kept or listed here, or '' when they can.
    tagProblem() {
      if (this.tagRecords && this.tagRecords.error) {
        return `The scenario records are not available in this window, so tags are not kept: ${this.tagRecords.error}`
      }

      return this.tagRead.error ? `The tags cannot be read here: ${this.tagRead.error.message}` : ''
    },

    // Why the form cannot offer bodies, or '' when it can.
    tagHint() {
      const bundle = this.tagBodiesBundle

      if (!this.tagScope) {
        return 'The campaign of this save is not settled yet'
      }

      if (!bundle) {
        return 'Reading the bodies of this save'
      }

      return bundle.error ? `This save cannot give its bodies: ${bundle.error}` : ''
    },
  },
  methods: {
    tagReport(outcome, done) {
      this.tagRevision += 1
      this.tagMessage = outcome.ok ? (outcome.unchanged ? 'The tag is as it was.' : done) : outcome.message
      this.tagMessageType = outcome.ok ? 'success' : 'warning'
    },

    // Runs a change of the store: refuses it when what is shown is not what the form was filled in for, and reports its outcome. True when it was made.
    async tagRun(scopeKey, work, done) {
      if (scopeKey !== undefined && scopeKey !== this.tagScopeKey) {
        this.tagMessage = 'The campaign, race or branch shown changed after the form was filled in, so nothing is saved. Fill it in again.'
        this.tagMessageType = 'warning'

        return false
      }

      this.tagBusy = true

      try {
        const outcome = await work()

        this.tagReport(outcome, done)

        return outcome.ok
      } finally {
        this.tagBusy = false
      }
    },

    // What the form records when it picks the body `row` (a row of `tagChoices`): the tag the body has among all of the branch's tags, whatever the filter shows, or that it has none.
    tagExpect(row) {
      return expectedOf(this.tagEntries, row)
    },

    // Puts the text `tag` on the body `row` (a row of `tagChoices`): a new tag, or the change of the tag the body has, over `expected`, what `tagExpect` gave when the body was picked. `scopeKey` is the `tagScopeKey` the form was filled in for.
    tagSave({ row, tag, expected, scopeKey }) {
      return this.tagRun(scopeKey, () => saveTag(this.tagRepository, this.tagScope, { tag, target: { type: 'body', row }, expected, context: this.tagContext }), 'The tag is kept.')
    },

    // Changes the text of a listed tag, which keeps its link: also a stale one, which is never moved to another body.
    tagRetag({ entry, tag, scopeKey }) {
      return this.tagRun(scopeKey, () => saveTag(this.tagRepository, this.tagScope, { entry, tag, context: this.tagContext }), 'The tag is changed.')
    },

    // Clears a listed tag.
    tagClear(entry) {
      return this.tagRun(undefined, () => clearTag(this.tagRepository, this.tagScope, entry), 'The tag is cleared.')
    },
  },
  asyncComputed: {
    // The repository of scenario records, loaded with the page: its module needs the app's settings store, so a page that is read without it still loads.
    tagRecords: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerWorldTags(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: error.message })
        }
      },
      default: null,
    },
    // The branches of the open campaign as the registry holds them (the branch each left and the game time it left it at), for telling whether a body that a link names is the same one on the branch of the open save. Null when the registry cannot be read here; loaded lazily like the records, since the registry needs the app's settings store.
    tagBranches: {
      async get() {
        // eslint-disable-next-line no-unused-expressions
        this.$store.state.history.revision

        const open = this.tagResolved
        const { config } = this

        if (!open) {
          return null
        }

        try {
          const [{ readRegistry }, { campaignStorage }] = await Promise.all([import('../utilities/campaign'), import('../utilities/history')])

          return branchLineage(readRegistry(campaignStorage(config)).campaigns[open.campaignId])
        } catch (error) {
          return null
        }
      },
      default: null,
    },
    // The bodies the tags link to and those of the system the host picks from; a read that fails is kept as an error, never as bodies that are gone.
    tagBodiesRead: {
      async get() {
        const { database, GameID, RaceID } = this
        const bodyIds = this.tagBodyIds
        const systemId = Number.isInteger(this.tagSystemId) ? this.tagSystemId : null

        if (!database || !GameID || !RaceID) {
          return null
        }

        try {
          return Object.freeze({ bodies: await loadBodies(database, { GameID, RaceID, bodyIds, systemId }), error: null, database, GameID, RaceID, requested: new Set(bodyIds) })
        } catch (error) {
          return Object.freeze({ bodies: null, error: error && error.message ? error.message : String(error), database, GameID, RaceID, requested: new Set(bodyIds) })
        }
      },
      default: null,
    },
  },
}
