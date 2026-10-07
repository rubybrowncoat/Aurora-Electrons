// The routes both smoke tests visit by default: every page in the navigation registry
// (src/renderer/utilities/navigation.js), settings last. Hidden pages such as /engines are opt-in
// through SMOKE_PAGES.
const { PAGES } = require('../src/renderer/utilities/navigation')

const visible = PAGES.filter((page) => !page.hidden)

module.exports = [...visible.filter((page) => page.section), ...visible.filter((page) => !page.section)].map((page) => page.route)
