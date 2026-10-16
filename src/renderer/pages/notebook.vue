<template>
  <div>
    <v-container fluid class="notebook-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <change-digest :config="config" :campaign="resolved" :race-id="RaceID" :game-time="GameTime" :notes="digestNotes" :names="installationNames" :start-year="StartYear" :separator="separator" :history-revision="historyRevision" :recording="recording" />

        <v-card class="panel notebook-form" data-summary="A note on one body, colony, fleet or tech, with a status and the next action to take. It keeps the economy's projects in one place; a note gives the game no order and writes nothing to the save." elevation="1">
          <div class="panel-head">
            <span>{{ draft.uuid ? 'Edit note' : 'New note' }}</span>
            <span class="caption text--secondary" data-note-count>{{ caption }}</span>
          </div>
          <div class="panel-body">
            <v-alert v-if="read.error" type="warning" outlined dense data-note-error>The notes cannot be read here: {{ read.error.message }}</v-alert>
            <v-alert v-else-if="records && records.error" type="info" outlined dense data-note-error>The scenario records are not available in this window, so notes are not kept: {{ records.error }}</v-alert>
            <div v-else-if="!scope" class="caption text--secondary" data-note-waiting>The campaign of this save is not settled yet, so notes wait for it.</div>
            <template v-else>
              <div class="notebook__form" data-note-form>
                <v-select v-model="draft.kind" :items="kindItems" label="About" dense outlined hide-details class="notebook__kind" data-note-kind @change="draft.pick = null" />
                <v-autocomplete v-if="draft.kind === 'body'" v-model="draft.systemId" :items="systems" item-text="name" item-value="id" label="System" dense outlined clearable hide-details class="notebook__system" data-note-system-pick @change="draft.pick = null" />
                <v-autocomplete v-if="draft.kind !== 'keep'" v-model="draft.pick" :items="choices" item-text="text" item-value="id" return-object :label="pickLabel" :disabled="!context || (draft.kind === 'body' && draft.systemId === null)" :hint="pickHint" persistent-hint dense outlined clearable class="notebook__pick" data-note-pick @change="picked" />
                <v-switch v-if="draft.kind === 'tech'" v-model="draft.unresearched" label="Include techs not yet researched" dense hide-details class="notebook__policy mt-1" data-note-unresearched />
                <v-text-field v-model="draft.title" label="Plan" :counter="titleLength" dense outlined class="notebook__title" data-note-title />
                <v-select v-model="draft.status" :items="statuses" item-text="text" item-value="value" label="Status" dense outlined hide-details class="notebook__status" data-note-status />
                <v-text-field v-model="draft.next" label="Next action" :counter="nextLength" dense outlined class="notebook__next" data-note-next />
                <v-switch v-model="draft.campaignWide" label="Share with every branch of this campaign" dense hide-details class="notebook__policy mt-1" data-note-policy />
              </div>
              <div class="notebook__actions">
                <v-btn small depressed color="primary" :disabled="busy || !ready" data-note-save @click="saveDraft(false)">{{ draft.uuid ? 'Save changes' : 'Add note' }}</v-btn>
                <v-btn v-if="draft.uuid" small text :disabled="busy" data-note-cancel @click="cancel">Cancel</v-btn>
              </div>
              <v-alert v-if="conflict" type="warning" outlined dense class="mt-2" data-note-conflict>
                <div>This note was changed elsewhere after it was opened here. It now reads: {{ conflict.title }} ({{ conflict.status }}).</div>
                <div class="mt-2">
                  <v-btn small depressed color="warning" :disabled="busy" data-note-overwrite @click="saveDraft(true)">Write over it</v-btn>
                  <v-btn small text class="ml-2" data-note-keep @click="cancel">Keep what is stored</v-btn>
                </div>
              </v-alert>
              <v-alert v-if="message" :type="messageType" outlined dense class="mt-2" data-note-message>{{ message }}</v-alert>
            </template>
          </div>
        </v-card>

        <v-card class="panel notebook-list" data-summary="The notes kept for this race, filtered by system. A note whose object has gone stays readable as stale, with the name it last had, and is never moved to another object by its name." elevation="1">
          <div class="panel-head">
            <span>Project notes</span>
            <v-select v-model="filterSystem" :items="systemFilter" item-value="value" label="System" dense outlined hide-details class="notebook__filter" data-note-filter>
              <template #selection="{ item }">{{ item.text }} ({{ item.count }})</template>
              <template #item="{ item }">{{ item.text }} ({{ item.count }})</template>
            </v-select>
          </div>
          <div class="panel-body">
            <div v-if="shown.length" data-note-list>
              <div v-for="entry in shown" :key="entry.uuid" class="notebook__row" :data-note="entry.uuid" :data-note-status="entry.status" :data-note-stale="entry.stale" :data-note-system="entry.place.systemId === null ? 'none' : entry.place.systemId">
                <div class="notebook__head">
                  <v-chip x-small outlined :color="entry.statusColor" data-note-status-chip>{{ entry.statusText }}</v-chip>
                  <span class="notebook__text" data-note-title-text>{{ entry.title }}</span>
                  <v-chip v-if="entry.link" x-small :color="entry.link.color" :text-color="entry.link.color ? 'white' : undefined" :title="entry.link.reason" :data-link-status="entry.link.status">{{ entry.target.label }}: {{ entry.target.name }}<template v-if="entry.link.nowNamed"> (now {{ entry.link.nowNamed }})</template> · {{ entry.link.word }}</v-chip>
                  <v-chip v-if="entry.stale" x-small color="warning" text-color="white" data-note-stale-chip>Stale</v-chip>
                </div>
                <div v-if="entry.next" class="caption" data-note-next-text>Next: {{ entry.next }}</div>
                <div class="caption text--secondary" data-note-place>
                  {{ entry.placeText }}
                  <page-link v-if="entry.place.systemId !== null" class="ml-1" :to="linkTo.map(entry.place.systemId)" :name="entry.place.systemName" />
                  · {{ entry.policy === 'branch' ? 'Kept for this branch only' : 'Kept for every branch of the campaign' }}<template v-if="entry.otherBranch">, made on another branch</template>
                </div>
                <div v-if="entry.stale" class="caption" data-note-stale-note>{{ entry.staleText }}</div>
                <div v-else-if="entry.link && entry.link.status !== 'linked'" class="caption" data-note-link-note>{{ entry.link.reason }}<template v-if="entry.holderName">. An object with this ID that matches what was linked is now named {{ entry.holderName }}; nothing shows it is the same one.</template></div>
                <div class="notebook__actions">
                  <v-btn x-small text :disabled="busy" data-note-edit @click="edit(entry)">Edit</v-btn>
                  <v-btn v-if="confirm !== entry.uuid" x-small text color="error" :disabled="busy" data-note-delete @click="confirm = entry.uuid">Delete</v-btn>
                  <template v-else>
                    <v-btn x-small depressed color="error" :disabled="busy" data-note-delete-confirm @click="remove(entry)">Delete it</v-btn>
                    <v-btn x-small text data-note-delete-cancel @click="confirm = null">Keep</v-btn>
                  </template>
                </div>
              </div>
            </div>
            <div v-else-if="scope && !read.error" class="caption text--secondary" data-note-empty>{{ entries.length ? 'No note is in this system.' : 'No notes yet for this race' }}{{ read.notes.length ? ', apart from ' + read.notes.length + ' that this version cannot read' : '' }}.</div>
            <div v-for="note in read.notes" :key="note.uuid" class="caption text--secondary mt-1" data-note-unreadable>{{ note.reason }}</div>
            <div class="caption text--secondary mt-3" data-note-limits>A note is checked against this save each time and is never moved to another object by its name: a rename keeps the link and shows the new name, and an object that has gone leaves the note stale with the name and system it had when the note was last kept. A colony and a designed tech have no date in the save and an ID can be given again, so the link to one reads not checked and the note shows what holds that ID now, apart from the link. A body in a system found after the branches parted, or a fleet with no creation entry, reads not checked on another branch. A note is kept for this branch unless it is shared; another race or branch never lists it. Nothing here gives an order or writes the save.</div>
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChangeDigest from '../components/notebook/ChangeDigest.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import loadState from '../mixins/load-state'
import { readRegistry } from '../utilities/campaign'
import { linkTo } from '../utilities/deep-links'
import { recordingStateOf } from '../utilities/economy-digest'
import { ALL_SYSTEMS, NEXT_LENGTH, NOTE_STATUSES, NOTE_TARGETS, NOTE_TARGET_KEYS, TITLE_LENGTH, bodyIdsOf, deleteNote, filterBySystem, loadBodies, loadNoteObjects, noteChoices, readNotes, registerEconomyNotes, saveNote, scopeOf, systemOptions, withBodies } from '../utilities/economy-notes'
import { campaignStorage } from '../utilities/history'
import { LINK_STATUS_TEXT, branchLineage } from '../utilities/history-milestones'
import { tracked } from '../utilities/load-tracking'

const INPUT_LABELS = {
  objects: 'the colonies, fleets, techs and systems',
  installationNames: 'the installation types',
}

const LINK_WORDS = { linked: 'linked', missing: 'gone', changed: 'changed', unknown: 'not checked', ambiguous: 'ambiguous' }

const STATUS_COLORS = { 'in-progress': 'primary', blocked: 'error', done: 'success' }

const blankDraft = () => ({ uuid: null, revision: null, kind: 'body', systemId: null, pick: null, unresearched: false, title: '', status: 'idea', next: '', campaignWide: false, scopeKey: null })

// A link as the list shows it: the status in words, the colour of its chip and the reason in full.
const linkView = (link) => ({ ...link, color: link.status === 'linked' ? undefined : link.status === 'unknown' ? 'grey' : 'warning', word: LINK_WORDS[link.status] || link.status, reason: link.reason || LINK_STATUS_TEXT[link.status] || '' })

export default {
  name: 'NotebookPage',
  components: { ChangeDigest, LoadState, PageLink },
  mixins: [loadState(INPUT_LABELS)],
  data() {
    return {
      linkTo,
      statuses: NOTE_STATUSES,
      titleLength: TITLE_LENGTH,
      nextLength: NEXT_LENGTH,
      // The repository's revision of what was read (bumped by each write), the form's draft, the system the list is filtered to, the entry whose deletion waits for a second click, the message of the last action and the conflict of a stale edit.
      revision: 0,
      draft: blankDraft(),
      filterSystem: ALL_SYSTEMS,
      confirm: null,
      message: '',
      messageType: 'info',
      conflict: null,
      busy: false,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID', 'StartYear']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    historyRevision() {
      return this.$store.state.history.revision
    },

    // What the recorder has reported for the open save: '' only once a pass of it wrote the empire's snapshot of this game on this copy of the save, the stage of its failure, or 'pending' (a pass still running, or none yet): the digest then compares nothing.
    recording() {
      return recordingStateOf(this.$store.state.history, this.GameID, this.$store.state.freshness.generation)
    },

    // The notes the digest compares, null while they cannot be read whole (no repository, no settled scope, a refused read, or a note this version cannot read, which is there but not listed and so would read as removed).
    digestNotes() {
      return this.repository && this.scope && !this.read.error && !this.read.notes.length ? this.read.entries : null
    },

    // The campaign and branch the recorder settled this game to, null until it has.
    resolved() {
      return this.$store.getters['history/campaign']
    },

    repository() {
      return this.records ? this.records.repository : null
    },

    // The scope the notes are read and kept in: the race, the campaign and the branch of the open save.
    scope() {
      return scopeOf({ campaign: this.resolved, RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // What a draft of the form belongs to: the campaign, the race and the branch. A draft is dropped when it changes, and one that is saved after it did not is refused.
    scopeKey() {
      const scope = this.scope

      return scope ? [scope.campaignId, scope.RaceID, scope.branchId].join('|') : ''
    },

    // The branches of the open campaign as the registry holds them (the branch each left and the game time it left it at), for telling whether an object that a link names is the same one on the branch of the open save. Null when the registry cannot be read here.
    branches() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision

      const open = this.resolved

      if (!open) {
        return null
      }

      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[open.campaignId])
      } catch (error) {
        return null
      }
    },

    // The notes read without the save's objects: which bodies they link to.
    base() {
      // eslint-disable-next-line no-unused-expressions
      this.revision + this.$store.state.history.revision

      return readNotes(this.repository, this.scope)
    },

    bodyIds() {
      return bodyIdsOf(this.base.entries)
    },

    // The system the form picks a body from, null for none.
    pickedSystemId() {
      return this.draft.kind === 'body' && this.draft.systemId !== null && this.draft.systemId !== undefined ? this.draft.systemId : null
    },

    // The objects and the bodies as read for the game and race shown and the save open now: the read that is still running for another save or race leaves the last one in place, and it is not used.
    objectsBundle() {
      const bundle = this.objectsRead

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // The bodies as read for the save, game and race shown, and only when that read asked for every body the notes link to now: a read made before the notes were loaded, or for other IDs, proves nothing about a body it did not ask for, so it is not used and those bodies read not checked until their own read is in.
    bodiesBundle() {
      const bundle = this.bodiesRead

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID && this.bodyIds.every((id) => bundle.requested.has(id)) ? bundle : null
    },

    // What the links are checked against: the open save's objects for the race shown, with its campaign, branch and the campaign's branches.
    context() {
      const bundle = this.objectsBundle
      const open = this.resolved

      if (!bundle || !open || !this.scope) {
        return null
      }

      const loaded = withBodies(bundle, this.bodiesBundle ? this.bodiesBundle.bodies : null)

      return { objects: loaded.objects, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId, branches: this.branches }
    },

    read() {
      // eslint-disable-next-line no-unused-expressions
      this.revision + this.$store.state.history.revision

      return readNotes(this.repository, this.scope, this.context)
    },

    // Each note with its link in words, the colour of its status, where it is and, when it is stale, what it last was.
    entries() {
      return this.read.entries.map((entry) => ({
        ...entry,
        statusColor: STATUS_COLORS[entry.status],
        link: entry.link ? linkView(entry.link) : null,
        placeText: entry.place.systemId === null ? (entry.target.type === 'tech' || entry.target.type === 'design' ? 'Not tied to a system' : 'No system known') : `${entry.place.lastKnown ? 'Last known in' : 'In'} ${entry.place.systemName || `system ${entry.place.systemId}`}`,
        staleText: `The ${entry.target.label.toLowerCase()} ${entry.link && entry.link.status === 'missing' ? 'is no longer in this save' : 'with this ID is no longer the one that was linked'}. It was last known as ${entry.target.name}${entry.target.systemName ? ` in ${entry.target.systemName}` : ''}. The note stays as it is: edit it to link another object, or delete it.`,
      }))
    },

    systemFilter() {
      return systemOptions(this.entries)
    },

    shown() {
      return filterBySystem(this.entries, this.filterSystem)
    },

    caption() {
      return this.entries.length ? `${this.entries.length} kept for this race` : 'Keep a plan about one object of the economy'
    },

    // The systems the race knows, for the body picker.
    systems() {
      return this.objectsBundle ? this.objectsBundle.systems : []
    },

    kindItems() {
      const edited = this.edited

      return [
        ...(edited ? [{ text: `Keep the link to the ${edited.target.label.toLowerCase()} ${edited.target.name}`, value: 'keep' }] : []),
        ...NOTE_TARGET_KEYS.map((key) => ({ text: NOTE_TARGETS[key].label, value: key })),
      ]
    },

    pickLabel() {
      return NOTE_TARGETS[this.draft.kind] ? NOTE_TARGETS[this.draft.kind].label : 'Object'
    },

    pickHint() {
      const kind = this.draft.kind
      const failed = this.objectsBundle && this.objectsBundle.failed[kind]

      if (!this.context) {
        return 'Reading the objects of this save'
      }

      if (failed) {
        return `This save cannot give them: ${failed}`
      }

      if (kind === 'body') {
        return this.draft.systemId === null ? 'Pick the system first' : this.bodiesBundle && this.bodiesBundle.error ? `This save cannot give its bodies: ${this.bodiesBundle.error}` : ''
      }

      return kind === 'design' ? 'A tech the race designed: its link reads not checked' : kind === 'colony' ? 'A colony link reads not checked: the save holds no date for it' : ''
    },

    choices() {
      return this.context ? noteChoices(this.context.objects, this.draft.kind, { systemId: this.pickedSystemId, researched: !this.draft.unresearched }) : []
    },

    edited() {
      return this.draft.uuid ? this.read.entries.find((entry) => entry.uuid === this.draft.uuid) || null : null
    },
  },
  watch: {
    // Another campaign, race or branch: a draft of the form (its object picked, the note it edits) belonged to the last one.
    scopeKey() {
      const draft = this.draft

      if (draft.uuid || draft.title || draft.next || draft.pick) {
        this.resetDraft()
        this.failed('The form was emptied: the campaign, race or branch shown changed.', 'info')
      } else {
        this.resetDraft()
      }
    },

    // The last note of a system was deleted or moved: the filter returns to all of them.
    systemFilter(options) {
      if (!options.some((option) => option.value === this.filterSystem)) {
        this.filterSystem = ALL_SYSTEMS
      }
    },
  },
  methods: {
    // Empties the form and what waits on it, for a draft that no longer belongs to what is shown.
    resetDraft() {
      this.draft = blankDraft()
      this.conflict = null
      this.confirm = null
      this.message = ''
    },

    cancel() {
      this.draft = blankDraft()
      this.conflict = null
      this.message = ''
      this.revision += 1
    },

    failed(text, type = 'warning') {
      this.message = text
      this.messageType = type
    },

    picked(pick) {
      if (pick && this.draft.scopeKey === null) {
        this.draft.scopeKey = this.scopeKey
      }
    },

    // Opens a note in the form to edit: it keeps its link unless another object is picked.
    edit(entry) {
      this.draft = { uuid: entry.uuid, revision: entry.revision, kind: 'keep', systemId: null, pick: null, unresearched: false, title: entry.title, status: entry.status, next: entry.next, campaignWide: entry.policy === 'campaign', scopeKey: this.scopeKey }
      this.message = ''
      this.conflict = null
      this.confirm = null
    },

    // Keeps the form's note: a new one, or an edit over the revision the form was opened at. A stale edit is not written unless `overwrite` says so.
    async saveDraft(overwrite = false) {
      const draft = this.draft

      if (draft.scopeKey !== null && draft.scopeKey !== this.scopeKey) {
        this.resetDraft()
        this.failed('The campaign, race or branch shown changed after this form was filled in, so nothing is saved. Fill it in again.')

        return
      }

      const stored = draft.uuid ? this.read.entries.find((entry) => entry.uuid === draft.uuid) : null

      if (draft.uuid && !stored) {
        this.failed('This note is no longer kept, so the edit is not written. Cancel to start again.')

        return
      }

      if (draft.kind !== 'keep' && !draft.pick) {
        this.failed('Pick the object the note is about.')

        return
      }

      const target = draft.kind === 'keep' ? undefined : { type: draft.kind, row: draft.pick.row }

      this.busy = true

      try {
        const outcome = await saveNote(this.repository, this.scope, { entry: stored ? { ...stored, revision: draft.revision } : null, title: draft.title, status: draft.status, next: draft.next, target, context: this.context, policy: draft.campaignWide ? 'campaign' : 'branch', overwrite })

        this.revision += 1

        if (outcome.ok) {
          this.draft = blankDraft()
          this.conflict = null
          this.failed(draft.uuid ? 'The note is saved.' : 'The note is kept.', 'success')
        } else if (outcome.code === 'revision-conflict') {
          this.conflict = { title: outcome.stored.title, status: outcome.stored.status }
          this.message = ''
        } else {
          this.failed(outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    async remove(entry) {
      this.busy = true

      try {
        const outcome = await deleteNote(this.repository, this.scope, entry)

        this.revision += 1
        this.confirm = null

        if (outcome.ok) {
          this.draft = this.draft.uuid === entry.uuid ? blankDraft() : this.draft
          this.failed('The note is deleted.', 'success')
        } else {
          this.failed(outcome.code === 'revision-conflict' ? 'The note was changed elsewhere, so it is not deleted. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },
  },
  asyncComputed: {
    // The names of the installation types, for the digest's installations.
    installationNames: {
      get: tracked('installationNames', async function () {
        if (!this.database) {
          return {}
        }

        const [rows] = await this.database.query('select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name from DIM_PlanetaryInstallation')

        return Object.fromEntries(rows.map((row) => [row.PlanetaryInstallationID, row.Name]))
      }),
      default: {},
    },
    // The repository of scenario records, loaded with the page: its module needs the app's settings store, so a page that is read without it still loads.
    records: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerEconomyNotes(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: error.message })
        }
      },
      default: null,
    },
    // The race's colonies, fleets, techs and designed techs in the open save, and the systems it knows. The read carries the save, game and race it was made for (`objectsBundle` ignores it for another).
    objectsRead: {
      get: tracked('objects', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID) {
          return null
        }

        return Object.freeze({ ...(await loadNoteObjects(database, { GameID, RaceID })), database })
      }),
      default: null,
    },
    // The bodies the notes link to and those of the system the form picks from; read apart so picking a system does not reload the page. A read that fails is kept as an error, never as bodies that are gone.
    bodiesRead: {
      async get() {
        const { database, GameID, RaceID } = this
        const bodyIds = this.bodyIds
        const systemId = this.pickedSystemId

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
</script>

<style lang="scss">
.notebook-page {
  .notebook__form {
    align-items: flex-start;
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 12px;
  }

  .notebook__kind {
    flex: 0 1 220px;
  }

  .notebook__system {
    flex: 0 1 240px;
  }

  .notebook__pick {
    flex: 1 1 300px;
    min-width: 0;
  }

  .notebook__title {
    flex: 1 1 260px;
  }

  .notebook__status {
    flex: 0 1 160px;
  }

  .notebook__next {
    flex: 1 1 300px;
  }

  .notebook__policy {
    flex: 0 0 auto;
  }

  .notebook__filter {
    flex: 0 1 260px;
    max-width: 260px;
  }

  .notebook__actions {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .notebook__row {
    border-top: 1px solid rgba(128, 128, 128, 0.3);
    padding: 8px 0;
  }

  .notebook__row .notebook__actions {
    margin-top: 2px;
  }

  .notebook__head {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .notebook__text {
    flex: 1 1 240px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
</style>
