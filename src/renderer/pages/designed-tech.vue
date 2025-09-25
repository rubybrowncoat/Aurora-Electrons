<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row justify="start">
          <v-col>
            <v-autocomplete v-model="selectedCategoryId" :items="plausibleResearchCategories" item-text="Name" item-value="CategoryID" label="Category" auto-select-first dense solo @change="config.set('designedTechCategoryId', selectedCategoryId)" />
          </v-col>
          <v-col cols="auto">
            <div class="d-flex align-center flex-wrap">
              <v-menu offset-y :close-on-content-click="false">
                <template #activator="{ on, attrs }">
                  <v-btn outlined v-bind="attrs" v-on="on">
                    Filters<span v-if="activeFilterCount"> ({{ activeFilterCount }})</span>
                  </v-btn>
                </template>

                <v-list dense>
                  <v-list-item>
                    <v-checkbox v-model="filterObsolete" label="Hide Obsolete" dense hide-details @change="config.set('designedTechFilterObsolete', filterObsolete)" />
                  </v-list-item>
                  <v-list-item>
                    <v-checkbox v-model="filterCommercial" label="Hide Commercial" dense hide-details @change="config.set('designedTechFilterCommercial', filterCommercial)" />
                  </v-list-item>
                  <v-list-item>
                    <v-checkbox v-model="filterCivilian" label="Hide Civilian" dense hide-details @change="config.set('designedTechFilterCivilian', filterCivilian)" />
                  </v-list-item>
                </v-list>
              </v-menu>
            </div>
          </v-col>
        </v-row>
        <v-row>
          <v-col cols="12">
            <v-data-table v-model="selected" class="elevation-2" :headers="headers" :items="filteredComponents" single-select item-key="SDComponentID" :sort-desc.sync="sortDescending" dense disable-pagination hide-default-footer @click:row="onRowClick" :item-class="rowClass">
              <template #[`item.Name`]="{ item }">
                <div style="min-width: 150px">
                  <span class="mr-1">
                    <v-icon small v-if="item.MilitarySystem">mdi-shield-star</v-icon>
                    <v-icon small v-else>mdi-truck</v-icon>
                  </span>
                  {{ item.Name }}
                  <v-chip v-if="item.Baseline" x-small color="grey darken-1" text-color="white" class="ml-1 px-1 font-weight-medium">Baseline</v-chip>
                  <v-chip v-if="item.TurretWeaponID" x-small color="blue accent-4" text-color="white" class="ml-1 px-1 font-weight-medium">Turret</v-chip>
                  <v-chip v-if="item.SpinalWeapon" x-small color="purple accent-4" text-color="white" class="ml-1 px-1 font-weight-medium">Spinal</v-chip>
                  <v-chip v-if="item.ShippingLineSystem" x-small color="light-green darken-1" text-color="black" class="ml-1 px-1 font-weight-bold">Civilian</v-chip>
                  <v-chip v-if="(item.ComponentTypeID === 16 && item.SpecialFunction === 2) || (item.ComponentTypeID !== 16 && item.MilitarySystem === 0)" x-small color="orange" text-color="white" class="ml-1 px-1 font-weight-medium">Commercial</v-chip>
                  <v-chip v-if="item.Obsolete" x-small color="red accent-4" text-color="white" class="ml-1 px-1 font-weight-medium">Obsolete</v-chip>
                </div>
              </template>
              <template v-for="header in renderedHeaders" v-slot:[`item.${header.value}`]="{ item }">
                <v-tooltip v-if="header.tooltip" :key="header.value" top>
                  <template #activator="{ on }">
                    <div v-on="on">
                      <div v-if="header.render" v-html="header.render(item)" />
                      <div v-else>
                        {{ item[header.value] }}
                      </div>
                    </div>
                  </template>
                  <span v-if="typeof header.tooltip == 'function'">
                    <div v-for="line in header.tooltip(item)" :key="line">{{ line }}</div>
                  </span>
                  <span v-else>{{ header.tooltip }}</span>
                </v-tooltip>
                <div v-else :key="header.value">
                  <div v-if="header.render" v-html="header.render(item)" />
                  <div v-else>
                    {{ item[header.value] }}
                  </div>
                </div>
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

import { roundToDecimal, separatedNumber } from '../utilities/math'
import { toNumber } from '~/utilities/aurora'

// const numberCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const comparator = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

const toCentigrade = (kelvin) => kelvin - KELVIN_OFFSET

const TONS_PER_HULL_SPACE = 50
const KELVIN_OFFSET = 273.15

export default {
  name: 'DesignedTechPage',
  components: {
    //
  },
  data() {
    return {
      selectedCategoryId: null,

      selected: [],
      sortDescending: [false],

      filterObsolete: true,
      filterCommercial: false,
      filterCivilian: true,

      categoryColumnsMap: {},
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    activeFilterCount() {
      return [this.filterObsolete, this.filterCivilian].filter(Boolean).length
    },

    plausibleResearchCategories() {
      return this.researchCategories.filter((category) => !!category.PlayerDefined || !!category.Components)
    },

    filteredComponents() {
      if (!this.selectedCategoryId) {
        return []
      }

      const allComponents = [...this.baselineComponents, ...this.researchedComponents, ...this.species]

      console.log(
        'Filtered Components',
        allComponents.filter((component) => {
          const inCategory = component.CategoryID === this.selectedCategoryId

          const hideObsoleteOk = this.filterObsolete ? !component.Obsolete : true
          const hideCommercialOk = this.filterCommercial ? !component.MilitarySystem : true
          const hideCivilianOk = this.filterCivilian ? !component.ShippingLineSystem : true

          return inCategory && hideObsoleteOk && hideCommercialOk && hideCivilianOk
        })
        // .map((c) => `${c.Name}: ${c.ComponentValue}`)
      )

      return allComponents.filter((component) => {
        const inCategory = component.CategoryID === this.selectedCategoryId

        const hideObsoleteOk = this.filterObsolete ? !component.Obsolete : true
        const hideCommercialOk = this.filterCommercial ? component.MilitarySystem : true
        const hideCivilianOk = this.filterCivilian ? !component.ShippingLineSystem : true

        return inCategory && hideObsoleteOk && hideCommercialOk && hideCivilianOk
      })
    },

    renderedHeaders() {
      return this.headers.filter((header) => typeof header.render === 'function' || !!header.tooltip)
    },

    headers() {
      if (!this.selectedCategoryId) {
        return []
      }

      if (this.categoryColumnsMap[this.selectedCategoryId]) {
        return this.categoryColumnsMap[this.selectedCategoryId]
      }

      return [
        {
          text: 'Name',
          value: 'Name',
          divider: true,
        },
      ]

      // return [
      //   {
      //     text: 'System',
      //     value: 'SystemName',
      //     divider: true,
      //   },
      //   {
      //     text: 'Body',
      //     value: 'SystemBodyOrder',
      //     divider: true,
      //     sort: collator.compare,
      //   },
      //   {
      //     text: 'Ground',
      //     value: 'GroundMineralSurvey',
      //     divider: true,
      //     align: 'center',
      //   },
      //   {
      //     text: 'Max Population (M)',
      //     value: 'MaximumPopulation',
      //     divider: true,
      //   },
      //   {
      //     text: 'Optimal Max (M)',
      //     value: 'MaximumPopulationAtOptimalHydro',
      //     divider: true,
      //   },
      //   {
      //     text: 'Terraformable',
      //     value: 'Liveable',
      //     divider: true,
      //     align: 'center',
      //     sortable: false,
      //   },
      //   {
      //     text: 'Time (Y)',
      //     value: 'TerraformationTime',
      //     divider: true,
      //     align: 'center',
      //     sort: (alpha, beta) => (alpha === -Infinity ? (this.sortDescending[0] ? -1 : 1) : beta === -Infinity ? (this.sortDescending[0] ? 1 : -1) : alpha - beta),
      //   },
      //   {
      //     text: 'Potential',
      //     value: 'MiningPotential',
      //     divider: true,
      //     align: 'center',
      //   },
      //   {
      //     text: 'Total Minerals (T)',
      //     value: 'TotalMiningAmount',
      //     divider: true,
      //   },
      // ]
    },
  },
  watch: {
    researchCategories: {
      immediate: true,
      handler(newResearchCategories) {
        if (!this.selectedCategoryId && newResearchCategories.length > 0) {
          this.selectedCategoryId = newResearchCategories[0].CategoryID
        }
      },
    },
  },
  created() {
    this.selectedCategoryId = this.config.get('designedTechCategoryId', null)
    this.filterObsolete = this.config.get('designedTechFilterObsolete', true)
    this.filterCommercial = this.config.get('designedTechFilterCommercial', false)
    this.filterCivilian = this.config.get('designedTechFilterCivilian', true)

    const nameColumn = {
      text: 'Name',
      value: 'Name',
      divider: true,
    }

    const sizeCostCrewHTKColumns = [
      {
        text: 'Size (Tons)',
        value: 'Size',
        divider: true,
        render: (component) => {
          const hullSpaces = toNumber(component.Size)
          const tons = hullSpaces * TONS_PER_HULL_SPACE

          return this.standardSeparatedDecimal(tons, 2)
        },
      },
      {
        text: 'Cost',
        value: 'Cost',
        divider: true,
        render: (component) => this.standardSeparatedNumber(component.Cost),
        tooltip: (component) => {
          const rows = []

          rows.push('Materials Required')
          rows.push('')

          if (component.Cost > 0) {
            if (component.Duranium > 0) {
              rows.push(`Duranium: ${this.standardSeparatedNumber(component.Duranium)}`)
            }
            if (component.Neuronium > 0) {
              rows.push(`Neutronium: ${this.standardSeparatedNumber(component.Neuronium)}`)
            }
            if (component.Corbomite > 0) {
              rows.push(`Corbomite: ${this.standardSeparatedNumber(component.Corbomite)}`)
            }
            if (component.Tritanium > 0) {
              rows.push(`Tritanium: ${this.standardSeparatedNumber(component.Tritanium)}`)
            }
            if (component.Boronide > 0) {
              rows.push(`Boronide: ${this.standardSeparatedNumber(component.Boronide)}`)
            }
            if (component.Mercassium > 0) {
              rows.push(`Mercassium: ${this.standardSeparatedNumber(component.Mercassium)}`)
            }
            if (component.Vendarite > 0) {
              rows.push(`Vendarite: ${this.standardSeparatedNumber(component.Vendarite)}`)
            }
            if (component.Sorium > 0) {
              rows.push(`Sorium: ${this.standardSeparatedNumber(component.Sorium)}`)
            }
            if (component.Uridium > 0) {
              rows.push(`Uridium: ${this.standardSeparatedNumber(component.Uridium)}`)
            }
            if (component.Corundium > 0) {
              rows.push(`Corundium: ${this.standardSeparatedNumber(component.Corundium)}`)
            }
            if (component.Gallicite > 0) {
              rows.push(`Gallicite: ${this.standardSeparatedNumber(component.Gallicite)}`)
            }
          }

          return rows
        },
      },
      {
        text: 'Crew',
        value: 'Crew',
        divider: true,
        render: (component) => this.standardSeparatedNumber(component.Crew),
      },
      {
        text: 'HTK',
        value: 'HTK',
        divider: true,
        render: (component) => this.standardSeparatedNumber(component.HTK),
      },
    ]

    this.categoryColumnsMap = {
      13: [
        // Active Sensors
        nameColumn,
        {
          text: 'Range (mKm)',
          value: 'MaxSensorRange',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.MaxSensorRange / 1e6, 2),
        },
        {
          text: 'Resolution',
          value: 'Resolution',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.Resolution),
        },
        {
          text: 'Emissions',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        ...sizeCostCrewHTKColumns,
      ],
      23: [
        // Beam Fire Controls
        nameColumn,
        {
          text: 'Range (Km)',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        {
          text: 'Tracking Speed',
          value: 'TrackingSpeed',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.TrackingSpeed),
        },
        ...sizeCostCrewHTKColumns,
      ],
      43: [
        // CIWS
        nameColumn,
        {
          text: 'ROF',
          value: 'ComponentValue',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.ComponentValue)} / 5s`,
        },
        {
          text: 'Tracking Speed',
          value: 'TrackingSpeed',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.TrackingSpeed),
        },
        {
          text: 'ECCM',
          value: 'ECCM',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ECCM),
        },
        ...sizeCostCrewHTKColumns,
      ],
      41: [
        // Cloaking Devices
        nameColumn,
        {
          text: 'Cloak Rating',
          value: 'CloakRating',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.CloakRating, 3),
        },
        {
          text: 'Cloak Ship Size (HS)',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        ...sizeCostCrewHTKColumns,
      ],
      34: [
        // EM Detection Sensors
        nameColumn,
        {
          text: 'Strength',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        {
          text: 'Range vs 10 (mKm)',
          value: 'Range10',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range10 / 1e6, 2),
        },
        {
          text: 'Range vs 100 (mKm)',
          value: 'Range100',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range100 / 1e6, 2),
        },
        {
          text: 'Range vs 1000 (mKm)',
          value: 'Range1000',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range1000 / 1e6, 2),
        },
        {
          text: 'Range vs 10000 (mKm)',
          value: 'Range10000',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range10000 / 1e6, 2),
        },
        ...sizeCostCrewHTKColumns,
      ],
      7: [
        // Engines
        nameColumn,
        {
          text: 'Power',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        {
          text: 'Efficiency',
          value: 'FuelEfficiency',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.FuelEfficiency, component.FuelEfficiency >= 0.0005 ? 3 : 4),
        },
        {
          text: 'Explosion / Chance',
          value: 'MaxExplosionSize',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.MaxExplosionSize)} / ${this.standardSeparatedDecimal(component.ExplosionChance, 1)}%`,
        },
        ...sizeCostCrewHTKColumns,
      ],
      39: [
        // Gauss Cannon
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'RangeModifier',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RangeModifier),
        },
        {
          text: 'Tracking Speed',
          value: 'TrackingSpeed',
          divider: true,
          render: (component) => (component.TrackingSpeed ? this.standardSeparatedNumber(component.TrackingSpeed) : '—'),
        },
        {
          text: 'ROF',
          value: 'NumberOfShots',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.NumberOfShots)} / 5s`,
        },
        ...sizeCostCrewHTKColumns,
      ],
      35: [
        // High Power Microwave
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'RangeModifier',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RangeModifier),
        },
        // {
        //   text: 'Tracking Speed',
        //   value: 'TrackingSpeed',
        //   divider: true,
        //   render: (component) => component.TrackingSpeed ? this.standardSeparatedNumber(component.TrackingSpeed) : '—',
        // },
        {
          text: 'Interval',
          value: 'Interval',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.Interval)}s`,
        },
        {
          text: 'Power',
          value: 'PowerRequirement',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.PowerRequirement),
        },
        {
          text: 'Capacitor',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      22: [
        // Jump Engines
        nameColumn,
        {
          text: 'Capacity',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue * 50),
        },
        {
          text: 'Squadron',
          value: 'JumpRating',
          divider: true,
          // render: (component) => this.standardSeparatedNumber(component.JumpRating),
        },
        {
          text: 'Radius (kKm)',
          value: 'JumpDistance',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.JumpDistance),
        },
        ...sizeCostCrewHTKColumns,
      ],
      2: [
        // Lasers
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'TotalRange',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.TotalRange),
        },
        {
          text: 'Tracking Speed',
          value: 'TrackingSpeed',
          divider: true,
          render: (component) => (component.TrackingSpeed ? this.standardSeparatedNumber(component.TrackingSpeed) : '—'),
        },
        {
          text: 'Interval',
          value: 'Interval',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.Interval)}s`,
        },
        {
          text: 'Power',
          value: 'PowerRequirement',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.PowerRequirement),
        },
        {
          text: 'Capacitor',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      42: [
        // Magazines
        nameColumn,
        {
          text: 'Capacity',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        {
          text: 'Capacity per HS',
          value: 'CapacityPerHS',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.CapacityPerHS, 2),
        },
        ...sizeCostCrewHTKColumns,
      ],
      27: [
        // Meson Cannons
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'RangeModifier',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RangeModifier),
        },
        {
          text: 'Tracking Speed',
          value: 'TrackingSpeed',
          divider: true,
          render: (component) => (component.TrackingSpeed ? this.standardSeparatedNumber(component.TrackingSpeed) : '—'),
        },
        {
          text: 'Interval',
          value: 'Interval',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.Interval)}s`,
        },
        {
          text: 'Power',
          value: 'PowerRequirement',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.PowerRequirement),
        },
        {
          text: 'Capacitor',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      50: [
        // Miscellaneous Components
        nameColumn,
        ...sizeCostCrewHTKColumns,
      ],
      47: [
        // Species
        nameColumn,
        {
          text: 'Breathes',
          value: 'GasName',
          divider: true,
        },
        {
          text: 'Gravity (G)',
          value: 'GravityTriplet',
          divider: true,
          render: (species) => `${this.standardSeparatedDecimal(species.GravityTriplet[0], 2)} < <span class="green--text darken-1">${this.standardSeparatedDecimal(species.GravityTriplet[1], 2)}</span> < ${this.standardSeparatedDecimal(species.GravityTriplet[2], 2)}`,
          sort: (alpha, beta) => {
            const desc = this.sortDescending?.[0] === true
            const [lowAlpha, midAlpha, highAlpha] = alpha
            const [lowBeta, midBeta, highBeta] = beta

            return desc ? comparator(lowBeta, lowAlpha) || comparator(midBeta, midAlpha) || comparator(highBeta, highAlpha) : comparator(highBeta, highAlpha) || comparator(midBeta, midAlpha) || comparator(lowBeta, lowAlpha)
          },
        },
        {
          text: 'Temperature (C)',
          value: 'TemperatureTriplet',
          divider: true,
          render: (species) => `${this.standardSeparatedDecimal(toCentigrade(species.TemperatureTriplet[0]), 2)} < <span class="green--text darken-1">${this.standardSeparatedDecimal(toCentigrade(species.TemperatureTriplet[1]), 2)}</span> < ${this.standardSeparatedDecimal(toCentigrade(species.TemperatureTriplet[2]), 2)}`,
          sort: (alpha, beta) => {
            const desc = this.sortDescending?.[0] === true
            const [lowAlpha, midAlpha, highAlpha] = alpha
            const [lowBeta, midBeta, highBeta] = beta

            return desc ? comparator(lowBeta, lowAlpha) || comparator(midBeta, midAlpha) || comparator(highBeta, highAlpha) : comparator(highBeta, highAlpha) || comparator(midBeta, midAlpha) || comparator(lowBeta, lowAlpha)
          },
        },
        {
          text: 'Oxygen (atm)',
          value: 'OxygenTriplet',
          divider: true,
          render: (species) => `${this.standardSeparatedDecimal(species.OxygenTriplet[0], 2)} < <span class="green--text darken-1">${this.standardSeparatedDecimal(species.OxygenTriplet[1], 2)}</span> < ${this.standardSeparatedDecimal(species.OxygenTriplet[2], 2)}`,
          sort: (alpha, beta) => {
            const desc = this.sortDescending?.[0] === true
            const [lowAlpha, midAlpha, highAlpha] = alpha
            const [lowBeta, midBeta, highBeta] = beta

            return desc ? comparator(lowBeta, lowAlpha) || comparator(midBeta, midAlpha) || comparator(highBeta, highAlpha) : comparator(highBeta, highAlpha) || comparator(midBeta, midAlpha) || comparator(lowBeta, lowAlpha)
          },
        },
        {
          text: 'Max Atmosphere (atm)',
          value: 'PressMax',
          divider: true,
          render: (species) => this.standardSeparatedDecimal(species.PressMax, 2),
        },
      ],
      26: [
        // Particle Beams
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'RangeModifier',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RangeModifier),
        },
        {
          text: 'Interval',
          value: 'Interval',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.Interval)}s`,
        },
        {
          text: 'Power',
          value: 'PowerRequirement',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.PowerRequirement),
        },
        {
          text: 'Capacitor',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      29: [
        // Plasma Carronade
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'TotalRange',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.TotalRange),
        },
        {
          text: 'Interval',
          value: 'Interval',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.Interval)}s`,
        },
        {
          text: 'Power',
          value: 'PowerRequirement',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.PowerRequirement),
        },
        {
          text: 'Capacitor',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      5: [
        // Power Plants
        nameColumn,
        {
          text: 'Power',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.ComponentValue, 0),
        },
        {
          text: 'Power per HS',
          value: 'PowerPerHS',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.PowerPerHS, 2),
        },
        {
          text: 'Explosion / Chance',
          value: 'MaxExplosionSize',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.MaxExplosionSize)} / ${this.standardSeparatedDecimal(component.ExplosionChance, 1)}%`,
        },
        ...sizeCostCrewHTKColumns,
      ],
      28: [
        // Railguns
        nameColumn,
        {
          text: 'Damage',
          value: 'TotalDamage',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.TotalDamage)}`,
          tooltip: (component) => [`${this.standardSeparatedNumber(component.DamageOutput)} x ${component.NumberOfShots}`],
        },
        {
          text: 'Range (Km)',
          value: 'RangeModifier',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RangeModifier),
        },
        {
          text: 'Interval',
          value: 'Interval',
          divider: true,
          render: (component) => `${this.standardSeparatedNumber(component.Interval)}s`,
        },
        {
          text: 'Power',
          value: 'PowerRequirement',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.PowerRequirement),
        },
        {
          text: 'Capacitor',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      12: [
        // Shield Generators
        nameColumn,
        {
          text: 'Strength',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        {
          text: 'Recharge Time (s)',
          value: 'RechargeRate',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.RechargeRate),
        },
        ...sizeCostCrewHTKColumns,
      ],
      14: [
        // Thermal Sensors
        nameColumn,
        {
          text: 'Strength',
          value: 'ComponentValue',
          divider: true,
          render: (component) => this.standardSeparatedNumber(component.ComponentValue),
        },
        {
          text: 'Range vs 10 (mKm)',
          value: 'Range10',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range10 / 1e6, 2),
        },
        {
          text: 'Range vs 100 (mKm)',
          value: 'Range100',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range100 / 1e6, 2),
        },
        {
          text: 'Range vs 1000 (mKm)',
          value: 'Range1000',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range1000 / 1e6, 2),
        },
        {
          text: 'Range vs 10000 (mKm)',
          value: 'Range10000',
          divider: true,
          render: (component) => this.standardSeparatedDecimal(component.Range10000 / 1e6, 2),
        },
        ...sizeCostCrewHTKColumns,
      ],
    }

    // TODO: Special case for missiles
  },
  mounted() {
    //
  },
  methods: {
    separatedNumber,
    roundToDecimal,

    standardSeparatedNumber(number) {
      return separatedNumber(number, this.separator)
    },
    standardSeparatedDecimal(number, decimalPlaces = 2) {
      return separatedNumber(roundToDecimal(number, decimalPlaces), this.separator)
    },

    onRowClick(item, payload) {
      console.log('Row clicked', item, payload)
      const row = payload?.item ?? item
      const key = row.SDComponentID

      const ev = payload?.event || payload
      if (ev?.target && ev.target.closest?.('button,.v-btn,.v-icon,.v-chip,a,input,[role="checkbox"]')) {
        return
      }

      const selectedIndex = this.selected.findIndex((s) => s.SDComponentID === key)
      this.selected = selectedIndex === -1 ? [row] : []
    },

    rowClass(item) {
      return this.selected.some((selection) => selection.SDComponentID === item.SDComponentID) ? 'is-selected-row' : ''
    },

    augmentComponent(component, baseline = false) {
      component.Baseline = baseline

      switch (component.CategoryID) {
        case 34: // EM Detection Sensors
        case 14: // Thermal Sensors
          component.Range10 = Math.sqrt(component.ComponentValue * 10) * 250000
          component.Range100 = Math.sqrt(component.ComponentValue * 100) * 250000
          component.Range1000 = Math.sqrt(component.ComponentValue * 1000) * 250000
          component.Range10000 = Math.sqrt(component.ComponentValue * 10000) * 250000
          break
        case 39: // Gauss Cannon
          component.TotalDamage = component.DamageOutput * component.NumberOfShots
          break
        case 35: // High Power Microwave
        case 26: // Particle Beams
        case 28: // Railguns
          component.TotalDamage = component.DamageOutput * component.NumberOfShots
          component.Interval = Math.ceil(component.PowerRequirement / component.RechargeRate) * 5
          break
        case 2: // Lasers
        case 27: // Meson Cannons
        case 29: // Plasma Carronade
          component.TotalDamage = component.DamageOutput * component.NumberOfShots
          component.TotalRange = component.RangeModifier * component.ComponentValue
          component.Interval = Math.ceil(component.PowerRequirement / component.RechargeRate) * 5
          break
        case 42: // Magazines
          component.CapacityPerHS = component.ComponentValue / component.Size
          break
        case 5: // Power Plants
          component.PowerPerHS = component.ComponentValue / component.Size
          break
        default:
          break
      }

      return component
    },

    augmentSpecies(species) {
      species.SDComponentID = `species-${species.SpeciesID}`
      species.CategoryID = 47 // Species
      species.MilitarySystem = 1

      species.TemperatureTriplet = [species.Temperature - species.TempDev, species.Temperature, species.Temperature + species.TempDev]
      species.OxygenTriplet = [species.Oxygen - species.OxyDev, species.Oxygen, species.Oxygen + species.OxyDev]
      species.GravityTriplet = [species.Gravity - species.GravDev, species.Gravity, species.Gravity + species.GravDev]

      return species
    },
  },
  asyncComputed: {
    componentTypes: {
      async get() {
        if (!this.database) {
          return []
        }

        const types = await this.database
          .query(
            `
          select DIM_ComponentType.ComponentTypeID, DIM_ComponentType.TypeDescription, DIM_ComponentType.EmptySpaceModifier, DIM_ComponentType.RatingDescription, DIM_ComponentType.ClassDisplayOrder, DIM_ComponentType.RepairPriority, DIM_ComponentType.ShowInClassDisplay, DIM_ComponentType.SingleSystem, DIM_ComponentType.ObsoleteAllowed, DIM_ComponentType.ClassSummaryTypeID, DIM_ClassSummaryType.Description as ClassSummaryType from DIM_ComponentType

          left join DIM_ClassSummaryType on DIM_ComponentType.ClassSummaryTypeID = DIM_ClassSummaryType.ClassSummaryTypeID

          where DIM_ComponentType.ObsoleteAllowed = 1
        `
          )
          .then(([items]) => {
            console.log('Component Types', items)

            return items
          })

        return types
      },
      default: [],
    },
    researchCategories: {
      async get() {
        if (!this.database) {
          return []
        }

        const categories = await this.database
          .query(
            `
          select DIM_ResearchCategories.CategoryID, DIM_ResearchCategories.CheckTech, DIM_ResearchCategories.Name, DIM_ResearchCategories.CompanyNameType, DIM_ResearchCategories.PlayerDefined, DIM_ResearchCategories.Components, DIM_ResearchCategories.NoteField from DIM_ResearchCategories

          order by DIM_ResearchCategories.Name
        `
          )
          .then(([items]) => {
            console.log('Research Categories', items)

            return items
          })

        return categories
      },
      default: [],
    },
    baselineComponents: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const components = await this.database
          .query(
            `
          select FCT_ShipDesignComponents.SDComponentID, FCT_RaceTech.Obsolete, FCT_ShipDesignComponents.Name, FCT_TechSystem.CategoryID, FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.AdditionalInfo3, FCT_TechSystem.AdditionalInfo4, FCT_TechSystem.TechDescription, FCT_ShipDesignComponents.MilitarySystem, FCT_ShipDesignComponents.BeamWeapon, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.PowerRequirement, FCT_ShipDesignComponents.RechargeRate, FCT_ShipDesignComponents.ElectronicSystem, FCT_ShipDesignComponents.ElectronicCTD, FCT_ShipDesignComponents.TrackingSpeed, FCT_ShipDesignComponents.SpecialFunction, FCT_ShipDesignComponents.MaxSensorRange, FCT_ShipDesignComponents.Resolution, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.FuelUse, FCT_ShipDesignComponents.NoMaintFailure, FCT_ShipDesignComponents.HangarReloadOnly, FCT_ShipDesignComponents.ExplosionChance, FCT_ShipDesignComponents.MaxExplosionSize, FCT_ShipDesignComponents.DamageOutput, FCT_ShipDesignComponents.NumberOfShots, FCT_ShipDesignComponents.RangeModifier, FCT_ShipDesignComponents.MaxWeaponRange, FCT_ShipDesignComponents.SpinalWeapon, FCT_ShipDesignComponents.JumpDistance, FCT_ShipDesignComponents.JumpRating, FCT_ShipDesignComponents.RateOfFire, FCT_ShipDesignComponents.MaxPercentage, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.IgnoreShields, FCT_ShipDesignComponents.IgnoreArmour, FCT_ShipDesignComponents.ElectronicOnly, FCT_ShipDesignComponents.StealthRating, FCT_ShipDesignComponents.CloakRating, FCT_ShipDesignComponents.Weapon, FCT_ShipDesignComponents.BGTech1, FCT_ShipDesignComponents.BGTech2, FCT_ShipDesignComponents.BGTech3, FCT_ShipDesignComponents.BGTech4, FCT_ShipDesignComponents.BGTech5, FCT_ShipDesignComponents.BGTech6, FCT_ShipDesignComponents.BGTech7, FCT_ShipDesignComponents.Duranium, FCT_ShipDesignComponents.Neutronium, FCT_ShipDesignComponents.Corbomite, FCT_ShipDesignComponents.Tritanium, FCT_ShipDesignComponents.Boronide, FCT_ShipDesignComponents.Mercassium, FCT_ShipDesignComponents.Vendarite, FCT_ShipDesignComponents.Sorium, FCT_ShipDesignComponents.Uridium, FCT_ShipDesignComponents.Corundium, FCT_ShipDesignComponents.Gallicite, FCT_ShipDesignComponents.SingleSystemOnly, FCT_ShipDesignComponents.ShipyardRepairOnly, FCT_ShipDesignComponents.ECCM, FCT_ShipDesignComponents.ArmourRetardation, FCT_ShipDesignComponents.WeaponToHitModifier, FCT_ShipDesignComponents.Prototype, FCT_ShipDesignComponents.TurretWeaponID, FCT_ShipDesignComponents.ShipComponentTemplateID, FCT_ShipDesignComponents.EnginePowerMod, FCT_ShipDesignComponents.ExtraHTK, FCT_ShipDesignComponents.FCRangeModifier, FCT_ShipDesignComponents.FCSpeedModifier, FCT_ShipDesignComponents.ShippingLineSystem from FCT_ShipDesignComponents

          left join FCT_RaceTech on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID and FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID}
          left join FCT_TechSystem on FCT_ShipDesignComponents.SDComponentID = FCT_TechSystem.TechSystemID

          where FCT_ShipDesignComponents.GameID = 0 and FCT_TechSystem.RaceID = 0
        `
          )
          .then(([items]) => {
            console.log('Baseline Components', items)

            return items.map((component) => this.augmentComponent(component, true))
          })

        return components
      },
      default: [],
    },
    researchedComponents: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const components = await this.database
          .query(
            `
          select FCT_ShipDesignComponents.SDComponentID, FCT_RaceTech.GameID, FCT_RaceTech.RaceID, FCT_RaceTech.Obsolete, FCT_ShipDesignComponents.Name, FCT_TechSystem.CategoryID, FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.AdditionalInfo3, FCT_TechSystem.AdditionalInfo4, FCT_TechSystem.TechDescription, FCT_ShipDesignComponents.MilitarySystem, FCT_ShipDesignComponents.BeamWeapon, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.PowerRequirement, FCT_ShipDesignComponents.RechargeRate, FCT_ShipDesignComponents.ElectronicSystem, FCT_ShipDesignComponents.ElectronicCTD, FCT_ShipDesignComponents.TrackingSpeed, FCT_ShipDesignComponents.SpecialFunction, FCT_ShipDesignComponents.MaxSensorRange, FCT_ShipDesignComponents.Resolution, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.FuelUse, FCT_ShipDesignComponents.NoMaintFailure, FCT_ShipDesignComponents.HangarReloadOnly, FCT_ShipDesignComponents.ExplosionChance, FCT_ShipDesignComponents.MaxExplosionSize, FCT_ShipDesignComponents.DamageOutput, FCT_ShipDesignComponents.NumberOfShots, FCT_ShipDesignComponents.RangeModifier, FCT_ShipDesignComponents.MaxWeaponRange, FCT_ShipDesignComponents.SpinalWeapon, FCT_ShipDesignComponents.JumpDistance, FCT_ShipDesignComponents.JumpRating, FCT_ShipDesignComponents.RateOfFire, FCT_ShipDesignComponents.MaxPercentage, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.IgnoreShields, FCT_ShipDesignComponents.IgnoreArmour, FCT_ShipDesignComponents.ElectronicOnly, FCT_ShipDesignComponents.StealthRating, FCT_ShipDesignComponents.CloakRating, FCT_ShipDesignComponents.Weapon, FCT_ShipDesignComponents.BGTech1, FCT_ShipDesignComponents.BGTech2, FCT_ShipDesignComponents.BGTech3, FCT_ShipDesignComponents.BGTech4, FCT_ShipDesignComponents.BGTech5, FCT_ShipDesignComponents.BGTech6, FCT_ShipDesignComponents.BGTech7, FCT_ShipDesignComponents.Duranium, FCT_ShipDesignComponents.Neutronium, FCT_ShipDesignComponents.Corbomite, FCT_ShipDesignComponents.Tritanium, FCT_ShipDesignComponents.Boronide, FCT_ShipDesignComponents.Mercassium, FCT_ShipDesignComponents.Vendarite, FCT_ShipDesignComponents.Sorium, FCT_ShipDesignComponents.Uridium, FCT_ShipDesignComponents.Corundium, FCT_ShipDesignComponents.Gallicite, FCT_ShipDesignComponents.SingleSystemOnly, FCT_ShipDesignComponents.ShipyardRepairOnly, FCT_ShipDesignComponents.ECCM, FCT_ShipDesignComponents.ArmourRetardation, FCT_ShipDesignComponents.WeaponToHitModifier, FCT_ShipDesignComponents.Prototype, FCT_ShipDesignComponents.TurretWeaponID, FCT_ShipDesignComponents.ShipComponentTemplateID, FCT_ShipDesignComponents.EnginePowerMod, FCT_ShipDesignComponents.ExtraHTK, FCT_ShipDesignComponents.FCRangeModifier, FCT_ShipDesignComponents.FCSpeedModifier, FCT_ShipDesignComponents.ShippingLineSystem from FCT_RaceTech

          inner join FCT_ShipDesignComponents on FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID
          inner join FCT_TechSystem on FCT_RaceTech.TechID = FCT_TechSystem.TechSystemID

          where FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID} and FCT_TechSystem.RaceID = FCT_RaceTech.RaceID
        `
          )
          .then(([items]) => {
            console.log('Components', items)

            return items.map((component) => this.augmentComponent(component))
          })

        return components
      },
      default: [],
    },
    species: {
      async get() {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const species = await this.database
          .query(
            `
          select FCT_Species.SpeciesID, FCT_Species.TechSystemID, FCT_Species.HomeworldID, FCT_Species.DerivedSpeciesID, FCT_Species.SpeciesName as Name, FCT_Species.RacePic, FCT_Species.BreatheID, FCT_Species.Oxygen, FCT_Species.OxyDev, FCT_Species.PressMax, FCT_Species.Temperature, FCT_Species.TempDev, FCT_Species.Gravity, FCT_Species.GravDev, FCT_Species.Xenophobia, FCT_Species.Diplomacy, FCT_Species.Translation, FCT_Species.Militancy, FCT_Species.Expansionism, FCT_Species.Determination, FCT_Species.Trade, FCT_Species.SpecialNPRID, FCT_Species.ProductionRateModifier, FCT_Species.ResearchRateModifier, FCT_Species.PopulationGrowthModifier, FCT_Species.PopulationDensityModifier, FCT_Species.GraduationAge, FCT_RaceTech.Obsolete, FCT_TechSystem.CategoryID, FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.AdditionalInfo3, FCT_TechSystem.AdditionalInfo4, FCT_TechSystem.TechDescription, DIM_Gases.Name as GasName, DIM_Gases.Symbol, DIM_Gases.Dangerous, DIM_Gases.DangerousLevel from FCT_Species

          left join FCT_TechSystem on FCT_Species.TechSystemID = FCT_TechSystem.TechSystemID
          left join FCT_RaceTech on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID and FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID}
          left join DIM_Gases on FCT_Species.BreatheID = DIM_Gases.GasID

          where FCT_Species.SpeciesID in (select FCT_Population.SpeciesID from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Population > 0 group by FCT_Population.SpeciesID) or FCT_RaceTech.TechID = FCT_Species.TechSystemID
        `
          )
          .then(([items]) => {
            console.log('Species', items)

            return items.map((species) => this.augmentSpecies(species))
          })

        return species
      },
      default: [],
    },
  },
}
</script>

<style lang="scss">
.is-selected-row {
  background-image: repeating-linear-gradient(-45deg, rgba(33, 150, 243, 0.12) 0, rgba(33, 150, 243, 0.12) 12px, rgba(33, 150, 243, 0.04) 12px, rgba(33, 150, 243, 0.04) 24px) !important;

  background-size: auto !important;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

/* optional: keep the same look on hover */
.v-data-table .is-selected-row:hover {
  background-image: repeating-linear-gradient(-45deg, rgba(33, 150, 243, 0.14) 0, rgba(33, 150, 243, 0.14) 12px, rgba(33, 150, 243, 0.06) 12px, rgba(33, 150, 243, 0.06) 24px) !important;
}

.theme--dark .is-selected-row {
  background-image: repeating-linear-gradient(-45deg, rgba(33, 150, 243, 0.22) 0, rgba(33, 150, 243, 0.22) 12px, rgba(33, 150, 243, 0.1) 12px, rgba(33, 150, 243, 0.1) 24px) !important;
  border-top-color: rgba(255, 255, 255, 0.06);
  border-bottom-color: rgba(255, 255, 255, 0.06);
}
</style>
