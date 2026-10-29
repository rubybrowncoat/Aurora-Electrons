<template>
  <v-alert type="warning" :prominent="!panel" :dense="panel" border="left" colored-border :elevation="panel ? 0 : 2" icon="mdi-progress-wrench" class="wip-notice" :class="{ 'wip-notice--panel': panel }" role="status" data-wip-notice>
    <div class="wip-notice__title">Work in progress</div>
    <div class="body-2">{{ title }} is still under development: its controls, layout and figures may change, and its results are not final.</div>
  </v-alert>
</template>

<script>
// The notice a work-in-progress page (`wip` in utilities/navigation.js) opens under, above the page. The section flyout and the tab strip mark the same pages with a WIP chip. With `panel` it is the compact notice inside a work-in-progress section panel, under the panel's head, where the head holds the WIP chip.
export default {
  name: 'WipNotice',
  props: {
    // What is unfinished: the page's title, or the section's name.
    title: {
      type: String,
      required: true,
    },
    // The notice of one section panel and not of a whole page.
    panel: {
      type: Boolean,
      default: false,
    },
  },
}
</script>

<style lang="scss" scoped>
.wip-notice {
  margin: 0 12px 16px;
}

.wip-notice--panel {
  margin: 12px 16px 4px;
}

.wip-notice__title {
  font-size: calc(16px * var(--ae-font-scale));
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.4;
  text-transform: uppercase;
}

.wip-notice--panel .wip-notice__title {
  font-size: calc(14px * var(--ae-font-scale));
}
</style>
