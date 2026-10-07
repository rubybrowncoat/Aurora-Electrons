<template>
  <div ref="root" class="trail">
    <div ref="scroller" class="trail__scroller" :class="{ 'trail__scroller--clipped': clipped }">
      <div ref="chips" class="trail__chips">
        <template v-for="(step, position) in steps">
          <v-icon v-if="position" :key="`separator-${step.index}`" x-small class="trail__separator">mdi-chevron-right</v-icon>
          <span
            :key="step.index"
            class="trail__step"
            :class="{ 'trail__step--now': step.index === index, 'trail__step--ahead': step.index > index, 'trail__step--disabled': step.disabled }"
            :style="step.style"
            role="link"
            :tabindex="step.disabled ? -1 : 0"
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

export default {
  data () {
    return {
      clipped: false,
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
        .map(({ index, path, disabled }) => ({ index, disabled, page: pageByRoute[path.split('?')[0]] }))
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

    // Keep the current chip in view: the trail scrolls to its end, or just far enough back to show the current chip
    // when forward entries fill the room. The oldest chips are the ones that clip.
    refresh () {
      const { scroller, chips } = this.$refs

      this.clipped = chips.offsetWidth > scroller.clientWidth
      scroller.scrollLeft = scroller.scrollWidth

      const current = chips.querySelector('.trail__step--now')

      if (current && current.offsetLeft < scroller.scrollLeft) {
        scroller.scrollLeft = Math.max(0, current.offsetLeft - 8)
      }
    },
  },
}
</script>

<style lang="scss" scoped>
.trail {
  display: flex;
  align-items: center;
  min-width: 0;
  height: 100%;
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
  mask-image: linear-gradient(to right, transparent, #000 14px);
}

.trail__chips {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  width: max-content;
  padding-inline: 0 2px;
}

.trail__separator {
  flex: none;
  color: var(--ae-muted) !important;
  opacity: .6;
}

.trail__step {
  display: flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding-inline: 8px;
  border: 1px solid var(--ae-border);
  border-radius: 11px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  color: var(--ae-ink);
  transition: border-color .15s ease, background .15s ease;

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

.trail__step--disabled {
  opacity: .55;
  cursor: default;

  &:hover {
    border-color: var(--ae-border);
  }
}

.trail__step--ahead {
  border-style: dashed;
  color: var(--ae-muted);
}
</style>
