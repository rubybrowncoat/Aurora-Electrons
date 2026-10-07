import { needsRace } from '../utilities/navigation'

// Feeds every route change into the navigation history store (store/navigation.js), and keeps the pages that show
// a race's data closed until a game and race are picked. The page the app starts on stays: the layout shows the picker over it.
export default ({ app, store }) => {
  app.router.beforeEach((to, from, next) => {
    const starting = from.name === null

    next(starting || store.getters.RaceID || !needsRace(to.path) ? undefined : false)
  })

  app.router.afterEach((to) => {
    store.commit('navigation/settle', to.fullPath)
  })
}
