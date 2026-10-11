import * as administration from './administration'
import * as colonies from './colonies'
import * as fleets from './fleets'
import * as industry from './industry'
import * as research from './research'
import * as ships from './ships'
import * as space from './space'

export { IDLE_FLEETS_KEY } from './fleets'
export { normalizeRows } from './common'

const MODULES = [fleets, ships, industry, colonies, research, administration, space]

export const GROUPS = MODULES.map((module) => module.group)

export const CHECKS = MODULES.flatMap((module) => module.checks)

export const SEVERITIES = [
  { key: 'needs-action', label: 'Needs action', icon: 'mdi-alert-circle', color: 'error' },
  { key: 'attention', label: 'Attention', icon: 'mdi-alert', color: 'warning' },
  { key: 'info', label: 'Info', icon: 'mdi-information-outline', color: 'info' },
]

export const checkByKey = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(CHECKS.map((check) => [check.key, check]))))

// The check's name without a count: `idle fleets`, `low maintenance ships`.
export const checkLabel = (check) => check.title(0, {}).replace(/^0 /, '')
