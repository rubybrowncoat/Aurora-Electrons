import { branchStore } from '../utilities/history'

// Empire History: `revision` is bumped each time snapshots are written, so pages re-read the history file; `failures` lists the games whose latest snapshots the recorder couldn't read or write, [{ GameID, stage: 'read' | 'write' | 'registry' }], GameID null when the whole save couldn't be read or the campaign registry couldn't be; `campaigns` is { [GameID]: { campaignId, branchId, relation, created, forked, pending, legacy, generation } } for the games of the open save, what the recorder settled each to (utilities/campaign.js). A resolution belongs to the copy of the save it was settled on (`generation`, the store's freshness generation): GameID repeats between saves, so once another copy is opened no game is settled to anything until that copy's own pass has settled it, and nothing keyed by the campaign (settings, history files) is read or written in between.
export const state = () => {
  return {
    revision: 0,
    failures: [],
    campaigns: {},
    // { [GameID]: generation }: the copy of the save (the store's freshness generation) a pass of the recorder last wrote the empire's snapshot of each game for. A failure of a later pass is in `failures`; a game without an entry for the copy now open has no confirmed recording of it yet.
    passes: {},
    captures: 0,
  }
}

export const getters = {
  // The selected game's settled campaign, `{ campaignId, branchId, ... }`, or null until the recorder has settled it on the copy of the save now open.
  campaign (state, _getters, rootState) {
    const settled = state.campaigns[rootState.GameID]

    return settled && settled.generation === rootState.freshness.generation ? settled : null
  },
  // (GameID, RaceID) => { count, latest } for a race's snapshots in the game's settled branch, `latest` being the last one's game time in seconds, or null while the history file can't be trusted or the game isn't settled yet. A getter's result lasts until `revision`, `failures`, `campaigns` or the generation changes, so each race's file is read once per revision, not once per look.
  snapshotSummary (state, _getters, rootState) {
    const { revision, failures, campaigns } = state
    const { generation } = rootState.freshness
    const summaries = {}

    return (GameID, RaceID) => {
      const key = `${revision}:${GameID}:${RaceID}`
      const campaign = campaigns[GameID]

      if (!campaign || campaign.generation !== generation) {
        return null
      }

      if (!(key in summaries)) {
        if (failures.some((failure) => failure.GameID === GameID && failure.stage === 'write')) {
          summaries[key] = null
        } else {
          const snapshots = branchStore(campaign.campaignId, campaign.branchId).get(`races.${RaceID}.snapshots`, [])

          summaries[key] = { count: snapshots.length, latest: snapshots.length ? snapshots[snapshots.length - 1].t : null }
        }
      }

      return summaries[key]
    }
  },
}

export const mutations = {
  // The window shows another save: what was settled and what failed belonged to the one it left, and the files the pages read are read again.
  reset (state) {
    state.revision++
    state.failures = []
    state.campaigns = {}
    state.passes = {}
  },
  recorded (state) {
    state.revision++
  },
  // The Colony series panel asks the recorder for one pass on the open save (a colony was just chosen, so its first observation is this save's).
  capture (state) {
    state.captures++
  },
  // A pass of the recorder ended on the copy of the save `generation`: `GameIDs` are the games whose empire snapshot it wrote.
  passed (state, { GameIDs, generation }) {
    state.passes = { ...state.passes, ...Object.fromEntries(GameIDs.map((GameID) => [GameID, generation])) }
  },
  failures (state, failures) {
    state.failures = failures
  },
  resolved (state, { GameID, resolution, generation }) {
    state.campaigns = { ...state.campaigns, [GameID]: { ...resolution, generation } }
  },
}
