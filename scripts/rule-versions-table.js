/*
  Prints the registered version labels per area, separately from each rule's verification classification (confirmed, estimated or assumed). Repair and label-work tables attribute the recorded work without treating a current-line label as a fresh comparison. Needs no save and no network.

  bun scripts/rule-versions-table.js                                  prints the tables
  bun scripts/rule-versions-table.js --write docs/ARCHITECTURE.md     replaces what stands between the two markers of the file (the marker lines stay)
  bun scripts/rule-versions-table.js --check docs/ARCHITECTURE.md     checks that the generated block still matches the registered rules

  The rules are those every module that calls `registerRule` or `checksOf` registers, loaded the way the check scripts load the utilities (scripts/lib/utilities.js); a new rule module is found without a list to keep. A rule is line-labelled when its `versions` cover the stated formula version of utilities/capabilities.js, version-independent when they are 'x' and unverified otherwise. An area is the part of a rule's id before the dot, and its module the one file that registers the rule.

  RETAINED holds each older-labelled rule's findings and pending repair items. REPAIRED holds rules relabelled after an AE-311 repair. LABEL_WORK records other label work and its basis, including the brief rules and the shared population estimate. These are evidence pointers, not additional verification verdicts; docs/plans/backlog/evidence/ holds the per-rule inventories of AE-301-07, AE-301-08, AE-301-10-A through E and the AE-311 repairs. Missing/stale attributions fail the consistency check.
*/
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const utilitiesDirectory = path.join(rendererDirectory, 'utilities')

const BEGIN = '<!-- rule-versions:begin -->'
const END = '<!-- rule-versions:end -->'
const COMMAND = 'bun scripts/rule-versions-table.js --write docs/ARCHITECTURE.md'

// A module registers rules by calling `registerRule` itself or through `checksOf` (utilities/warnings/common.js), which registers the rule of each Warnings check.
const REGISTERS_RULE = /\b(?:registerRule|checksOf)\(/
const PROVENANCE_IMPORT = /from '(\.\.?\/[\w\-/]*provenance)'/

// The packages the utilities import, as the least a load of them needs: dates, numerals and the store are never used here.
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  'lodash/groupBy': 'export default (list, by) => list.reduce((groups, item) => { (groups[by(item)] = groups[by(item)] || []).push(item); return groups }, {})',
}

// The items that repair the findings that keep rules unverified, by title.
const ITEMS = Object.freeze({
  'AE-311-01': 'Research throughput, finish dates and construct semantics',
  'AE-311-02': 'Colony growth, supported population and workforce',
  'AE-311-03': 'Terraforming jobs and finish behaviour',
  'AE-311-04': 'Warnings that demand action falsely',
  'AE-311-05': 'MSP forecast safety and the facility rate',
  'AE-311-06': 'Saved fleet-order distance and cycles',
  'AE-311-07': 'Mining association and export/CMC flow',
  'AE-311-08': 'Industrial queued demand and partial installations or training',
  'AE-311-09': 'Damaged-ship MSP and the protection display',
  'AE-311-10': 'Roster and display edges and the shared decimal limiter',
  'AE-311-11': 'Thermal signature of a moving engineless ship',
  'AE-311-12': 'Pi precision',
  'AE-311-13': 'NPR and unusual coordinate-membership cases',
  'AE-311-14': 'Maintenance class and runtime model',
})

// Each rule kept on an older version, with its findings of AE-301-10: [finding, ...items that repair it]. A finding no item names stands alone.
const RETAINED = Object.freeze({
  'map.dangerFlag': [['C F5', 'AE-311-09']],
  'mineral.depositForecast': [['B04 (continuous aggregate decline; per-increment per-extractor rounding omitted; no proven error bound)']],
  'mineral.stockProjection': [['B04 (continuous aggregate decline; per-increment per-extractor rounding omitted; no proven error bound)']],
  'warnings.damagedShips': [['D-2', 'AE-311-09']],
  'warnings.summary': [['D-1, D-2, D-5, D-7 to D-9 (industrial primitives repaired; final F7/F9 closure remains)', 'AE-311-07', 'AE-311-08', 'AE-311-09']],
})

// Each rule an AE-311 item repaired and moved to the line, with the finding of AE-301-10 that had kept it unverified: [finding, item]. Add a rule here when an item moves its label; the script tells on stderr when one listed is not on the line.
const REPAIRED = Object.freeze({
  'arks.bodySpecies': ['B11', 'AE-311-13'],
  'arks.orbit': ['B11', 'AE-311-13'],
  'arks.totals': ['B11', 'AE-311-13'],
  'hauling.groupCapacity': ['B12, C F2', 'AE-311-13'],
  'mineBootstrap.import': ['B11, B06 (pi), B12', 'AE-311-13'],
  'mineBootstrap.localBuild': ['B11, B06 (pi)', 'AE-311-13'],
  'mspSupply.delivery': ['C F2', 'AE-311-13'],
  'mspSupply.supplied': ['C F2', 'AE-311-13'],
  'route.elapsedTime': ['C F2', 'AE-311-13'],
  'route.jumpShock': ['C F2', 'AE-311-13'],
  'route.jumpWait': ['C F2', 'AE-311-13'],
  'transport.fleetTrip': ['C F2', 'AE-311-13'],
  'transport.roundTrip': ['C F2', 'AE-311-13'],
  'colonies.capacity': ['B06 (pi)', 'AE-311-12'],
  'mineral.queueDemand': ['B05', 'AE-311-08'],
  'production.trainingCapacity': ['A-11', 'AE-311-08'],
  'production.trainingRate': ['A-12, A-11', 'AE-311-08'],
  'production.capacityFree': ['A-13, A-11', 'AE-311-08'],
  'warnings.freeConstructionCapacity': ['D-10', 'AE-311-08'],
  'warnings.freeOrdnanceCapacity': ['D-10', 'AE-311-08'],
  'warnings.freeFighterCapacity': ['D-10', 'AE-311-08'],
  'warnings.idleGroundTraining': ['D-11', 'AE-311-08'],
  'production.trainingFinish': ['A-10, A-11', 'AE-311-08'],
  'production.timeline': ['A-14', 'AE-311-08'],
  'colonies.committedWorkers': ['B13 (joint closure)', 'AE-311-08'],
  'commanders.age': ['A-01', 'AE-311-10'],
  'designedTech.compareVerdict': ['A-09', 'AE-311-10'],
  'designedTech.reload': ['A-09', 'AE-311-10'],
  'production.componentPlan': ['B13', 'AE-311-10'],
  'production.stockCover': ['B13, R3', 'AE-311-10'],
  'cmcPolicy.throughput': ['B10, B01', 'AE-311-07'],
  'logistics.refineryOutput': ['B02', 'AE-311-07'],
  'minerals.massDriverRate': ['B01', 'AE-311-07'],
  'warnings.massDriverOrphans': ['D-9, D-5, D-7', 'AE-311-07'],
  'warnings.miningRedeployment': ['D-8, D-5, D-7', 'AE-311-07'],
  'warnings.strandedMiners': ['D-7', 'AE-311-07'],
  'warnings.undermannedShips': ['D-1', 'AE-311-07'],
  'warnings.wastedMiningCapacity': ['D-5', 'AE-311-07'],
  'colonies.infrastructureCap': ['B08', 'AE-311-02'],
  'colonies.populationProjection': ['B07', 'AE-311-02'],
  'colonies.workers': ['B09, C F3', 'AE-311-02'],
  'colonistFloor.committed': ['C F3', 'AE-311-02'],
  'colonistFloor.outcome': ['C F3', 'AE-311-02'],
  'colonistFloor.removable': ['C F3', 'AE-311-02'],
  'colonistFloor.staffing': ['C F3', 'AE-311-02'],
  'design.averageRepairCost': ['A-07', 'AE-311-14'],
  'design.maintenanceLifeSeries': ['A-08, A-07', 'AE-311-14'],
  'design.thermalSignature': ['A-06', 'AE-311-11'],
  'habitability.bodyCapacity': ['C F1', 'AE-311-12'],
  'habitability.score': ['C F1', 'AE-311-12'],
  'hauling.colonistsMoved': ['B12', 'AE-311-06'],
  'hauling.cycleTime': ['B12', 'AE-311-06'],
  'hauling.deliveries': ['B12', 'AE-311-06'],
  'hauling.fleetFuelPerYear': ['B12', 'AE-311-06'],
  'hauling.freightMoved': ['B12', 'AE-311-06'],
  'hauling.routeDistance': ['B12', 'AE-311-06'],
  'logistics.maintenanceLocation': ['B03, B15', 'AE-311-05'],
  'logistics.mspProduction': ['B03', 'AE-311-05'],
  'mspSupply.stockOnly': ['B03, C F4', 'AE-311-05'],
  'production.jobCount': ['A-02', 'AE-311-03'],
  'production.researchFinish': ['A-04, A-03', 'AE-311-01'],
  'production.researchRate': ['A-03', 'AE-311-01'],
  'production.terraformFinish': ['A-05', 'AE-311-03'],
  'research.nextLanding': ['B14, B15', 'AE-311-01'],
  'research.output': ['B14, B15', 'AE-311-01'],
  'research.projectRate': ['B14', 'AE-311-01'],
  'shipRuntime.supplyDraw': ['R1, A-07, A-08', 'AE-311-14'],
  'warnings.deadResearchProjects': ['D-12', 'AE-311-04'],
  'warnings.idleResearchLabs': ['D-6', 'AE-311-04'],
  'warnings.knownUnexploitedConstructs': ['D-4', 'AE-311-01'],
  'warnings.stalledResearchProjects': ['D-13', 'AE-311-04'],
})

// Other recorded label work: [basis, item, expected label kind]. Stored observations and app policies are not formula repairs.
const LABEL_WORK = Object.freeze({
  'brief.classCargo': ['played-save stored-column comparison', 'AE-301-08', 'verified'],
  'brief.classClassification': ['played-save stored-column comparison', 'AE-301-08', 'verified'],
  'brief.classDeployment': ['played-save stored-column comparison', 'AE-301-08', 'verified'],
  'brief.classHangar': ['stored-column meaning', 'AE-301-10-E', 'verified'],
  'brief.classPayloadSpace': ['verified game-tied inputs and arithmetic; app residual policy', 'AE-301-10-E', 'verified'],
  'brief.classSize': ['stored-column meaning', 'AE-301-10-E', 'verified'],
  'brief.cruiseEndurance': ['verified game-tied inputs and arithmetic; held cruise policy', 'AE-301-10-E', 'verified'],
  'brief.engineClassification': ['verified game-tied classification; unknown commercial result retained', 'AE-301-10-E', 'verified'],
  'brief.notModelled': ['app-only unavailable-result policy', 'AE-301-10-E', 'independent'],
  'brief.rangeKm': ['verified game-tied inputs and unit conversion', 'AE-301-10-E', 'verified'],
  'brief.setPayloadSpace': ['verified game-tied inputs and arithmetic; app residual policy', 'AE-301-10-E', 'verified'],
  'brief.setSize': ['verified game-tied inputs and arithmetic; held hull policy', 'AE-301-10-E', 'verified'],
  'colonies.crowding': ['repaired body census; existing line label retained', 'AE-311-02', 'verified'],
  'colonies.growthRate': ['B16 repaired; existing line label retained', 'AE-311-02', 'verified'],
  'logistics.harvesterObtainable': ['played-save capacity comparison', 'AE-301-08', 'verified'],
  'logistics.harvesterOutput': ['played-save rate and fuel-increment comparison', 'AE-301-08', 'verified'],
  'logistics.mspPopulation': ['new shared-census positive-population gate; saved-snapshot estimate', 'AE-311-05', 'verified'],
  'mineral.orbitalRate': ['played-save stored-ledger comparison', 'AE-301-08', 'verified'],
  'mineral.surfaceRate': ['played-save stored-ledger comparison', 'AE-301-08', 'verified'],
  'population.orbitalCensus': ['saved-snapshot population estimate; bounded uncertainty, not an increment replay', 'AE-311-15', 'verified'],
  'research.landing': ['repaired research inputs; existing line label retained', 'AE-311-01', 'verified'],
  'terraform.installationOutput': ['played-save independent capacity working', 'AE-301-08', 'verified'],
})

const KINDS = Object.freeze({
  verified: 'line-labelled (see item evidence)',
  independent: 'version-independent',
  unverified: 'unverified on the line',
})

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const unique = (list) => [...new Set(list)]

// Every module of the renderer that registers rules, as the names `loadUtilities` takes: relative to utilities/, so that a module of another folder (a mixin) starts with '../'.
const ruleModuleNames = () => {
  const found = []

  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)

      if (entry.isDirectory()) {
        walk(file)
      } else if (entry.name.endsWith('.js') && REGISTERS_RULE.test(fs.readFileSync(file, 'utf8'))) {
        found.push(path.relative(utilitiesDirectory, file).replace(/\\/g, '/').replace(/\.js$/, ''))
      }
    }
  }

  walk(rendererDirectory)

  return found.sort(byText)
}

// The name under which a module loads the registry of rules: a module of utilities/ reaches provenance.js as 'provenance', one of another folder by the path it imports it from, which loads a copy of its own.
const registryName = (name) => {
  if (!name.startsWith('../')) {
    return 'provenance'
  }

  const match = PROVENANCE_IMPORT.exec(fs.readFileSync(path.join(utilitiesDirectory, `${name}.js`), 'utf8'))

  if (!match) {
    throw new Error(`${name} registers rules but does not import provenance.js`)
  }

  return path.posix.join(path.posix.dirname(name), match[1])
}

// The rules of each module with the modules they came from: every module is loaded on its own, with the modules it imports, so a module's own rules are those of the smallest load that holds them.
const loadRules = async (names) => {
  const loads = []

  for (const name of names) {
    const registry = registryName(name)
    const loaded = await loadUtilities([name, registry], { stubs: STUBS })

    loads.push({ name, rules: loaded[registry].listRules(), supports: loaded[registry].ruleSupports })
  }

  const owners = new Map()

  for (const load of loads) {
    for (const rule of load.rules) {
      const owner = owners.get(rule.id)

      if (!owner || load.rules.length < owner.size) {
        owners.set(rule.id, { rule, module: load.name, size: load.rules.length, supports: load.supports })
      }
    }
  }

  return [...owners.values()].sort((a, b) => byText(a.rule.id, b.rule.id))
}

const kindOf = ({ rule, supports }, probe) => {
  if (rule.versions.includes('x')) {
    return 'independent'
  }

  return supports(rule.id, probe) ? 'verified' : 'unverified'
}

const count = (list, test) => list.filter(test).length

const stats = (entries) => ({
  rules: entries.length,
  verified: count(entries, (entry) => entry.kind === 'verified'),
  independent: count(entries, (entry) => entry.kind === 'independent'),
  unverified: count(entries, (entry) => entry.kind === 'unverified'),
  confirmed: count(entries, (entry) => entry.rule.verification === 'confirmed'),
  estimated: count(entries, (entry) => entry.rule.verification === 'estimated'),
  assumed: count(entries, (entry) => entry.rule.verification === 'assumed'),
})

const code = (text) => `\`${text}\``

const table = (headers, rows, numeric = []) => [
  `| ${headers.join(' | ')} |`,
  `|${headers.map((_header, index) => (numeric.includes(index) ? '---:' : '---')).join('|')}|`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
].join('\n')

const moduleFile = (name) => (name.startsWith('../') ? `${name.slice(3)}.js` : `${name}.js`)

const findingsOf = (id) => RETAINED[id] || []

const itemsOf = (id) => unique(findingsOf(id).flatMap(([, ...items]) => items)).sort(byText)

const render = (entries, stated) => {
  const total = stats(entries)
  const areas = unique(entries.map((entry) => entry.rule.id.split('.')[0])).sort(byText)
  const unverified = entries.filter((entry) => entry.kind === 'unverified')
  const repaired = entries.filter((entry) => REPAIRED[entry.rule.id] && entry.kind === 'verified')
  const label = { verified: code(stated), independent: code('x'), unverified: code(unique(unverified.flatMap((entry) => entry.rule.versions)).sort(byText).join(', ') || 'none') }

  const parts = []

  parts.push(`Generated by ${code(COMMAND)} from the registered rules. The line is ${code(stated)}.`)
  parts.push(`${total.rules} rules in ${areas.length} areas: ${total.verified} ${KINDS.verified} (${label.verified}), ${total.independent} ${KINDS.independent} (${label.independent}) and ${total.unverified} ${KINDS.unverified} (${label.unverified}).`)
  parts.push('The version counts report registry labels, not a fresh verification verdict. Relabelled-after-repair counts are a subset of line-labelled rules; other recorded label work follows separately.')

  parts.push(table(['Versions', 'Meaning', 'Confirmed', 'Estimated', 'Assumed', 'Rules'], [...Object.keys(KINDS).map((kind) => {
    const kept = stats(entries.filter((entry) => entry.kind === kind))

    return [label[kind], KINDS[kind], kept.confirmed, kept.estimated, kept.assumed, kept.rules]
  }), ['Total', '', total.confirmed, total.estimated, total.assumed, total.rules]], [2, 3, 4, 5]))

  parts.push(table(['Area', 'Module', 'Rules', label.verified, label.independent, label.unverified, 'Relabelled after repair', 'Repair items', 'Confirmed', 'Estimated', 'Assumed'], [...areas.map((area) => {
    const kept = entries.filter((entry) => entry.rule.id.split('.')[0] === area)
    const figures = stats(kept)
    const repairs = kept.filter((entry) => REPAIRED[entry.rule.id])

    return [code(area), unique(kept.map((entry) => entry.module)).sort(byText).map((name) => code(moduleFile(name))).join(', '), figures.rules, figures.verified, figures.independent, figures.unverified, repairs.length, unique(repairs.map((entry) => REPAIRED[entry.rule.id][1])).sort(byText).join(', ') || 'none', figures.confirmed, figures.estimated, figures.assumed]
  }), ['Total', '', total.rules, total.verified, total.independent, total.unverified, repaired.length, '', total.confirmed, total.estimated, total.assumed]], [2, 3, 4, 5, 6, 8, 9, 10]))

  if (repaired.length) {
    parts.push(`Repaired by an AE-311 item and now on the line (each was unverified until its item landed):\n\n${table(['Rule', 'Versions', 'Verification', 'Finding', 'Repaired by'], repaired.map((entry) => [code(entry.rule.id), entry.rule.versions.map(code).join(', '), entry.rule.verification, ...REPAIRED[entry.rule.id]]))}`)
  }

  const labelled = entries.filter((entry) => LABEL_WORK[entry.rule.id])

  parts.push(`Other recorded label work (not all earlier line-labelled rules were in an AE-301-10 batch):\n\n${table(['Rule', 'Versions', 'Verification', 'Basis', 'Item'], labelled.map((entry) => [code(entry.rule.id), entry.rule.versions.map(code).join(', '), entry.rule.verification, ...LABEL_WORK[entry.rule.id].slice(0, 2)]))}`)
  parts.push('AE-301-10-A through D record their selected rule inventories, including stored-column and app-only verdicts; E covers the nine formerly older-labelled brief rules. Earlier labels also rest on AE-301-07 and AE-301-08 fixture, planted and stored-column work. A registry label alone does not attribute a comparison to those batches. AE-311-04 retired the D-3 shuttle warning; no rule is counted for it.')

  if (unverified.length) {
    parts.push(`Unverified on the line:\n\n${table(['Rule', 'Versions', 'Verification', 'Findings', 'Pending repair item'], unverified.map((entry) => {
      const findings = findingsOf(entry.rule.id).map(([finding]) => finding)
      const items = itemsOf(entry.rule.id)

      return [code(entry.rule.id), entry.rule.versions.map(code).join(', '), entry.rule.verification, findings.length ? findings.join(', ') : 'none recorded', items.length ? items.join(', ') : 'none assigned']
    }))}`)

    const items = Object.keys(ITEMS)

    parts.push(`Unverified rules by repairing item:\n\n${table(['Item', 'Repairs', 'Rules left'], items.map((item) => [item, ITEMS[item], count(unverified, (entry) => itemsOf(entry.rule.id).includes(item))]), [2])}`)
  }

  return parts.join('\n\n')
}

const unmatched = (entries) => {
  const registered = new Set(entries.map((entry) => entry.rule.id))
  const unverified = new Set(entries.filter((entry) => entry.kind === 'unverified').map((entry) => entry.rule.id))
  const verified = new Set(entries.filter((entry) => entry.kind === 'verified').map((entry) => entry.rule.id))
  const problems = []

  for (const id of [...unverified].sort(byText)) {
    if (!RETAINED[id]) {
      problems.push(`${id} is unverified and has no finding in RETAINED`)
    }
  }

  for (const id of Object.keys(RETAINED)) {
    if (!registered.has(id)) {
      problems.push(`${id} is in RETAINED but no module registers it`)
    } else if (!unverified.has(id)) {
      problems.push(`${id} is in RETAINED but is no longer unverified on the line`)
    }
  }

  for (const id of Object.keys(REPAIRED)) {
    if (!registered.has(id)) {
      problems.push(`${id} is in REPAIRED but no module registers it`)
    } else if (!verified.has(id)) {
      problems.push(`${id} is in REPAIRED but is not line-labelled`)
    }
  }

  for (const [id, [, , kind]] of Object.entries(LABEL_WORK)) {
    const entry = entries.find((entry) => entry.rule.id === id)

    if (!entry || entry.kind !== kind) {
      problems.push(`${id} is in LABEL_WORK but is missing or has a different label kind`)
    }
  }

  return problems
}

const updateDocument = (file, block, check) => {
  const target = path.resolve(file)
  const text = fs.readFileSync(target, 'utf8')
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)

  if (begin === -1 || end === -1 || end < begin || text.includes(BEGIN, begin + 1) || text.includes(END, end + 1)) {
    throw new Error(`${file} must hold the line ${BEGIN} once, followed by the line ${END} once`)
  }

  const updated = `${text.slice(0, begin + BEGIN.length)}\n\n${block}\n\n${text.slice(end)}`

  if (check) {
    if (text !== updated) {
      throw new Error(`${file}: generated rule-version table is stale; run ${COMMAND}`)
    }
  } else {
    fs.writeFileSync(target, updated)
  }
}

const USAGE = 'usage: bun scripts/rule-versions-table.js [--write|--check <markdown file>]'

const main = async (argv) => {
  const [flag, file, ...rest] = argv

  if (flag !== undefined && (!['--write', '--check'].includes(flag) || !file || rest.length)) {
    throw new Error(USAGE)
  }

  const { capabilities } = await loadUtilities(['capabilities'], { stubs: STUBS })
  const stated = capabilities.STATED_FORMULA_VERSION
  const probe = stated.replace(/x$/, '0')
  const entries = (await loadRules(ruleModuleNames())).map((entry) => ({ ...entry, kind: kindOf(entry, probe) }))
  const block = render(entries, stated)

  const problems = unmatched(entries)

  if (problems.length) {
    throw new Error(problems.join('\n'))
  }

  if (file) {
    updateDocument(file, block, flag === '--check')
    console.log(`${flag === '--check' ? 'checked' : 'wrote'} ${entries.length} rules ${flag === '--check' ? 'in' : 'to'} ${file}`)
  } else {
    console.log(block)
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
