<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <v-container v-else fluid class="logistics-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <v-btn-toggle v-model="view" mandatory dense @change="(value) => config.set('logisticsView', value)">
            <v-btn value="fuel" small><v-icon small left>mdi-gas-station</v-icon>Fuel</v-btn>
            <v-btn value="maintenance" small><v-icon small left>mdi-wrench</v-icon>Maintenance supplies</v-btn>
          </v-btn-toggle>
        </v-col>
      </v-row>

      <v-alert v-if="failedInputs.length" type="error" outlined dense class="mt-3">
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate class="mt-3" />

      <template v-if="ready">
        <v-row class="mt-2">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value">
                <v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon>{{ tile.value }}
              </div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <template v-if="view === 'fuel'">
          <v-row>
            <v-col cols="12" lg="5">
              <v-card class="panel" elevation="1">
                <div class="panel-head"><span>Fuel balance per year</span></div>
                <div class="panel-body">
                  <div v-for="group in fuelBalance" :key="group.label" class="balance-group">
                    <div class="balance-head">
                      <span>{{ group.label }}</span>
                      <span class="text-no-wrap">{{ group.total }}</span>
                    </div>
                    <div v-for="line in group.lines" :key="line.label" class="balance-row">
                      <span>{{ line.label }}</span>
                      <span class="balance-meter"><span class="balance-meter-fill" :class="line.color" :style="{ width: `${line.width}%` }" /></span>
                      <span class="text-no-wrap balance-value">{{ litres(line.value) }}</span>
                    </div>
                  </div>
                  <div class="caption text--secondary mt-3">
                    Burn is estimated two ways: each ship's lifetime average (distance travelled against time at full speed), and every ship that moved in the last increment running at full power all year. The truth is usually between them.
                  </div>
                </div>
              </v-card>
            </v-col>
            <v-col cols="12" lg="7">
              <v-card class="panel" elevation="1">
                <div class="panel-head">
                  <span>Burn by class</span>
                  <span class="legend">
                    <span class="legend-item"><span class="swatch" :style="{ background: theme.categorical[0] }" />Lifetime average</span>
                    <span class="legend-item"><span class="swatch" :style="{ background: theme.categorical[1] }" />Moving now, full power</span>
                  </span>
                </div>
                <div class="panel-body">
                  <chart-canvas v-if="burnRows.length" type="bar" :data="burnChart" :options="burnOptions" :height="Math.max(160, burnChart.labels.length * 26 + 40)" label="Estimated fuel burn per year by ship class" />
                  <div v-else class="caption text--secondary">No ships with engines and fuel tanks.</div>
                </div>
              </v-card>
            </v-col>
          </v-row>

          <v-card class="panel" elevation="1">
            <div class="panel-head">
              <span>Colony fuel and refineries</span>
              <v-chip small>{{ refineryRows.filter((row) => row.output > 0).length }} refining</v-chip>
            </div>
            <v-data-table :headers="refineryHeaders" :items="refineryRows" item-key="PopulationID" :sort-by.sync="refinerySortBy" :sort-desc.sync="refinerySortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }">
              <template #[`item.name`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.PopName }}</div>
                  <div class="caption text--secondary">{{ item.place }}</div>
                </div>
              </template>
              <template #[`item.FuelStockpile`]="{ item }">
                <span class="text-no-wrap">
                  <v-icon v-if="item.belowWarning" small color="warning" :title="`Below the colony's warning level of ${litres(item.WarningFuel)}`">mdi-alert</v-icon>
                  {{ litres(item.FuelStockpile) }}
                </span>
              </template>
              <template #[`item.Refineries`]="{ item }">{{ item.Refineries ? count(item.Refineries) : '—' }}</template>
              <template #[`item.output`]="{ item }">
                <span v-if="item.output > 0" class="text-no-wrap">{{ litres(item.output) }}</span>
                <span v-else-if="item.idleReason" class="text-no-wrap" :class="item.idleReason === 'Turned off' ? 'text--secondary' : 'warning--text'">{{ item.idleReason }}</span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.Sorium`]="{ item }">{{ item.Sorium >= 1 ? tons(item.Sorium) : '—' }}</template>
              <template #[`item.soriumSort`]="{ item }">
                <span v-if="item.soriumYears !== null" class="text-no-wrap" :class="{ 'warning--text': item.soriumYears < 5 }">{{ years(item.soriumYears) }}</span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.services`]="{ item }">
                <v-chip v-if="item.CanRefuel" x-small class="mr-1" title="Has a spaceport or refuelling station">Refuel</v-chip>
                <v-chip v-if="item.CanResupply" x-small title="Has a spaceport, cargo shuttle station or maintenance facility">Resupply</v-chip>
              </template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              A refinery makes {{ litres(raceFuelProduction) }} a year, times the colony's production modifiers (governor, sector, workers, species), using a tonne of Sorium per 2,000 L. Refining stops when the Sorium runs out.
            </div>
          </v-card>

          <v-card v-if="harvesterRows.length" class="panel" elevation="1">
            <div class="panel-head">
              <span>Sorium harvesters</span>
              <v-chip small>Estimate</v-chip>
            </div>
            <v-data-table :headers="harvesterHeaders" :items="harvesterRows" item-key="ShipID" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }">
              <template #[`item.ShipName`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.ShipName }}</div>
                  <div class="caption text--secondary">{{ item.FleetName }}</div>
                </div>
              </template>
              <template #[`item.output`]="{ item }">
                <span v-if="!item.Surveyed" class="text--secondary">Not surveyed</span>
                <span v-else-if="item.tanksFull" class="warning--text text-no-wrap">Tanks full</span>
                <span v-else class="text-no-wrap">{{ litres(item.output) }}</span>
              </template>
              <template #[`item.SoriumAmount`]="{ item }">{{ item.SoriumAmount === null ? '—' : tons(item.SoriumAmount) }}</template>
              <template #[`item.depositYears`]="{ item }">{{ item.depositYears === null ? '—' : years(item.depositYears) }}</template>
              <template #[`item.tanks`]="{ item }">{{ percent(item.tanks) }}</template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              Output uses the Aur_Calcs workbook's rule (each module runs at the racial refinery rate, times the deposit's accessibility, commander and naval-admin Mining bonuses and the share of crew aboard); the wiki gives a different base rate, so treat it as an estimate. A harvester stops when its tanks are full.
            </div>
          </v-card>
        </template>

        <template v-else>
          <v-card class="panel" elevation="1">
            <div class="panel-head">
              <span>Maintenance locations</span>
              <v-switch v-model="showIdleLocations" label="Show colonies without ships" dense hide-details class="mt-0" @change="(value) => config.set('logisticsShowIdleLocations', !!value)" />
            </div>
            <v-data-table :headers="locationHeaders" :items="visibleLocations" item-key="key" :sort-by.sync="locationSortBy" :sort-desc.sync="locationSortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }">
              <template #[`item.name`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div class="caption text--secondary">{{ item.place }}</div>
                </div>
              </template>
              <template #[`item.stock`]="{ item }">
                <span class="text-no-wrap">
                  <v-icon v-if="item.belowWarning" small color="warning" :title="`Below the warning level of ${count(item.warningLevel)}`">mdi-alert</v-icon>
                  {{ count(item.stock) }}
                </span>
                <div v-if="item.supply" class="caption text--secondary text-no-wrap">+{{ count(item.supply) }} on supply ships</div>
              </template>
              <template #[`item.production`]="{ item }">
                <span v-if="item.production > 0" class="text-no-wrap">{{ count(item.production) }}</span>
                <span v-else-if="item.potential > 0" class="text-no-wrap" :class="item.net < 0 ? 'error--text' : 'text--secondary'">Off ({{ count(item.potential) }})</span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.loadSort`]="{ item }">
                <div v-if="item.tons > 0 || item.capacity > 0" class="load-cell" :title="`${tons(item.tons)} maintained, capacity ${tons(item.capacity)}`">
                  <div class="meter">
                    <div class="meter-fill" :class="{ warning: item.tons > item.capacity }" :style="{ width: `${item.capacity > 0 ? Math.min(100, (item.tons / item.capacity) * 100) : 100}%` }" />
                  </div>
                  <span class="caption text-no-wrap" :class="{ 'warning--text': item.tons > item.capacity }">{{ tons(item.tons) }} / {{ tons(item.capacity) }}</span>
                </div>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.upkeep`]="{ item }">
                <span v-if="item.tons > 0 && item.capacity <= 0" class="error--text text-no-wrap" title="No maintenance facilities or modules here: the ships' maintenance clocks are running">Not maintained</span>
                <span v-else-if="item.upkeep > 0" class="text-no-wrap">{{ count(item.upkeep) }}<span v-if="item.rate < 1" class="caption warning--text"> at {{ percent(item.rate) }}</span></span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.net`]="{ item }">
                <span class="text-no-wrap" :class="{ 'error--text': item.net < 0 }">{{ signed(item.net) }}</span>
              </template>
              <template #[`item.runwaySort`]="{ item }">
                <span v-if="item.runway !== null" class="text-no-wrap" :class="{ 'error--text': item.runway < 1, 'warning--text': item.runway >= 1 && item.runway < 5 }">{{ years(item.runway) }}</span>
                <span v-else-if="item.upkeep > 0" class="text--secondary">Covered</span>
                <span v-else class="text--secondary">—</span>
              </template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              Ships use supplies where they are, not where they're assigned: the colony's stock first, then supply ships there, then their own. A maintained ship needs its class cost / 4 in MSP a year (its full cost while overhauling); commercial ships and craft in military hangars need none. Above capacity every ship there is maintained, and uses MSP, at the capacity / tonnage rate. Production: facilities × {{ count(raceMspProduction * 4) }} MSP × the colony's production modifiers, using
              {{ mspMineralsText }}.
            </div>
          </v-card>

          <v-card v-if="supplyFleets.length" class="panel" elevation="1">
            <div class="panel-head">
              <span>Supply ships</span>
              <v-chip small>{{ count(supplyFleets.reduce((sum, fleet) => sum + fleet.SupplyMSP, 0)) }} MSP above their minimums</v-chip>
            </div>
            <v-data-table :headers="supplyHeaders" :items="supplyFleets" item-key="FleetID" disable-pagination hide-default-footer dense>
              <template #[`item.SupplyMSP`]="{ item }">{{ count(item.SupplyMSP) }}</template>
            </v-data-table>
          </v-card>
        </template>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme } from '../components/charts/theme'
import productionModifiers from '../mixins/production-modifiers'
import { populationName, systemBodyName } from '../utilities/aurora'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { LITRES_PER_TON, MSP_MINERALS, fullPowerBurn, harvesterOutput, maintenanceLocations, refineryOutput } from '../utilities/logistics'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { navalAdminChainBonus } from '../utilities/minerals'
import { loadNavalAdmins } from '../utilities/naval-admins'

const INPUT_LABELS = {
  colonies: 'the colonies',
  fleets: 'fleets and their ships',
  harvesters: 'harvesters',
  burn: 'fuel burn by class',
  shipFuel: 'fuel on ships',
  navalAdmins: 'naval admin commands',
  populationProductionModifiers: 'production modifiers',
}
const INPUTS = Object.keys(INPUT_LABELS)
// Classes shown in the burn chart; the rest are folded into "Other classes".
const BURN_CLASSES = 12

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 1)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 0)}`
}

export default {
  name: 'LogisticsPage',
  components: { ChartCanvas },
  mixins: [productionModifiers],
  data() {
    return {
      view: 'fuel',
      showIdleLocations: false,
      refinerySortBy: ['FuelStockpile'],
      refinerySortDesc: [true],
      locationSortBy: ['runwaySort'],
      locationSortDesc: [false],
      loadErrors: {},
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS)
    },

    raceFuelProduction() {
      return this.colonies.length ? this.colonies[0].FuelProduction : 0
    },

    raceMspProduction() {
      return this.colonies.length ? this.colonies[0].MSPProduction : 0
    },

    mspMineralsText() {
      return MSP_MINERALS.map((mineral) => `${mineral.perMsp} t of ${mineral.name}`).join(', ').replace(/, ([^,]*)$/, ' and $1') + ' per MSP'
    },

    // FUEL

    refineryRows() {
      return this.colonies.filter((colony) => colony.FuelStockpile >= 1 || colony.Refineries >= 1).map((colony) => {
        const potential = refineryOutput(colony, this.modifierOf(colony.PopulationID))
        const output = colony.Sorium >= 1 ? potential : 0
        const soriumYears = output > 0 ? colony.Sorium / (output / LITRES_PER_TON) : null

        return {
          ...colony,
          name: colony.PopName,
          place: this.place(colony),
          output,
          idleReason: colony.Refineries < 1 || output > 0 ? null : !colony.FuelProdStatus ? 'Turned off' : colony.Sorium < 1 ? 'No Sorium' : 'No workers',
          soriumYears,
          soriumSort: soriumYears ?? Infinity,
          belowWarning: colony.WarningFuel > 0 && colony.FuelStockpile < colony.WarningFuel,
        }
      })
    },

    harvesterRows() {
      const rows = this.harvesters.map((ship) => {
        const tanksFull = ship.FuelCapacity > 0 && ship.Fuel >= ship.FuelCapacity * 0.999
        const output = ship.Surveyed && !tanksFull ? harvesterOutput(ship, navalAdminChainBonus(this.navalAdmins, ship.SystemID, ship.NavalAdminCommandID)) : 0

        return {
          ...ship,
          body: ship.SystemBodyID ? (ship.SystemBodyName ? `${ship.SystemName} · ${ship.SystemBodyName}` : systemBodyName(ship, { Name: ship.SystemName })) : `${ship.SystemName}, deep space`,
          output,
          tanksFull,
          tanks: ship.FuelCapacity > 0 ? ship.Fuel / ship.FuelCapacity : 0,
        }
      })
      const byBody = {}

      rows.forEach((row) => {
        byBody[row.SystemBodyID] = (byBody[row.SystemBodyID] || 0) + row.output
      })

      return rows.map((row) => ({ ...row, depositYears: row.SoriumAmount !== null && byBody[row.SystemBodyID] > 0 ? row.SoriumAmount / (byBody[row.SystemBodyID] / LITRES_PER_TON) : null }))
    },

    burnRows() {
      return this.burn.map((row) => {
        const full = fullPowerBurn(row)

        return { ...row, lifetime: row.DutyShips * full, moving: row.ShipsMoving * full }
      }).sort((a, b) => Math.max(b.lifetime, b.moving) - Math.max(a.lifetime, a.moving))
    },

    fuelTotals() {
      const colonies = this.colonies.reduce((sum, colony) => sum + colony.FuelStockpile, 0)
      const tankers = this.shipFuel.filter((row) => row.FuelTanker).reduce((sum, row) => sum + row.Fuel, 0)
      const ships = this.shipFuel.filter((row) => !row.FuelTanker).reduce((sum, row) => sum + row.Fuel, 0)
      const refineries = this.refineryRows.reduce((sum, row) => sum + row.output, 0)
      const harvesters = this.harvesterRows.reduce((sum, row) => sum + row.output, 0)
      const lifetime = this.burnRows.reduce((sum, row) => sum + row.lifetime, 0)
      const moving = this.burnRows.reduce((sum, row) => sum + row.moving, 0)

      return { colonies, tankers, ships, stock: colonies + tankers + ships, refineries, harvesters, production: refineries + harvesters, low: Math.min(lifetime, moving), high: Math.max(lifetime, moving), lifetime, moving }
    },

    fuelBalance() {
      const totals = this.fuelTotals
      const largest = Math.max(totals.production, totals.high) || 1
      const line = (label, value, color) => ({ label, value, color, width: (value / largest) * 100 })

      return [
        {
          label: 'Made',
          total: this.litres(totals.production),
          lines: [line('Refineries', totals.refineries, 'success'), ...(this.harvesterRows.length ? [line('Harvesters (estimate)', totals.harvesters, 'success')] : [])],
        },
        {
          label: 'Burned (estimate)',
          total: `${this.litres(totals.low)} – ${this.litres(totals.high)}`,
          lines: [line('Lifetime average', totals.lifetime, 'primary'), line('Moving now, full power', totals.moving, 'primary')],
        },
      ]
    },

    burnChart() {
      const shown = this.burnRows.slice(0, BURN_CLASSES)
      const rest = this.burnRows.slice(BURN_CLASSES)
      const rows = rest.length ? [...shown, { ClassName: `Other classes (${rest.length})`, lifetime: rest.reduce((sum, row) => sum + row.lifetime, 0), moving: rest.reduce((sum, row) => sum + row.moving, 0) }] : shown
      const [first, second] = this.theme.categorical

      return {
        labels: rows.map((row) => row.ClassName),
        datasets: [
          { label: 'Lifetime average', data: rows.map((row) => row.lifetime), backgroundColor: first, maxBarThickness: 10 },
          { label: 'Moving now, full power', data: rows.map((row) => row.moving), backgroundColor: second, maxBarThickness: 10 },
        ],
      }
    },

    burnOptions() {
      return {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, ticks: { callback: (value) => `${compact(value)} L` } },
          y: { grid: { display: false } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${this.litres(item.raw)} a year`,
            },
          },
        },
      }
    },

    // MAINTENANCE

    locations() {
      const economicModifier = this.colonies.length ? this.colonies[0].EconomicProdModifier : 1
      const maintenanceCapacity = this.colonies.length ? this.colonies[0].MaintenanceCapacity : 0

      return maintenanceLocations({ colonies: this.colonies, fleets: this.fleets, modifierOf: this.modifierOf, maintenanceCapacity, economicModifier }).map((location) => {
        const main = location.colonies.slice().sort((a, b) => b.Population - a.Population || b.MaintenanceStockpile - a.MaintenanceStockpile)[0]
        const fleets = location.fleets.filter((fleet) => fleet.MaintainedShips > 0 || fleet.MaintenanceModules > 0 || fleet.SupplyMSP > 0)

        return {
          ...location,
          name: main ? main.PopName : fleets.length ? fleets.map((fleet) => fleet.FleetName).slice(0, 2).join(', ') : location.fleets[0].FleetName,
          place: main ? this.place(main) : `${location.fleets[0].SystemName || 'Unknown system'}, deep space`,
          belowWarning: location.warningLevel > 0 && location.stock < location.warningLevel,
          loadSort: location.capacity > 0 ? location.tons / location.capacity : location.tons > 0 ? Infinity : 0,
          // Ships with no maintenance at all first, then the stock that runs out soonest.
          runwaySort: location.tons > 0 && location.capacity <= 0 ? -1 : location.runway ?? Infinity,
        }
      }).filter((location) => location.tons > 0 || location.stock >= 1 || location.potential > 0 || location.supply > 0)
    },

    visibleLocations() {
      return this.showIdleLocations ? this.locations : this.locations.filter((location) => location.tons > 0 || location.supply > 0)
    },

    supplyFleets() {
      return this.fleets.filter((fleet) => fleet.SupplyMSP >= 1).map((fleet) => ({ ...fleet, place: fleet.SystemName || 'Unknown system' })).sort((a, b) => b.SupplyMSP - a.SupplyMSP)
    },

    mspTotals() {
      const sum = (key) => this.locations.reduce((total, location) => total + location[key], 0)
      const unmaintained = this.locations.filter((location) => location.tons > 0 && location.capacity <= 0)

      return {
        stock: sum('stock'),
        supply: sum('supply'),
        production: sum('production'),
        potential: sum('potential'),
        upkeep: sum('upkeep'),
        overloaded: this.locations.filter((location) => location.rate < 1 && location.capacity > 0).length,
        short: this.locations.filter((location) => location.runway !== null && location.runway < 5).length,
        unmaintainedShips: unmaintained.reduce((total, location) => total + location.ships, 0),
        unmaintainedTons: unmaintained.reduce((total, location) => total + location.tons, 0),
      }
    },

    tiles() {
      const fuel = this.fuelTotals
      const msp = this.mspTotals
      const fuelNet = fuel.production - fuel.high
      const mspNet = msp.production - msp.upkeep
      const mspStock = msp.stock + msp.supply

      return [
        {
          label: 'Fuel stock',
          value: this.litres(fuel.stock),
          note: `Colonies ${this.litres(fuel.colonies)}, tankers ${this.litres(fuel.tankers)}, other ships ${this.litres(fuel.ships)}`,
        },
        {
          label: 'Fuel per year',
          value: this.signedLitres(fuelNet),
          note: `Made ${this.litres(fuel.production)}, burned about ${this.litres(fuel.low)}–${this.litres(fuel.high)}${fuelNet < 0 && fuel.stock > 0 ? `: stock lasts ${this.years(fuel.stock / -fuelNet)}` : ''}`,
          icon: fuelNet < 0 ? 'mdi-trending-down' : 'mdi-trending-up',
          iconColor: fuelNet < 0 ? 'error' : 'success',
        },
        {
          label: 'Maintenance supplies',
          value: `${this.count(mspStock)} MSP`,
          note: msp.unmaintainedShips ? `${this.count(msp.unmaintainedShips)} ships (${this.tons(msp.unmaintainedTons)}) are away from any maintenance` : `${this.count(msp.supply)} on supply ships; every ship is at a maintenance location`,
          icon: msp.unmaintainedShips ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Supplies per year',
          value: this.signed(mspNet),
          note: `Made ${this.count(msp.production)}${msp.potential > msp.production ? ` (${this.count(msp.potential)} with all on)` : ''}, used ${this.count(msp.upkeep)}${msp.short ? `; ${msp.short} running low` : ''}`,
          icon: mspNet < 0 ? 'mdi-trending-down' : 'mdi-trending-up',
          iconColor: mspNet < 0 ? 'error' : 'success',
        },
      ]
    },

    refineryHeaders() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Fuel', value: 'FuelStockpile', align: 'end' },
        { text: 'Refineries', value: 'Refineries', align: 'end' },
        { text: 'Made / yr', value: 'output', align: 'end' },
        { text: 'Sorium (t)', value: 'Sorium', align: 'end' },
        { text: 'Sorium lasts', value: 'soriumSort', align: 'end' },
        { text: 'Services', value: 'services', sortable: false },
      ]
    },

    harvesterHeaders() {
      return [
        { text: 'Ship', value: 'ShipName' },
        { text: 'At', value: 'body' },
        { text: 'Modules', value: 'Harvesters', align: 'end' },
        { text: 'Makes / yr', value: 'output', align: 'end' },
        { text: 'Sorium left (t)', value: 'SoriumAmount', align: 'end' },
        { text: 'Deposit lasts', value: 'depositYears', align: 'end' },
        { text: 'Tanks', value: 'tanks', align: 'end' },
      ]
    },

    locationHeaders() {
      return [
        { text: 'Location', value: 'name' },
        { text: 'MSP stock', value: 'stock', align: 'end' },
        { text: 'Made / yr', value: 'production', align: 'end' },
        { text: 'Maintained / capacity', value: 'loadSort' },
        { text: 'Used / yr', value: 'upkeep', align: 'end' },
        { text: 'Net / yr', value: 'net', align: 'end' },
        { text: 'Lasts', value: 'runwaySort', align: 'end' },
      ]
    },

    supplyHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'System', value: 'place' },
        { text: 'Supply ships', value: 'SupplyShips', align: 'end' },
        { text: 'MSP above minimum', value: 'SupplyMSP', align: 'end' },
      ]
    },
  },
  created() {
    this.view = this.config.get('logisticsView', 'fuel')
    this.showIdleLocations = this.config.get('logisticsShowIdleLocations', false)
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    modifierOf(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      return modifiers ? modifiers.OverallProductionModifier : 0
    },

    place(colony) {
      return stripHtml(populationName(colony)).replace(` — ${colony.PopName}`, '')
    },

    count(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    signed(value) {
      return `${value < 0 ? '−' : '+'}${this.count(Math.abs(value))}`
    },
    tons(value) {
      return `${compact(value || 0)} t`
    },
    litres(value) {
      return `${compact(value || 0)} L`
    },
    signedLitres(value) {
      return `${value < 0 ? '−' : '+'}${this.litres(Math.abs(value))}`
    },
    percent(fraction) {
      return `${roundToDecimal((fraction || 0) * 100, 0)}%`
    },
    years(value) {
      if (value > 10000) {
        return '> 10,000 y'
      } else if (value < 1) {
        return `${Math.max(1, Math.round(value * 12))} mo`
      }

      return `${separatedNumber(roundToDecimal(value, value < 100 ? 1 : 0), this.separator)} y`
    },
  },
  asyncComputed: {
    // Every colony, with what both fuel and maintenance need. Services: refuel needs a spaceport or
    // refuelling station; resupply a spaceport, cargo shuttle station or maintenance facility.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Efficiency, FCT_Population.SystemBodyID, FCT_Population.MaintenanceStockpile, FCT_Population.MaintProdStatus, FCT_Population.WarningMSP, FCT_Population.FuelStockpile, FCT_Population.FuelProdStatus, FCT_Population.WarningFuel, FCT_Population.Sorium, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Race.MSPProduction, FCT_Race.MaintenanceCapacity, FCT_Race.FuelProduction, FCT_Race.EconomicProdModifier, (1 - coalesce(FCT_SystemBody.RadiationLevel, 0) / 10000.0) * (1 - FCT_Population.UnrestPoints / 100.0) * coalesce(DIM_PopPoliticalStatus.ProductionMod, 1) as CapacityModifier, coalesce(VIR_Installations.MaintenanceFacilities, 0) as MaintenanceFacilities, coalesce(VIR_Installations.Refineries, 0) as Refineries, coalesce(VIR_Installations.Refuel, 0) as CanRefuel, coalesce(VIR_Installations.Resupply, 0) as CanResupply from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.MaintenanceValue * FCT_PopulationInstallations.Amount) as MaintenanceFacilities, sum(DIM_PlanetaryInstallation.RefineryProductionValue * FCT_PopulationInstallations.Amount) as Refineries, max(case when DIM_PlanetaryInstallation.MassRefuelling > 0 then 1 else 0 end) as Refuel, max(case when DIM_PlanetaryInstallation.MaintenanceValue > 0 or DIM_PlanetaryInstallation.CargoShuttleValue > 0 then 1 else 0 end) as Resupply from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    // Per fleet: what its ships need maintained (military classes not in a military hangar), the
    // maintenance modules aboard (scaled by crew), and supply ships' MSP above their minimums.
    fleets: {
      get: tracked('fleets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.OrbitBodyID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, sum(case when FCT_ShipClass.Commercial = 0 and coalesce(VIR_Mothership.CommercialHangar, 1) = 1 then 1 else 0 end) as MaintainedShips, sum(case when FCT_ShipClass.Commercial = 0 and coalesce(VIR_Mothership.CommercialHangar, 1) = 1 then FCT_ShipClass.Size * 50 else 0 end) as MaintainedTons, sum(case when FCT_ShipClass.Commercial = 0 and coalesce(VIR_Mothership.CommercialHangar, 1) = 1 then case when FCT_Ship.MaintenanceState = 2 then FCT_ShipClass.Cost else FCT_ShipClass.Cost / 4.0 end else 0 end) as AnnualMSP, sum(case when FCT_Ship.MothershipID = 0 and FCT_ShipClass.MaintModules > 0 then FCT_ShipClass.MaintModules * case when FCT_ShipClass.Crew > 0 then min(1.0, max(0, FCT_Ship.CurrentCrew) * 1.0 / FCT_ShipClass.Crew) else 1 end else 0 end) as MaintenanceModules, sum(case when FCT_ShipClass.SupplyShip = 1 and FCT_Ship.CurrentMaintSupplies > FCT_ShipClass.MinimumSupplies then FCT_Ship.CurrentMaintSupplies - FCT_ShipClass.MinimumSupplies else 0 end) as SupplyMSP, sum(case when FCT_ShipClass.SupplyShip = 1 then 1 else 0 end) as SupplyShips from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID left join (select FCT_Ship.ShipID, FCT_ShipClass.CommercialHangar from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}) as VIR_Mothership on VIR_Mothership.ShipID = FCT_Ship.MothershipID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID where FCT_Fleet.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_Fleet.FleetID`).then(([items]) => items)
      }),
      default: [],
    },
    // The race's harvesters; deposit figures only where the race has surveyed the body.
    harvesters: {
      get: tracked('harvesters', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_Fleet.SystemID, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.Fuel, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.Harvesters, FCT_ShipClass.FuelCapacity, FCT_Race.FuelProduction, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end as Surveyed, case when FCT_SystemBodySurveys.SystemBodyID is null then null else coalesce(FCT_MineralDeposit.Amount, 0) end as SoriumAmount, case when FCT_SystemBodySurveys.SystemBodyID is null then null else coalesce(FCT_MineralDeposit.Accessibility, 0) end as SoriumAccessibility, coalesce(VIR_Commander.BonusValue, 1) as MiningBonus from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.Harvesters > 0 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Ship.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID and FCT_RaceSysSurvey.GameID = FCT_Ship.GameID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodySurveys.RaceID = FCT_Ship.RaceID and FCT_SystemBodySurveys.GameID = FCT_Ship.GameID left join FCT_MineralDeposit on FCT_MineralDeposit.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_MineralDeposit.MaterialID = 8 and FCT_MineralDeposit.GameID = FCT_Ship.GameID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6 where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Commander on VIR_Commander.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 order by FCT_Fleet.FleetName, FCT_Ship.ShipName`).then(([items]) => items)
      }),
      default: [],
    },
    // Per class with engines and tanks (docked craft aside): ships moving in the last increment,
    // and the sum of each ship's lifetime duty cycle (distance / (age x top speed), age at least
    // a quarter year).
    burn: {
      get: tracked('burn', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, count(*) as Ships, sum(case when FCT_Fleet.Xcor <> FCT_Fleet.LastXcor or FCT_Fleet.Ycor <> FCT_Fleet.LastYcor then 1 else 0 end) as ShipsMoving, sum(min(1.0, FCT_Ship.DistanceTravelled / (max(FCT_Game.GameTime - FCT_Ship.Constructed, 7884000.0) * FCT_ShipClass.MaxSpeed))) as DutyShips from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_Game on FCT_Game.GameID = FCT_Ship.GameID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_Ship.MothershipID = 0 and FCT_ShipClass.EnginePower > 0 and FCT_ShipClass.MaxSpeed > 0 and FCT_ShipClass.FuelCapacity > 0 group by FCT_ShipClass.ShipClassID`).then(([items]) => items)
      }),
      default: [],
    },
    shipFuel: {
      get: tracked('shipFuel', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.FuelTanker, count(*) as Ships, sum(FCT_Ship.Fuel) as Fuel from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.FuelCapacity > 0 group by FCT_ShipClass.FuelTanker`).then(([items]) => items)
      }),
      default: [],
    },
    // Naval admin commands with their Mining bonus, for harvesters.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 6, share: 'Industrial' })
      }),
      default: {},
    },
  },
}
</script>

<style lang="scss">
.logistics-page {
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

  .balance-group + .balance-group {
    margin-top: 16px;
  }

  .balance-head {
    display: flex;
    justify-content: space-between;
    font-weight: 500;
    padding-bottom: 4px;
    margin-bottom: 4px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    font-variant-numeric: tabular-nums;
  }

  .balance-row {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) 2fr 84px;
    align-items: center;
    gap: 12px;
    padding: 4px 0;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  .balance-meter {
    height: 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.06);
    overflow: hidden;
  }

  .balance-meter-fill {
    display: block;
    height: 100%;
    border-radius: 4px;
  }

  .balance-value {
    text-align: right;
  }

  .load-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .meter {
    flex: 0 0 72px;
    height: 6px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.08);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
    background-color: #6a6a6a;
  }
}

.theme--dark .logistics-page {
  .balance-head {
    border-bottom-color: rgba(255, 255, 255, 0.12);
  }

  .balance-meter,
  .meter {
    background: rgba(255, 255, 255, 0.1);
  }

  .meter-fill {
    background-color: #b0b0b0;
  }
}
</style>
