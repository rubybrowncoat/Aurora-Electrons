// The reconciliation of the sensors and fire controls a save stores with the design rules, for scripts/check-design-rules.js. Like missile-reconcile.js it takes the rules and loaders it is given and imports nothing, so a planted fault in either is seen by the comparison.

const isKnown = (value) => value !== null && value !== undefined && !Number.isNaN(value)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

// The tenth the modded saves store of the Uridium of a component and, mostly, of its other cost figures: the Uridium is the anchor that must agree at a tenth, and a cost figure that does not stays unexplained.
const COST_SCALE_TENTH = 0.1

// The roles whose tech row holds two figures: the rating and the cost factor.
const COST_ROLES = ['hardening', 'eccm']

// The reconciliation of the owned active sensors, missile fire controls, passive sensors and beam fire controls of a fixture (`loadSensorFixture`).
export const createSensorReconciler = ({ rules, data, basis }) => {
  const { activeSensorDesign, passiveSensorDesign, beamFireControlDesign, SENSOR_MODES, agrees } = rules
  const { SENSOR_COMPONENT_TYPES, SENSOR_TECH, sensorTechOf } = data

  const field = (name, column, kind, needs, value, { cost = false, source = null, anchor = false } = {}) => Object.freeze({ name, column, kind, needs, value, cost, source, anchor })

  const ACTIVE_FIELDS = Object.freeze([
    field('Strength', 'ComponentValue', 'decimal', ['size', 'strength'], (design) => design.strength, { source: 'strength' }),
    field('Range', 'MaxSensorRange', 'decimal', ['size', 'resolution', 'strength', 'em'], (design) => design.rangeKm),
    field('Cost', 'Cost', 'decimal', ['size', 'strength', 'hardeningCost', 'eccmCost'], (design) => design.cost, { cost: true }),
    field('Uridium', 'Uridium', 'decimal', ['size', 'strength', 'hardeningCost'], (design) => design.uridium, { cost: true, anchor: true }),
    field('Corbomite', 'Corbomite', 'decimal', ['size', 'strength', 'hardeningCost', 'eccmCost'], (design) => design.corbomite, { cost: true }),
    field('Crew', 'Crew', 'integer', ['size'], (design) => design.crew),
    field('HTK', 'HTK', 'integer', ['size'], (design) => design.htk),
    field('ECCM', 'ECCM', 'integer', ['eccm'], (design) => design.eccm),
    field('CTD', 'ElectronicCTD', 'integer', ['hardening'], (design) => design.ctd),
  ])

  const PASSIVE_FIELDS = Object.freeze([
    field('Sensitivity', 'ComponentValue', 'decimal', ['size', 'sensitivity'], (design) => design.sensitivity, { source: 'sensitivity' }),
    field('Cost', 'Cost', 'decimal', ['size', 'sensitivity', 'hardeningCost'], (design) => design.cost, { cost: true }),
    field('Uridium', 'Uridium', 'decimal', ['size', 'sensitivity', 'hardeningCost'], (design) => design.uridium, { cost: true, anchor: true }),
    field('Crew', 'Crew', 'integer', ['size'], (design) => design.crew),
    field('HTK', 'HTK', 'integer', ['size'], (design) => design.htk),
    field('CTD', 'ElectronicCTD', 'integer', ['hardening'], (design) => design.ctd),
  ])

  const FIRE_CONTROL_NEEDS = ['rangeMultiplier', 'trackingMultiplier', 'distance', 'speed', 'singleWeapon', 'hardeningCost', 'eccmCost']

  const BEAM_FIELDS = Object.freeze([
    field('Range', 'ComponentValue', 'decimal', ['rangeMultiplier', 'distance'], (design) => design.rangeKm, { source: 'distance' }),
    field('Tracking', 'TrackingSpeed', 'integer', ['trackingMultiplier', 'speed'], (design) => design.trackingKmS, { source: 'speed' }),
    field('Size', 'Size', 'decimal', ['rangeMultiplier', 'trackingMultiplier', 'singleWeapon'], (design) => design.sizeHS),
    field('Cost', 'Cost', 'decimal', FIRE_CONTROL_NEEDS, (design) => design.cost, { cost: true }),
    field('Uridium', 'Uridium', 'decimal', ['rangeMultiplier', 'trackingMultiplier', 'distance', 'speed', 'singleWeapon', 'hardeningCost'], (design) => design.uridium, { cost: true, anchor: true }),
    field('Corbomite', 'Corbomite', 'decimal', FIRE_CONTROL_NEEDS, (design) => design.corbomite, { cost: true }),
    field('Crew', 'Crew', 'integer', ['rangeMultiplier', 'trackingMultiplier', 'singleWeapon'], (design) => design.crew),
    field('HTK', 'HTK', 'integer', ['rangeMultiplier', 'trackingMultiplier', 'singleWeapon'], (design) => design.htk),
    field('ECCM', 'ECCM', 'integer', ['eccm'], (design) => design.eccm),
    field('CTD', 'ElectronicCTD', 'integer', ['hardening'], (design) => design.ctd),
    field('SpecialFunction', 'SpecialFunction', 'integer', ['trackingMultiplier', 'singleWeapon'], (design) => design.specialFunction),
  ])

  // What each component type is: its kind, the tech roles it reads (the tech types of SENSOR_TECH, found by type), its fields and the design the rules make of it from its stored size and the techs.
  const KINDS = Object.freeze({
    [SENSOR_COMPONENT_TYPES.active]: Object.freeze({
      kind: 'active',
      roles: { strength: 'strength', em: 'em', hardening: 'hardening', eccm: 'eccm' },
      fields: ACTIVE_FIELDS,
      design: (row, t) => activeSensorDesign({ sizeHS: row.Size, resolution: row.Resolution, strengthTech: t.strength.info, emTech: t.em.info, hardeningRating: t.hardening.info, hardeningCost: t.hardening.info2, eccmRating: t.eccm.info, eccmCost: t.eccm.info2, mode: SENSOR_MODES.search }),
      implied: (row) => (row.Size > 0 ? { strength: row.ComponentValue / row.Size } : {}),
    }),
    [SENSOR_COMPONENT_TYPES.missileFireControl]: Object.freeze({
      kind: 'missileFireControl',
      roles: { strength: 'strength', em: 'em', hardening: 'hardening', eccm: 'eccm' },
      fields: ACTIVE_FIELDS,
      design: (row, t) => activeSensorDesign({ sizeHS: row.Size, resolution: row.Resolution, strengthTech: t.strength.info, emTech: t.em.info, hardeningRating: t.hardening.info, hardeningCost: t.hardening.info2, eccmRating: t.eccm.info, eccmCost: t.eccm.info2, mode: SENSOR_MODES.missileFireControl }),
      implied: (row) => (row.Size > 0 ? { strength: row.ComponentValue / row.Size } : {}),
    }),
    [SENSOR_COMPONENT_TYPES.thermal]: Object.freeze({
      kind: 'thermal',
      roles: { sensitivity: 'thermal', hardening: 'hardening' },
      fields: PASSIVE_FIELDS,
      design: (row, t) => passiveSensorDesign({ sizeHS: row.Size, sensitivityTech: t.sensitivity.info, hardeningRating: t.hardening.info, hardeningCost: t.hardening.info2 }),
      implied: (row) => (row.Size > 0 ? { sensitivity: row.ComponentValue / row.Size } : {}),
    }),
    [SENSOR_COMPONENT_TYPES.em]: Object.freeze({
      kind: 'em',
      roles: { sensitivity: 'em', hardening: 'hardening' },
      fields: PASSIVE_FIELDS,
      design: (row, t) => passiveSensorDesign({ sizeHS: row.Size, sensitivityTech: t.sensitivity.info, hardeningRating: t.hardening.info, hardeningCost: t.hardening.info2 }),
      implied: (row) => (row.Size > 0 ? { sensitivity: row.ComponentValue / row.Size } : {}),
    }),
    [SENSOR_COMPONENT_TYPES.beamFireControl]: Object.freeze({
      kind: 'beamFireControl',
      roles: { distance: 'distance', speed: 'speed', singleWeapon: 'singleWeapon', hardening: 'hardening', eccm: 'eccm' },
      fields: BEAM_FIELDS,
      rangeLimited: true,
      design: (row, t, options) => beamFireControlDesign({ rangeMultiplier: row.FCRangeModifier, trackingMultiplier: row.FCSpeedModifier, distanceRating: t.distance.info, speedRating: t.speed.info, weaponNumber: t.singleWeapon.info, hardeningRating: t.hardening.info, hardeningCost: t.hardening.info2, eccmRating: t.eccm.info, eccmCost: t.eccm.info2, ...(options.uncapped ? { maxRangeKm: Infinity } : {}) }),
      implied: (row) => ({ ...(row.FCRangeModifier > 0 ? { distance: row.ComponentValue / row.FCRangeModifier } : {}), ...(row.FCSpeedModifier > 0 ? { speed: row.TrackingSpeed / row.FCSpeedModifier } : {}) }),
    }),
  })

  // The inputs a component's row gives apart from its techs: a figure the rules need that the row does not store is unknown (never 0).
  const rowInputs = (row, kind) => {
    const inputs = { size: { resolved: finite(row.Size) && row.Size > 0, reason: 'the save stores no size above zero' } }

    if (kind === 'active' || kind === 'missileFireControl') {
      inputs.resolution = { resolved: finite(row.Resolution) && row.Resolution > 0, reason: 'the save stores no resolution above zero' }
    }

    if (kind === 'beamFireControl') {
      inputs.rangeMultiplier = { resolved: finite(row.FCRangeModifier) && row.FCRangeModifier > 0, reason: 'the save stores no range multiplier above zero' }
      inputs.trackingMultiplier = { resolved: finite(row.FCSpeedModifier) && row.FCSpeedModifier > 0, reason: 'the save stores no tracking multiplier above zero' }
    }

    return inputs
  }

  // The techs of a component by role, each found by the tech type among its slots: { resolved, info, info2, id, slot, reason }. A tech the component does not name, names twice or names by an id the save does not hold has `resolved` false and `info` NaN, never 0; a tech row that stores no number in AdditionalInfo (`info`) is unresolved the same way, and one that stores none in AdditionalInfo2 (`info2`) has `info2` NaN. The hardening and ECCM techs carry two figures, the rating (`info`) and the cost factor (`info2`), so each also has a role of its own for the factor (`hardeningCost`, `eccmCost`): a missing factor makes only the figures that need it unknown.
  const techsOf = (fixture, row, spec) => {
    const techs = {}

    for (const [role, name] of Object.entries(spec.roles)) {
      const found = sensorTechOf(fixture, row, SENSOR_TECH[name])

      if (found.state !== 'resolved') {
        techs[role] = { resolved: false, info: NaN, info2: NaN, id: null, slot: null, reason: found.reason }

        if (COST_ROLES.includes(role)) {
          techs[`${role}Cost`] = { resolved: false, info2: NaN, reason: found.reason }
        }

        continue
      }

      const info = finite(found.info) ? found.info : NaN
      const info2 = finite(found.info2) ? found.info2 : NaN

      techs[role] = { resolved: Number.isFinite(info), info, info2, id: found.id, slot: found.slot, reason: Number.isFinite(info) ? null : `tech ${found.id} of ${role} stores no number in AdditionalInfo` }

      if (COST_ROLES.includes(role)) {
        techs[`${role}Cost`] = { resolved: Number.isFinite(info2), info2, reason: Number.isFinite(info2) ? null : `tech ${found.id} of ${role} stores no number in AdditionalInfo2` }
      }
    }

    return techs
  }

  const knownFigure = (value) => (isKnown(value) && Number.isFinite(value) ? value : null)

  // The figures of a component for one set of techs: [{ spec field, computed }], computed null when a role the field needs is unresolved. `scale` multiplies the cost figures; `uncapped` lifts the range limit of a fire control.
  const evaluate = (spec, row, inputs, techs, { scale = 1, uncapped = false } = {}) => {
    const pool = { ...inputs, ...techs }
    const missing = (needs) => needs.filter((name) => !pool[name].resolved).map((name) => pool[name].reason)
    const design = spec.design(row, techs, { uncapped })

    return spec.fields.map((entry) => {
      const unresolved = missing(entry.needs)

      return { entry, computed: unresolved.length ? null : knownFigure(entry.value(design) * (entry.cost ? scale : 1)), reason: unresolved.length ? [...new Set(unresolved)].join('; ') : null }
    })
  }

  const verdictOf = (kind, stored, computed) => {
    if (!isKnown(stored) || !isKnown(computed)) {
      return 'unknown'
    }

    return (kind === 'integer' ? Number(stored) === Number(computed) : agrees(Number(stored), Number(computed))) ? 'agree' : 'differ'
  }

  const labelOf = (role) => ({ strength: 'active sensor strength', sensitivity: 'sensitivity', distance: 'distance rating', speed: 'speed rating' })[role] || role

  // The figures of a component the rules do not give at its tech rows, each with the reading of an alternative that reaches it, for the report only (a difference is explained by a pinned row, never by this): a whole alternative of the techs the stored figures imply, of the cost figures a tenth and of a fire control's range left uncapped. The alternative that makes the most differing figures agree is the one named (the fewest changes on a tie), and only when it is corroborated: techs implied by a stored figure count only when another stored figure, one the implied tech does not come from, differed at the tech row and agrees at the implied tech; a tenth only when every known cost figure of the component agrees at a tenth. A figure no alternative reaches has none. Returns a Map of field name to the reading.
  const alternativesOf = (spec, row, inputs, techs, base) => {
    const stateOf = (item) => verdictOf(item.entry.kind, row[item.entry.column], item.computed)
    const differing = base.filter((item) => stateOf(item) === 'differ')
    const explained = new Map()

    if (!differing.length) {
      return explained
    }

    const implied = spec.implied(row)
    const impliedRoles = Object.keys(implied).filter((role) => techs[role].resolved && finite(implied[role]) && !agrees(implied[role], techs[role].info))
    const impliedTechs = Object.fromEntries(Object.entries(techs).map(([role, tech]) => [role, impliedRoles.includes(role) ? { ...tech, info: implied[role] } : tech]))
    const costFigures = base.filter((item) => item.entry.cost)
    const limited = Boolean(spec.rangeLimited) && finite(row.ComponentValue) && row.ComponentValue > rules.BEAM_FIRE_CONTROL_MAX_RANGE_KM
    const attempts = []

    for (const uncapped of limited ? [false, true] : [false]) {
      for (const roles of impliedRoles.length ? [[], impliedRoles] : [[]]) {
        for (const scale of costFigures.length ? [1, COST_SCALE_TENTH] : [1]) {
          if (uncapped || roles.length || scale !== 1) {
            attempts.push({ uncapped, roles, scale, changes: Number(uncapped) + Number(roles.length > 0) + Number(scale !== 1) })
          }
        }
      }
    }

    let best = null

    for (const attempt of attempts.sort((a, b) => a.changes - b.changes)) {
      const alternative = evaluate(spec, row, inputs, attempt.roles.length ? impliedTechs : techs, attempt)
      const stateAt = (item) => stateOf({ entry: item.entry, computed: alternative[base.indexOf(item)].computed })
      const agreeing = differing.filter((item) => stateAt(item) === 'agree')
      const sources = new Set(attempt.roles.map((role) => spec.fields.find((entry) => entry.source === role)).filter(Boolean).map((entry) => entry.name))
      const corroborated = !attempt.roles.length || agreeing.some((item) => !sources.has(item.entry.name) && item.entry.needs.some((role) => attempt.roles.includes(role)))
      const tenthHolds = attempt.scale === 1 || costFigures.filter((item) => item.entry.anchor).every((item) => stateAt(item) === 'agree')

      if (agreeing.length && corroborated && tenthHolds && (!best || agreeing.length > best.agreeing.length)) {
        best = { attempt, agreeing }
      }
    }

    if (best) {
      const parts = []

      for (const role of best.attempt.roles) {
        parts.push(`the tech row holds ${labelOf(role)} ${Number(techs[role].info.toPrecision(10))} but the stored figures imply ${Number(implied[role].toPrecision(10))}, at which they agree`)
      }

      if (best.attempt.uncapped) {
        parts.push(`the save stores the range uncapped, above the ${rules.BEAM_FIRE_CONTROL_MAX_RANGE_KM} km limit the rules apply, and the figures that follow the range are those of the stored one`)
      }

      if (best.attempt.scale !== 1) {
        parts.push('the stored cost figures are one tenth of the rule\'s, and the cause is not identified')
      }

      for (const item of best.agreeing) {
        explained.set(item.entry.name, parts.join('; '))
      }
    }

    return explained
  }

  // One owned component against its stored row: every figure the rules rebuild from its techs, as { field, scope, stored, computed, kind, basis, reason, alternative } for `judge`/`classify` of the missile library, plus the techs each role resolved to. `alternative` is a diagnostic only, the reading of the stored figure the closest alternative gives; it never explains a difference, so a difference is explained only by a pinned row of the harness. A figure whose tech role is missing, named twice, not held by the save or without the number it needs is unknown with the reason, never 0.
  const reconcileSensor = (fixture, component) => {
    const row = component.row
    const spec = KINDS[row.ComponentTypeID]

    if (!spec) {
      throw new Error(`Component ${component.id} of type ${row.ComponentTypeID} is not a sensor or fire control`)
    }

    const inputs = rowInputs(row, spec.kind)
    const techs = techsOf(fixture, row, spec)
    const base = evaluate(spec, row, inputs, techs)
    const alternatives = alternativesOf(spec, row, inputs, techs, base)
    const comparisons = base.map((item) => ({ field: item.entry.name, scope: spec.kind, stored: knownFigure(row[item.entry.column]), computed: item.computed, kind: item.entry.kind, basis: basis.REPRODUCED, reason: item.reason, alternative: alternatives.get(item.entry.name) || null }))
    const roles = Object.fromEntries(Object.keys(spec.roles).map((role) => [role, { resolved: techs[role].resolved, id: techs[role].id, slot: techs[role].slot, info: techs[role].resolved ? techs[role].info : null, info2: Number.isFinite(techs[role].info2) ? techs[role].info2 : null, reason: techs[role].reason }]))

    return { id: component.id, name: row.Name, kind: spec.kind, roles, comparisons }
  }

  return { reconcileSensor, SENSOR_KINDS: KINDS }
}
