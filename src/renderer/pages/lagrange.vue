<template>
  <div>
    <v-container fluid class="lagrange-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" />

        <v-card class="panel" data-summary="A map of the known systems, shaded by how many stable Lagrange points each has. Use it to see where the ships can already jump between points and where more would help." elevation="1">
          <div class="panel-head">
            <span>Lagrange map<provenance-mark rule="lagrange.pointCounts" /></span>
            <span class="legend">
              <span v-for="item in mapLegend" :key="item.key" class="legend-item"><span class="dot" :style="{ background: item.color }" />{{ item.label }}</span>
              <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Colonies</span>
            </span>
          </div>
          <div class="panel-body">
            <system-map :systems="mapNodes" :links="links" :selected="selectedSystemId" aria-label="Known systems coloured by their stable Lagrange points" @select="selectSystem" />
            <div class="caption text--secondary">Positions as on the game's galactic map. Click a system to list its planets and moons below. Dot size and colour step with the number of stable points, a display scale.<provenance-mark rule="lagrange.mapScale" /></div>
          </div>
        </v-card>

        <v-card ref="bodiesPanel" class="panel" data-summary="The planets and moons that have, or could be given, a stable Lagrange point, and how long stabilising each would take. Use it to choose which to stabilise." elevation="1">
          <div class="panel-head">
            <span>Planets and moons<provenance-mark rule="lagrange.stabilisationDays" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-chip v-if="selectedSystem" small close @click:close="selectedSystemId = null">{{ selectedSystem.Name }}</v-chip>
              <v-btn-toggle v-model="view" mandatory dense>
                <v-btn v-for="option in viewOptions" :key="option.value" :value="option.value" small>{{ option.label }}</v-btn>
              </v-btn-toggle>
              <v-switch v-model="colonySystemsOnly" label="Systems with colonies" dense hide-details class="mt-0" />
              <v-text-field v-model="search" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <v-data-table :headers="bodyHeaders" :items="visibleBodies" item-key="SystemBodyID" :custom-sort="sortNullLast" :sort-by.sync="bodiesTable.sortBy" :sort-desc.sync="bodiesTable.sortDesc" :items-per-page.sync="bodiesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: bodyPageSizes }">
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div class="flex-grow-1">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div class="caption text--secondary">{{ item.type }}</div>
                </div>
                <page-link :to="linkTo.planner({ bodies: [item] })" :name="item.name" />
                <page-link :to="linkTo.map(item.SystemID)" :name="item.SystemName" />
              </div>
            </template>
            <template #[`item.Mass`]="{ item }">{{ mass(item.Mass) }}</template>
            <template #[`item.systemPoints`]="{ item }">
              <span class="text-no-wrap">
                {{ item.systemPoints }}
                <v-icon v-if="item.systemPoints >= 2" small :color="colors.many" title="Ships can jump between this system's Lagrange points">mdi-swap-horizontal</v-icon>
              </span>
            </template>
            <template #[`item.daysSort`]="{ item }">
              <span v-if="item.status.key === 'stable'" class="text--secondary">—</span>
              <span v-else-if="item.days !== null" class="text-no-wrap">{{ duration(item.days) }}<provenance-mark :result="item.daysResult" /></span>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.daysResult" /></span>
            </template>
            <template #[`item.statusSort`]="{ item }">
              <span class="text-no-wrap">
                <v-icon small :color="item.status.color">{{ item.status.icon }}</v-icon>
                {{ item.status.label }}
              </span>
              <div v-if="item.status.note" class="caption text--secondary">{{ item.status.note }}<provenance-mark v-if="item.timeLeft" :result="item.timeLeft" /></div>
            </template>
            <template #[`item.Colonies`]="{ item }">
              <span :class="{ 'text--secondary': !item.Colonies }">{{ item.Colonies }}</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A ship with a jump point stabilisation module takes 60 / √mass months (of 30 days) at the body, times 2 − its captain's Production bonus, and longer when under-crewed (class crew / crew aboard). In a fleet the quickest ship counts; ships don't add up. Planets and moons of 0.25 Earth masses or more qualify. {{ timesNote }} Systems are generated with a stable point at every super-jovian and every gas giant above 200 Earth masses.<provenance-mark :result="best.result" />
          </div>
        </v-card>

        <v-card v-if="shipRows.length" class="panel" data-summary="Ships with a jump point stabilisation module, their captains and crews, and what each is doing now. It shows which ship to send to stabilise a point." elevation="1">
          <div class="panel-head">
            <span>Stabilisation ships<provenance-mark rule="lagrange.stabilisationMultiplier" label /></span>
          </div>
          <v-data-table :headers="shipHeaders" :items="shipRows" item-key="ShipID" :sort-by.sync="shipsTable.sortBy" :sort-desc.sync="shipsTable.sortDesc" disable-pagination hide-default-footer>
            <template #[`item.ShipName`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div class="flex-grow-1">
                  <div class="font-weight-medium">{{ item.ShipName }}</div>
                  <div class="caption text--secondary">{{ item.ClassName }} · {{ item.FleetName }}</div>
                </div>
                <page-link :to="linkTo.routes({ from: place.fleet(item.FleetID) })" :name="item.FleetName" />
              </div>
            </template>
            <template #[`item.ProductionBonus`]="{ item }">
              <span v-if="item.CaptainName">{{ percent(item.ProductionBonus) }}<span class="caption text--secondary d-block">{{ item.CaptainName }}</span></span>
              <span v-else class="text--secondary">No captain</span>
            </template>
            <template #[`item.crew`]="{ item }">{{ whole(item.CurrentCrew) }} / {{ whole(item.ClassCrew) }}</template>
            <template #[`item.multiplierSort`]="{ item }">
              <span v-if="item.multiplier !== null" class="text-no-wrap">× {{ fixed(item.multiplier, 2) }}<provenance-mark :result="item.result" /></span>
              <span v-else class="warning--text text-no-wrap">{{ stateTexts[item.state] }}<provenance-mark :result="item.result" /></span>
            </template>
            <template #[`item.activity`]="{ item }">
              <span v-if="item.activity" class="text-no-wrap">{{ item.activity }}<provenance-mark v-if="item.timeLeft" :result="item.timeLeft" /></span>
              <span v-else class="text--secondary">No stabilisation order</span>
            </template>
          </v-data-table>
        </v-card>

        <v-card v-if="infrastructureRows.length" class="panel" data-jump-infrastructure data-summary="Each jump point the race has charted, with whether it is a gate, the stabilisation orders of its fleets and the mines, buoys and detected objects at it. Use it to see where the race holds and watches its jump points, and to open a point on the map." elevation="1">
          <div class="panel-head">
            <span>Jump point infrastructure<provenance-mark rule="jumpInfrastructure.stabilisation" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-chip v-if="selectedSystem" small close @click:close="selectedSystemId = null">{{ selectedSystem.Name }}</v-chip>
            </span>
          </div>
          <v-data-table data-jump-table :headers="infrastructureHeaders" :items="visibleInfrastructure" item-key="WarpPointID" :custom-sort="sortNullLast" :sort-by.sync="infrastructureTable.sortBy" :sort-desc.sync="infrastructureTable.sortDesc" :items-per-page.sync="infrastructureTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: bodyPageSizes }">
            <template #[`item.sortName`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div class="flex-grow-1">
                  <div class="font-weight-medium" data-jump-cell="name" :data-jump="item.WarpPointID">{{ item.name }}</div>
                  <div class="caption text--secondary" data-jump-cell="beyond" :data-jump="item.WarpPointID"><template v-if="item.beyondName">Beyond: <span data-jump-name>{{ item.beyondName }}</span></template><template v-else>{{ item.beyond }}</template></div>
                </div>
                <page-link data-jump-cell="map" :data-jump="item.WarpPointID" :to="linkTo.map(item.SystemID, item.WarpPointID)" :name="`${item.name} in ${item.systemName}`" />
              </div>
            </template>
            <template #[`item.systemName`]="{ item }"><span data-jump-cell="system" :data-jump="item.WarpPointID">{{ item.systemName }}</span></template>
            <template #[`item.gateSort`]="{ item }"><span class="text-no-wrap" data-jump-cell="gate" :data-jump="item.WarpPointID">{{ item.gateText }}</span></template>
            <template #[`item.stabilisationSort`]="{ item }">
              <span v-if="item.stabilisationText" class="text-no-wrap" data-jump-cell="stabilisation" :data-jump="item.WarpPointID">{{ item.stabilisationText }}<provenance-mark :result="item.stabilisation" /></span>
              <span v-else class="text--secondary text-no-wrap" data-jump-cell="stabilisation" :data-jump="item.WarpPointID">{{ unknownText }}<provenance-mark :result="item.stabilisation" /></span>
              <div v-if="item.fleetsText" class="caption text--secondary" data-jump-cell="fleets" :data-jump="item.WarpPointID">{{ item.fleetsText }}</div>
            </template>
            <template #[`item.minefieldsSort`]="{ item }">
              <span :class="{ 'text--secondary': item.minefieldsSort === null }" data-jump-cell="minefields" :data-jump="item.WarpPointID">{{ item.minefieldsText }}<provenance-mark :result="item.minefields" /></span>
            </template>
            <template #[`item.buoysSort`]="{ item }">
              <span :class="{ 'text--secondary': item.buoysSort === null }" data-jump-cell="buoys" :data-jump="item.WarpPointID">{{ item.buoysText }}<provenance-mark :result="item.buoys" /></span>
            </template>
            <template #[`item.probesSort`]="{ item }"><span class="text--secondary" data-jump-cell="probes" :data-jump="item.WarpPointID">{{ item.probesText }}<provenance-mark :result="item.probes" /></span></template>
            <template #[`item.detectedSort`]="{ item }">
              <span :class="{ 'text--secondary': item.detectedSort === null || item.detectedSort === 0 }" data-jump-cell="detected" :data-jump="item.WarpPointID">{{ item.detectedText }}<provenance-mark :result="item.detected" /></span>
              <div v-if="item.earlierFigure" class="caption text--secondary" data-jump-cell="earlier" :data-jump="item.WarpPointID"><span data-jump-figure>{{ item.earlierFigure }}</span> earlier {{ item.earlierNoun }}</div>
            </template>
            <template #[`footer.page-text`]="{ pageStart, pageStop, itemsLength }">{{ pageStart }}-{{ pageStop }} of <span data-jump-total>{{ itemsLength }}</span></template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Every jump point the race has charted in a system it knows. A stabilised jump point is a gate: the save records no other state, so the Gate column shows both, and a builder of none, or one the save does not give, is not recorded. Stabilisation shows only the orders of the race's own fleets; another race's work is not known, and no time left is given because the order's time has no known unit. Minefields and Buoys count the race's own stationary missile salvos within 1 km of the point, one for each salvo and not for the missiles in it; a salvo of a design with a second stage is taken as a mine. Another race's stationary salvos are known only as contacts: Detected counts those detected now, once each, and neither their kind nor any that went undetected is known, so none detected is not none there. Probes are ordinary ships that the save does not mark, so no probe count is given. {{ unknownText }} is never 0.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { chartTheme, withAlpha } from '../components/charts/theme'
import SystemMap from '../components/exploration/SystemMap.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { systemBodyName } from '../utilities/aurora'
import { crewFraction } from '../utilities/crew'
import { linkTo, place, queryId } from '../utilities/deep-links'
import { jumpLinks, loadJumpPoints } from '../utilities/jump-graph'
import { DETECTED_ZERO_TEXT, FAR_SIDE_TEXT, GATE_TEXT, infrastructureRows as readInfrastructure, loadJumpBuilders, loadJumpInfrastructure, STABILISATION_TEXT, UNKNOWN_TEXT } from '../utilities/jump-infrastructure'
import { bestStabilisation, stabilisationDays, stabilisationMultiplier, timeLeft } from '../utilities/lagrange'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { jumpPointLabel } from '../utilities/places'
import { describeResult, describeRule, unavailable, valueOrNull } from '../utilities/provenance'
import { gateGaps, loadFormulaVersion } from '../utilities/capabilities'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  colonies: 'the colonies',
  bodies: 'the planets and moons',
  ships: 'the stabilisation ships',
  jumpInfrastructure: 'the jump point infrastructure',
  jumpBuilders: 'the gate builders',
  orders: 'stabilisation orders',
  formulaVersion: 'the save\'s schema',
}
// DIM_ComponentType 'Jump Point Stabilisation', DIM_MoveAction 'Stabilise Lagrange Point', the Production bonus. The capability check confirms that the save's component type 29 and bonus 5 are those (`unverified`).
const STABILISATION_COMPONENT = 29
const STABILISE_ACTION = 217
const PRODUCTION_BONUS = 5
const STATE_TEXTS = { damaged: 'Module damaged', 'no-crew': 'No crew', bonus: 'Bonus too high', unknown: 'Crew unknown' }
const TYPES = { 2: 'Terrestrial planet', 3: 'Dwarf planet', 4: 'Gas giant', 5: 'Super-jovian' }
const VIEW_OPTIONS = [
  { value: 'candidates', label: 'To stabilise' },
  { value: 'stable', label: 'Stable' },
  { value: 'all', label: 'All' },
]
const BODY_PAGE_SIZES = [15, 30, -1]

export default {
  name: 'LagrangePage',
  components: { LoadState, PageLink, ProvenanceMark, StatTiles, SystemMap },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      view: { key: 'lagrangeView', default: 'candidates', valid: oneOf(VIEW_OPTIONS.map((option) => option.value)) },
      colonySystemsOnly: { key: 'lagrangeColonySystemsOnly', default: false },
      search: { key: 'lagrangeSearch', default: '', scope: 'race' },
      bodiesTable: tableView('lagrangeBodiesTable', { sortBy: ['daysSort'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: BODY_PAGE_SIZES }),
      shipsTable: tableView('lagrangeShipsTable', {}),
      infrastructureTable: tableView('lagrangeInfrastructureTable', { sortBy: ['sortName'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: BODY_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      selectedSystemId: null,
      viewOptions: VIEW_OPTIONS,
      stateTexts: STATE_TEXTS,
      bodyPageSizes: BODY_PAGE_SIZES,
      linkTo,
      unknownText: UNKNOWN_TEXT,
      place,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    colors() {
      const [blue, , green] = this.theme.categorical

      return { none: withAlpha(this.theme.inkMuted, 0.45), one: blue, many: green }
    },

    mapLegend() {
      return [
        { key: 'many', label: 'Two or more: ships jump between them', color: this.colors.many },
        { key: 'one', label: 'One stable point', color: this.colors.one },
        { key: 'none', label: 'None', color: this.colors.none },
      ]
    },

    links() {
      return jumpLinks(this.jumpPoints)
    },

    coloniesBySystem() {
      return Object.fromEntries(this.colonies.map((row) => [row.SystemID, row.Colonies]))
    },

    // Body names straight from the read: the ship rows name the body an order is for, so they mustn't depend on bodyRows, which times stabilisations with the best ship.
    bodyNames() {
      return Object.fromEntries(this.bodies.map((body) => [body.SystemBodyID, systemBodyName(body, { Name: body.SystemName })]))
    },

    // Every ship that carries a stabilisation module: its multiplier on the time as a result, and the state that says why it has none (`stabilisationMultiplier`).
    shipRows() {
      const { orders, formulaVersion } = this

      return this.ships.map((ship) => {
        const { state, result } = stabilisationMultiplier(ship, formulaVersion)
        const multiplier = valueOrNull(result)
        const order = orders.find((candidate) => candidate.FleetID === ship.FleetID)
        const left = order && order.Arrived ? timeLeft(order.TimeRequired) : null

        return {
          ...ship,
          crew: ship.ClassCrew > 0 && Number.isFinite(ship.CurrentCrew) ? ship.CurrentCrew / ship.ClassCrew : crewFraction(ship),
          state,
          result,
          multiplier,
          multiplierSort: multiplier,
          timeLeft: left,
          activity: order ? this.orderText(order, left) : null,
        }
      })
    },

    // What the save's lookup rows leave unconfirmed of the two IDs this page reads (component type 29, Jump Point Stabilisation, and the Production bonus, 5), from the capability check (store/capabilities.js): [] when both read as expected, one text while the check has not answered for the copy now open.
    unverified() {
      return gateGaps(this.$store.getters['capabilities/gates'], { bonuses: [PRODUCTION_BONUS], components: [STABILISATION_COMPONENT] })
    },

    // The columns of the stabilisation ships' read the save lacks (the report's optional 'ships' input): the map and the saved points do not need them, so only the ships go without.
    missingShipFields() {
      const report = this.$store.getters['capabilities/report']('/lagrange')
      const entry = report && report.degraded.find((degraded) => degraded.key === 'ships')

      return entry ? entry.fields : []
    },

    // Why the stabilisation ships and every figure built on them are left out: the unconfirmed lookup rows and the missing columns of the ships' read.
    withheld() {
      return [...this.unverified, ...this.missingShipFields.map((field) => `the save lacks ${field}`)]
    },

    // The quickest usable ship (`ship`, a ship row) and the multiplier the times use (`result`, unavailable when no ship can time a stabilisation).
    best() {
      return this.withheld.length ? { ship: null, result: unavailable({ rule: 'lagrange.stabilisationMultiplier', missing: this.withheld }) } : bestStabilisation(this.shipRows)
    },

    bestShip() {
      return this.best.ship
    },

    timesNote() {
      const { bestShip } = this

      return bestShip ? `Times here use ${bestShip.ShipName} (× ${this.fixed(bestShip.multiplier, 2)}) and leave out the trip there.` : `No time is given: ${this.best.result.inputs.missing.join(', ')} ${this.best.result.inputs.missing.length > 1 ? 'are' : 'is'} needed.`
    },

    pointsBySystem() {
      const counts = {}

      this.bodies.forEach((body) => {
        if (body.LagrangePointID) {
          counts[body.SystemID] = (counts[body.SystemID] || 0) + 1
        }
      })

      return counts
    },

    // Computed values are read once, outside the loop: each read inside it would subscribe this property to every dependency of theirs again.
    bodyRows() {
      const { best, orders, pointsBySystem, coloniesBySystem, bodyNames } = this

      return this.bodies.map((body) => {
        const order = orders.find((candidate) => candidate.SystemBodyID === body.SystemBodyID)
        const stable = Boolean(body.LagrangePointID)
        const daysResult = stable ? null : stabilisationDays(body.Mass, best.result)
        const days = valueOrNull(daysResult)
        const left = order && order.Arrived && !stable ? timeLeft(order.TimeRequired) : null
        const status = stable ? { key: 'stable', label: 'Stable', icon: 'mdi-check-circle', color: 'success', rank: 2 } : order ? { key: 'working', label: order.Arrived ? 'Being stabilised' : 'Ship on the way', note: this.orderNote(order, left), icon: 'mdi-progress-wrench', color: 'primary', rank: 1 } : { key: 'candidate', label: 'Can be stabilised', icon: 'mdi-circle-outline', color: '', rank: 0 }

        return {
          ...body,
          name: bodyNames[body.SystemBodyID],
          type: TYPES[body.BodyTypeID] || (body.BodyClass === 2 ? 'Moon' : 'Planet'),
          systemPoints: pointsBySystem[body.SystemID] || 0,
          Colonies: coloniesBySystem[body.SystemID] || 0,
          days,
          daysResult,
          daysSort: days,
          timeLeft: left,
          status,
          statusSort: status.rank,
        }
      })
    },

    selectedSystem() {
      return this.systems.find((system) => system.SystemID === this.selectedSystemId) || null
    },

    linkQuery() {
      return linkTo.lagrange(this.selectedSystemId).query
    },

    linkLabel() {
      return this.selectedSystem && this.selectedSystem.Name
    },

    visibleBodies() {
      const search = (this.search || '').toLowerCase()

      return this.bodyRows.filter((body) => (this.view === 'all' || (this.view === 'stable') === (body.status.key === 'stable')) && (!this.colonySystemsOnly || body.Colonies > 0) && (!this.selectedSystemId || body.SystemID === this.selectedSystemId) && (!search || body.name.toLowerCase().includes(search) || body.SystemName.toLowerCase().includes(search)))
    },

    mapNodes() {
      const { pointsBySystem, coloniesBySystem, colors, theme } = this

      return this.systems.map((system) => {
        const points = pointsBySystem[system.SystemID] || 0
        const colonies = coloniesBySystem[system.SystemID] || 0

        return {
          ...system,
          points,
          size: points ? 5 + 2 * Math.min(points, 4) : 3.5,
          color: points >= 2 ? colors.many : points ? colors.one : colors.none,
          ring: colonies ? theme.ink : null,
          label: points >= 2,
          title: `${system.Name}: ${points ? `${points} stable Lagrange ${points === 1 ? 'point' : 'points'}` : 'no stable Lagrange point'}${colonies ? `, ${colonies} ${colonies === 1 ? 'colony' : 'colonies'}` : ''}`,
        }
      }).sort((a, b) => a.points - b.points)
    },

    tiles() {
      const stable = this.bodyRows.filter((body) => body.status.key === 'stable')
      const candidates = this.bodyRows.filter((body) => body.status.key !== 'stable')
      const systems = Object.keys(this.pointsBySystem).length
      const jumpSystems = Object.values(this.pointsBySystem).filter((points) => points >= 2).length
      const timed = candidates.filter((body) => body.days !== null)
      const quickest = timed.slice().sort((a, b) => a.days - b.days)[0]
      const untimed = candidates.length - timed.length
      const usable = this.shipRows.filter((ship) => ship.multiplier !== null)
      const unknownCrews = this.shipRows.filter((ship) => ship.state === 'unknown').length
      const countsTitle = describeRule('lagrange.pointCounts')
      const needs = this.best.result.inputs.missing.join(', ')

      return [
        {
          label: 'Stable Lagrange points',
          value: this.count(stable.length),
          title: countsTitle,
          note: `In ${systems} ${systems === 1 ? 'system' : 'systems'}; ${jumpSystems} with two or more, where ships can jump between them`,
        },
        {
          label: 'Planets and moons to stabilise',
          value: this.count(candidates.length),
          title: countsTitle,
          note: `${this.count(candidates.filter((body) => body.Colonies > 0).length)} in systems with colonies`,
        },
        {
          label: 'Quickest to stabilise',
          value: quickest ? this.duration(quickest.days) : '—',
          title: quickest ? describeResult(quickest.daysResult) : candidates.length ? describeResult(candidates[0].daysResult) : describeRule('lagrange.stabilisationDays'),
          note: quickest ? `${quickest.name}, ${this.mass(quickest.Mass)} Earth masses${untimed ? `; ${untimed} with no time given` : ''}` : candidates.length ? `No time is given: needs ${needs}` : 'Nothing left to stabilise',
        },
        {
          label: 'Stabilisation ships',
          value: this.withheld.length ? '—' : usable.length ? `${usable.length} ${usable.length === 1 ? 'ship' : 'ships'}` : 'None',
          title: describeResult(this.best.result),
          note: this.withheld.length ? `Not given: ${this.withheld.join('; ')}` : this.bestShip ? `Quickest: ${this.bestShip.ShipName}, × ${this.fixed(this.bestShip.multiplier, 2)} time${unknownCrews ? `; ${unknownCrews} with crew unknown` : ''}` : this.shipRows.length ? `${this.shipRows.length} with a module, none usable: needs ${needs}` : 'Needs a ship with a jump point stabilisation module',
        },
      ]
    },

    bodyHeaders() {
      return [
        { text: 'Body', value: 'name' },
        { text: 'System', value: 'SystemName' },
        { text: 'Mass (Earths)', value: 'Mass', align: 'end' },
        { text: 'Stable points in system', value: 'systemPoints', align: 'end' },
        { text: 'Time to stabilise', value: 'daysSort', align: 'end' },
        { text: 'Lagrange point', value: 'statusSort' },
        { text: 'Colonies in system', value: 'Colonies', align: 'end' },
      ]
    },

    shipHeaders() {
      return [
        { text: 'Ship', value: 'ShipName' },
        { text: 'System', value: 'SystemName' },
        { text: 'Captain\'s Production bonus', value: 'ProductionBonus', align: 'end' },
        { text: 'Crew', value: 'crew', align: 'end' },
        { text: 'Time', value: 'multiplierSort', align: 'end' },
        { text: 'Doing', value: 'activity', sortable: false },
      ]
    },

    infrastructureHeaders() {
      return [
        { text: 'Jump point', value: 'sortName' },
        { text: 'System', value: 'systemName' },
        { text: 'Gate (stabilised)', value: 'gateSort' },
        { text: 'Stabilisation', value: 'stabilisationSort' },
        { text: 'Minefields', value: 'minefieldsSort', align: 'end' },
        { text: 'Buoys', value: 'buoysSort', align: 'end' },
        { text: 'Probes', value: 'probesSort', align: 'end' },
        { text: 'Detected (other races)', value: 'detectedSort', align: 'end' },
      ]
    },

    // The columns of the infrastructure reads the save lacks (the report's optional 'jumpInfrastructure' and 'jumpBuilders' inputs): the jump points and the rest of the page do not need them.
    missingInfrastructureFields() {
      const report = this.$store.getters['capabilities/report']('/lagrange')
      const entry = report && report.degraded.find((degraded) => degraded.key === 'jumpInfrastructure')

      return entry ? entry.fields : []
    },

    missingBuilderFields() {
      const report = this.$store.getters['capabilities/report']('/lagrange')
      const entry = report && report.degraded.find((degraded) => degraded.key === 'jumpBuilders')

      return entry ? entry.fields : []
    },

    infrastructureMissing() {
      return this.missingInfrastructureFields.map((field) => `the save lacks ${field}`)
    },

    // The charted jump points with what the save says of each (utilities/jump-infrastructure.js) and the words of the table: a figure the save cannot give reads Unknown and sorts last.
    infrastructureRows() {
      const names = Object.fromEntries(this.systems.map((system) => [system.SystemID, system.Name]))
      const systemName = (id) => names[id] || `System #${id}`
      const gateOrder = Object.keys(GATE_TEXT)
      const stateOrder = Object.keys(STABILISATION_TEXT)
      const figure = (result, known) => {
        const value = valueOrNull(result)

        return { value, text: value === null ? this.unknownText : known(value) }
      }

      return readInfrastructure(this.jumpPoints, this.jumpInfrastructure, { RaceID: this.RaceID, missing: this.infrastructureMissing, builders: this.jumpBuilders }).map((row) => {
        const state = figure(row.stabilisation, (value) => STABILISATION_TEXT[value])
        const mines = figure(row.minefields, (value) => this.count(value))
        const buoys = figure(row.buoys, (value) => this.count(value))
        const probes = figure(row.probes, (value) => this.count(value))
        const detected = figure(row.detected, (value) => (value === 0 ? DETECTED_ZERO_TEXT : this.count(value)))

        return {
          ...row,
          name: jumpPointLabel(row.number),
          systemName: systemName(row.SystemID),
          sortName: `${systemName(row.SystemID)} ${String(row.number).padStart(4, '0')}`,
          beyondName: row.beyondSystemID ? systemName(row.beyondSystemID) : '',
          beyond: row.beyondSystemID ? '' : FAR_SIDE_TEXT[row.explored ? 'uncharted' : 'unexplored'],
          gateText: GATE_TEXT[row.gate],
          gateSort: gateOrder.indexOf(row.gate),
          stabilisationText: state.value === null ? '' : state.text,
          stabilisationSort: state.value === null ? null : stateOrder.indexOf(state.value),
          fleetsText: state.value === null ? '' : row.fleets.map((fleet) => fleet.FleetName || `Fleet #${fleet.FleetID}`).join(', '),
          minefieldsText: mines.text,
          minefieldsSort: mines.value,
          buoysText: buoys.text,
          buoysSort: buoys.value,
          probesText: probes.text,
          probesSort: probes.value,
          detectedText: detected.text,
          detectedSort: detected.value,
          earlierFigure: row.earlier > 0 ? this.count(row.earlier) : '',
          earlierNoun: row.earlier === 1 ? 'contact' : 'contacts',
        }
      })
    },

    visibleInfrastructure() {
      return this.infrastructureRows.filter((row) => !this.selectedSystemId || row.SystemID === this.selectedSystemId)
    },
  },
  watch: {
    // A system picked on the map belongs to the race that was showing.
    RaceID() {
      this.selectedSystemId = null
    },
  },
  methods: {
    applyLink(query) {
      this.selectedSystemId = queryId(query.system)
    },

    selectSystem(systemId) {
      this.selectedSystemId = systemId
      this.search = ''
      this.$nextTick(() => {
        const panel = this.$refs.bodiesPanel

        if (panel && panel.$el) {
          panel.$el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    },

    bodyNameOf(systemBodyId) {
      return this.bodyNames[systemBodyId] || `body #${systemBodyId}`
    },

    orderNote(order, left) {
      return order.Arrived ? `${order.FleetName}, ${this.leftText(left)}` : order.FleetName
    },

    orderText(order, left) {
      return order.Arrived ? `Stabilising ${this.bodyNameOf(order.SystemBodyID)}, ${this.leftText(left)}` : `On the way to stabilise ${this.bodyNameOf(order.SystemBodyID)}`
    },

    leftText(result) {
      return result && result.status !== 'unavailable' ? `${this.duration(result.value)} left` : 'time left not recorded'
    },

    percent(bonus) {
      return !Number.isFinite(bonus) || bonus === 1 ? 'None' : `${bonus > 1 ? '+' : ''}${roundToDecimal((bonus - 1) * 100, 0)}%`
    },

    fixed(value, decimals) {
      return Number.isFinite(value) ? roundToDecimal(value, decimals).toFixed(decimals) : '—'
    },

    mass(value) {
      return Number.isFinite(value) ? this.count(value, value < 10 ? 2 : 0) : '—'
    },

    whole(value) {
      return Number.isFinite(value) ? this.count(value) : '—'
    },

    sortNullLast(items, sortBy, sortDesc) {
      const [key] = sortBy

      if (!key) {
        return items
      }

      const direction = sortDesc[0] ? -1 : 1
      const known = (item) => item[key] !== null && item[key] !== undefined
      const sorted = items.filter(known).sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * direction)

      return sorted.concat(items.filter((item) => !known(item)))
    },
  },
  asyncComputed: {
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    jumpPoints: {
      get: tracked('jumpPoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadJumpPoints(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.SystemID, count(*) as Colonies from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemID`).then(([items]) => items)
      }),
      default: [],
    },
    // Planets and moons of the known systems that could hold a Lagrange point (0.25 Earth masses and up), and any that has one. Lagrange points belong to no race: every one in a known system shows. Frozen, as thousands of read-only rows.
    bodies: {
      get: tracked('bodies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_SystemBody.Mass, (select min(FCT_LagrangePoint.LagrangePointID) from FCT_LagrangePoint where FCT_LagrangePoint.PlanetID = FCT_SystemBody.SystemBodyID and FCT_LagrangePoint.GameID = ${this.GameID}) as LagrangePointID from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} and FCT_SystemBodyName.GameID = ${this.GameID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2) and (FCT_SystemBody.Mass >= 0.25 or FCT_SystemBody.SystemBodyID in (select FCT_LagrangePoint.PlanetID from FCT_LagrangePoint where FCT_LagrangePoint.GameID = ${this.GameID}))`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Ships with a jump point stabilisation module, their captain's (CommandType 1) Production bonus, and whether a module is damaged.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID || this.withheld.length) {
          return []
        }

        return await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.ClassName, FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_RaceSysSurvey.Name as SystemName, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, VIR_Captain.Name as CaptainName, VIR_Captain.BonusValue as ProductionBonus, exists (select 1 from FCT_DamagedComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_DamagedComponent.ComponentID where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_ShipDesignComponents.ComponentTypeID = ${STABILISATION_COMPONENT}) as Damaged from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join (select FCT_Commander.CommandID, FCT_Commander.Name, FCT_CommanderBonuses.BonusValue from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${PRODUCTION_BONUS} where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Captain on VIR_Captain.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShipClassID in (select FCT_ClassComponent.ClassID from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.GameID = ${this.GameID} and FCT_ShipDesignComponents.ComponentTypeID = ${STABILISATION_COMPONENT}) order by FCT_Ship.ShipName`).then(([items]) => items)
      }),
      default: [],
    },
    // Stabilise orders: the body is DestinationID; once the fleet is there (`Arrived`), TimeRequired is the seconds left.
    orders: {
      get: tracked('orders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.FleetID, FCT_Fleet.FleetName, FCT_MoveOrders.DestinationID as SystemBodyID, FCT_MoveOrders.Arrived, FCT_MoveOrders.TimeRequired from FCT_MoveOrders inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.MoveActionID = ${STABILISE_ACTION} order by FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder`).then(([items]) => items)
      }),
      default: [],
    },
    // The builder of each gate (`loadJumpBuilders`): null while the save lacks the column, so every gate reads as built by an unrecorded race and the rest of the page stands.
    jumpBuilders: {
      get: tracked('jumpBuilders', async function () {
        if (!this.database || !this.GameID || this.missingBuilderFields.length) {
          return null
        }

        return await loadJumpBuilders(this.database, { GameID: this.GameID })
      }),
      default: null,
    },
    // The race's own stabilisation orders of jump points, stationary salvos and contacts, and the game time (`loadJumpInfrastructure`): null while the save lacks a column of the read, so the figures that rest on it are unknown and the rest of the page stands.
    jumpInfrastructure: {
      get: tracked('jumpInfrastructure', async function () {
        if (!this.database || !this.GameID || !this.RaceID || this.infrastructureMissing.length) {
          return null
        }

        return await loadJumpInfrastructure(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: null,
    },
    // The formula version the save's schema stands for (`loadFormulaVersion`, utilities/capabilities.js): the stated one for a save that has the formula columns, null for a save without them.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.lagrange-page {
  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  .controls {
    gap: 12px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
