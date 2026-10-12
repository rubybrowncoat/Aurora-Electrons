<template>
  <nav v-show="visible" class="section-nav" :style="frame" aria-label="Sections">
    <div class="section-nav__ticks" @mouseleave="show(null)">
      <button v-for="(section, index) in sections" :key="section.key" type="button" class="section-nav__tick" :class="{ 'section-nav__tick--active': index === active, 'section-nav__tick--shown': index === shown }" :aria-label="section.title" :aria-current="index === active ? 'location' : null" @mouseenter="show(index, $event)" @focus="show(index, $event)" @blur="show(null)" @click="go(index)" />
    </div>

    <div v-if="card" ref="card" class="section-nav__card" :style="{ top: `${cardTop}px` }" aria-hidden="true">
      <div class="section-nav__title">{{ card.title }}</div>
      <div v-if="card.meta" class="section-nav__meta">{{ card.meta }}</div>
      <div v-if="card.summary" class="section-nav__summary">{{ card.summary }}</div>
    </div>
  </nav>
</template>

<script>
// A column of ticks at the right edge of the window, one for each section of the page, that scrolls to a section when one is clicked and shows its title, figures and summary when one is hovered. A section is a `.panel` with a `.panel-head` (styles/page-chrome.scss): its title is the text of the head's first element, its figures the chips and secondary notes in the head and the size of its table, and its summary the panel's `data-summary` attribute, shown in full. The ticks show once a page has two sections and is too long for the window.

const SCAN_DELAY = 200

// How far below the app bar a section's head lands when its tick is clicked.
const SCROLL_MARGIN = 12

// What in a head is a figure rather than the title, and what is neither.
const FIGURES = '.v-chip, .caption, .text--secondary'
const CONTROLS = '.legend, .v-btn, .v-input'

const squash = (text) => text.replace(/\s+/g, ' ').trim()

// Whether the element is in, or is, an element matching the selector below the root.
const within = (element, selector, root) => {
  const found = element.closest(selector)

  return Boolean(found) && found !== root && root.contains(found)
}

// The panel's own part, not that of a panel inside it.
const partOf = (panel, name) => [...panel.querySelectorAll(`.${name}`)].find((part) => part.closest('.panel') === panel)

const titleOf = (head) => {
  const holder = head.firstElementChild
  const texts = []

  if (holder && !holder.matches(CONTROLS)) {
    const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT)

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!within(node.parentElement, FIGURES, holder)) {
        texts.push(node.textContent)
      }
    }
  }

  return squash(texts.join(' '))
}

const figuresOf = (head) => [...head.querySelectorAll(FIGURES)].filter((figure) => figure !== head.firstElementChild && !within(figure.parentElement, FIGURES, head) && !within(figure, CONTROLS, head)).map((figure) => squash(figure.textContent)).filter(Boolean)

// The number of rows in the panel's table, unless a figure in the head already gives it.
const rowsOf = (panel, figures) => {
  const pagination = partOf(panel, 'v-data-footer__pagination')
  const total = pagination && /of\s+([\d'’,.]+)/.exec(pagination.textContent)

  if (!total || figures.some((figure) => figure.split(/[^\d'’,.]+/).includes(total[1]))) {
    return []
  }

  return [`${total[1]} ${total[1] === '1' ? 'row' : 'rows'}`]
}

const describe = (panel) => {
  const head = partOf(panel, 'panel-head')
  const figures = figuresOf(head)

  return {
    title: titleOf(head),
    meta: [...figures, ...rowsOf(panel, figures)].join(' · '),
    summary: squash(panel.dataset.summary || ''),
  }
}

export default {
  data () {
    return {
      sections: [],
      scrolls: false,
      active: 0,
      shown: null,
      card: null,
      cardTop: 0,
    }
  },
  computed: {
    visible () {
      return this.sections.length > 1 && this.scrolls
    },
    frame () {
      const { bar, top, bottom, footer, insetFooter, right } = this.$vuetify.application

      return {
        top: `${bar + top}px`,
        bottom: `${footer + insetFooter + bottom}px`,
        right: `${right}px`,
      }
    },
  },
  watch: {
    '$route.path' () {
      this.panels = []
      this.pin = null
      this.sections = []
      this.show(null)
      this.$nextTick(this.scan)
    },
  },
  created () {
    // The panels behind the ticks, in the same order, and the section last clicked with the scroll position the page came to rest at, null while it is still scrolling there. That section stays the active one until the page moves on.
    this.panels = []
    this.pin = null
  },
  mounted () {
    const root = this.$el.parentElement

    this.observer = new MutationObserver((records) => {
      if (records.some(({ target }) => !this.$el.contains(target))) {
        this.scanSoon()
      }
    })
    this.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] })

    this.resizeObserver = new ResizeObserver(this.scanSoon)
    this.resizeObserver.observe(root)

    window.addEventListener('scroll', this.track, { passive: true })
    window.addEventListener('scrollend', this.settle)
    window.addEventListener('resize', this.scanSoon)

    for (const type of ['wheel', 'touchstart', 'keydown']) {
      window.addEventListener(type, this.unpin, { passive: true })
    }

    this.scan()
  },
  beforeDestroy () {
    this.observer.disconnect()
    this.resizeObserver.disconnect()

    window.removeEventListener('scroll', this.track)
    window.removeEventListener('scrollend', this.settle)
    window.removeEventListener('resize', this.scanSoon)

    for (const type of ['wheel', 'touchstart', 'keydown']) {
      window.removeEventListener(type, this.unpin)
    }

    clearTimeout(this.scanTimer)
    cancelAnimationFrame(this.trackFrame)
  },
  methods: {
    scanSoon () {
      if (!this.scanTimer) {
        this.scanTimer = setTimeout(this.scan, SCAN_DELAY)
      }
    },
    // Panels in reading order: by their top, then left to right for panels side by side. A panel nested in another panel, hidden, or without a title is not a section.
    scan () {
      this.scanTimer = null

      const root = this.$el.parentElement
      const scroller = document.scrollingElement
      const found = [...root.querySelectorAll('.panel')].filter((panel) => !panel.parentElement.closest('.panel') && panel.getClientRects().length).map((panel) => {
        const head = partOf(panel, 'panel-head')

        return { panel, title: head ? titleOf(head) : '', rect: panel.getBoundingClientRect() }
      }).filter(({ title }) => title).sort((a, b) => (Math.round(a.rect.top) - Math.round(b.rect.top)) || (a.rect.left - b.rect.left))

      this.panels = found.map(({ panel }) => panel)
      this.sections = found.map(({ title }, index) => ({ key: `${index}:${title}`, title }))
      this.scrolls = scroller.scrollHeight > scroller.clientHeight + 1

      if (this.shown !== null && this.shown >= this.sections.length) {
        this.show(null)
      }

      this.active = this.current()
    },

    track () {
      if (!this.trackFrame) {
        this.trackFrame = requestAnimationFrame(() => {
          this.trackFrame = null
          this.active = this.current()
        })
      }
    },
    unpin () {
      this.pin = null
    },
    settle () {
      if (this.pin && this.pin.at === null) {
        this.pin.at = window.scrollY
      }
    },
    // The section being read: the one clicked, while the page goes to it and stays there; the last section once the page is scrolled to its end; otherwise the last whose top is above a line a third of the way down the window.
    current () {
      const { panels } = this
      const { bar, top, bottom, footer, insetFooter } = this.$vuetify.application
      const viewTop = bar + top
      const viewBottom = window.innerHeight - footer - insetFooter - bottom

      if (this.pin && panels[this.pin.index]) {
        if (this.pin.at === null || Math.abs(window.scrollY - this.pin.at) <= 2) {
          return this.pin.index
        }

        this.pin = null
      }

      const scroller = document.scrollingElement

      if (panels.length && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        return panels.length - 1
      }

      const line = viewTop + (viewBottom - viewTop) / 3

      return Math.max(0, panels.findLastIndex((panel) => panel.getBoundingClientRect().top <= line))
    },

    go (index) {
      const scroller = document.scrollingElement
      const { bar, top } = this.$vuetify.application
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const target = this.panels[index].getBoundingClientRect().top + window.scrollY - bar - top - SCROLL_MARGIN
      const destination = Math.round(Math.min(Math.max(0, target), scroller.scrollHeight - scroller.clientHeight))

      this.pin = { index, at: null }
      this.active = index
      window.scrollTo({ top: destination, behavior: reduce ? 'auto' : 'smooth' })

      // Already there, or jumped there: no scroll is left to end.
      if (Math.abs(window.scrollY - destination) < 1) {
        this.settle()
      }
    },

    // The card beside a tick, read from the page as it is now, centred on the tick but kept inside the strip.
    show (index, event) {
      this.shown = index
      this.card = index === null ? null : describe(this.panels[index])

      if (this.card) {
        const tick = event.currentTarget.getBoundingClientRect()

        this.$nextTick(() => {
          const strip = this.$el.getBoundingClientRect()
          const height = this.$refs.card.offsetHeight
          const centre = tick.top + tick.height / 2 - strip.top

          this.cardTop = Math.min(Math.max(0, centre - height / 2), strip.height - height)
        })
      }
    },
  },
}
</script>

<style lang="scss" scoped>
.section-nav {
  position: fixed;
  z-index: 4;
  width: 28px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  pointer-events: none;
}

.section-nav__ticks {
  max-height: 100%;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

// The button is the whole width of the strip; the tick drawn in it grows leftwards from the right edge.
.section-nav__tick {
  flex: 0 1 12px;
  min-height: 4px;
  width: 28px;
  padding: 0 5px 0 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  background: none;
  border: 0;
  cursor: pointer;

  &::after {
    content: '';
    width: 8px;
    height: 2px;
    border-radius: 1px;
    background: var(--ae-muted);
    opacity: .45;
    transition: width .12s ease-out, opacity .12s ease-out;
  }

  &:focus {
    outline: none;
  }

  &:focus-visible::after {
    outline: 2px solid var(--ae-primary);
    outline-offset: 2px;
  }
}

.section-nav__tick--active::after {
  width: 12px;
  background: var(--sc, var(--ae-ink));
  opacity: 1;
}

.section-nav__tick--shown::after {
  width: 16px;
  background: var(--ae-ink);
  opacity: 1;
}

.section-nav__card {
  position: absolute;
  right: calc(100% + 4px);
  width: 280px;
  padding: 10px 14px 12px;
  border: 1px solid var(--ae-border);
  border-radius: 12px;
  background: var(--ae-bg);
  box-shadow: 0 6px 24px rgba(0, 0, 0, .14);
  pointer-events: none;
}

.section-nav__title {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--ae-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-nav__meta {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 2px;
  font-size: 12px;
  line-height: 17px;
  color: var(--ae-ink);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.section-nav__summary {
  margin-top: 4px;
  font-size: 12px;
  line-height: 17px;
  color: var(--ae-muted);
}

@media (prefers-reduced-motion: reduce) {
  .section-nav__tick::after {
    transition: none;
  }
}
</style>
