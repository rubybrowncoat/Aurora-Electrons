// The local glossary and the learning links behind each page's help (components/page/HelpPanel.vue). A term is defined here in full, so the help reads the same with no network; a link is only a pointer to public material the definitions do not copy, with its own reviewed date, the game release it was written for and whether it could be reached at the review.
//
// Links and provenance stay apart. A link explains a term or a workflow; it is never a source for a calculated figure, and no rule registered in utilities/provenance.js cites one. How far a figure holds is stated by its mark (components/page/ProvenanceMark.vue), never by a link. scripts/check-glossary.js enforces both.

import { PAGES } from './navigation'

// The game release the definitions were reviewed against; a rule registered for '2.7.x' (utilities/provenance.js) matches it.
export const GAME_VERSION = '2.7.x'

// When the entries below were last read against the pages that show them and the reachable links last opened.
export const REVIEWED = '2026-10-13'

// A version status says how a link stands against GAME_VERSION: 'older' (written for an earlier release, so rules and menus may differ), 'current' (written for it, or tied to no release) or 'unknown' (the release is not stated and could not be told).
export const VERSION_STATUS = Object.freeze({ OLDER: 'older', CURRENT: 'current', UNKNOWN: 'unknown' })

// How a status reads beside a link.
export const VERSION_STATUS_TEXT = Object.freeze({
  [VERSION_STATUS.OLDER]: 'Older than 2.7: rules and menus may differ',
  [VERSION_STATUS.CURRENT]: 'Not tied to an older release',
  [VERSION_STATUS.UNKNOWN]: 'Release not known',
})

// Nothing written before this month can describe a 2.7 release, so a link dated earlier must be marked older.
export const OLDER_THAN_GAME_BEFORE = '2024-01'

const term = (id, name, definition, units = '') => Object.freeze({ id, term: name, units, definition, versions: GAME_VERSION, reviewed: REVIEWED })

export const TERMS = Object.freeze([
  term('hull-space', 'Hull space (HS)', 'The volume unit of ships and components. One HS is 50 tons of displacement, so a ship\'s tonnage is its hull spaces times 50, and component, hull and tank sizes are quoted in HS.', 'HS'),
  term('ton', 'Ton (t)', 'The mass unit of ships, cargo and minerals; kt is a thousand tons. Mineral stock, deposit amounts, yearly mining output and freight loads are counted in tons.', 't, kt, t/yr'),
  term('build-points', 'Build points (BP)', 'The unit a construction project\'s cost is stated in, and the unit a colony\'s or yard\'s construction capacity is stated in per period. The cost over the rate put into it gives the time; the minerals the cost needs are drawn from the colony\'s stock separately.', 'BP, BP per year'),
  term('research-points', 'Research points (RP)', 'The unit a research project\'s cost is stated in and a laboratory\'s output is measured in per period. The time left on a project is the RP still to pay over the RP it makes each year; the whole cost over the yearly output is only the length of a project not yet begun.', 'RP, RP per year'),
  term('wealth', 'Wealth', 'The race\'s currency. It builds up in a treasury, and each production cycle logs what came in and what was spent by category. The Finances page adds those logs up, so what the game does not log as income or spending is missing from its totals.', 'wealth, wealth/yr'),
  term('production-cycle', 'Production cycle', 'One step of the economy at which wealth income and spending are logged. Its length is read from the gaps between the logged ends, so it is a derived figure that can differ from one save to another.', 'days'),
  term('production-capacity', 'Production capacity', 'The work a colony can start or carry each period, kept in separate pools: construction, ordnance, fighters, training, research and slipways. Idle capacity is the part of a pool no job uses, and so the place where more work can begin.', 'BP, RP, per year'),
  term('mineral-shortage', 'Mineral shortage', 'A colony is short of a mineral for its queue when the queued projects still need at least a ton more than the colony holds. Mineral on its way, by mass driver or freighter, does not change that; a job that waits for a short mineral stalls until stock arrives.', 't'),
  term('haul-shortfall', 'Hauling shortfall', 'What a colony still lacks of a mineral once the mass-driver packets on their way to it are counted as held: the queue\'s need beyond stock plus those packets, and then the reserve the colony still lacks beyond the larger of that held amount and the queue\'s need. Freighter cargo already under way is not counted.', 't'),
  term('deposit', 'Mineral deposit', 'The amount of one mineral, in tons, that a surveyed body holds, together with the accessibility that governs how fast mines can take it. A body with no deposit survey has no known deposits, which is not the same as having none.', 't'),
  term('accessibility', 'Accessibility', 'How easily a deposit can be mined, from 0.1 to 1. Yearly output from a deposit scales with it. Above half of a deposit\'s original amount it holds, and below that it falls toward 0.1 as the deposit is worked down.', '0.1 to 1'),
  term('mining-rate', 'Mining output', 'The tons a year a colony\'s mines or an orbital miner take from a deposit. It follows the number and kind of mines, the race\'s mine production, the colony\'s efficiency and the deposit\'s accessibility, and the pages show it as an estimate of the present rate.', 't/yr'),
  term('runway', 'Runway', 'How many years a stock lasts at today\'s yearly net loss: the stock over the net loss. What counts as the stock depends on the page: Mineral Outlook counts the tons held plus the cargo on its way, Finances the treasury over the yearly wealth shortfall, and Fuel & Maintenance a location\'s MSP plus the spare MSP of its supply ships over upkeep less production. A stock with no net loss has no end to run to, and an unknown input leaves the runway unknown, never 0.', 'years'),
  term('civilian-mining', 'Civilian mining complex', 'Mining installations run by civilian companies. The race chooses for each colony whether to buy their output or tax it, and a bought output can be shipped to another colony by mass driver.', 't/yr, wealth/yr'),
  term('mass-driver', 'Mass driver', 'An installation that fires packets of minerals at another colony. Packets in flight are counted apart from the stock of either colony until they land.', 't'),
  term('fuel-litres', 'Fuel (L)', 'Fuel is stored and burned in litres. A ship\'s tank capacity, stock and burn are in L, L/h or L/yr, and a refinery turns Sorium into fuel at 2,000 L for each ton.', 'L, L/h, L/yr'),
  term('sorium', 'Sorium', 'The mineral that fuel refineries turn into fuel. Harvester ships take it from gas giants. How long a colony can keep refining is its Sorium stock over what the refineries use each year.', 't'),
  term('engine-power', 'Engine power and fuel use', 'Engine power (EP) is an engine\'s thrust rating. Fuel use is stated in litres per engine-power hour (L/EPH), so a ship burns its total EP times that figure each hour at full power. Speed rises with total EP and falls with the ship\'s mass.', 'EP, L/EPH'),
  term('speed', 'Speed', 'Ship speed in kilometres a second. The time over a leg is its distance over the speed, and a fleet moves at the speed of its slowest ship.', 'km/s'),
  term('range-endurance', 'Range and endurance', 'Range is the distance a full tank carries a ship, and it does not change with speed, because fuel per kilometre is the same at every speed. Endurance is the hours the tank lasts at a stated power, so a slower cruise stretches endurance and not range.', 'km, hours'),
  term('maintenance-supply', 'Maintenance supply points (MSP)', 'The stock of spare parts that keeps ships serviceable. Colonies hold and produce it, ships carry their own, and supply ships can move the spare stock above their class minimum. At a maintenance location the stock lasts as long as it covers the net yearly loss, upkeep less production, and does not run out while production meets upkeep; a ship away from maintenance draws more each year, so its supply does not last a constant upkeep\'s years.', 'MSP, MSP/yr'),
  term('maintenance-capacity', 'Maintenance capacity', 'The tons of ship that the maintenance facilities of a location can service. Where the ships present weigh more than the capacity, only the ratio of capacity to tonnage is covered.', 't'),
  term('maintenance-life', 'Maintenance life', 'How long a ship stays maintained away from a maintenance location, in years. Its failure rate climbs every year since the last overhaul and each failure takes supplies, so the draw grows year on year until the stored MSP are spent. Engineering spaces and stored MSP lengthen it, and it should reach past the deployment time the ship is meant to serve.', 'years'),
  term('deployment-time', 'Deployment time', 'The months a crew is meant to stay away from home, set in a class design. Maintenance life and fuel range should cover it, because crew morale suffers once a ship stays out longer.', 'months'),
  term('colony-cost', 'Colony cost', 'How hostile a body is to a species, taken from the worst of its environment factors and scaled by the race\'s colonisation skill. A body at 0 needs no infrastructure; the higher the cost, the more infrastructure each million colonists need.', 'colony cost'),
  term('infrastructure', 'Infrastructure', 'What a colony on a hostile body needs for each million people to live there. Colony Outlook sets the infrastructure the population needs against what is built, and the people that the built amount supports.', 'infrastructure per M people'),
  term('body-capacity', 'Body capacity', 'The millions of people a body holds before population growth stops. It follows the body\'s surface area and the species\' density, and is lower on very wet bodies and on tide-locked planets.', 'M people'),
  term('population-growth', 'Population growth', 'The yearly rate at which a colony\'s population rises, projected forward over a horizon. Growth ends at the body\'s capacity, so a projection past that point shows the capacity and not the growth.', 'per year, M people'),
  term('workers', 'Workers', 'The part of a colony\'s population that staffs its installations. An installation without enough workers runs below capacity, and Colony Outlook sets the workers the installations need against the workers the population supplies.', 'M workers'),
  term('terraforming', 'Terraforming', 'Changing a body\'s atmosphere and temperature toward a species\' needs. Its rate is the race\'s terraforming rate times the game\'s speed setting times the installations at work, in atmospheres of an Earth-sized body a year.', 'atm per year'),
  term('ark', 'Ark', 'A ship that houses population aboard. Its people count as orbital population, kept apart from a colony\'s surface population and from the workers its installations can use.', 'M people'),
  term('round-trip', 'Round trip and cycle time', 'The days a hauler needs to load, sail to its destination, unload and sail back. Moves a year are the days in a year over the cycle, and what a route carries each year is its load times those moves.', 'days, moves/yr'),
  term('civilian-shipping', 'Civilian shipping line', 'Civilian fleets that carry installations and colonists between colonies to meet work orders. A line is paid per unit carried and per billion km, at rates that depend on the game version of the save.', 'wealth per unit per billion km'),
  term('jump-point', 'Jump point', 'A gateway between two systems. Routes only pass through jump points the race has charted and explored, so a known system can stay out of reach until the points that lead to it are.', 'jumps, km'),
  term('sector', 'Sector', 'A group of systems that can be placed under one sector commander. The map can colour systems by sector.', ''),
  term('survey-progress', 'Survey progress', 'Gravitational survey finds the jump points of a system and geological survey the mineral deposits of its bodies. Each is a stock of points to work off, so the points left over the survey rate of the ships there is the time left.', 'survey points'),
  term('lagrange-point', 'Lagrange point', 'A location in a system tied to a planet or moon. Ships can jump between a system\'s stable points, which shortens a trip inside the system, and a point that is not yet stable has to be stabilised first.', 'points per system'),
  term('stabilisation', 'Stabilisation time', 'The days a ship with a stabilisation module needs to make a body\'s Lagrange point stable. The page estimates it from the modules and the multiplier of the ships that carry them.', 'days'),
  term('commander-bonus', 'Commander bonus', 'A rating that scales the output of the post a commander holds: a governor\'s bonus works on a colony, a ship commander\'s on the ship, and a scientist\'s on research.', 'bonus'),
  term('snapshot', 'History snapshot', 'A record the app writes from a save when it reads it, in its own file and not in the game\'s. A trend only spans the dates recorded, so a gap in the line is a gap in the record.', ''),
  term('observed-intel', 'Observed figure', 'What the race has learned of another empire through sensors, contact and translation. A figure is an observation and not the empire\'s full state, and what has not been observed is unknown, not zero.', ''),
  term('research-project', 'Research project', 'A technology with a cost in RP and prerequisites. It is available once its prerequisites are done. The RP left is the stored remainder of a running project, or the development cost less the points banked in paused research, and it lands after those RP over the points the labs and scientist make each year.', 'RP'),
  term('component-design', 'Component design', 'A saved design of one ship component, with its size in HS, cost in BP and the figures of its type. A design is in use when a class mounts it, unused when none does, and obsolete when the game has flagged it as replaced.', 'HS, BP'),
  term('refit', 'Refit', 'Converting a ship of one class into another at a yard. The cost and time depend on the components that change, and the reverse refit between two classes is a separate figure.', 'BP, days'),
  term('retool', 'Retooling', 'Preparing a yard to build or refit a class it is not tooled for. It has its own cost and time, and a yard that is already tooled for the class needs none.', 'BP, days'),
  term('slipway', 'Slipway', 'One of a yard\'s build slots. Each holds one ship under construction or refit at a time, so more slipways let more ships proceed together.', 'slipways'),
  term('warning-check', 'Warning check', 'A test run over the save that flags a condition worth a look, such as idle fleets or stock running short. A muted warning, or a muted check, stays out of the lists and tiles until it is unmuted, even if the condition worsens; Show muted warnings brings them back to unmute them one at a time, and Unmute all clears every mute.', ''),
  term('game-log', 'Game log', 'The events the game records as time passes, each with a type, a date and a message. It is a record of what has happened and not a forecast.', ''),
  term('project-note', 'Project note', 'A note the player keeps on one body, colony, fleet or tech, with a status and the next action to take. It is kept in the app\'s own files for the campaign and race, and it gives the game no order and writes nothing to the save. Its link to the object is checked against the save each time, so a note whose object has gone stays readable as stale.', ''),
  term('estimated-output', 'Estimated figure', 'A value the app computes from saved data rather than reads from the game. A mark beside it states how far it holds: confirmed (observed in the save, or reproduced by a rule checked against saves), estimated (approximate or not checked), assumed (it rests on a number entered or chosen) or unavailable (an input is missing, so the figure is blank and never 0). A help link explains a term and does not stand in for that mark.', ''),
  term('sensor-resolution', 'Sensor resolution', 'The size of target an active sensor is built to see. A target with a cross-section under the resolution is seen at its range cut by the square of the cross-section over the resolution, so a target half the resolution is seen at a quarter of the range. A larger resolution suits larger targets and needs a larger sensor to reach the same range against a small one.', 'HS'),
  term('sensor-jammer', 'Sensor jammer', 'A target\'s defence against active sensors. Each level of jammer above the sensor\'s ECCM cuts the sensor\'s range to 0.75 of it; ECCM at or above the jammer cuts nothing. It is a different figure from the jammer of a missile in the hit chance, which does not change a sensor\'s range.', ''),
  term('fire-control', 'Fire control', 'The sensor that guides weapons onto a target. A missile fire control reaches twice the range of a search sensor of the same size. A beam fire control has a range, capped at 1,400,000 km, and a tracking speed, each set by its own multiplier and sized apart; a single weapon control is restricted to one weapon.', 'km, km/s'),
  term('electronic-hardening', 'Hardening and ECCM', 'Protection a sensor or fire control is built with. Hardening sets its Uridium and ECCM adds Corbomite on top, each from the level of its tech and each changing the BP. ECCM lowers the jammer a sensor meets, so a higher level keeps more of its range against a jamming target.', 'BP'),
])

const link = (fields) => Object.freeze({ reviewed: REVIEWED, reached: REVIEWED, written: null, ...fields })

// `title` and `covers` say what the pointer is and what it deals with, in the words of this app, never as a verification. `written` is the month the material was written (null for a living site), `gameVersion` the release it describes in its own words, `status` how that stands against GAME_VERSION and `reached` the date the address answered at the review (null when it did not).
export const LINKS = Object.freeze([
  link({ id: 'resources-list', title: 'Aurora 4x Resources List', source: '7w1', url: 'https://7w1.github.io/posts/resources/', covers: 'An index of written and video tutorials, playthroughs, forums and the wiki.', written: '2023-03', gameVersion: 'C# edition, March 2023; no release number given', status: VERSION_STATUS.OLDER }),
  link({ id: 'tutorial-gameplay', title: 'Tutorial part 2: Gameplay', source: '7w1', url: 'https://7w1.github.io/posts/tutorial2/', covers: 'The first industry, research, shipyard and governor orders of a new game.', written: '2023-03', gameVersion: 'C# edition, March 2023; no release number given', status: VERSION_STATUS.OLDER }),
  link({ id: 'tutorial-research-engines', title: 'Tutorial part 3: Research and Engines', source: '7w1', url: 'https://7w1.github.io/posts/tutorial3/', covers: 'Queueing research and designing a first engine for range and fuel economy.', written: '2023-03', gameVersion: 'C# edition, March 2023; no release number given', status: VERSION_STATUS.OLDER }),
  link({ id: 'tutorial-survey-ship', title: 'Tutorial part 4: Survey Ship', source: '7w1', url: 'https://7w1.github.io/posts/tutorial4/', covers: 'Industry and shipyard set-up, and designing a ship around maintenance life, MSP and fuel range.', written: '2023-03', gameVersion: 'C# edition, March 2023; no release number given', status: VERSION_STATUS.OLDER }),
  link({ id: 'tutorial-surveying', title: 'Tutorial part 5: Surveying', source: '7w1', url: 'https://7w1.github.io/posts/tutorial5/', covers: 'Sending survey ships out, reading mineral stock and accessibility, and choosing a first mining colony.', written: '2023-03', gameVersion: 'C# edition, March 2023; no release number given', status: VERSION_STATUS.OLDER }),
  link({ id: 'community-forum', title: 'Aurora 4X community forum', source: 'Aurora 4X community', url: 'https://aurora4x.com/', covers: 'Discussion of the game and its releases, and the place to ask for help.', gameVersion: 'Live discussion, not tied to one release', status: VERSION_STATUS.CURRENT }),
  link({ id: 'community-wiki', title: 'Aurora community wiki', source: 'Aurora 4X community', url: 'https://aurorawiki.pentarch.org/index.php?title=Main_Page', covers: 'Reference pages on game terms; its C# part is largely the release changelogs, formatted.', gameVersion: 'Mixed releases; the page does not say which', status: VERSION_STATUS.UNKNOWN, reached: null }),
])

const RESOURCES = ['resources-list', 'community-forum', 'community-wiki']

// What each page's help shows: terms in reading order and links, by route. A route is a page of the registry (utilities/navigation.js); scripts/check-glossary.js holds every page that belongs to a section to an entry.
const PAGE_HELP = Object.freeze({
  '/production': { terms: ['build-points', 'research-points', 'production-capacity', 'mineral-shortage', 'slipway', 'estimated-output'], links: ['tutorial-gameplay', 'tutorial-survey-ship', ...RESOURCES] },
  '/warnings': { terms: ['warning-check', 'maintenance-supply', 'fuel-litres', 'mineral-shortage', 'estimated-output'], links: RESOURCES },
  '/log': { terms: ['game-log', 'production-cycle'], links: RESOURCES },
  '/minerals': { terms: ['deposit', 'accessibility', 'mining-rate', 'mineral-shortage', 'civilian-mining', 'mass-driver', 'ton', 'estimated-output'], links: ['tutorial-surveying', ...RESOURCES] },
  '/mineral-outlook': { terms: ['runway', 'mining-rate', 'deposit', 'accessibility', 'ton', 'estimated-output'], links: ['tutorial-surveying', ...RESOURCES] },
  '/finances': { terms: ['wealth', 'production-cycle', 'civilian-shipping', 'civilian-mining', 'runway', 'estimated-output'], links: RESOURCES },
  '/notebook': { terms: ['project-note', 'research-project', 'component-design'], links: RESOURCES },
  '/colony-outlook': { terms: ['population-growth', 'body-capacity', 'infrastructure', 'workers', 'ark', 'estimated-output'], links: ['tutorial-surveying', ...RESOURCES] },
  '/habitability': { terms: ['colony-cost', 'infrastructure', 'body-capacity', 'terraforming', 'accessibility', 'jump-point', 'estimated-output'], links: ['tutorial-surveying', ...RESOURCES] },
  '/logistics': { terms: ['fuel-litres', 'sorium', 'maintenance-supply', 'maintenance-capacity', 'maintenance-life', 'deployment-time', 'runway', 'estimated-output'], links: ['tutorial-survey-ship', ...RESOURCES] },
  '/hauling': { terms: ['haul-shortfall', 'mineral-shortage', 'mass-driver', 'round-trip', 'ton', 'speed', 'fuel-litres', 'estimated-output'], links: RESOURCES },
  '/information': { terms: ['round-trip', 'speed', 'civilian-shipping', 'ton', 'estimated-output'], links: RESOURCES },
  '/map': { terms: ['jump-point', 'sector', 'survey-progress', 'estimated-output'], links: RESOURCES },
  '/intelligence': { terms: ['observed-intel', 'estimated-output'], links: RESOURCES },
  '/survey-progress': { terms: ['survey-progress', 'speed', 'deployment-time', 'maintenance-life', 'estimated-output'], links: ['tutorial-survey-ship', 'tutorial-surveying', ...RESOURCES] },
  '/routes': { terms: ['jump-point', 'speed', 'lagrange-point', 'estimated-output'], links: RESOURCES },
  '/lagrange': { terms: ['lagrange-point', 'stabilisation', 'jump-point', 'estimated-output'], links: RESOURCES },
  '/history': { terms: ['snapshot', 'wealth', 'research-points', 'estimated-output'], links: RESOURCES },
  '/commanders': { terms: ['commander-bonus', 'research-project', 'estimated-output'], links: ['tutorial-gameplay', ...RESOURCES] },
  '/technologies': { terms: ['research-project', 'research-points', 'component-design', 'estimated-output'], links: ['tutorial-research-engines', 'tutorial-gameplay', ...RESOURCES] },
  '/designed-tech': { terms: ['component-design', 'hull-space', 'build-points', 'estimated-output'], links: ['tutorial-research-engines', 'tutorial-survey-ship', ...RESOURCES] },
  '/propulsion': { terms: ['engine-power', 'fuel-litres', 'speed', 'range-endurance', 'hull-space', 'build-points', 'maintenance-supply', 'estimated-output'], links: ['tutorial-research-engines', 'tutorial-survey-ship', ...RESOURCES] },
  '/missile-designer': { terms: ['speed', 'range-endurance', 'engine-power', 'fuel-litres', 'sensor-resolution', 'sensor-jammer', 'estimated-output'], links: RESOURCES },
  '/sensors': { terms: ['hull-space', 'sensor-resolution', 'sensor-jammer', 'fire-control', 'electronic-hardening', 'engine-power', 'speed', 'observed-intel', 'estimated-output'], links: RESOURCES },
  '/shipyards': { terms: ['refit', 'retool', 'slipway', 'build-points', 'hull-space', 'estimated-output'], links: ['tutorial-survey-ship', ...RESOURCES] },
})

const termById = Object.freeze(Object.fromEntries(TERMS.map((entry) => [entry.id, entry])))
const linkById = Object.freeze(Object.fromEntries(LINKS.map((entry) => [entry.id, entry])))

export { PAGE_HELP, termById, linkById }

// The pages that belong to a section of the navigation, which are the ones a help is owed to; Empires, Settings and About stand outside it.
export const helpRoutes = () => PAGES.filter(({ section, planned }) => section && !planned).map(({ route }) => route)

// The help of a route with its terms and links in full: { route, title, terms, links }, or null for a route with none.
export const helpFor = (route) => {
  const entry = PAGE_HELP[route]
  const page = PAGES.find((item) => item.route === route)

  if (!entry || !page) {
    return null
  }

  return {
    route,
    title: page.title,
    terms: entry.terms.map((id) => termById[id]),
    links: entry.links.map((id) => linkById[id]),
  }
}
