<template>
  <div>
    <v-container fluid class="missile-designer-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <v-alert v-if="designs.fixture && !savedItems.length" type="info" outlined dense class="mt-1" data-designer="no-designs">The race has no researched and owned missile design in this save, so there is no baseline to pin. Designs can still be made here from the tech the race holds.</v-alert>
        <v-alert v-if="designs.excluded > 0" type="info" outlined dense class="mt-1" data-designer="excluded">{{ designs.excluded }} {{ designs.excluded === 1 ? 'design is' : 'designs are' }} owned by the race but not researched by it, and {{ designs.excluded === 1 ? 'is' : 'are' }} not imported.</v-alert>
        <v-alert v-if="hypotheticalNotice" type="warning" outlined dense class="mt-1" data-tech="hypothetical">{{ hypotheticalNotice }}</v-alert>
        <v-alert v-for="item in unresolvedChoices" :key="item.type" type="warning" outlined dense class="mt-1" data-tech="unresolved">{{ item.text }}</v-alert>
        <v-alert v-if="scenarioNotice" type="info" outlined dense class="mt-1" data-tech="scenario-notice">{{ scenarioNotice }}</v-alert>

        <v-card class="panel" data-summary="The saved missile pinned as the baseline and the scenario every column is judged under: the target's speed and missile jammer, the launcher's tactical modifier, the point-defence figure and the target's signature. A baseline keeps the figures the save stored; a design made here starts from a copy of it or from nothing." elevation="1">
          <div class="panel-head">
            <span>Baseline and scenario</span>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="tool tool--baseline">
                <div class="tool__label caption text--secondary">Baseline, a saved missile</div>
                <v-autocomplete :value="baselineId" :items="savedItems" item-text="text" item-value="value" placeholder="None" prepend-inner-icon="mdi-rocket-launch-outline" aria-label="Saved missile pinned as the baseline" clearable dense outlined hide-details data-field="baseline" @change="setBaseline" />
              </div>
              <div class="tool tool--actions">
                <div class="tool__buttons">
                  <v-btn outlined :disabled="!canSeed || alternatives.length >= maxAlternatives" aria-label="Add a design seeded from the baseline" data-action="seed" @click="seedFromBaseline"><v-icon small left>mdi-content-copy</v-icon>Seed from baseline</v-btn>
                  <v-menu offset-y :close-on-content-click="true" max-height="360">
                    <template #activator="{ on, attrs }">
                      <v-btn outlined :disabled="!savedItems.length || alternatives.length >= maxAlternatives" aria-label="Add a saved missile as an alternative" data-action="add-saved" v-bind="attrs" v-on="on"><v-icon small left>mdi-plus</v-icon>Saved missile</v-btn>
                    </template>
                    <v-list dense>
                      <v-list-item v-for="item in savedItems" :key="item.value" @click="addSaved(item.value)"><v-list-item-title>{{ item.text }}</v-list-item-title></v-list-item>
                    </v-list>
                  </v-menu>
                  <v-btn outlined :disabled="alternatives.length >= maxAlternatives" aria-label="Add a blank design" data-action="add-blank" @click="addBlank"><v-icon small left>mdi-plus</v-icon>Blank design</v-btn>
                </div>
              </div>
            </div>
            <div v-if="alternativeMessage" class="caption warning--text mt-2" data-designer="alternative-message">{{ alternativeMessage }}</div>
            <div class="toolbar mt-3">
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target speed</div>
                <v-text-field v-model="hitTargetSpeed" suffix="km/s" aria-label="Target speed in km/s" :error-messages="scenarioErrors.targetSpeed" dense outlined hide-details="auto" data-field="targetSpeed" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target missile jammer</div>
                <v-text-field v-model="hitJammer" aria-label="Strength of the target's missile jammer" :error-messages="scenarioErrors.jammer" dense outlined hide-details="auto" data-field="jammer" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Tactical modifier</div>
                <v-text-field v-model="hitModifier" aria-label="Tactical modifier of the launching ship" :error-messages="scenarioErrors.modifier" dense outlined hide-details="auto" data-field="modifier" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Point-defence figure (planner)</div>
                <v-text-field v-model="pd" suffix="km/s" aria-label="Point-defence figure of the planner figure, in km/s" :error-messages="pdError" dense outlined hide-details="auto" data-field="pd" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target signature</div>
                <v-text-field v-model="targetSignature" suffix="HS" aria-label="Signature of the target in HS, for the reach of the missile's own sensor" :error-messages="scenarioErrors.targetSignature" dense outlined hide-details="auto" data-field="targetSignature" />
              </div>
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            The target speed, jammer and modifier are those of the Designed Tech page's missile hit chance panel and move together. The point-defence figure feeds the planner figure only, warhead × hit chance × (1 − PD / speed), a planner figure and not a game statistic: it is a point-defence attenuation in km/s with no verified model of interception, and it must be 0 or more and not above the missile speed. The target signature sets the reach of a missile's own active sensor against it and is left blank when not wanted.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The tech levels designs are made with: each line starts at the level the race holds and can be set to another level it has researched or to a next level it has not, which marks every result built on it as hypothetical. Ship thrust limits are not among them." elevation="1">
          <div class="panel-head">
            <span>Tech levels<v-chip v-if="techChoiceCount" x-small outlined class="ml-2">{{ techChoiceCount }} changed</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="scenarioNotice" class="caption warning--text mb-2" data-tech="notice">{{ scenarioNotice }}</div>
            <v-row dense>
              <v-col v-for="line in techLines" :key="line.type" cols="12" sm="6" md="4" xl="3" :data-tech-line="line.type">
                <v-select :value="line.selected" :items="line.items" item-text="text" item-value="value" :label="line.label" :disabled="!line.items.length" dense outlined hide-details @change="(id) => setTech(line.type, id)" />
                <v-select v-if="line.candidates.length" :value="line.candidate" :items="line.candidates" item-text="text" item-value="value" :label="`${line.label}: next tech (hypothetical)`" clearable dense outlined hide-details class="mt-1" @change="(id) => chooseNextTech(line.type, id)" />
                <div v-if="line.hypothetical" class="caption warning--text pt-1 pl-3" data-tech="hypothetical-line">Hypothetical: the results use a level the race has not researched.</div>
                <div v-if="line.unresolved" class="caption warning--text pt-1 pl-3" data-tech="unresolved-line">{{ line.unresolvedText }}<v-btn x-small text class="ml-1" @click="forgetChoice(line.type)">Forget the choice</v-btn></div>
                <div v-if="line.next" class="d-flex align-center caption text--disabled pt-1 pl-3">Next: {{ line.nextText }}<page-link :to="linkTo.techTree({ tech: line.next.id })" :name="line.next.name" class="ml-1" /></div>
                <div v-else-if="!line.items.length" class="caption text--disabled pt-1 pl-3">Not researched</div>
              </v-col>
            </v-row>
          </div>
          <div class="panel-foot caption text--secondary">
            A missile engine is designed at the thrust modifier of the missile itself. Above the race's greatest thrust modifier its fuel use is boosted by the missile rule; a ship's least thrust modifier and largest engine size are never read here. Typed tech figures on an alternative replace these lines for that alternative.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The baseline and up to three alternatives side by side: saved missiles, designs made from the tech the race holds, from a hypothetical next level or from typed figures. Every column carries the same inputs, figures and gated options, each figure with its provenance mark, sizes in MSP, HS and tons, and for a saved missile what the save stored beside what the rules rebuild." data-designer="comparison" elevation="1">
          <div class="panel-head">
            <span>Comparison<v-chip v-if="comparison.columns.length" x-small outlined class="ml-2">{{ comparison.columns.length }} {{ comparison.columns.length === 1 ? 'column' : 'columns' }}</v-chip></span>
            <span class="d-flex align-center flex-wrap">
              <v-btn small text :disabled="!comparison.columns.length" aria-label="Copy the comparison as text" data-action="copy" @click="copySummary"><v-icon small left>mdi-content-copy</v-icon>Copy summary</v-btn>
            </span>
          </div>
          <div v-if="copyMessage" class="panel-body pt-0 pb-0 caption text--secondary" data-designer="copy-message">{{ copyMessage }}</div>
          <div v-if="!comparison.columns.length" class="panel-body text--secondary" data-designer="empty">Pin a saved missile as the baseline, or add an alternative, to compare.</div>
          <missile-compare-table v-else :comparison="comparison" @remove="removeAlternative" />
          <div class="panel-foot caption text--secondary">
            Size is the full MSP sum of every part, raised to the floor of 1 MSP and cut to the size limit; 20 MSP are 1 HS and 50 tons are 1 HS. Fuel is 2,500 litres to the MSP, cut to a whole litre; speed and endurance are cut to 0.1. A saved missile's recomputed figures are rebuilt from the levels the race holds that reproduce what it stored, so agreement shows that some held level gives the figure; a figure the save lacks is unknown, never 0, and unknown or unsupported is never agreement. The planner figure is the planner's own heuristic and no game statistic. It is per warhead: the strength and the hit chance are those of one warhead and neither is multiplied by the number of warheads. A saved missile's hit chance and planner figure use its recomputed speed and warhead.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The designs made here, one editor each: the counts and sizes of the parts as typed, the options switched on and the tech they are designed with. Text that is not a figure stays on its field with its error and no number replaces it." data-designer="alternatives" elevation="1">
          <div class="panel-head">
            <span>Alternatives<v-chip x-small outlined class="ml-2">{{ alternatives.length }} of {{ maxAlternatives }}</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="!designedAlternatives.length" class="text--secondary" data-designer="no-drafts">No design is made here yet. Seed one from the baseline or start from a blank design.</div>
            <div v-for="entry in designedAlternatives" :key="entry.key" class="missile-designer-page__draft">
              <missile-draft-editor :draft="entry" :errors="draftErrors[entry.key] || {}" :blocked="draftBlocked[entry.key] || []" @input="(draft) => updateAlternative(entry.key, draft)" @remove="removeAlternative" />
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            An option that needs a tech line with no level is not applied: it is marked with its reason beside the option and on the column, and no figure of that column is shown, because any figure would be that of a missile without the option. A second stage, a ship decoy, a ground pod and an enhanced radiation warhead are carried from a seeded design and not built.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Comparisons kept in the scenario records of the race on this branch: the baseline, the alternatives as typed, the scenario and the tech levels chosen, never a figure of the save. A comparison made at a later game time is listed and not applied until moved to this save." data-designer="records" elevation="1">
          <div class="panel-head">
            <span>Saved comparisons<v-chip v-if="recordsRead.entries.length" x-small outlined class="ml-2">{{ recordsRead.entries.length }}</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="recordNotice" class="caption warning--text mb-2" data-designer="record-notice">{{ recordNotice }}</div>
            <div class="toolbar">
              <div class="tool tool--name">
                <div class="tool__label caption text--secondary">Name of this comparison</div>
                <v-text-field v-model="recordName" aria-label="Name of the comparison to keep" :error-messages="recordNameError" dense outlined hide-details="auto" data-field="record-name" @blur="recordTouched = true" />
              </div>
              <div class="tool tool--actions">
                <div class="tool__buttons">
                  <v-btn outlined :disabled="!canSaveRecord" aria-label="Save the comparison" data-action="record-save" @click="saveRecord(false)"><v-icon small left>mdi-content-save-outline</v-icon>{{ recordOrigin ? 'Save' : 'Save new' }}</v-btn>
                  <v-btn v-if="recordOrigin" outlined :disabled="!canSaveRecord" aria-label="Save as a new comparison" data-action="record-save-new" @click="saveRecordAsNew"><v-icon small left>mdi-content-save-plus-outline</v-icon>Save as new</v-btn>
                  <v-btn v-if="recordOrigin" outlined aria-label="Start a new comparison" data-action="record-new" @click="newRecord"><v-icon small left>mdi-file-outline</v-icon>New</v-btn>
                </div>
              </div>
            </div>
            <v-alert v-if="recordConflict" type="warning" outlined dense class="mt-2" data-designer="record-conflict">The comparison {{ recordConflict.name }} was changed elsewhere since it was opened. <v-btn x-small text class="ml-1" data-action="record-overwrite" @click="saveRecord(true)">Write over it</v-btn></v-alert>
            <div v-if="!recordsRead.entries.length" class="caption text--secondary mt-3" data-designer="no-records">No comparison is kept for this race on this branch.</div>
            <v-list v-else dense class="mt-2">
              <v-list-item v-for="entry in recordsRead.entries" :key="entry.uuid" :class="{ 'is-selected-row': entry.uuid === recordOrigin }" :data-record="entry.uuid">
                <v-list-item-content>
                  <v-list-item-title>{{ entry.name }}<v-chip v-if="entry.ahead" x-small color="warning" outlined class="ml-2" data-record="ahead">Saved at a later game time</v-chip><v-chip v-if="missingLinks(entry).length" x-small color="warning" outlined class="ml-2" data-record="links">{{ missingLinks(entry).length }} saved {{ missingLinks(entry).length === 1 ? 'design' : 'designs' }} changed or gone</v-chip></v-list-item-title>
                  <v-list-item-subtitle>{{ recordSummary(entry) }}</v-list-item-subtitle>
                </v-list-item-content>
                <v-list-item-action class="flex-row">
                  <v-btn v-if="entry.ahead" small text aria-label="Move the comparison to this save" data-action="record-move" @click="moveRecord(entry.uuid)">Move to this save</v-btn>
                  <v-btn v-else small text aria-label="Open the comparison" data-action="record-open" @click="openRecord(entry.uuid)">Open</v-btn>
                  <v-btn small text color="error" aria-label="Delete the comparison" data-action="record-delete" @click="deleteRecord(entry.uuid)">Delete</v-btn>
                </v-list-item-action>
              </v-list-item>
            </v-list>
          </div>
          <div class="panel-foot caption text--secondary">
            A comparison keeps its inputs as text and the tech levels chosen on this page, by tech ID and name (never a figure), and works every figure out again from the save when it is opened. A level that is no longer a level the race has, or whose tech changed, reads as unresolved and named, and the line designs with the game's pick. It is kept on this branch of the campaign; a saved missile it names that changed or is gone is flagged and never re-pointed. Nothing is written into the Aurora save.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import MissileCompareTable from '../components/missiles/MissileCompareTable.vue'
import MissileDraftEditor from '../components/missiles/MissileDraftEditor.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import countFormat from '../mixins/count-format'
import loadState from '../mixins/load-state'
import persistedView from '../mixins/persisted-view'
import { loadFormulaVersion } from '../utilities/capabilities'
import { linkTo } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { DESIGN_LINES, DESIGN_LINE_TYPES, LINE_LABELS, MAX_ALTERNATIVES, NO_DESIGNS, addAlternative, carryOf, compareDesigns, deleteDesign, designerContext, emptyDraft, loadDesigns, moveDesign, payloadOf, pdProblem, problemsOf, readDesigns, registerDesigner, removeAlternative, saveDesign, savedAlternative, savedChoices, scenarioOf, seedAlternative, summaryText, techChoicesOf, techLinksOf } from '../utilities/missile-designer'
import { entered } from '../utilities/missile-hit'
import { NO_TECH_CHOICES, candidateText, loadTechChoices, readScenario, registerTechScenarios, resolveChoices, saveChoice, scopeOf, selectionOf } from '../utilities/tech-scenarios'

const INPUT_LABELS = {
  tech: 'the race\'s tech lines, researched levels and research graph',
  designs: 'the missile designs the race has researched and owns',
  formulaVersion: 'the save\'s schema',
}

// The tech lines the page lists, with the label of each.
const TECH_LINES = Object.entries(DESIGN_LINES).map(([name, type]) => ({ type, label: LINE_LABELS[name] }))

const text = (value) => typeof value === 'string'

// The alternatives as the page keeps them: every entry the record adapter accepts, at most three.
const validAlternatives = (value) => Array.isArray(value) && problemsOf({ name: 'x', baselineId: null, alternatives: value, scenario: scenarioOf({}), tech: { choices: {} } }).length === 0

// A page for the missile designer: the researched missiles of the race and the missiles it could design, side by side under one scenario (utilities/missile-designer.js).
export default {
  name: 'MissileDesignerPage',
  components: { LoadState, MissileCompareTable, MissileDraftEditor, PageLink },
  mixins: [
    countFormat,
    loadState(INPUT_LABELS),
    persistedView({
      baselineId: { key: 'missileDesignerBaseline', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      alternatives: { key: 'missileDesignerAlternatives', default: [], scope: 'race', valid: validAlternatives },
      techChoice: { key: 'missileDesignerTech', default: {}, scope: 'race', valid: (value) => value && typeof value === 'object' && !Array.isArray(value) },
      hitTargetSpeed: { key: 'missileHitTargetSpeed', default: '10000', valid: text },
      hitJammer: { key: 'missileHitJammer', default: '0', valid: text },
      hitModifier: { key: 'missileHitModifier', default: '1', valid: text },
      pd: { key: 'missileDesignerPd', default: '0', valid: text },
      targetSignature: { key: 'missileDesignerTargetSignature', default: '', valid: text },
    }),
  ],
  data() {
    return {
      maxAlternatives: MAX_ALTERNATIVES,
      linkTo,
      // The hypothetical choices that could not be written to the scenario record, by tech type: they hold for this page only.
      heldChoices: {},
      scenarioMessage: '',
      scenarioRevision: 0,
      alternativeMessage: '',
      copyMessage: '',
      // The comparison kept in the records that is open: its uuid, the revision and payload it was opened at, the name being typed, and why the last write failed.
      recordOrigin: null,
      recordBaseline: null,
      recordName: '',
      recordTouched: false,
      recordMessage: '',
      recordConflict: null,
      recordRevision: 0,
      // The links of the comparison as they were read or last written (`carryOf`), kept through a save so that a saved design or a tech that changed, or that was kept with no link, is not accepted by a save; a choice made on the page leaves it.
      linkCarry: [],
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'GameTime']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    // The campaign and branch of the open save once settled, and the scope of its scenario records: null until both are known.
    scope() {
      return scopeOf({ campaign: this.$store.getters['history/campaign'], RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // The tech scenario record of the race on the branch as the open save reads it (see readScenario).
    techScenario() {
      return { ...readScenario(this.records ? this.records.repository : null, this.scope, this.tech), revision: this.scenarioRevision }
    },

    // The hypothetical choices as the lines resolve them: the record's, then the ones that could only be kept for this page.
    scenarioSelection() {
      const selection = { ...this.techScenario.selection }

      Object.entries(this.heldChoices).forEach(([type, choice]) => {
        if (choice) {
          selection[type] = { source: 'scenario', ...choice }
        } else {
          delete selection[type]
        }
      })

      return selection
    },

    // The choices of the lines as the page holds them: the researched levels it remembers and the hypothetical ones.
    techSelection() {
      return selectionOf(this.techChoice, this.scenarioSelection)
    },

    // Each tech line's choice resolved against the open save.
    techResolution() {
      return resolveChoices(this.tech, this.techSelection)
    },

    techChoiceCount() {
      return TECH_LINES.filter(({ type }) => this.techResolution[type] && this.techResolution[type].level && this.techResolution[type].level !== this.tech.lines[type].pick).length
    },

    techLines() {
      return TECH_LINES.map(({ type, label }) => {
        const line = this.tech.lines[type]
        const resolved = this.techResolution[type]
        const format = (value) => this.count(value)
        const unresolved = resolved.unresolved

        return {
          type,
          label,
          selected: resolved.hypothetical || !resolved.level ? null : resolved.level.id,
          candidate: resolved.hypothetical ? resolved.level.id : null,
          hypothetical: resolved.hypothetical,
          next: line.next,
          nextText: line.next ? `${line.next.name} · ${candidateText(line.next, format)}` : '',
          unresolved,
          unresolvedText: unresolved ? `${label}: ${unresolved.name} is not used. ${unresolved.reason} The line uses ${line.pick ? `the game's pick, ${line.pick.name}` : 'no level, as none is researched'}.` : '',
          items: line.levels.map((level) => ({ value: level.id, text: `${level.info} · ${level.name}${level === line.pick ? ' · the game\'s pick' : ''}` })),
          candidates: line.candidates.map((item) => ({ value: item.id, text: `${item.info} · ${item.name} · ${candidateText(item, format)}` })),
        }
      })
    },

    unresolvedChoices() {
      return this.techLines.filter((line) => line.unresolved).map((line) => ({ type: line.type, text: line.unresolvedText }))
    },

    // Why a record's choices are not all applied or kept: a write that failed, a file that cannot be read or made at another game time or by another version.
    scenarioNotice() {
      const parts = [this.scenarioMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so the choice is kept for this page only.` : '', this.techScenario.error ? `The scenario records cannot be read (${this.techScenario.error.message}), so saved choices are not applied.` : '', ...this.techScenario.notes.map((note) => note.reason)]

      return parts.filter(Boolean).join(' ')
    },

    savedItems() {
      return savedChoices(this.designs).map((choice) => ({ text: `${choice.name}${choice.obsolete ? ' (obsolete)' : ''} · ${this.count(choice.size, 2)} MSP`, value: choice.id }))
    },

    canSeed() {
      return this.baselineId !== null && Boolean(this.designs.fixture)
    },

    // The scenario as the designer takes it: the texts as typed.
    scenarioInput() {
      return { targetSpeed: this.hitTargetSpeed, jammer: this.hitJammer, modifier: this.hitModifier, pd: this.pd, targetSignature: this.targetSignature }
    },

    scenarioErrors() {
      const check = (value, label) => (entered(value) === null || entered(value) < 0 ? `${label}: enter a number of 0 or more` : '')

      return { targetSpeed: check(this.hitTargetSpeed, 'Target speed'), jammer: check(this.hitJammer, 'Jammer'), modifier: check(this.hitModifier, 'Modifier'), targetSignature: String(this.targetSignature).trim() === '' ? '' : check(this.targetSignature, 'Target signature') }
    },

    pdError() {
      return pdProblem(this.pd)
    },

    designerContext() {
      return designerContext({ fixture: this.designs.fixture, resolution: this.techResolution, version: this.formulaVersion, obsolete: this.designs.obsolete })
    },

    comparison() {
      return compareDesigns(this.designerContext, { baselineId: this.baselineId, alternatives: this.alternatives, scenario: this.scenarioInput })
    },

    summary() {
      return summaryText(this.comparison, this.scenarioInput)
    },

    designedAlternatives() {
      return this.alternatives.filter((entry) => entry.kind === 'designed')
    },

    // The field errors of each designed alternative, by key.
    draftErrors() {
      return Object.fromEntries(this.comparison.columns.filter((column) => column.kind === 'designed').map((column) => [column.key, column.errors]))
    },

    // The options asked for and not applied of each designed alternative, by key.
    draftBlocked() {
      return Object.fromEntries(this.comparison.columns.filter((column) => column.kind === 'designed').map((column) => [column.key, column.blocked]))
    },

    // The hypothetical tech the designed columns rest on, once each.
    hypotheticalNotice() {
      const assumptions = [...new Set(this.comparison.columns.flatMap((column) => column.hypothetical))]

      return assumptions.length ? `Hypothetical results: ${assumptions.join('; ')}. Each figure built on it is marked assumed.` : ''
    },

    recordsRead() {
      return { ...readDesigns(this.records ? this.records.repository : null, this.scope, this.designs, this.tech), revision: this.recordRevision }
    },

    recordPayload() {
      return payloadOf({ name: this.recordName, baselineId: this.baselineId, alternatives: this.alternatives, scenario: this.scenarioInput, tech: techChoicesOf(this.techSelection, this.tech) })
    },

    recordProblems() {
      return problemsOf(this.recordPayload)
    },

    recordNameError() {
      return this.recordTouched && !this.recordName.trim() ? 'Name the comparison to keep it' : ''
    },

    canSaveRecord() {
      return this.recordProblems.length === 0 && Boolean(this.records && this.records.repository) && Boolean(this.scope)
    },

    // The open comparison at the revision it was opened or last written at, so that a change made elsewhere since is refused as stale.
    recordEntry() {
      return this.recordOrigin ? this.recordBaseline : null
    },

    recordNotice() {
      const parts = [this.recordMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so a comparison cannot be kept.` : '', this.recordsRead.error ? `The comparisons cannot be read (${this.recordsRead.error.message}).` : '', ...this.recordsRead.notes.map((note) => note.reason)]

      return parts.filter(Boolean).join(' ')
    },
  },
  methods: {
    setBaseline(id) {
      this.baselineId = id === undefined || id === null ? null : id
      this.releaseLink('missile', this.baselineId)
    },

    // A link of the comparison that was read is given up when the choice it names is made again on the page, so that the next save links it to the open save.
    releaseLink(type, id) {
      this.linkCarry = this.linkCarry.filter((link) => !(link.type === type && link.id === id))
    },

    // Adds an alternative, or says why it cannot be.
    pushAlternative(entry) {
      const outcome = addAlternative(this.alternatives, entry)

      if (outcome.ok) {
        this.alternatives = outcome.list
        this.alternativeMessage = ''
      } else {
        this.alternativeMessage = outcome.reason
      }
    },

    seedFromBaseline() {
      const seeded = seedAlternative(this.designerContext, this.baselineId)

      if (seeded.ok) {
        this.pushAlternative(seeded.draft)
      } else {
        this.alternativeMessage = seeded.reason
      }
    },

    addSaved(id) {
      const before = this.alternatives.length

      this.pushAlternative(savedAlternative(id))

      if (this.alternatives.length > before) {
        this.releaseLink('missile', id)
      }
    },

    addBlank() {
      this.pushAlternative(emptyDraft(''))
    },

    updateAlternative(key, draft) {
      this.alternatives = this.alternatives.map((entry) => (entry.key === key ? { ...draft, key } : entry))
    },

    removeAlternative(key) {
      this.alternatives = removeAlternative(this.alternatives, key)
      this.alternativeMessage = ''
    },

    async copySummary() {
      try {
        await navigator.clipboard.writeText(this.summary)
        this.copyMessage = 'The comparison is copied as text.'
      } catch (error) {
        this.copyMessage = `The comparison could not be copied (${error && error.message ? error.message : 'the clipboard is not available'}).`
      }
    },

    // A researched level other than the game's pick is remembered; the pick itself is forgotten, so a later research moves it on. A line has one choice: a researched level replaces a hypothetical one.
    setTech(type, id) {
      const choice = { ...this.techChoice }

      if (id === (this.tech.lines[type].pick || {}).id) {
        delete choice[type]
      } else {
        choice[type] = id
        this.releaseLink('tech', id)
      }

      this.techChoice = choice

      return this.dropScenarioChoice(type)
    },

    // A hypothetical next tech of the line, kept in the tech scenario record of the race on the branch; null clears it. When the record cannot be written the choice holds for this page only, and the notice says why.
    async chooseNextTech(type, id) {
      const techId = id === undefined ? null : id

      if (techId === null && !this.techScenario.selection[type] && !this.heldChoices[type]) {
        return
      }

      if (techId !== null) {
        const choice = { ...this.techChoice }

        delete choice[type]
        this.releaseLink('tech', techId)
        this.techChoice = choice
      }

      const outcome = await saveChoice(this.records ? this.records.repository : null, this.scope, this.tech, this.techScenario, { typeId: type, techId })
      const held = { ...this.heldChoices }

      if (outcome.ok) {
        delete held[type]
        this.scenarioMessage = ''
        this.scenarioRevision += 1
      } else if (techId === null) {
        held[type] = null
        this.scenarioMessage = outcome.message
      } else {
        const candidate = this.tech.lines[type].candidates.find((item) => item.id === techId)

        held[type] = { techId, name: candidate ? candidate.name : `tech ${techId}` }
        this.scenarioMessage = outcome.message
      }

      this.heldChoices = held
    },

    // Removes the hypothetical choice of a line, from the record and from this page.
    async dropScenarioChoice(type) {
      if (this.heldChoices[type]) {
        const held = { ...this.heldChoices }

        delete held[type]
        this.heldChoices = held
      }

      if (this.techScenario.selection[type]) {
        await this.chooseNextTech(type, null)
      }
    },

    // Gives up a choice the save cannot honour, wherever it is kept.
    forgetChoice(type) {
      const choice = { ...this.techChoice }

      delete choice[type]
      this.techChoice = choice

      return this.dropScenarioChoice(type)
    },

    // The saved designs of a comparison that changed or are gone.
    missingLinks(entry) {
      return entry.links.filter((link) => link.status !== 'linked')
    },

    recordSummary(entry) {
      const { payload } = entry
      const designed = payload.alternatives.filter((item) => item.kind === 'designed').length
      const saved = payload.alternatives.length - designed
      const techCount = Object.keys(payload.tech.choices).length

      return `${payload.baselineId === null ? 'No baseline' : `Baseline design ${payload.baselineId}`} · ${saved} saved and ${designed} designed ${payload.alternatives.length === 1 ? 'alternative' : 'alternatives'} · target ${payload.scenario.targetSpeed} km/s, PD ${payload.scenario.pd} km/s · ${techCount ? `${techCount} tech ${techCount === 1 ? 'level' : 'levels'} chosen` : 'the tech of the save'}`
    },

    newRecord() {
      this.recordOrigin = null
      this.recordBaseline = null
      this.recordName = ''
      this.recordTouched = false
      this.recordConflict = null
      this.recordMessage = ''
    },

    // Puts a kept comparison on the page: its baseline, alternatives and scenario as they were typed, and the tech levels it was made with.
    openRecord(uuid) {
      const entry = this.recordsRead.entries.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const { payload } = entry

      this.baselineId = payload.baselineId
      this.alternatives = JSON.parse(JSON.stringify(payload.alternatives))
      this.hitTargetSpeed = payload.scenario.targetSpeed
      this.hitJammer = payload.scenario.jammer
      this.hitModifier = payload.scenario.modifier
      this.pd = payload.scenario.pd
      this.targetSignature = payload.scenario.targetSignature
      this.restoreTech(entry)
      this.recordName = payload.name
      this.recordTouched = false
      this.recordOrigin = uuid
      this.recordBaseline = { uuid, revision: entry.revision, links: entry.links }
      this.linkCarry = carryOf(entry.links, payload)
      this.recordConflict = null
      this.recordMessage = ''
    },

    // The tech levels a kept comparison names replace the page's choices, each resolved against the open save like any other: a researched level goes to the page's remembered levels, a hypothetical one to the page-only choices (the tech scenario record of the branch is not written). A level of the record's whose tech changed or is gone is held with its link status, so it reads as unresolved and named, and the line designs with the game's pick. A hypothetical choice of the branch the comparison has no choice for is hidden on this page.
    restoreTech(entry) {
      const researched = {}
      const held = {}

      DESIGN_LINE_TYPES.forEach((type) => {
        const choice = entry.payload.tech.choices[type]
        const link = choice ? entry.links.find((item) => item.type === 'tech' && item.id === choice.techId) || { type: 'tech', id: choice.techId, status: 'unknown', reason: 'the comparison kept no link for this tech' } : undefined
        const chosen = choice ? { techId: choice.techId, name: choice.name, ...(link ? { link } : {}) } : null

        if (choice && choice.kind === 'researched') {
          researched[type] = choice.techId
        }

        if (choice && choice.kind === 'hypothetical') {
          held[type] = chosen
        } else if (choice && link && link.status !== 'linked') {
          held[type] = { ...chosen, source: 'preference' }
        } else if (this.techScenario.selection[type]) {
          held[type] = null
        }
      })

      this.techChoice = researched
      this.heldChoices = held
      this.scenarioMessage = Object.keys(held).length ? 'The tech levels of the comparison apply on this page only: the tech scenario record of the branch is unchanged.' : ''
    },

    saveRecordAsNew() {
      return this.saveRecord(false, true)
    },

    async saveRecord(overwrite = false, asNew = false) {
      this.recordTouched = true

      const entry = asNew ? null : this.recordEntry
      const payload = this.recordPayload
      const outcome = await saveDesign(this.records ? this.records.repository : null, this.scope, this.designs, { entry, payload, overwrite, tech: this.tech, carry: [...techLinksOf(this.techSelection), ...this.linkCarry] })

      if (outcome.ok) {
        this.recordOrigin = outcome.record.uuid
        this.recordBaseline = { uuid: outcome.record.uuid, revision: outcome.record.revision, links: [] }
        this.linkCarry = carryOf(outcome.record.links, payload)
        this.recordConflict = null
        this.recordMessage = ''
        this.recordRevision += 1
      } else if (outcome.code === 'revision-conflict') {
        this.recordConflict = { name: outcome.stored.name, revision: outcome.revision }
        this.recordMessage = ''
      } else {
        this.recordMessage = outcome.message
      }
    },

    async deleteRecord(uuid) {
      const entry = this.recordsRead.entries.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const outcome = await deleteDesign(this.records ? this.records.repository : null, this.scope, entry)

      if (outcome.ok) {
        if (this.recordOrigin === uuid) {
          this.newRecord()
        }

        this.recordMessage = ''
        this.recordRevision += 1
      } else {
        this.recordMessage = outcome.message
      }
    },

    async moveRecord(uuid) {
      const entry = this.recordsRead.entries.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const outcome = await moveDesign(this.records ? this.records.repository : null, this.scope, entry)

      if (outcome.ok) {
        if (this.recordOrigin === uuid) {
          this.recordBaseline = { uuid, revision: outcome.record.revision, links: entry.links }
        }

        this.recordMessage = `The comparison ${entry.name} now applies to this save.`
        this.recordRevision += 1
      } else {
        this.recordMessage = outcome.message
      }
    },
  },
  asyncComputed: {
    tech: {
      get: tracked('tech', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_TECH_CHOICES
        }

        return await loadTechChoices(this.database, this.context)
      }),
      default: NO_TECH_CHOICES,
    },
    // The missiles the race has researched and owns, as the saved designs of a fixture the rules read.
    designs: {
      get: tracked('designs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_DESIGNS
        }

        return await loadDesigns(this.database, this.context)
      }),
      default: NO_DESIGNS,
    },
    // The formula version the save's schema stands for, which the hit chance rules are read for.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
    // The repository of scenario records, loaded when the page is: its module needs the app's settings store, so a page that is read without it still loads.
    records: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerTechScenarios(records.registerAdapter)
          registerDesigner(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: error.message })
        }
      },
      default: null,
    },
  },
}
</script>

<style lang="scss">
.missile-designer-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }

  .tool {
    min-width: 0;
  }

  .tool__label {
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
    white-space: nowrap;
  }

  .tool--baseline {
    flex: 1 1 260px;
    max-width: 420px;
  }

  .tool--number {
    flex: 0 0 170px;
  }

  .tool--name {
    flex: 1 1 220px;
    max-width: 360px;
  }

  .tool--actions {
    align-self: flex-end;
  }

  .tool__buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .tool__buttons .v-btn {
    height: 40px !important;
  }

  .missile-designer-page__draft + .missile-designer-page__draft {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid rgba(128, 128, 128, 0.3);
  }
}
</style>
