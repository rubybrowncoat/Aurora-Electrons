<template>
  <div>
    <v-container fluid class="transport-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />
      <fuel-reserve-reader :key="`${GameID}-${RaceID}`" @reserves="fuelReserveRead = $event" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--place">
            <div class="tool__label caption text--secondary">From</div>
            <v-autocomplete :value="origin && origin.key" :items="places" item-text="name" item-value="key" :filter="filterPlace" aria-label="From" dense outlined hide-details auto-select-first @change="setFrom">
              <template #item="{ item }">
                <v-icon small class="mr-3">{{ item.icon }}</v-icon>
                <v-list-item-content>
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.subtitle }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--swap">
            <v-btn icon :disabled="!destination" aria-label="Swap From and To" title="Swap From and To" @click="swap"><v-icon>mdi-swap-horizontal</v-icon></v-btn>
          </div>
          <div class="tool tool--place">
            <div class="tool__label caption text--secondary">To</div>
            <v-autocomplete :value="destination && destination.key" :items="places" item-text="name" item-value="key" :filter="filterPlace" aria-label="To" placeholder="A colony or a system" dense outlined hide-details clearable auto-select-first @change="setTo">
              <template #item="{ item }">
                <v-icon small class="mr-3">{{ item.icon }}</v-icon>
                <v-list-item-content>
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.subtitle }}</v-list-item-subtitle>
                </v-list-item-content>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--fleets">
            <div class="tool__label caption text--secondary">Fleets</div>
            <v-autocomplete :value="chosenFleetIds" :items="fleetOptions" item-text="FleetName" item-value="FleetID" aria-label="Fleets" placeholder="All fleets" multiple dense outlined hide-details clearable @change="setFleets">
              <template #selection="{ item, index }">
                <span v-if="index === 0" class="text-truncate">{{ item.FleetName }}</span>
                <span v-if="index === 1" class="caption text--secondary ml-2 text-no-wrap">+{{ chosenFleetIds.length - 1 }}</span>
              </template>
              <template #item="{ item, attrs, on }">
                <v-list-item v-bind="attrs" v-on="on">
                  <v-icon small class="mr-3">{{ attrs.inputValue ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}</v-icon>
                  <v-list-item-content>
                    <v-list-item-title>{{ item.FleetName }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.summary }}</v-list-item-subtitle>
                  </v-list-item-content>
                </v-list-item>
              </template>
            </v-autocomplete>
          </div>
          <div class="tool tool--actions">
            <v-menu offset-y left :close-on-content-click="false" max-width="420">
              <template #activator="{ on, attrs }">
                <v-btn outlined aria-label="Transport options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
              </template>
              <v-card class="pa-4">
                <div class="subtitle-2">How the run is planned</div>
                <v-checkbox v-for="option in optionList" :key="option.key" :input-value="options[option.key]" dense hide-details @change="(value) => setOption(option.key, value)">
                  <template #label>
                    <div>
                      <div class="body-2">{{ option.label }}</div>
                      <div class="caption text--secondary">{{ option.hint }}</div>
                    </div>
                  </template>
                </v-checkbox>
              </v-card>
            </v-menu>
          </div>
          <div class="tool tool--actions">
            <avoid-options :options="avoidOptionList" :settings="avoidSettings" :count="avoidCount" @change="setAvoid" />
          </div>
        </div>

        <div v-if="avoidNote" class="mt-2 caption" :class="avoidNote.tone" data-avoid-note>{{ avoidNote.text }}<v-btn v-if="avoidState.failed" x-small text class="ml-2" @click="retryAvoid">Retry</v-btn></div>
        <route-positions v-if="endpointPositions" :positions="endpointPositions" :state="positionState" class="mt-2" @retry="retryPosition" />

        <stat-tiles :tiles="tiles" class="mt-1" />

        <v-alert v-if="!destination" type="info" dense outlined class="mt-4 mb-0">Pick a destination to see what the fleets could move there.</v-alert>
        <v-alert v-for="problem in problems" :key="problem.text" type="warning" dense outlined class="mt-4 mb-0">{{ problem.text }}</v-alert>

        <v-card class="panel" data-summary="How long each fleet would take to sail the chosen run and how much it could carry." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Fleets on this run<provenance-mark rule="transport.roundTrip" label /></span>
              <v-chip v-if="destination" small class="ml-3">{{ origin.name }} → {{ destination.name }}</v-chip>
              <page-link v-if="destination" class="ml-1" :to="routesLink" :name="`${origin.name} to ${destination.name}`" />
            </span>
          </div>
          <div v-if="handlingSupportNote" class="panel-body py-2 caption" :class="handlingSupportNote.tone" data-handling-note>{{ handlingSupportNote.text }}<v-btn v-if="handlingSupportState.failed" x-small text class="ml-2" @click="retryHandlingSupport">Retry</v-btn></div>
          <v-data-table :headers="classHeaders" :items="rows" item-key="key" :expanded.sync="expanded" show-expand single-expand :sort-by.sync="classesTable.sortBy" :sort-desc.sync="classesTable.sortDesc" :items-per-page.sync="classesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="noRowsText" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.ClassName }}</div>
              </div>
            </template>
            <template #[`item.ships`]="{ item }">{{ count(item.ships) }}</template>
            <template #[`item.cargo`]="{ item }"><span v-if="item.cargo !== null" class="text-no-wrap">{{ count(item.cargo) }} t</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonists`]="{ item }"><span v-if="item.colonists !== null" class="text-no-wrap">{{ count(item.colonists) }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.speed`]="{ item }"><span class="text-no-wrap">{{ count(item.speed) }} km/s</span></template>
            <template #[`item.tripDays`]="{ item }">
              <div v-if="item.status === 'ok' || item.status === 'range'" class="py-2 text-no-wrap" :title="tripTitle(item)">
                <div>{{ duration(item.tripSeconds / SECONDS_PER_DAY) }}<provenance-mark v-if="item.provenance" :result="item.provenance" /></div>
                <div class="caption text--secondary">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }} · {{ distance(item.km) }}<provenance-mark v-if="item.pathResult" :result="item.pathResult" /></div>
                <div v-if="item.detourText" class="caption text--secondary route-detour" data-detour>{{ item.detourText }}</div>
                <div v-if="item.propagation" class="caption text--secondary" data-propagation :title="propagationText(item)">{{ propagationText(item) }}</div>
              </div>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark v-if="item.provenance" :result="item.provenance" /></span>
            </template>
            <template #[`item.trips`]="{ item }"><span v-if="item.trips !== null" class="text-no-wrap">{{ count(item.trips, 1) }}<provenance-mark :result="item.results.trips" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.tonsYear`]="{ item }"><span v-if="item.tonsYear !== null" class="text-no-wrap">{{ count(item.tonsYear) }} t<provenance-mark :result="item.results.tonsYear" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonistsYear`]="{ item }"><span v-if="item.colonistsYear !== null" class="text-no-wrap">{{ count(item.colonistsYear) }}<provenance-mark :result="item.results.colonistsYear" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.fuel`]="{ item }">
              <div v-if="item.fuel !== null" class="py-2 text-no-wrap">
                <div>{{ count(item.fuel) }} L<provenance-mark :result="item.results.fuel" /></div>
                <div class="caption text--secondary">{{ count(item.fuelShare * 100) }}% of a tank<provenance-mark :result="item.results.fuelShare" /></div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.statusSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap">
                  <v-icon small :color="STATUS[item.status].color" class="mr-1">{{ STATUS[item.status].icon }}</v-icon>
                  <span>{{ STATUS[item.status].label }}</span>
                </div>
                <div v-if="item.note && item.status !== 'noroute'" class="caption text--secondary">{{ item.note }}</div>
              </div>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <handling-breakdown :rows="item.handlingRows" />
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">Use it to pick the best ships for a haul between two places. Each class in a fleet is timed as if it sailed alone: the round trip is twice the route at top speed, plus loading at the origin and unloading at the destination, each stop taking its slowest ship. Loading speed follows the ship's cargo shuttle bays, the race's shuttle technology, the crew share and the Logistics bonuses of the commander, the governor and the sector; a bonus the save cannot settle counts as 1, so the time errs long. A ship over 500 t with no undamaged bays can load only at a colony with a spaceport or cargo shuttle station, its class is marked Can't load, and a class whose ability to load is not known has no time, trips or fuel. {{ versionNote }} Ships without a jump drive that covers their size use only jump points stabilised on both sides. The route is the fewest jumps, with Lagrange jumps unless turned off, and does not avoid dangerous or alien systems; jump shock and nebula speed limits are left out, and the wait after each jump is not added, so a run with jumps takes at least the time shown. The run must fit in one tank, since refuelling needs an order and a station and no time for it is counted; Civilian tile ships are timed the same way without that limit.</div>
          <div v-if="payoutNote" class="panel-foot caption text--secondary"><span class="font-weight-medium">Shipping-line payout</span><provenance-mark :result="payoutNote.result" label /> {{ payoutNote.text }}</div>
        </v-card>

        <v-card class="panel" data-summary="How long a fleet would take to sail the chosen run as one, at the speed of its slowest ship." data-fleet-panel elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Fleets sailing together<provenance-mark rule="transport.fleetTrip" label /></span>
              <v-chip v-if="destination" small class="ml-3">{{ origin.name }} → {{ destination.name }}</v-chip>
            </span>
          </div>
          <div v-for="note in fuelNotes" :key="note.key" class="panel-body py-2 caption" :class="note.tone" data-fuel-note :data-fuel-input="note.key">{{ note.text }}<v-btn v-if="note.retry" x-small text class="ml-2" @click="note.retry()">Retry</v-btn></div>
          <div v-if="fleetShipsState.loading" class="panel-body py-2 caption text--secondary" data-fleet-note>Reading the ships of the fleets.</div>
          <div v-else-if="fleetShipsState.failed" class="panel-body py-2 caption warning--text" data-fleet-note>The ships of the fleets could not be read: {{ fleetShipsState.error }}<v-btn x-small text class="ml-2" @click="retryFleetShips">Retry</v-btn></div>
          <v-data-table v-else :headers="fleetHeaders" :items="fleetRuns" item-key="key" :expanded.sync="fleetsExpanded" show-expand single-expand :sort-by.sync="fleetsTable.sortBy" :sort-desc.sync="fleetsTable.sortDesc" :items-per-page.sync="fleetsTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="destination ? 'No fleet carries cargo or colonists' : 'Pick a destination above'" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.FleetName`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium" data-fleet-name :data-fleet-id="item.FleetID">{{ item.FleetName }}</div>
                <div class="caption text--secondary">{{ item.independent }} of {{ item.ships }} under their own power<provenance-mark rule="transport.fleetSpeed" /></div>
              </div>
            </template>
            <template #[`item.ships`]="{ item }">{{ count(item.ships) }}<provenance-mark rule="transport.fleetSpeed" /></template>
            <template #[`item.cargo`]="{ item }"><span v-if="item.cargo !== null" class="text-no-wrap">{{ count(item.cargo) }} t<provenance-mark rule="transport.fleetCargo" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonists`]="{ item }"><span v-if="item.colonists !== null" class="text-no-wrap">{{ count(item.colonists) }}<provenance-mark rule="transport.fleetCargo" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.speed`]="{ item }">
              <div v-if="item.speed !== null" class="py-2 text-no-wrap">
                <div>{{ count(item.speed) }} km/s<provenance-mark rule="transport.fleetSpeed" /></div>
                <div v-if="item.savedSpeed !== item.speed || item.effectiveMax !== item.speed" class="caption text--secondary" data-fleet-speeds-apart>saved {{ count(item.savedSpeed) }}<provenance-mark rule="transport.fleetSpeed" /> · maximum {{ count(item.effectiveMax) }}<provenance-mark rule="transport.fleetSpeed" /></div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.tripDays`]="{ item }">
              <div v-if="(item.status === 'ok' || item.status === 'range') && item.timingKnown" class="py-2 text-no-wrap" :title="tripTitle(item)">
                <div>{{ duration(item.tripSeconds / SECONDS_PER_DAY) }}<provenance-mark v-if="item.provenance" :result="item.provenance" /></div>
                <div class="caption text--secondary">{{ item.jumps }} {{ item.jumps === 1 ? 'jump' : 'jumps' }} · {{ distance(item.km) }}<provenance-mark v-if="item.pathResult" :result="item.pathResult" /></div>
                <div v-if="item.propagation" class="caption text--secondary" data-propagation :title="propagationText(item)">{{ propagationText(item) }}</div>
              </div>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark v-if="item.provenance" :result="item.provenance" /></span>
            </template>
            <template #[`item.trips`]="{ item }"><span v-if="item.trips !== null" class="text-no-wrap">{{ count(item.trips, 1) }}<provenance-mark :result="item.results.trips" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.tonsYear`]="{ item }"><span v-if="item.tonsYear !== null" class="text-no-wrap">{{ count(item.tonsYear) }} t<provenance-mark :result="item.results.tonsYear" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.colonistsYear`]="{ item }"><span v-if="item.colonistsYear !== null" class="text-no-wrap">{{ count(item.colonistsYear) }}<provenance-mark :result="item.results.colonistsYear" /></span><span v-else class="text--secondary">—</span></template>
            <template #[`item.fuel`]="{ item }">
              <div v-if="item.fuel !== null" class="py-2 text-no-wrap">
                <div>{{ count(item.fuel) }} L<provenance-mark :result="item.results.fuel" /></div>
                <div class="caption text--secondary">{{ count(item.fuelShare * 100) }}% of the tank of {{ item.fuelLimiting }}<provenance-mark :result="item.results.fuelShare" /></div>
                <div v-if="item.ledger && item.returnShare !== null" class="caption text--secondary" data-fuel-return>returns with {{ count(item.returnShare * 100) }}% of the tank of {{ item.returnLimiting }}<provenance-mark :result="item.results.fuelReturn" /></div>
              </div>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.draw`]="{ item }"><span v-if="item.draw !== null" class="text-no-wrap" :title="item.drawTitle" data-fleet-draw>{{ item.draw }} of {{ item.drawOf }}</span><span v-else class="text--secondary">—</span></template>
            <template #[`item.statusSort`]="{ item }">
              <div class="py-2">
                <div class="text-no-wrap" data-fleet-status>
                  <v-icon small :color="STATUS[item.status].color" class="mr-1">{{ STATUS[item.status].icon }}</v-icon>
                  <span>{{ STATUS[item.status].label }}</span><provenance-mark v-if="item.ledger" :result="item.ledger.results.ledger" />
                </div>
                <div v-if="item.note && item.status !== 'noroute'" class="caption text--secondary" data-fleet-note-text>{{ item.note }}</div>
              </div>
            </template>
            <template #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div v-if="item.cycleRows.length" class="mb-3" data-fleet-cycle>
                  <div class="text-subtitle-2">Round trip</div>
                  <v-simple-table dense>
                    <tbody>
                      <tr v-for="row in item.cycleRows" :key="row.key" :data-cycle-row="row.key">
                        <td>{{ row.label }}</td>
                        <td class="text-right text-no-wrap" :data-cycle-value="row.key">{{ row.text }}<provenance-mark v-if="row.result" :result="row.result" /></td>
                      </tr>
                    </tbody>
                  </v-simple-table>
                </div>
                <div v-if="item.ledgerView" class="mb-3" data-fuel-ledger>
                  <div class="text-subtitle-2">Fuel on the run<provenance-mark :result="item.ledgerView.result" /></div>
                  <v-simple-table dense>
                    <thead>
                      <tr>
                        <th>Ship</th>
                        <th v-for="column in item.ledgerView.columns" :key="column.key" class="text-right">{{ column.label }}</th>
                        <th class="text-right">Returns with</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="ship in item.ledgerView.ships" :key="ship.id" :data-ledger-ship="ship.id">
                        <td>{{ ship.name }}</td>
                        <td v-for="cell in ship.cells" :key="cell.key" class="text-right text-no-wrap">
                          <span :data-ledger-value="cell.kind" :data-ledger-key="cell.key">{{ cell.litres }}</span>
                          <span v-if="cell.share" class="caption text--secondary ml-1">{{ cell.share }}</span>
                        </td>
                        <td class="text-right text-no-wrap">
                          <span data-ledger-value="return">{{ ship.returned }}</span>
                          <span v-if="ship.returnedShare" class="caption text--secondary ml-1">{{ ship.returnedShare }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </v-simple-table>
                  <div v-for="stop in item.ledgerView.stops" :key="stop.key" class="caption mt-2" :data-service-stop="stop.key">
                    <div class="font-weight-medium">{{ stop.title }}</div>
                    <div v-if="!stop.parts.length" class="text--secondary">{{ stop.verdict }}</div>
                    <div v-for="part in stop.parts" :key="part.key" class="mb-1" :data-service-source="part.key">
                      <div>{{ part.kind }}<span v-if="part.source">, {{ part.source }}</span>: {{ part.verdict }}</div>
                      <div v-for="figure in part.figures" :key="figure.key" class="text--secondary"><span>{{ figure.label }}: </span><span :data-service-value="figure.key">{{ figure.text }}</span></div>
                      <div v-for="tanker in part.tankers" :key="tanker.key" class="text--secondary" data-service-tanker>{{ tanker.text }}</div>
                    </div>
                    <div v-for="need in stop.needs" :key="need.id" class="text--secondary" :data-service-need="need.id"><span>{{ need.name }} needs </span><span data-service-need-value>{{ need.text }}</span><span> to reach the next stop that serves</span></div>
                  </div>
                  <div v-if="item.ledgerView.limiting" class="caption mt-2" data-ledger-limiting>{{ item.ledgerView.limiting }}</div>
                  <div v-for="text in item.ledgerView.notes" :key="text" class="caption text--secondary" data-ledger-note>{{ text }}</div>
                </div>
                <fleet-profile :participants="item.participantRows" :speeds="item.speeds" :reasons="item.reasons" :conditions="item.conditions" :handling-rows="item.handlingRows" />
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">Use it to see what a mixed fleet really does beside the classes timed alone, and whether its fuel lasts with the refuelling at the colonies and tankers on the way. A fleet sails at one speed: that of its slowest ship under its own power, which can be lower than the speed saved for the fleet and the class's rating. Every ship shares that travel time and burns fuel at its own engine power, scaled by the share of its maximum the fleet sails at. A ship in a hangar or under tow burns none and its holds are not counted, and a fleet with every hold in tow is not supported; a ship with no working engines that nothing carries or tows keeps the fleet from moving. Loading and unloading are timed as for the classes above, each stop taking its slowest counted ship. {{ versionNote }} Every jump is followed by a delay each ship draws from its own crew, the longest holding the fleet back, and a transit takes no time; the wait is counted for every jump of the way there and back, as a range from the lowest to the highest draws, and the round trip is the upper case, which also allows up to 12 hours for a transit retried after a blocked jump. Where a ship's crew is not in the save the round trip is not given.</div>
          <div class="panel-foot caption text--secondary" data-fuel-foot>A colony with a spaceport or refuelling station serves each ship at the race's refuelling rate from the stock above the local reserve. Stationary tankers with an undamaged transfer system serve from the fuel above the class minimum and the local reserve, richest first, and a tanker rated under 20,000 L/h serves recipients of 20 hull spaces or less only. The fleets shown draw on a shared stock one after another in the draw order, which is the order of the Fleets pick, or by fleet name when every fleet is shown, each fleet's whole round trip before the next, and which is not the order in time. Sorting the table changes neither that order nor any figure. {{ fillNote }} The fleet's own tankers are not counted, and a fleet starts with the fuel it has aboard now.</div>
        </v-card>

        <v-card class="panel" data-summary="The installations the colonies offer and ask for, and how much of each is already on its way." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Civilian work orders<provenance-mark rule="transport.shipments" label /></span>
              <template v-if="CivilianShippingLinesActive">
                <v-chip small class="ml-3">Supply {{ amount(workTotals.supply) }}</v-chip>
                <v-chip small class="ml-2">Demand {{ amount(workTotals.demand) }}</v-chip>
                <v-chip small class="ml-2">En route {{ amount(workTotals.out) }}</v-chip>
              </template>
            </span>
            <v-text-field v-if="CivilianShippingLinesActive" v-model="ordersSearch" label="Search" placeholder="Colony or installation" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
          </div>
          <div v-if="!CivilianShippingLinesActive" class="panel-body">Civilian shipping lines are off in this game, so no colony requests installations and no shipping line ships carry them.</div>
          <v-data-table v-else :headers="orderHeaders" :items="workVisible" item-key="key" group-by="InstallationName" :search="ordersSearch" :custom-filter="filterOrder" :sort-by.sync="ordersTable.sortBy" :sort-desc.sync="ordersTable.sortDesc" :items-per-page.sync="ordersTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" :no-data-text="workRows.length ? 'No work orders match the filters.' : 'No colony has asked for or offered an installation.'">
            <template #[`group.header`]="{ group, items, headers, isOpen, toggle }">
              <td :colspan="headers.length">
                <v-btn icon small :aria-label="isOpen ? `Collapse ${group}` : `Expand ${group}`" @click="toggle"><v-icon small>{{ isOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon></v-btn>
                <span class="font-weight-medium">{{ group }}</span>
                <span class="caption text--secondary ml-2">{{ groupSummary(items) }}</span>
              </td>
            </template>
            <template #[`item.colonyName`]="{ item }">
              <div class="py-2">
                <div>{{ item.colonyName }}</div>
                <div class="caption text--secondary">{{ item.systemName }}</div>
              </div>
            </template>
            <template #[`item.supply`]="{ item }"><span :class="{ 'text--secondary': !item.supply }">{{ amount(item.supply) }}</span></template>
            <template #[`item.demand`]="{ item }"><span :class="{ 'text--secondary': !item.demand }">{{ amount(item.demand) }}</span></template>
            <template #[`item.out`]="{ item }"><span :class="{ 'text--secondary': !item.out }">{{ amount(item.out) }}</span></template>
            <template #[`item.in`]="{ item }"><span :class="{ 'text--secondary': !item.in }">{{ amount(item.in) }}</span></template>
          </v-data-table>
          <div v-if="CivilianShippingLinesActive" class="panel-foot caption text--secondary">Use it to see what civilian shipping lines are carrying. A colony offers an installation as Supply and asks for one as Demand. When a shipping line ship sets off with a load, the game takes it from both the supplier's Supply and the buyer's Demand, so what is En route, out of a colony or toward it, is no longer counted in either. Shipping lines skip colonies marked military restricted. {{ idleNote }}</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import FleetProfile from '../components/page/FleetProfile.vue'
import FuelReserveReader from '../components/page/FuelReserveReader.vue'
import HandlingBreakdown from '../components/page/HandlingBreakdown.vue'
import AvoidOptions from '../components/page/AvoidOptions.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import RoutePositions from '../components/page/RoutePositions.vue'
import StatTiles from '../components/page/StatTiles.vue'
import capabilityGates from '../mixins/capability-gates'
import avoidRoutes from '../mixins/avoid-routes'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import handlingSupport from '../mixins/handling-support'
import loadState from '../mixins/load-state'
import persistedView, { tableView } from '../mixins/persisted-view'
import routePosition, { POSITION_INPUTS, POSITION_LABELS } from '../mixins/route-position'
import { loadHandlingSupport } from '../utilities/handling-support'
import { linkTo, queryPlaceKeys } from '../utilities/deep-links'
import { loadJumpPoints, pathKey, reverseSteps, routeLegs, searchRoutes } from '../utilities/jump-graph'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { colonyPlaces, filterPlace, searchable, systemPlaces } from '../utilities/places'
import { isAvailable } from '../utilities/provenance'
import { loadFormulaVersion } from '../utilities/capabilities'
import { amountText, describeTariffVersion, payoutRows } from '../utilities/civilian-tariff'
import { JUMP_DRIVE_COLUMNS, SHUTTLE_SERVICE_COLUMNS, SHUTTLE_STRENGTH_COLUMNS, colonyEndpoint, describeFormulaVersion, fleetCanTransit, handlingRows, roundTrip, routeBlockers, shuttleServiceJoin, transitRule, tripResult } from '../utilities/transport'
import { avoidFields, cutOffText, detourText, loadPlannedAvoidSystems, pathResult, planRun, unreadResult } from '../utilities/safe-routes'
import { fleetProfile, fleetTrip, fleetTripResult, loadFleetShips, participantRows } from '../utilities/fleet-profile'
import { SERVICE_BOUNDS, SERVICE_KINDS, SERVICE_REASONS, SERVICE_VERDICTS, ledgerNote, ledgerRows, loadFuelSites, netLedgers, serviceSeconds, timingKnown } from '../utilities/fuel-ledger'
import { distanceResult, simulateCycles } from '../utilities/route-plan'
import { fleetTimingOf, flightOnly, loadSystemDust, waitResult } from '../utilities/route-time'
import { cachedPropagation } from '../utilities/orbit-propagation'
import { ADAPTERS, CONDITIONS, figureOf, lagrangeEndpoint, placeEndpoint, routePositions, viaEndpoints, withPositions, withSavedComparison } from '../utilities/route-position'

const INPUT_LABELS = {
  systems: 'the known systems',
  jumpPoints: 'the jump points',
  lagrangePoints: 'the Lagrange points',
  colonies: 'the colonies',
  ships: 'the ships',
  requests: 'the installation requests',
  shipments: 'the installations in transit',
  formulaVersion: 'the save\'s schema',
  handlingSupport: 'the officers\' Logistics bonuses',
  avoidSystems: 'the danger and control of the systems',
  fleetShips: 'the ships of the fleets',
  fuelSites: 'the refuelling sites',
  systemDust: 'the nebula density of the systems',
  ...POSITION_LABELS,
}
// The reads that feed one optional feature alone: the page never waits for them, and each has its own note when it is not in (the officers' Logistics bonuses, the danger and control the avoid settings read, the ships of the fleets sailing together).
const OPTIONAL_INPUTS = ['handlingSupport', 'avoidSystems', 'fleetShips', 'fuelSites', ...POSITION_INPUTS]
const CORE_INPUTS = Object.keys(INPUT_LABELS).filter((key) => !OPTIONAL_INPUTS.includes(key))
const SECONDS_PER_DAY = 86400
const PAGE_SIZES = [15, 30, -1]

const OPTIONS = [
  { key: 'gatesOnly', config: 'transportGatesOnly', default: false, label: 'Stabilised jump points only', hint: 'Ships with a jump drive that covers their size use only jump points stabilised on both sides too, as the others always do.' },
  { key: 'useLagrange', config: 'transportUseLagrange', default: true, label: 'Use Lagrange points', hint: 'Jumps between stable Lagrange points inside a system when that is shorter.' },
  { key: 'showIdle', config: 'transportIdleRequests', default: false, label: 'Idle work orders', hint: 'Lists the requests in the civilian work orders that have nothing to supply, ask for or carry.' },
  { key: 'fillRequired', config: 'transportFillRequired', default: false, label: 'Take only what the run needs', hint: 'Each ship takes the litres the run to the next refuelling stop needs plus its reserve, not a full tank, which leaves more for the fleets behind it.' },
]
// Each option is kept on its own, for every game.
const OPTION_FIELDS = Object.fromEntries(OPTIONS.map((option) => [option.key, { key: option.config, default: option.default }]))

const STATUS = {
  ok: { label: 'Can run', icon: 'mdi-check-circle-outline', color: 'success' },
  blocked: { label: 'Can\'t load', icon: 'mdi-alert-circle-outline', color: 'warning' },
  range: { label: 'Out of range', icon: 'mdi-alert-circle-outline', color: 'warning' },
  unknown: { label: 'Not known', icon: 'mdi-help-circle-outline', color: 'warning' },
  immobile: { label: 'Can\'t move', icon: 'mdi-alert-circle-outline', color: 'warning' },
  unsupported: { label: 'Not supported', icon: 'mdi-help-circle-outline', color: 'warning' },
  noroute: { label: 'No route', icon: 'mdi-close-circle-outline', color: 'error' },
  none: { label: 'Nothing to move', icon: 'mdi-close-circle-outline', color: 'error' },
}

// Up to three names, then how many more.
const nameList = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : joinLabels(names))

const unique = (values) => [...new Set(values)]

// The order the fleets draw on a shared stock in: the order of the Fleets pick, and with no pick the fleets by name and then by FleetID. The table's sort never enters it, so no figure depends on how the rows are shown.
const drawOrderOf = (fleets, picked) => {
  const rank = new Map(picked.map((fleetId, index) => [fleetId, index]))

  return picked.length ? [...fleets].sort((a, b) => rank.get(a.FleetID) - rank.get(b.FleetID)) : [...fleets].sort((a, b) => a.FleetName.localeCompare(b.FleetName) || a.FleetID - b.FleetID)
}

// A place of the run as a stop of the ledger: the colony it is, when it is one.
const stopOf = (place) => ({ name: place.name, PopulationID: place.kind === 'colony' ? place.colony.PopulationID : null, SystemID: place.SystemID, Xcor: place.Xcor, Ycor: place.Ycor })

// The seconds a refuelling adds at each end of a cycle, from the ledger's hours (the opening and the closing fill at the origin together): none where the ledger has no figure.
const serviceOf = (ledger) => {
  const seconds = serviceSeconds(ledger)

  return seconds ? { origin: seconds.origin, destination: seconds.destination } : null
}

const sumOf = (list) => list.reduce((total, value) => total + value, 0)

const capitalised = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

export default {
  name: 'TransportPage',
  components: { AvoidOptions, FleetProfile, FuelReserveReader, HandlingBreakdown, LoadState, PageLink, ProvenanceMark, RoutePositions, StatTiles },
  mixins: [
    avoidRoutes,
    capabilityGates,
    countFormat,
    deepLink,
    handlingSupport,
    routePosition,
    loadState(INPUT_LABELS),
    persistedView({
      fromKey: { key: 'transportFrom', default: null, scope: 'race' },
      toKey: { key: 'transportTo', default: null, scope: 'race' },
      fleetIds: { key: 'transportFleets', default: [], scope: 'race', valid: (value) => Array.isArray(value) },
      ...OPTION_FIELDS,
      ...avoidFields('transport'),
      ordersSearch: { key: 'transportOrdersSearch', default: '', scope: 'race' },
      classesTable: tableView('transportClassesTable', { sortBy: ['tonsYear'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      fleetsTable: tableView('transportFleetsTable', { sortBy: ['tonsYear'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
      ordersTable: tableView('transportOrdersTable', { sortBy: ['demand'], sortDesc: [true], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      expanded: [],
      fleetsExpanded: [],
      fuelReserveRead: null,
      optionList: OPTIONS,
      pageSizes: PAGE_SIZES,
      STATUS,
      SECONDS_PER_DAY,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'CivilianShippingLinesActive']),
    ...mapState(['RaceNPR']),

    // The reads that hold the page back: every one but the officers' bonuses, which have their own note.
    failedInputs() {
      return CORE_INPUTS.filter((key) => this.loadErrors[key])
    },

    inputsLoaded() {
      return allLoaded(this.loadErrors, CORE_INPUTS)
    },

    options() {
      return Object.fromEntries(OPTIONS.map((option) => [option.key, this[option.key]]))
    },

    activeOptionCount() {
      return OPTIONS.filter((option) => this.options[option.key] !== option.default).length
    },

    systemById() {
      return Object.fromEntries(this.systems.map((system) => [system.SystemID, system]))
    },

    jumpPointById() {
      return Object.fromEntries(this.jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
    },

    restricted() {
      return new Set(this.systems.filter((system) => system.MilitaryRestrictedSystem).map((system) => system.SystemID))
    },

    // Where a run can start or end: colonies at their bodies, systems at their centre.
    places() {
      const { systemById } = this
      const systemName = (systemId) => (systemById[systemId] || {}).Name || ''

      return searchable([...colonyPlaces(this.colonies, systemName), ...systemPlaces(this.systems)], systemName)
    },

    placeByKey() {
      return Object.fromEntries(this.places.map((place) => [place.key, place]))
    },

    // The saved origin, else the capital.
    origin() {
      return this.placeByKey[this.fromKey] || this.places.find((place) => place.Capital) || this.places[0] || null
    },

    destination() {
      const place = this.placeByKey[this.toKey]

      return place && this.origin && place.key !== this.origin.key ? place : null
    },

    // The endpoints whose orbits are read: the two ends of the run and the Lagrange points a route may jump between.
    orbitEndpoints() {
      const ends = [this.origin, this.destination].filter(Boolean).map(placeEndpoint).filter((endpoint) => ['body', 'colony', 'lagrange-point'].includes(endpoint.family))

      return [...ends, ...(this.useLagrange ? this.lagrangePoints.map(lagrangeEndpoint) : [])]
    },

    // The positions the run's figures rest on, for the strip above them: those of every run's simulated year (utilities/route-plan.js `simulateCycles`) with the saved positions the displayed distances are measured on (each run's own, its Lagrange points included) and the endpoints at departure behind them, and the ends alone when no run has been flown. The saved ones stay observations of their own (`withSavedComparison`): a place that a distance takes at its saved position is stated as saved beside the one the year moved, so the strip reads mixed and never lets one replace the other. Null until there is a destination. A figure that kept the saved positions says why. The Lagrange points a route may jump between are stated on the run's own figures.
    endpointPositions() {
      if (!this.origin || !this.destination) {
        return null
      }

      const ends = routePositions([placeEndpoint(this.origin), placeEndpoint(this.destination)], { facts: this.positionRead })
      const runs = [...this.runs, ...this.fleetRuns]
      const flown = runs.filter((run) => run.simulation).flatMap((run) => run.simulation.annual.positions.records)
      const saved = runs.filter((run) => run.savedPositions).flatMap((run) => run.savedPositions.records)

      return withSavedComparison(flown, [...ends.records, ...saved])
    },

    // The run as a link names it: the origin, and the destination once there is one. Not known until the places are read.
    linkQuery() {
      return this.ready && this.origin ? linkTo.transport({ from: this.origin.key, to: this.destination && this.destination.key }).query : null
    },

    linkLabel() {
      if (!this.origin) {
        return ''
      }

      return this.destination ? `${this.origin.name} → ${this.destination.name}` : this.origin.name
    },

    routesLink() {
      return linkTo.routes({ from: this.origin.key, to: this.destination.key })
    },

    // Fleets that carry something, with their ships in classes that do, and whether the fleet can cross jump points that are not stabilised on its own.
    groups() {
      const byFleet = new Map()

      this.ships.forEach((ship) => {
        if (!byFleet.has(ship.FleetID)) {
          byFleet.set(ship.FleetID, { FleetID: ship.FleetID, FleetName: ship.FleetName, civilian: Boolean(ship.ShippingLine), ships: [] })
        }

        byFleet.get(ship.FleetID).ships.push(ship)
      })

      return [...byFleet.values()].map((group) => {
        const classes = new Map()

        group.ships.filter((ship) => ship.CargoCapacity > 0 || ship.ColonistCapacity > 0).forEach((ship) => {
          if (!classes.has(ship.ShipClassID)) {
            classes.set(ship.ShipClassID, { ShipClassID: ship.ShipClassID, ClassName: ship.ClassName, ships: [] })
          }

          classes.get(ship.ShipClassID).ships.push(ship)
        })

        return { ...group, canTransit: fleetCanTransit(group.ships), classes: [...classes.values()] }
      }).filter((group) => group.classes.length)
    },

    militaryGroups() {
      return this.groups.filter((group) => !group.civilian)
    },

    fleetOptions() {
      return this.militaryGroups.map((group) => ({
        FleetID: group.FleetID,
        FleetName: group.FleetName,
        summary: group.classes.map((shipClass) => `${shipClass.ships.length} × ${shipClass.ClassName}`).join(', '),
      })).sort((a, b) => a.FleetName.localeCompare(b.FleetName))
    },

    // The picked fleets that still exist; none picked means every fleet.
    chosenFleetIds() {
      const existing = new Set(this.militaryGroups.map((group) => group.FleetID))

      return this.fleetIds.filter((fleetId) => existing.has(fleetId))
    },

    // Where each kind of ship can go from the origin: `reachOf(group)` gives { route, open, profile, blockers, safe, pending }, the route its profile can sail under the avoid settings (every figure of a run comes from it), the route without any rule, what its rules stop on that one, what the avoid settings did to it (safe-routes.js `planRun`: its baseline, detour and cut-off systems) and whether the danger and control they read are still to come (no route is planned then).
    reachOf() {
      const { jumpPoints, jumpPointById, restricted, origin, destination, gatesOnly, systemById, avoid, avoidPending } = this
      const lagrangePoints = this.useLagrange ? this.lagrangePoints : []
      const systemName = (systemId) => (systemById[systemId] || {}).Name || `System #${systemId}`
      const searches = {}
      const reaches = {}
      const find = (profile) => {
        if (!origin || !destination) {
          return null
        }

        const key = `${profile.gates}:${profile.civilian}`

        if (!searches[key]) {
          searches[key] = searchRoutes(jumpPoints, [origin], { order: 'jumps', ...transitRule(profile, jumpPointById, restricted), lagrangePoints })
        }

        return searches[key].toPlace(destination)
      }

      return (group) => {
        const profile = { gates: gatesOnly || !group.canTransit, civilian: group.civilian }
        const key = `${profile.gates}:${profile.civilian}`

        if (!reaches[key]) {
          const safe = origin && destination ? planRun({ jumpPoints, origin, destination, order: 'jumps', lagrangePoints, transit: transitRule(profile, jumpPointById, restricted), avoid }) : null
          const baseline = safe && safe.baseline
          const route = avoidPending || !safe ? null : safe.route
          const open = baseline || find({ gates: false, civilian: false })

          reaches[key] = { route, open, profile, blockers: baseline || !open ? [] : routeBlockers(open, profile, restricted, systemName), safe, pending: avoidPending }
        }

        return reaches[key]
      }
    },

    // The formula version the save's schema stands for, in words for a panel foot.
    versionNote() {
      return describeFormulaVersion(this.formulaVersion)
    },

    // The two ends of the run as places a ship loads or unloads: a colony with the spaceports and cargo shuttle stations it has, and a system as a colony site with none.
    endpoints() {
      const endpointOf = (place) => (place ? colonyEndpoint(place.kind === 'colony' ? place.colony : { ShuttleCapacity: 0, SystemID: place.SystemID }, place.name) : null)

      return { origin: endpointOf(this.origin), destination: endpointOf(this.destination) }
    },

    // One entry per class in each fleet that is picked (every shipping line fleet too, while shipping lines are on), timed on its own.
    runs() {
      const { reachOf, endpoints, destination } = this
      const chosen = new Set(this.chosenFleetIds)
      const runs = []

      if (!destination) {
        return runs
      }

      this.groups.forEach((group) => {
        if (group.civilian ? !this.CivilianShippingLinesActive : chosen.size && !chosen.has(group.FleetID)) {
          return
        }

        const reach = reachOf(group)

        group.classes.forEach((shipClass) => runs.push({ ...this.runOf(group, shipClass, reach, endpoints), ...this.safeFields(reach) }))
      })

      return runs
    },

    rows() {
      return this.runs.filter((run) => !run.civilian)
    },

    civilianRuns() {
      return this.runs.filter((run) => run.civilian)
    },

    // The military fleets that have a hold or colony bays, each with all its ships as one fleet and whether it can cross jump points that are not stabilised on its own.
    fleetGroups() {
      const byFleet = new Map()

      this.fleetShips.forEach((ship) => {
        if (!byFleet.has(ship.FleetID)) {
          byFleet.set(ship.FleetID, { FleetID: ship.FleetID, FleetName: ship.FleetName, ships: [] })
        }

        byFleet.get(ship.FleetID).ships.push(ship)
      })

      return [...byFleet.values()].map((fleet) => ({ ...fleet, canTransit: fleetCanTransit(fleet.ships) }))
    },

    // The fleets read: { loading, failed, error } of the optional ships read.
    fleetShipsState() {
      const state = this.loadErrors.fleetShips

      return { loading: state === undefined, failed: typeof state === 'string', error: typeof state === 'string' ? state : '' }
    },

    // The fuel the player keeps at colonies and on ships as the ledger reads it, null while the records are not read.
    fuelReserveReader() {
      return this.fuelReserveRead && this.fuelReserveRead.ready ? this.fuelReserveRead.reader : null
    },

    // What the optional reads behind the ledgers say while they are in flight or failed: a note for each, with the read to try again when it failed.
    fuelNotes() {
      const sites = this.loadErrors.fuelSites
      const reserves = this.fuelReserveRead
      const notes = []

      if (sites === undefined) {
        notes.push({ key: 'sites', tone: 'text--secondary', text: 'Reading the refuelling sites.', retry: null })
      } else if (typeof sites === 'string') {
        notes.push({ key: 'sites', tone: 'warning--text', text: `The refuelling sites could not be read: ${sites}`, retry: this.retryFuelSites })
      }

      if (reserves && reserves.failed) {
        notes.push({ key: 'reserves', tone: 'warning--text', text: `The fuel reserves could not be read: ${reserves.error}`, retry: reserves.retry })
      } else if (reserves && reserves.loading) {
        notes.push({ key: 'reserves', tone: 'text--secondary', text: 'Reading the fuel reserves.', retry: null })
      }

      return notes
    },

    // What the foot says of the fill target.
    fillNote() {
      return this.fillRequired ? 'Each ship takes only what the run to the next refuelling stop needs, with its reserve, as the option is on.' : 'Each ship is filled to a full tank where a stop serves; the option to take only what the run needs draws less and leaves more for the fleets behind.'
    },

    // One entry per picked military fleet, sailing as one, on the route: every ship at the fleet's one speed. The fleets are planned in the draw order, each one's whole round trip drawing on the stock the fleets before it left: first on the kilometres of the saved positions, which give each fleet's first simulated cycle, then again on the kilometres that cycle flew, so what a fleet draws is what it flies.
    fleetRuns() {
      const { endpoints, destination } = this
      const chosen = new Set(this.chosenFleetIds)

      if (!destination || this.loadErrors.fleetShips !== null) {
        return []
      }

      const setups = drawOrderOf(this.fleetGroups.filter((fleet) => !chosen.size || chosen.has(fleet.FleetID)), this.chosenFleetIds).map((fleet) => this.fleetSetupOf(fleet))
      const held = this.fleetLedgers(setups, (setup) => [setup.reach.route.km, setup.reach.route.km])
      const stages = new Map(setups.filter((setup) => setup.ledgerable).map((setup) => [setup.fleet.FleetID, this.fleetStageOf(setup, endpoints, held.get(setup.fleet.FleetID))]))
      const flown = this.fleetLedgers(setups, (setup) => this.flownLegs(setup, stages.get(setup.fleet.FleetID)))

      return setups.map((setup) => this.fleetRunOf(setup, endpoints, stages.get(setup.fleet.FleetID), flown.get(setup.fleet.FleetID)))
    },

    fleetHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'Ships', value: 'ships', align: 'end' },
        { text: 'Cargo / trip', value: 'cargo', align: 'end' },
        { text: 'Colonists / trip', value: 'colonists', align: 'end' },
        { text: 'Speed', value: 'speed', align: 'end' },
        { text: 'Round trip', value: 'tripDays', align: 'end' },
        { text: 'Trips / yr', value: 'trips', align: 'end' },
        { text: 'Tons / yr', value: 'tonsYear', align: 'end' },
        { text: 'Colonists / yr', value: 'colonistsYear', align: 'end' },
        { text: 'Fuel / trip', value: 'fuel', align: 'end' },
        { text: 'Draw', value: 'draw', align: 'end' },
        { text: 'Status', value: 'statusSort' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    // What a shipping line is paid over the run, at the rates of the save's game version: one unit of each category over the measured route in billion km, with the result the figures rest on, or why no figure is given. Null while shipping lines are off or no destination is picked.
    payoutNote() {
      const { destination, formulaVersion: version } = this

      if (!destination || !this.CivilianShippingLinesActive) {
        return null
      }

      const kms = this.civilianRuns.filter((run) => run.status !== 'noroute' && !run.pending).map((run) => run.km)
      const npr = this.RaceNPR
      const unknown = payoutRows({ version, km: null, npr })

      if (!unknown.some((row) => isAvailable(row.rate))) {
        return { text: 'No payout is estimated: the save\'s game version has no published payout rates.', result: unknown[0].payout }
      } else if (!kms.length) {
        return { text: 'No payout is estimated: no shipping line ship has a route to the destination, so no distance is measured.', result: unknown[0].payout }
      }

      const shortest = Math.min(...kms)
      const longest = Math.max(...kms)
      const near = payoutRows({ version, km: shortest, npr })
      const far = payoutRows({ version, km: longest, npr })
      const parts = near.map((row, index) => {
        const { category, rate } = row

        if (!isAvailable(rate) || !isAvailable(row.payout)) {
          return `${category.label}: not estimated, needs ${(isAvailable(rate) ? row.payout : rate).inputs.missing.join(' and ')}`
        }

        const low = this.amountText(row.payout.value)
        const high = this.amountText(far[index].payout.value)

        return `${category.label} ${this.amountText(rate.value)} a unit per billion km, ${low === high ? low : `${low} to ${high}`} a unit over the route`
      })

      return { text: `${describeTariffVersion(version)}${npr ? ', with a computer-run empire paid half' : ''}, over the measured route of ${shortest === longest ? this.distance(shortest) : `${this.distance(shortest)} to ${this.distance(longest)}`} one way: ${parts.join('; ')}. A payout goes to the shipping line, and no stored link ties it to a treasury use, so no cost to the race is claimed.`, result: near[0].payout }
    },

    // What keeps fleets from the destination, said once for the fleets it stops: the military fleets and, while shipping lines are on, the shipping line fleets too.
    problems() {
      const byNote = new Map()

      this.runs.filter((row) => row.status === 'noroute').forEach((row) => {
        byNote.set(row.note, [...(byNote.get(row.note) || []), row.FleetName])
      })

      return [...byNote].map(([note, names]) => ({ text: `${nameList(unique(names))}: ${note}` }))
    },

    noRowsText() {
      if (!this.destination) {
        return 'Pick a destination to time the run.'
      }

      return this.militaryGroups.length ? 'No picked fleet carries cargo or colonists.' : 'None of the fleets has cargo holds or colony bays.'
    },

    tiles() {
      const working = this.rows.filter((row) => row.status === 'ok')
      const unknownRows = this.rows.filter((row) => row.status === 'unknown')
      const idle = this.rows.filter((row) => row.status !== 'ok' && row.status !== 'unknown').reduce((total, row) => total + row.ships, 0)
      const unknown = unknownRows.reduce((total, row) => total + row.ships, 0)
      const sum = (list, field) => list.reduce((total, row) => total + row[field], 0)
      const trips = working.reduce((total, row) => total + row.ships * row.trips, 0)
      const shortest = Math.min(...working.map((row) => row.km))
      const longest = Math.max(...working.map((row) => row.km))
      const first = working[0]
      const idleNote = [idle ? `${this.count(idle)} ${idle === 1 ? 'ship' : 'ships'} can't work the route` : '', unknown ? `${this.count(unknown)} ${unknown === 1 ? 'ship is' : 'ships are'} not known to load there` : ''].filter(Boolean).join('; ')
      const none = !this.destination ? 'Pick a destination above' : this.rows.length ? (unknown ? 'No picked fleet is known to work this route' : 'No picked fleet can work this route') : 'No fleet carries cargo or colonists'
      const civilian = this.civilianRuns.filter((run) => run.status === 'ok')
      const civilianShips = this.civilianRuns.reduce((total, run) => total + run.ships, 0)
      const civilianUnknown = this.civilianRuns.some((run) => run.status === 'unknown')
      const cargo = sum(working, 'cargo')
      const colonists = sum(working, 'colonists')
      const tonsYear = sum(working, 'tonsYear')
      const colonistsYear = sum(working, 'colonistsYear')
      const civilianTonsYear = sum(civilian, 'tonsYear')
      const yearOf = (runs, rule, value, units) => figureOf({ rule, results: runs.map((run) => run.provenance), value, units })

      return [
        {
          label: 'Freight a year',
          value: working.length ? `${this.count(tonsYear)} t` : '—',
          result: yearOf(working, 'transport.freightPerYear', tonsYear, 't/yr'),
          note: working.length ? [cargo ? `${this.count(cargo)} t a trip in ${this.count(sum(working, 'ships'))} ships` : 'No fleet that can run has a cargo hold', idleNote].filter(Boolean).join('; ') : none,
        },
        {
          label: 'Colonists a year',
          value: working.length ? this.count(colonistsYear) : '—',
          result: yearOf(working, 'transport.freightPerYear', colonistsYear, 'colonists/yr'),
          note: !working.length ? none : colonists ? `${this.count(colonists)} a trip` : 'No fleet that can run has colony bays',
        },
        {
          label: 'Trips a year',
          value: working.length ? this.count(trips, 1) : '—',
          result: yearOf(working, 'transport.freightPerYear', trips, 'trips/yr'),
          note: !working.length ? none : shortest === longest ? `${first.jumps} ${first.jumps === 1 ? 'jump' : 'jumps'}, ${this.distance(first.km)} one way` : `${this.distance(shortest)} to ${this.distance(longest)} one way`,
        },
        {
          label: 'Civilian freight a year',
          value: !this.CivilianShippingLinesActive ? 'Off in this game' : civilian.length ? `${this.count(civilianTonsYear)} t` : '—',
          result: this.CivilianShippingLinesActive ? yearOf(civilian, 'transport.civilianFreight', civilianTonsYear, 't/yr') : null,
          note: !this.CivilianShippingLinesActive ? 'Shipping lines are not run here' : !this.destination ? 'Pick a destination above' : civilian.length ? `${this.count(sum(civilian, 'colonistsYear'))} colonists a year, from ${this.count(sum(civilian, 'ships'))} of ${this.count(civilianShips)} ships` : civilianShips ? (civilianUnknown ? 'None of the shipping line ships is known to work the route' : 'None of the shipping line ships can work the route') : 'The shipping lines have no ships',
        },
      ]
    },

    classHeaders() {
      return [
        { text: 'Fleet', value: 'FleetName' },
        { text: 'Ships', value: 'ships', align: 'end' },
        { text: 'Cargo / trip', value: 'cargo', align: 'end' },
        { text: 'Colonists / trip', value: 'colonists', align: 'end' },
        { text: 'Speed', value: 'speed', align: 'end' },
        { text: 'Round trip', value: 'tripDays', align: 'end' },
        { text: 'Trips / yr', value: 'trips', align: 'end' },
        { text: 'Tons / yr', value: 'tonsYear', align: 'end' },
        { text: 'Colonists / yr', value: 'colonistsYear', align: 'end' },
        { text: 'Fuel / trip', value: 'fuel', align: 'end' },
        { text: 'Status', value: 'statusSort' },
        { text: '', value: 'data-table-expand' },
      ]
    },

    orderHeaders() {
      return [
        { text: 'Colony', value: 'colonyName' },
        { text: 'Supply', value: 'supply', align: 'end' },
        { text: 'Demand', value: 'demand', align: 'end' },
        { text: 'En route out', value: 'out', align: 'end' },
        { text: 'En route in', value: 'in', align: 'end' },
      ]
    },

    colonyById() {
      return Object.fromEntries(this.colonies.map((colony) => [colony.PopulationID, colony]))
    },

    // One row per colony and installation: what it supplies and demands, and what shipping lines carry out of it and toward it.
    workRows() {
      const { colonyById, systemById } = this
      const rows = {}
      const rowFor = (populationId, installationId, installationName) => {
        const key = `${populationId}:${installationId}`

        if (!rows[key]) {
          const colony = colonyById[populationId]

          rows[key] = {
            key,
            InstallationName: installationName,
            colonyName: colony ? colony.PopName : `Colony #${populationId}`,
            systemName: colony ? (systemById[colony.SystemID] || {}).Name || '' : '',
            supply: 0,
            demand: 0,
            out: 0,
            in: 0,
          }
        }

        return rows[key]
      }

      this.requests.forEach((request) => {
        rowFor(request.PopulationID, request.InstallationID, request.InstallationName)[request.Export ? 'supply' : 'demand'] += request.Amount
      })

      this.shipments.forEach((shipment) => {
        rowFor(shipment.OriginPopulationID, shipment.InstallationID, shipment.InstallationName).out += shipment.Amount

        if (shipment.DestinationPopulationID) {
          rowFor(shipment.DestinationPopulationID, shipment.InstallationID, shipment.InstallationName).in += shipment.Amount
        }
      })

      return Object.values(rows)
    },

    workVisible() {
      return this.showIdle ? this.workRows : this.workRows.filter((row) => row.supply || row.demand || row.out || row.in)
    },

    workTotals() {
      return this.workVisible.reduce((totals, row) => ({ supply: totals.supply + row.supply, demand: totals.demand + row.demand, out: totals.out + row.out }), { supply: 0, demand: 0, out: 0 })
    },

    idleNote() {
      const hidden = this.workRows.length - this.workVisible.length

      return hidden ? `${this.count(hidden)} ${hidden === 1 ? 'request' : 'requests'} with nothing to supply, ask for or carry ${hidden === 1 ? 'is' : 'are'} hidden; the Options list them.` : ''
    },
  },
  methods: {
    filterPlace,

    filterOrder(_value, query, item) {
      return `${item.colonyName} ${item.systemName} ${item.InstallationName}`.toLowerCase().includes(query.toLowerCase())
    },

    // The picks the query names; one it leaves out is cleared, so the origin is the capital again and there is no destination. They are plain keys, so a link that arrives before the places are read lands on its pair once they load.
    applyLink(query) {
      const [from] = queryPlaceKeys(query.from)
      const [to] = queryPlaceKeys(query.to)

      this.fromKey = from || null
      this.toKey = to || null
    },

    setFrom(key) {
      if (key) {
        this.fromKey = key
      }
    },

    setTo(key) {
      this.toKey = key || null
    },

    setFleets(ids) {
      this.fleetIds = ids || []
    },

    setOption(key, value) {
      this[key] = Boolean(value)
    },

    swap() {
      const from = this.origin.key

      this.setFrom(this.destination.key)
      this.setTo(from)
    },

    // A class in a fleet on a route: what it carries, how long a round trip takes and whether it can run.
    runOf(group, shipClass, reach, endpoints) {
      const [first] = shipClass.ships
      const count = shipClass.ships.length
      const base = {
        key: `${group.FleetID}:${shipClass.ShipClassID}`,
        FleetID: group.FleetID,
        FleetName: group.FleetName,
        ClassName: shipClass.ClassName,
        civilian: group.civilian,
        ships: count,
        cargo: Number.isFinite(first.CargoCapacity) ? count * first.CargoCapacity : null,
        colonists: Number.isFinite(first.ColonistCapacity) ? count * first.ColonistCapacity : null,
        speed: first.MaxSpeed,
        jumps: 0,
        km: 0,
        tripSeconds: null,
        travelSeconds: null,
        handlingSeconds: null,
        tripDays: null,
        trips: null,
        tonsYear: null,
        colonistsYear: null,
        fuel: null,
        fuelShare: null,
        provenance: null,
        results: null,
        statusSort: 4,
        status: 'noroute',
        note: '',
      }

      if (reach.pending) {
        return { ...base, status: 'unknown', statusSort: 1, pending: true, provenance: unreadResult(), note: this.avoidNote.text }
      } else if (!reach.route) {
        return { ...base, note: this.reachNote(group, reach) }
      }

      const heldTrip = roundTrip(shipClass.ships, reach.route.km, endpoints, first.ShuttleTechnology, { colonists: true, version: this.formulaVersion, support: this.officerSupport, jumps: reach.route.jumps })
      const simulation = this.simulate(reach, first.MaxSpeed, heldTrip)
      const trip = simulation && simulation.annual.status === 'propagated' ? roundTrip(shipClass.ships, simulation.annual.meanKm, endpoints, first.ShuttleTechnology, { colonists: true, version: this.formulaVersion, support: this.officerSupport, jumps: reach.route.jumps }) : heldTrip
      // Shipping line ships are timed without the fuel limit.
      const status = group.civilian && trip.status === 'range' ? 'ok' : trip.status
      const works = status === 'ok'
      const timed = works || status === 'range'
      const positions = simulation ? simulation.annual.positions : this.positionsOf(reach)
      const yearly = (value) => ({ days: value.tripSeconds / SECONDS_PER_DAY, trips: value.trips, tons: base.cargo === null ? null : base.cargo * value.trips, colonists: base.colonists === null ? null : base.colonists * value.trips })
      const run = { ...base, status, jumps: reach.route.jumps, km: reach.route.km, tripSeconds: trip.tripSeconds, travelSeconds: trip.travelSeconds, handlingSeconds: trip.handlingSeconds, limiting: trip.limiting, provenance: withPositions(tripResult(trip), positions), estimate: trip.estimate, handlingRows: handlingRows(trip.stops.map((stop, index) => ({ key: `${base.key}-${index}`, label: `${stop.where === 'origin' ? 'Loading' : 'Unloading'} ${stop.kind} at ${endpoints[stop.where].place}`, breakdown: stop.breakdown }))), statusSort: works ? 0 : 1, simulation, propagation: timed && simulation && simulation.annual.compared ? this.propagationOf(simulation, yearly(heldTrip), yearly(trip), works) : null }
      const problems = trip.problems.map((problem) => `${problem.text.charAt(0).toUpperCase()}${problem.text.slice(1)}`).join('; ')

      if (works) {
        const figure = (rule, value, units) => figureOf({ rule, results: [run.provenance], value, units })
        const results = { trips: figure('transport.freightPerYear', trip.trips, 'trips/yr'), tonsYear: figure('transport.freightPerYear', base.cargo === null ? null : base.cargo * trip.trips, 't/yr'), colonistsYear: figure('transport.freightPerYear', base.colonists === null ? null : base.colonists * trip.trips, 'colonists/yr'), fuel: figure('transport.fuelPerTrip', trip.fuelPerShip * count, 'L'), fuelShare: figure('transport.fuelPerTrip', trip.fuelShare * 100, '%') }

        return { ...run, results, tripDays: trip.tripSeconds / SECONDS_PER_DAY, trips: trip.trips, tonsYear: base.cargo === null ? null : base.cargo * trip.trips, colonistsYear: base.colonists === null ? null : base.colonists * trip.trips, fuel: trip.fuelPerShip * count, fuelShare: trip.fuelShare }
      } else if (status === 'range') {
        return { ...run, note: `A round trip needs ${this.count(trip.fuelShare * 100)}% of a tank.` }
      } else if (status === 'unknown') {
        return { ...run, note: `Not known whether the class can load: ${problems}.` }
      } else if (status === 'immobile') {
        return { ...run, note: 'The class has no top speed.' }
      }

      return { ...run, note: problems ? `${problems}.` : '' }
    },

    // What the avoid settings did to a run, for its row: the detour as text and the distance as a result (null while none is on).
    safeFields(reach) {
      const detour = reach.safe && reach.safe.detour

      return { detourText: detour ? detourText(detour, this.distance) : '', pathResult: this.pathOf(reach), savedPositions: reach.route ? this.positionsOf(reach) : null }
    },

    // The positions a run's endpoints and the Lagrange points of its route are held at (utilities/route-position.js).
    positionsOf(reach) {
      return routePositions([placeEndpoint(this.origin), placeEndpoint(this.destination), ...viaEndpoints(reach.route)], { facts: this.positionRead })
    },

    // A run's distance as a result: the avoid settings' own while they are on, else the plain distance, stated with the positions it rests on. Null with no route, or when neither has anything to say.
    pathOf(reach) {
      if (!reach.route) {
        return null
      }

      const positions = this.positionsOf(reach)

      if (!this.avoid.active && !positions.caveat) {
        return null
      }

      return withPositions(this.avoid.active ? pathResult(reach.route, this.avoid) : distanceResult(reach.route.km), positions)
    },

    // Why a profile of ships can't sail from the origin to the destination.
    reachNote(group, { open, blockers, profile, safe }) {
      if (!open) {
        return 'No explored jump route connects them.'
      } else if (safe && safe.status === 'blocked') {
        return cutOffText(safe.cutOff)
      }

      const hint = !profile.gates ? '' : group.canTransit ? ' The Stabilised jump points only option is on.' : ` A jump drive that covers the ship would make it ${open.jumps} ${open.jumps === 1 ? 'jump' : 'jumps'}.`

      return `Can't pass ${nameList(blockers)}.${hint}`
    },

    retryFleetShips() {
      this.$asyncComputed.fleetShips.update()
    },

    retryFuelSites() {
      this.$asyncComputed.fuelSites.update()
    },

    // What a fleet needs to be planned on the run: its profile, the reach of its ships, and whether a ledger can be worked out for it (its profile runs and a route exists).
    fleetSetupOf(fleet) {
      const profile = fleetProfile(fleet.ships, fleet, { basis: 'maximum' })
      const reach = this.reachOf({ FleetID: fleet.FleetID, FleetName: fleet.FleetName, canTransit: fleet.canTransit, civilian: false })

      return { fleet, profile, reach, ledgerable: profile.status === 'ok' && !reach.pending && Boolean(reach.route) }
    },

    // The ledgers of the fleets that can have one, drawn in the order given: a Map of FleetID to the ledger (`netLedgers`), each over the legs `legsOf(setup)` gives, out and back, with the stops origin, destination and the origin again.
    fleetLedgers(setups, legsOf) {
      const members = setups.filter((setup) => setup.ledgerable)
      const stops = [stopOf(this.origin), stopOf(this.destination), stopOf(this.origin)]
      const { ledgers } = netLedgers(members.map((setup) => ({ name: setup.fleet.FleetName, profile: setup.profile, legs: legsOf(setup), stops, cycle: true })), { sites: this.loadErrors.fuelSites === null ? this.fuelSites || null : null, reserves: this.fuelReserveReader || null, version: this.formulaVersion, target: this.fillRequired ? 'required' : 'full' })

      return new Map(members.map((setup, index) => [setup.fleet.FleetID, ledgers[index]]))
    },

    // A fleet's round trip with the time its refuelling takes: the timing of its route, the trip on the saved positions, the first simulated year of it, whether the flights of that year are the ones the trip is timed on (`moved`) and whether those flights are not known because the refuelling hours that move the bodies on are not (`clockUnknown`: the hours are not known and the bodies move, or the year is capped at the hours the ledger counts, which shorter or longer hours may not be).
    fleetStageOf(setup, endpoints, ledger) {
      const { profile, reach } = setup
      const timing = { ...fleetTimingOf(profile.participants, this.systemDust), steps: routeLegs(reach.route) }
      const heldTrip = fleetTrip(profile, reach.route.km, endpoints, { colonists: true, version: this.formulaVersion, support: this.officerSupport, timing, service: serviceOf(ledger) })
      const first = this.simulate(reach, profile.cruise, heldTrip)
      const stage = { timing, heldTrip, first, moved: false }
      const flown = this.flownTripOf(setup, endpoints, stage, ledger)
      const moved = Boolean(flown) && flightOnly(flown.cycle, profile.cruise)
      const capped = Boolean(first) && first.annual.reasons.includes('cycles-capped')

      return { ...stage, moved, clockUnknown: (moved || capped) && !timingKnown(ledger) }
    },

    // The round trip flown on the kilometres of the first simulated cycle: null when the bodies' movement left the saved positions standing.
    flownTripOf(setup, endpoints, stage, ledger) {
      const { first, timing } = stage

      return first && first.annual.status === 'propagated' ? fleetTrip(setup.profile, first.annual.meanKm, endpoints, { colonists: true, version: this.formulaVersion, support: this.officerSupport, timing: { ...timing, flights: { out: first.annual.flights[0], back: first.annual.flights[1] } }, service: serviceOf(ledger) }) : null
    },

    // The kilometres of the way out and of the way back a fleet's ledger runs on: those of the year's first cycle where the round trip is timed on them, the route's own otherwise, and not known where the bodies move on a refuelling clock that is not known.
    flownLegs(setup, stage) {
      const { km } = setup.reach.route

      return stage.clockUnknown ? [null, null] : stage.moved ? [sumOf(stage.first.annual.flights[0]), sumOf(stage.first.annual.flights[1])] : [km, km]
    },

    // A fleet sailing together on a route: the one speed its ships share, what it carries by the holds that count, how long a round trip takes and whether it can run, with each ship as a participant. `setup` as `fleetSetupOf`, `stage` as `fleetStageOf` and `ledger` the fleet's ledger (`fleetLedgers`): the ledger decides whether the fuel lasts where the round trip itself can run.
    fleetRunOf(setup, endpoints, stage, ledger) {
      const { fleet, profile, reach } = setup
      const capital = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
      const ok = profile.status === 'ok'
      const base = {
        key: String(fleet.FleetID),
        FleetID: fleet.FleetID,
        FleetName: fleet.FleetName,
        ships: profile.participants.length,
        independent: profile.participants.filter((participant) => participant.role === 'independent').length,
        cargo: ok ? profile.cargo.counted.cargo : null,
        colonists: ok ? profile.cargo.counted.colonists : null,
        speed: profile.cruise,
        savedSpeed: profile.savedSpeed,
        effectiveMax: profile.effectiveMax,
        jumps: 0,
        km: 0,
        tripSeconds: null,
        travelSeconds: null,
        handlingSeconds: null,
        tripDays: null,
        timingKnown: true,
        trips: null,
        tonsYear: null,
        colonistsYear: null,
        fuel: null,
        fuelShare: null,
        fuelLimiting: '',
        draw: null,
        drawOf: null,
        drawTitle: '',
        ledger: null,
        ledgerView: null,
        returnShare: null,
        returnLimiting: '',
        provenance: null,
        results: null,
        handlingRows: [],
        cycleRows: [],
        participantRows: participantRows(profile),
        speeds: { cruise: profile.cruise, cruiseSource: profile.cruiseSource, saved: profile.savedSpeed, useMaximum: profile.useMaximumSpeed, effectiveMax: profile.effectiveMax, designMax: profile.designMax, limiting: profile.limiting ? profile.limiting.name : '' },
        reasons: profile.reasons.map((reason) => capital(reason.text)),
        conditions: profile.notes.map((note) => capital(note.text)),
        statusSort: 4,
        status: 'noroute',
        note: '',
      }

      if (!ok) {
        return { ...base, status: profile.status, statusSort: 1, provenance: fleetTripResult(fleetTrip(profile, 0, endpoints), profile), note: base.reasons.join('; ') }
      } else if (reach.pending) {
        return { ...base, status: 'unknown', statusSort: 1, pending: true, provenance: unreadResult(), note: this.avoidNote.text }
      } else if (!reach.route) {
        return { ...base, note: this.reachNote(fleet, reach) }
      }

      const { heldTrip, first } = stage
      const flownTrip = this.flownTripOf(setup, endpoints, stage, ledger)
      // The bodies moved on can bring an end of the run nearer, so that a flight no longer runs the delay down: that round trip's time is a range, and it keeps the saved positions (`timed-clock`).
      const simulation = flownTrip && !flightOnly(flownTrip.cycle, profile.cruise) ? this.simulate(reach, profile.cruise, flownTrip) : first
      const trip = flownTrip && simulation === first ? flownTrip : heldTrip
      const positions = simulation ? simulation.annual.positions : this.positionsOf(reach)
      const yearly = (value) => ({ days: value.tripSeconds / SECONDS_PER_DAY, trips: value.trips, tons: value.tonsYear, colonists: value.colonistsYear })
      // Where the round trip can run, the ledger says whether the fuel lasts.
      const runs = trip.status === 'ok' || trip.status === 'range'
      const status = runs ? ledger.status : trip.status
      const works = status === 'ok'
      const timed = runs
      const left = profile.cargo.left.ships.length
      const known = timingKnown(ledger)
      const run = { ...base, ...this.safeFields(reach), ...this.ledgerFields(ledger), status, timingKnown: known, jumps: reach.route.jumps, km: reach.route.km, tripSeconds: trip.tripSeconds, travelSeconds: trip.travelSeconds, handlingSeconds: trip.handlingSeconds, limiting: trip.limiting, cycleRows: timed ? this.cycleRows(trip, ledger, known) : [], provenance: withPositions(fleetTripResult(trip, profile), positions), estimate: trip.estimate, handlingRows: handlingRows(trip.stops.map((stop, index) => ({ key: `${base.key}-${index}`, label: `${stop.where === 'origin' ? 'Loading' : 'Unloading'} ${stop.kind} at ${endpoints[stop.where].place}`, breakdown: stop.breakdown }))), participantRows: participantRows(profile, known ? trip : null), statusSort: works ? 0 : 1, simulation, propagation: timed && known && simulation && simulation.annual.compared ? this.propagationOf(simulation, yearly(heldTrip), yearly(trip), works) : null }
      const problems = trip.problems.map((problem) => capital(problem.text)).join('; ')
      const ledgerWords = runs ? ledgerNote(ledger, { litres: (value) => `${this.count(value)} L`, hours: (value) => this.span(value * 3600) }) : null

      if (works) {
        const figure = (rule, value, units) => figureOf({ rule, results: [run.provenance], value, units })
        const results = { trips: figure('transport.fleetTrip', trip.trips, 'trips/yr'), tonsYear: figure('transport.fleetTrip', trip.tonsYear, 't/yr'), colonistsYear: figure('transport.fleetTrip', trip.colonistsYear, 'colonists/yr'), fuel: figure('transport.fleetBurn', trip.fuelPerTrip, 'L'), fuelShare: figure('transport.fleetBurn', trip.fuelShare * 100, '%'), fuelReturn: figureOf({ rule: 'fuelService.ledger', results: [run.provenance, ledger.results.ledger], value: run.returnShare === null ? null : run.returnShare * 100, units: '%' }) }

        return { ...run, results, tripDays: known ? trip.tripSeconds / SECONDS_PER_DAY : null, trips: known ? trip.trips : null, tonsYear: known ? trip.tonsYear : null, colonistsYear: known ? trip.colonistsYear : null, fuel: trip.fuelPerTrip, fuelShare: trip.fuelShare, fuelLimiting: trip.fuelLimiting ? trip.fuelLimiting.ShipName : '', note: [ledgerWords, left ? `The holds of ${left} carried or towed craft are not counted.` : ''].filter(Boolean).join('. ') }
      } else if (runs) {
        return { ...run, note: [ledgerWords, stage.clockUnknown ? 'The legs are not known: the bodies move while the stops last, and the hours of a refuelling are not known.' : ''].filter(Boolean).join('. ') }
      } else if (trip.status === 'unknown') {
        return { ...run, note: `Not known whether the fleet can run: ${problems}.` }
      }

      return { ...run, note: problems ? `${problems}.` : '' }
    },

    // What a fleet's ledger adds to its row: its place in the draw order, the ledger and its view for the expanded row, and how full the fullest-run ship's tank is on return.
    ledgerFields(ledger) {
      const { draw } = ledger
      const stops = [...new Set(ledger.stops.map((stop) => stop.stop.name))]
      const returned = ledger.returnFuel ? ledger.ships.filter((entry) => entry.role === 'independent' && entry.tank).map((entry) => ({ entry, share: ledger.returnFuel.get(entry.id) / entry.capacity })).reduce((worst, item) => (!worst || item.share < worst.share ? item : worst), null) : null

      return { draw: draw.position, drawOf: draw.of, drawTitle: `Draws on ${joinLabels(stops)}${draw.ahead.length ? ` after ${joinLabels(draw.ahead)}` : ' first'}`, ledger, ledgerView: this.ledgerViewOf(ledger), returnShare: returned ? returned.share : null, returnLimiting: returned ? returned.entry.name : '' }
    },

    // The ledger as the expanded row shows it: a table of the fuel of each ship stop by stop and leg by leg, what each source at each stop gave, the limiting ship and what is not counted.
    ledgerViewOf(ledger) {
      const litres = (value) => (Number.isFinite(value) ? `${this.count(value)} L` : 'Not known')
      const share = (value) => (Number.isFinite(value) ? `${this.count(value * 100)}%` : '')
      const columns = [{ key: 'start', kind: 'start', label: 'Aboard' }]

      ledger.stops.forEach((stop, index) => {
        if (stop.serving) {
          columns.push({ key: `received-${index}`, kind: 'received', label: `Received at ${stop.stop.name}`, index })
        }

        if (index < ledger.legs.length) {
          columns.push({ key: `departure-${index}`, kind: 'departure', label: `Leaves ${stop.stop.name}`, index }, { key: `arrival-${index}`, kind: 'arrival', label: `Reaches ${ledger.legs[index].to.name}`, index })
        }
      })

      const cellOf = (row, column) => {
        if (column.kind === 'start') {
          return { key: column.key, kind: column.kind, litres: litres(row.start), share: row.capacity > 0 ? share(row.start / row.capacity) : '' }
        } else if (column.kind === 'received') {
          return { key: column.key, kind: column.kind, litres: row.received[column.index] === null ? '—' : litres(row.received[column.index]), share: '' }
        }

        const leg = row.legs[column.index]

        return leg ? { key: column.key, kind: column.kind, litres: litres(leg[column.kind]), share: column.kind === 'arrival' && leg.status === 'dry' ? `runs dry, short by ${litres(leg.shortfall)}` : share(leg[`${column.kind}Share`]) } : { key: column.key, kind: column.kind, litres: '—', share: '' }
      }
      const ships = ledgerRows(ledger).map((row) => ({ id: row.id, name: row.name, cells: columns.map((column) => cellOf(row, column)), returned: row.returned === null ? '—' : litres(row.returned), returnedShare: row.returned !== null && row.capacity > 0 ? share(row.returned / row.capacity) : '' }))
      const stops = ledger.stops.filter((stop) => stop.serving).map((stop) => ({ key: stop.index === 0 ? 'origin' : stop.index === 1 ? 'destination' : 'closing', title: `Refuelling at ${stop.stop.name}`, verdict: stop.service ? '' : SERVICE_REASONS['sites-unread'], parts: stop.service ? stop.service.services.map((part) => this.servicePartOf(part, stop.index, litres)) : [], needs: ledger.required.filter((need) => need.stop === stop.index).map((need) => ({ id: need.id, name: need.name, text: litres(need.litres) })) }))
      const { limiting } = ledger
      const conditional = [...new Set(ledger.stops.flatMap((stop) => (stop.service ? stop.service.services.flatMap((part) => part.conditional) : [])))]

      return {
        result: ledger.results.ledger,
        columns,
        ships,
        stops,
        limiting: limiting ? `Limiting ship: ${limiting.name}, ${limiting.dry ? `runs dry on the way to ${limiting.stop}, short by ${litres(limiting.shortfall)}` : `arrives at ${limiting.stop} with ${this.count(limiting.share * 100)}%`}` : '',
        notes: [...conditional, 'The fleet\'s own tankers are not counted', ...ledger.assumptions.map(capitalised)],
      }
    },

    // One source at a stop for the ledger view: whether it can serve or why not, and its figures. A colony the stop is not has none.
    servicePartOf(part, index, litres) {
      const allowed = part.permission === 'allowed'
      const reason = part.reason ? SERVICE_REASONS[part.reason] : ''
      const colony = part.kind === 'colony'
      const hours = part.hours === null ? 'Not known' : `${part.bound === 'at-least' ? `${SERVICE_BOUNDS['at-least'].before} ` : ''}${this.span(part.hours * 3600)}`
      const figures = colony && !part.key ? [] : [
        { key: 'stock', label: colony ? 'Stock now' : 'Eligible surplus now', text: litres(part.stock) },
        ...(colony ? [{ key: 'reserve', label: 'Local reserve', text: part.reserve === null ? 'Not read' : litres(part.reserve) }] : []),
        { key: 'ahead', label: 'Taken by the fleets ahead', text: part.takenAhead.length ? part.takenAhead.map((item) => `${item.fleet} ${litres(item.litres)}`).join(', ') : 'None' },
        { key: 'available', label: 'Available to the fleet at entry', text: litres(part.entry) },
        ...(allowed ? [{ key: 'received', label: 'Received by the fleet', text: part.received === null ? 'Not known' : litres(part.received) }, { key: 'residual', label: 'Left after the fleet', text: litres(part.residual) }, { key: 'hours', label: 'Hours', text: hours }, ...(part.limiting ? [{ key: 'limiting', label: 'Receives most', text: part.limiting.name }] : [])] : []),
      ]
      const tankers = (part.tankers || []).map((tanker) => ({ key: tanker.key, text: `${tanker.name}: ${tanker.permission === 'allowed' && tanker.residual !== null ? `gives from ${litres(tanker.entry)}, ${litres(tanker.residual)} left` : tanker.permission === 'allowed' && tanker.known === false ? `what it gives is not known, ${litres(tanker.entry)} at entry` : tanker.permission === 'allowed' ? `not drawn from, ${litres(tanker.entry)} at entry` : `${tanker.permission === 'blocked' ? 'cannot serve' : 'not known'}: ${SERVICE_REASONS[tanker.reason]}`}` }))

      return { key: `${index}-${part.key || part.kind}`, kind: SERVICE_KINDS[part.kind], source: part.name, verdict: allowed ? SERVICE_VERDICTS.allowed : `${SERVICE_VERDICTS[part.permission]}: ${reason}`, figures, tankers }
    },

    // The parts of a fleet's round trip that add up to its time, for the expanded row: flying (not known where the run is not), loading and unloading, the refuelling at each end where one is drawn, the transits (which take none), the wait for the jump shock as a range, the total at the upper case of that wait with the lower case beside it, and the round trips a year that total gives.
    cycleRows(trip, ledger = null, known = true) {
      const range = (low, high) => (low === high ? this.span(low) : `${this.span(low)} to ${this.span(high)}`)
      const refuelling = (ledger ? ledger.stops.slice(0, 3) : []).filter((stop) => stop.service && stop.service.permission === 'allowed' && stop.hours > 0).map((stop) => ({ key: ['refuel-origin', 'refuel-destination', 'refuel-closing'][stop.index], label: `Refuelling at ${stop.stop.name}${stop.index === 2 ? ' on return' : ''}`, text: `${stop.bound === 'at-least' ? `${SERVICE_BOUNDS['at-least'].before} ` : ''}${this.span(stop.hours * 3600)}` }))

      return [
        { key: 'flight', label: 'Flying', text: known ? this.span(trip.travelSeconds) : 'Not known' },
        { key: 'handling', label: 'Loading and unloading', text: this.span(trip.handlingSeconds) },
        ...refuelling,
        { key: 'transit', label: 'Transits', text: this.span(trip.transitSeconds) },
        { key: 'wait', label: 'Waiting for the jump shock', text: known ? range(trip.waitSeconds.lo, trip.waitSeconds.hi) : 'Not known', result: known ? waitResult(trip.waitSeconds, []) : null },
        { key: 'total', label: 'Round trip', text: known ? range(trip.tripSecondsLow, trip.tripSeconds) : 'Not known' },
        { key: 'year', label: 'Round trips a year', text: known ? this.count(trip.trips, 1) : 'Not known' },
      ]
    },

    // The round trip sailed cycle after cycle for a year with the bodies moved on to each arrival (utilities/route-plan.js `simulateCycles`): the run out and back, loading at the origin and unloading at the destination as waits, the way back flown on the same jump points with its Lagrange points chosen afresh. Null while the positions are not read, or for a run with no speed or no handling time. A round trip whose walk is not the flight's own clock (`flightOnly`: a jump shock to wait for, a nebula cap) states the saved positions and why. Kept per save, speed and run.
    simulate(reach, speed, trip) {
      const { origin, destination, positionRead } = this

      if (!positionRead || !reach.route || !(speed > 0) || trip.handlingSeconds === null) {
        return null
      }

      const wait = (where) => trip.stops.filter((stop) => stop.where === where).reduce((sum, stop) => sum + stop.seconds, 0) + trip.service[where]
      const steps = routeLegs(reach.route)
      const hops = [{ steps, from: origin, to: destination, wait: wait('destination') }, { steps: reverseSteps(steps), from: destination, to: origin, wait: wait('origin') }]
      const lagrangePoints = this.useLagrange ? this.lagrangePoints : []
      const path = pathKey(steps)
      const timed = !flightOnly(trip.cycle, speed)
      const scenario = JSON.stringify([origin.key, destination.key, reach.route.jumps, reach.route.km, path, this.useLagrange, wait('origin'), wait('destination'), timed])

      return cachedPropagation(this.database, 'transport', { facts: positionRead, profile: speed, scenario }, () => simulateCycles({ hops, facts: positionRead, adapters: ADAPTERS, speed, lagrangePoints, timed }))
    },

    // What the simulated year changed against the saved positions, for a row: { moved (the figures are the propagated ones), reasons (the texts of why the saved positions stand), held, used } with each of `held` and `used` as { days, trips, tons, colonists }.
    propagationOf(simulation, held, used, operational) {
      const moved = simulation.annual.status === 'propagated'
      const codes = simulation.annual.reasons.filter((code) => code !== 'propagation-unavailable' || simulation.annual.reasons.length === 1)

      return { moved, reasons: moved ? [] : codes.map((code) => CONDITIONS[code]), held, used, operational }
    },

    // A row's propagated and static trip side by side with the throughput between them, or the reason the saved positions stand.
    propagationText(run) {
      const found = run.propagation

      if (!found) {
        return ''
      } else if (!found.moved) {
        return `Static: ${found.reasons.join('; ')}.`
      }

      const { held, used } = found
      const signed = (value, digits = 0) => `${value < 0 ? '−' : '+'}${this.count(Math.abs(value), digits)}`
      const throughput = !found.operational ? '' : [`${signed(used.trips - held.trips, 2)} trips/yr`, used.tons === null ? '' : `${signed(used.tons - held.tons)} t/yr`, used.colonists === null ? '' : `${signed(used.colonists - held.colonists)} colonists/yr`].filter(Boolean).join(', ')

      return `Propagated ${this.duration(used.days)} against ${this.duration(held.days)} on the saved positions${throughput ? `; ${throughput}` : ''}.`
    },

    tripTitle(run) {
      return `${this.duration(run.travelSeconds / SECONDS_PER_DAY)} flying at ${this.count(run.speed)} km/s, ${this.duration(run.handlingSeconds / SECONDS_PER_DAY)} loading and unloading${run.limiting ? `, the slowest stop set by ${run.limiting.ship.ShipName} at a loading strength of ${this.count(run.limiting.strength, 1)}` : ''}`
    },

    // A count of installations, which shipments can split in parts.
    amount(value) {
      return Number.isFinite(value) ? this.count(value, Number.isInteger(value) ? 0 : 1) : '—'
    },

    groupSummary(items) {
      const total = (field) => items.reduce((sum, item) => sum + item[field], 0)

      return `Supply ${this.amount(total('supply'))} · Demand ${this.amount(total('demand'))} · En route ${this.amount(total('out'))}`
    },

    amountText(value) {
      return amountText(value, this.separator)
    },

    distance(km) {
      if (km >= 1e9) {
        return `${this.count(km / 1e9, 2)} bn km`
      } else if (km >= 1e6) {
        return `${this.count(km / 1e6, 1)} M km`
      }

      return `${this.count(km)} km`
    },
  },
  asyncComputed: {
    systems: {
      get: tracked('systems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.MilitaryRestrictedSystem from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    jumpPoints: {
      get: tracked('jumpPoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadJumpPoints(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // Stable Lagrange points in the known systems. They belong to no race.
    lagrangePoints: {
      get: tracked('lagrangePoints', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_LagrangePoint.LagrangePointID, FCT_LagrangePoint.SystemID, FCT_LagrangePoint.Xcor, FCT_LagrangePoint.Ycor from FCT_LagrangePoint inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_LagrangePoint.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} where FCT_LagrangePoint.GameID = ${this.GameID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The race's colonies with the body they are on, and whether a spaceport or cargo shuttle station stands there.
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, ${SHUTTLE_SERVICE_COLUMNS} from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID ${shuttleServiceJoin(this.GameID, 'FCT_Population.PopulationID')} where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} order by FCT_Population.Capital desc, FCT_Population.Population desc, FCT_Population.PopName`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The ships of every fleet that has a hold or colony bays, with their class, the strength of their undamaged cargo shuttle bays, the jump drives it carries (`Drive` the best ordinary one, `AnyDrive` the best of any kind, as ship sizes) and the race's shuttle technology.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Ship.ShipClassID, FCT_Ship.CurrentCrew, FCT_Ship.MothershipID, FCT_Fleet.FleetName, FCT_Fleet.ShippingLine, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_ShipClass.ClassName, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.Size, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.MaxSpeed, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, FCT_ShipClass.MilitaryEngines, FCT_Race.CargoShuttleLoadModifier as ShuttleTechnology, ${SHUTTLE_STRENGTH_COLUMNS}, ${JUMP_DRIVE_COLUMNS} from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipClass.MaxSpeed > 1 and FCT_Ship.FleetID in (select carrier.FleetID from FCT_Ship as carrier inner join FCT_ShipClass as carrierClass on carrierClass.ShipClassID = carrier.ShipClassID where carrier.GameID = ${this.GameID} and carrier.RaceID = ${this.RaceID} and (carrierClass.CargoCapacity > 0 or carrierClass.ColonistCapacity > 0)) order by FCT_Fleet.FleetName, FCT_ShipClass.ClassName`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // The ships of every military fleet that has a hold or colony bays, whole (`loadFleetShips`): what the fleets sailing together are profiled from. Optional, so the page renders without it and the fleets panel says so while it is in flight or failed.
    fleetShips: {
      get: tracked('fleetShips', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadFleetShips(this.database, { GameID: this.GameID, RaceID: this.RaceID, fleetWhere: `FCT_Fleet.ShippingLine = 0 and FCT_Fleet.FleetID in (select carrier.FleetID from FCT_Ship as carrier inner join FCT_ShipClass as carrierClass on carrierClass.ShipClassID = carrier.ShipClassID where carrier.GameID = ${this.GameID} and carrier.RaceID = ${this.RaceID} and (carrierClass.CargoCapacity > 0 or carrierClass.ColonistCapacity > 0 or carrierClass.CargoCapacity is null or carrierClass.ColonistCapacity is null))` })
      }),
      default: [],
    },
    // The colonies and the stationary tanker fleets that can serve a ship at a stop, with the race's refuelling rates (`loadFuelSites`): optional, so the page renders without it and a refuelling that cannot be decided reads as not known.
    fuelSites: {
      get: tracked('fuelSites', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return await loadFuelSites(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: null,
    },
    // The nebula density of the systems the race has surveyed that have dust (`loadSystemDust`): what caps a fleet's speed in a system. Few saves have any.
    systemDust: {
      get: tracked('systemDust', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadSystemDust(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: () => ({}),
    },
    // What colonies supply and demand of each installation, while shipping lines run.
    requests: {
      get: tracked('requests', async function () {
        if (!this.database || !this.GameID || !this.RaceID || !this.CivilianShippingLinesActive) {
          return []
        }

        return await this.database.query(`select FCT_PopInstallationDemand.PopulationID, FCT_PopInstallationDemand.InstallationID, DIM_PlanetaryInstallation.Name as InstallationName, FCT_PopInstallationDemand.Amount, FCT_PopInstallationDemand.Export from FCT_PopInstallationDemand inner join FCT_Population on FCT_Population.PopulationID = FCT_PopInstallationDemand.PopulationID inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopInstallationDemand.InstallationID where FCT_PopInstallationDemand.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}`).then(([items]) => Object.freeze(items))
      }),
      default: [],
    },
    // Installations in the holds of shipping line ships, by where they were loaded and where their fleet's unload order sends them (none when the order is not there).
    shipments: {
      get: tracked('shipments', async function () {
        if (!this.database || !this.GameID || !this.RaceID || !this.CivilianShippingLinesActive) {
          return []
        }

        return await this.database.query(`select FCT_ShipCargo.CargoID as InstallationID, DIM_PlanetaryInstallation.Name as InstallationName, FCT_ShipCargo.StartingPop as OriginPopulationID, orders.PopulationID as DestinationPopulationID, sum(FCT_ShipCargo.Amount) as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_ShipCargo.CargoID left join (select FleetID, DestinationItemID, min(PopulationID) as PopulationID from FCT_MoveOrders where GameID = ${this.GameID} and MoveActionID = 177 and DestinationItemType = 19 group by FleetID, DestinationItemID) as orders on orders.FleetID = FCT_Ship.FleetID and orders.DestinationItemID = FCT_ShipCargo.CargoID where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 2 and FCT_Ship.ShippingLineID != 0 group by FCT_ShipCargo.CargoID, FCT_ShipCargo.StartingPop, orders.PopulationID`).then(([items]) => Object.freeze(items))
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
    // The officers' Logistics bonuses that multiply a ship's loading strength (`loadHandlingSupport`): optional, so the page renders without them and counts each as unknown until they are in.
    handlingSupport: {
      get: tracked('handlingSupport', async function () {
        const { database, GameID, RaceID } = this
        const gates = this.capabilityGates('/information')

        if (!database || !GameID || !RaceID) {
          return null
        }

        const { ranks, blocked } = await gates

        return await loadHandlingSupport(database, { GameID, RaceID, ranks, blocked })
      }),
      default: null,
    },
    // The known systems with the danger and control the avoid settings read (`loadPlannedAvoidSystems`): optional, so the page renders at once and plans under a setting only once it is in.
    avoidSystems: {
      get: tracked('avoidSystems', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadPlannedAvoidSystems(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.transport-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }

  [data-propagation] {
    display: -webkit-box;
    width: 0;
    min-width: 100%;
    overflow: hidden;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .tool {
    min-width: 0;
  }

  .tool__label {
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
  }

  .tool--place {
    flex: 1 1 240px;
    max-width: 420px;
  }

  .tool--fleets {
    flex: 1 1 220px;
    max-width: 360px;
  }

  .tool--swap,
  .tool--actions {
    align-self: flex-end;
  }

  .tool--actions .v-btn {
    height: 40px !important;
  }

  .search-field {
    min-width: 200px;
    max-width: 260px;
  }

  th {
    white-space: nowrap;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
