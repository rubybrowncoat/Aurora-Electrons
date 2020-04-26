<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" :mini-variant.sync="mini" app permanent>
      <v-list-item class="px-2">
        <!-- <v-list-item-avatar>
          <v-img src="https://randomuser.me/api/portraits/men/85.jpg"></v-img>
        </v-list-item-avatar> -->

        <v-list-item-icon>
          <v-icon large>my_location</v-icon>
        </v-list-item-icon>

        <v-list-item-title>Games</v-list-item-title>

        <v-btn icon @click.stop="mini = !mini">
          <v-icon>mdi-chevron-left</v-icon>
        </v-btn>
      </v-list-item>
      <v-divider></v-divider>

      <v-list>
        <template v-for="game in games">
          <v-tooltip :key="game.GameID" right>
            <template #activator="{ on }">
              <v-list-group prepend-icon="domain" :value="game.GameID == GameID" :title="game.GameName" v-if="game.Races.length > 1" v-on="on">
                <template #activator>
                  <v-list-item-title>{{ game.GameName }}</v-list-item-title>
                </template>
                <v-list-item v-for="race in game.Races" :key="race.RaceID" :input-value="race.RaceID == RaceID" @click="changeGame({ game, race })">
                  <v-list-item-icon><v-icon>people</v-icon></v-list-item-icon>
                  <v-list-item-title>
                    {{ race.RaceTitle }}
                  </v-list-item-title>
                </v-list-item>
              </v-list-group>
              <v-list-item :input-value="game.GameID == GameID" @click="changeGame({ game })" v-else v-on="on">
                <v-list-item-icon><v-icon>domain</v-icon></v-list-item-icon>
                <v-list-item-title>
                  {{ game.GameName }}
                </v-list-item-title>
              </v-list-item>
            </template>
            <span>{{ game.GameName }}</span>
          </v-tooltip>
        </template>
      </v-list>
    </v-navigation-drawer>

    <v-app-bar color="pink" dark app>
      <v-toolbar-title color="white">{{ title }}</v-toolbar-title>
      <template #extension>
        <v-tabs>
          <v-tab to="/" @change="title = 'Production Recap'">Production</v-tab>
          <v-tab to="/minerals" @change="title = 'Mineral Breakdown'">Minerals</v-tab>
          <v-tab to="/engines" @change="title = 'Ship Engines'">Engine</v-tab>
          <v-tab to="/technologies" @change="title = 'Technology Tree'">Tech Tree</v-tab>
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
      <div class="overline"><span class="font-weight-bold">Aurora Electrons</span> - Looking Inwards // Engine Formulas by <span class="font-weight-bold">Iceranger</span></div>
    </v-footer>
  </v-app>
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
import { mapActions, mapGetters, mapMutations, mapState } from 'vuex'

export default {
  data() {
    return {
      drawer: true,
      mini: false,

      title: 'Production Recap',
    }
  },
  components: { appHeader },
  methods: {
    ...mapMutations('snackbar', [
      'setActive',
    ]),

    ...mapActions([
      'changeGame',
    ]),
  },
  computed: {
    ...mapState([
      'snackbar',
    ]),

    ...mapGetters([
      'database',

      'GameID',
      'RaceID',
    ]),
    
    snackbarStatus: {
      set(status) {
        this.setActive(status)
      },
      get() {
        return this.snackbar.active
      },
    },
  },
  asyncComputed: {
    games: {
      async get() {
        if (!this.database || !this.database.models.game) {
          return []
        }

        const games = await this.database.models.game.findAll({ 
          where: {
            '$Races.NPR$': 0,
          }, include: [ 
            'Races',
          ]
        })

        return games
      }, 
      default: [],
    },
  }
}
</script>
