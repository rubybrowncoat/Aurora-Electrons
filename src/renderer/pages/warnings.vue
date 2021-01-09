<template>
  <div class="fill-height">
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <!-- <div v-else>
      <v-container fluid>
        <div class="display-1">
          Transportation
        </div>
        <v-row justify="start">
          <v-col cols="12">
            <v-slider
              v-model="distance"
              min="1"
              max="100"
              :hint="`over a distance of ${distance} billion kilometers`"
              thumb-label
              persistent-hint
            ></v-slider>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Civilian Freight Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(civilianCargoCapacity) }} Tons per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Civilian Colonist Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(civilianColonistCapacity) }} People per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Military Freight Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(militaryCargoCapacity) }} Tons per Annum
              </v-card-title>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text class="pb-0">Military Colonist Capacity</v-card-text>
              <v-card-title>
                {{ separatedNumber(militaryColonistCapacity) }} People per Annum
              </v-card-title>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </div> -->

    <div id="graph"></div>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

import romanum from 'romanum'

import { convertDisplayBase } from '../../utilities/generic'
import { separatedNumber, roundToDecimal } from '../../utilities/math'

import ForceGraph from 'force-graph'

const secondsPerYear = 31536000

export default {
  components: {},
  data() {
    return {
      graph: null,

      distanceMultiplier: 1000000000,
      distance: 1,

      //

      rules: {
        required: value => !!value || 'Required.',
        positive: value => value > 0 || 'Must be positive.',
      },
    }
  },
  methods: {
    separatedNumber(number) {
      return separatedNumber(number)
    },

    resizeGraph() {
      if (this.graph) {
        const element = document.getElementById('graph')
        
        this.graph.width(element.offsetWidth)
        this.graph.height(element.parentElement.offsetHeight)
      }
    },
  },
  computed: {
    ...mapGetters([
      'database',
      
      'GameID',
      'RaceID',
    ]),

    multipliedDistance() {
      return this.distance * this.distanceMultiplier
    },
    
    civilianCargoCapacity() {
      return this.ships.filter(ship => ship.ShippingLineID & ship.MaximumCargoLoadingTime).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.CargoCapacity * secondsPerYear / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumCargoLoadingTime * 2))), 0)
    },
    civilianColonistCapacity() {
      return this.ships.filter(ship => ship.ShippingLineID & ship.MaximumColonistLoadingTime).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.ColonistCapacity * secondsPerYear / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumColonistLoadingTime * 2))), 0)
    },
    militaryCargoCapacity() {
      return this.ships.filter(ship => !ship.ShippingLineID & ship.MaximumCargoLoadingTime && this.multipliedDistance <= ship.MaxRange).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.CargoCapacity * Math.max(0, secondsPerYear - (secondsPerYear / ship.MaxRangeTime * ship.MaximumRefuellingTime)) / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumCargoLoadingTime * 2))), 0)
    },
    militaryColonistCapacity() {
      return this.ships.filter(ship => !ship.ShippingLineID && ship.MaximumColonistLoadingTime && this.multipliedDistance <= ship.MaxRange).reduce((aggregate, ship) => aggregate + roundToDecimal(ship.ColonistCapacity * Math.max(0, secondsPerYear - (secondsPerYear / ship.MaxRangeTime * ship.MaximumRefuellingTime)) / ((this.multipliedDistance * 2 / ship.MaxSpeed) + (ship.MaximumColonistLoadingTime * 2))), 0)
    },
  },
  asyncComputed: {
    mapElements: {
      async get() {
        if (!this.database || !this.GameID) {
          return {
            nodes: [],
            links: [],
          }
        }

        const nodes = await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Systems', items)

          return items.map(item => ({
            id: String(item.SystemID),
            name: item.Name,
            neighbors: [],
          }))
        })

        const links = await this.database.query(`select FCT_JumpPoint.*, VIR_Destination.SystemID as DestinationID, FCT_RaceSysSurvey.Name from FCT_JumpPoint inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_JumpPoint as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID where FCT_JumpPoint.WPLink <> 0 and FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Jump Points', items)

          return items.reduce((aggregate, item) => {
            const origin = nodes.find(node => node.id == item.SystemID)
            const destination = nodes.find(node => node.id == item.DestinationID)

            if (origin && destination) {
              aggregate.push({
                id: String(item.WarpPointID),
                source: String(item.SystemID),
                target: String(item.DestinationID),
                
                gated: !!item.JumpGateStrength,
              })

              origin.neighbors.push(destination)
            }

            return aggregate
          }, [])
        })

        return {
          nodes,
          links,
        }
      },
      default: {
        nodes: [],
        links: [],
      },
    },
  },
  watch: {
    mapElements: {
      immediate: true,
      handler(data) {
        console.log('data', data, this.graph)

        if (data && this.graph) {   
          console.log('ABDO')
          this.graph.graphData(data)
        }
      }
    },
  },
  mounted() {
    const element = document.getElementById('graph')
    
    const highlightNodes = new Set()

    this.graph = ForceGraph()(element)
      .nodeRelSize(8)
      .linkColor(() => this.$vuetify.theme.dark ? 'rgba(240, 240, 240, 0.8)' : 'rgba(18, 18, 18, 0.8)')
      .linkWidth(3)
      .enableNodeDrag(true)
      .onNodeHover(node => {
        highlightNodes.clear()

        if (node) {
          highlightNodes.add(node)
          node.neighbors.forEach(neighbor => highlightNodes.add(neighbor))

          element.style.cursor = '-webkit-grab'
        } else {
          element.style.cursor = null
        }
      })
      .nodeCanvasObject((node, ctx, globalScale) => {
        const label = node.name
        const fontSize = 12 / globalScale

        ctx.font = `${fontSize}px Sans-Serif`

        const textWidth = ctx.measureText(label).width
        const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.6) // some padding

        ctx.fillStyle = highlightNodes.has(node) ? 'red' : ( this.$vuetify.theme.dark ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0.8)' )
        ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions);

        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = highlightNodes.has(node) ? 'white' : ( this.$vuetify.theme.dark ? 'black' : 'white' )
        ctx.fillText(label, node.x, node.y)
      })
      .linkDirectionalArrowLength(link => link.gated ? 6 : 0)
      .linkDirectionalArrowRelPos(0)
      .graphData(this.mapElements)

    const linkForce = this.graph
      .d3Force('link')
      .distance(link => link.gated ? 30 : 60)

    window.addEventListener('resize', this.resizeGraph)

    this.resizeGraph()
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.resizeGraph)
    
    this.graph._destructor()
    this.graph = null
  }
}
</script>

<style lang="scss" scoped>

</style>
