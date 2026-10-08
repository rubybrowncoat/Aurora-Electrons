// The empires the app can open: every game's races, each with its kind and a line about its capital and colonies.
// Read into the `empires` store for the rail's Empires entry and flyout and the Empires page.

import { SPECIAL_NPR_NAMES, gameTime, toBoolean, toNumber } from './aurora'
import { people } from './colonies'
import { roundToDecimal, separatedNumber } from './math'

// One row per race, the game's columns repeated. Each race names its capital and the capital's system as that race
// knows them (`PopName` is its own, the system comes from the race's own survey rows), so nothing here shows what
// the viewer's race hasn't seen: a row stands for its own empire, and under "spy on NPRs" that is the sanctioned exception.
const EMPIRES_SQL = `select FCT_Game.GameID, FCT_Game.GameName, FCT_Game.StartYear, FCT_Game.GameTime, FCT_Game.CivilianShippingLinesActive,
  FCT_Race.RaceID, FCT_Race.RaceTitle, FCT_Race.NPR, FCT_Race.SpecialNPRID, FCT_Race.FlagPic,
  VIR_Capital.PopName as CapitalName, FCT_RaceSysSurvey.Name as CapitalSystemName,
  coalesce(VIR_Colonies.Colonies, 0) as Colonies, coalesce(VIR_Colonies.Population, 0) as Population
from FCT_Game
inner join FCT_Race on FCT_Race.GameID = FCT_Game.GameID
left join (select GameID, RaceID, sum(case when Population > 0 then 1 else 0 end) as Colonies, sum(Population) as Population from FCT_Population group by GameID, RaceID) as VIR_Colonies on VIR_Colonies.GameID = FCT_Race.GameID and VIR_Colonies.RaceID = FCT_Race.RaceID
left join FCT_Population as VIR_Capital on VIR_Capital.PopulationID = (select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = FCT_Race.GameID and FCT_Population.RaceID = FCT_Race.RaceID and FCT_Population.Capital = 1 order by FCT_Population.Population desc, FCT_Population.PopulationID limit 1)
left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.GameID = FCT_Race.GameID and FCT_RaceSysSurvey.RaceID = FCT_Race.RaceID and FCT_RaceSysSurvey.SystemID = VIR_Capital.SystemID
where (FCT_Race.NPR = 0 or :spyNPR = 1)
order by FCT_Game.GameID, FCT_Race.NPR, FCT_Race.RaceID`

// What kind of empire a race is: a player's, an ordinary NPR empire, or one of the game's special factions.
export const empireKind = ({ NPR, SpecialNPRID }) => {
  const special = toNumber(SpecialNPRID)

  if (!toBoolean(NPR)) {
    return { type: 'player', label: 'Player' }
  } else if (special > 0) {
    return { type: 'special', label: SPECIAL_NPR_NAMES[special] || `Faction ${special}` }
  }

  return { type: 'npr', label: 'NPR' }
}

// [{ GameID, GameName, StartYear, GameTime, CivilianShippingLinesActive, date, Races: [{ RaceID, RaceTitle, NPR,
// SpecialNPRID, FlagPic, kind, ... }] }]. A game with no race to show is left out. Without `spyNPR`, NPRs are left out.
export const loadEmpires = async (database, spyNPR) => {
  const [rows] = await database.query(EMPIRES_SQL, { replacements: { spyNPR: spyNPR ? 1 : 0 } })
  const games = new Map()

  rows.forEach(({ GameID, GameName, StartYear, GameTime, CivilianShippingLinesActive, ...race }) => {
    if (!games.has(GameID)) {
      games.set(GameID, {
        GameID,
        GameName,
        StartYear,
        GameTime,
        CivilianShippingLinesActive: toBoolean(CivilianShippingLinesActive),
        date: gameTime(StartYear, GameTime).format('YYYY-MM-DD'),
        Races: [],
      })
    }

    const normalized = { ...race, NPR: toBoolean(race.NPR), SpecialNPRID: toNumber(race.SpecialNPRID) }

    games.get(GameID).Races.push({ ...normalized, kind: empireKind(normalized) })
  })

  return [...games.values()]
}

// Millions of people: the thousands-separated figure in millions from 10 M up, `people`'s precision below.
const millions = (value, separator) => (value >= 10 ? `${separatedNumber(roundToDecimal(value, 1), separator)} M` : people(value))

// The capital, its system and the colonies of a race row: "Aurelia, Aurelus · 39 colonies · 15'261.2 M".
// A capital with nobody left is a remnant, not an empire. The Eldar's capital is literally named "Unknown", so only its system shows.
export const empireDetails = ({ Colonies, Population, CapitalName, CapitalSystemName }, separator) => {
  const place = [CapitalName !== 'Unknown' ? CapitalName : null, CapitalSystemName].filter(Boolean).join(', ')

  if (Colonies > 0) {
    return [place, `${Colonies} ${Colonies === 1 ? 'colony' : 'colonies'}`, millions(Population, separator)].filter(Boolean).join(' · ')
  }

  return CapitalName !== null && place ? `${place} · no population` : 'No colonies'
}
