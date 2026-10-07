<template>
  <div class="lines-view">
    <div class="d-flex align-center flex-wrap mb-2">
      <v-switch :input-value="hideFinished" label="Hide finished lines" dense hide-details class="mt-0 mr-6" @change="(value) => $emit('set-hide-finished', !!value)" />
      <span class="legend">
        <span v-for="item in legend" :key="item.status" class="legend-item"><span class="pip" :class="item.status" />{{ item.label }}</span>
      </span>
    </div>
    <div class="caption text--secondary mb-4">A line is one kind of upgrade: each square is a level, cheapest first. A slim square comes free with the level before it.</div>

    <v-card v-for="group in groups" :key="group.field.ResearchFieldID" class="panel" elevation="1">
      <div class="panel-head">
        <span><span class="abbreviation mr-2">{{ group.field.Abbreviation }}</span>{{ group.field.FieldName }}</span>
        <span class="caption text--secondary">{{ group.lines.length }} {{ group.lines.length === 1 ? 'line' : 'lines' }}</span>
      </div>
      <div v-for="line in group.lines" :key="line.typeId" class="line">
        <div class="line-name">
          <div class="font-weight-medium">{{ line.name }}</div>
          <div class="caption text--secondary">{{ line.done }} of {{ line.total }}<span v-if="line.best"> · now {{ line.best.name }}</span></div>
        </div>
        <div class="pips">
          <button v-for="tech in line.techs" :key="tech.id" type="button" class="pip" :class="[research.info.get(tech.id).status, { auto: tech.automatic }]" :title="pipTitle(tech)" :aria-label="pipTitle(tech)" @click="$emit('select-tech', tech.id)" />
        </div>
        <div class="line-next caption">
          <template v-if="line.next">
            <a class="tech-link font-weight-medium" @click="$emit('select-tech', line.next.id)">{{ line.next.name }}</a>
            <div class="text--secondary">{{ nextNote(line.next) }}</div>
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
import { ACTIVE, AVAILABLE, BLOCKED, DONE, LOCKED, QUEUED, STATUS_LABELS } from '../../utilities/research'

export default {
  name: 'LinesView',
  mixins: [countFormat],
  props: {
    research: { type: Object, required: true },
    search: { type: String, default: '' },
    hideFinished: { type: Boolean, default: true },
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
    pipTitle(tech) {
      const entry = this.research.info.get(tech.id)

      return `${tech.name}: ${STATUS_LABELS[entry.status].toLowerCase()}, ${this.count(tech.cost)} RP`
    },

    nextNote(tech) {
      const entry = this.research.info.get(tech.id)

      if (entry.status === ACTIVE) {
        return `Running, ${this.count(entry.remaining)} RP left`
      } else if (entry.status === QUEUED) {
        return `Queued, ${this.count(entry.remaining)} RP`
      } else if (entry.status === LOCKED) {
        return `${this.count(entry.pathRp)} RP in all, ${entry.missing.length + 1} steps`
      }

      return `${this.count(entry.remaining)} RP, available now`
    },
  },
}
</script>

<style lang="scss">
.lines-view {
  .panel {
    margin-bottom: 16px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 24px;
    font-size: 16px;
    line-height: 28px;
  }

  .abbreviation {
    font-size: 11px;
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

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
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
