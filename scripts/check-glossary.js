/*
  Checks the local glossary and the page help built on it (src/renderer/utilities/glossary.js, src/renderer/components/page/HelpPanel.vue, mounted by SectionNav.vue). Needs no save and no network; the addresses it holds are checked for their form, not opened.

  What it holds the glossary to:
  - every page of the registry that belongs to a section has a help entry with terms and links, every entry names terms and links that exist, and none stands unused or for a page that is gone;
  - the unit and estimate terms the planning pages need (cost, runway, maintenance, estimated outputs) are mapped to the pages that show them;
  - every term has a local definition of its own, a reviewed date and a game version label, and every link a title, a note on what it covers, an https address, a reviewed date, a version label and a version status, with material written before any 2.7 release marked older;
  - the help speaks in the impersonal voice, and a definition is short, original text with no address in it;
  - links and provenance stay apart: no glossary entry names a rule or a verification, no link's text claims to verify a figure, and no registered rule cites a glossary link;
  - the figures a definition states hold in the app's own rules: the shortage and the hauling shortfall of a colony, the runway of a mineral and of a maintenance location, the RP left and the time left of research, and the climb of maintenance life are run on small made-up rows and held to what the definitions say (no source text is matched).

  Then each mutation (an entry dropped, a date or version label removed, a link made http or left undated, an older link marked current, a first-person phrase, a link cited as a rule's source, or an expression of one of those rules changed) must make at least one check fail.

  Usage: node scripts/check-glossary.js
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { inParallel, runChild } = require('./lib/check-pool')

const rendererDirectory = path.resolve(__dirname, '..', 'src', 'renderer')
const MODULES = ['glossary', 'navigation', 'provenance']
const RULE_MODULES = ['logistics', 'research', 'colony-minerals', 'haul-plan', 'mineral-outlook', 'design-rules']
const COPIED = ['utilities', path.join('components', 'page')]

const HELP_PANEL = path.join('components', 'page', 'HelpPanel.vue')

// The packages the utilities import, as the least a load of them needs: dates, numerals and the store are never used by a case here.
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  'lodash/groupBy': 'export default (list, by) => list.reduce((groups, item) => { (groups[by(item)] = groups[by(item)] || []).push(item); return groups }, {})',
}

// What each page owes its readers beyond some term and some link: the terms of its cost, runway, maintenance and wealth units, and the estimate term every page of calculated figures carries. The game log lists events and calculates nothing.
const REQUIRED_TERMS = {
  '/production': ['build-points', 'research-points', 'production-capacity'],
  '/mineral-outlook': ['runway', 'mining-rate'],
  '/minerals': ['accessibility', 'deposit'],
  '/finances': ['wealth', 'production-cycle'],
  '/logistics': ['maintenance-supply', 'maintenance-life', 'fuel-litres'],
  '/habitability': ['colony-cost', 'body-capacity'],
  '/propulsion': ['engine-power', 'range-endurance', 'fuel-litres'],
  '/shipyards': ['refit', 'retool', 'build-points'],
}
const WITHOUT_ESTIMATES = ['/log', '/notebook']

const MAX_DEFINITION = 560
const MAX_COVERS = 200

const FIRST_OR_SECOND_PERSON = /\b(?:me|my|myself|we|our|ours|ourselves|us|you|your|yours|yourself|yourselves)\b|\bmine\b(?=\s*(?:[.,;:!?)]|$))/i
const FIRST_PERSON_I = /\bI(?:['’](?:m|ll|ve|d))?\b/
const VERIFICATION_CLAIM = /\b(?:verif\w*|confirm\w*|prov(?:e|es|ed|en|ing)|validat\w*|authoritative|checked against|official formula)\b/i
const FORBIDDEN_FIELDS = ['rule', 'rules', 'verification', 'verifies', 'verifiedBy', 'provenance']

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const text = (value) => typeof value === 'string' && value.trim().length > 0

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    return false
  }

  const date = new Date(`${value}T00:00:00Z`)

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10)
}

// The first problem of a list of [label, problem] pairs, or true.
const firstProblem = (problems) => {
  const found = problems.find(([, problem]) => problem)

  return found ? `${found[0]}: ${found[1]}` : true
}

const phraseOf = (value) => (value === undefined || value === null ? '' : String(value))

const voiceProblem = (value) => {
  const found = FIRST_OR_SECOND_PERSON.exec(value) || FIRST_PERSON_I.exec(value)

  return found ? `"${found[0]}" in "${value.slice(0, 70)}"` : ''
}

// The text a reader of the help card sees that is written in its template: the words between tags, and the literal title and label attributes.
const templateText = (source) => {
  const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'))
  const words = template.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/<[^>]*>/g, ' ')
  const attributes = [...template.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)].map(([, value]) => value)

  return [words.replace(/\s+/g, ' ').trim(), ...attributes]
}

const REGISTERS_RULE = /\bregisterRule\(/

// The utility modules a rule is registered in, as the names `loadUtilities` takes ('warnings/common'): found by the call every rule file makes, so that a new rule file is loaded without a list to keep.
const ruleModuleNames = (directory) => {
  const found = []

  const walk = (folder) => {
    for (const entry of fs.readdirSync(path.join(directory, folder), { withFileTypes: true })) {
      const file = path.join(folder, entry.name)

      if (entry.isDirectory()) {
        walk(file)
      } else if (entry.name.endsWith('.js') && REGISTERS_RULE.test(fs.readFileSync(path.join(directory, file), 'utf8'))) {
        found.push(file.replace(/\\/g, '/').replace(/\.js$/, ''))
      }
    }
  }

  walk('')

  return found
}

// Every module the checks run: the glossary and the registry of pages, the rules whose figures the definitions state, and every module that registers a rule, which the check of the glossary's links against the rules needs. `ruleModules` is the discovery of the tree, made once and handed to each child, since a mutation never changes whether a file registers a rule (mutatedCopy refuses one that would).
const loadModules = (directory, ruleModules) => loadUtilities([...new Set([...MODULES, ...RULE_MODULES, ...ruleModules])], { stubs: STUBS, directory })

// The checks that need no save, over the modules `m` ({ glossary, navigation }) and the renderer folder `tree` they and the component sources were read from: [[name, async () => true or a message]]. Run on the real sources and again on each mutated copy, where one at least must fail.
const synthetic = (m, tree) => {
  const { TERMS, LINKS, PAGE_HELP, GAME_VERSION, VERSION_STATUS, VERSION_STATUS_TEXT, OLDER_THAN_GAME_BEFORE, helpFor, helpRoutes } = m.glossary
  const read = (file) => fs.readFileSync(path.join(tree, file), 'utf8')
  const panel = () => read(HELP_PANEL)
  const { provenance, logistics, research, 'colony-minerals': colonyMineralRules, 'haul-plan': haulPlan, 'mineral-outlook': mineralOutlook, 'design-rules': designRules } = m
  const definitionOf = (id) => (TERMS.find((item) => item.id === id) || { definition: '' }).definition
  const says = (id, ...phrases) => phrases.map((phrase) => [`${id} definition`, definitionOf(id).includes(phrase) ? '' : `does not say "${phrase}"`])
  const planners = helpRoutes()
  const statuses = Object.values(VERSION_STATUS)

  return [
    ['the registry has planner routes to cover', async () => (planners.length >= 20 ? true : `${planners.length} routes`)],

    ['every planner route of the registry has help with terms and links', async () => firstProblem(planners.map((route) => {
      const help = helpFor(route)

      return [route, !help ? 'no entry' : help.terms.length === 0 ? 'no terms' : help.links.length === 0 ? 'no links' : '']
    }))],

    ['no help is kept for a route the registry does not list as a planner', async () => firstProblem(Object.keys(PAGE_HELP).map((route) => [route, planners.includes(route) ? '' : 'not a planner route of the registry']))],

    ['every term and link a page names exists', async () => firstProblem(Object.entries(PAGE_HELP).flatMap(([route, entry]) => [
      ...entry.terms.map((id) => [`${route} term`, TERMS.some((item) => item.id === id) ? '' : `${id} is not defined`]),
      ...entry.links.map((id) => [`${route} link`, LINKS.some((item) => item.id === id) ? '' : `${id} is not defined`]),
    ]))],

    ['no page lists a term or a link twice', async () => firstProblem(Object.entries(PAGE_HELP).flatMap(([route, entry]) => [
      [`${route} terms`, new Set(entry.terms).size === entry.terms.length ? '' : 'a term is repeated'],
      [`${route} links`, new Set(entry.links).size === entry.links.length ? '' : 'a link is repeated'],
    ]))],

    ['every term and link is shown on some page', async () => {
      const usedTerms = new Set(Object.values(PAGE_HELP).flatMap((entry) => entry.terms))
      const usedLinks = new Set(Object.values(PAGE_HELP).flatMap((entry) => entry.links))

      return firstProblem([
        ...TERMS.map((item) => [`term ${item.id}`, usedTerms.has(item.id) ? '' : 'shown on no page']),
        ...LINKS.map((item) => [`link ${item.id}`, usedLinks.has(item.id) ? '' : 'shown on no page']),
      ])
    }],

    ['the unit, cost, runway and maintenance terms are mapped to the pages that show them', async () => firstProblem(Object.entries(REQUIRED_TERMS).flatMap(([route, ids]) => ids.map((id) => [route, helpFor(route) && helpFor(route).terms.some((item) => item.id === id) ? '' : `lacks ${id}`])))],

    ['every page of calculated figures carries the estimated-figure term', async () => firstProblem(planners.filter((route) => !WITHOUT_ESTIMATES.includes(route)).map((route) => [route, helpFor(route) && helpFor(route).terms.some((item) => item.id === 'estimated-output') ? '' : 'lacks estimated-output']))],

    ['term ids are unique and well formed', async () => firstProblem([
      ['ids', new Set(TERMS.map((item) => item.id)).size === TERMS.length ? '' : 'an id is repeated'],
      ...TERMS.map((item) => [item.id, /^[a-z]+(?:-[a-z]+)*$/.test(item.id) ? '' : 'not kebab case']),
    ])],

    ['every term has a name, a local definition of its own, a reviewed date and a game version label', async () => firstProblem(TERMS.flatMap((item) => [
      [`${item.id} term`, text(item.term) ? '' : 'no name'],
      [`${item.id} definition`, text(item.definition) && item.definition.trim().length >= 40 ? '' : 'missing or too short to stand alone'],
      [`${item.id} reviewed`, validDate(item.reviewed) ? '' : `not a past date: ${phraseOf(item.reviewed)}`],
      [`${item.id} versions`, /^\d+\.\d+\.x$/.test(phraseOf(item.versions)) ? '' : `not a version label: ${phraseOf(item.versions)}`],
    ]))],

    ['the glossary is reviewed against the game version the app targets', async () => firstProblem(TERMS.map((item) => [item.id, item.versions === GAME_VERSION ? '' : `${item.versions} is not ${GAME_VERSION}`]))],

    ['a definition is short text of its own with no address and no quotation block', async () => firstProblem(TERMS.map((item) => [item.id, item.definition.length > MAX_DEFINITION ? `${item.definition.length} characters` : /https?:|www\./i.test(item.definition) ? 'holds an address' : /\n/.test(item.definition) ? 'spans lines' : '']))],

    ['link ids are unique and every address is unique', async () => firstProblem([
      ['ids', new Set(LINKS.map((item) => item.id)).size === LINKS.length ? '' : 'an id is repeated'],
      ['addresses', new Set(LINKS.map((item) => item.url)).size === LINKS.length ? '' : 'an address is repeated'],
    ])],

    ['every link has a title, a source, a note on what it covers, a reviewed date and a version label', async () => firstProblem(LINKS.flatMap((item) => [
      [`${item.id} title`, text(item.title) ? '' : 'missing'],
      [`${item.id} source`, text(item.source) ? '' : 'missing'],
      [`${item.id} covers`, text(item.covers) ? (item.covers.length > MAX_COVERS ? `${item.covers.length} characters` : '') : 'missing'],
      [`${item.id} reviewed`, validDate(item.reviewed) ? '' : `not a past date: ${phraseOf(item.reviewed)}`],
      [`${item.id} gameVersion`, text(item.gameVersion) ? '' : 'missing'],
      [`${item.id} status`, statuses.includes(item.status) ? '' : `unknown status ${phraseOf(item.status)}`],
    ]))],

    ['every link address is https', async () => firstProblem(LINKS.map((item) => {
      try {
        const url = new URL(item.url)

        return [item.id, url.protocol !== 'https:' ? `${url.protocol} address` : !url.hostname.includes('.') ? 'host without a domain' : url.username || url.password ? 'holds credentials' : '']
      } catch (error) {
        return [item.id, `not an address: ${phraseOf(item.url)}`]
      }
    }))],

    ['the date a link was reached is null, or a past date no later than its review', async () => firstProblem(LINKS.map((item) => [item.id, item.reached === null || (validDate(item.reached) && item.reached <= item.reviewed) ? '' : `reached ${phraseOf(item.reached)}`]))],

    ['a link has a written month or none, and material written before any 2.7 release is marked older', async () => firstProblem(LINKS.map((item) => {
      if (item.written !== null && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(phraseOf(item.written))) {
        return [item.id, `written ${phraseOf(item.written)} is not a month`]
      }

      return [item.id, item.written !== null && item.written < OLDER_THAN_GAME_BEFORE && item.status !== VERSION_STATUS.OLDER ? `written ${item.written} but not marked older` : '']
    }))],

    ['the older status reads as older on screen and every status has its words', async () => firstProblem([
      ...statuses.map((status) => [`status ${status}`, text(VERSION_STATUS_TEXT[status]) ? '' : 'no words']),
      ['older words', /older/i.test(VERSION_STATUS_TEXT[VERSION_STATUS.OLDER] || '') ? '' : 'do not say older'],
    ])],

    ['the help speaks in the impersonal voice', async () => firstProblem([
      ...TERMS.flatMap((item) => [item.term, item.units, item.definition].map((value) => [`term ${item.id}`, voiceProblem(value)])),
      ...LINKS.flatMap((item) => [item.title, item.source, item.covers, item.gameVersion].map((value) => [`link ${item.id}`, voiceProblem(value)])),
      ...Object.values(VERSION_STATUS_TEXT).map((value) => ['status words', voiceProblem(value)]),
      ...templateText(panel()).map((value) => ['card', voiceProblem(value)]),
    ])],

    ['no entry names a rule or a verification, and no link text claims to verify a figure', async () => firstProblem([
      ...[...TERMS, ...LINKS].flatMap((item) => FORBIDDEN_FIELDS.map((field) => [`${item.id}`, Object.prototype.hasOwnProperty.call(item, field) ? `has a ${field} field` : ''])),
      ...LINKS.flatMap((item) => [item.title, item.covers, item.gameVersion].map((value) => [`link ${item.id}`, VERIFICATION_CLAIM.test(value) ? `says "${VERIFICATION_CLAIM.exec(value)[0]}"` : ''])),
    ])],

    ['no registered rule cites a glossary link', async () => {
      const hosts = [...new Set(LINKS.map((item) => new URL(item.url).hostname))]
      const rules = provenance.listRules()

      return firstProblem([
        ['rules', rules.length >= 100 ? '' : `${rules.length} rules loaded`],
        ...rules.flatMap((rule) => hosts.map((host) => [rule.id, JSON.stringify(rule).includes(host) ? `names ${host}` : ''])),
      ])
    }],

    ['a hauling shortfall counts stock and mass-driver packets as held, as its definition says', async () => {
      const of = (stock, inbound, needs, reserve) => haulPlan.shortfallOf({ stock, inbound, needs, reserve })
      const gives = (label, got, queue, reserve) => [label, got.queue === queue && got.reserve === reserve ? '' : `gives ${got.queue} for the queue and ${got.reserve} for the reserve, not ${queue} and ${reserve}`]

      return firstProblem([
        gives('stock and packets held', of(10, 50, 100, 0), 40, 0),
        gives('packets cover the queue', of(10, 500, 100, 0), 0, 0),
        gives('reserve beyond the need', of(10, 0, 20, 100), 10, 80),
        gives('reserve beyond the stock', of(50, 0, 20, 100), 0, 50),
        gives('reserve beyond stock and packets', of(50, 30, 20, 100), 0, 20),
        ...says('haul-shortfall', 'mass-driver packets', 'larger of that held amount', 'Freighter cargo already under way is not counted'),
      ])
    }],

    ['a mineral shortage is the stock alone short of the queue by a ton, as its definition says', async () => {
      const { colonyMinerals } = colonyMineralRules
      const name = colonyMinerals({})[0].name
      const stateOf = (stock, needs, inbound = 0) => colonyMinerals({ [name]: stock }, { [name]: needs }, { [name]: inbound })[0].state

      return firstProblem([
        ['short by a ton', stateOf(99, 100) === 'short' ? '' : `is ${stateOf(99, 100)}`],
        ['short by less than a ton', stateOf(99.5, 100) === 'short' ? 'is short by under a ton' : ''],
        ['packets on their way', stateOf(10, 100, 500) === 'short' ? '' : `is ${stateOf(10, 100, 500)} with packets on their way`],
        ...says('mineral-shortage', 'at least a ton', 'does not change that'),
      ])
    }],

    ['the runway of a maintenance location is the stock and spare MSP over upkeep less production, as its definitions say', async () => {
      const colony = { PopulationID: 1, SystemBodyID: 1, MaintenanceFacilities: 1, MSPProduction: 10, MaintProdStatus: 1, MaintenanceStockpile: 100, Mines: 0, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6, Efficiency: 1, CapacityModifier: 1, EconomicProdModifier: 1, MaintenanceCapacity: 50, WarningMSP: 0 }
      const placeOf = (upkeep) => logistics.maintenanceLocations({ colonies: [colony], fleets: [{ FleetID: 1, SystemID: 1, OrbitBodyID: 1, MaintainedTons: 50, MaintainedShips: 1, AnnualMSP: upkeep, MaintenanceModules: 0, SupplyMSP: 5 }], modifierOf: () => 1, maintenanceCapacity: 50, economicModifier: 1 })[0]
      const { production } = placeOf(0)

      if (!(production >= 1)) {
        return `the case colony makes ${production} MSP, so it cannot set production against upkeep`
      }

      const loss = placeOf(production + 10)

      return firstProblem([
        ['upkeep', loss.upkeep === production + 10 ? '' : `upkeep is ${loss.upkeep}`],
        ['net', loss.net === -10 ? '' : `net is ${loss.net}, not upkeep less production`],
        ['runway', loss.runway === 10.5 ? '' : `runway is ${loss.runway} years, not 105 over the loss of 10`],
        ['production meets upkeep', placeOf(production).runway === null ? '' : 'has a runway where production meets upkeep'],
        ['production beats upkeep', placeOf(production - 1).runway === null ? '' : 'has a runway where production is the larger'],
        ...says('runway', 'upkeep less production'),
        ...says('maintenance-supply', 'upkeep less production', 'does not run out while production meets upkeep'),
      ])
    }],

    ['the runway of a mineral is the stock over the yearly loss, endless without a loss and unknown for an unknown input, as its definition says', async () => {
      const { ofRule, unavailable } = provenance
      const known = (value) => ofRule({ rule: 'mineral.stock', value, inputs: { present: ['a figure'] } })
      const unknown = unavailable({ rule: 'mineral.stock', missing: ['a figure'] })
      const runway = (stock, net) => mineralOutlook.runwayResult(stock, net)

      return firstProblem([
        ['a loss', runway(known(100), known(-20)).value === 5 ? '' : `is ${runway(known(100), known(-20)).value}, not the stock over the loss`],
        ['a gain', runway(known(100), known(5)).value === Infinity ? '' : 'ends where the stock grows'],
        ['no change', runway(known(100), known(0)).value === Infinity ? '' : 'ends where the stock holds'],
        ['an unknown net', runway(known(100), unknown).status === 'unavailable' ? '' : 'has a figure for an unknown net'],
        ['an unknown stock', runway(unknown, known(-20)).status === 'unavailable' ? '' : 'has a figure for an unknown stock'],
        ...says('runway', 'the stock over the net loss', 'unknown, never 0'),
      ])
    }],

    ['the RP left is the stored remainder or the cost less banked points, and the time left is that over the rate, as the definitions say', async () => {
      const tech = { TechSystemID: 1, Name: 'Tech', DevelopCost: 100, FieldID: 1, TechTypeID: 1, TypeName: 'Type', RaceID: 0, Prerequisite1: 0, Prerequisite2: 0 }
      const project = { ProjectID: 1, Name: 'Lasers', CommanderID: 9, ResearchBonus: 1, ScientistField: 1, FieldID: 1, OutputPerLab: 10, Facilities: 3, Pause: 0, ResearchPointsRequired: 300, LocalConstructField: null, LocalConstructBonus: null }
      const remaining = (state) => research.evaluateResearch(research.buildTechGraph([tech]), research.researchState({ raceId: 1, researched: [], ...state })).get(1).remaining
      const years = (left) => research.scheduleProjects([{ ...project, ResearchPointsRequired: left }], [], new Map())[0].yearsResult.value

      return firstProblem([
        ['a running project', remaining({ projects: [{ TechID: 1, ResearchPointsRequired: 40 }] }) === 40 ? '' : 'is not the stored remainder'],
        ['paused research', remaining({ paused: [{ TechSystemID: 1, PointsAccumulated: 30 }] }) === 70 ? '' : 'is not the cost less the banked points'],
        ['a tech not begun', remaining({}) === 100 ? '' : 'is not the whole cost'],
        ['time left', years(60) === 2 && years(300) === 10 ? '' : `is ${years(60)} and ${years(300)} years for 60 and 300 RP at 30 a year`],
        ...says('research-points', 'still to pay'),
        ...says('research-project', 'stored remainder of a running project', 'less the points banked in paused research'),
      ])
    }],

    ['the failure rate and the draw of maintenance life climb every year, as the definition says', async () => {
      const series = designRules.maintenanceLifeSeries({ commercial: false, baseFailureChance: 10, averageRepairCost: 5, maintSupplies: 100 })

      if (series.status === 'unavailable') {
        return `has no figure: ${series.inputs.missing.join(', ')}`
      }

      const { years } = series.value
      const climbs = (key) => years.every((year, index) => index === 0 || year[key] > years[index - 1][key])

      return firstProblem([
        ['years', years.length >= 3 ? '' : `${years.length} years`],
        ['failure rate', climbs('failureRate') ? '' : 'does not climb every year'],
        ['draw', climbs('supplyUse') ? '' : 'does not grow every year'],
        ...says('maintenance-life', 'climbs every year', 'year on year'),
      ])
    }],

    ['helpFor gives a route its entry in full and nothing for an unlisted route', async () => {
      const help = helpFor(planners[0])

      return firstProblem([
        ['entry', help && help.title && help.terms.every((item) => item.definition) && help.links.every((item) => item.url) ? '' : 'incomplete'],
        ['unlisted', helpFor('/no-such-page') === null && helpFor('/settings') === null ? '' : 'an unlisted route has help'],
      ])
    }],
  ]
}

// A copy of the folders the checks read, in the temp folder, in which `file` ('utilities/glossary.js') has `from` replaced by `to`.
const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-glossary-mutant-'))

  COPIED.forEach((folder) => fs.cpSync(path.join(rendererDirectory, folder), path.join(directory, folder), { recursive: true }))

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (source.split(from).length !== 2) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation of ${file} does not apply exactly once: ${from}`)
  }

  const changed = source.replace(from, () => to)

  if (REGISTERS_RULE.test(source) !== REGISTERS_RULE.test(changed)) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation of ${file} changes whether it registers a rule, which the rule modules found once for the real tree would miss: ${from}`)
  }

  fs.writeFileSync(target, changed)

  return directory
}

const GLOSSARY = path.join('utilities', 'glossary.js')

// The source text the mutations replace: [label, file, from, to, the checks it must break, each named by a part of the check's name]. A mutation counts as caught only when those checks fail, so a failure that has nothing to do with it cannot stand in for it.
const MUTATIONS = [
  ['a planner page loses its entry', GLOSSARY, '\'/lagrange\': {', '\'/lagrange-gone\': {', ['every planner route of the registry has help', 'no help is kept for a route']],
  ['a planner page is added to the registry with no entry', path.join('utilities', 'navigation.js'), '  { route: \'/\', section: null,', '  { route: \'/new-planner\', section: \'design\', tab: \'New\', title: \'New Planner\', icon: \'mdi-help\', blurb: \'x\', keywords: \'x\' },\n  { route: \'/\', section: null,', ['every planner route of the registry has help']],
  ['a page names a term that is not defined', GLOSSARY, '[\'game-log\', \'production-cycle\', \'cease-fire\', \'fleet-cease-fire\', \'ship-open-fire\', \'game-events-window\']', '[\'game-log-missing\', \'production-cycle\', \'cease-fire\', \'fleet-cease-fire\', \'ship-open-fire\', \'game-events-window\']', ['every term and link a page names exists']],
  ['a term is no longer shown on any page', GLOSSARY, '\'/log\': { terms: [\'game-log\', \'production-cycle\', \'cease-fire\', \'fleet-cease-fire\', \'ship-open-fire\', \'game-events-window\']', '\'/log\': { terms: [\'production-cycle\', \'cease-fire\', \'fleet-cease-fire\', \'ship-open-fire\', \'game-events-window\']', ['every term and link is shown on some page']],
  ['the runway term leaves the Mineral Outlook', GLOSSARY, '\'/mineral-outlook\': { terms: [\'runway\', ', '\'/mineral-outlook\': { terms: [', ['mapped to the pages that show them']],
  ['a term loses its reviewed date', GLOSSARY, 'versions: GAME_VERSION, reviewed })', 'versions: GAME_VERSION })', ['every term has a name']],
  ['a term loses its version label', GLOSSARY, 'units, definition, versions: GAME_VERSION, ', 'units, definition, ', ['every term has a name', 'the glossary is reviewed against the game version']],
  ['a term loses its local definition', GLOSSARY, 'units, definition, versions', 'units, definition: \'\', versions', ['every term has a name']],
  ['a definition holds an address', GLOSSARY, 'The mass unit of ships, cargo and minerals;', 'See https://example.com for the mass unit of ships, cargo and minerals;', ['a definition is short text of its own']],
  ['a definition speaks in the first person', GLOSSARY, 'The mass unit of ships, cargo and minerals;', 'The mass unit of my ships, cargo and minerals;', ['the help speaks in the impersonal voice']],
  ['a definition speaks to the reader', GLOSSARY, 'A ship that houses population aboard.', 'A ship that houses your population aboard.', ['the help speaks in the impersonal voice']],
  ['a link is http', GLOSSARY, '\'https://aurora4x.com/\'', '\'http://aurora4x.com/\'', ['every link address is https']],
  ['a link loses its reviewed date', GLOSSARY, 'Object.freeze({ reviewed: REVIEWED, reached: REVIEWED, written: null, ...fields })', 'Object.freeze({ reached: REVIEWED, written: null, ...fields })', ['every link has a title']],
  ['a link loses its version label', GLOSSARY, 'gameVersion: \'Live discussion, not tied to one release\', ', '', ['every link has a title']],
  ['an old tutorial is marked current', GLOSSARY, 'written: \'2023-03\', gameVersion: \'C# edition, March 2023; no release number given\', status: VERSION_STATUS.OLDER }),\n  link({ id: \'tutorial-gameplay\'', 'written: \'2023-03\', gameVersion: \'C# edition, March 2023; no release number given\', status: VERSION_STATUS.CURRENT }),\n  link({ id: \'tutorial-gameplay\'', ['material written before any 2.7 release is marked older']],
  ['the older words stop saying older', GLOSSARY, 'Older than 2.7: rules and menus may differ', 'Rules and menus may differ', ['the older status reads as older']],
  ['a link claims to verify a formula', GLOSSARY, 'An index of written and video tutorials, playthroughs, forums and the wiki.', 'Verifies the formulas, with tutorials, playthroughs, forums and the wiki.', ['no link text claims to verify a figure']],
  ['a link names a rule', GLOSSARY, 'link({ id: \'community-forum\', ', 'link({ rule: \'finances.treasury\', id: \'community-forum\', ', ['no entry names a rule or a verification']],
  ['a rule cites a glossary link', path.join('utilities', 'finances.js'), 'The race\\\'s stored treasury, shown as saved.', 'The race\\\'s stored treasury, shown as saved, as explained at https://7w1.github.io/posts/resources/.', ['no registered rule cites a glossary link']],
  ['the help card speaks to the reader', HELP_PANEL, 'Definitions of the terms and units on this page', 'Your definitions of the terms and units on this page', ['the help speaks in the impersonal voice']],
  ['the shortage rule starts counting packets on their way', path.join('utilities', 'colony-minerals.js'), 'state: stockState(values, exporting)', 'state: stockState({ ...values, stock: values.stock + values.inbound }, exporting)', ['a mineral shortage is']],
  ['the shortage rule wants two tons', path.join('utilities', 'colony-minerals.js'), 'if (needs - stock >= 1) {', 'if (needs - stock >= 2) {', ['a mineral shortage is']],
  ['the haul plan stops counting packets as held', path.join('utilities', 'haul-plan.js'), 'const held = mineral.stock + mineral.inbound', 'const held = mineral.stock', ['a hauling shortfall counts']],
  ['the haul plan measures the reserve against the stock alone', path.join('utilities', 'haul-plan.js'), 'mineral.reserve - Math.max(held, mineral.needs)', 'mineral.reserve - held', ['a hauling shortfall counts']],
  ['the MSP runway divides by upkeep', path.join('utilities', 'logistics.js'), '(stock.value + supply.value) / -net', '(stock.value + supply.value) / upkeep', ['the runway of a maintenance location']],
  ['a location that breaks even gets a runway', path.join('utilities', 'logistics.js'), 'net === null || net >= 0 ? null', 'net === null || net > 0 ? null', ['the runway of a maintenance location']],
  ['the net MSP is taken the wrong way round', path.join('utilities', 'logistics.js'), 'compute: (values) => values.production - values.upkeep', 'compute: (values) => values.upkeep - values.production', ['the runway of a maintenance location']],
  ['the mineral runway divides by the net itself', path.join('utilities', 'mineral-outlook.js'), '/ -values[\'yearly net\']', '/ values[\'yearly net\']', ['the runway of a mineral']],
  ['a mineral with no loss gets a number', path.join('utilities', 'mineral-outlook.js'), ' : Infinity) })', ' : 0) })', ['the runway of a mineral']],
  ['the RP left becomes the whole cost', path.join('utilities', 'research.js'), 'return isKnownNumber(left) ? left : null', 'return isKnownNumber(left) ? tech.cost : null', ['the RP left is']],
  ['banked points stop counting', path.join('utilities', 'research.js'), 'Math.max(0, tech.cost - banked)', 'tech.cost', ['the RP left is']],
  ['the time to pay multiplies instead of dividing', path.join('utilities', 'research.js'), 'values.left / values.rate', 'values.left * values.rate', ['the RP left is']],
  ['the failure rate stops growing with the years', path.join('utilities', 'design-rules.js'), 'const failureRate = Number(baseFailureChance) * year / 100', 'const failureRate = Number(baseFailureChance) / 100', ['the failure rate and the draw of maintenance life']],
]

const runChecks = async (modules, tree) => {
  const results = []

  for (const [name, run] of synthetic(modules, tree)) {
    let result

    try {
      result = await run()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

const RESULT_PREFIX = 'GLOSSARY-RESULT '

// The checks of one tree of the renderer's sources in a Node process of their own, as [[name, result]]: the rule registry is a module-level map, so rules a mutant overwrites would otherwise stay for every tree run after it.
const checksInChild = async (tree, ruleModules) => {
  const { code, stdout, stderr } = await runChild(__filename, [], { env: { GLOSSARY_TREE: tree, GLOSSARY_RULE_MODULES: JSON.stringify(ruleModules) } })
  const line = stdout.split('\n').find((row) => row.startsWith(RESULT_PREFIX))

  if (code !== 0 || !line) {
    throw new Error(`The checks of ${tree} ended with ${code}: ${stderr.trim().slice(0, 300)}`)
  }

  return JSON.parse(line.slice(RESULT_PREFIX.length))
}

const failedNames = (results) => results.filter(([, result]) => result !== true).map(([name]) => name)

// One mutation in a fresh process: [label, true or what is wrong, detail]. The checks it must break (each named by a part of the name) must be among those that fail.
const tryMutation = async ([label, file, from, to, expected], ruleModules) => {
  let directory

  try {
    directory = mutatedCopy(file, from, to)

    const failed = failedNames(await checksInChild(directory, ruleModules))
    const missed = expected.filter((part) => !failed.some((name) => name.includes(part)))

    return [label, missed.length ? `does not break "${missed.join('", "')}"; the checks that fail: ${failed.join('; ') || 'none'}` : true, `${failed.length} checks fail`]
  } catch (error) {
    return [label, error.message, '']
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const run = async () => {
  if (process.env.GLOSSARY_TREE) {
    const tree = process.env.GLOSSARY_TREE
    const modules = await loadModules(path.join(tree, 'utilities'), JSON.parse(process.env.GLOSSARY_RULE_MODULES))

    console.log(RESULT_PREFIX + JSON.stringify(await runChecks(modules, tree)))
    process.exit(0)
  }

  const ruleModules = ruleModuleNames(path.join(rendererDirectory, 'utilities'))

  // The mutations and the control run in children, side by side, while this process runs the checks of the real sources; the results print in order.
  const children = inParallel([...MUTATIONS, null], (mutation) => (mutation ? tryMutation(mutation, ruleModules) : checksInChild(rendererDirectory, ruleModules)))
  const modules = await loadModules(path.join(rendererDirectory, 'utilities'), ruleModules)

  for (const [name, result] of await runChecks(modules, rendererDirectory)) {
    check(name, result)
  }

  const results = await children
  const control = results.pop()

  for (const [label, result, detail] of results) {
    check(`mutation caught: ${label}`, result, detail)
  }

  if (control instanceof Error) {
    throw control
  }

  const uncaught = failedNames(control)

  check('a fresh process on the unchanged sources passes every check', uncaught.length === 0 ? true : `fails ${uncaught.join('; ')}`)

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
