import { ipcRenderer } from 'electron'

// The save the window shows and the ones opened before it, as the main process keeps them (src/main/saves.js): `active` is { path, state, reason } for the save now shown, `recent` the saves opened most recently, newest first, each with the state of its file as it was last checked ('available' or 'unavailable' with the `reason`), and whether it is the active one or is open in another window. `busy` is set while a request is out, the open dialog included, and `notice` is what the latest one ended in when it needs saying: { tone, text, retry } (`retry` the path to try again).
export const state = () => {
  return {
    active: null,
    recent: [],
    limit: 0,
    error: null,
    loaded: false,
    busy: false,
    notice: null,
  }
}

const messageOf = (error) => String((error && error.message) || error).split(/\r?\n/)[0]

const clause = (reason) => String(reason || 'the reason is not known')

// What a request's answer says to the person who made it, or null when it changed nothing and needs no word (the open dialog closed).
export const noticeOf = (result) => {
  switch (result.action) {
    case 'switched':
      return { tone: 'success', text: `Showing ${result.path}.`, retry: null }
    case 'unchanged':
      return { tone: 'info', text: 'That save is the one already shown.', retry: null }
    case 'focused':
      return { tone: 'warning', text: `${result.path} is already open in another window, which is now in front. This window keeps showing ${result.active}.`, retry: null }
    case 'unavailable':
      return { tone: 'error', text: `Couldn't open ${result.path || 'that save'}: ${clause(result.reason)}. This window keeps showing ${result.active}.`, retry: result.path || null }
    case 'gone':
      return { tone: 'error', text: 'The window is closing, so nothing was opened.', retry: null }
    default:
      return null
  }
}

export const mutations = {
  loaded (state, { active, recent, limit, error }) {
    state.active = active
    state.recent = recent
    state.limit = limit
    state.error = error
    state.loaded = true
  },
  failed (state, message) {
    state.error = message
  },
  busy (state, busy) {
    state.busy = busy
  },
  notice (state, notice) {
    state.notice = notice
  },
  // The window shows another save: the notice was about the one it left.
  reset (state) {
    state.active = null
    state.recent = []
    state.notice = null
    state.loaded = false
  },
}

// Reads are numbered, so one overtaken by a newer read is dropped.
let latest = 0

export const actions = {
  // The active save and the recent ones, with each file checked now. Never rejects.
  async load ({ commit }) {
    const read = ++latest

    try {
      const answer = await ipcRenderer.invoke('saves:state')

      if (read === latest) {
        commit('loaded', answer)
      }
    } catch (error) {
      if (read === latest) {
        commit('failed', messageOf(error))
      }
    }
  },

  // The open dialog of the main process, then the save it chose. Closing it changes nothing.
  choose (context) {
    return request(context, () => ipcRenderer.invoke('saves:choose'))
  },

  // The save at `path`, from the recent list or an earlier failure (a retry).
  select (context, path) {
    return request(context, () => ipcRenderer.invoke('saves:select', path))
  },

  // Takes a save off the recent list.
  async forget ({ dispatch }, path) {
    try {
      await ipcRenderer.invoke('saves:forget', path)
    } catch (error) {
      console.error("Couldn't forget the save", error)
    }

    return dispatch('load')
  },
}

// One request at a time. The main process decides; when it moved this window to another save, the store opens that save (`openSave` of the root store) before anything else reads. Never rejects: what went wrong is the notice.
const request = async ({ commit, dispatch, state }, send) => {
  if (state.busy) {
    return { ok: true, action: 'busy' }
  }

  commit('busy', true)

  try {
    const result = await send()

    if (result.action === 'switched') {
      dispatch('openSave', { path: result.path }, { root: true })
      commit('reset')
    }

    commit('notice', noticeOf(result))
    dispatch('load')

    return result
  } catch (error) {
    console.error("Couldn't change the save", error)
    commit('notice', { tone: 'error', text: `The save could not be changed: ${messageOf(error)}`, retry: null })

    return { ok: false, action: 'failed', reason: messageOf(error) }
  } finally {
    commit('busy', false)
  }
}
