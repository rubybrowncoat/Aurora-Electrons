<template>
  <div class="avoid-options">
    <v-menu offset-y left :close-on-content-click="false" max-width="420">
      <template #activator="{ on, attrs }">
        <v-btn outlined small aria-label="Avoid settings" v-bind="attrs" v-on="on"><v-icon small left>mdi-shield-alert-outline</v-icon>Avoid<span v-if="count">&nbsp;({{ count }})</span></v-btn>
      </template>
      <v-card class="pa-4">
        <div class="subtitle-2">Systems the route keeps out of</div>
        <v-checkbox v-for="option in options" :key="option.key" :input-value="settings[option.key]" dense hide-details @change="(value) => $emit('change', option.key, value)">
          <template #label>
            <div>
              <div class="body-2">{{ option.label }}</div>
              <div class="caption text--secondary">{{ option.hint }}</div>
            </div>
          </template>
        </v-checkbox>
        <div class="caption text--secondary mt-2">Danger and control are what the race knows. The system a run starts in is never kept out of.</div>
      </v-card>
    </v-menu>
  </div>
</template>

<script>
// The avoid preferences of a page that plans runs: a menu of one checkbox each, off by default. `settings` is { [key]: boolean } and `change(key, value)` is emitted for a click; the page keeps the values (mixins/avoid-routes.js).
export default {
  name: 'AvoidOptions',
  props: {
    options: {
      type: Array,
      required: true,
    },
    settings: {
      type: Object,
      required: true,
    },
    count: {
      type: Number,
      default: 0,
    },
  },
}
</script>
