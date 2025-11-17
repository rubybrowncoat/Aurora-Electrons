<template>
  <div class="fill-height">
    <div
      id="cytoscape"
      :style="{
        position: 'absolute',
        top: '12px',
        left: '12px',
        width: 'calc(100% - 24px)',
        height: 'calc(100vh - 112px - 44px - 24px)',
        zIndex: 0,
      }"
      :class="{ dark: $vuetify.theme.dark }"
    />
    <div :class="{ 'cytoscape-navigator': true, dark: $vuetify.theme.dark }" />
    <div v-if="!RaceID">Select a race from the left-side menu.</div>
    <template v-else>
      <v-navigation-drawer v-model="isOptionsDrawerOpen" absolute temporary right width="300">
        <v-list dense>
          <v-subheader style="font-size: 1.25rem; font-weight: 500">
            Map Options
            <v-btn icon class="ml-auto" @click.stop="isOptionsDrawerOpen = false">
              <v-icon>mdi-close</v-icon>
            </v-btn>
          </v-subheader>

          <v-divider />

          <v-list-item>
            <v-list-item-title>Connection Distance</v-list-item-title>
          </v-list-item>
          <v-list-item-group v-model="distanceSelection" mandatory color="indigo">
            <v-list-item v-for="option in distanceOptions" :key="option.value" :value="option.value">
              <v-list-item-icon>
                <v-icon class="mr-1">{{ option.icon }}</v-icon>
              </v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>{{ option.label }}</v-list-item-title>
              </v-list-item-content>
            </v-list-item>
          </v-list-item-group>

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

          <v-list-item>
            <v-list-item-title>Grouping</v-list-item-title>
          </v-list-item>
          <v-list-item-group v-model="groupingSelection" mandatory color="indigo">
            <v-list-item v-for="option in groupingOptions" :key="option.value" :value="option.value">
              <v-list-item-icon>
                <v-icon class="mr-1">{{ option.icon }}</v-icon>
              </v-list-item-icon>
              <v-list-item-content>
                <v-list-item-title>{{ option.label }}</v-list-item-title>
              </v-list-item-content>
            </v-list-item>
          </v-list-item-group>
        </v-list>
      </v-navigation-drawer>

      <v-container fluid>
        <v-row justify="start" no-gutters>
          <v-col cols="11">
            <v-btn icon outlined color="primary" :disabled="!mapElements.nodes.length || layoutInProgress" @click="focusHomeSystem">
              <v-icon>mdi-crosshairs-gps</v-icon>
            </v-btn>

            <v-btn icon outlined color="primary" :disabled="!mapElements.nodes.length || layoutInProgress" @click="fitView">
              <v-icon>mdi-fit-to-screen</v-icon>
            </v-btn>

            <v-tooltip v-if="!respectGalacticDistances" bottom>
              <template #activator="{ on, attrs }">
                <v-btn color="light-green lighten-1" fab x-small :disabled="!mapElements.nodes.length || !mapElements.links.length || layoutInProgress" v-bind="attrs" @click="applyForces" v-on="on">
                  <v-icon>mdi-arrow-expand-all</v-icon>
                </v-btn>
              </template>
              <span>Relational Forces Layout</span>
            </v-tooltip>

            <v-tooltip v-if="!groupingSelection" bottom>
              <template #activator="{ on, attrs }">
                <v-btn color="deep-purple darken-1" :dark="!(!mapElements.nodes.length || !mapElements.links.length || layoutInProgress)" fab x-small :disabled="!mapElements.nodes.length || !mapElements.links.length || layoutInProgress" v-bind="attrs" @click="scramble" v-on="on">
                  <v-icon>mdi-creation</v-icon>
                </v-btn>
              </template>
              <span>Scramble and Separate Layout</span>
            </v-tooltip>

            <v-btn color="teal accent-4" :disabled="!mapElements.nodes.length || layoutInProgress" @click="applySavedPositions"> Apply Database Positions </v-btn>
            <v-dialog v-model="isSaveDialogOpen" max-width="360" persistent>
              <template #activator="{ on, attrs }">
                <v-btn color="orange dark" v-bind="attrs" :disabled="!mapElements.nodes.length || layoutInProgress" v-on="on"> Save Positions </v-btn>
              </template>
              <v-card v-if="isSavingPositions" color="orange darken-1">
                <v-card-text>
                  <div class="pt-3 overline white--text">Saving positions to the database...</div>
                  <v-progress-linear :value="(executedQueries / totalQueries) * 100" color="white" class="mb-0" />
                </v-card-text>
              </v-card>
              <v-card v-else>
                <v-card-title class="headline">Save System Positions</v-card-title>
                <v-card-text> Are you sure you want to save the current system positions? This will overwrite the saved positions in your game database. </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn text @click="isSaveDialogOpen = false">Cancel</v-btn>
                  <v-btn color="green darken-1" @click="savePositions">Save</v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>

            <v-tooltip v-if="layoutInProgress" bottom>
              <template #activator="{ on, attrs }">
                <v-btn class="ml-2" color="red darken-1" :dark="layoutInProgress" fab x-small :disabled="!layoutInProgress" v-bind="attrs" @click="stopLayout" v-on="on">
                  <v-icon>mdi-stop</v-icon>
                </v-btn>
              </template>
              <span>Stop Prematurely</span>
            </v-tooltip>
          </v-col>
          <v-col class="d-flex justify-end">
            <v-btn icon :disabled="!mapElements.nodes.length || layoutInProgress" @click="exportPng">
              <v-icon>mdi-camera</v-icon>
            </v-btn>
            <v-btn icon @click.stop="isOptionsDrawerOpen = !isOptionsDrawerOpen">
              <v-icon>mdi-cog</v-icon>
            </v-btn>
          </v-col>
        </v-row>
      </v-container>
      <v-dialog v-model="isSystemDialogOpen" fullscreen hide-overlay transition="dialog-bottom-transition">
        <v-card>
          <v-toolbar dark color="primary">
            <v-btn icon dark @click="isSystemDialogOpen = false">
              <v-icon>mdi-close</v-icon>
            </v-btn>
            <v-toolbar-title>System Details</v-toolbar-title>
            <v-spacer />
          </v-toolbar>
          <v-card-text v-if="isSystemDialogOpen">
            <system-view v-if="systemId" :system-id="systemId" @jump="setSystem" />
          </v-card-text>
        </v-card>
      </v-dialog>
    </template>
  </div>
</template>

<script>
import { ipcRenderer } from 'electron'

import { mapActions, mapGetters } from 'vuex'

import { interpolateHslLong, quantize } from 'd3-interpolate'

import { cloneDeep as _cloneDeep } from 'lodash'

import { QueryTypes } from 'sequelize'

import cytoscape from 'cytoscape'

import layoutUtilities from 'cytoscape-layout-utilities'
import cxtmenu from 'cytoscape-cxtmenu'

import coseBilkent from 'cytoscape-cose-bilkent'
import fcose from 'cytoscape-fcose'
import cola from 'cytoscape-cola'

import navigator from 'cytoscape-navigator'

import { gameTime } from '~/utilities/aurora'
import { Vector2, Vector3 } from '~/utilities/map'
import { scaleValue } from '~/utilities/math'
import SystemView from '~/components/SystemView.vue'

cytoscape.use(layoutUtilities)
cytoscape.use(cxtmenu)

cytoscape.use(cola)
cytoscape.use(coseBilkent)
cytoscape.use(fcose)

if (typeof cytoscape('core', 'navigator') === 'undefined') {
  navigator(cytoscape)
}

// const secondsPerYear = 31536000
const kmPerAU = 149597870.7

export default {
  components: {
    SystemView,
  },
  data() {
    return {
      layoutInProgress: false,
      isSaveDialogOpen: false,
      isOptionsDrawerOpen: false,

      focusSystemId: null,
      systemViewOption: 0,

      groupingSelection: null,
      groupingOptions: [
        {
          label: 'None',
          value: null,
          icon: 'mdi-close-box',
        },
        {
          label: 'Sector',
          value: 'sector',
          icon: 'mdi-vector-square',
        },
        {
          label: 'Alien Control',
          value: 'control',
          icon: 'mdi-flag',
        },
      ],

      distanceSelection: 'travel',
      distanceOptions: [
        {
          label: 'Travel Distance',
          value: 'travel',
          icon: 'mdi-map-marker-distance',
        },
        {
          label: 'Galactic Distance',
          value: 'galactic',
          icon: 'mdi-creation',
        },
        {
          label: 'Automatic',
          value: null,
          icon: 'mdi-auto-fix',
        },
        {
          label: 'Short',
          value: 'short',
          icon: 'mdi-arrow-top-right-thick',
        },
        {
          label: 'Standard',
          value: 'standard',
          icon: 'mdi-arrow-top-right',
        },
        {
          label: 'Long',
          value: 'long',
          icon: 'mdi-arrow-top-right-thin',
        },
      ],

      // Save Positions
      nodePositions: {},
      isSavingPositions: false,
      executedQueries: 0,
      totalQueries: 0,

      // System Dialog
      isSystemDialogOpen: false,
      systemId: null,

      //

      sectorColorChain: ['#e60049', '#0bb4ff', '#50e991', '#e6d800', '#9b19f5', '#ffa300', '#dc0ab4', '#b3d4ff', '#00bfa0', '#b30000', '#7c1158', '#4421af', '#1a53ff', '#0d88e6', '#00b7c7', '#5ad45a', '#8be04e', '#ebdc78', '#fd7f6f', '#7eb0d5', '#b2e061', '#bd7ebe', '#ffb55a', '#ffee65', '#beb9db', '#fdcce5', '#8bd3c7', '#ea5545', '#f46a9b', '#ef9b20', '#edbf33', '#ede15b', '#bdcf32', '#87bc45', '#27aeef', '#b33dc6'],
      distanceColorChain: ['#00B370', '#27B364', '#47B358', '#69B34C', '#8BB340', '#ACB334', '#FAB733', '#FF8E15', '#FF6E13', '#ff4e11', '#FF2E0F', '#FF0D2D'],

      stylesheet: [
        {
          selector: 'node',
          style: {
            'background-clip': 'none',
            'bounds-expansion': '50px',
            'background-image-containment': 'over',
            'background-image': (node) => {
              const size = node.data('size') || 50
              const isLocked = node.locked()
              //   const stroke = "green"
              //   const strokeWidth = 4
              //   const background = "red"
              //   const cap = "round"              // "round" | "butt" | "square"

              //   const isEmpty = node.data('empty')
              const unexploredConnections = node.data('unexploredConnections')
              //   const percentage = this.showGeologicalSurvey ? node.data('geoPercentage') : this.showGravitationalSurvey ? node.data('gravPercentage') : 0
              const cx = size / 2
              const cy = size / 2
              //   const r = cx - strokeWidth / 2

              //   const startAngle = -Math.PI / 2
              //   const endAngle = startAngle + percentage * 2 * Math.PI

              //   const x0 = cx + r * Math.cos(startAngle)
              //   const y0 = cy + r * Math.sin(startAngle)

              //   const x1 = cx + r * Math.cos(endAngle)
              //   const y1 = cy + r * Math.sin(endAngle)

              //   const laf = percentage > 0.5 ? 1 : 0
              //   const swf = 1

              //   const d = percentage !== 1 && percentage !== 0 ? `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${laf} ${swf} ${x1} ${y1} Z` : ''
              //     // ? `M ${x0} ${y0} A ${r} ${r} 0 1 ${swf} ${cx - r} ${cy}
              //     //   A ${r} ${r} 0 1 ${swf} ${x0} ${y0}`
              //     // : percentage === 0
              //     //   ? "" // no arc
              //     //   : `M ${x0} ${y0} A ${r} ${r} 0 ${laf} ${swf} ${x1} ${y1}`;

              //   // Optional background circle (use background != "none")
              //   const bg = this.showGeologicalSurvey && isEmpty ?
              //     `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255, 255, 255, 0.4)" />`
              //     : background !== "none"
              //       ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${background}" />`
              //       : "";

              //   const slice = this.showGeologicalSurvey && isEmpty ?
              //     `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#777" stroke-width="${strokeWidth}" stroke-alignment="inside" />`
              //     : percentage === 1
              //       ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${stroke}" />`
              //       : percentage === 0
              //         ? "" // no slice
              //         : `<path d="${d}" fill="${stroke}" />`

              // Unexplored Jump Points
              let connections = ''
              for (let iterator = 0; iterator < unexploredConnections; iterator += 1) {
                const radius = 21 + 3 * Math.floor(iterator / 15)
                const xPos = cx + radius * -Math.sin((-32 * iterator * Math.PI) / 180)
                const yPos = cy + radius * -Math.cos((-32 * iterator * Math.PI) / 180)

                connections += `<circle cx="${xPos}" cy="${yPos}" r="3" fill="#Ff7034" />`
              }

              const lockIconSize = size / 3
              const lockIconX = (size - lockIconSize) / 2
              const lockIconY = (size - lockIconSize) / 2
              const lockIconTransform = isLocked ? `translate(${lockIconX}, ${lockIconY}) scale(${lockIconSize / 24})` : ''

              const lockIcon = isLocked ? '<path fill="white" d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" />' : ''
              const lockIconBlack = isLocked ? '<path fill="black" stroke="black" stroke-width="4" d="M 18 8 A 2 2 0 0 1 20 10 V 20 A 2 2 0 0 1 18 22 H 6 A 2 2 0 0 1 4 20 V 10 C 4 8.89 4.9 8 6 8 H 7 V 6 A 5 5 0 0 1 12 1 A 5 5 0 0 1 17 6 V 8 H 18 M 12 3 A 3 3 0 0 0 9 6 V 8 H 15 V 6 A 3 3 0 0 0 12 3 Z" />' : ''

              const lockIconContainer = isLocked ? `<g transform="${lockIconTransform}">${lockIconBlack}${lockIcon}</g>` : ''

              const svg = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${connections}${lockIconContainer}</svg>`)

              return svg
            },
            // 'background-opacity': 0,
            width: (node) => node.data('size') || 30,
            height: (node) => node.data('size') || 30,

            'pie-size': '70%',
            'pie-1-background-color': (node) => {
              const percentage = this.showGeologicalSurvey ? node.data('geoPercentage') : this.showGravitationalSurvey ? node.data('gravPercentage') : 0
              return percentage === 1 ? 'lime' : 'green'
            },
            'pie-1-background-size': (node) => {
              if (node.data('sector')) {
                return '0%'
              }

              const percentage = this.showGeologicalSurvey ? node.data('geoPercentage') : this.showGravitationalSurvey ? node.data('gravPercentage') : 0
              return `${percentage * 100}%`
            },
            'pie-2-background-color': (node) => {
              if (node.data('entirelyEmpty') && this.showGeologicalSurvey) {
                return 'rgba(255, 255, 255, 0.4)'
              }

              return 'red'
            },
            'pie-2-background-size': '100%',

            'background-color': (node) => {
              if (node.data('population') > 0) {
                return '#4A90E2' // Dark sky blue for populated systems
              }

              return '#C8D9DC'
            },

            // LABEL
            label: 'data(name)',
            'font-family': 'Roboto, sans-serif',
            'font-size': '16px',
            'text-wrap': 'none',
            'text-max-width': '60px',

            // 'text-outline-color': 'white',
            // 'text-outline-width': '2px',
            'text-background-color': 'white',
            'text-background-shape': 'round-rectangle',
            'text-background-opacity': 0.4,
            'text-background-padding': '4px',

            'text-valign': 'bottom',
            'text-margin-y': 6,

            'min-zoomed-font-size': 12,
            'text-events': 'yes',
            'box-selection': 'overlap',
          },
        },

        // {
        //   selector: 'node:locked',
        //   style: {
        //     'overlay-color': '#000',
        //     'overlay-padding': '3px',
        //     'overlay-opacity': 0.25,
        //   },
        // },

        {
          selector: ':parent',
          style: {
            shape: 'round-rectangle',
            'background-image': null,
            'pie-size': '0%',

            'background-opacity': 0.45,
            'background-color': 'data(color)',
            // 'border-color': '#2B65EC',

            // 'compound-sizing-wrt-labels': 'include',
          },
        },

        {
          selector: 'node:selected',
          style: {
            'background-color': '#F08080',
            'border-color': 'red',
            label: 'data(name)',
            'font-size': () => (this.graph.nodes(':selected').length > 1 ? '16px' : 20 / this.graph.zoom()),
            'text-background-padding': () => (this.graph.nodes(':selected').length > 1 ? '4px' : 6 / this.graph.zoom()),
            'text-margin-y': () => (this.graph.nodes(':selected').length > 1 ? 6 : 8 / this.graph.zoom()),
            'min-zoomed-font-size': 0,
          },
        },

        {
          selector: 'edge',
          style: {
            width: 6,
            'line-color': this.calculateEdgeColor,
            'curve-style': 'bezier',

            // LABEL
            // label: (edge) => {
            //   return `${edge.data('travelDistance').toFixed(2)} => ${edge.data('scaledTravelDistance').toFixed(2)}`
            // }, // 'data(scaledTravelDistance)',
            'font-family': 'Roboto, sans-serif',
            'font-size': '12px',
            'text-wrap': 'none',
            'text-max-width': '60px',

            'text-background-color': 'white',
            'text-background-shape': 'round-rectangle',
            'text-background-opacity': 0.95,
            'text-background-padding': '2px',

            'text-valign': 'bottom',
            'text-margin-y': 4,

            'min-zoomed-font-size': 12,
            'text-events': 'yes',
            'box-selection': 'overlap',
          },
        },

        {
          selector: 'edge[?stgated][!tsgated]',
          style: {
            'line-style': 'dashed',

            'target-arrow-shape': 'triangle-tee',
            'target-arrow-color': this.calculateEdgeColor,
          },
        },
        {
          selector: 'edge[?tsgated][!stgated]',
          style: {
            'line-style': 'dotted',

            'source-arrow-shape': 'triangle-tee',
            'source-arrow-color': this.calculateEdgeColor,
          },
        },
        {
          selector: 'edge[?stgated][?tsgated]',
          style: {
            'target-arrow-shape': 'chevron',
            'target-arrow-color': this.calculateEdgeColor,

            'source-arrow-shape': 'chevron',
            'source-arrow-color': this.calculateEdgeColor,
          },
        },
        {
          selector: 'edge[!stgated][!tsgated]',
          style: {
            width: 3,
          },
        },

        {
          selector: 'edge.hover',
          style: {
            'line-color': '#dcdc2d', // darker yellow
            'source-arrow-color': '#dcdc2d',
            'target-arrow-color': '#dcdc2d',
          },
        },

        {
          selector: 'edge:selected',
          style: {
            'line-color': '#F08080',
          },
        },
      ],
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'StartYear', 'GameTime']),

    nodeElements() {
      const nodeElements = this.mapElements.nodes.map((node) => {
        const size = this.calculateNodeSize(node)

        return {
          group: 'nodes',
          data: {
            id: node.id,
            name: node.name,
            parent: this.groupingSelection === 'sector' && node.sectorId ? `sector-${node.sectorId}` : this.groupingSelection === 'control' && node.controllerId ? `controller-${node.controllerId}` : null,

            connections: node.connections.size,
            unexploredConnections: node.unexploredConnections,

            empty: node.empty,
            entirelyEmpty: node.entirelyEmpty,

            geoPercentage: node.geoPercentage,
            gravPercentage: node.gravPercentage,

            populationNumber: node.populationNumber,
            population: node.population,
            capital: node.capital,

            discovered: node.discovered,

            size,
          },
          // position: { ...this.mapElements.positions[node.id] } || {
          //   x: node.mapX,
          //   y: node.mapY,
          // },
        }
      })

      return nodeElements
    },

    linkElements() {
      const linkElements = this.mapElements.links.map((link) => {
        const normalizedTravelDistance = (link.travelDistance * kmPerAU) / 1000000000 // in billions of km

        return {
          group: 'edges',
          data: {
            id: link.id,
            source: link.source,
            target: link.target,

            stgated: link.stgated,
            tsgated: link.tsgated,

            galacticDistance: link.galacticDistance,

            travelDistance: normalizedTravelDistance,
            scaledTravelDistance: scaleValue(normalizedTravelDistance),
          },
        }
      })

      return linkElements
    },

    homeSystem() {
      console.log('Finding home system', this.nodeElements)

      if (!this.nodeElements.length) {
        return null
      }

      const capitalSystem = this.nodeElements.find((node) => node.data.capital)
      if (capitalSystem) {
        return capitalSystem
      }

      const firstSystem = this.nodeElements[0]

      return firstSystem
    },

    // Distances
    numericDistance() {
      if (this.distanceSelection === 'short') {
        return 100
      }

      if (this.distanceSelection === 'standard') {
        return 200
      }

      if (this.distanceSelection === 'long') {
        return 300
      }

      return null
    },
    respectGalacticDistances() {
      return this.distanceSelection === 'galactic'
    },
    respectTravelDistances() {
      return this.distanceSelection === 'travel'
    },

    showGeologicalSurvey() {
      return this.systemViewOption === 0
    },
    showGravitationalSurvey() {
      return this.systemViewOption === 1
    },
  },
  watch: {
    systemViewOption: {
      immediate: true,
      handler() {
        if (this.graph) {
          this.graph.style(this.stylesheet)
        }
      },
    },

    groupingSelection: {
      immediate: true,
      handler(_value) {
        if (this.layoutInProgress && this.layoutInstance) {
          this.layoutInstance.stop()
          this.layoutInstance = null
          this.layoutInProgress = false
        }

        this.initializeGraphElements()
      },
    },

    mapElements: {
      immediate: true,
      handler(data) {
        if (!data.nodes.length) {
          return
        }

        if (!this.graph && this.GameID && this.RaceID) {
          this.initializeGraph()
        }

        if (this.graph) {
          this.initializeGraphElements()
        }
      },
    },
  },
  mounted() {
    if (!this.GameID || !this.RaceID) {
      return
    }

    this.initializeGraph()
  },
  beforeDestroy() {
    if (this.graph) {
      this.graph.destroy()
    }
  },
  methods: {
    ...mapActions('snackbar', ['activateSnackbar']),

    initializeGraph() {
      this.graph = cytoscape({
        container: document.getElementById('cytoscape'),

        layout: {
          name: 'preset',
        },

        // renderer: {
        //   name: 'canvas',
        //   webgl: true,
        //   showFps: true,
        // },

        style: this.stylesheet,
      })

      this.graph.layoutUtilities({
        idealEdgeLength: 100,
        desiredAspectRatio: this.graph.width() / this.graph.height(),
        utilityFunction: 1,
      })

      this.graph.on('mouseover', 'edge', (event) => {
        event.target.addClass('hover')
      })
      this.graph.on('mouseout', 'edge', (event) => {
        event.target.removeClass('hover')
      })

      this.graph.navigator({
        container: '.cytoscape-navigator',
        viewLiveFramerate: 0,
        thumbnailEventFramerate: 30,
        thumbnailLiveFramerate: false,
        dblClickDelay: 200,
        removeCustomContainer: false,
        rerenderDelay: 100,
      })

      this.graph.cxtmenu({
        menuRadius: 100,
        selector: 'node:selectable',
        fillColor: 'rgba(0, 137, 123, 0.85)',
        indicatorSize: 36,
        maxSpotlightRadius: 100,
        commands: (node) => {
          let selectedNodes = this.graph.nodes(':selected')
          if (!selectedNodes.contains(node)) {
            selectedNodes.unselect()

            selectedNodes = this.graph.collection().union(node)
            selectedNodes.select()
          }

          const commands = []

          const nonEmptySelectedNodes = selectedNodes.filter((node) => !node.data('entirelyEmpty'))
          if (nonEmptySelectedNodes.length) {
            commands.push({
              content: '<span><i class="v-icon mdi mdi-diamond-stone"></i></span>',
              select: () => {
                const systemIds = nonEmptySelectedNodes.map((node) => node.data('id'))

                this.$router.push({
                  path: 'minerals',
                  query: {
                    systems: systemIds.join(','),
                  },
                })
              },
            })

            commands.push({
              content: '<span><i class="v-icon mdi mdi-earth"></i></span>',
              select: () => {
                const systemIds = nonEmptySelectedNodes.map((node) => node.data('id'))

                this.$router.push({
                  path: 'habitability',
                  query: {
                    systems: systemIds.join(','),
                  },
                })
              },
            })
          }

          const nodesAreLocked = selectedNodes.allAre(':locked')
          if (nodesAreLocked) {
            commands.push({
              content: '<span><i class="v-icon mdi mdi-lock-open-variant"></i></span>',
              select: () => {
                selectedNodes.unlock()
              },
            })
          } else {
            commands.push({
              content: '<span><i class="v-icon mdi mdi-lock"></i></span>',
              select: () => {
                selectedNodes.lock()
              },
            })
          }

          if (selectedNodes.length === 1) {
            commands.push({
              content: '<span><i class="v-icon mdi mdi-orbit"></i></span>',
              select: () => {
                this.openSystemDialog(selectedNodes[0].data('id'))
                // this.systemId = selectedNodes[0].data('id')
                // this.isSystemDialogOpen = true
              },
            })
          }

          return commands
        },
      })
    },

    initializeGraphElements() {
      if (!this.graph) {
        return
      }

      let groupElements = []
      if (this.groupingSelection === 'sector') {
        groupElements = this.sectors.reduce((sectors, sector) => {
          if (sector.systems) {
            sectors.push({
              group: 'nodes',
              data: {
                id: `sector-${sector.id}`,
                name: sector.name,
                color: sector.color,

                sector: true,
              },
              grabbable: false,
              selectable: false,
              pannable: true,
            })
          }

          return sectors
        }, [])
      } else if (this.groupingSelection === 'control') {
        groupElements = this.controllers.map((controller) => {
          return {
            group: 'nodes',
            data: {
              id: `controller-${controller.id}`,
              name: controller.name || 'Unknown',
              color: this.sectorColorChain[controller.id % this.sectorColorChain.length],

              controller: true,
            },
            grabbable: false,
            selectable: false,
            pannable: true,
          }
        })
      }

      this.graph.elements().remove()

      const nodes = _cloneDeep(this.nodeElements)
      const links = _cloneDeep(this.linkElements)

      console.log('Node Elements', nodes.filter((n) => n.data.parent))

      this.graph.add(groupElements)
      this.graph.add([...nodes, ...links])

      console.log('Elements Added', [...groupElements, ...nodes, ...links])

      this.nodePositions = { ...this.mapElements.positions }

      if (!this.homeSystem) {
        this.activateSnackbar({
          color: 'warning',
          text: 'No systems to display',
        })

        return
      }

      // // Prepare dijkstra
      // this.dijkstra = this.graph.elements().dijkstra(`#${this.homeSystem.data.id}`)

      // let longestShortestDistance = 0
      // const exploredNodes = new Set([this.homeSystem.data.id])
      // this.graph.nodes().forEach((node) => {
      //   if (exploredNodes.has(node.id())) {
      //     return
      //   }

      //   exploredNodes.add(node.id())

      //   const shortestDistance = this.dijkstra.distanceTo(node)

      //   if (shortestDistance !== Infinity && shortestDistance > longestShortestDistance) {
      //     longestShortestDistance = shortestDistance
      //   }
      // })
      // console.log('Longest Shortest Distance', longestShortestDistance)

      // this.distanceColorChain = quantize(interpolateHslLong('lime', 'red'), longestShortestDistance)
      // console.log('Distance Scale', this.distanceColorChain)

      // Make walk map
      const fromOriginDistances = {}
      const centerToPointDistances = {}

      // Prepare centerToPoint distances
      for (const jumpPoint of this.mapElements.jumpPoints) {
        if (!jumpPoint.destinationSystemId) {
          continue
        }

        if (!centerToPointDistances[jumpPoint.sourceSystemId]) {
          centerToPointDistances[jumpPoint.sourceSystemId] = {}
        }

        centerToPointDistances[jumpPoint.sourceSystemId][jumpPoint.destinationSystemId] = (jumpPoint.distance * kmPerAU) / 1000000000 // in billions of km
      }

      console.log('Center to Point Distances Computed', centerToPointDistances)

      const jumpPointBySourceAndDestination = new Map()
      for (const jumpPoint of this.mapElements.jumpPoints) {
        jumpPointBySourceAndDestination.set(`${jumpPoint.sourceSystemId}-${jumpPoint.destinationSystemId}`, jumpPoint)
      }

      const calculateChainDistance2 = (chain, lastHopToCenter = true) => {
        let totalDistance = 0

        for (let i = 0; i < chain.length; i += 1) {
          const system = chain[i]

          const previousIndex = i - 1
          const nextIndex = i + 1

          const previousSystem = previousIndex >= 0 ? chain[previousIndex] : null
          const nextSystem = nextIndex < chain.length ? chain[nextIndex] : null

          if (!previousSystem && !nextSystem) {
            console.error('### NO PREVIOUS OR NEXT?', system.data(), chain)

            continue
          }

          if (!previousSystem) {
            totalDistance += centerToPointDistances[system.id()]?.[nextSystem.id()] || 0

            continue
          }

          if (!nextSystem) {
            if (lastHopToCenter) {
              totalDistance += centerToPointDistances[system.id()]?.[previousSystem.id()] || 0
            }

            continue
          }

          // const jumpPointToPrevious = this.mapElements.jumpPoints.find((jp) => {
          //   return jp.sourceSystemId === system.id() && jp.destinationSystemId === previousSystem.id()
          // })
          const jumpPointToPrevious = jumpPointBySourceAndDestination.get(`${system.id()}-${previousSystem.id()}`)

          // const jumpPointToNext = this.mapElements.jumpPoints.find((jp) => {
          //   return jp.sourceSystemId === system.id() && jp.destinationSystemId === nextSystem.id()
          // })
          const jumpPointToNext = jumpPointBySourceAndDestination.get(`${system.id()}-${nextSystem.id()}`)

          if (!jumpPointToPrevious || !jumpPointToNext) {
            console.error('### MISSING JUMP POINTS?', system.data(), previousSystem.data(), nextSystem.data(), jumpPointToPrevious, jumpPointToNext)
            continue
          }

          totalDistance += new Vector2(jumpPointToPrevious.mapX, jumpPointToPrevious.mapY).distanceTo(new Vector2(jumpPointToNext.mapX, jumpPointToNext.mapY)) / 1_000_000_000
        }

        return totalDistance
      }

      const bestByState = new Map()
      const enteredChainSignatures = new Set()

      // Depth fuse: no simple path can be longer than number of nodes
      const maxDepth = this.graph.nodes().length

      const process = (node, chain, distances) => {
        // Fuse: bail if ever beyond the simple-path upper bound
        if (chain.length > maxDepth) {
          return distances
        }

        const chainSignature = chain.map((n) => n.id()).join('>')
        if (enteredChainSignatures.has(chainSignature)) {
          console.log('Already Entered Chain Signature', chainSignature)

          return distances
        }

        enteredChainSignatures.add(chainSignature)

        // if (chain.length > 1) {
        //   const callingNode = chain[chain.length - 2]
        //   console.log(`Processing Node ${node.data('name')} (${node.id()}) From Node ${callingNode.data('name')} (${callingNode.id()}) Chain Length ${chain.length} Distances So Far ${Object.keys(distances).length}`)
        //   // console.log('Chain Signature', chainSignature)
        // } else {
        //   console.log(`Processing Initial Node ${node.data('name')} (${node.id()}) Chain Length ${chain.length} Distances So Far ${Object.keys(distances).length}`)
        // }

        const neighbors = node.neighborhood('node')

        neighbors.forEach((neighbor) => {
          const neighborId = neighbor.id()
          if (chain.contains(neighbor)) {
            return
          }

          const newChain = chain.union(neighbor)

          const previousId = node.id()
          const stateKey = `${neighborId}|${previousId}`

          const newDistance = calculateChainDistance2(newChain)

          // If we have already found an equal or better way to enter this state, prune
          if (newDistance >= (bestByState.get(stateKey) ?? Infinity)) {
            return
          }

          bestByState.set(stateKey, newDistance)

          if (!distances[neighborId]) {
            const previousDistance = chain.length > 1 ? calculateChainDistance2(chain, false) : 0

            distances[neighborId] = {
              name: neighbor.data('name'),
              distance: newDistance,
              hopDistance: newDistance - previousDistance,
              chain: newChain.toArray(),
              chainNames: newChain.map((n) => n.data('name')),
            }
          } else {
            const existingDistance = distances[neighborId].distance

            if (newDistance < existingDistance) {
              const previousDistance = chain.length > 1 ? calculateChainDistance2(chain, false) : 0

              distances[neighborId] = {
                name: neighbor.data('name'),
                distance: newDistance,
                hopDistance: newDistance - previousDistance,
                chain: newChain.toArray(),
                chainNames: newChain.map((n) => n.data('name')),
              }
            }
          }

          process(neighbor, newChain, distances)
        })

        // if (chain.length > 1) {
        //   console.log('Completed Node', node.data('name'), 'From Node', chain[chain.length - 2].data('name'), 'Distances So Far', Object.keys(distances).length)
        // } else {
        //   console.log('Completed Initial Node', node.data('name'), 'Distances So Far', Object.keys(distances).length)
        // }

        return distances
      }

      const distanceNodes = this.graph.nodes(`#${this.homeSystem.data.id}`)
      for (let i = 0; i < distanceNodes.length; i += 1) {
        const startNode = distanceNodes[i]

        fromOriginDistances[startNode.id()] = process(startNode, this.graph.collection().union(startNode), {})
      }

      console.log('From Origin Distances Computed', fromOriginDistances)

      const capitalDistances = fromOriginDistances[this.homeSystem.data.id]
      for (const edge of this.graph.edges()) {
        const source = this.graph.getElementById(edge.data('source'))
        const target = this.graph.getElementById(edge.data('target'))

        const sourceDistance = capitalDistances[source.id()]
        const targetDistance = capitalDistances[target.id()]

        const sourceDistanceHasTarget = sourceDistance && sourceDistance.chainNames[sourceDistance.chainNames.length - 2] === target.data('name')
        const targetDistanceHasSource = targetDistance && targetDistance.chainNames[targetDistance.chainNames.length - 2] === source.data('name')

        const sourceDistanceHopTarget = sourceDistanceHasTarget ? sourceDistance.hopDistance : null
        const targetDistanceHopSource = targetDistanceHasSource ? targetDistance.hopDistance : null

        if (sourceDistanceHopTarget && targetDistanceHopSource) {
          if (sourceDistanceHopTarget < targetDistanceHopSource) {
            edge.data('travelDistance', sourceDistanceHopTarget)
          } else {
            edge.data('travelDistance', targetDistanceHopSource)
          }
        } else if (sourceDistanceHopTarget) {
          edge.data('travelDistance', sourceDistanceHopTarget)
        } else if (targetDistanceHopSource) {
          edge.data('travelDistance', targetDistanceHopSource)
        } else {
          const distance = calculateChainDistance2([source, target])

          edge.data('travelDistance', distance)
        }

        edge.data('scaledTravelDistance', scaleValue(edge.data('travelDistance')))
      }

      this.fromOriginDistances = fromOriginDistances
      this.capitalDistances = capitalDistances

      const capitalDistanceValues = Object.values(capitalDistances)
      if (capitalDistanceValues.length) {
        const longestChain = Math.max(...capitalDistanceValues.map((d) => d.chain.length - 1))
        // console.log('Longest Chain', longestChain)

        this.distanceColorChain = quantize(interpolateHslLong('lime', 'red'), longestChain)
        // console.log('Distance Scale', this.distanceColorChain)
      } else {
        this.distanceColorChain = ['lime', 'red']
      }

      this.graph.fit()

      const unpositionedNodes = this.graph.nodes().filter((node) => {
        const id = node.data('id')
        const systemPosition = this.nodePositions[id]

        return node.data('id') !== this.homeSystem.data.id && systemPosition && !systemPosition.x && !systemPosition.y
      })
      console.log('Unpositioned Nodes', unpositionedNodes.length)

      this.graph
        .layout({
          name: 'preset',
          positions: this.nodePositions,
          randomize: false,
          fit: true,
          animate: false,
        })
        .run()

      unpositionedNodes
        .layout({
          name: 'fcose',

          randomize: false,
          fit: false,
          avoidOverlap: true,

          nodeDimensionsIncludeLabels: false,
          // uniformNodeDimensions: true,
          quality: 'proof',
          numIter: 16000,
          animate: true,
          animationDuration: 600,
          animationEasing: 'ease-in',

          nodeSeparation: 150,

          ...(this.distanceSelection
            ? {
                idealEdgeLength: this.numericDistance,
              }
            : {}),

          nodeRepulsion: 15000,
          edgeElasticity: 1,
          nestingFactor: 0,
          gravity: 0.1,
        })
        .run()
    },

    addNextNode() {
      if (this.currentNodeIndex + 1 >= this.nodeElements.length || this.currentNodeIndex > this.nodeLimit) {
        return
      }

      this.currentNodeIndex += 1

      const nodeElement = this.nodeElements[this.currentNodeIndex]

      const extantNodeIds = [...this.graph.nodes().map((node) => node.id()), nodeElement.data.id]
      const relevantLinkElements = this.linkElements.filter((linkElement) => {
        return extantNodeIds.includes(linkElement.data.source) && extantNodeIds.includes(linkElement.data.target)
      })

      const nodeLinks = relevantLinkElements.filter((linkElement) => {
        return linkElement.data.target === nodeElement.data.id || linkElement.data.source === nodeElement.data.id
      })
      const randomLink = nodeLinks.length ? nodeLinks[Math.floor(Math.random() * nodeLinks.length)] : null

      if (randomLink) {
        const otherSide = randomLink.data.source === nodeElement.data.id ? randomLink.data.target : randomLink.data.source
        const otherSideNode = this.graph.getElementById(otherSide)
        const otherSideNodeRenderedPosition = otherSideNode.renderedPosition()
        nodeElement.renderedPosition = {
          x: otherSideNodeRenderedPosition.x,
          y: otherSideNodeRenderedPosition.y,
        }

        console.log(this.currentNodeIndex, this.nodeLimit)
        // console.log(randomLink, otherSideNode, nodeLinks)
      }
      this.graph.add(nodeElement)

      this.graph.edges().remove()
      relevantLinkElements.forEach((linkElement) => {
        this.graph.add(linkElement)
      })

      this.graph
        .layout({
          // name: 'euler',

          // name: 'avsdf',

          // name: 'cose-bilkent',

          name: 'fcose',

          // name: 'elk',
          // elk: {
          //   algorithm: 'stress',

          //   // algorithm: 'layered',
          //   // 'elk.direction': 'DOWN',
          // },

          // name: 'cola',

          randomize: false,
          fit: false,
          avoidOverlap: true,

          nodeDimensionsIncludeLabels: true,
          uniformNodeDimensions: true,
          // quality: 'proof',
          // numIter: 6000,
          animate: true,
          animationDuration: 100,
          animationEasing: 'ease-in',

          nodeSeparation: 150,

          ...(this.distanceSelection
            ? {
                idealEdgeLength: this.numericDistance,
              }
            : {}),

          nodeRepulsion: 15000,
          edgeElasticity: 1,
          nestingFactor: 0,
          gravity: 0.1,
        })
        .run()
    },

    stepOne() {
      this.nodeLimit += 1
      this.addNextNode()
    },

    focusHomeSystem() {
      if (!this.graph || !this.nodeElements.length) {
        return
      }

      this.graph.zoom(1.5)

      console.log(this.homeSystem)

      const homeSystemNode = this.graph.getElementById(this.homeSystem.data.id)
      if (homeSystemNode) {
        this.graph.center(homeSystemNode)
      }
    },

    fitView() {
      if (!this.graph || !this.nodeElements.length) {
        return
      }

      this.graph.fit()
    },

    applyForces() {
      if (!this.graph || !this.nodeElements.length) {
        return
      }

      this.graph.one('layoutstop', () => {
        this.layoutInstance = null
        this.layoutInProgress = false
      })

      this.layoutInProgress = true

      this.layoutInstance = this.graph.layout({
        // name: 'euler',

        // name: 'avsdf',

        // name: 'cose-bilkent',

        name: 'fcose',

        // name: 'elk',
        // elk: {
        //   algorithm: 'stress',

        //   // algorithm: 'layered',
        //   // 'elk.direction': 'DOWN',
        // },

        // name: 'cola',

        randomize: false,
        fit: false,
        avoidOverlap: true,

        nodeDimensionsIncludeLabels: false,
        // uniformNodeDimensions: true,
        quality: 'proof',
        numIter: 16000,
        animate: true,
        animationDuration: 1600,
        animationEasing: 'ease-out',

        // nodeSeparation: 150,

        ...(this.distanceSelection
          ? {
              idealEdgeLength: (edge) => {
                const distance = this.respectGalacticDistances ? edge.data('galacticDistance') ?? 200 : this.respectTravelDistances ? edge.data('scaledTravelDistance') ?? 200 : this.numericDistance

                return distance
              },
            }
          : {}),

        nodeRepulsion: 15000,
        edgeElasticity: 1,
        nestingFactor: 0,
        gravity: 0.1,
      })

      this.layoutInstance.run()
    },

    scramble() {
      if (!this.graph || !this.nodeElements.length) {
        return
      }

      this.graph.one('layoutstop', () => {
        this.layoutInstance = null
        this.layoutInProgress = false
      })

      this.layoutInProgress = true

      this.layoutInstance = this.graph.layout({
        name: 'cola',

        randomize: false,
        fit: false,
        avoidOverlap: false,
        handleDisconnected: true,
        centerGraph: false,

        // nodeDimensionsIncludeLabels: false,
        // uniformNodeDimensions: true,
        // quality: 'proof',
        // numIter: 25000,
        animate: true,
        refresh: 10,
        // animationDuration: 2600,
        animationEasing: 'ease-out',

        ...(this.distanceSelection
          ? {
              edgeLength: (edge) => {
                const distance = this.respectGalacticDistances ? edge.data('galacticDistance') ?? 200 : this.respectTravelDistances ? edge.data('scaledTravelDistance') ?? 200 : this.numericDistance

                return distance
              },
            }
          : {}),

        nodeSpacing: 0,
        maxIterations: 5000,
        maxSimulationTime: 25000,
      })

      this.layoutInstance.run()
    },

    stopLayout() {
      if (this.layoutInstance) {
        this.layoutInstance.stop()
        this.layoutInstance = null
      }

      this.layoutInProgress = false
    },

    applySavedPositions() {
      if (!this.graph || !Object.keys(this.nodePositions)) {
        return
      }

      this.graph.one('layoutstop', () => {
        this.layoutInProgress = false
      })

      this.layoutInProgress = true

      this.layoutInstance = this.graph.layout({
        name: 'preset',
        positions: this.nodePositions,
        randomize: false,
        fit: true,
        animate: true,
        animationDuration: 800,
        animationEasing: 'ease-out',
      })

      this.layoutInstance.run()
    },

    async savePositions() {
      this.isSavingPositions = true

      // await this.database.saveMapPositions(this.mapElements.positions)

      const nodes = this.graph.nodes().filter((node) => !node.isParent())

      this.totalQueries = nodes.length
      this.executedQueries = 0

      try {
        for (const node of nodes) {
          console.log(node.id(), node.position())
          const id = node.id()
          const position = node.position()
          const query = `UPDATE FCT_RaceSysSurvey SET Xcor = ${Math.round(position.x)}, Ycor = ${Math.round(position.y)} WHERE GameID = ${this.GameID} AND RaceID = ${this.RaceID} AND SystemID = ${id}`

          console.log('Executing query:', query)

          await this.database.query(query, {
            type: QueryTypes.UPDATE,
          })
          // await new Promise((resolve) => setTimeout(resolve, 125))
          this.executedQueries += 1

          this.nodePositions[id] = { x: position.x, y: position.y }
        }

        this.activateSnackbar({
          color: 'success',
          text: 'Positions saved successfully!',
        })
      } catch (error) {
        console.error('Error saving positions:', error)

        this.activateSnackbar({
          color: 'error',
          text: 'Error saving positions',
        })
      } finally {
        this.isSaveDialogOpen = false
        this.isSavingPositions = false
      }
    },

    exportPng() {
      const pngData = this.graph.png({
        output: 'base64',
        full: true,
        scale: 2,
      })

      ipcRenderer
        .invoke('save-png', pngData, `map-${this.GameID}-${this.RaceID}-${this.GameTime}.png`)
        .then((result) => {
          if (!result?.canceled) {
            this.activateSnackbar({
              color: 'success',
              text: 'Map exported as PNG successfully!',
            })
          }
        })
        .catch((err) => {
          console.error('Error during save', err)
          this.activateSnackbar({
            color: 'error',
            text: 'Error during image save',
          })
        })
    },

    calculateNodeSize(node) {
      const baseSize = 50
      const maxSize = 120

      const normalizedPopulationNumber = Math.log1p(Math.max(0, node.populationNumber)) / Math.log1p(100)
      const normalizedPopulation = Math.log1p(Math.max(0, node.population)) / Math.log1p(10000)

      const blendedNormalization = Math.exp(0.3 * Math.log(Math.max(1e-9, normalizedPopulationNumber)) + 0.7 * Math.log(Math.max(1e-9, normalizedPopulation)))
      const saturatedNormalization = blendedNormalization / (1 + blendedNormalization)

      const size = baseSize + (maxSize - baseSize) * saturatedNormalization

      return size
    },

    getEdgeColor(edge) {
      if (this.capitalDistances) {
        const source = edge.source()
        const target = edge.target()

        // console.log('Edge', edge.data(), source.data(), target.data(), this.capitalDistances[source.id()], this.capitalDistances[target.id()])

        const sourceDistance = this.capitalDistances[source.id()]?.chain.length ?? 0 // this.dijkstra.distanceTo(source)
        const targetDistance = this.capitalDistances[target.id()]?.chain.length ?? 0 // this.dijkstra.distanceTo(target)

        if (sourceDistance !== Infinity && targetDistance !== Infinity) {
          const minDistance = Math.min(sourceDistance, targetDistance)
          const distanceIndex = Math.min(minDistance, this.distanceColorChain.length - 1)

          return this.distanceColorChain[distanceIndex]
        } else {
          return '#777'
        }
      } else {
        return '#777'
      }
    },
    calculateEdgeColor(edge) {
      if (typeof this.calculateEdgeColor.cache === 'undefined') {
        this.calculateEdgeColor.cache = {}
      }

      const edgeId = edge.data('id')
      if (!this.calculateEdgeColor.cache[edgeId]) {
        const color = this.getEdgeColor(edge)
        this.calculateEdgeColor.cache[edgeId] = color
      }

      return this.calculateEdgeColor.cache[edgeId]
    },

    openSystemDialog(systemId) {
      this.systemId = systemId
      this.isSystemDialogOpen = true
    },
    setSystem(systemId) {
      this.systemId = systemId
    },
  },
  asyncComputed: {
    sectors: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const sectors = await this.database.query(`select FCT_SectorCommand.*, count(FCT_RaceSysSurvey.SectorID) as SectorSystems from FCT_SectorCommand left join FCT_RaceSysSurvey on FCT_SectorCommand.SectorCommandID = FCT_RaceSysSurvey.SectorID where FCT_SectorCommand.GameID = ${this.GameID} and FCT_SectorCommand.RaceID = ${this.RaceID} group by FCT_SectorCommand.SectorCommandID`).then(([items]) => {
          return items.map((item) => ({
            id: String(item.SectorCommandID),
            name: item.SectorName,

            systems: item.SectorSystems,

            color: this.sectorColorChain[item.SectorCommandID % this.sectorColorChain.length],
          }))
        })

        console.log('Sectors', sectors)

        return sectors
      },
      default: [],
    },
    controllers: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const controllers = await this.database.query(`
          select FCT_RaceSysSurvey.ControlRaceID, FCT_AlienRace.AlienRaceName from FCT_RaceSysSurvey

          left join FCT_Race on FCT_Race.RaceID = FCT_RaceSysSurvey.ControlRaceID
          left join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}

          where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.ControlRaceID IS NOT NULL and FCT_RaceSysSurvey.ControlRaceID <> 0
          group by FCT_RaceSysSurvey.ControlRaceID
        `).then(([items]) => {
          return items.map((item) => ({
            id: String(item.ControlRaceID),
            name: item.AlienRaceName || `Unknown #${item.ControlRaceID}`,
          }))
        })

        console.log('Controllers', controllers)

        return controllers
      },
      default: [],
    },
    mapElements: {
      async get() {
        if (!this.database || !this.GameID) {
          return {
            nodes: [],
            positions: {},
            jumpPoints: [],
            links: [],
          }
        }

        const nodes = await this.database
          .query(`
            select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.SectorID, FCT_SectorCommand.SectorName, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.DiscoveredTime, FCT_RaceSysSurvey.ControlRaceID, FCT_AlienRace.AlienRaceName, DIM_KnownSystems.X, DIM_KnownSystems.Y, DIM_KnownSystems.Z, VIR_GeologicalSurvey.PlanetaryBodies, VIR_GeologicalSurvey.SystemBodies, VIR_GeologicalSurvey.SurveyedSystemBodies, VIR_GravitationalSurvey.SurveyLocations, VIR_GravitationalSurvey.SurveyedSurveyLocations, VIR_Population.PopulationNumber, VIR_Population.Population, VIR_Population.Capital from FCT_RaceSysSurvey

            left join (
              select FCT_SystemBody.SystemID, sum(CAST(CASE WHEN FCT_SystemBody.BodyClass IN (1, 2) THEN 1 ELSE 0 END AS INT)) as PlanetaryBodies, sum(CAST(CASE WHEN FCT_SystemBody.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT)) as SystemBodies, sum(CAST(CASE WHEN FCT_SystemBodySurveys.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyedSystemBodies from FCT_SystemBody left join FCT_SystemBodySurveys on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} where FCT_SystemBody.GameID = ${this.GameID} group by FCT_SystemBody.SystemID
            ) as VIR_GeologicalSurvey on FCT_RaceSysSurvey.SystemID = VIR_GeologicalSurvey.SystemID

            left join (
              select FCT_SurveyLocation.SystemID, sum(CAST(CASE WHEN FCT_SurveyLocation.SystemID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyLocations, sum(CAST(CASE WHEN FCT_RaceSurveyLocation.SystemID IS NULL THEN 0 ELSE 1 END AS BIT)) as SurveyedSurveyLocations from FCT_SurveyLocation left join FCT_RaceSurveyLocation on FCT_SurveyLocation.SystemID = FCT_RaceSurveyLocation.SystemID and FCT_SurveyLocation.LocationNumber = FCT_RaceSurveyLocation.LocationNumber and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID
            ) as VIR_GravitationalSurvey on FCT_RaceSysSurvey.SystemID = VIR_GravitationalSurvey.SystemID

            left join (
              select FCT_Population.SystemID, FCT_Population.Capital, count(FCT_Population.PopulationID) as PopulationNumber, sum(FCT_Population.Population) as Population from FCT_Population
              where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemID
            ) as VIR_Population on FCT_RaceSysSurvey.SystemID = VIR_Population.SystemID

            left join FCT_SectorCommand on FCT_SectorCommand.SectorCommandID = FCT_RaceSysSurvey.SectorID 

            left join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID
            left join DIM_KnownSystems on DIM_KnownSystems.KnownSystemID = FCT_System.SystemNumber
            left join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID}

            where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}
          `)
          .then(([items]) => {
            console.log('DB Systems', items)

            return items.map((item) => ({
              id: String(item.SystemID),
              name: item.Name,

              mapX: item.Xcor,
              mapY: item.Ycor,

              galacticPosition: item.X !== null ? new Vector3(item.X, item.Y, item.Z).multiplyScalar(18) : null,

              gravPercentage: item.SurveyLocations ? item.SurveyedSurveyLocations / item.SurveyLocations : 0,
              geoPercentage: item.SystemBodies ? item.SurveyedSystemBodies / item.SystemBodies : 0,
              empty: !item.PlanetaryBodies,
              entirelyEmpty: !item.SystemBodies,

              populationNumber: item.PopulationNumber || 0,
              population: item.Population || 0,
              capital: !!item.Capital,

              sectorId: item.SectorID,
              sector: item.SectorName,

              controllerId: item.ControlRaceID,
              controller: item.AlienRaceName || (item.ControlRaceID ? 'Unknown' : 'Uncontrolled'),

              discovered: gameTime(this.StartYear, item.DiscoveredTime).format('YYYY-MM-DD HH:mm:ss'),

              neighbors: new Set(),
              connections: new Set(),

              unexploredConnections: 0,
            }))
          })

        console.log('Nodes', nodes)

        const positions = nodes.reduce((aggregate, node) => {
          if (node.mapX != null && node.mapY != null) {
            aggregate[node.id] = {
              x: node.mapX,
              y: node.mapY,
            }
          }
          return aggregate
        }, {})

        console.log('Positions', positions)

        const jumpPoints = await this.database.query(`select FCT_JumpPoint.*, VIR_Destination.SystemID as DestinationID, FCT_RaceSysSurvey.Name, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.Charted, FCT_RaceJumpPointSurvey.Hide from FCT_JumpPoint inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_JumpPoint as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID left join FCT_RaceJumpPointSurvey on FCT_JumpPoint.WarpPointID = FCT_RaceJumpPointSurvey.WarpPointID and FCT_Race.RaceID = FCT_RaceJumpPointSurvey.RaceID where FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1`).then(([items]) => {
          console.log('DB Jump Points', items)

          return items.map((item) => ({
            id: String(item.WarpPointID),
            linkedId: item.WPLink ? String(item.WPLink) : null,

            sourceSystemId: String(item.SystemID),
            destinationSystemId: item.DestinationID !== null ? String(item.DestinationID) : null,

            distance: item.Distance,
            bearing: item.Bearing,

            mapX: item.Xcor,
            mapY: item.Ycor,

            // calculatedDistance: new Vector2(item.Xcor, item.Ycor).length() / kmPerAU,

            stable: !!item.JumpGateStrength,
            stabilizedBy: item.JumpGateRaceID,

            explored: !!item.Explored,
            charted: !!item.Charted,
            hidden: !!item.Hide,
          }))
        })

        console.log('Jump Points', jumpPoints)

        const links = jumpPoints.reduce((aggregate, item) => {
          const origin = nodes.find((node) => node.id === item.sourceSystemId)
          const destination = nodes.find((node) => node.id === item.destinationSystemId)

          if (origin && destination && item.explored) {
            let extant = aggregate.find((link) => link.target === origin.id && link.source === destination.id)

            if (extant) {
              extant.tsgated = item.stable
              extant.travelDistance += item.distance
            } else {
              extant = {
                id: `link-${origin.id}-${destination.id}`,
                source: origin.id,
                target: destination.id,

                sourceName: origin.name,
                targetName: destination.name,

                stgated: item.stable,
                tsgated: false,

                galacticDistance: origin.galacticPosition && destination.galacticPosition ? origin.galacticPosition.distanceTo(destination.galacticPosition) : null,
                travelDistance: item.distance,
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

        console.log('Links', links)

        return {
          nodes,
          positions,
          jumpPoints,
          links,
        }
      },
      default: {
        nodes: [],
        positions: {},
        jumpPoints: [],
        links: [],
      },
    },
  },
}
</script>

<style lang="scss">
#cytoscape {
  background: #fafafa;
  background-image: radial-gradient(#bebebe 1px, transparent 0);
  background-size: 18px 18px;

  border: 1px solid #ccc;
  border-radius: 8px;
  box-sizing: border-box;

  &.dark {
    background: #05050a;
    background-image: radial-gradient(#3a3a3a 1px, transparent 0);
    background-size: 18px 18px;

    border: 1px solid #333;
  }
}

.cytoscape-navigator {
  position: absolute;
  border: 1px solid #000;
  z-index: 5;
  bottom: 12px;
  right: 12px;
  overflow: hidden;

  border: 2px solid #bebebe !important;
  background: white !important;
  height: 15vh !important;
  width: 15vw !important;

  &.dark {
    border: 2px solid #333 !important;
    background: #222 !important;
  }
}

.cytoscape-navigator > img {
  max-width: 100%;
  max-height: 100%;
}

.cytoscape-navigator > canvas {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 101;
}

.cytoscape-navigatorView {
  position: absolute;
  top: 0;
  left: 0;
  cursor: move;
  background: #b7e1ed;
  -moz-opacity: 0.5;
  opacity: 0.5;
  z-index: 102;
}

.cytoscape-navigatorOverlay {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 103;
}

// #cytoscape-navigator {
//   position: absolute;
//   bottom: 12px;
//   right: 12px;
//   z-index: 10;

//   border: 2px solid #bebebe !important;
//   background: white !important;
//   height: 25vh !important;
//   width: 25vw !important;

//   overflow: hidden !important;
// }

/*Add border to View container:*/
.cytoscape-navigator .cytoscape-navigatorView {
  border: 2px solid #124191;
  // background: transparent;
}

// /*Ovveride overlay container when mouse is over Navigator*/
// #cytoscape-navigator:hover .cytoscape-navigatorOverlay {
//   border: 2px solid #124191;
//   background: transparent;
// }
</style>
