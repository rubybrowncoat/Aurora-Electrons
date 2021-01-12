<template>
  <div class="fill-height">
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div id="graph-container" style="position: absolute; top: 12px; left: 12px; width: calc(100% - 24px); height: calc(100vh - 112px - 44px - 24px); z-index: 0;">
      <div id="graph"></div>
    </div>

    <v-container fluid>
      <v-row justify="start">
        <v-col cols="4">
          <v-autocomplete
            :background-color="$vuetify.theme.dark ? 'rgba(5, 5, 10, 0.75)' : 'rgba(250, 250, 255, 0.85)'"

            v-model="focusSystemId"
            :items="sortedNodes"

            item-text="name"
            item-value="id"

            label="Highlighted System"
            
            auto-select-first
            hide-selected
            
            dense
            clearable
            outlined
          ></v-autocomplete>
        </v-col>
      </v-row>
    </v-container>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

import romanum from 'romanum'

import { convertDisplayBase } from '../../utilities/generic'
import { separatedNumber, roundToDecimal } from '../../utilities/math'

import colors from 'vuetify/lib/util/colors'

import ForceGraph from 'force-graph'
import * as d3Force from 'd3-force'

const secondsPerYear = 31536000

export default {
  components: {},
  data() {
    return {
      graph: null,

      distanceMultiplier: 1000000000,
      distance: 1,

      focusSystemId: null,

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

    sortedNodes() {
      const sortedNodes = [...this.mapElements.nodes]

      sortedNodes.sort((alpha, beta) => {
        if (alpha.id === this.focusSystemId) {
          return 1
        }

        if (beta.id === this.focusSystemId) {
          return -1
        }

        return alpha.name.localeCompare(beta.name)
      })

      return sortedNodes
    },
    sortedLinks() {
      return [...this.mapElements.links]
    },

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

            neighbors: new Set(),
            connections: new Set(),
          }))
        })

        const links = await this.database.query(`select FCT_JumpPoint.*, VIR_Destination.SystemID as DestinationID, FCT_RaceSysSurvey.Name from FCT_JumpPoint inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_JumpPoint as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID where FCT_JumpPoint.WPLink <> 0 and FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Jump Points', items)

          return items.reduce((aggregate, item) => {
            const origin = nodes.find(node => node.id == item.SystemID)
            const destination = nodes.find(node => node.id == item.DestinationID)

            if (origin && destination) {
              let extant = aggregate.find(link => link.target === origin.id && link.source === destination.id)

              if (extant) {
                extant.tsgated = !!item.JumpGateStrength
              } else {
                extant = {
                  id: String(item.WarpPointID),
                  source: String(item.SystemID),
                  target: String(item.DestinationID),

                  sourceName: origin.name,
                  targetName: destination.name,
                  
                  stgated: !!item.JumpGateStrength,
                  tsgated: false,
                }

                aggregate.push(extant)
              }

              origin.connections.add(extant)
              origin.neighbors.add(destination)
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
        if (data && this.graph) { 
          this.graph.graphData({
            nodes: this.sortedNodes,
            links: this.sortedLinks,
          })
        }
      }
    },
    focusSystemId: {
      handler(id) {
        if (id) {
          const selectedNode = this.sortedNodes.find(node => node.id === id)

          this.graph.graphData({
            nodes: this.sortedNodes,
            links: this.sortedLinks,
          })

          this.graph.centerAt(selectedNode.x, selectedNode.y, 400)
          this.graph.zoom(3, 600)
        } else {
          this.graph.centerAt(0, 0, 400)
          this.graph.zoom(1, 600)
        }
      }
    }
  },
  mounted() {
    const element = document.getElementById('graph')
    
    const highlightNodes = new Set()
    const highlightLinks = new Set()

    this.graph = ForceGraph()(element)
      .cooldownTime(Infinity)
      .nodeVal(node => node.id === this.focusSystemId ? 12 : 8)
      .nodeLabel('')
      .linkColor(link => highlightLinks.has(link)
        ? colors.cyan.lighten3
        : ( link.stgated && link.tsgated 
          ? colors.green.base 
          : ( link.stgated || link.tsgated 
            ? colors.orange.base
            : colors.red.base
          )
        )
      )
      .linkWidth(link => highlightLinks.has(link) ? 8 : ( link.stgated && link.tsgated ? 6 : ( link.stgated || link.tsgated ? 4 : 2 ) ) )
      .linkCanvasObject((link, ctx, globalScale) => {
        const label = highlightLinks.has(link) ? '' : ( link.stgated && link.tsgated ? '' : ( link.stgated ? `Gated from ${link.sourceName}` : ( link.tsgated ? `Gated from ${link.targetName}` : '' ) ) )

        if (label) {
          const fontSize = 10 / globalScale
          ctx.font = `${fontSize}px Sans-Serif`
          
          const textPos = Object.assign(...['x', 'y'].map(c => ({
            [c]: link.source[c] + (link.target[c] - link.source[c]) / 2 // calc middle point
          })))

          const textWidth = ctx.measureText(label).width
          const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.6) // some padding

          ctx.fillStyle = this.$vuetify.theme.dark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.9)' 
          ctx.fillRect(textPos.x - bckgDimensions[0] / 2, textPos.y - bckgDimensions[1] / 2, ...bckgDimensions);

          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = this.$vuetify.theme.dark ? 'white' : 'black'
          ctx.fillText(label, textPos.x, textPos.y)
        }
      })
      .linkCanvasObjectMode(() => 'after')
      .enableNodeDrag(true)
      .onNodeHover(node => {
        highlightNodes.clear()
        highlightLinks.clear()

        if (node) {
          highlightNodes.add(node)

          node.neighbors.forEach(neighbor => highlightNodes.add(neighbor))
          node.connections.forEach(connection => highlightLinks.add(connection))

          element.style.cursor = '-webkit-grab'
        } else {
          element.style.cursor = null
        }
      })
      .onNodeClick(node => {
        this.graph.zoom(6, 600)
        this.graph.centerAt(node.x, node.y, 400)
      })
      .onNodeDrag(node => {
        highlightNodes.clear()

        if (node) {
          highlightNodes.add(node)
        }
      })
      // .onNodeDragEnd(node => {
      //   node.fx = node.x
      //   node.fy = node.y
      // })
      .nodeCanvasObject((node, ctx, globalScale) => {
        const label = node.name
        const fontSize = ( node.id === this.focusSystemId ? 22 : 12 ) / globalScale

        ctx.font = `${this.focusSystemId === node.id ? 'bold ' : ''}${fontSize}px Sans-Serif`

        const textWidth = ctx.measureText(label).width
        const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.6) // some padding

        ctx.fillStyle = highlightNodes.has(node) ? colors.cyan.lighten2 : ( this.$vuetify.theme.dark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)' )
        ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions);

        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = highlightNodes.has(node) ? colors.shades.black : ( this.focusSystemId === node.id ? colors.yellow.darken3 : ( this.$vuetify.theme.dark ? 'black' : 'white' ) )
        ctx.fillText(label, node.x, node.y)
      })
      .d3Force("charge", d3Force.forceManyBody().strength(-50))
      .d3Force('collide', d3Force.forceCollide(8))
      .d3Force("center", d3Force.forceCenter(0,0))
      .d3Force("manyBody", d3Force.forceManyBody().strength(-50))
      .graphData({
        nodes: this.sortedNodes,
        links: this.sortedLinks,
      })

    const linkForce = this.graph
      .d3Force('link')
      .distance(link => link.stgated && link.tsgated ? 20 : ( link.stgated || link.tsgated ? 50 : 80 ))
      .strength(1)

    window.addEventListener('resize', this.resizeGraph)

    this.resizeGraph()
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.resizeGraph)
    
    if (this.graph) {
      this.graph._destructor()
      this.graph = null
    }
  }
}
</script>

<style lang="scss" scoped>

</style>
