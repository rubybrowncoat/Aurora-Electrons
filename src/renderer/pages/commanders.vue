<template>
  <div>
    <v-container fluid class="commanders-page">
      <v-alert v-if="failedInputs.length" type="error" outlined dense>
        Couldn't read {{ failedInputsText }}: {{ loadErrors[failedInputs[0]] }}. The game may be saving; the page reads the save again when it changes.
        <template #append>
          <v-btn small text color="error" @click="retryFailedInputs">Retry</v-btn>
        </template>
      </v-alert>
      <v-progress-linear v-else-if="!ready" indeterminate />

      <template v-if="ready">
        <v-row>
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value">
                <v-icon v-if="tile.icon" :color="tile.iconColor" class="mr-1">{{ tile.icon }}</v-icon>{{ tile.value }}
              </div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Better assignments</span>
            <v-btn-toggle v-model="suggestionView" mandatory dense>
              <v-btn value="governors" small>Governors ({{ governorRows.length }})</v-btn>
              <v-btn value="ships" small>Specialist ships ({{ shipRows.length }})</v-btn>
              <v-btn value="research" small>Research ({{ researchRows.length }})</v-btn>
            </v-btn-toggle>
          </div>

          <template v-if="suggestionView === 'governors'">
            <v-data-table v-if="governorRows.length" :headers="governorHeaders" :items="governorRows" item-key="key" disable-pagination hide-default-footer>
              <template #[`item.colony`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.colony.PopName }}</div>
                  <div class="caption text--secondary">Importance {{ item.colony.Importance }} · wants {{ colonyBonuses(item.colony) }}</div>
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
                  <div class="caption text--secondary">{{ keyLabel(item.colony, item.candidateKey) }} · admin rating {{ rating(item.candidate) }}<span v-if="item.alsoBestFor"> · also best for {{ item.alsoBestFor }} other {{ item.alsoBestFor === 1 ? 'colony' : 'colonies' }}</span></div>
                </div>
              </template>
            </v-data-table>
            <div v-else class="panel-body caption text--secondary">No unassigned administrator beats a current governor on their colony's bonuses, and no colony with a required bonus is without one.</div>
            <div class="panel-foot caption text--secondary">
              As the game ranks governors: a candidate must have the colony's required bonus, and ranks by it, then the secondary, then the tertiary bonus (set on the Governor tab of the Economics window). Only unassigned administrators are considered.
            </div>
          </template>

          <template v-else-if="suggestionView === 'ships'">
            <v-data-table v-if="shipRows.length" :headers="shipHeaders" :items="shipRows" item-key="key" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }">
              <template #[`item.ship`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.ship.ShipName }}</div>
                  <div class="caption text--secondary">{{ item.ship.ClassName }} · {{ item.ship.FleetName }}</div>
                </div>
              </template>
              <template #[`item.post`]="{ item }">
                <div>{{ item.post.post === 'science' ? 'Science officer' : 'Captain' }}</div>
                <div class="caption text--secondary">{{ item.post.label }} · {{ rankName(item.post.level) }}</div>
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
                  <div class="caption text--secondary">{{ bonusText(item.post.bonusId, item.candidate.bonuses[item.post.bonusId]) }}</div>
                </div>
                <span v-else class="text--secondary">None at this rank</span>
                <div v-if="item.otherRanks" class="caption text--secondary">{{ item.otherRanks }} better at other ranks</div>
              </template>
            </v-data-table>
            <div v-else class="panel-body caption text--secondary">Every terraformer, miner, harvester and survey ship has an officer, and no unassigned officer of the post's rank has a better bonus.</div>
            <div class="panel-foot caption text--secondary">
              Terraformers and miners use their captain's full bonus. Survey ships with a Science Department use their science officer's (one rank below the captain), others half their captain's. Candidates are unassigned naval officers of exactly the post's rank, as automatic assignment uses; "other ranks" would need a promotion, or a manual assignment.
            </div>
          </template>

          <template v-else>
            <v-data-table v-if="researchRows.length" :headers="researchHeaders" :items="researchRows" item-key="key" disable-pagination hide-default-footer>
              <template #[`item.project`]="{ item }">
                <div class="py-2">
                  <div class="font-weight-medium">{{ item.project.ProjectName }}</div>
                  <div class="caption text--secondary">{{ item.project.PopName }} · {{ item.project.FieldName }} · {{ item.project.Facilities }} labs</div>
                </div>
              </template>
              <template #[`item.holder`]="{ item }">
                <div v-if="item.holder">
                  <div>{{ item.holder.Name }}</div>
                  <div class="caption text--secondary">× {{ fixed(item.current, 2) }}{{ item.holder.ResSpecID === item.project.ResSpecID ? '' : ', out of field' }}</div>
                </div>
                <span v-else class="warning--text">No scientist</span>
              </template>
              <template #[`item.candidate`]="{ item }">
                <div class="font-weight-medium">{{ item.candidate.Name }}</div>
                <div class="caption text--secondary">× {{ fixed(item.candidateMultiplier, 2) }}, runs up to {{ Math.round(item.candidate.bonuses[27] || 0) }} labs</div>
              </template>
            </v-data-table>
            <div v-else class="panel-body caption text--secondary">{{ projects.length ? 'No unassigned scientist of the right field, able to run the labs, would research faster.' : 'No research projects are running.' }}</div>
            <div class="panel-foot caption text--secondary">
              A scientist's Research bonus counts four times in their own field (+15% becomes +60%) and once outside it. A candidate must be of the project's field and run at least its labs (Research Administration).
            </div>
          </template>
        </v-card>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Roster</span>
            <v-btn-toggle v-model="typeId" mandatory dense @change="(value) => config.set('commandersType', value)">
              <v-btn v-for="type in commanderTypes" :key="type.id" :value="type.id" small>{{ type.plural }} ({{ count(type.total) }})</v-btn>
            </v-btn-toggle>
          </div>
          <v-row dense align="center" class="px-6 pb-2">
            <v-col cols="12" sm="auto">
              <v-switch v-model="unassignedOnly" label="Unassigned only" dense hide-details class="mt-0" @change="(value) => config.set('commandersUnassignedOnly', !!value)" />
            </v-col>
            <v-col cols="12" sm="3">
              <v-text-field v-model="search" label="Search names and assignments" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
            </v-col>
            <v-col cols="12" sm="3">
              <v-select v-model="bonusId" :items="bonusItems" item-text="text" item-value="value" label="Sort by bonus" dense outlined hide-details clearable />
            </v-col>
            <v-col v-if="typeId === 3" cols="12" sm="3">
              <v-select v-model="fieldId" :items="fieldItems" item-text="text" item-value="value" label="Research field" dense outlined hide-details clearable />
            </v-col>
          </v-row>
          <v-data-table :headers="rosterHeaders" :items="rosterRows" item-key="CommanderID" :sort-by.sync="rosterSortBy" :sort-desc.sync="rosterSortDesc" :items-per-page="25" :footer-props="{ itemsPerPageOptions: [25, 50, 100] }" class="roster-table">
            <template #[`item.Name`]="{ item }">
              <span class="font-weight-medium">{{ item.Name }}</span>
              <v-icon v-if="item.StoryCharacter" small class="ml-1" title="Story character: never retires">mdi-book-open-variant</v-icon>
            </template>
            <template #[`item.rankSort`]="{ item }">
              <span :title="item.RankName">{{ item.rankLabel }}</span>
            </template>
            <template #[`item.assignment`]="{ item }">
              <span v-if="item.CommandType === 0" class="text--secondary">Unassigned</span>
              <template v-else>
                <div>{{ item.post }}</div>
                <div class="caption text--secondary">{{ item.AssignmentName }}</div>
              </template>
            </template>
            <template #[`item.HealthRisk`]="{ item }">
              <span :class="{ 'warning--text': item.HealthRisk >= 6 }">{{ item.HealthRisk }}</span>
            </template>
            <template #[`item.selectedBonus`]="{ item }">
              <span v-if="item.selectedBonus !== null">{{ bonusText(bonusId, item.selectedBonus) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.bonusList`]="{ item }">
              <span v-for="bonus in item.bonusList" :key="bonus.id" class="bonus-chip" :title="bonus.description">{{ bonus.abbrev }} {{ bonus.text }}</span>
            </template>
            <template #[`item.traitCount`]="{ item }">
              <span v-if="item.traitNames.length" :title="item.traitNames.join(', ')">{{ item.traitNames.length }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Age is the species' graduation age plus the years since the commander's career began. Health risk is the game's own figure (1 is the healthiest); its scale isn't documented.
          </div>
        </v-card>

        <v-card class="panel" elevation="1">
          <div class="panel-head">
            <span>Former commanders</span>
            <v-btn-toggle :value="formerGroup" mandatory dense @change="(value) => (formerView = value)">
              <v-btn v-for="group in formerGroups" :key="group.value" :value="group.value" :disabled="!group.count" small>{{ group.text }} ({{ count(group.count) }})</v-btn>
            </v-btn-toggle>
          </div>
          <v-data-table v-if="formerShown.length" :key="formerGroup === 'held' ? 'held' : 'own'" :headers="formerHeaders" :items="formerShown" item-key="CommanderID" :show-expand="formerGroup !== 'held'" :sort-by="formerGroup === 'held' ? 'raceName' : 'lastTime'" :sort-desc="formerGroup !== 'held'" :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 50, -1] }" class="roster-table">
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
              <template v-if="item.lastDate">
                <div>{{ item.lastDate }}</div>
                <div class="caption text--secondary">{{ item.lastText }}</div>
              </template>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.kills`]="{ item }">
              <span v-if="item.kills" :title="`${count(item.KillTonnageMilitary)} t military, ${count(item.KillTonnageCommercial)} t commercial`">{{ count(item.kills) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.MedalCount`]="{ item }">
              <span v-if="item.MedalCount" :title="item.Medals">{{ item.MedalCount }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.bonusList`]="{ item }">
              <span v-for="bonus in item.bonusList" :key="bonus.id" class="bonus-chip" :title="bonus.description">{{ bonus.abbrev }} {{ bonus.text }}</span>
            </template>
            <template #[`item.Processed`]="{ item }">
              {{ item.Processed ? 'Yes' : 'Not yet' }}
            </template>
            <template v-if="formerGroup !== 'held'" #expanded-item="{ headers, item }">
              <td :colspan="headers.length" class="py-3">
                <div v-if="item.Notes" class="mb-2"><span class="text--secondary">Notes:</span> {{ item.Notes }}</div>
                <div v-for="(entry, index) in item.history" :key="index" class="career-line">
                  <span class="text--secondary career-date">{{ date(entry.GameTime) }}</span>{{ entry.HistoryText }}
                </div>
                <div v-if="!item.history.length" class="text--secondary">The save holds no career record for this commander.</div>
              </td>
            </template>
          </v-data-table>
          <div v-else class="panel-body caption text--secondary">No commander of this race is a prisoner, retired or dead in the save, and the race holds no prisoners.</div>
          <div class="panel-foot caption text--secondary">
            The game deletes a commander who retires or dies when the game is saved, unless you press Retain for them in the Commanders window; prisoners are always kept. A prisoner's captor is the race owning the ship or colony that holds them, as your race knows it. Age at death counts to the commander's last career record. Expand a row for the full career.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { gameTime } from '../utilities/aurora'
import { COLONY_ADMINISTRATION, COMMANDER_TYPES, POSTS, RETIRE_STATUSES, SERVING_COMMANDER, formatBonus, formerKind, governorSuggestions, parseBonuses, researchSuggestions, shipSuggestions } from '../utilities/commanders'
import { allLoaded, joinLabels, tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'

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
}
const INPUTS = Object.keys(INPUT_LABELS)
// Chips shown per commander in the roster; the rest are in the tooltip-free count.
const ROSTER_BONUSES = 6
const SECONDS_PER_YEAR = 31536000
const FORMER_GROUPS = [
  { value: 'prisoner', text: 'Prisoners' },
  { value: 'retired', text: 'Retired' },
  { value: 'dead', text: 'Dead' },
  { value: 'held', text: 'Held by us' },
]

export default {
  name: 'CommandersPage',
  data() {
    return {
      typeId: 0,
      unassignedOnly: false,
      search: '',
      bonusId: null,
      fieldId: null,
      suggestionView: 'governors',
      rosterSortBy: [],
      rosterSortDesc: [],
      formerView: 'prisoner',
      loadErrors: {},
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    failedInputs() {
      return INPUTS.filter((key) => this.loadErrors[key])
    },

    failedInputsText() {
      return joinLabels(this.failedInputs.map((key) => INPUT_LABELS[key]))
    },

    ready() {
      return allLoaded(this.loadErrors, INPUTS)
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
        bonuses: parseBonuses(commander.Bonuses),
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

    commanderTypes() {
      return COMMANDER_TYPES.map((type) => ({ ...type, total: this.byType[type.id].length, idle: this.byType[type.id].filter((person) => person.CommandType === 0).length }))
    },

    governorRows() {
      return governorSuggestions(this.colonies, this.byType[2]).map((row) => ({ ...row, key: row.colony.PopulationID }))
    },

    shipRows() {
      return shipSuggestions(this.ships, this.byType[0]).map((row) => ({ ...row, key: row.ship.ShipID }))
    },

    researchRows() {
      return researchSuggestions(this.projects, this.byType[3]).map((row) => ({ ...row, key: row.project.ProjectID }))
    },

    tiles() {
      const types = this.commanderTypes
      const total = types.reduce((sum, type) => sum + type.total, 0)
      const vacancies = this.colonies.filter((colony) => !colony.GovernorID && colony.Population > 0).length
      const captainless = this.ships.filter((ship) => !ship.CaptainID).length
      const suggestions = this.governorRows.length + this.shipRows.length + this.researchRows.length

      return [
        {
          label: 'Commanders',
          value: this.count(total),
          note: types.map((type) => `${this.count(type.total)} ${type.plural.toLowerCase()}`).join(', '),
        },
        {
          label: 'Unassigned',
          value: this.count(types.reduce((sum, type) => sum + type.idle, 0)),
          note: types.map((type) => `${this.count(type.idle)} ${type.label.toLowerCase()}`).join(', '),
        },
        {
          label: 'Colonies without a governor',
          value: `${vacancies}`,
          note: captainless ? `${captainless} specialist ships without a captain` : 'Every specialist ship has a captain',
          icon: vacancies || captainless ? 'mdi-account-alert' : null,
          iconColor: 'warning',
        },
        {
          label: 'Better assignments',
          value: `${suggestions}`,
          note: `${this.governorRows.length} governors, ${this.shipRows.length} specialist ships, ${this.researchRows.length} research projects`,
          icon: suggestions ? 'mdi-swap-horizontal' : 'mdi-check-circle',
          iconColor: suggestions ? 'primary' : 'success',
        },
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

    rosterRows() {
      const search = (this.search || '').toLowerCase()

      return this.byType[this.typeId].filter((person) => (!this.unassignedOnly || person.CommandType === 0) && (this.fieldId === null || this.typeId !== 3 || person.ResSpecID === this.fieldId) && (!search || `${person.Name} ${person.AssignmentName || ''}`.toLowerCase().includes(search)) && (this.bonusId === null || person.bonuses[this.bonusId] !== undefined)).map((person) => ({
        ...person,
        post: POSTS[person.CommandType] || `Post ${person.CommandType}`,
        assignment: person.CommandType === 0 ? '' : `${POSTS[person.CommandType] || ''} ${person.AssignmentName || ''}`,
        rankLabel: person.RankAbbrev || (person.CommanderType === 3 ? person.FieldName || 'Scientist' : 'Administrator'),
        rankSort: person.RankLevel || 0,
        selectedBonus: this.bonusId === null ? null : person.bonuses[this.bonusId] ?? null,
        bonusList: this.topBonuses(person.bonuses),
        traitNames: person.traitIds.map((id) => this.traitById[id]).filter(Boolean),
        traitCount: person.traitIds.length,
      }))
    },

    // The race's former commanders with their status, captor, last career record and age; the dead
    // age only to their last record.
    formerRows() {
      return this.former.map((person) => {
        const kind = formerKind(person)
        const history = this.formerHistory[person.CommanderID] || []
        const last = history[0] || null
        const until = kind === 'dead' && last ? last.GameTime : person.GameTime
        const status = (RETIRE_STATUSES[person.RetireStatus] || {}).label

        return {
          ...person,
          kind,
          history,
          typeLabel: (COMMANDER_TYPES.find((type) => type.id === person.CommanderType) || {}).label || '',
          rankLabel: person.RankAbbrev || (person.CommanderType === 3 ? person.FieldName || 'Scientist' : 'Administrator'),
          statusLabel: kind === 'prisoner' ? `Prisoner${person.CaptorID ? ` of ${person.CaptorName || 'an unknown race'}` : ''}` : status || 'Retired',
          statusNote: kind !== 'prisoner' && person.Prisoner ? 'While a prisoner' : '',
          age: roundToDecimal(person.GraduationAge + (until - person.CareerStart) / SECONDS_PER_YEAR, 1),
          lastTime: last ? last.GameTime : -1,
          lastDate: last ? this.date(last.GameTime) : '',
          lastText: last ? last.HistoryText : '',
          kills: (person.KillTonnageMilitary || 0) + (person.KillTonnageCommercial || 0),
          bonusList: this.topBonuses(parseBonuses(person.Bonuses)),
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
      const counts = { prisoner: 0, retired: 0, dead: 0, held: this.heldRows.length }

      this.formerRows.forEach((person) => counts[person.kind]++)

      return FORMER_GROUPS.map((group) => ({ ...group, count: counts[group.value] }))
    },

    // The chosen group, or the first with anyone in it when the chosen one is empty.
    formerGroup() {
      const chosen = this.formerGroups.find((group) => group.value === this.formerView)

      return chosen.count ? chosen.value : (this.formerGroups.find((group) => group.count) || chosen).value
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
        { text: 'Medals', value: 'MedalCount', align: 'end' },
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
  },
  watch: {
    bonusId(value) {
      this.rosterSortBy = value === null ? [] : ['selectedBonus']
      this.rosterSortDesc = value === null ? [] : [true]
    },
    typeId() {
      this.bonusId = null
      this.fieldId = null
    },
  },
  created() {
    this.typeId = this.config.get('commandersType', 0)
    this.unassignedOnly = this.config.get('commandersUnassignedOnly', false)
  },
  methods: {
    retryFailedInputs() {
      this.failedInputs.forEach((key) => this.$asyncComputed[key].update())
    },

    count(value) {
      return separatedNumber(roundToDecimal(value || 0, 0), this.separator)
    },
    fixed(value, decimals) {
      return roundToDecimal(value, decimals).toFixed(decimals)
    },
    // Ratings rank above multipliers, then the bigger bonus first.
    bonusWeight({ id, value }) {
      return id === COLONY_ADMINISTRATION || id === 27 ? 10 + value : value
    },
    // The strongest bonuses as roster chips.
    topBonuses(bonuses) {
      return Object.entries(bonuses).map(([id, value]) => ({ id: Number(id), value })).sort((a, b) => this.bonusWeight(b) - this.bonusWeight(a)).slice(0, ROSTER_BONUSES).map((bonus) => ({
        id: bonus.id,
        abbrev: (this.bonusTypeById[bonus.id] || {}).BonusAbbrev || `#${bonus.id}`,
        description: (this.bonusTypeById[bonus.id] || {}).Description || `Bonus ${bonus.id}`,
        text: formatBonus(bonus.id, bonus.value),
      }))
    },
    date(seconds) {
      return gameTime(this.StartYear, seconds).format('YYYY-MM-DD')
    },
    bonusText(bonusId, value) {
      return value === null || value === undefined ? 'none' : `${(this.bonusTypeById[bonusId] || {}).Description || 'Bonus'} ${formatBonus(bonusId, value)}`
    },
    rating(admin) {
      return admin.bonuses[COLONY_ADMINISTRATION] ? Math.round(admin.bonuses[COLONY_ADMINISTRATION]) : '—'
    },
    rankName(level) {
      return this.navalRanks[level] || `rank ${level}`
    },
    colonyBonuses(colony) {
      return [colony.BonusOne, colony.BonusTwo, colony.BonusThree].filter((id) => id > 0).map((id) => (this.bonusTypeById[id] || {}).Description || `#${id}`).join(', then ')
    },
    keyLabel(colony, key) {
      // A missing bonus ranks as 1 (no effect); show it as "none" rather than +0%.
      return [colony.BonusOne, colony.BonusTwo, colony.BonusThree].map((id, index) => (id > 0 ? `${(this.bonusTypeById[id] || {}).BonusAbbrev || id} ${key[index] === 1 ? 'none' : formatBonus(id, key[index])}` : null)).filter(Boolean).join(', ')
    },
  },
  asyncComputed: {
    // Every serving commander of the race (not retired, dead or a prisoner), with rank level (1 is
    // the lowest rank), age, assignment name, and bonuses and traits as "id:value" / "id" lists.
    commanders: {
      get: tracked('commanders', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommanderType, FCT_Commander.CommandType, FCT_Commander.CommandID, FCT_Commander.ResSpecID, DIM_ResearchField.FieldName, FCT_Commander.HealthRisk, FCT_Commander.StoryCharacter, FCT_Ranks.RankName, FCT_Ranks.RankAbbrev, VIR_Levels.Lowest - FCT_Ranks.Priority + 1 as RankLevel, round(coalesce(FCT_Species.GraduationAge, 21) + (FCT_Game.GameTime - FCT_Commander.CareerStart) / 31536000.0, 1) as Age, case when FCT_Commander.CommandType in (1, 8, 9, 10, 11, 15) then VIR_Ship.ShipName when FCT_Commander.CommandType in (3, 17) then VIR_Population.PopName when FCT_Commander.CommandType = 4 then FCT_SectorCommand.SectorName when FCT_Commander.CommandType = 5 then FCT_GroundUnitFormation.Name when FCT_Commander.CommandType = 12 then FCT_NavalAdminCommand.AdminCommandName when FCT_Commander.CommandType = 7 then FCT_TechSystem.Name end as AssignmentName, VIR_Bonuses.Bonuses, VIR_Traits.Traits from FCT_Commander inner join FCT_Game on FCT_Game.GameID = FCT_Commander.GameID left join FCT_Species on FCT_Species.SpeciesID = FCT_Commander.SpeciesID left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID left join (select FCT_Ranks.RankType, max(FCT_Ranks.Priority) as Lowest from FCT_Ranks where FCT_Ranks.GameID = ${this.GameID} and FCT_Ranks.RaceID = ${this.RaceID} group by FCT_Ranks.RankType) as VIR_Levels on VIR_Levels.RankType = FCT_Ranks.RankType left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_Commander.ResSpecID and FCT_Commander.CommanderType = 3 left join FCT_Ship as VIR_Ship on VIR_Ship.ShipID = FCT_Commander.CommandID and FCT_Commander.CommandType in (1, 8, 9, 10, 11, 15) left join FCT_Population as VIR_Population on VIR_Population.PopulationID = FCT_Commander.CommandID and FCT_Commander.CommandType in (3, 17) left join FCT_SectorCommand on FCT_SectorCommand.SectorCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 4 left join FCT_GroundUnitFormation on FCT_GroundUnitFormation.FormationID = FCT_Commander.CommandID and FCT_Commander.CommandType = 5 left join FCT_NavalAdminCommand on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 12 left join FCT_ResearchProject on FCT_ResearchProject.ProjectID = FCT_Commander.CommandID and FCT_Commander.CommandType = 7 left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID left join (select FCT_CommanderBonuses.CommanderID, group_concat(FCT_CommanderBonuses.BonusID || ':' || FCT_CommanderBonuses.BonusValue, ',') as Bonuses from FCT_CommanderBonuses inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderBonuses.CommanderID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderBonuses.CommanderID) as VIR_Bonuses on VIR_Bonuses.CommanderID = FCT_Commander.CommanderID left join (select FCT_CommanderTraits.CmdrID as CommanderID, group_concat(FCT_CommanderTraits.TraitID, ',') as Traits from FCT_CommanderTraits inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderTraits.CmdrID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderTraits.CmdrID) as VIR_Traits on VIR_Traits.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and ${SERVING_COMMANDER} order by FCT_Commander.CommanderType, FCT_Commander.Seniority`).then(([items]) => items)
      }),
      default: [],
    },
    bonusTypes: {
      get: tracked('bonusTypes', async function () {
        if (!this.database) {
          return []
        }

        return await this.database.query('select DIM_CommanderBonusType.BonusID, DIM_CommanderBonusType.Description, DIM_CommanderBonusType.BonusAbbrev, DIM_CommanderBonusType.Naval, DIM_CommanderBonusType.Ground, DIM_CommanderBonusType.Civilian, DIM_CommanderBonusType.Scientist from DIM_CommanderBonusType order by DIM_CommanderBonusType.DisplayOrder').then(([items]) => items)
      }),
      default: [],
    },
    traits: {
      get: tracked('traits', async function () {
        if (!this.database) {
          return []
        }

        return await this.database.query('select DIM_TraitsList.TraitID, DIM_TraitsList.Name from DIM_TraitsList').then(([items]) => items)
      }),
      default: [],
    },
    // Colonies with their governor and the bonuses the game ranks governors by (Governor tab).
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Importance, FCT_Population.BonusOne, FCT_Population.BonusTwo, FCT_Population.BonusThree, VIR_Governor.CommanderID as GovernorID from FCT_Population left join (select FCT_Commander.CommanderID, FCT_Commander.CommandID from FCT_Commander where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.Deceased = 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and (FCT_Population.Population > 0 or VIR_Governor.CommanderID is not null) order by FCT_Population.Importance desc, FCT_Population.Population desc`).then(([items]) => items)
      }),
      default: [],
    },
    // Terraformers, orbital miners, harvesters and survey ships, with their captain and science
    // officer and whether the class has a Science Department.
    ships: {
      get: tracked('ships', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Fleet.FleetName, FCT_ShipClass.ClassName, FCT_ShipClass.RankRequired, FCT_ShipClass.Terraformers, FCT_ShipClass.MiningModules, FCT_ShipClass.Harvesters, FCT_ShipClass.GeoSurvey, FCT_ShipClass.GravSurvey, (select count(*) from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.Name = 'Science Department') as SciencePosts, (select FCT_Commander.CommanderID from FCT_Commander where FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 1 and FCT_Commander.RaceID = FCT_Ship.RaceID and FCT_Commander.Deceased = 0 limit 1) as CaptainID, (select FCT_Commander.CommanderID from FCT_Commander where FCT_Commander.CommandID = FCT_Ship.ShipID and FCT_Commander.CommandType = 10 and FCT_Commander.RaceID = FCT_Ship.RaceID and FCT_Commander.Deceased = 0 limit 1) as ScienceOfficerID from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Ship.ShippingLineID = 0 and (FCT_ShipClass.Terraformers > 0 or FCT_ShipClass.MiningModules > 0 or FCT_ShipClass.Harvesters > 0 or FCT_ShipClass.GeoSurvey > 0 or FCT_ShipClass.GravSurvey > 0) order by FCT_ShipClass.ClassName, FCT_Ship.ShipName`).then(([items]) => items)
      }),
      default: [],
    },
    projects: {
      get: tracked('projects', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_ResearchProject.ProjectID, FCT_ResearchProject.ResSpecID, DIM_ResearchField.FieldName, FCT_ResearchProject.Facilities, FCT_TechSystem.Name as ProjectName, FCT_Population.PopName, (select FCT_Commander.CommanderID from FCT_Commander where FCT_Commander.CommandID = FCT_ResearchProject.ProjectID and FCT_Commander.CommandType = 7 and FCT_Commander.RaceID = FCT_ResearchProject.RaceID and FCT_Commander.Deceased = 0 limit 1) as ScientistID from FCT_ResearchProject left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_ResearchProject.ResSpecID where FCT_ResearchProject.GameID = ${this.GameID} and FCT_ResearchProject.RaceID = ${this.RaceID}`).then(([items]) => items)
      }),
      default: [],
    },
    // Commanders of the race no longer serving: prisoners of another race, and retired or dead
    // commanders the player kept. A prisoner's captor is the race owning the ship or colony that
    // holds them, named as this race knows it.
    former: {
      get: tracked('former', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommanderType, FCT_Commander.ResSpecID, DIM_ResearchField.FieldName, FCT_Commander.StoryCharacter, FCT_Commander.Notes, FCT_Commander.KillTonnageMilitary, FCT_Commander.KillTonnageCommercial, FCT_Commander.CareerStart, FCT_Commander.RetireStatus, FCT_Commander.Prisoner, FCT_Ranks.RankName, FCT_Ranks.RankAbbrev, coalesce(FCT_Species.GraduationAge, 21) as GraduationAge, FCT_Game.GameTime, coalesce(VIR_HoldShip.RaceID, VIR_HoldColony.RaceID) as CaptorID, FCT_AlienRace.AlienRaceName as CaptorName, VIR_Bonuses.Bonuses, VIR_Medals.Medals, VIR_Medals.MedalCount
          from FCT_Commander
          inner join FCT_Game on FCT_Game.GameID = FCT_Commander.GameID
          left join FCT_Species on FCT_Species.SpeciesID = FCT_Commander.SpeciesID
          left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID
          left join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = FCT_Commander.ResSpecID and FCT_Commander.CommanderType = 3
          left join FCT_Ship as VIR_HoldShip on VIR_HoldShip.ShipID = FCT_Commander.TransportShipID and VIR_HoldShip.RaceID <> FCT_Commander.RaceID
          left join FCT_Population as VIR_HoldColony on VIR_HoldColony.PopulationID = FCT_Commander.PopLocationID and VIR_HoldColony.RaceID <> FCT_Commander.RaceID
          left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Commander.GameID and FCT_AlienRace.ViewRaceID = FCT_Commander.RaceID and FCT_AlienRace.AlienRaceID = coalesce(VIR_HoldShip.RaceID, VIR_HoldColony.RaceID)
          left join (select FCT_CommanderBonuses.CommanderID, group_concat(FCT_CommanderBonuses.BonusID || ':' || FCT_CommanderBonuses.BonusValue, ',') as Bonuses from FCT_CommanderBonuses inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderBonuses.CommanderID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderBonuses.CommanderID) as VIR_Bonuses on VIR_Bonuses.CommanderID = FCT_Commander.CommanderID
          left join (select FCT_CommanderMedal.CommanderID, group_concat(coalesce(FCT_RaceMedals.MedalName, 'Medal') || case when FCT_CommanderMedal.NumAwarded > 1 then ' ×' || FCT_CommanderMedal.NumAwarded else '' end, ', ') as Medals, sum(FCT_CommanderMedal.NumAwarded) as MedalCount from FCT_CommanderMedal inner join FCT_Commander as VIR_Owner on VIR_Owner.CommanderID = FCT_CommanderMedal.CommanderID left join FCT_RaceMedals on FCT_RaceMedals.MedalID = FCT_CommanderMedal.MedalID where VIR_Owner.GameID = ${this.GameID} and VIR_Owner.RaceID = ${this.RaceID} group by FCT_CommanderMedal.CommanderID) as VIR_Medals on VIR_Medals.CommanderID = FCT_Commander.CommanderID
          where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and not (${SERVING_COMMANDER})`).then(([items]) => items)
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

        return await this.database.query(`select FCT_Commander.CommanderID, FCT_Commander.Name, FCT_Commander.CommanderType, FCT_AlienRace.AlienRaceName, FCT_Ranks.RankName, FCT_Ranks.RankAbbrev, FCT_Commander.Processed, VIR_Ship.ShipName, VIR_Colony.PopName
          from FCT_Commander
          left join FCT_Ship as VIR_Ship on VIR_Ship.ShipID = FCT_Commander.TransportShipID and VIR_Ship.RaceID = ${this.RaceID}
          left join FCT_Population as VIR_Colony on VIR_Colony.PopulationID = FCT_Commander.PopLocationID and VIR_Colony.RaceID = ${this.RaceID}
          left join FCT_AlienRace on FCT_AlienRace.GameID = FCT_Commander.GameID and FCT_AlienRace.ViewRaceID = ${this.RaceID} and FCT_AlienRace.AlienRaceID = FCT_Commander.RaceID
          left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID
          where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID <> ${this.RaceID} and FCT_Commander.Prisoner = 1 and (VIR_Ship.ShipID is not null or VIR_Colony.PopulationID is not null)`).then(([items]) => items)
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss">
.commanders-page {
  .stat-tile {
    padding: 16px;
    height: 100%;
  }

  .stat-value {
    font-size: 24px;
    line-height: 32px;
    font-weight: 400;
    margin: 4px 0;
  }

  .panel {
    margin-top: 20px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 24px;
    font-size: 16px;
    line-height: 28px;
  }

  .panel-body {
    padding: 0 24px 16px;
  }

  .panel-foot {
    padding: 12px 24px 16px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .bonus-chip {
    display: inline-block;
    margin: 2px 4px 2px 0;
    padding: 0 6px;
    border-radius: 10px;
    font-size: 12px;
    line-height: 20px;
    white-space: nowrap;
    background: rgba(0, 0, 0, 0.06);
  }

  .career-line {
    font-size: 13px;
    line-height: 20px;
  }

  .career-date {
    display: inline-block;
    width: 96px;
  }
}

.theme--dark .commanders-page {
  .bonus-chip {
    background: rgba(255, 255, 255, 0.1);
  }
}
</style>
