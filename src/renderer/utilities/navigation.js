// The page registry: one row per route. The layout (rail, flyout, tabs, breadcrumb, Ctrl+K palette, titles) and the smoke tests' page list (scripts/smoke-pages.js) all read from here.

// `accent` indexes `sections.accents` of the appearance (utilities/appearance.js): the section's colour, which the accent mode (`on`, `restrained`, `off`) may soften or turn off, so a section is also told by its title, its icon and its place in this list. The accents are kept apart from the chart categories.
const SECTIONS = [
  { id: 'command', title: 'Command', icon: 'mdi-view-dashboard-outline', accent: 0 },
  { id: 'economy', title: 'Economy', icon: 'mdi-pickaxe', accent: 1 },
  { id: 'colonies', title: 'Colonies', icon: 'mdi-home-group', accent: 2 },
  { id: 'logistics', title: 'Logistics', icon: 'mdi-truck-fast-outline', accent: 3 },
  { id: 'galaxy', title: 'Galaxy', icon: 'mdi-orbit', accent: 6 },
  { id: 'exploration', title: 'Exploration', icon: 'mdi-telescope', accent: 7 },
  { id: 'empire', title: 'Empire', icon: 'mdi-shield-crown-outline', accent: 4 },
  { id: 'research', title: 'Research', icon: 'mdi-flask-outline', accent: 5 },
  { id: 'design', title: 'Design', icon: 'mdi-pencil-ruler', accent: 8 },
]

// `tab` labels the page in its section's tab strip. `requiresHistory` pages are disabled while the selected race isn't recorded. `hidden` pages keep a title but appear in no navigation, palette or default smoke list. `noRace` pages (Empires, Settings, About) work before a game and race are picked; every other page shows the selected race's data, so it can't be opened until one is. `planned` pages have no page file yet: the section flyout lists them dimmed with a "Planned" chip, and they are never navigable and appear in no tabs, palette, history or smoke list. `wip` pages are built but not finished: the section flyout and the tab strip mark them with a WIP chip, and each opens under a work-in-progress notice (components/page/WipNotice.vue). Pages within a section appear in this order. `/`, the Empires page, is where the app starts.
const PAGES = [
  { route: '/production', section: 'command', tab: 'Production', title: 'Production Recap', icon: 'mdi-factory', blurb: 'Research, industry, shipyards and training, each with its time left.', keywords: 'research industry shipyard queue terraforming' },
  { route: '/warnings', section: 'command', tab: 'Warnings', title: 'Warnings', icon: 'mdi-alert-octagon-outline', blurb: 'Checks over contacts, economy, ships, fleets and colonies.', keywords: 'alerts idle fleets damaged ships intruders lifepods' },
  { route: '/log', section: 'command', tab: 'Log', title: 'Game Log', icon: 'mdi-script-text-outline', blurb: 'The game log, filtered and coloured by event type.', keywords: 'events' },
  { route: '/minerals', section: 'economy', tab: 'Minerals', title: 'Mineral Breakdown', icon: 'mdi-diamond-stone', blurb: 'Deposits to mine, and stock against reserves and queues in each colony.', keywords: 'deposits mining duranium cmc reserve stockpile mass driver orbital untapped' },
  { route: '/mineral-outlook', section: 'economy', tab: 'Outlook', title: 'Mineral Outlook', icon: 'mdi-chart-timeline-variant', blurb: 'Stock, output and use per mineral, with the years of runway left.', keywords: 'runway depletion forecast' },
  { route: '/finances', section: 'economy', tab: 'Finances', title: 'Finances', icon: 'mdi-cash-multiple', blurb: 'Wealth income and spending by category.', keywords: 'wealth money treasury' },
  { route: '/notebook', section: 'economy', tab: 'Notebook', title: 'Project Notebook', icon: 'mdi-notebook-outline', blurb: 'Notes on bodies, colonies, fleets and techs, each with a status and a next action.', keywords: 'notes plans projects tasks todo stale rename' },
  { route: '/colony-outlook', section: 'colonies', tab: 'Outlook', title: 'Colony Outlook', icon: 'mdi-city-variant-outline', blurb: 'Growth, capacity and the worker split per colony over a horizon.', keywords: 'population growth workers infrastructure' },
  { route: '/habitability', section: 'colonies', tab: 'Colonization', title: 'Colonization Planner', icon: 'mdi-rocket-launch-outline', blurb: 'Where to settle next, for which species, and what it takes.', keywords: 'habitability colonization targets colony cost terraforming species capacity minerals settle' },
  { route: '/logistics', section: 'logistics', tab: 'Fuel & MSP', title: 'Fuel & Maintenance', icon: 'mdi-fuel', blurb: 'Fuel stock, burn and Sorium cover, and maintenance supply with how long it lasts.', keywords: 'logistics fuel msp sorium refinery harvester tankers fleets ships supply' },
  { route: '/hauling', section: 'logistics', tab: 'Hauling', title: 'Hauling Planner', icon: 'mdi-transit-connection-variant', blurb: 'The hauls that would cover the colonies\' mineral shortages, and the repeating freight routes.', keywords: 'freight cargo routes cycling fleets freighters plan shortage queue reserve minerals haul' },
  { route: '/information', section: 'logistics', tab: 'Transport', title: 'Transport Capacity', icon: 'mdi-swap-horizontal-bold', blurb: 'Freighter and colony ship capacity between two places, and the civilian work orders.', keywords: 'information freight colonists trips round trip civilian shipping lines work orders installations' },
  { route: '/map', section: 'galaxy', tab: 'Map', title: 'Galaxy Map', icon: 'mdi-map-marker-path', blurb: 'Known systems and jump links, coloured by survey, colonies, sectors or alien control.', keywords: 'jump points sectors arrange grid layout alien control pin save positions' },
  { route: '/intelligence', section: 'galaxy', tab: 'Intelligence', title: 'Intelligence', icon: 'mdi-incognito', blurb: 'What is known of every alien race met.', requiresHistory: true, keywords: 'aliens diplomacy treaties' },
  { route: '/survey-progress', section: 'exploration', tab: 'Survey', title: 'Survey Progress', icon: 'mdi-radar', blurb: 'Survey work left per system, and what survey fleets are doing.', keywords: 'geological gravitational survey fleets ships' },
  { route: '/routes', section: 'exploration', tab: 'Routes', title: 'Route Finder & Distances', icon: 'mdi-sign-direction', blurb: 'The shortest jump route through any number of stops, and the distance to every known system.', keywords: 'route path distance jumps travel time capital jump points lagrange stops waypoints moons cycle' },
  { route: '/lagrange', section: 'exploration', tab: 'Lagrange', title: 'Lagrange Points', icon: 'mdi-vector-triangle', blurb: 'Stable Lagrange points, the time to stabilise more, and the infrastructure at each jump point.', keywords: 'lagrange points stabilise stabilize gas giants intra-system jump gate infrastructure mines minefield buoys probes detected' },
  { route: '/history', section: 'empire', tab: 'History', title: 'Empire History', icon: 'mdi-chart-line', blurb: 'Snapshots the app records from each save: population, wealth, fleet and research.', requiresHistory: true, keywords: 'snapshots trends rivals' },
  { route: '/commanders', section: 'empire', tab: 'Commanders', title: 'Commanders', icon: 'mdi-account-tie', blurb: 'The roster with bonuses, and better assignments for governors and officers.', keywords: 'officers governors scientists' },
  { route: '/technologies', section: 'research', tab: 'Tech Tree', title: 'Tech Tree', icon: 'mdi-file-tree', blurb: 'Available techs by field, tech lines, prerequisite paths and project completion times.', keywords: 'technologies research projects prerequisites queue' },
  { route: '/designed-tech', section: 'research', tab: 'Designed', title: 'Designed Tech', icon: 'mdi-atom', blurb: 'Component designs by category, the classes that mount them, and a side-by-side comparison.', keywords: 'components engines sensors weapons armour compare obsolete unused classes' },
  { route: '/propulsion', section: 'design', tab: 'Propulsion', title: 'Propulsion Planner', wip: true, icon: 'mdi-engine-outline', blurb: 'The engines, thrust, count and fuel that give a hull its speed and range.', keywords: 'engine thrust fuel tanks speed range jump drive propulsion design' },
  { route: '/missile-designer', section: 'design', tab: 'Missiles', title: 'Missile Designer', wip: true, icon: 'mdi-rocket-outline', blurb: 'Researched and designable missiles side by side under one scenario.', keywords: 'missile designer warhead engine fuel overboost thrust sensor hit chance point defence planner compare' },
  { route: '/sensors', section: 'design', tab: 'Sensors', title: 'Sensor Planner', wip: true, icon: 'mdi-access-point', blurb: 'Sensors and fire controls sized for a target, and class signatures against passive sensors.', keywords: 'sensor active passive beam fire control mfc resolution jammer eccm hardening tracking signature thermal em detection range cross-section cloak shields stealth engine thermal reduction' },
  { route: '/shipyards', section: 'design', tab: 'Shipyards', title: 'Shipyard Planner', wip: true, icon: 'mdi-hammer-wrench', blurb: 'Refit costs and times between classes, the yards that can take them, and retooling costs.', keywords: 'refit retool shipyard slipways class yard tooling' },
  { route: '/', section: null, tab: 'Empires', title: 'Empires', noRace: true, icon: 'mdi-flag-variant-outline', blurb: 'Every game in the save and its empires, to pick the one the other pages show.', keywords: 'games races pick select switch' },
  { route: '/settings', section: null, tab: 'Settings', title: 'Settings', noRace: true, icon: 'mdi-wrench', blurb: 'Appearance, number format, computer-run empires and the views the pages remember.', keywords: 'preferences options thousands separator dark theme npr spy reset views filters' },
  { route: '/about', section: null, tab: 'About', title: 'About', noRace: true, icon: 'mdi-information-outline', blurb: 'Version, license, links, how to contribute and where the data lives.', keywords: 'version license github forum feedback credits contribute help data folder settings file' },
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
