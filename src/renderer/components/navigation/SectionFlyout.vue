<template>
  <div class="section-flyout">
    <div class="section-flyout__head">
      <span class="section-flyout__title">{{ section.title }}</span>
      <span class="section-flyout__count">{{ pages.filter(({ planned }) => !planned).length }} pages · Ctrl {{ shortcut }}</span>
    </div>

    <div
      v-for="page in pages"
      :key="page.route"
      class="section-flyout__item"
      :class="{ 'section-flyout__item--active': page.route === activeRoute, 'section-flyout__item--disabled': page.disabled || page.planned }"
      role="link"
      :tabindex="page.disabled || page.planned ? -1 : 0"
      @click="page.disabled || page.planned || $emit('go', page.route)"
      @keydown.enter="page.disabled || page.planned || $emit('go', page.route)"
    >
      <div class="section-flyout__icon">
        <v-icon size="20">{{ page.icon }}</v-icon>
      </div>
      <div class="section-flyout__name">{{ page.title }}</div>
      <div>
        <v-chip v-if="page.planned" x-small label>Planned</v-chip>
        <v-chip v-else-if="page.wip" x-small label outlined>WIP</v-chip>
      </div>
      <div class="section-flyout__blurb">{{ page.blurb }}</div>
      <div v-if="page.peekable" class="section-flyout__peek">
        <transition name="peek-fade">
          <span v-if="peeks[page.route]">{{ peeks[page.route] }}</span>
        </transition>
      </div>
    </div>

    <div class="section-flyout__foot"><kbd>Ctrl K</kbd> search every page <kbd>Alt ←</kbd> back</div>
  </div>
</template>

<script>
export default {
  props: {
    section: {
      type: Object,
      required: true,
    },
    // The section's pages, each with a `disabled` flag; `planned` ones are listed but can't be opened.
    pages: {
      type: Array,
      required: true,
    },
    activeRoute: {
      type: String,
      required: true,
    },
    // The section's Ctrl+<n> key.
    shortcut: {
      type: Number,
      required: true,
    },
    // route -> the live line under a `peekable` page, once it has loaded.
    peeks: {
      type: Object,
      default: () => ({}),
    },
  },
}
</script>

<style lang="scss" scoped>
.section-flyout {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 80px;
  z-index: 7;
  width: 330px;
  max-width: calc(100vw - 96px);
  padding: 18px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  background: var(--ae-chrome);
  border-right: 1px solid var(--ae-border);
  box-shadow: 8px 0 24px rgba(0, 0, 0, .12);
  animation: fly-in .14s ease-out;
}

@keyframes fly-in {
  from {
    transform: translateX(-12px);
    opacity: .4;
  }

  to {
    transform: none;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .section-flyout {
    animation: none;
  }
}

.section-flyout__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 10px 10px;
}

.section-flyout__title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--sc);
}

.section-flyout__count {
  font-family: var(--ae-mono);
  font-size: 11px;
  color: var(--ae-muted);
}

.section-flyout__item {
  display: grid;
  grid-template-columns: 36px 1fr auto;
  gap: 2px 12px;
  align-items: start;
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--ae-ink);

  &:not(.section-flyout__item--disabled):hover {
    background: var(--ae-hover);
  }
}

.section-flyout__item--active {
  background: var(--sc-soft);
}

.section-flyout__item--disabled {
  opacity: .55;
  cursor: default;
}

.section-flyout__icon {
  grid-row: span 2;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: var(--sc-tint);

  .v-icon {
    color: var(--sc) !important;
  }
}

.section-flyout__name {
  font-size: 14px;
  font-weight: 500;
}

.section-flyout__blurb {
  grid-column: 2 / 4;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ae-muted);
}

.section-flyout__peek {
  grid-column: 2 / 4;
  min-height: 16px;
  padding-top: 4px;
  font-family: var(--ae-mono);
  font-size: 11px;
  line-height: 12px;
  color: var(--ae-ink);
  opacity: .8;
}

.peek-fade-enter-active {
  transition: opacity .25s ease;
}

.peek-fade-enter {
  opacity: 0;
}

.section-flyout__foot {
  margin-top: auto;
  padding: 12px 10px 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--ae-muted);
}
</style>
