<template>
  <div class="save-status" :class="{ 'error--text': tone === 'bad' }" :title="detail" data-save-status>
    <v-icon x-small :color="tone === 'bad' ? 'error' : null" class="save-status__icon">{{ icon }}</v-icon>
    <span class="save-status__text">{{ text }}</span>
    <v-btn v-if="status === 'failed' || recovery.state !== 'ok'" x-small text color="error" class="save-status__retry" data-save-reopen @click="reopen">Reopen save</v-btn>
    <v-btn v-if="capabilityStatus === 'failed'" x-small text color="error" class="save-status__retry" data-capability-retry @click="recheck">Check again</v-btn>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import { gameTime } from '../../utilities/aurora'
import { describeRecovery } from '../../store/freshness'

const TICK_MS = 5000

// The wall-clock age of a moment, as the app measured it ("40 s", "3 min", "2 h", "5 d"; null under 5 s, which the caller words as "just now"); the caller adds "ago".
const ageLabel = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 5) {
    return null
  } else if (seconds < 60) {
    return `${seconds} s`
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min`
  } else if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} h`
  }

  return `${Math.floor(seconds / 86400)} d`
}

// What the shell says about how current its picture of the save is (store/freshness.js): when the last successful read happened by the wall clock, the game date that read returned for the selected game, and whether the latest refresh is still running or has failed (the read shown is then stale). A page whose inputs failed adds which ones, with the age of their last good read. The capability check of the copy (store/capabilities.js) adds a note only where the open page or the shell is not fully supported, and always a line to the hover text: the structure checked, apart from the formula version the schema stands for.
export default {
  name: 'SaveStatus',
  data () {
    return {
      now: Date.now(),
      timer: null,
    }
  },
  computed: {
    ...mapState('freshness', {
      read: 'read',
      refresh: 'refresh',
      file: 'file',
      inputs: 'inputs',
      recovery: 'recovery',
    }),
    ...mapGetters('freshness', [
      'status',
      'gameClock',
    ]),
    ...mapState('capabilities', {
      capabilityGeneration: 'generation',
      capabilityMessage: 'message',
    }),
    ...mapGetters('capabilities', {
      capabilities: 'result',
      capabilityStatus: 'status',
      reportOf: 'report',
    }),
    // The selected game's date at the last successful read, from its own StartYear and seconds, or null when no game is picked.
    gameDate () {
      return this.gameClock ? gameTime(this.gameClock.StartYear, this.gameClock.GameTime).format('YYYY-MM-DD HH:mm') : null
    },
    // The open page's inputs whose latest read failed: [{ label, readAt }], `readAt` null when the input never read.
    failedInputs () {
      const page = this.inputs[this.$route.path] || {}

      return Object.values(page).filter(({ failedAt }) => failedAt !== null)
    },
    // The open page's capability report, or null while the check has not answered.
    pageReport () {
      return this.reportOf(this.$route.path)
    },
    // What the check found short for the open page or the shell: '' when both are fully supported.
    capabilityText () {
      const parts = []

      if (this.capabilityStatus === 'failed') {
        parts.push('the save could not be checked for what it holds')
      }

      if (this.pageReport && this.pageReport.status !== 'supported') {
        parts.push(`this page is ${this.pageReport.status} by the save's structure`)
      }

      if (this.capabilities && this.capabilities.shell.status !== 'supported') {
        parts.push('some of what the shell reads is not in the save')
      }

      return parts.join(', ')
    },
    tone () {
      if (this.status === 'failed' || this.recovery.state === 'missing' || this.recovery.state === 'unreadable' || this.failedInputs.length || (this.pageReport && this.pageReport.status === 'unsupported') || this.capabilityStatus === 'failed') {
        return 'bad'
      }

      return this.status === 'ok' && this.recovery.state === 'ok' ? 'ok' : 'wait'
    },
    icon () {
      if (this.tone === 'bad') {
        return 'mdi-alert-outline'
      }

      return this.tone === 'ok' ? 'mdi-check-circle-outline' : 'mdi-timer-sand'
    },
    readAge () {
      return this.read ? ageLabel(this.now - this.read.at) : null
    },
    readText () {
      if (!this.read) {
        return 'No successful read of the save yet'
      }

      const when = this.readAge ? `${this.readAge} ago` : 'just now'

      return `Read ${when} (wall clock)${this.gameDate ? ` · game date ${this.gameDate}` : ''}`
    },
    // What the watcher's recovery says (missing, unreadable, reopening), in place of the plain refresh line.
    recoveryText () {
      return describeRecovery(this.recovery, this.now)
    },
    refreshText () {
      if (this.recoveryText) {
        return this.recoveryText
      }

      if (this.status === 'reading') {
        return this.read ? 'refreshing, so this read is the previous one' : 'reading'
      } else if (this.status === 'failed') {
        return `stale: the latest refresh failed (${this.refresh.message})`
      }

      return null
    },
    inputsText () {
      if (!this.failedInputs.length) {
        return null
      }

      const parts = this.failedInputs.map(({ label, readAt }) => {
        const age = readAt === null ? null : ageLabel(this.now - readAt)

        return readAt === null ? `${label} never read` : `${label} stale, last read ${age ? `${age} ago` : 'just now'}`
      })

      return `page inputs failed: ${parts.join('; ')}`
    },
    text () {
      return [this.readText, this.refreshText, this.inputsText, this.capabilityText].filter(Boolean).join(' · ')
    },
    // The full account, for the hover text: each fact with its own clock.
    detail () {
      const lines = [this.text]

      if (this.read) {
        lines.push(`Last successful read: ${new Date(this.read.at).toLocaleString()} (wall clock), database copy ${this.read.generation}`)
      }

      if (this.refresh) {
        lines.push(`Latest refresh: ${this.refresh.outcome}, started or ended ${new Date(this.refresh.at).toLocaleString()}, database copy ${this.refresh.generation}`)
      }

      if (this.file) {
        lines.push(`Last file notification: ${this.file.kind}${this.file.message ? ` (${this.file.message})` : ''} at ${new Date(this.file.at).toLocaleString()}. A notification alone is not a read.`)
      }

      lines.push(this.capabilityDetail)

      return lines.join('\n')
    },
    // The capability check of the copy now open, on its own line: its database copy number, the reports it found fully supported, and the formula version, which the schema only suggests.
    capabilityDetail () {
      if (this.capabilityStatus === 'failed') {
        return `Capability check of database copy ${this.capabilityGeneration} failed (${this.capabilityMessage}); ${this.capabilities ? 'the result of an earlier check of this copy stands' : 'the figures that rest on a lookup row are left out until it succeeds'}.`
      } else if (!this.capabilities) {
        return 'Capability check of the save: not finished, so the figures that rest on a lookup row are left out until it is.'
      }

      const reports = Object.values(this.capabilities.reports)
      const count = (status) => reports.filter((report) => report.status === status).length
      const formula = this.capabilities.formula.status === 'unavailable' ? `not stated (${this.capabilities.formula.inputs.missing.join(', ')} absent)` : `${this.capabilities.formula.value}, assumed from the schema, not a verified version`
      const gates = [...Object.values(this.capabilities.gates.bonuses), ...Object.values(this.capabilities.gates.components)]
      const unmatched = gates.filter((gate) => gate.status === 'unavailable').length

      return `Capability check of database copy ${this.capabilityGeneration}: ${count('supported')} of ${reports.length} reports supported, ${count('degraded')} degraded, ${count('unsupported')} unsupported; ${unmatched} of ${gates.length} lookup rows not as expected. Formula version: ${formula}.`
    },
  },
  created () {
    this.timer = setInterval(() => {
      this.now = Date.now()
    }, TICK_MS)
  },
  beforeDestroy () {
    clearInterval(this.timer)
  },
  methods: {
    // Runs the capability check again on the copy now open.
    recheck () {
      this.$store.dispatch('capabilities/retry')
    },
    // Opens the save again now, the automatic retries starting over: the refresh then ends in a probe that succeeds or fails.
    reopen () {
      this.$store.commit('freshness/retryRequested')
    },
  },
}
</script>

<style lang="scss" scoped>
.save-status {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-inline-start: 12px;
  max-width: 70%;
  font-size: calc(11px * var(--ae-font-scale));
  line-height: 1;
  white-space: nowrap;
  color: var(--ae-muted);
}

.save-status__text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
