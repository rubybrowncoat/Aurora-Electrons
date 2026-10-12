<template>
  <div class="save-status" :class="{ 'error--text': tone === 'bad' }" :title="detail" data-save-status>
    <v-icon x-small :color="tone === 'bad' ? 'error' : null" class="save-status__icon">{{ icon }}</v-icon>
    <span class="save-status__text">{{ text }}</span>
    <v-btn v-if="status === 'failed'" x-small text color="error" class="save-status__retry" @click="reopen">Reopen save</v-btn>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import { gameTime } from '../../utilities/aurora'

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

// What the shell says about how current its picture of the save is (store/freshness.js): when the last successful read happened by the wall clock, the game date that read returned for the selected game, and whether the latest refresh is still running or has failed (the read shown is then stale). A page whose inputs failed adds which ones, with the age of their last good read.
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
    }),
    ...mapGetters('freshness', [
      'status',
      'gameClock',
    ]),
    ...mapGetters([
      'savePath',
    ]),

    // The selected game's date at the last successful read, from its own StartYear and seconds, or null when no game is picked.
    gameDate () {
      return this.gameClock ? gameTime(this.gameClock.StartYear, this.gameClock.GameTime).format('YYYY-MM-DD HH:mm') : null
    },
    // The open page's inputs whose latest read failed: [{ label, readAt }], `readAt` null when the input never read.
    failedInputs () {
      const page = this.inputs[this.$route.path] || {}

      return Object.values(page).filter(({ failedAt }) => failedAt !== null)
    },
    tone () {
      if (this.status === 'failed' || this.failedInputs.length) {
        return 'bad'
      }

      return this.status === 'ok' ? 'ok' : 'wait'
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
    refreshText () {
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
      return [this.readText, this.refreshText, this.inputsText].filter(Boolean).join(' · ')
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

      return lines.join('\n')
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
    // Opens the save again, as a file notification does: the refresh then ends in a probe that succeeds or fails.
    reopen () {
      this.$store.dispatch('renew', { storagePath: this.savePath })
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
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  color: var(--ae-muted);
}

.save-status__text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
