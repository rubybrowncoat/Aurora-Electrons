<template>
  <div>
    <div class="mb-5" v-if="!RaceID">Select a race from the left-side menu to highlight researched technologies.</div>

    <v-container fluid v-else>
      <v-row justify="start">
        <v-col cols="12">
          <v-btn-toggle class="d-block" v-model="selectedFields" :color="$vuetify.theme.dark ? 'purple lighten-3' : 'deep-purple accent-3'" tile dense group multiple borderless>
            <v-btn v-for="field in fields" :key="field.ResearchFieldID" :value="field.ResearchFieldID">
              <v-sheet v-if="field.Abbreviation" class="d-inline-block px-2 mr-2 font-weight-bold overline" :elevation="1" dark :color="makeColor(field.Abbreviation)">{{ field.Abbreviation }}</v-sheet>
              {{ field.FieldName }}
            </v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="12">
          <v-text-field v-model="search" hint="Search Technology by Name" placeholder="Technology Name" solo persistent-hint clearable dense></v-text-field>
        </v-col>
        <v-col cols="12">
          <v-treeview :items="technologyTree" :search="search" item-key="TechSystemID" item-text="Name" activatable hoverable open-on-click :open-all="false">
            <template #label="{ item }" class="green--background">
              <div class="pa-1">
              <span>
                <v-sheet v-if="item.Abbreviation" :style="{
                  fontFamily: 'Monaco, monospace',
                }" class="d-inline-block px-3 font-weight-bold" :elevation="1" dark :color="makeColor(item.Abbreviation)">{{ item.Abbreviation }}</v-sheet>
                {{ item.Name }}
                <v-btn class="ml-3" color="red" dark x-small v-if="!researchedTechnologyIds.includes(item.TechSystemID)">{{ item.DevelopCost || 0 }}RP</v-btn>
              </span>

              <p class="overline mb-0" v-if="item.parents.length > 1">
                Requires <span v-for="(parent, index) in getTechedParents(item)" :key="parent.TechSystemID"><span class="font-weight-bold" :class="[ researchedTechnologyIds.includes(parent.TechSystemID) ? 'green--text' : 'red--text text--lighten-1' ]">{{ parent.Name }}</span><span v-if="index + 1 < item.parents.length"> and </span></span>
              </p>
              </div>
            </template>
          </v-treeview>
        </v-col>
      </v-row>
    </v-container>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

import ColorHash from 'color-hash'

const hasher = new ColorHash({ lightness: [0.3, 0.4, 0.5], saturation: [0.35, 0.5, 0.65] })
const darkHasher = new ColorHash({ lightness: [0.4, 0.5, 0.6], saturation: [0.45, 0.6, 0.75] })

export default {
  components: {},
  data() {
    return {
      search: '',
      selectedFields: [],

      individualTechnologies: {},
      technologyTree: [],
    }
  },
  methods: {
    makeColor(string) {
      return this.$vuetify.theme.dark ? darkHasher.hex(string) : hasher.hex(string)
    },

    //
    getTechnology(id) {
      return this.individualTechnologies[id]
    },
    getTechedParents(technology) {
      return technology.parents.map(parent => this.getTechnology(parent))
    },

    addTechnology(technology) {
      this.individualTechnologies[technology.TechSystemID] = {
        ...technology,

        children: [],
        parents: [],
      }
    },

    addToParent(technology, identifier) {
      if (!this.individualTechnologies[identifier]) {
        const foundParent = this.technologies.find(tech => tech.TechSystemID === identifier)

        if (foundParent) {
          this.addTechnology(foundParent)
        } else {
          console.log('!!! ALERT', identifier, technology.Name)
        }
      }

      const parent = this.individualTechnologies[identifier]

      if (parent) {
        parent.children.push(technology)

        parent.children.sort((alpha, beta) => {
          const alphaChildren = alpha.children.length
          const betaChildren = beta.children.length

          if (alpha.children.length === beta.children.length) {
            return alpha.Name.localeCompare(beta.Name)
          }

          return betaChildren - alphaChildren
        })

        if (!technology.parents.includes(identifier)) {
          technology.parents.push(identifier)
        }
      } else if (!technology.parents.length) {
        this.addToParent(technology, 'TransnewtonianStart')
      }
    },

    makeTechnologyTree() {
      this.individualTechnologies = {}

      const conventionalStart = this.individualTechnologies['ConventionalStart'] = {
        TechSystemID: 'ConventionalStart',
        Name: 'Conventional Start',

        children: [],
        parents: [],
      }
      
      const transnewtonianStart = this.individualTechnologies['TransnewtonianStart'] = {
        TechSystemID: 'TransnewtonianStart',
        Name: 'Transnewtonian Start',

        children: [],
        parents: [],
      }

      this.technologies
      .filter(technology => !this.selectedFields.length || this.selectedFields.includes(technology.ResearchFieldID))
      .forEach(technology => {
        if (!this.individualTechnologies[technology.TechSystemID]) {
          this.addTechnology(technology)
        }

        const child = this.individualTechnologies[technology.TechSystemID]

        if (technology.ConventionalSystem) {
          this.addToParent(child, 'ConventionalStart')
        } else if (technology.Prerequisite1 || technology.Prerequisite2) {
          if (technology.Prerequisite1) {
            this.addToParent(child, technology.Prerequisite1)
          }

          if (technology.Prerequisite2) {
            this.addToParent(child, technology.Prerequisite2)
          }
        } else {
          this.addToParent(child, 'TransnewtonianStart')
        }
      })

      if (transnewtonianStart.children.length) {
        this.addToParent(transnewtonianStart, 'ConventionalStart')
      }

      this.technologyTree = [conventionalStart]
    },
  },
  computed: {
    ...mapGetters([
      'database',
      
      'GameID',
      'RaceID',
    ]),
    
    researchedTechnologyIds() {
      const base = ['ConventionalStart']
      const currentlyResearchedIds = this.researchedTechnologies.map(tech => tech.TechID)

      if ((this.race.RaceID && !this.race.ConventionalStart) || currentlyResearchedIds.includes(27434)) {
        base.push('TransnewtonianStart')
      }

      return [...base, ...currentlyResearchedIds]
    },
  },
  asyncComputed: {
    researchedTechnologies: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        return await this.database.query(`select FCT_RaceTech.TechID, FCT_Race.RaceID, FCT_Race.RaceTitle from FCT_RaceTech join FCT_Race on FCT_Race.GameID = FCT_RaceTech.GameID and FCT_Race.NPR = 0 and FCT_RaceTech.RaceID = FCT_Race.RaceID where FCT_RaceTech.GameID = ${this.GameID}`).then(([ items ]) => {
          console.log('Researched Technologies', items)

          return items
        })
      },
      default: [],
    },

    fields: {
      async get() {
        if (!this.database) {
          return []
        }

        return await this.database.query(`select DIM_ResearchField.* from DIM_ResearchField where DIM_ResearchField.DoNotDisplay <> 1`).then(([ items ]) => {
          console.log('Research Fields', items)

          return items
        })
      },
      default: [],
    },

    technologies: {
      async get() {
        if (!this.database) {
          return []
        }

        return await this.database.query(`select FCT_TechSystem.*, DIM_TechType.*, DIM_ResearchField.* from FCT_TechSystem left join DIM_TechType on FCT_TechSystem.TechTypeID = DIM_TechType.TechTypeID left join DIM_ResearchField on DIM_TechType.FieldID = DIM_ResearchField.ResearchFieldID where FCT_TechSystem.GameID = 0 and DIM_ResearchField.DoNotDisplay != 1`).then(([ items ]) => {
          console.log('Technologies', items)

          return items
        })
      },
      default: [],
    },

    race: {
      async get() {
        if (!this.database || !this.RaceID) {
          return {}
        }

        return await this.database.models.Race.findByPk(this.RaceID).then(race => {
          console.log('Race', race)

          return race
        })
      },
      default: {},
    }
  },
  watch: {
    technologies(newTechnologies) {
      console.log('TECHNOLOGIES CHANGE')
      this.makeTechnologyTree()
    },
    selectedFields() {
      console.log('SELECTEDFIELDS CHANGE')
      this.makeTechnologyTree()
    },
  },
  mounted() {
    //
    window.explore = this
  },
}
</script>

<style lang="scss" scoped>

</style>
