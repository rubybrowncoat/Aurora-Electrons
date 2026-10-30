import { mapGetters } from 'vuex'

import { joinLabels, tracked } from '../utilities/load-tracking'
import { loadOrbitFacts } from '../utilities/orbit-propagation'
import { loadPositionFacts } from '../utilities/route-position'

// The optional reads behind the position caveats of a page that states a route (Route Finder, Transport, Hauling): the game clock and the saved state of the race's fleets, which date the positions the route rests on, and the orbits of the bodies the route reaches, which move them on to the arrival time. The tracked key, the async-computed name and the label key are one string. A page spreads `POSITION_LABELS` into its own labels and leaves `POSITION_INPUTS` out of the reads it waits on, as the Mineral Outlook does for its sites panel: while a read is in flight or failed the page renders at once and every position that depends on it is held at its saved place with its age unknown (a body whose orbit is not read says so), which the caveat says. A page names the endpoints whose orbits matter in a computed `orbitEndpoints` (the places it reaches and the Lagrange points of their systems); the default is none.
export const POSITION_LABELS = {
  positionFacts: 'the age of the saved positions',
  orbitFacts: 'the orbits of the bodies on the route',
}

export const POSITION_INPUTS = Object.keys(POSITION_LABELS)

export default {
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    // The endpoints whose orbits are read (`loadOrbitFacts`): a page lists what its routes reach.
    orbitEndpoints() {
      return []
    },

    // The reads' own state: { loading, failed, error }.
    positionState() {
      const states = POSITION_INPUTS.map((key) => [key, this.loadErrors[key]])
      const failed = states.filter(([, state]) => typeof state === 'string')

      return { loading: states.some(([, state]) => state === undefined), failed: joinLabels(failed.map(([key]) => POSITION_LABELS[key])), error: failed.map(([, state]) => state).join('; ') }
    },

    // What the positions take: the facts read, with the orbits once they are read too, or null until the read of the facts has succeeded (an age not read is unknown, never 0; an orbit not read leaves the saved position).
    positionRead() {
      if (this.loadErrors.positionFacts !== null) {
        return null
      }

      return this.loadErrors.orbitFacts === null && this.orbitFacts ? { ...this.positionFacts, orbits: this.orbitFacts } : this.positionFacts
    },
  },
  methods: {
    retryPosition() {
      this.$asyncComputed.positionFacts.update()
      this.$asyncComputed.orbitFacts.update()
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

    // The orbits of the bodies of `orbitEndpoints`, only for the systems the race has surveyed.
    orbitFacts: {
      get: tracked('orbitFacts', async function () {
        const { database, GameID, RaceID, orbitEndpoints } = this

        if (!database || !GameID || !RaceID || !orbitEndpoints.length) {
          return null
        }

        return loadOrbitFacts(database, { GameID, RaceID }, orbitEndpoints)
      }),
      default: null,
    },
  },
}
