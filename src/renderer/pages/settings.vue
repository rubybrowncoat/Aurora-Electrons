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
                <preset-reference v-if="shown.reference" :appearance="shown" />
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

      <v-row>
        <v-col cols="12" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="Moves the colour preset, the number format, the remembered views and the Galaxy Map's pins and clusters to a file and back. Use it to carry one empire's set-up to another, with a preview of every change and an Undo." elevation="1">
            <div class="panel-head">
              <span>Export and import preferences</span>
              <v-chip v-if="backup" small>Undo kept</v-chip>
            </div>
            <div class="panel-body">
              <div class="setting setting--block">
                <div class="setting__text">
                  <div class="body-2">Export</div>
                  <div class="caption text--secondary">{{ exportNote }}</div>
                </div>
                <div class="transfer__choices" role="group" aria-label="Categories to export">
                  <v-checkbox v-for="category in categories" :key="category.id" v-model="exportCategories" :value="category.id" class="transfer__choice" dense hide-details :data-export-category="category.id">
                    <template #label>
                      <span>{{ category.title }}<span class="caption text--secondary d-block">{{ category.note }}</span></span>
                    </template>
                  </v-checkbox>
                </div>
                <div class="presets__actions">
                  <v-btn small depressed color="primary" :disabled="!exportCategories.length || busy" data-transfer-action="export" @click="exportFile">Export file</v-btn>
                </div>
              </div>

              <div class="setting setting--block">
                <div class="setting__text">
                  <div class="body-2">Import</div>
                  <div class="caption text--secondary">{{ importNote }}</div>
                </div>
                <div class="presets__actions">
                  <v-btn small outlined :loading="busy" data-transfer-action="choose" @click="chooseFile">Choose file</v-btn>
                  <input ref="file" type="file" accept=".json,application/json" hidden aria-label="Preferences file to import" data-transfer-file @change="readFile">
                </div>

                <v-alert v-if="parsed && parsed.errors" type="error" text dense class="mb-0" data-transfer-errors>
                  <div class="body-2">{{ parsed.fileName }} is rejected, and nothing is changed.</div>
                  <ul class="transfer__list">
                    <li v-for="error in shownErrors" :key="error.field"><span class="transfer__field">{{ error.field }}</span> {{ error.message }}</li>
                  </ul>
                  <div v-if="hiddenErrors" class="caption">and {{ count(hiddenErrors) }} more</div>
                </v-alert>

                <template v-else-if="plan">
                  <div>
                    <div class="body-2">{{ parsed.fileName }}</div>
                    <div class="caption text--secondary" data-transfer-mapping>From {{ sourceText }} to {{ targetText }}.</div>
                  </div>
                  <v-alert :type="plan.identity.confirm ? 'warning' : 'info'" text dense class="mb-0" data-transfer-identity>{{ plan.identity.text }}</v-alert>
                  <div class="transfer__choices" role="group" aria-label="Categories to import">
                    <v-checkbox v-for="category in bundleCategories" :key="category.id" v-model="importCategories" :value="category.id" class="transfer__choice" dense hide-details :data-import-category="category.id">
                      <template #label>
                        <span>{{ category.title }}<span class="caption text--secondary d-block">{{ count(category.count) }} {{ valuesOf(category.count) }} in the file</span></span>
                      </template>
                    </v-checkbox>
                  </div>
                  <v-alert v-for="problem in plan.problems" :key="problem" type="error" text dense class="mb-0" data-transfer-problem>{{ problem }}</v-alert>
                  <div v-if="plan.changes.length" class="transfer__table" data-transfer-changes>
                    <v-simple-table dense>
                      <thead>
                        <tr>
                          <th>Setting</th>
                          <th>Applies to</th>
                          <th>Now</th>
                          <th>After the import</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="change in plan.changes" :key="change.fullKey">
                          <td><span class="transfer__field">{{ change.key }}</span></td>
                          <td>{{ change.scope === 'race' ? 'This empire' : 'App-wide' }}</td>
                          <td><span class="transfer__field">{{ shorten(change.old) }}</span></td>
                          <td><span class="transfer__field">{{ shorten(change.value) }}</span></td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                  </div>
                  <div v-else-if="!plan.problems.length" class="caption text--secondary" data-transfer-nothing>{{ nothingNote }}</div>
                  <div class="caption text--secondary">{{ unchangedNote }}</div>
                  <div>
                    <div class="caption text--secondary">Not imported:</div>
                    <ul class="transfer__list caption text--secondary" data-transfer-excluded>
                      <li v-for="item in plan.excluded" :key="item.id"><strong>{{ item.title }}.</strong> {{ item.reason }}</li>
                    </ul>
                  </div>
                  <v-checkbox v-if="plan.needsConfirmation" v-model="confirmed" label="Import it into this empire anyway" dense hide-details class="mt-0" data-transfer-confirm />
                  <div class="presets__actions">
                    <v-btn small depressed color="primary" :disabled="!canImport" data-transfer-action="import" @click="runImport">Import {{ count(plan.changes.length) }} {{ valuesOf(plan.changes.length) }}</v-btn>
                    <v-btn small outlined data-transfer-action="cancel-import" @click="cancelImport">Cancel</v-btn>
                  </div>
                </template>
              </div>

              <div v-if="backup" class="setting" data-transfer-undo>
                <div class="setting__text">
                  <div class="body-2">Undo the last import</div>
                  <div class="caption text--secondary">{{ backupNote }}</div>
                </div>
                <v-btn outlined data-transfer-action="undo" @click="undo">Undo</v-btn>
              </div>
            </div>
            <div class="panel-foot caption text--secondary">A file holds only the categories chosen, as the app stores them, and nothing of the save. Values about one empire travel without its game and empire ids and are written to the empire picked here; values the file does not hold stay as they are. The whole file is checked before anything is written: an unknown key, or a value the page would not accept, rejects it and names the field. One undo is kept, in a file of its own beside the settings, and the next import replaces it. Empire History, Warnings mutes and exclusions, what was new at the last visit, local scenarios and save paths are never exported or imported.</div>
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
import Config from 'electron-store'

import PresetCard from '../components/settings/PresetCard.vue'
import PresetReference from '../components/settings/PresetReference.vue'
import countFormat from '../mixins/count-format'
import { APPEARANCE_KEY, DEFAULT_PRESET_ID, activeAppearance, appliedPresetId, applyMode, applyPreset, baselinePresetId, cancelPreview, isPreviewing, listAppearances, previewPreset, resolveAppearance, unsupportedPresetId } from '../utilities/appearance'
import { separatedNumber, thousandsSeparator } from '../utilities/math'
import { declaredViews } from '../mixins/persisted-view'
import { CATEGORIES, MAX_BYTES, buildExport, buildSchema, commitImport, exportName, parseBundle, planImport, sameValue, shorten, undoImport, validBackup } from '../utilities/preferences'

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

// Every page and component module declares its remembered fields as it is loaded, which is on its first visit, so the allowlist of what can be exported and imported is complete only once all of them are. They load together the first time a file is exported or chosen, and the declarations are kept.
// The Settings components are left out: this page imports them already, and they declare nothing.
const declaringModules = import.meta.glob(['../pages/*.vue', '../components/**/*.vue', '!../components/settings/*.vue'])
let declarations = null

const loadDeclarations = () => {
  if (!declarations) {
    declarations = Promise.all(Object.values(declaringModules).map((load) => load())).then(() => declaredViews())
    declarations.catch(() => { declarations = null })
  }

  return declarations
}

const SHOWN_ERRORS = 12

const download = (text, name) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')

  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default {
  name: 'SettingsPage',
  components: { PresetCard, PresetReference },
  mixins: [countFormat],
  data() {
    return {
      // The settings file as last read; the counts come from it.
      stored: {},
      spyNPR: false,
      // The reset waiting for its confirmation: { scope, title, text }.
      pending: null,
      // The preferences panel: the categories to export; the file chosen to import (`errors` when it was rejected, else `bundle` and `entries`) with the categories to import from it and the confirmation of a source that can't be matched to this empire; whether a file is being read; and the undo kept from the last import.
      exportCategories: CATEGORIES.map(({ id }) => id),
      importCategories: [],
      parsed: null,
      confirmed: false,
      busy: false,
      backup: null,
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

    // The preset in force (the previewed one while a preview is open), resolved: the explanation of its reference is shown for it.
    shown() {
      return activeAppearance()
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

    categories() {
      return CATEGORIES
    },

    // The empire picked, as the export and the import's target know it.
    target() {
      const game = this.games.find((entry) => entry.GameID === this.GameID)

      return { gameId: this.GameID, raceId: this.RaceID, gameName: game ? game.GameName : null, raceName: this.empireName || null }
    },

    exportNote() {
      return this.RaceID ? `Saves the selected categories, as stored for ${this.empireName || 'this empire'}, to a JSON file.` : 'No empire is picked, so only the app-wide values are saved to the JSON file.'
    },

    importNote() {
      return this.RaceID ? `Reads a file and shows every change before anything is written. Empire values go to ${this.empireName || 'this empire'}.` : 'Reads a file and shows every change before anything is written. Pick an empire to import its empire values.'
    },

    shownErrors() {
      return this.parsed && this.parsed.errors ? this.parsed.errors.slice(0, SHOWN_ERRORS) : []
    },

    hiddenErrors() {
      return this.parsed && this.parsed.errors ? Math.max(0, this.parsed.errors.length - SHOWN_ERRORS) : 0
    },

    // The categories the chosen file holds, each with its number of values.
    bundleCategories() {
      const entries = this.parsed && this.parsed.entries ? this.parsed.entries : []

      return CATEGORIES.map((category) => ({ ...category, count: entries.filter((entry) => entry.category === category.id).length })).filter(({ count }) => count)
    },

    // The preview of the chosen file over the settings as they stand: what an import would write, and nothing else.
    plan() {
      if (!this.parsed || !this.parsed.entries) {
        return null
      }

      return planImport({ store: this.stored, entries: this.parsed.entries, source: this.parsed.bundle.source, target: this.target, categories: this.importCategories })
    },

    sourceText() {
      const source = this.parsed.bundle.source

      return source && source.gameId !== null && source.gameId !== undefined && source.raceId !== null && source.raceId !== undefined ? `${source.raceName || 'an empire'} (empire ${source.raceId}) of ${source.gameName || 'a campaign'} (game ${source.gameId})` : 'an unknown empire'
    },

    targetText() {
      return this.RaceID ? `${this.empireName || 'this empire'} (empire ${this.RaceID}) of ${this.target.gameName || 'a campaign'} (game ${this.GameID})` : 'no empire picked'
    },

    nothingNote() {
      return this.importCategories.length ? 'Everything selected is already as the file has it.' : 'Select a category to preview its changes.'
    },

    unchangedNote() {
      return this.plan.unchanged ? `${this.count(this.plan.unchanged)} selected ${values(this.plan.unchanged)} already as the file has ${this.plan.unchanged === 1 ? 'it' : 'them'}, and stay untouched.` : 'Every setting not listed stays untouched.'
    },

    canImport() {
      return Boolean(this.plan && this.plan.changes.length && !this.plan.problems.length && (!this.plan.needsConfirmation || this.confirmed))
    },

    backupNote() {
      const { entries, at, target } = this.backup

      return `${this.count(entries.length)} ${values(entries.length)} written to ${target.raceName || 'an empire'} on ${new Date(at).toLocaleString()}. Undo puts back what they replaced, and removes the ones that were not set.`
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
  created() {
    // Beside config.json, not in a `preferences` folder: on a disk that ignores case that name is taken by the Chromium `Preferences` file in the same user-data folder.
    this.backupStore = new Config({ name: 'preference-import-undo' })

    const kept = this.backupStore.get('backup')

    this.backup = validBackup(kept) ? kept : null
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

    valuesOf(number) {
      return values(number)
    },

    shorten,

    // The allowlist of what can be exported and imported, from every declared field; null, with a message, when the modules couldn't be loaded.
    async loadSchema() {
      this.busy = true

      try {
        return buildSchema({ declarations: await loadDeclarations(), appearance: { key: APPEARANCE_KEY, ids: listAppearances().map(({ id }) => id) }, separators: SEPARATORS })
      } catch (error) {
        console.error("Couldn't load the pages' declared preferences", error)
        this.activateSnackbar({ text: "Couldn't load the list of preferences that can be exported", color: 'error' })

        return null
      } finally {
        this.busy = false
      }
    },

    async exportFile() {
      const schema = await this.loadSchema()

      if (!schema) {
        return
      }

      const { bundle, keys, skipped } = buildExport(schema, this.config.store, this.target, this.exportCategories)

      if (!keys.length) {
        this.activateSnackbar({ text: 'Nothing is stored in the selected categories, so there is nothing to export', color: 'warning' })

        return
      }

      download(JSON.stringify(bundle, null, 2), exportName(this.target))
      this.activateSnackbar({ text: `${this.count(keys.length)} ${values(keys.length)} exported${skipped.length ? `; ${this.count(skipped.length)} left out because their pages would not accept them` : ''}`, color: skipped.length ? 'warning' : 'success' })
    },

    chooseFile() {
      this.$refs.file.click()
    },

    // Reads and checks the file, changing nothing.
    async readFile(event) {
      const [file] = event.target.files

      event.target.value = ''

      if (!file) {
        return
      }

      this.cancelImport()

      const text = file.size > MAX_BYTES ? null : await file.text()
      const schema = await this.loadSchema()

      if (!schema) {
        return
      }

      const result = text === null ? { errors: [{ field: 'file', message: `is larger than ${MAX_BYTES / 1024} KiB` }] } : parseBundle(text, schema)

      this.parsed = { fileName: file.name, ...result }
      this.importCategories = ['views', 'mapGroups'].filter((id) => this.bundleCategories.some((category) => category.id === id))
    },

    cancelImport() {
      this.parsed = null
      this.importCategories = []
      this.confirmed = false
    },

    // The settings file is the one thing that changes, in one write, and what it replaced goes to the undo file first. The preview is made again over the settings as they are now, and a difference from the one on screen stops the import.
    runImport() {
      const { plan } = this
      const settings = { target: this.target, source: this.parsed.bundle.source }
      const current = planImport({ store: this.config.store, entries: this.parsed.entries, source: settings.source, target: this.target, categories: this.importCategories })

      if (!this.canImport || !sameValue(current.changes, plan.changes)) {
        this.stored = this.config.store
        this.activateSnackbar({ text: 'The settings changed since the preview, so nothing was imported. The preview is refreshed.', color: 'warning' })

        return
      }

      const { store, backup } = commitImport(this.config.store, current, settings)

      try {
        this.backupStore.set('backup', backup)
        this.config.store = store
      } catch (error) {
        console.error("Couldn't write the imported preferences", error)
        this.backupStore.delete('backup')
        this.activateSnackbar({ text: "Couldn't write the settings, so nothing was imported", color: 'error' })

        return
      }

      this.backup = backup
      this.afterWrite(backup.entries.map(({ key }) => key))
      this.cancelImport()
      this.activateSnackbar({ text: `${this.count(backup.entries.length)} ${values(backup.entries.length)} imported. Undo is kept in Settings.`, color: 'success' })
    },

    undo() {
      let result

      try {
        result = undoImport(this.config.store, this.backup)
        this.config.store = result.store
      } catch (error) {
        console.error("Couldn't undo the import", error)
        this.activateSnackbar({ text: "Couldn't undo the import", color: 'error' })

        return
      }

      const keys = this.backup.entries.map(({ key }) => key)

      this.backupStore.delete('backup')
      this.backup = null
      this.afterWrite(keys)
      this.activateSnackbar({ text: `${this.count(result.restored)} ${values(result.restored)} put back`, color: 'success' })
    },

    // The colour preset in force follows the settings once they changed under it, and every reader takes a new settings instance.
    afterWrite(keys) {
      if (keys.includes(APPEARANCE_KEY)) {
        const id = this.config.get(APPEARANCE_KEY)

        if (listAppearances().some((preset) => preset.id === id)) {
          applyPreset(this.config, id)
        } else if (id === undefined) {
          const legacy = this.config.get('darkMode')

          applyPreset(this.config, typeof legacy === 'boolean' ? baselinePresetId(legacy ? 'dark' : 'light') : DEFAULT_PRESET_ID)
          this.config.delete(APPEARANCE_KEY)
        } else {
          cancelPreview()
        }
      }

      this.reinstantiateConfig()
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

.transfer__choices {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 32px;
}

.transfer__choice {
  margin-top: 0;
  padding-top: 0;
}

.transfer__list {
  margin: 4px 0 0;
  padding-left: 20px;
}

.transfer__field {
  font-family: monospace;
  word-break: break-all;
}

.transfer__table {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--ae-border);
}
</style>
