<template>
  <div>
    <v-container v-if="!historyRecorded" fluid class="intelligence-page">
      <v-alert type="info" outlined dense>
        The app doesn't keep intelligence for this race. It's one of Aurora's special factions (such as the Precursors, Invaders or Rakhas). Intelligence is kept for player races and NPR empires.
      </v-alert>
    </v-container>

    <v-container v-else fluid class="intelligence-page">
      <v-alert v-if="failedInputs.length" type="error" outlined dense>
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate />

      <template v-if="ready">
        <v-alert v-if="!rows.length" type="info" outlined dense>
          This race hasn't met another race yet. Alien races appear here once they're detected.
        </v-alert>

        <template v-else>
          <div class="caption text--secondary mb-2">
            Only what this race has observed: tracked ships aren't the alien fleet, and a colony's details show once intelligence on it is high enough. History is recorded each time Aurora saves while the app is open, when something has changed.
          </div>

          <v-row>
            <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
              <v-card class="stat-tile" elevation="1">
                <div class="caption text--secondary">{{ tile.label }}</div>
                <div class="stat-value">{{ tile.value }}</div>
                <div class="caption text--secondary">{{ tile.note }}</div>
              </v-card>
            </v-col>
          </v-row>

          <v-card class="panel" elevation="1">
            <div class="panel-head">
              <span>Known races</span>
            </div>
            <v-data-table :headers="raceHeaders" :items="rows" item-key="AlienRaceID" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 50, -1] }" :item-class="(item) => (item.AlienRaceID === selectedId ? 'selected-row' : '')" @click:row="(item) => select(item.AlienRaceID)">
              <template #[`item.AlienRaceName`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.AlienRaceName }}</div>
                  <div class="caption text--secondary">{{ item.Abbrev }}</div>
                </div>
              </template>
              <template #[`item.ContactStatus`]="{ item }">
                <v-chip small outlined :color="item.status.color"><v-icon small left>{{ item.status.icon }}</v-icon>{{ item.status.label }}</v-chip>
              </template>
              <template #[`item.CommStatus`]="{ item }">
                <span class="caption">{{ item.communication }}</span>
              </template>
              <template #[`item.DiplomaticPoints`]="{ item }">
                <div>{{ count(item.DiplomaticPoints) }}</div>
                <div class="caption text--secondary">{{ item.standing }}</div>
              </template>
              <template #[`item.FirstDetected`]="{ item }">{{ date(item.FirstDetected) }}</template>
              <template #[`item.LastContact`]="{ item }">{{ item.LastContact ? date(item.LastContact) : '—' }}</template>
              <template #[`item.KnownShips`]="{ item }">
                <div>{{ count(item.KnownShips) }}</div>
                <div v-if="item.KnownShips" class="caption text--secondary">{{ tons(item.KnownTons) }}</div>
              </template>
              <template #[`item.DestroyedShips`]="{ item }">{{ count(item.DestroyedShips) }}</template>
            </v-data-table>
          </v-card>

          <template v-if="selected">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>
                  {{ selected.AlienRaceName }}
                  <v-chip small outlined :color="selected.status.color" class="ml-2"><v-icon small left>{{ selected.status.icon }}</v-icon>{{ selected.status.label }}</v-chip>
                  <v-chip small outlined class="ml-1">{{ selected.communication }}</v-chip>
                  <v-chip v-if="selected.FixedRelationship" small outlined class="ml-1">Fixed relationship</v-chip>
                </span>
              </div>
              <div class="panel-body">
                <v-row dense>
                  <v-col v-for="fact in facts" :key="fact.label" cols="12" sm="6" md="4" lg="3">
                    <div class="caption text--secondary">{{ fact.label }}</div>
                    <div>{{ fact.value }}</div>
                  </v-col>
                </v-row>
              </div>
            </v-card>

            <v-row>
              <v-col v-for="chart in charts" :key="chart.key" cols="12" lg="4">
                <v-card class="panel chart-panel" elevation="1">
                  <div class="panel-head">
                    <span>{{ chart.title }}</span>
                    <span class="legend">
                      <span v-for="series in chart.data.datasets" :key="series.label" class="legend-item"><span class="swatch" :style="{ background: series.borderColor }" />{{ series.label }}</span>
                    </span>
                  </div>
                  <div class="panel-body">
                    <div class="caption text--secondary mb-2">{{ chart.note }}</div>
                    <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="240" :label="chart.title" />
                  </div>
                </v-card>
              </v-col>
            </v-row>

            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>Observed</span>
                <v-btn-toggle v-model="detailView" mandatory dense class="flex-wrap">
                  <v-btn value="classes" small>Classes ({{ selectedClasses.length }})</v-btn>
                  <v-btn value="colonies" small>Colonies ({{ selectedPopulations.length }})</v-btn>
                  <v-btn value="sensors" small>Sensors ({{ selectedSensors.length }})</v-btn>
                  <v-btn value="ground" small>Ground units ({{ selectedGroundUnits.length }})</v-btn>
                  <v-btn value="places" small>Systems and species ({{ selectedSystems.length + selectedSpecies.length }})</v-btn>
                </v-btn-toggle>
              </div>

              <template v-if="detailView === 'classes'">
                <v-data-table v-if="selectedClasses.length" :headers="classHeaders" :items="selectedClasses" item-key="AlienClassID" :items-per-page="15" dense>
                  <template #[`item.ClassName`]="{ item }">
                    <div class="py-1">
                      <div class="font-weight-medium">{{ item.ClassName }}</div>
                      <div class="caption text--secondary">
                        {{ engineType(item.EngineType) }} · {{ classRole(item.AlienClassRole) }}<span v-if="item.DiplomaticShip"> · diplomatic</span><span v-if="item.ObservedMissileDefence"> · point defence</span>
                      </div>
                    </div>
                  </template>
                  <template #[`item.TCS`]="{ item }">{{ tons(item.TCS * 50) }}</template>
                  <template #[`item.MaxSpeed`]="{ item }">{{ count(item.MaxSpeed) }}</template>
                  <template #[`item.alive`]="{ item }">{{ item.alive }} / {{ item.ShipCount }}</template>
                  <template #[`item.FirstDetected`]="{ item }">{{ date(item.FirstDetected) }}</template>
                  <template #[`item.Weapons`]="{ item }"><span class="caption">{{ item.Weapons || '—' }}</span></template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No classes observed.</div>
              </template>

              <template v-else-if="detailView === 'colonies'">
                <v-data-table v-if="selectedPopulations.length" :headers="populationHeaders" :items="selectedPopulations" item-key="PopulationID" :items-per-page="15" dense>
                  <template #[`item.PopulationName`]="{ item }">
                    <div class="py-1">
                      <div class="font-weight-medium">{{ item.PopulationName }}</div>
                      <div class="caption text--secondary">Thermal {{ count(item.ThermalSignature) }} · EM {{ count(item.EMSignature) }}</div>
                    </div>
                  </template>
                  <template #[`item.intelligence`]="{ item }">
                    <div>{{ count(item.AlienPopulationIntelligencePoints) }} <span class="caption text--secondary">/ peak {{ count(item.MaxIntelligence) }}</span></div>
                    <div class="caption text--secondary">{{ item.levelText }}</div>
                  </template>
                  <template v-for="field in POPULATION_FIELDS" #[`item.${field.value}`]="{ item }">
                    <v-tooltip v-if="item.fields[field.value].known" :key="field.value" bottom :disabled="item.fields[field.value].current">
                      <template #activator="{ on }">
                        <span :class="{ 'stale-value': !item.fields[field.value].current }" v-on="on">{{ fieldText(field, item.fields[field.value].value) }}</span>
                      </template>
                      <span>Last seen at peak intelligence; current intelligence no longer covers it.</span>
                    </v-tooltip>
                    <span v-else :key="field.value" class="text--disabled">unknown</span>
                  </template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No colonies observed.</div>
              </template>

              <template v-else-if="detailView === 'sensors'">
                <v-data-table v-if="selectedSensors.length" :headers="sensorHeaders" :items="selectedSensors" item-key="AlienSensorID" :items-per-page="15" dense>
                  <template #[`item.Range`]="{ item }">
                    <span v-if="item.IntelligencePoints > 100">{{ count(item.Range / 1e6, 1) }} M km, resolution {{ count(item.Resolution) }}</span>
                    <span v-else class="text--disabled">unknown until 100 points</span>
                  </template>
                  <template #[`item.IntelligencePoints`]="{ item }">{{ count(item.IntelligencePoints) }}</template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No sensors observed.</div>
              </template>

              <template v-else-if="detailView === 'ground'">
                <v-data-table v-if="selectedGroundUnits.length" :headers="groundHeaders" :items="selectedGroundUnits" item-key="AlienGroundUnitClassID" :items-per-page="15" dense>
                  <template v-for="counter in GROUND_COUNTERS" #[`item.${counter.value}`]="{ item }">
                    <span :key="counter.value" :class="{ 'text--disabled': item[counter.value] < GROUND_THRESHOLD }">{{ count(item[counter.value]) }}<span v-if="item[counter.value] < GROUND_THRESHOLD"> / {{ GROUND_THRESHOLD }}</span></span>
                  </template>
                  <template #[`item.WeaponsKnown`]="{ item }">{{ item.WeaponsKnown ? 'Known' : 'Unknown' }}</template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No ground units observed.</div>
              </template>

              <div v-else class="panel-body">
                <div class="caption text--secondary mb-1">Systems where they've been seen</div>
                <div class="mb-3">
                  <v-chip v-for="system in selectedSystems" :key="system.SystemID" small outlined class="mr-1 mb-1">{{ system.Name || `System ${system.SystemID}` }}</v-chip>
                  <span v-if="!selectedSystems.length" class="caption text--secondary">None.</span>
                </div>
                <div class="caption text--secondary mb-1">Species</div>
                <div>
                  <v-chip v-for="species in selectedSpecies" :key="species.SpeciesID" small outlined class="mr-1 mb-1">{{ species.SpeciesName }} · {{ speciesStatus(species.Status) }}</v-chip>
                  <span v-if="!selectedSpecies.length" class="caption text--secondary">None identified.</span>
                </div>
              </div>
            </v-card>
          </template>
        </template>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import { gameTime } from '../utilities/aurora'
import { historyConfig } from '../utilities/history'
import { ATTEMPTING_COMMUNICATION, CLASS_ROLES, COMM_STATUS, DIPLOMACY_LINES, ENGINE_TYPES, POPULATION_LEVELS, REWARD_COST, SPECIES_STATUS, alienRacesSql, contactStatus, intelSnapshot, populationField, populationLevel, rebuildFleet, rewardAttempts, standing, treatyNames } from '../utilities/intelligence'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'

const SECONDS_PER_YEAR = 31536000

const INPUT_LABELS = {
  races: 'the known races',
  ships: 'the tracked ships',
  classes: 'the observed classes',
  populations: 'the observed colonies',
  sensors: 'the observed sensors',
  groundUnits: 'the observed ground units',
  systems: 'the systems they were seen in',
  species: 'the known species',
}
const INPUTS = Object.keys(INPUT_LABELS)

// Colony columns, each shown once intelligence has unlocked it.
const POPULATION_FIELDS = [
  { text: 'Population', value: 'PopulationAmount', kind: 'millions' },
  { text: 'Installations', value: 'Installations' },
  { text: 'Factories', value: 'Factories' },
  { text: 'Mines', value: 'Mines' },
  { text: 'Refineries', value: 'Refineries' },
  { text: 'Maintenance', value: 'MaintenanceFacilities' },
  { text: 'Research labs', value: 'ResearchFacilities' },
  { text: 'Ground training', value: 'GFTF' },
  { text: 'Spaceport', value: 'Spaceport', kind: 'flag' },
  { text: 'Naval HQ', value: 'NavalHeadquarters', kind: 'flag' },
]

// A ground unit class's three observation counters, each revealing something at 20.
const GROUND_THRESHOLD = 20
const GROUND_COUNTERS = [
  { text: 'Hits seen (type)', value: 'Hits' },
  { text: 'Penetrations seen (armour)', value: 'Penetrated' },
  { text: 'Kills seen (hit points)', value: 'Destroyed' },
]

const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 2)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 1)}`
}

export default {
  name: 'IntelligencePage',
  components: { ChartCanvas },
  data() {
    return {
      selectedId: null,
      detailView: 'classes',
      loadErrors: {},
      POPULATION_FIELDS,
      GROUND_COUNTERS,
      GROUND_THRESHOLD,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'historyRecorded']),

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

    rows() {
      return this.races.map((race) => ({
        ...race,
        status: contactStatus(race.ContactStatus),
        communication: COMM_STATUS[race.CommStatus] || `Status ${race.CommStatus}`,
        standing: standing(race.DiplomaticPoints),
      }))
    },

    selected() {
      return this.rows.find((row) => row.AlienRaceID === this.selectedId) || null
    },

    // What the recorder has kept for this race's view of the selected alien race, re-read when it writes.
    recorded() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision

      if (!this.GameID || !this.RaceID || !this.selectedId || !this.historyRecorded) {
        return []
      }

      const record = historyConfig(this.GameID).get(`intel.${this.RaceID}.${this.selectedId}`, null)

      return record && Array.isArray(record.snapshots) ? record.snapshots : []
    },

    // The recorded snapshots, ending with the save as it is now.
    timeline() {
      if (!this.selected) {
        return []
      }

      const now = intelSnapshot(this.selected)
      const past = this.recorded.filter((snapshot) => snapshot.t < now.t)

      return [...past, now]
    },

    tiles() {
      const byStatus = {}

      this.rows.forEach((row) => {
        byStatus[row.status.label] = (byStatus[row.status.label] || 0) + 1
      })

      const alive = this.rows.reduce((sum, row) => sum + (row.KnownShips || 0), 0)
      const tons = this.rows.reduce((sum, row) => sum + (row.KnownTons || 0), 0)
      const lost = this.rows.reduce((sum, row) => sum + (row.DestroyedShips || 0), 0)
      const colonies = this.populations.length
      const sized = this.populations.filter((population) => population.MaxIntelligence > 100).length

      return [
        { label: 'Known races', value: this.count(this.rows.length), note: Object.entries(byStatus).map(([label, number]) => `${number} ${label.toLowerCase()}`).join(', ') },
        { label: 'Ships tracked', value: this.count(alive), note: `${this.tons(tons)} still in service, of ${this.count(alive + lost)} ever tracked` },
        { label: 'Ships destroyed', value: this.count(lost), note: lost ? `${this.count(this.classes.length)} classes observed` : 'None known' },
        { label: 'Colonies observed', value: this.count(colonies), note: colonies ? `${sized} with their population known` : 'None known' },
      ]
    },

    facts() {
      const race = this.selected
      const granted = treatyNames(intelSnapshot(race).granted)
      const received = treatyNames(intelSnapshot(race).received)
      const facts = [
        { label: 'First contact', value: this.date(race.FirstDetected) },
        { label: 'Last ship contact', value: race.LastContact ? this.date(race.LastContact) : 'None' },
        { label: 'Diplomatic points', value: `${this.count(race.DiplomaticPoints)} (${race.standing.toLowerCase()})` },
        { label: 'Communication', value: race.CommEstablished > 0 ? `${race.communication} on ${this.date(race.CommEstablished)}` : race.communication },
        { label: 'You grant', value: granted.length ? granted.join(', ') : 'No treaties' },
        { label: 'They grant', value: received.length ? received.join(', ') : 'No treaties' },
        { label: 'Race intelligence', value: `${this.count(race.AlienRaceIntelligencePoints, 1)} points; a discovery each time it passes ${REWARD_COST}` },
        { label: 'Damage they have done to you', value: this.count(race.DamageCausedByAlienRace) },
      ]

      if (race.CommStatus === ATTEMPTING_COMMUNICATION) {
        facts.splice(4, 0, { label: 'Translation progress', value: this.count(race.CommModifier, 1) })
      }

      return facts
    },

    charts() {
      const palette = this.theme.categorical
      const line = (label, points, index, extra = {}) => ({
        label,
        data: points,
        borderColor: palette[index % palette.length],
        backgroundColor: withAlpha(palette[index % palette.length], 0.1),
        borderWidth: 2,
        pointRadius: points.length > 40 ? 0 : 3,
        pointHoverRadius: 4,
        tension: 0,
        stepped: true,
        ...extra,
      })
      const timeline = this.timeline
      const at = (key) => timeline.map((snapshot) => ({ x: this.year(snapshot.t), y: snapshot[key] || 0 }))
      const recordedNote = timeline.length > 1 ? `Recorded since ${this.date(timeline[0].t)}.` : 'Recording starts now: points are added when it changes.'
      const fleet = rebuildFleet(this.selectedShips, this.selected.Now)
      const translating = timeline.some((snapshot) => snapshot.comm === ATTEMPTING_COMMUNICATION)
      const intelDatasets = [line('Race intelligence', at('intel'), 0)]
      // Diplomacy's axis reaches the nearest treaty or status line on each side, so where the race
      // stands relative to them shows even with one point.
      const points = timeline.map((snapshot) => snapshot.points)
      const lineAbove = DIPLOMACY_LINES.find((entry) => entry.y >= Math.max(...points))
      const lineBelow = DIPLOMACY_LINES.slice().reverse().find((entry) => entry.y <= Math.min(...points))

      if (translating) {
        intelDatasets.push(line('Translation progress', at('translation'), 1, { yAxisID: 'y1' }))
      }

      return [
        {
          key: 'diplomacy',
          title: 'Diplomatic points',
          note: `${recordedNote} Dashed lines are where treaties and statuses change.`,
          data: { datasets: [line('Diplomatic points', at('points'), 0)] },
          options: this.options({ y: (value) => this.count(value) }, { levels: DIPLOMACY_LINES }, { suggestedMax: lineAbove ? lineAbove.y : undefined, suggestedMin: lineBelow ? lineBelow.y : undefined }),
        },
        {
          key: 'fleet',
          title: 'Ships tracked',
          note: fleet.length ? 'Rebuilt from when each ship was first seen and last hit or seen, back to first contact.' : 'No ships tracked.',
          data: {
            datasets: [
              line('In service', fleet.map((point) => ({ x: this.year(point.t), y: point.alive })), 0),
              line('Destroyed', fleet.map((point) => ({ x: this.year(point.t), y: point.lost })), 1),
              line('Tonnage', fleet.map((point) => ({ x: this.year(point.t), y: point.tons })), 2, { yAxisID: 'y1', borderDash: [6, 4] }),
            ],
          },
          options: this.options({ y: (value) => this.count(value), y1: (value) => this.tons(value) }, {}, { beginAtZero: true, ticks: { precision: 0 } }),
        },
        {
          key: 'intelligence',
          title: translating ? 'Intelligence and translation' : 'Race intelligence',
          note: `${recordedNote} Marks show where points were spent on a discovery.`,
          data: { datasets: intelDatasets },
          options: this.options({ y: (value) => this.count(value), y1: translating ? (value) => this.count(value) : null }, { markers: rewardAttempts(timeline).map((t) => ({ x: this.year(t), label: 'Discovery' })) }, { min: 0, suggestedMax: REWARD_COST, ticks: { precision: 0 } }),
        },
      ]
    },

    selectedShips() {
      return this.ships.filter((ship) => ship.AlienRaceID === this.selectedId)
    },

    selectedClasses() {
      const alive = {}

      this.selectedShips.forEach((ship) => {
        if (!ship.Destroyed) {
          alive[ship.AlienClassID] = (alive[ship.AlienClassID] || 0) + 1
        }
      })

      return this.classes.filter((shipClass) => shipClass.AlienRaceID === this.selectedId).map((shipClass) => ({ ...shipClass, alive: alive[shipClass.AlienClassID] || 0 }))
    },

    selectedPopulations() {
      return this.populations.filter((population) => population.AlienRaceID === this.selectedId).map((population) => {
        const level = populationLevel(population)

        return {
          ...population,
          intelligence: population.AlienPopulationIntelligencePoints,
          levelText: level ? `Known: ${POPULATION_LEVELS.slice(0, level).map((entry) => entry.label.toLowerCase()).join('; ')}` : 'Only its signatures are known',
          fields: Object.fromEntries(POPULATION_FIELDS.map((field) => [field.value, populationField(population, field.value)])),
        }
      })
    },

    selectedSensors() {
      return this.sensors.filter((sensor) => sensor.AlienRaceID === this.selectedId).sort((a, b) => (a.Name || '').localeCompare(b.Name || '', undefined, { numeric: true }))
    },

    selectedGroundUnits() {
      return this.groundUnits.filter((unit) => unit.AlienRaceID === this.selectedId)
    },

    selectedSystems() {
      return this.systems.filter((system) => system.AlienRaceID === this.selectedId).sort((a, b) => (a.Name || '').localeCompare(b.Name || ''))
    },

    selectedSpecies() {
      return this.species.filter((entry) => entry.AlienRaceID === this.selectedId)
    },

    raceHeaders() {
      return [
        { text: 'Race', value: 'AlienRaceName' },
        { text: 'Stance', value: 'ContactStatus' },
        { text: 'Communication', value: 'CommStatus' },
        { text: 'Diplomatic points', value: 'DiplomaticPoints', align: 'end' },
        { text: 'First contact', value: 'FirstDetected', cellClass: 'text-no-wrap' },
        { text: 'Last ship contact', value: 'LastContact', cellClass: 'text-no-wrap' },
        { text: 'Ships tracked', value: 'KnownShips', align: 'end' },
        { text: 'Destroyed', value: 'DestroyedShips', align: 'end' },
        { text: 'Colonies', value: 'KnownPopulations', align: 'end' },
        { text: 'Systems', value: 'KnownSystems', align: 'end' },
      ]
    },

    classHeaders() {
      return [
        { text: 'Class', value: 'ClassName' },
        { text: 'Size', value: 'TCS', align: 'end' },
        { text: 'Top speed (km/s)', value: 'MaxSpeed', align: 'end' },
        { text: 'Armour', value: 'ArmourStrength', align: 'end' },
        { text: 'Shields', value: 'ShieldStrength', align: 'end' },
        { text: 'In service / tracked', value: 'alive', align: 'end' },
        { text: 'First seen', value: 'FirstDetected', cellClass: 'text-no-wrap' },
        { text: 'Weapons seen', value: 'Weapons', sortable: false },
      ]
    },

    populationHeaders() {
      return [
        { text: 'Colony', value: 'PopulationName' },
        { text: 'Intelligence', value: 'intelligence' },
        ...POPULATION_FIELDS.map((field) => ({ text: field.text, value: field.value, align: field.kind === 'flag' ? 'center' : 'end', sortable: false })),
      ]
    },

    sensorHeaders() {
      return [
        { text: 'Sensor', value: 'Name' },
        { text: 'Strength', value: 'Strength', align: 'end' },
        { text: 'Range', value: 'Range' },
        { text: 'Intelligence points', value: 'IntelligencePoints', align: 'end' },
      ]
    },

    groundHeaders() {
      return [
        { text: 'Unit class', value: 'Name' },
        ...GROUND_COUNTERS.map((counter) => ({ ...counter, align: 'end' })),
        { text: 'Weapons', value: 'WeaponsKnown' },
      ]
    },
  },
  watch: {
    rows() {
      if (!this.selected && this.rows.length) {
        const saved = this.config.get(`game.${this.GameID}.race.${this.RaceID}.intelligenceAlien`, null)
        const fallback = this.rows.slice().sort((a, b) => (b.KnownShips + b.DestroyedShips) - (a.KnownShips + a.DestroyedShips))[0]

        this.selectedId = this.rows.some((row) => row.AlienRaceID === saved) ? saved : fallback.AlienRaceID
      }
    },
    RaceID() {
      this.selectedId = null
    },
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },
    select(AlienRaceID) {
      this.selectedId = AlienRaceID
      this.config.set(`game.${this.GameID}.race.${this.RaceID}.intelligenceAlien`, AlienRaceID)
    },
    count(value, decimals = 0) {
      return separatedNumber(roundToDecimal(value || 0, decimals), this.separator)
    },
    tons(value) {
      return `${compact(value || 0)} t`
    },
    year(seconds) {
      return (this.StartYear || 0) + seconds / SECONDS_PER_YEAR
    },
    date(seconds) {
      return gameTime(this.StartYear, seconds).format('YYYY-MM-DD')
    },
    engineType(code) {
      return ENGINE_TYPES[code] || 'Unknown'
    },
    classRole(code) {
      return CLASS_ROLES[code] || 'Unknown'
    },
    speciesStatus(code) {
      return SPECIES_STATUS[code] || 'Discovered'
    },
    fieldText(field, value) {
      if (field.kind === 'flag') {
        return value ? 'Yes' : 'No'
      }

      return field.kind === 'millions' ? `${this.count(value, 1)} M` : this.count(value)
    },
    // Line-chart options over game years; `y` adds settings to the left axis.
    options(axes, guides = {}, y = {}) {
      const scales = {
        // As many decimals as the tick spacing needs, so short spans don't repeat a year.
        x: { type: 'linear', title: { display: true, text: 'Year' }, ticks: { callback: (value, _index, ticks) => `${roundToDecimal(value, ticks.length > 1 && Math.abs(ticks[1].value - ticks[0].value) < 0.1 ? 2 : 1)}` } },
        y: { ...y, ticks: { ...(y.ticks || {}), callback: axes.y } },
      }

      if (axes.y1) {
        scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: axes.y1 } }
      }

      return {
        scales,
        plugins: {
          guides,
          tooltip: {
            callbacks: {
              title: (items) => this.date((items[0].parsed.x - (this.StartYear || 0)) * SECONDS_PER_YEAR),
              label: (item) => `${item.dataset.label}: ${item.dataset.yAxisID === 'y1' && axes.y1 ? axes.y1(item.parsed.y) : axes.y(item.parsed.y)}`,
            },
          },
        },
      }
    },
  },
  asyncComputed: {
    races: {
      get: tracked('races', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(alienRacesSql(this.GameID, this.RaceID)).then(([items]) => items)
      }),
      default: [],
    },
    // Every tracked alien ship with its class's observed size, for the rebuilt fleet and per-class counts.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienShip.AlienRaceID, FCT_AlienShip.AlienClassID, FCT_AlienShip.FirstDetected, FCT_AlienShip.Destroyed, FCT_AlienShip.GameTimeDamaged, FCT_AlienShip.LastContactTime, FCT_AlienClass.TCS * 50 as Tons from FCT_AlienShip inner join FCT_AlienClass on FCT_AlienClass.AlienClassID = FCT_AlienShip.AlienClassID where FCT_AlienShip.GameID = ${this.GameID} and FCT_AlienShip.ViewRaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    // Observed classes: largest size and speed seen, engine and armament role, and the weapons seen firing.
    classes: {
      get: tracked('classes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienClass.AlienClassID, FCT_AlienClass.AlienRaceID, FCT_AlienClass.ClassName, FCT_AlienClass.TCS, FCT_AlienClass.MaxSpeed, FCT_AlienClass.EngineType, FCT_AlienClass.AlienClassRole, FCT_AlienClass.ArmourStrength, FCT_AlienClass.ShieldStrength, FCT_AlienClass.ShipCount, FCT_AlienClass.FirstDetected, FCT_AlienClass.DiplomaticShip, FCT_AlienClass.ObservedMissileDefence, (select group_concat(FCT_ShipDesignComponents.Name || ' ×' || FCT_AlienClassWeapon.Amount, ', ') from FCT_AlienClassWeapon inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_AlienClassWeapon.WeaponID where FCT_AlienClassWeapon.AlienClassID = FCT_AlienClass.AlienClassID) as Weapons from FCT_AlienClass where FCT_AlienClass.GameID = ${this.GameID} and FCT_AlienClass.ViewRaceID = ${this.RaceID} order by FCT_AlienClass.FirstDetected`).then(([items]) => items)
      }),
      default: [],
    },
    populations: {
      get: tracked('populations', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienPopulation.AlienRaceID, FCT_AlienPopulation.PopulationID, FCT_AlienPopulation.PopulationName, FCT_AlienPopulation.AlienPopulationIntelligencePoints, FCT_AlienPopulation.MaxIntelligence, FCT_AlienPopulation.PopulationAmount, FCT_AlienPopulation.Installations, FCT_AlienPopulation.Mines, FCT_AlienPopulation.Factories, FCT_AlienPopulation.Refineries, FCT_AlienPopulation.MaintenanceFacilities, FCT_AlienPopulation.ResearchFacilities, FCT_AlienPopulation.GFTF, FCT_AlienPopulation.Spaceport, FCT_AlienPopulation.CargoStation, FCT_AlienPopulation.RefuellingStation, FCT_AlienPopulation.OrdnanceTransfer, FCT_AlienPopulation.NavalHeadquarters, FCT_AlienPopulation.SectorCommand, FCT_AlienPopulation.ThermalSignature, FCT_AlienPopulation.EMSignature from FCT_AlienPopulation where FCT_AlienPopulation.GameID = ${this.GameID} and FCT_AlienPopulation.ViewingRaceID = ${this.RaceID} order by FCT_AlienPopulation.PopulationName`).then(([items]) => items)
      }),
      default: [],
    },
    sensors: {
      get: tracked('sensors', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienRaceSensor.AlienSensorID, FCT_AlienRaceSensor.AlienRaceID, FCT_AlienRaceSensor.Name, FCT_AlienRaceSensor.Strength, FCT_AlienRaceSensor.Resolution, FCT_AlienRaceSensor.Range, FCT_AlienRaceSensor.IntelligencePoints from FCT_AlienRaceSensor where FCT_AlienRaceSensor.GameID = ${this.GameID} and FCT_AlienRaceSensor.ViewingRaceID = ${this.RaceID} order by FCT_AlienRaceSensor.Name`).then(([items]) => items)
      }),
      default: [],
    },
    groundUnits: {
      get: tracked('groundUnits', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienGroundUnitClass.AlienGroundUnitClassID, FCT_AlienGroundUnitClass.AlienRaceID, FCT_AlienGroundUnitClass.Name, FCT_AlienGroundUnitClass.Hits, FCT_AlienGroundUnitClass.Penetrated, FCT_AlienGroundUnitClass.Destroyed, FCT_AlienGroundUnitClass.WeaponsKnown from FCT_AlienGroundUnitClass where FCT_AlienGroundUnitClass.GameID = ${this.GameID} and FCT_AlienGroundUnitClass.ViewRaceID = ${this.RaceID} order by FCT_AlienGroundUnitClass.Name`).then(([items]) => items)
      }),
      default: [],
    },
    // Systems where each race has been seen, by this race's name for them.
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienSystem.AlienRaceID, FCT_AlienSystem.SystemID, FCT_RaceSysSurvey.Name from FCT_AlienSystem left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_AlienSystem.SystemID and FCT_RaceSysSurvey.RaceID = FCT_AlienSystem.DetectRaceID and FCT_RaceSysSurvey.GameID = FCT_AlienSystem.GameID where FCT_AlienSystem.GameID = ${this.GameID} and FCT_AlienSystem.DetectRaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    species: {
      get: tracked('species', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienRaceSpecies.AlienRaceID, FCT_AlienRaceSpecies.SpeciesID, FCT_Species.SpeciesName, coalesce(FCT_KnownSpecies.Status, 0) as Status from FCT_AlienRaceSpecies inner join FCT_Species on FCT_Species.SpeciesID = FCT_AlienRaceSpecies.SpeciesID left join FCT_KnownSpecies on FCT_KnownSpecies.SpeciesID = FCT_AlienRaceSpecies.SpeciesID and FCT_KnownSpecies.ViewRaceID = FCT_AlienRaceSpecies.DetectRaceID and FCT_KnownSpecies.GameID = FCT_AlienRaceSpecies.GameID where FCT_AlienRaceSpecies.GameID = ${this.GameID} and FCT_AlienRaceSpecies.DetectRaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.intelligence-page {
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

  .chart-panel {
    height: calc(100% - 20px);
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

  .selected-row {
    background: rgba(24, 103, 192, 0.08);
  }

  .stale-value {
    font-style: italic;
    opacity: 0.7;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  td.text-end {
    white-space: nowrap;
  }

  tbody tr {
    cursor: pointer;
  }
}
</style>
