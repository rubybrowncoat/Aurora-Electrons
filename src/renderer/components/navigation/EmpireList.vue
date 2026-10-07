<template>
  <div class="empire-list">
    <template v-for="game in games">
      <div
        :key="`game-${game.GameID}`"
        class="empire-list__game"
        :class="{ 'empire-list__game--pick': game.Races.length === 1 }"
        @click="game.Races.length === 1 ? pick(game) : null"
      >
        {{ game.GameName }} · {{ game.date }}
      </div>
      <div
        v-for="race in game.Races"
        :key="`race-${race.RaceID}`"
        class="empire-list__race"
        :class="{ 'empire-list__race--active': game.GameID === GameID && race.RaceID === RaceID }"
        role="link"
        tabindex="0"
        @click="pick(game, race)"
        @keydown.enter="pick(game, race)"
      >
        <empire-avatar :race="race" :size="36" class="empire-list__avatar" />
        <div class="empire-list__title">{{ race.RaceTitle }}</div>
        <div>
          <v-chip v-if="race.kind.type === 'player'" x-small label outlined color="primary" data-kind="player">{{ race.kind.label }}</v-chip>
          <v-chip v-else-if="race.kind.type === 'npr'" x-small label data-kind="npr">{{ race.kind.label }}</v-chip>
          <v-chip v-else x-small label dark color="error" data-kind="special"><v-icon x-small left>mdi-skull-outline</v-icon>{{ race.kind.label }}</v-chip>
        </div>
        <div class="empire-list__details">{{ details(race) }}</div>
      </div>
    </template>
  </div>
</template>

<script>
import { mapActions, mapGetters } from 'vuex'

import { empireDetails } from '../../utilities/empires'
import { thousandsSeparator } from '../../utilities/math'
import EmpireAvatar from './EmpireAvatar.vue'

// Every game with its races: the flyout from the rail's Empires entry and the first-run picker. Picking a race
// selects it (a game with one race can be picked from its header). Coloured by `--sc` / `--sc-soft` of whoever styles it.
export default {
  components: {
    EmpireAvatar,
  },
  props: {
    // The shape `loadEmpires` returns.
    games: {
      type: Array,
      required: true,
    },
  },
  computed: {
    ...mapGetters([
      'config',
      'GameID',
      'RaceID',
    ]),

    separator () {
      return thousandsSeparator(this.config.get('selectedSeparator', 'Tick'))
    },
  },
  methods: {
    ...mapActions([
      'changeGame',
    ]),

    details (race) {
      return empireDetails(race, this.separator)
    },
    pick (game, race) {
      this.changeGame({ game, race })
      this.$emit('pick')
    },
  },
}
</script>

<style lang="scss" scoped>
.empire-list__game {
  padding: 12px 10px 6px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .04em;
  color: var(--ae-muted);
}

.empire-list__game--pick {
  cursor: pointer;
}

.empire-list__race {
  display: grid;
  grid-template-columns: 36px 1fr auto;
  gap: 2px 12px;
  align-items: center;
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--ae-ink);

  &:hover {
    background: var(--ae-hover);
  }
}

.empire-list__race--active,
.empire-list__race--active:hover {
  background: var(--sc-soft);
}

.empire-list__avatar {
  grid-row: span 2;
  align-self: start;
}

.empire-list__title {
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
}

.empire-list__details {
  grid-column: 2 / 4;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ae-muted);
}
</style>
