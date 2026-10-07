<template>
  <a :href="href" class="external-link" @click.prevent="open"><slot>{{ href }}</slot></a>
</template>

<script>
import { shell } from 'electron'

// A plain link would open a new app window in Electron, so hand it to the system browser (web mode's shim uses window.open).
export default {
  props: {
    href: {
      type: String,
      required: true,
    },
  },
  methods: {
    open () {
      shell.openExternal(this.href)
    },
  },
}
</script>

<style lang="scss" scoped>
.external-link {
  color: var(--ae-primary);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
</style>
