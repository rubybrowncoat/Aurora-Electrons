<template>
  <v-card class="game-picker" :style="neutralStyle" outlined>
    <v-card-title>Pick an empire</v-card-title>
    <template v-if="games.length">
      <v-card-subtitle>Picking one opens {{ targetTitle }}.</v-card-subtitle>
      <empire-list :games="games" class="pb-2 px-2" @pick="open" />
    </template>
    <v-alert v-else-if="databaseError" type="error" text class="mx-4">Couldn't open the save: {{ databaseError }}</v-alert>
    <v-alert v-else-if="error" type="error" text class="mx-4">Couldn't read the save: {{ error }}. The game may be saving; the list reads it again when it changes.</v-alert>
    <v-card-text v-else-if="!database">Waiting for the save{{ savePath ? ` at ${savePath}` : '' }}. It is read from there and loaded again whenever it changes.</v-card-text>
    <v-card-text v-else-if="loaded">No games found in the save.</v-card-text>
  </v-card>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import EmpireList from '../components/navigation/EmpireList.vue'
import { sectionStyle } from '../components/navigation/section-style'
import { pageByRoute } from '../utilities/navigation'

const DEFAULT_PAGE = '/production'

// Where the app starts, and where the rail's Empires entry leads: every game in the save with its empires. Picking one
// selects it and opens the last page that showed a race's data this session, or the Production Recap. Switching from
// the rail's Empires flyout instead keeps the page the user is on.
export default {
  components: {
    EmpireList,
  },
  computed: {
    ...mapState('empires', [
      'games',
      'error',
      'loaded',
    ]),
    ...mapState('navigation', [
      'lastRacePage',
    ]),
    ...mapGetters([
      'database',
      'savePath',
      'databaseError',
    ]),

    neutralStyle () {
      return sectionStyle(this.$vuetify.theme.dark)
    },
    // The page a pick opens.
    target () {
      return this.lastRacePage || DEFAULT_PAGE
    },
    targetTitle () {
      return pageByRoute[this.target.split('?')[0]].title
    },
  },
  methods: {
    open () {
      this.$router.push(this.target)
    },
  },
}
</script>
