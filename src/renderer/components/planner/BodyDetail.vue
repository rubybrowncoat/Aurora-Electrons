<template>
  <div class="body-detail">
    <div class="d-flex align-center flex-wrap mb-3">
      <span class="caption text--secondary mr-3">Species</span>
      <v-btn-toggle :value="shown.species.SpeciesID" mandatory dense @change="(id) => $emit('species', id)">
        <v-btn v-for="evaluation in speciesOptions" :key="evaluation.species.SpeciesID" :value="evaluation.species.SpeciesID" small>
          {{ evaluation.species.SpeciesName }}
          <v-icon v-if="evaluation.species.SpeciesID === item.best.species.SpeciesID && item.best.strategy !== 'none'" x-small right title="Best for the goal">mdi-star</v-icon>
        </v-btn>
      </v-btn-toggle>
      <v-chip v-if="assessment.cost.colonisable" small label class="ml-3" :color="outcome.color" outlined>{{ plan ? `Terraformed: ${outcome.label}` : outcome.label }}</v-chip>
      <span v-if="assessment.cost.colonisable" class="caption text--secondary ml-2">{{ outcome.description }}</span>
    </div>

    <v-alert v-if="!assessment.cost.colonisable" type="error" outlined dense class="mb-0">{{ shown.species.SpeciesName }} can't live on this body: {{ assessment.reason.toLowerCase() }}.</v-alert>

    <v-row v-else>
      <v-col cols="12" md="4">
        <v-card outlined class="pa-3 mb-3">
          <div class="overline">Colony cost</div>
          <div class="headline">
            <template v-if="plan"><span class="text--secondary">{{ cost(assessment.cost.worst) }}</span> → {{ cost(assessment.after.worst) }}</template>
            <template v-else>{{ cost(assessment.cost.worst) }}</template>
            <span v-if="assessment.lowGravity" class="caption">LG</span>
          </div>
          <div class="caption text--secondary">
            Now {{ cost(assessment.cost.current) }}<template v-if="swing(assessment.cost)"> · periapsis {{ cost(assessment.cost.periapsis) }} · apoapsis {{ cost(assessment.cost.apoapsis) }}</template><template v-if="rules.ColonizationSkill !== 1"> · skill ×{{ rules.ColonizationSkill }}</template>
          </div>
          <div class="factor-list mt-2">
            <div v-for="factor in factors" :key="factor.key" class="factor" :class="{ 'factor-limit': factor.limiting }">
              <span class="factor-label">{{ factor.label }}</span>
              <span class="factor-bar"><i :style="{ width: `${factor.width}%` }" /></span>
              <span class="factor-value">{{ factor.text }}</span>
            </div>
          </div>
          <div v-if="assessment.cost.dangerousGas" class="caption mt-1"><v-icon x-small color="warning">mdi-biohazard</v-icon> {{ assessment.cost.dangerousGas.AtmosGasName }} is above its safe level.</div>
        </v-card>

        <v-card outlined class="pa-3">
          <div class="overline">What it holds</div>
          <div class="headline">
            <template v-if="plan && afterCapacity !== null && Math.abs(afterCapacity - shown.capacityNow) > 0.005"><span class="text--secondary">{{ people(shown.capacityNow) }}</span> → {{ people(afterCapacity) }}</template>
            <template v-else>{{ people(shown.capacityNow) }}</template>
          </div>
          <div class="caption text--secondary">Infrastructure: {{ infrastructureLine }}. Growth slows past a third of the capacity.</div>
        </v-card>
      </v-col>

      <v-col cols="12" md="8">
        <template v-if="plan">
          <div class="d-flex align-baseline flex-wrap">
            <h3 class="mr-3">Terraforming blueprint</h3>
            <span class="caption text--secondary">{{ planSummary }}</span>
          </div>
          <v-list dense class="py-0 blueprint">
            <v-list-item v-for="step in plan.steps" :key="`${step.key}-${step.gasId}`" two-line>
              <v-list-item-content>
                <v-list-item-title class="text-wrap">
                  Set {{ step.label }} to
                  <span class="target-value">
                    {{ round(step.set, 3) }}
                    <v-tooltip top>
                      <template #activator="{ on, attrs }">
                        <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copy(step.set)"><v-icon x-small>mdi-content-copy</v-icon></v-btn>
                      </template>
                      <span>Copy value</span>
                    </v-tooltip>
                  </span>
                  maximum atm.
                </v-list-item-title>
                <v-list-item-subtitle>From {{ round(step.from, 3) }}, about {{ years(stepYears(step)) }}.</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
            <v-list-item v-if="plan.settling.years > 0.1" two-line>
              <v-list-item-content>
                <v-list-item-title class="text-wrap">Then wait for the surface to settle</v-list-item-title>
                <v-list-item-subtitle>About {{ years(plan.settling.years) }} for natural {{ plan.settling.process === 'Evaporate' ? 'evaporation' : 'condensation' }} to bring the water to {{ round(plan.target.hydroExt, 1) }}%.</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
          <div v-if="plan.partial" class="caption text--secondary mt-1">The temperature range can't fit this orbit completely, so the plan aims for the best compromise.</div>

          <v-row dense class="mt-2">
            <v-col v-for="tile in tiles" :key="tile.label" cols="6" sm="3">
              <v-card outlined class="pa-3">
                <div class="overline">{{ tile.label }}</div>
                <div class="subtitle-1 text-no-wrap">{{ tile.to }}</div>
                <div class="caption text--secondary text-no-wrap">From {{ tile.from }}</div>
              </v-card>
            </v-col>
          </v-row>

          <div class="overline mt-3">Installations to finish within</div>
          <div class="d-flex flex-wrap installation-times">
            <span v-for="option in installationOptions" :key="option.years" class="mr-6 text-no-wrap"><b>{{ option.count }}</b> in {{ option.years }} y</span>
            <span class="text--secondary">{{ rates }}</span>
          </div>
        </template>
        <div v-else class="text--secondary">
          <h3 class="text--primary">Terraforming</h3>
          <div class="mt-1">{{ noPlanText }}</div>
        </div>

        <div class="overline mt-4">Minerals</div>
        <div v-if="!item.row.minerals.surveyed" class="text--secondary">Not surveyed by this race yet. Ground survey potential: {{ groundSurvey }}.</div>
        <div v-else-if="!deposits.length" class="text--secondary">The survey found nothing on this body.</div>
        <div v-else class="d-flex flex-wrap">
          <v-chip v-for="deposit in deposits" :key="deposit.MaterialID" small label outlined class="mr-2 mb-2" :class="{ 'text--disabled': deposit.Amount < ranking.minimumDeposit }">
            <b class="mr-1">{{ deposit.name }}</b> {{ tons(deposit.Amount) }} · {{ round(deposit.Accessibility, 2) }}
          </v-chip>
        </div>
        <div v-if="item.row.minerals.cmc.length" class="caption text--secondary">Civilian mining complex candidate ({{ item.row.minerals.cmc.join(', ') }}). {{ cmcLine }}</div>
        <div v-if="item.row.distance" class="caption text--secondary mt-1">{{ round(item.row.distance.au, 1) }} AU from the nearest colony over {{ item.row.distance.jumps }} {{ item.row.distance.jumps === 1 ? 'jump' : 'jumps' }}.</div>
      </v-col>
    </v-row>
  </div>
</template>

<script>
import { FACTORS, infrastructurePerMillion, limitingFactor } from '../../utilities/habitability'
import { people } from '../../utilities/colonies'
import { roundToDecimal, separatedNumber } from '../../utilities/math'
import { MINERALS, compact } from '../../utilities/minerals'
import { OUTCOMES, planYears } from '../../utilities/terraforming'

const GROUND_SURVEY = { 0: 'completed', 1: 'minimal', 2: 'low', 3: 'good', 4: 'high', 5: 'excellent' }
const INSTALLATION_YEARS = [5, 10, 25, 50]

export default {
  name: 'BodyDetail',
  props: {
    item: { type: Object, required: true },
    shown: { type: Object, required: true },
    speciesOptions: { type: Array, required: true },
    terraformCapacity: { type: Number, required: true },
    rules: { type: Object, required: true },
    separator: { type: String, default: "'" },
    ranking: { type: Object, required: true },
  },
  computed: {
    assessment() {
      return this.shown.assessment
    },
    plan() {
      return this.assessment.plan
    },
    outcome() {
      return OUTCOMES[this.assessment.outcome]
    },
    afterCapacity() {
      return this.shown.capacityAfter
    },
    groundSurvey() {
      return GROUND_SURVEY[this.item.body.GroundMineralSurvey] || 'unknown'
    },

    factors() {
      const { factors } = this.assessment.cost
      const limiting = limitingFactor(factors)
      const top = Math.max(2, ...FACTORS.map((factor) => factors[factor.key]))

      return FACTORS.map((factor) => ({ ...factor, width: Math.min(100, (100 * factors[factor.key]) / top), text: factors[factor.key] ? roundToDecimal(factors[factor.key], 2).toString() : '-', limiting: !!limiting && limiting.key === factor.key }))
    },

    infrastructureLine() {
      const species = this.shown.species
      const now = infrastructurePerMillion(this.assessment.cost.worst, species, this.assessment.cost.lowGravity)

      if (!this.plan || !this.assessment.after) {
        return `${now} per million people`
      }

      return `${now} → ${infrastructurePerMillion(this.assessment.after.worst, species, this.assessment.lowGravity)} per million people`
    },

    planSummary() {
      const total = planYears(this.assessment.work, this.terraformCapacity)

      return `${this.years(total)} with ${this.terraformCapacity > 0 ? 'the terraformers you set' : 'no terraformers'}, ${roundToDecimal(this.assessment.work, 3)} atm of Earth-equivalent work`
    },

    tiles() {
      const { target, from } = this.plan
      const { body } = this.item
      const celsius = (kelvin) => `${roundToDecimal(kelvin - 273, 1)} °C`
      const spread = (low, high) => (Math.abs(high - low) > 0.01 ? `${celsius(low)} to ${celsius(high)}` : celsius(low))
      const now = this.shown.assessment.cost.colonisable ? spread(body.SurfaceTemp, body.SurfaceTemp) : '-'

      return [
        { label: 'Pressure', from: `${roundToDecimal(from.pressure, 2)} atm`, to: `${roundToDecimal(target.pressure, 2)} atm` },
        { label: 'Breathable', from: `${roundToDecimal(from.breathable, 2)} atm`, to: `${roundToDecimal(target.breathable, 2)} atm` },
        { label: 'Temperature', from: now, to: spread(target.temperatureLow, target.temperatureHigh) },
        { label: 'Water', from: `${roundToDecimal(body.HydroExt, 1)}%`, to: `${roundToDecimal(target.hydroExt, 1)}%` },
      ]
    },

    installationOptions() {
      const perYear = this.rules.TerraformingRate * (this.rules.TerraformingSpeed / 100)

      return perYear > 0 ? INSTALLATION_YEARS.map((years) => ({ years, count: Math.max(1, Math.ceil(this.assessment.work / (perYear * years))) })) : []
    },
    rates() {
      const { TerraformingRate, TerraformingSpeed } = this.rules

      return `Each moves ${TerraformingRate} atm a year${TerraformingSpeed === 100 ? '' : ` at ${TerraformingSpeed}% game speed`}, before commander and colony modifiers.`
    },

    noPlanText() {
      if (this.assessment.outcome === 'done') {
        return 'Already liveable for this species: nothing to terraform.'
      }

      return `${this.assessment.reason || 'No plan.'}${this.assessment.reason ? '.' : ''}`.replace('..', '.')
    },

    deposits() {
      return [...this.item.body.Minerals]
        .map((deposit) => ({ ...deposit, name: MINERALS.find((mineral) => mineral.id === deposit.MaterialID).name }))
        .sort((a, b) => b.Accessibility * (this.ranking.weights[b.MaterialID] || 0) - a.Accessibility * (this.ranking.weights[a.MaterialID] || 0))
    },
    cmcLine() {
      const { cmcSite } = this.item.row
      const missing = [!cmcSite.populatedSystem && 'an own colony of 10 M in the system', !cmcSite.nearStar && 'a body under 80 AU from its star', !cmcSite.notBanned && 'a body that is not banned', !cmcSite.uncolonised && 'a body with no colony yet'].filter(Boolean)

      return missing.length ? `The game also needs ${missing.join(', ')}.` : 'It meets the game\'s other conditions.'
    },
  },
  methods: {
    people,
    round: roundToDecimal,
    cost(value) {
      return value === null || value === undefined ? 'N/A' : roundToDecimal(value, 2).toString()
    },
    swing(cost) {
      return Math.abs(cost.periapsis - cost.current) > 0.005 || Math.abs(cost.apoapsis - cost.current) > 0.005
    },
    tons(value) {
      return compact(value)
    },
    years(value) {
      return value === 0 ? 'no time' : !Number.isFinite(value) ? 'forever without terraformers' : value < 0.1 ? 'under 0.1 years' : `${separatedNumber(roundToDecimal(value, value < 10 ? 2 : 1), this.separator)} years`
    },
    stepYears(step) {
      return planYears(step.work, this.terraformCapacity)
    },
    copy(value) {
      const text = `${roundToDecimal(Number.isFinite(value) ? value : 0, 3)}`

      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {})
      }
    },
  },
}
</script>

<style lang="scss">
.body-detail {
  .factor {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    line-height: 22px;
  }

  .factor-label {
    width: 96px;
    flex: none;
  }

  .factor-bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.25);
    overflow: hidden;

    i {
      display: block;
      height: 100%;
      background: rgba(128, 128, 128, 0.7);
    }
  }

  .factor-limit {
    font-weight: 500;

    .factor-bar i {
      background: var(--sc, #1baf7a);
    }
  }

  .factor-value {
    width: 36px;
    text-align: right;
    flex: none;
  }

  .blueprint {
    background: transparent;
  }

  .target-value {
    display: inline-flex;
    align-items: center;
    font-weight: 500;
  }

  .target-copy-btn {
    margin-left: 4px;
    height: 20px;
    width: 20px;
    min-width: 20px;
  }
}
</style>
