<template>
  <div>
    <v-container fluid class="tech-page" :style="rootStyle">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="mr-4">
          <v-btn-toggle :value="shownView" mandatory dense @change="setView">
            <v-btn v-for="option in viewOptions" :key="option.value" :value="option.value" small>
              <v-icon left small>{{ option.icon }}</v-icon>{{ option.label }}
            </v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col v-if="shownView !== 'path'" cols="12" sm="auto" class="search-field">
          <v-text-field v-model="search" label="Search technologies" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" class="mt-3" @retry="retryFailedInputs" />

      <template v-if="research">
        <v-alert v-if="startPointsResult.value > 0" type="info" outlined dense class="mt-3">
          The race has {{ count(startPointsResult.value) }} starting tech points left. The game's Research tab can spend them on techs instantly.<provenance-mark :result="startPointsResult" />
        </v-alert>
        <v-alert v-else-if="!startPointsKnown" type="warning" outlined dense class="mt-3">
          The starting tech points left are not stored, so whether any can be spent is unknown.<provenance-mark :result="startPointsResult" />
        </v-alert>

        <stat-tiles :tiles="tiles" class="mt-2" />

        <div class="mt-4">
          <fields-view v-if="shownView === 'fields'" :research="research" :field-id="activeFieldId" :search="search || ''" @select-field="(id) => (fieldId = id)" @select-tech="selectTech" />
          <lines-view v-else-if="shownView === 'lines'" :research="research" :search="search || ''" :hide-finished="hideFinished" @set-hide-finished="(value) => (hideFinished = value)" @select-tech="selectTech" />
          <path-view v-else :research="research" :target-id="activeTargetId" @select-tech="selectTech" />
        </div>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { sectionStyle } from '../components/navigation/section-style'
import LoadState from '../components/page/LoadState.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import FieldsView from '../components/research/FieldsView.vue'
import LinesView from '../components/research/LinesView.vue'
import PathView from '../components/research/PathView.vue'
import { statusStyle } from '../components/research/status-style'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { gameTime, toBoolean } from '../utilities/aurora'
import { SERVING_COMMANDER } from '../utilities/commanders'
import { linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { isKnownNumber, UNKNOWN_TEXT } from '../utilities/math'
import { sectionById } from '../utilities/navigation'
import { describeResult, isAvailable } from '../utilities/provenance'
import { ACTIVE, AVAILABLE, availableResult, BLOCKED, buildLines, buildTechGraph, countStatuses, DONE, durationLabel, evaluateResearch, fieldBonuses, freeScientistsResult, groupTechs, labsResults, LOCKED, nextLandingResult, outputResult, QUEUED, researchedResults, researchState, scheduleProjects, startPointsResult } from '../utilities/research'

const INPUT_LABELS = {
  catalogue: 'the technologies',
  researched: 'the researched technologies',
  projects: 'the research projects',
  queue: 'the research queue',
  paused: 'the paused projects',
  labs: 'the research facilities',
  scientists: 'the scientists',
  constructs: 'the ancient constructs',
  game: 'the game clock',
  race: 'the race',
}
const SECONDS_PER_YEAR = 31536000

// The commander bonuses of the scientists' rows: Research (3) and Research Administration (27). One the save's lookup row does not confirm (`blockedBonuses`) is left unknown in every row, never read as no bonus.
const RESEARCH_BONUS = 3
const RESEARCH_ADMINISTRATION = 27

const gated = (rows, blocked) => (blocked.size ? rows.map((row) => ({ ...row, ResearchBonus: blocked.has(RESEARCH_BONUS) ? null : row.ResearchBonus, MaxLabs: blocked.has(RESEARCH_ADMINISTRATION) ? null : row.MaxLabs })) : rows)
// The views a visit leaves behind; the path view opens on a tech and is never the remembered one.
const STORED_VIEWS = ['fields', 'lines']

export default {
  name: 'TechnologiesPage',
  components: { FieldsView, LinesView, LoadState, PathView, ProvenanceMark, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      view: { key: 'techTreeView', default: 'fields', scope: 'race', valid: oneOf(STORED_VIEWS) },
      fieldId: { key: 'techTreeField', default: null, scope: 'race' },
      targetId: { key: 'techTreeTarget', default: null, scope: 'race' },
      hideFinished: { key: 'techTreeHideFinished', default: true, scope: 'race' },
      search: { key: 'techTreeSearch', default: '', scope: 'race' },
    }),
  ],
  data() {
    return {
      viewOptions: [
        { value: 'fields', label: 'Fields', icon: 'mdi-view-list' },
        { value: 'lines', label: 'Lines', icon: 'mdi-stairs' },
        { value: 'path', label: 'Path', icon: 'mdi-graph-outline' },
      ],
      pathOpen: false,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),
    ...mapGetters('capabilities', ['blockedBonuses']),

    rootStyle() {
      const appearance = activeAppearance()

      return { ...sectionStyle(appearance, sectionById.research), ...statusStyle(appearance) }
    },

    startPointsResult() {
      return startPointsResult(this.race)
    },

    startPointsKnown() {
      return isAvailable(this.startPointsResult)
    },

    // Everything the views read, worked out once per read of the save.
    research() {
      if (!this.ready || !this.catalogue.fields.length || !this.game) {
        return null
      }

      const fields = this.catalogue.fields.filter((field) => !toBoolean(field.DoNotDisplay)).sort((a, b) => a.FieldName.localeCompare(b.FieldName))
      const shown = new Set(fields.map((field) => field.ResearchFieldID))
      const visible = (tech) => shown.has(tech.fieldId)
      const graph = buildTechGraph(this.catalogue.techs)
      const state = researchState({
        raceId: this.RaceID,
        researched: this.researched.map((row) => row.TechID),
        eligible: this.catalogue.eligible,
        projects: this.projects,
        queued: this.queue.map((row) => row.TechID),
        paused: this.paused,
      })
      const info = evaluateResearch(graph, state)
      const groups = groupTechs(graph, info, visible)
      const schedule = scheduleProjects(this.projects, this.queue, state.paused, fieldBonuses(this.constructs))
      const output = outputResult(schedule)

      return {
        graph,
        state,
        info,
        fields,
        shown,
        groups,
        counts: countStatuses(graph, info, visible),
        fieldCounts: new Map(fields.map((field) => [field.ResearchFieldID, this.countGroup(groups.get(field.ResearchFieldID))])),
        lines: buildLines(graph, info, visible),
        schedule,
        output,
        // The Path view's "every lab on it" rate: the whole output, so none while a running project's rate is unknown (a short sum would read as a rate it is not).
        totalRate: isAvailable(output.result) && !output.unknown ? output.result.value : null,
        scientists: this.summariseScientists(),
        game: this.game,
      }
    },

    // The view on show: the path view while a tech is open, else the remembered one.
    shownView() {
      return this.pathOpen ? 'path' : this.view
    },

    activeFieldId() {
      const { fields, fieldCounts } = this.research

      if (fields.some((field) => field.ResearchFieldID === this.fieldId)) {
        return this.fieldId
      }

      // Nothing remembered: open the field with the most to start.
      return fields.slice().sort((a, b) => fieldCounts.get(b.ResearchFieldID)[AVAILABLE] - fieldCounts.get(a.ResearchFieldID)[AVAILABLE])[0].ResearchFieldID
    },

    nextLanding() {
      return nextLandingResult(this.research.schedule, this.game)
    },

    nextToLand() {
      return this.nextLanding.project
    },

    activeTargetId() {
      const { graph, groups, fields } = this.research

      if (graph.techs.has(this.targetId)) {
        return this.targetId
      }

      if (this.nextToLand && graph.techs.has(this.nextToLand.TechID)) {
        return this.nextToLand.TechID
      }

      const first = fields.map((field) => (groups.get(field.ResearchFieldID) || {})[AVAILABLE]).find((techs) => techs && techs.length)

      return first ? first[0].id : null
    },

    // What is on show: the Fields view's field, the Lines view, or the Path view's target. Null while the field or target is still being worked out.
    linkQuery() {
      if (this.shownView === 'lines') {
        return linkTo.techTree({ view: 'lines' }).query
      }

      if (this.shownView === 'fields') {
        if (this.research) {
          return linkTo.techTree({ field: this.activeFieldId }).query
        }

        return this.fieldId ? linkTo.techTree({ field: this.fieldId }).query : null
      }

      if (this.research) {
        return linkTo.techTree({ tech: this.activeTargetId }).query
      }

      return this.targetId ? linkTo.techTree({ tech: this.targetId }).query : null
    },

    // The history menus and the trail name the field, the Lines view or the technology on show.
    linkLabel() {
      if (this.shownView === 'lines') {
        return 'Lines'
      }

      if (!this.research) {
        return null
      }

      if (this.shownView === 'fields') {
        const field = this.research.fields.find((row) => row.ResearchFieldID === this.activeFieldId)

        return field ? field.FieldName : null
      }

      const tech = this.research.graph.techs.get(this.activeTargetId)

      return tech ? tech.name : null
    },

    tiles() {
      const { counts, schedule, scientists, output } = this.research
      const tile = (fields, ...results) => ({ ...fields, result: results[0], title: results.map(describeResult).join('. ') })
      const done = researchedResults(counts)
      const labs = labsResults(this.labs, schedule)
      const next = this.nextLanding
      const plural = (number, one, many) => (number === 1 ? one : many)
      const share = isAvailable(done.share) ? `${this.count(done.share.value * 100)}%` : 'No share'
      const busy = isAvailable(labs.assigned) ? this.count(labs.assigned.value) : UNKNOWN_TEXT
      const built = isAvailable(labs.built) ? this.count(labs.built.value) : UNKNOWN_TEXT
      const idle = isAvailable(labs.idle) ? labs.idle.value : null
      const unrated = output.unknown ? `, ${this.count(output.unknown)} of them with no rate known` : ''
      const idleText = idle ? `, ${this.count(idle)} idle` : ''
      const overText = labs.over ? `, ${this.count(labs.over)} assigned beyond those built` : ''
      const landing = next.project && isAvailable(next.result) ? `${this.landing(next.project.years)}, in ${durationLabel(next.project.years, this.separator)}` : ''
      const nothing = next.unknown ? `${this.count(next.unknown)} ${plural(next.unknown, 'project has', 'projects have')} no landing time${next.causes.length ? `, missing ${next.causes.join(', ')}` : ''}` : schedule.length ? 'Every project is paused or has no scientist or rate' : 'No research project is under way'

      return [
        tile({ label: 'Researched', value: `${this.count(done.done.value)} of ${this.count(done.reachable.value)}`, note: `${share}${isAvailable(done.share) ? ' of what the race can research' : ': nothing is reachable to measure against'}${counts[BLOCKED] ? `, ${this.count(counts[BLOCKED])} more out of reach` : ''}`, icon: 'mdi-check-circle', iconColor: 'primary' }, done.done, done.share),
        tile({ label: 'Research output', value: isAvailable(output.result) ? `${this.count(output.result.value)} RP a year` : '—', note: `${this.count(output.projects)} ${plural(output.projects, 'project', 'projects')}${unrated}, ${busy} of ${built} labs busy${idleText}${overText}`, icon: idle ? 'mdi-alert' : null, iconColor: 'warning' }, output.result, labs.assigned, labs.built, labs.idle),
        next.project ? tile({ label: 'Next to land', value: next.project.Name, note: isAvailable(next.result) ? `${landing}${next.unknown ? `; ${this.count(next.unknown)} ${plural(next.unknown, 'project', 'projects')} with no landing time could land first` : ''}` : `Landing date unavailable: ${next.result.inputs.missing.join(', ')}` }, next.result) : tile({ label: 'Next to land', value: next.unknown ? '—' : 'Nothing running', note: nothing }, next.result),
        tile({ label: 'Available now', value: `${this.count(availableResult(counts).value)} ${plural(counts[AVAILABLE], 'technology', 'technologies')}`, note: `${this.count(freeScientistsResult(this.scientists).value)} free ${plural(scientists.total, 'scientist', 'scientists')} to run them` }, availableResult(counts), freeScientistsResult(this.scientists)),
      ]
    },
  },
  watch: {
    RaceID() {
      this.pathOpen = false
    },
  },
  methods: {
    // A tech in the query opens its path, a field the Fields view on that field, and `view=lines` the Lines view; without any the page shows the view it remembers. A field or view from Back or Forward is remembered as if picked, a linked tech only for the visit.
    applyLink(query) {
      const techId = queryId(query.tech)
      const fieldId = queryId(query.field)

      if (techId) {
        this.setUnsaved('targetId', techId)
      } else if (fieldId) {
        this.view = 'fields'
        this.fieldId = fieldId
      } else if ([].concat(query.view)[0] === 'lines') {
        this.view = 'lines'
      }

      this.pathOpen = !!techId
    },
    setView(view) {
      this.pathOpen = view === 'path'

      if (view !== 'path') {
        this.view = view
      }
    },
    // Looking at a tech anywhere opens its path.
    selectTech(techId) {
      this.targetId = techId
      this.pathOpen = true
    },

    landing(years) {
      return isKnownNumber(this.game.StartYear) && isKnownNumber(this.game.GameTime) ? gameTime(this.game.StartYear, this.game.GameTime + years * SECONDS_PER_YEAR).format('YYYY-MM-DD') : UNKNOWN_TEXT
    },

    countGroup(group) {
      const counts = { [DONE]: 0, [ACTIVE]: 0, [QUEUED]: 0, [AVAILABLE]: 0, [LOCKED]: 0, [BLOCKED]: 0 }

      if (group) {
        Object.keys(counts).forEach((status) => (counts[status] = group[status].length))
      }

      return counts
    },

    // Free scientists, and per specialisation how many there are, the best of them among those with a Research bonus on record, and how many have none on record.
    summariseScientists() {
      const byField = {}

      this.scientists.forEach((scientist) => {
        const entry = (byField[scientist.ResSpecID] = byField[scientist.ResSpecID] || { count: 0, unknown: 0, best: scientist })

        entry.count += 1

        if (!isKnownNumber(scientist.ResearchBonus)) {
          entry.unknown += 1
        } else if (!isKnownNumber(entry.best.ResearchBonus) || scientist.ResearchBonus > entry.best.ResearchBonus) {
          entry.best = scientist
        }
      })

      return { total: this.scientists.length, byField }
    },
  },
  asyncComputed: {
    catalogue: {
      get: tracked('catalogue', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { fields: [], techs: [], eligible: [] }
        }

        const [fields] = await this.database.query('select DIM_ResearchField.ResearchFieldID, DIM_ResearchField.FieldName, DIM_ResearchField.Abbreviation, DIM_ResearchField.DoNotDisplay from DIM_ResearchField')
        const eligible = await this.database.query(`select FCT_EligibleProjects.TechSystemID from FCT_EligibleProjects where FCT_EligibleProjects.GameID = ${this.GameID} and FCT_EligibleProjects.RaceID = ${this.RaceID}`).then(([rows]) => rows.map((row) => row.TechSystemID))
        const [techs] = await this.database.query(`select FCT_TechSystem.TechSystemID, FCT_TechSystem.Name, FCT_TechSystem.TechDescription, FCT_TechSystem.DevelopCost, FCT_TechSystem.RaceID, FCT_TechSystem.Prerequisite1, FCT_TechSystem.Prerequisite2, FCT_TechSystem.RuinOnly, FCT_TechSystem.AutomaticResearch, FCT_TechSystem.StartingSystem, FCT_TechSystem.ConventionalSystem, FCT_TechSystem.TechTypeID, DIM_TechType.Description as TypeName, DIM_TechType.FieldID from FCT_TechSystem inner join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_TechSystem.GameID = 0${eligible.length ? ` or FCT_TechSystem.TechSystemID in (${eligible.join(', ')})` : ''}`)

        return Object.freeze({ fields, techs: Object.freeze(techs), eligible })
      }),
      default: { fields: [], techs: [], eligible: [] },
    },

    researched: {
      get: tracked('researched', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_RaceTech.TechID from FCT_RaceTech where FCT_RaceTech.GameID = ${this.GameID} and FCT_RaceTech.RaceID = ${this.RaceID}`)

        return Object.freeze(rows)
      }),
      default: [],
    },

    // Each running project with its colony, scientist and the labs' output; RP a year follows from them.
    projects: {
      get: tracked('projects', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_ResearchProject.ProjectID, FCT_ResearchProject.PopulationID, FCT_ResearchProject.TechID, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResSpecID as FieldID, FCT_ResearchProject.ResearchPointsRequired, FCT_ResearchProject.Pause, FCT_ResearchProject.AssignNew, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost, FCT_Population.PopName, FCT_Commander.CommanderID, FCT_Commander.Name as ScientistName, FCT_Commander.ResSpecID as ScientistField, case when JOI_Research.CommanderID is null then 1 else JOI_Research.BonusValue end as ResearchBonus, case when JOI_Admin.CommanderID is null then 0 else JOI_Admin.BonusValue end as MaxLabs, FCT_Species.ResearchRateModifier * FCT_Race.Research * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * (1 - FCT_SystemBody.RadiationLevel / 10000.0) * (1 - FCT_Population.UnrestPoints / 100.0) * DIM_PopPoliticalStatus.ProductionMod * (FCT_Game.ResearchSpeed / 100.0) as OutputPerLab, FCT_AncientConstruct.ResearchField as LocalConstructField, FCT_AncientConstruct.ResearchBonus as LocalConstructBonus from FCT_ResearchProject
          inner join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID
          inner join FCT_Race on FCT_Race.RaceID = FCT_ResearchProject.RaceID
          inner join FCT_Game on FCT_Game.GameID = FCT_ResearchProject.GameID
          inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID
          inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
          left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID
          left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus
          left join FCT_AncientConstruct on FCT_AncientConstruct.SystemBodyID = FCT_Population.SystemBodyID and FCT_AncientConstruct.GameID = FCT_ResearchProject.GameID and FCT_AncientConstruct.Active = 1
          left join FCT_Commander on FCT_Commander.GameID = FCT_ResearchProject.GameID and FCT_Commander.RaceID = FCT_ResearchProject.RaceID and FCT_Commander.CommandType = 7 and FCT_Commander.CommandID = FCT_ResearchProject.ProjectID and FCT_Commander.Deceased = 0
          left join FCT_CommanderBonuses as JOI_Research on JOI_Research.CommanderID = FCT_Commander.CommanderID and JOI_Research.BonusID = 3
          left join FCT_CommanderBonuses as JOI_Admin on JOI_Admin.CommanderID = FCT_Commander.CommanderID and JOI_Admin.BonusID = 27
          where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`)

        return gated(rows, blocked)
      }),
      default: [],
    },

    // A queue belongs to a running project (CurrentProjectID); the race comes through its colony.
    queue: {
      get: tracked('queue', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_ResearchQueue.CurrentProjectID, FCT_ResearchQueue.ResearchOrder, FCT_ResearchQueue.PopulationID, FCT_ResearchQueue.TechSystemID as TechID, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost, DIM_TechType.FieldID from FCT_ResearchQueue
          inner join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID and FCT_Population.RaceID = ${this.RaceID}
          left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchQueue.TechSystemID
          left join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID
          where FCT_ResearchQueue.GameID = ${this.GameID}`)

        return rows
      }),
      default: [],
    },

    paused: {
      get: tracked('paused', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_PausedResearch.TechSystemID, FCT_PausedResearch.PointsAccumulated from FCT_PausedResearch where FCT_PausedResearch.GameID = ${this.GameID} and FCT_PausedResearch.RaceID = ${this.RaceID}`)

        return rows
      }),
      default: [],
    },

    labs: {
      get: tracked('labs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_Population.PopulationID, case when count(FCT_PopulationInstallations.Amount) = count(*) then sum(FCT_PopulationInstallations.Amount) end as Labs from FCT_PopulationInstallations
          inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID and DIM_PlanetaryInstallation.ResearchValue > 0
          inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID
          where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}
          group by FCT_Population.PopulationID`)

        return rows
      }),
      default: [],
    },

    // The race's scientists with no project: who could start something.
    scientists: {
      get: tracked('scientists', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.ResSpecID, case when JOI_Research.CommanderID is null then 1 else JOI_Research.BonusValue end as ResearchBonus, case when JOI_Admin.CommanderID is null then 0 else JOI_Admin.BonusValue end as MaxLabs from FCT_Commander
          left join FCT_CommanderBonuses as JOI_Research on JOI_Research.CommanderID = FCT_Commander.CommanderID and JOI_Research.BonusID = 3
          left join FCT_CommanderBonuses as JOI_Admin on JOI_Admin.CommanderID = FCT_Commander.CommanderID and JOI_Admin.BonusID = 27
          where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommanderType = 3 and FCT_Commander.CommandType = 0 and ${SERVING_COMMANDER}`)

        return Object.freeze(gated(rows, blocked))
      }),
      default: [],
    },

    // One row per populated colony of the race on an active ancient construct, as the game counts them.
    constructs: {
      get: tracked('constructs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_AncientConstruct.ResearchField as FieldID, FCT_AncientConstruct.ResearchBonus from FCT_AncientConstruct
          inner join FCT_Population on FCT_Population.SystemBodyID = FCT_AncientConstruct.SystemBodyID
          where FCT_AncientConstruct.GameID = ${this.GameID} and FCT_AncientConstruct.Active = 1 and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Population >= 1`)

        return rows
      }),
      default: [],
    },

    game: {
      get: tracked('game', async function () {
        if (!this.database || !this.GameID) {
          return null
        }

        const [rows] = await this.database.query(`select FCT_Game.StartYear, FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${this.GameID}`)

        return rows[0] || { StartYear: null, GameTime: null }
      }),
      default: null,
    },

    race: {
      get: tracked('race', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        const [rows] = await this.database.query(`select FCT_Race.StartTechPoints from FCT_Race where FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}`)

        return rows[0] || null
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.tech-page {
  .search-field {
    min-width: 260px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
