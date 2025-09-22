import BrowserWinHandler from './BrowserWinHandler'

const winHandler = new BrowserWinHandler({
  height: 800,
  width: 1200,

  webPreferences: {
    enableRemoteModule: true,
  },
})

winHandler.onCreated((_browserWindow) => {
  winHandler.loadPage('/')
  // Or load custom url
  // _browserWindow.loadURL('https://google.com')
})

export default winHandler
