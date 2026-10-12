<template>
  <!-- Vuetify activates a row on Enter or a click, even from a child link; the link keeps both to itself. -->
  <v-btn icon x-small :to="to" :style="{ color: 'inherit' }" :aria-label="text" :title="text" @click.stop @keydown.native.stop>
    <v-icon small>{{ page.icon }}</v-icon>
  </v-btn>
</template>

<script>
import { pageByRoute } from '../../utilities/navigation'

// A small icon link to another page, `to` from utilities/deep-links.js `linkTo`, with that page's icon and a title naming the page and what it opens on.
export default {
  props: {
    to: {
      type: Object,
      required: true,
    },
    name: {
      type: String,
      default: '',
    },
  },
  computed: {
    page () {
      return pageByRoute[this.to.path]
    },
    text () {
      return this.name ? `${this.page.title}: ${this.name}` : this.page.title
    },
  },
}
</script>
