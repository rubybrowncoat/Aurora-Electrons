// Commander maths for the Commanders page: assignments, bonuses and better candidates.
// Sources and checks: docs/plans/aurcalcs/build-3.md § Commanders.

export const COMMANDER_TYPES = [
  { id: 0, label: 'Naval', plural: 'Naval officers', flag: 'Naval' },
  { id: 1, label: 'Ground', plural: 'Ground officers', flag: 'Ground' },
  { id: 2, label: 'Administrator', plural: 'Administrators', flag: 'Civilian' },
  { id: 3, label: 'Scientist', plural: 'Scientists', flag: 'Scientist' },
]

// FCT_Commander.CommandType. The ship posts (8–15) were matched on the sample: every officer in
// a post has its required bonus and serves on a ship with its command module (docs
// `crew-and-commanders`).
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

// Bonuses stored as ratings, not multipliers.
const RATINGS = new Set([25, 27])

export const COLONY_ADMINISTRATION = 25
export const RESEARCH_ADMINISTRATION = 27
export const RESEARCH = 3
export const SURVEY = 2
export const MINING = 6
export const TERRAFORMING = 9

const EPSILON = 1e-9

// "6:1.15,25:6" -> { 6: 1.15, 25: 6 }
export const parseBonuses = (text) => Object.fromEntries((text || '').split(',').filter(Boolean).map((pair) => {
  const [id, value] = pair.split(':')

  return [Number(id), Number(value)]
}))

export const formatBonus = (bonusId, value) => (RATINGS.has(bonusId) ? `${Math.round(value)}` : `${value >= 1 ? '+' : '−'}${Math.round(Math.abs(value - 1) * 100)}%`)

// Lexicographic comparison of bonus tuples; positive when `a` ranks above `b`.
const compareKeys = (a, b) => {
  for (let index = 0; index < a.length; index++) {
    if (Math.abs(a[index] - b[index]) > EPSILON) {
      return a[index] - b[index]
    }
  }

  return 0
}

// Governors (docs `crew-and-commanders`, automated assignment): a candidate must have the colony's
// required bonus and ranks by it, then the secondary, then the tertiary bonus. For each colony with a
// required bonus: the best unassigned administrator, when they beat the governor (or there is none).
// A candidate can be the best for several colonies; `alsoBestFor` counts the others.
export const governorSuggestions = (colonies, administrators) => {
  const idle = administrators.filter((admin) => admin.CommandType === 0)
  const byId = Object.fromEntries(administrators.map((admin) => [admin.CommanderID, admin]))
  const keyOf = (admin, colony) => [colony.BonusOne, colony.BonusTwo, colony.BonusThree].map((bonusId) => (bonusId > 0 && admin && admin.bonuses[bonusId] !== undefined ? admin.bonuses[bonusId] : 1))
  const suggestions = colonies.filter((colony) => colony.BonusOne > 0).map((colony) => {
    const governor = colony.GovernorID ? byId[colony.GovernorID] : null
    const current = keyOf(governor, colony)
    const best = idle.filter((admin) => admin.bonuses[colony.BonusOne] !== undefined).map((admin) => ({ admin, key: keyOf(admin, colony) })).sort((a, b) => compareKeys(b.key, a.key))[0]

    if (!best || (governor && compareKeys(best.key, current) <= 0)) {
      return null
    }

    return { colony, governor, current, candidate: best.admin, candidateKey: best.key }
  }).filter(Boolean)

  return suggestions.map((suggestion) => ({ ...suggestion, alsoBestFor: suggestions.filter((other) => other !== suggestion && other.candidate === suggestion.candidate).length }))
}

// The officer post and bonus that matter on a specialist ship. Terraformers and miners use their
// captain's full bonus. Survey ships use their science officer's full Survey bonus when the class
// has a Science Department, else half their captain's. Secondary officers rank one below the captain.
export const specialistPost = (ship) => {
  if (ship.Terraformers > 0) {
    return { post: 'captain', bonusId: TERRAFORMING, label: 'Terraforming', level: ship.RankRequired, share: 1 }
  } else if (ship.MiningModules > 0 || ship.Harvesters > 0) {
    return { post: 'captain', bonusId: MINING, label: ship.Harvesters > 0 && !(ship.MiningModules > 0) ? 'Mining (harvesting)' : 'Mining', level: ship.RankRequired, share: 1 }
  } else if (ship.SciencePosts > 0) {
    return { post: 'science', bonusId: SURVEY, label: 'Survey', level: Math.max(1, ship.RankRequired - 1), share: 1 }
  }

  return { post: 'captain', bonusId: SURVEY, label: 'Survey (half for a captain)', level: ship.RankRequired, share: 0.5 }
}

// Specialist ships where an unassigned naval officer of the post's rank has a better bonus than the
// officer in it (or the post is empty). `officers`: naval officers with `bonuses` and `RankLevel`.
export const shipSuggestions = (ships, officers) => {
  const idle = officers.filter((officer) => officer.CommandType === 0)
  const byId = Object.fromEntries(officers.map((officer) => [officer.CommanderID, officer]))

  return ships.map((ship) => {
    const post = specialistPost(ship)
    const holder = byId[post.post === 'science' ? ship.ScienceOfficerID : ship.CaptainID] || null
    const current = holder ? holder.bonuses[post.bonusId] || 1 : null
    const better = idle.filter((officer) => (officer.bonuses[post.bonusId] || 1) > (current ?? 1) + EPSILON)
    const best = better.filter((officer) => officer.RankLevel === post.level).sort((a, b) => b.bonuses[post.bonusId] - a.bonuses[post.bonusId])[0]

    if (!best && holder) {
      return null
    }

    return { ship, post, holder, current, candidate: best || null, otherRanks: better.filter((officer) => officer.RankLevel !== post.level).length }
  }).filter((suggestion) => suggestion && (suggestion.candidate || !suggestion.holder))
}

// A scientist's research multiplier: in their own field the bonus counts four times (1.15 -> 1.60),
// outside it once (index.vue's rule; the docs: changing field cuts the bonus by 75%).
export const researchMultiplier = (bonus, inField) => (inField ? 4 * (bonus || 1) - 3 : bonus || 1)

// Research projects where an unassigned scientist of the project's field, able to run its labs
// (Research Administration >= labs), would research faster than the scientist on it.
export const researchSuggestions = (projects, scientists) => {
  const idle = scientists.filter((scientist) => scientist.CommandType === 0)
  const byId = Object.fromEntries(scientists.map((scientist) => [scientist.CommanderID, scientist]))

  return projects.map((project) => {
    const holder = project.ScientistID ? byId[project.ScientistID] : null
    const current = holder ? researchMultiplier(holder.bonuses[RESEARCH], holder.ResSpecID === project.ResSpecID) : 1
    const best = idle.filter((scientist) => scientist.ResSpecID === project.ResSpecID && (scientist.bonuses[RESEARCH_ADMINISTRATION] || 0) >= project.Facilities).map((scientist) => ({ scientist, multiplier: researchMultiplier(scientist.bonuses[RESEARCH], true) })).sort((a, b) => b.multiplier - a.multiplier)[0]

    if (!best || best.multiplier <= current + EPSILON) {
      return null
    }

    return { project, holder, current, candidate: best.scientist, candidateMultiplier: best.multiplier }
  }).filter(Boolean)
}
