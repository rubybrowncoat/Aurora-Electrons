<template>
  <div>
    <v-container fluid class="commanders-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div v-if="focusText" class="mb-2">
          <v-chip small close @click:close="clearFocus">{{ focusText }}</v-chip>
        </div>

        <stat-tiles :tiles="tiles" />

        <v-card class="panel" data-summary="Find unassigned officers whose relevant bonuses improve on the current post holders." elevation="1">
          <div class="panel-head">
            <span>Better assignments<provenance-mark rule="commanders.bonusSuggestion" /></span>
            <v-btn-toggle v-model="suggestionView" mandatory dense>
              <v-btn value="governors" small>Governor improvements ({{ governorRows.length }})</v-btn>
              <v-btn value="ships" small>Specialist ships ({{ shipRows.length }})</v-btn>
              <v-btn value="research" small>Research ({{ researchRows.length }})</v-btn>
            </v-btn-toggle>
          </div>

          <template v-if="suggestionView === 'governors'">
            <div class="panel-body caption text--secondary">{{ governorSummary }}<provenance-mark :result="governorStats.results.improvements" /></div>
            <v-data-table v-if="visibleGovernorRows.length" :headers="governorHeaders" :items="visibleGovernorRows" item-key="key" disable-pagination hide-default-footer>
              <template #[`item.colony`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.colony.PopName }}<page-link :to="colonyLink(item.colony.PopulationID)" :name="item.colony.PopName" class="ml-1" /></div>
                  <div class="caption text--secondary">Importance {{ plain(item.colony.Importance) }} · wants {{ colonyBonuses(item.colony) }}</div>
                </div>
              </template>
              <template #[`item.governor`]="{ item }">
                <div v-if="item.governor">
                  <div>{{ item.governor.Name }}</div>
                  <div class="caption text--secondary">{{ keyLabel(item.colony, item.current) }}</div>
                </div>
                <span v-else class="warning--text">Vacant</span>
              </template>
              <template #[`item.candidate`]="{ item }">
                <div>
                  <div class="font-weight-medium">{{ item.candidate.Name }}</div>
                  <div class="caption text--secondary">{{ keyLabel(item.colony, item.candidateKey) }} · admin rating {{ rating(item.candidate) }}<span v-if="item.alsoBestFor"> · also best for {{ item.alsoBestFor }} other {{ item.alsoBestFor === 1 ? 'colony' : 'colonies' }}</span><provenance-mark :result="item.result" /></div>
                </div>
              </template>
            </v-data-table>
            <div v-else class="panel-body caption text--secondary">
              <div>{{ governorEmptyText }}</div>
              <div v-for="reason in governorEmptyReasons" :key="reason">{{ reason }}</div>
            </div>
            <div v-if="visibleUnratedGovernors.length" class="panel-body caption text--secondary">
              <div>Cannot be rated, so left out of the table ({{ count(visibleUnratedGovernors.length) }}):</div>
              <div v-for="item in unratedShown(visibleUnratedGovernors)" :key="item.colony.PopulationID">{{ item.colony.PopName }}: {{ missingText(item.result) }}<provenance-mark :result="item.result" /></div>
              <div v-if="unratedMore(visibleUnratedGovernors)">and {{ count(unratedMore(visibleUnratedGovernors)) }} more</div>
            </div>
            <div class="panel-foot caption text--secondary">
              Only unassigned administrators are considered. A candidate must have the colony's required bonus, as the game ranks governors. Candidates rank by that bonus, then the secondary bonus, then the tertiary bonus, as set on the Governor tab of the Economics window.
            </div>
          </template>

          <template v-else-if="suggestionView === 'ships'">
            <v-data-table v-if="shipRows.length" :headers="shipHeaders" :items="shipRows" item-key="key" :items-per-page.sync="shipTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: shipPageSizes }">
              <template #[`item.ship`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.ship.ShipName }}<page-link v-if="item.ship.SystemID" :to="systemLink(item.ship.SystemID)" :name="item.ship.SystemName" class="ml-1" /></div>
                  <div class="caption text--secondary">{{ item.ship.ClassName }} · {{ item.ship.FleetName }}</div>
                </div>
              </template>
              <template #[`item.post`]="{ item }">
                <div>{{ item.post.post === 'science' ? 'Science officer' : 'Captain' }}</div>
                <div class="caption text--secondary">{{ item.post.label }} · {{ rankName(item.post.level) }}<provenance-mark :result="item.postResult" /></div>
              </template>
              <template #[`item.holder`]="{ item }">
                <div v-if="item.holder">
                  <div>{{ item.holder.Name }}</div>
                  <div class="caption text--secondary">{{ bonusText(item.post.bonusId, item.current) }}</div>
                </div>
                <span v-else class="warning--text">Vacant</span>
              </template>
              <template #[`item.candidate`]="{ item }">
                <div v-if="item.candidate">
                  <div class="font-weight-medium">{{ item.candidate.Name }}</div>
                  <div class="caption text--secondary">{{ bonusText(item.post.bonusId, item.candidate.bonuses[item.post.bonusId]) }}<provenance-mark :result="item.result" /></div>
                </div>
                <span v-else class="text--secondary">None at this rank<provenance-mark :result="item.result" /></span>
                <div v-if="item.otherRanks" class="caption text--secondary">{{ item.otherRanks }} better at other ranks</div>
                <div v-if="item.unknownCandidates" class="caption text--secondary">{{ item.unknownCandidates }} unassigned officers cannot be compared: a bonus or rank is not stored</div>
              </template>
            </v-data-table>
            <div v-else class="panel-body caption text--secondary">{{ shipAssessment.unrated.length ? 'Every specialist ship that can be rated has an officer, and no unassigned officer of the right rank has a better bonus.' : 'Every terraformer, miner, harvester and survey ship has an officer, and no unassigned officer of the post\'s rank has a better bonus.' }}</div>
            <div v-if="shipAssessment.unrated.length" class="panel-body caption text--secondary">
              <div>Cannot be rated, so left out of the table ({{ count(shipAssessment.unrated.length) }}):</div>
              <div v-for="item in unratedShown(shipAssessment.unrated)" :key="item.ship.ShipID">{{ item.ship.ShipName }}{{ item.ship.ClassName ? ` (${item.ship.ClassName})` : '' }}: {{ missingText(item.result) }}<provenance-mark :result="item.result" /></div>
              <div v-if="unratedMore(shipAssessment.unrated)">and {{ count(unratedMore(shipAssessment.unrated)) }} more</div>
            </div>
            <div class="panel-foot caption text--secondary">
              Terraformers and miners use the captain's full bonus. Survey ships with a Science Department use the science officer's bonus, and that post is one rank below the captain. Other survey ships use half the captain's bonus. Candidates are unassigned naval officers of exactly the post's rank, as automatic assignment requires. Officers under "other ranks" would need a promotion or a manual assignment.
            </div>
          </template>

          <template v-else>
            <v-data-table v-if="researchRows.length" :headers="researchHeaders" :items="researchRows" item-key="key" disable-pagination hide-default-footer>
              <template #[`item.project`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.project.ProjectName }}<page-link v-if="item.project.TechID" :to="techLink(item.project.TechID)" :name="item.project.ProjectName" class="ml-1" /></div>
                  <div class="caption text--secondary">{{ item.project.PopName }} · {{ item.project.FieldName }} · {{ plain(item.project.Facilities) }} labs</div>
                </div>
              </template>
              <template #[`item.holder`]="{ item }">
                <div v-if="item.holder">
                  <div>{{ item.holder.Name }}</div>
                  <div class="caption text--secondary">× {{ fixed(item.current, 2) }}{{ item.holder.ResSpecID === item.project.ResSpecID ? '' : ', out of field' }}<provenance-mark :result="item.currentResult" /></div>
                </div>
                <span v-else class="warning--text">No scientist</span>
              </template>
              <template #[`item.candidate`]="{ item }">
                <div class="font-weight-medium">{{ item.candidate.Name }}</div>
                <div class="caption text--secondary">× {{ fixed(item.candidateMultiplier, 2) }}, runs up to {{ item.candidateLabs }} labs<provenance-mark :result="item.result" /></div>
              </template>
            </v-data-table>
            <div v-else class="panel-body caption text--secondary">{{ projects.length ? (researchAssessment.unrated.length ? 'No unassigned scientist of the right field, able to run the labs, would research faster on a project that can be rated.' : 'No unassigned scientist of the right field, able to run the labs, would research faster.') : 'No research projects are running.' }}</div>
            <div v-if="researchAssessment.unrated.length" class="panel-body caption text--secondary">
              <div>Cannot be rated, so left out of the table ({{ count(researchAssessment.unrated.length) }}):</div>
              <div v-for="item in unratedShown(researchAssessment.unrated)" :key="item.project.ProjectID">{{ item.project.ProjectName || `Project ${item.project.ProjectID}` }}: {{ missingText(item.result) }}<provenance-mark :result="item.result" /></div>
              <div v-if="unratedMore(researchAssessment.unrated)">and {{ count(unratedMore(researchAssessment.unrated)) }} more</div>
            </div>
            <div class="panel-foot caption text--secondary">
              A scientist's Research bonus counts four times in their own field (+15% becomes +60%) and once outside it. A candidate must be of the project's field and run at least its labs (Research Administration).
            </div>
          </template>
        </v-card>

        <v-card class="panel" data-summary="Review commander ranks, posts, bonuses and health." elevation="1">
          <div class="panel-head">
            <span>Roster<provenance-mark rule="commanders.count" /></span>
            <v-btn-toggle v-model="typeId" mandatory dense>
              <v-btn v-for="type in commanderTypes" :key="type.id" :value="type.id" :disabled="!!focusCommanderId" small>{{ type.plural }} ({{ count(type.total) }})</v-btn>
            </v-btn-toggle>
          </div>
          <v-row dense align="center" class="px-6 pb-2">
            <v-col cols="12" sm="auto">
              <v-switch v-model="unassignedOnly" label="Unassigned only" dense hide-details class="mt-0" :disabled="!!focusCommanderId" />
            </v-col>
            <v-col cols="12" sm="3">
              <v-text-field v-model="search" label="Search names and assignments" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable :disabled="!!focusCommanderId" />
            </v-col>
            <v-col cols="12" sm="3">
              <v-select v-model="bonusId" :items="bonusItems" item-text="text" item-value="value" label="Sort by bonus" dense outlined hide-details clearable :disabled="!!focusCommanderId" />
            </v-col>
            <v-col v-if="typeId === 3" cols="12" sm="3">
              <v-select v-model="fieldId" :items="fieldItems" item-text="text" item-value="value" label="Research field" dense outlined hide-details clearable :disabled="!!focusCommanderId" />
            </v-col>
            <v-col cols="12" sm="3">
              <v-select v-model="postFilter" :items="postItems" item-text="text" item-value="value" label="Post" dense outlined hide-details clearable :disabled="!!focusCommanderId" data-roster-post />
            </v-col>
            <v-col v-if="rankItems.length" cols="12" sm="3">
              <v-select v-model="rankFilter" :items="rankItems" item-text="text" item-value="value" label="Rank" dense outlined hide-details clearable :disabled="!!focusCommanderId" data-roster-rank />
            </v-col>
            <v-col cols="6" sm="2">
              <v-text-field :value="ageMin" label="Age from" type="number" min="0" step="0.1" dense outlined hide-details clearable :disabled="!!focusCommanderId || !ageAvailable" data-roster-age-min @input="setAge('ageMin', $event)" />
            </v-col>
            <v-col cols="6" sm="2">
              <v-text-field :value="ageMax" label="Age to" type="number" min="0" step="0.1" dense outlined hide-details clearable :disabled="!!focusCommanderId || !ageAvailable" data-roster-age-max @input="setAge('ageMax', $event)" />
            </v-col>
          </v-row>
          <div v-if="!ageAvailable" class="px-6 pb-2 caption text--secondary" data-age-unavailable>{{ ageNotes.unavailable }}</div>
          <v-data-table :headers="rosterHeaders" :items="rosterRows" item-key="CommanderID" :custom-sort="sortRows" :sort-by.sync="rosterTable.sortBy" :sort-desc.sync="rosterTable.sortDesc" :items-per-page.sync="rosterTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: rosterPageSizes }" class="roster-table" data-roster-table>
            <template #[`header.Age`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.age" /></span></template>
            <template #[`header.selectedBonus`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.bonusValue" /></span></template>
            <template #[`header.bonusList`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.bonusValue" /></span></template>
            <template #[`item.Name`]="{ item }">
              <span class="font-weight-medium" :data-roster-name="item.CommanderID">{{ item.Name }}</span>
              <v-icon v-if="item.StoryCharacter" small class="ml-1" title="Story character: never retires">mdi-book-open-variant</v-icon>
            </template>
            <template #[`item.rankSort`]="{ item }">
              <span :title="item.RankName">{{ item.rankLabel }}</span>
            </template>
            <template #[`item.assignment`]="{ item }">
              <span v-if="item.CommandType === 0" class="text--secondary">Unassigned</span>
              <span v-else-if="item.assignmentMark" class="text--secondary">—<provenance-mark :result="item.assignmentMark" /></span>
              <template v-else>
                <div>{{ item.post }}</div>
                <div class="caption text--secondary">{{ item.AssignmentName }}<page-link v-if="item.CommandType === 3" :to="colonyLink(item.CommandID)" :name="item.AssignmentName" class="ml-1" /></div>
              </template>
            </template>
            <template #[`item.Age`]="{ item }">
              <span v-if="item.Age === null" class="text--secondary">—</span>
              <span v-else>{{ item.Age }}</span><provenance-mark :result="item.ageResult" />
            </template>
            <template #[`item.HealthRisk`]="{ item }">
              <span v-if="item.HealthRisk === null || item.HealthRisk === undefined" class="text--secondary">—</span>
              <span v-else :class="{ 'warning--text': item.HealthRisk >= 6 }">{{ item.HealthRisk }}</span>
            </template>
            <template #[`item.selectedBonus`]="{ item }">
              <span v-if="item.selectedBonus !== null">{{ bonusText(bonusId, item.selectedBonus) }}</span>
              <span v-else class="text--secondary">—<provenance-mark v-if="item.selectedBonusResult" :result="item.selectedBonusResult" /></span>
            </template>
            <template #[`item.bonusList`]="{ item }">
              <span v-for="bonus in item.bonusList" :key="bonus.id" class="bonus-chip" :title="bonus.description">{{ bonus.abbrev }} {{ bonus.text }}</span>
            </template>
            <template #[`item.traitCount`]="{ item }">
              <span v-if="item.traitNames.length" :title="item.traitNames.join(', ')">{{ item.traitNames.length }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
          </v-data-table>
          <div v-if="unassignedOnly && counts.noPost" class="panel-body caption text--secondary">{{ count(counts.noPost) }} commanders with no stored post are not shown: whether they are unassigned is not known.<provenance-mark :result="counts.idleResult" /></div>
          <div v-if="rosterNotRated" class="panel-body caption text--secondary" data-roster-not-rated>{{ rosterNotRated }}</div>
          <div class="panel-foot caption text--secondary">
            Age is the species' graduation age plus the years since the commander's career began, to one decimal; the age range is inclusive. Health risk is the game's own figure (1 is the healthiest); its scale isn't documented.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Review the careers of commanders who are prisoners, retired or dead." elevation="1">
          <div class="panel-head">
            <span>Former commanders<provenance-mark rule="commanders.groupCount" /></span>
            <v-btn-toggle :value="formerGroup" mandatory dense @change="(value) => (formerView = value)">
              <v-btn v-for="group in formerGroups" :key="group.value" :value="group.value" :disabled="!group.count" small>{{ group.text }} ({{ count(group.count) }})</v-btn>
            </v-btn-toggle>
          </div>
          <v-data-table v-if="formerShown.length" :key="formerGroup === 'held' ? 'held' : 'own'" :headers="formerHeaders" :items="formerShown" item-key="CommanderID" :show-expand="formerGroup !== 'held'" :custom-sort="sortRows" :sort-by.sync="formerTable.sortBy" :sort-desc.sync="formerTable.sortDesc" :items-per-page.sync="formerTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: formerPageSizes }" class="roster-table">
            <template #[`header.lastTime`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.recordDate" /></span></template>
            <template #[`header.age`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.age" /></span></template>
            <template #[`header.kills`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.kills" /></span></template>
            <template #[`header.medalTotal`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.medals" /></span></template>
            <template #[`header.bonusList`]="{ header }"><span>{{ header.text }}<provenance-mark rule="commanders.bonusValue" /></span></template>
            <template #[`item.Name`]="{ item }">
              <div class="py-2">
                <span class="font-weight-medium">{{ item.Name }}</span>
                <v-icon v-if="item.StoryCharacter" small class="ml-1" title="Story character">mdi-book-open-variant</v-icon>
                <div class="caption text--secondary">{{ item.typeLabel }}</div>
              </div>
            </template>
            <template #[`item.rankLabel`]="{ item }">
              <span :title="item.RankName">{{ item.rankLabel }}</span>
            </template>
            <template #[`item.statusLabel`]="{ item }">
              <div>{{ item.statusLabel }}</div>
              <div v-if="item.statusNote" class="caption text--secondary">{{ item.statusNote }}</div>
            </template>
            <template #[`item.lastTime`]="{ item }">
              <template v-if="item.lastResult">
                <div>{{ item.lastDate }}<provenance-mark v-if="item.lastResult.status === 'unavailable'" :result="item.lastResult" /></div>
                <div class="caption text--secondary">{{ item.lastText }}</div>
              </template>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.age`]="{ item }">
              <span v-if="item.age === null" class="text--secondary">—</span>
              <span v-else>{{ item.age }}</span><provenance-mark :result="item.ageResult" />
            </template>
            <template #[`item.kills`]="{ item }">
              <span :class="{ 'text--secondary': !item.kills }" :title="`${count(item.KillTonnageMilitary)} t military, ${count(item.KillTonnageCommercial)} t commercial`">{{ count(item.kills) }}</span><provenance-mark :result="item.killsResult" />
            </template>
            <template #[`item.medalTotal`]="{ item }">
              <span :class="{ 'text--secondary': !item.medalTotal }" :title="item.Medals || undefined">{{ count(item.medalTotal) }}</span><provenance-mark :result="item.medalsResult" />
            </template>
            <template #[`item.bonusList`]="{ item }">
              <span v-for="bonus in item.bonusList" :key="bonus.id" class="bonus-chip" :title="bonus.description">{{ bonus.abbrev }} {{ bonus.text }}</span>
            </template>
            <template #[`item.Processed`]="{ item }">
              {{ item.Processed === null || item.Processed === undefined ? '—' : item.Processed ? 'Yes' : 'Not yet' }}
            </template>
            <template v-if="formerGroup !== 'held'" #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div v-if="item.Notes" class="mb-2"><span class="text--secondary">Notes:</span> {{ item.Notes }}</div>
                <div v-if="item.history.length" class="caption text--secondary mb-1">Career<provenance-mark rule="commanders.recordDate" /></div>
                <div v-for="(entry, index) in item.history" :key="index" class="career-line">
                  <span class="text--secondary career-date">{{ recordText(entry.GameTime) }}</span><provenance-mark v-if="recordGap(entry.GameTime)" :result="recordGap(entry.GameTime)" />{{ entry.HistoryText }}
                </div>
                <div v-if="!item.history.length" class="text--secondary">The save holds no career record for this commander.</div>
              </td>
            </template>
          </v-data-table>
          <div v-else class="panel-body caption text--secondary">No commander of this race is a prisoner, retired or dead in the save, and the race holds no prisoners.</div>
          <div v-if="unsettled" class="panel-body caption text--secondary">{{ count(unsettled) }} commanders have no stored retirement or prisoner flag, so they are in neither the roster nor these groups and the counts are lower bounds.<provenance-mark :result="formerGroups[0].result" /></div>
          <div class="panel-foot caption text--secondary">
            The game deletes a commander who retires or dies when the game is saved, unless Retain is pressed for them in the Commanders window; prisoners are always kept. A prisoner's captor is the race owning the ship or colony that holds them, as the race knows it. Age at death counts to the commander's last career record. Expand a row for the full career.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Review naval admin commands, fleets and ships or ground formations, with the commander in each post." elevation="1" data-structure>
          <div class="panel-head">
            <span>Command structure</span>
            <span class="d-flex align-center flex-wrap controls">
              <v-chip x-small label color="warning" class="mr-2" data-wip-chip>WIP</v-chip>
              <v-switch v-if="structureView === 'naval'" v-model="shippingLines" label="Shipping lines" dense hide-details class="mt-0 mr-4" data-structure-shipping-lines />
              <v-btn-toggle v-model="structureView" mandatory dense>
                <v-btn v-for="view in structureViews" :key="view.value" :value="view.value" small>{{ view.text }}</v-btn>
              </v-btn-toggle>
              <v-btn small text :disabled="!structureExportable" class="ml-2" aria-label="Download the command structure as CSV" data-structure-csv @click="downloadStructure('csv')"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
              <v-btn small text :disabled="!structureExportable" aria-label="Download the command structure as Markdown" data-structure-markdown @click="downloadStructure('markdown')"><v-icon small left>mdi-download</v-icon>Markdown</v-btn>
            </span>
          </div>
          <wip-notice title="The command structure" panel />
          <load-state :failed="structureState.failed" :error="structureState.error" :loading="structureState.loading" class="px-6" @retry="retryStructure" />
          <div v-if="structureNotice" class="panel-body caption text--secondary" data-structure-notice>{{ structureNotice }}</div>
          <template v-if="structureExportable">
            <div class="panel-body d-flex align-center pt-0 branch-export">
              <v-autocomplete v-model="structureBranch" :items="structureBranches" label="Branch" placeholder="Any command or formation" dense hide-details clearable class="branch-picker mt-0 pt-0" aria-label="Branch to export on its own" data-structure-branch />
              <v-btn small text :disabled="!chosenBranch" class="ml-2" aria-label="Download the chosen branch as Markdown" data-structure-branch-markdown @click="downloadBranch"><v-icon small left>mdi-download</v-icon>Branch</v-btn>
            </div>
            <div class="panel-body caption text--secondary" data-structure-summary>{{ structureSummary }}</div>
            <v-data-table :headers="structureHeaders" :items="structureRows" item-key="key" :items-per-page.sync="structureTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: structurePageSizes }" class="roster-table" data-structure-table>
              <template #[`item.Name`]="{ item }">
                <span :style="{ paddingLeft: `${Math.min(item.Depth, 12) * 16}px` }" :data-structure-name="item.key">{{ item.Name === null || item.Name === '' ? '—' : item.Name }}</span>
              </template>
              <template #[`item.Holder`]="{ item }">
                <span v-if="item.Holder" data-structure-holder>{{ item.Holder }}</span>
                <span v-else class="text--secondary" data-structure-holder>—</span>
              </template>
            </v-data-table>
          </template>
          <div class="panel-foot caption text--secondary">
            Export the structure as CSV or Markdown. The naval structure leaves out the fleets and ships of shipping lines unless Shipping lines is on, which lists them, marks them in their own column and includes them in both exports. A fleet is not a post. An entry whose parent is missing, belongs to another race or loops appears at the top level with a note. A post whose holders cannot be told is not marked vacant. The CSV has one row per entry, with its path from the top. Both filenames use the empire's name, or the game and race IDs when the name has no usable form. The Markdown file lists every entry nested under its parent. It begins with a Mermaid diagram of the admin commands or of the formations that head others, which GitHub and Obsidian can render. The diagram is omitted above {{ diagramLimit }} such units. Branch exports one admin command or formation and everything under it as a Markdown file of its own. Its diagram is also omitted above {{ diagramLimit }} units, so a large organisation is drawn a branch at a time.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import WipNotice from '../components/page/WipNotice.vue'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { AGE_NOTES, COLONY_ADMINISTRATION, COMMANDER_TYPES, POSTS, RESEARCH_ADMINISTRATION, RETIRE_STATUSES, SERVING_COMMANDER, ageBound, ageResult, assignmentResult, bonusSuggestionCount, bonusValueResult, captainlessShips, commanderCounts, formatBonus, formerGroupCounts, formerKind, governorReview, killsResult, medalsResult, neutralBonus, parseBonuses, rankLabel, recordDate, researchSuggestions, rosterChoices, rosterFilter, rosterParts, shipSuggestions } from '../utilities/commanders'
import { linkTo, queryId } from '../utilities/deep-links'
import { loadGroundFormationPosts } from '../utilities/ground-formations'
import { DIAGRAM_LIMIT, hierarchyBranches, hierarchyExport, hierarchyNotice, hierarchyRows, hierarchySummary } from '../utilities/hierarchy-export'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { UNKNOWN_TEXT, countText, isKnownNumber, roundToDecimal } from '../utilities/math'
import { loadNavalHierarchy } from '../utilities/naval-hierarchy'
import { describeResult, isAvailable, valueOrNull } from '../utilities/provenance'

const INPUT_LABELS = {
  commanders: 'the commanders',
  bonusTypes: 'the bonus types',
  traits: 'the traits',
  colonies: 'the colonies',
  ships: 'the specialist ships',
  projects: 'the research projects',
  former: 'the former commanders',
  formerHistory: 'their careers',
  held: 'the prisoners held',
  unsettled: 'the commanders with no stored status',
  navalTree: 'the naval command structure',
  groundTree: 'the ground command structure',
}
// The reads of the command structure panel alone: the roster and the rest of the page never wait for them, and a failure of one is shown on that panel.
const OPTIONAL_INPUTS = ['navalTree', 'groundTree']
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key))
// Chips shown per commander in the roster; the rest are in the tooltip-free count.
const ROSTER_BONUSES = 6
// Unavailable assignments named under a suggestion table; the rest are counted.
const UNRATED_SHOWN = 8
const FORMER_GROUPS = [
  { value: 'prisoner', text: 'Prisoners' },
  { value: 'retired', text: 'Retired' },
  { value: 'dead', text: 'Dead' },
  { value: 'held', text: 'Alien prisoners' },
]
const ROSTER_PAGE_SIZES = [25, 50, 100]
const SHIP_PAGE_SIZES = [15, 30, -1]
const FORMER_PAGE_SIZES = [15, 50, -1]
const STRUCTURE_PAGE_SIZES = [25, 50, 100]
const STRUCTURE_VIEWS = [
  { value: 'naval', text: 'Naval' },
  { value: 'ground', text: 'Ground' },
]
const STRUCTURE_HEADERS = [
  { text: 'Name', value: 'Name', sortable: false },
  { text: 'Kind', value: 'Kind', sortable: false },
  { text: 'ID', value: 'ID', sortable: false, align: 'end' },
  { text: 'Post', value: 'Post', sortable: false },
  { text: 'Holder', value: 'Holder', sortable: false },
  { text: 'Vacancy', value: 'Vacancy', sortable: false },
  { text: 'Note', value: 'Note', sortable: false },
]
const SHIPPING_LINE_HEADER = { text: 'Shipping line', value: 'Shipping line', sortable: false }
// An age bound that is stored: a number of years from 0, or null when the bound is off.
const validBound = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

export default {
  name: 'CommandersPage',
  components: { LoadState, PageLink, ProvenanceMark, StatTiles, WipNotice },
  mixins: [
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      suggestionView: { key: 'commandersSuggestionView', default: 'governors', valid: oneOf(['governors', 'ships', 'research']) },
      shipTable: tableView('commandersShipsTable', { itemsPerPage: 15, itemsPerPageOptions: SHIP_PAGE_SIZES }),
      typeId: { key: 'commandersType', default: 0, valid: oneOf(COMMANDER_TYPES.map((type) => type.id)) },
      unassignedOnly: { key: 'commandersUnassignedOnly', default: false },
      search: { key: 'commandersSearch', default: '', scope: 'race' },
      bonusId: { key: 'commandersBonus', default: null },
      fieldId: { key: 'commandersField', default: null },
      postFilter: { key: 'commandersPost', default: null },
      rankFilter: { key: 'commandersRank', default: null },
      ageMin: { key: 'commandersAgeMin', default: null, valid: validBound },
      ageMax: { key: 'commandersAgeMax', default: null, valid: validBound },
      structureView: { key: 'commandersStructureView', default: 'naval', valid: oneOf(STRUCTURE_VIEWS.map((view) => view.value)) },
      shippingLines: { key: 'commandersShippingLines', default: false, valid: (value) => typeof value === 'boolean' },
      structureTable: tableView('commandersStructureTable', { itemsPerPage: 25, itemsPerPageOptions: STRUCTURE_PAGE_SIZES }),
      rosterTable: tableView('commandersRosterTable', { sortDesc: [], itemsPerPage: 25, itemsPerPageOptions: ROSTER_PAGE_SIZES }),
      formerView: { key: 'commandersFormerView', default: 'prisoner', valid: oneOf(FORMER_GROUPS.map((group) => group.value)) },
      formerOwnTable: tableView('commandersFormerOwnTable', { sortBy: ['lastTime'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: FORMER_PAGE_SIZES }),
      formerHeldTable: tableView('commandersFormerHeldTable', { sortBy: ['raceName'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: FORMER_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      rosterPageSizes: ROSTER_PAGE_SIZES,
      shipPageSizes: SHIP_PAGE_SIZES,
      formerPageSizes: FORMER_PAGE_SIZES,
      structurePageSizes: STRUCTURE_PAGE_SIZES,
      structureViews: STRUCTURE_VIEWS,
      diagramLimit: DIAGRAM_LIMIT,
      ageNotes: AGE_NOTES,
      focusCommanderId: null,
      focusColonyId: null,
      structureBranch: null,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear']),
    ...mapState('empires', ['games']),

    // The selected race's title, from the empire list the rail and Settings read it from: the name the Markdown export is titled and named with.
    empireName() {
      const game = this.games.find((entry) => entry.GameID === this.GameID)
      const race = game && game.Races.find((entry) => entry.RaceID === this.RaceID)

      return race ? race.RaceTitle : ''
    },

    // The branches of the listed structure that can be exported on their own (each admin command, or formation that heads others), as the branch picker offers them: the branch's name first, so the chosen one reads in the field, how many units its diagram draws or that it has too many to draw, and the entries above it, which the search also reads.
    structureBranches() {
      return this.structureExportable ? hierarchyBranches(this.structureModel, this.structureView).map((branch) => ({ value: branch.key, text: `${branch.name || `${branch.kind} ${branch.id}`} · ${branch.units > DIAGRAM_LIMIT ? `${this.count(branch.units)} units, too many to draw` : `${this.count(branch.units)} ${branch.units === 1 ? 'unit' : 'units'} drawn`}${branch.above ? ` · under ${branch.above}` : ''}` })) : []
    },

    // The branch to export: the one picked, while the listed structure still has it.
    chosenBranch() {
      return this.structureBranches.some((branch) => branch.value === this.structureBranch) ? this.structureBranch : null
    },

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    // The column groups the save has, { rank, age }, from the capability check of this page (store/capabilities.js); null until it has answered, and the queries then wait for it (`partsFor`).
    rosterGroups() {
      const report = this.$store.getters['capabilities/report']('/commanders')

      return report ? report.groups : null
    },

    // The bonus IDs whose row in the save does not read as the planners expect: the figures resting on their meaning are left unavailable.
    blockedBonuses() {
      return this.$store.getters['capabilities/blockedBonuses']
    },

    bonusTypeById() {
      return Object.fromEntries(this.bonusTypes.map((bonus) => [bonus.BonusID, bonus]))
    },

    traitById() {
      return Object.fromEntries(this.traits.map((trait) => [trait.TraitID, trait.Name]))
    },

    // Every commander with parsed bonuses and traits.
    people() {
      return this.commanders.map((commander) => ({
        ...commander,
        bonuses: parseBonuses(commander.Bonuses, this.blockedBonuses),
        traitIds: (commander.Traits || '').split(',').filter(Boolean).map(Number),
      }))
    },

    byType() {
      const groups = Object.fromEntries(COMMANDER_TYPES.map((type) => [type.id, []]))

      this.people.forEach((person) => {
        if (groups[person.CommanderType]) {
          groups[person.CommanderType].push(person)
        }
      })

      return groups
    },

    bonusNames() {
      return Object.fromEntries(this.bonusTypes.map((bonus) => [bonus.BonusID, bonus.Description]))
    },

    counts() {
      return commanderCounts(this.people, this.unsettled)
    },

    commanderTypes() {
      return this.counts.types
    },

    governorAssessment() {
      return governorReview(this.colonies, this.byType[2], this.bonusNames)
    },

    governorRows() {
      return this.governorAssessment.rows.map((row) => ({ ...row, key: row.colony.PopulationID }))
    },

    governorStats() {
      return this.governorAssessment.coverage
    },

    shipAssessment() {
      return shipSuggestions(this.ships, this.byType[0], this.bonusNames, this.blockedBonuses)
    },

    shipRows() {
      return this.shipAssessment.rows.map((row) => ({ ...row, key: row.ship.ShipID }))
    },

    researchAssessment() {
      return researchSuggestions(this.projects, this.byType[3], this.blockedBonuses)
    },

    researchRows() {
      return this.researchAssessment.rows.map((row) => ({ ...row, key: row.project.ProjectID }))
    },

    tiles() {
      const { counts } = this
      const stats = this.governorStats
      const captainless = captainlessShips(this.ships)
      const suggestions = bonusSuggestionCount(this.governorAssessment, this.shipAssessment, this.researchAssessment)
      const tile = (value, results, fields) => ({ ...fields, value, title: `${value}. ${results.map(describeResult).join('. ')}` })
      const captainNote = captainless.value ? `${this.count(captainless.value)} specialist ships without a captain` : captainless.unknown ? 'No specialist ship of a known class lacks a captain' : 'Every specialist ship has a captain'
      const vacantNotes = [captainNote, captainless.unknown ? `${this.count(captainless.unknown)} captainless ships of unknown class` : '', stats.popGaps ? `${this.count(stats.popGaps)} colonies without a governor and no stored population` : ''].filter(Boolean).join(', ')
      const typeNote = [...counts.types.map((type) => `${this.count(type.total)} ${type.plural.toLowerCase()}`), counts.untyped ? `${this.count(counts.untyped)} with no stored type` : '', counts.unsettled ? `${this.count(counts.unsettled)} with no stored status, not counted` : ''].filter(Boolean).join(', ')
      const idleNote = [...counts.types.map((type) => `${this.count(type.idle)} ${type.label.toLowerCase()}`), counts.noPost ? `${this.count(counts.noPost)} with no stored post, not counted` : ''].filter(Boolean).join(', ')
      const suggestionNote = `${this.count(this.governorRows.length)} governor improvements, ${this.count(this.shipRows.length)} specialist ships, ${this.count(this.researchRows.length)} research projects${suggestions.unknown ? `, ${this.count(suggestions.unknown)} assignments cannot be rated` : ''}`

      return [
        tile(this.count(counts.total), [counts.totalResult], { label: 'Commanders', note: typeNote }),
        tile(this.count(counts.idle), [counts.idleResult], { label: 'Unassigned', note: idleNote }),
        tile(this.count(stats.vacant), [stats.results.vacant, captainless.result], {
          label: 'Colonies without a governor',
          note: vacantNotes,
          icon: stats.vacant || captainless.value ? 'mdi-account-alert' : null,
          iconColor: 'warning',
        }),
        tile(this.count(suggestions.value), [suggestions.result], {
          label: 'Better assignments',
          note: suggestionNote,
          icon: suggestions.value ? 'mdi-swap-horizontal' : suggestions.unknown ? null : 'mdi-check-circle',
          iconColor: suggestions.value ? 'primary' : 'success',
        }),
      ]
    },

    bonusItems() {
      const flag = COMMANDER_TYPES.find((type) => type.id === this.typeId).flag

      return this.bonusTypes.filter((bonus) => bonus[flag]).map((bonus) => ({ text: bonus.Description, value: bonus.BonusID }))
    },

    fieldItems() {
      const fields = {}

      this.byType[3].forEach((scientist) => {
        if (scientist.FieldName) {
          fields[scientist.ResSpecID] = scientist.FieldName
        }
      })

      return Object.entries(fields).map(([value, text]) => ({ text, value: Number(value) })).sort((a, b) => a.text.localeCompare(b.text))
    },

    // The roster after its filters: { kept: [{ person, age }], notRated }. A linked commander is shown whatever the filters say. The rank filter applies only to a type whose commanders have ranks.
    rosterFiltered() {
      if (this.focusCommanderId) {
        return { kept: this.people.filter((person) => person.CommanderID === this.focusCommanderId).map((person) => ({ person, age: ageResult(person, person.GameTime) })), notRated: { post: 0, rank: 0, age: 0 } }
      }

      return rosterFilter(this.byType[this.typeId], { search: this.search, unassignedOnly: this.unassignedOnly, fieldId: this.fieldId, typeId: this.typeId, bonusId: this.bonusId, post: this.postFilter, rank: this.rankItems.length ? this.rankFilter : null, ageMin: this.ageAvailable ? this.ageMin : null, ageMax: this.ageAvailable ? this.ageMax : null })
    },

    rosterRows() {
      return this.rosterFiltered.kept.map(({ person, age }) => {
        const known = isKnownNumber(person.CommandType)

        return {
          ...person,
          Age: valueOrNull(age),
          ageResult: age,
          post: known ? POSTS[person.CommandType] || `Post ${person.CommandType}` : UNKNOWN_TEXT,
          assignment: !known ? null : person.CommandType === 0 ? '' : `${POSTS[person.CommandType] || ''} ${person.AssignmentName || ''}`,
          assignmentMark: known ? null : assignmentResult(person),
          rankLabel: rankLabel(person),
          rankSort: isKnownNumber(person.RankLevel) ? person.RankLevel : person.CommanderType === 2 || person.CommanderType === 3 ? 0 : null,
          selectedBonus: this.bonusId === null ? null : person.bonuses[this.bonusId] ?? null,
          selectedBonusResult: this.bonusId === null ? null : bonusValueResult(person, this.bonusId, (this.bonusTypeById[this.bonusId] || {}).Description || `bonus ${this.bonusId}`),
          bonusList: this.topBonuses(person.bonuses),
          traitNames: person.traitIds.map((id) => this.traitById[id] || `Trait ${id}`),
          traitCount: person.traitIds.length,
        }
      })
    },

    // The posts and ranks the chosen type holds, as the choices of the post and rank filters.
    filterChoices() {
      return rosterChoices(this.byType[this.typeId])
    },

    postItems() {
      return this.filterChoices.posts
    },

    rankItems() {
      return this.rankAvailable ? this.filterChoices.ranks : []
    },

    // Whether the save has the column groups the rank and age filters rest on: with a group missing its filter is inert, whatever bound is stored. Unknown (no report yet) counts as present, since the roster waits for the report.
    rankAvailable() {
      return !this.rosterGroups || this.rosterGroups.rank !== false
    },

    ageAvailable() {
      return !this.rosterGroups || this.rosterGroups.age !== false
    },

    // The commanders an active filter could not rate for a value the save does not store, in words; empty when none.
    rosterNotRated() {
      const { post, rank, age } = this.rosterFiltered.notRated

      return [post ? `${this.count(post)} commanders with no stored post are not shown by the post filter.` : '', rank ? `${this.count(rank)} commanders with no stored rank are not shown by the rank filter.` : '', age ? `${this.count(age)} commanders whose age cannot be worked out are not shown by the age range.` : ''].filter(Boolean).join(' ')
    },

    // The reads that hold the page back: every one but the command structure's, which have their own note.
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    // The command structure panel's reads: loading until each has settled, else the words naming the failed ones with the first message. The panel lists nothing from a read that is in flight or failed.
    structureState() {
      const failed = OPTIONAL_INPUTS.filter((key) => this.loadErrors[key])

      return { loading: failed.length === 0 && !allLoaded(this.loadErrors, OPTIONAL_INPUTS), failed: joinLabels(failed.map((key) => INPUT_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
    },

    // The model of the chosen structure, null until its read is in, while it is read again for changed inputs (the plugin keeps the earlier value until then) and after it failed.
    structureModel() {
      const model = this.structureView === 'naval' ? this.navalTree : this.groundTree

      return this.structureState.failed || this.loadErrors[this.structureView === 'naval' ? 'navalTree' : 'groundTree'] !== null || !model ? null : model
    },

    structureExportable() {
      return Boolean(this.structureModel && this.structureModel.supported)
    },

    // What the panel says instead of, or beside, the table: the save lacks what the structure reads, or the serving commanders.
    structureNotice() {
      return this.structureModel ? hierarchyNotice(this.structureModel, this.structureView) : null
    },

    structureSummary() {
      return this.structureExportable ? hierarchySummary(this.structureModel, this.structureView) : ''
    },

    // The structure table's columns: the shipping-line mark only where the listed model holds the shipping lines.
    structureHeaders() {
      return this.structureExportable && this.structureModel.shippingLines ? STRUCTURE_HEADERS.flatMap((header) => (header.value === 'Kind' ? [header, SHIPPING_LINE_HEADER] : [header])) : STRUCTURE_HEADERS
    },

    structureRows() {
      return this.structureExportable ? hierarchyRows(this.structureModel, this.structureView).map((row) => ({ ...row, key: row['Path IDs'] })) : []
    },

    // The race's former commanders with their status, captor, last career record and age; the dead age only to their last record.
    formerRows() {
      const { formerHistory } = this
      return this.former.map((person) => {
        const kind = formerKind(person)
        const history = formerHistory[person.CommanderID] || []
        const last = history[0] || null
        const atLast = kind === 'dead' && last
        const age = ageResult(person, atLast ? last.GameTime : person.GameTime, atLast ? 'the time of the last career record' : 'the game time')
        const status = (RETIRE_STATUSES[person.RetireStatus] || {}).label
        const lastResult = last ? recordDate(this.StartYear, last.GameTime) : null
        const kills = killsResult(person)
        const medals = medalsResult(person)

        return {
          ...person,
          kind,
          history,
          typeLabel: (COMMANDER_TYPES.find((type) => type.id === person.CommanderType) || {}).label || '',
          rankLabel: rankLabel(person),
          statusLabel: kind === 'prisoner' ? `Prisoner${person.CaptorID ? ` of ${person.CaptorName || 'an unknown race'}` : ''}` : status || 'Retired',
          statusNote: kind !== 'prisoner' && person.Prisoner ? 'While a prisoner' : '',
          age: valueOrNull(age),
          ageResult: age,
          lastTime: last && isKnownNumber(last.GameTime) ? last.GameTime : null,
          lastResult,
          lastDate: lastResult ? valueOrNull(lastResult) ?? UNKNOWN_TEXT : '',
          lastText: last ? last.HistoryText : '',
          kills: valueOrNull(kills),
          killsResult: kills,
          medalTotal: valueOrNull(medals),
          medalsResult: medals,
          bonusList: this.topBonuses(parseBonuses(person.Bonuses, this.blockedBonuses)),
        }
      })
    },

    heldRows() {
      return this.held.map((person) => ({
        ...person,
        typeLabel: (COMMANDER_TYPES.find((type) => type.id === person.CommanderType) || {}).label || '',
        raceName: person.AlienRaceName || 'Unknown race',
        heldAt: person.ShipName ? `Aboard ${person.ShipName}` : `At ${person.PopName}`,
      }))
    },

    formerGroups() {
      const counts = formerGroupCounts(this.formerRows, this.heldRows, this.unsettled)

      return FORMER_GROUPS.map((group) => ({ ...group, count: counts[group.value].value, result: counts[group.value] }))
    },

    // The chosen group, or the first with anyone in it when the chosen one is empty.
    formerGroup() {
      const chosen = this.formerGroups.find((group) => group.value === this.formerView)

      return chosen.count ? chosen.value : (this.formerGroups.find((group) => group.count) || chosen).value
    },

    // The table of the chosen former-commanders group: the prisoners the race holds have their own columns, the others share.
    formerTable() {
      return this.formerGroup === 'held' ? this.formerHeldTable : this.formerOwnTable
    },

    formerShown() {
      return this.formerGroup === 'held' ? this.heldRows : this.formerRows.filter((person) => person.kind === this.formerGroup)
    },

    formerHeaders() {
      if (this.formerGroup === 'held') {
        return [
          { text: 'Name', value: 'Name' },
          { text: 'Race', value: 'raceName' },
          { text: 'Rank', value: 'RankName' },
          { text: 'Held', value: 'heldAt' },
          { text: 'Interrogated', value: 'Processed' },
        ]
      }

      return [
        { text: 'Name', value: 'Name' },
        { text: 'Rank', value: 'rankLabel' },
        { text: 'Status', value: 'statusLabel' },
        { text: 'Last record', value: 'lastTime' },
        { text: this.formerGroup === 'dead' ? 'Age at death' : 'Age', value: 'age', align: 'end' },
        { text: 'Kills (t)', value: 'kills', align: 'end' },
        { text: 'Medals', value: 'medalTotal', align: 'end' },
        { text: 'Bonuses', value: 'bonusList', sortable: false },
        { text: '', value: 'data-table-expand' },
      ]
    },

    rosterHeaders() {
      const headers = [
        { text: 'Name', value: 'Name' },
        { text: this.typeId === 3 ? 'Field' : 'Rank', value: 'rankSort' },
        { text: 'Assignment', value: 'assignment' },
        { text: 'Age', value: 'Age', align: 'end' },
        { text: 'Health risk', value: 'HealthRisk', align: 'end' },
      ]

      if (this.bonusId !== null) {
        headers.push({ text: (this.bonusTypeById[this.bonusId] || {}).Description || 'Bonus', value: 'selectedBonus', align: 'end' })
      }

      return [...headers, { text: 'Bonuses', value: 'bonusList', sortable: false }, { text: 'Traits', value: 'traitCount', align: 'end' }]
    },

    governorHeaders() {
      return [
        { text: 'Colony', value: 'colony', sortable: false },
        { text: 'Governor', value: 'governor', sortable: false },
        { text: 'Better candidate', value: 'candidate', sortable: false },
      ]
    },

    shipHeaders() {
      return [
        { text: 'Ship', value: 'ship', sortable: false },
        { text: 'Post', value: 'post', sortable: false },
        { text: 'Now', value: 'holder', sortable: false },
        { text: 'Better candidate', value: 'candidate', sortable: false },
      ]
    },

    researchHeaders() {
      return [
        { text: 'Project', value: 'project', sortable: false },
        { text: 'Scientist', value: 'holder', sortable: false },
        { text: 'Better candidate', value: 'candidate', sortable: false },
      ]
    },

    navalRanks() {
      const names = {}

      this.byType[0].forEach((officer) => {
        if (officer.RankLevel) {
          names[officer.RankLevel] = officer.RankName
        }
      })

      return names
    },

    focusPerson() {
      return this.focusCommanderId ? this.people.find((person) => person.CommanderID === this.focusCommanderId) || null : null
    },

    focusColony() {
      return this.focusColonyId ? this.colonies.find((colony) => colony.PopulationID === this.focusColonyId) || null : null
    },

    focusGovernor() {
      const colony = this.focusColony

      return colony && colony.GovernorID ? this.people.find((person) => person.CommanderID === colony.GovernorID) || null : null
    },

    // What the roster or the governor suggestions are narrowed to, named for the chip that clears it.
    focusText() {
      if (this.focusCommanderId) {
        return this.focusPerson ? `Roster: ${this.focusPerson.Name} only` : 'No serving commander has this ID'
      } else if (this.focusColonyId) {
        return this.focusColony ? `Governor suggestions: ${this.focusColony.PopName}, governed by ${this.focusGovernor ? this.focusGovernor.Name : 'no one'}` : 'No colony of this race has this ID'
      }

      return null
    },

    visibleGovernorRows() {
      return this.focusColonyId ? this.governorRows.filter((row) => row.colony.PopulationID === this.focusColonyId) : this.governorRows
    },

    visibleUnratedGovernors() {
      const { unrated } = this.governorAssessment

      return this.focusColonyId ? unrated.filter((item) => item.colony.PopulationID === this.focusColonyId) : unrated
    },

    // The line above the governor table: the improvement count is not the number of governed colonies, so both are stated.
    governorSummary() {
      const stats = this.governorStats

      if (!stats.colonies) {
        return 'The race has no colonies.'
      }

      const proposed = stats.improvements ? `${this.count(stats.improvements)} improvements, naming ${this.count(stats.candidates)} distinct unassigned ${stats.candidates === 1 ? 'administrator' : 'administrators'}` : '0 improvements'
      const unknown = stats.unknown.assigned + stats.unknown.vacant
      const gaps = [unknown ? `${this.count(unknown)} cannot be rated` : '', stats.popGaps ? `${this.count(stats.popGaps)} without a governor have no stored population` : ''].filter(Boolean).map((text) => ` · ${text}`).join('')
      const noPost = stats.noPostAdmins ? `, and ${this.count(stats.noPostAdmins)} administrators have no stored post` : ''

      return `${this.colonyCount(stats.assigned)} with a governor · ${this.count(stats.vacant)} vacant · ${proposed}${gaps} · ${this.count(stats.idleAdmins)} unassigned administrators, ${this.count(stats.eligibleIdle)} of them holding a bonus some colony requires${noPost}`
    },

    // Why the governor table is empty. A colony filter gets its own reason, never the empire-wide one.
    governorEmptyText() {
      const stats = this.governorStats

      if (this.focusColonyId) {
        return this.focusColony ? `No governor improvement for ${this.focusColony.PopName}. The filter is limited to this colony.` : 'No colony of this race has this ID.'
      }

      return stats.colonies ? `No governor improvements for any colony. ${this.colonyCount(stats.assigned)} with a governor, ${stats.vacant} vacant.` : 'No governor improvements: the race has no colonies.'
    },

    governorEmptyReasons() {
      const stats = this.governorStats
      const reasons = []

      if (this.focusColonyId) {
        const colony = this.focusColony
        const status = colony ? stats.status[colony.PopulationID] : null
        const bonus = colony && colony.BonusOne > 0 ? (this.bonusTypeById[colony.BonusOne] || {}).Description || `#${colony.BonusOne}` : null

        if (status === 'unrated') {
          reasons.push('No required bonus is set for this colony (Governor tab of the Economics window), so no administrator is compared.')
        } else if (status === 'no-candidate') {
          reasons.push(colony.GovernorID ? `No unassigned administrator holds the required bonus (${bonus}), so nobody can replace the current governor.` : `The colony is vacant, and none of the ${this.count(stats.idleAdmins)} unassigned administrators holds the required bonus (${bonus}).`)
        } else if (status === 'not-stronger') {
          reasons.push(`The best unassigned administrator with the required bonus (${bonus}) does not beat the current governor on this colony's bonuses.`)
        }

        reasons.push(stats.improvements ? `${this.count(stats.improvements)} improvements for other colonies are hidden by this filter.` : 'The empire has no governor improvements either.')

        return reasons
      }

      const unrated = stats.unrated.assigned + stats.unrated.vacant
      const unknown = stats.unknown.assigned + stats.unknown.vacant

      if (unrated) {
        reasons.push(`Colonies with no required bonus, so none is compared: ${this.count(unrated)}${stats.unrated.vacant ? ` (${this.count(stats.unrated.vacant)} vacant)` : ''}.`)
      }

      if (unknown) {
        reasons.push(`Colonies that cannot be rated for a missing value: ${this.count(unknown)}.`)
      }

      if (stats.noCandidate.vacant) {
        reasons.push(`Vacant colonies where no unassigned administrator holds the required bonus: ${this.count(stats.noCandidate.vacant)}.`)
      }

      if (stats.noCandidate.assigned) {
        reasons.push(`Governed colonies where no unassigned administrator holds the required bonus: ${this.count(stats.noCandidate.assigned)}.`)
      }

      if (stats.notStronger) {
        reasons.push(`Governed colonies whose governor is at least as strong as the best unassigned candidate: ${this.count(stats.notStronger)}.`)
      }

      if (stats.colonies && !stats.idleAdmins) {
        reasons.push('No administrator is unassigned.')
      } else if (stats.colonies > unrated + unknown && !stats.eligibleIdle) {
        reasons.push(`None of the ${this.count(stats.idleAdmins)} unassigned administrators holds a required bonus of any colony.`)
      }

      return reasons
    },

    linkQuery() {
      return linkTo.commanders({ commander: this.focusCommanderId, colony: this.focusColonyId }).query
    },

    linkLabel() {
      return this.focusPerson ? this.focusPerson.Name : this.focusColony ? this.focusColony.PopName : null
    },
  },
  watch: {
    // Choosing a bonus sorts the roster by it. While a linked commander is shown, the type that follows them, the filters it clears and this sort are for the visit only, so the stored choices stay.
    bonusId(value) {
      const table = { ...this.rosterTable, sortBy: value === null ? [] : ['selectedBonus'], sortDesc: value === null ? [] : [true] }

      if (this.focusCommanderId) {
        this.setUnsaved('rosterTable', table)
      } else {
        this.rosterTable = table
      }
    },
    typeId() {
      ['bonusId', 'fieldId', 'postFilter', 'rankFilter'].forEach((name) => (this.focusCommanderId ? this.setUnsaved(name, null) : (this[name] = null)))
    },
    // A focused commander's roster is the one shown, so the type toggle follows them.
    focusPerson(person) {
      if (person) {
        this.setUnsaved('typeId', person.CommanderType)
      }
    },
  },
  methods: {
    // The SQL parts for the columns the save has (`rosterParts`). With no answer from the capability check yet, this waits for it, so the first read already leaves out what the save lacks; a check that failed reads like a save that has everything.
    async partsFor(groups) {
      if (!groups) {
        await this.$store.dispatch('capabilities/preflight')
      }

      const report = this.$store.getters['capabilities/report']('/commanders')

      return rosterParts(groups || (report ? report.groups : null), { GameID: this.GameID, RaceID: this.RaceID })
    },
    applyLink(query) {
      this.focusCommanderId = queryId(query.commander)
      this.focusColonyId = this.focusCommanderId ? null : queryId(query.colony)

      if (this.focusColonyId) {
        this.setUnsaved('suggestionView', 'governors')
      }
    },
    clearFocus() {
      this.focusCommanderId = null
      this.focusColonyId = null
    },
    colonyLink(populationId) {
      return linkTo.colonyOutlook(populationId)
    },
    systemLink(systemId) {
      return linkTo.map(systemId)
    },
    techLink(techSystemId) {
      return linkTo.techTree({ tech: techSystemId })
    },
    count(value) {
      return countText(value, 0, this.separator)
    },
    plain(value) {
      return isKnownNumber(value) ? value : UNKNOWN_TEXT
    },
    colonyCount(value) {
      return `${this.count(value)} ${value === 1 ? 'colony' : 'colonies'}`
    },
    fixed(value, decimals) {
      return isKnownNumber(value) ? roundToDecimal(value, decimals).toFixed(decimals) : UNKNOWN_TEXT
    },
    // Ratings rank above multipliers, then the bigger bonus first.
    bonusWeight({ id, value }) {
      return value === null ? -1 : id === COLONY_ADMINISTRATION || id === RESEARCH_ADMINISTRATION ? 10 + value : value
    },
    // The strongest bonuses as roster chips.
    topBonuses(bonuses) {
      const { bonusTypeById } = this
      return Object.entries(bonuses).map(([id, value]) => ({ id: Number(id), value })).sort((a, b) => this.bonusWeight(b) - this.bonusWeight(a)).slice(0, ROSTER_BONUSES).map((bonus) => ({
        id: bonus.id,
        abbrev: (bonusTypeById[bonus.id] || {}).BonusAbbrev || `#${bonus.id}`,
        description: (bonusTypeById[bonus.id] || {}).Description || `Bonus ${bonus.id}`,
        text: formatBonus(bonus.id, bonus.value, this.blockedBonuses),
      }))
    },
    recordText(seconds) {
      return valueOrNull(recordDate(this.StartYear, seconds)) ?? UNKNOWN_TEXT
    },
    recordGap(seconds) {
      const result = recordDate(this.StartYear, seconds)

      return isAvailable(result) ? null : result
    },
    bonusText(bonusId, value) {
      return this.blockedBonuses.has(bonusId) ? `${(this.bonusTypeById[bonusId] || {}).Description || 'Bonus'} ${UNKNOWN_TEXT}` : value === null || value === undefined ? 'none' : `${(this.bonusTypeById[bonusId] || {}).Description || 'Bonus'} ${formatBonus(bonusId, value, this.blockedBonuses)}`
    },
    rating(admin) {
      const value = admin.bonuses[COLONY_ADMINISTRATION]

      return value === null ? 'unknown' : value ? Math.round(value) : '—'
    },
    rankName(level) {
      return this.navalRanks[level] || `rank ${level}`
    },
    colonyBonuses(colony) {
      return [colony.BonusOne, colony.BonusTwo, colony.BonusThree].filter((id) => id > 0).map((id) => (this.bonusTypeById[id] || {}).Description || `#${id}`).join(', then ')
    },
    keyLabel(colony, key) {
      // A missing bonus row ranks as no effect (1 for a multiplier, 0 for a rating); show it as "none" rather than +0%.
      return [colony.BonusOne, colony.BonusTwo, colony.BonusThree].map((id, index) => (id > 0 ? `${(this.bonusTypeById[id] || {}).BonusAbbrev || id} ${key[index] === neutralBonus(id) ? 'none' : formatBonus(id, key[index], this.blockedBonuses)}` : null)).filter(Boolean).join(', ')
    },
    // A column of null-last values: an unavailable figure sorts after every value, in either direction, never as 0.
    sortRows(items, sortBy, sortDesc) {
      const [by] = sortBy

      if (!by) {
        return items
      }

      const direction = sortDesc[0] ? -1 : 1
      const missing = (value) => value === null || value === undefined

      return [...items].sort((a, b) => {
        const x = a[by]
        const y = b[by]

        if (missing(x) || missing(y)) {
          return missing(x) === missing(y) ? 0 : missing(x) ? 1 : -1
        }

        return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y) * direction
      })
    },
    missingText(result) {
      return result.inputs.missing.join(', ')
    },
    unratedShown(list) {
      return list.slice(0, UNRATED_SHOWN)
    },
    unratedMore(list) {
      return Math.max(0, list.length - UNRATED_SHOWN)
    },
    // The age range's bound as typed: a number, or null when the field is empty or not a number.
    setAge(name, value) {
      this[name] = ageBound(value)
    },
    retryStructure() {
      OPTIONAL_INPUTS.filter((key) => this.loadErrors[key]).forEach((key) => this.$asyncComputed[key].update())
    },
    // The text, file name and type of the chosen structure in a format ('csv' or 'markdown'), or of one of its branches as Markdown, or null while there is nothing to export.
    structureExport(format, branch = null) {
      return this.structureExportable ? hierarchyExport(this.structureModel, this.structureView, format, this.empireName, branch) : null
    },
    downloadBranch() {
      if (this.chosenBranch) {
        this.downloadStructure('markdown', this.chosenBranch)
      }
    },
    downloadStructure(format, branch = null) {
      const file = this.structureExport(format, branch)

      if (!file) {
        return
      }

      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([file.text], { type: file.type }))
      link.download = file.fileName
      link.click()
      URL.revokeObjectURL(link.href)
    },
  },
  asyncComputed: {
    // Every serving commander of the race (not retired, dead or a prisoner), with rank level (1 is the lowest rank), age, assignment name, and bonuses and traits as "id:value" / "id" lists.
    commanders: {
      get: tracked('commanders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const parts = await this.partsFor(this.rosterGroups)

        return await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommanderType, FCT_Commander.CommandType, FCT_Commander.CommandID, FCT_Commander.ResSpecID, DIM_ResearchField.FieldName, FCT_Commander.HealthRisk, FCT_Commander.StoryCharacter, ${parts.rankColumns}, ${parts.rankLevel}, ${parts.ageColumn}, FCT_Commander.CareerStart, FCT_Game.GameTime, case when FCT_Commander.CommandType in (1, 8, 9, 10, 11, 15) then VIR_Ship.ShipName when FCT_Commander.CommandType in (3, 17) then VIR_Population.PopName when FCT_Commander.CommandType = 4 then FCT_SectorCommand.SectorName when FCT_Commander.CommandType = 5 then FCT_GroundUnitFormation.Name when FCT_Commander.CommandType = 12 then FCT_NavalAdminCommand.AdminCommandName when FCT_Commander.CommandType = 7 then FCT_TechSystem.Name end as AssignmentName, VIR_Bonuses.Bonuses, VIR_Traits.Traits from FCT_Commander inner join FCT_Game on FCT_Game.GameID = FCT_Commander.GameID ${parts.ageJoin} ${parts.rankJoin} ${parts.levelJoin} left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_Commander.ResSpecID and FCT_Commander.CommanderType = 3 left join FCT_Ship as VIR_Ship on VIR_Ship.ShipID = FCT_Commander.CommandID and FCT_Commander.CommandType in (1, 8, 9, 10, 11, 15) left join FCT_Population as VIR_Population on VIR_Population.PopulationID = FCT_Commander.CommandID and FCT_Commander.CommandType in (3, 17) left join FCT_SectorCommand on FCT_SectorCommand.SectorCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 4 left join FCT_GroundUnitFormation on FCT_GroundUnitFormation.FormationID = FCT_Commander.CommandID and FCT_Commander.CommandType = 5 left join FCT_NavalAdminCommand on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 12 left join FCT_ResearchProject on FCT_ResearchProject.ProjectID = FCT_Commander.CommandID and FCT_Commander.CommandType = 7 left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID left join (select FCT_CommanderBonuses.CommanderID, group_concat(FCT_CommanderBonuses.BonusID || ':' || coalesce(FCT_CommanderBonuses.BonusValue, ''), ',') as Bonuses from FCT_CommanderBonuses inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderBonuses.CommanderID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderBonuses.CommanderID) as VIR_Bonuses on VIR_Bonuses.CommanderID = FCT_Commander.CommanderID left join (select FCT_CommanderTraits.CmdrID as CommanderID, group_concat(FCT_CommanderTraits.TraitID, ',') as Traits from FCT_CommanderTraits inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderTraits.CmdrID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderTraits.CmdrID) as VIR_Traits on VIR_Traits.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and ${SERVING_COMMANDER} order by FCT_Commander.CommanderType, FCT_Commander.Seniority`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    bonusTypes: {
      get: tracked('bonusTypes', async function () {
        if (!this.database) {
          return []
        }

        return await this.database.query('select DIM_CommanderBonusType.BonusID, DIM_CommanderBonusType.Description, DIM_CommanderBonusType.BonusAbbrev, DIM_CommanderBonusType.Naval, DIM_CommanderBonusType.Ground, DIM_CommanderBonusType.Civilian, DIM_CommanderBonusType.Scientist from DIM_CommanderBonusType order by DIM_CommanderBonusType.DisplayOrder').then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    traits: {
      get: tracked('traits', async function () {
        if (!this.database) {
          return []
        }

        return await this.database.query('select DIM_TraitsList.TraitID, DIM_TraitsList.Name from DIM_TraitsList').then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Colonies with their governor and the bonuses the game ranks governors by (Governor tab).
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Importance, FCT_Population.BonusOne, FCT_Population.BonusTwo, FCT_Population.BonusThree, VIR_Governor.CommanderID as GovernorID from FCT_Population left join (select FCT_Commander.CommanderID, FCT_Commander.CommandID from FCT_Commander where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.Deceased = 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and (FCT_Population.Population > 0 or FCT_Population.Population is null or VIR_Governor.CommanderID is not null) order by FCT_Population.Importance desc, FCT_Population.Population desc`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Terraformers, orbital miners, harvesters and survey ships, with their captain and science officer and whether the class has a Science Department.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const parts = await this.partsFor(this.rosterGroups)

        return await this.database.query(`with VIR_ShipCommanders as materialized (select CommanderID, CommandID, CommandType, RaceID from FCT_Commander where GameID = ${this.GameID} and RaceID = ${this.RaceID} and Deceased = 0 and CommandType in (1, 10) order by rowid) select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_ShipClass.ClassName, ${parts.classRank}, FCT_ShipClass.Terraformers, FCT_ShipClass.MiningModules, FCT_ShipClass.Harvesters, FCT_ShipClass.GeoSurvey, FCT_ShipClass.GravSurvey, (select count(*) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.Name = 'Science Department') as SciencePosts, (select FCT_Commander.CommanderID from VIR_ShipCommanders as FCT_Commander where FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 1 and FCT_Commander.RaceID = FCT_Ship.RaceID limit 1) as CaptainID, (select FCT_Commander.CommanderID from VIR_ShipCommanders as FCT_Commander where FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 10 and FCT_Commander.RaceID = FCT_Ship.RaceID limit 1) as ScienceOfficerID from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID and FCT_RaceSysSurvey.GameID = FCT_Ship.GameID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and (FCT_ShipClass.Terraformers > 0 or FCT_ShipClass.MiningModules > 0 or FCT_ShipClass.Harvesters > 0 or FCT_ShipClass.GeoSurvey > 0 or FCT_ShipClass.GravSurvey > 0 or FCT_ShipClass.Terraformers is null or FCT_ShipClass.MiningModules is null or FCT_ShipClass.Harvesters is null or FCT_ShipClass.GeoSurvey is null or FCT_ShipClass.GravSurvey is null) order by FCT_ShipClass.ClassName, FCT_Ship.ShipName`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    projects: {
      get: tracked('projects', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ResearchProject.ProjectID, FCT_ResearchProject.TechID, FCT_ResearchProject.ResSpecID, DIM_ResearchField.FieldName, FCT_ResearchProject.Facilities, FCT_TechSystem.Name as ProjectName, FCT_Population.PopName, (select FCT_Commander.CommanderID from FCT_Commander where FCT_Commander.CommandID = FCT_ResearchProject.ProjectID and FCT_Commander.CommandType = 7 and FCT_Commander.RaceID = FCT_ResearchProject.RaceID and FCT_Commander.Deceased = 0 limit 1) as ScientistID from FCT_ResearchProject left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_ResearchProject.ResSpecID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Commanders of the race no longer serving: prisoners of another race, and retired or dead commanders the player kept. A prisoner's captor is the race owning the ship or colony that holds them, named as this race knows it.
    former: {
      get: tracked('former', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const parts = await this.partsFor(this.rosterGroups)

        return await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommanderType, FCT_Commander.ResSpecID, DIM_ResearchField.FieldName, FCT_Commander.StoryCharacter, FCT_Commander.Notes, FCT_Commander.KillTonnageMilitary, FCT_Commander.KillTonnageCommercial, FCT_Commander.CareerStart, FCT_Commander.RetireStatus, FCT_Commander.Prisoner, ${parts.rankColumns}, ${parts.ageColumn}, FCT_Game.GameTime, coalesce(VIR_HoldShip.RaceID, VIR_HoldColony.RaceID) as CaptorID, FCT_AlienRace.AlienRaceName as CaptorName, VIR_Bonuses.Bonuses, VIR_Medals.Medals, VIR_Medals.MedalCount
          from FCT_Commander
          inner join FCT_Game on FCT_Game.GameID = FCT_Commander.GameID
          ${parts.ageJoin}
          ${parts.rankJoin}
          left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_Commander.ResSpecID and FCT_Commander.CommanderType = 3
          left join FCT_Ship as VIR_HoldShip on VIR_HoldShip.ShipID = FCT_Commander.TransportShipID and VIR_HoldShip.RaceID <> FCT_Commander.RaceID
          left join FCT_Population as VIR_HoldColony on VIR_HoldColony.PopulationID = FCT_Commander.PopLocationID and VIR_HoldColony.RaceID <> FCT_Commander.RaceID
          left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Commander.GameID and FCT_AlienRace.ViewRaceID = FCT_Commander.RaceID and FCT_AlienRace.AlienRaceID = coalesce(VIR_HoldShip.RaceID, VIR_HoldColony.RaceID)
          left join (select FCT_CommanderBonuses.CommanderID, group_concat(FCT_CommanderBonuses.BonusID || ':' || coalesce(FCT_CommanderBonuses.BonusValue, ''), ',') as Bonuses from FCT_CommanderBonuses inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderBonuses.CommanderID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderBonuses.CommanderID) as VIR_Bonuses on VIR_Bonuses.CommanderID = FCT_Commander.CommanderID
          left join (select FCT_CommanderMedal.CommanderID, group_concat(coalesce(FCT_RaceMedals.MedalName, 'Medal') || case when FCT_CommanderMedal.NumAwarded > 1 then ' ×' || FCT_CommanderMedal.NumAwarded else '' end, ', ') as Medals, case when count(FCT_CommanderMedal.NumAwarded) = count(*) then sum(FCT_CommanderMedal.NumAwarded) end as MedalCount from FCT_CommanderMedal inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderMedal.CommanderID left join FCT_RaceMedals on FCT_RaceMedals.MedalID = FCT_CommanderMedal.MedalID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderMedal.CommanderID) as VIR_Medals on VIR_Medals.CommanderID = FCT_Commander.CommanderID
          where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and not (${SERVING_COMMANDER})`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The career records of those commanders, newest first, by CommanderID.
    formerHistory: {
      get: tracked('formerHistory', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const [rows] = await this.database.query(`select FCT_CommanderHistory.CommanderID, FCT_CommanderHistory.GameTime, FCT_CommanderHistory.HistoryText from FCT_CommanderHistory inner join FCT_Commander on FCT_Commander.CommanderID = FCT_CommanderHistory.CommanderID where FCT_CommanderHistory.GameID = ${this.GameID} and FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and not (${SERVING_COMMANDER}) order by FCT_CommanderHistory.GameTime desc, FCT_CommanderHistory.rowid desc`)
        const history = {}

        rows.forEach((row) => {
          (history[row.CommanderID] = history[row.CommanderID] || []).push(row)
        })

        return history
      }),
      default: {},
    },
    // Other races' commanders this race holds prisoner, on its ships or at its colonies.
    held: {
      get: tracked('held', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const parts = await this.partsFor(this.rosterGroups)

        return await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommanderType, FCT_AlienRace.AlienRaceName, ${parts.rankColumns}, FCT_Commander.Processed, VIR_Ship.ShipName, VIR_Colony.PopName
          from FCT_Commander
          left join FCT_Ship as VIR_Ship on VIR_Ship.ShipID = FCT_Commander.TransportShipID and VIR_Ship.RaceID = ${this.RaceID}
          left join FCT_Population as VIR_Colony on VIR_Colony.PopulationID = FCT_Commander.PopLocationID and VIR_Colony.RaceID = ${this.RaceID}
          left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Commander.GameID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.AlienRaceID = FCT_Commander.RaceID
          ${parts.rankJoin}
          where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID <> ${this.RaceID} and FCT_Commander.Prisoner = 1 and (VIR_Ship.ShipID is not null or VIR_Colony.PopulationID is not null)`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // How many of the race's commanders are in neither the serving nor the former list because their retirement or prisoner flag is not stored.
    unsettled: {
      get: tracked('unsettled', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return 0
        }

        const [rows] = await this.database.query(`select count(*) as Unsettled from FCT_Commander where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and (${SERVING_COMMANDER}) is null`)

        return rows[0].Unsettled
      }),
      default: 0,
    },
    // The race's naval administration as one model (`loadNavalHierarchy`), or { supported: false, missing } for a save without what it reads. Read for the command structure panel alone: the roster never waits for it.
    navalTree: {
      get: tracked('navalTree', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return Object.freeze(await loadNavalHierarchy(this.database, { GameID: this.GameID, RaceID: this.RaceID, shippingLines: this.shippingLines }))
      }),
      default: null,
    },
    // The race's ground formations as one model (`loadGroundFormationPosts`), with the commander of each formation, or { supported: false, missing } for a save without what it reads. Read for the command structure panel alone.
    groundTree: {
      get: tracked('groundTree', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return Object.freeze(await loadGroundFormationPosts(this.database, { GameID: this.GameID, RaceID: this.RaceID }))
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.commanders-page {
  td {
    font-variant-numeric: tabular-nums;
  }

  .branch-export {
    max-width: 720px;
  }

  .branch-picker {
    flex: 1 1 auto;
    min-width: 0;
  }

  .bonus-chip {
    display: inline-block;
    margin: 2px 4px 2px 0;
    padding: 0 6px;
    border-radius: 10px;
    font-size: calc(12px * var(--ae-font-scale));
    line-height: calc(20px * var(--ae-font-scale));
    white-space: nowrap;
    background: var(--ae-track-soft);
  }

  .career-line {
    font-size: calc(13px * var(--ae-font-scale));
    line-height: calc(20px * var(--ae-font-scale));
  }

  .career-date {
    display: inline-block;
    width: 96px;
  }
}
</style>
