<template>
  <div class="path-view">
    <v-row dense align="center" class="mb-2">
      <v-col cols="12" md="7" lg="6">
        <v-autocomplete :value="targetId" :items="options" item-text="name" item-value="id" label="Technology" prepend-inner-icon="mdi-magnify" dense outlined hide-details auto-select-first :filter="filterOption" @change="(id) => id && $emit('select-tech', id)">
          <template #item="{ item }">
            <v-icon small class="mr-3" :color="colors[item.status]">{{ icons[item.status] }}</v-icon>
            <v-list-item-content>
              <v-list-item-title>{{ item.name }}</v-list-item-title>
              <v-list-item-subtitle>{{ item.field }} · {{ item.line }}</v-list-item-subtitle>
            </v-list-item-content>
          </template>
        </v-autocomplete>
      </v-col>
    </v-row>

    <v-card v-if="tech" class="panel" elevation="1">
      <div class="panel-body">
        <div class="d-flex align-center flex-wrap mb-1">
          <span class="text-h6 mr-3">{{ tech.name }}</span>
          <span class="status-chip mr-3"><v-icon small :color="colors[entry.status]">{{ icons[entry.status] }}</v-icon> {{ labels[entry.status] }}</span>
          <span class="caption text--secondary">{{ fieldName }} · {{ tech.typeName }}</span><page-link v-if="techViews[tech.typeId]" class="ml-1" :to="linkTo.shipyards({ view: techViews[tech.typeId] })" :name="tech.typeName" />
        </div>
        <div v-if="tech.description" class="description mb-3">{{ tech.description }}</div>
        <div v-if="entry.status === 'blocked'" class="text--secondary mb-3">{{ blockText }}</div>

        <v-row dense>
          <v-col v-for="fact in facts" :key="fact.label" cols="6" sm="3">
            <div class="caption text--secondary">{{ fact.label }}</div>
            <div class="fact-value">{{ fact.value }}<provenance-mark v-if="fact.result" :result="fact.result" /><provenance-mark v-else-if="fact.status" :status="fact.status" /></div>
            <div v-if="fact.note" class="caption text--secondary">{{ fact.note }}</div>
          </v-col>
        </v-row>
      </div>
    </v-card>

    <v-card v-if="tech" class="panel" data-summary="The chain of technologies leading to the selected one, coloured by status. Use it to see which the race already holds and which are still missing." elevation="1">
      <div class="panel-head">
        <span>Prerequisites</span>
        <span class="legend">
          <span v-for="item in legend" :key="item.status" class="legend-item"><span class="swatch" :class="item.status" />{{ item.label }}</span>
          <v-btn x-small outlined class="ml-2" @click="fit">Fit</v-btn>
        </span>
      </div>
      <div ref="graph" class="graph" role="img" :aria-label="`Prerequisites of ${tech.name}`" />
      <div class="panel-foot caption text--secondary">An arrow runs from a prerequisite to what it unlocks. The leftmost researched boxes are those the race already holds; click any box to look at that technology. Scroll to zoom, drag to move.</div>
    </v-card>

    <v-row v-if="tech">
      <v-col cols="12" md="6">
        <v-card class="panel" data-summary="The technologies the race still needs before this one, in an order that reaches it, with the research points each has left. Click one to open its own path." elevation="1">
          <div class="panel-head"><span>{{ order.length > 1 ? 'Research in this order' : 'Nothing else needed' }}</span></div>
          <div class="panel-body">
            <div v-if="entry.status === 'done'" class="empty">Already researched.</div>
            <div v-else-if="entry.status === 'blocked'" class="empty">Out of reach for this empire, so no order gets there.</div>
            <ol v-else class="steps">
              <li v-for="step in order" :key="step.id" class="step">
                <v-icon small :color="colors[step.status]">{{ icons[step.status] }}</v-icon>
                <a class="tech-link" @click="$emit('select-tech', step.id)">{{ step.name }}</a>
                <span class="caption text--secondary ml-auto text-no-wrap"><template v-if="step.remaining === null">—<provenance-mark :result="step.result" /></template><template v-else>{{ count(step.remaining) }} RP</template></span>
              </li>
            </ol>
          </div>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card class="panel" data-summary="The technologies that this one unlocks. Use it to see what researching it makes possible next." elevation="1">
          <div class="panel-head"><span>Opens</span></div>
          <div class="panel-body">
            <div v-if="!opens.length" class="empty">Nothing waits on this technology.</div>
            <ul v-else class="steps">
              <li v-for="step in opens" :key="step.id" class="step">
                <v-icon small :color="colors[step.status]">{{ icons[step.status] }}</v-icon>
                <a class="tech-link" @click="$emit('select-tech', step.id)">{{ step.name }}</a>
                <span class="caption text--secondary ml-auto text-no-wrap">{{ step.note }}</span>
              </li>
            </ul>
          </div>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script>
import cytoscape from 'cytoscape'

import countFormat from '../../mixins/count-format'
import { activeAppearance } from '../../utilities/appearance'
import { linkTo } from '../../utilities/deep-links'
import { isKnownNumber, UNKNOWN_TEXT } from '../../utilities/math'
import { ACTIVE, AVAILABLE, BLOCK_REASONS, BLOCKED, DONE, durationLabel, LOCKED, pathRpResult, prerequisiteChain, QUEUED, remainingResult, STATUS_LABELS } from '../../utilities/research'
import { SHIPYARD_TECH_VIEWS } from '../../utilities/shipyard-growth'
import { chartTheme, mapFont, withAlpha } from '../charts/theme'
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'

import { STATUS_ICONS, statusColors } from './status-style'

const COLUMN_WIDTH = 220
const ROW_HEIGHT = 58
const NODE_WIDTH = 190
const NODE_HEIGHT = 42

const truncate = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

export default {
  name: 'PathView',
  components: { PageLink, ProvenanceMark },
  mixins: [countFormat],
  props: {
    research: { type: Object, required: true },
    targetId: { type: Number, default: null },
  },
  data() {
    return {
      linkTo,
      techViews: SHIPYARD_TECH_VIEWS,
      icons: STATUS_ICONS,
      labels: STATUS_LABELS,
      legend: [DONE, ACTIVE, AVAILABLE, LOCKED, BLOCKED].map((status) => ({ status, label: STATUS_LABELS[status] })),
    }
  },
  computed: {
    // The appearance in force; the graph redraws on its key, so a switch between two dark presets redraws it too.
    appearance() {
      return activeAppearance()
    },

    colors() {
      return statusColors(this.appearance)
    },

    // The typeface and text size in force (utilities/appearance-font.js); the graph is drawn again when they change.
    typeface() {
      return mapFont()
    },

    tech() {
      return this.research.graph.techs.get(this.targetId) || null
    },

    entry() {
      return this.research.info.get(this.targetId)
    },

    fieldName() {
      const field = this.research.fields.find((candidate) => candidate.ResearchFieldID === this.tech.fieldId)

      return field ? field.FieldName : 'Hidden field'
    },

    options() {
      const { graph, info, shown } = this.research
      const names = new Map(this.research.fields.map((field) => [field.ResearchFieldID, field.FieldName]))

      return [...graph.techs.values()].filter((tech) => shown.has(tech.fieldId)).sort((a, b) => a.name.localeCompare(b.name)).map((tech) => ({ id: tech.id, name: tech.name, line: tech.typeName, field: names.get(tech.fieldId), status: info.get(tech.id).status }))
    },

    blockText() {
      return BLOCK_REASONS[this.entry.reason]
    },

    facts() {
      const { entry, tech } = this
      const { paused } = this.research.state
      const banked = paused.has(tech.id) ? paused.get(tech.id) : 0
      const costKnown = isKnownNumber(tech.cost)
      const cost = { label: 'Cost', value: costKnown ? `${this.count(tech.cost)} RP` : UNKNOWN_TEXT, ...(costKnown ? {} : { status: 'unavailable' }) }

      if (entry.status === DONE) {
        return [cost, { label: 'Opens', value: `${entry.unlocks}`, note: entry.unlocks === 1 ? 'technology not yet researched' : 'technologies not yet researched' }]
      } else if (entry.status === BLOCKED) {
        return [cost]
      }

      const facts = [{ label: entry.status === ACTIVE ? 'RP left on this project' : 'RP to research it', value: isKnownNumber(entry.remaining) ? `${this.count(entry.remaining)} RP` : UNKNOWN_TEXT, result: remainingResult(entry), note: banked > 0 ? `${this.count(banked)} banked of ${this.count(tech.cost)}` : entry.status === ACTIVE ? `of ${this.count(tech.cost)}` : '' }]

      if (entry.missing.length) {
        facts.push({ label: 'RP to get there', value: isKnownNumber(entry.pathRp) ? `${this.count(entry.pathRp)} RP` : UNKNOWN_TEXT, result: pathRpResult(entry), note: `${entry.missing.length + 1} steps, prerequisites included` })
      }

      const rate = this.research.totalRate

      if (rate > 0) {
        facts.push({ label: 'With every lab on it', value: isKnownNumber(entry.pathRp) ? durationLabel(entry.pathRp / rate, this.separator) : UNKNOWN_TEXT, result: pathRpResult(entry), note: `at ${this.count(rate)} RP a year, if one scientist could run them all` })
      }

      facts.push({ label: 'Opens', value: `${entry.unlocks}`, note: entry.unlocks === 1 ? 'technology' : 'technologies' })

      return facts.slice(0, 4)
    },

    order() {
      const { info, graph } = this.research

      return [...this.entry.missing, this.tech.id].map((id) => ({ id, name: graph.techs.get(id).name, status: info.get(id).status, remaining: info.get(id).remaining, result: remainingResult(info.get(id)) }))
    },

    opens() {
      const { info, graph, state } = this.research

      return this.tech.dependents.filter((id) => !state.researched.has(id)).map((id) => {
        const others = info.get(id).missing.length
        const status = info.get(id).status

        return { id, name: graph.techs.get(id).name, status, note: status === LOCKED && others > 1 ? `needs ${others - 1} more first` : STATUS_LABELS[status] }
      }).sort((a, b) => a.name.localeCompare(b.name))
    },

    chain() {
      return this.tech ? prerequisiteChain(this.research.graph, this.research.info, this.tech.id) : null
    },
  },
  watch: {
    chain: 'draw',
    'appearance.key': 'draw',
    typeface: 'draw',
  },
  mounted() {
    this.draw()
  },
  beforeDestroy() {
    this.destroy()
  },
  methods: {
    filterOption(item, query) {
      const needle = (query || '').toLowerCase()

      return !needle || item.name.toLowerCase().includes(needle) || item.line.toLowerCase().includes(needle)
    },

    destroy() {
      if (this.cy) {
        this.cy.destroy()
        this.cy = null
      }
    },

    fit() {
      if (this.cy) {
        this.cy.fit(undefined, 24)
      }
    },

    draw() {
      this.destroy()

      if (!this.chain) {
        return
      }

      // The container exists once the card has rendered.
      this.$nextTick(() => {
        const container = this.$refs.graph

        if (!container || !this.chain) {
          return
        }

        const { graph, info } = this.research
        const theme = chartTheme(this.appearance)
        const colors = statusColors(this.appearance)
        const elements = [
          ...this.chain.nodes.map((node) => {
            const tech = graph.techs.get(node.id)
            const status = info.get(node.id).status

            return {
              data: { id: String(node.id), status, target: node.id === this.tech.id, label: status === DONE ? truncate(tech.name, 30) : `${truncate(tech.name, 30)}\n${isKnownNumber(info.get(node.id).remaining) ? `${this.count(info.get(node.id).remaining)} RP` : 'RP not known'}` },
              position: { x: node.layer * COLUMN_WIDTH, y: node.row * ROW_HEIGHT },
            }
          }),
          ...this.chain.edges.map((edge) => ({ data: { id: `${edge.from}-${edge.to}`, source: String(edge.from), target: String(edge.to) } })),
        ]

        this.cy = cytoscape({
          container,
          elements,
          layout: { name: 'preset' },
          wheelSensitivity: 0.3,
          minZoom: 0.2,
          maxZoom: 2,
          style: [
            {
              selector: 'node',
              style: {
                shape: 'round-rectangle',
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                'background-color': (node) => colors[node.data('status')],
                'background-opacity': (node) => (node.data('status') === DONE ? 0.22 : node.data('status') === AVAILABLE ? 0.18 : node.data('status') === LOCKED ? 0.08 : 0.3),
                'border-width': (node) => (node.data('target') ? 3 : 2),
                'border-color': (node) => colors[node.data('status')],
                'border-style': (node) => (node.data('status') === BLOCKED ? 'dashed' : node.data('status') === QUEUED ? 'dotted' : 'solid'),
                label: 'data(label)',
                'text-wrap': 'wrap',
                'text-valign': 'center',
                'text-halign': 'center',
                'font-size': this.typeface.size(11),
                'font-family': this.typeface.family,
                color: theme.ink,
              },
            },
            { selector: 'edge', style: { width: 2, 'line-color': withAlpha(theme.inkMuted, 0.7), 'target-arrow-color': withAlpha(theme.inkMuted, 0.7), 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
          ],
        })

        this.cy.on('tap', 'node', (event) => this.$emit('select-tech', Number(event.target.id())))
        this.cy.on('mouseover', 'node', () => (container.style.cursor = 'pointer'))
        this.cy.on('mouseout', 'node', () => (container.style.cursor = ''))
        this.fit()
      })
    },
  },
}
</script>

<style lang="scss">
.path-view {
  .panel {
    margin-top: 0;
    margin-bottom: 16px;
  }

  .panel-body {
    padding: 16px 24px;
  }

  .panel-head + .panel-body {
    padding-top: 0;
  }

  .panel-foot {
    padding: 8px 24px 16px;
  }

  .description {
    max-width: 780px;
    opacity: 0.85;
  }

  .fact-value {
    font-size: calc(22px * var(--ae-font-scale));
    line-height: calc(30px * var(--ae-font-scale));
  }

  .status-chip {
    white-space: nowrap;
  }

  .graph {
    height: 420px;
  }

  .legend {
    align-items: center;
  }

  .legend-item {
    gap: 6px;
  }

  .swatch {
    display: inline-block;
    box-sizing: border-box;
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-radius: 3px;

    &.done {
      background: var(--st-done);
    }

    &.active {
      background: var(--st-active);
    }

    &.available {
      border-color: var(--st-available);
      background: var(--st-available-soft);
    }

    &.locked {
      border-color: var(--st-locked);
    }

    &.blocked {
      border: 2px dashed var(--st-blocked);
    }
  }

  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .step {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);

    &:last-child {
      border-bottom: 0;
    }
  }

  .empty {
    font-size: calc(14px * var(--ae-font-scale));
    opacity: 0.7;
  }

  .tech-link {
    color: inherit;
    cursor: pointer;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
