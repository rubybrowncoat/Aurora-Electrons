const { Nuxt, Builder, Generator } = require('nuxt')
const { SERVER_PORT } = require('../config')
const nuxtConfig = require('./nuxt.config.js')

const nuxt = new Nuxt(nuxtConfig)

// Nuxt's server and watchers would keep this process alive after `yarn dev` exits.
process.on('disconnect', () => process.exit())

process.on('message', async ({ action, target }) => {
  if (action !== 'build') {
    console.warn('Unknown action')
    process.send({ status: 'error', err: `Nuxt process: unknown action ('${action}')` })
    return
  }

  await nuxt.ready()

  // https://github.com/nuxt/nuxt.js/blob/dev/packages/builder/src/builder.js
  const builder = new Builder(nuxt)

  // https://github.com/nuxt/nuxt.js/blob/dev/packages/generator/src/generator.js
  const generator = new Generator(nuxt, builder)

  if (target === 'development') {
    builder.build().then(() => nuxt.listen(SERVER_PORT)).then(async () => {
      // Nuxt falls back to a random port when SERVER_PORT is taken, but the main process is built
      // to load SERVER_PORT, so Electron would show whatever else answers there.
      const { port } = new URL(nuxt.server.listeners[0].url)

      if (port !== String(SERVER_PORT)) {
        await nuxt.close()
        throw new Error(`Port ${SERVER_PORT} is in use (another \`yarn dev\` or \`yarn web\`?). Stop it, or run with PORT=<free port>.`)
      }

      process.send({ status: 'ok' })
    }).catch(err => {
      console.error(err)
      process.send({ status: 'error', err: err.message })
    })
  } else {
    generator.generate({ build: true, init: true }).then(({ errors }) => {
      if (errors.length === 0) process.send({ status: 'ok' })
      else process.send({ status: 'error', err: 'Error occurred while generating pages' })
    }).catch(err => {
      console.error(err)
      process.send({ status: 'error', err: err.message })
    })
  }
})
