> **Provenance.** Provided by the maintainer on 6 October 2026 as the most detailed reference available for Aurora's intelligence and diplomacy values. It describes Aurora C# 2.7.1. Where it differs from the docs archive, prefer this file for exact codes and boundaries. The app's plan cites it from `docs/plans/aurcalcs/sql-fleet.md` § 7.

# Aurora C# intelligence mechanics and numeric values

This reference covers alien intelligence, diplomatic contact, communication, electronic intelligence (ELINT), prisoners, species knowledge, ship and ground-force observation, territorial messages, and technology acquired through contact or capture. It describes the local `version/2.7.1` checkout, inspected on 6 October 2026 at commit `096bb4e`. Exact comparisons describe the decompiled implementation; entries labelled tentative retain uncertain symbol meanings.

The central distinction is between a **contact classification**, a **communication state**, **diplomatic points**, and **intelligence points**. These are separate quantities. Numeric code 2 in `ContactStatus` means Friendly; code 2 in `CommStatus` means Communication Established.

Each `FCT_AlienRace` record belongs to a viewing race. A record with `ViewRaceID = A` and `AlienRaceID = B` stores A's knowledge and stance toward B. B's view of A is a separate record. Treaty grants and diplomatic points are directional. The Intelligence window reads the reciprocal record when showing what the alien race grants you; its displayed Diplomacy Rating comes from your own record.

The database status fields decode as follows.

| `FCT_AlienRace.ContactStatus` | Enum name | Meaning |
| ---: | --- | --- |
| 0 | Hostile | Hostile diplomatic/contact classification |
| 1 | Neutral | Neutral diplomatic classification |
| 2 | Friendly | Friendly diplomatic classification |
| 3 | Allied | Allied diplomatic classification |
| 4 | Civilian | Additional contact classification; outside the four ordinary diplomatic policy choices |
| 5 | None | No associated/known diplomatic classification |
| 6 | Combat | Additional combat contact/event classification; outside ordinary diplomatic progression |

`Contact.GetContactStatus()` returns None when no contact race or corresponding alien-race record exists.

| `FCT_AlienRace.CommStatus` | Enum name | Display description |
| ---: | --- | --- |
| 0 | None | No Communication |
| 1 | AttemptingCommunication | Attempting Communication |
| 2 | CommunicationEstablished | Communication Established |
| 3 | CommunicationImpossible | Communication Impossible |

`CommModifier` is accumulated translation progress, not a percentage or another status code. `CommEstablished` is the game time of establishment. `Contact.GetCommunicationStatus()` returns Impossible when the race/record is missing, so that helper's fallback does not prove a translation attempt failed.

New contact records have several possible starting states.

| Creation case | Contact status | Communication | Initial diplomatic points |
| --- | --- | --- | ---: |
| Ordinary foreign contact by a standard race with primary-species Xenophobia other than 100 | Neutral | Attempting | 0 |
| Own race, within that standard-race creation branch | Allied | Established | 10000 |
| Another race with the same capital body, within that branch | Neutral | Established | 40 |
| Hostile first-contact roll succeeds for an NPR | Hostile | Attempting | -1000 |
| Viewing race is special, or its primary species has Xenophobia 100 | Hostile | Impossible | -1000 |
| Full-intelligence bootstrap | Neutral | Established | 0 |

For the hostile first-contact roll, both primary-species Xenophobia and Militancy must exceed 50. The condition is `d100 < Xenophobia + Militancy - 100`. A truce can set `FixedRelationship = 1`. Normal unknown races initially receive a system-based placeholder name. Full bootstrap also supplies known systems/species/classes/ships, colony intelligence at 600, and ground-unit observations of 100 for each observation counter.

Diplomatic thresholds are independent of the integer contact codes.

| Threshold | Diplomatic points | Effect |
| --- | ---: | --- |
| Hostility boundary | -100 | NPR becomes hostile below this; hostile NPR becomes neutral above it |
| Trade treaty | 200 | Grants trade access |
| Geological treaty | 800 | Shares future geological survey results |
| Friendly status | 800 | Allows use of the granting race's jump ships |
| Gravitational treaty | 2400 | Shares future gravitational survey results |
| Allied status | 4000 | Enables allied point-blank missile defence cooperation |
| Technology treaty | 6000 | Shares newly completed generic technology |

NPR automatic grants/promotions use **strictly greater than** the threshold. Treaty revocation and Friendly/Allied downgrades use **strictly less than**. Equality retains the existing state in those checks. Player Friendly/Allied and treaty controls become available at **greater than or equal to** their thresholds. Player policy selection is separate from NPR automatic promotion.

Diplomacy and communication missions require current ship or population detections in both directions in at least one common system. This is a system-level intersection of current contacts; the module ship itself does not have to be the detected object. A qualifying ship carries a Diplomacy Module. The highest relevant ship commander's bonus is selected.

For a record describing A's opinion of B, B's diplomatic ship improves A's opinion. Let `b` be its commander's Diplomacy bonus as a fraction, `X` A's racial Xenophobia, and `y` elapsed game years. With a positive commander bonus:

```text
diplomatic gain = (1 + 4*b) * 100 * (1 - X/100) * y
```

For example, 20% Diplomacy and Xenophobia 40 produce 108 points per year. No mutual contact produces a mission value of zero. Mutual contact with no qualified positive Diplomacy bonus produces a mission value of one and no mission gain. Ordinary point updates require both races to be Standard, `FixedRelationship == 0`, different viewing/target races, and established communication.

Grants received from the other race also improve the record holder's opinion, using these annual base values multiplied by `(1 - X/100)`. These contributions stack, except that Friendly and Allied describe alternative statuses.

| Grant received from the other race | Base diplomatic points/year |
| --- | ---: |
| Trade access | 100 |
| Geological data | 100 |
| Gravitational data | 100 |
| Research data | 200 |
| Friendly status | 100 |
| Allied status | 200 |

When the diplomacy mission value is zero, positive points move toward zero by `X*y`; negative points move toward zero by `(100-X)*y`, clamped at zero. This runs after the grant contributions, within the established-communication update path.

Communication attempts run during the construction-cycle strategic update. Each attempt uses the following score:

```text
R = d100 + CommModifier + floor((Translation_A + Translation_B)/2)
R -= 50 if the target race is a special race
R += 20 if both races have the same primary Species object
```

`d100` means an integer roll from 1 through 100. The attempting record must have state 1. The reciprocal record must exist and have state 1 or 2; a reciprocal None or Impossible stalls the attempt. Missing mutual current contact also prevents a roll.

Let `M = 1 + CommunicationsBonus` for the best qualifying commander. When there is no positive qualifying bonus, the code uses `M = 0.5` for positive progress. The commander's bonus changes the progress award, not the score `R`.

| Score R | Outcome | Change to CommModifier |
| --- | --- | ---: |
| R >= 100 | Communication established | Establishment path; no progress delta |
| 90 < R < 100 | Significant progress | +10*M |
| 80 < R <= 90 | Moderate progress | +5*M |
| 70 < R <= 80 | Minor progress | +3*M |
| 50 < R <= 70 | Minimal progress | +2*M |
| 25 < R <= 50 | Very limited progress | +1*M |
| 0 < R <= 25 | Struggling to make a breakthrough | -1 |
| -25 < R <= 0 | Considering communication impossible | -2 |
| -50 < R <= -25 | Advising communication may be impossible | -3 |
| R <= -50 | Communication impossible | -500 |

Ordinary progress applies the same signed delta to diplomatic points unless the relationship is fixed. Establishment grants +10 diplomatic points to each unfixed record and sets **both records** to Established with the current game time. It reveals each race's self-identification and portrait. Failure applies -100 diplomatic points to the attempting unfixed record. A communication or diplomacy mission may reveal the signal's location; a detected source ship can identify its class as diplomatic. Diplomacy messages also identify the ambassador.

Electronic intelligence uses three separate point pools: sensor intelligence, colony intelligence, and race intelligence. An ELINT module's strength determines interception reach; the ship commander's Intelligence bonus multiplies the point gain.

```text
ELINT interception range in km = 250000 * sqrt(ELINTStrength * target EM signature)
Active-sensor emission signature = max(1, sensor Strength * sensor Resolution)
Sensor IP gain = elapsed subpulse seconds / 86400 * (1 + IntelligenceBonus)
```

Sensor intelligence is shared for the same actual emitting sensor component in the viewing race's sensor catalogue. Each sensor record accumulates at most once per game timestamp. The first ELINT source in range is used; sources are deduplicated, and only the strongest ELINT strength is retained at identical coordinates. Multiple observing ships do not add parallel awards to that same sensor record in one timestamp.

At `Sensor IP >= 100`, crossing from below 100 records the actual sensor resolution and range and emits the classification event. `AlienRaceSensor.GetDisplayName()` and the Intelligence screen's detailed sensor listing require `IP > 100`; at exactly 100 they can still show GPS, the emission product `Strength*Resolution`. Full class revelation sets each active sensor's IP to 500. A random race-intelligence sensor reward adds 200.

For a colony's species Xenophobia `Xp`, and Intelligence multiplier `I = 1 + bonus`:

```text
base colony gain = elapsed subpulse seconds / 86400 * I * (1 - Xp/100)
colony IP gain = base colony gain / 5 if communication is not established
colony IP gain = base colony gain otherwise
race IP contribution = base colony gain * min(1, TotalPopulation/100)
```

Population is measured in millions, so the race contribution reaches full strength at 100 million inhabitants. The general race-IP gain method divides its input by five before communication is established. Thus both colony and race intelligence from this source are reduced to 20% before translation. Each colony record receives one accumulation per timestamp.

Colony information unlocks at the following **strict** thresholds.

| Current colony IP | Information refreshed from the actual colony |
| --- | --- |
| >100 | Population; total counted installations; race portrait becomes visible |
| >200 | Factories; mines; spaceport; cargo shuttle station |
| >300 | Fuel refineries; maintenance facilities; refuelling station; ordnance transfer station |
| >500 | Research labs; ground force construction complexes; naval headquarters; sector command |

The total-installation count includes installations with unit Cost >6. Factories combine construction, ordnance, and fighter factories. Mines combine mines, automated mines, and civilian mining complexes.

Unobserved colonies' current IP decays each increment by the multiplier `1 - 0.25*elapsedYears`. This is a proportional deduction per elapsed interval, not a fixed point loss. `MaxIntelligence` preserves the highest previous IP value. Previously unlocked information remains visible after decay, with red text when current IP no longer exceeds its threshold and green text while current IP still qualifies. Saved facility-presence flags are set when observed present; this refresh routine does not clear them when an installation disappears.

Race intelligence is a spending pool for random discoveries. When `AlienRaceIntelligencePoints > 100`, one gain call subtracts 100 and tries to grant a reward. The code uses a single `if`, so one large gain can trigger only one reward in that call. It makes up to three `d7` selections, stopping at the first eligible result. Points are spent even if none of those three selections succeeds.

| d7 | Possible race-intelligence reward |
| ---: | --- |
| 1 | Complete one unknown generic technology known by the target, with both prerequisites satisfied |
| 2 | Import full gravitational survey information for an eligible system |
| 3 | Import full geological survey information for an eligible system |
| 4 | Obtain a ship-class summary; may reveal a previously unknown class |
| 5 | Obtain knowledge of a previously unknown system |
| 6 | Add 200 IP to an alien active sensor |
| 7 | Learn the target's relationship with another race |

The seven selections have equal chance per roll, but successful rewards need not have equal probability because eligibility differs. The relationship report translates the target's diplomatic points into: war below -100; negative from -100 to below 0; neutral from 0 to below 200; positive from 200 to below 800; friendly from 800 to below 4000; allied at 4000 or above. These report bands are separate from the automatic status-transition comparisons.

Prisoner interrogation requires established communication. Player interrogation runs at an imperial population of at least one million inhabitants with positive effective Naval Headquarters capacity. An NPR population of that size can use capacity one as a fallback.

Enlisted interrogation has nominal capacity `floor(5000 * effective NHQ capacity * elapsedYears)` prisoners per update. Each processed prisoner provides 0.1 race IP before the relationship adjustment below. Groups are ordered by contact-status code, then unprocessed count descending. In the decompiled branch where a group exceeds remaining capacity, the capacity variable is not exhausted afterward; multiple large groups can therefore exceed that nominal aggregate capacity.

For an unprocessed prisoner commander of rank level `r`, the literal implementation is:

```text
C = NHQ capacity * 200 * elapsedYears * (Determination + Xenophobia)/(50*r)
interrogation succeeds if d100 < C
raw commander IP = d((r+1)^3) + d((r+1)^3)
```

Successful interrogation marks the commander Processed. The raw award ranges from 2 to `2*(r+1)^3`. In this formula, higher Determination/Xenophobia increases the computed chance; this is the implementation's expression.

| Record holder's contact status | Enlisted and commander IP adjustment |
| --- | --- |
| Hostile | Full award |
| Neutral | Divide by 2 |
| Friendly | Divide by 5 |
| Allied | Divide by 10 |
| Civilian | Zero |

Species knowledge uses its own codes in `FCT_KnownSpecies.Status`.

| Code | Enum name | Meaning |
| ---: | --- | --- |
| 0 | Discovered | Species identified; environmental tolerances shown as Unknown |
| 1 | Autopsied | Environmental tolerances available |
| 2 | FullyKnown_Tentative | Higher internal knowledge state; name remains tentative; the environmental panel treats it as known |

First recording an alien species creates a species-specific Alien Autopsy research project costing 1000 RP. Completing that project sets its status to Autopsied. Known tolerances include gravity, temperature, oxygen partial pressure, and maximum atmospheric pressure. Rescuing alien lifepods records species discovery and reveals the portrait; taking a population also records species knowledge.

Ship intelligence distinguishes observed class capabilities from individual hull histories.

| Observation/acquisition | Information added |
| --- | --- |
| Active ship contact | Maximum observed TCS; tonnage conversion is 50 tons per HS |
| Thermal ship contact | Maximum observed thermal signature; moving faster than 1 km/s can classify engines as Military or Commercial |
| Shield contact | Maximum observed shield strength = emission strength/30 |
| Any ship contact | Maximum observed speed |
| Observed armour damage/penetration | Maximum recorded armour penetration/strength observation |
| Observed weapon fire | Weapon type, maximum observed quantity/range, and recorded interval between firings |
| Observed energy missile defence | Maximum observed PD shots, total observed shots/hits, and missile-defence flag |
| Observed jamming | Maximum observed sensor, fire-control, or missile jammer strength |
| Salvaged wreck/components | Class size, recovered weapons/sensors, and component background technologies |
| Surrendered ship/full revelation | Actual armour, speed, jump distance, shields, jammer ratings, weapons, sensors, technology list, and class summary |

Individual `FCT_AlienShip` records retain name, class, speed, first detection, last contact time/system/coordinates, shield/armour/penetrating damage, total damage, damage time, and Destroyed/Salvaged flags. A known ship count represents tracked hulls, not the race's complete fleet.

Observed weapon amount is derived from `shots / shotsPerWeapon`. Recorded range and quantity increase when a larger value is observed. `ROF` starts at zero and records a smaller nonzero interval between observation timestamps when the condition qualifies; it is measured in game seconds. The method initializes `LastFired` on first discovery, but its existing-record path does not advance that timestamp. Consequently, treat this stored ROF as an observation artefact rather than a guaranteed true reload time. The class-level PD hit ratio is `TotalEnergyPDHits / TotalEnergyPDShots`; observing PD also flags known classes of ships in the same fleet as having missile defence.

Alien-class combat-role codes are retained with the decompiler's uncertainty.

| `FCT_AlienClass.AlienClassRole` | Name |
| ---: | --- |
| 0 | Unknown |
| 1 | AntiMissileMissile |
| 2 | AntiShipMissile |
| 3 | FastBeam_Tentative |
| 4 | SlowBeam_Tentative |
| 5 | Unknown_Value5 |
| 6 | Unknown_Value6 |

For a newly observed missile launcher, the implementation selects code 1 when component Size >=4, otherwise code 2 if the role is still Unknown. For a newly observed beam weapon, it selects code 3 when `PowerRequirement > 2*RechargeRate`, otherwise code 4 if the role is Unknown. These predicates are more reliable than interpreting the tentative names as confirmed tactical descriptions.

Ground-unit intelligence has three independent observation counters. Crossing each counter's threshold produces its corresponding classification.

| Counter reaches | Threshold | Information |
| --- | ---: | --- |
| Hits observed | 20 | Basic unit type |
| Armour penetrations observed | 20 | Armour strength |
| Units destroyed observed | 20 | Hit-point value |

`RecordCombatObservations` also calls weapon revelation without a 20-observation requirement. The first such revelation provides shots, penetration, and damage for weapon-bearing components.

Ground-combat force estimates improve with consecutive rounds. Let `n` be the consecutive-combat-round count:

```text
displayed error range E = round(200/n) percent
Q = 1 + d(E)/100
estimate = true unit count * Q, or true unit count / Q, chosen randomly
```

The displayed error ranges are 200% after one round, 100% after two, 50% after four, 20% after ten, and 10% after twenty. The estimate is multiplicative, so a 200% label corresponds to a possible factor of up to 3 or down to 1/3, not a symmetric plus/minus 200% count. Known classes are listed individually; unknown classes are pooled. `RollDie(0)` returns zero if rounding eventually makes E zero.

Technology can also arrive through treaties, salvage, and conquest.

| Acquisition route | Exact condition/value |
| --- | --- |
| Technology treaty | Newly completed generic (`RaceID == 0`) technology is completed for recipients when cascading updates are enabled |
| Allied without technology treaty | For `DistributeLowerTech` categories, transfer the recipient's cheapest unknown nonautomatic technology when its cost is strictly below the newly completed technology's cost |
| Trade treaty without technology treaty, status below Allied | Same selection, but recipient technology cost must be strictly below one third of the new technology's cost |
| Nonhostile races sharing the same capital body, without those grants | Same one-third rule in `DistributeLowerTech` categories |
| Random race-IP technology reward | Complete an eligible unknown generic technology whose prerequisites are already satisfied |
| Wreck technology data | Research points = integer truncation of eligible technology cost * recovered percentage/100 |
| Conquered standard-race population, technology capture enabled | For each eligible unknown generic scannable technology, `d100 <= researchLabCount` completes it |
| Transfer to ImperialPopulation, technology capture enabled | Transfers all eligible unknown generic scannable technologies in the inspected transfer path |

Survey treaties distribute new results for systems already known to the recipient. Gravitational sharing marks the survey location and charts its jump points; geological sharing marks the body as surveyed.

Wreck technology generation begins when `d200 <= class Size` in HS. Each generated data entry carries `d20`, or 1-20%, research information; further generation rolls use d128 against a repeatedly halved threshold. Salvage excludes `NoTechScan` entries and generally chooses the cheapest unknown nonautomatic, non-ruin-only technology in the same category with cost no greater than the recovered technology. Command-and-control data has a separate direct selection path. Player salvage research is held aboard ship and downloaded in a system with an owned population having at least one effective research facility, unless HoldTechData is set. The decompiled generator includes an anomalous `randomTechSystem == null && randomTechSystem.AutomaticResearch` condition; these generation rules should not be read as a guarantee of a usable reward.

Territorial protection is another coded field, stored per viewing race, alien race, and system in `FCT_AlienRaceSystemStatus.ProtectionStatusID`.

| Code | Protection/message level |
| ---: | --- |
| 0 | No Protection |
| 1 | Suggest Leave |
| 2 | Request Leave |
| 3 | Request Leave Urgently |
| 4 | Demand Leave |
| 5 | Demand Leave With Threat |

An NPR's generated warning wording also depends on the threat multiplier and estimated time to hostility; the stored protection field and the generated warning are related but separate.

For detected foreign presence in a valued NPR system, the annual point penalty is:

```text
penalty = sqrt(effective detected ship tonnage + 10*detected colony EM)
          * system multiplier * relationship multiplier * NPR Xenophobia/100
```

| Internal SystemValue code/name | Base system multiplier in this routine |
| --- | ---: |
| 0 None | No valued-system intrusion processing |
| 1 Insignificant_Tentative | No valued-system intrusion processing |
| 2 Low | No valued-system intrusion processing |
| 3 Medium | 2.5 |
| 4 High | 5 |
| 5 Extreme | 10 |
| 6 OtherRace_Tentative | 20 |

Friendly halves the multiplier; negative diplomatic points double it. Allied contacts are skipped. Friendly contacts are also skipped below High system value, and fixed relationships are skipped. Shipping-line ships are excluded when the NPR grants Trade Access. Nonmilitary ships with no known weapons count at 10% tonnage. One known unarmed diplomatic ship can receive a 10000-ton allowance where the system value is below Extreme or the observing NPR knows only one system. Positive effective ship tonnage below 1000 is raised to 1000; positive colony EM below 100 is raised to 100.

Let `T` be the resulting threat multiplier and `h = (DiplomaticPoints + 100)/thisUpdatePenalty` after applying the penalty. The NPR chooses the strongest matching message: threat at `T >=16` or `h <2`; demand at `T >=8` or `h <5`; urgent request at `T >=4` or `h <10`; request at `T >=2`; suggestion otherwise. Without translation, the received warning is unintelligible.

When a player sends a protection claim affecting an NPR's valued system, the immediate diplomatic penalty is `2 * ProtectionCode^2 * InternalSystemValue^2 * NPR Xenophobia/100`. A permanent-presence signature below `1000 * NPR Xenophobia/100` causes rejection for inadequate presence. Other claims are assessed against system connectivity/value, relative military power, population signatures, and the NPR's Xenophobia, Militancy, and Determination. This is a contextual comparison, not a fixed diplomatic-point threshold for acceptance.

Attacks alter diplomatic points through the following implementation paths.

| Attack consequence | Point deduction |
| --- | --- |
| Ship shield hit | 0.1 * damage per hit |
| Ship armour hit | 0.25 * damage per hit |
| Ship penetrating hit | 1 * damage per hit |
| Attack on an NPR ship whose main function is Diplomacy | Multiply the ship penalties by 3 |
| Nonship helper used for bombardment/shipyards | 0.25 * total hits * damage per hit |
| Ground units destroyed in ground combat | The call subtracts cumulative destroyed unit size/100 |

The ship helper forces points to -101 when its post-damage value is above -101; for an NPR diplomatic ship that forced value is -303. The nonship helper similarly forces -101. A separate shipyard path can additionally subtract resolved damage and force hostility. Ground-combat calls force points below -100 when necessary, and the inspected loop uses a cumulative destroyed-size value on successive hits. Thus a single universal damage-to-diplomacy formula would misdescribe this checkout.

The remaining contact and intelligence codes are useful for database readers.

| Field/type | Numeric mapping |
| --- | --- |
| `FCT_Contacts.ContactMethod` | 1 ActiveSensor_Tentative; 2 Thermal; 3 EM_Or_Emission; 4 Shield; 5 Transponder; 6 Environmental_Tentative |
| `FCT_Contacts.ContactType` | 0 None; 1 Ship; 3 Salvo; 4 Population; 9 Packet; 12 GroundUnit; 14 STOGroundUnit; 16 Shipyard; 17 Explosion; 18 EWImpact; 19 SecondaryPower; 20 SecondaryMg; 22 WayPoint |
| ContactFreshnessState, runtime | 0 Current; 1 Partial; 2 Lost |
| `FCT_AlienClass.EngineType` | 0 None; 1 Military; 2 Commercial; 3 FAC; 4 Survey; 5 Fighter |
| Jammer type | 0 None; 1 Sensor; 2 FireControl; 3 Missile |
| Transponder mode | 0 Off; 1 Friendly; 2 All |
| Special race type | 0 Standard; 1 Precursors; 2 Swarm; 3 Invaders; 4 Rakhas; 5 Eldar; 6 Ancients |
| Racial personality selector | 0 Xenophobia; 1 Translation; 2 Militancy; 3 Determination |

Contact-method names require context: the inspected colony EM-detection path uses method 4 (Shield) for a population EM signature. Ship freshness is computed from its constituent contact tracks: stale tracks with no current tracks produce Lost; a mixture produces Partial; otherwise the code defaults to Current.

The relevant modules and commander bonuses have their own IDs and base values.

| Item | ID | Values in the exported catalogue |
| --- | ---: | --- |
| ELINT component type | 66 | Component strengths shown below |
| Diplomacy component type | 67 | 30 HS = 1500 tons; 300 BP; 50 crew; 150 Corbomite, 75 Mercassium, 75 Vendarite |
| ELINT technology type | 242 | Electronic Intelligence and Analysis Module |
| Diplomacy technology type | 243 | Diplomacy Module |
| Alien Autopsy technology type | 197 | Species-specific project costs 1000 RP |
| Diplomacy commander bonus | 17 | Percentage multiplier; catalogue maximum 1.5 = +50% |
| Communications commander bonus | 22 | Percentage multiplier; catalogue maximum 1.5 = +50% |
| Intelligence commander bonus | 23 | Percentage multiplier; catalogue maximum 1.5 = +50% |

The bonus API returns multipliers: 1.2 means +20%, and the default for an absent percentage bonus is 1. The catalogue maximum is a database definition, not a claim that every possible loaded or edited value is runtime-clamped.

| ELINT strength | Research cost RP | Module size HS | Module cost BP | Crew |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 2000 | 10 | 100 | 15 |
| 6 | 4000 | 10 | 120 | 15 |
| 8 | 8000 | 10 | 160 | 15 |
| 11 | 15000 | 10 | 220 | 15 |
| 14 | 30000 | 10 | 280 | 15 |

These are the five generic ELINT technologies/components in the local export. Strength affects interception range, while the accumulation formula above supplies the point rate.

Racial personality queries return Xenophobia 100 and Translation -25 for special races. In the inspected standard-race implementation, a population-total check occurs before accumulation and therefore uses a primary-species fallback; when no imperial species is available it returns 50. The later population-weighted branch is marked unreachable in the source. Keep this in mind when applying formulas to multi-species empires.

The persisted intelligence tables divide information by observer and subject.

| Table | Information |
| --- | --- |
| `FCT_AlienRace` | Observer/target relation; ContactStatus; CommStatus; CommModifier; communication/contact times; diplomatic/race-intelligence points; treaties; portrait/name flags; damage history |
| `FCT_Contacts` | Sensor tracks; ContactID; method/type; strength/resolution; creation/reestablishment/update times; coordinates; speed |
| `FCT_AlienClass` | Inferred ship-class statistics, role, engine type, weapons/PD indicators, jammers, summary, notes, known hull counts |
| `FCT_AlienClassWeapon` | WeaponID; Amount; Range; ROF; LastFired |
| `FCT_AlienClassSensor` | Class-to-sensor links |
| `FCT_AlienClassTech` | Class-to-known-technology links |
| `FCT_AlienShip` | Individual tracked hull history, location, damage, destruction and salvage |
| `FCT_AlienRaceSensor` | Observer's sensor catalogue; strength, resolution, range, IP; actual component/missile/ground-class references |
| `FCT_AlienPopulation` | Observed population/installations/facilities/signatures; current, maximum, and previous-maximum colony IP |
| `FCT_AlienGroundUnitClass` | Hits; Penetrated; Destroyed; WeaponsKnown; class identity |
| `FCT_AlienRaceSpecies` | Species associated with a known race |
| `FCT_KnownSpecies` | Observer's species knowledge Status |
| `FCT_AlienSystem` | Systems associated with known alien presence |
| `FCT_AlienRaceSystemStatus` | System protection status per observer and alien race |
| `FCT_RaceGroundCombat` | ConsecutiveCombatRounds used by force estimates |
| `FCT_ShipTechData` | Research data held aboard ships |

Scope queries by `GameID` and the appropriate viewing/detecting race field. Restrict player intelligence queries to these observer-specific records: joins through ActualClassID, ActualSensor, ShipID, or PopulationID can expose actual capabilities beyond the observations. `FCT_AlienPopulation.GFTF` is the persisted field loaded into `GroundForceConstructionComplexes`.

Boolean flags generally decode as 0 false and 1 true. `RealClassNames`, `RandomNameOrder`, and `FixedRelationship` are integer flags in the class; RandomNameOrder defaults to 1. `RealClassNames` and naming-theme choices govern identification/display, not an additional IP tier. FirstDetected, LastContactTime, CommEstablished, and related timestamps are game-time seconds; a game year is 31536000 seconds and a day is 86400 seconds. Sizes in HS convert at 50 tons per HS; observed speed is km/s and weapon/sensor range is km.

For event-log readers, the relevant event IDs are:

| Event type | ID |
| --- | ---: |
| Communication | 55 |
| IntelligenceUpdate | 106 |
| NewAlienRace | 147 |
| SuccessfulEspionage | 157 |
| Diplomacy | 180 |
| GroundCombatIntelligence | 314 |
| AlienCommunication | 315 |
| InterrogationUpdate | 367 |

These are event-type IDs, separate from UI event categories: Intelligence is category 15 and Diplomacy category 19.

The [documentation archive](https://aurora4x-docs.vercel.app/#current) is an external companion reference. The [September 2020 C# manual](https://dokk.org/library/aurora_csharp_unofficial_manual_v0.1.4) corroborates mutual contact, the diplomacy formula, and reduced translation progress without a qualified commander. This reference's precise enums, boundaries, and anomalous branches belong to the local 2.7.1 source branch; a historical description or the archive's current label does not establish identical implementation behavior.
