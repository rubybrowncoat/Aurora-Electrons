// The redeployment queue of the race's mining assets: the mines of a colony whose body has no deposit left and the orbital miners of a fleet that sits at a body that is empty, exhausted, wider than the race's orbital mining limit or has no colony of the race. Each recommendation states why the asset is stuck, how many mines or ships and modules it holds, what a destination has to satisfy as far as the save and the rules settle it, and the inputs a relocation estimate would need but the save does not give. A destination is not chosen here, so travel and what the assets would dig there are always unknown; so is every stored value that decides a reason. A reason the save cannot decide (an unsurveyed body, a missing diameter limit, an amount not stored) is never read as met or as failing. Evidence: docs/plans/backlog/evidence/AE-057-01.md.

import { RADIATION_LIMIT, VERSION_INPUT, all, any, depositState, known, positive } from './mining-sites'
import { registerRule } from './provenance'

registerRule({
  id: 'miningRedeployment.queue',
  versions: ['2.7.x'],
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue, Workers, CivilianInstallation', 'FCT_MineralDeposit.Amount', 'FCT_SystemBodySurveys', 'FCT_Fleet.OrbitBodyID, AssignedPopulationID, Speed', 'FCT_SystemBody.Radius', 'FCT_Race.MaximumOrbitalMiningDiameter, MineProduction', 'FCT_ShipClass.MiningModules', 'FCT_Population.SystemBodyID'],
  note: 'Mines are queued when their colony\'s body is surveyed and holds no deposit above 0 t (stored rows at 0 t are exhausted; no row at all is empty, since the save does not tell a body mined out from one that never had a deposit); civilian complexes are not queued. Orbital miners (fleets without orders, any ship with mining modules, so a ship with one module counts) are queued when their body is exhausted or empty, wider than the race\'s stored orbital mining limit, or has no colony of the race to take the output; these reasons add up, so a body can be both exhausted and too wide. A fleet that fails only for another prerequisite (every module damaged, no crew, assigned to another colony, no race mine production) is not queued, since moving does not fix it; those are named beside a queued asset. A body the race has not surveyed, a diameter limit or diameter not stored, a deposit amount not stored and the colony rules on a save whose game rules are not known are unknown: such an asset is not queued on that reason, and one with no other reason is listed apart as not evaluated. No destination is chosen, so the route, the travel time and the output at a destination are listed as unknown inputs; the fleet\'s stored speed is shown, never a travel time.',
  assumptions: ['A deposit row at 0 t or less is exhausted.', 'A body with a survey and no deposit row is empty: mined out or never deposited.', 'A fleet not assigned to a colony, or assigned to one that is gone, is assigned to the colony on its body.'],
})

const DESTINATION_INPUT = 'the destination body and the route to it'
const OUTPUT_INPUT = 'what the assets would dig at a destination (the accessibility of its deposits)'
const FREIGHT_INPUT = 'the freight capacity that can carry the mines'
const SPEED_INPUT = 'the fleet\'s speed'
const LIMIT_INPUT = 'the race\'s orbital mining diameter limit'
const MINES_INPUT = 'the amount or the type of an installation of the colony'

// The prerequisites of a mining site (mining-sites.js) whose failing is cured by moving the asset, and the word each failing goes by.
const REDEPLOY = ['deposit', 'diameter', 'colony']

const reasonKey = (need, row) => (need.key === 'deposit' ? (depositState(row) === 'exhausted' ? 'exhausted' : 'empty') : need.key === 'diameter' ? 'oversized' : 'unsupported')

// A requirement of a destination: `known` when the save and the rules settle it, else unknown with the `inputs` that would.
const requirement = (key, text, settled, inputs = []) => (settled ? { key, text, state: 'known', inputs: [] } : { key, text, state: 'unknown', inputs })

const unique = (list) => [...new Set(list)]

// The mines of a colony as installation counts, or null while a count is not known (an installation row could not be read).
const mineCounts = (row) => {
  const readable = known(row.MannedMines) && known(row.AutomatedMines) && !(row.MineGaps > 0)

  return { manned: readable ? row.MannedMines : null, automated: readable ? row.AutomatedMines : null, total: readable ? row.MannedMines + row.AutomatedMines : null }
}

const groundConstraints = (row, { supported, count }) => [
  requirement('colony', 'a colony of the race on the destination body to land the mines at', true),
  requirement('deposit', 'a surveyed body with a mineral deposit above 0 t', true),
  ...(row.MannedMines === 0 && !(row.MineGaps > 0) ? [] : [requirement('workforce', 'a workforce for the manned mines (the colony\'s efficiency above 0)', supported.surface, [VERSION_INPUT])]),
  requirement('radiation', `radiation under ${count(RADIATION_LIMIT)}`, supported.surface, [VERSION_INPUT]),
  requirement('export', 'a way out for the minerals (mass drivers at both ends in one system, a loading order or use on the spot)', supported.delivery, [VERSION_INPUT]),
]

const orbitalConstraints = (row, { supported, count }) => [
  requirement('diameter', known(row.MaximumDiameter) ? `a body no more than ${count(row.MaximumDiameter)} km across` : 'a body within the race\'s orbital mining diameter limit', known(row.MaximumDiameter), [LIMIT_INPUT]),
  requirement('deposit', 'a surveyed body with a mineral deposit above 0 t', true),
  requirement('colony', 'a colony of the race on the body to take the output', supported.orbital, [VERSION_INPUT]),
  requirement('assignment', 'the fleet assigned to that colony (an unassigned fleet is assigned to the colony on its body)', supported.orbital, [VERSION_INPUT]),
]

// The prerequisites that travel with the asset (a damaged module, no crew, a race without mine production): moving does not fix them. The rest of the other prerequisites (radiation, workforce, the fleet's assignment) belong to the colony it works for, so a destination can cure them.
const CARRIED = ['modules', 'crew', 'mineProduction']

const otherNeeds = (site, state) => site.prerequisites.filter((need) => need.state === state && !REDEPLOY.includes(need.key))

// The inputs the other prerequisites of a site would need while they are not known (a crew, the race's mine production, a radiation level): a relocation estimate lacks them as well, whatever the reason that queues the asset.
const otherInputs = (site) => unique(otherNeeds(site, 'unknown').flatMap((need) => need.inputs))

const otherParts = (site) => {
  const others = otherNeeds(site, 'missing')

  return { others, carried: others.filter((need) => CARRIED.includes(need.key)), current: others.filter((need) => !CARRIED.includes(need.key)) }
}

const groundOf = (site, options) => {
  const { row } = site
  const deposit = site.prerequisites.find((need) => need.key === 'deposit')
  const present = any(positive(row.MannedMines, row.MineGaps), positive(row.AutomatedMines, row.MineGaps))
  const gone = deposit.state === 'missing' ? 1 : deposit.state === 'met' ? 0 : null
  const verdict = all(present, gone)
  const counts = mineCounts(row)
  const undecided = deposit.state === 'unknown' ? [deposit] : []
  const stored = unique([...undecided.flatMap((need) => need.inputs), ...(present === null || counts.total === null ? [MINES_INPUT] : [])])

  return {
    kind: 'colony',
    id: site.id,
    row,
    verdict,
    reasons: deposit.state === 'missing' ? [{ key: reasonKey(deposit, row), need: deposit }] : [],
    undecided,
    ...otherParts(site),
    assets: { kind: 'ground', ...counts },
    constraints: groundConstraints(row, options),
    unknown: { travel: [DESTINATION_INPUT, FREIGHT_INPUT], production: unique([OUTPUT_INPUT, ...otherInputs(site)]), stored },
  }
}

const orbitalOf = (site, options) => {
  const { row } = site
  const found = REDEPLOY.map((key) => site.prerequisites.find((need) => need.key === key)).filter(Boolean)
  const reasons = found.filter((need) => need.state === 'missing').map((need) => ({ key: reasonKey(need, row), need }))
  const undecided = found.filter((need) => need.state === 'unknown')
  const constraints = orbitalConstraints(row, options)

  return {
    kind: 'fleet',
    id: site.id,
    row,
    verdict: reasons.length ? 1 : undecided.length ? null : 0,
    reasons,
    undecided,
    ...otherParts(site),
    assets: { kind: 'orbital', ships: site.ships, modules: site.modules, working: site.workingModules, speed: known(row.Speed) ? row.Speed : null },
    constraints,
    unknown: { travel: [DESTINATION_INPUT, ...(known(row.Speed) ? [] : [SPEED_INPUT])], production: unique([OUTPUT_INPUT, ...otherInputs(site), ...site.shipInputs]), stored: unique(undecided.flatMap((need) => need.inputs)) },
  }
}

// The queue from the sites `assessMiningSites` (mining-sites.js) returns: `{ ground, orbital }`, one recommendation per colony with mines and per fleet of orbital miners, each with a `verdict` of 1 (queued), 0 (not) or null (not decided, with the `unknown.stored` inputs that decide it). `count` formats a figure in a text.
export const assessRedeployment = ({ colonies, fleets, supported }, { count = (value) => String(value) } = {}) => {
  const options = { supported, count }

  return { ground: colonies.filter((site) => site.surface).map((site) => groundOf(site, options)), orbital: fleets.map((site) => orbitalOf(site, options)) }
}

// The inputs a recommendation lacks, all of them: the stored values that decide a reason, then travel and production.
export const unknownInputs = (recommendation) => [...recommendation.unknown.stored, ...recommendation.unknown.travel, ...recommendation.unknown.production]

// What a recommendation states of its assets as text, and the stored inputs that a figure of it lacks (empty when all are known): `3 mines (2 manned, 1 automated)`, `2 ships, 6 modules (5 working), at 1 km/s`.
export const assetText = (assets, count) => {
  if (assets.kind === 'ground') {
    return { text: assets.total === null ? 'mines not counted' : `${count(assets.total)} ${assets.total === 1 ? 'mine' : 'mines'} (${count(assets.manned)} manned, ${count(assets.automated)} automated)`, lacking: assets.total === null ? [MINES_INPUT] : [] }
  }

  const modules = known(assets.modules) ? `${count(assets.modules)} ${assets.modules === 1 ? 'module' : 'modules'}${known(assets.working) ? ` (${count(assets.working)} working)` : ''}` : 'modules not stored'
  const lacking = [...(known(assets.modules) ? [] : ['the mining modules of a ship class']), ...(known(assets.working) ? [] : ['the class components of a ship', 'the damaged components of a ship'])]

  return { text: `${count(assets.ships)} ${assets.ships === 1 ? 'ship' : 'ships'}, ${modules}${known(assets.speed) ? `, at ${count(assets.speed)} km/s` : ''}`, lacking: unique(lacking) }
}
