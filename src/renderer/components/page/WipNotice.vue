<template>
  <v-alert type="warning" prominent border="left" colored-border elevation="2" icon="mdi-progress-wrench" class="wip-notice" role="status" data-wip-notice>
    <div class="wip-notice__title">Work in progress</div>
    <div class="body-2">{{ title }} is still under development: its controls, layout and figures may change, and its results are not final.</div>
  </v-alert>
</template>

<script>
// The notice a work-in-progress page (`wip` in utilities/navigation.js) opens under, above the page. The section flyout and the tab strip mark the same pages with a WIP chip.
export default {
  name: 'WipNotice',
  props: {
    // The page's title.
    title: {
      type: String,
      required: true,
    },
  },
}
</script>

<style lang="scss" scoped>
.wip-notice {
  margin: 0 12px 16px;
}

.wip-notice__title {
  font-size: calc(16px * var(--ae-font-scale));
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.4;
  text-transform: uppercase;
}
</style>
