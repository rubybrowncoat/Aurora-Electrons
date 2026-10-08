// The page registry: one row per route. The layout (rail, flyout, tabs, breadcrumb, Ctrl+K palette,
// titles) and the smoke tests' page list (scripts/smoke-pages.js) all read from here.

// `slot` indexes `chartTheme(dark).categorical` in components/charts/theme.js.
const SECTIONS = [
  { id: 'command', title: 'Command', icon: 'mdi-view-dashboard-outline', slot: 0 },
  { id: 'economy', title: 'Economy', icon: 'mdi-pickaxe', slot: 1 },
  { id: 'colonies', title: 'Colonies', icon: 'mdi-home-group', slot: 2 },
  { id: 'logistics', title: 'Logistics', icon: 'mdi-truck-fast-outline', slot: 3 },
  { id: 'galaxy', title: 'Galaxy', icon: 'mdi-orbit', slot: 6 },
  { id: 'exploration', title: 'Exploration', icon: 'mdi-telescope', slot: 7 },
  { id: 'empire', title: 'Empire', icon: 'mdi-shield-crown-outline', slot: 4 },
  { id: 'research', title: 'Research', icon: 'mdi-flask-outline', slot: 5 },
]

// `tab` labels the page in its section's tab strip. `requiresHistory` pages are disabled while the
// selected race isn't recorded. `hidden` pages keep a title but appear in no navigation, palette or
// default smoke list. `noRace` pages (Empires, Settings, About) work before a game and race are picked; every other page
// shows the selected race's data, so it can't be opened until one is. `planned` pages have no page file yet: the section flyout lists them dimmed with a
// "Planned" chip, and they are never navigable and appear in no tabs, palette, history or smoke list.
// Pages within a section appear in this order. `/`, the Empires page, is where the app starts.
const PAGES = [
  { route: '/production', section: 'command', tab: 'Production', title: 'Production Recap', icon: 'mdi-factory', blurb: 'Research, industry, shipyards and training, each with its time left.', keywords: 'research industry shipyard queue terraforming' },
  { route: '/warnings', section: 'command', tab: 'Warnings', title: 'Warnings', icon: 'mdi-alert-octagon-outline', blurb: 'About 40 checks over contacts, economy, ships, fleets and colonies.', keywords: 'alerts idle fleets damaged ships intruders lifepods' },
  { route: '/log', section: 'command', tab: 'Log', title: 'Game Log', icon: 'mdi-script-text-outline', blurb: 'The full event log, filtered and coloured by event type.', keywords: 'events' },
  { route: '/minerals', section: 'economy', tab: 'Minerals', title: 'Mineral Breakdown', icon: 'mdi-diamond-stone', blurb: 'Where your minerals are: deposits to mine, and stock against reserves and queues in each colony.', keywords: 'deposits mining duranium cmc reserve stockpile mass driver orbital untapped' },
  { route: '/mineral-outlook', section: 'economy', tab: 'Outlook', title: 'Mineral Outlook', icon: 'mdi-chart-timeline-variant', blurb: 'Stock, output and use per mineral, with years of runway left.', keywords: 'runway depletion forecast' },
  { route: '/finances', section: 'economy', tab: 'Finances', title: 'Finances', icon: 'mdi-cash-multiple', blurb: 'Wealth income and spending by category over the last year.', keywords: 'wealth money treasury' },
  { route: '/shipyards', section: 'economy', tab: 'Shipyards', title: 'Shipyard Planner', icon: 'mdi-hammer-wrench', blurb: 'Yard growth, slipways and build queues.', planned: true },
  { route: '/colony-outlook', section: 'colonies', tab: 'Outlook', title: 'Colony Outlook', icon: 'mdi-city-variant-outline', blurb: 'Growth, capacity and the worker split per colony over a horizon.', keywords: 'population growth workers infrastructure' },
  { route: '/habitability', section: 'colonies', tab: 'Colonization', title: 'Colonization Planner', icon: 'mdi-rocket-launch-outline', blurb: 'Where to settle next, for which species, and what it takes: colony cost, terraforming, capacity, minerals and distance.', keywords: 'habitability colonization targets colony cost terraforming species capacity minerals settle' },
  { route: '/logistics', section: 'logistics', tab: 'Fuel & MSP', title: 'Fuel & Maintenance', icon: 'mdi-fuel', blurb: 'Fuel stock, burn and Sorium cover; maintenance supply and how long it lasts.', keywords: 'logistics fuel msp sorium refinery harvester tankers fleets ships supply' },
  { route: '/hauling', section: 'logistics', tab: 'Hauling', title: 'Hauling Planner', icon: 'mdi-transit-connection-variant', blurb: 'Repeating freight routes, cycle times and cargo moved.', keywords: 'freight cargo routes cycling fleets freighters' },
  { route: '/information', section: 'logistics', tab: 'Transport', title: 'Transport Capacity', icon: 'mdi-swap-horizontal-bold', blurb: 'Freight and colonist capacity, plus civilian work orders.', keywords: 'information civilian shipping colonists' },
  { route: '/map', section: 'galaxy', tab: 'Map', title: 'Galaxy Map', icon: 'mdi-map-marker-path', blurb: 'Known systems, jump points, sectors and survey state.', wip: true, keywords: 'jump points sectors' },
  { route: '/intelligence', section: 'galaxy', tab: 'Intelligence', title: 'Intelligence', icon: 'mdi-incognito', blurb: 'What you know of every alien race you have met.', requiresHistory: true, keywords: 'aliens diplomacy treaties' },
  { route: '/survey-progress', section: 'exploration', tab: 'Survey', title: 'Survey Progress', icon: 'mdi-radar', blurb: 'Survey work left per system, and what survey fleets are doing.', keywords: 'geological gravitational survey fleets ships' },
  { route: '/routes', section: 'exploration', tab: 'Routes', title: 'Route Finder & Distances', icon: 'mdi-sign-direction', blurb: 'The shortest jump route between two places, leg by leg with the travel time, and how far away every known system is.', keywords: 'route path distance jumps travel time capital jump points lagrange' },
  { route: '/lagrange', section: 'exploration', tab: 'Lagrange', title: 'Lagrange Points', icon: 'mdi-vector-triangle', blurb: 'Stable Lagrange points in known systems, and how long stabilising the other planets and moons would take.', keywords: 'lagrange points stabilise stabilize gas giants intra-system jump' },
  { route: '/history', section: 'empire', tab: 'History', title: 'Empire History', icon: 'mdi-chart-line', blurb: 'Snapshots the app records each save: population, wealth, fleet, research.', requiresHistory: true, keywords: 'snapshots trends rivals' },
  { route: '/commanders', section: 'empire', tab: 'Commanders', title: 'Commanders', icon: 'mdi-account-tie', blurb: 'The roster with bonuses, and better assignments for governors and officers.', keywords: 'officers governors scientists' },
  { route: '/technologies', section: 'research', tab: 'Tech Tree', title: 'Tech Tree', icon: 'mdi-file-tree', blurb: 'What to research next: available techs by field, tech lines, prerequisite paths and when projects land.', keywords: 'technologies research projects prerequisites queue' },
  { route: '/designed-tech', section: 'research', tab: 'Designed', title: 'Designed Tech', icon: 'mdi-atom', blurb: 'Your designed components by category.', wip: true, keywords: 'components engines' },
  { route: '/engines', section: null, tab: 'Engines', title: 'Engine Planner', icon: 'mdi-engine-outline', blurb: 'Engine design inputs and thrust.', hidden: true, keywords: 'engine thrust' },
  { route: '/', section: null, tab: 'Empires', title: 'Empires', noRace: true, icon: 'mdi-flag-variant-outline', blurb: 'Every game in the save and its empires: pick the one the other pages show.', keywords: 'games races pick select switch' },
  { route: '/settings', section: null, tab: 'Settings', title: 'Settings', noRace: true, icon: 'mdi-wrench', blurb: 'NPR visibility, number format, CMC minerals and maintenance thresholds.', keywords: 'preferences options' },
  { route: '/about', section: null, tab: 'About', title: 'About', noRace: true, icon: 'mdi-information-outline', blurb: 'Version, license, links, how to contribute and where your data lives.', keywords: 'version license github forum feedback credits contribute help' },
]

// The forum thread for updates and feedback. The About page links to it while this is set, and says "coming soon" while it is empty.
const FORUM_URL = 'https://aurora4x.com/t/aurora-electrons-looking-inwards-v0-9-14/1177'

const sectionById = Object.fromEntries(SECTIONS.map((section) => [section.id, section]))
const pageByRoute = Object.fromEntries(PAGES.map((page) => [page.route, page]))

// Whether a path (a route with or without a query) shows a race's data, so it waits until a game and race are picked.
const needsRace = (path) => {
  const page = pageByRoute[path.split('?')[0]]

  return !(page && page.noRace)
}

export { SECTIONS, PAGES, FORUM_URL, sectionById, pageByRoute, needsRace }
