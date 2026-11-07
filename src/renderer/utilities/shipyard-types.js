// The kinds of shipyard (`FCT_Shipyard.SYType`) and what the rules share between them. One list for every reader, so a type the app names is never classified by a second table.
//
// The game numbers the shipyard types Naval 1, Commercial 2, RepairYard 3, Light 4. A Light yard is created with one slipway of 1,000 tons, lists the classes that fit it without tooling and offers no activity but Add Slipway and, to a Spacemaster, the Spacemaster modification, which cannot change its capacity.

export const SHIPYARD_TYPE = Object.freeze({ NAVAL: 1, COMMERCIAL: 2, REPAIR: 3, LIGHT: 4 })

// Whether a yard of `type` counts its whole capacity, as a naval or a Light yard does against a tenth of it at a commercial or a repair yard: in the workers its slipways need (0.00025 a ton of a slipway against 0.000025), in its modification rate and in the price of an upgrade (a tenth only at a commercial or a repair yard). The type never weighs a class's size in a build rate: that quarter is the class's own `Commercial` flag (production.js `commercialSizeFactor`; the game asks the class, whatever the yard).
export const isFullCapacityYard = (type) => type === SHIPYARD_TYPE.NAVAL || type === SHIPYARD_TYPE.LIGHT

// The types of `isFullCapacityYard` as the list inside a SQL `in (...)`.
export const FULL_CAPACITY_YARD_SQL = [SHIPYARD_TYPE.NAVAL, SHIPYARD_TYPE.LIGHT].join(', ')

// Whether a yard of `type` offers capacity growth and retooling. A Light yard offers neither: the game's activity list for it holds Add Slipway (and the Spacemaster modification) alone.
export const growsInCapacity = (type) => type !== SHIPYARD_TYPE.LIGHT
