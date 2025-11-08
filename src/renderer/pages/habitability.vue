<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row justify="start">
          <v-col>
            <v-autocomplete v-model="selectedSpeciesId" :items="species" :item-text="(item) => `${item.SpeciesName} (${separatedNumber(roundToDecimal(item.TotalPopulation, 2), separator)} M)`" item-value="SpeciesID" label="Species" auto-select-first dense solo />
          </v-col>
          <v-col cols="4">
            <v-text-field v-model.number="terraformers" type="number" min="10" placeholder="40" :hint="`Terraformers at ${selectedSpecies.TerraformingRate} rate`" :rules="[rules.required, rules.positive]" persistent-hint dense solo @change="config.set('habitabilityTerraformers', terraformers)" />
          </v-col>
          <v-col cols="auto">
            <div class="d-flex align-center flex-wrap">
              <v-menu offset-y :close-on-content-click="false">
                <template #activator="{ on, attrs }">
                  <v-btn outlined v-bind="attrs" v-on="on">
                    Filters<span v-if="activeFilterCount"> ({{ activeFilterCount }})</span>
                  </v-btn>
                </template>

                <v-list dense>
                  <v-list-item>
                    <v-checkbox v-model="filterNonTerraformable" label="Hide Non-Terraformable" dense hide-details @change="config.set('habitabilityFilterNonTerraformable', filterNonTerraformable)" />
                  </v-list-item>
                  <v-list-item>
                    <v-checkbox v-model="filterWithoutMinerals" label="Hide Without Minerals" dense hide-details @change="config.set('habitabilityFilterWithoutMinerals', filterWithoutMinerals)" />
                  </v-list-item>

                  <v-divider class="my-1" />

                  <v-list-item>
                    <v-checkbox v-model="filterOwnPopulations" label="Hide Own Populations" dense hide-details @change="config.set('habitabilityFilterOwnPopulations', filterOwnPopulations)" />
                  </v-list-item>
                  <v-list-item>
                    <v-checkbox v-model="filterOtherPopulations" label="Hide Other Populations" dense hide-details @change="config.set('habitabilityFilterOtherPopulations', filterOtherPopulations)" />
                  </v-list-item>

                  <v-divider class="my-1" />

                  <v-list-item>
                    <v-checkbox v-model="filterDoneTerraforming" label="Hide Terraformed" dense hide-details @change="config.set('habitabilityFilterDoneTerraforming', filterDoneTerraforming)" />
                  </v-list-item>
                  <v-list-item>
                    <v-checkbox v-model="filterUninhabited" label="Hide Uninhabited" dense hide-details @change="config.set('habitabilityFilterUninhabited', filterUninhabited)" />
                  </v-list-item>

                  <v-divider class="my-1" />

                  <v-list-item>
                    <v-btn
                      text
                      small
                      @click="
                        filterNonTerraformable = false
                        filterWithoutMinerals = false
                        filterOwnPopulations = false
                        filterOtherPopulations = false
                        filterDoneTerraforming = false
                        filterUninhabited = false

                        config.set('habitabilityFilterNonTerraformable', filterNonTerraformable)
                        config.set('habitabilityFilterWithoutMinerals', filterWithoutMinerals)
                        config.set('habitabilityFilterOwnPopulations', filterOwnPopulations)
                        config.set('habitabilityFilterOtherPopulations', filterOtherPopulations)
                        config.set('habitabilityFilterDoneTerraforming', filterDoneTerraforming)
                        config.set('habitabilityFilterUninhabited', filterUninhabited)
                      "
                    >
                      Reset Filters
                    </v-btn>
                  </v-list-item>
                </v-list>
              </v-menu>
            </div>
          </v-col>
          <v-col cols="12">
            <v-select v-model="systems" :disabled="filterBySelectedBodies" :items="systemNames" label="Active Systems" item-text="SystemName" item-value="SystemID" multiple small-chips deletable-chips @change="config.set('habitabilitySystems', systems)">
              <template #prepend-item>
                <v-list-item ripple @click="toggleSystems">
                  <v-list-item-action>
                    <v-icon>
                      {{ systems.length > 0 ? (systems.length == systemNames.length ? 'mdi-emoticon-outline' : 'mdi-emoticon-happy-outline') : 'mdi-emoticon-sad-outline' }}
                    </v-icon>
                  </v-list-item-action>
                  <v-list-item-content>
                    <v-list-item-title>Select All</v-list-item-title>
                  </v-list-item-content>
                </v-list-item>
                <v-list-item v-if="unrestrictedSystems.length && unrestrictedSystems.length !== systemNames.length" ripple :input-value="areSetsEqual(new Set(systems), new Set(unrestrictedSystemsIds))" @click="selectUnrestrictedSystems">
                  <v-list-item-action>
                    <v-icon>mdi-billiards-rack</v-icon>
                  </v-list-item-action>
                  <v-list-item-content>
                    <v-list-item-title>Select Unrestricted Systems</v-list-item-title>
                  </v-list-item-content>
                </v-list-item>
                <v-list-item v-if="colonizedSystems.length && colonizedSystems.length !== systemNames.length" ripple :input-value="areSetsEqual(new Set(systems), new Set(colonizedSystemsIds))" @click="selectOurSystems">
                  <v-list-item-action>
                    <v-icon>mdi-city-variant-outline</v-icon>
                  </v-list-item-action>
                  <v-list-item-content>
                    <v-list-item-title>Select Colonized Systems</v-list-item-title>
                  </v-list-item-content>
                </v-list-item>
                <v-list-item v-if="inhabitedColonizedSystems.length && inhabitedColonizedSystems.length !== systemNames.length" ripple :input-value="areSetsEqual(new Set(systems), new Set(inhabitedColonizedSystemsIds))" @click="selectOurInhabitedSystems">
                  <v-list-item-action>
                    <v-icon>mdi-account-multiple-outline</v-icon>
                  </v-list-item-action>
                  <v-list-item-content>
                    <v-list-item-title>Select Inhabited Systems</v-list-item-title>
                  </v-list-item-content>
                </v-list-item>
                <v-divider class="mt-2" />
              </template>
            </v-select>
          </v-col>
          <v-col v-if="selectedBodies.length || filterBySelectedBodies" cols="12">
            <v-row>
              <v-col cols="auto">
                <v-btn class="d-block mb-1" style="width: 100%" small outlined :color="filterBySelectedBodies ? 'red' : ''" @click="filterBySelectedBodies = !filterBySelectedBodies">Isolate in Habitability</v-btn>
                <v-btn
                  :to="{
                    path: 'minerals',
                    query: {
                      bodies: JSON.stringify(
                        selectedBodies.map((selection) => ({
                          SystemBodyID: selection.SystemBodyID,
                          SystemBodyName: selection.SystemBodyName,
                          SystemName: selection.SystemName,
                          BodyClass: selection.BodyClass,
                          Component: selection.Component,
                          PlanetNumber: selection.PlanetNumber,
                          OrbitNumber: selection.OrbitNumber,
                        }))
                      ),
                    },
                  }"
                  style="width: 100%"
                  small
                  outlined
                >
                  Isolate in Minerals
                </v-btn>

                <v-btn
                  class="d-block mt-4"
                  style="width: 100%"
                  small
                  outlined
                  @click="
                    selectedBodies = []
                    filterBySelectedBodies = false
                  "
                >
                  Clear Selection
                </v-btn>
              </v-col>
              <v-col>
                <v-chip v-for="body of selectedBodies" :key="body.SystemBodyID" class="mr-2 mb-2" small label outlined close @click:close="() => (selectedBodies = selectedBodies.filter((selection) => selection.SystemBodyID !== body.SystemBodyID))">{{ body.SystemName }} {{ systemBodyName(body) }}</v-chip>
              </v-col>
            </v-row>
          </v-col>
          <v-col cols="12">
            <v-data-table class="elevation-2" :headers="headers" :items="filteredCalculatedBodies" item-key="SystemBodyID" :expanded.sync="expandedRows" :sort-by.sync="sortBy" :sort-desc.sync="sortDescending" :items-per-page.sync="itemsPerPage" :footer-props="{ itemsPerPageOptions }" :show-expand="true" @click:row="(data, { expand, isExpanded, item }) => item.Terraformable && item.TerraformationTime > 0 && expand(!isExpanded)">
              <template #[`item.data-table-expand`]="{ item, isExpanded, expand }">
                <td style="white-space: nowrap">
                  <v-btn v-if="selectedBodies.find((selection) => selection.SystemBodyID === item.SystemBodyID)" color="red" icon @click.stop="() => (selectedBodies = selectedBodies.filter((selection) => selection.SystemBodyID !== item.SystemBodyID))"><v-icon>mdi-playlist-remove</v-icon></v-btn>
                  <v-btn v-else icon @click.stop="() => selectedBodies.push(item)"><v-icon>mdi-playlist-plus</v-icon></v-btn>

                  <template v-if="item.Terraformable && item.TerraformationTime > 0">
                    <v-btn v-if="isExpanded" icon @click.stop="expand(false)"><v-icon>mdi-arrow-expand-up</v-icon></v-btn>
                    <v-btn v-else icon @click.stop="expand(true)"><v-icon>mdi-arrow-expand-vertical</v-icon></v-btn>
                  </template>
                </td>
              </template>
              <template #expanded-item="{ item }">
                <td v-if="item.TerraformationPlan" :colspan="headers.length + 1" class="px-4 py-3">
                  <v-container fluid>
                    <v-row justify="start">
                      <v-col cols="12" md="8">
                        <v-list-item>
                          <v-list-item-content>
                            <v-list-item-title>
                              <h2>Rough Terraforming Blueprint</h2>
                            </v-list-item-title>

                            <v-list-item-subtitle>
                              Albedo:
                              <template v-if="item.TerraformationPlan && typeof item.TerraformationPlan.TargetAlbedo === 'number'">
                                {{ roundToDecimal(item.TerraformationPlan.TargetAlbedo, 3) }}
                                <span v-if="Math.abs((item.TerraformationPlan.TargetAlbedo || 0) - item.OriginalAlbedo) >= 0.001"> (from {{ roundToDecimal(item.OriginalAlbedo, 3) }}) </span>
                              </template>
                              <template v-else>
                                {{ roundToDecimal(item.OriginalAlbedo, 3) }}
                              </template>
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <template v-if="item.TerraformationPlan.Toxics.length">
                          <v-list-item v-for="toxic of item.TerraformationPlan.Toxics" :key="toxic.AtmosGasID" two-line>
                            <v-list-item-content>
                              <v-list-item-title class="text-wrap">
                                Set {{ toxic.AtmosGasName }} to
                                <span class="target-value">
                                  0
                                  <v-tooltip top>
                                    <template #activator="{ on, attrs }">
                                      <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copyAtmosphereValue(0)">
                                        <v-icon x-small>mdi-content-copy</v-icon>
                                      </v-btn>
                                    </template>
                                    <span>Copy value</span>
                                  </v-tooltip>
                                </span>
                                maximum atm.
                              </v-list-item-title>
                              <v-list-item-subtitle> This is going to take about {{ roundToDecimal(toxic.RemovalTime, 1) }} years. </v-list-item-subtitle>
                            </v-list-item-content>
                          </v-list-item>
                        </template>

                        <v-list-item v-if="item.TerraformationPlan.WaterVapourTime" two-line>
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              <template v-if="item.TerraformationPlan.WaterVapour > 0">
                                Set Water Vapour to
                                <span class="target-value">
                                  {{ roundToDecimal(item.TerraformationPlan.WaterVapour, 3) }}
                                  <v-tooltip top>
                                    <template #activator="{ on, attrs }">
                                      <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copyAtmosphereValue(item.TerraformationPlan.WaterVapour)">
                                        <v-icon x-small>mdi-content-copy</v-icon>
                                      </v-btn>
                                    </template>
                                    <span>Copy value</span>
                                  </v-tooltip>
                                </span>
                                maximum atm.
                              </template>
                              <span v-else>Set Water Vapour to a small amount and wait for Hydrographic Extent to be higher than 20.</span>
                            </v-list-item-title>
                            <v-list-item-subtitle>
                              This is going to take about {{ roundToDecimal(item.TerraformationPlan.WaterVapourTime, 2) }} years.
                              <template v-if="item.TerraformationPlan.HydroExtTime && item.TerraformationPlan.HydroExtTime > 0.1">
                                <br />
                                Then wait {{ roundToDecimal(item.TerraformationPlan.HydroExtTime, 2) }} years for natural {{ item.TerraformationPlan.WaterVapourProcess === 'Evaporate' ? 'evaporation' : 'condensation' }} to adjust hydrosphere to {{ roundToDecimal(item.TargetHydroExt, 1) }}%.
                              </template>
                            </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item v-if="item.TerraformationPlan.BreathableTime" two-line>
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.BreathableName }} to
                              <span class="target-value">
                                {{ roundToDecimal(item.TerraformationPlan.Breathable, 3) }}
                                <v-tooltip top>
                                  <template #activator="{ on, attrs }">
                                    <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copyAtmosphereValue(item.TerraformationPlan.Breathable)">
                                      <v-icon x-small>mdi-content-copy</v-icon>
                                    </v-btn>
                                  </template>
                                  <span>Copy value</span>
                                </v-tooltip>
                              </span>
                              maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle> This is going to take about {{ roundToDecimal(item.TerraformationPlan.BreathableTime, 2) }} years. </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item v-if="item.TerraformationPlan.GreenhouseTime" two-line>
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.GreenhouseName }} to
                              <span class="target-value">
                                {{ roundToDecimal(item.TerraformationPlan.Greenhouse - item.TerraformationPlan.GreenhouseSideContributions, 3) }}
                                <v-tooltip top>
                                  <template #activator="{ on, attrs }">
                                    <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copyAtmosphereValue(item.TerraformationPlan.Greenhouse - item.TerraformationPlan.GreenhouseSideContributions)">
                                      <v-icon x-small>mdi-content-copy</v-icon>
                                    </v-btn>
                                  </template>
                                  <span>Copy value</span>
                                </v-tooltip>
                              </span>
                              maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle> This is going to take about {{ roundToDecimal(item.TerraformationPlan.GreenhouseTime, 2) }} years. </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item v-if="item.TerraformationPlan.AntiGreenhouseTime" two-line>
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.AntiGreenhouseName }} to
                              <span class="target-value">
                                {{ roundToDecimal(item.TerraformationPlan.AntiGreenhouse - item.TerraformationPlan.AntiGreenhouseSideContributions, 3) }}
                                <v-tooltip top>
                                  <template #activator="{ on, attrs }">
                                    <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copyAtmosphereValue(item.TerraformationPlan.AntiGreenhouse - item.TerraformationPlan.AntiGreenhouseSideContributions)">
                                      <v-icon x-small>mdi-content-copy</v-icon>
                                    </v-btn>
                                  </template>
                                  <span>Copy value</span>
                                </v-tooltip>
                              </span>
                              maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle> This is going to take about {{ roundToDecimal(item.TerraformationPlan.AntiGreenhouseTime, 2) }} years. </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>

                        <v-list-item v-if="item.TerraformationPlan.NeutralTime" two-line>
                          <v-list-item-content>
                            <v-list-item-title class="text-wrap">
                              Set {{ item.TerraformationPlan.NeutralName }} to
                              <span class="target-value">
                                {{ roundToDecimal(item.TerraformationPlan.Neutral - item.TerraformationPlan.NeutralSideContributions, 3) }}
                                <v-tooltip top>
                                  <template #activator="{ on, attrs }">
                                    <v-btn icon x-small class="target-copy-btn" v-bind="attrs" v-on="on" @click.stop="copyAtmosphereValue(item.TerraformationPlan.Neutral - item.TerraformationPlan.NeutralSideContributions)">
                                      <v-icon x-small>mdi-content-copy</v-icon>
                                    </v-btn>
                                  </template>
                                  <span>Copy value</span>
                                </v-tooltip>
                              </span>
                              maximum atm.
                            </v-list-item-title>
                            <v-list-item-subtitle> This is going to take about {{ roundToDecimal(item.TerraformationPlan.NeutralTime, 2) }} years. </v-list-item-subtitle>
                          </v-list-item-content>
                        </v-list-item>
                      </v-col>
                      <v-col cols="12" md="4">
                        <v-row dense>
                          <v-col cols="12" sm="6">
                            <v-card outlined class="mb-3">
                              <v-list-item three-line>
                                <v-list-item-content>
                                  <div class="overline">ATMOSPHERIC PRESSURE</div>
                                  <v-list-item-title class="headline mb-1"> {{ roundToDecimal(item.TerraformedAtmosphere, 2) }} atm </v-list-item-title>
                                  <v-list-item-subtitle>From: {{ roundToDecimal(item.StartingAtmosphere, 2) }}</v-list-item-subtitle>
                                </v-list-item-content>
                              </v-list-item>
                            </v-card>
                          </v-col>
                          <v-col v-if="item.CurrentColonyCostOverall != null || item.PlannedColonyCostOverall != null" cols="12" sm="6">
                            <v-card outlined class="mb-3">
                              <v-list-item three-line>
                                <v-list-item-content>
                                  <div class="overline">COLONY COST</div>
                                  <v-list-item-title class="headline mb-1">
                                    <template v-if="item.PlannedColonyCostOverall != null && item.PlannedColonyCostPeriapsis != null && item.PlannedColonyCostApoapsis != null">
                                      <span v-if="item.PlannedColonyCostOverall === item.PlannedColonyCostPeriapsis && item.PlannedColonyCostOverall === item.PlannedColonyCostApoapsis">
                                        {{ roundToDecimal(item.PlannedColonyCostOverall, 2) }}
                                      </span>
                                      <span v-else-if="item.PlannedColonyCostPeriapsis === item.PlannedColonyCostApoapsis"> {{ roundToDecimal(item.PlannedColonyCostOverall, 2) }} ({{ roundToDecimal(item.PlannedColonyCostPeriapsis, 2) }}) </span>
                                      <span v-else> {{ roundToDecimal(item.PlannedColonyCostOverall, 2) }} ({{ roundToDecimal(Math.min(item.PlannedColonyCostPeriapsis, item.PlannedColonyCostApoapsis), 2) }} — {{ roundToDecimal(Math.max(item.PlannedColonyCostPeriapsis, item.PlannedColonyCostApoapsis), 2) }}) </span>
                                    </template>
                                    <template v-else> N/A </template>
                                  </v-list-item-title>
                                  <v-list-item-subtitle>
                                    <template v-if="item.CurrentColonyCostOverall != null && item.CurrentColonyCostPeriapsis != null && item.CurrentColonyCostApoapsis != null">
                                      <span v-if="item.CurrentColonyCostOverall === item.CurrentColonyCostPeriapsis && item.CurrentColonyCostOverall === item.CurrentColonyCostApoapsis"> Current: {{ roundToDecimal(item.CurrentColonyCostOverall, 2) }} </span>
                                      <span v-else> Current: {{ roundToDecimal(item.CurrentColonyCostOverall, 2) }} ({{ roundToDecimal(Math.min(item.CurrentColonyCostPeriapsis, item.CurrentColonyCostApoapsis), 2) }} — {{ roundToDecimal(Math.max(item.CurrentColonyCostPeriapsis, item.CurrentColonyCostApoapsis), 2) }}) </span>
                                    </template>
                                    <template v-else> Current: N/A </template>
                                  </v-list-item-subtitle>
                                </v-list-item-content>
                              </v-list-item>
                            </v-card>
                          </v-col>
                          <v-col cols="12" sm="6">
                            <v-card outlined class="mb-3">
                              <v-list-item three-line>
                                <v-list-item-content>
                                  <div class="overline">BREATHABLE PRESSURE</div>
                                  <v-list-item-title class="headline mb-1"> {{ roundToDecimal(item.TerraformationPlan.Breathable, 2) }} atm </v-list-item-title>
                                  <v-list-item-subtitle>From: {{ roundToDecimal(item.TerraformationPlan.BreathableStart, 2) }} ({{ item.TerraformationPlan.BreathableName }})</v-list-item-subtitle>
                                </v-list-item-content>
                              </v-list-item>
                            </v-card>
                          </v-col>
                          <v-col cols="12" sm="6">
                            <v-card outlined class="mb-3">
                              <v-list-item three-line>
                                <v-list-item-content>
                                  <div class="overline">SURFACE TEMPERATURE</div>
                                  <v-list-item-title class="headline mb-1">
                                    <template v-if="item.TerraformedTemperatureLow && Math.abs(item.TerraformedTemperatureHigh - item.TerraformedTemperatureLow) > 0.01"> {{ roundToDecimal(item.TerraformedTemperatureLow - 273, 2) }} °C — {{ roundToDecimal(item.TerraformedTemperatureHigh - 273, 2) }} °C </template>
                                    <template v-else> {{ roundToDecimal((item.TerraformedSurfaceTemperature || item.TerraformedTemperatureLow || item.TerraformedTemperatureHigh) - 273, 2) }} °C </template>
                                  </v-list-item-title>
                                  <v-list-item-subtitle>
                                    <template v-if="item.CurrentTemperatureLow && Math.abs(item.CurrentTemperatureHigh - item.CurrentTemperatureLow) > 0.01"> From: {{ roundToDecimal(item.CurrentTemperatureLow - 273, 2) }} °C — {{ roundToDecimal(item.CurrentTemperatureHigh - 273, 2) }} °C </template>
                                    <template v-else> From: {{ roundToDecimal(item.SurfaceTemp - 273, 2) }} °C </template>
                                  </v-list-item-subtitle>
                                </v-list-item-content>
                              </v-list-item>
                            </v-card>
                          </v-col>
                          <v-col cols="12" sm="6">
                            <v-card outlined>
                              <v-list-item three-line>
                                <v-list-item-content>
                                  <div class="overline">HYDROGRAPHIC EXTENT</div>
                                  <v-list-item-title class="headline mb-1">
                                    <template v-if="typeof item.TargetHydroExt === 'number' && Math.abs((item.TargetHydroExt || item.HydroExt) - item.HydroExt) >= 0.1"> {{ roundToDecimal(item.HydroExt, 1) }}% → {{ roundToDecimal(item.TargetHydroExt, 1) }}% </template>
                                    <template v-else> {{ roundToDecimal(item.TargetHydroExt != null ? item.TargetHydroExt : item.HydroExt, 1) }}% </template>
                                  </v-list-item-title>
                                  <v-list-item-subtitle v-if="Math.abs(item.HydroExtChange || 0) >= 0.1"> Change of {{ item.HydroExtChange > 0 ? '+' : '' }}{{ roundToDecimal(item.HydroExtChange, 1) }} pts expected </v-list-item-subtitle>
                                  <v-list-item-subtitle v-else> Minimal change expected </v-list-item-subtitle>
                                </v-list-item-content>
                              </v-list-item>
                            </v-card>
                          </v-col>
                        </v-row>
                      </v-col>
                    </v-row>
                  </v-container>
                </td>
              </template>
              <template #[`item.SystemBodyOrder`]="{ item }">
                {{ systemBodyName(item) }}
              </template>
              <template #[`item.GroundMineralSurvey`]="{ item }">
                <v-tooltip top>
                  <template #activator="{ on }">
                    <span v-if="item.GroundMineralSurvey" v-on="on">M{{ item.GroundMineralSurvey }}</span>
                    <span v-else v-on="on">❌</span>
                  </template>

                  <span>{{ GroundMineralSurveyMap[item.GroundMineralSurvey] }}</span>
                </v-tooltip>
              </template>
              <template #[`item.CurrentColonyCostOverall`]="{ item }">
                <span v-if="item.CurrentColonyCostOverall != null && item.CurrentColonyCostPeriapsis != null && item.CurrentColonyCostApoapsis != null">
                  <span v-if="item.CurrentColonyCostOverall === item.CurrentColonyCostPeriapsis && item.CurrentColonyCostOverall === item.CurrentColonyCostApoapsis">
                    {{ roundToDecimal(item.CurrentColonyCostOverall, 2) }}
                  </span>
                  <span v-else-if="item.CurrentColonyCostPeriapsis === item.CurrentColonyCostApoapsis">
                    {{ roundToDecimal(item.CurrentColonyCostOverall, 2) }}
                  </span>
                  <span v-else> {{ roundToDecimal(Math.min(item.CurrentColonyCostPeriapsis, item.CurrentColonyCostApoapsis), 2) }}–{{ roundToDecimal(Math.max(item.CurrentColonyCostPeriapsis, item.CurrentColonyCostApoapsis), 2) }} </span>
                </span>
                <span v-else>N/A</span>
              </template>
              <template #[`item.MaximumPopulation`]="{ item }">
                <v-tooltip v-if="item.Populations.length" top>
                  <template #activator="{ on }">
                    <span
                      :class="{
                        'green--text text--lighten-1 font-weight-bold': item.OwnPopulation && !item.OtherPopulation,
                        'red--text text--darken-3 font-weight-bold': !item.OwnPopulation && item.OtherPopulation,
                        'orange--text font-weight-bold': item.OwnPopulation && item.OtherPopulation,
                      }"
                      v-on="on"
                    >
                      <span class="text-no-wrap">{{ separatedNumber(roundToDecimal(item.TotalPopulation, 2), separator) }}</span> / <span class="text-no-wrap">{{ separatedNumber(roundToDecimal(item.MaximumPopulation, 2), separator) }}</span>
                    </span>
                  </template>

                  <span v-if="item.OwnPopulation && item.OtherPopulation"> Mixed Population </span>
                  <span v-else-if="item.OwnPopulation"> Own Population </span>
                  <span v-else> Alien Population </span>
                </v-tooltip>
                <span v-else>{{ separatedNumber(roundToDecimal(item.MaximumPopulation, 2), separator) }}</span>
              </template>
              <template #[`item.MaximumPopulationAtOptimalHydro`]="{ item }">
                <span v-if="item.MaximumPopulationAtOptimalHydro === item.MaximumPopulation" class="green--text text--lighten-1 font-weight-bold"> Optimal </span>
                <span v-else>
                  {{ separatedNumber(roundToDecimal(item.MaximumPopulationAtOptimalHydro, 2), separator) }}
                </span>
              </template>
              <template #[`item.PlannedColonyCostMetric`]="{ item }">
                <v-tooltip v-if="item.PlannedColonyCostOverall != null && item.TerraformationTime > 0" top>
                  <template #activator="{ on, attrs }">
                    <span
                      :class="{
                        'green--text text--lighten-1 font-weight-bold': item.TerraformableStatus.startsWith('Done') || item.TerraformableStatus.startsWith('Yes'),
                        'light-blue--text text--lighten-1 font-weight-bold': item.TerraformableStatus.startsWith('Partial'),
                        'teal--text text--lighten-1 font-weight-bold': item.TerraformableStatus.startsWith('Near'),
                        'orange--text font-weight-bold': item.TerraformableStatus.startsWith('Limited') || item.TerraformableStatus.includes('(LG)'),
                        'deep-orange--text darken-1 font-weight-bold': item.TerraformableStatus.startsWith('Insufficient'),
                        'red--text text--darken-3 font-weight-bold': item.TerraformableStatus.startsWith('No'),
                      }"
                      v-bind="attrs"
                      v-on="on"
                    >
                      {{ item.TerraformableStatus }}
                    </span>
                  </template>
                  <span>Planned Colony Cost: {{ roundToDecimal(item.PlannedColonyCostMetric, 2) }}</span>
                </v-tooltip>
                <span
                  v-else
                  :class="{
                    'green--text text--lighten-1 font-weight-bold': item.TerraformableStatus.startsWith('Done') || item.TerraformableStatus.startsWith('Yes'),
                    'light-blue--text text--lighten-1 font-weight-bold': item.TerraformableStatus.startsWith('Partial'),
                    'teal--text text--lighten-1 font-weight-bold': item.TerraformableStatus.startsWith('Near'),
                    'orange--text font-weight-bold': item.TerraformableStatus.startsWith('Limited') || item.TerraformableStatus.includes('(LG)'),
                    'deep-orange--text darken-1 font-weight-bold': item.TerraformableStatus.startsWith('Insufficient'),
                    'red--text text--darken-3 font-weight-bold': item.TerraformableStatus.startsWith('No'),
                  }"
                >
                  {{ item.TerraformableStatus }}
                </span>
              </template>
              <template #[`item.TerraformationTime`]="{ item }">
                <span v-if="item.TerraformationTime > 0">
                  {{ separatedNumber(roundToDecimal(item.TerraformationTime, 1), separator) }}
                </span>
                <span v-else-if="item.TerraformableStatus.startsWith('No')" class="red--text text--darken-3 font-weight-bold"> Impossible </span>
                <span v-else-if="item.TerraformableStatus.startsWith('Done') || item.TerraformableStatus.startsWith('Yes')" class="green--text text--lighten-1 font-weight-bold"> Done </span>
                <span v-else-if="item.TerraformableStatus.startsWith('Partial')" class="light-blue--text text--lighten-1 font-weight-bold"> Done </span>
                <span v-else-if="item.TerraformableStatus.startsWith('Near')" class="teal--text text--lighten-1 font-weight-bold"> Done </span>
                <span v-else-if="item.TerraformableStatus.startsWith('Limited') || item.TerraformableStatus.includes('(LG)')" class="orange--text font-weight-bold"> Done </span>
                <span v-else class="red--text text--darken-3 font-weight-bold">Impossible</span>
              </template>
              <template #[`item.MiningPotential`]="{ item }">
                <span
                  v-if="item.Minerals.length"
                  :class="{
                    'green--text text--lighten-1 font-weight-bold title': item.MiningPotential >= 7.5,
                    'red--text text--darken-3 font-weight-bold': item.MiningPotential <= 3,
                  }"
                  >{{ roundToDecimal(item.MiningPotential, 1) }}</span
                >
                <span v-else class="orange--text font-weight-bold">N/A</span>
              </template>
              <template #[`header.MiningPotential`]="{ header }">
                <v-tooltip top>
                  <template #activator="{ on }">
                    <span v-on="on">{{ header.text }}<sup>(?)</sup></span>
                  </template>
                  <span>Potential calculated for available minerals on the body.</span>
                </v-tooltip>
              </template>
              <template #[`item.TotalMiningAmount`]="{ item }">
                <span v-if="!item.BodySurveyed" class="orange--text font-weight-bold"> Unsurveyed </span>
                <span v-else>
                  <span class="text-no-wrap">{{ separatedNumber(roundToDecimal(item.TotalMiningAmount), separator) }}</span>
                </span>
              </template>
            </v-data-table>
          </v-col>
        </v-row>
      </v-container>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import _partition from 'lodash/partition'
import _intersectionBy from 'lodash/intersectionBy'
import _clamp from 'lodash/clamp'

import { separatedNumber, roundToDecimal } from '../utilities/math'
import { systemBodyName } from '../utilities/aurora'
import { areSetsEqual } from '../utilities/generic'

const MaterialMap = {
  // 0: 'Nothing',
  1: 'Duranium',
  2: 'Neutronium',
  3: 'Corbomite',
  4: 'Tritanium',
  5: 'Boronide',
  6: 'Mercassium',
  7: 'Vendarite',
  8: 'Sorium',
  9: 'Uridium',
  10: 'Corundium',
  11: 'Gallicite',
}

const GroundMineralSurveyMap = {
  0: 'Completed',
  1: 'Minimal',
  2: 'Low',
  3: 'Good',
  4: 'High',
  5: 'Excellent',
}

const BodyClass = {
  0: 'None',
  1: 'Planet',
  2: 'Moon',
  3: 'Asteroid',
  4: 'JumpPoint',
  5: 'Comet',
  6: 'LagrangePoint',
  7: 'Wormhole',
}

// const Hydrosphere = {
//   1: 'None',
//   2: 'Vapour',
//   3: 'Liquid',
//   4: 'Ice Sheet',
// }

const maxBreathablePercentage = 30
const earthSurfaceArea = 511187128
// const kmPerAU = 149600000
const baseMaxPop = 12000

export default {
  components: {},
  asyncData({ route }) {
    if (route.query.bodies) {
      const selectedBodies = route.query.bodies ? JSON.parse(route.query.bodies) : []

      return {
        selectedBodies,
        filterBySelectedBodies: !!(route.query.bodies && selectedBodies.length),
      }
    } else if (route.query.systems) {
      const systems = route.query.systems.split(',').map((id) => parseInt(id, 10))

      return {
        systems,
      }
    }

    return {}
  },
  data() {
    return {
      selectedSpeciesId: null,
      terraformers: 10,

      filterNonTerraformable: false,
      filterWithoutMinerals: false,
      filterOwnPopulations: false,
      filterOtherPopulations: false,
      filterDoneTerraforming: false,
      filterUninhabited: false,

      itemsPerPage: 10,
      sortBy: [],
      expandedRows: [],
      sortDescending: [false],

      systems: [],

      selectedBodies: [],
      filterBySelectedBodies: false,

      //

      rules: {
        required: (value) => !!value || 'Required.',
        positive: (value) => value > 0 || 'Must be positive.',
        integer: (value) => Number(value) === Number.parseInt(value) || 'Must be a whole number.',
      },
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    itemsPerPageOptions() {
      return [10, 30, 50, 100]
    },

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    activeFilterCount() {
      return [this.filterNonTerraformable, this.filterWithoutMinerals, this.filterOwnPopulations, this.filterOtherPopulations, this.filterDoneTerraforming, this.filterUninhabited].filter(Boolean).length
    },

    selectedSpecies() {
      const extant = this.species.find((species) => species.SpeciesID === this.selectedSpeciesId)

      return extant || {}
    },
    rawTerraformingPower() {
      return this.selectedSpecies.TerraformingRate * this.terraformers
    },

    filteredCalculatedBodies() {
      return this.calculatedBodies.filter((body) => {
        const inScope = this.filterBySelectedBodies ? !!this.selectedBodies.find((s) => s.SystemBodyID === body.SystemBodyID) : this.systems.includes(body.SystemID)

        const hideNonTerraformableOk = this.filterNonTerraformable ? body.Terraformable : true
        const hideWithoutMineralsOk = this.filterWithoutMinerals ? body.TotalMiningAmount > 0 : true
        const hideOwnPopulationOk = this.filterOwnPopulations ? !body.OwnPopulation || body.OtherPopulation : true
        const hideOtherPopulationOk = this.filterOtherPopulations ? !body.OtherPopulation || body.OwnPopulation : true
        const hideDoneTerraformingOk = this.filterDoneTerraforming ? body.TerraformationTime > 0 : true
        const hideUninhabitedOk = this.filterUninhabited ? body.TotalPopulation > 0 : true

        return inScope && hideNonTerraformableOk && hideWithoutMineralsOk && hideOwnPopulationOk && hideOtherPopulationOk && hideDoneTerraformingOk && hideUninhabitedOk
      })
    },
    calculatedBodies() {
      return this.selectedSpecies.SpeciesID ? this.bodies.filter((body) => body.Gravity <= this.selectedSpecies.IdealGravity + this.selectedSpecies.GravityDeviation).map(this._bodyMap) : []
    },

    systemNames() {
      if (!this.bodies || !this.bodies.length) {
        return []
      }

      return Object.values(
        this.bodies.reduce((names, item) => {
          if (!names[item.SystemID]) {
            names[item.SystemID] = {
              SystemID: item.SystemID,
              SystemName: item.SystemName,
            }
          }

          return names
        }, {})
      )
    },

    MaterialMap() {
      return MaterialMap
    },
    GroundMineralSurveyMap() {
      return GroundMineralSurveyMap
    },
    BodyClass() {
      return BodyClass
    },

    headers() {
      const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

      return [
        {
          text: 'System',
          value: 'SystemName',
          divider: true,
        },
        {
          text: 'Body',
          value: 'SystemBodyOrder',
          divider: true,
          sort: collator.compare,
        },
        {
          text: 'Ground',
          value: 'GroundMineralSurvey',
          divider: true,
          align: 'center',
        },
        {
          text: 'Current Cost',
          value: 'CurrentColonyCostOverall',
          divider: true,
          align: 'center',
        },
        {
          text: 'Max Population (M)',
          value: 'MaximumPopulation',
          divider: true,
        },
        {
          text: 'Optimal Max (M)',
          value: 'MaximumPopulationAtOptimalHydro',
          divider: true,
        },
        {
          text: 'Terraformable',
          value: 'PlannedColonyCostMetric',
          divider: true,
          align: 'center',
        },
        {
          text: 'Time (Y)',
          value: 'TerraformationTime',
          divider: true,
          align: 'center',
          sort: (alpha, beta) => (alpha === -Infinity ? (this.sortDescending[0] ? -1 : 1) : beta === -Infinity ? (this.sortDescending[0] ? 1 : -1) : alpha - beta),
        },
        {
          text: 'Potential',
          value: 'MiningPotential',
          divider: true,
          align: 'center',
        },
        {
          text: 'Total Minerals (T)',
          value: 'TotalMiningAmount',
          divider: true,
        },
      ]
    },

    unrestrictedSystems() {
      return _intersectionBy(
        this.surveyedSystems.filter((system) => system.RaceSystemSurveys.every((raceSystem) => !raceSystem.MilitaryRestrictedSystem)),
        this.systemNames,
        'SystemID'
      )
    },
    unrestrictedSystemsIds() {
      return this.unrestrictedSystems.map((system) => system.SystemID)
    },
    colonizedSystems() {
      return _intersectionBy(
        this.surveyedSystems.filter((system) => system.Populations.length),
        this.systemNames,
        'SystemID'
      )
    },
    colonizedSystemsIds() {
      return this.colonizedSystems.map((system) => system.SystemID)
    },
    inhabitedColonizedSystems() {
      return this.colonizedSystems.filter((system) => system.InhabitedColonies)
    },
    inhabitedColonizedSystemsIds() {
      return this.inhabitedColonizedSystems.map((system) => system.SystemID)
    },
  },
  watch: {
    itemsPerPage: {
      handler(newValue) {
        console.log('[Habitability] itemsPerPage changed:', newValue)
        this.$store.commit('tables/setHabitabilityItemsPerPage', newValue)
      },
    },
    sortBy: {
      deep: true,
      handler(newValue) {
        console.log('[Habitability] sortBy changed:', newValue)
        this.$store.commit('tables/setHabitabilitySortBy', newValue)
      },
    },
    sortDescending: {
      deep: true,
      handler(newValue) {
        console.log('[Habitability] sortDescending changed:', newValue)
        this.$store.commit('tables/setHabitabilitySortDescending', newValue)
        console.log('[Habitability] store after commit:', this.$store.state.tables.habitabilitySortDescending)
      },
    },
    systemNames: {
      immediate: true,
      handler(newNames) {
        if (newNames) {
          if (!this.systems.length) {
            this.systems = newNames.map((system) => system.SystemID)
          }
        }
      },
    },
    RaceID: {
      immediate: true,
      handler(newRaceID, oldRaceID) {
        if (oldRaceID) {
          this.config.set('habitabilitySystems', [])
          this.systems = []
        }
      },
    },
  },
  created() {
    this.terraformers = this.config.get('habitabilityTerraformers', 10)

    this.filterNonTerraformable = this.config.get('habitabilityFilterNonTerraformable', false)
    this.filterWithoutMinerals = this.config.get('habitabilityFilterWithoutMinerals', false)
    this.filterOwnPopulations = this.config.get('habitabilityFilterOwnPopulations', false)
    this.filterOtherPopulations = this.config.get('habitabilityFilterOtherPopulations', false)
    this.filterDoneTerraforming = this.config.get('habitabilityFilterDoneTerraforming', false)
    this.filterUninhabited = this.config.get('habitabilityFilterUninhabited', false)

    if (!this.systems.length) {
      this.systems = this.config.get('habitabilitySystems', this.systems)
    }

    // Initialize table settings from store
    if (this.$store.state.tables) {
      this.itemsPerPage = this.$store.state.tables.habitabilityItemsPerPage || 10
      this.sortBy = Array.isArray(this.$store.state.tables.habitabilitySortBy) ? [...this.$store.state.tables.habitabilitySortBy] : []
      this.sortDescending = Array.isArray(this.$store.state.tables.habitabilitySortDescending) ? [...this.$store.state.tables.habitabilitySortDescending] : [false]
      console.log('[Habitability] Initialized from store - itemsPerPage:', this.itemsPerPage, 'sortBy:', this.sortBy, 'sortDescending:', this.sortDescending)
    }
  },
  mounted() {
    //
  },
  methods: {
    separatedNumber,
    roundToDecimal,

    systemBodyName,

    getGasInfo(gasId) {
      if (!gasId || !this.gases || !this.gases.length) {
        return null
      }
      return this.gases.find((gas) => gas.GasID === gasId) || null
    },

    areSetsEqual,
    copyAtmosphereValue(value, decimals = 3) {
      let normalized = Number.isFinite(value) ? this.roundToDecimal(value, decimals) : 0
      if (!Number.isFinite(normalized)) {
        normalized = 0
      }
      const text = `${normalized}`

      const fallbackCopy = () => {
        if (typeof document === 'undefined') {
          return
        }
        const textArea = document.createElement('textarea')
        textArea.value = text
        textArea.setAttribute('readonly', '')
        textArea.style.position = 'absolute'
        textArea.style.left = '-9999px'
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand('copy')
        document.body.removeChild(textArea)
      }

      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy())
      } else {
        fallbackCopy()
      }
    },

    toggleSystems() {
      if (this.systems.length === this.systemNames.length) {
        this.systems = []
      } else {
        this.systems = this.systemNames.map((system) => system.SystemID)
      }

      this.config.set('habitabilitySystems', this.systems)
    },

    selectOurSystems() {
      this.systems = this.colonizedSystems.map((system) => system.SystemID)

      this.config.set('habitabilitySystems', this.systems)
    },
    selectOurInhabitedSystems() {
      this.systems = this.inhabitedColonizedSystems.map((system) => system.SystemID)

      this.config.set('habitabilitySystems', this.systems)
    },
    selectUnrestrictedSystems() {
      this.systems = this.unrestrictedSystems.map((system) => system.SystemID)

      this.config.set('habitabilitySystems', this.systems)
    },

    hydrosphereAtTemperature(temperature) {
      if (temperature <= 369) {
        if (temperature <= 245) {
          return 4 // Ice Sheet
        }

        return 3 // Liquid
      }

      return 2 // Vapour
    },

    determineHydrosphereState(surfaceTemp, totalPressure) {
      if (!Number.isFinite(totalPressure) || totalPressure <= 0) {
        return 1
      }

      if (totalPressure < 0.006 && surfaceTemp > 245) {
        return 1
      }

      if (surfaceTemp > 369) {
        return 2
      }

      if (surfaceTemp > 245) {
        return 3
      }

      return 4
    },

    calculateTargetHydroExt(currentHydroExt, projectedHydroId) {
      // Primary objective: Reach HydroExt >= 20 to avoid colony cost penalty
      // Secondary objective: Optimize for maximum population

      // If below 20, prioritize reaching at least 20 to eliminate colony cost
      if (currentHydroExt < 20) {
        return 20
      }

      // Once at or above 20, optimize for population based on hydrosphere type
      if (projectedHydroId === 3) {
        // Liquid water - target 50-75% range for optimal population
        // Population modifier: hydroExt > 75 reduces population by (100-hydroExt)/25
        if (currentHydroExt < 50) {
          // Gradually increase toward optimal range (60% is ideal)
          return Math.min(60, Math.max(20, currentHydroExt + 10))
        } else if (currentHydroExt > 75) {
          // Reduce directly to 75% to avoid population penalty
          // No need for gradual reduction since evaporation handles this naturally
          return 75
        }
        // Already in optimal range (50-75%)
        return _clamp(currentHydroExt, 50, 75)
      } else if (projectedHydroId === 4) {
        // Ice sheet - no population penalty above 20%, maintain at least 20
        // Since ice doesn't have the >75% penalty, can maintain higher if already there
        return Math.max(currentHydroExt, 20)
      } else if (projectedHydroId === 2) {
        // Vapor - want to increase to eventually form liquid for better habitability
        return Math.min(100, Math.max(20, currentHydroExt + 10))
      }

      // No hydrosphere (HydroID 1) - try to reach at least 20 if possible
      return Math.max(currentHydroExt, 20)
    },

    targetWaterForState(hydroId, hydroExtent, totalPressure) {
      if (!Number.isFinite(hydroExtent) || hydroExtent < 0) {
        return 0
      }

      // For liquid hydrosphere (HydroID 3), use relative humidity formula
      if (hydroId === 3) {
        return Math.max(totalPressure, 0) * (hydroExtent / 100) * 0.01
      }

      return 0
    },

    adjustAlbedoForHydrosphere(baseAlbedo, previousHydroId, predictedHydroId, hydroExtent) {
      if (predictedHydroId === previousHydroId) {
        return baseAlbedo
      }

      let adjusted = baseAlbedo

      if (previousHydroId !== 4) {
        if (predictedHydroId === 4) {
          adjusted -= hydroExtent * 0.0015
        }
      } else {
        adjusted += hydroExtent * 0.0015
      }

      if (!Number.isFinite(adjusted) || adjusted <= 0) {
        return baseAlbedo
      }

      return adjusted
    },

    computeAtmosphereMultipliers(totalPressure, greenhousePressure, antiPressure, dustTerm = 0) {
      const safeTotal = Math.max(totalPressure, 0)
      let greenhouseMultiplier = 1 + safeTotal / 10 + Math.max(greenhousePressure, 0)
      if (greenhouseMultiplier > 3) {
        greenhouseMultiplier = 3
      }

      let antiMultiplier = 1 + Math.max(dustTerm, 0) + Math.max(antiPressure, 0)
      if (antiMultiplier > 3) {
        antiMultiplier = 3
      }

      return { greenhouseMultiplier, antiMultiplier }
    },

    calculateSurfaceTemperatureAtOrbitalDistance(body, distanceAU) {
      if (!body || !Array.isArray(body.Atmosphere) || !Number.isFinite(distanceAU) || distanceAU <= 0) {
        return null
      }

      // Retry
      let equilibriumTemperature = 255 / Math.sqrt(distanceAU / Math.sqrt(body.StarLuminosity))
      if (equilibriumTemperature < 4) {
        equilibriumTemperature = 4
      }

      const temperatureRatio = body.SurfaceTemp / (body.BaseTemp * body.Albedo)
      const greenhouseThresholdTemperature = equilibriumTemperature * body.Albedo * temperatureRatio

      let greenhouseMultiplier = 1
      let antiGreenhouseMultipler = 1

      if (body.Atmosphere.length > 0) {
        let greenhouseAtm = 0
        let antiGreenhouseAtm = 0

        body.Atmosphere.forEach((gas) => {
          if (greenhouseThresholdTemperature >= gas.BoilingPoint) {
            if (gas.GHGas) {
              greenhouseAtm += gas.GasAtm
            }

            if (gas.AntiGHGas) {
              antiGreenhouseAtm += gas.GasAtm
            }
          }
        })

        greenhouseMultiplier = 1 + body.AtmosPress / 10 + greenhouseAtm
        if (greenhouseMultiplier > 3) {
          greenhouseMultiplier = 3
        }

        antiGreenhouseMultipler = 1 + body.DustLevel / 20000 + antiGreenhouseAtm
        if (antiGreenhouseMultipler > 3) {
          antiGreenhouseMultipler = 3
        }
      }

      let predictedSurfaceTemperature = (equilibriumTemperature * greenhouseMultiplier * body.Albedo) / antiGreenhouseMultipler
      if (predictedSurfaceTemperature < 1) {
        predictedSurfaceTemperature = 1
      }

      if (body.HydroExt > 0) {
        const previousHydrosphere = body.HydroID
        const predictedHydrosphere = this.hydrosphereAtTemperature(predictedSurfaceTemperature)

        if (previousHydrosphere !== predictedHydrosphere) {
          let adjustedAlbedo = body.Albedo

          if (previousHydrosphere !== 4) {
            if (predictedHydrosphere === 4) {
              adjustedAlbedo -= body.HydroExt * 0.0015
            }
          } else {
            adjustedAlbedo += body.HydroExt * 0.0015
          }
          predictedSurfaceTemperature = (equilibriumTemperature * greenhouseMultiplier * adjustedAlbedo) / antiGreenhouseMultipler
          if (predictedSurfaceTemperature < 1) {
            predictedSurfaceTemperature = 1
          }
        }
      }

      return predictedSurfaceTemperature
    },

    colonyCostAtDistance(body, distanceAU) {
      if (!body || !this.selectedSpecies || !this.selectedSpecies.SpeciesID) {
        return null
      }

      if (body.FixedBody || body.BodyTypeID === 4 || body.BodyTypeID === 5) {
        return -1
      }

      const species = this.selectedSpecies

      let surfaceTemperature = body.SurfaceTemp
      if (body.Eccentricity > 0 || body.BodyClass === 2) {
        surfaceTemperature = this.calculateSurfaceTemperatureAtOrbitalDistance(body, distanceAU)
      }

      let colonyCost = 0

      if (surfaceTemperature >= species.MinimumTemperature) {
        if (surfaceTemperature > species.MaximumTemperature) {
          colonyCost = Math.abs(species.MaximumTemperature - surfaceTemperature) / species.TemperatureDeviation
        }
      } else {
        colonyCost = Math.abs(species.MinimumTemperature - surfaceTemperature) / species.TemperatureDeviation
      }

      if (body.TidalLock && BodyClass[body.BodyClass] !== 'Moon') {
        colonyCost /= 5
      }

      let pressureMinimumCost = 0
      if (body.AtmosPress > species.MaximumPressure) {
        pressureMinimumCost = body.AtmosPress / species.MaximumPressure
        if (pressureMinimumCost < 2) {
          pressureMinimumCost = 2
        }
      }

      if (colonyCost < pressureMinimumCost) {
        colonyCost = pressureMinimumCost
      }

      let maxDangerousRating = 0
      body.Atmosphere.forEach((gas) => {
        // Check if gas is frozen out at this temperature
        const isFrozenOut = gas.FrozenOut || (Number.isFinite(gas.BoilingPoint) && surfaceTemperature < gas.BoilingPoint)

        if (gas.Dangerous > maxDangerousRating && gas.AtmosGasID !== species.BreatheID && !isFrozenOut) {
          const requiredPartialPressure = gas.DangerousLevel / 10000
          if (gas.AtmosGasAmount > requiredPartialPressure) {
            maxDangerousRating = gas.Dangerous
          }
        }
      })

      const dangerousGasMinimumCost = maxDangerousRating
      if (colonyCost < dangerousGasMinimumCost) {
        colonyCost = dangerousGasMinimumCost
      }

      if (Math.round(colonyCost * 10000) / 10000 < 2) {
        const breathableGasPressure = body.Atmosphere.reduce((total, gas) => {
          if (gas.AtmosGasID === species.BreatheID) {
            // Check if gas is frozen out at this temperature
            const isFrozenOut = gas.FrozenOut || (Number.isFinite(gas.BoilingPoint) && surfaceTemperature < gas.BoilingPoint)
            if (!isFrozenOut) {
              return total + gas.GasAtm
            }
          }

          return total
        }, 0)
        const breathableGasAmount = body.Atmosphere.reduce((total, gas) => {
          if (gas.AtmosGasID === species.BreatheID) {
            // Check if gas is frozen out at this temperature
            const isFrozenOut = gas.FrozenOut || (Number.isFinite(gas.BoilingPoint) && surfaceTemperature < gas.BoilingPoint)
            if (!isFrozenOut) {
              return total + gas.AtmosGasAmount
            }
          }

          return total
        }, 0)

        if (breathableGasPressure < species.MinimumBreathablePressure || breathableGasPressure > species.MaximumBreathablePressure) {
          colonyCost = 2
        } else if (breathableGasAmount > maxBreathablePercentage) {
          colonyCost = 2
        }
      }

      if (body.HydroExt < 20) {
        const hydrosphereMinimumCost = (20 - body.HydroExt) / 10
        if (colonyCost < hydrosphereMinimumCost) {
          colonyCost = hydrosphereMinimumCost
        }
      }

      if (body.Gravity < species.MinimumGravity && colonyCost < 1) {
        colonyCost = 1
      }

      return (Math.round(colonyCost * 10000) / 10000) * this.race.ColonizationSkill
    },

    colonyCosts(body) {
      if (!body || !this.selectedSpecies || !this.selectedSpecies.SpeciesID) {
        return {
          overall: null,
          periapsis: null,
          apoapsis: null,
        }
      }

      const isMoon = BodyClass[body.BodyClass] === 'Moon'
      const orbitalDistance = isMoon ? body.ParentOrbitalDistance : body.OrbitalDistance
      const orbitalEccentricity = isMoon ? body.ParentEccentricity : body.Eccentricity

      const species = this.selectedSpecies

      const periapsisDistance = orbitalDistance * (1 - orbitalEccentricity)
      const apoapsisDistance = orbitalDistance * (1 + orbitalEccentricity)

      let colonyCost = 0
      let currentCC = 0
      let periapsisCC = 0
      let apoapsisCC = 0

      let temperatureMinimumCost = 0

      if (body.BodyTypeID === 4 || body.BodyTypeID === 5 || body.Gravity > species.MaximumGravity || body.FixedBody) {
        return {
          overall: -1,
          periapsis: -1,
          apoapsis: -1,
        }
      } else {
        let maxDangerousRating = 0
        body.Atmosphere.forEach((gas) => {
          // Check if gas is frozen out at this temperature
          const isFrozenOut = gas.FrozenOut || (Number.isFinite(gas.BoilingPoint) && body.SurfaceTemp < gas.BoilingPoint)

          if (gas.Dangerous > maxDangerousRating && gas.AtmosGasID !== species.BreatheID && !isFrozenOut) {
            const requiredPartialPressure = gas.DangerousLevel / 10000
            if (gas.AtmosGasAmount > requiredPartialPressure) {
              maxDangerousRating = gas.Dangerous
            }
          }
        })

        colonyCost = maxDangerousRating

        //
        if (body.SurfaceTemp >= species.MinimumTemperature) {
          if (body.SurfaceTemp > species.MaximumTemperature) {
            temperatureMinimumCost = Math.abs(species.MaximumTemperature - body.SurfaceTemp) / species.TemperatureDeviation
          }
        } else {
          temperatureMinimumCost = Math.abs(species.MinimumTemperature - body.SurfaceTemp) / species.TemperatureDeviation
        }

        if (body.TidalLock && BodyClass[body.BodyClass] !== 'Moon') {
          temperatureMinimumCost /= 5
        }

        if (colonyCost < temperatureMinimumCost) {
          colonyCost = temperatureMinimumCost
        }

        //
        let pressureMinimumCost = 0
        if (body.AtmosPress > species.MaximumPressure) {
          pressureMinimumCost = body.AtmosPress / species.MaximumPressure
          if (pressureMinimumCost < 2) {
            pressureMinimumCost = 2
          }
        }

        if (colonyCost < pressureMinimumCost) {
          colonyCost = pressureMinimumCost
        }

        //
        if (Math.round(colonyCost * 10000) / 10000 < 2) {
          const breathableGasPressure = body.Atmosphere.reduce((total, gas) => {
            if (gas.AtmosGasID === species.BreatheID) {
              // Check if gas is frozen out at this temperature
              const isFrozenOut = gas.FrozenOut || (Number.isFinite(gas.BoilingPoint) && body.SurfaceTemp < gas.BoilingPoint)
              if (!isFrozenOut) {
                return total + gas.GasAtm
              }
            }

            return total
          }, 0)
          const breathableGasAmount = body.Atmosphere.reduce((total, gas) => {
            if (gas.AtmosGasID === species.BreatheID) {
              // Check if gas is frozen out at this temperature
              const isFrozenOut = gas.FrozenOut || (Number.isFinite(gas.BoilingPoint) && body.SurfaceTemp < gas.BoilingPoint)
              if (!isFrozenOut) {
                return total + gas.AtmosGasAmount
              }
            }

            return total
          }, 0)

          if (breathableGasPressure < species.MinimumBreathablePressure || breathableGasPressure > species.MaximumBreathablePressure) {
            colonyCost = 2
          } else if (breathableGasAmount > maxBreathablePercentage) {
            colonyCost = 2
          }
        }

        //
        if (body.HydroExt < 20) {
          const hydrosphereMinimumCost = (20 - body.HydroExt) / 10
          if (colonyCost < hydrosphereMinimumCost) {
            colonyCost = hydrosphereMinimumCost
          }
        }

        //
        if (body.Gravity < species.MinimumGravity && colonyCost < 1) {
          colonyCost = 1
        }

        currentCC = (Math.round(colonyCost * 10000) / 10000) * this.race.ColonizationSkill
      }

      if (currentCC <= -1 || (orbitalEccentricity <= 0 && !isMoon)) {
        return {
          overall: currentCC,
          periapsis: currentCC,
          apoapsis: currentCC,
        }
      } else {
        periapsisCC = this.colonyCostAtDistance(body, periapsisDistance)
        apoapsisCC = this.colonyCostAtDistance(body, apoapsisDistance)

        return {
          overall: currentCC,
          periapsis: periapsisCC,
          apoapsis: apoapsisCC,
        }
      }
    },

    makeTerraformationPlan(body) {
      // Terraforming information we know upfront
      // - HydroID is determined by SurfaceTemp
      //   - HydroID 1 -> None, when AtmosPress = 0 or (AtmosPress < 0.006 and SurfaceTemp > 245K)
      //   - HydroID 2 -> Vapour, when SurfaceTemp > 369K and AtmosPress >= 0.006
      //   - HydroID 3 -> Liquid, when 245K < SurfaceTemp <= 369K and AtmosPress >= 0.006
      //   - HydroID 4 -> Ice Sheet, when SurfaceTemp <= 245K and AtmosPress >= 0.006
      // - There is a target atmospheric water vapour level that changes over time approaching the following formula: body.AtmosPress * (body.HydroExt / 100) * 0.01
      // - A non liquid HydroID will target a water vapour pressure of HydroExt / 40
      // - Bodies with a SurfaceTemp below 369K condense water vapour to HydroExt to reach the target level, all bodies with an HydroExt above 0 evaporate water vapour to reach the target level
      // - Evaporating and condensing water vapour changes to HydroExt with a ratio of 40 times the pressure change
      // - Changes in atmospheric composition and temperature will lead to changes in HydroExt and Albedo, that might affect the final values
      // - A perfect terraformation is not possible if the species temperature range can't be made to overlap completely with the body's terraformed temperature range
      if (!body || !Array.isArray(body.Atmosphere) || !this.selectedSpecies || !this.selectedSpecies.SpeciesID) {
        return null
      }

      const species = this.selectedSpecies
      const tolerance = 1e-4
      const determineHydrosphere = this.determineHydrosphereState
      const targetWaterForState = this.targetWaterForState
      const adjustAlbedoForHydrosphere = this.adjustAlbedoForHydrosphere
      const computeMultipliers = this.computeAtmosphereMultipliers

      const localSurfaceArea = 4 * Math.PI * Math.pow(body.Radius, 2)
      const localTerraformingPower = localSurfaceArea > 0 ? (earthSurfaceArea / localSurfaceArea) * this.rawTerraformingPower : 0
      if (!Number.isFinite(localTerraformingPower) || localTerraformingPower <= 0) {
        return null
      }

      const computeTerraformingTime = (delta, rate, fallback = 0) => {
        const magnitude = Math.abs(delta)
        if (magnitude < tolerance) {
          return 0
        }

        const effectiveRate = rate > 0 ? rate : fallback
        if (!effectiveRate || !Number.isFinite(effectiveRate)) {
          return Number.POSITIVE_INFINITY
        }

        return magnitude / effectiveRate
      }

      const computeSwingRatios = (distance, eccentricity) => {
        let low = 1
        let high = 1

        if (Number.isFinite(distance) && distance > 0 && Number.isFinite(eccentricity) && eccentricity > 0) {
          const apoDistance = distance * (1 + eccentricity)
          if (apoDistance > 0) {
            low = Math.min(1, Math.sqrt(distance / apoDistance))
          }

          const periDistance = distance * (1 - eccentricity)
          if (periDistance > 0) {
            high = Math.max(1, Math.sqrt(distance / periDistance))
          }
        }

        return { low, high }
      }

      const isMoon = BodyClass[body.BodyClass] === 'Moon'
      const orbitalDistance = isMoon ? body.ParentOrbitalDistance : body.OrbitalDistance
      const orbitalEccentricity = isMoon ? body.ParentEccentricity : body.Eccentricity
      const { low: lowSwingRatio, high: highSwingRatio } = computeSwingRatios(orbitalDistance, orbitalEccentricity)

      const atmosphereSummary = body.Atmosphere.reduce(
        (summary, gas) => {
          const pressure = Number.isFinite(gas.GasAtm) ? gas.GasAtm : 0
          summary.totalPressure += pressure

          if (gas.AtmosGasID === species.BreatheID) {
            summary.breathablePressure += pressure
            summary.breathableGas = gas
          } else if (gas.Dangerous) {
            summary.toxicPressure += pressure
            summary.toxics.push(gas)
          } else if (gas.AtmosGasID === 5) {
            summary.waterVapourPressure += pressure
            summary.waterVapourGas = gas
          } else if (gas.GHGas) {
            summary.greenhousePressure += pressure
            summary.greenhouses.push(gas)
          } else if (gas.AntiGHGas) {
            summary.antiGreenhousePressure += pressure
            summary.antiGreenhouses.push(gas)
          } else {
            summary.neutralPressure += pressure
            summary.neutrals.push(gas)
          }

          return summary
        },
        {
          breathablePressure: 0,
          breathableGas: null,
          toxicPressure: 0,
          toxics: [],
          greenhousePressure: 0,
          greenhouses: [],
          antiGreenhousePressure: 0,
          antiGreenhouses: [],
          waterVapourPressure: 0,
          waterVapourGas: null,
          neutralPressure: 0,
          neutrals: [],
          totalPressure: 0,
        }
      )

      const greenhouseSideContributions = atmosphereSummary.greenhouses.slice(1).reduce((total, gas) => total + (gas.GasAtm || 0), 0)
      const antiGreenhouseSideContributions = atmosphereSummary.antiGreenhouses.slice(1).reduce((total, gas) => total + (gas.GasAtm || 0), 0)
      const neutralSideContributions = atmosphereSummary.neutrals.slice(1).reduce((total, gas) => total + (gas.GasAtm || 0), 0)

      const breathableRangeMin = Math.max(0, species.IdealBreathePressure - species.BreathePressureDeviation)
      const breathableRangeMax = species.IdealBreathePressure + species.BreathePressureDeviation
      const currentBreathablePressure = Math.max(atmosphereSummary.breathablePressure, 0)
      let targetBreathablePressure
      if (currentBreathablePressure >= breathableRangeMin - tolerance && currentBreathablePressure <= breathableRangeMax + tolerance) {
        targetBreathablePressure = _clamp(currentBreathablePressure, breathableRangeMin, breathableRangeMax)
      } else {
        const distanceToMin = Math.abs(currentBreathablePressure - breathableRangeMin)
        const distanceToMax = Math.abs(currentBreathablePressure - breathableRangeMax)
        targetBreathablePressure = distanceToMin <= distanceToMax ? breathableRangeMin : breathableRangeMax
      }
      targetBreathablePressure = _clamp(targetBreathablePressure, breathableRangeMin, breathableRangeMax)

      const speciesMinTemperature = species.IdealTemperature - species.TemperatureDeviation
      const speciesMaxTemperature = species.IdealTemperature + species.TemperatureDeviation
      const minAllowedMeanTemperature = speciesMinTemperature / (lowSwingRatio || 1)
      const maxAllowedMeanTemperature = speciesMaxTemperature / (highSwingRatio || 1)

      // If the orbital eccentricity makes it impossible to fit both perihelion and aphelion
      // within the species' temperature range, target the best compromise temperature
      let targetMeanTemperature
      let isPartialSolution = false

      if (minAllowedMeanTemperature > maxAllowedMeanTemperature) {
        // Can't perfectly satisfy temperature at both orbital extremes
        // Target the midpoint to minimize total colony cost
        targetMeanTemperature = (minAllowedMeanTemperature + maxAllowedMeanTemperature) / 2
        isPartialSolution = true
      } else {
        // Can achieve perfect habitability
        targetMeanTemperature = _clamp(species.IdealTemperature, minAllowedMeanTemperature, maxAllowedMeanTemperature)
      }

      // Determine which gases to use for greenhouse, anti-greenhouse, and neutral
      // Prefer existing gases on the planet when possible
      const greenhouseGasId = atmosphereSummary.greenhouses.length ? atmosphereSummary.greenhouses[0].AtmosGasID : 20 // Aestusium
      const greenhouseName = atmosphereSummary.greenhouses.length ? atmosphereSummary.greenhouses[0].AtmosGasName : 'Aestusium'
      const antiGreenhouseGasId = atmosphereSummary.antiGreenhouses.length ? atmosphereSummary.antiGreenhouses[0].AtmosGasID : 22 // Frigusium
      const antiGreenhouseName = atmosphereSummary.antiGreenhouses.length ? atmosphereSummary.antiGreenhouses[0].AtmosGasName : 'Frigusium'
      const neutralGasId = atmosphereSummary.neutrals.length ? atmosphereSummary.neutrals[0].AtmosGasID : 7 // Nitrogen
      const neutralName = atmosphereSummary.neutrals.length ? atmosphereSummary.neutrals[0].AtmosGasName : 'Nitrogen'

      // Collect all side contribution gases (non-primary gases) to preserve them
      const greenhouseSideGases = atmosphereSummary.greenhouses.slice(1)
      const antiGreenhouseSideGases = atmosphereSummary.antiGreenhouses.slice(1)
      const neutralSideGases = atmosphereSummary.neutrals.slice(1)

      const toxicsPlan = atmosphereSummary.toxics.map((gas) => ({
        AtmosGasID: gas.AtmosGasID,
        AtmosGasName: gas.AtmosGasName,
        GasAtm: gas.GasAtm,
        RemovalTime: computeTerraformingTime(gas.GasAtm, localTerraformingPower),
      }))

      const dustTerm = Math.max(Number.isFinite(body.DustLevel) ? body.DustLevel : 0, 0) / 20000

      const computeRatio = (totalPressure, greenhousePressure, antiPressure) => {
        const { greenhouseMultiplier, antiMultiplier } = computeMultipliers(totalPressure, greenhousePressure, antiPressure, dustTerm)
        return greenhouseMultiplier / (antiMultiplier || 1)
      }

      const solveForAlbedo = (albedo) => {
        const baseTemperatureReference = Math.max(body.BaseTemp * albedo, 1)
        if (!Number.isFinite(baseTemperatureReference) || baseTemperatureReference <= 0) {
          return null
        }

        const targetRatio = targetMeanTemperature / baseTemperatureReference

        let finalWater = Math.min(Math.max(atmosphereSummary.waterVapourPressure, 0), species.MaximumPressure)
        const baseNeutralMain = Math.max(atmosphereSummary.neutralPressure - neutralSideContributions, 0)
        let finalNeutralMain = Math.min(baseNeutralMain, Math.max(species.MaximumPressure - neutralSideContributions, 0))
        if (!Number.isFinite(finalNeutralMain) || finalNeutralMain < 0) {
          finalNeutralMain = 0
        }
        let totalNeutral = finalNeutralMain + neutralSideContributions
        let finalGreenhouse = Math.max(atmosphereSummary.greenhousePressure, greenhouseSideContributions)
        let finalAnti = Math.max(atmosphereSummary.antiGreenhousePressure, antiGreenhouseSideContributions)
        let finalTotal = Math.max(atmosphereSummary.totalPressure, 0)
        let finalRatio = targetRatio
        let finalSurfaceTemperature = targetMeanTemperature
        let projectedHydroId = body.HydroID
        let targetHydroExt = body.HydroExt

        for (let iteration = 0; iteration < 16; iteration += 1) {
          const previousNeutralMain = finalNeutralMain
          const previousWater = finalWater

          const nonNeutralSum = targetBreathablePressure + finalWater + finalGreenhouse + finalAnti
          const minimumNeutralTotal = Math.max(neutralSideContributions, targetBreathablePressure > 0 ? targetBreathablePressure / 0.3 - nonNeutralSum : neutralSideContributions)
          const maximumNeutralTotal = Math.max(neutralSideContributions, species.MaximumPressure - nonNeutralSum)

          if (minimumNeutralTotal > maximumNeutralTotal + tolerance) {
            return null
          }

          const minimumNeutralMain = Math.max(0, minimumNeutralTotal - neutralSideContributions)
          const maximumNeutralMain = Math.max(0, maximumNeutralTotal - neutralSideContributions)

          finalNeutralMain = _clamp(minimumNeutralMain, 0, maximumNeutralMain)
          totalNeutral = finalNeutralMain + neutralSideContributions

          finalTotal = nonNeutralSum + totalNeutral
          finalRatio = computeRatio(finalTotal, finalGreenhouse, finalAnti)
          finalSurfaceTemperature = finalRatio * baseTemperatureReference
          projectedHydroId = determineHydrosphere(finalSurfaceTemperature, finalTotal)

          // Calculate target HydroExt based on projected hydrosphere state
          targetHydroExt = this.calculateTargetHydroExt(body.HydroExt, projectedHydroId)

          const desiredWater = targetWaterForState(projectedHydroId, targetHydroExt, finalTotal)
          finalWater = Math.min(Math.max(desiredWater, 0), species.MaximumPressure)

          const ratioError = finalRatio - targetRatio
          const neutralChange = Math.abs(finalNeutralMain - previousNeutralMain)
          const waterChange = Math.abs(finalWater - previousWater)

          if (Math.abs(ratioError) < tolerance && neutralChange < tolerance && waterChange < tolerance) {
            break
          }

          if (Math.abs(ratioError) >= tolerance) {
            if (ratioError > 0) {
              const greenhouseAdjustable = Math.max(finalGreenhouse - greenhouseSideContributions, 0)
              if (greenhouseAdjustable > tolerance) {
                const scale = targetRatio / finalRatio
                finalGreenhouse = greenhouseSideContributions + greenhouseAdjustable * scale
              } else {
                const antiCapacity = Math.max(0, species.MaximumPressure - finalTotal)
                if (antiCapacity <= tolerance) {
                  return null
                }
                const antiDelta = Math.min(Math.max(ratioError, tolerance), antiCapacity)
                finalAnti += antiDelta
              }
            } else {
              const antiAdjustable = Math.max(finalAnti - antiGreenhouseSideContributions, 0)
              if (antiAdjustable > tolerance) {
                const scale = targetRatio / finalRatio
                finalAnti = antiGreenhouseSideContributions + antiAdjustable * scale
              } else {
                const greenhouseCapacity = Math.max(0, species.MaximumPressure - finalTotal)
                if (greenhouseCapacity <= tolerance) {
                  return null
                }
                const greenhouseDelta = Math.min(Math.max(-ratioError, tolerance), greenhouseCapacity)
                finalGreenhouse += greenhouseDelta
              }
            }
          }
        }

        const nonNeutralSum = targetBreathablePressure + finalWater + finalGreenhouse + finalAnti
        const minimumNeutralFinalTotal = Math.max(neutralSideContributions, targetBreathablePressure > 0 ? targetBreathablePressure / 0.3 - nonNeutralSum : neutralSideContributions)
        const maximumNeutralFinalTotal = Math.max(neutralSideContributions, species.MaximumPressure - nonNeutralSum)

        if (minimumNeutralFinalTotal > maximumNeutralFinalTotal + tolerance) {
          return null
        }

        const minimumNeutralFinalMain = Math.max(0, minimumNeutralFinalTotal - neutralSideContributions)
        const maximumNeutralFinalMain = Math.max(0, maximumNeutralFinalTotal - neutralSideContributions)

        finalNeutralMain = _clamp(minimumNeutralFinalMain, 0, maximumNeutralFinalMain)
        totalNeutral = finalNeutralMain + neutralSideContributions
        finalTotal = nonNeutralSum + totalNeutral
        finalRatio = computeRatio(finalTotal, finalGreenhouse, finalAnti)
        finalSurfaceTemperature = finalRatio * baseTemperatureReference
        projectedHydroId = determineHydrosphere(finalSurfaceTemperature, finalTotal)

        // Calculate target HydroExt and resulting water vapour adjustments
        targetHydroExt = this.calculateTargetHydroExt(body.HydroExt, projectedHydroId)

        // Calculate equilibrium water vapour for the target HydroExt
        const equilibriumWaterForTarget = targetWaterForState(projectedHydroId, targetHydroExt, finalTotal)

        // To reach target HydroExt, we need to account for condensation
        // HydroExt change = (water vapour condensed) × 40
        // Water condensed = (initial water - equilibrium water)
        // So: HydroExt increase needed = (finalWater - equilibrium) × 40
        // Therefore: finalWater = equilibrium + (HydroExt increase / 40)

        const hydroExtIncrease = targetHydroExt - body.HydroExt
        let targetWater = equilibriumWaterForTarget

        if (hydroExtIncrease > 0) {
          // Need to increase HydroExt through condensation
          // Add extra water that will condense to reach target
          targetWater = equilibriumWaterForTarget + hydroExtIncrease / 40
        }

        // Set water vapour to reach the target HydroExt
        if (targetWater >= 0 && targetWater <= species.MaximumPressure) {
          const newTotal = targetBreathablePressure + targetWater + finalGreenhouse + finalAnti + totalNeutral
          if (newTotal <= species.MaximumPressure + tolerance) {
            finalWater = targetWater
          }
        }

        // The final HydroExt will be the target after condensation
        const finalHydroExtent = targetHydroExt
        const finalTemperatureLow = finalSurfaceTemperature * (lowSwingRatio || 1)
        const finalTemperatureHigh = finalSurfaceTemperature * (highSwingRatio || 1)

        // Check if temperatures are out of range
        const tempOutOfRange = finalTemperatureLow < speciesMinTemperature - 0.5 || finalTemperatureHigh > speciesMaxTemperature + 0.5

        // If the body cannot reach perfect habitability but we have a valid plan, offer it as a partial solution
        if (tempOutOfRange && !isPartialSolution) {
          // Mark as partial solution - body can be improved but won't reach perfect habitability
          isPartialSolution = true
        }

        // For non-partial solutions, reject if temperatures still out of range
        // For partial solutions, allow it and let the user decide if the improvement is worth it
        if (!isPartialSolution && tempOutOfRange) {
          return null
        }

        const waterVapourDelta = finalWater - atmosphereSummary.waterVapourPressure
        const breathableDelta = targetBreathablePressure - atmosphereSummary.breathablePressure
        const greenhouseDelta = finalGreenhouse - atmosphereSummary.greenhousePressure
        const antiGreenhouseDelta = finalAnti - atmosphereSummary.antiGreenhousePressure
        const neutralDelta = totalNeutral - atmosphereSummary.neutralPressure

        const waterVapourTime = computeTerraformingTime(waterVapourDelta, localTerraformingPower, 0.1)
        const breathableTime = computeTerraformingTime(breathableDelta, localTerraformingPower)
        const toxicTime = computeTerraformingTime(atmosphereSummary.toxicPressure, localTerraformingPower)
        const greenhouseTime = computeTerraformingTime(greenhouseDelta, localTerraformingPower)
        const antiGreenhouseTime = computeTerraformingTime(antiGreenhouseDelta, localTerraformingPower)
        const neutralTime = computeTerraformingTime(neutralDelta, localTerraformingPower)

        // Determine water vapour process and estimate time for HydroExt changes
        // Note: Condensation/evaporation happens naturally in the game at different rates
        // Condensation: 0.1 atm/year, Evaporation: 4.0 atm/year
        const hydroExtChange = finalHydroExtent - body.HydroExt
        let waterVapourProcess = 'Stable'
        let hydroExtTime = 0

        // Game constants for condensation/evaporation
        const condensationRatePerYear = 0.1 // atm/year
        const evaporationRatePerYear = 4.0 // atm/year

        if (Math.abs(hydroExtChange) > 0.1) {
          if (hydroExtChange > 0) {
            // Need to INCREASE HydroExt through condensation
            // We're setting water above equilibrium, which will condense
            const equilibriumWater = targetWaterForState(projectedHydroId, targetHydroExt, finalTotal)
            const waterToCondense = finalWater - equilibriumWater

            if (waterToCondense > tolerance) {
              waterVapourProcess = 'Condense'
              // Time = water to condense / condensation rate
              hydroExtTime = waterToCondense / condensationRatePerYear
            }
          } else {
            // Need to DECREASE HydroExt through evaporation
            // HydroExt decreases as water evaporates from hydrosphere into atmosphere
            // Total water that needs to evaporate = HydroExt change / 40
            const waterToEvaporate = Math.abs(hydroExtChange) / 40

            if (waterToEvaporate > tolerance) {
              waterVapourProcess = 'Evaporate'
              // Time = water to evaporate from hydrosphere / evaporation rate
              hydroExtTime = waterToEvaporate / evaporationRatePerYear
            }
          }
        }

        return {
          plan: {
            WaterVapourStart: atmosphereSummary.waterVapourPressure,
            WaterVapour: Math.max(finalWater, 0),
            WaterVapourTime: waterVapourTime,
            WaterVapourChange: waterVapourDelta,
            WaterVapourProcess: waterVapourProcess,
            WaterVapourGas: atmosphereSummary.waterVapourGas,
            HydroExtTime: hydroExtTime,

            BreathableStart: atmosphereSummary.breathablePressure,
            Breathable: targetBreathablePressure,
            BreathableTime: breathableTime,
            BreathableName: species.BreatheName,
            BreathableGas: atmosphereSummary.breathableGas,

            ToxicStart: atmosphereSummary.toxicPressure,
            Toxic: 0,
            ToxicTime: toxicTime,
            Toxics: toxicsPlan,

            GreenhouseStart: atmosphereSummary.greenhousePressure,
            Greenhouse: finalGreenhouse,
            GreenhouseGasId: greenhouseGasId,
            GreenhouseName: greenhouseName,
            GreenhouseSideContributions: greenhouseSideContributions,
            GreenhouseSideGases: greenhouseSideGases,
            GreenhouseTime: greenhouseTime,

            AntiGreenhouseStart: atmosphereSummary.antiGreenhousePressure,
            AntiGreenhouse: finalAnti,
            AntiGreenhouseGasId: antiGreenhouseGasId,
            AntiGreenhouseName: antiGreenhouseName,
            AntiGreenhouseSideContributions: antiGreenhouseSideContributions,
            AntiGreenhouseSideGases: antiGreenhouseSideGases,
            AntiGreenhouseTime: antiGreenhouseTime,

            NeutralStart: atmosphereSummary.neutralPressure,
            Neutral: totalNeutral,
            NeutralGasId: neutralGasId,
            NeutralName: neutralName,
            NeutralSideContributions: neutralSideContributions,
            NeutralSideGases: neutralSideGases,
            NeutralTime: neutralTime,

            TargetTotalPressure: finalTotal,
            TargetMeanTemperature: finalSurfaceTemperature,
            TargetTemperatureLow: finalTemperatureLow,
            TargetTemperatureHigh: finalTemperatureHigh,

            TargetHydroID: projectedHydroId,
            TargetHydroExt: finalHydroExtent,
            HydroExtChange: hydroExtChange,
            TargetAlbedo: albedo,
            AlbedoChange: albedo - body.OriginalAlbedo,
            IsPartialSolution: isPartialSolution,
          },
        }
      }

      let effectiveAlbedo = body.Albedo
      let solution = solveForAlbedo(effectiveAlbedo)

      if (!solution) {
        return null
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const adjustedAlbedo = adjustAlbedoForHydrosphere(body.Albedo, body.HydroID, solution.plan.TargetHydroID, body.HydroExt)
        if (Math.abs(adjustedAlbedo - effectiveAlbedo) < 1e-3) {
          break
        }

        effectiveAlbedo = adjustedAlbedo
        const recalculated = solveForAlbedo(effectiveAlbedo)
        if (!recalculated) {
          break
        }
        solution = recalculated
      }

      if (solution?.plan) {
        solution.plan.TargetAlbedo = effectiveAlbedo
        solution.plan.AlbedoChange = effectiveAlbedo - body.OriginalAlbedo
      }

      return solution.plan
    },

    _bodyMap(body) {
      const species = this.selectedSpecies || {}

      const isMoon = BodyClass[body.BodyClass] === 'Moon'
      const orbitalDistance = isMoon ? body.ParentOrbitalDistance : body.OrbitalDistance
      const orbitalEccentricity = isMoon ? body.ParentEccentricity : body.Eccentricity
      let lowSwingRatio = 1
      let highSwingRatio = 1

      if (Number.isFinite(orbitalDistance) && orbitalDistance > 0 && Number.isFinite(orbitalEccentricity) && orbitalEccentricity > 0) {
        const apoDistance = orbitalDistance * (1 + orbitalEccentricity)
        if (apoDistance > 0) {
          lowSwingRatio = Math.sqrt(orbitalDistance / apoDistance)
        }

        const periDistance = orbitalDistance * (1 - orbitalEccentricity)
        if (periDistance > 0) {
          highSwingRatio = Math.sqrt(orbitalDistance / periDistance)
        } else if (orbitalEccentricity < 1) {
          // Extremely small perihelion; approximate using a minimal distance.
          highSwingRatio = Math.sqrt(orbitalDistance / (orbitalDistance * 0.0001))
        }
      }

      if (!Number.isFinite(lowSwingRatio) || lowSwingRatio <= 0) {
        lowSwingRatio = 1
      } else if (lowSwingRatio > 1) {
        lowSwingRatio = 1
      }

      if (!Number.isFinite(highSwingRatio) || highSwingRatio < 1) {
        highSwingRatio = 1
      }

      const localSurfaceArea = 4 * Math.PI * Math.pow(body.Radius, 2)

      // MAXIMUM POPULATION
      const tidalModifier = body.TidalLock && BodyClass[body.BodyClass] !== 'Moon' ? 5 : 1
      const hydroModifier = body.HydroExt > 75 ? Math.max((100 - body.HydroExt) / 25, 0.01) : 1

      const maxPopPreModifiers = (localSurfaceArea / earthSurfaceArea) * baseMaxPop * this.selectedSpecies.PopulationDensityModifier

      const newBody = {
        ...body,

        LowGravity: body.Gravity < this.selectedSpecies.IdealGravity - this.selectedSpecies.GravityDeviation,

        MaximumPopulation: Math.max((maxPopPreModifiers * hydroModifier) / tidalModifier, 0.05),
        MaximumPopulationAtOptimalHydro: Math.max(maxPopPreModifiers / tidalModifier, 0.05),
        CurrentTemperatureLow: body.SurfaceTemp * lowSwingRatio,
        CurrentTemperatureHigh: body.SurfaceTemp * highSwingRatio,
      }

      const currentColonyCosts = this.colonyCosts(body)
      newBody.CurrentColonyCostOverall = currentColonyCosts.overall
      newBody.CurrentColonyCostPeriapsis = currentColonyCosts.periapsis
      newBody.CurrentColonyCostApoapsis = currentColonyCosts.apoapsis

      const atmosphereSummary = body.Atmosphere.reduce(
        (aggregate, gas) => {
          const gasPressure = gas.GasAtm || 0

          aggregate.totalPressure += gasPressure

          if (gas.AtmosGasID === this.selectedSpecies.BreatheID) {
            aggregate.breathablePressure += gasPressure
          } else if (gas.Dangerous) {
            aggregate.toxicPressure += gasPressure
          }

          return aggregate
        },
        {
          totalPressure: 0,
          breathablePressure: 0,
          toxicPressure: 0,
        }
      )

      const tolerance = 1e-4
      const speciesGravityMin = this.selectedSpecies.IdealGravity - this.selectedSpecies.GravityDeviation
      const speciesGravityMax = this.selectedSpecies.IdealGravity + this.selectedSpecies.GravityDeviation
      const gravityLow = body.Gravity < speciesGravityMin
      const gravityNegligible = body.Gravity < 0.1
      const gravityHigh = body.Gravity > speciesGravityMax
      const gravityOk = !gravityLow && !gravityHigh

      const speciesTempMin = this.selectedSpecies.IdealTemperature - this.selectedSpecies.TemperatureDeviation
      const speciesTempMax = this.selectedSpecies.IdealTemperature + this.selectedSpecies.TemperatureDeviation
      const temperatureOk = newBody.CurrentTemperatureLow >= speciesTempMin && newBody.CurrentTemperatureHigh <= speciesTempMax

      const breathableMin = Math.max(0, this.selectedSpecies.IdealBreathePressure - this.selectedSpecies.BreathePressureDeviation)
      const breathableMax = this.selectedSpecies.IdealBreathePressure + this.selectedSpecies.BreathePressureDeviation
      const breathableOk = atmosphereSummary.breathablePressure >= breathableMin - tolerance && atmosphereSummary.breathablePressure <= breathableMax + tolerance

      const pressureOk = atmosphereSummary.totalPressure <= this.selectedSpecies.MaximumPressure + tolerance
      const toxicOk = atmosphereSummary.toxicPressure <= tolerance

      const currentLiveable = gravityOk && temperatureOk && breathableOk && pressureOk && toxicOk

      newBody.Liveable = currentLiveable
      newBody.StartingAtmosphere = atmosphereSummary.totalPressure
      newBody.TerraformationPlan = null
      newBody.TerraformationTime = -Infinity
      newBody.TerraformedAtmosphere = atmosphereSummary.totalPressure
      newBody.TerraformedSurfaceTemperature = body.SurfaceTemp
      newBody.TerraformedTemperatureLow = newBody.CurrentTemperatureLow
      newBody.TerraformedTemperatureHigh = newBody.CurrentTemperatureHigh
      newBody.TargetHydroExt = body.HydroExt
      newBody.TargetHydroID = body.HydroID
      newBody.HydroExtChange = 0

      let terraformable = false
      let terraformableStatus = 'No'

      if (currentLiveable) {
        terraformable = true
        terraformableStatus = 'Done'
        newBody.TerraformationTime = 0
      } else if (!gravityHigh && !gravityNegligible) {
        const newTerraformationPlan = this.makeTerraformationPlan(body)

        if (newTerraformationPlan) {
          newBody.TerraformationPlan = newTerraformationPlan
          newBody.TerraformationTime = newTerraformationPlan.WaterVapourTime + newTerraformationPlan.BreathableTime + newTerraformationPlan.ToxicTime + newTerraformationPlan.GreenhouseTime + newTerraformationPlan.AntiGreenhouseTime + newTerraformationPlan.NeutralTime
          newBody.TerraformedAtmosphere = newTerraformationPlan.TargetTotalPressure
          newBody.TerraformedSurfaceTemperature = newTerraformationPlan.TargetMeanTemperature
          newBody.TerraformedTemperatureLow = newTerraformationPlan.TargetTemperatureLow
          newBody.TerraformedTemperatureHigh = newTerraformationPlan.TargetTemperatureHigh

          const plannedHydroExt = Number.isFinite(newTerraformationPlan.TargetHydroExt) ? newTerraformationPlan.TargetHydroExt : body.HydroExt
          newBody.TargetHydroExt = plannedHydroExt
          newBody.TargetHydroID = newTerraformationPlan.TargetHydroID
          newBody.HydroExtChange = plannedHydroExt - body.HydroExt

          const plannedAtmosphere = []
          const pushGas = (gasId, amount, existingGas = null) => {
            if (!Number.isFinite(amount) || amount <= 0 || !gasId) {
              return
            }

            // Try to get gas info from the database
            const gasInfo = this.getGasInfo(gasId)

            // If we have existing gas information from the atmosphere, use it as a base
            // Otherwise use the database info or defaults
            const gasData = existingGas || gasInfo

            plannedAtmosphere.push({
              AtmosGasID: gasId,
              AtmosGasName: gasData?.AtmosGasName || gasData?.Name || 'Unknown',
              GasAtm: amount,
              AtmosGasAmount: amount,
              BoilingPoint: gasData?.BoilingPoint || 0,
              GHGas: gasData?.GHGas || 0,
              AntiGHGas: gasData?.AntiGHGas || 0,
              Dangerous: gasData?.Dangerous || 0,
              DangerousLevel: gasData?.DangerousLevel || 0,
              FrozenOut: false,
            })
          }

          // Add breathable gas
          pushGas(species.BreatheID, newTerraformationPlan.Breathable, newTerraformationPlan.BreathableGas)

          // Add water vapour
          pushGas(5, newTerraformationPlan.WaterVapour, newTerraformationPlan.WaterVapourGas)

          // Add main greenhouse gas
          const mainGreenhouseAmount = newTerraformationPlan.Greenhouse - newTerraformationPlan.GreenhouseSideContributions
          pushGas(newTerraformationPlan.GreenhouseGasId, mainGreenhouseAmount)

          // Add side greenhouse gases (preserve existing)
          if (newTerraformationPlan.GreenhouseSideGases && newTerraformationPlan.GreenhouseSideGases.length) {
            for (const gas of newTerraformationPlan.GreenhouseSideGases) {
              pushGas(gas.AtmosGasID, gas.GasAtm, gas)
            }
          }

          // Add main anti-greenhouse gas
          const mainAntiGreenhouseAmount = newTerraformationPlan.AntiGreenhouse - newTerraformationPlan.AntiGreenhouseSideContributions
          pushGas(newTerraformationPlan.AntiGreenhouseGasId, mainAntiGreenhouseAmount)

          // Add side anti-greenhouse gases (preserve existing)
          if (newTerraformationPlan.AntiGreenhouseSideGases && newTerraformationPlan.AntiGreenhouseSideGases.length) {
            for (const gas of newTerraformationPlan.AntiGreenhouseSideGases) {
              pushGas(gas.AtmosGasID, gas.GasAtm, gas)
            }
          }

          // Add main neutral gas
          const mainNeutralAmount = newTerraformationPlan.Neutral - newTerraformationPlan.NeutralSideContributions
          pushGas(newTerraformationPlan.NeutralGasId, mainNeutralAmount)

          // Add side neutral gases (preserve existing)
          if (newTerraformationPlan.NeutralSideGases && newTerraformationPlan.NeutralSideGases.length) {
            for (const gas of newTerraformationPlan.NeutralSideGases) {
              pushGas(gas.AtmosGasID, gas.GasAtm, gas)
            }
          }

          // Update Surface Temperature
          let ghAtm = 0
          let aghAtm = 0
          for (const gas of plannedAtmosphere) {
            if (!gas.FrozenOut) {
              if (gas.GHGas) {
                ghAtm += gas.GasAtm
              } else if (gas.AntiGHGas) {
                aghAtm += gas.GasAtm
              }
            }
          }

          let ghM = 1 + newTerraformationPlan.TargetTotalPressure / 10 + ghAtm
          if (ghM > 3) {
            ghM = 3
          }

          let aghM = 1 + body.DustLevel / 20000 + aghAtm
          if (aghM > 3) {
            aghM = 3
          }

          newTerraformationPlan.TargetSurfaceTemp = (body.BaseTemp * ghM * newTerraformationPlan.TargetAlbedo) / aghM
          if (newTerraformationPlan.TargetSurfaceTemp < 1) {
            newTerraformationPlan.TargetSurfaceTemp = 1
          }

          //
          const plannedColonyCosts = this.colonyCosts({
            ...newBody,
            SurfaceTemp: newTerraformationPlan.TargetSurfaceTemp,
            Albedo: newTerraformationPlan.TargetAlbedo,
            AtmosPress: newTerraformationPlan.TargetTotalPressure,
            HydroExt: plannedHydroExt,
            HydroID: newTerraformationPlan.TargetHydroID,
            Atmosphere: plannedAtmosphere,
          })

          const overallCost = plannedColonyCosts.overall
          const periapsisCost = plannedColonyCosts.periapsis
          const apoapsisCost = plannedColonyCosts.apoapsis

          // Optimization: If planned colony cost equals current cost, only remove toxics
          // No point in adjusting atmosphere if it doesn't improve habitability
          const currentOverall = newBody.CurrentColonyCostOverall
          const currentPeriapsis = newBody.CurrentColonyCostPeriapsis
          const currentApoapsis = newBody.CurrentColonyCostApoapsis

          const costsAreEqual = Math.abs(overallCost - currentOverall) < 0.01 && Math.abs(periapsisCost - currentPeriapsis) < 0.01 && Math.abs(apoapsisCost - currentApoapsis) < 0.01

          if (costsAreEqual) {
            if (newTerraformationPlan.ToxicTime > 0) {
              // Only keep toxic removal, skip all other atmospheric adjustments
              newTerraformationPlan.WaterVapour = newTerraformationPlan.WaterVapourStart
              newTerraformationPlan.WaterVapourTime = 0
              newTerraformationPlan.WaterVapourChange = 0
              newTerraformationPlan.Breathable = newTerraformationPlan.BreathableStart
              newTerraformationPlan.BreathableTime = 0
              newTerraformationPlan.Greenhouse = newTerraformationPlan.GreenhouseStart
              newTerraformationPlan.GreenhouseTime = 0
              newTerraformationPlan.AntiGreenhouse = newTerraformationPlan.AntiGreenhouseStart
              newTerraformationPlan.AntiGreenhouseTime = 0
              newTerraformationPlan.Neutral = newTerraformationPlan.NeutralStart
              newTerraformationPlan.NeutralTime = 0

              // Recalculate total time (only toxics now)
              newBody.TerraformationTime = newTerraformationPlan.ToxicTime
            } else {
              // No toxics and colony cost won't improve - nothing to terraform
              // Clear the plan so it shows as already optimal
              newBody.TerraformationPlan = null
              newBody.TerraformationTime = 0
            }
          }

          if (Number.isFinite(overallCost) && Number.isFinite(periapsisCost) && Number.isFinite(apoapsisCost) && overallCost >= 0 && periapsisCost >= 0 && apoapsisCost >= 0) {
            terraformable = true

            if (overallCost === 0 && periapsisCost === 0 && apoapsisCost === 0 && !gravityLow) {
              terraformableStatus = 'Yes'
            } else if (overallCost === 0 || periapsisCost === 0 || apoapsisCost === 0) {
              terraformableStatus = 'Partial'
            } else if (overallCost < 2 && periapsisCost < 2 && apoapsisCost < 2) {
              terraformableStatus = 'Near'
            } else if (overallCost < 4 && periapsisCost < 4 && apoapsisCost < 4) {
              terraformableStatus = 'Limited'
            } else {
              terraformableStatus = 'Insufficient'
            }
          } else {
            terraformable = false
            terraformableStatus = 'No'
          }

          newBody.PlannedColonyCostOverall = overallCost
          newBody.PlannedColonyCostPeriapsis = periapsisCost
          newBody.PlannedColonyCostApoapsis = apoapsisCost
        }
      }

      if (gravityHigh) {
        terraformable = false
        terraformableStatus = 'No (HG)'
      }

      if (gravityNegligible) {
        terraformable = false
        terraformableStatus = 'No (LG)'
      }

      if (gravityLow && !gravityNegligible) {
        if (terraformableStatus === 'Yes') {
          terraformableStatus = 'Partial'
        }

        terraformableStatus = `${terraformableStatus} (LG)`
      }

      newBody.Terraformable = terraformable && !terraformableStatus.startsWith('No')
      newBody.TerraformableStatus = terraformableStatus

      newBody.PlannedColonyCostMetric = terraformable && newBody.TerraformationTime > 0 ? Math.max(newBody.PlannedColonyCostOverall, newBody.PlannedColonyCostPeriapsis, newBody.PlannedColonyCostApoapsis) : Infinity

      // MINERALS
      const [miningPotential, totalMiningAmount] = body.Minerals.reduce(
        ([potential, amount], mineral) => {
          potential += Math.atan(Math.pow(mineral.Amount / 20000, Math.cos((Math.PI / 2) * mineral.Accessibility - Math.PI / 2)) * (0.5 - Math.cos(Math.PI * mineral.Accessibility) / 2))
          amount += mineral.Amount

          return [potential, amount]
        },
        [0, 0]
      )

      newBody.MiningPotential = body.Minerals.length && (miningPotential * 10) / ((Math.PI / 2) * body.Minerals.length)
      newBody.TotalMiningAmount = totalMiningAmount

      // EXTANT POPULATIONS
      const { totalPopulation, ownPopulation, otherPopulation } = body.Populations.reduce(
        (aggregate, population) => {
          aggregate.totalPopulation += population.Population

          const ownExtant = this.species.find((species) => species.SpeciesID === population.SpeciesID)

          if (ownExtant) {
            aggregate.ownPopulation = true
          } else {
            aggregate.otherPopulation = true
          }

          return aggregate
        },
        {
          totalPopulation: 0,
          ownPopulation: false,
          otherPopulation: false,
        }
      )

      newBody.TotalPopulation = totalPopulation
      newBody.OwnPopulation = ownPopulation
      newBody.OtherPopulation = otherPopulation

      if (newBody.TerraformationPlan && newBody.SystemBodyID === 1997767) {
        console.log(newBody)
      }

      return newBody
    },
  },
  asyncComputed: {
    race: {
      async get() {
        if (!this.database || !this.RaceID) {
          return {}
        }

        const race = await this.database.models.Race.findOne({
          where: {
            RaceID: this.RaceID,
          },
        }).then((race) => {
          console.log('Loaded race:', race.toJSON())
          return race
        })

        return race
      },
      default: {},
    },
    bodies: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const bodies = await this.database.query(`select FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.ParentBodyID, FCT_SystemBody.ParentBodyType, FCT_SystemBody.StarID, FCT_SystemBody.RuinID, FCT_SystemBody.RuinRaceID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID, FCT_SystemBody.TrojanAsteroid, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Radius, FCT_SystemBody.Gravity, FCT_SystemBody.BaseTemp, FCT_SystemBody.SurfaceTemp, FCT_SystemBody.HydroID, FCT_SystemBody.HydroExt, FCT_SystemBody.Albedo, FCT_SystemBody.AtmosPress, FCT_SystemBody.TidalLock, FCT_SystemBody.RadiationLevel, FCT_SystemBody.DustLevel, FCT_Star.Component, FCT_Star.Luminosity as StarLuminosity, FCT_Star.Xcor as StarXcor, FCT_Star.Ycor as StarYcor, FCT_RaceSysSurvey.Name as SystemName, FCT_Population.PopulationID, FCT_Population.Population, FCT_Population.SpeciesID, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, CAST(CASE WHEN FCT_SystemBodySurveys.SystemBodyID IS NULL THEN 0 ELSE 1 END AS BIT) AS BodySurveyed, FCT_AtmosphericGas.AtmosGasID, FCT_AtmosphericGas.AtmosGasAmount, FCT_AtmosphericGas.GasAtm, FCT_AtmosphericGas.FrozenOut, DIM_Gases.BoilingPoint, DIM_Gases.GHGas, DIM_Gases.AntiGHGas, DIM_Gases.Dangerous, DIM_Gases.DangerousLevel, DIM_Gases.Name as AtmosGasName, FCT_SystemBody.DistanceToParent, FCT_SystemBody.OrbitalDistance, FCT_SystemBody.Eccentricity, FCT_SystemBody.EccentricityDirection, FCT_SystemBody.FixedBody, ParentBody.OrbitalDistance as ParentOrbitalDistance, ParentBody.Eccentricity as ParentEccentricity from FCT_SystemBody left join FCT_Population on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_RaceSysSurvey on FCT_SystemBody.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = FCT_SystemBody.GameID left join FCT_SystemBodySurveys on FCT_SystemBody.SystemBodyID = FCT_SystemBodySurveys.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_MineralDeposit on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID and FCT_SystemBodySurveys.SystemBodyID = FCT_MineralDeposit.SystemBodyID left join FCT_AtmosphericGas on FCT_SystemBody.SystemBodyID = FCT_AtmosphericGas.SystemBodyID left join DIM_Gases on FCT_AtmosphericGas.AtmosGasID = DIM_Gases.GasID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_RaceSysSurvey.RaceID = FCT_SystemBodyName.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID left join FCT_SystemBody as ParentBody on FCT_SystemBody.ParentBodyID = ParentBody.SystemBodyID and FCT_SystemBody.ParentBodyType = 1 where FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBody.BodyTypeID not in (0, 4, 5) and FCT_SystemBody.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID} order by FCT_SystemBody.SystemBodyID asc`).then(([items]) => {
          const bodyPops = {}
          const bodyMats = {}
          const bodyAtmos = {}

          return Object.values(
            items.reduce((aggregate, item) => {
              if (!aggregate[item.SystemBodyID]) {
                aggregate[item.SystemBodyID] = {
                  SystemBodyID: item.SystemBodyID,
                  ParentBodyID: item.ParentBodyID,
                  ParentBodyType: item.ParentBodyType,
                  SystemBodyName: item.SystemBodyName,
                  SystemName: item.SystemName,
                  SystemID: item.SystemID,
                  StarID: item.StarID,
                  RuinID: item.RuinID,
                  RuinRaceID: item.RuinRaceID,
                  BodyClass: item.BodyClass,
                  BodyTypeID: item.BodyTypeID,
                  TrojanAsteroid: item.TrojanAsteroid,
                  Component: item.Component,
                  PlanetNumber: item.PlanetNumber,
                  OrbitNumber: item.OrbitNumber,
                  SystemBodyOrder: `${item.Component}-${item.PlanetNumber}-${item.OrbitNumber}`,
                  GroundMineralSurvey: item.GroundMineralSurvey,
                  BodySurveyed: item.BodySurveyed,

                  OrbitalDistance: item.OrbitalDistance,
                  ParentOrbitalDistance: item.ParentOrbitalDistance,
                  Eccentricity: item.Eccentricity,
                  ParentEccentricity: item.ParentEccentricity,
                  EccentricityDirection: item.EccentricityDirection,
                  FixedBody: item.FixedBody,

                  OriginalSurfaceTemp: item.SurfaceTemp,
                  OriginalAlbedo: item.Albedo,

                  Radius: item.Radius,
                  Gravity: item.Gravity,
                  BaseTemp: item.BaseTemp,
                  SurfaceTemp: item.SurfaceTemp,
                  HydroID: item.HydroID,
                  HydroExt: item.HydroExt,
                  Albedo: item.Albedo,
                  AtmosPress: item.AtmosPress,
                  RadiationLevel: item.RadiationLevel,
                  DustLevel: item.DustLevel,
                  TidalLock: item.TidalLock,

                  StarLuminosity: item.StarLuminosity,
                  StarXcor: item.StarXcor,
                  StarYcor: item.StarYcor,

                  Populations: [],
                  Minerals: [],
                  Atmosphere: [],
                }

                if (BodyClass[item.BodyClass] === 'Planet' || BodyClass[item.BodyClass] === 'Comet' || (BodyClass[item.BodyClass] === 'Asteroid' && item.TrojanAsteroid === 0)) {
                  aggregate[item.SystemBodyID].BaseTemp = Math.max(255 / Math.sqrt(item.DistanceToParent / Math.sqrt(item.StarLuminosity)), 4)
                }
              }

              if (!bodyPops[item.SystemBodyID]) {
                bodyPops[item.SystemBodyID] = []
              }

              if (!bodyMats[item.SystemBodyID]) {
                bodyMats[item.SystemBodyID] = []
              }

              if (!bodyAtmos[item.SystemBodyID]) {
                bodyAtmos[item.SystemBodyID] = []
              }

              if (item.PopulationID && !bodyPops[item.SystemBodyID].includes(item.PopulationID)) {
                bodyPops[item.SystemBodyID].push(item.PopulationID)

                aggregate[item.SystemBodyID].Populations.push({
                  PopulationID: item.PopulationID,
                  Population: item.Population,
                  SpeciesID: item.SpeciesID,
                })
              }

              if (item.MaterialID && !bodyMats[item.SystemBodyID].includes(item.MaterialID)) {
                bodyMats[item.SystemBodyID].push(item.MaterialID)

                aggregate[item.SystemBodyID].Minerals.push({
                  MaterialID: item.MaterialID,
                  MaterialName: this.MaterialMap[item.MaterialID],
                  Amount: item.Amount,
                  Accessibility: item.Accessibility,
                  HalfOriginalAmount: item.HalfOriginalAmount,
                  OriginalAcc: item.OriginalAcc,
                })
              }

              if (item.AtmosGasID && !bodyAtmos[item.SystemBodyID].includes(item.AtmosGasID)) {
                bodyAtmos[item.SystemBodyID].push(item.AtmosGasID)

                aggregate[item.SystemBodyID].Atmosphere.push({
                  AtmosGasID: item.AtmosGasID,
                  AtmosGasName: item.AtmosGasName,
                  AtmosGasAmount: item.AtmosGasAmount,
                  GasAtm: item.GasAtm,
                  FrozenOut: item.FrozenOut,
                  BoilingPoint: item.BoilingPoint,
                  GHGas: item.GHGas,
                  AntiGHGas: item.AntiGHGas,
                  Dangerous: item.Dangerous,
                  DangerousLevel: item.DangerousLevel,
                })
              }

              return aggregate
            }, {})
          )
        })

        console.log('### BODIES', bodies)

        return bodies
      },
      default: [],
    },
    species: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const species = await this.database.query(`select FCT_Population.SpeciesID, FCT_Species.SpeciesName, sum(FCT_Population.Population) as TotalPopulation, FCT_Race.TerraformingRate, FCT_Species.BreatheID, DIM_Gases.Name as BreatheName, FCT_Species.Oxygen as IdealBreathePressure, FCT_Species.OxyDev as BreathePressureDeviation, FCT_Species.PressMax as MaximumPressure, FCT_Species.Temperature as IdealTemperature, FCT_Species.TempDev as TemperatureDeviation, FCT_Species.Gravity as IdealGravity, FCT_Species.GravDev as GravityDeviation, FCT_Species.PopulationDensityModifier from FCT_Population left join FCT_Race on FCT_Population.RaceID = FCT_Race.RaceID left join FCT_Species on FCT_Population.SpeciesID = FCT_Species.SpeciesID left join DIM_Gases on FCT_Species.BreatheID = DIM_Gases.GasID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SpeciesID`).then(([items]) => {
          const species = items.map((item) => {
            return {
              ...item,

              MinimumTemperature: item.IdealTemperature - item.TemperatureDeviation,
              MaximumTemperature: item.IdealTemperature + item.TemperatureDeviation,
              MinimumBreathablePressure: Math.max(0, item.IdealBreathePressure - item.BreathePressureDeviation),
              MaximumBreathablePressure: item.IdealBreathePressure + item.BreathePressureDeviation,
              MinimumGravity: Math.max(0, item.IdealGravity - item.GravityDeviation),
              MaximumGravity: item.IdealGravity + item.GravityDeviation,
            }
          })

          return species
        })

        if (species.length) {
          this.selectedSpeciesId = species[0].SpeciesID
        }

        return species
      },
      default: [],
    },
    surveyedSystems: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const systems = await this.database.models.System.findAll({
          where: {
            GameID: this.GameID,
          },

          include: [
            {
              required: true,
              model: this.database.models.RaceSystemSurvey,
              where: {
                RaceID: this.RaceID,
              },
            },
            {
              required: false,
              model: this.database.models.Population,
              where: {
                RaceID: this.RaceID,
              },
            },
          ],
        }).then((items) => {
          return items.map((item) => {
            const [inhabitedColonies] = _partition(item.Populations, (population) => population.Population)

            return {
              ...item.toJSON(),

              InhabitedColonies: inhabitedColonies.length,
            }
          })
        })

        return systems
      },
      default: [],
    },
    gases: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const gases = await this.database.query('SELECT GasID, Name, Symbol, Weight, BoilingPoint, GHGas, AntiGHGas, Dangerous, DangerousLevel FROM DIM_Gases').then(([items]) => {
          return items
        })

        return gases
      },
      default: [],
    },
  },
}
</script>

<style lang="scss" scoped>
.target-value {
  display: inline-flex;
  align-items: center;
  .target-copy-btn {
    margin-left: 4px;
    height: 20px;
    width: 20px;
    min-width: 20px;
  }
}
</style>
