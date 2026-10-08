import path from 'path'
import { URL, pathToFileURL } from 'url'

import { app, Menu, net, protocol } from 'electron'

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
    // Downloaded on first use; offline, the app runs without it.
    import('electron-devtools-installer')
      .then(({ installExtension, VUEJS_DEVTOOLS }) => installExtension(VUEJS_DEVTOOLS))
      .catch((error) => console.log(`Vue devtools not installed: ${error.message}`))
  })
} else {
  // The scheme must be registered before the app is ready.
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { secure: true, standard: true } }])

  app.once('ready', () => {
    // The URL's path is already resolved, so it stays inside RENDERER_DIR (which may be inside app.asar).
    protocol.handle(APP_SCHEME, (request) => net.fetch(pathToFileURL(path.join(RENDERER_DIR, new URL(request.url).pathname)).toString()))

    Menu.setApplicationMenu(null)
  })
}
