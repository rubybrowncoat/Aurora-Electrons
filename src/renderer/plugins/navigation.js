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
}
