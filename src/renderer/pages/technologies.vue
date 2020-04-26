<template>
  <div>
    <div class="mb-5" v-if="!RaceID">Select a race from the left-side menu to highlight researched technologies.</div>

    <v-treeview :items="technologyTree" item-key="TechSystemID" activatable hoverable :open-all="false">
      <template #label="{ item, active }">
        <span :class="{
          'green--text font-weight-bold': researchedTechnologyIds.includes(item.TechSystemID),
        }">{{ item.Name }}</span>

        <p class="overline mb-0" v-if="item.parents.length > 1 && active">
          Requires <span v-for="(parent, index) in item.parents" :key="parent"><span class="font-weight-bold">{{ getTechnology(parent).Name }}</span><span v-if="index + 1 < item.parents.length">, </span></span>
        </p>
      </template>
    </v-treeview>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

export default {
  components: {},
  data() {
    return {
      individualTechnologies: {},
    }
  },
  methods: {
    //
    getTechnology(id) {
      return this.individualTechnologies[id]
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
          console.log('!!! ALERT', identifier)
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
      }
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

    technologyTree() {
      this.individualTechnologies['ConventionalStart'] = {
        TechSystemID: 'ConventionalStart',
        Name: 'Conventional Start',

        children: [],
        parents: [],
      }
      
      this.individualTechnologies['TransnewtonianStart'] = {
        TechSystemID: 'TransnewtonianStart',
        Name: 'Transnewtonian Start',

        children: [],
        parents: [],
      }

      this.individualTechnologies['ConventionalStart'].children.push(this.individualTechnologies['TransnewtonianStart'])

      this.technologies.forEach(technology => {
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

      return [this.individualTechnologies['ConventionalStart']]
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

    technologies: {
      async get() {
        if (!this.database) {
          return []
        }

        return await this.database.query(`select FCT_TechSystem.* from FCT_TechSystem where FCT_TechSystem.GameID = 0`).then(([ items ]) => {
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

        return await this.database.models.race.findByPk(this.RaceID).then(race => {
          console.log('Race', race)

          return race
        })
      },
      default: {},
    }
  },
  watch: {
    //
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped>

</style>
