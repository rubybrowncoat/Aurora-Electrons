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
        <v-col cols="8">
          <v-btn-toggle v-model="systemViewOption" dense mandatory>
            <v-btn>
              <v-icon class="mr-1">mdi-satellite</v-icon>
              Geological
            </v-btn>

            <v-btn>
              <v-icon class="mr-1">mdi-link-box-variant</v-icon>
              Gravitational
            </v-btn>
          </v-btn-toggle>
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

      distance: 1,

      focusSystemId: null,
      systemViewOption: 0,

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

    showGeologicalSurvey() {
      return this.systemViewOption === 0
    },
    showGravitationalSurvey() {
      return this.systemViewOption === 1
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

        const nodes = await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, VIR_GeologicalSurvey.SystemBodies, VIR_GeologicalSurvey.SurveyedSystemBodies, VIR_GravitationalSurvey.SurveyLocations, VIR_GravitationalSurvey.SurveyedSurveyLocations from FCT_RaceSysSurvey left join (select FCT_SystemBody.SystemID, sum(CAST(CASE WHEN FCT_SystemBody.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT)) as SystemBodies, sum(CAST(CASE WHEN FCT_SystemBodySurveys.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyedSystemBodies from FCT_SystemBody left join FCT_SystemBodySurveys on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} where FCT_SystemBody.GameID = ${this.GameID} group by FCT_SystemBody.SystemID) as VIR_GeologicalSurvey on FCT_RaceSysSurvey.SystemID = VIR_GeologicalSurvey.SystemID left join (select FCT_SurveyLocation.SystemID, sum(CAST(CASE WHEN FCT_SurveyLocation.SystemID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyLocations, sum(CAST(CASE WHEN FCT_RaceSurveyLocation.SystemID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyedSurveyLocations from FCT_SurveyLocation left join FCT_RaceSurveyLocation on FCT_SurveyLocation.SystemID = FCT_RaceSurveyLocation.SystemID and FCT_SurveyLocation.LocationNumber = FCT_RaceSurveyLocation.LocationNumber and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID) as VIR_GravitationalSurvey on FCT_RaceSysSurvey.SystemID = VIR_GravitationalSurvey.SystemID where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([ items ]) => {
          console.log('Systems', items)

          return items.map(item => ({
            id: String(item.SystemID),
            name: item.Name,

            gravPercentage: item.SurveyedSurveyLocations / item.SurveyLocations,
            geoPercentage: item.SurveyedSystemBodies / item.SystemBodies,
            empty: !item.SystemBodies,

            neighbors: new Set(),
            connections: new Set(),

            unexploredConnections: 0,
          }))
        })

        const links = await this.database.query(`select FCT_JumpPoint.*, VIR_Destination.SystemID as DestinationID, FCT_RaceSysSurvey.Name, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.Charted, FCT_RaceJumpPointSurvey.Hide from FCT_JumpPoint inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_JumpPoint as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID left join FCT_RaceJumpPointSurvey on FCT_JumpPoint.WarpPointID = FCT_RaceJumpPointSurvey.WarpPointID and FCT_Race.RaceID = FCT_RaceJumpPointSurvey.RaceID where FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1`).then(([ items ]) => {
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
            } else if (origin) {
              origin.unexploredConnections += 1
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
      .nodeVal(node => node.id === this.focusSystemId ? 10 : 2)
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

        // Geo / Grav Survey State
        const showSurvey = this.showGeologicalSurvey || this.showGravitationalSurvey
        if (showSurvey) {
          const percentage = this.showGeologicalSurvey ? node.geoPercentage : node.gravPercentage
          const empty = this.showGeologicalSurvey ? node.empty : node.neighbors.size + node.unexploredConnections === 1

          ctx.lineWidth = node.id === this.focusSystemId ? 4 : 2
          if (!empty) {
            ctx.strokeStyle = percentage === 1 ? 'lime' : 'green'
            ctx.beginPath()
            ctx.arc(node.x, node.y, node.id === this.focusSystemId ? 14 : 6, 0, 2 * Math.PI * percentage)
            ctx.stroke()

            if (percentage < 1) {
              ctx.strokeStyle = 'darkred'
              ctx.beginPath()
              ctx.arc(node.x, node.y, node.id === this.focusSystemId ? 14 : 6, 2 * Math.PI * percentage, 2 * Math.PI)
              ctx.stroke()
            }
          } else {
            ctx.strokeStyle = 'gray'
            ctx.beginPath()
            ctx.arc(node.x, node.y, node.id === this.focusSystemId ? 14 : 6, 0, 2 * Math.PI)
            ctx.stroke()
          }
        }

        // Unexplored Jump Points
        for (let iterator = 0; iterator < node.unexploredConnections; iterator += 1) {
          const radius = (node.id === this.focusSystemId ? 12 : 3) + (showSurvey ? 3 : 1 ) + 3 + (3 * Math.floor(iterator / 15))
          const xPos = node.x + radius * -Math.sin(-24 * iterator * Math.PI / 180)
          const yPos = node.y + radius * -Math.cos(-24 * iterator * Math.PI / 180)

          ctx.beginPath()
          ctx.arc(xPos, yPos, 1, 0, 2 * Math.PI)
          ctx.fillStyle = 'orange'
          ctx.fill()
        }

        ctx.fillStyle = highlightNodes.has(node) ? colors.cyan.lighten2 : ( this.$vuetify.theme.dark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)' )
        ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions);

        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = highlightNodes.has(node) ? colors.shades.black : ( this.focusSystemId === node.id ? colors.yellow.darken3 : ( this.$vuetify.theme.dark ? 'black' : 'white' ) )
        ctx.fillText(label, node.x, node.y)
      })
      .nodeCanvasObjectMode(() => 'after')
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
