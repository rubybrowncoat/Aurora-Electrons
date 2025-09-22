/**
 * By default, Nuxt.js is configured to cover most use cases.
 * This default configuration can be overwritten in this file
 * @link {https://nuxtjs.org/guide/configuration/}
 */

module.exports = {
  ssr: false,
  target: 'static',
  head: {
    title: 'Aurora Electrons',
    meta: [{ charset: 'utf-8' }],
  },
  loading: false,
  plugins: [
    { ssr: true, src: '@/plugins/async-computed.js' },
    { ssr: true, src: '@/plugins/icons.js' },
    { ssr: true, src: '@/plugins/vuetify.js' },

    { ssr: false, src: '@/plugins/database.js' },
  ],
  buildModules: [
    '@nuxt/typescript-build',
  ],
  modules: [
    '@nuxtjs/vuetify',
    '@nuxtjs/sentry',
  ],
  vuetify: {
    theme: {
      themes: {
        light: {
          primary: '#1867c0',
          secondary: '#b0bec5',
          accent: '#8c9eff',
          error: '#b71c1c',
        },
      },
    },
  },
  sentry: {
    dsn: 'https://8e243eff808fce8ae2da2b27f6eb4ff5@o237971.ingest.us.sentry.io/4510024176893952',
  },
}
