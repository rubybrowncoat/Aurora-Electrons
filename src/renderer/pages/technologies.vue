<template>
  <div>
    <v-container fluid class="tech-page" :style="rootStyle">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="mr-4">
          <v-btn-toggle :value="view" mandatory dense @change="setView">
            <v-btn v-for="option in viewOptions" :key="option.value" :value="option.value" small>
              <v-icon left small>{{ option.icon }}</v-icon>{{ option.label }}
            </v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col v-if="view !== 'path'" cols="12" sm="auto" class="search-field">
          <v-text-field v-model="search" label="Search technologies" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
        </v-col>
      </v-row>

      <v-alert v-if="failedInputs.length" type="error" outlined dense class="mt-3">
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate class="mt-3" />

      <template v-if="research">
        <v-alert v-if="startPoints > 0" type="info" outlined dense class="mt-3">
          This empire has {{ count(startPoints) }} starting tech points left. The game's Research tab can spend them on techs instantly.
        </v-alert>

        <v-row class="mt-2">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value" :title="tile.value">
                <v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon>{{ tile.value }}
              </div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <div class="mt-4">
          <fields-view v-if="view === 'fields'" :research="research" :field-id="activeFieldId" :search="search || ''" @select-field="setField" @select-tech="selectTech" />
          <lines-view v-else-if="view === 'lines'" :research="research" :search="search || ''" :hide-finished="hideFinished" @set-hide-finished="setHideFinished" @select-tech="selectTech" />
          <path-view v-else :research="research" :target-id="activeTargetId" @select-tech="selectTech" />
        </div>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { sectionStyle } from '../components/navigation/section-style'
import FieldsView from '../components/research/FieldsView.vue'
import LinesView from '../components/research/LinesView.vue'
import PathView from '../components/research/PathView.vue'
import { statusStyle } from '../components/research/status-style'
import countFormat from '../mixins/count-format'
import { gameTime, toBoolean } from '../utilities/aurora'
import { SERVING_COMMANDER } from '../utilities/commanders'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { sectionById } from '../utilities/navigation'
import { ACTIVE, AVAILABLE, BLOCKED, buildLines, buildTechGraph, countStatuses, DONE, durationLabel, evaluateResearch, fieldBonuses, groupTechs, LOCKED, QUEUED, researchState, scheduleProjects } from '../utilities/research'

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
const INPUTS = Object.keys(INPUT_LABELS)
const SECONDS_PER_YEAR = 31536000
const VIEWS = ['fields', 'lines', 'path']

export default {
  name: 'TechnologiesPage',
  components: { FieldsView, LinesView, PathView },
  mixins: [countFormat],
  data() {
    return {
      viewOptions: [
        { value: 'fields', label: 'Fields', icon: 'mdi-view-list' },
        { value: 'lines', label: 'Lines', icon: 'mdi-stairs' },
        { value: 'path', label: 'Path', icon: 'mdi-graph-outline' },
      ],
      view: 'fields',
      fieldId: null,
      targetId: null,
      hideFinished: true,
      search: '',
      loadErrors: {},
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    preferencePrefix() {
      return `game.${this.GameID}.race.${this.RaceID}.techTree`
    },

    rootStyle() {
      const dark = this.$vuetify.theme.dark

      return { ...sectionStyle(dark, sectionById.research), ...statusStyle(dark) }
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

    startPoints() {
      return this.race ? this.race.StartTechPoints : 0
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
        totalRate: schedule.reduce((sum, project) => sum + (project.running ? project.rate : 0), 0),
        scientists: this.summariseScientists(),
        game: this.game,
      }
    },

    activeFieldId() {
      const { fields, fieldCounts } = this.research

      if (fields.some((field) => field.ResearchFieldID === this.fieldId)) {
        return this.fieldId
      }

      // Nothing remembered: open the field with the most to start.
      return fields.slice().sort((a, b) => fieldCounts.get(b.ResearchFieldID)[AVAILABLE] - fieldCounts.get(a.ResearchFieldID)[AVAILABLE])[0].ResearchFieldID
    },

    nextToLand() {
      const running = this.research.schedule.filter((project) => project.running)

      return running.length ? running.reduce((best, project) => (project.years < best.years ? project : best)) : null
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

    tiles() {
      const { counts, schedule, totalRate, scientists } = this.research
      const reachable = counts[DONE] + counts[ACTIVE] + counts[QUEUED] + counts[AVAILABLE] + counts[LOCKED]
      const labs = this.labs.reduce((sum, row) => sum + row.Labs, 0)
      const assigned = schedule.reduce((sum, project) => sum + project.Facilities, 0)
      const idle = Math.max(0, labs - assigned)
      const next = this.nextToLand
      const available = counts[AVAILABLE]

      return [
        {
          label: 'Researched',
          value: `${this.count(counts[DONE])} of ${this.count(reachable)}`,
          note: `${reachable ? this.count((counts[DONE] / reachable) * 100) : 0}% of what this empire can research${counts[BLOCKED] ? `, ${this.count(counts[BLOCKED])} more out of reach` : ''}`,
          icon: 'mdi-check-circle',
          iconColor: 'primary',
        },
        {
          label: 'Research output',
          value: `${this.count(totalRate)} RP a year`,
          note: `${this.count(schedule.length)} ${schedule.length === 1 ? 'project' : 'projects'}, ${this.count(assigned)} of ${this.count(labs)} labs busy${idle ? `, ${this.count(idle)} idle` : ''}`,
          icon: idle ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        next
          ? { label: 'Next to land', value: next.Name, note: `${this.landing(next.years)}, in ${durationLabel(next.years)}` }
          : { label: 'Next to land', value: 'Nothing running', note: schedule.length ? 'Every project is paused or has no scientist' : 'No research project is under way' },
        {
          label: 'Available now',
          value: `${this.count(available)} ${available === 1 ? 'technology' : 'technologies'}`,
          note: `${this.count(scientists.total)} free ${scientists.total === 1 ? 'scientist' : 'scientists'} to run them`,
        },
      ]
    },
  },
  watch: {
    preferencePrefix: {
      immediate: true,
      handler() {
        const view = this.config.get(`${this.preferencePrefix}View`, 'fields')

        this.view = VIEWS.includes(view) ? view : 'fields'
        this.fieldId = this.config.get(`${this.preferencePrefix}Field`, null)
        this.targetId = this.config.get(`${this.preferencePrefix}Target`, null)
        this.hideFinished = this.config.get(`${this.preferencePrefix}HideFinished`, true)
        this.search = ''
      },
    },
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    setView(view) {
      this.view = view
      this.config.set(`${this.preferencePrefix}View`, view)
    },
    setField(fieldId) {
      this.fieldId = fieldId
      this.config.set(`${this.preferencePrefix}Field`, fieldId)
    },
    setHideFinished(value) {
      this.hideFinished = value
      this.config.set(`${this.preferencePrefix}HideFinished`, value)
    },
    // Looking at a tech anywhere opens its path.
    selectTech(techId) {
      this.targetId = techId
      this.config.set(`${this.preferencePrefix}Target`, techId)
      this.setView('path')
    },

    landing(years) {
      return gameTime(this.game.StartYear, this.game.GameTime + years * SECONDS_PER_YEAR).format('YYYY-MM-DD')
    },

    countGroup(group) {
      const counts = { [DONE]: 0, [ACTIVE]: 0, [QUEUED]: 0, [AVAILABLE]: 0, [LOCKED]: 0, [BLOCKED]: 0 }

      if (group) {
        Object.keys(counts).forEach((status) => (counts[status] = group[status].length))
      }

      return counts
    },

    // Free scientists, and per specialisation how many there are and the best of them.
    summariseScientists() {
      const byField = {}

      this.scientists.forEach((scientist) => {
        const entry = (byField[scientist.ResSpecID] = byField[scientist.ResSpecID] || { count: 0, best: scientist })

        entry.count += 1

        if (scientist.ResearchBonus > entry.best.ResearchBonus) {
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
        // Saves from before 2.6 have no eligible-projects table.
        const eligible = await this.database.query(`select FCT_EligibleProjects.TechSystemID from FCT_EligibleProjects where FCT_EligibleProjects.GameID = ${this.GameID} and FCT_EligibleProjects.RaceID = ${this.RaceID}`).then(([rows]) => rows.map((row) => row.TechSystemID), () => [])
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
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_ResearchProject.ProjectID, FCT_ResearchProject.PopulationID, FCT_ResearchProject.TechID, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResSpecID as FieldID, FCT_ResearchProject.ResearchPointsRequired, FCT_ResearchProject.Pause, FCT_ResearchProject.AssignNew, FCT_TechSystem.Name, FCT_TechSystem.DevelopCost, FCT_Population.PopName, FCT_Commander.CommanderID, FCT_Commander.Name as ScientistName, FCT_Commander.ResSpecID as ScientistField, coalesce(JOI_Research.BonusValue, 1) as ResearchBonus, coalesce(JOI_Admin.BonusValue, 0) as MaxLabs, FCT_Species.ResearchRateModifier * FCT_Race.Research * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * (1 - FCT_SystemBody.RadiationLevel / 10000.0) * (1 - FCT_Population.UnrestPoints / 100.0) * DIM_PopPoliticalStatus.ProductionMod * (FCT_Game.ResearchSpeed / 100.0) as OutputPerLab, FCT_AncientConstruct.ResearchField as LocalConstructField, FCT_AncientConstruct.ResearchBonus as LocalConstructBonus from FCT_ResearchProject
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

        return rows
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

        const [rows] = await this.database.query(`select FCT_Population.PopulationID, sum(FCT_PopulationInstallations.Amount) as Labs from FCT_PopulationInstallations
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
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [rows] = await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.ResSpecID, coalesce(JOI_Research.BonusValue, 1) as ResearchBonus, coalesce(JOI_Admin.BonusValue, 0) as MaxLabs from FCT_Commander
          left join FCT_CommanderBonuses as JOI_Research on JOI_Research.CommanderID = FCT_Commander.CommanderID and JOI_Research.BonusID = 3
          left join FCT_CommanderBonuses as JOI_Admin on JOI_Admin.CommanderID = FCT_Commander.CommanderID and JOI_Admin.BonusID = 27
          where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommanderType = 3 and FCT_Commander.CommandType = 0 and ${SERVING_COMMANDER}`)

        return Object.freeze(rows)
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

        return rows[0] || { StartYear: 0, GameTime: 0 }
      }),
      default: null,
    },

    race: {
      get: tracked('race', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        const [rows] = await this.database.query(`select FCT_Race.StartTechPoints from FCT_Race where FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}`)

        return rows[0] || { StartTechPoints: 0 }
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

  .stat-tile {
    padding: 16px;
    height: 100%;
  }

  .stat-value {
    font-size: 24px;
    line-height: 32px;
    font-weight: 400;
    margin: 4px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
