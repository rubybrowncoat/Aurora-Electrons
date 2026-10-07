<template>
  <v-menu offset-x right min-width="260">
    <template #activator="{ on, attrs }">
      <v-avatar class="game-switcher" size="40" color="primary" rounded role="button" tabindex="0" v-bind="attrs" v-on="on" @keydown.enter="on.click">
        <span v-if="initials" class="white--text">{{ initials }}</span>
        <v-icon v-else dark>mdi-tooltip-account</v-icon>
      </v-avatar>
    </template>
    <game-list :games="games" />
  </v-menu>
</template>

<script>
import { mapGetters } from 'vuex'

import GameList from './GameList.vue'

export default {
  components: {
    GameList,
  },
  props: {
    games: {
      type: Array,
      required: true,
    },
  },
  computed: {
    ...mapGetters([
      'GameID',
      'RaceID',
    ]),

    initials () {
      const game = this.games.find(({ GameID }) => GameID === this.GameID)
      const race = game && game.Races.find(({ RaceID }) => RaceID === this.RaceID)

      return race ? race.RaceTitle.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase() : ''
    },
  },
}
</script>

<style lang="scss" scoped>
.game-switcher {
  cursor: pointer;
  font-weight: 500;
  letter-spacing: .04em;
}
</style>
