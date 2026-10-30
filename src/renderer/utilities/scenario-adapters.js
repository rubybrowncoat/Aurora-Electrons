// Every kind of scenario record the app defines, as the function that registers its adapter with a repository's `registerAdapter`. The History page's backup reads and restores the records of every planner through one registry, in a session where no planner page has been opened, so a kind that is not listed here is rejected on a restore as a kind with no adapter. A planner page registers only the adapters it uses, from its own module. A new kind is added to this list when its module is added.
import { registerEconomyNotes } from './economy-notes'
import { registerFleetStations } from './fleet-stations'
import { registerMilestones } from './history-milestones'
import { registerDesigner } from './missile-designer'
import { registerBriefs } from './mission-briefs'
import { registerRecoveryLedger } from './recovery-ledger'
import { registerResourceReserves } from './resource-reserves'
import { registerRouteDesires } from './route-desires'
import { registerTechScenarios } from './tech-scenarios'
import { registerWorldTags } from './world-tags'

export const SCENARIO_ADAPTERS = Object.freeze([registerTechScenarios, registerBriefs, registerDesigner, registerResourceReserves, registerRouteDesires, registerMilestones, registerEconomyNotes, registerWorldTags, registerFleetStations, registerRecoveryLedger])

// Registers every kind's adapter with a repository's `registerAdapter`, once per function and adapter.
export const registerScenarioAdapters = (register) => {
  SCENARIO_ADAPTERS.forEach((registerAdapter) => registerAdapter(register))
}
