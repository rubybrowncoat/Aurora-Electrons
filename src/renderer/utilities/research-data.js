// The race's No Research Projects setting (`FCT_Race.NoResearchProjects`, Race.cs:87): a race the game never lets start a research project, which develops components, missiles and ground unit classes by Engineering, Ordnance and Ground Unit Projects instead (Economics.cs:1548, 3653, 3824, 3919 and 4144-4174 hide and refuse the project buttons of such a race, Population.cs:822 leaves out its idle research facilities event and Population.cs:8559-8560 keeps the research installations out of its construction choices). The read names its columns first, so a save without the column gives `read: false` and `value: null` (the setting is not known), never `false`; a value that is neither a flag nor a 0 or 1 is not known either.

// What the pages say of a race that starts no research projects: the game hides the project buttons of such a race and leaves its idle research facilities out of its events, and the race develops components, missiles and ground unit classes with Engineering, Ordnance and Ground Unit Projects on the Industry tab of Production, each for twice the development cost (Economics.cs:1548, 3653, 3824, 3919 and 4144-4174, Population.cs:822 and 8388-8479).
export const NO_RESEARCH_WORDS = 'The race starts no research projects, so labs and projects are not warned about for it. It develops components, missiles and ground unit classes by Engineering, Ordnance and Ground Unit Projects on the Industry tab of Production, each for twice the development cost.'

const FLAG_WORDS = new Map([['1', true], ['TRUE', true], ['YES', true], ['0', false], ['FALSE', false], ['NO', false]])

// The stored flag as true or false, null when it is not stored or not a flag.
export const flagOfStored = (raw) => (typeof raw === 'boolean' ? raw : typeof raw === 'number' && (raw === 0 || raw === 1) ? raw === 1 : typeof raw === 'string' && FLAG_WORDS.has(raw.trim().toUpperCase()) ? FLAG_WORDS.get(raw.trim().toUpperCase()) : null)

export const NO_RESEARCH_UNREAD = Object.freeze({ read: false, value: null })

// `{ read, value }`: `value` is true when the race starts no research projects, false when it does, null when the save does not say.
export const loadNoResearchProjects = async (database, { GameID, RaceID }) => {
  if (!database || !GameID || !RaceID) {
    return NO_RESEARCH_UNREAD
  }

  const [columns] = await database.query('select name from pragma_table_info(\'FCT_Race\')')
  const names = new Set(columns.map((column) => column.name))

  if (!['GameID', 'RaceID', 'NoResearchProjects'].every((name) => names.has(name))) {
    return NO_RESEARCH_UNREAD
  }

  const [rows] = await database.query(`select FCT_Race.NoResearchProjects from FCT_Race where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`)

  return rows.length ? { read: true, value: flagOfStored(rows[0].NoResearchProjects) } : NO_RESEARCH_UNREAD
}
