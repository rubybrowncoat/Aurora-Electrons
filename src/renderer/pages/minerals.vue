<template>
  <div>
    <div v-if="bodyGroups">
      <v-container fluid>
        <v-row justify="start">
          <!-- <v-col cols="12">
            <v-btn-toggle class="mb-3" v-model="materials" color="deep-purple accent-3" tile dense group multiple borderless>
              <v-btn v-for="(material, key) in MaterialMap" :key="key" small :value="material">{{ material }}</v-btn>
            </v-btn-toggle>
          </v-col> -->
          <v-col cols="12">
            <v-expansion-panels hover>
              <v-expansion-panel>
                <v-expansion-panel-header class="font-weight-bold"> Filters </v-expansion-panel-header>

                <v-expansion-panel-content>
                  <v-container fluid>
                    <v-row justify="start">
                      <v-col cols="12">
                        <v-btn-toggle v-model="materials" class="d-block" :color="$vuetify.theme.dark ? 'purple lighten-3' : 'deep-purple accent-3'" tile dense group multiple borderless>
                          <v-btn v-for="(material, key) in MaterialMap" :key="key" small :value="material">{{ material }}</v-btn>
                        </v-btn-toggle>
                      </v-col>
                    </v-row>
                    <v-row v-for="(filter, index) in filters" :key="index" justify="start">
                      <v-col cols="12" md="6">
                        <v-sheet class="d-flex flex-row">
                          <div class="d-flex mr-2">
                            <v-btn color="red" dense :disabled="!index && filters.length === 1" @click="removeFilter(index)">
                              <v-icon dark>mdi-minus</v-icon>
                            </v-btn>
                          </div>
                          <v-select v-model="filter.selectedMaterial" class="d-flex" :items="filterMaterials" hint="Filtered Material" solo persistent-hint dense />
                        </v-sheet>
                      </v-col>
                      <v-col cols="12" md="3">
                        <v-select v-model="filter.selectedAccessibility" :items="accessibilities" hint="Minimum Accessibility" solo persistent-hint dense />
                      </v-col>
                      <v-col cols="12" md="3">
                        <v-text-field v-model.number="filter.selectedAmount" type="number" min="1" placeholder="45000" hint="Minimum Quantity" :rules="[rules.required, rules.positive]" solo persistent-hint clearable dense />
                      </v-col>
                    </v-row>
                    <v-row>
                      <v-col>
                        <v-btn color="success d-flex mr-2" dark @click="addFilter">
                          <v-icon dark>mdi-plus</v-icon>
                        </v-btn>
                      </v-col>
                    </v-row>
                  </v-container>
                </v-expansion-panel-content>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-col>
          <v-col cols="12">
            <v-row>
              <v-col class="pr-2">
                <v-autocomplete v-model="systems" :disabled="filterBySelectedBodies" :items="systemNames" label="Active Systems" item-text="SystemName" item-value="SystemID" multiple small-chips deletable-chips>
                  <template #prepend-item>
                    <v-list-item ripple @click="toggleSystems">
                      <v-list-item-action>
                        <v-icon>
                          {{ systems.length > 0 ? (systems.length == systemNames.length ? 'mdi-emoticon-outline' : 'mdi-emoticon-happy-outline') : 'mdi-emoticon-sad-outline' }}
                        </v-icon>
                      </v-list-item-action>
                      <v-list-item-content>
                        <v-list-item-title>{{ systems.length == systemNames.length ? 'Deselect All' : 'Select All' }}</v-list-item-title>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item v-if="unrestrictedSystems.length && unrestrictedSystems.length !== systemNames.length" ripple :input-value="areSetsEqual(new Set(systems), new Set(unrestrictedSystemsIds))" @click="selectUnrestrictedSystems">
                      <v-list-item-action>
                        <v-icon>mdi-billiards-rack</v-icon>
                      </v-list-item-action>
                      <v-list-item-content>
                        <v-list-item-title>Select Unrestricted Systems</v-list-item-title>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item v-if="colonizedSystems.length && colonizedSystems.length !== systemNames.length" ripple :input-value="areSetsEqual(new Set(systems), new Set(colonizedSystemsIds))" @click="selectOurSystems">
                      <v-list-item-action>
                        <v-icon>mdi-city-variant-outline</v-icon>
                      </v-list-item-action>
                      <v-list-item-content>
                        <v-list-item-title>Select Colonized Systems</v-list-item-title>
                      </v-list-item-content>
                    </v-list-item>
                    <v-list-item v-if="inhabitedColonizedSystems.length && inhabitedColonizedSystems.length !== systemNames.length" ripple :input-value="areSetsEqual(new Set(systems), new Set(inhabitedColonizedSystemsIds))" @click="selectOurInhabitedSystems">
                      <v-list-item-action>
                        <v-icon>mdi-account-multiple-outline</v-icon>
                      </v-list-item-action>
                      <v-list-item-content>
                        <v-list-item-title>Select Inhabited Systems</v-list-item-title>
                      </v-list-item-content>
                    </v-list-item>
                    <v-divider class="mt-2" />
                  </template>
                </v-autocomplete>
              </v-col>
              <v-col cols="auto" class="d-flex align-center">
                <v-menu offset-y :close-on-content-click="false">
                  <template #activator="{ on, attrs }">
                    <v-btn outlined small class="px-2 min-width-0" style="min-width: 0" v-bind="attrs" v-on="on">
                      <span v-if="filterOrbitalEligibility === 'all'">All Bodies</span>
                      <span v-else>{{ orbitalEligibilityLabel }}</span>
                    </v-btn>
                  </template>

                  <v-list dense>
                    <v-list-item v-for="option in orbitalEligibilityOptions" :key="option.value" ripple @click="filterOrbitalEligibility = option.value">
                      <v-list-item-action>
                        <v-icon v-if="filterOrbitalEligibility === option.value">mdi-checkbox-marked</v-icon>
                        <v-icon v-else>mdi-checkbox-blank-outline</v-icon>
                      </v-list-item-action>
                      <v-list-item-content>
                        <v-list-item-title>{{ option.text }}</v-list-item-title>
                        <v-list-item-subtitle v-if="option.value === 'eligible' && maximumOrbitalMiningDiameter">≤ {{ formatOrbitalDiameter(maximumOrbitalMiningDiameter) }}</v-list-item-subtitle>
                      </v-list-item-content>
                    </v-list-item>

                    <v-divider class="my-1" />

                    <v-list-item>
                      <v-list-item-content>
                        <v-list-item-title class="text--secondary" v-if="maximumOrbitalMiningDiameter">Race max diameter: {{ formatOrbitalDiameter(maximumOrbitalMiningDiameter) }}</v-list-item-title>
                        <v-list-item-title class="text--secondary" v-else>Race maximum unknown</v-list-item-title>
                      </v-list-item-content>
                    </v-list-item>
                  </v-list>
                </v-menu>
              </v-col>
            </v-row>
          </v-col>
          <v-col v-if="selectedBodies.length || filterBySelectedBodies" cols="12">
            <v-row>
              <v-col cols="auto">
                <v-btn class="d-block mb-1" style="width: 100%" small outlined :color="filterBySelectedBodies ? 'red' : ''" @click="filterBySelectedBodies = !filterBySelectedBodies">Isolate in Minerals</v-btn>
                <v-btn
                  :to="{
                    path: 'habitability',
                    query: {
                      bodies: JSON.stringify(
                        selectedBodies.map((selection) => ({
                          SystemBodyID: selection.SystemBodyID,
                          SystemBodyName: selection.SystemBodyName,
                          SystemName: selection.SystemName,
                          BodyClass: selection.BodyClass,
                          Component: selection.Component,
                          PlanetNumber: selection.PlanetNumber,
                          OrbitNumber: selection.OrbitNumber,
                        }))
                      ),
                    },
                  }"
                  style="width: 100%"
                  small
                  outlined
                >
                  Isolate in Habitability
                </v-btn>

                <v-btn
                  class="d-block mt-4"
                  style="width: 100%"
                  small
                  outlined
                  @click="
                    selectedBodies = []
                    filterBySelectedBodies = false
                  "
                  >Clear Selection</v-btn
                >
              </v-col>
              <v-col>
                <v-chip v-for="body of selectedBodies" :key="body.SystemBodyID" class="mr-2 mb-2" small label outlined close @click:close="() => (selectedBodies = selectedBodies.filter((selection) => selection.SystemBodyID !== body.SystemBodyID))">{{ body.SystemName }} {{ systemBodyName(body) }}</v-chip>
              </v-col>
            </v-row>
          </v-col>
          <v-col cols="12">
            <v-data-table class="elevation-2" :headers="headers" :items="preFilteredBodyGroups" show-expand :items-per-page.sync="itemsPerPage" :sort-by.sync="sortBy" :sort-desc.sync="sortDescending" :footer-props="{ itemsPerPageOptions }">
              <template #[`item.data-table-expand`]="{ item }">
                <td style="white-space: nowrap">
                  <v-btn v-if="selectedBodies.find((selection) => selection.SystemBodyID === item.SystemBodyID)" color="red" icon @click.stop="() => (selectedBodies = selectedBodies.filter((selection) => selection.SystemBodyID !== item.SystemBodyID))"><v-icon>mdi-playlist-remove</v-icon></v-btn>
                  <v-btn v-else icon @click.stop="() => selectedBodies.push(item)"><v-icon>mdi-playlist-plus</v-icon></v-btn>
                </td>
              </template>
              <template #[`item.SystemBodyOrder`]="{ item }">
                {{ systemBodyName(item) }}
                <v-tooltip v-if="cmcByBody[item.SystemBodyID]" top max-width="360">
                  <template #activator="{ on }">
                    <v-chip x-small label color="teal darken-1" dark class="ml-1 px-1" v-on="on"><v-icon x-small left>mdi-pickaxe</v-icon>CMC ×{{ cmcByBody[item.SystemBodyID].complexes }}</v-chip>
                  </template>
                  <span>{{ cmcColonyText(cmcByBody[item.SystemBodyID]) }}</span>
                </v-tooltip>
                <v-tooltip v-else-if="cmcAllowed && cmcQualifyingMinerals(item).length" top max-width="360">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined class="ml-1 px-1" v-on="on">CMC</v-chip>
                  </template>
                  <span>Could host a civilian mining complex: more than 10,000 t of {{ cmcQualifyingMinerals(item).join(' and ') }} at accessibility 0.7 or better, and the body is close enough to its star. The game founds one only if one of your colonies in the system has over 10 M people, the body has no colony (one of yours with only orbital miners is fine) and isn't banned, and its star is in reach (a companion star within 80 AU of what it orbits, or linked by Lagrange points). It then rolls 1 in 3 for each such body, richest first. The Colonization Planner checks every condition per body.</span>
                </v-tooltip>
              </template>
              <template #[`item.GroundMineralSurvey`]="{ item }">
                <v-tooltip top>
                  <template #activator="{ on }">
                    <span v-if="item.GroundMineralSurvey" v-on="on">M{{ item.GroundMineralSurvey }}</span>
                    <span v-else v-on="on">❌</span>
                  </template>

                  <span>{{ GroundMineralSurveyMap[item.GroundMineralSurvey] }}</span>
                </v-tooltip>
              </template>
              <template #[`item.Potential`]="{ item }">
                <v-tooltip top max-width="360">
                  <template #activator="{ on }">
                    <span
                      :class="{
                        'green--text text--lighten-1 font-weight-bold title': item.Potential >= 7.5,
                        'red--text text--darken-3 font-weight-bold': item.Potential <= 3,
                      }"
                      v-on="on"
                      >{{ roundToDecimal(item.Potential, 1) }}</span
                    >
                  </template>

                  <span>{{ potentialSummary(item) }}</span>
                </v-tooltip>
              </template>
              <template #[`header.Potential`]="{ header }">
                <v-tooltip top max-width="400">
                  <template #activator="{ on }">
                    <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
                  </template>
                  <span>How well the body covers the minerals selected in Filters, from 0 to 10. Each mineral scores 0 to 10 from its amount and accessibility, and the column is their average, so a mineral the body lacks counts as 0. A mineral scores 5 with 20,000 t at accessibility 1 and about 8 with 100,000 t at 0.7; at accessibility 0.1 it stays under 1 however large. Green from 7.5, red at 3 or less. Hover a value for its minerals.</span>
                </v-tooltip>
              </template>
              <template v-for="material in materials" #[`item.${material}`]="{ item }">
                <span
                  v-if="item[material]"
                  :key="material"
                  :class="{
                    'green--text text--lighten-1 font-weight-bold': item[material].Accessibility > 0.7,
                    'red--text text--darken-3 font-weight-bold': item[material].Accessibility <= 0.2,
                    'orange--text text--accent-3': item[material].Accessibility <= 0.4 && item[material].Accessibility > 0.2,
                  }"
                  ><span class="text-no-wrap">{{ separatedNumber(roundToDecimal(item[material].Amount), separator) }}</span> ({{ item[material].Accessibility }})</span
                >
              </template>
              <template #[`item.TotalAccessibility`]="{ item }">
                <span class="text-no-wrap">
                  {{ roundToDecimal(item.TotalAccessibility, 2) }}
                </span>
              </template>
              <template #[`item.TotalAmount`]="{ item }">
                <span class="text-no-wrap">
                  {{ separatedNumber(Math.round(item.TotalAmount), separator) }}
                </span>
              </template>
            </v-data-table>
          </v-col>
        </v-row>
      </v-container>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import _partition from 'lodash/partition'
import _intersectionBy from 'lodash/intersectionBy'

import { separatedNumber, roundToDecimal } from '../utilities/math'
import { systemBodyName } from '../utilities/aurora'
import { areSetsEqual } from '../utilities/generic'
import { cmcBodyInReach } from '../utilities/colonization'
import { CMC_MINERAL_IDS, MINERALS, depositPotential, qualifiesForCmc } from '../utilities/minerals'

const CMC_MINERAL_NAMES = CMC_MINERAL_IDS.map((id) => MINERALS.find((mineral) => mineral.id === id).name)

const MaterialMap = {
  // 0: 'Nothing',
  1: 'Duranium',
  2: 'Neutronium',
  3: 'Corbomite',
  4: 'Tritanium',
  5: 'Boronide',
  6: 'Mercassium',
  7: 'Vendarite',
  8: 'Sorium',
  9: 'Uridium',
  10: 'Corundium',
  11: 'Gallicite',
}

const GroundMineralSurveyMap = {
  0: 'Completed',
  1: 'Minimal',
  2: 'Low',
  3: 'Good',
  4: 'High',
  5: 'Excellent',
}

const BodyClass = {
  0: 'None',
  1: 'Planet',
  2: 'Moon',
  3: 'Asteroid',
  4: 'JumpPoint',
  5: 'Comet',
  6: 'LagrangePoint',
  7: 'Wormhole',
}

const baseFilter = {
  selectedMaterial: 'Any',
  selectedAccessibility: 0.0,
  selectedAmount: null,
}

// The bodies or systems another page (the map) sent along in the query, over the defaults in data().
const selectionFromQuery = (query) => {
  if (query.bodies) {
    const selectedBodies = JSON.parse(query.bodies)

    return {
      selectedBodies,
      filterBySelectedBodies: !!selectedBodies.length,
    }
  } else if (query.systems) {
    return {
      systems: query.systems.split(',').map((id) => parseInt(id, 10)),
    }
  }

  return {}
}

export default {
  components: {},
  data() {
    return {
      filterMaterials: ['Any', 'All Present', 'All', ...Object.values(MaterialMap)],

      accessibilities: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
      selectedAccessibility: 0.1,

      filters: [
        {
          ...baseFilter,
        },
      ],

      filterOrbitalEligibility: 'all',
      orbitalEligibilityOptions: [
        { text: 'All bodies', value: 'all' },
        { text: 'Orbital mining eligible', value: 'eligible' },
        { text: 'Not orbital mining eligible', value: 'ineligible' },
      ],

      selectedAmount: null,

      panels: [0, 1, 2],

      materials: Object.values(MaterialMap),
      systems: [],

      selectedBodies: [],
      filterBySelectedBodies: false,

      itemsPerPage: 10,
      sortBy: [],
      sortDescending: [false],

      //

      rules: {
        required: (value) => !!value || 'Required.',
        positive: (value) => value > 0 || 'Must be positive.',
      },

      // Bodies or systems the map sent along in the query.
      ...selectionFromQuery(this.$route.query),
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    // The race's civilian mining complexes by body: { [SystemBodyID]: { complexes, names, purchased } }.
    cmcByBody() {
      return this.cmcColonies.reduce((bodies, colony) => {
        const body = (bodies[colony.SystemBodyID] = bodies[colony.SystemBodyID] || { complexes: 0, names: [], purchased: false })

        body.complexes += colony.Complexes
        body.names.push(colony.PopName)
        body.purchased = body.purchased || !!colony.PurchaseCivilianMinerals

        return bodies
      }, {})
    },

    itemsPerPageOptions() {
      return [10, 15, 30, 50, 100]
    },

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    bodyGroups() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      const aggregation = this.minerals.reduce((bodies, item) => {
        if (this.filterBySelectedBodies ? !this.selectedBodies.find((selection) => selection.SystemBodyID === item.SystemBodyID) : !this.systems.includes(item.SystemID)) {
          return bodies
        }

        if (!bodies[item.SystemBodyID]) {
          bodies[item.SystemBodyID] = {
            SystemID: item.SystemID,
            SystemName: item.SystemName,
            Component: item.Component,

            SystemBodyID: item.SystemBodyID,
            SystemBodyName: item.SystemBodyName,
            SystemBodyOrder: `${item.Component}-${item.PlanetNumber}-${item.OrbitNumber}`,

            PlanetNumber: item.PlanetNumber,
            OrbitNumber: item.OrbitNumber,

            BodyClass: item.BodyClass,
            BodyTypeID: item.BodyTypeID,
            SystemBodyType: item.BodyTypeID,
            OrbitalDistance: item.OrbitalDistance,
            Eccentricity: item.Eccentricity,
            ParentOrbitalDistance: item.ParentOrbitalDistance,

            GroundMineralSurvey: item.GroundMineralSurvey,
            Radius: item.Radius,
            Diameter: item.Radius ? item.Radius * 2 : null,
          }
        }

        bodies[item.SystemBodyID][this.MaterialMap[item.MaterialID]] = {
          Amount: item.Amount,
          Accessibility: item.Accessibility,

          HalfOriginalAmount: item.HalfOriginalAmount,
          OriginalAcc: item.OriginalAcc,
        }

        return bodies
      }, {})

      return Object.values(aggregation).map((body) => {
        const [totalPotential, totalAmount, totalAccessibility] = Object.values(this.materials).reduce(
          ([potential, amount, accessibility], materialId) => {
            const material = body[materialId]

            if (material) {
              potential += depositPotential(material)
              amount += material.Amount
              accessibility += material.Accessibility
            }

            return [potential, amount, accessibility]
          },
          [0, 0, 0]
        )

        return {
          ...body,

          // The average over every listed mineral, absent ones at 0.
          Potential: this.materials.length ? totalPotential / this.materials.length : 0,
          TotalAmount: totalAmount,
          TotalAccessibility: totalAccessibility,
        }
      })
    },
    systemNames() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      return Object.values(
        this.minerals.reduce((names, item) => {
          if (!names[item.SystemID]) {
            names[item.SystemID] = {
              SystemID: item.SystemID,
              SystemName: item.SystemName,
            }
          }

          return names
        }, {})
      ).sort((a, b) => (a.SystemName || '').localeCompare(b.SystemName || '', undefined, { numeric: true, sensitivity: 'base' }))
    },

    preFilteredBodyGroups() {
      return this.bodyGroups
        .filter((body) => this.passesOrbitalMiningFilter(body))
        .filter((body) => {
          return this.filters.every((filter) => {
            switch (filter.selectedMaterial) {
              case 'Any': {
                return this.materials.some((materialName) => {
                  const material = body[materialName]

                  if (!material) {
                    return false
                  }

                  return this.applyMaterialFilter(material, filter)
                })
              }
              case 'All Present': {
                return this.materials.every((materialName) => {
                  const material = body[materialName]

                  if (!material) {
                    return true
                  }

                  return this.applyMaterialFilter(material, filter)
                })
              }
              case 'All': {
                return this.materials.every((materialName) => {
                  const material = body[materialName]

                  if (!material) {
                    return false
                  }

                  return this.applyMaterialFilter(material, filter)
                })
              }
              default: {
                const material = body[filter.selectedMaterial]

                if (!material) {
                  return false
                }

                return this.applyMaterialFilter(material, filter)
              }
            }
          })
        })
    },

    MaterialMap() {
      return MaterialMap
    },
    GroundMineralSurveyMap() {
      return GroundMineralSurveyMap
    },
    BodyClass() {
      return BodyClass
    },
    maximumOrbitalMiningDiameter() {
      return this.race ? this.race.MaximumOrbitalMiningDiameter : null
    },
    orbitalEligibilityLabel() {
      const active = this.orbitalEligibilityOptions.find((option) => option.value === this.filterOrbitalEligibility)
      return active ? active.text : ''
    },

    headers() {
      const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

      return [
        {
          text: 'System',
          value: 'SystemName',
          divider: true,
          class: 'text-no-wrap',
        },
        {
          text: 'Body',
          value: 'SystemBodyOrder',
          divider: true,
          class: 'text-no-wrap',
          sort: (alpha, beta) => {
            console.log(alpha, beta)
            return collator.compare(alpha, beta)
          },
        },
        {
          text: 'Potential',
          value: 'Potential',
          divider: true,
          align: 'center',
          class: 'text-no-wrap',
        },
        {
          text: 'Ground',
          value: 'GroundMineralSurvey',
          divider: true,
          align: 'center',
          class: 'text-no-wrap',
        },
        ...this.materials.map((material) => ({
          text: material,
          value: material,
          sortable: true,
          align: 'center',
          class: 'text-no-wrap',
          sort: (alpha, beta) => {
            const alphaQuantity = alpha ? alpha.Amount : 0
            const betaQuantity = beta ? beta.Amount : 0

            return betaQuantity - alphaQuantity
          },
        })),
        {
          text: 'Total',
          value: 'TotalAmount',
          class: 'text-no-wrap',
          sort: (alpha, beta) => (beta || 0) - (alpha || 0),
        },
        {
          text: 'Total Accessibility',
          value: 'TotalAccessibility',
          align: 'center',
          class: 'text-no-wrap',
          sort: (alpha, beta) => (beta || 0) - (alpha || 0),
        },
      ]
    },

    unrestrictedSystems() {
      return _intersectionBy(
        this.surveyedSystems.filter((system) => system.RaceSystemSurveys.every((raceSystem) => !raceSystem.MilitaryRestrictedSystem)),
        this.systemNames,
        'SystemID'
      )
    },
    unrestrictedSystemsIds() {
      return this.unrestrictedSystems.map((system) => system.SystemID)
    },
    colonizedSystems() {
      return _intersectionBy(
        this.surveyedSystems.filter((system) => system.Populations.length),
        this.systemNames,
        'SystemID'
      )
    },
    colonizedSystemsIds() {
      return this.colonizedSystems.map((system) => system.SystemID)
    },
    inhabitedColonizedSystems() {
      return this.colonizedSystems.filter((system) => system.InhabitedColonies)
    },
    inhabitedColonizedSystemsIds() {
      return this.inhabitedColonizedSystems.map((system) => system.SystemID)
    },
  },
  watch: {
    itemsPerPage: {
      handler(newValue) {
        console.log('[Minerals] itemsPerPage changed:', newValue)
        this.$store.commit('tables/setMineralsItemsPerPage', newValue)
      },
    },
    sortBy: {
      deep: true,
      handler(newValue) {
        console.log('[Minerals] sortBy changed:', newValue)
        this.$store.commit('tables/setMineralsSortBy', newValue)
      },
    },
    sortDescending: {
      deep: true,
      handler(newValue) {
        console.log('[Minerals] sortDescending changed:', newValue)
        this.$store.commit('tables/setMineralsSortDescending', newValue)
      },
    },
    filterOrbitalEligibility(newValue) {
      this.config.set('mineralsFilterOrbitalEligibility', newValue)
    },
    systemNames: {
      immediate: true,
      handler(newNames) {
        if (newNames) {
          if (!this.systems.length) {
            this.systems = newNames.map((system) => system.SystemID)
          }
        }
      },
    },
  },
  created() {
    // Initialize table settings from store
    if (this.$store.state.tables) {
      this.itemsPerPage = this.$store.state.tables.mineralsItemsPerPage || 10
      this.sortBy = Array.isArray(this.$store.state.tables.mineralsSortBy) ? [...this.$store.state.tables.mineralsSortBy] : []
      this.sortDescending = Array.isArray(this.$store.state.tables.mineralsSortDescending) ? [...this.$store.state.tables.mineralsSortDescending] : [false]
      console.log('[Minerals] Initialized from store - itemsPerPage:', this.itemsPerPage, 'sortBy:', this.sortBy, 'sortDescending:', this.sortDescending)
    }

    const savedOrbitalFilter = this.config.get('mineralsFilterOrbitalEligibility', 'all')
    if (this.orbitalEligibilityOptions.some((option) => option.value === savedOrbitalFilter)) {
      this.filterOrbitalEligibility = savedOrbitalFilter
    }
  },
  mounted() {
    //
  },
  methods: {
    separatedNumber,
    roundToDecimal,

    systemBodyName,

    // The minerals that would draw a civilian mining complex, on a body near enough to its star and not a gas giant.
    cmcQualifyingMinerals(body) {
      return cmcBodyInReach(body) ? CMC_MINERAL_NAMES.filter((name) => qualifiesForCmc(body[name])) : []
    },

    cmcColonyText({ complexes, names, purchased }) {
      return `${names.join(' and ')} ${names.length > 1 ? 'run' : 'runs'} ${complexes} civilian mining ${complexes === 1 ? 'complex' : 'complexes'} here. ${purchased ? 'You buy their minerals.' : 'You tax them; their minerals don\'t reach your stockpile.'}`
    },

    potentialSummary(body) {
      const present = this.materials.filter((name) => body[name])
      const scores = present.map((name) => `${name} ${roundToDecimal(depositPotential(body[name]), 1)}`).join(', ')
      const absent = this.materials.length - present.length

      return `${roundToDecimal(body.Potential, 1)} of 10, the average over ${this.materials.length} minerals: ${scores || 'no deposits'}${absent ? `, ${absent} absent at 0` : ''}.`
    },

    areSetsEqual,

    addFilter() {
      this.filters.push({
        ...baseFilter,
      })
    },
    removeFilter(index) {
      this.filters.splice(index, 1)
    },

    applyMaterialFilter(material, filter) {
      const insideAccessibilityRange = material.Accessibility >= filter.selectedAccessibility

      if (filter.selectedAmount) {
        return material.Amount >= filter.selectedAmount && insideAccessibilityRange
      }

      return insideAccessibilityRange
    },

    toggleSystems() {
      if (this.systems.length === this.systemNames.length) {
        this.systems = []
      } else {
        this.systems = this.systemNames.map((system) => system.SystemID)
      }
    },

    selectOurSystems() {
      this.systems = this.colonizedSystems.map((system) => system.SystemID)
    },
    selectOurInhabitedSystems() {
      this.systems = this.inhabitedColonizedSystems.map((system) => system.SystemID)
    },
    selectUnrestrictedSystems() {
      this.systems = this.unrestrictedSystems.map((system) => system.SystemID)
    },
    formatOrbitalDiameter(value) {
      if (value == null) {
        return ''
      }

      return `${this.separatedNumber(Math.round(value), this.separator)} km`
    },
    passesOrbitalMiningFilter(body) {
      if (this.filterOrbitalEligibility === 'all') {
        return true
      }

      if (!this.maximumOrbitalMiningDiameter) {
        return true
      }

      const diameter = body.Diameter ?? (body.Radius != null ? body.Radius * 2 : null)

      if (diameter == null) {
        return this.filterOrbitalEligibility !== 'eligible'
      }

      const isEligible = diameter <= this.maximumOrbitalMiningDiameter

      if (this.filterOrbitalEligibility === 'eligible') {
        return isEligible
      }

      if (this.filterOrbitalEligibility === 'ineligible') {
        return !isEligible
      }

      return true
    },
  },
  asyncComputed: {
    // Whether the game founds civilian mining complexes at all (FCT_Game.AllowCMC).
    cmcAllowed: {
      async get() {
        if (!this.database || !this.GameID) {
          return false
        }

        const [[game]] = await this.database.query(`select AllowCMC from FCT_Game where GameID = ${this.GameID}`)

        return !!game && game.AllowCMC === 1
      },
      default: false,
    },
    cmcColonies: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [items] = await this.database.query(`select FCT_Population.SystemBodyID, FCT_Population.PopName, case when FCT_Race.NPR = 1 then 1 else FCT_Population.PurchaseCivilianMinerals end as PurchaseCivilianMinerals, FCT_PopulationInstallations.Amount as Complexes from FCT_PopulationInstallations inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_PopulationInstallations.PlanetaryInstallationID = 39 and FCT_PopulationInstallations.Amount > 0`)

        return items
      },
      default: [],
    },
    race: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        const race = await this.database.models.Race.findOne({
          where: {
            GameID: this.GameID,
            RaceID: this.RaceID,
          },
        }).then((race) => {
          if (race) {
            console.log('Loaded race:', race.toJSON())
          }
          return race
        })

        return race
      },
      default: null,
    },
    minerals: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const minerals = await this.database.query(`select FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.StarID, FCT_SystemBody.RuinID, FCT_SystemBody.RuinRaceID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.Radius, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.Eccentricity, VIR_Parent.OrbitalDistance as ParentOrbitalDistance, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName from FCT_MineralDeposit join FCT_RaceSysSurvey on FCT_SystemBody.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBody on FCT_MineralDeposit.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBody as VIR_Parent on VIR_Parent.SystemBodyID = FCT_SystemBody.ParentBodyID and FCT_SystemBody.ParentBodyType = 1 left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID where FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys where FCT_SystemBodySurveys.GameID = ${this.GameID} and FCT_SystemBodySurveys.RaceID = ${this.RaceID}) and FCT_MineralDeposit.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => {
          console.log('Minerals', items)

          return items
        })

        // const minerals = await this.database.query(`select FCT_MineralDeposit.*, FCT_SystemBody.Name as SystemBodyName, FCT_SystemBody.GroundMineralSurvey, DIM_KnownSystems.Name as SystemName from FCT_MineralDeposit left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID left join FCT_System on FCT_System.SystemID = FCT_MineralDeposit.SystemID left join DIM_KnownSystems on DIM_KnownSystems.KnownSystemID = FCT_System.SystemNumber where FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID join FCT_Race on FCT_Race.RaceID = FCT_SystemBodySurveys.RaceID and FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID})`).then(([ items ]) => {
        //   console.log('Minerals', items)

        //   return items
        // })

        return minerals
      },
      default: [],
    },
    surveyedSystems: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const systems = await this.database.models.System.findAll({
          where: {
            GameID: this.GameID,
          },

          include: [
            {
              required: true,
              model: this.database.models.RaceSystemSurvey,
              where: {
                RaceID: this.RaceID,
              },
            },
            {
              required: false,
              model: this.database.models.Population,
              where: {
                RaceID: this.RaceID,
              },
            },
          ],
        }).then((items) => {
          console.log('Surveyed Systems', items)

          return items.map((item) => {
            const [inhabitedColonies, _uninhabitedColonies] = _partition(item.Populations, (population) => population.Population)

            return {
              ...item.toJSON(),

              InhabitedColonies: inhabitedColonies.length,
            }
          })
        })

        console.log(systems)

        return systems
      },
      default: [],
    },
  },
}
</script>

<style lang="scss" scoped></style>
