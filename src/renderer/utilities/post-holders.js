// Who holds a post, for the hierarchies that list posts (the ground formations, the naval admin commands and the ships): the serving commanders of a race whose `CommandType` is the kind of post and whose `CommandID` is the post. The serving test is the roster's (`SERVING_COMMANDER` of utilities/commanders.js), so a retired, dead or captured commander never holds a post. A commander whose retirement or prisoner flag is not stored may or may not serve: they are read apart as `unsettled` and never decide a vacancy.
//
// A post is in one state:
// - `held`: one or more serving commanders. More than one is `shared`, which the game never makes and the save can still hold.
// - `vacant`: no serving commander and none whose status is not stored.
// - `unknown`: no serving commander, and at least one whose status is not stored.
// - `unread`: the commanders were not read (the save lacks what they need), so nothing is said of the post.
// - `none`: the thing is not a post (a fleet).

import { SERVING_COMMANDER } from './commanders'

// The columns the holders are read from; a save that lacks one leaves every post unread.
export const HOLDER_COLUMNS = { FCT_Commander: ['CommanderID', 'Name', 'CommandType', 'CommandID', 'RetireStatus', 'Prisoner', 'GameID', 'RaceID'] }

// The commanders of the race, in the game, holding a post of one of `commandTypes` (FCT_Commander.CommandType) who serve or whose status is not stored: `Serving` is 1 for the first and null for the second. A retired, dead or captured commander is not read.
export const holderSql = ({ GameID, RaceID }, commandTypes) => {
  if (!Number.isInteger(GameID) || !Number.isInteger(RaceID) || !commandTypes.every(Number.isInteger)) {
    throw new TypeError('The post holders are read for a game, a race and post types given as whole numbers')
  }

  return `select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommandType, FCT_Commander.CommandID, ${SERVING_COMMANDER} as Serving from FCT_Commander where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType in (${commandTypes.join(', ')}) and (${SERVING_COMMANDER}) is not 0 order by FCT_Commander.CommanderID`
}

// The holders of the posts of one type, by post id, from the rows of `holderSql`: { [CommandID]: { holders: [{ id, name }], unsettled: [{ id, name }] } }, each list by commander id. Null when the rows were not read (undefined or null), which `postOf` turns into `unread`.
export const holderIndex = (rows, commandType) => {
  if (rows === undefined || rows === null) {
    return null
  }

  const index = new Map()

  rows.filter((row) => row.CommandType === commandType).forEach((row) => {
    const entry = index.get(row.CommandID) || { holders: [], unsettled: [] }

    entry[row.Serving === 1 ? 'holders' : 'unsettled'].push({ id: row.CommanderID, name: row.Name ?? null })
    index.set(row.CommandID, entry)
  })

  index.forEach((entry) => {
    entry.holders.sort((a, b) => a.id - b.id)
    entry.unsettled.sort((a, b) => a.id - b.id)
  })

  return index
}

// The state of the post `id`: { state, holders, unsettled }. `index` is null for commanders that were not read.
export const postOf = (index, id) => {
  if (index === null) {
    return { state: 'unread', holders: [], unsettled: [] }
  }

  const { holders, unsettled } = index.get(id) || { holders: [], unsettled: [] }

  return { state: holders.length > 1 ? 'shared' : holders.length ? 'held' : unsettled.length ? 'unknown' : 'vacant', holders, unsettled }
}

// A thing that is not a post.
export const notAPost = () => ({ state: 'none', holders: [], unsettled: [] })

// The problems a post's state gives, { kind, message }: several serving holders, and holders whose status is not stored.
export const postProblems = (post) => [
  ...(post.state === 'shared' ? [{ kind: 'post-shared', message: `The post has ${post.holders.length} serving commanders: ${post.holders.map((holder) => holder.id).join(', ')}` }] : []),
  ...(post.unsettled.length ? [{ kind: 'post-unsettled', message: `${post.unsettled.length === 1 ? 'Commander' : 'Commanders'} ${post.unsettled.map((holder) => holder.id).join(', ')} hold${post.unsettled.length === 1 ? 's' : ''} the post with no stored retirement or prisoner flag, so whether the post is vacant is not known` }] : []),
]

// The serving holders in the index whose post is not among `ids` (a Set of post ids): commanders who hold a post this model does not list.
export const strayHolders = (index, ids) => (index === null ? 0 : Array.from(index.entries()).filter(([id, entry]) => entry.holders.length && !ids.has(id)).reduce((sum, [, entry]) => sum + entry.holders.length, 0))

// The posts of a model counted by state: { held, vacant, shared, unknown, unread }, over the nodes that are posts.
export const postCounts = (nodes) => {
  const counts = { held: 0, vacant: 0, shared: 0, unknown: 0, unread: 0 }

  nodes.forEach((node) => {
    if (node.post.state !== 'none') {
      counts[node.post.state]++
    }
  })

  return counts
}
