// The route audit of the Hauling page: the stored queues (utilities/route-queues.js) read as fleet records, grouped into routes, covered by what the page has worked out for each fleet and set beside the player's desired routes. The grouping and the coverage rules are utilities/route-signatures.js; this puts them together for the page.

import { coverDesires, coverGroups, describeFleet, groupRoutes, relationOf, routeName, templateIndex } from './route-signatures'

// The relations a group lists to another: a shared route is one group, a shared hub says nothing about duplication.
const LISTED_RELATIONS = new Set(['same-route-conditions', 'same-flows-path', 'same-flows-service', 'reversed', 'same-pair', 'partial'])

const NO_YEAR = null

// What the page has worked out for one fleet, as `memberState` (utilities/route-signatures.js) takes it. `row` is the fleet's row of the page's routes (null when the page has none: a fleet with no ships or no hold is not timed), `ships` its ship rows. `holds` is true when a ship has a hold, false when every ship's capacities are known and none is above zero, null when a capacity is not in the save and no ship has a hold.
export const figureOf = (row, ships) => {
  const capacities = ships.flatMap((ship) => [ship.CargoCapacity, ship.ColonistCapacity])
  const holds = capacities.some((capacity) => capacity > 0) ? true : capacities.every((capacity) => Number.isFinite(capacity)) ? false : null

  if (!row) {
    return { ships: ships.length, holds, profile: 'unknown', traced: false, blocked: 0, unknown: 0, moving: false, year: NO_YEAR }
  }

  const { year } = row

  return { ships: ships.length, holds: true, profile: row.profile.status, traced: row.route.km !== null, blocked: row.blocked.length, unknown: row.unknown.length, moving: row.Speed > 0, year: year ? { minerals: year.minerals, installations: year.installations, colonists: year.colonists, trips: year.trips } : NO_YEAR }
}

// The queue records of every fleet the read gave, from the stored orders alone. `queues` is `loadRouteQueues`' answer, `ships` the ship rows by fleet (for the fuel conditions).
export const recordsOf = (queues, { raceId, ships = {} }) => {
  const orders = {}
  const conditionals = {}

  queues.orders.forEach((order) => (orders[order.FleetID] = orders[order.FleetID] || []).push(order))
  queues.conditionals.forEach((row) => (conditionals[row.FleetID] = conditionals[row.FleetID] || []).push(row))

  return queues.fleets.map((fleet) => describeFleet(fleet, orders[fleet.FleetID] || [], { actions: queues.actions, raceId, conditionals: conditionals[fleet.FleetID] || [], standing: queues.standing[fleet.FleetID] || 0, ships: ships[fleet.FleetID] || [] }))
}

const labelsOf = (group, colonyNames) => {
  const labels = {}

  group.fleets.forEach((record) => Object.assign(labels, record.labels))

  return { ...labels, ...colonyNames }
}

// The whole audit. `queues`: the stored queues (`loadRouteQueues`); `raceId`; `ships`: the ship rows by fleet; `rows`: the page's route rows by fleet (each with `profile`, `route`, `blocked`, `unknown`, `year`, `cargo.deliveries`, `Speed`); `colonyNames`: { [colony place key]: name }; `desires`: the player's desired routes (`desiresOf`). Returns `{ supported, reason, records, groups, closed, broken, desires, counts }`: each group with its name and where it came from, its members' states, its summed capacity, the places it names (`labels`) and the groups it is related to (`related`).
export const auditOf = ({ queues, raceId, ships = {}, rows = {}, colonyNames = {}, desires = [] }) => {
  if (!queues || !queues.supported) {
    return { supported: false, reason: queues ? queues.reason : '', records: [], groups: [], closed: [], broken: [], desires: [], counts: { cycling: 0, groups: 0, duplicates: 0, closed: 0, broken: 0 } }
  }

  const records = recordsOf(queues, { raceId, ships })
  const figures = {}

  records.filter((record) => record.shape === 'route').forEach((record) => {
    figures[record.FleetID] = figureOf(rows[record.FleetID] || null, ships[record.FleetID] || [])
  })

  const templates = templateIndex(queues.templates, { actions: queues.actions, raceId })
  const covered = coverGroups(groupRoutes(records), figures)
  const groups = covered.map((group) => ({ ...group, name: routeName(group, { templates, colonyNames }), labels: labelsOf(group, colonyNames), related: [] }))

  groups.forEach((group, index) => {
    groups.slice(index + 1).forEach((other) => {
      const relation = relationOf(group.fleets[0], other.fleets[0])

      if (LISTED_RELATIONS.has(relation)) {
        group.related.push({ relation, id: other.id, name: other.name.name })
        other.related.push({ relation, id: group.id, name: group.name.name })
      }
    })
  })

  const deliveries = {}

  Object.entries(rows).forEach(([fleetId, row]) => {
    deliveries[fleetId] = row.cargo ? row.cargo.deliveries : []
  })

  return {
    supported: true,
    reason: '',
    records,
    groups,
    closed: records.filter((record) => record.shape === 'closed' || record.shape === 'finite-repeat').map((record) => ({ ...record, labels: { ...record.labels, ...colonyNames } })),
    broken: records.filter((record) => record.shape === 'empty' || record.shape === 'untraceable'),
    desires: coverDesires(desires, groups, deliveries),
    counts: { cycling: records.filter((record) => record.shape === 'route').length, groups: groups.length, duplicates: groups.filter((group) => group.duplicate).length, closed: records.filter((record) => (record.shape === 'closed' || record.shape === 'finite-repeat') && record.flows.length).length, broken: records.filter((record) => record.shape === 'empty' || record.shape === 'untraceable').length },
  }
}

// The desired routes (utilities/route-desires.js `readDesires`' entries) as `coverDesires` takes them: `{ id, name, cargo, yearly, from, to, stale }` with the colonies' ids, the unit of `yearly` being the cargo's own.
export const desiresOf = (entries) => entries.map((entry) => ({ id: entry.uuid, name: entry.name, cargo: entry.cargo, yearly: entry.yearly, from: entry.from.id, to: entry.to.id, stale: entry.stale }))

// The colonies a desired route can run between, as `{ id, name, text, row }` sorted by name (`objects` as `loadDesireObjects` gives them).
export const colonyChoices = (objects) => (objects && objects.colony instanceof Map ? [...objects.colony.values()].map((row) => ({ id: row.id, name: row.name, text: row.systemName ? `${row.name} (${row.systemName})` : row.name, row })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id) : [])
