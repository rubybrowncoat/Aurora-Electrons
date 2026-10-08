<template>
  <v-container fluid class="about">
    <v-row>
      <v-col cols="12" lg="8">
        <v-card outlined height="100%">
          <v-card-title class="align-baseline">
            <span class="display-1">Aurora Electrons</span>
            <v-chip class="ml-3" small outlined>v{{ version }}</v-chip>
          </v-card-title>
          <v-card-subtitle class="text-overline">Looking Inwards</v-card-subtitle>
          <v-card-text class="text-body-1">
            A desktop companion app for the 4X game Aurora (C#). It opens the game's SQLite save, watches it for changes, and shows its information in new ways, with useful dashboards: plans, forecasts and summaries drawn from the save.
            It covers production, warnings, minerals, colonies, logistics, finances, empire history, intelligence, the galaxy map and the tech tree.
          </v-card-text>
          <v-divider />
          <v-list dense>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-account-outline</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Author</v-list-item-title>
                <v-list-item-subtitle>Matsor Browncoat (GitHub <external-link :href="authorUrl">rubybrowncoat</external-link>)</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-scale-balance</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>License</v-list-item-title>
                <v-list-item-subtitle>MIT. Copyright (c) 2020 rubybrowncoat</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>

      <v-col cols="12" lg="4">
        <v-card outlined height="100%">
          <v-card-title class="subtitle-1">Built with</v-card-title>
          <v-card-text>
            <external-link v-for="item in stack" :key="item.name" :href="item.href" class="stack-link mr-2 mb-2">
              <v-chip small label outlined link>{{ item.name }}</v-chip>
            </external-link>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row>
      <v-col cols="12" md="6" xl="4">
        <v-card outlined height="100%">
          <v-card-title class="subtitle-1">Links</v-card-title>
          <v-list dense>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-github</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Repository</v-list-item-title>
                <v-list-item-subtitle><external-link :href="repoUrl" class="repo-link" /></v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-bug-outline</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Issues</v-list-item-title>
                <v-list-item-subtitle><external-link :href="issuesUrl" class="issues-link" /></v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-forum-outline</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Forum thread</v-list-item-title>
                <v-list-item-subtitle>
                  <external-link v-if="forumUrl" :href="forumUrl" class="forum-link" />
                  <span v-else class="forum-soon">Coming soon</span>
                </v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
          <v-card-text class="pt-0">
            <div class="font-weight-medium">Support and feedback</div>
            Report bugs in the GitHub issues. Updates are posted in the forum thread.
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6" xl="4">
        <v-card outlined height="100%">
          <v-card-title class="subtitle-1">Your data</v-card-title>
          <v-card-text>
            <p>The app only reads your save. The one exception is the map's Save Positions button, which writes system positions back to it.</p>
            <div class="font-weight-medium">Settings</div>
            <div class="path" :class="{ 'path--missing': !settingsPath }">{{ settingsPath || 'Not available in this mode' }}</div>
            <div class="font-weight-medium mt-3">Empire History</div>
            <div class="path" :class="{ 'path--missing': !historyPath }">{{ historyPath || 'Not available in this mode' }}</div>
            <div class="text--secondary mt-1">One file per game, named <code>game-&lt;GameID&gt;.json</code>.</div>
            <template v-if="historyFile">
              <div class="text--secondary mt-1">The open game's file:</div>
              <div class="path">{{ historyFile }}</div>
            </template>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" xl="4">
        <v-card outlined height="100%">
          <v-card-title class="subtitle-1">Credits</v-card-title>
          <v-list dense>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-rocket-launch-outline</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Aurora C#</v-list-item-title>
                <v-list-item-subtitle>The game is Steve Walmsley's. This app is an unofficial companion.</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
            <v-list-item>
              <v-list-item-icon><v-icon>mdi-forum-outline</v-icon></v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Aurora forum</v-list-item-title>
                <v-list-item-subtitle><external-link :href="auroraForumUrl" /></v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>
    </v-row>

    <v-row>
      <v-col cols="12">
        <v-card outlined>
          <v-card-title class="subtitle-1">Contribute</v-card-title>
          <v-card-text class="pb-0">Pull requests and issues are welcome. The short version:</v-card-text>
          <v-list dense>
            <v-list-item v-for="(step, number) in steps" :key="number">
              <v-list-item-avatar size="24" color="primary" class="steps__number">{{ number + 1 }}</v-list-item-avatar>
              <v-list-item-content>
                <v-list-item-title class="steps__text">
                  <template v-for="(part, position) in step">
                    <code v-if="part.code" :key="position">{{ part.code }}</code>
                    <template v-else>{{ part }}</template>
                  </template>
                </v-list-item-title>
              </v-list-item-content>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script>
import { mapGetters } from 'vuex'

import ExternalLink from '../components/ExternalLink.vue'
import { historyConfig } from '../utilities/history'
import { FORUM_URL } from '../utilities/navigation'
import { version } from '../../../package.json'

const REPO_URL = 'https://github.com/rubybrowncoat/Aurora-Electrons'

// The folder part of a file path, with either kind of separator.
const folderOf = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))

export default {
  components: {
    ExternalLink,
  },
  data () {
    return {
      version,
      forumUrl: FORUM_URL,
      repoUrl: REPO_URL,
      issuesUrl: `${REPO_URL}/issues`,
      authorUrl: 'https://github.com/rubybrowncoat',
      auroraForumUrl: 'https://aurora4x.com/',

      stack: [
        { name: 'Electron 16', href: 'https://www.electronjs.org/' },
        { name: 'Vite 7', href: 'https://vite.dev/' },
        { name: 'Vue 2', href: 'https://v2.vuejs.org/' },
        { name: 'Vuetify 2', href: 'https://v2.vuetifyjs.com/' },
        { name: 'Vuex 3', href: 'https://v3.vuex.vuejs.org/' },
        { name: 'Sequelize 6', href: 'https://sequelize.org/' },
        { name: 'SQLite', href: 'https://www.sqlite.org/' },
        { name: 'Chart.js 4', href: 'https://www.chartjs.org/' },
        { name: 'Cytoscape.js 3', href: 'https://js.cytoscape.org/' },
        { name: 'PixiJS 6', href: 'https://pixijs.com/' },
      ],

      // Each step is a list of text and `{ code }` parts.
      steps: [
        ['Fork the repository on GitHub and clone your fork.'],
        ['Install with ', { code: 'yarn install' }, ' (yarn only, npm is rejected).'],
        ['Put a save at ', { code: './AuroraDB.db' }, ', or unzip the sample with ', { code: 'unzip fixtures/AuroraDB.zip' }, '.'],
        ['Run ', { code: 'yarn dev' }, ' for the app, or ', { code: 'yarn web' }, ' for the renderer in a browser.'],
        ['With ', { code: 'yarn web' }, ' running, check every page with ', { code: 'yarn web:smoke' }, '.'],
        ['Lint only the files you touched. The repo-wide baseline is not clean.'],
        ['Commit as ', { code: '<gitmoji> Summary description' }, ', capitalized, with no trailing period.'],
        ['Open a pull request.'],
      ],
    }
  },
  computed: {
    ...mapGetters([
      'config',
      'GameID',
    ]),

    settingsPath () {
      return (this.config && this.config.path) || ''
    },
    // The open game's history file, once a game is picked.
    historyFile () {
      return this.GameID ? historyConfig(this.GameID).path || '' : ''
    },
    // The folder the history files live in: the open game's file locates it, else it sits beside the settings.
    historyPath () {
      if (this.historyFile) {
        return folderOf(this.historyFile)
      }

      return this.settingsPath ? `${folderOf(this.settingsPath)}/history` : ''
    },
  },
}
</script>

<style lang="scss" scoped>
.path {
  font-family: var(--ae-mono);
  font-size: 12px;
  word-break: break-all;
  color: var(--ae-muted);
}

.path--missing {
  font-family: inherit;
  font-style: italic;
}

.stack-link {
  display: inline-block;

  &:hover {
    text-decoration: none;
  }

  .v-chip:hover {
    border-color: var(--ae-primary);
    color: var(--ae-primary);
  }
}

.steps__text {
  white-space: normal;
}

.steps__number {
  justify-content: center;
  color: #fff;
  font-size: 12px;
}

code {
  padding: 1px 6px;
  border: 1px solid var(--ae-border);
  border-radius: 4px;
  box-shadow: none;
  background: var(--ae-chrome);
  color: var(--ae-ink);
  font-family: var(--ae-mono);
  font-size: 12px;
}
</style>
