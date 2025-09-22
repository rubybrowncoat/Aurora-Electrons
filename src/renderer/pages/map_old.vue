<template>
  <div class="fill-height">
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <template v-else>
      <div
        id="graph-container"
        style="position: absolute; top: 12px; left: 12px; width: calc(100% - 24px); height: calc(100vh - 112px - 44px - 24px); z-index: 0;"
      >
        <div id="graph" />
      </div>

      <v-navigation-drawer v-model="isOptionsDrawerOpen" absolute temporary right>
        <v-list dense>
          <v-subheader style="font-size: 1.25rem; font-weight: 500;">
            Map Options
            <v-btn icon class="ml-auto" @click.stop="isOptionsDrawerOpen = false">
              <v-icon>mdi-close</v-icon>
            </v-btn>
          </v-subheader>
          <v-list-item>
            <v-checkbox v-model="useSavedPositions" label="Show saved positions" dense />
          </v-list-item>
          <v-list-item>
            <v-checkbox v-model="isShowingSectors" label="Highlight by Sector" dense />
          </v-list-item>
          <v-divider />
          <v-list-item>
            <v-list-item-title>Survey Type</v-list-item-title>
          </v-list-item>
          <v-list-item-group v-model="systemViewOption" mandatory color="indigo">
            <v-list-item>
              <v-list-item-icon>
                <v-icon class="mr-1">mdi-satellite</v-icon>
              </v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Geological</v-list-item-title>
              </v-list-item-content>
            </v-list-item>

            <v-list-item>
              <v-list-item-icon>
                <v-icon class="mr-1">mdi-link-box-variant</v-icon>
              </v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>Gravitational</v-list-item-title>
              </v-list-item-content>
            </v-list-item>
          </v-list-item-group>
          <v-divider />
        </v-list>
      </v-navigation-drawer>

      <v-container fluid>
        <v-row justify="start">
          <v-col cols="4">
            <v-autocomplete
              v-model="focusSystemId"
              :background-color="$vuetify.theme.dark ? 'rgba(5, 5, 10, 0.75)' : 'rgba(250, 250, 255, 0.85)'" :items="sortedNodes" item-text="name" item-value="id" label="Highlighted System"
              auto-select-first hide-selected dense clearable outlined
            />
          </v-col>
          <v-col cols="8" class="d-flex justify-end">
            <v-btn icon @click.stop="isOptionsDrawerOpen = !isOptionsDrawerOpen">
              <v-icon>mdi-cog</v-icon>
            </v-btn>
          </v-col>
        </v-row>
        <v-sheet
          v-if="isShowingSectors && sectors.length" class="absolute pa-4" elevation="4" shaped width="200" :style="{
            position: 'absolute',
            bottom: '16px',
            right: '16px',
            maxHeight: '125px',
            overflowY: 'auto',
          }"
        >
          <div class="subtitle-1 font-weight-bold mb-2">Sectors</div>
          <v-row dense>
            <v-col v-for="sector in sectors" :key="sector.SectorID" cols="12" class="d-flex align-center">
              <v-sheet
                width="24" height="24" rounded :style="{
                  backgroundColor: sector.color,
                  display: 'inline-block',
                  marginRight: '8px',
                }"
              />
              <div class="caption text-center">{{ sector.SectorName }}</div>
            </v-col>
          </v-row>
        </v-sheet>
      </v-container>
    </template>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import colors from 'vuetify/lib/util/colors'

import ForceGraph from 'force-graph'
import * as d3Force from 'd3-force'

// const secondsPerYear = 31536000

export default {
  components: {},
  data () {
    return {
      graph: null,

      distance: 1,

      isOptionsDrawerOpen: false,
      isShowingSectors: true,

      focusSystemId: null,
      systemViewOption: 0,
      useSavedPositions: false,

      //

      sectorColorChain: ['#e60049', '#0bb4ff', '#50e991', '#e6d800', '#9b19f5', '#ffa300', '#dc0ab4', '#b3d4ff', '#00bfa0', '#b30000', '#7c1158', '#4421af', '#1a53ff', '#0d88e6', '#00b7c7', '#5ad45a', '#8be04e', '#ebdc78', '#fd7f6f', '#7eb0d5', '#b2e061', '#bd7ebe', '#ffb55a', '#ffee65', '#beb9db', '#fdcce5', '#8bd3c7', '#ea5545', '#f46a9b', '#ef9b20', '#edbf33', '#ede15b', '#bdcf32', '#87bc45', '#27aeef', '#b33dc6'],

      rules: {
        required: (value) => !!value || 'Required.',
        positive: (value) => value > 0 || 'Must be positive.',
      },
    }
  },
  methods: {
    resizeGraph () {
      if (this.graph) {
        const element = document.getElementById('graph')

        this.graph.width(element.offsetWidth)
        this.graph.height(element.parentElement.offsetHeight)
      }
    },

    initializeGraph () {
      const element = document.getElementById('graph')

      if (!element) {
        console.error('Graph element not found')
        return
      }

      if (this.graph) {
        this.graph._destructor()
        this.graph = null
      }

      let hoverNode = null
      const highlightNodes = new Set()
      const highlightLinks = new Set()

      this.graph = ForceGraph()(element)

      this.graph
        .cooldownTime(Infinity)
        .nodeVal((node) => node.id === this.focusSystemId ? 10 : 2)
        .nodeLabel((node) => {
          return this.isShowingSectors ? node.sector : ''
        })
        .linkColor((link) => highlightLinks.has(link)
          ? colors.cyan.lighten3
          : (link.stgated && link.tsgated
              ? colors.green.base
              : (link.stgated || link.tsgated
                  ? colors.orange.base
                  : colors.red.base
                )
            ),
        )
        .nodeCanvasObjectMode(() => 'replace')
        .nodeCanvasObject((node, ctx, globalScale) => {
          const scaleFraction = globalScale > 4 ? 1 / (globalScale / 4) : 1

          // Geo / Grav Survey State
          const showSurvey = this.showGeologicalSurvey || this.showGravitationalSurvey
          if (showSurvey) {
            const percentage = this.showGeologicalSurvey ? node.geoPercentage : node.gravPercentage
            const empty = this.showGeologicalSurvey ? node.empty : node.neighbors.size + node.unexploredConnections === 1

            const lineWidth = (node.id === this.focusSystemId ? 4 : 2) / (globalScale > 3 ? globalScale / 3 : 1)
            ctx.lineWidth = lineWidth

            const nodeScale = (node.id === this.focusSystemId ? 14 : 10) * scaleFraction
            if (this.showGravitationalSurvey || !empty) {
              ctx.fillStyle = percentage === 1 ? 'lime' : 'green'
              ctx.beginPath()
              ctx.moveTo(node.x, node.y)
              // ctx.ellipse(node.x, node.y, nodeScale, nodeScale, 0, 0, 2 * Math.PI * percentage)
              ctx.arc(node.x, node.y, nodeScale, 0, 2 * Math.PI * percentage)
              ctx.fill()

              if (percentage < 1) {
                ctx.fillStyle = 'darkred'
                ctx.beginPath()
                ctx.moveTo(node.x, node.y)
                // ctx.ellipse(node.x, node.y, nodeScale, nodeScale, 0, 2 * Math.PI * percentage, 2 * Math.PI)
                ctx.arc(node.x, node.y, nodeScale, 2 * Math.PI * percentage, 2 * Math.PI)
                ctx.fill()
              }
            } else {
              ctx.strokeStyle = 'gray'
              ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
              ctx.beginPath()
              // ctx.ellipse(node.x, node.y, nodeScale, nodeScale, 0, 0, 2 * Math.PI)
              ctx.arc(node.x, node.y, nodeScale, 0, 2 * Math.PI)
              ctx.fill()
              ctx.stroke()
            }
          }

          if (node.sector && this.isShowingSectors) {
            const sectorFraction = globalScale > 4 ? 1 / (globalScale / 4) : globalScale < 1 ? 1 / globalScale : 1

            ctx.fillStyle = this.sectorColorChain[node.sectorId % this.sectorColorChain.length]
            ctx.beginPath()
            ctx.arc(node.x, node.y, 5 * sectorFraction, 0, 2 * Math.PI)
            ctx.fill()
          }

          // Unexplored Jump Points
          for (let iterator = 0; iterator < node.unexploredConnections; iterator += 1) {
            const radius = ((node.id === this.focusSystemId ? 12 : 7) + (showSurvey ? 3 : 1) + 3 + (3 * Math.floor(iterator / 15))) * scaleFraction
            const xPos = node.x + radius * -Math.sin(-24 * iterator * Math.PI / 180)
            const yPos = node.y + radius * -Math.cos(-24 * iterator * Math.PI / 180)

            ctx.beginPath()
            ctx.arc(xPos, yPos, scaleFraction, 0, 2 * Math.PI)
            ctx.fillStyle = 'orange'
            ctx.fill()
          }

          if (globalScale > 1.5 || hoverNode === node) {
            const label = node.name
            const fontSize = (node.id === this.focusSystemId ? 22 : 12) / globalScale

            ctx.font = `${this.focusSystemId === node.id ? 'bold ' : ''}${fontSize}px Sans-Serif`

            const textWidth = ctx.measureText(label).width
            const bckgDimensions = [textWidth, fontSize].map((n) => n + fontSize * 0.6) // some padding

            ctx.moveTo(node.x, node.y - 20)

            ctx.fillStyle = highlightNodes.has(node) ? colors.cyan.lighten2 : (this.$vuetify.theme.dark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)')
            ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y + (18 * scaleFraction) - bckgDimensions[1] / 2, ...bckgDimensions)

            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = highlightNodes.has(node) ? colors.shades.black : (this.focusSystemId === node.id ? colors.yellow.darken3 : (this.$vuetify.theme.dark ? 'black' : 'white'))
            ctx.fillText(label, node.x, node.y + (18 * scaleFraction))
          }
        })
        .linkWidth((link) => highlightLinks.has(link) ? 8 : (link.stgated && link.tsgated ? 6 : (link.stgated || link.tsgated ? 4 : 2)))
        .linkCanvasObject((link, ctx, globalScale) => {
          const label = highlightLinks.has(link) ? '' : (link.stgated && link.tsgated ? '' : (link.stgated ? `Stable from ${link.sourceName}` : (link.tsgated ? `Stable from ${link.targetName}` : '')))

          if (label && (globalScale > 1.5 || (hoverNode && (hoverNode.name === link.sourceName || hoverNode.name === link.targetName)))) {
            const fontSize = 10 / globalScale
            ctx.font = `${fontSize}px Sans-Serif`

            const textPos = Object.assign(...['x', 'y'].map((c) => ({
              [c]: link.source[c] + (link.target[c] - link.source[c]) / 2, // calc middle point
            })))

            const textWidth = ctx.measureText(label).width
            const bckgDimensions = [textWidth, fontSize].map((n) => n + fontSize * 0.6) // some padding

            ctx.fillStyle = this.$vuetify.theme.dark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.9)'
            ctx.fillRect(textPos.x - bckgDimensions[0] / 2, textPos.y - bckgDimensions[1] / 2, ...bckgDimensions)

            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = this.$vuetify.theme.dark ? 'white' : 'black'
            ctx.fillText(label, textPos.x, textPos.y)
          }
        })
        .linkCanvasObjectMode(() => 'after')
        .enableNodeDrag(true)
        .onNodeHover((node) => {
          hoverNode = node
          highlightNodes.clear()
          highlightLinks.clear()

          if (node) {
            highlightNodes.add(node)

            node.neighbors.forEach((neighbor) => highlightNodes.add(neighbor))
            node.connections.forEach((connection) => highlightLinks.add(connection))

            element.style.cursor = '-webkit-grab'
          } else {
            element.style.cursor = null
          }
        })
        .onNodeClick((node) => {
          this.graph.zoom(6, 600)
          this.graph.centerAt(node.x, node.y, 400)
        })
        .onNodeDrag((node) => {
          highlightNodes.clear()

          if (node) {
            highlightNodes.add(node)
          }
        })
        // .onNodeDragEnd(node => {
        //   node.fx = node.x
        //   node.fy = node.y
        // })
        .minZoom(0.35)
      // .onZoom(zoom => {
      //   if (zoom.k > 1) {
      //     console.log('Zoomed In', zoom.k)
      //   } else {
      //     console.log('Zoomed Out', zoom.k)
      //   }
      // })

      if (this.useSavedPositions) {
        this.graph
          .d3Force('x', d3Force.forceX((node) => node.mapX).strength(1))
          .d3Force('y', d3Force.forceY((node) => node.mapY).strength(1))
      } else {
        this.graph
          .d3Force('center', d3Force.forceCenter().strength(0.1))
          .d3Force('charge', d3Force.forceManyBody().strength(-150))
          .d3Force('collide', d3Force.forceCollide(this.graph.nodeRelSize()))
          .d3Force('manyBody', d3Force.forceManyBody().strength(-150))

        const linkForce = this.graph
          .d3Force('link')
          .distance((link) => link.stgated && link.tsgated ? Math.min(75, 25 + Math.max(link.source.connections.size, link.target.connections.size) * 5) : (link.stgated || link.tsgated ? 80 : 100))
          // .strength(1)
          .strength((link) => {
            return 1 / Math.max(link.source.connections.size, link.target.connections.size)
          })
          .iterations(15)
      }

      this.graph.graphData({
        nodes: this.sortedNodes,
        links: this.sortedLinks,
      }).centerAt(0, 0).zoom(1.75, 300)

      window.addEventListener('resize', this.resizeGraph)

      this.resizeGraph()
    },
  },
  computed: {
    ...mapGetters([
      'database',

      'GameID',
      'RaceID',
    ]),

    sortedNodes () {
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
    sortedLinks () {
      const links = [...this.mapElements.links]

      const selfLoopLinks = {}
      const sameNodesLinks = {}
      const curvatureMinMax = 0.5

      // 1. assign each link a nodePairId that combines their source and target independent of the links direction
      // 2. group links together that share the same two nodes or are self-loops
      links.forEach((link) => {
        link.nodePairId = link.source <= link.target ? (link.source + '_' + link.target) : (link.target + '_' + link.source)
        const map = link.source === link.target ? selfLoopLinks : sameNodesLinks
        if (!map[link.nodePairId]) {
          map[link.nodePairId] = []
        }
        map[link.nodePairId].push(link)
      })

      // Compute the curvature for self-loop links to avoid overlaps
      Object.keys(selfLoopLinks).forEach((id) => {
        const links = selfLoopLinks[id]
        const lastIndex = links.length - 1
        links[lastIndex].curvature = 1
        const delta = (1 - curvatureMinMax) / lastIndex
        for (let i = 0; i < lastIndex; i++) {
          links[i].curvature = curvatureMinMax + i * delta
        }
      })

      // Compute the curvature for links sharing the same two nodes to avoid overlaps
      Object.keys(sameNodesLinks).filter((nodePairId) => sameNodesLinks[nodePairId].length > 1).forEach((nodePairId) => {
        const links = sameNodesLinks[nodePairId]
        const lastIndex = links.length - 1
        const lastLink = links[lastIndex]
        lastLink.curvature = curvatureMinMax
        const delta = 2 * curvatureMinMax / lastIndex
        for (let i = 0; i < lastIndex; i++) {
          links[i].curvature = -curvatureMinMax + i * delta
          if (lastLink.source !== links[i].source) {
            links[i].curvature *= -1 // flip it around, otherwise they overlap
          }
        }
      })

      console.log('selfLoopLinks', selfLoopLinks)
      console.log('sameNodesLinks', sameNodesLinks)

      console.log('links', links)

      return links
    },

    showGeologicalSurvey () {
      return this.systemViewOption === 0
    },
    showGravitationalSurvey () {
      return this.systemViewOption === 1
    },
  },
  asyncComputed: {
    sectors: {
      async get () {
        if (!this.database || !this.GameID) {
          return []
        }

        const sectors = await this.database.query(`select FCT_SectorCommand.*, count(FCT_RaceSysSurvey.SectorID) as SectorSystems from FCT_SectorCommand left join FCT_RaceSysSurvey on FCT_SectorCommand.SectorCommandID = FCT_RaceSysSurvey.SectorID where FCT_SectorCommand.GameID = ${this.GameID} and FCT_SectorCommand.RaceID = ${this.RaceID} group by FCT_SectorCommand.SectorCommandID`).then(([items]) => {
          return items.map((item) => ({
            ...item,
            color: this.sectorColorChain[item.SectorCommandID % this.sectorColorChain.length],
          }))
        })
        console.log('Sectors', sectors)

        return sectors
      },
      default: [],
    },
    mapElements: {
      async get () {
        if (!this.database || !this.GameID) {
          return {
            nodes: [],
            links: [],
          }
        }

        const nodes = await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.SectorID, FCT_SectorCommand.SectorName, FCT_RaceSysSurvey.Name, VIR_GeologicalSurvey.PlanetaryBodies, VIR_GeologicalSurvey.SystemBodies, VIR_GeologicalSurvey.SurveyedSystemBodies, VIR_GravitationalSurvey.SurveyLocations, VIR_GravitationalSurvey.SurveyedSurveyLocations from FCT_RaceSysSurvey left join (select FCT_SystemBody.SystemID, sum(CAST(CASE WHEN FCT_SystemBody.BodyClass IN (1, 2) THEN 1 ELSE 0 END AS INT)) as PlanetaryBodies, sum(CAST(CASE WHEN FCT_SystemBody.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT)) as SystemBodies, sum(CAST(CASE WHEN FCT_SystemBodySurveys.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyedSystemBodies from FCT_SystemBody left join FCT_SystemBodySurveys on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} where FCT_SystemBody.GameID = ${this.GameID} group by FCT_SystemBody.SystemID) as VIR_GeologicalSurvey on FCT_RaceSysSurvey.SystemID = VIR_GeologicalSurvey.SystemID left join (select FCT_SurveyLocation.SystemID, sum(CAST(CASE WHEN FCT_SurveyLocation.SystemID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyLocations, sum(CAST(CASE WHEN FCT_RaceSurveyLocation.SystemID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyedSurveyLocations from FCT_SurveyLocation left join FCT_RaceSurveyLocation on FCT_SurveyLocation.SystemID = FCT_RaceSurveyLocation.SystemID and FCT_SurveyLocation.LocationNumber = FCT_RaceSurveyLocation.LocationNumber and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID) as VIR_GravitationalSurvey on FCT_RaceSysSurvey.SystemID = VIR_GravitationalSurvey.SystemID left join FCT_SectorCommand on FCT_SectorCommand.SectorCommandID = FCT_RaceSysSurvey.SectorID where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => {
          return items.map((item) => ({
            id: String(item.SystemID),
            name: item.Name,

            mapX: item.Xcor / 3,
            mapY: item.Ycor / 3,

            gravPercentage: item.SurveyedSurveyLocations / item.SurveyLocations,
            geoPercentage: item.SurveyedSystemBodies / item.SystemBodies,
            empty: !item.SystemBodies,

            sectorId: item.SectorID,
            sector: item.SectorName,

            neighbors: new Set(),
            connections: new Set(),

            unexploredConnections: 0,
          }))
        })

        console.log('Nodes', nodes)

        const links = await this.database.query(`select FCT_JumpPoint.*, VIR_Destination.SystemID as DestinationID, FCT_RaceSysSurvey.Name, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.Charted, FCT_RaceJumpPointSurvey.Hide from FCT_JumpPoint inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_JumpPoint as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID left join FCT_RaceJumpPointSurvey on FCT_JumpPoint.WarpPointID = FCT_RaceJumpPointSurvey.WarpPointID and FCT_Race.RaceID = FCT_RaceJumpPointSurvey.RaceID where FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1`).then(([items]) => {
          return items.reduce((aggregate, item) => {
            const origin = nodes.find((node) => node.id == item.SystemID)
            const destination = nodes.find((node) => node.id == item.DestinationID)

            if (origin && destination) {
              let extant = aggregate.find((link) => link.target === origin.id && link.source === destination.id)

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

        console.log('Links', links)

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
      handler (data) {
        if (data && this.graph) {
          this.graph.graphData({
            nodes: this.sortedNodes,
            links: this.sortedLinks,
          })
        }
      },
    },
    focusSystemId: {
      handler (id) {
        if (!this.graph) {
          return
        }

        if (id) {
          const selectedNode = this.sortedNodes.find((node) => node.id === id)

          this.graph.graphData({
            nodes: this.sortedNodes,
            links: this.sortedLinks,
          })

          this.graph.centerAt(selectedNode.x, selectedNode.y, 400)
          this.graph.zoom(3, 600)
        } else {
          this.graph.centerAt(0, 0, 400)
          this.graph.zoom(1.75, 600)
        }
      },
    },
    useSavedPositions: {
      handler () {
        this.initializeGraph()
      },
    },
  },
  mounted () {
    this.initializeGraph()
  },
  beforeDestroy () {
    window.removeEventListener('resize', this.resizeGraph)

    if (this.graph) {
      this.graph._destructor()
      this.graph = null
    }
  },
}
</script>

<style lang="scss">
.force-graph-container {
  .graph-tooltip {
    transform: translate(-50%, -110%);
  }
}
</style>
