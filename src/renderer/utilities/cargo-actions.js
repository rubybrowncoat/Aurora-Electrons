// The move actions whose DestinationItemID names the one type of cargo they handle, shared by what a cycle moves (utilities/hauling.js `cycleCargo`) and by which stops a cycle's cargo reaches (utilities/route-signatures.js `flowsOf`).

// Load Ship Component, Load Installation, Load Mineral Type, Load Mineral when X available: they load one type, up to their quantity (a number of components for a ship component, which is not a number of tonnes).
export const ITEM_LOADS = new Set([140, 176, 178, 180])

// Unload Ship Component, Unload Installation, Unload Mineral Type: they unload only the cargo of that type and leave the rest of the hold. Every other unload takes all it can (Unload Colonists carries a quantity flag but ignores it).
export const ITEM_UNLOADS = new Set([141, 177, 179])

// The item unloads that stop at their quantity: Unload Installation and Unload Mineral Type. Unload Ship Component carries a quantity flag but unloads every unit of its component, whatever the quantity.
export const QUANTITY_UNLOADS = new Set([177, 179])
