<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" :mini-variant.sync="mini" app permanent>
      <v-list-item class="px-2">
        <!-- <v-list-item-avatar>
          <v-img src="https://randomuser.me/api/portraits/men/85.jpg"></v-img>
        </v-list-item-avatar> -->

        <v-list-item-icon>
          <v-icon large>mdi-tooltip-account</v-icon>
        </v-list-item-icon>

        <v-list-item-title>Games</v-list-item-title>

        <v-btn icon @click.stop="mini = !mini">
          <v-icon>mdi-chevron-left</v-icon>
        </v-btn>
      </v-list-item>
      <v-divider />

      <v-list>
        <v-tooltip v-for="game in games" :key="game.GameID" right>
          <template #activator="{ on }">
            <v-list-group prepend-icon="mdi-domain" append-icon :value="game.GameID === GameID" :title="game.GameName" @click="game.Races.length === 1 ? changeGame({ game }) : null" v-on="on">
              <template #activator>
                <v-list-item-content>
                  <v-list-item-title>{{ game.GameName }}</v-list-item-title>
                  <v-list-item-subtitle>{{ game.DateTime }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
              <v-list-item v-for="race in game.Races" :key="race.RaceID" :input-value="race.RaceID === RaceID" @click="changeGame({ game, race })">
                <v-list-item-icon><v-icon>mdi-account-multiple</v-icon></v-list-item-icon>
                <v-list-item-title>
                  {{ race.RaceTitle }}
                </v-list-item-title>
              </v-list-item>
            </v-list-group>
          </template>
          <span>{{ game.GameName }} ({{ game.StartYear }})</span>
        </v-tooltip>
      </v-list>
    </v-navigation-drawer>

    <v-app-bar app>
      <v-toolbar-title>{{ title }}</v-toolbar-title>
      <v-spacer />
      <v-btn icon to="/settings" nuxt>
        <v-icon>mdi-wrench</v-icon>
      </v-btn>
      <v-btn v-if="$vuetify.theme.dark" icon @click="$vuetify.theme.dark = false">
        <v-icon>mdi-lightbulb-on-outline</v-icon>
      </v-btn>
      <v-btn v-else icon @click="$vuetify.theme.dark = true">
        <v-icon>mdi-lightbulb-on</v-icon>
      </v-btn>
      <template #extension>
        <v-tabs v-model="tab" show-arrows center-active :hide-slider="title === 'Settings'">
          <v-tab to="/" nuxt>Production</v-tab>
          <v-tab to="/warnings" nuxt>Warnings</v-tab>
          <v-tab to="/minerals" nuxt>Minerals</v-tab>
          <v-tab to="/habitability" nuxt>Habitability</v-tab>
          <v-tab to="/information" nuxt>Information</v-tab>
          <v-tab to="/map" nuxt>Map (WIP)</v-tab>
          <!-- <v-tab to="/map_old" nuxt>Map Old</v-tab> -->
          <v-tab to="/log" nuxt>Log</v-tab>
          <v-tab to="/technologies" nuxt>Tech Tree</v-tab>
          <v-tab to="/engines" nuxt>Engines (WIP)</v-tab>
        </v-tabs>
      </template>
    </v-app-bar>

    <!-- Sizes your content based upon application components -->
    <v-content>
      <v-snackbar v-model="snackbarStatus" :timeout="2000" :color="snackbar.color">
        {{ snackbar.text }}
        <v-btn dark text @click="snackbarStatus = false">
          Close
        </v-btn>
      </v-snackbar>

      <!-- Provides the application the proper gutter -->
      <v-container fluid>
        <nuxt />
      </v-container>
    </v-content>

    <v-footer app>
      <div class="overline"><span class="font-weight-bold">Aurora Electrons</span> - Looking Inwards</div>
    </v-footer>
  </v-app>
</template>

<script>
import { mapActions, mapGetters, mapMutations, mapState } from 'vuex'
// import AppHeader from '@/components/header'

export default {
  components: {
    // AppHeader
  },
  data () {
    return {
      drawer: true,
      mini: false,

      tab: null,

      // WATCHED CONFIG
      spyNPR: false,
      unsubscribeSpyNPR: null,
    }
  },
  computed: {
    ...mapState([
      'snackbar',
    ]),

    ...mapGetters([
      'config',
      'database',

      'GameID',
      'RaceID',
    ]),

    title () {
      switch (this.$route.name) {
      case 'index': {
        return 'Production Recap'
      }
      case 'warnings': {
        return 'Warnings'
      }
      case 'minerals': {
        return 'Mineral Breakdown'
      }
      case 'habitability': {
        return 'Habitability Breakdown'
      }
      case 'information': {
        return 'Empire Information'
      }
      case 'technologies': {
        return 'Technology Tree'
      }
      case 'map': {
        return 'Galaxy Map'
      }
      case 'settings': {
        return 'Settings'
      }
      case 'log': {
        return 'Game Log Viewer'
      }
      default: {
        return 'Default title'
      }
      }
    },

    snackbarStatus: {
      set (status) {
        this.setActive(status)
      },
      get () {
        return this.snackbar.active
      },
    },
  },
  watch: {
    config: {
      immediate: true,
      handler (config) {
        this.spyNPR = config.get('spyNPR', false)
      },
    },
  },
  mounted () {
    this.themeInit()

    // CONFIG CHANGE SUBSCRIPTION
    const mutationReturn = {}
    this.configDidChange({
      key: 'spyNPR',
      callback: (value) => {
        this.spyNPR = value
      },

      returnant: mutationReturn,
    })

    if (mutationReturn.unsubscribe) {
      this.unsubscribeSpyNPR = mutationReturn.unsubscribe
    }
  },
  beforeDestroy () {
    if (this.unsubscribeSpyNPR) {
      this.unsubscribeSpyNPR()
    }
  },
  methods: {
    ...mapMutations('snackbar', [
      'setActive',
    ]),
    ...mapMutations([
      'configDidChange',
    ]),

    ...mapActions([
      'changeGame',
    ]),

    themeInit () {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

      mediaQuery.addEventListener('change', (e) => {
        console.log('mediaQuery listener', e)
      })

      if (mediaQuery.matches) {
        this.$nextTick(() => {
          this.$vuetify.theme.dark = true
        })
      }
    },
  },
  asyncComputed: {
    games: {
      async get () {
        if (!this.database || !this.database.models.Game) {
          return []
        }

        const games = await this.database.models.Game.findAll({
          include: [{
            model: this.database.models.Race,
            ...(this.spyNPR
              ? null
              : {
                  where: {
                    NPR: false,
                  },
                }),
          }],
        })

        return games
      },
      default: [],
    },
  },
}
</script>

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
