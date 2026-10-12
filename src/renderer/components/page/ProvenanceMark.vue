<template>
  <span v-if="mark" class="provenance-mark" :class="`provenance-mark--${kind}`" role="img" :aria-label="text" :title="text">
    <v-icon x-small class="provenance-mark__icon">{{ mark.icon }}</v-icon><span v-if="label" class="provenance-mark__label">{{ mark.label }}</span>
  </span>
</template>

<script>
import { STATUS_MARKS, describeResult, describeRule, getRule } from '../../utilities/provenance'

// The mark of how far a figure can be trusted: an icon whose shape differs for confirmed, estimated, assumed and unavailable, so the four tell apart without colour, with the status, rule, versions and assumptions as its title. It stands for one of: `result`, a provenance envelope (utilities/provenance.js); `rule`, a registered rule id, with the rule's verification as the status; or `status`, a bare status, as a legend entry gives it. `label` adds the status as a word beside the icon.
export default {
  name: 'ProvenanceMark',
  props: {
    result: {
      type: Object,
      default: null,
    },
    rule: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      default: '',
    },
    label: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    kind() {
      return this.result ? this.result.status : this.rule ? (getRule(this.rule) || {}).verification : this.status
    },
    mark() {
      return STATUS_MARKS[this.kind] || null
    },
    text() {
      return this.result ? describeResult(this.result) : this.rule ? describeRule(this.rule) : this.mark ? this.mark.meaning : ''
    },
  },
}
</script>

<style lang="scss" scoped>
.provenance-mark {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  vertical-align: middle;
  opacity: 0.75;
  cursor: help;
}

.provenance-mark__label {
  font-size: 0.75rem;
}
</style>
