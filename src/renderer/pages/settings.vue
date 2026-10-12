<template>
  <div>
    <v-container fluid class="settings-page">
      <v-row>
        <v-col cols="12" md="6" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="Choices that change how every page looks and reads, such as number format and the colour preset. Use it to set the app up, and to preview a preset on every page before keeping it." elevation="1">
            <div class="panel-head"><span>Display</span></div>
            <div class="panel-body">
              <div class="setting setting--block">
                <div class="setting__text">
                  <div class="body-2">Colour preset</div>
                  <div class="caption text--secondary">{{ presetNote }}</div>
                </div>
                <div class="presets" role="group" aria-label="Colour presets">
                  <preset-card v-for="preset in presets" :key="preset.id" :appearance="preset" :active="preset.id === activeId" :applied="preset.id === appliedId" @select="preview" />
                </div>
                <div class="presets__actions">
                  <v-btn small depressed color="primary" :disabled="!previewing" data-preset-action="apply" @click="applyDraft">Apply</v-btn>
                  <v-btn small outlined :disabled="!previewing" data-preset-action="cancel" @click="cancelDraft">Cancel</v-btn>
                  <v-btn small text :disabled="activeId === defaultId" data-preset-action="reset" @click="resetDraft">Reset to {{ defaultName }}</v-btn>
                </div>
              </div>
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">Thousands separator</div>
                  <div class="caption text--secondary">How every page writes large numbers.</div>
                </div>
                <v-select :value="separatorName" :items="separatorOptions" aria-label="Thousands separator" class="setting__control" dense outlined hide-details @change="setSeparator" />
              </div>
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">Dark theme</div>
                  <div class="caption text--secondary">Applies the Light or Dark preset at once, as the lamp in the app bar does.</div>
                </div>
                <v-switch :input-value="dark" aria-label="Dark theme" class="setting__switch" inset dense hide-details @change="setDark" />
              </div>
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">Computer-run empires</div>
                  <div class="caption text--secondary">Lists the NPR empires on the Empires page beside the players' ones, so their data can be opened, and adds the Rivals chart to Empire History.</div>
                </div>
                <v-switch :input-value="spyNPR" aria-label="Computer-run empires" class="setting__switch" inset dense hide-details @change="setSpyNPR" />
              </div>
            </div>
            <div class="panel-foot caption text--secondary">A preset's sample uses example data. Choosing one previews it on every page; Apply keeps it, and Cancel, or leaving Settings, returns to the kept one. Resetting a preset changes no other setting. Number format and Computer-run empires apply at once; every setting is kept in the settings file, and About shows where it is.</div>
          </v-card>
        </v-col>

        <v-col cols="12" md="6" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="The options, filters and table layouts each page has remembered. Use it to clear them and bring every page back to its defaults." elevation="1">
            <div class="panel-head">
              <span>Remembered views</span>
              <v-chip small>{{ count(totalCount) }} {{ totalCount === 1 ? 'value' : 'values' }}</v-chip>
            </div>
            <div class="panel-body">
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">{{ empireName || 'This empire' }}</div>
                  <div class="caption text--secondary">{{ empireNote }}</div>
                </div>
                <v-btn outlined :disabled="!empireCount" @click="ask('empire')">Reset</v-btn>
              </div>
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">Every empire and the app-wide views</div>
                  <div class="caption text--secondary">{{ allNote }}</div>
                </div>
                <v-btn outlined color="error" :disabled="!totalCount" @click="ask('all')">Reset all</v-btn>
              </div>
            </div>
            <div class="panel-foot caption text--secondary">Each page remembers its options, filters, searches, views, and each table's sort and rows per page: app-wide, or per empire for what is about the empire's own things (its systems, colonies, fleets, a search over them). A reset brings back each page's defaults the next time it opens. It keeps the Display settings, the Warnings mutes, the Galaxy Map's pinned systems and clusters, what was new at the last visit to the Game Log and Warnings, and Empire History, which has files of its own.</div>
          </v-card>
        </v-col>
      </v-row>

      <v-dialog :value="Boolean(pending)" max-width="460" @input="(open) => !open && (pending = null)">
        <v-card v-if="pending">
          <v-card-title class="subtitle-1">{{ pending.title }}</v-card-title>
          <v-card-text>{{ pending.text }}</v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn text @click="pending = null">Cancel</v-btn>
            <v-btn text color="error" @click="reset">Reset</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
  </div>
</template>

<script>
import { mapActions, mapGetters, mapState } from 'vuex'

import PresetCard from '../components/settings/PresetCard.vue'
import countFormat from '../mixins/count-format'
import { APPEARANCE_KEY, DEFAULT_PRESET_ID, activeAppearance, appliedPresetId, applyMode, applyPreset, cancelPreview, isPreviewing, listAppearances, previewPreset, resolveAppearance, unsupportedPresetId } from '../utilities/appearance'
import { separatedNumber, thousandsSeparator } from '../utilities/math'

const SEPARATORS = ['Tick', 'Comma', 'Dash', 'Space', 'None']

// The settings the Display panel holds. A reset keeps them. `darkMode` is no longer written; a file that still holds it keeps it.
const APP_SETTINGS = [APPEARANCE_KEY, 'darkMode', 'spyNPR', 'selectedSeparator']
// What an empire's pages keep that isn't a view: the Warnings mutes and what each check listed at the last visit, the Game Log's last event seen, and the Galaxy Map's pinned systems and clusters. A reset keeps them too.
const KEPT_EMPIRE_KEYS = ['warningsMuted', 'warningsLastLook', 'logLastSeen', 'mapPinned', 'mapGroups']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The app-wide keys a reset clears: every top-level key but the empires' and the Display settings.
const appViews = (store) => Object.keys(store).filter((key) => key !== 'game' && !APP_SETTINGS.includes(key))

// The keys a reset clears for each empire with any stored: [{ GameID, RaceID, keys }], ids as stored (strings).
const empireViews = (store) => Object.entries(isObject(store.game) ? store.game : {}).flatMap(([GameID, game]) => Object.entries(isObject(game) && isObject(game.race) ? game.race : {}).map(([RaceID, values]) => ({ GameID, RaceID, keys: isObject(values) ? Object.keys(values).filter((key) => !KEPT_EMPIRE_KEYS.includes(key)) : [] }))).filter(({ keys }) => keys.length)

// The settings with the views cleared: one empire's (`only`, { GameID, RaceID }), or every empire's and the app-wide ones.
const withoutViews = (store, only) => {
  const next = JSON.parse(JSON.stringify(store))

  if (!only) {
    appViews(next).forEach((key) => delete next[key])
  }

  empireViews(next).filter(({ GameID, RaceID }) => !only || (GameID === String(only.GameID) && RaceID === String(only.RaceID))).forEach(({ GameID, RaceID, keys }) => {
    const races = next.game[GameID].race

    keys.forEach((key) => delete races[RaceID][key])

    if (!Object.keys(races[RaceID]).length) {
      delete races[RaceID]
    }
  })

  return next
}

const values = (number) => (number === 1 ? 'value' : 'values')

export default {
  name: 'SettingsPage',
  components: { PresetCard },
  mixins: [countFormat],
  data() {
    return {
      // The settings file as last read; the counts come from it.
      stored: {},
      spyNPR: false,
      // The reset waiting for its confirmation: { scope, title, text }.
      pending: null,
    }
  },
  computed: {
    ...mapGetters(['config', 'GameID', 'RaceID']),
    ...mapState('empires', ['games']),

    separatorName() {
      return this.config.get('selectedSeparator', 'Tick')
    },

    separatorOptions() {
      return SEPARATORS.map((name) => ({ value: name, text: `${name} · ${separatedNumber(1234567, thousandsSeparator(name))}` }))
    },

    dark() {
      return activeAppearance().mode === 'dark'
    },

    presets() {
      return listAppearances()
    },

    // The preset in force (the previewed one while a preview is open) and the kept one.
    activeId() {
      return activeAppearance().id
    },

    appliedId() {
      return appliedPresetId()
    },

    previewing() {
      return isPreviewing()
    },

    defaultId() {
      return DEFAULT_PRESET_ID
    },

    defaultName() {
      return resolveAppearance(DEFAULT_PRESET_ID).name
    },

    // A saved id this version has no preset for: it stays in the file until a preset is applied.
    unsupportedId() {
      return this.appliedId && unsupportedPresetId(this.config)
    },

    presetNote() {
      const applied = resolveAppearance(this.appliedId).name

      if (this.previewing) {
        return `Previewing ${activeAppearance().name} on every page. Apply keeps it; Cancel returns to ${applied}.`
      }

      if (this.unsupportedId) {
        return `The saved preset "${this.unsupportedId}" isn't available in this version, so ${applied} is shown. Applying a preset replaces it.`
      }

      return `${applied} is applied. Choose a preset to preview it on every page before keeping it.`
    },

    empireName() {
      const game = this.games.find((entry) => entry.GameID === this.GameID)
      const race = game && game.Races.find((entry) => entry.RaceID === this.RaceID)

      return race ? race.RaceTitle : ''
    },

    empires() {
      return empireViews(this.stored)
    },

    empireCount() {
      const own = this.empires.find(({ GameID, RaceID }) => GameID === String(this.GameID) && RaceID === String(this.RaceID))

      return this.RaceID && own ? own.keys.length : 0
    },

    appCount() {
      return appViews(this.stored).length
    },

    totalCount() {
      return this.appCount + this.empires.reduce((total, { keys }) => total + keys.length, 0)
    },

    empireNote() {
      if (!this.RaceID) {
        return 'Pick an empire to reset what its pages remember.'
      }

      return this.empireCount ? `${this.count(this.empireCount)} remembered ${values(this.empireCount)} about its systems, colonies, fleets and searches.` : 'Its pages remember nothing of their own yet.'
    },

    allNote() {
      const empires = this.empires.length

      return `${this.count(this.appCount)} app-wide ${values(this.appCount)}, and ${this.count(this.totalCount - this.appCount)} over ${this.count(empires)} ${empires === 1 ? 'empire' : 'empires'}.`
    },
  },
  watch: {
    config: {
      immediate: true,
      handler(config) {
        this.spyNPR = config.get('spyNPR', false)
        this.stored = config.store
      },
    },
  },
  beforeDestroy() {
    cancelPreview()
  },
  methods: {
    ...mapActions(['reinstantiateConfig']),
    ...mapActions('snackbar', ['activateSnackbar']),

    // Every reader of the settings (number formats, the empire list, the layout) takes the change from a new settings instance.
    save(key, value) {
      this.config.set(key, value)
      this.reinstantiateConfig()
    },

    setSeparator(name) {
      this.save('selectedSeparator', name)
    },

    setDark(value) {
      applyMode(this.config, value ? 'dark' : 'light')
      this.reinstantiateConfig()
    },

    preview(id) {
      previewPreset(id)
    },

    applyDraft() {
      applyPreset(this.config, this.activeId)
      this.reinstantiateConfig()
    },

    cancelDraft() {
      cancelPreview()
    },

    // The bundled default as a draft: Apply keeps it, and nothing but the `appearance` key is ever written.
    resetDraft() {
      previewPreset(DEFAULT_PRESET_ID)
    },

    setSpyNPR(value) {
      this.save('spyNPR', Boolean(value))
    },

    ask(scope) {
      this.pending = scope === 'empire' ? { scope, title: `Reset what ${this.empireName || 'this empire'}'s pages remember?`, text: `${this.count(this.empireCount)} ${values(this.empireCount)} go back to each page's defaults. The app-wide views and the other empires' stay.` } : { scope, title: 'Reset every remembered view?', text: `${this.count(this.totalCount)} ${values(this.totalCount)} go back to each page's defaults, for every empire and app-wide. The Display settings, mutes, pinned systems and clusters stay.` }
    },

    reset() {
      const { scope } = this.pending
      const cleared = scope === 'empire' ? this.empireCount : this.totalCount

      this.config.store = withoutViews(this.config.store, scope === 'empire' ? { GameID: this.GameID, RaceID: this.RaceID } : null)
      this.pending = null
      this.reinstantiateConfig()
      this.activateSnackbar({ text: `${this.count(cleared)} remembered ${values(cleared)} reset`, color: 'success' })
    },
  },
}
</script>

<style lang="scss" scoped>
.setting {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 0;

  & + & {
    border-top: 1px solid var(--ae-border);
  }
}

.setting--block {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.presets {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.presets__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.setting__text {
  flex: 1 1 auto;
  min-width: 0;
}

.setting__control {
  flex: 0 0 220px;
}

.setting__switch {
  flex: none;
  margin-top: 0;
  padding-top: 0;
}
</style>
