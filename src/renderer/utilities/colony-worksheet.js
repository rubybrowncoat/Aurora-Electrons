// The Colony Comparison worksheet: the bodies a player picked in the Colonization Planner side by side, each with one species' colony cost and population limit and every mineral's amount and accessibility. It reads the planner's own ranked rows and works nothing out again: the cost and the limit are the figures of the evaluation the body detail shows for the same species, the deposits are the rows the loader joined to the race's geological surveys. No score is built from them.

import { systemBodyName } from './aurora'
import { nowProvenance } from './colonization'
import { sortTableItems } from './colony-transit'
import { isKnownNumber } from './math'
import { MINERALS } from './minerals'
import { ofRule, registerRule, unavailable } from './provenance'

const VERSIONS = ['2.7.x']
const SURVEY_INPUT = 'a geological survey of the body by the race'
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export const AMOUNT_RULE = 'colonyWorksheet.depositAmount'
export const ACCESSIBILITY_RULE = 'colonyWorksheet.depositAccessibility'

registerRule({
  id: AMOUNT_RULE,
  versions: VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_MineralDeposit.Amount', 'FCT_SystemBodySurveys.SystemBodyID, RaceID'],
  note: 'The tons of one mineral in the body\'s deposit as the save stores them, shown only for a body the race has surveyed geologically (the survey covers the whole body, not one mineral). A body that is not surveyed has no figure, whatever the save holds for it. A surveyed body with no deposit of the mineral holds none. Deposits found by a later ground survey and the depletion of mining are not forecast: the figure is the deposit as of the save.',
  assumptions: ['a surveyed body with no deposit row of a mineral holds none of it'],
})

registerRule({
  id: ACCESSIBILITY_RULE,
  versions: VERSIONS,
  units: '0 to 1',
  verification: 'confirmed',
  structure: ['FCT_MineralDeposit.Accessibility', 'FCT_SystemBodySurveys.SystemBodyID, RaceID'],
  note: 'How easily one mineral\'s deposit is mined, 0 to 1, as the save stores it, shown only for a body the race has surveyed geologically. A mineral with no deposit has no accessibility. The figure is the deposit as of the save; mining and later ground surveys change it.',
})

export const amountKey = (mineralId) => `amount${mineralId}`
export const accessKey = (mineralId) => `access${mineralId}`

// The sortable columns, in table order: the body, the species, the cost, the limit, then each mineral's amount and accessibility.
export const SORT_KEYS = ['name', 'speciesName', 'costValue', 'capacityValue', ...MINERALS.flatMap((mineral) => [amountKey(mineral.id), accessKey(mineral.id)])]

// The evaluation of a body for one species, or the body's best one when no species is picked or the body has no figures for it. The Planner's detail panel shows exactly this, so a figure read from it is the panel's figure.
export const evaluationOf = (row, speciesId) => (speciesId && row.evaluations.find((evaluation) => evaluation.species.SpeciesID === speciesId)) || row.best

const unsurveyedCell = (mineral) => ({
  id: mineral.id,
  name: mineral.name,
  status: 'unsurveyed',
  amount: null,
  accessibility: null,
  amountResult: unavailable({ rule: AMOUNT_RULE, missing: [SURVEY_INPUT] }),
  accessResult: unavailable({ rule: ACCESSIBILITY_RULE, missing: [SURVEY_INPUT] }),
})

// A stored figure as a number, or null when the save holds none: null, an empty or whitespace-only text and anything that is not a finite number are not figures, a numeric 0 is.
const recorded = (value) => (isKnownNumber(value) && (typeof value !== 'string' || value.trim() !== '') ? Number(value) : null)

const depositCell = (mineral, deposits) => {
  if (!deposits.length) {
    return { id: mineral.id, name: mineral.name, status: 'none', amount: 0, accessibility: null, amountResult: ofRule({ rule: AMOUNT_RULE, value: 0, inputs: { present: ['the body\'s survey'] }, assumptions: ['a surveyed body with no deposit row of the mineral holds none of it'] }), accessResult: null }
  }

  if (deposits.length > 1) {
    const missing = [`one deposit row of ${mineral.name} (the save holds ${deposits.length})`]

    return { id: mineral.id, name: mineral.name, status: 'ambiguous', amount: null, accessibility: null, amountResult: unavailable({ rule: AMOUNT_RULE, missing }), accessResult: unavailable({ rule: ACCESSIBILITY_RULE, missing }) }
  }

  const [deposit] = deposits
  const amount = recorded(deposit.Amount)
  const accessibility = recorded(deposit.Accessibility)

  return {
    id: mineral.id,
    name: mineral.name,
    status: 'deposit',
    amount,
    accessibility,
    amountResult: amount === null ? unavailable({ rule: AMOUNT_RULE, missing: [`the amount of ${mineral.name}`] }) : ofRule({ rule: AMOUNT_RULE, value: amount, inputs: { present: ['the deposit', 'the body\'s survey'] } }),
    accessResult: accessibility === null ? unavailable({ rule: ACCESSIBILITY_RULE, missing: [`the accessibility of ${mineral.name}`] }) : ofRule({ rule: ACCESSIBILITY_RULE, value: accessibility, inputs: { present: ['the deposit', 'the body\'s survey'] } }),
  }
}

// All eleven minerals of a body, in the minerals' own order. A body the race has not surveyed shows nothing of its deposits, however many rows the save holds for it.
export const mineralCells = (row) => MINERALS.map((mineral) => (row.minerals.surveyed ? depositCell(mineral, row.body.Minerals.filter((deposit) => deposit.MaterialID === mineral.id)) : unsurveyedCell(mineral)))

const bodyName = (body) => `${body.SystemName} ${systemBodyName(body)}`

const flat = (cells) => Object.fromEntries(cells.flatMap((cell) => [[amountKey(cell.id), cell.amount], [accessKey(cell.id), cell.accessibility]]))

const NO_FIGURES = { speciesId: null, speciesName: null, costValue: null, capacityValue: null, lowGravity: false, reason: null, missing: [], results: { cost: null, capacity: null } }

// The cost and the limit as they are today, the two figures the body detail's headlines open with.
const figuresOf = (row, evaluation) => {
  const { assessment, species, missing } = evaluation
  const base = { ...NO_FIGURES, speciesId: species.SpeciesID, speciesName: species.SpeciesName, results: nowProvenance(row, evaluation) }

  if (missing.length) {
    return { ...base, state: 'unknown', missing }
  }

  if (!assessment.cost.colonisable) {
    return { ...base, state: 'unfit', reason: assessment.reason || assessment.cost.reason || 'no reason recorded' }
  }

  return { ...base, state: 'known', costValue: assessment.cost.worst, capacityValue: evaluation.capacityNow, lowGravity: !!assessment.lowGravity }
}

// The worksheet's rows: one per distinct selected body, in the order selected, each worked out for `speciesId` (null: the species the Planner's table shows for the body). `rows` is the Planner's ranked rows before any filter. A selected body the rows do not hold stays in the worksheet as an `absent` row with no figures.
export const worksheetRows = ({ rows, selection, speciesId = null }) => {
  const byId = new Map(rows.map((row) => [row.body.SystemBodyID, row]))
  const seen = new Set()

  return selection.filter((reference) => !seen.has(reference.SystemBodyID) && seen.add(reference.SystemBodyID)).map((reference) => {
    const row = byId.get(reference.SystemBodyID)

    if (!row) {
      const cells = MINERALS.map(unsurveyedCell)
      const missing = ['the body among the Planner\'s ranked bodies']

      return { ...NO_FIGURES, id: reference.SystemBodyID, name: bodyName(reference), state: 'absent', missing, results: { cost: unavailable({ rule: 'habitability.colonyCost', missing }), capacity: unavailable({ rule: 'habitability.bodyCapacity', missing }) }, minerals: cells, ...flat(cells) }
    }

    const cells = mineralCells(row)

    return { ...figuresOf(row, evaluationOf(row, speciesId)), id: row.body.SystemBodyID, name: bodyName(row.body), minerals: cells, ...flat(cells) }
  })
}

// The rows ordered by a column key of `SORT_KEYS` ([key] or none) and `sortDesc` ([boolean]): a figure that is unknown goes last whichever way the sort runs and is never read as 0.
export const sortWorksheetRows = (items, sortBy, sortDesc) => sortTableItems(items, sortBy, sortDesc, COLLATOR.compare)
