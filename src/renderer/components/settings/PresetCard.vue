<template>
  <button type="button" class="preset" :class="{ 'preset--active': active }" :aria-pressed="String(active)" :data-preset="appearance.id" @click="$emit('select', appearance.id)">
    <span class="preset__head">
      <span class="preset__name">{{ appearance.name }}</span>
      <span class="preset__mode">{{ appearance.mode === 'dark' ? 'Dark mode' : 'Light mode' }}<template v-if="appearance.file"> · from a file</template></span>
      <span v-if="status" class="preset__status" :class="{ 'preset__status--previewing': !applied }">{{ status }}</span>
    </span>

    <span class="sample" :style="sampleStyle" aria-hidden="true">
      <span class="sample__nav">
        <span v-for="item in navItems" :key="item.id" class="sample__nav-item" :class="{ 'sample__nav-item--active': item.active }" :style="item.style">
          <i class="mdi" :class="item.icon" />
          {{ item.title }}
        </span>
      </span>

      <span class="sample__card">
        <span class="sample__row sample__row--head">
          <span>Body</span>
          <span class="sample__num">Pop (M)</span>
          <span class="sample__num">Output</span>
        </span>
        <span v-for="row in rows" :key="row.name" class="sample__row" :class="{ 'sample__row--hover': row.hover }">
          <span>{{ row.name }}</span>
          <span class="sample__num">{{ row.population }}</span>
          <span class="sample__num">{{ row.output }}</span>
        </span>

        <span class="sample__levels">
          <span v-for="level in levels" :key="level.label" class="sample__level" :style="{ color: level.color }">
            <i class="mdi" :class="level.icon" />
            <span class="sample__level-text">{{ level.label }}</span>
          </span>
        </span>

        <span class="sample__controls">
          <span class="sample__tab">Selected</span>
          <span class="sample__field">Focused</span>
        </span>

        <span class="sample__chart">
          <span v-for="(bar, index) in bars" :key="index" class="sample__bar" :style="bar" />
        </span>
      </span>
    </span>
  </button>
</template>

<script>
import { appearanceStyle } from '../../utilities/appearance'
import { patternImage, seriesIdentity } from '../charts/theme'
import { SECTIONS } from '../../utilities/navigation'
import { sectionStyle } from '../navigation/section-style'

// Static example data: nothing here comes from a save, so a card shows the same before any race is picked.
const NAV = [{ id: 'colonies', active: true }, { id: 'economy', active: false }]
const ROWS = [{ name: 'Example I', population: '1 240.5', output: '86.2' }, { name: 'Example II', population: '312.0', output: '14.9', hover: true }]
const LEVELS = [{ key: 'action', label: 'Action', icon: 'mdi-alert-circle' }, { key: 'attention', label: 'Attention', icon: 'mdi-alert' }, { key: 'info', label: 'Info', icon: 'mdi-information-outline' }]
const BAR_HEIGHTS = [46, 72, 34, 88, 58, 40, 76, 30, 64]

// One preset as a button: its name and mode, and a sample drawn with the preset's own resolved colours, not the live app's. `appearance` is a resolved appearance (`resolveAppearance`); `active` says it is the one in force (the previewed one), `applied` that it is the one kept.
export default {
  name: 'PresetCard',
  props: {
    appearance: { type: Object, required: true },
    active: { type: Boolean, default: false },
    applied: { type: Boolean, default: false },
  },
  computed: {
    status() {
      if (this.applied) {
        return 'Applied'
      }

      return this.active ? 'Previewing' : ''
    },

    // The preset's tokens for the sample alone: the CSS custom properties the app reads, set on the sample so everything inside takes the preset's, and the axis colour the app has no property for.
    sampleStyle() {
      return { ...appearanceStyle(this.appearance), '--sample-axis': this.appearance.charts.axis }
    },

    navItems() {
      return NAV.map(({ id, active }) => {
        const section = SECTIONS.find((entry) => entry.id === id)

        return { id, active, title: section.title, icon: section.icon, style: sectionStyle(this.appearance, section) }
      })
    },

    rows() {
      return ROWS
    },

    levels() {
      return LEVELS.map(({ key, label, icon }) => ({ label, icon, color: this.appearance.severity[key] }))
    },

    // The nine categorical slots as bars, each with the texture that tells its slot apart without the colour.
    bars() {
      const { categorical } = this.appearance.charts

      return categorical.map((background, index) => {
        const texture = patternImage(seriesIdentity(this.appearance, background), this.appearance.surfaces.card)

        return { background, height: `${BAR_HEIGHTS[index]}%`, ...(texture ? { backgroundImage: texture, backgroundSize: '8px 8px' } : {}) }
      })
    },
  },
}
</script>

<style lang="scss" scoped>
.preset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 10px;
  font: inherit;
  text-align: left;
  color: var(--ae-ink);
  cursor: pointer;
  background: transparent;
  border: 2px solid var(--ae-border);
  border-radius: 8px;

  &:hover {
    background: var(--ae-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--ae-primary);
    outline-offset: 2px;
  }
}

.preset--active {
  border-color: var(--ae-primary);
}

.preset__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.preset__name {
  font-size: calc(15px * var(--ae-font-scale));
  font-weight: 500;
}

.preset__mode {
  font-size: calc(12px * var(--ae-font-scale));
  color: var(--ae-muted);
}

.preset__status {
  margin-left: auto;
  padding: 0 8px;
  font-size: calc(11px * var(--ae-font-scale));
  line-height: calc(18px * var(--ae-font-scale));
  color: var(--ae-primary);
  border: 1px solid var(--ae-primary);
  border-radius: 9px;
}

.preset__status--previewing {
  border-style: dashed;
}

// Everything under .sample reads the preset's own --ae-* values, set inline on it.
.sample {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  font-size: calc(11px * var(--ae-font-scale));
  line-height: 1.3;
  color: var(--ae-ink);
  background: var(--ae-bg);
  border: 1px solid var(--ae-border);
  border-radius: 6px;
}

.sample__nav {
  display: flex;
  gap: 6px;
  padding: 6px;
  background: var(--ae-chrome);
  border-bottom: 1px solid var(--ae-border);
}

.sample__nav-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  white-space: nowrap;
  border-radius: 10px;

  .mdi {
    font-size: calc(14px * var(--ae-font-scale));
    color: var(--sc);
  }
}

.sample__nav-item--active {
  font-weight: 500;
  background: var(--sc-soft);
}

.sample__card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px;
  padding: 6px 8px 8px;
  background: var(--ae-card);
  border: 1px solid var(--ae-border);
  border-radius: 4px;
}

.sample__row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 6px;
  padding: 2px 4px;
}

.sample__row--head {
  color: var(--ae-muted);
  border-bottom: 1px solid var(--ae-border);
}

.sample__row--hover {
  background: var(--ae-hover);
}

.sample__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.sample__levels {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}

.sample__level {
  display: inline-flex;
  align-items: center;
  gap: 3px;

  .mdi {
    font-size: calc(14px * var(--ae-font-scale));
  }
}

.sample__level-text {
  color: var(--ae-ink);
}

.sample__controls {
  display: flex;
  gap: 8px;
}

.sample__tab {
  padding: 2px 8px;
  font-weight: 500;
  color: var(--ae-primary);
  background: var(--ae-hover);
  border-bottom: 2px solid var(--ae-primary);
}

.sample__field {
  flex: 1 1 auto;
  padding: 1px 6px;
  color: var(--ae-muted);
  border: 2px solid var(--ae-primary);
  border-radius: 4px;
}

.sample__chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 36px;
  border-bottom: 1px solid var(--sample-axis);
}

.sample__bar {
  flex: 1 1 0;
  min-width: 0;
}
</style>
