<template>
  <section class="reference" :data-preset-reference="appearance.id" :aria-label="`${appearance.name}: reference and changes`">
    <div class="reference__head">
      <span class="body-2 font-weight-medium">{{ appearance.name }}</span>
      <span class="caption text--secondary">version {{ appearance.version }}</span>
    </div>
    <div class="body-2">{{ reference.title }}. {{ reference.summary }}</div>

    <div class="reference__label caption text--secondary">Reference values</div>
    <ul class="reference__roles">
      <li v-for="role in reference.roles" :key="role.role" class="reference__role">
        <span class="reference__swatch" :style="{ backgroundColor: role.value }" aria-hidden="true" />
        <span><span class="font-weight-medium">{{ role.role }}</span> <code>{{ role.value }}</code><span class="text--secondary"> · {{ role.maps }}</span></span>
      </li>
    </ul>

    <div class="reference__label caption text--secondary">What the adaptation changes</div>
    <ul class="reference__list">
      <li v-for="item in reference.modifications" :key="item">{{ item }}</li>
    </ul>

    <div class="reference__label caption text--secondary">Provenance</div>
    <div class="caption">
      Inspired by the <external-link :href="source.repository">{{ source.name }}</external-link> by {{ source.author }}, revision <code>{{ source.revision.slice(0, 7) }}</code> of {{ source.revisionDate }}, under the {{ source.license }}. {{ source.inspected }} {{ source.copied }} {{ source.note }} The notice is in About, under Credits.
    </div>
  </section>
</template>

<script>
import ExternalLink from '../ExternalLink.vue'

// The explanation of a preset that adapts a reference: what it looks like, which reference values it takes and where it puts them, what the adaptation changes and where the reference comes from. `appearance` is a resolved appearance with a `reference` (`resolveAppearance`); everything shown is that preset's own metadata, so nothing here is written twice.
export default {
  name: 'PresetReference',
  components: { ExternalLink },
  props: {
    appearance: { type: Object, required: true },
  },
  computed: {
    reference() {
      return this.appearance.reference
    },

    source() {
      return this.appearance.reference.source
    },
  },
}
</script>

<style lang="scss" scoped>
.reference {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--ae-border);
  border-radius: 6px;
}

.reference__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.reference__label {
  margin-top: 6px;
}

.reference__roles,
.reference__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.reference__roles {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.reference__role {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: calc(13px * var(--ae-font-scale));
}

.reference__swatch {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border: 1px solid var(--ae-ink);
  border-radius: 3px;
}

.reference__list {
  font-size: calc(13px * var(--ae-font-scale));

  li + li {
    margin-top: 4px;
  }
}
</style>
