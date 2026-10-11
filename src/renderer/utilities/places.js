// The places a route can start or end, as Route Finder and the Transport page offer them: a colony at its body, a system at its centre. Each option is { key, kind, name, subtitle, icon, SystemID, Xcor, Ycor } with the source row beside it, and `searchable` adds the lowercase words a search matches. Keys come from utilities/deep-links.js `place`.

import { place } from './deep-links'

// `colonies`: [{ PopulationID, PopName, SystemID, Capital, Xcor, Ycor }]; `systemName(SystemID)` names the system a colony is in.
export const colonyPlaces = (colonies, systemName) => colonies.map((colony) => ({
  key: place.colony(colony.PopulationID),
  kind: 'colony',
  name: colony.PopName,
  subtitle: `Colony in ${systemName(colony.SystemID)}${colony.Capital ? ', capital' : ''}`,
  icon: colony.Capital ? 'mdi-star-circle-outline' : 'mdi-earth',
  SystemID: colony.SystemID,
  Xcor: colony.Xcor,
  Ycor: colony.Ycor,
  Capital: colony.Capital,
  colony,
}))

// `systems`: [{ SystemID, Name }], by name. A system's place is its centre.
export const systemPlaces = (systems) => systems.slice().sort((a, b) => a.Name.localeCompare(b.Name)).map((system) => ({
  key: place.system(system.SystemID),
  kind: 'system',
  name: system.Name,
  subtitle: 'System',
  icon: 'mdi-white-balance-sunny',
  SystemID: system.SystemID,
  Xcor: 0,
  Ycor: 0,
}))

// The options with `text`: their name and their system's, for `filterPlace`.
export const searchable = (places, systemName) => places.map((option) => ({ ...option, text: `${option.name} ${systemName(option.SystemID)}`.toLowerCase() }))

// A v-autocomplete `filter` over `searchable` options.
export const filterPlace = (item, query) => item.text.includes(query.toLowerCase())
