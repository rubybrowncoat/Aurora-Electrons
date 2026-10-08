<template>
  <v-container fluid class="map-page">
    <v-alert v-if="failedInputs.length" type="error" outlined dense class="mb-0">
      Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
      <template #append>
        <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
      </template>
    </v-alert>
    <v-progress-linear v-else-if="!loaded" indeterminate />

    <template v-if="loaded">
      <div class="toolbar">
        <div class="tool tool--find">
          <div class="tool__label caption text--secondary">Find</div>
          <v-autocomplete v-model="foundId" :items="searchItems" :search-input.sync="findText" placeholder="A system" prepend-inner-icon="mdi-magnify" aria-label="Find a system" dense outlined hide-details clearable auto-select-first @change="(id) => id && focusSystem(id)" />
        </div>
        <div class="tool tool--layer">
          <div class="tool__label caption text--secondary">Colour by</div>
          <v-select v-model="layer" :items="layers" aria-label="Colour systems by" dense outlined hide-details @change="(value) => setSetting('mapLayer', value)" />
        </div>
        <div class="tool tool--boxes">
          <div class="tool__label caption text--secondary">Boxes</div>
          <v-select v-model="boxes" :items="boxOptions" aria-label="Draw boxes around" dense outlined hide-details @change="(value) => setSetting('mapBoxes', value)" />
        </div>
        <div class="tool tool--actions">
          <v-menu v-model="arrangeMenu" offset-y left :close-on-content-click="false" max-width="400">
            <template #activator="{ on, attrs }">
              <v-btn color="primary" depressed :disabled="!!busy || !systemRows.length" v-bind="attrs" v-on="on"><v-icon small left>mdi-grid</v-icon>Arrange</v-btn>
            </template>
            <v-card class="pa-4">
              <div class="subtitle-2">Arrange on a grid</div>
              <div class="caption text--secondary mb-3">As players lay out the galactic map: one system to a cell, links straight or at 45°, dead ends beside their system, and no link crossing another or running over a system wherever the jump network allows.</div>
              <v-btn-toggle v-model="arrange.mode" mandatory dense @change="saveArrange">
                <v-btn v-for="option in arrangeModes" :key="option.value" :value="option.value" small>{{ option.text }}</v-btn>
              </v-btn-toggle>
              <div class="caption text--secondary mt-1 mb-4">{{ arrangeModeHint }}</div>
              <div class="arrange-fields">
                <v-select v-model="arrange.spacing" :items="spacings" label="Spacing" dense outlined hide-details @change="saveArrange" />
                <v-select v-model="arrange.keepTogether" :items="keepTogetherOptions" label="Keep together" dense outlined hide-details @change="saveArrange" />
              </div>
              <v-checkbox v-model="arrange.diagonals" label="Allow links at 45°" dense hide-details @change="saveArrange" />
              <div v-if="groupList.length" class="mt-4">
                <div class="caption text--secondary">Your groups, which come before the setting above</div>
                <div v-for="group in groupList" :key="group.index" class="group-row">
                  <span class="body-2 text-truncate" :title="group.title">{{ group.label }}</span>
                  <v-btn icon x-small aria-label="Drop this group" title="Drop this group" @click="dropGroup(group.index)"><v-icon x-small>mdi-close</v-icon></v-btn>
                </div>
              </div>
              <div class="caption text--secondary mt-4">
                <template v-if="pinnedCount">{{ pinnedCount }} pinned {{ pinnedCount === 1 ? 'system stays' : 'systems stay' }} where {{ pinnedCount === 1 ? 'it is' : 'they are' }} (<a @click="unpinAll">unpin all</a>).</template>
                <template v-else>Pin a system from its panel to keep it where it is.</template>
                Select several systems to keep them together.
              </div>
              <v-btn color="primary" depressed block class="mt-4" @click="arrangeMap">Arrange</v-btn>
            </v-card>
          </v-menu>
          <v-menu offset-y left :close-on-content-click="false" max-width="340">
            <template #activator="{ on, attrs }">
              <v-btn outlined :disabled="!!busy || !links.list.length" v-bind="attrs" v-on="on"><v-icon small left>mdi-vector-polyline</v-icon>Free layout</v-btn>
            </template>
            <v-card class="pa-4">
              <div class="subtitle-2">Let the links pull the systems into place</div>
              <v-radio-group v-model="linkLength" dense hide-details class="mt-2" @change="(value) => setSetting('mapLinkLength', value)">
                <v-radio v-for="option in linkLengths" :key="option.value" :value="option.value" :label="option.text" />
              </v-radio-group>
              <div class="caption text--secondary mt-2">{{ linkLengthHint }}</div>
              <div class="free-actions">
                <v-btn outlined small :disabled="linkLength === 'galactic'" title="A force-directed layout that keeps linked systems close" @click="applyForces">Forces</v-btn>
                <v-btn outlined small :disabled="boxes !== 'none'" title="Shakes the map loose and separates the systems" @click="scramble">Scramble</v-btn>
              </div>
              <div class="caption text--secondary mt-2">Forces don't take galactic distances, and Scramble doesn't work with boxes.</div>
            </v-card>
          </v-menu>
          <v-btn outlined :disabled="!!busy || !movedIds.length" title="Put every system back where the save has it" @click="revertPositions"><v-icon small left>mdi-undo</v-icon>Revert</v-btn>
          <v-btn outlined color="primary" :disabled="!!busy || !movedIds.length" @click="saveDialog = true"><v-icon small left>mdi-content-save-outline</v-icon>Save positions<span v-if="movedIds.length">&nbsp;({{ movedIds.length }})</span></v-btn>
        </div>
      </div>

      <v-card class="panel map-card" elevation="1">
        <div class="panel-head">
          <span class="legend">
            <span v-for="item in legend" :key="item.label" class="legend-item">
              <span v-if="item.kind === 'ring'" class="dot dot-ring" :style="{ borderColor: item.color, borderStyle: item.style || 'solid' }" />
              <span v-else-if="item.kind === 'spot'" class="spot" :style="{ background: item.color }" />
              <span v-else-if="item.kind === 'line'" class="line" :class="{ 'line--dashed': item.dashed }" :style="item.dashed ? { borderColor: item.color } : { background: item.color }" />
              <v-icon v-else-if="item.kind === 'icon'" x-small class="mr-1">{{ item.icon }}</v-icon>
              <span v-else class="dot" :style="{ background: item.color }" />
              {{ item.label }}
            </span>
          </span>
        </div>
        <div class="map-body">
          <div ref="stage" class="map-stage">
            <div ref="canvas" class="map-canvas" aria-label="Galactic map of the known systems and their jump links" />
            <div class="map-navigator" @pointerdown="fitted = false" />
            <div class="map-controls">
              <v-btn icon small aria-label="Centre on the capital" title="Centre on the capital" :disabled="!systemRows.length" @click="focusCapital"><v-icon small>mdi-crosshairs-gps</v-icon></v-btn>
              <v-btn icon small aria-label="Fit the map" title="Fit the map" :disabled="!systemRows.length" @click="fitView"><v-icon small>mdi-fit-to-screen</v-icon></v-btn>
              <v-btn icon small aria-label="Export as PNG" title="Export as PNG" :disabled="!!busy || !systemRows.length" @click="exportPng"><v-icon small>mdi-camera</v-icon></v-btn>
            </div>
            <div v-if="busy || quality" class="map-status caption">
              <template v-if="busy">
                <span>{{ busyLabel }}</span>
                <v-progress-linear class="busy-bar" :value="progress * 100" :indeterminate="busy !== 'arrange'" height="4" rounded />
                <v-btn x-small text color="primary" @click="stopBusy">Stop</v-btn>
              </template>
              <span v-else>{{ qualityText }}</span>
            </div>
            <div v-if="!systemRows.length" class="map-empty text--secondary">Your race knows no systems yet.</div>
          </div>
          <aside v-if="panelSystem" class="map-side">
            <div class="side-head">
              <div class="min-width-0">
                <div class="subtitle-1 font-weight-medium text-truncate">{{ panelSystem.Name }}</div>
                <div class="caption text--secondary">{{ panelSubtitle }}</div>
              </div>
              <v-btn icon small aria-label="Close" title="Close" @click="clearSelection"><v-icon small>mdi-close</v-icon></v-btn>
            </div>
            <dl class="facts">
              <template v-for="fact in panelFacts">
                <dt :key="`${fact.label}-label`" class="text--secondary">{{ fact.label }}</dt>
                <dd :key="`${fact.label}-value`">{{ fact.value }}</dd>
              </template>
            </dl>
            <template v-if="panelNeighbours.length">
              <div class="caption text--secondary mt-3 mb-1">Linked systems</div>
              <div class="chips">
                <v-chip v-for="neighbour in panelNeighbours" :key="neighbour.id" small outlined @click="focusSystem(neighbour.id)">{{ neighbour.Name }}</v-chip>
              </div>
            </template>
            <div class="side-actions">
              <v-btn small outlined :to="mineralsLink([panelSystem.id])">Minerals</v-btn>
              <v-btn small outlined :to="plannerLink([panelSystem.id])">Colonization Planner</v-btn>
              <v-btn small outlined @click="openSystemView(panelSystem.id)">System view</v-btn>
              <v-btn small outlined @click="togglePins([panelSystem.id])"><v-icon x-small left>{{ pinnedSet.has(panelSystem.id) ? 'mdi-lock-open-variant-outline' : 'mdi-lock-outline' }}</v-icon>{{ pinnedSet.has(panelSystem.id) ? 'Unpin' : 'Pin in place' }}</v-btn>
              <v-btn v-if="groupOf[panelSystem.id] !== undefined" small text @click="leaveGroup(panelSystem.id)">Leave its group</v-btn>
            </div>
          </aside>
          <aside v-else-if="selectedRows.length > 1" class="map-side">
            <div class="side-head">
              <div class="subtitle-1 font-weight-medium">{{ selectedRows.length }} systems selected</div>
              <v-btn icon small aria-label="Close" title="Close" @click="clearSelection"><v-icon small>mdi-close</v-icon></v-btn>
            </div>
            <div class="body-2">{{ selectedNames }}</div>
            <div class="side-actions">
              <v-btn small outlined :to="mineralsLink(selectedIds)">Minerals</v-btn>
              <v-btn small outlined :to="plannerLink(selectedIds)">Colonization Planner</v-btn>
              <v-btn small outlined @click="togglePins(selectedIds)"><v-icon x-small left>{{ allSelectedPinned ? 'mdi-lock-open-variant-outline' : 'mdi-lock-outline' }}</v-icon>{{ allSelectedPinned ? 'Unpin' : 'Pin in place' }}</v-btn>
              <v-btn small outlined @click="keepTogether(selectedIds)"><v-icon x-small left>mdi-group</v-icon>Keep together</v-btn>
            </div>
            <div class="caption text--secondary mt-2">Keep together makes them a group. Arrange draws a group's systems together and keeps other systems from between them, as far as their links allow.</div>
          </aside>
        </div>
        <div class="panel-foot caption text--secondary">
          Positions are the game's galactic map, in its units; markers grow with the people living there. Shift-click or shift-drag to select several systems; right-click one for a quick menu.
          <template v-if="unplacedIds.length">{{ unplacedIds.length }} {{ unplacedIds.length === 1 ? 'system has' : 'systems have' }} no place on the save's map (the game left {{ unplacedIds.length === 1 ? 'it' : 'them' }} at its centre), so {{ unplacedIds.length === 1 ? 'it sits' : 'they sit' }} beside a linked system until you save.</template>
        </div>
      </v-card>
    </template>

    <v-dialog v-model="saveDialog" max-width="440" :persistent="saving">
      <v-card>
        <v-card-title class="text-h6">Save positions</v-card-title>
        <v-card-text>
          Write the positions of {{ movedIds.length }} {{ movedIds.length === 1 ? 'system' : 'systems' }} to the save? Only systems that moved are written, rounded to whole units.
          The game reads the map when it loads a save and writes its own copy back when it saves, so do this with the game closed, or load the save again in the game before playing on.
        </v-card-text>
        <v-progress-linear v-if="saving" indeterminate />
        <v-card-actions>
          <v-spacer />
          <v-btn text :disabled="saving" @click="saveDialog = false">Cancel</v-btn>
          <v-btn color="primary" depressed :loading="saving" @click="savePositions">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="systemDialog" fullscreen hide-overlay transition="dialog-bottom-transition">
      <v-card>
        <v-toolbar dark color="primary">
          <v-btn icon dark aria-label="Close" @click="systemDialog = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
          <v-toolbar-title>{{ systemDialogTitle }}</v-toolbar-title>
        </v-toolbar>
        <v-card-text v-if="systemDialog">
          <system-view v-if="systemViewId" :system-id="systemViewId" @jump="(id) => (systemViewId = String(id))" />
        </v-card-text>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script>
import { ipcRenderer } from 'electron'
import { mapActions, mapGetters } from 'vuex'
import cytoscape from 'cytoscape'
import cxtmenu from 'cytoscape-cxtmenu'
import fcose from 'cytoscape-fcose'
import cola from 'cytoscape-cola'
import navigator from 'cytoscape-navigator'

import { chartTheme } from '../components/charts/theme'
import SystemView from '../components/SystemView.vue'
import countFormat from '../mixins/count-format'
import { gameTime } from '../utilities/aurora'
import { gridLayout, GRID_LAYOUT_DEFAULTS, layoutQuality } from '../utilities/grid-layout'
import { loadJumpPoints } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { scaleValue } from '../utilities/math'

cytoscape.use(cxtmenu)
cytoscape.use(cola)
cytoscape.use(fcose)

if (typeof cytoscape('core', 'navigator') === 'undefined') {
  navigator(cytoscape)
}

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  sectors: 'your sectors',
  aliens: 'the alien races you know',
}
const INPUTS = Object.keys(INPUT_LABELS)

const LAYERS = [
  { value: 'geological', text: 'Geological survey' },
  { value: 'gravitational', text: 'Gravitational survey' },
  { value: 'colonies', text: 'Colonies' },
  { value: 'sectors', text: 'Sectors' },
  { value: 'control', text: 'Alien control' },
  { value: 'jumps', text: 'Jumps from the capital' },
]

const BOX_OPTIONS = [
  { value: 'none', text: 'None' },
  { value: 'sectors', text: 'Sectors' },
  { value: 'control', text: 'Alien control' },
]

// How long the free layouts want each link.
const LINK_LENGTHS = [
  { value: 'travel', text: 'Travel distance', hint: 'Longer where the jump points lie far out from their stars.' },
  { value: 'galactic', text: 'Galactic distance', hint: 'As far apart as the stars are in the galaxy.' },
  { value: 'auto', text: 'Automatic', hint: 'Whatever the layout settles on.' },
  { value: 'short', text: 'Short', length: 100, hint: 'Every link 100 units.' },
  { value: 'standard', text: 'Standard', length: 200, hint: 'Every link 200 units.' },
  { value: 'long', text: 'Long', length: 300, hint: 'Every link 300 units.' },
]

const ARRANGE_MODES = [
  { value: 'rebuild', text: 'Rebuild', hint: 'Lays the map out afresh from its links, turned to face the way yours does.' },
  { value: 'tidy', text: 'Tidy', hint: 'Straightens the map you have, moving each system as little as it can.' },
]

const SPACINGS = [
  { value: 100, text: '100' },
  { value: 120, text: '120' },
  { value: 140, text: '140, as the game places' },
  { value: 160, text: '160' },
]

const KEEP_TOGETHER = [
  { value: 'none', text: 'Nothing' },
  { value: 'sectors', text: 'Sectors' },
  { value: 'control', text: 'Alien control' },
]

const PHASES = {
  stress: 'Spreading the systems out',
  place: 'Putting them on the grid',
  improve: 'Untangling the links',
}

// Arrange works in slices this long, handing the browser a turn between them to draw.
const SLICE_MS = 12

// The game puts a newly found system this far from the one it was reached from, and no
// closer than this to any other (RaceSysSurvey.AssignRelativeMapCoordinates).
const GAME_SPACING = 140
const AROUND = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]

const LOCK_PATH = 'M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z'

// A new task as soon as the browser has had its turn. Unlike an animation frame, it still comes
// in a hidden or minimised window, so an Arrange carries on there.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(null)
})

const samePlace = (a, b) => Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y)

const clampToSpacing = (value) => Math.max(-GAME_SPACING, Math.min(GAME_SPACING, value))

// `hex` laid over `background` at `alpha`, as an opaque colour: cytoscape takes no alpha in a colour.
const blend = (hex, background, alpha) => {
  const channels = (value) => [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16))
  const top = channels(hex)
  const bottom = channels(background)

  return `#${top.map((channel, i) => Math.round(channel * alpha + bottom[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(', ')}, ${alpha})`

// 44 units across for a system with nobody in it, growing towards 104 with colonies and people.
const markerSize = (colonies, population) => {
  if (!colonies) {
    return 44
  }

  const count = Math.log1p(colonies) / Math.log1p(100)
  const people = Math.log1p(Math.max(0, population)) / Math.log1p(10000)
  const blended = Math.exp(0.3 * Math.log(Math.max(1e-9, count)) + 0.7 * Math.log(Math.max(1e-9, people)))

  return Math.round(44 + 60 * (blended / (1 + blended)))
}

const markerImages = new Map()

// What a marker carries over its fill: `spots` small dots round the rim (unexplored jump points,
// or bodies with ground survey potential), and a lock on a pinned system.
const markerImage = (size, spots, color, pinned) => {
  if (!spots && !pinned) {
    return 'none'
  }

  const key = `${size}|${spots}|${color}|${pinned}`

  if (!markerImages.has(key)) {
    const centre = size / 2
    let content = ''

    for (let i = 0; i < spots; i += 1) {
      const radius = centre - 4 + 3 * Math.floor(i / 11)
      const angle = (32 * i * Math.PI) / 180

      content += `<circle cx="${centre + radius * Math.sin(angle)}" cy="${centre - radius * Math.cos(angle)}" r="3" fill="${color}" />`
    }

    if (pinned) {
      const lock = size / 3

      content += `<g transform="translate(${(size - lock) / 2}, ${(size - lock) / 2}) scale(${lock / 24})"><path fill="black" stroke="black" stroke-width="3" d="${LOCK_PATH}" /><path fill="white" d="${LOCK_PATH}" /></g>`
    }

    markerImages.set(key, `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${content}</svg>`)}`)
  }

  return markerImages.get(key)
}

// Systems the game never put on the map all sit at 0, 0. Each gets a place beside a linked
// system that has one, the way the game places a system it has just found: straight on past
// that system, away from the one it was reached from, else the first cell around it with no
// system within 140. Systems with no placed link go in a row under the map.
const placeUnplaced = (rows, saved, neighbours, capitalId) => {
  const atOrigin = rows.filter((row) => !row.Xcor && !row.Ycor)

  if (atOrigin.length < 2) {
    return { positions: saved, unplaced: [] }
  }

  const kept = atOrigin.find((row) => row.id === capitalId) || atOrigin[0]
  const unplaced = atOrigin.filter((row) => row !== kept).map((row) => row.id)
  const waiting = new Set(unplaced)
  const positions = { ...saved }
  unplaced.forEach((id) => delete positions[id])

  const free = ([x, y]) => Object.values(positions).every((position) => Math.abs(position.x - x) >= GAME_SPACING || Math.abs(position.y - y) >= GAME_SPACING)
  let progress = true

  while (waiting.size && progress) {
    progress = false

    for (const id of waiting) {
      const anchor = (neighbours[id] || []).find((other) => positions[other])

      if (!anchor) {
        continue
      }

      const at = positions[anchor]
      const from = (neighbours[anchor] || []).find((other) => other !== id && positions[other])
      const spots = []

      if (from) {
        const dx = clampToSpacing(at.x - positions[from].x)
        const dy = clampToSpacing(at.y - positions[from].y)

        if (dx || dy) {
          spots.push([at.x + dx, at.y + dy])
        }
      }

      for (let ring = 1; ring <= 4; ring += 1) {
        AROUND.forEach(([ox, oy]) => spots.push([at.x + ox * GAME_SPACING * ring, at.y + oy * GAME_SPACING * ring]))
      }

      const [x, y] = spots.find(free) || spots[spots.length - 1]
      positions[id] = { x, y }
      waiting.delete(id)
      progress = true
    }
  }

  if (waiting.size) {
    const placed = Object.values(positions)
    const bottom = Math.max(0, ...placed.map((position) => position.y)) + 2 * GAME_SPACING
    let x = Math.min(0, ...placed.map((position) => position.x))

    waiting.forEach((id) => {
      positions[id] = { x, y: bottom }
      x += GAME_SPACING
    })
  }

  return { positions, unplaced }
}

// How far along a whole Arrange is, from the phase the layout reports.
const overallProgress = (mode, { phase, progress }) => {
  if (mode === 'tidy') {
    return phase === 'place' ? 0.1 * progress : 0.1 + 0.9 * progress
  }

  return phase === 'stress' ? 0.15 * progress : phase === 'place' ? 0.15 + 0.1 * progress : 0.25 + 0.75 * progress
}

export default {
  name: 'MapPage',
  components: { SystemView },
  mixins: [countFormat],
  data() {
    return {
      loadErrors: {},
      // Set once the first reads are in, so the map stays up while the page reads a changed save.
      loaded: false,

      layer: 'geological',
      boxes: 'none',
      linkLength: 'travel',
      arrange: { mode: GRID_LAYOUT_DEFAULTS.mode, spacing: GRID_LAYOUT_DEFAULTS.spacing, diagonals: GRID_LAYOUT_DEFAULTS.diagonals, keepTogether: 'none' },
      pinned: [],
      groups: [],

      foundId: null,
      findText: null,
      selectedIds: [],
      arrangeMenu: false,

      busy: null,
      phase: null,
      progress: 0,
      quality: null,
      before: null,
      movedIds: [],

      saveDialog: false,
      saving: false,
      systemDialog: false,
      systemViewId: null,

      layers: LAYERS,
      boxOptions: BOX_OPTIONS,
      linkLengths: LINK_LENGTHS,
      arrangeModes: ARRANGE_MODES,
      spacings: SPACINGS,
      keepTogetherOptions: KEEP_TOGETHER,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'GameTime']),

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    colors() {
      const { categorical, inkMuted, surface, ink, primary } = this.theme
      const [blue, orange, green, amber, pink, , violet] = categorical

      return {
        done: green,
        left: orange,
        ground: pink,
        unexplored: amber,
        colony: blue,
        outpost: blend(blue, surface, 0.35),
        none: blend(inkMuted, surface, 0.3),
        ring: inkMuted,
        ink,
        surface,
        primary,
        link: blend(inkMuted, surface, 0.6),
        gate: violet,
      }
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS)
    },

    settingsPrefix() {
      return `game.${this.GameID}.race.${this.RaceID}`
    },

    systemRows() {
      return this.systems.map((system) => ({
        id: String(system.SystemID),
        SystemID: system.SystemID,
        Name: system.Name,
        Xcor: system.Xcor,
        Ycor: system.Ycor,
        SectorID: system.SectorID || null,
        ControlRaceID: system.ControlRaceID || null,
        DiscoveredTime: system.DiscoveredTime,
        // Light years, scaled as the old map did so a free layout's links stay on screen.
        galactic: system.X === null || system.X === undefined ? null : { x: system.X * 18, y: system.Y * 18, z: system.Z * 18 },
        bodies: system.Bodies || 0,
        surveyedBodies: system.SurveyedBodies || 0,
        cometsOnly: system.Bodies > 0 && !system.Planets && system.Comets === system.Bodies,
        groundSurveys: system.GroundSurveys || 0,
        locations: system.Locations || 0,
        surveyedLocations: system.SurveyedLocations || 0,
        colonies: system.Colonies || 0,
        population: system.Population || 0,
        capital: Boolean(system.Capital),
        size: markerSize(system.Colonies || 0, system.Population || 0),
      }))
    },

    rowById() {
      return Object.fromEntries(this.systemRows.map((row) => [row.id, row]))
    },

    capitalId() {
      const capital = this.systemRows.find((row) => row.capital) || this.systemRows[0]

      return capital ? capital.id : null
    },

    // One link per pair of systems joined by a jump point the race has explored from either
    // side, with a gate on either end; and per system, the charted jump points still unexplored.
    links() {
      const byId = Object.fromEntries(this.jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
      const links = new Map()
      const unexplored = {}

      this.jumpPoints.forEach((jumpPoint) => {
        const from = String(jumpPoint.SystemID)
        const partner = byId[jumpPoint.WPLink]

        if (!partner || !(jumpPoint.Explored || partner.Explored)) {
          unexplored[from] = (unexplored[from] || 0) + 1

          return
        }

        const to = String(partner.SystemID)

        if (from === to || !this.rowById[from] || !this.rowById[to]) {
          return
        }

        const key = from < to ? `${from}-${to}` : `${to}-${from}`

        if (!links.has(key)) {
          links.set(key, { id: `link-${key}`, source: from, target: to, gateSource: false, gateTarget: false, km: 0 })
        }

        const link = links.get(key)

        if (jumpPoint.JumpGateStrength > 0) {
          link[link.source === from ? 'gateSource' : 'gateTarget'] = true
        }

        link.km += Math.hypot(jumpPoint.Xcor, jumpPoint.Ycor)
      })

      const list = [...links.values()].map((link) => {
        const a = this.rowById[link.source].galactic
        const b = this.rowById[link.target].galactic

        return {
          ...link,
          gate: link.gateSource && link.gateTarget ? 'both' : link.gateSource ? 'source' : link.gateTarget ? 'target' : 'none',
          // From star to star through the jump point, in billions of km, as the free layouts want it.
          travel: scaleValue(link.km / 1e9),
          galactic: a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null,
        }
      })

      return { list, unexplored }
    },

    linkPairs() {
      return this.links.list.map((link) => [link.source, link.target])
    },

    neighbours() {
      const neighbours = {}

      const add = (from, to) => {
        neighbours[from] = neighbours[from] || []
        neighbours[from].push(to)
      }

      this.links.list.forEach(({ source, target }) => {
        add(source, target)
        add(target, source)
      })

      return neighbours
    },

    hops() {
      const hops = {}

      if (!this.capitalId) {
        return hops
      }

      hops[this.capitalId] = 0
      const queue = [this.capitalId]

      for (let i = 0; i < queue.length; i += 1) {
        (this.neighbours[queue[i]] || []).forEach((other) => {
          if (hops[other] === undefined) {
            hops[other] = hops[queue[i]] + 1
            queue.push(other)
          }
        })
      }

      return hops
    },

    farthestHop() {
      return Math.max(1, ...Object.values(this.hops))
    },

    savedPositions() {
      return Object.fromEntries(this.systemRows.map((row) => [row.id, { x: row.Xcor || 0, y: row.Ycor || 0 }]))
    },

    placement() {
      return placeUnplaced(this.systemRows, this.savedPositions, this.neighbours, this.capitalId)
    },

    // Where each system starts: as saved, with the ones the game never placed given a place.
    startPositions() {
      return this.placement.positions
    },

    unplacedIds() {
      return this.placement.unplaced
    },

    sectorById() {
      return Object.fromEntries(this.sectors.map((sector, index) => [sector.SectorCommandID, { name: sector.SectorName, color: this.theme.categorical[index % this.theme.categorical.length] }]))
    },

    // The alien races holding systems on the map, most systems first, each with a colour.
    controllers() {
      const counts = {}

      this.systemRows.forEach((row) => {
        if (this.alienControl(row)) {
          counts[row.ControlRaceID] = (counts[row.ControlRaceID] || 0) + 1
        }
      })

      const names = Object.fromEntries(this.aliens.map((alien) => [alien.AlienRaceID, alien.AlienRaceName]))

      return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id, systems], index) => ({
        id: Number(id),
        name: names[id] || 'An unknown race',
        systems,
        color: this.theme.categorical[index % this.theme.categorical.length],
      }))
    },

    controllerById() {
      return Object.fromEntries(this.controllers.map((controller) => [controller.id, controller]))
    },

    pinnedSet() {
      return new Set(this.pinned)
    },

    pinnedCount() {
      return this.pinned.filter((id) => this.rowById[id]).length
    },

    // The group index of each system in one of the player's groups.
    groupOf() {
      const groupOf = {}

      this.groups.forEach((group, index) => group.forEach((id) => {
        groupOf[id] = index
      }))

      return groupOf
    },

    groupList() {
      return this.groups.map((group, index) => {
        const names = group.map((id) => (this.rowById[id] || {}).Name).filter(Boolean)

        return { index, label: names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '), title: names.join(', ') }
      }).filter((group) => group.label)
    },

    // What Arrange keeps together for each system: its own group first, else the setting.
    keepTogetherKeys() {
      const keys = {}

      this.systemRows.forEach((row) => {
        if (this.groupOf[row.id] !== undefined) {
          keys[row.id] = `group-${this.groupOf[row.id]}`
        } else if (this.arrange.keepTogether === 'sectors' && row.SectorID) {
          keys[row.id] = `sector-${row.SectorID}`
        } else if (this.arrange.keepTogether === 'control' && this.alienControl(row)) {
          keys[row.id] = `control-${row.ControlRaceID}`
        }
      })

      return keys
    },

    // Everything the map's elements are built from; a change rebuilds them.
    graphSource() {
      return [this.systemRows, this.links, this.sectorById, this.controllerById]
    },

    // The known systems by name, those starting with what's typed first.
    searchItems() {
      const typed = (this.findText || '').toLowerCase()
      const rank = (item) => (typed && item.text.toLowerCase().startsWith(typed) ? 0 : 1)

      return this.systemRows.map((row) => ({ text: row.Name, value: row.id })).sort((a, b) => rank(a) - rank(b) || a.text.localeCompare(b.text))
    },

    selectedRows() {
      return this.selectedIds.map((id) => this.rowById[id]).filter(Boolean)
    },

    selectedNames() {
      const names = this.selectedRows.map((row) => row.Name)

      return names.length > 12 ? `${names.slice(0, 12).join(', ')} and ${names.length - 12} more` : names.join(', ')
    },

    allSelectedPinned() {
      return this.selectedIds.every((id) => this.pinnedSet.has(id))
    },

    panelSystem() {
      return this.selectedRows.length === 1 ? this.selectedRows[0] : null
    },

    panelSubtitle() {
      const system = this.panelSystem
      const parts = []

      if (system.capital) {
        parts.push('Capital')
      }

      if (system.SectorID && this.sectorById[system.SectorID]) {
        parts.push(this.sectorById[system.SectorID].name)
      }

      if (this.pinnedSet.has(system.id)) {
        parts.push('Pinned')
      }

      return parts.join(' · ') || 'System'
    },

    panelFacts() {
      const system = this.panelSystem
      const hops = this.hops[system.id]
      const group = this.groupOf[system.id]
      const facts = [
        { label: 'From the capital', value: hops === undefined ? 'No explored route' : hops === 0 ? 'Capital' : `${hops} ${hops === 1 ? 'jump' : 'jumps'}` },
        { label: 'Held by', value: this.controllerName(system) },
        { label: 'Colonies', value: system.colonies ? `${system.colonies}, ${this.count(system.population, system.population < 10 ? 2 : 0)} m people` : 'None' },
        { label: 'Geological', value: system.bodies ? `${this.count(system.surveyedBodies)} of ${this.count(system.bodies)} bodies surveyed${system.groundSurveys ? `, ${system.groundSurveys} with ground survey potential` : ''}` : 'No bodies' },
        { label: 'Gravitational', value: system.locations ? `${system.surveyedLocations} of ${system.locations} survey locations` : 'No survey locations' },
        { label: 'Jump points', value: this.jumpPointSummary(system) },
        { label: 'Discovered', value: gameTime(this.StartYear, system.DiscoveredTime || 0).format('YYYY-MM-DD') },
      ]

      if (group !== undefined) {
        facts.push({ label: 'Kept with', value: this.groups[group].filter((id) => id !== system.id && this.rowById[id]).map((id) => this.rowById[id].Name).join(', ') })
      }

      return facts
    },

    panelNeighbours() {
      return (this.neighbours[this.panelSystem.id] || []).map((id) => this.rowById[id]).sort((a, b) => a.Name.localeCompare(b.Name))
    },

    legend() {
      const { colors } = this
      const items = []

      if (this.layer === 'geological' || this.layer === 'gravitational') {
        const geological = this.layer === 'geological'

        items.push(
          { kind: 'dot', color: colors.done, label: geological ? 'Bodies surveyed' : 'Locations surveyed' },
          { kind: 'dot', color: colors.left, label: 'Left to survey' },
          { kind: 'ring', color: colors.ring, style: 'dotted', label: geological ? 'No bodies' : 'No survey locations' }
        )

        if (geological) {
          items.push({ kind: 'ring', color: colors.ring, style: 'dashed', label: 'Comets only' }, { kind: 'spot', color: colors.ground, label: 'Body with ground survey potential' })
        } else {
          items.push({ kind: 'spot', color: colors.unexplored, label: 'Unexplored jump point' })
        }
      } else if (this.layer === 'colonies') {
        items.push(
          { kind: 'ring', color: colors.ink, label: 'Capital' },
          { kind: 'dot', color: colors.colony, label: 'Colonies with people' },
          { kind: 'dot', color: colors.outpost, label: 'Colonies without' },
          { kind: 'dot', color: colors.none, label: 'No colony' }
        )
      } else if (this.layer === 'sectors') {
        this.sectors.forEach((sector) => items.push({ kind: 'dot', color: this.sectorById[sector.SectorCommandID].color, label: sector.SectorName }))
        items.push({ kind: 'dot', color: colors.none, label: 'In no sector' })
      } else if (this.layer === 'control') {
        this.controllers.forEach((controller) => items.push({ kind: 'dot', color: controller.color, label: `${controller.name} (${controller.systems})` }))
        items.push({ kind: 'dot', color: colors.none, label: 'Held by no alien race' })
      } else {
        items.push(
          { kind: 'ring', color: colors.ink, label: 'Capital' },
          { kind: 'dot', color: colors.colony, label: 'Near' },
          { kind: 'dot', color: blend(colors.colony, colors.surface, 0.25), label: `Far (${this.farthestHop} ${this.farthestHop === 1 ? 'jump' : 'jumps'})` },
          { kind: 'dot', color: colors.none, label: 'No explored route' }
        )
      }

      if (this.links.list.some((link) => link.gate === 'both')) {
        items.push({ kind: 'line', color: colors.gate, label: 'Gates at both ends' })
      }

      if (this.links.list.some((link) => link.gate === 'source' || link.gate === 'target')) {
        items.push({ kind: 'line', color: colors.gate, dashed: true, label: 'Gate at one end (arrow: the way it lets ships through)' })
      }

      if (this.pinnedCount) {
        items.push({ kind: 'icon', icon: 'mdi-lock', label: 'Pinned' })
      }

      return items
    },

    arrangeModeHint() {
      return ARRANGE_MODES.find((option) => option.value === this.arrange.mode).hint
    },

    linkLengthHint() {
      return LINK_LENGTHS.find((option) => option.value === this.linkLength).hint
    },

    busyLabel() {
      if (this.busy === 'arrange') {
        return `${PHASES[this.phase] || 'Arranging'}, ${Math.round(this.progress * 100)}%`
      }

      return 'Moving the systems'
    },

    qualityText() {
      const straight = (quality) => `${quality.links ? Math.round((100 * (quality.straight + quality.diagonal)) / quality.links) : 100}%`
      const part = (label, value) => (this.before ? `${label} ${value(this.before)} → ${value(this.quality)}` : `${label} ${value(this.quality)}`)

      return [
        part('Crossings', (quality) => quality.crossings),
        part('Links over systems', (quality) => quality.overSystems),
        part('Straight or 45°', straight),
      ].join(' · ')
    },

    systemDialogTitle() {
      return (this.rowById[this.systemViewId] || {}).Name || 'System'
    },
  },
  watch: {
    // The map's settings are kept per game and race; another race starts a fresh map.
    RaceID: {
      immediate: true,
      handler() {
        const setting = (key, fallback) => this.config.get(`${this.settingsPrefix}.${key}`, fallback)

        this.layer = setting('mapLayer', 'geological')
        this.boxes = setting('mapBoxes', 'none')
        this.linkLength = setting('mapLinkLength', 'travel')
        this.arrange = { ...this.arrange, ...setting('mapArrange', {}) }
        this.pinned = setting('mapPinned', [])
        this.groups = setting('mapGroups', [])
        this.resetGraph()
      },
    },

    ready(value) {
      if (value) {
        this.loaded = true
        this.scheduleSync()
      }
    },

    graphSource() {
      this.scheduleSync()
    },

    boxes() {
      this.rebuild()
    },

    layer() {
      this.restyle()
    },

    pinned() {
      this.restyle()
    },

    '$vuetify.theme.dark'() {
      if (this.graph) {
        this.graph.style(this.stylesheet())
        this.createMenu()
        this.rebuild()
      }
    },
  },
  created() {
    this.graph = null
    this.menu = null
    this.navigatorInstance = null
    this.layoutInstance = null
    this.run = null
    this.syncedStart = null
    this.syncQueued = false
    this.syncPending = false
    this.selectionQueued = false
    this.fitPending = true
    // The view shows the whole map and the user hasn't moved it since, so a resize fits it again.
    this.fitted = true
    this.resizeObserver = null
    // `?system=<SystemID>` opens the map on that system.
    this.pendingFocus = this.$route.query.system ? String(this.$route.query.system) : null
  },
  beforeDestroy() {
    this.run = null

    if (this.layoutInstance) {
      this.layoutInstance.stop()
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }

    if (this.navigatorInstance) {
      this.navigatorInstance.destroy()
    }

    if (this.menu) {
      this.menu.destroy()
    }

    if (this.graph) {
      this.graph.destroy()
    }
  },
  methods: {
    ...mapActions('snackbar', ['activateSnackbar']),

    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    setSetting(key, value) {
      this.config.set(`${this.settingsPrefix}.${key}`, value)
    },

    saveArrange() {
      this.setSetting('mapArrange', { ...this.arrange })
    },

    alienControl(row) {
      return Boolean(row.ControlRaceID && row.ControlRaceID !== this.RaceID)
    },

    controllerName(row) {
      if (!row.ControlRaceID) {
        return 'No one'
      }

      if (row.ControlRaceID === this.RaceID) {
        return 'You'
      }

      return (this.controllerById[row.ControlRaceID] || {}).name || 'An unknown race'
    },

    jumpPointSummary(row) {
      const linked = (this.neighbours[row.id] || []).length
      const unexplored = this.links.unexplored[row.id] || 0
      const gates = this.links.list.filter((link) => (link.source === row.id && link.gateSource) || (link.target === row.id && link.gateTarget)).length
      const parts = [`${linked} explored`]

      if (unexplored) {
        parts.push(`${unexplored} unexplored`)
      }

      if (gates) {
        parts.push(`${gates} with ${gates === 1 ? 'a gate' : 'gates'}`)
      }

      return parts.join(', ')
    },

    mineralsLink(ids) {
      return { path: '/minerals', query: { systems: ids.join(',') } }
    },

    plannerLink(ids) {
      return { path: '/habitability', query: { systems: ids.join(',') } }
    },

    // The cytoscape style; the per-system colours are in each node's data, set by `markerData`.
    stylesheet() {
      const { colors, theme } = this

      return [
        {
          selector: 'node',
          style: {
            width: 'data(size)',
            height: 'data(size)',
            'background-color': 'data(fill)',
            'border-color': 'data(border)',
            'border-width': 'data(borderWidth)',
            'border-style': 'data(borderStyle)',
            'pie-size': '78%',
            'pie-1-background-color': colors.done,
            'pie-1-background-size': (node) => `${node.data('pieDone') || 0}%`,
            'pie-2-background-color': colors.left,
            'pie-2-background-size': (node) => `${node.data('pieLeft') || 0}%`,
            'background-image': 'data(image)',
            'background-width': '100%',
            'background-height': '100%',
            'background-clip': 'none',
            'background-image-containment': 'over',
            'bounds-expansion': 8,
            label: 'data(name)',
            color: theme.ink,
            'font-family': 'Roboto, sans-serif',
            'font-size': 14,
            'text-valign': 'bottom',
            'text-margin-y': 5,
            'text-background-color': theme.surface,
            'text-background-opacity': 0.8,
            'text-background-padding': 2,
            'text-background-shape': 'round-rectangle',
            'min-zoomed-font-size': 9,
          },
        },
        {
          selector: ':parent',
          style: {
            shape: 'round-rectangle',
            'background-color': 'data(fill)',
            'background-opacity': 0.12,
            'background-image': 'none',
            'border-color': 'data(fill)',
            'border-width': 2,
            'border-style': 'solid',
            'pie-size': '0%',
            padding: 30,
            label: 'data(name)',
            'font-size': 16,
            'font-weight': 500,
            'text-valign': 'top',
            'text-margin-y': -4,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-color': colors.primary,
            'border-width': 5,
            'border-style': 'solid',
            'font-weight': 'bold',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 3,
            'line-color': colors.link,
            'curve-style': 'straight',
          },
        },
        {
          selector: 'edge[gate = "both"]',
          style: {
            width: 5,
            'line-color': colors.gate,
          },
        },
        {
          selector: 'edge[gate = "source"]',
          style: {
            'line-color': colors.gate,
            'line-style': 'dashed',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': colors.gate,
          },
        },
        {
          selector: 'edge[gate = "target"]',
          style: {
            'line-color': colors.gate,
            'line-style': 'dashed',
            'source-arrow-shape': 'triangle',
            'source-arrow-color': colors.gate,
          },
        },
        {
          selector: 'edge.hover, edge:selected',
          style: {
            'line-color': colors.primary,
            'source-arrow-color': colors.primary,
            'target-arrow-color': colors.primary,
            'z-index': 10,
          },
        },
      ]
    },

    // A system's fill, border, survey pie and overlay for the layer shown.
    markerData(row) {
      const { colors } = this
      let marker = { fill: colors.none, border: colors.ring, borderWidth: 2, borderStyle: 'solid', pieDone: 0, pieLeft: 0, spots: 0, spotColor: null }

      if (this.layer === 'geological' || this.layer === 'gravitational') {
        const geological = this.layer === 'geological'
        const total = geological ? row.bodies : row.locations
        const done = geological ? row.surveyedBodies : row.surveyedLocations
        const share = total ? Math.round((100 * done) / total) : 0

        marker = {
          ...marker,
          fill: total ? colors.surface : colors.none,
          border: total && share === 100 ? colors.done : colors.ring,
          borderStyle: !total ? 'dotted' : geological && row.cometsOnly ? 'dashed' : 'solid',
          pieDone: share,
          pieLeft: total ? 100 - share : 0,
          spots: geological ? row.groundSurveys : this.links.unexplored[row.id] || 0,
          spotColor: geological ? colors.ground : colors.unexplored,
        }
      } else if (this.layer === 'colonies') {
        marker = {
          ...marker,
          fill: row.population > 0 ? colors.colony : row.colonies ? colors.outpost : colors.none,
          border: row.capital ? colors.ink : row.colonies ? colors.colony : colors.ring,
          borderWidth: row.capital ? 4 : 2,
        }
      } else if (this.layer === 'sectors') {
        marker.fill = (this.sectorById[row.SectorID] || {}).color || colors.none
      } else if (this.layer === 'control') {
        marker.fill = row.ControlRaceID === this.RaceID ? colors.primary : (this.controllerById[row.ControlRaceID] || {}).color || colors.none
      } else {
        const hops = this.hops[row.id]

        marker = {
          ...marker,
          fill: hops === undefined ? colors.none : blend(colors.colony, colors.surface, 1 - (0.75 * hops) / this.farthestHop),
          border: row.capital ? colors.ink : colors.ring,
          borderWidth: row.capital ? 4 : 2,
        }
      }

      const { spots, spotColor, ...data } = marker

      return { ...data, image: markerImage(row.size, spots, spotColor, this.pinnedSet.has(row.id)) }
    },

    boxOf(row) {
      if (this.boxes === 'sectors' && this.sectorById[row.SectorID]) {
        return `box-sector-${row.SectorID}`
      }

      if (this.boxes === 'control' && this.controllerById[row.ControlRaceID]) {
        return `box-control-${row.ControlRaceID}`
      }

      return undefined
    },

    boxElements() {
      const boxes = new Map()

      this.systemRows.forEach((row) => {
        const id = this.boxOf(row)

        if (id && !boxes.has(id)) {
          const owner = this.boxes === 'sectors' ? this.sectorById[row.SectorID] : this.controllerById[row.ControlRaceID]

          boxes.set(id, { group: 'nodes', data: { id, name: owner.name, fill: owner.color }, selectable: false, grabbable: false, pannable: true })
        }
      })

      return [...boxes.values()]
    },

    createGraph() {
      const graph = cytoscape({
        container: this.$refs.canvas,
        style: this.stylesheet(),
        layout: { name: 'preset' },
        minZoom: 0.05,
        maxZoom: 4,
      })

      graph.on('mouseover', 'edge', (event) => event.target.addClass('hover'))
      graph.on('mouseout', 'edge', (event) => event.target.removeClass('hover'))
      graph.on('select unselect', 'node', () => this.queueSelection())
      graph.on('dragfree', 'node', () => {
        if (!this.busy) {
          this.refreshLayoutState()
        }
      })
      graph.on('scrollzoom pinchzoom dragpan', () => {
        this.fitted = false
      })

      this.graph = graph
      this.navigatorInstance = graph.navigator({
        container: '.map-navigator',
        viewLiveFramerate: 0,
        thumbnailEventFramerate: 30,
        thumbnailLiveFramerate: false,
        dblClickDelay: 200,
        removeCustomContainer: false,
        rerenderDelay: 100,
      })
      this.createMenu()

      // The side panel opening narrows the map; cytoscape only notices the window resizing. A map
      // the user hasn't moved is fitted again, so a larger window isn't left with it in a corner.
      this.resizeObserver = new ResizeObserver(() => {
        graph.resize()

        if (this.fitted && !this.busy) {
          graph.fit(undefined, 40)
        }
      })
      this.resizeObserver.observe(this.$refs.stage)
    },

    // The right-click menu: Minerals and the Colonization Planner for the selection, pin or
    // unpin, and the System View for a single system.
    createMenu() {
      if (this.menu) {
        this.menu.destroy()
      }

      const icon = (name) => `<span><i class="v-icon mdi ${name}"></i></span>`

      this.menu = this.graph.cxtmenu({
        menuRadius: 100,
        selector: 'node:selectable',
        fillColor: rgba(this.theme.primary, 0.88),
        activeFillColor: rgba(this.theme.categorical[2], 0.9),
        indicatorSize: 36,
        maxSpotlightRadius: 100,
        commands: (node) => {
          let selected = this.graph.nodes(':selected')

          if (!selected.contains(node)) {
            selected.unselect()
            selected = node
            node.select()
          }

          const ids = selected.map((element) => element.id())
          const commands = [
            { content: icon('mdi-diamond-stone'), select: () => this.$router.push(this.mineralsLink(ids)) },
            { content: icon('mdi-earth'), select: () => this.$router.push(this.plannerLink(ids)) },
            { content: icon(ids.every((id) => this.pinnedSet.has(id)) ? 'mdi-lock-open-variant' : 'mdi-lock'), select: () => this.togglePins(ids) },
          ]

          if (ids.length === 1) {
            commands.push({ content: icon('mdi-orbit'), select: () => this.openSystemView(ids[0]) })
          }

          return commands
        },
      })
    },

    resetGraph() {
      if (this.graph) {
        this.graph.elements().remove()
      }

      this.syncedStart = null
      this.fitPending = true
      this.fitted = true
      this.before = null
      this.selectedIds = []
      this.movedIds = []
      this.quality = null
    },

    scheduleSync() {
      if (this.syncQueued) {
        return
      }

      this.syncQueued = true
      this.$nextTick(() => {
        this.syncQueued = false
        this.syncGraph()
      })
    },

    // Brings the map in line with the save. A system the player has moved since the last sync
    // stays where it is; the rest go where the save now has them.
    syncGraph() {
      if (!this.ready || !this.$refs.canvas) {
        return
      }

      if (this.busy) {
        this.syncPending = true

        return
      }

      if (!this.graph) {
        this.createGraph()
      }

      const current = this.graphPositions()
      const previous = this.syncedStart || {}
      const positions = {}

      this.systemRows.forEach(({ id }) => {
        const now = current[id]
        const was = previous[id]

        positions[id] = now && was && !samePlace(now, was) ? now : this.startPositions[id]
      })

      this.syncedStart = this.startPositions
      this.buildElements(positions)

      if (this.fitPending) {
        this.fitPending = false
        this.graph.fit(undefined, 40)
      }

      this.refreshLayoutState()

      if (this.pendingFocus) {
        const id = this.pendingFocus

        this.pendingFocus = null
        this.focusSystem(id)
      }
    },

    buildElements(positions) {
      const graph = this.graph
      const selected = new Set(this.selectedIds)

      graph.batch(() => {
        graph.elements().remove()
        graph.add([
          ...this.boxElements(),
          ...this.systemRows.map((row) => ({
            group: 'nodes',
            data: { id: row.id, name: row.Name, system: true, parent: this.boxOf(row), size: row.size, ...this.markerData(row) },
            position: { ...positions[row.id] },
            locked: this.pinnedSet.has(row.id),
            selected: selected.has(row.id),
          })),
          ...this.links.list.map((link) => ({
            group: 'edges',
            data: { id: link.id, source: link.source, target: link.target, gate: link.gate, travel: link.travel, galactic: link.galactic },
          })),
        ])
      })

      this.queueSelection()
    },

    // Rebuilds the elements where they stand, for new boxes or colours.
    rebuild() {
      if (this.graph && this.syncedStart) {
        this.buildElements(this.graphPositions())
      }
    },

    restyle() {
      if (!this.graph) {
        return
      }

      this.graph.batch(() => {
        this.graph.nodes('[?system]').forEach((node) => {
          const row = this.rowById[node.id()]

          if (row) {
            node.data(this.markerData(row))
            if (this.pinnedSet.has(row.id)) {
              node.lock()
            } else {
              node.unlock()
            }
          }
        })
      })
    },

    graphPositions() {
      const positions = {}

      if (this.graph) {
        this.graph.nodes('[?system]').forEach((node) => {
          const { x, y } = node.position()

          positions[node.id()] = { x, y }
        })
      }

      return positions
    },

    // Which systems sit away from their saved place, and how tidy the map is.
    refreshLayoutState() {
      const positions = this.graphPositions()

      this.movedIds = Object.keys(positions).filter((id) => !this.savedPositions[id] || !samePlace(positions[id], this.savedPositions[id]))
      this.quality = this.systemRows.length ? layoutQuality({ edges: this.linkPairs, positions }) : null
    },

    queueSelection() {
      if (this.selectionQueued) {
        return
      }

      this.selectionQueued = true
      Promise.resolve().then(() => {
        this.selectionQueued = false
        this.selectedIds = this.graph ? this.graph.nodes('[?system]:selected').map((node) => node.id()) : []
      })
    },

    clearSelection() {
      if (this.graph) {
        this.graph.nodes(':selected').unselect()
      }

      this.foundId = null
    },

    focusSystem(id) {
      const node = this.graph && this.graph.getElementById(String(id))

      if (!node || node.empty()) {
        return
      }

      this.graph.nodes(':selected').unselect()
      node.select()
      this.fitted = false
      this.graph.animate({ center: { eles: node }, zoom: Math.max(this.graph.zoom(), 1) }, { duration: 400 })
    },

    focusCapital() {
      const node = this.graph && this.capitalId && this.graph.getElementById(this.capitalId)

      if (node && node.nonempty()) {
        this.fitted = false
        this.graph.animate({ center: { eles: node }, zoom: 1 }, { duration: 400 })
      }
    },

    fitView() {
      if (this.graph) {
        this.fitted = true
        this.graph.animate({ fit: { eles: this.graph.elements(), padding: 40 } }, { duration: 400 })
      }
    },

    togglePins(ids) {
      const pinned = new Set(this.pinned)
      const unpin = ids.every((id) => pinned.has(id))

      ids.forEach((id) => (unpin ? pinned.delete(id) : pinned.add(id)))
      this.pinned = [...pinned]
      this.setSetting('mapPinned', this.pinned)
    },

    unpinAll() {
      this.pinned = []
      this.setSetting('mapPinned', [])
    },

    // Makes `ids` one group, taking them out of any group they were in.
    keepTogether(ids) {
      const taken = new Set(ids)
      const groups = this.groups.map((group) => group.filter((id) => !taken.has(id))).filter((group) => group.length > 1)

      this.groups = [...groups, [...ids]]
      this.setSetting('mapGroups', this.groups)
    },

    leaveGroup(id) {
      this.groups = this.groups.map((group) => group.filter((member) => member !== id)).filter((group) => group.length > 1)
      this.setSetting('mapGroups', this.groups)
    },

    dropGroup(index) {
      this.groups = this.groups.filter((_group, i) => i !== index)
      this.setSetting('mapGroups', this.groups)
    },

    openSystemView(id) {
      this.systemViewId = String(id)
      this.systemDialog = true
    },

    // Runs a cytoscape layout; the toolbar waits for it to stop.
    runLayout(options) {
      if (this.layoutInstance) {
        const running = this.layoutInstance

        this.layoutInstance = null
        running.stop()
      }

      const layout = this.graph.layout(options)

      this.layoutInstance = layout
      this.busy = 'layout'
      layout.one('layoutstop', () => {
        if (this.layoutInstance === layout) {
          this.layoutInstance = null
          this.finishBusy()
        }
      })
      layout.run()
    },

    animateTo(positions, fit = false) {
      this.fitted = this.fitted || fit
      this.runLayout({
        name: 'preset',
        positions: (node) => positions[node.id()],
        fit,
        padding: 40,
        animate: true,
        animationDuration: 700,
        animationEasing: 'ease-in-out-cubic',
      })
    },

    stopBusy() {
      this.run = null

      if (this.layoutInstance) {
        const running = this.layoutInstance

        this.layoutInstance = null
        running.stop()
      }

      this.finishBusy()
    },

    finishBusy() {
      this.busy = null
      this.phase = null
      this.progress = 0
      this.refreshLayoutState()

      if (this.syncPending) {
        this.syncPending = false
        this.syncGraph()
      }
    },

    // Lays the map on a grid with `gridLayout`, a slice at a time, then moves the systems there.
    async arrangeMap() {
      if (!this.graph || this.busy) {
        return
      }

      this.arrangeMenu = false

      const positions = this.graphPositions()
      const before = layoutQuality({ edges: this.linkPairs, positions })
      const iterator = gridLayout({
        nodes: this.systemRows.map((row) => ({ id: row.id, group: this.keepTogetherKeys[row.id] || null, pinned: this.pinnedSet.has(row.id) })),
        edges: this.linkPairs,
        capitalId: this.capitalId,
        positions,
        options: { mode: this.arrange.mode, spacing: this.arrange.spacing, diagonals: this.arrange.diagonals },
      })
      const run = {}
      let step

      this.run = run
      this.busy = 'arrange'
      this.phase = null
      this.progress = 0

      try {
        do {
          const end = performance.now() + SLICE_MS

          do {
            step = iterator.next()
          } while (!step.done && performance.now() < end)

          if (!step.done) {
            this.phase = step.value.phase
            this.progress = Math.max(this.progress, overallProgress(this.arrange.mode, step.value))
            await nextTask()
          }

          if (this.run !== run) {
            return
          }
        } while (!step.done)
      } catch (error) {
        if (this.run === run) {
          this.run = null
          this.finishBusy()
        }

        this.activateSnackbar({ color: 'error', text: `Arrange failed: ${error.message}` })

        return
      }

      this.run = null
      this.before = before
      this.animateTo(step.value.positions, true)
    },

    edgeLength(edge) {
      if (this.linkLength === 'galactic') {
        return edge.data('galactic') ?? 200
      }

      if (this.linkLength === 'travel') {
        return edge.data('travel') ?? 200
      }

      return LINK_LENGTHS.find((option) => option.value === this.linkLength).length
    },

    applyForces() {
      this.before = null
      this.runLayout({
        name: 'fcose',
        randomize: false,
        fit: false,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: false,
        quality: 'proof',
        numIter: 16000,
        animate: true,
        animationDuration: 1600,
        animationEasing: 'ease-out',
        ...(this.linkLength === 'auto' ? {} : { idealEdgeLength: (edge) => this.edgeLength(edge) }),
        nodeRepulsion: 15000,
        edgeElasticity: 1,
        nestingFactor: 0,
        gravity: 0.1,
      })
    },

    scramble() {
      this.before = null
      this.runLayout({
        name: 'cola',
        randomize: false,
        fit: false,
        avoidOverlap: false,
        handleDisconnected: true,
        centerGraph: false,
        animate: true,
        refresh: 10,
        animationEasing: 'ease-out',
        ...(this.linkLength === 'auto' ? {} : { edgeLength: (edge) => this.edgeLength(edge) }),
        nodeSpacing: 0,
        maxIterations: 5000,
        maxSimulationTime: 25000,
      })
    },

    revertPositions() {
      this.before = null
      this.animateTo(this.startPositions, true)
    },

    // Writes the systems that moved, in one transaction, as the whole numbers the game reads.
    async savePositions() {
      const positions = this.graphPositions()
      const ids = this.movedIds.filter((id) => positions[id])

      this.saving = true

      try {
        await this.database.transaction(async (transaction) => {
          for (const id of ids) {
            await this.database.query(`update FCT_RaceSysSurvey set Xcor = ${Math.round(positions[id].x)}, Ycor = ${Math.round(positions[id].y)} where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.SystemID = ${Number(id)}`, { transaction })
          }
        })

        this.saveDialog = false
        this.before = null
        this.activateSnackbar({ color: 'success', text: `Saved the positions of ${ids.length} ${ids.length === 1 ? 'system' : 'systems'}` })
        this.$asyncComputed.systems.update()
      } catch (error) {
        this.activateSnackbar({ color: 'error', text: `Couldn't save the positions: ${error.message}` })
      } finally {
        this.saving = false
      }
    },

    exportPng() {
      const image = this.graph.png({ output: 'base64', full: true, scale: 2, bg: this.theme.surface })

      ipcRenderer.invoke('save-png', image, `map-${this.GameID}-${this.RaceID}-${this.GameTime}.png`).then((result) => {
        if (!result?.canceled) {
          this.activateSnackbar({ color: 'success', text: 'Map exported as PNG' })
        }
      }).catch((error) => {
        this.activateSnackbar({ color: 'error', text: `Couldn't export the map: ${error.message}` })
      })
    },
  },
  asyncComputed: {
    // The known systems with where the race has them on its map, their survey state, the race's
    // colonies there, and the star's place in the galaxy for the free layouts.
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.SectorID, FCT_RaceSysSurvey.ControlRaceID, FCT_RaceSysSurvey.DiscoveredTime, DIM_KnownSystems.X, DIM_KnownSystems.Y, DIM_KnownSystems.Z, Bodies.Bodies, Bodies.Planets, Bodies.Comets, Bodies.Surveyed as SurveyedBodies, Bodies.GroundSurveys, Locations.Locations, Locations.Surveyed as SurveyedLocations, Colonies.Colonies, Colonies.Population, Colonies.Capital from FCT_RaceSysSurvey left join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID left join DIM_KnownSystems on DIM_KnownSystems.KnownSystemID = FCT_System.SystemNumber left join (select FCT_SystemBody.SystemID, count(*) as Bodies, sum(FCT_SystemBody.BodyClass in (1, 2)) as Planets, sum(FCT_SystemBody.BodyClass = 5) as Comets, count(FCT_SystemBodySurveys.SystemBodyID) as Surveyed, sum(FCT_SystemBodySurveys.SystemBodyID is not null and FCT_SystemBody.GroundMineralSurvey > 0) as GroundSurveys from FCT_SystemBody inner join FCT_RaceSysSurvey as Known on Known.SystemID = FCT_SystemBody.SystemID and Known.RaceID = ${this.RaceID} and Known.GameID = ${this.GameID} left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} where FCT_SystemBody.GameID = ${this.GameID} group by FCT_SystemBody.SystemID) as Bodies on Bodies.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_SurveyLocation.SystemID, count(*) as Locations, count(FCT_RaceSurveyLocation.SystemID) as Surveyed from FCT_SurveyLocation inner join FCT_RaceSysSurvey as Known on Known.SystemID = FCT_SurveyLocation.SystemID and Known.RaceID = ${this.RaceID} and Known.GameID = ${this.GameID} left join FCT_RaceSurveyLocation on FCT_RaceSurveyLocation.SystemID = FCT_SurveyLocation.SystemID and FCT_RaceSurveyLocation.LocationNumber = FCT_SurveyLocation.LocationNumber and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID) as Locations on Locations.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_Population.SystemID, count(*) as Colonies, sum(FCT_Population.Population) as Population, max(FCT_Population.Capital) as Capital from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemID) as Colonies on Colonies.SystemID = FCT_RaceSysSurvey.SystemID where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([rows]) => rows)
      }),
      default: [],
    },
    jumpPoints: {
      get: tracked('jumpPoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadJumpPoints(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    sectors: {
      get: tracked('sectors', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_SectorCommand.SectorCommandID, FCT_SectorCommand.SectorName from FCT_SectorCommand where FCT_SectorCommand.GameID = ${this.GameID} and FCT_SectorCommand.RaceID = ${this.RaceID} order by FCT_SectorCommand.SectorCommandID`).then(([rows]) => rows)
      }),
      default: [],
    },
    aliens: {
      get: tracked('aliens', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_AlienRace.AlienRaceID, FCT_AlienRace.AlienRaceName from FCT_AlienRace where FCT_AlienRace.GameID = ${this.GameID} and FCT_AlienRace.ViewRaceID = ${this.RaceID}`).then(([rows]) => rows)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.map-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  // The window less the app bar with its tabs (108), the footer (36) and the layout's padding (24).
  height: calc(100vh - 168px);
  min-height: 520px;

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px 16px;
  }

  .tool {
    min-width: 0;
  }

  .tool__label {
    height: 18px;
    line-height: 18px;
  }

  .tool--find {
    flex: 1 1 120px;
    min-width: 110px;
    max-width: 300px;
  }

  .tool--layer {
    flex: 0 1 200px;
    min-width: 170px;
  }

  .tool--boxes {
    flex: 0 1 140px;
    min-width: 120px;
  }

  .tool--actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .tool--actions .v-btn:not(.v-btn--icon) {
    height: 40px !important;
  }

  .map-card {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 24px;
    padding: 10px 16px;
  }

  .panel-foot {
    padding: 8px 16px 12px;
    border-top: 1px solid var(--ae-border);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
  }

  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
  }

  .dot-ring {
    background: transparent;
    border: 2px solid;
  }

  .spot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 6px;
  }

  .line {
    display: inline-block;
    width: 18px;
    height: 4px;
    border-radius: 2px;
    margin-right: 6px;
  }

  .line--dashed {
    height: 0;
    border-radius: 0;
    border-top: 3px dashed;
  }

  .map-controls,
  .map-status {
    position: absolute;
    z-index: 5;
    display: flex;
    align-items: center;
    border: 1px solid var(--ae-border);
    border-radius: 4px;
    background: var(--ae-bg);
  }

  .map-controls {
    top: 8px;
    right: 8px;
    padding: 2px;
  }

  .map-status {
    left: 8px;
    bottom: 8px;
    max-width: calc(100% - 16px);
    gap: 8px;
    padding: 2px 8px;
    font-variant-numeric: tabular-nums;
  }

  .busy-bar {
    width: 120px;
  }

  .map-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    border-top: 1px solid var(--ae-border);
  }

  .map-stage {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    background-color: var(--ae-bg);
    background-image: radial-gradient(var(--ae-border) 1px, transparent 0);
    background-size: 20px 20px;
  }

  .map-canvas {
    position: absolute;
    inset: 0;
  }

  .map-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .map-navigator {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: clamp(120px, 18%, 220px);
    height: clamp(80px, 24%, 150px);
    z-index: 5;
    overflow: hidden;
    border: 1px solid var(--ae-border);
    border-radius: 4px;
    background: var(--ae-chrome);

    > img {
      max-width: 100%;
      max-height: 100%;
    }

    > canvas {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 101;
    }

    .cytoscape-navigatorView {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 102;
      cursor: move;
      background: var(--ae-hover);
      border: 2px solid var(--ae-primary);
    }

    .cytoscape-navigatorOverlay {
      position: absolute;
      inset: 0;
      z-index: 103;
    }
  }

  .map-side {
    flex: 0 0 300px;
    min-width: 0;
    overflow-y: auto;
    padding: 12px 16px 16px;
    border-left: 1px solid var(--ae-border);
  }

  .side-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .min-width-0 {
    min-width: 0;
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    font-size: 13px;

    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .side-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
}

.arrange-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.free-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
