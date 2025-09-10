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
          <v-col cols="6" lg="4">
            <v-checkbox v-model="hideNonCustomized" label="Hide Non-Customized Events"></v-checkbox>
          </v-col>
          <v-col cols="6" lg="4">
            <v-select v-model="activeTypes" :items="logEventTypes" item-text="Description" item-value="EventTypeID"
              label="Select Active Event Types" multiple>
              <template v-slot:selection="{ item, index }">
                <v-chip v-if="activeTypes.length === logEventTypes.length && index === 0" small>
                  All Event Types
                </v-chip>
                <span v-else-if="index === 0" class="grey--text text--darken-1 caption">{{ activeTypes.length }}
                  types</span>
              </template>
            </v-select>
          </v-col>
          <v-col cols="12">
            <v-progress-linear v-if="loadingEvents" indeterminate color="yellow darken-2"></v-progress-linear>
            <v-virtual-scroll :items="filteredLogEvents" item-height="64" bench="5" :style="{
              height: 'calc(100vh - 362px)',
            }">
              <template #default="{ item: event }">
                <v-list-item :style="{
                  height: '64px',
                  backgroundColor: event.AlertColourRGBA || 'transparent',
                  color: event.TextColourRGBA || 'inherit',
                }">
                  <v-list-item-content>
                    <v-list-item-title>
                      <v-icon v-if="hasEventIcon(event)" :style="{
                        color: event.TextColourRGBA || 'initial',
                        marginRight: '6px',
                      }">{{ eventIcon(event) }}</v-icon>
                      {{ event['LogEventType.Description'] }}
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
                              marginTop: '-4px',
                              marginLeft: '4px',
                              color: event.TextColourRGBA || 'initial',
                            }" x-small v-on="on">
                              <v-icon>mdi-earth</v-icon>
                            </v-btn>
                          </template>
                          <span>Go to related Body</span>
                        </v-tooltip>
                      </template>
                    </v-list-item-title>
                    <v-list-item-subtitle style="color: inherit;">
                      {{ event.DateTime }}
                      <span v-if="event['LogEventType.Description']"> //
                        <v-tooltip top>
                          <template v-slot:activator="{ on }">
                            <span v-on="on">
                              {{ event.MessageText }}</span>
                          </template>
                          <span>{{ event.MessageText }}</span>
                        </v-tooltip></span>
                    </v-list-item-subtitle>
                  </v-list-item-content>
                </v-list-item>
              </template>
            </v-virtual-scroll>

            <!-- <v-simple-table>
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
                    }" v-if="activeTypes.includes(event.EventType)">
                      <td>{{ event.DateTime }}</td>
                      <td>{{ event['LogEventType.Description'] }}</td>
                      <td  class="py-3">
                        <v-icon v-if="hasEventIcon(event)" :style="{
                                color: event.TextColourRGBA || 'initial',
                              }">{{ eventIcon(event) }}</v-icon>
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
                                color: event.TextColourRGBA || 'initial',
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
            </v-simple-table> -->
          </v-col>
        </v-row>
      </v-container>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import { separatedNumber } from '../../utilities/math'
import { eventColorToRGBA, populationName } from '../../utilities/aurora'
import dayjs from 'dayjs'
import { has } from 'lodash'

const secondsPerYear = 31536000

export default {
  components: {},
  data() {
    return {
      loadingEvents: true,

      activeTypes: [],
      eventIcons: {
        0: "mdi-help-circle-outline",     // No Event Type
        1: "mdi-factory",                 // Production
        2: "mdi-ferry",                   // Ship Construction
        3: "mdi-wrench",                  // Ship Repair
        4: "mdi-swap-horizontal",         // Ship Refit
        7: "mdi-delete",                  // Ship Scrapped
        9: "mdi-shield-account",          // Unit Trained
        10: "mdi-account-cog",            // Commander Update
        11: "mdi-shield",                 // Shield Recharge
        12: "mdi-crosshairs",             // Targeting
        14: "mdi-crosshairs-question",    // Targeting Problem
        15: "mdi-rocket",                 // Missile Launch
        16: "mdi-ammunition",             // Out of Ammo
        17: "mdi-rocket-off",             // No Missile Assigned
        18: "mdi-timer-sand",             // Weapon Reloading
        19: "mdi-bullseye-arrow",         // Chance To Hit
        20: "mdi-bullseye",               // Target Hit
        21: "mdi-bullseye-off",           // Target Missed
        22: "mdi-flash-outline",          // Weapon Recharging
        25: "mdi-check-circle",           // System Intact
        26: "mdi-bomb",                   // Secondary Explosion
        27: "mdi-ferry-sink",             // Ship Destroyed
        28: "mdi-file-document-alert",    // Damage Report
        35: "mdi-account-star",           // Team Skill
        37: "mdi-radar",                  // System Surveyed
        41: "mdi-clipboard-text",         // Orders Assigned
        42: "mdi-clipboard-alert",        // Orders Not Possible
        43: "mdi-diamond-stone",          // Minerals Located
        44: "mdi-domain",                 // Ruins Located
        45: "mdi-clipboard-check",        // Orders Completed
        46: "mdi-gas-station-off",        // Insufficient Fuel
        52: "mdi-eye-off",                // Target Lost
        53: "mdi-rocket-launch-outline",  // Missiles Lost
        54: "mdi-transit-transfer",       // Transit Failure
        55: "mdi-message-processing",     // Communication
        57: "mdi-domain",                 // Ruins Exploited
        58: "mdi-cog-off",                // No Spare Parts
        59: "mdi-wrench-check",           // Successful Repair
        60: 'mdi-flask',                  // Research Completed
        63: 'mdi-flask-empty-remove',     // Inactive Lab
        64: "mdi-alert-decagram",         // Mineral Shortage
        65: "mdi-fuel",                   // Low Fuel
        66: "mdi-diamond-outline",      // Mineral Exhausted
        71: "mdi-gas-station-off-outline",// Fuel Exhausted
        75: "mdi-shield-sword",           // Ground Combat Update
        76: "mdi-weather-windy",          // Gas Removed
        77: "mdi-leaf",                   // Terraforming Report
        80: "mdi-barrel",                 // Harvester Capacity
        81: "mdi-snowflake-melt",         // Ice Sheet Melted
        82: "mdi-emoticon-happy-outline", // Morale Increase
        83: "mdi-archive-arrow-down-outline", // Pickup Failed
        87: "mdi-bridge",                 // Jump Gate Underway
        88: 'mdi-flask-plus',             // Research Started
        90: "mdi-account-arrow-up",       // Commander Promoted
        91: "mdi-ray-start-end",          // Conditional Order
        92: "mdi-timer-off",              // Life Pod Expired
        93: "mdi-magnify-scan",           // Search and Rescue
        97: "mdi-chip",                   // System Damaged
        98: "mdi-account-plus",           // New Naval Officer
        99: "mdi-heart-pulse",            // Commander Health
        100: "mdi-mine",                  // Mine Restored
        101: "mdi-factory",               // Factory Restored
        106: "mdi-account-search",        // Intelligence Update
        107: "mdi-email",                 // Fleet Message
        108: "mdi-robot-dead",            // Wreck Salvaged
        111: "mdi-cog-outline",           // Components Scrapped
        115: "mdi-home-city",             // Pop Status Change
        116: "mdi-vector-polyline-remove",// Insufficient JGC
        117: "mdi-dots-horizontal",       // Message Continued
        119: "mdi-timer-outline",         // Fire Delay
        122: "mdi-cog-stop",              // Overhaul Complete
        125: "mdi-crane",                 // Shipyard Modified
        127: "mdi-download-network",      // Tech Downloaded
        128: "mdi-magnify-scan",          // Tech Data Scanned
        129: "mdi-account-tie",           // Command Assignment
        133: "mdi-office-building",       // Civilian Construction
        135: "mdi-gas-station-off",       // Fuel Shortage
        138: "mdi-asteroid",              // Jump Point Detected
        139: "mdi-domain",                // Civilian Activity
        140: "mdi-block-helper",          // Illegal Order
        141: "mdi-diamond-stone",         // New Mineral Deposit
        142: "mdi-trending-up",           // Accessibility Increase
        143: "mdi-radar",                 // Geo Survey Complete
        145: "mdi-tools",                 // No Freighter Overhaul
        146: "mdi-wrench-cog",            // Maintenance Problem
        147: "mdi-alien",                 // New Alien Race
        148: "mdi-emoticon-angry-outline",// Unrest Increasing
        149: "mdi-emoticon-happy-outline",// Unrest Decreasing
        155: "mdi-emoticon-happy-outline",// Morale Increase
        157: "mdi-incognito",             // Successful Espionage
        169: "mdi-tune",                  // Increment Adjustment
        173: "mdi-hand-coin",             // Reparations
        174: "mdi-sack",                  // Planet Looted
        177: "mdi-alert-octagram",        // Overkill
        178: "mdi-handshake",             // Ship Surrender
        179: "mdi-earth",                 // Breathable Atmosphere
        180: "mdi-handshake-outline",     // Diplomacy
        181: "mdi-target-account",        // New Hostile Contact
        182: "mdi-account-question",      // New Neutral Contact
        183: "mdi-account",               // New Friendly Contact
        184: "mdi-account-multiple",      // New Allied Contact
        186: "mdi-ferry",                 // Wreck Contact
        187: "mdi-package-variant-closed",// Mineral Packet Contact
        191: "mdi-ferry",                 // Civilian Contact
        195: "mdi-earth-plus",            // New System Discovered
        200: "mdi-rocket-off",            // Missile Self-destruct
        201: "mdi-timer-minus",           // Overhaul Clock Reduced
        203: "mdi-thermometer-off",       // Thermal Contact Lost
        204: "mdi-radar-off",             // GPD Contact Lost
        206: "mdi-target-account",        // Hostile Contact Update
        207: "mdi-account-question",      // Neutral Contact Update
        208: "mdi-account",               // Friendly Contact Update
        209: "mdi-account-multiple",      // Allied Contact Update
        210: "mdi-ferry",                 // Civilian Contact Update
        211: "mdi-mine",                  // Civilian Mining Colony
        212: "mdi-ferry",                 // New Shipping Line
        215: "mdi-star-circle",           // Outstanding New Officer
        216: "mdi-star",                  // Exceptional New Officer
        217: "mdi-star-outline",          // Promising New Officer
        218: "mdi-file-chart",            // Geological Survey Data
        219: "mdi-arm-flex",              // Boarding Attempt
        220: "mdi-sword-cross",           // Boarding Combat
        221: "mdi-account-remove",        // Crew Losses
        224: "mdi-cog",                   // Wreck Components
        227: "mdi-car-arrow-right",       // Ramming Attempt
        228: "mdi-cash-remove",           // Empire in Debt
        229: "mdi-flask-minus",           // Overallocation of Labs
        232: "mdi-radar",                 // New Alien Class
        233: "mdi-rocket",                // New Alien Ship
        235: "mdi-account-star",          // Crew Grade Increase
        237: "mdi-shield-off",            // Shield Deactivation
        238: "mdi-file-document",         // Tech Data Learned
        245: "mdi-magnet",                // Tractor(s) Released
        252: "mdi-emoticon-sad-outline",  // Crew Morale Falling
        253: "mdi-beach",                 // Shore Leave Complete
        254: "mdi-air-humidifier-off",    // Life Support Failure
        255: "mdi-gas-station-off",       // Probe Out of Fuel
        256: "mdi-account-tie",           // New Administrator
        257: "mdi-account",               // New Scientist
        258: "mdi-handcuffs",             // POWs Rescued
        260: "mdi-alpha-a-box",           // Ancient Construct
        265: "mdi-clock-outline",         // Time Check
        266: "mdi-truck-fast-outline",    // Invalid Unload System
        276: "mdi-progress-close",        // Conversion Halted
        277: "mdi-lifebuoy",              // Lifepods Launched
        278: "mdi-run-fast",              // Crew Escape
        279: "mdi-account-group-outline", // Insufficient Population
        280: "mdi-star-four-points",      // Commander Experience
        281: "mdi-trash-can",             // Replacement Unit Disbanded
        282: "mdi-restore-alert",         // Recovery Failure
        283: "mdi-account-group",         // Ship Overcrowded
        284: "mdi-terrain",               // Change to Dominant Terrain
        285: "mdi-crosshairs",            // New Combat Contact
        286: "mdi-account-cog",           // Admin Command Update
        287: "mdi-school-off",            // Training Task Abandoned
        288: "mdi-home-search",           // Ground Survey Potential
        289: "mdi-account-tie",           // Senior Officer Required
        290: "mdi-school",                // Maximum Fleet Training
        291: "mdi-account-plus",          // New Ground Force Officer
        292: "mdi-account-cancel",        // Retirement
        293: "mdi-earth",                 // New Alien Population
        294: "mdi-beaker-alert",          // Acid Burn
        295: "mdi-ship-wheel",            // Intact Ship Salvaged
        296: "mdi-medal",                 // Medal Awarded
        297: "mdi-sword-cross",           // Boarding Underway
        298: "mdi-account-group",         // New Alien Ground Unit
        299: "mdi-lightbulb-on",          // Breakthrough Achieved
        300: "mdi-crosshairs",            // Ground Attack Summary
        301: "mdi-file-document-multiple",// Element Loss Summary
        302: "mdi-file-document-multiple",// Attack vs GUC Summary
        303: "mdi-shield-home",           // Ground Defence Summary
        304: "mdi-file-document",         // Element vs GUC Report
        305: "mdi-file-document",         // Ship vs GUC Report
        306: "mdi-file-document-multiple",// GUC vs GUC Summary
        307: "mdi-file-document-multiple",// Formation Attack Summary
        308: "mdi-file-document-multiple",// Formation Loss Summary
        309: "mdi-file-document-multiple",// Orbital vs GUC Summary
        310: "mdi-swap-horizontal",       // Orbital Support Reassigned
        311: "mdi-swap-horizontal",       // Ground Support Reassigned
        312: "mdi-domain",                // Installations Salvaged
        313: "mdi-target-variant",        // Target Out of Range
        314: "mdi-eye",                   // Ground Combat Intelligence
        315: "mdi-translate",             // Alien Communication
        316: "mdi-snowflake",             // Ice Sheet Frozen
        317: "mdi-school-off",            // Shipyard Task Abandoned
        318: "mdi-school-off",            // Training not Possible
        319: "mdi-airplane",              // Fighter Construction
        320: "mdi-factory",               // Production Started
        321: "mdi-timer-alert",           // Deployment Time Exceeded
        322: "mdi-account-off",           // Commander Unassigned
        323: "mdi-school",                // Formation Training Task
        324: "mdi-nuke",                  // Planet Destroyed
        325: "mdi-account-reactivate",    // Commander Restored
        326: "mdi-bomb-off",              // Incorrect Ordnance
        327: "mdi-swap-vertical",         // Fleet Transfer
        328: "mdi-factory-off",           // Installation Scrapped
        329: "mdi-shield-off",            // Ground Units Scrapped
        330: "mdi-shield-sun-outline",    // Orbital Support Summary
        331: "mdi-shield-sun",            // Energy Point Defence
        332: "mdi-shield-home-outline",   // STO Point Defence
        333: "mdi-shield-airplane-outline",// AMM Point Defence
        334: "mdi-ship-wheel",            // Ship Combat - Energy
        335: "mdi-rocket",                // Ship Combat - Missile
        336: "mdi-shield-home",           // STO Combat
        337: "mdi-bullseye",              // Missile vs Ship
        338: "mdi-crosshairs",            // Attacked by STO
        339: "mdi-flash",                 // Attacked By Energy Weapons
        340: "mdi-rocket",                // Attacked By Missiles
        341: "mdi-shield",                // Attacked By AA Fire
        342: "mdi-sword-cross",           // Boarding Damage
        343: "mdi-beaker-alert",          // Acid Damage
        344: "mdi-home-alert",            // Collaterall Damage
        345: "mdi-file-document-alert",   // Damage Summary
        346: "mdi-shield-airplane",       // Fighter Point Defence
        347: "mdi-airplane",              // Fighter Combat - Energy
        348: "mdi-airplane",              // Fighter Combat - Missile
        349: "mdi-shield-check",          // Fleet PD Summary
        350: "mdi-ferry",                 // Civilian Ship Scrapped
        351: "mdi-hammer-wrench",         // Damage Control
        352: "mdi-bomb",                  // Bombardment Summary
        353: "mdi-timer-sand-paused",     // Transit Delay
        354: "mdi-shield-home",           // Population PD Summary
        355: "mdi-dots-horizontal",       // (unused)
        356: "mdi-ferry",                 // New Wreck Detected
        357: "mdi-robot-dead",            // Alien Salvage
        358: "mdi-test-tube",             // Test Data
        359: "mdi-archive-arrow-down",    // Ground Unit Unloaded
        360: "mdi-warehouse",             // Stockpile Warning
        361: "mdi-cog-off",               // Maintenance Failure
        362: "mdi-account-question",      // Neutral Contact Update - AC
        363: "mdi-account",               // Friendly Contact Update - AC
        364: "mdi-account-multiple",      // Allied Contact Update - AC
        365: "mdi-car-arrow-right",       // Successful Ramming Attack
        366: "mdi-car-arrow-left",        // Ship Rammed
        367: "mdi-account-search",        // Interrogation Update
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
      const filteredByType = this.logEvents.filter(event => this.activeTypes.includes(event.EventType))

      if (this.hideNonCustomized) {
        return filteredByType.filter(event => event['LogEventType.LogEventColours.AlertColour'] || event['LogEventType.LogEventColours.TextColour'])
      }

      return filteredByType
    },
  },
  asyncComputed: {
    logEventTypes: {
      async get() {
        if (!this.database) {
          return []
        }

        const logEventTypes = await this.database.models.LogEventType.findAll({
          include: [{
            required: false,
            model: this.database.models.LogEventColour,
            where: {
              RaceID: this.RaceID,
            },
          }],
          order: [['Description', 'ASC']],
        })

        this.activeTypes = logEventTypes.map(type => type.EventTypeID)

        return logEventTypes
      },
    },
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
          })

        this.loadingEvents = false

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
