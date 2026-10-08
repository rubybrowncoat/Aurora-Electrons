// `electron` in the renderer: the parts src/preload/index.js hands over.
export const { ipcRenderer, shell } = window.__aurora.electron

export default window.__aurora.electron
