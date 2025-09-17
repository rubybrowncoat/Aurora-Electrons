<template>
  <div>
    <v-container fluid>
      <v-row>
        <v-col>
          <div class="display-1">
            Application settings
          </div>
        </v-col>
      </v-row>
      <v-row justify="start">
        <v-col cols="12">
          <v-switch v-model="spyNPR" inset :label="spyNPR ? 'Displays all races.' : 'Shows only player controlled races.'" @change="setSpyNPR" />
        </v-col>
      </v-row>
      <v-row justify="start">
        <v-col cols="12" md="4">
          <v-select v-model="selectedSeparator" class="d-flex" :items="curatedSeparators" hint="Thousands Separator" solo persistent-hint dense @change="setSelectedSeparator" />
        </v-col>
        <v-col cols="12" md="8">
          <v-text-field v-model="exampleString" label="Example Number" :hint="separatedNumber(exampleString, thousandsSeparator)" solo persistent-hint dense type="number" />
        </v-col>
      </v-row>
    </v-container>

    <div v-if="RaceID">
      <v-container fluid>
        <v-row>
          <v-col>
            <div class="display-1">
              Maintenance threshold
            </div>
          </v-col>
          <v-col v-if="!isMaintenanceDefault" cols="auto" class="d-flex align-center">
            <v-btn color="red" dark x-small @click="resetMaintenanceConfiguration">Reset</v-btn>
          </v-col>
        </v-row>
        <v-row justify="start">
          <v-col cols="12">
            <v-slider
              :value="maintenanceThreshold"
              min="10"

              max="100"
              :hint="`List ships under ${maintenanceThreshold}% maintenance`"
              thumb-label
              persistent-hint
              @change="setMaintenanceThreshold"
            />
          </v-col>
          <v-col cols="12">
            <v-autocomplete v-model="maintenanceExclusions" :items="shipClasses" label="Excluded Ship Classes" item-text="ClassName" item-value="ShipClassID" multiple small-chips deletable-chips clearable @change="setMaintenanceExclusions" />
          </v-col>
        </v-row>
      </v-container>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { separatedNumber } from '../utilities/math'

export default {
  components: {},
  data () {
    return {
      curatedSeparators: ['Tick', 'Comma', 'Dash', 'Space', 'None'],

      spyNPR: false,
      selectedSeparator: 'Tick',
      thousandsSeparator: '\'',
      exampleString: '1234567890.1234',

      maintenanceThreshold: 0,
      maintenanceExclusions: [],
    }
  },
  methods: {
    separatedNumber,

    // APPLICATION
    setSpyNPR (value) {
      this.config.set('spyNPR', value)

      this.spyNPR = value
    },
    setSelectedSeparator (value) {
      this.config.set('selectedSeparator', value)

      this.selectedSeparator = value
      this.thousandsSeparator = value === 'Tick' ? '\'' : value === 'Comma' ? ',' : value === 'Dash' ? '-' : value === 'Space' ? ' ' : ''
    },

    // MAINTENANCE
    setMaintenanceThreshold (value) {
      this.config.set(`game.${this.GameID}.race.${this.RaceID}.maintenanceThreshold`, value)

      this.maintenanceThreshold = value
    },
    setMaintenanceExclusions (value) {
      this.config.set(`game.${this.GameID}.race.${this.RaceID}.maintenanceExclusions`, [...value])

      this.maintenanceExclusions = value
    },
    resetMaintenanceConfiguration () {
      this.config.set(`game.${this.GameID}.race.${this.RaceID}.maintenanceThreshold`, 100)
      this.config.set(`game.${this.GameID}.race.${this.RaceID}.maintenanceExclusions`, [])

      this.maintenanceThreshold = 100
      this.maintenanceExclusions = []
    },
  },
  computed: {
    ...mapGetters([
      'config',
      'database',

      'GameID',
      'RaceID',
    ]),

    // APPLICATION
    storedSpyNPR () {
      return this.config.get('spyNPR', false)
    },
    storedSelectedSeparator () {
      return this.config.get('selectedSeparator', 'Tick')
    },

    // MAINTENANCE
    storedMaintenanceThreshold () {
      return this.config.get(`game.${this.GameID}.race.${this.RaceID}.maintenanceThreshold`, 100)
    },
    storedMaintenanceExclusions () {
      return this.config.get(`game.${this.GameID}.race.${this.RaceID}.maintenanceExclusions`, [])
    },
    isMaintenanceDefault () {
      return this.maintenanceThreshold === 100 && !this.maintenanceExclusions.length
    },
  },
  asyncComputed: {
    shipClasses: {
      async get () {
        if (!this.database || !this.GameID) {
          return []
        }

        const classes = await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_HullDescription.Description as HullDescription from FCT_ShipClass left join FCT_HullDescription on FCT_ShipClass.HullDescriptionID = FCT_HullDescription.HullDescriptionID where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID} and FCT_ShipClass.ClassShippingLineID = 0 order by FCT_ShipClass.ClassName`).then(([items]) => {
          console.log('Ship Classes', items)

          return items
        })

        return classes
      },
      default: [],
    },
  },
  watch: {
    storedSpyNPR: {
      immediate: true,
      handler (spyNPR) {
        this.spyNPR = spyNPR
      },
    },
    storedSelectedSeparator: {
      immediate: true,
      handler (selectedSeparator) {
        this.selectedSeparator = selectedSeparator
        this.thousandsSeparator = selectedSeparator === 'Tick' ? '\'' : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
      },
    },
    storedMaintenanceThreshold: {
      immediate: true,
      handler (maintenanceThreshold) {
        this.maintenanceThreshold = maintenanceThreshold
      },
    },
    storedMaintenanceExclusions: {
      immediate: true,
      handler (maintenanceExclusions) {
        this.maintenanceExclusions = maintenanceExclusions
      },
    },
  },
}
</script>

<style lang="scss" scoped>

</style>
