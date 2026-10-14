<template>
  <div>
    <v-container v-if="!historyRecorded" fluid class="history-page">
      <v-alert type="info" outlined dense>
        The app doesn't keep Empire History for this race. It's one of Aurora's special factions (such as the Precursors, Invaders or Rakhas), which have no empire to chart. History is kept for player races and NPR empires.
      </v-alert>
    </v-container>

    <v-container v-else fluid class="history-page">
      <v-row dense align="center" class="mb-1">
        <v-col class="caption text--secondary">
          <template v-if="recording">{{ recording.headline }}<provenance-mark rule="history.recordedSpan" /></template>
          The app records one each time Aurora saves while it's open, for every player race and NPR empire in the save.<provenance-mark :result="timeAxis" />
          <div v-if="recording && recording.note" class="history-recording-note">{{ recording.note }}</div>
        </v-col>
        <v-col cols="auto">
          <v-btn-toggle v-model="span" mandatory dense class="mr-2">
            <v-btn v-for="option in spanOptions" :key="option.value" :value="option.value" small :title="option.title">{{ option.text }}</v-btn>
          </v-btn-toggle>
          <v-btn-toggle v-model="view" mandatory dense>
            <v-btn value="charts" small><v-icon small>mdi-chart-line</v-icon></v-btn>
            <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
          </v-btn-toggle>
          <v-btn small text :disabled="!allSnapshots.length" class="ml-2" @click="downloadCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
          <v-btn small text color="error" :disabled="!allSnapshots.length" @click="confirmClear = true">Clear</v-btn>
        </v-col>
      </v-row>

      <v-alert v-if="failure && failure.stage === 'readonly'" type="info" outlined dense class="mt-3">
        Another window or tab of this app records this database's history and campaigns, so this one shows what is stored and writes nothing: no save is matched to a campaign here, and race settings are not remembered. Recording starts here when the other one is closed.
      </v-alert>
      <v-alert v-else-if="failure && failure.stage === 'registry'" type="warning" outlined dense class="mt-3">
        The campaign registry in the history folder is damaged, so no save was matched to a campaign and nothing was recorded. The file was left as it is, so it can be recovered; the console has the details.
      </v-alert>
      <v-alert v-else-if="failure && failure.stage === 'write'" type="warning" outlined dense class="mt-3">
        The latest snapshot couldn't be written to the history file, so this history has stopped growing: the disk or browser storage may be full, or the file locked. The app tries again at the next save. The console has the details.
      </v-alert>
      <v-alert v-else-if="failure" type="warning" outlined dense class="mt-3">
        The latest save couldn't be read for a snapshot (the game may have been writing it), so this history is missing it. The app tries again at the next save. The console has the details.
      </v-alert>

      <v-card v-if="campaignView" class="panel history-campaign" data-summary="Which campaign this save belongs to, the branches of its recorded timeline, the saves attached to it, and any history still waiting for an answer on where it belongs. Saves are matched by what they hold, never by where they sit on disk." elevation="1">
        <div class="panel-head">
          <span>Campaign<v-chip v-if="campaignView.carriedOver" x-small outlined class="ml-2" title="The history recorded before campaigns were told apart was assumed to belong to this campaign">carried over</v-chip></span>
          <span class="caption text--secondary">{{ campaignView.title }}</span>
        </div>
        <div class="panel-body">
          <div v-if="campaignView.names.length > 1" class="caption text--secondary">Named {{ campaignView.names.join(', then ') }} over time.</div>
          <div v-if="campaignView.carriedOver" class="caption text--secondary mt-1">The history from before campaigns were recorded was assumed to be this campaign's: {{ campaignView.carriedOver }}.<template v-if="campaignView.conflict"> A campaign recognised from a save of the same game id exists as well, so this assumption may be wrong; nothing was merged.</template></div>

          <div v-if="campaignView.branches.length > 1" class="mt-2">
            <div class="caption text--secondary">Branches: a save that left an earlier timeline at some point is a branch of its own, and its history is kept apart.</div>
            <v-btn-toggle :value="shownBranchId" mandatory dense class="mt-1 flex-wrap" @change="branchChoice = $event">
              <v-btn v-for="branch in campaignView.branches" :key="branch.id" :value="branch.id" small :title="branch.title">{{ branch.id }}<span class="caption ml-1">{{ branch.text }}</span></v-btn>
            </v-btn-toggle>
          </div>

          <div v-if="campaignView.attachments.length" class="mt-2">
            <div class="caption text--secondary">Saves recognised as this campaign, newest first:</div>
            <div v-for="attachment in campaignView.attachments" :key="`${attachment.path}-${attachment.GameID}`" class="history-campaign__path"><span class="path">{{ attachment.path || 'Path not known' }}</span> <span class="caption text--secondary">{{ attachment.text }}</span></div>
          </div>

          <v-alert v-if="campaignView.pending.length" type="warning" outlined dense class="mt-3">
            <div>This save shares its game id with {{ campaignView.pending.length === 1 ? 'a recorded campaign' : 'recorded campaigns' }}, and its record is too short to tell whether it is the same campaign. It is kept apart until an answer is given; nothing is merged on a guess.</div>
            <div v-for="candidate in campaignView.pending" :key="candidate.key" class="history-campaign__candidate mt-2">
              <div class="font-weight-medium">{{ candidate.name }}, branch {{ candidate.branchId }}</div>
              <div class="caption">{{ candidate.span }}</div>
              <div v-if="candidate.same" class="caption text--secondary">Merge into branch: {{ candidate.same }}</div>
              <div v-if="candidate.newBranch" class="caption text--secondary">New branch: {{ candidate.newBranch }}</div>
              <v-btn small outlined class="mr-2 mt-1" @click="attachCurrent(candidate, 'same')">Same campaign: merge into the branch</v-btn>
              <v-btn small outlined class="mt-1" @click="attachCurrent(candidate, 'new-branch')">Same campaign: keep as a new branch</v-btn>
            </div>
            <v-btn small text class="mt-2" @click="keepCurrentSeparate">Separate campaign: keep apart</v-btn>
          </v-alert>

          <div v-if="campaignView.pool.length" class="mt-3">
            <div class="font-weight-medium">History kept from before campaigns were recorded</div>
            <div class="caption text--secondary">These records could not be tied to one campaign. They stay where they are, unchanged, until attached to this campaign.</div>
            <div v-for="entry in campaignView.pool" :key="entry.id" class="history-campaign__candidate mt-2">
              <div>{{ entry.text }}</div>
              <div class="caption text--secondary">{{ entry.reason }}</div>
              <div v-if="entry.same" class="caption text--secondary">Merge into this branch: {{ entry.same }}</div>
              <v-btn small outlined class="mr-2 mt-1" @click="attachPool(entry, 'same')">Attach to this branch</v-btn>
              <v-btn small outlined class="mt-1" @click="attachPool(entry, 'new-branch')">Attach as a new branch</v-btn>
            </div>
          </div>

          <v-alert v-if="campaignError" type="error" outlined dense class="mt-3">{{ campaignError }}</v-alert>
        </div>
      </v-card>

      <v-alert v-if="!allSnapshots.length" type="info" outlined dense class="mt-3">
        No history for this race yet. A snapshot is taken as soon as the app reads the save, and another each time Aurora saves the game. For the past year of income and spending, see <router-link to="/finances">Finances</router-link>.
      </v-alert>

      <template v-else>
        <stat-tiles :tiles="tiles" class="mt-1" />

        <v-alert v-if="allSnapshots.length === 1" type="info" outlined dense class="mt-4">
          History starts here. Charts fill in as Aurora saves: each save while the app is open adds a point.
        </v-alert>

        <v-card v-if="view === 'charts' && rivals" class="panel" data-summary="Every race recorded in this game on one chosen measure over time, to see who is ahead of the race and who is catching up." elevation="1">
          <div class="panel-head">
            <span>Rivals<provenance-mark :rule="rivals.rule" /> <span class="caption text--secondary ml-2">Spy mode: every race recorded in this game</span></span>
            <span class="legend">
              <span v-for="series in rivals.data.datasets" :key="series.label" class="legend-item" :class="{ 'font-weight-bold': series.borderWidth === 3 }"><series-key :color="series.borderColor" :dash="series.borderDash" kind="line" />{{ series.label }}</span>
            </span>
          </div>
          <div class="panel-body">
            <v-btn-toggle v-model="rivalMetric" mandatory dense class="mb-2 flex-wrap">
              <v-btn v-for="metric in rivalMetrics" :key="metric.value" :value="metric.value" small>{{ metric.text }}</v-btn>
            </v-btn-toggle>
            <chart-canvas type="line" :data="rivals.data" :options="rivals.options" :height="280" label="Rivals" />
          </div>
        </v-card>

        <v-row v-if="view === 'charts'">
          <v-col v-for="chart in charts" :key="chart.key" cols="12" lg="6">
            <v-card class="panel" :data-summary="chart.summary" elevation="1">
              <div class="panel-head">
                <span>{{ chart.title }}<provenance-mark v-for="rule in chart.rules" :key="rule" :rule="rule" /></span>
                <span class="legend">
                  <span v-for="series in chart.data.datasets" :key="series.label" class="legend-item"><series-key :color="series.borderColor" :dash="series.borderDash" kind="line" />{{ series.label }}</span>
                </span>
              </div>
              <div class="panel-body">
                <div v-if="chart.compare" class="mb-2 history-compare">
                  <v-btn-toggle v-model="mineralScale" mandatory dense class="mr-2">
                    <v-btn v-for="option in chart.compare.scales" :key="option.value" :value="option.value" small :title="option.title">{{ option.text }}</v-btn>
                  </v-btn-toggle>
                  <v-btn small text :disabled="chart.compare.resetDisabled" title="Show every retained snapshot: the span above goes back to All, for the whole page. The minerals picked and the scale stay." @click="resetMineralRange"><v-icon small left>mdi-backup-restore</v-icon>Reset range</v-btn>
                  <v-btn small text :disabled="chart.compare.csvDisabled" title="Download the minerals picked, on the scale shown, as a CSV with units and baselines" @click="downloadMineralCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
                </div>
                <div v-if="chart.picker" class="mb-2">
                  <v-chip-group :value="chart.picker.model" multiple column @change="chart.picker.change">
                    <v-chip v-for="option in chart.picker.options" :key="option.value" :value="option.value" :title="option.title" small filter outlined><series-key v-if="option.color" :color="option.color" :dash="option.dash" kind="line" />{{ option.text }}<span v-if="option.flag" class="caption text--secondary ml-1">{{ option.flag }}</span></v-chip>
                  </v-chip-group>
                </div>
                <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="240" :label="chart.title" />
                <div v-for="note in chart.notes" :key="note" class="caption text--secondary mt-1">{{ note }}</div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-card v-else class="panel" elevation="1">
          <v-data-table :headers="tableHeaders" :items="tableRows" item-key="t" :custom-sort="sortRows" :sort-by.sync="historyTable.sortBy" :sort-desc.sync="historyTable.sortDesc" :items-per-page.sync="historyTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: historyPageSizes }" dense>
            <template v-for="column in tableHeaders" #[`header.${column.value}`]="{ header }">{{ header.text }}<provenance-mark v-if="column.rule" :key="column.value" :rule="column.rule" /></template>
            <template v-for="column in measureColumns" #[`item.${column.value}`]="{ item }">{{ count(item[column.value], column.decimals) }}<provenance-mark v-if="item.results[column.value].status === 'unavailable'" :key="column.value" :result="item.results[column.value]" /></template>
          </v-data-table>
        </v-card>
      </template>

      <v-card class="panel history-backup" data-summary="A file of the campaigns, the history of each race and what it knows of the others, and the planners' annotations, to keep or to move to another computer. A restore shows what it would add, keep and replace for each campaign and branch before anything is written, and keeps a copy of what it touches first. The save is never touched." elevation="1">
        <div class="panel-head">
          <span>Backup</span>
          <span class="caption text--secondary">Export the history, or restore it from a file</span>
        </div>
        <div class="panel-body">
          <div class="history-backup__actions">
            <v-btn small outlined :disabled="backupBusy" title="Every campaign recorded on this computer, with its branches, race and intelligence history and annotations" @click="exportBackup(true)"><v-icon small left>mdi-download</v-icon>Export all campaigns</v-btn>
            <v-btn small outlined :disabled="backupBusy || !resolved" title="Only the campaign this save belongs to" @click="exportBackup(false)"><v-icon small left>mdi-download</v-icon>Export this campaign</v-btn>
            <v-file-input :key="backupInput" accept="application/json,.json" label="Restore from a backup file" prepend-icon="" prepend-inner-icon="mdi-upload" dense outlined hide-details class="history-backup__file" :disabled="backupBusy" @change="readBackup" />
          </div>
          <div class="caption text--secondary mt-2">A backup holds the campaign records, the history of every race, what each race knows of the others and the annotations. The unattached history from before campaigns were recorded, the migration record and the settings of each race are not in it. A restore only adds to a campaign record; it never changes an answer already given and never merges two campaigns.</div>

          <v-alert v-if="backupErrors.length" type="error" outlined dense class="mt-3">
            <div>{{ backupFile }} was not read, and nothing was changed:</div>
            <div v-for="message in backupErrors" :key="message">{{ message }}</div>
          </v-alert>
          <v-alert v-if="backupError" type="error" outlined dense class="mt-3">{{ backupError }}</v-alert>
          <v-alert v-if="backupResult" type="success" outlined dense class="mt-3">{{ backupResult }}</v-alert>
          <v-alert v-if="unfinishedBackup" type="warning" outlined dense class="mt-3">
            <div v-if="unfinishedBackup.problem">The restore started {{ stamp(unfinishedBackup.at) }} ({{ unfinishedBackup.label }}) did not finish, and the history kept for it cannot be read back ({{ unfinishedBackup.problem }}). It is kept as it is, and no restore is applied until it is abandoned. Download it to save what it holds, or abandon it to put it among the other copies.</div>
            <div v-else>The restore started {{ stamp(unfinishedBackup.at) }} ({{ unfinishedBackup.label }}) did not finish. The history it began with is kept. Apply the same backup again with the same choices to finish it, or abandon it to keep the files as they are now. No other restore is applied until then.</div>
            <div class="mt-1">
              <v-btn x-small text :disabled="backupBusy" title="The history as it was before the restore began, as a backup file" @click="downloadUnfinished"><v-icon x-small left>mdi-download</v-icon>Download the kept history</v-btn>
              <v-btn x-small text :disabled="backupBusy || (failure && failure.stage === 'readonly')" class="ml-2" title="Stop treating the restore as unfinished: the kept history joins the other copies and no file changes" @click="abandonBackup"><v-icon x-small left>mdi-close</v-icon>Abandon</v-btn>
            </div>
          </v-alert>

          <div v-if="backupPlan" class="history-backup__preview mt-3">
            <div class="font-weight-medium">{{ backupFile }}<span class="caption text--secondary ml-2">made {{ stamp(backupPlan.preview.exportedAt) }}</span></div>
            <div class="caption text--secondary">Nothing is written until the restore is applied. Merge keeps what is stored where both have a snapshot at the same game time; Replace takes the backup's and drops stored snapshots it lacks; Keep leaves the target as it is.</div>

            <div v-for="item in backupPlan.preview.campaigns" :key="item.id" class="history-backup__campaign mt-3">
              <div class="history-backup__title">
                <span class="font-weight-medium">{{ item.name }}</span><span class="caption text--secondary ml-2" title="The app's own id of this campaign">{{ item.id }}</span>
                <v-chip x-small outlined :color="statusColor(item.status)" class="ml-2">{{ statusText(item.status) }}</v-chip>
                <v-chip v-if="item.skipped" x-small outlined class="ml-1">not restored</v-chip>
              </div>
              <div v-for="note in item.notes" :key="note" class="caption text--secondary">{{ note }}</div>

              <div v-if="!item.skipped" class="history-backup__row mt-1">
                <span class="history-backup__label">Campaign record</span>
                <v-btn-toggle :value="item.requested" mandatory dense @change="chooseAssociation(item.id, $event)">
                  <v-btn value="merge" small title="Add the names, game ids, saves, branches and later tips the backup has">Add</v-btn>
                  <v-btn value="keep" small title="Leave the campaign record as it is">Keep</v-btn>
                </v-btn-toggle>
                <span class="caption text--secondary ml-2">{{ changesText(item) }}</span>
              </div>
              <div v-for="note in item.association.kept" :key="note" class="caption text--secondary">Kept as stored: {{ note }}.</div>

              <v-simple-table dense class="history-backup__table mt-1">
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Policy</th>
                    <th>Races</th>
                    <th class="text-right" title="Snapshots stored now">Stored</th>
                    <th class="text-right" title="Snapshots in the backup">Backup</th>
                    <th class="text-right" title="Backup snapshots at a game time with none stored">Added</th>
                    <th class="text-right" title="Snapshots at the same game time with the same figures">Same</th>
                    <th class="text-right" title="Snapshots at the same game time with different figures">Conflicts</th>
                    <th class="text-right" title="Stored snapshots a replace drops">Removed</th>
                    <th class="text-right" title="Snapshots thinned to keep the retention cap">Thinned</th>
                    <th class="text-right" title="Snapshots in the result">After</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="file in item.files">
                    <tr :key="file.branchId">
                      <td>{{ file.branchId }}<span class="caption text--secondary ml-1">{{ relationText(file) }}</span></td>
                      <td>
                        <v-btn-toggle :value="file.requested" mandatory dense :class="{ 'history-backup__locked': file.locked }" @change="choosePolicy(item.id, file.branchId, $event)">
                          <v-btn value="merge" x-small :disabled="item.skipped">Merge</v-btn>
                          <v-btn value="replace" x-small :disabled="item.skipped">Replace</v-btn>
                          <v-btn value="keep" x-small :disabled="item.skipped">Keep</v-btn>
                        </v-btn-toggle>
                      </td>
                      <td class="history-backup__races">
                        <v-select :value="file.races || []" :items="file.raceChoices" item-value="RaceID" item-text="label" multiple chips small-chips deletable-chips dense hide-details placeholder="All races" :disabled="item.skipped || file.policy === 'keep' || file.raceChoices.length < 2" @change="chooseRaces(item.id, file.branchId, $event)" />
                      </td>
                      <td class="text-right">{{ count(file.totals.stored) }}</td>
                      <td class="text-right">{{ count(file.totals.backup) }}</td>
                      <td class="text-right">{{ count(file.policy === 'keep' ? 0 : file.totals.added) }}</td>
                      <td class="text-right">{{ count(file.totals.identical) }}</td>
                      <td class="text-right" :class="{ 'warning--text': file.totals.conflicts && file.policy !== 'keep' }">{{ count(file.totals.conflicts) }}</td>
                      <td class="text-right" :class="{ 'warning--text': file.policy === 'replace' && file.totals.removed }">{{ count(file.policy === 'replace' ? file.totals.removed : 0) }}</td>
                      <td class="text-right">{{ count(file.totals.thinned) }}</td>
                      <td class="text-right">{{ count(file.totals.result) }}</td>
                    </tr>
                    <tr v-if="file.locked || file.series.length" :key="`${file.branchId}-detail`" class="history-backup__detail">
                      <td colspan="11">
                        <div v-if="file.locked" class="caption text--secondary">Kept as stored: {{ file.locked }}.</div>
                        <details v-if="file.series.length">
                          <summary class="caption text--secondary">Every series in branch {{ file.branchId }}, one by one</summary>
                          <div v-for="row in file.series" :key="row.key" class="caption">{{ row.label }}: {{ count(row.stored) }} stored, {{ count(row.backup) }} in the backup, {{ count(row.added) }} added, {{ count(row.identical) }} the same, {{ count(row.conflicts) }} in conflict<template v-if="file.policy === 'replace'">, {{ count(row.removed) }} removed</template><template v-if="row.thinned">, {{ count(row.thinned) }} thinned</template></div>
                        </details>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </v-simple-table>

              <div v-if="item.annotations.total" class="history-backup__row mt-2">
                <span class="history-backup__label">Annotations</span>
                <v-btn-toggle :value="item.annotations.requested" mandatory dense :class="{ 'history-backup__locked': item.skipped }" @change="chooseAnnotations(item.id, $event)">
                  <v-btn value="merge" small :disabled="item.skipped || !item.annotations.available" title="Add the annotations stored here lacks, never over one stored and never one deleted here">Add</v-btn>
                  <v-btn value="keep" small :disabled="item.skipped" title="Leave the annotations as they are">Keep</v-btn>
                </v-btn-toggle>
                <span class="caption text--secondary ml-2">{{ item.annotations.total }} in the backup<template v-if="!item.annotations.available">; the planners' records are not available here</template></span>
              </div>
              <div v-for="group in item.annotations.groups" :key="`${group.RaceID}-${group.branchId}`" class="caption text--secondary">
                Race {{ group.RaceID }}, branch {{ group.branchId }}: {{ count(group.records) }} in the backup, {{ count(group.add) }} to add, {{ count(group.existing) }} here already, {{ count(group.deleted) }} deleted here, {{ count(group.rejected) }} refused<template v-if="group.locked">; kept as stored ({{ group.locked }})</template><template v-if="group.refused">; {{ group.refused }}</template>
                <div v-for="reason in group.reasons" :key="reason">{{ reason }}</div>
              </div>
            </div>

            <div class="mt-3">
              <div v-if="backupPlan.preview.nothingToDo" class="caption text--secondary">Nothing to restore with these choices: what the backup holds is stored already, or kept.</div>
              <div v-else class="caption">{{ totalsText(backupPlan.preview.totals) }}</div>
              <v-alert v-if="backupPlan.preview.needsConfirmation.length" type="warning" outlined dense class="mt-2">
                <div v-for="message in backupPlan.preview.needsConfirmation" :key="message">{{ message }}.</div>
                <v-checkbox v-model="backupConfirmed" label="Confirm these changes" dense hide-details class="mt-1" />
              </v-alert>
              <v-alert v-if="failure && failure.stage === 'readonly'" type="info" outlined dense class="mt-2">Another window or tab records this history, so a restore can only be applied there.</v-alert>
              <div class="mt-2">
                <v-btn small color="primary" :disabled="backupBusy || backupPlan.preview.nothingToDo || (backupPlan.preview.needsConfirmation.length > 0 && !backupConfirmed) || (failure && failure.stage === 'readonly')" @click="applyBackup"><v-icon small left>mdi-backup-restore</v-icon>Apply</v-btn>
                <v-btn small text :disabled="backupBusy" class="ml-2" @click="cancelBackup">Cancel</v-btn>
              </div>
            </div>
          </div>

          <div v-if="keptBackupList.length" class="mt-4">
            <div class="font-weight-medium">Copies kept before a restore</div>
            <div class="caption text--secondary">The newest few stay here. To bring the files of a copy back as they were, download it and restore it with Replace; campaign records a restore added stay.</div>
            <div v-for="entry in keptBackupList" :key="entry.at" class="history-backup__kept">
              <span>{{ stamp(entry.at) }}</span><span class="caption text--secondary ml-2">{{ entry.label }}</span>
              <v-btn x-small text class="ml-2" @click="downloadKept(entry.at)"><v-icon x-small left>mdi-download</v-icon>Download</v-btn>
            </div>
          </div>
        </div>
      </v-card>

      <v-dialog v-model="confirmClear" max-width="440">
        <v-card>
          <v-card-title>Clear this race's history?</v-card-title>
          <v-card-text>This deletes the {{ allSnapshots.length }} snapshots the app has recorded for this race<template v-if="campaignView && campaignView.branches.length > 1"> in branch {{ shownBranchId }}</template>. The save isn't touched, and recording starts again at the next save.</v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn text @click="confirmClear = false">Cancel</v-btn>
            <v-btn text color="error" @click="clearHistory">Clear</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { gameTime } from '../utilities/aurora'
import { readRegistry } from '../utilities/campaign'
import { attach, keepSeparate, previewAttach } from '../utilities/campaign-attach'
import { MAX_SNAPSHOTS, branchStore, campaignStorage, changeResult, clearRaceHistory, installationResult, mineralResult, recordedSpan, shownBranch, snapshotResult, totalResult } from '../utilities/history'
import { Changed, MAX_BYTES, Rejected, abandonRestore, annotationsOf, applyRestore, backupFileName, buildBackup, defaultChoices, keptBackups, parseBackup, planRestore, recoveryFileName, unfinishedProblem, unfinishedRestore } from '../utilities/history-backup'
import { UNKNOWN_TEXT, countText, isKnownNumber, roundToDecimal } from '../utilities/math'
import { MINERAL_SCALES, compareMinerals, comparisonCsv, mineralStyle } from '../utilities/mineral-compare'
import { MINERALS } from '../utilities/minerals'
import { describeResult, isAvailable, ofRule, unavailable, valueOrNull } from '../utilities/provenance'
import { withRegistry } from '../utilities/recording-owner'

const SECONDS_PER_YEAR = 31536000
// How far back the tiles, charts and table reach, in years before the latest snapshot; 0 is all.
const SPAN_OPTIONS = [10, 20, 50].map((years) => ({ value: years, text: `${years} y`, title: `The last ${years} years` })).concat({ value: 0, text: 'All', title: 'Every snapshot' })
const HISTORY_PAGE_SIZES = [25, 100, -1]
// Installation types charted when the player hasn't picked any: the largest by count.
const DEFAULT_INSTALLATIONS = 5

// An unknown figure reads as a dash, never 0.
const compact = (value) => {
  if (!isKnownNumber(value)) {
    return UNKNOWN_TEXT
  }

  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 2)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 1)}`
}

// Millions of people, in billions from 1,000 M (three decimals, so slow growth still shows).
const people = (millions) => (!isKnownNumber(millions) ? UNKNOWN_TEXT : Math.abs(millions) >= 1000 ? `${roundToDecimal(millions / 1000, 3)} bn` : `${roundToDecimal(millions, 1)} M`)

const whole = (value) => (isKnownNumber(value) ? `${roundToDecimal(value, 0)}` : UNKNOWN_TEXT)

const withUnit = (text, unit) => (text === UNKNOWN_TEXT ? text : `${text} ${unit}`)

// A percent change on an axis: signed, 0 without a sign.
const percentTick = (value) => (!isKnownNumber(value) ? UNKNOWN_TEXT : value === 0 ? '0 %' : `${value > 0 ? '+' : '−'}${compact(Math.abs(value))} %`)

const fleetResult = (snapshot) => totalResult('history.fleetTonnage', [snapshotResult(snapshot, 'militaryTons'), snapshotResult(snapshot, 'commercialTons')])

// What the Rivals chart can compare: `result` is a snapshot's figure as a result of `rule`.
const RIVAL_METRICS = [
  { value: 'population', text: 'Population', rule: 'history.population', result: (snapshot) => snapshotResult(snapshot, 'population'), format: people },
  { value: 'colonies', text: 'Colonies', rule: 'history.colonies', result: (snapshot) => snapshotResult(snapshot, 'colonies'), format: whole },
  { value: 'fleet', text: 'Fleet tonnage', rule: 'history.fleetTonnage', result: fleetResult, format: (value) => withUnit(compact(value), 't') },
  { value: 'military', text: 'Military tonnage', rule: 'history.fleetTonnage', result: (snapshot) => snapshotResult(snapshot, 'militaryTons'), format: (value) => withUnit(compact(value), 't') },
  { value: 'research', text: 'Research', rule: 'history.research', result: (snapshot) => snapshotResult(snapshot, 'research'), format: (value) => withUnit(compact(value), 'RP') },
  { value: 'systems', text: 'Known systems', rule: 'history.systems', result: (snapshot) => snapshotResult(snapshot, 'systems'), format: whole },
  { value: 'wealth', text: 'Treasury', rule: 'history.treasury', result: (snapshot) => snapshotResult(snapshot, 'wealth'), format: compact },
]

// The table's figure columns.
const MEASURES = [
  { value: 'population', text: 'Population (M)', decimals: 1, rule: 'history.population' },
  { value: 'colonies', text: 'Colonies', decimals: 0, rule: 'history.colonies' },
  { value: 'wealth', text: 'Treasury', decimals: 0, rule: 'history.treasury' },
  { value: 'militaryTons', text: 'Military (t)', decimals: 0, rule: 'history.fleetTonnage' },
  { value: 'commercialTons', text: 'Commercial (t)', decimals: 0, rule: 'history.fleetTonnage' },
  { value: 'research', text: 'Research (RP)', decimals: 0, rule: 'history.research' },
  { value: 'systems', text: 'Systems', decimals: 0, rule: 'history.systems' },
]

const RIVAL_METRIC_VALUES = RIVAL_METRICS.map((metric) => metric.value)

export default {
  name: 'HistoryPage',
  components: { ChartCanvas, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    persistedView({
      view: { key: 'historyView', default: 'charts', valid: oneOf(['charts', 'table']) },
      historyTable: tableView('historyTable', { itemsPerPage: 25, itemsPerPageOptions: HISTORY_PAGE_SIZES }),
      mineralIds: { key: 'historyMinerals', default: [1, 2, 11], normalise: (stored) => (Array.isArray(stored) ? MINERALS.map((mineral) => mineral.id).filter((id) => stored.includes(id)) : undefined) },
      mineralScale: { key: 'historyMineralScale', default: 'absolute', valid: oneOf(MINERAL_SCALES.map((option) => option.value)) },
      installationIds: { key: 'historyInstallations', default: null, scope: 'race' },
      rivalMetric: { key: 'historyRivalsMetric', default: 'population', valid: oneOf(RIVAL_METRIC_VALUES) },
      span: { key: 'historySpan', default: 0, valid: oneOf(SPAN_OPTIONS.map((option) => option.value)) },
    }),
  ],
  data() {
    return {
      confirmClear: false,
      historyPageSizes: HISTORY_PAGE_SIZES,
      measureColumns: MEASURES,
      rivalMetrics: RIVAL_METRICS,
      spanOptions: SPAN_OPTIONS,
      // Spy mode shows the other races' history (Rivals). Read on creation: it's set on Settings.
      spyNPR: false,
      // Bumped when this page clears the history, so `gameHistory` re-reads it.
      cleared: 0,
      // The branch picked on this page; the settled branch until one is.
      branchChoice: null,
      // Bumped when this page changes the campaign registry, so the Campaign panel re-reads it.
      campaignChanges: 0,
      campaignError: '',
      // The Backup panel: the file picked (its envelope is frozen, so Vue doesn't walk it), what it would change, and the choices made for it.
      backupEnvelope: null,
      backupFile: '',
      backupErrors: [],
      backupError: '',
      backupResult: '',
      backupChoices: null,
      backupPlan: null,
      backupConfirmed: false,
      backupBusy: false,
      // Changes the key of the file input, so it is empty again after a cancel.
      backupInput: 0,
      // Bumped when the copies kept before a restore change.
      backupKept: 0,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'historyRecorded']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    // The campaign and branch the recorder settled this game to, null until it has.
    resolved() {
      return this.$store.getters['history/campaign']
    },

    // The branch the page shows: the one picked, if the campaign has it, else the one the save belongs to.
    shownBranchId() {
      const picked = this.branchChoice

      return this.resolved ? shownBranch(this.campaignView ? this.campaignView.branches.map((branch) => branch.id) : [], picked, this.resolved.branchId) : null
    },

    // The shown branch's history file, re-read whenever the recorder writes (store revision) or this page clears it.
    gameHistory() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared + this.campaignChanges

      if (!this.GameID || !this.RaceID || !this.historyRecorded || !this.resolved) {
        return null
      }

      return branchStore(this.resolved.campaignId, this.shownBranchId).store
    },

    // The Campaign panel: what the registry holds on the settled campaign, as text and as the choices the player has. Null until the game is settled.
    campaignView() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.campaignChanges

      const resolved = this.resolved

      if (!resolved) {
        return null
      }

      const io = campaignStorage(this.config)
      let registry

      try {
        registry = readRegistry(io)
      } catch (error) {
        return null
      }

      const campaign = registry.campaigns[resolved.campaignId]

      if (!campaign) {
        return null
      }

      const stamp = (milliseconds) => new Date(milliseconds).toISOString().slice(0, 10)
      const nameOf = (entry) => (entry.names.length ? entry.names[entry.names.length - 1].name : 'Unnamed campaign')
      const countIn = (file, RaceID) => {
        const record = file && file.races ? file.races[RaceID] : null

        return record && Array.isArray(record.snapshots) ? record.snapshots.length : 0
      }
      const previewText = (details) => `${details.added} snapshot${details.added === 1 ? '' : 's'} added${details.overlaps ? `, ${details.overlaps} at a game time both hold` : ''}; ${details.settingsCopied} remembered setting${details.settingsCopied === 1 ? '' : 's'} copied, ${details.settingsKept} already set kept as they are.`
      const preview = (from, to, mode) => {
        try {
          return previewAttach(io, { from, to, mode })
        } catch (error) {
          return null
        }
      }
      // The branch a history from before campaigns is attached to: the one picked on this page, not the one the open save settled to.
      const here = { campaignId: campaign.id, branchId: shownBranch(Object.keys(campaign.branches), this.branchChoice, resolved.branchId) }
      const pendingKeys = new Set()
      const pending = []

      campaign.attachments.filter((attachment) => attachment.answer === null).forEach((attachment) => {
        attachment.pending.forEach((candidate) => {
          const key = `${candidate.campaignId}/${candidate.branchId}`
          const other = registry.campaigns[candidate.campaignId]

          if (pendingKeys.has(key) || !other || other.mergedInto || !other.branches[candidate.branchId]) {
            return
          }

          pendingKeys.add(key)

          const to = { campaignId: candidate.campaignId, branchId: candidate.branchId }
          const sameWith = preview({ campaignId: campaign.id }, to, 'same')
          const newWith = preview({ campaignId: campaign.id }, to, 'new-branch')

          pending.push({ key, campaignId: candidate.campaignId, branchId: candidate.branchId, name: nameOf(other), span: `Recorded game ${other.gameIds[0]}, ${other.branches[candidate.branchId].tip.n} ledger entries seen`, same: sameWith ? previewText(sameWith) : '', newBranch: newWith ? previewText(newWith) : '' })
        })
      })

      const pool = Object.values(registry.pool).filter((entry) => entry.attachedTo === null && entry.GameID === Number(this.GameID)).map((entry) => {
        const withPreview = preview({ poolId: entry.id }, here, 'same')
        const span = entry.span && entry.span.snapshots ? `${entry.span.snapshots} snapshot${entry.span.snapshots === 1 ? '' : 's'} from ${this.date(entry.span.first)} to ${this.date(entry.span.last)}` : 'no snapshots'

        return { id: entry.id, text: `Game ${entry.GameID}${entry.gameName ? `, "${entry.gameName}"` : ''}: ${span}`, reason: `Not attached automatically: ${entry.reason}.`, same: withPreview ? previewText(withPreview) : '' }
      })

      return {
        title: nameOf(campaign),
        names: campaign.names.map((entry) => entry.name),
        carriedOver: campaign.provenance === 'legacy-assumed' && campaign.legacy ? campaign.legacy.reason : '',
        conflict: !!(campaign.legacy && campaign.legacy.conflict),
        branches: Object.values(campaign.branches).map((branch) => {
          const file = branchStore(campaign.id, branch.id).store
          const count = countIn(file, this.RaceID)
          const where = branch.fork ? `forked from ${branch.parent}${branch.fork.t === null ? ' at the start' : ` at ${this.date(branch.fork.t)}`}` : branch.parent ? `a branch of ${branch.parent}` : 'the first timeline recorded'

          return { id: branch.id, text: `${count} snapshot${count === 1 ? '' : 's'}${branch.id === resolved.branchId ? ', this save' : ''}`, title: `${where}; last seen ${stamp(branch.seen)}` }
        }),
        attachments: campaign.attachments.map((attachment) => ({ path: attachment.path, GameID: attachment.GameID, text: `game ${attachment.GameID}, branch ${attachment.branchId}, last seen ${stamp(attachment.lastSeen)}` })),
        pending,
        pool,
      }
    },

    record() {
      return this.gameHistory && this.gameHistory.races ? this.gameHistory.races[this.RaceID] || null : null
    },

    // Why the recorder missed this game's latest snapshots, if it did (see store/history.js).
    failure() {
      return this.$store.state.history.failures.find(({ GameID }) => GameID === null || GameID === Number(this.GameID)) || null
    },

    // The copies kept before earlier restores, newest first. Only this page changes them, so they are read once and again after a restore, not at every snapshot.
    keptBackupList() {
      // eslint-disable-next-line no-unused-expressions
      this.backupKept

      return keptBackups(campaignStorage(this.config)).map(({ at, label }) => ({ at, label }))
    },

    // The restore that did not finish, if any: its kept history stays until that restore is finished or abandoned. `id` is what an action on it names, so it never acts on another restore that took its place; `problem` is why the kept history cannot be read back, when it cannot.
    unfinishedBackup() {
      // eslint-disable-next-line no-unused-expressions
      this.backupKept

      const held = unfinishedRestore(campaignStorage(this.config))

      return held ? { id: held.id, at: held.at, label: held.label, problem: unfinishedProblem(held) } : null
    },

    // Every snapshot recorded for the race; the CSV and Clear work on these.
    allSnapshots() {
      return this.record && Array.isArray(this.record.snapshots) ? this.record.snapshots : []
    },

    // The first game time shown: `span` years before the latest snapshot, or the start.
    since() {
      return this.span && this.allSnapshots.length ? this.allSnapshots[this.allSnapshots.length - 1].t - this.span * SECONDS_PER_YEAR : -Infinity
    },

    // The snapshots in the chosen span, for the tiles, charts and table.
    snapshots() {
      return this.allSnapshots.filter((snapshot) => snapshot.t >= this.since)
    },

    latest() {
      return this.snapshots[this.snapshots.length - 1]
    },

    // What the recording covers, labelled for the header: first and latest game dates, the span between them and how much of the chosen window it fills. Null when nothing is recorded.
    recording() {
      const coverage = recordedSpan(this.allSnapshots, this.span * SECONDS_PER_YEAR)

      if (!coverage.count) {
        return null
      }

      if (coverage.count === 1) {
        return { headline: `1 snapshot, ${this.date(coverage.first)}. No span is recorded yet, and nothing earlier was observed.`, note: '' }
      }

      const years = (seconds) => (seconds / SECONDS_PER_YEAR).toFixed(1)
      const dates = `${this.date(coverage.first)} to ${this.date(coverage.last)}`
      const covered = this.span ? `${years(coverage.covered)} of ${this.span} years recorded${coverage.inWindow < coverage.count ? `, ${coverage.inWindow} of ${coverage.count} snapshots in this window` : ''}` : `${years(coverage.seconds)} years recorded`

      return {
        headline: `${coverage.count} snapshots, ${dates}: ${covered}.`,
        note: `Game time before the first snapshot was never observed by the app and cannot be rebuilt, since snapshots keep only aggregate figures. Gaps between snapshots are expected: one is taken per save while the app is open, and past ${MAX_SNAPSHOTS} snapshots the older ones are thinned to every other one, so older stretches can be coarser than recent ones.`,
      }
    },

    // Whether the game's start year is known, which the calendar year of a snapshot needs.
    yearKnown() {
      return isKnownNumber(this.StartYear)
    },

    timeAxis() {
      return this.yearKnown ? ofRule({ rule: 'history.timeAxis', value: Number(this.StartYear), inputs: { present: ['start year'] } }) : unavailable({ rule: 'history.timeAxis', missing: ['start year'] })
    },

    tiles() {
      const first = this.snapshots[0]
      const last = this.latest
      const since = this.date(first.t)
      // The change from the first snapshot of the window to the latest: its note and its result.
      const change = (key, format) => {
        if (this.snapshots.length < 2) {
          return { note: 'First snapshot', result: null }
        }

        const result = changeResult(snapshotResult(first, key), snapshotResult(last, key))

        return result.value === null ? { note: `Change since ${since} unavailable: no ${result.inputs.missing.join(' or ')}`, result } : { note: `${result.value >= 0 ? '+' : '−'}${format(Math.abs(result.value))} since ${since}`, result }
      }
      const tile = (label, result, text, note, moved = null) => ({ label, value: text, note, title: [describeResult(result), moved ? describeResult(moved) : ''].filter(Boolean).join(' | ') })
      const population = snapshotResult(last, 'population')
      const treasury = snapshotResult(last, 'wealth')
      const research = snapshotResult(last, 'research')
      const fleet = fleetResult(last)
      const populationChange = change('population', people)
      const treasuryChange = change('wealth', compact)
      const researchChange = change('research', (value) => withUnit(compact(value), 'RP'))

      return [
        tile('Population', population, people(population.value), populationChange.note, populationChange.result),
        tile('Treasury', treasury, compact(treasury.value), treasuryChange.note, treasuryChange.result),
        tile('Fleet tonnage', fleet, withUnit(compact(fleet.value), 't'), `${withUnit(compact(valueOrNull(snapshotResult(last, 'militaryTons'))), 't')} military, ${withUnit(compact(valueOrNull(snapshotResult(last, 'commercialTons'))), 't')} commercial`),
        tile('Research', research, withUnit(compact(research.value), 'RP'), researchChange.note, researchChange.result),
      ]
    },

    installationOptions() {
      const ids = new Set()

      this.snapshots.forEach((snapshot) => Object.keys(snapshot.installations || {}).forEach((id) => ids.add(Number(id))))

      return [...ids].map((id) => ({ value: id, text: this.installationNames[id] || `Installation ${id}` })).sort((a, b) => a.text.localeCompare(b.text))
    },

    // The installation types of the latest snapshot ranked by amount; a type with no stored amount is not ranked.
    installationRanking() {
      const entries = Object.entries((this.latest && this.latest.installations) || {})
      const ranked = entries.filter(([, amount]) => isKnownNumber(amount)).sort((a, b) => b[1] - a[1])

      return { ranked, unranked: entries.length - ranked.length }
    },

    chosenInstallations() {
      return this.installationIds ? this.installationIds : this.installationRanking.ranked.slice(0, DEFAULT_INSTALLATIONS).map(([id]) => Number(id))
    },

    // What the default choice of installation types leaves out: types tied with the last one shown, and types with no stored amount.
    installationNotes() {
      const { ranked, unranked } = this.installationRanking
      const notes = []

      if (this.installationIds) {
        return notes
      }

      if (ranked.length > DEFAULT_INSTALLATIONS && ranked[DEFAULT_INSTALLATIONS - 1][1] === ranked[DEFAULT_INSTALLATIONS][1]) {
        notes.push(`Types tied with the ${DEFAULT_INSTALLATIONS}th by amount are not shown by default; pick them above.`)
      }

      if (unranked) {
        notes.push(`${unranked} installation ${unranked === 1 ? 'type has' : 'types have'} no stored amount in the latest snapshot and ${unranked === 1 ? 'is' : 'are'} not ranked.`)
      }

      return notes
    },

    // The mineral comparison: the minerals picked over the snapshots of the chosen span, with the baseline of each (the first snapshot of the span).
    mineralComparison() {
      return compareMinerals(this.snapshots, this.mineralIds)
    },

    // The mineral chart on the scale chosen. Each mineral is drawn in the colour of its ID, whichever others are picked. On the percent scale a mineral whose change from its baseline is undefined has no line, and says why.
    mineralChart() {
      const palette = this.theme.categorical
      const percent = this.mineralScale === 'percent'
      const scale = MINERAL_SCALES.find((option) => option.value === this.mineralScale)
      const { series } = this.mineralComparison
      const drawn = series.filter((entry) => !percent || entry.normalisation.defined)
      const options = this.options({ y: percent ? percentTick : (value) => `${compact(value)} t` })
      const signed = (value) => `${value >= 0 ? '+' : '−'}${this.count(Math.abs(value), 1)} %`

      options.scales.y.title = { display: true, text: scale.axis }
      options.plugins.tooltip.callbacks.label = (item) => {
        const name = item.dataset.label
        const stock = item.raw ? item.raw.stock : null

        if (!isKnownNumber(item.parsed.y)) {
          return `${name}: ${UNKNOWN_TEXT}`
        }

        return percent ? `${name}: ${signed(item.parsed.y)} (${this.count(stock, 0)} t)` : `${name}: ${this.count(item.parsed.y, item.parsed.y < 100 ? 1 : 0)} t`
      }

      if (percent) {
        options.plugins.guides = { levels: [{ y: 0 }] }
      }

      const notes = [
        ...(this.mineralIds.length ? [] : ['Pick a mineral above to draw its stockpile.']),
        ...(percent && this.mineralIds.length ? ['Change is measured from each mineral\'s stock in the first snapshot of the span chosen above, so another span has another baseline.'] : []),
        ...(percent ? series.filter((entry) => entry.baseline).map((entry) => (entry.normalisation.defined ? `${entry.name}: baseline ${this.count(entry.baseline.stock, 0)} t, at ${this.date(entry.baseline.t)}.` : `${entry.name}: change undefined, so no line is drawn, because ${entry.normalisation.reason} (${this.date(entry.baseline.t)}).`)) : []),
      ]

      return {
        key: 'minerals',
        title: 'Mineral stockpiles',
        rules: ['history.stockpile', 'history.mineralChange'],
        summary: 'Stockpiles of the selected minerals over time, in tonnes or as the percent change from the first snapshot of the span, to spot shortages and surpluses before they hold up production and to compare how fast the minerals move. Each mineral keeps its own colour.',
        compare: { scales: MINERAL_SCALES, resetDisabled: this.span === 0, csvDisabled: !this.mineralIds.length || !this.snapshots.length },
        picker: {
          model: this.mineralIds,
          options: MINERALS.map((mineral) => {
            const style = mineralStyle(palette, mineral.id)
            const entry = series.find((candidate) => candidate.id === mineral.id)
            const undefinedChange = percent && !!entry && !entry.normalisation.defined

            return { value: mineral.id, text: mineral.name, color: style.color, dash: style.dash, flag: undefinedChange ? 'undefined' : '', title: undefinedChange ? `Change from the baseline is undefined: ${entry.normalisation.reason}` : undefined }
          }),
          change: this.setMinerals,
        },
        extraNotes: notes,
        data: {
          datasets: drawn.map((entry) => {
            const style = mineralStyle(palette, entry.id)

            return {
              label: entry.name,
              data: entry.samples.map((sample, position) => ({ x: this.year(sample.t), y: percent ? entry.percent[position] : sample.stock, stock: sample.stock })),
              borderColor: style.color,
              backgroundColor: withAlpha(style.color, 0.1),
              borderDash: style.dash,
              borderWidth: 2,
              pointRadius: this.snapshots.length > 40 ? 0 : 3,
              pointHoverRadius: 4,
              tension: 0,
            }
          }),
        },
        options,
      }
    },

    charts() {
      const palette = this.theme.categorical
      const line = (label, values, index, axis = 'y') => ({
        label,
        data: this.snapshots.map((snapshot, position) => ({ x: this.year(snapshot.t), y: values[position] })),
        borderColor: palette[index % palette.length],
        backgroundColor: withAlpha(palette[index % palette.length], 0.1),
        borderWidth: 2,
        pointRadius: this.snapshots.length > 40 ? 0 : 3,
        pointHoverRadius: 4,
        tension: 0,
        yAxisID: axis,
      })
      const pick = (key) => this.snapshots.map((snapshot) => valueOrNull(snapshotResult(snapshot, key)))

      const charts = [
        {
          key: 'population',
          title: 'Population',
          rules: ['history.population', 'history.colonies'],
          summary: 'How the population and number of colonies have grown over the years, to show whether the expansion keeps pace.',
          data: { datasets: [line('Population', pick('population'), 0), line('Colonies', pick('colonies'), 1, 'y1')] },
          options: this.options({ y: people, y1: (value) => `${value}` }),
        },
        {
          key: 'wealth',
          title: 'Wealth',
          rules: ['history.treasury', 'history.income'],
          summary: 'The treasury and annual income over time, to show whether the race is saving, spending or running short.',
          data: { datasets: [line('Treasury', pick('wealth'), 0), line('Annual income', pick('income'), 1, 'y1')] },
          options: this.options({ y: compact, y1: compact }),
        },
        {
          key: 'fleet',
          title: 'Fleet tonnage',
          rules: ['history.fleetTonnage'],
          summary: 'The military and commercial tonnage fielded over time, to show how the fleet has grown or shrunk.',
          data: { datasets: [line('Military', pick('militaryTons'), 0), line('Commercial', pick('commercialTons'), 1)] },
          options: this.options({ y: (value) => `${compact(value)} t` }),
        },
        {
          key: 'research',
          title: 'Research and exploration',
          rules: ['history.research', 'history.systems'],
          summary: 'The research output and the number of systems known over time, to show how fast the race advances and explores.',
          data: { datasets: [line('Research (RP)', pick('research'), 0), line('Known systems', pick('systems'), 1, 'y1')] },
          options: this.options({ y: compact, y1: (value) => `${value}` }),
        },
        this.mineralChart,
        {
          key: 'installations',
          title: 'Installations',
          rules: ['history.installations'],
          summary: 'How many installations of the selected types have been built over time, to track industrial growth.',
          picker: { model: this.chosenInstallations, options: this.installationOptions, change: this.setInstallations },
          extraNotes: this.installationNotes,
          data: { datasets: this.chosenInstallations.map((id, index) => line(this.installationNames[id] || `Installation ${id}`, this.snapshots.map((snapshot) => valueOrNull(installationResult(snapshot, id, this.installationNames[id] || `installation ${id}`))), index)) },
          options: this.options({ y: compact }),
        },
        {
          key: 'logistics',
          title: 'Fuel and maintenance supplies',
          rules: ['history.stockpile'],
          summary: 'The fuel and maintenance supply stocks over time, to show whether the fleets can keep operating.',
          data: { datasets: [line('Fuel (L)', pick('fuel'), 0), line('MSP', pick('msp'), 1, 'y1')] },
          options: this.options({ y: (value) => `${compact(value)} L`, y1: compact }),
        },
      ]

      // A snapshot with no figure for a series leaves a gap in its line; each series says how many.
      return charts.map((chart) => ({ ...chart, notes: [...chart.data.datasets.map((dataset) => [dataset.label, dataset.data.filter((point) => point.y === null).length]).filter(([, missing]) => missing).map(([label, missing]) => `${label}: ${missing} of ${this.snapshots.length} snapshots have no figure, so the line breaks there.`), ...(chart.extraNotes || [])] }))
    },

    // Every recorded race in the game on one metric, players first; only in spy mode.
    rivals() {
      const races = this.spyNPR && this.gameHistory && this.gameHistory.races ? Object.entries(this.gameHistory.races).filter(([, record]) => record.snapshots && record.snapshots.length).sort(([a, first], [b, second]) => Number(!!first.npr) - Number(!!second.npr) || Number(a) - Number(b)) : []

      if (races.length < 2) {
        return null
      }

      const metric = RIVAL_METRICS.find((option) => option.value === this.rivalMetric) || RIVAL_METRICS[0]
      const palette = this.theme.categorical
      const datasets = races.map(([RaceID, record], index) => {
        const selected = Number(RaceID) === Number(this.RaceID)
        const color = palette[index % palette.length]

        return {
          label: record.raceName || `Race ${RaceID}`,
          data: record.snapshots.filter((snapshot) => snapshot.t >= this.since).map((snapshot) => ({ x: this.year(snapshot.t), y: valueOrNull(metric.result(snapshot)) })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          borderWidth: selected ? 3 : 1.5,
          borderDash: index >= palette.length ? [6, 4] : [],
          pointRadius: record.snapshots.length > 40 ? 0 : 2,
          pointHoverRadius: 4,
          tension: 0,
        }
      })

      return { rule: metric.rule, data: { datasets }, options: this.options({ y: metric.format }, metric.format) }
    },

    tableHeaders() {
      return [{ text: 'Date', value: 'date' }, ...MEASURES.map(({ value, text, rule }) => ({ text, value, rule, align: 'end' }))]
    },

    // Each row keeps the numbers behind its cells (null when unknown) and the result of each figure.
    tableRows() {
      return this.snapshots.slice().reverse().map((snapshot) => {
        const results = Object.fromEntries(MEASURES.map(({ value }) => [value, snapshotResult(snapshot, value)]))

        return { t: snapshot.t, date: this.date(snapshot.t), results, ...Object.fromEntries(MEASURES.map(({ value }) => [value, valueOrNull(results[value])])) }
      })
    },
  },
  watch: {
    // Another campaign or branch: the picked branch belonged to the last one.
    'resolved.campaignId'() {
      this.branchChoice = null
    },
  },
  created() {
    this.spyNPR = this.config.get('spyNPR', false)
  },
  methods: {
    count(value, decimals = 0) {
      return countText(value, decimals, this.separator)
    },
    // Sorts the table by the numbers behind its cells, a snapshot by its time, and an unknown figure last in either direction.
    sortRows(items, sortBy, sortDesc) {
      const [by] = sortBy

      if (!by) {
        return items
      }

      const key = by === 'date' ? 't' : by
      const direction = sortDesc[0] ? -1 : 1

      return items.slice().sort((a, b) => {
        const x = a[key]
        const y = b[key]

        if (x === y) {
          return 0
        }

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return Number.isFinite(x) ? -1 : 1
        }

        return (x - y) * direction
      })
    },
    // The calendar year of a game time; without a start year, the game years elapsed.
    year(seconds) {
      return (this.yearKnown ? Number(this.StartYear) : 0) + seconds / SECONDS_PER_YEAR
    },
    date(seconds) {
      return this.yearKnown ? gameTime(this.StartYear, seconds).format('YYYY-MM-DD') : `${roundToDecimal(seconds / SECONDS_PER_YEAR, 2)} y elapsed`
    },
    options(axes, labelFormat = null) {
      const scales = {
        x: { type: 'linear', title: { display: true, text: this.yearKnown ? 'Year' : 'Game years elapsed' }, ticks: { callback: (value) => `${roundToDecimal(value, 2)}` } },
        y: { ticks: { callback: axes.y } },
      }

      if (axes.y1) {
        scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: axes.y1 } }
      }

      return {
        scales,
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => this.date((items[0].parsed.x - (this.yearKnown ? Number(this.StartYear) : 0)) * SECONDS_PER_YEAR),
              label: (item) => `${item.dataset.label}: ${labelFormat ? labelFormat(item.parsed.y) : this.count(item.parsed.y, item.parsed.y < 100 ? 1 : 0)}`,
            },
          },
        },
      }
    },
    // The minerals picked, kept in the order of their IDs so that the order of picking changes nothing.
    setMinerals(ids) {
      this.mineralIds = MINERALS.map((mineral) => mineral.id).filter((id) => ids.includes(id))
    },
    // The span goes back to every retained snapshot; the minerals picked and the scale stay as they are.
    resetMineralRange() {
      this.span = 0
    },
    downloadMineralCsv() {
      const csv = comparisonCsv({ comparison: this.mineralComparison, scale: this.mineralScale, palette: this.theme.categorical, date: (seconds) => this.date(seconds) })

      this.saveCsv(csv, `${(this.record.raceName || 'race').replace(/[^\w-]+/g, '_')}-minerals-${this.mineralScale}.csv`)
    },
    saveCsv(csv, fileName) {
      this.saveFile(csv, fileName, 'text/csv')
    },
    saveFile(text, fileName, type) {
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([text], { type }))
      link.download = fileName
      link.click()
      URL.revokeObjectURL(link.href)
    },
    setInstallations(ids) {
      this.installationIds = ids
    },
    // Remove this race from the shown branch's history file; other races keep theirs. The race and branch are the ones shown when the player confirms, taken before any wait for the registry lock.
    async clearHistory() {
      const target = this.resolved ? { campaignId: this.resolved.campaignId, branchId: this.shownBranchId, RaceID: this.RaceID } : null

      this.confirmClear = false

      if (!target) {
        return
      }

      try {
        await clearRaceHistory(target)
        this.cleared++
      } catch (error) {
        this.campaignError = `The history could not be cleared: ${error.message}`
      }
    },
    // The game, campaign and branch the recorder settled the open save to, the branch picked on this page and the branch an attachment goes to, null until settled: what an answer on this page is given for. The settled branch is only compared (the save stays where the recorder put it); the picked one is what an attach of a history targets.
    shown() {
      const resolved = this.resolved

      return resolved ? { GameID: Number(this.GameID), campaignId: resolved.campaignId, branchId: resolved.branchId, generation: resolved.generation, picked: this.branchChoice, attachTo: this.shownBranchId } : null
    },
    // The campaign changed on this page: the pages re-read, and the recorder's answer for the game follows it when the recorder still has the game where the answer was given (the answer waited for the registry lock, and the player may have moved on). The branch picked on this page is reset only when it is still the one picked at the click.
    campaignChanged(resolution, given, resetBranch = false) {
      const now = this.shown()

      if (now && now.GameID === given.GameID && now.campaignId === given.campaignId && now.branchId === given.branchId && now.generation === given.generation) {
        this.$store.commit('history/resolved', { GameID: given.GameID, resolution: { ...this.resolved, ...resolution, pending: [] }, generation: given.generation })

        if (resetBranch && this.branchChoice === given.picked) {
          this.branchChoice = null
        }

        this.campaignError = ''
      }

      this.$store.commit('history/recorded')
      this.campaignChanges++
    },
    // The open save's campaign is the candidate's (or a branch of it): merge into the branch, or keep as a branch of its own.
    async attachCurrent(candidate, mode) {
      const given = this.shown()

      if (!given) {
        return
      }

      try {
        const result = await withRegistry(() => attach(campaignStorage(this.config), { from: { campaignId: given.campaignId }, to: { campaignId: candidate.campaignId, branchId: candidate.branchId }, mode }))

        this.campaignChanged(result, given, true)
      } catch (error) {
        this.campaignError = `The history could not be attached: ${error.message}`
      }
    },
    // The open save is a campaign of its own; the question is closed and nothing is written to the candidates.
    async keepCurrentSeparate() {
      const given = this.shown()

      if (!given) {
        return
      }

      try {
        await withRegistry(() => keepSeparate(campaignStorage(this.config), given.campaignId))
        this.campaignChanged({}, given)
      } catch (error) {
        this.campaignError = `The answer could not be kept: ${error.message}`
      }
    },
    // A history kept from before campaigns were recorded joins this campaign's branch, or becomes a branch of its own under it.
    async attachPool(entry, mode) {
      const given = this.shown()

      if (!given) {
        return
      }

      try {
        await withRegistry(() => attach(campaignStorage(this.config), { from: { poolId: entry.id }, to: { campaignId: given.campaignId, branchId: given.attachTo }, mode }))
        this.campaignChanged({}, given)
      } catch (error) {
        this.campaignError = `The history could not be attached: ${error.message}`
      }
    },
    downloadCsv() {
      const names = Object.fromEntries(this.installationOptions.map((option) => [option.value, option.text]))
      const installationIds = Object.keys(names).map(Number)
      const header = ['GameTime', 'Date', 'Population (M)', 'Colonies', 'Treasury', 'Annual income', 'Fuel (L)', 'MSP', ...MINERALS.map((mineral) => `${mineral.name} (t)`), 'Military ships', 'Military tons', 'Commercial ships', 'Commercial tons', 'Research (RP)', 'Known systems', 'Commanders', ...installationIds.map((id) => names[id]), 'Figures not recorded']
      const quote = (value) => (typeof value === 'string' && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
      // A figure that was not recorded is an empty cell, never 0; the last column names every one of them, the stockpiles and installations included.
      const rows = this.allSnapshots.map((snapshot) => {
        const results = [...['population', 'colonies', 'wealth', 'income', 'fuel', 'msp'].map((key) => snapshotResult(snapshot, key)), ...MINERALS.map((mineral) => mineralResult(snapshot, mineral.id, mineral.name)), ...['militaryShips', 'militaryTons', 'commercialShips', 'commercialTons', 'research', 'systems', 'commanders'].map((key) => snapshotResult(snapshot, key)), ...installationIds.map((id) => installationResult(snapshot, id, names[id]))]

        return [snapshot.t, this.date(snapshot.t), ...results.map(valueOrNull), results.filter((result) => !isAvailable(result)).flatMap((result) => result.inputs.missing).join('; ')]
      })
      const csv = [header, ...rows].map((row) => row.map(quote).join(',')).join('\n')

      this.saveCsv(csv, `${(this.record.raceName || 'race').replace(/[^\w-]+/g, '_')}-history.csv`)
    },
    // The adapter the backup reads and restores the planners' annotations through: { adapter, error }, the adapter null with the reason when the records cannot be opened here. The modules load when a backup is made or read, so the page doesn't carry them otherwise.
    async backupAnnotations() {
      try {
        const [records, tech, briefs] = await Promise.all([import('../utilities/scenario-records'), import('../utilities/tech-scenarios'), import('../utilities/mission-briefs')])

        tech.registerTechScenarios(records.registerAdapter)
        briefs.registerBriefs(records.registerAdapter)

        return { adapter: annotationsOf(records.openScenarioRecords(), records.scenarioStorage()), error: null }
      } catch (error) {
        return { adapter: null, error: error.message }
      }
    },
    stamp(milliseconds) {
      return new Date(milliseconds).toLocaleString()
    },
    statusText(status) {
      return { new: 'New here', known: 'Already recorded', conflict: 'Different galaxy', ambiguous: 'Possibly a campaign already recorded' }[status] || status
    },
    statusColor(status) {
      return status === 'conflict' || status === 'ambiguous' ? 'warning' : undefined
    },
    relationText(file) {
      return { same: 'same timeline', extends: 'the backup is further along', behind: 'the stored one is further along', different: 'a different timeline', unknown: 'timeline cannot be told', new: 'new branch' }[file.relation] || ''
    },
    // What the backup would do to a campaign record, in words.
    changesText(item) {
      const { association } = item
      const parts = [['names', 'names'], ['gameIds', 'game ids'], ['attachments', 'saved paths'], ['branches', 'branches'], ['tips', 'later tips'], ['anchor', 'anchor']].filter(([key]) => association.added[key]).map(([key, text]) => `${association.added[key]} ${text}`)

      return association.policy === 'keep' ? 'Left as stored' : item.status === 'new' || item.status === 'ambiguous' ? 'Adds this campaign as a record of its own' : parts.length ? `Adds ${parts.join(', ')}` : 'Nothing to add'
    },
    // The preview's totals in words.
    totalsText(totals) {
      const plural = (amount, noun) => `${this.count(amount)} ${noun}${amount === 1 ? '' : 's'}`
      const parts = [`adds ${plural(totals.added, 'snapshot')}`, `meets ${plural(totals.conflicts, 'conflict')} at a shared game time (Merge keeps the stored snapshot, Replace takes the backup's)`, `drops ${plural(totals.removed, 'stored snapshot')} under Replace`, `restores ${plural(totals.annotations, 'annotation')}`, `changes ${plural(totals.registry, 'campaign record')}`]

      return `Applying ${parts.join('; ')}. A copy of what it touches is kept first.`
    },
    // A file of the stored campaigns (all, or the one this save belongs to) with their branches, race and intelligence history and annotations, saved by the browser.
    async exportBackup(all) {
      this.backupBusy = true
      this.backupError = ''
      this.backupResult = ''

      try {
        const { adapter, error } = await this.backupAnnotations()
        const envelope = buildBackup(campaignStorage(this.config), { campaignIds: all ? null : [this.resolved.campaignId], at: Date.now(), annotations: adapter })
        const name = backupFileName(envelope)

        this.saveFile(JSON.stringify(envelope), name, 'application/json')
        this.backupResult = `Exported ${envelope.campaigns.length === 1 ? 'one campaign' : `${envelope.campaigns.length} campaigns`} as ${name}.${adapter ? '' : ` The annotations are not in it: ${error}.`}`
      } catch (error) {
        this.backupError = `The backup could not be made: ${error.message}`
      } finally {
        this.backupBusy = false
      }
    },
    // Reads a backup file and previews it. A file that is too large, damaged, altered or of a newer version is refused here, with nothing previewed and nothing changed.
    async readBackup(file) {
      this.backupEnvelope = null
      this.backupPlan = null
      this.backupChoices = null
      this.backupConfirmed = false
      this.backupErrors = []
      this.backupError = ''
      this.backupResult = ''

      if (!file) {
        return
      }

      this.backupFile = file.name

      if (file.size > MAX_BYTES) {
        this.backupErrors = [`The file is larger than ${MAX_BYTES / (1024 * 1024)} MB, the most a backup is read at`]

        return
      }

      this.backupBusy = true

      try {
        const read = parseBackup(await file.text())

        if (read.errors) {
          this.backupErrors = read.errors

          return
        }

        this.backupEnvelope = Object.freeze(read.envelope)
        this.backupChoices = defaultChoices(read.envelope)
        await this.planBackup()
      } catch (error) {
        this.backupErrors = [`The file could not be read: ${error.message}`]
      } finally {
        this.backupBusy = false
      }
    },
    // What applying the envelope with the current choices would do, read from the stores as they are now; nothing is written.
    async planBackup() {
      try {
        const { adapter } = await this.backupAnnotations()
        const planned = planRestore({ io: campaignStorage(this.config), envelope: this.backupEnvelope, choices: this.backupChoices, annotations: adapter })

        this.backupPlan = Object.freeze({ preview: Object.freeze(planned.preview), digest: planned.digest })
      } catch (error) {
        this.backupPlan = null
        this.backupError = `The backup could not be previewed: ${error.message}`
      }
    },
    // A choice made for one campaign: the preview is made again, and an earlier confirmation no longer stands.
    async chooseBackup(id, change) {
      change(this.backupChoices.campaigns[id])
      this.backupConfirmed = false
      this.backupError = ''
      this.backupResult = ''
      await this.planBackup()
    },
    chooseAssociation(id, value) {
      return this.chooseBackup(id, (choice) => { choice.association = value })
    },
    choosePolicy(id, branchId, value) {
      return this.chooseBackup(id, (choice) => { choice.files[branchId].policy = value })
    },
    chooseRaces(id, branchId, value) {
      return this.chooseBackup(id, (choice) => { choice.files[branchId].races = value.length ? value : null })
    },
    chooseAnnotations(id, value) {
      return this.chooseBackup(id, (choice) => { choice.annotations = value })
    },
    // Applies what the preview showed, once the registry lock is held. A plan that changed since is refused and previewed again; one that stopped part way is applied again to finish.
    async applyBackup() {
      if (!this.backupEnvelope || !this.backupPlan || this.backupBusy) {
        return
      }

      this.backupBusy = true
      this.backupError = ''
      this.backupResult = ''

      try {
        const { adapter } = await this.backupAnnotations()
        const result = await withRegistry(() => applyRestore({ io: campaignStorage(this.config), envelope: this.backupEnvelope, choices: this.backupChoices, expected: this.backupPlan.digest, confirmed: this.backupConfirmed, annotations: adapter }))

        this.backupResult = result.applied ? `Restored ${result.files} history ${result.files === 1 ? 'file' : 'files'} and ${result.imports} ${result.imports === 1 ? 'annotation' : 'annotations'}${result.registry ? ', and updated the campaign records' : ''}. A copy of what it touched is kept below.` : result.backup ? 'The unfinished restore is finished: what the backup holds is stored. Its kept history is among the copies below.' : 'Nothing was restored: what the backup holds is stored already.'
        this.$store.commit('history/recorded')
        this.campaignChanges++
        this.backupKept++
        this.backupConfirmed = false
        await this.planBackup()
      } catch (error) {
        this.backupError = error instanceof Changed || error instanceof Rejected ? error.message : unfinishedRestore(campaignStorage(this.config)) ? `The restore did not finish: ${error.message}. The history it began with is kept; apply it again with the same choices to finish it.` : `The restore was not applied: ${error.message}`
        this.backupKept++
        this.backupConfirmed = false
        await this.planBackup()
      } finally {
        this.backupBusy = false
      }
    },
    // Drops the file and the preview. Nothing was written.
    cancelBackup() {
      this.backupEnvelope = null
      this.backupPlan = null
      this.backupChoices = null
      this.backupConfirmed = false
      this.backupErrors = []
      this.backupError = ''
      this.backupResult = ''
      this.backupInput++
    },
    // A kept copy is named by the time it was kept, whatever it holds, and a copy that cannot be serialized or saved is reported.
    downloadCopy(entry) {
      this.backupError = ''

      try {
        this.saveFile(JSON.stringify(entry.envelope), recoveryFileName(entry), 'application/json')
      } catch (error) {
        this.backupError = `The kept history could not be downloaded: ${error.message}`
      }
    },
    downloadKept(at) {
      const entry = keptBackups(campaignStorage(this.config)).find((item) => item.at === at)

      if (entry) {
        this.downloadCopy(entry)
      }
    },
    downloadUnfinished() {
      const shown = this.unfinishedBackup
      const entry = unfinishedRestore(campaignStorage(this.config))

      if (entry && shown && entry.id === shown.id) {
        this.downloadCopy(entry)
      } else {
        this.backupError = 'The unfinished restore shown is no longer the one kept, so nothing was downloaded. The one kept now is shown.'
        this.backupKept++
      }
    },
    // Stops treating the restore shown as unfinished: its kept history is filed with the others and no file changes. The restore is named by its id, so one that took its place since is left alone and shown.
    async abandonBackup() {
      const shown = this.unfinishedBackup

      if (this.backupBusy || !shown) {
        return
      }

      this.backupBusy = true
      this.backupError = ''
      this.backupResult = ''

      try {
        const filed = await withRegistry(() => abandonRestore(campaignStorage(this.config), shown.id))

        this.backupResult = filed ? 'The unfinished restore was abandoned. The history it began with is among the copies kept below.' : 'No restore is unfinished any more.'
      } catch (error) {
        this.backupError = `The restore could not be abandoned: ${error.message}`
      } finally {
        this.backupKept++
        this.backupBusy = false
      }
    },
  },
  asyncComputed: {
    installationNames: {
      async get() {
        if (!this.database) {
          return {}
        }

        const rows = await this.database.query('select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name from DIM_PlanetaryInstallation').then(([items]) => items)

        return Object.fromEntries(rows.map((row) => [row.PlanetaryInstallationID, row.Name]))
      },
      default: {},
    },
  },
}
</script>

<style lang="scss">
.history-page {
  td {
    font-variant-numeric: tabular-nums;
  }

  .history-campaign__path .path {
    word-break: break-all;
  }

  .history-compare {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .history-backup__actions {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 8px;
  }

  .history-backup__file {
    flex: 1 1 260px;
    max-width: 360px;
  }

  .history-backup__row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .history-backup__label {
    min-width: 130px;
  }

  .history-backup__campaign {
    border-top: 1px solid rgba(128, 128, 128, 0.3);
    padding-top: 8px;
  }

  .history-backup__races {
    min-width: 180px;
  }

  .history-backup__locked {
    opacity: 0.6;
  }

  .history-backup__detail td {
    height: auto !important;
    padding-bottom: 6px !important;
  }

  .history-backup__kept {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
  }
}
</style>
