<template>
  <div class="lines-view">
    <div class="d-flex align-center flex-wrap mb-2">
      <v-switch :input-value="hideFinished" label="Hide finished lines" dense hide-details class="mt-0 mr-6" @change="(value) => $emit('set-hide-finished', !!value)" />
      <span class="legend">
        <span v-for="item in legend" :key="item.status" class="legend-item"><span class="pip" :class="item.status" />{{ item.label }}</span>
      </span>
    </div>
    <div class="caption text--secondary mb-4">A line is one kind of upgrade: each square is a level, cheapest first. A slim square comes free with the level before it.</div>

    <v-card v-for="group in groups" :key="group.field.ResearchFieldID" class="panel" data-summary="The upgrade lines of one research field, level by level, with the next technology of each." elevation="1">
      <div class="panel-head">
        <span><span class="abbreviation mr-2">{{ group.field.Abbreviation }}</span>{{ group.field.FieldName }}</span>
        <span class="caption text--secondary">{{ group.lines.length }} {{ group.lines.length === 1 ? 'line' : 'lines' }}</span>
      </div>
      <div v-for="line in group.lines" :key="line.typeId" class="line">
        <div class="line-name">
          <div class="font-weight-medium">{{ line.name }}<page-link v-if="techViews[line.typeId]" class="ml-1" :to="linkTo.shipyards({ view: techViews[line.typeId] })" :name="line.name" /></div>
          <div class="caption text--secondary">{{ line.done }} of {{ line.total }}<span v-if="line.best"> · now {{ line.best.name }}</span></div>
        </div>
        <div class="pips">
          <button v-for="tech in line.techs" :key="tech.id" type="button" class="pip" :class="[research.info.get(tech.id).status, { auto: tech.automatic }]" :title="pipTitle(tech)" :aria-label="pipTitle(tech)" @click="$emit('select-tech', tech.id)" />
        </div>
        <div class="line-next caption">
          <template v-if="line.next">
            <a class="tech-link font-weight-medium" @click="$emit('select-tech', line.next.id)">{{ line.next.name }}</a>
            <div class="text--secondary">{{ nextNote(line.next) }}<provenance-mark v-if="nextResult(line.next)" :result="nextResult(line.next)" /></div>
          </template>
          <span v-else class="text--secondary">Every level researched</span>
        </div>
      </div>
    </v-card>
    <div v-if="!groups.length" class="text--secondary pa-4">No line matches.</div>
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { linkTo } from '../../utilities/deep-links'
import { isKnownNumber } from '../../utilities/math'
import { ACTIVE, AVAILABLE, BLOCKED, DONE, LOCKED, pathRpResult, QUEUED, remainingResult, STATUS_LABELS } from '../../utilities/research'
import { SHIPYARD_TECH_VIEWS } from '../../utilities/shipyard-growth'
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'

export default {
  name: 'LinesView',
  components: { PageLink, ProvenanceMark },
  mixins: [countFormat],
  props: {
    research: { type: Object, required: true },
    search: { type: String, default: '' },
    hideFinished: { type: Boolean, default: true },
  },
  data() {
    return { linkTo, techViews: SHIPYARD_TECH_VIEWS }
  },
  computed: {
    legend() {
      return [DONE, ACTIVE, QUEUED, AVAILABLE, LOCKED, BLOCKED].map((status) => ({ status, label: STATUS_LABELS[status] }))
    },

    groups() {
      const needle = this.search.trim().toLowerCase()

      return this.research.fields.map((field) => ({
        field,
        lines: this.research.lines.filter((line) => line.fieldId === field.ResearchFieldID && line.techs.length > 1 && (!this.hideFinished || line.done < line.total) && (!needle || line.name.toLowerCase().includes(needle) || line.techs.some((tech) => tech.name.toLowerCase().includes(needle)))),
      })).filter((group) => group.lines.length)
    },
  },
  methods: {
    // RP as the page prints it, or a plain statement that the save does not give it.
    rp(value) {
      return isKnownNumber(value) ? `${this.count(value)} RP` : 'RP not known'
    },

    pipTitle(tech) {
      const entry = this.research.info.get(tech.id)

      return `${tech.name}: ${STATUS_LABELS[entry.status].toLowerCase()}, ${isKnownNumber(tech.cost) ? this.rp(tech.cost) : 'cost not known'}`
    },

    nextNote(tech) {
      const entry = this.research.info.get(tech.id)

      if (entry.status === ACTIVE) {
        return isKnownNumber(entry.remaining) ? `Running, ${this.rp(entry.remaining)} left` : 'Running, RP left not known'
      } else if (entry.status === QUEUED) {
        return `Queued, ${this.rp(entry.remaining)}`
      } else if (entry.status === LOCKED) {
        return `${isKnownNumber(entry.pathRp) ? `${this.rp(entry.pathRp)} in all` : 'RP in all not known'}, ${entry.missing.length + 1} steps`
      }

      return `${this.rp(entry.remaining)}, available now`
    },

    // The result behind the figure of the next note: the path RP of a locked level (an estimate while known), the RP left of an available one when that is not known.
    nextResult(tech) {
      const entry = this.research.info.get(tech.id)

      if (entry.status === LOCKED) {
        return pathRpResult(entry)
      }

      return isKnownNumber(entry.remaining) ? null : remainingResult(entry)
    },
  },
}
</script>

<style lang="scss">
.lines-view {
  .panel {
    margin-top: 0;
    margin-bottom: 16px;
  }

  .panel-head {
    flex-wrap: nowrap;
    gap: 0;
  }

  .abbreviation {
    font-size: calc(11px * var(--ae-font-scale));
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--sc-soft);
  }

  .line {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr) minmax(200px, 1fr);
    gap: 4px 24px;
    align-items: center;
    padding: 8px 24px;
    border-top: 1px solid rgba(128, 128, 128, 0.2);
  }

  .pips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .pip {
    display: inline-block;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    vertical-align: middle;

    &.done {
      background: var(--st-done);
    }

    &.active {
      background: var(--st-active);
    }

    &.queued {
      border-color: var(--st-active);
      background: repeating-linear-gradient(45deg, var(--st-active) 0 3px, transparent 3px 6px);
    }

    &.available {
      border-color: var(--st-available);
      background: var(--st-available-soft);
    }

    &.locked {
      border-color: var(--st-locked);
      opacity: 0.75;
    }

    &.blocked {
      border: 2px dashed var(--st-blocked);
    }

    &.auto {
      width: 9px;
    }
  }

  button.pip {
    cursor: pointer;

    &:hover,
    &:focus-visible {
      outline: 2px solid var(--sc);
      outline-offset: 1px;
    }
  }

  .legend-item {
    gap: 6px;
  }

  .tech-link {
    color: inherit;
    cursor: pointer;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}

@media (max-width: 959px) {
  .lines-view .line {
    grid-template-columns: 1fr;
  }
}
</style>
