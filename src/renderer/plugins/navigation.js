// Feeds every route change into the navigation history store (store/navigation.js).
export default ({ app, store }) => {
  app.router.afterEach((to) => {
    store.commit('navigation/settle', to.fullPath)
  })
}
