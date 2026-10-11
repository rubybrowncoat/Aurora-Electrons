// Whether the page on screen is still loading, for both smoke tests to wait on; it runs in the page. A read the save already answered comes from memory without a database call, so a page can still be working with no call in flight: one of its async-computed reads is updating, or it shows a progress bar while it works out what it read.
module.exports = () => {
  const match = window.$app.$route.matched[0]
  const page = match && match.instances.default

  if (!page) {
    return true
  }

  const updating = Object.values(page.$asyncComputed || {}).some((state) => state.updating)
  const working = [...document.querySelectorAll('.v-main .v-progress-linear')].some((bar) => bar.offsetParent && bar.querySelector('.v-progress-linear__indeterminate--active'))

  return updating || working
}
