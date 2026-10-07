// The routes both smoke tests visit by default: every page in the navigation registry
// (src/renderer/utilities/navigation.js), settings last. Hidden pages such as /engines are opt-in
// through SMOKE_PAGES, and planned pages have no page to visit.
const { PAGES } = require('../src/renderer/utilities/navigation')

const visible = PAGES.filter((page) => !page.hidden && !page.planned)

module.exports = [...visible.filter((page) => page.section), ...visible.filter((page) => !page.section)].map((page) => page.route)
