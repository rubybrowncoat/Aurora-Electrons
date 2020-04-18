<template>
  <div>
    <app-header />
    
    <div class="columns">
      <div class="column is-one-fifth">
        <b-menu class="games-menu">
          <b-menu-list label="Games">
            <b-menu-item
              v-for="game in games"
              :key="game.GameID"
              :label="game.GameName"
              @click="changeGame({ gameId: game.GameID })"
            ></b-menu-item>
          </b-menu-list>
        </b-menu>
      </div>

      <div class="column">
        <div class="corpus">
          <nuxt />
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.column {
  padding-bottom: 0;
}

.corpus {
  min-height: calc(100vh - 52px);
  background: linear-gradient(to right, #ece9e6, #ffffff);

  padding: 30px 50px;
}

.games-menu {
  padding: 20px 0 20px 20px;
}
</style>

<script>
import appHeader from '@/components/header'
import { mapActions, mapGetters } from 'vuex'

export default {
  components: { appHeader },
  methods: {
    ...mapActions([
      'changeGame',
    ]),
  },
  computed: {
    ...mapGetters([
      'database',
    ]),
  },
  asyncComputed: {
    games: {
      async get() {
        if (!this.database || !this.database.models.game) {
          return []
        }

        return await this.database.models.game.findAll()
      }, 
      default: [],
    },
  }
}
</script>
