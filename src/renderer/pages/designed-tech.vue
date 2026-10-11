<template>
  <div>
    <v-container fluid class="designed-tech-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--category">
            <div class="tool__label caption text--secondary">Category</div>
            <v-autocomplete v-model="categoryModel" :items="categoryOptions" item-text="Name" item-value="CategoryID" aria-label="Category" prepend-inner-icon="mdi-shape-outline" auto-select-first dense outlined hide-details>
              <template #item="{ item }">
                <v-list-item-content>
                  <v-list-item-title>{{ item.Name }}</v-list-item-title>
                </v-list-item-content>
                <v-list-item-action class="category-count caption text--secondary">{{ count(item.count) }}</v-list-item-action>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--search">
            <div class="tool__label caption text--secondary">Search</div>
            <v-text-field v-model="search" aria-label="Search components" placeholder="Name or type" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="360">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Filters" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Filters<span v-if="activeFilterCount">&nbsp;({{ activeFilterCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">Show</div>
                <v-checkbox v-model="hideObsolete" label="Hide obsolete" dense hide-details class="mt-1" />
                <v-checkbox v-model="hideCommercial" label="Hide commercial" dense hide-details class="mt-1" />
                <v-checkbox v-model="hideCivilian" label="Hide civilian" dense hide-details class="mt-1" />
                <v-checkbox v-model="unusedOnly" label="Unused only" dense hide-details class="mt-1" />
                <div class="caption text--secondary mt-1">Unused means on no class of yours. Missiles and species are never mounted, so this leaves them all.</div>
                <div class="subtitle-2 mt-4">Columns</div>
                <v-checkbox v-model="perHullSpace" label="Per hull space figures" dense hide-details class="mt-1" />
                <div class="caption text--secondary mt-1">Adds damage per hull space to beam weapons and power per hull space to engines.</div>
                <v-btn v-if="activeFilterCount" text small class="mt-3" @click="resetFilters">Reset filters</v-btn>
              </v-card>
            </v-menu>
          </div>
        </div>

        <stat-tiles class="mt-1" :tiles="tiles" />

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>{{ categoryName }}</span>
            <span class="text--secondary body-2">{{ count(rows.length) }} of {{ count(categoryRows.length) }} shown</span>
          </div>
          <div v-if="selected.length" class="selection-bar">
            <span class="body-2">{{ selected.length }} picked<span v-if="selected.length < 2" class="text--secondary"> · pick one or two more to compare them</span></span>
            <v-btn small text @click="clearSelection">Clear</v-btn>
          </div>
          <v-data-table v-model="selected" class="components-table" :class="{ 'is-expandable': mountable }" :headers="headers" :items="rows" item-key="SDComponentID" show-select :show-expand="mountable" single-expand :expanded.sync="expanded" :sort-by.sync="componentsTable.sortBy" :sort-desc.sync="componentsTable.sortDesc" :items-per-page.sync="componentsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" no-data-text="No design matches the category, filters and search." @click:row="onRowClick">
            <template #[`header.data-table-select`]><span /></template>
            <template #[`item.data-table-select`]="{ item, isSelected, select }">
              <v-simple-checkbox :value="isSelected" :disabled="!isSelected && selected.length >= maxCompare" :ripple="false" :aria-label="`Compare ${item.Name}`" @input="select" />
            </template>
            <template v-for="column in hintedColumns" #[`header.${column.value}`]="{ header }">
              <v-tooltip :key="column.value" top max-width="320">
                <template #activator="{ on }">
                  <span v-on="on">{{ header.text }}<v-icon x-small class="ml-1">mdi-information-outline</v-icon></span>
                </template>
                <span>{{ column.hint }}</span>
              </v-tooltip>
            </template>
            <template #[`item.Name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <v-icon small class="mr-2">{{ iconOf(item) }}</v-icon>
                <div class="name-cell">
                  <div class="font-weight-medium text-no-wrap">{{ item.Name }}</div>
                  <div class="caption text--secondary text-no-wrap">{{ typeLine(item) }}<span v-if="item.Obsolete" class="warning--text font-weight-medium"> · Obsolete</span></div>
                </div>
              </div>
            </template>
            <template v-for="column in cellColumns" #[`item.${column.value}`]="{ item }">
              <div :key="column.value" class="py-2" :class="{ 'text-right': column.numeric }" :title="cellOf(column, item).title">
                <div v-if="cellOf(column, item).none" class="text--disabled">—</div>
                <template v-else>
                  <div class="text-no-wrap">{{ cellOf(column, item).text }}</div>
                  <div v-if="cellOf(column, item).note" class="caption text--secondary text-no-wrap">{{ cellOf(column, item).note }}</div>
                </template>
              </div>
            </template>
            <template #expanded-item="{ headers: columns, item }">
              <td :colspan="columns.length" class="expand-cell">
                <v-simple-table v-if="item.classes.length" dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th class="text-right">Mounted per ship</th>
                      <th class="text-right">Ships in service</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="shipClass in item.classes" :key="shipClass.id">
                      <td>
                        <span class="font-weight-medium">{{ shipClass.name }}</span>
                        <span v-if="shipClass.obsolete" class="warning--text caption"> · Obsolete class</span>
                      </td>
                      <td class="text-right text-no-wrap">{{ count(shipClass.perShip, 2) }}</td>
                      <td class="text-right text-no-wrap">{{ shipClass.ships ? count(shipClass.ships) : '—' }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div v-else class="body-2 text--secondary">No class of this race mounts it.</div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            <div>{{ ruleNote }}</div>
            <div v-if="categoryNoteText" class="mt-1">{{ categoryNoteText }}</div>
          </div>
        </v-card>

        <v-card v-if="compared.length > 1" class="panel" elevation="1">
          <div class="panel-head">
            <span>Compare {{ compared.length }} designs</span>
            <span class="head-tools">
              <span class="legend">
                <span class="legend-item"><span class="dot differs-dot" />Differs</span>
                <span class="legend-item"><v-icon x-small>mdi-arrow-up</v-icon>Highest</span>
                <span class="legend-item"><v-icon x-small>mdi-arrow-down</v-icon>Lowest</span>
              </span>
              <v-btn small text @click="clearSelection">Clear</v-btn>
            </span>
          </div>
          <v-simple-table class="compare-table">
            <thead>
              <tr>
                <th>Attribute</th>
                <th v-for="row in compared" :key="row.SDComponentID" class="text-right">
                  <div class="d-flex align-center justify-end">
                    <span class="text-no-wrap">{{ row.Name }}</span>
                    <v-btn icon x-small class="ml-1" :aria-label="`Remove ${row.Name} from the comparison`" @click="deselect(row.SDComponentID)"><v-icon x-small>mdi-close</v-icon></v-btn>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="attribute in compareAttributes" :key="attribute.key" :class="attribute.differs ? 'compare-differs' : 'compare-same'">
                <td class="text-no-wrap">{{ attribute.label }}</td>
                <td v-for="(cell, index) in attribute.cells" :key="index" class="text-right">
                  <div v-if="cell.none" class="text--disabled">—</div>
                  <template v-else>
                    <div class="text-no-wrap">
                      <v-icon v-if="cell.mark" x-small class="mr-1">{{ cell.mark === 'high' ? 'mdi-arrow-up' : 'mdi-arrow-down' }}</v-icon>{{ cell.text }}
                    </div>
                    <div v-if="cell.note" class="caption text--secondary text-no-wrap">{{ cell.note }}</div>
                  </template>
                </td>
              </tr>
            </tbody>
          </v-simple-table>
          <div class="panel-foot caption text--secondary">A row is tinted when the designs differ in it. The arrows mark the highest and the lowest value of a row that differs; they say nothing about which is better, since a lower cost or a longer interval can be what you want. Classes and ships are what your race has today.</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import { MISSILE_CATEGORY_ID, SPECIES_CATEGORY_ID, augmentComponent, augmentMissile, augmentSpecies, categoryNote, columnsFor, isMountable, tagsOf } from '../utilities/designed-tech'
import { tracked } from '../utilities/load-tracking'
import { MINERALS } from '../utilities/minerals'

const INPUT_LABELS = {
  categories: 'the research categories',
  components: 'the component designs',
  missiles: 'the missile designs',
  species: 'the species',
  classUsage: 'the classes that mount them',
}

const PAGE_SIZES = [15, 30, -1]
const MAX_COMPARE = 3

const USAGE_COLUMNS = [
  { text: 'Classes', value: 'classCount', numeric: true, format: (item, f) => f.count(item.classCount), hint: 'Classes of yours that mount it, obsolete classes included.' },
  { text: 'Ships', value: 'shipCount', numeric: true, format: (item, f) => f.count(item.shipCount), hint: 'Ships of those classes still in service.' },
]

const MINERAL_COLUMNS = MINERALS.map((mineral) => `FCT_ShipDesignComponents.${mineral.name}`).join(', ')

const RULE_NOTE = 'Lists the designs your race knows: researched ones and the base components it starts with. Used on counts the classes of your race that mount a component, obsolete classes included, and the ships of those classes still in service. A component marked obsolete is only kept out of the design pickers; classes that mount it keep it. Commercial is any component that is not a military system (a jump drive: one built as a commercial drive), Civilian one made for a shipping line, and Baseline one from the base data every game starts with. One hull space is 50 tons.'

export default {
  name: 'DesignedTechPage',
  components: { LoadState, StatTiles },
  mixins: [
    countFormat,
    loadState(INPUT_LABELS),
    persistedView({
      selectedCategoryId: { key: 'designedTechCategoryId', default: null },
      hideObsolete: { key: 'designedTechFilterObsolete', default: true },
      hideCommercial: { key: 'designedTechFilterCommercial', default: false },
      hideCivilian: { key: 'designedTechFilterCivilian', default: true },
      unusedOnly: { key: 'designedTechUnusedOnly', default: false },
      perHullSpace: { key: 'designedTechPerHullSpace', default: false },
      search: { key: 'designedTechSearch', default: '', scope: 'race', normalise: (stored) => (typeof stored === 'string' ? stored : '') },
      componentsTable: tableView('designedTechComponentsTable', { sortBy: ['Name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      selected: [],
      expanded: [],
      pageSizes: PAGE_SIZES,
      maxCompare: MAX_COMPARE,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    fmt() {
      return { count: this.count }
    },

    allItems() {
      return [...this.components, ...this.missiles, ...this.species]
    },

    categoryOptions() {
      const counts = new Map()

      this.allItems.forEach((item) => counts.set(item.CategoryID, (counts.get(item.CategoryID) || 0) + 1))

      return this.categories.filter((category) => counts.has(category.CategoryID)).map((category) => ({ CategoryID: category.CategoryID, Name: category.Name, count: counts.get(category.CategoryID) }))
    },

    activeCategoryId() {
      const stored = this.categoryOptions.find((category) => category.CategoryID === this.selectedCategoryId)

      return stored ? stored.CategoryID : this.categoryOptions.length ? this.categoryOptions[0].CategoryID : null
    },

    categoryModel: {
      get() {
        return this.activeCategoryId
      },
      set(id) {
        if (id != null) {
          this.selectedCategoryId = id
        }
      },
    },

    categoryName() {
      const category = this.categoryOptions.find((option) => option.CategoryID === this.activeCategoryId)

      return category ? category.Name : 'Designs'
    },

    mountable() {
      return this.activeCategoryId !== MISSILE_CATEGORY_ID && this.activeCategoryId !== SPECIES_CATEGORY_ID
    },

    categoryNoteText() {
      return categoryNote(this.activeCategoryId)
    },

    ruleNote() {
      return RULE_NOTE
    },

    // Per component: the classes of this race that mount it, each with how many it mounts per ship and the ships in service.
    usageById() {
      const byComponent = new Map()

      this.classUsage.forEach((row) => {
        let classes = byComponent.get(row.ComponentID)

        if (!classes) {
          classes = new Map()
          byComponent.set(row.ComponentID, classes)
        }

        const existing = classes.get(row.ClassID)

        if (existing) {
          existing.perShip += row.NumComponent
        } else {
          classes.set(row.ClassID, { id: row.ClassID, name: row.ClassName, perShip: row.NumComponent, ships: row.Ships, obsolete: !!row.Obsolete })
        }
      })

      return byComponent
    },

    // Every design of the category with its usage, before the filters.
    categoryRows() {
      return this.allItems
        .filter((item) => item.CategoryID === this.activeCategoryId)
        .map((item) => {
          const classes = isMountable(item) && this.usageById.has(item.SDComponentID) ? [...this.usageById.get(item.SDComponentID).values()].sort((a, b) => b.ships - a.ships || a.name.localeCompare(b.name)) : []

          return { ...item, classes, classCount: classes.length, shipCount: classes.reduce((total, shipClass) => total + shipClass.ships, 0) }
        })
        .sort((a, b) => a.Name.localeCompare(b.Name))
    },

    rows() {
      const needle = (this.search || '').trim().toLowerCase()

      return this.categoryRows.filter((row) => {
        if ((this.hideObsolete && row.Obsolete) || (this.hideCommercial && row.Commercial) || (this.hideCivilian && row.Civilian)) {
          return false
        } else if (this.unusedOnly && this.mountable && row.classCount > 0) {
          return false
        }

        return !needle || `${row.Name} ${row.TypeDescription || ''}`.toLowerCase().includes(needle)
      })
    },

    activeFilterCount() {
      return [this.hideObsolete !== true, this.hideCommercial !== false, this.hideCivilian !== true, this.unusedOnly !== false, this.perHullSpace !== false].filter(Boolean).length
    },

    tiles() {
      const rows = this.categoryRows
      const used = rows.filter((row) => row.classCount > 0)
      const unused = rows.filter((row) => row.classCount === 0)
      const obsolete = rows.filter((row) => row.Obsolete)
      const shipClasses = new Set(used.flatMap((row) => row.classes.map((shipClass) => shipClass.id)))
      const ships = new Map(used.flatMap((row) => row.classes.map((shipClass) => [shipClass.id, shipClass.ships])))
      const shipTotal = [...ships.values()].reduce((total, number) => total + number, 0)

      if (!this.mountable) {
        return [
          { label: 'Designs', value: this.count(rows.length), note: `All in the category; ${this.count(this.rows.length)} listed with your filters` },
          { label: 'In use', value: '—', note: 'Not mounted on a class' },
          { label: 'Unused', value: '—', note: 'Not mounted on a class' },
          { label: 'Obsolete', value: this.count(obsolete.length), note: 'Filters ignored · marked obsolete by your race' },
        ]
      }

      return [
        { label: 'Designs', value: this.count(rows.length), note: `All in the category; ${this.count(this.rows.length)} listed with your filters` },
        { label: 'In use', value: this.count(used.length), note: `Filters ignored · on ${this.count(shipClasses.size)} classes, ${this.count(shipTotal)} ships` },
        { label: 'Unused', value: this.count(unused.length), note: `Filters ignored · ${this.count(unused.filter((row) => !row.Obsolete).length)} not obsolete` },
        { label: 'Obsolete', value: this.count(obsolete.length), note: `Filters ignored · ${this.count(obsolete.filter((row) => row.classCount > 0).length)} still on a class` },
      ]
    },

    columnSpecs() {
      const [name, ...rest] = columnsFor(this.activeCategoryId)

      return [name, ...(this.mountable ? USAGE_COLUMNS : []), ...rest.filter((column) => this.perHullSpace || !column.perHS)]
    },

    cellColumns() {
      return this.columnSpecs.filter((column) => column.value !== 'Name')
    },

    hintedColumns() {
      return this.cellColumns.filter((column) => column.hint)
    },

    headers() {
      return this.columnSpecs.map((column) => ({ text: column.text, value: column.value, align: column.numeric ? 'end' : 'start' }))
    },

    compared() {
      const byId = new Map(this.categoryRows.map((row) => [row.SDComponentID, row]))

      return this.selected.map((item) => byId.get(item.SDComponentID)).filter(Boolean)
    },

    compareAttributes() {
      const rows = this.compared

      const attributes = this.cellColumns.map((column) => {
        const cells = rows.map((row) => this.cellOf(column, row))
        const differs = new Set(cells.map((cell) => `${cell.text}|${cell.note}`)).size > 1
        const values = rows.map((row) => Number(row[column.value]) || 0)
        const high = Math.max(...values)
        const low = Math.min(...values)
        const marked = differs && column.numeric && high !== low

        return {
          key: column.value,
          label: column.text,
          differs,
          cells: cells.map((cell, index) => ({ ...cell, mark: marked ? (values[index] === high ? 'high' : values[index] === low ? 'low' : null) : null })),
        }
      })

      const textRow = (key, label, text) => {
        const texts = rows.map(text)

        return { key, label, differs: new Set(texts).size > 1, cells: texts.map((value) => ({ text: value, note: '', none: false, mark: null })) }
      }

      return [...attributes, textRow('status', 'Status', (row) => (row.Obsolete ? 'Obsolete' : 'Current')), textRow('marks', 'Marked as', (row) => tagsOf(row).join(', ') || 'None')]
    },

    // Whether the table is sorted on a column it doesn't show: another category's, or a per hull space one turned off.
    sortOnHiddenColumn() {
      const values = new Set(this.headers.map((header) => header.value))

      return this.ready && ![].concat(this.componentsTable.sortBy).every((value) => values.has(value))
    },
  },
  watch: {
    activeCategoryId() {
      this.selected = []
      this.expanded = []
    },

    sortOnHiddenColumn(hidden) {
      if (hidden) {
        this.componentsTable.sortBy = ['Name']
        this.componentsTable.sortDesc = [false]
      }
    },

    categoryRows(rows) {
      const ids = new Set(rows.map((row) => row.SDComponentID))
      const kept = this.selected.filter((item) => ids.has(item.SDComponentID))

      if (kept.length !== this.selected.length) {
        this.selected = kept
      }

      this.expanded = this.expanded.filter((item) => ids.has(item.SDComponentID))
    },
  },
  methods: {
    cellOf(column, item) {
      const value = item[column.value]
      const none = column.none ? column.none(item) : value == null || Number.isNaN(value) || (column.numeric && value === 0)

      return none ? { text: '—', note: '', title: '', none: true } : { text: column.format(item, this.fmt), note: column.note ? column.note(item, this.fmt) : '', title: column.title ? column.title(item, this.fmt) : '', none: false }
    },

    iconOf(item) {
      if (item.CategoryID === MISSILE_CATEGORY_ID) {
        return 'mdi-rocket-launch-outline'
      } else if (item.CategoryID === SPECIES_CATEGORY_ID) {
        return 'mdi-dna'
      }

      return item.Commercial ? 'mdi-truck' : 'mdi-shield-star'
    },

    typeLine(item) {
      const type = item.CategoryID === MISSILE_CATEGORY_ID ? 'Missile' : item.CategoryID === SPECIES_CATEGORY_ID ? 'Species' : item.TypeDescription || this.categoryName

      return [type, ...tagsOf(item)].join(' · ')
    },

    onRowClick(_item, { expand, isExpanded }) {
      if (this.mountable) {
        expand(!isExpanded)
      }
    },

    deselect(id) {
      this.selected = this.selected.filter((item) => item.SDComponentID !== id)
    },

    clearSelection() {
      this.selected = []
    },

    resetFilters() {
      this.hideObsolete = true
      this.hideCommercial = false
      this.hideCivilian = true
      this.unusedOnly = false
      this.perHullSpace = false
    },
  },
  asyncComputed: {
    categories: {
      get: tracked('categories', async function () {
        if (!this.database) {
          return []
        }

        const [items] = await this.database.query('select CategoryID, Name from DIM_ResearchCategories order by Name')

        return Object.freeze(items)
      }),
      default: [],
    },
    // Every component design the race knows: the researched ones and the base components, each once, as the race's tech list holds them.
    components: {
      get: tracked('components', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [items] = await this.database.query(`select FCT_ShipDesignComponents.SDComponentID, (FCT_ShipDesignComponents.GameID = 0) as Baseline, FCT_RaceTech.Obsolete, FCT_ShipDesignComponents.Name, FCT_TechSystem.CategoryID, DIM_ComponentType.TypeDescription, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.MilitarySystem, FCT_ShipDesignComponents.ShippingLineSystem, FCT_ShipDesignComponents.SpecialFunction, FCT_ShipDesignComponents.Prototype, FCT_ShipDesignComponents.TurretWeaponID, FCT_ShipDesignComponents.SpinalWeapon, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.PowerRequirement, FCT_ShipDesignComponents.RechargeRate, FCT_ShipDesignComponents.TrackingSpeed, FCT_ShipDesignComponents.MaxSensorRange, FCT_ShipDesignComponents.Resolution, FCT_ShipDesignComponents.ECCM, FCT_ShipDesignComponents.HangarReloadOnly, FCT_ShipDesignComponents.ExplosionChance, FCT_ShipDesignComponents.MaxExplosionSize, FCT_ShipDesignComponents.DamageOutput, FCT_ShipDesignComponents.NumberOfShots, FCT_ShipDesignComponents.RangeModifier, FCT_ShipDesignComponents.MaxWeaponRange, FCT_ShipDesignComponents.JumpDistance, FCT_ShipDesignComponents.JumpRating, FCT_ShipDesignComponents.RateOfFire, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.CloakRating, ${MINERAL_COLUMNS} from FCT_RaceTech inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID and (FCT_ShipDesignComponents.GameID = FCT_RaceTech.GameID or FCT_ShipDesignComponents.GameID = 0) inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID and (FCT_TechSystem.RaceID = FCT_RaceTech.RaceID or FCT_TechSystem.RaceID = 0) left join DIM_ComponentType on DIM_ComponentType.ComponentTypeID = FCT_ShipDesignComponents.ComponentTypeID where FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID}`)

        return Object.freeze(items.map(augmentComponent))
      }),
      default: [],
    },
    missiles: {
      get: tracked('missiles', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [items] = await this.database.query(`select FCT_MissileType.MissileID, FCT_MissileType.Name, FCT_RaceTech.Obsolete, FCT_MissileType.Size, FCT_MissileType.Speed, FCT_MissileType.MaxRange, FCT_MissileType.Endurance, FCT_MissileType.FuelRequired, FCT_MissileType.WarheadStrength, FCT_MissileType.MultipleWarheads, FCT_MissileType.RadDamage, FCT_MissileType.SensorStrength, FCT_MissileType.SensorResolution, FCT_MissileType.SensorRange, FCT_MissileType.ThermalStrength, FCT_MissileType.EMStrength, FCT_MissileType.Geostrength, FCT_MissileType.NumDecoys, FCT_MissileType.ECCM, FCT_MissileType.ATG, FCT_MissileType.Retargeting, FCT_MissileType.Cost, FCT_MissileType.Corbomite, FCT_MissileType.Tritanium, FCT_MissileType.Boronide, FCT_MissileType.Uridium, FCT_MissileType.Gallicite, FCT_MissileType.SecondStageID, FCT_MissileType.NumSS, FCT_MissileType.SeparationRange, SecondStage.Name as SecondStageName, SecondStage.MaxRange as SecondStageMaxRange from FCT_RaceTech inner join FCT_MissileType on FCT_MissileType.MissileID = FCT_RaceTech.TechID and FCT_MissileType.GameID = FCT_RaceTech.GameID inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID and FCT_TechSystem.RaceID = FCT_RaceTech.RaceID left join FCT_MissileType as SecondStage on SecondStage.MissileID = FCT_MissileType.SecondStageID and SecondStage.GameID = FCT_MissileType.GameID where FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID}`)

        return Object.freeze(items.map(augmentMissile))
      }),
      default: [],
    },
    // The species of the race's populations, and those it has the tech to design.
    species: {
      get: tracked('species', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [items] = await this.database.query(`select FCT_Species.SpeciesID, FCT_Species.SpeciesName as Name, FCT_Species.Oxygen, FCT_Species.OxyDev, FCT_Species.PressMax, FCT_Species.Temperature, FCT_Species.TempDev, FCT_Species.Gravity, FCT_Species.GravDev, FCT_RaceTech.Obsolete, DIM_Gases.Name as GasName from FCT_Species left join FCT_RaceTech on FCT_RaceTech.TechID = FCT_Species.TechSystemID and FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID} left join DIM_Gases on DIM_Gases.GasID = FCT_Species.BreatheID where FCT_Species.GameID = ${this.GameID} and (FCT_Species.SpeciesID in (select FCT_Population.SpeciesID from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Population > 0) or FCT_RaceTech.TechID = FCT_Species.TechSystemID)`)

        return Object.freeze(items.map(augmentSpecies))
      }),
      default: [],
    },
    // One row per class and component it mounts, with the ships of the class still in service. The class table scopes it: a class component row's own game id isn't reliable.
    classUsage: {
      get: tracked('classUsage', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [items] = await this.database.query(`select FCT_ClassComponent.ComponentID, FCT_ClassComponent.ClassID, FCT_ClassComponent.NumComponent, FCT_ShipClass.ClassName, FCT_ShipClass.Obsolete, coalesce(Fleet.Ships, 0) as Ships from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID left join (select ShipClassID, count(*) as Ships from FCT_Ship where GameID = ${this.GameID} and RaceID = ${this.RaceID} and Destroyed = 0 group by ShipClassID) as Fleet on Fleet.ShipClassID = FCT_ShipClass.ShipClassID where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID}`)

        return Object.freeze(items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.designed-tech-page {
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

  .tool--category {
    flex: 0 1 320px;
    min-width: 220px;
  }

  .tool--search {
    flex: 0 1 260px;
    min-width: 200px;
  }

  .tool--actions {
    align-self: flex-end;
    margin-left: auto;
  }

  .tool--actions .v-btn {
    height: 40px !important;
  }

  .panel {
    margin-top: 8px;
  }

  > .panel {
    margin-top: 20px;
  }

  .head-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
  }

  td,
  th {
    font-variant-numeric: tabular-nums;
  }

  .selection-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 0 24px 12px;
  }

  .category-count {
    min-width: 0;
    margin-left: 16px;
  }

  .name-cell {
    max-width: 360px;
  }

  .name-cell .text-no-wrap {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .components-table.is-expandable tbody tr {
    cursor: pointer;
  }

  .components-table td,
  .components-table th {
    white-space: nowrap;
  }

  .expand-cell {
    padding: 8px 24px 16px !important;
  }

  .detail-table {
    max-width: 720px;
    background: transparent !important;
  }

  .compare-table th:first-child {
    width: 200px;
  }

  .compare-differs td {
    background: rgba(33, 150, 243, 0.1);
  }

  .compare-differs td:first-child {
    box-shadow: inset 3px 0 0 #1e88e5;
    font-weight: 500;
  }

  .compare-same td {
    opacity: 0.6;
  }

  .differs-dot {
    background: rgba(33, 150, 243, 0.45);
  }
}

.theme--dark .designed-tech-page {
  .compare-differs td {
    background: rgba(33, 150, 243, 0.2);
  }
}
</style>
