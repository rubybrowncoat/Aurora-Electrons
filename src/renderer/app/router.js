import Vue from 'vue'
import VueRouter from 'vue-router'

Vue.use(VueRouter)

// One route per file in pages/, named after it, and pages/index.vue at `/`. Each page loads on first visit.
const routes = Object.entries(import.meta.glob('../pages/*.vue')).map(([file, component]) => {
  const name = file.match(/([^/]+)\.vue$/)[1]

  return { path: name === 'index' ? '/' : `/${name}`, name, component }
})

const router = new VueRouter({
  mode: 'hash',
  routes: [...routes, { path: '*', redirect: '/' }],
  // Back and forward return to where the page was; anything else starts at the top.
  scrollBehavior: (_to, _from, savedPosition) => savedPosition || { x: 0, y: 0 },
})

// A push without callbacks returns a promise that rejects when the navigation is redirected or aborted (the race guard
// in plugins/navigation.js, or the page already open), so every push gets a no-op completion callback and returns none.
const push = router.push.bind(router)

router.push = (location, onComplete = () => {}, onAbort) => push(location, onComplete, onAbort)

export default router
