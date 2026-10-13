<template>
  <div v-if="help" class="help">
    <button ref="button" type="button" class="help__button" :class="{ 'help__button--open': open }" :style="buttonStyle" :title="`Help for ${help.title}`" :aria-label="`Help for ${help.title}`" aria-haspopup="dialog" aria-controls="page-help" :aria-expanded="open ? 'true' : 'false'" data-help-button @click="toggle">
      <v-icon small>mdi-help-circle-outline</v-icon>
    </button>

    <v-navigation-drawer id="page-help" ref="card" :value="open" app right clipped stateless :width="width" :height="height" color="var(--ae-bg)" class="help__drawer" role="dialog" aria-labelledby="page-help-title" tabindex="-1" data-help-card @transitionend="focusCard">
      <template #prepend>
        <header class="help__head">
          <h2 id="page-help-title" class="help__title">Help: {{ help.title }}</h2>
          <button type="button" class="help__close" aria-label="Close help" @click="close(true)">
            <v-icon small>mdi-close</v-icon>
          </button>
        </header>
      </template>

      <div class="help__body">
        <p class="help__lead">Definitions of the terms and units on this page, kept in the app and reviewed on {{ reviewed }} against game version {{ version }}.</p>

        <h3 class="help__heading">Terms and units</h3>
        <dl class="help__terms">
          <div v-for="entry in help.terms" :key="entry.id" class="help__term" :data-term="entry.id">
            <dt>{{ entry.term }}<span v-if="entry.units" class="help__units">{{ entry.units }}</span></dt>
            <dd>{{ entry.definition }}</dd>
          </div>
        </dl>

        <h3 class="help__heading">Learning links</h3>
        <p class="help__note">Links open in the browser and point to public material the app does not copy. They explain terms and workflows and are no source for any figure; the mark beside a figure states how far it holds. Every definition above stands on its own when a link is down.</p>
        <ul class="help__links">
          <li v-for="item in help.links" :key="item.id" class="help__link" :data-link="item.id">
            <external-link :href="item.url">{{ item.title }}</external-link>
            <div class="help__covers">{{ item.covers }}</div>
            <div class="help__meta">
              <span>{{ item.source }}</span>
              <span>{{ item.gameVersion }}</span>
              <span class="help__status" :class="`help__status--${item.status}`"><v-icon x-small>{{ statusIcon[item.status] }}</v-icon>{{ statusText[item.status] }}</span>
              <span>Reviewed {{ item.reviewed }}</span>
              <span v-if="item.reached" class="help__reach">Reachable at the review</span>
              <span v-else class="help__reach help__reach--down">Not reachable at the review</span>
            </div>
          </li>
        </ul>
      </div>
    </v-navigation-drawer>
  </div>
</template>

<script>
import { GAME_VERSION, REVIEWED, VERSION_STATUS, VERSION_STATUS_TEXT, helpFor } from '../../utilities/glossary'
import ExternalLink from '../ExternalLink.vue'

// Where the button sits below the app bar, and its size.
const BUTTON_OFFSET = 8
const BUTTON_SIZE = 22

// The widest the help gets, and the share of a narrow window it may take.
const MAX_WIDTH = 380
const MAX_SHARE = 0.4

// The help of the open page: a button at the top of the strip the section ticks use, and a drawer of the page's glossary terms and learning links. The drawer is a right-hand application drawer under the app bar and above the footer, so it takes its width out of the page (`$vuetify.application.right`, which the page container, the app bar, the footer, this button and the section ticks all keep clear of) instead of covering controls. The terms are defined in utilities/glossary.js, so it reads the same without a network; the links are pointers with their own review date and game version, kept apart from the provenance marks that say how far a figure holds. The drawer is no section of the page (it is not a `.panel`), so the section ticks do not list it.
export default {
  name: 'HelpPanel',
  components: { ExternalLink },
  data () {
    return {
      open: false,
      reviewed: REVIEWED,
      version: GAME_VERSION,
      statusText: VERSION_STATUS_TEXT,
      statusIcon: { [VERSION_STATUS.OLDER]: 'mdi-history', [VERSION_STATUS.CURRENT]: 'mdi-check', [VERSION_STATUS.UNKNOWN]: 'mdi-help' },
    }
  },
  computed: {
    help () {
      return helpFor(this.$route.path)
    },
    width () {
      return Math.min(MAX_WIDTH, Math.round(this.$vuetify.breakpoint.width * MAX_SHARE))
    },
    // From the app bar's bottom edge to the footer's top edge.
    height () {
      const { bar, top, footer, insetFooter, bottom } = this.$vuetify.application

      return `calc(100vh - ${bar + top + footer + insetFooter + bottom}px)`
    },
    buttonStyle () {
      const { bar, top, right } = this.$vuetify.application

      return { top: `${bar + top + BUTTON_OFFSET}px`, right: `${right}px`, width: `${BUTTON_SIZE}px`, height: `${BUTTON_SIZE}px` }
    },
  },
  watch: {
    '$route.path' () {
      this.close(false)
    },
    open (open) {
      if (open) {
        document.addEventListener('keydown', this.onKey)
        this.$nextTick(this.focusCard)
      } else {
        document.removeEventListener('keydown', this.onKey)
      }
    },
  },
  beforeDestroy () {
    document.removeEventListener('keydown', this.onKey)
  },
  methods: {
    toggle () {
      this.open = !this.open
    },
    // The drawer is hidden until its slide-in starts, so the focus moves in on the next tick when the motion is off and at the end of the slide otherwise; it never takes the focus from a control the reader has moved to meanwhile.
    focusCard () {
      const { card } = this.$refs
      const active = document.activeElement

      if (this.open && card && !card.$el.contains(active) && (active === this.$refs.button || active === document.body)) {
        card.$el.focus()
      }
    },
    // `refocus` hands the focus back to the button, as Esc and the close button do; a route change leaves it where it is.
    close (refocus) {
      const wasOpen = this.open

      this.open = false

      if (wasOpen && refocus) {
        this.$nextTick(() => this.$refs.button && this.$refs.button.focus())
      }
    },
    // Esc closes the help only from inside it or from its button, so it does not also close what a control on the page opened.
    onKey (event) {
      const { card, button } = this.$refs

      if (event.key === 'Escape' && ((card && card.$el.contains(event.target)) || (button && button === event.target))) {
        this.close(true)
      }
    },
  },
}
</script>

<style lang="scss" scoped>
.help__button {
  position: fixed;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--ae-muted);
  background: var(--ae-bg);
  border: 1px solid var(--ae-border);
  border-radius: 50%;
  cursor: pointer;

  &:hover,
  &:focus-visible,
  &--open {
    color: var(--ae-ink);
    border-color: var(--ae-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--ae-primary);
    outline-offset: 2px;
  }

  .v-icon {
    color: inherit;
  }
}

.help__drawer.v-navigation-drawer {
  color: var(--ae-ink);
  border-left: 1px solid var(--ae-border);

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 2px solid var(--ae-primary);
    outline-offset: -2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .help__drawer.v-navigation-drawer {
    transition: none;
  }
}

.help__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 8px 8px 14px;
  border-bottom: 1px solid var(--ae-border);
}

.help__title {
  min-width: 0;
  overflow: hidden;
  font-size: calc(14px * var(--ae-font-scale));
  font-weight: 600;
  line-height: calc(20px * var(--ae-font-scale));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.help__close {
  flex: none;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--ae-muted);
  background: none;
  border: 0;
  border-radius: 50%;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--ae-ink);
    background: var(--ae-hover);
  }

  .v-icon {
    color: inherit;
  }
}

.help__body {
  padding: 10px 14px 14px;
  font-size: calc(12px * var(--ae-font-scale));
  line-height: calc(17px * var(--ae-font-scale));
}

.help__lead,
.help__note {
  margin: 0 0 8px;
  color: var(--ae-muted);
}

.help__heading {
  margin: 12px 0 6px;
  font-size: calc(12px * var(--ae-font-scale));
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.help__terms,
.help__links {
  margin: 0;
  padding: 0;
}

.help__term {
  margin-bottom: 8px;

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
  }
}

.help__units {
  margin-left: 8px;
  font-family: var(--ae-mono);
  font-size: calc(11px * var(--ae-font-scale));
  font-weight: 400;
  color: var(--ae-muted);
}

.help__links {
  list-style: none;
}

.help__link {
  margin-bottom: 10px;
}

.help__covers {
  color: var(--ae-ink);
}

.help__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
  color: var(--ae-muted);
  font-size: calc(11px * var(--ae-font-scale));
}

.help__status {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-weight: 600;

  .v-icon {
    color: inherit;
  }
}

.help__status--older {
  color: var(--ae-ink);
}

.help__reach--down {
  font-weight: 600;
  color: var(--ae-ink);
}
</style>
