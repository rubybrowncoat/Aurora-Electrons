<template>
  <div>
    <v-container v-if="!historyRecorded" fluid class="intelligence-page">
      <v-alert type="info" outlined dense>
        The app doesn't keep intelligence for this race. It's one of Aurora's special factions (such as the Precursors, Invaders or Rakhas). Intelligence is kept for player races and NPR empires.
      </v-alert>
    </v-container>

    <v-container v-else fluid class="intelligence-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <v-alert v-if="!rows.length" type="info" outlined dense>
          This race hasn't met another race yet. Alien races appear here once they're detected.
        </v-alert>

        <template v-else>
          <div class="caption text--secondary mb-2">
            Only what this race has observed: tracked ships aren't the alien fleet, and a colony's details show once intelligence on it is high enough. History is recorded each time Aurora saves while the app is open, when something has changed.
          </div>

          <stat-tiles :tiles="tiles" />

          <v-card class="panel" data-summary="Every alien race met, with its status, communication and diplomatic standing. Select one to study it in detail." elevation="1">
            <div class="panel-head">
              <span>Known races<provenance-mark v-for="rule in RACE_RULES" :key="rule" :rule="rule" /></span>
            </div>
            <v-data-table :headers="raceHeaders" :items="rows" item-key="AlienRaceID" :custom-sort="sortNullLast" :sort-by.sync="racesTable.sortBy" :sort-desc.sync="racesTable.sortDesc" :items-per-page.sync="racesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: racePageSizes }" :item-class="(item) => (item.AlienRaceID === selectedId ? 'selected-row' : '')" @click:row="(item) => select(item.AlienRaceID)">
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
                <div>{{ count(item.DiplomaticPoints) }}<provenance-mark :result="item.standingResult" /></div>
                <div class="caption text--secondary">{{ item.standingText }}</div>
              </template>
              <template #[`item.FirstDetected`]="{ item }">{{ dateText(item.firstContact) }}<provenance-mark :result="unknown(item.firstContact)" /></template>
              <template #[`item.LastContact`]="{ item }">{{ item.lastContact ? dateText(item.lastContact) : '—' }}<provenance-mark :result="unknown(item.lastContact)" /></template>
              <template #[`item.KnownShips`]="{ item }">
                <div>{{ count(item.KnownShips) }}<provenance-mark :result="unknown(item.aliveResult)" /></div>
                <div v-if="item.KnownShips" class="caption text--secondary">{{ tons(item.KnownTons) }}<provenance-mark :result="unknown(item.tonsResult)" /></div>
              </template>
              <template #[`item.DestroyedShips`]="{ item }">{{ count(item.DestroyedShips) }}<provenance-mark :result="unknown(item.lostResult)" /></template>
            </v-data-table>
          </v-card>

          <template v-if="selected">
            <v-card class="panel" data-summary="The selected race's status, and what has been learned about it so far." elevation="1">
              <div class="panel-head">
                <span>
                  {{ selected.AlienRaceName }}
                  <v-chip small outlined :color="selected.status.color" class="ml-2"><v-icon small left>{{ selected.status.icon }}</v-icon>{{ selected.status.label }}</v-chip>
                  <v-chip small outlined class="ml-1">{{ selected.communication }}</v-chip>
                  <v-chip v-if="selected.FixedRelationship" small outlined class="ml-1">Fixed relationship</v-chip>
                  <provenance-mark v-for="rule in FACT_RULES" :key="rule" :rule="rule" />
                </span>
              </div>
              <div class="panel-body">
                <v-row dense>
                  <v-col v-for="fact in facts" :key="fact.label" cols="12" sm="6" md="4" lg="3">
                    <div class="caption text--secondary">{{ fact.label }}</div>
                    <div>{{ fact.value }}<provenance-mark v-for="(result, index) in fact.results" :key="index" :result="result" /></div>
                  </v-col>
                </v-row>
              </div>
            </v-card>

            <v-row>
              <v-col v-for="chart in charts" :key="chart.key" cols="12" lg="4">
                <v-card class="panel chart-panel" :data-summary="chart.summary" elevation="1">
                  <div class="panel-head">
                    <span>{{ chart.title }}<provenance-mark v-for="(result, index) in chart.results" :key="index" :result="result" /></span>
                    <span class="legend">
                      <span v-for="series in chart.data.datasets" :key="series.label" class="legend-item"><series-key :color="series.borderColor" :dash="series.borderDash" kind="line" />{{ series.label }}</span>
                    </span>
                  </div>
                  <div class="panel-body">
                    <div class="caption text--secondary mb-2">{{ chart.note }}</div>
                    <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="240" :label="chart.title" />
                  </div>
                </v-card>
              </v-col>
            </v-row>

            <v-card class="panel" data-summary="The ship classes, colonies, sensors, ground units, systems and species observed for the selected race. Switch views to see each kind." elevation="1">
              <div class="panel-head">
                <span>Observed<provenance-mark v-for="rule in DETAIL_RULES[detailView]" :key="rule" :rule="rule" /></span>
                <v-btn-toggle v-model="detailView" mandatory dense class="flex-wrap">
                  <v-btn value="classes" small>Classes ({{ selectedClasses.length }})</v-btn>
                  <v-btn value="colonies" small>Colonies ({{ selectedPopulations.length }})</v-btn>
                  <v-btn value="sensors" small>Sensors ({{ selectedSensors.length }})</v-btn>
                  <v-btn value="ground" small>Ground units ({{ selectedGroundUnits.length }})</v-btn>
                  <v-btn value="places" small>Systems and species ({{ selectedSystems.length + selectedSpecies.length }})</v-btn>
                </v-btn-toggle>
              </div>

              <template v-if="detailView === 'classes'">
                <v-data-table v-if="selectedClasses.length" :headers="classHeaders" :items="selectedClasses" item-key="AlienClassID" :custom-sort="sortNullLast" :sort-by.sync="classesTable.sortBy" :sort-desc.sync="classesTable.sortDesc" :items-per-page.sync="classesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: detailPageSizes }" dense>
                  <template #[`item.ClassName`]="{ item }">
                    <div class="py-1">
                      <div class="font-weight-medium">{{ item.ClassName }}</div>
                      <div class="caption text--secondary">
                        {{ engineType(item.EngineType) }} · {{ classRole(item.AlienClassRole) }}<span v-if="item.DiplomaticShip"> · diplomatic</span><span v-if="item.ObservedMissileDefence"> · point defence</span>
                      </div>
                    </div>
                  </template>
                  <template #[`item.TCS`]="{ item }">{{ tons(item.tons) }}<provenance-mark :result="unknown(item.sizeResult)" /></template>
                  <template #[`item.MaxSpeed`]="{ item }">{{ count(item.MaxSpeed) }}<provenance-mark :result="gap(item.MaxSpeed, 'the top speed')" /></template>
                  <template #[`item.ArmourStrength`]="{ item }">{{ count(item.ArmourStrength) }}<provenance-mark :result="gap(item.ArmourStrength, 'the armour strength')" /></template>
                  <template #[`item.ShieldStrength`]="{ item }">{{ count(item.ShieldStrength) }}<provenance-mark :result="gap(item.ShieldStrength, 'the shield strength')" /></template>
                  <template #[`item.alive`]="{ item }">{{ count(item.alive) }} / {{ count(item.ShipCount) }}<provenance-mark :result="unknown(item.aliveResult)" /><provenance-mark :result="gap(item.ShipCount, 'the ships seen')" /></template>
                  <template #[`item.FirstDetected`]="{ item }">{{ date(item.FirstDetected) }}<provenance-mark :result="dateGap(item.FirstDetected)" /></template>
                  <template #[`item.Weapons`]="{ item }"><span class="caption">{{ item.Weapons || '—' }}</span></template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No classes observed.</div>
              </template>

              <template v-else-if="detailView === 'colonies'">
                <v-data-table v-if="selectedPopulations.length" :headers="populationHeaders" :items="selectedPopulations" item-key="PopulationID" :custom-sort="sortNullLast" :sort-by.sync="populationsTable.sortBy" :sort-desc.sync="populationsTable.sortDesc" :items-per-page.sync="populationsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: detailPageSizes }" dense>
                  <template #[`item.PopulationName`]="{ item }">
                    <div class="py-1">
                      <div class="font-weight-medium">{{ item.PopulationName }}</div>
                      <div class="caption text--secondary">Thermal {{ count(item.ThermalSignature) }}<provenance-mark :result="gap(item.ThermalSignature, 'the thermal signature')" /> · EM {{ count(item.EMSignature) }}<provenance-mark :result="gap(item.EMSignature, 'the EM signature')" /></div>
                    </div>
                  </template>
                  <template #[`item.intelligence`]="{ item }">
                    <div>{{ count(item.AlienPopulationIntelligencePoints) }}<provenance-mark :result="gap(item.AlienPopulationIntelligencePoints, 'the intelligence points')" /> <span class="caption text--secondary">/ peak {{ count(item.MaxIntelligence) }}</span><provenance-mark :result="gap(item.MaxIntelligence, 'the peak intelligence')" /></div>
                    <div class="caption text--secondary">{{ item.levelText }}<provenance-mark :result="flagged(item.levelResult)" /></div>
                  </template>
                  <template v-for="field in POPULATION_FIELDS" #[`item.${field.value}`]="{ item }">
                    <span v-if="!available(item.fields[field.value].result)" :key="field.value">—<provenance-mark :result="item.fields[field.value].result" /></span>
                    <span v-else-if="item.fields[field.value].known" :key="field.value">
                      <v-tooltip bottom :disabled="item.fields[field.value].current === true">
                        <template #activator="{ on }">
                          <span :class="{ 'stale-value': item.fields[field.value].current !== true }" v-on="on">{{ fieldText(field, item.fields[field.value].value) }}</span>
                        </template>
                        <span>{{ item.fields[field.value].current === null ? 'Current intelligence is not saved; this is the last value seen.' : 'Last seen at peak intelligence; current intelligence no longer covers it.' }}</span>
                      </v-tooltip><provenance-mark :result="flagged(item.fields[field.value].result)" />
                    </span>
                    <span v-else :key="field.value"><span class="text--disabled">unknown</span><provenance-mark :result="flagged(item.fields[field.value].result)" /></span>
                  </template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No colonies observed.</div>
              </template>

              <template v-else-if="detailView === 'sensors'">
                <v-data-table v-if="selectedSensors.length" :headers="sensorHeaders" :items="selectedSensors" item-key="AlienSensorID" :custom-sort="sortNullLast" :sort-by.sync="sensorsTable.sortBy" :sort-desc.sync="sensorsTable.sortDesc" :items-per-page.sync="sensorsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: detailPageSizes }" dense>
                  <template #[`item.Strength`]="{ item }">{{ count(item.Strength) }}<provenance-mark :result="gap(item.Strength, 'the strength')" /></template>
                  <template #[`item.Range`]="{ item }">
                    <span v-if="!available(item.reveal)">—<provenance-mark :result="item.reveal" /></span>
                    <span v-else-if="item.reveal.value">{{ rangeText(item) }}<provenance-mark :result="flagged(item.reveal)" /><provenance-mark :result="gap(item.Range, 'the range')" /><provenance-mark :result="gap(item.Resolution, 'the resolution')" /></span>
                    <span v-else><span class="text--disabled">unknown until {{ SENSOR_THRESHOLD }} points</span><provenance-mark :result="flagged(item.reveal)" /></span>
                  </template>
                  <template #[`item.IntelligencePoints`]="{ item }">{{ count(item.IntelligencePoints) }}<provenance-mark :result="gap(item.IntelligencePoints, 'the intelligence points')" /></template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No sensors observed.</div>
              </template>

              <template v-else-if="detailView === 'ground'">
                <v-data-table v-if="selectedGroundUnits.length" :headers="groundHeaders" :items="selectedGroundUnits" item-key="AlienGroundUnitClassID" :custom-sort="sortNullLast" :sort-by.sync="groundTable.sortBy" :sort-desc.sync="groundTable.sortDesc" :items-per-page.sync="groundTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: detailPageSizes }" dense>
                  <template v-for="counter in GROUND_COUNTERS" #[`item.${counter.value}`]="{ item }">
                    <span v-if="!available(item.reveals[counter.value])" :key="counter.value">—<provenance-mark :result="item.reveals[counter.value]" /></span>
                    <span v-else :key="counter.value"><span :class="{ 'text--disabled': !item.reveals[counter.value].value }">{{ count(item[counter.value]) }}<span v-if="!item.reveals[counter.value].value"> / {{ GROUND_THRESHOLD }}</span></span><provenance-mark :result="flagged(item.reveals[counter.value])" /></span>
                  </template>
                  <template #[`item.WeaponsKnown`]="{ item }">{{ item.WeaponsKnown ? 'Known' : 'Unknown' }}</template>
                </v-data-table>
                <div v-else class="panel-body caption text--secondary">No ground units observed.</div>
              </template>

              <div v-else class="panel-body">
                <div class="caption text--secondary mb-1">Systems where they've been seen</div>
                <div class="mb-3">
                  <v-chip v-for="system in selectedSystems" :key="system.SystemID" small outlined class="mr-1 mb-1" :to="linkTo.map(system.SystemID)">{{ system.Name || `System ${system.SystemID}` }}</v-chip>
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
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance, toneColor } from '../utilities/appearance'
import { gameTime } from '../utilities/aurora'
import { linkTo, queryId } from '../utilities/deep-links'
import { historyConfig } from '../utilities/history'
import { ATTEMPTING_COMMUNICATION, CLASS_ROLES, DIPLOMACY_LINES, ENGINE_TYPES, GROUND_THRESHOLD, POPULATION_LEVELS, REWARD_COST, SECONDS_PER_YEAR, SENSOR_THRESHOLD, SPECIES_STATUS, TONS_PER_SIZE, aliveByClass, aliveShips, alienRacesSql, classTons, coloniesObserved, communicationLabel, contactStatus, contactTime, diplomaticPoints, gameYear, groundReveal, intelSnapshot, lastShipContact, lostShips, observed, populationField, populationLevel, rebuildFleet, rewardAttempts, sensorReveal, sizedColonies, snapshotSeries, standing, trackedTons, translationProgress, treatiesGranted, treatiesReceived, treatyNames } from '../utilities/intelligence'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { describeResult, getRule, isAvailable, sumResults, valueOrNull } from '../utilities/provenance'
import { loadFormulaVersion } from '../utilities/transport'

const INPUT_LABELS = {
  races: 'the known races',
  ships: 'the tracked ships',
  classes: 'the observed classes',
  populations: 'the observed colonies',
  sensors: 'the observed sensors',
  groundUnits: 'the observed ground units',
  systems: 'the systems they were seen in',
  species: 'the known species',
  formulaVersion: 'the save\'s schema',
}

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

// A ground unit class's three observation counters, each revealing something at the ground threshold.
const GROUND_COUNTERS = [
  { text: 'Hits seen (type)', value: 'Hits' },
  { text: 'Penetrations seen (armour)', value: 'Penetrated' },
  { text: 'Kills seen (hit points)', value: 'Destroyed' },
]

const DETAIL_VIEWS = ['classes', 'colonies', 'sensors', 'ground', 'places']
const RACE_PAGE_SIZES = [15, 50, -1]
const DETAIL_PAGE_SIZES = [5, 10, 15, -1]
const COMMUNICATION_ESTABLISHED = 2
// The rules each panel's figures follow, as the marks on its head.
const RACE_RULES = ['intelligence.standing', 'intelligence.diplomaticPoints', 'intelligence.shipsTracked', 'intelligence.tonsTracked', 'intelligence.contactDate']
const FACT_RULES = ['intelligence.contactDate', 'intelligence.diplomaticPoints', 'intelligence.standing', 'intelligence.treaties', 'intelligence.translationProgress', 'intelligence.observed']
const DETAIL_RULES = {
  classes: ['intelligence.tonsTracked', 'intelligence.shipsTracked', 'intelligence.contactDate', 'intelligence.observed'],
  colonies: ['intelligence.coloniesObserved', 'intelligence.populationLevel', 'intelligence.observed'],
  sensors: ['intelligence.sensorReveal', 'intelligence.observed'],
  ground: ['intelligence.groundReveal', 'intelligence.observed'],
  places: ['intelligence.observed'],
}

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
  components: { ChartCanvas, LoadState, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      detailView: { key: 'intelligenceDetailView', default: 'classes', valid: oneOf(DETAIL_VIEWS) },
      savedAlien: { key: 'intelligenceAlien', default: null, scope: 'race' },
      racesTable: tableView('intelligenceRacesTable', { itemsPerPage: 15, itemsPerPageOptions: RACE_PAGE_SIZES }),
      classesTable: tableView('intelligenceClassesTable', { itemsPerPage: 15, itemsPerPageOptions: DETAIL_PAGE_SIZES }),
      populationsTable: tableView('intelligencePopulationsTable', { itemsPerPage: 15, itemsPerPageOptions: DETAIL_PAGE_SIZES }),
      sensorsTable: tableView('intelligenceSensorsTable', { itemsPerPage: 15, itemsPerPageOptions: DETAIL_PAGE_SIZES }),
      groundTable: tableView('intelligenceGroundTable', { itemsPerPage: 15, itemsPerPageOptions: DETAIL_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      selectedId: null,
      racePageSizes: RACE_PAGE_SIZES,
      detailPageSizes: DETAIL_PAGE_SIZES,
      POPULATION_FIELDS,
      GROUND_COUNTERS,
      GROUND_THRESHOLD,
      SENSOR_THRESHOLD,
      RACE_RULES,
      FACT_RULES,
      DETAIL_RULES,
      linkTo,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'historyRecorded']),

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

    rows() {
      return this.races.map((race) => {
        const status = contactStatus(race.ContactStatus)
        const alive = aliveShips(race)
        const lost = lostShips(race)
        const tonnage = trackedTons(race)
        const lastContact = lastShipContact(race, this.StartYear)
        const standingResult = standing(race.DiplomaticPoints, this.formulaVersion)

        // The figures that can be unknown replace their raw columns, so a table sorts them last and shows a dash; `source` is the row as the query gave it.
        return {
          ...race,
          source: race,
          status: { ...status, color: toneColor(this.appearance, status.color) },
          communication: communicationLabel(race.CommStatus),
          standingResult,
          standingText: valueOrNull(standingResult) || '—',
          firstContact: this.dateResult(race.FirstDetected, 'the first contact time'),
          lastContact,
          LastContact: lastContact && isAvailable(lastContact) ? lastContact.value : null,
          aliveResult: alive,
          lostResult: lost,
          tonsResult: tonnage,
          KnownShips: valueOrNull(alive),
          DestroyedShips: valueOrNull(lost),
          KnownTons: valueOrNull(tonnage),
        }
      })
    },

    selected() {
      return this.rows.find((row) => row.AlienRaceID === this.selectedId) || null
    },

    linkQuery() {
      return linkTo.intelligence(this.selectedId).query
    },

    linkLabel() {
      return this.selected && this.selected.AlienRaceName
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

      const now = intelSnapshot(this.selected.source)
      const past = this.recorded.filter((snapshot) => snapshot.t < now.t)

      return [...past, now]
    },

    tiles() {
      const byStatus = {}

      this.rows.forEach((row) => {
        byStatus[row.status.label] = (byStatus[row.status.label] || 0) + 1
      })

      const alive = sumResults({ rule: 'intelligence.shipsTracked', results: this.rows.map((row) => row.aliveResult) })
      const lost = sumResults({ rule: 'intelligence.shipsTracked', results: this.rows.map((row) => row.lostResult) })
      const tonnage = sumResults({ rule: 'intelligence.tonsTracked', results: this.rows.map((row) => row.tonsResult) })
      const colonies = coloniesObserved(this.populations)
      const sized = sizedColonies(this.populations, this.formulaVersion)
      const sizedFlagged = this.flagged(sized)
      const unknownRaces = this.rows.filter((row) => !isAvailable(row.aliveResult) || !isAvailable(row.lostResult) || !isAvailable(row.tonsResult)).length
      const unknownNote = unknownRaces ? `; ${unknownRaces} of ${this.rows.length} races unknown` : ''
      const ever = isAvailable(alive) && isAvailable(lost) ? alive.value + lost.value : null

      return [
        { label: 'Known races', value: this.count(this.rows.length), note: Object.entries(byStatus).map(([label, number]) => `${number} ${label.toLowerCase()}`).join(', ') },
        { label: 'Ships tracked', title: [describeResult(alive), describeResult(tonnage)].join('. '), value: this.count(valueOrNull(alive)), note: `${this.tons(valueOrNull(tonnage))} still in service, of ${this.count(ever)} ever tracked${unknownNote}` },
        { label: 'Ships destroyed', title: describeResult(lost), value: this.count(valueOrNull(lost)), note: !isAvailable(lost) ? `${unknownRaces} of ${this.rows.length} races unknown` : lost.value ? `${this.count(this.classes.length)} classes observed` : 'None known' },
        { label: 'Colonies observed', title: [describeResult(colonies), sizedFlagged ? describeResult(sized) : null].filter(Boolean).join('. '), value: this.count(colonies.value), note: !colonies.value ? 'None known' : isAvailable(sized) ? `${sized.value} with their population known${sized.status === 'estimated' ? ' (estimate: thresholds not checked for this save)' : ''}` : 'Peak intelligence unknown for some' },
      ]
    },

    facts() {
      const race = this.selected
      const granted = treatiesGranted(race.source)
      const received = treatiesReceived(race.source)
      const treaties = (result) => (isAvailable(result) ? treatyNames(result.value).join(', ') || 'No treaties' : '—')
      const first = race.firstContact
      const last = race.lastContact
      const points = diplomaticPoints(race.DiplomaticPoints)
      const progress = translationProgress(race.CommModifier)
      const intelligence = observed(race.AlienRaceIntelligencePoints, 'the race intelligence points')
      const damage = observed(race.DamageCausedByAlienRace, 'the damage received')
      let communication = { value: race.communication, results: [] }

      if (race.CommEstablished > 0) {
        const established = this.dateResult(race.CommEstablished, 'the time communication was established')

        communication = { value: `${race.communication} on ${this.dateText(established)}`, results: [established] }
      } else if (race.CommStatus === COMMUNICATION_ESTABLISHED && !Number.isFinite(race.CommEstablished)) {
        communication = { value: `${race.communication} on —`, results: [observed(race.CommEstablished, 'the time communication was established')] }
      }

      const facts = [
        { label: 'First contact', value: this.dateText(first), results: [first] },
        { label: 'Last ship contact', value: last ? this.dateText(last) : last === null ? 'None' : '—', results: last ? [last] : [] },
        { label: 'Diplomatic points', value: isAvailable(points) ? `${this.count(points.value)} (${race.standingText.toLowerCase()})` : '—', results: [points, race.standingResult] },
        { label: 'Communication', ...communication },
        { label: 'Treaties granted', value: treaties(granted), results: [granted] },
        { label: 'Treaties received', value: treaties(received), results: [received] },
        { label: 'Race intelligence', value: isAvailable(intelligence) ? `${this.count(intelligence.value, 1)} points; a discovery each time it passes ${REWARD_COST}` : '—', results: [intelligence] },
        { label: 'Damage received', value: this.count(valueOrNull(damage)), results: [damage] },
      ]

      if (race.CommStatus === ATTEMPTING_COMMUNICATION) {
        facts.splice(4, 0, { label: 'Translation progress', value: this.count(valueOrNull(progress), 1), results: [progress] })
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
      const series = (key, rule, name) => snapshotSeries(timeline, key, this.StartYear, rule, name)
      const pointsOf = (result) => valueOrNull(result) || []
      // A series' unknown points stay null, which a chart draws as a gap, and one without a year is left out.
      const placed = (points, key) => points.map((point) => ({ x: this.year(point.t), y: point[key] })).filter((point) => point.x !== null)
      // What a panel's note says of a result that is missing inputs or not available at all.
      const gapNote = (result) => (!isAvailable(result) ? ` ${describeResult(result)}.` : result.inputs.missing.length ? ` Missing ${result.inputs.missing.join(', ')}.` : '')
      const recordedNote = timeline.length > 1 ? `Recorded since ${this.date(timeline[0].t)}.` : 'Recording starts now: points are added when it changes.'
      const fleet = rebuildFleet(this.selectedShips, this.selected.Now, this.StartYear)
      const translating = timeline.some((snapshot) => snapshot.comm === ATTEMPTING_COMMUNICATION)
      const diplomacy = series('points', 'intelligence.diplomaticPoints', 'the diplomatic points')
      const intelligence = series('intel', 'intelligence.observed', 'the race intelligence')
      const translation = translating ? series('translation', 'intelligence.translationProgress', 'the translation progress') : null
      const rewards = rewardAttempts(timeline, this.formulaVersion, this.StartYear)
      const intelDatasets = [line('Race intelligence', pointsOf(intelligence), 0)]
      // Diplomacy's axis reaches the nearest treaty or status line on each side, so where the race stands relative to them shows even with one point.
      const known = pointsOf(diplomacy).map((point) => point.y).filter((y) => y !== null)
      const lineAbove = known.length ? DIPLOMACY_LINES.find((entry) => entry.y >= Math.max(...known)) : undefined
      const lineBelow = known.length ? DIPLOMACY_LINES.slice().reverse().find((entry) => entry.y <= Math.min(...known)) : undefined
      const fleetPoints = pointsOf(fleet)

      if (translation) {
        intelDatasets.push(line('Translation progress', pointsOf(translation), 1, { yAxisID: 'y1' }))
      }

      return [
        {
          key: 'diplomacy',
          title: 'Diplomatic points',
          summary: 'How the diplomatic points of the selected race have moved over time, against the levels where treaties and statuses change.',
          note: `${recordedNote} Dashed lines are where treaties and statuses change.${gapNote(diplomacy)}`,
          results: [diplomacy],
          data: { datasets: [line('Diplomatic points', pointsOf(diplomacy), 0)] },
          options: this.options({ y: (value) => this.count(value) }, { levels: DIPLOMACY_LINES }, { suggestedMax: lineAbove ? lineAbove.y : undefined, suggestedMin: lineBelow ? lineBelow.y : undefined }),
        },
        {
          key: 'fleet',
          title: 'Ships tracked',
          summary: 'How many ships of the selected race have been tracked in service and destroyed, and their tonnage, over time. It shows how its fleet has grown.',
          note: !this.selectedShips.length ? 'No ships tracked.' : `${isAvailable(fleet) ? 'Rebuilt from when each ship was first seen and last hit or seen, back to first contact.' : 'The fleet cannot be rebuilt.'}${gapNote(fleet)}`,
          results: [fleet],
          data: {
            datasets: [
              line('In service', placed(fleetPoints, 'alive'), 0),
              line('Destroyed', placed(fleetPoints, 'lost'), 1),
              line('Tonnage', placed(fleetPoints, 'tons'), 2, { yAxisID: 'y1', borderDash: [6, 4] }),
            ],
          },
          options: this.options({ y: (value) => this.count(value), y1: (value) => this.tons(value) }, {}, { beginAtZero: true, ticks: { precision: 0 } }),
        },
        {
          key: 'intelligence',
          title: translating ? 'Intelligence and translation' : 'Race intelligence',
          summary: 'The intelligence points gathered on the selected race over time, with translation progress while contact is being attempted.',
          note: `${recordedNote} Marks show where points were spent on a discovery.${gapNote(intelligence)}${gapNote(rewards)}${translation ? gapNote(translation) : ''}`,
          results: translation ? [intelligence, rewards, translation] : [intelligence, rewards],
          data: { datasets: intelDatasets },
          options: this.options({ y: (value) => this.count(value), y1: translating ? (value) => this.count(value) : null }, { markers: pointsOf(rewards).map((t) => ({ x: this.year(t), label: 'Discovery' })).filter((marker) => marker.x !== null) }, { min: 0, suggestedMax: REWARD_COST, ticks: { precision: 0 } }),
        },
      ]
    },

    selectedShips() {
      return this.ships.filter((ship) => ship.AlienRaceID === this.selectedId)
    },

    selectedClasses() {
      const classes = this.classes.filter((shipClass) => shipClass.AlienRaceID === this.selectedId)
      const alive = aliveByClass(this.selectedShips, classes)

      return classes.map((shipClass) => {
        const size = classTons(shipClass.TCS)

        return { ...shipClass, alive: valueOrNull(alive[shipClass.AlienClassID]), aliveResult: alive[shipClass.AlienClassID], sizeResult: size, tons: valueOrNull(size) }
      })
    },

    selectedPopulations() {
      return this.populations.filter((population) => population.AlienRaceID === this.selectedId).map((population) => {
        const level = populationLevel(population, this.formulaVersion)

        return {
          ...population,
          intelligence: population.AlienPopulationIntelligencePoints,
          levelResult: level,
          levelText: !isAvailable(level) ? '—' : level.value ? `Known: ${POPULATION_LEVELS.slice(0, level.value).map((entry) => entry.label.toLowerCase()).join('; ')}` : 'Only its signatures are known',
          fields: Object.fromEntries(POPULATION_FIELDS.map((field) => [field.value, populationField(population, field.value, this.formulaVersion)])),
        }
      })
    },

    selectedSensors() {
      return this.sensors.filter((sensor) => sensor.AlienRaceID === this.selectedId).sort((a, b) => (a.Name || '').localeCompare(b.Name || '', undefined, { numeric: true })).map((sensor) => ({ ...sensor, reveal: sensorReveal(sensor.IntelligencePoints, this.formulaVersion) }))
    },

    selectedGroundUnits() {
      return this.groundUnits.filter((unit) => unit.AlienRaceID === this.selectedId).map((unit) => ({ ...unit, reveals: Object.fromEntries(GROUND_COUNTERS.map((counter) => [counter.value, groundReveal(unit[counter.value], this.formulaVersion)])) }))
    },

    selectedSystems() {
      return this.systems.filter((system) => system.AlienRaceID === this.selectedId).sort((a, b) => (a.Name || '').localeCompare(b.Name || ''))
    },

    selectedSpecies() {
      return this.species.filter((entry) => entry.AlienRaceID === this.selectedId)
    },

    raceHeaders() {
      return [
        { text: 'Race', value: 'AlienRaceName', cellClass: 'text-no-wrap' },
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
      this.selectDefault()
    },
    RaceID() {
      this.selectedId = null
    },
  },
  methods: {
    applyLink(query) {
      this.selectedId = queryId(query.race)
      this.selectDefault()
    },
    // The race kept for this race's view, else the one with the most ships seen, when none is selected.
    selectDefault() {
      if (!this.selected && this.rows.length) {
        const saved = this.savedAlien
        const fallback = this.rows.slice().sort((a, b) => b.source.TrackedShips - a.source.TrackedShips)[0]

        this.selectedId = this.rows.some((row) => row.AlienRaceID === saved) ? saved : fallback.AlienRaceID
      }
    },
    select(AlienRaceID) {
      this.selectedId = AlienRaceID
      this.savedAlien = AlienRaceID
    },
    // A figure the save does not hold is a dash, never 0.
    count(value, decimals = 0) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, decimals), this.separator) : '—'
    },
    tons(value) {
      return Number.isFinite(value) ? `${compact(value)} t` : '—'
    },
    scaled(value, divisor) {
      return Number.isFinite(value) ? value / divisor : null
    },
    available(result) {
      return isAvailable(result)
    },
    // The result when it is unavailable or has inputs missing, so a mark shows only where a figure is not whole.
    unknown(result) {
      return result && (!isAvailable(result) || result.inputs.missing.length) ? result : null
    },
    // The result when it is not whole or differs from its rule as registered (a weaker status, or assumptions beyond the rule's own, as an unverified save adds), so the figure's own mark stands where the panel's rule mark would say more than the figure can.
    flagged(result) {
      const rule = result ? getRule(result.rule.id) : null

      return result && (this.unknown(result) || result.status !== rule.verification || result.assumptions.length > rule.assumptions.length) ? result : null
    },
    // An unavailable result for a stored figure that is not a number, else null.
    gap(value, name) {
      return Number.isFinite(value) ? null : observed(value, name)
    },
    year(seconds) {
      return valueOrNull(gameYear(this.StartYear, seconds))
    },
    dateResult(seconds, name) {
      return contactTime(this.StartYear, seconds, name)
    },
    dateText(result) {
      return isAvailable(result) ? gameTime(this.StartYear, result.value).format('YYYY-MM-DD') : '—'
    },
    date(seconds) {
      return this.dateText(this.dateResult(seconds))
    },
    dateGap(seconds) {
      return this.unknown(this.dateResult(seconds))
    },
    rangeText(sensor) {
      return `${this.count(this.scaled(sensor.Range, 1e6), 1)} M km, resolution ${this.count(sensor.Resolution)}`
    },
    // Table rows with the figure missing go last, whichever way it sorts.
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
    engineType(code) {
      return ENGINE_TYPES[code] || 'Unknown'
    },
    classRole(code) {
      return CLASS_ROLES[code] || 'Unknown'
    },
    speciesStatus(code) {
      return SPECIES_STATUS[code] || 'Unknown'
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
              title: (items) => this.date((items[0].parsed.x - this.StartYear) * SECONDS_PER_YEAR),
              label: (item) => `${item.dataset.label}: ${item.dataset.yAxisID === 'y1' && axes.y1 ? axes.y1(item.parsed.y) : axes.y(item.parsed.y)}`,
            },
          },
        },
      }
    },
  },
  asyncComputed: {
    // The formula version the save's schema stands for (`loadFormulaVersion`): the stated one for a 2.7-shaped save, null for any other shape.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
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

        return await this.database.query(`select FCT_AlienShip.AlienRaceID, FCT_AlienShip.AlienClassID, FCT_AlienShip.FirstDetected, FCT_AlienShip.Destroyed, FCT_AlienShip.GameTimeDamaged, FCT_AlienShip.LastContactTime, FCT_AlienClass.TCS * ${TONS_PER_SIZE} as Tons from FCT_AlienShip left join FCT_AlienClass on FCT_AlienClass.AlienClassID = FCT_AlienShip.AlienClassID where FCT_AlienShip.GameID = ${this.GameID} and FCT_AlienShip.ViewRaceID = ${this.RaceID}`).then(([items]) => items)
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

        return await this.database.query(`select FCT_AlienRaceSpecies.AlienRaceID, FCT_AlienRaceSpecies.SpeciesID, FCT_Species.SpeciesName, FCT_KnownSpecies.Status from FCT_AlienRaceSpecies inner join FCT_Species on FCT_Species.SpeciesID = FCT_AlienRaceSpecies.SpeciesID left join FCT_KnownSpecies on FCT_KnownSpecies.SpeciesID = FCT_AlienRaceSpecies.SpeciesID and FCT_KnownSpecies.ViewRaceID = FCT_AlienRaceSpecies.DetectRaceID and FCT_KnownSpecies.GameID = FCT_AlienRaceSpecies.GameID where FCT_AlienRaceSpecies.GameID = ${this.GameID} and FCT_AlienRaceSpecies.DetectRaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.intelligence-page {
  .chart-panel {
    height: calc(100% - 20px);
  }

  .selected-row {
    background: color-mix(in srgb, var(--ae-primary) 8%, transparent);
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
