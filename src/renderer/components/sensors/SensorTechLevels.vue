<template>
  <v-menu offset-y left :close-on-content-click="false" max-width="560" max-height="640">
    <template #activator="{ on, attrs }">
      <v-btn outlined aria-label="Tech levels" data-sensors="tech-button" v-bind="attrs" v-on="on"><v-icon small left>mdi-flask-outline</v-icon>Tech<span v-if="changed">&nbsp;({{ changed }})</span><v-icon v-if="hypothetical" small right color="warning" title="A hypothetical level is in use">mdi-flask-empty-outline</v-icon></v-btn>
    </template>
    <v-card class="pa-4" data-sensors="tech-levels">
      <div class="subtitle-2">Tech levels designed with</div>
      <div class="caption text--secondary mb-2">Each line starts at the level the game designs with. A lower level shows what a sensor built before the latest research would be. The next tech choice is a hypothetical level the race has not researched: every result built on it is marked hypothetical, and a level with a missing prerequisite says so. The three modes use these lines together.</div>
      <div v-if="notice" class="caption warning--text mb-2" data-tech="notice">{{ notice }}</div>
      <div v-for="line in lines" :key="line.type" class="mt-3" :data-tech-line="line.type">
        <v-autocomplete :value="line.selected" :items="line.items" item-text="text" item-value="value" :label="line.label" :disabled="!line.items.length" dense outlined hide-details @change="(id) => $emit('tech', line.type, id)" />
        <v-autocomplete v-if="line.candidates.length" :value="line.candidate" :items="line.candidates" item-text="text" item-value="value" :label="`${line.label}: next tech (hypothetical)`" clearable dense outlined hide-details class="mt-1" @change="(id) => $emit('next', line.type, id)" />
        <div v-if="line.hypothetical" class="caption warning--text pt-1 pl-3" data-tech="hypothetical-line">Hypothetical: the results use a level the race has not researched.</div>
        <div v-if="line.unresolved" class="caption warning--text pt-1 pl-3" data-tech="unresolved-line">{{ line.unresolvedText }}<v-btn x-small text class="ml-1" @click="$emit('forget', line.type)">Forget the choice</v-btn></div>
        <div v-if="line.next" class="d-flex align-center caption text--disabled pt-1 pl-3">Next: {{ line.nextText }}<page-link :to="linkTo.techTree({ tech: line.next.id })" :name="line.next.name" class="ml-1" /></div>
        <div v-else-if="line.candidates.length" class="caption text--disabled pt-1 pl-3">No further level is researchable now.</div>
        <div v-else-if="!line.items.length" class="caption text--disabled pt-1 pl-3">Not researched</div>
      </div>
    </v-card>
  </v-menu>
</template>

<script>
import { linkTo } from '../../utilities/deep-links'
import PageLink from '../page/PageLink.vue'

// The menu of the tech levels the three modes of the Sensor Planner design with, the same researched and hypothetical contract as the Propulsion Planner and the Missile Designer. It holds no state: `lines` are the lines of mixins/tech-levels.js, `changed` the number of lines not at the game's pick, and each edit is emitted: `tech` (line type, a researched level), `next` (line type, a hypothetical next level or null) and `forget` (line type).
export default {
  name: 'SensorTechLevels',
  components: { PageLink },
  props: {
    lines: { type: Array, required: true },
    notice: { type: String, default: '' },
    changed: { type: Number, default: 0 },
  },
  data() {
    return { linkTo }
  },
  computed: {
    hypothetical() {
      return this.lines.some((line) => line.hypothetical)
    },
  },
}
</script>
