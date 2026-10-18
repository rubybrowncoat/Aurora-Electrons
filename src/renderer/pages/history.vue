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
          <div v-if="recording" class="history-recording-note" data-recording-sampling>{{ recording.sampling }}</div>
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
          <v-btn small text :disabled="!allSnapshots.length" class="ml-2" title="Every retained snapshot and every series, whatever the span and the view, with the figures not recorded and the sampling notes. The CSV under each chart holds only what that chart shows." @click="downloadCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
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
            <chart-canvas type="line" :data="rivals.data" :options="rivals.options" :height="280" label="Rivals" data-chart="rivals" />
            <div class="history-export mt-1">
              <v-btn x-small text :disabled="exportEmpty(rivals)" title="Download the races, window and annotations this chart shows now as a CSV, in spy mode: exact game times, units, rules and what was not recorded" @click="downloadChartCsv(rivals.key)"><v-icon x-small left>mdi-download</v-icon>Shown CSV</v-btn>
              <v-btn x-small text :disabled="exportEmpty(rivals)" title="Save this chart as a PNG with a caption of the races shown, the window, the rules and the limits of the sampling" @click="exportChartPng(rivals.key)"><v-icon x-small left>mdi-image-outline</v-icon>PNG</v-btn>
            </div>
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
                <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="240" :label="chart.title" :data-chart="chart.key" />
                <div v-for="note in chart.notes" :key="note" class="caption text--secondary mt-1">{{ note }}</div>
                <div class="history-export mt-1">
                  <v-btn x-small text :disabled="exportEmpty(chart)" title="Download the series, window and annotations this chart shows now as a CSV: exact game times, units, rules and what was not recorded" @click="downloadChartCsv(chart.key)"><v-icon x-small left>mdi-download</v-icon>Shown CSV</v-btn>
                  <v-btn x-small text :disabled="exportEmpty(chart)" title="Save this chart as a PNG with a caption of the series shown, the window, the rules and the limits of the sampling" @click="exportChartPng(chart.key)"><v-icon x-small left>mdi-image-outline</v-icon>PNG</v-btn>
                </div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-card v-else class="panel" elevation="1">
          <div class="history-export px-4 pt-2">
            <v-btn x-small text :disabled="exportEmpty(tableChart)" title="Download every snapshot of the window, oldest first, as a CSV: exact game times, units, rules and what was not recorded. The page and sort of the table do not apply." @click="downloadChartCsv(tableChart.key)"><v-icon x-small left>mdi-download</v-icon>Shown CSV</v-btn>
          </div>
          <v-data-table :headers="tableHeaders" :items="tableRows" item-key="t" :custom-sort="sortRows" :sort-by.sync="historyTable.sortBy" :sort-desc.sync="historyTable.sortDesc" :items-per-page.sync="historyTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: historyPageSizes }" dense>
            <template v-for="column in tableHeaders" #[`header.${column.value}`]="{ header }">{{ header.text }}<provenance-mark v-if="column.rule" :key="column.value" :rule="column.rule" /></template>
            <template v-for="column in measureColumns" #[`item.${column.value}`]="{ item }">{{ count(item[column.value], column.decimals) }}<provenance-mark v-if="item.results[column.value].status === 'unavailable'" :key="column.value" :result="item.results[column.value]" /></template>
          </v-data-table>
        </v-card>
      </template>

      <v-card class="panel history-milestones" data-summary="Notes pinned to an exact game time, each with a type and, if wanted, a link to a colony, system, fleet, ship or log event. A marker sits at the exact time on every chart whatever the samples are, the nearest sample is shown beside it, and a link to an object that has gone stays on the note as unresolved and is never moved to another object by name." elevation="1">
        <div class="panel-head">
          <span>Milestones</span>
          <span class="caption text--secondary" data-milestone-count>{{ milestoneCaption }}</span>
        </div>
        <div class="panel-body">
          <v-alert v-if="milestoneRead.error" type="warning" outlined dense data-milestone-error>The milestones cannot be read here: {{ milestoneRead.error.message }}</v-alert>
          <v-alert v-else-if="records && records.error" type="info" outlined dense data-milestone-error>The scenario records are not available in this window, so milestones are not kept: {{ records.error }}</v-alert>
          <div v-else-if="!milestoneScope" class="caption text--secondary" data-milestone-waiting>The campaign of this save is not settled yet, so milestones wait for it.</div>
          <div v-else-if="!yearKnown" class="caption text--secondary" data-milestone-waiting>The start year of this game is not known, so a date cannot be turned into a game time.</div>
          <template v-else>
            <div class="history-milestones__form" data-milestone-form>
              <v-text-field v-model="milestoneDraft.date" label="Game date and time" :placeholder="gameDateOfOpen" :error-messages="milestoneTime.ok ? [] : [milestoneTime.error]" :hint="milestoneTimeHint" persistent-hint dense outlined class="history-milestones__date" data-milestone-date />
              <v-select v-model="milestoneDraft.type" :items="milestoneTypes" label="Type" dense outlined hide-details class="history-milestones__type" data-milestone-type />
              <v-text-field v-model="milestoneDraft.text" label="Note" :counter="textLength" dense outlined class="history-milestones__note" data-milestone-text />
              <v-select v-model="milestoneDraft.linkKind" :items="milestoneKindItems" label="Link" dense outlined hide-details class="history-milestones__kind" data-milestone-link-kind @change="milestoneDraft.linkPick = null" />
              <v-autocomplete v-if="milestoneLinkKinds.includes(milestoneDraft.linkKind)" v-model="milestoneDraft.linkPick" :items="milestoneChoices" item-text="text" item-value="id" return-object :label="milestoneLinkLabel" :disabled="!milestoneContext" :hint="milestoneLinkHint" persistent-hint dense outlined clearable class="history-milestones__pick" data-milestone-link-pick @change="pickMilestoneLink" />
              <v-switch v-model="milestoneDraft.branchOnly" label="This branch only" dense hide-details class="history-milestones__policy mt-1" data-milestone-policy />
            </div>
            <div class="history-milestones__actions">
              <v-btn small depressed color="primary" :disabled="milestoneBusy || !milestoneReady" data-milestone-save @click="saveMilestoneDraft(false)">{{ milestoneDraft.uuid ? 'Save changes' : 'Add milestone' }}</v-btn>
              <v-btn v-if="milestoneDraft.uuid" small text :disabled="milestoneBusy" data-milestone-cancel @click="cancelMilestone">Cancel</v-btn>
            </div>
            <v-alert v-if="milestoneConflict" type="warning" outlined dense class="mt-2" data-milestone-conflict>
              <div>This milestone was changed elsewhere after it was opened here. It now reads: {{ milestoneConflict.text }} ({{ milestoneConflict.dateText }}).</div>
              <div class="mt-2">
                <v-btn small depressed color="warning" :disabled="milestoneBusy" data-milestone-overwrite @click="saveMilestoneDraft(true)">Write over it</v-btn>
                <v-btn small text class="ml-2" data-milestone-keep @click="cancelMilestone">Keep what is stored</v-btn>
              </div>
            </v-alert>
            <v-alert v-if="milestoneMessage" :type="milestoneMessageType" outlined dense class="mt-2" data-milestone-message>{{ milestoneMessage }}</v-alert>
          </template>

          <div v-if="milestoneEntries.length" class="mt-3" data-milestone-list>
            <div v-for="entry in milestoneEntries" :key="entry.uuid" class="history-milestones__row" :data-milestone="entry.uuid" :data-milestone-t="entry.t" :data-milestone-drawn="entry.drawn">
              <div class="history-milestones__head">
                <v-chip x-small outlined>{{ entry.typeText }}</v-chip>
                <span class="history-milestones__text">{{ entry.text }}</span>
                <v-chip v-if="entry.link" x-small :color="entry.link.color" :text-color="entry.link.color ? 'white' : undefined" :title="entry.link.reason" :data-link-status="entry.link.status">{{ entry.link.label }}: {{ entry.link.name || entry.link.id }}<template v-if="entry.link.nowNamed"> (now {{ entry.link.nowNamed }})</template> · {{ entry.link.word }}</v-chip>
              </div>
              <div class="caption text--secondary">
                <span data-milestone-exact>{{ entry.dateText }}, game time {{ count(entry.t, entry.t % 1 === 0 ? 0 : 3) }} s</span>
                <span data-milestone-sample> · <template v-if="entry.sample">nearest sample {{ entry.sample.dateText }}, {{ entry.sample.offsetText }}</template><template v-else>no sample recorded yet</template></span>
              </div>
              <div class="caption text--secondary">{{ entry.policy === 'branch' ? 'Kept for this branch only' : 'Kept for every branch of the campaign' }}<template v-if="entry.otherBranch">, made on another branch</template> · {{ entry.drawnText }}</div>
              <div v-if="entry.link && entry.link.status !== 'linked'" class="caption" data-milestone-link-note>{{ entry.link.reason }}<template v-if="entry.link.status === 'changed' || entry.link.status === 'missing'">. Edit the milestone to link it to another object, or leave it as it is.</template></div>
              <div class="history-milestones__actions">
                <v-btn x-small text :disabled="milestoneBusy || !yearKnown" data-milestone-edit @click="editMilestone(entry)">Edit</v-btn>
                <v-btn v-if="entry.ahead" x-small text :disabled="milestoneBusy" title="Keeps its time and moves its place to this save, so it is drawn here" data-milestone-move @click="moveMilestoneHere(entry)">Move to this save</v-btn>
                <v-btn v-if="milestoneConfirm !== entry.uuid" x-small text color="error" :disabled="milestoneBusy" data-milestone-delete @click="milestoneConfirm = entry.uuid">Delete</v-btn>
                <template v-else>
                  <v-btn x-small depressed color="error" :disabled="milestoneBusy" data-milestone-delete-confirm @click="deleteMilestoneEntry(entry)">Delete it</v-btn>
                  <v-btn x-small text data-milestone-delete-cancel @click="milestoneConfirm = null">Keep</v-btn>
                </template>
              </div>
            </div>
          </div>
          <div v-else-if="milestoneScope && yearKnown && !milestoneRead.error" class="caption text--secondary mt-3" data-milestone-empty>No milestones yet for this race{{ milestoneRead.notes.length ? ', apart from ' + milestoneRead.notes.length + ' that this version cannot read' : '' }}.</div>
          <div v-for="note in milestoneRead.notes" :key="note.uuid" class="caption text--secondary mt-1" data-milestone-note>{{ note.reason }}</div>
          <div v-if="milestoneAttached.error" class="caption text--secondary mt-3" data-milestone-attached-error>The milestones of attached campaigns cannot be listed here: {{ milestoneAttached.error.message }}</div>
          <div v-else-if="milestoneAttached.entries.length || milestoneAttached.refused.length" class="mt-4" data-milestone-attached>
            <div class="subtitle-2">From an attached campaign</div>
            <div class="caption text--secondary">These were made in a campaign that is attached to this one. They are listed here and are not drawn on the charts, and the attached campaign keeps its own. Adopting one copies it into this campaign, on this branch.</div>
            <div v-for="entry in milestoneAttached.entries" :key="entry.attachedFrom + entry.uuid" class="history-milestones__row" :data-milestone-attached-uuid="entry.uuid" :data-milestone-t="entry.t">
              <div class="history-milestones__head">
                <v-chip x-small outlined>{{ entry.typeText }}</v-chip>
                <span class="history-milestones__text">{{ entry.text }}</span>
                <v-chip v-if="entry.link" x-small :color="entry.link.color" :text-color="entry.link.color ? 'white' : undefined" :title="entry.link.reason" :data-link-status="entry.link.status">{{ entry.link.label }}: {{ entry.link.name || entry.link.id }}<template v-if="entry.link.nowNamed"> (now {{ entry.link.nowNamed }})</template> · {{ entry.link.word }}</v-chip>
              </div>
              <div class="caption text--secondary">{{ entry.dateText }}, game time {{ count(entry.t, entry.t % 1 === 0 ? 0 : 3) }} s · {{ entry.policy === 'branch' ? 'kept for one branch of its campaign' : 'kept for every branch of its campaign' }}</div>
              <div v-if="entry.link && entry.link.status !== 'linked'" class="caption" data-milestone-link-note>{{ entry.link.reason }}</div>
              <div class="history-milestones__actions">
                <span v-if="entry.adopted" class="caption text--secondary" :data-milestone-adopted-on="entry.adoptedOn.branchId" data-milestone-adopted>Adopted: {{ adoptedText(entry.adoptedOn) }}</span>
                <v-btn v-else x-small text :disabled="milestoneBusy" data-milestone-adopt @click="adoptMilestoneEntry(entry)">Adopt into this campaign</v-btn>
              </div>
            </div>
            <div v-for="source in milestoneAttached.refused" :key="source.campaignId" class="caption text--secondary mt-1" data-milestone-attached-refused>The scenario file of an attached campaign cannot be read ({{ source.message }}), so its milestones are not listed.</div>
          </div>

          <div class="caption text--secondary mt-2" data-milestone-limits>A marker is drawn at the exact game time, not at a sample, and only where the charts have samples on both sides of it. A milestone made at a later game time than this save is listed and not drawn until the save reaches it or it is moved here. A link is checked against this save each time and is never moved to another object by its name: renaming a system, a fleet or a ship leaves it linked and shows the new name, and an object that is gone stays unresolved. A log event is named by its increment, what it says and the place it names, never by the row number SQLite gives it, and one the log holds several times over is ambiguous. A rewound save is a branch: a milestone kept for the campaign shows on every branch, one kept for a branch only on that branch. A save continues the IDs it hands out from the highest it holds, so an ID can come back for another object, after a rewind or after the highest one was destroyed. A link reads linked for a ship, a fleet or a system that has the time it was made or found that it was linked with, which on a branch other than the one the link was made on must also be strictly before the two branches parted; an object that does not give that time is not told by its ID alone. A colony has no date in the save and one body can hold several, so the colony that has the ID can be another one: a link to a colony reads not checked, and changed only where its system, body or species differ.</div>
        </div>
      </v-card>

      <stock-rates :empire-record="record" :colony-record="colonyRecord" :colonies="colonyBudget ? colonyBudget.entries : []" :race-id="RaceID" :race-name="record ? record.raceName || '' : ''" :campaign-id="resolved ? resolved.campaignId : null" :branch-id="shownBranchId" :game-id="GameID" :chart-options="options" :year="year" :date="date" :separator="separator" />

      <colony-series :database="database" :config="config" :game-id="GameID" :race-id="RaceID" :game-time="GameTime" :resolved="resolved" :view="colonyBudget" :cap="retentionView.profile.cap" :date="date" :separator="separator" @changed="colonyChanges++" />

      <v-card class="panel history-retention" data-summary="How many samples this race's history keeps, how far apart they are, whether and when its older half was thinned, and how large the record is, with the colony series and the game log's event archive kept beside it. A retention profile caps the samples one series keeps; it applies only to samples observed or still kept, and never brings back a sample that was thinned. A cap on the events the archive keeps cuts the oldest ones when the race is next captured." elevation="1">
        <div class="panel-head">
          <span>Retention</span>
          <span class="caption text--secondary">{{ retentionView.sampling }}</span>
        </div>
        <div class="panel-body">
          <div class="history-retention__row"><span class="history-retention__label">Samples</span><span class="history-retention__value" data-retention-samples>{{ count(retentionView.stats.count, 0) }} kept for this race; the {{ retentionView.profile.label }} profile keeps at most {{ count(retentionView.profile.cap, 0) }} per series<template v-if="retentionView.over">. This series is above that, and is thinned when the recorder next saves it</template></span></div>
          <div class="history-retention__row"><span class="history-retention__label">Time covered</span><span class="history-retention__value">{{ duration(retentionView.stats.seconds) }}<template v-if="retentionView.stats.first !== null"> ({{ date(retentionView.stats.first) }} to {{ date(retentionView.stats.last) }})</template></span></div>
          <div class="history-retention__row"><span class="history-retention__label">Time between samples</span><span class="history-retention__value" data-retention-gaps>largest {{ duration(retentionView.stats.gaps.largest) }}, typical {{ duration(retentionView.stats.gaps.typical) }}</span></div>
          <div class="history-retention__row"><span class="history-retention__label">Thinning</span><span class="history-retention__value" data-retention-thinning :data-status="retentionView.status">{{ retentionView.thinning }}.</span></div>
          <div class="history-retention__row"><span class="history-retention__label">Size, measured</span><span class="history-retention__value" data-retention-measured>{{ size(retentionView.measured) }} for this race's series, {{ size(retentionView.file) }} for the whole branch file. Measured as compact JSON; the file on disk is larger by its indentation.</span></div>
          <div class="history-retention__row"><span class="history-retention__label">Size, predicted</span><span class="history-retention__value" data-retention-predicted>About {{ size(retentionView.current.bytesAtCap) }} for this series once it holds {{ count(retentionView.profile.cap, 0) }} samples, predicted from the average size of its samples.</span></div>
          <div class="history-retention__row"><span class="history-retention__label">Colony series</span><span class="history-retention__value" data-retention-colonies>{{ colonyBudgetText }}</span></div>
          <div class="history-retention__row"><span class="history-retention__label">Event archive</span><span class="history-retention__value" data-retention-events>{{ eventBudgetText }} Turning it on or off is on the <router-link to="/log">Game Log</router-link> page.</span></div>

          <div class="history-retention__profiles mt-3">
            <table>
              <thead>
                <tr><th>Profile</th><th>Cap per series</th><th>Kept if the stored samples were thinned now</th><th>Largest gap then</th><th>Size if thinned now (predicted)</th><th>Size at the cap (predicted)</th><th /></tr>
              </thead>
              <tbody>
                <tr v-for="option in retentionView.profiles" :key="option.id" :class="{ 'history-retention__active': option.active }" :data-profile="option.id">
                  <td>{{ option.label }}<template v-if="option.active"> (in force)</template></td>
                  <td>{{ count(option.cap, 0) }}</td>
                  <td>{{ count(option.kept, 0) }}<template v-if="option.thins"> ({{ count(option.dropped, 0) }} thinned)</template></td>
                  <td>{{ duration(option.largestGap) }}</td>
                  <td>{{ size(option.bytes) }}</td>
                  <td>{{ size(option.bytesAtCap) }}</td>
                  <td><v-btn x-small outlined :disabled="option.active" :data-retention="option.id" @click="pickRetention(option.id)">Choose</v-btn></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="caption text--secondary mt-2" data-retention-limits>A profile applies only to samples that are observed or still kept. It cannot restore samples that were thinned, and a larger cap brings none back. A smaller cap thins each series when the recorder next saves it, and a series that is not saved again keeps the samples it has. Saves are only read, never changed.</div>

          <v-alert v-if="retentionChange" type="warning" outlined dense class="mt-3" data-retention-confirm>
            <div>Change the retention profile from {{ retentionChange.current.label }} ({{ count(retentionChange.current.cap, 0) }}) to {{ retentionChange.picked.label }} ({{ count(retentionChange.picked.cap, 0) }})?</div>
            <div>{{ retentionChange.text }}</div>
            <div class="mt-2">
              <v-btn small depressed color="warning" data-retention-apply @click="applyRetention">Apply {{ retentionChange.picked.label }}</v-btn>
              <v-btn small text class="ml-2" data-retention-cancel @click="retentionPick = null">Cancel</v-btn>
            </div>
          </v-alert>

          <div class="mt-3" data-event-cap-choice>
            <span class="caption text--secondary mr-2">Cap on the event archive, per race and branch, in every campaign</span>
            <v-btn v-for="cap in eventCaps" :key="cap" x-small outlined class="mr-1" :disabled="cap === eventCap" :data-event-cap="cap" @click="pickEventCap(cap)">{{ count(cap, 0) }}</v-btn>
          </div>

          <v-alert v-if="eventCapChange" type="warning" outlined dense class="mt-3" data-event-cap-confirm>
            <div>Change the cap on the event archive from {{ count(eventCap, 0) }} to {{ count(eventCapChange.cap, 0) }} events?</div>
            <div>{{ eventCapChange.text }}</div>
            <div class="mt-2">
              <v-btn small depressed color="warning" data-event-cap-apply @click="applyEventCap">Apply {{ count(eventCapChange.cap, 0) }}</v-btn>
              <v-btn small text class="ml-2" data-event-cap-cancel @click="eventCapPick = null">Cancel</v-btn>
            </div>
          </v-alert>
        </div>
      </v-card>

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
          <div class="caption text--secondary mt-2">A backup holds the campaign records, the history of every race, what each race knows of the others, the observed-event archive of each branch that keeps one, and the annotations. The unattached history from before campaigns were recorded, the migration record and the settings of each race are not in it. A restore only adds to a campaign record; it never changes an answer already given and never merges two campaigns.</div>

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
            <div class="caption text--secondary">Nothing is written until the restore is applied. Merge keeps what is stored where both have a snapshot at the same game time; Replace takes the backup's and drops stored snapshots it lacks; Keep leaves the target as it is. A branch's colony series are restored under the same policy and races, branch by branch and never merged with another branch's; Replace drops the colony series the backup lacks, except for a backup made before colony series were recorded in it, which says nothing about them. Which colonies are followed is a setting of the race and is not in the backup. A branch's event archive follows the same policy and races: Merge adds the races whose archive is not stored and keeps the stored archive of any other; Replace gives the branch exactly the backup's archive, so the archive of a race the backup lacks is removed, except for a backup made before event archives were recorded in it, which says nothing about them. Which races keep an archive is a setting of the race and is not in the backup.</div>

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
                    <tr v-if="file.locked || file.series.length || file.colonies || file.events" :key="`${file.branchId}-detail`" class="history-backup__detail">
                      <td colspan="11">
                        <div v-if="file.locked" class="caption text--secondary">Kept as stored: {{ file.locked }}.</div>
                        <details v-if="file.series.length">
                          <summary class="caption text--secondary">Every series in branch {{ file.branchId }}, one by one</summary>
                          <div v-for="row in file.series" :key="row.key" class="caption">{{ row.label }}: {{ count(row.stored) }} stored, {{ count(row.backup) }} in the backup, {{ count(row.added) }} added, {{ count(row.identical) }} the same, {{ count(row.conflicts) }} in conflict<template v-if="file.policy === 'replace'">, {{ count(row.removed) }} removed</template><template v-if="row.thinned">, {{ count(row.thinned) }} thinned</template></div>
                        </details>
                        <div v-if="file.colonies" class="caption" data-backup-colonies>Colony series of branch {{ file.branchId }}: {{ file.colonies.status === 'new' ? 'new here' : file.colonies.status === 'changes' ? 'changed' : file.colonies.status === 'unchanged' ? 'stored already' : 'kept as stored' }}; {{ count(file.colonies.totals.stored) }} snapshots stored, {{ count(file.colonies.totals.backup) }} in the backup, {{ count(file.colonies.policy === 'keep' ? 0 : file.colonies.totals.added) }} added, {{ count(file.colonies.totals.identical) }} the same, {{ count(file.colonies.totals.conflicts) }} in conflict<template v-if="file.colonies.policy === 'replace'">, {{ count(file.colonies.totals.removed) }} removed</template><template v-if="file.colonies.totals.thinned">, {{ count(file.colonies.totals.thinned) }} thinned</template><template v-if="file.colonies.locked"> ({{ file.colonies.locked }})</template></div>
                        <details v-if="file.colonies && file.colonies.series.length">
                          <summary class="caption text--secondary">Every colony series in branch {{ file.branchId }}, one by one</summary>
                          <div v-for="row in file.colonies.series" :key="row.key" class="caption">{{ row.label }}: {{ count(row.stored) }} stored, {{ count(row.backup) }} in the backup, {{ count(row.added) }} added, {{ count(row.identical) }} the same, {{ count(row.conflicts) }} in conflict<template v-if="file.colonies.policy === 'replace'">, {{ count(row.removed) }} removed</template><template v-if="row.thinned">, {{ count(row.thinned) }} thinned</template></div>
                        </details>
                        <div v-if="file.events" class="caption" data-backup-events>Event archive of branch {{ file.branchId }}: {{ file.events.status === 'new' ? 'new here' : file.events.status === 'changes' ? 'changed' : file.events.status === 'unchanged' ? 'stored already' : 'kept as stored' }}; {{ count(file.events.totals.stored) }} events stored, {{ count(file.events.totals.backup) }} in the backup, {{ count(file.events.policy === 'keep' ? 0 : file.events.totals.added) }} added, {{ count(file.events.totals.identical) }} the same, {{ count(file.events.totals.conflicts) }} in conflict<template v-if="file.events.policy === 'replace'">, {{ count(file.events.totals.removed) }} removed</template><template v-if="file.events.locked"> ({{ file.events.locked }})</template></div>
                        <details v-if="file.events && file.events.series.length">
                          <summary class="caption text--secondary">Every event archive in branch {{ file.branchId }}, one by one</summary>
                          <div v-for="row in file.events.series" :key="row.key" class="caption">{{ row.label }}: {{ count(row.stored) }} stored, {{ count(row.backup) }} in the backup, {{ count(row.added) }} added, {{ count(row.identical) }} the same, {{ count(row.conflicts) }} in conflict<template v-if="file.events.policy === 'replace'">, {{ count(row.removed) }} removed</template></div>
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
          <v-card-text>This deletes the {{ allSnapshots.length }} snapshots the app has recorded for this race<template v-if="campaignView && campaignView.branches.length > 1"> in branch {{ shownBranchId }}</template>, and the colony series and the event archive kept with them. The colonies chosen to follow and the event archive choice stay chosen. The save isn't touched, and recording starts again at the next save.</v-card-text>
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
import { ipcRenderer } from 'electron'
import { mapActions, mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartFont, chartTheme, seriesIdentity, withAlpha } from '../components/charts/theme'
import ColonySeries from '../components/history/ColonySeries.vue'
import StockRates from '../components/history/StockRates.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { whenFontsReady } from '../utilities/appearance-font'
import { gameTime } from '../utilities/aurora'
import { readRegistry } from '../utilities/campaign'
import { attach, keepSeparate, previewAttach } from '../utilities/campaign-attach'
import { COLONY_BYTES, chosenNow, colonyEstimate, colonyWish } from '../utilities/colony-series'
import { csvCell } from '../utilities/csv-cell'
import { registerEconomyNotes } from '../utilities/economy-notes'
import { EVENT_BYTES, EVENT_CAP, EVENT_CAPS, archiveOn, capRecord, eventEstimate, eventFileProblem, gapsOf, recordEvents } from '../utilities/event-archive'
import { DEFAULT_RETENTION, RETENTION_PROFILES, SNAPSHOT_FIELDS, branchStore, bytesText, campaignStorage, changeResult, clearRaceHistory, colonyStore, durationText, eventStore, installationResult, measuredBytes, mineralResult, predictRetention, recordedSpan, retentionNote, retentionProfile, retentionStats, samplingText, seriesOverCap, shownBranch, snapshotResult, sparseColumns, thinningStatus, thinningText, totalResult } from '../utilities/history'
import { Changed, MAX_BYTES, Rejected, abandonRestore, annotationsOf, applyRestore, backupFileName, buildBackup, defaultChoices, keptBackups, parseBackup, planRestore, recoveryFileName, unfinishedProblem, unfinishedRestore } from '../utilities/history-backup'
import { captionLines, drawExport, exportCsv, exportModel } from '../utilities/history-export'
import { LINK_STATUS_TEXT, LINK_TYPES, LINK_TYPE_KEYS, MILESTONE_TYPES, TEXT_LENGTH, adoptMilestone, branchLineage, deleteMilestone, gameDateText, gameSecondsOf, incrementsOf, linkChoices, loadObjects, markersOf, moveMilestone, nearestSample, readAttachedMilestones, readMilestones, registerMilestones, saveMilestone, scopeOf as milestoneScopeOf, typeText, withinSamples } from '../utilities/history-milestones'
import { UNKNOWN_TEXT, countText, isKnownNumber, roundToDecimal } from '../utilities/math'
import { MINERAL_SCALES, compareMinerals, comparisonCsv, mineralStyle } from '../utilities/mineral-compare'
import { MINERALS } from '../utilities/minerals'
import { describeResult, isAvailable, ofRule, unavailable, valueOrNull } from '../utilities/provenance'
import { withRegistry } from '../utilities/recording-owner'
import { registerWorldTags } from '../utilities/world-tags'

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

// What the Rivals chart can compare: `result` is a snapshot's figure as a result of `rule`, in `unit`.
const RIVAL_METRICS = [
  { value: 'population', text: 'Population', rule: 'history.population', unit: 'M people', result: (snapshot) => snapshotResult(snapshot, 'population'), format: people },
  { value: 'colonies', text: 'Colonies', rule: 'history.colonies', unit: 'colonies', result: (snapshot) => snapshotResult(snapshot, 'colonies'), format: whole },
  { value: 'fleet', text: 'Fleet tonnage', rule: 'history.fleetTonnage', unit: 't', result: fleetResult, format: (value) => withUnit(compact(value), 't') },
  { value: 'military', text: 'Military tonnage', rule: 'history.fleetTonnage', unit: 't', result: (snapshot) => snapshotResult(snapshot, 'militaryTons'), format: (value) => withUnit(compact(value), 't') },
  { value: 'research', text: 'Research', rule: 'history.research', unit: 'RP', result: (snapshot) => snapshotResult(snapshot, 'research'), format: (value) => withUnit(compact(value), 'RP') },
  { value: 'systems', text: 'Known systems', rule: 'history.systems', unit: 'systems', result: (snapshot) => snapshotResult(snapshot, 'systems'), format: whole },
  { value: 'wealth', text: 'Treasury', rule: 'history.treasury', unit: 'wealth', result: (snapshot) => snapshotResult(snapshot, 'wealth'), format: compact },
]

// The table's figure columns, each in `unit`.
const MEASURES = [
  { value: 'population', text: 'Population (M)', decimals: 1, rule: 'history.population', unit: 'M people' },
  { value: 'colonies', text: 'Colonies', decimals: 0, rule: 'history.colonies', unit: 'colonies' },
  { value: 'wealth', text: 'Treasury', decimals: 0, rule: 'history.treasury', unit: 'wealth' },
  { value: 'militaryTons', text: 'Military (t)', decimals: 0, rule: 'history.fleetTonnage', unit: 't' },
  { value: 'commercialTons', text: 'Commercial (t)', decimals: 0, rule: 'history.fleetTonnage', unit: 't' },
  { value: 'research', text: 'Research (RP)', decimals: 0, rule: 'history.research', unit: 'RP' },
  { value: 'systems', text: 'Systems', decimals: 0, rule: 'history.systems', unit: 'systems' },
]

const RIVAL_METRIC_VALUES = RIVAL_METRICS.map((metric) => metric.value)

const blankMilestone = () => ({ uuid: null, revision: null, date: '', t: null, type: 'other', text: '', linkKind: 'none', linkPick: null, branchOnly: false, scopeKey: null })

const LINK_WORDS = { linked: 'linked', missing: 'unresolved, gone', changed: 'unresolved, changed', unknown: 'not checked', ambiguous: 'ambiguous' }

// A link as the list shows it: the status in words, the colour of its chip and the reason in full.
const linkView = (link) => ({ ...link, color: link.status === 'linked' ? undefined : link.status === 'unknown' ? 'grey' : 'warning', word: LINK_WORDS[link.status] || link.status, reason: link.reason || LINK_STATUS_TEXT[link.status] || '' })

// A link as the export names it: the chip's words.
const linkText = (link) => (link ? `${link.label}: ${link.name || link.id}${link.nowNamed ? ` (now ${link.nowNamed})` : ''}, ${link.word}` : '')

export default {
  name: 'HistoryPage',
  components: { ChartCanvas, ColonySeries, ProvenanceMark, SeriesKey, StatTiles, StockRates },
  mixins: [
    persistedView({
      view: { key: 'historyView', default: 'charts', valid: oneOf(['charts', 'table']) },
      historyTable: tableView('historyTable', { itemsPerPage: 25, itemsPerPageOptions: HISTORY_PAGE_SIZES }),
      mineralIds: { key: 'historyMinerals', default: [1, 2, 11], normalise: (stored) => (Array.isArray(stored) ? MINERALS.map((mineral) => mineral.id).filter((id) => stored.includes(id)) : undefined) },
      mineralScale: { key: 'historyMineralScale', default: 'absolute', valid: oneOf(MINERAL_SCALES.map((option) => option.value)) },
      installationIds: { key: 'historyInstallations', default: null, scope: 'race' },
      rivalMetric: { key: 'historyRivalsMetric', default: 'population', valid: oneOf(RIVAL_METRIC_VALUES) },
      span: { key: 'historySpan', default: 0, valid: oneOf(SPAN_OPTIONS.map((option) => option.value)) },
      retentionProfile: { key: 'historyRetention', default: DEFAULT_RETENTION, valid: oneOf(RETENTION_PROFILES.map((profile) => profile.id)) },
      eventCap: { key: 'historyEventCap', default: EVENT_CAP, valid: oneOf(EVENT_CAPS) },
    }),
  ],
  data() {
    return {
      confirmClear: false,
      historyPageSizes: HISTORY_PAGE_SIZES,
      measureColumns: MEASURES,
      rivalMetrics: RIVAL_METRICS,
      spanOptions: SPAN_OPTIONS,
      eventCaps: EVENT_CAPS,
      // Spy mode shows the other races' history (Rivals). Read on creation: it's set on Settings.
      spyNPR: false,
      // Bumped when this page clears the history, so `gameHistory` re-reads it.
      cleared: 0,
      // Bumped when the Colony series panel changes what is followed, so the settings are read again.
      colonyChanges: 0,
      // The cap picked on the Retention panel and waiting for confirmation; the cap in force is the persisted `eventCap`.
      eventCapPick: null,
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
      // The retention profile picked and waiting for confirmation (Retention panel); the profile in force is the persisted `retentionProfile`.
      retentionPick: null,
      // The Milestones panel: the repository's revision of what was read (bumped by each write), the form's draft, the entry whose deletion waits for a second click, the message of the last action and the conflict of a stale edit.
      milestoneRevision: 0,
      milestoneDraft: blankMilestone(),
      milestoneConfirm: null,
      milestoneMessage: '',
      milestoneMessageType: 'info',
      milestoneConflict: null,
      milestoneBusy: false,
      milestoneTypes: MILESTONE_TYPES,
      milestoneLinkKinds: LINK_TYPE_KEYS,
      textLength: TEXT_LENGTH,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID', 'StartYear', 'historyRecorded']),

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

    // The scenario repository the milestones are kept in, null until it loads or when it cannot be opened here.
    milestoneRepository() {
      return this.records ? this.records.repository : null
    },

    // The scope the milestones are read in: the race, the campaign and the branch shown. The game time is the open save's on its own branch and the last sample's on another, so a milestone made later than that is listed as ahead.
    milestoneScope() {
      const open = this.resolved

      if (!open || !this.shownBranchId) {
        return null
      }

      const last = this.allSnapshots.length ? this.allSnapshots[this.allSnapshots.length - 1].t : 0

      return milestoneScopeOf({ campaign: open, RaceID: this.RaceID, branchId: this.shownBranchId, gameTime: this.shownBranchId === open.branchId ? this.GameTime : last })
    },

    // What a draft of the form belongs to: the campaign, the race and the branch it is kept for. A draft is dropped when it changes, and one that is saved after it did not is refused.
    milestoneScopeKey() {
      const scope = this.milestoneScope

      return scope ? [scope.campaignId, scope.RaceID, scope.branchId].join('|') : ''
    },

    // The milestones read without the save's objects: which events they link to, and whether any link needs the objects read.
    milestoneBase() {
      // eslint-disable-next-line no-unused-expressions
      this.milestoneRevision + this.$store.state.history.revision

      return readMilestones(this.milestoneRepository, this.milestoneScope)
    },

    // The milestones of attached campaigns read without the save's objects, for the events their links name.
    milestoneAttachedBase() {
      // eslint-disable-next-line no-unused-expressions
      this.milestoneRevision + this.$store.state.history.revision

      return readAttachedMilestones(this.milestoneRepository, this.milestoneScope)
    },

    milestoneIncrements() {
      return incrementsOf([...this.milestoneBase.entries, ...this.milestoneAttachedBase.entries])
    },

    // Whether the save's objects are needed: a milestone is linked, or the form picks an object to link to.
    milestoneWantsObjects() {
      return [...this.milestoneBase.entries, ...this.milestoneAttachedBase.entries].some((entry) => entry.links.length > 0) || LINK_TYPE_KEYS.includes(this.milestoneDraft.linkKind)
    },

    // The objects as read for the game and race shown and the save open now: the read that is still running for another save or race leaves the last one in place, and it is not used.
    milestoneBundle() {
      const bundle = this.milestoneObjects

      return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null
    },

    // The branches of the open campaign as the registry holds them (the branch each left and the game time it left it at), for telling whether an object that a link names is the same one on the branch of the open save. Null when the registry cannot be read here.
    milestoneBranches() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.campaignChanges

      const open = this.resolved

      if (!open) {
        return null
      }

      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[open.campaignId])
      } catch (error) {
        return null
      }
    },

    // What the links are checked against: the open save's objects for the game and race shown, with its campaign, branch and the campaign's branches, and only when the branch shown is the open save's.
    milestoneContext() {
      const open = this.resolved
      const bundle = this.milestoneBundle

      return bundle && this.milestoneScope && open && this.milestoneScope.branchId === open.branchId ? { objects: bundle.objects, GameID: bundle.GameID, RaceID: bundle.RaceID, campaignId: open.campaignId, branchId: open.branchId, branches: this.milestoneBranches } : null
    },

    milestoneRead() {
      // eslint-disable-next-line no-unused-expressions
      this.milestoneRevision + this.$store.state.history.revision

      return readMilestones(this.milestoneRepository, this.milestoneScope, this.milestoneContext)
    },

    // The milestones of attached campaigns, listed apart from the campaign's own: with their date, link and whether a copy of them was adopted, on any branch of the campaign. They are not drawn.
    milestoneAttached() {
      // eslint-disable-next-line no-unused-expressions
      this.milestoneRevision + this.$store.state.history.revision

      const read = readAttachedMilestones(this.milestoneRepository, this.milestoneScope, this.milestoneContext, Object.keys(this.milestoneBranches || {}))

      return { ...read, entries: read.entries.map((entry) => ({ ...entry, typeText: typeText(entry.type), dateText: this.dateTimeText(entry.t), link: entry.link ? linkView(entry.link) : null })) }
    },

    milestoneCaption() {
      const drawn = this.milestoneEntries.filter((entry) => entry.drawn).length

      return this.milestoneEntries.length ? `${this.milestoneEntries.length} kept, ${drawn} drawn on the charts` : 'Pin a note to an exact game time'
    },

    // Each milestone with its time as a date, its nearest sample beside it, the state of its link in words and whether the charts draw it.
    milestoneEntries() {
      return this.milestoneRead.entries.map((entry) => {
        const sample = nearestSample(this.allSnapshots, entry.t)
        const drawn = !entry.ahead && withinSamples(this.snapshots, entry.t)

        return {
          ...entry,
          typeText: typeText(entry.type),
          dateText: this.dateTimeText(entry.t),
          drawn,
          drawnText: entry.ahead ? 'made at a later game time than this save, listed and not drawn' : drawn ? 'drawn on the charts at its exact time' : 'outside the samples the charts show now',
          sample: sample ? { dateText: this.dateTimeText(sample.sampleT), offsetText: sample.offset === 0 ? 'exactly at the milestone' : `${this.duration(Math.abs(sample.offset))} ${sample.offset > 0 ? 'before' : 'after'} it` } : null,
          link: entry.link ? linkView(entry.link) : null,
        }
      })
    },

    // The markers the charts draw: at the exact game time of each milestone, whatever the samples are.
    milestoneMarkers() {
      return markersOf(this.milestoneRead.entries, this.snapshots, (seconds) => this.year(seconds))
    },

    milestoneEdited() {
      return this.milestoneDraft.uuid ? this.milestoneRead.entries.find((entry) => entry.uuid === this.milestoneDraft.uuid) || null : null
    },

    // The time the form holds: the typed date, the exact time kept when the date is the one that time gives, the scope's game time when it is empty and a milestone is new.
    milestoneTime() {
      const text = this.milestoneDraft.date.trim()
      const draft = this.milestoneDraft

      if (draft.t !== null && text === gameDateText(this.StartYear, draft.t)) {
        return { ok: true, seconds: draft.t }
      }

      if (text === '' && !draft.uuid && this.milestoneScope) {
        return { ok: true, seconds: this.milestoneScope.gameTime }
      }

      return gameSecondsOf(this.StartYear, text)
    },

    milestoneTimeHint() {
      return this.milestoneTime.ok ? `Exact game time ${this.count(this.milestoneTime.seconds, this.milestoneTime.seconds % 1 === 0 ? 0 : 3)} s${this.milestoneDraft.date.trim() === '' ? ', that of this save' : ''}` : ''
    },

    gameDateOfOpen() {
      return this.milestoneScope && this.yearKnown ? gameDateText(this.StartYear, this.milestoneScope.gameTime) : ''
    },

    milestoneKindItems() {
      return [{ text: 'No link', value: 'none' }, ...(this.milestoneEdited && this.milestoneEdited.link ? [{ text: `Keep the link to ${this.milestoneEdited.link.label.toLowerCase()} ${this.milestoneEdited.link.name || this.milestoneEdited.link.id}`, value: 'keep' }] : []), ...LINK_TYPE_KEYS.map((key) => ({ text: `Link to a ${LINK_TYPES[key].label.toLowerCase()}`, value: key }))]
    },

    milestoneLinkLabel() {
      return LINK_TYPES[this.milestoneDraft.linkKind] ? LINK_TYPES[this.milestoneDraft.linkKind].label : 'Object'
    },

    milestoneLinkHint() {
      const kind = this.milestoneDraft.linkKind
      const failed = this.milestoneBundle && this.milestoneBundle.failed[kind]

      return !this.milestoneContext ? (this.shownBranchId && this.resolved && this.shownBranchId !== this.resolved.branchId ? 'Objects are read from the open save, which is on another branch' : 'Reading the objects of this save') : failed ? `This save cannot give them: ${failed}` : kind === 'event' ? 'The latest events of the log; picking one sets the time to its own' : ''
    },

    milestoneChoices() {
      const kind = this.milestoneDraft.linkKind

      return this.milestoneContext && LINK_TYPES[kind] ? linkChoices(this.milestoneContext.objects, kind).map((choice) => ({ ...choice, text: kind === 'event' ? `${this.dateTimeText(choice.row.time)} · ${choice.name}${choice.ambiguous ? ` (${choice.row.copies} identical entries: ambiguous)` : ''}` : choice.name || `${LINK_TYPES[kind].label} ${choice.id}` })) : []
    },

    // Whether the form can be saved: a time, a note and, if a link is asked for, the object picked.
    milestoneReady() {
      const draft = this.milestoneDraft

      return this.milestoneTime.ok && draft.text.trim() !== '' && draft.text.length <= TEXT_LENGTH && !(LINK_TYPE_KEYS.includes(draft.linkKind) && !draft.linkPick)
    },

    latest() {
      return this.snapshots[this.snapshots.length - 1]
    },

    // What the recording covers, labelled for the header: first and latest game dates, the span between them, how much of the chosen window it fills and how sparsely it is sampled (the thinning is stated in the Retention panel). Null when nothing is recorded.
    recording() {
      const coverage = recordedSpan(this.allSnapshots, this.span * SECONDS_PER_YEAR)

      if (!coverage.count) {
        return null
      }

      const sampling = retentionNote(this.record, (t) => this.date(t))

      if (coverage.count === 1) {
        return { headline: `1 snapshot, ${this.date(coverage.first)}. No span is recorded yet, and nothing earlier was observed.`, sampling, note: '' }
      }

      const years = (seconds) => (seconds / SECONDS_PER_YEAR).toFixed(1)
      const dates = `${this.date(coverage.first)} to ${this.date(coverage.last)}`
      const covered = this.span ? `${years(coverage.covered)} of ${this.span} years recorded${coverage.inWindow < coverage.count ? `, ${coverage.inWindow} of ${coverage.count} snapshots in this window` : ''}` : `${years(coverage.seconds)} years recorded`

      return {
        headline: `${coverage.count} snapshots, ${dates}: ${covered}.`,
        sampling,
        note: 'Game time before the first snapshot was never observed by the app and cannot be rebuilt, since snapshots keep only aggregate figures. Gaps between snapshots are expected: one is taken per save while the app is open, and a series past the retention cap has its older half thinned to every other snapshot, so older stretches can be coarser than recent ones.',
      }
    },

    // The Retention panel: the readouts of the shown race's series (samples, gaps, thinning, measured size), what each profile would do to it now, and the choice waiting for confirmation. Predicted sizes are never shown as measured ones.
    retentionView() {
      const record = this.record
      const profile = retentionProfile(this.retentionProfile)
      const stats = retentionStats(this.allSnapshots)
      const status = thinningStatus(record)
      const profiles = RETENTION_PROFILES.map((option) => ({ ...option, active: option.id === profile.id, ...predictRetention(record, option) }))

      return {
        profile,
        stats,
        sampling: samplingText(stats),
        thinning: thinningText(status, (t) => this.date(t)),
        status: status.status,
        measured: measuredBytes(record),
        file: this.gameHistory ? measuredBytes(this.gameHistory) : null,
        over: stats.count > profile.cap,
        profiles,
        current: profiles.find((option) => option.active),
      }
    },

    // The shown branch's colony file as stored, or why it could not be read: { file, error }. The file is null when the branch has none; the error is '' when the read worked.
    colonyRecord() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared + this.campaignChanges + this.colonyChanges

      if (!this.GameID || !this.RaceID || !this.historyRecorded || !this.resolved) {
        return { file: null, error: '' }
      }

      try {
        const file = colonyStore(this.resolved.campaignId, this.shownBranchId).store

        return { file: file && file.races ? file : null, error: '' }
      } catch (error) {
        return { file: null, error: error.message }
      }
    },

    // The colonies this race follows (Colony series panel): the entries kept in the settings for the settled campaign, the measured size of the shown branch's colony file and the predicted size at the retention cap. `error` is why the settings or the file could not be read, else ''; a figure not known is null, never 0.
    colonyBudget() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared + this.campaignChanges + this.colonyChanges

      if (!this.GameID || !this.RaceID || !this.historyRecorded || !this.resolved) {
        return null
      }

      const cap = this.retentionView.profile.cap

      try {
        const io = campaignStorage(this.config)
        const wish = colonyWish(io.settings.store, readRegistry(io).campaigns)
        const entries = wish[this.resolved.campaignId] ? wish[this.resolved.campaignId].races[this.RaceID] || [] : []
        const followed = chosenNow(entries).length

        if (this.colonyRecord.error) {
          throw new Error(this.colonyRecord.error)
        }

        const file = this.colonyRecord.file
        const series = file ? file.races[this.RaceID] : null

        return { entries, followed, dropped: new Set(entries.filter((entry) => entry.until !== undefined).map((entry) => entry.id)).size, measured: series ? measuredBytes(series) : null, snapshots: series ? series.snapshots.length : 0, predicted: colonyEstimate({ snapshots: cap, colonies: followed }), error: '' }
      } catch (error) {
        return { entries: [], followed: 0, dropped: 0, measured: null, snapshots: 0, predicted: null, error: error.message }
      }
    },

    // The Retention panel's line on the colony series: measured and predicted at the cap, or why neither is known.
    colonyBudgetText() {
      const budget = this.colonyBudget

      if (!budget) {
        return 'Unavailable: the campaign of the open save is not settled.'
      }

      if (budget.error) {
        return `Unavailable: ${budget.error}.`
      }

      const measured = budget.measured === null ? 'none recorded yet' : `${this.size(budget.measured)} measured in ${this.count(budget.snapshots, 0)} snapshots`
      const predicted = budget.followed ? `about ${this.size(budget.predicted)} predicted for ${this.count(budget.followed, 0)} ${budget.followed === 1 ? 'colony' : 'colonies'} at ${this.count(this.retentionView.profile.cap, 0)} snapshots` : 'none followed, so none predicted'

      return `${measured}; ${predicted}. Counted with the history in the retention budget; each colony takes about ${COLONY_BYTES} bytes a snapshot.`
    },

    // The shown branch's event archive as stored, or why it could not be read: { file, error }. The file is null when the branch has none; the error is '' when the read worked and names the problem of a file this version cannot read, never a count of 0.
    eventRecord() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared + this.campaignChanges

      if (!this.GameID || !this.RaceID || !this.historyRecorded || !this.resolved) {
        return { file: null, error: '' }
      }

      try {
        const file = eventStore(this.resolved.campaignId, this.shownBranchId).store
        const problem = eventFileProblem(file)

        return problem ? { file: null, error: `the event archive of this branch is unreadable (${problem})` } : { file: file && file.races ? file : null, error: '' }
      } catch (error) {
        return { file: null, error: error.message }
      }
    },

    // What the Retention panel states of the shown race's event archive: the choice in the settings for the settled campaign, the events kept, the measured size of its record in the shown branch's file, the predicted size at the cap and the unobserved stretches. `error` is why the settings or the file could not be read, else ''; a figure not known is null, never 0.
    eventBudget() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared + this.campaignChanges

      if (!this.GameID || !this.RaceID || !this.historyRecorded || !this.resolved) {
        return null
      }

      const cap = this.eventCap

      try {
        if (this.eventRecord.error) {
          throw new Error(this.eventRecord.error)
        }

        const io = campaignStorage(this.config)
        const file = this.eventRecord.file
        const record = file ? file.races[this.RaceID] || null : null

        return { on: archiveOn(io.settings.store, this.resolved.campaignId, this.RaceID), player: !(this.record && this.record.npr), cap, events: record ? recordEvents(record) : null, measured: record ? measuredBytes(record) : null, predicted: eventEstimate(cap), gaps: record ? gapsOf(record).filter((gap) => gap.from !== null).length : null, cut: record && isKnownNumber(record.cut) ? record.cut : null, error: '' }
      } catch (error) {
        return { on: false, player: true, cap, events: null, measured: null, predicted: null, gaps: null, cut: null, error: error.message }
      }
    },

    // The Retention panel's line on the event archive: whether the shown race keeps one, the events kept of the cap, the measured size of its record in the shown branch's file, the predicted size at the cap, the unobserved stretches and the date the cap cut the oldest events from; or why none of it is known.
    eventBudgetText() {
      const budget = this.eventBudget

      if (!budget) {
        return 'Unavailable: the campaign of the open save is not settled.'
      }

      if (budget.error) {
        return `Unavailable: ${budget.error}.`
      }

      if (!budget.player) {
        return 'Not kept: the event archive is for player races only.'
      }

      const state = budget.on ? 'On for this race in this campaign' : 'Off for this race in this campaign, so nothing more is captured'
      const kept = budget.events === null ? `none kept yet, at most ${this.count(budget.cap, 0)}` : `${this.count(budget.events, 0)} events kept of at most ${this.count(budget.cap, 0)}`
      const measured = budget.measured === null ? 'none recorded yet' : `${this.size(budget.measured)} measured as compact JSON`
      const gaps = budget.gaps === null ? '' : ` ${this.count(budget.gaps, 0)} ${budget.gaps === 1 ? 'stretch' : 'stretches'} between captures ${budget.gaps === 1 ? 'was' : 'were'} not observed, as was the time before the first capture.`
      const cut = budget.cut === null ? '' : ` The cap cut the oldest events: the record is complete from ${this.date(budget.cut)}.`

      return `${state}; ${kept}; ${measured}; about ${this.size(budget.predicted)} predicted at the cap, at about ${EVENT_BYTES} bytes an event.${gaps}${cut}`
    },

    // The cap picked and not yet confirmed. The cap is one setting of the installation, read by the recorder for every campaign, race and branch, so any decrease waits here, whatever the shown branch holds; the shown branch's figures are added when its archive is known, and are never the whole of what is cut. Null when none is waiting.
    eventCapChange() {
      const cap = this.eventCapPick

      if (!cap) {
        return null
      }

      const scope = 'The cap applies to every campaign, race and branch of this installation, and takes effect at the next capture of each. Events it cuts are gone for good: a larger cap keeps the events observed from now on and never brings them back.'
      const record = this.eventRecord

      if (record.error) {
        return { cap, text: `${scope} The archive of the shown branch could not be read, so what it would lose is not shown.` }
      }

      if (!record.file) {
        return { cap, text: `${scope} The shown branch holds no archive, and the others are not read here, so the events they would lose are not shown.` }
      }

      const races = Object.entries(record.file.races).map(([RaceID, entry]) => ({ RaceID, dropped: capRecord(entry, cap).dropped }))
      const shown = races.filter(({ RaceID }) => RaceID === String(this.RaceID)).reduce((sum, race) => sum + race.dropped, 0)
      const others = races.filter(({ RaceID }) => RaceID !== String(this.RaceID)).reduce((sum, race) => sum + race.dropped, 0)
      const own = shown ? `In the shown branch, the next capture of this race cuts ${this.count(shown, 0)} of its oldest events (whole increments, so a little more than the excess can go).` : 'In the shown branch, the next capture of this race cuts none of its events.'
      const rest = others ? ` The archives of other races in this branch lose ${this.count(others, 0)} events in all when each is next captured.` : ''

      return { cap, text: `${scope} ${own}${rest} Other branches and campaigns are not counted here.` }
    },

    // The profile picked and not yet confirmed: what the recorder's next save would do to the shown branch under it (the new sample goes in, then every thinning pass runs, so that is more than thinning the stored samples alone when the count sits at a pass boundary), the figure for the stored samples as they are now labelled as such, and what it cannot undo. Null when none is waiting.
    retentionChange() {
      const picked = this.retentionPick ? retentionProfile(this.retentionPick) : null

      if (!picked) {
        return null
      }

      const current = retentionProfile(this.retentionProfile)
      const held = seriesOverCap(this.gameHistory, picked.cap)
      const colonyHeld = this.colonyRecord.file ? seriesOverCap(this.colonyRecord.file, picked.cap) : null
      const cap = this.count(picked.cap, 0)
      const stored = held.over ? ` (${held.over} ${held.over === 1 ? 'holds' : 'hold'} more than ${cap} now, and thinning only the samples stored now would drop ${this.count(held.dropped, 0)})` : ''
      const replaced = held.next.replaced ? ` The figure also allows for an observation that matches the intelligence sample before it, which removes the sample stored at its time before the thinning runs; that adds up to ${this.count(held.next.replaced, 0)} to what thinning alone would discard.` : ''
      const none = colonyHeld && colonyHeld.next.thins ? `No series of the empire history in this branch holds as many as ${cap} samples, so the next save thins none of them.` : `No series in this branch holds as many as ${cap} samples, so the next save thins nothing.`
      const consequence = held.next.thins ? `The next save thins ${held.next.thins} of the ${held.series} series in this branch to at most ${cap} samples and discards up to ${this.count(held.next.dropped, 0)} stored samples in all${stored}. A series is thinned by dropping every other sample of its older half, repeated until it fits, once the new sample is in; the newest samples stay.${replaced}` : `${none} A series is thinned when the recorder saves a sample that takes it past ${cap}.`
      const unthinned = ` No colony series of this branch holds as many as ${cap} samples, so none of them is thinned.`
      const thinned = colonyHeld ? ` The next save thins ${colonyHeld.next.thins} of the ${colonyHeld.series} colony series of this branch to at most ${cap} samples and discards up to ${this.count(colonyHeld.next.dropped, 0)} stored samples in all.` : ''
      const colonies = this.colonyRecord.error ? ` The colony series of this branch could not be read (${this.colonyRecord.error}), so whether they are thinned is not shown.` : colonyHeld && colonyHeld.next.thins ? thinned : colonyHeld ? unthinned : ''

      return { picked, current, text: `${consequence}${colonies} Samples that are already thinned are gone for good: a larger cap keeps the samples observed from now on and never brings them back.` }
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
        options.plugins.guides.levels = [{ y: 0 }]
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
        series: drawn.map((entry) => ({ unit: percent ? '%' : 't', rule: percent ? 'history.mineralChange' : 'history.stockpile', times: this.snapshots.map((snapshot) => snapshot.t), results: this.snapshots.map((snapshot) => mineralResult(snapshot, entry.id, entry.name)), ...(percent ? { baseline: entry.baseline } : {}) })),
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
      // The figures behind a line, as the export reads them: the unit, the rule, the game time of each sample and its result.
      const field = (key, unit) => ({ unit, rule: SNAPSHOT_FIELDS[key].rule, times: this.snapshots.map((snapshot) => snapshot.t), results: this.snapshots.map((snapshot) => snapshotResult(snapshot, key)) })

      const charts = [
        {
          key: 'population',
          title: 'Population',
          rules: ['history.population', 'history.colonies'],
          summary: 'How the population and number of colonies have grown over the years, to show whether the expansion keeps pace.',
          data: { datasets: [line('Population', pick('population'), 0), line('Colonies', pick('colonies'), 1, 'y1')] },
          series: [field('population', 'M people'), field('colonies', 'colonies')],
          options: this.options({ y: people, y1: (value) => `${value}` }),
        },
        {
          key: 'wealth',
          title: 'Wealth',
          rules: ['history.treasury', 'history.income'],
          summary: 'The treasury and annual income over time, to show whether the race is saving, spending or running short.',
          data: { datasets: [line('Treasury', pick('wealth'), 0), line('Annual income', pick('income'), 1, 'y1')] },
          series: [field('wealth', 'wealth'), field('income', 'wealth/yr')],
          options: this.options({ y: compact, y1: compact }),
        },
        {
          key: 'fleet',
          title: 'Fleet tonnage',
          rules: ['history.fleetTonnage'],
          summary: 'The military and commercial tonnage fielded over time, to show how the fleet has grown or shrunk.',
          data: { datasets: [line('Military', pick('militaryTons'), 0), line('Commercial', pick('commercialTons'), 1)] },
          series: [field('militaryTons', 't'), field('commercialTons', 't')],
          options: this.options({ y: (value) => `${compact(value)} t` }),
        },
        {
          key: 'research',
          title: 'Research and exploration',
          rules: ['history.research', 'history.systems'],
          summary: 'The research output and the number of systems known over time, to show how fast the race advances and explores.',
          data: { datasets: [line('Research (RP)', pick('research'), 0), line('Known systems', pick('systems'), 1, 'y1')] },
          series: [field('research', 'RP'), field('systems', 'systems')],
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
          series: this.chosenInstallations.map((id) => ({ unit: 'installations', rule: 'history.installations', times: this.snapshots.map((snapshot) => snapshot.t), results: this.snapshots.map((snapshot) => installationResult(snapshot, id, this.installationNames[id] || `installation ${id}`)) })),
          options: this.options({ y: compact }),
        },
        {
          key: 'logistics',
          title: 'Fuel and maintenance supplies',
          rules: ['history.stockpile'],
          summary: 'The fuel and maintenance supply stocks over time, to show whether the fleets can keep operating.',
          data: { datasets: [line('Fuel (L)', pick('fuel'), 0), line('MSP', pick('msp'), 1, 'y1')] },
          series: [field('fuel', 'L'), field('msp', 'MSP')],
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
      const kept = races.map(([, record]) => record.snapshots.filter((snapshot) => snapshot.t >= this.since))
      const datasets = races.map(([RaceID, record], index) => {
        const selected = Number(RaceID) === Number(this.RaceID)
        const color = palette[index % palette.length]

        return {
          label: record.raceName || `Race ${RaceID}`,
          data: kept[index].map((snapshot) => ({ x: this.year(snapshot.t), y: valueOrNull(metric.result(snapshot)) })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          borderWidth: selected ? 3 : 1.5,
          borderDash: index >= palette.length ? [6, 4] : [],
          pointRadius: record.snapshots.length > 40 ? 0 : 2,
          pointHoverRadius: 4,
          tension: 0,
        }
      })

      // `races` is what an export states of each race apart: its record (the retention note) and the samples it draws.
      return { key: 'rivals', title: `Rivals: ${metric.text}`, notes: [], rule: metric.rule, data: { datasets }, options: this.options({ y: metric.format }, metric.format), series: kept.map((list) => ({ unit: metric.unit, rule: metric.rule, times: list.map((snapshot) => snapshot.t), results: list.map(metric.result) })), races: races.map(([RaceID, record], index) => ({ label: `${datasets[index].label} (race ${RaceID})`, record, times: kept[index].map((snapshot) => snapshot.t) })) }
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

    // The table as an export sees it: every snapshot of the window, oldest first, a series for each figure column. The page of the table and its sort do not apply.
    tableChart() {
      const results = (key) => this.snapshots.map((snapshot) => snapshotResult(snapshot, key))

      return {
        key: 'table',
        title: 'History table',
        notes: [],
        annotated: false,
        data: { datasets: MEASURES.map(({ value, text }) => ({ label: text, data: results(value).map((result) => ({ y: valueOrNull(result) })) })) },
        series: MEASURES.map(({ value, rule, unit }) => ({ unit, rule, times: this.snapshots.map((snapshot) => snapshot.t), results: results(value) })),
      }
    },
  },
  watch: {
    // Another campaign or branch: the picked branch belonged to the last one.
    'resolved.campaignId'() {
      this.branchChoice = null
    },
    // Another campaign, race or branch: a draft of the form (its object picked, the milestone it edits) belonged to the last one.
    milestoneScopeKey() {
      const draft = this.milestoneDraft

      if (draft.uuid || draft.text || draft.date || draft.linkKind !== 'none') {
        this.resetMilestoneDraft()
        this.milestoneFailed('The form was emptied: the campaign, race or branch shown changed.', 'info')
      } else {
        this.resetMilestoneDraft()
      }
    },
  },
  created() {
    this.spyNPR = this.config.get('spyNPR', false)
  },
  methods: {
    ...mapActions('snackbar', ['activateSnackbar']),

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
    duration(seconds) {
      return durationText(seconds)
    },
    size(bytes) {
      return bytesText(bytes)
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
          guides: { markers: this.milestoneMarkers },
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
      const csv = comparisonCsv({ comparison: this.mineralComparison, scale: this.mineralScale, palette: this.theme.categorical, date: (seconds) => this.date(seconds), retention: retentionNote(this.record, (t) => this.date(t)) })

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
    // The view with this key as the page shows it now: a chart in the charts view (the Rivals chart only in spy mode, when it is on screen) or the table in the table view. Null for any other, so nothing that is not on screen is exported.
    exportView(key) {
      const views = this.view === 'charts' ? [...this.charts, ...(this.rivals ? [this.rivals] : [])] : [this.tableChart]

      return views.find((candidate) => candidate.key === key) || null
    },
    // Whether a view has nothing to export: no series drawn, or no sample in the window.
    exportEmpty(view) {
      return !view.data.datasets.length || !this.snapshots.length
    },
    // The export of one view (utilities/history-export.js), read from what the view draws: its datasets, the snapshots of the window and the annotations the charts draw. Returns `{ view, model }` (the view is kept for the legend of the picture), or null when there is nothing on screen to export.
    exportOf(key) {
      const view = this.exportView(key)

      if (!view || this.exportEmpty(view)) {
        return null
      }

      const datasets = view.data.datasets

      if (view.series.length !== datasets.length) {
        throw new Error(`The ${view.title} view draws ${datasets.length} series and describes ${view.series.length}`)
      }

      const series = datasets.map((dataset, index) => {
        const trace = view.series[index]

        if (trace.times.length !== dataset.data.length) {
          throw new Error(`${dataset.label} draws ${dataset.data.length} samples and describes ${trace.times.length}`)
        }

        return { label: dataset.label, unit: trace.unit, rule: trace.rule, baseline: trace.baseline, samples: trace.times.map((t, position) => ({ t, value: dataset.data[position].y, missing: trace.results[position].inputs.missing || [], stock: trace.baseline ? valueOrNull(trace.results[position]) : null })) }
      })
      const annotated = view.annotated !== false
      const drawn = annotated ? this.milestoneEntries.filter((entry) => entry.drawn) : []
      const annotations = drawn.map((entry) => {
        const near = nearestSample(this.snapshots, entry.t)

        return { id: entry.uuid, t: entry.t, type: entry.typeText, text: entry.text, link: linkText(entry.link), nearest: near ? { t: near.sampleT, offset: near.offset } : null }
      })
      const times = this.snapshots.map((snapshot) => snapshot.t)
      // A chart of one race states the window and sampling of the selected race. A chart of several (Rivals) states each race's own over the samples it draws: the selected race's bounds and sampling say nothing of another race.
      const races = view.races ? view.races.map((race) => ({ label: race.label, window: { count: race.times.length, retained: race.record.snapshots.length, from: race.times[0], to: race.times[race.times.length - 1] }, retention: retentionNote(race.record, (t) => this.date(t)) })) : null
      const model = exportModel({
        chart: { key, title: view.title, notes: view.notes },
        series,
        annotations,
        annotated,
        unseen: annotated ? this.milestoneEntries.length - drawn.length : 0,
        scope: { race: this.record.raceName || `Race ${this.RaceID}`, RaceID: this.RaceID, GameID: this.GameID, campaignId: this.resolved ? this.resolved.campaignId : null, branchId: this.shownBranchId, spy: key === 'rivals' },
        window: { span: this.span, count: times.length, retained: this.allSnapshots.length, from: times[0], to: times[times.length - 1] },
        retention: retentionNote(this.record, (t) => this.date(t)),
        races,
        date: (t) => this.date(t),
        dateTime: (t) => this.dateTimeText(t),
      })

      return { view, model }
    },
    exportFileName(key, extension) {
      return `${(this.record.raceName || 'race').replace(/[^\w-]+/g, '_')}-${key}-shown.${extension}`
    },
    // The CSV of the series, window and annotations one view shows now (not every retained snapshot: that is the CSV above).
    downloadChartCsv(key) {
      const exported = this.exportOf(key)

      if (exported) {
        this.saveCsv(exportCsv(exported.model), this.exportFileName(key, 'csv'))
      }
    },
    // The picture of one chart as it is on screen, with a caption of what it shows and what its sampling cannot say. The model and the bitmap are taken in one turn after every wait (the fonts, the redraw a change of the page asks for), and only when the view still reads as it did when the picture was asked for: the CSV text holds the race, branch, window, series and annotations, so a change of any of them while waiting gives no picture rather than a chart under the caption of another.
    async exportChartPng(key) {
      try {
        const asked = this.exportOf(key)

        if (!asked) {
          return
        }

        const wanted = exportCsv(asked.model)

        await whenFontsReady()
        await this.$nextTick()

        const exported = this.exportOf(key)

        if (!exported || exportCsv(exported.model) !== wanted) {
          this.activateSnackbar({ color: 'warning', text: 'The chart changed while its picture was being made, so nothing was saved. Export it again.' })

          return
        }

        const canvas = this.$el.querySelector(`[data-chart="${key}"] canvas`)

        if (!canvas || !canvas.clientWidth) {
          return
        }

        const { view, model } = exported
        const legend = view.data.datasets.map((dataset) => {
          const identity = seriesIdentity(this.appearance, dataset.borderColor)

          return { color: dataset.borderColor, dash: dataset.borderDash && dataset.borderDash.length ? dataset.borderDash : identity ? identity.dash : [] }
        })
        const make = (width, height) => Object.assign(document.createElement('canvas'), { width, height })
        const picture = drawExport({ make, source: { canvas, width: canvas.clientWidth, height: canvas.clientHeight }, caption: captionLines(model), legend, theme: this.theme, type: chartFont() })
        const result = await ipcRenderer.invoke('save-png', picture.canvas.toDataURL('image/png').split(',')[1], this.exportFileName(key, 'png'), `Save ${model.title} as PNG`)

        if (!result?.canceled) {
          this.activateSnackbar({ color: 'success', text: `${model.title} exported as PNG (${picture.canvas.width} × ${picture.canvas.height})` })
        }
      } catch (error) {
        this.activateSnackbar({ color: 'error', text: `Couldn't export the chart: ${error.message}` })
      }
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
      // The seconds since the previous row and the retention note, so an export of thinned or sparse history says so.
      const sparse = sparseColumns(this.allSnapshots, retentionNote(this.record, (t) => this.date(t)))
      const header = ['GameTime', 'Date', 'Population (M)', 'Colonies', 'Treasury', 'Annual income', 'Fuel (L)', 'MSP', ...MINERALS.map((mineral) => `${mineral.name} (t)`), 'Military ships', 'Military tons', 'Commercial ships', 'Commercial tons', 'Research (RP)', 'Known systems', 'Commanders', ...installationIds.map((id) => names[id]), 'Figures not recorded', ...sparse.header]
      // A figure that was not recorded is an empty cell, never 0; the last column names every one of them, the stockpiles and installations included.
      const rows = this.allSnapshots.map((snapshot, index) => {
        const results = [...['population', 'colonies', 'wealth', 'income', 'fuel', 'msp'].map((key) => snapshotResult(snapshot, key)), ...MINERALS.map((mineral) => mineralResult(snapshot, mineral.id, mineral.name)), ...['militaryShips', 'militaryTons', 'commercialShips', 'commercialTons', 'research', 'systems', 'commanders'].map((key) => snapshotResult(snapshot, key)), ...installationIds.map((id) => installationResult(snapshot, id, names[id]))]

        return [snapshot.t, this.date(snapshot.t), ...results.map(valueOrNull), results.filter((result) => !isAvailable(result)).flatMap((result) => result.inputs.missing).join('; '), ...sparse.rows[index]]
      })
      const csv = [header, ...rows].map((row) => row.map((value) => csvCell(value)).join(',')).join('\n')

      this.saveCsv(csv, `${(this.record.raceName || 'race').replace(/[^\w-]+/g, '_')}-history.csv`)
    },
    // A game time as a date and time to the second; without a start year, the game years elapsed.
    dateTimeText(seconds) {
      return this.yearKnown ? gameDateText(this.StartYear, seconds) : `${roundToDecimal(seconds / SECONDS_PER_YEAR, 2)} y elapsed`
    },
    // Opens a milestone in the form to edit: its exact time stays the time unless the date is retyped.
    editMilestone(entry) {
      this.milestoneDraft = { uuid: entry.uuid, revision: entry.revision, date: gameDateText(this.StartYear, entry.t), t: entry.t, type: entry.type, text: entry.text, linkKind: entry.link ? 'keep' : 'none', linkPick: null, branchOnly: entry.policy === 'branch', scopeKey: this.milestoneScopeKey }
      this.milestoneMessage = ''
      this.milestoneConflict = null
      this.milestoneConfirm = null
    },
    // Empties the form and what waits on it, for a draft that no longer belongs to what is shown.
    resetMilestoneDraft() {
      this.milestoneDraft = blankMilestone()
      this.milestoneConflict = null
      this.milestoneConfirm = null
      this.milestoneMessage = ''
    },
    cancelMilestone() {
      this.milestoneDraft = blankMilestone()
      this.milestoneConflict = null
      this.milestoneMessage = ''

      this.milestoneRevision += 1
    },
    // A log event is dated by its own time, so picking one sets the time of the form to it.
    pickMilestoneLink(pick) {
      if (pick && this.milestoneDraft.scopeKey === null) {
        this.milestoneDraft.scopeKey = this.milestoneScopeKey
      }

      if (pick && pick.row && this.milestoneDraft.linkKind === 'event' && Number.isFinite(pick.row.time)) {
        this.milestoneDraft.t = pick.row.time
        this.milestoneDraft.date = gameDateText(this.StartYear, pick.row.time)
      }
    },
    milestoneFailed(text, type = 'warning') {
      this.milestoneMessage = text
      this.milestoneMessageType = type
    },
    // Keeps the form's milestone: a new one, or an edit over the revision the form was opened at. A stale edit is not written unless `overwrite` says so.
    async saveMilestoneDraft(overwrite = false) {
      const draft = this.milestoneDraft

      if (draft.scopeKey !== null && draft.scopeKey !== this.milestoneScopeKey) {
        this.resetMilestoneDraft()
        this.milestoneFailed('The campaign, race or branch shown changed after this form was filled in, so nothing is saved. Fill it in again.')

        return
      }

      const time = this.milestoneTime

      if (!time.ok) {
        this.milestoneFailed(time.error)

        return
      }

      const stored = draft.uuid ? this.milestoneRead.entries.find((entry) => entry.uuid === draft.uuid) : null

      if (draft.uuid && !stored) {
        this.milestoneFailed('This milestone is no longer kept, so the edit is not written. Cancel to start again.')

        return
      }

      const link = draft.linkKind === 'none' ? null : draft.linkKind === 'keep' ? undefined : draft.linkPick ? { type: draft.linkKind, row: draft.linkPick.row } : false

      if (link === false) {
        this.milestoneFailed('Pick the object to link to, or choose no link.')

        return
      }

      this.milestoneBusy = true

      try {
        const outcome = await saveMilestone(this.milestoneRepository, this.milestoneScope, { entry: stored ? { ...stored, revision: draft.revision } : null, t: time.seconds, type: draft.type, text: draft.text, link, context: this.milestoneContext, policy: draft.branchOnly ? 'branch' : 'campaign', overwrite })

        this.milestoneRevision += 1

        if (outcome.ok) {
          this.milestoneDraft = blankMilestone()
          this.milestoneConflict = null
          this.milestoneFailed(draft.uuid ? 'The milestone is saved.' : 'The milestone is kept at that exact game time.', 'success')
        } else if (outcome.code === 'revision-conflict') {
          this.milestoneConflict = { text: outcome.stored.text, dateText: this.dateTimeText(outcome.stored.t) }
          this.milestoneMessage = ''
        } else {
          this.milestoneFailed(outcome.message)
        }
      } finally {
        this.milestoneBusy = false
      }
    },
    async deleteMilestoneEntry(entry) {
      this.milestoneBusy = true

      try {
        const outcome = await deleteMilestone(this.milestoneRepository, this.milestoneScope, entry)

        this.milestoneRevision += 1
        this.milestoneConfirm = null

        if (outcome.ok) {
          this.milestoneDraft = this.milestoneDraft.uuid === entry.uuid ? blankMilestone() : this.milestoneDraft
          this.milestoneFailed('The milestone is deleted.', 'success')
        } else {
          this.milestoneFailed(outcome.code === 'revision-conflict' ? 'The milestone was changed elsewhere, so it is not deleted. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.milestoneBusy = false
      }
    },
    // Moves a milestone made at a later game time to this save: its time stays and it is drawn here.
    async moveMilestoneHere(entry) {
      this.milestoneBusy = true

      try {
        const outcome = await moveMilestone(this.milestoneRepository, this.milestoneScope, entry)

        this.milestoneRevision += 1

        if (outcome.ok) {
          this.milestoneFailed('The milestone now belongs to this save, at the same game time.', 'success')
        } else {
          this.milestoneFailed(outcome.code === 'revision-conflict' ? 'The milestone was changed elsewhere, so it is not moved. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.milestoneBusy = false
      }
    },
    // Where the copy of an attached milestone that this campaign holds is kept, in words: one kept for a branch shows on that branch only.
    adoptedText(copy) {
      return copy.policy === 'campaign' ? 'this campaign holds a copy of it, kept for every branch.' : copy.branchId === this.shownBranchId ? 'this campaign holds a copy of it, kept for this branch only.' : `this campaign holds a copy of it, kept for branch ${copy.branchId} only. Pick that branch to see it.`
    },
    // Copies a milestone of an attached campaign into this campaign, on the branch shown. Only the player's click does it.
    async adoptMilestoneEntry(entry) {
      this.milestoneBusy = true

      try {
        const outcome = await adoptMilestone(this.milestoneRepository, this.milestoneScope, entry)

        this.milestoneRevision += 1

        if (outcome.ok) {
          this.milestoneFailed('The milestone is adopted: this campaign holds a copy of it, and the attached campaign keeps its own.', 'success')
        } else {
          this.milestoneFailed(outcome.code === 'collision' ? 'This milestone was adopted already.' : outcome.message)
        }
      } finally {
        this.milestoneBusy = false
      }
    },
    // Picks a retention profile: the choice waits for confirmation, which states what it does and does not do.
    pickRetention(id) {
      this.retentionPick = id === this.retentionProfile ? null : id
    },
    // Picks a cap on the events the archive keeps for a race. The cap is one setting of the installation that every campaign's recorder reads, so a decrease always waits for confirmation, whatever the shown branch holds; an increase cuts nothing and is kept at once.
    pickEventCap(cap) {
      if (cap === this.eventCap) {
        this.eventCapPick = null
      } else if (cap < this.eventCap) {
        this.eventCapPick = cap
      } else {
        this.eventCap = cap
        this.eventCapPick = null
      }
    },
    applyEventCap() {
      if (this.eventCapPick) {
        this.eventCap = this.eventCapPick
      }

      this.eventCapPick = null
    },
    applyRetention() {
      if (this.retentionPick) {
        this.retentionProfile = this.retentionPick
      }

      this.retentionPick = null
    },
    // The adapter the backup reads and restores the planners' annotations through: { adapter, error }, the adapter null with the reason when the records cannot be opened here. The modules load when a backup is made or read, so the page doesn't carry them otherwise.
    async backupAnnotations() {
      try {
        const [records, tech, briefs] = await Promise.all([import('../utilities/scenario-records'), import('../utilities/tech-scenarios'), import('../utilities/mission-briefs')])

        tech.registerTechScenarios(records.registerAdapter)
        briefs.registerBriefs(records.registerAdapter)
        registerMilestones(records.registerAdapter)
        registerEconomyNotes(records.registerAdapter)
        registerWorldTags(records.registerAdapter)

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
      const parts = [`adds ${plural(totals.added, 'snapshot')}`, `meets ${plural(totals.conflicts, 'conflict')} at a shared game time (Merge keeps the stored snapshot, Replace takes the backup's)`, `drops ${plural(totals.removed, 'stored snapshot')} under Replace`, ...(totals.events || totals.eventsRemoved ? [`adds ${plural(totals.events, 'event')} and drops or overwrites ${plural(totals.eventsRemoved, 'stored event')} under Replace`] : []), `restores ${plural(totals.annotations, 'annotation')}`, `changes ${plural(totals.registry, 'campaign record')}`]

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
    // The repository of scenario records, loaded with the page: its module needs the app's settings store, so a page that is read without it still loads.
    records: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerMilestones(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: error.message })
        }
      },
      default: null,
    },
    // The race's objects in the open save that milestones link to, read only while a milestone is linked or the form picks an object to link to. The read carries the save, game and race it was made for (`milestoneBundle` ignores it for another), and the page keeps the last one while the next is read.
    milestoneObjects: {
      async get() {
        const { database, GameID, RaceID } = this

        if (!database || !GameID || !RaceID || !this.milestoneWantsObjects) {
          return null
        }

        return Object.freeze({ ...(await loadObjects(database, { GameID, RaceID, increments: this.milestoneIncrements })), database })
      },
      default: null,
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

  .history-retention__row {
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    padding: 2px 0;
  }

  .history-retention__label {
    flex: 0 0 180px;
    opacity: 0.75;
  }

  .history-retention__value {
    flex: 1 1 260px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .history-retention__profiles {
    overflow-x: auto;
  }

  .history-retention__profiles th,
  .history-retention__profiles td {
    padding: 2px 12px 2px 0;
    text-align: left;
    white-space: nowrap;
  }

  .history-retention__active {
    font-weight: 600;
  }

  .history-milestones__form {
    align-items: flex-start;
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 12px;
  }

  .history-milestones__date {
    flex: 0 1 230px;
  }

  .history-milestones__type {
    flex: 0 1 150px;
  }

  .history-milestones__note {
    flex: 1 1 260px;
  }

  .history-milestones__kind {
    flex: 0 1 240px;
  }

  .history-milestones__pick {
    flex: 1 1 300px;
    min-width: 0;
  }

  .history-milestones__policy {
    flex: 0 0 auto;
  }

  .history-milestones__actions {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .history-milestones__row {
    border-top: 1px solid rgba(128, 128, 128, 0.3);
    padding: 8px 0;
  }

  .history-milestones__row .history-milestones__actions {
    margin-top: 2px;
  }

  .history-milestones__head {
    align-items: center;
    column-gap: 8px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .history-milestones__text {
    flex: 1 1 240px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
</style>
