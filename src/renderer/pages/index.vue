<template>
  <div class="recap-container">
    <div v-if="!GameID">Select a game from the left-side menu.</div>

    <v-expansion-panels v-model="panels" multiple>
      <v-expansion-panel v-if="research.length">
        <v-expansion-panel-header class="font-weight-bold">Research</v-expansion-panel-header>

        <v-expansion-panel-content>
          <v-simple-table>
            <template #default>
              <thead>
                <tr>
                  <th class="text-left">Population</th>
                  <th class="text-left">Technology</th>
                  <th class="text-center">Assigned Facilities</th>
                  <th class="text-right">Remaining Research</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(researchItem, index) in research" :key="index">
                  <td>{{ researchItem.PopName }}</td>
                  <td>{{ researchItem.Name }}</td>
                  <td class="text-center">{{ researchItem.Facilities }}</td>
                  <td class="text-right">{{ researchItem.ResearchPointsRequired.toFixed(2) }} RP <span v-if="researchItem.Queue"><em>Queued</em></span></td>
                </tr>
              </tbody>
            </template>
          </v-simple-table>
        </v-expansion-panel-content>
      </v-expansion-panel>
    
      <v-expansion-panel v-if="ships.length">
        <v-expansion-panel-header class="font-weight-bold">Ships</v-expansion-panel-header>

        <v-expansion-panel-content>
          <v-simple-table>
            <template #default>
              <thead>
                <tr>
                  <th class="text-left">Population</th>
                  <th class="text-left">Class</th>
                  <th class="text-left">Unit Name</th>
                  <th class="text-right">Remaining Production</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(ship, index) in ships" :key="index">
                  <td class="text-left">{{ ship.PopName }}</td>
                  <td class="text-left">{{ ship.ClassName }}</td>
                  <td class="text-left">{{ ship.UnitName }}</td>
                  <td class="text-right">{{ ship.RemainingBP.toFixed(2) }} BP</td>
                </tr>
              </tbody>
            </template>
          </v-simple-table>
        </v-expansion-panel-content>
      </v-expansion-panel>
    
      <v-expansion-panel v-if="production.length">
        <v-expansion-panel-header class="font-weight-bold">Industrial Production</v-expansion-panel-header>

        <v-expansion-panel-content>
          <v-simple-table>
            <template #default>
              <thead>
                <tr>
                  <th class="text-left">Population</th>
                  <th class="text-left">Project</th>
                  <th class="text-right">Remaining Production</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(productionItem, index) in production" :key="index">
                  <td class="text-left">{{ productionItem.PopName }}</td>
                  <td class="text-left">{{ productionItem.Description }}</td>
                  <td class="text-right">
                    {{ productionItem.RemainingBP.toFixed(2) }} BP 
                    <span v-if="productionItem.Queue"><em>Queued</em></span>
                    <span v-else>at {{ productionItem.Percentage }}%</span>
                  </td>
                </tr>
              </tbody>
            </template>
          </v-simple-table>
        </v-expansion-panel-content>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

export default {
  components: {},
  data() {
    return {
      panels: [0, 1, 2],
    }
  },
  methods: {
    openURL(url) {
      remote.shell.openExternal(url)
    },
  },
  computed: {
    ...mapGetters(['GameID', 'database']),
  },
  asyncComputed: {
    research: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const queue = await this.database.query(`select FCT_Population.PopName, FCT_ResearchProject.Facilities, FCT_TechSystem.DevelopCost as ResearchPointsRequired, FCT_TechSystem.Name, 1 as Queue from FCT_ResearchQueue join FCT_Race on FCT_Race.RaceID = FCT_ResearchProject.RaceID and FCT_Race.GameID = FCT_ResearchProject.GameID and FCT_Race.NPR = 0 left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID left join FCT_ResearchProject on FCT_ResearchProject.ProjectID = FCT_ResearchQueue.CurrentProjectID left join FCT_TechSystem on FCT_ResearchQueue.TechSystemID = FCT_TechSystem.TechSystemID where FCT_Population.GameID = ${this.GameID} order by FCT_ResearchQueue.ResearchOrder asc`).then(([ items ]) => {
          console.log('Research queue', items)

          return items
        })

        const projects = await this.database.query(`select FCT_Population.PopName, FCT_ResearchProject.Facilities, FCT_ResearchProject.ResearchPointsRequired, FCT_TechSystem.Name, 0 as Queue from FCT_Population join FCT_ResearchProject on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID and FCT_Population.GameID = FCT_ResearchProject.GameID join FCT_Race on FCT_Race.RaceID = FCT_ResearchProject.RaceID and FCT_Race.GameID = FCT_ResearchProject.GameID and FCT_Race.NPR = 0 join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID where FCT_Population.GameID = ${this.GameID} order by FCT_ResearchProject.ResearchPointsRequired asc`).then(([ items ]) => {
          console.log('Research projects', items)

          return items
        })
      
        return [...projects, ...queue]
      },
      default: [],
    },
    ships: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopName, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingBP, FCT_ShipyardTask.UnitName, FCT_ShipClass.ClassName from FCT_Population join FCT_ShipyardTask on FCT_ShipyardTask.PopulationID = FCT_Population.PopulationID and FCT_ShipyardTask.GameID = FCT_Population.GameID join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID and FCT_ShipClass.GameID = FCT_ShipyardTask.GameID join FCT_Race on FCT_Race.RaceID = FCT_ShipyardTask.RaceID and FCT_Race.GameID = FCT_ShipyardTask.GameID and FCT_Race.NPR = 0 where FCT_Population.GameID = ${this.GameID} order by RemainingBP asc`).then(([ items ]) => {
          console.log('Ships', items)

          return items
        })
      },
      default: [],
    },
    production: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopName, FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Amount * FCT_IndustrialProjects.ProdPerUnit as RemainingBP, FCT_IndustrialProjects.Queue from FCT_Population join FCT_IndustrialProjects on FCT_IndustrialProjects.PopulationID = FCT_Population.PopulationID and FCT_IndustrialProjects.GameID = FCT_Population.GameID join FCT_Race on FCT_Race.RaceID = FCT_IndustrialProjects.RaceID and FCT_Race.GameID = FCT_IndustrialProjects.GameID and FCT_Race.NPR = 0 where FCT_Population.GameID = ${this.GameID} order by FCT_IndustrialProjects.Queue asc, RemainingBP asc`).then(([ items ]) => {
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
