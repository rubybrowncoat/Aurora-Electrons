<template>
  <v-card v-if="refusal" class="unsupported-save" outlined data-unsupported-save>
    <v-card-title class="unsupported-save__title"><v-icon left color="error">mdi-file-alert-outline</v-icon>Unsupported save</v-card-title>
    <v-card-text class="unsupported-save__body">
      <p class="body-1" :data-unsupported-reason="line.reason">{{ refusal.notice }}</p>
      <p>Aurora Electrons <span data-unsupported-version>{{ version }}</span> reads Aurora <span data-unsupported-line>{{ stated }}</span> saves only: a save of any other Aurora version is not read, and no figure on any page is for it. Open an Aurora {{ lineName }} save from the Empires page, or use Aurora Electrons <a :href="releaseUrl" target="_blank" rel="noopener" data-unsupported-release>{{ releaseVersion }}</a>, the last release that read older saves.</p>
      <template v-if="line.missing.length">
        <p class="mb-1">Columns Aurora {{ lineName }} added, absent from the save:</p>
        <ul class="unsupported-save__list">
          <li v-for="column in line.missing" :key="column" data-unsupported-column>{{ column }}</li>
        </ul>
      </template>
    </v-card-text>
    <v-card-actions>
      <v-btn small outlined :loading="checking" data-unsupported-retry @click="retry">Check again</v-btn>
    </v-card-actions>
  </v-card>
</template>

<script>
import { mapActions, mapGetters } from 'vuex'

import { LINE_NAME, REFUSALS, STATED_FORMULA_VERSION } from '../../utilities/capabilities'
import { version } from '../../../../package.json'

// The release of Aurora Electrons that still reads saves older than the line the app is for.
const RELEASE_VERSION = '0.11.0'
const RELEASES_URL = 'https://github.com/rubybrowncoat/Aurora-Electrons/releases/tag'

// What the app shows in place of a page, or of the empire list, when the save now open is not of the Aurora line the app reads (store/capabilities.js `line`, utilities/capabilities.js `lineResult`): one notice saying so, the columns of the line the save lacks, the release that read older saves, and a button to check the save again. It is no section panel: it stands where the page would, and the Save panel of the Empires page is left under it for opening another save.
export default {
  name: 'UnsupportedSave',
  data () {
    return {
      version,
      stated: STATED_FORMULA_VERSION,
      lineName: LINE_NAME,
      releaseVersion: RELEASE_VERSION,
      releaseUrl: `${RELEASES_URL}/v${RELEASE_VERSION}`,
    }
  },
  computed: {
    ...mapGetters('capabilities', [
      'line',
      'status',
    ]),
    checking () {
      return this.status === 'checking'
    },
    refusal () {
      return this.line ? REFUSALS[this.line.reason] : undefined
    },
  },
  methods: {
    ...mapActions('capabilities', {
      retry: 'retry',
    }),
  },
}
</script>

<style lang="scss" scoped>
.unsupported-save {
  margin-bottom: 16px;
}

.unsupported-save__list {
  margin: 0 0 8px;
  padding-inline-start: 20px;
  font-size: calc(13px * var(--ae-font-scale));
  line-height: 1.6;
}
</style>
