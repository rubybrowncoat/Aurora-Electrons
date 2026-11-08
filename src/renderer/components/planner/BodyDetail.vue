<template>
  <div class="body-detail">
    <div class="d-flex align-center mb-3">
      <v-chip small label :color="tone(item.row.state.color)" :dark="item.row.state.target" :outlined="!item.row.state.target" class="mr-3 flex-none"><v-icon x-small left>{{ item.row.state.icon }}</v-icon>{{ item.row.state.label }}</v-chip>
      <span class="text--secondary">{{ item.row.state.text(item.row.facts) }}</span>
    </div>
    <div class="d-flex align-center flex-wrap mb-3">
      <span class="caption text--secondary mr-3">Species</span>
      <v-btn-toggle :value="shown.species.SpeciesID" mandatory dense @change="(id) => $emit('species', id)">
        <v-btn v-for="evaluation in speciesOptions" :key="evaluation.species.SpeciesID" :value="evaluation.species.SpeciesID" small>
          {{ evaluation.species.SpeciesName }}
          <v-icon v-if="evaluation.species.SpeciesID === item.best.species.SpeciesID && item.best.strategy !== 'none'" x-small right title="Best for the goal">mdi-star</v-icon>
        </v-btn>
      </v-btn-toggle>
      <v-chip v-if="assessment.cost.colonisable" small label class="ml-3" :color="tone(outcome.color)" outlined>{{ plan ? `Terraformed: ${outcome.label}` : outcome.label }}</v-chip>
      <span v-if="assessment.cost.colonisable" class="caption text--secondary ml-2">{{ outcome.description }}</span>
    </div>

    <v-alert v-if="shown.missing.length" type="warning" outlined dense class="mb-0">Not worked out for {{ shown.species.SpeciesName }}: {{ shown.missing.join(', ') }} missing from the save, so the colony cost, the plan and what the body holds are unknown.<provenance-mark :result="missingResult" /></v-alert>

    <v-alert v-else-if="!assessment.cost.colonisable" type="error" outlined dense class="mb-0">{{ shown.species.SpeciesName }} can't live on this body: {{ reasonText }}.</v-alert>

    <v-row v-else>
      <v-col cols="12" md="4">
        <v-card outlined class="pa-3 mb-3">
          <div class="overline">Colony cost</div>
          <div class="headline" data-detail="cost">
            <template v-if="plan"><span class="text--secondary">{{ cost(assessment.cost.worst) }}</span> → {{ cost(assessment.after.worst) }}</template>
            <template v-else>{{ cost(assessment.cost.worst) }}</template>
            <span v-if="assessment.gravityClass" class="caption" :title="gravityText(assessment.gravityClass)" data-detail="gravity-class">{{ assessment.gravityClass }}</span>
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

        <v-card outlined class="pa-3 mb-3">
          <div class="overline">What it holds</div>
          <div class="headline" data-detail="capacity">
            <template v-if="plan && afterCapacity !== null && Math.abs(afterCapacity - shown.capacityNow) > 0.005"><span class="text--secondary">{{ people(shown.capacityNow) }}</span> → {{ people(afterCapacity) }}</template>
            <template v-else>{{ people(shown.capacityNow) }}</template>
          </div>
          <div class="caption text--secondary">Infrastructure: {{ infrastructureLine }}. Growth slows past a third of the capacity.</div>
        </v-card>

        <v-card outlined class="pa-3">
          <div class="overline">Why it ranks here</div>
          <template v-if="why">
            <div class="why-line"><span>People</span><span>{{ why.people }}</span></div>
            <div class="why-line"><span>Deposits</span><span>{{ why.mining }}</span></div>
            <div class="why-line why-total"><span>Prize for the goal</span><span>{{ why.prize }}</span></div>
            <div class="why-line"><span>× colony cost {{ cost(shown.raw) }}</span><span>{{ why.cost }}</span></div>
            <div class="why-line"><span>× {{ time(shown.years, shown.yearsBasis) }} to terraform</span><span>{{ why.time }}</span></div>
            <div class="why-line"><span>× {{ distanceText }}</span><span>{{ why.distance }}</span></div>
            <div class="caption text--secondary mt-1">{{ rankText }}</div>
          </template>
          <div v-else class="caption text--secondary">No species of the race can live here, so there is nothing to rank.</div>
        </v-card>
      </v-col>

      <v-col cols="12" md="8">
        <template v-if="plan">
          <div class="d-flex align-baseline flex-wrap">
            <h3 class="mr-3">Terraforming blueprint</h3>
            <span class="caption text--secondary">{{ planSummary }}</span>
          </div>
          <div v-if="minimumTime" class="caption text--secondary mb-1" data-detail="minimum-time">{{ minimumTimeNote }}</div>
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
                <v-list-item-subtitle :class="{ 'text-wrap': step.drained > 0 }">From {{ round(step.from, 3) }}<template v-if="step.drained > 0">, draining {{ round(step.drained, 1) }}% of the surface water with it</template>, {{ stepTime(step) }}.</v-list-item-subtitle>
                <div v-if="step.lever" class="caption text--secondary text-wrap" data-detail="lever">{{ leverNote(step) }}</div>
              </v-list-item-content>
            </v-list-item>
            <v-list-item v-if="plan.settling.years > 0.1" two-line>
              <v-list-item-content>
                <v-list-item-title class="text-wrap">Then wait for the surface to settle</v-list-item-title>
                <v-list-item-subtitle>About {{ years(plan.settling.years) }} for natural {{ plan.settling.process === 'Evaporate' ? 'evaporation' : 'condensation' }} to bring the water to {{ round(plan.target.hydroExt, 1) }}%.</v-list-item-subtitle>
                <div v-if="settleLever" class="caption text--secondary text-wrap" data-detail="lever">{{ settleLever }}</div>
              </v-list-item-content>
            </v-list-item>
          </v-list>
          <div v-if="plan.partial" class="caption text--secondary mt-1">A temperature limitation remains after this plan.</div>
          <div v-if="plan.dampening" class="caption text--secondary mt-1" data-detail="dampening">{{ dampeningNote }}</div>

          <div class="overline mt-3">What limits the colony cost at each stage</div>
          <v-simple-table dense class="limit-table" data-limits="table">
            <thead>
              <tr>
                <th>Stage</th>
                <th class="text-right">Colony cost</th>
                <th>Limits the cost</th>
                <th>Next limit</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in stageRows" :key="row.key" data-limits="stage">
                <td>{{ row.title }}<div v-if="row.change" class="caption text--secondary">{{ row.change }}</div></td>
                <td class="text-right text-no-wrap">{{ row.cost }}<provenance-mark :result="row.result" /></td>
                <td>
                  <v-chip v-for="entry in row.limiting" :key="entry.key" x-small label outlined class="mr-1 my-1" :title="entry.title" data-limits="limiting"><v-icon v-if="entry.fixed" x-small left>mdi-lock-outline</v-icon>{{ entry.text }}</v-chip>
                  <span v-if="!row.limiting.length" class="text--secondary">None</span>
                </td>
                <td>
                  <v-chip v-for="entry in row.next" :key="entry.key" x-small label outlined class="mr-1 my-1" :title="entry.title" data-limits="next"><v-icon v-if="entry.fixed" x-small left>mdi-lock-outline</v-icon>{{ entry.text }}</v-chip>
                  <span v-if="!row.next.length" class="text--secondary">None</span>
                </td>
              </tr>
            </tbody>
          </v-simple-table>
          <div v-for="note in limitNotes" :key="note" class="caption text--secondary mt-1">{{ note }}</div>

          <v-row dense class="mt-2">
            <v-col v-for="tile in tiles" :key="tile.label" cols="6" sm="3">
              <v-card outlined class="pa-3">
                <div class="overline">{{ tile.label }}</div>
                <div class="subtitle-1 text-no-wrap">{{ tile.to }}</div>
                <div class="caption text--secondary text-no-wrap">From {{ tile.from }}</div>
              </v-card>
            </v-col>
          </v-row>

          <div class="overline mt-3">{{ installationsTitle }}</div>
          <div class="d-flex flex-wrap installation-times">
            <span v-for="option in installationOptions" :key="option.years" class="mr-6 text-no-wrap"><b>{{ option.count }}</b> in {{ option.years }} y</span>
            <span class="text--secondary">{{ rates }}</span>
          </div>
        </template>
        <div v-else class="text--secondary">
          <h3 class="text--primary">Terraforming</h3>
          <div class="mt-1">{{ noPlanText }}</div>
        </div>

        <template v-if="ownColonies.length">
          <div class="overline mt-3">The race's colonies on this body</div>
          <div v-for="colony in ownColonies" :key="colony.id" class="mt-2">
            <div class="font-weight-medium">{{ colony.name }}<template v-if="plan"><provenance-mark :result="colony.result" /> <span class="text--secondary">{{ colony.yearsText }}</span></template></div>
            <template v-if="plan">
              <div v-for="line in colony.lines" :key="line.key" class="d-flex justify-space-between caption"><span class="mr-4">{{ line.label }}</span><span>{{ line.text }}</span></div>
            </template>
            <template v-if="colony.oneYear">
              <div v-for="line in colony.oneYear.lines" :key="line.key" class="d-flex justify-space-between caption" data-detail="one-year"><span class="mr-4">{{ line.label }}<provenance-mark v-if="line.result" :result="line.result" /></span><span>{{ line.text }}</span></div>
            </template>
          </div>
        </template>

        <div class="overline mt-4 d-flex align-center">
          Minerals
          <page-link v-if="deposits.length" class="ml-2" :to="mineralsLink" :name="bodyName" />
        </div>
        <div v-if="!item.row.minerals.surveyed" class="text--secondary">Not surveyed by the race yet. Ground survey potential: {{ groundSurvey }}.</div>
        <div v-else-if="!deposits.length" class="text--secondary">The survey found nothing on this body.</div>
        <div v-else class="d-flex flex-wrap">
          <v-chip v-for="deposit in deposits" :key="deposit.id" small label outlined class="mr-2 mb-2" :class="{ 'text--disabled': deposit.value !== null && deposit.value <= 0 }">
            <b class="mr-1">{{ deposit.name }}</b> {{ tons(deposit.amount) }} · {{ figure(deposit.accessibility, 2) }} → {{ figure(deposit.value, 1) }}<provenance-mark v-if="deposit.value === null" :result="unknownResult(deposit)" /><span v-if="deposit.scarcity && deposit.scarcity.factor > 1" class="ml-1 scarce">×{{ deposit.scarcity.factor }} {{ deposit.scarcity.label.toLowerCase() }}</span>
          </v-chip>
        </div>
        <div v-if="item.row.minerals.cmc.length" class="caption text--secondary">Civilian mining complex candidate ({{ item.row.minerals.cmc.join(', ') }}). {{ cmcLine }}</div>
        <div v-if="item.row.minerals.deposits" class="caption text--secondary">Deposit value {{ figure(item.row.minerals.value, 1) }}<provenance-mark v-if="item.row.minerals.value === null" :result="mineralsResult" />: each deposit's accessibility (raised for a big one, halved under 10 kt), times its weight and how short the race is of the mineral. {{ item.row.minerals.rich ? 'Rich: ' : '' }}The game seeds a mining colony from 6.</div>
        <div v-if="item.row.distance" class="caption text--secondary mt-1">{{ distanceLine }}</div>
      </v-col>
    </v-row>
  </div>
</template>

<script>
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import { activeAppearance, toneColor } from '../../utilities/appearance'
import { systemBodyName } from '../../utilities/aurora'
import { linkTo } from '../../utilities/deep-links'
import { FACTORS, GRAVITY_CLASSES, infrastructurePerMillion, limitingFactors } from '../../utilities/habitability'
import { people } from '../../utilities/colonies'
import { cmcNote, rowProvenance } from '../../utilities/colonization'
import { rangeFigure, rangeText, roundToDecimal, separatedNumber } from '../../utilities/math'
import { compact } from '../../utilities/minerals'
import { isAvailable, unavailable, valueOrNull } from '../../utilities/provenance'
import { NO_TERRAFORM_SOURCES, hasTerraformers, oneYearEstimate, terraformBreakdown } from '../../utilities/terraform-capacity'
import { LEVER, MINIMUM_TIME_NOTE, OUTCOMES, TIME_BASIS, planYears, stepTimeBasis, timeWords } from '../../utilities/terraforming'
import { terraformStages } from '../../utilities/terraform-limits'

const GROUND_SURVEY = { 0: 'completed', 1: 'minimal', 2: 'low', 3: 'good', 4: 'high', 5: 'excellent' }
const INSTALLATION_YEARS = [5, 10, 25, 50]
// What the stages say of a drain: they show its end state, and no date for it.
const DRAIN_STAGE_NOTE = 'The stages after a drain show it complete. It completes no earlier than its minimum time, and no stage is dated.'
// What each dampening lever is called where a stage names it.
const LEVER_WORDS = { [LEVER.WATER]: 'surface water', [LEVER.PRESSURE]: 'pressure' }
// The temperature a stage shows, in the degrees Celsius the species' range is given in.
const degrees = (kelvin) => roundToDecimal(kelvin - 273, 1)
// A temperature as a range figure, the unit beside it and the sign it reads with, so that a range writes the unit once.
const temperatureFigure = (kelvin) => rangeFigure(degrees(kelvin), { unit: ' °C', negative: kelvin - 273 < 0 })
// A range of temperatures, the unit once after the second figure.
const temperatureRange = (from, to) => rangeText(from, to, { format: (kelvin) => temperatureFigure(kelvin) })

export default {
  name: 'BodyDetail',
  components: { PageLink, ProvenanceMark },
  props: {
    item: { type: Object, required: true },
    shown: { type: Object, required: true },
    speciesOptions: { type: Array, required: true },
    terraformCapacity: { type: Number, required: true },
    gases: { type: Array, default: () => [] },
    terraformSources: { type: Object, default: () => NO_TERRAFORM_SOURCES },
    navalAdmins: { type: Object, default: () => ({}) },
    rules: { type: Object, required: true },
    separator: { type: String, default: "'" },
  },
  computed: {
    assessment() {
      return this.shown.assessment
    },
    plan() {
      return this.assessment.plan
    },
    outcome() {
      const outcome = OUTCOMES[this.assessment.outcome]

      return !this.plan && !['done', 'no'].includes(this.assessment.outcome) ? { ...outcome, description: 'The body stays as it is.' } : outcome
    },
    afterCapacity() {
      return this.shown.capacityAfter
    },
    // What is missing for the species shown, as a result for the mark in the unavailable notice.
    missingResult() {
      return unavailable({ rule: 'habitability.colonyCost', missing: this.shown.missing })
    },
    reasonText() {
      return (this.assessment.reason || this.assessment.cost.reason || 'no reason recorded').toLowerCase()
    },
    mineralsResult() {
      return rowProvenance(this.item.row).minerals
    },
    groundSurvey() {
      return GROUND_SURVEY[this.item.body.GroundMineralSurvey] || 'unknown'
    },

    mineralsLink() {
      return linkTo.minerals({ bodies: [this.item.body] })
    },
    bodyName() {
      return `${this.item.body.SystemName} ${systemBodyName(this.item.body)}`
    },

    factors() {
      const { factors } = this.assessment.cost
      const limiting = new Set(limitingFactors(factors).map((factor) => factor.key))
      const top = Math.max(2, ...FACTORS.map((factor) => factors[factor.key]))

      return FACTORS.map((factor) => ({ ...factor, width: Math.min(100, (100 * factors[factor.key]) / top), text: factors[factor.key] ? roundToDecimal(factors[factor.key], 2).toString() : '-', limiting: limiting.has(factor.key) }))
    },

    gasInfo() {
      const byId = new Map(this.gases.map((gas) => [gas.GasID, gas]))

      return (id) => byId.get(id)
    },

    // The plan's stages with what limits the colony cost at each, null without a plan.
    limits() {
      return this.plan ? terraformStages({ assessment: this.assessment, body: this.item.body, species: this.shown.species, skill: this.rules.ColonizationSkill, gasInfo: this.gasInfo }) : null
    },

    stageRows() {
      if (!this.limits) {
        return []
      }

      const at = { current: 'now', periapsis: 'at periapsis', apoapsis: 'at apoapsis' }
      const names = (list) => list.map((key) => (FACTORS.find((factor) => factor.key === key) || { label: key }).label).join(', ')
      const entries = (list, swings) => list.map((entry) => ({ ...entry, text: `${entry.label} ${roundToDecimal(entry.value, 2)}${swings ? ` ${entry.at.map((point) => at[point]).join(' and ')}` : ''}`, title: entry.fixed ? 'Fixed: no gas operation changes it.' : '' }))

      return this.limits.stages.map((stage) => {
        const swings = stage.points.periapsis !== stage.points.current
        const changes = [this.leverText(stage), stage.cleared.length ? `Clears ${names(stage.cleared)}.` : '', stage.overtaken.length ? `${names(stage.overtaken)} no longer set the cost, but stay.` : '', stage.revealed.length ? `Reveals ${names(stage.revealed)}.` : '', stage.blocked ? 'Only a fixed factor remains: no gas operation lowers the cost further.' : ''].filter(Boolean)

        return {
          key: stage.index,
          title: stage.kind === 'start' ? 'As it is' : stage.kind === 'settle' ? 'The surface settles' : stage.kind === 'target' ? 'The plan\'s end state, with no gas operation' : `Set ${stage.step.label} to ${roundToDecimal(stage.step.set, 3)} atm`,
          change: changes.join(' '),
          cost: this.cost(stage.cost.worst),
          result: stage.result,
          limiting: entries(stage.limiting, swings),
          next: entries(stage.next, swings),
        }
      })
    },

    limitNotes() {
      if (!this.limits) {
        return []
      }

      return [
        ...(this.limits.lowGravity ? [`Gravity below the species' minimum is fixed: no gas operation removes it, so the colony cost can't fall under ${this.cost(this.limits.floorWorst)} on this body (1 before the colonisation skill).`] : []),
        ...(this.limits.tidalLock ? ['A tidally locked body has its temperature factor divided by 5, and that stays whatever the atmosphere.'] : []),
        'Stages after the first are the plan\'s estimate: each gas operation completes in the plan\'s order. A drain changes the surface water inside its operation; later stages inherit that water and its dampening. Other condensation or evaporation settles at the end.',
        ...(this.minimumTime ? [DRAIN_STAGE_NOTE] : []),
        ...(this.assessment.reason ? [this.assessment.reason] : []),
      ]
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
      const total = this.time(planYears(this.assessment.work, this.terraformCapacity), this.assessment.timeBasis)

      return `${total} with ${this.terraformCapacity > 0 ? 'the terraformers set by the race' : 'no terraformers'}, ${roundToDecimal(this.assessment.work, 3)} atm of Earth-equivalent work`
    },
    // Whether the plan's years are a minimum: it drains surface water, and the evaporation that limits the drain is not modelled.
    minimumTime() {
      return this.assessment.timeBasis === TIME_BASIS.MINIMUM
    },
    minimumTimeNote() {
      return MINIMUM_TIME_NOTE
    },
    // The installations are counted for the work, which a drain's evaporation can keep longer than any number of them.
    installationsTitle() {
      return this.minimumTime ? 'Installations to move the work within' : 'Installations to finish within'
    },

    tiles() {
      const { target, from } = this.plan
      const { body } = this.item
      const now = this.shown.assessment.cost.colonisable ? temperatureRange(body.SurfaceTemp, body.SurfaceTemp) : '-'

      return [
        { label: 'Pressure', from: `${roundToDecimal(from.pressure, 2)} atm`, to: `${roundToDecimal(target.pressure, 2)} atm` },
        { label: 'Breathable', from: `${roundToDecimal(from.breathable, 2)} atm`, to: `${roundToDecimal(target.breathable, 2)} atm` },
        { label: 'Temperature', from: now, to: temperatureRange(target.temperatureLow, target.temperatureHigh) },
        { label: 'Water', from: `${roundToDecimal(body.HydroExt, 1)}%`, to: `${roundToDecimal(target.hydroExt, 1)}%` },
      ]
    },

    installationOptions() {
      const perYear = this.rules.TerraformingRate * (this.rules.TerraformingSpeed / 100)

      return perYear > 0 ? INSTALLATION_YEARS.map((years) => ({ years, count: Math.max(1, Math.ceil(this.assessment.work / (perYear * years))) })) : []
    },
    rates() {
      const { TerraformingRate, TerraformingSpeed } = this.rules
      const base = `Each moves ${TerraformingRate} atm a year${TerraformingSpeed === 100 ? '' : ` at ${TerraformingSpeed}% game speed`}, before commander and colony modifiers.`

      return this.ownColonies.length ? `${base} The race's colonies on this body are broken down below.` : base
    },
    // The race's own colonies on the body that terraform, each with what its capacity is made of and the years this plan takes at it (the figures of the Production recap).
    ownColonies() {
      const { raceRate, speed, colonies } = this.terraformSources
      const has = (population) => colonies[population.PopulationID] && hasTerraformers(colonies[population.PopulationID])

      return this.item.body.OwnPopulations.filter(has).map((population) => {
        const source = colonies[population.PopulationID]
        const breakdown = terraformBreakdown({ raceRate, speed, source, admins: this.navalAdmins })
        const capacity = valueOrNull(breakdown.capacity)

        return { id: population.PopulationID, name: source.PopName, lines: breakdown.lines, oneYear: this.oneYearLines(breakdown.rate), result: breakdown.capacity, yearsText: capacity === null ? 'time not known' : `${this.time(planYears(this.assessment.work, capacity), this.assessment.timeBasis)} for this plan` }
      })
    },

    // What the whole plan does to the swing of an eccentric orbit, said once under the steps when a dampening lever is in it.
    dampeningNote() {
      const { limits, plan } = this

      if (!limits || !plan || !plan.dampening) {
        return ''
      }

      const first = limits.stages[0]
      const last = limits.stages[limits.stages.length - 1]
      const levers = plan.dampening.levers.map((lever) => LEVER_WORDS[lever]).join(' and ')

      return `The greenhouse and anti-greenhouse gases alone leave an extreme of this orbit outside the species' range, so the plan also raises the dampening of the seasons with ${levers}: the dampening goes from ${roundToDecimal(first.dampening * 100, 1)}% to ${roundToDecimal(last.dampening * 100, 1)}%, the temperature at periapsis from ${degrees(first.extremes.periapsis)} to ${degrees(last.extremes.periapsis)} °C and at apoapsis from ${degrees(first.extremes.apoapsis)} to ${degrees(last.extremes.apoapsis)} °C.`
    },

    // What the end stage says of a water lever: the surface gains the water as the added vapour settles.
    settleLever() {
      const end = this.limits && this.limits.stages[this.limits.stages.length - 1]

      return end && !end.step ? this.leverText(end) : ''
    },

    noPlanText() {
      if (this.assessment.outcome === 'done') {
        return 'Already liveable for this species: nothing to terraform.'
      }

      return `${this.assessment.reason || 'No plan.'}${this.assessment.reason ? '.' : ''}`.replace('..', '.')
    },

    deposits() {
      return this.item.row.minerals.lines
    },
    why() {
      const { parts } = this.shown

      if (!parts) {
        return null
      }

      const fixed = (value) => (value === null ? '—' : roundToDecimal(value, 2).toString())

      return { people: fixed(parts.people), mining: fixed(parts.mining), prize: fixed(parts.prize), cost: fixed(parts.cost), time: fixed(parts.time), distance: fixed(parts.distance) }
    },
    distanceText() {
      const { distance } = this.item.row

      return distance ? `${roundToDecimal(distance.au, 1)} AU from the nearest colony` : 'no charted route'
    },
    rankText() {
      const { row } = this.item
      const score = row.score === null || !(this.item.best.value > 0) ? '' : ` ${roundToDecimal((this.shown.value * row.score) / this.item.best.value, 0)}% of the best target's worth.`

      if (this.shown.mineralsUnknown) {
        return `Worth is not worked out for ${this.shown.species.SpeciesName}: deposit figures are missing from the save.${row.rank ? ` Rank ${row.rank}.` : ''}`
      }

      return `Worth ${roundToDecimal(this.shown.value, 3)} for ${this.shown.species.SpeciesName}${this.shown.strategy === 'terraform' ? ' after terraforming' : ', settled as it is'}.${this.shown.strategy === 'terraform' && this.shown.yearsBasis === TIME_BASIS.MINIMUM ? ' The terraforming time is a minimum, so the worth is the most the plan can earn.' : ''}${row.rank ? ` Rank ${row.rank}.` : ''}${score}`
    },
    distanceLine() {
      const { distance, capitalDistance } = this.item.row
      const jumps = (count) => `${count} ${count === 1 ? 'jump' : 'jumps'}`
      const from = distance.from ? distance.from.PopName.replace(/<[^>]*>/g, '') : 'the nearest colony'
      const capital = capitalDistance && !(distance.from && distance.from.Capital) ? ` The capital is ${roundToDecimal(capitalDistance.au, 1)} AU and ${jumps(capitalDistance.jumps)} away.` : ''

      return `${roundToDecimal(distance.au, 1)} AU from ${from} over ${jumps(distance.jumps)}, by the charted route.${capital}`
    },
    cmcLine() {
      return cmcNote(this.item.row.cmcSite)
    },
  },
  methods: {
    people,
    // What a gravity class (LG, LGR or N) says.
    gravityText(name) {
      return GRAVITY_CLASSES[name]
    },
    // The colour of a plan state's or outcome's tone under the appearance in force.
    tone(name) {
      return toneColor(activeAppearance(), name)
    },
    round: roundToDecimal,
    // The two lines the game's Environment tab gives a terraforming colony: the temperature of the body now and what a year of Aestusium or of Frigusium would make it, null where the colony moves no pressure.
    oneYearLines(rate) {
      const result = oneYearEstimate(this.item.body, rate)

      if (!result) {
        return null
      }

      if (!isAvailable(result)) {
        return { lines: [{ key: 'oneYear', label: 'Temperature after a year of terraforming', text: 'not known', result }] }
      }

      const { current, aestusium, frigusium } = result.value
      const gas = (entry) => ({ key: entry.label, label: entry.label, text: `${roundToDecimal(entry.temperature, 1)} K (${entry.text})` })

      return { lines: [{ key: 'oneYearNow', label: 'Surface temperature now', text: `${roundToDecimal(current, 1)} K (${degrees(current)} °C)`, result }, gas(aestusium), gas(frigusium)] }
    },
    // What a stage says of the dampening lever it pulls and its effect on both extremes, or nothing for a stage with none.
    leverText(stage) {
      if (!stage.lever) {
        return ''
      }

      if (stage.step && stage.lever === LEVER.WATER) {
        return 'Adds the vapour that condenses into the extra surface water.'
      }

      const { effect } = stage
      const range = (swing) => `${degrees(swing.from)} to ${degrees(swing.to)} °C`

      return `Raises the dampening by ${LEVER_WORDS[stage.lever]}: from ${roundToDecimal(effect.dampening.from * 100, 1)}% to ${roundToDecimal(effect.dampening.to * 100, 1)}%, periapsis from ${range(effect.periapsis)}, apoapsis from ${range(effect.apoapsis)}.`
    },
    // What a plan step says of its lever, found as the stage that carries the step.
    leverNote(step) {
      const stage = this.limits && this.limits.stages.find((entry) => entry.step === step)

      return stage ? this.leverText(stage) : ''
    },
    cost(value) {
      return value === null || value === undefined ? 'N/A' : roundToDecimal(value, 2).toString()
    },
    swing(cost) {
      return Math.abs(cost.periapsis - cost.current) > 0.005 || Math.abs(cost.apoapsis - cost.current) > 0.005
    },
    tons(value) {
      return Number.isFinite(value) ? compact(value) : '—'
    },
    figure(value, places) {
      return Number.isFinite(value) ? roundToDecimal(value, places) : '—'
    },
    unknownResult(deposit) {
      return isAvailable(deposit.baseResult) ? deposit.scarcityResult : deposit.baseResult
    },
    years(value) {
      return value === 0 ? 'no time' : !Number.isFinite(value) ? 'forever without terraformers' : value < 0.1 ? 'under 0.1 years' : `${separatedNumber(roundToDecimal(value, value < 10 ? 2 : 1), this.separator)} years`
    },
    // The years of a time of `basis`, a minimum worded as one (`timeWords`), at the decimals `years` shows: a bound floored there never reads above itself.
    time(value, basis) {
      return timeWords(value, basis, this.years, value < 10 ? 2 : 1)
    },
    stepYears(step) {
      return planYears(step.work, this.terraformCapacity)
    },
    // What a step takes: about its years, or for a drain at least them, which the evaporation of the surface water can exceed.
    stepTime(step) {
      const value = this.stepYears(step)

      return stepTimeBasis(step) === TIME_BASIS.MINIMUM ? `${this.time(value, TIME_BASIS.MINIMUM)}${Number.isFinite(value) ? ', and longer where the surface water evaporates slowly' : ''}` : `about ${this.years(value)}`
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
    font-size: calc(12px * var(--ae-font-scale));
    line-height: calc(22px * var(--ae-font-scale));
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
      background: var(--sc);
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

  .why-line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: calc(13px * var(--ae-font-scale));
    line-height: calc(22px * var(--ae-font-scale));
    font-variant-numeric: tabular-nums;
  }

  .why-total {
    border-top: 1px solid rgba(128, 128, 128, 0.35);
    font-weight: 500;
  }

  .scarce {
    font-weight: 500;
    color: var(--sc-text);
  }

  .flex-none {
    flex: none;
  }

  .target-copy-btn {
    margin-left: 4px;
    height: 20px;
    width: 20px;
    min-width: 20px;
  }
}
</style>
