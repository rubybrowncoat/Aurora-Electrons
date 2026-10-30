<template>
  <v-card class="panel notebook-digest" data-summary="Review economic changes in observed saves since the last acknowledged save." elevation="1">
    <div class="panel-head">
      <span>Economic changes since the last acknowledgment</span>
      <span class="caption text--secondary" data-digest-caption>{{ caption }}</span>
    </div>
    <div class="panel-body">
      <v-alert v-if="problem" type="warning" outlined dense :data-digest-error="problemKind">{{ problem }}</v-alert>
      <div v-else-if="!campaign" class="caption text--secondary" data-digest-waiting>The campaign of the open save is not settled yet, so no acknowledgment can be read or kept.</div>
      <template v-else>
        <div v-if="digest.state !== 'ready'" class="caption" :data-digest-state="digest.state">{{ digest.reason }}</div>

        <template v-if="digest.state === 'ready'">
          <div class="caption" data-digest-boundary>Compared with the save acknowledged at {{ date(digest.boundary.t) }}<provenance-mark :result="digest.coverage.result" /> and the open save at {{ date(digest.to.t) }}.</div>
          <div class="caption text--secondary" data-digest-coverage>{{ coverage }}</div>

          <div v-if="!digest.groups.length" class="caption mt-2" data-digest-none>{{ digest.items.length ? 'Every change is acknowledged.' : 'No change in the figures compared.' }}</div>
          <div v-for="group in digest.groups" :key="group.key" class="notebook-digest__group mt-3" :data-digest-group="group.key">
            <div class="font-weight-medium">{{ group.name }}<span class="caption text--secondary ml-2">{{ groupKind(group) }}</span><page-link v-if="group.type === 'colony' && !group.stale" class="ml-1" :to="linkTo.production(group.id)" :name="group.name" /></div>
            <div v-for="item in group.items" :key="item.key" class="notebook-digest__item" :data-digest-item="item.key" :data-digest-kind="item.kind">
              <v-chip x-small outlined class="mr-2">{{ kindName(item.kind) }}</v-chip><span data-digest-text>{{ text(item) }}</span><provenance-mark :result="item.result" />
              <v-btn x-small text class="ml-2" :disabled="busy" data-digest-acknowledge-item @click="acknowledgeItem(item)">Acknowledge</v-btn>
            </div>
          </div>

          <div v-if="digest.unknown.length" class="mt-3" data-digest-unknown>
            <div class="caption text--secondary">Not comparable, so no change can be stated:</div>
            <div v-for="entry in digest.unknown" :key="entry.key" class="caption" data-digest-unknown-item>{{ entry.label }}: {{ unknownText }}<provenance-mark :result="entry.result" /></div>
          </div>

          <div v-if="digest.hidden" class="caption text--secondary mt-3" data-digest-hidden>{{ hiddenText }}<v-btn x-small text class="ml-2" :disabled="busy" data-digest-show @click="showAcknowledged">Show them again</v-btn></div>
        </template>

        <div class="notebook__actions">
          <v-btn small depressed color="primary" :disabled="busy || !acknowledgeable" data-digest-acknowledge @click="acknowledge">{{ acknowledgeLabel }}</v-btn>
          <span v-if="!acknowledgeable && digest.state !== 'waiting'" class="caption text--secondary" data-digest-cannot>The open save has no recorded snapshot to take as the boundary.</span>
        </div>
        <v-alert v-if="message" :type="messageType" outlined dense class="mt-2" data-digest-message>{{ message }}</v-alert>

        <div class="caption text--secondary mt-3" data-digest-limits>The digest groups the changes by the object they are about: installations and ships of the race, stockpiles that ran out or are back, the treasury, followed colonies and project notes. Only the net change between two observed saves is shown, saves that were never observed are named as gaps, and acknowledged changes stay hidden. The digest says nothing of what happened between two observed saves: a build that finished and was spent, a stockpile that ran out and refilled, or a note edited and edited back leaves no trace. A bottleneck here is a sum over the colonies reaching none or recovering, so one colony may still run dry under a positive sum. The acknowledgment belongs to this race on this branch: another branch, another race or another campaign never reads it, a fork starts with none, and an open save from before the boundary or from another history is not compared. Acknowledging writes only the app's settings, never the save.</div>
      </template>
    </div>
  </v-card>
</template>

<script>
import PageLink from '../page/PageLink.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import { linkTo } from '../../utilities/deep-links'
import { DigestChanged, DigestLimit, DigestScopeChanged, DigestUnprotected, DigestUnreadable, RECORDING_PENDING, buildDigest, coverageText, digestStore, guarded, itemText, kindText, readRace, recordFrom, recordOf, recordingText, saveDigestSafely, withItem, withRecord, withoutItem } from '../../utilities/economy-digest'
import { entriesOf } from '../../utilities/colony-series'
import { statusText } from '../../utilities/economy-notes'
import { branchStore, colonyStore, durationText, thinningStatus } from '../../utilities/history'
import { raceKeyPrefix } from '../../utilities/campaign'
import { countText } from '../../utilities/math'

const GROUP_KINDS = { empire: 'summed over the race', colony: 'colony', body: 'body', fleet: 'fleet', tech: 'tech', design: 'designed tech' }

// The panel of the Notebook page that shows what changed in the race's economy since the last acknowledgment, on the branch of the open save. `campaign` is the settled { campaignId, branchId } of the open save, `notes` the entries of the notes of the race on the branch (null when they cannot be read), `names` the installation types' names and `recording` what the recorder has reported for the open save (utilities/economy-digest.js `recordingStateOf`): '' only when a pass of it wrote the snapshot of this copy of the save, otherwise the stage of its failure or 'pending' (the default), which leaves the snapshot found at the game time unconfirmed, so nothing is compared or acknowledged. The acknowledgment is read from and written to the digest's own store file under the campaign, the race and the branch (utilities/economy-digest.js).
export default {
  name: 'ChangeDigest',
  components: { PageLink, ProvenanceMark },
  props: {
    config: {
      type: Object,
      default: null,
    },
    campaign: {
      type: Object,
      default: null,
    },
    raceId: {
      type: [Number, String],
      default: null,
    },
    gameTime: {
      type: [Number, String],
      default: null,
    },
    notes: {
      type: Array,
      default: null,
    },
    names: {
      type: Object,
      default: () => ({}),
    },
    startYear: {
      type: [Number, String],
      default: null,
    },
    separator: {
      type: String,
      default: '\'',
    },
    historyRevision: {
      type: Number,
      default: 0,
    },
    recording: {
      type: String,
      default: RECORDING_PENDING,
    },
  },
  data() {
    return {
      linkTo,
      // Bumped by each write, so what was stored is read again.
      revision: 0,
      busy: false,
      message: '',
      messageType: 'info',
      // The name of the error of the last refused or failed write, '' when it succeeded.
      failureName: '',
    }
  },
  computed: {
    prefix() {
      return this.campaign && this.raceId !== null ? raceKeyPrefix(this.campaign.campaignId, this.raceId) : null
    },

    // What the digest's file holds of the race: { read, error }.
    stored() {
      // eslint-disable-next-line no-unused-expressions
      this.revision + this.historyRevision

      if (!this.campaign || this.raceId === null) {
        return { read: null, error: '' }
      }

      try {
        const read = readRace(digestStore(this.campaign.campaignId).get('races', undefined), this.raceId)

        return { read, error: read.ok ? '' : `The stored acknowledgments cannot be read (${read.reason}), so none is shown and nothing is written over them.` }
      } catch (error) {
        return { read: null, error: `The stored acknowledgments cannot be read: ${error.message}` }
      }
    },

    // The branch's recorded snapshots and colony series of the race: { snapshots, record, colonyRecord, error }.
    history() {
      // eslint-disable-next-line no-unused-expressions
      this.revision + this.historyRevision

      if (!this.campaign || this.raceId === null) {
        return { snapshots: [], record: null, colonyRecord: null, error: '' }
      }

      try {
        const record = branchStore(this.campaign.campaignId, this.campaign.branchId).get(`races.${this.raceId}`, null)
        const colonyRecord = colonyStore(this.campaign.campaignId, this.campaign.branchId).get(`races.${this.raceId}`, null)

        return { snapshots: record && Array.isArray(record.snapshots) ? record.snapshots : [], record, colonyRecord, error: '' }
      } catch (error) {
        return { snapshots: [], record: null, colonyRecord: null, error: `The history of this branch cannot be read: ${error.message}` }
      }
    },

    problem() {
      return this.stored.error || this.history.error || this.recordingProblem
    },

    // The colonies the History page follows, as { id, name, bodyId }.
    colonies() {
      // eslint-disable-next-line no-unused-expressions
      this.revision + this.historyRevision

      if (!this.prefix || !this.config) {
        return []
      }

      try {
        return entriesOf(this.config.get(`${this.prefix}.historyColonies`, undefined)).map((entry) => ({ id: entry.id, name: entry.name || `Colony ${entry.id}`, bodyId: entry.bodyId }))
      } catch (error) {
        return []
      }
    },

    record() {
      return this.campaign && this.stored.read && this.stored.read.ok ? recordOf(this.stored.read.store, this.campaign.branchId) : null
    },

    // Why the open save's figures are not taken as recorded: the recorder failed for it, or has not yet recorded it.
    recordingProblem() {
      return this.recording ? recordingText(this.recording) : ''
    },

    // What the problem is about: 'file' (the acknowledgments cannot be read), 'history' (the branch's history cannot be read), 'recording' (the recorder failed for the open save), 'pending' (the recorder has not yet recorded it) or ''.
    problemKind() {
      return this.stored.error ? 'file' : this.history.error ? 'history' : this.recordingProblem ? (this.recording === RECORDING_PENDING ? 'pending' : 'recording') : ''
    },

    digest() {
      return buildDigest({ record: this.record, snapshots: this.history.snapshots, gameTime: this.gameTime === null || this.gameTime === '' ? null : this.gameTime, colonyRecord: this.history.colonyRecord, colonies: this.colonies, notes: this.notes, names: this.names, thinning: this.history.record ? thinningStatus(this.history.record) : null, recording: this.recording })
    },

    acknowledgeLabel() {
      return this.digest.state === 'ready' ? 'Acknowledge all changes' : this.record ? 'Take the open save as the boundary' : 'Acknowledge the open save'
    },

    acknowledgeable() {
      return Boolean(this.digest.now) && !this.problem
    },

    // The changes shown: those that are not acknowledged.
    shownCount() {
      return this.digest.items.length - this.digest.hidden
    },

    caption() {
      if (!this.campaign) {
        return 'Not settled'
      }

      return this.digest.state === 'ready' ? `${this.shownCount} to show` : 'Nothing compared'
    },

    coverage() {
      return this.digest.coverage ? coverageText(this.digest.coverage, durationText) : ''
    },

    unknownText() {
      return 'a figure of one of the two saves is not stored'
    },

    hiddenText() {
      return `${this.hidden} acknowledged ${this.hidden === 1 ? 'change is' : 'changes are'} hidden. A change that moves again after being acknowledged shows again.`
    },

    hidden() {
      return countText(this.digest.hidden, 0, this.separator)
    },
  },
  methods: {
    date(seconds) {
      return Number.isFinite(Number(this.startYear)) && this.startYear !== null && this.startYear !== '' ? new Date(Date.UTC(Number(this.startYear), 0, 1) + seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : `${countText(seconds / 31536000, 2, this.separator)} y elapsed`
    },

    count(value, decimals = 0) {
      return countText(value, decimals, this.separator)
    },

    text(item) {
      return itemText(item, (value) => this.count(value, Number.isInteger(value) ? 0 : 1), statusText)
    },

    kindName(kind) {
      return kindText(kind)
    },

    groupKind(group) {
      const kind = GROUP_KINDS[group.type] || group.type

      return group.stale ? `${kind}, link not current` : kind
    },

    failed(error) {
      this.failureName = error && error.name ? error.name : 'Error'
      this.message = error instanceof DigestChanged || error instanceof DigestLimit || error instanceof DigestScopeChanged || error instanceof DigestUnreadable || error instanceof DigestUnprotected ? error.message : `The acknowledgment could not be written: ${error.message}`
      this.messageType = 'warning'
      this.revision += 1
    },

    // The campaign, branch and race the panel shows now with the record the digest was built from: what an acknowledgment is made for, frozen when it is asked for.
    scope() {
      return this.campaign && this.raceId !== null && !this.recordingProblem ? { campaignId: this.campaign.campaignId, branchId: this.campaign.branchId, raceId: this.raceId, record: this.record } : null
    },

    inScope(scope) {
      return Boolean(this.campaign) && this.campaign.campaignId === scope.campaignId && this.campaign.branchId === scope.branchId && this.raceId === scope.raceId
    },

    // Writes one change to the race's store on the branch that was shown when it was asked for, only while the stored record is still the one the digest was built from, and where the file is shared by tabs of a browser only as the one tab holding the lock. `make(scope)` gives the change from the frozen scope (and the data frozen with it); a panel that shows another campaign, branch or race when the turn comes writes nothing.
    async commit(make) {
      const scope = this.scope()

      if (!scope || this.busy) {
        return
      }

      const next = make(scope)
      const change = guarded(scope.branchId, scope.record, next)

      this.busy = true
      this.message = ''
      this.failureName = ''

      try {
        await saveDigestSafely(digestStore(scope.campaignId), scope.raceId, (store) => {
          if (!this.inScope(scope)) {
            throw new DigestScopeChanged()
          }

          return change(store)
        })
        this.revision += 1
      } catch (error) {
        this.failed(error)
      } finally {
        this.busy = false
      }
    },

    // Takes the open save as the boundary: the changes after it show from now on, and none acknowledged one at a time is kept.
    acknowledge() {
      const now = this.digest.now

      if (!now) {
        return Promise.resolve()
      }

      return this.commit((scope) => (store) => withRecord(store, scope.branchId, recordFrom(now, Date.now())))
    },

    acknowledgeItem(item) {
      const { key, signature } = item

      return this.commit((scope) => (store) => withItem(store, scope.branchId, key, signature))
    },

    showAcknowledged() {
      const keys = this.digest.items.filter((item) => item.acknowledged).map((item) => item.key)

      return this.commit((scope) => (store) => keys.reduce((next, key) => withoutItem(next, scope.branchId, key), store))
    },
  },
}
</script>

<style lang="scss" scoped>
.notebook-digest__item {
  align-items: center;
  column-gap: 4px;
  display: flex;
  flex-wrap: wrap;
  padding: 2px 0 2px 12px;
}

.notebook-digest__group {
  border-top: 1px solid rgba(128, 128, 128, 0.3);
  padding-top: 6px;
}
</style>
