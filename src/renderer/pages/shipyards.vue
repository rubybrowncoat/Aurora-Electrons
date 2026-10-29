<template>
  <div>
    <v-container fluid class="shipyards-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <v-row dense align="center" class="mb-1">
          <v-col cols="auto" class="d-flex align-center mr-4">
            <span class="caption text--secondary mr-2">View</span>
            <v-btn-toggle v-model="view" mandatory dense>
              <v-btn v-for="option in viewOptions" :key="option.value" :value="option.value" small>{{ option.label }}</v-btn>
            </v-btn-toggle>
          </v-col>
        </v-row>

        <stat-tiles :tiles="tiles" />

        <v-card v-if="view === 'yards'" class="panel" data-summary="Every shipyard of the race once, with its tasks, its upgrade or retool and its slipway price." elevation="1">
          <div class="panel-head">
            <span>Shipyards<provenance-mark rule="production.shipyardUpgradeFinish" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-chip v-if="colonyId" small close @click:close="colonyId = null">{{ colonyName }}</v-chip>
              <v-switch v-model="idleOnly" label="Free slipway only" dense hide-details class="mt-0" />
              <v-text-field v-model="yardSearch" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <div v-if="!inventoryRows.length" class="panel-body caption text--secondary">{{ inventoryHint }}</div>
          <v-data-table v-else :headers="inventoryHeaders" :items="inventoryRows" item-key="id" :custom-sort="sortNullLast" :sort-by.sync="yardsList.sortBy" :sort-desc.sync="yardsList.sortDesc" :expanded.sync="expanded" :item-class="yardRowClass" show-expand disable-pagination hide-default-footer>
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div class="flex-grow-1">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div class="caption text--secondary">{{ item.colony || '—' }}<v-chip v-if="item.shipBased === true" x-small class="ml-1" title="The yard belongs to a ship and cannot be modified">Ship-based</v-chip></div>
                </div>
                <page-link v-if="item.populationId" :to="linkTo.production(item.populationId)" :name="item.colony || ''" />
              </div>
            </template>
            <template #[`item.freeSlipways`]="{ item }">
              <span v-if="item.slipwaysText" class="text-no-wrap">{{ item.slipwaysText }}</span>
              <span v-else class="text-no-wrap">—<provenance-mark :result="item.slipwaysGap" /></span>
              <div v-if="item.retooling" class="caption text--secondary">A retool holds no slipway</div>
            </template>
            <template #[`item.capacity`]="{ item }">{{ count(item.capacity) }}</template>
            <template #[`item.tooledName`]="{ item }">
              <span v-if="item.tooled === undefined" class="text-no-wrap">—<provenance-mark :result="item.tooledGap" /></span>
              <span v-else-if="item.tooled === null" class="text--secondary">None</span>
              <span v-else class="d-flex align-center flex-wrap">
                {{ item.tooledName }}
                <v-chip v-if="item.tooled.obsolete === true" x-small class="ml-1" title="The class is marked obsolete">Obsolete</v-chip>
                <page-link :to="linkTo.propulsion({ class: item.tooled.id })" :name="item.tooledName" />
              </span>
            </template>
            <template #[`item.taskCount`]="{ item }">
              <span v-if="item.taskCount === null" class="text-no-wrap">—<provenance-mark :result="item.taskGap" /></span>
              <span v-else-if="!item.taskCount" class="text--secondary">None</span>
              <div v-else class="py-1">
                <div class="font-weight-medium">{{ count(item.taskCount) }}</div>
                <div v-for="line in item.taskLines.slice(0, 3)" :key="line.id" class="caption text--secondary">{{ line.label }} · {{ line.subject }} · <span class="text-no-wrap">{{ taskTime(line) }}<provenance-mark :result="line.result" /></span></div>
                <div v-if="item.taskLines.length > 3" class="caption text--secondary">and {{ count(item.taskLines.length - 3) }} more</div>
              </div>
            </template>
            <template #[`item.activitySort`]="{ item }">
              <span v-if="!item.activity" class="text--secondary">None</span>
              <div v-else class="py-1">
                <div class="font-weight-medium">{{ item.activity.label }}<v-chip v-if="item.activity.paused" x-small class="ml-1">Paused</v-chip></div>
                <div v-if="item.activity.detail" class="caption text--secondary">{{ item.activity.detail }}</div>
                <div class="caption text--secondary text-no-wrap">{{ activityTime(item.activity) }}<provenance-mark :result="item.activity.result" /></div>
              </div>
            </template>
            <template #[`item.slipwayBP`]="{ item }">
              <span v-if="item.slipwayBP !== null" class="text-no-wrap">{{ count(item.slipwayBP, 1) }} BP<provenance-mark :result="item.slipwayResult" /></span>
              <span v-else class="text-no-wrap">—<provenance-mark :result="item.slipwayResult" /></span>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="yard-detail">
                <v-row dense>
                  <v-col cols="12" md="6">
                    <div class="font-weight-medium mb-1">Tasks</div>
                    <div v-if="item.taskLines === null" class="caption text--secondary">The save does not list the tasks at the yard.</div>
                    <div v-else-if="!item.taskLines.length" class="caption text--secondary">No task at the yard.</div>
                    <v-simple-table v-else dense>
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Subject</th>
                          <th class="text-right">Left (BP)</th>
                          <th class="text-right">Rate (BP/yr)</th>
                          <th class="text-right">Time left</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="line in item.taskLines" :key="line.id">
                          <td>{{ line.label }}</td>
                          <td>{{ line.subject }}</td>
                          <td class="text-right">{{ count(line.remaining, 1) }}</td>
                          <td class="text-right text-no-wrap">{{ line.rate === null ? '—' : count(line.rate, 1) }}<provenance-mark :result="line.rateResult" /></td>
                          <td class="text-right text-no-wrap">{{ taskTime(line) }}<provenance-mark :result="line.result" /></td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                  </v-col>
                  <v-col cols="12" md="6">
                    <div class="d-flex align-center mb-1">
                      <span class="font-weight-medium">Upgrade prices</span>
                      <v-spacer />
                      <v-btn x-small text color="primary" @click="openGrowth(item.id)">Growth view</v-btn>
                    </div>
                    <div v-if="item.shipBased === true" class="caption text--secondary mb-1">The yard belongs to a ship, which the game does not let be modified: no upgrade is priced.</div>
                    <v-simple-table dense>
                      <thead>
                        <tr>
                          <th>Upgrade</th>
                          <th class="text-right">Price (BP)</th>
                          <th class="text-right">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="step in growthOf(item.yard).rows" :key="step.key">
                          <td>{{ step.label }}</td>
                          <td class="text-right text-no-wrap">{{ count(figureOf(step.price), 1) }}<provenance-mark :result="step.price" /></td>
                          <td class="text-right text-no-wrap">{{ growthTime(step) }}<provenance-mark :result="step.time" /></td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                  </v-col>
                </v-row>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Use it to find idle yards and to see what keeps each one busy. A yard appears once, with every task it works. A task's time left is the Production Recap's: the build points not yet done over the colony's shipyard rate for the task's class. The activity is the yard's own upgrade or retool; a continual upgrade's time is approximate. A retool holds no slipway, so the free slipways are the slipways less the tasks. The add-slipway price is the yard's capacity over 500 tons times 120 times the race's shipyard operations, a tenth of it at a commercial or repair yard. Obsolete marks a yard tooled for a class that is marked obsolete.<provenance-mark rule="shipyardGrowth.slipwayPrice" />
          </div>
        </v-card>

        <v-card v-if="view === 'growth'" class="panel" data-summary="What it costs, in build points and time, to add a slipway or capacity to one shipyard." elevation="1">
          <div class="panel-head">
            <span>Yard growth<provenance-mark rule="shipyardGrowth.capacityStep" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-autocomplete :value="growthYard ? growthYard.id : null" :items="yardOptions" item-text="name" item-value="id" label="Shipyard" dense outlined hide-details clearable class="yard-picker" @change="yardId = $event || null" />
              <v-text-field :value="growthTarget === null ? '' : String(growthTarget)" label="Continual target (t)" :placeholder="targetPlaceholder" persistent-placeholder type="number" min="0" dense outlined hide-details clearable class="target-field" @input="setTarget" />
            </span>
          </div>
          <div v-if="!growth" class="panel-body caption text--secondary">{{ growthHint }}</div>
          <div v-else class="panel-body">
            <div class="d-flex align-center flex-wrap pair-title">
              <span class="font-weight-medium">{{ growthYard.name }}</span>
              <page-link v-if="growthYard.populationId" :to="linkTo.production(growthYard.populationId)" :name="growthYard.colony || ''" />
              <span class="caption text--secondary">{{ growthSummary }}</span>
            </div>
            <div class="caption text--secondary mb-2">
              Modification rate {{ count(figureOf(growth.rate), 1) }} BP a year<provenance-mark :result="growth.rate" /> · Shipyard operations {{ count(figureOf(operations), 2) }}<provenance-mark :result="operations" />
            </div>
            <div v-if="growthYard.shipBased === true" class="caption text--secondary mb-2">The yard belongs to a ship, which the game does not let be modified: no upgrade is priced.</div>
            <v-simple-table dense class="growth-table">
              <thead>
                <tr>
                  <th>Upgrade</th>
                  <th class="text-right">Adds</th>
                  <th class="text-right">Price (BP)</th>
                  <th class="text-right">Time</th>
                  <th class="bar-head">Time against the longest</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="step in growth.rows" :key="step.key">
                  <td>{{ step.label }}</td>
                  <td class="text-right text-no-wrap">{{ addsText(step) }}</td>
                  <td class="text-right text-no-wrap">{{ count(figureOf(step.price), 1) }}<provenance-mark :result="step.price" /></td>
                  <td class="text-right text-no-wrap">{{ growthTime(step) }}<provenance-mark :result="step.time" /></td>
                  <td class="bar-cell"><span class="days-bar" :title="growthTime(step)"><span :style="{ width: `${barWidth(step.days, growth.longest)}%` }" /></span></td>
                </tr>
              </tbody>
            </v-simple-table>
          </div>
          <div class="panel-foot caption text--secondary">
            Use it to compare the upgrades and to size a continual target. The yard's own modification rate sets the time. A slipway costs the yard's capacity over 500 tons times 120 times the race's shipyard operations; a capacity step costs the yard's slipways times 120 times the operations times its multiple of 500 tons (1, 2, 4, 10 or 20). A commercial or repair yard pays a tenth. The operations factor is the lowest multiplier among the Shipyard Operations levels the race holds. The time is the price over the yard's modification rate, which rises with its capacity. The 500 and 2,000 ton steps are marked estimated: no save checked stores one, so their price follows the pattern of the others. A continual upgrade is priced per ton at the steps' rate and stepped each construction period, so its time is approximate and the last period may overshoot the target; the game stores no price for it to compare with.<provenance-mark rule="shipyardGrowth.operations" />
          </div>
        </v-card>

        <v-card v-if="view === 'refits'" class="panel" data-summary="Every refit between the race's ship classes, one direction at a time." elevation="1">
          <div class="panel-head">
            <span>Refit matrix<provenance-mark rule="refit.cost" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-switch v-model="sizeWindow" label="Within 20% of the size" dense hide-details class="mt-0" />
              <v-switch v-model="shipsOnly" label="Classes with ships" dense hide-details class="mt-0" />
              <v-switch v-model="hideObsolete" label="Hide obsolete" dense hide-details class="mt-0" />
              <v-text-field v-model="search" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <div class="panel-body">
            <div v-if="matrix.tooLarge" class="caption text--secondary">The filters leave {{ count(matrix.pairs) }} pairs, more than the matrix draws at once ({{ count(matrixLimit) }}). {{ narrowHint }}</div>
            <div v-else-if="!matrix.rows.length || !matrix.columns.length" class="caption text--secondary">No class matches the filters.</div>
            <div v-else class="matrix-scroll">
              <table class="refit-matrix" aria-label="Refit time and cost from each class (rows) to each class (columns)">
                <thead>
                  <tr>
                    <th class="corner" scope="col">From ↓ · To →</th>
                    <th v-for="target in matrix.columns" :key="target.id" scope="col" class="column-head" :class="{ 'is-selected': target.id === toId }" :title="target.name">
                      <span class="class-name">{{ target.name }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in matrix.rows" :key="row.source.id">
                    <th scope="row" class="row-head" :class="{ 'is-selected': row.source.id === fromId }">
                      <span class="d-flex align-center">
                        <span class="flex-grow-1 class-name" :title="row.source.name">{{ row.source.name }}<span class="caption text--secondary d-block">{{ shipsText(row.source.id) }}</span></span>
                        <page-link :to="linkTo.propulsion({ class: row.source.id })" :name="row.source.name" />
                      </span>
                    </th>
                    <td v-for="cell in row.cells" :key="cell.target.id" class="matrix-cell" :class="{ 'is-same': cell.state === 'same', 'is-selected': row.source.id === fromId && cell.target.id === toId }">
                      <span v-if="cell.state === 'outside'" class="text--secondary" title="Outside the size window: clear the filter to price it, or pick the two classes above.">·</span>
                      <button v-else-if="cell.state === 'priced'" type="button" class="cell-button" :title="cellTitle(row.source, cell)" :aria-label="cellTitle(row.source, cell)" @click="selectPair(row.source, cell.target)">
                        <span class="cell-time">
                          <template v-if="cell.days !== null">{{ duration(cell.days) }}</template>
                          <template v-else-if="cell.info.none">No yard</template>
                          <template v-else-if="cell.info.retoolFirst">Retool first</template>
                          <template v-else>—<provenance-mark :result="cell.time" /></template>
                        </span>
                        <span class="cell-share">S {{ percent(cell.shareSource) }} · T {{ percent(cell.shareTarget) }}</span>
                        <span class="cell-yards">
                          <v-icon v-if="cell.noRetool.ok === true" x-small color="success">mdi-check</v-icon>
                          <v-icon x-small>mdi-wrench-outline</v-icon>{{ yardsText(cell.info.refitYards, cell.info.unknownYards) }}
                          <v-icon x-small>mdi-tools</v-icon>{{ yardsText(cell.info.retoolYards, cell.info.unknownYards) }}
                        </span>
                      </button>
                      <span v-else-if="cell.state === 'unpriced'" class="cell-button cell-unpriced" :title="describeResult(cell.refit.total)">—<provenance-mark :result="cell.refit.total" /></span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            Use it to find upgrades worth refitting and to avoid needless tooling changes. Each cell shows the refit's time and cost against each class, and how many yards can take it or be retooled for it. A cell is a refit of a ship of the row's class into the column's class; the opposite cell is a separate figure. Its time is at the quickest yard that can take the column's class now or once a slipway is free, one slipway working; a dash means a yard's eligibility or rate is not known, so the quickest is not known either, and "Retool first" means only a retooled yard could take it. S and T are the refit's cost as a share of the source (row) class's cost and of the target (column) class's cost. The wrench is the number of yards that take the target class now or when a slipway frees; the tools are the yards that would take it after a retool; a ≥ marks a count that has yards not known either way. A check mark: a yard tooled for the source builds or refits to the target without retooling. Components the target drops earn no credit. With the size window on, a class with no partner inside the window leaves the matrix.
          </div>
        </v-card>

        <v-card v-if="view === 'refits'" class="panel" data-summary="One refit in full: its cost by part, its minerals, the components that change and the ships that would take it." elevation="1">
          <div class="panel-head">
            <span>Selected refit<provenance-mark rule="refit.minerals" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-autocomplete v-model="fromId" :items="classOptions" item-text="name" item-value="id" label="From class" dense outlined hide-details clearable class="class-picker" />
              <v-btn icon small title="Swap the two classes" aria-label="Swap the two classes" :disabled="!fromId && !toId" @click="swapPair"><v-icon>mdi-swap-horizontal</v-icon></v-btn>
              <v-autocomplete v-model="toId" :items="classOptions" item-text="name" item-value="id" label="To class" dense outlined hide-details clearable class="class-picker" />
            </span>
          </div>
          <div v-if="!detail" class="panel-body caption text--secondary">{{ pairHint }}</div>
          <div v-else class="panel-body">
            <div class="d-flex align-center flex-wrap pair-title">
              <span class="font-weight-medium">{{ pair.from.name }}</span>
              <page-link :to="linkTo.propulsion({ class: pair.from.id })" :name="pair.from.name" />
              <v-icon small class="mx-1">mdi-arrow-right</v-icon>
              <span class="font-weight-medium">{{ pair.to.name }}</span>
              <page-link :to="linkTo.propulsion({ class: pair.to.id })" :name="pair.to.name" />
            </div>
            <v-row dense>
              <v-col cols="12" md="5">
                <v-simple-table dense class="breakdown">
                  <tbody>
                    <tr v-for="line in detail.lines" :key="line.label" :class="{ 'font-weight-medium': line.strong }">
                      <td>{{ line.label }}</td>
                      <td class="text-right">{{ count(figureOf(line.result), 1) }} BP<provenance-mark :result="line.result" /></td>
                    </tr>
                    <tr>
                      <td>Share of the source class's cost ({{ pair.from.name }}, {{ count(pair.from.cost, 1) }} BP)</td>
                      <td class="text-right">{{ percent(detail.shareSource) }}<provenance-mark :result="detail.shareSource" /></td>
                    </tr>
                    <tr>
                      <td>Share of the target class's cost ({{ pair.to.name }}, {{ count(pair.to.cost, 1) }} BP)</td>
                      <td class="text-right">{{ percent(detail.shareTarget) }}<provenance-mark :result="detail.shareTarget" /></td>
                    </tr>
                    <tr>
                      <td>Time{{ detail.yard ? ` at ${detail.yard.name}, the quickest yard` : '' }}</td>
                      <td class="text-right">
                        <template v-if="detail.days !== null">{{ duration(detail.days) }}</template>
                        <template v-else-if="detail.info.none">No yard takes the target class</template>
                        <template v-else-if="detail.info.retoolFirst">Only after a yard is retooled</template>
                        <template v-else>—</template>
                        <provenance-mark v-if="!detail.info.untimed" :result="detail.time" />
                      </td>
                    </tr>
                    <tr>
                      <td>The reverse refit ({{ pair.to.name }} to {{ pair.from.name }})</td>
                      <td class="text-right">{{ count(figureOf(detail.reverse.total), 1) }} BP<provenance-mark :result="detail.reverse.total" /></td>
                    </tr>
                    <tr>
                      <td>Ships of the source class · of the target class</td>
                      <td class="text-right">{{ count(shipCountOf(pair.from.id)) }} · {{ count(shipCountOf(pair.to.id)) }}</td>
                    </tr>
                    <tr>
                      <td>Running refits of this pair</td>
                      <td class="text-right">{{ count(runningOfPair) }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div class="mt-3">
                  <div class="caption text--secondary">Minerals<provenance-mark :result="detail.minerals" /></div>
                  <div v-if="mineralChips.length" class="d-flex flex-wrap chips">
                    <v-chip v-for="chip in mineralChips" :key="chip.name" small label>{{ chip.name }} {{ count(chip.amount, 1) }}</v-chip>
                  </div>
                  <div v-else-if="isAvailable(detail.minerals)" class="caption text--secondary">No minerals: nothing is added.</div>
                  <div v-else class="caption text--secondary">—</div>
                </div>
              </v-col>
              <v-col cols="12" md="7">
                <v-simple-table dense>
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th class="text-right">In {{ pair.from.name }}</th>
                      <th class="text-right">In {{ pair.to.name }}</th>
                      <th class="text-right">Change</th>
                      <th class="text-right">Cost each (BP)</th>
                      <th class="text-right">Added (BP)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="change in detail.changes" :key="change.id" :class="{ 'text--secondary': change.added === 0 }">
                      <td>{{ change.name }}</td>
                      <td class="text-right">{{ count(change.from, 2) }}</td>
                      <td class="text-right">{{ count(change.to, 2) }}</td>
                      <td class="text-right">{{ change.unknown.length ? '—' : change.added > 0 ? `+${count(change.added, 2)}` : `−${count(change.removed, 2)} (no credit)` }}</td>
                      <td class="text-right">{{ count(change.cost, 1) }}</td>
                      <td class="text-right">
                        <template v-if="change.addedBP === null">—<provenance-mark :result="detail.total" /></template>
                        <template v-else>{{ count(change.addedBP, 1) }}</template>
                      </td>
                    </tr>
                    <tr v-if="!detail.changes.length">
                      <td colspan="6" class="text--secondary">The two classes mount the same components.</td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </v-col>
            </v-row>
          </div>
          <div class="panel-foot caption text--secondary">
            Use it to see why a refit is dear and whether the reverse refit is cheaper. The cost is the added components' cost times 1.2 plus the size change (the difference in size over the source class's size). Percentages name their denominator: the source class is what the ship is worth as it stands, the target class what a new one costs. A removed component refunds nothing, so the minerals count the added parts only, each count at one decimal.<provenance-mark rule="refit.cost" />
          </div>
        </v-card>

        <v-card v-if="view === 'refits' || view === 'classes'" class="panel" :data-summary="yardsSummary" elevation="1">
          <div class="panel-head">
            <span>{{ yardsTitle }}<provenance-mark rule="refit.yardEligibility" label /></span>
            <span v-if="view === 'classes'" class="d-flex align-center flex-wrap controls">
              <v-btn-toggle v-model="operation" mandatory dense>
                <v-btn v-for="option in operationOptions" :key="option.value" :value="option.value" small>{{ option.label }}</v-btn>
              </v-btn-toggle>
              <v-autocomplete v-if="operation === 'refit'" v-model="fromId" :items="classOptions" item-text="name" item-value="id" label="From class" dense outlined hide-details clearable class="class-picker" />
              <v-autocomplete v-model="toId" :items="classOptions" item-text="name" item-value="id" :label="operation === 'refit' ? 'To class' : 'Class'" dense outlined hide-details clearable class="class-picker" />
            </span>
          </div>
          <div v-if="!yardScope" class="panel-body caption text--secondary">{{ yardsHint }}</div>
          <template v-else>
            <div v-if="scopeNote" class="panel-body caption text--secondary">{{ scopeNote }}</div>
            <v-data-table :headers="yardHeaders" :items="yardRows" item-key="id" :custom-sort="sortNullLast" :sort-by.sync="yardsTable.sortBy" :sort-desc.sync="yardsTable.sortDesc" disable-pagination hide-default-footer>
              <template #[`item.name`]="{ item }">
                <div class="py-2 d-flex align-center">
                  <div class="flex-grow-1">
                    <div class="font-weight-medium">{{ item.name }}</div>
                    <div class="caption text--secondary">{{ item.colony || '—' }}</div>
                  </div>
                  <page-link v-if="item.populationId" :to="linkTo.production(item.populationId)" :name="item.colony || ''" />
                </div>
              </template>
              <template #[`item.freeSlipways`]="{ item }">
                <span v-if="item.slipwaysText" class="text-no-wrap">{{ item.slipwaysText }}</span>
                <span v-else class="text-no-wrap">—<provenance-mark :result="item.slipwaysGap" /></span>
              </template>
              <template #[`item.capacity`]="{ item }">{{ count(item.capacity) }}</template>
              <template #[`item.tooledName`]="{ item }">
                <span v-if="item.tooled === undefined" class="text-no-wrap">—<provenance-mark :result="item.tooledGap" /></span>
                <span v-else-if="item.tooled === null" class="text--secondary">None</span>
                <span v-else>{{ item.tooledName }}</span>
              </template>
              <template #[`item.statusSort`]="{ item }">
                <span class="text-no-wrap">
                  <v-icon small :color="item.status.color">{{ item.status.icon }}</v-icon>
                  {{ item.status.label }}<provenance-mark :result="item.result" />
                </span>
                <div v-if="item.status.reasons" class="caption text--secondary">{{ item.status.reasons }}</div>
                <div v-if="item.status.notes" class="caption text--secondary">{{ item.status.notes }}</div>
              </template>
              <template #[`item.refitDays`]="{ item }">
                <span v-if="item.timed" class="text-no-wrap">{{ item.refitDays === null ? '—' : duration(item.refitDays) }}<provenance-mark :result="item.refitTime" /></span>
                <span v-else-if="item.state === 'unknown'" class="text-no-wrap">—<provenance-mark :result="item.result" /></span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.retoolCost`]="{ item }">
                <span v-if="item.retool.state === 'priced'" class="text-no-wrap">{{ count(item.retool.cost, 1) }} BP · {{ item.retool.days === null ? '—' : duration(item.retool.days) }}<provenance-mark :result="item.retool.costResult" /><provenance-mark :result="item.retool.timeResult" /></span>
                <span v-else-if="item.retool.state === 'unknown'" class="text-no-wrap">—<provenance-mark :result="item.retool.gap" /></span>
                <span v-else>{{ item.retool.label }}</span>
                <div v-if="item.retool.note" class="caption text--secondary">{{ item.retool.note }}</div>
              </template>
            </v-data-table>
          </template>
          <div class="panel-foot caption text--secondary">
            Use it to pick a yard for a class and to see why a yard cannot take it or needs a retool. A yard is judged on its type, its capacity (50 tons to the size unit), its slipways less the tasks working at it and the class's flags. A yard takes the class it is tooled for whatever its other flags, and another class without a retool when that class is within 20% of the tooled class's size and the refit between them costs at most a fifth of its cost; any other class that is not obsolete, not a shipping line's and within the capacity needs a retool, which a yard with no tooled class takes at once and free. A retool costs the lesser of the refit from the yard's own tooled class to the target and the target's cost, times 0.5 plus 0.25 per slipway, times the race's shipyard operations, and is shared among the slipways; a refit that costs nothing retools at once. A refit also needs its source class within the capacity and within 20% of the size of the class the yard is tooled for when the work starts, and a commercial yard takes commercial classes only. A repair yard repairs only, with no tooling. A yard type the rules do not cover shows as not covered and a figure the save lacks as not known. Not checked: whether ships of the source class are at the yard's colony, and whether a damaged ship is there to repair.<provenance-mark rule="refit.yardEligibility" />
          </div>
        </v-card>

        <platform-paths v-if="view === 'classes'" :classes="classes" :extras="platformSources.extras" :components="components" :yards="yards" :colonies="platformColonies" :context="eligibilityContext" :version="formulaVersion" :researched="platformSources.researched" />

        <v-card v-if="(view === 'refits' || view === 'classes') && runningRows.length" class="panel" data-summary="Refits and retools the yards are working on now, with the stored cost beside the cost the rules give." elevation="1">
          <div class="panel-head">
            <span>Running refits and retools<provenance-mark rule="production.shipFinish" label /></span>
          </div>
          <v-data-table :headers="runningHeaders" :items="runningRows" item-key="key" :custom-sort="sortNullLast" :sort-by.sync="runningTable.sortBy" :sort-desc.sync="runningTable.sortDesc" disable-pagination hide-default-footer>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.name }}</div>
                <div class="caption text--secondary">{{ item.kind }}{{ item.yardName ? ` · ${item.yardName}` : '' }}</div>
              </div>
            </template>
            <template #[`item.sourceName`]="{ item }">
              <span class="d-flex align-center">
                {{ item.sourceName }}
                <page-link v-if="item.sourceId" :to="linkTo.propulsion({ class: item.sourceId })" :name="item.sourceName" />
              </span>
            </template>
            <template #[`item.targetName`]="{ item }">
              <span class="d-flex align-center">
                {{ item.targetName }}
                <page-link v-if="item.targetId" :to="linkTo.propulsion({ class: item.targetId })" :name="item.targetName" />
                <v-btn v-if="item.sourceId && item.targetId" icon x-small title="Show this refit above" aria-label="Show this refit above" @click="selectPairById(item.sourceId, item.targetId)"><v-icon small>mdi-eye-outline</v-icon></v-btn>
              </span>
            </template>
            <template #[`item.stored`]="{ item }">{{ count(item.stored, 1) }}</template>
            <template #[`item.expected`]="{ item }">
              <span v-if="item.expected !== null">{{ count(item.expected, 1) }}</span>
              <span v-else class="text-no-wrap">—<provenance-mark :result="item.expectedResult" /></span>
            </template>
            <template #[`item.agree`]="{ item }">
              <span v-if="item.matches === true" class="text-no-wrap"><v-icon small color="success">mdi-check-circle</v-icon> Agrees</span>
              <span v-else-if="item.matches === false" class="text-no-wrap"><v-icon small color="warning">mdi-alert-circle-outline</v-icon> Differs by {{ count(Math.abs(item.expected - item.stored), 2) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.done`]="{ item }">{{ item.done === null ? '—' : `${count(item.done, 0)}%` }}</template>
            <template #[`item.daysSort`]="{ item }">
              <span v-if="item.statusLabel" class="text--secondary">{{ item.statusLabel }}</span>
              <span v-else-if="item.days !== null" class="text-no-wrap">{{ duration(item.days) }}<provenance-mark :result="item.finish" /></span>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.finish" /></span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Use it to check the rules against the game and to see when the work ends. The time left is the one the Production Recap shows: the stored cost not yet done over the colony's shipyard rate for the task. A retool's cost is the rules' figure from the yard's tooled class to the class it is retooled to.<provenance-mark rule="refit.retool" />
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import PlatformPaths from '../components/shipyards/PlatformPaths.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import { linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { UNKNOWN_TEXT } from '../utilities/math'
import { MINERALS } from '../utilities/minerals'
import { loadPlatformSources } from '../utilities/platform-paths'
import { finishDays, flagOf, shipRate, shipyardFinish, shipyardUpgradeRate, sortNullLast } from '../utilities/production'
import { describeResult, isAvailable, unavailable, valueOrNull } from '../utilities/provenance'
import { REFIT_TASK_TYPES, SHIPYARD_TYPE, YARD_OPERATIONS, checkRefitTask, checkRetoolTask, costShare, inBand, loadRefitClasses, loadRefitTasks, loadRetoolTasks, loadShipCounts, loadYards, noRetoolCheck, refitCost, refitRate, refitTime, refitTotal, retoolCost, retoolTime, tooledClassOf, yardEligibility } from '../utilities/refits'
import { CONTINUAL_ACTIVITY, RETOOL_ACTIVITY, SHIPYARD_TASK_TYPES, SHIPYARD_UPGRADE_TYPES, activityFinish, continualPrice, continualTime, loadShipyardOperations, modificationRate, shipyardOperations, slipwayPrice, taskFinish, upgradePrices, upgradeTime } from '../utilities/shipyard-growth'
import { loadFormulaVersion } from '../utilities/capabilities'

const INPUT_LABELS = {
  refitData: 'the ship classes and their components',
  platformSources: 'the colonies\' component stock, industrial projects and installations',
  shipCounts: 'the ships',
  yards: 'the shipyards',
  refitTasks: 'the running refits',
  retoolTasks: 'the running retools',
  populationProductionModifiers: 'the colonies\' production rates',
  shipyardOperationsHeld: 'the race\'s Shipyard Operations levels',
  formulaVersion: 'the save\'s schema',
}
const VIEW_OPTIONS = [{ value: 'yards', label: 'Yards' }, { value: 'growth', label: 'Growth' }, { value: 'refits', label: 'Refits' }, { value: 'classes', label: 'Class to yards' }]
// The tons the Growth view's continual target starts above the yard's capacity until a target is typed.
const DEFAULT_GROWTH_TONS = 10000
const INVENTORY_HEADERS = [
  { text: 'Yard', value: 'name' },
  { text: 'Type', value: 'type' },
  { text: 'Free slipways', value: 'freeSlipways', align: 'end' },
  { text: 'Capacity (t)', value: 'capacity', align: 'end' },
  { text: 'Tooled for', value: 'tooledName' },
  { text: 'Tasks', value: 'taskCount' },
  { text: 'Activity', value: 'activitySort' },
  { text: 'Add slipway', value: 'slipwayBP', align: 'end' },
]
const OPERATION_OPTIONS = [{ value: 'build', label: 'Build' }, { value: 'refit', label: 'Refit to' }, { value: 'repair', label: 'Repair' }]
const OPERATION_VERBS = { build: 'build', refit: 'refit to', repair: 'repair' }
// What each eligibility state reads as: a label, an icon and a colour, and `rank` for sorting (the yards that can do the work first, those not known last).
const STATE_VIEW = {
  capable: { label: 'Can take it', icon: 'mdi-check-circle', color: 'success', rank: 0 },
  busy: { label: 'Busy: every slipway working', icon: 'mdi-progress-clock', color: 'info', rank: 1 },
  retool: { label: 'Retool first', icon: 'mdi-wrench-outline', color: 'warning', rank: 2 },
  ineligible: { label: 'Cannot', icon: 'mdi-close-circle-outline', color: '', rank: 3 },
  unsupported: { label: 'Not covered', icon: 'mdi-minus-circle-outline', color: '', rank: 4 },
  unknown: { label: 'Not known', icon: 'mdi-help-circle-outline', color: 'warning', rank: null },
}
// The most cells the matrix prices and draws at once: a page of thousands of priced cells is slow to read and to scroll.
const MATRIX_PAIR_LIMIT = 4000

// The yards table's sort is kept under the key it always had; a column that was renamed is carried over to its new name.
const YARD_SORT_RENAMES = { takesSort: 'statusSort', slipways: 'freeSlipways' }
const yardsTableView = tableView('shipyardsYardsTable', { sortBy: ['statusSort'], sortDesc: false })
const yardsTableSort = {
  ...yardsTableView,
  normalise(stored) {
    const sort = yardsTableView.normalise(stored)

    return sort && { ...sort, sortBy: Array.isArray(sort.sortBy) ? sort.sortBy.map((column) => YARD_SORT_RENAMES[column] || column) : sort.sortBy }
  },
}

const YARD_TYPES = { [SHIPYARD_TYPE.NAVAL]: 'Naval', [SHIPYARD_TYPE.COMMERCIAL]: 'Commercial', [SHIPYARD_TYPE.REPAIR]: 'Repair' }

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

export default {
  name: 'ShipyardsPage',
  components: { LoadState, PageLink, PlatformPaths, ProvenanceMark, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    persistedView({
      view: { key: 'shipyardsView', default: 'yards', valid: oneOf(VIEW_OPTIONS.map((option) => option.value)) },
      operation: { key: 'shipyardsOperation', default: 'build', valid: oneOf(YARD_OPERATIONS) },
      sizeWindow: { key: 'shipyardsSizeWindow', default: true },
      shipsOnly: { key: 'shipyardsShipsOnly', default: true },
      hideObsolete: { key: 'shipyardsHideObsolete', default: true },
      search: { key: 'shipyardsSearch', default: '', scope: 'race' },
      yardId: { key: 'shipyardsYard', default: null, scope: 'race', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },
      fromId: { key: 'shipyardsFromClass', default: null, scope: 'race', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },
      toId: { key: 'shipyardsToClass', default: null, scope: 'race', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },
      growthTarget: { key: 'shipyardsGrowthTarget', default: null, scope: 'race', valid: (value) => value === null || (isNumber(value) && value > 0) },
      yardSearch: { key: 'shipyardsYardSearch', default: '', scope: 'race' },
      idleOnly: { key: 'shipyardsIdleOnly', default: false },
      yardsList: tableView('shipyardsYardsList', { sortBy: ['name'], sortDesc: false }),
      yardsTable: yardsTableSort,
      runningTable: tableView('shipyardsRunningTable', { sortBy: ['daysSort'], sortDesc: false }),
    }),
  ],
  data() {
    return {
      colonyId: null,
      linkedYardId: null,
      expanded: [],
      inventoryHeaders: INVENTORY_HEADERS,
      linkedClassIds: [],
      viewOptions: VIEW_OPTIONS,
      operationOptions: OPERATION_OPTIONS,
      matrixLimit: MATRIX_PAIR_LIMIT,
      linkTo,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    classes() {
      return this.refitData.classes
    },

    components() {
      return this.refitData.components
    },

    classById() {
      return Object.fromEntries(this.classes.map((shipClass) => [shipClass.id, shipClass]))
    },

    classOptions() {
      return this.classes.map((shipClass) => ({ id: shipClass.id, name: shipClass.name }))
    },

    pair() {
      const from = this.classById[this.fromId]
      const to = this.classById[this.toId]

      return from && to && from.id !== to.id ? { from, to } : null
    },

    pairHint() {
      if (this.fromId && this.toId && this.fromId === this.toId) {
        return 'Pick two different classes: a refit of a class into itself changes nothing.'
      } else if ((this.fromId && !this.classById[this.fromId]) || (this.toId && !this.classById[this.toId])) {
        return 'A class named by the link is not one of the race\'s classes.'
      }

      return 'Select a cell of the matrix, or pick the two classes, to see the refit in full.'
    },

    modifiersOf() {
      return this.populationProductionModifiers
    },

    // What the platform comparison reads of each colony: the page's reads of its stock, projects and installations with its production modifiers and its construction capacity as a result.
    platformColonies() {
      const { platformSources, modifiersOf } = this

      return Object.fromEntries(Object.entries(platformSources.colonies).map(([id, colony]) => [id, { ...colony, modifiers: modifiersOf[id], capacity: this.populationCapacityResult(id, 'construction') }]))
    },

    // What the yards take, for the shared eligibility: the classes by id, the components and the save's formula version, with a cache for the refits between classes.
    eligibilityContext() {
      return { classesById: this.classById, components: this.components, version: this.formulaVersion, cache: new Map() }
    },

    // The operation the yards table is about: a refit on the Refits view, the picked one on the Class to yards view.
    activeOperation() {
      return this.view === 'refits' ? 'refit' : this.operation
    },

    // What the yards table is judged against, { operation, source, target }, or null until a class is picked. The source is the class refitted from, null when none is picked (the ship side is then not checked).
    yardScope() {
      const { view, pair, classById, toId, fromId, activeOperation } = this

      if (view === 'refits') {
        return pair ? { operation: 'refit', source: pair.from, target: pair.to } : null
      }

      const target = classById[toId]

      return target ? { operation: activeOperation, source: activeOperation === 'refit' ? classById[fromId] || null : null, target } : null
    },

    yardsTitle() {
      return this.view === 'refits' ? 'Yards for the selected refit' : 'Yards for a class'
    },

    yardsSummary() {
      return this.view === 'refits' ? 'The race\'s shipyards against the selected refit, with the time and the retooling cost at each.' : 'The race\'s shipyards against one class and one kind of work, with the reasons each can or cannot take it.'
    },

    yardsHint() {
      if (this.view === 'refits') {
        return this.pairHint
      } else if (this.toId && !this.classById[this.toId]) {
        return 'A class named by the link is not one of the race\'s classes.'
      }

      return `Pick the class to see which yards can ${OPERATION_VERBS[this.activeOperation]} it.`
    },

    scopeNote() {
      const { yardScope } = this

      return yardScope && this.view === 'classes' && yardScope.operation === 'refit' && !yardScope.source ? 'No source class is picked: only the class refitted to is checked. Pick the class to refit from to check the ship side too and to see the refit time.' : ''
    },

    // The refit rate of a yard for a target class, kept for each yard and class: `refitRate` over the colony's production modifiers.
    rateOf() {
      const { modifiersOf } = this
      const kept = new Map()

      return (yard, target) => {
        const key = `${yard.id}>${target.id}`

        if (!kept.has(key)) {
          kept.set(key, refitRate(modifiersOf[yard.populationId], target))
        }

        return kept.get(key)
      }
    },

    // The yards against one refit from `source` into `target`, as { refitYards, unknownYards, retoolYards, best, gap, none, retoolFirst, untimed }: the yards that take it now or when a slipway frees (`refitYards`), the yards that would take it after a retool (`retoolYards`), the yards not known either way (`unknownYards`) and the quickest yard's rate. The source matters (a source over a yard's capacity, or outside the window of its tooled class, leaves the yard out), so this is per pair, kept for the pair. `none` is that no yard can take it at all, which is a fact, and `retoolFirst` that only a retool would make one able. `gap` says what leaves the quickest yard unknown: a yard that might take it with an input missing, or a rate that is missing. While a gap stands there is no `best`, as the quickest of the yards known would not be the quickest of them all. `untimed` is that there is no yard whose time a cell could show.
    yardSummaryOf() {
      const { yards, rateOf, eligibilityContext } = this
      const kept = new Map()

      return (source, target) => {
        const key = `${source.id}>${target.id}`

        if (kept.has(key)) {
          return kept.get(key)
        }

        let refitYards = 0
        let unknownYards = 0
        let retoolYards = 0
        let best = null
        const missing = []

        yards.forEach((yard) => {
          const { state, missing: gaps } = yardEligibility(yard, target, 'refit', eligibilityContext, source)

          if (state === 'capable' || state === 'busy') {
            refitYards++

            const rate = rateOf(yard, target)

            if (!isAvailable(rate)) {
              missing.push(...rate.inputs.missing.map((input) => `${input} (${yard.name})`))
            } else if (!best || rate.value > best.rate.value) {
              best = { rate, yard }
            }
          } else if (state === 'retool') {
            retoolYards++
          } else if (state === 'unknown') {
            unknownYards++
            missing.push(...gaps.map((input) => `${input} (${yard.name})`))
          }
        })

        const gap = missing.length ? unavailable({ rule: 'refit.time', missing: [...new Set(missing)], units: 'days' }) : null
        const none = refitYards === 0 && retoolYards === 0 && unknownYards === 0
        const retoolFirst = refitYards === 0 && retoolYards > 0 && !gap
        const summary = Object.freeze({ refitYards, unknownYards, retoolYards, best: gap ? null : best, gap, none, retoolFirst, untimed: none || retoolFirst })

        kept.set(key, summary)

        return summary
      }
    },

    searchText() {
      return (this.search || '').toLowerCase()
    },

    // Which filters would narrow a matrix that is too big to draw.
    narrowHint() {
      const off = [!this.sizeWindow ? 'turn on "Within 20% of the size"' : '', !this.shipsOnly ? 'turn on "Classes with ships"' : '', !this.hideObsolete ? 'turn on "Hide obsolete"' : ''].filter(Boolean)

      return off.length ? `Narrow them: ${off.join(', ')} or search for a class.` : 'Narrow them: search for a class.'
    },

    // The matrix: the rows are the classes ships can be refitted from, the columns the classes they can become, each cell priced once. `rows[].cells[]` are { target, state ('same'; 'outside' the size window, both sizes known; 'priced'; or 'unpriced' when a figure is missing), refit, days, time, shareSource, shareTarget, noRetool, info }. With the size window on, a row or column with no pair in the window is left out, which keeps a save with many classes to the pairs worth reading. `tooLarge` is set, with `pairs` the cells to price, when the matrix would be too big to draw.
    matrix() {
      const { classes, components, formulaVersion, shipCounts, yardSummaryOf, sizeWindow, shipsOnly, hideObsolete, searchText, fromId, toId } = this
      const matches = (shipClass) => !searchText || shipClass.name.toLowerCase().includes(searchText)
      const priceable = (source, target) => source.id !== target.id && !(sizeWindow && inBand(source, target) === false)
      const candidateRows = classes.filter((shipClass) => shipClass.id === fromId || (matches(shipClass) && (!shipsOnly || shipCounts[shipClass.id] > 0) && (!hideObsolete || shipClass.obsolete !== true || shipCounts[shipClass.id] > 0)))
      const candidateColumns = classes.filter((shipClass) => shipClass.id === toId || (matches(shipClass) && (!hideObsolete || shipClass.obsolete !== true)))
      const columns = sizeWindow ? candidateColumns.filter((target) => target.id === toId || candidateRows.some((source) => priceable(source, target))) : candidateColumns
      const rowClasses = sizeWindow ? candidateRows.filter((source) => source.id === fromId || columns.some((target) => priceable(source, target))) : candidateRows
      const pairs = rowClasses.reduce((total, source) => total + columns.filter((target) => priceable(source, target)).length, 0)

      if (pairs > MATRIX_PAIR_LIMIT) {
        return { rows: [], columns: [], pairs, tooLarge: true, priced: 0, unpriced: 0 }
      }

      const rows = []
      let priced = 0
      let unpriced = 0

      rowClasses.forEach((source) => {
        const cells = columns.map((target) => {
          if (target.id === source.id) {
            return { target, state: 'same' }
          } else if (!priceable(source, target)) {
            return { target, state: 'outside' }
          }

          const refit = refitTotal(source, target, components, formulaVersion)

          if (!isAvailable(refit.total)) {
            unpriced++

            return { target, state: 'unpriced', refit }
          }

          priced++

          const info = yardSummaryOf(source, target)
          const time = info.untimed ? null : refitTime(refit.total, info.gap || info.best.rate)

          return { target, state: 'priced', refit, time, days: valueOrNull(time), shareSource: costShare(refit.total, { name: source.name, cost: source.cost }), shareTarget: costShare(refit.total, { name: target.name, cost: target.cost }), noRetool: noRetoolCheck(source, target, refit.total, formulaVersion), info }
        })

        rows.push({ source, cells })
      })

      return { rows, columns, pairs, priced, unpriced }
    },

    detail() {
      const { pair } = this

      if (!pair) {
        return null
      }

      const { components, formulaVersion, yardSummaryOf } = this
      const refit = refitCost(pair.from, pair.to, components, formulaVersion)
      const info = yardSummaryOf(pair.from, pair.to)
      const time = info.untimed ? null : refitTime(refit.total, info.gap || info.best.rate)

      return {
        ...refit,
        lines: [
          { label: 'Added components', result: refit.added },
          { label: 'Yard overhead (20% of the added cost)', result: refit.overhead },
          { label: 'Size change (share of the added cost)', result: refit.surcharge },
          { label: 'Refit cost', result: refit.total, strong: true },
        ],
        shareSource: costShare(refit.total, { name: pair.from.name, cost: pair.from.cost }),
        shareTarget: costShare(refit.total, { name: pair.to.name, cost: pair.to.cost }),
        reverse: refitTotal(pair.to, pair.from, components, formulaVersion),
        info,
        yard: info.best ? info.best.yard : null,
        time,
        days: valueOrNull(time),
      }
    },

    mineralChips() {
      const amounts = this.detail ? valueOrNull(this.detail.minerals) : null

      return amounts ? MINERALS.filter(({ name }) => amounts[name] > 0).map(({ name }) => ({ name, amount: amounts[name] })) : []
    },

    runningOfPair() {
      const { pair } = this

      return pair ? this.refitTasks.filter((task) => task.SourceClassID === pair.from.id && task.TargetClassID === pair.to.id).length : 0
    },

    // One row for each shipyard against the class and work in scope: the shared eligibility, the refit time and the retool costed from the yard's own tooled class.
    yardRows() {
      const { yardScope, yards, classById, components, formulaVersion, modifiersOf, eligibilityContext } = this

      if (!yardScope) {
        return []
      }

      const { operation, source, target } = yardScope
      const refit = source && source.id !== target.id ? refitTotal(source, target, components, formulaVersion).total : null

      return yards.map((yard) => {
        const modifiers = modifiersOf[yard.populationId]
        const result = yardEligibility(yard, target, operation, eligibilityContext, source)
        const status = this.statusOf(result)
        const timed = operation === 'refit' && refit !== null && ['capable', 'busy', 'retool'].includes(result.state)
        const rate = timed ? refitRate(modifiers, target) : null
        const refitTimeResult = rate ? refitTime(refit, rate) : null
        const { free, total, tasks } = result.slipways
        const retool = operation === 'repair' ? null : this.retoolOf(yard, result, target, modifiers, formulaVersion)
        const tooled = tooledClassOf(yard, classById)
        const slipwayGaps = [...(total === null ? ['the yard\'s slipways'] : []), ...(tasks === null ? ['the tasks at the yard'] : [])]

        return {
          id: yard.id,
          name: yard.name,
          populationId: yard.populationId,
          colony: yard.colony,
          type: YARD_TYPES[yard.type] || (isNumber(yard.type) ? `Type ${yard.type}` : UNKNOWN_TEXT),
          capacity: yard.capacity,
          tooled,
          tooledName: tooled ? tooled.name : null,
          tooledGap: unavailable({ rule: 'refit.yardEligibility', missing: ['the class the yard is tooled for'], units: '' }),
          state: result.state,
          status,
          statusSort: status.rank,
          result: result.result,
          freeSlipways: free,
          slipwaysText: free === null ? '' : `${this.count(free)} of ${this.count(total)}`,
          slipwaysGap: unavailable({ rule: 'refit.yardEligibility', missing: slipwayGaps, units: '' }),
          timed,
          refitDays: valueOrNull(refitTimeResult),
          refitTime: refitTimeResult,
          retool,
          retoolCost: retool && retool.state === 'priced' ? retool.cost : null,
        }
      })
    },

    // The refit tasks and retool activities the yards are working on, each checked against the rules; the time left is the Production Recap's.
    runningRows() {
      const { classById, components, formulaVersion, modifiersOf } = this
      const name = (id) => (classById[id] ? classById[id].name : `class #${id}`)
      const refits = this.refitTasks.map((task) => {
        const check = checkRefitTask(task, classById, components, formulaVersion)
        const modifiers = modifiersOf[task.PopulationID]
        const paused = flagOf(task.Paused)
        const finish = finishDays({ rule: 'production.shipFinish', rate: shipRate(modifiers, task), remaining: task.RemainingProduction, remainingName: 'the task\'s remaining build points', paused })

        return this.runningRow({ key: `refit-${task.ID}`, kind: task.ShipyardTaskType === REFIT_TASK_TYPES[1] ? 'Automatic refit' : 'Refit', name: task.Name || `Refit #${task.ID}`, yardName: task.ShipyardName, sourceId: task.SourceClassID, targetId: task.TargetClassID, sourceName: name(task.SourceClassID), targetName: name(task.TargetClassID), stored: task.TotalBP, completed: task.CompletedBP, check, paused, finish: finish.result, idle: finish.idle })
      })
      const retools = this.retoolTasks.map((task) => {
        const check = checkRetoolTask(task, classById, components, modifiersOf[task.PopulationID] ? modifiersOf[task.PopulationID].ShipyardOperations : null, formulaVersion)
        const modifiers = modifiersOf[task.PopulationID]
        const shipyard = task
        const paused = flagOf(task.Paused)
        const finish = shipyardFinish(modifiers, shipyard, shipyardUpgradeRate(modifiers, shipyard))

        return this.runningRow({ key: `retool-${task.ID}`, kind: 'Retool', name: task.ShipyardName, yardName: '', sourceId: task.SourceClassID, targetId: task.TargetClassID, sourceName: task.SourceClassID ? name(task.SourceClassID) : 'No class', targetName: name(task.TargetClassID), stored: task.RequiredBP, completed: task.CompletedBP, check, paused, finish: finish.result, idle: finish.idle })
      })

      return [...refits, ...retools]
    },

    yardOptions() {
      return this.yards.map((yard) => ({ id: yard.id, name: yard.colony ? `${yard.name} · ${yard.colony}` : yard.name }))
    },

    // The yard the page is open on, null for none or one the race does not have.
    pickedYard() {
      const { yards, yardId } = this

      return yards.find((yard) => yard.id === yardId) || null
    },

    // The yard the Growth view prices: the one picked, or the first yard while none is picked.
    growthYard() {
      const { pickedYard, yardId, yards } = this

      return pickedYard || (yardId === null && yards.length ? yards[0] : null)
    },

    // The race's shipyard operations as a result of its held levels.
    operations() {
      return shipyardOperations(this.shipyardOperationsHeld, this.formulaVersion)
    },

    colonyName() {
      const { colonyId, yards } = this
      const yard = yards.find((candidate) => candidate.populationId === colonyId)

      return yard && yard.colony ? yard.colony : `Colony #${colonyId}`
    },

    // The upgrades of a yard priced and timed, kept for each yard and target: { rate, rows, longest }, `rows` being { key, taskType, label, tons, price, time, days, idle, approx } with a continual upgrade to `target` tons last when a target is given.
    growthOf() {
      const { modifiersOf, operations, formulaVersion } = this
      const kept = new Map()

      return (yard, target = null) => {
        const key = `${yard.id}>${target}`

        if (!kept.has(key)) {
          const modifiers = modifiersOf[yard.populationId]
          const rows = upgradePrices({ yard, operations, version: formulaVersion }).map((step) => {
            const time = upgradeTime(modifiers, yard, step.taskType, step.price)

            return { ...step, time: time.result, days: valueOrNull(time.result), idle: time.idle, approx: false }
          })

          if (target !== null) {
            const price = continualPrice({ yard, target, operations, version: formulaVersion })
            const time = continualTime(modifiers, yard, target, price)

            rows.push({ key: 'continual', taskType: CONTINUAL_ACTIVITY, label: `Continual to ${this.count(target)} t`, tons: isNumber(yard.capacity) ? target - yard.capacity : null, price, time: time.result, days: valueOrNull(time.result), idle: time.idle, approx: true })
          }

          kept.set(key, Object.freeze({ rate: modificationRate(modifiers, yard), rows, longest: Math.max(0, ...rows.map((row) => row.days).filter(isNumber)) }))
        }

        return kept.get(key)
      }
    },

    growth() {
      const { growthYard } = this

      return growthYard ? this.growthOf(growthYard, this.growthTargetFor(growthYard)) : null
    },

    growthHint() {
      if (!this.yards.length) {
        return 'The race has no shipyard.'
      } else if (this.yardId !== null && !this.pickedYard) {
        return 'The yard named by the link is not one of the race\'s yards.'
      }

      return 'Pick a shipyard to price its growth.'
    },

    growthSummary() {
      const yard = this.growthYard

      return yard ? `${this.typeLabel(yard)} yard · ${this.count(yard.capacity)} t · ${this.count(yard.slipways)} slipways` : ''
    },

    targetPlaceholder() {
      const yard = this.growthYard
      const target = yard ? this.growthTargetFor(yard) : null

      return target === null ? '' : this.count(target)
    },

    // One row for each shipyard of the race: its slipways, tooling, tasks (each timed as the Production Recap times a task), its own activity, and the price to add a slipway. The colony, search and free-slipway filters leave a yard out, except the yard a link named on this visit, which the saved filters never hide; a yard with no task stays in.
    inventoryRows() {
      const { yards, classById, modifiersOf, colonyId, idleOnly, linkedYardId, operations, formulaVersion } = this
      const search = (this.yardSearch || '').trim().toLowerCase()
      const matches = (yard) => (colonyId === null || yard.populationId === colonyId) && (yard.id === linkedYardId || !search || yard.name.toLowerCase().includes(search) || (yard.colony || '').toLowerCase().includes(search))
      const full = (yard) => isNumber(yard.slipways) && isNumber(yard.tasks) && yard.slipways - yard.tasks <= 0

      return yards.filter((yard) => matches(yard) && !(idleOnly && yard.id !== linkedYardId && full(yard))).map((yard) => {
        const modifiers = modifiersOf[yard.populationId]
        const slipwayResult = slipwayPrice({ yard, operations, version: formulaVersion })
        const tooled = tooledClassOf(yard, classById)
        const taskLines = yard.taskRows === null ? null : yard.taskRows.map((task) => this.taskLineOf(yard, task, modifiers))
        const free = isNumber(yard.slipways) && isNumber(yard.tasks) ? yard.slipways - yard.tasks : null
        const activity = isNumber(yard.taskType) && yard.taskType > 0 ? this.activityOf(yard, modifiers) : null

        return {
          id: yard.id,
          yard,
          shipBased: yard.shipBased,
          name: yard.name,
          colony: yard.colony,
          populationId: yard.populationId,
          type: this.typeLabel(yard),
          capacity: yard.capacity,
          freeSlipways: free,
          slipwaysText: free === null ? '' : `${this.count(free)} of ${this.count(yard.slipways)}`,
          slipwaysGap: unavailable({ rule: 'refit.yardEligibility', missing: [...(isNumber(yard.slipways) ? [] : ['the yard\'s slipways']), ...(isNumber(yard.tasks) ? [] : ['the tasks at the yard'])], units: '' }),
          retooling: yard.taskType === RETOOL_ACTIVITY,
          tooled,
          tooledName: tooled ? tooled.name : null,
          tooledGap: unavailable({ rule: 'refit.yardEligibility', missing: ['the class the yard is tooled for'], units: '' }),
          taskCount: isNumber(yard.tasks) ? yard.tasks : null,
          taskLines,
          taskGap: unavailable({ rule: 'production.shipFinish', missing: ['the tasks at the yard'], units: '' }),
          activity,
          activitySort: activity ? activity.days : null,
          slipwayResult,
          slipwayBP: valueOrNull(slipwayResult),
        }
      })
    },

    inventoryHint() {
      const { yards, colonyId } = this

      if (!yards.length) {
        return 'The race has no shipyard.'
      } else if (colonyId !== null && !yards.some((yard) => yard.populationId === colonyId)) {
        return 'The colony named by the link has no shipyard of the race.'
      }

      return 'No shipyard matches the filters.'
    },

    // The Yards and Growth views' tiles: the yards by type, the slipways free of all, the work running and the race's shipyard operations.
    yardTiles() {
      const { yards, operations } = this
      const typed = (type) => yards.filter((yard) => yard.type === type).length
      const others = yards.filter((yard) => !isNumber(yard.type) || ![SHIPYARD_TYPE.NAVAL, SHIPYARD_TYPE.COMMERCIAL, SHIPYARD_TYPE.REPAIR].includes(yard.type)).length
      const known = yards.filter((yard) => isNumber(yard.slipways) && isNumber(yard.tasks))
      const slipways = known.reduce((total, yard) => total + yard.slipways, 0)
      const free = known.reduce((total, yard) => total + yard.slipways - yard.tasks, 0)
      const tasks = yards.reduce((total, yard) => total + (isNumber(yard.tasks) ? yard.tasks : 0), 0)
      const activities = yards.filter((yard) => isNumber(yard.taskType) && yard.taskType > 0).length
      const operationsValue = valueOrNull(operations)

      return [
        { label: 'Shipyards', value: this.count(yards.length), rule: 'refit.yardEligibility', note: `${this.count(typed(SHIPYARD_TYPE.NAVAL))} naval, ${this.count(typed(SHIPYARD_TYPE.COMMERCIAL))} commercial, ${this.count(typed(SHIPYARD_TYPE.REPAIR))} repair${others ? `, ${this.count(others)} of no type the rules cover` : ''}` },
        { label: 'Free slipways', value: `${this.count(free)} of ${this.count(slipways)}`, rule: 'refit.yardEligibility', note: known.length < yards.length ? `${this.count(yards.length - known.length)} ${yards.length - known.length === 1 ? 'yard' : 'yards'} with a slipway or task count not known, not counted` : 'Slipways with no task working' },
        { label: 'Work running', value: `${this.count(tasks)} ${tasks === 1 ? 'task' : 'tasks'}`, rule: 'production.shipFinish', note: `${this.count(activities)} yard ${activities === 1 ? 'activity' : 'activities'} (upgrades and retools)` },
        { label: 'Shipyard operations', value: operationsValue === null ? UNKNOWN_TEXT : this.count(operationsValue, 2), rule: 'shipyardGrowth.operations', result: operations, note: 'Multiplier on the price of every upgrade and retool' },
      ]
    },

    tiles() {
      if (this.view === 'yards' || this.view === 'growth') {
        return this.yardTiles
      } else if (this.view === 'classes') {
        return this.classTiles
      }

      const { matrix, yards, runningRows } = this
      const covered = yards.filter((yard) => yard.type === SHIPYARD_TYPE.NAVAL || yard.type === SHIPYARD_TYPE.COMMERCIAL)
      const repair = yards.filter((yard) => yard.type === SHIPYARD_TYPE.REPAIR)
      const typeless = yards.filter((yard) => !isNumber(yard.type))
      const others = yards.length - covered.length - repair.length - typeless.length
      const refits = runningRows.filter((row) => row.kind !== 'Retool')
      const retools = runningRows.filter((row) => row.kind === 'Retool')
      const balance = (rows, rule, none) => {
        if (!rows.length) {
          return { note: none }
        }

        const unknown = rows.filter((row) => row.remaining === null)

        if (unknown.length) {
          return { note: `The balance is not known for ${unknown.length} of ${rows.length}`, result: unavailable({ rule, missing: [`the balance of ${unknown.length} of ${rows.length} tasks`], units: 'BP' }) }
        }

        return { note: `${this.count(rows.reduce((total, row) => total + row.remaining, 0), 0)} BP left` }
      }
      const refitBalance = balance(refits, 'refit.cost', 'No yard is refitting a ship')
      const retoolBalance = balance(retools, 'refit.retool', 'No yard is being retooled')
      const notCovered = [repair.length ? `${this.count(repair.length)} repair yards, which neither build nor refit` : '', others ? `${this.count(others)} of a type the rules do not cover` : '', typeless.length ? `${this.count(typeless.length)} with no type known` : ''].filter(Boolean).join('; ')

      return [
        { label: 'Refits priced', value: matrix.tooLarge ? UNKNOWN_TEXT : this.count(matrix.priced), rule: 'refit.cost', note: matrix.tooLarge ? this.narrowHint : `${this.count(matrix.rows.length)} source classes into ${this.count(matrix.columns.length)} target classes${matrix.unpriced ? `; ${this.count(matrix.unpriced)} with no price, a figure missing` : ''}` },
        { label: 'Yards that refit and retool', value: this.count(covered.length), rule: 'refit.yardEligibility', note: notCovered ? `Naval and commercial yards; ${notCovered}` : 'Naval and commercial yards' },
        { label: 'Refits running', value: this.count(refits.length), rule: 'refit.cost', result: refitBalance.result, note: refitBalance.note },
        { label: 'Retools running', value: this.count(retools.length), rule: 'refit.retool', result: retoolBalance.result, note: retoolBalance.note },
      ]
    },

    // The Class to yards view's tiles: the yards by what they can do for the class picked; a yard not known either way is not counted.
    classTiles() {
      const { yardScope, yardRows } = this
      const rule = 'refit.yardEligibility'

      if (!yardScope) {
        return ['Can take it now', 'Busy', 'After a retool', 'Cannot take it'].map((label) => ({ label, value: UNKNOWN_TEXT, rule, note: 'Pick a class' }))
      }

      const tally = (...states) => yardRows.filter((row) => states.includes(row.state)).length
      const unknown = tally('unknown')
      const unsupported = tally('unsupported')

      return [
        { label: 'Can take it now', value: this.count(tally('capable')), rule, note: `Of ${this.count(yardRows.length)} yards${unknown ? `; ${this.count(unknown)} not known, not counted` : ''}` },
        { label: 'Busy', value: this.count(tally('busy')), rule, note: 'Compatible, every slipway working' },
        { label: 'After a retool', value: this.count(tally('retool')), rule, note: yardScope.operation === 'repair' ? 'A repair needs no tooling' : 'A retool, or a class assigned to a yard with none' },
        { label: 'Cannot take it', value: this.count(tally('ineligible', 'unsupported')), rule, note: unsupported ? `${this.count(unsupported)} of a type the rules do not cover` : 'By capacity, type or the class\'s flags' },
      ]
    },

    yardHeaders() {
      const operation = this.activeOperation

      return [
        { text: 'Yard', value: 'name' },
        { text: 'Type', value: 'type' },
        { text: 'Free slipways', value: 'freeSlipways', align: 'end' },
        { text: 'Capacity (t)', value: 'capacity', align: 'end' },
        { text: 'Tooled for', value: 'tooledName' },
        { text: 'Status', value: 'statusSort' },
        ...(operation === 'refit' ? [{ text: 'Refit time here', value: 'refitDays', align: 'end' }] : []),
        ...(operation === 'repair' ? [] : [{ text: 'Retool to the class', value: 'retoolCost' }]),
      ]
    },

    runningHeaders() {
      return [
        { text: 'Work', value: 'name' },
        { text: 'From', value: 'sourceName' },
        { text: 'To', value: 'targetName' },
        { text: 'Stored cost (BP)', value: 'stored', align: 'end' },
        { text: 'Rule cost (BP)', value: 'expected', align: 'end' },
        { text: 'Rule', value: 'agree', sortable: false },
        { text: 'Done', value: 'done', align: 'end' },
        { text: 'Time left', value: 'daysSort', align: 'end' },
      ]
    },

    // The Refits view's focus is its pair, as a link to the page writes it. The Class to yards view writes `view=classes` beside its work and class, so a history entry left in that view is not mistaken for a link to a refit; the Yards and Growth views write their own `view` beside the yard (and the colony the yards are limited to).
    linkQuery() {
      if (this.view === 'yards') {
        return { view: 'yards', yard: this.yardId, colony: this.colonyId }
      } else if (this.view === 'growth') {
        return { view: 'growth', yard: this.growthYard ? this.growthYard.id : this.yardId }
      } else if (this.view === 'classes') {
        return { view: 'classes', operation: this.operation, from: this.operation === 'refit' ? this.fromId : null, to: this.toId }
      }

      return linkTo.shipyards({ from: this.fromId, to: this.toId }).query
    },

    linkLabel() {
      if (this.view === 'yards' || this.view === 'growth') {
        const yard = this.view === 'growth' ? this.growthYard : this.pickedYard

        return yard ? (this.view === 'growth' ? `Growth of ${yard.name}` : yard.name) : null
      } else if (this.view === 'classes') {
        const target = this.classById[this.toId]

        return target ? `${OPERATION_VERBS[this.operation]} ${target.name}` : null
      }

      return this.pair ? `${this.pair.from.name} to ${this.pair.to.name}` : null
    },
  },
  watch: {
    // The picks and the colony belong to the race that was showing; the picks of the race now showing are restored with its other settings.
    RaceID() {
      this.colonyId = null
      this.linkedYardId = null
      this.linkedClassIds = []
      this.expanded = []
    },
    // A pick that is no longer one of the race's classes (a class deleted since, or one the race never had) is dropped once the classes are known, unless a link named it: the page then says so.
    classes(list) {
      if (list.length) {
        for (const name of ['fromId', 'toId']) {
          const id = this[name]

          if (id && !this.classById[id] && !this.linkedClassIds.includes(id)) {
            this[name] = null
          }
        }
      }
    },
    // The yard opened last in the Yards view is the one the page is open on.
    expanded(rows) {
      if (rows.length) {
        this.yardId = rows[rows.length - 1].id
      }
    },
  },
  methods: {
    sortNullLast,
    isAvailable,
    describeResult,

    // A query with `view=classes` is the Class to yards view (with its work and class), `view=growth` the Growth view and `view=yards` or a yard or colony alone the Yards view; any other, a link to a refit or the Refits view's own entry, is the Refits view.
    applyLink(query) {
      const single = (value) => (Array.isArray(value) ? value[0] : value)
      const view = single(query.view)
      const yardId = queryId(query.yard)

      this.colonyId = queryId(query.colony)
      this.linkedYardId = yardId
      this.expanded = yardId ? [{ id: yardId }] : []

      if (view === 'classes') {
        const operation = single(query.operation)

        this.view = 'classes'
        this.operation = YARD_OPERATIONS.includes(operation) ? operation : 'build'
      } else {
        this.view = ['yards', 'growth', 'refits'].includes(view) ? view : yardId || this.colonyId ? 'yards' : 'refits'
      }

      // The classes of a link are the visit's: the stored picks are left as they were, and a link to the Yards or Growth view does not touch them.
      if (this.view === 'refits' || this.view === 'classes') {
        const fromId = queryId(query.from)
        const toId = queryId(query.to)

        this.linkedClassIds = [fromId, toId].filter((id) => id)
        this.setUnsaved('fromId', fromId)
        this.setUnsaved('toId', toId)
      } else {
        this.linkedClassIds = []
      }

      if (yardId || this.view === 'yards') {
        this.setUnsaved('yardId', yardId)
      }
    },

    typeLabel(yard) {
      return YARD_TYPES[yard.type] || (isNumber(yard.type) ? `Type ${yard.type}` : UNKNOWN_TEXT)
    },

    // The tons the Growth view's continual upgrade of a yard aims at: the one typed, else the yard's capacity and DEFAULT_GROWTH_TONS; null while the capacity is not known.
    growthTargetFor(yard) {
      return this.growthTarget !== null ? this.growthTarget : isNumber(yard.capacity) ? yard.capacity + DEFAULT_GROWTH_TONS : null
    },

    openGrowth(yardId) {
      this.yardId = yardId
      this.view = 'growth'
    },

    // The continual target typed: the tons, or none (the default) for a blank or a value that is not a number above 0.
    setTarget(text) {
      const number = Number(text)

      this.growthTarget = text !== null && text !== undefined && String(text).trim() !== '' && Number.isFinite(number) && number > 0 ? number : null
    },

    yardRowClass(item) {
      return item.id === this.yardId ? 'is-picked' : ''
    },

    // A shipyard task as a line: what it is, what it is for, and its time left as the Production Recap times it.
    taskLineOf(yard, task, modifiers) {
      const { classById } = this
      const finish = taskFinish(modifiers, yard, task)
      const target = task.refitId && classById[task.refitId] ? ` to ${classById[task.refitId].name}` : ''

      return { id: task.id, label: SHIPYARD_TASK_TYPES[task.taskType] || `Task ${task.taskType}`, subject: `${task.className || task.name || '—'}${target}`, remaining: task.remaining, paused: task.paused === true, rate: valueOrNull(finish.rate), rateResult: finish.rate, days: valueOrNull(finish.result), result: finish.result, idle: finish.idle }
    },

    // A yard's own activity as { label, detail, paused, approx, days, result, idle }: an upgrade or a retool, timed as the Production Recap times it.
    activityOf(yard, modifiers) {
      const finish = activityFinish(modifiers, yard)
      const parts = []

      if (yard.taskType === RETOOL_ACTIVITY) {
        parts.push(`to ${yard.retoolId && this.classById[yard.retoolId] ? this.classById[yard.retoolId].name : 'no class'}`)
      } else if (yard.taskType === CONTINUAL_ACTIVITY) {
        parts.push(`to ${this.count(yard.capacityTarget)} t`)
      }

      if (isNumber(yard.requiredBP) && yard.requiredBP > 0 && isNumber(yard.completedBP)) {
        parts.push(`${this.count((yard.completedBP / yard.requiredBP) * 100)}% done`)
      }

      return { label: SHIPYARD_UPGRADE_TYPES[yard.taskType] || `Activity ${yard.taskType}`, detail: parts.join(' · '), paused: yard.paused === true, approx: yard.taskType === CONTINUAL_ACTIVITY, days: valueOrNull(finish.result), result: finish.result, idle: finish.idle }
    },

    daysText(days, approx = false) {
      return days === null ? '—' : `${approx ? '~' : ''}${this.duration(days)}`
    },

    taskTime(line) {
      return line.paused ? 'Paused' : line.idle ? 'No capacity' : this.daysText(line.days)
    },

    activityTime(activity) {
      return activity.paused ? 'Paused' : activity.idle ? 'No capacity' : this.daysText(activity.days, activity.approx)
    },

    growthTime(step) {
      return step.idle ? 'No capacity' : this.daysText(step.days, step.approx)
    },

    addsText(step) {
      return step.tons === null ? '1 slipway' : isNumber(step.tons) ? `${step.tons > 0 ? '+' : ''}${this.count(step.tons)} t` : '—'
    },

    barWidth(days, longest) {
      return days === null || !(longest > 0) ? 0 : Math.max(2, Math.round((days / longest) * 100))
    },

    selectPair(source, target) {
      this.fromId = source.id
      this.toId = target.id
    },

    // Shows a running refit in the Refits view, whichever view the page was in.
    selectPairById(fromId, toId) {
      this.view = 'refits'
      this.fromId = fromId
      this.toId = toId
    },

    swapPair() {
      const { fromId } = this

      this.fromId = this.toId
      this.toId = fromId
    },

    figureOf(result) {
      return valueOrNull(result)
    },

    shipCountOf(classId) {
      return this.shipCounts[classId] || 0
    },

    shipsText(classId) {
      const ships = this.shipCountOf(classId)

      return `${this.count(ships)} ${ships === 1 ? 'ship' : 'ships'}`
    },

    percent(result) {
      const value = valueOrNull(result)

      return value === null ? UNKNOWN_TEXT : `${this.count(value, value < 10 ? 1 : 0)}%`
    },

    yardsText(known, unknown) {
      return unknown ? `≥${this.count(known)}` : this.count(known)
    },

    cellTitle(source, cell) {
      const total = valueOrNull(cell.refit.total)
      const { info } = cell
      const takes = info.unknownYards ? `at least ${info.refitYards} yards take the target class now or when a slipway frees` : `${info.refitYards} yards take the target class now or when a slipway frees`
      const retools = info.unknownYards ? `at least ${info.retoolYards} would take it after a retool, and ${info.unknownYards} more are not known either way` : `${info.retoolYards} would take it after a retool`

      return `${source.name} to ${cell.target.name}: ${this.count(total, 1)} BP, ${this.percent(cell.shareSource)} of ${source.name}'s cost, ${this.percent(cell.shareTarget)} of ${cell.target.name}'s cost; ${takes}, ${retools}${cell.noRetool.ok === true ? '; a yard tooled for the source needs no retool' : ''}`
    },

    // What an eligibility result reads as: its state's label, icon, colour and rank, the reasons and the notes.
    statusOf(result) {
      return { ...STATE_VIEW[result.state], reasons: result.reasons.join('; '), notes: result.notes.join('; ') }
    },

    // A yard's retool to `target` from its eligibility `result`, costed from its own tooled class: { state, label, note, cost, days, costResult, timeResult, gap }.
    retoolOf(yard, result, target, modifiers, version) {
      const none = (state, label, note = '') => ({ state, label, note, cost: null, days: null, costResult: null, timeResult: null, gap: null })
      const { tooling } = result

      if (result.state === 'unsupported') {
        return none('unsupported', 'Not covered')
      } else if (result.state === 'ineligible') {
        return none('blocked', 'Cannot')
      } else if (result.state === 'unknown') {
        return { ...none('unknown', ''), gap: unavailable({ rule: 'refit.retool', missing: result.missing, units: 'BP' }) }
      } else if (!tooling) {
        return none('none', '')
      } else if (tooling.kind === 'tooled') {
        return none('tooled', 'Tooled for the class')
      } else if (tooling.kind === 'compatible') {
        return none('noRetool', 'No retool needed', `Within 20% of ${tooling.tooled.name}'s size, refit at most a fifth of its cost`)
      } else if (tooling.kind === 'unassigned') {
        return none('immediate', 'At once', 'The yard has no tooled class')
      }

      const operations = modifiers && isNumber(modifiers.ShipyardOperations) ? modifiers.ShipyardOperations : null
      const priced = retoolCost({ tooling: tooling.tooled, target, refit: tooling.refit, slipways: yard.slipways, operations, version })

      if (priced.kind === 'immediate') {
        return none('immediate', 'At once', 'The refit from the tooled class costs nothing')
      }

      const timeResult = retoolTime(modifiers, yard, priced.cost)

      return { state: 'priced', label: '', note: `From ${tooling.tooled.name}`, cost: valueOrNull(priced.cost), days: valueOrNull(timeResult), costResult: priced.cost, timeResult, gap: null }
    },

    // A running task as a table row: the stored cost against the rule's, the share done and the time left (null with `statusLabel` while paused or stalled).
    runningRow({ key, kind, name, yardName, sourceId, targetId, sourceName, targetName, stored, completed, check, paused, finish, idle = false }) {
      const days = valueOrNull(finish)
      const known = isNumber(stored) && isNumber(completed)

      return {
        key,
        kind,
        name,
        yardName,
        sourceId,
        targetId,
        sourceName,
        targetName,
        stored: isNumber(stored) ? stored : null,
        expected: check.expected,
        expectedResult: check.priced ? check.priced.cost : check.refit ? check.refit.total : unavailable({ rule: kind === 'Retool' ? 'refit.retool' : 'refit.cost', missing: ['a class that is one of the race\'s classes'], units: 'BP' }),
        matches: check.matches,
        done: known && stored > 0 ? (completed / stored) * 100 : null,
        remaining: known ? stored - completed : null,
        days,
        daysSort: days,
        finish,
        statusLabel: paused === true ? 'Paused' : idle ? 'No capacity' : '',
      }
    },
  },
  asyncComputed: {
    refitData: {
      get: tracked('refitData', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { classes: [], components: {} }
        }

        return await loadRefitClasses(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { classes: [], components: {} },
    },
    // What the platform comparison reads beside the classes and the yards: each class's armour and mining modules, whether the race has researched each component of its classes, and each colony's component stock, projects, spaceports and construction workers.
    platformSources: {
      get: tracked('platformSources', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { extras: {}, colonies: {}, researched: null, stockRead: false }
        }

        return await loadPlatformSources(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { extras: {}, colonies: {}, researched: null, stockRead: false },
    },
    // The race's ships, not destroyed, by class: the own-ship count the other pages use.
    shipCounts: {
      get: tracked('shipCounts', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadShipCounts(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },
    yards: {
      get: tracked('yards', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadYards(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // The Shipyard Operations levels the race holds: the multiplier on the price of every yard upgrade.
    shipyardOperationsHeld: {
      get: tracked('shipyardOperationsHeld', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await loadShipyardOperations(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: null,
    },
    refitTasks: {
      get: tracked('refitTasks', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadRefitTasks(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    retoolTasks: {
      get: tracked('retoolTasks', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadRetoolTasks(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // The formula version the save's schema stands for (`loadFormulaVersion`, utilities/capabilities.js): the stated one for a save that has the formula columns, null for a save without them.
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
.shipyards-page {
  .controls {
    gap: 12px;
  }

  .search-field {
    min-width: 180px;
    max-width: 240px;
  }

  .class-picker {
    min-width: 200px;
    max-width: 280px;
  }

  td,
  .breakdown td {
    font-variant-numeric: tabular-nums;
  }

  .pair-title {
    gap: 4px;
    margin-bottom: 12px;
  }

  .chips {
    gap: 6px;
    margin-top: 4px;
  }

  .matrix-scroll {
    max-height: 70vh;
    overflow: auto;
  }

  .yard-picker {
    min-width: 240px;
    max-width: 360px;
  }

  .target-field {
    min-width: 180px;
    max-width: 220px;
  }

  .yard-detail {
    padding: 8px 16px 14px !important;
  }

  tr.is-picked {
    background: var(--ae-row-selected);
  }

  .growth-table {
    .bar-head,
    .bar-cell {
      min-width: 160px;
      width: 30%;
    }
  }

  .days-bar {
    display: block;
    height: 8px;
    border-radius: 4px;
    background: var(--ae-track-soft);
    overflow: hidden;

    span {
      display: block;
      height: 100%;
      background: var(--ae-primary);
    }
  }

  .refit-matrix {
    border-collapse: separate;
    border-spacing: 0;

    th,
    td {
      border-bottom: 1px solid var(--ae-border);
      border-right: 1px solid var(--ae-border);
    }

    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      min-width: 112px;
      max-width: 112px;
      padding: 6px 6px;
      background: var(--ae-card);
      text-align: center;
      font-weight: 500;
      font-size: calc(12px * var(--ae-font-scale));
    }

    thead th.corner {
      left: 0;
      z-index: 4;
      min-width: 200px;
      max-width: 220px;
      text-align: left;
    }

    .row-head {
      position: sticky;
      left: 0;
      z-index: 1;
      min-width: 200px;
      max-width: 220px;
      padding: 4px 8px;
      background: var(--ae-card);
      text-align: left;
      font-weight: 500;
      font-size: calc(13px * var(--ae-font-scale));
    }

    .class-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .is-selected {
      background: var(--ae-row-selected);
    }

    .matrix-cell {
      min-width: 112px;
      max-width: 112px;
      padding: 0;
      text-align: center;
      font-size: calc(12px * var(--ae-font-scale));
      line-height: 1.3;
    }

    .matrix-cell.is-same {
      background: var(--ae-track-soft);
    }

    .cell-button {
      display: block;
      width: 100%;
      padding: 4px 6px;
      background: transparent;
      border: 0;
      color: inherit;
      font: inherit;
      cursor: pointer;

      &:hover {
        background: var(--ae-hover);
      }

      &:focus-visible {
        outline: 2px solid var(--ae-primary);
        outline-offset: -2px;
      }
    }

    .cell-unpriced {
      cursor: default;
    }

    .cell-time {
      display: block;
      font-weight: 500;
      white-space: nowrap;
    }

    .cell-share,
    .cell-yards {
      display: block;
      color: var(--ae-muted);
      font-size: calc(11px * var(--ae-font-scale));
      white-space: nowrap;
    }
  }
}
</style>
