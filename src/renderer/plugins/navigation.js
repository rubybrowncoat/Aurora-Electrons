import { needsRace } from '../utilities/navigation'

// Feeds every route change into the navigation history store (store/navigation.js), and sends the pages that show
// a race's data to the Empires page until a game and race are picked, the page the app starts on included.
export default ({ router, store }) => {
  router.beforeEach((to, _from, next) => {
    next(store.getters.RaceID || !needsRace(to.path) ? undefined : '/')
  })

  router.afterEach((to) => {
    store.commit('navigation/settle', to.fullPath)
  })

  // A replace updates the current history entry rather than adding one. Like the app's push (app/router.js) it always
  // gets callbacks, so it returns no promise to reject when the location is the one already open.
  const replace = router.replace.bind(router)

  router.replace = (location, onComplete = () => {}, onAbort = () => {}) => {
    store.commit('navigation/expectReplace', true)
    replace(location, onComplete, (error) => {
      store.commit('navigation/expectReplace', false)
      onAbort(error)
    })
  }
}
