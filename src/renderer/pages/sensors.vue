<template>
  <div>
    <v-container fluid class="sensors-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--mode">
            <div class="tool__label caption text--secondary">Mode</div>
            <v-btn-toggle :value="mode" mandatory dense aria-label="Sensor mode" data-sensors="mode" @change="setMode">
              <v-btn v-for="entry in modes" :key="entry.value" :value="entry.value" small :data-sensors-mode="entry.value">{{ entry.text }}</v-btn>
            </v-btn-toggle>
          </div>
          <template v-if="mode === 'active'">
            <div class="tool tool--kind">
              <div class="tool__label caption text--secondary">Target</div>
              <v-btn-toggle v-model="targetKind" mandatory dense aria-label="What the sensor is sized against" data-sensors="target-kind">
                <v-btn v-for="entry in targetKinds" :key="entry.value" :value="entry.value" small :data-sensors-target="entry.value">{{ entry.text }}</v-btn>
              </v-btn-toggle>
            </div>
            <div v-if="targetKind === 'tons'" class="tool tool--figure">
              <div class="tool__label caption text--secondary">Target size</div>
              <v-text-field v-model="targetTons" type="text" suffix="t" placeholder="Unknown" aria-label="Target size in tons, blank when unknown" dense outlined hide-details data-sensors="target-tons" />
            </div>
            <div v-else-if="targetKind === 'class'" class="tool tool--class">
              <div class="tool__label caption text--secondary">Target class</div>
              <v-autocomplete :value="targetClass ? targetClass.id : null" :items="classItems" item-text="text" item-value="value" placeholder="None" prepend-inner-icon="mdi-ferry" aria-label="Class the sensor is sized against" dense outlined hide-details data-sensors="target-class" @change="targetClassId = Number.isInteger($event) ? $event : null" />
            </div>
            <div v-else class="tool tool--figure">
              <div class="tool__label caption text--secondary">Missile size</div>
              <v-text-field v-model="targetMsp" type="text" suffix="MSP" placeholder="Unknown" aria-label="Missile size in MSP, blank when unknown" dense outlined hide-details data-sensors="target-msp" />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Wanted range</div>
              <v-text-field v-model="wantedRange" type="text" suffix="km" placeholder="Unknown" aria-label="Range the sensor must reach in km, blank when unknown" dense outlined hide-details data-sensors="wanted-range" />
            </div>
            <div class="tool tool--resolution">
              <div class="tool__label caption text--secondary">Resolution</div>
              <v-select v-model="resolutionPick" :items="resolutionItems" item-text="text" item-value="value" aria-label="Resolution of the sensor, or the best" dense outlined hide-details data-sensors="resolution" />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Jammer</div>
              <v-text-field v-model="jammer" type="text" placeholder="None" aria-label="Jammer level of the target, blank for none" dense outlined hide-details data-sensors="jammer" />
            </div>
          </template>
          <template v-else-if="mode === 'beam'">
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Wanted range</div>
              <v-text-field v-model="beamRange" type="text" suffix="km" placeholder="Unknown" aria-label="Range the fire control must reach in km, blank when unknown" dense outlined hide-details data-sensors="beam-range" />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Wanted tracking speed</div>
              <v-text-field v-model="beamTracking" type="text" suffix="km/s" placeholder="Unknown" aria-label="Tracking speed the fire control must reach in km/s, blank when unknown" dense outlined hide-details data-sensors="beam-tracking" />
            </div>
            <div v-if="techInput.singleWeapon.offersSingle" class="tool tool--switch">
              <v-switch v-model="beamSingle" label="Single weapon" dense hide-details class="mt-0 pt-2" data-sensors="beam-single" />
            </div>
          </template>
          <template v-else>
            <div class="tool tool--shares">
              <div class="tool__label caption text--secondary">Speed shares</div>
              <v-text-field v-model="shares" type="text" suffix="%" placeholder="50" aria-label="Shares of top speed in percent, separated by commas" dense outlined hide-details />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Enemy thermal sensitivity</div>
              <v-text-field v-model="enemyThermal" type="text" placeholder="Unknown" aria-label="Enemy thermal sensor sensitivity, blank when unknown" dense outlined hide-details />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Enemy EM sensitivity</div>
              <v-text-field v-model="enemyEm" type="text" placeholder="Unknown" aria-label="Enemy EM sensor sensitivity, blank when unknown" dense outlined hide-details />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Enemy active range</div>
              <v-text-field v-model="enemyRange" type="text" suffix="km" placeholder="Unknown" aria-label="Enemy active sensor range in km at its resolution, blank when unknown" dense outlined hide-details />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Enemy resolution</div>
              <v-text-field v-model="enemyResolution" type="text" suffix="HS" placeholder="Unknown" aria-label="Enemy active sensor resolution in HS, blank when unknown" dense outlined hide-details />
            </div>
            <div class="tool tool--figure">
              <div class="tool__label caption text--secondary">Proposed sensor size</div>
              <v-text-field v-model="passiveSize" type="text" suffix="HS" placeholder="Unknown" aria-label="Size of the proposed thermal and EM sensors in HS, blank when unknown" dense outlined hide-details data-sensors="passive-size" />
            </div>
            <div class="tool tool--class">
              <div class="tool__label caption text--secondary">Class for the speed and reduction panels</div>
              <v-autocomplete :value="selectedClass ? selectedClass.id : null" :items="classItems" item-text="text" item-value="value" placeholder="None" prepend-inner-icon="mdi-ferry" aria-label="Class for the speed and thermal reduction panels" dense outlined hide-details @change="pickClass" />
            </div>
          </template>
          <div class="tool tool--switch">
            <v-switch v-model="hideObsolete" label="Hide obsolete" dense hide-details class="mt-0 pt-2" />
          </div>
          <div class="tool tool--switch">
            <sensor-tech-levels :lines="modeTechLines" :notice="scenarioNotice" :changed="modeChangedCount" @tech="setTech" @next="chooseNextTech" @forget="forgetChoice" />
          </div>
        </div>

        <v-alert v-for="problem in shownProblems" :key="problem" type="warning" outlined dense class="mt-3" data-sensors="input-problem">{{ problem }}</v-alert>
        <v-alert v-if="hypotheticalNotice" type="warning" outlined dense class="mt-3" data-tech="hypothetical">{{ hypotheticalNotice }}</v-alert>
        <v-alert v-for="choice in unresolvedChoices" :key="choice.type" type="warning" outlined dense class="mt-3" data-tech="unresolved">{{ choice.text }}</v-alert>
        <v-chip v-if="focusRow" small outlined close class="mt-3" data-sensors="focus" @click:close="clearFocus">Focused design: {{ focusRow.name }}</v-chip>
        <v-alert v-if="mode === 'passive' && !classes.length" type="info" outlined dense class="mt-3" data-sensors="no-classes">The race has no ship classes.</v-alert>
        <v-alert v-if="handoffProblemText" type="warning" outlined dense dismissible class="mt-3" data-planner-link="unreadable" @input="dismissHandoffProblems">{{ handoffProblemText }}</v-alert>
        <v-alert v-if="focusNotice" type="warning" outlined dense dismissible class="mt-3" data-planner-link="design" @input="dismissFocusNotice">{{ focusNotice }}</v-alert>
        <v-card v-if="handoffResolution" class="panel" data-summary="The missile handed over by the Missile Designer: its name, size and range, the target signature, resolution and jammer it was evaluated under, where the figures come from and the tech it is built on, so the sizing reads against that missile and each figure traces back to it." elevation="1" data-planner-link="handoff">
          <div class="panel-head">
            <span>Missile from the Missile Designer<v-chip x-small outlined class="ml-2" data-planner-link="source">{{ handoffSourceText }}</v-chip><v-chip v-if="handoffResolution.applies" x-small outlined class="ml-2" :color="handoffHeld ? undefined : 'warning'" data-planner-link="state">{{ handoffHeld ? 'In the sizing' : 'Edited since' }}</v-chip></span>
          </div>
          <div class="panel-body">
            <div class="d-flex align-baseline"><span class="font-weight-medium handoff-name" data-planner-link="name">{{ handoffName }}</span><span v-if="handoff.missile !== null" class="caption text--secondary ml-2 text-no-wrap">Design {{ handoff.missile }}</span></div>
            <v-alert v-if="!handoffResolution.applies" type="warning" outlined dense class="mt-2 mb-0" data-planner-link="not-applied">{{ handoffNotAppliedText }}</v-alert>
            <template v-else>
              <v-alert v-if="!handoffHeld" type="info" outlined dense class="mt-2 mb-0" data-planner-link="edited">The sizing inputs were edited after the handover, so the target is the one typed above and no longer carries the missile's provenance. Entering the figures below again restores it.</v-alert>
              <v-simple-table dense class="mt-2" data-planner-link="figures">
                <tbody>
                  <tr v-for="row in handoffFigures" :key="row.key" :data-figure="row.key">
                    <th scope="row" class="text-left">{{ row.label }}</th>
                    <td class="text-no-wrap">{{ row.text }}<span v-if="row.unit" class="caption text--secondary"> {{ row.unit }}</span><provenance-mark v-if="row.result" :result="row.result" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div v-for="note in handoffResolution.notes" :key="note" class="caption warning--text mt-2" data-planner-link="note">{{ note }}</div>
              <div v-if="handoffResolution.tech.length" class="caption mt-2" data-planner-link="tech">
                <div class="text--secondary">Tech the missile is built on</div>
                <div v-for="level in handoffResolution.tech" :key="`${level.type}-${level.id}`" class="d-flex align-center" :data-tech-state="level.state">{{ level.text }}<page-link v-if="level.known" :to="linkTo.techTree({ tech: level.id })" :name="level.name" class="ml-1" /></div>
              </div>
            </template>
            <div class="d-flex align-center caption text--secondary mt-2">
              <span>Back to the Missile Designer</span><page-link :to="handoffBackLink" :name="handoffLabel" class="ml-1" data-planner-link="back" />
              <template v-if="handoffDesignedTech">
                <span class="ml-4">Row in Designed Tech</span><page-link :to="handoffDesignedTech" :name="handoffLabel" class="ml-1" data-planner-link="designed-tech" />
              </template>
            </div>
          </div>
          <div class="panel-foot caption text--secondary">The size and the range are those the Missile Designer evaluated, the range being the wanted range of the sizing. A saved missile is checked against the save and keeps the detection rule's own status while its stored size and range are the ones handed over; a candidate, a hypothetical or typed tech level, or a saved missile that changed since is marked assumed in every figure the target feeds. The signature, resolution and jammer are the scenario of the Missile Designer. Editing a sizing input ends the handover.</div>
        </v-card>

        <template v-if="mode === 'passive'">
          <v-card class="panel" data-summary="The thermal and EM signatures of each class and its cross-section with the cloak working and damaged, then how far the typed enemy sensors reach each. A figure is marked confirmed, estimated, assumed or unavailable, and a stored figure the rules do not reproduce is flagged, so the classes can be compared on what a sensor sees." elevation="1">
            <div class="panel-head">
              <span>Signatures</span>
              <span class="d-flex align-center flex-wrap">
                <v-chip small outlined class="mr-2">{{ signatureRows.length }} of {{ classes.length }} classes</v-chip>
              </span>
            </div>
            <div class="panel-body">
              <div class="legend mb-2">
                <span v-for="status in statuses" :key="status" class="legend-item mr-4"><provenance-mark :status="status" label /><span class="caption text--secondary ml-1">{{ statusMeaning(status) }}</span></span>
              </div>
              <div class="subtitle-2">Signatures of the classes</div>
            </div>
            <v-data-table :headers="signatureHeaders" :items="signatureRows" item-key="id" :sort-by.sync="signaturesTable.sortBy" :sort-desc.sync="signaturesTable.sortDesc" :items-per-page.sync="signaturesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No class to show." data-sensors="signatures">
              <template #[`item.name`]="{ item }">
                <div class="py-1">
                  <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                  <div v-if="item.obsolete" class="caption text--secondary">Obsolete</div>
                </div>
              </template>
              <template #[`item.sizeHS`]="{ item }"><div class="text-no-wrap">{{ shown(item.size, 2) }} HS<provenance-mark :result="item.size" /></div><div class="caption text--secondary text-no-wrap">{{ shown(item.tonsResult, 0) }} tons<provenance-mark :result="item.tonsResult" /></div></template>
              <template #[`item.cross`]="{ item }">
                <span class="text-no-wrap" data-sensors="cross-effective">{{ shown(item.sig.crossSection.effective, 2) }}</span><provenance-mark :result="item.sig.crossSection.effective" />
                <v-icon v-if="item.sig.crossSection.agrees === false" x-small color="warning" class="ml-1" :title="disagreement(item.sig.crossSection.stored, item.sig.crossSection.rebuilt, 'cross-section')">mdi-alert-circle-outline</v-icon>
                <div v-if="item.sig.crossSection.cloaked" class="caption text--secondary">Cloaked</div>
              </template>
              <template #[`item.uncloaked`]="{ item }"><span class="text-no-wrap" data-sensors="cross-uncloaked">{{ shown(item.sig.crossSection.uncloaked, 2) }}</span><provenance-mark :result="item.sig.crossSection.uncloaked" /></template>
              <template v-for="column in shareColumns" #[`item.${column.key}`]="{ item }">
                <span :key="column.key" class="text-no-wrap" :data-sensors="`thermal-${column.index}`">{{ shown(item.sig.thermal.byFraction[column.index].result, 1) }}</span><provenance-mark :key="`${column.key}-mark`" :result="item.sig.thermal.byFraction[column.index].result" />
                <v-icon v-if="column.full && item.sig.thermal.agrees === false" :key="`${column.key}-agree`" x-small color="warning" class="ml-1" :title="disagreement(item.sig.thermal.stored, item.sig.thermal.aggregate, 'thermal signature')">mdi-alert-circle-outline</v-icon>
              </template>
              <template #[`item.shields`]="{ item }"><span class="text-no-wrap" data-sensors="em-shields">{{ shown(item.sig.em.shields, 0) }}</span><provenance-mark :result="item.sig.em.shields" /></template>
              <template #[`item.active`]="{ item }">
                <span class="text-no-wrap" data-sensors="em-active" :title="activeEmText(item)">{{ shown(item.sig.em.strongestActive, 0) }}</span><provenance-mark :result="item.sig.em.strongestActive" />
                <div v-if="item.sig.em.activeSensors.length > 1" class="caption text--secondary text-no-wrap">{{ item.sig.em.activeSensors.length }} sensors, each alone</div>
              </template>
            </v-data-table>

            <div class="panel-body pt-4">
              <div class="subtitle-2">Reach of the enemy sensors (million km)</div>
            </div>
            <v-data-table :headers="reachHeaders" :items="signatureRows" item-key="id" :sort-by.sync="reachTable.sortBy" :sort-desc.sync="reachTable.sortDesc" :items-per-page.sync="reachTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No class to show." data-sensors="reach">
              <template #[`item.name`]="{ item }"><div class="font-weight-medium text-no-wrap py-1">{{ item.name }}</div></template>
              <template v-for="column in shareColumns" #[`item.reach${column.key}`]="{ item }">
                <span :key="column.key" class="text-no-wrap" :data-sensors="`reach-thermal-${column.index}`">{{ shown(item.reach.thermal[column.index], 2, MILLION) }}</span><provenance-mark :key="`${column.key}-mark`" :result="item.reach.thermal[column.index]" />
              </template>
              <template #[`item.reachShields`]="{ item }"><span class="text-no-wrap" data-sensors="reach-em-shields">{{ shown(item.reach.shields, 2, MILLION) }}</span><provenance-mark :result="item.reach.shields" /></template>
              <template #[`item.reachActiveEm`]="{ item }"><span class="text-no-wrap" data-sensors="reach-em-active">{{ shown(item.reach.activeEm, 2, MILLION) }}</span><provenance-mark :result="item.reach.activeEm" /></template>
              <template #[`item.reachCross`]="{ item }"><span class="text-no-wrap" data-sensors="reach-active-effective">{{ shown(item.reach.cross, 2, MILLION) }}</span><provenance-mark :result="item.reach.cross" /></template>
              <template #[`item.reachUncloaked`]="{ item }"><span class="text-no-wrap" data-sensors="reach-active-uncloaked">{{ shown(item.reach.uncloaked, 2, MILLION) }}</span><provenance-mark :result="item.reach.uncloaked" /></template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">
              At rest a class shows a twentieth of its size in HS as thermal signature. Moving, it shows the larger of that and the engines' summed power times thermal rating times the share of top speed. The sum is compared with the thermal signature the save stores for the class, and a warning icon names a stored figure the rule does not reproduce. The cross-section is the class size times the rating of the last cloak that fits the class, never under 0.3; an active sensor sees the size instead when the cloak is damaged. EM is the shield strength times 30 with shields up, and for each active sensor switched on its strength times its resolution, each seen alone and never summed; the saves store no emission, so EM figures are estimates. A passive sensor reaches 250,000 km times the square root of its sensitivity times the signature, and several sensors of one design do not add. An active sensor reaches its range times the square of the cross-section over its resolution when the cross-section is the smaller. The enemy figures are typed: they are assumed, a blank one is unknown and never 0, and nothing of another empire is read from the save. Shields may be below full strength, and damaged engines, overhaul, towing and nebulae change a fleet's speed and so its thermal signature; the figures are for the class and the chosen share. A hypothetical cloak is not sized here: only the cross-sections saved with the classes are shown.
              <div class="mt-2">The speed shares are percentages of top speed typed in the toolbar, separated by commas; idle and full speed are always shown beside them.</div>
            </div>
          </v-card>

          <v-card class="panel" data-summary="The thermal signature of the chosen class and the reach of the typed enemy thermal sensor against it from standing still to full speed, to see what speed costs in being seen." elevation="1">
            <div class="panel-head">
              <span>Speed and detection<v-chip v-if="selectedClass" x-small outlined class="ml-2">{{ selectedClass.name }}</v-chip></span>
              <v-btn-toggle v-model="speedView" mandatory dense>
                <v-btn value="chart" small aria-label="Chart"><v-icon small>mdi-chart-line</v-icon></v-btn>
                <v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>
              </v-btn-toggle>
            </div>
            <div class="panel-body">
              <div v-if="!selectedClass" class="caption text--secondary" data-sensors="speed-none">No class to show.</div>
              <template v-else-if="speedView === 'chart'">
                <div class="legend">
                  <span class="legend-item"><series-key :color="seriesColor(0)" kind="line" />Thermal signature</span>
                  <span v-if="speedChart.hasReach" class="legend-item"><series-key :color="seriesColor(1)" kind="line" />Reach of the enemy thermal sensor (million km)</span>
                </div>
                <div v-if="!speedChart.hasReach" class="caption text--secondary mt-1" data-sensors="speed-reach-unknown">The reach of the enemy thermal sensor is unknown: type its sensitivity to chart it.</div>
                <chart-canvas type="line" :data="speedChart.data" :options="speedChart.options" :height="320" :label="`Thermal signature of ${selectedClass.name} and the reach of the enemy thermal sensor against the share of top speed`" />
              </template>
              <v-simple-table v-else dense data-sensors="speed-table">
                <thead>
                  <tr>
                    <th class="text-right">Share of top speed</th>
                    <th class="text-right">Thermal signature</th>
                    <th class="text-right">Reach of the enemy thermal sensor (million km)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in speedRows" :key="row.fraction">
                    <td class="text-right text-no-wrap">{{ percent(row.fraction) }}<provenance-mark :result="typedShare(row.fraction)" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.thermal, 2) }}<provenance-mark :result="row.thermal" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.reach, 3, MILLION) }}<provenance-mark :result="row.reach" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">The share is the part of top speed the fleet moves at. Idle, with no move orders, is the floor of a twentieth of the class size, and a share too low to rise above the floor shows the floor. A class with no engine shows the floor at rest and 0 when it moves. The reach is that of a passive thermal sensor of the typed sensitivity against each signature; with no sensitivity typed the reach is unknown, and the table says so. The chart and the table list the same points.</div>
          </v-card>

          <v-card class="panel" data-summary="How far passive thermal and EM sensors detect targets of typed signatures: every thermal and EM sensor the race has researched and the typed enemy sensor, on logarithmic axes, to see which sensor sees what a target gives off." elevation="1">
            <div class="panel-head">
              <span>Passive range</span>
              <v-btn-toggle v-model="passiveView" mandatory dense>
                <v-btn value="chart" small aria-label="Chart"><v-icon small>mdi-chart-line</v-icon></v-btn>
                <v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>
              </v-btn-toggle>
            </div>
            <div class="panel-body">
              <v-row dense>
                <v-col cols="12" md="6"><v-text-field v-model="targetThermal" type="text" label="Target thermal signatures" suffix="thermal" :error-messages="targetThermalRead.error" aria-label="Thermal signatures of targets, separated by commas" dense outlined hide-details="auto" /></v-col>
                <v-col cols="12" md="6"><v-text-field v-model="targetEm" type="text" label="Target EM signatures" suffix="EM" :error-messages="targetEmRead.error" aria-label="EM signatures of targets, separated by commas" dense outlined hide-details="auto" /></v-col>
              </v-row>
              <div v-for="set in passiveSets" :key="set.kind" class="mt-4" :data-sensors="`passive-${set.kind}`">
                <div class="subtitle-2">{{ set.title }}</div>
                <div v-if="!set.sensitivities.length" class="caption text--secondary" :data-sensors="`passive-${set.kind}-none`">No {{ set.sensorName }} is researched by the race and no enemy sensitivity is typed.</div>
                <div v-else-if="!set.curve.rows.length" class="caption text--secondary">No target signature is typed.</div>
                <template v-else-if="passiveView === 'chart'">
                  <div class="legend">
                    <span v-for="(series, index) in set.chartSeries" :key="series.key" class="legend-item"><series-key :color="seriesColor(index)" kind="line" />{{ series.name }}</span>
                  </div>
                  <div v-if="set.skipped" class="caption text--secondary mt-1">A signature of 0 is listed in the table only: a logarithmic axis has no 0.</div>
                  <chart-canvas type="line" :data="set.chart.data" :options="set.chart.options" :height="300" :label="`Range of ${set.sensorName}s against target ${set.kind} signature`" />
                </template>
                <v-simple-table v-else dense :data-sensors="`passive-${set.kind}-table`">
                  <thead>
                    <tr>
                      <th class="text-right">Signature</th>
                      <th v-for="series in set.curve.series" :key="series.key" class="text-right">{{ series.name }} (million km)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in set.curve.rows" :key="row.signature">
                      <td class="text-right text-no-wrap">{{ count(row.signature, 2) }}<provenance-mark :result="typedSignature(row.signature)" /></td>
                      <td v-for="range in row.ranges" :key="range.key" class="text-right text-no-wrap">{{ shown(range.result, 3, MILLION) }}<provenance-mark :result="range.result" /></td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </div>
            </div>
            <div class="panel-foot caption text--secondary">A passive sensor detects a target out to 250,000 km times the square root of its sensitivity times the target's signature, so four times the sensitivity doubles the range. A sensor size typed in the toolbar adds a proposed thermal and an EM sensor of that size at the levels in use, ahead of the rest, and a hypothetical level marks its ranges. The sensors listed are every thermal and EM sensor design the race has researched, each by its design's sensitivity, the strongest first; the chart draws the strongest eight of each kind and the typed enemy sensor, and the table holds the rest. The number fitted to a ship does not add, and a target's cloak and jammer do not change a passive range. The target signatures are typed and assumed, one number for each point, in the thermal or EM figure of the game; the enemy sensitivity is the one typed in the toolbar and is assumed too. The axes are logarithmic.</div>
          </v-card>

          <v-card class="panel" data-summary="The engines of the chosen class designed again at each thermal reduction level the race has researched: the multiplier, the engine cost factor and tech, the engine BP and the thermal signature at the speed shares, to weigh stealth against cost." elevation="1">
            <div class="panel-head">
              <span>Thermal reduction<v-chip v-if="selectedClass" x-small outlined class="ml-2">{{ selectedClass.name }}</v-chip></span>
            </div>
            <div class="panel-body">
              <div v-if="!selectedClass" class="caption text--secondary">No class to show.</div>
              <div v-else-if="!selectedClass.engines.length" class="caption text--secondary" data-sensors="reduction-no-engine">The class mounts no engine.</div>
              <div v-else-if="!reductionRows.length" class="caption text--secondary" data-sensors="reduction-none">The race has researched no thermal reduction level.</div>
              <v-simple-table v-else dense data-sensors="reduction-table">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th class="text-right">Multiplier</th>
                    <th class="text-right">Cost factor</th>
                    <th class="text-right">Engine BP</th>
                    <th class="text-right">Class engines BP</th>
                    <th v-for="column in shareColumns" :key="column.key" class="text-right">Thermal at {{ column.label }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in reductionRows" :key="row.level.id" :class="{ 'is-current-level': row.level.current }">
                    <td class="text-no-wrap">{{ row.level.name }}<v-chip v-if="row.level.current" x-small outlined class="ml-2">Current</v-chip><page-link :to="linkTo.techTree({ tech: row.level.id })" :name="row.level.name" class="ml-1" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.multiplierResult, 2) }}<provenance-mark :result="row.multiplierResult" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.costFactorResult, 2) }}<provenance-mark :result="row.costFactorResult" /><div v-if="!row.costApplied" class="caption text--secondary">not applied</div></td>
                    <td class="text-right text-no-wrap">{{ shown(row.engineCost, 2) }}<provenance-mark :result="row.engineCost" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.classEngineCost, 2) }}<provenance-mark :result="row.classEngineCost" /></td>
                    <td v-for="(entry, index) in row.byFraction" :key="shareColumns[index].key" class="text-right text-no-wrap">{{ shown(entry.result, 1) }}<provenance-mark :result="entry.result" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">Each engine of the class is designed again from its own engine and fuel techs at the level's multiplier, which is the share of the engine's power that shows as heat. The cost factor is read from the level's tech and multiplies the engine's BP only when the multiplier is under 1. The thermal signature at a share is worked out as in the signatures panel from the engines at that level. The current level is the one every engine of the class was designed at. An engine whose tech rows are missing leaves the level unavailable, naming them.</div>
          </v-card>
        </template>

        <template v-else-if="mode === 'active'">
          <stat-tiles :tiles="activeTiles" class="mt-3" data-sensors="active-tiles" />

          <v-card class="panel" data-summary="The smallest search sensor and missile fire control that reach the wanted range against the target at each legal resolution: the size and reach of each, the pair's cost, minerals and crew, to see which resolution suits the target." elevation="1">
            <div class="panel-head">
              <span>Sizing<v-chip x-small outlined class="ml-2">{{ target.label }}</v-chip></span>
            </div>
            <div class="panel-body">
              <active-sizing-panel :scenarios="sizingScenarios" />
            </div>
            <div class="panel-foot caption text--secondary">
              <div>A sensor sees a target to its range cut by the square of the target's cross-section over the resolution when the target is under it, and shortened by 0.75 for each level the jammer stands over the ECCM. The missile fire control reaches twice the range of a search sensor of the same size. For each resolution the table lists the smallest legal size of each that reaches the wanted range, so a larger resolution needs a larger sensor against a small target. The best resolution is the pair with the lowest BP, then the smaller HS, then the higher resolution; a pair with no known cost is judged on size. A size beyond the largest legal one is reported as such, never as 0.</div>
              <div class="mt-2">The cross-section of a typed size is the size over 50 t per HS, never under 0.3 HS; a missile is seen by its size over 20 MSP per HS, never under 0.3 HS. A class with a working cloak has a second table with the cloak damaged. The jammer is the target's sensor jamming, not a missile's jammer. A hypothetical tech level is marked assumed in every figure that reads it.</div>
            </div>
          </v-card>

          <v-card class="panel" data-summary="How far the proposed pair and each saved sensor reach against targets of different sizes, on logarithmic axes or as a table, to see which sensor sees what size." elevation="1">
            <div class="panel-head">
              <span>Range curve</span>
              <v-btn-toggle v-model="curveView" mandatory dense>
                <v-btn value="chart" small aria-label="Chart"><v-icon small>mdi-chart-line</v-icon></v-btn>
                <v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>
              </v-btn-toggle>
            </div>
            <div class="panel-body">
              <v-row dense>
                <v-col cols="12" md="6"><v-text-field v-model="curveTonsText" type="text" label="Target sizes" suffix="t" placeholder="Default sizes" aria-label="Target sizes in tons, separated by commas" dense outlined hide-details data-sensors="curve-tons" /></v-col>
              </v-row>
              <div v-if="!curve.series.length" class="caption text--secondary mt-2" data-sensors="curve-none">The race has no active sensor and no pair is proposed.</div>
              <template v-else-if="curveView === 'chart'">
                <div class="legend mt-2">
                  <span v-for="(series, index) in curveChart.series" :key="series.key" class="legend-item"><series-key :color="seriesColor(index)" kind="line" />{{ series.name }}</span>
                </div>
                <div v-if="curveChart.hidden" class="caption text--secondary mt-1">The chart draws the first {{ curveChart.series.length }} sensors; the table lists the other {{ curveChart.hidden }}.</div>
                <chart-canvas type="line" :data="curveChart.data" :options="curveChart.options" :height="300" label="Range of the proposed pair and the saved active sensors against target size" />
              </template>
              <v-simple-table v-else dense class="mt-2" data-sensors="curve-table">
                <thead>
                  <tr>
                    <th class="text-right">Target size (t)</th>
                    <th v-for="series in curve.series" :key="series.key" class="text-right">{{ series.name }} (million km)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in curve.rows" :key="row.tons">
                    <td class="text-right text-no-wrap">{{ count(row.tons, 0) }}<provenance-mark :result="typedSize(row.tons)" /></td>
                    <td v-for="range in row.ranges" :key="range.key" class="text-right text-no-wrap">{{ shown(range.result, 3, MILLION) }}<provenance-mark :result="range.result" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">The curve is the effective range of each sensor against a target of each size, at the sensor's own resolution and ECCM and against the jammer typed in the toolbar. A target size is typed and assumed; the cross-section is the size over 50 t per HS, never under 0.3 HS. A sensor with no stored range or resolution has no point, never 0. The proposed pair comes first, then the saved sensors; the chart draws the first eight and the table lists all. The chart and the table hold the same points.</div>
          </v-card>

          <v-card class="panel" data-summary="A saved search sensor and a saved missile fire control against the target: the reach of each and of the pair, the member that falls short, and the best pair to design instead." elevation="1">
            <div class="panel-head">
              <span>Saved pair</span>
            </div>
            <div class="panel-body">
              <v-row dense>
                <v-col cols="12" md="6"><v-autocomplete :value="pairSearch ? pairSearch.id : null" :items="searchItems" item-text="text" item-value="value" label="Search sensor" clearable placeholder="None" aria-label="Saved search sensor" dense outlined hide-details data-sensors="pair-search" @change="pickSearch" /></v-col>
                <v-col cols="12" md="6"><v-autocomplete :value="pairFireControl ? pairFireControl.id : null" :items="fireControlItems" item-text="text" item-value="value" label="Missile fire control" clearable placeholder="None" aria-label="Saved missile fire control" dense outlined hide-details data-sensors="pair-fire-control" @change="pickFireControl" /></v-col>
              </v-row>
              <div v-if="!pairChecks.length" class="caption text--secondary mt-3" data-sensors="pair-none">Pick a search sensor and a missile fire control to check them against the target.</div>
              <div v-for="entry in pairChecks" :key="entry.key" class="mt-4" :data-sensors-pair="entry.key">
                <div v-if="pairChecks.length > 1" class="subtitle-2 mb-1">{{ entry.label }}</div>
                <v-simple-table dense data-sensors="pair-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Design</th>
                      <th class="text-right">Reach (million km)</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in entry.members" :key="item.key">
                      <td>{{ item.label }}<v-chip v-if="entry.check.limiting === item.key" x-small outlined class="ml-2" data-sensors="pair-limiting">Limits the pair</v-chip></td>
                      <td>{{ item.member ? item.member.row.name : 'None picked' }}</td>
                      <td class="text-right text-no-wrap">{{ item.member ? shown(item.member.reach, 3, MILLION) : 'Unknown' }}<provenance-mark v-if="item.member" :result="item.member.reach" /></td>
                      <td>{{ item.member ? meetsText(item.member.meets) : 'Unknown' }}</td>
                    </tr>
                    <tr>
                      <td class="font-weight-medium">Pair</td>
                      <td />
                      <td class="text-right text-no-wrap" data-sensors="pair-reach">{{ shown(entry.check.reach, 3, MILLION) }}<provenance-mark :result="entry.check.reach" /></td>
                      <td data-sensors="pair-verdict">{{ meetsText(entry.check.meets) }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div v-if="entry.alternative.length" class="mt-3">
                  <div class="caption text--secondary">Pair to design instead: the best one at {{ entry.basis }}.</div>
                  <active-sizing-panel :scenarios="entry.alternative" />
                </div>
                <div v-else class="caption text--secondary mt-3" data-sensors="pair-no-alternative">No pair of legal sizes reaches the range, so none is proposed.</div>
              </div>
            </div>
            <div class="panel-foot caption text--secondary">Each member is measured at its stored range, resolution and ECCM against the target and the jammer. The pair reaches as far as the shorter member. A search sensor that falls short limits the pair whatever the fire control reaches, and the reverse; when both fall short, the member that reaches less is named. The pair to design instead is the best one at the saved resolution of the search sensor when one reaches the range, else the best overall.</div>
          </v-card>

          <v-card class="panel" data-summary="What the proposed pair costs at each hardening and ECCM level the race has: BP, Uridium and Corbomite, and whether the pair still reaches the wanted range against the jammer." elevation="1">
            <div class="panel-head">
              <span>Hardening and ECCM</span>
            </div>
            <div class="panel-body">
              <div v-if="!tradeoff.rows.length" class="caption text--secondary" data-sensors="tradeoff-none">No pair reaches the range at the chosen resolution, so there is nothing to price.</div>
              <v-simple-table v-else dense data-sensors="tradeoff-table">
                <thead>
                  <tr>
                    <th>Hardening</th>
                    <th>ECCM</th>
                    <th class="text-right">Cost (BP)</th>
                    <th class="text-right">Uridium</th>
                    <th class="text-right">Corbomite</th>
                    <th class="text-right">Reach (million km)</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in tradeoff.rows" :key="index" :class="{ 'is-current-level': row.current }">
                    <td class="text-no-wrap">{{ row.hardening.level.name }}<v-chip v-if="row.hardening.hypothetical" x-small outlined class="ml-2">Hypothetical</v-chip></td>
                    <td class="text-no-wrap">{{ row.eccm.level.name }}<v-chip v-if="row.eccm.hypothetical" x-small outlined class="ml-2">Hypothetical</v-chip></td>
                    <td class="text-right text-no-wrap">{{ shown(row.cost, 1) }}<provenance-mark :result="row.cost" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.uridium, 1) }}<provenance-mark :result="row.uridium" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.corbomite, 1) }}<provenance-mark :result="row.corbomite" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.reach, 3, MILLION) }}<provenance-mark :result="row.reach" /></td>
                    <td>{{ meetsText(row.meets) }}</td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">The sizes stay those of the proposed pair at the chosen resolution; the levels change the cost and the ECCM the pair meets the jammer with. Hardening sets the Uridium of the sensor and ECCM the Corbomite on top of it. The row in the tint is the level the tech lines are set to. The jammer is the target's sensor jamming, lowered by the ECCM of the pair.</div>
          </v-card>

          <v-card class="panel" data-summary="The active sensors and missile fire controls the race has researched, with the stored figures and how far each reaches the target, linked to their designs and techs." elevation="1">
            <div class="panel-head">
              <span>Existing designs</span>
              <v-chip small outlined>{{ existingItems.length }} designs</v-chip>
            </div>
            <v-data-table :headers="existingHeaders" :items="existingItems" item-key="id" :sort-by.sync="existingTable.sortBy" :sort-desc.sync="existingTable.sortDesc" :items-per-page.sync="existingTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="The race has no active sensor." data-sensors="existing">
              <template #[`item.name`]="{ item }">
                <div class="py-1 text-no-wrap">
                  <span class="font-weight-medium">{{ item.name }}</span><page-link :to="linkTo.designedTech({ design: item.id })" :name="item.name" class="ml-1" />
                  <div v-if="item.obsolete" class="caption text--secondary">Obsolete</div>
                </div>
              </template>
              <template #[`item.sizeHS`]="{ item }"><span class="text-no-wrap">{{ shown(item.size, 2) }}</span><provenance-mark :result="item.size" /></template>
              <template #[`item.rangeKm`]="{ item }"><span class="text-no-wrap">{{ shown(item.range, 3, MILLION) }}</span><provenance-mark :result="item.range" /></template>
              <template #[`item.resolution`]="{ item }"><span class="text-no-wrap">{{ shown(item.resolutionResult, 0) }}</span><provenance-mark :result="item.resolutionResult" /></template>
              <template #[`item.eccm`]="{ item }"><span class="text-no-wrap">{{ shown(item.eccmResult, 0) }}</span><provenance-mark :result="item.eccmResult" /></template>
              <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ shown(item.costResult, 1) }}</span><provenance-mark :result="item.costResult" /></template>
              <template v-for="scenario in target.results" #[`item.reach${scenario.key}`]="{ item }">
                <span :key="scenario.key" class="text-no-wrap" :data-sensors="`existing-reach-${scenario.key}`">{{ shown(item.reaches.find((entry) => entry.key === scenario.key).reach, 3, MILLION) }}</span><provenance-mark :key="`${scenario.key}-mark`" :result="item.reaches.find((entry) => entry.key === scenario.key).reach" />
              </template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">The figures are as the save stores them. The reach is the stored range cut by the resolution against the target and shortened by the jammer over the ECCM, so a design the stored figures do not give a reach for shows Unknown. A missile fire control reaches as far as its own stored range. The links open the design in Designed Tech and its research in the Tech Tree.</div>
          </v-card>

          <v-card class="panel" data-summary="How far the proposed pair reaches each class of the race, with the cloak working and damaged, to see which classes the pair sees at the wanted range." elevation="1">
            <div class="panel-head">
              <span>Classes against the proposed pair</span>
              <v-chip small outlined>{{ visibleClasses.length }} of {{ classes.length }} classes</v-chip>
            </div>
            <div class="panel-body">
              <div v-if="!classReachRows.length" class="caption text--secondary" data-sensors="class-reach-none">No pair is proposed, or the race has no class to show.</div>
              <v-simple-table v-else dense data-sensors="class-reach">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Scenario</th>
                    <th class="text-right">Cross-section (HS)</th>
                    <th class="text-right">Search reach (million km)</th>
                    <th class="text-right">Fire control reach (million km)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in classReachRows" :key="row.key">
                    <td class="text-no-wrap">{{ row.name }}</td>
                    <td class="text-no-wrap">{{ row.label }}</td>
                    <td class="text-right text-no-wrap">{{ shown(row.signature, 2) }}<provenance-mark :result="row.signature" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.search, 3, MILLION) }}<provenance-mark :result="row.search" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.fireControl, 3, MILLION) }}<provenance-mark :result="row.fireControl" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">Each class is seen at its cross-section: the class size times the rating of the last cloak that fits, never under 0.3 HS, and the size alone where the cloak is damaged. The reach is that of the proposed search sensor and missile fire control at the chosen resolution, against the jammer typed in the toolbar. A class with no known cross-section shows Unknown.</div>
          </v-card>
        </template>

        <template v-else>
          <stat-tiles :tiles="beamTileList" class="mt-3" data-sensors="beam-tiles" />

          <v-card class="panel" data-summary="The range and the tracking speed wanted, each on its own: the multiplier that reaches it, what that multiplier gives, and whether the cap or the tech stands in the way." elevation="1">
            <div class="panel-head">
              <span>Requirement<v-chip x-small outlined class="ml-2" data-sensors="beam-restriction">{{ beam.restriction.label }}</v-chip></span>
            </div>
            <div class="panel-body">
              <v-simple-table dense data-sensors="beam-axes">
                <thead>
                  <tr>
                    <th>Requirement</th>
                    <th class="text-right">Wanted</th>
                    <th class="text-right">Multiplier</th>
                    <th class="text-right">Reaches</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in beamAxisRows" :key="row.key" :data-sensors-axis="row.key">
                    <td class="text-no-wrap">{{ row.label }} ({{ row.unit }})</td>
                    <td class="text-right text-no-wrap">{{ shown(row.wanted, 0) }}<provenance-mark :result="row.wanted" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.multiplier, 2) }}<provenance-mark :result="row.multiplier" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.reach, 0) }}<provenance-mark :result="row.reach" /></td>
                    <td>{{ row.verdict }}</td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">The range of a beam fire control is its range multiplier times the distance rating, never above 1,400,000 km, and its tracking speed is its tracking multiplier times the speed rating. The two are sized separately, each at the smallest legal multiplier that reaches what is wanted; a range above the cap is reported as beyond it, not as met. A single weapon control is offered only where the race has researched or hypothetically chose the single weapon tech, and the restriction in the heading says which kind is sized: an unrestricted control is never taken for a single weapon one.</div>
          </v-card>

          <v-card class="panel" data-summary="The beam fire controls at each pair of range and tracking multipliers: range, tracking speed, size, cost, minerals and crew, with the sized pair marked and a multiplier that the range cap wastes flagged." elevation="1">
            <div class="panel-head">
              <span>Multipliers</span>
              <v-chip small outlined>{{ beamMultiplierRows.length }} designs</v-chip>
            </div>
            <div class="panel-body">
              <v-simple-table dense data-sensors="beam-multipliers">
                <thead>
                  <tr>
                    <th class="text-right">Range multiplier</th>
                    <th class="text-right">Tracking multiplier</th>
                    <th class="text-right">Range (km)</th>
                    <th class="text-right">Tracking (km/s)</th>
                    <th class="text-right">Size (HS)</th>
                    <th class="text-right">Cost (BP)</th>
                    <th class="text-right">Uridium</th>
                    <th class="text-right">Corbomite</th>
                    <th class="text-right">Crew</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in beamMultiplierRows" :key="row.key" :class="{ 'is-current-level': row.proposed }" :data-sensors-multiplier="`${row.rangeMultiplier}-${row.trackingMultiplier}`">
                    <td class="text-right text-no-wrap">{{ row.rangeMultiplier }}<v-chip v-if="row.proposed" x-small outlined class="ml-2">Sized</v-chip></td>
                    <td class="text-right text-no-wrap">{{ row.trackingMultiplier }}</td>
                    <td class="text-right text-no-wrap">{{ shown(row.range, 0) }}<provenance-mark :result="row.range" /><div v-if="row.wasted" class="caption text--secondary">Capped: part of the multiplier is wasted</div></td>
                    <td class="text-right text-no-wrap">{{ shown(row.tracking, 0) }}<provenance-mark :result="row.tracking" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.size, 2) }}<provenance-mark :result="row.size" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.cost, 1) }}<provenance-mark :result="row.cost" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.uridium, 1) }}<provenance-mark :result="row.uridium" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.corbomite, 1) }}<provenance-mark :result="row.corbomite" /></td>
                    <td class="text-right text-no-wrap">{{ shown(row.crew, 0) }}<provenance-mark :result="row.crew" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
            <div class="panel-foot caption text--secondary">Each row designs the fire control at the two multipliers from the distance and speed ratings, the weapon number of the restriction and the hardening and ECCM levels in use. A row whose range multiplier takes the range past the cap of 1,400,000 km is flagged: the range stays at the cap and the rest of the multiplier only adds size and cost. A figure the tech lines do not give shows Unknown, naming the line.</div>
          </v-card>

          <v-card class="panel" data-summary="The beam fire controls the race has researched, with the stored range and tracking speed beside what is wanted and the axis that falls short." elevation="1">
            <div class="panel-head">
              <span>Existing beam fire controls</span>
              <v-chip small outlined>{{ existingBeamItems.length }} designs</v-chip>
            </div>
            <v-data-table :headers="beamHeaders" :items="existingBeamItems" item-key="id" :sort-by.sync="beamTable.sortBy" :sort-desc.sync="beamTable.sortDesc" :items-per-page.sync="beamTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="The race has no beam fire control." data-sensors="existing-beam">
              <template #[`item.name`]="{ item }">
                <div class="py-1 text-no-wrap">
                  <span class="font-weight-medium">{{ item.name }}</span><page-link :to="linkTo.designedTech({ design: item.id })" :name="item.name" class="ml-1" />
                  <div v-if="item.obsolete" class="caption text--secondary">Obsolete</div>
                </div>
              </template>
              <template #[`item.sizeHS`]="{ item }"><span class="text-no-wrap">{{ shown(item.size, 2) }}</span><provenance-mark :result="item.size" /></template>
              <template #[`item.cost`]="{ item }"><span class="text-no-wrap">{{ shown(item.costResult, 1) }}</span><provenance-mark :result="item.costResult" /></template>
              <template #[`item.rangeKm`]="{ item }"><span class="text-no-wrap">{{ shown(item.rangeResult, 0) }}</span><provenance-mark :result="item.rangeResult" /><v-chip v-if="item.aboveCap" x-small outlined class="ml-1" data-sensors="above-cap">Above cap</v-chip></template>
              <template #[`item.trackingKmS`]="{ item }"><span class="text-no-wrap">{{ shown(item.trackingResult, 0) }}</span><provenance-mark :result="item.trackingResult" /></template>
              <template #[`item.meets`]="{ item }">{{ meetsText(item.meets) }}</template>
              <template #[`item.limiting`]="{ item }">{{ limitingText(item) }}</template>
            </v-data-table>
            <div class="panel-foot caption text--secondary">The range and the tracking speed are as the save stores them, each held to the wanted one on its own. A stored range above the cap of 1,400,000 km that designing allows (a control made outside the game's design window) is marked Above cap and kept as stored, not cut to the cap: a shot is held to the stored range, so the verdict uses it as it is. A control that meets both is marked as meeting; one that falls short names the axis that limits it, range, tracking speed or both. With no range or tracking speed typed the answer is Unknown. The links open the design in Designed Tech.</div>
          </v-card>
        </template>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ActiveSizingPanel from '../components/sensors/ActiveSizingPanel.vue'
import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import SensorTechLevels from '../components/sensors/SensorTechLevels.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import techLevels, { TECH_INPUT_LABELS, techChoiceField } from '../mixins/tech-levels'
import { activeAppearance } from '../utilities/appearance'
import { cutText, linkTo, queryId, queryMissileTarget } from '../utilities/deep-links'
import { NO_SIGNATURE_CLASSES, NO_THERMAL_REDUCTION, SENSOR_COMPONENT_TYPES, loadSignatureClasses, loadThermalReduction, ownedActiveSensors, ownedBeamFireControls, ownedPassiveSensors } from '../utilities/design-data'
import { SENSOR_RESOLUTIONS_HS, SENSOR_RULES, TONS_PER_HS } from '../utilities/design-rules'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { entered } from '../utilities/missile-hit'
import { beginRead, componentPlacementText, isCurrentRead, loadComponentStanding, loadMissileStanding, resolveMissileTarget, targetProblemText } from '../utilities/planner-links'
import { STATUSES, STATUS_MARKS, STATUS, envelope, isAvailable, ofRule, unavailable, valueOrNull } from '../utilities/provenance'
import { DEFAULT_CURVE_TONS, SENSOR_MODE_LINES, SENSOR_TECH_LINES, activeSizing, beamSizing, existingBeamControls, existingDesigns, hardeningEccmTradeoff, passiveProposal, rangeCurve as sensorRangeCurve, savedPairCheck, sensorOf, sensorTechOf, targetOf } from '../utilities/sensor-planner'
import { axisRows, beamTiles, multiplierRows, sizingTiles } from '../utilities/sensor-view'
import { activeReach, classSignatures, passiveReach, rangeCurve, readSpeedShares, speedCurve, thermalReductionOptions } from '../utilities/signatures'

const INPUT_LABELS = {
  classRead: 'the ship classes with their engines, cloaks and sensors',
  ownedRows: 'the thermal and EM sensors the race has researched',
  reduction: 'the thermal reduction levels the race has researched',
  activeRows: 'the active sensors and missile fire controls the race has researched',
  beamRows: 'the beam fire controls the race has researched',
  ...TECH_INPUT_LABELS,
}

const PAGE_SIZES = [15, 30, -1]
const VIEWS = ['chart', 'table']

// The three modes of the page, in the order the switch lists them.
const MODES = Object.freeze([{ value: 'active', text: 'Active' }, { value: 'passive', text: 'Passive' }, { value: 'beam', text: 'Beam FC' }])
const MODE_VALUES = MODES.map((mode) => mode.value)

// What an active sensor is sized against: a size in tons, a class of the race or a missile size in MSP.
const TARGET_KINDS = Object.freeze([{ value: 'tons', text: 'Tons' }, { value: 'class', text: 'Own class' }, { value: 'missile', text: 'Missile' }])

// The resolution choices: the best of them, or one of the window's.
const RESOLUTION_ITEMS = Object.freeze([{ text: 'Best', value: 'best' }, ...SENSOR_RESOLUTIONS_HS.map((value) => ({ text: `${value} HS`, value: String(value) }))])
const validResolution = (value) => value === 'best' || SENSOR_RESOLUTIONS_HS.includes(Number(value))

// The tech lines the menu lists, as the mixin takes them.
const TECH_LINES = SENSOR_TECH_LINES.map(({ typeId, label }) => ({ type: typeId, label }))

// Ranges are listed in millions of km.
const MILLION = 1e6

// A tick of a logarithmic axis is labelled at 1, 2 and 5 times a power of 10 only, so the labels stay apart.
const logTick = (value) => (value > 0 && [1, 2, 5].includes(roundToDecimal(value / 10 ** Math.floor(Math.log10(value)), 6)) ? String(value) : '')

// The steps the speed curve is drawn in between standing still and full speed.
const SPEED_STEPS = 20

// The most own sensors of a kind drawn beside the enemy one: the chart has nine categorical colours. The table lists every researched sensor.
const MAX_SENSOR_SERIES = 8

const EMPTY_LIST = Object.freeze([])

const text = (value) => typeof value === 'string'

// The numbers of a text such as '10, 100 1000': each a finite number of 0 or more. `error` names the first token that is not one, as a `noun` of 0 or more.
const numbersOf = (value, noun = 'signature') => {
  const tokens = String(value === null || value === undefined ? '' : value).split(/[\s,;]+/).filter(Boolean)
  const values = []

  for (const token of tokens) {
    const number = entered(token)

    if (number === null || number < 0) {
      return { values: EMPTY_LIST, error: `"${token}" is not a ${noun} of 0 or more` }
    }

    values.push(number)
  }

  return { values, error: '' }
}

// A figure the enemy sensor is typed as: blank or not above 0 is null (unknown), anything else an assumed result that the reach rules lend their provenance from.
const typedFigure = (value, name, units) => {
  const number = entered(value)

  if (number === null || !(number > 0)) {
    return null
  }

  return envelope({ value: number, status: STATUS.ASSUMED, rule: SENSOR_RULES.detection, units, inputs: { present: [name] }, assumptions: [`${name} is typed, not read from the save`] })
}

// The rules a figure stored in the save or typed in the toolbar is marked under: the size of the class as the save stores it, the engine design rule that reads the level's multiplier and cost factor, and the thermal signature rule the shares of top speed feed.
const CLASS_SIZE_RULE = 'design.classSize'
const ENGINE_RULE = 'design.engineDesign'
const THERMAL_SIGNATURE_RULE = 'design.thermalSignature'

// A figure the save stores as a result: confirmed when it is a number, unavailable (never 0) when the save holds none.
const storedFigure = (value, name, rule, units) => (Number.isFinite(value) ? ofRule({ rule, value, units, inputs: { present: [name] } }) : unavailable({ rule, units, missing: [name] }))

// A page for what a sensor sees and what it takes to see it. Active mode sizes the search sensor and the missile fire control that reach a target, passive mode shows what the classes of the race give off and how far passive sensors reach (utilities/signatures.js), and beam mode sizes the beam fire control for a range and a tracking speed (utilities/sensor-planner.js). The three read the same tech levels.
export default {
  name: 'SensorsPage',
  components: { ActiveSizingPanel, ChartCanvas, LoadState, PageLink, ProvenanceMark, SensorTechLevels, SeriesKey, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    techLevels({ lines: TECH_LINES }),
    persistedView({
      techChoice: techChoiceField('sensorsTech'),
      mode: { key: 'sensorsMode', default: 'active', scope: 'race', valid: oneOf(MODE_VALUES) },
      targetKind: { key: 'sensorsTargetKind', default: 'tons', scope: 'race', valid: oneOf(TARGET_KINDS.map((kind) => kind.value)) },
      targetTons: { key: 'sensorsTargetTons', default: '', scope: 'race', valid: text },
      targetClassId: { key: 'sensorsTargetClass', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      targetMsp: { key: 'sensorsTargetMsp', default: '', scope: 'race', valid: text },
      wantedRange: { key: 'sensorsWantedRange', default: '', scope: 'race', valid: text },
      resolutionPick: { key: 'sensorsResolution', default: 'best', scope: 'race', valid: (value) => text(value) && validResolution(value) },
      jammer: { key: 'sensorsJammer', default: '', scope: 'race', valid: text },
      pairSearchId: { key: 'sensorsPairSearch', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      pairFcId: { key: 'sensorsPairFireControl', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      curveTonsText: { key: 'sensorsCurveTons', default: '', scope: 'race', valid: text },
      beamRange: { key: 'sensorsBeamRange', default: '', scope: 'race', valid: text },
      beamTracking: { key: 'sensorsBeamTracking', default: '', scope: 'race', valid: text },
      beamSingle: { key: 'sensorsBeamSingle', default: false, scope: 'race', valid: (value) => typeof value === 'boolean' },
      passiveSize: { key: 'sensorsPassiveSize', default: '', scope: 'race', valid: text },
      shares: { key: 'sensorsShares', default: '50', scope: 'race', valid: text },
      enemyThermal: { key: 'sensorsEnemyThermal', default: '', scope: 'race', valid: text },
      enemyEm: { key: 'sensorsEnemyEm', default: '', scope: 'race', valid: text },
      enemyRange: { key: 'sensorsEnemyRange', default: '', scope: 'race', valid: text },
      enemyResolution: { key: 'sensorsEnemyResolution', default: '', scope: 'race', valid: text },
      hideObsolete: { key: 'sensorsHideObsolete', default: false, valid: (value) => typeof value === 'boolean' },
      classId: { key: 'sensorsClass', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      targetThermal: { key: 'sensorsTargetThermal', default: '10, 100, 1000, 10000', scope: 'race', valid: text },
      targetEm: { key: 'sensorsTargetEm', default: '10, 100, 1000, 10000', scope: 'race', valid: text },
      speedView: { key: 'sensorsSpeedView', default: 'chart', valid: oneOf(VIEWS) },
      passiveView: { key: 'sensorsPassiveView', default: 'chart', valid: oneOf(VIEWS) },
      curveView: { key: 'sensorsCurveView', default: 'chart', valid: oneOf(VIEWS) },
      signaturesTable: { ...tableView('sensorsSignaturesTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
      reachTable: { ...tableView('sensorsReachTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
      existingTable: { ...tableView('sensorsExistingTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
      beamTable: { ...tableView('sensorsBeamTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
    }),
  ],
  data() {
    return {
      linkTo,
      pageSizes: PAGE_SIZES,
      statuses: STATUSES,
      MILLION,
      modes: MODES,
      targetKinds: TARGET_KINDS,
      resolutionItems: RESOLUTION_ITEMS,
      focusSensorId: null,
      // The missile a link hands over (utilities/deep-links.js `queryMissileTarget`): the target, or null; why a target in the query was unreadable; what the save says of the saved missile it names (undefined until read); whether its figures were put in the inputs.
      handoff: null,
      handoffProblems: [],
      handoffStanding: undefined,
      handoffApplied: false,
      // What the save says of a design a link names that the open mode does not list, and the text of a link's design that is not an ID.
      focusStanding: null,
      focusInvalid: '',
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    // The speed shares as typed: idle and full speed always present.
    sharesRead() {
      return readSpeedShares(this.shares)
    },

    fractions() {
      return this.sharesRead.fractions
    },

    // One column of the tables for each share: its key, its label, its place in the shares and whether it is full speed.
    shareColumns() {
      return this.fractions.map((fraction, index) => ({ key: `share${index}`, index, fraction, label: fraction === 0 ? 'idle' : `${roundToDecimal(fraction * 100, 2)} %`, full: fraction === 1 }))
    },

    // The enemy sensors as typed, each an assumed result or null when blank or not above 0.
    enemy() {
      return {
        thermal: typedFigure(this.enemyThermal, 'the enemy thermal sensitivity', ''),
        em: typedFigure(this.enemyEm, 'the enemy EM sensitivity', ''),
        range: typedFigure(this.enemyRange, 'the enemy active sensor range', 'km'),
        resolution: typedFigure(this.enemyResolution, 'the enemy active sensor resolution', 'HS'),
      }
    },

    // What typed in the toolbar is not read: the field, and that a blank one is unknown.
    inputProblems() {
      const fields = [
        [this.enemyThermal, this.enemy.thermal, 'Enemy thermal sensitivity'],
        [this.enemyEm, this.enemy.em, 'Enemy EM sensitivity'],
        [this.enemyRange, this.enemy.range, 'Enemy active range'],
        [this.enemyResolution, this.enemy.resolution, 'Enemy resolution'],
      ]
      const problems = fields.filter(([typed, figure]) => String(typed).trim() !== '' && figure === null).map(([, , name]) => `${name}: enter a number above 0, or leave the field blank when it is unknown.`)

      return this.sharesRead.error ? [`Speed shares: ${this.sharesRead.error}; the defaults are shown.`, ...problems] : problems
    },

    classes() {
      return this.classRead || NO_SIGNATURE_CLASSES
    },

    classItems() {
      return this.classes.map((cls) => ({ text: cls.obsolete ? `${cls.name} (obsolete)` : cls.name, value: cls.id }))
    },

    // The chosen class, else the first with an engine, else the first.
    selectedClass() {
      return this.classes.find((cls) => cls.id === this.classId) || this.classes.find((cls) => cls.engines.length) || this.classes[0] || null
    },

    visibleClasses() {
      return this.hideObsolete ? this.classes.filter((cls) => !cls.obsolete) : this.classes
    },

    // One row for each class shown: what it shows to a sensor, and how far each typed enemy sensor reaches it.
    signatureRows() {
      return this.visibleClasses.map((cls) => {
        const sig = classSignatures(cls, { fractions: this.fractions })
        const { crossSection, em, thermal } = sig
        const reach = {
          thermal: thermal.byFraction.map(({ result }) => passiveReach({ sensitivity: this.enemy.thermal, signature: result })),
          shields: passiveReach({ sensitivity: this.enemy.em, signature: em.shields }),
          activeEm: passiveReach({ sensitivity: this.enemy.em, signature: em.strongestActive }),
          cross: activeReach({ rangeKm: this.enemy.range, resolution: this.enemy.resolution, crossSection: crossSection.effective }),
          uncloaked: activeReach({ rangeKm: this.enemy.range, resolution: this.enemy.resolution, crossSection: crossSection.uncloaked }),
        }
        const size = storedFigure(cls.sizeHS, 'the class size', CLASS_SIZE_RULE, 'HS')
        const tons = storedFigure(Number.isFinite(cls.sizeHS) ? cls.sizeHS * TONS_PER_HS : null, 'the class size', CLASS_SIZE_RULE, 't')
        const row = { id: cls.id, name: cls.name, obsolete: cls.obsolete === true, sizeHS: valueOrNull(size), tons: valueOrNull(tons), size, tonsResult: tons, sig, reach, cross: valueOrNull(crossSection.effective), uncloaked: valueOrNull(crossSection.uncloaked), shields: valueOrNull(em.shields), active: valueOrNull(em.strongestActive), reachShields: valueOrNull(reach.shields), reachActiveEm: valueOrNull(reach.activeEm), reachCross: valueOrNull(reach.cross), reachUncloaked: valueOrNull(reach.uncloaked) }

        thermal.byFraction.forEach(({ result }, index) => {
          row[`share${index}`] = valueOrNull(result)
          row[`reachshare${index}`] = valueOrNull(reach.thermal[index])
        })

        return row
      })
    },

    signatureHeaders() {
      return [
        { text: 'Class', value: 'name' },
        { text: 'Size', value: 'sizeHS', align: 'end' },
        { text: 'Cross-section (HS)', value: 'cross', align: 'end' },
        { text: 'Cloak damaged (HS)', value: 'uncloaked', align: 'end' },
        ...this.shareColumns.map((column) => ({ text: `Thermal ${column.label}`, value: column.key, align: 'end' })),
        { text: 'EM shields up', value: 'shields', align: 'end' },
        { text: 'EM active sensor', value: 'active', align: 'end' },
      ]
    },

    reachHeaders() {
      return [
        { text: 'Class', value: 'name' },
        ...this.shareColumns.map((column) => ({ text: `Thermal ${column.label}`, value: `reach${column.key}`, align: 'end' })),
        { text: 'EM shields up', value: 'reachShields', align: 'end' },
        { text: 'EM active sensor', value: 'reachActiveEm', align: 'end' },
        { text: 'Active, cloaked', value: 'reachCross', align: 'end' },
        { text: 'Active, cloak damaged', value: 'reachUncloaked', align: 'end' },
      ]
    },

    // The thermal signature and the reach of the enemy thermal sensor at 0 to 100 % of top speed, for the chosen class.
    speed() {
      return this.selectedClass ? speedCurve(this.selectedClass, { sensitivity: this.enemy.thermal, steps: SPEED_STEPS }) : { points: EMPTY_LIST, rows: EMPTY_LIST }
    },

    speedRows() {
      return this.speed.rows
    },

    speedChart() {
      const { points } = this.speed
      const thermal = points.filter((point) => point.thermal !== null).map((point) => ({ x: roundToDecimal(point.fraction * 100, 2), y: roundToDecimal(point.thermal, 2) }))
      const reach = points.filter((point) => point.reach !== null).map((point) => ({ x: roundToDecimal(point.fraction * 100, 2), y: roundToDecimal(point.reach / MILLION, 3) }))
      const line = (label, data, color, axis) => ({ label, data, yAxisID: axis, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0 })
      const datasets = [line('Thermal signature', thermal, this.seriesColor(0), 'y')]
      const { ink, inkMuted, border } = this.theme

      if (reach.length) {
        datasets.push(line('Reach of the enemy thermal sensor (million km)', reach, this.seriesColor(1), 'y1'))
      }

      return {
        hasReach: reach.length > 0,
        data: { labels: [], datasets },
        options: {
          scales: {
            x: { type: 'linear', min: 0, max: 100, title: { display: true, text: 'Share of top speed (%)' } },
            y: { type: 'linear', min: 0, title: { display: true, text: 'Thermal signature' } },
            y1: { type: 'linear', min: 0, position: 'right', display: reach.length > 0, grid: { drawOnChartArea: false }, border: { color: border }, ticks: { color: inkMuted, padding: 6 }, title: { display: true, text: 'Reach (million km)', color: ink } },
          },
        },
      }
    },

    targetThermalRead() {
      return numbersOf(this.targetThermal)
    },

    targetEmRead() {
      return numbersOf(this.targetEm)
    },

    // The thermal and EM sensor designs the race has researched, each by its sensitivity, strongest first, after the proposed one when a size is typed.
    ownThermalSensors() {
      return [...this.proposalSensors('thermal'), ...this.sensorsOf(SENSOR_COMPONENT_TYPES.thermal, 'thermal')]
    },

    ownEmSensors() {
      return [...this.proposalSensors('em'), ...this.sensorsOf(SENSOR_COMPONENT_TYPES.em, 'em')]
    },

    // The two range curves of the passive panel: for each kind, the researched sensors and the typed enemy one, against the typed target signatures.
    passiveSets() {
      return [
        this.passiveSet({ kind: 'thermal', title: 'Thermal sensors against thermal signature', sensorName: 'thermal sensor', own: this.ownThermalSensors, enemy: this.enemy.thermal, signatures: this.targetThermalRead.values, axis: 'Thermal signature' }),
        this.passiveSet({ kind: 'em', title: 'EM sensors against EM signature', sensorName: 'EM sensor', own: this.ownEmSensors, enemy: this.enemy.em, signatures: this.targetEmRead.values, axis: 'EM signature' }),
      ]
    },

    // The chosen class's engines at each researched level: the page adds the plain facts of the level (whether its cost factor applies).
    reductionRows() {
      if (!this.selectedClass) {
        return EMPTY_LIST
      }

      return thermalReductionOptions(this.selectedClass, { levels: this.reduction.levels, techs: this.reduction.techs, fractions: this.fractions }).map((option) => ({ ...option, costApplied: option.multiplier < 1, multiplierResult: storedFigure(option.multiplier, 'the multiplier of the level', ENGINE_RULE, ''), costFactorResult: storedFigure(option.costFactor, 'the cost factor of the level', ENGINE_RULE, '') }))
    },

    // ---------- the tech the three modes share ----------

    techInput() {
      return sensorTechOf(this.tech, this.techResolution)
    },

    // The tech types the open mode reads: the menu lists only these, and every mode keeps the same choices.
    modeTechTypes() {
      return SENSOR_TECH_LINES.filter((entry) => entry.modes.includes(this.mode)).map((entry) => entry.typeId)
    },

    modeTechLines() {
      return this.techLines.filter((line) => this.modeTechTypes.includes(line.type))
    },

    // The lines of the open mode that are not at the game's pick.
    modeChangedCount() {
      return this.modeTechTypes.filter((type) => this.techResolution[type] && this.techResolution[type].level && this.techResolution[type].level !== this.tech.lines[type].pick).length
    },

    hypotheticalNotice() {
      const marks = SENSOR_MODE_LINES[this.mode].map((role) => this.techInput[role].assumption).filter(Boolean)

      return marks.length ? `Hypothetical tech is in use, so the figures built on it carry the assumption in their marks: ${marks.join('; ')}.` : ''
    },

    // ---------- the problems of what is typed ----------

    activeProblems() {
      const problems = [
        this.targetKind === 'tons' ? this.figureProblem(this.targetTons, 'Target size') : '',
        this.targetKind === 'missile' ? this.figureProblem(this.targetMsp, 'Missile size') : '',
        this.figureProblem(this.wantedRange, 'Wanted range'),
        this.figureProblem(this.jammer, 'Jammer', true),
        this.curveTonsRead.error ? `Sizes of the curve: ${this.curveTonsRead.error}; the defaults are shown.` : '',
      ]

      return problems.filter(Boolean)
    },

    beamProblems() {
      return [this.figureProblem(this.beamRange, 'Wanted range'), this.figureProblem(this.beamTracking, 'Wanted tracking speed')].filter(Boolean)
    },

    passiveProblems() {
      return [...this.inputProblems, this.figureProblem(this.passiveSize, 'Sensor size')].filter(Boolean)
    },

    // The problems of the open mode.
    shownProblems() {
      return this.mode === 'active' ? this.activeProblems : this.mode === 'beam' ? this.beamProblems : this.passiveProblems
    },

    // ---------- active mode ----------

    // The class an own-class target is: the chosen one, else the class of the signature panels.
    targetClass() {
      return this.classes.find((cls) => cls.id === this.targetClassId) || this.selectedClass
    },

    target() {
      return targetOf({ kind: this.targetKind, tons: this.targetTons, cls: this.targetClass, msp: this.targetMsp, origin: this.handoffLive && this.handoffResolution.applies ? this.handoffResolution.origin : null })
    },

    // The pair sized for each scenario of the target: the cloak working, and a second one with the cloak damaged for a class that has a cloak.
    sizingScenarios() {
      return this.target.results.map((entry) => ({ key: entry.key, label: entry.label, sizing: activeSizing({ target: entry, wantedRangeKm: this.wantedRange, resolution: this.resolutionPick, jammer: this.jammer, tech: this.techInput }) }))
    },

    sizing() {
      return this.sizingScenarios[0].sizing
    },

    activeTiles() {
      return sizingTiles(this.sizing, this.count)
    },

    searchSensors() {
      return this.activeRows.filter((row) => row.kind === 'search')
    },

    fireControls() {
      return this.activeRows.filter((row) => row.kind === 'fireControl')
    },

    // The saved sensors and fire controls shown, the focused design first.
    visibleActive() {
      return this.focusFirst(this.hideObsolete ? this.activeRows.filter((row) => !row.obsolete) : this.activeRows)
    },

    searchItems() {
      return this.searchSensors.map((row) => ({ text: row.obsolete ? `${row.name} (obsolete)` : row.name, value: row.id }))
    },

    fireControlItems() {
      return this.fireControls.map((row) => ({ text: row.obsolete ? `${row.name} (obsolete)` : row.name, value: row.id }))
    },

    // The design a pick names, else the focused one when it is of the kind.
    pairSearch() {
      return this.searchSensors.find((row) => row.id === this.pairSearchId) || (this.focusRow && this.focusRow.kind === 'search' ? this.focusRow : null)
    },

    pairFireControl() {
      return this.fireControls.find((row) => row.id === this.pairFcId) || (this.focusRow && this.focusRow.kind === 'fireControl' ? this.focusRow : null)
    },

    // The saved pair against the target for each scenario: each member's reach, the pair's, the limiting member and the best pair proposed instead.
    pairChecks() {
      if (!this.pairSearch && !this.pairFireControl) {
        return EMPTY_LIST
      }

      return this.target.results.map((entry) => {
        const check = savedPairCheck({ search: this.pairSearch, fireControl: this.pairFireControl, target: entry, wantedRangeKm: this.wantedRange, jammer: this.jammer, tech: this.techInput })
        const members = [{ key: 'search', label: 'Search sensor', member: check.search }, { key: 'fireControl', label: 'Missile fire control', member: check.fireControl }]
        const alternative = check.alternative.row ? [{ key: `${entry.key}-alternative`, label: entry.label, sizing: { problems: EMPTY_LIST, request: check.alternative.sizing.request, rows: [check.alternative.row] } }] : EMPTY_LIST

        return { key: entry.key, label: entry.label, check, members, alternative, basis: check.alternative.basis }
      })
    },

    // What the pair of the first scenario costs at each hardening and ECCM level the race has.
    tradeoff() {
      return hardeningEccmTradeoff({ sizing: this.sizing, tech: this.techInput })
    },

    // The proposed search sensor and fire control as sensors of the curve and the class table: the pair of the chosen resolution, a null range where it has none.
    proposedSensors() {
      const row = this.sizing.selected

      if (!row) {
        return EMPTY_LIST
      }

      const sensorOfMember = (member, key, name, kind) => {
        const design = isAvailable(member.design) ? member.design.value : null

        return { key, name, kind, rangeKm: design ? design.rangeKm : null, resolution: row.resolution, eccm: design ? design.eccm : null, source: design ? member.design : null }
      }

      return [sensorOfMember(row.search, 'proposed-search', 'Proposed search sensor', 'search'), sensorOfMember(row.fireControl, 'proposed-fire-control', 'Proposed missile fire control', 'fireControl')]
    },

    // The saved sensors with their reach against the target in each scenario, as the rows of the designs table.
    existingItems() {
      return existingDesigns({ sensors: this.visibleActive, target: this.target, jammer: this.jammer }).map(({ row, scenarios }) => {
        const item = {
          id: row.id,
          name: row.name,
          obsolete: row.obsolete === true,
          kind: row.kind === 'search' ? 'Search sensor' : 'Missile fire control',
          sizeHS: row.sizeHS,
          rangeKm: row.rangeKm,
          resolution: row.resolution,
          eccm: row.eccm,
          cost: row.cost,
          size: storedFigure(row.sizeHS, 'the sensor size', SENSOR_RULES.active, 'HS'),
          range: storedFigure(row.rangeKm, 'the stored range', SENSOR_RULES.active, 'km'),
          resolutionResult: storedFigure(row.resolution, 'the stored resolution', SENSOR_RULES.active, 'HS'),
          eccmResult: storedFigure(row.eccm, 'the stored ECCM', SENSOR_RULES.active, ''),
          costResult: storedFigure(row.cost, 'the stored cost', SENSOR_RULES.active, 'BP'),
          reaches: scenarios,
        }

        scenarios.forEach((scenario) => {
          item[`reach${scenario.key}`] = valueOrNull(scenario.reach)
        })

        return item
      })
    },

    beamHeaders() {
      return [
        { text: 'Design', value: 'name' },
        { text: 'Size (HS)', value: 'sizeHS', align: 'end' },
        { text: 'Cost (BP)', value: 'cost', align: 'end' },
        { text: 'Range (km)', value: 'rangeKm', align: 'end' },
        { text: 'Tracking (km/s)', value: 'trackingKmS', align: 'end' },
        { text: 'Verdict', value: 'meets' },
        { text: 'Limiting axis', value: 'limiting' },
      ]
    },

    existingHeaders() {
      return [
        { text: 'Design', value: 'name' },
        { text: 'Kind', value: 'kind' },
        { text: 'Size (HS)', value: 'sizeHS', align: 'end' },
        { text: 'Range (million km)', value: 'rangeKm', align: 'end' },
        { text: 'Resolution (HS)', value: 'resolution', align: 'end' },
        { text: 'ECCM', value: 'eccm', align: 'end' },
        { text: 'Cost (BP)', value: 'cost', align: 'end' },
        ...this.target.results.map((entry) => ({ text: `Reach, ${entry.label} (million km)`, value: `reach${entry.key}`, align: 'end' })),
      ]
    },

    // The proposed pair against each class of the race, in each scenario of the class.
    classReachRows() {
      if (!this.sizing.selected) {
        return EMPTY_LIST
      }

      return this.visibleClasses.flatMap((cls) => {
        const classTarget = targetOf({ kind: 'class', cls })
        const [search, fireControl] = existingDesigns({ sensors: this.proposedSensors, target: classTarget, jammer: this.jammer })

        return classTarget.results.map((entry, index) => ({ key: `${cls.id}-${entry.key}`, name: cls.name, label: entry.label, signature: entry.signature, search: search.scenarios[index].reach, fireControl: fireControl.scenarios[index].reach }))
      })
    },

    curveTonsRead() {
      return numbersOf(this.curveTonsText, 'size in tons')
    },

    curveTonsList() {
      return this.curveTonsRead.values.length && !this.curveTonsRead.error ? this.curveTonsRead.values : DEFAULT_CURVE_TONS
    },

    // The reach of the proposed pair and the saved sensors against targets of each size in tons.
    curve() {
      return sensorRangeCurve({ sensors: [...this.proposedSensors.filter((sensor) => sensor.rangeKm !== null), ...this.visibleActive.map(sensorOf)], tonsList: this.curveTonsList, jammer: this.jammer })
    },

    // The chart of the curve: the first series (the proposed pair, then the saved sensors) at the points a logarithmic axis can show. The table lists every sensor.
    curveChart() {
      const charted = this.curve.series.slice(0, MAX_SENSOR_SERIES)
      const datasets = charted.map((series, index) => ({ label: series.name, data: series.points.filter((point) => point.x > 0 && point.y > 0).map((point) => ({ x: point.x, y: point.y / MILLION })), borderColor: this.seriesColor(index), backgroundColor: this.seriesColor(index), borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, tension: 0 }))

      return {
        series: charted,
        hidden: Math.max(0, this.curve.series.length - MAX_SENSOR_SERIES),
        data: { labels: [], datasets },
        options: {
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: { tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.parsed.y.toPrecision(4))} million km` } } },
          scales: {
            x: { type: 'logarithmic', ticks: { callback: logTick }, title: { display: true, text: 'Target size (tons, log)' } },
            y: { type: 'logarithmic', ticks: { callback: logTick }, title: { display: true, text: 'Range (million km, log)' } },
          },
        },
      }
    },

    // ---------- beam mode ----------

    beam() {
      return beamSizing({ rangeKm: this.beamRange, trackingKmS: this.beamTracking, tech: this.techInput, singleWeapon: this.beamSingle && this.techInput.singleWeapon.offersSingle })
    },

    beamTileList() {
      return beamTiles(this.beam, this.count)
    },

    beamAxisRows() {
      return axisRows(this.beam, this.count)
    },

    beamMultiplierRows() {
      return multiplierRows(this.beam)
    },

    visibleBeam() {
      return this.focusFirst(this.hideObsolete ? this.beamRows.filter((row) => !row.obsolete) : this.beamRows)
    },

    // The saved beam fire controls with what each reaches beside what is wanted, as the rows of the beam table.
    existingBeamItems() {
      return existingBeamControls({ controls: this.visibleBeam, rangeKm: this.beamRange, trackingKmS: this.beamTracking }).map((entry) => ({
        id: entry.row.id,
        name: entry.row.name,
        obsolete: entry.row.obsolete === true,
        sizeHS: entry.row.sizeHS,
        cost: entry.row.cost,
        rangeKm: entry.row.rangeKm,
        aboveCap: entry.range.aboveCap,
        trackingKmS: entry.row.trackingKmS,
        special: entry.row.specialFunction,
        size: storedFigure(entry.row.sizeHS, 'the stored size', SENSOR_RULES.beam, 'HS'),
        costResult: storedFigure(entry.row.cost, 'the stored cost', SENSOR_RULES.beam, 'BP'),
        rangeResult: entry.range.result,
        trackingResult: entry.tracking.result,
        meets: entry.meets,
        limiting: entry.limiting,
      }))
    },

    // ---------- passive proposals ----------

    // A thermal and an EM sensor of the typed size, designed from the race's techs; none while the size is blank.
    passiveProposals() {
      if (String(this.passiveSize).trim() === '') {
        return EMPTY_LIST
      }

      return [['thermal', 'Thermal sensor'], ['em', 'EM sensor']].map(([kind, label]) => ({ kind, label, proposal: passiveProposal({ sizeHS: this.passiveSize, kind, tech: this.techInput }) }))
    },

    // ---------- the focus ----------

    // The design a link names, among those of the open mode.
    focusRow() {
      if (this.focusSensorId === null) {
        return null
      }

      const pool = this.mode === 'active' ? this.activeRows : this.mode === 'beam' ? this.beamRows : this.ownedRows.map((row) => ({ id: row.SDComponentID, name: row.Name }))

      return pool.find((row) => row.id === this.focusSensorId) || null
    },

    // ---------- the missile handed over ----------

    // The handed-over missile against the open save and its tech: whether it applies, its provenance and the state of each tech level. Null for a link with none.
    handoffResolution() {
      return this.handoff ? resolveMissileTarget({ target: this.handoff, standing: this.handoffStanding, tech: this.tech }) : null
    },

    // The inputs are still the handed-over figures: the mode, the missile target and its size and range, and the resolution and jammer the link carried.
    handoffHeld() {
      const target = this.handoff

      if (!target) {
        return false
      }

      const resolutionCarried = target.resolution !== null && validResolution(String(target.resolution))
      const jammer = String(this.jammer).trim() === '' ? 0 : entered(this.jammer)

      return this.mode === 'active' && this.targetKind === 'missile' && entered(this.targetMsp) === target.msp && entered(this.wantedRange) === target.range && (!resolutionCarried || String(this.resolutionPick) === String(target.resolution)) && (target.jammer === null || jammer === target.jammer)
    },

    // The handover is in the link: while the saved missile is being checked, and while it applies and has not been edited away.
    handoffLive() {
      const resolution = this.handoffResolution

      return Boolean(resolution) && (resolution.pending || (resolution.applies && (!this.handoffApplied || this.handoffHeld)))
    },

    handoffName() {
      if (!this.handoff) {
        return ''
      }

      return this.handoff.name || (this.handoff.missile === null ? 'Candidate' : `Saved missile ${this.handoff.missile}`)
    },

    // The name as a link or a history entry shows it: the name is whole in the panel and in every check, and cut where it is only a label.
    handoffLabel() {
      return cutText(this.handoffName)
    },

    handoffSourceText() {
      return this.handoff ? { saved: 'Saved missile', researched: 'Candidate on researched tech', hypothetical: 'Candidate on hypothetical tech', manual: 'Candidate on typed tech' }[this.handoff.source] : ''
    },

    // Each handed-over figure as a result: the size and the range carry the target's provenance, the rest are the Missile Designer's scenario, assumed, or unknown where the link carries none.
    handoffFigures() {
      const resolution = this.handoffResolution
      const target = this.handoff

      if (!resolution || !resolution.origin) {
        return EMPTY_LIST
      }

      const { origin } = resolution
      const handed = (value, units) => envelope({ value, status: origin.status, rule: SENSOR_RULES.detection, units, inputs: { present: origin.present }, assumptions: origin.assumptions })
      const scenario = (value, units, name) => (value === null ? unavailable({ rule: SENSOR_RULES.detection, missing: [`${name}: the link carries none`], units }) : envelope({ value, status: STATUS.ASSUMED, rule: SENSOR_RULES.detection, units, inputs: { present: [name] }, assumptions: [`${name} was typed in the Missile Designer scenario and carried in the link, not read from the save`] }))
      const best = target.resolution === 'best'
      const carried = (value, decimals) => (value === null ? 'Not carried' : this.count(value, decimals))

      return [
        { key: 'size', label: 'Size', result: handed(target.msp, 'MSP'), text: this.count(target.msp, 2), unit: 'MSP' },
        { key: 'range', label: 'Wanted range', result: handed(target.range, 'km'), text: this.count(target.range, 0), unit: 'km' },
        { key: 'signature', label: 'Target signature evaluated under', result: scenario(target.signature, 'HS', 'the target signature'), text: carried(target.signature, 2), unit: target.signature === null ? '' : 'HS' },
        { key: 'resolution', label: 'Resolution', result: best ? null : scenario(target.resolution, 'HS', 'the resolution'), text: best ? 'Best' : carried(target.resolution, 2), unit: target.resolution === null || best ? '' : 'HS' },
        { key: 'jammer', label: 'Jammer', result: scenario(target.jammer, '', 'the jammer'), text: carried(target.jammer, 2), unit: '' },
      ]
    },

    // The words for a handover that does not apply, and for a target of the link that could not be read.
    handoffNotAppliedText() {
      return targetProblemText({ resolution: this.handoffResolution })
    },

    handoffProblemText() {
      return this.handoffProblems.length ? targetProblemText({ problems: this.handoffProblems }) : ''
    },

    // The links of the panel: back to the Missile Designer (the saved missile's own page, or the page as it was for a candidate) and the saved missile's row in Designed Tech.
    handoffBackLink() {
      return linkTo.missileDesigner({ missile: this.handoff ? this.handoff.missile : null, name: this.handoff ? this.handoff.name : '' })
    },

    handoffDesignedTech() {
      return this.handoff && this.handoff.missile !== null ? linkTo.designedTech({ missile: this.handoff.missile }) : null
    },

    // Why a design a link names is not the focus: text that is no ID, or a design the open mode does not list, with what the save says of it.
    focusNotice() {
      if (this.focusSensorId === null) {
        return this.focusInvalid === '' ? '' : `The link names the design "${cutText(this.focusInvalid)}", which is not a design ID (a whole number above 0). No design is focused.`
      } else if (this.focusRow) {
        return ''
      } else if (!this.focusStanding || this.focusStanding.id !== this.focusSensorId) {
        return `The design ${this.focusSensorId} named by the link is being checked against the save.`
      }

      return `${componentPlacementText({ standing: this.focusStanding, mode: MODES.find((entry) => entry.value === this.mode).text, found: false })} No design is focused.`
    },

    // A link names the mode and the design the page is on.
    linkQuery() {
      return this.ready ? linkTo.sensors({ mode: this.mode, sensor: this.focusRow ? this.focusRow.id : null, target: this.handoffLive ? this.handoff : null }).query : null
    },

    linkLabel() {
      return this.focusRow ? this.focusRow.name : this.handoffLive && this.handoffResolution.applies ? this.handoffLabel : ''
    },
  },
  watch: {
    // The saved missile is checked and the tech read: the handover is put in the inputs once it applies.
    handoffResolution() {
      this.settleHandoff()
    },

    ready() {
      this.settleHandoff()
    },

    database() {
      this.readStandings()
    },

    context() {
      this.readStandings()
    },
  },
  asyncComputed: {
    // The race's classes with the engines, cloaks and sensors their signatures are made of.
    classRead: {
      get: tracked('classRead', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_SIGNATURE_CLASSES
        }

        return await loadSignatureClasses(this.database, this.context)
      }),
      default: NO_SIGNATURE_CLASSES,
    },
    // The thermal and EM sensor designs the race has researched, as the rows of the save.
    ownedRows: {
      get: tracked('ownedRows', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await ownedPassiveSensors(this.database, this.GameID, this.RaceID)
      }),
      default: EMPTY_LIST,
    },
    // The thermal reduction levels the race has researched and the tech rows its engines name.
    reduction: {
      get: tracked('reduction', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_THERMAL_REDUCTION
        }

        return await loadThermalReduction(this.database, this.context)
      }),
      default: NO_THERMAL_REDUCTION,
    },
    // The active sensors and missile fire controls the race has researched, as the rows of the save.
    activeRows: {
      get: tracked('activeRows', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await ownedActiveSensors(this.database, this.GameID, this.RaceID)
      }),
      default: EMPTY_LIST,
    },
    // The beam fire controls the race has researched, as the rows of the save.
    beamRows: {
      get: tracked('beamRows', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await ownedBeamFireControls(this.database, this.GameID, this.RaceID)
      }),
      default: EMPTY_LIST,
    },
  },
  methods: {
    pickClass(id) {
      this.classId = Number.isInteger(id) ? id : null
    },

    // The colour of the n-th series of a chart.
    seriesColor(index) {
      const colors = this.theme.categorical

      return colors[index % colors.length]
    },

    percent(fraction) {
      return `${roundToDecimal(fraction * 100, 2)} %`
    },

    // A figure typed in the toolbar and taken as given: the rule that uses it lends the provenance, and the status is assumed.
    typedResult(value, name, rule, units) {
      return envelope({ value, status: STATUS.ASSUMED, rule, units, inputs: { present: [name] }, assumptions: [`${name} is typed or defaulted here, not read from the save`] })
    },

    typedSignature(signature) {
      return this.typedResult(signature, 'the target signature', SENSOR_RULES.detection, '')
    },

    typedShare(fraction) {
      return this.typedResult(fraction, 'the share of top speed', THERMAL_SIGNATURE_RULE, '')
    },

    statusMeaning(status) {
      return STATUS_MARKS[status].meaning
    },

    // A figure of a result as text, divided by `divisor`: Unknown for a result with no value, never 0.
    shown(result, decimals = 0, divisor = 1) {
      return isAvailable(result) ? this.count(result.value / divisor, decimals) : 'Unknown'
    },

    // Where a figure the save stores is not the one the rules give.
    disagreement(stored, computed, name) {
      return `The save stores ${this.shown(stored, 2)} for the ${name} of this class and the rule gives ${this.shown(computed, 2)}.`
    },

    // The EM signature of each active sensor of a class, each seen on its own.
    activeEmText(row) {
      const sensors = row.sig.em.activeSensors

      return sensors.length ? sensors.map(({ sensor, result }) => `${sensor.name}: ${this.shown(result, 0)}`).join('; ') : 'The class has no active sensor.'
    },

    // The designs of one kind of passive sensor the race has researched, strongest first, as { key, name, sensitivity } (sensitivity null when the design stores none).
    sensorsOf(typeId, kind) {
      const strength = (sensor) => (Number.isFinite(sensor.sensitivity) ? sensor.sensitivity : -Infinity)

      return this.ownedRows
        .filter((row) => row.ComponentTypeID === typeId)
        .map((row) => ({ key: `${kind}-${row.SDComponentID}`, id: row.SDComponentID, name: row.Name, sensitivity: Number.isFinite(row.ComponentValue) ? row.ComponentValue : null }))
        .sort((a, b) => Number(b.id === this.focusSensorId) - Number(a.id === this.focusSensorId) || strength(b) - strength(a) || a.name.localeCompare(b.name) || a.id - b.id)
        .map((sensor) => ({ key: sensor.key, name: sensor.sensitivity === null ? sensor.name : `${sensor.name} (${this.count(sensor.sensitivity, 2)})`, sensitivity: sensor.sensitivity }))
    },

    // The proposed sensor of a kind as a sensor of the passive curves, the one designed at the typed size; none when the size is blank or the techs give no sensitivity.
    proposalSensors(kind) {
      const entry = this.passiveProposals.find((proposal) => proposal.kind === kind)
      const sensitivity = entry ? valueOrNull(entry.proposal.sensitivity) : null

      return sensitivity === null ? EMPTY_LIST : [{ key: `${kind}-proposed`, name: `Proposed ${entry.label.toLowerCase()} of ${this.passiveSize} HS (${this.count(sensitivity, 2)})`, sensitivity, source: entry.proposal.sensitivity }]
    },

    // What typed in a figure field is not read: blank is unknown (or none, for a jammer), and a figure is above 0 (or 0 or more).
    figureProblem(typed, name, zeroAllowed = false) {
      const number = entered(typed)

      if (String(typed === null || typed === undefined ? '' : typed).trim() === '' || (number !== null && (zeroAllowed ? number >= 0 : number > 0))) {
        return ''
      }

      return zeroAllowed ? `${name}: enter a number of 0 or more, or leave the field blank for none.` : `${name}: enter a number above 0, or leave the field blank when it is unknown.`
    },

    // The rows of a list with the focused design first.
    focusFirst(rows) {
      return [...rows].sort((a, b) => Number(b.id === this.focusSensorId) - Number(a.id === this.focusSensorId))
    },

    // The mode of the switch: a focus on a design of another mode is dropped.
    setMode(mode) {
      if (MODE_VALUES.includes(mode)) {
        this.mode = mode

        if (!this.focusRow) {
          this.focusSensorId = null
        }
      }
    },

    clearFocus() {
      this.focusSensorId = null
    },

    pickSearch(id) {
      this.pairSearchId = Number.isInteger(id) ? id : null
    },

    pickFireControl(id) {
      this.pairFcId = Number.isInteger(id) ? id : null
    },

    // Whether a design meets what is wanted, in words: Unknown where the answer is.
    meetsText(meets) {
      return meets === true ? 'Meets' : meets === false ? 'Falls short' : 'Unknown'
    },

    // The axis that limits a beam fire control, in words: None for one that meets, Unknown where the answer is.
    limitingText(item) {
      return item.limiting === 'both' ? 'Range and tracking speed' : item.limiting === 'tracking' ? 'Tracking speed' : item.limiting === 'range' ? 'Range' : item.meets === true ? 'None' : 'Unknown'
    },

    // A tonnage typed for the curve as a result: taken as given, so assumed.
    typedSize(tons) {
      return this.typedResult(tons, 'the target size', SENSOR_RULES.detection, 't')
    },

    // The mode and the design the query names. A mode the query leaves out keeps the mode the page restored; a design it names becomes the pair, whatever pair was picked.
    applyLink(query) {
      const mode = Array.isArray(query.mode) ? query.mode[0] : query.mode

      if (MODE_VALUES.includes(mode)) {
        this.mode = mode
      }

      this.focusSensorId = queryId(query.sensor)
      this.focusInvalid = this.focusSensorId === null && (Array.isArray(query.sensor) ? query.sensor[0] : query.sensor) !== undefined ? String(Array.isArray(query.sensor) ? query.sensor[0] : query.sensor) : ''

      if (this.focusSensorId !== null) {
        this.pairSearchId = null
        this.pairFcId = null
      }

      const parsed = queryMissileTarget(query)

      this.handoff = parsed ? parsed.target : null
      this.handoffProblems = parsed ? parsed.problems : []
      this.handoffStanding = undefined
      this.handoffApplied = false
      this.readStandings()
      this.settleHandoff()
    },

    // The standing of the saved missile and of the design a link names: what the save says of each, the latest read only counting.
    readStandings() {
      this.readHandoffStanding()
      this.readFocusStanding()
    },

    async readHandoffStanding() {
      const id = this.handoff ? this.handoff.missile : null
      const stamp = beginRead(this, 'handoff')

      this.handoffStanding = undefined

      if (id === null || !this.database || !this.GameID || !this.RaceID) {
        return
      }

      const standing = await loadMissileStanding(this.database, this.context, id)

      if (isCurrentRead(this, stamp) && this.handoff && id === this.handoff.missile) {
        this.handoffStanding = standing
        this.settleHandoff()
      }
    },

    async readFocusStanding() {
      const id = this.focusSensorId
      const stamp = beginRead(this, 'focus')

      this.focusStanding = null

      if (id === null || !this.database || !this.GameID || !this.RaceID) {
        return
      }

      const standing = await loadComponentStanding(this.database, this.context, id)

      if (isCurrentRead(this, stamp) && id === this.focusSensorId) {
        this.focusStanding = standing
      }
    },

    // Puts the handed-over figures in the inputs once, when they apply: Active mode with the missile as the target, its size, the range as the wanted range, and the resolution and jammer the link carried. Anything typed afterwards is the user's.
    settleHandoff() {
      const resolution = this.handoffResolution

      if (!resolution || !resolution.applies || this.handoffApplied || !this.ready) {
        return
      }

      const target = this.handoff

      this.mode = 'active'
      this.targetKind = 'missile'
      this.targetMsp = String(target.msp)
      this.wantedRange = String(target.range)

      if (target.resolution !== null && validResolution(String(target.resolution))) {
        this.resolutionPick = String(target.resolution)
      }

      if (target.jammer !== null) {
        this.jammer = target.jammer === 0 ? '' : String(target.jammer)
      }

      this.handoffApplied = true
    },

    dismissHandoffProblems() {
      this.handoffProblems = []
    },

    dismissFocusNotice() {
      this.focusSensorId = null
      this.focusInvalid = ''
    },

    // One kind's curve, its chart (the strongest own sensors and the typed enemy one, at the points of the curve's series a logarithmic axis can show) and the sensors it holds. The table lists every sensor.
    passiveSet({ kind, title, sensorName, own, enemy, signatures, axis }) {
      const sensitivities = [...own, ...(enemy ? [{ key: `${kind}-enemy`, name: 'Enemy sensor', sensitivity: enemy }] : [])]
      const curve = rangeCurve({ sensitivities, signatures })
      const charted = new Set([...own.slice(0, MAX_SENSOR_SERIES).map((sensor) => sensor.key), `${kind}-enemy`])
      const chartSeries = curve.series.filter((series) => charted.has(series.key))
      const shownPoints = (series) => series.points.filter((point) => point.x > 0 && point.y > 0)
      const datasets = chartSeries.map((series, index) => ({ label: series.name, data: shownPoints(series).map((point) => ({ x: point.x, y: point.y / MILLION })), borderColor: this.seriesColor(index), backgroundColor: this.seriesColor(index), borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, tension: 0 }))
      const skipped = curve.series.some((series) => shownPoints(series).length !== series.points.length) || signatures.includes(0)

      return {
        kind,
        title,
        sensorName,
        sensitivities,
        curve,
        chartSeries,
        hidden: Math.max(0, own.length - MAX_SENSOR_SERIES),
        skipped,
        chart: {
          data: { labels: [], datasets },
          options: {
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: { tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.parsed.y.toPrecision(4))} million km` } } },
            scales: {
              x: { type: 'logarithmic', ticks: { callback: logTick }, title: { display: true, text: `${axis} (log)` } },
              y: { type: 'logarithmic', ticks: { callback: logTick }, title: { display: true, text: 'Range (million km, log)' } },
            },
          },
        },
      }
    },
  },
}
</script>

<style lang="scss">
.sensors-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }

  .tool {
    min-width: 0;
  }

  // The missile's name stops at two lines whatever its length; the plugin that serves cut text gives the whole name as the title while it is cut.
  .handoff-name {
    display: -webkit-box;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .tool__label {
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
    white-space: nowrap;
  }

  .tool--shares {
    flex: 0 0 200px;
  }

  .tool--figure {
    flex: 0 0 150px;
  }

  .tool--class {
    flex: 1 1 200px;
    max-width: 300px;
  }

  .tool--switch {
    align-self: flex-end;
  }

  tr.is-current-level {
    background: var(--ae-row-selected);
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
