<template>
  <div>
    <v-container fluid class="outlook-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Horizon</span>
          <v-btn-toggle v-model="horizon" mandatory dense>
            <v-btn v-for="option in horizonOptions" :key="option" :value="option" small>{{ option }} y</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Workers needed</span>
          <v-btn-toggle v-model="workerBasis" mandatory dense>
            <v-btn v-for="option in workerBases" :key="option.value" :value="option.value" small>{{ option.label }}</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="auto" class="mr-4">
          <v-switch v-model="attentionOnly" label="Only colonies that need attention" dense hide-details class="mt-0" />
        </v-col>
        <v-col cols="12" sm="auto" class="search-field">
          <v-text-field v-model="search" label="Search colonies" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" class="mt-3" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" class="mt-2" />

        <v-card class="panel" data-summary="Compare colony population, growth and worker projections with body capacity and infrastructure." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Colonies<provenance-mark rule="colonies.populationProjection" label /></span>
              <v-chip v-if="focusId" small close class="ml-3" close-label="Show every colony" @click:close="focusId = null">{{ focusName }}</v-chip>
            </span>
            <span class="legend">
              <span class="legend-item">Workers<provenance-mark rule="colonies.workers" /></span>
              <span class="legend-item"><series-key :color="workerColors.service" />Services</span>
              <span class="legend-item"><series-key :color="workerColors.agriculture" />Agriculture</span>
              <span class="legend-item"><series-key :color="workerColors.employed" />Working</span>
              <span class="legend-item"><series-key :color="workerColors.free" />Free</span>
              <span class="legend-item"><span class="swatch swatch-short" />Short</span>
            </span>
          </div>
          <v-data-table :headers="headers" :items="visibleRows" item-key="PopulationID" :expanded.sync="expanded" show-expand single-expand :custom-sort="sortRows" :sort-by.sync="colonyTable.sortBy" :sort-desc.sync="colonyTable.sortDesc" :items-per-page.sync="colonyTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: colonyPageSizes }" :no-data-text="focusId ? 'This colony has no population, or does not belong to the race.' : undefined" class="colony-table" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div>
                  <div class="font-weight-medium">
                    <v-icon v-if="item.Capital" small class="mr-1" title="Capital">mdi-star</v-icon>{{ item.name }}
                  </div>
                  <div class="caption text--secondary">{{ item.place }}<span v-if="multiSpecies"> · {{ item.SpeciesName }}</span></div>
                </div>
                <span class="ml-2 text-no-wrap">
                  <page-link :to="linkTo.production(item.PopulationID)" :name="item.name" />
                  <page-link :to="linkTo.planner({ bodies: [item] })" :name="item.place" />
                  <page-link :to="linkTo.commanders({ colony: item.PopulationID })" :name="item.name" />
                </span>
              </div>
            </template>
            <template #[`item.populationSort`]="{ item }">
              <div class="text-no-wrap">{{ people(item.Population) }}</div>
              <div class="caption text--secondary text-no-wrap">{{ people(item.final) }} in {{ horizon }} y<provenance-mark :result="item.r.projection" /></div>
              <div v-if="item.ark" class="caption text--secondary text-no-wrap">{{ arkCaption(item.ark) }}<provenance-mark :result="item.ark.occupied" /></div>
            </template>
            <template #[`item.growthSort`]="{ item }">
              <span class="text-no-wrap" :class="{ 'text--secondary': !(item.growth > 0) }">{{ percent(item.growth, 2) }}</span><provenance-mark :result="item.r.growth" />
            </template>
            <template #[`item.fillSort`]="{ item }">
              <div class="fill-cell" :title="fillTitle(item)">
                <div class="meter">
                  <div v-if="item.fill !== null" class="meter-fill" :class="{ warning: item.fill > 1 / 3 }" :style="{ width: `${Math.min(100, item.fill * 100)}%` }" />
                  <div class="meter-tick" />
                </div>
                <span class="caption text-no-wrap">{{ fillCaption(item) }}<provenance-mark :result="item.r.fill" /></span>
              </div>
            </template>
            <template #[`item.infrastructureSort`]="{ item }">
              <span class="text-no-wrap" :class="{ 'text--secondary': item.infrastructureStatus.muted }">
                <v-icon v-if="item.infrastructureStatus.icon" small :color="item.infrastructureStatus.color">{{ item.infrastructureStatus.icon }}</v-icon>
                {{ item.infrastructureStatus.label }}
              </span><provenance-mark :result="item.infrastructureStatus.mark" />
              <div v-if="item.infrastructureStatus.note" class="caption text--secondary text-no-wrap">{{ item.infrastructureStatus.note }}</div>
            </template>
            <template #[`item.workersSort`]="{ item }">
              <div class="worker-cell">
                <div v-if="item.workersNow" class="worker-bar" :title="workerTitle(item.workersNow)">
                  <div v-for="segment in workerSegments(item.workersNow)" :key="segment.key" class="worker-segment" :class="segment.className" :style="segment.style" />
                </div>
                <span class="caption text-no-wrap" :class="{ 'error--text': item.shortNow }">{{ freeLabel(item.freeNow) }}<provenance-mark :result="item.r.workersNow" /></span>
              </div>
            </template>
            <template #[`item.futureSort`]="{ item }">
              <span class="caption text-no-wrap" :class="{ 'error--text': item.shortLater }">{{ freeLabel(item.freeLater) }}</span><provenance-mark :result="item.r.workersLater" />
              <div v-if="item.laterRange" class="caption text-no-wrap" :class="item.mayBeShortLater ? 'error--text' : 'text--secondary'">At worst {{ freeLabel(item.freeLaterWorst) }}<provenance-mark :result="item.r.workersLaterWorst" /></div>
              <div v-if="item.duringNote" class="caption error--text ml-auto" style="max-width: 18em">{{ item.duringNote }}<provenance-mark :result="item.committedResult" /></div>
            </template>
            <template #[`item.inboundSort`]="{ item }">
              <span v-if="item.inbound" class="caption">{{ inboundLabel(item.inbound) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #expanded-item="{ headers: columns, item }">
              <td :colspan="columns.length" class="py-4">
                <div v-if="!focusId" class="mb-2">
                  <v-btn small text @click="focusId = item.PopulationID"><v-icon small left>mdi-filter-outline</v-icon>Only this colony</v-btn>
                </div>
                <v-row>
                  <v-col cols="12" md="7">
                    <div class="chart-title">Population over {{ horizon }} years<provenance-mark :result="item.r.projection" /></div>
                    <chart-canvas v-if="item.projection" type="line" :data="projectionChart(item)" :options="projectionOptions()" :height="220" :label="`Projected population of ${item.name}`" />
                    <div v-else class="caption text--secondary">No projection: {{ missingText(item.r.projection) }}.</div>
                    <div class="caption text--secondary mt-1"><span v-for="(part, index) in projectionNote(item)" :key="index" class="note-part">{{ part.text }}<provenance-mark v-for="(result, at) in part.results" :key="at" :result="result" /></span></div>
                  </v-col>
                  <v-col cols="12" md="5">
                    <div class="chart-title">Workers (millions)</div>
                    <v-simple-table dense class="worker-table">
                      <thead>
                        <tr>
                          <th />
                          <th class="text-right">Now<provenance-mark :result="item.r.workersNow" /></th>
                          <th class="text-right">In {{ horizon }} y<provenance-mark :result="item.r.workersLater" /></th>
                          <th v-if="item.laterRange" class="text-right">At worst</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="line in workerLines" :key="line.key">
                          <td>{{ line.label }}</td>
                          <td class="text-right" :class="line.key === 'free' && item.shortNow ? 'error--text' : ''">{{ millions(workerValue(item.workersNow, line.key, item.Population)) }}</td>
                          <td class="text-right" :class="line.key === 'free' && item.shortLater ? 'error--text' : ''">{{ millions(workerValue(item.workersLater, line.key, item.final)) }}</td>
                          <td v-if="item.laterRange" class="text-right" :class="line.key === 'free' && item.mayBeShortLater ? 'error--text' : ''">{{ millions(workerValue(item.workersLaterWorst, line.key, item.final)) }}</td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                    <div class="caption text--secondary mt-2">{{ workerNote(item) }}</div>
                    <div v-if="committedView" class="caption text--secondary mt-1">{{ committedNote(item) }}<provenance-mark :result="item.committedResult" /></div>
                  </v-col>
                </v-row>
                <v-row v-if="committedView && item.events.length">
                  <v-col cols="12">
                    <div class="chart-title">Queued installations and shipyard upgrades<provenance-mark :result="item.committedResult" /></div>
                    <v-simple-table dense class="event-table">
                      <thead>
                        <tr>
                          <th>Job</th>
                          <th>Status</th>
                          <th>When</th>
                          <th class="text-right">Workers needed</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="event in item.events" :key="event.id">
                          <td>
                            {{ event.name }}
                            <div v-for="(limit, at) in event.limits" :key="at" class="caption text--secondary">{{ limit }}</div>
                          </td>
                          <td>{{ eventStatus(event) }}</td>
                          <td class="text-no-wrap">{{ eventWhen(event) }}</td>
                          <td class="text-right text-no-wrap">{{ eventEffect(event) }}</td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                  </v-col>
                </v-row>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Find colonies that will outgrow their bodies or lack workers. Growth is an estimate from the game's growth rule. It slows as a colony fills its body and stops at the infrastructure cap, and the species and governor modifiers apply. Workers needed are today's installations and shipyards. With the queue counted, they also include the installations queued and the shipyard upgrades under way, each from the date the production forecast supports. The first figure counts only completions with a supported date. "At worst" counts every completion that could happen. A job with no date, a queued job the forecast may start in an order it did not try, and a continual upgrade add nothing to the first figure, and a paused or stalled job adds nothing certain. The figures for now and for the horizon are endpoints. A colony short of workers on the way is not counted in them but stays in the attention filter, and its row names the month the shortage starts. Population aboard Ark ships is listed separately, with no growth applied. A dash is a figure the save cannot support, and the mark beside it names what is missing. Colonies short of workers today are also on the <router-link :to="linkTo.warnings({ check: 'low-efficiency-populations' })">Warnings</router-link> page.
          </div>
        </v-card>

        <v-card v-if="ark.ships.length" class="panel" data-summary="Review the population and species aboard Ark ships at colonies, along with their empty berths." elevation="1">
          <div class="panel-head">
            <span>Ark population<provenance-mark rule="arks.occupied" label /></span>
            <span class="caption text--secondary">{{ arkHeadline }}<provenance-mark :result="ark.totals.occupied" /></span>
          </div>
          <v-data-table :headers="arkHeaders" :items="arkRows" item-key="SystemBodyID" :expanded.sync="arkExpanded" show-expand single-expand :custom-sort="sortRows" :sort-by.sync="arkTable.sortBy" :sort-desc.sync="arkTable.sortDesc" :items-per-page.sync="arkTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: colonyPageSizes }" no-data-text="No Ark ship of the race is at a colony." class="ark-table" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.name }}</div>
                <div class="caption text--secondary">{{ item.place }}</div>
              </div>
            </template>
            <template #[`item.speciesSort`]="{ item }"><span class="text-no-wrap">{{ speciesLabel(item.species) }}</span><provenance-mark :result="item.species" /></template>
            <template #[`item.occupiedSort`]="{ item }"><span class="text-no-wrap">{{ people(item.occupiedSort) }}</span><provenance-mark :result="item.occupied" /></template>
            <template #[`item.emptySort`]="{ item }"><span class="text-no-wrap">{{ people(item.emptySort) }}</span><provenance-mark :result="item.empty" /></template>
            <template #[`item.shipsSort`]="{ item }">{{ item.shipsSort }}</template>
            <template #[`item.surfaceSort`]="{ item }"><span class="text-no-wrap" :class="{ 'text--secondary': !(item.surfaceSort > 0) }">{{ people(item.surfaceSort) }}</span></template>
            <template #expanded-item="{ headers: columns, item }">
              <td :colspan="columns.length" class="py-4">
                <v-simple-table dense class="ark-ships">
                  <thead>
                    <tr>
                      <th>Ship</th>
                      <th>Fleet</th>
                      <th class="text-right">Aboard<provenance-mark rule="arks.aboard" /></th>
                      <th class="text-right">Standard berths<provenance-mark rule="arks.berths" /></th>
                      <th class="text-right">Empty<provenance-mark rule="arks.emptyBerths" /></th>
                      <th>Species<provenance-mark rule="arks.species" /></th>
                      <th>Orbit<provenance-mark rule="arks.orbit" /></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="ship in item.ships" :key="ship.ShipID">
                      <td>{{ ship.ShipName }}<div class="caption text--secondary">{{ ship.ClassName }}</div></td>
                      <td>{{ ship.FleetName }}</td>
                      <td class="text-right">{{ people(ship.aboard) }}<provenance-mark :result="ship.results.aboard" /><div v-if="ship.beyondBerths > 0" class="caption text--secondary">{{ people(ship.beyondBerths) }} beyond the berths</div></td>
                      <td class="text-right">{{ people(ship.berths) }}<provenance-mark :result="ship.results.berths" /></td>
                      <td class="text-right">{{ people(ship.empty) }}<provenance-mark :result="ship.results.empty" /></td>
                      <td>{{ speciesLabel(ship.results.species) }}<provenance-mark :result="ship.results.species" /></td>
                      <td>{{ orbitText(ship) }}<provenance-mark :result="ship.results.orbit" /></td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </td>
            </template>
          </v-data-table>
          <div v-if="arkAside.length" class="px-6 pb-2">
            <div class="chart-title">Aboard Ark ships that are not orbital population<provenance-mark :result="ark.totals.aboardElsewhere" /></div>
            <v-simple-table dense class="ark-ships">
              <thead>
                <tr>
                  <th>Ship</th>
                  <th>Fleet</th>
                  <th class="text-right">Aboard<provenance-mark rule="arks.aboard" /></th>
                  <th>Why<provenance-mark rule="arks.orbit" /></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="ship in arkAside" :key="ship.ShipID">
                  <td>{{ ship.ShipName }}<div class="caption text--secondary">{{ ship.ClassName }}</div></td>
                  <td>{{ ship.FleetName }}</td>
                  <td class="text-right">{{ people(ship.aboard) }}<provenance-mark :result="ship.results.aboard" /></td>
                  <td>{{ orbitText(ship) }}<provenance-mark :result="ship.results.orbit" /></td>
                </tr>
              </tbody>
            </v-simple-table>
          </div>
          <div class="panel-foot caption text--secondary">
            Use it to see where orbital population sits and how much room is left for more. People aboard an Ark ship count as orbital population only while its fleet sits at its colony's body with no move orders and is not a civilian fleet. Empty berths are room in the standard berths, not people, and stay apart from the population in orbit; people beyond the berths of a damaged ship are not counted. Orbital population is not surface population or workers, and the colony projections above leave it out. Its growth and its transfer to the surface are not verified, so none is applied and no forecast is made for it. A dash is a figure the save cannot support, and the mark beside it names what is missing.
          </div>
        </v-card>

        <colonist-floor :key="`${GameID}-${RaceID}`" :colonies="rows" :sources="colonistSources" :committed-view="committedView" :loading="colonistState.loading" :failed="colonistState.failed" :error="colonistState.error" @retry="retryColonistSources" />

        <v-card class="panel mine-bootstrap" data-summary="Compare the three ways to add mining capacity at a colony." elevation="1">
          <div class="panel-head">
            <span>Mine bootstrap<provenance-mark rule="mineBootstrap.localBuild" label /></span>
          </div>
          <v-row dense class="px-4 pt-2">
            <v-col cols="12" sm="6" md="3">
              <v-autocomplete v-model="bootstrapColonyId" :items="bootstrapColonyItems" item-text="text" item-value="value" label="Colony to gain mining" aria-label="Colony to gain mining" dense outlined hide-details clearable />
            </v-col>
            <v-col cols="12" sm="6" md="3">
              <v-autocomplete :value="bootstrapType ? bootstrapType.PlanetaryInstallationID : null" :items="bootstrapTypeItems" item-text="text" item-value="value" label="Mine type" aria-label="Mine type" dense outlined hide-details :disabled="!bootstrapColonyId" @change="bootstrapTypeId = $event" />
            </v-col>
            <v-col cols="12" sm="6" md="2">
              <v-text-field v-model="bootstrapQuantity" label="Number of mines" aria-label="Number of mines" type="number" min="1" dense outlined hide-details :disabled="!bootstrapColonyId" :error="bootstrapColonyId !== null && bootstrapCount === null" />
            </v-col>
            <v-col cols="12" sm="6" md="4">
              <v-autocomplete :value="bootstrapBuilders.length ? (bootstrapBuilders.find((option) => option.colony.PopulationID === bootstrapBuilderId) || bootstrapBuilders[0]).colony.PopulationID : null" :items="bootstrapBuilderItems" item-text="text" item-value="value" label="Builder for the import" aria-label="Builder for the import" dense outlined hide-details :disabled="!bootstrapColonyId" @change="bootstrapBuilderId = $event" />
            </v-col>
          </v-row>
          <div v-if="bootstrapState.loading || bootstrapState.failed" class="px-4 py-2" data-bootstrap-state>
            <load-state :failed="bootstrapState.failed" :error="bootstrapState.error" :loading="bootstrapState.loading" @retry="retryBootstrapSources" />
          </div>
          <template v-else>
            <div v-if="bootstrapSources.problems.length" class="px-4 pb-2 caption text--secondary" data-bootstrap-problems>Not read: {{ bootstrapSources.problems.map((problem) => problem.text).join('; ') }}.<v-btn v-if="bootstrapRetryable" x-small text color="primary" class="ml-2" data-bootstrap-retry @click="retryBootstrapSources">Retry</v-btn></div>
            <div v-if="!bootstrapTarget" class="px-4 py-3 caption text--secondary">Pick the colony that should gain mining capacity to compare the three routes.</div>
            <div v-else-if="!bootstrapRoutes.length" class="px-4 py-3 caption text--secondary">The comparison needs a mine type the race can build and a position for the colony.</div>
            <v-row v-else dense class="px-4 pb-2">
              <v-col v-for="route in bootstrapRoutes" :key="route.id" cols="12" md="4">
                <div class="route-card" :data-route="route.id">
                  <div class="d-flex align-center mb-1">
                    <span class="font-weight-medium">{{ route.title }}</span>
                    <v-chip small label class="ml-2" :color="routeColor(route.status)">{{ routeStatus[route.status] }}</v-chip>
                  </div>
                  <table v-if="routeFigures(route).length" class="route-figures caption">
                    <tr v-for="figure in routeFigures(route)" :key="figure.label">
                      <td class="text--secondary">{{ figure.label }}</td>
                      <td>{{ figure.text }}<provenance-mark v-if="figure.result" :result="figure.result" /></td>
                    </tr>
                  </table>
                  <div v-if="route.worksNow.length" class="chart-title mt-2">Works now</div>
                  <ul v-if="route.worksNow.length" class="route-list caption"><li v-for="line in route.worksNow" :key="line">{{ line }}</li></ul>
                  <div v-if="route.limits.length" class="chart-title mt-2">Limits</div>
                  <ul v-if="route.limits.length" class="route-list caption"><li v-for="line in route.limits" :key="line">{{ line }}</li></ul>
                  <div v-if="route.missing.length" class="chart-title mt-2">Missing inputs</div>
                  <ul v-if="route.missing.length" class="route-list caption text--secondary"><li v-for="line in route.missing" :key="line">{{ line }}</li></ul>
                </div>
              </v-col>
            </v-row>
          </template>
          <div class="panel-foot caption text--secondary">
            Each route builds the same number of mines of one type and shows what works now, what limits it and what the save does not say. Import builds them at another colony of the race, with the build time of that colony's idle construction capacity, and carries them by freighter; the freight deficit is the tonnage beyond one lift of the class and the labour deficit is the workers the manned mines need beyond the colony's free workers. A freighter class crosses a jump point not stabilised on both sides only with jump drives that cover its size, else it takes a route over stabilised jump points when one exists, and otherwise needs a jump-capable tender. Local industry uses the colony's own idle construction capacity at its saved efficiency, so a colony short of workers builds slower. Ground-force assistance adds the construction rating of engineer formations at other colonies, weighted by their commanders' Production bonus, and a formation travels whole in one troop ship. It is unavailable where the save lacks the columns, and the figure is an upper bound because the assignment of engineers to fortification work is not saved. Mines already installed elsewhere, free freighters and troop ships, the move time of troops and mineral stock beyond the colony's own are not counted. A dash is a figure the save cannot support, and the mark beside it names what is missing.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import ColonistFloor from '../components/colonies/ColonistFloor.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme, patternImage, seriesIdentity, withAlpha } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers, { capacityResult } from '../mixins/production-modifiers'
import queueForecast from '../mixins/queue-forecast'
import { activeAppearance } from '../utilities/appearance'
import { ORBIT_REASONS, arkLayer, loadArks } from '../utilities/arks'
import { populationName } from '../utilities/aurora'
import { WORKER_TOLERANCE, attentionResult, outlookColonies, people as peopleOf, totalResult } from '../utilities/colonies'
import { linkTo, queryId } from '../utilities/deep-links'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { MINERALS } from '../utilities/minerals'
import { industryUsage, prepareForecast } from '../utilities/production'
import { describeResult, valueOrNull } from '../utilities/provenance'
import { committedSplitResult, committedWorkforce, workforceNeeds } from '../utilities/workforce-demand'
import { loadFormulaVersion } from '../utilities/capabilities'
import { ROUTE_STATUS, builderOptions, compareRoutes, engineerCapacityGap, fullStaffModifiers, idleConstruction, mineRequirements, plural, withMappedEngineers } from '../utilities/mine-bootstrap'
import { NO_BOOTSTRAP_SOURCES, loadBootstrapSources } from '../utilities/mine-bootstrap-data'
import { NO_COLONIST_SOURCES, loadColonistSources } from '../utilities/colonist-floor'

const CAPACITY_KINDS = ['construction', 'ordnance', 'fighter']

const EVENT_STATUS = {
  dated: 'Dated',
  range: 'Date between',
  sampled: 'Date from some orders',
  unknown: 'No date',
  paused: 'Paused, adds nothing',
  queued: 'Queued, adds nothing',
  stalled: 'Stalls, adds nothing certain',
  later: 'Beyond the forecast',
  maybe: 'May start, adds nothing certain',
  approximate: 'Date approximate',
  short: 'Short of minerals',
}

const INPUT_LABELS = {
  colonies: 'the colonies',
  inbound: 'cargo on its way',
  populationProductionModifiers: 'production modifiers',
  arks: 'the Ark ships',
  industry: 'the industrial projects',
  yardActivities: 'the shipyard activities',
  installationTypes: 'the installation types',
  bootstrapSources: 'the mine bootstrap reads',
  bootstrapVersion: 'the formula version',
  colonistSources: 'the colonist source fields',
}
// The reads of single panels: the rest of the page never waits for them, so a colony picked in the mine bootstrap panel never takes the page back to its loading state, and a failure of one is shown on its panel with the panel's own Retry.
const COLONIST_INPUTS = ['colonistSources']
const BOOTSTRAP_INPUTS = ['bootstrapSources', 'bootstrapVersion']
const OPTIONAL_INPUTS = [...COLONIST_INPUTS, ...BOOTSTRAP_INPUTS]
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key))

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

const HORIZONS = [5, 10, 25, 50]
const WORKER_BASES = [{ value: 'current', label: 'Today\'s installations' }, { value: 'committed', label: 'With the queue' }]

// The commander bonus the growth rate of a colony rests on, Population Growth: left unknown in every colony while the save's lookup row for it is not confirmed (`blockedBonuses`).
const POPULATION_GROWTH_BONUS = 8
const COLONY_PAGE_SIZES = [25, 50, -1]

export default {
  name: 'ColonyOutlookPage',
  components: { ChartCanvas, ColonistFloor, LoadState, PageLink, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    queueForecast,
    persistedView({
      horizon: { key: 'colonyOutlookHorizon', default: 10, valid: oneOf(HORIZONS) },
      workerBasis: { key: 'colonyOutlookWorkerBasis', default: 'current', valid: oneOf(['current', 'committed']) },
      attentionOnly: { key: 'colonyOutlookAttentionOnly', default: false },
      search: { key: 'colonyOutlookSearch', default: '', scope: 'race' },
      colonyTable: tableView('colonyOutlookTable', { sortBy: ['populationSort'], sortDesc: [true], itemsPerPage: 25, itemsPerPageOptions: COLONY_PAGE_SIZES }),
      arkTable: tableView('colonyOutlookArkTable', { sortBy: ['occupiedSort'], sortDesc: [true], itemsPerPage: 25, itemsPerPageOptions: COLONY_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      horizonOptions: HORIZONS,
      workerBases: WORKER_BASES,
      colonyPageSizes: COLONY_PAGE_SIZES,
      focusId: null,
      linkTo,
      expanded: [],
      bootstrapColonyId: null,
      // Whether a colony has been picked in the mine bootstrap panel: the first pick starts the panel's reads, which are the same for every colony.
      bootstrapPicked: false,
      bootstrapTypeId: null,
      bootstrapQuantity: '10',
      bootstrapBuilderId: null,
      routeStatus: ROUTE_STATUS,
      arkExpanded: [],
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),
    ...mapState(['RaceNPR']),

    // The reads behind the page's own panels that failed: the reads of the colonist and mine bootstrap panels are their own (`colonistState`, `bootstrapState`).
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    // The colonist panel's read and the mine bootstrap panel's reads: loading until they have settled, else the words naming them with the message. A panel shows no figures from a read that is in flight or failed.
    colonistState() {
      return this.optionalState(COLONIST_INPUTS)
    },

    bootstrapState() {
      return this.optionalState(BOOTSTRAP_INPUTS)
    },

    // Whether a source of the mine bootstrap reads failed to read (as against a column the save lacks): the sources settle with it named in their problems, so only a new read can bring it back.
    bootstrapRetryable() {
      return this.bootstrapSources.problems.some((problem) => problem.retry)
    },

    // Whether the workers needed count the queue and the shipyard upgrades as well as what stands today.
    committedView() {
      return this.workerBasis === 'committed'
    },

    // The industrial projects of each colony in the order the forecast takes them: { [PopulationID]: [project] }.
    queueByColony() {
      const colonies = {}

      this.industry.forEach((project) => (colonies[project.PopulationID] = colonies[project.PopulationID] || []).push(project))

      return colonies
    },

    // The changes in workers the queue and the yard activities of each colony hold: { [PopulationID]: `workforceNeeds` }. Nothing is read or worked out with the queue not counted.
    workforceNeedsByColony() {
      if (!this.committedView) {
        return {}
      }

      const yards = {}

      this.yardActivities.forEach((yard) => (yards[yard.PopulationID] = yards[yard.PopulationID] || []).push(yard))

      return Object.fromEntries(this.colonies.map((colony) => [colony.PopulationID, workforceNeeds({ projects: this.queueByColony[colony.PopulationID] || [], installations: this.installationTypes, yards: yards[colony.PopulationID] || [] })]))
    },

    // The projects of the colonies whose installations change the workers, made ready for the cycle forecast (`queue-forecast`); the other colonies need no forecast.
    industryPlans() {
      const plans = {}

      Object.entries(this.workforceNeedsByColony).forEach(([populationId, needs]) => {
        if (needs.installation.length) {
          const id = Number(populationId)
          const capacities = Object.fromEntries(CAPACITY_KINDS.map((kind) => [kind, this.populationCapacityResult(id, kind)]))

          plans[id] = prepareForecast({ projects: this.queueByColony[id], capacities, modifiers: this.populationProductionModifiers[id], arrivals: [], npr: this.RaceNPR })
        }
      })

      return plans
    },

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    workerColors() {
      const [blue, , green, , pink] = this.theme.categorical

      return { service: withAlpha(blue, 0.45), agriculture: withAlpha(pink, 0.6), employed: blue, free: green }
    },

    // Each worker segment's colour under its slot's texture, as its legend key draws it.
    workerStyles() {
      const surface = this.appearance.surfaces.card

      return Object.fromEntries(Object.entries(this.workerColors).map(([key, color]) => {
        const texture = patternImage(seriesIdentity(this.appearance, color), surface)

        return [key, { backgroundColor: color, ...(texture ? { backgroundImage: texture, backgroundSize: '8px 8px' } : {}) }]
      }))
    },

    multiSpecies() {
      return new Set(this.colonies.map((colony) => colony.SpeciesID)).size > 1
    },

    rows() {
      return outlookColonies(this.colonies, this.inbound, this.horizon).map(({ colony, arriving, otherSeries, results }) => {
        const committedResult = this.committedView ? this.committedOf(colony, results) : null
        const committed = valueOrNull(committedResult)
        const worstLater = committed ? committed.later.worst : null
        const bestLater = this.committedView ? committedSplitResult(committedResult, 'best') : null
        const worstResult = this.committedView ? committedSplitResult(committedResult, 'worst') : null
        const r = { ...results, ...(bestLater ? { workersLater: bestLater, workersLaterWorst: worstResult, committed: committedResult, attention: attentionResult(results.workersNow, bestLater, results.projection) } : {}), construction: this.populationCapacityResult(colony.PopulationID, 'construction') }
        const projection = valueOrNull(r.projection)
        const workersNow = valueOrNull(r.workersNow)
        const workersLater = valueOrNull(r.workersLater)
        const perMillion = valueOrNull(r.rate)
        const growth = valueOrNull(r.growth)
        const fill = valueOrNull(r.fill)
        const freeNow = workersNow ? workersNow.free : null
        const freeLater = workersLater ? workersLater.free : null
        const row = {
          ...colony,
          name: colony.PopName,
          place: stripHtml(populationName(colony)).replace(` — ${colony.PopName}`, ''),
          r,
          capacity: valueOrNull(r.capacity),
          otherSeries,
          fill,
          growth,
          projection,
          final: projection ? projection.final : null,
          perMillion,
          infrastructureCap: valueOrNull(r.cap),
          infrastructureNeeded: valueOrNull(r.needed),
          infrastructureBP: valueOrNull(r.neededCost),
          constructionBP: valueOrNull(r.construction),
          workersNow,
          workersLater,
          freeNow,
          freeLater,
          shortNow: freeNow === null ? null : freeNow < -WORKER_TOLERANCE,
          shortLater: freeLater === null ? null : freeLater < -WORKER_TOLERANCE,
          attention: valueOrNull(r.attention),
          inbound: arriving && (arriving.Colonists || arriving.Infrastructure || arriving.Installations) ? arriving : null,
          ark: this.ark.byPopulation[colony.PopulationID] || null,
          committedResult,
          committed,
          events: committed ? committed.events : [],
          workersLaterWorst: worstLater,
          freeLaterWorst: worstLater ? worstLater.free : null,
          laterRange: worstLater !== null && freeLater !== null && Math.abs(worstLater.free - freeLater) > 1e-9,
          mayBeShortLater: worstLater !== null && freeLater !== null && freeLater >= -WORKER_TOLERANCE && worstLater.free < -WORKER_TOLERANCE,
          shortInBetween: committed !== null && committed.firstShort.best !== null && freeNow !== null && freeLater !== null && freeNow >= -WORKER_TOLERANCE && freeLater >= -WORKER_TOLERANCE,
          recoveryAtBestOnly: committed !== null && committed.firstShort.best !== null && committed.recovery.worstAfterBest !== committed.recovery.best,
          mayBeShortDuring: committed !== null && committed.firstShort.best === null && committed.firstShort.worst !== null,
        }

        row.duringNote = committed ? this.duringNote(row) : ''
        row.infrastructureStatus = this.infrastructureStatus(row)

        return {
          ...row,
          populationSort: colony.Population,
          growthSort: growth,
          fillSort: fill,
          infrastructureSort: perMillion === null ? null : perMillion === 0 ? 2e6 : projection ? (projection.infrastructureAt === null ? 1e6 : projection.infrastructureAt) : null,
          workersSort: freeNow,
          futureSort: freeLater,
          inboundSort: arriving ? arriving.Colonists * 1e6 + arriving.Infrastructure + arriving.Installations : 0,
        }
      })
    },

    ark() {
      return arkLayer(this.arks)
    },

    // One row per body with Ark ships at its colonies, the species as a list for the cell and the sortable values.
    arkRows() {
      return this.ark.bodies.map((body) => {
        const assigned = body.colonies.filter((colony) => body.populationIds.includes(colony.PopulationID))
        const named = assigned.length ? assigned : body.colonies.slice(0, 1)
        const speciesList = valueOrNull(body.species)

        return {
          ...body,
          name: named.length ? named.map((colony) => colony.PopName).join(', ') : `Body #${body.SystemBodyID}`,
          place: named.length ? stripHtml(populationName(named[0])).replace(` — ${named[0].PopName}`, '') : '',
          speciesSort: speciesList === null ? null : speciesList.map((entry) => entry.name).join(', '),
          occupiedSort: valueOrNull(body.occupied),
          emptySort: valueOrNull(body.empty),
          shipsSort: body.ships.length,
          surfaceSort: body.surface,
        }
      })
    },

    arkAside() {
      return [...this.ark.elsewhere, ...this.ark.unplaced]
    },

    arkHeadline() {
      const { occupied, empty, unknown } = this.ark.totals

      return `${this.people(valueOrNull(occupied))} in orbit · empty berths ${this.people(valueOrNull(empty))}${unknown ? ` · ${unknown} ${unknown === 1 ? 'ship' : 'ships'} left out` : ''}`
    },

    arkHeaders() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Species', value: 'speciesSort' },
        { text: 'In orbit', value: 'occupiedSort', align: 'end' },
        { text: 'Empty berths', value: 'emptySort', align: 'end' },
        { text: 'Ships', value: 'shipsSort', align: 'end' },
        { text: 'Surface population', value: 'surfaceSort', align: 'end' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    focusRow() {
      return this.focusId ? this.rows.find((row) => row.PopulationID === this.focusId) || null : null
    },

    focusName() {
      return this.focusRow ? this.focusRow.name : `Colony #${this.focusId}`
    },

    linkQuery() {
      return linkTo.colonyOutlook(this.focusId).query
    },

    linkLabel() {
      return this.focusRow ? this.focusRow.name : ''
    },

    visibleRows() {
      if (this.focusId) {
        return this.rows.filter((row) => row.PopulationID === this.focusId)
      }

      const search = (this.search || '').toLowerCase()

      return this.rows.filter((row) => (!this.attentionOnly || row.attention === true || row.shortInBetween === true || row.mayBeShortDuring === true) && (!search || `${row.name} ${row.place}`.toLowerCase().includes(search)))
    },

    tiles() {
      const rows = this.rows
      const horizon = this.horizon
      const total = rows.length

      if (!total) {
        return ['Population', 'Colonies short of workers', `Growth capped within ${horizon} y`, `Infrastructure for ${horizon} years of growth`].map((label) => ({ label, value: '—', note: 'No colonies with a population' }))
      }

      const results = (name) => rows.map((row) => row.r[name])
      const countOf = (name, test) => totalResult({ results: results(name), pick: (value) => (test(value) ? 1 : 0), partial: true })
      const sumOf = (name, units) => totalResult({ results: results(name), pick: (value) => value, partial: true, units })
      const now = rows.reduce((sum, row) => sum + row.Population, 0)
      const later = totalResult({ results: results('projection'), pick: (projection) => projection.final, units: 'M people' })
      const laterValue = valueOrNull(later.result)
      const annual = laterValue !== null && now > 0 ? (laterValue / now) ** (1 / horizon) - 1 : null
      const isShort = (workers) => workers.free < -WORKER_TOLERANCE
      const shortNow = countOf('workersNow', isShort)
      const shortLater = countOf('workersLater', isShort)
      const free = totalResult({ results: results('workersNow'), pick: (workers) => Math.max(0, workers.free), partial: true, units: 'M workers' })
      // Colonies short of workers on the way to the horizon (committed view): short for some months and enough again by the horizon on the dates the forecast supports (`recovered`), or short only if every completion that could happen does (`possible`): the figures above count the endpoints only, and neither of these is counted as short there.
      const recovered = this.committedView ? rows.filter((row) => row.shortInBetween).length : 0
      const atBest = this.committedView ? rows.filter((row) => row.shortInBetween && row.mayBeShortLater).length : 0
      const possible = this.committedView ? rows.filter((row) => row.mayBeShortDuring).length : 0
      const during = this.committedView ? countOf('committed', (value) => value.firstShort.worst !== null) : null
      const capped = countOf('projection', (projection) => projection.infrastructureAt !== null)
      const crowded = countOf('fill', (fill) => fill > 1 / 3)
      const needed = sumOf('needed', 'infrastructure')
      const cost = sumOf('neededCost', 'BP')
      const shortNowValue = valueOrNull(shortNow.result)
      const shortLaterValue = valueOrNull(shortLater.result)
      const freeValue = valueOrNull(free.result)
      const cappedValue = valueOrNull(capped.result)
      const crowdedValue = valueOrNull(crowded.result)
      const neededValue = valueOrNull(needed.result)
      const costValue = valueOrNull(cost.result)
      const unknownWorkers = rows.filter((row) => !row.workersNow || !row.workersLater).length
      const unknownGrowth = Math.max(capped.unknown, crowded.unknown)
      const unknownInfrastructure = Math.max(needed.unknown, cost.unknown)
      const tile = (value, parts, fields) => ({ ...fields, value, title: `${value}. ${parts.map(describeResult).join('. ')}` })
      let neededNote = 'Infrastructure needed is unavailable'
      let neededText = '—'

      if (neededValue > 0) {
        neededText = this.count(neededValue)
        neededNote = `${costValue === null ? 'Cost unavailable' : `${this.count(costValue)} BP`}, beyond what's built or on its way`
      } else if (neededValue === 0 && !needed.unknown) {
        neededText = 'None needed'
        neededNote = 'Every colony with a colony cost has enough'
      } else if (neededValue === 0) {
        neededNote = 'None needed by the colonies that can be read'
      }

      return [
        tile(`${this.people(now)} → ${this.people(laterValue)}`, [later.result], {
          label: 'Population',
          note: later.unknown ? `${later.unknown} of ${total} colonies have no projection` : `In ${horizon} years, about ${percent(annual, 2)} a year`,
        }),
        tile(shortNowValue === null && shortLaterValue === null ? '—' : `${shortNowValue === null ? '—' : shortNowValue} now, ${shortLaterValue === null ? '—' : shortLaterValue} in ${horizon} y`, [shortNow.result, shortLater.result, ...(during && (recovered || possible) ? [during.result] : [])], {
          label: 'Colonies short of workers',
          note: `${recovered ? `${recovered} short on the way, back by ${horizon} y${atBest ? ` (${atBest} of them only at best)` : ''} · ` : ''}${possible ? `${possible} more may be short at worst · ` : ''}${freeValue === null ? 'Free workers elsewhere unavailable' : `${this.millions(freeValue)} M free workers elsewhere`}${leftOut(unknownWorkers, total)}${this.committedView ? ' · queue and yard upgrades counted' : ''}`,
          icon: shortNowValue > 0 || shortLaterValue > 0 || recovered > 0 || possible > 0 ? 'mdi-account-alert' : shortNowValue === 0 && !unknownWorkers ? 'mdi-check-circle' : null,
          iconColor: shortNowValue > 0 || shortLaterValue > 0 || recovered > 0 || possible > 0 ? 'warning' : 'success',
        }),
        tile(cappedValue === null ? '—' : `${cappedValue}`, [capped.result, crowded.result], {
          label: `Growth capped within ${horizon} y`,
          note: `${cappedValue > 0 ? 'By infrastructure. ' : ''}${crowdedValue === null ? 'Crowding unavailable' : `${crowdedValue} past a third of their body's capacity`}${leftOut(unknownGrowth, total)}`,
          icon: cappedValue > 0 ? 'mdi-alert' : null,
          iconColor: 'warning',
        }),
        tile(neededText, [needed.result, cost.result], {
          label: `Infrastructure for ${horizon} years of growth`,
          note: `${neededNote}${leftOut(unknownInfrastructure, total)}`,
        }),
      ]
    },

    // Nothing is on its way to most colonies most of the time, and an all-empty column is the first thing to give up when the window is narrow.
    headers() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Population', value: 'populationSort', align: 'end' },
        { text: 'Growth / yr', value: 'growthSort', align: 'end' },
        { text: 'Body capacity', value: 'fillSort' },
        { text: 'Infrastructure', value: 'infrastructureSort' },
        { text: 'Workers now', value: 'workersSort' },
        { text: `In ${this.horizon} y`, value: 'futureSort', align: 'end' },
        ...(this.rows.some((row) => row.inbound) ? [{ text: 'On its way', value: 'inboundSort' }] : []),
        { text: '', value: 'data-table-expand' },
      ]
    },

    workerLines() {
      return [
        { key: 'population', label: 'Population' },
        { key: 'service', label: 'Services' },
        { key: 'agriculture', label: 'Agriculture and environment' },
        { key: 'available', label: 'Available to work' },
        { key: 'required', label: 'Needed by installations and yards' },
        { key: 'free', label: 'Free (short when negative)' },
      ]
    },

    // The colony meant to gain mining capacity: its row of the outlook.
    bootstrapTarget() {
      return this.rows.find((row) => row.PopulationID === this.bootstrapColonyId) || null
    },

    bootstrapColonyItems() {
      return this.rows.map((row) => ({ text: row.name, value: row.PopulationID }))
    },

    bootstrapType() {
      const { types } = this.bootstrapSources

      return types.find((type) => type.PlanetaryInstallationID === this.bootstrapTypeId) || types[0] || null
    },

    bootstrapTypeItems() {
      return this.bootstrapSources.types.map((type) => ({ text: type.Name, value: type.PlanetaryInstallationID }))
    },

    // The number of mines, a whole number above 0; null for anything else.
    bootstrapCount() {
      const count = Number(this.bootstrapQuantity)

      return Number.isInteger(count) && count > 0 ? count : null
    },

    bootstrapRequirement() {
      return this.bootstrapType ? mineRequirements(this.bootstrapType, this.bootstrapCount) : null
    },

    // The share of each colony's capacities the running projects hold.
    bootstrapUsage() {
      return industryUsage(this.bootstrapSources.projects)
    },

    // The colonies that could build the mines, the quickest first, each with its charted route to the colony.
    bootstrapBuilders() {
      const { colonies, jumpPoints } = this.bootstrapSources
      const target = this.bootstrapTarget
      const places = Object.fromEntries(colonies.map((colony) => [colony.PopulationID, colony]))

      if (!target || !this.bootstrapRequirement || !places[target.PopulationID]) {
        return []
      }

      const builders = this.rows.filter((row) => row.PopulationID !== target.PopulationID && places[row.PopulationID]).map((row) => ({ colony: places[row.PopulationID], rate: idleConstruction(this.mappedConstruction(row), this.bootstrapUsage[`${row.PopulationID}-construction`]), stock: places[row.PopulationID].stock }))

      return builderOptions({ requirement: this.bootstrapRequirement, target: places[target.PopulationID], builders, jumpPoints })
    },

    bootstrapBuilderItems() {
      return this.bootstrapBuilders.map((builder) => ({ text: `${builder.colony.PopName}${builder.route ? ` (${builder.route.jumps} ${plural(builder.route.jumps, 'jump')})` : ' (no route)'}`, value: builder.colony.PopulationID }))
    },

    // The three routes to mining capacity at the colony: import, local industry and ground-force assistance.
    bootstrapRoutes() {
      const target = this.bootstrapTarget
      const requirement = this.bootstrapRequirement
      const place = target ? this.bootstrapSources.colonies.find((colony) => colony.PopulationID === target.PopulationID) : null

      if (!target || !requirement || !place) {
        return []
      }

      const { freighters, troops, ground, shuttleTechnology, problems } = this.bootstrapSources
      const modifiers = this.populationProductionModifiers[target.PopulationID]
      const mapped = withMappedEngineers(modifiers, ground, this.bootstrapVersion, target.PopulationID)
      const full = fullStaffModifiers(mapped || modifiers, target.Efficiency)
      const capacityNow = this.mappedConstruction(target)
      const usage = this.bootstrapUsage[`${target.PopulationID}-construction`]
      const workers = { now: target.workersNow, later: target.workersLater, cost: valueOrNull(target.r.cost) }
      const stock = place.stock
      const builder = this.bootstrapBuilders.find((option) => option.colony.PopulationID === this.bootstrapBuilderId) || this.bootstrapBuilders[0] || null
      const failed = (sources) => problems.filter((problem) => sources.includes(problem.source)).map((problem) => problem.text)

      return compareRoutes({
        requirement,
        target: place,
        local: { capacity: { now: capacityNow, full: full ? capacityResult(full, 'construction', this.blockedBonuses) : null }, usage, colony: target, workers, stock, gaps: failed(['projects']) },
        importing: { builder, freighters, shuttleTechnology, version: this.bootstrapVersion, workers, gaps: failed(['freight', 'jumps', 'colonies', 'handling', 'projects']) },
        ground: { ground, factor: modifiers, capacity: capacityNow, usage, version: this.bootstrapVersion, troopCapacity: troops, workers, stock, gaps: failed(['freight', 'projects']) },
        format: (value, decimals) => this.bootstrapNumber(value, decimals),
      })
    },
  },
  watch: {
    // A colony picked by a link opens expanded.
    focusRow(row, previous) {
      if (row && (!previous || previous.PopulationID !== row.PopulationID)) {
        this.expanded = [row]
        this.bootstrapColonyId = row.PopulationID
      }
    },
    // The first colony picked in the mine bootstrap panel starts its reads; a later pick reads nothing again.
    bootstrapColonyId(id) {
      if (id) {
        this.bootstrapPicked = true
      }
    },
    RaceID() {
      this.focusId = null
    },
  },
  methods: {
    // The words of the failed reads among `keys`, or the loading state until they have all settled.
    optionalState(keys) {
      const failed = keys.filter((key) => this.loadErrors[key])

      return { loading: failed.length === 0 && !allLoaded(this.loadErrors, keys), failed: joinLabels(failed.map((key) => INPUT_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
    },

    // Reads again the read of the colonist panel when it failed.
    retryColonistSources() {
      COLONIST_INPUTS.filter((key) => this.loadErrors[key]).forEach((key) => this.$asyncComputed[key].update())
    },

    // Reads again the reads of the mine bootstrap panel that failed, and the sources when one of them could not be read: the panel reads them once and a later pick does not read them again.
    retryBootstrapSources() {
      BOOTSTRAP_INPUTS.filter((key) => this.loadErrors[key] || (key === 'bootstrapSources' && this.bootstrapRetryable)).forEach((key) => this.$asyncComputed[key].update())
    },

    applyLink(query) {
      this.focusId = queryId(query.colony)
    },

    count(value) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, 0), this.separator) : '—'
    },
    millions(value) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, Math.abs(value) < 10 ? 2 : 1), this.separator) : '—'
    },
    people(millions) {
      return Number.isFinite(millions) ? peopleOf(millions) : '—'
    },
    routeFigures(route) {
      const figures = route.figures
      const results = figures.results || {}
      const bp = (value) => (Number.isFinite(value) ? `${this.count(value)} BP/yr` : '—')
      const daysOf = (value) => (Number.isFinite(value) ? `${this.bootstrapNumber(value, value < 10 ? 1 : 0)} ${plural(roundToDecimal(value, value < 10 ? 1 : 0), 'day')}` : '—')
      const counted = (value, one, many) => `${this.count(value)} ${plural(roundToDecimal(value, 0), one, many)}`
      const share = (value) => percent(value, 0)
      const tonnes = (value) => (Number.isFinite(value) ? `${this.count(value)} t` : '—')

      if (route.id === 'local' && figures.rate) {
        return [
          { label: 'Build time', text: daysOf(valueOrNull(figures.days)), result: figures.days },
          { label: 'Idle construction capacity', text: bp(valueOrNull(figures.rate)), result: figures.rate },
          { label: 'Capacity if fully staffed', text: bp(valueOrNull(figures.full)), result: figures.full },
          { label: 'Efficiency now', text: Number.isFinite(figures.efficiencyNow) ? share(figures.efficiencyNow) : '—', result: results.efficiencyNow },
          { label: 'Efficiency with the mines', text: Number.isFinite(figures.efficiencyAfter) ? share(figures.efficiencyAfter) : '—', result: results.efficiencyAfter },
        ]
      } else if (route.id === 'import' && figures.builder) {
        const labour = results.labour || {}

        return [
          { label: 'Built at', text: `${figures.builder.name}, ${Number.isFinite(figures.builder.jumps) ? counted(figures.builder.jumps, 'jump') : 'no route'}, ${daysOf(figures.builder.buildDays)}`, result: results.buildDays },
          { label: 'Freight', text: Number.isFinite(figures.freightDeficit) ? `${tonnes(valueOrNull(figures.tonnes))} in ${Number.isFinite(figures.trips) ? counted(figures.trips, 'trip') : '—'}, ${tonnes(figures.freightDeficit)} beyond one lift` : '—', result: results.freight || figures.tonnes },
          { label: 'Hauling time', text: daysOf(figures.haulDays), result: results.haulDays },
          { label: 'Hauling and build time', text: daysOf(figures.totalDays), result: results.totalDays },
          { label: 'Workers the mines need', text: this.people(figures.labour.needed), result: labour.needed },
          { label: 'Workers short for the mines, now', text: this.people(figures.labour.deficitNow), result: labour.deficitNow },
          { label: 'Workers short at the colony before the mines', text: this.people(figures.labour.existingNow), result: labour.existingNow },
        ]
      } else if (route.id === 'ground' && figures.candidates) {
        const carried = figures.carried ? figures.carried.length : figures.candidates.length

        return [
          { label: 'Engineers that can move', text: `${counted(carried, 'formation')} of ${figures.candidates.length}, ${bp(figures.added)}`, result: results.added },
          { label: 'Engineers already at the colony', text: bp(figures.present), result: results.present },
          { label: 'Build rate now', text: bp(figures.rateNow), result: results.rateNow },
          { label: 'Build rate with them', text: bp(figures.rateWith), result: results.rateWith },
          { label: 'Build time now', text: daysOf(figures.daysNow), result: results.daysNow },
          { label: 'Build time with them', text: daysOf(figures.daysWith), result: results.daysWith },
          { label: 'Troop capacity needed, held', text: figures.troopCapacity ? `${tonnes(figures.troopNeeded)}, ${tonnes(figures.troopCapacity.lift)}` : '—', result: results.troop },
        ]
      }

      return []
    },
    bootstrapNumber(value, decimals) {
      return separatedNumber(roundToDecimal(value, decimals), this.separator)
    },
    // The colony's construction capacity with the engineers at it counted by the mapped command rule, as the ground route counts them; the Production page's figure when the rule is not mapped for the save, and unavailable (naming the formations) when a figure of the engineers is unknown.
    mappedConstruction(row) {
      const modifiers = this.populationProductionModifiers[row.PopulationID]
      const { ground } = this.bootstrapSources
      const gap = engineerCapacityGap(modifiers, ground, this.bootstrapVersion, row.PopulationID)
      const mapped = withMappedEngineers(modifiers, ground, this.bootstrapVersion, row.PopulationID)

      return gap || (mapped ? capacityResult(mapped, 'construction', this.blockedBonuses) : row.r.construction)
    },
    routeColor(status) {
      return { works: 'success', limited: 'warning', blocked: 'error' }[status]
    },
    percent,
    years(months) {
      return months < 12 ? `${Math.max(1, months)} mo` : `${roundToDecimal(months / 12, 1)} y`
    },
    freeLabel(free) {
      if (!Number.isFinite(free)) {
        return '—'
      } else if (Math.abs(free) < WORKER_TOLERANCE) {
        return 'Balanced'
      }

      return free < 0 ? `${this.people(-free)} short` : `${this.people(free)} free`
    },
    inboundLabel(inbound) {
      return [inbound.Colonists ? `${this.people(inbound.Colonists)} colonists` : null, inbound.Infrastructure ? `${this.count(inbound.Infrastructure)} infrastructure` : null, inbound.Installations ? `${this.count(inbound.Installations)} installations` : null].filter(Boolean).join(', ')
    },
    missingText(result) {
      return result.inputs.missing.length ? `missing ${result.inputs.missing.join(', ')}` : 'an input is missing'
    },
    fillTitle(row) {
      return row.capacity === null ? 'Body capacity is unavailable' : `Body holds ${this.people(row.capacity)}; growth slows past a third`
    },
    fillCaption(row) {
      return row.capacity === null ? '—' : `${percent(row.fill, 0)} of ${this.people(row.capacity)}`
    },
    arkCaption(ark) {
      const occupied = valueOrNull(ark.occupied)

      return occupied === null ? '+ people aboard Arks in orbit: —' : `+ ${this.people(occupied)} aboard Arks in orbit`
    },
    speciesLabel(result) {
      const species = valueOrNull(result)

      if (species === null) {
        return '—'
      } else if (!species.length) {
        return 'None aboard'
      }

      return species.length === 1 ? species[0].name : species.map((entry) => `${entry.name} ${this.people(entry.amount)}`).join(', ')
    },
    orbitText(ship) {
      if (!ship.orbit) {
        return `Unknown, ${this.missingText(ship.results.orbit)}`
      }

      return ship.orbit.counted ? (ship.orbit.PopulationID ? 'At its colony' : 'At a colony, assigned by the game') : ORBIT_REASONS[ship.orbit.reason]
    },
    // A column of null-last values: an unavailable figure sorts after every number, in either direction, never as 0.
    sortRows(items, sortBy, sortDesc) {
      const [by] = sortBy

      if (!by) {
        return items
      }

      const direction = sortDesc[0] ? -1 : 1
      const missing = (value) => value === null || value === undefined

      return [...items].sort((a, b) => {
        const x = a[by]
        const y = b[by]

        if (missing(x) || missing(y)) {
          return missing(x) === missing(y) ? 0 : missing(x) ? 1 : -1
        }

        return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y) * direction
      })
    },

    infrastructureStatus(row) {
      if (row.perMillion === null) {
        return { label: '—', note: '', icon: null, muted: true, mark: row.r.rate }
      } else if (row.perMillion === 0) {
        return { label: 'Not needed', note: 'No colony cost', icon: null, muted: true, mark: row.r.rate }
      } else if (row.infrastructureCap === null) {
        return { label: '—', note: '', icon: null, muted: true, mark: row.r.cap }
      }

      const supports = `Supports ${this.people(row.infrastructureCap)}`

      if (!row.projection) {
        return { label: supports, note: `${this.count(row.perMillion)} per million, no projection`, icon: null, mark: row.r.projection }
      } else if (row.projection.infrastructureAt === 0) {
        return { label: 'At its cap', note: supports, icon: 'mdi-alert-octagon', color: 'error', mark: row.r.projection }
      } else if (row.projection.infrastructureAt !== null) {
        return { label: `Cap in ${this.years(row.projection.infrastructureAt)}`, note: supports, icon: 'mdi-alert', color: 'warning', mark: row.r.projection }
      }

      return { label: supports, note: `${this.count(row.perMillion)} per million`, icon: null, mark: row.r.projection }
    },

    workerSegments(workers) {
      const total = Math.max(workers.population, workers.service + workers.agriculture + workers.required)

      if (!(total > 0)) {
        return []
      }

      const employed = Math.min(workers.available, workers.required)
      const segments = [
        { key: 'service', value: workers.service },
        { key: 'agriculture', value: workers.agriculture },
        { key: 'employed', value: employed },
        { key: 'free', value: Math.max(0, workers.free) },
        { key: 'short', value: Math.max(0, -workers.free), className: 'segment-short' },
      ]

      return segments.filter((segment) => segment.value > 0).map((segment) => ({ ...segment, style: { ...this.workerStyles[segment.key], width: `${(segment.value / total) * 100}%` } }))
    },
    workerTitle(workers) {
      return `${this.millions(workers.available)} M can work, ${this.millions(workers.required)} M needed`
    },
    workerValue(workers, key, population) {
      return workers ? workers[key] : key === 'population' ? population : null
    },
    workerNote(row) {
      if (row.freeNow === null) {
        return 'The worker split is unavailable for this colony.'
      } else if (row.freeLater === null) {
        return `${row.shortNow ? `Short of ${this.people(-row.freeNow)} now. ` : ''}The worker split in ${this.horizon} years is unavailable.`
      } else if (row.shortLater) {
        return `Short of ${this.people(-row.freeLater)} in ${this.horizon} years at ${this.committedView ? 'the installations counted' : 'today\'s installations'}: hold off on new ones, or bring colonists.`
      } else if (row.shortNow) {
        return `Growth closes the gap within ${this.horizon} years.`
      }

      return `Room for about ${this.count(Math.floor(Math.max(0, row.freeLater) / 0.05))} more factories, mines or similar (50,000 workers each) by then.`
    },

    // What the queue and the shipyard upgrades add to the workers a colony needs: its result of 'colonies.committedWorkers', unavailable while the forecast it rests on is running or lacks a figure.
    committedOf(colony, results) {
      const id = colony.PopulationID
      const needs = this.workforceNeedsByColony[id] || { missing: [], installation: [], yards: [] }
      const run = this.forecastCurrent
      let forecast = null

      if (needs.installation.length) {
        const plan = this.industryPlans[id]

        forecast = !plan ? { gaps: ['the colony\'s industrial projects'] } : plan.gaps ? plan : run ? (run.error ? { gaps: [`the forecast of the colony failed (${run.error})`] } : (run.colonies && run.colonies[id]) || null) : null
      }

      return committedWorkforce({ colony, workersNow: results.workersNow, cost: results.cost, projection: results.projection, needs, forecast, modifiers: this.populationProductionModifiers[id], npr: this.RaceNPR })
    },
    committedNote(row) {
      if (!row.committed) {
        return `What the queue and the shipyard upgrades add is unavailable, ${this.missingText(row.committedResult)}.`
      } else if (!row.events.length) {
        return 'No queued installation or shipyard upgrade changes the workers needed.'
      }

      const during = row.duringNote ? ` ${row.duringNote}.` : ''

      if (row.laterRange) {
        return `The first figure counts only the completions the forecast supports; "At worst" counts every completion that could happen by then${row.mayBeShortLater ? ', and the colony is not certain to be short of workers but may be' : ''}.${during}`
      }

      return `Every completion the forecast supports is counted at its date.${during}`
    },
    duringNote(row) {
      const { committed } = row
      const month = (index) => `month ${index}`
      const back = (index) => (index === null ? '' : `, back by ${month(index)}`)

      if (row.shortInBetween && row.mayBeShortLater) {
        const { best, worstAfterBest: worst } = committed.recovery
        const start = `Short of workers from ${month(committed.firstShort.best)}`

        return worst === null ? `${start}, back by ${month(best)} at best; still short at worst at ${this.horizon} y` : `${start}, back by ${month(best)}${worst === best ? '' : ` at best, ${month(worst)} at worst`}; short again at worst by ${this.horizon} y`
      } else if (row.shortInBetween && row.recoveryAtBestOnly) {
        return `Short of workers from ${month(committed.firstShort.best)}, back by ${month(committed.recovery.best)} at best, ${month(committed.recovery.worstAfterBest)} at worst`
      } else if (row.shortInBetween) {
        return `Short of workers from ${month(committed.firstShort.best)}${back(committed.recovery.best)}`
      } else if (row.mayBeShortDuring && !row.mayBeShortLater) {
        return `May be short of workers at worst from ${month(committed.firstShort.worst)}${back(committed.recovery.worst)}`
      }

      return ''
    },
    eventStatus(event) {
      return EVENT_STATUS[event.status] || event.status
    },
    eventWhen(event) {
      if (event.earliest === null || event.latest === null) {
        return '—'
      }

      const earliest = Math.round(event.earliest)
      const latest = Math.round(event.latest)

      return `${event.approximate ? 'About day' : 'Day'} ${earliest === latest ? earliest : `${earliest} to ${latest}`}`
    },
    eventEffect(event) {
      const workers = event.delta * event.units

      return workers === 0 || !Number.isFinite(workers) ? '—' : `${workers > 0 ? '+' : ''}${this.millions(workers)} M`
    },

    projectionChart(row) {
      const color = this.theme.primary
      const points = row.projection.series.map((value, month) => ({ x: month / 12, y: value }))
      const peak = Math.max(...row.projection.series)
      // `values` are monthly, like the projection; a limit at or below zero isn't drawn.
      const ceiling = (label, values, dash) => ({
        label,
        data: values.map((value, month) => ({ x: month / 12, y: value > 0 ? value : null })),
        borderColor: this.theme.inkMuted,
        borderDash: dash,
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
      })
      const datasets = [{ label: 'Population', data: points, borderColor: color, backgroundColor: withAlpha(color, 0.1), fill: 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 }]

      // Only limits near the curve: one far above it would flatten it (the note names it instead). Other populations on the body grow too, so the body's limits for this colony move with them.
      const near = (values) => values.some((value) => value > 0 && value !== Infinity && value <= peak * 2)
      const limits = [
        ['Growth slows', row.otherSeries.map((other) => row.capacity / 3 - other), [2, 3]],
        ['Infrastructure cap', row.otherSeries.map(() => row.infrastructureCap), [6, 4]],
        ['Body capacity', row.otherSeries.map((other) => row.capacity - other), [10, 4]],
      ]

      limits.filter(([, values]) => near(values)).forEach(([label, values, dash]) => datasets.push(ceiling(label, values, dash)))

      return { datasets }
    },
    projectionOptions() {
      return {
        scales: {
          x: { type: 'linear', min: 0, max: this.horizon, title: { display: true, text: 'Years from now' } },
          y: { grace: '5%', ticks: { callback: (value) => peopleOf(value) } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => `Year ${roundToDecimal(items[0].parsed.x, 1)}`,
              label: (item) => `${item.dataset.label}: ${peopleOf(item.parsed.y)}`,
            },
          },
        },
      }
    },
    // The note under the chart as parts, each with the results whose marks follow it.
    projectionNote(row) {
      const notes = []
      const r = row.r

      if (row.infrastructureCap !== null && row.infrastructureCap !== Infinity) {
        notes.push({ text: row.projection && row.projection.infrastructureAt !== null ? `Infrastructure stops growth at ${this.people(row.infrastructureCap)}.` : `Infrastructure supports ${this.people(row.infrastructureCap)}.`, results: [row.projection ? r.projection : r.cap] })
      }

      if (row.infrastructureNeeded === null) {
        notes.push({ text: 'The infrastructure to keep it growing is unavailable.', results: [r.needed] })
      } else if (row.infrastructureNeeded > 0) {
        const bp = row.infrastructureBP
        const share = bp !== null && row.constructionBP > 0 ? ` (${this.years(Math.max(1, Math.ceil((bp / row.constructionBP) * 12)))} of this colony's construction)` : ''

        notes.push({ text: `${this.count(row.infrastructureNeeded)} more infrastructure, ${bp === null ? 'cost unavailable' : `${this.count(bp)} BP${share}`}, keeps it growing for ${this.horizon} years.`, results: [r.needed, ...(bp === null ? [r.neededCost] : share ? [r.construction] : [])] })
      }

      if (row.capacity === null) {
        notes.push({ text: 'Body capacity is unavailable, so crowding is unknown.', results: [r.capacity] })
      } else {
        notes.push({ text: row.fill !== null && row.fill > 1 / 3 ? 'Past a third of the body\'s capacity, so growth is slowing.' : `Growth starts slowing at ${this.people(row.capacity / 3)} on this body.`, results: [row.fill === null ? r.capacity : r.fill] })
      }

      if (row.inbound && row.inbound.Colonists) {
        notes.push({ text: `Includes ${this.people(row.inbound.Colonists)} colonists on their way.`, results: [] })
      }

      return notes
    },
  },
  asyncComputed: {
    colonies: {
      get: tracked('colonies', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Efficiency, FCT_Population.ReqInf, FCT_Population.Capital, FCT_Population.SpeciesID, FCT_Species.SpeciesName, FCT_Species.PopulationGrowthModifier, FCT_Species.PopulationDensityModifier, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Radius, FCT_SystemBody.HydroExt, FCT_SystemBody.TidalLock, FCT_SystemBody.RadiationLevel, case when FCT_SystemBody.Gravity < FCT_Species.Gravity - FCT_Species.GravDev then 1 else 0 end as LowGravity, coalesce(VIR_Installations.Infrastructure, 0) as Infrastructure, coalesce(VIR_Installations.LGInfrastructure, 0) as LGInfrastructure, coalesce(VIR_Installations.Workers, 0) as InstallationWorkers, coalesce(VIR_Yards.Workers, 0) as YardWorkers, coalesce(VIR_Governor.BonusValue, 1) * (1 + (coalesce(VIR_Sector.BonusValue, 1) - 1) * 0.25) as PopulationGrowthBonus, VIR_Body.Population as BodyPopulation, VIR_InfrastructureCost.InfrastructureCost from FCT_Population inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID cross join (select min(case when DIM_PlanetaryInstallation.InfrastructureValue > 0 then DIM_PlanetaryInstallation.Cost end) as InfrastructureCost from DIM_PlanetaryInstallation) as VIR_InfrastructureCost left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.InfrastructureValue * FCT_PopulationInstallations.Amount) as Infrastructure, sum(DIM_PlanetaryInstallation.LGInfrastructureValue * FCT_PopulationInstallations.Amount) as LGInfrastructure, sum(DIM_PlanetaryInstallation.Workers * FCT_PopulationInstallations.Amount) as Workers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID left join (select FCT_Shipyard.PopulationID, sum(FCT_Shipyard.Capacity * FCT_Shipyard.Slipways * case FCT_Shipyard.SYType when 1 then 1.0 else 0.1 end) / 4000.0 as Workers from FCT_Shipyard where FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID} group by FCT_Shipyard.PopulationID) as VIR_Yards on VIR_Yards.PopulationID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 8 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 8 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_Sector on VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 left join (select FCT_Population.SystemBodyID, sum(FCT_Population.Population) as Population from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemBodyID) as VIR_Body on VIR_Body.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Population > 0 order by FCT_Population.Population desc`).then(([items]) => (blocked.has(POPULATION_GROWTH_BONUS) ? items.map((item) => ({ ...item, PopulationGrowthBonus: null })) : items))
      }),
      default: [],
    },
    // Colonists (millions) and installations in cargo, by the colony an unload order sends them to.
    inbound: {
      get: tracked('inbound', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.PopulationID, sum(case when FCT_MoveOrders.MoveActionID = 6 and FCT_ShipCargo.CargoTypeID = 1 then FCT_ShipCargo.Amount else 0 end) / 1000000.0 as Colonists, sum(case when FCT_MoveOrders.MoveActionID in (96, 177) and FCT_ShipCargo.CargoTypeID = 2 then FCT_ShipCargo.Amount * (coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0)) else 0 end) as Infrastructure, sum(case when FCT_MoveOrders.MoveActionID in (96, 177) and FCT_ShipCargo.CargoTypeID = 2 and coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0) = 0 then FCT_ShipCargo.Amount else 0 end) as Installations from FCT_MoveOrders inner join FCT_Ship on FCT_Ship.FleetID = FCT_MoveOrders.FleetID inner join FCT_ShipCargo on FCT_ShipCargo.ShipID = FCT_Ship.ShipID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_ShipCargo.CargoID and FCT_ShipCargo.CargoTypeID = 2 where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.MoveActionID in (6, 96, 177) and FCT_MoveOrders.PopulationID <> 0 group by FCT_MoveOrders.PopulationID`).then(([items]) => items)
      }),
      default: [],
    },
    // The race's Ark ships, their cargo and the colonies they can sit at.
    arks: {
      get: tracked('arks', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { ships: [], cargo: [], colonies: [] }
        }

        return await loadArks(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: () => ({ ships: [], cargo: [], colonies: [] }),
    },
    // The industrial projects with what each is made of, as the queue forecast takes them; read only with the queue counted.
    industry: {
      get: tracked('industry', async function () {
        const committed = this.committedView

        if (!committed || !this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const needs = MINERALS.map((mineral) => `FCT_IndustrialProjects.${mineral.name}`).join(', ')
        const stocks = MINERALS.map((mineral) => `FCT_Population.${mineral.name} as Stock${mineral.name}`).join(', ')

        const [rows] = await this.database.query(`select FCT_IndustrialProjects.ProjectID as ID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.ProductionID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.Description as Name, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.PartialCompletion, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Pause as Paused, FCT_IndustrialProjects.FuelRequired, ${needs}, ${stocks}, FCT_Population.FuelStockpile as StockFuel, DIM_PlanetaryInstallation.ConversionFrom as ConversionFrom, case when DIM_PlanetaryInstallation.ConversionFrom is null then null else (select case when sum(FCT_PopulationInstallations.Amount is null) > 0 then null else coalesce(sum(FCT_PopulationInstallations.Amount), 0) end from FCT_PopulationInstallations where FCT_PopulationInstallations.PopID = FCT_IndustrialProjects.PopulationID and FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.ConversionFrom) end as ConversionSource from FCT_IndustrialProjects inner join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_IndustrialProjects.ProductionID and FCT_IndustrialProjects.ProductionType = 0 and DIM_PlanetaryInstallation.ConversionTo > 0 where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    // The shipyard activities under way (an upgrade or a retool) with the stock of the two minerals an upgrade takes; read only with the queue counted.
    yardActivities: {
      get: tracked('yardActivities', async function () {
        const committed = this.committedView

        if (!committed || !this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.TaskType as UpgradeTaskType, FCT_Shipyard.RequiredBP - FCT_Shipyard.CompletedBP as RemainingProduction, FCT_Shipyard.PauseActivity as Paused, FCT_Shipyard.CapacityTarget, FCT_Population.Duranium as StockDuranium, FCT_Population.Neutronium as StockNeutronium from FCT_Shipyard inner join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID where FCT_Shipyard.TaskType <> 0 and FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },
    // The workers one of each installation type needs: { [PlanetaryInstallationID]: { Workers } }; read only with the queue counted.
    installationTypes: {
      get: tracked('installationTypes', async function () {
        const committed = this.committedView

        if (!committed || !this.database) {
          return {}
        }

        const [rows] = await this.database.query('select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Workers from DIM_PlanetaryInstallation')

        return Object.fromEntries(rows.map((row) => [row.PlanetaryInstallationID, { Workers: row.Workers }]))
      }),
      default: {},
    },
    // Everything the mine bootstrap panel compares, read only once a colony is picked there and kept for the later picks: the mine types, the colonies' places, shuttle service and stock, the projects that hold construction capacity, the freighters and troop ships, the ground formations with their commanders, the charted jump points and the cargo shuttle technology.
    bootstrapSources: {
      get: tracked('bootstrapSources', async function () {
        if (!this.bootstrapPicked || !this.database || !this.GameID || !this.RaceID) {
          return NO_BOOTSTRAP_SOURCES
        }

        return await loadBootstrapSources(this.database, { GameID: this.GameID, RaceID: this.RaceID, blocked: this.blockedBonuses })
      }),
      default: NO_BOOTSTRAP_SOURCES,
    },
    // The formula version the save's schema stands for, read with the mine bootstrap sources: null for a save without the formula columns.
    bootstrapVersion: {
      get: tracked('bootstrapVersion', async function () {
        if (!this.bootstrapPicked || !this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
    // The colonist source fields of the race's colonies (role, status, emigrant pool and pressure), read for the colonist floor panel.
    colonistSources: {
      get: tracked('colonistSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_COLONIST_SOURCES
        }

        return await loadColonistSources(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: NO_COLONIST_SOURCES,
    },
  },
}

function leftOut(unknown, total) {
  return unknown ? ` · ${unknown} of ${total} colonies not counted` : ''
}

function percent(fraction, decimals) {
  return Number.isFinite(fraction) ? `${roundToDecimal(fraction * 100, decimals).toFixed(decimals)}%` : '—'
}
</script>

<style lang="scss">
.outlook-page {
  .search-field {
    min-width: 240px;
  }

  .chart-title {
    font-size: calc(14px * var(--ae-font-scale));
    font-weight: 500;
    margin-bottom: 8px;
  }

  .note-part:not(:last-child) {
    margin-right: 6px;
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    margin-right: 6px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .colony-table,
  .ark-table {
    td:first-child,
    th:first-child {
      min-width: 180px;
    }
  }

  .meter {
    position: relative;
    flex: 1 1 72px;
    min-width: 48px;
    max-width: 240px;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
    background-color: var(--ae-muted);
  }

  .meter-tick {
    position: absolute;
    top: -2px;
    left: 33.3%;
    width: 1px;
    height: 10px;
    background: currentColor;
    opacity: 0.5;
  }

  .fill-cell,
  .worker-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .worker-bar {
    display: flex;
    flex: 1 1 120px;
    min-width: 64px;
    max-width: 360px;
    height: 10px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--ae-track-soft);
  }

  .worker-segment {
    height: 100%;
  }

  .route-card {
    height: 100%;
    padding: 8px 12px;
    border: 1px solid var(--ae-border, rgba(128, 128, 128, 0.35));
    border-radius: 4px;
  }

  .route-list {
    margin: 0 0 6px;
    padding-left: 18px;
  }

  .route-figures td {
    padding: 1px 8px 1px 0;
  }

  .segment-short,
  .swatch-short {
    background-image: repeating-linear-gradient(-45deg, var(--ae-shortfall) 0, var(--ae-shortfall) 3px, transparent 3px, transparent 6px) !important;
  }

  .worker-table td,
  .worker-table th {
    font-variant-numeric: tabular-nums;
  }
}
</style>
