// The organisation the game gives a ground formation: its role, the symbol and echelon its order-of-battle chart draws for it, and the naming and symbol settings of the template it was raised from. Pure rules over the rows of the ground model (utilities/ground-formations.js); nothing is read here.
//
// The sources are the 3.1 game's, and none of the three figures is stored in a save: the role is worked out when a commander of the formation gains experience, and the symbol and echelon when the colony's chart is drawn. The save holds the settings they start from (the template's symbol type, echelon level, naming theme and random naming, and the elements and classes below), so each figure is read from its source and not checked against a saved value. The one stored symbol, a text column of the formation, is never read or written by the game, so a save holds it empty.
//
// - Role (`GroundUnitFormation.GetGroundFormationRole`): for every element the class size times the units is counted in the formation's total, in the kind of its unit base type (static, infantry, or one of the five vehicle sizes) and once in each of the kinds its class's components give it (logistics, bombardment, anti-air, construction, geological survey, xenoarchaeology, decontamination, surface to orbit). Logistics beyond twice the rest give ground logistics; then each kind above 40% of what is left after logistics gives, in this order, ground artillery, ground anti-aircraft, engineering, survey, xenoarchaeology, decontamination and planetary defence; then vehicles above 60% give ground attack and static units above 60% ground defence; otherwise the role is generic (tentative). The rule of the 2.7 game differed in three places: it counted a vehicle only when it was of the medium size, it tested engineering against the construction rating of the formation rather than the tonnage of its construction units, and it tested ground defence against the static tonnage itself.
// - Symbol (`GClass147.smethod_9`, `smethod_17` and the headquarters pass `smethod_12`/`smethod_14`): the original template's symbol type when it is not Auto, otherwise a type worked out from the elements by the same tonnage test as the role, in the order headquarters (units of a class with headquarters capacity above half of the total), supply, artillery, air defence, surface to orbit, engineer, geosurvey, xenoarchaeology, decontamination, static defence, armour, infantry, mechanised infantry (both infantry and vehicles, neither above 60%) and generic. A formation whose symbol is headquarters and which has formations of its own colony below it takes the commonest symbol of those below that is neither headquarters nor generic, the first of the formations, sorted by headquarters capacity, abbreviation and name with the game's own string comparison, winning a tie; where that comparison does not order two of them, the symbol is left unknown. Only a formation at a colony is drawn in a chart.
// - Echelon (`GClass147.smethod_9`, `smethod_18`): the original template's echelon when it is not Auto, otherwise the formation's required rank taken as a place among the race's ground ranks from the lowest: company, battalion, regiment, brigade, division, corps, army, and army for any place above. The stored rank may be any rank of the race: the game takes its priority and the ground rank of that priority (`GroundUnitFormation.GetRequiredCommanderRank`), so a naval rank draws the ground rank of its priority and not none. A priority no ground rank of the race holds gives no echelon. The rank is the stored required rank; the game works one out from the size and the commanders below when none is set, and that case is left unknown here.
// - Naming (`GroundUnitFormationTemplate.GenerateNextFormationName`, `Game.LoadGroundUnitFormationTemplates`): a template whose naming theme is the class name only or the name plus a number numbers its formations; any other theme names them from its list, shuffled when the template asks for random names, and the first name not in use wins. A theme the catalogue does not hold is read as the name plus a number.

import { fieldWords, ofRule, registerRule, unavailable } from './provenance'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isCount = (value) => isNumber(value) && value >= 0

const SLOTS = ['ComponentA', 'ComponentB', 'ComponentC', 'ComponentD']

// The symbol types a template can set, by the value the save stores (the game's own order); 0 is Auto.
export const SYMBOL_TYPES = Object.freeze(['Auto', 'Headquarters', 'Infantry', 'Armour', 'Mechanised Infantry', 'Artillery', 'Air Defence', 'Supply', 'Engineer', 'Geosurvey', 'Xenoarchaeology', 'Decontamination', 'Surface to Orbit', 'Static Defence', 'Generic', 'Motorised Infantry', 'Airborne Infantry', 'Air Assault Infantry', 'Marine Infantry', 'Mountain Infantry', 'Special Forces', 'Security', 'Armoured Cavalry', 'Reconnaissance', 'Anti-Armour', 'Self-Propelled Artillery', 'Rocket Artillery', 'Forward Observer', 'Military Police'])

// The echelons a template can set, by the value the save stores; 0 is Auto, 1 no echelon.
export const ECHELONS = Object.freeze(['Auto', 'None', 'Team', 'Squad', 'Section', 'Platoon', 'Company', 'Battalion', 'Regiment', 'Brigade', 'Division', 'Corps', 'Army'])

// The roles of a formation, by the value of the game's role enumeration.
export const ROLES = Object.freeze(['Generic (tentative)', 'Ground attack', 'Ground artillery', 'Ground anti-aircraft', 'Ground defence', 'Engineering', 'Survey', 'Planetary defence', 'Xenoarchaeology', 'Ground logistics', 'Decontamination'])

const SYMBOL = Object.freeze({ headquarters: 1, infantry: 2, armour: 3, mechanisedInfantry: 4, artillery: 5, airDefence: 6, supply: 7, engineer: 8, geosurvey: 9, xenoarchaeology: 10, decontamination: 11, surfaceToOrbit: 12, staticDefence: 13, generic: 14 })
const ROLE = Object.freeze({ generic: 0, attack: 1, artillery: 2, antiAir: 3, defence: 4, engineering: 5, survey: 6, planetaryDefence: 7, xenoarchaeology: 8, logistics: 9, decontamination: 10 })
const ECHELON_NONE = 1

// The unit base types (`FCT_GroundUnitClass.BaseType`): infantry 0, static 5, and the vehicles medium 1, heavy 2, super-heavy 3, ultra-heavy 4 and light 6.
const INFANTRY = 0
const STATIC = 5
const BASE_TYPES = Object.freeze([0, 1, 2, 3, 4, 5, 6])

// The echelons of the places a required rank can take among the race's ground ranks, the lowest rank first.
const CHART_ECHELONS = Object.freeze([6, 7, 8, 9, 10, 11, 12])

// The ground rank type of FCT_Ranks.
const GROUND_RANK = 1

// The theme ids at or below which a template numbers its formations (the class name only, the name plus a number), which is also the theme a template falls back to when its own is not in the catalogue.
const NUMBERED_THEMES = 1
const FALLBACK_THEME = 1

registerRule({
  id: 'groundOrganisation.role',
  versions: ['3.2.x'],
  units: '',
  verification: 'estimated',
  structure: ['FCT_GroundUnitFormationElement.ClassID, Units', 'FCT_GroundUnitClass.BaseType, Size, ComponentA, ComponentB, ComponentC, ComponentD', 'DIM_GroundComponentType.LogisticsPoints, BombardmentWeapon, AAWeapon, Construction, Geosurvey, Xenoarchaeology, Decontamination, STO'],
  note: 'The role the game gives a formation, worked out from the tonnage of its elements: logistics beyond twice the rest give ground logistics, then artillery, anti-air, construction, geological survey, xenoarchaeology, decontamination and surface-to-orbit units, each above 40% of the tonnage left after logistics, give their own roles, vehicles of the five sizes above 60% give ground attack, static units above 60% ground defence, and anything else is generic. The game works the role out when it needs it, to choose which bonus a formation\'s commander gains experience in, and saves none, so the rule is read from its source and not checked against a save.',
  assumptions: ['the game classes a formation by the rule of its source as written'],
})

registerRule({
  id: 'groundOrganisation.symbol',
  versions: ['3.2.x'],
  units: '',
  verification: 'estimated',
  structure: ['FCT_GroundUnitFormationTemplate.SymbolType', 'FCT_GroundUnitFormationElement.ClassID, Units', 'FCT_GroundUnitClass.BaseType, Size, HQCapacity, STOWeapon, ComponentA, ComponentB, ComponentC, ComponentD', 'DIM_GroundComponentType.LogisticsPoints, BombardmentWeapon, AAWeapon, Construction, Geosurvey, Xenoarchaeology, Decontamination, STO', 'FCT_GroundUnitFormation.ParentFormationID, PopulationID'],
  note: 'The symbol the game draws for a formation in its colony chart: the symbol type the original template sets, or when the template leaves it on Auto a type worked out from the tonnage of the elements, headquarters when half of it is units with headquarters capacity. A headquarters with formations of its colony below it takes the commonest symbol among them, leaving out headquarters and generic, the first of them in the game\'s own order by headquarters capacity, abbreviation and name winning a tie; that order is the game\'s culture-sensitive string comparison and not a plain one, and where it does not order two of them the symbol is left unknown. A formation aboard a ship is in no colony chart and keeps its own symbol. The game draws the symbol and saves none, so the rule is read from its source and not checked against a save.',
  assumptions: ['the game draws a formation by the rule of its source as written'],
})

registerRule({
  id: 'groundOrganisation.echelon',
  versions: ['3.2.x'],
  units: '',
  verification: 'estimated',
  structure: ['FCT_GroundUnitFormationTemplate.EchelonLevel', 'FCT_GroundUnitFormation.RequiredRank', 'FCT_Ranks.RankID, Priority, RankType'],
  note: 'The echelon the game draws for a formation: the one the original template sets, or when it is left on Auto the place of the formation\'s required rank among the race\'s ground ranks counted from the lowest, company, battalion, regiment, brigade, division, corps and army, army for every place above. The stored rank may be any rank of the race: the game takes its priority and the ground rank of that priority, so a naval rank draws the ground rank of the same priority and not none. A priority no ground rank of the race holds gives none. A formation with no stored required rank, or one the race does not hold, is left unknown, since the game then works the rank out from the size of the formation and the ranks of the commanders below it. The game draws the echelon and saves none, so the rule is read from its source and not checked against a save.',
  assumptions: ['the game draws a formation by the rule of its source as written'],
})

// ---- Template settings -------------------------------------------------------------------------------------------------

const enumSetting = (stored, labels) => (isNumber(stored) ? { value: stored, label: Number.isInteger(stored) && stored >= 0 && stored < labels.length ? labels[stored] : null, auto: stored === 0 } : null)

// The naming a template stores, as { themeId, theme: { id, name, listed } | null, random, mode, names }: `themeId` is the stored theme (null when not stored), `theme` the catalogue row the game uses for it (the stored theme, or the name-plus-number theme when the catalogue has no row of that id: `listed` is then false), `random` whether names are drawn at random (null when not stored), `mode` 'numbered' or 'themed' by the theme the game uses and `names` how many names that theme lists (null when the names are not read). `themes` is the catalogue by theme id, `counts` the names of each theme.
export const namingOf = (row, themes, counts) => {
  const themeId = isNumber(row.NameThemeID) ? row.NameThemeID : null
  const random = isNumber(row.RandomFormationNameFromTheme) ? row.RandomFormationNameFromTheme === 1 : null

  if (themeId === null || !themes) {
    return { themeId, theme: null, random, mode: themeId === null ? null : themeId <= NUMBERED_THEMES ? 'numbered' : 'themed', names: null }
  }

  const listed = themes.has(themeId)
  const id = listed ? themeId : FALLBACK_THEME
  const found = themes.get(id)

  return { themeId, theme: found ? { id, name: found.Description ?? null, listed } : null, random, mode: id <= NUMBERED_THEMES ? 'numbered' : 'themed', names: counts && counts.has(id) ? counts.get(id) : counts ? 0 : null }
}

// The settings of a template row as { naming, symbolType, echelon }: the symbol type and echelon each { value, label, auto } or null when the save does not store them (`label` is null for a value the game has no name for).
export const settingsOf = (row, themes, counts) => ({ naming: namingOf(row, themes, counts), symbolType: enumSetting(row.SymbolType, SYMBOL_TYPES), echelon: enumSetting(row.EchelonLevel, ECHELONS) })

// ---- The classes ---------------------------------------------------------------------------------------------------------

const TRAITS = Object.freeze({
  logistics: { column: 'LogisticsPoints', words: 'logistics points', found: (value) => value > 0 },
  artillery: { column: 'BombardmentWeapon', words: 'bombardment weapon level', found: (value) => value !== 0 },
  antiAir: { column: 'AAWeapon', words: 'anti-air weapon level', found: (value) => value !== 0 },
  construction: { column: 'Construction', words: 'construction rating', found: (value) => value > 0 },
  geo: { column: 'Geosurvey', words: 'geological survey rating', found: (value) => value > 0 },
  xeno: { column: 'Xenoarchaeology', words: 'xenoarchaeology rating', found: (value) => value > 0 },
  decontamination: { column: 'Decontamination', words: 'decontamination rating', found: (value) => value > 0 },
  sto: { column: 'STO', words: 'surface-to-orbit setting', found: (value) => value > 0 },
})

// What the game reads of a class's four component slots, as { base, hq, stoWeapon, flags: { logistics, artillery, antiAir, construction, geo, xeno, decontamination, sto }, gaps }: a flag is true when a component of a slot has the trait, false when every slot is known and none has, and null when a slot or a component rating is not stored and no known component has it. A slot recorded as 0 or less holds nothing (the game adds no component for an id it does not hold). `base`, `hq` and `stoWeapon` are the class's own values or null. `gaps` names what leaves a flag unknown, in words.
export const classTraits = (row, components) => {
  const flags = {}
  const gaps = {}

  Object.entries(TRAITS).forEach(([trait, { column, words, found }]) => {
    let proven = false
    let unknown = null

    SLOTS.forEach((slot) => {
      const id = row[slot]

      if (!isNumber(id)) {
        unknown = unknown || 'a component slot of a class of the formation'

        return
      }

      if (id <= 0) {
        return
      }

      const component = components.get(id)

      if (!component) {
        unknown = unknown || 'a component of a class of the formation, which the catalogue does not list'
      } else if (!isNumber(component[column])) {
        unknown = unknown || `the ${words} of a component of a class of the formation`
      } else if (found(component[column])) {
        proven = true
      }
    })

    flags[trait] = proven ? true : unknown ? null : false
    gaps[trait] = proven ? null : unknown
  })

  return { base: BASE_TYPES.includes(row.BaseType) ? row.BaseType : null, hq: isCount(row.HQCapacity) ? row.HQCapacity : null, stoWeapon: isNumber(row.STOWeapon) ? row.STOWeapon : null, flags, gaps }
}

// What each rule asks of a class.
const ROLE_NEEDS = Object.freeze(['logistics', 'artillery', 'antiAir', 'construction', 'geo', 'xeno', 'decontamination', 'sto'])
const SYMBOL_NEEDS = Object.freeze(['logistics', 'artillery', 'antiAir', 'construction', 'geo', 'xeno', 'decontamination', 'stoClass', 'hq'])

// The game's sizes are decimals, and a formation's tonnage is summed and compared against 40% and 60% of a total, so each part's tonnage is kept in millionths of a tonne as a whole number: the sums and the comparisons are then exact, as the game's decimal arithmetic is.
const SIZE_SCALE = 1e6

// The elements of a formation as parts the rules take, { parts, gaps }: each part { size (the class's size times the units, in millionths of a tonne), base, hq, logistics, artillery, antiAir, construction, geo, xeno, decontamination, sto, stoClass }, one for every element; `gaps` is what the save does not store that a rule needs, in words (then `parts` is not to be used). A formation with no element rows has no parts.
export const partsOf = (items, classes, figures, needs) => {
  const gaps = new Set()
  const parts = []

  if (!items.length) {
    gaps.add('the elements of the formation')
  }

  items.forEach((item) => {
    const known = classes.has(item.classId) ? figures.get(item.classId) : null

    if (!known) {
      gaps.add('a class of the formation, which the save does not list')

      return
    }

    const { traits } = known

    if (!isCount(item.units)) {
      gaps.add('the units of an element of the formation')
    }

    if (known.size === null) {
      gaps.add('the size of a class of the formation')
    }

    if (traits.base === null) {
      gaps.add('the unit type of a class of the formation')
    }

    const stoWeapon = traits.stoWeapon

    needs.forEach((need) => {
      if (need === 'hq') {
        if (traits.hq === null) {
          gaps.add('the headquarters capacity of a class of the formation')
        }
      } else if (need === 'stoClass') {
        if (traits.flags.sto !== true && !(isNumber(stoWeapon) && stoWeapon > 0)) {
          if (traits.flags.sto === null) {
            gaps.add(traits.gaps.sto)
          } else if (stoWeapon === null) {
            gaps.add('the surface-to-orbit weapon of a class of the formation')
          }
        }
      } else if (traits.flags[need] === null) {
        gaps.add(traits.gaps[need])
      }
    })

    parts.push({ size: known.size === null || !isCount(item.units) ? null : Math.round(known.size * item.units * SIZE_SCALE), base: traits.base, hq: traits.hq, ...traits.flags, stoClass: traits.flags.sto === true || (isNumber(stoWeapon) && stoWeapon > 0) })
  })

  return { parts, gaps: [...gaps] }
}

// ---- The rules -----------------------------------------------------------------------------------------------------------

const VEHICLE_BASES = Object.freeze([1, 2, 3, 4, 6])

// The tonnage sums both rules start from.
const tonnage = (parts, flag) => {
  const sums = { total: 0, logistics: 0, artillery: 0, antiAir: 0, construction: 0, geo: 0, xeno: 0, decontamination: 0, sto: 0, hq: 0, infantry: 0, statics: 0, vehicles: 0 }

  parts.forEach((part) => {
    sums.total += part.size

    if (part.base === STATIC) {
      sums.statics += part.size
    } else if (part.base === INFANTRY) {
      sums.infantry += part.size
    } else if (VEHICLE_BASES.includes(part.base)) {
      sums.vehicles += part.size
    }

    ;['logistics', 'artillery', 'antiAir', 'construction', 'geo', 'xeno', 'decontamination'].forEach((kind) => {
      if (part[kind] === true) {
        sums[kind] += part.size
      }
    })

    if (flag(part)) {
      sums.sto += part.size
    }

    if (part.hq > 0) {
      sums.hq += part.size
    }
  })

  return sums
}

// Whether `amount` is above the fraction `top / bottom` of `whole`, compared by cross-multiplying so that no rounding decides a tie.
const above = (amount, whole, top, bottom) => amount * bottom > whole * top

// The role id of a formation from its parts (`partsOf` with the role's needs): logistics first, then the kinds above two fifths of the rest in the game's order, then vehicles and static units above three fifths.
export const roleOf = (parts) => {
  const sums = tonnage(parts, (part) => part.sto === true)
  const rest = sums.total - sums.logistics

  if (sums.logistics > rest * 2) {
    return ROLE.logistics
  }

  const order = [['artillery', ROLE.artillery], ['antiAir', ROLE.antiAir], ['construction', ROLE.engineering], ['geo', ROLE.survey], ['xeno', ROLE.xenoarchaeology], ['decontamination', ROLE.decontamination], ['sto', ROLE.planetaryDefence]]

  for (const [kind, role] of order) {
    if (above(sums[kind], rest, 2, 5)) {
      return role
    }
  }

  return above(sums.vehicles, rest, 3, 5) ? ROLE.attack : above(sums.statics, rest, 3, 5) ? ROLE.defence : ROLE.generic
}

// The symbol id the elements give a formation whose template leaves it on Auto (`partsOf` with the symbol's needs): nothing is generic, headquarters units above half of the total headquarters, then the kinds in the game's order.
export const autoSymbolOf = (parts) => {
  const sums = tonnage(parts, (part) => part.stoClass === true)

  if (sums.total === 0) {
    return SYMBOL.generic
  }

  const rest = sums.total - sums.logistics

  if (above(sums.hq, sums.total, 1, 2)) {
    return SYMBOL.headquarters
  } else if (sums.logistics > rest * 2) {
    return SYMBOL.supply
  }

  const order = [['artillery', SYMBOL.artillery, 2, 5], ['antiAir', SYMBOL.airDefence, 2, 5], ['sto', SYMBOL.surfaceToOrbit, 2, 5], ['construction', SYMBOL.engineer, 2, 5], ['geo', SYMBOL.geosurvey, 2, 5], ['xeno', SYMBOL.xenoarchaeology, 2, 5], ['decontamination', SYMBOL.decontamination, 2, 5], ['statics', SYMBOL.staticDefence, 3, 5], ['vehicles', SYMBOL.armour, 3, 5], ['infantry', SYMBOL.infantry, 3, 5]]

  for (const [kind, symbol, top, bottom] of order) {
    if (above(sums[kind], rest, top, bottom)) {
      return symbol
    }
  }

  return sums.infantry > 0 && sums.vehicles > 0 ? SYMBOL.mechanisedInfantry : SYMBOL.generic
}

// The echelon id a required rank gives, as { id, place } or null when the rank is not a rank of the race: `ranks` are the race's ranks { RankID, Priority, RankType } and `rankId` the stored required rank. The stored rank may be any rank of the race, naval or ground: the game takes its priority and the race's ground rank of that priority (`GroundUnitFormation.GetRequiredCommanderRank`), then lists the ground ranks from the lowest (the highest priority number) and takes that rank's place: company, battalion, regiment, brigade, division, corps or army, army for any place above. A priority no ground rank of the race holds gives no echelon, as `GClass147.smethod_18` reads the null rank it then gets as none.
export const echelonOfRank = (ranks, rankId) => {
  const rank = ranks.find((one) => one.RankID === rankId)

  if (!rank || !isNumber(rank.Priority)) {
    return null
  }

  const ground = ranks.filter((one) => one.RankType === GROUND_RANK && isNumber(one.Priority)).sort((a, b) => b.Priority - a.Priority)
  const place = ground.findIndex((one) => one.Priority === rank.Priority)

  return { id: place < 0 ? ECHELON_NONE : CHART_ECHELONS[Math.min(place, CHART_ECHELONS.length - 1)], place }
}

// ---- The results ---------------------------------------------------------------------------------------------------------

const roleResult = (items, classes, figures) => {
  const { parts, gaps } = partsOf(items, classes, figures, ROLE_NEEDS)

  return gaps.length ? unavailable({ rule: 'groundOrganisation.role', missing: gaps }) : ofRule({ rule: 'groundOrganisation.role', value: { id: roleOf(parts), label: ROLES[roleOf(parts)] }, inputs: { present: ['the elements and classes of the formation'] } })
}

// The symbol a formation starts from, before its subordinates: { id, label, source: 'template' | 'elements' }. `template` is the original template as { state, settings }.
const ownSymbol = (items, classes, figures, template) => {
  const rule = 'groundOrganisation.symbol'

  if (template.state === 'unknown') {
    return unavailable({ rule, missing: ['the original template of the formation'] })
  }

  if (template.state === 'found' || template.state === 'foreign') {
    const set = template.settings && template.settings.symbolType

    if (!set) {
      return unavailable({ rule, missing: ['the symbol type of the original template'] })
    } else if (set.label === null) {
      return unavailable({ rule, missing: ['the symbol type of the original template, which is not a type the game knows'] })
    } else if (!set.auto) {
      return ofRule({ rule, value: { id: set.value, label: set.label, source: 'template' }, inputs: { present: ['the symbol type of the original template'] } })
    }
  }

  const { parts, gaps } = partsOf(items, classes, figures, SYMBOL_NEEDS)

  if (gaps.length) {
    return unavailable({ rule, missing: gaps })
  }

  const id = autoSymbolOf(parts)

  return ofRule({ rule, value: { id, label: SYMBOL_TYPES[id], source: 'elements' }, inputs: { present: ['the elements and classes of the formation'] } })
}

// The order the game sorts the formations below a headquarters by: `GClass147.smethod_8` orders them by headquarters capacity, then abbreviation, then name, with .NET's culture-sensitive string comparison, which is not JavaScript's `localeCompare`. On Windows that comparison drops the hyphen at its first level and only then puts the shorter of two texts first, so the game puts A2 before A-2 where `localeCompare` puts it after; the space, the full stop and the other punctuation a name holds weigh in below the digits and the letters. This reproduces it for the characters a formation abbreviation holds: a letter, a digit, the full stop and the hyphen, and the punctuation of `CHART_WEIGHTS`. The game reads the culture of the player's Windows, which this does not: the characters of that set order the same way in every culture probed for the rule, and any other character leaves the order unestablished rather than guessed.
const CHART_WEIGHTS = ' #&()./_~+0123456789abcdefghijklmnopqrstuvwxyz'

// Where one text falls in the game's comparison, as the levels it compares by: `weights` the primary order of every character but the hyphen, `cases` the case of each of those with a lowercase letter first, `flags` how many hyphens stand before each, and `trailing` those after the last. Null for a character outside the set, whose order is then not established.
const chartKey = (text) => {
  const key = { weights: [], cases: [], flags: [], trailing: 0 }
  let hyphens = 0

  for (const character of String(text)) {
    if (character === '-') {
      hyphens += 1

      continue
    }

    const lower = character.toLowerCase()
    const weight = CHART_WEIGHTS.indexOf(lower)

    if (lower.length !== 1 || weight < 0) {
      return null
    }

    key.weights.push(weight)
    key.cases.push(character === lower ? 0 : 1)
    key.flags.push(hyphens)
    hyphens = 0
  }

  key.trailing = hyphens

  return key
}

// The order of two lists of numbers, the shorter first when one is a prefix of the other.
const listOrder = (first, second) => {
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    if (first[index] !== second[index]) {
      return first[index] < second[index] ? -1 : 1
    }
  }

  return first.length === second.length ? 0 : first.length < second.length ? -1 : 1
}

// The order the game gives two texts, as -1, 0 or 1, or null when it is not established here because a character is outside the set.
const chartOrder = (first, second) => {
  const one = chartKey(first)
  const other = chartKey(second)

  return one && other ? listOrder(one.weights, other.weights) || listOrder(one.cases, other.cases) || listOrder(one.flags, other.flags) || listOrder([one.trailing], [other.trailing]) : null
}

// Where the game puts formation `first` against `second` in the chart: by headquarters capacity (the largest first), then by abbreviation, then by name, as -1, 0 or 1, or null where that order is not established here (a character outside the set, or two formations the game's comparison leaves equal, whose order is then the save's).
const chartPlace = (first, second) => {
  const capacity = (second.hq ?? 0) - (first.hq ?? 0)

  if (capacity) {
    return capacity > 0 ? 1 : -1
  }

  for (const field of ['abbreviation', 'name']) {
    const order = chartOrder(first[field] || '', second[field] || '')

    if (order === null) {
      return null
    } else if (order) {
      return order
    }
  }

  return null
}

// The symbols a formation is drawn with, the formations in `order` (parents before their children) each given as { id, items, template, colony (the stored colony id, 0 or null for a formation aboard a ship), children (ids), hq (the largest headquarters capacity of its classes, or null), abbreviation, name }: a formation whose own symbol is headquarters and which has children at its own colony takes the commonest symbol of theirs (their own drawn symbols, the formations below them settled first), leaving out headquarters and generic, and the first of the children in the game's own order by headquarters capacity (largest first), abbreviation and name wins a tie; where that order does not establish which of two tied symbols comes first, the symbol is unknown rather than chosen. A child whose symbol or headquarters capacity is unknown leaves the symbol unknown. Gives a Map of formation id to the result.
const drawnSymbols = (entries, classes, figures) => {
  const rule = 'groundOrganisation.symbol'
  const own = new Map(entries.map((entry) => [entry.id, ownSymbol(entry.items, classes, figures, entry.template)]))
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const drawn = new Map()

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    const mine = own.get(entry.id)

    if (mine.status === 'unavailable' || mine.value.id !== SYMBOL.headquarters || !(entry.colony > 0)) {
      drawn.set(entry.id, mine)

      continue
    }

    const below = entry.children.map((id) => byId.get(id)).filter((child) => child && child.colony === entry.colony)

    if (!below.length) {
      drawn.set(entry.id, mine)

      continue
    }

    const results = new Map(below.map((child) => [child.id, drawn.get(child.id)]))

    if (below.some((child) => results.get(child.id).status === 'unavailable')) {
      drawn.set(entry.id, unavailable({ rule, missing: ['the symbol of a formation below the headquarters'] }))

      continue
    }

    const idOf = (child) => results.get(child.id).value.id

    // The game counts every child's symbol, then takes the first child of a commonest symbol in its capacity, abbreviation and name order. An unresolved comparison preserves the input order only for sorting; it cannot establish the winning symbol.
    const sorted = [...below].sort((a, b) => chartPlace(a, b) ?? 0)
    const tally = new Map()

    sorted.forEach((child) => {
      if (idOf(child) !== SYMBOL.headquarters && idOf(child) !== SYMBOL.generic) {
        tally.set(idOf(child), (tally.get(idOf(child)) || 0) + 1)
      }
    })

    if (!tally.size) {
      drawn.set(entry.id, mine)

      continue
    }

    const best = Math.max(...tally.values())
    const tied = new Set([...tally.entries()].filter(([, count]) => count === best).map(([id]) => id))
    const candidates = sorted.filter((child) => tied.has(idOf(child)))

    if (tied.size > 1 && below.some((child) => child.hq === null)) {
      drawn.set(entry.id, unavailable({ rule, missing: ['the headquarters capacity of a class of a formation below the headquarters'] }))

      continue
    }

    // Keep every child that could be first: only a known earlier child can rule one out, never an id or one representative of its symbol. In a symbol tie the order between any two possible-first children must be established; unknown comparisons among known-later children do not matter.
    const first = candidates.filter((child) => !candidates.some((other) => chartPlace(other, child) === -1))

    if (tied.size > 1 && first.length > 1) {
      drawn.set(entry.id, unavailable({ rule, missing: ['the order the game gives two formations below the headquarters, which its chart breaks a tie by'] }))

      continue
    }

    const pick = idOf(first[0])

    drawn.set(entry.id, ofRule({ rule, value: { id: pick, label: SYMBOL_TYPES[pick], source: 'subordinates' }, inputs: { present: ['the symbols of the formations below'] } }))
  }

  return drawn
}

// The echelon of a formation as a result: { id, label, source: 'template' | 'rank' }. `read` says the ranks were read.
const echelonResult = ({ template, requiredRank, ranks, ranksRead }) => {
  const rule = 'groundOrganisation.echelon'

  if (template.state === 'unknown') {
    return unavailable({ rule, missing: ['the original template of the formation'] })
  }

  if (template.state === 'found' || template.state === 'foreign') {
    const set = template.settings && template.settings.echelon

    if (!set) {
      return unavailable({ rule, missing: ['the echelon of the original template'] })
    } else if (set.label === null) {
      return unavailable({ rule, missing: ['the echelon of the original template, which is not an echelon the game knows'] })
    } else if (!set.auto) {
      return ofRule({ rule, value: { id: set.value, label: set.label, source: 'template' }, inputs: { present: ['the echelon of the original template'] } })
    }
  }

  if (!ranksRead) {
    return unavailable({ rule, missing: ['the ranks of the race'] })
  } else if (!isNumber(requiredRank)) {
    return unavailable({ rule, missing: ['the required rank of the formation'] })
  }

  const found = requiredRank > 0 ? echelonOfRank(ranks, requiredRank) : null

  if (!found) {
    return unavailable({ rule, missing: ['the required rank of the formation, which the game works out from the size of the formation and the ranks below it when none is set'] })
  }

  return ofRule({ rule, value: { id: found.id, label: ECHELONS[found.id], source: 'rank', place: found.place < 0 ? null : found.place + 1 }, inputs: { present: ['the required rank of the formation', 'the ranks of the race'] } })
}

// The stored symbol text of a formation: the trimmed text, null for an empty column. The game neither reads nor writes it.
const storedSymbolOf = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

const settingsGaps = (gaps) => gaps.map(fieldWords)

// Sets `node.organisation` on every node of `order` (parents before their children): { role, symbol, echelon, template: { state, settings }, storedSymbol }, the first three results of their rules. `rowOf(id)` is the stored formation row (its required rank, colony and symbol text), `classes` and `figures` are the model's, `ranks` the race's ranks `{ RankID, Priority, RankType }` and `ranksRead` whether they were read. `gaps` names, as 'Table.Column' fields, the columns the rules start from that the save lacks: every result is then unavailable and says so.
export const organise = ({ order, rowOf, classes, figures, ranks, ranksRead, gaps }) => {
  if (gaps.length) {
    const missing = settingsGaps(gaps)

    order.forEach((node) => {
      node.organisation = { role: unavailable({ rule: 'groundOrganisation.role', missing }), symbol: unavailable({ rule: 'groundOrganisation.symbol', missing }), echelon: unavailable({ rule: 'groundOrganisation.echelon', missing }), template: { state: node.templates.original.state, settings: null }, storedSymbol: null }
    })

    return
  }

  const entries = order.map((node) => {
    const row = rowOf(node.id)
    const hqs = node.elements.map((item) => (classes.has(item.classId) && figures.get(item.classId).traits.hq !== null ? figures.get(item.classId).traits.hq : null))

    return { id: node.id, items: node.elements, template: { state: node.templates.original.state, settings: node.templates.original.settings || null }, colony: isNumber(row.PopulationID) ? row.PopulationID : null, children: node.children, hq: node.elements.length && !hqs.includes(null) ? Math.max(...hqs) : node.elements.length ? null : 0, abbreviation: node.abbreviation, name: node.name }
  })
  const drawn = drawnSymbols(entries, classes, figures)

  order.forEach((node) => {
    const row = rowOf(node.id)
    const template = { state: node.templates.original.state, settings: node.templates.original.settings || null }

    node.organisation = { role: roleResult(node.elements, classes, figures), symbol: drawn.get(node.id), echelon: echelonResult({ template, requiredRank: row.RequiredRank, ranks, ranksRead }), template, storedSymbol: storedSymbolOf(row.FormationSymbol) }
  })
}

// ---- The words -----------------------------------------------------------------------------------------------------------

const SOURCES = Object.freeze({ template: 'set by the original template', elements: 'worked out from the elements', subordinates: 'taken from the formations below it', rank: 'from the required rank' })

const lacking = (result) => `unknown, missing ${result.inputs.missing.join('; ')}`

const symbolText = (result) => (result.status === 'unavailable' ? `Symbol: ${lacking(result)}` : `Symbol: ${result.value.label}, ${SOURCES[result.value.source]}`)

const echelonText = (result) => {
  if (result.status === 'unavailable') {
    return `Echelon: ${lacking(result)}`
  }

  return result.value.id === ECHELON_NONE && result.value.source === 'rank' ? 'Echelon: None, no ground rank has the priority of the required rank' : `Echelon: ${result.value.label}, ${SOURCES[result.value.source]}`
}

// How a template's naming reads: the theme and how its names are chosen.
export const namingText = (template) => {
  if (template.state === 'none') {
    return 'Naming: no original template, so none'
  } else if (template.state === 'missing') {
    return 'Naming: the original template is not in the save'
  } else if (template.state === 'unknown') {
    return 'Naming: unknown, the original template is not stored'
  } else if (!template.settings) {
    return 'Naming: unknown, the settings of the original template are not stored'
  }

  const { naming } = template.settings

  if (naming.themeId === null) {
    return 'Naming: unknown, the naming theme of the original template is not stored'
  } else if (!naming.theme) {
    return naming.mode === 'numbered' ? 'Naming: numbered after the template name, the theme names are not read' : 'Naming: from a naming theme the save does not list'
  }

  const how = naming.mode === 'numbered' ? 'numbered after the template name' : naming.random === null ? 'names from the theme, whether random is not stored' : naming.random ? `random names from the theme${naming.names === null ? '' : ` of ${naming.names} names`}` : `names in the order of the theme${naming.names === null ? '' : ` of ${naming.names} names`}`

  return `Naming: ${naming.theme.name ?? 'unnamed theme'}${naming.theme.listed ? '' : ' (the stored theme is not in the catalogue)'}, ${how}`
}

// The lines the page shows for a formation's organisation, as [{ key, text }]: the role, the symbol, the echelon, the naming of the original template and, when the save holds one, the stored symbol text.
export const organisationLines = (organisation) => {
  const role = organisation.role
  const lines = [
    { key: 'role', text: role.status === 'unavailable' ? `Role: ${lacking(role)}` : `Role: ${role.value.label}, by the tonnage of its elements` },
    { key: 'symbol', text: symbolText(organisation.symbol) },
    { key: 'echelon', text: echelonText(organisation.echelon) },
    { key: 'naming', text: namingText(organisation.template) },
  ]

  if (organisation.storedSymbol !== null) {
    lines.push({ key: 'stored', text: `Symbol text stored with the formation: ${organisation.storedSymbol}, which the game does not read` })
  }

  return lines
}
