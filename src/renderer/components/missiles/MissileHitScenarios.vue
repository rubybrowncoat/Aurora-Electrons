<template>
  <v-card class="panel missile-hit" data-summary="The hit chance of the race's missile designs and of one proposed missile against a typed target." elevation="1">
    <div class="panel-head">
      <span>Missile hit chance<provenance-mark :rule="rules.raw" /></span>
      <span class="text--secondary body-2">{{ count(rows.length) }} {{ rows.length === 1 ? 'missile' : 'missiles' }} · follows the filters and search above</span>
    </div>
    <div class="panel-body">
      <div class="missile-hit__inputs">
        <div class="missile-hit__group">
          <div class="subtitle-2">Scenario</div>
          <div class="missile-hit__fields">
            <div class="missile-hit__field">
              <div class="caption text--secondary">Target speed</div>
              <v-text-field v-model="hitTargetSpeed" type="number" min="0" suffix="km/s" aria-label="Target speed in km/s" :error-messages="errors.targetSpeed" dense outlined hide-details="auto" />
            </div>
            <div class="missile-hit__field">
              <div class="caption text--secondary">Target missile jammer</div>
              <v-text-field v-model="hitJammer" type="number" min="0" aria-label="Strength of the target's missile jammer" :error-messages="errors.jammer" dense outlined hide-details="auto" />
            </div>
            <div class="missile-hit__field">
              <div class="caption text--secondary">Tactical modifier</div>
              <v-text-field v-model="hitModifier" type="number" min="0" step="0.05" aria-label="Tactical modifier of the launching ship" :error-messages="errors.modifier" dense outlined hide-details="auto" />
            </div>
          </div>
        </div>
        <div class="missile-hit__group">
          <div class="subtitle-2">Proposed missile <span class="caption text--secondary">· optional, joins the table once its speed is entered</span></div>
          <div class="missile-hit__fields">
            <div class="missile-hit__field">
              <div class="caption text--secondary">Speed</div>
              <v-text-field v-model="hitProposed.speed" type="number" min="0" suffix="km/s" aria-label="Speed of the proposed missile in km/s" :error-messages="errors.proposedSpeed" dense outlined hide-details="auto" />
            </div>
            <div class="missile-hit__field">
              <div class="caption text--secondary">Terminal guidance</div>
              <v-text-field v-model="hitProposed.atg" type="number" min="0" step="0.05" aria-label="Terminal guidance multiplier of the proposed missile" :error-messages="errors.proposedGuidance" dense outlined hide-details="auto" />
            </div>
            <div class="missile-hit__field">
              <div class="caption text--secondary">ECCM</div>
              <v-text-field v-model="hitProposed.eccm" type="number" min="0" aria-label="ECCM of the proposed missile" :error-messages="errors.proposedEccm" dense outlined hide-details="auto" />
            </div>
            <div class="missile-hit__field">
              <div class="caption text--secondary">Warheads</div>
              <v-text-field v-model="hitProposed.warheads" type="number" min="1" step="1" aria-label="Warheads of the proposed missile" :error-messages="errors.proposedWarheads" dense outlined hide-details="auto" />
            </div>
          </div>
        </div>
      </div>
      <div class="missile-hit__assumption caption text--secondary">{{ assumptionText }}</div>
    </div>

    <v-data-table class="missile-hit__table" :headers="headers" :items="rows" item-key="key" :item-class="rowClass" :custom-sort="sortRows" :sort-by.sync="hitTable.sortBy" :sort-desc.sync="hitTable.sortDesc" :items-per-page.sync="hitTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" no-data-text="No missile matches the filters and search, and no proposed missile is entered." @click:row="onRowClick">
      <template v-for="column in markedColumns" #[`header.${column.value}`]="{ header }">
        <span :key="column.value">
          <v-tooltip top max-width="320">
            <template #activator="{ on }">
              <span v-on="on">{{ header.text }}<v-icon x-small class="ml-1">mdi-information-outline</v-icon></span>
            </template>
            <span>{{ column.hint }}</span>
          </v-tooltip><provenance-mark v-if="column.rule" :rule="column.rule" />
        </span>
      </template>
      <template #[`item.name`]="{ item }">
        <div class="py-2 name-cell">
          <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
          <div class="caption text--secondary text-no-wrap">{{ kindText(item) }}</div>
        </div>
      </template>
      <template #[`item.speed`]="{ item }">{{ count(item.speed) }}</template>
      <template #[`item.atg`]="{ item }">{{ count(item.atg, 2) }}</template>
      <template #[`item.eccm`]="{ item }">{{ count(item.eccm) }}</template>
      <template #[`item.warheads`]="{ item }">{{ count(item.warheads) }}</template>
      <template #[`item.effectValue`]="{ item }">
        <span v-if="item.stationary" class="text--secondary" title="A stationary target is hit at 100 before any jammer counts">n/a</span>
        <span v-else-if="item.effectValue === null" class="text--disabled">—<provenance-mark :result="item.effect" /></span>
        <span v-else class="text-no-wrap">{{ effectText(item.effectValue) }}<provenance-mark :result="item.effect" /></span>
      </template>
      <template #[`item.rawValue`]="{ item }">
        <span v-if="item.rawValue === null" class="text--disabled">—<provenance-mark :result="item.raw" /></span>
        <span v-else class="text-no-wrap">{{ percent(item.raw) }}<provenance-mark :result="item.raw" /></span>
      </template>
      <template #[`item.cappedValue`]="{ item }">
        <span v-if="item.cappedValue === null" class="text--disabled">—<provenance-mark :result="item.capped" /></span>
        <template v-else>
          <div class="text-no-wrap font-weight-medium">{{ percent(item.capped) }}<provenance-mark :result="item.capped" /></div>
          <div class="caption text--secondary text-no-wrap">Roll {{ percent(item.roll, 0) }}</div>
        </template>
      </template>
      <template #[`item.hitsValue`]="{ item }">
        <span v-if="item.hitsValue === null" class="text--disabled">—<provenance-mark :result="item.hitsCapped" /></span>
        <template v-else>
          <div class="text-no-wrap">{{ count(item.hitsValue, 2) }}<provenance-mark :result="item.hitsCapped" /></div>
          <div class="caption text--secondary text-no-wrap">Roll {{ count(item.hitsRollValue, 2) }}</div>
        </template>
      </template>
    </v-data-table>

    <div v-if="focus" class="panel-body missile-hit__focus">
      <div class="missile-hit__focus-head">
        <div class="subtitle-2">Where the chance changes</div>
        <v-autocomplete :value="focus.key" class="missile-hit__pick" :items="rows" item-text="name" item-value="key" aria-label="Missile to chart" dense outlined hide-details @change="(key) => (focusKey = key)" />
      </div>
      <stat-tiles compact :tiles="tiles" />
      <v-row class="mt-2">
        <v-col cols="12" md="6">
          <div class="body-2 font-weight-medium">By target speed<provenance-mark :rule="rules.raw" /></div>
          <v-simple-table dense class="missile-hit__curve">
            <thead>
              <tr>
                <th class="text-right">Target speed (km/s)</th>
                <th class="text-right">Raw</th>
                <th class="text-right">Capped</th>
                <th class="text-right">Roll</th>
                <th class="text-right">Hits</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in speedRows" :key="row.speed" :class="{ 'is-selected-row': row.current }">
                <td class="text-right text-no-wrap">{{ count(row.speed) }}<span v-if="row.stationary" class="caption text--secondary"> stationary</span></td>
                <td class="text-right text-no-wrap">{{ percent(row.raw) }}<provenance-mark :result="row.raw" /></td>
                <td class="text-right text-no-wrap">{{ percent(row.capped) }}</td>
                <td class="text-right text-no-wrap">{{ percent(row.roll, 0) }}</td>
                <td class="text-right text-no-wrap">{{ hitsText(row.hitsCapped) }}</td>
              </tr>
            </tbody>
          </v-simple-table>
        </v-col>
        <v-col cols="12" md="6">
          <div class="body-2 font-weight-medium">By target missile jammer, against {{ targetText }}<provenance-mark :rule="rules.jammer" /></div>
          <v-simple-table dense class="missile-hit__curve">
            <thead>
              <tr>
                <th class="text-right">Jammer</th>
                <th class="text-right">Effect</th>
                <th class="text-right">Raw</th>
                <th class="text-right">Capped</th>
                <th class="text-right">Roll</th>
                <th class="text-right">Hits</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in jammerRows" :key="row.jammer" :class="{ 'is-selected-row': row.current }">
                <td class="text-right text-no-wrap">{{ count(row.jammer) }}</td>
                <td class="text-right text-no-wrap">{{ row.stationary ? 'n/a' : valueText(row.effect, (value) => effectText(value)) }}<provenance-mark v-if="!row.stationary" :result="row.effect" /></td>
                <td class="text-right text-no-wrap">{{ percent(row.raw) }}<provenance-mark :result="row.raw" /></td>
                <td class="text-right text-no-wrap">{{ percent(row.capped) }}</td>
                <td class="text-right text-no-wrap">{{ percent(row.roll, 0) }}</td>
                <td class="text-right text-no-wrap">{{ hitsText(row.hitsCapped) }}</td>
              </tr>
            </tbody>
          </v-simple-table>
        </v-col>
      </v-row>
    </div>

    <div class="panel-foot caption text--secondary">
      <div>Raw chance is the missile's speed over the target's speed, times 10, the tactical modifier, the terminal guidance (at least 1) and the jammer effect, not limited to 100<provenance-mark :rule="rules.raw" />. Capped chance limits it to 100<provenance-mark :rule="rules.capped" />. A stationary target is hit at 100. The tactical modifier is 1 unless entered: the launching ship's crew, morale and commander bonuses are not read from the save.</div> <div class="mt-1">A target's missile jammer counts only above the missile's ECCM, and then as 0.75 to the whole jammer strength<provenance-mark :rule="rules.jammer" />.</div> <div class="mt-1">Roll is the capped chance rounded down to a whole percent, on a fair die of 1 to 100 with a hit on a roll not above the chance; the game's own rounding is not settled, so Roll is an estimate<provenance-mark :rule="rules.roll" />. Expected hits are the warheads of one missile times the chance of one warhead hitting, with no allowance for a missile shot down or falling short, so the figure is a planner figure and no expected-damage rating<provenance-mark :rule="rules.hits" />.</div> <div class="mt-1">A missile with a second stage, and a ship decoy, have no chance here, and a missile whose stage count is not stored is not known to be single-stage.</div>
    </div>
  </v-card>
</template>

<script>
import countFormat from '../../mixins/count-format'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { sortRows } from '../../utilities/designed-tech'
import { HIT_RULES, entered, jammerCurve, proposedMissile, savedMissile, scenarioRows, speedCurve, targetSpeedForChance, versionLimit } from '../../utilities/missile-hit'
import { describeResult, isAvailable, unavailable, valueOrNull } from '../../utilities/provenance'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import StatTiles from '../page/StatTiles.vue'

const PAGE_SIZES = [15, 30, -1]

const PROPOSED_DEFAULT = { speed: '', atg: '1', eccm: '0', warheads: '1' }

const text = (value) => typeof value === 'string'

const normaliseProposed = (stored) => (stored !== null && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(PROPOSED_DEFAULT).every((key) => text(stored[key])) ? Object.fromEntries(Object.keys(PROPOSED_DEFAULT).map((key) => [key, stored[key]])) : undefined)

const COLUMNS = [
  { text: 'Missile', value: 'name', align: 'start' },
  { text: 'Speed', value: 'speed', align: 'end', hint: 'The missile\'s speed in km/s.' },
  { text: 'ATG', value: 'atg', align: 'end', hint: 'Active terminal guidance, the multiplier the design stores. A value under 1 counts as 1.' },
  { text: 'ECCM', value: 'eccm', align: 'end', hint: 'The target\'s missile jammer counts only when its strength is above this.' },
  { text: 'Warheads', value: 'warheads', align: 'end' },
  { text: 'Jammer', value: 'effectValue', align: 'end', rule: HIT_RULES.jammer, hint: 'The multiplier the target\'s missile jammer puts on the chance: none at or below the missile\'s ECCM, 0.75 to the jammer strength above it.' },
  { text: 'Raw chance', value: 'rawValue', align: 'end', rule: HIT_RULES.raw, hint: 'The continuous chance the speeds, guidance, modifier and jammer give. It is not limited to 100.' },
  { text: 'Capped chance', value: 'cappedValue', align: 'end', rule: HIT_RULES.capped, hint: 'The raw chance limited to 100. Under it, Roll is the chance of one warhead on a whole-number roll, an estimate.' },
  { text: 'Hits', value: 'hitsValue', align: 'end', rule: HIT_RULES.hits, hint: 'Expected warhead hits per missile: the warheads times the chance of one warhead hitting, each rolling independently. Not penetrating damage and not point-defence survival.' },
]

const need = (value, test, message) => {
  const number = entered(value)

  return number !== null && test(number) ? '' : message
}

// The hit chance panel of the Designed page's missile category: the missiles of `missiles` (the page's shown designs) and one proposed missile, each against a target speed, missile jammer and tactical modifier entered here, with the curves of one missile. The figures come from utilities/missile-hit.js; `version` is the save's formula version.
export default {
  name: 'MissileHitScenarios',
  components: { ProvenanceMark, StatTiles },
  mixins: [
    countFormat,
    persistedView({
      hitTargetSpeed: { key: 'missileHitTargetSpeed', default: '10000', valid: text },
      hitJammer: { key: 'missileHitJammer', default: '0', valid: text },
      hitModifier: { key: 'missileHitModifier', default: '1', valid: text },
      hitProposed: { key: 'missileHitProposed', default: { ...PROPOSED_DEFAULT }, normalise: normaliseProposed },
      hitTable: tableView('missileHitTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  props: {
    missiles: {
      type: Array,
      required: true,
    },
    version: {
      type: String,
      default: null,
    },
  },
  data() {
    return {
      focusKey: null,
      pageSizes: PAGE_SIZES,
      rules: HIT_RULES,
      sortRows,
    }
  },
  computed: {
    headers() {
      return COLUMNS.map(({ text: label, value, align }) => ({ text: label, value, align }))
    },

    markedColumns() {
      return COLUMNS.filter((column) => column.hint)
    },

    errors() {
      const proposed = this.hitProposed
      const entering = String(proposed.speed).trim() !== ''

      return {
        targetSpeed: need(this.hitTargetSpeed, (value) => value >= 0, 'Enter a speed of 0 or more'),
        jammer: need(this.hitJammer, (value) => value >= 0, 'Enter a strength of 0 or more'),
        modifier: need(this.hitModifier, (value) => value > 0, 'Enter a modifier above 0'),
        proposedSpeed: entering ? need(proposed.speed, (value) => value > 0, 'Enter a speed above 0') : '',
        proposedGuidance: entering ? need(proposed.atg, (value) => value >= 0, 'Enter a number') : '',
        proposedEccm: entering ? need(proposed.eccm, (value) => value >= 0, 'Enter a number') : '',
        proposedWarheads: entering ? need(proposed.warheads, (value) => Number.isInteger(value) && value >= 1, 'Enter a whole number') : '',
      }
    },

    // The assumptions every figure below is worked under, written beside the results.
    assumptionText() {
      const jammer = this.errors.jammer ? 'no valid jammer strength' : `a target missile jammer of ${this.count(entered(this.hitJammer), 2)}`
      const modifier = this.errors.modifier ? 'no valid tactical modifier' : `a tactical modifier of ${this.count(entered(this.hitModifier), 2)}, entered here and not read from the save`

      return `Results assume ${this.targetText}, ${jammer} and ${modifier}. A figure with no valid input shows a dash, never 0.${this.versionNote ? ` ${this.versionNote}.` : ''}`
    },

    versionNote() {
      return versionLimit(this.version)
    },

    proposed() {
      return proposedMissile(this.hitProposed)
    },

    entries() {
      return [...(this.proposed ? [this.proposed] : []), ...this.missiles.map(savedMissile)]
    },

    scenario() {
      return { targetSpeed: this.hitTargetSpeed, jammer: this.hitJammer, modifier: this.hitModifier, version: this.version }
    },

    rows() {
      return scenarioRows({ missiles: this.entries, ...this.scenario })
    },

    // The missile the curves and tiles are of: the one picked, else the first with a speed, else the first.
    focus() {
      return this.entries.find((entry) => entry.key === this.focusKey) || this.entries.find((entry) => entered(entry.speed) > 0 && !entry.shipDecoy && entry.secondStageId === 0) || this.entries[0] || null
    },

    speedRows() {
      return this.focus ? speedCurve({ missile: this.focus, ...this.scenario }) : []
    },

    jammerRows() {
      return this.focus ? jammerCurve({ missile: this.focus, ...this.scenario }) : []
    },

    targetText() {
      return this.errors.targetSpeed ? 'no valid target speed' : `a target moving at ${this.count(entered(this.hitTargetSpeed), 2)} km/s`
    },

    tiles() {
      const { focus } = this
      const speedTile = (label, chance, note) => {
        const result = targetSpeedForChance({ missile: focus, chance, jammer: this.hitJammer, modifier: this.hitModifier, version: this.version })

        return { label, value: isAvailable(result) ? `${this.count(result.value)} km/s` : '—', note, title: describeResult(result), result }
      }

      const eccm = entered(focus.eccm)
      const threshold = eccm === null || eccm < 0 ? { value: '—', result: unavailable({ rule: HIT_RULES.jammer, missing: ['the missile\'s ECCM'] }) } : { value: `above ${this.count(eccm)}`, rule: HIT_RULES.jammer }

      return [
        speedTile('Capped chance of 100 up to', 100, 'The fastest target hit at the cap, under the jammer and modifier entered'),
        speedTile('Chance of 50% at', 50, 'The target speed that halves the raw chance, under the jammer and modifier entered'),
        { label: 'Jammer counts when', ...threshold, note: 'A jammer at or below the ECCM has no effect; above it the chance is multiplied by 0.75 to the jammer strength' },
      ]
    },
  },
  watch: {
    entries(entries) {
      if (this.focusKey !== null && !entries.some((entry) => entry.key === this.focusKey)) {
        this.focusKey = null
      }
    },
  },
  methods: {
    isAvailable,

    // A chance result as a percentage, a dash when it has no value.
    percent(result, decimals = 2) {
      const value = valueOrNull(result)

      return value === null ? '—' : `${this.count(value, decimals)}%`
    },

    hitsText(result) {
      const value = valueOrNull(result)

      return value === null ? '—' : this.count(value, 2)
    },

    valueText(result, format) {
      const value = valueOrNull(result)

      return value === null ? '—' : format(value)
    },

    effectText(value) {
      return value === 1 ? 'None' : `× ${this.count(value, 3)}`
    },

    kindText(item) {
      return [item.kind === 'proposed' ? 'Proposed' : 'Saved', item.obsolete ? 'Obsolete' : '', item.shipDecoy ? 'Ship decoy' : '', item.secondStageId > 0 ? 'Staged' : ''].filter(Boolean).join(' · ')
    },

    rowClass(item) {
      return this.focus && item.key === this.focus.key ? 'is-selected-row' : ''
    },

    onRowClick(item) {
      this.focusKey = item.key
    },
  },
}
</script>

<style lang="scss">
.missile-hit {
  .missile-hit__inputs {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 32px;
  }

  .missile-hit__fields {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-top: 4px;
  }

  .missile-hit__field {
    flex: 0 1 160px;
    min-width: 120px;
  }

  .missile-hit__assumption {
    margin-top: 12px;
  }

  .missile-hit__table tbody tr {
    cursor: pointer;
  }

  .missile-hit__table td,
  .missile-hit__table th {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    padding: 0 10px !important;
  }

  .name-cell {
    max-width: 200px;
  }

  .name-cell .text-no-wrap {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .missile-hit__focus {
    padding-top: 16px;
  }

  .missile-hit__focus-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-bottom: 8px;
  }

  .missile-hit__pick {
    flex: 0 1 360px;
    min-width: 220px;
  }

  .missile-hit__curve {
    background: transparent !important;
  }

  .missile-hit__curve td,
  .missile-hit__curve th {
    font-variant-numeric: tabular-nums;
  }
}
</style>
