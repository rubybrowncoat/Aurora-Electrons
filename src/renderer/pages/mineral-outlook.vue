<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <v-container v-else fluid class="mineral-outlook">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Ledger window</span>
          <v-btn-toggle v-model="windowDays" mandatory dense @change="(value) => config.set('mineralOutlookWindowDays', value)">
            <v-btn v-for="days in windowOptions" :key="days" :value="days" small>{{ days }} d</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Horizon</span>
          <v-btn-toggle v-model="horizon" mandatory dense @change="(value) => config.set('mineralOutlookHorizon', value)">
            <v-btn v-for="option in horizonOptions" :key="option" :value="option" small>{{ option }} y</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="12" sm="auto" class="mineral-select">
          <v-select v-model="focusMineralId" :items="mineralItems" item-text="name" item-value="id" label="Mineral" prepend-inner-icon="mdi-diamond-stone" dense outlined hide-details />
        </v-col>
      </v-row>

      <v-alert v-if="ledgerFailed" type="error" outlined dense class="mt-3">
        Couldn't read the mineral ledger: {{ ledgerError }}. The game may be saving; the page reads it again when the save changes.
        <template #append>
          <v-btn small text color="error" @click="$asyncComputed.ledger.update()">Retry</v-btn>
        </template>
      </v-alert>
      <v-alert v-else-if="ledgerLoaded && !hasLedger" type="info" outlined dense class="mt-3">
        This save has no mineral ledger (Aurora 2.6 adds one). Production comes from your mines, and use is the industry queue only: fuel refining, maintenance and shipbuilding aren't counted.
      </v-alert>
      <v-progress-linear v-else-if="!ledgerLoaded" indeterminate class="mt-3" />

      <!-- Runway, flows and the focused outlook need the ledger, or to know there is none: never a guess while it's loading or failed. -->
      <template v-if="ledgerLoaded">
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

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Mineral runway</span>
            <v-chip small>{{ coverageLabel }}</v-chip>
          </div>
          <v-data-table :headers="runwayHeaders" :items="mineralRows" item-key="id" :sort-by.sync="runwaySortBy" :sort-desc.sync="runwaySortDesc" :item-class="(item) => (item.id === focusMineralId ? 'is-focus-row' : '')" disable-pagination hide-default-footer class="runway-table" @click:row="(item) => (focusMineralId = item.id)">
            <template #[`item.name`]="{ item }">
              <span class="font-weight-medium">{{ item.name }}</span>
            </template>
            <template #[`item.stock`]="{ item }">{{ tons(item.stock) }}</template>
            <template #[`item.transit`]="{ item }">
              <span :class="{ 'text--secondary': !item.transit }">{{ tons(item.transit) }}</span>
            </template>
            <template #[`item.produced`]="{ item }">{{ tons(item.produced) }}</template>
            <template #[`item.used`]="{ item }">{{ tons(item.used) }}</template>
            <template #[`item.net`]="{ item }">
              <span class="text-no-wrap">
                <v-icon small :color="item.net < 0 ? 'error' : 'success'">{{ item.net < 0 ? 'mdi-arrow-down' : 'mdi-arrow-up' }}</v-icon>
                {{ signedTons(item.net) }}
              </span>
            </template>
            <template #[`item.runwaySort`]="{ item }">
              <div class="runway-cell">
                <div class="meter" :title="runwayLabel(item)">
                  <div class="meter-fill" :class="statusColor(item.status)" :style="{ width: `${meterWidth(item)}%` }" />
                </div>
                <span class="text-no-wrap">
                  <v-icon small :color="statusColor(item.status)">{{ statusIcon(item.status) }}</v-icon>
                  {{ runwayLabel(item) }}
                </span>
              </div>
            </template>
            <template #[`item.queue`]="{ item }">
              <span :class="{ 'text--secondary': !item.queue }">{{ tons(item.queue) }}</span>
            </template>
            <template #[`item.trend`]="{ item }">
              <v-sparkline v-if="item.trend.length > 1" :value="item.trend" :color="theme.inkMuted" :line-width="2" :padding="4" :smooth="2" height="36" width="120" class="trend" />
              <span v-else class="text--secondary">—</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            {{ hasLedger ? `Produced and used come from the game's mineral ledger over the last ${coverageText}, annualised. Freighter and mass-driver transfers between your colonies aren't counted. Industry queue: what the queued projects will use in the next 12 months.` : 'Produced comes from your mines; used is the industry queue over the next 12 months.' }}
            Click a row to see its outlook.
          </div>
        </v-card>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Where minerals come from and go</span>
            <v-btn-toggle v-model="flowsView" mandatory dense>
              <v-btn value="chart" small><v-icon small>mdi-chart-bar</v-icon></v-btn>
              <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
            </v-btn-toggle>
          </div>
          <div class="panel-body">
            <template v-if="flowsView === 'chart'">
              <div class="legend">
                <span v-for="group in presentFlowGroups" :key="group.key" class="legend-item">
                  <span class="swatch" :style="{ background: flowColor(group.key) }" />{{ group.label }}
                </span>
              </div>
              <chart-canvas type="bar" :data="flowsChart" :options="flowsOptions" :height="380" label="Mineral sources and uses per year, by purpose" />
              <div class="caption text--secondary mt-2">Tonnes per year. Sources to the right of zero, uses to the left.</div>
            </template>
            <v-data-table v-else :headers="flowsHeaders" :items="flowRows" item-key="id" disable-pagination hide-default-footer dense />
          </div>
        </v-card>

        <v-card v-if="focusRow" class="panel" elevation="1">
          <div class="panel-head">
            <span>{{ focusRow.name }} outlook</span>
            <span>
              <v-chip small class="mr-2">
                <v-icon small left :color="statusColor(projection.status)">{{ statusIcon(projection.status) }}</v-icon>{{ projection.summary }}
              </v-chip>
              <v-chip small>{{ focusDeposits.length }} {{ focusDeposits.length === 1 ? 'deposit' : 'deposits' }} mined</v-chip>
            </span>
          </div>
          <div class="panel-body">
            <v-row>
              <v-col cols="12" md="6">
                <div class="chart-title">Projected stockpile</div>
                <chart-canvas type="line" :data="stockChart" :options="stockOptions" :height="240" :label="`Projected ${focusRow.name} stockpile over ${horizon} years`" />
              </v-col>
              <v-col cols="12" md="6">
                <div class="chart-title">Projected mining output</div>
                <chart-canvas type="line" :data="outputChart" :options="outputOptions" :height="240" :label="`Projected ${focusRow.name} mining output over ${horizon} years`" />
              </v-col>
            </v-row>
            <div class="caption text--secondary">
              Mining follows each deposit's accessibility as it's worked down; other income and all uses stay at today's rates. In transit counts as stock.
            </div>
          </div>
        </v-card>
      </template>

      <v-card class="panel" elevation="1">
        <div class="panel-head">
          <span>Deposits being mined</span>
          <span class="d-flex align-center">
            <v-switch v-model="allDeposits" label="All minerals" dense hide-details class="mt-0 mr-6" @change="(value) => config.set('mineralOutlookAllDeposits', !!value)" />
            <v-switch v-model="onlyEmptying" :label="`Empty within ${horizon} y`" dense hide-details class="mt-0" @change="(value) => config.set('mineralOutlookOnlyEmptying', !!value)" />
          </span>
        </div>
        <v-data-table :headers="depositHeaders" :items="visibleDeposits" item-key="key" :expanded.sync="expandedDeposits" show-expand single-expand :sort-by.sync="depositSortBy" :sort-desc.sync="depositSortDesc" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, 60, -1] }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
          <template #[`item.place`]="{ item }">
            <div class="py-2">
              <div>{{ item.bodyName }}</div>
              <div v-if="item.sourceNames" class="caption text--secondary">{{ item.sourceNames }}</div>
            </div>
          </template>
          <template #[`item.amount`]="{ item }">{{ tons(item.amount) }}</template>
          <template #[`item.accessibility`]="{ item }">
            {{ fixed(item.accessibility, 2) }}
            <v-tooltip v-if="item.forecast.upgraded" top>
              <template #activator="{ on }">
                <v-icon small class="ml-1" v-on="on">mdi-information-outline</v-icon>
              </template>
              <span>Raised by a ground survey; the forecast uses the game's stored decline values.</span>
            </v-tooltip>
          </template>
          <template #[`item.rate`]="{ item }">
            <span v-if="item.rate > 0">{{ tons(item.rate) }}</span>
            <span v-else class="text--secondary">Idle</span>
          </template>
          <template #[`item.halfSort`]="{ item }">{{ halfLabel(item) }}</template>
          <template #[`item.emptySort`]="{ item }">
            <span class="text-no-wrap">
              <v-icon v-if="emptyingSoon(item)" small color="warning">mdi-alert</v-icon>
              {{ emptyLabel(item) }}
            </span>
          </template>
          <template #[`item.timeline`]="{ item }">
            <div class="timeline" :title="emptyLabel(item)">
              <div class="timeline-full primary" :style="{ width: `${timelineWidth(item, 'half')}%` }" />
              <div class="timeline-decline primary" :style="{ width: `${timelineWidth(item, 'decline')}%` }" />
              <div v-if="emptyingSoon(item)" class="timeline-end error" />
            </div>
          </template>
          <template #expanded-item="{ headers, item }">
            <td :colspan="headers.length" class="py-4">
              <div class="chart-title">Output of {{ item.mineral }} at {{ item.bodyName }}</div>
              <chart-canvas type="line" :data="depositChart(item)" :options="depositOptions(item)" :height="200" :label="`${item.mineral} output at ${item.bodyName} over time`" />
              <div class="caption text--secondary mt-1">
                {{ depositNote(item) }}
              </div>
            </td>
          </template>
        </v-data-table>
        <div class="panel-foot caption text--secondary">
          Rates include governor, sector, commander and naval-admin bonuses. Orbital mining uses the workbook's formula and is an estimate. Timeline: solid until half mined, lighter while accessibility falls, across {{ horizon }} years.
        </div>
      </v-card>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, flowColor, withAlpha } from '../components/charts/theme'
import productionModifiers from '../mixins/production-modifiers'
import { separatedNumber, roundToDecimal } from '../utilities/math'
import { systemBodyName, populationName } from '../utilities/aurora'
import { ENDLESS_YEARS, FLOW_GROUPS, MINERALS, SECONDS_PER_DAY, TRANSFER_TYPES, annualQueueDemand, depositForecast, depositStateAt, flowGroupOf, ledgerCoverageDays, navalAdminChainBonus, navalAdminRadius, navalAdminRequiredRanks, orbitalRate, stockProjection, surfaceRate, systemsWithinJumps, yearSteps } from '../utilities/minerals'

const BUCKET_DAYS = 5
const CRITICAL_YEARS = 5
const WARNING_YEARS = 25

const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 1)} Gt`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 1)} Mt`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} kt`
  }

  return `${roundToDecimal(value, 0)} t`
}

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'MineralOutlookPage',
  components: { ChartCanvas },
  mixins: [productionModifiers],
  data() {
    return {
      windowOptions: [30, 90, 180, 365],
      horizonOptions: [25, 50, 100, 250],
      windowDays: 365,
      // The last ledger read's error message, or null. Kept here because the async-computed
      // plugin's own error flag isn't reactive under Vue 2.
      ledgerError: null,
      horizon: 50,
      focusMineralId: null,
      flowsView: 'chart',
      allDeposits: false,
      onlyEmptying: false,
      expandedDeposits: [],
      runwaySortBy: ['runwaySort'],
      runwaySortDesc: [false],
      depositSortBy: ['emptySort'],
      depositSortDesc: [false],
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

    mineralItems() {
      return MINERALS
    },

    hasLedger() {
      return !!(this.ledger && this.ledger.length)
    },

    // Read, or known to be absent. A failed read keeps the last value, which may be stale.
    ledgerLoaded() {
      return this.ledger !== null && !this.ledgerFailed
    },

    ledgerFailed() {
      return this.ledgerError !== null
    },

    coverageDays() {
      if (!this.hasLedger || !this.game) {
        return 0
      }

      // Each mining event stands for one production cycle; minerals mined together share their times.
      const mining = this.ledger.filter((row) => row.MineralDataType === 1)
      const rows = mining.length ? mining : this.ledger
      const eventsByMineral = {}

      rows.forEach((row) => {
        eventsByMineral[row.MaterialID] = (eventsByMineral[row.MaterialID] || 0) + row.Events
      })

      return ledgerCoverageDays({
        gameTime: this.game.GameTime,
        firstTime: Math.min(...rows.map((row) => row.FirstTime)),
        lastTime: Math.max(...rows.map((row) => row.LastTime)),
        events: Math.max(...Object.values(eventsByMineral)),
        windowDays: this.windowDays,
      })
    },

    coverageText() {
      return `${roundToDecimal(this.coverageDays, 0)} days`
    },

    coverageLabel() {
      return this.hasLedger ? `Ledger: last ${this.coverageText}` : 'No ledger'
    },

    perYear() {
      return this.coverageDays ? 365 / this.coverageDays : 0
    },

    // { [MaterialID]: { [groupKey]: t/yr } }
    flowsByMineral() {
      const flows = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, 0]))]))

      if (!this.hasLedger) {
        return flows
      }

      this.ledger.forEach((row) => {
        const group = !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)

        if (group && flows[row.MaterialID]) {
          flows[row.MaterialID][group.key] += row.Amount * this.perYear
        }
      })

      return flows
    },

    // Mined deposits: every colony and orbital miner on the same body and mineral summed.
    deposits() {
      const deposits = {}
      const add = (row, source) => {
        const key = `${row.SystemBodyID}-${row.MaterialID}`

        if (!deposits[key]) {
          deposits[key] = {
            key,
            SystemBodyID: row.SystemBodyID,
            MaterialID: row.MaterialID,
            mineral: MINERALS.find((mineral) => mineral.id === row.MaterialID).name,
            systemName: row.SystemName,
            bodyName: row.SystemBodyName ? `${row.SystemName} · ${row.SystemBodyName}` : systemBodyName(row, { Name: row.SystemName }),
            Amount: row.Amount,
            Accessibility: row.Accessibility,
            HalfOriginalAmount: row.HalfOriginalAmount,
            OriginalAcc: row.OriginalAcc,
            sources: [],
            rate: 0,
            delivered: 0,
          }
        }

        deposits[key].sources.push(source)
        deposits[key].rate += source.rate
        deposits[key].delivered += source.delivered
      }

      this.surfaceMining.forEach((row) => {
        add(row, { name: stripHtml(populationName(row, '', true)), kind: 'surface', rate: surfaceRate(row, false), delivered: surfaceRate(row, true) })
      })

      this.orbitalMining.forEach((row) => {
        const tooLarge = row.MaximumOrbitalMiningDiameter > 0 && row.Diameter > row.MaximumOrbitalMiningDiameter
        const rate = tooLarge ? 0 : orbitalRate(row, navalAdminChainBonus(this.navalAdmins, row.SystemID, row.NavalAdminCommandID))

        add(row, { name: row.ShipName, kind: 'orbital', rate, delivered: rate })
      })

      return Object.values(deposits).map((deposit) => {
        const forecast = depositForecast(deposit, deposit.rate)

        return {
          ...deposit,
          amount: deposit.Amount,
          accessibility: deposit.Accessibility,
          forecast,
          sourceNames: deposit.sources.filter((source) => source.name !== deposit.bodyName).map((source) => (source.kind === 'orbital' ? `${source.name} (orbital)` : source.name)).join(', '),
          deliveredShare: deposit.rate > 0 ? deposit.delivered / deposit.rate : 0,
          halfSort: forecast.yearsToHalf ?? Infinity,
          emptySort: forecast.idle ? Infinity : forecast.yearsToDepletion,
        }
      })
    },

    queueDemand() {
      return annualQueueDemand(this.industrialProjects, (populationId, productionType) => {
        if (productionType === 1) {
          return this.populationOrdnanceCapacity(populationId)
        } else if (productionType === 2) {
          return this.populationFighterCapacity(populationId)
        }

        return this.populationConstructionCapacity(populationId)
      })
    },

    mineralRows() {
      return MINERALS.map((mineral) => {
        const flows = this.flowsByMineral[mineral.id]
        const stock = (this.stockpile && this.stockpile[mineral.name]) || 0
        const transit = (this.cargo[mineral.id] || 0) + ((this.packets && this.packets[mineral.name]) || 0)
        const mined = this.deposits.filter((deposit) => deposit.MaterialID === mineral.id).reduce((sum, deposit) => sum + deposit.delivered, 0)
        const produced = this.hasLedger ? FLOW_GROUPS.filter((group) => group.income).reduce((sum, group) => sum + flows[group.key], 0) : mined
        const used = this.hasLedger ? FLOW_GROUPS.filter((group) => !group.income).reduce((sum, group) => sum + flows[group.key], 0) : this.queueDemand[mineral.name]
        const net = produced - used
        const runway = net < 0 ? (stock + transit) / -net : null

        return {
          id: mineral.id,
          name: mineral.name,
          stock,
          transit,
          produced,
          used,
          net,
          runway,
          status: this.runwayStatus(runway, produced, used),
          runwaySort: runway ?? Infinity,
          queue: this.queueDemand[mineral.name],
          trend: this.trendFor(mineral.id, stock + transit),
          otherIncome: this.hasLedger ? produced - flows.mining : 0,
        }
      })
    },

    focusRow() {
      return this.mineralRows.find((row) => row.id === this.focusMineralId)
    },

    focusDeposits() {
      return this.deposits.filter((deposit) => deposit.MaterialID === this.focusMineralId)
    },

    visibleDeposits() {
      return this.deposits.filter((deposit) => (this.allDeposits || deposit.MaterialID === this.focusMineralId) && (!this.onlyEmptying || (!deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon)))
    },

    tiles() {
      const declining = this.mineralRows.filter((row) => row.runway !== null)
      const shortest = declining.slice().sort((a, b) => a.runway - b.runway)[0]
      const active = this.deposits.filter((deposit) => !deposit.forecast.idle)
      const emptying = active.filter((deposit) => deposit.forecast.yearsToDepletion <= this.horizon)
      const minedPerYear = this.hasLedger ? this.mineralRows.reduce((sum, row) => sum + this.flowsByMineral[row.id].mining, 0) : this.deposits.reduce((sum, deposit) => sum + deposit.delivered, 0)

      return [
        {
          label: 'Shortest runway',
          value: shortest ? `${shortest.name} · ${this.years(shortest.runway)}` : 'None running down',
          note: shortest ? 'Stock and transit at today\'s net rate' : 'Every mineral breaks even or grows',
          icon: shortest ? this.statusIcon(shortest.status) : 'mdi-check-circle',
          iconColor: shortest ? this.statusColor(shortest.status) : 'success',
        },
        {
          label: 'Minerals running down',
          value: `${declining.length} of ${MINERALS.length}`,
          note: declining.length ? declining.map((row) => row.name).join(', ') : 'None',
        },
        {
          label: `Deposits emptying within ${this.horizon} y`,
          value: `${emptying.length}`,
          note: `Of ${active.length} mined deposits`,
          icon: emptying.length ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Mined per year',
          value: this.tons(minedPerYear),
          note: this.hasLedger ? 'From the ledger, all minerals' : 'From your mines, all minerals',
        },
      ]
    },

    runwayHeaders() {
      return [
        { text: 'Mineral', value: 'name' },
        { text: 'Stockpile (t)', value: 'stock', align: 'end' },
        { text: 'In transit (t)', value: 'transit', align: 'end' },
        { text: 'Produced / yr', value: 'produced', align: 'end' },
        { text: 'Used / yr', value: 'used', align: 'end' },
        { text: 'Net / yr', value: 'net', align: 'end' },
        { text: 'Runway', value: 'runwaySort' },
        { text: 'Industry queue (12 mo)', value: 'queue', align: 'end' },
        { text: `Stock, last ${this.coverageText}`, value: 'trend', sortable: false },
      ]
    },

    presentFlowGroups() {
      return FLOW_GROUPS.filter((group) => MINERALS.some((mineral) => this.flowsByMineral[mineral.id][group.key] > 0))
    },

    flowRows() {
      return MINERALS.map((mineral) => ({ id: mineral.id, name: mineral.name, ...Object.fromEntries(FLOW_GROUPS.map((group) => [group.key, this.tons(this.flowsByMineral[mineral.id][group.key])])) }))
    },

    flowsHeaders() {
      return [{ text: 'Mineral (t / yr)', value: 'name' }, ...this.presentFlowGroups.map((group) => ({ text: `${group.label}${group.income ? '' : ' (use)'}`, value: group.key, align: 'end' }))]
    },

    flowsChart() {
      return {
        labels: MINERALS.map((mineral) => mineral.name),
        datasets: this.presentFlowGroups.map((group) => ({
          label: group.label,
          data: MINERALS.map((mineral) => (group.income ? 1 : -1) * this.flowsByMineral[mineral.id][group.key]),
          backgroundColor: this.flowColor(group.key),
          borderColor: this.theme.surface,
          borderWidth: { left: 1, right: 1, top: 0, bottom: 0 },
          borderSkipped: false,
          maxBarThickness: 20,
          stack: 'flows',
        })),
      }
    },

    flowsOptions() {
      return {
        indexAxis: 'y',
        scales: {
          x: {
            stacked: true,
            ticks: { callback: (value) => compact(Math.abs(value)) },
            grid: { color: (context) => (context.tick && context.tick.value === 0 ? this.theme.inkMuted : `${this.theme.border}99`) },
          },
          y: { stacked: true, grid: { display: false } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => `${this.tons(Math.abs(item.raw))} t/yr · ${item.dataset.label}${item.raw < 0 ? ' (use)' : ''}`,
            },
          },
        },
      }
    },

    projectionSteps() {
      return yearSteps(this.horizon, 100)
    },

    projection() {
      const row = this.focusRow
      const steps = this.projectionSteps

      if (!row) {
        return { stock: [], output: [], status: 'ok', summary: '' }
      }

      const { stock, output, runOut } = stockProjection({
        start: row.stock + row.transit,
        otherNet: row.otherIncome - row.used,
        deposits: this.focusDeposits.map((deposit) => ({ deposit, rate: deposit.rate, share: deposit.deliveredShare })),
        steps,
      })

      const firstEmpty = this.focusDeposits.filter((deposit) => !deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon).sort((a, b) => a.forecast.yearsToDepletion - b.forecast.yearsToDepletion)[0]

      const summary = runOut !== null ? `Runs out in ${this.years(runOut)}` : stock[stock.length - 1] < stock[0] ? `Falling, ${compact(stock[stock.length - 1])} left in ${this.horizon} y` : `Lasts past ${this.horizon} y`
      const status = runOut !== null ? (runOut < CRITICAL_YEARS ? 'critical' : 'warning') : stock[stock.length - 1] < stock[0] ? 'ok' : 'growing'

      return { stock, output, runOut, firstEmpty, summary, status }
    },

    stockChart() {
      const color = this.theme.primary

      return {
        datasets: [{
          label: 'Stockpile',
          data: this.projectionSteps.map((year, index) => ({ x: year, y: this.projection.stock[index] })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          fill: 'origin',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
        }],
      }
    },

    stockOptions() {
      return this.lineOptions({
        unit: 't',
        markers: this.projection.runOut !== null ? [{ x: this.projection.runOut, label: `Runs out, ${this.years(this.projection.runOut)}` }] : [],
      })
    },

    outputChart() {
      const color = this.theme.primary

      return {
        datasets: [{
          label: 'Mining output',
          data: this.projectionSteps.map((year, index) => ({ x: year, y: this.projection.output[index] })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          fill: 'origin',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
        }],
      }
    },

    outputOptions() {
      const first = this.projection.firstEmpty

      return this.lineOptions({
        unit: 't/yr',
        markers: first ? [{ x: first.forecast.yearsToDepletion, label: `${first.bodyName} empties` }] : [],
      })
    },

    depositHeaders() {
      return [
        { text: 'Deposit', value: 'place', sortable: false },
        { text: 'Mineral', value: 'mineral' },
        { text: 'Remaining (t)', value: 'amount', align: 'end' },
        { text: 'Accessibility', value: 'accessibility', align: 'end' },
        { text: 'Mined / yr', value: 'rate', align: 'end' },
        { text: 'Half mined in', value: 'halfSort', align: 'end' },
        { text: 'Empty in', value: 'emptySort', align: 'end' },
        { text: `Next ${this.horizon} years`, value: 'timeline', sortable: false, width: '18%' },
        { text: '', value: 'data-table-expand' },
      ]
    },
  },
  watch: {
    mineralRows: {
      immediate: true,
      handler(rows) {
        if (this.focusMineralId || !rows.length || !this.stockpile || this.ledger === null) {
          return
        }

        const declining = rows.filter((row) => row.runway !== null).sort((a, b) => a.runway - b.runway)[0]

        this.focusMineralId = declining ? declining.id : rows[0].id
      },
    },
  },
  created() {
    this.windowDays = this.config.get('mineralOutlookWindowDays', 365)
    this.horizon = this.config.get('mineralOutlookHorizon', 50)
    this.allDeposits = this.config.get('mineralOutlookAllDeposits', false)
    this.onlyEmptying = this.config.get('mineralOutlookOnlyEmptying', false)
  },
  methods: {
    flowColor(key) {
      return flowColor(this.$vuetify.theme.dark, key)
    },

    tons(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    signedTons(value) {
      return `${value < 0 ? '−' : '+'}${this.tons(Math.abs(value))}`
    },
    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
    years(value) {
      if (value === null || value === undefined) {
        return '—'
      } else if (value > ENDLESS_YEARS) {
        return `> ${separatedNumber(ENDLESS_YEARS, this.separator)} y`
      } else if (value < 1) {
        return `${Math.max(1, Math.round(value * 12))} mo`
      } else if (value < 100) {
        return `${roundToDecimal(value, 1)} y`
      }

      return `${separatedNumber(Math.round(value), this.separator)} y`
    },

    runwayStatus(runway, produced, used) {
      if (runway === null) {
        return produced === 0 && used === 0 ? 'idle' : 'growing'
      } else if (runway < CRITICAL_YEARS) {
        return 'critical'
      } else if (runway < WARNING_YEARS) {
        return 'warning'
      }

      return 'ok'
    },
    runwayLabel(row) {
      if (row.status === 'idle') {
        return 'No activity'
      } else if (row.status === 'growing') {
        return 'Growing'
      }

      return this.years(row.runway)
    },
    statusIcon(status) {
      return { critical: 'mdi-alert-octagon', warning: 'mdi-alert', ok: 'mdi-trending-down', growing: 'mdi-trending-up', idle: 'mdi-minus' }[status]
    },
    statusColor(status) {
      return { critical: 'error', warning: 'warning', ok: '', growing: 'success', idle: '' }[status]
    },
    meterWidth(row) {
      if (row.runway === null) {
        return row.status === 'growing' ? 100 : 0
      }

      return Math.max(2, Math.min(100, (row.runway / this.horizon) * 100))
    },

    // Stock (with transit) at the end of each ledger bucket, oldest first.
    trendFor(materialId, current) {
      if (!this.hasLedger) {
        return []
      }

      const nets = {}

      this.ledger.forEach((row) => {
        if (row.MaterialID !== materialId || TRANSFER_TYPES.has(row.MineralDataType)) {
          return
        }

        const group = flowGroupOf(row.MineralDataType)

        if (group) {
          nets[row.Bucket] = (nets[row.Bucket] || 0) + (group.income ? row.Amount : -row.Amount)
        }
      })

      const buckets = Math.ceil(this.coverageDays / BUCKET_DAYS)
      const points = [current]
      let level = current

      for (let bucket = 0; bucket < buckets; bucket++) {
        level -= nets[bucket] || 0
        points.unshift(level)
      }

      return points
    },

    halfLabel(deposit) {
      const { forecast } = deposit

      if (forecast.idle) {
        return '—'
      } else if (forecast.yearsToHalf === null) {
        return 'No decline'
      } else if (forecast.yearsToHalf === 0) {
        return 'Past half'
      }

      return this.years(forecast.yearsToHalf)
    },
    emptyLabel(deposit) {
      return deposit.forecast.idle ? 'Not being mined' : this.years(deposit.forecast.yearsToDepletion)
    },
    emptyingSoon(deposit) {
      return !deposit.forecast.idle && deposit.forecast.yearsToDepletion <= this.horizon
    },
    timelineWidth(deposit, part) {
      const { forecast } = deposit

      if (forecast.idle) {
        return 0
      }

      const half = forecast.yearsToHalf === null ? Math.min(forecast.yearsToDepletion, this.horizon) : Math.min(forecast.yearsToHalf, this.horizon)
      const end = Math.min(forecast.yearsToDepletion, this.horizon)

      return part === 'half' ? (half / this.horizon) * 100 : (Math.max(0, end - half) / this.horizon) * 100
    },

    depositSpan(deposit) {
      const { forecast } = deposit

      return forecast.idle || forecast.endless ? this.horizon : Math.max(1, forecast.yearsToDepletion * 1.05)
    },
    depositChart(deposit) {
      const color = this.theme.primary
      const steps = yearSteps(this.depositSpan(deposit), 80)

      return {
        datasets: [{
          label: 'Output',
          data: steps.map((year) => {
            const state = depositStateAt(deposit, deposit.rate, year)

            return { x: year, y: state.rate * deposit.deliveredShare, accessibility: state.accessibility, amount: state.amount }
          }),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          fill: 'origin',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
        }],
      }
    },
    depositOptions(deposit) {
      const { forecast } = deposit
      const markers = []

      if (forecast.yearsToHalf > 0 && forecast.yearsToHalf < this.depositSpan(deposit)) {
        markers.push({ x: forecast.yearsToHalf, label: 'Half mined' })
      }

      if (!forecast.idle && !forecast.endless) {
        markers.push({ x: forecast.yearsToDepletion, label: 'Empty' })
      }

      return this.lineOptions({
        unit: 't/yr',
        markers,
        extraLabel: (raw) => [`Accessibility ${this.fixed(raw.accessibility, 2)}`, `${this.tons(raw.amount)} t left`],
      })
    },
    depositNote(deposit) {
      const { forecast } = deposit

      if (forecast.idle) {
        return 'Nothing is being mined here at the moment (no workers or a colony at zero efficiency).'
      } else if (forecast.endless) {
        return `At today's rate this deposit lasts more than ${separatedNumber(ENDLESS_YEARS, this.separator)} years.`
      } else if (forecast.yearsToHalf === null) {
        return `Accessibility doesn't decline here; at today's rate it's empty in ${this.years(forecast.yearsToDepletion)}.`
      }

      return `Accessibility holds at ${this.fixed(deposit.OriginalAcc, 2)} until half the deposit is mined, then falls toward 0.10, slowing output until it's empty in ${this.years(forecast.yearsToDepletion)}.`
    },

    lineOptions({ unit, markers = [], extraLabel = null }) {
      return {
        scales: {
          x: {
            type: 'linear',
            min: 0,
            title: { display: true, text: 'Years from now' },
            ticks: { callback: (value) => separatedNumber(roundToDecimal(value, 1), this.separator) },
          },
          y: {
            beginAtZero: true,
            ticks: { callback: (value) => `${compact(value)}${unit === 't/yr' ? '/yr' : ''}` },
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => `Year ${roundToDecimal(items[0].parsed.x, 1)}`,
              label: (item) => [`${this.tons(item.parsed.y)} ${unit}`, ...(extraLabel ? extraLabel(item.raw) : [])],
            },
          },
          guides: { markers },
        },
      }
    },
  },
  asyncComputed: {
    game: {
      async get() {
        if (!this.database || !this.GameID) {
          return null
        }

        return await this.database.query(`select FCT_Game.GameTime, FCT_Game.StartYear from FCT_Game where FCT_Game.GameID = ${this.GameID}`).then(([items]) => items[0] || null)
      },
      default: null,
    },
    stockpile: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await this.database.query(`select sum(FCT_Population.Duranium) as Duranium, sum(FCT_Population.Neutronium) as Neutronium, sum(FCT_Population.Corbomite) as Corbomite, sum(FCT_Population.Tritanium) as Tritanium, sum(FCT_Population.Boronide) as Boronide, sum(FCT_Population.Mercassium) as Mercassium, sum(FCT_Population.Vendarite) as Vendarite, sum(FCT_Population.Sorium) as Sorium, sum(FCT_Population.Uridium) as Uridium, sum(FCT_Population.Corundium) as Corundium, sum(FCT_Population.Gallicite) as Gallicite from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      },
      default: null,
    },
    cargo: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const rows = await this.database.query(`select FCT_ShipCargo.CargoID as MaterialID, sum(FCT_ShipCargo.Amount) as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 3 group by FCT_ShipCargo.CargoID`).then(([items]) => items)

        return Object.fromEntries(rows.map((row) => [row.MaterialID, row.Amount]))
      },
      default: {},
    },
    packets: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await this.database.query(`select sum(FCT_MassDriverPackets.Duranium) as Duranium, sum(FCT_MassDriverPackets.Neutronium) as Neutronium, sum(FCT_MassDriverPackets.Corbomite) as Corbomite, sum(FCT_MassDriverPackets.Tritanium) as Tritanium, sum(FCT_MassDriverPackets.Boronide) as Boronide, sum(FCT_MassDriverPackets.Mercassium) as Mercassium, sum(FCT_MassDriverPackets.Vendarite) as Vendarite, sum(FCT_MassDriverPackets.Sorium) as Sorium, sum(FCT_MassDriverPackets.Uridium) as Uridium, sum(FCT_MassDriverPackets.Corundium) as Corundium, sum(FCT_MassDriverPackets.Gallicite) as Gallicite from FCT_MassDriverPackets where FCT_MassDriverPackets.GameID = ${this.GameID} and FCT_MassDriverPackets.RaceID = ${this.RaceID}`).then(([items]) => items[0] || null)
      },
      default: null,
    },
    // The game's mineral ledger (Aurora 2.6+), in 5-day buckets counted back from now.
    // Older saves don't have the table: null means "not loaded", [] means "none". Any other
    // failure (the game holding a lock while it saves, say) rejects, and the page says so.
    ledger: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        // Read before the first await, so a window change re-runs this getter.
        const windowDays = Number(this.windowDays) || 365
        const request = (this.ledgerRequest = (this.ledgerRequest || 0) + 1)

        try {
          const [[table]] = await this.database.query("select count(*) as Present from sqlite_master where type = 'table' and name = 'FCT_RaceMineralData'")
          const rows = table.Present ? await this.database.query(`select FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, cast((FCT_Game.GameTime - FCT_RaceMineralData.Time) / ${BUCKET_DAYS * SECONDS_PER_DAY} as integer) as Bucket, sum(FCT_RaceMineralData.Amount) as Amount, min(FCT_RaceMineralData.Time) as FirstTime, max(FCT_RaceMineralData.Time) as LastTime, count(distinct FCT_RaceMineralData.Time) as Events from FCT_RaceMineralData inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID where FCT_RaceMineralData.GameID = ${this.GameID} and FCT_RaceMineralData.RaceID = ${this.RaceID} and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${windowDays * SECONDS_PER_DAY} group by FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType, Bucket`).then(([items]) => items) : []

          if (request === this.ledgerRequest) {
            this.ledgerError = null
          }

          return rows
        } catch (error) {
          if (request === this.ledgerRequest) {
            this.ledgerError = (error && error.message) || String(error)
          }

          throw error
        }
      },
      default: null,
    },
    surfaceMining: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.Radius * 2 as Diameter, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, VIR_Mines.MineCount, VIR_Mines.OwnedMineCount, VIR_Mines.ManualMineCount, FCT_Race.MineProduction, coalesce(VIR_Governor.BonusValue, 1) as GovernorBonus, 1 + (coalesce(VIR_Sector.BonusValue, 1) - 1) * 0.25 as SectorBonus, FCT_Population.Efficiency, (1 - FCT_SystemBody.RadiationLevel / 10000) as RadiationModifier, (1 - FCT_Population.UnrestPoints / 100) as StabilityModifier, DIM_PopPoliticalStatus.ProductionMod as PoliticalModifier, FCT_Race.EconomicProdModifier from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Population.RaceID and FCT_SystemBodySurveys.GameID = FCT_Population.GameID inner join FCT_MineralDeposit on FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID inner join (select FCT_PopulationInstallations.PopID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue) as MineCount, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID = 39 and VIR_Owner.PurchaseCivilianMinerals = 0 then 0 else FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue end) as OwnedMineCount, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID in (7, 38, 48) then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as ManualMineCount from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID inner join FCT_Population as VIR_Owner on VIR_Owner.PopulationID = FCT_PopulationInstallations.PopID where FCT_PopulationInstallations.GameID = ${this.GameID} and DIM_PlanetaryInstallation.MiningProductionValue > 0 and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Mines on VIR_Mines.PopID = FCT_Population.PopulationID left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6 where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6 where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_Sector on VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => items)
      },
      default: [],
    },
    orbitalMining: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.MiningModules, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.Radius * 2 as Diameter, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, FCT_Race.MineProduction, FCT_Race.MaximumOrbitalMiningDiameter, coalesce(VIR_Commander.BonusValue, 1) as CommanderBonus from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID inner join FCT_Population on FCT_Population.PopulationID = FCT_Fleet.AssignedPopulationID and FCT_Population.SystemBodyID = FCT_Fleet.OrbitBodyID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodySurveys.RaceID = FCT_Ship.RaceID and FCT_SystemBodySurveys.GameID = FCT_Ship.GameID inner join FCT_MineralDeposit on FCT_MineralDeposit.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_MineralDeposit.GameID = FCT_Ship.GameID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Ship.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6 where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Commander on VIR_Commander.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}`).then(([items]) => items)
      },
      default: [],
    },
    // Naval admin commands with their Mining bonus and the systems in their range.
    navalAdmins: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const admins = await this.database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.ParentAdminCommandID as ParentCommandID, FCT_NavalAdminCommand.ShipID, FCT_NavalAdminCommand.MinimumRankPriority, case when FCT_NavalAdminCommand.ShipID > 0 then VIR_Flagship.SystemID else FCT_Population.SystemID end as SystemID, coalesce(VIR_Headquarters.Level, 0) as HeadquartersLevel, FCT_Ranks.Priority as RankPriority, FCT_CommanderBonuses.BonusValue, DIM_NavalAdminCommandType.Radius, DIM_NavalAdminCommandType.Industrial as Share from FCT_NavalAdminCommand left join FCT_Population on FCT_Population.PopulationID = FCT_NavalAdminCommand.PopulationID left join (select FCT_PopulationInstallations.PopID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.NavalHeadquartersValue) as Level from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and DIM_PlanetaryInstallation.NavalHeadquartersValue > 0 group by FCT_PopulationInstallations.PopID) as VIR_Headquarters on VIR_Headquarters.PopID = FCT_NavalAdminCommand.PopulationID left join (select FCT_Ship.ShipID, FCT_Fleet.SystemID from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}) as VIR_Flagship on VIR_Flagship.ShipID = FCT_NavalAdminCommand.ShipID left join DIM_NavalAdminCommandType on DIM_NavalAdminCommandType.CommandTypeID = FCT_NavalAdminCommand.AdminCommandTypeID left join FCT_Commander on FCT_Commander.CommandID = FCT_NavalAdminCommand.NavalAdminCommandID and FCT_Commander.CommandType = 12 and FCT_Commander.RaceID = FCT_NavalAdminCommand.RaceID left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6 where FCT_NavalAdminCommand.GameID = ${this.GameID} and FCT_NavalAdminCommand.RaceID = ${this.RaceID}`).then(([items]) => items)

        if (!admins.some((admin) => admin.BonusValue)) {
          return {}
        }

        const captains = await this.database.query(`select FCT_Fleet.ParentCommandID as NavalAdminCommandID, min(FCT_Ranks.Priority) as RankPriority from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_Commander on FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 1 and FCT_Commander.RaceID = FCT_Ship.RaceID inner join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID where FCT_Fleet.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} and FCT_Fleet.ParentCommandID > 0 group by FCT_Fleet.ParentCommandID`).then(([items]) => items)
        const links = await this.database.query(`select FCT_JumpPoint.SystemID, VIR_Destination.SystemID as DestinationID from FCT_JumpPoint inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1 inner join FCT_JumpPoint as VIR_Destination on VIR_Destination.WarpPointID = FCT_JumpPoint.WPLink inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = VIR_Destination.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_JumpPoint.GameID = ${this.GameID}`).then(([items]) => items)
        const graph = {}

        links.forEach((link) => {
          ;(graph[link.SystemID] = graph[link.SystemID] || new Set()).add(link.DestinationID)
          ;(graph[link.DestinationID] = graph[link.DestinationID] || new Set()).add(link.SystemID)
        })

        const byId = Object.fromEntries(admins.map((admin) => [admin.NavalAdminCommandID, admin]))
        const required = navalAdminRequiredRanks(byId, Object.fromEntries(captains.map((captain) => [captain.NavalAdminCommandID, captain.RankPriority])))

        return Object.fromEntries(admins.map((admin) => {
          const radius = navalAdminRadius(admin)

          return [admin.NavalAdminCommandID, {
            ...admin,
            Eligible: admin.RankPriority != null && admin.RankPriority <= required[admin.NavalAdminCommandID],
            Systems: radius === null || admin.SystemID == null ? new Set() : systemsWithinJumps(graph, admin.SystemID, radius),
          }]
        }))
      },
      default: {},
    },
    industrialProjects: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Duranium, FCT_IndustrialProjects.Neutronium, FCT_IndustrialProjects.Corbomite, FCT_IndustrialProjects.Tritanium, FCT_IndustrialProjects.Boronide, FCT_IndustrialProjects.Mercassium, FCT_IndustrialProjects.Vendarite, FCT_IndustrialProjects.Sorium, FCT_IndustrialProjects.Uridium, FCT_IndustrialProjects.Corundium, FCT_IndustrialProjects.Gallicite from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID} and FCT_IndustrialProjects.Pause = 0`).then(([items]) => items)
      },
      default: [],
    },
  },
}
</script>

<style lang="scss">
.mineral-outlook {
  .mineral-select {
    min-width: 220px;
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

  .chart-title {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin-bottom: 8px;
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

  .runway-table td {
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .runway-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 160px;
  }

  .meter {
    flex: 0 0 64px;
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

  .trend {
    display: block;
  }

  .timeline {
    position: relative;
    display: flex;
    align-items: center;
    height: 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.06);
  }

  .timeline-full {
    height: 100%;
    border-radius: 4px 0 0 4px;
  }

  .timeline-decline {
    height: 100%;
    opacity: 0.35;
  }

  .timeline-end {
    width: 2px;
    height: 14px;
  }

  tr.is-focus-row {
    background-image: repeating-linear-gradient(-45deg, rgba(33, 150, 243, 0.12) 0, rgba(33, 150, 243, 0.12) 12px, rgba(33, 150, 243, 0.04) 12px, rgba(33, 150, 243, 0.04) 24px);
  }
}

.theme--dark .mineral-outlook {
  .meter {
    background: rgba(255, 255, 255, 0.12);
  }

  .meter-fill {
    background-color: #b0b0b0;
  }

  .timeline {
    background: rgba(255, 255, 255, 0.1);
  }

  tr.is-focus-row {
    background-image: repeating-linear-gradient(-45deg, rgba(33, 150, 243, 0.22) 0, rgba(33, 150, 243, 0.22) 12px, rgba(33, 150, 243, 0.1) 12px, rgba(33, 150, 243, 0.1) 24px);
  }
}
</style>
