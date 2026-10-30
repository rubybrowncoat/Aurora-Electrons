<template>
  <v-menu offset-y left :close-on-content-click="false" max-width="380" min-width="320" @input="reset">
    <template #activator="{ on, attrs }">
      <v-btn outlined aria-label="Game Log presets" v-bind="attrs" v-on="on"><v-icon small left>mdi-bookmark-multiple-outline</v-icon>Presets<span v-if="presets.length">&nbsp;({{ presets.length }})</span></v-btn>
    </template>
    <v-card class="pa-4 presets">
      <div class="subtitle-2">Saved presets</div>
      <div class="caption text--secondary mt-1">A preset keeps the keywords and the event types selected now. Applying one replaces both; the search, place and dates stay as they are, and types no category lists stay shown.</div>
      <v-list v-if="presets.length" dense class="preset-list mt-2">
        <v-list-item v-for="preset in presets" :key="preset.id" class="preset-item" :class="{ 'preset-item--editing': editing === preset.id }" @click="editing === preset.id ? null : apply(preset)">
          <template v-if="editing === preset.id">
            <v-text-field v-model="editName" label="Name" dense outlined hide-details autofocus :error="!!editProblem" :error-messages="editProblem" @click.stop @keydown.enter.prevent="rename(preset)" @keydown.esc.stop.prevent="editing = null" />
            <v-btn icon small aria-label="Save the name" :disabled="!!editProblem" @click.stop="rename(preset)"><v-icon small>mdi-check</v-icon></v-btn>
            <v-btn icon small aria-label="Cancel renaming" @click.stop="editing = null"><v-icon small>mdi-close</v-icon></v-btn>
          </template>
          <template v-else>
            <v-list-item-content>
              <v-list-item-title>{{ preset.name }}</v-list-item-title>
              <v-list-item-subtitle>{{ describe(preset) }}</v-list-item-subtitle>
            </v-list-item-content>
            <v-list-item-action class="preset-actions">
              <v-btn icon small :aria-label="`Rename ${preset.name}`" title="Rename" @click.stop="startRename(preset)"><v-icon small>mdi-pencil-outline</v-icon></v-btn>
            </v-list-item-action>
            <v-list-item-action class="preset-actions">
              <v-btn icon small :aria-label="`Delete ${preset.name}`" title="Delete" @click.stop="$emit('remove', preset.id)"><v-icon small>mdi-delete-outline</v-icon></v-btn>
            </v-list-item-action>
          </template>
        </v-list-item>
      </v-list>
      <div v-else class="text--secondary mt-2">No presets are saved.</div>
      <v-divider class="my-3" />
      <v-text-field v-model="name" label="Name for the current filters" dense outlined hide-details="auto" :error-messages="problem" @keydown.enter.prevent="save" />
      <div class="caption text--secondary mt-1">{{ describeCurrent }}</div>
      <v-btn small text color="primary" class="mt-2" :disabled="!!problem || !name.trim()" @click="save"><v-icon small left>mdi-content-save-outline</v-icon>Save current filters</v-btn>
    </v-card>
  </v-menu>
</template>

<script>
import { nameProblem } from '../../utilities/event-triage'

// The saved presets of the Game Log: apply, save the current filters under a name, rename, delete. The page owns the list and the filters; this only asks (`apply`, `save` with the name, `rename` with { id, name }, `remove` with the id).
export default {
  props: {
    presets: { type: Array, required: true },
    keywords: { type: Array, required: true },
    // How many event types are selected now, null for every type.
    typeCount: { type: Number, default: null },
  },
  data() {
    return { name: '', editing: null, editName: '' }
  },
  computed: {
    problem() {
      return this.name.trim() ? nameProblem(this.name, this.presets) : null
    },

    editProblem() {
      return this.editing ? nameProblem(this.editName, this.presets, this.editing) : null
    },

    describeCurrent() {
      return `Now: ${this.describe({ keywords: this.keywords, types: this.typeCount === null ? null : { length: this.typeCount } })}.`
    },
  },
  methods: {
    describe(preset) {
      const keywords = preset.keywords.length ? `${preset.keywords.length} keyword${preset.keywords.length === 1 ? '' : 's'}` : 'no keywords'

      return `${keywords} · ${preset.types === null ? 'all types' : `${preset.types.length} type${preset.types.length === 1 ? '' : 's'}`}`
    },

    apply(preset) {
      this.$emit('apply', preset)
    },

    save() {
      if (!this.problem && this.name.trim()) {
        this.$emit('save', this.name.trim())
        this.name = ''
      }
    },

    startRename(preset) {
      this.editing = preset.id
      this.editName = preset.name
    },

    rename(preset) {
      if (!this.editProblem) {
        this.$emit('rename', { id: preset.id, name: this.editName.trim() })
        this.editing = null
      }
    },

    reset(open) {
      if (!open) {
        this.editing = null
        this.name = ''
      }
    },
  },
}
</script>

<style lang="scss" scoped>
.preset-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 0;
}

.preset-item {
  gap: 4px;
}

.preset-actions {
  margin: 0;
}
</style>
