// @xpda-dev/core stops Electron and Nuxt with ps-tree, which lists child processes through
// wmic.exe. Recent Windows 11 builds no longer ship wmic, so closing or relaunching Electron
// crashed `yarn dev` and left its processes running. taskkill stops a whole tree by itself.
// Required before anything that reads `utils.killWithAllSubProcess`, since they copy it on load.
const { execFile } = require('child_process')
const killProcess = require('@xpda-dev/core/lib/utils/killProcess')

if (process.platform === 'win32') {
  killProcess.killWithAllSubProcess = (pid) => new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
  })
}
