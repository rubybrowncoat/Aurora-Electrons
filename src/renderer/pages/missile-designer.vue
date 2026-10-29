<template>
  <div>
    <v-container fluid class="missile-designer-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <v-alert v-if="designs.fixture && !savedItems.length" type="info" outlined dense class="mt-1" data-designer="no-designs">The race has no researched and owned missile design in this save, so there is no baseline to pin. Designs can still be made here from the tech the race holds.</v-alert>
        <v-alert v-if="designs.excluded > 0" type="info" outlined dense class="mt-1" data-designer="excluded">{{ designs.excluded }} {{ designs.excluded === 1 ? 'design is' : 'designs are' }} owned by the race but not researched by it, and {{ designs.excluded === 1 ? 'is' : 'are' }} not imported.</v-alert>
        <v-alert v-if="hypotheticalNotice" type="warning" outlined dense class="mt-1" data-tech="hypothetical">{{ hypotheticalNotice }}</v-alert>
        <v-alert v-for="item in unresolvedChoices" :key="item.type" type="warning" outlined dense class="mt-1" data-tech="unresolved">{{ item.text }}</v-alert>
        <v-alert v-if="scenarioNotice" type="info" outlined dense class="mt-1" data-tech="scenario-notice">{{ scenarioNotice }}</v-alert>
        <v-alert v-if="linkNotice" type="warning" outlined dense dismissible class="mt-1" data-link="notice" @input="dismissLink">{{ linkNotice }}</v-alert>

        <v-card class="panel" data-summary="The saved missile pinned as the baseline, and the scenario every column is judged under." elevation="1">
          <div class="panel-head">
            <span>Baseline and scenario</span>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="tool tool--baseline">
                <div class="tool__label caption text--secondary">Baseline, a saved missile<page-link v-if="baselineLink" :to="baselineLink" :name="baselineName" class="ml-1" /></div>
                <v-autocomplete :value="baselineId" :items="savedItems" item-text="text" item-value="value" placeholder="None" prepend-inner-icon="mdi-rocket-launch-outline" aria-label="Saved missile pinned as the baseline" clearable dense outlined hide-details data-field="baseline" @change="setBaseline" />
              </div>
              <div class="tool tool--actions">
                <div class="tool__buttons">
                  <v-btn outlined :disabled="!canSeed || alternatives.length >= maxAlternatives" aria-label="Add a design seeded from the baseline" data-action="seed" @click="seedFromBaseline"><v-icon small left>mdi-content-copy</v-icon>Seed from baseline</v-btn>
                  <v-menu offset-y :close-on-content-click="true" max-height="360">
                    <template #activator="{ on, attrs }">
                      <v-btn outlined :disabled="!savedItems.length || alternatives.length >= maxAlternatives" aria-label="Add a saved missile as an alternative" data-action="add-saved" v-bind="attrs" v-on="on"><v-icon small left>mdi-plus</v-icon>Saved missile</v-btn>
                    </template>
                    <v-list dense>
                      <v-list-item v-for="item in savedItems" :key="item.value" @click="addSaved(item.value)"><v-list-item-title>{{ item.text }}</v-list-item-title></v-list-item>
                    </v-list>
                  </v-menu>
                  <v-btn outlined :disabled="alternatives.length >= maxAlternatives" aria-label="Add a blank design" data-action="add-blank" @click="addBlank"><v-icon small left>mdi-plus</v-icon>Blank design</v-btn>
                </div>
              </div>
            </div>
            <div v-if="alternativeMessage" class="caption warning--text mt-2" data-designer="alternative-message">{{ alternativeMessage }}</div>
            <div class="toolbar mt-3">
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target speed</div>
                <v-text-field v-model="hitTargetSpeed" suffix="km/s" aria-label="Target speed in km/s" :error-messages="scenarioErrors.targetSpeed" dense outlined hide-details="auto" data-field="targetSpeed" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target missile jammer</div>
                <v-text-field v-model="hitJammer" aria-label="Strength of the target's missile jammer" :error-messages="scenarioErrors.jammer" dense outlined hide-details="auto" data-field="jammer" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Tactical modifier</div>
                <v-text-field v-model="hitModifier" aria-label="Tactical modifier of the launching ship" :error-messages="scenarioErrors.modifier" dense outlined hide-details="auto" data-field="modifier" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Point-defence figure (planner)</div>
                <v-text-field v-model="pd" suffix="km/s" aria-label="Point-defence figure of the planner figure, in km/s" :error-messages="pdError" dense outlined hide-details="auto" data-field="pd" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target signature</div>
                <v-text-field v-model="targetSignature" suffix="HS" aria-label="Signature of the target in HS, for the reach of the missile's own sensor" :error-messages="scenarioErrors.targetSignature" dense outlined hide-details="auto" data-field="targetSignature" />
              </div>
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            The scenario is the target's speed and missile jammer, the launcher's tactical modifier, the point-defence figure and the target's signature. A baseline keeps the figures the save stored, and a design made here starts from a copy of it or from nothing. The target speed, jammer and modifier are those of the Designed Tech page's missile hit chance panel and move together. The point-defence figure feeds the planner figure only, warhead × hit chance × (1 − PD / speed), a planner figure and not a game statistic: it is a point-defence attenuation in km/s with no verified model of interception, and it must be 0 or more and not above the missile speed. The target signature sets the reach of a missile's own active sensor against it and is left blank when not wanted.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The tech levels that designs are made with." elevation="1">
          <div class="panel-head">
            <span>Tech levels<v-chip v-if="techChoiceCount" x-small outlined class="ml-2">{{ techChoiceCount }} changed</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="scenarioNotice" class="caption warning--text mb-2" data-tech="notice">{{ scenarioNotice }}</div>
            <v-row dense>
              <v-col v-for="line in techLines" :key="line.type" cols="12" sm="6" md="4" xl="3" :data-tech-line="line.type">
                <v-select :value="line.selected" :items="line.items" item-text="text" item-value="value" :label="line.label" :disabled="!line.items.length" dense outlined hide-details @change="(id) => setTech(line.type, id)" />
                <v-select v-if="line.candidates.length" :value="line.candidate" :items="line.candidates" item-text="text" item-value="value" :label="`${line.label}: next tech (hypothetical)`" clearable dense outlined hide-details class="mt-1" @change="(id) => chooseNextTech(line.type, id)" />
                <div v-if="line.hypothetical" class="caption warning--text pt-1 pl-3" data-tech="hypothetical-line">Hypothetical: the results use a level the race has not researched.</div>
                <div v-if="line.unresolved" class="caption warning--text pt-1 pl-3" data-tech="unresolved-line">{{ line.unresolvedText }}<v-btn x-small text class="ml-1" @click="forgetChoice(line.type)">Forget the choice</v-btn></div>
                <div v-if="line.next" class="d-flex align-center caption text--disabled pt-1 pl-3">Next: {{ line.nextText }}<page-link :to="linkTo.techTree({ tech: line.next.id })" :name="line.next.name" class="ml-1" /></div>
                <div v-else-if="!line.items.length" class="caption text--disabled pt-1 pl-3">Not researched</div>
              </v-col>
            </v-row>
          </div>
          <div class="panel-foot caption text--secondary">
            Each line starts at the level the race holds and can be set to another level it has researched or to a next level it has not, which marks every result built on it as hypothetical. Ship thrust limits are not among them. A missile engine is designed at the thrust modifier of the missile itself. Above the race's greatest thrust modifier its fuel use is boosted by the missile rule; a ship's least thrust modifier and largest engine size are never read here. Typed tech figures on an alternative replace these lines for that alternative.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The baseline and its alternatives side by side." data-designer="comparison" elevation="1">
          <div class="panel-head">
            <span>Comparison<v-chip v-if="comparison.columns.length" x-small outlined class="ml-2">{{ comparison.columns.length }} {{ comparison.columns.length === 1 ? 'column' : 'columns' }}</v-chip></span>
            <span class="d-flex align-center flex-wrap">
              <v-btn small text :disabled="!comparison.columns.length" aria-label="Copy the comparison as text" data-action="copy" @click="copySummary"><v-icon small left>mdi-content-copy</v-icon>Copy summary</v-btn>
            </span>
          </div>
          <div v-if="copyMessage" class="panel-body pt-0 pb-0 caption text--secondary" data-designer="copy-message">{{ copyMessage }}</div>
          <div v-if="!comparison.columns.length" class="panel-body text--secondary" data-designer="empty">Pin a saved missile as the baseline, or add an alternative, to compare.</div>
          <missile-compare-table v-else :comparison="comparison" :links="columnLinks" @remove="removeAlternative" />
          <div class="panel-foot caption text--secondary">
            Alternatives are saved missiles, designs made from the tech the race holds, from a hypothetical next level or from typed figures. Every column carries the same inputs, figures and gated options, each figure with its provenance mark, and sizes in MSP, HS and tons. For a saved missile, the column shows what the save stored beside what the rules rebuild. Size is the full MSP sum of every part, raised to the floor of 1 MSP and cut to the size limit; 20 MSP are 1 HS and 50 tons are 1 HS. Fuel is 2,500 litres to the MSP, cut to a whole litre; speed and endurance are cut to 0.1. A saved missile's recomputed figures are rebuilt from the levels the race holds that reproduce what it stored, so agreement shows that some held level gives the figure; a figure the save lacks is unknown, never 0, and unknown or unsupported is never agreement. The planner figure is the planner's own heuristic and no game statistic. It is per warhead: the strength and the hit chance are those of one warhead and neither is multiplied by the number of warheads. A saved missile's hit chance and planner figure use its recomputed speed and warhead.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The designs made here, one editor each." data-designer="alternatives" elevation="1">
          <div class="panel-head">
            <span>Alternatives<v-chip x-small outlined class="ml-2">{{ alternatives.length }} of {{ maxAlternatives }}</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="!designedAlternatives.length" class="text--secondary" data-designer="no-drafts">No design is made here yet. Seed one from the baseline or start from a blank design.</div>
            <div v-for="entry in designedAlternatives" :key="entry.key" class="missile-designer-page__draft">
              <missile-draft-editor :draft="entry" :errors="draftErrors[entry.key] || {}" :blocked="draftBlocked[entry.key] || []" @input="(draft) => updateAlternative(entry.key, draft)" @remove="removeAlternative" />
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            Each editor holds the counts and sizes of the parts as typed, the options switched on and the tech the design uses. Text that is not a figure stays on its field with its error, and no number replaces it. An option that needs a tech line with no level is not applied: it is marked with its reason beside the option and on the column, and no figure of that column is shown, because any figure would be that of a missile without the option. A second stage, a ship decoy, a ground pod and an enhanced radiation warhead are carried from a seeded design and not built.
          </div>
        </v-card>

        <v-card class="panel" data-summary="A bounded search of the engine, fuel, warhead and option sizes of a missile for one goal." data-designer="optimiser" elevation="1">
          <div class="panel-head">
            <span>Missile optimiser<v-chip v-if="optimiserIncomplete" x-small color="warning" outlined class="ml-2" data-search="incomplete-chip">Incomplete</v-chip><v-chip v-if="optimiserHypothetical" x-small color="warning" outlined class="ml-2" data-tech="optimiser-hypothetical">Hypothetical tech</v-chip></span>
            <span class="d-flex align-center flex-wrap">
              <v-btn small text :disabled="!optimiserOutcome" aria-label="Copy the optimisation result as text" data-action="optimiser-copy" @click="copyOptimised"><v-icon small left>mdi-content-copy</v-icon>Copy</v-btn>
              <v-btn small text :disabled="!optimiserOutcome" aria-label="Download the optimisation result as CSV" data-action="optimiser-csv" @click="downloadOptimised"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
            </span>
          </div>
          <div class="panel-body">
            <missile-optimiser :fields="optimiserFieldsRead" :errors="optimiserErrors" :goals="optimiserGoals" :goal-text="optimiserGoalText" :axes="optimiserAxes" :options="optimiserOptions" @field="setOptimiserField" @axis="setOptimiserAxis" />
            <div class="toolbar mt-3">
              <div class="tool tool--actions">
                <div class="tool__buttons">
                  <v-btn outlined color="primary" :disabled="!optimiserRequest.ok || optimiserRunning" aria-label="Run the optimisation" data-action="optimiser-run" @click="runOptimiser"><v-icon small left>mdi-magnify</v-icon>Optimise</v-btn>
                  <v-btn outlined :disabled="!optimiserRunning" aria-label="Stop the optimisation and keep the best so far" data-action="optimiser-cancel" @click="cancelOptimiser"><v-icon small left>mdi-stop</v-icon>Cancel</v-btn>
                  <v-btn outlined :disabled="!optimiserBaseDraft" aria-label="Match the baseline with a domain around its own figures" data-action="optimiser-around" @click="searchAroundBaseline"><v-icon small left>mdi-target</v-icon>Match the baseline</v-btn>
                  <v-btn outlined :disabled="!canNominate" aria-label="Set the best candidates beside the baseline as alternatives" data-action="optimiser-nominate" @click="nominateOptimised"><v-icon small left>mdi-plus</v-icon>Nominate the best</v-btn>
                </div>
              </div>
            </div>
            <v-progress-linear v-if="optimiserRunning" :value="optimiserProgress * 100" height="3" class="mt-3" aria-label="Optimising" data-optimiser="progress" />
            <v-alert v-if="optimiserProblems" type="error" outlined dense class="mt-3" data-optimiser="errors">The optimisation does not run: {{ optimiserProblems }}</v-alert>
            <v-alert v-if="optimiserError" type="error" outlined dense class="mt-3" data-optimiser="failed">The optimisation failed: {{ optimiserError }}</v-alert>
            <div v-if="optimiserMessage" class="caption text--secondary mt-2" data-optimiser="message">{{ optimiserMessage }}</div>
            <div v-if="optimiserCopyMessage" class="caption text--secondary mt-2" data-optimiser="copy-message">{{ optimiserCopyMessage }}</div>
            <template v-if="optimiserOutcome">
              <v-alert v-if="optimiserStale && !optimiserRunning" type="info" outlined dense class="mt-3" data-search="stale">The inputs changed after this result was found. Run the optimisation again to refresh it.</v-alert>
              <v-alert v-if="optimiserIncomplete" type="warning" outlined dense class="mt-3" data-search="incomplete">Incomplete search. {{ optimiserStatus }}</v-alert>
              <div v-else class="caption text--secondary mt-2" data-search="outcome">{{ optimiserStatus }}</div>
              <div v-if="optimiserOutcome.result && optimiserOutcome.result.output.omitted > 0" class="caption text--secondary" data-search="omitted">The best {{ count(optimiserOutcome.result.output.listed) }} are listed; {{ count(optimiserOutcome.result.output.omitted) }} more meet the limits.</div>
              <missile-optimiser-results :headers="optimiserHeaders" :rows="optimiserRows" :front="optimiserFront" :empty-text="optimiserEmptyText" class="mt-3" />
            </template>
          </div>
          <div class="panel-foot caption text--secondary">
            The goals are the greatest warhead at a hit chance, the fastest, the longest range, the cheapest per warhead and the match of the baseline. The best are listed beside the efficient front and can be set beside the baseline as alternatives. A run that stops early says so. Every candidate of the domain is held to the size, cost, range and speed limits; the missile is designed with the tech levels above and an option set to both ways is tried with and without. The hit chance is the combat model's, against the target speed, jammer and tactical modifier of the scenario, capped at its greatest; the point-defence figure feeds the planner figure only, a planner figure and not a game statistic. A missile on a second stage or with a decoy warhead has no hit chance, so a goal that needs one finds none. Cheapest per warhead leaves out a missile with no warhead, as its cost per warhead is undefined. The efficient front holds every candidate within the limits that no other beats on all the compared figures, whatever number of results is kept. A run stops at 200,000 candidates or 30 seconds and then says it is incomplete, never as an answer for the whole domain.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The launching ship's missile fire control and search sensor, set beside the missile's own sensor and its range." data-designer="launcher-coverage" elevation="1">
          <div class="panel-head">
            <span>Launcher coverage</span>
          </div>
          <div class="panel-body">
            <launcher-coverage :sensors="launcherSensorRows" :selection="launcherSelection" :items="launcherItems" :missiles="launcherMissileRows" :jammer="launcherJammer" :jammer-problem="launcherJammerProblem" @sensor="setLauncherSensor" @jammer="setLauncherJammer" />
          </div>
          <div class="panel-foot caption text--secondary">
            Each sensor is a saved one of the race or typed figures, and the coverage of the target comes from the same detection rule as the Sensor Planner. A figure that is missing is unknown and never 0. A sensor reaches a target at its maximum range, cut by the square of the target's signature over the sensor's resolution when the target is under it, and by 0.75 for each point the target's sensor jammer is above the sensor's ECCM. The target signature is that of the scenario above. The sensor jammer is its own figure, a blank one meaning none, and is not the missile jammer of the hit chance, which does not cut a sensor's range. A saved sensor that is not in this save has no figures: its coverage is unknown and the typed figures are not used in its place. The missile's own sensor and the launching ship's are never added: a fire control that reaches the whole range of a missile can guide it with no sensor of its own, and a missile whose own sensor reaches less than the shot is guided from the ship.
          </div>
        </v-card>

        <v-card class="panel" data-summary="The smallest search sensor and missile fire control that see the target of the scenario at the missile's range." data-designer="sensor-sizing" elevation="1">
          <div class="panel-head">
            <span>Sensor sizing for the target<page-link :to="linkTo.sensors({ mode: 'active' })" name="Active mode" class="ml-1" /></span>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Wanted range</div>
                <v-text-field v-model="embedRange" suffix="km" :placeholder="embedBaselineRange === null ? 'Unknown' : count(embedBaselineRange)" aria-label="Range the sensor must reach in km, the baseline missile's range when blank" dense outlined hide-details data-field="sensor-range" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Target sensor jammer</div>
                <v-text-field v-model="embedJammer" :placeholder="String(launcherJammer)" aria-label="Sensor jammer of the target, the launcher card's figure when blank" dense outlined hide-details data-field="sensor-jammer" />
              </div>
              <div class="tool tool--number">
                <div class="tool__label caption text--secondary">Resolution</div>
                <v-select v-model="embedResolution" :items="embedResolutionItems" item-text="text" item-value="value" aria-label="Resolution of the sensor, or the best" dense outlined hide-details data-field="sensor-resolution" />
              </div>
            </div>
            <div class="caption text--secondary mt-2" data-designer="sensor-tech">Tech in effect: {{ embedTechText }}.</div>
            <div v-if="embedTech.assumptions.length" class="caption warning--text" data-designer="sensor-hypothetical">Hypothetical tech is in use: {{ embedTech.assumptions.join('; ') }}.</div>
            <div class="mt-3">
              <active-sizing-panel :scenarios="embedScenarios" />
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            Sizes come from the race's tech at each legal resolution. The range and the jammer start from the baseline and the launcher card and can be changed here without changing them there, and the tech levels in effect are those chosen above. The target is the signature typed in the scenario above, and the wanted range starts at the range of the pinned baseline missile; a blank range or signature leaves the sizing unknown, never 0. Each row sizes the search sensor and the missile fire control at one resolution, from the sensor tech levels the Tech menu above holds. The jammer is the target's sensor jammer, not the missile jammer of the hit chance. The Sensor Planner shows the same sizing with the target by size or class, the saved pair and the hardening and ECCM levels.
          </div>
        </v-card>

        <v-card class="panel" data-summary="Comparisons kept in the scenario records of the race on this branch." data-designer="records" elevation="1">
          <div class="panel-head">
            <span>Saved comparisons<v-chip v-if="recordsRead.entries.length" x-small outlined class="ml-2">{{ recordsRead.entries.length }}</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="recordNotice" class="caption warning--text mb-2" data-designer="record-notice">{{ recordNotice }}</div>
            <div class="toolbar">
              <div class="tool tool--name">
                <div class="tool__label caption text--secondary">Name of this comparison</div>
                <v-text-field v-model="recordName" aria-label="Name of the comparison to keep" :error-messages="recordNameError" dense outlined hide-details="auto" data-field="record-name" @blur="recordTouched = true" />
              </div>
              <div class="tool tool--actions">
                <div class="tool__buttons">
                  <v-btn outlined :disabled="!canSaveRecord" aria-label="Save the comparison" data-action="record-save" @click="saveRecord(false)"><v-icon small left>mdi-content-save-outline</v-icon>{{ recordOrigin ? 'Save' : 'Save new' }}</v-btn>
                  <v-btn v-if="recordOrigin" outlined :disabled="!canSaveRecord" aria-label="Save as a new comparison" data-action="record-save-new" @click="saveRecordAsNew"><v-icon small left>mdi-content-save-plus-outline</v-icon>Save as new</v-btn>
                  <v-btn v-if="recordOrigin" outlined aria-label="Start a new comparison" data-action="record-new" @click="newRecord"><v-icon small left>mdi-file-outline</v-icon>New</v-btn>
                </div>
              </div>
            </div>
            <v-alert v-if="recordConflict" type="warning" outlined dense class="mt-2" data-designer="record-conflict">The comparison {{ recordConflict.name }} was changed elsewhere since it was opened. <v-btn x-small text class="ml-1" data-action="record-overwrite" @click="saveRecord(true)">Write over it</v-btn></v-alert>
            <div v-if="!recordsRead.entries.length" class="caption text--secondary mt-3" data-designer="no-records">No comparison is kept for this race on this branch.</div>
            <v-list v-else dense class="mt-2">
              <v-list-item v-for="entry in recordsRead.entries" :key="entry.uuid" :class="{ 'is-selected-row': entry.uuid === recordOrigin }" :data-record="entry.uuid">
                <v-list-item-content>
                  <v-list-item-title>{{ entry.name }}<v-chip v-if="entry.ahead" x-small color="warning" outlined class="ml-2" data-record="ahead">Saved at a later game time</v-chip><v-chip v-if="missingLinks(entry).length" x-small color="warning" outlined class="ml-2" data-record="links">{{ missingLinks(entry).length }} saved {{ missingLinks(entry).length === 1 ? 'design' : 'designs' }} changed or gone</v-chip></v-list-item-title>
                  <v-list-item-subtitle>{{ recordSummary(entry) }}</v-list-item-subtitle>
                </v-list-item-content>
                <v-list-item-action class="flex-row">
                  <v-btn v-if="entry.ahead" small text aria-label="Move the comparison to this save" data-action="record-move" @click="moveRecord(entry.uuid)">Move to this save</v-btn>
                  <v-btn v-else small text aria-label="Open the comparison" data-action="record-open" @click="openRecord(entry.uuid)">Open</v-btn>
                  <v-btn small text color="error" aria-label="Delete the comparison" data-action="record-delete" @click="deleteRecord(entry.uuid)">Delete</v-btn>
                </v-list-item-action>
              </v-list-item>
            </v-list>
          </div>
          <div class="panel-foot caption text--secondary">
            A comparison holds the baseline, the alternatives as typed, the scenario and the tech levels chosen, never a figure of the save. One made at a later game time is listed and not applied until moved to this save. A comparison keeps its inputs as text and the tech levels chosen on this page, by tech ID and name (never a figure), and works every figure out again from the save when it is opened. A level that is no longer a level the race has, or whose tech changed, reads as unresolved and named, and the line designs with the game's pick. It is kept on this branch of the campaign; a saved missile it names that changed or is gone is flagged and never re-pointed. Nothing is written into the Aurora save.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import LauncherCoverage from '../components/missiles/LauncherCoverage.vue'
import MissileCompareTable from '../components/missiles/MissileCompareTable.vue'
import MissileDraftEditor from '../components/missiles/MissileDraftEditor.vue'
import MissileOptimiser from '../components/missiles/MissileOptimiser.vue'
import MissileOptimiserResults from '../components/missiles/MissileOptimiserResults.vue'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ActiveSizingPanel from '../components/sensors/ActiveSizingPanel.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView from '../mixins/persisted-view'
import { loadFormulaVersion } from '../utilities/capabilities'
import { cutText, linkTo, queryId } from '../utilities/deep-links'
import { loadSensorFixture, SENSOR_COMPONENT_TYPES } from '../utilities/design-data'
import { SENSOR_RESOLUTIONS_HS, SENSOR_RULES } from '../utilities/design-rules'
import { LAUNCH_ROLES, emptySelection, launcherView, normaliseSelection, sensorOfSelection } from '../utilities/launcher-coverage'
import { tracked } from '../utilities/load-tracking'
import { DESIGN_LINES, DESIGN_LINE_TYPES, LINE_LABELS, MAX_ALTERNATIVES, NO_DESIGNS, addAlternative, carryOf, compareDesigns, deleteDesign, designerContext, emptyDraft, loadDesigns, moveDesign, payloadOf, pdProblem, problemsOf, readDesigns, registerDesigner, removeAlternative, saveDesign, savedAlternative, savedChoices, scenarioOf, seedAlternative, summaryText, techChoicesOf, techFigures, techLinksOf } from '../utilities/missile-designer'
import { entered } from '../utilities/missile-hit'
import { AXIS_ORDER, COLUMNS, GOALS, GOAL_IDS, OPTION_LABELS, SWEEP_AXES, describeMissileFront, describeStatus, domainAround, exportOutcome, frontTable, missileRun, nominations, normaliseFields, readRequest, referenceOfColumn, stageOfDraft, tableOf, techNotesOf } from '../utilities/missile-optimizer'
import { STANDING, beginRead, isCurrentRead, loadMissileStanding, missileHandoff, missileLinkState } from '../utilities/planner-links'
import { STATUS, envelope, unavailable } from '../utilities/provenance'
import { RESPONSIVENESS, TERMINATION, createRunSlot } from '../utilities/search-run'
import { activeSizing, sensorTechOf } from '../utilities/sensor-planner'
import { NO_TECH_CHOICES, candidateText, loadTechChoices, readScenario, registerTechScenarios, resolveChoices, saveChoice, scopeOf, selectionOf } from '../utilities/tech-scenarios'

const INPUT_LABELS = {
  tech: 'the race\'s tech lines, researched levels and research graph',
  designs: 'the missile designs the race has researched and owns',
  sensors: 'the missile fire controls and active sensors the race has researched',
  formulaVersion: 'the save\'s schema',
}

// The tech lines the page lists, with the label of each.
const TECH_LINES = Object.entries(DESIGN_LINES).map(([name, type]) => ({ type, label: LINE_LABELS[name] }))

const text = (value) => typeof value === 'string'

const NO_SENSORS = Object.freeze({ components: Object.freeze([]) })

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// How many decimals each figure of the optimiser's tables is written with.
const OPTIMISER_DECIMALS = { engineMsp: 3, thrust: 3, fuelMsp: 3, warheadMsp: 3, size: 2, damage: 2, hitChance: 1, cost: 2, costPerWarhead: 2, deviation: 1, planner: 2 }

// How many members of the efficient front the table lists: a front can hold thousands, and the caption states how many there are.
const FRONT_ROWS = 25

// A new task as soon as the browser has had its turn, which still comes in a hidden window.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(null)
})

// The alternatives as the page keeps them: every entry the record adapter accepts, at most three.
const validAlternatives = (value) => Array.isArray(value) && problemsOf({ name: 'x', baselineId: null, alternatives: value, scenario: scenarioOf({}), tech: { choices: {} } }).length === 0

// A page for the missile designer: the researched missiles of the race and the missiles it could design, side by side under one scenario (utilities/missile-designer.js).
export default {
  name: 'MissileDesignerPage',
  components: { ActiveSizingPanel, LauncherCoverage, LoadState, MissileCompareTable, MissileDraftEditor, MissileOptimiser, MissileOptimiserResults, PageLink },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      baselineId: { key: 'missileDesignerBaseline', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      alternatives: { key: 'missileDesignerAlternatives', default: [], scope: 'race', valid: validAlternatives },
      techChoice: { key: 'missileDesignerTech', default: {}, scope: 'race', valid: (value) => value && typeof value === 'object' && !Array.isArray(value) },
      hitTargetSpeed: { key: 'missileHitTargetSpeed', default: '10000', valid: text },
      hitJammer: { key: 'missileHitJammer', default: '0', valid: text },
      hitModifier: { key: 'missileHitModifier', default: '1', valid: text },
      pd: { key: 'missileDesignerPd', default: '0', valid: text },
      targetSignature: { key: 'missileDesignerTargetSignature', default: '', valid: text },
      optimiserFields: { key: 'missileOptimiserFields', default: normaliseFields(null), valid: isObject },
      launcherSensors: { key: 'missileLauncherSensors', default: emptySelection(), scope: 'race', valid: isObject },
      launcherJammer: { key: 'missileLauncherJammer', default: '0', valid: text },
    }),
  ],
  data() {
    return {
      maxAlternatives: MAX_ALTERNATIVES,
      linkTo,
      embedResolutionItems: Object.freeze([{ text: 'Best', value: 'best' }, ...SENSOR_RESOLUTIONS_HS.map((value) => ({ text: `${value} HS`, value: String(value) }))]),
      // The sensor sizing panel's own figures: blank means the prefill from the scenario, the baseline and the launcher card.
      embedRange: '',
      embedJammer: '',
      embedResolution: 'best',
      // The hypothetical choices that could not be written to the scenario record, by tech type: they hold for this page only.
      heldChoices: {},
      // The saved missile a link names (its ID, the text of the link when it is not an ID, and the name the link gave it) and what the save says of it: null until read, and while no link names one.
      linkedMissileId: null,
      linkedMissileRaw: '',
      linkedMissileName: '',
      linkedStanding: null,
      scenarioMessage: '',
      scenarioRevision: 0,
      alternativeMessage: '',
      copyMessage: '',
      // The comparison kept in the records that is open: its uuid, the revision and payload it was opened at, the name being typed, and why the last write failed.
      recordOrigin: null,
      recordBaseline: null,
      recordName: '',
      recordTouched: false,
      recordMessage: '',
      recordConflict: null,
      recordRevision: 0,
      // The links of the comparison as they were read or last written (`carryOf`), kept through a save so that a saved design or a tech that changed, or that was kept with no link, is not accepted by a save; a choice made on the page leaves it.
      linkCarry: [],
      // The optimiser: the outcome of the last run that was kept (frozen, with its descriptor), whether a run is going and how far, and what is to be said beside it.
      optimiserOutcome: null,
      optimiserRunning: false,
      optimiserProgress: 0,
      optimiserError: '',
      optimiserMessage: '',
      optimiserCopyMessage: '',
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID', 'GameTime']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    // The campaign and branch of the open save once settled, and the scope of its scenario records: null until both are known.
    scope() {
      return scopeOf({ campaign: this.$store.getters['history/campaign'], RaceID: this.RaceID, gameTime: this.GameTime })
    },

    // The tech scenario record of the race on the branch as the open save reads it (see readScenario).
    techScenario() {
      return { ...readScenario(this.records ? this.records.repository : null, this.scope, this.tech), revision: this.scenarioRevision }
    },

    // The hypothetical choices as the lines resolve them: the record's, then the ones that could only be kept for this page.
    scenarioSelection() {
      const selection = { ...this.techScenario.selection }

      Object.entries(this.heldChoices).forEach(([type, choice]) => {
        if (choice) {
          selection[type] = { source: 'scenario', ...choice }
        } else {
          delete selection[type]
        }
      })

      return selection
    },

    // ---------- the sensor sizing for the target ----------

    embedTech() {
      return sensorTechOf(this.tech, this.techResolution)
    },

    // The tech lines the sizing reads, with the level each is at.
    embedTechText() {
      return ['strength', 'em', 'eccm', 'hardening'].map((role) => `${this.embedTech[role].label} ${this.embedTech[role].level ? this.embedTech[role].level.name : 'not researched'}`).join('; ')
    },

    // The range the pinned baseline missile flies, which the sizing wants to reach until a range is typed in the panel.
    embedBaselineRange() {
      const baseline = this.optimiserBaseline

      return baseline && Number.isFinite(baseline.figures.maxRange.value) ? baseline.figures.maxRange.value : null
    },

    // The target of the scenario: its typed signature, taken as given and assumed; unavailable while blank or not above 0.
    embedTarget() {
      const typed = entered(this.targetSignature)
      const signature = typed !== null && typed > 0 ? envelope({ value: typed, status: STATUS.ASSUMED, rule: SENSOR_RULES.detection, units: 'HS', inputs: { present: ['the target signature'] }, assumptions: ['the target signature is typed in the scenario above, not read from the save'] }) : unavailable({ rule: SENSOR_RULES.detection, missing: ['the target signature in HS, typed in the scenario above'], units: 'HS' })

      return { signature }
    },

    embedSizing() {
      const wanted = String(this.embedRange).trim() === '' ? this.embedBaselineRange : this.embedRange
      const jammer = String(this.embedJammer).trim() === '' ? this.launcherJammer : this.embedJammer

      return activeSizing({ target: this.embedTarget, wantedRangeKm: wanted, resolution: this.embedResolution, jammer, tech: this.embedTech })
    },

    embedScenarios() {
      return [{ key: 'effective', label: 'Target signature', sizing: this.embedSizing }]
    },

    // The choices of the lines as the page holds them: the researched levels it remembers and the hypothetical ones.
    techSelection() {
      return selectionOf(this.techChoice, this.scenarioSelection)
    },

    // Each tech line's choice resolved against the open save.
    techResolution() {
      return resolveChoices(this.tech, this.techSelection)
    },

    techChoiceCount() {
      return TECH_LINES.filter(({ type }) => this.techResolution[type] && this.techResolution[type].level && this.techResolution[type].level !== this.tech.lines[type].pick).length
    },

    techLines() {
      return TECH_LINES.map(({ type, label }) => {
        const line = this.tech.lines[type]
        const resolved = this.techResolution[type]
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
          items: line.levels.map((level) => ({ value: level.id, text: `${level.info} · ${level.name}${level === line.pick ? ' · the game\'s pick' : ''}` })),
          candidates: line.candidates.map((item) => ({ value: item.id, text: `${item.info} · ${item.name} · ${candidateText(item, format)}` })),
        }
      })
    },

    unresolvedChoices() {
      return this.techLines.filter((line) => line.unresolved).map((line) => ({ type: line.type, text: line.unresolvedText }))
    },

    // Why a record's choices are not all applied or kept: a write that failed, a file that cannot be read or made at another game time or by another version.
    scenarioNotice() {
      const parts = [this.scenarioMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so the choice is kept for this page only.` : '', this.techScenario.error ? `The scenario records cannot be read (${this.techScenario.error.message}), so saved choices are not applied.` : '', ...this.techScenario.notes.map((note) => note.reason)]

      return parts.filter(Boolean).join(' ')
    },

    // The saved design a link names, once the designs are read: only a design of the race that is the one the link meant (a link from another page names it too) is pinned.
    linkedChoice() {
      if (this.linkedMissileId === null) {
        return null
      }

      const choice = savedChoices(this.designs).find((item) => item.id === this.linkedMissileId) || null

      return choice && (!this.linkedMissileName || choice.name === this.linkedMissileName) ? choice : null
    },

    // Why a link's missile is not the baseline, or an empty text: an ID that is not one, a missile that is gone, another race's, not researched or changed, or a design of the race that the designer does not list.
    linkNotice() {
      if (this.linkedMissileRaw !== '' && this.linkedMissileId === null) {
        return `The link names the missile "${cutText(this.linkedMissileRaw)}", which is not a missile ID (a whole number above 0). The baseline is as it was.`
      } else if (this.linkedMissileId === null || this.linkedChoice || !this.ready) {
        return ''
      }

      const listed = savedChoices(this.designs).find((item) => item.id === this.linkedMissileId)
      const standing = listed ? { id: listed.id, state: STANDING.HELD, name: listed.name, text: '' } : this.linkedStanding

      if (!standing) {
        return `The missile ${this.linkedMissileId} named by the link is being checked against the save.`
      }

      const state = missileLinkState({ standing, name: this.linkedMissileName })

      return `${state.state === STANDING.HELD ? `The missile ${state.id} (${state.name}) is a design of the race that the designer does not list: a second stage of another design is not offered on its own.` : state.text} The baseline is as it was.`
    },

    // The Designed Tech page's row of the baseline, and the baseline's name for the link's title.
    baselineLink() {
      return this.baselineId !== null && savedChoices(this.designs).some((item) => item.id === this.baselineId) ? linkTo.designedTech({ missile: this.baselineId }) : null
    },

    baselineName() {
      const choice = savedChoices(this.designs).find((item) => item.id === this.baselineId)

      return choice ? choice.name : ''
    },

    // The target signature, resolution and jammer the designer assumed, as the missile handover passes them: what the sizing panel starts from.
    handoffScenario() {
      const jammer = String(this.embedJammer).trim() === '' ? this.launcherJammer : this.embedJammer

      return { signature: entered(this.targetSignature), resolution: this.embedResolution === 'best' ? 'best' : entered(this.embedResolution), jammer: String(jammer).trim() === '' ? 0 : entered(jammer) }
    },

    // The links of each column: the missile handed to the Sensor Planner (or why it cannot be) and, for a saved design, its row in Designed Tech.
    columnLinks() {
      return Object.fromEntries(this.comparison.columns.map((column) => {
        const handoff = missileHandoff(column, this.handoffScenario)

        return [column.key, { sensors: handoff.ok ? linkTo.sensors({ target: handoff.target }) : null, reason: handoff.ok ? '' : handoff.reason, designedTech: column.kind === 'saved' && column.savedId ? linkTo.designedTech({ missile: column.savedId }) : null }]
      }))
    },

    // A link names the saved missile the page is on: the baseline. The incoming link is consumed once it settles, so a baseline picked or opened afterwards is the one named.
    linkQuery() {
      return this.ready ? linkTo.missileDesigner({ missile: this.linkedChoice ? this.linkedChoice.id : this.baselineId }).query : null
    },

    linkLabel() {
      return this.baselineName
    },

    savedItems() {
      return savedChoices(this.designs).map((choice) => ({ text: `${choice.name}${choice.obsolete ? ' (obsolete)' : ''} · ${this.count(choice.size, 2)} MSP`, value: choice.id }))
    },

    canSeed() {
      return this.baselineId !== null && Boolean(this.designs.fixture)
    },

    // The scenario as the designer takes it: the texts as typed.
    scenarioInput() {
      return { targetSpeed: this.hitTargetSpeed, jammer: this.hitJammer, modifier: this.hitModifier, pd: this.pd, targetSignature: this.targetSignature }
    },

    scenarioErrors() {
      const check = (value, label) => (entered(value) === null || entered(value) < 0 ? `${label}: enter a number of 0 or more` : '')

      return { targetSpeed: check(this.hitTargetSpeed, 'Target speed'), jammer: check(this.hitJammer, 'Jammer'), modifier: check(this.hitModifier, 'Modifier'), targetSignature: String(this.targetSignature).trim() === '' ? '' : check(this.targetSignature, 'Target signature') }
    },

    pdError() {
      return pdProblem(this.pd)
    },

    designerContext() {
      return designerContext({ fixture: this.designs.fixture, resolution: this.techResolution, version: this.formulaVersion, obsolete: this.designs.obsolete })
    },

    comparison() {
      return compareDesigns(this.designerContext, { baselineId: this.baselineId, alternatives: this.alternatives, scenario: this.scenarioInput })
    },

    summary() {
      return summaryText(this.comparison, this.scenarioInput)
    },

    designedAlternatives() {
      return this.alternatives.filter((entry) => entry.kind === 'designed')
    },

    // The field errors of each designed alternative, by key.
    draftErrors() {
      return Object.fromEntries(this.comparison.columns.filter((column) => column.kind === 'designed').map((column) => [column.key, column.errors]))
    },

    // The options asked for and not applied of each designed alternative, by key.
    draftBlocked() {
      return Object.fromEntries(this.comparison.columns.filter((column) => column.kind === 'designed').map((column) => [column.key, column.blocked]))
    },

    // The hypothetical tech the designed columns rest on, once each.
    hypotheticalNotice() {
      const assumptions = [...new Set(this.comparison.columns.flatMap((column) => column.hypothetical))]

      return assumptions.length ? `Hypothetical results: ${assumptions.join('; ')}. Each figure built on it is marked assumed.` : ''
    },

    recordsRead() {
      return { ...readDesigns(this.records ? this.records.repository : null, this.scope, this.designs, this.tech), revision: this.recordRevision }
    },

    recordPayload() {
      return payloadOf({ name: this.recordName, baselineId: this.baselineId, alternatives: this.alternatives, scenario: this.scenarioInput, tech: techChoicesOf(this.techSelection, this.tech) })
    },

    recordProblems() {
      return problemsOf(this.recordPayload)
    },

    recordNameError() {
      return this.recordTouched && !this.recordName.trim() ? 'Name the comparison to keep it' : ''
    },

    canSaveRecord() {
      return this.recordProblems.length === 0 && Boolean(this.records && this.records.repository) && Boolean(this.scope)
    },

    // The open comparison at the revision it was opened or last written at, so that a change made elsewhere since is refused as stale.
    recordEntry() {
      return this.recordOrigin ? this.recordBaseline : null
    },

    recordNotice() {
      const parts = [this.recordMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so a comparison cannot be kept.` : '', this.recordsRead.error ? `The comparisons cannot be read (${this.recordsRead.error.message}).` : '', ...this.recordsRead.notes.map((note) => note.reason)]

      return parts.filter(Boolean).join(' ')
    },

    optimiserFieldsRead() {
      return normaliseFields(this.optimiserFields)
    },

    optimiserGoals() {
      return GOAL_IDS.map((id) => ({ id, label: GOALS[id].label }))
    },

    optimiserGoalText() {
      const goal = GOALS[this.optimiserFieldsRead.goal]

      return `${goal.objective} ${goal.ties}`
    },

    optimiserAxes() {
      return AXIS_ORDER.map((name) => ({ name, label: SWEEP_AXES[name].label, unit: SWEEP_AXES[name].unit }))
    },

    optimiserOptions() {
      return Object.entries(OPTION_LABELS).map(([name, label]) => ({ name, label }))
    },

    // The tech lines the page designs with, as the figures the optimiser reads.
    optimiserTech() {
      return techFigures(this.designerContext.levels)
    },

    // The baseline's column when a saved missile is pinned, whose figures a match is taken from.
    optimiserBaseline() {
      const column = this.comparison.columns[0]

      return column && column.role === 'baseline' ? column : null
    },

    // The draft the baseline is seeded as: its sensors, decoys and what it carries stay as they are in every candidate.
    optimiserBaseDraft() {
      if (this.baselineId === null) {
        return null
      }

      const seeded = seedAlternative(this.designerContext, this.baselineId)

      return seeded.ok ? seeded.draft : null
    },

    optimiserRequest() {
      return readRequest({ fields: this.optimiserFieldsRead, scenario: this.scenarioInput, tech: this.optimiserTech, reference: this.optimiserBaseline ? referenceOfColumn(this.optimiserBaseline) : null, baseDraft: this.optimiserBaseDraft, stage: stageOfDraft(this.designs.fixture, this.optimiserBaseDraft), version: this.formulaVersion, techNotes: techNotesOf(this.techResolution, { fields: this.optimiserFieldsRead, baseDraft: this.optimiserBaseDraft }) })
    },

    optimiserErrors() {
      return this.optimiserRequest.errors
    },

    optimiserProblems() {
      return Object.values(this.optimiserRequest.errors).join('; ')
    },

    // What the request stands for, as text: a run that was made for another is out of date.
    optimiserRequestKey() {
      return this.optimiserRequest.ok ? JSON.stringify(this.optimiserRequest.input) : ''
    },

    optimiserStale() {
      return Boolean(this.optimiserOutcome) && JSON.stringify(this.optimiserOutcome.descriptor.input) !== this.optimiserRequestKey
    },

    // Whether the result shown is not the whole answer: a run that was cancelled, replaced or stopped at its budget.
    optimiserIncomplete() {
      return Boolean(this.optimiserOutcome) && this.optimiserOutcome.incomplete && !this.optimiserRunning
    },

    optimiserHypothetical() {
      return this.techLines.some((line) => line.hypothetical)
    },

    optimiserStatus() {
      return this.optimiserOutcome ? describeStatus(this.optimiserOutcome, this.figureText) : ''
    },

    optimiserExport() {
      return this.optimiserOutcome ? exportOutcome(this.optimiserOutcome, this.figureText) : null
    },

    optimiserTable() {
      return this.optimiserOutcome ? tableOf(this.optimiserOutcome) : null
    },

    optimiserHeaders() {
      return this.optimiserTable ? this.optimiserTable.header : []
    },

    optimiserRows() {
      if (!this.optimiserTable) {
        return []
      }

      return this.optimiserTable.rows.map((row) => ({ key: row.entry.id, cells: COLUMNS.map((column) => this.cellOf(column.id, row.cells[column.id], row.results[column.id] || null)) }))
    },

    optimiserFront() {
      const result = this.optimiserOutcome ? this.optimiserOutcome.result : null

      if (!result) {
        return { caption: '', headers: [], rows: [], omitted: 0 }
      }

      const table = frontTable(result.front, this.optimiserOutcome.descriptor.input)

      return { caption: describeMissileFront(result.front, this.figureText), headers: table.axes.map((axis) => axis.label), rows: table.rows.slice(0, FRONT_ROWS).map((row) => ({ key: row.id, alike: row.alike, cells: row.cells.map((value, at) => this.cellOf(table.axes[at].key, value, row.results[at])) })), omitted: Math.max(0, table.rows.length - FRONT_ROWS) }
    },

    optimiserEmptyText() {
      return this.optimiserIncomplete ? 'None found so far.' : 'None meets the limits.'
    },

    // Whether the result can be set beside the baseline: it was made for the inputs now on the page and lists a candidate.
    canNominate() {
      const result = this.optimiserOutcome ? this.optimiserOutcome.result : null

      return Boolean(result) && result.entries.length > 0 && !this.optimiserStale && !this.optimiserRunning && this.alternatives.length < MAX_ALTERNATIVES
    },

    // The saved sensors of the race that can guide a missile from the ship: its missile fire controls and its active sensors.
    launcherItems() {
      const of = (type) => this.sensors.components.filter((component) => component.row.ComponentTypeID === type).map((component) => ({ text: `${component.row.Name} · ${this.count(component.row.MaxSensorRange)} km`, value: component.id }))
      const items = { [LAUNCH_ROLES.missileFireControl]: of(SENSOR_COMPONENT_TYPES.missileFireControl), [LAUNCH_ROLES.search]: of(SENSOR_COMPONENT_TYPES.active) }

      for (const [role, list] of Object.entries(items)) {
        const id = this.launcherSelection[role].id

        if (id !== null && !list.some((item) => item.value === id)) {
          list.push({ text: `Saved sensor ${id} · not in this save`, value: id })
        }
      }

      return items
    },

    // Why the target's sensor jammer is not a figure, or an empty text: a blank one is none, and a text that is not a number of 0 or more leaves the coverage unknown.
    launcherJammerProblem() {
      const blank = String(this.launcherJammer).trim() === ''
      const jammer = blank ? 0 : entered(this.launcherJammer)

      return jammer === null || jammer < 0 ? 'Enter a number of 0 or more, or leave it blank for none' : ''
    },

    launcherSelection() {
      return normaliseSelection(this.launcherSensors)
    },

    // The missiles whose reach and range the launching ship's sensors are set beside: the baseline as saved and the best of the optimisation that is not out of date.
    launcherMissiles() {
      const rows = []
      const baseline = this.optimiserBaseline

      if (baseline) {
        rows.push({ label: `Baseline: ${baseline.name}`, ownReachKm: baseline.figures.reach.value, ownReachReason: baseline.figures.reach.reason || '', flightRangeKm: baseline.figures.maxRange.value, flightRangeReason: baseline.figures.maxRange.reason || '' })
      }

      const result = this.optimiserOutcome && !this.optimiserStale ? this.optimiserOutcome.result : null

      if (result && result.best) {
        rows.push({ label: `Best of the optimisation: ${result.best.id}`, ownReachKm: result.sensor.reachKm, ownReachReason: result.sensor.reachReason, flightRangeKm: result.best.figures.maxRange, flightRangeReason: '' })
      }

      return rows
    },

    launcherView() {
      const selection = this.launcherSelection
      const components = this.sensors.components
      const signature = String(this.targetSignature).trim() === '' ? null : entered(this.targetSignature)
      const jammer = String(this.launcherJammer).trim() === '' ? 0 : entered(this.launcherJammer)
      const missing = this.launcherJammerProblem ? [`the target's sensor jammer: ${this.launcherJammerProblem.toLowerCase()}`] : []

      return launcherView({ mfc: sensorOfSelection(selection[LAUNCH_ROLES.missileFireControl], components, LAUNCH_ROLES.missileFireControl), search: sensorOfSelection(selection[LAUNCH_ROLES.search], components, LAUNCH_ROLES.search), target: { signature, jammer, missing }, missiles: this.launcherMissiles, format: this.figureText })
    },

    launcherSensorRows() {
      return this.launcherView.sensors
    },

    launcherMissileRows() {
      return this.launcherView.missiles
    },
  },
  watch: {
    // A saved missile a link names is pinned once the designs are read.
    linkedChoice() {
      this.settleLink()
    },

    linkedMissileId() {
      this.readLinkStanding()
    },

    database() {
      this.readLinkStanding()
    },

    // An input that changes while a run goes ends it; the result already kept stays and is marked out of date.
    optimiserRequestKey() {
      if (this.optimiserRunning) {
        this.stopOptimiser(TERMINATION.INPUT_CHANGED)
      }
    },

    // Another save, or another race of it, has no use for a result made from the last.
    context() {
      this.stopOptimiser(TERMINATION.SAVE_CHANGED)
      this.optimiserOutcome = null
      this.optimiserMessage = ''
      this.readLinkStanding()
    },
  },
  beforeDestroy() {
    this.stopOptimiser(TERMINATION.CLOSED)
  },
  methods: {
    setBaseline(id) {
      this.baselineId = id === undefined || id === null ? null : id
      this.releaseLink('missile', this.baselineId)
      this.dismissLink()
    },

    // The missile and name of a link, as the query gives them: the saved missile a link names becomes the baseline once it is known to be one the race holds (settleLink), and anything else it names is told in the notice. The link is applied when the route changes under the open page (Back, Forward, a link), so a query that names no missile is a step to no baseline.
    applyLink(query) {
      const first = (value) => (Array.isArray(value) ? value[0] : value)
      const raw = first(query.missile) === undefined ? '' : String(first(query.missile))

      if (raw === '') {
        this.baselineId = null
      }

      this.linkedMissileRaw = raw
      this.linkedMissileId = queryId(query.missile)
      this.linkedMissileName = this.linkedMissileId === null || first(query.name) === undefined ? '' : String(first(query.name))
      this.settleLink()
    },

    // Pins the saved design the link names when it is one the race holds, the one the link meant, and consumes the link: from then on the baseline is the focus.
    settleLink() {
      const choice = this.linkedChoice

      if (!choice) {
        return
      }

      if (this.baselineId !== choice.id) {
        this.baselineId = choice.id
        this.releaseLink('missile', choice.id)
      }

      this.dismissLink()
    },

    // What the save says of the missile a link names that is not a design the race holds: the latest read only counts.
    async readLinkStanding() {
      const id = this.linkedMissileId
      const stamp = beginRead(this, 'link')

      this.linkedStanding = null

      if (id === null || !this.database || !this.GameID || !this.RaceID) {
        return
      }

      const standing = await loadMissileStanding(this.database, this.context, id)

      if (isCurrentRead(this, stamp) && id === this.linkedMissileId) {
        this.linkedStanding = standing
      }
    },

    // The link's notice is given up, with the missile it named.
    dismissLink() {
      this.linkedMissileId = null
      this.linkedMissileRaw = ''
      this.linkedMissileName = ''
    },

    // A link of the comparison that was read is given up when the choice it names is made again on the page, so that the next save links it to the open save.
    releaseLink(type, id) {
      this.linkCarry = this.linkCarry.filter((link) => !(link.type === type && link.id === id))
    },

    // Adds an alternative, or says why it cannot be.
    pushAlternative(entry) {
      const outcome = addAlternative(this.alternatives, entry)

      if (outcome.ok) {
        this.alternatives = outcome.list
        this.alternativeMessage = ''
      } else {
        this.alternativeMessage = outcome.reason
      }
    },

    seedFromBaseline() {
      const seeded = seedAlternative(this.designerContext, this.baselineId)

      if (seeded.ok) {
        this.pushAlternative(seeded.draft)
      } else {
        this.alternativeMessage = seeded.reason
      }
    },

    addSaved(id) {
      const before = this.alternatives.length

      this.pushAlternative(savedAlternative(id))

      if (this.alternatives.length > before) {
        this.releaseLink('missile', id)
      }
    },

    addBlank() {
      this.pushAlternative(emptyDraft(''))
    },

    updateAlternative(key, draft) {
      this.alternatives = this.alternatives.map((entry) => (entry.key === key ? { ...draft, key } : entry))
    },

    removeAlternative(key) {
      this.alternatives = removeAlternative(this.alternatives, key)
      this.alternativeMessage = ''
    },

    async copySummary() {
      try {
        await navigator.clipboard.writeText(this.summary)
        this.copyMessage = 'The comparison is copied as text.'
      } catch (error) {
        this.copyMessage = `The comparison could not be copied (${error && error.message ? error.message : 'the clipboard is not available'}).`
      }
    },

    // A researched level other than the game's pick is remembered; the pick itself is forgotten, so a later research moves it on. A line has one choice: a researched level replaces a hypothetical one.
    setTech(type, id) {
      const choice = { ...this.techChoice }

      if (id === (this.tech.lines[type].pick || {}).id) {
        delete choice[type]
      } else {
        choice[type] = id
        this.releaseLink('tech', id)
      }

      this.techChoice = choice

      return this.dropScenarioChoice(type)
    },

    // A hypothetical next tech of the line, kept in the tech scenario record of the race on the branch; null clears it. When the record cannot be written the choice holds for this page only, and the notice says why.
    async chooseNextTech(type, id) {
      const techId = id === undefined ? null : id

      if (techId === null && !this.techScenario.selection[type] && !this.heldChoices[type]) {
        return
      }

      if (techId !== null) {
        const choice = { ...this.techChoice }

        delete choice[type]
        this.releaseLink('tech', techId)
        this.techChoice = choice
      }

      const outcome = await saveChoice(this.records ? this.records.repository : null, this.scope, this.tech, this.techScenario, { typeId: type, techId })
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

      if (this.techScenario.selection[type]) {
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

    // The saved designs of a comparison that changed or are gone.
    missingLinks(entry) {
      return entry.links.filter((link) => link.status !== 'linked')
    },

    recordSummary(entry) {
      const { payload } = entry
      const designed = payload.alternatives.filter((item) => item.kind === 'designed').length
      const saved = payload.alternatives.length - designed
      const techCount = Object.keys(payload.tech.choices).length

      return `${payload.baselineId === null ? 'No baseline' : `Baseline design ${payload.baselineId}`} · ${saved} saved and ${designed} designed ${payload.alternatives.length === 1 ? 'alternative' : 'alternatives'} · target ${payload.scenario.targetSpeed} km/s, PD ${payload.scenario.pd} km/s · ${techCount ? `${techCount} tech ${techCount === 1 ? 'level' : 'levels'} chosen` : 'the tech of the save'}`
    },

    newRecord() {
      this.recordOrigin = null
      this.recordBaseline = null
      this.recordName = ''
      this.recordTouched = false
      this.recordConflict = null
      this.recordMessage = ''
    },

    // Puts a kept comparison on the page: its baseline, alternatives and scenario as they were typed, and the tech levels it was made with.
    openRecord(uuid) {
      const entry = this.recordsRead.entries.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const { payload } = entry

      this.baselineId = payload.baselineId
      this.dismissLink()
      this.alternatives = JSON.parse(JSON.stringify(payload.alternatives))
      this.hitTargetSpeed = payload.scenario.targetSpeed
      this.hitJammer = payload.scenario.jammer
      this.hitModifier = payload.scenario.modifier
      this.pd = payload.scenario.pd
      this.targetSignature = payload.scenario.targetSignature
      this.restoreTech(entry)
      this.recordName = payload.name
      this.recordTouched = false
      this.recordOrigin = uuid
      this.recordBaseline = { uuid, revision: entry.revision, links: entry.links }
      this.linkCarry = carryOf(entry.links, payload)
      this.recordConflict = null
      this.recordMessage = ''
    },

    // The tech levels a kept comparison names replace the page's choices, each resolved against the open save like any other: a researched level goes to the page's remembered levels, a hypothetical one to the page-only choices (the tech scenario record of the branch is not written). A level of the record's whose tech changed or is gone is held with its link status, so it reads as unresolved and named, and the line designs with the game's pick. A hypothetical choice of the branch the comparison has no choice for is hidden on this page.
    restoreTech(entry) {
      const researched = {}
      const held = {}

      DESIGN_LINE_TYPES.forEach((type) => {
        const choice = entry.payload.tech.choices[type]
        const link = choice ? entry.links.find((item) => item.type === 'tech' && item.id === choice.techId) || { type: 'tech', id: choice.techId, status: 'unknown', reason: 'the comparison kept no link for this tech' } : undefined
        const chosen = choice ? { techId: choice.techId, name: choice.name, ...(link ? { link } : {}) } : null

        if (choice && choice.kind === 'researched') {
          researched[type] = choice.techId
        }

        if (choice && choice.kind === 'hypothetical') {
          held[type] = chosen
        } else if (choice && link && link.status !== 'linked') {
          held[type] = { ...chosen, source: 'preference' }
        } else if (this.techScenario.selection[type]) {
          held[type] = null
        }
      })

      this.techChoice = researched
      this.heldChoices = held
      this.scenarioMessage = Object.keys(held).length ? 'The tech levels of the comparison apply on this page only: the tech scenario record of the branch is unchanged.' : ''
    },

    saveRecordAsNew() {
      return this.saveRecord(false, true)
    },

    async saveRecord(overwrite = false, asNew = false) {
      this.recordTouched = true

      const entry = asNew ? null : this.recordEntry
      const payload = this.recordPayload
      const outcome = await saveDesign(this.records ? this.records.repository : null, this.scope, this.designs, { entry, payload, overwrite, tech: this.tech, carry: [...techLinksOf(this.techSelection), ...this.linkCarry] })

      if (outcome.ok) {
        this.recordOrigin = outcome.record.uuid
        this.recordBaseline = { uuid: outcome.record.uuid, revision: outcome.record.revision, links: [] }
        this.linkCarry = carryOf(outcome.record.links, payload)
        this.recordConflict = null
        this.recordMessage = ''
        this.recordRevision += 1
      } else if (outcome.code === 'revision-conflict') {
        this.recordConflict = { name: outcome.stored.name, revision: outcome.revision }
        this.recordMessage = ''
      } else {
        this.recordMessage = outcome.message
      }
    },

    async deleteRecord(uuid) {
      const entry = this.recordsRead.entries.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const outcome = await deleteDesign(this.records ? this.records.repository : null, this.scope, entry)

      if (outcome.ok) {
        if (this.recordOrigin === uuid) {
          this.newRecord()
        }

        this.recordMessage = ''
        this.recordRevision += 1
      } else {
        this.recordMessage = outcome.message
      }
    },

    async moveRecord(uuid) {
      const entry = this.recordsRead.entries.find((item) => item.uuid === uuid)

      if (!entry) {
        return
      }

      const outcome = await moveDesign(this.records ? this.records.repository : null, this.scope, entry)

      if (outcome.ok) {
        if (this.recordOrigin === uuid) {
          this.recordBaseline = { uuid, revision: outcome.record.revision, links: entry.links }
        }

        this.recordMessage = `The comparison ${entry.name} now applies to this save.`
        this.recordRevision += 1
      } else {
        this.recordMessage = outcome.message
      }
    },

    // The text of a figure as a table writes it: a word for one that is not known, never 0.
    figureText(value) {
      return this.count(value, 4)
    },

    // A cell of the optimiser's tables: the figure to its decimals, the word 'unknown' for a figure that is not known, and the provenance result of the figure where it has one.
    cellOf(id, value, result = null) {
      if (value === null || value === undefined) {
        return { text: 'unknown', unknown: true, result }
      }

      return { text: typeof value === 'number' ? this.count(value, OPTIMISER_DECIMALS[id] === undefined ? 0 : OPTIMISER_DECIMALS[id]) : String(value), unknown: false, result }
    },

    setOptimiserField(name, value) {
      this.optimiserFields = { ...this.optimiserFieldsRead, [name]: value }
    },

    setOptimiserAxis(name, part, value) {
      const fields = this.optimiserFieldsRead

      this.optimiserFields = { ...fields, [name]: { ...fields[name], [part]: value } }
    },

    // Sets the domain around the figures of the saved missile pinned as the baseline, with the match of it as the goal.
    searchAroundBaseline() {
      if (!this.optimiserBaseDraft) {
        return
      }

      this.optimiserFields = { ...this.optimiserFieldsRead, ...domainAround(this.optimiserBaseDraft), maxMsp: '', hitChance: '' }
      this.optimiserMessage = 'The domain now surrounds the figures of the baseline and the goal is its match. The size limit is left blank, which is the size of the baseline.'
    },

    // The run slot, made when first wanted: it holds a live generator and is not reactive.
    optimiserSlotOf() {
      if (!this.optimiserSlot) {
        this.optimiserSlot = createRunSlot()
      }

      return this.optimiserSlot
    },

    stopOptimiser(why) {
      if (this.optimiserSlot) {
        this.optimiserSlot.invalidate(why)
      }

      this.optimiserRunning = false
    },

    // Stops the run where it is; its best so far is kept, labelled incomplete.
    cancelOptimiser() {
      this.optimiserSlotOf().cancel()
    },

    // Runs the optimisation of the request a slice at a time and keeps its outcome. A run that is replaced is dropped without a word.
    async runOptimiser() {
      const request = this.optimiserRequest

      if (!request.ok) {
        return
      }

      const slot = this.optimiserSlotOf()

      try {
        const run = slot.start(missileRun(request.input))

        this.optimiserProgress = 0
        this.optimiserRunning = true
        this.optimiserError = ''
        this.optimiserMessage = ''
        this.optimiserCopyMessage = ''

        while (run.running) {
          run.advance(RESPONSIVENESS.sliceMs)
          this.optimiserProgress = run.progress

          if (run.running) {
            await nextTask()
          }

          if (!slot.isCurrent(run)) {
            return
          }
        }

        const outcome = slot.publish(run)

        if (!outcome) {
          return
        }

        this.optimiserRunning = false

        if (outcome.error) {
          this.optimiserError = outcome.error

          return
        }

        this.optimiserOutcome = outcome
      } catch (error) {
        this.optimiserRunning = false
        this.optimiserError = error.message
      }
    },

    async copyOptimised() {
      try {
        await navigator.clipboard.writeText(this.optimiserExport.text)
        this.optimiserCopyMessage = 'The result is copied as text with the status of the search.'
      } catch (error) {
        this.optimiserCopyMessage = `The result could not be copied (${error && error.message ? error.message : 'the clipboard is not available'}).`
      }
    },

    // The listed candidates as a CSV file, the status of the search on every row.
    downloadOptimised() {
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([this.optimiserExport.csv], { type: 'text/csv' }))
      link.download = 'missile-optimisation.csv'
      link.click()
      URL.revokeObjectURL(link.href)
    },

    // Sets the best candidates of the result beside the baseline as alternatives, up to the three the comparison holds. The baseline stays as saved.
    nominateOptimised() {
      if (!this.canNominate) {
        return
      }

      const drafts = nominations(this.optimiserOutcome, { baseDraft: this.optimiserBaseDraft })
      const before = this.alternatives.length

      drafts.forEach((draft) => this.pushAlternative(draft))

      const added = this.alternatives.length - before

      const beside = this.baselineId === null ? '' : ' beside the baseline'

      this.optimiserMessage = added === drafts.length ? `The best ${added === 1 ? 'candidate is' : `${added} candidates are`} set${beside} as ${added === 1 ? 'an alternative' : 'alternatives'}.` : `${added} of the ${drafts.length} best could be set${beside}. ${this.alternativeMessage}`
    },

    // One field of a launch sensor: the saved sensor chosen (its id, or null for typed figures) or a figure typed.
    setLauncherSensor(role, field, value) {
      const selection = this.launcherSelection

      this.launcherSensors = { ...selection, [role]: { ...selection[role], [field]: value === undefined ? null : value } }
    },

    setLauncherJammer(value) {
      this.launcherJammer = value
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
    // The missiles the race has researched and owns, as the saved designs of a fixture the rules read.
    designs: {
      get: tracked('designs', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_DESIGNS
        }

        return await loadDesigns(this.database, this.context)
      }),
      default: NO_DESIGNS,
    },
    // The formula version the save's schema stands for, which the hit chance rules are read for.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
    // The missile fire controls and active sensors the race has researched, as components of the save with their stored range, resolution and ECCM.
    sensors: {
      get: tracked('sensors', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_SENSORS
        }

        return await loadSensorFixture(this.database, this.GameID, this.RaceID)
      }),
      default: NO_SENSORS,
    },
    // The repository of scenario records, loaded when the page is: its module needs the app's settings store, so a page that is read without it still loads.
    records: {
      async get() {
        try {
          const records = await import('../utilities/scenario-records')

          registerTechScenarios(records.registerAdapter)
          registerDesigner(records.registerAdapter)

          return Object.freeze({ repository: records.openScenarioRecords(), error: null })
        } catch (error) {
          return Object.freeze({ repository: null, error: error.message })
        }
      },
      default: null,
    },
  },
}
</script>

<style lang="scss">
.missile-designer-page {
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

  .tool--baseline {
    flex: 1 1 260px;
    max-width: 420px;
  }

  .tool--number {
    flex: 0 0 170px;
  }

  .tool--name {
    flex: 1 1 220px;
    max-width: 360px;
  }

  .tool--actions {
    align-self: flex-end;
  }

  .tool__buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .tool__buttons .v-btn {
    height: 40px !important;
  }

  .missile-designer-page__draft + .missile-designer-page__draft {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid rgba(128, 128, 128, 0.3);
  }
}
</style>
