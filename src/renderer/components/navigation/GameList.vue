<template>
  <v-list dense class="game-list">
    <template v-for="game in games">
      <v-subheader :key="`game-${game.GameID}`" :class="{ 'game-list__pick': game.Races.length === 1 }" @click="game.Races.length === 1 ? changeGame({ game }) : null">
        {{ game.GameName }} · {{ game.DateTime.slice(0, 10) }}
      </v-subheader>
      <v-list-item v-for="race in game.Races" :key="`race-${race.RaceID}`" :input-value="game.GameID === GameID && race.RaceID === RaceID" @click="changeGame({ game, race })">
        <v-list-item-icon class="mr-3">
          <v-icon small>mdi-account-multiple</v-icon>
        </v-list-item-icon>
        <v-list-item-title>{{ race.RaceTitle }}</v-list-item-title>
      </v-list-item>
    </template>
  </v-list>
</template>

<script>
import { mapActions, mapGetters } from 'vuex'

export default {
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
  },
  methods: {
    ...mapActions([
      'changeGame',
    ]),
  },
}
</script>

<style lang="scss" scoped>
.game-list__pick {
  cursor: pointer;
}
</style>
