<template>
  <v-avatar class="empire-avatar" :size="size" rounded :color="src ? 'transparent' : color">
    <img v-if="src" :src="src" :alt="race.RaceTitle">
    <span v-else-if="race" class="empire-avatar__initials white--text">{{ initials }}</span>
    <v-icon v-else dark>mdi-tooltip-account</v-icon>
  </v-avatar>
</template>

<script>
import { flagUrl } from '../../utilities/flags'
import { hashColor } from '../../utilities/color'

// A race's flag, or its initials on a colour taken from its title when the flag file isn't there. Without a race, an icon.
export default {
  props: {
    race: {
      type: Object,
      default: null,
    },
    size: {
      type: Number,
      default: 36,
    },
  },
  data () {
    return {
      src: null,
    }
  },
  computed: {
    initials () {
      return this.race.RaceTitle.split(/\s+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || '?'
    },
    color () {
      return this.race ? hashColor(this.race.RaceTitle, this.$vuetify.theme.dark) : 'primary'
    },
    flag () {
      return this.race ? this.race.FlagPic : null
    },
  },
  watch: {
    flag: {
      immediate: true,
      async handler (name) {
        this.src = null

        if (name) {
          const src = await flagUrl(name)

          if (this.flag === name) {
            this.src = src
          }
        }
      },
    },
  },
}
</script>

<style lang="scss" scoped>
.empire-avatar {
  flex: none;
  font-weight: 500;
  letter-spacing: .04em;

  img {
    object-fit: cover;
  }
}
</style>
