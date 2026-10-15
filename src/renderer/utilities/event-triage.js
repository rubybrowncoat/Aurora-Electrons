// Triage of the Game Log: the built-in categories of event types, and the presets (named keyword and type selections) the player saves. Everything here filters in memory over rows already read; no keyword or preset ever enters an SQL statement.

// The categories in the order the type selector lists them, each with the EventTypeIDs of `DIM_EventType` it holds (.github/exports/DIM_EventType.csv). Every type of the export is listed once, and every type flagged `AttackEvent` is in Combat (scripts/check-event-triage.js checks both). A type the table has not listed, including one the open save's DIM_EventType lacks, belongs to `OTHER`.
export const CATEGORIES = Object.freeze([
  { id: 'combat', name: 'Combat', types: [11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27, 28, 52, 53, 75, 97, 119, 173, 174, 177, 178, 200, 219, 220, 221, 227, 237, 258, 294, 297, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 313, 314, 324, 326, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 351, 352, 354, 365, 366, 368] },
  { id: 'contacts', name: 'Contacts and intelligence', types: [55, 106, 139, 147, 157, 180, 181, 182, 183, 184, 186, 187, 191, 203, 204, 206, 207, 208, 209, 210, 232, 233, 285, 293, 298, 315, 356, 357, 362, 363, 364, 367] },
  { id: 'ships', name: 'Ships and fleets', types: [2, 3, 4, 7, 41, 42, 45, 46, 54, 58, 59, 65, 71, 82, 83, 87, 91, 92, 93, 107, 108, 111, 116, 122, 125, 135, 140, 145, 146, 155, 201, 224, 245, 252, 253, 254, 255, 266, 277, 278, 282, 283, 295, 317, 319, 321, 327, 350, 353, 361] },
  { id: 'colonies', name: 'Colonies and industry', types: [1, 9, 64, 66, 76, 77, 80, 81, 100, 101, 115, 133, 148, 149, 179, 211, 212, 228, 276, 279, 281, 284, 310, 311, 312, 316, 320, 328, 329, 359, 360] },
  { id: 'research', name: 'Research and personnel', types: [10, 35, 60, 63, 88, 90, 98, 99, 127, 128, 129, 215, 216, 217, 229, 235, 238, 256, 257, 280, 286, 287, 289, 290, 291, 292, 296, 299, 318, 322, 323, 325, 370, 371, 372] },
  { id: 'exploration', name: 'Exploration and survey', types: [37, 43, 44, 57, 138, 141, 142, 143, 195, 218, 260, 288] },
  { id: 'notices', name: 'Log notices', types: [0, 117, 169, 265, 355, 358, 369] },
])

// The fallback: types no category lists. Its group is always offered by the type selector, even while the log holds none of them.
export const OTHER = Object.freeze({ id: 'other', name: 'Other', types: [] })

const CATEGORY_OF = new Map(CATEGORIES.flatMap((category) => category.types.map((type) => [type, category.id])))

export const categoryOfType = (EventType) => CATEGORY_OF.get(Number(EventType)) || OTHER.id

// The types of a log as the selector's groups: [{ id, name, types: [{ value, text, count }] }] in the categories' order, the fallback last and always present. `types` is [{ value, text, count }] of the types the log holds.
export const groupTypes = (types) => {
  const groups = [...CATEGORIES, OTHER].map(({ id, name }) => ({ id, name, types: [] }))
  const byId = new Map(groups.map((group) => [group.id, group]))

  types.forEach((type) => byId.get(categoryOfType(type.value)).types.push(type))

  return groups
}

// The types of the log's groups that no category lists.
export const otherTypes = (types) => types.filter((type) => categoryOfType(type) === OTHER.id)

// The selection after choosing or clearing every type of one group. `selected` is the ids now selected, `ids` the group's.
export const toggledGroup = (selected, ids, on) => {
  const chosen = new Set(selected)

  ids.forEach((id) => (on ? chosen.add(id) : chosen.delete(id)))

  return [...chosen]
}

// ---- Presets -------------------------------------------------------------------------------------------------------

// The most presets kept, and the longest name and keyword.
export const MAX_PRESETS = 50
export const MAX_NAME = 60
export const MAX_KEYWORD = 80

const isId = (value) => Number.isInteger(value) && value >= 0

// Keywords as typed: trimmed, without empty ones, without repeats that differ only in case, in the order given.
export const cleanKeywords = (keywords) => {
  const seen = new Set()

  return (Array.isArray(keywords) ? keywords : []).filter((keyword) => typeof keyword === 'string').map((keyword) => keyword.trim().slice(0, MAX_KEYWORD)).filter((keyword) => {
    const key = keyword.toLowerCase()

    if (!keyword || seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

// The presets a stored value holds, dropping what is not a preset: { id, name, keywords: [text], types: null | [ids] }. `types` null is every type.
export const readPresets = (stored) => {
  if (!Array.isArray(stored)) {
    return []
  }

  const ids = new Set()

  return stored.filter((preset) => preset && typeof preset === 'object' && typeof preset.id === 'string' && preset.id && typeof preset.name === 'string' && preset.name.trim() && (preset.types === null || (Array.isArray(preset.types) && preset.types.every(isId)))).filter((preset) => !ids.has(preset.id) && ids.add(preset.id)).slice(0, MAX_PRESETS).map((preset) => ({ id: preset.id, name: preset.name.trim().slice(0, MAX_NAME), keywords: cleanKeywords(preset.keywords), types: preset.types === null ? null : [...new Set(preset.types)] }))
}

export const newPresetId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

// Why a name cannot be given to a preset, or null. `presets` are those kept, `id` the preset being renamed.
export const nameProblem = (name, presets, id = null) => {
  const text = String(name || '').trim()

  if (!text) {
    return 'Type a name.'
  }

  if (text.length > MAX_NAME) {
    return `A name has at most ${MAX_NAME} characters.`
  }

  if (presets.some((preset) => preset.id !== id && preset.name.toLowerCase() === text.toLowerCase())) {
    return 'A preset has this name already.'
  }

  return id === null && presets.length >= MAX_PRESETS ? `At most ${MAX_PRESETS} presets are kept.` : null
}

export const withPreset = (presets, { name, keywords, types }) => [...presets, { id: newPresetId(), name: name.trim(), keywords: cleanKeywords(keywords), types: types === null ? null : [...new Set(types)] }]

export const withRenamedPreset = (presets, id, name) => presets.map((preset) => (preset.id === id ? { ...preset, name: name.trim() } : preset))

export const withoutPreset = (presets, id) => presets.filter((preset) => preset.id !== id)

// The types a preset selects in a log holding `logTypes`: null for every type, else the preset's with every type no category lists added, so an event type the table does not know never drops out of view because a preset was saved before the type appeared.
export const presetTypes = (preset, logTypes) => (preset.types === null ? null : [...new Set([...preset.types, ...otherTypes(logTypes)])])

// ---- Keywords ------------------------------------------------------------------------------------------------------

// A test of a row's lower-cased search text against keywords: any keyword as a case-insensitive substring. No keyword matches everything.
export const keywordTest = (keywords) => {
  const needles = cleanKeywords(keywords).map((keyword) => keyword.toLowerCase())

  return needles.length ? (searchText) => needles.some((needle) => searchText.includes(needle)) : null
}
