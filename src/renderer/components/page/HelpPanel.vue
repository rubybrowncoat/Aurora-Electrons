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
        <h3 class="help__heading">About this page</h3>
        <p class="help__overview" data-help-overview>{{ help.overview }}</p>

        <h3 class="help__heading">Using this page</h3>
        <ul class="help__usage" data-help-usage>
          <li v-for="(line, index) in help.usage" :key="index">{{ line }}</li>
        </ul>

        <h3 class="help__heading">Terms and units</h3>
        <p class="help__lead">Definitions kept in the app, so they read the same without a network.</p>
        <dl class="help__terms">
          <div v-for="entry in help.terms" :key="entry.id" class="help__term" :data-term="entry.id">
            <dt>{{ entry.term }}<span v-if="entry.units" class="help__units">{{ entry.units }}</span></dt>
            <dd>{{ entry.definition }}</dd>
          </div>
        </dl>
      </div>
    </v-navigation-drawer>
  </div>
</template>

<script>
import { helpFor } from '../../utilities/glossary'

// Where the button sits below the app bar, and its size.
const BUTTON_OFFSET = 8
const BUTTON_SIZE = 22

// The widest the help gets, and the share of a narrow window it may take.
const MAX_WIDTH = 380
const MAX_SHARE = 0.4

// The help of the open page: a button at the top of the strip the section ticks use, and a drawer of the page's overview, usage notes and glossary terms. The drawer is a right-hand application drawer under the app bar and above the footer, so it takes its width out of the page (`$vuetify.application.right`, which the page container, the app bar, the footer, this button and the section ticks all keep clear of) instead of covering controls. The terms are defined in utilities/glossary.js, so it reads the same without a network. The drawer is no section of the page (it is not a `.panel`), so the section ticks do not list it.
export default {
  name: 'HelpPanel',
  data () {
    return {
      open: false,
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
.help__overview {
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

.help__usage {
  margin: 0 0 8px;
  padding-left: 18px;

  li {
    margin-bottom: 4px;
  }
}

.help__terms {
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
</style>
