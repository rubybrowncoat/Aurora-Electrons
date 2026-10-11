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
        <div class="tool tool--borders">
          <div class="tool__label caption text--secondary">Borders</div>
          <v-select v-model="borders" :items="borderOptions" aria-label="Draw borders round" dense outlined hide-details @change="(value) => setSetting('mapBorders', value)" />
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
                <v-select v-model="arrange.keepTogether" :items="keepTogetherOptions" label="Keep together" placeholder="Nothing" persistent-placeholder multiple dense outlined hide-details @change="saveArrange">
                  <!-- One line for what's chosen, where the select would wrap each choice onto its own. -->
                  <template #selection="{ index }">
                    <span v-if="index === 0" class="v-select__selection v-select__selection--comma" :title="keepTogetherLabel">{{ keepTogetherLabel }}</span>
                  </template>
                </v-select>
              </div>
              <v-checkbox v-model="arrange.diagonals" label="Allow links at 45°" dense hide-details @change="saveArrange" />
              <v-checkbox v-model="arrange.nexuses" label="Centre nexuses" dense hide-details @change="saveArrange" />
              <div v-if="arrange.nexuses" class="caption text--secondary mt-2">{{ nexusHint }}</div>
              <div v-if="arrange.keepTogether.includes('stabilised')" class="caption text--secondary mt-2">Only jumps stabilised at both ends join a network.</div>
              <div v-if="arrange.keepTogether.length > 1" class="caption text--secondary mt-2">With several choices, systems stay with those sharing every selected group.</div>
              <div v-if="groupList.length" class="mt-4">
                <div class="caption text--secondary">Your groups, which come before the setting above</div>
                <div v-for="group in groupList" :key="group.index" class="group-row">
                  <span class="body-2 text-truncate" :title="group.title"><v-icon x-small :color="group.color" class="mr-1">mdi-circle</v-icon>{{ group.name }}: {{ group.label }}</span>
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
                <v-btn outlined small title="Shakes the map loose and separates the systems" @click="scramble">Scramble</v-btn>
              </div>
              <div class="caption text--secondary mt-2">Forces don't take galactic distances.</div>
            </v-card>
          </v-menu>
          <v-btn outlined :disabled="!!busy || !movedIds.length" title="Put every system back where the save has it" @click="revertPositions"><v-icon small left>mdi-undo</v-icon>Revert</v-btn>
          <v-btn outlined color="primary" :disabled="!!busy || !movedIds.length" @click="saveDialog = true"><v-icon small left>mdi-content-save-outline</v-icon>Save positions<span v-if="movedIds.length">&nbsp;({{ movedIds.length }})</span></v-btn>
        </div>
      </div>

      <v-card class="panel map-card" elevation="1">
        <div class="panel-head">
          <span class="legend">
            <span v-for="(row, index) in legendRows" :key="index" class="legend-row">
              <span v-for="item in row" :key="`${item.kind}-${item.label}`" class="legend-item" :class="{ 'legend-item--heading': item.kind === 'heading', 'text--secondary': item.kind === 'note' }">
                <span v-if="item.kind === 'ring'" class="dot dot-ring" :style="{ borderColor: item.color, borderStyle: item.style || 'solid', borderWidth: item.width && `${item.width}px` }" />
                <span v-else-if="item.kind === 'spot'" class="spot" :style="{ background: item.color }" />
                <span v-else-if="item.kind === 'line'" class="line" :class="{ 'line--dashed': item.dashed }" :style="item.dashed ? { borderColor: item.color } : { background: item.color }" />
                <v-icon v-else-if="item.kind === 'icon'" x-small class="mr-1">{{ item.icon }}</v-icon>
                <map-glyph v-else-if="item.kind === 'glyph'" :path="item.path" :text="item.text" :color="item.color" :hollow="item.hollow" :surface="colors.surface" />
                <span v-else-if="item.kind === 'sample'" class="sample">{{ item.sample }}</span>
                <span v-else-if="item.kind === 'area'" class="area" :style="{ borderColor: item.color, background: item.tint }"><span v-if="item.dot" class="dot" :style="{ background: item.color }" /></span>
                <span v-else-if="item.kind !== 'heading' && item.kind !== 'note'" class="dot" :style="{ background: item.color }" />
                {{ item.label }}
              </span>
            </span>
          </span>
        </div>
        <div class="map-body">
          <div ref="stage" class="map-stage" @wheel.capture="shiftWheel">
            <canvas ref="borders" class="map-borders" />
            <div ref="canvas" class="map-canvas" aria-label="Galactic map of the known systems and their jump links" />
            <div ref="minimap" class="map-minimap" @pointerdown="fitted = false" />
            <div class="map-controls">
              <v-btn icon small aria-label="Centre on the capital" title="Centre on the capital" :disabled="!systemRows.length" @click="focusCapital"><v-icon small>mdi-crosshairs-gps</v-icon></v-btn>
              <v-btn icon small aria-label="Fit the map" title="Fit the map" :disabled="!systemRows.length" @click="fitView"><v-icon small>mdi-fit-to-screen</v-icon></v-btn>
              <v-btn icon small :color="locked ? 'primary' : undefined" :aria-pressed="String(locked)" :aria-label="lockLabel" :title="lockLabel" @click="toggleLock"><v-icon small>{{ locked ? 'mdi-lock' : 'mdi-lock-open-variant-outline' }}</v-icon></v-btn>
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
            <div class="caption text--secondary mt-2">Keep together makes them a group, which Colour by and Borders show under Your groups. Arrange draws a group's systems together and keeps other systems from between them, as far as their links allow.</div>
          </aside>
        </div>
        <div class="panel-foot caption text--secondary">
          <span class="panel-foot__text">
            Positions are the game's galactic map, in its units; markers grow with the people living there. Shift-click or shift-drag to select several systems; right-click one for a quick menu.
            <template v-if="unplacedIds.length">{{ unplacedIds.length }} {{ unplacedIds.length === 1 ? 'system has' : 'systems have' }} no place on the save's map (the game left {{ unplacedIds.length === 1 ? 'it' : 'them' }} at its centre), so {{ unplacedIds.length === 1 ? 'it sits' : 'they sit' }} beside a linked system until you save.</template>
          </span>
          <!-- What the map marks, as a game's minimap tracking button: a disc for each mark that is on, and a
               list to turn them on and off. -->
          <v-menu top left offset-y nudge-top="6" :close-on-content-click="false" content-class="tracker-menu">
            <template #activator="{ on, attrs }">
              <v-btn small outlined class="map-tracker" :aria-label="trackerLabel" :title="trackerLabel" v-bind="attrs" v-on="on">
                <v-icon small>mdi-binoculars</v-icon>
                <map-glyph v-for="mark in trackedMarks" :key="mark.value" v-bind="mark.disc" :surface="colors.surface" />
              </v-btn>
            </template>
            <v-card>
              <v-list dense>
                <template v-for="group in markGroups">
                  <v-subheader :key="group.place">{{ group.header }}</v-subheader>
                  <v-list-item v-for="mark in group.marks" :key="mark.value" role="menuitemcheckbox" :aria-checked="String(marksSet.has(mark.value))" @click="toggleMark(mark.value)">
                    <v-icon class="mr-3" :color="marksSet.has(mark.value) ? 'primary' : undefined">{{ marksSet.has(mark.value) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}</v-icon>
                    <v-list-item-title>{{ mark.text }}</v-list-item-title>
                    <map-glyph class="ml-3" v-bind="markDiscs[mark.value]" :surface="colors.surface" />
                  </v-list-item>
                </template>
              </v-list>
            </v-card>
          </v-menu>
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

import { chartTheme } from '../components/charts/theme'
import MapGlyph from '../components/MapGlyph.vue'
import SystemView from '../components/SystemView.vue'
import countFormat from '../mixins/count-format'
import { gameTime } from '../utilities/aurora'
import { gridLayout, GRID_LAYOUT_DEFAULTS, layoutQuality } from '../utilities/grid-layout'
import { buildDistanceMap, loadJumpPoints } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { bordersBox, drawBorders, groupBorders, placeLabels, showsLabels, TINT } from '../utilities/map-borders'
import { COLONY_COST_BANDS, loadHabitability, loadMapFeatures, ruinState } from '../utilities/map-features'
import { createMinimap, wheelZoom } from '../utilities/map-minimap'
import { placeUnplaced } from '../utilities/map-placement'
import { scaleValue } from '../utilities/math'

cytoscape.use(cxtmenu)
cytoscape.use(cola)
cytoscape.use(fcose)

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  sectors: 'your sectors',
  aliens: 'the alien races you know',
  features: 'what the map can mark',
}
const INPUTS = Object.keys(INPUT_LABELS)

const LAYERS = [
  { value: 'geological', text: 'Geological survey' },
  { value: 'gravitational', text: 'Gravitational survey' },
  { value: 'colonies', text: 'Colonies' },
  { value: 'habitability', text: 'Habitability' },
  { value: 'stars', text: 'Star type' },
  { value: 'sectors', text: 'Sectors' },
  { value: 'control', text: 'Alien control' },
  { value: 'groups', text: 'Your groups' },
  { value: 'jumps', text: 'Jumps from a system' },
  { value: 'travel', text: 'Travel from a system' },
  { value: 'discovery', text: 'Discovery era' },
]

// The Star type layer's groups for a system's primary star, the first that fits it: by its size for the
// giants, else by its spectral class. A group's colour is its entry in the page's `colors.stars`.
const GIANT_SIZES = new Set(['III', 'II', 'Ib', 'Ia'])
const STAR_GROUPS = [
  { value: 'hole', text: 'Black hole', fits: (spectral) => spectral === 'BH' },
  { value: 'giant', text: 'Giant (Wolf-Rayet, carbon and S stars too)', fits: (spectral, size) => GIANT_SIZES.has(size) || ['WR', 'C', 'S'].includes(spectral) },
  { value: 'hot', text: 'O, B or A', fits: (spectral) => ['O', 'B', 'A'].includes(spectral) },
  { value: 'yellow', text: 'F or G', fits: (spectral) => ['F', 'G'].includes(spectral) },
  { value: 'orange', text: 'K', fits: (spectral) => spectral === 'K' },
  { value: 'red', text: 'M', fits: (spectral) => spectral === 'M' },
  { value: 'white', text: 'White dwarf', fits: (spectral) => spectral === 'D' },
  { value: 'brown', text: 'Brown dwarf (L, T or Y)', fits: (spectral) => ['L', 'T', 'Y'].includes(spectral) },
]

const starGroup = (spectral, size) => (STAR_GROUPS.find((group) => group.fits(spectral, size)) || {}).value || null

// What the borders go round: sectors, alien control, colonies, danger, stabilised networks, or
// the groups the player keeps together.
const BORDER_OPTIONS = [
  { value: 'none', text: 'None' },
  { value: 'sectors', text: 'Sectors', empty: 'no sector has a system' },
  { value: 'control', text: 'Alien control', empty: 'no alien race holds a system' },
  { value: 'colonies', text: 'Your colonies', empty: 'no colonies' },
  { value: 'danger', text: 'Danger', empty: 'no system has a danger rating' },
  { value: 'stabilised', text: 'Stabilised networks', empty: 'no jumps are stabilised at both ends' },
  { value: 'groups', text: 'Your groups', empty: 'no groups (select systems and keep them together)' },
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

// Arrange combines the chosen kinds: systems stay with those sharing all of them.
// `short` names each kind in the field when several are chosen.
const KEEP_TOGETHER = [
  { value: 'sectors', text: 'Sectors', short: 'sectors' },
  { value: 'control', text: 'Alien control', short: 'aliens' },
  { value: 'stabilised', text: 'Stabilised networks', short: 'networks' },
]

// Arrange can centre the systems with more jump points than this, the nexuses.
const NEXUS_JUMP_POINTS = 6

const LOCK_PATH = 'M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z'
const PILLAR_PATH = 'M6,5H18A1,1 0 0,1 19,6A1,1 0 0,1 18,7H6A1,1 0 0,1 5,6A1,1 0 0,1 6,5M21,2V4H3V2H21M15,8H17V22H15V8M7,8H9V22H7V8M11,8H13V22H11V8Z'
const PYRAMID_PATH = 'M21.85 16.96H21.85L12.85 2.47C12.65 2.16 12.33 2 12 2S11.35 2.16 11.15 2.47L2.15 16.96H2.15C1.84 17.45 2 18.18 2.64 18.43L11.64 21.93C11.75 22 11.88 22 12 22S12.25 22 12.36 21.93L21.36 18.43C22 18.18 22.16 17.45 21.85 16.96M11 6.5V13.32L5.42 15.5L11 6.5M12 19.93L5.76 17.5L12 15.07L18.24 17.5L12 19.93M13 13.32V6.5L18.58 15.5L13 13.32Z'
const HURRICANE_PATH = 'M15,6.79C16.86,7.86 18,9.85 18,12C18,22 6,22 6,22C7.25,21.06 8.38,19.95 9.34,18.71C9.38,18.66 9.41,18.61 9.44,18.55C9.69,18.06 9.5,17.46 9,17.21C7.14,16.14 6,14.15 6,12C6,2 18,2 18,2C16.75,2.94 15.62,4.05 14.66,5.29C14.62,5.34 14.59,5.39 14.56,5.45C14.31,5.94 14.5,6.54 15,6.79M12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14Z'
const CLOSE_PATH = 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z'
const ALERT_PATH = 'M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16'
const CALENDAR_PATH = 'M12 12H17V17H12V12M19 3H18V1H16V3H8V1H6V3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3M19 5V7H5V5H19M5 19V9H19V19H5Z'
const EARTH_PATH = 'M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z'

// What Show adds to the map: glyphs round a system's marker, a mark after its name, or lines under it.
// `short` names each mark in the tracker's title when several are on. In the tracker a mark is a disc
// with its icon `path`, filled in the `colors` entry its glyphs take, or hollow for marks the names
// carry; `offset` centres an icon MDI draws high in its square (see MapGlyph).
const MARKS = [
  { value: 'habitable', text: 'Habitable worlds', short: 'habitable worlds', place: 'glyph', path: EARTH_PATH, color: 'colony' },
  { value: 'ruins', text: 'Ruins', short: 'ruins', place: 'glyph', path: PILLAR_PATH, color: 'ruins' },
  { value: 'constructs', text: 'Ancient constructs', short: 'constructs', place: 'glyph', path: PYRAMID_PATH, color: 'construct' },
  { value: 'rifts', text: 'Aether rifts', short: 'rifts', place: 'glyph', path: HURRICANE_PATH, color: 'rift' },
  { value: 'wrecks', text: 'Wrecks', short: 'wrecks', place: 'name', path: CLOSE_PATH },
  { value: 'danger', text: 'Danger and protection', short: 'danger', place: 'line', path: ALERT_PATH, offset: [0, 0.5] },
  { value: 'discovered', text: 'Discovery date', short: 'discovery', place: 'line', path: CALENDAR_PATH, offset: [0, 1] },
]

const MARK_HEADERS = { glyph: 'Round the marker', name: 'After the name', line: 'Under the name' }

const MARK_GROUPS = Object.keys(MARK_HEADERS).map((place) => ({ place, header: MARK_HEADERS[place], marks: MARKS.filter((mark) => mark.place === place) }))

// A system with nothing to mark.
const NO_FEATURES = Object.freeze({ ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, warships: 0, ships: 0 })

const PHASES = {
  stress: 'Spreading the systems out',
  place: 'Putting them on the grid',
  improve: 'Untangling the links',
}

// Arrange works in slices this long, handing the browser a turn between them to draw.
const SLICE_MS = 12

// Glyphs sit on a ring just outside the marker's rim, 16 units across with a 12 unit icon, so a
// marker with any has this much more room on every side.
const GLYPH_RADIUS = 8
const GLYPH_RING = 10
const MARK_ROOM = 20
// Where the glyphs go round the marker, in degrees clockwise from the top: the left first, then over
// the top and down the right, clear of the name below. The count of habitable worlds has its own place
// at the top right, BADGE_ANGLE, which the others leave free.
const GLYPH_ANGLES = [300, 330, 270, 0, 240, 60, 90, 120]
const BADGE_ANGLE = 30

// A new task as soon as the browser has had its turn. Unlike an animation frame, it still comes
// in a hidden or minimised window, so an Arrange carries on there.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(null)
})

// The map as the player left it, per game and race: places with any unsaved moves, the view and the
// selection. Coming back to the page, by the back arrow, the trail or a link, picks it up again.
const keptMaps = new Map()

const samePlace = (a, b) => Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y)

// `hex` laid over `background` at `alpha`, as an opaque colour: cytoscape takes no alpha in a colour.
const blend = (hex, background, alpha) => {
  const channels = (value) => [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16))
  const top = channels(hex)
  const bottom = channels(background)

  return `#${top.map((channel, i) => Math.round(channel * alpha + bottom[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(', ')}, ${alpha})`

// Jumps from `origin` to every system an explored route reaches, over the page's `neighbours`.
const hopsFrom = (origin, neighbours) => {
  const hops = { [origin]: 0 }
  const queue = [origin]

  for (let i = 0; i < queue.length; i += 1) {
    (neighbours[queue[i]] || []).forEach((other) => {
      if (hops[other] === undefined) {
        hops[other] = hops[queue[i]] + 1
        queue.push(other)
      }
    })
  }

  return hops
}

const MARKER_BASE_SIZE = 44
const COLONY_FULL_MILLIONS = 10

// 44 units across for a system with nobody in it, growing towards 104 with colonies and people.
const markerSize = (colonies, population) => {
  if (!colonies) {
    return MARKER_BASE_SIZE
  }

  const count = Math.log1p(colonies) / Math.log1p(100)
  const people = Math.log1p(Math.max(0, population)) / Math.log1p(10000)
  const blended = Math.exp(0.3 * Math.log(Math.max(1e-9, count)) + 0.7 * Math.log(Math.max(1e-9, people)))

  return Math.round(MARKER_BASE_SIZE + 60 * (blended / (1 + blended)))
}

// The broken rings round empty systems (dots) and comets-only ones (dashes). Cytoscape's own dotted
// border puts dots one unit apart, which blur into a plain ring as soon as the map is zoomed out.
// These are drawn as dash patterns instead, `dash` long with `gap` between at zoom 1, and at least
// `least` of them round a system.
const RING_DOTS = { dash: 0, gap: 6, least: 8 }
const RING_DASHES = { dash: 7, gap: 4, least: 6 }

// Below RING_ZOOM the rings grow thicker and their gaps wider so they still show on screen. They
// grow in these steps, rather than smoothly, so zooming restyles the map only now and then.
const RING_ZOOM = 0.6
const RING_SCALES = [1, 1.25, 1.5, 2, 2.5, 3, 4]

const ringScaleAt = (zoom) => RING_SCALES.find((scale) => scale >= RING_ZOOM / zoom) || RING_SCALES[RING_SCALES.length - 1]

// A wheel or pinch zoom restyles the markers once it has paused this long, the pause after which
// cytoscape too counts a wheel zoom as over.
const ZOOM_PAUSE_MS = 150
// Cytoscape keeps a picture of the whole map to pan and zoom with. It makes that picture only
// while drawing, and not within a quarter second of the systems changing, so the map draws one more
// frame once it has been quiet this long.
const SETTLE_MS = 300

const ringPatterns = new Map()

// A whole number of dashes round the ring, so none is cut short where the ring starts and ends.
const ringPattern = (size, scale, { dash, gap, least }) => {
  const key = `${size}|${scale}|${dash}|${gap}|${least}`

  // Cytoscape skips a function-mapped property when its value has the same identity. Reusing the
  // pattern also avoids reparsing unchanged rings when another marker property changes.
  if (!ringPatterns.has(key)) {
    const around = Math.PI * size
    const period = around / Math.max(least, Math.round(around / ((dash + gap) * scale)))

    ringPatterns.set(key, [(period * dash) / (dash + gap), (period * gap) / (dash + gap)])
  }

  return ringPatterns.get(key)
}

const markerImages = new Map()

// A clear pixel, for a marker with nothing over its fill. Cytoscape restyles a node without an
// image each time it draws it, which throws away the picture of the whole map it keeps for
// panning and zooming, so every frame would draw each system and link again.
const CLEAR_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// What a marker carries over its fill: `spots` small dots round the rim (unexplored jump points,
// or bodies with ground survey potential), a lock on a pinned system, and `glyphs` round the
// outside (`{ key, path, color, hollow }`, or a count as `text` at its own `angle`), which the image
// then has MARK_ROOM for on every side.
const markerImage = (size, spots, color, pinned, glyphs, surface) => {
  if (!spots && !pinned && !glyphs.length) {
    return CLEAR_IMAGE
  }

  const key = `${size}|${spots}|${color}|${pinned}|${glyphs.map((glyph) => glyph.key).join(',')}|${surface}`

  if (!markerImages.has(key)) {
    const room = glyphs.length ? MARK_ROOM : 0
    const centre = size / 2 + room
    const width = size + 2 * room
    let content = ''

    for (let i = 0; i < spots; i += 1) {
      const radius = size / 2 - 4 + 3 * Math.floor(i / 11)
      const angle = (32 * i * Math.PI) / 180

      content += `<circle cx="${centre + radius * Math.sin(angle)}" cy="${centre - radius * Math.cos(angle)}" r="3" fill="${color}" />`
    }

    if (pinned) {
      const lock = size / 3

      content += `<g transform="translate(${centre - lock / 2}, ${centre - lock / 2}) scale(${lock / 24})"><path fill="black" stroke="black" stroke-width="3" d="${LOCK_PATH}" /><path fill="white" d="${LOCK_PATH}" /></g>`
    }

    let next = 0

    glyphs.forEach((glyph) => {
      const degrees = glyph.angle === undefined ? GLYPH_ANGLES[next++] : glyph.angle

      if (degrees === undefined) {
        return
      }

      const angle = (degrees * Math.PI) / 180
      const x = centre + (size / 2 + GLYPH_RING) * Math.sin(angle)
      const y = centre - (size / 2 + GLYPH_RING) * Math.cos(angle)
      const icon = GLYPH_RADIUS - 2
      const ink = glyph.hollow ? glyph.color : surface

      content += `<circle cx="${x}" cy="${y}" r="${GLYPH_RADIUS}" fill="${glyph.hollow ? surface : glyph.color}" stroke="${glyph.hollow ? glyph.color : surface}" stroke-width="1.5" />`
      content += glyph.text
        ? `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Roboto, Arial, sans-serif" font-weight="700" font-size="${[11, 9, 7][Math.min(glyph.text.length, 3) - 1]}" fill="${ink}">${glyph.text}</text>`
        : `<path transform="translate(${x - icon}, ${y - icon}) scale(${(2 * icon) / 24})" fill="${ink}" d="${glyph.path}" />`
    })

    markerImages.set(key, `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${width} ${width}">${content}</svg>`)}`)
  }

  return markerImages.get(key)
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
  components: { MapGlyph, SystemView },
  mixins: [countFormat],
  data() {
    return {
      loadErrors: {},
      // Set once the first reads are in, so the map stays up while the page reads a changed save.
      loaded: false,

      layer: 'geological',
      borders: 'none',
      linkLength: 'travel',
      locked: false,
      arrange: { mode: GRID_LAYOUT_DEFAULTS.mode, spacing: GRID_LAYOUT_DEFAULTS.spacing, diagonals: GRID_LAYOUT_DEFAULTS.diagonals, keepTogether: [], nexuses: false },
      pinned: [],
      groups: [],
      marks: [],

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
      borderOptions: BORDER_OPTIONS,
      linkLengths: LINK_LENGTHS,
      arrangeModes: ARRANGE_MODES,
      spacings: SPACINGS,
      keepTogetherOptions: KEEP_TOGETHER,
      markGroups: MARK_GROUPS,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'GameTime']),

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    colors() {
      const { categorical, inkMuted, surface, ink, primary } = this.theme
      const [blue, orange, green, amber, pink, , violet, red] = categorical
      const outpost = blend(blue, surface, 0.35)

      return {
        done: this.layer === 'colonies' ? blue : green,
        left: this.layer === 'colonies' ? outpost : orange,
        ground: pink,
        unexplored: amber,
        colony: blue,
        outpost,
        none: blend(inkMuted, surface, 0.3),
        ring: inkMuted,
        ink,
        surface,
        primary,
        link: blend(inkMuted, surface, 0.6),
        gate: violet,
        danger: red,
        ruins: amber,
        construct: green,
        rift: pink,
        discovery: orange,
        // Habitability's shades, the best band first.
        bands: [blue, blend(blue, surface, 0.55), blend(blue, surface, 0.25)],
        stars: { hole: violet, giant: green, hot: blue, yellow: amber, orange, red, white: blend(blue, '#ffffff', 0.35), brown: blend(orange, '#000000', 0.6) },
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
        danger: system.DangerRating || 0,
        stars: system.Stars || 0,
        starGroup: starGroup(system.SpectralClass, system.SizeText),
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
    // side, stabilised at either end; and per system, the charted jump points still unexplored.
    links() {
      // Read the computed inputs once: every this.rowById read inside the loops collects its dependencies again.
      const { jumpPoints, rowById } = this
      const byId = Object.fromEntries(jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
      const links = new Map()
      const unexplored = {}

      jumpPoints.forEach((jumpPoint) => {
        const from = String(jumpPoint.SystemID)
        const partner = byId[jumpPoint.WPLink]

        if (!partner || !(jumpPoint.Explored || partner.Explored)) {
          unexplored[from] = (unexplored[from] || 0) + 1

          return
        }

        const to = String(partner.SystemID)

        if (from === to || !rowById[from] || !rowById[to]) {
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
        const a = rowById[link.source].galactic
        const b = rowById[link.target].galactic

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
      return this.capitalId ? hopsFrom(this.capitalId, this.neighbours) : {}
    },

    // Where Jumps and Travel measure from: the one system selected, else the capital.
    distanceOrigin() {
      return this.panelSystem ? this.panelSystem.id : this.capitalId
    },

    originHops() {
      const { distanceOrigin } = this

      if (!distanceOrigin) {
        return {}
      }

      return distanceOrigin === this.capitalId ? this.hops : hopsFrom(distanceOrigin, this.neighbours)
    },

    farthestHop() {
      return Math.max(1, ...Object.values(this.originHops))
    },

    // Kilometres from the origin's star to each system's on the shortest explored route, as the game's
    // galactic map measures distance.
    originKm() {
      const { distanceOrigin } = this
      const km = {}

      if (!distanceOrigin) {
        return km
      }

      const distanceTo = buildDistanceMap(this.jumpPoints, [{ SystemID: Number(distanceOrigin), Xcor: 0, Ycor: 0 }])

      this.systemRows.forEach((row) => {
        const found = distanceTo({ SystemID: row.SystemID, Xcor: 0, Ycor: 0 })

        if (found) {
          km[row.id] = found.km
        }
      })

      return km
    },

    farthestKm() {
      return Math.max(1, ...Object.values(this.originKm))
    },

    // Colony costs are worked out only while the map shows them: every body of a large galaxy takes a while.
    needsHabitability() {
      return this.layer === 'habitability' || this.marksSet.has('habitable')
    },

    // The race's habitability once it has loaded: until then the plugin keeps the last race's.
    currentHabitability() {
      const { habitability } = this

      return habitability && habitability.key === `${this.GameID}:${this.RaceID}` ? habitability : null
    },

    // What stands in for habitability while there is none to show, or null when there is.
    habitabilityNote() {
      if (!this.needsHabitability) {
        return null
      }

      if (this.loadErrors.habitability) {
        return 'Colony costs couldn\'t be worked out'
      }

      if (!this.currentHabitability) {
        return 'Working out colony costs…'
      }

      return this.currentHabitability.species ? null : 'No species of yours to work out colony costs for'
    },

    // Each system's count of bodies per band of COLONY_COST_BANDS, for systems with any.
    habitableBands() {
      return this.currentHabitability ? this.currentHabitability.systems : {}
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

    // The parts of the map joined by jumps stabilised at both ends, each with at least one link. Sorted
    // by size and lowest system ID so a network's name and colour don't depend on the order the save
    // returned its systems or jump points.
    stabilisedNetworks() {
      const owner = {}
      const { categorical } = this.theme
      const parts = groupBorders(this.systemRows, this.links.list.filter((link) => link.gate === 'both'), () => owner).filter((part) => part.links.length)

      parts.forEach((part) => part.ids.sort((a, b) => Number(a) - Number(b)))
      parts.sort((a, b) => b.ids.length - a.ids.length || Number(a.ids[0]) - Number(b.ids[0]))
      parts.forEach((part, index) => {
        part.owner = { id: part.ids[0], name: `Stabilised network ${index + 1}`, color: categorical[index % categorical.length] }
      })

      return parts
    },

    stabilisedNetworkById() {
      return Object.fromEntries(this.stabilisedNetworks.flatMap((part) => part.ids.map((id) => [id, part.owner.id])))
    },

    // The groups the borders go round, in the legend's order (each `{ name, color }`, with `legend`
    // where the legend says more than the name, and no `name` where the shapes go unnamed).
    // Stabilised networks provide their parts too, so unstabilised shortcuts aren't drawn inside their borders.
    borderGroups() {
      if (this.borders === 'stabilised') {
        const parts = this.stabilisedNetworks

        return { owners: parts.map((part) => part.owner), parts }
      }

      if (this.borders === 'sectors') {
        return { owners: this.sectors.map((sector) => this.sectorById[sector.SectorCommandID]), ownerOf: (row) => this.sectorById[row.SectorID] }
      }

      if (this.borders === 'control') {
        return { owners: this.controllers, ownerOf: (row) => this.controllerById[row.ControlRaceID] }
      }

      if (this.borders === 'groups') {
        return { owners: this.groupOwners, ownerOf: (row) => this.groupOwners[this.groupOf[row.id]] }
      }

      if (this.borders === 'colonies') {
        const owner = { name: null, legend: 'Systems with your colonies', color: this.colors.colony }

        return { owners: [owner], ownerOf: (row) => (row.colonies ? owner : null) }
      }

      if (this.borders === 'danger') {
        const owner = { name: 'Danger', legend: 'Systems with a danger rating', color: this.colors.danger }

        return { owners: [owner], ownerOf: (row) => (row.danger > 0 ? owner : null) }
      }

      return { owners: [], ownerOf: () => null }
    },

    // The shapes the borders draw: each group's systems, split where its own links don't join them.
    borderParts() {
      if (this.borders === 'none') {
        return []
      }

      return this.borderGroups.parts || groupBorders(this.systemRows, this.links.list, this.borderGroups.ownerOf)
    },

    // The legend's entries for the borders: each group with a shape on the map, and its systems.
    borderLegend() {
      const systems = new Map()

      this.borderParts.forEach((part) => systems.set(part.owner, (systems.get(part.owner) || 0) + part.ids.length))

      return this.borderGroups.owners.filter((owner) => systems.has(owner)).map((owner) => ({ owner, systems: systems.get(owner) }))
    },

    pinnedSet() {
      return new Set(this.pinned)
    },

    pinnedCount() {
      return this.pinned.filter((id) => this.rowById[id]).length
    },

    marksSet() {
      return new Set(this.marks)
    },

    marksLabel() {
      const chosen = MARKS.filter((mark) => this.marksSet.has(mark.value))

      if (chosen.length === 1) {
        return chosen[0].text
      }

      const label = chosen.map((mark) => mark.short).join(', ')

      return label.charAt(0).toUpperCase() + label.slice(1)
    },

    // Each mark's disc in the tracker.
    markDiscs() {
      return Object.fromEntries(MARKS.map((mark) => [mark.value, { path: mark.path, offset: mark.offset, ...(mark.color ? { color: this.colors[mark.color] } : { color: this.colors.ink, hollow: true }) }]))
    },

    trackedMarks() {
      return MARKS.filter((mark) => this.marksSet.has(mark.value)).map((mark) => ({ value: mark.value, disc: this.markDiscs[mark.value] }))
    },

    trackerLabel() {
      return this.trackedMarks.length ? `Show on the map: ${this.marksLabel}` : 'Show on the map'
    },

    // How each glyph looks, by what it marks: filled, or hollow for the lesser state. The habitable
    // worlds' badge carries their count, which `text` gives an example of for the legend.
    glyphStyles() {
      const { colors } = this
      const species = this.currentHabitability && this.currentHabitability.species

      return {
        habitable: { path: EARTH_PATH, text: '2', color: colors.colony, label: `Habitable worlds there, colony cost under ${COLONY_COST_BANDS[0]}${species ? ` for the ${species}` : ''}` },
        'ruins-identified': { path: PILLAR_PATH, color: colors.ruins, label: 'Ruins, their builders identified' },
        'ruins-found': { path: PILLAR_PATH, color: colors.ruins, hollow: true, label: 'Ruins, builders unknown' },
        'ruins-used': { path: PILLAR_PATH, color: colors.ring, hollow: true, label: 'Ruins with nothing left to recover' },
        'constructs-active': { path: PYRAMID_PATH, color: colors.construct, label: 'Active ancient construct' },
        'constructs-dormant': { path: PYRAMID_PATH, color: colors.construct, hollow: true, label: 'Dormant ancient construct' },
        rifts: { path: HURRICANE_PATH, color: colors.rift, label: 'Aether rift' },
      }
    },

    // The first and last time the race found a system after the game began, in seconds of game time.
    discoveryRange() {
      const times = this.systemRows.map((row) => row.DiscoveredTime).filter((time) => time > 0)

      return times.length ? { first: Math.min(...times), last: Math.max(...times) } : null
    },

    // The legend's entries for Show: each glyph, mark or line it draws, with how many systems have it.
    marksLegend() {
      const items = []
      const counts = {}

      this.systemRows.forEach((row) => this.glyphsOf(row).forEach((glyph) => {
        counts[glyph.name] = (counts[glyph.name] || 0) + 1
      }))

      MARKS.filter((mark) => this.marksSet.has(mark.value)).forEach((mark) => {
        if (mark.value === 'habitable' && this.habitabilityNote) {
          items.push({ kind: 'note', label: `${mark.text}: ${this.habitabilityNote.charAt(0).toLowerCase()}${this.habitabilityNote.slice(1)}` })
        } else if (mark.place === 'glyph') {
          const names = Object.keys(this.glyphStyles).filter((name) => name === mark.value || name.startsWith(`${mark.value}-`))
          const shown = names.filter((name) => counts[name])

          shown.forEach((name) => items.push({ kind: 'glyph', ...this.glyphStyles[name], label: `${this.glyphStyles[name].label} (${counts[name]})` }))

          if (!shown.length) {
            items.push({ kind: 'note', label: `${mark.text}: none known` })
          }
        } else {
          const systems = this.systemRows.filter((row) => this.markText(mark.value, row)).length
          const sample = { wrecks: '✕2', danger: '40 / 25', discovered: 'Date' }[mark.value]
          const label = { wrecks: 'Wrecks there, after the name', danger: 'Danger rating / your protection there, ⚠ when it falls short', discovered: 'Date found, for systems found after the game began' }[mark.value]

          items.push(systems ? { kind: 'sample', sample, label: `${label} (${systems})` } : { kind: 'note', label: `${mark.text}: none known` })
        }
      })

      return items
    },

    // The group index of each system in one of the player's groups.
    groupOf() {
      const groupOf = {}

      this.groups.forEach((group, index) => group.forEach((id) => {
        groupOf[id] = index
      }))

      return groupOf
    },

    // A colour and a name for each of the player's groups, by its index in `groups`.
    groupOwners() {
      const { categorical } = this.theme

      return this.groups.map((group, index) => {
        const names = group.map((id) => (this.rowById[id] || {}).Name).filter(Boolean)

        return {
          name: `Group ${index + 1}`,
          legend: names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '),
          title: names.join(', '),
          color: categorical[index % categorical.length],
        }
      })
    },

    groupList() {
      return this.groupOwners.map((owner, index) => ({ index, name: owner.name, label: owner.legend, title: owner.title, color: owner.color })).filter((group) => group.label)
    },

    keepTogetherLabel() {
      const chosen = KEEP_TOGETHER.filter((option) => this.arrange.keepTogether.includes(option.value))

      if (chosen.length === 1) {
        return chosen[0].text
      }

      const label = chosen.map((option) => option.short).join(', ')

      return label.charAt(0).toUpperCase() + label.slice(1)
    },

    // What Arrange keeps together for each system: its own group first, else the setting.
    keepTogetherKeys() {
      const keys = {}

      this.systemRows.forEach((row) => {
        if (this.groupOf[row.id] !== undefined) {
          keys[row.id] = `group-${this.groupOf[row.id]}`
        } else {
          // Several choices keep together the systems that share every selected group.
          const by = []

          if (this.arrange.keepTogether.includes('sectors') && row.SectorID) {
            by.push(`sector-${row.SectorID}`)
          }

          if (this.arrange.keepTogether.includes('control') && this.alienControl(row)) {
            by.push(`control-${row.ControlRaceID}`)
          }

          if (this.arrange.keepTogether.includes('stabilised') && this.stabilisedNetworkById[row.id]) {
            by.push(`stabilised-${this.stabilisedNetworkById[row.id]}`)
          }

          if (by.length) {
            keys[row.id] = by.join(' ')
          }
        }
      })

      return keys
    },

    // The systems with more jump points charted than NEXUS_JUMP_POINTS, explored or not.
    nexusIds() {
      const counts = {}

      this.jumpPoints.forEach((jumpPoint) => {
        const id = String(jumpPoint.SystemID)
        counts[id] = (counts[id] || 0) + 1
      })

      return new Set(Object.keys(counts).filter((id) => counts[id] > NEXUS_JUMP_POINTS && this.rowById[id]))
    },

    nexusHint() {
      const count = this.nexusIds.size

      if (!count) {
        return `No system has more than ${NEXUS_JUMP_POINTS} jump points.`
      }

      return `${count} ${count === 1 ? 'system has' : 'systems have'} more than ${NEXUS_JUMP_POINTS} jump points. Each sits in the middle of its links, which fan out round it at any angle, with more room the more links it has.`
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
        facts.push({ label: 'Kept with', value: `${this.groupOwners[group].name}: ${this.groups[group].filter((id) => id !== system.id && this.rowById[id]).map((id) => this.rowById[id].Name).join(', ')}` })
      }

      return facts
    },

    panelNeighbours() {
      return (this.neighbours[this.panelSystem.id] || []).map((id) => this.rowById[id]).sort((a, b) => a.Name.localeCompare(b.Name))
    },

    legend() {
      const { colors } = this
      const items = []
      // Borders round the groups the layer colours by: those entries show the border's swatch too.
      const merged = this.borders === this.layer && (this.layer === 'sectors' || this.layer === 'control' || this.layer === 'groups')
      const shaped = new Set(this.borderLegend.map((entry) => entry.owner))
      const group = (owner, label) => (merged && shaped.has(owner) ? { kind: 'area', dot: true, color: owner.color, tint: rgba(owner.color, TINT), label } : { kind: 'dot', color: owner.color, label })

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
          { kind: 'dot', color: colors.colony, label: `Population (full at ${COLONY_FULL_MILLIONS} M)` },
          { kind: 'dot', color: colors.outpost, label: 'Zero people / unfilled' },
          { kind: 'dot', color: colors.none, label: 'No colony' }
        )
      } else if (this.layer === 'sectors') {
        this.sectors.forEach((sector) => items.push(group(this.sectorById[sector.SectorCommandID], sector.SectorName)))
        items.push({ kind: 'dot', color: colors.none, label: 'In no sector' })
      } else if (this.layer === 'control') {
        this.controllers.forEach((controller) => items.push(group(controller, `${controller.name} (${controller.systems})`)))
        items.push({ kind: 'dot', color: colors.none, label: 'Held by no alien race' })
      } else if (this.layer === 'groups') {
        this.groupOwners.filter((owner) => owner.legend).forEach((owner) => items.push(group(owner, `${owner.name}: ${owner.legend}`)))
        items.push({ kind: 'dot', color: colors.none, label: 'In no group' })
      } else if (this.layer === 'discovery') {
        const range = this.discoveryRange
        const year = (time) => gameTime(this.StartYear, time).format('YYYY')

        items.push({ kind: 'ring', color: colors.ink, label: 'Capital' }, { kind: 'dot', color: this.discoveryColor(0), label: 'Known from the start' })

        if (range) {
          items.push({ kind: 'dot', color: this.discoveryColor(range.first), label: `Found first (${year(range.first)})` }, { kind: 'dot', color: this.discoveryColor(range.last), label: `Found last (${year(range.last)})` })
        }
      } else if (this.layer === 'habitability') {
        if (this.habitabilityNote) {
          items.push({ kind: 'note', label: this.habitabilityNote })
        } else {
          const best = this.systemRows.map((row) => this.bestBand(row))
          const systems = (band) => best.filter((value) => value === band).length
          const last = COLONY_COST_BANDS[COLONY_COST_BANDS.length - 1]

          items.push(
            ...COLONY_COST_BANDS.map((limit, band) => ({ kind: 'dot', color: colors.bands[band], label: `${band ? 'Best' : 'A habitable world,'} colony cost under ${limit} (${systems(band)})` })),
            { kind: 'dot', color: colors.none, label: `None under ${last} (${systems(-1)})` },
            { kind: 'note', label: `The ${this.currentHabitability.species}'s colony costs now, before colonisation tech, as the game counts habitable worlds` }
          )
        }
      } else if (this.layer === 'stars') {
        const systems = {}
        const multiple = this.systemRows.filter((row) => row.stars > 1).length

        this.systemRows.forEach((row) => {
          systems[row.starGroup] = (systems[row.starGroup] || 0) + 1
        })
        STAR_GROUPS.filter((group) => systems[group.value]).forEach((group) => items.push({ kind: 'dot', color: colors.stars[group.value], label: `${group.text} (${systems[group.value]})` }))

        if (multiple) {
          items.push({ kind: 'ring', color: colors.ring, style: 'double', width: 4, label: `Two or more stars (${multiple})` })
        }
      } else {
        const origin = this.rowById[this.distanceOrigin]
        const far = this.layer === 'travel' ? `${this.count(this.farthestKm / 1e9, 1)} billion km` : `${this.farthestHop} ${this.farthestHop === 1 ? 'jump' : 'jumps'}`

        items.push(
          { kind: 'ring', color: colors.ink, label: origin ? `From ${origin.Name}${origin.id === this.capitalId ? ', the capital' : ''}` : 'From the capital' },
          { kind: 'dot', color: colors.colony, label: 'Near' },
          { kind: 'dot', color: blend(colors.colony, colors.surface, 0.25), label: `Far (${far})` },
          { kind: 'dot', color: colors.none, label: 'No explored route' },
          { kind: 'note', label: this.panelSystem ? 'Clear the selection to measure from the capital' : 'Select a system to measure from it' }
        )
      }

      if (this.links.list.some((link) => link.gate === 'both')) {
        items.push({ kind: 'line', color: colors.gate, label: 'Stabilised at both ends' })
      }

      if (this.links.list.some((link) => link.gate === 'source' || link.gate === 'target')) {
        items.push({ kind: 'line', color: colors.gate, dashed: true, label: 'Stabilised at one end (arrow: the way it lets ships through)' })
      }

      if (this.pinnedCount) {
        items.push({ kind: 'icon', icon: 'mdi-lock', label: 'Pinned' })
      }

      if (this.borders !== 'none' && !merged) {
        if (this.borderLegend.length) {
          items.push({ kind: 'heading', label: 'Borders:' })
          this.borderLegend.forEach(({ owner, systems }) => items.push({ kind: 'area', color: owner.color, tint: rgba(owner.color, TINT), label: `${owner.legend || owner.name} (${systems})` }))
        } else {
          items.push({ kind: 'heading', label: `Borders: ${BORDER_OPTIONS.find((option) => option.value === this.borders).empty}` })
        }
      }

      return items
    },

    legendRows() {
      const layer = []
      const borders = []

      this.legend.forEach((item) => {
        (item.kind === 'area' || item.kind === 'heading' ? borders : layer).push(item)
      })

      if (borders.length && borders[0].kind !== 'heading') {
        borders.unshift({ kind: 'heading', label: 'Borders:' })
      }

      const marks = this.marksLegend.length ? [{ kind: 'heading', label: 'Show:' }, ...this.marksLegend] : []

      return [layer, borders, marks].filter((row) => row.length)
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

    lockLabel() {
      return this.locked ? 'Unlock the map, so systems can be dragged' : 'Lock the map: dragging a system then moves the view, not the system'
    },
  },
  watch: {
    // The map's settings are kept per game and race; another race starts a fresh map.
    RaceID: {
      immediate: true,
      handler() {
        const setting = (key, fallback) => this.config.get(`${this.settingsPrefix}.${key}`, fallback)

        this.keepMap()
        this.layer = setting('mapLayer', 'geological')
        // A saved choice the map no longer offers falls back to none.
        const borders = setting('mapBorders', 'none')

        this.borders = BORDER_OPTIONS.some((option) => option.value === borders) ? borders : 'none'
        this.linkLength = setting('mapLinkLength', 'travel')
        const arrange = setting('mapArrange', {})

        // Keep together holds a list of what to keep together; an older single choice is dropped.
        this.arrange = { ...this.arrange, ...arrange, keepTogether: Array.isArray(arrange.keepTogether) ? arrange.keepTogether : [] }
        this.pinned = setting('mapPinned', [])
        this.locked = setting('mapLocked', false)
        this.groups = setting('mapGroups', [])
        // Marks the map no longer offers are dropped.
        const marks = setting('mapMarks', [])

        this.marks = Array.isArray(marks) ? marks.filter((value) => MARKS.some((mark) => mark.value === value)) : []
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

    // The borders and the overview draw outside cytoscape, which doesn't know when they change.
    borderParts() {
      this.labelPlaces = null
      this.paintBorders()

      if (this.minimap) {
        this.minimap.refresh()
      }
    },

    layer() {
      this.restyle()
    },

    pinned() {
      this.restyle()
    },

    groups() {
      if (this.layer === 'groups') {
        this.restyle()
      }
    },

    marks() {
      this.restyle()
    },

    features() {
      this.restyle()
    },

    habitableBands() {
      this.restyle()
    },

    // Selecting one system measures Jumps and Travel from it.
    distanceOrigin() {
      if (this.layer === 'jumps' || this.layer === 'travel') {
        this.restyle()
      }
    },

    // A locked map's systems can't be grabbed; pressing on one pans the view as the background does.
    locked(value) {
      if (this.graph) {
        this.graph.autoungrabify(value)
        this.graph.nodes()[value ? 'panify' : 'unpanify']()
      }
    },

    '$vuetify.theme.dark'() {
      if (this.graph) {
        this.graph.style(this.stylesheet())
        this.createMenu()
        this.restyle()
      }
    },
  },
  // The map's own state (its places, view and selection) is set by `resetGraph`, which the RaceID
  // watcher has run by now.
  created() {
    this.graph = null
    this.menu = null
    this.minimap = null
    this.layoutInstance = null
    this.run = null
    this.syncQueued = false
    this.syncPending = false
    this.selectionQueued = false
    this.resizeObserver = null
    // Where the borders' names go, worked out again when the systems or the borders change.
    this.labelPlaces = null
    this.ringScale = 1
    this.zoomedByHand = false
    this.zoomStyleTimer = null
    this.settleTimer = null
    this.settling = false
    // `?system=<SystemID>` opens the map on that system.
    this.pendingFocus = this.$route.query.system ? String(this.$route.query.system) : null
  },
  beforeDestroy() {
    this.keepMap()
    this.run = null
    clearTimeout(this.zoomStyleTimer)
    clearTimeout(this.settleTimer)

    if (this.layoutInstance) {
      this.layoutInstance.stop()
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }

    if (this.minimap) {
      this.minimap.destroy()
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

    toggleMark(value) {
      this.marks = this.marksSet.has(value) ? this.marks.filter((mark) => mark !== value) : [...this.marks, value]
      this.setSetting('mapMarks', this.marks)
    },

    saveArrange() {
      this.setSetting('mapArrange', { ...this.arrange })
    },

    toggleLock() {
      this.locked = !this.locked
      this.setSetting('mapLocked', this.locked)
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
      const stabilised = this.links.list.filter((link) => (link.source === row.id && link.gateSource) || (link.target === row.id && link.gateTarget)).length
      const parts = [`${linked} explored`]

      if (unexplored) {
        parts.push(`${unexplored} unexplored`)
      }

      if (stabilised) {
        parts.push(`${stabilised} stabilised`)
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
            'pie-1-background-color': 'data(pieDoneColor)',
            'pie-1-background-size': (node) => `${node.data('pieDone') || 0}%`,
            'pie-2-background-color': 'data(pieLeftColor)',
            'pie-2-background-size': (node) => `${node.data('pieLeft') || 0}%`,
            'background-image': 'data(image)',
            // A marker with glyphs has a larger image, centred on it, with room for them round the rim.
            'background-width': (node) => `${100 * node.data('imageScale')}%`,
            'background-height': (node) => `${100 * node.data('imageScale')}%`,
            'background-clip': 'none',
            'background-image-containment': 'over',
            'bounds-expansion': (node) => Math.max(8, Math.ceil((node.data('size') * (node.data('imageScale') - 1)) / 2)),
            label: 'data(label)',
            'text-wrap': 'wrap',
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
        // Rings follow the zoom; `setZoomStyle` restyles them.
        {
          selector: 'node[borderStyle = "dotted"]',
          style: {
            'border-style': 'dashed',
            'border-cap': 'round',
            'border-width': (node) => node.data('borderWidth') * this.ringScale,
            'border-dash-pattern': (node) => ringPattern(node.data('size'), this.ringScale, RING_DOTS),
          },
        },
        {
          selector: 'node[borderStyle = "dashed"]',
          style: {
            'border-width': (node) => node.data('borderWidth') * this.ringScale,
            'border-dash-pattern': (node) => ringPattern(node.data('size'), this.ringScale, RING_DASHES),
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
            'arrow-scale': 1.6,
          },
        },
        {
          selector: 'edge[gate = "target"]',
          style: {
            'line-color': colors.gate,
            'line-style': 'dashed',
            'source-arrow-shape': 'triangle',
            'source-arrow-color': colors.gate,
            'arrow-scale': 1.6,
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

    // A system's fill, border, pie and overlay for the layer shown.
    markerData(row) {
      const { colors } = this
      let marker = { fill: colors.none, border: colors.ring, borderWidth: 2, borderStyle: 'solid', pieDone: 0, pieLeft: 0, pieDoneColor: colors.done, pieLeftColor: colors.left, spots: 0, spotColor: null }

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
        const share = row.colonies ? Math.min(100, (100 * Math.max(0, row.population)) / COLONY_FULL_MILLIONS) : 0

        marker = {
          ...marker,
          fill: row.colonies ? colors.outpost : colors.none,
          border: row.capital ? colors.ink : row.colonies ? colors.colony : colors.ring,
          borderWidth: row.capital ? 4 : 2,
          pieDone: share,
          pieLeft: row.colonies ? 100 - share : 0,
        }
      } else if (this.layer === 'sectors') {
        marker.fill = (this.sectorById[row.SectorID] || {}).color || colors.none
      } else if (this.layer === 'control') {
        marker.fill = row.ControlRaceID === this.RaceID ? colors.primary : (this.controllerById[row.ControlRaceID] || {}).color || colors.none
      } else if (this.layer === 'groups') {
        marker.fill = (this.groupOwners[this.groupOf[row.id]] || {}).color || colors.none
      } else if (this.layer === 'discovery') {
        marker = {
          ...marker,
          fill: this.discoveryColor(row.DiscoveredTime),
          border: row.capital ? colors.ink : colors.ring,
          borderWidth: row.capital ? 4 : 2,
        }
      } else if (this.layer === 'habitability') {
        const band = this.bestBand(row)

        marker.fill = band < 0 ? colors.none : colors.bands[band]
      } else if (this.layer === 'stars') {
        marker = {
          ...marker,
          fill: colors.stars[row.starGroup] || colors.none,
          ...(row.stars > 1 ? { borderStyle: 'double', borderWidth: 6 } : {}),
        }
      } else {
        const travel = this.layer === 'travel'
        const distance = travel ? this.originKm[row.id] : this.originHops[row.id]
        const origin = row.id === this.distanceOrigin

        marker = {
          ...marker,
          fill: distance === undefined ? colors.none : blend(colors.colony, colors.surface, 1 - (0.75 * distance) / (travel ? this.farthestKm : this.farthestHop)),
          border: origin ? colors.ink : colors.ring,
          borderWidth: origin ? 4 : 2,
        }
      }

      const { spots, spotColor, ...data } = marker
      const glyphs = this.glyphsOf(row)

      return {
        ...data,
        label: this.labelOf(row),
        imageScale: glyphs.length ? (row.size + 2 * MARK_ROOM) / row.size : 1,
        image: markerImage(row.size, spots, spotColor, this.pinnedSet.has(row.id), glyphs, colors.surface),
      }
    },

    // The fill for a system found at `time`: palest for those known from the start, then from the
    // first found after it to the last, the strongest.
    discoveryColor(time) {
      const range = this.discoveryRange

      if (!(time > 0) || !range) {
        return blend(this.colors.discovery, this.colors.surface, 0.15)
      }

      const share = range.last > range.first ? (time - range.first) / (range.last - range.first) : 1

      return blend(this.colors.discovery, this.colors.surface, 0.35 + 0.65 * share)
    },

    // The best colony cost band a system has a body in, as an index of COLONY_COST_BANDS, or -1.
    bestBand(row) {
      const counts = this.habitableBands[row.id]

      return counts ? counts.findIndex(Boolean) : -1
    },

    // The glyphs Show puts round a system's marker, in the order they take their places: each
    // `{ name, key, path, color, hollow }`, with `name` the glyph's entry in `glyphStyles`; the
    // habitable worlds' badge has their count as `text`, at its own `angle`.
    glyphsOf(row) {
      const features = this.features[row.id] || NO_FEATURES
      const marks = this.marksSet
      const names = []

      if (marks.has('ruins') && features.ruins.length) {
        const states = new Set(features.ruins.map(ruinState))

        names.push(`ruins-${['identified', 'found', 'used'].find((state) => states.has(state))}`)
      }

      if (marks.has('constructs') && features.constructs.length) {
        names.push(features.constructs.some((construct) => construct.active) ? 'constructs-active' : 'constructs-dormant')
      }

      if (marks.has('rifts') && features.rifts) {
        names.push('rifts')
      }

      const glyphs = names.map((name) => {
        const style = this.glyphStyles[name]

        return { name, key: `${name}:${style.color}`, path: style.path, color: style.color, hollow: Boolean(style.hollow) }
      })
      const habitable = marks.has('habitable') && this.habitableBands[row.id] ? this.habitableBands[row.id][0] : 0

      if (habitable) {
        const { color } = this.glyphStyles.habitable

        glyphs.push({ name: 'habitable', key: `habitable:${color}:${habitable}`, text: String(habitable), angle: BADGE_ANGLE, color, hollow: false })
      }

      return glyphs
    },

    // What a mark placed by the name says for a system, or '' where it has nothing to say.
    markText(mark, row) {
      const features = this.features[row.id] || NO_FEATURES

      if (mark === 'wrecks') {
        return features.wrecks ? `✕${features.wrecks}` : ''
      }

      if (mark === 'danger') {
        // The game reds its danger line where the warships there protect less than the danger.
        const protection = Math.round(features.protection)

        return row.danger > 0 ? `${protection < row.danger ? '⚠ ' : ''}${this.count(row.danger)} / ${this.count(protection)}` : ''
      }

      if (mark === 'discovered') {
        return row.DiscoveredTime > 0 ? gameTime(this.StartYear, row.DiscoveredTime).format('YYYY-MM-DD') : ''
      }

      return ''
    },

    // A system's name with what Show adds: its wrecks after it, and a line under it for each of
    // danger and the date it was found.
    labelOf(row) {
      const marks = MARKS.filter((mark) => mark.place !== 'glyph' && this.marksSet.has(mark.value))
      const after = marks.filter((mark) => mark.place === 'name').map((mark) => this.markText(mark.value, row)).filter(Boolean)
      const lines = marks.filter((mark) => mark.place === 'line').map((mark) => this.markText(mark.value, row)).filter(Boolean)

      return [[row.Name, ...after].join('  '), ...lines].join('\n')
    },

    createGraph() {
      const graph = cytoscape({
        container: this.$refs.canvas,
        style: this.stylesheet(),
        layout: { name: 'preset' },
        minZoom: 0.05,
        maxZoom: 4,
        autoungrabify: this.locked,
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
      graph.on('scrollzoom pinchzoom', () => {
        this.zoomedByHand = true
      })
      // Cytoscape tells of a wheel or pinch zoom just after the zoom itself.
      graph.on('zoom', () => queueMicrotask(() => this.zoomChanged()))
      // The borders' names are placed again once the systems settle, not on each frame of a drag or
      // of an animated layout: `dragfree` and `finishBusy` place them when those end.
      graph.on('add remove data dragfree', () => {
        this.labelPlaces = null
      })
      graph.on('position', 'node', (event) => {
        if (this.busy !== 'layout' && !event.target.grabbed()) {
          this.labelPlaces = null
        }
      })
      // The borders lie on a canvas under cytoscape's, drawn again after each frame it draws.
      graph.on('render', () => {
        this.paintBorders()
        this.settle()
      })

      this.graph = graph
      this.sizeBorders()
      this.minimap = createMinimap(graph, this.$refs.minimap, (context, scale) => this.paintMinimap(context, scale))
      this.createMenu()

      // The side panel opening narrows the map; cytoscape only notices the window resizing. A map
      // the user hasn't moved is fitted again, so a larger window isn't left with it in a corner.
      this.resizeObserver = new ResizeObserver(() => {
        this.sizeBorders()
        graph.resize()

        if (this.fitted && !this.busy) {
          graph.fit(undefined, 40)
        }

        this.paintBorders()
        this.minimap.refresh()
      })
      this.resizeObserver.observe(this.$refs.stage)
    },

    // A zoom by hand restyles the rings once it pauses, not at each step on the way: on a large
    // map each restyle takes the better part of a second. Any other zoom restyles them at once.
    zoomChanged() {
      clearTimeout(this.zoomStyleTimer)

      if (!this.zoomedByHand) {
        this.setZoomStyle(this.graph.zoom())
        return
      }

      this.zoomedByHand = false
      this.zoomStyleTimer = setTimeout(() => this.setZoomStyle(this.graph.zoom()), ZOOM_PAUSE_MS)
    },

    // One more frame once the map is quiet, for cytoscape to make its picture of the map (see
    // SETTLE_MS). That frame doesn't ask for another.
    settle() {
      clearTimeout(this.settleTimer)

      if (this.settling) {
        this.settling = false
        return
      }

      this.settleTimer = setTimeout(() => {
        this.settling = true
        this.graph.forceRender()
      }, SETTLE_MS)
    },

    // Zoomed out, the broken rings grow thicker and their gaps wider, in the steps of RING_SCALES.
    // Markers keep their size: growing them to stay visible means restyling every one at each step,
    // seconds of zooming on a large map.
    setZoomStyle(zoom) {
      const scale = ringScaleAt(zoom)

      if (scale !== this.ringScale) {
        this.ringScale = scale
        this.graph.nodes('[borderStyle != "solid"]').updateStyle()
      }
    },

    sizeBorders() {
      const canvas = this.$refs.borders
      const ratio = window.devicePixelRatio || 1

      canvas.width = Math.round(canvas.clientWidth * ratio)
      canvas.height = Math.round(canvas.clientHeight * ratio)
    },

    // Where the borders find a system: its place on the map now, or nothing before it is added, and
    // its marker's size.
    borderGeometry() {
      return {
        positionOf: (id) => {
          const node = this.graph.getElementById(id)

          return node.nonempty() ? node.position() : null
        },
        sizeOf: (id) => this.rowById[id].size,
      }
    },

    borderLabels() {
      if (!this.labelPlaces) {
        this.labelPlaces = placeLabels(this.$refs.borders.getContext('2d'), this.borderParts, {
          ...this.borderGeometry(),
          systems: this.systemRows.map((row) => row.id),
          links: this.links.list,
          nameOf: (id) => this.labelOf(this.rowById[id]),
        })
      }

      return this.labelPlaces
    },

    // Shift and the wheel zoom faster than cytoscape's own wheel zoom, round the pointer. This runs
    // before cytoscape sees the wheel, which it then doesn't.
    shiftWheel(event) {
      if (!event.shiftKey || !this.graph || !this.$refs.canvas.contains(event.target)) {
        return
      }

      const box = this.$refs.canvas.getBoundingClientRect()

      event.preventDefault()
      event.stopPropagation()
      this.fitted = false
      this.zoomedByHand = true
      this.graph.zoom({ level: this.graph.zoom() * wheelZoom(event), renderedPosition: { x: event.clientX - box.left, y: event.clientY - box.top } })
    },

    paintBorders() {
      const canvas = this.$refs.borders

      if (!this.graph || !canvas) {
        return
      }

      const context = canvas.getContext('2d')
      const ratio = window.devicePixelRatio || 1
      const zoom = this.graph.zoom()
      const pan = this.graph.pan()

      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.setTransform(ratio * zoom, 0, 0, ratio * zoom, ratio * pan.x, ratio * pan.y)
      drawBorders(context, this.borderParts, { ...this.borderGeometry(), zoom, ink: this.theme.ink, halo: this.theme.surface, places: showsLabels(zoom) ? this.borderLabels() : null })
    },

    // The overview: the borders, links and systems, without names. A system is a dot in the colour
    // it shows most: the larger share of its pie, else its fill.
    paintMinimap(context, scale) {
      const { colors } = this

      drawBorders(context, this.borderParts, { ...this.borderGeometry(), zoom: scale })
      context.lineWidth = 1 / scale
      context.strokeStyle = colors.link
      context.beginPath()
      this.graph.edges().forEach((edge) => {
        const a = edge.source().position()
        const b = edge.target().position()

        context.moveTo(a.x, a.y)
        context.lineTo(b.x, b.y)
      })
      context.stroke()
      this.graph.nodes().forEach((node) => {
        const { x, y } = node.position()
        const done = node.data('pieDone')
        const left = node.data('pieLeft')

        context.beginPath()
        context.arc(x, y, Math.max(node.data('size') / 2, 1.5 / scale), 0, 2 * Math.PI)
        context.fillStyle = done || left ? (done >= left ? colors.done : colors.left) : node.data('fill')
        context.fill()
      })
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
        selector: 'node',
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

    // Starts the map afresh for the game and race shown, as the player left it if they have been here.
    // The previous race's reads no longer count as loaded: every read depends on the race and runs
    // again, and until it settles `ready` keeps a sync from drawing the old rows in the new view.
    resetGraph() {
      this.loadErrors = {}

      if (this.graph) {
        this.graph.elements().remove()
      }

      this.mapKey = this.settingsPrefix
      this.kept = keptMaps.get(this.mapKey) || null
      this.syncedStart = null
      this.fitPending = true
      // The view shows the whole map and the user hasn't moved it since, so a resize fits it again.
      this.fitted = this.kept ? this.kept.fitted : true
      this.before = this.kept ? this.kept.before : null
      this.selectedIds = this.kept ? [...this.kept.selectedIds] : []
      this.movedIds = []
      this.quality = null
    },

    // Remembers the map as it is, for `resetGraph` to pick up when the player comes back to it.
    keepMap() {
      if (this.graph && this.syncedStart) {
        keptMaps.set(this.mapKey, {
          positions: this.graphPositions(),
          syncedStart: this.syncedStart,
          zoom: this.graph.zoom(),
          pan: { ...this.graph.pan() },
          fitted: this.fitted,
          selectedIds: [...this.selectedIds],
          before: this.before,
        })
      }
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
    // stays where it is; the rest go where the save now has them. Back on a map the player left,
    // the places they left it with stand in for the graph's.
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

      const kept = this.kept
      const current = kept ? kept.positions : this.graphPositions()
      const previous = (kept ? kept.syncedStart : this.syncedStart) || {}
      const positions = {}

      this.systemRows.forEach(({ id }) => {
        const now = current[id]
        const was = previous[id]

        positions[id] = now && was && !samePlace(now, was) ? now : this.startPositions[id]
      })

      this.syncedStart = this.startPositions
      this.buildElements(positions)

      this.kept = null

      if (this.fitPending) {
        this.fitPending = false

        if (kept && !kept.fitted) {
          this.graph.viewport({ zoom: kept.zoom, pan: kept.pan })
        } else {
          this.graph.fit(undefined, 40)
        }
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
          ...this.systemRows.map((row) => ({
            group: 'nodes',
            data: { id: row.id, size: row.size, ...this.markerData(row) },
            position: { ...positions[row.id] },
            locked: this.pinnedSet.has(row.id),
            selected: selected.has(row.id),
            pannable: this.locked,
          })),
          ...this.links.list.map((link) => ({
            group: 'edges',
            data: { id: link.id, source: link.source, target: link.target, gate: link.gate, travel: link.travel, galactic: link.galactic },
          })),
        ])
      })

      this.queueSelection()
    },

    restyle() {
      if (!this.graph) {
        return
      }

      this.graph.batch(() => {
        this.graph.nodes().forEach((node) => {
          const row = this.rowById[node.id()]

          if (row) {
            const data = this.markerData(row)
            const current = node.data()

            if (Object.keys(data).some((key) => current[key] !== data[key])) {
              node.data(data)
            }

            const pinned = this.pinnedSet.has(row.id)

            if (node.locked() !== pinned) {
              node[pinned ? 'lock' : 'unlock']()
            }
          }
        })
      })
    },

    graphPositions() {
      const positions = {}

      if (this.graph) {
        this.graph.nodes().forEach((node) => {
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
        this.selectedIds = this.graph ? this.graph.nodes(':selected').map((node) => node.id()) : []
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
      this.labelPlaces = null
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
        nodes: this.systemRows.map((row) => ({ id: row.id, group: this.keepTogetherKeys[row.id] || null, pinned: this.pinnedSet.has(row.id), nexus: this.arrange.nexuses && this.nexusIds.has(row.id) })),
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

    // The whole map with its borders. Keep both canvases within a bounded size;
    // oversized canvases produce an empty data URL that Image.decode() rejects.
    async exportPng() {
      const graph = this.graph
      const requestedScale = 2 * (window.devicePixelRatio || 1)
      const geometry = this.borderGeometry()

      try {
        const image = new Image()
        let systems
        let places
        let x1
        let y1
        let width
        let height
        let scale

        // Export with the rings as zoom 1 draws them, and put the screen's back before the next frame.
        this.setZoomStyle(1)

        try {
          systems = graph.elements().boundingBox({ useCache: false })
          places = this.borderLabels()
          const borders = bordersBox(this.borderParts, geometry, places) || systems

          x1 = Math.min(systems.x1, borders.x1) - 20
          y1 = Math.min(systems.y1, borders.y1) - 20
          width = Math.ceil(Math.max(systems.x2, borders.x2) + 20 - x1)
          height = Math.ceil(Math.max(systems.y2, borders.y2) + 20 - y1)
          scale = Math.min(requestedScale, 8192 / width, 8192 / height, Math.sqrt((32 * 1024 * 1024) / (width * height)))
          // max dimensions use output pixels, independently of display DPI. They
          // also keep the graph raster at the same scale as the border canvas.
          image.src = graph.png({ full: true, maxWidth: Math.ceil(systems.w) * scale, maxHeight: Math.ceil(systems.h) * scale })
        } finally {
          this.setZoomStyle(graph.zoom())
        }

        const canvas = document.createElement('canvas')

        canvas.width = Math.max(1, Math.floor(width * scale))
        canvas.height = Math.max(1, Math.floor(height * scale))
        const context = canvas.getContext('2d')

        await image.decode()
        context.setTransform(scale, 0, 0, scale, -x1 * scale, -y1 * scale)
        drawBorders(context, this.borderParts, { ...geometry, zoom: 1, ink: this.theme.ink, halo: this.theme.surface, places })
        context.setTransform(1, 0, 0, 1, 0, 0)
        // Border painting cuts out its interiors. Fill behind the finished layer so its tint
        // blends over the map's base colour, not transparency or the card surface.
        context.globalCompositeOperation = 'destination-over'
        context.fillStyle = window.getComputedStyle(this.$refs.stage).backgroundColor
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.globalCompositeOperation = 'source-over'
        context.drawImage(image, Math.round((systems.x1 - x1) * scale), Math.round((systems.y1 - y1) * scale))

        const result = await ipcRenderer.invoke('save-png', canvas.toDataURL('image/png').split(',')[1], `map-${this.GameID}-${this.RaceID}-${this.GameTime}.png`)

        if (!result?.canceled) {
          this.activateSnackbar({ color: 'success', text: `Map exported as PNG (${canvas.width} × ${canvas.height})` })
        }
      } catch (error) {
        this.activateSnackbar({ color: 'error', text: `Couldn't export the map: ${error.message}` })
      }
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

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.SectorID, FCT_RaceSysSurvey.ControlRaceID, FCT_RaceSysSurvey.DangerRating, FCT_RaceSysSurvey.DiscoveredTime, DIM_KnownSystems.X, DIM_KnownSystems.Y, DIM_KnownSystems.Z, Bodies.Bodies, Bodies.Planets, Bodies.Comets, Bodies.Surveyed as SurveyedBodies, Bodies.GroundSurveys, Locations.Locations, Locations.Surveyed as SurveyedLocations, Colonies.Colonies, Colonies.Population, Colonies.Capital, Stars.Stars, DIM_StellarType.SpectralClass, DIM_StellarType.SizeText from FCT_RaceSysSurvey left join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID left join DIM_KnownSystems on DIM_KnownSystems.KnownSystemID = FCT_System.SystemNumber left join (select FCT_SystemBody.SystemID, count(*) as Bodies, sum(FCT_SystemBody.BodyClass in (1, 2)) as Planets, sum(FCT_SystemBody.BodyClass = 5) as Comets, count(FCT_SystemBodySurveys.SystemBodyID) as Surveyed, sum(FCT_SystemBodySurveys.SystemBodyID is not null and FCT_SystemBody.GroundMineralSurvey > 0) as GroundSurveys from FCT_SystemBody inner join FCT_RaceSysSurvey as Known on Known.SystemID = FCT_SystemBody.SystemID and Known.RaceID = ${this.RaceID} and Known.GameID = ${this.GameID} left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} where FCT_SystemBody.GameID = ${this.GameID} group by FCT_SystemBody.SystemID) as Bodies on Bodies.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_SurveyLocation.SystemID, count(*) as Locations, count(FCT_RaceSurveyLocation.SystemID) as Surveyed from FCT_SurveyLocation inner join FCT_RaceSysSurvey as Known on Known.SystemID = FCT_SurveyLocation.SystemID and Known.RaceID = ${this.RaceID} and Known.GameID = ${this.GameID} left join FCT_RaceSurveyLocation on FCT_RaceSurveyLocation.SystemID = FCT_SurveyLocation.SystemID and FCT_RaceSurveyLocation.LocationNumber = FCT_SurveyLocation.LocationNumber and FCT_RaceSurveyLocation.RaceID = ${this.RaceID} where FCT_SurveyLocation.GameID = ${this.GameID} group by FCT_SurveyLocation.SystemID) as Locations on Locations.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_Population.SystemID, count(*) as Colonies, sum(FCT_Population.Population) as Population, max(FCT_Population.Capital) as Capital from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemID) as Colonies on Colonies.SystemID = FCT_RaceSysSurvey.SystemID left join (select FCT_Star.SystemID, count(*) as Stars, max(case when FCT_Star.Component = 1 then FCT_Star.StarTypeID end) as PrimaryType from FCT_Star where FCT_Star.GameID = ${this.GameID} group by FCT_Star.SystemID) as Stars on Stars.SystemID = FCT_RaceSysSurvey.SystemID left join DIM_StellarType on DIM_StellarType.StellarTypeID = Stars.PrimaryType where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([rows]) => Object.freeze(rows))
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
    features: {
      get: tracked('features', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadMapFeatures(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },
    // Loaded the first time the map shows habitability for the race, and kept for it after.
    habitability: {
      get: tracked('habitability', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        const key = `${this.GameID}:${this.RaceID}`

        if (this.habitabilityKept && this.habitabilityKept.key === key) {
          return this.habitabilityKept
        }

        if (!this.needsHabitability) {
          return null
        }

        const habitability = await loadHabitability(this.database, { GameID: this.GameID, RaceID: this.RaceID })

        this.habitabilityKept = Object.freeze({ key, ...habitability })

        return this.habitabilityKept
      }),
      default: null,
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

  .tool--borders {
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
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 16px 12px;
    border-top: 1px solid var(--ae-border);
  }

  .panel-foot__text {
    flex: 1 1 auto;
    min-width: 0;
  }

  // The tracker: the binoculars, then a disc for each mark that is on.
  .map-tracker {
    flex: none;
    padding: 0 8px !important;

    .v-btn__content {
      gap: 4px;
    }
  }

  .legend {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 4px;
    font-size: 12px;
  }

  .legend-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
  }

  .legend-item--heading {
    font-weight: 500;
  }

  // A border's swatch: its line and tint, with the layer's dot inside where both show one group.
  .area {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 18px;
    height: 14px;
    border: 2px solid;
    border-radius: 6px;
    margin-right: 6px;

    .dot {
      width: 6px;
      height: 6px;
      margin: 0;
    }
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

  .legend-item > .map-glyph {
    margin-right: 6px;
  }

  // What a mark by the name reads, as the map's labels show it.
  .sample {
    padding: 0 4px;
    margin-right: 6px;
    border: 1px solid var(--ae-border);
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
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

  .map-borders {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
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

  .map-minimap {
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
    cursor: pointer;
    touch-action: none;

    > canvas {
      position: absolute;
      top: 0;
      left: 0;
    }
  }

  .map-minimap__frame {
    position: absolute;
    box-sizing: border-box;
    pointer-events: none;
    background: var(--ae-hover);
    border: 2px solid var(--ae-primary);
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
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

// The tracker's menu: a short row per mark under its heading.
.tracker-menu {
  .v-subheader {
    height: 28px;
  }

  .v-list-item {
    min-height: 32px;
  }
}
</style>
