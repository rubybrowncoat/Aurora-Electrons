/*
  Checks the thermal and EM signatures, the cross-section and the passive and active reach of a ship class (utilities/signatures.js, the rules behind it in utilities/design-rules.js and the loaders of utilities/design-data.js).

  bun scripts/check-signatures.js [--no-mutations]

  Groups (each check's name begins with its group):
  - thermal: a moving class shows power × thermal rating × the share of top speed, never under a twentieth of its size; idle shows that floor, a low share clamps to it, a class with no engine shows 0 moving; the speed shares typed as percentages read to sorted fractions with idle and full speed always present, and an unreadable text is an error;
  - range: four times the sensitivity doubles the passive range, a signature of 0 gives a range of 0, an unknown signature or sensitivity stays unavailable and never 0, a reach lends the provenance of its figures, and the curves hold the same points as their tables;
  - mixed: engines of several designs make the power-weighted sum and never the mean of their ratings, and are estimated; a class of one design equals its stored thermal signature;
  - cross-section: the effective and the uncloaked cross-section stay distinct for a cloaked class, the floor of 0.3 HS, the cloak that covers the class, the last such cloak, and the active reach with the floor and the square of the cross-section over the resolution;
  - reduction: the engines rebuilt at each researched thermal reduction level, the cost factor read from the tech row;
  - em: shields × 30, an active sensor max(1, trunc(strength) × trunc(resolution)), each sensor on its own and never summed, 0 and not unknown for no shields or no active sensor;
  - saves: ClassThermal, ClassCrossSection and SensorReduction rebuilt for every class of every save in saves/ from the loader and the rules (read-only), with the two modded classes whose stored thermal signature the rule does not reproduce pinned; a save that is not there is reported as skipped, never as passed.

  Mutations: each deliberate fault planted in the source of a module (the module is loaded from its text, scripts/lib/utilities.js, with a registry of provenance rules of its own, so no fault reaches another) runs the checks it names and must fail them. Prints `N of N checks passed`; exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const savesDirectory = path.join(root, 'saves')
const MODULES = ['signatures', 'design-data', 'design-rules', 'provenance', 'capabilities', 'capability-reads']

// ---------- the modules, as they ship or with one fault planted ----------

const texts = new Map()
let planted = 0

// The modules from their source; with a `mutation` { file, find, replace } the fault is planted in that file (`find` must occur once) and the provenance module is loaded from a text of its own, so the fault's copy of every module registers its rules in a registry that no other load shares.
const loadAll = async (mutation = null) => {
  const sources = {}

  if (mutation) {
    sources[mutation.file.replace(/\.js$/, '')] = patched(mutation.file, fs.readFileSync(path.join(utilitiesDirectory, mutation.file), 'utf8'), mutation.find, mutation.replace)
    sources.provenance = `${fs.readFileSync(path.join(utilitiesDirectory, 'provenance.js'), 'utf8')}\n// planted fault ${++planted}\n`
  }

  const loaded = await loadUtilities(MODULES, { sources, texts })

  return { sig: loaded.signatures, dd: loaded['design-data'], dr: loaded['design-rules'], pv: loaded.provenance, cap: loaded.capabilities }
}

// ---------- fixtures ----------

const engine = (over = {}) => ({ id: 1, name: 'Engine A', power: 100, thermalRating: 0.5, thrust: 1, sizeHS: 10, count: 1, techIds: { engine: 10, fuel: 11, thermal: 13 }, ...over })

// A class of 40 HS whose two engines of 100 EP at a thermal rating of 0.5 make a signature of 100 at full power.
const klass = (over = {}) => ({ id: 1, name: 'Test', sizeHS: 40, obsolete: false, commercial: false, stored: { crossSection: 40, sensorReduction: 1, thermal: 100, enginePower: 200, speed: 5000, shieldStrength: 0 }, engines: [engine({ count: 2 })], cloaks: [], activeSensors: [], thermalSensors: [], emSensors: [], ...over })

const stored = (over) => ({ crossSection: 40, sensorReduction: 1, thermal: 100, enginePower: 200, speed: 5000, shieldStrength: 0, ...over })

const cloak = (maxShipHS, rating, id = 50) => ({ id, name: `Cloak ${id}`, maxShipHS, rating, count: 1 })

const close = (actual, expected, message, tolerance = 1e-9) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} is not ${expected}`)

const unknown = (result, message) => {
  assert.equal(result.status, 'unavailable', message)
  assert.equal(result.value, null, message)
  assert.ok(result.inputs.missing.length > 0, `${message}: the result names no missing input`)
}

const thermalOf = (m, cls, fractions) => m.sig.classSignatures(cls, { fractions }).thermal.byFraction.map(({ result }) => result.value)

const sizes = (m, cls) => {
  const { crossSection } = m.sig.classSignatures(cls)

  return { effective: crossSection.effective.value, uncloaked: crossSection.uncloaked.value, cloaked: crossSection.cloaked }
}

// ---------- the saves ----------

// The saves of saves/ the checks read, each { file, database }, opened by `run`.
const SAVES = []

const skipped = (reason) => ({ skipped: reason })

// The app's database object, `query(sql, { replacements })` giving `[rows]`, over a sqlite3 handle.
const appDatabase = (raw) => ({
  query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
    const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
    const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

    raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
  }),
})

const openSave = (file) => new Promise((resolve, reject) => {
  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(path.join(savesDirectory, file), sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ file, database: appDatabase(raw), close: () => raw.close() })
  })
})

const openSaves = async () => {
  const files = fs.existsSync(savesDirectory) ? fs.readdirSync(savesDirectory).filter((name) => name.endsWith('.db')).sort() : []

  for (const file of files) {
    SAVES.push(await openSave(file))
  }
}

// The two modded classes of one save whose stored thermal signature is 12.5 times what the rule gives.
const PINNED = Object.freeze([
  { file: 'AuroraDB_270_unknown.db', game: 140, race: 784, classId: 62932, name: 'Owl', field: 'ClassThermal', stored: 15000, computed: 1200 },
  { file: 'AuroraDB_270_unknown.db', game: 140, race: 784, classId: 62946, name: 'Akita', field: 'ClassThermal', stored: 30000, computed: 2400 },
])

const racesOf = async (save) => {
  const [rows] = await save.database.query('select distinct GameID, RaceID from FCT_ShipClass order by GameID, RaceID')

  return rows
}

const sameFigure = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

// Every class of a save rebuilt from the loader and the rules and set beside what the save stores: the tallies and the mismatches of the three figures.
const reconcileSave = async (m, save) => {
  const tally = { races: 0, classes: 0, withEngines: 0, cloaked: 0, several: 0 }
  const mismatches = []

  for (const { GameID, RaceID } of await racesOf(save)) {
    const classes = await m.dd.loadSignatureClasses(save.database, { GameID, RaceID })
    const [[counted]] = await save.database.query('select count(*) as n from FCT_ShipClass where GameID = :GameID and RaceID = :RaceID', { replacements: { GameID, RaceID } }).then(([rows]) => [rows])

    assert.equal(classes.length, counted.n, `${save.file} game ${GameID} race ${RaceID}: the classes loaded are those of the race`)
    tally.races++

    for (const cls of classes) {
      const reduction = m.dr.cloakReduction({ sizeHS: cls.sizeHS, cloaks: cls.cloaks })
      const computed = { ClassThermal: m.dr.classThermal({ engines: cls.engines }), ClassCrossSection: m.dr.classCrossSection({ sizeHS: cls.sizeHS, sensorReduction: reduction }), SensorReduction: reduction }
      const storedFigures = { ClassThermal: cls.stored.thermal, ClassCrossSection: cls.stored.crossSection, SensorReduction: cls.stored.sensorReduction }
      const signatures = m.sig.classSignatures(cls)
      const agreed = { ClassThermal: signatures.thermal.agrees, ClassCrossSection: signatures.crossSection.agrees, SensorReduction: signatures.crossSection.reduction.agrees }

      tally.classes++
      tally.withEngines += cls.engines.length ? 1 : 0
      tally.cloaked += reduction < 1 ? 1 : 0
      tally.several += new Set(cls.engines.map((part) => part.id)).size > 1 ? 1 : 0

      for (const field of Object.keys(computed)) {
        if (!m.dr.agrees(storedFigures[field], computed[field]) || agreed[field] !== true) {
          mismatches.push({ file: save.file, game: GameID, race: RaceID, classId: cls.id, name: cls.name, field, stored: storedFigures[field], computed: computed[field], agreed: agreed[field] })
        }
      }
    }
  }

  return { tally, mismatches }
}

const explains = (pin, mismatch) => pin.file === mismatch.file && pin.game === mismatch.game && pin.race === mismatch.race && pin.classId === mismatch.classId && pin.field === mismatch.field && sameFigure(pin.stored, mismatch.stored) && sameFigure(pin.computed, mismatch.computed)

const describeMismatch = (mismatch) => `${mismatch.file} game ${mismatch.game} race ${mismatch.race} class ${mismatch.classId} ${mismatch.name} ${mismatch.field}: stored ${mismatch.stored}, rebuilt ${mismatch.computed}`

// ---------- the checks ----------

const checks = []
const check = (name, run) => checks.push({ name, run })

// ----- thermal

check('thermal: a moving class shows power × thermal rating × share', (m) => {
  const cls = klass()
  const { thermal } = m.sig.classSignatures(cls, { fractions: [0.25, 0.5, 1] })

  assert.deepEqual(thermal.byFraction.map(({ result }) => result.value), [25, 50, 100])
  assert.equal(thermal.aggregate.value, 100)
  assert.equal(thermal.byFraction[1].result.status, 'estimated')
  assert.ok(thermal.byFraction[1].result.assumptions.includes('moving at 50 % of top speed'), 'the share is an assumption of the result')
  assert.equal(m.sig.classSignatures(klass({ engines: [engine({ count: 4, thermalRating: 0.25, power: 80 })] }), { fractions: [1] }).thermal.byFraction[0].result.value, 80)
})

check('thermal: idle shows the floor of a twentieth of the size', (m) => {
  assert.equal(thermalOf(m, klass(), [0])[0], 2)
  assert.equal(thermalOf(m, klass({ sizeHS: 100 }), [0])[0], 5)
  assert.equal(thermalOf(m, klass({ engines: [engine({ count: 50, power: 1000 })] }), [0])[0], 2)
})

check('thermal: a low share clamps to the floor', (m) => {
  assert.deepEqual(thermalOf(m, klass(), [0.01, 0.02, 0.03]), [2, 2, 3])
})

check('thermal: a class with no engine shows the floor idle and 0 moving', (m) => {
  const cls = klass({ engines: [], stored: stored({ thermal: 0, enginePower: 0 }) })
  const { thermal } = m.sig.classSignatures(cls, { fractions: [0, 0.5, 1] })

  assert.deepEqual(thermal.byFraction.map(({ result }) => result.value), [2, 0, 0])
  assert.ok(thermal.byFraction[1].result.assumptions.some((text) => text.includes('no engine')), 'the reason is named')
  assert.equal(thermal.aggregate.value, 0)
  assert.equal(thermal.agrees, true)
})

check('thermal: a class of an unknown size or engine figure is unavailable, not 0', (m) => {
  unknown(m.sig.classSignatures(klass({ sizeHS: null })).thermal.byFraction[0].result, 'idle with no size')
  unknown(m.sig.classSignatures(klass({ engines: [engine({ power: null, count: 2 })] }), { fractions: [1] }).thermal.byFraction[0].result, 'moving with no power')
})

check('thermal: speed shares read from text', (m) => {
  assert.deepEqual(m.sig.readSpeedShares('25, 75%').fractions, [0, 0.25, 0.75, 1])
  assert.deepEqual(m.sig.readSpeedShares('75 25 75 50%;100').fractions, [0, 0.25, 0.5, 0.75, 1])
  assert.deepEqual(m.sig.readSpeedShares('33.5').fractions, [0, 0.335, 1])
  assert.deepEqual(m.sig.readSpeedShares('').fractions, m.sig.DEFAULT_FRACTIONS)
  assert.deepEqual(m.sig.readSpeedShares(null).fractions, [0, 0.5, 1])
  assert.deepEqual(m.sig.DEFAULT_FRACTIONS, [0, 0.5, 1])
  assert.equal(m.sig.readSpeedShares('25').error, '')
})

check('thermal: speed shares that cannot be read are errors as text', (m) => {
  for (const text of ['0', '150', '-5', '100.5', 'fast', '25, abc', '5 %%']) {
    const read = m.sig.readSpeedShares(text)

    assert.equal(typeof read.error, 'string', text)
    assert.ok(read.error.length > 0, `${text} has an error`)
    assert.deepEqual(read.fractions, [0, 0.5, 1], `${text} leaves the defaults`)
  }
})

check('thermal: the speed curve holds equal steps from 0 to 1 with the same points in its rows', (m) => {
  const curve = m.sig.speedCurve(klass(), { sensitivity: 4, steps: 4 })

  assert.deepEqual(curve.points.map((point) => point.fraction), [0, 0.25, 0.5, 0.75, 1])
  assert.deepEqual(curve.points.map((point) => point.thermal), [2, 25, 50, 75, 100])
  curve.points.forEach((point, index) => close(point.reach, 250000 * Math.sqrt(4 * point.thermal), `reach at step ${index}`))
  assert.deepEqual(curve.rows.map((row) => row.thermal.value), curve.points.map((point) => point.thermal))
  assert.deepEqual(curve.rows.map((row) => row.reach.value), curve.points.map((point) => point.reach))

  const blind = m.sig.speedCurve(klass(), { sensitivity: null, steps: 2 })

  assert.deepEqual(blind.points.map((point) => point.reach), [null, null, null])
  assert.deepEqual(blind.points.map((point) => point.thermal), [2, 50, 100])

  for (const steps of [0, 1.5, 201, '4']) {
    assert.throws(() => m.sig.speedCurve(klass(), { sensitivity: 4, steps }), /steps/, `${steps} steps`)
  }
})

// ----- range

check('range: four times the sensitivity doubles the range for a fixed signature', (m) => {
  const base = m.sig.passiveReach({ sensitivity: 5, signature: 100 })
  const four = m.sig.passiveReach({ sensitivity: 20, signature: 100 })

  close(base.value, 250000 * Math.sqrt(500), 'range of sensitivity 5 against 100')
  close(four.value, 2 * base.value, 'four times the sensitivity')
  close(m.sig.passiveReach({ sensitivity: 5, signature: 400 }).value, 2 * base.value, 'four times the signature')
  assert.equal(base.units, 'km')
  assert.equal(base.rule.id, 'design.sensorDetection')
})

check('range: a signature of 0 gives a range of 0', (m) => {
  const result = m.sig.passiveReach({ sensitivity: 5, signature: 0 })

  assert.equal(result.value, 0)
  assert.notEqual(result.status, 'unavailable')
  assert.equal(m.dr.passiveRange({ sensitivity: 5, signature: 0 }).value, 0)
})

check('range: an unknown signature or sensitivity stays unavailable', (m) => {
  for (const signature of [null, undefined, Number.NaN, 'ten', -1, Infinity]) {
    unknown(m.sig.passiveReach({ sensitivity: 5, signature }), `signature ${String(signature)}`)
    unknown(m.dr.passiveRange({ sensitivity: 5, signature }), `rule, signature ${String(signature)}`)
  }

  for (const sensitivity of [null, undefined, Number.NaN, 0, -5, Infinity, '5']) {
    unknown(m.sig.passiveReach({ sensitivity, signature: 100 }), `sensitivity ${String(sensitivity)}`)
    unknown(m.dr.passiveRange({ sensitivity, signature: 100 }), `rule, sensitivity ${String(sensitivity)}`)
  }

  assert.ok(m.sig.passiveReach({ sensitivity: 5, signature: null }).inputs.missing.some((text) => text.includes('signature')), 'the missing signature is named')
  assert.ok(m.sig.passiveReach({ sensitivity: null, signature: 5 }).inputs.missing.some((text) => text.includes('sensitivity')), 'the missing sensitivity is named')
})

check('range: a reach lends the provenance of its figures', (m) => {
  const signature = m.sig.classSignatures(klass(), { fractions: [0.5] }).thermal.byFraction[0].result
  const reach = m.sig.passiveReach({ sensitivity: 4, signature })

  assert.equal(reach.status, 'estimated')
  assert.ok(reach.assumptions.includes('moving at 50 % of top speed'), 'the assumption of the signature travels')
  close(reach.value, 250000 * Math.sqrt(200), 'reach')

  const blind = m.sig.passiveReach({ sensitivity: 4, signature: m.sig.classSignatures(klass({ sizeHS: null }), { fractions: [0] }).thermal.byFraction[0].result })

  unknown(blind, 'a reach on an unavailable signature')
})

check('range: the curve has a point for each known signature and none for an unknown sensor', (m) => {
  const curve = m.sig.rangeCurve({ sensitivities: [{ key: 'a', name: 'A', sensitivity: 4 }, { key: 'b', name: 'B', sensitivity: null }], signatures: [100, 25, 25, -5, Number.NaN, 0] })

  assert.deepEqual(curve.rows.map((row) => row.signature), [0, 25, 100])
  assert.deepEqual(curve.series[0].points.map((point) => point.x), [0, 25, 100])
  close(curve.series[0].points[1].y, 250000 * 10, 'range at 25')
  close(curve.series[0].points[2].y, 250000 * 20, 'range at 100')
  assert.equal(curve.series[0].points[0].y, 0)
  assert.deepEqual(curve.series[1].points, [])
  curve.rows.forEach((row) => {
    assert.equal(row.ranges.length, 2)
    unknown(row.ranges[1].result, `unknown sensor at ${row.signature}`)
  })
  curve.series[0].points.forEach((point, index) => assert.equal(curve.rows[index].ranges[0].result.value, point.y))
})

// ----- mixed

const TWO = () => klass({ engines: [engine({ id: 1, name: 'Fast', power: 100, thermalRating: 1, count: 1 }), engine({ id: 2, name: 'Quiet', power: 300, thermalRating: 0.1, count: 1 })] })

check('mixed: engines of two designs sum power-weighted, not as the mean of their ratings', (m) => {
  const { thermal } = m.sig.classSignatures(TWO(), { fractions: [0.5] })

  close(thermal.aggregate.value, 130, 'power-weighted sum')
  assert.notEqual(thermal.aggregate.value, 0.55 * 400, 'not the unweighted mean of the ratings')
  close(m.dr.classThermal({ engines: TWO().engines }), 130, 'the rule')
  close(thermal.byFraction[0].result.value, 65, 'half speed')
  assert.equal(m.dr.classThermal({ engines: [] }), 0)
})

check('mixed: a mixed class is estimated, a single design confirmed', (m) => {
  const mixed = m.sig.classSignatures(TWO()).thermal.aggregate

  assert.equal(mixed.status, 'estimated')
  assert.ok(mixed.assumptions.some((text) => text.includes('2 engine designs')), 'the reason is named')
  assert.equal(m.pv.getRule('design.classThermal').verification, 'confirmed')
  assert.equal(m.pv.getRule('design.classCrossSection').verification, 'confirmed')
  assert.equal(m.pv.getRule('design.emEmission').verification, 'estimated')
  assert.equal(m.pv.getRule('design.thermalSignature').verification, 'estimated')

  const single = m.sig.classSignatures(klass()).thermal.aggregate
  const twoRows = m.sig.classSignatures(klass({ engines: [engine({ id: 7, count: 1 }), engine({ id: 7, count: 1 })] })).thermal.aggregate

  assert.equal(single.status, 'confirmed')
  assert.equal(twoRows.status, 'confirmed', 'a design mounted in two rows is one design')
  assert.equal(m.sig.classSignatures(klass({ engines: [] })).thermal.aggregate.status, 'confirmed')
})

check('mixed: a single design equals the stored thermal signature', (m) => {
  const cls = klass({ engines: [engine({ power: 120, thermalRating: 0.25, count: 3 })], stored: stored({ thermal: 90 }) })
  const { thermal } = m.sig.classSignatures(cls)

  close(thermal.aggregate.value, 90, 'aggregate')
  assert.equal(thermal.stored.value, 90)
  assert.equal(thermal.agrees, true)
  assert.equal(m.sig.classSignatures({ ...cls, stored: stored({ thermal: 91 }) }).thermal.agrees, false)
  assert.equal(m.sig.classSignatures({ ...cls, stored: stored({ thermal: null }) }).thermal.agrees, null)
  unknown(m.sig.classSignatures({ ...cls, stored: stored({ thermal: null }) }).thermal.stored, 'a stored figure the save lacks')
})

// ----- cross-section

// A class whose stored cross-section and sensor reduction are what the rules rebuild from its size and cloaks.
const consistent = (m, over) => {
  const cls = klass(over)
  const reduction = m.dr.cloakReduction({ sizeHS: cls.sizeHS, cloaks: cls.cloaks })

  return { ...cls, stored: stored({ crossSection: m.dr.classCrossSection({ sizeHS: cls.sizeHS, sensorReduction: reduction }), sensorReduction: reduction }) }
}

check('cross-section: effective and uncloaked stay distinct for a cloaked class', (m) => {
  const cls = klass({ sizeHS: 100, cloaks: [cloak(120, 0.5)], stored: stored({ crossSection: 50, sensorReduction: 0.5 }) })
  const { crossSection } = m.sig.classSignatures(cls)

  assert.equal(crossSection.effective.value, 50)
  assert.equal(crossSection.uncloaked.value, 100)
  assert.equal(crossSection.cloaked, true)
  assert.equal(crossSection.stored.value, 50)
  assert.equal(crossSection.rebuilt.value, 50)
  assert.equal(crossSection.agrees, true)
  assert.equal(crossSection.reduction.rebuilt.value, 0.5)
  assert.equal(crossSection.reduction.agrees, true)
  assert.equal(m.sig.classSignatures({ ...cls, stored: stored({ crossSection: 50, sensorReduction: 0.6 }) }).crossSection.reduction.agrees, false)
  assert.ok(crossSection.uncloaked.assumptions.some((text) => text.includes('cloak is damaged')), 'the scenario is an assumption')
})

check('cross-section: the effective cross-section is the stored one, and a stored figure the rules do not rebuild is flagged, not replaced', (m) => {
  const cls = klass({ sizeHS: 100, cloaks: [cloak(120, 0.5)], stored: stored({ crossSection: 25, sensorReduction: 0.5 }) })
  const { crossSection } = m.sig.classSignatures(cls)

  assert.equal(crossSection.effective.value, 25)
  assert.equal(crossSection.effective.status, 'confirmed')
  assert.equal(crossSection.effective.rule.id, 'design.classCrossSection')
  assert.equal(crossSection.rebuilt.value, 50)
  assert.equal(crossSection.agrees, false)
  assert.equal(crossSection.uncloaked.value, 100)
  close(m.sig.activeReach({ rangeKm: 4e7, resolution: 100, crossSection: crossSection.effective }).value, 4e7 * (25 / 100) ** 2, 'the reach from the stored figure')
})

check('cross-section: a cloak with unknown figures leaves the stored effective and the size known', (m) => {
  const cls = klass({ sizeHS: 100, cloaks: [cloak(120, null)], stored: stored({ crossSection: 25, sensorReduction: 0.25 }) })
  const { crossSection } = m.sig.classSignatures(cls)

  assert.equal(crossSection.effective.value, 25)
  assert.equal(crossSection.effective.status, 'confirmed')
  assert.equal(crossSection.uncloaked.value, 100)
  assert.equal(crossSection.cloaked, true)
  assert.equal(crossSection.agrees, null)
  unknown(crossSection.rebuilt, 'rebuilt')
  assert.equal(crossSection.reduction.agrees, null)
})

check('cross-section: a class that stores no cross-section has it rebuilt and says so, unknown when the rebuild is', (m) => {
  const rebuilt = m.sig.classSignatures(klass({ sizeHS: 100, cloaks: [cloak(120, 0.5)], stored: stored({ crossSection: null, sensorReduction: null }) })).crossSection

  assert.equal(rebuilt.effective.value, 50)
  assert.ok(rebuilt.effective.assumptions.some((text) => text.includes('stores no cross-section')), 'the stand-in is an assumption')
  assert.equal(rebuilt.cloaked, true)
  assert.equal(rebuilt.agrees, null)

  const lacking = m.sig.classSignatures(klass({ sizeHS: 100, cloaks: [cloak(null, 0.5)], stored: stored({ crossSection: null, sensorReduction: null }) })).crossSection

  unknown(lacking.effective, 'effective')
  assert.equal(lacking.uncloaked.value, 100)

  const sizeless = m.sig.classSignatures(klass({ sizeHS: null, stored: stored({ crossSection: 25, sensorReduction: 1 }) })).crossSection

  assert.equal(sizeless.effective.value, 25)
  unknown(sizeless.uncloaked, 'uncloaked without a size')
})

check('cross-section: a class without a cloak shows its size, cloaked or not', (m) => {
  assert.deepEqual(sizes(m, consistent(m, { sizeHS: 100 })), { effective: 100, uncloaked: 100, cloaked: false })
  assert.deepEqual(sizes(m, consistent(m, { sizeHS: 100, cloaks: [cloak(80, 0.1)] })), { effective: 100, uncloaked: 100, cloaked: false })
})

check('cross-section: a cloak covers a class only when it is at least its size', (m) => {
  assert.equal(m.dr.cloakReduction({ sizeHS: 100, cloaks: [cloak(99.9, 0.5)] }), 1)
  assert.equal(m.dr.cloakReduction({ sizeHS: 100, cloaks: [cloak(100, 0.5)] }), 0.5)
  assert.equal(m.dr.cloakReduction({ sizeHS: 100, cloaks: [cloak(100.1, 0.5)] }), 0.5)
  assert.equal(m.dr.cloakReduction({ sizeHS: 100, cloaks: [] }), 1)
  assert.equal(m.sig.classSignatures(klass({ sizeHS: 100, cloaks: [cloak(99, 0.1)] })).crossSection.reduction.rebuilt.value, 1)
})

check('cross-section: the last covering cloak wins', (m) => {
  const size = 100

  assert.equal(m.dr.cloakReduction({ sizeHS: size, cloaks: [cloak(120, 0.5, 1), cloak(150, 0.4, 2)] }), 0.4)
  assert.equal(m.dr.cloakReduction({ sizeHS: size, cloaks: [cloak(150, 0.4, 1), cloak(120, 0.5, 2)] }), 0.5)
  assert.equal(m.dr.cloakReduction({ sizeHS: size, cloaks: [cloak(150, 0.4, 1), cloak(80, 0.1, 2)] }), 0.4)
  assert.equal(m.sig.classSignatures(klass({ sizeHS: size, cloaks: [cloak(120, 0.5, 1), cloak(150, 0.4, 2)] })).crossSection.rebuilt.value, 40)
})

check('cross-section: the floor of 0.3', (m) => {
  assert.equal(m.dr.CROSS_SECTION_MIN, 0.3)
  assert.equal(m.dr.CROSS_SECTION_MIN, m.dr.MISSILE_SIGNATURE_MIN)
  assert.equal(m.dr.classCrossSection({ sizeHS: 0.1 }), 0.3)
  assert.equal(m.dr.classCrossSection({ sizeHS: 40, sensorReduction: 0.005 }), 0.3)
  assert.equal(m.dr.classCrossSection({ sizeHS: 1, sensorReduction: 0.5 }), 0.5)
  assert.equal(m.dr.classCrossSection({ sizeHS: 40 }), 40)
  assert.deepEqual(sizes(m, consistent(m, { sizeHS: 0.1 })), { effective: 0.3, uncloaked: 0.3, cloaked: false })
  assert.deepEqual(sizes(m, consistent(m, { sizeHS: 40, cloaks: [cloak(40, 0.005)] })), { effective: 0.3, uncloaked: 40, cloaked: true })
  assert.equal(m.sig.classSignatures(klass({ sizeHS: 40, cloaks: [cloak(40, 0.005)] })).crossSection.rebuilt.value, 0.3)
})

check('cross-section: active reach applies the floor and the (C/R)^2 penalty', (m) => {
  const small = m.sig.classSignatures(consistent(m, { sizeHS: 0.1 })).crossSection
  const cloaked = m.sig.classSignatures(consistent(m, { sizeHS: 100, cloaks: [cloak(120, 0.5)] })).crossSection

  close(m.sig.activeReach({ rangeKm: 1e7, resolution: 1, crossSection: small.effective }).value, 1e7 * 0.09, 'the floored cross-section against a resolution of 1')
  close(m.sig.activeReach({ rangeKm: 4e7, resolution: 100, crossSection: cloaked.effective }).value, 1e7, 'a cloaked class against a resolution of 100')
  close(m.sig.activeReach({ rangeKm: 4e7, resolution: 100, crossSection: cloaked.uncloaked }).value, 4e7, 'the same class uncloaked')
  close(m.sig.activeReach({ rangeKm: 4e7, resolution: 20, crossSection: cloaked.effective }).value, 4e7, 'a cross-section at or above the resolution keeps the range')
  close(m.sig.activeReach({ rangeKm: 4e7, resolution: 50, crossSection: 25 }).value, 1e7, 'a number as the cross-section')
  assert.equal(m.sig.activeReach({ rangeKm: 4e7, resolution: 100, crossSection: cloaked.effective }).rule.id, 'design.sensorDetection')

  for (const figures of [{ rangeKm: null, resolution: 100, crossSection: 50 }, { rangeKm: 4e7, resolution: null, crossSection: 50 }, { rangeKm: 4e7, resolution: 100, crossSection: null }, { rangeKm: 0, resolution: 100, crossSection: 50 }]) {
    unknown(m.sig.activeReach(figures), `reach of ${JSON.stringify(figures)}`)
  }
})

// ----- reduction

const LEVELS = Object.freeze([
  { id: 12, name: 'Thermal Reduction: Signature 100% Normal', multiplier: 1, costFactor: 1.7, cost: 1, obsolete: false },
  { id: 13, name: 'Thermal Reduction: Signature 75% Normal', multiplier: 0.75, costFactor: 1.3, cost: 1500, obsolete: false },
  { id: 14, name: 'Thermal Reduction: Signature 50% Normal', multiplier: 0.5, costFactor: 1.9, cost: 3000, obsolete: false },
])

const TECHS = Object.freeze({
  10: { type: 40, name: 'Engine tech', info: 5, info2: 0 },
  11: { type: 65, name: 'Fuel tech', info: 0.2, info2: 0 },
  13: { type: 127, name: 'Thermal Reduction: Signature 75% Normal', info: 0.75, info2: 1.3 },
})

const reductionOf = (m, cls = klass(), over = {}) => m.sig.thermalReductionOptions(cls, { levels: LEVELS, techs: TECHS, ...over })

check('reduction: each level rebuilds the engine from its tech rows with the level\'s multiplier', (m) => {
  const options = reductionOf(m, klass(), { fractions: [0, 0.5, 1] })

  assert.deepEqual(options.map((option) => option.level), [{ id: 12, name: LEVELS[0].name, current: false }, { id: 13, name: LEVELS[1].name, current: true }, { id: 14, name: LEVELS[2].name, current: false }])
  assert.deepEqual(options.map((option) => option.multiplier), [1, 0.75, 0.5])
  assert.deepEqual(options.map((option) => option.aggregate.value), [100, 75, 50])
  assert.deepEqual(options[1].byFraction.map(({ result }) => result.value), [2, 37.5, 75])
  assert.deepEqual(options[2].byFraction.map(({ result }) => result.value), [2, 25, 50])
  assert.equal(options[1].engines[0].count, 2)
  assert.equal(options[1].engines[0].engine.name, 'Engine A')
  assert.equal(options[1].aggregate.status, 'confirmed')
  assert.equal(options[1].engineCost.units, 'BP')
})

check('reduction: the cost factor is read from the tech row, and applies only below a multiplier of 1', (m) => {
  const options = reductionOf(m)

  close(options[0].engineCost.value, 25, 'level 100 % ignores its cost factor')
  close(options[1].engineCost.value, 25 * 1.3, 'level 75 %')
  close(options[2].engineCost.value, 25 * 1.9, 'level 50 %')
  assert.deepEqual(options.map((option) => option.costFactor), [1.7, 1.3, 1.9])

  const other = reductionOf(m, klass(), { levels: [{ ...LEVELS[1], costFactor: 2.1 }] })

  close(other[0].engineCost.value, 25 * 2.1, 'a cost factor of 2.1 from the row')
  close(other[0].classEngineCost.value, 2 * 25 * 2.1, 'the class cost')
})

check('reduction: a level whose tech row is missing is unavailable, naming the row', (m) => {
  const noFuel = reductionOf(m, klass(), { techs: { 10: TECHS[10] } })
  const noEngine = reductionOf(m, klass(), { techs: { 11: TECHS[11] } })

  for (const option of noFuel) {
    unknown(option.engineCost, 'engine cost without the fuel row')
    unknown(option.classEngineCost, 'class cost without the fuel row')
    unknown(option.aggregate, 'thermal without the fuel row')
    assert.ok(option.engineCost.inputs.missing.some((text) => text.includes('fuel tech row')), 'the fuel row is named')
  }

  assert.ok(noEngine[0].engineCost.inputs.missing.some((text) => text.includes('engine tech row')), 'the engine row is named')
  unknown(reductionOf(m, klass({ engines: [engine({ count: 2, techIds: { engine: null, fuel: 11, thermal: 13 } })] }))[0].engineCost, 'an engine naming no engine tech')
  unknown(reductionOf(m, klass(), { levels: [{ ...LEVELS[1], costFactor: null }] })[0].engineCost, 'a level with no cost factor')
  unknown(reductionOf(m, klass(), { levels: [{ ...LEVELS[1], multiplier: null }] })[0].aggregate, 'a level with no multiplier')
})

check('reduction: a class with no engine has no options', (m) => {
  assert.deepEqual(reductionOf(m, klass({ engines: [] })), [])
})

check('reduction: the class cost sums every engine and an engine cost is that of one design', (m) => {
  const options = reductionOf(m)

  close(options[1].classEngineCost.value, 2 * 25 * 1.3, 'two engines')
  assert.equal(options[1].classEngineCost.units, 'BP')

  const mixed = reductionOf(m, klass({ engines: [engine({ id: 1, name: 'One', count: 1 }), engine({ id: 2, name: 'Two', count: 3, sizeHS: 20 })] }), { techs: TECHS })

  close(mixed[1].classEngineCost.value, 25 * 1.3 + 3 * 50 * 1.3, 'two designs')
  unknown(mixed[1].engineCost, 'an engine cost for two designs')
  assert.equal(mixed[1].aggregate.status, 'estimated')
  close(mixed[1].aggregate.value, 0.75 * 50 + 3 * 0.75 * 100, 'thermal of two designs at 75 %')
})

check('reduction (save): the levels and tech rows read are those of the save', async (m) => {
  if (!SAVES.length) {
    return skipped('no save in saves/')
  }

  let levels = 0
  let reduced = 0
  let rows = 0

  for (const save of SAVES) {
    for (const { GameID, RaceID } of await racesOf(save)) {
      const read = await m.dd.loadThermalReduction(save.database, { GameID, RaceID })
      const [direct] = await save.database.query('select t.TechSystemID as id, t.AdditionalInfo as info, t.AdditionalInfo2 as info2 from FCT_RaceTech r inner join FCT_TechSystem t on t.TechSystemID = r.TechID where r.GameID = :GameID and r.RaceID = :RaceID and t.TechTypeID = 127 order by t.DevelopCost, t.TechSystemID', { replacements: { GameID, RaceID } })

      assert.deepEqual(read.levels.map((level) => [level.id, level.multiplier, level.costFactor]), direct.map((row) => [row.id, row.info, row.info2]), `${save.file} game ${GameID} race ${RaceID}`)
      levels += read.levels.length
      reduced += read.levels.filter((level) => level.multiplier < 1 && level.costFactor > 1).length

      for (const [id, tech] of Object.entries(read.techs)) {
        const [[row]] = await save.database.query('select TechTypeID, AdditionalInfo, AdditionalInfo2 from FCT_TechSystem where TechSystemID = :id', { replacements: { id: Number(id) } }).then(([found]) => [found])

        assert.deepEqual([tech.type, tech.info, tech.info2], [row.TechTypeID, row.AdditionalInfo, row.AdditionalInfo2], `${save.file} tech ${id}`)
        rows++
      }
    }
  }

  assert.ok(levels > 0 && reduced > 0 && rows > 0, `levels ${levels}, reduced ${reduced}, tech rows ${rows}`)

  return { lines: [`${levels} levels (${reduced} reducing the signature at a higher engine cost) and ${rows} engine, fuel and thermal tech rows over ${SAVES.length} saves, each as the tech table gives it`] }
})

// A save older or modded may lack a column the loaders read for a figure only: the figure is then unknown (null), and no query may name the column by its table.
const memoryDatabase = (statements) => new Promise((resolve, reject) => {
  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(':memory:', (openError) => {
    if (openError) {
      reject(openError)

      return
    }

    raw.exec(statements.join(';\n'), (execError) => {
      if (execError) {
        reject(execError)

        return
      }

      resolve({ database: appDatabase(raw), close: () => raw.close() })
    })
  })
})

check('reduction (missing column): a save without the development cost or the obsolete flag gives the levels with an unknown cost', async (m) => {
  const memory = await memoryDatabase([
    'create table FCT_TechSystem (TechSystemID integer, TechTypeID integer, Name text, AdditionalInfo real, AdditionalInfo2 real)',
    'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer)',
    "insert into FCT_TechSystem values (30, 127, 'Second', 0.5, 1.5), (20, 127, 'First', 0.75, 1.25), (40, 65, 'Fuel', 0.2, null)",
    'insert into FCT_RaceTech values (1, 2, 30), (1, 2, 20), (1, 2, 40), (1, 3, 30)',
  ])

  try {
    const read = await m.dd.loadThermalReduction(memory.database, { GameID: 1, RaceID: 2 })

    assert.deepEqual(read.levels.map((level) => [level.id, level.name, level.multiplier, level.costFactor, level.cost, level.obsolete]), [[20, 'First', 0.75, 1.25, null, false], [30, 'Second', 0.5, 1.5, null, false]])
  } finally {
    memory.close()
  }
})

check('reduction (missing column): the levels come cheapest first, ties by id, and the flag is read when the save has it', async (m) => {
  const memory = await memoryDatabase([
    'create table FCT_TechSystem (TechSystemID integer, TechTypeID integer, Name text, AdditionalInfo real, AdditionalInfo2 real, DevelopCost real)',
    'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer, Obsolete integer)',
    "insert into FCT_TechSystem values (30, 127, 'Dear', 0.5, 1.5, 900), (25, 127, 'Cheap too', 0.7, 1.3, 100), (20, 127, 'Cheap', 0.75, 1.25, 100)",
    'insert into FCT_RaceTech values (1, 2, 30, 0), (1, 2, 25, 1), (1, 2, 20, 0)',
  ])

  try {
    const read = await m.dd.loadThermalReduction(memory.database, { GameID: 1, RaceID: 2 })

    assert.deepEqual(read.levels.map((level) => [level.id, level.cost, level.obsolete]), [[20, 100, false], [25, 100, true], [30, 900, false]])
  } finally {
    memory.close()
  }
})

check('reduction (missing column): a class read from a save with only the columns it cannot do without has every other figure unknown, not 0', async (m) => {
  const memory = await memoryDatabase([
    'create table FCT_ShipClass (ShipClassID integer, ClassName text, GameID integer, RaceID integer)',
    'create table FCT_ClassComponent (GameID integer, ClassID integer, ComponentID integer, NumComponent integer)',
    'create table FCT_ShipDesignComponents (SDComponentID integer, ComponentTypeID integer)',
    'create table FCT_TechSystem (TechSystemID integer, TechTypeID integer)',
    "insert into FCT_ShipClass values (7, 'Bare', 1, 2)",
    'insert into FCT_ClassComponent values (1, 7, 100, 3)',
    'insert into FCT_ShipDesignComponents values (100, 1)',
  ])

  try {
    const [cls] = await m.dd.loadSignatureClasses(memory.database, { GameID: 1, RaceID: 2 })

    assert.equal(cls.name, 'Bare')
    assert.equal(cls.stored.thermal, null)
    assert.equal(cls.stored.crossSection, null)
    assert.equal(cls.engines.length, 1)
    assert.equal(cls.engines[0].count, 3)
    assert.equal(cls.engines[0].power, null)
  } finally {
    memory.close()
  }
})

check('loaders: the three reads of the page succeed on a schema without the sensor design columns the page does not use, with the passive sensors as stored', async (m) => {
  const memory = await memoryDatabase([
    'create table FCT_ShipClass (ShipClassID integer, ClassName text, GameID integer, RaceID integer, Size real)',
    'create table FCT_ClassComponent (GameID integer, ClassID integer, ComponentID integer, NumComponent integer)',
    'create table FCT_ShipDesignComponents (SDComponentID integer, GameID integer, Name text, ComponentTypeID integer, ComponentValue real, Size real, StealthRating real)',
    'create table FCT_TechSystem (TechSystemID integer, TechTypeID integer, Name text, AdditionalInfo real, AdditionalInfo2 real, DevelopCost real)',
    'create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer)',
    "insert into FCT_ShipClass values (7, 'Sensing', 1, 2, 40)",
    'insert into FCT_ClassComponent values (1, 7, 100, 2), (1, 7, 101, 1)',
    "insert into FCT_ShipDesignComponents values (100, 1, 'Engine', 1, 50, 10, 0.5), (101, 1, 'Thermal 25', 8, 25, 1, null), (102, 1, 'EM 10', 41, 10, 1, null), (103, 0, 'Active', 24, 40, 1, null), (104, 1, 'Thermal other race', 8, 99, 1, null)",
    "insert into FCT_TechSystem values (5, 127, 'Reduction', 0.5, 1.5, 100)",
    'insert into FCT_RaceTech values (1, 2, 101), (1, 2, 102), (1, 2, 103), (1, 3, 104), (1, 2, 5)',
  ])

  try {
    const classes = await m.dd.loadSignatureClasses(memory.database, { GameID: 1, RaceID: 2 })
    const reduction = await m.dd.loadThermalReduction(memory.database, { GameID: 1, RaceID: 2 })
    const passive = await m.dd.ownedPassiveSensors(memory.database, 1, 2)

    assert.equal(classes.length, 1)
    assert.equal(classes[0].thermalSensors.length, 1)
    assert.equal(reduction.levels.length, 1)
    assert.deepEqual(passive.map((row) => [row.SDComponentID, row.Name, row.ComponentTypeID, row.ComponentValue]), [[101, 'Thermal 25', 8, 25], [102, 'EM 10', 41, 10]])
  } finally {
    memory.close()
  }
})

// The capability registry as the app evaluates it (utilities/capabilities.js `schemaOf` and `evaluate` on the columns the registry lists for /sensors): a column a loader projects only when the save has it is no read of the registry, so a save without it keeps the page supported, and a column a query cannot do without is a read, so a save without it makes the page unsupported.
const sensorSchema = (m, without = []) => {
  const rows = []

  for (const input of m.cap.INPUTS['/sensors']) {
    for (const [tbl, columns] of Object.entries(input.reads)) {
      columns.filter((name) => name !== '*' && !without.includes(`${tbl}.${name}`)).forEach((name) => rows.push({ tbl, name }))
    }
  }

  if (!without.includes('FCT_RaceTech.Obsolete')) {
    rows.push({ tbl: 'FCT_RaceTech', name: 'Obsolete' })
  }

  return m.cap.schemaOf(rows)
}

check('capability: /sensors is supported on a save with the whole schema and with FCT_RaceTech.Obsolete absent', (m) => {
  const whole = m.cap.evaluate(sensorSchema(m)).reports['/sensors']
  const absent = m.cap.evaluate(sensorSchema(m, ['FCT_RaceTech.Obsolete'])).reports['/sensors']

  assert.equal(whole.status, 'supported', JSON.stringify(whole))
  assert.equal(absent.status, 'supported', JSON.stringify(absent))
  assert.ok(!Object.values(m.cap.INPUTS['/sensors']).some((input) => (input.reads.FCT_RaceTech || []).includes('Obsolete')), 'a loader that projects the flag only when the save has it lists it as a read')
})

check('capability: /sensors is unsupported on a save without a column a loader cannot do without, naming it', (m) => {
  for (const field of ['FCT_RaceTech.TechID', 'FCT_TechSystem.TechTypeID', 'FCT_ShipClass.ClassName', 'FCT_ClassComponent.NumComponent']) {
    const report = m.cap.evaluate(sensorSchema(m, [field])).reports['/sensors']

    assert.equal(report.status, 'unsupported', `${field}: ${JSON.stringify(report)}`)
    assert.ok(report.missing.some((entry) => entry.fields.includes(field)), `${field} is not named`)
  }
})

check('reduction (save): an engine rebuilt at its own tech levels reproduces its stored power', async (m) => {
  if (!SAVES.length) {
    return skipped('no save in saves/')
  }

  const lines = []
  let total = 0

  for (const save of SAVES) {
    let rebuilt = 0
    let ratings = 0

    for (const { GameID, RaceID } of await racesOf(save)) {
      const { techs } = await m.dd.loadThermalReduction(save.database, { GameID, RaceID })
      const classes = await m.dd.loadSignatureClasses(save.database, { GameID, RaceID })

      for (const cls of classes) {
        for (const part of cls.engines) {
          const [engineTech, fuelTech, thermalTech] = [techs[part.techIds.engine], techs[part.techIds.fuel], techs[part.techIds.thermal]]

          assert.ok(engineTech && fuelTech && thermalTech, `${save.file} ${cls.name}: ${part.name} names its three techs`)

          const design = m.dr.engineDesign({ sizeHS: part.sizeHS, thrust: part.thrust, engineTech: engineTech.info, fuelTech: fuelTech.info, thermalTech: thermalTech.info, thermalCost: thermalTech.info2 })

          assert.ok(m.dr.agrees(part.power, design.power), `${save.file} ${cls.name}: ${part.name} stores ${part.power} EP, the rule gives ${design.power}`)
          rebuilt++
          ratings += sameFigure(part.thermalRating, thermalTech.info) ? 0 : 1
        }
      }
    }

    total += rebuilt
    lines.push(`${save.file}: ${rebuilt} engine mounts rebuilt, 0 differing in power${ratings ? `, ${ratings} storing a thermal rating other than their thermal tech's (a modded save; not a figure of the three reconciled)` : ''}`)
  }

  assert.ok(total > 0, 'no engine was rebuilt')

  return { lines }
})

// ----- em

check('em: shields give strength × 30 with the shields up', (m) => {
  const { shields } = m.sig.classSignatures(klass({ stored: stored({ shieldStrength: 85 }) })).em

  assert.equal(shields.value, 2550)
  assert.equal(shields.status, 'estimated')
  assert.ok(shields.assumptions.includes('shields up at full strength'), 'the assumption is named')
  assert.equal(m.dr.shieldEmission({ shieldStrength: 3 }), 90)
  assert.equal(m.dr.SHIELD_EM_MULTIPLIER, 30)
})

check('em: an active sensor gives max(1, trunc(strength) × trunc(resolution))', (m) => {
  const em = m.sig.classSignatures(klass({ activeSensors: [{ id: 21, name: 'AS A', count: 1, strength: 10.9, resolution: 5.7 }, { id: 22, name: 'AS B', count: 3, strength: 0.4, resolution: 1 }] })).em

  assert.deepEqual(em.activeSensors.map(({ result }) => result.value), [50, 1])
  assert.equal(em.activeSensors[0].sensor.name, 'AS A')
  assert.equal(m.dr.activeSensorEmission({ strength: 10.9, resolution: 5.7 }), 50)
  assert.equal(m.dr.activeSensorEmission({ strength: 0, resolution: 100 }), 1)
  assert.equal(m.dr.activeSensorEmission({ strength: 30, resolution: 20 }), 600)
  unknown(m.sig.classSignatures(klass({ activeSensors: [{ id: 21, name: 'AS A', count: 1, strength: null, resolution: 5 }] })).em.activeSensors[0].result, 'a sensor with no strength')
})

check('em: each active sensor is seen on its own and the strongest is not a sum', (m) => {
  const sensors = [{ id: 21, name: 'AS A', count: 1, strength: 10.9, resolution: 5.7 }, { id: 22, name: 'AS B', count: 3, strength: 0.4, resolution: 1 }]
  const em = m.sig.classSignatures(klass({ activeSensors: sensors })).em
  const twice = m.sig.classSignatures(klass({ activeSensors: [...sensors, { ...sensors[0] }] })).em

  assert.equal(em.strongestActive.value, 50)
  assert.equal(twice.activeSensors.length, 2, 'a design in two rows is one sensor')
  assert.equal(twice.strongestActive.value, 50)
  unknown(m.sig.classSignatures(klass({ activeSensors: [...sensors, { id: 23, name: 'AS C', count: 1, strength: null, resolution: 5 }] })).em.strongestActive, 'the strongest with a sensor of unknown strength')
})

check('em: no shields or no active sensor gives 0, not unknown', (m) => {
  const em = m.sig.classSignatures(klass()).em

  assert.equal(em.shields.value, 0)
  assert.notEqual(em.shields.status, 'unavailable')
  assert.equal(em.strongestActive.value, 0)
  assert.notEqual(em.strongestActive.status, 'unavailable')
  assert.deepEqual(em.activeSensors, [])
  unknown(m.sig.classSignatures(klass({ stored: stored({ shieldStrength: null }) })).em.shields, 'a shield strength the save lacks')
})

// ----- saves

check('saves: ClassThermal, ClassCrossSection and SensorReduction are rebuilt for every class, but for the pinned rows', async (m) => {
  if (!SAVES.length) {
    return skipped('no save in saves/')
  }

  const lines = []
  const unexplained = []
  const seen = new Set()
  let classes = 0
  let explained = 0

  for (const save of SAVES) {
    const { tally, mismatches } = await reconcileSave(m, save)
    const own = mismatches.filter((mismatch) => PINNED.some((pin, index) => explains(pin, mismatch) && seen.add(index)))

    unexplained.push(...mismatches.filter((mismatch) => !own.includes(mismatch)))
    classes += tally.classes
    explained += own.length

    const count = (field) => mismatches.filter((mismatch) => mismatch.field === field).length

    lines.push(`${save.file}: ${tally.classes} classes in ${tally.races} races, ${tally.withEngines} with engines, ${tally.cloaked} cloaked, ${tally.several} with several engine designs; mismatches: ClassThermal ${count('ClassThermal')}, ClassCrossSection ${count('ClassCrossSection')}, SensorReduction ${count('SensorReduction')}, of which ${own.length} explained`)
  }

  assert.ok(classes > 0, 'the saves hold no class')
  assert.deepEqual(unexplained.map(describeMismatch), [], 'mismatches no pinned row explains')
  assert.equal(seen.size, PINNED.filter((pin) => SAVES.some((save) => save.file === pin.file)).length, 'every pinned row of a save read is still a mismatch')
  lines.push(`${classes} classes over ${SAVES.length} saves, ${unexplained.length} unexplained mismatches, ${explained} explained by the pinned rows`)

  return { lines }
})

check('saves: the pinned modded classes store what is pinned and the rule gives the pinned figure', async (m) => {
  const present = SAVES.filter((save) => PINNED.some((pin) => pin.file === save.file))

  if (!present.length) {
    return skipped(`${[...new Set(PINNED.map((pin) => pin.file))].join(', ')} is not in saves/`)
  }

  const lines = []

  for (const pin of PINNED) {
    const save = present.find((item) => item.file === pin.file)
    const classes = await m.dd.loadSignatureClasses(save.database, { GameID: pin.game, RaceID: pin.race })
    const cls = classes.find((item) => item.id === pin.classId)

    assert.ok(cls, `class ${pin.classId} of ${pin.file}`)
    assert.equal(cls.name, pin.name)
    assert.equal(cls.stored.thermal, pin.stored, `${pin.name}: stored`)
    close(m.dr.classThermal({ engines: cls.engines }), pin.computed, `${pin.name}: rebuilt`)
    assert.equal(m.sig.classSignatures(cls).thermal.agrees, false, `${pin.name}: the disagreement is shown, not hidden`)
    lines.push(`game ${pin.game} race ${pin.race} class ${pin.classId} ${pin.name}: ${pin.field} stored ${pin.stored}, rebuilt ${pin.computed}`)
  }

  return { lines }
})

// ---------- the faults ----------

// Each fault is planted in one module: `find` must occur once in `file`, and every check beginning with a name of `fails` must fail on the copy.
const MUTATIONS = [
  { name: 'the thermal floor of a tenth of the size', file: 'design-rules.js', find: 'return Math.max(sizeHS / 20, enginePower * stealthRating * fraction)', replace: 'return Math.max(sizeHS / 10, enginePower * stealthRating * fraction)', fails: ['thermal: idle', 'thermal: a low share', 'thermal: the speed curve'] },
  { name: 'the thermal signature as the smaller of the floor and the engines', file: 'design-rules.js', find: 'return Math.max(sizeHS / 20, enginePower * stealthRating * fraction)', replace: 'return Math.min(sizeHS / 20, enginePower * stealthRating * fraction)', fails: ['thermal: a moving', 'thermal: idle'] },
  { name: 'the thermal signature without the share of top speed', file: 'design-rules.js', find: 'return Math.max(sizeHS / 20, enginePower * stealthRating * fraction)', replace: 'return Math.max(sizeHS / 20, enginePower * stealthRating)', fails: ['thermal: a moving', 'thermal: a low share', 'thermal: the speed curve'] },
  { name: 'the class thermal as the mean of the ratings', file: 'design-rules.js', find: 'return engines.reduce((total, { power, thermalRating, count }) => total + count * power * thermalRating, 0)', replace: 'return engines.reduce((total, { power, count }) => total + count * power, 0) * (engines.reduce((total, { thermalRating }) => total + thermalRating, 0) / (engines.length || 1))', fails: ['mixed: engines of two designs'] },
  { name: 'the class thermal without the thermal rating', file: 'design-rules.js', find: 'total + count * power * thermalRating, 0)', replace: 'total + count * power, 0)', fails: ['mixed: engines of two designs', 'mixed: a single design', 'saves: ClassThermal'] },
  { name: 'the class thermal without the engine count', file: 'design-rules.js', find: 'total + count * power * thermalRating, 0)', replace: 'total + power * thermalRating, 0)', fails: ['mixed: a single design', 'saves: ClassThermal'] },
  { name: 'the passive range unit of 200,000 km', file: 'design-rules.js', find: 'export const PASSIVE_RANGE_MULTIPLIER = 250000', replace: 'export const PASSIVE_RANGE_MULTIPLIER = 200000', fails: ['range: four times'] },
  { name: 'the passive range on the sensitivity times the signature without the root', file: 'design-rules.js', find: 'Math.sqrt(sensitivity * signature) * PASSIVE_RANGE_MULTIPLIER', replace: '(sensitivity * signature) * PASSIVE_RANGE_MULTIPLIER', fails: ['range: four times'] },
  { name: 'a passive sensor of sensitivity 0 accepted', file: 'design-rules.js', find: '[\'sensor sensitivity\', sensitivity, POSITIVE,', replace: '[\'sensor sensitivity\', sensitivity, NON_NEGATIVE,', fails: ['range: an unknown'] },
  { name: 'a signature of 0 refused', file: 'design-rules.js', find: 'signature, NON_NEGATIVE, \'the target\\\'s signature, 0 or more\'],', replace: 'signature, POSITIVE, \'the target\\\'s signature, 0 or more\'],', fails: ['range: a signature of 0'] },
  { name: 'the cross-section floor of 0.5', file: 'design-rules.js', find: 'export const CROSS_SECTION_MIN = MISSILE_SIGNATURE_MIN', replace: 'export const CROSS_SECTION_MIN = 0.5', fails: ['cross-section: the floor', 'cross-section: active reach'] },
  { name: 'no cross-section floor', file: 'design-rules.js', find: 'Math.max(sizeHS * sensorReduction, CROSS_SECTION_MIN)', replace: 'sizeHS * sensorReduction', fails: ['cross-section: the floor', 'cross-section: active reach'] },
  { name: 'the first covering cloak wins', file: 'design-rules.js', find: 'for (const { maxShipHS, rating } of cloaks) {', replace: 'for (const { maxShipHS, rating } of [...cloaks].reverse()) {', fails: ['cross-section: the last covering cloak'] },
  { name: 'a cloak covering only a larger class', file: 'design-rules.js', find: 'if (maxShipHS >= sizeHS) {', replace: 'if (maxShipHS > sizeHS) {', fails: ['cross-section: a cloak covers'] },
  { name: 'any cloak covering the class', file: 'design-rules.js', find: 'if (maxShipHS >= sizeHS) {', replace: 'if (true) {', fails: ['cross-section: a cloak covers', 'cross-section: a class without a cloak'] },
  { name: 'the shield EM multiplier of 3', file: 'design-rules.js', find: 'export const SHIELD_EM_MULTIPLIER = 30', replace: 'export const SHIELD_EM_MULTIPLIER = 3', fails: ['em: shields'] },
  { name: 'an active sensor emission with no minimum of 1', file: 'design-rules.js', find: 'Math.max(1, Math.trunc(strength)', replace: 'Math.max(0, Math.trunc(strength)', fails: ['em: an active sensor'] },
  { name: 'an active sensor emission without the whole numbers', file: 'design-rules.js', find: 'Math.trunc(strength) * Math.trunc(resolution)', replace: 'strength * resolution', fails: ['em: an active sensor'] },
  { name: 'the active range cut by the ratio, not its square', file: 'design-rules.js', find: '(signature / resolution) ** 2', replace: '(signature / resolution)', fails: ['cross-section: active reach'] },
  { name: 'idle thermal shown as 0', file: 'signatures.js', find: 'thermalSignature({ enginePower: 0, stealthRating: 1, fraction: 0, sizeHS })', replace: '0', fails: ['thermal: idle', 'thermal: the speed curve'] },
  { name: 'a class with no engine showing the floor while moving', file: 'signatures.js', find: 'value: 0, inputs: { present: [\'class size\'] }, assumptions: [\'the class has no engine', replace: 'value: sizeHS / 20, inputs: { present: [\'class size\'] }, assumptions: [\'the class has no engine', fails: ['thermal: a class with no engine'] },
  { name: 'a speed share of 0 accepted', file: 'signatures.js', find: 'if (!(percent > 0 && percent <= 100)) {', replace: 'if (!(percent >= 0 && percent <= 100)) {', fails: ['thermal: speed shares that cannot be read'] },
  { name: 'a speed share of up to 1,000 % accepted', file: 'signatures.js', find: 'percent <= 100)) {', replace: 'percent <= 1000)) {', fails: ['thermal: speed shares that cannot be read'] },
  { name: 'the speed shares not sorted', file: 'signatures.js', find: 'Object.freeze([...fractions].sort((a, b) => a - b))', replace: 'Object.freeze([...fractions])', fails: ['thermal: speed shares read'] },
  { name: 'full speed not always a share', file: 'signatures.js', find: 'new Set([0, 1])', replace: 'new Set([0])', fails: ['thermal: speed shares read'] },
  { name: 'a mixed class not estimated', file: 'signatures.js', find: 'if (designs <= 1 || !isAvailable(result)) {', replace: 'if (true) {', fails: ['mixed: a mixed class'] },
  { name: 'engine designs counted by rows', file: 'signatures.js', find: 'new Set(engines.map((engine) => engine.id)).size', replace: 'engines.length', fails: ['mixed: a mixed class'] },
  { name: 'the uncloaked cross-section taken as the effective one', file: 'signatures.js', find: 'const uncloaked = sizeKnown ? ofRule({ rule, value: classCrossSection({ sizeHS: cls.sizeHS, sensorReduction: 1 })', replace: 'const uncloaked = sizeKnown ? ofRule({ rule, value: effective.value', fails: ['cross-section: effective and uncloaked', 'cross-section: the effective cross-section is the stored', 'cross-section: the floor'] },
  { name: 'the uncloaked cross-section lost with the cloak figures', file: 'signatures.js', find: 'const uncloaked = sizeKnown ?', replace: 'const uncloaked = sizeKnown && reduction !== null ?', fails: ['cross-section: a cloak with unknown figures', 'cross-section: a class that stores no cross-section'] },
  { name: 'every class marked cloaked', file: 'signatures.js', find: 'storedReduction.value < 1 :', replace: 'storedReduction.value <= 1 :', fails: ['cross-section: a class without a cloak'] },
  { name: 'the effective cross-section taken from the rebuilt figure', file: 'signatures.js', find: 'const effective = isAvailable(stored) ? stored : standIn', replace: 'const effective = standIn', fails: ['cross-section: the effective cross-section is the stored', 'cross-section: a cloak with unknown figures'] },
  { name: 'the rebuilt cross-section used when the stored one is known and differs', file: 'signatures.js', find: 'const effective = isAvailable(stored) ? stored : standIn', replace: 'const effective = isAvailable(rebuilt) ? standIn : stored', fails: ['cross-section: the effective cross-section is the stored'] },
  { name: 'the shield EM taken as the strength', file: 'signatures.js', find: 'value: shieldEmission({ shieldStrength: cls.stored.shieldStrength })', replace: 'value: cls.stored.shieldStrength', fails: ['em: shields'] },
  { name: 'a class without shields unknown', file: 'signatures.js', find: 'isNumber(cls.stored.shieldStrength) ? ofRule', replace: 'isNumber(cls.stored.shieldStrength) && cls.stored.shieldStrength > 0 ? ofRule', fails: ['em: no shields'] },
  { name: 'the active sensor emissions summed', file: 'signatures.js', find: 'compute: (values) => Math.max(...Object.values(values))', replace: 'compute: (values) => Object.values(values).reduce((total, value) => total + value, 0)', fails: ['em: each active sensor'] },
  { name: 'a class without an active sensor unknown', file: 'signatures.js', find: ': ofRule({ rule, value: 0, inputs: { present: [\'active sensors\'] }, assumptions: [\'the class has no active sensor\'] })', replace: ': unavailable({ rule, missing: [\'an active sensor\'] })', fails: ['em: no shields'] },
  { name: 'a sensor design counted once per row', file: 'signatures.js', find: '[...new Map(cls.activeSensors.map((sensor) => [sensor.id, sensor])).values()]', replace: 'cls.activeSensors', fails: ['em: each active sensor'] },
  { name: 'a reach that keeps no provenance of its figures', file: 'signatures.js', find: 'Object.keys(lent).length ? combine(', replace: 'false ? combine(', fails: ['range: a reach lends'] },
  { name: 'the range curve not sorted', file: 'signatures.js', find: '.sort((a, b) => a - b)\n\n// The range of each sensor', replace: '\n\n// The range of each sensor', fails: ['range: the curve'] },
  { name: 'a point for a sensor of unknown sensitivity', file: 'signatures.js', find: '.filter((row) => isAvailable(row.ranges[index].result))', replace: '.filter(() => true)', fails: ['range: the curve'] },
  { name: 'a hard-coded cost factor of 1.25', file: 'signatures.js', find: 'thermalCost: level.costFactor', replace: 'thermalCost: 1.25', fails: ['reduction: the cost factor'] },
  { name: 'the multiplier of the level ignored', file: 'signatures.js', find: 'thermalTech: level.multiplier, thermalCost', replace: 'thermalTech: 1, thermalCost', fails: ['reduction: each level', 'reduction: the cost factor'] },
  { name: 'the engine and fuel techs swapped', file: 'signatures.js', find: 'engineTech, fuelTech, thermalTech: level.multiplier', replace: 'engineTech: fuelTech, fuelTech: engineTech, thermalTech: level.multiplier', fails: ['reduction: each level', 'reduction: the cost factor'] },
  { name: 'the current level never marked', file: 'signatures.js', find: 'const current = cls.engines.every((engine) => engine.techIds.thermal === level.id)', replace: 'const current = false', fails: ['reduction: each level'] },
  { name: 'the class engine cost without the engine count', file: 'signatures.js', find: 'value: costs[index].value * entry.engine.count', replace: 'value: costs[index].value', fails: ['reduction: the cost factor', 'reduction: the class cost'] },
  { name: 'the thermal of a level without the engine count', file: 'signatures.js', find: 'value: entry.design.thermal * entry.engine.count', replace: 'value: entry.design.thermal', fails: ['reduction: each level', 'reduction: the class cost'] },
  { name: 'a missing fuel tech row filled in', file: 'signatures.js', find: 'const fuelTech = techFigure(techs, engine.techIds.fuel)', replace: 'const fuelTech = techFigure(techs, engine.techIds.fuel) ?? 0.2', fails: ['reduction: a level whose tech row'] },
  { name: 'the cost factor of a level read as 1.25 by the loader', file: 'design-data.js', find: 'costFactor: row.AdditionalInfo2', replace: 'costFactor: 1.25', fails: ['reduction (save): the levels'] },
  { name: 'the multiplier of a level read from the cost factor', file: 'design-data.js', find: 'multiplier: row.AdditionalInfo,', replace: 'multiplier: row.AdditionalInfo2,', fails: ['reduction (save): the levels'] },
  { name: 'the thermal rating of an engine not read', file: 'design-data.js', find: 'thermalRating: part.StealthRating', replace: 'thermalRating: 1', fails: ['saves: ClassThermal'] },
  { name: 'the count of a component not read', file: 'design-data.js', find: 'count: row.NumComponent })', replace: 'count: 1 })', fails: ['saves: ClassThermal'] },
  { name: 'the largest ship of a cloak read from its size', file: 'design-data.js', find: 'maxShipHS: part.ComponentValue', replace: 'maxShipHS: part.Size', fails: ['saves: ClassThermal'] },
  { name: 'the classes of every race read', file: 'design-data.js', find: 'where sc.GameID = :GameID and sc.RaceID = :RaceID order by sc.ClassName', replace: 'where sc.GameID = :GameID order by sc.ClassName', fails: ['saves: ClassThermal'] },
  { name: 'the engine and fuel tech types swapped', file: 'design-data.js', find: 'engine: techIdOfType(part, techTypes, ENGINE_TECH_TYPE), fuel: techIdOfType(part, techTypes, FUEL_TECH_TYPE)', replace: 'engine: techIdOfType(part, techTypes, FUEL_TECH_TYPE), fuel: techIdOfType(part, techTypes, ENGINE_TECH_TYPE)', fails: ['reduction (save): an engine'] },
  { name: 'the levels ordered by the development cost column of the table', file: 'design-data.js', find: 'order by DevelopCost, t.TechSystemID', replace: 'order by t.DevelopCost, t.TechSystemID', fails: ['reduction (missing column): a save without'] },
  { name: 'the levels not ordered by id on a tie', file: 'design-data.js', find: 'order by DevelopCost, t.TechSystemID', replace: 'order by DevelopCost', fails: ['reduction (missing column): the levels come'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the obsolete flag of a level read by its table column', file: 'design-data.js', find: "${selectedColumns('r', raceTechColumns, ['Obsolete'])}", replace: 'r.Obsolete as Obsolete', fails: ['reduction (missing column): a save without'] },
  { name: 'the obsolete flag listed as a read of /sensors', file: 'capability-reads.js', find: "tech: { label: 'the tech', reads: 'DIM_TechType(Description FieldID TechTypeID) FCT_EligibleProjects(GameID RaceID TechSystemID) FCT_PausedResearch(GameID PointsAccumulated RaceID TechSystemID) FCT_Population(PopulationID RaceID) FCT_RaceTech(GameID RaceID TechID)", replace: "tech: { label: 'the tech', reads: 'DIM_TechType(Description FieldID TechTypeID) FCT_EligibleProjects(GameID RaceID TechSystemID) FCT_PausedResearch(GameID PointsAccumulated RaceID TechSystemID) FCT_Population(PopulationID RaceID) FCT_RaceTech(GameID Obsolete RaceID TechID)", fails: ['capability: /sensors is supported'] },
  { name: 'the class name not listed as a read of /sensors', file: 'capability-reads.js', find: 'FCT_ClassComponent(ClassID ComponentID GameID NumComponent) FCT_ShipClass(ClassName GameID RaceID ShipClassID)', replace: 'FCT_ClassComponent(ClassID ComponentID GameID NumComponent) FCT_ShipClass(GameID RaceID ShipClassID)', fails: ['capability: /sensors is unsupported'] },
  { name: 'the passive sensors read with a fire control column the page does not use', file: 'design-data.js', find: 'FCT_ShipDesignComponents.ComponentValue from FCT_ShipDesignComponents inner join', replace: 'FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.FCRangeModifier from FCT_ShipDesignComponents inner join', fails: ['loaders: the three reads'] },
  { name: 'the passive sensors read with the active sensors', file: 'design-data.js', find: 'const PASSIVE_SENSOR_TYPE_IDS = Object.freeze([SENSOR_COMPONENT_TYPES.thermal, SENSOR_COMPONENT_TYPES.em])', replace: 'const PASSIVE_SENSOR_TYPE_IDS = Object.freeze([SENSOR_COMPONENT_TYPES.thermal, SENSOR_COMPONENT_TYPES.em, SENSOR_COMPONENT_TYPES.active])', fails: ['loaders: the three reads'] },
  { name: 'the passive sensors of every race read', file: 'design-data.js', find: 'and FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID = :race order by FCT_ShipDesignComponents.SDComponentID`, { replacements: { game, race } })\n\n  return rows\n}\n\nconst wholeIds', replace: 'and FCT_RaceTech.GameID = :game order by FCT_ShipDesignComponents.SDComponentID`, { replacements: { game } })\n\n  return rows\n}\n\nconst wholeIds', fails: ['loaders: the three reads'] },
]

const parseArguments = (argv) => {
  const options = { mutations: true }

  for (const argument of argv) {
    if (argument === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argument}`)
      process.exit(2)
    }
  }

  return options
}

const isSkip = (result) => result !== null && typeof result === 'object' && typeof result.skipped === 'string'

// One check on the modules given: 'pass', 'fail' (with the reason) or 'skip' (with the reason), and the lines it reports.
const attempt = async (entry, m) => {
  try {
    const result = await entry.run(m)

    return isSkip(result) ? { state: 'skip', reason: result.skipped } : { state: 'pass', lines: (result && result.lines) || [] }
  } catch (error) {
    return { state: 'fail', reason: String(error.message).split('\n').join(' | ') }
  }
}

let failures = 0
let passed = 0
let skips = 0

const report = (state, name, detail = '') => {
  if (state === 'skip') {
    skips++
    console.log(`SKIP  ${name}  [${detail}]`)

    return
  }

  if (state === 'pass') {
    passed++
  } else {
    failures++
  }

  console.log(`${state === 'pass' ? 'PASS' : 'FAIL'}  ${name}${state === 'pass' ? '' : `  [${detail}]`}`)
}

// A planted fault: the checks it names run on the faulty copy, and each name must have a check that fails (or only skipped ones, which skip the fault as well).
const runMutation = async (mutation) => {
  let m

  try {
    m = await loadAll(mutation)
  } catch (error) {
    return { state: 'fail', reason: `does not load: ${error.message}` }
  }

  const missed = []
  let caught = 0

  for (const start of mutation.fails) {
    const named = checks.filter((entry) => entry.name.startsWith(start))

    if (!named.length) {
      return { state: 'fail', reason: `no check begins "${start}"` }
    }

    const outcomes = []

    for (const entry of named) {
      outcomes.push(await attempt(entry, m))
    }

    if (outcomes.some((outcome) => outcome.state === 'fail')) {
      caught++
    } else if (!outcomes.every((outcome) => outcome.state === 'skip')) {
      missed.push(start)
    }
  }

  if (missed.length) {
    return { state: 'fail', reason: `these checks did not fail: ${missed.join('; ')}` }
  }

  return caught ? { state: 'pass', detail: `${caught} of the ${mutation.fails.length} names it gives fail` } : { state: 'skip', reason: 'the checks it names read a save that is not there' }
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  await openSaves()
  console.log(`Saves read: ${SAVES.length ? SAVES.map((save) => save.file).join(', ') : 'none (saves/ holds no database)'}`)
  console.log('Signatures: thermal, range, mixed engines, cross-section, thermal reduction, EM and the saves')

  const real = await loadAll()

  for (const entry of checks) {
    const outcome = await attempt(entry, real)

    report(outcome.state, entry.name, outcome.reason)
    ;(outcome.lines || []).forEach((line) => console.log(`        ${line}`))
  }

  if (options.mutations) {
    console.log('\nMutations: each planted fault must fail the checks it names')

    for (const mutation of MUTATIONS) {
      const outcome = await runMutation(mutation)

      if (outcome.state === 'pass') {
        passed++
        console.log(`PASS  mutation caught: ${mutation.name}  [${outcome.detail}]`)
      } else {
        report(outcome.state, `mutation caught: ${mutation.name}`, outcome.reason)
      }
    }
  }

  SAVES.forEach((save) => save.close())
  console.log(`\n${passed} of ${passed + failures} checks passed${skips ? `, ${skips} skipped (the save they read is not there)` : ''}`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
