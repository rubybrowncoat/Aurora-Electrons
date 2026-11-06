// Commander maths for the Commanders page: assignments, bonuses and better candidates. Sources and checks: docs/plans/aurcalcs/build-3.md § Commanders. Every figure the page calculates is a provenance result (utilities/provenance.js). A count that leaves out commanders whose stored value is missing says so, and an assignment that cannot be rated for a missing bonus is unavailable and names the commander and the field: a missing value is never read as a neutral 1, a 0 or an idle post.

import { gameTime } from './aurora'
import { UNKNOWN_TEXT, isKnownNumber, roundToDecimal } from './math'
import { STATUS, combine, envelope, getRule, isAvailable, ofRule, registerRule, unavailable, weakestStatus } from './provenance'
import { NO_RESEARCH_WORDS } from './research-data'

export const COMMANDER_TYPES = [
  { id: 0, label: 'Naval', plural: 'Naval officers', flag: 'Naval' },
  { id: 1, label: 'Ground', plural: 'Ground officers', flag: 'Ground' },
  { id: 2, label: 'Administrator', plural: 'Administrators', flag: 'Civilian' },
  { id: 3, label: 'Scientist', plural: 'Scientists', flag: 'Scientist' },
]

// FCT_Commander.CommandType. The ship posts (8–15) were matched on the sample: every officer in a post has its required bonus and serves on a ship with its command module (docs `crew-and-commanders`).
export const POSTS = {
  0: 'Unassigned',
  1: 'Captain',
  3: 'Governor',
  4: 'Sector governor',
  5: 'Ground formation',
  7: 'Research project',
  8: 'Executive officer',
  9: 'Chief engineer',
  10: 'Science officer',
  11: 'Tactical officer',
  12: 'Naval admin command',
  15: 'Commander, air group',
  17: 'Academy commandant',
}

// The notes of the roster's age range, by what each says.
export const AGE_NOTES = {
  unavailable: 'This save lacks the species data the ages rest on, so the age range is off and any stored bound is kept for a save that has it.',
}

// Bonuses stored as ratings, not multipliers.
const RATINGS = new Set([25, 27])

// The bonus IDs the save's lookup rows do not confirm (`blockedBonuses` of utilities/capabilities.js, from the capability check): none unless a caller passes some. A figure that rests on the meaning of one of them is not given.
const NONE = new Set()

export const COLONY_ADMINISTRATION = 25
export const RESEARCH_ADMINISTRATION = 27
export const RESEARCH = 3
export const SURVEY = 2
export const MINING = 6
export const TERRAFORMING = 9
// A ship class this small (FCT_ShipClass.Size, in hull spaces, 1,000 t) or smaller is a light naval unit, and its captain's bonus counts in full where a larger ship's counts halved. The limit is inclusive.
const LIGHT_NAVAL_SIZE = 20

// FCT_ShipClass.MainFunction, the function the game ranks a ship's officers by (`Race.AssignCommanderAssignmentScore`) and names as the class's role. The game works it out from the class's armament, sensors and size each time it loads a class unless the player picked it (`UserDefinedFunction` set, `ClassDesign` where the player chooses it), so a function that is stored and not declared is the game's own reading. Names as the game words them.
export const MAIN_FUNCTIONS = Object.freeze({ 0: 'None', 1: 'Carrier', 2: 'Warship', 3: 'Light Naval', 5: 'Scout', 6: 'Survey Ship', 7: 'Survey Ship', 8: 'Freighter', 9: 'Colony Ship', 10: 'Troop Transport', 11: 'Stabilisation Ship', 12: 'Fuel Harvester', 13: 'Terraformer', 14: 'Orbital Miner', 15: 'Salvager', 16: 'Liner', 17: 'Supply Ship', 18: 'Maintenance Ship', 19: 'Tanker', 20: 'Orbital Habitat', 21: 'Worker', 22: 'Recreational Ship', 23: 'Space Station', 24: 'Intelligence Ship', 26: 'Diplomatic Ship', 27: 'Tug', 28: 'Ordnance Production' })
const LIGHT_NAVAL_FUNCTION = 3
// Light Tactical, the bonus the game ranks the captain of a Light Naval ship by.
export const LIGHT_TACTICAL = 39
// Tactical, the bonus a captain's combat effect takes on a ship over `LIGHT_NAVAL_SIZE` hull spaces (half of it).
export const TACTICAL = 21

// FCT_Ranks.RankType of the naval ranks (the game's commander type Naval, the first of its enumeration).
const NAVAL_RANK_TYPE = 0

// `FCT_Commander.RetireStatus` values. `kind` sorts them for the Former panel.
export const RETIRE_STATUSES = {
  1: { label: 'Killed in naval combat', kind: 'dead' },
  2: { label: 'Retired: old age', kind: 'retired' },
  3: { label: 'Retired: medical condition', kind: 'retired' },
  4: { label: 'Retired when their ship was decommissioned', kind: 'retired' },
  5: { label: 'Retired by order of High Command', kind: 'retired' },
  6: { label: 'Captured', kind: 'prisoner' },
  7: { label: 'Honourable discharge', kind: 'retired' },
  8: { label: 'Killed in an accident', kind: 'dead' },
  9: { label: 'Died of natural causes', kind: 'dead' },
  10: { label: 'Died of life support failure', kind: 'dead' },
  11: { label: 'Killed in ground combat', kind: 'dead' },
  12: { label: 'Died in a life pod', kind: 'dead' },
  13: { label: 'Killed in boarding combat', kind: 'dead' },
  14: { label: 'Executed', kind: 'dead' },
}

// SQL condition for the commanders still serving. The game saves a retired or dead commander only when the player keeps them (`RetainRetired`) or they are a prisoner; `RetireStatus` is 0 while they serve, and a captured one keeps 0 with `Prisoner` set.
export const SERVING_COMMANDER = 'FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0'

// The SQL the roster's queries take for the columns the save has: `groups` is { rank, age, seniorCO } from the capability check of /commanders (utilities/capabilities.js `SOFT`), null while it has not answered, which reads as a save that has everything. A group the save lacks is selected as nulls (never 0, so the figures built on it are unavailable) and its joins are left out: `rankColumns`, `rankLevel`, `classRank` and `shipFlag` for the ranks, `ageColumn` for the species' graduation age; the ship's Senior CO flag and the count of naval ranks that a flagged ship's captain rank needs are nulls without the `seniorCO` group.
// `classRank` is the rank the class requires beside the ship's Senior CO flag and the number of naval ranks the race holds, which `captainRank` needs to tell whether a rank above the class's exists; `shipFlag` is the same flag of the ship an assigned officer serves on, null for a post that is not on a ship. A save without the flag selects it as null, and `captainRank` holds a null flag to be unknown, never no flag: its captain's rank is then unavailable rather than the class's. `namedFunctions` lists the codes of the main functions the game names (`MAIN_FUNCTIONS`), for the read of the classes whose function is not stored or is not one of them, which may be light naval ones.
export const rosterParts = (groups, { GameID, RaceID }) => {
  const ranked = !groups || groups.rank !== false
  const aged = !groups || groups.age !== false
  const flagged = !groups || groups.seniorCO !== false

  return {
    rankColumns: ranked ? 'FCT_Ranks.RankName, FCT_Ranks.RankAbbrev' : 'null as RankName, null as RankAbbrev',
    rankLevel: ranked ? 'VIR_Levels.Lowest - FCT_Ranks.Priority + 1 as RankLevel' : 'null as RankLevel',
    classRank: ranked ? `FCT_ShipClass.RankRequired, ${flagged ? `FCT_Ship.ShipSeniorCO, (select count(*) from FCT_Ranks where FCT_Ranks.GameID = ${GameID} and FCT_Ranks.RaceID = ${RaceID} and FCT_Ranks.RankType = ${NAVAL_RANK_TYPE}) as NavalRanks` : 'null as ShipSeniorCO, null as NavalRanks'}` : 'null as RankRequired, null as ShipSeniorCO, null as NavalRanks',
    shipFlag: flagged ? 'VIR_Ship.ShipSeniorCO as AssignmentSeniorCO' : 'null as AssignmentSeniorCO',
    ageColumn: aged ? 'FCT_Species.GraduationAge' : 'null as GraduationAge',
    ageJoin: aged ? 'left join FCT_Species on FCT_Species.SpeciesID = FCT_Commander.SpeciesID' : '',
    rankJoin: ranked ? 'left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID' : '',
    levelJoin: ranked ? `left join (select FCT_Ranks.RankType, max(FCT_Ranks.Priority) as Lowest from FCT_Ranks where FCT_Ranks.GameID = ${GameID} and FCT_Ranks.RaceID = ${RaceID} group by FCT_Ranks.RankType) as VIR_Levels on VIR_Levels.RankType = FCT_Ranks.RankType` : '',
    namedFunctions: Object.keys(MAIN_FUNCTIONS).join(', '),
  }
}

// 'prisoner', 'dead' or 'retired' for an FCT_Commander row. A prisoner who is discharged or executed in captivity keeps the flag, so the status decides first.
export const formerKind = ({ RetireStatus, Prisoner }) => (RETIRE_STATUSES[RetireStatus] || {}).kind || (Prisoner ? 'prisoner' : 'retired')

const EPSILON = 1e-9
const SECONDS_PER_YEAR = 31536000
const VERSIONS = ['3.2.x']
const COUNT = 'commanders.count'
const UNASSIGNED = 'commanders.unassigned'
const VACANT = 'commanders.vacantGovernor'
const CAPTAINLESS = 'commanders.captainless'
const GOVERNOR = 'commanders.governorBonus'
const POST = 'commanders.specialistPost'
const SHIP = 'commanders.shipBonus'
const MULTIPLIER = 'commanders.researchMultiplier'
const PROJECT = 'commanders.researchSuggestion'
const SUGGESTIONS = 'commanders.bonusSuggestion'
const KILLS = 'commanders.kills'
const AGE = 'commanders.age'
const MEDALS = 'commanders.medals'
const GROUP = 'commanders.groupCount'
const BONUS_VALUE = 'commanders.bonusValue'
const RECORD_DATE = 'commanders.recordDate'
const NO_BONUS = 'A commander with no stored row for a bonus has none: 1 for a multiplier, 0 for a rating'

registerRule({
  id: COUNT,
  versions: VERSIONS,
  units: 'commanders',
  verification: 'confirmed',
  structure: ['FCT_Commander.CommanderType, RetireStatus, Prisoner'],
  note: 'Serving commanders of the race: the stored rows that are neither retired, dead nor prisoners, by commander type. A commander whose type or status is not stored cannot be placed, and the count then says how many it leaves out. A count of stored rows with no formula to check.',
})

registerRule({
  id: UNASSIGNED,
  versions: VERSIONS,
  units: 'commanders',
  verification: 'confirmed',
  structure: ['FCT_Commander.CommandType'],
  note: 'Serving commanders whose stored post is 0, unassigned. A commander with no stored post is not counted as idle, and the count says how many it leaves out.',
})

registerRule({
  id: VACANT,
  versions: VERSIONS,
  units: 'colonies',
  verification: 'confirmed',
  structure: ['FCT_Population.Population', 'FCT_Commander.CommandType, CommandID, Deceased (governor post 3)'],
  note: 'Colonies of the race with people, or with a governor, that have no serving commander in the governor post. A colony with no stored population and no governor is left out and counted apart.',
})

registerRule({
  id: CAPTAINLESS,
  versions: VERSIONS,
  units: 'ships',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Terraformers, MiningModules, Harvesters, GeoSurvey, GravSurvey', 'FCT_Commander.CommandType, CommandID (captain post 1)'],
  note: 'Specialist ships (terraformers, miners, harvesters and survey ships, by their class modules) with no captain among the stored commanders. A ship whose class modules are not stored is of unknown kind and is counted apart.',
})

registerRule({
  id: GOVERNOR,
  versions: VERSIONS,
  units: 'bonus ranking',
  verification: 'estimated',
  structure: ['FCT_Population.BonusOne, BonusTwo, BonusThree', 'FCT_CommanderBonuses.BonusID, BonusValue', 'FCT_Commander.CommandType'],
  assumptions: [NO_BONUS],
  note: 'Whether an unassigned administrator would govern a colony better than its governor: the colony\'s required bonuses (Governor tab) compared in order, the first, then the second, then the third. The order follows the game\'s documented automated assignment and is not compared with an assignment the game made. A colony or commander whose bonus is not stored cannot be rated: the result is unavailable and names the missing value.',
})

// Source members of the post rule, 3.1.0: `Race.AssignCommanderAssignmentScore` (Race.cs 13255-13380; 13280-13344) ranks the captain of a ship by the bonus of its stored main function, Light Naval by Light Tactical, whatever the size; `ShipClass.AssignMainFunction` (ShipClass.cs 4566-4733) chooses Light Naval only for a class of at most 20 hull spaces (4731) unless the player declared the function (`ClassDesign`, `UserDefinedFunction`), and the game loads a class with it only when it was not declared (ShipClass.cs 3928); `Ship.CalculateTacticalEffectivenessMultiplier` (Ship.cs 1723-1741) takes the captain's Light Tactical (`Commander.method_5`) for a ship of at most 20 hull spaces and the captain's Tactical halved (`Commander.method_7`, Commander.cs 325-337) for a larger one, as `Ship.method_125` does (Ship.cs 5621-5627, which skips Light Tactical above 20 hull spaces). So the ranking of a declared Light Naval class over 20 hull spaces by Light Tactical is the game's assignment order and not its effect in combat.
registerRule({
  id: POST,
  versions: ['3.2.x'],
  units: 'post',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Terraformers, MiningModules, Harvesters, GeoSurvey, GravSurvey, RankRequired, Size', 'FCT_ShipClass.MainFunction, UserDefinedFunction, NoOfficers', 'FCT_Ship.ShipSeniorCO', 'FCT_Ranks.RankType (the count of the naval ranks)', 'FCT_ClassComponent, FCT_ShipDesignComponents.Name (Science Department)', 'FCT_CommanderBonuses.BonusID, BonusValue (Light Tactical, Tactical)'],
  note: 'The post and bonus that matter on a ship, from its class: terraformers and miners use the captain\'s bonus, survey ships the science officer\'s Survey bonus when the class has a Science Department and otherwise the captain\'s, in full for a class of 20 hull spaces or less (the limit included) and halved for a larger one. A ship of a class whose stored main function is Light Naval and that has officers is a light naval ship: its captain is ranked by Light Tactical, the bonus the game\'s assignment order uses for that function. That ranking is not the effect on the ship: in combat the ship\'s own tactical multiplier takes the captain\'s Light Tactical in full for a class of 20 hull spaces or less and half of the captain\'s Tactical for a larger one, so for a class declared Light Naval over 20 hull spaces Light Tactical counts for nothing in combat, and the post carries the Tactical bonus beside it. The game works the main function out from the class\'s size, armament and sensors unless the player declared it, so a stored Light Naval function counts for a class over 20 hull spaces only when it was declared. A class whose main function is not stored, or is one the game does not name, may be a light naval class and has no post, unless it has no officers or is not declared and over 20 hull spaces, which no function makes light naval. A declared function is shown beside the post; only Light Naval is ranked by its own bonus, the other posts follow the class\'s modules. The captain\'s rank is the rank the class requires, which already carries the class\'s own Senior CO option, and one rank higher for a ship that is flagged Senior CO itself, as the game asks the ship for its rank; a secondary officer ranks one below the class rank whatever the flag. The post-to-bonus match was observed on a sample of saved assignments; the captain\'s share is the game source\'s rule and is not checked against a save. A class whose module counts, size or required rank are not stored has no post, nor has a captain\'s post of a ship whose Senior CO setting is not stored or whose flagged rank the race\'s ranks do not hold; a save that does not store the setting at all keeps the class\'s rank for the post and says so. A Light Naval class whose officers, size or declaration are not stored has no post.',
})

registerRule({
  id: SHIP,
  versions: VERSIONS,
  units: 'bonus',
  verification: 'estimated',
  structure: ['FCT_CommanderBonuses.BonusID, BonusValue', 'FCT_Commander.CommandType, RankID', 'FCT_Ranks.Priority', 'FCT_Ship, FCT_Commander (captain and science officer posts)'],
  assumptions: [NO_BONUS],
  note: 'Whether an unassigned naval officer of the post\'s exact rank has a better bonus than the officer in a specialist ship\'s post, or the post is vacant. Better officers at other ranks are counted apart. The ranking is a planner rule that is not compared with the game\'s own assignments. A post holder or candidate whose bonus or rank is not stored cannot be rated.',
})

registerRule({
  id: MULTIPLIER,
  versions: VERSIONS,
  units: '×',
  verification: 'estimated',
  structure: ['FCT_CommanderBonuses.BonusValue (Research, bonus 3)', 'FCT_Commander.ResSpecID', 'FCT_ResearchProject.ResSpecID'],
  assumptions: [NO_BONUS, 'A project with no scientist researches at ×1'],
  note: 'A scientist\'s research multiplier: the Research bonus counts four times in the scientist\'s own field (1.15 becomes 1.60) and once outside it. The docs say a change of field cuts the bonus by 75%; the four-times reading is a planner rule that is not compared with a stored research output.',
})

registerRule({
  id: PROJECT,
  versions: VERSIONS,
  units: 'research multiplier',
  verification: 'estimated',
  structure: ['FCT_ResearchProject.Facilities, ResSpecID', 'FCT_CommanderBonuses.BonusValue (Research and Research Administration, bonuses 3 and 27)', 'FCT_Commander.ResSpecID, CommandType'],
  assumptions: [NO_BONUS],
  note: 'Whether an unassigned scientist of the project\'s field, with a Research Administration rating of at least its labs, would research faster than the scientist on it. It rests on the research multiplier rule and is not compared with a stored output. A project, scientist or bonus whose value is not stored cannot be rated.',
})

registerRule({
  id: SUGGESTIONS,
  versions: ['x'],
  units: 'assignments',
  verification: 'estimated',
  structure: ['the governor, specialist ship and research suggestion rules'],
  note: 'The assignments an unassigned officer would improve: governor improvements, specialist ships, light naval ships and research projects added. Each counts a post, and one officer can be the best candidate of many posts, so the count is of posts that an officer would improve and is neither a number of officers nor an allocation. Each rests on an estimated rule; assignments that cannot be rated for a missing value are left out and counted apart.',
})

registerRule({
  id: KILLS,
  versions: VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_Commander.KillTonnageMilitary, KillTonnageCommercial'],
  note: 'Tonnage a commander destroyed: the stored military and commercial kill tonnage added. A commander missing either column has no total.',
})

registerRule({
  id: AGE,
  versions: ['2.7.x'],
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_Species.GraduationAge', 'FCT_Commander.CareerStart', 'FCT_Game.GameTime', 'FCT_CommanderHistory.GameTime (last record, for the dead)'],
  note: 'Age in years: the species\' graduation age plus the time since the career began, to the game time or, for a commander who died, to the last career record. It is not compared with an age the game shows. A commander with no stored graduation age, career start or end time has no age.',
})

registerRule({
  id: MEDALS,
  versions: VERSIONS,
  units: 'medals',
  verification: 'confirmed',
  structure: ['FCT_CommanderMedal.NumAwarded'],
  note: 'Medals a commander holds: the stored awards added. A commander with no award rows holds none; an award with no stored amount leaves the total unavailable.',
})

registerRule({
  id: GROUP,
  versions: VERSIONS,
  units: 'commanders',
  verification: 'confirmed',
  structure: ['FCT_Commander.RetireStatus, Prisoner, RaceID, TransportShipID, PopLocationID'],
  note: 'Former commanders by group (prisoners of other races, retired, dead) and the alien prisoners the race holds, counted from the stored rows. A retirement status outside the known list counts as retired. A commander whose status is not stored is in no group and is counted apart.',
})

registerRule({
  id: BONUS_VALUE,
  versions: VERSIONS,
  units: 'bonus',
  verification: 'confirmed',
  structure: ['FCT_CommanderBonuses.BonusID, BonusValue'],
  note: 'A stored bonus shown as its percentage over neutral for a multiplier, or as its rating. Arithmetic on the stored value; a bonus row with no value is shown as unknown.',
})

registerRule({
  id: RECORD_DATE,
  versions: VERSIONS,
  units: 'date',
  verification: 'estimated',
  structure: ['FCT_CommanderHistory.GameTime', 'FCT_Game.StartYear'],
  note: 'The calendar date of a career record: the game\'s start year plus the stored time in seconds. A record with no stored time, or a save with no start year, has no date.',
})

// "6:1.15,25:6" -> { 6: 1.15, 25: 6 }. An entry with no value ("9:") is a stored bonus with no value: null. So is the entry of a bonus in `blocked`, whose stored value the save's lookup row does not let the page read as that bonus, so that every figure built on the value is unknown.
export const parseBonuses = (text, blocked = NONE) => Object.fromEntries((text || '').split(',').filter(Boolean).map((pair) => {
  const [id, value] = pair.split(':')

  return [Number(id), blocked.has(Number(id)) || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)]
}))

export const formatBonus = (bonusId, value, blocked = NONE) => (!isKnownNumber(value) || blocked.has(bonusId) ? UNKNOWN_TEXT : RATINGS.has(bonusId) ? `${Math.round(value)}` : `${value >= 1 ? '+' : '−'}${Math.round(Math.abs(value - 1) * 100)}%`)

// The commander's career tag for a roster: the abbreviation of the rank, the field of a scientist, 'Administrator' for an administrator and a dash for an officer whose rank is not stored.
export const rankLabel = (person) => person.RankAbbrev || (person.CommanderType === 3 ? person.FieldName || 'Scientist' : person.CommanderType === 2 ? 'Administrator' : UNKNOWN_TEXT)

const unique = (list) => [...new Set(list)]

const NAMED_LIMIT = 4

// A list of names for a result's missing inputs: the first few and the number left over, so a save with many gaps does not fill a tooltip.
const named = (list) => {
  const names = unique(list)

  return names.length > NAMED_LIMIT ? [...names.slice(0, NAMED_LIMIT), `${names.length - NAMED_LIMIT} more`] : names
}

const bonusName = (bonusId, names) => (names && names[bonusId]) || `bonus ${bonusId}`

// What a bonus a commander holds no row for is worth: none, which is 1 for a multiplier and 0 for a rating (the game's own reading). A row with no value stays null: the commander's bonus is unknown.
export const neutralBonus = (bonusId) => (RATINGS.has(bonusId) ? 0 : 1)

const heldBonus = (person, bonusId) => {
  const value = person.bonuses[bonusId]

  return value === undefined ? neutralBonus(bonusId) : value
}

// The commanders with a stored post of 0. One with no stored post is neither idle nor assigned.
const idleOf = (people) => people.filter((person) => person.CommandType === 0)

const postUnknown = (person) => !isKnownNumber(person.CommandType)

// A count of stored rows at the rule's own verification. Rows whose test cannot be decided are left out of it, so it is then only a lower bound: estimated, naming `missing`.
const countOf = ({ rule, value, unknown = 0, missing = '', units }) => {
  if (!unknown) {
    return ofRule({ rule, value, units })
  }

  return envelope({ value, status: weakestStatus([getRule(rule).verification, STATUS.ESTIMATED]), rule, inputs: { missing: [missing] }, units, assumptions: [`${unknown} left out: ${missing}`] })
}

// Serving commanders by type: the total, who is unassigned and the counts the tiles and the type toggle show, each as a result. `unsettled` is the number of commanders whose retirement or prisoner flag is not stored, which belong to neither the serving nor the former list. A commander with no stored type is in the total and in no type; one with no stored post is not idle.
export const commanderCounts = (people, unsettled = 0) => {
  const untyped = people.filter((person) => !isKnownNumber(person.CommanderType)).length
  const noPost = people.filter(postUnknown).length
  const types = COMMANDER_TYPES.map((type) => {
    const rows = people.filter((person) => person.CommanderType === type.id)
    const lacking = rows.filter(postUnknown).length

    return {
      ...type,
      total: rows.length,
      idle: idleOf(rows).length,
      totalResult: countOf({ rule: COUNT, value: rows.length, unknown: untyped + unsettled, missing: `the type of ${untyped} commanders, the status of ${unsettled}`, units: 'commanders' }),
      idleResult: countOf({ rule: UNASSIGNED, value: idleOf(rows).length, unknown: lacking, missing: `the post of ${lacking} ${type.plural.toLowerCase()}`, units: 'commanders' }),
    }
  })

  return {
    total: people.length,
    idle: idleOf(people).length,
    untyped,
    noPost,
    unsettled,
    totalResult: countOf({ rule: COUNT, value: people.length, unknown: unsettled, missing: `the retirement or prisoner status of ${unsettled} commanders`, units: 'commanders' }),
    idleResult: countOf({ rule: UNASSIGNED, value: idleOf(people).length, unknown: noPost + unsettled, missing: `the post of ${noPost} commanders, the status of ${unsettled}`, units: 'commanders' }),
    types,
  }
}

// Whether a commander is unassigned, as a result of 'commanders.unassigned' (value true or false): unavailable when the post is not stored.
export const assignmentResult = (person) => (postUnknown(person) ? unavailable({ rule: UNASSIGNED, missing: [`the post of ${person.Name}`] }) : ofRule({ rule: UNASSIGNED, value: person.CommandType === 0, inputs: { present: ['CommandType'] } }))

// A stored bonus value of a commander as a result of 'commanders.bonusValue': unavailable when the row holds no value. `description` names the bonus.
export const bonusValueResult = (person, bonusId, description) => {
  const value = person.bonuses[bonusId]

  return isKnownNumber(value) ? ofRule({ rule: BONUS_VALUE, value, inputs: { present: [description] } }) : unavailable({ rule: BONUS_VALUE, missing: [`${description} of ${person.Name}`] })
}

// Lexicographic comparison of bonus tuples; positive when `a` ranks above `b`.
const compareKeys = (a, b) => {
  for (let index = 0; index < a.length; index++) {
    if (Math.abs(a[index] - b[index]) > EPSILON) {
      return a[index] - b[index]
    }
  }

  return 0
}

// The tuple a commander is ranked by for a colony: the value of each required bonus, 1 for a slot with none. `missing` names the stored bonus rows with no value.
const keyOf = (person, required, names) => {
  const missing = []
  const key = required.map((bonusId) => {
    if (!(bonusId > 0)) {
      return 1
    }

    const value = heldBonus(person, bonusId)

    if (value === null) {
      missing.push(`${bonusName(bonusId, names)} of ${person.Name}`)
    }

    return value
  })

  return { key, missing }
}

const REQUIRED_COLUMNS = ['BonusOne', 'BonusTwo', 'BonusThree']
const REQUIRED_WORDS = { BonusOne: 'the required bonus', BonusTwo: 'the second required bonus', BonusThree: 'the third required bonus' }

// How one colony stands: 'unknown' (what it lacks in `gaps`), 'unrated' (no required bonus set), 'no-candidate', 'not-stronger' or 'improvement'. A colony with no stored requirement, a governor not among the administrators, or a governor or candidate whose bonus has no value cannot be rated.
const governorOutcome = (colony, byId, idle, names) => {
  const name = colony.PopName
  const vacant = !colony.GovernorID
  const popGap = vacant && !isKnownNumber(colony.Population)
  const requirementGaps = (colony.BonusOne > 0 ? REQUIRED_COLUMNS : REQUIRED_COLUMNS.slice(0, 1)).filter((column) => !isKnownNumber(colony[column])).map((column) => `${REQUIRED_WORDS[column]} of ${name}`)
  const gaps = [...(popGap ? [`the population of ${name}`] : []), ...requirementGaps]

  if (gaps.length) {
    return { colony, status: 'unknown', gaps, popGap, requirementGap: requirementGaps.length > 0 }
  } else if (!(colony.BonusOne > 0)) {
    return { colony, status: 'unrated' }
  }

  const governor = vacant ? null : byId[colony.GovernorID] || null

  if (!vacant && !governor) {
    return { colony, status: 'unknown', gaps: [`the governor of ${name} (commander ${colony.GovernorID}) is not among the serving administrators`] }
  }

  const required = REQUIRED_COLUMNS.map((column) => colony[column])
  const current = governor ? keyOf(governor, required, names) : null
  const rated = idle.filter((admin) => admin.bonuses[colony.BonusOne] !== undefined).map((admin) => ({ admin, ...keyOf(admin, required, names) }))
  const candidates = rated.filter((candidate) => !candidate.missing.length).sort((a, b) => compareKeys(b.key, a.key))
  const best = candidates[0]
  const candidateGaps = rated.flatMap((candidate) => candidate.missing)

  if (!rated.length) {
    return { colony, status: 'no-candidate' }
  } else if (current && current.missing.length) {
    return { colony, status: 'unknown', gaps: [...current.missing, ...candidateGaps] }
  } else if (best && (!governor || compareKeys(best.key, current.key) > 0)) {
    return { colony, status: 'improvement', governor, current: current ? current.key : null, candidate: best.admin, candidateKey: best.key, gaps: candidateGaps }
  } else if (candidateGaps.length) {
    return { colony, status: 'unknown', gaps: candidateGaps }
  }

  return { colony, status: 'not-stronger' }
}

const tally = () => ({ assigned: 0, vacant: 0 })

// Governors (docs `crew-and-commanders`, automated assignment): a candidate must have the colony's required bonus and ranks by it, then the secondary, then the tertiary bonus. For each colony with a required bonus: the best unassigned administrator, when they beat the governor (or there is none). A candidate can be the best for several colonies; `alsoBestFor` counts the others. `names` maps a bonus id to its description for the inputs a result names.
// Returns { rows, unrated, coverage }. `rows` are the improvements, each with a result of 'commanders.governorBonus' (an improvement that leaves out a candidate whose bonus has no value names it). `unrated` are the colonies that cannot be rated, each { colony, result } with the result unavailable and naming what is missing. `coverage` is what the rows leave out: per colony `status` is 'improvement', 'unrated' (no required bonus, not evaluated), 'no-candidate' (no unassigned administrator holds the required bonus), 'not-stronger' (the best unassigned candidate does not beat the governor) or 'unknown' (cannot be rated). `improvements` is only the colonies where an unassigned administrator beats the governor, so it can be zero while every colony is staffed. `eligibleIdle` counts unassigned administrators holding the required bonus of at least one colony; `candidates` counts the distinct administrators proposed; `results` gives the counts the page shows as results.
export const governorReview = (colonies, administrators, names = {}) => {
  const idle = idleOf(administrators)
  const byId = Object.fromEntries(administrators.map((admin) => [admin.CommanderID, admin]))
  const outcomes = colonies.map((colony) => governorOutcome(colony, byId, idle, names))
  const improved = outcomes.filter((outcome) => outcome.status === 'improvement')
  const rows = improved.map((outcome) => ({
    colony: outcome.colony,
    governor: outcome.governor,
    current: outcome.current,
    candidate: outcome.candidate,
    candidateKey: outcome.candidateKey,
    alsoBestFor: improved.filter((other) => other !== outcome && other.candidate === outcome.candidate).length,
    result: ofRule({ rule: GOVERNOR, value: { current: outcome.current, candidate: outcome.candidateKey }, inputs: { present: [`bonuses of ${outcome.candidate.Name}`], missing: named(outcome.gaps) } }),
  }))
  const unrated = outcomes.filter((outcome) => outcome.status === 'unknown').map((outcome) => ({ colony: outcome.colony, result: unavailable({ rule: GOVERNOR, missing: named(outcome.gaps) }) }))
  const status = {}
  const coverage = {
    colonies: colonies.length,
    assigned: 0,
    vacant: 0,
    unrated: tally(),
    noCandidate: tally(),
    unknown: tally(),
    notStronger: 0,
    improvements: rows.length,
    candidates: new Set(rows.map((row) => row.candidate.CommanderID)).size,
    idleAdmins: idle.length,
    noPostAdmins: administrators.filter(postUnknown).length,
    eligibleIdle: 0,
    status,
  }
  const wanted = new Set(colonies.filter((colony) => colony.BonusOne > 0).map((colony) => colony.BonusOne))
  const popGaps = outcomes.filter((outcome) => outcome.popGap).length

  coverage.eligibleIdle = idle.filter((admin) => [...wanted].some((bonusId) => admin.bonuses[bonusId] !== undefined)).length
  coverage.popGaps = popGaps

  outcomes.forEach((outcome) => {
    const side = outcome.colony.GovernorID ? 'assigned' : 'vacant'

    status[outcome.colony.PopulationID] = outcome.status

    if (side === 'assigned' || !outcome.popGap) {
      coverage[side]++
    }

    if (outcome.status === 'unrated') {
      coverage.unrated[side]++
    } else if (outcome.status === 'unknown') {
      coverage.unknown[side]++
    } else if (outcome.status === 'no-candidate') {
      coverage.noCandidate[side]++
    } else if (outcome.status === 'not-stronger') {
      coverage.notStronger++
    }
  })

  const requirementGaps = outcomes.filter((outcome) => outcome.requirementGap).length

  coverage.results = {
    vacant: countOf({ rule: VACANT, value: coverage.vacant, unknown: popGaps, missing: `the population of ${popGaps} colonies without a governor`, units: 'colonies' }),
    improvements: countOf({ rule: GOVERNOR, value: rows.length, unknown: unrated.length, missing: `${unrated.length} colonies cannot be rated`, units: 'colonies' }),
    idle: countOf({ rule: UNASSIGNED, value: idle.length, unknown: coverage.noPostAdmins, missing: `the post of ${coverage.noPostAdmins} administrators`, units: 'administrators' }),
    eligible: countOf({ rule: GOVERNOR, value: coverage.eligibleIdle, unknown: requirementGaps, missing: `the required bonus of ${requirementGaps} colonies`, units: 'administrators' }),
  }

  return { rows, unrated, coverage }
}

// The class modules that make a ship a specialist ship.
const SPECIALIST_COLUMNS = ['Terraformers', 'MiningModules', 'Harvesters', 'GeoSurvey', 'GravSurvey']

// Whether a ship's class is a specialist one: true when a module count is above 0, false when every one is stored as 0, null when none is above 0 and one is not stored.
export const isSpecialist = (ship) => (SPECIALIST_COLUMNS.some((column) => ship[column] > 0) ? true : SPECIALIST_COLUMNS.every((column) => isKnownNumber(ship[column])) ? false : null)

// Specialist ships with no captain, as { value, unknown, result }: `result` is of 'commanders.captainless' and `unknown` the ships without a captain whose class modules are not stored, which are not counted.
export const captainlessShips = (ships) => {
  const captainless = ships.filter((ship) => !ship.CaptainID)
  const value = captainless.filter((ship) => isSpecialist(ship) === true).length
  const unknown = captainless.filter((ship) => isSpecialist(ship) === null).length

  return { value, unknown, result: countOf({ rule: CAPTAINLESS, value, unknown, missing: `the class modules of ${unknown} ships without a captain`, units: 'ships' }) }
}

const SHIP_INPUTS = { RankRequired: 'the rank the class requires', ClassSize: 'the size of the class', Terraformers: 'the number of terraformers', MiningModules: 'the number of mining modules', Harvesters: 'the number of harvesters', SciencePosts: 'the number of science posts', GeoSurvey: 'the geological survey strength', GravSurvey: 'the gravitational survey strength' }

// The name of a main function code: the game's, else its number, else unknown.
export const mainFunctionLabel = (code) => MAIN_FUNCTIONS[code] || (isKnownNumber(code) ? `Function ${code}` : UNKNOWN_TEXT)

// A stored flag as true or false (a boolean, or a number that is not 0); null when it is not stored.
const flagOf = (value) => (typeof value === 'boolean' ? value : isKnownNumber(value) ? value !== 0 : null)

// The function the player declared for a ship's class (`FCT_ShipClass.UserDefinedFunction` set), as { code, label }; null for a class whose function the game works out and for one whose function or declaration is not stored.
export const declaredFunction = (ship) => (flagOf(ship.UserDefinedFunction) === true && isKnownNumber(ship.MainFunction) ? { code: ship.MainFunction, label: mainFunctionLabel(ship.MainFunction) } : null)

// Whether a main function code is one the game names (`MAIN_FUNCTIONS`): a stored code of another kind, or none, is not a function the page can tell from Light Naval.
const namedFunction = (ship) => isKnownNumber(ship.MainFunction) && MAIN_FUNCTIONS[ship.MainFunction] !== undefined

// What the class's officers, declaration and size say for a Light Naval function: true when the class has officers and is declared or of `LIGHT_NAVAL_SIZE` hull spaces or fewer, false with no officers or for a class that is not declared and is larger, null where a flag or the size that decides is not stored.
const lightNavalFit = (ship) => {
  const officers = flagOf(ship.NoOfficers)
  const declared = flagOf(ship.UserDefinedFunction)

  if (officers === true) {
    return false
  } else if (officers === null) {
    return null
  } else if (declared === true) {
    return true
  }

  if (!isKnownNumber(ship.ClassSize)) {
    return null
  }

  return ship.ClassSize <= LIGHT_NAVAL_SIZE ? true : declared === false ? false : null
}

// Whether a ship is a light naval one, whose captain the game ranks by Light Tactical (`Race.AssignCommanderAssignmentScore`): its class's stored main function is Light Naval, the class has officers, and either the player declared the function or the class is of `LIGHT_NAVAL_SIZE` hull spaces or fewer (the limit the game's own choice stops at). True, false, or null where what decides it is not stored (a class with no stored officers flag, size, or declaration). A stored function the game names other than Light Naval is not one. A class whose function is not stored, or is not one the game names, may be one: it is not one only where its officers, declaration and size rule out any function being Light Naval, else null.
export const isLightNavalPost = (ship) => {
  const named = namedFunction(ship)

  if (named && ship.MainFunction !== LIGHT_NAVAL_FUNCTION) {
    return false
  }

  const fit = lightNavalFit(ship)

  return named || fit === false ? fit : null
}

// What keeps `isLightNavalPost` from answering for a ship, as phrases for a missing list.
const lightNavalGaps = (ship, where) => [
  ...(namedFunction(ship) ? [] : [isKnownNumber(ship.MainFunction) ? `the main function of the class of ${where}, stored as ${ship.MainFunction}, which the game does not name` : `the main function of the class of ${where}`]),
  ...(flagOf(ship.NoOfficers) === null ? [`whether the class of ${where} has officers`] : []),
  ...(flagOf(ship.UserDefinedFunction) !== true && !isKnownNumber(ship.ClassSize) ? [`the size of the class of ${where}`] : []),
  ...(flagOf(ship.UserDefinedFunction) === null && isKnownNumber(ship.ClassSize) && ship.ClassSize > LIGHT_NAVAL_SIZE ? [`whether the function of the class of ${where} was declared`] : []),
]

// The rank a ship's captain must hold, as { level, flagged, missing } (`Ship.method_47` of the game, which asks the ship for it): the rank the class requires as a level (1 is the lowest naval rank; the stored requirement already carries the class's own Senior CO option, so it is not added again) and one level higher for a ship that is flagged Senior CO itself (`FCT_Ship.ShipSeniorCO` is 1). The game finds no rank for a flagged ship whose class already holds the highest naval rank: `ship.NavalRanks` is the number of the race's naval ranks. `missing` names what is not stored or not there, and `level` is then null. A flag the save does not hold — a save without the column, whose read selects it as null, or a null under it — is not read as an unflagged ship: the game adds one rank to the class's when the flag is 1, so either could have been 1, and the rank is unknown with `flagged` null and the setting named in `missing`. The ranks of the other posts stay relative to the class.
export const captainRank = (ship) => {
  const where = ship.ClassName || `class of ship ${ship.ShipID}`
  const known = isKnownNumber(ship.ShipSeniorCO)
  const ranked = isKnownNumber(ship.RankRequired)
  const missing = [...(ranked ? [] : [`${SHIP_INPUTS.RankRequired} of ${where}`]), ...(known ? [] : [`the Senior CO setting of ${ship.ShipName || `ship ${ship.ShipID}`}`])]

  if (missing.length) {
    return { level: null, flagged: null, missing }
  }

  const flagged = ship.ShipSeniorCO === 1

  if (!flagged) {
    return { level: ship.RankRequired, flagged, missing }
  } else if (!isKnownNumber(ship.NavalRanks)) {
    return { level: null, flagged, missing: ['the naval ranks of the race'] }
  } else if (ship.RankRequired + 1 > ship.NavalRanks) {
    return { level: null, flagged, missing: [`a naval rank above the rank the class requires of ${where}`] }
  }

  return { level: ship.RankRequired + 1, flagged, missing }
}

// The officer post and bonus that matter on a ship, as a result of 'commanders.specialistPost' with the value { post, bonusId, label, level, share, seniorCO } (and `combat` for a ship over the limit). A light naval ship (`isLightNavalPost`) has its captain ranked by Light Tactical, the bonus of the game's assignment order for that function (Race.cs 13280-13344): `share` is the part of it that counts in the ship's own tactical multiplier (Ship.cs 1731-1741, 5621-5627), 1 for a class of `LIGHT_NAVAL_SIZE` hull spaces or fewer, 0 for a larger one, which only a declared class is, and null where the size is not stored, with `combat` { bonusId, label, share } naming the bonus that counts there instead (Tactical, half; `Commander.method_7`). Terraformers and miners use their captain's full bonus. Survey ships use their science officer's full Survey bonus when the class has a Science Department, else their captain's: in full for a class of `LIGHT_NAVAL_SIZE` hull spaces or less (`ship.ClassSize`), half for a larger one. The captain's `level` is `captainRank`'s, `seniorCO` whether the ship's own flag raised it; a secondary officer ranks one below the rank the class requires, the flag leaving it alone. A class whose module counts, size or required rank are not stored has no post, nor has a captain's post of a ship whose Senior CO setting the save does not hold, or that has no rank above its class's, nor a class that may be Light Naval and whose main function, officers, size or declaration are not stored. `blocked` are the bonus IDs the save's lookup rows do not confirm: a post that rests on one is unavailable, naming it.
export const specialistPost = (ship, blocked = NONE) => {
  const where = ship.ClassName || `class of ship ${ship.ShipID}`
  const lacking = (columns) => columns.filter((column) => !isKnownNumber(ship[column])).map((column) => `${SHIP_INPUTS[column] || column} of ${where}`)
  const post = (value, notes = []) => {
    const science = value.post === 'science'
    const rank = science ? null : captainRank(ship)
    const missing = [...(science ? lacking(['RankRequired']) : rank.missing), ...(blocked.has(value.bonusId) ? [`the save's row for bonus ${value.bonusId}, ${value.label}`] : [])]

    return missing.length ? unavailable({ rule: POST, missing }) : ofRule({ rule: POST, value: { ...value, level: science ? Math.max(1, ship.RankRequired - 1) : rank.level, seniorCO: science ? false : rank.flagged }, inputs: { present: science ? ['class modules', 'RankRequired'] : ['class modules', 'RankRequired', 'Senior CO setting'], missing: notes } })
  }
  // The captain of a light naval ship: ranked by Light Tactical whatever the size, which counts in the ship's tactical multiplier only up to `LIGHT_NAVAL_SIZE` hull spaces and gives way to half of Tactical above.
  const lightNavalPost = () => {
    const base = { post: 'captain', bonusId: LIGHT_TACTICAL, label: 'Light Tactical' }

    if (!isKnownNumber(ship.ClassSize)) {
      return post({ ...base, share: null }, [`the size of the class of ${where}, which says whether Light Tactical counts in combat`])
    }

    const over = ship.ClassSize > LIGHT_NAVAL_SIZE

    return over ? post({ ...base, share: 0, combat: { bonusId: TACTICAL, label: 'Tactical', share: 0.5 } }) : post({ ...base, share: 1 })
  }

  const lightNaval = isLightNavalPost(ship)

  if (lightNaval === null) {
    return unavailable({ rule: POST, missing: lightNavalGaps(ship, where) })
  } else if (lightNaval) {
    return lightNavalPost()
  } else if (!isKnownNumber(ship.Terraformers)) {
    return unavailable({ rule: POST, missing: lacking(['Terraformers', 'RankRequired']) })
  } else if (ship.Terraformers > 0) {
    return post({ post: 'captain', bonusId: TERRAFORMING, label: 'Terraforming', share: 1 })
  } else if (ship.MiningModules > 0) {
    return post({ post: 'captain', bonusId: MINING, label: 'Mining', share: 1 })
  } else if (!isKnownNumber(ship.MiningModules) || !isKnownNumber(ship.Harvesters)) {
    return unavailable({ rule: POST, missing: lacking(['MiningModules', 'Harvesters', 'RankRequired']) })
  } else if (ship.Harvesters > 0) {
    return post({ post: 'captain', bonusId: MINING, label: 'Mining (harvesting)', share: 1 })
  } else if (!isKnownNumber(ship.SciencePosts)) {
    return unavailable({ rule: POST, missing: lacking(['SciencePosts', 'RankRequired']) })
  } else if (ship.SciencePosts > 0) {
    return post({ post: 'science', bonusId: SURVEY, label: 'Survey', share: 1 })
  } else if (!(ship.GeoSurvey > 0 || ship.GravSurvey > 0) && lacking(['GeoSurvey', 'GravSurvey']).length) {
    return unavailable({ rule: POST, missing: lacking(['GeoSurvey', 'GravSurvey', 'RankRequired']) })
  } else if (!isKnownNumber(ship.ClassSize)) {
    return unavailable({ rule: POST, missing: lacking(['ClassSize', 'RankRequired']) })
  }

  return ship.ClassSize <= LIGHT_NAVAL_SIZE ? post({ post: 'captain', bonusId: SURVEY, label: 'Survey', share: 1 }) : post({ post: 'captain', bonusId: SURVEY, label: 'Survey (half for a captain)', share: 0.5 })
}

// Ships where an unassigned naval officer of the post's rank has a better bonus than the officer in it (or the post is empty): the specialist ships, or the light naval ones. `officers`: naval officers with `bonuses` and `RankLevel`. Returns { rows, unrated }: `rows` are the posts to improve or vacant, each with a result of 'commanders.shipBonus' that names a candidate left out for a missing bonus or rank (`unknownCandidates` counts them), and `unrated` the ships that cannot be rated, each { ship, result } with the result unavailable. A row is the best unassigned officer for its post taken alone: one officer can be the candidate of many rows, `alsoBestFor` counts the other rows that name the same officer, and those rows are alternatives, not a simultaneous allocation. A row of a post that carries `combat` (a light naval ship over the limit) holds the holder's and the candidate's bonus of that kind beside the ranking's, as `combat` { bonusId, label, share, current, candidate }. A vacant post stays a row whether or not an officer is better. A post holder not among the officers, or whose bonus has no value, cannot be rated. `blocked` as for `specialistPost`.
export const shipSuggestions = (ships, officers, names = {}, blocked = NONE) => {
  const idle = idleOf(officers)
  const byId = Object.fromEntries(officers.map((officer) => [officer.CommanderID, officer]))
  const ranking = new Map()
  const rows = []
  const unrated = []

  // The unassigned officers by a bonus, the best first, and the ones whose stored bonus has no value.
  const rankedBy = (bonusId) => {
    if (!ranking.has(bonusId)) {
      const ranked = idle.map((officer) => ({ officer, value: heldBonus(officer, bonusId) }))

      ranking.set(bonusId, { known: ranked.filter(({ value }) => value !== null).sort((a, b) => b.value - a.value), gaps: ranked.filter(({ value }) => value === null).map(({ officer }) => `${bonusName(bonusId, names)} of ${officer.Name}`) })
    }

    return ranking.get(bonusId)
  }

  ships.forEach((ship) => {
    const postResult = specialistPost(ship, blocked)

    if (!isAvailable(postResult)) {
      unrated.push({ ship, result: postResult })

      return
    }

    const post = postResult.value
    const holderId = post.post === 'science' ? ship.ScienceOfficerID : ship.CaptainID
    const holder = holderId ? byId[holderId] || null : null
    const heldValue = holder ? heldBonus(holder, post.bonusId) : null

    if (holderId && !holder) {
      unrated.push({ ship, result: unavailable({ rule: SHIP, missing: [`the ${post.post === 'science' ? 'science officer' : 'captain'} of ${ship.ShipName} (commander ${holderId}) is not among the serving naval officers`] }) })

      return
    } else if (holder && heldValue === null) {
      unrated.push({ ship, result: unavailable({ rule: SHIP, missing: [`${bonusName(post.bonusId, names)} of ${holder.Name}`] }) })

      return
    }

    const current = holder ? heldValue : null
    const { known, gaps: bonusGaps } = rankedBy(post.bonusId)
    const better = []

    for (const entry of known) {
      if (!(entry.value > (current ?? 1) + EPSILON)) {
        break
      }

      better.push(entry)
    }

    const atRank = better.filter(({ officer }) => officer.RankLevel === post.level)
    const unranked = better.filter(({ officer }) => !isKnownNumber(officer.RankLevel))
    const best = atRank[0]
    const gaps = [...bonusGaps, ...unranked.map(({ officer }) => `the rank level of ${officer.Name}`)]

    if (!best && holder) {
      if (gaps.length) {
        unrated.push({ ship, result: unavailable({ rule: SHIP, missing: named(gaps) }) })
      }

      return
    }

    // What counts in combat where it is not the ranking's bonus (a light naval ship over the limit): the holder's and the candidate's bonus of that kind, none where the save's row for it is not confirmed.
    const combat = post.combat ? { ...post.combat, current: holder && !blocked.has(post.combat.bonusId) ? heldBonus(holder, post.combat.bonusId) : null, candidate: best && !blocked.has(post.combat.bonusId) ? heldBonus(best.officer, post.combat.bonusId) : null } : null

    rows.push({
      ship,
      post,
      postResult,
      holder,
      current,
      candidate: best ? best.officer : null,
      combat,
      alsoBestFor: 0,
      otherRanks: better.length - atRank.length - unranked.length,
      unknownCandidates: gaps.length,
      result: combine({ rule: SHIP, parts: { post: postResult }, compute: () => ({ current, candidate: best ? best.value : null }), inputs: { present: ['officer bonuses'], missing: named(gaps) } }),
    })
  })

  // The rows that name the same officer are alternatives for that one officer, not a simultaneous allocation.
  const rowsOf = new Map()

  rows.forEach((row) => row.candidate && rowsOf.set(row.candidate, (rowsOf.get(row.candidate) || 0) + 1))
  rows.forEach((row) => {
    row.alsoBestFor = row.candidate ? rowsOf.get(row.candidate) - 1 : 0
  })

  return { rows, unrated }
}

// A scientist's research multiplier, as a result of 'commanders.researchMultiplier': in their own field the bonus counts four times (1.15 -> 1.60), outside it once (production.vue's rule; the docs: changing field cuts the bonus by 75%). `inField` is true, false or null when the field of the scientist or the project is not stored. A scientist with no stored Research row has none, ×1; a row with no value is unavailable.
export const researchMultiplier = (scientist, inField) => {
  const bonus = heldBonus(scientist, RESEARCH)
  const missing = [...(bonus === null ? [`Research bonus of ${scientist.Name}`] : []), ...(inField === null ? [`research field of ${scientist.Name} or of the project`] : [])]

  return missing.length ? unavailable({ rule: MULTIPLIER, missing }) : ofRule({ rule: MULTIPLIER, value: inField ? 4 * bonus - 3 : bonus, inputs: { present: ['Research bonus', 'research field'] } })
}

// Research projects where an unassigned scientist of the project's field, able to run its labs (Research Administration >= labs), would research faster than the scientist on it. Returns { rows, unrated, skipped }: `rows` carry the multipliers as results, `candidateLabs` and a result of 'commanders.researchSuggestion', and `unrated` the projects that cannot be rated, each { project, result } with the result unavailable. A project with no scientist researches at ×1. A project whose labs or field, a holder who is not among the scientists, or a scientist whose Research bonus, Research Administration or field is not stored cannot be rated unless no unassigned scientist could be its candidate. With a `blocked` Research or Research Administration bonus no project can be rated. `noResearch`: the race starts no research projects (`FCT_Race.NoResearchProjects`), so no scientist is suggested for a project and `skipped` gives the reason (`NO_RESEARCH_WORDS`); it is null otherwise.
export const researchSuggestions = (projects, scientists, blocked = NONE, { noResearch = false } = {}) => {
  if (noResearch === true) {
    return { rows: [], unrated: [], skipped: NO_RESEARCH_WORDS }
  }

  const unconfirmed = [RESEARCH, RESEARCH_ADMINISTRATION].filter((bonusId) => blocked.has(bonusId))

  if (unconfirmed.length) {
    return { rows: [], unrated: projects.map((project) => ({ project, result: unavailable({ rule: PROJECT, missing: unconfirmed.map((bonusId) => `the save's row for bonus ${bonusId}`) }) })), skipped: null }
  }

  const idle = idleOf(scientists)
  const byId = Object.fromEntries(scientists.map((scientist) => [scientist.CommanderID, scientist]))
  const rows = []
  const unrated = []

  projects.forEach((project) => {
    const label = project.ProjectName || `project ${project.ProjectID}`
    const holder = project.ScientistID ? byId[project.ScientistID] || null : null
    const fieldOf = (scientist) => (isKnownNumber(project.ResSpecID) && isKnownNumber(scientist.ResSpecID) ? scientist.ResSpecID === project.ResSpecID : null)
    const currentResult = !project.ScientistID ? ofRule({ rule: MULTIPLIER, value: 1, inputs: { present: ['no scientist'] }, assumptions: ['A project with no scientist researches at ×1'] }) : holder ? researchMultiplier(holder, fieldOf(holder)) : unavailable({ rule: MULTIPLIER, missing: [`the scientist of ${label} (commander ${project.ScientistID}) is not among the serving scientists`] })
    const eligible = []
    const gaps = []

    idle.forEach((scientist) => {
      const field = fieldOf(scientist)
      const rating = heldBonus(scientist, RESEARCH_ADMINISTRATION)
      const labs = isKnownNumber(project.Facilities) && rating !== null ? rating >= project.Facilities : null
      const lacking = [...(field === null ? [isKnownNumber(project.ResSpecID) ? `research field of ${scientist.Name}` : `research field of ${label}`] : []), ...(isKnownNumber(project.Facilities) ? [] : [`Facilities of ${label}`]), ...(rating === null ? [`Research Administration of ${scientist.Name}`] : [])]

      if (field === true && labs === true) {
        const multiplier = researchMultiplier(scientist, true)

        if (isAvailable(multiplier)) {
          eligible.push({ scientist, multiplier, labs: rating })
        } else {
          gaps.push(...multiplier.inputs.missing)
        }
      } else if (field !== false && labs !== false) {
        gaps.push(...lacking)
      }
    })

    const best = eligible.sort((a, b) => b.multiplier.value - a.multiplier.value)[0]

    if (!isAvailable(currentResult)) {
      if (best || gaps.length) {
        unrated.push({ project, result: unavailable({ rule: PROJECT, missing: named([...currentResult.inputs.missing, ...gaps]) }) })
      }
    } else if (best && best.multiplier.value > currentResult.value + EPSILON) {
      rows.push({
        project,
        holder,
        current: currentResult.value,
        currentResult,
        candidate: best.scientist,
        candidateMultiplier: best.multiplier.value,
        candidateResult: best.multiplier,
        candidateLabs: Math.round(best.labs),
        result: combine({ rule: PROJECT, parts: { current: currentResult, candidate: best.multiplier }, compute: ({ current, candidate }) => ({ current, candidate }), inputs: { missing: named(gaps) } }),
      })
    } else if (gaps.length) {
      unrated.push({ project, result: unavailable({ rule: PROJECT, missing: named(gaps) }) })
    }
  })

  return { rows, unrated, skipped: null }
}

// The assignments an unassigned officer would improve, as a result of 'commanders.bonusSuggestion': the governor, ship, research and light naval rows added (`light` as `ships`, for the light naval ships). `unrated` is the number of assignments left out because they cannot be rated.
export const bonusSuggestionCount = (governors, ships, research, light = { rows: [], unrated: [] }) => {
  const unknown = governors.unrated.length + ships.unrated.length + research.unrated.length + light.unrated.length
  const value = governors.rows.length + ships.rows.length + research.rows.length + light.rows.length

  return { value, unknown, result: countOf({ rule: SUGGESTIONS, value, unknown, missing: `${unknown} assignments cannot be rated`, units: 'assignments' }) }
}

// A former commander's kills in tonnes, as a result of 'commanders.kills': the military and commercial tonnage added; unavailable when either column is not stored.
export const killsResult = (person) => {
  const missing = [['KillTonnageMilitary', 'the military tonnage destroyed by'], ['KillTonnageCommercial', 'the commercial tonnage destroyed by']].filter(([column]) => !isKnownNumber(person[column])).map(([, words]) => `${words} ${person.Name}`)

  return missing.length ? unavailable({ rule: KILLS, missing }) : ofRule({ rule: KILLS, value: Number(person.KillTonnageMilitary) + Number(person.KillTonnageCommercial), inputs: { present: ['KillTonnageMilitary', 'KillTonnageCommercial'] } })
}

// Medals a commander holds, as a result of 'commanders.medals': the awards added, 0 for a commander with no award rows (`Medals` null), unavailable for awards with no stored amount.
export const medalsResult = (person) => (person.Medals === null || person.Medals === undefined ? ofRule({ rule: MEDALS, value: 0, inputs: { present: ['no award rows'] } }) : isKnownNumber(person.MedalCount) ? ofRule({ rule: MEDALS, value: Number(person.MedalCount), inputs: { present: ['NumAwarded'] } }) : unavailable({ rule: MEDALS, missing: [`the number of awards of the medals of ${person.Name}`] }))

// A commander's age in years, as a result of 'commanders.age': the species' graduation age plus the years from `CareerStart` to `until` (a game time), to one decimal. `untilName` names `until` when it is missing. Unavailable naming the graduation age, career start or end time that is not stored.
export const ageResult = (person, until, untilName = 'the game time') => {
  const missing = [...(isKnownNumber(person.GraduationAge) ? [] : [`the graduation age of ${person.Name}`]), ...(isKnownNumber(person.CareerStart) ? [] : [`the career start of ${person.Name}`]), ...(isKnownNumber(until) ? [] : [untilName])]

  return missing.length ? unavailable({ rule: AGE, missing }) : ofRule({ rule: AGE, value: roundToDecimal(Number(person.GraduationAge) + (Number(until) - Number(person.CareerStart)) / SECONDS_PER_YEAR, 1), inputs: { present: ['graduation age', 'CareerStart', untilName] } })
}

// A bound of the age range as a number, or null when it is off: a field left empty, text that is not a number and a negative figure are no bound.
export const ageBound = (value) => {
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value)

  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? number : null
}

// The posts and ranks the commanders of one type hold, as the choices of the roster's filters: `posts` are { value (CommandType), text } by post, `ranks` { value (RankLevel), text } by level. A commander with no stored post or rank adds no choice.
export const rosterChoices = (people) => {
  const posts = new Map()
  const ranks = new Map()

  people.forEach((person) => {
    if (isKnownNumber(person.CommandType) && !posts.has(person.CommandType)) {
      posts.set(person.CommandType, POSTS[person.CommandType] || `Post ${person.CommandType}`)
    }

    if (isKnownNumber(person.RankLevel) && !ranks.has(person.RankLevel)) {
      ranks.set(person.RankLevel, person.RankName || person.RankAbbrev || `Rank ${person.RankLevel}`)
    }
  })

  return {
    posts: Array.from(posts.entries()).map(([value, text]) => ({ value, text })).sort((a, b) => a.value - b.value),
    ranks: Array.from(ranks.entries()).map(([value, text]) => ({ value, text })).sort((a, b) => b.value - a.value),
  }
}

// The commanders of the roster that pass its filters. `people` are the commanders of the chosen type; the filters are the search over names and assignments, the unassigned-only switch, the research field (scientists), a bonus held, the post (CommandType), the rank (RankLevel) and the age range (both bounds inclusive, on the age as the roster shows it to one decimal). A filter that is off passes everyone.
// A commander whose value is not stored for an active filter (no post, no rank, an age that cannot be worked out) is neither inside nor outside it: left out of the rows and counted, never read as 0 or as another post. Gives { kept: [{ person, age }] (age the result of `ageResult`), notRated: { post, rank, age } }. A commander who falls outside another filter on a stored value is not counted: `notRated` is of those who would otherwise show.
export const rosterFilter = (people, { search = '', unassignedOnly = false, fieldId = null, typeId = null, bonusId = null, post = null, rank = null, ageMin = null, ageMax = null }) => {
  const text = (search || '').toLowerCase()
  const low = ageBound(ageMin)
  const high = ageBound(ageMax)
  const notRated = { post: 0, rank: 0, age: 0 }
  const kept = []

  people.forEach((person) => {
    if ((unassignedOnly && person.CommandType !== 0) || (fieldId !== null && typeId === 3 && person.ResSpecID !== fieldId) || (text && !`${person.Name} ${person.AssignmentName || ''}`.toLowerCase().includes(text)) || (bonusId !== null && person.bonuses[bonusId] === undefined)) {
      return
    }

    const age = ageResult(person, person.GameTime)
    const value = isAvailable(age) ? age.value : null
    const verdicts = {
      post: post === null ? true : isKnownNumber(person.CommandType) ? person.CommandType === post : null,
      rank: rank === null ? true : isKnownNumber(person.RankLevel) ? person.RankLevel === rank : null,
      age: low === null && high === null ? true : value === null ? null : (low === null || value >= low) && (high === null || value <= high),
    }

    if (Object.values(verdicts).includes(false)) {
      return
    }

    if (Object.values(verdicts).includes(null)) {
      Object.keys(verdicts).filter((name) => verdicts[name] === null).forEach((name) => notRated[name]++)

      return
    }

    kept.push({ person, age })
  })

  return { kept, notRated }
}

// The calendar date of a career record, as a result of 'commanders.recordDate' ('YYYY-MM-DD'): unavailable without a stored time or a game start year (a positive year; the store holds 0 until the clock is read).
export const recordDate = (startYear, seconds) => {
  const missing = [...(isKnownNumber(seconds) ? [] : ['the time of the record']), ...(isKnownNumber(startYear) && startYear > 0 ? [] : ['the game\'s start year'])]

  return missing.length ? unavailable({ rule: RECORD_DATE, missing }) : ofRule({ rule: RECORD_DATE, value: gameTime(startYear, seconds).format('YYYY-MM-DD'), inputs: { present: ['the time of the record', 'the game\'s start year'] } })
}

// The former-commander group counts, each a result of 'commanders.groupCount': `former` rows carry their `kind` ('prisoner', 'retired' or 'dead'), `held` is the alien prisoners the race holds. `unsettled` commanders (no stored status) are in no group, so each own group's count is then a lower bound that names them.
export const formerGroupCounts = (former, held, unsettled = 0) => {
  const counts = { prisoner: 0, retired: 0, dead: 0 }

  former.forEach((person) => counts[person.kind]++)

  const own = (kind) => countOf({ rule: GROUP, value: counts[kind], unknown: unsettled, missing: `the retirement or prisoner status of ${unsettled} commanders`, units: 'commanders' })

  return { prisoner: own('prisoner'), retired: own('retired'), dead: own('dead'), held: countOf({ rule: GROUP, value: held.length, units: 'commanders' }) }
}
