<template>
  <div>
    <v-container fluid class="logistics-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <v-btn-toggle v-model="view" mandatory dense>
            <v-btn value="fuel" small><v-icon small left>mdi-gas-station</v-icon>Fuel</v-btn>
            <v-btn value="maintenance" small><v-icon small left>mdi-wrench</v-icon>Maintenance supplies</v-btn>
            <v-btn value="reserves" small><v-icon small left>mdi-shield-lock-outline</v-icon>Reserves</v-btn>
            <v-btn value="stations" small><v-icon small left>mdi-flag-variant</v-icon>Fleet stations</v-btn>
          </v-btn-toggle>
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" class="mt-3" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" class="mt-2" />

        <template v-if="view === 'fuel'">
          <v-row>
            <v-col cols="12" lg="5">
              <v-card class="panel" data-summary="Compare yearly fuel production from refineries and harvesters with ship fuel use." elevation="1">
                <div class="panel-head"><span>Fuel balance per year</span></div>
                <div class="panel-body">
                  <div v-for="group in fuelBalance" :key="group.label" class="balance-group">
                    <div class="balance-head">
                      <span>{{ group.label }}</span>
                      <span class="text-no-wrap">{{ group.total }}</span>
                    </div>
                    <div v-for="line in group.lines" :key="line.label" class="balance-row">
                      <span>{{ line.label }}</span>
                      <span class="balance-meter"><span class="balance-meter-fill" :class="line.color" :style="{ width: `${line.width}%` }" /></span>
                      <span class="text-no-wrap balance-value">{{ litres(line.value) }}</span>
                    </div>
                  </div>
                  <div class="caption text--secondary mt-3">
                    Burn is estimated two ways: each ship's lifetime average (distance travelled against time at full speed), and every ship that moved in the last increment running at full power all year. The truth is usually between them.
                  </div>
                </div>
              </v-card>
            </v-col>
            <v-col cols="12" lg="7">
              <v-card class="panel" data-summary="Compare estimated yearly fuel burn by class using lifetime averages and full-power burn for ships moving now." elevation="1">
                <div class="panel-head">
                  <span>Burn by class<provenance-mark rule="logistics.fullPowerBurn" label /></span>
                  <span class="legend">
                    <span class="legend-item"><series-key :color="theme.categorical[0]" />Lifetime average</span>
                    <span class="legend-item"><series-key :color="theme.categorical[1]" />Moving now, full power</span>
                  </span>
                </div>
                <div class="panel-body">
                  <chart-canvas v-if="burnRows.length" type="bar" :data="burnChart" :options="burnOptions" :height="Math.max(160, burnChart.labels.length * 26 + 40)" label="Estimated fuel burn per year by ship class" />
                  <div v-else class="caption text--secondary">No ships with engines and fuel tanks.</div>
                </div>
              </v-card>
            </v-col>
          </v-row>

          <v-card class="panel" data-summary="Review each colony's fuel stock, refineries and Sorium stock." elevation="1">
            <div class="panel-head">
              <span>Colony fuel and refineries<provenance-mark rule="logistics.refineryOutput" label /></span>
              <v-chip small>{{ refineryRows.filter((row) => row.output > 0).length }} refining<template v-if="refineryTotals.unknown"> · {{ refineryTotals.unknown }} not known</template></v-chip>
            </div>
            <v-data-table :headers="refineryHeaders" :items="refineryRows" item-key="PopulationID" :custom-sort="sortNullLast" :sort-by.sync="refineriesTable.sortBy" :sort-desc.sync="refineriesTable.sortDesc" :items-per-page.sync="refineriesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }">
              <template #[`item.name`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.PopName }}<page-link :to="colonyLink(item.PopulationID)" :name="item.PopName" class="ml-1" /></div>
                  <div class="caption text--secondary">{{ item.place }}</div>
                </div>
              </template>
              <template #[`item.FuelStockpile`]="{ item }">
                <span class="text-no-wrap">
                  <v-icon v-if="item.belowWarning" small color="warning" :title="`Below the colony's warning level of ${litres(item.WarningFuel)}`">mdi-alert</v-icon>
                  {{ litres(item.FuelStockpile) }}
                </span>
              </template>
              <template #[`item.Refineries`]="{ item }">{{ item.Refineries ? count(item.Refineries) : '—' }}</template>
              <template #[`item.output`]="{ item }">
                <span v-if="item.output === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.outputResult" /></span>
                <span v-else-if="item.output > 0" class="text-no-wrap">{{ litres(item.output) }}<provenance-mark :result="item.outputResult" /></span>
                <span v-else-if="item.idleReason" class="text-no-wrap" :class="item.idleReason === 'Turned off' ? 'text--secondary' : 'warning--text'">{{ item.idleReason }}</span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.Sorium`]="{ item }">{{ item.Sorium >= 1 ? tons(item.Sorium) : '—' }}</template>
              <template #[`item.soriumSort`]="{ item }">
                <span v-if="item.soriumYears !== null" class="text-no-wrap" :class="{ 'warning--text': item.soriumYears < 5 }">{{ years(item.soriumYears) }}<provenance-mark :result="item.soriumResult" /></span>
                <span v-else class="text--secondary">—<provenance-mark v-if="item.output === null" :result="item.soriumResult" /></span>
              </template>
              <template #[`item.services`]="{ item }">
                <v-chip v-if="item.CanRefuel" x-small class="mr-1" title="Has a spaceport or refuelling station">Refuel</v-chip>
                <v-chip v-if="item.CanResupply" x-small title="Has a spaceport, cargo shuttle station or maintenance facility">Resupply</v-chip>
              </template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              Use it to see where fuel is made and where Sorium is about to run out. A refinery makes {{ litres(raceFuelProduction) }} a year, times the colony's production modifiers (governor, sector, workers, species), using a tonne of Sorium per 2,000 L. Refining stops when the Sorium runs out.
            </div>
          </v-card>

          <v-card class="panel" data-summary="Review each tanker's stored fuel, transferable surplus and any reason it cannot serve." elevation="1" data-donor-panel>
            <div class="panel-head">
              <span>Tankers and fuel service<provenance-mark rule="fuelService.eligibleSurplus" label /></span>
              <v-chip v-if="donorReport" small data-donor-chip><span data-donor-value="ships">{{ donorReport.totals.ships }}</span> {{ donorReport.totals.ships === 1 ? 'tanker' : 'tankers' }} · <span data-donor-value="chip">{{ litres(donorReport.totals.stored.value) }}</span> stored</v-chip>
            </div>
            <load-state v-if="!donorReport" :failed="donorState.failed" :error="donorState.error" :loading="donorState.loading" class="ma-3" @retry="retryDonors" />
            <template v-else>
              <div class="panel-body caption" data-donor-totals>
                <span data-donor-total="stored">Stored fuel <span data-donor-value="stored">{{ exactLitres(donorReport.totals.stored.value) }}</span><provenance-mark :result="donorReport.totals.stored.result" /></span>
                <span data-donor-total="surplus"> · Eligible surplus <span data-donor-value="eligible">{{ exactLitres(donorReport.totals.eligible) }}</span><template v-if="donorReport.totals.eligibleUnknown"> ({{ donorReport.totals.eligibleUnknown }} not known)</template></span>
                <span data-donor-total="permissions"> · <span data-donor-value="allowed">{{ donorReport.totals.permissions.allowed }}</span> can serve, <span data-donor-value="blocked">{{ donorReport.totals.permissions.blocked }}</span> cannot, <span data-donor-value="unknown">{{ donorReport.totals.permissions.unknown }}</span> not known</span>
                <span data-donor-total="empty"> · <span data-donor-value="empty">{{ donorReport.totals.empty }}</span> empty</span>
              </div>
              <v-data-table :headers="tankerHeaders" :items="tankerRows" item-key="ShipID" :custom-sort="sortNullLast" :sort-by.sync="tankersTable.sortBy" :sort-desc.sync="tankersTable.sortDesc" :items-per-page.sync="tankersTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" no-data-text="No tanker ships.">
                <template #[`item.ShipName`]="{ item }">
                  <div class="py-2" :data-donor-ship="item.ShipID">
                    <div class="font-weight-medium" data-donor-cell="name">{{ item.ShipName }}</div>
                    <div class="caption text--secondary">{{ item.FleetName }}<template v-if="item.SystemName"> · {{ item.SystemName }}</template></div>
                  </div>
                </template>
                <template #[`item.role`]="{ item }">
                  <div :data-service-site="item.site ? 'yes' : 'no'" data-donor-cell="role">{{ item.role }}</div>
                  <div class="caption text--secondary"><span data-donor-cell="class">{{ item.ClassName }}</span><template v-if="!item.counted"> · <span data-donor-cell="uncounted">not in the tanker stock</span></template></div>
                </template>
                <template #[`item.Fuel`]="{ item }">
                  <span v-if="item.Fuel === null" class="text--secondary">—</span>
                  <template v-else>
                    <div class="text-no-wrap" data-donor-cell="stored">{{ donorText(item).stored }}</div>
                    <div v-if="item.Fuel === 0" class="caption text--secondary" data-donor-cell="empty">Empty</div>
                  </template>
                </template>
                <template #[`item.MinimumFuel`]="{ item }"><span class="text-no-wrap" data-donor-cell="minimum">{{ donorText(item).minimum }}</span></template>
                <template #[`item.reserve`]="{ item }">
                  <div class="text-no-wrap text--secondary" data-donor-cell="reserve">{{ donorText(item).reserve }}</div>
                  <div v-if="reserveSourceText(item)" class="caption text--secondary" data-donor-cell="reserve-source">{{ reserveSourceText(item) }}</div>
                </template>
                <template #[`item.eligibleSurplus`]="{ item }">
                  <span class="text-no-wrap" :class="item.donor.permission === 'allowed' ? '' : 'text--secondary'" data-donor-cell="surplus">{{ donorText(item).surplus }}<provenance-mark :result="item.donor.results.eligibleSurplus" /></span>
                </template>
                <template #[`item.service`]="{ item }">
                  <div :class="item.donor.permission === 'allowed' ? 'success--text' : item.donor.permission === 'blocked' ? 'warning--text' : 'text--secondary'" data-donor-cell="permission">{{ donorText(item).permission }}<provenance-mark :result="item.donor.results.permission" /></div>
                  <div v-if="donorText(item).reason" class="caption text--secondary" data-donor-cell="reason">{{ donorText(item).reason }}</div>
                  <div v-if="donorText(item).limit" class="caption text--secondary" data-donor-cell="limit">{{ donorText(item).limit }}</div>
                </template>
              </v-data-table>
              <fuel-reserves :key="`${GameID}-${RaceID}`" @reserves="fuelReserves = $event" />
              <div class="panel-foot caption text--secondary">
                Distinguish stored fuel from fuel free to give, and keep a reserve back on a ship or on a ship class. Stored fuel is the fuel aboard now, and no restriction lowers it. The class minimum is the fuel the game keeps in a donor. The local reserve is a level the player keeps aboard, kept as a record for a ship or for a ship class. A ship's own record holds over its class's, and a ship with none reads as none set. The eligible surplus is the whole litres above the larger of the two. It is given only when the ship has the Tanker designation, an undamaged Transfer - Fuel system, a class rate above 0 and fuel above the class minimum, and a rate under 20,000 LPH serves recipients of 20 HS or less only. A ship that cannot serve is shown with the reason, not as empty. A ship with no engines is a service site with no range of its own. The damaged systems are read from the ship, and the ship's refuel mode is not read. {{ versionNote }}
              </div>
            </template>
          </v-card>

          <v-card v-if="harvesterRows.length" class="panel" data-summary="Compare harvester output, free tank capacity and deposits, including when tanks fill or Sorium runs out." elevation="1">
            <div class="panel-head">
              <span>Sorium harvesters<provenance-mark rule="logistics.harvesterOutput" label /><provenance-mark rule="logistics.harvesterObtainable" /></span>
              <span class="d-flex align-center">
                <v-chip small class="mr-3">{{ formulaVersion ? 'Rates follow the game\'s rules' : 'Rates are estimates' }}</v-chip>
                <span class="caption text--secondary mr-2">Fits over</span>
                <v-btn-toggle v-model="harvesterHorizon" mandatory dense>
                  <v-btn v-for="option in horizonOptions" :key="option.years" :value="option.years" small>{{ option.label }}</v-btn>
                </v-btn-toggle>
              </span>
            </div>
            <v-data-table :headers="harvesterHeaders" :items="harvesterRows" item-key="ShipID" :sort-by.sync="harvestersTable.sortBy" :sort-desc.sync="harvestersTable.sortDesc" :items-per-page.sync="harvestersTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }">
              <template #[`item.ShipName`]="{ item }">
                <div class="py-2" :data-harvester-ship="item.ShipID">
                  <div class="font-weight-medium" data-harvester-name>{{ item.ShipName }}</div>
                  <div class="caption text--secondary">{{ item.FleetName }}</div>
                  <div v-if="item.fuelRole" class="caption text--secondary" data-harvester-role>{{ item.fuelRole }}</div>
                </div>
              </template>
              <template #[`item.modules`]="{ item }">
                <span v-if="item.modules === null" class="text--secondary">—<provenance-mark :result="item.rate" /></span>
                <span v-else class="text-no-wrap">{{ item.modules === item.classModules ? item.modules : `${item.modules} of ${item.classModules}` }}</span>
              </template>
              <template #[`item.perYear`]="{ item }">
                <span v-if="item.perYear === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.rate" /></span>
                <span v-else class="text-no-wrap">{{ litres(item.perYear) }}</span>
              </template>
              <template #[`item.obtainableLitres`]="{ item }">
                <template v-if="item.unknown">
                  <span class="text--secondary text-no-wrap">—<provenance-mark :result="item.obtainable" /></span>
                  <div class="caption text--secondary">{{ item.idle }}</div>
                </template>
                <span v-else-if="item.idle === 'Tanks full'" class="warning--text text-no-wrap">Tanks full</span>
                <span v-else-if="item.idle" class="text--secondary text-no-wrap">{{ item.idle }}</span>
                <template v-else>
                  <div class="text-no-wrap">{{ litres(item.obtainableLitres) }}</div>
                  <div class="caption text--secondary">{{ limitText(item) }}</div>
                </template>
              </template>
              <template #[`item.room`]="{ item }">
                <span v-if="item.room === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.obtainable" /></span>
                <template v-else>
                  <div class="text-no-wrap">{{ litres(item.room) }}</div>
                  <div class="caption text--secondary">{{ percent(item.tanks) }} full</div>
                </template>
              </template>
              <template #[`item.fillYears`]="{ item }">{{ item.fillYears === null ? '—' : item.fillYears === 0 ? 'Full' : years(item.fillYears) }}</template>
              <template #[`item.SoriumAmount`]="{ item }">{{ item.SoriumAmount === null ? '—' : tons(item.SoriumAmount) }}</template>
              <template #[`item.depositYears`]="{ item }">{{ item.depositYears === null ? '—' : years(item.depositYears) }}</template>
              <template #[`item.service`]="{ item }">
                <fuel-figures v-if="item.fuelDonor" :donor="item.fuelDonor" />
                <span v-else class="text--secondary">—</span>
              </template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              Judge which harvesters are worth keeping where they are. Rate is what a harvester makes while it works, not fuel that fits. It is each undamaged module at the racial Fuel Production rate, times the commander's and naval admin Mining bonuses (a fleet with no command takes the race's root command), the deposit's accessibility and the share of crew aboard when short-crewed. The fuel that fits over the chosen period is held to the Sorium in the deposit and to the room in the undamaged tanks, and a ship with any room left keeps harvesting. The deposit is the gas giant or super-Jovian at the fleet's coordinates. Where the race has not surveyed it, the output is unknown (—), not 0. Ships over one deposit share it, and the fall in accessibility once less than half of it is left is not applied. {{ versionNote }}
            </div>
          </v-card>
        </template>

        <template v-else-if="view === 'maintenance'">
          <v-card class="panel" data-summary="Review colonies and ships that provide maintenance, with their supply stocks, production and upkeep." elevation="1">
            <div class="panel-head">
              <span>Maintenance locations<provenance-mark rule="logistics.maintenanceLocation" label /></span>
              <v-switch v-model="showIdleLocations" label="Show colonies without ships" dense hide-details class="mt-0" />
            </div>
            <v-data-table :headers="locationHeaders" :items="visibleLocations" item-key="key" show-expand single-expand :expanded.sync="expandedLocations" :custom-sort="sortNullLast" :sort-by.sync="locationsTable.sortBy" :sort-desc.sync="locationsTable.sortDesc" :items-per-page.sync="locationsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
              <template #[`item.name`]="{ item }">
                <div class="py-2" :data-location="item.key">
                  <div class="font-weight-medium"><span data-location-name>{{ item.name }}</span><page-link v-if="item.PopulationID" :to="colonyLink(item.PopulationID)" :name="item.name" class="ml-1" /></div>
                  <div class="caption text--secondary" data-location-place>{{ item.place }}</div>
                </div>
              </template>
              <template #[`item.stock`]="{ item }">
                <span class="text-no-wrap">
                  <v-icon v-if="item.belowWarning" small color="warning" :title="`Below the warning level of ${count(item.warningLevel)}`">mdi-alert</v-icon>
                  {{ count(item.stock) }}<provenance-mark v-if="item.stockUnknown" :result="item.stockResult" />
                </span>
                <div v-if="item.supply || item.supplyUnknown" class="caption text--secondary text-no-wrap" data-location-supply :title="item.supplyAbove === null ? '' : `${count(item.supplyAbove)} above the class minimums`">{{ item.supply === null ? 'Supply ships not known' : `+${count(item.supply)} ${locationWords.supply}` }}<provenance-mark v-if="item.supplyUnknown" :result="item.supplyResult" /></div>
              </template>
              <template #[`item.production`]="{ item }">
                <span v-if="item.production === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.productionResult" /></span>
                <template v-else-if="item.production > 0">
                  <span class="text-no-wrap">{{ count(item.production) }}<provenance-mark :result="item.productionResult" /></span>
                  <div v-if="item.blocked > 0" class="caption error--text text-no-wrap" :title="`The ${item.missing.join(', ')} in stock won't last a year at full production`">Short of {{ item.missing.join(', ') }} (−{{ count(item.blocked) }})</div>
                </template>
                <span v-else-if="item.blocked > 0" class="text-no-wrap error--text" :title="`Facilities are on but the colony has none of the ${item.missing.join(', ')} the MSP needs in stock`">No {{ item.missing.join(', ') }} ({{ count(item.blocked) }})</span>
                <span v-else-if="item.potential > 0" class="text-no-wrap" :class="item.net < 0 ? 'error--text' : 'text--secondary'">Off ({{ count(item.potential) }})</span>
                <span v-else class="text--secondary">—</span>
                <div v-if="item.uncounted && item.production !== null" class="caption text--secondary text-no-wrap">{{ item.uncounted }} {{ item.uncounted === 1 ? 'colony' : 'colonies' }} not counted</div>
              </template>
              <template #[`item.loadSort`]="{ item }">
                <span v-if="item.tons === null || item.capacity === null" class="caption text-no-wrap" :title="`${tons(item.tons)} maintained, capacity ${tons(item.capacity)}`">{{ tons(item.tons) }} / {{ tons(item.capacity) }}<provenance-mark :result="item.tons === null ? item.tonsResult : item.capacityResult" /></span>
                <div v-else-if="item.tons > 0 || item.capacity > 0" class="load-cell" :title="`${tons(item.tons)} maintained, capacity ${tons(item.capacity)}`">
                  <div class="meter">
                    <div class="meter-fill" :class="{ warning: item.tons > item.capacity }" :style="{ width: `${item.capacity > 0 ? Math.min(100, (item.tons / item.capacity) * 100) : 100}%` }" />
                  </div>
                  <span class="caption text-no-wrap" :class="{ 'warning--text': item.tons > item.capacity }">{{ tons(item.tons) }} / {{ tons(item.capacity) }}</span>
                </div>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.upkeep`]="{ item }">
                <span v-if="item.unmaintained" class="error--text text-no-wrap" data-location-unmaintained title="No maintenance facilities or modules here: the ships' maintenance clocks are running">{{ locationWords.unmaintained }}</span>
                <span v-else-if="item.upkeep === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.upkeepResult" /></span>
                <span v-else-if="item.upkeep > 0" class="text-no-wrap">{{ count(item.upkeep) }}<span v-if="item.rate !== null && item.rate < 1" class="caption warning--text"> at {{ percent(item.rate) }}</span></span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #[`item.net`]="{ item }">
                <span v-if="item.net === null" class="text--secondary text-no-wrap">—<provenance-mark :result="item.netResult" /></span>
                <span v-else class="text-no-wrap" :class="{ 'error--text': item.net < 0 }">{{ signed(item.net) }}<provenance-mark :result="item.netResult" /></span>
              </template>
              <template #[`item.runwaySort`]="{ item }">
                <span v-if="item.net === null" class="text--secondary">—<provenance-mark :result="item.netResult" /></span>
                <span v-else-if="item.runway !== null" class="text-no-wrap" :class="{ 'error--text': item.runway < 1, 'warning--text': item.runway >= 1 && item.runway < 5 }">{{ years(item.runway) }}<provenance-mark :result="item.netResult" /></span>
                <span v-else-if="item.runwayResult" class="text--secondary">—<provenance-mark :result="item.runwayResult" /></span>
                <span v-else-if="item.upkeep > 0" class="text--secondary">Covered</span>
                <span v-else class="text--secondary">—</span>
              </template>
              <template #expanded-item="{ headers: columns, item }">
                <td :colspan="columns.length" class="pa-3">
                  <maintenance-pool :location="item" :days="poolDays" :period="poolPeriod" />
                </td>
              </template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              Spot locations that will run short of maintenance supplies. Open a row to see its capacity sources, the stock providers in the order they are drawn, and what each ship takes. {{ groupingText }} Ships use supplies where their location is: the stock of its colonies first (the fullest colony first), then the supply ships there (the fullest first), then their own. The supply caption is the whole stock of the supply ships, and their class minimums show in the open row. A maintained ship needs a quarter of its class cost in MSP a year, or its full cost while overhauling. Commercial ships and craft in military hangars need none. Above capacity every ship there is maintained, and uses MSP, at the capacity × the economic modifier / tonnage rate. Production: facilities × {{ count(raceMspProduction * 4) }} MSP × the colony's production modifiers, using {{ mspMineralsText }}. Production here counts the minerals in stock alone, and the panel below adds mining, packets and hauls on the days they arrive.
            </div>
          </v-card>

          <msp-supply :key="`${GameID}-${RaceID}`" :rows="mspSupplyTable" :state="mspSupplyState" :problems="mspSupply ? mspSupply.problems : []" :years="mspHorizon" :horizons="mspHorizonOptions" @years="mspHorizon = $event" @retry="retryMspSupply" />

          <v-card v-if="supplyFleets.length" class="panel" data-summary="Review supply ships and the maintenance supplies each carries." elevation="1">
            <div class="panel-head">
              <span>Supply ships</span>
              <v-chip small>{{ count(supplyTotal.value) }} MSP above their minimums<template v-if="supplyTotal.unknown"> · {{ supplyTotal.unknown }} not known<provenance-mark :result="supplyTotal.result" /></template></v-chip>
            </div>
            <v-data-table :headers="supplyHeaders" :items="supplyFleets" item-key="FleetID" :custom-sort="sortNullLast" :sort-by.sync="supplyTable.sortBy" :sort-desc.sync="supplyTable.sortDesc" disable-pagination hide-default-footer dense>
              <template #[`item.FleetName`]="{ item }">
                <span>{{ item.FleetName }}</span><page-link :to="fleetRoutesLink(item.FleetID)" :name="item.FleetName" class="ml-1" />
              </template>
              <template #[`item.SupplyMSP`]="{ item }">{{ count(item.SupplyMSP) }}<provenance-mark v-if="item.SupplyMSP === null" rule="logistics.maintenanceStock" /></template>
            </v-data-table>
          </v-card>
        </template>

        <template v-else-if="view === 'reserves'">
          <resource-reserves :key="`${GameID}-${RaceID}`" kind="supplies" :colonies="colonies" :place="place" :modifier-of="modifierOf" />
        </template>

        <template v-else>
          <fleet-stations :key="`${GameID}-${RaceID}`" :state="stationState" :view="stationView" :repository="stationRepository" :repository-error="stationRepositoryError" :scope="stationScope" :context="stationContext" :database="database" :game-id="GameID" :race-id="RaceID" @retry="retryStations" @changed="stationsChanged" />
        </template>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme } from '../components/charts/theme'
import MaintenancePool from '../components/logistics/MaintenancePool.vue'
import MspSupply from '../components/logistics/MspSupply.vue'
import FleetStations from '../components/fleets/FleetStations.vue'
import ResourceReserves from '../components/logistics/ResourceReserves.vue'
import FuelFigures from '../components/logistics/FuelFigures.vue'
import FuelReserves from '../components/logistics/FuelReserves.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import fleetStations, { STATION_INPUTS, STATION_LABELS } from '../mixins/fleet-stations'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import { activeAppearance } from '../utilities/appearance'
import { populationName, systemBodyName } from '../utilities/aurora'
import { linkTo, place as placeKey } from '../utilities/deep-links'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { MSP_MINERALS, columnTotal, compact, fullPowerBurn, gateHarvesterRows, harvesterReport, maintenanceLocations, maintenanceSupplyTotals, refineryYield, soriumLasts } from '../utilities/logistics'
import { POOL_WORDS, SETTLED_POINTS, loadMaintenanceShips, periodDays, shipFigures } from '../utilities/maintenance-pools'
import { donorTexts, loadFuelDonors, tankerReport } from '../utilities/fuel-donors'
import { fuelReserveOf } from '../utilities/resource-reserves'
import { UNKNOWN_TEXT, isKnownNumber, roundToDecimal, separatedNumber } from '../utilities/math'
import { loadNavalAdmins } from '../utilities/naval-admins'
import { sortNullLast, totalOf } from '../utilities/production'
import { describeResult, valueOrNull } from '../utilities/provenance'
import { loadFormulaVersion } from '../utilities/capabilities'
import { MSP_HORIZONS, loadMspSupply, mspSupplyRows } from '../utilities/msp-supply'

const INPUT_LABELS = {
  colonies: 'the colonies',
  maintenanceShips: 'the ships and their maintenance',
  harvesters: 'harvesters',
  burn: 'fuel burn by class',
  shipFuel: 'fuel on ships',
  navalAdmins: 'naval admin commands',
  populationProductionModifiers: 'production modifiers',
  formulaVersion: 'the save\'s schema',
  mspSupply: 'the incoming minerals',
  fuelDonors: 'the fuel service of the ships',
  ...STATION_LABELS,
}
// The read of the incoming minerals feeds the supplied-output panel alone, and the read of the ships' fuel service the tanker panel and the fuel service column of the harvesters: the rest of the page never waits for them, and a failure of one is shown on its own panel.
const MSP_INPUTS = ['mspSupply']
const DONOR_INPUTS = ['fuelDonors']
const OPTIONAL_INPUTS = [...MSP_INPUTS, ...DONOR_INPUTS]
// The reads behind the fleet stations panel feed that panel alone, each with its own loading, failure and Retry there.
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key) && !STATION_INPUTS.includes(key))
// Classes shown in the burn chart; the rest are folded into "Other classes".
const BURN_CLASSES = 12
const VIEW_NAMES = { fuel: 'Fuel', maintenance: 'Maintenance supplies', reserves: 'Reserves', stations: 'Fleet stations' }
const PAGE_SIZES = [15, 30, -1]
// How far ahead the harvesters' obtainable fuel looks, in years.
const HARVESTER_HORIZONS = [
  { years: 0.25, label: '3 mo' },
  { years: 0.5, label: '6 mo' },
  { years: 1, label: '1 y' },
  { years: 2, label: '2 y' },
  { years: 5, label: '5 y' },
]

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

export default {
  name: 'LogisticsPage',
  components: { ChartCanvas, FleetStations, FuelFigures, FuelReserves, LoadState, MaintenancePool, MspSupply, PageLink, ProvenanceMark, ResourceReserves, SeriesKey, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    fleetStations,
    loadState(INPUT_LABELS),
    productionModifiers,
    persistedView({
      view: { key: 'logisticsView', default: 'fuel', valid: oneOf(Object.keys(VIEW_NAMES)) },
      showIdleLocations: { key: 'logisticsShowIdleLocations', default: false },
      harvesterHorizon: { key: 'logisticsHarvesterHorizon', default: 1, valid: oneOf(HARVESTER_HORIZONS.map((option) => option.years)) },
      mspHorizon: { key: 'logisticsMspHorizon', default: 1, valid: oneOf(MSP_HORIZONS.map((option) => option.years)) },
      refineriesTable: tableView('logisticsRefineriesTable', { sortBy: ['FuelStockpile'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      harvestersTable: tableView('logisticsHarvestersTable', { itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      tankersTable: tableView('logisticsTankersTable', { sortBy: ['Fuel'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      locationsTable: tableView('logisticsLocationsTable', { sortBy: ['runwaySort'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      supplyTable: tableView('logisticsSupplyTable', {}),
    }),
  ],
  data() {
    return {
      pageSizes: PAGE_SIZES,
      // The maintenance location whose pool is open (one at a time, not kept between visits).
      expandedLocations: [],
      horizonOptions: HARVESTER_HORIZONS,
      mspHorizonOptions: MSP_HORIZONS,
      sortNullLast,
      // The fuel reserves of ships and ship classes as the Fuel panel's records give them ({ ready, table }), null until the panel has read them.
      fuelReserves: null,
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

    raceFuelProduction() {
      return this.colonies.length ? this.colonies[0].FuelProduction : 0
    },

    raceMspProduction() {
      return this.colonies.length ? this.colonies[0].MSPProduction : 0
    },

    mspMineralsText() {
      return MSP_MINERALS.map((mineral) => `${mineral.perMsp} t of ${mineral.name}`).join(', ').replace(/, ([^,]*)$/, ' and $1') + ' per MSP'
    },

    // The reads behind the page's own panels that failed: the read of the incoming minerals is its own (`mspSupplyState`).
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    // The read of the incoming minerals: loading until it has settled, else the words naming it with its message. The panel shows no figures from a read that is in flight or failed.
    mspSupplyState() {
      return this.optionalState(MSP_INPUTS)
    },

    // The read of the ships' fuel service, in the same way: the tanker panel and the fuel service of the harvesters show no figure from a read that is in flight or failed.
    donorState() {
      return this.optionalState(DONOR_INPUTS)
    },

    // The player's fuel reserve that holds for each ship by its ID (its own, else its class's), null for a ship with none.
    reserveByShip() {
      const table = this.fuelReserves && this.fuelReserves.ready ? this.fuelReserves.table : null

      return new Map((this.fuelDonors || []).map((ship) => [ship.ShipID, table ? fuelReserveOf(table, ship) : null]))
    },

    // The ships that can serve fuel with their donor results and totals, null until the read is in. The surplus of a ship that may serve and the total are worked out only once the reserve records are read: until then they read as not read, and the stored fuel and the game's permission stay.
    donorReport() {
      if (!this.fuelDonors || this.donorState.loading || this.donorState.failed) {
        return null
      }

      return tankerReport(this.fuelDonors, { version: this.formulaVersion, reserveRead: Boolean(this.fuelReserves && this.fuelReserves.ready), reserveOf: (ship) => (this.reserveByShip.get(ship.ShipID) || { amount: null }).amount })
    },

    // The tanker table lists every ship that is designated a tanker, has a refuelling rate or mounts a transfer system.
    tankerRows() {
      return this.donorReport ? this.donorReport.rows.filter((row) => row.listed) : []
    },

    // The donor result of each ship by its ID, for the harvesters.
    donorByShip() {
      return new Map((this.donorReport ? this.donorReport.rows : []).map((row) => [row.ShipID, row]))
    },

    // The supplied maintenance output of each colony over the chosen period, null until the read is in.
    mspSupplyTable() {
      if (!this.mspSupply || this.mspSupplyState.loading || this.mspSupplyState.failed) {
        return null
      }

      return mspSupplyRows({ colonies: this.colonies, sources: this.mspSupply, modifierOf: this.modifierOf, navalAdmins: this.navalAdmins, formulaVersion: this.formulaVersion, RaceID: this.RaceID, years: this.mspHorizon }).map((row) => ({ ...row, name: row.colony.PopName, place: this.place(row.colony) }))
    },

    // FUEL

    refineryRows() {
      return this.colonies.filter((colony) => colony.FuelStockpile >= 1 || colony.Refineries >= 1).map((colony) => {
        const outputResult = refineryYield(colony, this.modifierOf(colony.PopulationID))
        const output = valueOrNull(outputResult)
        const soriumResult = soriumLasts(colony, outputResult)
        const soriumYears = valueOrNull(soriumResult)

        return {
          ...colony,
          name: colony.PopName,
          place: this.place(colony),
          output,
          outputResult,
          idleReason: colony.Refineries < 1 || output === null || output > 0 ? null : !colony.FuelProdStatus ? 'Turned off' : colony.Sorium < 1 ? 'No Sorium' : 'No workers',
          soriumYears,
          soriumResult,
          soriumSort: soriumYears,
          belowWarning: colony.WarningFuel > 0 && colony.FuelStockpile < colony.WarningFuel,
        }
      })
    },

    // The refineries' output summed over the colonies that have a figure, with how many do not.
    refineryTotals() {
      const { result, unknown } = totalOf('logistics.refineryOutput', this.refineryRows.map((row) => row.outputResult), 'colonies')

      return { result, unknown, litres: valueOrNull(result) }
    },

    harvesterRows() {
      return harvesterReport(this.harvesters, { admins: this.navalAdmins, horizon: this.harvesterHorizon, version: this.formulaVersion }).rows.map((row) => ({
        ...row,
        body: row.SystemBodyID ? (row.SystemBodyName ? `${row.SystemName} · ${row.SystemBodyName}` : systemBodyName(row, { Name: row.SystemName })) : `${row.SystemName}, deep space`,
        tanks: row.capacity > 0 ? row.Fuel / row.capacity : 0,
        fuelDonor: this.donorByShip.has(row.ShipID) ? this.donorByShip.get(row.ShipID).donor : null,
        fuelRole: this.donorByShip.has(row.ShipID) ? this.donorByShip.get(row.ShipID).role : null,
      }))
    },

    // What the harvesters can fit into their tanks within a year, for the fuel balance: the stock is made per year, so it is held to the room left, not the rate.
    harvesterYear() {
      return harvesterReport(this.harvesters, { admins: this.navalAdmins, horizon: 1, version: this.formulaVersion })
    },

    horizonLabel() {
      return HARVESTER_HORIZONS.find((option) => option.years === this.harvesterHorizon).label
    },

    versionNote() {
      return this.formulaVersion ? 'The stored inputs agree with the rules on sample saves, but no fuel gain between two saves has been observed.' : 'The save does not state which game rules it was played under, so the rules are not verified against the save and every figure is an estimate.'
    },

    burnRows() {
      return this.burn.map((row) => {
        const full = fullPowerBurn(row)

        return { ...row, lifetime: row.DutyShips * full, moving: row.ShipsMoving * full }
      }).sort((a, b) => Math.max(b.lifetime, b.moving) - Math.max(a.lifetime, a.moving))
    },

    fuelTotals() {
      const colonyStock = columnTotal('logistics.fuelStock', this.colonies, 'FuelStockpile', 'the colony\'s fuel stockpile', 'colonies')
      const tankerStock = columnTotal('logistics.fuelStock', this.shipFuel.filter((row) => row.FuelTanker), 'Fuel', 'the fuel aboard', 'tankers', [], 'FuelUnknown')
      const shipStock = columnTotal('logistics.fuelStock', this.shipFuel.filter((row) => !row.FuelTanker), 'Fuel', 'the fuel aboard', 'ships', [], 'FuelUnknown')
      const stockResult = totalOf('logistics.fuelStock', [colonyStock.result, tankerStock.result, shipStock.result], 'stocks').result
      const colonies = colonyStock.value
      const tankers = tankerStock.value
      const ships = shipStock.value
      const refineries = this.refineryTotals.litres
      const harvesters = this.harvesterYear.litres
      const harvestersKnown = this.harvesterYear.knownLitres
      const lifetime = this.burnRows.reduce((sum, row) => sum + row.lifetime, 0)
      const moving = this.burnRows.reduce((sum, row) => sum + row.moving, 0)

      return { colonies, tankers, ships, stock: valueOrNull(stockResult), stockResult, stockUnknown: colonyStock.unknown + tankerStock.unknown + shipStock.unknown, refineries, refineriesUnknown: this.refineryTotals.unknown, harvesters, harvestersKnown, harvestersUnknown: this.harvesterYear.unknown, harvestersGaps: this.harvesterYear.gaps, production: refineries === null || harvesters === null ? null : refineries + harvesters, low: Math.min(lifetime, moving), high: Math.max(lifetime, moving), lifetime, moving }
    },

    fuelBalance() {
      const totals = this.fuelTotals
      const largest = Math.max((totals.refineries ?? 0) + totals.harvestersKnown, totals.high) || 1
      const line = (label, value, color) => ({ label, value, color, width: value ? (value / largest) * 100 : 0 })

      return [
        {
          label: 'Made',
          total: this.litres(totals.production),
          lines: [line(`Refineries${totals.refineriesUnknown ? ` (${totals.refineriesUnknown} unknown)` : ''}`, totals.refineries, 'success'), ...(this.harvesterRows.length ? [line(`Harvesters, fit in tanks${totals.harvestersUnknown ? ` (${totals.harvestersUnknown} unknown, those known only)` : ''}`, totals.harvestersKnown, 'success')] : [])],
        },
        {
          label: 'Burned (estimate)',
          total: `${this.litres(totals.low)} – ${this.litres(totals.high)}`,
          lines: [line('Lifetime average', totals.lifetime, 'primary'), line('Moving now, full power', totals.moving, 'primary')],
        },
      ]
    },

    burnChart() {
      const shown = this.burnRows.slice(0, BURN_CLASSES)
      const rest = this.burnRows.slice(BURN_CLASSES)
      const rows = rest.length ? [...shown, { ClassName: `Other classes (${rest.length})`, lifetime: rest.reduce((sum, row) => sum + row.lifetime, 0), moving: rest.reduce((sum, row) => sum + row.moving, 0) }] : shown
      const [first, second] = this.theme.categorical

      return {
        labels: rows.map((row) => row.ClassName),
        datasets: [
          { label: 'Lifetime average', data: rows.map((row) => row.lifetime), backgroundColor: first, maxBarThickness: 10 },
          { label: 'Moving now, full power', data: rows.map((row) => row.moving), backgroundColor: second, maxBarThickness: 10 },
        ],
      }
    },

    burnOptions() {
      return {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, ticks: { callback: (value) => `${compact(value)} L` } },
          y: { grid: { display: false } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${this.litres(item.raw)} a year`,
            },
          },
        },
      }
    },

    // MAINTENANCE

    locations() {
      const economicModifier = this.colonies.length ? this.colonies[0].EconomicProdModifier : 1
      const maintenanceCapacity = this.colonies.length ? this.colonies[0].MaintenanceCapacity : 0

      return maintenanceLocations({ colonies: this.colonies, ships: this.maintenanceShips, modifierOf: this.modifierOf, maintenanceCapacity, economicModifier }).map((location) => {
        const pool = location.pool
        // A pool is named and placed from its anchor: the anchor colony, or for a module ship the most populous colony in the anchor's system. Sources of other systems within the grouping distance are sources and nothing more.
        const here = pool ? location.located.filter((colony) => colony.SystemID === pool.SystemID) : location.located
        const anchor = pool && pool.anchor.kind === 'colony' ? here.find((colony) => colony.PopulationID === pool.anchor.id) : null
        const main = anchor || here.slice().sort((a, b) => b.Population - a.Population || b.MaintenanceStockpile - a.MaintenanceStockpile)[0]
        const local = pool ? location.shipRows.filter((ship) => ship.SystemID === pool.SystemID) : location.shipRows
        const shipsHere = local.length ? local : location.shipRows
        const named = shipsHere.filter((ship) => shipFigures(ship).MaintainedShips > 0 || shipFigures(ship).SupplyMSP > 0 || Number(ship.Modules) > 0)
        const fleetNames = [...new Set((named.length ? named : shipsHere).map((ship) => ship.FleetName))]
        const unmaintained = location.tons > 0 && location.capacity !== null && location.capacity <= 0

        return {
          ...location,
          PopulationID: main ? main.PopulationID : null,
          name: main ? main.PopName : fleetNames.slice(0, 2).join(', '),
          place: main ? this.place(main) : `${shipsHere[0].SystemName || 'Unknown system'}, deep space`,
          unmaintained,
          belowWarning: location.warningLevel > 0 && location.stock !== null && location.stock < location.warningLevel,
          // The load unknown (null) sorts last: a tonnage or a capacity the save does not give is no load of 0.
          loadSort: location.tons === null || (location.capacity === null && location.tons > 0) ? null : location.capacity > 0 ? location.tons / location.capacity : location.tons > 0 ? Infinity : 0,
          // Ships with no maintenance at all first, then the stock that runs out soonest, then the locations whose runway is unknown.
          runwaySort: unmaintained ? -1 : location.net === null || (location.runway === null && location.net < 0) ? null : location.runway ?? Infinity,
        }
      }).filter((location) => location.tons > 0 || location.tons === null || location.stock >= 1 || location.stockUnknown > 0 || location.potential > 0 || location.potential === null || location.supply > 0 || location.supplyUnknown > 0)
    },

    visibleLocations() {
      return this.showIdleLocations ? this.locations : this.locations.filter((location) => location.tons > 0 || location.tons === null || location.supply > 0 || location.supplyUnknown > 0)
    },

    // The supply ships' fleets, a fleet with a ship the save does not describe with no figure (null).
    supplyFleets() {
      const fleets = new Map()

      this.maintenanceShips.forEach((ship) => {
        const figures = shipFigures(ship)
        const fleet = fleets.get(ship.FleetID) || { FleetID: ship.FleetID, FleetName: ship.FleetName, SystemName: ship.SystemName, SupplyShips: 0, SupplyMSP: 0, SupplyUnknown: 0 }

        fleet.SupplyShips += figures.designated === true ? 1 : 0
        fleet.SupplyMSP += figures.SupplyAboveMinimum
        fleet.SupplyUnknown += figures.SupplyUnknown
        fleets.set(ship.FleetID, fleet)
      })

      return [...fleets.values()].filter((fleet) => fleet.SupplyMSP >= 1 || fleet.SupplyUnknown > 0).map((fleet) => ({ ...fleet, SupplyMSP: fleet.SupplyUnknown > 0 ? null : fleet.SupplyMSP, place: fleet.SystemName || 'Unknown system' })).sort((a, b) => (b.SupplyMSP ?? -1) - (a.SupplyMSP ?? -1))
    },

    supplyTotal() {
      return columnTotal('logistics.maintenanceStock', this.supplyFleets, 'SupplyMSP', 'the spare MSP of the supply ships', 'fleets')
    },

    // The period the open pool is worked out over: the horizon the incoming-minerals panel below is set to.
    poolDays() {
      return periodDays(this.mspHorizon)
    },

    poolPeriod() {
      return MSP_HORIZONS.find((option) => option.years === this.mspHorizon).label
    },

    groupingText() {
      return SETTLED_POINTS.find((point) => point.key === 'grouping').text
    },

    locationWords() {
      return POOL_WORDS.location
    },

    mspTotals() {
      const sum = (key) => this.locations.reduce((total, location) => total + (location[key] ?? 0), 0)
      const unmaintained = this.locations.filter((location) => location.unmaintained)

      return {
        ...maintenanceSupplyTotals(this.locations, this.modifierOf),
        upkeep: sum('upkeep'),
        upkeepUnknown: this.locations.filter((location) => location.upkeep === null).length,
        overloaded: this.locations.filter((location) => location.rate !== null && location.rate < 1 && location.capacity > 0).length,
        short: this.locations.filter((location) => location.runway !== null && location.runway < 5).length,
        unmaintainedShips: unmaintained.reduce((total, location) => total + (location.ships ?? 0), 0),
        unmaintainedTons: unmaintained.reduce((total, location) => total + location.tons, 0),
      }
    },

    tiles() {
      const fuel = this.fuelTotals
      const msp = this.mspTotals
      const fuelNet = fuel.production === null ? null : fuel.production - fuel.high
      const mspNet = msp.production === null || msp.upkeepUnknown ? null : msp.production - msp.upkeep
      const mspStock = valueOrNull(msp.stockResult)
      const fuelDown = fuelNet !== null && fuelNet < 0
      const mspDown = mspNet !== null && mspNet < 0

      return [
        {
          label: 'Fuel stock',
          hook: 'fuelStock',
          value: this.litres(valueOrNull(fuel.stockResult)),
          note: `Colonies ${this.litres(fuel.colonies)}, tankers ${this.litres(fuel.tankers)}, other ships ${this.litres(fuel.ships)}${fuel.stockUnknown ? `; ${fuel.stockUnknown} stocks not counted` : ''}`,
          title: describeResult(fuel.stockResult),
        },
        {
          label: 'Fuel per year',
          value: this.signedLitres(fuelNet),
          note: `Made ${this.litres(fuel.production)}${fuel.refineriesUnknown ? ` (${fuel.refineriesUnknown} ${fuel.refineriesUnknown === 1 ? 'colony' : 'colonies'} not counted)` : ''}${fuel.harvestersUnknown ? ` (${fuel.harvestersUnknown} harvesters have no figure, so the total and the balance are not given: ${fuel.harvestersGaps.join('; ')}; the known output of the rest is ${this.litres(fuel.refineries === null ? null : fuel.refineries + fuel.harvestersKnown)})` : ''}, burned about ${this.litres(fuel.low)}–${this.litres(fuel.high)}${fuelDown && fuel.stock > 0 && !fuel.stockUnknown ? `: stock lasts ${this.years(fuel.stock / -fuelNet)}` : ''}`,
          title: `Refineries: ${describeResult(this.refineryTotals.result)}${this.harvesterRows.length ? ` Harvesters, fit in tanks: ${fuel.harvestersUnknown ? `${fuel.harvestersUnknown} of ${this.harvesterRows.length} have no figure, so the fuel made and the balance are not given.` : 'every harvester has a figure.'}` : ''}`,
          icon: fuelNet === null ? null : fuelDown ? 'mdi-trending-down' : 'mdi-trending-up',
          iconColor: fuelDown ? 'error' : 'success',
        },
        {
          label: 'Maintenance supplies',
          value: mspStock === null ? UNKNOWN_TEXT : `${this.count(mspStock)} MSP`,
          note: `${msp.unmaintainedShips ? `${this.count(msp.unmaintainedShips)} ships (${this.tons(msp.unmaintainedTons)}) are away from any maintenance` : `${this.count(msp.supply)} on supply ships; every ship is at a maintenance location`}${msp.stockUnknown ? `; ${msp.stockUnknown} stocks not counted` : ''}`,
          title: describeResult(msp.stockResult),
          icon: msp.unmaintainedShips ? 'mdi-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Supplies per year',
          value: this.signed(mspNet),
          note: `Made ${this.count(msp.production)}${msp.uncounted ? ` (${msp.uncounted} ${msp.uncounted === 1 ? 'colony' : 'colonies'} not counted)` : ''}${msp.potential > msp.production ? ` (${this.count(msp.potential)} with all on and supplied)` : ''}, used ${msp.upkeepUnknown ? `${this.count(msp.upkeep)} at the ${this.locations.length - msp.upkeepUnknown} locations that have a figure (${msp.upkeepUnknown} unknown)` : this.count(msp.upkeep)}${msp.short ? `; ${msp.short} running low` : ''}`,
          title: `${describeResult(msp.productionResult)}${msp.upkeepUnknown ? ` The upkeep of ${msp.upkeepUnknown} locations is not known, so the net is not given.` : ''}`,
          icon: mspNet === null ? null : mspDown ? 'mdi-trending-down' : 'mdi-trending-up',
          iconColor: mspDown ? 'error' : 'success',
        },
      ]
    },

    refineryHeaders() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Fuel', value: 'FuelStockpile', align: 'end' },
        { text: 'Refineries', value: 'Refineries', align: 'end' },
        { text: 'Made / yr', value: 'output', align: 'end' },
        { text: 'Sorium (t)', value: 'Sorium', align: 'end' },
        { text: 'Sorium lasts', value: 'soriumSort', align: 'end' },
        { text: 'Services', value: 'services', sortable: false },
      ]
    },

    harvesterHeaders() {
      return [
        { text: 'Ship', value: 'ShipName' },
        { text: 'At', value: 'body' },
        { text: 'Modules', value: 'modules', align: 'end' },
        { text: 'Rate / yr (uncapped)', value: 'perYear', align: 'end' },
        { text: `Fits in ${this.horizonLabel}`, value: 'obtainableLitres', align: 'end' },
        { text: 'Tank room', value: 'room', align: 'end' },
        { text: 'Tanks fill in', value: 'fillYears', align: 'end' },
        { text: 'Sorium left (t)', value: 'SoriumAmount', align: 'end' },
        { text: 'Deposit lasts', value: 'depositYears', align: 'end' },
        { text: 'Fuel service', value: 'service', sortable: false },
      ]
    },

    tankerHeaders() {
      return [
        { text: 'Ship', value: 'ShipName' },
        { text: 'Role', value: 'role' },
        { text: 'Stored fuel', value: 'Fuel', align: 'end' },
        { text: 'Class minimum', value: 'MinimumFuel', align: 'end' },
        { text: 'Local reserve', value: 'reserve', align: 'end', sortable: false },
        { text: 'Eligible surplus', value: 'eligibleSurplus', align: 'end' },
        { text: 'Service', value: 'service', sortable: false },
      ]
    },

    locationHeaders() {
      return [
        { text: 'Location', value: 'name' },
        { text: 'MSP stock', value: 'stock', align: 'end' },
        { text: 'Made / yr', value: 'production', align: 'end' },
        { text: 'Maintained / capacity', value: 'loadSort' },
        { text: 'Used / yr', value: 'upkeep', align: 'end' },
        { text: 'Net / yr', value: 'net', align: 'end' },
        { text: 'Lasts', value: 'runwaySort', align: 'end' },
      ]
    },

    supplyHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'System', value: 'place' },
        { text: 'Supply ships', value: 'SupplyShips', align: 'end' },
        { text: 'MSP above minimum', value: 'SupplyMSP', align: 'end' },
      ]
    },

    linkQuery() {
      return linkTo.logistics(this.view).query
    },

    linkLabel() {
      return VIEW_NAMES[this.view]
    },
  },
  methods: {
    applyLink(query) {
      const view = [].concat(query.view)[0]

      this.setUnsaved('view', Object.keys(VIEW_NAMES).includes(view) ? view : 'fuel')
    },

    colonyLink(populationId) {
      return linkTo.colonyOutlook(populationId)
    },

    limitText(row) {
      const text = { tanks: 'Limited by tank room', deposit: 'Limited by the deposit', rate: 'At the full rate' }[row.limit]

      return row.overDeposit ? `${text}; the ${row.ships} ships on it share a deposit that cannot cover them all` : text
    },

    fleetRoutesLink(fleetId) {
      return linkTo.routes({ from: placeKey.fleet(fleetId) })
    },

    // The colony's overall production modifier, null while the save does not give it.
    modifierOf(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      return modifiers && isKnownNumber(modifiers.OverallProductionModifier) ? modifiers.OverallProductionModifier : null
    },

    place(colony) {
      return stripHtml(populationName(colony)).replace(` — ${colony.PopName}`, '')
    },

    signed(value) {
      return isKnownNumber(value) ? `${value < 0 ? '−' : '+'}${this.count(Math.abs(value))}` : UNKNOWN_TEXT
    },
    tons(value) {
      return isKnownNumber(value) ? `${compact(value)} t` : UNKNOWN_TEXT
    },
    litres(value) {
      return isKnownNumber(value) ? `${compact(value)} L` : UNKNOWN_TEXT
    },
    signedLitres(value) {
      return isKnownNumber(value) ? `${value < 0 ? '−' : '+'}${this.litres(Math.abs(value))}` : UNKNOWN_TEXT
    },
    percent(fraction) {
      return isKnownNumber(fraction) ? `${roundToDecimal(fraction * 100, 0)}%` : UNKNOWN_TEXT
    },
    years(value) {
      if (!isKnownNumber(value)) {
        return UNKNOWN_TEXT
      } else if (value > 10000) {
        return '> 10,000 y'
      } else if (value < 1) {
        return `${Math.max(1, Math.round(value * 12))} mo`
      }

      return `${separatedNumber(roundToDecimal(value, value < 100 ? 1 : 0), this.separator)} y`
    },

    // The words of the failed reads among `keys`, or the loading state until they have all settled.
    optionalState(keys) {
      const failed = keys.filter((key) => this.loadErrors[key])

      return { loading: failed.length === 0 && !allLoaded(this.loadErrors, keys), failed: joinLabels(failed.map((key) => INPUT_LABELS[key])), error: failed.length ? this.loadErrors[failed[0]] : '' }
    },

    // A figure of litres written whole, a dash when it is not known.
    exactLitres(value) {
      return isKnownNumber(value) ? `${this.count(value)} L` : UNKNOWN_TEXT
    },

    // The words of a ship's donor result.
    donorText(row) {
      return donorTexts(row.donor, (value) => this.exactLitres(value))
    },

    // Where a ship's reserve is set, on the ship or on its class, with the scenarios it comes from; empty when none is set.
    reserveSourceText(row) {
      const reserve = this.reserveByShip.get(row.ShipID)

      return reserve ? `Set on the ${reserve.source === 'ship' ? 'ship' : 'class'}${reserve.scenarios.length ? ` · ${reserve.scenarios.join(', ')}` : ''}` : ''
    },

    // Reads again the read of the incoming minerals, whether it failed whole or settled with sources it could not read.
    retryMspSupply() {
      MSP_INPUTS.forEach((key) => this.$asyncComputed[key].update())
    },

    retryDonors() {
      DONOR_INPUTS.forEach((key) => this.$asyncComputed[key].update())
    },
  },
  asyncComputed: {
    // Every colony, with what both fuel and maintenance need. Services: refuel needs a spaceport or refuelling station; resupply a spaceport, cargo shuttle station or maintenance facility.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Efficiency, FCT_Population.SystemBodyID, FCT_Population.SystemID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, FCT_Population.MaintenanceStockpile, FCT_Population.MaintProdStatus, FCT_Population.WarningMSP, FCT_Population.FuelStockpile, FCT_Population.FuelProdStatus, FCT_Population.WarningFuel, FCT_Population.Sorium, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Race.MSPProduction, FCT_Race.MaintenanceCapacity, FCT_Race.FuelProduction, FCT_Race.EconomicProdModifier, max(0, min(1, 1 - coalesce(FCT_SystemBody.RadiationLevel, 0) / 10000.0)) * max(0, min(1, 1 - FCT_Population.UnrestPoints / 100.0)) * coalesce(DIM_PopPoliticalStatus.ProductionMod, 1) as CapacityModifier, FCT_Population.Duranium, FCT_Population.Uridium, FCT_Population.Gallicite,
          coalesce(VIR_Installations.Mines, 0) as Mines, coalesce(VIR_Installations.MaintenanceFacilities, 0) as MaintenanceFacilities, coalesce(VIR_Installations.Refineries, 0) as Refineries, coalesce(VIR_Installations.Refuel, 0) as CanRefuel, coalesce(VIR_Installations.Resupply, 0) as CanResupply from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
          left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.MaintenanceValue * FCT_PopulationInstallations.Amount) as MaintenanceFacilities, sum(DIM_PlanetaryInstallation.RefineryProductionValue * FCT_PopulationInstallations.Amount) as Refineries, sum(DIM_PlanetaryInstallation.MiningProductionValue * FCT_PopulationInstallations.Amount) as Mines, max(case when DIM_PlanetaryInstallation.MassRefuelling > 0 then 1 else 0 end) as Refuel, max(case when DIM_PlanetaryInstallation.MaintenanceValue > 0 or DIM_PlanetaryInstallation.CargoShuttleValue > 0 then 1 else 0 end) as Resupply from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    // Every ship of the race with what its maintenance step reads (utilities/maintenance-pools.js): the fleet's place and assigned colony, the class's size, cost and designations, the ship's state and own stock, and the undamaged maintenance modules and cargo shuttle bays.
    maintenanceShips: {
      get: tracked('maintenanceShips', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadMaintenanceShips(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // The race's harvesters: the undamaged modules and tank capacity (class components less the first damage row of each component), the gas giant or super-Jovian at the fleet's coordinates (the first body within 1 unit on both axes), and its deposit only where the race has surveyed the body. A class whose component rows are missing gives unknown modules or capacity (null).
    harvesters: {
      get: tracked('harvesters', async function () {
        const blocked = this.blockedBonuses

        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_Fleet.SystemID, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.Fuel, FCT_Ship.CurrentCrew, FCT_ShipClass.Crew as ClassCrew, case when VIR_Parts.HarvesterRows > 0 then VIR_Parts.Harvesters end as Harvesters, case when VIR_Parts.HarvesterRows > 0 then VIR_Parts.ClassHarvesters end as ClassHarvesters, case when VIR_Parts.TankRows > 0 then VIR_Parts.FuelCapacity when FCT_ShipClass.FuelCapacity > 0 then null else 0 end as FuelCapacity, FCT_Race.FuelProduction, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end as Surveyed, case when FCT_SystemBodySurveys.SystemBodyID is null then null else coalesce(FCT_MineralDeposit.Amount, 0) end as SoriumAmount, case when FCT_SystemBodySurveys.SystemBodyID is null then null else coalesce(FCT_MineralDeposit.Accessibility, 0) end as SoriumAccessibility, coalesce(VIR_Commander.BonusValue, 1) as MiningBonus from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID left join (select VIR_Ship.ShipID, sum(case when FCT_ShipDesignComponents.ComponentTypeID = 32 then 1 else 0 end) as HarvesterRows, sum(case when FCT_ShipDesignComponents.ComponentTypeID = 32 then FCT_ClassComponent.NumComponent else 0 end) as ClassHarvesters, sum(case when FCT_ShipDesignComponents.ComponentTypeID = 32 then FCT_ClassComponent.NumComponent - coalesce(VIR_Damage.Number, 0) else 0 end) as Harvesters, sum(case when FCT_ShipDesignComponents.ComponentTypeID = 3 then 1 else 0 end) as TankRows, sum(case when FCT_ShipDesignComponents.ComponentTypeID = 3 then (FCT_ClassComponent.NumComponent - coalesce(VIR_Damage.Number, 0)) * FCT_ShipDesignComponents.ComponentValue else 0 end) as FuelCapacity from FCT_Ship as VIR_Ship inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = VIR_Ship.ShipClassID and FCT_ClassComponent.GameID = VIR_Ship.GameID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID in (3, 32) left join (select FCT_DamagedComponent.ShipID, FCT_DamagedComponent.ComponentID, FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.rowid in (select min(VIR_First.rowid) from FCT_DamagedComponent as VIR_First where VIR_First.GameID = ${this.GameID} group by VIR_First.ShipID, VIR_First.ComponentID)) as VIR_Damage on VIR_Damage.ShipID = VIR_Ship.ShipID and VIR_Damage.ComponentID = FCT_ClassComponent.ComponentID where VIR_Ship.GameID = ${this.GameID} and VIR_Ship.RaceID = ${this.RaceID} and VIR_Ship.ShippingLineID = 0 and VIR_Ship.ShipClassID in (select VIR_Harvester.ClassID from FCT_ClassComponent as VIR_Harvester inner join FCT_ShipDesignComponents as VIR_Type on VIR_Type.SDComponentID = VIR_Harvester.ComponentID and VIR_Type.ComponentTypeID = 32 where VIR_Harvester.GameID = ${this.GameID}) group by VIR_Ship.ShipID) as VIR_Parts on VIR_Parts.ShipID = FCT_Ship.ShipID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = (select VIR_Body.SystemBodyID from FCT_SystemBody as VIR_Body where VIR_Body.GameID = FCT_Ship.GameID and VIR_Body.BodyTypeID in (4, 5) and abs(VIR_Body.Xcor - FCT_Fleet.Xcor) < 1 and abs(VIR_Body.Ycor - FCT_Fleet.Ycor) < 1 order by VIR_Body.SystemBodyID limit 1) left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Ship.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID and FCT_RaceSysSurvey.GameID = FCT_Ship.GameID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Ship.RaceID and FCT_SystemBodySurveys.GameID = FCT_Ship.GameID left join FCT_MineralDeposit on FCT_MineralDeposit.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_MineralDeposit.MaterialID = 8 and FCT_MineralDeposit.GameID = FCT_Ship.GameID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6 where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Commander on VIR_Commander.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and (FCT_ShipClass.Harvesters > 0 or VIR_Parts.HarvesterRows > 0) order by FCT_Fleet.FleetName, FCT_Ship.ShipName`).then(([items]) => gateHarvesterRows(items, blocked))
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
    // Per class with engines and tanks (docked craft aside): ships moving in the last increment, and the sum of each ship's lifetime duty cycle (distance / (age x top speed), age at least a quarter year).
    burn: {
      get: tracked('burn', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, count(*) as Ships, sum(case when FCT_Fleet.Xcor <> FCT_Fleet.LastXcor or FCT_Fleet.Ycor <> FCT_Fleet.LastYcor then 1 else 0 end) as ShipsMoving, sum(min(1.0, FCT_Ship.DistanceTravelled / (max(FCT_Game.GameTime - FCT_Ship.Constructed, 7884000.0) * FCT_ShipClass.MaxSpeed))) as DutyShips from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_Game on FCT_Game.GameID = FCT_Ship.GameID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_Ship.MothershipID = 0 and FCT_ShipClass.EnginePower > 0 and FCT_ShipClass.MaxSpeed > 0 and FCT_ShipClass.FuelCapacity > 0 group by FCT_ShipClass.ShipClassID`).then(([items]) => items)
      }),
      default: [],
    },
    shipFuel: {
      get: tracked('shipFuel', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ShipClass.FuelTanker, count(*) as Ships, sum(FCT_Ship.Fuel) as Fuel, sum(case when FCT_Ship.Fuel is null then 1 else 0 end) as FuelUnknown from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.FuelCapacity > 0 group by FCT_ShipClass.FuelTanker`).then(([items]) => items)
      }),
      default: [],
    },
    // The ships that can serve fuel (tankers, ships with a refuelling rate or a transfer system, harvesters) with their class minimum, rate and designation and the transfer systems they have left after damage; read for the tanker panel and the harvesters' fuel service alone.
    fuelDonors: {
      get: tracked('fuelDonors', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await loadFuelDonors(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: null,
    },
    // Naval admin commands with their Mining bonus, for harvesters.
    navalAdmins: {
      get: tracked('navalAdmins', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        const { ranks, blocked } = await this.capabilityGates('/logistics')

        return await loadNavalAdmins(this.database, { GameID: this.GameID, RaceID: this.RaceID, bonusId: 6, share: 'Industrial', ranks, blocked })
      }),
      default: {},
    },
    // The incoming minerals of the maintenance colonies (mining, packets in flight, feasible hauls), read for the supplied-output panel alone.
    mspSupply: {
      get: tracked('mspSupply', async function () {
        const { database, GameID, RaceID } = this
        const blocked = this.blockedBonuses

        if (!database || !GameID || !RaceID) {
          return null
        }

        return await loadMspSupply(database, { GameID, RaceID, blocked })
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.logistics-page {
  td {
    font-variant-numeric: tabular-nums;
  }

  .balance-group + .balance-group {
    margin-top: 16px;
  }

  .balance-head {
    display: flex;
    justify-content: space-between;
    font-weight: 500;
    padding-bottom: 4px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--ae-rule);
    font-variant-numeric: tabular-nums;
  }

  .balance-row {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) 2fr 84px;
    align-items: center;
    gap: 12px;
    padding: 4px 0;
    font-size: calc(14px * var(--ae-font-scale));
    font-variant-numeric: tabular-nums;
  }

  .balance-meter {
    height: 8px;
    border-radius: 4px;
    background: var(--ae-track-soft);
    overflow: hidden;
  }

  .balance-meter-fill {
    display: block;
    height: 100%;
    border-radius: 4px;
  }

  .balance-value {
    text-align: right;
  }

  .load-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .meter {
    flex: 0 0 72px;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
    background-color: var(--ae-muted);
  }
}
</style>
