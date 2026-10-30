<template>
  <v-card class="panel route-groups" data-summary="Compare repeating routes grouped by saved orders, with the fleets assigned to each." elevation="1" data-route-groups>
    <div class="panel-head">
      <span>Route coverage<provenance-mark rule="hauling.routeGroup" label /></span>
      <span v-if="ready" class="d-flex align-center flex-wrap">
        <v-switch v-model="flaggedOnly" label="Only flagged routes" dense hide-details class="mt-0 mr-3" data-route-flagged />
        <v-chip small data-route-count>{{ audit.counts.groups }} {{ audit.counts.groups === 1 ? 'route' : 'routes' }}, {{ audit.counts.duplicates }} duplicated</v-chip>
      </span>
    </div>
    <div v-if="state.loading || state.failed" class="px-4 py-2" data-route-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="$emit('retry')" />
    </div>
    <div v-else-if="!audit.supported" class="px-4 py-3 caption text--secondary" data-route-unsupported>{{ unsupportedText }}</div>
    <template v-else>
      <v-data-table :headers="headers" :items="items" item-key="id" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="routeGroupsTable.sortBy" :sort-desc.sync="routeGroupsTable.sortDesc" :items-per-page.sync="routeGroupsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No fleet repeats a route." class="route-groups__table" data-route-table>
        <template #[`item.nameText`]="{ item }">
          <div class="py-1" :data-route-group="item.id">
            <div class="font-weight-medium" data-route-name>{{ item.name.name }}</div>
            <div class="caption text--secondary">
              <span data-route-source>{{ sourceText(item.name) }}</span><template v-if="item.name.source === 'template'">, <span data-route-match>{{ matchText(item.name) }}</span></template>
              <span v-if="item.name.others.length" data-route-others> · also a content match for <span v-for="(other, index) in item.name.others" :key="other" data-route-other>{{ index ? ', ' : '' }}{{ other }}</span></span>
            </div>
            <div class="caption text--secondary">{{ flowsText(item) }}</div>
          </div>
        </template>
        <template #[`item.fleetCount`]="{ item }">
          <span data-route-fleet-count>{{ item.fleetCount }}</span>
          <div class="caption text--secondary">{{ item.fleetNames }}</div>
        </template>
        <template #[`item.statusText`]="{ item }">
          <span class="text-no-wrap" :data-route-status="item.status">{{ item.statusText }}</span>
        </template>
        <template #[`item.capacitySort`]="{ item }">
          <div>
            <div v-if="item.capacity" class="text-no-wrap" data-route-capacity>
              <div v-if="item.capacity.minerals + item.capacity.installations > 0">{{ number(item.capacity.minerals + item.capacity.installations) }} t/yr<provenance-mark :result="item.freightResult" /></div>
              <div v-if="item.capacity.colonists > 0">{{ number(item.capacity.colonists) }} colonists/yr<provenance-mark :result="item.colonistsResult" /></div>
              <div v-if="item.capacity.minerals + item.capacity.installations + item.capacity.colonists === 0" class="text--secondary">none</div>
            </div>
            <span v-else class="text--secondary" data-route-capacity-unknown>—<provenance-mark :result="item.freightResult" /></span>
            <div v-if="item.leftOut" class="caption text--secondary" data-route-capacity-note>{{ capacityNotes.undetermined }}</div>
          </div>
        </template>
        <template #[`item.flags`]="{ item }">
          <v-chip v-for="flag in item.flags" :key="flag.key" x-small :color="flag.warning ? 'warning' : undefined" :text-color="flag.warning ? 'white' : undefined" :data-route-flag="flag.key">{{ flag.text }}</v-chip>
        </template>
        <template #expanded-item="{ headers: columns, item }">
          <td :colspan="columns.length" class="pa-3" :data-route-detail="item.id">
            <div class="route-groups__title">Fleets on this route</div>
            <div v-for="member in item.members" :key="member.record.FleetID" class="route-groups__fleet" :data-route-fleet="member.record.FleetID" :data-route-member-state="member.state">
              <div>
                <span class="font-weight-medium" data-route-fleet-name>{{ member.record.FleetName }}</span>
                <span class="text--secondary"> · <span data-route-member-text>{{ stateText(member) }}</span></span>
                <span v-if="member.record.waiting" class="text--secondary" data-route-activity> · {{ activityText(member.record) }}</span>
                <page-link v-if="fleetLink" :to="fleetLink(member.record.FleetID)" :name="member.record.FleetName" class="ml-1" />
              </div>
              <div v-if="member.reason" class="caption text--secondary" data-route-reason>{{ member.reason }}</div>
              <div class="caption text--secondary" data-route-conditional><span data-route-conditional-status>{{ conditionStatusText(member.record) }}</span><template v-if="member.record.conditional.rows.length">: <span data-route-conditional-names>{{ conditionNames(member.record) }}</span></template></div>
              <div v-if="member.record.standing > 0" class="caption text--secondary">{{ member.record.standing }} standing {{ member.record.standing === 1 ? 'order' : 'orders' }} apply while the fleet is idle; they do not change the route.</div>
              <div class="caption text--secondary" data-route-orders>Stored orders: <span v-for="(order, index) in member.record.orders" :key="order.MoveOrderID" :data-route-order="order.MoveOrderID">{{ index ? ', ' : '' }}#<span data-route-order-number>{{ order.MoveOrder }}</span> (order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span><span v-if="!member.record.orders.length">none</span></div>
            </div>
            <div v-if="item.variants.length > 1" class="caption mt-2" data-route-variants>Pacing: {{ item.variants.length }} sub-groups of fleets, told apart by the delay set on their orders.</div>
            <div v-if="item.related.length" class="mt-2" data-route-related>
              <div class="route-groups__title">Related routes</div>
              <div v-for="related in item.related" :key="related.id" class="caption" :data-route-relation="related.id"><span data-route-relation-label>{{ relationText(related.relation) }}</span>: <span data-route-relation-name>{{ related.name }}</span></div>
            </div>
            <div class="mt-2">
              <page-link v-if="item.finder" :to="item.finder" :name="item.name.name" />
            </div>
          </td>
        </template>
      </v-data-table>

      <div class="px-4 pt-3 pb-1" data-route-closed>
        <div class="route-groups__title">Queues that do not repeat ({{ audit.closed.length }})</div>
        <div class="caption text--secondary">A queue that closes on itself but is set to run once, or a fixed number of times, moves cargo while it runs and then stops. It is listed here and never counted as service.</div>
        <div v-for="record in audit.closed" :key="record.FleetID" class="route-groups__fleet" :data-route-closed-fleet="record.FleetID">
          <span class="font-weight-medium" data-route-fleet-name>{{ record.FleetName }}</span>
          <span class="text--secondary"> · <span data-route-shape>{{ shapeText(record) }}</span> · {{ flowsOf(record) }}</span>
          <div class="caption text--secondary" data-route-orders>Stored orders: <span v-for="(order, index) in record.orders" :key="order.MoveOrderID" :data-route-order="order.MoveOrderID">{{ index ? ', ' : '' }}#<span data-route-order-number>{{ order.MoveOrder }}</span> (order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span></div>
        </div>
        <div v-if="!audit.closed.length" class="caption text--secondary" data-route-closed-none>No closed queue carries cargo.</div>
      </div>

      <div v-if="audit.broken.length" class="px-4 pt-3 pb-2" data-route-broken>
        <div class="route-groups__title">Fleets set to repeat that are not on a route ({{ audit.broken.length }})</div>
        <div v-for="record in audit.broken" :key="record.FleetID" class="route-groups__fleet" :data-route-broken-fleet="record.FleetID">
          <span class="font-weight-medium" data-route-fleet-name>{{ record.FleetName }}</span>
          <span class="text--secondary"> · <span data-route-shape>{{ shapeText(record) }}</span><template v-if="record.problem">: {{ problemText(record.problem) }}</template></span>
          <div v-if="record.orders.length" class="caption text--secondary" data-route-orders>Stored orders: <span v-for="(order, index) in record.orders" :key="order.MoveOrderID" :data-route-order="order.MoveOrderID">{{ index ? ', ' : '' }}#<span data-route-order-number>{{ order.MoveOrder }}</span> (order <span data-route-order-id>{{ order.MoveOrderID }}</span>)</span></div>
        </div>
      </div>
      <div class="panel-foot caption text--secondary">Routes are grouped only by their saved orders: the path, service and cargo limits of each order. Delay only sorts fleets within a route. A different conditional order creates a separate route. Each route's yearly capacity is counted once, regardless of how many fleets share it. Template names are matched by content because no table links a fleet to a template.</div>
    </template>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { roundToDecimal, separatedNumber } from '../../utilities/math'
import { ACTIVITY, CAPACITY_NOTES, CONDITION_STATUSES, GROUP_STATUSES, MATCHES, NAME_SOURCES, PROBLEMS, RELATIONS, SHAPES, STATES, capacityResult, flagsOf } from '../../utilities/route-signatures'

const PAGE_SIZES = [10, 25, -1]

// The routes the saved orders make, with the fleets on each (utilities/route-audit.js): `audit` is what the page's `routeAudit` gives, `state` the read's own `{ loading, failed, error }`, and the page's own words for places and links come in as functions.
export default {
  name: 'RouteGroups',
  components: { LoadState, PageLink, ProvenanceMark },
  mixins: [
    persistedView({
      flaggedOnly: { key: 'haulingRouteFlagged', default: false },
      routeGroupsTable: tableView('haulingRouteGroupsTable', { sortBy: ['capacitySort'], sortDesc: [true], itemsPerPage: 10, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  props: {
    audit: {
      type: Object,
      required: true,
    },
    state: {
      type: Object,
      required: true,
    },
    separator: {
      type: String,
      default: '',
    },
    // A group's Route Finder link, or null for none.
    finderLink: {
      type: Function,
      default: null,
    },
    fleetLink: {
      type: Function,
      default: null,
    },
  },
  data() {
    return {
      expanded: [],
      pageSizes: PAGE_SIZES,
      capacityNotes: CAPACITY_NOTES,
    }
  },
  computed: {
    ready() {
      return !this.state.loading && !this.state.failed && this.audit.supported
    },

    unsupportedText() {
      return this.audit.reason || 'Route signatures are not supported for this save.'
    },

    headers() {
      return [
        { text: 'Route', value: 'nameText' },
        { text: 'Fleets', value: 'fleetCount' },
        { text: 'State', value: 'statusText' },
        { text: 'Capacity a year', value: 'capacitySort' },
        { text: 'Flags', value: 'flags', sortable: false },
      ]
    },

    rows() {
      return this.audit.groups.map((group) => ({
        ...group,
        nameText: group.name.name,
        fleetCount: group.members.length,
        fleetNames: group.members.map((member) => member.record.FleetName).join(', '),
        statusText: GROUP_STATUSES[group.status],
        capacitySort: group.capacity ? group.capacity.minerals + group.capacity.installations + group.capacity.colonists / 1000 : -1,
        freightResult: capacityResult(group, 'freight'),
        leftOut: group.members.some((member) => member.undetermined),
        colonistsResult: capacityResult(group, 'colonists'),
        flags: flagsOf(group),
        finder: this.finderLink ? this.finderLink(group) : null,
      }))
    },

    items() {
      return this.flaggedOnly ? this.rows.filter((row) => row.flags.length > 0 || row.status !== 'capable') : this.rows
    },
  },
  methods: {
    number(value) {
      return separatedNumber(roundToDecimal(value, 0), this.separator)
    },

    sourceText(name) {
      return NAME_SOURCES[name.source]
    },

    stateText(member) {
      return STATES[member.state]
    },

    activityText(record) {
      return `${ACTIVITY[record.waiting]}${record.waiting === 'timer' && record.head ? ` (${this.number(record.head.remaining)} s left)` : ''}`
    },

    conditionStatusText(record) {
      return CONDITION_STATUSES[record.conditional.status]
    },

    conditionNames(record) {
      return record.conditional.rows.map((row) => row.name || `condition ${row.conditionId}`).join(', ')
    },

    relationText(relation) {
      return RELATIONS[relation]
    },

    matchText(name) {
      return name.exact ? MATCHES.exact : MATCHES.pacing
    },

    shapeText(record) {
      return SHAPES[record.shape]
    },

    problemText(problem) {
      return PROBLEMS[problem]
    },

    placeName(group, key) {
      return group.labels[key] || key
    },

    flowsText(group) {
      return group.flows.length ? group.flows.map((flow) => (flow.kind === 'reserve' ? `${this.placeName(group, flow.from)} reserve` : `${this.placeName(group, flow.from)} → ${this.placeName(group, flow.to)} (${flow.kind})`)).join('; ') : 'No cargo moved'
    },

    flowsOf(record) {
      return this.flowsText({ flows: record.flows, labels: record.labels })
    },
  },
}
</script>

<style lang="scss">
.route-groups {
  .route-groups__title {
    font-weight: 500;
    font-size: 0.875rem;
  }

  .route-groups__fleet {
    padding: 4px 0;
  }
}
</style>
