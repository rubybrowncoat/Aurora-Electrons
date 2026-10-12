// What both smoke tests ask the page on screen; both run in the page. A read the save already answered comes from memory without a database call, so a page can still be working with no call in flight: one of its async-computed reads is updating, or it shows a progress bar while it works out what it read.
const pageLoading = () => {
  const match = window.$app.$route.matched[0]
  const page = match && match.instances.default

  if (!page) {
    return true
  }

  const updating = Object.values(page.$asyncComputed || {}).some((state) => state.updating)
  const working = [...document.querySelectorAll('.v-main .v-progress-linear')].some((bar) => bar.offsetParent && bar.querySelector('.v-progress-linear__indeterminate--active'))

  return updating || working
}

// Whether the router has committed the route asked for (a path, with or without a query) and its page is mounted. A page loads on its first visit and the router's push returns no promise, so until then the route and page on screen are the previous ones, and they already count as settled.
pageLoading.arrived = (target) => {
  const route = window.$app.$route
  const match = route.matched[0]
  const page = match && match.instances.default

  return route.path === target.split(/[?#]/)[0] && Boolean(page && page.$el && page.$el.isConnected)
}

module.exports = pageLoading
