/*
  The contrast and colour-vision gate for the shipped presets (src/renderer/utilities/appearance.js).

  node scripts/check-contrast.js [--preset <id>] [--verbose]

  For every preset it measures WCAG 2.x contrast ratios of the resolved tokens against the surfaces they are drawn on:
  - text (4.5:1): the inks on the page, card and chrome surfaces, the tooltip ink on the tooltip, axis ticks, links and the sky's labels;
  - essential graphics and state cues (3:1): the focus colour, the severities, the contact relationships, the status colours, the selection mark and each categorical slot, against the card and page surfaces.
  A categorical slot under 3:1 passes only when the slot's encoding (marker, dash and bar pattern, `SERIES_ENCODINGS` in appearance.js) tells it from every other slot without colour. Exceptions (decorative hairlines, track fills, gridlines, washes, disabled controls) are listed with their reason, so the evidence names what the gate does not measure.
  It then simulates protanopia, deuteranopia and tritanopia (Machado et al. 2009, severity 1.0, in linear RGB) and reports the smallest CIEDE2000 difference between any two categorical slots and between neighbouring slots, on the card surface's chart; the encodings carry what a small difference loses.

  A failed measurement, or a preset whose encodings do not tell its nine slots apart, sets exit code 1.
*/
const { loadUtilities } = require('./lib/utilities')

const TEXT = 4.5
const GRAPHIC = 3
const CVD_NEIGHBOUR_DELTA = 8
const CVD_ANY_DELTA = 5

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB.
const MACHADO = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}

const parseColor = (value) => {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)

  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].replace(/./g, '$&$&') : hex[1]

    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1 }
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)

  if (rgb) {
    const [r, g, b, a = 1] = rgb[1].split(',').map(Number)

    return { r, g, b, a }
  }

  throw new Error(`Unreadable colour ${value}`)
}

// A colour drawn over an opaque one.
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })

const linear = (channel) => {
  const value = channel / 255

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

const ratio = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)

  return (light + 0.05) / (dark + 0.05)
}

const hex = ({ r, g, b }) => `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`

const toLinear = (color) => [linear(color.r), linear(color.g), linear(color.b)]

const fromLinear = (channels) => {
  const encode = (value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055)
  const [r, g, b] = channels.map((value) => encode(Math.max(0, Math.min(1, value))))

  return { r, g, b, a: 1 }
}

const simulate = (color, matrix) => {
  const channels = toLinear(color)

  return fromLinear(matrix.map((row) => row[0] * channels[0] + row[1] * channels[1] + row[2] * channels[2]))
}

const lab = (color) => {
  const [r, g, b] = toLinear(color)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)

  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

// CIEDE2000.
const deltaE = (first, second) => {
  const [L1, a1, b1] = lab(first)
  const [L2, a2, b2] = lab(second)
  const rad = (degrees) => degrees * Math.PI / 180
  const deg = (radians) => radians * 180 / Math.PI
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const meanC = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h = (b, a) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360)
  const h1p = h(b1, a1p)
  const h2p = h(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0

  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    dhp = dhp > 180 ? dhp - 360 : dhp < -180 ? dhp + 360 : dhp
  }

  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2))
  const meanL = (L1 + L2) / 2
  const meanCp = (C1p + C2p) / 2
  let meanhp = h1p + h2p

  if (C1p * C2p === 0) {
    meanhp = h1p + h2p
  } else if (Math.abs(h1p - h2p) <= 180) {
    meanhp = (h1p + h2p) / 2
  } else {
    meanhp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2
  }

  const T = 1 - 0.17 * Math.cos(rad(meanhp - 30)) + 0.24 * Math.cos(rad(2 * meanhp)) + 0.32 * Math.cos(rad(3 * meanhp + 6)) - 0.2 * Math.cos(rad(4 * meanhp - 63))
  const dTheta = 30 * Math.exp(-(((meanhp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2)
  const Sc = 1 + 0.045 * meanCp
  const Sh = 1 + 0.015 * meanCp * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc

  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

const at = (object, path) => path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), object)

// What the gate measures against which surfaces: [label, token path of the foreground, surfaces]. A surface is a token path; the tooltip's is composited over the card. Surfaces that resolve to the same colour in a preset are measured once.
const SURFACES = ['surfaces.background', 'surfaces.card', 'surfaces.chrome']

// The planner's tones: each is drawn as text (an outlined chip, a label) and as the fill of a chip, so each is measured on both. `selected` is a button colour only, measured as a graphic.
const PLAN_TONES = ['mining', 'terraformFree', 'terraformPartial', 'terraformCheaper', 'cheap', 'moderate', 'costly', 'severe', 'insufficient', 'rich', 'cmc', 'unsurveyed']

// Colours that fill a chip or a control with text on it, which `inks.onFill` draws (styles/appearance.scss).
const FILL_TONES = ['focus.primary', 'severity.action', 'severity.attention', 'severity.info', 'severity.success', 'status.inactive', ...PLAN_TONES.map((tone) => `plan.${tone}`)]
const TEXT_CHECKS = [
  ['Body text', 'inks.body', SURFACES],
  ['Secondary text, rail icons, axis ticks', 'inks.muted', SURFACES],
  ['Links and selected text', 'focus.primary', SURFACES],
  ['Tooltip text', 'inks.onTooltip', ['charts.tooltip']],
  ['Sky labels', 'space.label', ['space.background']],
  ['Needs-action tone as text (outlined chips)', 'severity.action', ['surfaces.background', 'surfaces.card']],
  ['Attention tone as text', 'severity.attention', ['surfaces.background', 'surfaces.card']],
  ['Info tone as text', 'severity.info', ['surfaces.background', 'surfaces.card']],
  ['Success tone as text', 'severity.success', ['surfaces.background', 'surfaces.card']],
  ['Inactive tone as text', 'status.inactive', ['surfaces.background', 'surfaces.card']],
  ...PLAN_TONES.map((tone) => [`Planner tone ${tone} as text`, `plan.${tone}`, ['surfaces.background', 'surfaces.card']]),
]

const GRAPHIC_CHECKS = [
  ['Keyboard focus ring and selection mark', 'focus.primary', SURFACES],
  ['Compared-row mark', 'rows.differsMark', SURFACES],
  ['Needs-action severity', 'severity.action', SURFACES],
  ['Attention severity', 'severity.attention', SURFACES],
  ['Info severity', 'severity.info', SURFACES],
  ['Success', 'severity.success', SURFACES],
  ['Hostile contact', 'contacts.hostile', SURFACES],
  ['Unidentified contact', 'contacts.unknown', SURFACES],
  ['Neutral contact', 'contacts.neutral', SURFACES],
  ['Friendly contact', 'contacts.friendly', SURFACES],
  ['Allied contact', 'contacts.allied', SURFACES],
  ['Civilian contact', 'contacts.civilian', SURFACES],
  ['Inactive standing', 'status.inactive', SURFACES],
  ['Shortfall standing', 'status.shortfall', SURFACES],
  ...[...PLAN_TONES, 'selected'].map((tone) => [`Planner tone ${tone}`, `plan.${tone}`, SURFACES]),
]

// Measured nowhere, and why.
const EXCEPTIONS = [
  ['surfaces.border', 'Hairlines between regions repeat a boundary the layout already gives; decorative.'],
  ['surfaces.rule', 'The hairline under a table head; decorative.'],
  ['surfaces.track and surfaces.trackSoft', 'The empty part of a meter and a chip fill: the filled part and the figure beside it carry the value; decorative.'],
  ['charts.axis (axis line, gridlines at 60%)', 'Tick labels (measured at 4.5:1) and the tooltip carry every value; gridlines and the axis line are decorative guides.'],
  ['rows.selected, rows.differs, rows.stripe, rows.stripeSoft, focus.hover', 'Washes under content: the compared row also carries a mark (3:1, measured) and a dot, the selected row a bar on its left edge in the focus colour (3:1, measured); the hover wash is feedback on top of a focus ring.'],
  ['washes.*', 'Alphas of a section colour behind an active item; the item also carries the section icon, label and weight.'],
  ['Disabled controls (Vuetify disabled opacity)', 'Exempt under WCAG 1.4.3 and 1.4.11: inactive components.'],
  ['Stars, planet terrain, orbit lines in the stars\' colour', 'Physical colours that depict the world, not a meaning; named in the legend by their label.'],
]

const analyse = ({ resolveAppearance, listAppearances, SERIES_ENCODINGS }, options = {}) => {
  const results = []
  const appearances = options.preset ? [resolveAppearance(options.preset)] : listAppearances()

  appearances.forEach((appearance) => {
    const card = parseColor(appearance.surfaces.card)
    const resolve = (path) => {
      const color = parseColor(at(appearance, path))

      return color.a < 1 ? over(color, card) : color
    }

    const report = { id: appearance.id, name: appearance.name, key: appearance.key, slotCount: appearance.charts.categorical.length, text: [], graphics: [], categorical: [], cvd: [], encodings: null }
    const distinct = (surfaces) => surfaces.filter((surface, index) => surfaces.findIndex((other) => hex(resolve(other)) === hex(resolve(surface))) === index)

    TEXT_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
      const background = resolve(surface)
      const foreground = over(parseColor(at(appearance, path)), background)
      const value = ratio(foreground, background)

      report.text.push({ label, foreground: at(appearance, path), surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: TEXT, pass: value >= TEXT })
    }))

    GRAPHIC_CHECKS.forEach(([label, path, surfaces]) => distinct(surfaces).forEach((surface) => {
      const background = resolve(surface)
      const foreground = over(parseColor(at(appearance, path)), background)
      const value = ratio(foreground, background)

      report.graphics.push({ label, foreground: at(appearance, path), surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: GRAPHIC, pass: value >= GRAPHIC })
    }))

    const encodings = SERIES_ENCODINGS
    const unique = (key) => new Set(encodings.map((encoding) => JSON.stringify(encoding[key]))).size === encodings.length
    report.fills = FILL_TONES.map((path) => {
      const fill = resolve(path)
      const value = ratio(parseColor(appearance.inks.onFill), fill)

      return { label: path, foreground: appearance.inks.onFill, surface: at(appearance, path), ratio: value, minimum: TEXT, pass: value >= TEXT }
    })
    report.encodings = { slots: encodings.length, markers: unique('marker'), dashes: unique('dash'), patterns: unique('pattern') }
    appearance.charts.categorical.forEach((color, slot) => {
      distinct(SURFACES).forEach((surface) => {
        const background = resolve(surface)
        const value = ratio(parseColor(color), background)

        report.categorical.push({ slot, color, surface: at(appearance, surface), surfacePath: surface, ratio: value, minimum: GRAPHIC, pass: value >= GRAPHIC })
      })
    })

    Object.entries(MACHADO).concat([['normal vision', null]]).forEach(([vision, matrix]) => {
      const seen = appearance.charts.categorical.map((color) => (matrix ? simulate(parseColor(color), matrix) : parseColor(color)))
      let any = { delta: Infinity, pair: null }
      let neighbour = { delta: Infinity, pair: null }

      for (let first = 0; first < seen.length; first++) {
        for (let second = first + 1; second < seen.length; second++) {
          const delta = deltaE(seen[first], seen[second])

          if (delta < any.delta) {
            any = { delta, pair: [first, second] }
          }

          if (second === first + 1 && delta < neighbour.delta) {
            neighbour = { delta, pair: [first, second] }
          }
        }
      }

      report.cvd.push({ vision, any, neighbour, simulated: seen.map(hex) })
    })

    results.push(report)
  })

  return results
}

const failures = (reports) => reports.flatMap((report) => [
  ...report.text.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.graphics.filter((row) => !row.pass).map((row) => `${report.id}: ${row.label} ${row.foreground} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...report.categorical.filter((row) => !row.pass).map((row) => `${report.id}: slot ${row.slot} ${row.color} on ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1 (a marker or pattern does not stand in for the colour)`),
  ...report.fills.filter((row) => !row.pass).map((row) => `${report.id}: text ${row.foreground} on the ${row.label} fill ${row.surface} is ${row.ratio.toFixed(2)}:1, under ${row.minimum}:1`),
  ...(report.encodings.markers && report.encodings.dashes && report.encodings.patterns && report.encodings.slots === report.slotCount ? [] : [`${report.id}: the series encodings do not give each of the ${report.slotCount} slots its own marker, dash and pattern`]),
  ...report.cvd.filter((row) => row.vision !== 'normal vision' && row.neighbour.delta < CVD_NEIGHBOUR_DELTA).map((row) => `${report.id}: ${row.vision}: neighbouring slots ${row.neighbour.pair.join(' and ')} differ by only ${row.neighbour.delta.toFixed(1)}`),
])

const format = (reports, verbose) => {
  const lines = []
  const mark = (pass) => (pass ? 'ok  ' : 'FAIL')

  reports.forEach((report) => {
    lines.push(`\n== ${report.name} (${report.key}) ==`)
    lines.push('Text, minimum 4.5:1')
    report.text.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surfacePath.split('.')[1]} ${row.surface}`))
    lines.push('Essential graphics and state cues, minimum 3:1')
    report.graphics.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surfacePath.split('.')[1]} ${row.surface}`))
    lines.push('Categorical slots against the card and the page, minimum 3:1 (the encodings come on top of the colour, they do not replace it)')
    report.categorical.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  slot ${row.slot}: ${row.color} on ${row.surfacePath.split('.')[1]} ${row.surface}`))
    lines.push(`Text on filled chips and controls, ink ${report.fills[0].foreground}, minimum 4.5:1`)
    report.fills.forEach((row) => lines.push(`  ${mark(row.pass)} ${row.ratio.toFixed(2).padStart(5)}  ${row.label}: ${row.foreground} on ${row.surface}`))

    lines.push(`Encodings: ${report.encodings.slots} slots, markers unique ${report.encodings.markers}, dashes unique ${report.encodings.dashes}, patterns unique ${report.encodings.patterns}`)
    lines.push('Colour-vision simulation, smallest CIEDE2000 between two slots (any pair, neighbours)')

    report.cvd.forEach((row) => {
      lines.push(`  ${row.vision.padEnd(13)} any ${row.any.delta.toFixed(1).padStart(5)} (${row.any.pair.join('/')})  neighbours ${row.neighbour.delta.toFixed(1).padStart(5)} (${row.neighbour.pair.join('/')})${row.any.delta < CVD_ANY_DELTA && row.vision !== 'normal vision' ? '  close pair: the encodings carry it' : ''}`)

      if (verbose) {
        lines.push(`      ${row.simulated.join(' ')}`)
      }
    })
  })

  lines.push('\nExceptions, not measured:')
  EXCEPTIONS.forEach(([token, reason]) => lines.push(`  ${token}: ${reason}`))

  return lines.join('\n')
}

// Mutations the gate must catch, so that it can't pass by measuring nothing: a slot the colour of the card (its markers and patterns don't make it visible), and a chip whose text is the colour of its fill.
const MUTATIONS = [
  ['a categorical slot the colour of the card', 'light', (appearance) => ({ ...appearance, charts: { ...appearance.charts, categorical: appearance.charts.categorical.map((color, slot) => (slot === 5 ? appearance.surfaces.card : color)) } }), /slot 5 .* under 3:1/],
  ['a chip whose text is its fill', 'dark', (appearance) => ({ ...appearance, plan: { ...appearance.plan, rich: appearance.inks.onFill } }), /plan\.rich fill .* under 4\.5:1/],
  ['a chip with white text on a light fill', 'light', (appearance) => ({ ...appearance, plan: { ...appearance.plan, costly: '#ffb74d' } }), /plan\.costly fill .* under 4\.5:1/],
]

const selfTest = (utilities) => MUTATIONS.map(([label, id, mutate, expected]) => {
  const mutated = mutate(utilities.resolveAppearance(id))
  const found = failures(analyse({ ...utilities, resolveAppearance: () => mutated, listAppearances: () => [mutated] }))

  return { label, caught: found.some((problem) => expected.test(problem)) }
})

const main = async () => {
  const argv = process.argv.slice(2)
  const options = { preset: null, verbose: false }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--preset') {
      options.preset = argv[++index]
    } else if (argv[index] === '--verbose') {
      options.verbose = true
    } else {
      console.error(`Unknown argument ${argv[index]}`)
      process.exit(2)
    }
  }

  const { appearance } = await loadUtilities(['appearance'], { stubs: { vue: 'export default { observable: (value) => value }' } })
  const reports = analyse(appearance, options)
  const problems = failures(reports)

  console.log(format(reports, options.verbose))

  const missed = selfTest(appearance).filter((mutation) => !mutation.caught)

  console.log(`\nSelf-test: ${MUTATIONS.length - missed.length} of ${MUTATIONS.length} mutations are caught`)
  missed.forEach((mutation) => problems.push(`self-test: the gate does not catch ${mutation.label}`))

  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`)
    problems.forEach((problem) => console.log(`  ${problem}`))
    process.exit(1)
  }

  console.log('\nEvery measurement passes.')
}

if (require.main === module) {
  main()
}

module.exports = { analyse, deltaE, parseColor, ratio, simulate }
