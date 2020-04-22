<template>
  <div>
    <div v-if="!GameID">Select a game from the left-side menu.</div>

    <div v-if="bodyGroups">
      <v-btn-toggle class="mb-3" v-model="materials" color="deep-purple accent-3" tile dense group multiple borderless>
        <v-btn v-for="(material, key) in MaterialMap" :key="key" small :value="material">{{ material }}</v-btn>
      </v-btn-toggle>

      <v-select v-model="systems" :items="systemNames" label="Active Systems" item-text="SystemName" item-value="SystemID" multiple>
        <template v-slot:prepend-item>
          <v-list-item
            ripple
            @click="toggleSystems"
          >
            <v-list-item-action>
              <v-icon :color="systems.length > 0 ? 'indigo darken-4' : ''">{{ systems.length > 0 
                ? systems.length == systemNames.length 
                  ? 'sentiment_very_satisfied'
                  : 'sentiment_satisfied'
                : 'sentiment_very_dissatisfied' }}</v-icon>
            </v-list-item-action>
            <v-list-item-content>
              <v-list-item-title>Select All</v-list-item-title>
            </v-list-item-content>
          </v-list-item>
          <v-divider class="mt-2"></v-divider>
        </template>
      </v-select>

      <v-data-table class="elevation-2" :headers="headers" :items="Object.values(bodyGroups)">
        <template v-for="material in materials" v-slot:[`item.${material}`]="{ item }">
          <span :class="{
            'green--text text--lighten-1 font-weight-bold': item[material].Accessibility > 0.7,
            'red--text text--darken-3 font-weight-bold': item[material].Accessibility <= 0.2,
            'orange--text text--accent-3': item[material].Accessibility <= 0.4 && item[material].Accessibility > 0.2,
          }" :key="material" v-if="item[material]">{{ item[material].Amount.toFixed(0) }} ({{ item[material].Accessibility }})</span>
        </template>
      </v-data-table>
    </div>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

const MaterialMap = {
  1: "Duranium",
  2: "Neutronium",
  3: "Corbomite",
  4: "Tritanium",
  5: "Boronide",
  6: "Mercassium",
  7: "Vendarite",
  8: "Sorium",
  9: "Uridium",
  10: "Corundium",
  11: "Gallicite",
}

export default {
  components: {},
  data() {
    return {
      panels: [0, 1, 2],
      
      materials: Object.values(MaterialMap),
      systems: [],
    }
  },
  methods: {
    toggleSystems() {
      if (!this.systems.length) {
        this.systems = this.systemNames.map(system => system.SystemID)
      } else {
        this.systems = []
      }
    }
  },
  computed: {
    ...mapGetters([
      'database',
      
      'GameID',
      'RaceID',
    ]),

    bodyGroups() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      return this.minerals.reduce((bodies, item) => {
        if (!this.systems.includes(item.SystemID)) {
          return bodies
        }

        if (!bodies[item.SystemBodyID]) {
          bodies[item.SystemBodyID] = {
            SystemID: item.SystemID,
            SystemName: item.SystemName,

            SystemBodyID: item.SystemBodyID,
            SystemBodyName: item.SystemBodyName,
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
    },
    systemNames() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      return Object.values(this.minerals.reduce((names, item) => {
        if (!names[item.SystemID]) {
          names[item.SystemID] = {
            SystemID: item.SystemID,
            SystemName: item.SystemName,
          }
        }

        return names
      }, {})).map(system => system)
    },
    bodyNames() {
      if (!this.minerals || !this.minerals.length) {
        return null
      }

      return this.minerals.reduce((names, item) => {
        if (!names[item.SystemBodyID]) {
          names[item.SystemBodyID] = item.SystemBodyName
        }

        return names
      }, {})
    },

    MaterialMap() {
      return MaterialMap
    },

    headers() {
      return [
        {
          text: 'System',
          value: 'SystemName',
          divider: true,
        },
        {
          text: 'Body',
          value: 'SystemBodyName',
          divider: true,
        },
        ...this.materials.map(material => ({
          text: material,
          value: material,
          sortable: true,
          align: 'center',
          sort: (alpha, beta) => {
            const alphaQuantity = alpha ? alpha.Amount : 0
            const betaQuantity = beta ? beta.Amount : 0

            return betaQuantity - alphaQuantity
          }
        })),
      ]
    }
  },
  asyncComputed: {
    minerals: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const minerals = await this.database.query(`select FCT_MineralDeposit.*, FCT_SystemBody.Name as SystemBodyName, DIM_KnownSystems.Name as SystemName from FCT_MineralDeposit left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID left join FCT_System on FCT_System.SystemID = FCT_MineralDeposit.SystemID left join DIM_KnownSystems on DIM_KnownSystems.KnownSystemID = FCT_System.SystemNumber where FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID join FCT_Race on FCT_Race.RaceID = FCT_SystemBodySurveys.RaceID and FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID})`).then(([ items ]) => {
          console.log('Minerals', items)

          return items
        })
              
        return minerals
      },
      default: [],
    },
  },
  watch: {
    systemNames: {
      immediate: true,
      handler(newNames) {
        if (newNames) {
          this.systems = newNames.map(system => system.SystemID)
        }
      }
    },
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>

</style>
