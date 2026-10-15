// What Settings resets: the views the pages remember, in the settings store. A campaign's empire keeps its values under `campaign.<campaign id>.race.<RaceID>` (see utilities/campaign.js); the `game` subtree is a history of the app before campaigns, kept as the original of the migration, and no reset reads or changes it.

// What an empire's pages keep that isn't a view: the Warnings mutes and what each check listed at the last visit, the Game Log's last event seen, the Galaxy Map's pinned systems and clusters, and the colonies the History page follows. A reset keeps them too.
export const KEPT_EMPIRE_KEYS = ['warningsMuted', 'warningsLastLook', 'logLastSeen', 'mapPinned', 'mapGroups', 'historyColonies']

// The top-level keys that are not app-wide views: the campaigns' and the pre-campaign records of empires.
const EMPIRE_ROOTS = ['campaign', 'game']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The app-wide keys a reset clears: every top-level key but the empires' and the settings in `appSettings` (the Display settings).
export const appViews = (store, appSettings) => Object.keys(store).filter((key) => !EMPIRE_ROOTS.includes(key) && !appSettings.includes(key))

// The keys a reset clears for each empire of each campaign with any stored: [{ campaignId, RaceID, keys }], ids as stored (strings).
export const empireViews = (store) => Object.entries(isObject(store.campaign) ? store.campaign : {}).flatMap(([campaignId, campaign]) => Object.entries(isObject(campaign) && isObject(campaign.race) ? campaign.race : {}).map(([RaceID, values]) => ({ campaignId, RaceID, keys: isObject(values) ? Object.keys(values).filter((key) => !KEPT_EMPIRE_KEYS.includes(key)) : [] }))).filter(({ keys }) => keys.length)

// The settings with the views cleared: one empire's (`only`, { campaignId, RaceID }), or every empire's and the app-wide ones. An empire is cleared only when `only` names a campaign.
export const withoutViews = (store, appSettings, only) => {
  const next = JSON.parse(JSON.stringify(store))

  if (!only) {
    appViews(next, appSettings).forEach((key) => delete next[key])
  }

  empireViews(next).filter(({ campaignId, RaceID }) => !only || (campaignId === only.campaignId && RaceID === String(only.RaceID))).forEach(({ campaignId, RaceID, keys }) => {
    const races = next.campaign[campaignId].race

    keys.forEach((key) => delete races[RaceID][key])

    if (!Object.keys(races[RaceID]).length) {
      delete races[RaceID]
    }
  })

  return next
}
