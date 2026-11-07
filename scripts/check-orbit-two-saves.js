/*
  Measures the real orbital propagation against an ancestral pair of played saves of one campaign, matched by SystemBodyID only after validating the complete ledger prefix, without changing either save. --from and --to name A, B, C1 or C2 for the four calibrated orbit-pair saves of the registry (A and B, then the parallel branches C1 and C2 from B; the registry also holds D1 and its sibling, outside this pair witness), or the path of a save relative to the repository root, whose game is the one with the latest clock. Defaults remain A-B. The gate reads A-B, B-C1, A-C1, B-C2 and A-C2 at the fixture-calibrated forced-update level differences 1, 1, 2, 2 and 3; C1-C2 is not an ancestral pair. Missing saves print SKIP and exit 0. --no-mutations runs the head only; --json prints every body's residual as well as the summary. A finding exits 1, never becomes a wider tolerance.

  Snapshots reach the later save's GameTime from the earlier save's baseline: full elapsed circular/moon-own bearings, whole eccentric calls plus a local remainder, never movement-phase calls. The private stateAt and clockOf seams are exported only in the loaded source copy. horizon:false measures short-period bodies too, without changing the arithmetic or MAX_CALLS; out-of-horizon measurements and every other refusal remain disclosed. All campaign systems are read, not just the race's surveyed subset.

  Fixture levels are calibration compatible with the game's rules from raw saved bearings and GameTime, not historical load counts or proof of a unique past. --load-count=N is an explicit nonnegative integer scenario override, never canonical gate evidence. An unregistered pair without an override remains numerical evidence-only. Ordinary played updates may partition increments at any positive integer-second lengths; neither endpoint's stored cadence/mode nor automatic selection reconstructs that history. The game forces a 60-second orbital update when loading without advancing GameTime. Product residuals never insert those loads; only circular/moon-own conditional bearings use their placement-independent total. Eccentric bounds carry the extra time without inventing a replay order. The model assumes enabled orbital motion throughout and uniform global forced updates, not an absence of unrecorded edits or switching proved by the endpoints. Diameter-capped bounds are uninformative, not trajectory confirmation. The old one-metre coordinate counts remain diagnostics only.
*/
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { PLAYED, PLAYED_NEXT, PLAYED_C1, PLAYED_C2 } = require('./lib/fixtures')
const { loadUtilities } = require('./lib/utilities')
const { runChild, lastJson } = require('./lib/check-pool')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const sourceFile = path.join(root, 'src/renderer/utilities/orbit-propagation.js')
const KM = 149600000
const ROUNDING_KM = 0.001
const U = 2 ** -53
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

// The four calibrated orbit-pair saves of the registry, lettered as docs/WORKFLOW.md and the played-save entries of scripts/check-capabilities.js name them (C1 and C2 the two branches from B; the registry also holds D1 and its sibling, outside this pair witness); any other --from or --to value is the path of a save, resolved against the repository root as a fixture's file is.
const SAVES = { A: PLAYED, B: PLAYED_NEXT, C1: PLAYED_C1, C2: PLAYED_C2 }

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

// Bearing-space roundoff of the game's update under the calibrated/scenario uniform-update model, without a historical cadence premise. Each ordinary played call is at least one integer second, so K=T bounds ordinary subtractions; n forced subtractions and W+1 wraps enter separately. Every call is no longer than its completed increment, or 60 seconds for a forced call, giving hMax=max(largest Length,60). Each saved subtraction/wrap has half-ulp scale max(360,incrMax). Three game turn operations cost <= 3u*adv. The app evaluates 360*seconds/(Year*3600), subtracts from a bearing in [0,360), then wraps: the large subtraction has magnitude <= adv+360; the first remainder is <360 in magnitude, +360 is <720, and the final remainder is <360. The combined app arithmetic is covered by 4u*(adv+360), including the <720 addition, rather than pretending the large subtraction rounds only at 360. See AE-310-06-H1 for the accounting; no coordinate tolerance enters this assertion.
const bearingBound = (body, context) => {
  const adv = 360 * (context.elapsed + 60 * context.loadCount) / (body.year * 3600)
  const incrMax = 360 * context.maxSourceCall / (body.year * 3600)
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

const measure = async (pair, loadModel, mutation = null) => {
  const a = readSave(pair.from.fixture)
  const b = readSave(pair.to.fixture)
  const loadCount = loadModel.count
  const inputs = [a, b].map((save, index) => ({ file: save.file, sha256: save.sha256, clock: save.clock, oneSecondSubPulse: save.oneSecondSubPulse, bodies: Object.keys(save.orbits.bodies).length, orbitalWitnessLevel: [pair.from.fixture, pair.to.fixture][index].orbitalWitnessLevel ?? null }))
  const assertions = []
  const check = (id, description, work) => {
    try {
      work()
      assertions.push({ id, description, ok: true })
    } catch (error) {
      assertions.push({ id, description, ok: false, error: error.message })
    }
  }
  const elapsed = b.clock.gameTime - a.clock.gameTime
  const ledger = b.increments.slice(a.increments.length)

  // Refuse branches before matching reused body IDs, loading propagation or planting a mutant. The whole prefix matters, not just equal rows somewhere in the later history.
  check('ledger', 'valid-pair ancestry: the complete earlier ledger is the later prefix and positive integer increments partition an ordered same-game interval', () => {
    assert.equal(a.gameId, b.gameId, 'invalid-pair campaign: both saves must hold the same game')
    assert.ok(Number.isSafeInteger(a.clock.gameTime) && a.clock.gameTime >= 0 && Number.isSafeInteger(b.clock.gameTime) && elapsed > 0, 'invalid-pair chronology: positive ordered integer GameTimes required')
    assert.deepEqual(b.increments.filter((row) => row.GameTime < a.clock.gameTime), a.increments, 'invalid-pair ancestry: the later ledger must preserve the complete earlier (GameTime, Length) prefix')
    assert.equal(a.increments[a.increments.length - 1].GameTime + a.increments[a.increments.length - 1].Length, a.clock.gameTime, 'the earlier ledger must end at its GameTime')
    assert.ok(ledger.length > 0, 'the later ledger must extend the earlier prefix')
    assert.equal(ledger[0].GameTime, a.clock.gameTime, 'the first increment after the prefix must start at the earlier GameTime')
    assert.ok(ledger.every((row) => Number.isSafeInteger(row.GameTime) && Number.isSafeInteger(row.Length) && row.Length > 0), 'every played increment must have a positive finite integer-second length')
    ledger.forEach((row, i) => assert.equal(row.GameTime + row.Length, i + 1 === ledger.length ? b.clock.gameTime : ledger[i + 1].GameTime, 'played increments must partition the interval contiguously'))
  })
  const invalidPair = () => ({ invalidPair: true, inputs, sourceSha256: sha256(sourceFile), loadModel: { ...loadModel, numericalStatus: 'invalid pair; no matching, trajectory computation or mutants' }, assertions })

  if (!assertions[0].ok) {
    return invalidPair()
  }

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
  const length = orbit.callLength(a.clock)
  const calls = Math.floor(elapsed / length)
  const remainder = elapsed - calls * length
  const maximumIncrement = Math.max(...ledger.map((row) => row.Length))
  const context = { elapsed, loadCount, remainder, squaredCalls: calls * length ** 2 + remainder ** 2, squaredIncrements: ledger.reduce((sum, row) => sum + row.Length ** 2, 0), sourceCalls: elapsed, maxSourceCall: Math.max(maximumIncrement, 60) }

  check('cadence', 'enabled endpoint motion and the actual earlier-save forecast fit the inclusive evaluation budget', () => {
    assert.equal(a.clock.orbitalMotion, 1)
    assert.equal(b.clock.orbitalMotion, 1)
    assert.ok(Number.isFinite(length) && length > 0 && calls >= 0 && calls + (remainder > 0 ? 1 : 0) <= orbit.MAX_CALLS)
  })
  if (!assertions[1].ok) {
    return invalidPair()
  }
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
    check('circular-bearing', 'conditional circular bearings fit the roundoff bound of the game\'s update at the fixed calibrated/scenario count without a historical cadence premise', () => assert.equal(bearingFailures('circular').length, 0, `${bearingFailures('circular').length} circular bearings exceed their derived bound`))
    check('moon-bearing', 'conditional moon-own bearings fit the roundoff bound of the game\'s update independently of parent coordinate error', () => assert.equal(bearingFailures('moon').length, 0, `${bearingFailures('moon').length} moon bearings exceed their derived bound`))
    check('eccentric-bound', 'unadjusted product eccentric residuals fit the conditional increment-partition and forced-load-time bound', () => assert.equal(eccentricFailures.length, 0, `${eccentricFailures.length} eccentric residuals exceed their cadence bound`))
  }
  check('trojan-parent', 'predicted and saved trojans follow the parent bearing plus their offset', () => assert.ok(measured('trojan').every((row) => row.parentOffsetDegrees <= 1e-9 && row.savedParentOffsetDegrees <= 1e-9)))
  check('bearing-direction', 'non-aliased circular bearings move clockwise as the game\'s update requires', () => assert.ok(circular.filter((row) => a.orbits.bodies[row.id].year * 3600 > 2 * elapsed).every((row) => row.observedClockwiseDegrees < 180 && row.predictedClockwiseDegrees < 180)))
  check('coverage', 'every common body receives a finite numeric result or an explicit refusal', () => assert.equal(rows.filter((row) => row.refusal || (Number.isFinite(row.residualKm) && Number.isFinite(row.bearingResidualDegrees))).length, common.length))
  const lagGroups = [...new Set(circular.map((row) => `${row.systemId}:${row.starId}`))].map((key) => {
    const members = circular.filter((row) => `${row.systemId}:${row.starId}` === key)

    return { systemId: members[0].systemId, starId: members[0].starId, lagSeconds: distribution(members.map((row) => row.lagSeconds)) }
  })

  return {
    inputs,
    sourceSha256: sha256(sourceFile),
    loadModel,
    cadence: { elapsed, length, calls, remainder, evaluations: calls + (remainder > 0 ? 1 : 0), repeatedSeconds: calls * length, increments: ledger.length, sourceCallUpperBound: context.sourceCalls, maxSourceCall: context.maxSourceCall, squaredCalls: context.squaredCalls, squaredIncrements: context.squaredIncrements, maximumIncrement },
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
    assert.ok(typeof text === 'string' && text.trim() !== '' && !text.startsWith('--'), `--${name} takes A, B, C1, C2 or the path of a save`)

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
  const calibrated = Number.isSafeInteger(pair.from.fixture.orbitalWitnessLevel) && Number.isSafeInteger(pair.to.fixture.orbitalWitnessLevel)
  const loadCount = loadIndex < 0 ? calibrated ? pair.to.fixture.orbitalWitnessLevel - pair.from.fixture.orbitalWitnessLevel : null : Number(loadText)

  assert.ok(loadIndex < 0 || (typeof loadText === 'string' && loadText.trim() !== '' && Number.isSafeInteger(loadCount) && loadCount >= 0), '--load-count requires an explicit nonnegative safe integer; it is never fitted or rounded')
  const loadModel = { count: loadCount, status: loadIndex >= 0 ? 'explicit scenario override; not canonical gate evidence; registry levels unchanged' : calibrated ? 'fixture-calibrated relative forced-update levels; not historical load counts or a unique history' : 'no registered calibration; numerical trajectory comparisons are evidence-only', numericalStatus: loadIndex >= 0 ? 'scenario only; not canonical gate evidence' : calibrated ? 'canonical calibrated orbital-rule consistency assertions' : 'evidence-only' }
  const child = process.argv.find((arg) => arg.startsWith('--child='))

  if (child) {
    const index = Number(child.slice('--child='.length))

    assert.ok(Number.isInteger(index) && index >= 0 && index < MUTANTS.length, 'a declared mutant index is required')
    console.log(`RESULT ${JSON.stringify(await measure(pair, loadModel, MUTANTS[index]))}`)
    return
  }

  const result = await measure(pair, loadModel)

  if (result.invalidPair) {
    console.log('INVALID PAIR: no matching, trajectory computation or mutants')
  } else {
    console.log(`Matched ${result.matched}; skipped ${result.newInTo} bodies new in ${pair.to.label}; absent from ${pair.to.label} ${result.absentFrom}`)
    console.log(`Snapshot: ${result.cadence.calls} whole calls of ${result.cadence.length} s plus ${result.cadence.remainder} s local remainder (${result.cadence.evaluations} evaluations); GameTime epoch; product inserts no loads`)
    console.log(`LOAD MODEL ${JSON.stringify(result.loadModel)}; ordinary update call upper bound K=T=${result.cadence.sourceCallUpperBound}, maximum update call hMax=${result.cadence.maxSourceCall} s; endpoint clock settings are observations, not historical cadence`)
    result.families.forEach((family) => console.log(JSON.stringify(family)))
    Object.entries(result.refusals).forEach(([code, count]) => console.log(`LIMITATION ${count} explicit ${code} refusals; not counted as position matches`))
  }
  const checks = [...result.assertions]
  const mutants = []

  if (!result.invalidPair && mutating()) {
    for (const [index, mutation] of MUTANTS.entries()) {
      const childResult = await runChild(__filename, [`--child=${index}`, ...(loadIndex < 0 ? [] : [`--load-count=${loadCount}`]), ...(from === null ? [] : [`--from=${from}`]), ...(to === null ? [] : [`--to=${to}`])], { limit: 180000 })
      const actual = lastJson(childResult, 'RESULT ')
      const head = result.assertions.find((check) => check.id === mutation.criterion)
      const mutant = actual.assertions.find((check) => check.id === mutation.criterion)
      const ok = childResult.code === 0 && head && head.ok && mutant && !mutant.ok

      const entry = { id: `mutant-${index}`, description: mutation.name, ok: !!ok, criterion: mutation.criterion, childCode: childResult.code, head, mutant, failures: mutation.criterion === 'eccentric-bound' ? actual.eccentricBounds.failures : actual.families.find((family) => family.family === 'circular').conditionalBearing?.failures, status: loadCount === null ? 'diagnostic; no numerical credit without calibrated/scenario load model' : ok ? 'head-true/mutant-false conditional credit' : 'not credited', error: ok || loadCount === null ? undefined : `no independent credit: head ${JSON.stringify(head)}, mutant ${JSON.stringify(mutant)}` }

      mutants.push(entry)
      if (loadCount !== null) {
        checks.push(entry)
      } else {
        console.log(`DIAGNOSTIC ${mutation.name}: numerical mutant credit absent without fixture calibration or --load-count scenario`)
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
