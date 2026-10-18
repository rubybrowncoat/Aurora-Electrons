// The mineral comparison of the Empire History page: the stockpiles of the minerals picked, as tonnes or as the percent change from a baseline, with each mineral's colour fixed by its mineral ID, and the comparison as CSV. Pure: it reads the snapshots it is given (utilities/history.js) and draws nothing.

import { csvCell } from './csv-cell'
import { mineralResult } from './history'
import { MINERALS } from './minerals'
import { registerRule, valueOrNull } from './provenance'

registerRule({
  id: 'history.mineralChange',
  versions: ['2.7.x'],
  units: '%',
  verification: 'confirmed',
  structure: ['FCT_Population.Duranium to Gallicite', 'snapshots of the app\'s history file'],
  note: 'A mineral stockpile\'s change from its baseline, the stock in the first snapshot of the window: 100 x (stock - baseline) / baseline. It is unknown where the stock or the baseline is, and undefined when the baseline is not above 0 t: a percentage of nothing is neither 0 nor infinite, so the mineral has no line on this scale.',
})

// The scales the comparison offers: the stock in tonnes, and the change from each mineral's baseline in percent.
export const MINERAL_SCALES = [
  { value: 'absolute', text: 'Stock (t)', title: 'Stockpile in tonnes', axis: 'Stock (t)', label: 'stock (t)' },
  { value: 'percent', text: 'Change (%)', title: 'Change from the stock in the first snapshot of the window, in percent', axis: 'Change from baseline (%)', label: 'percent change from baseline (%)' },
]

// The palette slot of each mineral by mineral ID (index is the ID less 1): fixed, so a mineral keeps its colour whichever others are picked and in either theme. The palette has nine slots for eleven minerals: Corundium (10) and Gallicite (11) take the slots of Corbomite and Tritanium, chosen away from the Duranium, Neutronium and Gallicite the page starts with, and are drawn dashed so their line differs from that of the mineral whose colour they share.
export const MINERAL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 3]

const SHARED_DASH = [6, 2, 1, 2]

// How a mineral is drawn: `{ slot, color, dash, shared }`. `palette` is the categorical colours in force. `dash` is empty for a mineral that owns its slot, which then has the slot's own dash; `shared` marks the two that reuse a slot. Null for an ID that is no mineral's.
export const mineralStyle = (palette, id) => {
  const index = MINERALS.findIndex((mineral) => mineral.id === id)

  if (index < 0) {
    return null
  }

  const slot = MINERAL_SLOTS[index]
  const shared = MINERAL_SLOTS.indexOf(slot) !== index

  return { slot, color: palette[slot], dash: shared ? SHARED_DASH : [], shared }
}

// A stock's change from its baseline in percent; null when either is not known and when the baseline is not above 0, which no percentage is taken from.
export const percentChange = (stock, baseline) => (typeof stock === 'number' && Number.isFinite(stock) && typeof baseline === 'number' && Number.isFinite(baseline) && baseline > 0 ? (100 * (stock - baseline)) / baseline : null)

const UNDEFINED_REASONS = {
  empty: 'no snapshot lies in the window',
  unknown: 'the stock in the first snapshot of the window is not recorded',
  zero: 'the stock in the first snapshot of the window is 0 t',
  negative: 'the stock in the first snapshot of the window is below 0 t',
}

const normalisationOf = (first) => {
  const code = !first ? 'empty' : first.stock === null ? 'unknown' : first.stock === 0 ? 'zero' : first.stock < 0 ? 'negative' : null

  return code ? { defined: false, code, reason: UNDEFINED_REASONS[code] } : { defined: true, code: null, reason: null }
}

// The comparison of the minerals `ids` over `snapshots` (the snapshots of the window, oldest first): one entry per ID, in the order given, `{ id, name, samples: [{ t, stock }], baseline, normalisation, percent }`. A stock the snapshot does not hold is null, never 0. `baseline` is the first sample of the window, `{ t, stock }` (the stock null when it was not recorded), or null for no snapshot; it is not moved on to a later sample when its stock is unknown. `normalisation` is `{ defined, code, reason }`: undefined, with the reason, for a baseline that is 0 t or not recorded. `percent` is a value for each sample, null wherever the stock is unknown and everywhere when the normalisation is undefined.
export const compareMinerals = (snapshots, ids) => ({
  series: ids.map((id) => {
    const mineral = MINERALS.find((entry) => entry.id === id)
    const samples = snapshots.map((snapshot) => ({ t: snapshot.t, stock: valueOrNull(mineralResult(snapshot, id, mineral.name)) }))
    const baseline = samples.length ? samples[0] : null
    const normalisation = normalisationOf(baseline)

    return { id, name: mineral.name, samples, baseline, normalisation, percent: samples.map((sample) => (normalisation.defined ? percentChange(sample.stock, baseline.stock) : null)) }
  }),
})

// The CSV of a comparison as the page shows it: a row for each mineral at each snapshot of the window, the mineral's ID and the slot and colour it is drawn in, the scale, the stock in tonnes, the baseline's stock and game time (and its date), the change from it in percent, the seconds since the mineral's previous row and the retention note of the history (how sparsely it is sampled and what is known of its thinning), on the first row. A figure that is not recorded or not defined is an empty cell, and the note says why. `palette` is the categorical colours in force, `date(seconds)` the date of a game time and `retention` the retention note.
export const comparisonCsv = ({ comparison, scale, palette, date, retention }) => {
  const named = MINERAL_SCALES.find((entry) => entry.value === scale) || MINERAL_SCALES[0]
  const header = ['Mineral ID', 'Mineral', 'Palette slot', 'Colour', 'Scale', 'Game time (s)', 'Date', 'Stock (t)', 'Baseline stock (t)', 'Baseline game time (s)', 'Baseline date', 'Change from baseline (%)', 'Note', 'Gap since previous row (s)', 'Retention']
  const rows = comparison.series.flatMap((series, order) => {
    const style = mineralStyle(palette, series.id)
    const baseline = series.baseline

    return series.samples.map((sample, position) => {
      const notes = [sample.stock === null ? 'stock not recorded' : '', series.normalisation.defined ? '' : `change undefined: ${series.normalisation.reason}`].filter(Boolean)

      return [series.id, series.name, style.slot + 1, style.color, named.label, sample.t, date(sample.t), sample.stock, baseline.stock, baseline.t, date(baseline.t), series.percent[position], notes.join('; '), position ? sample.t - series.samples[position - 1].t : null, order || position ? null : retention]
    })
  })

  return [header, ...rows].map((row) => row.map((value) => csvCell(value)).join(',')).join('\n')
}
