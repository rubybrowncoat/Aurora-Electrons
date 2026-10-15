<template>
  <div class="type-filter-root">
    <v-menu offset-y :close-on-content-click="false" max-height="520" min-width="320">
      <template #activator="{ on, attrs }">
        <v-text-field :value="summary" label="Event types" readonly dense outlined hide-details append-icon="mdi-menu-down" v-bind="attrs" v-on="on" />
      </template>
      <v-card class="type-filter">
        <div class="type-filter-actions">
          <v-btn small text @click="$emit('change', null)">All types</v-btn>
          <v-btn small text @click="$emit('change', [])">No types</v-btn>
        </div>
        <v-divider />
        <v-list dense class="type-filter-list">
          <template v-for="group in groups">
            <v-list-item :key="`group-${group.id}`" class="type-group" role="checkbox" :disabled="!group.types.length" :aria-checked="groupState(group).mixed ? 'mixed' : String(groupState(group).all)" @click="toggleGroup(group)">
              <v-list-item-action class="my-0 mr-3"><v-checkbox :input-value="groupState(group).all" :indeterminate="groupState(group).mixed" readonly hide-details dense class="mt-0 pt-0" /></v-list-item-action>
              <v-list-item-content>
                <v-list-item-title class="font-weight-medium">{{ group.name }} <span class="caption text--secondary">{{ groupCaption(group) }}</span></v-list-item-title>
              </v-list-item-content>
            </v-list-item>
            <v-list-item v-for="type in group.types" :key="`type-${type.value}`" class="type-item" role="checkbox" :aria-checked="String(chosen.has(type.value))" @click="toggleType(type.value)">
              <v-list-item-action class="my-0 mr-3"><v-checkbox :input-value="chosen.has(type.value)" readonly hide-details dense class="mt-0 pt-0" /></v-list-item-action>
              <v-list-item-content><v-list-item-title>{{ type.text }}</v-list-item-title></v-list-item-content>
            </v-list-item>
          </template>
        </v-list>
        <div class="caption text--secondary px-4 py-2">Choose or clear a whole category with its box. Types the app does not know are listed under Other.</div>
      </v-card>
    </v-menu>
  </div>
</template>

<script>
import { toggledGroup } from '../../utilities/event-triage'

// The Game Log's event type selector: the types the log holds, grouped by category (utilities/event-triage.js), each category chosen or cleared as a whole. `groups` is `groupTypes`'s result, `selected` the ids chosen (every type when `all`), and `change` gives the new selection, null for every type.
export default {
  props: {
    groups: { type: Array, required: true },
    selected: { type: Array, required: true },
    all: { type: Boolean, default: false },
  },
  computed: {
    chosen() {
      return new Set(this.selected)
    },

    typeIds() {
      return this.groups.flatMap((group) => group.types.map((type) => type.value))
    },

    summary() {
      return this.all ? 'All types' : `${this.typeIds.filter((id) => this.chosen.has(id)).length} types`
    },
  },
  methods: {
    groupState(group) {
      const count = group.types.filter((type) => this.chosen.has(type.value)).length

      return { count, all: !!group.types.length && count === group.types.length, mixed: count > 0 && count < group.types.length }
    },

    groupCaption(group) {
      return group.types.length ? `${this.groupState(group).count} of ${group.types.length} types` : 'No such types in this log'
    },

    emit(selected) {
      this.$emit('change', this.typeIds.every((id) => selected.includes(id)) ? null : selected)
    },

    toggleGroup(group) {
      this.emit(toggledGroup(this.selected, group.types.map((type) => type.value), !this.groupState(group).all))
    },

    toggleType(id) {
      this.emit(toggledGroup(this.selected, [id], !this.chosen.has(id)))
    },
  },
}
</script>

<style lang="scss" scoped>
.type-filter {
  max-height: 520px;
  overflow-y: auto;
}

.type-filter-actions {
  display: flex;
  gap: 4px;
  padding: 4px 8px;
}

.type-group {
  min-height: 36px;
  background: var(--ae-surface-alt, rgba(128, 128, 128, 0.08));
}

.type-item {
  min-height: 32px;
  padding-left: 32px;
}
</style>
