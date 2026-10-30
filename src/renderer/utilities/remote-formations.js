// Remote ground formations as the Galaxy Map and the Survey Progress table show them, read from the shared model of the race's formations (utilities/ground-formations.js). A formation is remote when it is stationed at no colony of the race (`formationPlace`); its role is geological, xenoarchaeology or other, from the model's own ratings (`formationRoles`), and one with both ratings is one formation that shows under both roles. The map marks the systems that hold remote formations of the selected roles, with counts; the table lists each formation once with its system or the reasons it has none. A system is known only when the race stores its survey name, so a formation whose system is not known has no mark and no coordinates.

import { formationPlace, formationRoles, groupBySystem, roleTotals } from './ground-formations'

// The roles the filter offers, in the order shown. `unknown` is the formations whose ratings leave no role to count them under; the pages show it only where there are some.
export const ROLE_OPTIONS = Object.freeze([
  { value: 'geo', text: 'Geological' },
  { value: 'xeno', text: 'Xenoarchaeology' },
  { value: 'other', text: 'Other' },
  { value: 'unknown', text: 'Role not known' },
])

const ROLE_KEYS = ROLE_OPTIONS.map((option) => option.value)

// The words of a formation's place and of its roles, which the table shows and sorts by.
const WHERE_TEXT = Object.freeze({ true: 'Remote', false: 'At a colony', null: 'Not known' })
const roleLabel = (roles) => (roles.undetermined ? 'Not known' : roles.list.map((role) => ROLE_OPTIONS.find((option) => option.value === role).text).join(' · '))

// The role filter as one view preference of the race, shared by the Galaxy Map and Survey Progress (`persistedView`, mixins/persisted-view.js): the roles that are on. A stored value keeps only the roles still offered.
export const rolesView = Object.freeze({ key: 'groundRoles', scope: 'race', default: Object.freeze(ROLE_KEYS.slice()), normalise: (stored) => (Array.isArray(stored) ? ROLE_KEYS.filter((role) => stored.includes(role)) : undefined) })

// The table's Remote only switch, a view preference of the race.
export const remoteOnlyView = Object.freeze({ key: 'groundRemoteOnly', scope: 'race', default: true })

// What the pages say remote means.
export const REMOTE_DEFINITION = 'Remote is this page\'s own definition, not a rule of the game: a formation is remote when it is stationed at no colony of the race, whether embarked on a ship, under way or parked in a colony\'s system, stored with no location, or at the colony of another race. A colony is a population record, with or without residents, and a ship in a colony\'s system does not put its formations at the colony. A formation at a colony of the race is never remote, and one whose colony the save does not hold is left out of the marks.'

// The map legend's short form of it.
export const REMOTE_LEGEND = 'Remote, as defined here: stationed at no colony of the race (embarked on a ship, stored with no location, or at the colony of another race); a ship in a colony\'s system does not put its formations at the colony'

// Whether a formation with `roles` (`formationRoles`) is in one of the `selected` roles.
export const inRoles = (roles, selected) => (roles.undetermined ? selected.includes('unknown') : roles.list.some((role) => selected.includes(role)))

// The systems that hold remote formations of the selected roles, keyed by SystemID as a string (`groupBySystem`); each system's `formations` lists them once. A formation whose colony the save does not hold (remote null) is not among them.
export const remoteSystems = (model, selected) => groupBySystem(model, (_node, place, roles) => place.remote === true && inRoles(roles, selected))

// The formations by what holds them, for a row's Held by column.
const heldBy = (node) => {
  const { location } = node

  if (location.kind === 'colony') {
    return location.population && location.population.name ? `Colony ${location.population.name}` : `Colony ${location.population ? location.population.id : ''}`.trim()
  }

  if (location.kind === 'ship') {
    return location.ship && location.ship.name ? `Ship ${location.ship.name}${location.ship.carriedBy ? `, carried by ${location.ship.carriedBy.name}` : ''}` : `Ship ${location.ship ? location.ship.id : ''}`.trim()
  }

  return 'Nothing stored'
}

// One row per formation of the model, once, for the table: the formation, its place (`formationPlace`: remote true, false or null; the system when known; the reasons when not), its roles and the ratings behind them (null where unknown).
export const formationRows = (model) => model.formations.map((node) => {
  const place = formationPlace(node, model)
  const roles = formationRoles(node)

  return { id: node.id, name: node.name || `Formation ${node.id}`, abbreviation: node.abbreviation, remote: place.remote, where: WHERE_TEXT[place.remote], kind: place.kind, heldBy: heldBy(node), system: place.system, systemName: place.system ? place.system.name : '', reasons: place.reasons, roles, roleLabel: roleLabel(roles), geo: node.geo.value, xeno: node.xeno.value, mass: node.mass.value }
})

// The rows the table shows: the selected roles, and with `remoteOnly` the formations that are remote or not known not to be (a formation whose colony the save does not hold stays visible, with its reason).
export const selectRows = (rows, { roles, remoteOnly }) => rows.filter((row) => inRoles(row.roles, roles) && (!remoteOnly || row.remote !== false))

// The counts the table's chips and foot state, over the rows in scope (`remoteOnly` as in `selectRows`): { formations, remote, atColonies, remoteUnknown, ...roleTotals } with the role totals of `roleTotals` and `placed` and `unplaced` the formations with and without a known system.
export const rowTotals = (model, { remoteOnly }) => {
  const inScope = (_node, place) => !remoteOnly || place.remote !== false
  const totals = roleTotals(model, inScope)
  const all = groupBySystem(model, inScope)
  let remote = 0
  let remoteUnknown = 0

  model.formations.forEach((node) => {
    const { remote: state } = formationPlace(node, model)

    remote += state === true ? 1 : 0
    remoteUnknown += state === null ? 1 : 0
  })

  return { ...totals, placed: all.formations - all.unplaced.length, unplaced: all.unplaced.length, remote, remoteUnknown, atColonies: model.formations.length - remote - remoteUnknown }
}

// The sentence for a system's remote formations of the selected roles: `entry` is one value of `remoteSystems(...).systems`.
export const systemText = (entry, count) => {
  const present = ROLE_OPTIONS.filter((option) => entry.roles[option.value])
  const parts = present.map((option) => `${count(entry.roles[option.value])} ${option.text.toLowerCase()}`)

  return present.length === 1 && entry.roles[present[0].value] === entry.formations.length ? parts[0] : `${count(entry.formations.length)} (${parts.join(', ')})`
}
