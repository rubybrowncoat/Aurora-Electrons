<template>
  <div class="recap-container">
    <div class="title">Production Recap</div>

    <div v-if="!this.game">Select a game from the left-side menu.</div>

    <b-collapse animation="slide" aria-id="researchPanel" class="panel" v-show="research.length">
      <div slot="trigger" class="panel-heading" role="button" aria-controls="researchPanel">
        <strong>Research</strong>
      </div>

      <b-table :data="research" bordered striped narrowed hoverable>
        <template slot-scope="props">
          <b-table-column field="PopName" label="Population" width="150">{{ props.row.PopName }}</b-table-column>
          <b-table-column field="Name" label="Technology">{{ props.row.Name }}</b-table-column>
          <b-table-column field="Facilities" label="Assigned Facilities" numeric>{{ props.row.Facilities }}</b-table-column>
          <b-table-column field="ResearchPointsRequired" label="Remaining Research" width="200">{{ props.row.ResearchPointsRequired.toFixed(2) }} RP <span v-if="props.row.Queue"><em>Queued</em></span></b-table-column>
        </template>
      </b-table>
    </b-collapse>

    <b-collapse
      animation="slide"
      aria-id="researchPanel"
      class="panel"
      v-show="ships.length"
    >
      <div
        slot="trigger"
        class="panel-heading"
        role="button"
        aria-controls="researchPanel"
      >
        <strong>Ships</strong>
      </div>

      <b-table :data="ships" bordered striped narrowed hoverable>
        <template slot-scope="props">
          <b-table-column field="PopName" label="Population" width="150">{{
            props.row.PopName
          }}</b-table-column>
          <b-table-column field="ClassName" label="Class">{{
            props.row.ClassName
          }}</b-table-column>
          <b-table-column field="UnitName" label="Unit Name">{{
            props.row.UnitName
          }}</b-table-column>
          <b-table-column
            field="RemainingBP"
            label="Remaining Production"
            width="200"
            >{{ props.row.RemainingBP.toFixed(2) }} BP</b-table-column
          >
        </template>
      </b-table>
    </b-collapse>

    <b-collapse
      animation="slide"
      aria-id="researchPanel"
      class="panel"
      v-show="production.length"
    >
      <div
        slot="trigger"
        class="panel-heading"
        role="button"
        aria-controls="researchPanel"
      >
        <strong>Industrial Production</strong>
      </div>

      <b-table :data="production" bordered striped narrowed hoverable>
        <template slot-scope="props">
          <b-table-column field="PopName" label="Population" width="150">{{
            props.row.PopName
          }}</b-table-column>
          <b-table-column field="Description" label="Project">{{
            props.row.Description
          }}</b-table-column>
          <b-table-column
            field="RemainingBP"
            label="Remaining Production"
            width="200"
            v-if="!props.row.Queue"
            >{{ props.row.RemainingBP.toFixed(2) }} BP at
            {{ props.row.Percentage }}%</b-table-column
          >
          <b-table-column
            field="RemainingBP"
            label="Remaining Production"
            width="200"
            v-else
          >
            {{ props.row.RemainingBP.toFixed(2) }} BP
            <em>Queued</em>
          </b-table-column>
        </template>
      </b-table>
    </b-collapse>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

export default {
  components: {},
  data() {
    return {
      production: [],
    }
  },
  methods: {
    openURL(url) {
      remote.shell.openExternal(url)
    },
  },
  computed: {
    ...mapGetters(['game', 'database']),
  },
  asyncComputed: {
    research: {
      async get() {
        if (!this.database || !this.game) {
          return []
        }

        const queue = await this.database.query(`select FCT_Population.PopName, FCT_ResearchProject.Facilities, FCT_TechSystem.DevelopCost as ResearchPointsRequired, FCT_TechSystem.Name, 1 as Queue from FCT_ResearchQueue join FCT_Race on FCT_Race.RaceID = FCT_ResearchProject.RaceID and FCT_Race.GameID = FCT_ResearchProject.GameID and FCT_Race.NPR = 0 left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID left join FCT_ResearchProject on FCT_ResearchProject.ProjectID = FCT_ResearchQueue.CurrentProjectID left join FCT_TechSystem on FCT_ResearchQueue.TechSystemID = FCT_TechSystem.TechSystemID where FCT_Population.GameID = ${this.game} order by FCT_ResearchQueue.ResearchOrder asc`).then(([ items ]) => {
          console.log('Research queue', items)

          return items
        })

        const projects = await this.database.query(`select FCT_Population.PopName, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired, FCT_TechSystem.Name, 0 as Queue from FCT_Population join FCT_ResearchProject on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID and FCT_Population.GameID = FCT_ResearchProject.GameID join FCT_Race on FCT_Race.RaceID = FCT_ResearchProject.RaceID and FCT_Race.GameID = FCT_ResearchProject.GameID and FCT_Race.NPR = 0 join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID where FCT_Population.GameID = ${this.game} order by FCT_ResearchProject.ResearchPointsRequired asc`).then(([ items ]) => {
          console.log('Research projects', items)

          return items
        })
      
        return [...projects, ...queue]
      },
      default: [],
    },
    ships: {
      async get() {
        if (!this.database || !this.game) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopName, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingBP, FCT_ShipyardTask.UnitName, FCT_ShipClass.ClassName from FCT_Population join FCT_ShipyardTask on FCT_ShipyardTask.PopulationID = FCT_Population.PopulationID and FCT_ShipyardTask.GameID = FCT_Population.GameID join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID and FCT_ShipClass.GameID = FCT_ShipyardTask.GameID join FCT_Race on FCT_Race.RaceID = FCT_ShipyardTask.RaceID and FCT_Race.GameID = FCT_ShipyardTask.GameID and FCT_Race.NPR = 0 where FCT_Population.GameID = ${this.game} order by RemainingBP asc`).then(([ items ]) => {
          console.log('Ships', items)

          return items
        })
      },
      default: [],
    },
    production: {
      async get() {
        if (!this.database || !this.game) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopName, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount * FCT_IndustrialProjects.ProdPerUnit as RemainingBP, FCT_IndustrialProjects.Queue from FCT_Population join FCT_IndustrialProjects on FCT_IndustrialProjects.PopulationID = FCT_Population.PopulationID and FCT_IndustrialProjects.GameID = FCT_Population.GameID join FCT_Race on FCT_Race.RaceID = FCT_IndustrialProjects.RaceID and FCT_Race.GameID = FCT_IndustrialProjects.GameID and FCT_Race.NPR = 0 where FCT_Population.GameID = ${this.game} order by FCT_IndustrialProjects.Queue asc, RemainingBP asc`).then(([ items ]) => {
          console.log('Industrial Production', items)

          return items
        })
      },
      default: [],
    },
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>
.recap-container {
  //
}

.panel {
  margin-bottom: 20px;
}
</style>
