<template>
  <div>
    <v-container fluid class="minerals-page">
      <v-alert v-if="failedInputs.length" type="error" outlined dense>
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--mineral">
            <div class="tool__label caption text--secondary">Mineral</div>
            <v-select :value="focusId" :items="mineralItems" item-text="name" item-value="id" aria-label="Mineral" prepend-inner-icon="mdi-diamond-stone" dense outlined hide-details @change="setFocus" />
          </div>
          <div class="tool tool--reach">
            <div class="tool__label caption text--secondary">Systems</div>
            <v-select :value="reach" :items="reachItems" item-text="label" item-value="id" aria-label="Systems" :disabled="!!selection" dense outlined hide-details @change="setReach">
              <template #item="{ item }">
                <v-list-item-content>
                  <v-list-item-title>{{ item.label }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.note }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-select>
          </div>
          <div v-if="selection" class="tool tool--selection">
            <div class="tool__label caption text--secondary">Picked</div>
            <v-chip label close class="selection-chip" close-label="Show every system again" :title="selection.title" @click:close="clearSelection">{{ selection.label }}</v-chip>
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="440">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Deposit options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">Bodies</div>
                <v-radio-group v-model="orbital" dense hide-details class="mt-1" @change="(value) => config.set('mineralsFilterOrbitalEligibility', value)">
                  <v-radio v-for="option in orbitalOptions" :key="option.value" :value="option.value" :label="option.text" />
                </v-radio-group>
                <div class="caption text--secondary mt-1">Your orbital miners work bodies up to {{ count(raceRules.MaximumOrbitalMiningDiameter) }} km across.</div>
                <div class="subtitle-2 mt-4">Deposits</div>
                <v-row dense class="mt-1">
                  <v-col cols="6">
                    <v-select v-model="minAccessibility" :items="accessibilitySteps" label="Accessibility from" dense outlined hide-details @change="(value) => saveSetting('mineralsMinAccessibility', value)" />
                  </v-col>
                  <v-col cols="6">
                    <v-text-field v-model.number="minAmount" type="number" min="0" label="Tonnes from" dense outlined hide-details clearable @change="(value) => saveSetting('mineralsMinAmount', Number(value) > 0 ? Number(value) : null)" />
                  </v-col>
                </v-row>
                <v-btn v-if="activeOptionCount" text small class="mt-3" @click="resetOptions">Reset options</v-btn>
              </v-card>
            </v-menu>
          </div>
        </div>

        <v-row class="mt-1">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value text-truncate" :title="tile.title || tile.value">{{ tile.value }}</div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <v-row>
          <v-col cols="12" xl="7">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>By mineral</span>
                <router-link v-if="focus" :to="{ path: '/mineral-outlook', query: { mineral: String(focus.id) } }" class="body-2">{{ focus.name }} runway in Mineral Outlook</router-link>
              </div>
              <v-simple-table dense class="overview-table">
                <thead>
                  <tr>
                    <th>Mineral</th>
                    <th>In the ground</th>
                    <th class="text-right">Deposits</th>
                    <th>Best untapped</th>
                    <th class="text-right">In stock</th>
                    <th class="text-right">Free to move</th>
                    <th>Colonies</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in overviewRows" :key="row.id" :class="{ 'is-selected-row': row.id === focusId }" class="overview-row" tabindex="0" @click="setFocus(row.id === focusId ? 0 : row.id)" @keydown.enter="setFocus(row.id === focusId ? 0 : row.id)">
                    <td class="font-weight-medium">{{ row.name }}</td>
                    <td>
                      <div class="band-cell">
                        <div class="band-meter" :title="bandTitle(row)">
                          <div v-for="band in bands" :key="band.id" class="band-meter__part" :style="{ width: `${row.amount ? (row.bands[band.id] / row.amount) * 100 : 0}%`, background: bandColors[band.id] }" />
                        </div>
                        <span class="text-no-wrap" :title="`${count(row.amount)} t`">{{ row.amount ? compact(row.amount) : '—' }}</span>
                      </div>
                    </td>
                    <td class="text-right">
                      <div>{{ count(row.deposits) }}</div>
                      <div class="caption text--secondary text-no-wrap">{{ row.worked ? `${count(row.worked)} mined` : 'none mined' }}</div>
                    </td>
                    <td>
                      <template v-if="row.best">
                        <div class="text-no-wrap">{{ row.best.name }}</div>
                        <div class="caption text--secondary text-no-wrap">{{ compact(row.best.deposit.Amount) }} at {{ row.best.deposit.Accessibility }}<span v-if="row.best.distance"> · {{ distanceText(row.best.distance) }}</span></div>
                      </template>
                      <span v-else class="text--secondary">—</span>
                    </td>
                    <td class="text-right text-no-wrap" :title="`${count(row.stock)} t`">{{ row.stock ? compact(row.stock) : '—' }}</td>
                    <td class="text-right text-no-wrap" :title="`${count(row.free)} t`">{{ row.free ? compact(row.free) : '—' }}</td>
                    <td class="text-no-wrap">
                      <span v-if="row.short" class="error--text">{{ row.short }} short</span>
                      <span v-if="row.short && row.below" class="text--secondary"> · </span>
                      <span v-if="row.below" class="warning--text">{{ row.below }} below reserve</span>
                      <span v-if="!row.short && !row.below" class="text--secondary">—</span>
                    </td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div class="panel-foot caption text--secondary">
                Click a mineral to focus the page on it, and again for all minerals. In the ground counts the deposits in the chosen systems that pass the options, split by accessibility; a deposit is mined when a colony of yours on the body has mines or your orbital miners are there, and untapped when nobody mines it and no known alien colony holds the body. Colonies short need more for their build queue than they hold; below reserve hold less than the reserve set for them.
              </div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="5">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>Where it lies</span>
                <span class="legend">
                  <span v-for="band in bands" :key="band.id" class="legend-item"><span class="dot" :style="{ background: bandColors[band.id] }" />{{ band.label }}</span>
                  <span class="legend-item"><span class="dot" :style="{ background: mutedColor }" />None or out of reach</span>
                  <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Your colonies</span>
                </span>
              </div>
              <div class="panel-body">
                <system-map :systems="mapNodes" :links="mapLinks" :selected="mapSelected" :height="mapHeight" :aria-label="`Known systems sized by the ${focusName} in their deposits`" @select="selectSystem" />
                <div class="caption text--secondary">Positions as on the game's galactic map. Size shows the tonnes of {{ focusName }} in the deposits that pass the options and the deposit view; colour, the best accessibility among them. Click a system to list only its deposits and colonies, and again to show them all.</div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>{{ focus ? `${focus.name} deposits` : 'Bodies with deposits' }}</span>
            <span class="head-tools">
              <v-btn-toggle :value="depositView" mandatory dense @change="setDepositView">
                <v-btn v-for="view in depositViews" :key="view.id" :value="view.id" small>{{ view.label }}&nbsp;<span class="text--secondary">{{ count(viewCounts[view.id]) }}</span></v-btn>
              </v-btn-toggle>
              <v-text-field v-model="search" label="Search" placeholder="Body or system" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <div v-if="selectedRows.length" class="selection-bar">
            <span class="body-2">{{ counted(selectedRows.length, 'body', 'bodies') }} picked</span>
            <v-btn small outlined :to="plannerLink(selectedRows)">Open in Colonization Planner</v-btn>
            <v-btn small text @click="selectedRows = []">Clear</v-btn>
          </div>
          <v-data-table v-model="selectedRows" :headers="depositHeaders" :items="depositRows" item-key="SystemBodyID" show-select show-expand single-expand :expanded.sync="depositExpanded" :sort-by.sync="depositSortBy" :sort-desc.sync="depositSortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" :no-data-text="bodies.length ? 'No deposits match the systems, options and search.' : 'No surveyed body has deposits yet.'">
            <template #[`item.nameSort`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                <div class="caption text--secondary text-no-wrap">{{ item.place }}</div>
              </div>
            </template>
            <template #[`item.amount`]="{ item }">
              <div v-if="focus" class="text-no-wrap" :title="`${count(item.amount)} t`">{{ compact(item.amount) }}</div>
              <div v-else class="py-2">
                <div class="mineral-strip">
                  <span v-for="cell in item.cells" :key="cell.id" class="mineral-strip__cell" :class="{ 'mineral-strip__cell--empty': !cell.deposit, 'mineral-strip__cell--out': cell.deposit && !cell.passes }" :style="cell.deposit && cell.passes ? { background: withAlpha(bandColors[cell.band], 0.3), borderBottomColor: bandColors[cell.band] } : {}" :title="cell.title">{{ cell.short }}</span>
                </div>
                <div class="caption text--secondary text-no-wrap" :title="`${count(item.amount)} t`">{{ compact(item.amount) }} in {{ counted(item.minerals, 'mineral', 'minerals') }}</div>
              </div>
            </template>
            <template #[`item.accessibility`]="{ item }">
              <div class="py-2">
                <div class="band-cell">
                  <div class="meter"><div class="meter-fill" :style="{ width: `${item.accessibility * 100}%`, background: bandColors[item.band] }" /></div>
                  <span>{{ item.accessibility }}</span>
                </div>
                <div class="caption text--secondary text-no-wrap">{{ depletionText(item.deposit) }}</div>
              </div>
            </template>
            <template #[`item.perMine`]="{ item }">
              <span class="text-no-wrap">{{ count(item.perMine) }} t/yr</span>
            </template>
            <template #[`item.potential`]="{ item }">
              <span :class="{ 'success--text font-weight-medium': item.potential >= 7.5, 'text--secondary': item.potential <= 3 }" :title="item.potentialTitle">{{ roundToDecimal(item.potential, 1) }}</span>
            </template>
            <template #[`header.potential`]="{ header }">
              <v-tooltip top max-width="400">
                <template #activator="{ on }">
                  <span v-on="on">{{ header.text }}<v-icon x-small class="ml-1">mdi-information-outline</v-icon></span>
                </template>
                <span>{{ potentialHint }}</span>
              </v-tooltip>
            </template>
            <template #[`item.mining`]="{ item }">
              <div class="chip-cell">
                <v-tooltip v-if="item.body.orbitalEligible" top max-width="320">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined v-on="on">Orbital</v-chip>
                  </template>
                  <span>{{ count(item.body.Diameter) }} km across: your orbital miners can work it (up to {{ count(raceRules.MaximumOrbitalMiningDiameter) }} km), with no colony.</span>
                </v-tooltip>
                <v-tooltip v-if="item.body.complexes" top max-width="360">
                  <template #activator="{ on }">
                    <v-chip x-small label color="teal darken-1" dark v-on="on"><v-icon x-small left>mdi-pickaxe</v-icon>CMC ×{{ item.body.complexes }}</v-chip>
                  </template>
                  <span>{{ cmcText(item.body) }}</span>
                </v-tooltip>
                <v-tooltip v-else-if="raceRules.AllowCMC && item.body.cmcCandidate" top max-width="360">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined v-on="on">CMC</v-chip>
                  </template>
                  <span>Could host a civilian mining complex: more than 10,000 t of {{ item.body.cmcCandidate }} at accessibility 0.7 or better, and the body is close enough to its star. The game founds one only if one of your colonies in the system has over 10 M people, the body has no colony (one of yours with only orbital miners is fine) and isn't banned, and its star is in reach (a companion star within 80 AU of what it orbits, or linked by Lagrange points). It then rolls 1 in 3 for each such body, richest first. The Colonization Planner checks every condition per body.</span>
                </v-tooltip>
                <v-tooltip v-if="item.body.GroundMineralSurvey" top max-width="320">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined to="/survey-progress" v-on="on">Ground: {{ groundSurvey[item.body.GroundMineralSurvey] }}</v-chip>
                  </template>
                  <span>A ground survey can still find more deposits here (potential {{ groundSurvey[item.body.GroundMineralSurvey] }}). Survey Progress tracks the teams on it.</span>
                </v-tooltip>
              </div>
            </template>
            <template #[`item.workedSort`]="{ item }">
              <div class="py-2 worker-cell">
                <div v-for="worker in item.body.workers" :key="worker.key" class="wrap-cell">
                  <span :class="{ 'warning--text': worker.alien }">{{ worker.text }}</span>
                  <span class="caption text--secondary"> · {{ worker.note }}</span>
                </div>
                <span v-if="!item.body.workers.length" class="text--secondary">—</span>
              </div>
            </template>
            <template #[`item.distanceSort`]="{ item }">
              <div v-if="item.body.distance" class="py-2 ml-auto distance-cell">
                <div class="text-no-wrap">{{ distanceText(item.body.distance) }}</div>
                <div class="caption text--secondary text-truncate" :title="item.body.distance.from.PopName">from {{ item.body.distance.from.PopName }}</div>
              </div>
              <span v-else class="text--secondary text-no-wrap">No route</span>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="expand-cell">
                <v-simple-table dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Mineral</th>
                      <th class="text-right">In the ground</th>
                      <th>Accessibility</th>
                      <th class="text-right">Per mine</th>
                      <th class="text-right">Potential</th>
                      <th>Depletion</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="deposit in item.body.depositList" :key="deposit.MaterialID" :class="{ 'text--disabled': !passesDeposit(deposit) }">
                      <td class="font-weight-medium">{{ mineralName(deposit.MaterialID) }}</td>
                      <td class="text-right" :title="`${count(deposit.Amount)} t`">{{ compact(deposit.Amount) }}</td>
                      <td>{{ deposit.Accessibility }}<span v-if="deposit.OriginalAcc && deposit.OriginalAcc !== deposit.Accessibility" class="caption text--secondary"> (was {{ deposit.OriginalAcc }})</span></td>
                      <td class="text-right">{{ count(raceRules.MineProduction * deposit.Accessibility) }} t/yr</td>
                      <td class="text-right">{{ roundToDecimal(depositPotential(deposit), 1) }}</td>
                      <td>{{ depletionText(deposit, true) }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div class="detail-links body-2">
                  <router-link :to="plannerLink([item])">Open in Colonization Planner</router-link>
                </div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A mine digs {{ count(raceRules.MineProduction) }} t a year at accessibility 1 with your mining tech, times the deposit's accessibility, before the colony's own modifiers; an automated mine digs the same and a civilian mining complex ten times as much. Accessibility holds until a deposit is down to half its original amount, then falls with what is left, to {{ ACCESSIBILITY_FLOOR }} when it is empty. Orbital miners work bodies up to {{ count(raceRules.MaximumOrbitalMiningDiameter) }} km across. Untapped: nobody mines the body and no known alien colony holds it; a colony of yours without mines counts as untapped. Distance is the charted route from your nearest colony of {{ SUPPLY_BASE_MILLIONS }} million people or more.
          </div>
        </v-card>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>{{ focus ? `${focus.name} in your colonies` : 'Minerals in your colonies' }}</span>
            <v-text-field v-model="colonySearch" label="Search" placeholder="Colony or system" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <v-data-table :headers="colonyHeaders" :items="visibleColonyRows" item-key="key" show-expand single-expand :expanded.sync="colonyExpanded" :sort-by.sync="colonySortBy" :sort-desc.sync="colonySortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" :no-data-text="colonyRows.length ? 'No colony matches the search.' : `No colony in the chosen systems holds, reserves, needs or expects ${focusName}.`">
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                <div class="caption text--secondary text-no-wrap">{{ item.place }}</div>
              </div>
            </template>
            <template v-for="column in tonnageColumns" #[`item.${column}`]="{ item }">
              <span :key="column" class="text-no-wrap" :class="{ 'text--secondary': !item[column] }" :title="`${count(item[column])} t`">{{ item[column] ? compact(item[column]) : '—' }}</span>
            </template>
            <template #[`item.driverSort`]="{ item }">
              <div v-if="item.colony.MassDrivers" class="py-2 wrap-cell">
                <div>{{ counted(item.colony.MassDrivers, 'driver', 'drivers') }}<span v-if="item.destination"> → {{ item.destination }}</span></div>
                <div class="caption text--secondary">{{ item.destination ? `up to ${compact(item.colony.MassDrivers * MASS_DRIVER_TONS)} a year` : 'no destination: sends nothing' }}</div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.stateOrder`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">
                  <v-icon small :color="stockStates[item.state].color" class="mr-1">{{ stockStates[item.state].icon }}</v-icon>{{ stockStates[item.state].label }}
                </div>
                <div v-if="item.stateNote" class="caption text--secondary wrap-cell" :title="item.stateTitle">{{ item.stateNote }}</div>
              </div>
            </template>
            <template #expanded-item="{ headers }">
              <td :colspan="headers.length" class="expand-cell">
                <v-simple-table v-if="colonyDetail" dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Mineral</th>
                      <th class="text-right">Stock</th>
                      <th class="text-right">Reserve</th>
                      <th class="text-right">Free to move</th>
                      <th class="text-right">Queue needs</th>
                      <th class="text-right">In flight</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="mineral in colonyDetail" :key="mineral.id">
                      <td class="font-weight-medium">{{ mineral.name }}</td>
                      <td v-for="column in tonnageColumns" :key="column" class="text-right" :class="{ 'text--secondary': !mineral[column] }" :title="`${count(mineral[column])} t`">{{ mineral[column] ? compact(mineral[column]) : '—' }}</td>
                      <td>
                        <div class="text-no-wrap"><v-icon small :color="stockStates[mineral.state].color" class="mr-1">{{ stockStates[mineral.state].icon }}</v-icon>{{ stockStates[mineral.state].label }}</div>
                        <div v-if="mineral.advice" class="caption text--secondary">{{ mineral.advice }}</div>
                      </td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Freighters, load and unload to reserve orders and mass drivers move only what a colony holds above its reserve. Industrial projects, shipyards and ground training draw on the whole stock, reserve included, so a reserve keeps a queue's minerals from being carried off but never holds them back from it. A mass driver sends up to {{ count(MASS_DRIVER_TONS) }} t a year to the colony set as its destination, and nothing with none set; packets bound for a colony that is gone are lost. Queue needs are what the colony's industrial projects (paused and queued ones too) and shipyard tasks still need. Expand a colony for each mineral and the nearest colony with stock free to move.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import SystemMap from '../components/exploration/SystemMap.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import countFormat from '../mixins/count-format'
import { systemBodyName } from '../utilities/aurora'
import { cmcBodyInReach } from '../utilities/colonization'
import { SUPPLY_BASE_MILLIONS, loadRoutes } from '../utilities/colonization-data'
import { KM_PER_AU, buildDistanceMap, jumpLinks, searchRoutes } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { ACCESSIBILITY_FLOOR, CMC_MINERAL_IDS, MINERALS, compact, depositPotential, qualifiesForCmc } from '../utilities/minerals'

const INPUT_LABELS = {
  race: "the race's mining tech",
  systems: 'the known systems',
  routes: 'the jump routes',
  deposits: 'the mineral deposits',
  colonies: "the colonies' stockpiles",
  needs: 'the build queues',
  packets: 'the mass-driver packets',
  miners: 'the orbital miners',
  aliens: 'the alien colonies',
}
const INPUTS = Object.keys(INPUT_LABELS)

const MINERAL_NAMES = MINERALS.map((mineral) => mineral.name)
const SHORT_NAMES = { 1: 'Du', 2: 'Ne', 3: 'Co', 4: 'Tr', 5: 'Bo', 6: 'Me', 7: 'Ve', 8: 'So', 9: 'Ur', 10: 'Cr', 11: 'Ga' }

// Helpers.MassDriverCapacityPerInstallation: tonnes a year per mass driver.
const MASS_DRIVER_TONS = 5000

// Accessibility bands, best first, with their slot in the chart palette.
const BANDS = [
  { id: 'good', label: '0.7 and up', min: 0.7, slot: 2 },
  { id: 'fair', label: '0.4 to 0.7', min: 0.4, slot: 3 },
  { id: 'poor', label: 'Under 0.4', min: 0, slot: 1 },
]
const bandOf = (accessibility) => BANDS.find((band) => accessibility >= band.min).id

// FCT_SystemBody.GroundMineralSurvey: what a ground survey can still find (0: nothing left).
const GROUND_SURVEY = { 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }

const BODY_CLASSES = { 1: 'Planet', 2: 'Moon', 3: 'Asteroid', 5: 'Comet' }

const REACHES = [
  { id: 'all', label: 'All known systems' },
  { id: 'colonies', label: 'Systems with your colonies' },
  { id: 'inhabited', label: 'Systems with your people' },
  { id: 'unrestricted', label: 'Unrestricted systems' },
]

const DEPOSIT_VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'untapped', label: 'Untapped' },
  { id: 'worked', label: 'Mined by you' },
]

const ORBITAL_OPTIONS = [
  { value: 'all', text: 'All bodies' },
  { value: 'eligible', text: 'Only bodies orbital miners can work' },
  { value: 'ineligible', text: 'Only bodies too large for orbital miners' },
]

const ACCESSIBILITY_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

// A colony's state for one mineral, most pressing first. Differences under a tonne are rounding.
const STOCK_STATES = {
  short: { order: 0, label: 'Short for queue', icon: 'mdi-alert-circle-outline', color: 'error' },
  exported: { order: 1, label: 'Driver ships queue stock', icon: 'mdi-arrow-top-right-thick', color: 'warning' },
  below: { order: 2, label: 'Below reserve', icon: 'mdi-arrow-down-bold-circle-outline', color: 'warning' },
  surplus: { order: 3, label: 'Free to move', icon: 'mdi-check-circle-outline', color: 'success' },
  held: { order: 4, label: 'All reserved', icon: 'mdi-lock-outline', color: undefined },
  empty: { order: 5, label: 'Nothing held', icon: 'mdi-circle-outline', color: undefined },
}
const PRESSING = ['short', 'exported', 'below']

const stockState = ({ stock, reserve, needs }, exporting) => {
  if (needs - stock >= 1) {
    return 'short'
  } else if (exporting && needs - reserve >= 1 && stock - reserve >= 1) {
    return 'exported'
  } else if (reserve - stock >= 1) {
    return 'below'
  } else if (stock - reserve >= 1) {
    return 'surplus'
  }

  return stock >= 1 ? 'held' : 'empty'
}

const sum = (items, key) => items.reduce((total, item) => total + (item[key] || 0), 0)
const sums = (table) => MINERAL_NAMES.map((name) => `sum(${table}.${name}) as ${name}`).join(', ')
const byPopulation = (rows) => Object.fromEntries(rows.map((row) => [row.PopulationID, row]))

// What the Colonization Planner's `?bodies=` takes, and the Planner sends here.
const bodyReference = (body) => ({
  SystemBodyID: body.SystemBodyID,
  SystemBodyName: body.SystemBodyName,
  SystemName: body.SystemName,
  BodyClass: body.BodyClass,
  Component: body.Component,
  PlanetNumber: body.PlanetNumber,
  OrbitNumber: body.OrbitNumber,
})

// Deposits ranked for an untapped site: the higher potential (to a tenth, as shown), then accessibility, then size.
const betterSite = (a, b) => roundToDecimal(a.potential, 1) - roundToDecimal(b.potential, 1) || a.accessibility - b.accessibility || a.amount - b.amount

export default {
  name: 'MineralsPage',
  components: { SystemMap },
  mixins: [countFormat],
  data() {
    const { systems, bodies } = this.$route.query

    return {
      loadErrors: {},
      focusId: 0,
      reach: 'all',
      depositView: 'all',
      orbital: 'all',
      minAccessibility: 0,
      minAmount: null,
      search: '',
      colonySearch: '',
      // Systems the map or a click on this page's map picked, or bodies the Colonization Planner sent.
      selectedSystemIds: !bodies && systems ? systems.split(',').map((id) => parseInt(id, 10)).filter(Boolean) : [],
      selectedBodies: bodies ? JSON.parse(bodies) : [],
      selectedRows: [],
      depositExpanded: [],
      colonyExpanded: [],
      depositSortBy: ['potential'],
      depositSortDesc: [true],
      colonySortBy: ['stateOrder'],
      colonySortDesc: [false],
      bands: BANDS,
      depositViews: DEPOSIT_VIEWS,
      orbitalOptions: ORBITAL_OPTIONS,
      accessibilitySteps: ACCESSIBILITY_STEPS,
      groundSurvey: GROUND_SURVEY,
      stockStates: STOCK_STATES,
      tonnageColumns: ['stock', 'reserve', 'free', 'needs', 'inbound'],
      mapHeight: 'clamp(320px, calc(100vh - 460px), 560px)',
      ACCESSIBILITY_FLOOR,
      KM_PER_AU,
      MASS_DRIVER_TONS,
      SUPPLY_BASE_MILLIONS,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    bandColors() {
      return Object.fromEntries(BANDS.map((band) => [band.id, this.theme.categorical[band.slot]]))
    },

    mutedColor() {
      return withAlpha(this.theme.inkMuted, 0.35)
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    raceRules() {
      return this.race || { MineProduction: 0, MaximumOrbitalMiningDiameter: 0, AllowCMC: 0 }
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS)
    },

    settingsPrefix() {
      return `game.${this.GameID}.race.${this.RaceID}`
    },

    focus() {
      return MINERALS.find((mineral) => mineral.id === this.focusId) || null
    },

    focusName() {
      return this.focus ? this.focus.name : 'all minerals'
    },

    mineralItems() {
      return [{ id: 0, name: 'All minerals' }, ...MINERALS]
    },

    activeOptionCount() {
      return [this.orbital !== 'all', this.minAccessibility > 0, this.minAmount > 0].filter(Boolean).length
    },

    coloniesById() {
      return byPopulation(this.colonies)
    },

    needsById() {
      return byPopulation(this.needs)
    },

    packetsById() {
      return byPopulation(this.packets)
    },

    colonySystemIds() {
      return new Set(this.colonies.map((colony) => colony.SystemID))
    },

    inhabitedSystemIds() {
      return new Set(this.colonies.filter((colony) => colony.Population > 0).map((colony) => colony.SystemID))
    },

    unrestrictedSystemIds() {
      return new Set(this.systems.filter((system) => !system.MilitaryRestrictedSystem).map((system) => system.SystemID))
    },

    reachItems() {
      const sizes = { all: this.systems.length, colonies: this.colonySystemIds.size, inhabited: this.inhabitedSystemIds.size, unrestricted: this.unrestrictedSystemIds.size }

      return REACHES.map((reach) => ({ ...reach, note: this.counted(sizes[reach.id], 'system', 'systems') }))
    },

    // The systems in view: those of the picked bodies, the picked systems, else the preset's (null: every system).
    scopeSystemIds() {
      if (this.selectedBodies.length) {
        return new Set(this.bodies.filter((body) => this.selectedBodyIds.has(body.SystemBodyID)).map((body) => body.SystemID))
      } else if (this.selectedSystemIds.length) {
        return new Set(this.selectedSystemIds)
      }

      return { colonies: this.colonySystemIds, inhabited: this.inhabitedSystemIds, unrestricted: this.unrestrictedSystemIds }[this.reach] || null
    },

    selectedBodyIds() {
      return new Set(this.selectedBodies.map((body) => body.SystemBodyID))
    },

    selection() {
      if (this.selectedBodies.length) {
        return { label: this.counted(this.selectedBodies.length, 'body', 'bodies'), title: this.selectedBodies.map((body) => `${body.SystemName} ${systemBodyName(body)}`).join(', ') }
      } else if (this.selectedSystemIds.length) {
        const names = this.selectedSystemIds.map((id) => (this.systems.find((system) => system.SystemID === id) || { Name: `System #${id}` }).Name)

        return { label: names.length > 2 ? this.counted(names.length, 'system', 'systems') : names.join(', '), title: names.join(', ') }
      }

      return null
    },

    distanceTo() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.colonies)
    },

    // Every surveyed body with deposits: its place, its deposits by mineral, who mines it and how far it is.
    bodies() {
      const colonies = {}
      const aliens = {}
      const miners = Object.fromEntries(this.miners.map((row) => [row.SystemBodyID, row]))
      const bodies = {}

      this.colonies.forEach((colony) => (colonies[colony.SystemBodyID] = colonies[colony.SystemBodyID] || []).push(colony))
      this.aliens.forEach((alien) => (aliens[alien.SystemBodyID] = aliens[alien.SystemBodyID] || []).push(alien))

      this.deposits.forEach((row) => {
        if (!bodies[row.SystemBodyID]) {
          bodies[row.SystemBodyID] = { ...row, deposits: {} }
        }

        bodies[row.SystemBodyID].deposits[row.MaterialID] = {
          MaterialID: row.MaterialID,
          Amount: row.Amount,
          Accessibility: row.Accessibility,
          HalfOriginalAmount: row.HalfOriginalAmount,
          OriginalAcc: row.OriginalAcc,
        }
      })

      return Object.values(bodies).map((row) => {
        const own = colonies[row.SystemBodyID] || []
        const alien = aliens[row.SystemBodyID] || []
        const fleet = miners[row.SystemBodyID]
        const mining = sum(own, 'Mines') + sum(own, 'Automines') + sum(own, 'Complexes') * 10 + (fleet ? fleet.Modules : 0)
        const name = row.SystemBodyName || `${row.SystemName} ${systemBodyName(row)}`
        const diameter = row.Radius * 2
        const cmcMinerals = cmcBodyInReach(row) ? CMC_MINERAL_IDS.filter((id) => qualifiesForCmc(row.deposits[id])).map((id) => this.mineralName(id)) : []

        return {
          ...row,
          name,
          place: [row.SystemBodyName ? row.SystemName : null, BODY_CLASSES[row.BodyClass], diameter ? `${this.count(diameter)} km` : null].filter(Boolean).join(' · '),
          search: `${name} ${row.SystemName}`.toLowerCase(),
          Diameter: diameter,
          orbitalEligible: diameter <= this.raceRules.MaximumOrbitalMiningDiameter,
          depositList: MINERALS.map((mineral) => row.deposits[mineral.id]).filter(Boolean),
          complexes: sum(own, 'Complexes'),
          complexColonies: own.filter((colony) => colony.Complexes > 0),
          cmcCandidate: cmcMinerals.join(' and '),
          workers: [
            ...own.map((colony) => ({ key: `colony-${colony.PopulationID}`, text: colony.PopName, note: this.minesText(colony) })),
            ...(fleet ? [{ key: 'orbital', text: this.counted(fleet.Ships, 'orbital miner', 'orbital miners'), note: this.counted(fleet.Modules, 'module', 'modules') }] : []),
            ...alien.map((population) => ({ key: `alien-${population.PopulationID}`, text: population.PopulationName || 'Alien colony', note: population.AlienRaceName || 'Alien', alien: true })),
          ],
          mining,
          worked: mining > 0,
          tapped: mining > 0 || alien.length > 0,
          distance: this.distanceTo(row),
        }
      })
    },

    bodiesPassingOrbital() {
      return this.bodies.filter((body) => this.orbital === 'all' || (this.orbital === 'eligible') === body.orbitalEligible)
    },

    scopedBodies() {
      return this.bodiesPassingOrbital.filter((body) => this.inScope(body))
    },

    // Per mineral, over the bodies in view and the deposits the options let through.
    mineralStats() {
      const stats = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, { amount: 0, bands: { good: 0, fair: 0, poor: 0 }, deposits: 0, worked: 0, falling: 0, best: null, bodyIds: new Set(), systemIds: new Set() }]))

      this.scopedBodies.forEach((body) => {
        body.depositList.forEach((deposit) => {
          if (!this.passesDeposit(deposit)) {
            return
          }

          const stat = stats[deposit.MaterialID]

          stat.amount += deposit.Amount
          stat.bands[bandOf(deposit.Accessibility)] += deposit.Amount
          stat.deposits += 1
          stat.bodyIds.add(body.SystemBodyID)
          stat.systemIds.add(body.SystemID)

          if (body.worked) {
            stat.worked += 1
            stat.falling += deposit.Amount < deposit.HalfOriginalAmount ? 1 : 0
          } else if (!body.tapped) {
            const site = { name: body.name, SystemName: body.SystemName, distance: body.distance, deposit, potential: depositPotential(deposit), accessibility: deposit.Accessibility, amount: deposit.Amount }

            if (!stat.best || betterSite(site, stat.best) > 0) {
              stat.best = site
            }
          }
        })
      })

      return stats
    },

    // Per colony and mineral: stock, reserve, what moves, what the queue needs and what is on its way.
    colonyStocks() {
      return this.colonies.map((colony) => {
        const needs = this.needsById[colony.PopulationID] || {}
        const inbound = this.packetsById[colony.PopulationID] || {}
        const exporting = colony.MassDrivers > 0 && colony.MassDriverDest > 0

        return {
          colony,
          exporting,
          minerals: MINERALS.map((mineral) => {
            const values = {
              stock: colony[mineral.name] || 0,
              reserve: colony[`Reserve${mineral.name}`] || 0,
              needs: needs[mineral.name] || 0,
              inbound: inbound[mineral.name] || 0,
            }

            return { ...mineral, ...values, free: Math.max(0, values.stock - values.reserve), state: stockState(values, exporting) }
          }),
        }
      })
    },

    scopedColonyStocks() {
      return this.colonyStocks.filter(({ colony }) => this.inScope(colony))
    },

    overviewRows() {
      return MINERALS.map((mineral) => {
        const stocks = this.scopedColonyStocks.map(({ minerals }) => minerals[mineral.id - 1])

        return {
          ...mineral,
          ...this.mineralStats[mineral.id],
          stock: sum(stocks, 'stock'),
          free: sum(stocks, 'free'),
          short: stocks.filter((stock) => stock.state === 'short').length,
          below: stocks.filter((stock) => stock.state === 'below').length,
        }
      })
    },

    // The best untapped site for the focus mineral, or the body with the best average potential.
    bestSite() {
      if (this.focus) {
        return this.mineralStats[this.focus.id].best
      }

      return this.allMineralRows.filter((row) => !row.body.tapped).reduce((best, row) => (!best || betterSite(row, best) > 0 ? row : best), null)
    },

    tiles() {
      const rows = this.focus ? this.overviewRows.filter((row) => row.id === this.focus.id) : this.overviewRows
      const bodyIds = new Set(rows.flatMap((row) => [...row.bodyIds]))
      const systemIds = new Set(rows.flatMap((row) => [...row.systemIds]))
      const best = this.bestSite
      const worked = sum(rows, 'worked')
      const falling = sum(rows, 'falling')
      const short = this.colonyRows.filter((row) => row.state === 'short').length
      const below = this.colonyRows.filter((row) => row.minerals.some((mineral) => mineral.state === 'below' && (!this.focus || mineral.id === this.focus.id))).length
      const bestNote = best && [best.name.startsWith(best.SystemName) ? null : best.SystemName, this.focus ? `${compact(best.deposit.Amount)} at ${best.deposit.Accessibility}` : `potential ${roundToDecimal(best.potential, 1)} of 10`, best.distance ? this.distanceText(best.distance) : null].filter(Boolean).join(' · ')

      return [
        {
          label: `${this.focus ? this.focus.name : 'Minerals'} in the ground`,
          value: compact(sum(rows, 'amount')),
          title: `${this.count(sum(rows, 'amount'))} t`,
          note: `${this.counted(sum(rows, 'deposits'), 'deposit', 'deposits')} on ${this.counted(bodyIds.size, 'body', 'bodies')} in ${this.counted(systemIds.size, 'system', 'systems')}`,
        },
        {
          label: 'Best untapped site',
          value: best ? best.name : '—',
          note: best ? bestNote : 'Everything in view is mined, or held by aliens',
        },
        {
          label: 'Deposits you mine',
          value: this.count(worked),
          note: worked ? (falling ? `${this.count(falling)} past half and losing accessibility` : 'None past half yet; accessibility holds') : 'No colony or orbital miner of yours mines here',
        },
        {
          label: 'Free to move',
          value: compact(sum(this.colonyRows, 'free')),
          title: `${this.count(sum(this.colonyRows, 'free'))} t above the colonies' reserves`,
          note: `${this.counted(below, 'colony', 'colonies')} below reserve · ${this.count(short)} short for their queue`,
        },
      ]
    },

    // One row per body for all minerals: each mineral's cell, and the totals over the deposits that pass.
    allMineralRows() {
      return this.scopedBodies.map((body) => {
        const passing = body.depositList.filter((deposit) => this.passesDeposit(deposit))

        if (!passing.length) {
          return null
        }

        const potential = passing.reduce((total, deposit) => total + depositPotential(deposit), 0) / MINERALS.length

        return {
          SystemBodyID: body.SystemBodyID,
          body,
          name: body.name,
          place: body.place,
          SystemName: body.SystemName,
          distance: body.distance,
          nameSort: `${body.SystemName} ${body.name}`,
          amount: sum(passing, 'Amount'),
          accessibility: Math.max(...passing.map((deposit) => deposit.Accessibility)),
          minerals: passing.length,
          perMine: passing.reduce((total, deposit) => total + this.raceRules.MineProduction * deposit.Accessibility, 0),
          potential,
          potentialTitle: `${roundToDecimal(potential, 1)} of 10, the average over the 11 minerals: ${passing.map((deposit) => `${this.mineralName(deposit.MaterialID)} ${roundToDecimal(depositPotential(deposit), 1)}`).join(', ')}${passing.length < MINERALS.length ? `, ${MINERALS.length - passing.length} at 0` : ''}.`,
          cells: MINERALS.map((mineral) => {
            const deposit = body.deposits[mineral.id]
            const passes = !!deposit && this.passesDeposit(deposit)

            return {
              id: mineral.id,
              short: SHORT_NAMES[mineral.id],
              deposit,
              passes,
              band: deposit && bandOf(deposit.Accessibility),
              title: deposit ? `${mineral.name}: ${this.count(deposit.Amount)} t at accessibility ${deposit.Accessibility}${passes ? '' : ', outside the options'}` : `No ${mineral.name}`,
            }
          }),
          workedSort: body.mining,
          distanceSort: body.distance ? body.distance.km : Infinity,
        }
      }).filter(Boolean)
    },

    focusRows() {
      const focus = this.focus

      return this.scopedBodies.map((body) => {
        const deposit = body.deposits[focus.id]

        if (!deposit || !this.passesDeposit(deposit)) {
          return null
        }

        const potential = depositPotential(deposit)

        return {
          SystemBodyID: body.SystemBodyID,
          body,
          deposit,
          name: body.name,
          place: body.place,
          nameSort: `${body.SystemName} ${body.name}`,
          amount: deposit.Amount,
          accessibility: deposit.Accessibility,
          band: bandOf(deposit.Accessibility),
          perMine: this.raceRules.MineProduction * deposit.Accessibility,
          potential,
          potentialTitle: `${roundToDecimal(potential, 1)} of 10 for ${this.count(deposit.Amount)} t at accessibility ${deposit.Accessibility}`,
          workedSort: body.mining,
          distanceSort: body.distance ? body.distance.km : Infinity,
        }
      }).filter(Boolean)
    },

    viewRows() {
      return this.focus ? this.focusRows : this.allMineralRows
    },

    viewCounts() {
      return {
        all: this.viewRows.length,
        untapped: this.viewRows.filter((row) => !row.body.tapped).length,
        worked: this.viewRows.filter((row) => row.body.worked).length,
      }
    },

    depositRows() {
      const search = (this.search || '').toLowerCase()

      return this.viewRows.filter((row) => (this.depositView === 'all' || (this.depositView === 'untapped' ? !row.body.tapped : row.body.worked)) && (!search || row.body.search.includes(search)))
    },

    depositHeaders() {
      return [
        { text: 'Body', value: 'nameSort' },
        ...(this.focus
          ? [
              { text: 'In the ground', value: 'amount', align: 'end' },
              { text: 'Accessibility', value: 'accessibility' },
            ]
          : [{ text: 'Deposits', value: 'amount' }]),
        { text: 'Per mine', value: 'perMine', align: 'end' },
        { text: 'Potential', value: 'potential', align: 'end' },
        { text: 'Mining', value: 'mining', sortable: false },
        { text: 'Worked by', value: 'workedSort' },
        { text: 'Distance', value: 'distanceSort', align: 'end' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    potentialHint() {
      const rule = 'A deposit scores 0 to 10 from its amount and accessibility: 20,000 t at accessibility 1 scores 5 and 100,000 t at 0.7 about 8, while at 0.1 it stays under 1 however large. Green from 7.5.'

      return this.focus ? rule : `The average over the 11 minerals, so a mineral the body lacks counts as 0. ${rule} Hover a value for its minerals.`
    },

    colonyRows() {
      return this.scopedColonyStocks.map(({ colony, minerals, exporting }) => {
        const picked = this.focus ? [minerals[this.focus.id - 1]] : minerals
        const totals = { stock: sum(picked, 'stock'), reserve: sum(picked, 'reserve'), free: sum(picked, 'free'), needs: sum(picked, 'needs'), inbound: sum(picked, 'inbound') }

        if (!totals.stock && !totals.reserve && !totals.needs && !totals.inbound) {
          return null
        }

        const state = picked.reduce((worst, mineral) => (STOCK_STATES[mineral.state].order < STOCK_STATES[worst].order ? mineral.state : worst), 'empty')
        const flaggedNames = !this.focus && PRESSING.includes(state) ? picked.filter((mineral) => mineral.state === state).map((mineral) => mineral.name) : []
        const destination = exporting ? (this.coloniesById[colony.MassDriverDest] || { PopName: `Colony #${colony.MassDriverDest}` }).PopName : null

        return {
          key: colony.PopulationID,
          colony,
          minerals,
          name: colony.PopName,
          place: [colony.SystemName, systemBodyName(colony), colony.Population > 0 ? `${this.count(colony.Population, colony.Population < 10 ? 1 : 0)} M people` : 'no people'].join(' · '),
          search: `${colony.PopName} ${colony.SystemName}`.toLowerCase(),
          ...totals,
          state,
          stateOrder: STOCK_STATES[state].order,
          stateNote: flaggedNames.length > 3 ? `${flaggedNames.slice(0, 2).join(', ')} and ${flaggedNames.length - 2} more` : flaggedNames.join(', '),
          stateTitle: flaggedNames.join(', '),
          destination,
          driverSort: colony.MassDrivers,
        }
      }).filter(Boolean)
    },

    visibleColonyRows() {
      const search = (this.colonySearch || '').toLowerCase()

      return search ? this.colonyRows.filter((row) => row.search.includes(search)) : this.colonyRows
    },

    colonyHeaders() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Stock', value: 'stock', align: 'end' },
        { text: 'Reserve', value: 'reserve', align: 'end' },
        { text: 'Free to move', value: 'free', align: 'end' },
        { text: 'Queue needs', value: 'needs', align: 'end' },
        { text: 'In flight', value: 'inbound', align: 'end' },
        { text: 'Mass driver', value: 'driverSort' },
        { text: 'State', value: 'stateOrder' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    // The expanded colony's minerals, with what to do about the pressing ones: where the nearest stock free to
    // move is, on the charted route from this colony.
    colonyDetail() {
      const expanded = this.colonyExpanded[0] && this.colonyRows.find((row) => row.key === this.colonyExpanded[0].key)

      if (!expanded) {
        return null
      }

      const { colony, minerals } = expanded
      const routes = searchRoutes(this.routes.jumpPoints, [{ SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor }], { order: 'km' })
      const others = this.colonyStocks.filter((other) => other.colony.PopulationID !== colony.PopulationID)

      return minerals.filter((mineral) => mineral.stock || mineral.reserve || mineral.needs || mineral.inbound).map((mineral) => {
        if (mineral.state === 'exported') {
          return { ...mineral, advice: `The mass driver can ship off ${compact(Math.min(mineral.stock, mineral.needs) - mineral.reserve)} the queue needs; a reserve of ${compact(mineral.needs)} keeps it here.` }
        } else if (mineral.state !== 'short' && mineral.state !== 'below') {
          return mineral
        }

        const missing = mineral.state === 'short' ? mineral.needs - mineral.stock : mineral.reserve - mineral.stock
        const source = others
          .map((other) => ({ other, free: other.minerals[mineral.id - 1].free }))
          .filter(({ free }) => free >= 1)
          .map((candidate) => ({ ...candidate, route: routes.toPlace({ SystemID: candidate.other.colony.SystemID, Xcor: candidate.other.colony.Xcor, Ycor: candidate.other.colony.Ycor }) }))
          .filter(({ route }) => route)
          .reduce((best, candidate) => (!best || candidate.route.km < best.route.km ? candidate : best), null)
        const lack = `${compact(missing)} ${mineral.state === 'short' ? 'more for the queue' : 'under the reserve'}`

        return {
          ...mineral,
          advice: source ? `${lack}. Nearest free stock: ${source.other.colony.PopName}, ${compact(source.free)}, ${this.distanceText(source.route)}.` : `${lack}. No colony on a charted route has any free to move.`,
        }
      })
    },

    mapLinks() {
      return jumpLinks(this.routes.jumpPoints)
    },

    mapSelected() {
      return this.selectedSystemIds.length === 1 ? this.selectedSystemIds[0] : null
    },

    // Per system, the deposits of the focus mineral that pass the options and the deposit view, whether or not
    // the system is in view.
    systemDeposits() {
      const systems = {}

      this.bodiesPassingOrbital.forEach((body) => {
        if (this.depositView !== 'all' && (this.depositView === 'untapped' ? body.tapped : !body.worked)) {
          return
        }

        body.depositList.forEach((deposit) => {
          if ((this.focus && deposit.MaterialID !== this.focus.id) || !this.passesDeposit(deposit)) {
            return
          }

          const system = (systems[body.SystemID] = systems[body.SystemID] || { amount: 0, deposits: 0, best: 0 })

          system.amount += deposit.Amount
          system.deposits += 1
          system.best = Math.max(system.best, deposit.Accessibility)
        })
      })

      return systems
    },

    // Out-of-view and empty systems first, so the ones with deposits in view draw on top.
    mapNodes() {
      const systems = this.systemDeposits
      const largest = Math.max(1, ...Object.values(systems).map((system) => system.amount))

      return this.systems.map((system) => {
        const deposits = systems[system.SystemID]
        const shown = !!deposits && this.systemInScope(system.SystemID)
        const colonised = this.colonySystemIds.has(system.SystemID)

        return {
          SystemID: system.SystemID,
          Name: system.Name,
          Xcor: system.Xcor,
          Ycor: system.Ycor,
          size: deposits ? 4 + 10 * Math.sqrt(deposits.amount / largest) : 3,
          color: shown ? this.bandColors[bandOf(deposits.best)] : this.mutedColor,
          ring: colonised ? this.theme.ink : null,
          label: colonised || system.SystemID === this.mapSelected,
          title: deposits ? `${system.Name}: ${compact(deposits.amount)} of ${this.focusName} in ${this.counted(deposits.deposits, 'deposit', 'deposits')}, best accessibility ${deposits.best}${shown ? '' : ' (out of view)'}` : `${system.Name}: no ${this.focusName} deposits that pass`,
          order: shown ? deposits.amount : -1,
        }
      }).sort((a, b) => a.order - b.order)
    },
  },
  watch: {
    // The focus, view and options are kept per game and race; the orbital filter for the app.
    RaceID: {
      immediate: true,
      handler(_value, previous) {
        const focusId = this.config.get(`${this.settingsPrefix}.mineralsFocus`, 0)
        const reach = this.config.get(`${this.settingsPrefix}.mineralsReach`, 'all')
        const view = this.config.get(`${this.settingsPrefix}.mineralsDepositView`, 'all')
        const orbital = this.config.get('mineralsFilterOrbitalEligibility', 'all')

        this.focusId = MINERALS.some((mineral) => mineral.id === focusId) ? focusId : 0
        this.reach = REACHES.some((option) => option.id === reach) ? reach : 'all'
        this.depositView = DEPOSIT_VIEWS.some((option) => option.id === view) ? view : 'all'
        this.orbital = ORBITAL_OPTIONS.some((option) => option.value === orbital) ? orbital : 'all'
        this.minAccessibility = this.config.get(`${this.settingsPrefix}.mineralsMinAccessibility`, 0)
        this.minAmount = this.config.get(`${this.settingsPrefix}.mineralsMinAmount`, null)

        if (previous) {
          this.clearSelection()
        }
      },
    },
  },
  created() {
    // `?mineral=<MaterialID>` opens on that mineral; the saved focus is left as it was.
    const linked = MINERALS.find((mineral) => mineral.id === Number(this.$route.query.mineral))

    if (linked) {
      this.focusId = linked.id
    }
  },
  methods: {
    roundToDecimal,
    compact,
    withAlpha,
    depositPotential,

    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    saveSetting(key, value) {
      this.config.set(`${this.settingsPrefix}.${key}`, value)
    },

    setFocus(id) {
      this.focusId = id
      this.saveSetting('mineralsFocus', id)
    },

    setReach(id) {
      this.reach = id
      this.saveSetting('mineralsReach', id)
    },

    setDepositView(id) {
      this.depositView = id
      this.saveSetting('mineralsDepositView', id)
    },

    resetOptions() {
      this.orbital = 'all'
      this.minAccessibility = 0
      this.minAmount = null
      this.config.set('mineralsFilterOrbitalEligibility', 'all')
      this.saveSetting('mineralsMinAccessibility', 0)
      this.saveSetting('mineralsMinAmount', null)
    },

    clearSelection() {
      this.selectedSystemIds = []
      this.selectedBodies = []
    },

    // A click on the map lists only that system; a second click shows the preset again.
    selectSystem(id) {
      this.selectedBodies = []
      this.selectedSystemIds = this.mapSelected === id ? [] : [id]
    },

    inScope(place) {
      if (this.selectedBodies.length) {
        return this.selectedBodyIds.has(place.SystemBodyID)
      }

      return this.systemInScope(place.SystemID)
    },

    systemInScope(systemId) {
      return !this.scopeSystemIds || this.scopeSystemIds.has(systemId)
    },

    passesDeposit(deposit) {
      return deposit.Accessibility >= this.minAccessibility && (!(this.minAmount > 0) || deposit.Amount >= this.minAmount)
    },

    mineralName(id) {
      return MINERALS[id - 1].name
    },

    counted(value, one, many) {
      return `${this.count(value)} ${Math.round(value) === 1 ? one : many}`
    },

    distanceText(route) {
      return `${roundToDecimal(route.km / KM_PER_AU, 1)} AU, ${route.jumps ? this.counted(route.jumps, 'jump', 'jumps') : 'same system'}`
    },

    bandTitle(row) {
      return BANDS.map((band) => `${band.label}: ${this.count(row.bands[band.id])} t`).join(', ')
    },

    // Accessibility holds down to half the original amount, then falls with what is left (Population.cs).
    depletionText(deposit, long = false) {
      if (!(deposit.HalfOriginalAmount > 0)) {
        return ''
      } else if (deposit.Amount >= deposit.HalfOriginalAmount) {
        return long ? `Holds for ${compact(deposit.Amount - deposit.HalfOriginalAmount)} more, then falls toward ${ACCESSIBILITY_FLOOR}` : `holds for ${compact(deposit.Amount - deposit.HalfOriginalAmount)}`
      }

      return long ? `Past half: falls with what is left, to ${ACCESSIBILITY_FLOOR} when empty` : 'past half, falling'
    },

    minesText(colony) {
      const parts = [
        colony.Mines >= 0.5 && this.counted(colony.Mines, 'mine', 'mines'),
        colony.Automines >= 0.5 && this.counted(colony.Automines, 'automine', 'automines'),
        colony.Complexes > 0 && this.counted(colony.Complexes, 'CMC', 'CMCs'),
      ].filter(Boolean)

      return parts.length ? parts.join(', ') : 'no mines'
    },

    cmcText(body) {
      const names = body.complexColonies.map((colony) => colony.PopName)
      const purchased = body.complexColonies.some((colony) => colony.PurchaseCivilianMinerals)

      return `${names.join(' and ')} ${names.length > 1 ? 'run' : 'runs'} ${this.counted(body.complexes, 'civilian mining complex', 'civilian mining complexes')} here. ${purchased ? 'You buy their minerals.' : "You tax them; their minerals don't reach your stockpile."}`
    },

    plannerLink(rows) {
      return { path: '/habitability', query: { bodies: JSON.stringify(rows.map((row) => bodyReference(row.body || row))) } }
    },
  },
  asyncComputed: {
    race: {
      get: tracked('race', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        // Saves before 2.7 have no FCT_Game.AllowCMC: the game founded civilian mining complexes in every game.
        const [[[race]], [[game]]] = await Promise.all([
          this.database.query(`select MineProduction, MaximumOrbitalMiningDiameter from FCT_Race where GameID = ${this.GameID} and RaceID = ${this.RaceID}`),
          this.database.query(`select * from FCT_Game where GameID = ${this.GameID}`),
        ])

        return race ? { ...race, AllowCMC: game && game.AllowCMC !== undefined ? game.AllowCMC : 1 } : null
      }),
      default: null,
    },

    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [systems] = await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.MilitaryRestrictedSystem from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`)

        return systems
      }),
      default: [],
    },

    routes: {
      get: tracked('routes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { jumpPoints: [], capital: null, colonies: [] }
        }

        return loadRoutes(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { jumpPoints: [], capital: null, colonies: [] },
    },

    // The deposits on bodies the race has surveyed, in systems it knows, with each body's place and orbit.
    deposits: {
      get: tracked('deposits', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [deposits] = await this.database.query(`select FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.Radius, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.Eccentricity, VIR_Parent.OrbitalDistance as ParentOrbitalDistance, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName from FCT_MineralDeposit inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBody as VIR_Parent on VIR_Parent.SystemBodyID = FCT_SystemBody.ParentBodyID and FCT_SystemBody.ParentBodyType = 1 left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_MineralDeposit.GameID = ${this.GameID} and FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys where FCT_SystemBodySurveys.GameID = ${this.GameID} and FCT_SystemBodySurveys.RaceID = ${this.RaceID})`)

        return deposits
      }),
      default: [],
    },

    // The race's colonies: stock and reserve of each mineral, mining in mine equivalents (manned, automated) and
    // civilian complexes, mass drivers and where they send.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [colonies] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_Population.Population, FCT_Population.Capital, FCT_Population.MassDriverDest, case when FCT_Race.NPR = 1 then 1 else FCT_Population.PurchaseCivilianMinerals end as PurchaseCivilianMinerals, ${MINERAL_NAMES.map((name) => `FCT_Population.${name}, FCT_Population.Reserve${name}`).join(', ')}, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, coalesce(VIR_Installations.Mines, 0) as Mines, coalesce(VIR_Installations.Automines, 0) as Automines, coalesce(VIR_Installations.Complexes, 0) as Complexes, coalesce(VIR_Installations.MassDrivers, 0) as MassDrivers from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID left join (select FCT_PopulationInstallations.PopID, sum(case when DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Mines, sum(case when DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers = 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Automines, sum(case when DIM_PlanetaryInstallation.CivilianInstallation = 1 and DIM_PlanetaryInstallation.MiningProductionValue > 0 then FCT_PopulationInstallations.Amount else 0 end) as Complexes, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MassDriverValue) as MassDrivers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)

        return colonies
      }),
      default: [],
    },

    // What each colony's queue still needs: industrial projects (per unit, times the units left) and shipyard
    // tasks (their full cost, times the share of build points left).
    needs: {
      get: tracked('needs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [needs] = await this.database.query(`select VIR_Needs.PopulationID, ${sums('VIR_Needs')} from (select FCT_IndustrialProjects.PopulationID, ${MINERAL_NAMES.map((name) => `FCT_IndustrialProjects.${name} * FCT_IndustrialProjects.Amount as ${name}`).join(', ')} from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID} union all select FCT_ShipyardTask.PopulationID, ${MINERAL_NAMES.map((name) => `FCT_ShipyardTask.${name} * (FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP) / FCT_ShipyardTask.TotalBP as ${name}`).join(', ')} from FCT_ShipyardTask where FCT_ShipyardTask.GameID = ${this.GameID} and FCT_ShipyardTask.RaceID = ${this.RaceID} and FCT_ShipyardTask.TotalBP > 0) as VIR_Needs group by VIR_Needs.PopulationID`)

        return needs
      }),
      default: [],
    },

    // Mass-driver packets in flight, by the colony they are bound for.
    packets: {
      get: tracked('packets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [packets] = await this.database.query(`select FCT_MassDriverPackets.DestID as PopulationID, ${sums('FCT_MassDriverPackets')} from FCT_MassDriverPackets where FCT_MassDriverPackets.GameID = ${this.GameID} and FCT_MassDriverPackets.RaceID = ${this.RaceID} group by FCT_MassDriverPackets.DestID`)

        return packets
      }),
      default: [],
    },

    // The race's ships with mining modules, by the body their fleet orbits.
    miners: {
      get: tracked('miners', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [miners] = await this.database.query(`select FCT_Fleet.OrbitBodyID as SystemBodyID, count(*) as Ships, sum(FCT_ShipClass.MiningModules) as Modules from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Fleet.OrbitBodyID > 0 group by FCT_Fleet.OrbitBodyID`)

        return miners
      }),
      default: [],
    },

    // Alien colonies the race knows of, on their bodies.
    aliens: {
      get: tracked('aliens', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [aliens] = await this.database.query(`select FCT_AlienPopulation.PopulationID, FCT_AlienPopulation.PopulationName, FCT_Population.SystemBodyID, FCT_AlienRace.AlienRaceName from FCT_AlienPopulation inner join FCT_Population on FCT_Population.PopulationID = FCT_AlienPopulation.PopulationID left join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_AlienPopulation.AlienRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID} where FCT_AlienPopulation.GameID = ${this.GameID} and FCT_AlienPopulation.ViewingRaceID = ${this.RaceID}`)

        return aliens
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.minerals-page {
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
    height: 18px;
    line-height: 18px;
  }

  .tool--mineral {
    flex: 0 1 220px;
    min-width: 180px;
  }

  .tool--reach {
    flex: 0 1 280px;
    min-width: 200px;
  }

  .tool--actions {
    align-self: flex-end;
    margin-left: auto;
  }

  .toolbar .v-btn-toggle .v-btn,
  .tool--actions .v-btn,
  .selection-chip {
    height: 40px !important;
  }

  .selection-chip {
    max-width: 320px;
  }

  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  .stat-tile {
    padding: 16px;
    height: 100%;
  }

  .stat-value {
    font-size: 24px;
    line-height: 32px;
    font-weight: 400;
    margin: 4px 0;
  }

  .panel {
    margin-top: 8px;
  }

  > .panel {
    margin-top: 20px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 24px;
    font-size: 16px;
    line-height: 28px;
  }

  .head-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;

    .v-btn-toggle .v-btn {
      height: 40px !important;
    }
  }

  .panel-body {
    padding: 0 24px 16px;
  }

  .panel-foot {
    padding: 12px 24px 16px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
  }

  .dot {
    display: inline-block;
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
  }

  .dot-ring {
    background: transparent;
    border: 2px solid;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .selection-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 0 24px 12px;
  }

  .overview-row {
    cursor: pointer;
  }

  tr.is-selected-row {
    background: rgba(33, 150, 243, 0.08);
  }

  .band-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .band-meter,
  .meter {
    display: flex;
    flex: 0 0 72px;
    height: 6px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.08);
    overflow: hidden;
  }

  .band-meter__part,
  .meter-fill {
    height: 100%;
  }

  .meter-fill {
    border-radius: 3px;
  }

  .mineral-strip {
    display: flex;
    gap: 2px;
  }

  .mineral-strip__cell {
    flex: 0 0 22px;
    height: 20px;
    line-height: 17px;
    font-size: 10px;
    text-align: center;
    border-radius: 2px;
    border-bottom: 3px solid transparent;
  }

  .mineral-strip__cell--empty {
    opacity: 0.3;
  }

  .mineral-strip__cell--out {
    border: 1px dashed rgba(127, 127, 127, 0.6);
    line-height: 18px;
  }

  .chip-cell {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .wrap-cell {
    max-width: 260px;
  }

  .worker-cell {
    min-width: 140px;
  }

  .distance-cell {
    max-width: 140px;
  }

  .expand-cell {
    padding: 8px 24px 16px !important;
  }

  .detail-table {
    background: transparent !important;
  }

  .detail-links {
    margin-top: 8px;
  }
}

.theme--dark .minerals-page {
  .band-meter,
  .meter {
    background: rgba(255, 255, 255, 0.12);
  }

  tr.is-selected-row {
    background: rgba(33, 150, 243, 0.16);
  }
}
</style>
