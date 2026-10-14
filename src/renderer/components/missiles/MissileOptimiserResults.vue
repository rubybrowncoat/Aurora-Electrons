<template>
  <div class="missile-optimiser-results">
    <div v-if="!rows.length" class="text--secondary" data-optimiser="empty">{{ emptyText }}</div>
    <v-simple-table v-else dense class="missile-optimiser-results__table" data-optimiser="table">
      <thead>
        <tr>
          <th v-for="header in headers" :key="header" scope="col">{{ header }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :data-candidate="row.key">
          <td v-for="(cell, at) in row.cells" :key="at" :class="{ 'text--disabled': cell.unknown }">{{ cell.text }}<provenance-mark v-if="cell.result" :result="cell.result" /></td>
        </tr>
      </tbody>
    </v-simple-table>
    <div class="caption text--secondary mt-3" data-optimiser="front-caption">{{ front.caption }}</div>
    <v-simple-table v-if="front.rows.length" dense class="missile-optimiser-results__front" data-optimiser="front">
      <thead>
        <tr>
          <th scope="col">Efficient candidate</th>
          <th v-for="header in front.headers" :key="header" scope="col">{{ header }}</th>
          <th scope="col">Alike</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in front.rows" :key="row.key">
          <td>{{ row.key }}</td>
          <td v-for="(cell, at) in row.cells" :key="at" :class="{ 'text--disabled': cell.unknown }">{{ cell.text }}<provenance-mark v-if="cell.result" :result="cell.result" /></td>
          <td>{{ row.alike }}</td>
        </tr>
      </tbody>
    </v-simple-table>
    <div v-if="front.omitted > 0" class="caption text--secondary" data-optimiser="front-omitted">The first {{ front.rows.length }} of {{ front.rows.length + front.omitted }} efficient candidates are listed.</div>
  </div>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'

// The result of a run of the missile optimiser: the listed candidates in the goal's order and the efficient front, each figure as the page has written it (an unknown figure as the word, never 0), a figure the rules compute with the mark of how far it can be trusted.
export default {
  name: 'MissileOptimiserResults',
  components: { ProvenanceMark },
  props: {
    headers: { type: Array, required: true },
    rows: { type: Array, required: true },
    front: { type: Object, required: true },
    emptyText: { type: String, default: '' },
  },
}
</script>

<style lang="scss" scoped>
.missile-optimiser-results__table,
.missile-optimiser-results__front {
  white-space: nowrap;
}
</style>
