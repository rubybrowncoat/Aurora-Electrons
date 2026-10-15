<template>
  <v-card class="panel history-colonies" data-summary="The colonies of this race that the app follows through its history: each one's population, installations and stockpiles, one reading per save read while the app is open. Nothing is kept for a colony until it is chosen, the size of the record is estimated before choosing, and a colony that has left the save or changed hands is shown as that, never as zero." elevation="1">
    <div class="panel-head">
      <span>Colony series</span>
      <span class="caption text--secondary" data-colony-caption>{{ caption }}</span>
    </div>
    <div class="panel-body">
      <div v-if="!view" class="caption text--secondary" data-colony-unavailable>Colony series are unavailable: the campaign of the open save is not settled yet, so there is no history to add them to.</div>
      <template v-else>
        <v-alert v-if="view.error" type="warning" outlined dense data-colony-error>The colonies followed could not be read from the settings: {{ view.error }}.</v-alert>

        <div class="history-colonies__row"><span class="history-colonies__label">Followed</span><span class="history-colonies__value" data-colony-followed>{{ count(view.followed) }} of at most {{ count(limit) }} for this race<template v-if="view.dropped"> ({{ count(view.dropped) }} dropped, their record is kept)</template></span></div>
        <div class="history-colonies__row"><span class="history-colonies__label">Size, estimated</span><span class="history-colonies__value" data-colony-estimate>{{ estimateText() }}</span></div>
        <div class="history-colonies__row"><span class="history-colonies__label">Size, measured</span><span class="history-colonies__value" data-colony-measured>{{ measuredText() }}</span></div>

        <div v-if="readError" class="caption mt-3" data-colony-read-error>The colonies of the open save are unavailable: {{ readError }}.</div>
        <div v-else-if="rows === null" class="caption text--secondary mt-3">Reading the colonies of the open save.</div>
        <div v-else class="history-colonies__list mt-3">
          <table>
            <thead>
              <tr><th>Colony</th><th class="text-right">Population (M)</th><th>Followed</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="row in listed" :key="row.id" :data-colony="row.id">
                <td>{{ row.name }}</td>
                <td class="text-right">{{ row.population === null ? unknown : count(row.population, 3) }}</td>
                <td>{{ row.text }}</td>
                <td><v-btn x-small outlined :disabled="busy || row.locked" :data-colony-toggle="row.id" @click="toggle(row)">{{ row.followed ? 'Stop following' : 'Follow' }}</v-btn></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="message" class="caption mt-2" data-colony-message>{{ message }}</div>
        <div class="caption text--secondary mt-2" data-colony-limits>Following starts with the open save and records one reading for each save read after it while the app is open. A save that was not read leaves its interval unobserved, and nothing is filled in for it. A colony that is not in a save is recorded as gone, one held by another race or on another body as not the colony that was chosen, and one that could not be read as not read; none of them is a zero. Stopping keeps what was recorded and adds nothing after it. Each branch keeps its own record, seeded from the branch it forked from up to the fork and never merged. Saves are only read, never changed.</div>
      </template>
    </div>
  </v-card>
</template>

<script>
import { COLONY_BYTES, ColonyLimit, MAX_COLONIES, colonyEstimate, saveEntries, withColony, withoutColony } from '../../utilities/colony-series'
import { campaignStorage } from '../../utilities/history'
import { UNKNOWN_TEXT, countText } from '../../utilities/math'

// The panel of the History page that lets the player choose the colonies of the shown race to follow. `view` is { entries, followed, dropped, measured, snapshots, predicted, error } as the page reads it from the settings and the branch's colony file, or null while the campaign is not settled. A choice is written to the settings under the campaign and race, stamped with the game time of the open save, and the store is asked to read that save once more so the first reading is the save the colony was chosen in. `date` writes a game time as a date.
export default {
  name: 'ColonySeries',
  props: {
    database: {
      type: Object,
      default: null,
    },
    config: {
      type: Object,
      default: null,
    },
    gameId: {
      type: [Number, String],
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
    resolved: {
      type: Object,
      default: null,
    },
    view: {
      type: Object,
      default: null,
    },
    cap: {
      type: Number,
      default: 0,
    },
    date: {
      type: Function,
      default: (seconds) => String(seconds),
    },
    separator: {
      type: String,
      default: '\'',
    },
  },
  data() {
    return {
      // The colonies of the race in the open save, null while being read.
      rows: null,
      readError: '',
      busy: false,
      message: '',
    }
  },
  computed: {
    limit() {
      return MAX_COLONIES
    },
    bytes() {
      return COLONY_BYTES
    },
    unknown() {
      return UNKNOWN_TEXT
    },
    perColony() {
      return colonyEstimate({ snapshots: this.cap, colonies: 1 })
    },
    caption() {
      return this.view ? `${this.count(this.view.followed)} followed` : 'Unavailable'
    },
    // The race's colonies in the open save, then the followed ones the open save does not show (kept as stored, never as a zero).
    listed() {
      const now = new Map(((this.view && this.view.entries) || []).filter((entry) => entry.until === undefined).map((entry) => [entry.id, entry]))
      const last = new Map()

      ;((this.view && this.view.entries) || []).forEach((entry) => last.set(entry.id, entry))

      const open = (this.rows || []).map((row) => ({ id: Number(row.PopulationID), name: row.PopName, population: row.Population === null || row.Population === undefined ? null : Number(row.Population), colony: { id: Number(row.PopulationID), name: row.PopName, bodyId: row.SystemBodyID, raceId: row.RaceID } }))
      const shown = new Set(open.map((row) => row.id))
      const kept = [...last.values()].filter((entry) => !shown.has(entry.id)).map((entry) => ({ id: entry.id, name: entry.name, population: null, colony: entry, absent: true }))

      return [...open, ...kept].map((row) => {
        const entry = last.get(row.id)
        const followed = now.has(row.id)

        return { ...row, followed, locked: Boolean(row.absent) && !followed, text: this.entryText(entry, followed, row.absent) }
      })
    },
  },
  watch: {
    database: 'load',
    gameId: 'load',
    raceId: 'load',
    gameTime: 'load',
  },
  created() {
    this.load()
  },
  methods: {
    count(value, decimals = 0) {
      return countText(value, decimals, this.separator)
    },
    size(bytes) {
      return bytes === null || bytes === undefined ? UNKNOWN_TEXT : this.sizeText(bytes)
    },
    sizeText(bytes) {
      if (bytes < 1024) {
        return `${this.count(bytes)} B`
      }

      return bytes < 1048576 ? `${this.count(bytes / 1024, 1)} KiB` : `${this.count(bytes / 1048576, 1)} MiB`
    },
    estimateText() {
      const cap = this.count(this.cap)
      const head = `Following a colony adds about ${this.size(this.perColony)} for it once the series holds ${cap} snapshots (${cap} snapshots × ${COLONY_BYTES} bytes).`
      const followed = this.view.followed

      return followed ? `${head} The ${followed === 1 ? 'colony' : `${followed} colonies`} followed would take about ${this.size(this.view.predicted)} at the cap. This is a prediction, not a measure.` : `${head} No colony is followed, so none is recorded. This is a prediction, not a measure.`
    },
    measuredText() {
      const view = this.view

      return view.measured === null ? 'None recorded yet on this branch.' : `${this.size(view.measured)} for this race's colony series on this branch, in ${this.count(view.snapshots)} snapshots. Measured as compact JSON; the file on disk is larger by its indentation.`
    },
    entryText(entry, followed, absent) {
      if (!entry) {
        return 'No'
      }

      const since = `since ${this.date(entry.since)}`

      if (followed) {
        return absent ? `${since}; not in the open save` : since
      }

      return `${since}, stopped ${this.date(entry.until)}`
    },
    async load() {
      this.rows = null
      this.readError = ''

      if (!this.database || !this.gameId || !this.raceId) {
        this.readError = 'no save is open'

        return
      }

      const database = this.database
      const GameID = Number(this.gameId)
      const RaceID = Number(this.raceId)

      try {
        const [rows] = await database.query('select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.RaceID, FCT_Population.SystemBodyID, FCT_Population.Population from FCT_Population where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID order by FCT_Population.Population desc, FCT_Population.PopulationID', { replacements: { GameID, RaceID } })

        if (database === this.database && GameID === Number(this.gameId) && RaceID === Number(this.raceId)) {
          this.rows = rows
        }
      } catch (error) {
        if (database === this.database) {
          this.readError = error && error.message ? error.message : 'the read failed'
        }
      }
    },
    // Follows or stops following one colony, as of the open save's game time.
    toggle(row) {
      if (!this.resolved || this.busy) {
        return
      }

      this.busy = true
      this.message = ''

      try {
        const since = this.gameTime === null || this.gameTime === undefined || this.gameTime === '' ? NaN : Number(this.gameTime)

        if (!Number.isFinite(since)) {
          this.message = 'The choice could not be saved: the game time of the open save is not known'
          return
        }

        const settings = campaignStorage(this.config).settings

        saveEntries(settings, this.resolved.campaignId, Number(this.raceId), (entries) => (row.followed ? withoutColony(entries, row.id, since) : withColony(entries, row.colony, since)))
        this.$emit('changed')

        if (!row.followed) {
          this.$store.commit('history/capture')
        }
      } catch (error) {
        this.message = error instanceof ColonyLimit ? error.message : `The choice could not be saved: ${error.message}`
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style scoped lang="scss">
.history-colonies__row {
  column-gap: 12px;
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.history-colonies__label {
  flex: 0 0 180px;
  opacity: 0.75;
}

.history-colonies__value {
  flex: 1 1 260px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.history-colonies__list {
  max-height: 320px;
  overflow: auto;
}

.history-colonies__list th,
.history-colonies__list td {
  padding: 2px 12px 2px 0;
  text-align: left;
  white-space: nowrap;
}

.history-colonies__list .text-right {
  text-align: right;
}
</style>
