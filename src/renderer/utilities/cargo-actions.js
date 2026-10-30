// The move actions whose DestinationItemID names the one type of cargo they handle, shared by what a cycle moves (utilities/hauling.js `cycleCargo`) and by which stops a cycle's cargo reaches (utilities/route-signatures.js `flowsOf`).

// Load Installation, Load Mineral Type, Load Mineral when X available: they load one type, up to their quantity.
export const ITEM_LOADS = new Set([176, 178, 180])

// Unload Installation, Unload Mineral Type: they unload only the cargo of that type, up to their quantity, and leave the rest of the hold. Every other unload takes all it can (Unload Colonists carries a quantity flag but ignores it).
export const ITEM_UNLOADS = new Set([177, 179])
