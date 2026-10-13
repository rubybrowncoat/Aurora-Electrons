// What a page's reads take from the capability check of the copy now open (store/capabilities.js, utilities/capabilities.js): the commander bonus IDs whose lookup row the save does not confirm, and whether the naval admin commanders' ranks are in the save.
// `blockedBonuses` is every ID while no result is known. `capabilityGates(route)` reads the result before its first await, so an async read that calls it before any await of its own reads again when the check answers; it waits for the check when it has not answered, then gives `{ blocked, ranks }` for `loadNavalAdmins` and the mining rows (`gateMiningRows`); a check that failed reads like one that has not confirmed the lookup rows and like a save that has every rank.
export default {
  computed: {
    blockedBonuses () {
      return this.$store.getters['capabilities/blockedBonuses']
    },
  },
  methods: {
    async capabilityGates (route) {
      const known = this.$store.getters['capabilities/result']

      if (!known) {
        await this.$store.dispatch('capabilities/preflight')
      }

      const report = this.$store.getters['capabilities/report'](route)

      return { blocked: this.$store.getters['capabilities/blockedBonuses'], ranks: report ? report.groups.navalRank !== false : true }
    },
  },
}
