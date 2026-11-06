/*
  Measures the real orbital propagation against a pair of played saves of one campaign, matched by SystemBodyID, without changing either save. --from and --to name the pair: A, B or C for the three registered saves, or the path of a save relative to the repository root, whose game is the one with the latest clock. The defaults are A and B, the pair this check was written for; B-C is a second witness on the same terms and A-C spans two loads. Missing saves print SKIP and exit 0. --no-mutations runs the head only; --json prints every body's residual as well as the summary. A finding exits 1, never becomes a wider tolerance.

  Snapshots reach the later save's GameTime from the earlier save's baseline: full elapsed circular/moon-own bearings, whole eccentric calls plus a local remainder, never movement-phase calls. The private stateAt and clockOf seams are exported only in the loaded source copy. horizon:false measures short-period bodies too, without changing the arithmetic or MAX_CALLS; out-of-horizon measurements and every other refusal remain disclosed. All campaign systems are read, not just the race's surveyed subset.

  --load-count=N explicitly supplies a nonnegative integer inferred load-history assumption, not a stored fact or a fitted value. Without it the numerical pair comparisons are evidence-only. Conditional bearing assertions assume automatic source sub-pulse selection (an unsaved manual override cannot be excluded). The source load path forces 60 seconds without advancing GameTime. Product residuals never insert those loads; only circular/moon-own conditional bearings use their placement-independent total. Eccentric bounds carry the extra time without inventing a replay order. Diameter-capped bounds are uninformative, not trajectory confirmation. The old one-metre coordinate counts remain diagnostics only.
*/
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { PLAYED, PLAYED_NEXT, PLAYED_THIRD } = require('./lib/fixtures')
const { loadUtilities } = require('./lib/utilities')
const { runChild, lastJson } = require('./lib/check-pool')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const sourceFile = path.join(root, 'src/renderer/utilities/orbit-propagation.js')
const KM = 149600000
const ROUNDING_KM = 0.001
const U = 2 ** -53
const MAX_SOURCE_CALL = 21600
const FAMILIES = ['fixed', 'circular', 'moon', 'trojan', 'eccentric', 'unsupported']
const IMMUTABLE = ['systemId', 'starId', 'bodyClass', 'trojan', 'distance', 'year', 'eccentricity', 'direction', 'parentId', 'parentType', 'fixed', 'fixedParentId']
const MUTANTS = [
  { name: 'epoch from LastGrowthTime', anchor: 'return clock && isNumber(clock.gameTime) ? clock : null', replacement: 'return clock && isNumber(clock.gameTime) ? { ...clock, gameTime: clock.lastGrowthTime } : null', criterion: 'circular-bearing' },
  { name: 'ratio dropped (mean speed only)', anchor: 'const turn = (deltaSeconds / (body.year * 3600)) * (current / mean)', replacement: 'const turn = (deltaSeconds / (body.year * 3600)) * 1', criterion: 'eccentric-bound' },
  { name: 'old 561600 s whole steps', anchor: 'const call = length', replacement: 'const call = 561600', criterion: 'eccentric-bound', wholeSteps: true },
]

const point = (body) => ({ Xcor: body.xcor, Ycor: body.ycor })
const distance = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)
const signed = (degrees) => ((degrees % 360) + 540) % 360 - 180
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil((values.length - 1) * p)] : null
const distribution = (values) => ({ count: values.length, max: values.length ? Math.max(...values) : null, p50: percentile(values, 0.5), p95: percentile(values, 0.95) })
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// The registered saves of the campaign, lettered as docs/WORKFLOW.md and the played-save entries of scripts/check-capabilities.js name them; any other --from or --to value is the path of a save, resolved against the repository root as a fixture's file is.
const SAVES = { A: PLAYED, B: PLAYED_NEXT, C: PLAYED_THIRD }

const readSave = (fixture) => {
  const file = path.resolve(root, fixture.file)
  const database = new Database(file, { readonly: true })

  try {
    const games = database.query('select GameID, GameTime, LastGrowthTime, OrbitalMotion, OrbitalMovementInSubPulse, SubPulseLength, OneSecondSubPulse from FCT_Game').all()
    // A registered save names its game; a save named by path holds the game it was played in, which is the one with the latest clock, since a new game beside it sits at time zero.
    const game = fixture.gameId === null ? games.sort((one, other) => other.GameTime - one.GameTime || other.GameID - one.GameID)[0] : games.find((candidate) => candidate.GameID === fixture.gameId)

    assert.ok(game, 'the named game is present in the save')
    const increments = database.query('select GameTime, Length from FCT_Increments where GameID = ? order by GameTime').all(game.GameID)
    const rows = database.query('select SystemBodyID, SystemID, StarID, BodyClass, TrojanAsteroid, OrbitalDistance, Bearing, Year, Eccentricity, EccentricityDirection, ParentBodyID, ParentBodyType, FixedBody, FixedBodyParentID, Xcor, Ycor from FCT_SystemBody where GameID = ? order by SystemBodyID').all(game.GameID)
    const stars = database.query('select StarID, ComponentNumber, Xcor, Ycor from FCT_Star where GameID = ?').all(game.GameID)
    const bodies = Object.fromEntries(rows.map((row) => [row.SystemBodyID, { id: row.SystemBodyID, systemId: row.SystemID, starId: row.StarID, bodyClass: row.BodyClass, trojan: row.TrojanAsteroid, distance: row.OrbitalDistance, bearing: row.Bearing, year: row.Year, eccentricity: row.Eccentricity, direction: row.EccentricityDirection, parentId: row.ParentBodyID, parentType: row.ParentBodyType, fixed: row.FixedBody, fixedParentId: row.FixedBodyParentID, xcor: row.Xcor, ycor: row.Ycor }]))
    const latest = increments[increments.length - 1]

    assert.ok(latest, 'the campaign clock and increment ledger are present')

    return { file: fixture.file, gameId: game.GameID, sha256: sha256(file), oneSecondSubPulse: game.OneSecondSubPulse, clock: { gameTime: game.GameTime, lastGrowthTime: game.LastGrowthTime, orbitalMotion: game.OrbitalMotion, orbitalMovementInSubPulse: game.OrbitalMovementInSubPulse, subPulseLength: game.SubPulseLength, incrementLength: latest.Length }, increments, orbits: { bodies, stars: Object.fromEntries(stars.map((row) => [row.StarID, { id: row.StarID, component: row.ComponentNumber, xcor: row.Xcor, ycor: row.Ycor }])), hidden: {} } }
  } finally {
    database.close()
  }
}

// Automatic selection, IncrementManager.cs 55-122; Game.cs 23616-23618 selects one second for a five-second increment with OneSecondSubPulse. Under automatic selection a shortened saved increment cannot imply more calls than Length/s(Length), since s is non-decreasing (the five-second override is the minimum). The source maximum is 21600, not the largest pulse implied by this shortened ledger.
const sourcePulse = (length, oneSecond) => length === 5 && oneSecond === 1 ? 1 : length < 61 ? 5 : length < 201 ? 10 : length < 401 ? 20 : length < 1201 ? 60 : length < 3601 ? 120 : length < 10801 ? 360 : length < 28801 ? 900 : length < 86401 ? 1800 : length < 432001 ? 7200 : 21600

// Bearing-space source roundoff, conditional on the stated automatic pulse and load model. Each saved subtraction/wrap has half-ulp scale max(360,incrMax); K bounds ordinary subtractions, n forced subtractions, and W+1 the wraps. Three game turn operations cost <= 3u*adv. The app evaluates 360*seconds/(Year*3600), subtracts from a bearing in [0,360), then wraps: the large subtraction has magnitude <= adv+360; the first remainder is <360 in magnitude, +360 is <720, and the final remainder is <360. The combined app arithmetic is covered by 4u*(adv+360), including the <720 addition, rather than pretending the large subtraction rounds only at 360. See the evidence for the operation accounting and premises; no coordinate tolerance enters this assertion.
const bearingBound = (body, context) => {
  const adv = 360 * (context.elapsed + 60 * context.loadCount) / (body.year * 3600)
  const incrMax = 360 * MAX_SOURCE_CALL / (body.year * 3600)
  const halfUlp = 2 ** (Math.floor(Math.log2(Math.max(360, incrMax))) - 53)
  const wraps = Math.floor(adv / 360) + 1

  return { degrees: (context.sourceCalls + context.loadCount + wraps + 1) * halfUlp + 3 * U * adv + 4 * U * (adv + 360), adv, halfUlp, wraps }
}

// For theta in radians, |d position/d theta| <= a P, q = current/mean lies in [qmin,qmax], and |dq/d theta| <= Lq. The scalar time coordinate |F'|=1/(w q) gives local Euler time error <= w Lq (qmax/qmin)^2 h^2 / 2. Sum both schedules' errors, including the app's final partial and n forced 60-second calls. The first-order 60*n term is time absent from the product, independent of the loads' placement. Played calls partition each contiguous saved increment, so sum(h^2) <= sum(Length^2). The old dropped-remainder term is gone.
const cadenceBound = (body, context) => {
  const e = Math.abs(body.eccentricity)
  const P = Math.sqrt(1 + (e * e / (2 * (1 - e * e))) ** 2)
  const qmin = Math.sqrt((1 - e) / (1 + e))
  const qmax = 1 / qmin
  const Lq = P / (qmin * (1 - e) ** 2)
  const w = 2 * Math.PI / (body.year * 3600)
  const drift = w * Lq * (qmax / qmin) ** 2 * (context.squaredCalls + context.squaredIncrements + context.loadCount * 60 ** 2) / 2
  const diameter = 2 * body.distance * KM
  const raw = body.distance * KM * P * w * qmax * (60 * context.loadCount + drift)

  return { km: Math.min(diameter, raw) + ROUNDING_KM, informative: raw < diameter }
}

const measure = async (pair, loadCount, mutation = null) => {
  const a = readSave(pair.from.fixture)
  const b = readSave(pair.to.fixture)
  let source = fs.readFileSync(sourceFile, 'utf8').replace(/\r\n/g, '\n')

  if (mutation) {
    refusePlanting(mutation.name)
    source = patched(sourceFile, source, mutation.anchor, mutation.replacement)

    if (mutation.wholeSteps) {
      source = patched(sourceFile, source, 'while (calls.length <= whole)', 'while (calls.length <= Math.floor(seconds / call))')
      source = patched(sourceFile, source, 'bearing = calls[whole]', 'bearing = calls[Math.floor(seconds / call)]')
      source = patched(sourceFile, source, 'if (remainder > 0) {', 'if (false) {')
    }
  }

  const orbit = (await loadUtilities(['orbit-propagation'], { sources: { 'orbit-propagation': `${source}\nexport { stateAt, clockOf };\n` } }))['orbit-propagation']
  const elapsed = b.clock.gameTime - a.clock.gameTime
  const length = orbit.callLength(a.clock)
  const calls = Math.floor(elapsed / length)
  const ledger = b.increments.filter((row) => row.GameTime >= a.clock.gameTime && row.GameTime < b.clock.gameTime)
  const remainder = elapsed - calls * length
  const context = { elapsed, loadCount, remainder, squaredCalls: calls * length ** 2 + remainder ** 2, squaredIncrements: ledger.reduce((sum, row) => sum + row.Length ** 2, 0), sourceCalls: ledger.reduce((sum, row) => sum + row.Length / sourcePulse(row.Length, a.oneSecondSubPulse), 0) }
  const assertions = []
  const check = (id, description, work) => {
    try {
      work()
      assertions.push({ id, description, ok: true })
    } catch (error) {
      assertions.push({ id, description, ok: false, error: error.message })
    }
  }

  check('ledger', 'saved increments exactly partition the clock interval', () => {
    assert.ok(ledger.length > 0)
    assert.equal(a.gameId, b.gameId, 'both saves hold the same game')
    assert.equal(ledger[0].GameTime, a.clock.gameTime)
    ledger.forEach((row, i) => assert.equal(row.GameTime + row.Length, i + 1 === ledger.length ? b.clock.gameTime : ledger[i + 1].GameTime))
    assert.ok(ledger.every((row) => row.Length > 0 && row.Length % sourcePulse(row.Length, a.oneSecondSubPulse) === 0), 'every saved length divides by its source-selected automatic pulse')
  })
  check('cadence', 'both saves have the same enabled orbital cadence, within the exact call budget', () => {
    assert.equal(a.clock.orbitalMotion, 1)
    assert.equal(b.clock.orbitalMotion, 1)
    assert.equal(a.clock.orbitalMovementInSubPulse, b.clock.orbitalMovementInSubPulse)
    assert.equal(a.clock.subPulseLength, b.clock.subPulseLength)
    assert.equal(a.oneSecondSubPulse, b.oneSecondSubPulse)
    assert.ok(length > 0 && calls > 0 && calls + (remainder > 0 ? 1 : 0) <= orbit.MAX_CALLS)
  })
  const common = Object.values(a.orbits.bodies).filter((body) => b.orbits.bodies[body.id])
  const rows = []
  const snapshotClock = orbit.clockOf({ clock: a.clock })
  const snapshotElapsed = b.clock.gameTime - snapshotClock.gameTime

  for (const body of common) {
    const next = b.orbits.bodies[body.id]
    const family = body.fixed > 0 ? 'fixed' : orbit.familyOf(body) || 'unsupported'
    const row = { id: body.id, systemId: body.systemId, starId: body.starId, family, changedFields: IMMUTABLE.filter((key) => body[key] !== next[key]) }
    // A separate cache owner per body bounds memory: no 17,113-element eccentric table is retained for every body in the campaign at once. A moon/trojan still shares its parent's real calls within this evaluation.
    const orbits = { ...a.orbits }

    try {
      const rebuilt = family === 'fixed' ? { ...point(body), bearing: body.bearing } : orbit.stateAt(orbits, snapshotClock, body.id, 0, { horizon: false })
      const state = family === 'fixed' ? rebuilt : orbit.stateAt(orbits, snapshotClock, body.id, snapshotElapsed, { horizon: false })

      row.rebuildKm = distance(rebuilt, point(body))
      row.residualKm = distance(state, point(next))
      row.coordinatesIdentical = Object.is(body.xcor, next.xcor) && Object.is(body.ycor, next.ycor)
      row.bearingResidualDegrees = signed(state.bearing - next.bearing)
      row.observedClockwiseDegrees = ((body.bearing - next.bearing) % 360 + 360) % 360
      row.predictedClockwiseDegrees = ((body.bearing - state.bearing) % 360 + 360) % 360

      if (family === 'circular' || family === 'moon') {
        row.lagSeconds = row.bearingResidualDegrees * body.year * 3600 / 360
        if (loadCount !== null) {
          const conditional = orbit.stateAt(orbits, snapshotClock, body.id, snapshotElapsed + 60 * loadCount, { horizon: false })
          const bound = bearingBound(body, context)

          row.conditionalBearingResidualDegrees = signed(conditional.bearing - next.bearing)
          row.bearingBoundDegrees = bound.degrees
          row.bearingBoundRatio = Math.abs(row.conditionalBearingResidualDegrees) / bound.degrees
          row.bearingAdvanceDegrees = bound.adv
          row.bearingHalfUlpDegrees = bound.halfUlp
          if (family === 'circular') {
            row.conditionalKm = distance(conditional, point(next))
          }
        }
      }
      if (family === 'moon') {
        const parent = orbit.stateAt(orbits, snapshotClock, body.parentId, snapshotElapsed, { horizon: false })
        const nextParent = b.orbits.bodies[body.parentId]

        row.relativeKm = distance({ Xcor: state.Xcor - parent.Xcor, Ycor: state.Ycor - parent.Ycor }, { Xcor: next.xcor - nextParent.xcor, Ycor: next.ycor - nextParent.ycor })
        row.parentResidualKm = distance(parent, point(nextParent))
        row.lagSeconds = row.bearingResidualDegrees * body.year * 3600 / 360
      } else if (family === 'trojan') {
        const parent = orbit.stateAt(orbits, snapshotClock, body.parentId, snapshotElapsed, { horizon: false })

        row.parentOffsetDegrees = Math.abs(signed(state.bearing - parent.bearing - body.trojan))
        row.savedParentOffsetDegrees = Math.abs(signed(next.bearing - b.orbits.bodies[body.parentId].bearing - body.trojan))
      } else if (family === 'eccentric') {
        const bound = loadCount === null ? null : cadenceBound(body, context)
        const meanBearing = body.bearing - 360 * elapsed / (body.year * 3600)

        if (bound) {
          row.boundKm = bound.km
          row.informativeBound = bound.informative
          row.boundRatio = row.residualKm / bound.km
        }
        row.meanResidualDegrees = signed(meanBearing - next.bearing)
        row.ratioCorrectionDegrees = signed(state.bearing - meanBearing)
        row.ratioSignAgrees = Math.sign(-row.meanResidualDegrees) === Math.sign(row.ratioCorrectionDegrees)
      }
    } catch (error) {
      if (!error.unsupported) {
        throw error
      }

      row.refusal = error.code
    }

    rows.push(row)
  }

  const measured = (family) => rows.filter((row) => row.family === family && !row.refusal)
  const circular = measured('circular')
  const moons = measured('moon')
  const eccentric = measured('eccentric')
  const roundingFailures = (family, field = 'residualKm') => measured(family).filter((row) => row[field] > ROUNDING_KM)
  const eccentricFailures = eccentric.filter((row) => !Number.isFinite(row.boundKm) || row.residualKm > row.boundKm)
  const bearingFailures = (family) => measured(family).filter((row) => !Number.isFinite(row.bearingBoundDegrees) || !Number.isFinite(row.conditionalBearingResidualDegrees) || Math.abs(row.conditionalBearingResidualDegrees) > row.bearingBoundDegrees)

  check('orbit-fields', 'every matched body keeps the same orbit fields', () => assert.equal(rows.filter((row) => row.changedFields.length).length, 0))
  check('primary-stars', 'matched primary star positions are unchanged', () => assert.ok(Object.values(a.orbits.stars).filter((star) => star.component === 1).every((star) => b.orbits.stars[star.id] && Object.is(star.xcor, b.orbits.stars[star.id].xcor) && Object.is(star.ycor, b.orbits.stars[star.id].ycor))))
  check('fixed', 'any fixed bodies have bit-identical saved coordinates (zero bodies is unexercised)', () => assert.ok(measured('fixed').every((row) => row.coordinatesIdentical)))
  if (loadCount !== null) {
    check('circular-bearing', 'conditional circular bearings fit the source-arithmetic bound with the supplied inferred load count and automatic pulse selection', () => assert.equal(bearingFailures('circular').length, 0, `${bearingFailures('circular').length} circular bearings exceed their derived bound`))
    check('moon-bearing', 'conditional moon-own bearings fit the source-arithmetic bound independently of parent coordinate error', () => assert.equal(bearingFailures('moon').length, 0, `${bearingFailures('moon').length} moon bearings exceed their derived bound`))
    check('eccentric-bound', 'unadjusted product eccentric residuals fit the conditional increment-partition and forced-load-time bound', () => assert.equal(eccentricFailures.length, 0, `${eccentricFailures.length} eccentric residuals exceed their cadence bound`))
  }
  check('trojan-parent', 'predicted and saved trojans follow the parent bearing plus their offset', () => assert.ok(measured('trojan').every((row) => row.parentOffsetDegrees <= 1e-9 && row.savedParentOffsetDegrees <= 1e-9)))
  check('bearing-direction', 'non-aliased circular bearings move clockwise as the source requires', () => assert.ok(circular.filter((row) => a.orbits.bodies[row.id].year * 3600 > 2 * elapsed).every((row) => row.observedClockwiseDegrees < 180 && row.predictedClockwiseDegrees < 180)))
  check('coverage', 'every common body receives a finite numeric result or an explicit refusal', () => assert.equal(rows.filter((row) => row.refusal || (Number.isFinite(row.residualKm) && Number.isFinite(row.bearingResidualDegrees))).length, common.length))
  const lagGroups = [...new Set(circular.map((row) => `${row.systemId}:${row.starId}`))].map((key) => {
    const members = circular.filter((row) => `${row.systemId}:${row.starId}` === key)

    return { systemId: members[0].systemId, starId: members[0].starId, lagSeconds: distribution(members.map((row) => row.lagSeconds)) }
  })

  return {
    inputs: [a, b].map((save) => ({ file: save.file, sha256: save.sha256, clock: save.clock, oneSecondSubPulse: save.oneSecondSubPulse, bodies: Object.keys(save.orbits.bodies).length })),
    sourceSha256: sha256(sourceFile),
    loadModel: { count: loadCount, status: loadCount === null ? 'absent; numerical trajectory comparisons are evidence-only' : 'inferred explicit input, not stored; no event placement assumed', automaticPulseSelection: 'conditional, not stored; no unsaved manual override assumed', numericalStatus: loadCount === null ? 'evidence-only' : 'conditional source-derived assertions' },
    cadence: { elapsed, length, calls, remainder, evaluations: calls + (remainder > 0 ? 1 : 0), repeatedSeconds: calls * length, increments: ledger.length, sourceCallUpperBound: context.sourceCalls, maxSourceCall: MAX_SOURCE_CALL, squaredCalls: context.squaredCalls, squaredIncrements: context.squaredIncrements, maximumIncrement: Math.max(...ledger.map((row) => row.Length)) },
    matched: common.length,
    newInTo: Object.keys(b.orbits.bodies).filter((id) => !a.orbits.bodies[id]).length,
    absentFrom: Object.keys(a.orbits.bodies).filter((id) => !b.orbits.bodies[id]).length,
    families: FAMILIES.map((family) => ({ family, total: rows.filter((row) => row.family === family).length, refused: rows.filter((row) => row.family === family && row.refusal).length, residualKm: distribution(measured(family).map((row) => row.residualKm)), relativeKm: family === 'moon' ? distribution(moons.map((row) => row.relativeKm)) : undefined, aboveOldMetreDiagnostic: ['circular', 'moon'].includes(family) ? roundingFailures(family, family === 'moon' ? 'relativeKm' : 'residualKm').length : undefined, conditionalBearing: loadCount !== null && ['circular', 'moon'].includes(family) ? { failures: bearingFailures(family).length, ratio: distribution(measured(family).map((row) => row.bearingBoundRatio)), degrees: distribution(measured(family).map((row) => row.bearingBoundDegrees)) } : undefined })),
    circularLagSeconds: distribution(circular.map((row) => row.lagSeconds)),
    circularLagBySystemStar: lagGroups,
    moonLagSeconds: distribution(moons.map((row) => row.lagSeconds)),
    refusals: Object.fromEntries([...new Set(rows.filter((row) => row.refusal).map((row) => row.refusal))].map((code) => [code, rows.filter((row) => row.refusal === code).length])),
    diagnostics: { circularConditionalKm: loadCount === null ? undefined : distribution(circular.map((row) => row.conditionalKm)), circularConditionalAboveOldMetre: loadCount === null ? undefined : circular.filter((row) => row.conditionalKm > ROUNDING_KM).length, measuredEccentricBeyondRoutingHorizon: eccentric.filter((row) => a.orbits.bodies[row.id].year * 3600 <= elapsed).length, fixedTemporalEvidence: measured('fixed').length ? 'exercised' : 'unexercised; no fixed bodies' },
    eccentricBounds: loadCount === null ? { status: 'evidence-only; no load model supplied' } : { failures: eccentricFailures.length, informative: eccentric.filter((row) => row.informativeBound).length, diameterOnly: eccentric.filter((row) => !row.informativeBound).length, ratio: distribution(eccentric.map((row) => row.boundRatio)), informativeRatio: distribution(eccentric.filter((row) => row.informativeBound).map((row) => row.boundRatio)), km: distribution(eccentric.map((row) => row.boundKm)) },
    sample: eccentric.filter((row) => a.orbits.bodies[row.id].year * 3600 > 2 * elapsed && Math.abs(row.meanResidualDegrees) > 0.1).slice(0, 8),
    assertions,
    rows,
  }
}

const main = async () => {
  const options = process.argv.slice(2)
  const argument = (name) => {
    const index = options.findIndex((value) => value === `--${name}` || value.startsWith(`--${name}=`))

    return index < 0 ? null : options[index] === `--${name}` ? options[index + 1] : options[index].slice(name.length + 3)
  }
  // A pair letter names a registered save; any other value is the path of a save, resolved against the repository root as a fixture's file is and read as its game with the latest clock.
  const named = (text, name) => {
    assert.ok(typeof text === 'string' && text.trim() !== '' && !text.startsWith('--'), `--${name} takes A, B, C or the path of a save`)

    return SAVES[text.toUpperCase()] ? { label: text.toUpperCase(), fixture: SAVES[text.toUpperCase()] } : { label: text, fixture: { file: text, gameId: null } }
  }
  const from = argument('from')
  const to = argument('to')
  const pair = { from: named(from === null ? 'A' : from, 'from'), to: named(to === null ? 'B' : to, 'to') }
  const missing = [pair.from.fixture, pair.to.fixture].filter((fixture) => !fs.existsSync(path.resolve(root, fixture.file)))

  if (missing.length) {
    console.log(`SKIP orbit two saves: missing ${missing.map((fixture) => fixture.file).join(', ')} (gitignored played saves); no temporal witness exercised`)
    return
  }

  const loadIndex = options.findIndex((arg) => arg === '--load-count' || arg.startsWith('--load-count='))
  const loadText = loadIndex < 0 ? null : options[loadIndex] === '--load-count' ? options[loadIndex + 1] : options[loadIndex].slice('--load-count='.length)
  const loadCount = loadIndex < 0 ? null : Number(loadText)

  assert.ok(loadIndex < 0 || (typeof loadText === 'string' && loadText.trim() !== '' && Number.isSafeInteger(loadCount) && loadCount >= 0), '--load-count requires an explicit nonnegative safe integer; it is never fitted or rounded')
  const child = process.argv.find((arg) => arg.startsWith('--child='))

  if (child) {
    const index = Number(child.slice('--child='.length))

    assert.ok(Number.isInteger(index) && index >= 0 && index < MUTANTS.length, 'a declared mutant index is required')
    console.log(`RESULT ${JSON.stringify(await measure(pair, loadCount, MUTANTS[index]))}`)
    return
  }

  const result = await measure(pair, loadCount)

  console.log(`Matched ${result.matched}; skipped ${result.newInTo} bodies new in ${pair.to.label}; absent from ${pair.to.label} ${result.absentFrom}`)
  console.log(`Snapshot: ${result.cadence.calls} whole calls of ${result.cadence.length} s plus ${result.cadence.remainder} s local remainder (${result.cadence.evaluations} evaluations); GameTime epoch; product inserts no loads`)
  console.log(`LOAD MODEL ${JSON.stringify(result.loadModel)}; source call upper bound K=${result.cadence.sourceCallUpperBound}, maximum source call ${MAX_SOURCE_CALL} s`)
  result.families.forEach((family) => console.log(JSON.stringify(family)))
  Object.entries(result.refusals).forEach(([code, count]) => console.log(`LIMITATION ${count} explicit ${code} refusals; not counted as position matches`))
  const checks = [...result.assertions]
  const mutants = []

  if (mutating()) {
    for (const [index, mutation] of MUTANTS.entries()) {
      const childResult = await runChild(__filename, [`--child=${index}`, ...(loadCount === null ? [] : [`--load-count=${loadCount}`]), ...(from === null ? [] : [`--from=${from}`]), ...(to === null ? [] : [`--to=${to}`])], { limit: 180000 })
      const actual = lastJson(childResult, 'RESULT ')
      const head = result.assertions.find((check) => check.id === mutation.criterion)
      const mutant = actual.assertions.find((check) => check.id === mutation.criterion)
      const ok = childResult.code === 0 && head && head.ok && mutant && !mutant.ok

      const entry = { id: `mutant-${index}`, description: mutation.name, ok: !!ok, criterion: mutation.criterion, childCode: childResult.code, head, mutant, failures: mutation.criterion === 'eccentric-bound' ? actual.eccentricBounds.failures : actual.families.find((family) => family.family === 'circular').conditionalBearing?.failures, status: loadCount === null ? 'diagnostic; no numerical credit without explicit load model' : ok ? 'head-true/mutant-false conditional credit' : 'not credited', error: ok || loadCount === null ? undefined : `no independent credit: head ${JSON.stringify(head)}, mutant ${JSON.stringify(mutant)}` }

      mutants.push(entry)
      if (loadCount !== null) {
        checks.push(entry)
      } else {
        console.log(`DIAGNOSTIC ${mutation.name}: numerical mutant credit absent without --load-count`)
      }
    }
  }

  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FINDING'} ${check.id}: ${check.description}${check.error ? `: ${check.error}` : ''}`))
  const passed = checks.filter((check) => check.ok).length

  console.log(`REPORT ${JSON.stringify({ ...result, rows: process.argv.includes('--json') ? result.rows : undefined, mutants })}`)
  console.log(`${passed} of ${checks.length} checks passed; ${checks.length - passed} findings; numerical status: ${result.loadModel.numericalStatus}`)
  process.exitCode = passed === checks.length ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
