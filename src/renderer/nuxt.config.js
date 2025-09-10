/**
 * By default, Nuxt.js is configured to cover most use cases.
 * This default configuration can be overwritten in this file
 * @link {https://nuxtjs.org/guide/configuration/}
 */

const { resolve } = require('path')

module.exports = {
  ssr: false,
  head: {
    title: 'Aurora Electrons',
    meta: [{ charset: "utf-8" }]
  },
  loading: false,
  router: {
    linkActiveClass: 'is-active',
  },
  plugins: [
    { ssr: true, src: '@/plugins/async-computed.js' },
    { ssr: true, src: '@/plugins/icons.js' },

    { ssr: false, src: '@/plugins/database.js' },
  ],
  buildModules: [
    '@nuxtjs/vuetify',
  ],
  modules: [
    // 
  ],
};
