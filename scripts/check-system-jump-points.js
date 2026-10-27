/*
  Checks the jump points of the System view (src/renderer/utilities/system-jump-points.js and the way components/SystemView.vue draws them) against the save in SQL written here, in a browser.

  Run: bun scripts/check-system-jump-points.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The fixture is a copy of a save (artifacts/falryx-sequential-and-rollback, the race Concord of game 141) in which the point 59944 of the system 21771 is charted but not explored by the race, the point 59943 beside it is a gate of strength 500 and the point 59944 has no gate. The save itself holds the case the item names: the race Ancients (789) has charted the points 59943 and 59944 of that system without exploring either, and knows the system beyond 59944 by the name Warrior Knight. Every expected figure is read from the save with SQL written here and joined here, never from the module.
  - module: the rows of the system are the points the race has charted there in a system it knows, one each and no other; each row has the fields the race may see and no other (never the link, the builder of the gate or the flags); a point that is not explored has no far system and no far name, an explored one has the system beyond and its name as the race knows it; the label of an unexplored point is the word of the module's own table, whatever its row carries; a gate is a strength above 0; the same on the small save written here for the cases the saves do not hold (a far system the race does not know, a gate of strength 500 and 999, a point charted by another race only, a point of another game, a point in a system the race does not know);
  - page: the System view of the system, opened on the map, draws a label for each charted point of the system that is the oracle's (the word for the far side of the unexplored point 59944, never the name of the system beyond it), reads only the fields the race may see, and draws the gate outline on the points whose strength is above 0 and on no other.
  Every planted fault is served in place of the module's or the component's file (or run on the module's text) and each must fail the checks it names by a value; the rewrites must leave every check passing and the labels as they were. Table wording is human-reviewed prose: the check reads the words back through the module's own table (FAR_SIDE_TEXT of jump-infrastructure.js) and never spells them. The labels and outlines are read from the scene the component builds (its annotation registry, in the order of its points); the canvas itself is not read, which this check records as its limit.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. It needs Playwright's Chromium (`bunx playwright install chromium` once). Every head and variant runs through scripts/lib/suite-runner.js in a worker that copies the save, starts one page server and one browser and warms them first.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { runSuite } = require('./lib/suite-runner')
const { observe, validate, failureLine, describe, HarnessError, installScreen } = require('./lib/browser-observe')
const { caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const SAVE = 'artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db'
const GAME = 141
const NAMES = { game: 'Orphean Concord', race: 'Concord' }
const RACE = { player: 791, ancients: 789 }
const SYSTEM = 21771
const POINT = { hidden: 59944, gated: 59943 }
const TIMEOUT = 120000
const STEP = 45000
const MODULE = 'src/renderer/utilities/system-jump-points.js'
const WORDS = 'src/renderer/utilities/jump-infrastructure.js'
const VIEW = 'src/renderer/components/SystemView.vue'
const DETAIL = process.argv.includes('--detail')

// What the race may see of a point: the position, the gate strength, whether it is explored, and the system beyond with its name once it is explored.
const FIELDS = ['DestinationID', 'DestinationName', 'Explored', 'JumpGateStrength', 'SystemID', 'WarpPointID', 'Xcor', 'Ycor']

// The cases the save does not hold, written into the copy: the point the race has charted without exploring (its far system is known to the race), a gate of strength 500 and a point with no gate.
const STATEMENTS = [
  `update FCT_RaceJumpPointSurvey set Explored = 0 where GameID = ${GAME} and RaceID = ${RACE.player} and WarpPointID = ${POINT.hidden}`,
  `update FCT_JumpPoint set JumpGateStrength = 500 where GameID = ${GAME} and WarpPointID = ${POINT.gated}`,
  `update FCT_JumpPoint set JumpGateStrength = 0 where GameID = ${GAME} and WarpPointID = ${POINT.hidden}`,
]

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---------- the save, in SQL written here ----------

const open = (file, mode = sqlite3.OPEN_READONLY) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(raw)))
})
const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
const run = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
const close = (raw) => new Promise((resolve) => raw.close(resolve))
const adapter = (raw) => ({ query: async (sql) => [await all(raw, sql)] })

// A copy of the save in a folder of its own, with the cases of STATEMENTS written into it.
const saveCopy = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-system-jump-points-'))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await open(file, sqlite3.OPEN_READWRITE)

  try {
    for (const statement of STATEMENTS) {
      await run(raw, statement)
    }
  } finally {
    await close(raw)
  }

  return { folder, file }
}

// What the save says of the points of `system` for a race, joined here: { systemName, rows: Map(WarpPointID -> { id, strength, explored, farSystem (the system beyond, for an explored point whose system the race knows), farName (its name there), hidden (the name of the system beyond whether or not the point is explored, as the race knows it) }) }. A point counts when the race has charted it in a system it knows.
const truthOf = async (file, { GameID, RaceID }, system) => {
  const raw = await open(file)

  try {
    const points = await all(raw, `select WarpPointID, SystemID, WPLink, JumpGateStrength from FCT_JumpPoint where GameID = ${GameID}`)
    const survey = await all(raw, `select WarpPointID, Charted, Explored from FCT_RaceJumpPointSurvey where GameID = ${GameID} and RaceID = ${RaceID}`)
    const systems = await all(raw, `select SystemID, Name from FCT_RaceSysSurvey where GameID = ${GameID} and RaceID = ${RaceID}`)
    const pointById = new Map(points.map((point) => [point.WarpPointID, point]))
    const surveyById = new Map(survey.map((row) => [row.WarpPointID, row]))
    const nameOf = new Map(systems.map((row) => [row.SystemID, row.Name]))
    const rows = new Map()

    points.filter((point) => point.SystemID === system && nameOf.has(system) && surveyById.has(point.WarpPointID) && surveyById.get(point.WarpPointID).Charted === 1).forEach((point) => {
      const explored = surveyById.get(point.WarpPointID).Explored === 1
      const far = pointById.get(point.WPLink)
      const known = Boolean(far) && nameOf.has(far.SystemID)

      rows.set(point.WarpPointID, {
        id: point.WarpPointID,
        strength: point.JumpGateStrength,
        explored,
        farSystem: explored && known ? far.SystemID : null,
        farName: explored && known ? nameOf.get(far.SystemID) : null,
        hidden: known ? nameOf.get(far.SystemID) : null,
      })
    })

    return { systemName: nameOf.get(system), rows }
  } finally {
    await close(raw)
  }
}

// The small save written here: game 1, race 2 (race 3 charts some of the same points, game 2 holds one more of the same system).
const SMALL = [
  'create table FCT_JumpPoint (WarpPointID integer, GameID integer, SystemID integer, Xcor real, Ycor real, Distance real, WPLink integer, JumpGateStrength integer, JumpGateRaceID integer)',
  'insert into FCT_JumpPoint values (1, 1, 10, 100, 100, 1, 2, 1000, 2), (2, 1, 11, 5, 5, 1, 1, 0, 0), (3, 1, 10, 200, 200, 2, 4, 500, 3), (4, 1, 12, 6, 6, 1, 3, 0, 0), (5, 1, 10, 300, 300, 3, 6, 999, 3), (6, 1, 13, 7, 7, 1, 5, 0, 0), (7, 1, 10, 400, 400, 4, 8, 0, 0), (8, 1, 14, 8, 8, 1, 7, 1000, 2), (9, 1, 10, 500, 500, 5, 2, 1000, 3), (10, 2, 10, 600, 600, 1, 12, 1000, 2), (11, 1, 10, 700, 700, 6, NULL, NULL, 0), (12, 2, 11, 9, 9, 1, 10, 0, 0)',
  'create table FCT_RaceJumpPointSurvey (WarpPointID integer, GameID integer, RaceID integer, Charted integer, Explored integer)',
  'insert into FCT_RaceJumpPointSurvey values (1, 1, 2, 1, 1), (2, 1, 2, 1, 1), (3, 1, 2, 1, 0), (4, 1, 2, 1, 0), (5, 1, 2, 1, 1), (6, 1, 2, 1, 0), (7, 1, 2, 0, 0), (8, 1, 2, 1, 0), (11, 1, 2, 1, 0), (1, 1, 3, 1, 1), (3, 1, 3, 1, 1), (9, 1, 3, 1, 1), (10, 2, 2, 1, 1)',
  'create table FCT_RaceSysSurvey (SystemID integer, GameID integer, RaceID integer, Name text)',
  "insert into FCT_RaceSysSurvey values (10, 1, 2, 'Home'), (11, 1, 2, 'Alpha'), (12, 1, 2, 'Bravo'), (10, 1, 3, 'HomeX'), (11, 1, 3, 'AlphaX'), (13, 1, 3, 'Charlie'), (10, 2, 2, 'Home2'), (11, 2, 2, 'Alpha2')",
]

// What each read of the small save must give, written by hand: a row for each point, with the far system and name the race knows and the strength. `null` for what the race cannot know.
const SMALL_READS = [
  { key: 'home', ids: { GameID: 1, RaceID: 2 }, system: 10, rows: { 1: { far: 11, name: 'Alpha', strength: 1000, explored: true }, 3: { far: null, name: null, strength: 500, explored: false }, 5: { far: null, name: null, strength: 999, explored: true }, 11: { far: null, name: null, strength: null, explored: false } } },
  { key: 'other-race', ids: { GameID: 1, RaceID: 3 }, system: 10, rows: { 1: { far: 11, name: 'AlphaX', strength: 1000, explored: true }, 3: { far: null, name: null, strength: 500, explored: true }, 9: { far: 11, name: 'AlphaX', strength: 1000, explored: true } } },
  { key: 'other-game', ids: { GameID: 2, RaceID: 2 }, system: 10, rows: { 10: { far: 11, name: 'Alpha2', strength: 1000, explored: true } } },
  { key: 'unknown-system', ids: { GameID: 1, RaceID: 2 }, system: 14, rows: {} },
  { key: 'not-charted-system', ids: { GameID: 1, RaceID: 2 }, system: 13, rows: {} },
]

// ---------- the module ----------

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const loadModules = async (changes = {}) => {
  const sources = {}

  for (const [file, change] of Object.entries(changes)) {
    sources[path.basename(file, '.js')] = change(source(file))
  }

  const { 'system-jump-points': points, 'jump-infrastructure': infrastructure } = await loadUtilities(['system-jump-points', 'jump-infrastructure'], { sources })

  return { points, infrastructure }
}

// The words of the module's own table for a far side the race cannot name, read once from the module.
const wordsOf = ({ infrastructure }) => ({ unexplored: infrastructure.FAR_SIDE_TEXT.unexplored, uncharted: infrastructure.FAR_SIDE_TEXT.uncharted })

// The label the oracle expects of a point: the far system's name for an explored point whose system the race knows, else the word of the table for it.
const labelOf = (row, words) => (row.explored ? (row.farName !== null ? row.farName : words.uncharted) : words.unexplored)

// The synthetic rows given to the module's reader of a row: a name on an unexplored row, a padded name, an explored row with no system known, and the strengths around the boundary of a gate.
const SYNTHETIC = [
  { Explored: 0, DestinationName: 'Far', DestinationID: 5, JumpGateStrength: 1000 },
  { Explored: 1, DestinationName: ' Far ', DestinationID: 5, JumpGateStrength: 0 },
  { Explored: 1, DestinationName: null, DestinationID: null, JumpGateStrength: null },
  { Explored: 0, DestinationName: null, DestinationID: null, JumpGateStrength: 1 },
  { Explored: 0, DestinationName: null, DestinationID: null, JumpGateStrength: 999 },
  { Explored: 0, DestinationName: null, DestinationID: null, JumpGateStrength: -1 },
]

// The modules' answers on the saves and on the small save: { item (race Ancients on the save as it is), own (race Concord on the copy), small: { [key]: rows }, synthetic }.
const observeModule = async (changes) => {
  const { points } = await loadModules(changes)
  const original = await open(path.join(root, SAVE))
  const copy = await open(ENV.copy.file)
  const small = await open(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)

  try {
    for (const statement of SMALL) {
      await run(small, statement)
    }

    const read = async (raw, ids, system) => {
      const rows = await points.loadSystemJumpPoints(adapter(raw), { ...ids, SystemID: system })

      return { rows, looks: rows.map((row) => points.jumpPointLook(row)) }
    }
    const smallReads = {}

    for (const entry of SMALL_READS) {
      smallReads[entry.key] = await read(small, entry.ids, entry.system)
    }

    return {
      item: await read(original, { GameID: GAME, RaceID: RACE.ancients }, SYSTEM),
      own: await read(copy, { GameID: GAME, RaceID: RACE.player }, SYSTEM),
      small: smallReads,
      synthetic: SYNTHETIC.map((row) => points.jumpPointLook(row)),
    }
  } finally {
    await close(original)
    await close(copy)
    await close(small)
  }
}

const idsOf = (rows) => rows.map((row) => Number(row.WarpPointID)).sort((a, b) => a - b)

const lookOf = (read, id) => {
  const index = read.rows.findIndex((row) => Number(row.WarpPointID) === id)

  return index < 0 ? null : { row: read.rows[index], look: read.looks[index] }
}

// The reads of the saves with the oracle's rows beside them: [name, read, truth rows].
const sets = (o, t) => [['item', o.item, t.item.rows], ['own', o.own, t.own.rows]]

// The rows a read gave against the oracle's by the identity of the point: [] when each point of the oracle has exactly one row and no row is of another point.
const rowProblems = (read, rows) => {
  const ids = idsOf(read.rows)
  const wanted = [...rows.keys()].sort((a, b) => a - b)

  return JSON.stringify(ids) === JSON.stringify(wanted) ? [] : [{ ids, wanted }]
}

const smallProblems = (read, entry) => {
  const wanted = Object.keys(entry.rows).map(Number).sort((a, b) => a - b)

  return JSON.stringify(idsOf(read.rows)) === JSON.stringify(wanted) ? [] : [{ key: entry.key, ids: idsOf(read.rows), wanted }]
}

const MODULE_CHECKS = [
  ['m-point', 'the point 59944 of the system 21771 the race Ancients has charted without exploring has no far system and no far name in its row, though the save knows the system beyond it by name, and its label is the word of the module\'s table for a far side not explored', (o, t) => {
    const found = lookOf(o.item, POINT.hidden)
    const want = t.item.rows.get(POINT.hidden)

    if (!want || want.explored || want.hidden === null) {
      throw new HarnessError('the save no longer holds the point 59944 charted, unexplored and with a far system the race knows')
    }

    return (found !== null && Number(found.row.Explored) === 0 && found.row.DestinationName === null && found.row.DestinationID === null && found.look.label === ENV.words.unexplored && !JSON.stringify(o.item).includes(want.hidden)) || short({ found, hidden: want.hidden })
  }],
  ['m-rows', 'the rows of a system are the points the race has charted there in a system it knows, one each, and a point it has not charted, one charted by another race, one of another game or one in a system it does not know has none', (o, t) => {
    const problems = [...sets(o, t).flatMap(([name, read, rows]) => rowProblems(read, rows).map((problem) => ({ name, ...problem }))), ...SMALL_READS.flatMap((entry) => smallProblems(o.small[entry.key], entry))]

    return (problems.length === 0 && t.item.rows.size >= 2 && t.own.rows.size >= 2) || short(problems.slice(0, 3))
  }],
  ['m-fields', 'each row holds the fields the race may see and no other: never the link, the builder of the gate or the flags', (o) => {
    const reads = [o.item, o.own, ...Object.values(o.small)]
    const wrong = reads.flatMap((read) => read.rows).filter((row) => JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(FIELDS)).map((row) => Object.keys(row).sort())

    return (wrong.length === 0 && reads.some((read) => read.rows.length > 0)) || short(wrong.slice(0, 2))
  }],
  ['m-far', 'the far system and its name are the oracle\'s for each row: given for an explored point whose system the race knows, null for one that is not explored and for an explored one whose system the race does not know', (o, t) => {
    const wrong = sets(o, t).flatMap(([name, read, rows]) => [...rows.values()].map((want) => {
      const found = lookOf(read, want.id)

      return found !== null && (found.row.DestinationID ?? null) === want.farSystem && (found.row.DestinationName ?? null) === want.farName ? null : [name, want.id, found && found.row.DestinationID, want.farSystem, found && found.row.DestinationName, want.farName]
    }).filter(Boolean))
    const small = SMALL_READS.flatMap((entry) => Object.entries(entry.rows).map(([id, want]) => {
      const found = lookOf(o.small[entry.key], Number(id))

      return found !== null && (found.row.DestinationID ?? null) === want.far && (found.row.DestinationName ?? null) === want.name ? null : [entry.key, id, found && found.row.DestinationID, want.far, found && found.row.DestinationName, want.name]
    }).filter(Boolean))
    const named = [...t.own.rows.values()].some((row) => row.farName !== null)

    return (wrong.length === 0 && small.length === 0 && named) || short({ wrong: wrong.slice(0, 2), small: small.slice(0, 2), named })
  }],
  ['m-look', 'the label of each row is the oracle\'s: the far system\'s name for an explored point the race knows the system beyond, the word of the module\'s table for the far side otherwise, and never a name on an unexplored point, whatever the row carries; the destination is offered only for an explored point', (o, t) => {
    const { unexplored, uncharted } = ENV.words
    const wrong = sets(o, t).flatMap(([name, read, rows]) => [...rows.values()].map((want) => {
      const found = lookOf(read, want.id)

      return found !== null && found.look.label === labelOf(want, ENV.words) && found.look.destinationId === want.farSystem ? null : [name, want.id, found && found.look, labelOf(want, ENV.words)]
    }).filter(Boolean))
    const synthetic = o.synthetic.map((look) => [look.label, look.destinationId])
    const wantSynthetic = [[unexplored, null], ['Far', 5], [uncharted, null], [unexplored, null], [unexplored, null], [unexplored, null]]

    return (wrong.length === 0 && JSON.stringify(synthetic) === JSON.stringify(wantSynthetic) && unexplored !== uncharted) || short({ wrong: wrong.slice(0, 2), synthetic })
  }],
  ['m-gate', 'a point is a gate when its strength is above 0, in the saves and for the strengths 1, 500, 999 and 1000 and for none recorded', (o, t) => {
    const wrong = sets(o, t).flatMap(([name, read, rows]) => [...rows.values()].map((want) => {
      const found = lookOf(read, want.id)

      return found !== null && found.look.gate === (want.strength > 0) ? null : [name, want.id, found && found.look.gate, want.strength]
    }).filter(Boolean))
    const small = SMALL_READS.flatMap((entry) => Object.entries(entry.rows).map(([id, want]) => {
      const found = lookOf(o.small[entry.key], Number(id))

      return found !== null && found.look.gate === (want.strength !== null && want.strength > 0) ? null : [entry.key, id, found && found.look.gate, want.strength]
    }).filter(Boolean))
    const synthetic = o.synthetic.map((look) => look.gate)
    const gated = [...t.own.rows.values()].filter((row) => row.strength > 0 && row.strength < 1000).length

    return (wrong.length === 0 && small.length === 0 && JSON.stringify(synthetic) === JSON.stringify([true, false, false, true, true, false]) && gated >= 1) || short({ wrong: wrong.slice(0, 2), small: small.slice(0, 2), synthetic })
  }],
]

// ---------- the page ----------

// What the page shows; runs in the page. The System view's scene as its component built it: the title, and for each point the component loaded, the text of the label and whether the gate outline is part of the marker.
const readScene = () => {
  const { visible, visibleText } = window.__screen
  const title = document.querySelector('[data-system-name]')
  const view = document.querySelector('.system-view')
  const vm = view ? view.__vue__ : null

  if (!vm || !vm.elements || !Array.isArray(vm.elements.jumpPoints) || !vm._annotationRegistry) {
    return { title: title ? { on: visible(title), text: visibleText(title) } : null, points: null }
  }

  const entries = vm._annotationRegistry.filter((entry) => entry.bodyTypeId === 550)
  const outline = vm._getShapeTexture('squareOutline')

  return {
    title: title ? { on: visible(title), text: visibleText(title) } : null,
    drawn: entries.length,
    points: vm.elements.jumpPoints.map((point, index) => ({ id: Number(point.WarpPointID), keys: Object.keys(point).sort(), label: entries[index] ? entries[index].label.text : null, gate: entries[index] ? entries[index].marker.children.some((child) => child.texture === outline) : null })),
  }
}

const openApp = async (page, url, step) => {
  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })
  await installScreen(page)

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
}

// The System view of the system as a player opens it: the map on the system, then the button of its side panel.
const observePage = (browser, url) => observe(browser, async ({ page, step }) => {
  await openApp(page, url, step)

  step('opening the map on the system')
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), `/map?system=${SYSTEM}`)
  await page.waitForFunction(() => window.$app.$route.path === '/map', null, { timeout: TIMEOUT })
  await page.waitForFunction(() => { const view = window.$app.$route.matched[0].instances.default; return Boolean(view && view.ready) }, null, { timeout: TIMEOUT })
  await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT })

  step('opening the System view')
  await page.getByRole('button', { name: 'System view', exact: true }).first().click({ timeout: STEP })

  step('waiting for the scene of the System view')
  await page.waitForFunction(() => {
    const view = document.querySelector('.system-view')
    const vm = view ? view.__vue__ : null

    return Boolean(vm && vm.elements && Array.isArray(vm.elements.jumpPoints) && vm.elements.jumpPoints.length > 0 && vm._annotationRegistry && vm._annotationRegistry.filter((entry) => entry.bodyTypeId === 550).length === vm.elements.jumpPoints.length)
  }, null, { timeout: TIMEOUT })

  return page.evaluate(readScene)
})

const pointOf = (scene, id) => (scene.points || []).find((point) => point.id === id) || null

const PAGE_CHECKS = [
  ['p-title', 'the System view is the one of the system asked for', (o, t) => (o.title !== null && o.title.on && o.title.text === t.page.systemName) || short({ title: o.title, wanted: t.page.systemName })],
  ['p-rows', 'the view draws a point for each point the race has charted in the system and for no other', (o, t) => {
    const ids = (o.points || []).map((point) => point.id).sort((a, b) => a - b)
    const wanted = [...t.page.rows.keys()].sort((a, b) => a - b)

    return (JSON.stringify(ids) === JSON.stringify(wanted) && o.drawn === wanted.length && wanted.length >= 2) || short({ ids, wanted, drawn: o.drawn })
  }],
  ['p-fields', 'the view reads the fields the race may see of each point and no other', (o) => {
    const wrong = (o.points || []).filter((point) => JSON.stringify(point.keys) !== JSON.stringify(FIELDS)).map((point) => [point.id, point.keys])

    return (wrong.length === 0 && (o.points || []).length > 0) || short(wrong.slice(0, 2))
  }],
  ['p-labels', 'the label of each point is the oracle\'s: the word for the far side of the point 59944, never the name of the system beyond it, and the system beyond by its name for an explored point', (o, t) => {
    const wrong = [...t.page.rows.values()].map((want) => {
      const point = pointOf(o, want.id)

      return point !== null && point.label === labelOf(want, ENV.words) ? null : [want.id, point && point.label, labelOf(want, ENV.words)]
    }).filter(Boolean)
    const hidden = t.page.rows.get(POINT.hidden)
    const leaked = (o.points || []).filter((point) => hidden && hidden.hidden !== null && point.id === hidden.id && point.label === hidden.hidden)

    if (!hidden || hidden.explored || hidden.hidden === null) {
      throw new HarnessError('the copy no longer holds the point 59944 charted, unexplored and with a far system the race knows')
    }

    return (wrong.length === 0 && leaked.length === 0 && [...t.page.rows.values()].some((row) => row.explored && row.farName !== null)) || short({ wrong: wrong.slice(0, 3), leaked })
  }],
  ['p-gate', 'the gate outline is part of the marker of each point whose strength is above 0 and of no other: the gate of strength 500 has one, the point without a gate has none', (o, t) => {
    const wrong = [...t.page.rows.values()].map((want) => {
      const point = pointOf(o, want.id)

      return point !== null && point.gate === (want.strength > 0) ? null : [want.id, point && point.gate, want.strength]
    }).filter(Boolean)
    const strengths = [...t.page.rows.values()].map((row) => row.strength)

    return (wrong.length === 0 && strengths.some((value) => value > 0 && value < 1000) && strengths.includes(0)) || short({ wrong, strengths })
  }],
  ['p-no-errors', 'the page raises no error', (o) => (o.unexpected.length === 0 ? true : short(o.unexpected.slice(0, 3)))],
]

// ---------- the faults and the rewrites ----------

const swap = (from, to, count = 1) => (text) => {
  if (text.split(from).length !== count + 1) {
    throw new Error(`The variant must apply ${count === 1 ? 'exactly once' : `${count} times`} to the file: ${from}`)
  }

  return text.split(from).join(to)
}

/* eslint-disable no-template-curly-in-string */
const FAR_JOIN = 'left join FCT_JumpPoint as FarPoint on FCT_RaceJumpPointSurvey.Explored = 1 and FarPoint'
const LABEL = 'label: explored && name ? name : FAR_SIDE_TEXT[explored ? \'uncharted\' : \'unexplored\'],'

const MODULE_FAULTS = [
  { name: 'the far system of a point that is not explored is read', file: MODULE, change: swap(FAR_JOIN, 'left join FCT_JumpPoint as FarPoint on FarPoint'), fails: ['m-point', 'm-far'] },
  { name: 'the builder of the gate is read', file: MODULE, change: swap('FCT_JumpPoint.JumpGateStrength, FCT_RaceJumpPointSurvey.Explored,', 'FCT_JumpPoint.JumpGateStrength, FCT_JumpPoint.JumpGateRaceID, FCT_RaceJumpPointSurvey.Explored,'), fails: ['m-fields'] },
  { name: 'the link of the point is read', file: MODULE, change: swap('FCT_JumpPoint.JumpGateStrength, FCT_RaceJumpPointSurvey.Explored,', 'FCT_JumpPoint.JumpGateStrength, FCT_JumpPoint.WPLink, FCT_RaceJumpPointSurvey.Explored,'), fails: ['m-fields'] },
  { name: 'the points the race has not charted are read', file: MODULE, change: swap(' and FCT_RaceJumpPointSurvey.Charted = 1', ''), fails: ['m-rows'] },
  { name: 'the points of systems the race does not know are read', file: MODULE, change: swap('inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID', 'left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID'), fails: ['m-rows'] },
  { name: 'the survey of every race is read', file: MODULE, change: swap('FCT_RaceJumpPointSurvey.RaceID = ${RaceID} and', 'FCT_RaceJumpPointSurvey.RaceID > 0 and'), fails: ['m-rows'] },
  { name: 'the points of every game are read', file: MODULE, change: swap('where FCT_JumpPoint.GameID = ${GameID} and ', 'where '), fails: ['m-rows'] },
  { name: 'the far system is the system of the point itself', file: MODULE, change: swap('FarSystem.SystemID = FarPoint.SystemID', 'FarSystem.SystemID = FCT_JumpPoint.SystemID'), fails: ['m-far', 'm-look'] },
  { name: 'a gate is a strength of 1000', file: MODULE, change: swap('gate: point.JumpGateStrength > 0,', 'gate: point.JumpGateStrength >= 1000,'), fails: ['m-gate'] },
  { name: 'a far side the race has explored but does not know is told as not explored', file: MODULE, change: swap(LABEL, 'label: explored && name ? name : FAR_SIDE_TEXT.unexplored,'), fails: ['m-look'] },
  { name: 'a name on an unexplored row is drawn', file: MODULE, change: swap(LABEL, 'label: name || FAR_SIDE_TEXT[explored ? \'uncharted\' : \'unexplored\'],'), fails: ['m-look'] },
  { name: 'the destination of an unexplored point is offered', file: MODULE, change: swap('destinationId: explored && point.DestinationID ? point.DestinationID : null', 'destinationId: point.DestinationID || null'), fails: ['m-look'] },
]

const MODULE_BENIGN = [
  { name: 'the explored test of the module parenthesised', file: MODULE, change: swap('const explored = Number(point.Explored) === 1', 'const explored = (Number(point.Explored) === 1)') },
  { name: 'the conditions of the read in the other order', file: MODULE, change: swap('where FCT_JumpPoint.GameID = ${GameID} and FCT_JumpPoint.SystemID = ${SystemID}`', 'where FCT_JumpPoint.SystemID = ${SystemID} and FCT_JumpPoint.GameID = ${GameID}`') },
  { name: 'the word for a far side not explored in other words', file: WORDS, words: true, change: swap("unexplored: 'Unexplored',", "unexplored: 'Not yet explored',") },
]

const BEFORE = [
  [FAR_JOIN, 'left join FCT_JumpPoint as FarPoint on FarPoint'],
  ['label: explored && name ? name : ', 'label: name || '],
]
const OLD_READ = (text) => BEFORE.reduce((changed, [from, to]) => swap(from, to)(changed), text)

const PAGE_FAULTS = [
  { name: 'the view draws the far name of a point not explored, as it once did', file: MODULE, change: OLD_READ, fails: ['p-labels'] },
  { name: 'the view takes a gate to be a strength of 1000', file: MODULE, change: swap('gate: point.JumpGateStrength > 0,', 'gate: point.JumpGateStrength >= 1000,'), fails: ['p-gate'] },
  { name: 'the view outlines every point as a gate', file: VIEW, change: swap('if (hasGate) {', 'if (true) {'), fails: ['p-gate'] },
  { name: 'the view draws the same word on every point', file: VIEW, change: swap('const labelText = look.label', "const labelText = 'Unexplored'"), fails: ['p-labels'] },
  { name: 'the view reads every column of every point of the system', file: VIEW, change: swap('const jumpPoints = await loadSystemJumpPoints(this.database, { GameID: this.GameID, RaceID: this.RaceID, SystemID: this.$props.systemId }).then((items) => {', 'const jumpPoints = await this.database.query(`select * from FCT_JumpPoint where SystemID = ${this.$props.systemId} and GameID = ${this.GameID}`).then(([items]) => {'), fails: ['p-fields'] },
]

const PAGE_BENIGN = [
  { name: 'the gate of the marker parenthesised', file: VIEW, change: swap('const hasGate = look.gate', 'const hasGate = (look.gate)') },
  { name: 'the word for a far side not explored in other words, read through the module\'s table', file: WORDS, words: true, change: swap("unexplored: 'Unexplored',", "unexplored: 'Not yet explored',") },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the results ----------

// The results of `list` over the observation `o` (and the oracle `t`): { id, name, result, kind }; a check fails by a value (kind 'assertion'); a check that throws stops the run.
const judge = (o, t, list, ids = null) => list.filter(([id]) => !ids || ids.includes(id)).map(([id, name, test]) => {
  let result = null

  try {
    result = test(o, t)
  } catch (error) {
    throw new HarnessError(`the check ${id} threw: ${error && error.message ? error.message : error}`)
  }

  return { id, name, result, kind: result === true ? null : 'assertion' }
})

// The results of the page checks over a record of `observe`: the screen read, or a HarnessError when the record has none and `strict`.
const pageResults = (seen, truth, { ids = null, strict = true, label = 'the observation' } = {}) => {
  validate(seen, label)

  if (unobserved(seen)) {
    if (strict) {
      throw new HarnessError(`${label} did not get through: ${failureLine(seen)}`)
    }

    return PAGE_CHECKS.filter(([id]) => !ids || ids.includes(id)).map(([id, name]) => ({ id, name, result: failureLine(seen), kind: 'unobserved' }))
  }

  return judge({ ...seen.value, unexpected: seen.unexpected }, truth, PAGE_CHECKS, ids)
}

// ---------- the run ----------

let ENV = null
const cleanups = []
let checks = 0
let failures = 0

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const reportFault = (fault, results) => {
  report(`fault caught: ${fault.name}`, caughtAll(results, { name: fault.name }) ? true : notCaught(results), `fails ${fault.fails.join(', ')}`)

  if (DETAIL) {
    results.forEach(({ id, result }) => console.log(`         ${id}: ${result === true ? 'holds' : result}`))
  }
}

const told = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }

  return seen
}

// The page with `fault` made to it (a file replaced in the page server), read as a player uses it.
const view = async (fault) => {
  if (fault) {
    ENV.server.replace(fault.file, fault.change(ENV.original[fault.file]))
  }

  try {
    return told(fault ? 'a variant of the page' : 'the page', await observePage(ENV.chrome, ENV.server.url))
  } finally {
    if (fault) {
      ENV.server.replace(fault.file, null)
    }
  }
}

const moduleView = (fault) => observeModule(fault ? { [fault.file]: fault.change } : {})

const checkHead = async () => {
  const o = await observeModule({})

  judge(o, ENV.truth, MODULE_CHECKS).forEach(({ name, result }) => report(name, result))

  const control = judge(o, ENV.truth, [['planted', 'a check that fails by its own value', () => 'what was seen']])

  report('control: a check that fails by its own verdict credits a fault named for it, and one that holds does not', caughtAll(control) && !caughtAll(judge(o, ENV.truth, [['holds', 'a check that holds', () => true]])) ? true : 'the credit of a fault does not follow the verdict')

  pageResults(await view(null), ENV.truth, { strict: false, label: 'the page' }).forEach(({ name, result }) => report(name, result))
}

const checkModuleFault = async (fault) => {
  reportFault(fault, judge(await moduleView(fault), ENV.truth, MODULE_CHECKS, fault.fails))
}

const checkModuleBenign = async (rewrite) => {
  const words = ENV.words

  ENV.words = rewrite.words ? wordsOf(await loadModules({ [rewrite.file]: rewrite.change })) : words

  try {
    const wrong = judge(await moduleView(rewrite), ENV.truth, MODULE_CHECKS).filter(({ result }) => result !== true).map(({ id }) => id)

    report(`variant passes: ${rewrite.name}`, wrong.length === 0 ? true : `fails ${wrong.join(', ')}`)
  } finally {
    ENV.words = words
  }
}

const checkFault = async (fault) => {
  reportFault(fault, pageResults(await view(fault), ENV.truth, { ids: fault.fails, label: `the page with the fault "${fault.name}"` }))
}

const checkBenign = async (rewrite) => {
  if (unobserved(ENV.baseline)) {
    throw new HarnessError(`the page as it is was not observed, so the rewrite has no screen to be set against: ${failureLine(ENV.baseline)}`)
  }

  const words = ENV.words

  ENV.words = rewrite.words ? wordsOf(await loadModules({ [rewrite.file]: rewrite.change })) : words

  let seen
  let wrong

  try {
    seen = await view(rewrite)
    wrong = pageResults(seen, ENV.truth, { label: `the page rewritten as "${rewrite.name}"` }).filter(({ result }) => result !== true).map(({ id }) => id)
  } finally {
    ENV.words = words
  }

  const shape = (value) => JSON.stringify(value.points.map((point) => [point.id, point.gate]))

  report(`variant passes: ${rewrite.name}`, wrong.length === 0 && shape(seen.value) === shape(ENV.baseline.value) ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the scene it draws is not the page\'s')
}

// What a worker sets up once before its first variant: the copy of the save with the cases written into it, the oracle's reading of the save and of the copy, the words of the module's table, the texts of the files a variant may change, and one page server over the copy, warmed, with one Chromium.
const setUp = async () => {
  const { startPageServer } = require('./lib/page-server')
  const copy = await saveCopy()

  cleanups.push(async () => fs.rmSync(copy.folder, { recursive: true, force: true }))

  const item = await truthOf(path.join(root, SAVE), { GameID: GAME, RaceID: RACE.ancients }, SYSTEM)
  const own = await truthOf(copy.file, { GameID: GAME, RaceID: RACE.player }, SYSTEM)

  assert.ok(item.rows.has(POINT.hidden) && own.rows.has(POINT.hidden), 'the saves hold the point 59944 charted by the races')

  const env = { copy, truth: { item, own, page: own }, words: wordsOf(await loadModules()), original: {}, baseline: null }

  for (const file of [MODULE, WORDS, VIEW]) {
    env.original[file] = source(file)
  }

  env.server = await startPageServer({ save: copy.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/map'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// The deadlines, in seconds.
const DEADLINES = { head: 300, module: 120, view: 240, setup: 900 + 180 }
const CONTROL_FAULT = 'the view takes a gate to be a strength of 1000'

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the module and the System view as they are', head: true, heading: 'The jump points of the System view (scripts/lib/page-server.js over a copy of a save)', pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(mutating ? MODULE_FAULTS.map((fault, index) => ({ key: `module-fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the module', pool: 'suite', deadline: DEADLINES.module, run: () => checkModuleFault(fault) })) : []),
  ...(mutating ? MODULE_BENIGN.map((rewrite, index) => ({ key: `module-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nrewrites of the module that say the same thing', pool: 'suite', deadline: DEADLINES.module, run: () => checkModuleBenign(rewrite) })) : []),
  ...(mutating ? PAGE_FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the view', pool: 'suite', deadline: DEADLINES.view, run: () => checkFault(fault) })) : []),
  ...(mutating ? PAGE_BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: '\nvariants of the view that say the same thing', pool: 'suite', deadline: DEADLINES.view, baseline: true, run: () => checkBenign(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      ENV = await setUp()

      if (queue.some((variant) => variant.baseline)) {
        ENV.baseline = await view(null)
      }
    },
    afterEach: async () => {
      if (ENV && ENV.server) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      const problems = []

      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch((error) => problems.push(String(error && error.message ? error.message : error).split('\n')[0]))
      }

      if (problems.length) {
        throw new Error(`cleanups failed: ${problems.join(' | ')}`)
      }
    },
    control: mutating ? { fault: `fault:${PAGE_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'head', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
