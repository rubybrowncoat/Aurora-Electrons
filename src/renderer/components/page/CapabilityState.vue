<template>
  <v-card v-if="unsupported" class="panel capability-state" elevation="1" :data-summary="`What the save lacks for ${title}, so the page is not shown, and a button to check the save again.`" data-capability-state="unsupported">
    <div class="panel-head">
      <span><v-icon small left color="error">mdi-alert-outline</v-icon>{{ title }} cannot be shown for this save</span>
      <v-btn small outlined :loading="checking" data-capability-retry @click="$emit('retry')">Check again</v-btn>
    </div>
    <div class="panel-body">
      <div class="body-2">The save lacks fields this page reads, so it shows nothing rather than figures that could be wrong. The other pages are not affected.</div>
      <ul class="capability-state__list">
        <li v-for="entry in notes.missing" :key="`missing ${entry.text}`"><strong>{{ upper(entry.text) }}</strong> cannot be read: {{ entry.fields.join(', ') }}</li>
        <li v-for="entry in notes.degraded" :key="`degraded ${entry.text}`">{{ upper(entry.text) }}: {{ entry.fields.join(', ') }}<span v-if="entry.effect">. {{ entry.effect }}</span></li>
      </ul>
    </div>
    <div class="panel-foot caption text--secondary">The check reads the save's structure only and never changes it. It runs again when the save changes, and on request.</div>
  </v-card>
  <v-alert v-else-if="notes.degraded.length" type="warning" outlined dense class="capability-state" data-capability-state="degraded">
    <div>Part of this page is left out, because the save differs from what the page reads:</div>
    <ul class="capability-state__list">
      <li v-for="entry in notes.degraded" :key="entry.text">{{ upper(entry.text) }}: {{ entry.fields.join(', ') }}<span v-if="entry.effect">. {{ entry.effect }}</span></li>
    </ul>
    <template #append>
      <v-btn small text color="warning" :loading="checking" data-capability-retry @click="$emit('retry')">Check again</v-btn>
    </template>
  </v-alert>
</template>

<script>
import { describeReport } from '../../utilities/capabilities'

// What a page shows when the capability check (store/capabilities.js, utilities/capabilities.js) found the save short of what it reads, or holding it differently. An unsupported report replaces the page with a panel naming what is missing; a degraded one is a notice above the page, which leaves out what depended on the missing fields. Both have a button to run the check again on the copy now open.
export default {
  name: 'CapabilityState',
  props: {
    // The report of the open route: { status, missing, degraded }.
    report: {
      type: Object,
      required: true,
    },
    // The page's title.
    title: {
      type: String,
      default: 'The page',
    },
    // Whether a new check is running.
    checking: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    unsupported() {
      return this.report.status === 'unsupported'
    },
    notes() {
      return describeReport(this.report)
    },
  },
  methods: {
    upper(text) {
      return text.charAt(0).toUpperCase() + text.slice(1)
    },
  },
}
</script>

<style lang="scss" scoped>
.capability-state {
  margin-bottom: 16px;
}

.capability-state__list {
  margin: 8px 0 0;
  padding-inline-start: 20px;
  font-size: calc(13px * var(--ae-font-scale));
  line-height: 1.6;
}
</style>
