import { mapGetters } from 'vuex'

import { tracked } from '../utilities/load-tracking'
import { NO_TECH_CHOICES, candidateText, loadTechChoices, readScenario, registerTechScenarios, resolveChoices, saveChoice, scopeOf, selectionOf } from '../utilities/tech-scenarios'

// What a page that uses `techLevels` names for its read of the race's tech in INPUT_LABELS.
export const TECH_INPUT_LABELS = Object.freeze({ tech: 'the race\'s tech lines, researched levels and research graph' })

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The tech levels of the open save as a page designs with them, the researched/hypothetical contract of the Propulsion Planner and the Missile Designer (utilities/tech-scenarios.js): each line starts at the level the game designs with, can be set to another level the race has researched (kept for the race as `techChoice`), or to a next level it has not researched, which is a hypothetical choice kept in the scenario record of the race on the branch and marks every figure built on it. `lines` is [{ type, label }], the tech types the page lists.
//
// The page declares `techChoice: techChoiceField('<key>')` in its own `persistedView` (a component takes one persisted view: two share their method names), provides `count` (mixins/count-format) and a tracked `tech` among its INPUT_LABELS (TECH_INPUT_LABELS). The mixin gives `tech` (the lines with their candidates), `techResolution` (every line resolved), `techLines` (the menu), `techChoiceCount`, `unresolvedChoices`, `scenarioNotice` and the methods `setTech`, `chooseNextTech` and `forgetChoice`.
export const techChoiceField = (key) => ({ key, default: {}, scope: 'race', valid: isObject })

export default function techLevels ({ lines }) {
  return {
    data () {
      return {
        // The hypothetical choices that could not be written to the scenario record, by tech type: they hold for this page only.
        heldChoices: {},
        // Why the last choice was not kept in the record, and a count that makes the record be read again after a write.
        scenarioMessage: '',
        scenarioRevision: 0,
      }
    },
    computed: {
      ...mapGetters(['database', 'GameID', 'RaceID', 'GameTime']),

      context () {
        return { GameID: this.GameID, RaceID: this.RaceID }
      },

      // The campaign and branch of the open save once settled, and the scope of its scenario records: null until both are known.
      scope () {
        return scopeOf({ campaign: this.$store.getters['history/campaign'], RaceID: this.RaceID, gameTime: this.GameTime })
      },

      // The scenario record of the race on the branch as the open save reads it (see readScenario).
      scenario () {
        return { ...readScenario(this.records ? this.records.repository : null, this.scope, this.tech), revision: this.scenarioRevision }
      },

      // The hypothetical choices as the lines resolve them: the record's, then the ones that could only be kept for this page. A choice cleared for this page only (null) hides the record's choice of its line.
      scenarioSelection () {
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
      techResolution () {
        return resolveChoices(this.tech, selectionOf(this.techChoice, this.scenarioSelection))
      },

      techChoiceCount () {
        return lines.filter(({ type }) => this.techResolution[type] && this.techResolution[type].level && this.techResolution[type].level !== this.tech.lines[type].pick).length
      },

      // The menu of the lines: the researched levels, the next levels as hypothetical candidates, and what the line is resolved to.
      techLines () {
        return lines.map(({ type, label }) => {
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

      unresolvedChoices () {
        return this.techLines.filter((line) => line.unresolved).map((line) => ({ type: line.type, text: line.unresolvedText }))
      },

      // Why a record's choices are not all applied or kept: a write that failed, a file that cannot be read or made at another game time or by another version.
      scenarioNotice () {
        const parts = [this.scenarioMessage, this.records && this.records.error ? `The scenario records are not available (${this.records.error}), so the choice is kept for this page only.` : '', this.scenario.error ? `The scenario records cannot be read (${this.scenario.error.message}), so saved choices are not applied.` : '', ...this.scenario.notes.map((note) => note.reason)]

        return parts.filter(Boolean).join(' ')
      },
    },
    watch: {
      // Another save, or another race of it, has none of the choices held for the last.
      context () {
        this.heldChoices = {}
        this.scenarioMessage = ''
      },

      database () {
        this.heldChoices = {}
        this.scenarioMessage = ''
      },
    },
    methods: {
      // A researched level other than the game's pick is remembered; the pick itself is forgotten, so a later research moves it on. A line has one choice: a researched level replaces a hypothetical one.
      setTech (type, id) {
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
      async chooseNextTech (type, id) {
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
      async dropScenarioChoice (type) {
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
      forgetChoice (type) {
        const choice = { ...this.techChoice }

        delete choice[type]
        this.techChoice = choice

        return this.dropScenarioChoice(type)
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
        async get () {
          try {
            const records = await import('../utilities/scenario-records')

            registerTechScenarios(records.registerAdapter)

            return Object.freeze({ repository: records.openScenarioRecords(), error: null })
          } catch (error) {
            return Object.freeze({ repository: null, error: error.message })
          }
        },
        default: null,
      },
    },
  }
}
