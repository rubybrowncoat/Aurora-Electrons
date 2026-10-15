// What size of active sensor and missile fire control reaches a target, which beam fire control tracks a speed at a range, and what the sensors and fire controls the race already has reach: pure functions over the records of design-data.js (`ownedActiveSensors`, `ownedBeamFireControls`, `loadSignatureClasses`) and the tech lines of the researched and hypothetical tech contract (race-tech.js, tech-scenarios.js), built on the rules of design-rules.js and mechanics-sensors.md. Every figure is a provenance result (utilities/provenance.js): unavailable, naming what is missing, and never 0 when the target, the wanted range or a tech line is blank. A level the race has not researched is only ever a hypothetical choice and marks every figure built on it as assumed.
//
// Inputs are numbers or text: a blank, null or unreadable text is unknown. A jammer that is blank is no jammer.
//
// Return shapes:
// - `sensorTechOf(tech, resolution)`: the `tech` argument of every function here, from `tech` (tech-scenarios.js `withCandidates`) and its `resolution` (`resolveChoices`). `{ strength, em, thermal, hardening, eccm, distance, speed, singleWeapon, levels: { hardening, eccm }, assumptions, hypothetical }`; each line is `{ role, typeId, label, level: { id, name, info, info2, cost }|null, info, info2, kind, hypothetical, assumption, unresolved }`, `singleWeapon` also `{ weapons: { unrestricted, single }, offersSingle }`, `levels` the researched levels and the chosen hypothetical one as `{ level, researched, hypothetical, current, assumption }`.
// - `techLineOptions(tech, resolution, role)`: the levels a menu offers for a line, `{ id, name, info, info2, researched, hypothetical, current, status, text }`; an unresearched level is never `researched`.
// - `targetOf({ kind, tons, cls, msp })`: `{ kind, label, signature, fireControlSignature, fireControlJammer, uncloaked, tons, results: [{ key, label, signature, fireControlSignature, fireControlJammer }] }`: `signature` is what a search sensor sees and `fireControlSignature` what a missile fire control sees (the same cross-section for a ship, the missile's size in MSP, never under 0.33, for a missile), and `fireControlJammer` is false where no jammer applies to a fire control (a missile target); each entry of `results` carries the three, as a target of its own for `activeSizing`, `savedPairCheck` and `existingDesigns`.
// - `activeSizing(...)`: `{ request: { signature, fireControlSignature, wantedRangeKm, jammer, fireControlJammer, resolution }, problems, rows, selected, best, bestBasis, tiles: { rangeReached, sizeNeeded, bestResolution, cost } }`, a row per legal resolution `{ resolution, selected, best, search, fireControl, totalCost, totalHS, reach, feasible, failing, limiting }` and a member `{ mode, sizing, sizeHS, size, reach, design, cost }`.
// - `savedPairCheck(...)`: `{ search, fireControl, reach, meets, limiting, alternative: { basis, row, sizing } }`.
// - `existingDesigns(...)`: `[{ row, reach, scenarios: [{ key, label, reach }] }]`.
// - `rangeCurve(...)`: `{ series: [{ key, name, points: [{ x (tons), y (km) }] }], rows: [{ tons, signature, ranges: [{ key, name, result }] }] }`.
// - `hardeningEccmTradeoff(...)`: `{ pair, rows: [{ hardening, eccm, search, fireControl, cost, uridium, corbomite, reach, meets, current }] }`.
// - `passiveProposal(...)`: `{ design, sensitivity }`.
// - `beamSizing(...)`: `{ restriction, range, tracking, request, design, tiles, table }`; `existingBeamControls(...)`: `[{ row, range, tracking, meets, limiting }]`, each axis `{ result, wanted, meets }` and the range also `aboveCap` (the stored range is above the cap of a designed control; it is kept and checked as stored).

import { BEAM_FIRE_CONTROL_MAX_RANGE_KM, FIRE_CONTROL_MULTIPLIERS, FIRE_CONTROL_SPECIAL, SENSOR_MODES, SENSOR_RESOLUTIONS_HS, SENSOR_RULES, TONS_PER_HS, activeSensorDesign, beamFireControlDesign, beamFireControlForRequest, classCrossSection, fireControlTracking, missileFireControlSignature, missileSignature, passiveSensorDesign, reaches, sensorEffectiveRange, sensorSizeForRange } from './design-rules'
import { isKnownNumber } from './math'
import { STATUS, combine, envelope, isAvailable, ofRule, unavailable, valueOrNull } from './provenance'
import { SENSOR_PLANNER_LINES } from './race-tech'
import { classSignatures } from './signatures'
import { NO_TECH_CHOICES, candidateText, describeHypothetical, markHypothetical, resolveChoices } from './tech-scenarios'

const CROSS_SECTION_RULE = 'design.classCrossSection'

const BEST_OBJECTIVE = 'the best resolution is the one whose pair costs the fewest BP, then needs the fewest HS, then has the higher resolution: the planner\'s own objective, which the game does not apply'

const RESOLUTION_WINDOW = 'the design window offers resolutions 1 to 20, 25 to 200 in fives and 220 to 500 in twenties'

export const DEFAULT_CURVE_TONS = Object.freeze([50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000])

export const DEFAULT_BEAM_MULTIPLIERS = Object.freeze([0.5, 1, 1.5, 2, 3, 4])

const figureOf = (value) => (isKnownNumber(value) ? Number(value) : null)

// A number the player typed or a stored figure: a number, a numeric text, or null for anything blank or unreadable.
const numberOf = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null
}

// A wanted figure a player typed: a number above zero, else null (unknown), as a sizing request reads it.
const positiveOf = (value) => {
  const number = numberOf(value)

  return number !== null && number > 0 ? number : null
}

// The jammer a player typed: blank is no jammer (0), a number is itself, an unreadable text is unknown (null).
const jammerOf = (value) => (value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? 0 : numberOf(value))

const unique = (list) => [...new Set(list)]

// ---------- the tech lines ----------

const lineOf = (role, label, modes) => Object.freeze({ role, typeId: SENSOR_PLANNER_LINES[role], label, modes: Object.freeze(modes) })

// The tech lines of the planner in the order a menu lists them, with the modes that read each.
export const SENSOR_TECH_LINES = Object.freeze([
  lineOf('strength', 'Active sensor strength', ['active']),
  lineOf('em', 'EM sensitivity', ['active', 'passive']),
  lineOf('thermal', 'Thermal sensitivity', ['passive']),
  lineOf('hardening', 'Hardening', ['active', 'passive', 'beam']),
  lineOf('eccm', 'ECCM', ['active', 'beam']),
  lineOf('distance', 'Beam fire control distance', ['beam']),
  lineOf('speed', 'Beam fire control speed', ['beam']),
  lineOf('singleWeapon', 'Single weapon control', ['beam']),
])

export const SENSOR_MODE_LINES = Object.freeze(Object.fromEntries(['active', 'passive', 'beam'].map((mode) => [mode, Object.freeze(SENSOR_TECH_LINES.filter((entry) => entry.modes.includes(mode)).map((entry) => entry.role))])))

const LINE_LABELS = Object.freeze(Object.fromEntries(SENSOR_TECH_LINES.map((entry) => [entry.role, entry.label])))

// The lines whose tech row holds a rating and a cost factor.
const COST_ROLES = Object.freeze(['hardening', 'eccm'])

const levelOf = (level) => (level ? Object.freeze({ id: level.id, name: level.name, info: figureOf(level.info), info2: figureOf(level.info2), cost: level.cost }) : null)

// The levels of a line: the ones the race has researched and, when the choice is a hypothetical level, that one.
const entriesOf = (tech, resolution, typeId) => {
  const line = tech && tech.lines ? tech.lines[typeId] : null
  const resolved = resolution ? resolution[typeId] : null
  const currentId = resolved && resolved.level ? resolved.level.id : null
  const researched = line ? line.levels.map((item) => Object.freeze({ level: levelOf(item), researched: true, hypothetical: false, current: item.id === currentId, assumption: null })) : []
  const chosen = resolved && resolved.hypothetical ? [Object.freeze({ level: levelOf(resolved.level), researched: false, hypothetical: true, current: true, assumption: describeHypothetical(resolved) })] : []

  return [...researched, ...chosen]
}

const lineFigureOf = (resolution, role) => {
  const typeId = SENSOR_PLANNER_LINES[role]
  const resolved = resolution ? resolution[typeId] : null
  const level = resolved ? levelOf(resolved.level) : null

  return { role, typeId, label: LINE_LABELS[role], level, info: level ? level.info : null, info2: level ? level.info2 : null, kind: resolved ? resolved.kind : 'none', hypothetical: Boolean(resolved && resolved.hypothetical), assumption: resolved && resolved.hypothetical ? describeHypothetical(resolved) : null, unresolved: resolved ? resolved.unresolved : null }
}

// The weapon number a class of single weapon levels gives: the chosen level of the class, else the researched one that cost the most to develop.
const weaponOf = (entries) => {
  if (!entries.length) {
    return null
  }

  const chosen = entries.find((entry) => entry.current) || entries.reduce((best, entry) => (!best || entry.level.cost > best.level.cost ? entry : best), null)

  return Object.freeze({ number: chosen.level.info, level: chosen.level, hypothetical: chosen.hypothetical, assumption: chosen.assumption })
}

// The tech a planner function designs with, from the race's tech and its resolution of the lines (see the return shapes above). A line with no level has `info` null and every figure that needs it is unavailable.
export const sensorTechOf = (tech = NO_TECH_CHOICES, resolution = resolveChoices(tech)) => {
  const figures = Object.fromEntries(SENSOR_TECH_LINES.map(({ role }) => [role, lineFigureOf(resolution, role)]))
  const allWeaponEntries = entriesOf(tech, resolution, SENSOR_PLANNER_LINES.singleWeapon)
  const weaponEntries = allWeaponEntries.filter((entry) => entry.level.info !== null)
  const unknownEntries = allWeaponEntries.filter((entry) => entry.level.info === null)
  const weapons = Object.freeze({ unrestricted: weaponOf(weaponEntries.filter((entry) => entry.level.info >= 1)), single: weaponOf(weaponEntries.filter((entry) => entry.level.info > 0 && entry.level.info < 1)), unknown: Object.freeze(unknownEntries.map((entry) => entry.level.name)), currentUnknown: unknownEntries.some((entry) => entry.current) })

  figures.singleWeapon = Object.freeze({ ...figures.singleWeapon, weapons, offersSingle: weapons.single !== null })

  const assumptions = unique(Object.values(figures).map((figure) => figure.assumption).filter(Boolean))

  return Object.freeze({
    ...Object.fromEntries(Object.entries(figures).map(([role, figure]) => [role, Object.freeze(figure)])),
    levels: Object.freeze({ hardening: Object.freeze(entriesOf(tech, resolution, SENSOR_PLANNER_LINES.hardening)), eccm: Object.freeze(entriesOf(tech, resolution, SENSOR_PLANNER_LINES.eccm)) }),
    assumptions: Object.freeze(assumptions),
    hypothetical: assumptions.length > 0,
  })
}

// What a page holds before the race's tech is read: every line empty.
export const NO_SENSOR_TECH = sensorTechOf(NO_TECH_CHOICES, resolveChoices(NO_TECH_CHOICES))

// The levels of a line a menu offers: the researched levels first, then the candidates the research graph names. A candidate is a hypothetical level and is never researched, whatever its research status.
export const techLineOptions = (tech, resolution, role) => {
  const typeId = SENSOR_PLANNER_LINES[role]
  const line = tech && tech.lines ? tech.lines[typeId] : null
  const resolved = resolution ? resolution[typeId] : null

  if (!line) {
    return []
  }

  const researched = line.levels.map((item) => ({ id: item.id, name: item.name, info: figureOf(item.info), info2: figureOf(item.info2), researched: true, hypothetical: false, current: Boolean(resolved && resolved.level && resolved.level.id === item.id), status: null, text: item.name }))
  const candidates = line.candidates.map((item) => ({ id: item.id, name: item.name, info: figureOf(item.info), info2: figureOf(item.info2), researched: false, hypothetical: true, current: Boolean(resolved && resolved.hypothetical && resolved.level.id === item.id), status: item.status, text: `${item.name} · ${candidateText(item)}` }))

  return [...researched, ...candidates]
}

const techOf = (tech) => tech || NO_SENSOR_TECH

// The hypothetical assumptions of the lines a figure reads.
const marksOf = (tech, roles) => unique(roles.map((role) => techOf(tech)[role].assumption).filter(Boolean))

const marked = (result, assumptions) => markHypothetical(result, unique(assumptions))

// The lines among `roles` whose figures the race's tech does not give, as the names of what is missing.
const missingLines = (tech, roles) => roles.filter((role) => techOf(tech)[role].info === null || (COST_ROLES.includes(role) && techOf(tech)[role].info2 === null)).map((role) => `the race's ${LINE_LABELS[role].toLowerCase()} tech`)

const DESIGN_ROLES = Object.freeze(['strength', 'em', 'hardening', 'eccm'])

const eccmOf = (tech) => (techOf(tech).eccm.info === null ? null : Math.trunc(techOf(tech).eccm.info))

// ---------- the target ----------

const noTarget = (label, missing) => {
  const signature = unavailable({ rule: SENSOR_RULES.detection, missing: [missing] })

  return Object.freeze({ kind: null, label, signature, fireControlSignature: signature, fireControlJammer: true, uncloaked: null, tons: null, results: Object.freeze([Object.freeze({ key: 'effective', label, signature, fireControlSignature: signature, fireControlJammer: true })]) })
}

const typedSignature = (rule, value, label, assumptions) => envelope({ value, status: STATUS.ASSUMED, rule, inputs: { present: [label] }, assumptions })

// The target a sensor is sized or measured against: a size in tons (the cross-section is the size over 50 t per HS, never under 0.3 HS), a saved class of the race (its stored cross-section, with the uncloaked size as a second scenario where a cloak works) or a missile size in MSP (its signature, never under 0.3 HS). Blank or not above zero is unknown: the signature is unavailable, never 0.
export const targetOf = ({ kind, tons = null, cls = null, msp = null } = {}) => {
  if (kind === 'class') {
    if (!cls) {
      return noTarget('No class', 'a ship class of the race')
    }

    const { crossSection } = classSignatures(cls)
    const results = [Object.freeze({ key: 'effective', label: crossSection.cloaked ? 'Cloak working' : 'Cross-section', signature: crossSection.effective, fireControlSignature: crossSection.effective, fireControlJammer: true })]

    if (crossSection.cloaked && isAvailable(crossSection.uncloaked)) {
      results.push(Object.freeze({ key: 'uncloaked', label: 'Cloak damaged', signature: crossSection.uncloaked, fireControlSignature: crossSection.uncloaked, fireControlJammer: true }))
    }

    return Object.freeze({ kind, label: cls.name, signature: crossSection.effective, fireControlSignature: crossSection.effective, fireControlJammer: true, uncloaked: crossSection.cloaked ? crossSection.uncloaked : null, tons: numberOf(cls.sizeHS) !== null ? cls.sizeHS * TONS_PER_HS : null, results: Object.freeze(results) })
  }

  if (kind === 'tons') {
    const size = numberOf(tons)

    if (!(size > 0)) {
      return noTarget('No size', 'the target size in tons, above zero')
    }

    const signature = typedSignature(CROSS_SECTION_RULE, classCrossSection({ sizeHS: size / TONS_PER_HS }), 'target size', [`a target of ${size} t typed here`, `the cross-section is the size over ${TONS_PER_HS} t per HS, never under 0.3 HS`])

    return Object.freeze({ kind, label: `${size} t`, signature, fireControlSignature: signature, fireControlJammer: true, uncloaked: null, tons: size, results: Object.freeze([Object.freeze({ key: 'effective', label: `${size} t`, signature, fireControlSignature: signature, fireControlJammer: true })]) })
  }

  if (kind === 'missile') {
    const size = numberOf(msp)

    if (!(size > 0)) {
      return noTarget('No missile', 'the missile size in MSP, above zero')
    }

    const signature = typedSignature(SENSOR_RULES.detection, missileSignature({ sizeMsp: size }), 'missile size', [`a missile of ${size} MSP typed here`, 'a missile is seen by its size over 20 MSP per HS, never under 0.3 HS'])

    const fireControlSignature = typedSignature(SENSOR_RULES.detection, missileFireControlSignature({ sizeMsp: size }), 'missile size', [`a missile of ${size} MSP typed here`, 'a missile fire control sees a missile by its size in MSP, never under 0.33, and no jammer applies to it'])

    return Object.freeze({ kind, label: `${size} MSP missile`, signature, fireControlSignature, fireControlJammer: false, uncloaked: null, tons: null, results: Object.freeze([Object.freeze({ key: 'effective', label: `${size} MSP missile`, signature, fireControlSignature, fireControlJammer: false })]) })
  }

  return noTarget('No target', 'the target')
}

const signatureOf = (target) => (target && target.signature ? target.signature : unavailable({ rule: SENSOR_RULES.detection, missing: ['the target'] }))

// What each member of a pair is set against: the search sensor the target's search signature and the jammer; the missile fire control the target's fire control signature (the same cross-section for a ship, the missile's size in MSP for a missile) and, for a missile, no jammer.
const inputsOf = (target, jammer) => ({ search: { signature: signatureOf(target), jammer }, fireControl: { signature: target && target.fireControlSignature ? target.fireControlSignature : signatureOf(target), jammer: target && target.fireControlJammer === false ? 0 : jammer } })

// ---------- the effective range of a sensor ----------

// A sensor's range against a signature (a result), the signature's provenance carried, and the provenance of the design result in `source` where it has one: unavailable naming the sensor figure or the target that is missing.
const reachOf = ({ rangeKm, resolution, eccm, signature, jammer, source = null }) => combine({ rule: SENSOR_RULES.detection, parts: { reach: sensorEffectiveRange({ rangeKm: figureOf(rangeKm), signature: valueOrNull(signature), resolution: figureOf(resolution), jammer, eccm: figureOf(eccm) }), 'target signature': signature, ...(source ? { 'sensor design': source } : {}) }, compute: (values) => values.reach, units: 'km' })

// A reach with the provenance of the design it comes from carried (a proposed sensor's design result, which names a hypothetical tech level it was built on): the reach itself where the sensor has no design result, as for a saved one.
const withDesign = (reach, source) => (source ? combine({ rule: SENSOR_RULES.detection, parts: { reach, 'sensor design': source }, compute: (values) => values.reach, units: 'km' }) : reach)

// The shorter of two ranges, unavailable when either is.
const shorterOf = (first, second) => combine({ rule: SENSOR_RULES.detection, parts: { search: first, 'fire control': second }, compute: (values) => Math.min(values.search, values['fire control']), units: 'km' })

// A sensor as the curve and the tables read it, from a stored sensor of `ownedActiveSensors`.
export const sensorOf = (row) => ({ key: row.id, name: row.name, kind: row.kind, rangeKm: row.rangeKm, resolution: row.resolution, eccm: row.eccm })

// ---------- active sizing ----------

const MEMBERS = Object.freeze([{ key: 'search', mode: SENSOR_MODES.search, name: 'search sensor' }, { key: 'fireControl', mode: SENSOR_MODES.missileFireControl, name: 'missile fire control' }])

const designOf = ({ sizeHS, resolution, mode, tech, sizing }) => combine({ rule: SENSOR_RULES.active, parts: { sizing }, compute: () => activeSensorDesign({ sizeHS, resolution, strengthTech: tech.strength.info, emTech: tech.em.info, hardeningRating: tech.hardening.info, hardeningCost: tech.hardening.info2, eccmRating: tech.eccm.info, eccmCost: tech.eccm.info2, mode }) })

// One member of a pair at a resolution: the smallest legal size that reaches the wanted range, its effective range and its design.
const memberOf = ({ member, resolution, signature, wanted, jammer, tech }) => {
  const raw = sensorSizeForRange({ mode: member.mode, targetRangeKm: wanted, signature: valueOrNull(signature), resolution, strengthTech: tech.strength.info, emTech: tech.em.info, jammer, eccm: eccmOf(tech) })
  const sizing = marked(combine({ rule: SENSOR_RULES.sizing, parts: { sizing: raw, 'target signature': signature }, compute: (values) => values.sizing }), marksOf(tech, jammer > 0 ? ['strength', 'em', 'eccm'] : ['strength', 'em']))
  const sizeHS = isAvailable(sizing) ? sizing.value.sizeHS : null
  const beyond = isAvailable(sizing) && sizeHS === null
  const missing = beyond ? [`a ${member.name} that reaches the wanted range: even ${sizing.value.largestHS} HS falls short of it`] : isAvailable(sizing) ? [] : sizing.inputs.missing
  const size = sizeHS === null ? unavailable({ rule: SENSOR_RULES.sizing, missing, units: 'HS' }) : combine({ rule: SENSOR_RULES.sizing, parts: { sizing }, compute: (values) => values.sizing.sizeHS, units: 'HS' })
  const reach = sizeHS === null ? unavailable({ rule: SENSOR_RULES.detection, missing, units: 'km' }) : combine({ rule: SENSOR_RULES.detection, parts: { sizing }, compute: (values) => values.sizing.rangeKm, units: 'km' })
  const lacking = missingLines(tech, DESIGN_ROLES)
  const design = sizeHS === null ? unavailable({ rule: SENSOR_RULES.active, missing }) : lacking.length ? unavailable({ rule: SENSOR_RULES.active, missing: lacking }) : marked(designOf({ sizeHS, resolution, mode: member.mode, tech, sizing }), marksOf(tech, DESIGN_ROLES))
  const cost = combine({ rule: SENSOR_RULES.active, parts: { design }, compute: (values) => values.design.cost, units: 'BP' })

  return { mode: member.mode, sizing, sizeHS, beyond, size, reach, design, cost }
}

const differs = (a, b) => Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

// The cheaper pair, then the smaller, then the one of the higher resolution.
const compareRows = (basis) => (a, b) => (basis === 'cost' && differs(a.totalCost.value, b.totalCost.value) ? a.totalCost.value - b.totalCost.value : 0) || (differs(a.totalHS.value, b.totalHS.value) ? a.totalHS.value - b.totalHS.value : 0) || b.resolution - a.resolution

const rowOf = (resolution, { inputs, wanted, tech }) => {
  const search = memberOf({ member: MEMBERS[0], resolution, wanted, tech, ...inputs.search })
  const fireControl = memberOf({ member: MEMBERS[1], resolution, wanted, tech, ...inputs.fireControl })
  const feasible = search.sizeHS !== null && fireControl.sizeHS !== null
  const failing = [search.beyond ? 'search' : null, fireControl.beyond ? 'fireControl' : null].filter(Boolean)
  const totalCost = combine({ rule: SENSOR_RULES.active, parts: { search: search.cost, 'missile fire control': fireControl.cost }, compute: (values) => values.search + values['missile fire control'], units: 'BP' })
  const totalHS = combine({ rule: SENSOR_RULES.sizing, parts: { search: search.size, 'missile fire control': fireControl.size }, compute: (values) => values.search + values['missile fire control'], units: 'HS' })

  return { resolution, selected: false, best: false, search, fireControl, totalCost, totalHS, reach: shorterOf(search.reach, fireControl.reach), feasible, failing, limiting: failing.length === 1 ? failing[0] : failing.length ? 'search' : null }
}

const tileOf = (result, rule, missing, units) => (result && isAvailable(result) ? result : unavailable({ rule, missing: result ? result.inputs.missing : missing, units }))

// A search sensor and a missile fire control, both designed from the same chosen tech at one resolution, sized to see `target` at `wantedRangeKm` (the target's effective range after the resolution cut and the jammer): a row per legal resolution, the row of the chosen `resolution` (a number of the design window, or 'best') and the best row. `tech` is `sensorTechOf`'s.
export const activeSizing = ({ target = null, wantedRangeKm = null, resolution = 'best', jammer = 0, tech = NO_SENSOR_TECH } = {}) => {
  const figures = techOf(tech)
  const wanted = numberOf(wantedRangeKm)
  const jam = jammerOf(jammer)
  const inputs = inputsOf(target, jam)
  const context = { inputs, wanted, tech: figures }
  const rows = SENSOR_RESOLUTIONS_HS.map((entry) => rowOf(entry, context))
  const feasible = rows.filter((row) => row.feasible)
  const priced = feasible.filter((row) => isAvailable(row.totalCost))
  const bestBasis = priced.length ? 'cost' : feasible.length ? 'size' : null
  const bestRow = bestBasis === null ? null : (bestBasis === 'cost' ? priced : feasible).reduce((best, row) => (!best || compareRows(bestBasis)(row, best) < 0 ? row : best), null)
  const wantedResolution = resolution === 'best' ? 'best' : numberOf(resolution)
  const problems = []

  if (wantedResolution === null) {
    problems.push('the resolution is not chosen')
  } else if (wantedResolution !== 'best' && !rows.some((row) => row.resolution === wantedResolution)) {
    problems.push(`a resolution of ${wantedResolution} is not offered: ${RESOLUTION_WINDOW}`)
  }

  const flagged = rows.map((row) => ({ ...row, best: row === bestRow, selected: wantedResolution === 'best' ? row === bestRow : row.resolution === wantedResolution }))
  const selected = flagged.find((row) => row.selected) || null
  const best = flagged.find((row) => row.best) || null
  const first = rows[0].search.sizing
  const none = problems.length ? problems : isAvailable(first) ? ['a resolution at which the pair reaches the wanted range'] : first.inputs.missing
  const bestSource = best ? (bestBasis === 'cost' ? best.totalCost : best.totalHS) : null

  return Object.freeze({
    request: Object.freeze({ signature: inputs.search.signature, fireControlSignature: inputs.fireControl.signature, wantedRangeKm: wanted, jammer: jam, fireControlJammer: inputs.fireControl.jammer, resolution: wantedResolution }),
    problems: Object.freeze(problems),
    rows: Object.freeze(flagged),
    selected,
    best,
    bestBasis,
    tiles: Object.freeze({
      rangeReached: tileOf(selected ? selected.reach : null, SENSOR_RULES.detection, none, 'km'),
      sizeNeeded: tileOf(selected ? selected.totalHS : null, SENSOR_RULES.sizing, none, 'HS'),
      bestResolution: bestSource ? combine({ rule: SENSOR_RULES.sizing, parts: { 'pair of the best resolution': bestSource }, compute: () => best.resolution, units: 'HS', assumptions: [BEST_OBJECTIVE] }) : unavailable({ rule: SENSOR_RULES.sizing, missing: isAvailable(first) ? ['a resolution at which the pair reaches the wanted range'] : first.inputs.missing, units: 'HS' }),
      cost: tileOf(selected ? selected.totalCost : null, SENSOR_RULES.active, none, 'BP'),
    }),
  })
}

// ---------- a saved pair ----------

const memberCheck = ({ row, signature, jammer, wanted }) => {
  if (!row) {
    return null
  }

  const reach = reachOf({ rangeKm: row.rangeKm, resolution: row.resolution, eccm: row.eccm, signature, jammer })

  return { row, reach, meets: isAvailable(reach) && wanted !== null ? reaches(reach.value, wanted) : null }
}

const limitingOf = (search, fireControl) => {
  const falling = [['search', search], ['fireControl', fireControl]].filter(([, member]) => member && member.meets === false)

  if (falling.length < 2) {
    return falling.length ? falling[0][0] : null
  }

  return falling[1][1].reach.value < falling[0][1].reach.value ? 'fireControl' : 'search'
}

// A saved search sensor and a saved missile fire control against a target at a wanted range: each member's effective range and whether it meets the range, the pair's reach (the shorter), the limiting member when the pair falls short (a search sensor that falls short limits the pair whatever the fire control reaches, and the reverse), and the best proposed pair at the saved resolution of the search sensor, else the best overall.
export const savedPairCheck = ({ search = null, fireControl = null, target = null, wantedRangeKm = null, jammer = 0, tech = NO_SENSOR_TECH } = {}) => {
  const wanted = positiveOf(wantedRangeKm)
  const inputs = inputsOf(target, jammerOf(jammer))
  const members = { search: memberCheck({ row: search, wanted, ...inputs.search }), fireControl: memberCheck({ row: fireControl, wanted, ...inputs.fireControl }) }
  const outcomes = Object.values(members).map((member) => (member ? member.meets : null))
  const meets = outcomes.includes(false) ? false : outcomes.every((outcome) => outcome === true) ? true : null
  const proposal = activeSizing({ target, wantedRangeKm: wanted, resolution: 'best', jammer, tech })
  const savedResolution = search ? figureOf(search.resolution) : null
  const atSaved = savedResolution === null ? null : proposal.rows.find((row) => row.resolution === savedResolution && row.feasible) || null
  const alternative = atSaved ? { basis: 'saved resolution', row: atSaved, sizing: proposal } : proposal.best ? { basis: 'best overall', row: proposal.best, sizing: proposal } : { basis: null, row: null, sizing: proposal }

  return Object.freeze({
    search: members.search,
    fireControl: members.fireControl,
    reach: members.search && members.fireControl ? shorterOf(members.search.reach, members.fireControl.reach) : unavailable({ rule: SENSOR_RULES.detection, missing: [members.search ? 'a missile fire control' : 'a search sensor'], units: 'km' }),
    meets,
    limiting: meets === false ? limitingOf(members.search, members.fireControl) : null,
    alternative: Object.freeze(alternative),
  })
}

// ---------- the sensors the race has ----------

// Each saved active sensor and missile fire control with its reach against the target, for every scenario of the target (the cloak working, and the cloak damaged where one works).
export const existingDesigns = ({ sensors = [], target = null, jammer = 0 } = {}) => {
  const jam = jammerOf(jammer)
  const scenarios = target && target.results ? target.results : [{ key: 'effective', label: 'Cross-section', signature: signatureOf(target), fireControlSignature: signatureOf(target), fireControlJammer: true }]

  return sensors.map((row) => {
    const fireControl = row.kind === 'fireControl'
    const reaching = scenarios.map((scenario) => ({ key: scenario.key, label: scenario.label, reach: reachOf({ rangeKm: row.rangeKm, resolution: row.resolution, eccm: row.eccm, signature: fireControl ? scenario.fireControlSignature : scenario.signature, jammer: fireControl && scenario.fireControlJammer === false ? 0 : jam, source: row.source }) }))

    return { row, reach: reaching[0].reach, scenarios: reaching }
  })
}

// The reach of each sensor (`sensors` of { key, name, rangeKm, resolution, eccm, source }, `source` the design result of a proposed sensor, whose provenance each of its reaches carries) against targets of each size in `tonsList` (tons, sorted, without duplicates and without what is not above zero): a point only where the reach is known, so a curve never has a 0 for an unknown sensor.
export const rangeCurve = ({ sensors = [], tonsList = [], jammer = 0 } = {}) => {
  const jam = jammerOf(jammer)
  const tonnages = unique(tonsList.map(numberOf).filter((tons) => tons !== null && tons > 0)).sort((a, b) => a - b)
  const rows = tonnages.map((tons) => {
    const signature = classCrossSection({ sizeHS: tons / TONS_PER_HS })

    return { tons, signature, ranges: sensors.map(({ key, name, rangeKm, resolution, eccm, source = null }) => ({ key, name, result: withDesign(sensorEffectiveRange({ rangeKm: figureOf(rangeKm), signature, resolution: figureOf(resolution), jammer: jam, eccm: figureOf(eccm) }), source) })) }
  })
  const series = sensors.map(({ key, name }, index) => ({ key, name, points: rows.filter((row) => isAvailable(row.ranges[index].result)).map((row) => ({ x: row.tons, y: row.ranges[index].result.value })) }))

  return { series, rows }
}

// ---------- hardening and ECCM ----------

const tradeoffMember = ({ member, entryHardening, entryEccm, tech, pair }) => {
  const missing = []

  if (member.sizeHS === null) {
    return unavailable({ rule: SENSOR_RULES.active, missing: member.size.inputs.missing })
  }

  missingLines(tech, ['strength', 'em']).forEach((name) => missing.push(name))

  if (entryHardening.level.info === null || entryHardening.level.info2 === null) {
    missing.push(`the rating and the cost factor of ${entryHardening.level.name}`)
  }

  if (entryEccm.level.info === null || entryEccm.level.info2 === null) {
    missing.push(`the rating and the cost factor of ${entryEccm.level.name}`)
  }

  if (missing.length) {
    return unavailable({ rule: SENSOR_RULES.active, missing })
  }

  const design = combine({ rule: SENSOR_RULES.active, parts: { sizing: member.sizing }, compute: () => activeSensorDesign({ sizeHS: member.sizeHS, resolution: pair.resolution, strengthTech: tech.strength.info, emTech: tech.em.info, hardeningRating: entryHardening.level.info, hardeningCost: entryHardening.level.info2, eccmRating: entryEccm.level.info, eccmCost: entryEccm.level.info2, mode: member.mode }) })

  return marked(design, [...marksOf(tech, ['strength', 'em']), entryHardening.assumption, entryEccm.assumption].filter(Boolean))
}

const partOf = (design, field, units) => combine({ rule: SENSOR_RULES.active, parts: { design }, compute: (values) => values.design[field], units })

// What the chosen pair of an `activeSizing` costs at each hardening level and each ECCM level (`levels` { hardening, eccm } of `sensorTechOf`: the researched levels and the chosen hypothetical one): the BP, the Uridium (the hardening base) and the Corbomite (the ECCM increment) of both members, and whether the pair still reaches the wanted range against the jammer at that ECCM. The sizes stay those of the chosen pair.
export const hardeningEccmTradeoff = ({ sizing, tech = NO_SENSOR_TECH, levels = null } = {}) => {
  const figures = techOf(tech)
  const options = levels || figures.levels
  const pair = sizing && sizing.selected && sizing.selected.feasible ? sizing.selected : null

  if (!pair) {
    return { pair: null, rows: [] }
  }

  const { signature, fireControlSignature, wantedRangeKm, jammer, fireControlJammer } = sizing.request
  const rows = []

  for (const entryHardening of options.hardening) {
    for (const entryEccm of options.eccm) {
      const search = tradeoffMember({ member: pair.search, entryHardening, entryEccm, tech: figures, pair })
      const fireControl = tradeoffMember({ member: pair.fireControl, entryHardening, entryEccm, tech: figures, pair })
      const eccm = entryEccm.level.info === null ? null : Math.trunc(entryEccm.level.info)
      const ranges = [[search, signature, jammer], [fireControl, fireControlSignature, fireControlJammer]].map(([design, against, jamming]) => (isAvailable(design) ? reachOf({ rangeKm: design.value.rangeKm, resolution: pair.resolution, eccm, signature: against, jammer: jamming, source: design }) : unavailable({ rule: SENSOR_RULES.detection, missing: design.inputs.missing, units: 'km' })))
      const reach = shorterOf(ranges[0], ranges[1])
      const total = (field, units) => combine({ rule: SENSOR_RULES.active, parts: { search: partOf(search, field, units), 'missile fire control': partOf(fireControl, field, units) }, compute: (values) => values.search + values['missile fire control'], units })

      rows.push({ hardening: entryHardening, eccm: entryEccm, search, fireControl, cost: total('cost', 'BP'), uridium: total('uridium', 'Uridium'), corbomite: total('corbomite', 'Corbomite'), reach, meets: isAvailable(reach) && wantedRangeKm !== null ? reaches(reach.value, wantedRangeKm) : null, current: entryHardening.current && entryEccm.current })
    }
  }

  return { pair, rows }
}

// A passive sensor of `sizeHS` (thermal or EM), designed from the sensitivity tech of its kind and the hardening tech: the design and its sensitivity.
export const passiveProposal = ({ sizeHS = null, kind = 'thermal', tech = NO_SENSOR_TECH } = {}) => {
  const figures = techOf(tech)
  const role = kind === 'em' ? 'em' : 'thermal'
  const size = numberOf(sizeHS)
  const missing = [...(size > 0 ? [] : ['the sensor size in HS, above zero']), ...missingLines(figures, [role, 'hardening'])]
  const design = missing.length ? unavailable({ rule: SENSOR_RULES.passive, missing }) : marked(ofRule({ rule: SENSOR_RULES.passive, value: passiveSensorDesign({ sizeHS: size, sensitivityTech: figures[role].info, hardeningRating: figures.hardening.info, hardeningCost: figures.hardening.info2 }), inputs: { present: ['sensor size', LINE_LABELS[role].toLowerCase(), 'hardening'] } }), marksOf(figures, [role, 'hardening']))

  return { design, sensitivity: combine({ rule: SENSOR_RULES.passive, parts: { design }, compute: (values) => values.design.sensitivity }) }
}

// ---------- beam fire controls ----------

const LEGAL_MULTIPLIERS = new Set(FIRE_CONTROL_MULTIPLIERS)

const BEAM_ROLES = Object.freeze(['distance', 'speed', 'hardening', 'eccm'])

const SINGLE_WEAPON_MISSING = 'the single weapon fire control tech: the race has not researched it, so only a hypothetical choice of it gives a single weapon control'

// The weapon number of the control wanted as a result: a single weapon control reads the single-weapon tech (never researched means unavailable), an unrestricted one the multi-weapon level, which is 1 and assumed only when the race holds no weapon number row at all (a held row that stores no number leaves the weapon number unknown).
const weaponNumberOf = (tech, singleWeapon) => {
  const { weapons } = tech.singleWeapon
  const weapon = singleWeapon ? weapons.single : weapons.unrestricted

  if (weapons.currentUnknown || (!weapon && weapons.unknown.length)) {
    return unavailable({ rule: SENSOR_RULES.beam, missing: [`the weapon number of ${weapons.unknown.join(', ')}: the level is held but stores no number`] })
  }

  if (!weapon) {
    return singleWeapon ? unavailable({ rule: SENSOR_RULES.beam, missing: [SINGLE_WEAPON_MISSING] }) : envelope({ value: 1, status: STATUS.ASSUMED, rule: SENSOR_RULES.beam, inputs: { present: ['unrestricted control'] }, assumptions: ['the race holds no multi-weapon fire control tech, so unrestricted control is taken as a weapon number of 1'] })
  }

  return marked(ofRule({ rule: SENSOR_RULES.beam, value: weapon.number, inputs: { present: [weapon.level.name] } }), weapon.assumption ? [weapon.assumption] : [])
}

const beamInputsOf = (tech, weaponNumber) => ({ distanceRating: tech.distance.info, speedRating: tech.speed.info, weaponNumber, hardeningRating: tech.hardening.info, hardeningCost: tech.hardening.info2, eccmRating: tech.eccm.info, eccmCost: tech.eccm.info2 })

// The requirement of one axis (the range or the tracking speed), sized on its own: the rule separates the axes, so the other axis, the weapon number, the hardening and the ECCM stand in with neutral figures that the axis does not read.
const axisOf = ({ axis, wanted, tech }) => {
  const isRange = axis === 'range'
  const rating = isRange ? tech.distance : tech.speed
  const cap = BEAM_FIRE_CONTROL_MAX_RANGE_KM
  const missing = [...(wanted === null || !(wanted > 0) ? [isRange ? 'the wanted range, above zero' : 'the wanted tracking speed, above zero'] : []), ...(rating.info === null || !(rating.info > 0) ? [`the race's ${rating.label.toLowerCase()} tech, above zero`] : [])]
  const greatest = missing.length ? null : isRange ? Math.min(cap, FIRE_CONTROL_MULTIPLIERS[FIRE_CONTROL_MULTIPLIERS.length - 1] * rating.info) : fireControlTracking(FIRE_CONTROL_MULTIPLIERS[FIRE_CONTROL_MULTIPLIERS.length - 1], rating.info)
  const beyondCap = isRange && wanted !== null && wanted > cap
  const base = { axis, wanted, capKm: isRange ? cap : null, beyondCap, greatest }

  if (missing.length) {
    return Object.freeze({ ...base, status: 'unavailable', multiplier: null, exactMultiplier: null, smaller: null, reachKm: null, result: unavailable({ rule: SENSOR_RULES.sizing, missing }) })
  }

  const probe = beamFireControlForRequest({ rangeKm: isRange ? wanted : 1, trackingKmS: isRange ? 1 : wanted, distanceRating: isRange ? rating.info : 1, speedRating: isRange ? 1 : rating.info, weaponNumber: 1, hardeningRating: 0, hardeningCost: 0, eccmRating: 0, eccmCost: 0 })
  const value = probe.value[axis]
  const result = marked(ofRule({ rule: SENSOR_RULES.sizing, value, inputs: { present: [isRange ? 'wanted range' : 'wanted tracking speed', rating.label.toLowerCase()] } }), marksOf(tech, [isRange ? 'distance' : 'speed']))
  const sized = value.multiplier !== null

  return Object.freeze({ ...base, status: value.status, multiplier: value.multiplier, exactMultiplier: value.exactMultiplier, smaller: value.smaller, reachKm: sized ? (isRange ? Math.min(cap, value.multiplier * rating.info) : fireControlTracking(value.multiplier, rating.info)) : null, result })
}

const axisTile = (axis, units) => {
  if (axis.reachKm !== null) {
    return combine({ rule: SENSOR_RULES.beam, parts: { requirement: axis.result }, compute: () => axis.reachKm, units })
  }

  const missing = isAvailable(axis.result) ? [axis.beyondCap ? `a range within ${axis.capKm} km, which no fire control exceeds` : `a ${axis.axis === 'range' ? 'range' : 'tracking speed'} within the greatest the techs give, ${axis.greatest} ${units}`] : axis.result.inputs.missing

  return unavailable({ rule: SENSOR_RULES.beam, missing, units })
}

const specialOf = (design) => (isAvailable(design) ? design.value.specialFunction : null)

const tableDesign = ({ rangeMultiplier, trackingMultiplier, tech, weaponNumber }) => {
  const lacking = [...missingLines(tech, BEAM_ROLES), ...(isAvailable(weaponNumber) ? [] : weaponNumber.inputs.missing)]

  if (lacking.length) {
    return unavailable({ rule: SENSOR_RULES.beam, missing: lacking })
  }

  return marked(combine({ rule: SENSOR_RULES.beam, parts: { 'weapon number': weaponNumber }, compute: (values) => beamFireControlDesign({ rangeMultiplier, trackingMultiplier, ...beamInputsOf(tech, values['weapon number']) }) }), marksOf(tech, BEAM_ROLES))
}

// The beam fire control that reaches `rangeKm` and tracks `trackingKmS`, with the range requirement and the tracking requirement each reported on its own (a range above 1,400,000 km cannot claim reach: the game caps it there), the restriction ('single weapon' only when the race has researched or hypothetically chose the single-weapon tech, 'unrestricted' otherwise, the two always told apart), and a table of designs at multipliers (`multipliers` { range, tracking } of legal multipliers; the sized pair is added to it and flagged `proposed`).
export const beamSizing = ({ rangeKm = null, trackingKmS = null, tech = NO_SENSOR_TECH, singleWeapon = false, multipliers = {} } = {}) => {
  const figures = techOf(tech)
  const restricted = Boolean(singleWeapon)
  const weaponNumber = weaponNumberOf(figures, restricted)
  const wantedRange = numberOf(rangeKm)
  const wantedTracking = numberOf(trackingKmS)
  const range = axisOf({ axis: 'range', wanted: wantedRange, tech: figures })
  const tracking = axisOf({ axis: 'tracking', wanted: wantedTracking, tech: figures })
  const lacking = [...missingLines(figures, BEAM_ROLES), ...(isAvailable(weaponNumber) ? [] : weaponNumber.inputs.missing)]
  const request = lacking.length ? unavailable({ rule: SENSOR_RULES.sizing, missing: lacking }) : combine({ rule: SENSOR_RULES.sizing, parts: { request: marked(beamFireControlForRequest({ rangeKm: wantedRange, trackingKmS: wantedTracking, ...beamInputsOf(figures, weaponNumber.value) }), marksOf(figures, BEAM_ROLES)), 'weapon number': weaponNumber }, compute: (values) => values.request })
  const design = isAvailable(request) && request.value.design ? combine({ rule: SENSOR_RULES.beam, parts: { request }, compute: (values) => values.request.design }) : unavailable({ rule: SENSOR_RULES.beam, missing: isAvailable(request) ? ['a fire control that reaches the range and the tracking speed wanted'] : request.inputs.missing })
  const rangeList = (multipliers.range || DEFAULT_BEAM_MULTIPLIERS).filter((value) => LEGAL_MULTIPLIERS.has(value))
  const trackingList = (multipliers.tracking || DEFAULT_BEAM_MULTIPLIERS).filter((value) => LEGAL_MULTIPLIERS.has(value))
  const proposedPair = range.multiplier !== null && tracking.multiplier !== null ? [range.multiplier, tracking.multiplier] : null
  const pairs = unique([...rangeList.flatMap((first) => trackingList.map((second) => `${first}|${second}`)), ...(proposedPair ? [proposedPair.join('|')] : [])]).map((key) => key.split('|').map(Number))
  const rows = pairs.map(([rangeMultiplier, trackingMultiplier]) => {
    const rowDesign = tableDesign({ rangeMultiplier, trackingMultiplier, tech: figures, weaponNumber })
    const rowRangeKm = isAvailable(rowDesign) ? rowDesign.value.rangeKm : figures.distance.info === null ? null : Math.min(BEAM_FIRE_CONTROL_MAX_RANGE_KM, rangeMultiplier * figures.distance.info)

    return { rangeMultiplier, trackingMultiplier, proposed: Boolean(proposedPair) && proposedPair[0] === rangeMultiplier && proposedPair[1] === trackingMultiplier, design: rowDesign, rangeKm: rowRangeKm, rangeCapped: isAvailable(rowDesign) ? rowDesign.value.rangeCapped : figures.distance.info === null ? null : rangeMultiplier * figures.distance.info > BEAM_FIRE_CONTROL_MAX_RANGE_KM, wastedMultiplier: isAvailable(rowDesign) ? rowDesign.value.rangeCapped : false, specialFunction: specialOf(rowDesign) }
  }).sort((a, b) => a.rangeMultiplier - b.rangeMultiplier || a.trackingMultiplier - b.trackingMultiplier)

  return Object.freeze({
    restriction: Object.freeze({ state: restricted ? 'single weapon' : 'unrestricted', label: restricted ? 'Special function: single weapon' : 'Unrestricted control', offered: figures.singleWeapon.offersSingle, weaponNumber, specialFunction: restricted ? FIRE_CONTROL_SPECIAL.singleWeapon : FIRE_CONTROL_SPECIAL.none }),
    range,
    tracking,
    request,
    design,
    tiles: Object.freeze({
      range: axisTile(range, 'km'),
      tracking: axisTile(tracking, 'km/s'),
      size: combine({ rule: SENSOR_RULES.beam, parts: { design }, compute: (values) => values.design.sizeHS, units: 'HS' }),
      cost: combine({ rule: SENSOR_RULES.beam, parts: { design }, compute: (values) => values.design.cost, units: 'BP' }),
    }),
    table: Object.freeze({ rows: Object.freeze(rows) }),
  })
}

// One axis of a saved beam fire control: its stored figure as a result, whether it meets the wanted one (null when either is unknown) and, for a range given a `cap`, whether the stored figure is above it. A stored figure above the cap (a modded control) is kept as stored and is the one the check holds to the wanted range, as the combat rules compare the stored range; the result carries that as an assumption.
const axisCheck = ({ stored, wanted, label, cap = null }) => {
  const known = figureOf(stored)
  const aboveCap = cap !== null && known !== null && known > cap
  const assumptions = aboveCap ? [`the stored ${label} is above the ${cap} km a designed fire control is capped at: the stored figure is kept and is the one a shot is held to`] : []
  const result = known === null || !(known > 0) ? unavailable({ rule: SENSOR_RULES.beam, missing: [`the stored ${label}`] }) : ofRule({ rule: SENSOR_RULES.beam, value: known, inputs: { present: [`stored ${label}`] }, assumptions })

  return { result, wanted, aboveCap, meets: isAvailable(result) && wanted !== null ? reaches(result.value, wanted) : null }
}

// Each saved beam fire control against a range and a tracking speed: the stored range and tracking beside what is wanted, whether each axis meets it, and the axis that limits the control ('range', 'tracking' or 'both'; null when it meets or the answer is unknown).
export const existingBeamControls = ({ controls = [], rangeKm = null, trackingKmS = null } = {}) => {
  const wantedRange = positiveOf(rangeKm)
  const wantedTracking = positiveOf(trackingKmS)

  return controls.map((row) => {
    const range = axisCheck({ stored: row.rangeKm, wanted: wantedRange, label: 'range', cap: BEAM_FIRE_CONTROL_MAX_RANGE_KM })
    const tracking = axisCheck({ stored: row.trackingKmS, wanted: wantedTracking, label: 'tracking speed' })
    const falling = [range.meets === false ? 'range' : null, tracking.meets === false ? 'tracking' : null].filter(Boolean)
    const meets = falling.length ? false : range.meets === true && tracking.meets === true ? true : null

    return { row, range, tracking, meets, limiting: falling.length === 2 ? 'both' : falling.length ? falling[0] : null }
  })
}
