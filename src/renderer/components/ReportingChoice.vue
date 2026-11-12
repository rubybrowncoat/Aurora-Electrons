<template>
  <div>
    <v-dialog v-if="prompt" :value="showPrompt" max-width="620" persistent>
      <v-card data-reporting-prompt>
        <v-card-title class="subtitle-1">Optional error and crash reporting</v-card-title>
        <v-card-text>
          <p>Reporting is off until enabled. Declining keeps every app feature available. This choice applies to every window and can be changed in Settings.</p>
          <p>When enabled, Sentry receives error text, redacted stacks, app/runtime versions and native crash minidumps. Minidumps may contain memory, local paths and save-related information that text redaction cannot remove.</p>
          <p>No screenshots, replay, profiling, session tracking, network or SQL breadcrumbs are collected. Disabling blocks new uploads immediately; already transmitted bytes cannot be recalled. Restart is needed to stop native collection completely.</p>
          <v-btn text small @click="privacy">Read privacy policy</v-btn>
          <v-alert v-for="message in problems" :key="message" type="warning" text dense>{{ message }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn outlined :disabled="busy" data-reporting-decline @click="choose(false)">Keep reporting off</v-btn>
          <v-btn text :disabled="busy" data-reporting-enable @click="choose(true)">Enable reporting</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-card v-else class="panel" data-reporting-settings data-summary="Choose app-wide error and native crash reporting and read its privacy limits." elevation="1">
      <div class="panel-head"><span>Error and crash reporting</span></div>
      <div class="panel-body">
        <p class="body-2" data-reporting-status>{{ status }}</p>
        <template v-if="state.available">
          <p class="body-2">Optional reporting sends Sentry error text, redacted stacks, app/runtime versions and native crash minidumps. Native dumps can contain memory, paths and save-related information even after text fields are redacted.</p>
          <p class="body-2">No screenshots, user attachments, replay, profiling, session tracking, network or SQL breadcrumbs are collected. There is no offline report queue. Reports already transmitted cannot be recalled; active requests are aborted where possible.</p>
          <p v-if="state.restartRequired" class="body-2" data-reporting-restart>Uploads are blocked for this session. Save reporting off, restart, then enable reporting here if wanted. Restart while off stops native collection and removes dumps only from the app's validated reporting folder. It cannot be enabled again before restart; if saving off failed, the previous saved choice may survive.</p>
          <v-btn v-if="state.enabled || state.savedChoice === true" outlined :disabled="busy" data-reporting-disable @click="choose(false)">Disable reporting</v-btn>
          <v-btn v-else outlined :disabled="busy || state.restartRequired || !state.loaded" data-reporting-enable @click="choose(true)">Enable reporting</v-btn>
          <v-btn v-if="state.cleanupError || state.persistenceError" text :disabled="busy" data-reporting-decline @click="choose(false)">Keep reporting off and retry saving</v-btn>
        </template>
        <v-btn text small @click="privacy">Privacy policy</v-btn>
        <v-alert v-for="message in problems" :key="message" type="warning" text dense class="mt-3 mb-0">{{ message }}</v-alert>
      </div>
      <div class="panel-foot caption text--secondary">Use Enable reporting to opt in, Disable reporting to block uploads, and Privacy policy to read the policy. The desktop app keeps this choice in reporting.json in its app data folder, separately from ordinary preferences, exports, imports, resets and undo. Native collection can continue until restart after disabling. Server retention is governed by the receiving service, not a local deletion promise.</div>
    </v-card>
  </div>
</template>

<script>
import { shell } from 'electron'
import { chooseReporting, reporting } from '../utilities/reporting'

export default {
  name: 'ReportingChoice',
  props: { prompt: Boolean },
  data: () => ({ state: reporting, busy: false, dismissed: false }),
  computed: {
    showPrompt () { return this.state.loaded && this.state.available && this.state.savedChoice === null && !this.dismissed },
    problems () { return [...new Set([this.state.persistenceError, this.state.cleanupError, this.state.error].filter(Boolean))] },
    status () {
      if (!this.state.loaded) return 'Reading the reporting choice…'
      if (!this.state.available) return 'Reporting is unavailable and remains off in web, development and ordinary smoke-test modes.'
      if (this.state.enabled) return 'Reporting is enabled for every window.'
      if (this.state.savedChoice === true) return 'Reporting is off in this session. The saved choice is still enabled; see the warning below.'
      return 'Reporting is off. Every app feature remains available.'
    },
  },
  methods: {
    async choose (enabled) {
      this.busy = true
      try {
        await chooseReporting(enabled)
        if (!enabled || this.state.enabled) this.dismissed = true
      } finally {
        this.busy = false
      }
    },
    privacy () { shell.openExternal('https://github.com/rubybrowncoat/Aurora-Electrons/blob/signpath-preparation/PRIVACY.md') },
  },
}
</script>
