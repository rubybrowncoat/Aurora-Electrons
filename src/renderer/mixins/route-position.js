import { mapGetters } from 'vuex'

import { joinLabels, tracked } from '../utilities/load-tracking'
import { loadPositionFacts } from '../utilities/route-position'

// The optional read behind the position caveats of a page that states a route (Route Finder, Transport, Hauling): the game clock and the saved state of the race's fleets, which date the positions the route rests on. The tracked key, the async-computed name and the label key are one string. A page spreads `POSITION_LABELS` into its own labels and leaves `POSITION_INPUTS` out of the reads it waits on, as the Mineral Outlook does for its sites panel: while the read is in flight or failed the page renders at once and every position that depends on a clock is held at its saved place with its age unknown, which the caveat says.
export const POSITION_LABELS = {
  positionFacts: 'the age of the saved positions',
}

export const POSITION_INPUTS = Object.keys(POSITION_LABELS)

export default {
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    // The read's own state: { loading, failed, error }.
    positionState() {
      const state = this.loadErrors.positionFacts

      return { loading: state === undefined, failed: typeof state === 'string' ? joinLabels([POSITION_LABELS.positionFacts]) : '', error: typeof state === 'string' ? state : '' }
    },

    // What the positions take: the facts read, or null until the read has succeeded (an age not read is unknown, never 0).
    positionRead() {
      return this.loadErrors.positionFacts === null ? this.positionFacts : null
    },
  },
  methods: {
    retryPosition() {
      this.$asyncComputed.positionFacts.update()
    },
  },
  asyncComputed: {
    // The game clock and the race's fleets as the save has them, for the save, game and race shown. A race switch reads again.
    positionFacts: {
      get: tracked('positionFacts', async function () {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID) {
          return null
        }

        return loadPositionFacts(database, { GameID, RaceID })
      }),
      default: null,
    },
  },
}
