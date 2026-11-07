// Engines whose stored row the engine rule (utilities/design-rules.js `engineDesign`) does not reproduce for a reason outside it, each checked by hand against the save it is in and shared by scripts/check-design-rules.js and scripts/check-signatures.js. A pin names the pinned saved state it was audited in (scripts/lib/pinned-saves.js: its game, name, start year and game time), the component, the field and the stored and computed figures observed: it explains a difference only while it is read on that state and both figures still match, so a changed figure, or another save that reuses the game and the component id, is a mismatch, and a pin that no comparison of its state used is a mismatch too.
const { pinnedRows } = require('./pinned-saves')

const MODDED_COST = "the stored cost is a tenth of the rule's 1500; the other engines of game 140 on the same thermal tech (500722, 500735, 500606) match the rule, so this cost was changed outside the design rule"
const MODDED_FLAG = 'a 0.8 HS engine at thrust 0.9 is military under the rule (commercial needs 25 HS and thrust 0.5 or less); the flag was changed outside the design rule, and the commercial engines of game 140 (500246, 500707, 500708) obey it'

const MIGRATED_FLAG = 'the engine is stored commercial at a size under 25 HS, where the rule makes an engine commercial only at 25 HS or more and a thrust of 0.5 or less; the flag was set outside the design rule in the campaign this save was migrated from, and the commercial engines of 25 HS or more in the save obey the rule'
const MIGRATED_COST = 'the stored cost is 1000 where the rule gives 4218.75 at its size and thrust, and the flag of the same engine was set outside the design rule too; its power, fuel efficiency, crew and HTK agree, and the cause of the cost is not identified'
const MIGRATED_POWER = "the stored power is a multiple of 25 EP, 25 to 250 EP from the rule's at the engine's size and thrust; the stored fuel efficiency, cost and maximum explosion all reproduce at the rule's power and none at the stored one, so the power was set outside the design rule in the campaign this save was migrated from"
const MIGRATED_SMALL = "the stored power, fuel efficiency, cost and maximum explosion of this small engine are 2.5 to 4.4 times the rule's at its stored size and thrust, while its crew, HTK and explosion chance agree; the figures were set outside the design rule in the campaign this save was migrated from, and the cause is not identified"

// The two engines of the modded campaign, audited in the modded save, game 140.
const MODDED_ENGINES = [
  { id: 500260, field: 'cost', stored: 150, computed: 1500, reason: MODDED_COST },
  { id: 500613, field: 'military', stored: 0, computed: 1, reason: MODDED_FLAG },
]

const MIGRATED_ENGINES = [
  { id: 500259, field: 'cost', stored: 1000, computed: 4218.75, reason: MIGRATED_COST },
  { id: 500259, field: 'military', stored: 0, computed: 1, reason: MIGRATED_FLAG },
  { id: 500361, field: 'power', stored: 9375, computed: 9350, reason: MIGRATED_POWER },
  { id: 500368, field: 'power', stored: 7125, computed: 7150, reason: MIGRATED_POWER },
  { id: 500389, field: 'power', stored: 15500, computed: 15400, reason: MIGRATED_POWER },
  { id: 500392, field: 'power', stored: 30500, computed: 30250, reason: MIGRATED_POWER },
  { id: 500395, field: 'power', stored: 32500, computed: 32450, reason: MIGRATED_POWER },
  { id: 500403, field: 'military', stored: 0, computed: 1, reason: MIGRATED_FLAG },
  { id: 500412, field: 'military', stored: 0, computed: 1, reason: MIGRATED_FLAG },
  { id: 500415, field: 'power', stored: 375, computed: 140, reason: MIGRATED_SMALL },
  { id: 500415, field: 'fuelEfficiency', stored: 0.025365192, computed: 0.005729412873, reason: MIGRATED_SMALL },
  { id: 500415, field: 'cost', stored: 245, computed: 98, reason: MIGRATED_SMALL },
  { id: 500415, field: 'maxExplosion', stored: 87, computed: 35, reason: MIGRATED_SMALL },
  { id: 500416, field: 'power', stored: 500, computed: 200, reason: MIGRATED_SMALL },
  { id: 500416, field: 'fuelEfficiency', stored: 0.00773398, computed: 0.001746928107, reason: MIGRATED_SMALL },
  { id: 500416, field: 'cost', stored: 250, computed: 100, reason: MIGRATED_SMALL },
  { id: 500416, field: 'maxExplosion', stored: 125, computed: 50, reason: MIGRATED_SMALL },
]

const PINNED_ENGINES = Object.freeze([
  ...pinnedRows('modded-g140', MODDED_ENGINES),
  ...pinnedRows('migrated-g141', MIGRATED_ENGINES),
])

module.exports = { PINNED_ENGINES }
