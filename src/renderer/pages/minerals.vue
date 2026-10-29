<template>
  <div>
    <v-container fluid class="minerals-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--mineral">
            <div class="tool__label caption text--secondary">Mineral</div>
            <v-select v-model="focusId" :items="mineralItems" item-text="name" item-value="id" aria-label="Mineral" prepend-inner-icon="mdi-diamond-stone" dense outlined hide-details />
          </div>
          <div class="tool tool--reach">
            <div class="tool__label caption text--secondary">Systems</div>
            <v-select v-model="reach" :items="reachItems" item-text="label" item-value="id" aria-label="Systems" :disabled="!!selection" dense outlined hide-details>
              <template #item="{ item }">
                <v-list-item-content>
                  <v-list-item-title>{{ item.label }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.note }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-select>
          </div>
          <div v-if="selection" class="tool tool--selection">
            <div class="tool__label caption text--secondary">Picked</div>
            <v-chip label close class="selection-chip" close-label="Show every system again" :title="selection.title" @click:close="clearSelection">{{ selection.label }}</v-chip>
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="440">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Deposit options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">Bodies</div>
                <v-radio-group v-model="orbital" dense hide-details class="mt-1">
                  <v-radio v-for="option in orbitalOptions" :key="option.value" :value="option.value" :label="option.text" />
                </v-radio-group>
                <div class="caption text--secondary mt-1">{{ orbitalLimitNote }}</div>
                <div class="subtitle-2 mt-4">Deposits</div>
                <v-row dense class="mt-1">
                  <v-col cols="6">
                    <v-select v-model="minAccessibility" :items="accessibilitySteps" label="Accessibility from" dense outlined hide-details />
                  </v-col>
                  <v-col cols="6">
                    <v-text-field v-model.number="minAmount" type="number" min="0" label="Tonnes from" dense outlined hide-details clearable />
                  </v-col>
                </v-row>
                <v-btn v-if="activeOptionCount" text small class="mt-3" @click="resetOptions">Reset options</v-btn>
              </v-card>
            </v-menu>
          </div>
        </div>

        <stat-tiles class="mt-1" :tiles="tiles" />

        <v-row>
          <v-col cols="12" xl="7">
            <v-card class="panel" data-summary="Each mineral with what lies in the ground, what is mined, what is held and which colonies are short." elevation="1">
              <div class="panel-head">
                <span>By mineral<provenance-mark rule="minerals.colonyStock" /></span>
                <router-link v-if="focus" :to="outlookLink" class="body-2">{{ focus.name }} runway in Mineral Outlook</router-link>
              </div>
              <v-simple-table dense class="overview-table">
                <thead>
                  <tr>
                    <th>Mineral</th>
                    <th>In the ground</th>
                    <th class="text-right">Deposits</th>
                    <th>Best untapped<provenance-mark rule="minerals.siteOrder" /></th>
                    <th class="text-right">In stock<provenance-mark rule="minerals.colonyStock" /></th>
                    <th class="text-right">Free to move<provenance-mark rule="minerals.colonyStock" /></th>
                    <th>Colonies<provenance-mark rule="minerals.stockState" /></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in overviewRows" :key="row.id" :class="{ 'is-selected-row': row.id === focusId }" class="overview-row" tabindex="0" @click="setFocus(row.id === focusId ? 0 : row.id)" @keydown.enter="setFocus(row.id === focusId ? 0 : row.id)">
                    <td class="font-weight-medium">{{ row.name }}</td>
                    <td>
                      <div class="band-cell">
                        <div class="band-meter" :title="bandTitle(row)">
                          <div v-for="band in bands" :key="band.id" class="band-meter__part" :style="{ width: `${row.amount ? (row.bands[band.id] / row.amount) * 100 : 0}%`, background: bandColors[band.id] }" />
                        </div>
                        <span class="text-no-wrap" :class="{ 'text--secondary': !row.amount }" :title="`${count(row.amount)} t`">{{ compact(row.amount) }}</span>
                      </div>
                    </td>
                    <td class="text-right">
                      <div>{{ count(row.deposits) }}</div>
                      <div class="caption text--secondary text-no-wrap">{{ row.worked ? `${count(row.worked)} mined` : 'none mined' }}</div>
                    </td>
                    <td>
                      <template v-if="row.best">
                        <div class="text-no-wrap">{{ row.best.name }}<provenance-mark :result="row.bestResult" /></div>
                        <div class="caption text--secondary text-no-wrap">{{ compact(row.best.deposit.Amount) }} at {{ row.best.deposit.Accessibility }}<span v-if="row.best.distance"> · {{ distanceText(row.best.distance) }}</span><span v-else> · route —</span><provenance-mark v-if="!row.best.distance" :result="row.best.distanceResult" /></div>
                      </template>
                      <template v-else>
                        <span class="text--secondary">—</span><provenance-mark v-if="row.bestResult" :result="row.bestResult" />
                      </template>
                    </td>
                    <td class="text-right text-no-wrap" :class="{ 'text--secondary': !row.stock }" :title="exactTons(row.stockResult)">{{ tons(row.stock) }}<provenance-mark v-if="unsure(row.stockResult)" :result="row.stockResult" /></td>
                    <td class="text-right text-no-wrap" :class="{ 'text--secondary': !row.free }" :title="exactTons(row.freeResult)">{{ tons(row.free) }}<provenance-mark v-if="unsure(row.freeResult)" :result="row.freeResult" /></td>
                    <td class="text-no-wrap">
                      <span v-if="row.short" class="error--text">{{ row.short }} short</span>
                      <span v-if="row.short && row.below" class="text--secondary"> · </span>
                      <span v-if="row.below" class="warning--text">{{ row.below }} below reserve</span>
                      <span v-if="(row.short || row.below) && row.unknown" class="text--secondary"> · </span>
                      <span v-if="row.unknown" class="text--secondary">{{ row.unknown }} unknown</span><provenance-mark v-if="row.unknown" :result="row.unknownResult" />
                      <span v-if="!row.short && !row.below && !row.unknown" class="text--secondary">—</span>
                    </td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div class="panel-foot caption text--secondary">
                Use it to pick the mineral to focus on: click a mineral to focus the page on it, and click again for all minerals. In the ground counts the deposits in the chosen systems that pass the options, split by accessibility; a deposit is mined when a colony on the body has mines or orbital miners are there, and untapped when nobody mines it and no known alien colony holds the body. Colonies short need more for their build queue than they hold; below reserve hold less than the reserve set for them.
                A dash is a figure the save does not record, never 0: hover its mark for what is missing.
              </div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="5">
            <v-card class="panel" data-summary="A map of the known systems sized by how much of the chosen mineral their deposits hold." elevation="1">
              <div class="panel-head">
                <span>Deposits by system</span>
                <span class="legend">
                  <span v-for="band in bands" :key="band.id" class="legend-item"><span class="dot" :style="{ background: bandColors[band.id] }" />{{ band.label }}</span>
                  <span class="legend-item"><span class="dot" :style="{ background: mutedColor }" />None or out of reach</span>
                  <span class="legend-item"><span class="dot dot-ring" :style="{ borderColor: theme.ink }" />Colonies</span>
                </span>
              </div>
              <div class="panel-body">
                <system-map :systems="mapNodes" :links="mapLinks" :selected="mapSelected" :height="mapHeight" :aria-label="`Known systems sized by the ${focusName} in their deposits`" @select="selectSystem" />
                <div class="caption text--secondary">Positions as on the game's galactic map. Size shows the tonnes of {{ focusName }} in the deposits that pass the options and the deposit view; colour, the best accessibility among them. Click a system to list only its deposits and colonies, and again to show them all.</div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" data-summary="Surveyed bodies with mineral deposits, with their accessibility and mining potential." elevation="1">
          <div class="panel-head">
            <span>{{ focus ? `${focus.name} deposits` : 'Bodies with deposits' }}<provenance-mark rule="minerals.potential" /></span>
            <span class="head-tools">
              <v-btn-toggle v-model="depositView" mandatory dense>
                <v-btn v-for="view in depositViews" :key="view.id" :value="view.id" small>{{ view.label }}&nbsp;<span class="text--secondary">{{ count(viewCounts[view.id]) }}</span></v-btn>
              </v-btn-toggle>
              <v-text-field v-model="search" label="Search" placeholder="Body or system" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <div v-if="selectedRows.length" class="selection-bar">
            <span class="body-2">{{ counted(selectedRows.length, 'body', 'bodies') }} picked</span>
            <v-btn small outlined :to="plannerLink(selectedRows)">Open in Colonization Planner</v-btn>
            <v-btn small text @click="selectedRows = []">Clear</v-btn>
          </div>
          <div v-if="unreadableCount" class="selection-bar caption warning--text">{{ counted(unreadableCount, 'deposit', 'deposits') }} in view {{ unreadableCount === 1 ? 'has' : 'have' }} no recorded amount or accessibility and {{ unreadableCount === 1 ? 'is' : 'are' }} left out of the figures and tables.<provenance-mark :result="unreadableResult" /></div>
          <v-data-table v-model="selectedRows" :headers="depositHeaders" :items="depositRows" :custom-sort="sortNullLast" item-key="SystemBodyID" show-select show-expand single-expand :expanded.sync="depositExpanded" :sort-by.sync="depositTable.sortBy" :sort-desc.sync="depositTable.sortDesc" :items-per-page.sync="depositTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="bodies.length ? 'No deposits match the systems, options and search.' : 'No surveyed body has deposits yet.'">
            <template #[`item.nameSort`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div>
                  <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                  <div class="caption text--secondary text-no-wrap">{{ item.place }}</div>
                </div>
                <page-link class="ml-2" :to="plannerLink([item])" :name="item.name" />
              </div>
            </template>
            <template #[`item.amount`]="{ item }">
              <div v-if="focus" class="text-no-wrap" :title="`${count(item.amount)} t`">{{ compact(item.amount) }}</div>
              <div v-else-if="item.body.bare" class="py-2 text--secondary">No mineral deposit recorded</div>
              <div v-else class="py-2">
                <div class="mineral-strip">
                  <span v-for="cell in item.cells" :key="cell.id" class="mineral-strip__cell" :class="{ 'mineral-strip__cell--empty': !cell.deposit, 'mineral-strip__cell--out': cell.deposit && !cell.passes }" :style="cell.deposit && cell.passes ? { background: withAlpha(bandColors[cell.band], 0.3), borderBottomColor: bandColors[cell.band] } : {}" :title="cell.title">{{ cell.short }}</span>
                </div>
                <div class="caption text--secondary text-no-wrap" :title="`${count(item.amount)} t`">{{ compact(item.amount) }} in {{ counted(item.minerals, 'mineral', 'minerals') }}</div>
                <div v-if="item.unreadable" class="caption warning--text text-no-wrap">+ {{ counted(item.unreadable, 'deposit', 'deposits') }} not recorded</div>
              </div>
            </template>
            <template #[`item.accessibility`]="{ item }">
              <div class="py-2">
                <div class="band-cell">
                  <div class="meter"><div class="meter-fill" :style="{ width: `${item.accessibility * 100}%`, background: bandColors[item.band] }" /></div>
                  <span>{{ item.accessibility }}</span>
                </div>
                <div class="caption text--secondary text-no-wrap">{{ depletionText(item.deposit) }}</div>
              </div>
            </template>
            <template #[`item.perMine`]="{ item }">
              <span class="text-no-wrap">{{ perYear(item.perMineResult) }}</span><provenance-mark v-if="unsure(item.perMineResult)" :result="item.perMineResult" />
            </template>
            <template #[`item.potential`]="{ item }">
              <span v-if="item.potential === null" class="text--secondary" :title="item.potentialTitle">—</span>
              <span v-else :class="{ 'success--text font-weight-medium': item.potential >= 7.5, 'text--secondary': item.potential <= 3 }" :title="item.potentialTitle">{{ roundToDecimal(item.potential, 1) }}</span><provenance-mark :result="item.potentialResult" />
            </template>
            <template #[`header.potential`]="{ header }">
              <v-tooltip top max-width="400">
                <template #activator="{ on }">
                  <span v-on="on">{{ header.text }}<v-icon x-small class="ml-1">mdi-information-outline</v-icon></span>
                </template>
                <span>{{ potentialHint }}</span>
              </v-tooltip>
              <provenance-mark rule="minerals.potential" />
            </template>
            <template #[`header.perMine`]="{ header }"><span>{{ header.text }}<provenance-mark rule="minerals.perMine" /></span></template>
            <template #[`header.accessibility`]="{ header }"><span>{{ header.text }}<provenance-mark rule="minerals.depletion" /></span></template>
            <template #[`header.mining`]="{ header }"><span>{{ header.text }}<provenance-mark rule="minerals.orbitalReach" /><provenance-mark rule="minerals.cmcCandidate" /></span></template>
            <template #[`header.distanceSort`]="{ header }"><span>{{ header.text }}<provenance-mark rule="minerals.distance" /></span></template>
            <template #[`item.mining`]="{ item }">
              <div class="chip-cell">
                <v-tooltip v-if="item.body.orbitalEligible" top max-width="320">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined v-on="on">Orbital</v-chip>
                  </template>
                  <span>{{ count(item.body.Diameter) }} km across: orbital miners can work it (up to {{ count(raceRules.MaximumOrbitalMiningDiameter) }} km), with no colony.</span>
                </v-tooltip>
                <v-tooltip v-else-if="item.body.orbitalEligible === null" top max-width="320">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined v-on="on">Orbital —</v-chip>
                  </template>
                  <span>The body's diameter, or the race's orbital mining limit, is not recorded, so it is not known whether orbital miners can work it.</span>
                </v-tooltip>
                <v-tooltip v-if="item.body.complexes" top max-width="360">
                  <template #activator="{ on }">
                    <v-chip x-small label :color="appearance.plan.cmc" dark v-on="on"><v-icon x-small left>mdi-pickaxe</v-icon>CMC ×{{ item.body.complexes }}</v-chip>
                  </template>
                  <span>{{ cmcText(item.body) }}</span>
                </v-tooltip>
                <v-tooltip v-else-if="raceRules.AllowCMC && item.body.cmcCandidate" top max-width="360">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined v-on="on">CMC</v-chip>
                  </template>
                  <span>Could host a civilian mining complex: more than 10,000 t of {{ item.body.cmcCandidate }} at accessibility 0.7 or better, and the body is close enough to its star. The game founds one only if a colony in the system has over 10 M people, the body has no colony (one with only orbital miners is fine) and isn't banned, and its star is in reach (a companion star within 80 AU of what it orbits, or linked by Lagrange points). It then rolls 1 in 3 for each such body, richest first. The Colonization Planner checks every condition per body.</span>
                </v-tooltip>
                <v-tooltip v-if="item.body.GroundMineralSurvey" top max-width="320">
                  <template #activator="{ on }">
                    <v-chip x-small label outlined to="/survey-progress" v-on="on">Ground: {{ groundSurvey[item.body.GroundMineralSurvey] }}</v-chip>
                  </template>
                  <span>A ground survey can still find more deposits here (potential {{ groundSurvey[item.body.GroundMineralSurvey] }}). Survey Progress tracks the teams on it.</span>
                </v-tooltip>
              </div>
            </template>
            <template #[`item.workedSort`]="{ item }">
              <div class="py-2 worker-cell">
                <div v-for="worker in item.body.workers" :key="worker.key" class="wrap-cell">
                  <span :class="{ 'warning--text': worker.alien }">{{ worker.text }}</span>
                  <span class="caption text--secondary"> · {{ worker.note }}</span>
                </div>
                <span v-if="!item.body.workers.length" class="text--secondary">—</span>
              </div>
            </template>
            <template #[`item.distanceSort`]="{ item }">
              <div v-if="item.body.distance" class="py-2 ml-auto distance-cell">
                <div class="text-no-wrap">{{ distanceText(item.body.distance) }}<provenance-mark :result="item.body.distanceResult" /></div>
                <div class="caption text--secondary text-truncate" :title="item.body.distance.from.PopName">from {{ item.body.distance.from.PopName }}</div>
              </div>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.body.distanceResult" /></span>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="expand-cell">
                <v-simple-table dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Mineral</th>
                      <th class="text-right">In the ground</th>
                      <th>Accessibility</th>
                      <th class="text-right">Per mine</th>
                      <th class="text-right">Potential</th>
                      <th>Depletion</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="deposit in item.body.depositList" :key="deposit.MaterialID" :class="{ 'text--disabled': !passesDeposit(deposit) }">
                      <td class="font-weight-medium">{{ mineralName(deposit.MaterialID) }}</td>
                      <td class="text-right" :title="tonsTitle(deposit.Amount)">{{ tons(deposit.Amount) }}</td>
                      <td>{{ plain(deposit.Accessibility) }}<span v-if="deposit.OriginalAcc && deposit.OriginalAcc !== deposit.Accessibility" class="caption text--secondary"> (was {{ deposit.OriginalAcc }})</span></td>
                      <td class="text-right">{{ perYear(perMineOf(deposit)) }}<provenance-mark :result="perMineOf(deposit)" /></td>
                      <td class="text-right">{{ potentialText(potentialOf(deposit)) }}<provenance-mark :result="potentialOf(deposit)" /></td>
                      <td>{{ depletionText(deposit, true) }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div class="detail-links body-2">
                  <router-link :to="plannerLink([item])">Open in Colonization Planner</router-link>
                </div>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Use it to choose where to open new mines or send miners. A mine digs {{ mineProductionText }} a year at accessibility 1 with the race's mining tech, times the deposit's accessibility, before the colony's own modifiers; an automated mine digs the same and a civilian mining complex ten times as much. Accessibility holds until a deposit is down to half its original amount, then falls with what is left, to {{ ACCESSIBILITY_FLOOR }} when it is empty. {{ orbitalLimitNote }} Untapped: nobody mines the body and no known alien colony holds it; a colony without mines counts as untapped. Distance is the charted route from the nearest colony of {{ SUPPLY_BASE_MILLIONS }} million people or more. A dash is a figure the save does not record, never 0: hover its mark for what is missing.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Surveyed bodies that could host a civilian mining complex, with their reserve and accessibility." elevation="1">
          <div class="panel-head">
            <span>Civilian mining candidates<provenance-mark rule="minerals.cmcCandidate" /></span>
            <span class="head-tools body-2">
              <span class="text--secondary">{{ candidateSummary }}</span>
              <v-btn-toggle v-model="cmcRanking" mandatory dense>
                <v-btn v-for="option in rankings" :key="option.id" :value="option.id" small>{{ option.label }}</v-btn>
              </v-btn-toggle>
            </span>
          </div>
          <div class="candidate-tools">
            <v-text-field v-for="field in settingFields" :key="field.key" v-model="cmcPreference[field.key]" :label="field.label" :hint="field.hint" :error-messages="settingError(field)" :maxlength="settingMaxText" persistent-hint dense outlined class="candidate-field" />
            <v-btn text small class="candidate-reset" @click="resetPreference">Reset to defaults</v-btn>
          </div>
          <div v-if="candidates.fellBack" class="selection-bar caption warning--text">The longevity ranking is not available, so the rows keep the headline order: {{ candidates.blocking.join('; ') }}.<provenance-mark rule="cmcCandidate.score" /></div>
          <div v-for="note in candidates.notes" :key="note" class="selection-bar caption warning--text">{{ note }}.<provenance-mark rule="cmcCandidate.input" /></div>
          <ul class="candidate-assumptions caption text--secondary">
            <li v-for="line in candidates.lines" :key="line.key"><span>{{ line.label }}: </span><strong>{{ line.value === null ? (line.note ? '' : '—') : `${count(line.value, 2)}${line.unit}` }}</strong><span v-if="line.note"><span v-if="line.value !== null"> · </span>{{ line.note }}</span><provenance-mark :result="line.result" /></li>
          </ul>
          <v-data-table :headers="candidateHeaders" :items="candidates.rows" item-key="key" show-expand single-expand :expanded.sync="candidateExpanded" disable-sort disable-pagination hide-default-footer :no-data-text="candidateEmptyText">
            <template v-for="(rule, column) in candidateRules" #[`header.${column}`]="{ header }">
              <span :key="column">{{ header.text }}<provenance-mark :rule="rule" /></span>
            </template>
            <template #[`item.rank`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium text-no-wrap">{{ rankText(item.rank) }}<provenance-mark :result="item.rankResult" /></div>
                <div class="caption text--secondary text-no-wrap">Headline {{ rankText(item.headlineRank) }}<provenance-mark :result="item.potentialResult" /></div>
                <div class="caption text--secondary text-no-wrap">Longevity {{ rankText(item.longevityRank) }}<provenance-mark :result="item.score" /></div>
              </div>
            </template>
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div>
                  <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                  <div class="caption text--secondary text-no-wrap">{{ item.place }}</div>
                  <div v-if="item.status === 'possible'" class="caption warning--text text-no-wrap">Possible: {{ item.possibleBecause.join(' and ') }}</div>
                </div>
                <page-link class="ml-2" :to="plannerLink([item])" :name="item.name" />
              </div>
            </template>
            <template #[`item.potential`]="{ item }">
              <span v-if="item.potential === null" class="text--secondary">—</span>
              <span v-else>{{ roundToDecimal(item.potential, 1) }}</span><provenance-mark :result="item.potentialResult" />
            </template>
            <template #[`item.reserve`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap" :title="isAvailable(item.reserve) ? `${count(item.reserve.value)} t` : describeResult(item.reserve)">{{ isAvailable(item.reserve) ? compact(item.reserve.value) : '—' }}<provenance-mark :result="item.reserve" /></div>
                <div class="caption text--secondary text-no-wrap">{{ item.lines.map((line) => line.mineral).join(' and ') }}</div>
              </div>
            </template>
            <template #[`item.accessibility`]="{ item }">
              <span class="text-no-wrap">{{ isAvailable(item.accessibility) ? count(item.accessibility.value, 2) : '—' }}</span><provenance-mark :result="item.accessibility" />
            </template>
            <template #[`item.lifetime`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">{{ yearsText(item.lifetime) }}<provenance-mark :result="item.lifetime" /></div>
                <div v-if="item.lines.length > 1" class="caption text--secondary text-no-wrap">longest of {{ item.lines.length }} deposits</div>
              </div>
            </template>
            <template #[`item.score`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium text-no-wrap">{{ isAvailable(item.score) ? count(item.score.value, 2) : '—' }}<provenance-mark :result="item.score" /></div>
                <div v-for="entry in item.terms" :key="entry.key" class="caption text--secondary text-no-wrap">{{ termText(entry) }}<provenance-mark :result="entry.term" /></div>
              </div>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="expand-cell">
                <v-simple-table dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Mineral</th>
                      <th class="text-right">In the ground<provenance-mark rule="cmcCandidate.deposit" /></th>
                      <th>Accessibility<provenance-mark rule="cmcCandidate.deposit" /></th>
                      <th class="text-right">Assumed output</th>
                      <th class="text-right">Lifetime</th>
                      <th>Meets the deposit rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="line in item.lines" :key="line.MaterialID">
                      <td class="font-weight-medium">{{ line.mineral }}</td>
                      <td class="text-right" :title="tonsTitle(line.Amount)">{{ tons(line.Amount) }}<provenance-mark :result="line.amountResult" /></td>
                      <td>{{ plain(line.Accessibility) }}<provenance-mark :result="line.accessibilityResult" /></td>
                      <td class="text-right">{{ perYear(line.rate) }}<provenance-mark :result="line.rate" /></td>
                      <td class="text-right">{{ yearsText(line.lifetime) }}<provenance-mark :result="line.lifetime" /></td>
                      <td>{{ line.qualifies ? 'Yes' : 'Not known' }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A candidate is a surveyed body in reach of its star, with no complex on it yet, that holds more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better. A body with such a deposit whose amount or accessibility is not recorded, and a body with a colony whose civilian installations are not fully recorded, is listed as possible and stays unknown; the game's other conditions are not checked here. Bodies are ranked by the headline order (mining potential, then accessibility, then amount) or by an optional longevity preference with editable weights, a weighted mean of the reserve, accessibility and lifetime terms. The lifetime is how long the assumed complexes would take to dig out the qualifying deposits, the longest of them. Neither order is the game's choice of where a complex is founded, which follows its own scoring and a dice roll, and nothing here predicts it. A dash is a figure the save does not record or a field left blank, never 0: hover its mark for what is missing.
          </div>
        </v-card>

        <v-card class="panel" data-summary="What each colony holds, reserves and needs of minerals." elevation="1">
          <div class="panel-head">
            <span>{{ focus ? `${focus.name} in the colonies` : 'Minerals in the colonies' }}<provenance-mark rule="minerals.colonyStock" /></span>
            <v-text-field v-model="colonySearch" label="Search" placeholder="Colony or system" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <v-data-table :headers="colonyHeaders" :items="visibleColonyRows" :custom-sort="sortNullLast" item-key="key" show-expand single-expand :expanded.sync="colonyExpanded" :sort-by.sync="colonyTable.sortBy" :sort-desc.sync="colonyTable.sortDesc" :items-per-page.sync="colonyTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="colonyRows.length ? 'No colony matches the search.' : `No colony in the chosen systems holds, reserves, needs or expects ${focusName}.`">
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                <div class="caption text--secondary text-no-wrap">{{ item.place }}</div>
              </div>
            </template>
            <template v-for="(rule, column) in headerRules" #[`header.${column}`]="{ header }">
              <span :key="column">{{ header.text }}<provenance-mark :rule="rule" /></span>
            </template>
            <template v-for="column in tonnageColumns" #[`item.${column}`]="{ item }">
              <span :key="column" class="text-no-wrap" :class="{ 'text--secondary': !item[column] }" :title="exactTons(item.results[column])">{{ tons(item[column]) }}<provenance-mark v-if="unsure(item.results[column])" :result="item.results[column]" /></span>
            </template>
            <template #[`item.driverSort`]="{ item }">
              <div v-if="item.colony.MassDrivers" class="py-2 wrap-cell">
                <div>{{ counted(item.colony.MassDrivers, 'driver', 'drivers') }}<span v-if="item.destination"> → {{ item.destination }}</span></div>
                <div class="caption text--secondary">{{ item.destination ? driverCapacity(item.driverResult) : 'no destination: sends nothing' }}<provenance-mark v-if="item.destination" :result="item.driverResult" /></div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.stateOrder`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">
                  <v-icon small :color="stockStates[item.state].color" class="mr-1">{{ stockStates[item.state].icon }}</v-icon>{{ stockStates[item.state].label }}<provenance-mark v-if="unsure(item.stateResult)" :result="item.stateResult" />
                </div>
                <div v-if="item.stateNote" class="caption text--secondary wrap-cell" :title="item.stateTitle">{{ item.stateNote }}</div>
              </div>
            </template>
            <template #expanded-item="{ headers }">
              <td :colspan="headers.length" class="expand-cell">
                <v-simple-table v-if="colonyDetail" dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Mineral</th>
                      <th class="text-right">Stock</th>
                      <th class="text-right">Reserve</th>
                      <th class="text-right">Free to move</th>
                      <th class="text-right">Queue needs</th>
                      <th class="text-right">In flight</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="mineral in colonyDetail" :key="mineral.id">
                      <td class="font-weight-medium">{{ mineral.name }}</td>
                      <td v-for="column in tonnageColumns" :key="column" class="text-right" :class="{ 'text--secondary': !mineral[column] }" :title="exactTons(mineral.results[column])">{{ tons(mineral[column]) }}<provenance-mark v-if="unsure(mineral.results[column])" :result="mineral.results[column]" /></td>
                      <td>
                        <div class="text-no-wrap"><v-icon small :color="stockStates[mineral.state || 'unknown'].color" class="mr-1">{{ stockStates[mineral.state || 'unknown'].icon }}</v-icon>{{ stockStates[mineral.state || 'unknown'].label }}<provenance-mark v-if="unsure(mineral.results.state)" :result="mineral.results.state" /></div>
                        <div v-if="mineral.advice" class="caption text--secondary">{{ mineral.advice }}<provenance-mark v-if="mineral.adviceRoute" rule="minerals.distance" /></div>
                      </td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Use it to find shortages and stock that can be moved. Freighters, load and unload to reserve orders and mass drivers move only what a colony holds above its reserve. Industrial projects, shipyards and ground training draw on the whole stock, reserve included, so a reserve keeps a queue's minerals from being carried off but never holds them back from it. A mass driver sends up to {{ count(MASS_DRIVER_TONS) }} t a year to the colony set as its destination, and nothing with none set; packets bound for a colony that is gone are lost. Queue needs are what the colony's industrial projects (paused and queued ones too) and shipyard tasks that build, repair or refit still need; a scrap task needs no minerals. Expand a colony for each mineral and the nearest colony with stock free to move.
            A dash is a figure the save does not record, never 0: hover its mark for what is missing. A colony with nothing queued needs 0.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Each colony whose civilian mining complexes produce, with whether the race buys or taxes their output." elevation="1">
          <div class="panel-head">
            <span>Civilian mining policy<provenance-mark rule="cmcPolicy.choice" /></span>
            <span class="head-tools body-2">
              <span v-if="policySummary" class="text--secondary">{{ policySummary }}</span>
              <router-link v-if="policyHasStockpiling" :to="stockpilingLink">Stockpiling check in Warnings</router-link>
            </span>
          </div>
          <v-data-table :headers="policyHeaders" :items="policyRows" :custom-sort="sortNullLast" item-key="key" :sort-by.sync="policyTable.sortBy" :sort-desc.sync="policyTable.sortDesc" disable-pagination hide-default-footer no-data-text="No colony of the race has civilian mining complexes that produce.">
            <template v-for="(rule, column) in policyRules" #[`header.${column}`]="{ header }">
              <span :key="column">{{ header.text }}<provenance-mark :rule="rule" /></span>
            </template>
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div>
                  <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                  <div class="caption text--secondary text-no-wrap">{{ item.place }}</div>
                </div>
                <page-link class="ml-2" :to="colonyLink(item)" :name="item.name" />
              </div>
            </template>
            <template #[`item.outputSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">{{ item.complexes === null ? '—' : counted(item.complexes, 'complex', 'complexes') }}<provenance-mark v-if="!isAvailable(item.production)" :result="item.production" /></div>
                <div class="caption text--secondary text-no-wrap" :title="isAvailable(item.output) ? `${count(item.output.value)} t a year` : describeResult(item.output)">{{ isAvailable(item.output) ? `${compact(item.output.value)} a year` : '—' }}<provenance-mark :result="item.output" /></div>
              </div>
            </template>
            <template #[`item.choiceSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">{{ choiceLabels[item.choice] || '—' }}<provenance-mark v-if="unsure(item.choiceResult)" :result="item.choiceResult" /></div>
                <div class="caption text--secondary text-no-wrap">{{ wealthText(item.wealth) }}<provenance-mark :result="item.wealth" /></div>
              </div>
            </template>
            <template #[`item.targetSort`]="{ item }">
              <div class="py-2 wrap-cell policy-wrap" :title="item.target ? `From ${item.name} to ${item.destinationName || 'no destination'}` : null">
                <div>{{ item.target ? `→ ${item.destinationName || 'no destination'}` : '→ —' }}</div>
                <div class="caption" :class="targetClass(item)">{{ targetText(item) }}<provenance-mark :result="item.targetResult" /></div>
              </div>
            </template>
            <template #[`item.drivers`]="{ item }">
              <div class="py-2 text-no-wrap">
                <div><v-icon small :color="driverIcon(item.sourceDrivers).color" class="mr-1">{{ driverIcon(item.sourceDrivers).icon }}</v-icon>{{ driverText(item.sourceDrivers, item.row.Drivers, 'Source') }}<provenance-mark :result="item.sourceDrivers" /></div>
                <div v-if="item.receiverDrivers"><v-icon small :color="driverIcon(item.receiverDrivers).color" class="mr-1">{{ driverIcon(item.receiverDrivers).icon }}</v-icon>{{ driverText(item.receiverDrivers, item.row.DestinationDrivers, 'Destination') }}<provenance-mark :result="item.receiverDrivers" /></div>
                <div v-else-if="item.target" class="caption text--secondary"><v-icon small class="mr-1">mdi-minus</v-icon>No destination to receive</div>
                <div v-else class="caption text--secondary"><v-icon small class="mr-1">mdi-help-circle-outline</v-icon>Destination: —<provenance-mark :result="item.targetResult" /></div>
              </div>
            </template>
            <template #[`item.throughput`]="{ item }">
              <div class="py-2 wrap-cell policy-wrap">
                <div>{{ throughputText(item) }}<provenance-mark v-if="item.throughput.result" :result="item.throughput.result" /></div>
                <div v-if="throughputNote(item)" class="caption text--secondary">{{ throughputNote(item) }}<provenance-mark v-if="item.throughput.state === 'stays' && unsure(item.held)" :result="item.held" /></div>
              </div>
            </template>
            <template #[`item.switchSort`]="{ item }">
              <div v-if="!item.switch" class="text--secondary text-no-wrap">{{ item.choice === 'npr' ? 'No choice for an NPR' : '—' }}<provenance-mark v-if="!item.choice" :result="item.choiceResult" /></div>
              <div v-else-if="!isAvailable(item.switch)" class="text-no-wrap"><span class="text--secondary">—</span><provenance-mark :result="item.switch" /></div>
              <div v-else class="py-2">
                <div class="text-no-wrap">{{ item.choice === 'buy' ? 'Taxed' : 'Bought' }}: {{ signed(item.switch.value.minerals, compact) }} a year<provenance-mark :result="item.switch" /></div>
                <div class="caption text--secondary text-no-wrap">{{ signed(item.switch.value.wealth, (value) => count(value)) }} wealth a year</div>
              </div>
            </template>
            <template #[`item.stateOrder`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap"><v-icon small :color="policyStates[item.state].color" class="mr-1">{{ policyStates[item.state].icon }}</v-icon>{{ policyStates[item.state].label }}<provenance-mark v-if="item.unknownResult" :result="item.unknownResult" /></div>
                <v-btn v-if="item.acknowledgeable" x-small text class="px-1 acknowledge-button" :aria-label="`${item.acknowledged ? 'Withdraw the acknowledgement of' : 'Acknowledge as intended'} the taxation at ${item.name}`" @click="toggleAcknowledged(item)">{{ item.acknowledged ? 'Withdraw' : 'Acknowledge as intended' }}</v-btn>
              </div>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Use it to review the policy colony by colony, including where a bought output is shipped by mass driver and what holds the transfer back. A row for each colony of the race whose civilian mining complexes produce, in every system whatever the view<span v-if="policyAudit.idle">; {{ counted(policyAudit.idle, 'colony', 'colonies') }} with complexes that produce nothing {{ policyAudit.idle === 1 ? 'is' : 'are' }} left out, as the game neither charges nor pays for them</span>. A bought output goes to the colony's stockpile, or by mass driver to its destination when that colony exists; a taxed output reaches no stockpile, and an NPR keeps its output at no charge. {{ policyRatesNote }} The bought output leaves in a packet of its own whatever the source's drivers can send, so the output is set against the drivers' capacity, which limits the stock above the reserve, only where both are known. A destination the game never offers is invalid, and a missing mass driver at either end is listed apart. If switched is hypothetical: the choice is made in the game, and nothing here changes the save. Acknowledging a taxed colony as intended is kept for this race and colony, can be withdrawn and leaves the row listed. A dash is a figure the save does not record, never 0: hover its mark for what is missing.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import SystemMap from '../components/exploration/SystemMap.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import capabilityGates from '../mixins/capability-gates'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { systemBodyName } from '../utilities/aurora'
import { DEFAULT_SETTINGS, MAX_TEXT, RANKINGS, SETTING_FIELDS, candidateRanking, normaliseSettings } from '../utilities/cmc-candidates'
import { CMC_PURCHASE_COST, CMC_TAX_INCOME, NO_CMC_POLICY, POLICY_STATES, TARGET_STATES, cmcPolicyRows, loadCmcPolicy } from '../utilities/cmc-policy'
import { cmcBodyInReach } from '../utilities/colonization'
import { SUPPLY_BASE_MILLIONS, cmcAllowedOf, loadRoutes } from '../utilities/colonization-data'
import { linkTo, queryBodies, queryId, queryIds } from '../utilities/deep-links'
import { PRESSING, STOCK_COLUMNS, STOCK_STATES, colonyMineralResults, loadPacketsInFlight, loadQueueNeeds, worstState } from '../utilities/colony-minerals'
import { KM_PER_AU, buildDistanceMap, jumpLinks, searchRoutes } from '../utilities/jump-graph'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { ACCESSIBILITY_FLOOR, CMC_MINERAL_IDS, MASS_DRIVER_TONS, MINERALS, bestSiteResult, betterSite, bodyPotentialResult, compact, compactYears, depositPotential, depositPotentialResult, depositReadable, massDriverRateResult, miningDistanceResult, pastHalf, perMineResult, qualifiesForCmc, withinOrbitalReach } from '../utilities/minerals'
import { describeResult, isAvailable, ruleSupports, sumResults, unavailable, valueOrNull } from '../utilities/provenance'
import { loadFormulaVersion } from '../utilities/capabilities'

const INPUT_LABELS = {
  race: "the race's mining tech",
  systems: 'the known systems',
  routes: 'the jump routes',
  deposits: 'the mineral deposits',
  colonies: "the colonies' stockpiles",
  needs: 'the build queues',
  packets: 'the mass-driver packets',
  miners: 'the orbital miners',
  aliens: 'the alien colonies',
  policy: 'the civilian mining policy',
  formulaVersion: "the save's game version",
}

const SHORT_NAMES = { 1: 'Du', 2: 'Ne', 3: 'Co', 4: 'Tr', 5: 'Bo', 6: 'Me', 7: 'Ve', 8: 'So', 9: 'Ur', 10: 'Cr', 11: 'Ga' }

// Accessibility bands, best first; their colours are the appearance's `accessibility` roles of the same id.
const BANDS = [
  { id: 'good', label: '0.7 and up', min: 0.7 },
  { id: 'fair', label: '0.4 to 0.7', min: 0.4 },
  { id: 'poor', label: 'Under 0.4', min: 0 },
]
const bandOf = (accessibility) => BANDS.find((band) => accessibility >= band.min).id

// FCT_SystemBody.GroundMineralSurvey: what a ground survey can still find (0: nothing left).
const GROUND_SURVEY = { 1: 'Minimal', 2: 'Low', 3: 'Good', 4: 'High', 5: 'Excellent' }

const BODY_CLASSES = { 1: 'Planet', 2: 'Moon', 3: 'Asteroid', 5: 'Comet' }

const REACHES = [
  { id: 'all', label: 'All known systems' },
  { id: 'colonies', label: 'Systems with colonies' },
  { id: 'inhabited', label: 'Systems with people' },
  { id: 'unrestricted', label: 'Unrestricted systems' },
]

const DEPOSIT_VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'untapped', label: 'Untapped' },
  { id: 'worked', label: 'Mined' },
]

const ORBITAL_OPTIONS = [
  { value: 'all', text: 'All bodies' },
  { value: 'eligible', text: 'Only bodies orbital miners can work' },
  { value: 'ineligible', text: 'Only bodies too large for orbital miners' },
]

const ACCESSIBILITY_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

const PAGE_SIZES = [15, 30, -1]

const sum = (items, key) => items.reduce((total, item) => total + (item[key] || 0), 0)
const byPopulation = (rows) => Object.fromEntries(rows.map((row) => [row.PopulationID, row]))

export default {
  name: 'MineralsPage',
  components: { LoadState, PageLink, ProvenanceMark, StatTiles, SystemMap },
  mixins: [
    capabilityGates,
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      focusId: { key: 'mineralsFocus', default: 0, scope: 'race', valid: oneOf(MINERALS.map((mineral) => mineral.id)) },
      reach: { key: 'mineralsReach', default: 'all', scope: 'race', valid: oneOf(REACHES.map((option) => option.id)) },
      depositView: { key: 'mineralsDepositView', default: 'all', scope: 'race', valid: oneOf(DEPOSIT_VIEWS.map((option) => option.id)) },
      orbital: { key: 'mineralsFilterOrbitalEligibility', default: 'all', valid: oneOf(ORBITAL_OPTIONS.map((option) => option.value)) },
      minAccessibility: { key: 'mineralsMinAccessibility', default: 0, scope: 'race' },
      minAmount: { key: 'mineralsMinAmount', default: null, scope: 'race', normalise: (stored) => (Number(stored) > 0 ? Number(stored) : null) },
      search: { key: 'mineralsSearch', default: '', scope: 'race' },
      colonySearch: { key: 'mineralsColonySearch', default: '', scope: 'race' },
      depositTable: tableView('mineralsDepositsTable', { sortBy: ['potential'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      colonyTable: tableView('mineralsColoniesTable', { sortBy: ['stateOrder'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      policyTable: tableView('mineralsCmcPolicyTable', { sortBy: ['stateOrder'], sortDesc: [false] }),
      cmcAcknowledged: { key: 'mineralsCmcTaxAcknowledged', default: [], scope: 'race', normalise: (stored) => (Array.isArray(stored) ? stored.filter(Number.isInteger) : undefined) },
      cmcRanking: { key: 'mineralsCmcRanking', default: 'headline', scope: 'race', valid: oneOf(RANKINGS.map((option) => option.id)) },
      cmcPreference: { key: 'mineralsCmcPreference', default: { ...DEFAULT_SETTINGS }, scope: 'race', normalise: normaliseSettings },
    }),
  ],
  data() {
    return {
      // Systems the map or a click on this page's map picked, or bodies the Colonization Planner sent.
      selectedSystemIds: [],
      selectedBodies: [],
      selectedRows: [],
      depositExpanded: [],
      colonyExpanded: [],
      pageSizes: PAGE_SIZES,
      bands: BANDS,
      depositViews: DEPOSIT_VIEWS,
      orbitalOptions: ORBITAL_OPTIONS,
      accessibilitySteps: ACCESSIBILITY_STEPS,
      groundSurvey: GROUND_SURVEY,
      stockStates: STOCK_STATES,
      policyStates: POLICY_STATES,
      rankings: RANKINGS,
      settingFields: SETTING_FIELDS,
      settingMaxText: MAX_TEXT,
      candidateExpanded: [],
      candidateRules: { rank: 'minerals.siteOrder', potential: 'minerals.bodyPotential', reserve: 'cmcCandidate.reserve', accessibility: 'cmcCandidate.accessibility', lifetime: 'cmcCandidate.lifetime', score: 'cmcCandidate.score' },
      policyRules: { outputSort: 'cmcPolicy.output', choiceSort: 'cmcPolicy.choice', targetSort: 'cmcPolicy.destination', drivers: 'cmcPolicy.drivers', throughput: 'cmcPolicy.throughput', switchSort: 'cmcPolicy.switch' },
      choiceLabels: { buy: 'Bought', tax: 'Taxed', npr: 'Kept (NPR)' },
      tonnageColumns: ['stock', 'reserve', 'free', 'needs', 'inbound'],
      headerRules: { stock: 'minerals.colonyStock', reserve: 'minerals.colonyStock', free: 'minerals.colonyStock', needs: 'minerals.queueNeeds', inbound: 'minerals.inFlight', driverSort: 'minerals.massDriverRate', stateOrder: 'minerals.stockState' },
      mapHeight: 'clamp(320px, calc(100vh - 460px), 560px)',
      ACCESSIBILITY_FLOOR,
      KM_PER_AU,
      MASS_DRIVER_TONS,
      SUPPLY_BASE_MILLIONS,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    bandColors() {
      return Object.fromEntries(BANDS.map((band) => [band.id, this.appearance.accessibility[band.id]]))
    },

    mutedColor() {
      return withAlpha(this.theme.inkMuted, 0.35)
    },

    raceRules() {
      return this.race || { MineProduction: null, MaximumOrbitalMiningDiameter: null, AllowCMC: false }
    },

    // The race's orbital mining reach and mine output as the options and the foot of the deposits read them, or what the save lacks.
    orbitalLimitNote() {
      const limit = this.raceRules.MaximumOrbitalMiningDiameter

      return Number.isFinite(limit) ? `Orbital miners work bodies up to ${this.count(limit)} km across.` : "The save records no size limit for the race's orbital miners."
    },

    mineProductionText() {
      const production = this.raceRules.MineProduction

      return Number.isFinite(production) ? `${this.count(production)} t` : 'an amount the save does not record'
    },

    // Deposits in view (of the focus mineral, if one is picked) with no recorded amount or accessibility: they are left out of every figure and table, and counted here.
    unreadableCount() {
      return this.scopedBodies.reduce((total, body) => total + body.depositList.filter((deposit) => (!this.focus || deposit.MaterialID === this.focus.id) && !depositReadable(deposit)).length, 0)
    },

    unreadableResult() {
      return unavailable({ rule: 'minerals.potential', missing: ['the amount or accessibility of a deposit'] })
    },

    focus() {
      return MINERALS.find((mineral) => mineral.id === this.focusId) || null
    },

    focusName() {
      return this.focus ? this.focus.name : 'all minerals'
    },

    mineralItems() {
      return [{ id: 0, name: 'All minerals' }, ...MINERALS]
    },

    activeOptionCount() {
      return [this.orbital !== 'all', this.minAccessibility > 0, this.minAmount > 0].filter(Boolean).length
    },

    coloniesById() {
      return byPopulation(this.colonies)
    },

    colonySystemIds() {
      return new Set(this.colonies.map((colony) => colony.SystemID))
    },

    inhabitedSystemIds() {
      return new Set(this.colonies.filter((colony) => colony.Population > 0).map((colony) => colony.SystemID))
    },

    unrestrictedSystemIds() {
      return new Set(this.systems.filter((system) => !system.MilitaryRestrictedSystem).map((system) => system.SystemID))
    },

    reachItems() {
      const sizes = { all: this.systems.length, colonies: this.colonySystemIds.size, inhabited: this.inhabitedSystemIds.size, unrestricted: this.unrestrictedSystemIds.size }

      return REACHES.map((reach) => ({ ...reach, note: this.counted(sizes[reach.id], 'system', 'systems') }))
    },

    // The systems in view: those of the picked bodies, the picked systems, else the preset's (null: every system).
    scopeSystemIds() {
      if (this.selectedBodies.length) {
        return new Set(this.bodies.filter((body) => this.selectedBodyIds.has(body.SystemBodyID)).map((body) => body.SystemID))
      } else if (this.selectedSystemIds.length) {
        return new Set(this.selectedSystemIds)
      }

      return { colonies: this.colonySystemIds, inhabited: this.inhabitedSystemIds, unrestricted: this.unrestrictedSystemIds }[this.reach] || null
    },

    selectedBodyIds() {
      return new Set(this.selectedBodies.map((body) => body.SystemBodyID))
    },

    selection() {
      if (this.selectedBodies.length) {
        return { label: this.counted(this.selectedBodies.length, 'body', 'bodies'), title: this.selectedBodies.map((body) => `${body.SystemName} ${systemBodyName(body)}`).join(', ') }
      } else if (this.selectedSystemIds.length) {
        const names = this.selectedSystemIds.map((id) => (this.systems.find((system) => system.SystemID === id) || { Name: `System #${id}` }).Name)

        return { label: names.length > 2 ? this.counted(names.length, 'system', 'systems') : names.join(', '), title: names.join(', ') }
      }

      return null
    },

    linkQuery() {
      const { selectedBodies, selectedSystemIds } = this

      return linkTo.minerals({ mineral: this.focusId || null, systems: selectedBodies.length ? null : selectedSystemIds, bodies: selectedBodies }).query
    },

    linkLabel() {
      return [this.focus && this.focus.name, this.selection && this.selection.label].filter(Boolean).join(' · ')
    },

    outlookLink() {
      return linkTo.mineralOutlook(this.focusId)
    },

    distanceTo() {
      return buildDistanceMap(this.routes.jumpPoints, this.routes.colonies)
    },

    // Every surveyed body with deposits: its place, its deposits by mineral, who mines it and how far it is.
    bodies() {
      const { raceRules, distanceTo } = this
      const colonies = {}
      const aliens = {}
      const miners = Object.fromEntries(this.miners.map((row) => [row.SystemBodyID, row]))
      const bodies = {}

      this.colonies.forEach((colony) => (colonies[colony.SystemBodyID] = colonies[colony.SystemBodyID] || []).push(colony))
      this.aliens.forEach((alien) => (aliens[alien.SystemBodyID] = aliens[alien.SystemBodyID] || []).push(alien))

      this.deposits.forEach((row) => {
        if (!bodies[row.SystemBodyID]) {
          bodies[row.SystemBodyID] = { ...row, deposits: {} }
        }

        bodies[row.SystemBodyID].deposits[row.MaterialID] = {
          MaterialID: row.MaterialID,
          Amount: row.Amount,
          Accessibility: row.Accessibility,
          HalfOriginalAmount: row.HalfOriginalAmount,
          OriginalAcc: row.OriginalAcc,
        }
      })

      // A body picked by a link stays listed when the save records no deposit on it, so its colonies and miners remain reachable.
      this.selectedBodies.forEach((body) => {
        if (!bodies[body.SystemBodyID]) {
          const [colony] = colonies[body.SystemBodyID] || []

          bodies[body.SystemBodyID] = { ...body, SystemID: colony ? colony.SystemID : null, Xcor: colony ? colony.Xcor : null, Ycor: colony ? colony.Ycor : null, deposits: {}, bare: true }
        }
      })

      return Object.values(bodies).map((row) => {
        const own = colonies[row.SystemBodyID] || []
        const alien = aliens[row.SystemBodyID] || []
        const fleet = miners[row.SystemBodyID]
        const mining = sum(own, 'Mines') + sum(own, 'Automines') + sum(own, 'Complexes') * 10 + (fleet ? fleet.Modules : 0)
        const name = row.SystemBodyName || `${row.SystemName} ${systemBodyName(row)}`
        const diameter = Number.isFinite(row.Radius) ? row.Radius * 2 : null
        const depositList = MINERALS.map((mineral) => row.deposits[mineral.id]).filter(Boolean)
        const placed = Number.isFinite(row.Xcor) && Number.isFinite(row.Ycor)
        const distanceResult = miningDistanceResult(placed ? distanceTo(row) : null, { origins: this.routes.colonies.length, placed })
        const inReach = cmcBodyInReach(row)
        const cmcMinerals = inReach ? CMC_MINERAL_IDS.filter((id) => qualifiesForCmc(row.deposits[id])).map((id) => this.mineralName(id)) : []

        return {
          ...row,
          name,
          place: [row.SystemBodyName ? row.SystemName : null, BODY_CLASSES[row.BodyClass], diameter ? `${this.count(diameter)} km` : null].filter(Boolean).join(' · '),
          search: `${name} ${row.SystemName}`.toLowerCase(),
          Diameter: diameter,
          orbitalEligible: withinOrbitalReach(diameter, raceRules.MaximumOrbitalMiningDiameter),
          depositList,
          unreadable: depositList.filter((deposit) => !depositReadable(deposit)).length,
          complexes: sum(own, 'Complexes'),
          complexGaps: sum(own, 'ComplexGaps'),
          complexColonies: own.filter((colony) => colony.Complexes > 0),
          cmcCandidate: cmcMinerals.join(' and '),
          cmcInReach: inReach,
          workers: [
            ...own.map((colony) => ({ key: `colony-${colony.PopulationID}`, text: colony.PopName, note: this.minesText(colony) })),
            ...(fleet ? [{ key: 'orbital', text: this.counted(fleet.Ships, 'orbital miner', 'orbital miners'), note: this.counted(fleet.Modules, 'module', 'modules') }] : []),
            ...alien.map((population) => ({ key: `alien-${population.PopulationID}`, text: population.PopulationName || 'Alien colony', note: population.AlienRaceName || 'Alien', alien: true })),
          ],
          mining,
          worked: mining > 0,
          tapped: mining > 0 || alien.length > 0,
          miningUnknown: mining === 0 && own.some((colony) => colony.InstallationGaps > 0),
          untapped: !row.bare && mining === 0 && alien.length === 0 && !own.some((colony) => colony.InstallationGaps > 0),
          distance: valueOrNull(distanceResult),
          distanceResult,
        }
      })
    },

    bodiesPassingOrbital() {
      return this.bodies.filter((body) => body.bare || this.orbital === 'all' || (this.orbital === 'eligible') === body.orbitalEligible)
    },

    scopedBodies() {
      const { selectedBodyIds, scopeSystemIds } = this
      const byBody = this.selectedBodies.length > 0

      return this.bodiesPassingOrbital.filter((body) => byBody ? selectedBodyIds.has(body.SystemBodyID) : !scopeSystemIds || scopeSystemIds.has(body.SystemID))
    },

    // Per mineral, over the bodies in view and the deposits the options let through.
    mineralStats() {
      const stats = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, { amount: 0, bands: { good: 0, fair: 0, poor: 0 }, deposits: 0, worked: 0, falling: 0, unknownHalf: 0, unreadable: 0, unranked: 0, best: null, bodyIds: new Set(), systemIds: new Set() }]))

      this.scopedBodies.forEach((body) => {
        body.depositList.forEach((deposit) => {
          const stat = stats[deposit.MaterialID]

          if (!depositReadable(deposit)) {
            stat.unreadable += 1
            stat.unranked += body.tapped ? 0 : 1

            return
          }

          if (!this.passesDeposit(deposit)) {
            return
          }

          stat.amount += deposit.Amount
          stat.bands[bandOf(deposit.Accessibility)] += deposit.Amount
          stat.deposits += 1
          stat.bodyIds.add(body.SystemBodyID)
          stat.systemIds.add(body.SystemID)

          if (body.worked) {
            const past = pastHalf(deposit)

            stat.worked += 1
            stat.falling += past ? 1 : 0
            stat.unknownHalf += past === null ? 1 : 0
          } else if (body.miningUnknown && !body.tapped) {
            stat.unranked += 1
          } else if (body.untapped) {
            const site = { name: body.name, SystemName: body.SystemName, distance: body.distance, distanceResult: body.distanceResult, deposit, potential: depositPotential(deposit), accessibility: deposit.Accessibility, amount: deposit.Amount }

            if (!stat.best || betterSite(site, stat.best) > 0) {
              stat.best = site
            }
          }
        })
      })

      Object.values(stats).forEach((stat) => {
        stat.bestResult = bestSiteResult(stat.best, stat.best && depositPotentialResult(stat.best.deposit), stat.unranked)
      })

      return stats
    },

    // Per colony and mineral: stock, reserve, what moves, what the queue needs and what is on its way.
    colonyStocks() {
      const { needs, packets } = this
      return this.colonies.map((colony) => {
        const exporting = colony.MassDrivers > 0 && colony.MassDriverDest > 0

        return { colony, exporting, minerals: colonyMineralResults(colony, needs, packets, exporting) }
      })
    },

    scopedColonyStocks() {
      return this.colonyStocks.filter(({ colony }) => this.inScope(colony))
    },

    overviewRows() {
      const { scopedColonyStocks, mineralStats } = this
      return MINERALS.map((mineral) => {
        const stocks = scopedColonyStocks.map(({ minerals }) => minerals[mineral.id - 1])
        const stock = sumResults({ rule: 'minerals.colonyStock', results: stocks.map((entry) => entry.results.stock) })
        const free = sumResults({ rule: 'minerals.colonyStock', results: stocks.map((entry) => entry.results.free) })
        const unknown = stocks.filter((entry) => entry.state === null)

        return {
          ...mineral,
          ...mineralStats[mineral.id],
          stock: valueOrNull(stock),
          free: valueOrNull(free),
          stockResult: stock,
          freeResult: free,
          short: stocks.filter((entry) => entry.state === 'short').length,
          below: stocks.filter((entry) => entry.state === 'below').length,
          unknown: unknown.length,
          unknownResult: unknown.length ? unknown[0].results.state : null,
        }
      })
    },

    // The best untapped site for the focus mineral, or the body with the best average potential.
    bestSite() {
      if (this.focus) {
        const stat = this.mineralStats[this.focus.id]

        return { site: stat.best, result: stat.bestResult, unranked: stat.unranked }
      }

      const open = this.allMineralRows.filter((row) => !row.body.tapped)
      const ranked = open.filter((row) => row.potential !== null && !row.body.miningUnknown)
      const site = ranked.reduce((best, row) => (!best || betterSite(row, best) > 0 ? row : best), null)
      const unranked = open.length - ranked.length

      return { site, result: bestSiteResult(site, site && site.potentialResult, unranked), unranked }
    },

    tiles() {
      const rows = this.focus ? this.overviewRows.filter((row) => row.id === this.focus.id) : this.overviewRows
      const bodyIds = new Set(rows.flatMap((row) => [...row.bodyIds]))
      const systemIds = new Set(rows.flatMap((row) => [...row.systemIds]))
      const { site, result: bestResult, unranked } = this.bestSite
      const worked = sum(rows, 'worked')
      const falling = sum(rows, 'falling')
      const unknownHalf = sum(rows, 'unknownHalf')
      const unreadable = sum(rows, 'unreadable')
      const short = this.colonyRows.filter((row) => row.state === 'short').length
      const below = this.colonyRows.filter((row) => row.minerals.some((mineral) => mineral.state === 'below' && (!this.focus || mineral.id === this.focus.id))).length
      const unknownStates = this.colonyRows.filter((row) => row.state === 'unknown').length
      const free = sumResults({ rule: 'minerals.colonyStock', results: this.colonyRows.map((row) => row.results.free) })
      const bestNote = site && [site.name.startsWith(site.SystemName) ? null : site.SystemName, this.focus ? `${compact(site.deposit.Amount)} at ${site.deposit.Accessibility}` : `potential ${roundToDecimal(site.potential, 1)} of 10`, site.distance ? this.distanceText(site.distance) : 'no charted route', unranked ? `${this.counted(unranked, 'deposit', 'deposits')} not ranked for want of a recorded amount, accessibility or mining` : null].filter(Boolean).join(' · ')
      const bestMissing = bestResult ? 'No untapped deposit in view has a recorded amount, accessibility and mining to rank' : 'Everything in view is mined, or held by aliens'
      const minedNote = [falling ? `${this.count(falling)} past half and losing accessibility` : unknownHalf ? null : 'None past half yet; accessibility holds', unknownHalf ? `${this.counted(unknownHalf, 'deposit', 'deposits')} with no recorded original amount` : null].filter(Boolean).join(' · ')

      return [
        {
          label: `${this.focus ? this.focus.name : 'Minerals'} in the ground`,
          value: compact(sum(rows, 'amount')),
          title: `${this.count(sum(rows, 'amount'))} t`,
          note: `${this.counted(sum(rows, 'deposits'), 'deposit', 'deposits')} on ${this.counted(bodyIds.size, 'body', 'bodies')} in ${this.counted(systemIds.size, 'system', 'systems')}${unreadable ? ` · ${this.counted(unreadable, 'deposit', 'deposits')} left out for want of an amount or accessibility` : ''}`,
        },
        {
          label: 'Best untapped site',
          value: site ? site.name : '—',
          title: bestResult ? describeResult(bestResult) : undefined,
          note: site ? bestNote : bestMissing,
        },
        {
          label: 'Deposits mined',
          value: this.count(worked),
          note: worked ? minedNote : 'No colony or orbital miner mines here',
        },
        {
          label: 'Free to move',
          value: isAvailable(free) ? compact(free.value) : '—',
          title: isAvailable(free) ? `${this.count(free.value)} t above the colonies' reserves` : describeResult(free),
          note: `${this.counted(below, 'colony', 'colonies')} below reserve · ${this.count(short)} short for their queue${unknownStates ? ` · ${this.counted(unknownStates, 'colony', 'colonies')} unknown` : ''}${isAvailable(free) ? '' : ' · a stock or reserve is not recorded'}`,
        },
      ]
    },

    // One row per body for all minerals: each mineral's cell, and the totals over the deposits that pass.
    allMineralRows() {
      const { raceRules } = this
      return this.scopedBodies.map((body) => {
        const passing = body.depositList.filter((deposit) => this.passesDeposit(deposit))

        if (!passing.length && !body.unreadable && !body.bare) {
          return null
        }

        const potentialResult = body.bare ? unavailable({ rule: 'minerals.bodyPotential', missing: ['A recorded deposit'] }) : bodyPotentialResult(passing, body.unreadable)
        const perMine = body.bare ? unavailable({ rule: 'minerals.perMine', missing: ['A recorded deposit'] }) : body.unreadable ? unavailable({ rule: 'minerals.perMine', missing: [`The amount or accessibility of ${this.counted(body.unreadable, 'deposit', 'deposits')}`] }) : perMineResult(raceRules.MineProduction, passing)
        const potential = valueOrNull(potentialResult)

        return {
          SystemBodyID: body.SystemBodyID,
          body,
          name: body.name,
          place: body.place,
          SystemName: body.SystemName,
          distance: body.distance,
          nameSort: `${body.SystemName} ${body.name}`,
          amount: sum(passing, 'Amount'),
          accessibility: passing.length ? Math.max(...passing.map((deposit) => deposit.Accessibility)) : null,
          minerals: passing.length,
          unreadable: body.unreadable,
          perMine: valueOrNull(perMine),
          perMineResult: perMine,
          potential,
          potentialResult,
          potentialTitle: potential === null ? describeResult(potentialResult) : `${roundToDecimal(potential, 1)} of 10, the average over the 11 minerals: ${passing.map((deposit) => `${this.mineralName(deposit.MaterialID)} ${roundToDecimal(depositPotential(deposit), 1)}`).join(', ')}${passing.length < MINERALS.length ? `, ${MINERALS.length - passing.length} at 0` : ''}.`,
          cells: MINERALS.map((mineral) => {
            const deposit = body.deposits[mineral.id]
            const passes = !!deposit && this.passesDeposit(deposit)

            return {
              id: mineral.id,
              short: SHORT_NAMES[mineral.id],
              deposit,
              passes,
              band: deposit && depositReadable(deposit) ? bandOf(deposit.Accessibility) : null,
              title: deposit ? (depositReadable(deposit) ? `${mineral.name}: ${this.count(deposit.Amount)} t at accessibility ${deposit.Accessibility}${passes ? '' : ', outside the options'}` : `${mineral.name}: no recorded amount or accessibility, left out`) : `No ${mineral.name}`,
            }
          }),
          workedSort: body.mining,
          distanceSort: body.distance ? body.distance.km : null,
        }
      }).filter(Boolean)
    },

    focusRows() {
      const focus = this.focus
      const { raceRules } = this

      return this.scopedBodies.map((body) => {
        const deposit = body.deposits[focus.id]

        if (!deposit || !this.passesDeposit(deposit)) {
          return null
        }

        const potentialResult = depositPotentialResult(deposit)
        const perMine = perMineResult(raceRules.MineProduction, [deposit])
        const potential = valueOrNull(potentialResult)

        return {
          SystemBodyID: body.SystemBodyID,
          body,
          deposit,
          name: body.name,
          place: body.place,
          nameSort: `${body.SystemName} ${body.name}`,
          amount: deposit.Amount,
          accessibility: deposit.Accessibility,
          band: bandOf(deposit.Accessibility),
          perMine: valueOrNull(perMine),
          perMineResult: perMine,
          potential,
          potentialResult,
          potentialTitle: `${roundToDecimal(potential, 1)} of 10 for ${this.count(deposit.Amount)} t at accessibility ${deposit.Accessibility}`,
          workedSort: body.mining,
          distanceSort: body.distance ? body.distance.km : null,
        }
      }).filter(Boolean)
    },

    viewRows() {
      return this.focus ? this.focusRows : this.allMineralRows
    },

    viewCounts() {
      return {
        all: this.viewRows.length,
        untapped: this.viewRows.filter((row) => row.body.untapped).length,
        worked: this.viewRows.filter((row) => row.body.worked).length,
      }
    },

    depositRows() {
      const search = (this.search || '').toLowerCase()

      return this.viewRows.filter((row) => (this.depositView === 'all' || (this.depositView === 'untapped' ? row.body.untapped : row.body.worked)) && (!search || row.body.search.includes(search)))
    },

    depositHeaders() {
      return [
        { text: 'Body', value: 'nameSort' },
        ...(this.focus ? [
          { text: 'In the ground', value: 'amount', align: 'end' },
          { text: 'Accessibility', value: 'accessibility' },
        ] : [{ text: 'Deposits', value: 'amount' }]),
        { text: 'Per mine', value: 'perMine', align: 'end' },
        { text: 'Potential', value: 'potential', align: 'end' },
        { text: 'Mining', value: 'mining', sortable: false },
        { text: 'Worked by', value: 'workedSort' },
        { text: 'Distance', value: 'distanceSort', align: 'end' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    potentialHint() {
      const rule = 'A deposit scores 0 to 10 from its amount and accessibility: 20,000 t at accessibility 1 scores 5 and 100,000 t at 0.7 about 8, while at 0.1 it stays under 1 however large. Green from 7.5.'

      return this.focus ? rule : `The average over the 11 minerals, so a mineral the body lacks counts as 0. ${rule} Hover a value for its minerals.`
    },

    colonyRows() {
      const noteOf = (names) => (names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', '))

      return this.scopedColonyStocks.map(({ colony, minerals, exporting }) => {
        const picked = this.focus ? [minerals[this.focus.id - 1]] : minerals
        const total = (rule, key) => sumResults({ rule, results: picked.map((mineral) => mineral.results[key]) })
        const results = { stock: total('minerals.colonyStock', 'stock'), reserve: total('minerals.colonyStock', 'reserve'), free: total('minerals.colonyStock', 'free'), needs: total('minerals.queueNeeds', 'needs'), inbound: total('minerals.inFlight', 'inbound') }

        if (Object.values(results).every((result) => isAvailable(result) && result.value === 0) && !this.selectedBodyIds.has(colony.SystemBodyID)) {
          return null
        }

        const { state, result: stateResult, unknown } = worstState(picked)
        const flaggedNames = !this.focus && PRESSING.includes(state) ? picked.filter((mineral) => mineral.state === state).map((mineral) => mineral.name) : []
        const unknownNames = unknown.map((mineral) => mineral.name)
        const destination = exporting ? (this.coloniesById[colony.MassDriverDest] || { PopName: `Colony #${colony.MassDriverDest}` }).PopName : null
        const people = Number.isFinite(colony.Population) ? (colony.Population > 0 ? `${this.count(colony.Population, colony.Population < 10 ? 1 : 0)} M people` : 'no people') : 'population not recorded'

        return {
          key: colony.PopulationID,
          colony,
          minerals,
          name: colony.PopName,
          place: [colony.SystemName, systemBodyName(colony), people].join(' · '),
          search: `${colony.PopName} ${colony.SystemName}`.toLowerCase(),
          stock: valueOrNull(results.stock),
          reserve: valueOrNull(results.reserve),
          free: valueOrNull(results.free),
          needs: valueOrNull(results.needs),
          inbound: valueOrNull(results.inbound),
          results,
          state,
          stateResult,
          stateOrder: state === 'unknown' ? null : STOCK_STATES[state].order,
          stateNote: this.focus ? '' : [noteOf(state === 'unknown' ? unknownNames : flaggedNames), state !== 'unknown' && unknownNames.length ? `${unknownNames.length} unknown` : null].filter(Boolean).join(' · '),
          stateTitle: (state === 'unknown' ? unknownNames : flaggedNames).join(', '),
          destination,
          driverResult: massDriverRateResult(colony.MassDrivers, colony.InstallationGaps),
          driverSort: colony.MassDrivers,
        }
      }).filter(Boolean)
    },

    visibleColonyRows() {
      const search = (this.colonySearch || '').toLowerCase()

      return search ? this.colonyRows.filter((row) => row.search.includes(search)) : this.colonyRows
    },

    colonyHeaders() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Stock', value: 'stock', align: 'end' },
        { text: 'Reserve', value: 'reserve', align: 'end' },
        { text: 'Free to move', value: 'free', align: 'end' },
        { text: 'Queue needs', value: 'needs', align: 'end' },
        { text: 'In flight', value: 'inbound', align: 'end' },
        { text: 'Mass driver', value: 'driverSort' },
        { text: 'State', value: 'stateOrder' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    // The expanded colony's minerals, with what to do about the pressing ones: where the nearest stock free to move is, on the charted route from this colony.
    colonyDetail() {
      const expanded = this.colonyExpanded[0] && this.colonyRows.find((row) => row.key === this.colonyExpanded[0].key)

      if (!expanded) {
        return null
      }

      const { colony, minerals } = expanded
      const routes = searchRoutes(this.routes.jumpPoints, [{ SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor }], { order: 'km' })
      const others = this.colonyStocks.filter((other) => other.colony.PopulationID !== colony.PopulationID)

      return minerals.filter((mineral) => [mineral.stock, mineral.reserve, mineral.needs, mineral.inbound].some((value) => value === null || value > 0)).map((mineral) => {
        if (mineral.state === 'exported') {
          return { ...mineral, advice: `The mass driver can ship off ${compact(Math.min(mineral.stock, mineral.needs) - mineral.reserve)} the queue needs; a reserve of ${compact(mineral.needs)} keeps it here.` }
        } else if (mineral.state !== 'short' && mineral.state !== 'below') {
          return mineral
        }

        const missing = mineral.state === 'short' ? mineral.needs - mineral.stock : mineral.reserve - mineral.stock
        const candidates = others.map((other) => ({ other, free: other.minerals[mineral.id - 1].free }))
        const unknownFree = candidates.filter(({ free }) => free === null).length
        const source = candidates.filter(({ free }) => free >= 1).map((candidate) => ({ ...candidate, route: routes.toPlace({ SystemID: candidate.other.colony.SystemID, Xcor: candidate.other.colony.Xcor, Ycor: candidate.other.colony.Ycor }) })).filter(({ route }) => route).reduce((best, candidate) => (!best || candidate.route.km < best.route.km ? candidate : best), null)
        const lack = `${compact(missing)} ${mineral.state === 'short' ? 'more for the queue' : 'under the reserve'}`
        const unknownText = unknownFree ? `, and ${this.counted(unknownFree, 'colony', 'colonies')} ${unknownFree === 1 ? 'has' : 'have'} no recorded stock or reserve` : ''

        return {
          ...mineral,
          advice: source ? `${lack}. Nearest free stock: ${source.other.colony.PopName}, ${compact(source.free)}, ${this.distanceText(source.route)}.${unknownText ? ` Not counted: ${this.counted(unknownFree, 'colony', 'colonies')} with no recorded stock or reserve.` : ''}` : `${lack}. No colony on a charted route has any free to move${unknownText}.`,
          adviceRoute: !!source,
        }
      })
    },

    // The civilian mining policy (utilities/cmc-policy.js) of every colony of the race whose complexes produce, in every system whatever the view.
    policyAudit() {
      return cmcPolicyRows(this.policy, { RaceID: this.RaceID, version: this.formulaVersion, acknowledged: this.cmcAcknowledged })
    },

    // The civilian mining candidates, ranked by the headline order or the longevity preference (utilities/cmc-candidates.js), in every system whatever the view.
    candidates() {
      return candidateRanking({ bodies: this.bodies, race: this.race, allowed: this.raceRules.AllowCMC, settings: this.cmcPreference, ranking: this.cmcRanking })
    },

    candidateHeaders() {
      return [
        { text: 'Rank', value: 'rank' },
        { text: 'Body', value: 'name' },
        { text: 'Potential', value: 'potential', align: 'end' },
        { text: 'Reserve', value: 'reserve', align: 'end' },
        { text: 'Accessibility', value: 'accessibility' },
        { text: 'Lifetime', value: 'lifetime', align: 'end' },
        { text: 'Longevity score', value: 'score' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    candidateSummary() {
      const { rows, shown } = this.candidates
      const possible = rows.filter((row) => row.status === 'possible').length
      const known = rows.length - possible

      return `${this.counted(known, 'candidate', 'candidates')}${possible ? `, ${this.counted(possible, 'possible', 'possible')}` : ''} · ordered by ${shown === 'longevity' ? 'the longevity preference' : 'the headline order'}`
    },

    candidateEmptyText() {
      return this.raceRules.AllowCMC ? 'No surveyed body in reach, without a complex, holds more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better.' : 'Civilian mining complexes are switched off for the game.'
    },

    policyRows() {
      const stocks = Object.fromEntries(this.colonyStocks.map((entry) => [entry.colony.PopulationID, entry]))

      return this.policyAudit.rows.map((row) => {
        const colony = this.coloniesById[row.PopulationID]
        const stock = stocks[row.PopulationID]
        const held = stock ? sumResults({ rule: 'minerals.colonyStock', results: stock.minerals.map((mineral) => mineral.results.stock) }) : unavailable({ rule: 'minerals.colonyStock', missing: ["the colony's stockpile"] })
        const unknownResult = row.state === 'unknown' ? [row.production, row.choiceResult, row.targetResult, row.sourceDrivers, row.receiverDrivers, row.throughput.result].find((result) => result && !isAvailable(result)) || null : null

        return {
          ...row,
          key: row.PopulationID,
          name: colony ? colony.PopName : `Colony #${row.PopulationID}`,
          place: colony ? [colony.SystemName, systemBodyName(colony)].filter(Boolean).join(' · ') : '',
          destinationName: this.destinationName(row),
          held,
          unknownResult,
          outputSort: valueOrNull(row.output),
          choiceSort: row.choice,
          targetSort: row.target ? Object.keys(TARGET_STATES).indexOf(row.target) : null,
          switchSort: isAvailable(row.switch) ? row.switch.value.wealth : null,
          stateOrder: POLICY_STATES[row.state].order,
        }
      })
    },

    // How many colonies are in each state, most pressing first.
    policySummary() {
      return Object.entries(POLICY_STATES).map(([state, { label }]) => [this.policyRows.filter((row) => row.state === state).length, label]).filter(([count]) => count).map(([count, label]) => `${this.count(count)} ${label.toLowerCase()}`).join(' · ')
    },

    policyHasStockpiling() {
      return this.policyRows.some((row) => row.state === 'stockpiling')
    },

    stockpilingLink() {
      return linkTo.warnings({ check: 'stockpiling-civilian-minerals' })
    },

    policyHeaders() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Complexes', value: 'outputSort', align: 'end' },
        { text: 'Choice', value: 'choiceSort' },
        { text: 'Export', value: 'targetSort' },
        { text: 'Mass drivers', value: 'drivers', sortable: false },
        { text: 'Throughput', value: 'throughput', sortable: false },
        { text: 'If switched', value: 'switchSort', align: 'end' },
        { text: 'Verdict', value: 'stateOrder' },
      ]
    },

    // The rates sentence of the policy panel's foot: the game's constants where they hold for the save, or why the wealth figures show a dash.
    policyRatesNote() {
      return ruleSupports('cmcPolicy.rates', this.formulaVersion) === true ? `Buying a complex's output costs ${this.count(CMC_PURCHASE_COST)} wealth a year and taxing it brings in ${this.count(CMC_TAX_INCOME)}, the game's rates; the save stores neither.` : "No purchase or tax rate is verified for the save's game version, so the wealth figures and If switched show a dash."
    },

    mapLinks() {
      return jumpLinks(this.routes.jumpPoints)
    },

    mapSelected() {
      return this.selectedSystemIds.length === 1 ? this.selectedSystemIds[0] : null
    },

    // Per system, the deposits of the focus mineral that pass the options and the deposit view, whether or not the system is in view.
    systemDeposits() {
      const systems = {}

      this.bodiesPassingOrbital.forEach((body) => {
        if (this.depositView !== 'all' && (this.depositView === 'untapped' ? !body.untapped : !body.worked)) {
          return
        }

        body.depositList.forEach((deposit) => {
          if ((this.focus && deposit.MaterialID !== this.focus.id) || !this.passesDeposit(deposit)) {
            return
          }

          const system = (systems[body.SystemID] = systems[body.SystemID] || { amount: 0, deposits: 0, best: 0 })

          system.amount += deposit.Amount
          system.deposits += 1
          system.best = Math.max(system.best, deposit.Accessibility)
        })
      })

      return systems
    },

    // Out-of-view and empty systems first, so the ones with deposits in view draw on top.
    mapNodes() {
      const systems = this.systemDeposits
      const { scopeSystemIds, colonySystemIds, bandColors, mutedColor, theme, mapSelected, focusName } = this
      const largest = Math.max(1, ...Object.values(systems).map((system) => system.amount))

      return this.systems.map((system) => {
        const deposits = systems[system.SystemID]
        const shown = !!deposits && (!scopeSystemIds || scopeSystemIds.has(system.SystemID))
        const colonised = colonySystemIds.has(system.SystemID)

        return {
          SystemID: system.SystemID,
          Name: system.Name,
          Xcor: system.Xcor,
          Ycor: system.Ycor,
          size: deposits ? 4 + 10 * Math.sqrt(deposits.amount / largest) : 3,
          color: shown ? bandColors[bandOf(deposits.best)] : mutedColor,
          ring: colonised ? theme.ink : null,
          label: colonised || system.SystemID === mapSelected,
          title: deposits ? `${system.Name}: ${compact(deposits.amount)} of ${focusName} in ${this.counted(deposits.deposits, 'deposit', 'deposits')}, best accessibility ${deposits.best}${shown ? '' : ' (out of view)'}` : `${system.Name}: no ${focusName} deposits that pass`,
          order: shown ? deposits.amount : -1,
        }
      }).sort((a, b) => a.order - b.order)
    },
  },
  watch: {
    // A picked system or set of bodies belongs to one race's map, so another race starts without them.
    RaceID(_value, previous) {
      if (previous) {
        this.clearSelection()
      }
    },
  },
  methods: {
    applyLink(query) {
      const mineral = queryId(query.mineral)
      const bodies = queryBodies(query.bodies)

      this.setUnsaved('focusId', MINERALS.some((item) => item.id === mineral) ? mineral : 0)
      this.selectedBodies = bodies
      this.selectedSystemIds = bodies.length ? [] : queryIds(query.systems)
    },

    roundToDecimal,
    compact,
    withAlpha,
    isAvailable,
    describeResult,

    setFocus(id) {
      this.focusId = id
    },

    resetOptions() {
      this.orbital = 'all'
      this.minAccessibility = 0
      this.minAmount = null
    },

    clearSelection() {
      this.selectedSystemIds = []
      this.selectedBodies = []
    },

    // A click on the map lists only that system; a second click shows the preset again.
    selectSystem(id) {
      this.selectedBodies = []
      this.selectedSystemIds = this.mapSelected === id ? [] : [id]
    },

    inScope(place) {
      if (this.selectedBodies.length) {
        return this.selectedBodyIds.has(place.SystemBodyID)
      }

      return this.systemInScope(place.SystemID)
    },

    systemInScope(systemId) {
      return !this.scopeSystemIds || this.scopeSystemIds.has(systemId)
    },

    passesDeposit(deposit) {
      return depositReadable(deposit) && deposit.Accessibility >= this.minAccessibility && (!(this.minAmount > 0) || deposit.Amount >= this.minAmount)
    },

    mineralName(id) {
      return MINERALS[id - 1].name
    },

    // A tonnage, or a dash when it is not recorded: a real 0 stays 0.
    tons(value) {
      return Number.isFinite(value) ? compact(value) : '—'
    },

    tonsTitle(value) {
      return Number.isFinite(value) ? `${this.count(value)} t` : 'Not recorded'
    },

    plain(value) {
      return Number.isFinite(value) ? value : '—'
    },

    exactTons(result) {
      return isAvailable(result) ? `${this.count(result.value)} t` : describeResult(result)
    },

    driverCapacity(result) {
      return isAvailable(result) ? `up to ${compact(result.value)} a year` : 'capacity not recorded'
    },

    perYear(result) {
      return isAvailable(result) ? `${this.count(result.value)} t/yr` : '—'
    },

    // Whether a figure carries a mark of its own: anything short of confirmed.
    unsure(result) {
      return !!result && result.status !== 'confirmed'
    },

    potentialOf(deposit) {
      return depositPotentialResult(deposit)
    },

    potentialText(result) {
      return isAvailable(result) ? roundToDecimal(result.value, 1) : '—'
    },

    perMineOf(deposit) {
      return perMineResult(this.raceRules.MineProduction, [deposit])
    },

    // Sorts by the first column; a figure that is not known (null) goes last whichever way the column runs, never as 0.
    sortNullLast(items, sortBy, sortDesc) {
      const [by] = sortBy
      const missing = (value) => value === null || value === undefined || Number.isNaN(value)

      if (!by) {
        return items
      }

      const direction = sortDesc[0] ? -1 : 1

      return [...items].sort((a, b) => {
        const x = a[by]
        const y = b[by]

        if (missing(x) || missing(y)) {
          return missing(x) ? (missing(y) ? 0 : 1) : -1
        }

        return (typeof x === 'string' || typeof y === 'string' ? String(x).toLowerCase().localeCompare(String(y).toLowerCase()) : x - y) * direction
      })
    },

    counted(value, one, many) {
      return `${this.count(value)} ${Math.round(value) === 1 ? one : many}`
    },

    distanceText(route) {
      return `${roundToDecimal(route.km / KM_PER_AU, 1)} AU, ${route.jumps ? this.counted(route.jumps, 'jump', 'jumps') : 'same system'}`
    },

    bandTitle(row) {
      return BANDS.map((band) => `${band.label}: ${this.count(row.bands[band.id])} t`).join(', ')
    },

    // Accessibility holds down to half the original amount, then falls with what is left.
    depletionText(deposit, long = false) {
      const past = pastHalf(deposit)

      if (past === null) {
        return long ? 'Depletion not known: no recorded amount or original amount' : 'depletion not known'
      } else if (!(deposit.HalfOriginalAmount > 0)) {
        return ''
      } else if (!past) {
        return long ? `Holds for ${compact(deposit.Amount - deposit.HalfOriginalAmount)} more, then falls toward ${ACCESSIBILITY_FLOOR}` : `holds for ${compact(deposit.Amount - deposit.HalfOriginalAmount)}`
      }

      return long ? `Past half: falls with what is left, to ${ACCESSIBILITY_FLOOR} when empty` : 'past half, falling'
    },

    minesText(colony) {
      const parts = [
        colony.Mines >= 0.5 && this.counted(colony.Mines, 'mine', 'mines'),
        colony.Automines >= 0.5 && this.counted(colony.Automines, 'automine', 'automines'),
        colony.Complexes > 0 && this.counted(colony.Complexes, 'CMC', 'CMCs'),
      ].filter(Boolean)

      return parts.length ? parts.join(', ') : colony.InstallationGaps > 0 ? 'mines not fully recorded' : 'no mines'
    },

    cmcText(body) {
      const names = body.complexColonies.map((colony) => colony.PopName)
      const purchased = body.complexColonies.some((colony) => colony.PurchaseCivilianMinerals)

      return `${names.join(' and ')} ${names.length > 1 ? 'run' : 'runs'} ${this.counted(body.complexes, 'civilian mining complex', 'civilian mining complexes')} here. ${purchased ? 'The race buys their minerals.' : "The race taxes them; their minerals don't reach its stockpile."}`
    },

    plannerLink(rows) {
      return linkTo.planner({ bodies: rows.map((row) => row.body || row) })
    },

    settingError(field) {
      const read = this.candidates.parsed[field.key]

      return read.state === 'ok' ? [] : [read.state === 'blank' ? 'Blank, so not known' : `Rejected: ${read.reason}`]
    },

    resetPreference() {
      this.cmcPreference = { ...DEFAULT_SETTINGS }
    },

    rankText(rank) {
      return rank === null ? '—' : `#${rank}`
    },

    yearsText(result) {
      return isAvailable(result) ? `${compactYears(result.value, this.separator)} yr` : '—'
    },

    // One term of a longevity score: its value, the weight it carries and what it adds to the score.
    termText(entry) {
      if (!isAvailable(entry.term)) {
        return `${entry.label}: —`
      }

      return `${entry.label}: ${this.count(entry.term.value, 2)} × ${entry.weight === null ? '—' : this.count(entry.weight, 2)} → ${entry.contribution === null ? '—' : this.count(entry.contribution, 2)}`
    },

    colonyLink(row) {
      return linkTo.colonyOutlook(row.PopulationID)
    },

    // The name of a policy row's destination: a colony of the race by its name, one of another race unnamed, one that is gone by its id.
    destinationName(row) {
      if (!row.destination) {
        return null
      } else if (row.target === 'foreign') {
        return TARGET_STATES.foreign
      }

      const colony = this.coloniesById[row.destination.PopulationID]

      return colony ? colony.PopName : row.destination.name || `Colony #${row.destination.PopulationID}`
    },

    // What a row's destination does: for a bought output, whether it ships or stays; otherwise what the destination means for the stock above the reserve.
    targetText(row) {
      if (!row.target) {
        return 'Destination not known'
      } else if (row.target === 'valid') {
        return row.choice === 'buy' ? 'Destination valid' : 'Ships the stock above the reserve'
      } else if (row.target === 'none' || row.target === 'gone') {
        const what = row.target === 'none' ? 'No destination' : 'Destination gone'

        return row.choice === 'buy' ? `${what}: the bought output stays here` : what
      }

      return `Invalid: ${TARGET_STATES[row.target]}, never offered by the game`
    },

    targetClass(row) {
      return ['self', 'foreign', 'elsewhere'].includes(row.target) ? 'error--text' : row.choice === 'buy' && (row.target === 'none' || row.target === 'gone') ? 'warning--text' : 'text--secondary'
    },

    // A mass driver verdict as an icon: present, missing or not known.
    driverIcon(result) {
      if (!isAvailable(result)) {
        return { icon: 'mdi-help-circle-outline', color: undefined }
      }

      return result.value ? { icon: 'mdi-check', color: 'success' } : { icon: 'mdi-close', color: 'error' }
    },

    driverText(result, drivers, where) {
      return isAvailable(result) ? `${where}: ${result.value ? this.counted(drivers, 'driver', 'drivers') : 'no driver'}` : `${where}: —`
    },

    // What of a row's output ships, and against what.
    throughputText(row) {
      const { state, result } = row.throughput

      if (state === 'unbought') {
        return row.choice === 'tax' ? 'The taxed output reaches no stockpile' : 'Kept at the source'
      } else if (state === 'stays') {
        return 'Nothing ships'
      } else if (state === 'invalid') {
        return 'No valid destination to ship to'
      } else if (state === 'unknown') {
        return 'Not known'
      }

      return `${compact(result.value.output)} a year ${state === 'within' ? 'within' : 'over'} the drivers' ${compact(result.value.capacity)}`
    },

    throughputNote(row) {
      const { state } = row.throughput

      if (state === 'over') {
        return 'Ships in full in a packet of its own; the drivers\' capacity limits the stock above the reserve.'
      } else if (state === 'stays') {
        return isAvailable(row.held) ? `${compact(row.held.value)} held here` : 'Stock here not known'
      } else if (state === 'unbought' && row.target === 'valid' && isAvailable(row.capacity)) {
        return `Drivers ship up to ${compact(row.capacity.value)} a year of the stock above the reserve.`
      }

      return ''
    },

    // A signed figure: a plus for a gain, a minus sign for a loss, 0 as 0.
    signed(value, text) {
      return value > 0 ? `+${text(value)}` : value < 0 ? `\u2212${text(-value)}` : text(0)
    },

    wealthText(result) {
      return isAvailable(result) ? `${this.signed(result.value, (value) => this.count(value))} wealth a year` : '—'
    },

    toggleAcknowledged(row) {
      const ids = new Set(this.cmcAcknowledged)

      if (ids.has(row.PopulationID)) {
        ids.delete(row.PopulationID)
      } else {
        ids.add(row.PopulationID)
      }

      this.cmcAcknowledged = [...ids].sort((a, b) => a - b)
    },
  },
  asyncComputed: {
    race: {
      get: tracked('race', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        const [[race]] = await this.database.query(`select FCT_Race.MineProduction, FCT_Race.MaximumOrbitalMiningDiameter, (select max(DIM_PlanetaryInstallation.MiningProductionValue) from DIM_PlanetaryInstallation where DIM_PlanetaryInstallation.CivilianInstallation = 1) as ComplexMining, FCT_Game.AllowCMC from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID}`)

        return race ? { MineProduction: race.MineProduction, MaximumOrbitalMiningDiameter: race.MaximumOrbitalMiningDiameter, ComplexMining: race.ComplexMining, AllowCMC: cmcAllowedOf(race) } : null
      }),
      default: null,
    },

    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [systems] = await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.MilitaryRestrictedSystem from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`)

        return Object.freeze(systems)
      }),
      default: [],
    },

    routes: {
      get: tracked('routes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { jumpPoints: [], capital: null, colonies: [] }
        }

        return loadRoutes(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { jumpPoints: [], capital: null, colonies: [] },
    },

    // The deposits on bodies the race has surveyed, in systems it knows, with each body's place and orbit.
    deposits: {
      get: tracked('deposits', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [deposits] = await this.database.query(`select FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.Radius, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.Eccentricity, FCT_SystemBody.RadiationLevel, VIR_Parent.OrbitalDistance as ParentOrbitalDistance, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName from FCT_MineralDeposit inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBody as VIR_Parent on VIR_Parent.SystemBodyID = FCT_SystemBody.ParentBodyID and FCT_SystemBody.ParentBodyType = 1 left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_MineralDeposit.GameID = ${this.GameID} and FCT_MineralDeposit.SystemBodyID in (select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys where FCT_SystemBodySurveys.GameID = ${this.GameID} and FCT_SystemBodySurveys.RaceID = ${this.RaceID})`)

        return Object.freeze(deposits)
      }),
      default: [],
    },

    // The race's colonies: stock and reserve of each mineral, mining in mine equivalents (manned, automated) and civilian complexes, mass drivers and where they send.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [colonies] = await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_Population.Population, FCT_Population.Capital, FCT_Population.MassDriverDest, case when FCT_Race.NPR = 1 then 1 else FCT_Population.PurchaseCivilianMinerals end as PurchaseCivilianMinerals, ${STOCK_COLUMNS}, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_RaceSysSurvey.Name as SystemName, coalesce(VIR_Installations.Mines, 0) as Mines, coalesce(VIR_Installations.Automines, 0) as Automines, coalesce(VIR_Installations.Complexes, 0) as Complexes, coalesce(VIR_Installations.MassDrivers, 0) as MassDrivers, coalesce(VIR_Installations.Gaps, 0) as InstallationGaps, coalesce(VIR_Installations.ComplexGaps, 0) as ComplexGaps from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID left join (select FCT_PopulationInstallations.PopID, sum(case when DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Mines, sum(case when DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers = 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as Automines, sum(case when DIM_PlanetaryInstallation.CivilianInstallation = 1 and DIM_PlanetaryInstallation.MiningProductionValue > 0 then FCT_PopulationInstallations.Amount else 0 end) as Complexes, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MassDriverValue) as MassDrivers, sum(case when FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.CivilianInstallation is null or DIM_PlanetaryInstallation.Workers is null or DIM_PlanetaryInstallation.MiningProductionValue is null or DIM_PlanetaryInstallation.MassDriverValue is null then 1 else 0 end) as Gaps, sum(case when DIM_PlanetaryInstallation.CivilianInstallation is null or (DIM_PlanetaryInstallation.CivilianInstallation = 1 and (FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.MiningProductionValue is null)) then 1 else 0 end) as ComplexGaps from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`)

        return Object.freeze(colonies)
      }),
      default: [],
    },

    // What each colony's queue still needs, by colony.
    needs: {
      get: tracked('needs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadQueueNeeds(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },

    // Mass-driver packets in flight, by the colony they are bound for.
    packets: {
      get: tracked('packets', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadPacketsInFlight(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },

    // The race's ships with mining modules, by the body their fleet orbits.
    miners: {
      get: tracked('miners', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [miners] = await this.database.query(`select FCT_Fleet.OrbitBodyID as SystemBodyID, count(*) as Ships, sum(FCT_ShipClass.MiningModules) as Modules from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Fleet.OrbitBodyID > 0 group by FCT_Fleet.OrbitBodyID`)

        return Object.freeze(miners)
      }),
      default: [],
    },

    // Alien colonies the race knows of, on their bodies.
    aliens: {
      get: tracked('aliens', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [aliens] = await this.database.query(`select FCT_AlienPopulation.PopulationID, FCT_AlienPopulation.PopulationName, FCT_Population.SystemBodyID, FCT_AlienRace.AlienRaceName from FCT_AlienPopulation inner join FCT_Population on FCT_Population.PopulationID = FCT_AlienPopulation.PopulationID left join FCT_AlienRace on FCT_AlienRace.AlienRaceID = FCT_AlienPopulation.AlienRaceID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.GameID = ${this.GameID} where FCT_AlienPopulation.GameID = ${this.GameID} and FCT_AlienPopulation.ViewingRaceID = ${this.RaceID}`)

        return Object.freeze(aliens)
      }),
      default: [],
    },

    // The race's civilian mining complex colonies and their output, for the policy panel.
    policy: {
      get: tracked('policy', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_CMC_POLICY
        }

        return await loadCmcPolicy(this.database, { GameID: this.GameID, RaceID: this.RaceID, blocked })
      }),
      default: NO_CMC_POLICY,
    },

    // The formula version the save's schema stands for (`loadFormulaVersion`, utilities/capabilities.js): the stated one for a save that has the formula columns, null for a save without them. The civilian mining rates hold for that version only.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.minerals-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }

  .tool {
    min-width: 0;
  }

  .tool__label {
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
  }

  .tool--mineral {
    flex: 0 1 220px;
    min-width: 180px;
  }

  .tool--reach {
    flex: 0 1 280px;
    min-width: 200px;
  }

  .tool--actions {
    align-self: flex-end;
    margin-left: auto;
  }

  .toolbar .v-btn-toggle .v-btn,
  .tool--actions .v-btn,
  .selection-chip {
    height: 40px !important;
  }

  .selection-chip {
    max-width: 320px;
  }

  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  .panel {
    margin-top: 8px;
  }

  > .panel {
    margin-top: 20px;
  }

  .head-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;

    .v-btn-toggle .v-btn {
      height: 40px !important;
    }
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .selection-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 0 24px 12px;
  }

  .candidate-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 12px;
    padding: 0 24px 12px;
  }

  .candidate-field {
    flex: 0 0 170px;
    max-width: 170px;
  }

  .candidate-reset {
    align-self: center;
  }

  .candidate-assumptions {
    margin: 0;
    padding: 0 24px 12px;
    list-style: none;
  }

  .overview-row {
    cursor: pointer;
  }

  tr.is-selected-row {
    background: var(--ae-row-selected);
  }

  .band-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .band-meter,
  .meter {
    display: flex;
    flex: 0 0 72px;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
    overflow: hidden;
  }

  .band-meter__part,
  .meter-fill {
    height: 100%;
  }

  .meter-fill {
    border-radius: 3px;
  }

  .mineral-strip {
    display: flex;
    gap: 2px;
  }

  .mineral-strip__cell {
    flex: 0 0 22px;
    height: 20px;
    line-height: calc(17px * var(--ae-font-scale));
    font-size: calc(10px * var(--ae-font-scale));
    text-align: center;
    border-radius: 2px;
    border-bottom: 3px solid transparent;
  }

  .mineral-strip__cell--empty {
    opacity: 0.3;
  }

  .mineral-strip__cell--out {
    border: 1px dashed rgba(127, 127, 127, 0.6);
    line-height: calc(18px * var(--ae-font-scale));
  }

  .chip-cell {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .wrap-cell {
    max-width: 260px;
  }

  .policy-wrap {
    min-width: 180px;
  }

  .worker-cell {
    min-width: 140px;
  }

  .distance-cell {
    max-width: 140px;
  }

  .acknowledge-button {
    margin-top: 2px;
    text-transform: none;
  }

  .expand-cell {
    padding: 8px 24px 16px !important;
  }

  .detail-table {
    background: transparent !important;
  }

  .detail-links {
    margin-top: 8px;
  }
}
</style>
