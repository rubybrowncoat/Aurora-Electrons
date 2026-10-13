<template>
  <div>
    <v-container fluid class="about-page">
      <v-row class="my-0">
        <v-col cols="12" md="6" class="d-flex flex-column py-0">
          <v-card class="panel flex-grow-1" data-summary="What this app is, its version and who made it. Use it to check which release is running." elevation="1">
            <div class="panel-head">
              <span class="d-flex align-center">
                <span>Aurora Electrons</span>
                <v-chip small class="ml-3">v{{ version }}</v-chip>
              </span>
              <span class="caption text--secondary">Looking Inwards</span>
            </div>
            <div class="panel-body body-2">A desktop companion app for the 4X game Aurora (C#). It opens the game's SQLite save, watches it for changes, and shows its information in new ways, with useful dashboards: plans, forecasts and summaries drawn from the save. It covers production, warnings, minerals, colonies, logistics, finances, empire history, intelligence, the galaxy map and the tech tree.</div>
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
              <v-list-item>
                <v-list-item-icon><v-icon>mdi-rocket-launch-outline</v-icon></v-list-item-icon>
                <v-list-item-content>
                  <v-list-item-title>Aurora C#</v-list-item-title>
                  <v-list-item-subtitle class="text-wrap">The game is Steve Walmsley's (<external-link :href="auroraForumUrl">Aurora forum</external-link>). This app is an unofficial companion.</v-list-item-subtitle>
                </v-list-item-content>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>

        <v-col cols="12" md="6" class="d-flex flex-column py-0">
          <v-card class="panel flex-grow-1" data-summary="Places to report bugs, follow updates and discuss the app. Use them to get help or share feedback." elevation="1">
            <div class="panel-head"><span>Links</span></div>
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
            <div class="panel-foot caption text--secondary">Report bugs in the GitHub issues. Updates are posted in the forum thread.</div>
          </v-card>
        </v-col>

        <v-col cols="12" md="6" class="d-flex flex-column py-0">
          <v-card class="panel flex-grow-1" data-summary="Where the app keeps its settings and Empire History files on disk. Use it to find them or back them up." elevation="1">
            <div class="panel-head">
              <span>Data</span>
              <v-btn v-if="dataFolder" small outlined @click="openDataFolder"><v-icon small left>mdi-folder-open-outline</v-icon>Open folder</v-btn>
            </div>
            <div class="panel-body body-2">
              <div class="font-weight-medium">Settings</div>
              <div class="path" :class="{ 'path--missing': !settingsPath }">{{ settingsPath || 'Not available in this mode' }}</div>
              <div class="font-weight-medium mt-3">Empire History</div>
              <div class="path" :class="{ 'path--missing': !historyPath }">{{ historyPath || 'Not available in this mode' }}</div>
              <div class="caption text--secondary mt-1">One file per game, named <code>game-&lt;GameID&gt;.json</code>.</div>
              <template v-if="historyFile">
                <div class="caption text--secondary mt-1">The open game's file:</div>
                <div class="path">{{ historyFile }}</div>
              </template>
            </div>
            <div class="panel-foot caption text--secondary">The app only reads the save. The one exception is the Galaxy Map's Save Positions button, which writes system positions back to it. Settings can reset the views the pages remember.</div>
          </v-card>
        </v-col>

        <v-col cols="12" md="6" class="d-flex flex-column py-0">
          <v-card class="panel flex-grow-1" data-summary="The libraries and tools this app is built on. Use the links to read about any of them." elevation="1">
            <div class="panel-head"><span>Built with</span></div>
            <div class="panel-body">
              <external-link v-for="item in stack" :key="item.name" :href="item.href" class="stack-link mr-2 mb-2">
                <v-chip small label outlined link>{{ item.name }}</v-chip>
              </external-link>
            </div>
          </v-card>
        </v-col>

        <v-col cols="12" class="py-0">
          <v-card class="panel" data-summary="The fonts and icons the app ships and the community themes the colour presets are adapted from, who made them and the terms they come under. Open a notice to read the license text bundled with the app." elevation="1" data-credits>
            <div class="panel-head"><span>Credits</span></div>
            <v-simple-table class="credits-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Author</th>
                  <th>Source</th>
                  <th>License</th>
                  <th>Changes</th>
                  <th>Notices</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="credit in credits" :key="credit.id" :data-credit="credit.id">
                  <td>
                    <div class="font-weight-medium">{{ credit.name }}</div>
                    <div class="caption text--secondary">{{ credit.kind }} · {{ credit.covers }}</div>
                    <div class="caption"><span class="font-weight-medium">{{ credit.reuse.kind }}.</span> {{ credit.reuse.detail }}</div>
                  </td>
                  <td>{{ credit.author }}</td>
                  <td class="text-no-wrap"><external-link :href="credit.source.href">{{ credit.source.label }}</external-link></td>
                  <td><external-link :href="credit.license.href">{{ credit.license.label }}</external-link></td>
                  <td>{{ credit.modifications }}</td>
                  <td class="text-no-wrap">
                    <button v-for="item in credit.notices" :key="item.title" type="button" class="credit-notice" :data-notice="item.title" @click="openNotice(credit, item)">{{ item.title }}</button>
                  </td>
                </tr>
              </tbody>
            </v-simple-table>
            <div class="panel-foot caption text--secondary">Each notice is the license text as it comes with the asset's package, or with the community themes the presets are adapted from, bundled into the app. Bundled files ship in the app; visual inspiration copies no code, image or font, and its notice is shown for provenance. Code libraries carry their licenses in their own packages; they are listed under Built with. Material not listed here, such as the game's flags and portraits, is read from the Aurora install and not shipped.</div>
          </v-card>
        </v-col>

        <v-col cols="12" class="py-0">
          <v-card class="panel" data-summary="How to help improve the app with pull requests and issues. Follow the steps to get a change in." elevation="1">
            <div class="panel-head"><span>Contribute</span></div>
            <div class="panel-body body-2 pb-0">Pull requests and issues are welcome. The short version:</div>
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

      <v-dialog v-model="noticeOpen" max-width="760" scrollable>
        <v-card v-if="notice" data-notice-dialog>
          <v-card-title class="subtitle-1">{{ notice.asset }}: {{ notice.title }}</v-card-title>
          <v-card-text>
            <pre class="notice-text">{{ notice.text }}</pre>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn text @click="noticeOpen = false">Close</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
  </div>
</template>

<script>
import { shell } from 'electron'
import { mapActions, mapGetters } from 'vuex'

import ExternalLink from '../components/ExternalLink.vue'
import { CREDITS } from '../utilities/credits'
import { historyConfig } from '../utilities/history'
import { FORUM_URL } from '../utilities/navigation'
import { version } from '../../../package.json'

const REPO_URL = 'https://github.com/rubybrowncoat/Aurora-Electrons'

// The folder part of a file path, with either kind of separator; empty for a path without a folder (web mode's localStorage keys).
const folderOf = (path) => {
  const end = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return end > 0 ? path.slice(0, end) : ''
}

export default {
  name: 'AboutPage',
  components: {
    ExternalLink,
  },
  data() {
    return {
      version,
      forumUrl: FORUM_URL,
      repoUrl: REPO_URL,
      issuesUrl: `${REPO_URL}/issues`,
      authorUrl: 'https://github.com/rubybrowncoat',
      auroraForumUrl: 'https://aurora4x.com/',

      stack: [
        { name: 'Electron 44', href: 'https://www.electronjs.org/' },
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

      credits: CREDITS,
      // The notice the dialog shows: { asset, title, text }.
      notice: null,
      noticeOpen: false,

      // Each step is a list of text and `{ code }` parts.
      steps: [
        ['Fork the repository on GitHub and clone the fork.'],
        ['Install with ', { code: 'bun install' }, ' (bun only, other package managers are rejected).'],
        ['Put a save at ', { code: './AuroraDB.db' }, ', or unzip the sample with ', { code: 'unzip fixtures/AuroraDB.zip' }, '.'],
        ['Run ', { code: 'bun run dev' }, ' for the app, or ', { code: 'bun run web' }, ' for the renderer in a browser.'],
        ['With ', { code: 'bun run web' }, ' running, check every page with ', { code: 'bun run web:smoke' }, '.'],
        ['Lint only the files the change touches. The repo-wide baseline is not clean.'],
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

    settingsPath() {
      return (this.config && this.config.path) || ''
    },
    // The app's data folder, which holds the settings file and the history folder.
    dataFolder() {
      return this.settingsPath ? folderOf(this.settingsPath) : ''
    },
    // The open game's history file, once a game is picked.
    historyFile() {
      return this.GameID ? historyConfig(this.GameID).path || '' : ''
    },
    // The folder the history files live in: the open game's file locates it, else it sits beside the settings.
    historyPath() {
      if (this.historyFile) {
        return folderOf(this.historyFile)
      }

      return this.dataFolder ? `${this.dataFolder}/history` : ''
    },
  },
  methods: {
    ...mapActions('snackbar', ['activateSnackbar']),

    openNotice(credit, item) {
      this.notice = { asset: credit.name, title: item.title, text: item.text }
      this.noticeOpen = true
    },

    // The system's file manager opens the folder; it answers with an error message, empty when it opened.
    async openDataFolder() {
      const error = await shell.openPath(this.dataFolder)

      if (error) {
        this.activateSnackbar({ text: `Couldn't open ${this.dataFolder}: ${error}`, color: 'error' })
      }
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

// A list's icons and step numbers line up with the panel's title and text, which sit 24px in (styles/page-chrome.scss).
.panel .v-list-item {
  padding: 0 24px;
}

.steps__text {
  white-space: normal;
}

.steps__number {
  justify-content: center;
  color: var(--ae-on-fill);
  font-size: 12px;
}

// Every cell starts at the same line and keeps the same space below it; the selector matches Vuetify's own cell rule, which sets the padding, so it wins.
.credits-table.v-data-table > .v-data-table__wrapper > table > tbody > tr > td {
  padding-top: 10px;
  padding-bottom: 10px;
  vertical-align: top;
}

// A notice opens in a dialog; it reads as a link, like the source and license beside it.
.credit-notice {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ae-primary);
  text-decoration-line: var(--ae-link-line, none);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }

  &:focus-visible {
    outline: 2px solid var(--ae-primary);
    outline-offset: 2px;
  }
}

.notice-text {
  font-family: var(--ae-mono);
  font-size: 12px;
  white-space: pre-wrap;
  color: var(--ae-ink);
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
