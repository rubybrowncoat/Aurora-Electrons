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
                  <v-btn outlined aria-label="Engine options" v-bind="attrs" v-on="on"><v-icon small left>mdi-engine-outline</v-icon><span class="tool__btn-label">Engines</span><span v-if="engineOptionCount">&nbsp;({{ engineOptionCount }})</span></v-btn>
                </template>
                <v-card class="pa-4">
                  <div class="subtitle-2">Engines</div>
                  <v-btn-toggle :value="engineOptions.kind" mandatory dense class="mt-2" :disabled="!!existingEngine" @change="(value) => setEngineOption('kind', value)">
                    <v-btn v-for="option in kinds" :key="option.value" :value="option.value" small>{{ option.text }}</v-btn>
                  </v-btn-toggle>
                  <v-row dense class="mt-2">
                    <v-col cols="4"><v-text-field :value="engineOptions.min" type="number" min="1" label="Fewest" aria-label="Fewest engines" dense outlined hide-details @input="(value) => setEngineNumber('min', value)" /></v-col>
                    <v-col cols="4"><v-text-field :value="engineOptions.max" type="number" min="1" label="Most" aria-label="Most engines" dense outlined hide-details @input="(value) => setEngineNumber('max', value)" /></v-col>
                    <v-col cols="4"><v-text-field :value="Math.round(engineOptions.share * 100)" type="number" min="1" max="100" suffix="%" label="Share" aria-label="Most of the ship the engines and fuel may take, in percent" dense outlined hide-details @input="(value) => setEngineNumber('share', value / 100)" /></v-col>
                  </v-row>
                  <div class="caption text--secondary mt-1">The share is the most of the finished ship the engines and their fuel tanks may take.</div>
                  <v-autocomplete :value="engineId" :items="engineItems" item-text="text" item-value="value" label="Engine" placeholder="Design new engines" prepend-inner-icon="mdi-engine-outline" clearable dense outlined hide-details class="mt-3" @change="(value) => (engineId = value || null)" />
                  <div class="caption text--secondary mt-1">An engine of the race's own fixes the size, thrust and fuel of the set, and only its count is searched.</div>
                </v-card>
              </v-menu>
              <v-menu offset-y left :close-on-content-click="false" max-width="560" max-height="640">
                <template #activator="{ on, attrs }">
                  <v-btn outlined aria-label="Tech levels" v-bind="attrs" v-on="on"><v-icon small left>mdi-flask-outline</v-icon><span class="tool__btn-label">Tech</span><span v-if="techChoiceCount">&nbsp;({{ techChoiceCount }})</span></v-btn>
                </template>
                <v-card class="pa-4">
                  <div class="subtitle-2">Tech levels designed with</div>
                  <div class="caption text--secondary mb-2">Each line starts at the level the game designs with. A lower level shows what an engine built before the latest research would be.</div>
                  <div v-for="line in techLines" :key="line.type" class="mt-3">
                    <v-select :value="line.selected" :items="line.items" item-text="text" item-value="value" :label="line.label" :disabled="!line.items.length" dense outlined hide-details @change="(id) => setTech(line.type, id)" />
                    <div v-if="line.next" class="d-flex align-center caption text--disabled pt-1 pl-3">Next: {{ line.next.name }} · {{ count(line.next.cost) }} RP<page-link :to="linkTo.techTree({ tech: line.next.id })" :name="line.next.name" class="ml-1" /></div>
                    <div v-else-if="!line.items.length" class="caption text--disabled pt-1 pl-3">Not researched</div>
                  </div>
                </v-card>
              </v-menu>
            </div>
          </div>
        </div>

        <v-progress-linear v-if="searching" :value="progress * 100" height="3" class="mt-2" aria-label="Searching propulsion sets" />
        <v-alert v-if="searchError" type="error" outlined dense class="mt-3">The search failed: {{ searchError }}</v-alert>
        <v-alert v-else-if="!engineTechMissing && !hullReady" type="info" outlined dense class="mt-3">Enter a hull size, or pick a saved class, to search propulsion sets.</v-alert>
        <v-alert v-else-if="engineTechMissing" type="warning" outlined dense class="mt-3">The race has no engine or fuel consumption tech to design engines with. A saved class and the race's own engines can still be shown.</v-alert>
        <v-alert v-else-if="!speedReady" type="info" outlined dense class="mt-3">Enter a speed between 1 and {{ count(maxSpeed) }} km/s.</v-alert>
        <v-alert v-else-if="result && !result.sets.length && !searching" type="warning" outlined dense class="mt-3">No engine set reaches {{ count(speed) }} km/s{{ goalText }} within {{ Math.round(engineOptions.share * 100) }}% of the ship. Raise the share or the most engines, lower the targets, allow both kinds of engine, or pick a higher tech level.</v-alert>

        <stat-tiles :tiles="tiles" class="mt-1" :class="{ 'is-searching': searching }" />

        <v-card class="panel" data-summary="The engine sets that give the hull its speed and range, ranked by how little of the ship the engines and fuel take, with the saved class beside them. A row opens to the engine as the game would build it and the tanks that hold its fuel." elevation="1">
          <div class="panel-head">
            <span>Propulsion sets</span>
            <span class="d-flex align-center flex-wrap">
              <v-chip v-if="hullReady" small class="mr-2">Hull {{ count(hullHS, 2) }} HS · {{ count(hullHS * tonsPerHs) }} tons</v-chip>
              <v-chip v-if="existingEngine" small color="primary" outlined close @click:close="engineId = null">{{ existingEngine.name }}</v-chip>
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
              <span class="text-no-wrap">{{ count(item.speed) }}</span>
              <v-icon v-if="item.check && item.check.matches" x-small color="success" class="ml-1" :title="`The save stores ${count(item.check.stored)} km/s for this class, the same.`">mdi-check-circle-outline</v-icon>
              <v-icon v-else-if="item.check" x-small color="warning" class="ml-1" :title="`The save stores ${count(item.check.stored)} km/s for this class.`">mdi-alert-circle-outline</v-icon>
            </template>
            <template #[`item.burn`]="{ item }"><span class="text-no-wrap">{{ litres(item.burn) }}</span></template>
            <template #[`item.rangeBn`]="{ item }"><span class="text-no-wrap">{{ count(item.rangeBn, 2) }}</span></template>
            <template #[`item.enduranceDays`]="{ item }"><span class="text-no-wrap">{{ count(item.enduranceDays, 1) }}</span></template>
            <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ count(item.cost, 1) }}</span></template>
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
          <div class="panel-foot caption text--secondary">
            Engine power is the engine tech's power per HS times the size times the thrust modifier. Fuel per engine power hour is the fuel tech times the thrust modifier to the power of 2.5 times the square root of 10 over the size, so a larger or slower engine burns less. An engine of 25 HS or more at thrust 0.5 or less is commercial; any other is military. Cost is half the power, times the thermal reduction's cost multiplier when it cuts the signature, times the thrust when that is under 1, and never under 5 BP. Speed is the total power over the ship's size in HS, times 1,000, cut to a whole number and capped at 270,000 km/s; the fuel tanks are part of that size. The engines are tried from 1 HS up to the largest size researched, at every 0.05 of thrust between the least and the most researched, at every count that fits the share. Sets rank by the least HS the engines and tanks take, then the least cost. The saved class is worked out from the engines it mounts; a check mark says the save stores the same speed.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The sets no other beats on the share of the ship the propulsion takes against speed or range, to see what extra speed or range costs in hull." elevation="1">
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
                <span class="legend-item"><span class="dot" :style="{ background: theme.categorical[0] }" />Military</span>
                <span class="legend-item"><span class="dot" :style="{ background: theme.categorical[1] }" />Commercial</span>
                <span v-if="tradeSaved" class="legend-item"><span class="dot" :style="{ background: theme.categorical[2] }" />Saved class</span>
              </div>
              <chart-canvas type="line" :data="tradeChart.data" :options="tradeChart.options" :height="340" :label="`Share of the ship the propulsion takes against ${tradeMetric === 'speed' ? 'speed' : 'range'}`" />
            </template>
            <v-data-table v-else :headers="tradeHeaders" :items="tradeTable" item-key="key" disable-pagination hide-default-footer dense>
              <template #[`item.share`]="{ item }"><span class="text-no-wrap">{{ percent(item.share) }}</span></template>
              <template #[`item.speed`]="{ item }"><span class="text-no-wrap">{{ count(item.speed) }}</span></template>
              <template #[`item.rangeBn`]="{ item }"><span class="text-no-wrap">{{ count(item.rangeBn, 2) }}</span></template>
              <template #[`item.propulsionHS`]="{ item }"><span class="text-no-wrap">{{ count(item.propulsionHS, 2) }}</span></template>
              <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ count(item.cost, 1) }}</span></template>
            </v-data-table>
          </div>
          <div class="panel-foot caption text--secondary">A set is listed when no other set takes a smaller share of the finished ship and also goes faster (or farther). Every set already meets the speed and range targets, so the range column mostly shows the rounding of whole tanks. The table lists the same sets for reading off exact figures.</div>
        </v-card>

        <v-row>
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="The stock fuel tanks that hold the chosen set's fuel in the fewest HS, with their litres and cost, to fit the fuel a range or endurance needs." elevation="1">
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
              <div class="panel-foot caption text--secondary">Tanks are picked from the stock tanks the race holds: from the largest down, each size takes as many as fit and leaves the rest to the smaller ones, or takes one more and holds it all, whichever takes fewer HS, then fewer BP. The game has no packing rule; this is the planner's own. A range target is met at the speed the finished ship reaches with the tanks aboard.</div>
            </v-card>
          </v-col>
          <v-col cols="12" xl="6">
            <v-card class="panel" data-summary="How fast the chosen set burns its fuel and how long it lasts at full power, half power and the cruise share, to see what a slower cruise buys." elevation="1">
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
                    <td class="text-right text-no-wrap">{{ count(level.speed) }}</td>
                    <td class="text-right text-no-wrap">{{ litres(level.burn) }}</td>
                    <td class="text-right text-no-wrap">{{ count(level.days, 1) }}</td>
                    <td class="text-right text-no-wrap">{{ count(level.rangeBn, 2) }}</td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div class="panel-foot caption text--secondary">The engines burn their power times the fuel per engine power hour every hour, scaled by the share of power in use, so a slower cruise lengthens the endurance and leaves the range as it is. The range is the fuel over the burn at full power, times the speed, times 3,600.</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" data-summary="The jump drives the game would add to the finished hull, military and commercial, with their size, cost, crew and the ships they move." elevation="1">
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
            </div>
          </template>
          <div class="panel-foot caption text--secondary">A drive for a ship of S HS is S over (efficiency × the larger of 1 and (S / 20) to the power 0.25) HS. Its cost is S over the efficiency, times the squadron size and radius cost multipliers, times 5; its crew is twice its size, rounded; its HTK is the square root of its size, cut to a whole number. A commercial drive is five times the size and moves five times the ships. The game's automatic design starts from the hull's size, rounded up (a fifth of it for a commercial drive), and grows the drive by 1 HS until it moves the hull with the drive aboard. It uses the race's highest efficiency tech and the default squadron size and radius techs, whatever else the race has researched, and it leaves the armour as it is.</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { linkTo, queryId } from '../utilities/deep-links'
import { loadClassParts, loadClasses, loadRaceEngines, loadStockTanks, splitClasses } from '../utilities/design-data'
import { DEFAULT_SQUADRON_RADIUS_TECH, DEFAULT_SQUADRON_SIZE_TECH, MAX_SPEED, TONS_PER_HS, burnPerHour, classSpeed, enduranceHours, fullPowerRangeKm, selfJumpDrive, thermalSignature } from '../utilities/design-rules'
import { searchPropulsion } from '../utilities/design-search'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { derive } from '../utilities/query-cache'
import { ENGINE_TECH_TYPE, FUEL_TECH_TYPE, JUMP_EFFICIENCY_TECH_TYPE, MAX_ENGINE_SIZE_TECH_TYPE, MAX_THRUST_TECH_TYPE, MIN_THRUST_TECH_TYPE, NO_RACE_TECH, SQUADRON_RADIUS_TECH_TYPE, SQUADRON_SIZE_TECH_TYPE, THERMAL_TECH_TYPE, loadRaceTech } from '../utilities/race-tech'

const INPUT_LABELS = {
  tech: 'the race\'s engine and jump drive tech',
  classes: 'the ship classes',
  classParts: 'the engines, tanks and jump drives of the classes',
  tanks: 'the fuel tanks',
  raceEngines: 'the race\'s engines',
}

// The search runs in slices this long, handing the browser a turn between them to draw, and starts this long after the last change to an input.
const SLICE_MS = 12
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
  components: { ChartCanvas, LoadState, PageLink, StatTiles },
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
      engineOptions: { key: 'propulsionEngines', default: { kind: 'either', min: 1, max: 100, share: 0.5 }, scope: 'race', valid: (value) => value && KIND_VALUES.includes(value.kind) && value.min >= 1 && value.max >= value.min && value.share > 0 && value.share <= 1 },
      techChoice: { key: 'propulsionTech', default: {}, scope: 'race', valid: (value) => value && typeof value === 'object' && !Array.isArray(value) },
      setsTable: { ...tableView('propulsionSetsTable', { sortBy: ['rank'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: SET_PAGE_SIZES }), scope: 'race' },
      tradeView: { key: 'propulsionTradeView', default: 'chart', valid: oneOf(TRADE_VIEWS) },
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
      searchError: '',
      // The row whose fuel and jump drive the panels show, by its key; the rows open in the table.
      selectedKey: null,
      expanded: [],
      tradeMetric: 'speed',
      kinds: KINDS,
      setPageSizes: SET_PAGE_SIZES,
      maxSpeed: MAX_SPEED,
      tonsPerHs: TONS_PER_HS,
      linkTo,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
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
      const { kind, min, max, share } = this.engineOptions

      return (kind !== 'either' ? 1 : 0) + (min !== 1 || max !== 100 ? 1 : 0) + (share !== 0.5 ? 1 : 0) + (this.existingEngine ? 1 : 0)
    },

    // The level of each tech line the page designs with: the race's choice when it is still researched, else the game's pick.
    techLevels() {
      return Object.fromEntries(TECH_LINES.map(({ type }) => {
        const line = this.tech.lines[type]

        return [type, line.levels.find((level) => level.id === this.techChoice[type]) || line.pick]
      }))
    },

    techChoiceCount() {
      return TECH_LINES.filter(({ type }) => this.techLevels[type] && this.techLevels[type] !== this.tech.lines[type].pick).length
    },

    techLines() {
      return TECH_LINES.map(({ type, label, figure }) => {
        const line = this.tech.lines[type]
        const selected = this.techLevels[type]

        return {
          type,
          label,
          selected: selected ? selected.id : null,
          next: line.next,
          items: line.levels.map((level) => ({ value: level.id, text: `${figure ? `${figure(level)} · ` : ''}${level.name}${level === line.pick ? ' · the game\'s pick' : ''}` })),
        }
      })
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

    // The least and most engines of a set, and the share of the ship they may take, as entered but made sane.
    engineLimits() {
      const min = Math.max(1, Math.floor(finiteNumber(this.engineOptions.min)) || 1)

      return { kind: this.engineOptions.kind, min, max: Math.max(min, Math.floor(finiteNumber(this.engineOptions.max)) || min), share: Math.min(1, Math.max(0.01, finiteNumber(this.engineOptions.share) || 1)) }
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
      if (!this.ready || !this.hullReady || !this.speedReady || (!this.existingEngine && !this.designTech)) {
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
        tech: this.designTech,
        tanks: this.tanks,
        engine: this.existingEngine,
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
        speed,
        check: power > 0 ? { stored: shipClass.stored.speed, matches: shipClass.stored.speed === speed } : null,
        burn: burnFull,
        rangeBn: fullPowerRangeKm({ fuel: shipClass.fuel, enginePower: power, fuelPerEph, speed }) / 1e9,
        enduranceDays: enduranceHours({ fuel: shipClass.fuel, enginePower: power, fuelPerEph, fraction: this.fraction }) / 24,
        cost: sumBy(shipClass.engines, (engine) => engine.cost * engine.count) + sumBy(shipClass.tanks, (tank) => tank.cost * tank.count),
        crew: sumBy(shipClass.engines, (engine) => engine.crew * engine.count) + sumBy(shipClass.tanks, (tank) => tank.crew * tank.count),
        type: !shipClass.engines.length ? '—' : commercial === shipClass.engines.length ? 'Commercial' : commercial ? 'Mixed' : 'Military',
        thermal: thermalSignature({ enginePower: heat, stealthRating: 1, fraction: this.fraction, sizeHS: shipClass.sizeHS }),
        cards: shipClass.engines.map((engine) => engineCard(engine, engine.name, engine.count)),
        tanks: shipClass.tanks,
        tankHS: shipClass.tankHS,
        tankCost: sumBy(shipClass.tanks, (tank) => tank.cost * tank.count),
        litres: shipClass.fuel,
        totalHS: shipClass.sizeHS,
        rangeKm: fullPowerRangeKm({ fuel: shipClass.fuel, enginePower: power, fuelPerEph, speed }),
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

      return [...new Set([1, 0.5, this.fraction])].sort((a, b) => b - a).map((fraction) => ({
        fraction,
        speed: Math.floor(row.speed * fraction),
        burn: burnPerHour({ enginePower: row.power, fuelPerEph: row.fuelPerEph, fraction }),
        days: enduranceHours({ fuel: row.litres, enginePower: row.power, fuelPerEph: row.fuelPerEph, fraction }) / 24,
        rangeBn: row.rangeKm / 1e9,
      }))
    },

    tiles() {
      const result = this.result
      const none = { value: '—', note: this.searching ? 'Searching…' : 'No set meets the targets' }
      const describe = (set) => `${this.count(set.count)} × ${this.setName(set)}`
      const tile = (label, set, figure) => ({ label, ...(set ? { value: figure(set), note: describe(set) } : none) })
      const tech = this.designTech

      return [
        tile('Fastest set within the share', result && result.fastest, (set) => `${this.count(set.speed)} km/s`),
        tile('Lightest set for the targets', result && result.lightest, (set) => `${this.count(set.propulsionHS, 2)} HS (${this.count(set.tons)} tons)`),
        tile('Cheapest set', result && result.cheapest, (set) => `${this.count(set.cost, 1)} BP`),
        { label: 'Engine and fuel tech', value: tech ? `${this.count(tech.engineTech, 2)} EP/HS` : '—', note: tech ? `Fuel ${tech.fuelTech} L per EP hour · thrust × ${tech.minThrust} to × ${tech.maxThrust}` : 'None researched' },
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
      return this.tradeFrontier.map((set) => ({ key: `${set.engine.id || `${set.engine.sizeHS}-${set.engine.thrust}`}-${set.count}`, set, share: set.share, speed: set.speed, rangeBn: set.rangeKm / 1e9, propulsionHS: set.propulsionHS, cost: set.cost, name: this.setName(set), count: set.count, type: set.commercial ? 'Commercial' : 'Military' }))
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
      return this.tradeRows
    },

    tradeChart() {
      const speed = this.tradeMetric === 'speed'
      const [military, commercial, saved] = this.theme.categorical
      const value = (row) => (speed ? row.speed : row.rangeBn)
      const point = (row, label) => ({ x: roundToDecimal(row.share * 100, 2), y: roundToDecimal(value(row), speed ? 0 : 2), label })
      const series = (label, color, data, style = 'circle') => ({ label, data, showLine: false, pointRadius: 5, pointHoverRadius: 8, pointStyle: style, backgroundColor: color, borderColor: color })
      const describe = (row) => `${row.count} × ${row.name}: ${this.count(row.propulsionHS, 2)} HS, ${this.count(row.speed)} km/s, ${this.count(row.rangeBn, 2)} bn km`
      const datasets = [
        series('Military', military, this.tradeRows.filter((row) => row.type === 'Military').map((row) => point(row, describe(row)))),
        series('Commercial', commercial, this.tradeRows.filter((row) => row.type === 'Commercial').map((row) => point(row, describe(row)))),
      ]

      if (this.tradeSaved) {
        const row = this.tradeSaved

        datasets.push(series('Saved class', saved, [point(row, `${row.name} (saved): ${this.count(row.propulsionHS, 2)} HS, ${this.count(row.speed)} km/s, ${this.count(row.rangeBn, 2)} bn km`)], 'rectRot'))
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

    // A link names the saved class and the race's own engine the page is on.
    linkQuery() {
      return this.ready ? linkTo.propulsion({ class: this.selectedClass ? this.selectedClass.id : null, engine: this.existingEngine ? this.existingEngine.id : null }).query : null
    },

    linkLabel() {
      return this.selectedClass ? this.selectedClass.name : this.existingEngine ? this.existingEngine.name : ''
    },
  },
  watch: {
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
  beforeDestroy() {
    clearTimeout(this.searchTimer)
    this.run = null
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

    // A count or share the field holds as typed; one that isn't sane keeps the stored value.
    setEngineNumber(key, value) {
      const number = finiteNumber(value)
      const options = { ...this.engineOptions, [key]: number }

      if (key === 'share' ? number > 0 && number <= 1 : number >= 1 && Number.isInteger(number) && (key === 'max' ? number >= options.min : number <= options.max)) {
        this.engineOptions = options
      }
    },

    // A level other than the game's pick is remembered; the pick itself is forgotten, so a later research moves it on.
    setTech(type, id) {
      const choice = { ...this.techChoice }

      if (id === (this.tech.lines[type].pick || {}).id) {
        delete choice[type]
      } else {
        choice[type] = id
      }

      this.techChoice = choice
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
        speed: set.speed,
        check: null,
        burn: set.burnFull,
        rangeBn: set.rangeKm / 1e9,
        enduranceDays: set.enduranceHours / 24,
        cost: set.cost,
        crew: set.crew,
        type: set.commercial ? 'Commercial' : 'Military',
        thermal: set.thermal,
        cards: [engineCard(set.engine, name, set.count)],
        tanks: set.tanks,
        tankHS: set.tankHS,
        tankCost: set.tanks.reduce((total, tank) => total + tank.cost * tank.count, 0),
        litres: set.litres,
        totalHS: set.totalHS,
        rangeKm: set.rangeKm,
      }
    },

    selectRow(row) {
      this.selectedKey = row.key
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
            return a.rank - b.rank
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

    // Stops the search running and, for an input that can be searched, starts it after a short wait. An input that changes meanwhile takes over.
    startSearch(input) {
      clearTimeout(this.searchTimer)

      const run = {}

      this.run = run
      this.searchError = ''

      if (!input) {
        this.result = null
        this.searching = false

        return
      }

      this.searching = true
      this.searchTimer = setTimeout(() => this.runSearch(input, run), SEARCH_DELAY_MS)
    },

    // Runs `searchPropulsion` a slice at a time, then keeps its result with the input it was for.
    async runSearch(input, run) {
      const iterator = searchPropulsion(input)
      let step

      this.progress = 0

      try {
        do {
          const end = performance.now() + SLICE_MS

          do {
            step = iterator.next()
          } while (!step.done && performance.now() < end)

          if (!step.done) {
            this.progress = step.value.progress
            await nextTask()
          }

          if (this.run !== run) {
            return
          }
        } while (!step.done)
      } catch (error) {
        if (this.run === run) {
          this.run = null
          this.searching = false
          this.searchError = error.message
        }

        return
      }

      this.run = null
      this.searching = false
      this.result = Object.freeze({ ...step.value, input })
    },
  },
  asyncComputed: {
    tech: {
      get: tracked('tech', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_RACE_TECH
        }

        return await loadRaceTech(this.database, this.context)
      }),
      default: NO_RACE_TECH,
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
    height: 18px;
    line-height: 18px;
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

  .clickable-rows tbody tr {
    cursor: pointer;
  }

  tr.is-selected-row {
    background: rgba(33, 150, 243, 0.08);
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

.theme--dark .propulsion-page {
  tr.is-selected-row {
    background: rgba(33, 150, 243, 0.16);
  }
}
</style>
