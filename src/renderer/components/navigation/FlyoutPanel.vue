<template>
  <div class="flyout-panel" :style="{ width: `${width}px` }">
    <div class="flyout-panel__head">
      <span class="flyout-panel__title">{{ title }}</span>
      <span class="flyout-panel__meta">{{ meta }}</span>
    </div>

    <slot />

    <div class="flyout-panel__foot"><slot name="foot" /></div>
  </div>
</template>

<script>
// The panel that slides out of the rail: a head with a title and a note, the content, and a foot. The title takes
// the colour `--sc` of whoever styles the panel.
export default {
  props: {
    title: {
      type: String,
      required: true,
    },
    meta: {
      type: String,
      default: '',
    },
    width: {
      type: Number,
      default: 330,
    },
  },
}
</script>

<style lang="scss" scoped>
.flyout-panel {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 80px;
  z-index: 7;
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
  .flyout-panel {
    animation: none;
  }
}

.flyout-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 10px 10px;
}

.flyout-panel__title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--sc);
}

.flyout-panel__meta {
  font-family: var(--ae-mono);
  font-size: 11px;
  color: var(--ae-muted);
}

.flyout-panel__foot {
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
