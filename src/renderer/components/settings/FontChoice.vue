<template>
  <div class="font-choice" data-font-choice>
    <div class="setting__text">
      <div class="body-2">Typeface and text size</div>
      <div class="caption text--secondary">{{ note }}</div>
    </div>

    <div class="font-choice__families" role="radiogroup" aria-label="Typeface">
      <button v-for="item in families" :key="item.id" type="button" role="radio" class="family" :class="{ 'family--active': item.id === inForce.family, 'family--missing': !item.status.available }" :aria-checked="String(item.id === inForce.family)" :data-font-family="item.id" :data-font-available="String(item.status.available)" @click="pickFamily(item.id)">
        <span class="family__head">
          <span class="family__name" :style="{ fontFamily: item.drawn }">{{ item.name }}</span>
          <span v-if="item.id === applied.family" class="family__tag">{{ previewing ? 'Kept' : 'In use' }}</span>
        </span>
        <span class="family__sample" :style="{ fontFamily: item.drawn }">{{ item.sample }}</span>
        <span class="family__figures" :style="{ fontFamily: item.drawn }">0123456789 · 1,234,567.89 · −12.5 %</span>
        <span class="family__meta">{{ item.sourceLabel }} · {{ item.licence }}</span>
        <span class="family__status" :class="{ 'family__status--missing': !item.status.available }">{{ item.status.text }}</span>
      </button>
    </div>

    <div class="font-choice__scales">
      <span id="font-scale-label" class="caption text--secondary">Text size</span>
      <v-btn-toggle :value="inForce.scale" mandatory dense aria-labelledby="font-scale-label" @change="pickScale">
        <v-btn v-for="scale in scales" :key="scale.value" :value="scale.value" small :data-font-scale="scale.value">{{ scale.label }}</v-btn>
      </v-btn-toggle>
    </div>

    <div class="caption" data-font-effective>{{ roles.explanation }}</div>

    <div class="presets__actions">
      <v-btn small depressed color="primary" :disabled="!previewing" data-font-action="apply" @click="apply">Apply</v-btn>
      <v-btn small outlined :disabled="!previewing" data-font-action="cancel" @click="cancel">Cancel</v-btn>
      <v-btn small text :disabled="atDefault" data-font-action="reset" @click="reset">Reset to {{ defaultName }} at {{ defaultScale }}</v-btn>
    </div>

    <v-alert v-if="problem" type="warning" text dense class="mb-0" data-font-problem>
      <div class="body-2">{{ problem }} The default is shown. The saved value stays in the settings until a choice is applied.</div>
    </v-alert>
  </div>
</template>

<script>
import { mapActions } from 'vuex'

import { DEFAULT_FONT, FONT_FAMILIES, FONT_SCALES, appliedFont, applyFont, cancelFontPreview, familyOf, familyStatus, fontInForce, fontProblem, fontRoles, isFontPreviewing, previewFont, resetFont, scaleLabel } from '../../utilities/appearance-font'

// The typeface and text size of the app (utilities/appearance-font.js): the families offered, each drawn in itself as it is in force (a family that is not installed shows the typeface that replaces it), the bounded text sizes, and what the choice in force resolves to. A choice previews on every page at once; Apply keeps it, Cancel and leaving Settings drop it, and Reset keeps the bundled default.
export default {
  name: 'FontChoice',
  props: {
    // The settings store the choice is kept in.
    config: { type: Object, required: true },
  },
  computed: {
    inForce() {
      return fontInForce()
    },

    applied() {
      return appliedFont()
    },

    previewing() {
      return isFontPreviewing()
    },

    problem() {
      return fontProblem()
    },

    roles() {
      return fontRoles()
    },

    families() {
      return FONT_FAMILIES.map((family) => ({ ...family, status: familyStatus(family.id), drawn: fontRoles({ family: family.id, scale: 1 }).body, sourceLabel: family.source === 'bundled' ? 'Bundled' : 'System' }))
    },

    scales() {
      return FONT_SCALES.map((value) => ({ value, label: scaleLabel(value) }))
    },

    defaultName() {
      return familyOf(DEFAULT_FONT.family).name
    },

    defaultScale() {
      return scaleLabel(DEFAULT_FONT.scale)
    },

    atDefault() {
      return this.inForce.family === DEFAULT_FONT.family && this.inForce.scale === DEFAULT_FONT.scale && this.applied.family === DEFAULT_FONT.family && this.applied.scale === DEFAULT_FONT.scale
    },

    note() {
      return `A bounded choice of typeface and text size for every page, chart and map. ${this.previewing ? 'Previewed on every page; Apply keeps it.' : `Now ${familyOf(this.applied.family).name} at ${scaleLabel(this.applied.scale)}.`}`
    },
  },
  beforeDestroy() {
    cancelFontPreview()
  },
  methods: {
    ...mapActions('snackbar', ['activateSnackbar']),

    pickFamily(id) {
      previewFont({ family: id })
    },

    pickScale(value) {
      previewFont({ scale: value })
    },

    cancel() {
      cancelFontPreview()
    },

    apply() {
      this.keep(() => applyFont(this.config), 'applied')
    },

    reset() {
      this.keep(() => resetFont(this.config), 'reset to the bundled default')
    },

    // Writes the choice. The state changes only when the write succeeds, and the settings are read again by what depends on them.
    keep(write, done) {
      try {
        write()
      } catch (error) {
        console.error("Couldn't write the typeface", error)
        this.activateSnackbar({ text: "Couldn't write the settings, so the typeface was not changed", color: 'error' })

        return
      }

      this.$emit('changed')
      this.activateSnackbar({ text: `The typeface and text size are ${done}`, color: 'success' })
    },
  },
}
</script>

<style lang="scss" scoped>
// The block itself is laid out by the Display panel (`setting setting--block`).
.presets__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.font-choice__families {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.font-choice__scales {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.family {
  display: flex;
  flex-direction: column;
  gap: 4px;
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

.family--active {
  border-color: var(--ae-primary);
}

.family--missing {
  border-style: dashed;
}

.family__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.family__name {
  font-size: calc(15px * var(--ae-font-scale));
  font-weight: 500;
}

.family__tag {
  margin-left: auto;
  padding: 0 8px;
  font-family: var(--ae-font);
  font-size: calc(11px * var(--ae-font-scale));
  line-height: 1.6;
  color: var(--ae-primary);
  border: 1px solid var(--ae-primary);
  border-radius: 9px;
}

.family__sample {
  font-size: calc(13px * var(--ae-font-scale));
  overflow-wrap: anywhere;
}

.family__figures {
  font-size: calc(13px * var(--ae-font-scale));
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.family__meta,
.family__status {
  font-family: var(--ae-font);
  font-size: calc(12px * var(--ae-font-scale));
  color: var(--ae-muted);
}

.family__status--missing {
  font-weight: 500;
  color: var(--ae-ink);
}
</style>
