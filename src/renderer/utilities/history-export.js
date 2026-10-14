// What the Empire History page shares of one view (a chart or the table): the visible series over the visible window, with the annotations the chart draws, as a CSV and as the caption of a PNG. Both come from one model, so the two cannot name different series, windows or annotations. Pure: it reads the figures it is given and draws on a canvas it is handed.
//
// The CSV is long-form, one file per view, and every row has a `Record`:
// - `context`: one row of text per fact (the race and branch, who may see it, the window, the sampling limits, how annotations are placed, the notes the chart shows) and one per series for its rule, rule status and assumptions;
// - `sample`: one row per series and per sample in the window, at the sample's exact game time. A figure the snapshot does not hold has an empty `Value` and the status `not recorded`, never 0;
// - `annotation`: one row per annotation the chart draws, at its own exact game time, with its ID, type, text and link. The time of an annotation is never a sample's: it is in `Annotation game time (s)`, a column no sample row fills, and the sample nearest to it is named apart.
// A column that does not apply to a row is empty. A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe, so a spreadsheet shows it as text and never runs it; the columns of numbers are not touched.

import { getRule } from './provenance'

export const CSV_COLUMNS = [
  'Record',
  'Chart',
  'Series',
  'Unit',
  'Sample game time (s)',
  'Sample date',
  'Value',
  'Value status',
  'Rule',
  'Rule status',
  'Missing inputs',
  'Stock behind the change (t)',
  'Baseline game time (s)',
  'Baseline stock (t)',
  'Gap since previous sample (s)',
  'Annotation game time (s)',
  'Annotation date',
  'Annotation ID',
  'Annotation type',
  'Annotation text',
  'Annotation link',
  'Nearest sample game time (s)',
  'Offset to nearest sample (s)',
  'Note',
]

export const RECORDED = 'recorded'
export const NOT_RECORDED = 'not recorded'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// A text cell (a name, a note, an annotation's text) that starts with a character a spreadsheet reads as the start of a formula is written with a leading apostrophe, so it is shown as text. The columns of numbers are never touched: a negative figure stays a number.
const NUMBER_COLUMNS = new Set(['Sample game time (s)', 'Value', 'Stock behind the change (t)', 'Baseline game time (s)', 'Baseline stock (t)', 'Gap since previous sample (s)', 'Annotation game time (s)', 'Nearest sample game time (s)', 'Offset to nearest sample (s)'])

const FORMULA_START = /^[=+\-@\t\r]/

const cell = (value, column) => {
  const text = typeof value === 'string' && !NUMBER_COLUMNS.has(column) && FORMULA_START.test(value) ? `'${value}` : value

  return typeof text === 'string' && /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text === null || text === undefined ? '' : text
}

const rowOf = (fields) => {
  const unknown = Object.keys(fields).filter((name) => !CSV_COLUMNS.includes(name))

  if (unknown.length) {
    throw new Error(`The export has no column ${unknown.join(', ')}`)
  }

  return CSV_COLUMNS.map((name) => cell(fields[name], name)).join(',')
}

const joined = (list) => list.join('; ')

const seriesOf = (entry, date) => {
  const rule = getRule(entry.rule)

  if (!rule) {
    throw new Error(`The export of ${entry.label} names a rule that is not registered: ${entry.rule}`)
  }

  const samples = entry.samples.map((sample, index) => {
    const recorded = isNumber(sample.value)

    return { t: sample.t, date: date(sample.t), value: recorded ? sample.value : null, status: recorded ? RECORDED : NOT_RECORDED, missing: recorded ? [] : sample.missing || [], stock: isNumber(sample.stock) ? sample.stock : null, gap: index ? sample.t - entry.samples[index - 1].t : null }
  })
  const recorded = samples.filter((sample) => sample.status === RECORDED).length

  return { label: entry.label, unit: entry.unit, rule: rule.id, ruleStatus: rule.verification, ruleNote: rule.note, assumptions: rule.assumptions || [], samples, baseline: entry.baseline || null, recorded, unrecorded: samples.length - recorded }
}

// The samples a window holds, as a clause.
const spanText = (window, date) => (window.count ? `${window.count} of ${window.retained} retained snapshots, from ${date(window.from)} (${window.from} s) to ${date(window.to)} (${window.to} s)` : 'no snapshot lies in this window')

const windowText = (window, date) => `${window.span ? `The last ${window.span} years before the latest snapshot` : 'Every retained snapshot'}: ${spanText(window, date)}.`

// The window of a view that draws several races, each over its own samples: the span is counted back from the selected race's latest snapshot, and the first and last sample, the count and the retained snapshots are each race's own.
const racesWindowText = (span, races, date) => `${span ? `The last ${span} years before the selected race's latest snapshot` : 'Every retained snapshot'}, race by race: ${races.map((race) => `${race.label}: ${spanText(race.window, date)}`).join('; ')}.`

const raceText = (scope) => `Race: ${scope.race} (race ${scope.RaceID}) in game ${scope.GameID}, campaign ${scope.campaignId === null || scope.campaignId === undefined ? 'not settled' : scope.campaignId}, branch ${scope.branchId === null || scope.branchId === undefined ? 'not settled' : scope.branchId}.`

const viewerText = (scope) => (scope.spy ? 'Spy mode: the recorded history of other races is included because spy mode is on and the Rivals chart shows it.' : 'Scope: the selected race only; no other race is included.')

const COVERAGE_TEXT = 'Game time before the first snapshot was never observed and is not inferred. A snapshot keeps aggregate figures only (colony stocks added up, no figure per colony), and the older half of a long series is thinned to every other snapshot, so the samples are not a continuous record: a line between two samples joins them and is not an observation.'

const MISSING_TEXT = 'A sample with no figure has an empty value and the status not recorded; it is not 0.'

// The model of one view's export. `chart` is `{ key, title, notes }` (the notes the view shows), `series` the visible series, each `{ label, unit, rule, samples: [{ t, value, missing, stock? }], baseline? }` with `value` null where the snapshot holds no figure and `baseline` `{ t, stock }` on a series drawn as a change from a baseline. `annotations` are the ones the chart draws, `{ id, t, type, text, link, nearest: { t, offset } | null }`; `annotated` is false for a view that draws none (the table), and `unseen` is how many more annotations are kept and not drawn. `scope` is `{ race, RaceID, GameID, campaignId, branchId, spy }`, `window` is `{ span, count, retained, from, to }`, `retention` the sampling and thinning sentence, and `date(t)` and `dateTime(t)` write a game time. A view that draws several races (Rivals) gives `races` instead of `retention`: `[{ label, window: { count, retained, from, to }, retention }]`, one for each race it draws, over that race's own samples (`window` then only needs `span`), so the first and last sample, the counts and the sampling of each race are stated apart and none is taken from another.
export const exportModel = ({ chart, series, annotations = [], annotated = true, unseen = 0, scope, window, retention, races = null, date, dateTime }) => {
  const shown = series.map((entry) => seriesOf(entry, date))
  const facts = {
    race: raceText(scope),
    viewer: viewerText(scope),
    window: races ? racesWindowText(window.span, races, date) : windowText(window, date),
    coverage: races ? `Sampling, race by race: ${races.map((race) => `${race.label}: ${race.retention}`).join(' ')} ${COVERAGE_TEXT}` : `Sampling: ${retention} ${COVERAGE_TEXT}`,
    missing: MISSING_TEXT,
    annotations: annotated ? `Annotations: ${annotations.length} drawn in this window, each at its own exact game time, which is not a sample time; the nearest sample${races ? ', one of the selected race\'s,' : ''} is named beside it. ${unseen} more kept for this race and branch are not exported because this view does not draw them (outside the window, or made at a later game time than this save).` : 'Annotations: this view does not draw them, so none is exported.',
  }
  const placed = annotations.map((entry) => ({ id: entry.id, t: entry.t, date: dateTime(entry.t), type: entry.type, text: entry.text, link: entry.link || '', nearest: entry.nearest || null })).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return { key: chart.key, title: chart.title, spy: Boolean(scope.spy), facts, notes: chart.notes || [], series: shown, annotations: placed }
}

// Each rule once, in the order its series come.
const rulesOf = (model) => {
  const seen = new Set()

  return model.series.filter((entry) => !seen.has(entry.rule) && seen.add(entry.rule))
}

const ruleText = (entry) => `${entry.rule} (${entry.ruleStatus}): ${entry.ruleNote}${entry.assumptions.length ? ` Assumes ${joined(entry.assumptions)}.` : ''}`

// The CSV of a model, as the header and one line per row.
export const exportCsv = (model) => {
  const context = (fields) => rowOf({ Record: 'context', Chart: model.title, ...fields })
  const rows = [
    ...Object.values(model.facts).map((text) => context({ Note: text })),
    ...model.notes.map((text) => context({ Note: text })),
    ...model.series.map((entry) => context({ Series: entry.label, Unit: entry.unit, Rule: entry.rule, 'Rule status': entry.ruleStatus, Note: ruleText(entry) })),
    ...model.series.flatMap((entry) => entry.samples.map((sample) => rowOf({ Record: 'sample', Chart: model.title, Series: entry.label, Unit: entry.unit, 'Sample game time (s)': sample.t, 'Sample date': sample.date, Value: sample.value, 'Value status': sample.status, Rule: entry.rule, 'Rule status': entry.ruleStatus, 'Missing inputs': joined(sample.missing), 'Stock behind the change (t)': entry.baseline ? sample.stock : null, 'Baseline game time (s)': entry.baseline ? entry.baseline.t : null, 'Baseline stock (t)': entry.baseline ? entry.baseline.stock : null, 'Gap since previous sample (s)': sample.gap }))),
    ...model.annotations.map((entry) => rowOf({ Record: 'annotation', Chart: model.title, 'Annotation game time (s)': entry.t, 'Annotation date': entry.date, 'Annotation ID': entry.id, 'Annotation type': entry.type, 'Annotation text': entry.text, 'Annotation link': entry.link, 'Nearest sample game time (s)': entry.nearest ? entry.nearest.t : null, 'Offset to nearest sample (s)': entry.nearest ? entry.nearest.offset : null, Note: 'Drawn at its exact game time; this is not a sample time.' })),
  ]

  return [CSV_COLUMNS.map((name) => cell(name, name)).join(','), ...rows].join('\n')
}

// The caption of the PNG as lines of `{ role, text }` (and `index`, the series a `series` line belongs to): the title and what the picture is of, then the series, rules, notes, the limits of the sampling and the annotations.
export const captionLines = (model) => {
  const seriesLine = (entry) => `${entry.label} (${entry.unit}): ${entry.recorded} of ${entry.samples.length} samples recorded${entry.unrecorded ? `, ${entry.unrecorded} not recorded (not 0)` : ''}; ${entry.rule}, ${entry.ruleStatus}.${entry.baseline ? ` Change from the baseline of ${entry.baseline.stock === null ? 'a stock that was not recorded' : `${entry.baseline.stock} t`} at game time ${entry.baseline.t} s.` : ''}`
  const lines = [
    { role: 'title', text: model.spy ? `${model.title} (spy mode)` : model.title },
    { role: 'subtitle', text: model.facts.race },
    { role: 'subtitle', text: model.facts.viewer },
    { role: 'subtitle', text: model.facts.window },
    { role: 'heading', text: 'Series' },
    ...model.series.map((entry, index) => ({ role: 'series', index, text: seriesLine(entry) })),
    { role: 'heading', text: 'Rules and assumptions' },
    ...rulesOf(model).map((entry) => ({ role: 'text', text: ruleText(entry) })),
    ...(model.notes.length ? [{ role: 'heading', text: 'Notes' }, ...model.notes.map((text) => ({ role: 'text', text }))] : []),
    { role: 'heading', text: 'Coverage and limits' },
    { role: 'text', text: model.facts.coverage },
    { role: 'text', text: model.facts.missing },
    { role: 'text', text: model.facts.annotations },
  ]

  if (model.annotations.length) {
    lines.push({ role: 'heading', text: 'Annotations' }, ...model.annotations.map((entry) => ({ role: 'annotation', text: `${entry.date}: ${entry.type}, ${entry.text}${entry.link ? ` (${entry.link})` : ''} [${entry.id}]` })))
  }

  return lines
}

const MIN_WIDTH = 640
const PAD = 16

const STYLES = {
  title: { px: 18, weight: 500, ink: 'ink', before: 0 },
  subtitle: { px: 12, weight: 400, ink: 'inkMuted', before: 0 },
  heading: { px: 13, weight: 500, ink: 'ink', before: 12 },
  series: { px: 12, weight: 400, ink: 'ink', before: 0, indent: 30 },
  text: { px: 12, weight: 400, ink: 'inkMuted', before: 0 },
  annotation: { px: 12, weight: 400, ink: 'ink', before: 0 },
}

// A text broken into lines no wider than `limit`, at spaces; a word wider than that is broken where it must be.
const wrapped = (context, text, limit) => {
  const lines = []
  let line = ''
  const flush = () => {
    if (line) {
      lines.push(line)
      line = ''
    }
  }

  text.split(/\s+/).filter(Boolean).forEach((word) => {
    const attempt = line ? `${line} ${word}` : word

    if (context.measureText(attempt).width <= limit) {
      line = attempt

      return
    }

    flush()

    let rest = word

    while (context.measureText(rest).width > limit && rest.length > 1) {
      let cut = rest.length - 1

      while (cut > 1 && context.measureText(rest.slice(0, cut)).width > limit) {
        cut -= 1
      }

      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }

    line = rest
  })

  flush()

  return lines
}

// The picture: the chart as it is on screen (`source`: `{ canvas, width, height }` in CSS pixels, the canvas at its own pixel density) between the title and the rest of the caption, on the chart's surface colour. `make(width, height)` gives a canvas; `legend[index]` is `{ color, dash }` for the series line `index`; `theme` has the chart's `surface`, `ink` and `inkMuted`; `type` is `{ font(px, weight), size(px) }`, the chart's typeface. Returns `{ canvas, width, height }` in CSS pixels (the canvas has the density of the source).
export const drawExport = ({ make, source, caption, legend, theme, type }) => {
  const width = Math.max(MIN_WIDTH, Math.ceil(source.width) + 2 * PAD)
  const limit = width - 2 * PAD
  const ratio = source.canvas.width > 0 && source.width > 0 ? source.canvas.width / source.width : 1
  const measure = make(1, 1).getContext('2d')
  const split = caption.findIndex((line) => line.role === 'heading')
  const blocks = caption.map((line) => {
    const style = STYLES[line.role]

    measure.font = type.font(style.px, style.weight)

    return { ...line, style, rows: wrapped(measure, line.text.replace(/\s+/g, ' '), limit - (style.indent || 0)), step: type.size(style.px) * 1.4 }
  })
  const heightOf = (list) => list.reduce((sum, block) => sum + type.size(block.style.before) + block.rows.length * block.step, 0)
  const top = blocks.slice(0, split)
  const rest = blocks.slice(split)
  const height = Math.ceil(PAD + heightOf(top) + source.height + 8 + heightOf(rest) + PAD)
  const canvas = make(Math.ceil(width * ratio), Math.ceil(height * ratio))
  const context = canvas.getContext('2d')
  let y = PAD

  context.scale(ratio, ratio)
  context.fillStyle = theme.surface
  context.fillRect(0, 0, width, height)
  context.textBaseline = 'alphabetic'
  context.textAlign = 'left'

  const draw = (block) => {
    y += type.size(block.style.before)
    context.font = type.font(block.style.px, block.style.weight)
    context.fillStyle = theme[block.style.ink]

    block.rows.forEach((row, position) => {
      y += block.step

      if (block.role === 'series' && position === 0) {
        const key = legend[block.index]

        context.save()
        context.strokeStyle = key.color
        context.lineWidth = 2
        context.setLineDash(key.dash || [])
        context.beginPath()
        context.moveTo(PAD, y - block.step * 0.35)
        context.lineTo(PAD + 22, y - block.step * 0.35)
        context.stroke()
        context.restore()
      }

      context.fillText(row, PAD + (block.style.indent || 0), y - block.step * 0.2)
    })
  }

  top.forEach(draw)
  context.drawImage(source.canvas, Math.round((width - source.width) / 2), y, source.width, source.height)
  y += source.height + 8
  rest.forEach(draw)

  return { canvas, width, height }
}
