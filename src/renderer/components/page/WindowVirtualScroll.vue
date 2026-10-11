<template>
  <div class="window-virtual-scroll" :style="{ height: `${items.length * itemHeight}px` }">
    <div v-for="index in shown" :key="index" class="window-virtual-scroll__item" :style="{ top: `${index * itemHeight}px`, height: `${itemHeight}px` }">
      <slot :item="items[index]" :index="index" />
    </div>
  </div>
</template>

<script>
// Rows of one height that the page itself scrolls, as tall as all of them, rendering only those in or near the window: Vuetify's v-virtual-scroll without a scroller of its own.
export default {
  props: {
    items: {
      type: Array,
      required: true,
    },
    itemHeight: {
      type: Number,
      required: true,
    },
    // Rows rendered past each edge of the window.
    bench: {
      type: Number,
      default: 4,
    },
  },
  data () {
    return {
      first: 0,
      last: -1,
    }
  },
  computed: {
    shown () {
      const last = Math.min(this.last, this.items.length - 1)

      return Array.from({ length: Math.max(0, last - this.first + 1) }, (_, offset) => this.first + offset)
    },
  },
  mounted () {
    window.addEventListener('scroll', this.measure, { passive: true })
    window.addEventListener('resize', this.measure)
    // The list moves without a scroll when anything above it changes height, and grows or shrinks with its rows; either changes the document's height.
    this.observer = new ResizeObserver(() => this.measure())
    this.observer.observe(document.documentElement)
    this.measure()
  },
  beforeDestroy () {
    window.removeEventListener('scroll', this.measure)
    window.removeEventListener('resize', this.measure)
    this.observer.disconnect()
  },
  methods: {
    // The rows between the window's top and bottom edges, from where the list sits now.
    measure () {
      const { top } = this.$el.getBoundingClientRect()

      this.first = Math.max(0, Math.floor(-top / this.itemHeight) - this.bench)
      this.last = Math.ceil((window.innerHeight - top) / this.itemHeight) + this.bench
    },
  },
}
</script>

<style lang="scss" scoped>
.window-virtual-scroll {
  position: relative;
}

.window-virtual-scroll__item {
  position: absolute;
  right: 0;
  left: 0;
}
</style>
