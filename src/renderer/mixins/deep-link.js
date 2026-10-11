import { userActed } from '../plugins/navigation'
import { cleanQuery, sameQuery } from '../utilities/deep-links'

// Keeps a page's focus, the one thing it is open on, and its route's query (utilities/deep-links.js) in step.
//
// The page provides:
// - `applyLink(query)`, a method that sets the focus to what the query names; a key the query leaves out means no focus there, or the page's default. It runs when the page opens with a query, after the page's own `created`, so a link wins over anything the page restores; and again when Back, Forward or a link changes the query while the page stays open. A page opened without a query keeps whatever focus it restores itself.
// - `linkQuery`, a computed: the focus as a query, `{}` for none, or null while the page can't tell yet. When it differs from the route's, the route follows it. A focus the user moved is a new history entry, so Back returns to the focus before it; while the page settles on what it opened on or what the route asked for (no key or pointer press since the route changed, or a focus it couldn't tell before), the current entry is updated instead.
// - `linkLabel`, an optional computed naming the focus, such as a system's name, for the history menus and trail.
//
// While the router leaves the page, the route already belongs to the next one; the page then neither applies that route's query nor follows its own focus onto it.
export default {
  computed: {
    linkStep () {
      return { path: this.$route.fullPath, label: this.linkLabel || null }
    },
  },
  watch: {
    '$route.query' (query) {
      if (this.onLinkPath() && (this.linkQuery === null || !sameQuery(query, this.linkQuery))) {
        this.applyLink(query)
      }
    },
    linkQuery (query, previous) {
      this.followFocus(query, previous !== null && userActed())
    },
    linkStep: {
      immediate: true,
      handler (step) {
        if (this.onLinkPath()) {
          this.$store.commit('navigation/label', step)
        }
      },
    },
  },
  beforeCreate () {
    this.linkPath = this.$route.path
  },
  beforeMount () {
    if (Object.keys(this.$route.query).length) {
      this.applyLink(this.$route.query)
    }

    this.followFocus(this.linkQuery, false)
  },
  methods: {
    onLinkPath () {
      return this.$route.path === this.linkPath
    },
    followFocus (query, step) {
      if (query && this.onLinkPath() && !sameQuery(query, this.$route.query)) {
        const location = { path: this.linkPath, query: cleanQuery(query) }

        if (step) {
          this.$router.push(location)
        } else {
          this.$router.replace(location)
        }
      }
    },
  },
}
