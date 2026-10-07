<template>
  <div ref="root" class="trail">
    <span v-if="showLabel" ref="label" class="trail__label"><v-icon small>mdi-history</v-icon>Trail</span>
    <div ref="scroller" class="trail__scroller" :class="{ 'trail__scroller--clipped': clipped }">
      <div ref="chips" class="trail__chips">
        <template v-for="(step, position) in steps">
          <v-icon v-if="position" :key="`separator-${step.index}`" x-small class="trail__separator">mdi-chevron-right</v-icon>
          <span
            :key="step.index"
            class="trail__step"
            :class="{ 'trail__step--now': step.index === index, 'trail__step--ahead': step.index > index }"
            :style="step.style"
            role="link"
            tabindex="0"
            @click="jump(step.index)"
            @keydown.enter="jump(step.index)"
          >
            <span class="trail__dot" />{{ step.page.tab }}
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
import { mapActions, mapGetters, mapState } from 'vuex'

import { sectionById, pageByRoute } from '../../utilities/navigation'
import { sectionStyle } from './section-style'

// The label's width until it has been measured, and the gap between it and the chips.
const LABEL_WIDTH = 72
const LABEL_GAP = 8

export default {
  data () {
    return {
      showLabel: true,
      clipped: false,
      labelWidth: LABEL_WIDTH,
    }
  },
  computed: {
    ...mapState('navigation', [
      'index',
    ]),
    ...mapGetters('navigation', [
      'trail',
    ]),

    // The trail's entries that are pages, each with its section's colours.
    steps () {
      return this.trail
        .map(({ index, path }) => ({ index, page: pageByRoute[path.split('?')[0]] }))
        .filter(({ page }) => page)
        .map((step) => ({ ...step, style: sectionStyle(this.$vuetify.theme.dark, sectionById[step.page.section]) }))
    },
  },
  watch: {
    steps () {
      this.$nextTick(this.refresh)
    },
  },
  mounted () {
    this.observer = new ResizeObserver(() => this.refresh())
    this.observer.observe(this.$refs.root)
    this.refresh()
  },
  beforeDestroy () {
    this.observer.disconnect()
  },
  methods: {
    ...mapActions('navigation', [
      'jump',
    ]),

    // Hide the label when the chips and the label together don't fit, then keep the current chip in view: the
    // trail scrolls to its end, or just far enough back to show the current chip when forward entries fill the room.
    refresh () {
      const { root, label, scroller, chips } = this.$refs

      if (label) {
        this.labelWidth = label.offsetWidth
      }

      this.showLabel = chips.offsetWidth + this.labelWidth + LABEL_GAP <= root.clientWidth
      this.$nextTick(() => {
        this.clipped = chips.offsetWidth > scroller.clientWidth
        scroller.scrollLeft = scroller.scrollWidth

        const current = chips.querySelector('.trail__step--now')

        if (current && current.offsetLeft < scroller.scrollLeft) {
          scroller.scrollLeft = Math.max(0, current.offsetLeft - 8)
        }
      })
    },
  },
}
</script>

<style lang="scss" scoped>
.trail {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 8px;
  min-width: 140px;
  height: 100%;
}

.trail__label {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ae-muted);

  .v-icon {
    color: inherit;
  }
}

.trail__scroller {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.trail__scroller--clipped {
  mask-image: linear-gradient(to right, transparent, #000 10px, #000 calc(100% - 10px), transparent);
}

.trail__chips {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  width: max-content;
  padding-inline: 8px;
}

.trail__separator {
  flex: none;
  color: var(--ae-muted) !important;
}

.trail__step {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-inline: 10px;
  border: 1px solid var(--ae-border);
  border-radius: 13px;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  color: var(--ae-ink);

  &:hover {
    border-color: var(--sc);
  }
}

.trail__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sc);
}

.trail__step--now {
  border-color: transparent;
  font-weight: 500;
  background: var(--sc-soft);
}

.trail__step--ahead {
  border-style: dashed;
  color: var(--ae-muted);
}
</style>
