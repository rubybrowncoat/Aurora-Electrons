<template>
  <v-card class="panel" data-summary="Define the ship's requirements and the preferences used to rank alternatives." elevation="1" data-brief="panel">
    <div class="panel-head">
      <span>Mission brief<v-chip v-if="dirty" x-small color="warning" outlined class="ml-2" data-brief="dirty-chip">{{ briefWords.unsaved }}</v-chip><v-chip v-if="draft.preset" x-small outlined class="ml-2" data-brief="preset-chip">From {{ presetLabel(draft.preset) }}</v-chip></span>
      <span class="d-flex align-center flex-wrap">
        <v-menu offset-y>
          <template #activator="{ on, attrs }">
            <v-btn small text class="mr-1" v-bind="attrs" data-brief="preset-menu" v-on="on"><v-icon small left>mdi-playlist-plus</v-icon>Preset</v-btn>
          </template>
          <v-list dense>
            <v-list-item v-for="preset in presets" :key="preset.key" :data-brief="`preset-${preset.key}`" @click="$emit('preset', preset.key)">
              <v-list-item-content>
                <v-list-item-title>{{ preset.label }}</v-list-item-title>
                <v-list-item-subtitle>{{ preset.summary }}</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
        </v-menu>
        <v-btn small text class="mr-1" data-brief="new" @click="$emit('new')"><v-icon small left>mdi-file-plus-outline</v-icon>New</v-btn>
        <v-btn small color="primary" class="mr-1" :disabled="!canSave" data-brief="save" @click="$emit('save')"><v-icon small left>mdi-content-save-outline</v-icon>{{ selected ? 'Save' : 'Save as new' }}</v-btn>
        <v-btn small text :disabled="!selected" data-brief="delete" @click="$emit('remove')"><v-icon small left>mdi-delete-outline</v-icon>Delete</v-btn>
      </span>
    </div>

    <div class="panel-body">
      <v-alert v-if="pending" type="warning" outlined dense class="mb-3" data-brief="discard">
        <span data-brief="question">{{ pending.blank ? briefWords.discardBlank : briefWords.discardOther }}</span>
        <v-btn small text class="ml-2" data-brief="discard-yes" @click="$emit('discard')">Discard</v-btn>
        <v-btn small text data-brief="discard-no" @click="$emit('keep')">Keep editing</v-btn>
      </v-alert>
      <v-alert v-if="conflict" type="warning" outlined dense class="mb-3" data-brief="conflict">
        The saved brief changed since it was opened{{ conflict.name ? ` (now named ${conflict.name})` : '' }}. Nothing was written.
        <v-btn small text class="ml-2" data-brief="save-over" @click="$emit('save-over')">Save over the other change</v-btn>
      </v-alert>
      <v-alert v-if="message" type="info" outlined dense class="mb-3" data-brief="message">{{ message }}</v-alert>
      <v-alert v-for="entry in ahead" :key="entry.uuid" type="info" outlined dense class="mb-3" data-brief="ahead">
        The brief {{ entry.name }} was made at a later game time than this save, so it is not applied.
        <v-btn small text class="ml-2" data-brief="move" @click="$emit('move', entry.uuid)">Use on this save</v-btn>
      </v-alert>

      <v-row dense>
        <v-col cols="12" md="4">
          <v-autocomplete :value="selected" :items="saved" item-text="name" item-value="uuid" label="Saved brief" dense outlined clearable hide-details="auto" :no-data-text="'No brief saved for this race yet.'" data-brief="select" @change="(value) => $emit('select', value)" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field :value="draft.name" label="Name" dense outlined hide-details="auto" :counter="nameLength" :error-messages="nameError" data-brief="name" @input="(value) => $emit('field', 'name', value)" />
        </v-col>
      </v-row>

      <div class="overline mt-3">Requirements</div>
      <div class="caption text--secondary mb-2">A requirement left empty is not required. A figure an alternative does not give counts as unknown, never as a pass.</div>
      <v-row dense>
        <v-col v-for="field in fields" :key="field.key" cols="12" sm="6" md="3">
          <v-text-field :value="typed[field.key]" :label="field.label" :suffix="field.unit" dense outlined hide-details="auto" :hint="field.hint" persistent-hint :error-messages="errors[field.key]" :data-brief-field="field.key" @input="(value) => type(field.key, value)" />
          <v-btn-toggle v-if="field.key === 'maxSizeHS'" :value="sizeUnit" mandatory dense class="mt-1" data-brief="size-unit" @change="(value) => $emit('size-unit', value)">
            <v-btn value="hs" x-small>HS</v-btn>
            <v-btn value="tons" x-small>Tons</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-text-field :value="typed.cruiseShare" label="Cruise power" suffix="% of full power" dense outlined hide-details="auto" hint="The power the endurance is measured at." persistent-hint :error-messages="errors.cruiseShare" data-brief-field="cruiseShare" @input="(value) => type('cruiseShare', value)" />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-select :value="draft.requirements.classification" :items="classifications" label="Classification" dense outlined hide-details="auto" :hint="classificationHint" persistent-hint data-brief-field="classification" @change="(value) => $emit('field', 'classification', value)" />
        </v-col>
      </v-row>

      <div class="overline mt-4">Preferences</div>
      <div class="caption text--secondary mb-2">A preference only orders the alternatives that reach the same verdict, in the order given. It never lets an alternative past a requirement.</div>
      <v-row dense>
        <v-col v-for="(axis, index) in axisRows" :key="index" cols="12" md="4" class="d-flex align-start">
          <v-select :value="axis.figure" :items="axisOptions(index)" :label="`Preference ${index + 1}`" dense outlined clearable hide-details="auto" :data-brief-axis="index" @change="(value) => pickAxis(index, value)" />
          <v-btn-toggle :value="axis.direction" mandatory dense class="ml-2" :disabled="!axis.figure" @change="(value) => pickDirection(index, value)">
            <v-btn value="min" small title="Smaller first">Min</v-btn>
            <v-btn value="max" small title="Larger first">Max</v-btn>
          </v-btn-toggle>
        </v-col>
      </v-row>

      <div v-if="draft.unmodelled.length" class="mt-4" data-brief="notes">
        <div class="overline">Not modelled</div>
        <div v-for="note in draft.unmodelled" :key="note.key" class="caption text--secondary mb-1"><v-chip x-small outlined class="mr-2">Unknown</v-chip><span class="font-weight-medium">{{ note.label }}</span> {{ note.note }}</div>
      </div>

      <div v-if="preview" class="mt-4" data-brief="preview">
        <div class="overline">Preview of the {{ preview.label }} preset</div>
        <div class="caption text--secondary mb-1">{{ preview.summary }}</div>
        <div class="caption text--secondary mb-2">{{ preview.basis }}</div>
        <v-simple-table dense class="detail-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Now</th>
              <th>Preset</th>
              <th>Change</th>
              <th class="text-center">Apply</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in preview.items" :key="item.key" :data-brief-item="item.key">
              <td>{{ item.label }}</td>
              <td class="text-no-wrap">{{ show(item.key, item.from) }}</td>
              <td>{{ show(item.key, item.to) }}</td>
              <td>{{ kindText(item.kind) }}</td>
              <td class="text-center"><v-checkbox v-if="item.kind !== 'same'" :input-value="accepted.includes(item.key)" dense hide-details class="mt-0 pt-0 d-inline-block" :aria-label="`Apply the preset's ${item.label}`" @change="$emit('toggle', item.key)" /></td>
            </tr>
          </tbody>
        </v-simple-table>
        <div class="caption text--secondary mt-1">Fields that are empty now are ticked; a field that has a value is changed only when ticked. {{ preview.untouched.length ? `The preset gives nothing for ${preview.untouched.join(', ')}, which stay as they are.` : '' }} The saved brief stays as it is until Save.</div>
        <div class="mt-2">
          <v-btn small color="primary" class="mr-2" data-brief="apply" @click="$emit('apply')">Apply ticked fields</v-btn>
          <v-btn small text data-brief="cancel-preview" @click="$emit('cancel-preview')">Cancel</v-btn>
        </div>
      </div>

      <div class="overline mt-4">Alternatives against the brief</div>
      <div class="caption text--secondary mb-2" data-brief="counts">{{ countsText }}</div>
      <v-simple-table v-if="evaluation.alternatives.length" dense class="detail-table" data-brief="results">
        <thead>
          <tr>
            <th class="text-right">#</th>
            <th>Alternative</th>
            <th>Verdict</th>
            <th>Violated</th>
            <th>Unknown</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <template v-for="item in evaluation.alternatives">
            <tr :key="item.id" :data-brief-alternative="item.id">
              <td class="text-right">{{ item.rank }}</td>
              <td class="text-no-wrap">{{ item.name }}<v-chip v-if="item.pinned" x-small outlined class="ml-2">Saved class</v-chip></td>
              <td><v-chip x-small label :color="verdictColor(item.verdict)" outlined>{{ verdictText(item.verdict) }}</v-chip></td>
              <td>{{ names(item.violated) }}</td>
              <td>{{ names(item.unknown) }}</td>
              <td class="text-right"><v-btn icon x-small :aria-label="`${isOpen(item.id) ? 'Hide' : 'Show'} the requirements of ${item.name}`" @click="toggleOpen(item.id)"><v-icon small>{{ isOpen(item.id) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon></v-btn></td>
            </tr>
            <tr v-if="isOpen(item.id)" :key="`${item.id}-detail`" :data-brief-detail="item.id">
              <td colspan="6" class="expand-cell">
                <v-simple-table dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Requirement</th>
                      <th>Verdict</th>
                      <th class="text-right">Required</th>
                      <th class="text-right">Found</th>
                      <th>Unit</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="requirement in item.requirements" :key="requirement.key" :data-brief-requirement="requirement.key">
                      <td data-brief-cell="label">{{ requirement.label }}<v-chip v-if="requirement.kind === 'optional'" x-small outlined class="ml-2">Optional</v-chip></td>
                      <td data-brief-cell="verdict"><v-chip x-small label :color="requirementColor(requirement.verdict)" outlined>{{ requirement.verdict }}</v-chip></td>
                      <td class="text-right text-no-wrap" data-brief-cell="required">{{ requirement.required === null ? '—' : amount(requirement.key, requirement.required) }}</td>
                      <td class="text-right text-no-wrap" data-brief-cell="actual">{{ requirement.actual === null ? 'Unknown' : amount(requirement.key, requirement.actual) }}<provenance-mark v-if="requirement.figure" :result="requirement.figure" /></td>
                      <td data-brief-cell="unit">{{ unitOf(requirement) }}</td>
                      <td data-brief-cell="reason">{{ requirement.reason }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </td>
            </tr>
          </template>
        </tbody>
      </v-simple-table>
    </div>

    <div class="panel-foot caption text--secondary">
      Every alternative is judged against the limits. Each limit shows pass, fail or unknown, with the figure found, the figure required and the reason. Requirements decide the verdict: meets if every one passes, open if none fails and one is unknown, or fails if one fails. Preferences rank the alternatives within a verdict and are never added up. A preset fills the fields with a starting point to edit. A ship size of 50 tons is 1 HS. A cargo hold stores 50 tons for each HS of its size, and a hangar holds ships by their HS. A propulsion set is engines and tanks over a hull, so its cargo, hangar and deployment are unknown. A saved class gives them as the save stores them. The presets are guidance, not game rules. A brief is kept for the race on every branch of the campaign.
    </div>
  </v-card>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'
import countFormat from '../../mixins/count-format'
import { TONS_PER_HS } from '../../utilities/design-rules'
import { AXES, BRIEF_WORDS, REQUIREMENTS, axisOf, describeCounts, parseField, requirementOf, shownIn, typedText, typedUnit } from '../../utilities/mission-briefs'

const VERDICTS = { meets: 'Meets', open: 'Open', fails: 'Fails', none: 'No requirement' }
const VERDICT_COLORS = { meets: 'success', open: 'warning', fails: 'error', none: undefined }
const REQUIREMENT_COLORS = { pass: 'success', unknown: 'warning', fail: 'error' }
const KINDS = { add: 'Fills an empty field', replace: 'Replaces a value', same: 'No change' }
const CLASSIFICATIONS = [{ text: 'Not required', value: null }, { text: 'Military', value: 'military' }, { text: 'Commercial', value: 'commercial' }]

// The fields of a mission brief, the preview of a preset against them and the verdict of every alternative, as the page hands them over. Typing is parsed here (utilities/mission-briefs.js) and only a value that parses is emitted; the fields whose text does not parse are reported (`invalid`), and the text starts over when `identity` changes, which is when another brief is opened.
export default {
  name: 'MissionBriefPanel',
  components: { ProvenanceMark },
  mixins: [countFormat],
  props: {
    draft: { type: Object, required: true },
    identity: { type: Number, default: 0 },
    saved: { type: Array, default: () => [] },
    ahead: { type: Array, default: () => [] },
    selected: { type: String, default: null },
    dirty: { type: Boolean, default: false },
    canSave: { type: Boolean, default: false },
    problems: { type: Array, default: () => [] },
    evaluation: { type: Object, required: true },
    preview: { type: Object, default: null },
    accepted: { type: Array, default: () => [] },
    presets: { type: Array, default: () => [] },
    sizeUnit: { type: String, default: 'hs' },
    message: { type: String, default: '' },
    conflict: { type: Object, default: null },
    pending: { type: Object, default: null },
  },
  data() {
    return {
      typed: {},
      errors: {},
      opened: [],
      nameLength: 80,
    }
  },
  computed: {
    fields() {
      return REQUIREMENTS.filter((definition) => !definition.values).map((definition) => ({ key: definition.key, label: definition.label, unit: typedUnit(definition, { sizeUnit: this.sizeUnit }), hint: definition.hint }))
    },
    classifications() {
      return CLASSIFICATIONS
    },
    briefWords() {
      return BRIEF_WORDS
    },
    classificationHint() {
      return requirementOf('classification').hint
    },
    nameError() {
      return this.draft.name.trim() === '' ? ['Give the brief a name to save it.'] : []
    },
    axisRows() {
      return [0, 1, 2].map((index) => this.draft.axes[index] || { figure: null, direction: 'max' })
    },
    countsText() {
      return describeCounts(this.evaluation.counts, this.evaluation.alternatives.length)
    },
    invalid() {
      return Object.keys(this.errors).filter((key) => this.errors[key] && this.errors[key].length)
    },
    invalidSignature() {
      return this.invalid.join(',')
    },
  },
  watch: {
    draft: {
      immediate: true,
      handler() {
        this.syncTyped()
      },
    },
    sizeUnit() {
      this.syncTyped()
    },
    identity() {
      this.typed = {}
      this.errors = {}
      this.syncTyped()
    },
    invalidSignature() {
      this.$emit('invalid', this.invalid)
    },
  },
  methods: {
    presetLabel(key) {
      const preset = this.presets.find((item) => item.key === key)

      return preset ? preset.label : key
    },
    // The text of each field as the draft holds it, kept where the typed text already stands for the same value.
    syncTyped() {
      const typed = {}
      const errors = {}

      ;[...REQUIREMENTS.filter((definition) => !definition.values).map((definition) => definition.key), 'cruiseShare'].forEach((key) => {
        const value = key === 'cruiseShare' ? this.draft.cruiseShare : this.draft.requirements[key]
        const parsed = parseField(key, this.typed[key], { sizeUnit: this.sizeUnit })

        if (this.typed[key] !== undefined && parsed.ok && parsed.value === value) {
          typed[key] = this.typed[key]
        } else if (this.typed[key] !== undefined && !parsed.ok && this.errors[key]) {
          typed[key] = this.typed[key]
          errors[key] = this.errors[key]
        } else {
          typed[key] = typedText(key, value, { sizeUnit: this.sizeUnit })
        }
      })

      this.typed = typed
      this.errors = errors
    },
    type(key, text) {
      const parsed = parseField(key, text, { sizeUnit: this.sizeUnit })

      this.typed = { ...this.typed, [key]: text }
      this.errors = { ...this.errors, [key]: parsed.ok ? [] : [parsed.error] }

      if (parsed.ok) {
        this.$emit('field', key, parsed.value)
      }
    },
    axisOptions(index) {
      const others = this.draft.axes.filter((_axis, position) => position !== index).map((axis) => axis.figure)

      return AXES.filter((axis) => !others.includes(axis.figure)).map((axis) => ({ text: axis.label, value: axis.figure }))
    },
    pickAxis(index, figure) {
      const rows = this.axisRows.map((axis) => ({ ...axis }))

      rows[index] = figure ? { figure, direction: this.draft.axes[index] ? this.draft.axes[index].direction : axisOf(figure).direction } : { figure: null, direction: 'max' }
      this.$emit('axes', rows.filter((axis) => axis.figure))
    },
    pickDirection(index, direction) {
      const rows = this.axisRows.map((axis) => ({ ...axis }))

      rows[index].direction = direction
      this.$emit('axes', rows.filter((axis) => axis.figure))
    },
    kindText(kind) {
      return KINDS[kind]
    },
    verdictText(verdict) {
      return VERDICTS[verdict]
    },
    verdictColor(verdict) {
      return VERDICT_COLORS[verdict]
    },
    requirementColor(verdict) {
      return REQUIREMENT_COLORS[verdict]
    },
    names(list) {
      return list.length ? list.map((item) => item.label).join(', ') : '—'
    },
    isOpen(id) {
      return this.opened.includes(id)
    },
    toggleOpen(id) {
      this.opened = this.isOpen(id) ? this.opened.filter((item) => item !== id) : [...this.opened, id]
    },
    // A figure of a requirement as the panel shows it, in the unit shown beside it (unitOf): sizes in HS with their tons, a range in billions of km.
    amount(key, value) {
      const definition = requirementOf(key)
      const shown = definition ? shownIn(definition) : null

      if (!shown || typeof value !== 'number') {
        return String(value)
      }

      if (key === 'maxSizeHS') {
        return `${this.count(value, 2)} (${this.count(value * TONS_PER_HS)} tons)`
      }

      return this.count(value / shown.scale, shown.digits)
    },
    // The unit that goes with the numbers amount() gives for a requirement.
    unitOf(requirement) {
      const definition = requirementOf(requirement.key)
      const shown = definition ? shownIn(definition) : null

      return shown ? shown.unit : requirement.unit || '—'
    },
    // A value of a preview as it reads in its column.
    show(key, value) {
      if (value === null || value === undefined) {
        return '—'
      }

      if (key === 'axes') {
        return value.map((axis) => `${axisOf(axis.figure).label} ${axis.direction === 'min' ? 'smallest' : 'largest'} first`).join(', ')
      }

      if (key === 'cruiseShare') {
        return `${this.count(value * 100)}% of full power`
      }

      if (key === 'name' || key.startsWith('note:')) {
        return String(value)
      }

      const definition = requirementOf(key)
      const shown = definition ? shownIn(definition) : null

      return `${this.amount(key, value)} ${shown ? shown.unit : ''}`.trim()
    },
  },
}
</script>
