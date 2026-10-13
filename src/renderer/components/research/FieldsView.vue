<template>
  <v-row class="fields-view">
    <v-col cols="12" md="4" lg="3" xl="2">
      <v-select v-if="!$vuetify.breakpoint.mdAndUp" :value="fieldId" :items="research.fields" item-text="FieldName" item-value="ResearchFieldID" label="Field" dense outlined hide-details @change="(id) => $emit('select-field', id)" />
      <v-card v-else class="rail" elevation="1">
        <button v-for="item in research.fields" :key="item.ResearchFieldID" type="button" class="rail-item" :class="{ selected: item.ResearchFieldID === fieldId }" @click="$emit('select-field', item.ResearchFieldID)">
          <span class="rail-title">
            <span class="abbreviation">{{ item.Abbreviation }}</span>
            <span class="rail-name">{{ item.FieldName }}</span>
            <span v-if="countsOf(item).available" class="rail-now">{{ countsOf(item).available }} now</span>
          </span>
          <span class="meter" :title="`${countsOf(item).done} researched, ${countsOf(item).active + countsOf(item).queued} in progress`">
            <span class="meter-fill meter-done" :style="{ width: `${share(countsOf(item).done, reachable(item))}%` }" />
            <span class="meter-fill meter-active" :style="{ width: `${share(countsOf(item).active + countsOf(item).queued, reachable(item))}%` }" />
          </span>
          <span class="caption text--secondary">{{ count(countsOf(item).done) }} of {{ count(reachable(item)) }} researched</span>
        </button>
      </v-card>
    </v-col>

    <v-col cols="12" md="8" lg="9" xl="10">
      <v-card v-if="search" class="panel" data-summary="Technologies from every field whose name matches the search, with their status and remaining cost. Click one to open it." elevation="1">
        <div class="panel-head">
          <span>{{ matches.length }} {{ matches.length === 1 ? 'technology matches' : 'technologies match' }} "{{ search }}"</span>
          <span v-if="matches.length > MATCH_LIMIT" class="caption text--secondary">Showing the first {{ MATCH_LIMIT }}</span>
        </div>
        <v-data-table :headers="matchHeaders" :items="matches.slice(0, MATCH_LIMIT)" item-key="id" dense :custom-sort="sortMatches" :sort-by.sync="matchesTable.sortBy" :sort-desc.sync="matchesTable.sortDesc" :items-per-page.sync="matchesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: MATCH_PAGE_SIZES }" class="clickable" @click:row="(item) => $emit('select-tech', item.id)">
          <template #[`item.status`]="{ item }">
            <span class="status-chip"><v-icon x-small :color="statusColor(item.status)">{{ icons[item.status] }}</v-icon> {{ labels[item.status] }}</span>
          </template>
          <template #[`item.name`]="{ item }">
            <div class="font-weight-medium">{{ item.name }}</div>
            <div class="caption text--secondary">{{ item.line }}</div>
          </template>
          <template #[`item.remaining`]="{ item }">
            <span v-if="item.status === 'done'" class="text--secondary">—</span>
            <span v-else-if="item.remaining === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.remainingResult" /></span>
            <span v-else class="text-no-wrap">{{ count(item.remaining) }} RP</span>
          </template>
        </v-data-table>
      </v-card>

      <template v-else-if="field">
        <div class="d-flex align-center flex-wrap mb-3">
          <span class="text-h6 mr-4">{{ field.FieldName }}</span>
          <span class="caption text--secondary">{{ fieldSummary }}</span>
        </div>

        <v-expansion-panels v-model="open" multiple accordion class="panels">
          <v-expansion-panel>
            <v-expansion-panel-header>
              <span class="panel-title">In progress <span class="panel-count">{{ projects.length }}</span></span>
            </v-expansion-panel-header>
            <v-expansion-panel-content>
              <div v-if="!projects.length" class="empty">No project is running in this field.</div>
              <div v-for="project in projects" :key="project.ProjectID" class="project">
                <div class="project-main">
                  <div class="project-name">
                    <v-icon small :color="statusColor('active')" class="mr-2">{{ project.running ? 'mdi-flask' : 'mdi-pause-circle-outline' }}</v-icon>
                    <a class="tech-link" @click="$emit('select-tech', project.TechID)">{{ project.Name }}</a>
                    <span v-if="!project.running" class="caption warning--text ml-2">{{ pausedLabel(project) }}<provenance-mark v-if="pausedResult(project)" :result="pausedResult(project)" /></span>
                  </div>
                  <div class="caption text--secondary">
                    {{ project.PopName }}<page-link :to="colonyLink(project.PopulationID)" :name="project.PopName" class="ml-1" /> · {{ scientistLabel(project) }}<page-link v-if="project.CommanderID" :to="commanderLink(project.CommanderID)" :name="project.ScientistName" class="ml-1" /> · {{ count(project.Facilities) }}<span v-if="project.MaxLabs"> of {{ count(project.MaxLabs) }}</span> labs · {{ count(project.rate) }} RP a year<provenance-mark v-if="project.CommanderID" :result="project.rateResult" />
                  </div>
                </div>
                <div class="project-progress">
                  <span class="meter"><span class="meter-fill meter-active" :style="{ width: `${progress(project)}%` }" /></span>
                  <span class="caption text-no-wrap">{{ count(project.ResearchPointsRequired) }} of {{ count(project.DevelopCost) }} RP left<provenance-mark v-if="leftResult(project)" :result="leftResult(project)" /></span>
                </div>
                <div class="project-eta">
                  <div class="text-no-wrap">{{ project.landing.text }}<provenance-mark v-if="project.landing.result" :result="project.landing.result" /></div>
                  <div v-if="project.years !== null" class="caption text--secondary text-no-wrap">in {{ duration(project.years) }}</div>
                </div>
                <div v-for="entry in project.queue" :key="`${entry.CurrentProjectID}-${entry.ResearchOrder}`" class="queued">
                  <div class="project-name">
                    <v-icon small :color="statusColor('queued')" class="mr-2">mdi-subdirectory-arrow-right</v-icon>
                    <a class="tech-link" @click="$emit('select-tech', entry.TechID)">{{ entry.Name }}</a>
                  </div>
                  <div class="project-progress caption text--secondary">{{ count(entry.remaining) }} RP<provenance-mark v-if="entry.remaining === null" :result="entry.yearsResult" />, queued {{ entry.ResearchOrder }}</div>
                  <div class="project-eta caption">
                    <span class="text-no-wrap">{{ entry.landing.text }}<provenance-mark v-if="entry.landing.result" :result="entry.landing.result" /></span>
                  </div>
                </div>
              </div>
            </v-expansion-panel-content>
          </v-expansion-panel>

          <v-expansion-panel>
            <v-expansion-panel-header>
              <span class="panel-title">Available now <span class="panel-count">{{ group.available.length }}</span></span>
            </v-expansion-panel-header>
            <v-expansion-panel-content>
              <div v-if="scientistNote" class="caption text--secondary mb-2">{{ scientistNote }}</div>
              <div v-if="!group.available.length" class="empty">Nothing to start here: every project is running, queued or waits on a prerequisite.</div>
              <v-data-table v-else :headers="availableHeaders" :items="availableRows" item-key="id" dense :custom-sort="sortNullLast" :sort-by.sync="availableTable.sortBy" :sort-desc.sync="availableTable.sortDesc" :items-per-page.sync="availableTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: TECH_PAGE_SIZES }" class="clickable" @click:row="(item) => $emit('select-tech', item.id)">
                <template #[`item.name`]="{ item }">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div class="caption text--secondary">{{ item.line }}<span v-if="item.automatic"> · free with its prerequisite</span></div>
                </template>
                <template #[`item.remaining`]="{ item }">
                  <span v-if="item.remaining === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.remainingResult" /></span>
                  <span v-else class="text-no-wrap">{{ count(item.remaining) }} RP</span>
                  <div v-if="item.banked > 0" class="caption text--secondary text-no-wrap">{{ count(item.banked) }} banked of {{ count(item.cost) }}</div>
                </template>
                <template #[`item.unlocks`]="{ item }">
                  <span v-if="item.unlocks">{{ item.unlocks }}</span>
                  <span v-else class="text--secondary">—</span>
                </template>
              </v-data-table>
            </v-expansion-panel-content>
          </v-expansion-panel>

          <v-expansion-panel>
            <v-expansion-panel-header>
              <span class="panel-title">Waiting on a prerequisite <span class="panel-count">{{ group.locked.length }}</span></span>
            </v-expansion-panel-header>
            <v-expansion-panel-content>
              <div v-if="!group.locked.length" class="empty">Nothing here waits on a prerequisite.</div>
              <v-data-table v-else :headers="lockedHeaders" :items="lockedRows" item-key="id" dense :custom-sort="sortNullLast" :sort-by.sync="lockedTable.sortBy" :sort-desc.sync="lockedTable.sortDesc" :items-per-page.sync="lockedTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: TECH_PAGE_SIZES }" class="clickable" @click:row="(item) => $emit('select-tech', item.id)">
                <template #[`item.name`]="{ item }">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div class="caption text--secondary">{{ item.line }}</div>
                </template>
                <template #[`item.needs`]="{ item }">
                  <div v-for="need in item.needs" :key="need.id" class="need">
                    <v-icon x-small :color="statusColor(need.status)" class="mr-1">{{ icons[need.status] }}</v-icon>{{ need.name }}
                  </div>
                </template>
                <template #[`item.pathRp`]="{ item }">
                  <span v-if="item.pathRp === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.pathRpResult" /></span>
                  <span v-else class="text-no-wrap">{{ count(item.pathRp) }} RP<provenance-mark :result="item.pathRpResult" /></span>
                  <div class="caption text--secondary text-no-wrap">{{ item.steps }} {{ item.steps === 1 ? 'step' : 'steps' }}</div>
                </template>
              </v-data-table>
            </v-expansion-panel-content>
          </v-expansion-panel>

          <v-expansion-panel>
            <v-expansion-panel-header>
              <span class="panel-title">Researched <span class="panel-count">{{ group.done.length }}</span></span>
            </v-expansion-panel-header>
            <v-expansion-panel-content>
              <div v-if="!group.done.length" class="empty">Nothing researched in this field yet.</div>
              <v-data-table v-else :headers="doneHeaders" :items="doneRows" item-key="id" dense :custom-sort="sortNullLast" :sort-by.sync="doneTable.sortBy" :sort-desc.sync="doneTable.sortDesc" :items-per-page.sync="doneTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: DONE_PAGE_SIZES }" class="clickable" @click:row="(item) => $emit('select-tech', item.id)">
                <template #[`item.cost`]="{ item }">
                  <span v-if="item.cost === null" class="text--secondary text-no-wrap">—<provenance-mark status="unavailable" /></span>
                  <span v-else class="text-no-wrap">{{ count(item.cost) }} RP</span>
                </template>
              </v-data-table>
            </v-expansion-panel-content>
          </v-expansion-panel>

          <v-expansion-panel v-if="group.blocked.length">
            <v-expansion-panel-header>
              <span class="panel-title">Out of reach <span class="panel-count">{{ group.blocked.length }}</span></span>
            </v-expansion-panel-header>
            <v-expansion-panel-content>
              <div class="caption text--secondary mb-2">Techs this empire has no way to research: found only in ruins, owned by another empire, or behind a technology the game doesn't provide.</div>
              <v-data-table :headers="blockedHeaders" :items="blockedRows" item-key="id" dense :custom-sort="sortNullLast" :sort-by.sync="blockedTable.sortBy" :sort-desc.sync="blockedTable.sortDesc" :items-per-page.sync="blockedTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: TECH_PAGE_SIZES }" class="clickable" @click:row="(item) => $emit('select-tech', item.id)">
                <template #[`item.cost`]="{ item }">
                  <span v-if="item.cost === null" class="text--secondary text-no-wrap">—<provenance-mark status="unavailable" /></span>
                  <span v-else class="text-no-wrap">{{ count(item.cost) }} RP</span>
                </template>
              </v-data-table>
            </v-expansion-panel-content>
          </v-expansion-panel>
        </v-expansion-panels>
      </template>
    </v-col>
  </v-row>
</template>

<script>
import countFormat from '../../mixins/count-format'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { activeAppearance } from '../../utilities/appearance'
import { gameTime, toBoolean } from '../../utilities/aurora'
import { linkTo } from '../../utilities/deep-links'
import { isKnownNumber, UNKNOWN_TEXT } from '../../utilities/math'
import { sortNullLast } from '../../utilities/production'
import { isAvailable, unavailable } from '../../utilities/provenance'
import { ACTIVE, AVAILABLE, BLOCK_REASONS, BLOCKED, DONE, durationLabel, LOCKED, pathRpResult, projectIdle, QUEUED, remainingResult, STATUS_LABELS } from '../../utilities/research'
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'

import { STATUS_ICONS, statusColors } from './status-style'

const SECONDS_PER_YEAR = 31536000
const MATCH_LIMIT = 300
const MATCH_PAGE_SIZES = [25, 50, 100]
const TECH_PAGE_SIZES = [15, 30, -1]
const DONE_PAGE_SIZES = [25, 50, -1]
// Search results list what is happening first, what is finished last.
const STATUS_ORDER = [ACTIVE, QUEUED, AVAILABLE, LOCKED, DONE, BLOCKED]

export default {
  name: 'FieldsView',
  components: { PageLink, ProvenanceMark },
  mixins: [
    countFormat,
    persistedView({
      matchesTable: tableView('techTreeMatchesTable', { itemsPerPage: 25, itemsPerPageOptions: MATCH_PAGE_SIZES }),
      availableTable: tableView('techTreeAvailableTable', { sortBy: ['remaining'], itemsPerPage: 15, itemsPerPageOptions: TECH_PAGE_SIZES }),
      lockedTable: tableView('techTreeLockedTable', { sortBy: ['pathRp'], itemsPerPage: 15, itemsPerPageOptions: TECH_PAGE_SIZES }),
      doneTable: tableView('techTreeDoneTable', { sortBy: ['line'], itemsPerPage: 25, itemsPerPageOptions: DONE_PAGE_SIZES }),
      blockedTable: tableView('techTreeBlockedTable', { itemsPerPage: 15, itemsPerPageOptions: TECH_PAGE_SIZES }),
    }),
  ],
  props: {
    research: { type: Object, required: true },
    fieldId: { type: Number, default: null },
    search: { type: String, default: '' },
  },
  data() {
    return {
      MATCH_LIMIT,
      MATCH_PAGE_SIZES,
      TECH_PAGE_SIZES,
      DONE_PAGE_SIZES,
      icons: STATUS_ICONS,
      labels: STATUS_LABELS,
      open: [0, 1],
      sortNullLast,
    }
  },
  computed: {
    colors() {
      return statusColors(activeAppearance())
    },

    field() {
      return this.research.fields.find((field) => field.ResearchFieldID === this.fieldId) || null
    },

    group() {
      return this.research.groups.get(this.fieldId) || { [DONE]: [], [ACTIVE]: [], [QUEUED]: [], [AVAILABLE]: [], [LOCKED]: [], [BLOCKED]: [] }
    },

    fieldSummary() {
      const { done, available, active, queued } = this.countsOf(this.field)

      return `${this.count(done)} researched, ${this.count(available)} available, ${this.count(active)} running, ${this.count(queued)} queued`
    },

    projects() {
      return this.research.schedule.filter((project) => project.FieldID === this.fieldId).sort((a, b) => (a.years === null) - (b.years === null) || a.years - b.years).map((project) => ({ ...project, landing: this.landingOf(project, project), queue: project.queue.map((entry) => ({ ...entry, landing: this.landingOf(entry, project) })) }))
    },

    scientistNote() {
      const free = this.research.scientists.byField[this.fieldId]

      if (!free) {
        return 'No free scientist specialises in this field; any free scientist can run a project at their plain Research bonus.'
      }

      const { best } = free
      const lead = `${this.count(free.count)} free ${free.count === 1 ? 'scientist specialises' : 'scientists specialise'} in this field.`

      if (!isKnownNumber(best.ResearchBonus)) {
        return `${lead} ${free.count === 1 ? 'It has no' : 'None has a'} Research bonus on record, so the best cannot be told.`
      }

      const labs = isKnownNumber(best.MaxLabs) ? `can run ${this.count(best.MaxLabs)} labs` : 'has no lab limit on record'
      const gap = free.unknown ? ` ${this.count(free.unknown)} ${free.unknown === 1 ? 'scientist has' : 'scientists have'} no Research bonus on record and ${free.unknown === 1 ? 'is' : 'are'} not ranked.` : ''

      return `${lead} The best, ${best.Name}, adds ${this.count((best.ResearchBonus - 1) * 100)}% (${this.count((4 * best.ResearchBonus - 3 - 1) * 100)}% on a project here) and ${labs}.${gap}`
    },

    availableRows() {
      return this.group.available.map((tech) => this.row(tech))
    },

    lockedRows() {
      return this.group.locked.map((tech) => {
        const { info, graph, state } = this.research
        const entry = info.get(tech.id)

        return {
          ...this.row(tech),
          needs: tech.prerequisites.filter((id) => !state.researched.has(id)).map((id) => ({ id, name: graph.techs.get(id).name, status: info.get(id).status })),
          pathRp: entry.pathRp,
          steps: entry.missing.length + 1,
        }
      })
    },

    doneRows() {
      return this.group.done.map((tech) => this.row(tech))
    },

    blockedRows() {
      return this.group.blocked.map((tech) => ({ ...this.row(tech), reason: BLOCK_REASONS[this.research.info.get(tech.id).reason] }))
    },

    matches() {
      const needle = this.search.trim().toLowerCase()

      if (!needle) {
        return []
      }

      const rows = []

      this.research.graph.techs.forEach((tech) => {
        if (this.research.shown.has(tech.fieldId) && (tech.name.toLowerCase().includes(needle) || tech.typeName.toLowerCase().includes(needle))) {
          const status = this.research.info.get(tech.id).status

          rows.push({ ...this.row(tech), status, statusRank: STATUS_ORDER.indexOf(status), field: this.fieldAbbreviation(tech.fieldId) })
        }
      })

      return rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name))
    },

    matchHeaders() {
      return [
        { text: 'Status', value: 'status', sort: (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b) },
        { text: 'Technology', value: 'name' },
        { text: 'Field', value: 'field' },
        { text: 'RP left', value: 'remaining', align: 'end' },
      ]
    },
    availableHeaders() {
      return [
        { text: 'Technology', value: 'name' },
        { text: 'RP to research', value: 'remaining', align: 'end' },
        { text: 'Opens', value: 'unlocks', align: 'end' },
      ]
    },
    lockedHeaders() {
      return [
        { text: 'Technology', value: 'name' },
        { text: 'Waiting on', value: 'needs', sortable: false },
        { text: 'RP to get there', value: 'pathRp', align: 'end' },
      ]
    },
    doneHeaders() {
      return [
        { text: 'Technology', value: 'name' },
        { text: 'Line', value: 'line' },
        { text: 'Cost', value: 'cost', align: 'end' },
      ]
    },
    blockedHeaders() {
      return [
        { text: 'Technology', value: 'name' },
        { text: 'Why', value: 'reason' },
        { text: 'Cost', value: 'cost', align: 'end' },
      ]
    },
  },
  methods: {
    statusColor(status) {
      return this.colors[status]
    },

    countsOf(field) {
      return this.research.fieldCounts.get(field.ResearchFieldID)
    },
    reachable(field) {
      const counts = this.countsOf(field)

      return counts.done + counts.active + counts.queued + counts.available + counts.locked
    },
    share(part, whole) {
      return whole > 0 ? Math.min(100, (part / whole) * 100) : 0
    },
    // The share of a project paid; none while its RP left or its cost is not known.
    progress(project) {
      return isKnownNumber(project.ResearchPointsRequired) && isKnownNumber(project.DevelopCost) ? this.share(project.DevelopCost - project.ResearchPointsRequired, project.DevelopCost) : 0
    },

    // What a project's RP left lacks, as an unavailable result; null when it is known.
    leftResult(project) {
      const missing = [...(isKnownNumber(project.ResearchPointsRequired) ? [] : [`RP left on ${project.Name}`]), ...(isKnownNumber(project.DevelopCost) ? [] : [`development cost of ${project.Name}`])]

      return missing.length ? unavailable({ rule: 'research.remaining', missing }) : null
    },

    // Search results sort by what is happening first (`statusRank`), and a figure the save lacks last.
    sortMatches(items, sortBy, sortDesc) {
      return sortNullLast(items, sortBy.map((key) => (key === 'status' ? 'statusRank' : key)), sortDesc)
    },

    fieldAbbreviation(fieldId) {
      return (this.research.fields.find((field) => field.ResearchFieldID === fieldId) || {}).Abbreviation || ''
    },

    row(tech) {
      const { info, state } = this.research
      const entry = info.get(tech.id)

      return {
        id: tech.id,
        name: tech.name,
        line: tech.typeName,
        cost: tech.cost,
        remaining: entry.remaining,
        remainingResult: remainingResult(entry),
        pathRpResult: pathRpResult(entry),
        banked: state.paused.has(tech.id) ? state.paused.get(tech.id) : 0,
        unlocks: entry.unlocks,
        automatic: tech.automatic,
      }
    },

    colonyLink(populationId) {
      return linkTo.colonyOutlook(populationId)
    },

    commanderLink(commanderId) {
      return linkTo.commanders({ commander: commanderId })
    },

    scientistLabel(project) {
      if (!project.CommanderID) {
        return 'no scientist'
      }

      const specialised = project.ScientistField === project.FieldID

      if (!isKnownNumber(project.ResearchBonus)) {
        return `${project.ScientistName} (bonus not known)`
      }

      return `${project.ScientistName} (${specialised ? `${this.count((4 * project.ResearchBonus - 3 - 1) * 100)}% in field` : `${this.count((project.ResearchBonus - 1) * 100)}%, off field`})`
    },

    pausedLabel(project) {
      if (project.Pause === null || project.Pause === undefined) {
        return 'Pause not stored'
      } else if (toBoolean(project.Pause)) {
        return 'Paused'
      } else if (!project.CommanderID) {
        return 'No scientist'
      }

      return isAvailable(project.rateResult) ? 'No labs' : 'Rate not known'
    },

    // What a stopped project's label rests on when the save does not give it: the pause flag, or the rate of a project with a scientist.
    pausedResult(project) {
      if (project.Pause === null || project.Pause === undefined) {
        return project.yearsResult
      }

      return !toBoolean(project.Pause) && project.CommanderID && !isAvailable(project.rateResult) ? project.rateResult : null
    },

    // The landing date of a project or of an entry queued behind it, as { text, result }: a project that makes no progress for a reason the save states never lands, one whose pause flag, rate or RP left is not stored has no date (result names what is missing), and so has any when the game clock is not stored.
    landingOf(entry, project) {
      const { StartYear, GameTime } = this.research.game

      if (isKnownNumber(entry.years)) {
        const clock = [...(isKnownNumber(StartYear) ? [] : ['the game start year']), ...(isKnownNumber(GameTime) ? [] : ['the game time'])]

        return clock.length ? { text: UNKNOWN_TEXT, result: unavailable({ rule: 'research.landing', missing: clock }) } : { text: gameTime(StartYear, GameTime + entry.years * SECONDS_PER_YEAR).format('YYYY-MM-DD'), result: null }
      }

      return projectIdle(project) ? { text: 'Not progressing', result: null } : { text: UNKNOWN_TEXT, result: entry.yearsResult }
    },

    duration: durationLabel,
  },
}
</script>

<style lang="scss">
.fields-view {
  .rail {
    overflow: hidden;
  }

  .rail-item {
    display: block;
    width: 100%;
    padding: 10px 16px 12px;
    text-align: left;
    border-left: 3px solid transparent;
    cursor: pointer;
    color: inherit;

    &:hover {
      background: var(--sc-tint);
    }

    &.selected {
      background: var(--sc-soft);
      border-left-color: var(--sc);
    }

    &:focus-visible {
      outline: 2px solid var(--sc);
      outline-offset: -2px;
    }
  }

  .rail-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 14px;
    font-weight: 500;
  }

  .rail-name {
    flex: 1;
    min-width: 0;
  }

  .rail-now {
    font-size: 12px;
    font-weight: 400;
    color: var(--st-available);
  }

  .abbreviation {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--sc-soft);
  }

  .meter {
    display: flex;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
    overflow: hidden;
    margin-bottom: 2px;
  }

  .meter-fill {
    display: block;
    height: 100%;
  }

  .meter-done {
    background: var(--st-done);
  }

  .meter-active {
    background: var(--st-active);
  }

  .panels .v-expansion-panel-header {
    min-height: 48px;
  }

  .panel-title {
    font-size: 15px;
    font-weight: 500;
  }

  .panel-count {
    display: inline-block;
    margin-left: 6px;
    padding: 0 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 500;
    background: var(--sc-soft);
  }

  .empty {
    padding: 4px 0 8px;
    font-size: 14px;
    opacity: 0.7;
  }

  .project,
  .queued {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) minmax(110px, 1fr);
    gap: 4px 16px;
    align-items: center;
    padding: 8px 0;
  }

  .project + .project {
    border-top: 1px solid rgba(128, 128, 128, 0.2);
  }

  .queued {
    grid-column: 1 / -1;
    padding: 2px 0 2px 28px;
    margin-top: -6px;
    font-size: 13px;
  }

  .project-name {
    display: flex;
    align-items: center;
    min-width: 0;
    font-weight: 500;
  }

  .queued .project-name {
    font-weight: 400;
  }

  .project-progress {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .project-eta {
    text-align: right;
  }

  .tech-link {
    color: inherit;
    cursor: pointer;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  .status-chip {
    white-space: nowrap;
  }

  .need {
    font-size: 13px;
    white-space: nowrap;
  }

  .clickable tbody tr {
    cursor: pointer;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .panel {
    margin-top: 0;
    margin-bottom: 16px;
  }
}
</style>
