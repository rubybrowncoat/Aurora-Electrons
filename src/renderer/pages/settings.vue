<template>
  <div>
    <v-container fluid class="settings-page">
      <v-row>
        <v-col cols="12" md="6" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="How every page writes large numbers, and whether the computer-run empires are listed beside the players' ones." elevation="1">
            <div class="panel-head"><span>Number format and Computer-run empires</span></div>
            <div class="panel-body">
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">Thousands separator</div>
                  <div class="caption text--secondary">How every page writes large numbers.</div>
                </div>
                <v-select :value="separatorName" :items="separatorOptions" aria-label="Thousands separator" class="setting__control" dense outlined hide-details @change="setSeparator" />
              </div>
              <div class="setting">
                <div class="setting__text">
                  <div class="body-2">Computer-run empires</div>
                  <div class="caption text--secondary">Lists the NPR empires on the Empires page beside the players' ones, so their data can be opened, and adds the Rivals chart to Empire History.</div>
                </div>
                <v-switch :input-value="spyNPR" aria-label="Computer-run empires" class="setting__switch" inset dense hide-details @change="setSpyNPR" />
              </div>
            </div>
            <div class="panel-foot caption text--secondary">Use it to pick the thousands separator and to open the data of the NPR empires. Both apply at once and are kept in the settings file; About shows where it is.</div>
          </v-card>
        </v-col>

        <v-col cols="12" md="6" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="The options, filters and table layouts that each page has remembered." elevation="1">
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
            <div class="panel-foot caption text--secondary">Use it to clear them and bring every page back to its defaults. Each page remembers its options, filters, searches, views, and each table's sort and rows per page: app-wide, or per empire for what is about the empire's own things (its systems, colonies, fleets, a search over them). A reset brings back each page's defaults the next time it opens. It keeps the Display settings, the number format and Computer-run empires, the Warnings mutes, the Galaxy Map's pinned systems and clusters, what was new at the last visit to the Game Log and Warnings, the Game Log's saved presets, event archive choice and pinned events with the cap on the events kept, and Empire History, which has files of its own.</div>
          </v-card>
        </v-col>
      </v-row>

      <v-row>
        <v-col cols="12" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="How every page looks and reads: theme, section colours, colour preset, typeface and text size." elevation="1">
            <div class="panel-head"><span>Display</span></div>
            <div class="panel-body">
              <div class="setting" data-theme-policy>
                <div class="setting__text">
                  <div class="body-2">Theme</div>
                  <div class="caption text--secondary">{{ themeNote }}</div>
                </div>
                <div class="setting__buttons" role="group" aria-label="Theme">
                  <v-btn v-for="option in policies" :key="option.id" small :depressed="option.id === shownPolicy" :outlined="option.id !== shownPolicy" :color="option.id === shownPolicy ? 'primary' : undefined" :aria-pressed="String(option.id === shownPolicy)" :data-policy="option.id" @click="setPolicy(option.id)">{{ option.label }}</v-btn>
                </div>
              </div>
              <div class="setting" data-accent-modes>
                <div class="setting__text">
                  <div class="body-2">Section accents</div>
                  <div class="caption text--secondary">{{ accentNote }}</div>
                </div>
                <div class="setting__buttons" role="group" aria-label="Section accents">
                  <v-btn v-for="option in accentOptions" :key="option.id" small :depressed="option.id === accents" :outlined="option.id !== accents" :color="option.id === accents ? 'primary' : undefined" :aria-pressed="String(option.id === accents)" :data-accent-mode="option.id" @click="setAccents(option.id)">{{ option.label }}</v-btn>
                </div>
              </div>
              <div class="setting setting--block">
                <div class="setting__text">
                  <div class="body-2">Colour preset</div>
                  <div class="caption text--secondary">{{ presetNote }}</div>
                </div>
                <div class="presets" role="group" aria-label="Colour presets">
                  <preset-card v-for="preset in presets" :key="preset.id" :appearance="preset" :active="preset.id === activeId" :applied="preset.id === appliedId" @select="preview" />
                </div>
                <div class="presets__actions">
                  <v-btn small depressed color="primary" :disabled="applyBlocked" data-preset-action="apply" @click="applyDraft">Apply</v-btn>
                  <v-btn small outlined :disabled="!previewing" data-preset-action="cancel" @click="cancelDraft">Cancel</v-btn>
                  <v-btn small text :disabled="activeId === defaultId" data-preset-action="reset" @click="resetDraft">Reset to {{ defaultName }}</v-btn>
                </div>
                <v-checkbox v-if="needsAcknowledgement" v-model="acknowledged" :label="acknowledgementLabel" dense hide-details class="mt-0" data-appearance-confirm />
                <preset-reference v-if="shown.reference" :appearance="shown" />
              </div>
              <div class="setting setting--block" data-appearance-file>
                <div class="setting__text">
                  <div class="body-2">Appearance file</div>
                  <div class="caption text--secondary">{{ fileNote }}</div>
                </div>
                <div class="presets__actions">
                  <v-btn small outlined data-appearance-action="export" @click="exportAppearance">Export {{ shown.name }}</v-btn>
                  <v-btn small outlined data-appearance-action="choose" @click="chooseAppearance">Choose file</v-btn>
                  <input ref="appearanceFile" type="file" accept=".json,application/json" hidden aria-label="Appearance file to import" data-appearance-input @change="readAppearance">
                  <v-btn v-if="removable" small text color="error" data-appearance-action="remove" @click="removeImported">Remove imported appearance</v-btn>
                </div>

                <v-alert v-if="fileProblem" type="error" text dense class="mb-0" data-appearance-errors>
                  <div class="body-2">{{ fileProblem.fileName }} is rejected, and nothing is changed.</div>
                  <ul class="transfer__list">
                    <li v-for="(error, index) in shownFileErrors" :key="index" data-appearance-error><strong>{{ kindLabel(error.kind) }}.</strong> <span class="transfer__field">{{ error.field }}</span> {{ error.message }}</li>
                  </ul>
                  <div v-if="hiddenFileErrors" class="caption">and {{ count(hiddenFileErrors) }} more</div>
                </v-alert>

                <v-alert v-if="imported.problem" type="warning" text dense class="mb-0" data-appearance-stored-problem>
                  <div class="body-2">The kept appearance file cannot be read, so it is not offered. It stays in the settings as it is until it is removed or another file is applied.</div>
                  <ul class="transfer__list">
                    <li v-for="(error, index) in storedErrors" :key="index"><strong>{{ kindLabel(error.kind) }}.</strong> <span class="transfer__field">{{ error.field }}</span> {{ error.message }}</li>
                  </ul>
                </v-alert>

                <appearance-file v-if="detail" :entry="detail" :kept="detailKept" @use-font="useFont" />
              </div>
              <font-choice class="setting setting--block" :config="config" @changed="reinstantiateConfig" />
            </div>
            <div class="panel-foot caption text--secondary">The theme (Light, Dark or System) applies at once; System follows the operating system, a named preset replaces the theme until a theme is chosen again, and the lamp in the app bar sets the opposite of the mode drawn now, so it ends System or a named preset too. The section accents apply at once and are kept whatever preset is chosen. The preset sample uses example data, and choosing a preset previews its colours throughout the app; Apply keeps it, and Cancel, or leaving Settings, returns to the kept one. A typeface and a text size are chosen from a bounded list, preview the same way and are kept with their own Apply; a typeface that is not installed is shown as such and the bundled one is drawn in its place. An appearance file is the app's own JSON format for the colours of an appearance, not an Aurora game file. A file is read whole and shown as a draft with the roles it left out and the contrast it measures; one that fails changes nothing. Every setting is kept in the settings file, and About shows where it is.</div>
          </v-card>
        </v-col>
      </v-row>

      <v-row>
        <v-col cols="12" class="d-flex flex-column">
          <v-card class="panel flex-grow-1" data-summary="Preferences exported to a file and imported back." elevation="1">
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

              <div v-if="!backup && backupUnavailable" class="setting" data-transfer-undo-unavailable>
                <div class="setting__text">
                  <div class="body-2">Undo the last import</div>
                  <div class="caption text--secondary">{{ backupUnavailable }}</div>
                </div>
              </div>

              <div v-if="backup" class="setting" data-transfer-undo>
                <div class="setting__text">
                  <div class="body-2">Undo the last import</div>
                  <div class="caption text--secondary">{{ backupNote }}</div>
                </div>
                <v-btn outlined data-transfer-action="undo" @click="undo">Undo</v-btn>
              </div>
            </div>
            <div class="panel-foot caption text--secondary">Use it to carry one empire's set-up to another, with a preview of every change and an Undo. A file holds only the categories chosen, as the app stores them, and nothing of the save. Values about one empire travel without its game and empire ids and are written to the empire picked here; values the file does not hold stay as they are. The whole file is checked before anything is written: an unknown key, or a value the page would not accept, rejects it and names the field. One undo is kept, in a file of its own beside the settings, and the next import replaces it. Empire History, Warnings mutes and exclusions, what was new at the last visit, local scenarios and save paths are never exported or imported.</div>
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

import AppearanceFile from '../components/settings/AppearanceFile.vue'
import FontChoice from '../components/settings/FontChoice.vue'
import PresetCard from '../components/settings/PresetCard.vue'
import PresetReference from '../components/settings/PresetReference.vue'
import countFormat from '../mixins/count-format'
import { ACCENTS_KEY, ACCENT_MODES, APPEARANCE_KEY, APPEARANCE_SETTINGS, BASELINE_POLICIES, CUSTOM_ID, DEFAULT_PRESET_ID, DRAFT_ID, NO_OVERRIDE, POLICIES, POLICY_KEY, accentMode, activeAppearance, adoptAppearance, appearanceOverride, appearancePolicy, appliedPresetId, applyAccents, applyPolicy, applyPreset, cancelPreview, exportAppearanceFile, importAppearanceFile, importedAppearances, isPreviewing, listAppearances, previewPreset, removeCustom, resolveAppearance, systemMode, unsupportedPresetId } from '../utilities/appearance'
import { KIND_LABELS, MAX_BYTES as FILE_BYTES, appearanceFileName } from '../utilities/appearance-file'
import { ACKNOWLEDGEMENT_WORDS } from '../utilities/appearance-contrast'
import { FONT_KEY, loadFont, previewFont, readFont } from '../utilities/appearance-font'
import { separatedNumber, thousandsSeparator } from '../utilities/math'
import { declaredViews } from '../mixins/persisted-view'
import { legacyCampaignOf } from '../utilities/campaign'
import { campaignStorage } from '../utilities/history'
import { appViews as appViewsOf, empireViews, withoutViews as withoutViewsOf } from '../utilities/remembered-views'
import { CATEGORIES, MAX_BYTES, adoptBackup, buildExport, buildSchema, commitImport, exportName, parseBundle, planImport, sameValue, shorten, undoImport } from '../utilities/preferences'

const SEPARATORS = ['Tick', 'Comma', 'Dash', 'Space', 'None']

// The settings the Display and the Number format and Computer-run empires panels hold, and the Game Log's saved presets, which are written by hand and not a view. A reset keeps them. `darkMode` is no longer written; a file that still holds it keeps it.
const APP_SETTINGS = [...APPEARANCE_SETTINGS, 'darkMode', 'spyNPR', 'selectedSeparator', 'logPresets']

// The theme policies as the Theme control offers them.
const THEMES = POLICIES.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))

// The accent modes as the Section accents control offers them, with what each does.
const ACCENTS = ACCENT_MODES.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1), note: { on: 'Each section is drawn in its own accent: the icon in the rail, the tab, the breadcrumb and the washes.', restrained: 'Each accent is mixed halfway toward the neutral one, so the sections are told apart gently.', off: 'Every section is drawn in the neutral accent and is told by its label, icon and place.' }[id] }))
const appViews = (store) => appViewsOf(store, APP_SETTINGS)
const withoutViews = (store, only) => withoutViewsOf(store, APP_SETTINGS, only)

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
  components: { AppearanceFile, FontChoice, PresetCard, PresetReference },
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
      // Why a kept undo is not offered, or '' (see `adoptBackup`).
      backupUnavailable: '',
      // The appearance file: what a file that failed said (`fileName`, `errors`, `omitted`), and whether the contrast findings of the draft are accepted.
      fileProblem: null,
      acknowledged: false,
    }
  },
  computed: {
    ...mapGetters(['config', 'GameID', 'RaceID', 'campaignId']),
    ...mapState('empires', ['games']),

    separatorName() {
      return this.config.get('selectedSeparator', 'Tick')
    },

    separatorOptions() {
      return SEPARATORS.map((name) => ({ value: name, text: `${name} · ${separatedNumber(1234567, thousandsSeparator(name))}` }))
    },

    policies() {
      return THEMES
    },

    // The kept theme policy, and the one the control shows as pressed: none while a named appearance replaces the theme.
    policy() {
      return appearancePolicy()
    },

    shownPolicy() {
      return appearanceOverride() ? null : appearancePolicy()
    },

    accentOptions() {
      return ACCENTS
    },

    accents() {
      return accentMode()
    },

    accentNote() {
      return `${ACCENTS.find(({ id }) => id === this.accents).note} The labels, icons and places of the nine sections stay as they are.`
    },

    themeNote() {
      const policy = THEMES.find(({ id }) => id === this.policy).label
      const replacing = appearanceOverride()

      if (replacing) {
        return `${resolveAppearance(replacing).name} replaces the theme. A choice here ends it. The theme kept under it is ${policy}.`
      }

      return this.policy === 'system' ? `System follows the operating system, which is ${systemMode() === 'dark' ? 'dark' : 'light'} now, and changes with it.` : `${policy} stays as it is when the operating system changes.`
    },

    // The imported appearances (the kept one, the draft of a file just read, what kept the stored one from loading), reactive.
    imported() {
      return importedAppearances()
    },

    // The presets, then the kept imported appearance and the draft.
    presets() {
      return [...listAppearances(), ...[this.imported.custom, this.imported.draft].filter(Boolean).map(({ appearance }) => appearance)]
    },

    // The entry of the imported appearance whose details are shown: the one in force when it is one, else the draft, else the kept one.
    detail() {
      const { custom, draft } = this.imported

      return this.activeId === CUSTOM_ID ? custom : this.activeId === DRAFT_ID ? draft : draft || custom
    },

    detailKept() {
      return this.detail !== null && this.detail === this.imported.custom
    },

    // The draft when it is the one in force, which Apply would keep.
    draftInForce() {
      return this.activeId === DRAFT_ID ? this.imported.draft : null
    },

    // Apply waits for a preview, and for a draft that can be read: not one that blocks, and one with contrast findings only once they are accepted.
    applyBlocked() {
      const draft = this.draftInForce

      return !this.previewing || Boolean(draft && (draft.report.blocking.length || (draft.report.findings.length && !this.acknowledged)))
    },

    needsAcknowledgement() {
      const draft = this.draftInForce

      return Boolean(draft && draft.report.findings.length && !draft.report.blocking.length)
    },

    acknowledgementLabel() {
      const findings = this.draftInForce.report.findings.length

      return `${ACKNOWLEDGEMENT_WORDS.before} ${this.count(findings)} ${findings === 1 ? ACKNOWLEDGEMENT_WORDS.one : ACKNOWLEDGEMENT_WORDS.many}`
    },

    removable() {
      return Boolean(this.imported.custom || this.imported.problem)
    },

    shownFileErrors() {
      return this.fileProblem ? this.fileProblem.errors.slice(0, SHOWN_ERRORS) : []
    },

    hiddenFileErrors() {
      return this.fileProblem ? this.fileProblem.errors.length - this.shownFileErrors.length + (this.fileProblem.omitted || 0) : 0
    },

    storedErrors() {
      return this.imported.problem ? this.imported.problem.errors.slice(0, SHOWN_ERRORS) : []
    },

    fileNote() {
      return 'Saves the appearance shown, or reads one back, in the app\'s own JSON format for Electrons appearances. It is not an Aurora game file and no game reads it. A file is checked whole and shown as a draft: nothing is kept until Apply, and a file that fails changes nothing.'
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
        return this.unsupportedId === CUSTOM_ID ? `The kept appearance file cannot be read (see below), so ${applied} is shown. Applying a preset replaces the saved choice.` : `The saved preset "${this.unsupportedId}" isn't available in this version, so ${applied} is shown. Applying a preset replaces it.`
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
      const own = this.campaignId ? this.empires.find(({ campaignId, RaceID }) => campaignId === this.campaignId && RaceID === String(this.RaceID)) : null

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

      return { gameId: this.GameID, raceId: this.RaceID, campaignId: this.campaignId, gameName: game ? game.GameName : null, raceName: this.empireName || null }
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
    // A game from before campaigns settles to a campaign after the page opened: an undo kept for it is offered then.
    campaignId() {
      this.loadBackup()
    },
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
    // The number of the latest appearance file read; a read whose number is no longer the latest, or that finishes after the page is gone, is dropped.
    this.appearanceRead = 0

    this.loadBackup()
  },
  beforeDestroy() {
    this.appearanceRead++
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

    // A theme at once, ending the named appearance that replaced the previous one.
    setPolicy(policy) {
      try {
        applyPolicy(this.config, policy)
      } catch (error) {
        console.error("Couldn't write the theme", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so the theme was not applied", color: 'error' })

        return
      }

      this.acknowledged = false
      this.reinstantiateConfig()
    },

    // The accent mode at once.
    setAccents(mode) {
      try {
        applyAccents(this.config, mode)
      } catch (error) {
        console.error("Couldn't write the section accents", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so the section accents were not changed", color: 'error' })

        return
      }

      this.reinstantiateConfig()
    },

    preview(id) {
      previewPreset(id)
    },

    applyDraft() {
      try {
        applyPreset(this.config, this.activeId)
      } catch (error) {
        console.error("Couldn't write the colour preset", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so the appearance was not applied", color: 'error' })

        return
      }

      this.acknowledged = false
      this.reinstantiateConfig()
    },

    cancelDraft() {
      cancelPreview()
    },

    // The typeface an appearance file names, previewed through the same choice as the typeface list; Apply there keeps it.
    useFont(id) {
      previewFont({ family: id })
    },

    // The label of a kind of failure of an appearance file.
    kindLabel(kind) {
      return KIND_LABELS[kind]
    },

    // The appearance in force, preset or imported, as a file.
    exportAppearance() {
      const file = exportAppearanceFile(this.activeId)

      download(JSON.stringify(file, null, 2), appearanceFileName(file.name))
      this.activateSnackbar({ text: `${file.name} exported as an appearance file`, color: 'success' })
    },

    chooseAppearance() {
      this.$refs.appearanceFile.click()
    },

    // Reads and checks a file: a valid one becomes the draft and is previewed, and one that fails changes nothing, the draft and the kept file included. Only the latest read counts: a read that is superseded by a newer one, or that finishes after the page was left, publishes nothing and starts no preview.
    async readAppearance(event) {
      const [file] = event.target.files

      event.target.value = ''

      if (!file) {
        return
      }

      const read = ++this.appearanceRead
      let text = null
      let unreadable = false

      if (file.size <= FILE_BYTES) {
        try {
          text = await file.text()
        } catch (error) {
          unreadable = true
        }
      }

      if (read !== this.appearanceRead) {
        return
      }

      let result

      if (file.size > FILE_BYTES) {
        result = { ok: false, errors: [{ kind: 'field', field: 'file', message: `is ${file.size} bytes; the limit is ${FILE_BYTES}` }], omitted: 0 }
      } else if (unreadable) {
        result = { ok: false, errors: [{ kind: 'field', field: 'file', message: 'could not be read' }], omitted: 0 }
      } else {
        result = importAppearanceFile(text)
      }

      if (result.ok) {
        this.fileProblem = null
        this.acknowledged = false
        this.activateSnackbar({ text: `${result.entry.appearance.name} is previewed from ${file.name}. Apply keeps it.`, color: 'info' })
      } else {
        this.fileProblem = { fileName: file.name, errors: result.errors, omitted: result.omitted }
      }
    },

    removeImported() {
      try {
        removeCustom(this.config)
      } catch (error) {
        console.error("Couldn't remove the imported appearance", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so the imported appearance was not removed", color: 'error' })

        return
      }

      this.reinstantiateConfig()
      this.activateSnackbar({ text: 'The imported appearance is removed', color: 'success' })
    },

    // The bundled default as a draft: Apply keeps it, and nothing but the `appearance` key is ever written.
    resetDraft() {
      previewPreset(DEFAULT_PRESET_ID)
    },

    setSpyNPR(value) {
      this.save('spyNPR', Boolean(value))
    },

    ask(scope) {
      this.pending = scope === 'empire' ? { scope, title: `Reset what ${this.empireName || 'this empire'}'s pages remember?`, text: `${this.count(this.empireCount)} ${values(this.empireCount)} go back to each page's defaults. The app-wide views and the other empires' stay.` } : { scope, title: 'Reset every remembered view?', text: `${this.count(this.totalCount)} ${values(this.totalCount)} go back to each page's defaults, for every empire and app-wide. The Display settings, the number format and Computer-run empires, mutes, pinned systems and clusters stay.` }
    },

    reset() {
      const { scope } = this.pending
      const cleared = scope === 'empire' ? this.empireCount : this.totalCount

      // Over the settings as they are when written: a page of another window may have written one since this page read them.
      this.config.update((store) => withoutViews(store, scope === 'empire' ? { campaignId: this.campaignId, RaceID: this.RaceID } : null))
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
        return buildSchema({ declarations: await loadDeclarations(), appearance: { key: APPEARANCE_KEY, ids: [...listAppearances().map(({ id }) => id), NO_OVERRIDE], none: NO_OVERRIDE, baselines: BASELINE_POLICIES }, policy: { key: POLICY_KEY, values: POLICIES }, accents: { key: ACCENTS_KEY, values: ACCENT_MODES }, font: { key: FONT_KEY, read: readFont }, separators: SEPARATORS })
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

    // The undo kept in its file, as `adoptBackup` offers it: an import made before campaigns were recorded is moved to the campaign that holds that game's settings now, or not offered, with the reason.
    loadBackup() {
      const { backup, reason } = adoptBackup(this.backupStore.get('backup'), (GameID) => {
        try {
          return legacyCampaignOf(campaignStorage(this.config), Number(GameID))
        } catch (error) {
          return null
        }
      })

      this.backup = backup
      this.backupUnavailable = reason || ''
    },

    // The settings file changes in one write, and the undo of that write goes to the undo file in the same step (the store host writes both or neither, and the undo of a change that was kept, never one of an attempt that lost to another window). The preview is made again over the settings as they are when the write is made (another window may have written since), and a difference from the one on screen stops the import.
    runImport() {
      const { plan } = this
      const settings = { target: this.target, source: this.parsed.bundle.source }
      let committed = null

      try {
        this.config.update((store) => {
          const current = planImport({ store, entries: this.parsed.entries, source: settings.source, target: this.target, categories: this.importCategories })

          if (!this.canImport || !sameValue(current.changes, plan.changes)) {
            throw Object.assign(new Error('The settings changed since the preview'), { changed: true })
          }

          committed = commitImport(store, current, settings)

          return committed.store
        }, () => ({ store: this.backupStore, key: 'backup', value: committed.backup }))
      } catch (error) {
        if (error.changed) {
          this.stored = this.config.store
          this.activateSnackbar({ text: 'The settings changed since the preview, so nothing was imported. The preview is refreshed.', color: 'warning' })

          return
        }

        console.error("Couldn't write the imported preferences", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so nothing was imported", color: 'error' })

        return
      }

      const { backup } = committed

      this.backup = backup
      this.afterWrite(backup.entries.map(({ key }) => key))
      this.cancelImport()
      this.activateSnackbar({ text: `${this.count(backup.entries.length)} ${values(backup.entries.length)} imported. Undo is kept in Settings.`, color: 'success' })
    },

    undo() {
      let result

      try {
        this.config.update((store) => {
          result = undoImport(store, this.backup)

          return result.store
        })
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

    // The theme, the section accents, the colour preset and the typeface in force follow the settings once they changed under them, and every reader takes a new settings instance.
    afterWrite(keys) {
      if (keys.includes(FONT_KEY)) {
        loadFont(this.config)
      }

      if (keys.includes(APPEARANCE_KEY) || keys.includes(POLICY_KEY) || keys.includes(ACCENTS_KEY)) {
        adoptAppearance(this.config)
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

.setting__buttons {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
}

// The categories to export and to import, one per line, each with its note under its title.
.transfer__choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
