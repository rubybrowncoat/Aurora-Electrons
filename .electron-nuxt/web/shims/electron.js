// Web mode stand-in for `electron` in the renderer: answers the IPC calls
// src/main/index.js would handle.

const downloadPng = (base64, fileName) => {
  const link = document.createElement('a')
  link.href = `data:image/png;base64,${base64}`
  link.download = fileName
  link.click()
}

export const ipcRenderer = {
  invoke (channel, ...args) {
    switch (channel) {
      case 'request-storage-path': {
        return Promise.resolve('AuroraDB.db')
      }
      case 'read-flag': {
        // Web mode has no Aurora folder beside the save, so every race shows its initials.
        return Promise.resolve(null)
      }
      case 'save-png': {
        const [imageData, filePath] = args

        downloadPng(imageData, filePath)

        return Promise.resolve({ canceled: false, filePath })
      }
      default: {
        return Promise.reject(new Error(`[web] Unhandled IPC channel: ${channel}`))
      }
    }
  },
}

export const shell = {
  openExternal: (url) => window.open(url, '_blank', 'noopener'),
}

export const remote = {}

export default { ipcRenderer, remote, shell }
