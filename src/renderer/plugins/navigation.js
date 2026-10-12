import { needsRace } from '../utilities/navigation'

let acted = false

// Whether the user has pressed a key or a pointer button since the route, the save, the game or the race last changed. A page's focus that moves then is the user's doing and a step in the history; one that moves before is the page settling on the route it opened on or on the data it now shows (mixins/deep-link.js).
export const userActed = () => acted

// Feeds every route change into the navigation history store (store/navigation.js), and sends the pages that show a race's data to the Empires page until a game and race are picked, the page the app starts on included.
export default ({ router, store }) => {
  router.beforeEach((to, _from, next) => {
    next(store.getters.RaceID || !needsRace(to.path) ? undefined : '/')
  })

  router.afterEach((to) => {
    acted = false
    store.commit('navigation/settle', to.fullPath)
  })

  // A new save, game or race moves a page's focus by itself (a race's own systems, colonies or commanders). Sync, so it lands before the pages' watchers move it.
  store.watch((state) => [state.database, state.GameID, state.RaceID], () => {
    acted = false
  }, { sync: true })

  // A replace updates the current history entry rather than adding one. Like the app's push (app/router.js) it always gets callbacks, so it returns no promise to reject when the location is the one already open.
  const replace = router.replace.bind(router)

  router.replace = (location, onComplete = () => {}, onAbort = () => {}) => {
    store.commit('navigation/expectReplace', true)
    replace(location, onComplete, (error) => {
      store.commit('navigation/expectReplace', false)
      onAbort(error)
    })
  }

  // Captured before any handler runs, so a key or click that navigates is counted before the route changes.
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => {
      acted = true
    }, true)
  }
}
