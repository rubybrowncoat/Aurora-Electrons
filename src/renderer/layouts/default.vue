<template>
  <v-app :style="rootStyle">
    <v-navigation-drawer app permanent mini-variant mini-variant-width="80" class="rail">
      <div class="rail__empire" :class="{ 'rail__empire--active': onEmpiresPage, 'rail__empire--peek': flyoutId === EMPIRES_ID, 'rail__empire--invite': !RaceID && !onEmpiresPage }" :style="neutralStyle" role="link" tabindex="0" @click="goEmpires" @keydown.enter="goEmpires" @mouseenter="onEmpiresPage || peekSection(EMPIRES_ID)" @mouseleave="leaveRail">
        <empire-avatar :race="selectedRace" :size="40" />
        <div class="rail__label" title="Empires">Empires</div>
      </div>

      <div v-for="section in railSections" :key="section.id" class="rail__item" :class="{ 'rail__item--active': RaceID && currentSection === section, 'rail__item--peek': flyoutId === section.id, 'rail__item--disabled': !RaceID }" :style="section.style" role="link" :tabindex="RaceID ? 0 : -1" @click="goSection(section)" @keydown.enter="goSection(section)" @mouseenter="RaceID && peekSection(section.id)" @mouseleave="leaveRail">
        <div class="rail__pill">
          <v-icon>{{ section.icon }}</v-icon>
        </div>
        <div class="rail__label" :title="section.title">{{ section.title }}</div>
      </div>

      <div class="rail__spacer" />

      <div class="rail__item" :class="{ 'rail__item--active': page.route === '/settings' }" :style="neutralStyle" role="link" tabindex="0" @click="go('/settings')" @keydown.enter="go('/settings')">
        <div class="rail__pill">
          <v-icon>mdi-wrench</v-icon>
        </div>
        <div class="rail__label" title="Settings">Settings</div>
      </div>

      <div class="rail__item" :class="{ 'rail__item--active': page.route === '/about' }" :style="neutralStyle" role="link" tabindex="0" @click="go('/about')" @keydown.enter="go('/about')">
        <div class="rail__pill">
          <v-icon>mdi-information-outline</v-icon>
        </div>
        <div class="rail__label" title="About">About</div>
      </div>
    </v-navigation-drawer>

    <section-flyout v-if="flyoutSection" :style="flyoutSection.style" :section="flyoutSection" :pages="flyoutSection.pages" :active-route="page.route" :shortcut="railSections.indexOf(flyoutSection) + 1" :peeks="peekLines" @go="go" @mouseenter.native="cancelLeave" @mouseleave.native="leaveRail" />

    <flyout-panel v-if="flyoutId === EMPIRES_ID && !onEmpiresPage && !refused" class="empire-flyout" :style="neutralStyle" title="Empires" :meta="`${raceCount} ${raceCount === 1 ? 'empire' : 'empires'}`" :width="380" @mouseenter.native="cancelLeave" @mouseleave.native="leaveRail">
      <empire-list :games="games" @pick="flyoutId = null" />
      <template #foot><kbd>Esc</kbd> close</template>
    </flyout-panel>

    <v-app-bar app flat clipped-right height="64" extension-height="44" :extended="showTabs" class="app-bar">
      <history-buttons />

      <div class="breadcrumb ml-3" :style="pageStyle">
        <template v-if="currentSection">
          <span class="breadcrumb__section hidden-xs-only" @mouseenter="RaceID && peekSection(currentSection.id)" @mouseleave="leaveRail">{{ currentSection.title }}</span>
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

      <v-btn v-if="appearance.mode === 'dark'" icon :title="lampTitle" :aria-label="lampTitle" data-theme-toggle="light" @click="switchTheme">
        <v-icon>mdi-lightbulb-on-outline</v-icon>
      </v-btn>
      <v-btn v-else icon :title="lampTitle" :aria-label="lampTitle" data-theme-toggle="dark" @click="switchTheme">
        <v-icon>mdi-lightbulb-on</v-icon>
      </v-btn>

      <template v-if="showTabs" #extension>
        <v-tabs class="section-tabs" :style="pageStyle" :value="tabIndex" show-arrows height="44">
          <v-tab v-for="tab in tabs" :key="tab.route" :disabled="tab.disabled" @click="go(tab.route)">{{ tab.tab }}</v-tab>
        </v-tabs>
      </template>
    </v-app-bar>

    <page-palette v-model="paletteOpen" :pages="openPages" :locked="!RaceID" @go="go" />

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
        <unsupported-save v-if="refusedHere" />
        <capability-state v-else-if="capabilityReport && capabilityReport.status === 'unsupported'" :report="capabilityReport" :title="page.title" :checking="capabilityChecking" @retry="recheckCapabilities" />
        <template v-else>
          <capability-state v-if="capabilityReport && capabilityReport.status === 'degraded'" :report="capabilityReport" :title="page.title" :checking="capabilityChecking" @retry="recheckCapabilities" />
          <router-view :key="$route.path" />
        </template>
        <section-nav :style="pageStyle" />
      </v-container>
    </v-main>

    <v-footer app inset height="36" class="app-footer">
      <transition name="footer-swap" mode="out-in">
        <page-trail v-if="hasMoved" key="trail" class="app-footer__trail" :style="pageStyle" />
        <div v-else key="tagline" class="overline"><span class="font-weight-bold">Aurora Electrons</span> - Looking Inwards</div>
      </transition>
      <save-status />
    </v-footer>
  </v-app>
</template>

<script>
import { ipcRenderer } from 'electron'
import { mapActions, mapGetters, mapMutations, mapState } from 'vuex'

import EmpireAvatar from '../components/navigation/EmpireAvatar.vue'
import EmpireList from '../components/navigation/EmpireList.vue'
import FlyoutPanel from '../components/navigation/FlyoutPanel.vue'
import HistoryButtons from '../components/navigation/HistoryButtons.vue'
import PagePalette from '../components/navigation/PagePalette.vue'
import PageTrail from '../components/navigation/PageTrail.vue'
import SaveStatus from '../components/navigation/SaveStatus.vue'
import SectionFlyout from '../components/navigation/SectionFlyout.vue'
import { sectionStyle } from '../components/navigation/section-style'
import CapabilityState from '../components/page/CapabilityState.vue'
import SectionNav from '../components/page/SectionNav.vue'
import UnsupportedSave from '../components/page/UnsupportedSave.vue'
import { SYSTEM_QUERY, activeAppearance, appearanceStyle, applyPolicy, followSystem, loadAppearance, nativeThemeSource, quickSwitch, requestNativeTheme } from '../utilities/appearance'
import { REPORT_ROUTES } from '../utilities/capabilities'
import { PAGES, SECTIONS, needsRace, pageByRoute } from '../utilities/navigation'
import { peeks } from '../utilities/peeks'

// The flyout id of the rail's Empires entry; the others are section ids.
const EMPIRES_ID = 'empires'

const FLYOUT_OPEN_DELAY = 140
const FLYOUT_CLOSE_DELAY = 220

export default {
  components: {
    CapabilityState,
    EmpireAvatar,
    EmpireList,
    FlyoutPanel,
    HistoryButtons,
    PagePalette,
    PageTrail,
    SaveStatus,
    SectionFlyout,
    SectionNav,
    UnsupportedSave,
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
    ...mapState('empires', [
      'games',
    ]),
    ...mapState('navigation', [
      'lastInSection',
      'entries',
    ]),
    ...mapState('history', {
      historyRevision: 'revision',
    }),
    ...mapGetters('peeks', {
      peekLines: 'visible',
    }),

    ...mapGetters('capabilities', {
      capabilityStatus: 'status',
      reportOf: 'report',
      refused: 'refused',
    }),

    ...mapGetters([
      'config',
      'database',

      'GameID',
      'RaceID',
      'historyRecorded',
    ]),

    // The appearance in force, and the custom properties it sets on the root; everything below that took the dark flag reads it, so a switch between presets of one mode redraws too.
    appearance () {
      return activeAppearance()
    },
    rootStyle () {
      return appearanceStyle(this.appearance)
    },

    // The lamp sets the opposite of the mode drawn now as an explicit Light or Dark theme, which also ends System or a named preset: the title says what it replaces.
    lampTitle () {
      const { mode, replaces } = quickSwitch()

      return `${mode === 'dark' ? 'Dark' : 'Light'} theme${replaces ? ` (replaces ${replaces})` : ''}`
    },

    // What the application's native theme is asked to be (the window frame, the native dialogs): see nativeThemeSource.
    nativeSource () {
      return nativeThemeSource()
    },

    // The trail replaces the tagline once a page beyond the one the app started on has been opened.
    hasMoved () {
      return this.entries.length > 1
    },
    page () {
      return pageByRoute[this.$route.path]
    },
    // What the capability check found of the open page (store/capabilities.js): null until it has answered, or if it failed, so the page then reads as before. A refused save has no report shown: the notice stands for every page (`refusedHere`) and on the Empires page the page draws it.
    capabilityReport () {
      return this.refused ? null : this.reportOf(this.$route.path)
    },
    // Whether the open page is a report that the refusal of the save replaces with its notice: every report but the Empires page, which draws the notice itself and keeps the Save panel under it. Settings, About and the rest that read nothing of the save draw as always.
    refusedHere () {
      return this.refused && this.$route.path !== '/' && REPORT_ROUTES.includes(this.$route.path)
    },
    capabilityChecking () {
      return this.capabilityStatus === 'checking'
    },
    currentSection () {
      return this.railSections.find(({ id }) => id === this.page.section)
    },
    onEmpiresPage () {
      return this.page.route === '/'
    },
    tabs () {
      return this.currentSection ? this.currentSection.pages.filter(({ planned }) => !planned) : []
    },
    tabIndex () {
      return this.tabs.findIndex(({ route }) => route === this.page.route)
    },
    neutralStyle () {
      return sectionStyle(this.appearance)
    },
    pageStyle () {
      return this.currentSection ? this.currentSection.style : this.neutralStyle
    },

    showTabs () {
      return this.tabs.length > 1
    },

    // Every page that appears in the navigation, flagged `disabled` when it shows a race's data and none is picked yet or it needs Empire History the race doesn't have, `planned` when it has no page yet, and `peekable` when the flyout shows a live line under it.
    pages () {
      return PAGES.filter(({ hidden }) => !hidden).map((page) => {
        const disabled = (!this.RaceID && needsRace(page.route)) || Boolean(page.requiresHistory && !this.historyRecorded)

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
        style: sectionStyle(this.appearance, section),
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
    nativeSource: {
      immediate: true,
      handler: 'syncNativeTheme',
    },

    // The flyout's lines load when it opens, and again when the save, the race or the history file changes under it. The empire list is read again when the save or the NPR setting changes.
    flyoutId: 'loadFlyoutPeeks',
    database: ['loadFlyoutPeeks', 'loadEmpires'],
    RaceID: 'loadFlyoutPeeks',
    historyRevision: 'loadFlyoutPeeks',
    spyNPR: 'loadEmpires',
  },
  created() {
    // The operating system's colour scheme is observed from the start, before the settings are read, so that the System policy draws the right one at once; the listener is removed with the layout.
    this.system = window.matchMedia ? followSystem(window.matchMedia(SYSTEM_QUERY)) : null
    loadAppearance(this.config)
    this.loadEmpires()
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
    if (this.system) {
      this.system.stop()
    }

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

    ...mapActions('snackbar', ['activateSnackbar']),
    ...mapActions('navigation', [
      'back',
      'forward',
    ]),
    ...mapActions('peeks', {
      loadPeeks: 'load',
    }),
    ...mapActions('empires', {
      loadEmpires: 'load',
    }),
    ...mapActions('capabilities', {
      recheckCapabilities: 'retry',
    }),

    loadFlyoutPeeks () {
      if (this.flyoutSection) {
        this.loadPeeks(this.flyoutSection.pages.filter(({ peekable }) => peekable).map(({ route }) => route))
      }
    },

    // The lamp and the Theme control of Settings both apply a policy through the one helper that writes it (`applyPolicy`).
    switchTheme () {
      try {
        applyPolicy(this.config, quickSwitch().mode)
      } catch (error) {
        console.error("Couldn't write the theme", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so the theme was not applied", color: 'error' })
      }
    },

    // Tells the main process what the native theme should be. A pinned theme or a named appearance asks for its own mode, which makes the colour scheme query report that mode, so the observer keeps the last scheme it read from the system. When the system is asked for again, the main process answers with its scheme (the web shim with nothing, and the query is then the system's), and the observer reads that.
    syncNativeTheme () {
      requestNativeTheme((source) => ipcRenderer.invoke('theme:source', source)).catch((error) => console.error("Couldn't set the native theme", error))
    },

    go (path) {
      this.flyoutId = null
      this.paletteOpen = false

      if (path !== this.$route.fullPath) {
        this.$router.push(path)
      }
    },
    // Back to the last page used in the section, or its first page. Until a race is picked, to the Empires page instead.
    goSection (section) {
      if (!this.RaceID) {
        this.goEmpires()

        return
      }

      clearTimeout(this.peekTimer)
      this.go(this.lastInSection[section.id] || section.pages.find(({ disabled, planned }) => !disabled && !planned).route)
    },

    // The Empires page. Hovering the entry anywhere else opens the empire list as a flyout, which switches race in place.
    goEmpires () {
      clearTimeout(this.peekTimer)
      this.go('/')
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
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[1-9]$/.test(event.key) && Number(event.key) <= this.railSections.length) {
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
}
</script>

<style lang="scss">
// Off-canvas parts (a closed drawer parked past the right edge) must not make the window scroll sideways. Content that really is too wide is still reported by the smoke test's layout check.
.v-main__wrap {
  overflow-x: clip;
}

// Tables keep a header on one line and scroll inside their own wrapper when they need more room. Below the 1080p layout (1904 px and up) the cells give up more than a third of their side padding.
.v-application .v-data-table {
  th {
    white-space: nowrap;
  }

  @media (max-width: 1903px) {
    > .v-data-table__wrapper > table > thead > tr > th,
    > .v-data-table__wrapper > table > tbody > tr > td,
    > .v-data-table__wrapper > table > tfoot > tr > td {
      padding-inline: 10px;
    }
  }
}

// The monospace of keys and figures (--ae-mono) comes from the typeface choice on the root element (utilities/appearance-font.js). The colour custom properties (--ae-bg, --ae-chrome, --ae-card, --ae-border, --ae-ink, --ae-muted, --ae-primary, --ae-hover) are set inline on the root from the appearance in force (utilities/appearance.js).
.v-application {
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
    font-size: calc(11px * var(--ae-font-scale));
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
  &--peek,
  &--active {
    .empire-avatar {
      box-shadow: 0 0 0 2px var(--ae-chrome), 0 0 0 4px var(--sc);
    }
  }

  &--active .rail__label {
    color: var(--ae-ink);
  }
}

.rail__empire--invite {
  position: relative;
  color: var(--ae-ink);

  .rail__label {
    font-weight: 700;
    color: var(--ae-primary);
  }

  .empire-avatar {
    box-shadow: 0 0 0 2px var(--ae-chrome), 0 0 0 4px var(--ae-primary);
  }

  // A ring that grows off the avatar and fades, once every couple of seconds.
  &::before {
    content: '';
    position: absolute;
    top: 4px;
    left: 18px;
    width: 40px;
    height: 40px;
    border: 2px solid var(--ae-primary);
    border-radius: 4px;
    opacity: 0;
    pointer-events: none;
    animation: invite-pulse 2.4s ease-out infinite;
  }
}

@keyframes invite-pulse {
  0% {
    opacity: .7;
    transform: scale(1);
  }

  70%,
  100% {
    opacity: 0;
    transform: scale(1.6);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail__empire--invite::before {
    animation: none;
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

// The label box keeps the 16.5 px line it has at 100 % (1.5 times 11 px), so the rail still fits its nine sections, Settings and About in a 720 px window at any text size. The rail is 80 px wide at every size, so a name wider than its entry (a wide typeface at a large size) ends in an ellipsis, and its title carries the whole name.
.rail__label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(11px * var(--ae-font-scale));
  line-height: 16.5px;
  font-weight: 500;
  letter-spacing: .02em;
}

// Nine sections, Settings and About take 760 px; a window under 780 px tall tightens them so About still shows at 720, with about 30 px to spare.
@media (max-height: 779px) {
  .rail ::v-deep .v-navigation-drawer__content {
    gap: 1px;
    padding-block: 6px;
  }

  .rail__item {
    padding-block: 2px;
    gap: 2px;
  }

  .rail__empire {
    margin-bottom: 2px;
    padding-block: 2px;
    gap: 2px;
  }
}

.rail__item--disabled {
  opacity: .45;
  cursor: default;
}

.rail__item:not(.rail__item--disabled):hover,
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

// Keyboard focus on the rail's entries and the search button, which are not Vuetify controls: a 2px ring in the focus colour (3:1 or more on every surface of every preset, scripts/check-contrast.js), drawn inside the rail's own width so the drawer does not clip it.
.rail__item:focus-visible,
.rail__empire:focus-visible {
  outline: 2px solid var(--ae-primary);
  outline-offset: -2px;
  border-radius: 8px;
}

.search-button:focus-visible {
  outline: 2px solid var(--ae-primary);
  outline-offset: 2px;
}

.app-bar.v-app-bar.v-sheet {
  background: var(--ae-bg) !important;
  border-bottom: 1px solid var(--ae-border) !important;
}

// Same side padding as the page's container, and no block padding: Vuetify's 6 px leaves less height than the tagline's line box, which then hangs below the centre while the trail stays centred.
// The footer is inset for the rail, and the help drawer (a right application drawer between the bar and the footer; the bar clears it with `clipped-right`) must not narrow it either.
.app-footer.v-footer {
  right: 0 !important;
  padding-block: 0;
  padding-inline: 12px;
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
  font-size: calc(14px * var(--ae-font-scale));
  color: var(--ae-muted);
  white-space: nowrap;
  flex: none;
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
  font-size: calc(12px * var(--ae-font-scale));
  font-weight: 500;
  letter-spacing: .08em;
  text-transform: uppercase;
  white-space: nowrap;
  cursor: pointer;
  color: var(--sc-text);
}

.breadcrumb__separator {
  color: var(--ae-muted);
}

.breadcrumb__title {
  overflow: hidden;
  font-size: calc(20px * var(--ae-font-scale));
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ae-ink);
}

.section-tabs {
  ::v-deep .v-tab {
    letter-spacing: .06em;
  }

  ::v-deep .v-tab--active {
    color: var(--sc-text) !important;
  }

  ::v-deep .v-tabs-slider {
    background: var(--sc) !important;
  }
}
</style>
