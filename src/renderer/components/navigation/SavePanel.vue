<template>
  <v-card class="panel save-panel" data-summary="The save this window shows and the saves opened before it." elevation="1" data-save-panel>
    <div class="panel-head">
      <span>Save</span>
      <v-btn small outlined :disabled="busy" data-save-choose @click="choose"><v-icon small left>mdi-folder-open-outline</v-icon>Open a save…</v-btn>
    </div>
    <div class="panel-body">
      <div class="save-panel__active" data-save-active>
        <span class="text--secondary">Showing</span>
        <code class="save-panel__path">{{ shown || 'no save yet' }}</code>
        <v-chip v-if="active && active.state === 'unavailable'" x-small label color="error" outlined data-save-active-state>{{ active.reason }}</v-chip>
        <v-btn v-if="active && active.state === 'unavailable'" x-small text color="error" :disabled="busy" data-save-retry-active @click="select(active.path)">Retry</v-btn>
      </div>
      <v-alert v-if="recoveryText" dense text :type="recovery.state === 'reconnecting' ? 'info' : 'warning'" class="mt-3 mb-0" data-save-recovery :data-save-recovery-state="recovery.state">
        <span>{{ recoveryText }}.</span>
        <v-btn x-small text class="ml-2" data-save-recovery-retry @click="retryNow">Retry</v-btn>
      </v-alert>
      <v-alert v-if="dropped" dense text type="warning" class="mt-3 mb-0" data-save-dropped>
        <span v-if="dropped.kind === 'game'">The game{{ dropped.name ? ` ${dropped.name}` : '' }} is no longer in the save, so its selection and what was shown for it were cleared. Pick an empire to go on.</span>
        <span v-else>The empire{{ dropped.name ? ` ${dropped.name}` : '' }} is no longer in the save, so its selection and what was shown for it were cleared. The game stays picked; pick an empire to go on.</span>
      </v-alert>
      <v-alert v-if="notice" dense text :type="notice.tone" class="mt-3 mb-0" data-save-notice>
        <span>{{ notice.text }}</span>
        <v-btn v-if="notice.retry" x-small text :disabled="busy" class="ml-2" data-save-retry-notice @click="select(notice.retry)">Retry</v-btn>
      </v-alert>
      <v-alert v-if="error" dense text type="error" class="mt-3 mb-0">Couldn't read the recent saves: {{ error }}</v-alert>
    </div>
    <v-list v-if="recent.length" dense class="save-panel__recent" data-save-recent>
      <v-subheader>Recent saves, newest first. Up to {{ limit }} are kept.</v-subheader>
      <v-list-item v-for="entry in recent" :key="entry.path" :data-save-entry="entry.path" :data-save-state="entry.state" :class="{ 'save-panel__entry--unavailable': entry.state === 'unavailable' }">
        <v-list-item-content>
          <v-list-item-title>{{ entry.name }}</v-list-item-title>
          <v-list-item-subtitle :title="entry.path">{{ entry.folder }}</v-list-item-subtitle>
          <v-list-item-subtitle v-if="entry.state === 'unavailable'" class="error--text">Unavailable: {{ entry.reason }}</v-list-item-subtitle>
        </v-list-item-content>
        <v-list-item-action class="save-panel__actions">
          <v-chip v-if="entry.active" x-small label color="primary" outlined>Showing</v-chip>
          <v-chip v-else-if="entry.openElsewhere" x-small label outlined>Open in another window</v-chip>
          <v-btn v-if="entry.state === 'unavailable'" x-small text color="error" :disabled="busy" data-save-retry @click="select(entry.path)">Retry</v-btn>
          <v-btn v-else-if="!entry.active" x-small text :disabled="busy" data-save-open @click="select(entry.path)">{{ entry.openElsewhere ? 'Go to window' : 'Open' }}</v-btn>
          <v-btn v-if="!entry.active" x-small icon title="Forget this save" :disabled="busy" data-save-forget @click="forget(entry.path)"><v-icon small>mdi-close</v-icon></v-btn>
        </v-list-item-action>
      </v-list-item>
    </v-list>
    <div v-else-if="loaded" class="panel-body text--secondary pt-0">No other saves opened yet.</div>
    <div class="panel-foot text--secondary caption">Use it to open another save file, return to an earlier one, or retry one that could not be reached or read. A save is only read: opening one never moves, copies or edits the file. A save already open in another window is brought to the front instead of opened twice.</div>
  </v-card>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import { describeRecovery } from '../../store/freshness'

// The active save and the recent ones (store/saves.js, kept by the main process): open another with the system dialog, return to an earlier one, retry one that could not be reached, drop one from the list.
export default {
  name: 'SavePanel',
  data () {
    return {
      now: Date.now(),
      timer: null,
    }
  },
  computed: {
    ...mapState('freshness', [
      'recovery',
    ]),
    ...mapState('empires', [
      'dropped',
    ]),

    ...mapState('saves', [
      'active',
      'recent',
      'limit',
      'error',
      'loaded',
      'busy',
      'notice',
    ]),
    ...mapGetters([
      'savePath',
    ]),

    // The window's own word for the save, which the main process confirms in `active`.
    recoveryText () {
      return describeRecovery(this.recovery, this.now)
    },
    shown () {
      return (this.active && this.active.path) || this.savePath
    },
  },
  created () {
    this.$store.dispatch('saves/load')
    this.timer = setInterval(() => {
      this.now = Date.now()
    }, 1000)
  },
  beforeDestroy () {
    clearInterval(this.timer)
  },
  methods: {
    // Opens the save again now; the automatic retries start over.
    retryNow () {
      this.$store.commit('freshness/retryRequested')
    },
    choose () {
      this.$store.dispatch('saves/choose')
    },
    select (path) {
      this.$store.dispatch('saves/select', path)
    },
    forget (path) {
      this.$store.dispatch('saves/forget', path)
    },
  },
}
</script>

<style lang="scss" scoped>
.save-panel {
  &__active {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__path {
    overflow-wrap: anywhere;
  }

  &__actions {
    flex-direction: row;
    align-items: center;
    gap: 4px;
  }

  &__entry--unavailable {
    opacity: .9;
  }
}
</style>
