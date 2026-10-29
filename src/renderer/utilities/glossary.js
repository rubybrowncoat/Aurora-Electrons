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
  [VERSION_STATUS.OLDER]: 'Written for an older release: rules and menus may differ',
  [VERSION_STATUS.CURRENT]: 'Not tied to an older release',
  [VERSION_STATUS.UNKNOWN]: 'Release not known',
})

// Nothing written before this month can describe a 2.7 release, so a link dated earlier must be marked older.
export const OLDER_THAN_GAME_BEFORE = '2024-01'

const term = (id, name, definition, units = '', reviewed = REVIEWED) => Object.freeze({ id, term: name, units, definition, versions: GAME_VERSION, reviewed })

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
  term('body-tag', 'Body tag', 'A short label the player puts on one planet, moon, asteroid or comet of a known system, to find it again from the Notebook and the Galaxy Map. It is kept in the app\'s own files for the campaign, race and branch, and it gives the game no order and writes nothing to the save. It belongs to that body alone, so tagging a moon leaves its planet and system untagged. A body that has gone leaves the tag listed as stale.', ''),
  term('estimated-output', 'Estimated figure', 'A value the app computes from saved data rather than reads from the game. A mark beside it states how far it holds: confirmed (observed in the save, or reproduced by a rule checked against saves), estimated (approximate or not checked), assumed (it rests on a number entered or chosen) or unavailable (an input is missing, so the figure is blank and never 0). A help link explains a term and does not stand in for that mark.', ''),
  term('sensor-resolution', 'Sensor resolution', 'The size of target an active sensor is built to see. A target with a cross-section under the resolution is seen at its range cut by the square of the cross-section over the resolution, so a target half the resolution is seen at a quarter of the range. A larger resolution suits larger targets and needs a larger sensor to reach the same range against a small one.', 'HS'),
  term('sensor-jammer', 'Sensor jammer', 'A target\'s defence against active sensors. Each level of jammer above the sensor\'s ECCM cuts the sensor\'s range to 0.75 of it; ECCM at or above the jammer cuts nothing. It is a different figure from the jammer of a missile in the hit chance, which does not change a sensor\'s range.', ''),
  term('fire-control', 'Fire control', 'The sensor that guides weapons onto a target. A missile fire control reaches twice the range of a search sensor of the same size. A beam fire control has a range, capped at 1,400,000 km, and a tracking speed, each set by its own multiplier and sized apart; a single weapon control is restricted to one weapon.', 'km, km/s'),
  term('cease-fire', 'Cease fire (tactical map)', 'A control of the game\'s tactical map, Cease Fire All Ships on its Miscellaneous tab, that closes the offensive fire controls of the race\'s ships other than commercial ones. It leaves each fire control\'s target in place, and nothing read shows it ending combat or stopping a boarding already under way.', '', '2026-10-20'),
  term('game-events-window', 'Events window (game)', 'The game\'s own list of logged events, which draws on the same log the Game Log page reads. Its Show All Events option brings back the event types the race hid there, so an event absent from that window can still be in the log.', '', '2026-10-20'),
  term('fleet-cease-fire', 'Cease fire fleet (Fleet window)', 'A control of the game\'s Fleet window, Cease Fire Fleet, that closes the fire controls of every ship of the selected fleet, ships carried by a mothership included; a selected ship stands for its fleet. It leaves each fire control\'s target in place, and nothing read shows it ending combat or stopping a boarding already under way.', '', '2026-10-20'),
  term('ship-open-fire', 'Open and cease fire toggles (Fleet window)', 'Two controls of the game\'s Fleet window for the selected ship. Open Fire All and Cease Fire All close every fire control of the ship, or open those that hold a target; Open Fire FC and Cease Fire FC flip the one fire control picked in the ship\'s combat list. Neither changes a target, and nothing read shows either ending combat or stopping a boarding already under way.', '', '2026-10-20'),
  term('electronic-hardening', 'Hardening and ECCM', 'Protection a sensor or fire control is built with. Hardening sets its Uridium and ECCM adds Corbomite on top, each from the level of its tech and each changing the BP. ECCM lowers the jammer a sensor meets, so a higher level keeps more of its range against a jamming target.', 'BP'),
])

const link = (fields) => Object.freeze({ reviewed: REVIEWED, reached: REVIEWED, written: null, ...fields })

// `title` and `covers` say what the pointer is and what it deals with, in the words of this app, never as a verification. `written` is the month the material was written (null for a living site), `gameVersion` the release it describes in its own words, `status` how that stands against GAME_VERSION and `reached` the date the address answered at the review (null when it did not).
export const LINKS = Object.freeze([
  link({ id: 'community-forum', title: 'Aurora 4X community forum', source: 'Aurora 4X community', url: 'https://aurora4x.com/', covers: 'Discussion of the game and its releases, and the place to ask for help.', gameVersion: 'Live discussion, not tied to one release', status: VERSION_STATUS.CURRENT }),
  link({ id: 'community-wiki', title: 'Aurora community wiki', source: 'Aurora 4X community', url: 'https://aurorawiki.pentarch.org/index.php?title=Main_Page', covers: 'Reference pages on game terms; its C# part is largely the release changelogs, formatted.', gameVersion: 'Mixed releases; the page does not say which', status: VERSION_STATUS.UNKNOWN, reached: null }),
])

const RESOURCES = ['community-forum', 'community-wiki']

// What each page's help shows: terms in reading order and links, by route. A route is a page of the registry (utilities/navigation.js); scripts/check-glossary.js holds every page that belongs to a section to an entry.
const PAGE_HELP = Object.freeze({
  '/production': {
    overview: 'Production Recap lists every job the colonies are building, researching, training or terraforming, with the time each has left, and sets the idle capacity beside it. It reads the industrial projects, research projects, shipyard tasks, training tasks and terraforming of the save and forecasts each finish from the colony\'s capacity and stock. Finish dates are estimates with a mark; the save is only read.',
    usage: [
      'Show picks the kinds of job listed, Rows switches the table between one row a job and the jobs grouped by colony, and Production options adds the queued and paused jobs.',
      'Work in progress lists each job with its status and finish; Search narrows it, a colony name focuses the page on that colony, and the chip Show every colony clears the focus.',
      'Assumed arrivals enters stock expected at a colony on a day so that a project the stock cannot finish gets a date; the arrivals are assumptions kept in memory, not read from the save, and Remove all drops them.',
      'Completions counts the jobs finishing in each month, quarter or year of the horizon chosen (1 y, 5 y or 20 y), by kind.',
      'Idle capacity by colony shows the construction, ordnance, fighter, training, research and slipway capacity each colony leaves unused, with links to Colony Outlook, the Colonization Planner and Commanders.',
      'Component calculator takes a Ship class, a Colony, the Hulls and a Deadline in days and gives the share of the colony\'s construction capacity that builds the class\'s manufactured components in time; a stock figure typed over a row is an assumption, and Reset stock restores the save\'s.',
      'Procurement manifest takes one or more classes with their hulls and the colony they are Needed at, and lists what is short of each component, where the stock sits and what has to move; CSV downloads the manifest and Copy text copies it.',
      'A finish date is a forecast under the rules in each section\'s footer; a dash is a job with no date, and the mark beside it says why.',
    ],
    terms: ['build-points', 'research-points', 'production-capacity', 'mineral-shortage', 'slipway', 'estimated-output'],
    links: RESOURCES,
  },
  '/warnings': {
    overview: 'Warnings runs a set of checks over the save and lists what each one flags, in groups: fleets, ships, industry, colonies, research, administration, and contacts and space. Each check has a severity, and a warning stays listed until the condition clears in the save or it is muted or snoozed here. Mutes and snoozes are the app\'s own records for this race; nothing is written to the save.',
    usage: [
      'Severity (Needs action, Attention or Info) and Group narrow the list, Search warnings matches the text of a row, and the chip Only keeps one check; the empty state offers Reset filters and Show every check.',
      'The tiles at the top count the warnings by severity, with the muted and snoozed ones apart.',
      'Each group is a section of its checks; a check\'s title carries its count, a check with more than ten rows shows the rest under Show all, and a row links to the page that deals with it.',
      'Mute on a row or a check takes it out of the list for good, and Snooze takes it out until a game date, until the check lists nothing or until the warning changes materially, as chosen in the snooze dialog.',
      'Show muted warnings and Show snoozed warnings in Warnings options bring them back so they can be unmuted one at a time, and Unmute all clears every mute.',
      'Warnings options also sets the maintenance share the low maintenance check lists ships under, the ship classes it leaves out, and whether fleets parked at the race\'s places count as idle.',
      'A check that could not be read says so in place of its rows, and a count it cannot settle is not 0.',
    ],
    terms: ['warning-check', 'maintenance-supply', 'fuel-litres', 'mineral-shortage', 'estimated-output'],
    links: RESOURCES,
  },
  '/log': {
    overview: 'Game Log reads the events the game has logged for the race, newest first, with filters, colours and pins the game does not offer. It can keep an archive of the events each save showed, so events that have fallen out of the save\'s window stay readable. Pins and the archive are the app\'s own records for this race and branch, the presets are saved filter sets kept for the whole app, and the save is only read.',
    usage: [
      'Search messages, Keywords (any), System or colony and Event types narrow the Events list, and Presets keeps a set of filters under a name to apply again.',
      'Game Log options collapses daily repeats, keeps only custom-coloured events, switches the event archive on and resets the filters.',
      'Pinned holds copies of the events pinned from the list, each with a note of its own; Read in full opens the message and Unpin removes the copy.',
      'Event archive shows what the archive has observed on this branch, and Events listed from switches the list between This save and the Archive.',
      'Short-interval checklist lists the fire and boarding events of the chosen Window and how far the log covers it, as evidence for a stalled short interval; it names no cause.',
      'Timeline counts the events by month under the search, place and type filters; click a month to set From and Through, click it again to clear them, or pick a Month directly.',
      'In Events, click a message to read it in full, expand a daily repeat for each message, pin an event, hide its type, or open its place on the Galaxy Map or in the Colonization Planner; New marks the events since the last visit to this branch.',
    ],
    terms: ['game-log', 'production-cycle', 'cease-fire', 'fleet-cease-fire', 'ship-open-fire', 'game-events-window'],
    links: RESOURCES,
  },
  '/minerals': {
    overview: 'Mineral Breakdown sets each mineral\'s deposits in the ground against what is mined, held and needed in the colonies, so the next mining site, mining ship or transfer can be chosen. It reads the surveyed deposits, the colonies\' stocks, reserves and queues, the mass drivers and the civilian mining complexes of the save. Figures are as of the save, the policy acknowledgments are the app\'s own records, and the save is only read.',
    usage: [
      'Mineral focuses every section on one mineral; Systems limits them to all known systems, those with colonies, those with people or the unrestricted ones; a system clicked on the map narrows them further until the chip Show every system again clears it.',
      'Deposit options filters the deposits by body kind, accessibility and tonnes, and Reset options restores the defaults.',
      'By mineral counts, for each mineral, what lies in the ground, what is mined, what is held and which colonies are short; click a mineral to focus the page on it, and the link beside the title opens its runway in Mineral Outlook.',
      'Deposits by system sizes each known system by what its deposits hold of the focused mineral; click a system to narrow the deposits and colonies to it.',
      'Bodies with deposits lists the surveyed bodies under the view All, Untapped or Mined and a search on body or system; expand a body for its minerals, and select bodies to open them in the Colonization Planner.',
      'Civilian mining candidates ranks the surveyed bodies a complex could be founded on, by the Headline order or by a Longevity preference with editable weights that Reset to defaults restores; neither order predicts the game\'s choice.',
      'Minerals in the colonies shows what each colony holds, reserves and needs; expand a colony for each mineral and the nearest colony with stock free to move.',
      'Civilian mining policy lists each colony whose complexes produce, whether the race buys or taxes the output and where a bought output is sent; Acknowledge as intended marks a taxed colony as meant, and the link opens the stockpiling check in Warnings.',
      'A dash is a figure the save does not record, never 0, and the mark beside it names what is missing.',
    ],
    terms: ['deposit', 'accessibility', 'mining-rate', 'mineral-shortage', 'civilian-mining', 'mass-driver', 'ton', 'estimated-output'],
    links: RESOURCES,
  },
  '/mineral-outlook': {
    overview: 'Mineral Outlook projects how long each mineral lasts: its stock, what the mines produce, what industry uses and the years of runway left, then where the mined mineral goes and where more of a short one could come from. It reads the game\'s mineral ledger where the save keeps one, and models the uses from the queues, refineries, maintenance facilities and shipyards where it does not. Every figure past today is a projection under the rules in the footers; the save is only read.',
    usage: [
      'Ledger window sets the days of the ledger the rates are read from (30 d to 365 d), Horizon sets how far the projection runs (25 y to 250 y), and Mineral chooses the mineral the outlook, supply and deficit sections follow.',
      'The outlook section of the chosen mineral charts its projected stockpile and mining output; Mineral Breakdown opens that page on the mineral, and Sources and uses opens Mineral sources and uses, the flows of the window as a chart or a table.',
      'Mineral runway lists every mineral with its stock, production, use and years left; click a row to make it the chosen mineral.',
      'Mineral uses lists the purposes that use minerals, observed in the ledger or modelled, each with a switch that leaves it out of the Used column and the runway.',
      'Deposits being mined shows each worked deposit\'s yield and when it runs down; All minerals widens it past the chosen mineral, the Empty within switch keeps the deposits that empty inside the horizon, and a row expands to its output timeline.',
      'Extraction, export and delivered supply tells the stock a site extracts from the supply a destination colony receives by mass driver; a Delivery typed for one site is a hypothetical, never stored or counted elsewhere.',
      'Sites for a deficit mineral ranks the surveyed deposits of a mineral the race is short of by how soon a first load could reach the colony picked in Deliver to colony, with the mines built at the colony chosen, the Mine type and Number of mines, and the carrier\'s Speed, Cargo hold and drive typed or taken from a ship class.',
      'A rate from the ledger is observed; a modelled use, a projection and a first-load time are estimates with a mark, and a figure the save cannot support is a dash, never 0.',
    ],
    terms: ['runway', 'mining-rate', 'deposit', 'accessibility', 'ton', 'estimated-output'],
    links: RESOURCES,
  },
  '/finances': {
    overview: 'Finances adds up the wealth the game logs each production cycle, income and spending by category, and sets the treasury beside it. It reads the race\'s wealth log and treasury from the save, and the history snapshots the app has recorded on this branch. What the game does not log as income or spending is missing from the totals, the shipping scenarios are estimates entered here, and the save is only read.',
    usage: [
      'Window sets the days of the log the sections read, from 30 d to 365 d.',
      'Income and spending lists each production cycle\'s income, spending and net by category, as a chart or a table.',
      'Income and spending by source turns the window into yearly totals and shares for each source of income and kind of spending.',
      'Treasury charts the balance over the window.',
      'Treasury against the log compares the stored treasury between two recorded snapshots with the logged cycles between them and names the residual the log does not account for; a dash is a span that cannot be compared.',
      'Civilian shipping-line payouts shows the rates a line is paid, and a Category, the Units carried and the One-way loaded distance give a worked payout estimate.',
      'Treasury runway under shipping scenarios projects when the treasury runs out over the Horizon chosen under a Future shipping tax, paused contracts, a government transport\'s running cost and new contracts added with Add a contract; the scenario is the app\'s own, and Empire History holds the snapshots it draws on.',
      'Logged amounts are observed; every runway and payout is an estimate with a mark.',
    ],
    terms: ['wealth', 'production-cycle', 'civilian-shipping', 'civilian-mining', 'runway', 'estimated-output'],
    links: RESOURCES,
  },
  '/notebook': {
    overview: 'Project Notebook keeps the player\'s own notes on bodies, colonies, fleets and techs of the race, each with a status and a next action, with short tags on single bodies and a digest of what changed in the economy since the last acknowledgment. Notes, tags and acknowledgments are kept in the app\'s files for this campaign, race and branch, and each note\'s link is checked against the open save every time. Nothing here gives the game an order or writes to the save.',
    usage: [
      'New note picks what the note is About, the System and the object, then its Plan, Status and Next action; Share with every branch of this campaign keeps it on every branch, and Add note stores it.',
      'Include techs not yet researched widens a tech note\'s picker, and a note that changed meanwhile asks whether to Write over it or Keep what is stored.',
      'Project notes lists the notes under the System filter, each with a chip that says whether its link holds, is not checked or is stale; Edit opens a note in the editor, and Delete removes it after a confirmation.',
      'Body tags puts a short tag on one body of a known system (System, Body, Tag, then Tag the body), lists the tags under the Tag filter and lets each be changed or cleared; the Galaxy Map shows the same tags.',
      'Economic changes since the last acknowledgment groups the net changes between the saves the app observed by the object they are about; Acknowledge hides a change, the section\'s acknowledgment moves the boundary to this save, and Show them again brings the hidden changes back.',
      'A note whose object has gone stays readable as stale with the name it had; a colony or a designed tech has no date in the save, so its link reads not checked and the note shows what holds that ID now.',
    ],
    terms: ['project-note', 'body-tag', 'research-project', 'component-design'],
    links: RESOURCES,
  },
  '/colony-outlook': {
    overview: 'Colony Outlook projects each colony\'s population, growth, body capacity, infrastructure and workers over a horizon, so the colonies that will outgrow their bodies or run short of workers show before they do. It reads the colonies, species, installations, shipyards and queues of the save and applies the game\'s growth rule. Figures past today are estimates with a mark; the save is only read.',
    usage: [
      'Horizon sets the years projected (5 to 50), Workers needed counts the workers of Today\'s installations or With the queue added, Only colonies that need attention keeps the colonies that fall short, and Search colonies narrows the table.',
      'Colonies lists each colony now and at the horizon; expand a row for its population chart, its worker split and the queued installations and shipyard upgrades, Only this colony focuses the page on it, and the chip Show every colony clears the focus.',
      'A colony\'s row links to its work in Production Recap, its body in the Colonization Planner and its governor in Commanders.',
      'Ark population, shown where the race has Ark ships, lists the people living aboard at each colony with the berths still empty, apart from the surface figures and without growth.',
      'Colonist floor gives how many colonists each colony can give up to a Batch while its installations stay staffed, with a retained floor entered per colony.',
      'Mine bootstrap compares three ways of adding mines at the Colony to gain mining, for a Mine type and Number of mines: importing them from the Builder chosen, building them with the colony\'s own industry, or ground-force assistance.',
      'A dash is a figure the save cannot support, and the mark beside it names what is missing; colonies short of workers today are also on Warnings.',
    ],
    terms: ['population-growth', 'body-capacity', 'infrastructure', 'workers', 'ark', 'estimated-output'],
    links: RESOURCES,
  },
  '/habitability': {
    overview: 'Colonization Planner ranks the known bodies as places to settle next for a species, by the people they hold, the minerals they offer or both, with the colony cost, the terraforming it would take and the transit from the race\'s colonies. It reads the surveyed bodies, the species, the deposits, the Lagrange points and the charted routes of the save. The ranking is the planner\'s own ordering, not a game rule; the save is only read.',
    usage: [
      'Species sets the species the bodies are judged for, Goal ranks them by People, Minerals or Both, and Terraformers sets how many installations the terraforming time assumes.',
      'Active systems limits the bodies to the systems picked (Select All or a preset), Filters hides kinds of body, and Ranking sets the weights of the score; Reset Filters and Reset ranking restore the defaults.',
      'Transit times the trip from the nearest colony at a Speed typed or taken from a ship class, with or without jumps between Lagrange points, and can sort the table by it.',
      'Plan states shows the state each body is in and filters the table to the states clicked, and Show all states clears that; the view toggle switches between Best targets, All ranked, Colonies and Other bodies, each with its count.',
      'In the table, expand a body for its detail by species and copy a figure from it; the selection buttons add bodies to the comparison, Isolate in Planner narrows the table to them, Isolate in Minerals opens the Mineral Breakdown on them, and Clear Selection empties it.',
      'Colony comparison, shown above the table once bodies are selected, sets them side by side on their raw figures for the Species chosen in its head; every column sorts, and nothing is combined into a score.',
      'A figure that cannot be worked out shows a dash and names what is missing; an unsurveyed body keeps its deposits unknown.',
    ],
    terms: ['colony-cost', 'infrastructure', 'body-capacity', 'terraforming', 'accessibility', 'jump-point', 'estimated-output'],
    links: RESOURCES,
  },
  '/logistics': {
    overview: 'Fuel & Maintenance sets what the race makes of fuel and maintenance supplies against what its ships burn and use, by colony and by ship, and keeps the player\'s reserve records and fleet station notes beside them. It reads the refineries, harvesters, tankers, maintenance facilities, supply ships and stocks of the save. Yearly figures are estimates under the rules in the footers, the records are the app\'s own, and the save is only read.',
    usage: [
      'The view toggle switches the page between Fuel, Maintenance supplies, Reserves and Fleet stations.',
      'Under Fuel, Fuel balance per year sets the refineries\' and harvesters\' output against the ships\' burn, Burn by class estimates each class\'s yearly burn two ways, and Colony fuel and refineries shows where fuel is made and where Sorium is about to run out.',
      'Tankers and fuel service tells each tanker\'s stored fuel from the fuel it is free to give, and the Fuel reserves editor below keeps a reserve record for a ship or a class, with a note and the choice to share it with every branch.',
      'Sorium harvesters, shown where the race has harvesters, gives each one\'s rate and the fuel that fits over the period picked in Fits over.',
      'Under Maintenance supplies, Maintenance locations lists each colony and ship that maintains ships with its stock, production and upkeep; Show colonies without ships adds the idle ones, and a row expands to its capacity sources, stock providers and the ships it maintains.',
      'Maintenance supplies with incoming minerals adds the mining, packets and hauls arriving over the horizon chosen to the stock-only output above, and Supply ships lists the ships carrying supplies.',
      'Under Reserves, the ledger walks the chosen horizon day by day to show when a planned withdrawal would leave a colony short of fuel or supplies; Show sources without a record lists every source, the scenario chips pick which scenarios run together, and the editor keeps the player\'s reserves and withdrawals as scenario records.',
      'Under Fleet stations, each fleet\'s noted station and supply base sits beside where the fleet is; New note records one, and Show fleets without a note lists the rest.',
      'A rate the save does not give leaves a figure not known, never 0; a figure with a mark carries what it rests on.',
    ],
    terms: ['fuel-litres', 'sorium', 'maintenance-supply', 'maintenance-capacity', 'maintenance-life', 'deployment-time', 'runway', 'estimated-output'],
    links: RESOURCES,
  },
  '/hauling': {
    overview: 'Hauling Planner works out the hauls that would cover what the colonies lack of each mineral and which freighter class carries each one soonest, then reads the freight routes the fleets already run on repeat. It reads the colonies\' stocks, reserves and queues, the mass-driver packets, the freighter classes and the saved cycle orders of the fleets. The plan and the desired routes are the app\'s own; nothing is ordered in the game or written to the save.',
    usage: [
      'Hauling plan lists each shortfall with the colony that gives, the colony that is short and the tonnes; Fill reserves adds what a colony lacks below its reserve, and the avoid options keep the hauls out of dangerous or alien-held systems.',
      'Expand a haul for each freighter class\'s round trip, trips and fuel, with the best class first; the reserves ledger under the table walks the plan day by day against the colonies\' mineral reserves, with Count the hauling plan adding the planned hauls to it.',
      'Repeating routes lists the fleets Aurora runs on cycle orders with their stops, cycle time, yearly moves and fuel; expand a route for its legs, its loading and unloading and the fleet\'s profile, and the links open the route in the Route Finder.',
      'Route coverage groups the repeating fleets by the route their orders make, with the yearly capacity of each; Only flagged routes keeps the routes with a problem, and a route expands to its fleets.',
      'Desired routes keeps the player\'s record of the routes wanted between two colonies (New desired route, then Name, From colony, To colony, Cargo and Yearly demand) and sets each against the observed routes\' capacity.',
      'Deliveries by destination credits each colony with what the repeating routes bring it a year, by cargo, and Freighter classes compares the classes on capacity, speed and yearly distance and fuel.',
      'Cycle times, trips and fuel are estimates under the rules in the footers and carry a mark; a route a ship cannot load on, or whose crew the save lacks, is named with the reason and left out of the totals.',
    ],
    terms: ['haul-shortfall', 'mineral-shortage', 'mass-driver', 'round-trip', 'ton', 'speed', 'fuel-litres', 'estimated-output'],
    links: RESOURCES,
  },
  '/information': {
    overview: 'Transport Capacity times a run between two places for the race\'s freighters and colony ships, class by class and fleet by fleet, and gives what each could carry in a year; the civilian work orders show what the shipping lines are carrying meanwhile. It reads the fleets, classes, crews, colonies and charted routes of the save. Every trip is a projection at full loads under the rules in the footers; the save is only read.',
    usage: [
      'From and To set the two ends of the run, the swap button reverses them, and Fleets limits the tables to the fleets picked.',
      'Transport options chooses stabilised jump points only, the use of Lagrange points, whether idle work orders count and whether a run takes only what it needs; Avoid keeps the route out of dangerous, alien or no-auto-route systems.',
      'Fleets on this run times each class as if it sailed alone, with its round trip, trips a year and the tonnes or colonists carried; expand a row for the loading and unloading, and the link beside the title opens the run in the Route Finder.',
      'Fleets sailing together times a whole fleet at the speed of its slowest ship, with the fuel it burns and the refuelling at colonies and tankers on the way; expand a fleet for its round trip, fuel ledger and profile.',
      'Civilian work orders lists what the colonies offer and ask for of each installation and how much is on its way, grouped by installation under Search.',
      'A class that cannot load at an end of the run is marked with the reason, a fleet whose crew the save lacks has no round trip, and a bonus the save cannot settle counts as 1, so a time errs long.',
    ],
    terms: ['round-trip', 'speed', 'civilian-shipping', 'ton', 'estimated-output'],
    links: RESOURCES,
  },
  '/map': {
    overview: 'Galaxy Map draws the systems the race knows and the jump links between them, coloured by a measure and marked with what is chosen, and lets the layout be arranged, pinned and saved back to the game. It reads the systems, jump points, surveys, colonies, sectors, contacts and the game\'s own map positions of the save. Save positions is the one action in the app that writes to the save; tags, pins, clusters and recovery statuses are the app\'s own records.',
    usage: [
      'Find a system centres the map on it; Colour by picks the measure (survey, colonies, habitability, star type, sectors, alien control, clusters, jumps or travel from a system, or discovery era), Borders draws the boundaries of sectors, alien control, colonies, danger, stabilised networks or clusters, and Tag highlights the bodies carrying a tag.',
      'Show on the map adds marks for habitable worlds, ruins, constructs, rifts, wrecks, ships, shipyards, waypoints, remote ground formations, alien contacts, flags, tagged bodies, danger and discovery date, and can dim the systems with none of them.',
      'Arrange rebuilds or tidies the layout at a spacing, keeping sectors, alien control or stabilised networks together; Free layout sets the link length and lets forces or Scramble move the systems; Revert returns to the saved positions.',
      'Shift-click or shift-drag selects several systems to pin them as a cluster, and a right-click opens the quick menu of a system, with its System View.',
      'The year slider in the legend, where the race has history, shows the map as the race knew it at the end of a year; Fit the map, the lock and Export as PNG sit on the map itself.',
      'Save positions writes the systems\' positions back into the save after a confirmation, so the game\'s map matches this one; nothing else on the page changes the save.',
      'Recovery opens the Recovery ledger of the life pods and wrecks the race knows, each with a status the player keeps (pending, acknowledged or a personal recovery), filtered by kind, owner and status.',
      'A system the save leaves at the game\'s centre is drawn beside a linked system until the map is saved.',
    ],
    terms: ['jump-point', 'sector', 'survey-progress', 'body-tag', 'estimated-output'],
    links: RESOURCES,
  },
  '/intelligence': {
    overview: 'Intelligence gathers what the race has learned of every alien race it has met: its status, communication and diplomatic standing, and the classes, colonies, sensors, ground units, systems and species observed. It reads the race\'s contact and intelligence records of the save and the history snapshots the app has recorded on this branch, so the page needs the race recorded. Every figure is an observation, not the alien race\'s full state; the save is only read.',
    usage: [
      'Known races lists every alien race met with its status, communication and standing; click a row to select it.',
      'The selected race\'s section shows its status, communication and whether the relationship is fixed, with what has been learned so far.',
      'The diplomatic points and the intelligence and translation during communication attempts follow the selected race over the recorded snapshots, while Ships tracked is rebuilt from the first-seen and last-seen times of the ship contacts in the save.',
      'Observed switches between the Classes, Colonies, Sensors, Ground units, and Systems and species observed for the race; a system chip opens the Galaxy Map.',
      'A race that Empire History does not record shows a notice instead of the page, and what has not been observed is unknown, not 0.',
    ],
    terms: ['observed-intel', 'estimated-output'],
    links: RESOURCES,
  },
  '/survey-progress': {
    overview: 'Survey Progress shows how much gravitational and geological survey work each known system still needs, what the survey fleets and ground formations are doing and where they would pay off. It reads the systems, bodies, survey points, fleets, sensors, formations and ruins of the save and applies the game\'s survey rate rules. Rates and times are estimates with a mark, the observed formation records are the app\'s own, and the save is only read.',
    usage: [
      'Survey map shades each known system by the work left; click a system to show its details in Systems.',
      'Systems lists each system\'s gravitational and geological progress, the points left and the time the ships there would take; Show fully surveyed adds the finished ones, Search systems narrows the list, and a system name opens the Galaxy Map.',
      'Survey fleets gives each survey fleet\'s place, activity and points a day, with a chip saying whether the rates follow the game\'s rules or are estimates; a fleet name opens the Route Finder.',
      'Ground surveys, shown where bodies have mineral potential left, lists the bodies a ground survey could raise, with progress and time left.',
      'Specialist deployments lists each geological survey and xenoarchaeology formation once, with its state read from where it stands; Roles shown and States shown filter it, and a row expands to the formation.',
      'Survey targets lists the known bodies and ruins where such a formation has work, and Without a formation only keeps the ones nobody is at.',
      'Ground formations lists the race\'s formations by role; Remote only keeps those stationed at no colony, Template compared with sets each formation against its Original or Replacement template, and Observe formations records the formations seen on this branch.',
      'Travel between targets is not counted in a time, and a formation whose place or rating the save does not hold has no state.',
    ],
    terms: ['survey-progress', 'speed', 'deployment-time', 'maintenance-life', 'estimated-output'],
    links: RESOURCES,
  },
  '/routes': {
    overview: 'Route Finder & Distances plans a route through any number of stops over the jump points the race has explored and times it at a speed, and lists the distance from the first stop to every known system. It reads the systems, jump points, Lagrange points, bodies, waypoints and fleets of the save and the game\'s galactic map positions. Routes and times are the planner\'s own under the rules in the footers; the save is only read.',
    usage: [
      'Route picks the fewest jumps, the shortest distance or the fastest time; Speed sets the km/s the times use, typed or taken from a ship class; Route options sets civilian shipping, stabilised jump points only and the use of Lagrange points; Reverse the stops turns the route round.',
      'Stops lists the places the route visits in order, with the leg to the next; Add stop appends a place, each stop can be changed, moved or removed, and Return to start makes the route a cycle.',
      'Route map shades the known systems by distance from the first stop and draws the route across them; click a system to add it as the last stop.',
      'Route detail, shown once a route exists, lists it leg by leg with the jump points passed and the distance and time along the way; a leg expands or collapses, and a system name opens the Galaxy Map.',
      'Distances from the first stop lists every known system with its jumps, distance and travel time by explored routes; Search narrows it, and click a row to add that system as the last stop.',
      'A leg with no explored route is bridged by a straight line on the map and has no time; the footer of Route detail says how the delay after a jump is counted.',
    ],
    terms: ['jump-point', 'speed', 'lagrange-point', 'estimated-output'],
    links: RESOURCES,
  },
  '/lagrange': {
    overview: 'Lagrange Points maps the stable Lagrange points of the known systems, the planets and moons that could be given one and the time a stabilisation ship would take, and lists the infrastructure the race holds at each jump point. It reads the systems, bodies, Lagrange points, jump points, fleets, stabilisation modules and stationary salvos of the save. Stabilisation times are estimates under the rule in the footer; the save is only read.',
    usage: [
      'Lagrange map shades each known system by how many stable points it has; click a system to list its planets and moons below.',
      'Planets and moons lists the bodies To stabilise, the Stable ones or All, limited to Systems with colonies if wanted and narrowed by Search; the chip beside the title clears the system, and each body links to the Colonization Planner and the Galaxy Map.',
      'Stabilisation ships, shown where the race has ships with a stabilisation module, lists each with its captain, crew and activity; a fleet name opens the Route Finder.',
      'Jump point infrastructure, shown where the race has charted jump points, lists each point\'s gate status, stabilisation orders, mines, buoys and detected objects, with a link to open the point on the map.',
      'A time follows the body\'s mass and the captain and crew of the quickest usable ship, as the footer states; a count the save cannot give is unknown, never 0.',
    ],
    terms: ['lagrange-point', 'stabilisation', 'jump-point', 'estimated-output'],
    links: RESOURCES,
  },
  '/history': {
    overview: 'Empire History charts the snapshots the app records each time it reads a save of the race: population, wealth, fleet tonnage, research, minerals, installations and supplies, with the rivals\' measures where the game records them. It keeps the record in the app\'s own files by campaign and branch, with milestones, followed colonies, retention and backups, so the page needs the race recorded. The save is only read; a rewound save becomes a branch, and nothing recorded is written back.',
    usage: [
      'The span toggle (years or All) sets how far back the tiles, charts and table reach, the chart and table toggle switches the view, CSV in the toolbar downloads every snapshot kept whatever the span, and Clear removes recorded snapshots after a confirmation.',
      'Campaign says which campaign the save belongs to and its branches, and settles an ambiguous save as the same campaign merged into the branch, as a new branch or as a separate campaign; an older history can be attached to a branch.',
      'Rivals charts every race recorded in this game on one measure (population, colonies, fleet tonnage, military tonnage, research, known systems or treasury); each chart has Shown CSV and PNG exports, the Mineral stockpiles chart picks its minerals and scale, and Installations picks its types.',
      'The table view lists each snapshot\'s game time, population, colonies, treasury, tonnage, research and systems in place of the charts.',
      'Milestones pins a note to an exact game time with a type and an optional link to an object; Add milestone stores it, This branch only keeps it off other branches, and Move to this save brings a later one here.',
      'Stock rates gives how fast a stock of the Empire or of a followed Colony changed over a window of snapshots, with a depletion estimate where the decline is steady; Shown CSV and Copy text export it.',
      'Colony series chooses the colonies the app follows through the history (Follow and Stop following); nothing is kept for a colony until it is chosen.',
      'Retention shows how many samples the record keeps and how large it is, and sets a retention profile and an event archive cap after a confirmation; a smaller cap thins the record and a larger one brings nothing back.',
      'Backup exports all campaigns or this one to a file and restores from one, with a preview that chooses Merge, Replace or Keep for each branch before Apply.',
    ],
    terms: ['snapshot', 'wealth', 'research-points', 'estimated-output'],
    links: RESOURCES,
  },
  '/commanders': {
    overview: 'Commanders lists every commander of the race with rank, post, bonuses and health, finds the unassigned officers who would do a post better than its holder, and lays out the naval and ground command structure. It reads the commanders, their careers, the colonies, ships, research projects and admin commands of the save and ranks candidates as the game\'s automatic assignment does. Nothing is assigned here; the save is only read.',
    usage: [
      'Better assignments switches between Governor improvements, Specialist ships and Research, each a table of posts with the current holder, the better unassigned candidate and the gain; the links open the colony, system or technology.',
      'Roster lists the commanders of the type chosen; Unassigned only, Search names and assignments, Sort by bonus, Research field, Post, Rank and the age range narrow it, and a focused commander keeps the filters off until the chip at the top clears the focus.',
      'Former commanders lists the Prisoners, Retired, Dead and Alien prisoners with their careers; expand a row for the full career.',
      'Command structure shows the naval admin commands with their fleets and ships, or the ground formations, with the commander in each post; Shipping lines adds the lines\' fleets to the naval view, and CSV and Markdown download the structure with each entry\'s path.',
      'A candidate is ranked under the rules in each table\'s footer; a post whose holders cannot be told is not shown as vacant, and health risk is the game\'s own figure.',
    ],
    terms: ['commander-bonus', 'research-project', 'estimated-output'],
    links: RESOURCES,
  },
  '/technologies': {
    overview: 'Tech Tree shows the race\'s technologies by research field, the upgrade lines of each field level by level, and the chain of prerequisites that leads to any one technology, with the time each running project has left. It reads the technologies, research projects, labs and scientists of the save. Finish times are estimates from a project\'s RP left and the labs on it; the save is only read.',
    usage: [
      'The view toggle switches between Fields, Lines and Path, and Search technologies matches names across every field in Fields and Lines.',
      'In Fields, pick a field from the rail (or the select on a narrow window) to see its technologies under In progress, Available now, Waiting on a prerequisite, Researched and, where any are blocked, Out of reach; a search lists the matches of every field instead, and clicking a technology selects it.',
      'In progress lists the running and queued projects with their colony, scientist and time left, with links to the colony and the commander.',
      'In Lines, each field\'s upgrade lines run level by level with the next technology of each; Hide finished lines keeps the lines with work left, and a shipyard-type technology links to the Shipyard Planner.',
      'In Path, Technology chooses a target; Prerequisites draws the chain that leads to it coloured by status (scroll to zoom, drag to move, Fit to refit the graph, click a box to look at that technology), Research in this order lists what is still needed in an order that reaches it, and Opens lists what it unlocks.',
      'A notice at the top reports starting technology points the race has not spent, where the save holds them.',
    ],
    terms: ['research-project', 'research-points', 'component-design', 'estimated-output'],
    links: RESOURCES,
  },
  '/designed-tech': {
    overview: 'Designed Tech lists the component designs the race knows by category, with the figures of each type, the classes that mount them and the ships in service, and sets chosen designs side by side. It reads the designs, classes and ships of the save. Figures are as stored in the design data, the picks are kept by the app for each category and race, and the save is only read.',
    usage: [
      'Category chooses the component type, Search components narrows the table, and Filters hides obsolete, commercial or civilian designs, keeps only unused ones or shows figures per hull space; Reset filters restores the defaults.',
      'The category\'s section lists every design with its figures; expand a design for the classes that mount it, how many each ship carries and the ships in service, and a sensor or missile name opens it in the Sensor Planner or the Missile Designer.',
      'Select two or more designs to open the comparison, which tints the rows where they differ and marks the best and worst value where a figure has a better side; Clear empties the picks.',
      'Best and worst are judged only among designs of one type, and a raw total trades against size and cost, so the per hull space and per build point rows rank designs of different sizes.',
      'A figure the save does not store is a dash, never 0, and a design no longer known drops out of the picks.',
    ],
    terms: ['component-design', 'hull-space', 'build-points', 'estimated-output'],
    links: RESOURCES,
  },
  '/propulsion': {
    overview: 'Propulsion Planner searches the engine sets that give a hull its speed and range or endurance from the engine, fuel and thrust technologies the race holds, and ranks them by how little of the ship they take. It reads the race\'s technologies, its saved classes and its stock fuel tanks, and builds each engine as the game would. Every designed set is a planner estimate under the rules in the footers; nothing is designed in the game or written to the save.',
    usage: [
      'Hull in tons (or a Saved class to take the hull from), Speed in km/s, the Goal of Range or Endurance with its figure and the Cruise power set the targets; Engine options limits the engine kind, the fewest and most engines, the most of the ship the propulsion may take and the engine tried, and Stop ends a long search.',
      'Propulsion sets lists the sets found, ranked by the least HS, with Incomplete marked when the search stopped early; click a row to choose a set, expand it for its engine and tanks, and CSV downloads the sets with their marks.',
      'Mission brief writes what the ship is for as limits to meet and preferences to order by, from a preset or New, and Save keeps it for the race on every branch; every set is judged against it as meets, open or fails.',
      'Trade-off shows the sets no other beats on the share of the ship against Speed or Range, as a chart or a table, and Efficient sets keeps the sets no other beats on every axis set to Least or Most.',
      'Fuel tanks, Burn and endurance and Jump drive follow the chosen set: the stock tanks that hold its fuel in the fewest HS, its burn and endurance at full power, half power and the cruise share, and the jump drives the game would add to the finished hull.',
      'A mark beside speed, burn, range, endurance and BP says whether the figure is confirmed, estimated, assumed or unavailable; a figure with nothing to work from is a dash, never 0.',
    ],
    terms: ['engine-power', 'fuel-litres', 'speed', 'range-endurance', 'hull-space', 'build-points', 'maintenance-supply', 'estimated-output'],
    links: RESOURCES,
  },
  '/missile-designer': {
    overview: 'Missile Designer sets a saved missile beside alternatives designed from the race\'s technology, a hypothetical next level or typed figures, every column judged under one scenario of target speed, jammer, tactical modifier and signature. It reads the race\'s missiles, tech levels, sensors and fire controls from the save and rebuilds each figure from the game\'s rules. Designs and comparisons are the app\'s own records for this race and branch; nothing is designed in the game or written to the save.',
    usage: [
      'Baseline and scenario pins a saved missile as the Baseline, adds an alternative with Seed from baseline, from another Saved missile or as a Blank design, and sets the scenario: Target speed, Target missile jammer, Tactical modifier, the Point-defence figure and the Target signature.',
      'Tech levels starts each line at the level the race holds and lets it be set to another researched level or a next level not yet researched, which marks every result built on it as hypothetical.',
      'Comparison sets the baseline and the alternatives side by side, each figure with its provenance mark, and Copy summary copies the table as text.',
      'Alternatives holds one editor for each design made here: its Name, the counts and sizes of its parts, its options and whether it uses the Tech of the page or Typed tech; Remove drops it.',
      'Missile optimiser searches the engine, fuel, warhead and option sizes for one goal within the limits set and lists the best beside the efficient front; Match the baseline searches around the baseline\'s own figures, Nominate the best sets the best candidates beside the baseline as alternatives, Cancel stops a run, and Copy and CSV export the results.',
      'Launcher coverage sets the launching ship\'s fire control and search sensor beside the missile\'s own sensor and range, and Sensor sizing for the target gives the smallest search sensor and fire control that see the target at the Wanted range and Resolution, with the Sensor Planner\'s Active mode for more.',
      'Saved comparisons keeps a comparison by name with its inputs and tech levels as text and works every figure out again from the save when it is opened.',
      'A hit chance follows the game\'s combat rules under the scenario entered, and the point-defence planner figure is the app\'s own heuristic, not a game statistic; a figure the save lacks is unknown, never 0, and a run that stops early says so.',
    ],
    terms: ['speed', 'range-endurance', 'engine-power', 'fuel-litres', 'sensor-resolution', 'sensor-jammer', 'estimated-output'],
    links: RESOURCES,
  },
  '/sensors': {
    overview: 'Sensor Planner sizes the active search sensor and missile fire control that reach a wanted range against a target, the beam fire control that meets a range and tracking speed, and shows the thermal and EM signatures of the race\'s classes against passive sensors of typed strength. It reads the race\'s sensor, fire control, cloak and engine technologies, its sensor designs and its classes from the save. Every proposed sensor is a planner figure under the rules in the footers, the enemy figures are typed assumptions, and the save is only read.',
    usage: [
      'Sensor mode switches the page between Active, Passive and Beam FC; Hide obsolete leaves out obsolete designs, and the tech level controls set the levels the designs are made with, a hypothetical level marking every figure that reads it.',
      'In Active mode, choose what the sensor is sized against (Tons, Own class or Missile) with its size, the Wanted range, the Resolution (Best or one of the game\'s) and the target\'s Jammer; Sizing then lists the smallest search sensor and fire control at each legal resolution.',
      'Range curve charts or tables how far the proposed pair and each saved sensor reach the Target sizes typed; Saved pair measures a chosen Search sensor and Missile fire control against the target and names the best pair to design instead; Hardening and ECCM prices the pair at each level and says whether it still reaches the range against the jammer.',
      'Existing designs lists the active sensors and fire controls the race has researched with their reach, each linking to Designed Tech and the Tech Tree, and Classes against the proposed pair gives the reach against each class with its cloak working and damaged.',
      'In Passive mode, the Speed shares, the Enemy thermal and EM sensitivities, the Enemy active range and resolution and the Class for the speed and reduction panels are typed; Signatures lists each class\'s thermal and EM signatures and cloaked cross-section with the enemy reach against each.',
      'Speed and detection follows the chosen class from standing still to full speed against the enemy thermal sensor, Passive range charts how far the race\'s passive sensors and a Proposed sensor size detect the Target thermal and EM signatures typed, and Thermal reduction designs the class\'s engines again at each reduction level.',
      'In Beam FC mode, the Wanted range and Wanted tracking speed are sized on their own under Requirement, with Single weapon where the race has that technology; Multipliers lists the fire control at each pair of multipliers, and Existing beam fire controls judges the researched ones against what is wanted.',
      'A missile handed over from the Missile Designer shows at the top with the scenario and tech it was evaluated under, and editing a sizing input ends the handover.',
      'A blank enemy figure is unknown and never 0, a size beyond the largest legal one is reported as such; a table lists every point, while a chart leaves out the points a logarithmic axis cannot draw and the sensors beyond its series limit.',
    ],
    terms: ['hull-space', 'sensor-resolution', 'sensor-jammer', 'fire-control', 'electronic-hardening', 'engine-power', 'speed', 'observed-intel', 'estimated-output'],
    links: RESOURCES,
  },
  '/shipyards': {
    overview: 'Shipyard Planner lists the race\'s shipyards with their tasks and growth, prices every refit between its classes and says which yards can take a class or a refit now, after a retool or not at all. It reads the shipyards, slipways, tasks, classes, components and stocks of the save and prices refits, retools and growth by the game\'s rules. Prices and times are estimates with a mark where the save stores nothing to compare with; the save is only read.',
    usage: [
      'The view toggle switches the page between Yards, Growth, Refits and Class to yards.',
      'Under Yards, Shipyards lists every yard once with its tasks, its upgrade or retool and its slipway price; Free slipway only and Search narrow it, the colony chip clears a colony focus, and a yard expands to its tasks with links to the colony in Production Recap and the class in the Propulsion Planner.',
      'Under Growth, Yard growth prices adding a slipway or a capacity step to the Shipyard chosen, in build points and time, and sizes a continual target.',
      'Under Refits, Refit matrix prices every refit between the race\'s classes one direction at a time, with how many yards can take each; Within 20% of the size limits the pairs to classes of similar size, and a yard may still need a retool, as the Selected refit and the yard sections show.',
      'Selected refit shows one refit in full for the two classes chosen: its cost by part, its minerals, the components that change and the ships that would take it, with the reverse refit beside it.',
      'Yards for the selected refit sets the race\'s shipyards against that refit with the time and the retooling cost at each; under Class to yards the same section becomes Yards for a class, judging each yard on one class and one kind of work (Build, Refit to or Repair) with the reason it can or cannot take it.',
      'Platform production paths compares, colony by colony, a shipyard build and a station project for the Class and number of Platforms chosen, with the time, build points, minerals, labour and blockers of each path.',
      'Running refits and retools, shown where any run, sets the stored cost of each beside the cost the rules give, with the time left.',
      'A figure the save lacks is not known, never 0; a dash in a time means a yard\'s eligibility or rate is not known, and the footer of each section states the pricing rule.',
    ],
    terms: ['refit', 'retool', 'slipway', 'build-points', 'hull-space', 'estimated-output'],
    links: RESOURCES,
  },
})

const termById = Object.freeze(Object.fromEntries(TERMS.map((entry) => [entry.id, entry])))
const linkById = Object.freeze(Object.fromEntries(LINKS.map((entry) => [entry.id, entry])))

export { PAGE_HELP, termById, linkById }

// The pages that belong to a section of the navigation, which are the ones a help is owed to; Empires, Settings and About stand outside it.
export const helpRoutes = () => PAGES.filter(({ section, planned }) => section && !planned).map(({ route }) => route)

// The help of a route with its text, terms and links in full: { route, title, overview, usage, terms, links }, or null for a route with none.
export const helpFor = (route) => {
  const entry = PAGE_HELP[route]
  const page = PAGES.find((item) => item.route === route)

  if (!entry || !page) {
    return null
  }

  return {
    route,
    title: page.title,
    overview: entry.overview,
    usage: entry.usage,
    terms: entry.terms.map((id) => termById[id]),
    links: entry.links.map((id) => linkById[id]),
  }
}
