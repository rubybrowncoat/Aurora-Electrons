<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <div v-else>
      <v-container fluid>
        <v-row justify="start">
          <v-col cols="12">
            <div class="display-1">
              Full Game Log
            </div>
          </v-col>
          <v-col cols="6" md="4">
            <v-checkbox
              v-model="hideNonCustomized"
              label="Hide Non-Customized Events"
            ></v-checkbox>
          </v-col>
          <v-col cols="12">
            <v-simple-table>
              <template v-slot:default>
                <thead>
                  <tr>
                    <th style="width: 165px;">Date/Time</th>
                    <th style="width: 135px;">Type</th>
                    <th>Event</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="(event, index) in filteredLogEvents">
                    <tr :key="index" :style="{
                      backgroundColor: event.AlertColourRGBA || 'transparent',
                      color: event.TextColourRGBA || 'inherit',
                    }">
                      <td>{{ event.DateTime }}</td>
                      <td>{{ event['LogEventType.Description'] }}</td>
                      <td  class="py-3">
                        <v-icon v-if="hasEventIcon(event)" dark>{{ eventIcon(event) }}</v-icon>
                        {{ event.MessageText }}
                        <template v-if="event['Population.PopulationID']">
                          <v-tooltip top>
                            <template v-slot:activator="{ on }">
                              <v-btn icon :to="{
                                path: 'habitability',
                                query: {
                                  bodies: JSON.stringify([{
                                    SystemBodyID: event['Population.SystemBody.SystemBodyID'],
                                    SystemBodyName: event['Population.SystemBody.Name'],
                                    SystemName: event['System.RaceSystemSurveys.Name'],
                                    BodyClass: event['Population.SystemBody.BodyClass'],
                                    Component: event['Population.SystemBody.Star.Component'],
                                    PlanetNumber: event['Population.SystemBody.PlanetNumber'],
                                    OrbitNumber: event['Population.SystemBody.OrbitNumber'],
                                  }])
                                },
                              }" :style="{
                                color: event.TextColourRGBA || 'inherit',
                              }" x-small v-on="on">
                                <v-icon>mdi-earth</v-icon>
                              </v-btn>
                            </template>
                            <span>Go to related Body</span>
                          </v-tooltip>
                        </template>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </template>
            </v-simple-table>
          </v-col>
        </v-row>
      </v-container>
    </div>
  </div>
</template>

<script>
import { remote } from 'electron'

import { mapGetters } from 'vuex'

import romanum from 'romanum'

import { convertDisplayBase } from '../../utilities/generic'
import { separatedNumber, roundToDecimal } from '../../utilities/math'
import { eventColorToRGBA, populationName } from '../../utilities/aurora'
import dayjs from 'dayjs'
import { has } from 'lodash'

const secondsPerYear = 31536000

export default {
  components: {},
  data() {
    return {
      eventIcons: {
        60: 'mdi-flask',
        63: 'mdi-flask-empty-remove',
        88: 'mdi-flask-plus',
      },

      //
      hideNonCustomized: false,
    }
  },
  methods: {
    eventColorToRGBA,
    separatedNumber,

    populationName,

    hasEventIcon(event) {
      if (has(this.eventIcons, event.EventType)) {
        return true
      }

      return false
    },
    eventIcon(event) {
      return this.eventIcons[event.EventType]
    }
  },
  computed: {
    ...mapGetters([
      'database',

      'GameID',
      'RaceID',
    ]),

    filteredLogEvents() {
      if (this.hideNonCustomized) {
        return this.logEvents.filter(event => event['LogEventType.LogEventColours.AlertColour'] || event['LogEventType.LogEventColours.TextColour'])
      }

      return this.logEvents
    },
  },
  asyncComputed: {
    logEvents: {
      async get() {
        if (!this.database || !this.GameID) {
          return []
        }

        const logEvents = await this.database.models.LogEvent.findAll({
          where: {
            GameID: this.GameID,
            RaceID: this.RaceID,
          },
          include: [{
            required: true,
            model: this.database.models.Game,
          }, {
            required: true,
            model: this.database.models.LogEventType,
            include: [{
              required: false,
              model: this.database.models.LogEventColour,
              where: {
                RaceID: this.RaceID,
              },
            }],
          }, {
            required: false,
            model: this.database.models.System,
            include: [{
              required: true,
              model: this.database.models.RaceSystemSurvey,
              where: {
                RaceID: this.RaceID,
              },
            }]
          }, {
            required: false,
            model: this.database.models.Population,
            where: {
              RaceID: this.RaceID,
            },
            include: [{
              required: false,
              model: this.database.models.SystemBody,
              include: [{
                required: false,
                model: this.database.models.Star,
              }],
            }]
          }],
          order: [['Time', 'DESC'], ['IncrementID', 'DESC']],
          raw: true,
        })
          .then((items) => {
            console.log('Game LogEvents', items)

            return items.map(event => {
              event.DateTime = dayjs(0).set('year', event['Game.StartYear']).set('hour', 0).add(event.Time, 'second').format('YYYY-MM-DD HH:mm:ss')

              if (event['LogEventType.LogEventColours.AlertColour']) {
                event.AlertColourRGBA = this.eventColorToRGBA(event['LogEventType.LogEventColours.AlertColour'])
              }

              if (event['LogEventType.LogEventColours.TextColour']) {
                event.TextColourRGBA = this.eventColorToRGBA(event['LogEventType.LogEventColours.TextColour'])
              }

              return event
            })

            return items

            // return items.map(construct => {
            //   construct.OwnPopulations = construct.SystemBody.Populations.filter(population => population.RaceID === this.RaceID)
            //   construct.AlienPopulations = construct.SystemBody.Populations.filter(population => population.RaceID !== this.RaceID)

            //   return construct
            // }).filter(construct => !construct.Active || !construct.OwnPopulations.length || !construct.OwnPopulations.filter(population => population.Population > 10).length)
          })
        console.log('Game LogEvents', logEvents)

        return logEvents
      },
      default: [],
    },
  },
  mounted() {
    //
  },
}
</script>

<style lang="scss" scoped></style>
