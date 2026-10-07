<template>
  <v-app>
    <v-navigation-drawer app permanent mini-variant mini-variant-width="80" class="rail">
      <div
        class="rail__empire"
        :class="{ 'rail__empire--peek': flyoutId === EMPIRES_ID }"
        :style="neutralStyle"
        role="button"
        tabindex="0"
        @click="toggleEmpires"
        @keydown.enter="toggleEmpires"
        @mouseenter="peekSection(EMPIRES_ID)"
        @mouseleave="leaveRail"
      >
        <empire-avatar :race="selectedRace" :size="40" />
        <div class="rail__label">Empires</div>
      </div>

      <div
        v-for="section in railSections"
        :key="section.id"
        class="rail__item"
        :class="{ 'rail__item--active': currentSection === section, 'rail__item--peek': flyoutId === section.id }"
        :style="section.style"
        role="link"
        tabindex="0"
        @click="goSection(section)"
        @keydown.enter="goSection(section)"
        @mouseenter="peekSection(section.id)"
        @mouseleave="leaveRail"
      >
        <div class="rail__pill">
          <v-icon>{{ section.icon }}</v-icon>
        </div>
        <div class="rail__label">{{ section.title }}</div>
      </div>

      <div class="rail__spacer" />

      <div class="rail__item" :class="{ 'rail__item--active': page.route === '/settings' }" :style="neutralStyle" role="link" tabindex="0" @click="go('/settings')" @keydown.enter="go('/settings')">
        <div class="rail__pill">
          <v-icon>mdi-wrench</v-icon>
        </div>
        <div class="rail__label">Settings</div>
      </div>

      <div class="rail__item" :class="{ 'rail__item--active': page.route === '/about' }" :style="neutralStyle" role="link" tabindex="0" @click="go('/about')" @keydown.enter="go('/about')">
        <div class="rail__pill">
          <v-icon>mdi-information-outline</v-icon>
        </div>
        <div class="rail__label">About</div>
      </div>
    </v-navigation-drawer>

    <section-flyout
      v-if="flyoutSection"
      :style="flyoutSection.style"
      :section="flyoutSection"
      :pages="flyoutSection.pages"
      :active-route="page.route"
      :shortcut="railSections.indexOf(flyoutSection) + 1"
      :peeks="peekLines"
      @go="go"
      @mouseenter.native="cancelLeave"
      @mouseleave.native="leaveRail"
    />

    <flyout-panel
      v-if="flyoutId === EMPIRES_ID"
      class="empire-flyout"
      :style="neutralStyle"
      title="Empires"
      :meta="`${raceCount} ${raceCount === 1 ? 'empire' : 'empires'}`"
      :width="380"
      @mouseenter.native="cancelLeave"
      @mouseleave.native="leaveRail"
    >
      <empire-list :games="games" @pick="flyoutId = null" />
      <template #foot><kbd>Esc</kbd> close</template>
    </flyout-panel>

    <v-app-bar app flat height="64" extension-height="44" :extended="tabs.length > 1" class="app-bar">
      <history-buttons />

      <div class="breadcrumb ml-3" :style="pageStyle">
        <template v-if="currentSection">
          <span class="breadcrumb__section hidden-xs-only" @mouseenter="peekSection(currentSection.id)" @mouseleave="leaveRail">{{ currentSection.title }}</span>
          <span class="breadcrumb__separator hidden-xs-only">/</span>
        </template>
        <span class="breadcrumb__title">{{ page.title }}</span>
      </div>

      <v-spacer />

      <div class="search-button" role="button" tabindex="0" @click="openPalette" @keydown.enter="openPalette">
        <v-icon small>mdi-magnify</v-icon>
        <span class="hidden-xs-only">Go to page</span>
        <kbd class="hidden-xs-only">Ctrl K</kbd>
      </div>

      <v-btn v-if="$vuetify.theme.dark" icon @click="setDarkMode(false)">
        <v-icon>mdi-lightbulb-on-outline</v-icon>
      </v-btn>
      <v-btn v-else icon @click="setDarkMode(true)">
        <v-icon>mdi-lightbulb-on</v-icon>
      </v-btn>

      <template v-if="tabs.length > 1" #extension>
        <v-tabs class="section-tabs" :style="pageStyle" :value="tabIndex" show-arrows height="44">
          <v-tab v-for="tab in tabs" :key="tab.route" :disabled="tab.disabled" @click="go(tab.route)">{{ tab.tab }}</v-tab>
        </v-tabs>
      </template>
    </v-app-bar>

    <page-palette v-model="paletteOpen" :pages="openPages" @go="go" />

    <!-- Sizes your content based upon application components -->
    <v-main>
      <v-snackbar v-model="snackbarStatus" :timeout="2000" :color="snackbar.color">
        {{ snackbar.text }}
        <v-btn dark text @click="snackbarStatus = false">
          Close
        </v-btn>
      </v-snackbar>

      <!-- Provides the application the proper gutter -->
      <v-container fluid>
        <v-card v-if="!RaceID && $route.path !== '/settings'" class="game-picker mx-auto mt-12" :style="neutralStyle" max-width="480" outlined>
          <v-card-title>Pick a game</v-card-title>
          <empire-list v-if="games.length" :games="games" class="pb-2 px-2" />
          <v-card-text v-else-if="$asyncComputed.games.state === 'success'">No games found in the save.</v-card-text>
        </v-card>
        <nuxt v-else />
      </v-container>
    </v-main>

    <v-footer app inset height="36" class="app-footer">
      <transition name="footer-swap" mode="out-in">
        <page-trail v-if="hasMoved" key="trail" class="app-footer__trail" :style="pageStyle" />
        <div v-else key="tagline" class="overline"><span class="font-weight-bold">Aurora Electrons</span> - Looking Inwards</div>
      </transition>
    </v-footer>
  </v-app>
</template>

<script>
import { mapActions, mapGetters, mapMutations, mapState } from 'vuex'

import EmpireAvatar from '../components/navigation/EmpireAvatar.vue'
import EmpireList from '../components/navigation/EmpireList.vue'
import FlyoutPanel from '../components/navigation/FlyoutPanel.vue'
import HistoryButtons from '../components/navigation/HistoryButtons.vue'
import PagePalette from '../components/navigation/PagePalette.vue'
import PageTrail from '../components/navigation/PageTrail.vue'
import SectionFlyout from '../components/navigation/SectionFlyout.vue'
import { sectionStyle } from '../components/navigation/section-style'
import { loadEmpires } from '../utilities/empires'
import { PAGES, SECTIONS, pageByRoute } from '../utilities/navigation'
import { peeks } from '../utilities/peeks'

// The flyout id of the rail's Empires entry; the others are section ids.
const EMPIRES_ID = 'empires'

const FLYOUT_OPEN_DELAY = 140
const FLYOUT_CLOSE_DELAY = 220

export default {
  components: {
    EmpireAvatar,
    EmpireList,
    FlyoutPanel,
    HistoryButtons,
    PagePalette,
    PageTrail,
    SectionFlyout,
  },
  data () {
    return {
      EMPIRES_ID,

      flyoutId: null,
      paletteOpen: false,

      // WATCHED CONFIG
      spyNPR: false,
      unsubscribeSpyNPR: null,
    }
  },
  computed: {
    ...mapState([
      'snackbar',
    ]),
    ...mapState('navigation', [
      'lastInSection',
      'entries',
    ]),
    ...mapState('history', {
      historyRevision: 'revision',
    }),
    ...mapState('peeks', {
      peekLines: 'lines',
    }),

    ...mapGetters([
      'config',
      'database',

      'GameID',
      'RaceID',
      'historyRecorded',
    ]),

    // The trail replaces the tagline once a page beyond the one the app started on has been opened.
    hasMoved () {
      return this.entries.length > 1
    },
    page () {
      return pageByRoute[this.$route.path]
    },
    currentSection () {
      return this.railSections.find(({ id }) => id === this.page.section)
    },
    tabs () {
      return this.currentSection ? this.currentSection.pages.filter(({ planned }) => !planned) : []
    },
    tabIndex () {
      return this.tabs.findIndex(({ route }) => route === this.page.route)
    },
    neutralStyle () {
      return sectionStyle(this.$vuetify.theme.dark)
    },
    pageStyle () {
      return this.currentSection ? this.currentSection.style : this.neutralStyle
    },

    // Every page that appears in the navigation, flagged `disabled` when it needs Empire History the race doesn't have,
    // `planned` when it has no page yet, and `peekable` when the flyout shows a live line under it.
    pages () {
      return PAGES.filter(({ hidden }) => !hidden).map((page) => {
        const disabled = Boolean(page.requiresHistory && !this.historyRecorded)

        return { ...page, disabled, peekable: !disabled && !page.planned && Boolean(peeks[page.route]) }
      })
    },
    openPages () {
      return this.pages.filter(({ disabled, planned }) => !disabled && !planned)
    },
    railSections () {
      return SECTIONS.map((section) => ({
        ...section,
        pages: this.pages.filter(({ section: id }) => id === section.id),
        style: sectionStyle(this.$vuetify.theme.dark, section),
      }))
    },
    flyoutSection () {
      return this.railSections.find(({ id }) => id === this.flyoutId)
    },
    selectedRace () {
      const game = this.games.find(({ GameID }) => GameID === this.GameID)

      return (game && game.Races.find(({ RaceID }) => RaceID === this.RaceID)) || null
    },
    raceCount () {
      return this.games.reduce((count, { Races }) => count + Races.length, 0)
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

    // The flyout's lines load when it opens, and again when the save, the race or the history file changes under it.
    flyoutId: 'loadFlyoutPeeks',
    database: 'loadFlyoutPeeks',
    RaceID: 'loadFlyoutPeeks',
    historyRevision: 'loadFlyoutPeeks',
  },
  created() {
    this.$vuetify.theme.dark = this.config.get('darkMode', false)
  },
  mounted() {
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

    window.addEventListener('keydown', this.onKeydown)
    window.addEventListener('mouseup', this.onMouseup)
  },
  beforeDestroy () {
    if (this.unsubscribeSpyNPR) {
      this.unsubscribeSpyNPR()
    }

    window.removeEventListener('keydown', this.onKeydown)
    window.removeEventListener('mouseup', this.onMouseup)
    clearTimeout(this.peekTimer)
    clearTimeout(this.leaveTimer)
  },
  methods: {
    ...mapMutations('snackbar', [
      'setActive',
    ]),
    ...mapMutations([
      'configDidChange',
    ]),

    ...mapActions('navigation', [
      'back',
      'forward',
    ]),
    ...mapActions('peeks', {
      loadPeeks: 'load',
    }),

    loadFlyoutPeeks () {
      if (this.flyoutSection) {
        this.loadPeeks(this.flyoutSection.pages.filter(({ peekable }) => peekable).map(({ route }) => route))
      }
    },

    setDarkMode(value) {
      this.$vuetify.theme.dark = value
      this.config.set('darkMode', value)
    },

    go (path) {
      this.flyoutId = null
      this.paletteOpen = false

      if (path !== this.$route.fullPath) {
        this.$router.push(path)
      }
    },
    // Back to the last page used in the section, or its first page.
    goSection (section) {
      clearTimeout(this.peekTimer)
      this.go(this.lastInSection[section.id] || section.pages.find(({ disabled, planned }) => !disabled && !planned).route)
    },

    // A click opens the Empires flyout at once (hover opens it after a short delay) or closes it again.
    toggleEmpires () {
      clearTimeout(this.peekTimer)
      this.flyoutId = this.flyoutId === EMPIRES_ID ? null : EMPIRES_ID
    },

    peekSection (id) {
      clearTimeout(this.leaveTimer)
      clearTimeout(this.peekTimer)
      this.peekTimer = setTimeout(() => {
        this.flyoutId = id
      }, this.flyoutId ? 0 : FLYOUT_OPEN_DELAY)
    },
    leaveRail () {
      clearTimeout(this.peekTimer)
      this.leaveTimer = setTimeout(() => {
        this.flyoutId = null
      }, FLYOUT_CLOSE_DELAY)
    },
    cancelLeave () {
      clearTimeout(this.leaveTimer)
    },

    openPalette () {
      this.flyoutId = null
      this.paletteOpen = true
    },

    onKeydown (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        this.openPalette()
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        this.back()
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        this.forward()
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[1-7]$/.test(event.key)) {
        event.preventDefault()
        this.goSection(this.railSections[Number(event.key) - 1])
      } else if (event.key === 'Escape') {
        this.flyoutId = null
      }
    },
    // The mouse's back and forward buttons.
    onMouseup (event) {
      if (event.button === 3) {
        event.preventDefault()
        this.back()
      } else if (event.button === 4) {
        event.preventDefault()
        this.forward()
      }
    },
  },
  asyncComputed: {
    games: {
      async get () {
        if (!this.database) {
          return []
        }

        return loadEmpires(this.database, this.spyNPR)
      },
      default: [],
    },
  },
}
</script>

<style lang="scss">
.v-application {
  --ae-chrome: #f6f7f9;
  --ae-ink: #212121;
  --ae-muted: #6a6a6a;
  --ae-border: #e0e3e8;
  --ae-primary: #1867c0;
  --ae-hover: rgba(24, 103, 192, .07);
  --ae-mono: 'Roboto Mono', ui-monospace, Consolas, monospace;

  &.theme--light {
    --ae-bg: #ffffff;
  }

  &.theme--dark {
    --ae-bg: #121212;
    --ae-chrome: #1e1e1e;
    --ae-ink: #f5f5f5;
    --ae-muted: #b0b0b0;
    --ae-border: #333333;
    --ae-primary: #2196f3;
    --ae-hover: rgba(33, 150, 243, .10);
  }

  // Both theme classes, to outrank Vuetify's own kbd styling.
  &.theme--light kbd,
  &.theme--dark kbd {
    padding: 1px 6px;
    border: 1px solid var(--ae-border);
    border-radius: 4px;
    box-shadow: none;
    background: var(--ae-bg);
    color: var(--ae-muted);
    font-family: var(--ae-mono);
    font-size: 11px;
  }
}
</style>

<style lang="scss" scoped>
.rail {
  &.v-navigation-drawer {
    background: var(--ae-chrome) !important;
  }

  ::v-deep .v-navigation-drawer__content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding-block: 10px;
  }
}

.rail__empire {
  width: 76px;
  margin-bottom: 8px;
  padding-block: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: var(--ae-muted);

  .empire-avatar {
    transition: box-shadow .15s ease;
  }

  &:hover,
  &--peek {
    .empire-avatar {
      box-shadow: 0 0 0 2px var(--ae-chrome), 0 0 0 4px var(--sc);
    }
  }
}

.rail__spacer {
  flex: 1;
}

.rail__item {
  position: relative;
  width: 76px;
  padding-block: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: var(--ae-muted);

  .v-icon {
    color: var(--ae-muted) !important;
    transition: color .15s ease;
  }
}

.rail__pill {
  width: 56px;
  height: 32px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  transition: background .15s ease;
}

.rail__label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .02em;
}

.rail__item:hover,
.rail__item--peek {
  .rail__pill {
    background: var(--sc-tint);
  }

  .v-icon {
    color: var(--sc) !important;
  }
}

.rail__item--active {
  .rail__pill {
    background: var(--sc-soft);
  }

  .rail__label {
    color: var(--ae-ink);
  }

  .v-icon {
    color: var(--sc) !important;
  }
}

.app-bar.v-app-bar.v-sheet {
  background: var(--ae-bg) !important;
  border-bottom: 1px solid var(--ae-border) !important;
}

.app-footer.v-footer {
  background: var(--ae-chrome) !important;
  border-top: 1px solid var(--ae-border) !important;
}

.app-footer ::v-deep .overline,
.app-footer__trail {
  flex: 1 1 0;
  min-width: 0;
}

.footer-swap-enter-active,
.footer-swap-leave-active {
  transition: opacity .18s ease;
}

.footer-swap-enter,
.footer-swap-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .footer-swap-enter-active,
  .footer-swap-leave-active {
    transition: none;
  }
}

.search-button {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding-inline: 12px;
  border: 1px solid var(--ae-border);
  border-radius: 18px;
  cursor: pointer;
  font-size: 14px;
  color: var(--ae-muted);
  background: var(--ae-bg);

  &:hover {
    border-color: var(--ae-primary);
    color: var(--ae-ink);
  }
}

.breadcrumb {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.breadcrumb__section {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .08em;
  text-transform: uppercase;
  white-space: nowrap;
  cursor: pointer;
  color: var(--sc);
}

.breadcrumb__separator {
  color: var(--ae-muted);
}

.breadcrumb__title {
  overflow: hidden;
  font-size: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ae-ink);
}

.section-tabs {
  ::v-deep .v-tab {
    letter-spacing: .06em;
  }

  ::v-deep .v-tab--active {
    color: var(--sc) !important;
  }

  ::v-deep .v-tabs-slider {
    background: var(--sc) !important;
  }
}
</style>
