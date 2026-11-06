/*
  Checks the stabilisation time of the Lagrange page (src/renderer/utilities/lagrange.js `stabilisationMultiplier`, `bestStabilisation` and `stabilisationDays`, and the stabilisation activity of utilities/crew.js `crewEffects`) against the 3.1 rule: a ship with no crew aboard is skipped and contributes nothing, and the duration is capped at Int32.MaxValue seconds before the game converts it to an integer (`Fleet.CalculateGateBuildTime`, `Fleet.CalculateLagrangePointStabilisationTime`; docs `MOVEMENT_AND_LOGISTICS_REFERENCE.md` § Changes since the earlier line, line 918).

  Run: bun scripts/check-lagrange-times.js [--no-mutations]

  Every expected figure is written here from the rule, never read from the module:
  - the multiplier of a ship at its class crew is 2 - its captain's Production bonus, Class Crew / Current Crew times that again while short of crew, and no faster above the class crew;
  - a ship with no crew aboard is not a candidate, whatever its class needs, so a class that needs none but carries none is skipped too: a fleet times at its quickest ready ship whatever zero-crew ships sail with it, and a fleet of zero-crew and damaged ships has no time (no figure, never 0) and names no division by the crew;
  - a current crew that is not in the save is unknown, not crewless, whatever its class needs: a class that needs none with its crew missing gives no time and is disclosed in a mixed fleet as possibly quicker, while its activities that the class never scales keep the share of 1;
  - the duration is 60 / sqrt(mass) months of 30 days times that multiplier, and the game's 32-bit integer time caps it at 2,147,483,647 seconds (24855.13 days): a tiny body or a very short crew gives the cap and never a larger or non-finite figure;
  - on the interim 3.1 fixture (scripts/lib/fixtures.js, game 141, race 784: the values the earlier game stored under the 3.1 schema) every body of the page's list is timed from the save's stored mass, crew and captain's Production bonus read by SQL here, a crew of 0 planted in a copy of the save leaves no ship and no time, and a crew of 1 gives the cap on the light bodies and a figure below it on the heavy ones;
  - the stabilisation activity of a zero-crew ship is blocked at factor 0, never an unsupported figure, a class that needs none whose current crew is missing is unknown there rather than blocked, and the two timing rules and `crew.stabilisation` stand for 3.2.x.
  The fixture holds no zero-crew stabilisation ship of the race (specimen S18 is tier b of AE-310-03), so the zero-crew cases are written into copies of the save here, and the fixture's own stored values are the earlier game's. A save that is not there reads UNSUPPORTED.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const COMPONENT = 29
const PRODUCTION_BONUS = 5
const BASE_DAYS = 60 * 30
const DAY = 86400
// The game's 32-bit integer time: 2,147,483,647 seconds, as the days the page shows.
const CAP_DAYS = 2147483647 / DAY
const PAGE_MASS = 0.25

const FILES = {
  lagrange: path.join(root, 'src', 'renderer', 'utilities', 'lagrange.js'),
  crew: path.join(root, 'src', 'renderer', 'utilities', 'crew.js'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules as shipped, or with edits planted ---------------------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => ({ modules: memo(() => loadUtilities(['lagrange', 'crew', 'provenance'], { sources: { lagrange: texts.lagrange, crew: texts.crew } })) })

// ---- The rows the cases are built from ---------------------------------------------------------------------------
const ship = (overrides = {}) => ({ Damaged: false, CurrentCrew: 100, ClassCrew: 100, ProductionBonus: 1, CaptainName: 'A captain', ...overrides })
const zeroCrew = (overrides = {}) => ship({ CurrentCrew: 0, ...overrides })
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))
const value = (result) => (result && result.status !== 'unavailable' ? result.value : null)

const multiplierOf = (l, row, version = '3.2.x') => l.stabilisationMultiplier(row, version)
const bestOf = (l, rows) => l.bestStabilisation(rows.map((row) => multiplierOf(l, row)))
const daysOf = (l, mass, row, version = '3.2.x') => l.stabilisationDays(mass, multiplierOf(l, row, version).result)

// ---- The fixture, read by SQL, and the copies with a crew planted -------------------------------------------------
const shipSql = `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, Captain.Name as CaptainName, Captain.ProductionBonus, exists (select 1 from FCT_DamagedComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_DamagedComponent.ComponentID where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_ShipDesignComponents.ComponentTypeID = ${COMPONENT}) as Damaged
from FCT_Ship
inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.GameID = FCT_Ship.GameID
inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${COMPONENT}
left join (select FCT_Commander.CommandID, FCT_Commander.Name, FCT_CommanderBonuses.BonusValue as ProductionBonus from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${PRODUCTION_BONUS} where FCT_Commander.GameID = ${GAME} and FCT_Commander.CommandType = 1) as Captain on Captain.CommandID = FCT_Ship.ShipID
where FCT_Ship.GameID = ${GAME} and FCT_Ship.RaceID = ${RACE}
group by FCT_Ship.ShipID
order by FCT_Ship.ShipName`

// The bodies the page lists: the planets and moons of the known systems of the race at 0.25 Earth masses and up, and any body with a Lagrange point. The star read the page also makes is left out (AE-308-02).
const bodySql = `select FCT_SystemBody.SystemBodyID, FCT_SystemBody.Mass
from FCT_SystemBody
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GAME} and FCT_RaceSysSurvey.RaceID = ${RACE}
where FCT_SystemBody.GameID = ${GAME} and FCT_SystemBody.BodyClass in (1, 2) and (FCT_SystemBody.Mass >= ${PAGE_MASS} or FCT_SystemBody.SystemBodyID in (select FCT_LagrangePoint.PlanetID from FCT_LagrangePoint where FCT_LagrangePoint.GameID = ${GAME}))
order by FCT_SystemBody.Mass`

let COPIES = null

const copies = () => {
  if (COPIES) {
    return COPIES
  }

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-lagrange-times-'))
  const original = path.join(root, SAVE)
  const intact = new Database(original, { readonly: true })
  const ships = intact.query(shipSql).all()
  const bodies = intact.query(bodySql).all()

  intact.close()

  if (ships.length !== 1 || !bodies.length) {
    throw new Error(`the fixture ${SAVE} holds ${ships.length} ships of the race with a stabilisation module and ${bodies.length} bodies of the page's list; the check needs one ship and at least one body`)
  }

  const planted = (crew) => {
    const file = path.join(folder, `crew-${crew}.db`)

    fs.copyFileSync(original, file)

    const edit = new Database(file)

    edit.run(`update FCT_Ship set CurrentCrew = ${crew} where ShipID = ${ships[0].ShipID}`)
    edit.close()

    const database = new Database(file, { readonly: true })
    const rows = database.query(shipSql).all()

    database.close()

    return rows
  }

  const opened = { folder, intact: ships, zero: planted(0), one: planted(1), bodies }

  opened.close = () => {
    fs.rmSync(opened.folder, { recursive: true, force: true })
    COPIES = null
  }
  COPIES = opened

  return COPIES
}

// What the rule gives a body for a stored ship row: 60 / sqrt(mass) months of 30 days times the multiplier, capped at the game's 32-bit integer time. The multiplier is written here: 2 - the captain's Production bonus, Class Crew / Current Crew while short of crew.
const oracleMultiplier = (row) => {
  const fraction = row.ClassCrew > 0 ? Math.min(1, Math.max(0, row.CurrentCrew) / row.ClassCrew) : 1

  return (2 - (Number.isFinite(row.ProductionBonus) ? row.ProductionBonus : 1)) / fraction
}

const oracleDays = (row) => (mass) => Math.min((BASE_DAYS / Math.sqrt(mass)) * oracleMultiplier(row), CAP_DAYS)

// ---- The checks -------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('multiplier', 'a ship at its class crew takes 2 minus its captain\'s Production bonus times as long, a short crew lengthens that by Class Crew / Current Crew, an over-crewed ship is no faster, a ship with no crew aboard is no candidate (unavailable, never a figure), and a class that needs no crew with its current crew not in the save is unknown rather than crewless', async (w) => {
  const { lagrange: l } = await w.modules()
  const atBonus = (bonus) => multiplierOf(l, ship({ ProductionBonus: bonus })).result.value

  assert.equal(multiplierOf(l, ship({ ProductionBonus: 1.25 })).state, 'ready')
  assert.ok(near(atBonus(1.25), 0.75), `a captain at 1.25 gives 0.75, not ${atBonus(1.25)}`)
  assert.ok(near(multiplierOf(l, ship({ CurrentCrew: 50, ClassCrew: 100 })).result.value, 2), 'half the class crew doubles the time')
  assert.ok(near(multiplierOf(l, ship({ CurrentCrew: 150, ClassCrew: 100 })).result.value, 1), 'over-crewed is no faster')
  assert.ok(near(multiplierOf(l, ship({ CurrentCrew: 50, ClassCrew: 0 })).result.value, 1), 'a crewed class that needs no crew is not scaled')
  assert.equal(multiplierOf(l, ship({ Damaged: true })).state, 'damaged')
  assert.equal(multiplierOf(l, ship({ CurrentCrew: null })).state, 'unknown')
  assert.equal(multiplierOf(l, ship({ ProductionBonus: 2 })).state, 'bonus')

  const zero = multiplierOf(l, zeroCrew())

  assert.equal(zero.state, 'no-crew', `a ship with no crew aboard is no candidate, not ${zero.state}`)
  assert.equal(zero.result.status, 'unavailable')
  assert.equal(zero.result.value, null)

  const classless = multiplierOf(l, zeroCrew({ ClassCrew: 0 }))
  const missingCrew = [null, undefined, NaN].map((crew) => multiplierOf(l, zeroCrew({ ClassCrew: 0, CurrentCrew: crew })))

  assert.equal(classless.state, 'no-crew', `a class that needs no crew but carries none is still no candidate, not ${classless.state}`)
  assert.equal(classless.result.status, 'unavailable')
  assert.equal(classless.result.value, null)

  missingCrew.forEach((row) => {
    assert.equal(row.state, 'unknown', `a class that needs no crew with its current crew not in the save is unknown, not ${row.state}`)
    assert.equal(row.result.status, 'unavailable')
    assert.equal(row.result.value, null)
  })
})

check('skip', 'a zero-crew ship contributes nothing to the fleet\'s time, a class that needs no crew but carries none included: the quickest ready ship times it, a fleet of zero-crew and damaged ships has no time at all (never 0), a ship whose current crew is not in the save is not counted as crewless but disclosed as possibly quicker, and no reason names a division by the crew', async (w) => {
  const { lagrange: l } = await w.modules()
  const mixed = bestOf(l, [ship({ ProductionBonus: 1.25 }), ship({ CurrentCrew: 50, ClassCrew: 100 }), zeroCrew(), zeroCrew({ ClassCrew: 0 })])
  const alone = bestOf(l, [zeroCrew()])
  const classless = bestOf(l, [zeroCrew({ ClassCrew: 0 })])
  const unusable = bestOf(l, [zeroCrew(), zeroCrew({ ClassCrew: 0 }), ship({ Damaged: true })])
  const mixedUnknown = bestOf(l, [ship({ ProductionBonus: 1.25 }), zeroCrew({ ClassCrew: 0, CurrentCrew: null })])
  const aloneUnknown = bestOf(l, [zeroCrew({ ClassCrew: 0, CurrentCrew: null })])
  const reasons = [...alone.result.inputs.missing, ...unusable.result.inputs.missing]

  assert.ok(near(mixed.result.value, 0.75), `the fleet times at its quickest ready ship (0.75), not ${mixed.result.value}`)
  assert.equal(mixed.ship.state, 'ready', 'the quickest ship is the ready one')
  assert.equal(alone.ship, null, 'a fleet of one zero-crew ship has no ship to time it')
  assert.equal(alone.result.status, 'unavailable')
  assert.equal(alone.result.value, null)
  assert.equal(classless.ship, null, 'a fleet of one ship whose class needs no crew, with none aboard, has no ship to time it')
  assert.equal(classless.result.value, null, 'no time is given, never 0')
  assert.equal(unusable.ship, null, 'a fleet of a zero-crew ship and a damaged ship has no ship to time it')
  assert.equal(unusable.result.value, null, 'no time is given, never 0')
  assert.ok(near(mixedUnknown.result.value, 0.75), `the ready ship still times the fleet, not ${mixedUnknown.result.value}`)
  assert.ok(mixedUnknown.result.assumptions.some((text) => /left out, though quicker/.test(text)), `the ship whose crew is not in the save is disclosed as possibly quicker: ${mixedUnknown.result.assumptions.join(' | ')}`)
  assert.equal(aloneUnknown.ship, null, 'a fleet of one ship whose current crew is not in the save has no ship to time it')
  assert.equal(aloneUnknown.result.value, null, 'no time is given, never 0')
  assert.ok(aloneUnknown.result.inputs.missing.some((text) => /^the crew of a ship/.test(text)), `the reason names the crew of a ship, not a missing crew aboard: ${aloneUnknown.result.inputs.missing.join(' | ')}`)
  assert.ok(!reasons.some((text) => /divides|divide/.test(text)), `no reason names a division by the crew: ${reasons.join(' | ')}`)
})

check('days', 'the duration is 60 / sqrt(mass) months of 30 days times the multiplier and is capped at the game\'s 2,147,483,647 seconds, never a larger or non-finite figure, and a body or a ship the rule cannot time gives no figure, never 0', async (w) => {
  const { lagrange: l } = await w.modules()

  assert.ok(near(daysOf(l, 1, ship()).value, BASE_DAYS), `mass 1 at ×1 takes ${BASE_DAYS} days, not ${daysOf(l, 1, ship()).value}`)
  assert.ok(near(daysOf(l, 4, ship({ ProductionBonus: 1.25 })).value, BASE_DAYS / 2 * 0.75), 'mass 4 at ×0.75 takes three quarters of half the base time')
  assert.ok(near(daysOf(l, 0.25, ship({ ProductionBonus: 1.25 })).value, BASE_DAYS / 0.5 * 0.75), 'mass 0.25 at ×0.75 takes three quarters of twice the base time')
  assert.ok(near(daysOf(l, 1, ship({ CurrentCrew: 1, ClassCrew: 100000 })).value, CAP_DAYS), `a very short crew gives the cap, not ${daysOf(l, 1, ship({ CurrentCrew: 1, ClassCrew: 100000 })).value}`)
  assert.ok(near(daysOf(l, Number.MIN_VALUE, ship()).value, CAP_DAYS), `a tiny body gives the cap, not ${daysOf(l, Number.MIN_VALUE, ship()).value}`)

  const spread = [Number.MIN_VALUE, 1e-15, 0.25, 1, 4000].flatMap((mass) => [0.5, 1, 1.25, 1.5].map((bonus) => ({ mass, days: daysOf(l, mass, ship({ ProductionBonus: bonus })).value })))
  const overflow = spread.filter(({ days }) => !(Number.isFinite(days) && days > 0 && days <= CAP_DAYS))

  assert.equal(overflow.length, 0, `no figure overflows the cap: ${spread.map(({ mass, days }) => `mass ${mass}: ${days}`).join('; ')}`)

  const unknownMass = l.stabilisationDays(0, multiplierOf(l, ship()).result)
  const noCrew = daysOf(l, 1, zeroCrew())

  assert.equal(unknownMass.status, 'unavailable')
  assert.equal(value(unknownMass), null, 'a mass of 0 gives no time, never 0 days')
  assert.equal(noCrew.status, 'unavailable', 'a zero-crew ship gives no time, not a figure')
  assert.equal(value(noCrew), null)
})

check('crew', 'the stabilisation activity of a ship with no crew aboard is blocked at factor 0 (nothing is stabilised, as the 3.1 game skips the ship), a class that needs no crew but carries none included, a class that needs none whose current crew is not in the save is unknown there while its other activities keep the share of 1, the short-crewed ship keeps its share, and the timing rules and crew.stabilisation stand for 3.2.x', async (w) => {
  const { crew: c, lagrange: l, provenance: p } = await w.modules()
  const modules = { [COMPONENT]: { designed: 1, working: 1 } }
  const row = (crew) => ({ CurrentCrew: crew, ClassCrew: 100, CargoCapacity: 0, ColonistCapacity: 0, TroopCapacity: 0, CrewMorale: 1, GradePoints: 0 })
  const of = (ship) => c.crewEffects(ship, { modules, holds: false, version: '3.2.x' }).find((effect) => effect.key === 'stabilisation')
  const stopped = of(row(0))
  const short = of(row(50))
  const classZero = of({ ...row(0), ClassCrew: 0 })
  const classZeroCrewed = of({ ...row(50), ClassCrew: 0 })
  const classZeroMissing = of({ ...row(null), ClassCrew: 0 })
  const classZeroMissingHandling = c.crewEffects({ ...row(null), ClassCrew: 0 }, { modules, holds: true, version: '3.2.x' }).find((effect) => effect.key === 'handling')

  assert.ok(stopped, 'the ship with a stabilisation module has the stabilisation activity')
  assert.equal(stopped.state, 'blocked', `a zero-crew ship stabilises nothing, not ${stopped.state}`)
  assert.equal(stopped.factor, 0)
  assert.equal(value(stopped.result), 0)
  assert.equal(classZero.state, 'blocked', `a class that needs no crew but carries none stabilises nothing, not ${classZero.state}`)
  assert.equal(classZero.factor, 0)
  assert.equal(value(classZero.result), 0)
  assert.ok(classZeroCrewed.state === 'full' && near(classZeroCrewed.factor, 1), `a crewed class that needs none stabilises at full pace, not ${classZeroCrewed.state} at ${classZeroCrewed.factor}`)
  assert.equal(classZeroMissing.state, 'unknown', `a class that needs no crew whose current crew is not in the save stabilises an unknown amount, not ${classZeroMissing.state}`)
  assert.equal(classZeroMissing.factor, null)
  assert.equal(classZeroMissing.result.status, 'unavailable')
  assert.equal(value(classZeroMissing.result), null)
  assert.ok(classZeroMissingHandling.state === 'full' && near(classZeroMissingHandling.factor, 1), `a class that needs no crew is never scaled for its missing current crew, not ${classZeroMissingHandling.state} at ${classZeroMissingHandling.factor}`)
  assert.ok(near(short.factor, 0.5) && short.state === 'reduced', `a short-crewed ship keeps the share of its crew aboard, not ${short.factor}`)
  assert.ok(['lagrange.stabilisationMultiplier', 'lagrange.stabilisationDays', 'crew.stabilisation'].every((id) => p.ruleSupports(id, '3.2.x') === true), 'the timing rules and crew.stabilisation are registered for 3.2.x')
  assert.ok(!multiplierOf(l, ship({ ProductionBonus: 1.25 })).result.assumptions.some((text) => /does not state which game rules/.test(text)), 'a 3.2 save carries no unverified-save assumption on the multiplier')
})

check('save', 'on the interim 3.1 fixture every body of the page\'s list is timed from the save\'s stored mass, crew and captain, a crew of 0 planted in a copy leaves no ship and no time (never 0), and a crew of 1 gives the cap on the light bodies and the formula\'s figure on the heavy ones', async (w) => {
  const { lagrange: l } = await w.modules()
  const { intact, zero, one, bodies } = copies()
  const timed = (rows) => {
    const best = bestOf(l, rows)

    return { best, days: bodies.map((body) => l.stabilisationDays(body.Mass, best.result)) }
  }
  const intactDays = timed(intact)
  const zeroDays = timed(zero)
  const oneDays = timed(one)
  const intactWrong = daysWrong(intactDays.days, oracleDays(intact[0]), bodies)
  const oneWrong = daysWrong(oneDays.days, oracleDays(one[0]), bodies)
  const capped = oneDays.days.filter((result) => near(value(result), CAP_DAYS)).length

  assert.equal(intactDays.best.ship.state, 'ready', 'the fixture\'s stabilisation ship times the bodies')
  assert.ok(Number.isFinite(intactDays.best.result.value), 'the fixture\'s ship gives a multiplier')
  assert.equal(intactWrong.length, 0, `every one of the ${bodies.length} bodies takes the formula's time from the stored mass and multiplier: ${intactWrong.slice(0, 4).join('; ')}`)
  assert.ok(intactDays.days.every((result) => value(result) <= CAP_DAYS), 'no body of the intact ship\'s list is above the cap')

  assert.equal(zeroDays.best.ship, null, 'a crew of 0 leaves no ship to time the bodies')
  assert.equal(zeroDays.best.result.status, 'unavailable')
  assert.ok(zeroDays.days.every((result) => result.status === 'unavailable' && value(result) === null), 'a crew of 0 gives no time for any body, never 0')

  assert.ok(near(oneDays.best.result.value, oracleMultiplier(one[0])), `a crew of 1 gives Class Crew / Current Crew times the captain's multiplier, not ${oneDays.best.result.value}`)
  assert.equal(oneWrong.length, 0, `a crew of 1 gives the capped formula's time on every body: ${oneWrong.slice(0, 4).join('; ')}`)
  assert.ok(capped > 0 && capped < bodies.length, `the light bodies are capped and the heavy ones are not (${capped} of ${bodies.length} capped)`)
})

// The bodies whose duration is not the oracle's, each as a line naming the mass, the figure and the expected one.
const daysWrong = (results, expected, bodies) => results.map((result, index) => [bodies[index].Mass, value(result), expected(bodies[index].Mass)]).filter(([, days, want]) => !near(days, want)).map(([mass, days, want]) => `mass ${mass}: ${days} not ${want}`)

// ---- The faults and the rewrites ----------------------------------------------------------------------------------
const FAULTS = [
  { name: 'a ship with no crew is timed as the quickest one, the division by zero that the earlier line aborted on', target: 'lagrange', from: '} else if (!aboard) {', to: '} else if (false) {', fails: ['multiplier', 'skip', 'days'] },
  { name: 'the no-crew skip keyed on the crew fraction, so a class that needs no crew is timed as ready with none aboard', target: 'lagrange', from: '} else if (!aboard) {', to: '} else if (fraction === 0) {', fails: ['multiplier', 'skip'] },
  { name: 'a missing current crew read as crewless, so a class that needs no crew is timed as no-crew rather than unknown', target: 'lagrange', from: 'const aboard = Number.isFinite(ship.CurrentCrew) ? ship.CurrentCrew > 0 : null', to: 'const aboard = ship.CurrentCrew > 0', fails: ['multiplier', 'skip'] },
  { name: 'a missing current crew read as crewless in the crew effects, so a class that needs no crew reads blocked at 0 rather than unknown', target: 'crew', from: 'const aboard = Number.isFinite(ship.CurrentCrew) ? ship.CurrentCrew > 0 : null', to: 'const aboard = ship.CurrentCrew > 0', fails: ['crew'] },
  { name: 'the duration is not capped at the game\'s 32-bit integer time', target: 'lagrange', from: 'Math.min((BASE_DAYS / Math.sqrt(mass)) * factor, MAX_DAYS)', to: '(BASE_DAYS / Math.sqrt(mass)) * factor', fails: ['days', 'save'] },
  { name: 'the cap is below the game\'s Int32.MaxValue seconds', target: 'lagrange', from: 'const MAX_SECONDS = 2147483647', to: 'const MAX_SECONDS = 2000000000', fails: ['days', 'save'] },
  { name: 'a ship with no crew is shown as stopped at 0% rather than blocked', target: 'crew', from: 'time: true, aboard: true, versions: STABILISATION_VERSIONS', to: 'time: true, versions: STABILISATION_VERSIONS', fails: ['crew'] },
]

// Rewrites that say the same thing: a day written as its hours, minutes and seconds, and the ready rows filtered by a destructured state.
const BENIGN = [
  { name: 'a day written as 24 hours of 60 minutes of 60 seconds', target: 'lagrange', from: 'const SECONDS_PER_DAY = 86400', to: 'const SECONDS_PER_DAY = 24 * 60 * 60' },
  { name: 'the ready rows filtered by a destructured state', target: 'lagrange', from: 'const ready = rows.filter((row) => row.state === \'ready\')', to: 'const ready = rows.filter(({ state }) => state === \'ready\')' },
]

// ---- Run ---------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const absent = (check) => check.name === 'save' && !fs.existsSync(path.join(root, SAVE))

const main = async () => {
  const available = CHECKS.filter((one) => !absent(one))

  if (available.length !== CHECKS.length) {
    console.log(`UNSUPPORTED  the fixture ${SAVE}: the save is not there`)
  }

  const failures = await run(available, worldOf())
  let passed = available.length - failures.length
  let total = available.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    const known = new Set(available.map(({ name }) => name))

    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(known.has(id) || CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(available, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith(benign)

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      const world = worldOf(texts)
      const named = fault.fails.filter((id) => known.has(id))
      const missed = []

      for (const id of named) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed, named: named.length }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (!outcome.named) {
        console.log(`FAIL planted fault ${outcome.label}: none of its checks can run here`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    if (COPIES) {
      COPIES.close()
    }

    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)

    if (COPIES) {
      COPIES.close()
    }

    process.exit(2)
  })
