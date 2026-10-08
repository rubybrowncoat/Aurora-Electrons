import path from 'path'
import { URL } from 'url'

import { app, Menu, protocol } from 'electron'

// Set by `yarn dev` (electron-vite) to its dev server. Without it, the renderer is the build in out/renderer, served
// through the app:// scheme.
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL
const APP_SCHEME = 'app'
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')

export const RENDERER_URL = DEV_SERVER_URL || `${APP_SCHEME}://./index.html`

if (DEV_SERVER_URL) {
  app.once('browser-window-created', (_event, browserWindow) => {
    browserWindow.webContents.once('did-frame-finish-load', () => browserWindow.webContents.openDevTools())
  })

  app.once('ready', () => {
    // Downloaded on first use; offline, the app runs without it. The import hands over the CommonJS exports object
    // as `default`, and the installer's own default export is in it.
    import('electron-devtools-installer')
      .then(({ default: { default: installExtension, VUEJS_DEVTOOLS } }) => installExtension(VUEJS_DEVTOOLS))
      .catch((error) => console.log(`Vue devtools not installed: ${error.message}`))
  })
} else {
  // The scheme must be registered before the app is ready.
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { secure: true, standard: true } }])

  app.once('ready', () => {
    protocol.registerFileProtocol(APP_SCHEME, (request, callback) => {
      // eslint-disable-next-line node/no-callback-literal -- Electron's protocol callback takes the response, not an error.
      callback({ path: path.join(RENDERER_DIR, path.normalize(new URL(request.url).pathname)) })
    })

    Menu.setApplicationMenu(null)
  })
}
