<template>
  <div class="world-tags" :class="{ 'world-tags--compact': compact }">
    <v-alert v-if="problem" type="info" outlined dense data-tag-problem>{{ problem }}</v-alert>
    <template v-else>
      <div class="world-tags__form" data-tag-form>
        <v-autocomplete v-if="systems" :value="systemId" :items="systems" item-text="name" item-value="id" label="System" dense outlined clearable hide-details class="world-tags__system" data-tag-system @change="pickSystem" />
        <v-autocomplete v-model="pick" :items="choices" item-text="text" item-value="id" return-object label="Body" :disabled="!choices.length" :hint="hint || pickHint" persistent-hint dense outlined clearable class="world-tags__pick" data-tag-pick @change="picked" />
        <v-text-field v-model="text" :list="listId" label="Tag" :counter="length" dense outlined class="world-tags__text" data-tag-text />
        <datalist :id="listId">
          <option v-for="suggestion in suggestions" :key="suggestion" :value="suggestion" />
        </datalist>
        <v-btn small depressed color="primary" :disabled="busy || !pick || !text.trim()" data-tag-save @click="add">Tag the body</v-btn>
      </div>
      <v-alert v-if="message" :type="messageType" outlined dense class="mt-2" data-tag-message>{{ message }}</v-alert>
      <div v-if="rows.length" class="world-tags__list" data-tag-list>
        <div v-for="row in rows" :key="row.uuid" class="world-tags__row" :data-tag="row.uuid" :data-tag-text-of="row.tag" :data-tag-stale="row.stale" :data-tag-system="row.place.systemId === null ? 'none' : row.place.systemId" :data-tag-link="row.link ? row.link.status : 'none'">
          <div class="world-tags__head">
            <v-chip small outlined data-tag-chip>{{ row.tag }}</v-chip>
            <span class="world-tags__body" data-tag-body>{{ row.kind }}: {{ row.target.name }}<template v-if="row.link && row.link.nowNamed"> (now {{ row.link.nowNamed }})</template></span>
            <v-chip v-if="row.stale" x-small color="warning" text-color="white" data-tag-stale-chip>Stale</v-chip>
            <v-chip v-else-if="row.link && row.link.status !== 'linked'" x-small color="grey" text-color="white" :title="row.link.reason" data-tag-link-chip>Not checked</v-chip>
          </div>
          <div class="caption text--secondary" data-tag-place>
            {{ row.place.systemId === null ? 'No system known' : `${row.place.lastKnown ? 'Last known in' : 'In'} ${row.place.systemName || `system ${row.place.systemId}`}` }}
            <page-link v-if="showSystem && row.place.systemId !== null" class="ml-1" :to="linkTo.map(row.place.systemId)" :name="row.place.systemName" />
          </div>
          <div v-if="row.stale" class="caption" data-tag-stale-note>{{ row.staleText }}</div>
          <div v-else-if="row.link && row.link.status === 'unknown'" class="caption" data-tag-link-note>{{ row.link.reason }}</div>
          <div v-if="row.rewound" class="caption" data-tag-rewind>{{ row.rewound }}</div>
          <div v-if="editing === row.uuid" class="world-tags__edit">
            <v-text-field v-model="editText" :list="listId" :counter="length" label="Tag" dense outlined hide-details class="world-tags__text" data-tag-edit-text />
            <v-btn x-small depressed color="primary" :disabled="busy || !editText.trim()" data-tag-edit-save @click="change(row)">Save</v-btn>
            <v-btn x-small text data-tag-edit-cancel @click="editing = null">Cancel</v-btn>
          </div>
          <div v-else class="world-tags__actions">
            <v-btn x-small text :disabled="busy" data-tag-edit @click="edit(row)">Change</v-btn>
            <v-btn v-if="confirm !== row.uuid" x-small text color="error" :disabled="busy" data-tag-clear @click="ask(row)">Clear</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-tag-clear-confirm @click="remove(row)">Clear it</v-btn>
              <v-btn x-small text data-tag-clear-cancel @click="confirm = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>
      <div v-else class="caption text--secondary mt-2" data-tag-empty>{{ empty }}</div>
    </template>
    <div v-if="!compact" class="caption text--secondary mt-3" data-tag-rule>{{ RULE }}</div>
  </div>
</template>

<script>
import PageLink from '../page/PageLink.vue'
import { linkTo } from '../../utilities/deep-links'
import { gameDateText } from '../../utilities/history-milestones'
import { TAG_LENGTH } from '../../utilities/world-tags'

// Which body a tag can be put on, how it is checked and what it never touches: shown once where tags are kept and listed.
const RULE = 'A tag can be put on any planet, moon, asteroid or comet of a system the race knows, surveyed or not, because the game lists every body of a known system (the ruins and ancient constructs the map marks also need the body surveyed; a tag does not). A tag is on that body alone, never on its planet or its system, and never changes a cluster or a border. It is checked against the save each time and is never moved to another body by its name: a body that is gone, or that is no longer the one that was tagged, leaves the tag listed as stale with the name and system it had. A save from before the system was found holds no such body, so the tag reads gone or changed there and matches again in a later save. Another race, branch or campaign never lists a tag. Nothing here gives an order to the game or writes the save.'

// The tags of the race's bodies, as a form to put a tag on a body and the list of the tags it is given: the part of the Notebook and the Galaxy Map that both create, change and clear the tags of one store (mixins/world-tags.js). The parent filters the tags it passes in (`entries`) and does the writing (`save`, `retag` and `clear` are its functions, each answering with whether the change was made).
export default {
  components: { PageLink },
  props: {
    // The tags to list.
    entries: { type: Array, required: true },
    // The bodies the form offers, and the tag texts in use.
    choices: { type: Array, default: () => [] },
    suggestions: { type: Array, default: () => [] },
    // The systems to pick from and the one picked (`.sync`), or null where the parent has picked the system already.
    systems: { type: Array, default: null },
    systemId: { type: Number, default: null },
    hint: { type: String, default: '' },
    // Why tags cannot be kept here, or ''.
    problem: { type: String, default: '' },
    message: { type: String, default: '' },
    messageType: { type: String, default: 'info' },
    busy: { type: Boolean, default: false },
    // What the form belongs to: a change of it drops the form.
    scopeKey: { type: String, default: '' },
    startYear: { type: [Number, String], default: 0 },
    empty: { type: String, default: 'No body is tagged.' },
    compact: { type: Boolean, default: false },
    showSystem: { type: Boolean, default: false },
    save: { type: Function, required: true },
    retag: { type: Function, required: true },
    clear: { type: Function, required: true },
    // What the form records when a body is picked, to make its tag over: `expect(row)` gives the tag the body has now or that it has none (answered by the parent over all of the branch's tags).
    expect: { type: Function, required: true },
  },
  data() {
    return {
      RULE,
      linkTo,
      length: TAG_LENGTH,
      pick: null,
      // What the picked body's tag was when it was picked, `{ id, value }`: a tag made or changed elsewhere after that is a conflict and never written over.
      expected: null,
      text: '',
      // The scope the form was filled in for.
      filledFor: null,
      editing: null,
      editText: '',
      confirm: null,
      // The tags as listed when the change or the clear was opened: what is saved is over that revision, so a change made elsewhere meanwhile is a conflict and is never overwritten.
      editEntry: null,
      confirmEntry: null,
    }
  },
  computed: {
    listId() {
      return `world-tags-${this._uid}`
    },

    pickHint() {
      return this.systems && this.systemId === null ? 'Pick the system first' : ''
    },

    // Each tag with what its row says besides the tag: why it is stale, and what a save from before it was made means for it.
    rows() {
      return this.entries.map((entry) => ({
        ...entry,
        staleText: `The body ${entry.link && entry.link.status === 'missing' ? 'is no longer in this save' : 'with this ID is no longer the one that was tagged'}. It was last known as ${entry.target.name}${entry.target.systemName ? ` in ${entry.target.systemName}` : ''}. The tag stays as it is: clear it, or tag the body again, which makes a new tag.`,
        rewound: entry.ahead && entry.link && entry.link.status !== 'linked' ? `This save is from before the tag was made.${entry.discoveredAt === null ? '' : ` The body's system was found on ${gameDateText(this.startYear, entry.discoveredAt)}, and a save from before then does not hold the body.`} The tag matches again in a save from after the system was found.` : '',
      }))
    },
  },
  watch: {
    scopeKey() {
      this.pick = null
      this.text = ''
      this.filledFor = null
      this.editing = null
      this.confirm = null
      this.editEntry = null
      this.confirmEntry = null
    },

    // The bodies of another system, or none: the one picked is not among them.
    choices(choices) {
      if (this.pick && !choices.some((choice) => choice.id === this.pick.id)) {
        this.pick = null
      }
    },
  },
  methods: {
    pickSystem(id) {
      this.pick = null
      this.$emit('update:systemId', id === undefined || id === null ? null : id)
    },

    picked(pick) {
      this.expected = pick ? { id: pick.id, value: this.expect(pick.row) } : null

      if (pick && this.filledFor === null) {
        this.filledFor = this.scopeKey
      }
    },

    async add() {
      const expected = this.expected && this.expected.id === this.pick.id ? this.expected.value : null

      if (await this.save({ row: this.pick.row, tag: this.text, expected, scopeKey: this.filledFor === null ? this.scopeKey : this.filledFor })) {
        this.pick = null
        this.expected = null
        this.text = ''
        this.filledFor = null
      }
    },

    edit(row) {
      this.editing = row.uuid
      this.editEntry = this.entries.find((entry) => entry.uuid === row.uuid) || null
      this.editText = row.tag
      this.confirm = null
      this.confirmEntry = null
    },

    ask(row) {
      this.confirm = row.uuid
      this.confirmEntry = this.entries.find((entry) => entry.uuid === row.uuid) || null
    },

    async change(row) {
      if (this.editing === row.uuid && this.editEntry && await this.retag({ entry: this.editEntry, tag: this.editText, scopeKey: this.scopeKey })) {
        this.editing = null
        this.editEntry = null
      }
    },

    async remove(row) {
      if (this.confirm === row.uuid && this.confirmEntry) {
        await this.clear(this.confirmEntry)
      }

      this.confirm = null
      this.confirmEntry = null
    },
  },
}
</script>

<style lang="scss">
.world-tags {
  .world-tags__form {
    align-items: flex-start;
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .world-tags__system {
    flex: 0 1 240px;
  }

  .world-tags__pick {
    flex: 1 1 260px;
    min-width: 0;
  }

  .world-tags__text {
    flex: 1 1 200px;
    min-width: 0;
  }

  .world-tags__form > .v-btn {
    margin-top: 4px;
  }

  .world-tags__row {
    border-top: 1px solid rgba(128, 128, 128, 0.3);
    padding: 8px 0;
  }

  .world-tags__head {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .world-tags__body {
    flex: 1 1 160px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .world-tags__actions,
  .world-tags__edit {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    margin-top: 2px;
  }

  .world-tags__list {
    margin-top: 8px;
  }
}

.world-tags--compact {
  .world-tags__form {
    flex-direction: column;
    align-items: stretch;
  }

  .world-tags__pick,
  .world-tags__text {
    flex: 0 0 auto;
  }
}
</style>
