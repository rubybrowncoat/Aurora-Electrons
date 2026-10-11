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
  },
  computed: {
    ...mapGetters([
      'config',
    ]),

    // APPLICATION
    storedSpyNPR () {
      return this.config.get('spyNPR', false)
    },
    storedSelectedSeparator () {
      return this.config.get('selectedSeparator', 'Tick')
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
  },
}
</script>

<style lang="scss" scoped>

</style>
