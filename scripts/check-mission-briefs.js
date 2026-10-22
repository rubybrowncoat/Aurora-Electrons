/*
  Checks the mission briefs (utilities/mission-briefs.js) and the propulsion page's use of them (pages/propulsion.vue): the requirements a ship is for, kept apart from the alternatives judged against them, with pass, fail or unknown for each.

  bun scripts/check-mission-briefs.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>] [--no-mutations] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  Groups:
  - units: 50 tons are 1 HS for a hull; a cargo hold stores 50 tons to the HS and a capacity point is a ton; a hangar capacity is HS of ships; a typed size, range and cruise power become the unit the figure is held in, and text that is not a positive number is refused;
  - evaluation: every requirement of every alternative is pass, fail or unknown with the figure found, the figure required, the unit and the reason; an unknown figure never passes and never counts as 0; the verdict comes from the requirements alone; every violated and every unknown requirement is named; a note a preset cannot model is optional and unknown and outside the verdict;
  - ranking: the alternatives are ordered by verdict, then by the preferences in their order, an unknown figure last, and a preference never changes a verdict;
  - presets: survey and fighter give different visible requirements; a preview lists what would be added, replaced or left and changes nothing; only ticked fields are applied, to a copy; what a preset cannot model stays an unknown note and never becomes a requirement;
  - alternatives: a propulsion set answers size, speed, range, endurance, payload space and cost, and is unknown for cargo, hangar, deployment and (unless an engine is military) classification; a saved class answers what its row stores and is unknown for what the save lacks;
  - the record: a brief is a typed record of the campaign and race, seen on every branch, written only when the tab holds the file, and a brief made at a later game time is listed, flagged and not applied until moved; a stale save is refused unless asked to write over;
  - the page: its list, its draft, its preview, its saves and its notices on a pseudo instance (scripts/lib/page-loader.js);
  - the panel: the real component (its script loaded as the pages' are, its template compiled and rendered by Vue without a document): text that is not a figure is reported to the page and never given as a value, unfinished text stays through an update of the same brief and starts over when another is opened, and a range is drawn with its number in billions of km and the unit bn km beside it, each cell of a requirement read by its role (`data-brief-cell`);
  - the browser: the page and panel together in the real renderer, served over a copy of AuroraDB.db (game and race Aurelian Empire, scripts/lib/page-server.js) and driven in Chromium (scripts/lib/browser-observe.js `observe`): text that is not a figure shows its error in place of the field's hint, marks the brief as changed and leaves Save doing nothing (a click on it draws no message), New asks before it drops such text (the text stays until Discard) and the text and its error do not carry over, and a range cell is drawn in bn km. The screen is read the way every page check reads it (`installScreen`, `hooked`, `readFigure`, `rolesRead`, `labelKey`): the hooks only find the elements, a state is read back through the module's own words (the hints of REQUIREMENTS, FIELD_ERRORS, BRIEF_WORDS), a figure is read whole in the grouping of the app's setting, and a cell by its role; every wait is on the operation the check started. Nothing is saved to the save;
  - each save: a cargo hold stores 50 per HS, a class's cargo and hangar capacity equal the sum of its holds' and hangars', the ships docked in a mother ship never total more than its hangar capacity, no fighter class is as big as 10 HS, no commercial class mounts a military engine, and the loader's figures equal SQL of its own.

  The checks run through scripts/lib/fault-credit.js: a check's body is the call of the code under test, so a check that throws fails as a call that threw, and a verdict other than true is the check's own failure by value; the browser checks only read what the page showed, so one that throws is a defect of the harness, a failure over the real sources and a stop when a fault or a rewrite is judged (`judged`). Mutants: each deliberate fault in a copy of the utilities, of the page's script, of the panel or of the panel served to the browser is run with the checks it names and must fail each of them by a value, never by a throw (`caughtBy`, which stops the run when only checks that threw would credit a fault); each benign rewrite served to the browser must fail none, and a variant whose page does not get through is a defect of the harness, as nothing may be credited with it. The parts (`groups`, `page`, `panel`, `browser`, each mutant by its id such as `utility:3`, `page:0`, `panel:1`, `browser:0` or `browser-benign:0`, and each save by its label) run through scripts/lib/suite-runner.js, each with a deadline and a record that --resume continues: those in memory in a process each, those served to the browser one after another in a worker that starts one page server and one Chromium and warms them first, with the control `control:warm-reset`, which runs `browser:0` and then `browser` on the same server; `--variants=<key>,...` runs exactly the parts named. Prints `N of N checks passed`; exit code 1 when a check fails, 2 for a defect of the harness.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const nodeVm = require('vm')
const Vue = require('vue')
const { compileTemplate, parse } = require('vue/compiler-sfc')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')
const { runSuite, runnerArgs } = require('./lib/suite-runner')
const { patched } = require('./lib/mutant-source')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError, installScreen, readFigure, rolesRead, labelKey } = require('./lib/browser-observe')
const { failure, through, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

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

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 260 ? `${text.slice(0, 260)}…` : text
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value)

const equal = (actual, expected) => JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

// Lets the writes a page started without waiting for them finish.
const ticks = () => new Promise((resolve) => setTimeout(resolve, 0))

// A verdict as scripts/lib/fault-credit.js takes it: true holds, anything else is the check's own failure by value, with what was seen.
const verdictHeld = (verdict) => {
  if (verdict !== true) {
    throw failure(typeof verdict === 'string' ? verdict : short(verdict))
  }
}

// Checks `[name, test]` for `runChecks`, each named by itself: the test is the call of the code under test, so what it throws is a call that threw, which credits no fault (`caughtBy`), and a verdict other than true is a failure by value.
const asChecks = (list) => list.map(([name, test]) => ({ id: name, name, run: async () => verdictHeld(await through('the code under test', test, { read: false })) }))

// Prints the results of `runChecks`.
const printResults = (results) => results.forEach((result) => check(result.name, result.ok || result.detail))

// The failed checks of a fault, each with whether it failed by a value or because a call threw, and the start of what it saw: the matrix of what credits it.
const creditOf = (failed) => failed.map((result) => `${result.name} (${result.threw ? 'a throw' : 'a value'}: ${result.detail.slice(0, 160)})`).join('; ') || 'nothing'

// What a region draws, each role read its own way (scripts/lib/browser-observe.js `rolesRead`, one role at a time): `roles` is { role: [wanted, read] }, and a role on screen that `roles` does not name is a problem too.
const regionRead = (what, entries, roles) => [...Object.entries(roles).flatMap(([role, [wanted, read]]) => rolesRead(what, entries.filter((entry) => entry.role === role), { [role]: wanted }, read)), ...rolesRead(what, entries.filter((entry) => !Object.prototype.hasOwnProperty.call(roles, entry.role)), {})]

// The problems a reader found as a verdict: true when there are none.
const problemsHeld = (problems) => (problems.length === 0 ? true : short(problems))

const loadAll = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(['mission-briefs', 'design-rules', 'provenance', 'scenario-records'], { stubs: STUBS, directory })

  return { mb: loaded['mission-briefs'], dr: loaded['design-rules'], pv: loaded.provenance, sr: loaded['scenario-records'] }
}

// ---------- fixtures ----------

const RACE = 7

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update`. `owner.value` says whether this window may write.
const memory = () => {
  const files = new Map()
  const log = []
  const owner = { value: true }
  const store = (name) => ({
    get store () {
      return copy(files.get(name)) || {}
    },
    set store (value) {
      log.push('write')
      files.set(name, copy(value))
    },
    update (change) {
      for (;;) {
        const base = JSON.stringify(this.store)
        const next = change(JSON.parse(base))

        if (JSON.stringify(this.store) === base) {
          this.store = next

          return next
        }
      }
    },
  })

  return {
    files,
    log,
    owner,
    storage: {
      open: (campaignId) => store(`campaign-${campaignId}`),
      registry: () => ({}),
      writable: async () => {
        log.push('writable')
        await Promise.resolve()

        return owner.value
      },
    },
    writes: () => log.filter((entry) => entry === 'write').length,
  }
}

const repositoryOf = (m, mem) => {
  const adapters = m.sr.createAdapterRegistry()
  let counter = 0
  let clock = 1000

  m.mb.registerBriefs(adapters.register)

  return m.sr.createRepository({ storage: mem.storage, adapters, newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, now: () => ++clock })
}

const scopeIn = ({ campaignId = 'c1', branchId = 'b1', RaceID = RACE, gameTime = 100 } = {}) => ({ campaignId, RaceID, branchId, gameTime })

const fresh = (m) => {
  const mem = memory()

  return { mem, repository: repositoryOf(m, mem) }
}

// A brief with the requirements given (the rest not required), as a draft.
const briefOf = (m, requirements = {}, extra = {}) => ({ ...m.mb.emptyBrief('Test brief'), requirements: { ...m.mb.emptyBrief().requirements, ...requirements }, ...extra })

const known = (m, value, units = '') => m.pv.ofRule({ rule: 'brief.classSize', value, units, inputs: { present: ['test'] } })

const alternativeOf = (m, id, figures, extra = {}) => ({ id, name: id, pinned: false, figures: Object.fromEntries(Object.entries(figures).map(([key, value]) => [key, typeof value === 'number' ? known(m, value) : value])), ...extra })

const evaluated = (m, brief, alternatives) => m.mb.evaluateBrief(brief, alternatives)

const verdictsOf = (evaluation) => Object.fromEntries(evaluation.alternatives.map((item) => [item.id, item.verdict]))

const orderOf = (evaluation) => evaluation.alternatives.map((item) => item.id)

const requirementOf = (evaluation, id, key) => evaluation.alternatives.find((item) => item.id === id).requirements.find((item) => item.key === key)

// A row of the propulsion planner as the page builds it (utilities/design-rules.js figures, each with its provenance).
const rowOf = (m, key, extra = {}) => {
  const figure = (rule, value, units, assumptions = [], status = 'confirmed') => m.pv.envelope({ value, status, rule, units, assumptions, inputs: { present: ['test'] } })

  return { key, name: key, pinned: false, totalHS: 40, propulsionHS: 10, power: 1000, fuelPerEph: 0.5, litres: 50000, type: 'Military', provenance: { speed: figure('design.classSpeed', 2500, 'km/s'), burn: figure('design.burnPerHour', 500, 'L/h'), rangeBn: figure('design.fullPowerRangeKm', 12, 'bn km'), enduranceDays: figure('design.enduranceHours', 4, 'days'), cost: figure('design.propulsionSetCost', 30, 'BP'), tanks: figure('design.packTanks', 1, 'HS') }, ...extra }
}

const HYPOTHETICAL = 'Hypothetical tech: Engine B'

const hypotheticalRow = (m, key) => {
  const row = rowOf(m, key)
  const marked = m.pv.envelope({ value: 2500, status: 'assumed', rule: 'design.classSpeed', units: 'km/s', assumptions: [HYPOTHETICAL], inputs: { present: ['test'] } })

  return { ...row, provenance: { ...row.provenance, speed: marked } }
}

const FIGURES = { cargoCapacity: 100, hangarCapacity: 20, plannedDeployment: 24, commercial: false }

// ---------- units, fields, the brief ----------

const unitChecks = (m) => {
  const { mb, dr } = m

  return [
    ['units: 50 tons are 1 HS for a hull', () => mb.hsOfTons(50) === 1 && mb.tonsOfHs(1) === 50 && mb.hsOfTons(2500) === 50 && mb.tonsOfHs(0.5) === 25 && dr.TONS_PER_HS === 50 ? true : short([mb.hsOfTons(50), mb.tonsOfHs(1), mb.hsOfTons(2500)])],
    ['units: a hold stores 50 tons of cargo to the HS, a capacity point is a ton and a hangar capacity is HS of ships', () => mb.cargoTonsOfHoldHS(2) === 100 && mb.CARGO_POINTS_PER_HS === 50 && mb.cargoTonsOfCapacity(100) === 100 && mb.hangarHSOfCapacity(20) === 20 && mb.hangarTonsOfCapacity(20) === 1000 ? true : short([mb.cargoTonsOfHoldHS(2), mb.cargoTonsOfCapacity(100), mb.hangarHSOfCapacity(20)])],
    ['units: a size typed in tons is the HS it comes to, and in HS it is as typed', () => {
      const tons = mb.parseField('maxSizeHS', '500', { sizeUnit: 'tons' })
      const hs = mb.parseField('maxSizeHS', '10', { sizeUnit: 'hs' })
      const odd = mb.parseField('maxSizeHS', '25', { sizeUnit: 'tons' })

      return tons.ok && tons.value === 10 && hs.ok && hs.value === 10 && odd.ok && odd.value === 0.5 ? true : short([tons, hs, odd])
    }],
    ['units: a range typed in billions of km is km and a cruise power typed in percent is a share', () => {
      const range = mb.parseField('minRangeKm', '20')
      const cruise = mb.parseField('cruiseShare', '50')

      return range.ok && range.value === 20e9 && cruise.ok && cruise.value === 0.5 ? true : short([range, cruise])
    }],
    ['units: the other requirements are typed in the unit they are held in', () => {
      const parsed = ['minSpeedKmS', 'minEnduranceDays', 'minPayloadHS', 'minCargoTons', 'minHangarHS', 'minDeploymentMonths'].map((key) => mb.parseField(key, '12.5'))

      return parsed.every((item) => item.ok && item.value === 12.5) ? true : short(parsed)
    }],
    ['units: a stored value is typed back in the unit shown, whole', () => {
      const text = [mb.typedText('maxSizeHS', 10, { sizeUnit: 'tons' }), mb.typedText('maxSizeHS', 10, { sizeUnit: 'hs' }), mb.typedText('minRangeKm', 20e9), mb.typedText('cruiseShare', 0.5), mb.typedText('minSpeedKmS', null), mb.typedText('minSpeedKmS', undefined), mb.typedText('classification', 'military')]

      return equal(text, ['500', '10', '20', '50', '', '', 'military']) ? true : short(text)
    }],
    ['fields: an empty text clears a field, and text that is not a positive number is refused with a reason', () => {
      const empty = mb.parseField('minSpeedKmS', '  ')
      const bad = ['abc', '0', '-3', 'NaN', 'Infinity'].map((text) => mb.parseField('minSpeedKmS', text))
      const cruise = ['0', '0.5', '101', 'x'].map((text) => mb.parseField('cruiseShare', text))

      return empty.ok && empty.value === null && bad.every((item) => !item.ok && item.error) && cruise.every((item) => !item.ok && item.error) ? true : short([empty, bad, cruise])
    }],
    ['fields: a field is changed in a copy, and a key that is no field is refused', () => {
      const draft = briefOf(m, { minSpeedKmS: 100 })
      const before = copy(draft)
      const next = mb.withField(draft, 'minSpeedKmS', 200)
      const named = mb.withField(draft, 'name', 'Other')
      const axes = mb.withAxes(draft, [{ figure: 'costBP', direction: 'min' }])
      let refused = false

      try {
        mb.withField(draft, 'nothing', 1)
      } catch (_error) {
        refused = true
      }

      return equal(draft, before) && next.requirements.minSpeedKmS === 200 && named.name === 'Other' && axes.axes.length === 1 && refused ? true : short([next.requirements.minSpeedKmS, named.name, axes.axes, refused])
    }],
    ['brief: a valid brief has no problem and each fault is named', () => {
      const good = briefOf(m, { maxSizeHS: 10, classification: 'military' }, { cruiseShare: 0.5, axes: [{ figure: 'costBP', direction: 'min' }] })
      const faults = {
        name: { ...good, name: '' },
        longName: { ...good, name: 'x'.repeat(81) },
        size: { ...good, requirements: { ...good.requirements, maxSizeHS: -1 } },
        zero: { ...good, requirements: { ...good.requirements, minSpeedKmS: 0 } },
        class: { ...good, requirements: { ...good.requirements, classification: 'both' } },
        field: { ...good, requirements: { ...good.requirements, other: 1 } },
        missing: { ...good, requirements: { ...good.requirements, minSpeedKmS: undefined } },
        cruise: { ...good, cruiseShare: 2 },
        tooMany: { ...good, axes: ['costBP', 'sizeHS', 'speedKmS', 'rangeKm'].map((figure) => ({ figure, direction: 'min' })) },
        twice: { ...good, axes: [{ figure: 'costBP', direction: 'min' }, { figure: 'costBP', direction: 'max' }] },
        direction: { ...good, axes: [{ figure: 'costBP', direction: 'up' }] },
        figure: { ...good, axes: [{ figure: 'luck', direction: 'max' }] },
        note: { ...good, unmodelled: [{ key: 'x' }] },
        extra: { ...good, colour: 'red' },
      }
      const wrong = Object.entries(faults).filter(([, payload]) => mb.problemsOf(payload).length === 0).map(([name]) => name)

      return mb.problemsOf(good).length === 0 && mb.problemsOf(mb.emptyBrief('Blank')).length === 0 && mb.problemsOf(null).length > 0 && wrong.length === 0 ? true : short([mb.problemsOf(good), wrong])
    }],
    ['brief: what is missing is not required, and two briefs that say the same are the same', () => {
      const brief = mb.normaliseBrief({ name: 'A', requirements: { maxSizeHS: 5 } })
      const same = mb.sameBrief({ ...briefOf(m, { maxSizeHS: 5 }), name: 'A', axes: [{ direction: 'min', figure: 'costBP' }] }, { ...briefOf(m, { maxSizeHS: 5 }), name: 'A', axes: [{ figure: 'costBP', direction: 'min' }] })

      return brief.requirements.maxSizeHS === 5 && brief.requirements.minSpeedKmS === null && brief.cruiseShare === null && equal(brief.axes, []) && mb.requiredKeys(brief).join() === 'maxSizeHS' && same && !mb.sameBrief(briefOf(m, { maxSizeHS: 5 }), briefOf(m, { maxSizeHS: 6 })) ? true : short(brief)
    }],
  ]
}

// ---------- evaluation ----------

const NUMERIC = [
  ['maxSizeHS', 'sizeHS', 'atMost', 'HS', 10],
  ['minSpeedKmS', 'speedKmS', 'atLeast', 'km/s', 3000],
  ['minRangeKm', 'rangeKm', 'atLeast', 'km', 20e9],
  ['minEnduranceDays', 'enduranceDays', 'atLeast', 'days', 90],
  ['minPayloadHS', 'payloadHS', 'atLeast', 'HS', 3],
  ['minCargoTons', 'cargoTons', 'atLeast', 'tons', 500],
  ['minHangarHS', 'hangarHS', 'atLeast', 'HS', 20],
  ['minDeploymentMonths', 'deploymentMonths', 'atLeast', 'months', 24],
]

const evaluationChecks = (m) => {
  const { mb, pv } = m
  const unknown = (reason = 'not given') => mb.unknownFigure(reason)

  return [
    ['evaluation: the size limit passes at the limit, fails above it and tolerates the rounding of a sum', () => {
      const limit = mb.parseField('maxSizeHS', '500', { sizeUnit: 'tons' }).value
      const brief = briefOf(m, { maxSizeHS: limit })
      const result = evaluated(m, brief, [alternativeOf(m, 'tons', { sizeHS: mb.hsOfTons(500) }), alternativeOf(m, 'over', { sizeHS: mb.hsOfTons(500.5) }), alternativeOf(m, 'sum', { sizeHS: 0.1 + 0.2 })])
      const sum = evaluated(m, briefOf(m, { maxSizeHS: 0.3 }), [alternativeOf(m, 'sum', { sizeHS: 0.1 + 0.2 })])

      return equal(verdictsOf(result), { tons: 'meets', over: 'fails', sum: 'meets' }) && sum.alternatives[0].verdict === 'meets' ? true : short([verdictsOf(result), sum.alternatives[0].verdict])
    }],
    ['evaluation: each requirement gives pass, fail or unknown with the figure found, the figure required, the unit and the reason', () => {
      const problems = []

      for (const [key, figure, comparison, unit, required] of NUMERIC) {
        const good = comparison === 'atMost' ? required / 2 : required * 2
        const bad = comparison === 'atMost' ? required * 2 : required / 2
        const result = evaluated(m, briefOf(m, { [key]: required }, { cruiseShare: 1 }), [alternativeOf(m, 'good', { [figure]: good }), alternativeOf(m, 'bad', { [figure]: bad }), alternativeOf(m, 'none', { [figure]: unknown('the figure is not stored') })])
        const [pass, fail, open] = ['good', 'bad', 'none'].map((id) => requirementOf(result, id, key))

        if (pass.verdict !== 'pass' || pass.actual !== good || pass.required !== required || pass.unit !== unit || !pass.reason) {
          problems.push(`${key} pass ${short(pass)}`)
        }

        if (fail.verdict !== 'fail' || fail.actual !== bad || fail.required !== required || fail.unit !== unit || !fail.reason.includes(comparison === 'atMost' ? 'over' : 'short')) {
          problems.push(`${key} fail ${short(fail)}`)
        }

        if (open.verdict !== 'unknown' || open.actual !== null || open.required !== required || open.unit !== unit || !open.reason.includes('the figure is not stored') || pv.isAvailable(open.figure)) {
          problems.push(`${key} unknown ${short(open)}`)
        }
      }

      return problems.length === 0 ? true : problems.join('; ')
    }],
    ['evaluation: an unknown figure never passes, however little is required', () => {
      const brief = briefOf(m, { maxSizeHS: 1e9, minSpeedKmS: 1e-9, minRangeKm: 1e-9, minPayloadHS: 1e-9, minCargoTons: 1e-9, minHangarHS: 1e-9, minDeploymentMonths: 1e-9, classification: 'military' })
      const result = evaluated(m, brief, [alternativeOf(m, 'blank', {})])
      const item = result.alternatives[0]

      return item.passed.length === 0 && item.violated.length === 0 && item.unknown.length === 8 && item.verdict === 'open' && item.requirements.every((requirement) => requirement.verdict === 'unknown' && requirement.actual === null) ? true : short([item.verdict, item.unknown.length, item.passed.length])
    }],
    ['evaluation: a figure of 0 is a figure, and a requirement that is not set is not judged', () => {
      const zero = evaluated(m, briefOf(m, { minSpeedKmS: 1 }), [alternativeOf(m, 'stopped', { speedKmS: 0 })]).alternatives[0]
      const maxZero = evaluated(m, briefOf(m, { maxSizeHS: 5 }), [alternativeOf(m, 'empty', { sizeHS: 0 })]).alternatives[0]
      const none = evaluated(m, briefOf(m, {}), [alternativeOf(m, 'any', { speedKmS: 5 })])
      const item = none.alternatives[0]

      return zero.verdict === 'fails' && zero.requirements[0].actual === 0 && maxZero.verdict === 'meets' && item.verdict === 'none' && item.requirements.length === 0 && none.required.length === 0 && none.counts.none === 1 ? true : short([zero.verdict, zero.requirements[0].actual, maxZero.verdict, item.verdict, item.requirements.length])
    }],
    ['evaluation: the verdict comes from the requirements alone: meets, open, fails or none', () => {
      const brief = briefOf(m, { minSpeedKmS: 1000, minCargoTons: 100 }, { axes: [{ figure: 'costBP', direction: 'min' }] })
      const result = evaluated(m, brief, [
        alternativeOf(m, 'meets', { speedKmS: 2000, cargoTons: 100, costBP: 900 }),
        alternativeOf(m, 'open', { speedKmS: 2000, cargoTons: unknown(), costBP: 1 }),
        alternativeOf(m, 'fails', { speedKmS: 10, cargoTons: 100, costBP: 1 }),
        alternativeOf(m, 'failsAndOpen', { speedKmS: 10, cargoTons: unknown(), costBP: 1 }),
      ])
      const blank = evaluated(m, briefOf(m, {}, { axes: [{ figure: 'costBP', direction: 'min' }] }), [alternativeOf(m, 'a', { costBP: 5 })])

      return equal(verdictsOf(result), { meets: 'meets', open: 'open', fails: 'fails', failsAndOpen: 'fails' }) && blank.alternatives[0].verdict === 'none' && equal(result.counts, { meets: 1, open: 1, fails: 2, none: 0 }) ? true : short([verdictsOf(result), blank.alternatives[0].verdict, result.counts])
    }],
    ['evaluation: every violated and every unknown requirement is named', () => {
      const brief = briefOf(m, { maxSizeHS: 10, minSpeedKmS: 5000, minRangeKm: 1e9, minCargoTons: 10, minHangarHS: 1, minDeploymentMonths: 6 })
      const result = evaluated(m, brief, [alternativeOf(m, 'a', { sizeHS: 20, speedKmS: 100, rangeKm: 2e9, cargoTons: unknown('no holds'), hangarHS: unknown('no hangar'), deploymentMonths: 12 })])
      const item = result.alternatives[0]
      const words = mb.describeVerdict(item)

      return equal(item.violated.map((entry) => entry.key), ['maxSizeHS', 'minSpeedKmS']) && equal(item.unknown.map((entry) => entry.key), ['minCargoTons', 'minHangarHS']) && equal(item.passed.map((entry) => entry.key), ['minRangeKm', 'minDeploymentMonths']) && ['Ship size', 'Speed', 'Cargo capacity', 'Hangar space'].every((label) => words.includes(label)) && !words.includes('Range') ? true : short([item.violated.map((entry) => entry.key), item.unknown.map((entry) => entry.key), words])
    }],
    ['evaluation: every alternative is judged and listed once, with a rank', () => {
      const alternatives = ['a', 'b', 'c', 'd'].map((id, index) => alternativeOf(m, id, { speedKmS: 1000 * index }))
      const result = evaluated(m, briefOf(m, { minSpeedKmS: 1500 }), alternatives)

      return result.alternatives.length === 4 && equal([...orderOf(result)].sort(), ['a', 'b', 'c', 'd']) && equal(result.alternatives.map((item) => item.rank), [1, 2, 3, 4]) && result.alternatives.every((item) => item.requirements.length === 1) ? true : short(result.alternatives.map((item) => [item.id, item.rank]))
    }],
    ['evaluation: endurance is measured at the cruise power of the brief and is unknown when the brief names none', () => {
      const seen = []
      const figure = (context) => {
        seen.push(context.cruiseShare)

        return known(m, context.cruiseShare === null ? 1000 : 10 * context.cruiseShare)
      }
      const alternative = alternativeOf(m, 'a', { enduranceDays: figure })
      const half = evaluated(m, briefOf(m, { minEnduranceDays: 5 }, { cruiseShare: 0.5 }), [alternative]).alternatives[0]
      const full = evaluated(m, briefOf(m, { minEnduranceDays: 6 }, { cruiseShare: 0.5 }), [alternative]).alternatives[0]
      const unnamed = evaluated(m, briefOf(m, { minEnduranceDays: 5 }), [alternative]).alternatives[0]

      return half.verdict === 'meets' && half.requirements[0].actual === 5 && full.verdict === 'fails' && unnamed.verdict === 'open' && unnamed.requirements[0].actual === null && unnamed.requirements[0].reason.includes('cruise power') && !seen.includes(null) ? true : short([half.verdict, full.verdict, unnamed.verdict, seen])
    }],
    ['evaluation: a classification must match, and an unknown one never matches', () => {
      const text = (value) => pv.ofRule({ rule: 'brief.classClassification', value, inputs: { present: ['test'] } })
      const result = evaluated(m, briefOf(m, { classification: 'military' }), [alternativeOf(m, 'military', { classification: text('military') }), alternativeOf(m, 'commercial', { classification: text('commercial') }), alternativeOf(m, 'unknown', { classification: unknown('the engines are commercial') })])
      const reason = requirementOf(result, 'commercial', 'classification')

      return equal(verdictsOf(result), { military: 'meets', commercial: 'fails', unknown: 'open' }) && reason.actual === 'commercial' && reason.required === 'military' && reason.reason.includes('commercial') && requirementOf(result, 'unknown', 'classification').actual === null ? true : short([verdictsOf(result), reason])
    }],
    ['evaluation: a note a preset cannot model is optional, unknown and outside the verdict', () => {
      const brief = { ...briefOf(m, { minSpeedKmS: 100 }), unmodelled: [{ key: 'weapons', label: 'Weapons', note: 'Not part of a set.' }, { key: 'sensors', label: 'Sensors', note: 'Not part of a set.' }] }
      const result = evaluated(m, brief, [alternativeOf(m, 'fast', { speedKmS: 200 }), alternativeOf(m, 'slow', { speedKmS: 50 })])
      const item = result.alternatives[0]

      return equal(verdictsOf(result), { fast: 'meets', slow: 'fails' }) && item.optional.length === 2 && item.optional.every((note) => note.kind === 'optional' && note.verdict === 'unknown' && note.actual === null) && item.unknown.length === 0 && item.passed.length === 1 && item.requirements.length === 3 && mb.describeVerdict(item) === 'Meets all 1 requirements' ? true : short([verdictsOf(result), item.optional.length, item.unknown.length])
    }],
    ['evaluation: the counts and the words say how many meet, are open and fail', () => {
      const counts = { meets: 2, open: 1, fails: 3, none: 0 }
      const text = mb.describeCounts(counts, 6)

      return text.includes('2 of 6 meet') && text.includes('1 stay open') && text.includes('3 fail') && mb.describeCounts({ meets: 0, open: 0, fails: 0, none: 4 }, 4).includes('requires nothing') && mb.describeCounts(counts, 0).includes('No alternative') ? true : short(text)
    }],
    ['evaluation: an amount is described in the unit of its requirement', () => {
      const size = mb.describeAmount(mb.requirementOf('maxSizeHS'), 10)
      const range = mb.describeAmount(mb.requirementOf('minRangeKm'), 20e9)
      const cargo = mb.describeAmount(mb.requirementOf('minCargoTons'), 1500)

      return size.includes('10 HS') && size.includes('500 tons') && range.includes('20 bn km') && cargo.includes('1,500 tons') ? true : short([size, range, cargo])
    }],
  ]
}

// ---------- ranking ----------

const rankingChecks = (m) => {
  const { mb } = m
  const unknown = () => mb.unknownFigure('not given')

  return [
    ['ranking: the meeting alternatives come first, then the open ones, then the failing ones', () => {
      const result = evaluated(m, briefOf(m, { minSpeedKmS: 100 }), [alternativeOf(m, 'fails', { speedKmS: 1 }), alternativeOf(m, 'open', { speedKmS: unknown() }), alternativeOf(m, 'meets', { speedKmS: 500 })])

      return equal(orderOf(result), ['meets', 'open', 'fails']) ? true : short(orderOf(result))
    }],
    ['ranking: preferences order within a verdict, the first one first, a tie going to the next', () => {
      const brief = briefOf(m, {}, { axes: [{ figure: 'speedKmS', direction: 'max' }, { figure: 'costBP', direction: 'min' }] })
      const result = evaluated(m, brief, [alternativeOf(m, 'slowCheap', { speedKmS: 100, costBP: 1 }), alternativeOf(m, 'fastDear', { speedKmS: 200, costBP: 9 }), alternativeOf(m, 'fastCheap', { speedKmS: 200, costBP: 5 })])
      const reversed = evaluated(m, { ...brief, axes: [{ figure: 'speedKmS', direction: 'min' }, { figure: 'costBP', direction: 'max' }] }, [alternativeOf(m, 'slowCheap', { speedKmS: 100, costBP: 1 }), alternativeOf(m, 'fastDear', { speedKmS: 200, costBP: 9 }), alternativeOf(m, 'fastCheap', { speedKmS: 200, costBP: 5 })])

      return equal(orderOf(result), ['fastCheap', 'fastDear', 'slowCheap']) && equal(orderOf(reversed), ['slowCheap', 'fastDear', 'fastCheap']) ? true : short([orderOf(result), orderOf(reversed)])
    }],
    ['ranking: an unknown figure sorts after every known one, in either direction', () => {
      const alternatives = [alternativeOf(m, 'blank', { costBP: unknown() }), alternativeOf(m, 'dear', { costBP: 90 }), alternativeOf(m, 'cheap', { costBP: 10 })]
      const min = evaluated(m, briefOf(m, {}, { axes: [{ figure: 'costBP', direction: 'min' }] }), alternatives)
      const max = evaluated(m, briefOf(m, {}, { axes: [{ figure: 'costBP', direction: 'max' }] }), alternatives)

      return equal(orderOf(min), ['cheap', 'dear', 'blank']) && equal(orderOf(max), ['dear', 'cheap', 'blank']) ? true : short([orderOf(min), orderOf(max)])
    }],
    ['ranking: a preference never changes a verdict', () => {
      const alternatives = [alternativeOf(m, 'a', { speedKmS: 50, costBP: 1 }), alternativeOf(m, 'b', { speedKmS: 500, costBP: 99 }), alternativeOf(m, 'c', { speedKmS: unknown(), costBP: 5 })]
      const plain = briefOf(m, { minSpeedKmS: 100 })
      const sets = [[], [{ figure: 'costBP', direction: 'min' }], [{ figure: 'speedKmS', direction: 'min' }, { figure: 'costBP', direction: 'max' }], [{ figure: 'costBP', direction: 'max' }]]
      const verdicts = sets.map((axes) => verdictsOf(evaluated(m, { ...plain, axes }, alternatives)))
      const blank = sets.slice(1).map((axes) => evaluated(m, briefOf(m, {}, { axes }), alternatives).alternatives.map((item) => item.verdict))

      return verdicts.every((verdict) => equal(verdict, { a: 'fails', b: 'meets', c: 'open' })) && blank.every((list) => list.every((verdict) => verdict === 'none')) ? true : short([verdicts, blank])
    }],
    ['ranking: alternatives that tie keep the order they came in', () => {
      const result = evaluated(m, briefOf(m, { minSpeedKmS: 100 }, { axes: [{ figure: 'costBP', direction: 'min' }] }), ['c', 'a', 'b'].map((id) => alternativeOf(m, id, { speedKmS: 200, costBP: 7 })))
      const bare = evaluated(m, briefOf(m, {}), ['c', 'a', 'b'].map((id) => alternativeOf(m, id, { speedKmS: 200 })))

      return equal(orderOf(result), ['c', 'a', 'b']) && equal(orderOf(bare), ['c', 'a', 'b']) ? true : short([orderOf(result), orderOf(bare)])
    }],
  ]
}

// ---------- presets ----------

const presetChecks = (m) => {
  const { mb } = m
  const blank = () => mb.emptyBrief('')
  const everything = (preview) => preview.items.filter((item) => item.kind !== 'same').map((item) => item.key)

  return [
    ['presets: survey and fighter give different visible requirements', () => {
      const survey = mb.applyPreview(blank(), mb.previewPreset(blank(), 'survey'), everything(mb.previewPreset(blank(), 'survey'))).draft
      const fighter = mb.applyPreview(blank(), mb.previewPreset(blank(), 'fighter'), everything(mb.previewPreset(blank(), 'fighter'))).draft
      const keys = (brief) => mb.requiredKeys(brief)

      return mb.PRESET_KEYS.join() === 'survey,fighter' && !equal(survey, fighter) && !equal(keys(survey), keys(fighter)) && survey.requirements.minDeploymentMonths > 0 && fighter.requirements.minDeploymentMonths === null && fighter.requirements.classification === 'military' && survey.requirements.classification === null && survey.requirements.minRangeKm > fighter.requirements.minRangeKm * 0 && fighter.requirements.maxSizeHS < 10.0001 && survey.requirements.maxSizeHS > fighter.requirements.maxSizeHS && !equal(survey.axes, fighter.axes) && survey.name !== fighter.name ? true : short([keys(survey), keys(fighter)])
    }],
    ['presets: a preview lists what would be added, replaced or left and changes nothing', () => {
      const draft = { ...briefOf(m, { maxSizeHS: 25, minSpeedKmS: 8000 }), name: 'Mine', axes: [{ figure: 'costBP', direction: 'max' }] }
      const before = copy(draft)
      const preview = mb.previewPreset(draft, 'fighter')
      const kinds = Object.fromEntries(preview.items.map((item) => [item.key, item.kind]))

      return equal(draft, before) && kinds.maxSizeHS === 'replace' && kinds.minSpeedKmS === 'same' && kinds.minEnduranceDays === 'add' && kinds.minPayloadHS === 'add' && kinds.classification === 'add' && kinds.cruiseShare === 'add' && kinds.axes === 'replace' && kinds.name === undefined && preview.untouched.includes('Range') && preview.basis.includes('not a game rule') && equal(mb.additionsOf(preview).sort(), preview.items.filter((item) => item.kind === 'add').map((item) => item.key).sort()) && !mb.additionsOf(preview).includes('maxSizeHS') ? true : short(kinds)
    }],
    ['presets: only the ticked fields are applied, to a copy, and the draft given is not changed', () => {
      const draft = { ...briefOf(m, { maxSizeHS: 25 }), name: 'Mine' }
      const before = copy(draft)
      const preview = mb.previewPreset(draft, 'fighter')
      const added = mb.applyPreview(draft, preview, mb.additionsOf(preview))
      const replaced = mb.applyPreview(draft, preview, [...mb.additionsOf(preview), 'maxSizeHS'])

      return equal(draft, before) && added.draft !== draft && added.draft.requirements.maxSizeHS === 25 && added.draft.requirements.minSpeedKmS === 8000 && added.applied.length > 0 && added.skipped.includes('maxSizeHS') && added.draft.preset === 'fighter' && replaced.draft.requirements.maxSizeHS === 10 && added.draft.name === 'Mine' && equal(draft, before) ? true : short([added.draft.requirements, added.skipped, replaced.draft.requirements.maxSizeHS])
    }],
    ['presets: nothing ticked changes nothing', () => {
      const draft = briefOf(m, { maxSizeHS: 25 })
      const preview = mb.previewPreset(draft, 'survey')
      const outcome = mb.applyPreview(draft, preview, [])
      const stray = mb.applyPreview(draft, preview, ['nothing', 'minSpeedKmS-typo'])

      return mb.sameBrief(outcome.draft, draft) && outcome.draft.preset === null && outcome.applied.length === 0 && mb.sameBrief(stray.draft, draft) && stray.applied.length === 0 ? true : short([outcome.draft, outcome.applied])
    }],
    ['presets: applying a preset again shows no change', () => {
      const out = {}

      for (const key of mb.PRESET_KEYS) {
        const first = mb.previewPreset(blank(), key)
        const applied = mb.applyPreview(blank(), first, everything(first)).draft
        const again = mb.previewPreset(applied, key)

        out[key] = again.items.every((item) => item.kind === 'same') && everything(again).length === 0 && mb.problemsOf(applied).length === 0
      }

      return Object.values(out).every(Boolean) ? true : short(out)
    }],
    ['presets: what a preset cannot model stays an unknown note and never becomes a requirement', () => {
      const out = []

      for (const key of mb.PRESET_KEYS) {
        const preview = mb.previewPreset(blank(), key)
        const applied = mb.applyPreview(blank(), preview, everything(preview)).draft
        const notes = preview.items.filter((item) => item.key.startsWith('note:'))
        const result = evaluated(m, applied, [alternativeOf(m, 'any', { sizeHS: 5, speedKmS: 9000, enduranceDays: () => known(m, 10), payloadHS: 4, classification: m.pv.ofRule({ rule: 'brief.classClassification', value: 'military', inputs: { present: ['test'] } }) })])
        const item = result.alternatives[0]

        out.push(notes.length >= 2 && applied.unmodelled.length === notes.length && applied.unmodelled.every((note) => !mb.REQUIREMENT_KEYS.includes(note.key) && !m.mb.requirementOf(note.key)) && item.optional.length === notes.length && item.optional.every((entry) => entry.verdict === 'unknown' && entry.kind === 'optional'))
      }

      return out.every(Boolean) ? true : short(out)
    }],
    ['presets: a blank name is filled and a name given is kept, and a preset is never applied to the draft by previewing it', () => {
      const blankName = mb.previewPreset(blank(), 'survey')
      const named = mb.previewPreset({ ...blank(), name: 'Mine' }, 'survey')
      const draft = blank()
      const before = copy(draft)

      mb.previewPreset(draft, 'fighter')

      return blankName.items.some((item) => item.key === 'name' && item.kind === 'add') && !named.items.some((item) => item.key === 'name') && equal(draft, before) ? true : short(blankName.items.map((item) => item.key))
    }],
    ['presets: a preset that does not exist is refused', () => {
      try {
        mb.previewPreset(blank(), 'cruiser')
      } catch (_error) {
        return true
      }

      return 'a preset that is not listed was previewed'
    }],
  ]
}

// ---------- the alternatives ----------

const alternativeChecks = (m) => {
  const { mb, pv } = m
  const figureText = (alternative, key, context = { cruiseShare: 0.5 }) => mb.figureOf(alternative, key, context)
  const classAlternative = (extra = {}, figures = FIGURES) => mb.propulsionAlternative(rowOf(m, 'class', { pinned: true, totalHS: 40, propulsionHS: 10, ...extra }), figures)

  return [
    ['alternative: a propulsion set is unknown for cargo, hangar and deployment and says why', () => {
      const set = mb.propulsionAlternative(rowOf(m, 'set'), null)
      const withFigures = mb.propulsionAlternative(rowOf(m, 'set'), FIGURES)
      const out = ['cargoTons', 'hangarHS', 'deploymentMonths'].map((key) => [figureText(set, key), figureText(withFigures, key)])

      return out.every(([bare, given]) => !pv.isAvailable(bare) && bare.value === null && bare.inputs.missing[0].includes('propulsion set') && !pv.isAvailable(given)) ? true : short(out)
    }],
    ['alternative: the size, space beside the propulsion, speed, range, endurance and cost of a set come from its row', () => {
      const set = mb.propulsionAlternative(rowOf(m, 'set'), null)
      const values = Object.fromEntries(['sizeHS', 'payloadHS', 'speedKmS', 'rangeKm', 'costBP'].map((key) => [key, figureText(set, key).value]))
      const days = figureText(set, 'enduranceDays', { cruiseShare: 0.5 }).value
      const fullDays = figureText(set, 'enduranceDays', { cruiseShare: 1 }).value

      return equal(values, { sizeHS: 40, payloadHS: 30, speedKmS: 2500, rangeKm: 12e9, costBP: 30 }) && close(days, 50000 / (1000 * 0.5 * 0.5) / 24) && close(fullDays, 50000 / (1000 * 0.5) / 24) && set.id === 'set' && !set.pinned ? true : short([values, days, fullDays])
    }],
    ['alternative: the endurance of a set is measured at the cruise power of the brief, and is unknown without one or without fuel', () => {
      const set = mb.propulsionAlternative(rowOf(m, 'set'), null)
      const unnamed = mb.figureOf(set, 'enduranceDays', { cruiseShare: null })
      const stopped = mb.propulsionAlternative(rowOf(m, 'dry', { provenance: { ...rowOf(m, 'dry').provenance, enduranceDays: pv.unavailable({ rule: 'design.enduranceHours', missing: ['fuel'], units: 'days' }) } }), null)
      const dry = mb.figureOf(stopped, 'enduranceDays', { cruiseShare: 0.5 })

      return !pv.isAvailable(unnamed) && unnamed.inputs.missing[0].includes('cruise power') && !pv.isAvailable(dry) && dry.inputs.missing.includes('fuel') && dry.value === null ? true : short([unnamed, dry])
    }],
    ['alternative: the classification of a set is military with a military engine, and unknown otherwise', () => {
      const military = mb.propulsionAlternative(rowOf(m, 'a', { type: 'Military' }), null)
      const commercial = mb.propulsionAlternative(rowOf(m, 'b', { type: 'Commercial' }), null)
      const first = mb.figureOf(military, 'classification', {})
      const second = mb.figureOf(commercial, 'classification', {})

      return first.value === 'military' && first.status === 'confirmed' && !pv.isAvailable(second) && second.value === null && second.inputs.missing[0].includes('commercial') ? true : short([first, second])
    }],
    ['alternative: a saved class gives its cargo, hangar, deployment and classification as the save stores them', () => {
      const military = classAlternative()
      const commercial = classAlternative({}, { ...FIGURES, commercial: true })
      const read = (alternative) => ['cargoTons', 'hangarHS', 'deploymentMonths', 'classification', 'sizeHS'].map((key) => mb.figureOf(alternative, key, {}).value)

      return equal(read(military), [100, 20, 24, 'military', 40]) && equal(read(commercial), [100, 20, 24, 'commercial', 40]) && military.pinned && mb.figureOf(military, 'cargoTons', {}).status === 'confirmed' ? true : short([read(military), read(commercial)])
    }],
    ['alternative: a saved class is unknown for what the save lacks, never 0', () => {
      const none = mb.propulsionAlternative(rowOf(m, 'class', { pinned: true }), null)
      const partial = classAlternative({}, { cargoCapacity: null, hangarCapacity: null, plannedDeployment: null, commercial: null })
      const keys = ['cargoTons', 'hangarHS', 'deploymentMonths', 'classification']
      const all = [none, partial].map((alternative) => keys.map((key) => mb.figureOf(alternative, key, {})))

      return all.every((figures) => figures.every((figure) => !pv.isAvailable(figure) && figure.value === null)) && mb.figureOf(partial, 'cargoTons', {}).inputs.missing[0].includes('stores no CargoCapacity') && mb.figureOf(none, 'cargoTons', {}).inputs.missing[0].includes('could not be read') ? true : short(all.map((figures) => figures.map((figure) => figure.inputs.missing)))
    }],
    ['alternative: a cargo capacity equal to the requirement passes, one ton under fails, and a set is open for it', () => {
      const result = evaluated(m, briefOf(m, { minCargoTons: 100 }), [classAlternative(), classAlternative({ key: 'under' }, { ...FIGURES, cargoCapacity: 99 }), mb.propulsionAlternative(rowOf(m, 'set'), null)].map((alternative, index) => ({ ...alternative, id: ['equal', 'under', 'set'][index] })))
      const hangar = evaluated(m, briefOf(m, { minHangarHS: 20 }), [classAlternative(), classAlternative({}, { ...FIGURES, hangarCapacity: 19.99 })].map((alternative, index) => ({ ...alternative, id: ['equal', 'under'][index] })))

      return equal(verdictsOf(result), { equal: 'meets', under: 'fails', set: 'open' }) && equal(verdictsOf(hangar), { equal: 'meets', under: 'fails' }) ? true : short([verdictsOf(result), verdictsOf(hangar)])
    }],
    ['alternative: the class figures of a set that is not pinned are ignored', () => {
      const set = mb.propulsionAlternative(rowOf(m, 'set', { type: 'Commercial' }), FIGURES)

      return !pv.isAvailable(mb.figureOf(set, 'cargoTons', {})) && !pv.isAvailable(mb.figureOf(set, 'hangarHS', {})) ? true : 'a designed set took the figures of a saved class'
    }],
    ['alternative: a hypothetical tech level carries into the size, speed and space of a set, and a researched set stays confirmed', () => {
      const marked = mb.propulsionAlternative(hypotheticalRow(m, 'hypo'), null)
      const plain = mb.propulsionAlternative(rowOf(m, 'plain'), null)
      const pinned = mb.propulsionAlternative(hypotheticalRow(m, 'class'), null)
      const keys = ['sizeHS', 'payloadHS', 'speedKmS']
      const status = (alternative) => keys.map((key) => mb.figureOf(alternative, key, {}).status)
      const carried = (alternative) => keys.every((key) => mb.figureOf(alternative, key, {}).assumptions.includes(HYPOTHETICAL))
      const result = evaluated(m, briefOf(m, { minSpeedKmS: 100 }), [{ ...marked, id: 'hypo' }])

      return carried(marked) && !carried(plain) && status(marked).every((entry) => entry !== 'confirmed') && status(plain).includes('assumed') && result.alternatives[0].requirements[0].assumptions.includes(HYPOTHETICAL) && result.alternatives[0].requirements[0].status !== 'confirmed' && !pinned.pinned ? true : short([status(marked), status(plain), carried(marked), carried(plain)])
    }],
    ['alternative: a figure an alternative does not give is unknown and says so', () => {
      const bare = { id: 'bare', name: 'Bare', figures: {} }
      const figure = mb.figureOf(bare, 'cargoTons', {})
      const missing = mb.figureOf({ id: 'x', name: 'x' }, 'speedKmS', {})

      return !pv.isAvailable(figure) && figure.value === null && !pv.isAvailable(missing) ? true : short([figure, missing])
    }],
    ['class figures: the loader reads what the save stores and gives null for nothing, never 0', async () => {
      const asked = []
      const make = (rows) => ({
        query: async (sql) => {
          asked.push(sql)

          return [rows, {}]
        },
      })
      const all = await mb.loadClassFigures(make([{ ShipClassID: 1, CargoCapacity: 250, ParasiteCapacity: 12.5, PlannedDeployment: 36, Commercial: 0 }, { ShipClassID: 2, CargoCapacity: null, ParasiteCapacity: null, PlannedDeployment: null, Commercial: null }, { ShipClassID: 3, CargoCapacity: 0, ParasiteCapacity: 0, PlannedDeployment: 3, Commercial: 1 }]), { GameID: 1, RaceID: 2 })

      return equal(all[1], { cargoCapacity: 250, hangarCapacity: 12.5, plannedDeployment: 36, commercial: false }) && all[2].cargoCapacity === null && all[2].hangarCapacity === null && all[2].plannedDeployment === null && all[2].commercial === null && all[3].cargoCapacity === 0 && all[3].hangarCapacity === 0 && all[3].commercial === true && asked.length === 1 && asked[0].includes('ParasiteCapacity') ? true : short(all)
    }],
  ]
}

// ---------- the record ----------

const payloadOf = (m, name = 'Survey', requirements = { minSpeedKmS: 3000 }) => ({ ...briefOf(m, requirements), name })

const recordChecks = (m) => {
  const { mb } = m
  const seed = async (repository, scope = scopeIn(), payload = payloadOf(m)) => (await mb.saveBrief(repository, scope, { payload })).record

  return [
    ['record: a brief is kept as a typed record of the campaign and race and read back whole', async () => {
      const { repository } = fresh(m)
      const payload = { ...payloadOf(m, 'Fighter wing', { maxSizeHS: 10, classification: 'military' }), cruiseShare: 1, axes: [{ figure: 'speedKmS', direction: 'max' }], preset: 'fighter', unmodelled: [{ key: 'weapons', label: 'Weapons', note: 'Not modelled.' }] }
      const saved = await mb.saveBrief(repository, scopeIn(), { payload })
      const read = mb.readBriefs(repository, scopeIn())
      const record = repository.list(scopeIn(), { kind: mb.BRIEF_KIND })[0].record

      return saved.ok && read.entries.length === 1 && read.error === null && equal(read.entries[0].payload, payload) && read.entries[0].name === 'Fighter wing' && read.entries[0].uuid === saved.record.uuid && read.entries[0].status === 'current' && !read.entries[0].ahead && record.kind === 'planner.missionBrief' && record.association.policy === 'campaign' ? true : short([saved, read.entries.map((entry) => entry.payload), record && record.association])
    }],
    ['record: a brief is seen on every branch of the campaign and not on another race or campaign', async () => {
      const { repository } = fresh(m)

      await seed(repository)

      const names = (scope) => mb.readBriefs(repository, scope).entries.map((entry) => entry.name)
      const out = { sameBranch: names(scopeIn()), otherBranch: names(scopeIn({ branchId: 'b2' })), otherRace: names(scopeIn({ RaceID: RACE + 1 })), otherCampaign: names(scopeIn({ campaignId: 'c2' })) }

      return equal(out, { sameBranch: ['Survey'], otherBranch: ['Survey'], otherRace: [], otherCampaign: [] }) ? true : short(out)
    }],
    ['record: a brief made at a later game time is listed, flagged and not applied, and moving it applies it unchanged', async () => {
      const { repository } = fresh(m)
      const payload = payloadOf(m)
      const later = await mb.saveBrief(repository, scopeIn({ gameTime: 500 }), { payload })
      const read = mb.readBriefs(repository, scopeIn({ gameTime: 100 }))
      const entry = read.entries[0]
      const moved = await mb.moveBrief(repository, scopeIn({ gameTime: 100 }), entry)
      const after = mb.readBriefs(repository, scopeIn({ gameTime: 100 })).entries[0]

      return later.ok && read.entries.length === 1 && entry.ahead === true && entry.status === 'ahead' && entry.flags.includes('ahead') && moved.ok && after.ahead === false && after.status === 'current' && equal(after.payload, payload) ? true : short([entry && entry.status, moved, after && after.status])
    }],
    ['record: a tab that does not hold the file writes nothing', async () => {
      const { mem, repository } = fresh(m)
      const mine = await seed(repository)
      const entry = mb.readBriefs(repository, scopeIn()).entries[0]
      const before = mem.writes()

      mem.owner.value = false

      const created = await mb.saveBrief(repository, scopeIn(), { payload: payloadOf(m, 'Other') })
      const edited = await mb.saveBrief(repository, scopeIn(), { entry, payload: payloadOf(m, 'Renamed') })
      const moved = await mb.moveBrief(repository, scopeIn(), entry)
      const removed = await mb.deleteBrief(repository, scopeIn(), entry)

      return mine && [created, edited, moved, removed].every((outcome) => !outcome.ok && outcome.code === 'not-owner' && outcome.message.includes('Another tab')) && mem.writes() === before && mb.readBriefs(repository, scopeIn()).entries.length === 1 ? true : short([created, edited, moved, removed, mem.writes() - before])
    }],
    ['record: no repository and no scope write nothing and say why', async () => {
      const { mem, repository } = fresh(m)
      const before = mem.writes()
      const none = await mb.saveBrief(null, scopeIn(), { payload: payloadOf(m) })
      const unscoped = await mb.saveBrief(repository, null, { payload: payloadOf(m) })
      const read = [mb.readBriefs(null, scopeIn()), mb.readBriefs(repository, null)]

      return none.code === 'no-repository' && unscoped.code === 'no-scope' && !none.ok && !unscoped.ok && mem.writes() === before && read.every((item) => item.entries.length === 0 && item.error === null) ? true : short([none, unscoped])
    }],
    ['record: a brief that is not valid is refused and nothing is written', async () => {
      const { mem, repository } = fresh(m)
      const before = mem.writes()
      const outcome = await mb.saveBrief(repository, scopeIn(), { payload: { ...payloadOf(m), name: '' } })
      const negative = await mb.saveBrief(repository, scopeIn(), { payload: payloadOf(m, 'Bad', { minSpeedKmS: -5 }) })
      let direct = null

      try {
        repository.create(scopeIn(), { kind: mb.BRIEF_KIND, payload: { name: 'Raw' } })
      } catch (error) {
        direct = error.code
      }

      return !outcome.ok && outcome.code === 'invalid-brief' && !negative.ok && negative.code === 'invalid-brief' && mem.writes() === before && direct !== null ? true : short([outcome, negative, direct, mem.writes() - before])
    }],
    ['record: a stale save is refused with the stored brief and written over only when asked', async () => {
      const { repository } = fresh(m)

      await seed(repository)

      const entry = mb.readBriefs(repository, scopeIn()).entries[0]
      const other = await mb.saveBrief(repository, scopeIn(), { entry, payload: payloadOf(m, 'Changed elsewhere', { minSpeedKmS: 9000 }) })
      const refused = await mb.saveBrief(repository, scopeIn(), { entry, payload: payloadOf(m, 'Mine', { minSpeedKmS: 1000 }) })
      const stored = mb.readBriefs(repository, scopeIn()).entries[0]
      const forced = await mb.saveBrief(repository, scopeIn(), { entry, payload: payloadOf(m, 'Mine', { minSpeedKmS: 1000 }), overwrite: true })
      const after = mb.readBriefs(repository, scopeIn()).entries

      return other.ok && !refused.ok && refused.code === 'revision-conflict' && refused.stored.name === 'Changed elsewhere' && stored.name === 'Changed elsewhere' && stored.payload.requirements.minSpeedKmS === 9000 && forced.ok && after.length === 1 && after[0].name === 'Mine' && after[0].payload.requirements.minSpeedKmS === 1000 ? true : short([refused, stored.name, forced, after.map((item) => item.name)])
    }],
    ['record: a brief is edited in place and deleted, and a stale delete is refused', async () => {
      const { repository } = fresh(m)

      await seed(repository)

      const entry = mb.readBriefs(repository, scopeIn()).entries[0]
      const edited = await mb.saveBrief(repository, scopeIn(), { entry, payload: payloadOf(m, 'Survey', { minSpeedKmS: 4000 }) })
      const stale = await mb.deleteBrief(repository, scopeIn(), entry)
      const fresher = mb.readBriefs(repository, scopeIn()).entries[0]
      const removed = await mb.deleteBrief(repository, scopeIn(), fresher)

      return edited.ok && edited.record.uuid === entry.uuid && !stale.ok && stale.code === 'revision-conflict' && removed.ok && mb.readBriefs(repository, scopeIn()).entries.length === 0 ? true : short([edited.ok, stale, removed])
    }],
    ['record: two briefs of a race are kept apart and listed', async () => {
      const { repository } = fresh(m)

      await seed(repository, scopeIn(), payloadOf(m, 'Survey'))
      await seed(repository, scopeIn(), payloadOf(m, 'Fighter', { maxSizeHS: 10 }))

      const entries = mb.readBriefs(repository, scopeIn()).entries

      return entries.length === 2 && entries.map((entry) => entry.name).sort().join() === 'Fighter,Survey' && new Set(entries.map((entry) => entry.uuid)).size === 2 ? true : short(entries.map((entry) => entry.name))
    }],
  ]
}

// ---------- the page ----------

const pageStatements = async (mutate, m) => {
  const options = await loadPage('pages/propulsion', { stubs: STUBS, mutate })
  const page = (data = {}) => instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }, database: {}, GameID: 1, RaceID: RACE, data })
  const { mb } = m
  const rows = () => [rowOf(m, 'set-a'), rowOf(m, 'set-b', { totalHS: 60, propulsionHS: 20, provenance: { ...rowOf(m, 'x').provenance, speed: m.pv.envelope({ value: 1200, status: 'confirmed', rule: 'design.classSpeed', units: 'km/s', inputs: { present: ['test'] } }) } })]
  const withRecords = async (briefs = [payloadOf(m)]) => {
    const { mem, repository } = fresh(m)
    const kept = []

    for (const payload of briefs) {
      kept.push((await mb.saveBrief(repository, scopeIn(), { payload })).record)
    }

    return { mem, repository, kept, records: { repository, error: null } }
  }
  const stored = (repository) => mb.readBriefs(repository, scopeIn()).entries
  const settled = (vm) => vm.briefRevision

  return [
    ['page: every row is judged against the draft, and each requirement names its figures', () => {
      const vm = page({ rows: rows(), briefDraft: briefOf(m, { minSpeedKmS: 2000, maxSizeHS: 50, minCargoTons: 10 }) })
      const result = vm.briefEvaluation
      const first = result.alternatives.find((item) => item.id === 'set-a')
      const second = result.alternatives.find((item) => item.id === 'set-b')

      return result.alternatives.length === 2 && first.verdict === 'open' && second.verdict === 'fails' && first.unknown.map((item) => item.key).join() === 'minCargoTons' && second.violated.map((item) => item.key).join() === 'maxSizeHS,minSpeedKmS' && vm.briefAlternatives.length === 2 && first.requirements.every((item) => item.unit !== undefined && item.reason) ? true : short([result.alternatives.map((item) => [item.id, item.verdict, item.violated.map((entry) => entry.key)])])
    }],
    ['page: a saved class answers cargo, hangar and deployment from the save and a set does not', () => {
      const pinned = { ...rowOf(m, 'class', { pinned: true, totalHS: 40 }) }
      const draft = briefOf(m, { minCargoTons: 100, minHangarHS: 20, minDeploymentMonths: 24, classification: 'military' })
      const vm = page({ rows: [pinned, rowOf(m, 'set')], selectedClass: { id: 5 }, classFigures: { 4: { ...FIGURES, cargoCapacity: 1 }, 5: FIGURES }, briefDraft: draft })
      const lacking = page({ rows: [pinned, rowOf(m, 'set')], selectedClass: { id: 5 }, classFigures: {}, briefDraft: draft })
      const under = page({ rows: [pinned], selectedClass: { id: 5 }, classFigures: { 5: { ...FIGURES, cargoCapacity: 99 } }, briefDraft: draft })

      return equal(verdictsOf(vm.briefEvaluation), { class: 'meets', set: 'open' }) && equal(verdictsOf(lacking.briefEvaluation), { class: 'open', set: 'open' }) && under.briefEvaluation.alternatives[0].violated.map((item) => item.key).join() === 'minCargoTons' ? true : short([verdictsOf(vm.briefEvaluation), verdictsOf(lacking.briefEvaluation)])
    }],
    ['page: the briefs of the race are listed, and opening one puts it in the draft without changing it', async () => {
      const { repository, kept, records } = await withRecords([payloadOf(m, 'Survey'), payloadOf(m, 'Fighter', { maxSizeHS: 10 })])
      const vm = page({ records })

      vm.selectBrief(kept[1].uuid)

      return vm.briefSaved.length === 2 && vm.briefDraft.name === 'Fighter' && vm.briefDraft.requirements.maxSizeHS === 10 && vm.briefOrigin === kept[1].uuid && vm.briefEntry.uuid === kept[1].uuid && vm.briefSelected === kept[1].uuid && !vm.briefDirty && stored(repository).length === 2 ? true : short([vm.briefSaved.length, vm.briefDraft.name, vm.briefDirty])
    }],
    ['page: an edit marks the draft unsaved and writes nothing until Save', async () => {
      const { mem, repository, kept, records } = await withRecords()
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)

      const writes = mem.writes()

      vm.setBriefField('minSpeedKmS', 5000)
      vm.setBriefAxes([{ figure: 'costBP', direction: 'min' }])

      const dirty = vm.briefDirty
      const unchanged = stored(repository)[0].payload.requirements.minSpeedKmS === 3000 && mem.writes() === writes

      await vm.saveBriefDraft(false)

      const after = stored(repository)[0]

      return dirty && unchanged && !vm.briefDirty && after.payload.requirements.minSpeedKmS === 5000 && equal(after.payload.axes, [{ figure: 'costBP', direction: 'min' }]) && after.uuid === kept[0].uuid && stored(repository).length === 1 ? true : short([dirty, unchanged, vm.briefDirty, after.payload.requirements])
    }],
    ['page: opening another brief with unsaved changes asks first, and nothing is lost until the answer', async () => {
      const { kept, records } = await withRecords([payloadOf(m, 'Survey'), payloadOf(m, 'Fighter', { maxSizeHS: 10 })])
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)
      vm.setBriefField('minSpeedKmS', 1234)
      vm.selectBrief(kept[1].uuid)

      const asked = vm.pendingBrief !== null && vm.briefDraft.name === 'Survey' && vm.briefDraft.requirements.minSpeedKmS === 1234

      vm.keepPendingBrief()

      const kept1 = vm.pendingBrief === null && vm.briefDraft.requirements.minSpeedKmS === 1234

      vm.newBrief()
      vm.discardPendingBrief()

      const blank = vm.briefDraft.name === '' && vm.briefOrigin === null && vm.pendingBrief === null && vm.briefDirty === false

      vm.selectBrief(kept[1].uuid)
      vm.selectBrief(kept[0].uuid)

      return asked && kept1 && blank && vm.pendingBrief === null && vm.briefOrigin === kept[0].uuid ? true : short([asked, kept1, blank, vm.pendingBrief])
    }],
    ['page: a preset is previewed with its additions ticked and its replacements not, and the draft is unchanged', () => {
      const vm = page({ briefDraft: { ...briefOf(m, { maxSizeHS: 20 }), name: 'Mine' } })
      const before = copy(vm.briefDraft)

      vm.previewBriefPreset('fighter')

      const items = Object.fromEntries(vm.briefPreview.items.map((item) => [item.key, item.kind]))

      return equal(vm.briefDraft, before) && items.maxSizeHS === 'replace' && items.minSpeedKmS === 'add' && vm.briefAccepted.includes('minSpeedKmS') && !vm.briefAccepted.includes('maxSizeHS') && vm.briefPresets.map((item) => item.key).join() === 'survey,fighter' && vm.briefPresets.every((item) => item.label && item.summary) ? true : short([items, vm.briefAccepted])
    }],
    ['page: applying a preset writes only the ticked fields to the draft and never the saved brief', async () => {
      const { repository, kept, records } = await withRecords([payloadOf(m, 'Mine', { maxSizeHS: 20 })])
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)
      vm.previewBriefPreset('fighter')
      vm.applyBriefPreview()

      const draft = vm.briefDraft

      await ticks()
      const first = draft.requirements.maxSizeHS === 20 && draft.requirements.minSpeedKmS === 8000 && draft.preset === 'fighter' && vm.briefPreview === null && vm.briefMessage.includes('stays as it is until Save') && vm.briefDirty && stored(repository)[0].payload.requirements.minSpeedKmS === null && stored(repository)[0].payload.requirements.maxSizeHS === 20

      vm.previewBriefPreset('fighter')
      vm.toggleBriefItem('maxSizeHS')
      vm.applyBriefPreview()

      const second = vm.briefDraft.requirements.maxSizeHS === 10 && stored(repository)[0].payload.requirements.maxSizeHS === 20

      vm.previewBriefPreset('survey')
      vm.cancelBriefPreview()

      return first && second && vm.briefPreview === null && vm.briefAccepted.length === 0 && vm.briefDraft.requirements.minDeploymentMonths === null ? true : short([first, second, vm.briefDraft.requirements])
    }],
    ['page: a preset with nothing ticked leaves the draft as it was and says so', () => {
      const vm = page({ briefDraft: { ...briefOf(m, { maxSizeHS: 20 }), name: 'Mine' } })
      const before = copy(vm.briefDraft)

      vm.previewBriefPreset('survey')
      vm.briefAccepted = []
      vm.applyBriefPreview()

      return equal(vm.briefDraft, before) && vm.briefMessage.includes('unchanged') ? true : short([vm.briefDraft, vm.briefMessage])
    }],
    ['page: the survey and fighter presets show different requirements', () => {
      const shown = (key) => {
        const vm = page()

        vm.previewBriefPreset(key)
        vm.applyBriefPreview()

        return vm.briefDraft
      }
      const survey = shown('survey')
      const fighter = shown('fighter')

      return !equal(mb.requiredKeys(survey), mb.requiredKeys(fighter)) && survey.name === 'Survey ship' && fighter.name === 'Fighter' && survey.unmodelled.length >= 2 && fighter.unmodelled.length >= 2 ? true : short([mb.requiredKeys(survey), mb.requiredKeys(fighter)])
    }],
    ['page: a new brief is saved as a record of the campaign and shows on another branch', async () => {
      const { repository, records } = await withRecords([])
      const vm = page({ records })

      vm.setBriefField('name', 'Scout')
      vm.setBriefField('minRangeKm', 5e9)
      await vm.saveBriefDraft(false)

      const entries = stored(repository)
      const other = mb.readBriefs(repository, scopeIn({ branchId: 'b9' })).entries

      return entries.length === 1 && entries[0].name === 'Scout' && vm.briefOrigin === entries[0].uuid && vm.briefSelected === entries[0].uuid && vm.briefEntry.uuid === entries[0].uuid && !vm.briefDirty && other.length === 1 && settled(vm) === 1 ? true : short([entries.length, vm.briefOrigin, vm.briefDirty, other.length])
    }],
    ['page: a brief without a name is not saved and the notice says why', async () => {
      const { mem, records } = await withRecords([])
      const vm = page({ records })
      const writes = mem.writes()

      vm.setBriefField('minRangeKm', 5e9)
      await vm.saveBriefDraft(false)

      return vm.briefCanSave === false && vm.briefNotice.includes('not valid') && mem.writes() === writes ? true : short([vm.briefNotice, mem.writes() - writes])
    }],
    ['page: deleting a brief removes the record and empties the draft', async () => {
      const { repository, kept, records } = await withRecords([payloadOf(m, 'Survey'), payloadOf(m, 'Fighter')])
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)
      await vm.removeBrief()

      const names = stored(repository).map((entry) => entry.name)

      return equal(names, ['Fighter']) && vm.briefOrigin === null && vm.briefDraft.name === '' && vm.briefSelected === null && !vm.briefDirty ? true : short([names, vm.briefOrigin, vm.briefSelected])
    }],
    ['page: a brief made at a later game time is listed apart, is not opened, and is applied once moved', async () => {
      const { repository, mem } = fresh(m)
      const later = await mb.saveBrief(repository, scopeIn({ gameTime: 500 }), { payload: payloadOf(m, 'Later') })
      const vm = page({ records: { repository, error: null } })

      vm.selectBrief(later.record.uuid)

      const typing = page({ records: { repository, error: null } })

      typing.setBriefField('name', 'Typing')
      typing.selectBrief(later.record.uuid)

      const apart = vm.briefAhead.length === 1 && vm.briefSaved.length === 0 && vm.briefAhead[0].name === 'Later' && vm.briefOrigin === null && vm.briefDraft.name === '' && typing.pendingBrief === null && typing.briefDraft.name === 'Typing'
      const writes = mem.writes()

      await vm.moveBriefHere(later.record.uuid)

      const said = vm.briefMessage.includes('now applies')

      vm.selectBrief(later.record.uuid)

      return apart && said && mem.writes() === writes + 1 && vm.briefSaved.length === 1 && vm.briefAhead.length === 0 && vm.briefDraft.name === 'Later' ? true : short([apart, said, vm.briefSaved.length, vm.briefAhead.length, vm.briefDraft.name])
    }],
    ['page: a stale save is refused and shown, and is written over only when asked', async () => {
      const { repository, kept, records } = await withRecords()
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)

      await mb.saveBrief(repository, scopeIn(), { entry: stored(repository)[0], payload: payloadOf(m, 'Changed elsewhere', { minSpeedKmS: 9000 }) })
      vm.setBriefField('minSpeedKmS', 1500)
      await vm.saveBriefDraft(false)

      const refused = vm.briefConflict !== null && vm.briefConflict.name === 'Changed elsewhere' && stored(repository)[0].payload.requirements.minSpeedKmS === 9000 && vm.briefDirty

      await vm.saveBriefDraft(true)

      return refused && vm.briefConflict === null && stored(repository)[0].payload.requirements.minSpeedKmS === 1500 && stored(repository).length === 1 ? true : short([refused, vm.briefConflict, stored(repository)[0].payload.requirements.minSpeedKmS])
    }],
    ['page: a list read again does not move the revision a save is judged at', async () => {
      const { repository, kept, records } = await withRecords()
      const later = await mb.saveBrief(repository, scopeIn({ gameTime: 500 }), { payload: payloadOf(m, 'Later') })
      const vm = page({ records })
      const mine = () => stored(repository).find((entry) => entry.uuid === kept[0].uuid)

      vm.selectBrief(kept[0].uuid)
      vm.setBriefField('minSpeedKmS', 1500)
      await mb.saveBrief(repository, scopeIn(), { entry: mine(), payload: payloadOf(m, 'Concurrent rename', { minSpeedKmS: 3000, minCargoTons: 100 }) })
      await vm.moveBriefHere(later.record.uuid)

      const listed = vm.briefSaved.find((entry) => entry.uuid === kept[0].uuid)
      const moved = listed.revision === 2 && listed.name === 'Concurrent rename' && vm.briefEntry.revision === 1

      await vm.saveBriefDraft(false)

      const refused = vm.briefConflict !== null && vm.briefConflict.name === 'Concurrent rename' && mine().name === 'Concurrent rename' && mine().payload.requirements.minCargoTons === 100 && mine().payload.requirements.minSpeedKmS === 3000 && vm.briefDirty

      await vm.saveBriefDraft(true)

      return moved && refused && vm.briefConflict === null && mine().name === 'Survey' && mine().payload.requirements.minSpeedKmS === 1500 && mine().payload.requirements.minCargoTons === null && !vm.briefDirty ? true : short([moved, refused, vm.briefConflict, mine().name])
    }],
    ['page: the next save after a save is judged at the revision that save wrote', async () => {
      const { repository, kept, records } = await withRecords()
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)
      vm.setBriefField('minSpeedKmS', 1500)
      await vm.saveBriefDraft(false)
      vm.setBriefField('minSpeedKmS', 1600)
      await vm.saveBriefDraft(false)

      return vm.briefConflict === null && vm.briefEntry.revision === 3 && stored(repository)[0].revision === 3 && stored(repository)[0].payload.requirements.minSpeedKmS === 1600 && !vm.briefDirty ? true : short([vm.briefConflict, vm.briefEntry.revision, stored(repository)[0].revision])
    }],
    ['page: text that is not a figure blocks Save and counts as unsaved', async () => {
      const { mem, repository, kept, records } = await withRecords()
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)

      const clean = !vm.briefDirty && vm.briefCanSave

      vm.setBriefInvalid(['minSpeedKmS'])

      const blocked = vm.briefDirty && !vm.briefCanSave
      const writes = mem.writes()

      await vm.saveBriefDraft(false)
      await vm.saveBriefDraft(true)

      const refused = mem.writes() === writes && stored(repository)[0].revision === 1 && vm.briefNotice.includes('not a figure')

      vm.newBrief()

      const asked = vm.pendingBrief !== null && vm.briefOrigin === kept[0].uuid

      vm.keepPendingBrief()
      vm.setBriefInvalid([])

      return clean && blocked && refused && asked && !vm.briefDirty && vm.briefCanSave ? true : short([clean, blocked, refused, asked, vm.briefDirty])
    }],
    ['page: opening or emptying a brief starts the text of the panel over, and an ordinary edit does not', async () => {
      const { kept, records } = await withRecords([payloadOf(m, 'Survey'), payloadOf(m, 'Fighter')])
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)

      const opened = vm.briefOpening

      vm.setBriefField('minSpeedKmS', 1500)
      vm.setBriefInvalid(['minRangeKm'])
      await vm.saveBriefDraft(false)

      const kept1 = vm.briefOpening === opened && equal(vm.briefInvalid, ['minRangeKm'])

      vm.newBrief()
      vm.discardPendingBrief()

      const blank = vm.briefOpening > opened && vm.briefInvalid.length === 0 && !vm.briefDirty
      const second = vm.briefOpening

      vm.setBriefInvalid(['minRangeKm'])
      vm.selectBrief(kept[1].uuid)
      vm.discardPendingBrief()

      const other = vm.briefOpening > second && vm.briefInvalid.length === 0 && vm.briefDraft.name === 'Fighter'
      const third = vm.briefOpening

      vm.setBriefInvalid(['minRangeKm'])
      vm.clearBrief()

      return kept1 && blank && other && vm.briefOpening > third && vm.briefInvalid.length === 0 ? true : short([kept1, blank, other, vm.briefOpening, vm.briefInvalid])
    }],
    ['page: a write another tab blocks keeps nothing and the notice says so', async () => {
      const { mem, repository, kept, records } = await withRecords()
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)
      vm.setBriefField('minSpeedKmS', 1)
      mem.owner.value = false

      const writes = mem.writes()

      await vm.saveBriefDraft(false)

      const saved = vm.briefNotice.includes('Another tab') && mem.writes() === writes && stored(repository)[0].payload.requirements.minSpeedKmS === 3000 && vm.briefDirty

      await vm.removeBrief()

      return saved && vm.briefNotice.includes('Another tab') && stored(repository).length === 1 && vm.briefOrigin === kept[0].uuid ? true : short([vm.briefNotice, mem.writes() - writes, stored(repository).length])
    }],
    ['page: with no scenario records a brief is not kept and the notice says so', async () => {
      const vm = page({ records: { repository: null, error: 'no store' } })

      vm.setBriefField('name', 'Lost')
      await vm.saveBriefDraft(false)

      return vm.briefSaved.length === 0 && vm.briefOrigin === null && vm.briefNotice.includes('not available') && vm.briefDirty ? true : short([vm.briefNotice, vm.briefOrigin])
    }],
    ['page: the brief the race last opened is restored once its briefs are read, unless the draft was touched', async () => {
      const { kept, records } = await withRecords([payloadOf(m, 'Survey'), payloadOf(m, 'Fighter')])
      const vm = page({ records, briefSelected: kept[1].uuid })
      const touched = page({ records, briefSelected: kept[1].uuid, briefDraft: { ...briefOf(m, { maxSizeHS: 3 }), name: 'Typing' } })
      const gone = page({ records, briefSelected: 'no-such-brief' })
      const none = page({ records, briefSelected: null })

      vm.restoreBrief()
      touched.restoreBrief()
      gone.restoreBrief()
      none.restoreBrief()

      return vm.briefOrigin === kept[1].uuid && vm.briefDraft.name === 'Fighter' && touched.briefOrigin === null && touched.briefDraft.name === 'Typing' && gone.briefOrigin === null && none.briefOrigin === null ? true : short([vm.briefOrigin, touched.briefOrigin, gone.briefOrigin])
    }],
    ['page: emptying the draft for another save keeps the brief the race last opened', async () => {
      const { kept, records } = await withRecords()
      const vm = page({ records })

      vm.selectBrief(kept[0].uuid)
      vm.setBriefField('minSpeedKmS', 1)
      vm.previewBriefPreset('fighter')
      vm.clearBrief()

      return vm.briefOrigin === null && vm.briefDraft.name === '' && vm.briefPreview === null && vm.briefSelected === kept[0].uuid && vm.pendingBrief === null && vm.briefConflict === null && vm.briefMessage === '' ? true : short([vm.briefOrigin, vm.briefSelected])
    }],
    ['page: the size unit of the brief is tons until the player says HS', () => {
      const vm = page()

      return vm.briefSizeUnit === 'tons' ? true : short(vm.briefSizeUnit)
    }],
  ]
}

// ---------- the panel ----------

const rendererDirectory = path.join(root, 'src', 'renderer')
const panelFile = path.join(rendererDirectory, 'components', 'planner', 'MissionBriefPanel.vue')

Vue.config.silent = true
Vue.config.productionTip = false
Vue.config.devtools = false

// The component the app ships: its script is loaded the way the pages' are, its template is compiled and then rendered by Vue itself, without a document, so the Vuetify elements stay plain nodes and what is read is the text of each cell. `change(text)` rewrites the whole file first (a mutant).
const loadPanel = async (change) => {
  const original = fs.readFileSync(panelFile, 'utf8')
  const source = (change ? change(original) : original).replace(/from '\.\.\/\.\.\//g, "from '../")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mission-briefs-panel-'))

  try {
    fs.cpSync(utilitiesDirectory, path.join(directory, 'utilities'), { recursive: true })
    fs.cpSync(path.join(rendererDirectory, 'mixins'), path.join(directory, 'mixins'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'pages'))
    fs.writeFileSync(path.join(directory, 'pages', 'Panel.vue'), source)

    const options = await loadPage('pages/Panel', { directory, stubs: STUBS })
    const compiled = compileTemplate({ source: parse({ source }).template.content, filename: 'MissionBriefPanel.vue' })

    if (compiled.errors.length) {
      throw new Error(`The template does not compile: ${compiled.errors.join('; ')}`)
    }

    const { render, staticRenderFns } = nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)

    return Vue.extend({ ...options, beforeCreate () { this.$store = { getters: { config: { get: (_name, fallback) => fallback } } } }, render, staticRenderFns })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const textOf = (node) => (typeof node.text === 'string' ? node.text : (node.children || []).map(textOf).join(''))

const nodesOf = (node, test, found = []) => {
  if (test(node)) {
    found.push(node)
  }

  ;(node.children || []).forEach((child) => nodesOf(child, test, found))

  return found
}

const panelStatements = async (change, m) => {
  const Panel = await loadPanel(change)
  const { mb } = m
  const panel = (props = {}) => new Panel({ propsData: { draft: briefOf(m, { minSpeedKmS: 3000 }), evaluation: evaluated(m, briefOf(m), []), ...props } })
  const heard = (vm) => {
    const events = []

    vm.$on('invalid', (keys) => events.push(['invalid', keys]))
    vm.$on('field', (key, value) => events.push(['field', key, value]))

    return events
  }
  // The cells of the row of a requirement as entries of `rolesRead`, each by its role (`data-brief-cell`) with the text it draws, all on screen (a render without a document hides nothing); null when no row draws the requirement.
  const cellsOf = (vm, requirement) => {
    const row = nodesOf(vm._render(), (node) => Boolean(node.data && node.data.attrs && node.data.attrs['data-brief-requirement'] === requirement))[0]

    return row ? nodesOf(row, (node) => Boolean(node.data && node.data.attrs && node.data.attrs['data-brief-cell'])).map((node) => ({ role: node.data.attrs['data-brief-cell'], text: textOf(node), on: true })) : null
  }

  return [
    ['panel: text that is not a figure is reported to the page, never given as a value, and is cleared when corrected', async () => {
      const vm = panel()
      const events = heard(vm)

      vm.type('minSpeedKmS', 'abc')
      await ticks()
      vm.type('minSpeedKmS', '4000')
      await ticks()

      return equal(events, [['invalid', ['minSpeedKmS']], ['field', 'minSpeedKmS', 4000], ['invalid', []]]) && vm.typed.minSpeedKmS === '4000' ? true : short(events)
    }],
    ['panel: unfinished text stays through an ordinary update of the same brief', async () => {
      const vm = panel()
      const events = heard(vm)

      vm.type('minSpeedKmS', 'abc')
      await ticks()
      vm._props.draft = { ...vm.draft, name: 'Renamed', axes: [{ figure: 'costBP', direction: 'min' }] }
      await ticks()

      return vm.typed.minSpeedKmS === 'abc' && vm.errors.minSpeedKmS.length === 1 && equal(events, [['invalid', ['minSpeedKmS']]]) ? true : short([vm.typed.minSpeedKmS, vm.errors, events])
    }],
    ['panel: the text starts over when another brief is opened', async () => {
      const vm = panel()
      const events = heard(vm)

      vm.type('minSpeedKmS', 'abc')
      vm.type('minRangeKm', 'x')
      await ticks()
      vm._props.identity = 1
      vm._props.draft = briefOf(m, { minSpeedKmS: 5000 })
      await ticks()

      return vm.typed.minSpeedKmS === mb.typedText('minSpeedKmS', 5000, { sizeUnit: 'hs' }) && vm.typed.minRangeKm === '' && Object.values(vm.errors).every((list) => list.length === 0) && equal(events[events.length - 1], ['invalid', []]) ? true : short([vm.typed.minSpeedKmS, vm.typed.minRangeKm, vm.errors, events])
    }],
    ['panel: a range is shown with the number in billions of km and the unit beside it', () => {
      const evaluation = evaluated(m, briefOf(m, { minRangeKm: 20e9 }), [mb.propulsionAlternative(rowOf(m, 'set-range'))])
      const vm = panel({ evaluation })
      const definition = mb.requirementOf('minRangeKm')
      const grouping = vm.$store.getters.config.get('selectedSeparator', 'Tick')

      vm.opened = ['set-range']

      const cells = cellsOf(vm, 'minRangeKm')
      const figure = (text) => readFigure(text, grouping)

      return cells === null ? 'no row draws the range' : problemsHeld(regionRead('the range of set-range', cells, {
        label: [definition.label, (text) => text],
        verdict: [true, (text) => text !== ''],
        required: [20, figure],
        actual: [12, figure],
        unit: [definition.input.unit, (text) => text],
        reason: [true, (text) => text.includes(`12 ${definition.input.unit}`) && text.includes(`20 ${definition.input.unit}`)],
      }))
    }],
    ['panel: the unit beside a figure is the unit its number is in, for every requirement', () => {
      const vm = panel()
      const problems = []

      for (const definition of mb.REQUIREMENTS.filter((item) => !item.values)) {
        const stored = 7.25 * definition.input.scale
        const unit = vm.unitOf({ key: definition.key, unit: definition.unit })
        const number = vm.amount(definition.key, stored)

        if (unit !== mb.typedUnit(definition, { sizeUnit: 'hs' }) || !number.startsWith(vm.count(7.25, definition.input.digits))) {
          problems.push([definition.key, unit, number])
        }
      }

      return problems.length === 0 && vm.unitOf({ key: 'note:hangar', unit: '' }) === '—' && vm.amount('classification', 'military') === 'military' ? true : short(problems)
    }],
  ]
}

const PAGE_MUTATIONS = [
  { name: 'a preset ticking every field, replacements included', find: 'this.briefAccepted = additionsOf(this.briefPreview)', replace: 'this.briefAccepted = this.briefPreview.items.map((item) => item.key)', fails: ['page: a preset is previewed with its additions ticked', 'page: applying a preset writes only the ticked fields'] },
  { name: 'a preset applied whatever is ticked', find: 'applyPreview(this.briefDraft, this.briefPreview, this.briefAccepted)', replace: 'applyPreview(this.briefDraft, this.briefPreview, this.briefPreview.items.map((item) => item.key))', fails: ['page: applying a preset writes only the ticked fields', 'page: a preset with nothing ticked'] },
  { name: 'a preset applied straight to the saved brief', find: '      this.briefDraft = outcome.draft\n', replace: '      this.briefDraft = outcome.draft\n      this.briefOrigin !== null && this.saveBriefDraft(false)\n', fails: ['page: applying a preset writes only the ticked fields'] },
  { name: 'unsaved changes discarded without asking', find: '      if (this.briefDirty) {\n        this.pendingBrief = target', replace: '      if (false) {\n        this.pendingBrief = target', fails: ['page: opening another brief with unsaved changes asks first'] },
  { name: 'a brief made at a later game time applied', find: 'this.briefRead.entries.filter((entry) => !entry.ahead)', replace: 'this.briefRead.entries', fails: ['page: a brief made at a later game time is listed apart'] },
  { name: 'a stale save written over without asking', find: '{ entry: this.briefEntry, payload, overwrite }', replace: '{ entry: this.briefEntry, payload, overwrite: true }', fails: ['page: a stale save is refused and shown', 'page: a list read again does not move the revision'] },
  { name: 'a save judged at the revision the list was read at', find: 'return listed ? { uuid: this.briefOrigin, revision: this.briefBaseline.revision, payload: this.briefBaseline.payload } : null', replace: 'const live = this.briefSaved.find((entry) => entry.uuid === this.briefOrigin)\n\n      return live ? { uuid: live.uuid, revision: live.revision, payload: this.briefBaseline.payload } : null', fails: ['page: a list read again does not move the revision', 'page: a stale save is refused and shown'] },
  { name: 'the revision of a save not taken on', find: 'this.briefBaseline = { revision: outcome.record.revision, payload }', replace: 'this.briefBaseline = this.briefBaseline', fails: ['page: the next save after a save is judged'] },
  { name: 'text that is not a figure let through to Save', find: 'return this.briefProblems.length === 0 && this.briefInvalid.length === 0', replace: 'return this.briefProblems.length === 0', fails: ['page: text that is not a figure blocks Save'] },
  { name: 'text that is not a figure not counted as unsaved', find: 'return this.briefInvalid.length > 0 || !sameBrief(', replace: 'return !sameBrief(', fails: ['page: text that is not a figure blocks Save'] },
  { name: 'the text of the panel not started over', find: '      this.briefInvalid = []\n      this.briefOpening += 1\n', replace: '', fails: ['page: opening or emptying a brief starts the text of the panel over'] },
  { name: 'the text of the panel started over on every edit', find: '      this.briefDraft = withField(this.briefDraft, key, value)\n', replace: '      this.briefDraft = withField(this.briefDraft, key, value)\n      this.briefOpening += 1\n', fails: ['page: opening or emptying a brief starts the text of the panel over'] },
  { name: 'a failed write not reported', find: '      } else {\n        this.briefMessage = outcome.message\n      }\n    },\n\n    async removeBrief() {', replace: '      }\n    },\n\n    async removeBrief() {', fails: ['page: a write another tab blocks keeps nothing'] },
  { name: 'a refused delete clearing the draft', find: '      if (outcome.ok) {\n        this.clearBrief()\n        this.briefSelected = null', replace: '      if (true) {\n        this.clearBrief()\n        this.briefSelected = null', fails: ['page: a write another tab blocks keeps nothing'] },
  { name: 'the draft emptied forgetting the brief last opened', find: '      this.briefConflict = null\n      this.pendingBrief = null\n    },', replace: '      this.briefConflict = null\n      this.pendingBrief = null\n      this.briefSelected = null\n    },', fails: ['page: emptying the draft for another save keeps the brief'] },
  { name: 'the brief restored over a draft being typed', find: 'if (this.briefOrigin === null && !this.briefDirty && this.briefSelected', replace: 'if (this.briefOrigin === null && this.briefSelected', fails: ['page: the brief the race last opened is restored'] },
  { name: 'every row judged against the class figures of the wrong class', find: 'this.classFigures[this.selectedClass.id] || null', replace: 'Object.values(this.classFigures)[0] || null', fails: ['page: a saved class answers cargo, hangar and deployment'] },
  { name: 'the unsaved changes not told from the saved brief', find: '!sameBrief(this.briefDraft, this.briefEntry ? this.briefEntry.payload : emptyBrief())', replace: 'false', fails: ['page: an edit marks the draft unsaved', 'page: opening another brief with unsaved changes asks first'] },
  { name: 'an unlisted brief opened as a blank one', find: '      if (uuid && !this.briefSaved.some((entry) => entry.uuid === uuid)) {\n        return\n      }\n', replace: '', fails: ['page: a brief made at a later game time is listed apart'] },
]

const PANEL_MUTATIONS = [
  { name: 'text that is not a figure not reported to the page', find: 'invalidSignature() {\n      this.$emit(\'invalid\', this.invalid)\n    },', replace: 'invalidSignature() {},', fails: ['panel: text that is not a figure is reported'] },
  { name: 'text that is not a figure given as a value', find: '      if (parsed.ok) {\n        this.$emit(\'field\', key, parsed.value)', replace: '      if (true) {\n        this.$emit(\'field\', key, parsed.value)', fails: ['panel: text that is not a figure is reported'] },
  { name: 'the text kept when another brief is opened', find: 'identity() {\n      this.typed = {}\n      this.errors = {}\n      this.syncTyped()\n    },', replace: 'identity() {},', fails: ['panel: the text starts over'] },
  { name: 'unfinished text dropped by an ordinary update', find: '} else if (this.typed[key] !== undefined && !parsed.ok && this.errors[key]) {', replace: '} else if (false) {', fails: ['panel: unfinished text stays'] },
  { name: 'the number of a range not scaled', find: 'return this.count(value / shown.scale, shown.digits)', replace: 'return this.count(value, shown.digits)', fails: ['panel: a range is shown with the number in billions of km', 'panel: the unit beside a figure'] },
  { name: 'the unit of a figure the canonical one', find: 'return shown ? shown.unit : requirement.unit || \'—\'', replace: 'return requirement.unit || \'—\'', fails: ['panel: a range is shown with the number in billions of km', 'panel: the unit beside a figure'] },
  { name: 'the unit cell of the table the canonical unit', find: '<td data-brief-cell="unit">{{ unitOf(requirement) }}</td>', replace: '<td data-brief-cell="unit">{{ requirement.unit || \'—\' }}</td>', fails: ['panel: a range is shown with the number in billions of km'] },
]

// ---------- the browser ----------

// The panel inside the page in a real browser (scripts/lib/page-server.js over a copy of the save, Chromium through scripts/lib/browser-observe.js `observe`): the wiring between the two and the drawn cells, which the pseudo instance and the render without a document cannot show. Nothing is saved.
const BROWSER_SAVE = { file: 'AuroraDB.db', game: 'Aurelian Empire', race: 'Aurelian Empire' }
const TIMEOUT = 90000

// What the brief panel draws, read through the shared readers (`window.__screen`); runs in the page. Each part of the panel by its hook (`data-brief`) with the text it draws and whether it is on screen; the text the speed field shows and the line under it (its hint, or the error drawn in the hint's place); given the id of an alternative, the cells of its range requirement by their roles (`data-brief-cell`); and the "Thousands Separator" setting the figures are grouped by.
const readBrief = (alternative) => {
  const { hooked, visibleText } = window.__screen
  const panel = document.querySelector('[data-brief="panel"]')
  const speed = document.querySelector('[data-brief-field="minSpeedKmS"]')
  const messages = speed && speed.closest('.v-input') ? speed.closest('.v-input').querySelector('.v-messages') : null
  const row = alternative === null ? null : document.querySelector(`[data-brief-detail="${CSS.escape(alternative)}"] [data-brief-requirement="minRangeKm"]`)

  return {
    parts: panel ? hooked(panel, 'data-brief') : null,
    speed: speed ? speed.value : null,
    line: messages ? visibleText(messages) : null,
    range: row ? hooked(row, 'data-brief-cell') : null,
    grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'),
  }
}

// The page once Vue has drawn what the step before it changed.
const drawn = (page) => page.evaluate(async () => { await window.$app.$nextTick() })

// The case as a player meets it, each step read where it ends; resolves to the record of `observe` with the screens read. Every wait is on the operation the check started: the route arrived and its reads done, the alternatives listed, the next draw after a field typed or a button clicked, the row of the requirement opened.
const observeBrief = (browser, url) => observe(browser, async ({ page, step }) => {
  const pageLoading = require('./page-loading')
  const read = (alternative = null) => page.evaluate(readBrief, alternative)
  const seen = {}

  step('opening the app')
  await installScreen(page)
  await page.goto(url, { timeout: TIMEOUT })
  await page.waitForFunction(() => Boolean(window.$app && window.$app.$store), null, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${BROWSER_SAVE.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(BROWSER_SAVE.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID), null, { timeout: TIMEOUT })
  step('opening the propulsion page')
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/propulsion')
  await page.waitForFunction(pageLoading.arrived, '/propulsion', { timeout: TIMEOUT })
  await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT })
  await page.waitForSelector('[data-brief-alternative]', { state: 'attached', timeout: TIMEOUT })

  step('typing text that is not a figure')
  await page.fill('[data-brief="name"]', 'Browser case')
  await page.fill('[data-brief-field="minSpeedKmS"]', 'abc')
  await drawn(page)
  seen.typed = await read()

  step('clicking Save while the text is there')
  await page.click('[data-brief="save"]', { force: true, timeout: TIMEOUT })
  await drawn(page)
  seen.saved = await read()

  step('asking for a new brief')
  await page.fill('[data-brief="name"]', '')
  await page.click('[data-brief="new"]', { timeout: TIMEOUT })
  await drawn(page)
  seen.asked = await read()

  step('discarding the changes')
  await page.click('[data-brief="discard-yes"]', { timeout: TIMEOUT })
  await drawn(page)
  seen.discarded = await read()

  step('requiring a range and opening the requirements of an alternative')
  await page.fill('[data-brief-field="minRangeKm"]', '20')
  await drawn(page)

  const alternative = await page.getAttribute('[data-brief-alternative]', 'data-brief-alternative', { timeout: TIMEOUT })

  await page.click(`[data-brief-alternative="${alternative}"] button`, { timeout: TIMEOUT })
  await page.waitForSelector(`[data-brief-detail="${alternative}"] [data-brief-requirement="minRangeKm"]`, { state: 'attached', timeout: TIMEOUT })
  seen.range = await read(alternative)

  return seen
})

// The page server and the Chromium of a worker that runs the parts served to the browser, started and warmed once by `prepare` for every part of its queue and stopped by `close`. Each part is served on its own (`server.replace`) and seen in a context of its own; the reset after each part puts the server back as it started. A server or a browser that did not start is kept as `failure`, and every observation of the worker is then one that did not happen.
const BROWSER = { server: null, chrome: null, failure: null }

const openBrowser = async () => {
  try {
    BROWSER.server = await startPageServer({ save: BROWSER_SAVE.file })
    BROWSER.chrome = await require('playwright').chromium.launch()

    const warmed = await BROWSER.server.warm(BROWSER.chrome, { routes: ['/propulsion'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  } catch (error) {
    BROWSER.failure = String(error.message).split('\n')[0]
  }
}

const closeBrowser = async () => {
  const { server, chrome } = BROWSER

  BROWSER.server = null
  BROWSER.chrome = null

  if (chrome) {
    await chrome.close()
  }

  if (server) {
    await server.stop()
  }
}

// Serves the panel as given (`source`, null for the real one) and resolves the record of `observe`, or a failed one that names why there is none.
const observeSource = async (source) => {
  if (BROWSER.failure || !BROWSER.chrome) {
    return failedObservation(BROWSER.failure || 'the page server was not started for this worker')
  }

  BROWSER.server.replace(panelFile, source)

  try {
    const seen = await observeBrief(BROWSER.chrome, BROWSER.server.url)

    report(source === null ? 'the propulsion page' : 'a variant of the panel', seen)

    return seen
  } catch (error) {
    return failedObservation(String(error.message).split('\n')[0])
  } finally {
    BROWSER.server.replace(panelFile, null)
  }
}

// The lines the module draws under a field, by key, from its own tables: the hint of each requirement (REQUIREMENTS) and the error of each refused text (FIELD_ERRORS).
const fieldLinesOf = (mb) => ({ ...Object.fromEntries(mb.REQUIREMENTS.filter((definition) => definition.hint).map((definition) => [definition.key, definition.hint])), ...mb.FIELD_ERRORS })

// The checks of the browser case: `[name, test]`, each test given the screens read and the record of the observation, and returning true or what was seen. The hooks find the elements; what is judged is the text they draw on screen: a state read back through the module's own words (`labelKey`), a figure whole in the grouping of the setting (`readFigure`), the cells of a row by their roles (`rolesRead`).
const browserStatements = (m) => {
  const { mb } = m
  const definition = mb.requirementOf('minRangeKm')
  const lines = fieldLinesOf(mb)
  const parts = (screen, role) => screen.parts.filter((entry) => entry.role === role)
  const chip = (screen, wanted) => rolesRead('the panel', parts(screen, 'dirty-chip'), { 'dirty-chip': wanted }, (text) => labelKey(text, mb.BRIEF_WORDS))

  return [
    ['browser: text that is not a figure shows its error in place of the field\'s hint, marks the brief as changed and leaves Save doing nothing', (seen) => {
      const problems = [
        ...(seen.typed.speed === 'abc' ? [] : [['the speed field', seen.typed.speed]]),
        ...(labelKey(seen.typed.line, lines) === 'notAFigure' ? [] : [['the line under the speed field', seen.typed.line]]),
        ...chip(seen.typed, 'unsaved'),
        ...rolesRead('the panel after Save', parts(seen.saved, 'message'), { message: null }),
        ...(seen.saved.speed === 'abc' && labelKey(seen.saved.line, lines) === 'notAFigure' ? [] : [['the speed field after Save', seen.saved.speed, seen.saved.line]]),
      ]

      return problemsHeld(problems)
    }],
    ['browser: New asks before it drops text that is not a figure, and the text and its error do not carry over', (seen) => {
      const problems = [
        ...rolesRead('the panel once New is clicked', parts(seen.asked, 'question'), { question: 'discardBlank' }, (text) => labelKey(text, mb.BRIEF_WORDS)),
        ...(seen.asked.speed === 'abc' ? [] : [['the speed field once New is clicked', seen.asked.speed]]),
        ...chip(seen.asked, 'unsaved'),
        ...(seen.discarded.speed === '' ? [] : [['the speed field once discarded', seen.discarded.speed]]),
        ...(labelKey(seen.discarded.line, lines) === 'minSpeedKmS' ? [] : [['the line under the speed field once discarded', seen.discarded.line]]),
        ...chip(seen.discarded, null),
      ]

      return problemsHeld(problems)
    }],
    ['browser: a range required in billions of km is drawn with its number and the unit bn km', (seen) => (seen.range.range === null ? 'no row of the range was opened' : problemsHeld(regionRead('the range of the first alternative', seen.range.range, {
      label: [definition.label, (text) => text],
      verdict: [true, (text) => text !== ''],
      required: [20, (text) => readFigure(text, seen.range.grouping)],
      actual: [true, (text) => text !== ''],
      unit: [definition.input.unit, (text) => text],
      reason: [true, (text) => text.includes(definition.input.unit)],
    })))],
    ['browser: no page error was raised', (_seen, observation) => problemsHeld(observation.unexpected)],
  ]
}

// The browser checks for `runChecks` over { observation }: a page that did not get through fails each of them by naming why.
const browserChecks = (m) => browserStatements(m).map(([name, test]) => ({ id: name, name, run: ({ observation }) => verdictHeld(unobserved(observation) ? `the page did not get through: ${observation.error}` : test(observation.value, observation)) }))

// A fault or a benign rewrite of the panel served to the browser (`observeSource`). A fault must fail by a value each check it names (`caughtBy`), a rewrite none; a variant whose page did not get through is judged by nothing and fails as a defect of the harness, as nothing may be credited with it.
const checkBrowserVariant = async ({ kind, name, find, replace, fails = [], throws = false }, real) => {
  const began = Date.now()
  const fault = kind === 'browser'
  const observation = await observeSource(patched(panelFile, fs.readFileSync(panelFile, 'utf8'), find, replace))

  if (unobserved(observation)) {
    throw new HarnessError(`the panel ${fault ? 'with the fault' : 'rewritten as'} "${name}" did not get through: ${observation.error}`)
  }

  const results = await runChecks(browserChecks(real), { observation })
  const failed = judged(results, `the ${fault ? 'fault' : 'rewrite'} "${name}"`)
  const took = `${((Date.now() - began) / 1000).toFixed(1)} s`

  if (fault) {
    const missed = fails.filter((start) => !caughtBy(failed, results.map((result) => result.id).filter((id) => id.startsWith(start)), { name, throws }))

    check(`browser mutation caught: ${name}`, missed.length ? `these checks did not fail by a value: ${missed.join('; ')}` : true, `credited by ${creditOf(failed)}, ${took}`)
  } else {
    check(`browser benign rewrite: ${name}: no check fails`, failed.length === 0 ? true : failed.map((result) => `${result.name}: ${result.detail}`).join('; '), took)
  }
}

// Faults planted in the panel the browser is served, with the checks each must fail by a value: a figure, and the question asked before a blank brief is opened, drawn wrong with their hooks kept (FU-46), and the cell, or the row that holds it, drawn with no opacity (FU-43).
const BROWSER_MUTATIONS = [
  { name: 'the required figure drawn unscaled, its hook kept', find: '{{ requirement.required === null ? \'—\' : amount(requirement.key, requirement.required) }}', replace: '{{ requirement.required === null ? \'—\' : count(requirement.required) }}', fails: ['browser: a range required in billions of km'] },
  { name: 'the required cell drawn with no opacity', find: '<td class="text-right text-no-wrap" data-brief-cell="required">', replace: '<td class="text-right text-no-wrap" data-brief-cell="required" style="opacity: 0">', fails: ['browser: a range required in billions of km'] },
  { name: 'the row of the requirements of an alternative drawn with no opacity', find: ':data-brief-detail="item.id">', replace: ':data-brief-detail="item.id" style="opacity: 0">', fails: ['browser: a range required in billions of km'] },
  { name: 'the question before a blank brief asks about the other brief, its hook kept', find: '{{ pending.blank ? briefWords.discardBlank : briefWords.discardOther }}', replace: '{{ pending.blank ? briefWords.discardOther : briefWords.discardBlank }}', fails: ['browser: New asks before it drops text'] },
]

// Rewrites of the panel the browser is served that draw the same screen, one of each family (a test written the other way round, full opacity): each must leave every browser check passing.
const BROWSER_BENIGN = [
  { name: 'the required figure written with the test the other way round', find: '{{ requirement.required === null ? \'—\' : amount(requirement.key, requirement.required) }}', replace: '{{ requirement.required !== null ? amount(requirement.key, requirement.required) : \'—\' }}' },
  { name: 'full opacity on the row of the requirements of an alternative', find: ':data-brief-detail="item.id">', replace: ':data-brief-detail="item.id" style="opacity: 1">' },
]

// ---------- the mutants of the utilities ----------

const GROUPS = (m) => [...unitChecks(m), ...evaluationChecks(m), ...rankingChecks(m), ...presetChecks(m), ...alternativeChecks(m), ...recordChecks(m)]

const MUTATIONS = [
  { name: 'tons taken at 100 to the HS', file: 'mission-briefs.js', find: 'export const hsOfTons = (tons) => tons / TONS_PER_HS', replace: 'export const hsOfTons = (tons) => tons / 100', fails: ['units: 50 tons are 1 HS', 'evaluation: the size limit passes at the limit'] },
  { name: 'a size typed in tons not converted', find: '(definition.key === \'maxSizeHS\' && sizeUnit === \'tons\' ? 1 / TONS_PER_HS : definition.input.scale)', replace: '(definition.key === \'maxSizeHS\' && sizeUnit === \'tons\' ? 1 : definition.input.scale)', file: 'mission-briefs.js', fails: ['units: a size typed in tons', 'units: a stored value is typed back', 'evaluation: the size limit passes at the limit'] },
  { name: 'a cargo capacity read as HS of hold', find: 'export const cargoTonsOfCapacity = (capacity) => capacity', replace: 'export const cargoTonsOfCapacity = (capacity) => capacity * 50', file: 'mission-briefs.js', fails: ['units: a hold stores 50 tons', 'alternative: a saved class gives its cargo'] },
  { name: 'a hold taken to store 1 ton to the HS', find: 'export const cargoTonsOfHoldHS = (sizeHS) => sizeHS * CARGO_POINTS_PER_HS', replace: 'export const cargoTonsOfHoldHS = (sizeHS) => sizeHS', file: 'mission-briefs.js', fails: ['units: a hold stores 50 tons'] },
  { name: 'a hangar capacity read as tons of hull', find: 'export const hangarHSOfCapacity = (capacity) => capacity', replace: 'export const hangarHSOfCapacity = (capacity) => capacity * TONS_PER_HS', file: 'mission-briefs.js', fails: ['units: a hold stores 50 tons', 'alternative: a saved class gives its cargo'] },
  { name: 'a range typed in billions read as km', find: 'return Number.isFinite(number) && number > 0 ? { ok: true, value: number * typedScale(definition, sizeUnit) }', replace: 'return Number.isFinite(number) && number > 0 ? { ok: true, value: number }', file: 'mission-briefs.js', fails: ['units: a range typed in billions of km'] },
  { name: 'a cruise power typed in percent kept as typed', find: '{ ok: true, value: number / 100 } : { ok: false, error: FIELD_ERRORS.notAPercent }', replace: '{ ok: true, value: number } : { ok: false, error: FIELD_ERRORS.notAPercent }', file: 'mission-briefs.js', fails: ['units: a range typed in billions of km'] },
  { name: 'text that is not a positive number accepted', find: 'return Number.isFinite(number) && number > 0 ? { ok: true, value: number * typedScale(definition, sizeUnit) }', replace: 'return Number.isFinite(number) ? { ok: true, value: number * typedScale(definition, sizeUnit) }', file: 'mission-briefs.js', fails: ['fields: an empty text clears a field'] },
  { name: 'an unknown figure passing', find: 'actual: null, verdict: \'unknown\', reason: unknownReason(definition, figure)', replace: 'actual: null, verdict: \'pass\', reason: unknownReason(definition, figure)', file: 'mission-briefs.js', fails: ['evaluation: an unknown figure never passes', 'evaluation: each requirement gives', 'evaluation: the verdict comes from the requirements alone'] },
  { name: 'an unknown figure read as 0', find: 'actual: null, verdict: \'unknown\', reason: unknownReason(definition, figure)', replace: 'actual: 0, verdict: \'fail\', reason: unknownReason(definition, figure)', file: 'mission-briefs.js', fails: ['evaluation: an unknown figure never passes', 'evaluation: each requirement gives'] },
  { name: 'a figure of 0 taken for unknown', find: 'if (!isAvailable(figure)) {\n    return { ...base, actual: null, verdict: \'unknown\'', replace: 'if (!isAvailable(figure) || !figure.value) {\n    return { ...base, actual: null, verdict: \'unknown\'', file: 'mission-briefs.js', fails: ['evaluation: a figure of 0 is a figure'] },
  { name: 'no tolerance on the limit', find: 'const slack = (value) => Math.max(Math.abs(value) * EPSILON, 1e-12)', replace: 'const slack = () => 0', file: 'mission-briefs.js', fails: ['evaluation: the size limit passes at the limit'] },
  { name: 'an upper limit read as a lower one', find: 'definition.comparison === \'atLeast\' ? actual >= required - slack(required) : definition.comparison === \'atMost\' ? actual <= required + slack(required)', replace: 'definition.comparison === \'atLeast\' ? actual >= required - slack(required) : definition.comparison === \'atMost\' ? actual >= required + slack(required)', file: 'mission-briefs.js', fails: ['evaluation: the size limit passes at the limit', 'evaluation: each requirement gives'] },
  { name: 'a requirement that is not set judged', find: 'REQUIREMENTS.filter((definition) => brief.requirements[definition.key] !== null).map((definition) => evaluateRequirement', replace: 'REQUIREMENTS.filter((definition) => true).map((definition) => evaluateRequirement', file: 'mission-briefs.js', fails: ['evaluation: a figure of 0 is a figure, and a requirement that is not set'] },
  { name: 'a note counted in the verdict', find: 'const unknown = hard.filter((item) => item.verdict === \'unknown\')', replace: 'const unknown = [...hard, ...optional].filter((item) => item.verdict === \'unknown\')', file: 'mission-briefs.js', fails: ['evaluation: a note a preset cannot model'] },
  { name: 'a violated requirement outweighed by an unknown one', find: 'const verdict = !hard.length ? \'none\' : violated.length ? \'fails\' : unknown.length ? \'open\' : \'meets\'', replace: 'const verdict = !hard.length ? \'none\' : unknown.length ? \'open\' : violated.length ? \'fails\' : \'meets\'', file: 'mission-briefs.js', fails: ['evaluation: the verdict comes from the requirements alone'] },
  { name: 'the preferences deciding the verdict', find: 'const verdict = !hard.length ? \'none\'', replace: 'const verdict = !hard.length && !brief.axes.length ? \'none\'', file: 'mission-briefs.js', fails: ['ranking: a preference never changes a verdict', 'evaluation: the verdict comes from the requirements alone'] },
  { name: 'the violated requirements not listed', find: 'const violated = hard.filter((item) => item.verdict === \'fail\')', replace: 'const violated = hard.filter((item) => item.verdict === \'fail\').slice(0, 1)', file: 'mission-briefs.js', fails: ['evaluation: every violated and every unknown requirement is named'] },
  { name: 'the cruise power of the brief assumed', find: 'if (definition.needs === \'cruiseShare\' && brief.cruiseShare === null) {', replace: 'if (false) {', file: 'mission-briefs.js', fails: ['evaluation: endurance is measured at the cruise power of the brief'] },
  { name: 'the endurance of a set measured without a cruise power', find: 'if (!context || context.cruiseShare === null || context.cruiseShare === undefined) {', replace: 'if (false) {', file: 'mission-briefs.js', fails: ['alternative: the endurance of a set is measured at the cruise power'] },
  { name: 'the endurance of a set measured at full power', find: 'fraction: context.cruiseShare })', replace: 'fraction: 1 })', file: 'mission-briefs.js', fails: ['alternative: the size, space beside the propulsion'] },
  { name: 'a classification that is not the one required passing', find: ': actual === required\n', replace: ': true\n', file: 'mission-briefs.js', fails: ['evaluation: a classification must match'] },
  { name: 'the alternatives ranked by the failing ones first', find: 'return GROUP[a.verdict] - GROUP[b.verdict]', replace: 'return GROUP[b.verdict] - GROUP[a.verdict]', file: 'mission-briefs.js', fails: ['ranking: the meeting alternatives come first'] },
  { name: 'the verdicts not told apart when ranking', find: 'if (GROUP[a.verdict] !== GROUP[b.verdict]) {', replace: 'if (false) {', file: 'mission-briefs.js', fails: ['ranking: the meeting alternatives come first'] },
  { name: 'the preferences ignored', find: 'for (let index = 0; index < a.axes.length; index++) {', replace: 'for (let index = 0; index < 0; index++) {', file: 'mission-briefs.js', fails: ['ranking: preferences order within a verdict', 'ranking: an unknown figure sorts after'] },
  { name: 'a larger-first preference read as smaller-first', find: 'return a.axes[index].direction === \'min\' ? first - second : second - first', replace: 'return a.axes[index].direction === \'min\' ? second - first : first - second', file: 'mission-briefs.js', fails: ['ranking: preferences order within a verdict', 'ranking: an unknown figure sorts after'] },
  { name: 'an unknown figure sorted first', find: 'return first === null ? 1 : -1', replace: 'return first === null ? -1 : 1', file: 'mission-briefs.js', fails: ['ranking: an unknown figure sorts after'] },
  { name: 'a tie not falling to the next preference', find: 'if (Math.abs(first - second) > slack(Math.max(Math.abs(first), Math.abs(second)))) {', replace: 'if (true) {', file: 'mission-briefs.js', fails: ['ranking: preferences order within a verdict'] },
  { name: 'ties reordered', find: 'return a.index - b.index', replace: 'return b.index - a.index', file: 'mission-briefs.js', fails: ['ranking: alternatives that tie keep the order'] },
  { name: 'a preview marking every field an addition', find: 'kind: from === null || from === undefined || from === \'\' ? \'add\' : equalValue(from, to) ? \'same\' : \'replace\' })', replace: 'kind: \'add\' })', file: 'mission-briefs.js', fails: ['presets: a preview lists what would be added', 'presets: applying a preset again shows no change'] },
  { name: 'a preset applied whatever is ticked', find: 'if (!wanted.has(item.key)) {', replace: 'if (false) {', file: 'mission-briefs.js', fails: ['presets: only the ticked fields are applied', 'presets: nothing ticked changes nothing'] },
  { name: 'the draft changed in place by a preset', find: 'export const applyPreview = (draft, preview, accepted) => {\n  const brief = copyOf(normaliseBrief(draft))', replace: 'export const applyPreview = (draft, preview, accepted) => {\n  const brief = draft', file: 'mission-briefs.js', fails: ['presets: only the ticked fields are applied'] },
  { name: 'a preset recorded on a draft it changed nothing in', find: 'if (applied.length) {\n    brief.preset = preview.preset', replace: 'if (true) {\n    brief.preset = preview.preset', file: 'mission-briefs.js', fails: ['presets: nothing ticked changes nothing'] },
  { name: 'the fighter preset the same as the survey one', find: 'requirements: Object.freeze({ maxSizeHS: 10, minSpeedKmS: 8000, minEnduranceDays: 2, minPayloadHS: 3, classification: \'military\' })', replace: 'requirements: Object.freeze({ maxSizeHS: 200, minSpeedKmS: 3000, minRangeKm: 20 * KM_PER_BN, minEnduranceDays: 90, minDeploymentMonths: 24 })', file: 'mission-briefs.js', fails: ['presets: survey and fighter give different visible requirements'] },
  { name: 'the notes of a preset made requirements', find: 'preset.unmodelled.filter((note) => !current.unmodelled.some((have) => have.key === note.key)).forEach((note) => items.push({ key: `note:$' + '{note.key}`, label: note.label, from: null, to: note.note, kind: \'add\' }))', replace: '', file: 'mission-briefs.js', fails: ['presets: what a preset cannot model stays an unknown note'] },
  { name: 'a name given overwritten by a preset', find: 'if (!isText(current.name)) {', replace: 'if (true) {', file: 'mission-briefs.js', fails: ['presets: a blank name is filled'] },
  { name: 'a set passing cargo', find: 'unknownFigure(SET_WITHOUT.cargoTons, \'tons\')', replace: 'ofRule({ rule: \'brief.classCargo\', value: 1e9, units: \'tons\', inputs: { present: [\'assumed\'] } })', file: 'mission-briefs.js', fails: ['alternative: a propulsion set is unknown for cargo', 'alternative: a cargo capacity equal to the requirement passes'] },
  { name: 'a set passing a hangar', find: 'unknownFigure(SET_WITHOUT.hangarHS, \'HS\')', replace: 'ofRule({ rule: \'brief.classHangar\', value: 1e9, units: \'HS\', inputs: { present: [\'assumed\'] } })', file: 'mission-briefs.js', fails: ['alternative: a propulsion set is unknown for cargo'] },
  { name: 'a set given a deployment', find: 'unknownFigure(SET_WITHOUT.deploymentMonths, \'months\')', replace: 'ofRule({ rule: \'brief.classDeployment\', value: 1e9, units: \'months\', inputs: { present: [\'assumed\'] } })', file: 'mission-briefs.js', fails: ['alternative: a propulsion set is unknown for cargo'] },
  { name: 'a designed set taking the figures of a class', find: 'cargoTons: pinned ? stored(', replace: 'cargoTons: classFigures ? stored(', file: 'mission-briefs.js', fails: ['alternative: the class figures of a set that is not pinned are ignored', 'alternative: a propulsion set is unknown for cargo'] },
  { name: 'every set with a commercial engine military', find: 'else if (row.type === \'Military\') {', replace: 'else if (true) {', file: 'mission-briefs.js', fails: ['alternative: the classification of a set'] },
  { name: 'a commercial class read as military', find: 'value: commercial ? \'commercial\' : \'military\'', replace: 'value: commercial ? \'military\' : \'commercial\'', file: 'mission-briefs.js', fails: ['alternative: a saved class gives its cargo'] },
  { name: 'a class figure the save lacks read as 0', find: 'cargoCapacity: numberOrNull(row.CargoCapacity),', replace: 'cargoCapacity: Number(row.CargoCapacity) || 0,', file: 'mission-briefs.js', fails: ['class figures: the loader reads what the save stores'] },
  { name: 'a class figure that is not stored read as 0 in the alternative', find: 'return value === null ? unavailable({ rule, units, missing: [`The save stores no $' + '{name} for this class`] })', replace: 'return value === null ? ofRule({ rule, value: 0, units, inputs: { present: [name] } })', file: 'mission-briefs.js', fails: ['alternative: a saved class is unknown for what the save lacks'] },
  { name: 'a hypothetical level not carried into the size', find: ': envelope({ value: row.totalHS, status: stateOf(STATUS.ASSUMED), rule: \'brief.setSize\', units: \'HS\', inputs: { present: [\'hull\', \'engines\', \'fuel tanks\'] }, assumptions: basis.assumptions })', replace: ': envelope({ value: row.totalHS, status: STATUS.ASSUMED, rule: \'brief.setSize\', units: \'HS\', inputs: { present: [\'hull\', \'engines\', \'fuel tanks\'] } })', file: 'mission-briefs.js', fails: ['alternative: a hypothetical tech level carries'] },
  { name: 'a brief kept for the branch only', find: 'policy: \'campaign\', ...patch', replace: 'policy: \'branch\', ...patch', file: 'mission-briefs.js', fails: ['record: a brief is seen on every branch of the campaign', 'record: a brief is kept as a typed record'] },
  { name: 'the file\'s grant not waited for', find: 'if (!(await repository.writable(scope.campaignId))) {', replace: 'if (!repository.writable(scope.campaignId)) {', file: 'mission-briefs.js', fails: ['record: a tab that does not hold the file writes nothing'] },
  { name: 'a brief made at a later game time applied', find: 'ahead: item.status === \'ahead\', otherBranch', replace: 'ahead: false, otherBranch', file: 'mission-briefs.js', fails: ['record: a brief made at a later game time is listed, flagged'] },
  { name: 'a brief moved to this save not rebased', find: '{ rebase: true }', replace: '{}', file: 'mission-briefs.js', fails: ['record: a brief made at a later game time is listed, flagged'] },
  { name: 'a stale save written over without asking', find: 'if (!overwrite) {', replace: 'if (false) {', file: 'mission-briefs.js', fails: ['record: a stale save is refused'] },
  { name: 'a brief that is not valid written', find: 'if (problems.length) {\n      return { ok: false, code: \'invalid-brief\'', replace: 'if (false) {\n      return { ok: false, code: \'invalid-brief\'', file: 'mission-briefs.js', fails: ['record: a brief that is not valid is refused'] },
  { name: 'the repository not told what a valid brief is', find: 'validate: problemsOf,', replace: 'validate: () => [],', file: 'mission-briefs.js', fails: ['record: a brief that is not valid is refused'] },
  { name: 'a missing scope reported as a missing repository', find: 'if (!scope) {\n    return { ok: false, code: \'no-scope\'', replace: 'if (!scope) {\n    return { ok: false, code: \'no-repository\'', file: 'mission-briefs.js', fails: ['record: no repository and no scope write nothing'] },
  { name: 'a missing repository reported as a missing scope', find: 'if (!repository) {\n    return { ok: false, code: \'no-repository\'', replace: 'if (!repository) {\n    return { ok: false, code: \'no-scope\'', file: 'mission-briefs.js', fails: ['record: no repository and no scope write nothing'] },
  { name: 'a stale delete accepted', find: 'return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed', replace: 'return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, repository.read(scope, entry.uuid).revision) } : allowed', file: 'mission-briefs.js', fails: ['record: a brief is edited in place and deleted'] },
]

const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mission-briefs-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation does not apply to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

// ---------- the saves ----------

// The script's own arguments (those of scripts/lib/suite-runner.js taken out by `runnerArgs`).
const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({
      query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
        const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
        const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

        raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
      }),
      close: () => raw.close(),
    })
  })
})

const rowsOf = async (database, sql, replacements = {}) => (await database.query(sql, { replacements }))[0]

// The checks of one save. Everything the oracle reads is SQL of its own, not the loader's.
const saveChecks = async (m, database, { GameID, RaceID }, label) => {
  const { mb, pv } = m
  const results = []
  const add = (name, verdict, detail = '') => results.push([`${label}: ${name}`, verdict, detail])
  const holds = await rowsOf(database, 'select Size, ComponentValue as cv from FCT_ShipDesignComponents where ComponentTypeID = 4')

  add(`a cargo hold stores 50 capacity points to the HS of its size (${holds.length} holds)`, holds.length > 0 && holds.every((row) => close(row.cv, row.Size * 50)) ? true : short(holds.find((row) => !close(row.cv, row.Size * 50))))

  const sums = await rowsOf(database, 'select c.ShipClassID as id, c.CargoCapacity as cargo, c.ParasiteCapacity as hangar, coalesce(sum(case when d.ComponentTypeID = 4 then cc.NumComponent * d.ComponentValue end), 0) as holds, coalesce(sum(case when d.ComponentTypeID in (43, 58) then cc.NumComponent * d.ComponentValue end), 0) as decks from FCT_ShipClass c left join FCT_ClassComponent cc on cc.ClassID = c.ShipClassID and cc.GameID = c.GameID left join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where c.GameID = :GameID group by c.ShipClassID', { GameID })
  const offCargo = sums.filter((row) => !close(row.cargo, row.holds))
  const offHangar = sums.filter((row) => !close(row.hangar, row.decks))

  add(`a class's cargo capacity is the sum of its holds' capacity points, in tons (${sums.length} classes, ${sums.filter((row) => row.holds > 0).length} with a hold)`, sums.length > 0 && sums.some((row) => row.holds > 0) && offCargo.length === 0 ? true : short(offCargo.slice(0, 3)))
  add(`a class's hangar capacity is the sum of its military and commercial hangar decks' capacity, in HS (${sums.filter((row) => row.decks > 0).length} with a hangar)`, sums.some((row) => row.decks > 0) && offHangar.length === 0 ? true : short(offHangar.slice(0, 3)))

  const decks = await rowsOf(database, 'select Size, ComponentValue as cv from FCT_ShipDesignComponents where ComponentTypeID in (43, 58) and ComponentValue > 0')

  add(`a hangar deck holds ships of no more HS than its own size (${decks.length} decks)`, decks.length > 0 && decks.every((row) => row.cv <= row.Size + 1e-9) ? true : short(decks.find((row) => row.cv > row.Size)))

  const docked = await rowsOf(database, 'select m.ShipID as mother, mc.ParasiteCapacity as capacity, sum(sc.Size) as held, count(*) as ships from FCT_Ship s inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID inner join FCT_Ship m on m.ShipID = s.MothershipID inner join FCT_ShipClass mc on mc.ShipClassID = m.ShipClassID where s.GameID = :GameID and s.MothershipID > 0 group by m.ShipID, mc.ParasiteCapacity', { GameID })

  add(`the ships docked in a mother ship never total more than its hangar capacity (${docked.length} mother ships)`, docked.every((row) => row.held <= row.capacity + 1e-6) ? true : short(docked.find((row) => row.held > row.capacity + 1e-6)))

  const fighters = await rowsOf(database, 'select count(*) as n, max(Size) as biggest from FCT_ShipClass where GameID = :GameID and FighterClass = 1', { GameID })

  add(`no fighter class is as big as 10 HS (${fighters[0].n} fighter classes, the biggest ${fighters[0].biggest === null ? 'none' : Number(fighters[0].biggest).toFixed(3)} HS)`, fighters[0].n > 0 && fighters[0].biggest < 10 ? true : short(fighters))

  const engines = await rowsOf(database, 'select c.Commercial as commercial, d.MilitarySystem as military, count(distinct c.ShipClassID) as n from FCT_ShipClass c inner join FCT_ClassComponent cc on cc.ClassID = c.ShipClassID and cc.GameID = c.GameID inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where c.GameID = :GameID and d.ComponentTypeID = 1 group by c.Commercial, d.MilitarySystem', { GameID })
  const both = engines.filter((row) => row.commercial === 1 && row.military === 1)

  add(`no commercial class mounts a military engine, so a military engine makes the class military (${engines.filter((row) => row.military === 1).reduce((total, row) => total + row.n, 0)} classes mount one)`, both.length === 0 && engines.some((row) => row.military === 1) ? true : short(engines))

  const figures = await mb.loadClassFigures(database, { GameID, RaceID })
  const classes = await rowsOf(database, 'select ShipClassID as id, CargoCapacity as cargo, ParasiteCapacity as hangar, PlannedDeployment as deployment, Commercial as commercial from FCT_ShipClass where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })
  const wrong = classes.filter((row) => {
    const read = figures[row.id]

    return !read || read.cargoCapacity !== row.cargo || read.hangarCapacity !== row.hangar || read.plannedDeployment !== row.deployment || read.commercial !== Boolean(row.commercial)
  })

  add(`the loader's figures of every class of the race equal SQL of its own (${classes.length} classes)`, classes.length > 0 && wrong.length === 0 && Object.keys(figures).length === classes.length ? true : short(wrong.slice(0, 3)))

  const tested = classes.filter((row) => row.cargo > 0 || row.hangar > 0).slice(0, 60)
  const problems = []

  for (const row of tested) {
    const alternative = mb.propulsionAlternative(rowOf(m, `class-${row.id}`, { pinned: true }), figures[row.id])
    const at = { cargoTons: row.cargo, hangarHS: row.hangar, deploymentMonths: row.deployment }
    const keys = { cargoTons: 'minCargoTons', hangarHS: 'minHangarHS', deploymentMonths: 'minDeploymentMonths' }

    for (const [figure, key] of Object.entries(keys)) {
      if (!(at[figure] > 0)) {
        continue
      }

      const result = evaluated(m, briefOf(m, { [key]: at[figure] }), [alternative]).alternatives[0]
      const over = evaluated(m, briefOf(m, { [key]: at[figure] + 1 }), [alternative]).alternatives[0]
      const classification = evaluated(m, briefOf(m, { classification: row.commercial ? 'commercial' : 'military' }), [alternative]).alternatives[0]
      const opposite = evaluated(m, briefOf(m, { classification: row.commercial ? 'military' : 'commercial' }), [alternative]).alternatives[0]

      if (result.verdict !== 'meets' || over.verdict !== 'fails' || classification.verdict !== 'meets' || opposite.verdict !== 'fails') {
        problems.push([row.id, figure, result.verdict, over.verdict, classification.verdict, opposite.verdict])
      }
    }
  }

  add(`a saved class meets a requirement equal to its stored cargo, hangar and deployment and fails one more, and its classification is the saved one (${tested.length} classes)`, tested.length > 0 && problems.length === 0 ? true : short(problems.slice(0, 3)))

  const set = mb.propulsionAlternative(rowOf(m, 'set'), null)
  const setFigures = ['cargoTons', 'hangarHS', 'deploymentMonths'].map((key) => mb.figureOf(set, key, {}))

  add('a propulsion set is unknown for cargo, hangar and deployment against this save too', setFigures.every((figure) => !pv.isAvailable(figure)) ? true : short(setFigures))

  const options = await loadPage('pages/propulsion', { stubs: STUBS })
  const vm = instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }, database, GameID, RaceID })
  const viaPage = await vm.runAsync('classFigures')

  add('the page reads the same class figures as the loader', equal(JSON.parse(JSON.stringify(viaPage)), JSON.parse(JSON.stringify(figures))) ? true : short(Object.keys(viaPage).length))

  return results
}

// ---------- the parts: each mutant, each group of the real sources and each save run in a process of their own ----------

const MUTANTS = [
  ...MUTATIONS.map((mutation, index) => ({ kind: 'utility', id: `utility:${index}`, ...mutation })),
  ...PAGE_MUTATIONS.map((mutation, index) => ({ kind: 'page', id: `page:${index}`, ...mutation })),
  ...PANEL_MUTATIONS.map((mutation, index) => ({ kind: 'panel', id: `panel:${index}`, ...mutation })),
  ...BROWSER_MUTATIONS.map((mutation, index) => ({ kind: 'browser', id: `browser:${index}`, ...mutation })),
  ...BROWSER_BENIGN.map((rewrite, index) => ({ kind: 'browser-benign', id: `browser-benign:${index}`, ...rewrite })),
]

const SAVE_LABELS = ['modded', 'stock']

// The verdict on a fault over the checks it names (`named`, `[name, test]`): each start of `fails` must begin a check that failed by a value (`caughtBy`, which stops the run when only checks that threw would credit the fault, unless the fault declares `throws`). Returns [verdict, detail], the detail naming each check that failed and how.
const faultVerdict = async (named, { name, fails, throws = false }, began) => {
  const absent = fails.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))
  const failed = judged(await runChecks(asChecks(named), {}), `the fault "${name}"`)
  const missed = fails.filter((start) => !caughtBy(failed, named.map(([checkName]) => checkName).filter((checkName) => checkName.startsWith(start)), { name, throws }))

  return [absent.length ? `no check begins ${absent.join('; ')}` : missed.length ? `these checks did not fail by a value: ${missed.join('; ')}` : true, `credited by ${creditOf(failed)}, ${((Date.now() - began) / 1000).toFixed(1)} s`]
}

const checkUtilityMutation = async (mutant) => {
  const { name, file, find, replace, fails } = mutant
  const began = Date.now()
  let directory = null

  try {
    directory = mutatedCopy(file, find, replace)

    const named = GROUPS(await loadAll(directory)).filter(([checkName]) => fails.some((start) => checkName.startsWith(start)))
    const [verdict, detail] = await faultVerdict(named, mutant, began)

    check(`mutation caught: ${name}`, verdict, detail)
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error
    }

    check(`mutation caught: ${name}`, `does not load: ${error.message}`)
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const checkPageMutation = async (mutant, real) => {
  const { kind, name, find, replace, fails } = mutant
  const statementsOf = kind === 'page' ? pageStatements : panelStatements
  const began = Date.now()

  try {
    const named = (await statementsOf(replacing(find, replace), real)).filter(([statement]) => fails.some((start) => statement.startsWith(start)))
    const [verdict, detail] = await faultVerdict(named, mutant, began)

    check(`${kind} mutation caught: ${name}`, verdict, detail)
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error
    }

    check(`${kind} mutation caught: ${name}`, `does not load: ${error.message}`)
  }
}

const checkSave = async (label, [file, GameID, RaceID], real) => {
  console.log(`\n${label} save: ${file} (game ${GameID}, race ${RaceID})`)

  const database = await openSave(file)

  if (!database) {
    console.log(`SKIP  ${file} is not there`)

    return
  }

  for (const [name, verdict, detail] of await saveChecks(real, database, { GameID, RaceID }, label)) {
    check(name, verdict, detail)
  }

  database.close()
}

// One part, in this process: `groups`, `page`, `panel`, `browser`, a mutant or a benign rewrite by its id, or a save by its label.
const runPart = async (part, options) => {
  const mutant = MUTANTS.find(({ id }) => id === part)

  if (mutant && mutant.kind === 'utility') {
    await checkUtilityMutation(mutant)

    return
  }

  const real = await loadAll()

  if (part === 'groups') {
    printResults(await runChecks(asChecks(GROUPS(real)), {}))
  } else if (part === 'page') {
    printResults(await runChecks(asChecks(await pageStatements(null, real)), {}))
  } else if (part === 'panel') {
    printResults(await runChecks(asChecks(await panelStatements(null, real)), {}))
  } else if (part === 'browser') {
    printResults(await runChecks(browserChecks(real), { observation: await observeSource(null) }))
  } else if (mutant && mutant.kind.startsWith('browser')) {
    await checkBrowserVariant(mutant, real)
  } else if (mutant) {
    await checkPageMutation(mutant, real)
  } else if (SAVE_LABELS.includes(part)) {
    await checkSave(part, options[part], real)
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

// The deadlines, in seconds: five times the slowest time measured (a part in memory 1.4 s, a mutant 1.2 s, a part served to the browser 4.3 s, a save 0.1 s), at least two minutes, and for a part served to the browser at least a minute past its longest step (TIMEOUT, 90 s for a click or a wait of the page), so that a step that does not end fails by its own timeout, named, before the deadline runs out. A part in memory (a group, the page, the panel, a mutant, each in a process of its own) loads the modules and runs its checks; a part served to the browser reads the page once; a save is read through SQL; the setup of a worker of the browser starts and warms the page server, the one cold start of the run.
const DEADLINES = { part: 120, mutant: 120, browser: 150, save: 120, setup: 900 }
const MUTATIONS_HEADING = '\nMutations: each must fail by a value the checks it names, and each benign rewrite of the browser case none'

// The parts, in the order they print: those in memory each in a process of its own, as they ran before the runner; those served to the browser (the page as it is, its faults and its rewrites) one after another in a worker that starts one page server and one Chromium for them (the pool `browser`).
const variantsOf = (options) => [
  { key: 'groups', name: 'the mission brief: units, evaluation, ranking, presets, alternatives and the record', head: true, heading: 'The mission brief: units, evaluation, ranking, presets, alternatives and the record', deadline: DEADLINES.part, run: () => runPart('groups', options) },
  { key: 'page', name: 'the propulsion page', head: true, heading: '\nThe propulsion page (its script on a pseudo instance, scripts/lib/page-loader.js)', deadline: DEADLINES.part, run: () => runPart('page', options) },
  { key: 'panel', name: 'the panel', head: true, heading: '\nThe panel (its script, template and Vue, without a document)', deadline: DEADLINES.part, run: () => runPart('panel', options) },
  { key: 'browser', name: 'the browser', head: true, heading: '\nThe browser (the page and the panel over a copy of AuroraDB.db, in Chromium)', pool: 'browser', deadline: DEADLINES.browser, run: () => runPart('browser', options) },
  ...(options.mutations ? MUTANTS.map((mutant) => ({ key: mutant.id, name: `${mutant.kind} ${mutant.kind === 'browser-benign' ? 'rewrite' : 'mutation'}: ${mutant.name}`, heading: MUTATIONS_HEADING, pool: mutant.kind.startsWith('browser') ? 'browser' : null, deadline: mutant.kind.startsWith('browser') ? DEADLINES.browser : DEADLINES.mutant, run: () => runPart(mutant.id, options) })) : []),
  ...SAVE_LABELS.map((label) => ({ key: label, name: `the ${label} save`, head: true, deadline: DEADLINES.save, run: () => runPart(label, options) })),
]

const run = async () => {
  const options = parseArguments(runnerArgs().rest)
  const totals = await runSuite({
    script: __filename,
    inputs: [options.modded[0], options.stock[0]],
    variants: variantsOf(options),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      if (queue.some((variant) => variant.pool === 'browser')) {
        await openBrowser()
      }
    },
    afterEach: async () => {
      if (BROWSER.server) {
        await BROWSER.server.reset()
      }
    },
    close: closeBrowser,
    control: options.mutations ? { fault: 'browser:0', head: 'browser', heading: '\nThe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
