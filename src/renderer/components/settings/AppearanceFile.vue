<template>
  <div class="appearance-file" :data-appearance-details="kept ? 'kept' : 'draft'">
    <div class="appearance-file__head">
      <span class="body-2" data-appearance-name>{{ appearance.name }}</span>
      <span class="caption text--secondary">{{ appearance.mode === 'dark' ? 'Dark mode' : 'Light mode' }} · {{ kept ? 'kept in the settings' : 'a draft, kept only by Apply' }}</span>
    </div>

    <div v-if="file.description" class="caption" data-appearance-description>{{ file.description }}</div>
    <div v-if="file.author" class="caption text--secondary" data-appearance-author>Author: {{ file.author }}</div>

    <ul class="appearance-file__facts caption text--secondary">
      <li data-appearance-base>{{ baseText }}</li>
      <li v-if="originText" data-appearance-origin>{{ originText }}</li>
      <li v-if="referenceText" data-appearance-reference>{{ referenceText }}</li>
      <li data-appearance-font>{{ fontText }} <v-btn v-if="usable" x-small text color="primary" data-appearance-use-font @click="$emit('use-font', file.font.choice)">Preview {{ file.font.family }}</v-btn></li>
    </ul>

    <v-alert v-if="notice" type="warning" text dense class="mb-0" data-appearance-font-notice>{{ notice }}</v-alert>

    <v-alert :type="file.defaults.length ? 'info' : 'success'" text dense class="mb-0" data-appearance-defaults>
      <template v-if="file.defaults.length">
        <div>{{ count(file.defaults.length) }} of {{ count(total) }} roles are not in the file, and take the values of {{ baseName }}{{ file.base.explicit ? ', the base the file names' : `, the base of the ${appearance.mode} mode` }}.</div>
        <details class="appearance-file__more">
          <summary>List the roles taken from {{ baseName }}</summary>
          <ul class="appearance-file__list">
            <li v-for="item in file.defaults" :key="item.path">
              <span v-if="isColor(item.value)" class="appearance-file__swatch" :style="{ backgroundColor: item.value }" aria-hidden="true" />
              <span class="appearance-file__path">{{ item.path }}</span> {{ valueText(item.value) }}
            </li>
          </ul>
        </details>
      </template>
      <template v-else>Every role is in the file; no default is used.</template>
    </v-alert>

    <v-alert v-if="report.blocking.length" type="error" text dense class="mb-0" data-appearance-blocking>
      <div>Apply is blocked: the text would be unreadable.</div>
      <ul class="appearance-file__list">
        <li v-for="finding in report.blocking" :key="finding.label">{{ finding.label }}: {{ finding.foreground }} on {{ finding.surface }} is {{ ratioText(finding.ratio) }}:1, under the {{ finding.minimum }}:1 that is the least that can be read.</li>
      </ul>
    </v-alert>

    <v-alert v-if="report.findings.length" type="warning" text dense class="mb-0" data-appearance-findings>
      <div><span data-appearance-count>{{ count(report.findings.length) }}</span> of {{ count(report.checked) }} contrast measurements are under their minimum (4.5:1 for text, 3:1 for graphics and chart slots, 2.5:1 for disabled text), in {{ count(groups.length) }} {{ groups.length === 1 ? 'place' : 'places' }}. {{ report.blocking.length ? '' : 'Apply asks for a confirmation first.' }}</div>
      <ul class="appearance-file__list">
        <li v-for="group in shownGroups" :key="group.label"><span data-appearance-finding>{{ group.label }}</span>: {{ group.foreground }} on {{ group.surface }} is {{ ratioText(group.ratio) }}:1, under {{ group.minimum }}:1{{ group.more ? ` (and ${count(group.more)} more of the same)` : '' }}.</li>
      </ul>
      <div v-if="hiddenGroups" class="caption">and {{ count(hiddenGroups) }} more</div>
    </v-alert>
    <div v-else class="caption text--secondary" data-appearance-pass>All {{ count(report.checked) }} measured contrasts pass.</div>

    <div class="caption text--secondary">Measured here: text, graphics, table row washes, filled chips and the nine chart slots, with the checks the built-in presets are held to. The colour-vision simulation, the Galaxy Map's menu and the stylesheet's own rules are not measured for a file.</div>
  </div>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { ROLE_PATHS, fontNotice } from '../../utilities/appearance-file'
import { fontInForce } from '../../utilities/appearance-font'
import { resolveAppearance } from '../../utilities/appearance'

const SHOWN_GROUPS = 12

// What the imported appearance file says besides its colours, and how its colours measure: the kind of base it fills omitted roles from, the roles it did fill in, where it says it came from, the font it names and the contrast findings. `entry` is `{ appearance, report }` of `importedAppearances()`; `kept` says it is the one kept in the settings and not a draft. Reads only; it changes nothing.
export default {
  name: 'AppearanceFile',
  mixins: [countFormat],
  props: {
    entry: { type: Object, required: true },
    kept: { type: Boolean, default: false },
  },
  computed: {
    appearance() {
      return this.entry.appearance
    },

    file() {
      return this.appearance.file
    },

    report() {
      return this.entry.report
    },

    // The roles an appearance has: every role of the file format, the optional link line only when it has one.
    total() {
      return ROLE_PATHS.filter((path) => path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), this.appearance) !== undefined).length
    },

    baseName() {
      return resolveAppearance(this.file.base.id).name
    },

    baseText() {
      return this.file.base.explicit ? `Base: ${this.baseName}, named by the file; roles the file leaves out take its values.` : `Base: ${this.baseName}, the baseline of the ${this.appearance.mode} mode, since the file names none; roles the file leaves out take its values.`
    },

    originText() {
      const { provenance } = this.file

      if (!provenance) {
        return ''
      }

      const origin = provenance.origin ? `${provenance.origin.kind === 'built-in' ? 'the built-in appearance' : 'an imported appearance'} ${provenance.origin.name || provenance.origin.id || ''}${provenance.origin.version === undefined ? '' : `, version ${provenance.origin.version}`}` : ''
      const parts = [provenance.app ? `written by ${provenance.app}` : '', provenance.exportedAt ? `at ${provenance.exportedAt}` : '', origin ? `from ${origin}` : ''].filter(Boolean)

      return parts.length ? `Provenance: ${parts.join(' ')}.` : ''
    },

    referenceText() {
      const reference = this.file.provenance && this.file.provenance.reference

      if (!reference) {
        return ''
      }

      const { source = {} } = reference
      const parts = [source.name, source.author ? `by ${source.author}` : '', source.license, source.revision ? `revision ${source.revision}` : '', source.revisionDate].filter(Boolean)

      return `Reference carried by the file: ${[reference.title, parts.join(', ')].filter(Boolean).join(', ')}. This is a note of attribution; nothing is downloaded from it.`
    },

    fontText() {
      const { family, explicit, supported } = this.file.font

      if (!explicit) {
        return 'Font: none named, so the typeface in force is kept.'
      }

      return supported ? `Font: ${family}, one of the typefaces offered under Typeface and text size. Applying the file does not change the typeface in force.` : `Font: ${family}.`
    },

    // A typeface the file names that is offered, and not the one in force already: the preview button.
    usable() {
      const { explicit, choice } = this.file.font

      return explicit && choice !== null && choice !== fontInForce().family
    },

    notice() {
      return fontNotice(this.file.font)
    },

    // The measurements under their minimum, one entry per place (a label), the worst first.
    groups() {
      const found = new Map()

      this.report.findings.forEach((finding) => {
        const known = found.get(finding.label)

        if (!known) {
          found.set(finding.label, { ...finding, more: 0 })
        } else {
          known.more++

          if (finding.ratio < known.ratio) {
            Object.assign(known, { foreground: finding.foreground, surface: finding.surface, ratio: finding.ratio, minimum: finding.minimum })
          }
        }
      })

      return [...found.values()].sort((first, second) => first.ratio - second.ratio)
    },

    shownGroups() {
      return this.groups.slice(0, SHOWN_GROUPS)
    },

    hiddenGroups() {
      return Math.max(0, this.groups.length - SHOWN_GROUPS)
    },
  },
  methods: {
    isColor(value) {
      return typeof value === 'string' && /^(#|rgb)/i.test(value)
    },

    valueText(value) {
      return Array.isArray(value) ? value.join(' ') : String(value)
    },

    ratioText(value) {
      return value.toFixed(2)
    },
  },
}
</script>

<style lang="scss" scoped>
.appearance-file {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--ae-border);
  border-radius: 6px;
}

.appearance-file__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}

.appearance-file__facts {
  margin: 0;
  padding-left: 18px;
}

.appearance-file__list {
  margin: 4px 0 0;
  padding-left: 20px;
}

.appearance-file__more {
  margin-top: 4px;

  summary {
    cursor: pointer;
  }

  .appearance-file__list {
    max-height: 240px;
    overflow: auto;
  }
}

.appearance-file__path {
  font-family: monospace;
  word-break: break-all;
}

.appearance-file__swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 4px;
  vertical-align: -1px;
  border: 1px solid var(--ae-border);
  border-radius: 2px;
}
</style>
