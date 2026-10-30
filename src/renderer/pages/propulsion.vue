<template>
  <div>
    <v-container fluid class="propulsion-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--hull">
            <div class="tool__label caption text--secondary">Hull without engines and fuel</div>
            <v-text-field :value="hullTonsField" :type="selectedClass ? 'text' : 'number'" min="1" suffix="tons" :disabled="!!selectedClass" aria-label="Hull in tons" dense outlined hide-details @input="setHullTons" />
          </div>
          <div class="tool tool--class">
            <div class="tool__label caption text--secondary">Saved class</div>
            <v-autocomplete :value="selectedClass ? selectedClass.id : null" :items="classItems" item-text="text" item-value="value" placeholder="None" prepend-inner-icon="mdi-ferry" aria-label="Saved class to take the hull from" clearable dense outlined hide-details @change="pickClass" />
          </div>
          <div class="tool tool--speed">
            <div class="tool__label caption text--secondary">Speed at least</div>
            <v-text-field :value="speed" type="number" min="1" suffix="km/s" aria-label="Speed in km/s" dense outlined hide-details @input="setSpeed" />
          </div>
          <div class="tool">
            <div class="tool__label caption text--secondary">Goal</div>
            <v-btn-toggle v-model="rangeMode" mandatory dense>
              <v-btn value="range" small>Range</v-btn>
              <v-btn value="endurance" small>Endurance</v-btn>
            </v-btn-toggle>
          </div>
          <div class="tool tool--goal">
            <div class="tool__label caption text--secondary">{{ rangeMode === 'range' ? 'Range at least' : 'Endurance at least' }}</div>
            <v-text-field :value="range[rangeMode]" type="number" min="0" :suffix="rangeMode === 'range' ? 'bn km' : 'days'" :aria-label="rangeMode === 'range' ? 'Range in billions of km' : 'Endurance in days'" dense outlined hide-details @input="setGoal" />
          </div>
          <div class="tool tool--cruise">
            <div class="tool__label caption text--secondary">Cruise power</div>
            <v-text-field :value="Math.round(fraction * 100)" type="number" min="1" max="100" suffix="%" aria-label="Cruise power as a share of full power" dense outlined hide-details @input="setCruise" />
          </div>
          <div class="tool tool--actions">
            <div class="tool__buttons">
              <v-menu offset-y left :close-on-content-click="false" max-width="440">
                <template #activator="{ on, attrs }">
                  <v-btn outlined :color="sweepHasErrors ? 'error' : undefined" aria-label="Engine options" v-bind="attrs" v-on="on"><v-icon small left>mdi-engine-outline</v-icon><span class="tool__btn-label">Engines</span><span v-if="engineOptionCount">&nbsp;({{ engineOptionCount }})</span></v-btn>
                </template>
                <v-card class="pa-4">
                  <div class="subtitle-2">Engines</div>
                  <v-btn-toggle :value="engineOptions.kind" mandatory dense class="mt-2" :disabled="!!existingEngine" @change="(value) => setEngineOption('kind', value)">
                    <v-btn v-for="option in kinds" :key="option.value" :value="option.value" small>{{ option.text }}</v-btn>
                  </v-btn-toggle>
                  <v-row dense class="mt-2">
                    <v-col cols="4"><v-text-field :value="engineFieldText('min')" type="number" min="1" label="Fewest" aria-label="Fewest engines" :error-messages="sweepFields.errors.min" dense outlined hide-details="auto" @input="(value) => setEngineNumber('min', value)" /></v-col>
                    <v-col cols="4"><v-text-field :value="engineFieldText('max')" type="number" min="1" label="Most" aria-label="Most engines" :error-messages="sweepFields.errors.max" dense outlined hide-details="auto" @input="(value) => setEngineNumber('max', value)" /></v-col>
                    <v-col cols="4"><v-text-field :value="engineFieldText('share')" type="number" min="1" max="100" suffix="%" label="Share" aria-label="Most of the ship the engines and fuel may take, in percent" :error-messages="sweepFields.errors.share" dense outlined hide-details="auto" @input="(value) => setEngineNumber('share', value)" /></v-col>
                  </v-row>
                  <div class="caption text--secondary mt-1">The share is the most of the finished ship the engines and their fuel tanks may take.</div>
                  <v-autocomplete :value="engineId" :items="engineItems" item-text="text" item-value="value" label="Engine" placeholder="Design new engines" prepend-inner-icon="mdi-engine-outline" clearable dense outlined hide-details class="mt-3" @change="(value) => (engineId = value || null)" />
                  <div class="caption text--secondary mt-1">An engine of the race's own fixes the size, thrust and fuel of the set, and only its count is searched.</div>
                  <div v-if="sweepPreview" class="sweep-detail mt-3" data-sweep="detail">
                    <div class="d-flex align-center justify-space-between">
                      <div class="subtitle-2">Sweep</div>
                      <v-btn-toggle v-model="sweepUnit" mandatory dense>
                        <v-btn value="hs" small aria-label="Show engine sizes in HS">HS</v-btn>
                        <v-btn value="tons" small aria-label="Show engine sizes in tons">Tons</v-btn>
                      </v-btn-toggle>
                    </div>
                    <template v-if="sweepPreview.ok">
                      <div v-for="line in sweepPreview.lines" :key="line.key" class="caption mt-1"><span class="font-weight-medium">{{ line.label }}</span> {{ line.detail }}</div>
                      <div class="caption mt-1"><span class="font-weight-medium">Combinations</span> up to {{ count(sweepPreview.combinations) }}, before the counts that cannot reach the speed or fit the share are dropped.</div>
                    </template>
                    <div v-for="problem in sweepPreview.problems" :key="problem" class="caption error--text mt-1">{{ problem }}</div>
                    <v-checkbox :input-value="!!engineOptions.exactLimits" label="Try a researched limit between two steps" :disabled="!!existingEngine" dense hide-details class="mt-1" @change="(value) => setEngineOption('exactLimits', !!value)" />
                    <div class="caption text--secondary">Sizes step by 0.1 HS to 10 HS, by 0.25 HS to 20 HS and by 1 HS above; thrust steps by 0.05. A researched least or greatest limit that falls between two steps is left out. With this on it is tried once, as the first or last value.</div>
                  </div>
                </v-card>
              </v-menu>
              <v-menu offset-y left :close-on-content-click="false" max-width="560" max-height="640">
                <template #activator="{ on, attrs }">
                  <v-btn outlined aria-label="Tech levels" v-bind="attrs" v-on="on"><v-icon small left>mdi-flask-outline</v-icon><span class="tool__btn-label">Tech</span><span v-if="techChoiceCount">&nbsp;({{ techChoiceCount }})</span></v-btn>
                </template>
                <v-card class="pa-4">
                  <div class="subtitle-2">Tech levels designed with</div>
                  <div class="caption text--secondary mb-2">Each line starts at the level the game designs with. A lower level shows what an engine built before the latest research would be. The next tech choice is a hypothetical level the race has not researched: every result built on it is marked hypothetical, and a level with a missing prerequisite says so.</div>
                  <div v-if="scenarioNotice" class="caption warning--text mb-2" data-tech="notice">{{ scenarioNotice }}</div>
                  <div v-for="line in techLines" :key="line.type" class="mt-3" :data-tech-line="line.type">
                    <v-autocomplete :value="line.selected" :items="line.items" item-text="text" item-value="value" :label="line.label" :disabled="!line.items.length" dense outlined hide-details @change="(id) => setTech(line.type, id)" />
                    <v-autocomplete v-if="line.candidates.length" :value="line.candidate" :items="line.candidates" item-text="text" item-value="value" :label="`${line.label}: next tech (hypothetical)`" clearable dense outlined hide-details class="mt-1" @change="(id) => chooseNextTech(line.type, id)" />
                    <div v-if="line.hypothetical" class="caption warning--text pt-1 pl-3" data-tech="hypothetical-line">Hypothetical: the results use a level the race has not researched.</div>
                    <div v-if="line.unresolved" class="caption warning--text pt-1 pl-3" data-tech="unresolved-line">{{ line.unresolvedText }}<v-btn x-small text class="ml-1" @click="forgetChoice(line.type)">Forget the choice</v-btn></div>
                    <div v-if="line.next" class="d-flex align-center caption text--disabled pt-1 pl-3">Next: {{ line.nextText }}<page-link :to="linkTo.techTree({ tech: line.next.id })" :name="line.next.name" class="ml-1" /></div>
                    <div v-else-if="line.candidates.length" class="caption text--disabled pt-1 pl-3">No further level is researchable now.</div>
                    <div v-else-if="!line.items.length" class="caption text--disabled pt-1 pl-3">Not researched</div>
                  </div>
                </v-card>
              </v-menu>
            </div>
          </div>
        </div>

        <div v-if="sweepPreview && sweepPreview.ok" class="sweep-summary caption text--secondary mt-2" data-sweep="summary">
          <div>{{ sweepSummaryText }}</div>
          <div v-for="note in sweepPreview.notes" :key="note">{{ note }}</div>
        </div>

        <div v-if="searching" class="d-flex align-center mt-2">
          <v-progress-linear :value="progress * 100" height="3" class="flex-grow-1" aria-label="Searching propulsion sets" />
          <v-btn v-if="running" x-small text class="ml-2" aria-label="Stop the search and keep the best sets so far" data-search="stop" @click="cancelSearch">Stop</v-btn>
        </div>
        <v-alert v-if="sweepErrorText" type="error" outlined dense class="mt-3" data-sweep="errors">The search does not run: {{ sweepErrorText }}</v-alert>
        <v-alert v-else-if="searchError" type="error" outlined dense class="mt-3">The search failed: {{ searchError }}</v-alert>
        <v-alert v-else-if="!engineTechMissing && !hullReady" type="info" outlined dense class="mt-3">Enter a hull size, or pick a saved class, to search propulsion sets.</v-alert>
        <v-alert v-else-if="engineTechMissing" type="warning" outlined dense class="mt-3">The race has no engine or fuel consumption tech to design engines with. A saved class and the race's own engines can still be shown.</v-alert>
        <v-alert v-else-if="!speedReady" type="info" outlined dense class="mt-3">Enter a speed between 1 and {{ count(maxSpeed) }} km/s.</v-alert>
        <v-alert v-else-if="emptyNotice === 'no-package'" type="warning" outlined dense class="mt-3">No tank package can hold the fuel of the targets: the race holds no fuel tank with known litres, size and cost, or a target asks for more fuel than the planner can size. Lower the range or endurance target, or research a fuel tank.</v-alert>
        <v-alert v-else-if="emptyNotice === 'unreachable'" type="warning" outlined dense class="mt-3">No engine set reaches {{ count(speed) }} km/s{{ goalText }} within {{ Math.round(engineOptions.share * 100) }}% of the ship. Raise the share or the most engines, lower the targets, allow both kinds of engine, or pick a higher tech level.</v-alert>
        <v-alert v-else-if="emptyNotice === 'so-far'" type="info" outlined dense class="mt-3" data-search="none-so-far">No matching set found so far. The search stopped before it explored the whole domain, so a set that meets the targets may still exist.</v-alert>
        <v-alert v-else-if="result && result.sets.length && result.packages && result.packages.boundExhausted && !searching" type="info" outlined dense class="mt-3">{{ result.packages.boundExhausted }} of the {{ result.counts.feasible }} sets that meet the targets carry fuel tanks that hold the litres but are not proved the lightest. The mark beside the tanks of a set says so.</v-alert>
        <v-alert v-if="result && result.run.incomplete && !searching" type="warning" outlined dense class="mt-3" data-search="incomplete">Incomplete search. {{ result.run.text }}</v-alert>
        <div v-else-if="result && !searching" class="caption text--secondary mt-2" data-search="outcome">
          <div>{{ result.run.text }}</div>
          <div v-if="result.output.omitted > 0">The best {{ count(result.output.listed) }} are listed; {{ count(result.output.omitted) }} more meet the targets.</div>
        </div>
        <v-alert v-if="hypotheticalNotice" type="warning" outlined dense class="mt-3" data-tech="hypothetical">{{ hypotheticalNotice }}</v-alert>
        <v-alert v-for="item in unresolvedChoices" :key="item.type" type="warning" outlined dense class="mt-3" data-tech="unresolved">{{ item.text }}</v-alert>
        <v-alert v-if="scenarioNotice" type="info" outlined dense class="mt-3" data-tech="scenario-notice">{{ scenarioNotice }}</v-alert>

        <stat-tiles :tiles="tiles" class="mt-1" :class="{ 'is-searching': searching }" />

        <v-card class="panel" data-summary="Compare propulsion sets meeting the hull's speed and range targets, ranked by the share of the ship they occupy." elevation="1">
          <div class="panel-head">
            <span>Propulsion sets<v-chip v-if="result && result.run.incomplete && !searching" x-small color="warning" outlined class="ml-2" data-search="incomplete-chip">Incomplete</v-chip><v-chip v-if="propulsionAssumptions.length" x-small color="warning" outlined class="ml-2" data-tech="hypothetical-chip">Hypothetical tech</v-chip></span>
            <span class="d-flex align-center flex-wrap">
              <v-chip v-if="hullReady" small class="mr-2">Hull {{ count(hullHS, 2) }} HS · {{ count(hullHS * tonsPerHs) }} tons</v-chip>
              <v-chip v-if="existingEngine" small color="primary" outlined close @click:close="engineId = null">{{ existingEngine.name }}</v-chip>
              <v-btn small text :disabled="!rows.length" aria-label="Download the sets as CSV" @click="downloadCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
            </span>
          </div>
          <v-data-table :headers="setHeaders" :items="rows" item-key="key" show-expand :expanded.sync="expanded" :custom-sort="sortRows" :sort-by.sync="setsTable.sortBy" :sort-desc.sync="setsTable.sortDesc" :items-per-page.sync="setsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: setPageSizes }" :item-class="rowClass" :loading="searching" :no-data-text="searching ? 'Searching…' : 'No set yet.'" class="clickable-rows" @click:row="selectRow">
            <template #[`item.rank`]="{ item }"><span v-if="item.pinned" class="text--secondary">—</span><span v-else>{{ item.rank }}</span></template>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                <div class="caption text--secondary text-no-wrap">{{ item.detail }}</div>
              </div>
            </template>
            <template #[`item.count`]="{ item }"><span class="text-no-wrap">{{ count(item.count) }}</span></template>
            <template #[`item.thrust`]="{ item }"><span class="text-no-wrap">{{ item.thrust === null ? '—' : `× ${count(item.thrust, 2)}` }}</span></template>
            <template #[`item.power`]="{ item }"><span class="text-no-wrap">{{ count(item.power, 2) }}</span></template>
            <template #[`item.fuelPerEph`]="{ item }"><span class="text-no-wrap">{{ count(item.fuelPerEph, 4) }}</span></template>
            <template #[`item.propulsionHS`]="{ item }">
              <div class="text-no-wrap">{{ count(item.propulsionHS, 2) }}</div>
              <div class="caption text--secondary text-no-wrap">{{ count(item.tons) }} tons</div>
            </template>
            <template #[`item.share`]="{ item }"><span class="text-no-wrap">{{ percent(item.share) }}</span></template>
            <template #[`item.speed`]="{ item }">
              <span class="text-no-wrap">{{ item.speed === null ? '—' : count(item.speed) }}</span>
              <provenance-mark :result="item.provenance.speed" />
              <v-icon v-if="item.check && !item.check.matches" x-small color="warning" class="ml-1" :title="`The save stores ${count(item.check.stored)} km/s for this class.`">mdi-alert-circle-outline</v-icon>
            </template>
            <template #[`item.burn`]="{ item }"><span class="text-no-wrap">{{ item.burn === null ? '—' : litres(item.burn) }}</span><provenance-mark :result="item.provenance.burn" /></template>
            <template #[`item.rangeBn`]="{ item }"><span class="text-no-wrap">{{ item.rangeBn === null ? '—' : count(item.rangeBn, 2) }}</span><provenance-mark :result="item.provenance.rangeBn" /></template>
            <template #[`item.enduranceDays`]="{ item }"><span class="text-no-wrap">{{ item.enduranceDays === null ? '—' : count(item.enduranceDays, 1) }}</span><provenance-mark :result="item.provenance.enduranceDays" /></template>
            <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ item.cost === null ? '—' : count(item.cost, 1) }}</span><provenance-mark :result="item.provenance.cost" /></template>
            <template #[`item.type`]="{ item }"><span class="text-no-wrap">{{ item.type }}</span></template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="expand-cell">
                <div class="caption text--secondary mb-1">{{ item.pinned ? 'The engines as the game designed them' : 'The engine as the game would design it' }}</div>
                <v-simple-table dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Engine</th>
                      <th class="text-right">Count</th>
                      <th class="text-right">Power (EP)</th>
                      <th class="text-right">Fuel / h (L)</th>
                      <th class="text-right">L / EP hour</th>
                      <th class="text-right">Size (HS)</th>
                      <th class="text-right">Tons</th>
                      <th class="text-right">HTK</th>
                      <th class="text-right">Thermal</th>
                      <th class="text-right">Explosion</th>
                      <th class="text-right">Max explosion</th>
                      <th class="text-right">BP</th>
                      <th class="text-right">Crew</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(card, index) in item.cards" :key="index">
                      <td class="text-no-wrap">{{ card.name }}</td>
                      <td class="text-right">{{ count(card.count) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.power, 2) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.fuelPerHour, 2) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.fuelPerEph, 3) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.sizeHS, 2) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.tons) }}</td>
                      <td class="text-right">{{ count(card.htk) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.thermal, 1) }}</td>
                      <td class="text-right">{{ count(card.explosionChance) }}%</td>
                      <td class="text-right">{{ count(card.maxExplosion) }}</td>
                      <td class="text-right text-no-wrap">{{ count(card.cost, 2) }}</td>
                      <td class="text-right">{{ count(card.crew) }}</td>
                      <td>{{ card.commercial ? 'Commercial' : 'Military' }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div class="caption text--secondary mt-3 mb-1">Fuel tanks</div>
                <div v-if="!item.tanks.length" class="caption text--secondary">None: the set carries no fuel.</div>
                <v-simple-table v-else dense class="detail-table">
                  <thead>
                    <tr>
                      <th>Tank</th>
                      <th class="text-right">Count</th>
                      <th class="text-right">HS</th>
                      <th class="text-right">Litres</th>
                      <th class="text-right">BP</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="tank in item.tanks" :key="tank.id">
                      <td>{{ tank.name }}</td>
                      <td class="text-right">{{ count(tank.count) }}</td>
                      <td class="text-right text-no-wrap">{{ count(tank.sizeHS * tank.count, 3) }}</td>
                      <td class="text-right text-no-wrap">{{ count(tank.litres * tank.count) }}</td>
                      <td class="text-right text-no-wrap">{{ count(tank.cost * tank.count, 2) }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </td>
            </template>
          </v-data-table>
          <div v-if="selectedRow" class="panel-body provenance-basis caption text--secondary">
            <div class="provenance-basis__legend">
              <span v-for="status in statuses" :key="status" class="provenance-basis__legend-item"><provenance-mark :status="status" label />{{ statusMeaning(status) }}</span>
            </div>
            <div class="mt-2">Basis of the figures of {{ selectedSetLabel }}:</div>
            <div v-for="line in basisRows" :key="line.label" class="provenance-basis__line"><provenance-mark :result="line.result" label /><span class="font-weight-medium">{{ line.label }}</span> {{ basisText(line.result) }}</div>
          </div>
          <div class="panel-foot caption text--secondary">
            A row opens to the engine as the game would build it and the tanks that hold its fuel. A mark beside speed, burn, range, endurance and BP says whether the figure is confirmed, estimated, assumed or unavailable, and the CSV keeps it. An engine of 25 HS or more at thrust 0.5 or less is commercial; any other is military. Speed is the total power over the ship's size in HS, times 1,000, cut to a whole number and capped at 270,000 km/s, and the fuel tanks are part of that size. The engines are tried over a grid of sizes, thrusts and counts that fit the share, with steps that widen with the size, so a size or thrust between two steps is not tried; a researched limit that falls between two steps is not tried unless the Engines menu says so. Sets rank by the least HS the engines and tanks take, then the least cost, then the higher speed. The saved class is worked out from the engines it mounts, and its speed is confirmed when the save stores the same speed. A figure with nothing to work from, such as the range of a class without engines, shows a dash and is unavailable, never 0.
          </div>
        </v-card>

        <mission-brief-panel :draft="briefDraft" :identity="briefOpening" :saved="briefSaved" :ahead="briefAhead" :selected="briefEntry ? briefEntry.uuid : null" :dirty="briefDirty" :can-save="briefCanSave" :problems="briefProblems" :evaluation="briefEvaluation" :preview="briefPreview" :accepted="briefAccepted" :presets="briefPresets" :size-unit="briefSizeUnit" :message="briefNotice" :conflict="briefConflict" :pending="pendingBrief" @select="selectBrief" @new="newBrief" @preset="previewBriefPreset" @field="setBriefField" @axes="setBriefAxes" @invalid="setBriefInvalid" @size-unit="briefSizeUnit = $event" @toggle="toggleBriefItem" @apply="applyBriefPreview" @cancel-preview="cancelBriefPreview" @save="saveBriefDraft(false)" @save-over="saveBriefDraft(true)" @remove="removeBrief" @move="moveBriefHere" @discard="discardPendingBrief" @keep="keepPendingBrief" />

        <v-card class="panel" data-summary="Compare efficient trade-offs between propulsion's share of the finished ship and speed or range." elevation="1">
          <div class="panel-head">
            <span>Trade-off</span>
            <span class="d-flex align-center flex-wrap">
              <v-btn-toggle v-model="tradeMetric" mandatory dense class="mr-2">
                <v-btn value="speed" small>Speed</v-btn>
                <v-btn value="range" small>Range</v-btn>
              </v-btn-toggle>
              <v-btn-toggle v-model="tradeView" mandatory dense>
                <v-btn value="chart" small aria-label="Chart"><v-icon small>mdi-chart-scatter-plot</v-icon></v-btn>
                <v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>
              </v-btn-toggle>
            </span>
          </div>
          <div class="panel-body">
            <div v-if="!tradeRows.length && !tradeSaved" class="caption text--secondary">No sets to compare yet.</div>
            <template v-else-if="tradeView === 'chart'">
              <div class="legend">
                <span class="legend-item"><series-key :color="kindColors.military" kind="point" />Military</span>
                <span class="legend-item"><series-key :color="kindColors.commercial" kind="point" />Commercial</span>
                <span v-if="tradeSaved" class="legend-item"><series-key :color="kindColors.saved" kind="point" />Saved class</span>
              </div>
              <chart-canvas type="line" :data="tradeChart.data" :options="tradeChart.options" :height="340" :label="`Share of the ship the propulsion takes against ${tradeMetric === 'speed' ? 'speed' : 'range'}`" />
            </template>
            <v-data-table v-else :headers="tradeHeaders" :items="tradeTable" item-key="key" :custom-sort="sortRows" disable-pagination hide-default-footer dense>
              <template #[`item.name`]="{ item }">{{ item.name }}<span v-if="item.pinned" class="caption text--secondary"> · saved class</span></template>
              <template #[`item.share`]="{ item }"><span class="text-no-wrap">{{ percent(item.share) }}</span></template>
              <template #[`item.speed`]="{ item }"><span class="text-no-wrap">{{ item.speed === null ? '—' : count(item.speed) }}</span><provenance-mark :result="item.provenance.speed" /></template>
              <template #[`item.rangeBn`]="{ item }"><span class="text-no-wrap">{{ item.rangeBn === null ? '—' : count(item.rangeBn, 2) }}</span><provenance-mark :result="item.provenance.rangeBn" /></template>
              <template #[`item.propulsionHS`]="{ item }"><span class="text-no-wrap">{{ count(item.propulsionHS, 2) }}</span></template>
              <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ item.cost === null ? '—' : count(item.cost, 1) }}</span><provenance-mark :result="item.provenance.cost" /></template>
            </v-data-table>
          </div>
          <div class="panel-foot caption text--secondary">Use it to see what extra speed or range costs in hull. A set is listed when no other set takes a smaller share of the finished ship and also goes faster (or farther). Every set already meets the speed and range targets, so the range column mostly shows the rounding of whole tanks. The table lists the same sets for reading off exact figures, with the saved class first, and the mark beside each figure keeps its status: a saved class's figures are observed, a designed set's BP is an estimate.</div>
        </v-card>

        <v-card class="panel" data-summary="Compare propulsion sets that meet the targets and that no other set beats on every selected axis." data-pareto="panel" elevation="1">
          <div class="panel-head">
            <span>Efficient sets<v-chip v-if="efficientProvisional && !searching" x-small color="warning" outlined class="ml-2" data-pareto="provisional-chip">Provisional</v-chip></span>
          </div>
          <div class="panel-body">
            <div class="d-flex flex-wrap">
              <div v-for="axis in paretoChoices" :key="axis.key" class="mr-4 mb-2">
                <div class="caption text--secondary">{{ axis.label }}</div>
                <v-btn-toggle :value="axis.pick" mandatory dense :data-pareto-axis="axis.key" @change="setParetoAxis(axis.key, $event)">
                  <v-btn value="off" small>Off</v-btn>
                  <v-btn value="min" small>Least</v-btn>
                  <v-btn value="max" small>Most</v-btn>
                </v-btn-toggle>
              </div>
            </div>
            <div v-if="!efficientAxes.length" class="caption text--secondary" data-pareto="few">Pick two or more axes to list the sets no other set beats on all of them.</div>
            <div v-else-if="searching" class="caption text--secondary" data-pareto="searching">Searching…</div>
            <div v-else-if="!efficient" class="caption text--secondary">No sets to compare yet.</div>
            <template v-else>
              <v-alert v-if="efficientProvisional" type="warning" outlined dense class="mt-2" data-pareto="provisional">{{ efficientNote }}</v-alert>
              <div v-else class="caption text--secondary mt-2" data-pareto="note">{{ efficientNote }}</div>
            </template>
          </div>
          <v-data-table v-if="efficientAxes.length && !searching && efficient" :headers="efficientHeaders" :items="efficientRows" item-key="key" show-expand :expanded.sync="paretoExpanded" :custom-sort="sortRows" :items-per-page="15" :footer-props="{ itemsPerPageOptions: setPageSizes }" :no-data-text="efficientEmpty" dense class="clickable-rows" data-pareto="table" @click:row="(row, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.name`]="{ item }">{{ item.name }}</template>
            <template #[`item.count`]="{ item }"><span class="text-no-wrap">{{ count(item.count) }}</span></template>
            <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ item.cost === null ? '—' : count(item.cost, 1) }}</span><provenance-mark :result="item.provenance.cost" /></template>
            <template #[`item.tons`]="{ item }"><span class="text-no-wrap">{{ count(item.tons) }}</span></template>
            <template #[`item.speed`]="{ item }"><span class="text-no-wrap">{{ item.speed === null ? '—' : count(item.speed) }}</span><provenance-mark :result="item.provenance.speed" /></template>
            <template #[`item.rangeBn`]="{ item }"><span class="text-no-wrap">{{ item.rangeBn === null ? '—' : count(item.rangeBn, 2) }}</span><provenance-mark :result="item.provenance.rangeBn" /></template>
            <template #[`item.enduranceDays`]="{ item }"><span class="text-no-wrap">{{ item.enduranceDays === null ? '—' : count(item.enduranceDays, 1) }}</span><provenance-mark :result="item.provenance.enduranceDays" /></template>
            <template #[`item.payload`]="{ item }"><span class="text-no-wrap">{{ count(item.payload, 2) }}</span></template>
            <template #[`item.alternativeCount`]="{ item }"><span class="text-no-wrap">{{ item.alternativeCount ? `+${count(item.alternativeCount)}` : '—' }}</span></template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="expand-cell" data-pareto="alike">
                <div v-if="!item.alternativeCount" class="caption text--secondary">No other set meeting the targets has these figures on every axis picked.</div>
                <template v-else>
                  <div class="caption text--secondary mb-1">{{ count(item.alternativeCount) }} other {{ item.alternativeCount === 1 ? 'set has' : 'sets have' }} these figures on every axis picked:</div>
                  <div v-for="line in item.alternatives" :key="line" class="caption">{{ line }}</div>
                  <div v-if="item.alternativesMore > 0" class="caption text--secondary">and {{ count(item.alternativesMore) }} more<template v-if="item.alternativeIds.length">: {{ item.alternativeIds.join(', ') }}<template v-if="item.alternativesMore > item.alternativeIds.length"> and others</template></template></div>
                </template>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">The axes are BP, propulsion tonnage, speed, range, endurance and payload. Each axis is taken as least or most as picked, and no score is added up. A set is listed when no other set that meets the targets is as good on every axis picked and better on one. A set with a figure that is not known on a picked axis takes no part and is counted above. The comparison covers every set the search evaluated that meets the targets, not only the sets the table above lists. It stays provisional while the search has stopped early or when more sets are efficient than the comparison holds. Sets with the same figures on every axis picked are kept under the first found, and a row opens to show them. Payload is the hull, the same for every set of one search, so it never tells two sets apart. Changing an axis runs the search again.</div>
        </v-card>

        <v-row>
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="Review the stock fuel tanks that hold the selected set's fuel in the fewest HS." elevation="1">
              <div class="panel-head">
                <span>Fuel tanks</span>
                <v-chip v-if="selectedRow" small>{{ selectedSetLabel }}</v-chip>
              </div>
              <div v-if="!selectedRow" class="panel-body caption text--secondary">No set to show yet. Click a row of the table to choose the set shown here.</div>
              <div v-else-if="!selectedRow.tanks.length" class="panel-body caption text--secondary">The set carries no fuel.</div>
              <v-simple-table v-else dense>
                <thead>
                  <tr>
                    <th>Tank</th>
                    <th class="text-right">Count</th>
                    <th class="text-right">HS</th>
                    <th class="text-right">Litres</th>
                    <th class="text-right">BP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="tank in selectedRow.tanks" :key="tank.id">
                    <td>{{ tank.name }}</td>
                    <td class="text-right">{{ count(tank.count) }}</td>
                    <td class="text-right text-no-wrap">{{ count(tank.sizeHS * tank.count, 3) }}</td>
                    <td class="text-right text-no-wrap">{{ count(tank.litres * tank.count) }}</td>
                    <td class="text-right text-no-wrap">{{ count(tank.cost * tank.count, 2) }}</td>
                  </tr>
                  <tr class="font-weight-medium">
                    <td>Total</td>
                    <td />
                    <td class="text-right text-no-wrap">{{ count(selectedRow.tankHS, 3) }}</td>
                    <td class="text-right text-no-wrap">{{ count(selectedRow.litres) }}</td>
                    <td class="text-right text-no-wrap">{{ count(selectedRow.tankCost, 2) }}</td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div v-if="selectedRow && selectedRow.tankPackage" class="panel-body pt-3 caption text--secondary"><provenance-mark :result="selectedRow.provenance.tanks" label /><span class="ml-2">{{ tankPackageText(selectedRow) }}</span></div>
              <div class="panel-foot caption text--secondary">Fit the fuel a range or endurance target needs. Each pick shows its litres and cost. Tanks are picked from the stock tanks the race holds: the package with the fewest HS that holds the litres the set needs, then the fewest BP, then the fewest tanks. Two tanks of a smaller size can beat one of a larger size, so the choice is never greedy by size. A package meets the litres within a relative 1e-9. The spare litres are what the whole tanks add. When the table behind the search runs out on a very large request, the package is marked not proved. The game has no packing rule, so this is the planner's own. A range target is met at the speed the finished ship reaches with the tanks aboard.</div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="Compare the selected set's fuel burn and endurance at full power, half power and the cruise share." elevation="1">
              <div class="panel-head">
                <span>Burn and endurance</span>
                <v-chip v-if="selectedRow" small>{{ selectedSetLabel }}</v-chip>
              </div>
              <div v-if="!selectedRow" class="panel-body caption text--secondary">No set to show yet. Click a row of the table to choose the set shown here.</div>
              <v-simple-table v-else dense>
                <thead>
                  <tr>
                    <th>Power</th>
                    <th class="text-right">Speed (km/s)</th>
                    <th class="text-right">Burn (L/h)</th>
                    <th class="text-right">Endurance (days)</th>
                    <th class="text-right">Range (bn km)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="level in burnLevels" :key="level.fraction">
                    <td>{{ percent(level.fraction) }}{{ level.fraction === fraction ? ' (cruise)' : '' }}</td>
                    <td class="text-right text-no-wrap">{{ level.speed === null ? '—' : count(level.speed) }}</td>
                    <td class="text-right text-no-wrap">{{ level.burn === null ? '—' : litres(level.burn) }}<provenance-mark :result="level.provenance.burn" /></td>
                    <td class="text-right text-no-wrap">{{ level.days === null ? '—' : count(level.days, 1) }}<provenance-mark :result="level.provenance.days" /></td>
                    <td class="text-right text-no-wrap">{{ level.rangeBn === null ? '—' : count(level.rangeBn, 2) }}<provenance-mark :result="level.provenance.rangeBn" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div class="panel-foot caption text--secondary">See what a slower cruise buys. The engines burn their power times the fuel per engine power hour every hour, scaled by the share of power in use, so a slower cruise lengthens the endurance and leaves the range as it is. The range is the fuel over the burn at full power, times the speed, times 3,600.</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" data-summary="Compare military and commercial jump drives the game would add to the finished hull." elevation="1">
          <div class="panel-head">
            <span>Jump drive</span>
            <v-chip v-if="selectedRow" small>Hull with the propulsion: {{ count(jumpHullHS, 2) }} HS</v-chip>
          </div>
          <div v-if="!selectedRow" class="panel-body caption text--secondary">No set to show yet. Click a row of the table to choose the set shown here.</div>
          <div v-else-if="!jumpDrives" class="panel-body caption text--secondary">The race has no jump drive efficiency tech researched.</div>
          <template v-else>
            <v-simple-table dense>
              <thead>
                <tr>
                  <th>Drive</th>
                  <th class="text-right">Drive size (HS)</th>
                  <th class="text-right">Designed for (HS)</th>
                  <th class="text-right">Moves up to (HS)</th>
                  <th class="text-right">Ship with the drive (HS)</th>
                  <th class="text-right">BP</th>
                  <th class="text-right">Crew</th>
                  <th class="text-right">HTK</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="drive in jumpDrives" :key="drive.name">
                  <td>{{ drive.name }}</td>
                  <td class="text-right text-no-wrap">{{ count(drive.sizeHS, 2) }}</td>
                  <td class="text-right text-no-wrap">{{ count(drive.designHS) }}</td>
                  <td class="text-right text-no-wrap">{{ count(drive.capacityHS) }}</td>
                  <td class="text-right text-no-wrap">{{ count(drive.totalHS, 2) }}</td>
                  <td class="text-right text-no-wrap">{{ count(drive.cost, 1) }}</td>
                  <td class="text-right">{{ count(drive.crew) }}</td>
                  <td class="text-right">{{ count(drive.htk) }}</td>
                </tr>
              </tbody>
            </v-simple-table>
            <div class="panel-body pt-3 caption text--secondary">
              <div>Squadron limits of the automatic design: {{ jumpSquadron }}.</div>
              <div>The race's own techs, as reference: {{ jumpReference }}.</div>
              <div v-if="selectedClass && selectedClass.drives.length">The saved class already mounts {{ driveList }}; the figures above are for the hull without them.</div>
              <div v-if="jumpAssumptions.length" class="warning--text" data-tech="jump-hypothetical">{{ jumpAssumptions.join('; ') }}. The figures above rest on it and are not the race's today.</div>
            </div>
          </template>
          <div class="panel-foot caption text--secondary">Each drive shows its size, cost, crew and the ships it moves. A drive for a ship of S HS is S over (efficiency × the larger of 1 and (S / 20) to the power 0.25) HS. Its cost is S over the efficiency, times the squadron size and radius cost multipliers, times 5; its crew is twice its size, rounded; its HTK is the square root of its size, cut to a whole number. A commercial drive is five times the size and moves five times the ships. The game's automatic design starts from the hull's size, rounded up (a fifth of it for a commercial drive), and grows the drive by 1 HS until it moves the hull with the drive aboard. It uses the race's highest efficiency tech and the default squadron size and radius techs, whatever else the race has researched, and it leaves the armour as it is.</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import MissionBriefPanel from '../components/planner/MissionBriefPanel.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { csvCell } from '../utilities/csv-cell'
import { linkTo, queryId } from '../utilities/deep-links'
import { loadClassParts, loadClasses, loadRaceEngines, loadStockTanks, splitClasses } from '../utilities/design-data'
import { DEFAULT_SQUADRON_RADIUS_TECH, DEFAULT_SQUADRON_SIZE_TECH, MAX_SPEED, TONS_PER_HS, burnPerHour, classSpeed, enduranceHours, fullPowerRangeKm, selfJumpDrive, tankPackageResult, thermalSignature } from '../utilities/design-rules'
import { engineFields, engineSweep, normaliseEngineOptions, propulsionRun } from '../utilities/design-search'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { NO_CLASS_FIGURES, PRESETS, PRESET_KEYS, additionsOf, applyPreview, deleteBrief, emptyBrief, evaluateBrief, loadClassFigures, moveBrief, normaliseBrief, previewPreset, problemsOf, propulsionAlternative, readBriefs, registerBriefs, sameBrief, saveBrief, withAxes, withField } from '../utilities/mission-briefs'
import { PARETO_AXES, axesOf, describeEmpty, describeFront, normaliseChoice } from '../utilities/pareto'
import { STATUS, STATUSES, STATUS_MARKS, combine, describeResult, envelope, exportFields, isAvailable, ofRule, unavailable, valueOrNull, weakestStatus } from '../utilities/provenance'
import { derive } from '../utilities/query-cache'
import { ENGINE_TECH_TYPE, FUEL_TECH_TYPE, JUMP_EFFICIENCY_TECH_TYPE, MAX_ENGINE_SIZE_TECH_TYPE, MAX_THRUST_TECH_TYPE, MIN_THRUST_TECH_TYPE, PROPULSION_TECH_TYPES, SQUADRON_RADIUS_TECH_TYPE, SQUADRON_SIZE_TECH_TYPE, THERMAL_TECH_TYPE } from '../utilities/race-tech'
import { RESPONSIVENESS, TERMINATION, countText, createRunSlot, describeOutcome } from '../utilities/search-run'
import { describeSweep } from '../utilities/sweep-domain'
import { NO_TECH_CHOICES, candidateText, hypotheticalAssumptionsOf, hypotheticalOf, loadTechChoices, markAllHypothetical, markHypothetical, readScenario, registerTechScenarios, resolveChoices, saveChoice, scopeOf, selectionOf } from '../utilities/tech-scenarios'

const INPUT_LABELS = {
  tech: 'the race\'s tech lines, researched levels and research graph',
  classes: 'the ship classes',
  classParts: 'the engines, tanks and jump drives of the classes',
  tanks: 'the fuel tanks',
  raceEngines: 'the race\'s engines',
  classFigures: 'the classes\' cargo, hangar and deployment',
}

// The search runs in slices of RESPONSIVENESS.sliceMs, handing the browser a turn between them to draw, and starts this long after the last change to an input.
const SEARCH_DELAY_MS = 250

const KINDS = [
  { value: 'either', text: 'Either' },
  { value: 'military', text: 'Military' },
  { value: 'commercial', text: 'Commercial' },
]
const KIND_VALUES = KINDS.map((option) => option.value)
const SET_PAGE_SIZES = [15, 30, -1]
const TRADE_VIEWS = ['chart', 'table']
const RANGE_MODES = ['range', 'endurance']
const SWEEP_UNITS = ['hs', 'tons']

// The tech lines the menu offers, with how a level reads. The line's levels are the ones the race has researched.
const TECH_LINES = [
  { type: ENGINE_TECH_TYPE, label: 'Engine technology', figure: (level) => `${level.info} EP/HS` },
  { type: FUEL_TECH_TYPE, label: 'Fuel consumption' },
  { type: THERMAL_TECH_TYPE, label: 'Thermal reduction' },
  { type: MAX_THRUST_TECH_TYPE, label: 'Maximum thrust' },
  { type: MIN_THRUST_TECH_TYPE, label: 'Minimum thrust' },
  { type: MAX_ENGINE_SIZE_TECH_TYPE, label: 'Maximum engine size' },
  { type: JUMP_EFFICIENCY_TECH_TYPE, label: 'Jump drive efficiency' },
  { type: SQUADRON_SIZE_TECH_TYPE, label: 'Squadron size (reference)' },
  { type: SQUADRON_RADIUS_TECH_TYPE, label: 'Squadron radius (reference)' },
]

// The race's starting techs, for a line the race has no level of.
const DEFAULTS = { minThrust: 0.5, maxThrust: 1, maxSize: 25, thermalTech: 1, thermalCost: 1 }

const EMPTY_LIST = Object.freeze([])

// How many more candidate ids of the sets alike a set a row names after the sets it describes.
const ALTERNATIVE_IDS_SHOWN = 40

// The column of the efficient sets table for each axis of the comparison: its heading and the field of the row it reads.
const PARETO_COLUMNS = { cost: ['BP', 'cost'], tons: ['Propulsion tons', 'tons'], speed: ['Speed (km/s)', 'speed'], range: ['Range (bn km)', 'rangeBn'], endurance: ['Endurance (d)', 'enduranceDays'], payload: ['Payload (HS)', 'payload'] }

// A new task as soon as the browser has had its turn, which still comes in a hidden window.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(null)
})

const finiteNumber = (value) => {
  const number = Number(value)

  return Number.isFinite(number) ? number : 0
}

const sumBy = (items, value) => items.reduce((total, item) => total + value(item), 0)

const unique = (lists) => [...new Set(lists.flat())]

const SPEED_INPUTS = ['engine power', 'ship size']
const BURN_INPUTS = ['engine power', 'fuel per engine-power hour']
const NO_ENGINES = 'engines: the class mounts none'
const SETS_NO_FUEL = 'fuel: no range or endurance target sizes any tanks'
const CLASS_NO_FUEL = 'fuel: the class stores none that is known'

// The figures the sets table, its CSV and the basis list carry a provenance result for.
const BASIS_COLUMNS = [['Speed (km/s)', 'speed'], ['Burn (L/h)', 'burn'], ['Range (bn km)', 'rangeBn'], ['Endurance (days)', 'enduranceDays'], ['BP', 'cost']]

const cruiseAssumption = (fraction) => `The engines run at ${Math.round(fraction * 100)}% of full power`

// A saved class's top speed: unavailable without engines or a size, estimated when the save stores another speed than the rule gives, otherwise confirmed.
const classSpeedResult = ({ power, sizeHS, speed, check }) => {
  if (!(power > 0 && sizeHS > 0)) {
    return unavailable({ rule: 'design.classSpeed', units: 'km/s', missing: [power > 0 ? 'ship size' : NO_ENGINES] })
  }

  if (check && !check.matches) {
    return envelope({ value: speed, status: STATUS.ESTIMATED, rule: 'design.classSpeed', units: 'km/s', inputs: { present: SPEED_INPUTS }, assumptions: [`The save stores ${check.stored} km/s for this class; the rule gives ${speed} km/s`] })
  }

  return ofRule({ rule: 'design.classSpeed', value: speed, units: 'km/s', inputs: { present: SPEED_INPUTS } })
}

// The burn, range and endurance of one row. All three are unavailable when the engines are missing or burn nothing, and range and endurance when `noFuel` says no fuel is known; a figure is never 0 for want of an input. The range is built from the speed and burn results, so it is as weak as they are and keeps their assumptions and inputs. The endurance is assumed: it rests on the share of power the player chose.
const fuelFigures = ({ speedResult, power, burn, noFuel, rangeKm, hours, fraction }) => {
  const stopped = !(power > 0) ? NO_ENGINES : !(burn > 0) ? 'fuel consumption: the engines burn none' : null

  if (stopped) {
    return { burn: unavailable({ rule: 'design.burnPerHour', units: 'L/h', missing: [stopped] }), rangeBn: unavailable({ rule: 'design.fullPowerRangeKm', units: 'bn km', missing: [stopped] }), enduranceDays: unavailable({ rule: 'design.enduranceHours', units: 'days', missing: [stopped] }) }
  }

  const burnResult = ofRule({ rule: 'design.burnPerHour', value: burn, units: 'L/h', inputs: { present: BURN_INPUTS } })

  if (noFuel) {
    return { burn: burnResult, rangeBn: unavailable({ rule: 'design.fullPowerRangeKm', units: 'bn km', present: BURN_INPUTS, missing: [noFuel] }), enduranceDays: unavailable({ rule: 'design.enduranceHours', units: 'days', present: BURN_INPUTS, missing: [noFuel] }) }
  }

  return {
    burn: burnResult,
    rangeBn: combine({ rule: 'design.fullPowerRangeKm', parts: { speed: speedResult, burn: burnResult }, compute: () => rangeKm / 1e9, units: 'bn km', inputs: { present: ['fuel'] } }),
    enduranceDays: envelope({ value: hours / 24, status: weakestStatus([STATUS.ASSUMED, burnResult.status]), rule: 'design.enduranceHours', units: 'days', inputs: { present: [...BURN_INPUTS, 'fuel'] }, assumptions: [cruiseAssumption(fraction)] }),
  }
}

// A designed set's figures: speed, burn and range follow rules checked against saved classes; the endurance rests on the cruise share; the BP is an estimate. `assumptions` are the hypothetical tech lines the set was designed with: every figure carries them and is at most assumed.
const setProvenance = (set, fraction, assumptions = EMPTY_LIST) => {
  const speedResult = classSpeedResult({ power: set.power, sizeHS: set.totalHS, speed: set.speed, check: null })
  const figures = {
    speed: speedResult,
    ...fuelFigures({ speedResult, power: set.power, burn: set.burnFull, noFuel: set.litres > 0 ? null : SETS_NO_FUEL, rangeKm: set.rangeKm, hours: set.enduranceHours, fraction }),
    cost: ofRule({ rule: 'design.propulsionSetCost', value: set.cost, units: 'BP', inputs: { present: ['engine design', 'stock tank costs'] } }),
    tanks: set.tankPackage ? tankPackageResult({ feasible: true, sizeHS: set.tankHS, objective: 'lightest', status: set.tankPackage.status, reason: set.tankPackage.reason }) : null,
  }

  return assumptions.length ? markAllHypothetical(figures, assumptions) : figures
}

// A saved class's BP: the sum of the stored costs of its engines and tanks, unavailable and naming the component when any stored cost is missing, never counted as 0.
const savedCostResult = (shipClass) => {
  const parts = [...shipClass.engines, ...shipClass.tanks]
  const missing = parts.filter((part) => !Number.isFinite(part.cost)).map((part) => `stored cost of ${part.name || 'a component'}`)

  if (missing.length) {
    return unavailable({ rule: 'design.savedPropulsionCost', units: 'BP', missing: unique([missing]) })
  }

  return ofRule({ rule: 'design.savedPropulsionCost', value: sumBy(parts, (part) => part.cost * part.count), units: 'BP', inputs: { present: ['engine costs', 'tank costs'] } })
}

// A saved class's figures, observed in the save or worked out exactly from what it stores.
const classProvenance = ({ shipClass, power, speed, check, burn, rangeKm, hours, fraction }) => {
  const speedResult = classSpeedResult({ power, sizeHS: shipClass.sizeHS, speed, check })

  return {
    speed: speedResult,
    ...fuelFigures({ speedResult, power, burn, noFuel: Number.isFinite(shipClass.fuel) ? null : CLASS_NO_FUEL, rangeKm, hours, fraction }),
    cost: savedCostResult(shipClass),
  }
}

// A burn or endurance level of the chosen row: the row's own result when it is unavailable, confirmed at full power, and assumed at any other share, which the player picked. The hypothetical tech the row's result rests on stays on every level, and keeps the level from being confirmed.
const levelResult = (base, rule, value, units, fraction) => {
  if (!isAvailable(base)) {
    return base
  }

  const result = fraction === 1 ? ofRule({ rule, value, units, inputs: base.inputs }) : envelope({ value, status: STATUS.ASSUMED, rule, units, inputs: base.inputs, assumptions: [cruiseAssumption(fraction)] })

  return markHypothetical(result, hypotheticalAssumptionsOf([base]))
}

// One engine as the game prints it on its design window, with how many the row mounts.
const engineCard = (engine, name, count) => ({
  name,
  count,
  power: engine.power,
  fuelPerHour: roundToDecimal(engine.power * engine.fuelPerEph, 2),
  fuelPerEph: roundToDecimal(engine.fuelPerEph, 3),
  sizeHS: engine.sizeHS,
  tons: engine.sizeHS * TONS_PER_HS,
  htk: engine.htk,
  thermal: roundToDecimal(engine.thermal, 1),
  explosionChance: engine.explosionChance,
  maxExplosion: engine.maxExplosion,
  cost: engine.cost,
  crew: engine.crew,
  commercial: engine.commercial,
})

// A page for the propulsion of one hull: the engines and fuel tanks that give it a speed and a range, searched over the race's engine tech and ranked by the HS they take.
export default {
  name: 'PropulsionPage',
  components: { ChartCanvas, LoadState, MissionBriefPanel, PageLink, ProvenanceMark, SeriesKey, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      target: { key: 'propulsionTarget', default: { kind: 'tonnage', value: 5000 }, scope: 'race', valid: (value) => value && ['tonnage', 'class'].includes(value.kind) && Number(value.value) > 0 },
      speed: { key: 'propulsionSpeed', default: 2500, scope: 'race', valid: (value) => typeof value === 'number' && value >= 0 },
      range: { key: 'propulsionRange', default: { range: 5, endurance: 30 }, scope: 'race', valid: (value) => value && value.range >= 0 && value.endurance >= 0 },
      rangeMode: { key: 'propulsionRangeMode', default: 'range', scope: 'race', valid: oneOf(RANGE_MODES) },
      fraction: { key: 'propulsionFraction', default: 0.5, scope: 'race', valid: (value) => value > 0 && value <= 1 },
      engineOptions: { key: 'propulsionEngines', default: { kind: 'either', min: 1, max: 100, share: 0.5, exactLimits: false }, scope: 'race', normalise: normaliseEngineOptions, valid: (value) => value && KIND_VALUES.includes(value.kind) && Number.isInteger(value.min) && Number.isInteger(value.max) && value.min >= 1 && value.max >= value.min && value.share >= 0.01 && value.share <= 1 && typeof value.exactLimits === 'boolean' },
      techChoice: { key: 'propulsionTech', default: {}, scope: 'race', valid: (value) => value && typeof value === 'object' && !Array.isArray(value) },
      setsTable: { ...tableView('propulsionSetsTable', { sortBy: ['rank'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: SET_PAGE_SIZES }), scope: 'race' },
      tradeView: { key: 'propulsionTradeView', default: 'chart', valid: oneOf(TRADE_VIEWS) },
      paretoAxes: { key: 'propulsionParetoAxes', default: {}, normalise: normaliseChoice, valid: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) },
      sweepUnit: { key: 'propulsionSweepUnit', default: 'hs', valid: oneOf(SWEEP_UNITS) },
      briefSelected: { key: 'propulsionBrief', default: null, scope: 'race', valid: (value) => value === null || typeof value === 'string' },
      briefSizeUnit: { key: 'propulsionBriefSizeUnit', default: 'tons', valid: oneOf(SWEEP_UNITS) },
    }),
  ],
  data() {
    return {
      // The race's own engine a link or the menu named, whose count alone is searched; null to design engines.
      engineId: null,
      // The search: its latest result, whether it runs, and how far.
      result: null,
      searching: false,
      progress: 0,
      running: false,
      searchError: '',
      // What the count and share fields hold as typed while a value is not accepted, by field ('min', 'max', 'share'); the stored value stays as it was until every field is right.
      sweepDrafts: {},
      // The row whose fuel and jump drive the panels show, by its key; the rows open in the table.
      selectedKey: null,
      expanded: [],
      paretoExpanded: [],
      tradeMetric: 'speed',
      kinds: KINDS,
      setPageSizes: SET_PAGE_SIZES,
      maxSpeed: MAX_SPEED,
      statuses: STATUSES,
      tonsPerHs: TONS_PER_HS,
      linkTo,
      // The hypothetical choices that could not be written to the scenario record (another tab holds the file, the campaign is not settled, the file cannot be written), by tech type: they hold for this page only.
      heldChoices: {},
      // Why the last choice was not kept in the record, and a count that makes the record be read again after a write.
      scenarioMessage: '',
      scenarioRevision: 0,
      // The mission brief being edited: the draft every alternative is judged against, the saved brief it was opened from (its uuid) and what a preset would change, as ticked fields, before it is applied.
      briefDraft: emptyBrief(),
      briefOrigin: null,
      // The revision and the payload the draft was opened at (or last saved at), kept apart from the list, which a later read moves on: a save is judged against these, so a change another writer made meanwhile is found however often the list was read again.
      briefBaseline: null,
      // The fields whose typed text is not a figure (the panel reports them) and a count the panel starts its text over at when another brief is opened.
      briefInvalid: [],
      briefOpening: 0,
      briefPreview: null,
      briefAccepted: [],
      briefPresets: PRESET_KEYS.map((key) => ({ key, label: PRESETS[key].label, summary: PRESETS[key].summary })),
      // Why the last write of a brief failed, the stored brief a stale save found, a brief waiting for the answer to discarding the unsaved changes, and a count that makes the briefs be read again after a write.
      briefMessage: '',
      briefConflict: null,
      pendingBrief: null,
      briefRevision: 0,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'GameTime']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    // The trade-off chart's three series and its legend: military and commercial sets, and the saved class.
    kindColors() {
      const [military, commercial, saved] = this.theme.categorical

      return { military, commercial, saved }
    },

    splits() {
      return derive(this.database, 'propulsion.splits', [this.classes, this.classParts], () => splitClasses(this.classes, this.classParts))
    },

    // The class the hull comes from, or null for a hull given in tons (or a class the save no longer has).
    selectedClass() {
      return this.target.kind === 'class' ? this.splits[this.target.value] || null : null
    },

    // Whether the saved target is a class the save lost, which falls back to a hull in tons.
    targetOrphaned() {
      return this.ready && this.target.kind === 'class' && !this.splits[this.target.value]
    },

    hullHS() {
      return this.selectedClass ? this.selectedClass.hullHS : finiteNumber(this.target.value) / TONS_PER_HS
    },

    hullReady() {
      return this.hullHS > 0
    },

    // The class's hull in the app's number format; a tonnage typed in stays as it was typed.
    hullTonsField() {
      return this.selectedClass ? this.count(this.hullHS * TONS_PER_HS, 1) : this.target.kind === 'tonnage' ? this.target.value : ''
    },

    speedReady() {
      return this.speed > 0 && this.speed <= MAX_SPEED
    },

    classItems() {
      return this.classes.map((shipClass) => ({ text: shipClass.obsolete ? `${shipClass.name} (obsolete)` : shipClass.name, value: shipClass.id }))
    },

    existingEngine() {
      return this.engineId ? this.raceEngines.find((engine) => engine.id === this.engineId) || null : null
    },

    engineItems() {
      return this.raceEngines.map((engine) => ({ text: `${engine.name} · ${this.count(engine.sizeHS, 2)} HS · ${this.count(engine.power, 2)} EP${engine.obsolete ? ' (obsolete)' : ''}`, value: engine.id }))
    },

    engineOptionCount() {
      const { kind, min, max, share, exactLimits } = this.engineOptions

      return (kind !== 'either' ? 1 : 0) + (min !== 1 || max !== 100 ? 1 : 0) + (share !== 0.5 ? 1 : 0) + (exactLimits ? 1 : 0) + (this.existingEngine ? 1 : 0)
    },

    // The campaign and branch of the open save once settled, and the scope of its scenario records: null until both are known.
    scope() {
      return scopeOf({ campaign: this.$store.getters['history/campaign'], RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // The scenario record of the race on the branch as the open save reads it (see readScenario).
    scenario() {
      return { ...readScenario(this.records ? this.records.repository : null, this.scope, this.tech), revision: this.scenarioRevision }
    },

    // The hypothetical choices as the lines resolve them: the record's, then the ones that could only be kept for this page. A choice cleared for this page only (null) hides the record's choice of its line.
    scenarioSelection() {
      const selection = { ...this.scenario.selection }

      Object.entries(this.heldChoices).forEach(([type, choice]) => {
        if (choice) {
          selection[type] = { ...choice, source: 'scenario' }
        } else {
          delete selection[type]
        }
      })

      return selection
    },

    // Each tech line's choice resolved against the open save: the level it designs with, whether that level is hypothetical, and a choice the save cannot honour as unresolved.
    techResolution() {
      return resolveChoices(this.tech, selectionOf(this.techChoice, this.scenarioSelection))
    },

    // The level of each tech line the page designs with: the race's choice when it is still researched, a hypothetical next tech the player picked, else the game's pick.
    techLevels() {
      return Object.fromEntries(TECH_LINES.map(({ type }) => [type, this.techResolution[type].level]))
    },

    techChoiceCount() {
      return TECH_LINES.filter(({ type }) => this.techLevels[type] && this.techLevels[type] !== this.tech.lines[type].pick).length
    },

    // The hypothetical tech lines the sets are designed with, as assumptions of their results; none when an engine of the race's own fixes the design.
    propulsionAssumptions() {
      return this.existingEngine ? EMPTY_LIST : hypotheticalOf(this.techResolution, PROPULSION_TECH_TYPES).assumptions
    },

    // The hypothetical tech the jump drive figures rest on: a hypothetical jump efficiency, and a hypothetical propulsion set whose size is the hull they start from (a saved class's own row is not marked).
    jumpAssumptions() {
      const own = hypotheticalOf(this.techResolution, [JUMP_EFFICIENCY_TECH_TYPE]).assumptions
      const row = this.selectedRow ? hypotheticalAssumptionsOf(Object.values(this.selectedRow.provenance)) : EMPTY_LIST

      return unique([own, row])
    },

    hypotheticalNotice() {
      const assumptions = unique([this.propulsionAssumptions, this.jumpAssumptions])

      return assumptions.length ? `Hypothetical results: ${assumptions.join('; ')}. Each figure built on it is marked assumed.` : ''
    },

    // Why a record's choices are not all applied or kept: a write that failed, a file that cannot be read or made at another game time or by another version.
    scenarioNotice() {
      const parts = [this.scenarioMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so the choice is kept for this page only.` : '', this.scenario.error ? `The scenario records cannot be read (${this.scenario.error.message}), so saved choices are not applied.` : '', ...this.scenario.notes.map((note) => note.reason)]

      return parts.filter(Boolean).join(' ')
    },

    // The briefs of the race in the campaign as the open save reads them (see readBriefs); one made at a later game time is listed apart and is not applied.
    briefRead() {
      return { ...readBriefs(this.records ? this.records.repository : null, this.scope), revision: this.briefRevision }
    },

    briefSaved() {
      return this.briefRead.entries.filter((entry) => !entry.ahead)
    },

    briefAhead() {
      return this.briefRead.entries.filter((entry) => entry.ahead)
    },

    // The saved brief the draft was opened from, at the revision it was opened at, or null for a new one (or one another tab deleted). The list's own revision is never used: it moves on with every read.
    briefEntry() {
      const listed = this.briefOrigin !== null && this.briefBaseline !== null && this.briefSaved.some((entry) => entry.uuid === this.briefOrigin)

      return listed ? { uuid: this.briefOrigin, revision: this.briefBaseline.revision, payload: this.briefBaseline.payload } : null
    },

    briefProblems() {
      return problemsOf(this.briefDraft)
    },

    briefCanSave() {
      return this.briefProblems.length === 0 && this.briefInvalid.length === 0
    },

    // Whether the draft says something else than the saved brief it was opened from (or than a blank one), or a field holds text that is not a figure yet.
    briefDirty() {
      return this.briefInvalid.length > 0 || !sameBrief(this.briefDraft, this.briefEntry ? this.briefEntry.payload : emptyBrief())
    },

    // Every row, the saved class and the sets, as the alternatives the brief is judged against.
    briefAlternatives() {
      const figures = this.selectedClass ? this.classFigures[this.selectedClass.id] || null : null

      return this.rows.map((row) => propulsionAlternative(row, row.pinned ? figures : null))
    },

    briefEvaluation() {
      return evaluateBrief(this.briefDraft, this.briefAlternatives)
    },

    briefNotice() {
      const parts = [this.briefMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so a brief cannot be kept.` : '', this.briefRead.error ? `The briefs cannot be read (${this.briefRead.error.message}).` : '', ...this.briefRead.notes.map((note) => note.reason)]

      return parts.filter(Boolean).join(' ')
    },

    techLines() {
      return TECH_LINES.map(({ type, label, figure }) => {
        const line = this.tech.lines[type]
        const resolved = this.techResolution[type]
        const text = (item) => `${figure ? `${figure(item)} · ` : ''}${item.name}`
        const format = (value) => this.count(value)
        const unresolved = resolved.unresolved

        return {
          type,
          label,
          selected: resolved.hypothetical || !resolved.level ? null : resolved.level.id,
          candidate: resolved.hypothetical ? resolved.level.id : null,
          hypothetical: resolved.hypothetical,
          next: line.next,
          nextText: line.next ? `${line.next.name} · ${candidateText(line.next, format)}` : '',
          unresolved,
          unresolvedText: unresolved ? `${label}: ${unresolved.name} is not used. ${unresolved.reason} The line uses ${line.pick ? `the game's pick, ${line.pick.name}` : 'no level, as none is researched'}.` : '',
          items: line.levels.map((level) => ({ value: level.id, text: `${text(level)}${level === line.pick ? ' · the game\'s pick' : ''}` })),
          candidates: line.candidates.map((item) => ({ value: item.id, text: `${text(item)} · ${candidateText(item, format)}` })),
        }
      })
    },

    // The choices a line could not use, in words.
    unresolvedChoices() {
      return this.techLines.filter((line) => line.unresolved).map((line) => ({ type: line.type, text: line.unresolvedText }))
    },

    // What the search designs with, or null without an engine and a fuel consumption tech.
    designTech() {
      const engine = this.techLevels[ENGINE_TECH_TYPE]
      const fuel = this.techLevels[FUEL_TECH_TYPE]

      if (!engine || !fuel) {
        return null
      }

      const level = (type, key, fallback) => (this.techLevels[type] ? this.techLevels[type][key] : fallback)

      return {
        engineTech: engine.info,
        fuelTech: fuel.info,
        thermalTech: level(THERMAL_TECH_TYPE, 'info', DEFAULTS.thermalTech),
        thermalCost: level(THERMAL_TECH_TYPE, 'info2', DEFAULTS.thermalCost),
        minThrust: level(MIN_THRUST_TECH_TYPE, 'info', DEFAULTS.minThrust),
        maxThrust: level(MAX_THRUST_TECH_TYPE, 'info', DEFAULTS.maxThrust),
        maxSize: level(MAX_ENGINE_SIZE_TECH_TYPE, 'info', DEFAULTS.maxSize),
      }
    },

    engineTechMissing() {
      return !this.designTech && !this.existingEngine
    },

    // The least and most engines of a set, the share of the ship they may take and the endpoint policy of the grid, as stored (the fields accept only valid values).
    engineLimits() {
      const { kind, min, max, share, exactLimits } = this.engineOptions

      return { kind, min, max, share, include: exactLimits ? 'limits' : 'grid' }
    },

    // The count and share fields as they stand, with a message for each that is wrong.
    sweepFields() {
      const draft = this.sweepDrafts

      return engineFields({ min: 'min' in draft ? draft.min : this.engineOptions.min, max: 'max' in draft ? draft.max : this.engineOptions.max, share: 'share' in draft ? draft.share : roundToDecimal(this.engineOptions.share * 100, 2) })
    },

    // The values the search sweeps, or null when nothing is searched. The preview and the search read this one object.
    sweep() {
      if (!this.ready || (!this.existingEngine && !this.designTech)) {
        return null
      }

      return engineSweep({ tech: this.designTech, engine: this.existingEngine, minCount: this.engineLimits.min, maxCount: this.engineLimits.max, include: this.engineLimits.include })
    },

    // The sweep in words and figures: a line for each domain with its endpoints and count, the notes on bounds between steps, and the combinations.
    sweepPreview() {
      const sweep = this.sweep

      if (!sweep) {
        return null
      }

      if (!sweep.ok) {
        return { ok: false, problems: sweep.problems, lines: [], notes: [], combinations: null }
      }

      const format = (value) => this.count(value, 3)
      const lines = []

      const add = (key, label, noun, domain, unit, wrap) => {
        const described = describeSweep(domain, { unit, format })

        lines.push({ key, label, detail: described.text, notes: described.notes, count: described.count, summary: `${this.count(described.count)} ${noun} (${wrap(format(described.first))} to ${wrap(format(described.last))}${described.unit ? ` ${described.unit}` : ''})` })
      }

      if (sweep.sizes) {
        add('sizes', 'Engine sizes', 'engine sizes', sweep.sizes, this.sweepUnit === 'tons' ? 'tons' : undefined, (text) => text)
        add('thrusts', 'Engine thrust', 'thrust modifiers', sweep.thrusts, undefined, (text) => `× ${text}`)
      }

      add('counts', 'Engine counts', 'engine counts', sweep.counts, undefined, (text) => text)

      return { ok: true, problems: [], lines, notes: lines.flatMap((line) => line.notes), combinations: sweep.combinations }
    },

    sweepSummaryText() {
      const preview = this.sweepPreview

      return preview && preview.ok ? `Sweep: ${preview.lines.map((line) => line.summary).join(' × ')}${preview.lines.length > 1 ? ` = up to ${this.count(preview.combinations)} combinations` : ''}` : ''
    },

    // What stops the search: a message for each count or share field that is wrong, and the reasons the engine grid cannot be built.
    sweepErrorText() {
      const labels = { min: 'Fewest engines', max: 'Most engines', share: 'Share' }
      const messages = Object.entries(this.sweepFields.errors).map(([key, message]) => `${labels[key]}: ${message}`)

      if (this.sweep && !this.sweep.ok) {
        messages.push(...this.sweep.problems)
      }

      return messages.join(' ')
    },

    sweepHasErrors() {
      return this.sweepErrorText !== ''
    },

    goal() {
      const value = finiteNumber(this.range[this.rangeMode])

      if (!(value > 0)) {
        return null
      }

      return this.rangeMode === 'range' ? { mode: 'range', value: value * 1e9 } : { mode: 'endurance', value: value * 24 }
    },

    goalText() {
      return this.goal ? (this.goal.mode === 'range' ? ` with a range of ${this.count(this.goal.value / 1e9, 2)} bn km` : ` with an endurance of ${this.count(this.goal.value / 24, 1)} days`) : ''
    },

    // Everything the search depends on, or null while it can't run.
    searchInput() {
      if (!this.ready || !this.hullReady || !this.speedReady || (!this.existingEngine && !this.designTech) || this.sweepHasErrors) {
        return null
      }

      return {
        hullHS: this.hullHS,
        speed: this.speed,
        fraction: this.fraction,
        goal: this.goal,
        kind: this.engineLimits.kind,
        minCount: this.engineLimits.min,
        maxCount: this.engineLimits.max,
        share: this.engineLimits.share,
        include: this.engineLimits.include,
        sweep: this.sweep,
        tech: this.designTech,
        tanks: this.tanks,
        engine: this.existingEngine,
        axes: this.efficientAxes,
        engineTechName: this.techLevels[ENGINE_TECH_TYPE] ? this.techLevels[ENGINE_TECH_TYPE].componentName : '',
      }
    },

    // The saved class as a row, from the engines it mounts.
    pinnedRow() {
      const shipClass = this.selectedClass

      if (!shipClass) {
        return null
      }

      const power = shipClass.enginePower
      const burnFull = shipClass.burnFull
      const fuelPerEph = power > 0 ? burnFull / power : 0
      const speed = classSpeed({ enginePower: power, sizeHS: shipClass.sizeHS })
      const propulsionHS = shipClass.engineHS + shipClass.tankHS
      const commercial = shipClass.engines.filter((engine) => engine.commercial).length
      const heat = sumBy(shipClass.engines, (engine) => engine.thermal * engine.count)
      const single = shipClass.engines.length === 1 ? shipClass.engines[0] : null
      const check = power > 0 ? { stored: shipClass.stored.speed, matches: shipClass.stored.speed === speed } : null
      const tankCost = sumBy(shipClass.tanks, (tank) => tank.cost * tank.count)

      const provenance = classProvenance({
        shipClass,
        power,
        speed,
        check,
        burn: burnFull,
        rangeKm: fullPowerRangeKm({ fuel: shipClass.fuel, enginePower: power, fuelPerEph, speed }),
        hours: enduranceHours({ fuel: shipClass.fuel, enginePower: power, fuelPerEph, fraction: this.fraction }),
        fraction: this.fraction,
      })

      return {
        key: 'class',
        pinned: true,
        rank: null,
        name: shipClass.name,
        detail: `Saved class: ${this.count(shipClass.engineHS, 2)} HS of engines, ${this.count(shipClass.tankHS, 2)} HS of tanks`,
        count: shipClass.engineCount,
        thrust: single ? single.thrust : null,
        power,
        fuelPerEph,
        propulsionHS,
        tons: propulsionHS * TONS_PER_HS,
        share: shipClass.sizeHS > 0 ? propulsionHS / shipClass.sizeHS : 0,
        speed: valueOrNull(provenance.speed),
        check,
        burn: valueOrNull(provenance.burn),
        rangeBn: valueOrNull(provenance.rangeBn),
        enduranceDays: valueOrNull(provenance.enduranceDays),
        cost: valueOrNull(provenance.cost),
        crew: sumBy(shipClass.engines, (engine) => engine.crew * engine.count) + sumBy(shipClass.tanks, (tank) => tank.crew * tank.count),
        type: !shipClass.engines.length ? '—' : commercial === shipClass.engines.length ? 'Commercial' : commercial ? 'Mixed' : 'Military',
        thermal: thermalSignature({ enginePower: heat, stealthRating: 1, fraction: this.fraction, sizeHS: shipClass.sizeHS }),
        cards: shipClass.engines.map((engine) => engineCard(engine, engine.name, engine.count)),
        tanks: shipClass.tanks,
        tankHS: shipClass.tankHS,
        tankCost,
        litres: shipClass.fuel,
        totalHS: shipClass.sizeHS,
        provenance,
      }
    },

    // The saved class first, then the ranked sets.
    rows() {
      const sets = this.result ? this.result.sets.map((set, index) => this.rowOfSet(set, index + 1)) : EMPTY_LIST

      return this.pinnedRow ? [this.pinnedRow, ...sets] : sets
    },

    selectedRow() {
      return this.rows.find((row) => row.key === this.selectedKey) || this.rows.find((row) => !row.pinned) || this.rows[0] || null
    },

    // The chosen set as the Fuel tanks and Burn and endurance heads name it.
    selectedSetLabel() {
      const row = this.selectedRow

      return row ? `${row.name}${row.pinned ? '' : ` × ${this.count(row.count)}`}` : ''
    },

    // What the figures of the chosen row rest on, one entry a figure with its result.
    basisRows() {
      const row = this.selectedRow

      return row ? [...BASIS_COLUMNS.map(([label, key]) => ({ label, result: row.provenance[key] })), ...(row.provenance.tanks ? [{ label: 'Fuel tanks (HS)', result: row.provenance.tanks }] : [])] : EMPTY_LIST
    },

    // The finished hull's size without the jump drives the saved class mounts, as the game's automatic design starts from.
    jumpHullHS() {
      return this.selectedRow ? Math.max(0, this.selectedRow.totalHS - (this.selectedClass ? this.selectedClass.driveHS : 0)) : 0
    },

    jumpDrives() {
      const efficiency = this.techLevels[JUMP_EFFICIENCY_TECH_TYPE]

      if (!this.selectedRow || !efficiency || !(this.jumpHullHS > 0)) {
        return null
      }

      const sizeTech = this.tech.fixed[DEFAULT_SQUADRON_SIZE_TECH]
      const radiusTech = this.tech.fixed[DEFAULT_SQUADRON_RADIUS_TECH]
      const drives = [false, true].map((commercial) => ({ name: commercial ? 'Commercial' : 'Military', ...selfJumpDrive({ hullHS: this.jumpHullHS, efficiency: efficiency.info, squadronSizeCost: sizeTech ? sizeTech.info2 : 1, squadronRadiusCost: radiusTech ? radiusTech.info2 : 1, commercial }) }))

      return drives
    },

    jumpSquadron() {
      const names = [DEFAULT_SQUADRON_SIZE_TECH, DEFAULT_SQUADRON_RADIUS_TECH].map((id) => (this.tech.fixed[id] ? this.tech.fixed[id].name : null)).filter(Boolean)

      return names.join('; ') || 'not in the save'
    },

    jumpReference() {
      const names = [JUMP_EFFICIENCY_TECH_TYPE, SQUADRON_SIZE_TECH_TYPE, SQUADRON_RADIUS_TECH_TYPE].map((type) => (this.techLevels[type] ? this.techLevels[type].name : null)).filter(Boolean)

      return names.join('; ') || 'none researched'
    },

    driveList() {
      return this.selectedClass.drives.map((drive) => `${drive.count} × ${drive.name} (${this.count(drive.sizeHS, 2)} HS)`).join(', ')
    },

    // Full power, half power and the cruise share, for the chosen set.
    burnLevels() {
      const row = this.selectedRow

      if (!row) {
        return EMPTY_LIST
      }

      return [...new Set([1, 0.5, this.fraction])].sort((a, b) => b - a).map((fraction) => {
        const burn = isAvailable(row.provenance.burn) ? burnPerHour({ enginePower: row.power, fuelPerEph: row.fuelPerEph, fraction }) : null
        const days = isAvailable(row.provenance.enduranceDays) ? enduranceHours({ fuel: row.litres, enginePower: row.power, fuelPerEph: row.fuelPerEph, fraction }) / 24 : null

        return {
          fraction,
          speed: row.speed === null ? null : Math.floor(row.speed * fraction),
          burn,
          days,
          rangeBn: row.rangeBn,
          provenance: { burn: levelResult(row.provenance.burn, 'design.burnPerHour', burn, 'L/h', fraction), days: levelResult(row.provenance.enduranceDays, 'design.enduranceHours', days, 'days', fraction), rangeBn: row.provenance.rangeBn },
        }
      })
    },

    // What an empty result says. Only a search that explored its whole domain can say that nothing reaches the targets; one that stopped early has found nothing so far.
    emptyNotice() {
      const result = this.result

      if (!result || result.sets.length || this.searching) {
        return null
      }

      if (result.run.incomplete) {
        return 'so-far'
      }

      return result.packages && result.packages.infeasible ? 'no-package' : 'unreachable'
    },

    // The note of a tile with no set.
    noSetNote() {
      return this.searching ? 'Searching…' : this.result && this.result.run.incomplete ? 'No set found so far' : 'No set meets the targets'
    },

    tiles() {
      const result = this.result
      const none = { value: '—', note: this.noSetNote }
      const partial = result && result.run.incomplete ? ' · best so far' : ''
      const describe = (set) => `${this.count(set.count)} × ${this.setName(set)}${partial}`
      const tile = (label, set, figure) => ({ label, ...(set ? { value: figure(set), note: describe(set) } : none) })
      const tech = this.designTech
      const cheapest = tile('Cheapest set', result && result.cheapest, (set) => `${this.count(set.cost, 1)} BP`)

      if (result && result.cheapest) {
        const cost = setProvenance(result.cheapest, this.fraction, this.propulsionAssumptions).cost

        Object.assign(cheapest, { icon: STATUS_MARKS[cost.status].icon, title: `${cheapest.value}. ${describeResult(cost)}`, note: `${cheapest.note} · cost ${cost.status}` })
      }

      return [
        tile('Fastest set within the share', result && result.fastest, (set) => `${this.count(set.speed)} km/s`),
        tile('Lightest set for the targets', result && result.lightest, (set) => `${this.count(set.propulsionHS, 2)} HS (${this.count(set.tons)} tons)`),
        cheapest,
        { label: 'Engine and fuel tech', value: tech ? `${this.count(tech.engineTech, 2)} EP/HS` : '—', note: tech ? `Fuel ${tech.fuelTech} L per EP hour · thrust × ${tech.minThrust} to × ${tech.maxThrust}${this.propulsionAssumptions.length ? ' · hypothetical level' : ''}` : 'None researched' },
      ]
    },

    setHeaders() {
      return [
        { text: '#', value: 'rank', align: 'end', width: 48 },
        { text: 'Engine', value: 'name' },
        { text: 'Count', value: 'count', align: 'end' },
        { text: 'Thrust', value: 'thrust', align: 'end' },
        { text: 'Power (EP)', value: 'power', align: 'end' },
        { text: 'L / EP hour', value: 'fuelPerEph', align: 'end' },
        { text: 'Propulsion HS', value: 'propulsionHS', align: 'end' },
        { text: 'Share', value: 'share', align: 'end' },
        { text: 'Speed (km/s)', value: 'speed', align: 'end' },
        { text: 'Burn (L/h)', value: 'burn', align: 'end' },
        { text: 'Range (bn km)', value: 'rangeBn', align: 'end' },
        { text: 'Endurance (d)', value: 'enduranceDays', align: 'end' },
        { text: 'BP', value: 'cost', align: 'end' },
        { text: 'Crew', value: 'crew', align: 'end' },
        { text: 'Type', value: 'type' },
        { text: '', value: 'data-table-expand', sortable: false },
      ]
    },

    tradeFrontier() {
      return this.result ? (this.tradeMetric === 'speed' ? this.result.pareto.speed : this.result.pareto.range) : EMPTY_LIST
    },

    tradeRows() {
      return this.tradeFrontier.map((set) => {
        const provenance = setProvenance(set, this.fraction, this.propulsionAssumptions)

        return { key: `${set.engine.id || `${set.engine.sizeHS}-${set.engine.thrust}`}-${set.count}`, set, share: set.share, speed: valueOrNull(provenance.speed), rangeBn: valueOrNull(provenance.rangeBn), propulsionHS: set.propulsionHS, cost: valueOrNull(provenance.cost), name: this.setName(set), count: set.count, type: set.commercial ? 'Commercial' : 'Military', provenance }
      })
    },

    // The saved class as a point of the chart.
    tradeSaved() {
      return this.pinnedRow && this.pinnedRow.power > 0 ? this.pinnedRow : null
    },

    tradeHeaders() {
      return [
        { text: 'Engine', value: 'name' },
        { text: 'Count', value: 'count', align: 'end' },
        { text: 'Type', value: 'type' },
        { text: 'Share', value: 'share', align: 'end' },
        { text: 'Propulsion HS', value: 'propulsionHS', align: 'end' },
        { text: 'Speed (km/s)', value: 'speed', align: 'end' },
        { text: 'Range (bn km)', value: 'rangeBn', align: 'end' },
        { text: 'BP', value: 'cost', align: 'end' },
      ]
    },

    tradeTable() {
      return this.tradeSaved ? [this.tradeSaved, ...this.tradeRows] : this.tradeRows
    },

    tradeChart() {
      const speed = this.tradeMetric === 'speed'
      const { military, commercial, saved } = this.kindColors
      const value = (row) => (speed ? row.speed : row.rangeBn)
      const plotted = (rows) => rows.filter((row) => value(row) !== null)
      const point = (row, label) => ({ x: roundToDecimal(row.share * 100, 2), y: roundToDecimal(value(row), speed ? 0 : 2), label })
      const series = (label, color, data, style = 'circle') => ({ label, data, showLine: false, pointRadius: 5, pointHoverRadius: 8, pointStyle: style, backgroundColor: color, borderColor: color })
      const status = (result) => STATUS_MARKS[result.status].label.toLowerCase()
      const shown = (figure, digits, unit, result) => (figure === null ? `${unit} unavailable` : `${this.count(figure, digits)} ${unit} (${status(result)})`)
      const figures = (row) => `${this.count(row.propulsionHS, 2)} HS, ${shown(row.speed, 0, 'km/s', row.provenance.speed)}, ${shown(row.rangeBn, 2, 'bn km', row.provenance.rangeBn)}, ${shown(row.cost, 1, 'BP', row.provenance.cost)}`
      const describe = (row) => `${row.count} × ${row.name}: ${figures(row)}`
      const datasets = [
        series('Military', military, plotted(this.tradeRows.filter((row) => row.type === 'Military')).map((row) => point(row, describe(row)))),
        series('Commercial', commercial, plotted(this.tradeRows.filter((row) => row.type === 'Commercial')).map((row) => point(row, describe(row)))),
      ]

      if (this.tradeSaved && value(this.tradeSaved) !== null) {
        const row = this.tradeSaved

        datasets.push(series('Saved class', saved, [point(row, `${row.name} (saved): ${figures(row)}`)], 'rectRot'))
      }

      return {
        data: { labels: [], datasets },
        options: {
          interaction: { mode: 'nearest', intersect: true },
          scales: {
            x: { type: 'linear', min: 0, title: { display: true, text: 'Share of the ship the propulsion takes (%)' } },
            y: { type: 'linear', title: { display: true, text: speed ? 'Speed (km/s)' : 'Range (bn km)' } },
          },
          plugins: {
            guides: { crosshair: false },
            tooltip: { callbacks: { title: () => '', label: (item) => item.raw.label } },
          },
        },
      }
    },

    // The axes the sets are compared on: the ones picked when two or more are, else none (one axis compares nothing), and then the search keeps no comparison.
    efficientAxes() {
      const axes = axesOf(this.paretoAxes)

      return axes.length >= 2 ? axes : EMPTY_LIST
    },

    // One control for each axis offered, with whether it is off, least or most.
    paretoChoices() {
      return Object.entries(PARETO_AXES).map(([key, axis]) => ({ key, label: axis.label, pick: this.paretoAxes[key] || 'off' }))
    },

    // The comparison of the latest result, null when its search kept none.
    efficient() {
      return this.result && this.result.efficient ? this.result.efficient : null
    },

    // Whether the comparison is provisional: a set not yet compared may beat these, or the comparison was cut at its limit.
    efficientProvisional() {
      return this.efficient !== null && this.efficient.status === 'provisional'
    },

    efficientNote() {
      return this.efficient ? describeFront(this.efficient, (value) => this.count(value)) : ''
    },

    // What the table says when the comparison holds no set: nothing met the targets, the search stopped before it found one, or every set that met them lacks a figure that was picked.
    efficientEmpty() {
      return this.efficient ? describeEmpty(this.efficient, (value) => this.count(value)) : ''
    },

    // The columns follow the axes of the result shown, not the ones picked since, which a search that is running has not reached.
    efficientHeaders() {
      const axes = this.efficient ? this.efficient.axes : EMPTY_LIST

      return [
        { text: 'Engine', value: 'name' },
        { text: 'Count', value: 'count', align: 'end' },
        { text: 'Type', value: 'type' },
        ...axes.map(({ key }) => ({ text: PARETO_COLUMNS[key][0], value: PARETO_COLUMNS[key][1], align: 'end' })),
        { text: 'Same figures', value: 'alternativeCount', align: 'end' },
        { text: '', value: 'data-table-expand', sortable: false },
      ]
    },

    efficientRows() {
      if (!this.efficient) {
        return EMPTY_LIST
      }

      return this.efficient.members.map((member) => {
        const named = member.alternatives.map(({ set }) => `${this.count(set.count)} × ${this.setName(set)}`)

        return { ...this.rowOfSet(member.set, null), key: member.name, payload: member.set.hullHS, alternativeCount: member.alternativeCount, alternatives: named, alternativesMore: member.alternativeCount - named.length, alternativeIds: member.identities.slice(named.length, named.length + ALTERNATIVE_IDS_SHOWN) }
      })
    },

    // A link names the saved class and the race's own engine the page is on.
    linkQuery() {
      return this.ready ? linkTo.propulsion({ class: this.selectedClass ? this.selectedClass.id : null, engine: this.existingEngine ? this.existingEngine.id : null }).query : null
    },

    linkLabel() {
      return this.selectedClass ? this.selectedClass.name : this.existingEngine ? this.existingEngine.name : ''
    },
  },
  watch: {
    context() {
      this.searchSlot.invalidate(TERMINATION.SAVE_CHANGED)
      this.startSearch(this.searchInput)
      this.sweepDrafts = {}
      this.heldChoices = {}
      this.scenarioMessage = ''
      this.clearBrief()
    },

    database() {
      this.searchSlot.invalidate(TERMINATION.SAVE_CHANGED)
      this.startSearch(this.searchInput)
      this.heldChoices = {}
      this.scenarioMessage = ''
      this.clearBrief()
    },

    // The briefs are read again (the records load after the page, a save was made, a write landed): the brief the race last opened is restored once it is there.
    briefSaved() {
      this.restoreBrief()
    },

    searchInput: {
      immediate: true,
      handler(input) {
        this.startSearch(input)
      },
    },

    targetOrphaned(orphaned) {
      if (orphaned) {
        this.target = { kind: 'tonnage', value: 5000 }
      }
    },

    rows(rows) {
      if (!rows.some((row) => row.key === this.selectedKey)) {
        this.selectedKey = null
      }
    },
  },
  beforeCreate() {
    // Not reactive: the run slot holds live generators, and the immediate `searchInput` watcher needs it before `data` is read.
    this.searchSlot = createRunSlot()
  },
  beforeDestroy() {
    clearTimeout(this.searchTimer)
    this.searchSlot.invalidate(TERMINATION.CLOSED)
  },
  methods: {
    // The class the query names becomes the hull; the race's own engine is searched alone. A key the query leaves out means no engine, and the hull as it is.
    applyLink(query) {
      const classId = queryId(query.class)

      this.engineId = queryId(query.engine)

      if (classId) {
        this.target = { kind: 'class', value: classId }
      }
    },

    setHullTons(value) {
      this.target = { kind: 'tonnage', value: finiteNumber(value) }
    },

    pickClass(id) {
      this.target = id ? { kind: 'class', value: id } : { kind: 'tonnage', value: Math.max(1, Math.round(this.hullHS * TONS_PER_HS)) }
    },

    setSpeed(value) {
      this.speed = finiteNumber(value)
    },

    setGoal(value) {
      this.range = { ...this.range, [this.rangeMode]: Math.max(0, finiteNumber(value)) }
    },

    setCruise(value) {
      const percent = finiteNumber(value)

      if (percent > 0 && percent <= 100) {
        this.fraction = percent / 100
      }
    },

    setEngineOption(key, value) {
      this.engineOptions = { ...this.engineOptions, [key]: value }
    },

    // The text a count or share field shows: what was typed while it is not accepted, else the stored value (the share in percent).
    engineFieldText(key) {
      if (key in this.sweepDrafts) {
        return this.sweepDrafts[key]
      }

      return key === 'share' ? roundToDecimal(this.engineOptions.share * 100, 2) : this.engineOptions[key]
    },

    // A count or share field as typed. Every field is read together: when all are right they are stored and the drafts dropped; otherwise the stored values stay, each wrong field shows its message and the search does not run.
    setEngineNumber(key, value) {
      this.sweepDrafts = { ...this.sweepDrafts, [key]: value }

      const fields = this.sweepFields

      if (fields.ok) {
        this.engineOptions = { ...this.engineOptions, min: fields.min, max: fields.max, share: fields.share }
        this.sweepDrafts = {}
      }
    },

    // A researched level other than the game's pick is remembered; the pick itself is forgotten, so a later research moves it on. A line has one choice: a researched level replaces a hypothetical one.
    setTech(type, id) {
      const choice = { ...this.techChoice }

      if (id === (this.tech.lines[type].pick || {}).id) {
        delete choice[type]
      } else {
        choice[type] = id
      }

      this.techChoice = choice

      return this.dropScenarioChoice(type)
    },

    // A hypothetical next tech of the line (a candidate of the research graph), kept in the scenario record of the race on the branch; null clears it. When the record cannot be written the choice holds for this page only, and the notice says why.
    async chooseNextTech(type, id) {
      const techId = id === undefined ? null : id

      if (techId === null && !this.scenario.selection[type] && !this.heldChoices[type]) {
        return
      }

      if (techId !== null) {
        const choice = { ...this.techChoice }

        delete choice[type]
        this.techChoice = choice
      }

      const outcome = await saveChoice(this.records ? this.records.repository : null, this.scope, this.tech, this.scenario, { typeId: type, techId })
      const held = { ...this.heldChoices }

      if (outcome.ok) {
        delete held[type]
        this.scenarioMessage = ''
        this.scenarioRevision += 1
      } else if (techId === null) {
        held[type] = null
        this.scenarioMessage = outcome.message
      } else {
        const candidate = this.tech.lines[type].candidates.find((item) => item.id === techId)

        held[type] = { techId, name: candidate ? candidate.name : `tech ${techId}` }
        this.scenarioMessage = outcome.message
      }

      this.heldChoices = held
    },

    // Removes the hypothetical choice of a line, from the record and from this page.
    async dropScenarioChoice(type) {
      if (this.heldChoices[type]) {
        const held = { ...this.heldChoices }

        delete held[type]
        this.heldChoices = held
      }

      if (this.scenario.selection[type]) {
        await this.chooseNextTech(type, null)
      }
    },

    // Gives up a choice the save cannot honour, wherever it is kept.
    forgetChoice(type) {
      const choice = { ...this.techChoice }

      delete choice[type]
      this.techChoice = choice

      return this.dropScenarioChoice(type)
    },

    // The engine as the game names a design: the tech's component name, two spaces and EP with the power, with Commercial in front for a commercial engine. The race's own engines keep their names.
    engineName(engine, techName) {
      if (engine.name) {
        return engine.name
      }

      const name = `${techName}  EP${engine.power}`

      return engine.commercial ? `Commercial ${name}` : name
    },

    setName(set) {
      return this.engineName(set.engine, this.result ? this.result.input.engineTechName : '')
    },

    rowOfSet(set, rank) {
      const name = this.setName(set)
      const provenance = setProvenance(set, this.fraction, this.propulsionAssumptions)

      return {
        key: `${set.engine.id || `${set.engine.sizeHS}-${set.engine.thrust}`}-${set.count}`,
        pinned: false,
        rank,
        set,
        name,
        detail: `${this.count(set.engine.sizeHS, 2)} HS each, ${set.tankHS > 0 ? `${this.count(set.tankHS, 2)} HS of tanks` : 'no tanks'}`,
        count: set.count,
        thrust: set.engine.thrust,
        power: set.power,
        fuelPerEph: set.engine.fuelPerEph,
        propulsionHS: set.propulsionHS,
        tons: set.tons,
        share: set.share,
        speed: valueOrNull(provenance.speed),
        check: null,
        burn: valueOrNull(provenance.burn),
        rangeBn: valueOrNull(provenance.rangeBn),
        enduranceDays: valueOrNull(provenance.enduranceDays),
        cost: valueOrNull(provenance.cost),
        crew: set.crew,
        type: set.commercial ? 'Commercial' : 'Military',
        thermal: set.thermal,
        cards: [engineCard(set.engine, name, set.count)],
        tanks: set.tanks,
        tankPackage: set.tankPackage,
        tankHS: set.tankHS,
        tankCost: set.tanks.reduce((total, tank) => total + tank.cost * tank.count, 0),
        litres: set.litres,
        totalHS: set.totalHS,
        provenance,
      }
    },

    // Turns an axis of the comparison off or sets its direction; the search runs again for the new axes.
    setParetoAxis(key, pick) {
      const next = { ...this.paretoAxes }

      if (pick === 'off') {
        delete next[key]
      } else {
        next[key] = pick
      }

      this.paretoAxes = next
    },

    // A click picks the set the panels below show and opens or closes its detail, as clicking a row with details does on the other pages.
    selectRow(row, { expand, isExpanded }) {
      this.selectedKey = row.key
      expand(!isExpanded)
    },

    rowClass(row) {
      return this.selectedRow && row.key === this.selectedRow.key ? 'is-selected-row' : ''
    },

    // The saved class stays on top whatever the sort; the sets are sorted by the column, ties in rank order.
    sortRows(items, sortBy, sortDesc) {
      const [by] = sortBy
      const pinned = items.filter((item) => item.pinned)
      const rest = items.filter((item) => !item.pinned)

      if (by) {
        const direction = sortDesc[0] ? -1 : 1

        rest.sort((a, b) => {
          const x = a[by]
          const y = b[by]

          if (x === y) {
            return (a.rank || 0) - (b.rank || 0)
          }

          if (x === null || y === null) {
            return x === null ? 1 : -1
          }

          return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : finiteNumber(x) - finiteNumber(y)) * direction
        })
      }

      return [...pinned, ...rest]
    },

    percent(share) {
      return `${this.count(share * 100, share < 0.1 ? 2 : 1)}%`
    },

    // Litres an hour, with decimals for a small burn.
    litres(value) {
      return this.count(value, value < 10 ? 2 : value < 100 ? 1 : 0)
    },

    statusMeaning(status) {
      return STATUS_MARKS[status].meaning
    },

    // What the tanks of a designed row are: proved the lightest package for the litres the set asks for, or only a package that holds them, with the reason the proof stopped.
    tankPackageCell(row) {
      return !row.tankPackage ? '' : row.tankPackage.status === 'optimal' ? 'proved lightest' : `not proved: ${row.tankPackage.reason}`
    },

    tankPackageText(row) {
      const { status, requestedLitres, excessLitres } = row.tankPackage
      const litres = `${this.count(requestedLitres)} L`

      return status === 'optimal' ? `The lightest package that holds the ${litres} this set needs, proved against every other combination of the tanks; ${this.count(excessLitres)} L of it is spare. The mark reads assumed because the game has no packing rule.` : `A package that holds the ${litres} this set needs, but not proved the lightest, so the mark reads estimated. The basis above names why.`
    },

    // A result's rule note, assumptions and missing inputs on one line.
    basisText(result) {
      const parts = [result.rule.note]

      if (result.assumptions.length) {
        parts.push(`assumes ${result.assumptions.join('; ')}`)
      }

      if (result.inputs.missing.length) {
        parts.push(`missing ${result.inputs.missing.join(', ')}`)
      }

      return parts.join(' · ')
    },

    // The saved class and every set listed, with the status beside each figure and the rules, assumptions and missing inputs of the row, so a copy keeps what the table showed. An unavailable figure is left empty, never 0.
    downloadCsv() {
      const header = ['Row', 'Engine', 'Count', 'Thrust', 'Power (EP)', 'L / EP hour', 'Propulsion HS', 'Share (%)', ...BASIS_COLUMNS.flatMap(([label]) => [label, `${label} status`]), 'Crew', 'Type', 'Tank package', 'Rules', 'Assumptions', 'Missing inputs', 'Search']
      const search = !this.result ? '' : `${this.result.run.incomplete ? `incomplete (${this.result.run.termination})` : 'complete'}: ${countText(this.result.counts)}`
      const lines = this.rows.map((row) => {
        const basis = BASIS_COLUMNS.map(([, key]) => row.provenance[key])
        const fields = basis.map(exportFields)
        const results = row.provenance.tanks ? [...basis, row.provenance.tanks] : basis

        return [row.pinned ? 'Saved class' : row.rank, row.name, row.count, row.thrust === null ? '' : row.thrust, row.power, row.fuelPerEph, row.propulsionHS, roundToDecimal(row.share * 100, 4), ...fields.flatMap((field) => [field.value, field.status]), row.crew, row.type, this.tankPackageCell(row), unique(results.map((result) => [result.rule.id])).join('; '), unique(results.map((result) => result.assumptions)).join('; '), unique(results.map((result) => result.inputs.missing)).join('; '), row.pinned ? '' : search]
      })

      const csv = [header, ...lines].map((line) => line.map((value) => csvCell(value)).join(',')).join('\n')
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      link.download = 'propulsion-sets.csv'
      link.click()
      URL.revokeObjectURL(link.href)
    },

    // Ends the search running and, for an input that can be searched, starts it after a short wait. An input that changes meanwhile takes over.
    startSearch(input) {
      clearTimeout(this.searchTimer)
      this.searchSlot.invalidate(TERMINATION.INPUT_CHANGED)
      this.running = false
      this.searchError = ''

      if (!input) {
        this.result = null
        this.searchSlot.clear()
        this.searching = false

        return
      }

      this.searching = true
      this.searchTimer = setTimeout(() => this.runSearch(input), SEARCH_DELAY_MS)
    },

    // Stops the search running where it is; the best sets so far stay, labelled incomplete.
    cancelSearch() {
      this.searchSlot.cancel()
    },

    // Runs the search of `input` a slice at a time, then keeps its outcome with the input it was for. A run that is replaced, or whose save changed, is dropped without a word.
    async runSearch(input) {
      try {
        const run = this.searchSlot.start(propulsionRun(input))

        this.progress = 0
        this.running = true

        while (run.running) {
          run.advance(RESPONSIVENESS.sliceMs)
          this.progress = run.progress

          if (run.running) {
            await nextTask()
          }

          if (!this.searchSlot.isCurrent(run)) {
            return
          }
        }

        const outcome = this.searchSlot.publish(run)

        if (!outcome) {
          return
        }

        this.running = false
        this.searching = false

        if (outcome.error) {
          this.searchError = outcome.error

          return
        }

        const text = describeOutcome(outcome, (value) => this.count(value))

        this.result = outcome.result ? Object.freeze({ ...outcome.result, input, run: Object.freeze({ status: outcome.status, incomplete: outcome.incomplete, termination: outcome.termination, elapsedMs: outcome.elapsedMs, text }) }) : null
      } catch (error) {
        this.running = false
        this.searching = false
        this.searchError = error.message
      }
    },

    // Empties the draft and what hangs on it. The brief the race last opened stays remembered, so the briefs of the next save restore it.
    clearBrief() {
      this.briefDraft = emptyBrief()
      this.briefOrigin = null
      this.briefBaseline = null
      this.briefInvalid = []
      this.briefOpening += 1
      this.briefPreview = null
      this.briefAccepted = []
      this.briefMessage = ''
      this.briefConflict = null
      this.pendingBrief = null
    },

    // Opens a saved brief (target.uuid) or a blank one (target.blank) as the draft.
    enterBrief(target) {
      const entry = target.blank ? null : this.briefSaved.find((item) => item.uuid === target.uuid) || null

      this.clearBrief()
      this.briefOrigin = entry ? entry.uuid : null
      this.briefBaseline = entry ? { revision: entry.revision, payload: normaliseBrief(entry.payload) } : null
      this.briefDraft = entry ? normaliseBrief(entry.payload) : emptyBrief()
      this.briefSelected = entry ? entry.uuid : null
    },

    // Opens the target at once, or asks first when the draft has changes that would be lost.
    requestBrief(target) {
      if (this.briefDirty) {
        this.pendingBrief = target
      } else {
        this.enterBrief(target)
      }
    },

    // Opens the saved brief `uuid` (none or null opens a blank one). A brief that is not listed as applying to this save, one made at a later game time among them, is not opened.
    selectBrief(uuid) {
      if (uuid && !this.briefSaved.some((entry) => entry.uuid === uuid)) {
        return
      }

      this.requestBrief(uuid ? { uuid } : { blank: true })
    },

    newBrief() {
      this.requestBrief({ blank: true })
    },

    discardPendingBrief() {
      if (this.pendingBrief) {
        this.enterBrief(this.pendingBrief)
      }
    },

    keepPendingBrief() {
      this.pendingBrief = null
    },

    // Opens the brief the race last had open, once its briefs are read and nothing has been opened or typed.
    restoreBrief() {
      if (this.briefOrigin === null && !this.briefDirty && this.briefSelected && this.briefSaved.some((entry) => entry.uuid === this.briefSelected)) {
        this.enterBrief({ uuid: this.briefSelected })
      }
    },

    setBriefField(key, value) {
      this.briefDraft = withField(this.briefDraft, key, value)
    },

    // The fields the panel holds text in that is not a figure: the draft cannot be kept while there are any, and they count as changes.
    setBriefInvalid(keys) {
      this.briefInvalid = keys
    },

    setBriefAxes(axes) {
      this.briefDraft = withAxes(this.briefDraft, axes)
    },

    // Lists what a preset would change in the draft, every empty field ticked and every field that has a value not, and changes nothing.
    previewBriefPreset(key) {
      this.briefPreview = previewPreset(this.briefDraft, key)
      this.briefAccepted = additionsOf(this.briefPreview)
      this.briefMessage = ''
    },

    toggleBriefItem(key) {
      this.briefAccepted = this.briefAccepted.includes(key) ? this.briefAccepted.filter((item) => item !== key) : [...this.briefAccepted, key]
    },

    // Writes the ticked fields of the preview to the draft. The saved brief changes only on Save.
    applyBriefPreview() {
      if (!this.briefPreview) {
        return
      }

      const outcome = applyPreview(this.briefDraft, this.briefPreview, this.briefAccepted)

      this.briefDraft = outcome.draft
      this.briefMessage = outcome.applied.length ? `${outcome.applied.length} ${outcome.applied.length === 1 ? 'field' : 'fields'} of the ${this.briefPreview.label} preset applied to the draft. The saved brief stays as it is until Save.` : 'No field was ticked, so the draft is unchanged.'
      this.briefPreview = null
      this.briefAccepted = []
    },

    cancelBriefPreview() {
      this.briefPreview = null
      this.briefAccepted = []
    },

    // Keeps the draft: a new record, or the saved brief it was opened from. A saved brief that changed meanwhile is not written over unless `overwrite` says so.
    async saveBriefDraft(overwrite) {
      if (!this.briefCanSave) {
        this.briefMessage = this.briefInvalid.length ? 'A field holds text that is not a figure, so the brief is not kept. Correct the field or empty it.' : `The brief is not valid: ${this.briefProblems.join('; ')}`

        return
      }

      const payload = normaliseBrief(this.briefDraft)
      const outcome = await saveBrief(this.records ? this.records.repository : null, this.scope, { entry: this.briefEntry, payload, overwrite })

      if (outcome.ok) {
        this.briefOrigin = outcome.record.uuid
        this.briefBaseline = { revision: outcome.record.revision, payload }
        this.briefSelected = outcome.record.uuid
        this.briefConflict = null
        this.briefMessage = ''
        this.briefRevision += 1
      } else if (outcome.code === 'revision-conflict') {
        this.briefConflict = { name: outcome.stored.name, revision: outcome.revision }
        this.briefMessage = ''
      } else {
        this.briefMessage = outcome.message
      }
    },

    async removeBrief() {
      const entry = this.briefEntry

      if (!entry) {
        return
      }

      const outcome = await deleteBrief(this.records ? this.records.repository : null, this.scope, entry)

      if (outcome.ok) {
        this.clearBrief()
        this.briefSelected = null
        this.briefRevision += 1
      } else {
        this.briefMessage = outcome.message
      }
    },

    // Moves a brief made at a later game time to this save, so that it applies here.
    async moveBriefHere(uuid) {
      const entry = this.briefAhead.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const outcome = await moveBrief(this.records ? this.records.repository : null, this.scope, entry)

      if (outcome.ok) {
        this.briefMessage = `The brief ${entry.name} now applies to this save.`
        this.briefRevision += 1
      } else {
        this.briefMessage = outcome.message
      }
    },
  },
  asyncComputed: {
    tech: {
      get: tracked('tech', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_TECH_CHOICES
        }

        return await loadTechChoices(this.database, this.context)
      }),
      default: NO_TECH_CHOICES,
    },
    // The repository of scenario records, loaded when the page is: its module needs the app's settings store, so a page that is read without it still loads.
    records: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerTechScenarios(records.registerAdapter)
          registerBriefs(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: error.message })
        }
      },
      default: null,
    },
    classes: {
      get: tracked('classes', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await loadClasses(this.database, this.context)
      }),
      default: EMPTY_LIST,
    },
    classParts: {
      get: tracked('classParts', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await loadClassParts(this.database, this.context)
      }),
      default: EMPTY_LIST,
    },
    tanks: {
      get: tracked('tanks', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await loadStockTanks(this.database, this.context)
      }),
      default: EMPTY_LIST,
    },
    raceEngines: {
      get: tracked('raceEngines', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await loadRaceEngines(this.database, this.context)
      }),
      default: EMPTY_LIST,
    },
    classFigures: {
      get: tracked('classFigures', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_CLASS_FIGURES
        }

        return await loadClassFigures(this.database, this.context)
      }),
      default: NO_CLASS_FIGURES,
    },
  },
}
</script>

<style lang="scss">
.propulsion-page {
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
    white-space: nowrap;
  }

  .tool--actions {
    align-self: flex-end;
  }

  // One row from 1280 px up: the numbers keep their size, the class field takes what is left up to 280 px and the buttons lose their labels below 1500 px. Narrower windows wrap.
  .tool--hull {
    flex: 0 0 180px;
  }

  .tool--class {
    flex: 1 1 160px;
    max-width: 280px;
  }

  .tool--speed {
    flex: 0 0 150px;
  }

  .tool--goal {
    flex: 0 0 150px;
  }

  .tool--cruise {
    flex: 0 0 120px;
  }

  @media (max-width: 1499px) {
    .tool__btn-label {
      display: none;
    }

    .tool__buttons .v-btn {
      min-width: 40px !important;
      padding: 0 12px !important;
    }

    .tool__buttons .v-btn .v-icon--left {
      margin-right: 0;
    }
  }

  .tool__buttons {
    display: flex;
    gap: 8px;
  }

  .toolbar .v-btn-toggle .v-btn,
  .tool__buttons .v-btn {
    height: 40px !important;
  }

  .is-searching {
    opacity: 0.6;
  }

  .provenance-basis__legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .provenance-basis__legend-item {
    display: inline-flex;
    align-items: center;
  }

  .provenance-basis__line {
    padding-top: 2px;
  }

  .clickable-rows tbody tr {
    cursor: pointer;
  }

  tr.is-selected-row {
    background: var(--ae-row-selected);
  }

  .expand-cell {
    padding: 8px 24px 16px !important;
  }

  .detail-table {
    background: transparent !important;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
