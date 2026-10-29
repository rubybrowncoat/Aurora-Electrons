#!/usr/bin/env node
/*
  The Telemagenta preset (src/renderer/utilities/appearance.js: `TELEMAGENTA`), checked without a browser.

  It proves: the preset is the owner's own light palette and nothing else (registered last, light, versioned, no `reference` and no credits entry, the other presets untouched); each colour sampled from the photograph of the room (docs/plans/backlog/evidence/FU-96.md) is used for the roles it is recorded against, in its own hue (cream page and raised cream cards, the ceiling's pink in the rail and the secondary colour, the wall's crimson in the accent, the shadow's brown in both inks); the primary is telemagenta, of the hue of RAL 4010, deepened from it until it is 4.5:1 as text on every cream surface, the selection, focus, hover and row washes are that colour, and the neutral section accent is a deeper telemagenta of its own (a section colour is never the focus colour); no severity and no chart slot is telemagenta, or the same as it under protanopia, deuteranopia or tritanopia, and the four severities stay apart from each other under all three; the inks Vuetify draws are Vuetify's own, which every preset without a reference keeps; the readability matrix passes in the three accent modes; the preset's file round trips; and the preset is previewed, kept and read back at start.

  What a browser shows (the preset card, the pages) is probed separately; the run is recorded in docs/plans/backlog/evidence/FU-96.md. The full gate (the compiled stylesheet, the colour-vision simulation, the map menu) is scripts/check-contrast.js --preset telemagenta.

  Run: node scripts/check-telemagenta-preset.js
*/
const fs = require('fs')
const path = require('path')

const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

let instance = 0

const NAMES = ['appearance-font', 'appearance', 'appearance-file', 'appearance-contrast', 'credits']

const NOTICE = fs.readFileSync(path.join(utilitiesDirectory, 'notices', 'solaris-theme-license.txt'), 'utf8')

const raw = (text) => `export default ${JSON.stringify(text)}`

// credits.js imports licence texts and package versions; each is stood in for by a fixed module, the Solaris notice by the real file.
const stubs = (stamp) => ({
  vue: `export default { observable: (value) => value, set: (target, key, value) => { target[key] = value } }\n// instance ${stamp}`,
  '@mdi/font/LICENSE?raw': raw('mdi licence'),
  '@mdi/font/package.json': 'export const version = "0.0.0"',
  'roboto-fontface/LICENSE?raw': raw('roboto licence'),
  'roboto-fontface/package.json': 'export const version = "0.0.0"',
  './notices/solaris-theme-license.txt?raw': raw(NOTICE),
  './notices/t2d-theme-license.txt?raw': raw('t2d licence'),
})

// A fresh copy of the modules, so the state of one check never reaches another; `sources` is the text of the module a planted fault changes, by name. The files of the folder do not change during a run, so each is read once.
const texts = new Map()

const load = async (sources = {}) => {
  const loaded = await loadUtilities(NAMES, { sources, texts, stubs: stubs(instance++) })

  return { font: loaded['appearance-font'], appearance: loaded.appearance, file: loaded['appearance-file'], contrast: loaded['appearance-contrast'], credits: loaded.credits, reload: () => load(sources) }
}

const fakeConfig = (initial = {}) => ({
  data: JSON.parse(JSON.stringify(initial)),
  writes: [],
  get store() {
    return this.data
  },
  update(change) {
    this.store = change(JSON.parse(JSON.stringify(this.data)))
  },
  set store(value) {
    this.writes.push({ via: 'store', keys: Object.keys(value).sort() })
    this.data = JSON.parse(JSON.stringify(value))
  },
  get(key) {
    return this.data[key]
  },
  set(key, value) {
    this.writes.push({ via: 'set', keys: [key] })
    this.data = { ...this.data, [key]: JSON.parse(JSON.stringify(value)) }
  },
  delete(key) {
    this.writes.push({ via: 'delete', keys: [key] })

    const rest = { ...this.data }

    delete rest[key]
    this.data = rest
  },
})

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 200 ? `${text.slice(0, 200)}…` : text
}

const canonical = (value) => JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner))

const expectEqual = (actual, wanted, label, problems) => {
  if (canonical(actual) !== canonical(wanted)) {
    problems.push(`${label}: ${short(actual)}, wanted ${short(wanted)}`)
  }
}

const verdict = (problems) => (problems.length ? problems.join('; ') : true)

const at = (object, dotted) => dotted.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), object)

// Worked out here from the hex digits, not by the code under check.
const rgb = (color) => [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))

const linearOf = (channel) => {
  const value = channel / 255

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminanceOf = (color) => {
  const [r, g, b] = rgb(color).map(linearOf)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrastOf = (a, b) => {
  const [light, dark] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x)

  return (light + 0.05) / (dark + 0.05)
}

const hueOf = (color) => {
  const [r, g, b] = rgb(color).map((channel) => channel / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)

  if (max === min) {
    return 0
  }

  const spread = max - min
  const hue = max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4

  return (hue * 60 + 360) % 360
}

const saturationOf = (color) => {
  const [r, g, b] = rgb(color)

  return Math.max(r, g, b) === 0 ? 0 : (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b)
}

// The distance of two hues on the colour wheel, in degrees.
const hueGap = (a, b) => {
  const gap = Math.abs(hueOf(a) - hueOf(b)) % 360

  return gap > 180 ? 360 - gap : gap
}

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB; the identity is normal vision.
const VISIONS = {
  'normal vision': [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
}

// A colour as the viewer sees it, in CIELAB (CIE 1976).
const labOf = (color, matrix = VISIONS['normal vision']) => {
  const linear = rgb(color).map(linearOf)
  const [r, g, b] = matrix.map((row) => Math.max(0, Math.min(1, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])))
  const curve = (value) => (value > 216 / 24389 ? Math.cbrt(value) : ((24389 / 27) * value + 16) / 116)
  const x = curve((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047)
  const y = curve(0.2126729 * r + 0.7151522 * g + 0.072175 * b)
  const z = curve((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883)

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

const distanceOf = (a, b, matrix) => {
  const [first, second] = [labOf(a, matrix), labOf(b, matrix)]

  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
}

// The colours sampled from the photograph of the room (reference.png, 2560 x 1920): the mean of a flat region, away from the lamp and the gradients, with the region in the 1568 px wide view the sample was taken in. The photograph is under-exposed (the white trim reads #B6B0A3), so a sample gives a hue and a saturation, and the lightness is lifted where the preset draws a surface.
const SAMPLES = {
  creamWall: { region: 'right wall, lit: x 1400-1560, y 700-900', value: '#cfcab7' },
  creamWallShaded: { region: 'left wall, shaded: x 20-200, y 480-640', value: '#aa977a' },
  ceiling: { region: 'ceiling, right and lit: x 1150-1500, y 100-350', value: '#bfafa2' },
  ceilingPink: { region: 'ceiling by the corner, shadowed: x 500-900, y 440-520', value: '#9b7363' },
  trim: { region: 'trim, right band: x 1260-1500, y 520-580', value: '#b6b0a3' },
  magentaWall: { region: 'accent wall: x 450-1100, y 700-1100', value: '#840021' },
  shadowDark: { region: 'brown corner, in shadow: x 20-180, y 1000-1150', value: '#240a03' },
  shadowLit: { region: 'brown corner, lit: x 20-110, y 830-880', value: '#634a3a' },
}

// RAL 4010 Telemagenta, the colour the owner names, as the colour charts give it.
const TELEMAGENTA = '#cf3476'

// What each role takes from the photograph and the most its hue may lie from the sample's, in degrees.
const MAPPED = [
  ['the cream page', 'surfaces.background', 'creamWall', 10],
  ['the cream card', 'surfaces.card', 'creamWall', 10],
  ['the rail and footer', 'surfaces.chrome', 'ceiling', 14],
  ['the secondary colour', 'focus.secondary', 'ceilingPink', 10],
  ['the accent', 'focus.accent', 'magentaWall', 6],
  ['the body ink', 'inks.body', 'shadowDark', 14],
  ['the secondary ink', 'inks.muted', 'shadowLit', 8],
]

const SURFACE_PATHS = ['surfaces.background', 'surfaces.card', 'surfaces.chrome']

// The least distance (CIELAB, CIE 1976) the primary keeps from a severity or a chart slot, and the severities from each other, under normal vision and each deficiency.
const LEAST_DISTANCE = 12

const SEVERITIES = ['action', 'attention', 'info', 'success']

const telemagenta = (ctx) => ctx.appearance.resolveAppearance('telemagenta')

// Every string of a value.
const strings = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])

// The paths of what is not plain data (a function, an undefined member, a symbol) in a value.
const notData = (value, where = 'preset') => (value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => notData(inner, `${where}.${key}`)) : ['string', 'number', 'boolean'].includes(typeof value) || value === null ? [] : [`${where} is ${typeof value}`])

const FIRST_OR_SECOND_PERSON = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i

// The red, green and blue digits of a colour written `#rrggbb` or `rgba(r, g, b, a)`.
const channelsOf = (color) => (color.startsWith('#') ? rgb(color) : color.match(/[\d.]+/g).slice(0, 3).map(Number))

// Every colour the file format maps, as `group.role`, with the preset's value, hex digits only.
const colourPaths = (ctx, appearance) => Object.keys(ctx.file.ROLES).flatMap((group) => Object.keys(ctx.file.ROLES[group]).map((role) => `${group}.${role}`)).filter((dotted) => /^#[0-9a-f]{6}$/i.test(String(at(appearance, dotted))))

const CHECKS = [
  ['the preset is the owner\'s own light palette and nothing more: registered after every other preset, light, versioned, with no reference and no credits entry, and the other presets keep their identity and version', async (ctx) => {
    const problems = []
    const ids = ctx.appearance.listAppearances().map(({ id }) => id)
    const appearance = telemagenta(ctx)

    expectEqual(ids, ['light', 'dark', 'classic', 'solaris', 't2d', 'cristo', 'deepblue', 'telemagenta'], 'the presets in order', problems)
    expectEqual([appearance.id, appearance.name, appearance.mode, appearance.key], ['telemagenta', 'Telemagenta', 'light', 'telemagenta@1'], 'the identity', problems)
    expectEqual(Number.isInteger(appearance.version) && appearance.version >= 1, true, 'the version is a positive integer', problems)
    expectEqual(appearance.reference, null, 'the preset adapts no community theme, so it carries no reference (as Light and Dark do not)', problems)
    expectEqual(ctx.credits.CREDITS.filter((credit) => /telemagenta/i.test(JSON.stringify({ ...credit, notices: undefined }))).map(({ id }) => id), [], 'no credits entry names the preset', problems)
    expectEqual(ctx.credits.CREDITS.map(({ id }) => id), ['roboto', 'mdi', 'solaris-theme', 'deepblue-theme', 't2d-theme', 'cristo-theme'], 'the credits entries are the ones before the preset', problems)
    expectEqual(ids.map((id) => ctx.appearance.resolveAppearance(id).key).slice(0, 7), ['light@5', 'dark@5', 'classic@2', 'solaris@2', 't2d@1', 'cristo@1', 'deepblue@1'], 'the other presets keep their versions', problems)
    expectEqual(ctx.appearance.resolveAppearance('light').inks.text, 'rgba(0, 0, 0, 0.87)', 'Light keeps Vuetify\'s text ink', problems)

    return verdict(problems)
  }],

  ['the colours sampled from the photograph are on the record and each is used in its own hue for the roles it is recorded against: the cream page and cards, the ceiling pink, the wall\'s crimson, the shadow\'s brown', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)

    Object.entries(SAMPLES).forEach(([name, { value, region }]) => {
      expectEqual([/^#[0-9a-f]{6}$/.test(value), region.length > 0], [true, true], `the sample ${name} is a recorded colour of a recorded region`, problems)
    })
    expectEqual(Object.keys(SAMPLES).length, 8, 'the samples on the record', problems)
    MAPPED.forEach(([role, dotted, sample, within]) => {
      const colour = String(at(appearance, dotted))
      const gap = hueGap(colour, SAMPLES[sample].value)

      if (gap > within) {
        problems.push(`${role} (${dotted}) ${colour} is ${gap.toFixed(1)} degrees of hue from the ${sample} sample ${SAMPLES[sample].value}, over ${within}`)
      }
    })
    expectEqual(luminanceOf(appearance.surfaces.background) > luminanceOf(SAMPLES.creamWall.value), true, 'the page is the sample\'s hue lifted out of the photograph\'s under-exposure', problems)
    expectEqual(luminanceOf(appearance.inks.body) < luminanceOf(SAMPLES.shadowLit.value) && luminanceOf(appearance.inks.muted) < luminanceOf(SAMPLES.creamWall.value), true, 'the inks are the brown, darkened', problems)

    return verdict(problems)
  }],

  ['the base reads as cream and the cards as raised: a warm yellow-white page of low saturation, the cards lighter than the page by a step that shows, the rail neither the page nor a card, and the border a darker cream', async (ctx) => {
    const problems = []
    const { surfaces } = telemagenta(ctx)

    expectEqual([hueOf(surfaces.background) >= 35 && hueOf(surfaces.background) <= 55, saturationOf(surfaces.background) >= 0.06 && saturationOf(surfaces.background) <= 0.16], [true, true], `the page ${surfaces.background} is cream (hue ${hueOf(surfaces.background).toFixed(0)}, saturation ${saturationOf(surfaces.background).toFixed(2)})`, problems)
    expectEqual(luminanceOf(surfaces.background) >= 0.82 && luminanceOf(surfaces.background) <= 0.92, true, `the page is light but not white (${luminanceOf(surfaces.background).toFixed(2)})`, problems)
    expectEqual(luminanceOf(surfaces.card) > luminanceOf(surfaces.background), true, 'the card is lighter than the page', problems)
    expectEqual(distanceOf(surfaces.card, surfaces.background) >= 4, true, `the card is ${distanceOf(surfaces.card, surfaces.background).toFixed(1)} from the page, so it reads as raised`, problems)
    expectEqual([surfaces.chrome === surfaces.background, surfaces.chrome === surfaces.card], [false, false], 'the rail and footer are a colour of their own', problems)
    expectEqual(luminanceOf(surfaces.border) < luminanceOf(surfaces.background) && hueGap(surfaces.border, surfaces.background) <= 12, true, 'the border is a darker cream', problems)

    return verdict(problems)
  }],

  ['the primary is telemagenta: of the hue of RAL 4010, deepened from it until it is 4.5:1 as text on the page, the cards and the rail (RAL 4010 itself is not on the page or the rail), the selection, focus, hover, row washes and compared-row mark are that colour, and the neutral section accent is a deeper telemagenta of its own', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)
    const { primary } = appearance.focus

    expectEqual(hueGap(primary, TELEMAGENTA) <= 5, true, `the primary ${primary} is ${hueGap(primary, TELEMAGENTA).toFixed(1)} degrees of hue from RAL 4010 ${TELEMAGENTA}`, problems)
    expectEqual(saturationOf(primary) >= 0.7, true, `the primary is saturated (${saturationOf(primary).toFixed(2)})`, problems)
    expectEqual(luminanceOf(primary) < luminanceOf(TELEMAGENTA), true, 'the primary is deeper than RAL 4010', problems)
    SURFACE_PATHS.forEach((dotted) => {
      const surface = at(appearance, dotted)

      expectEqual(dotted === 'surfaces.card' || contrastOf(TELEMAGENTA, surface) < 4.5, true, `RAL 4010 on ${dotted} is under 4.5:1 (${contrastOf(TELEMAGENTA, surface).toFixed(2)}), the reason it is deepened`, problems)

      if (contrastOf(primary, surface) < 4.5) {
        problems.push(`the primary on ${dotted} is ${contrastOf(primary, surface).toFixed(2)}:1, under 4.5:1`)
      }
    })
    expectEqual([appearance.sections.neutral !== primary, hueGap(appearance.sections.neutral, primary) <= 6, luminanceOf(appearance.sections.neutral) < luminanceOf(primary), saturationOf(appearance.sections.neutral) >= 0.7], [true, true, true, true], `the neutral section accent ${appearance.sections.neutral} is a deeper telemagenta of its own (the section colours are never the focus colour)`, problems)
    expectEqual(appearance.rows.differsMark, primary, 'the compared-row mark is the primary', problems)
    ;['focus.hover', 'rows.selected', 'rows.differs', 'rows.differsDot', 'rows.stripe', 'rows.stripeSoft'].forEach((dotted) => {
      expectEqual(channelsOf(String(at(appearance, dotted))), rgb(primary), `${dotted} is a wash of the primary`, problems)
    })
    expectEqual(contrastOf(appearance.focus.accent, appearance.surfaces.card) >= 4.5 && luminanceOf(appearance.focus.accent) < luminanceOf(primary), true, 'the accent is the deeper crimson of the wall', problems)

    return verdict(problems)
  }],

  ['no severity and no chart slot is telemagenta, in colour or under protanopia, deuteranopia or tritanopia, and the four severities stay apart from each other under all three', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)
    const { primary } = appearance.focus
    const others = [...SEVERITIES.map((level) => [`severity ${level}`, appearance.severity[level]]), ...appearance.charts.categorical.map((colour, index) => [`chart slot ${index + 1}`, colour]), ...appearance.sections.accents.map((colour, index) => [`section accent ${index + 1}`, colour])]

    others.forEach(([label, colour]) => {
      expectEqual(hueGap(colour, primary) >= 15, true, `${label} ${colour} is ${hueGap(colour, primary).toFixed(0)} degrees of hue from the primary`, problems)
      Object.entries(VISIONS).forEach(([vision, matrix]) => {
        const distance = distanceOf(colour, primary, matrix)

        if (distance < LEAST_DISTANCE) {
          problems.push(`${label} ${colour} is ${distance.toFixed(1)} from the primary under ${vision}, under ${LEAST_DISTANCE}`)
        }
      })
    })
    SEVERITIES.forEach((first, index) => SEVERITIES.slice(index + 1).forEach((second) => {
      Object.entries(VISIONS).forEach(([vision, matrix]) => {
        const distance = distanceOf(appearance.severity[first], appearance.severity[second], matrix)

        if (distance < LEAST_DISTANCE) {
          problems.push(`severity ${first} and ${second} are ${distance.toFixed(1)} apart under ${vision}, under ${LEAST_DISTANCE}`)
        }
      })
    }))
    expectEqual(new Set(appearance.charts.categorical.map((colour) => colour.toLowerCase())).size, 9, 'the nine chart slots are distinct', problems)
    expectEqual(new Set(appearance.sections.accents.map((colour) => colour.toLowerCase())).size, 9, 'the nine section accents are distinct', problems)
    expectEqual(canonical(appearance.sections.accents) === canonical(appearance.charts.categorical), true, 'the section accents are copies of the chart slots, as in every preset with a palette of its own', problems)

    return verdict(problems)
  }],

  ['the inks Vuetify draws are Vuetify\'s own, as for every preset without a reference, and the body and muted inks are the warm brown, 4.5:1 or more on every surface, with the white on-colour ink 4.5:1 on the primary and the severities', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)
    const light = ctx.appearance.resolveAppearance('light')

    ;['text', 'textMuted', 'onTooltip', 'onColor', 'onSnackbar'].forEach((token) => {
      expectEqual(appearance.inks[token], light.inks[token], `inks.${token} is Vuetify's own, as in Light`, problems)
    })
    ;[['inks.body', 8, 30], ['inks.muted', 8, 30]].forEach(([dotted, from, to]) => {
      const hue = hueOf(at(appearance, dotted))

      expectEqual(hue >= from && hue <= to && saturationOf(at(appearance, dotted)) >= 0.2, true, `${dotted} ${at(appearance, dotted)} is a warm brown (hue ${hue.toFixed(0)})`, problems)
      SURFACE_PATHS.forEach((surface) => {
        if (contrastOf(at(appearance, dotted), at(appearance, surface)) < 4.5) {
          problems.push(`${dotted} on ${surface} is ${contrastOf(at(appearance, dotted), at(appearance, surface)).toFixed(2)}:1, under 4.5:1`)
        }
      })
    })
    ;['focus.primary', ...SEVERITIES.map((level) => `severity.${level}`)].forEach((dotted) => {
      if (contrastOf('#ffffff', at(appearance, dotted)) < 4.5) {
        problems.push(`white on ${dotted} ${at(appearance, dotted)} is ${contrastOf('#ffffff', at(appearance, dotted)).toFixed(2)}:1, under 4.5:1`)
      }
    })

    return verdict(problems)
  }],

  ['the preview and the cards are not those of Light, and the colours of the file format are not Light\'s but the preset\'s: the page, the cards, the rail, the primary and the inks each at least their least distance from Light\'s, and fewer than half of the colours are the same', async (ctx) => {
    const problems = []
    const fresh = await ctx.reload()

    fresh.appearance.previewPreset('light')

    const light = JSON.parse(JSON.stringify(fresh.appearance.activeAppearance()))

    fresh.appearance.previewPreset('telemagenta')

    const preview = JSON.parse(JSON.stringify(fresh.appearance.activeAppearance()))

    expectEqual([light.id, preview.id], ['light', 'telemagenta'], 'the two previews', problems)
    ;[['the page', 'surfaces.background', 6], ['the cards', 'surfaces.card', 3], ['the rail and footer', 'surfaces.chrome', 6], ['the primary', 'focus.primary', 40], ['the body ink', 'inks.body', 6]].forEach(([label, dotted, least]) => {
      const distance = distanceOf(at(preview, dotted), at(light, dotted))

      if (distance < least) {
        problems.push(`${label}: ${at(preview, dotted)} is ${distance.toFixed(1)} from Light's ${at(light, dotted)}, under ${least}`)
      }
    })

    const paths = colourPaths(ctx, preview)
    const same = paths.filter((dotted) => String(at(preview, dotted)).toLowerCase() === String(at(light, dotted)).toLowerCase())

    expectEqual(paths.length > 40, true, `the colours compared (${paths.length})`, problems)
    expectEqual(same.length < paths.length / 2, true, `the share of colours the same as Light's: ${same.length} of ${paths.length}`, problems)
    fresh.appearance.cancelPreview()

    return verdict(problems)
  }],

  ['the preset is plain data, its wording and the exported file keep off the first and second person, and nothing but colour values is added: no image, font or notice file', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)
    const exported = JSON.stringify(ctx.appearance.exportAppearanceFile('telemagenta', 1000))

    expectEqual(notData(ctx.appearance.PRESETS.telemagenta), [], 'the members of the preset that are not plain data', problems)
    ;[...strings(appearance.name), exported].forEach((text) => {
      const person = FIRST_OR_SECOND_PERSON.exec(text)

      if (person) {
        problems.push(`the word "${person[0]}" in ${short(text)}`)
      }
    })
    expectEqual(fs.readdirSync(path.join(utilitiesDirectory, 'notices')).filter((name) => /telemagenta/i.test(name)), [], 'no notice file of its own', problems)
    expectEqual(fs.readdirSync(path.join(root, 'src', 'renderer', 'utilities')).filter((name) => /\.(png|jpe?g|gif|ttf|otf|woff2?)$/i.test(name)), [], 'no image or font among the utilities', problems)

    return verdict(problems)
  }],

  ['the readability matrix passes in the on, restrained and off accent modes: every measurement of the contrast report, the nine accents and the neutral one as graphics (on the bare surfaces, on their own active and hover washes, on the icon plates over them, in a hovered table row and under the overlay of a list entry) and as text, the page\'s text on those washes, and the report has no blocking finding', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)
    const baseline = ctx.appearance.resolveAppearance('light')
    const report = ctx.file.contrastReport(appearance, { baseline })
    const measured = ctx.contrast.measureAppearance(appearance, { baseline })

    expectEqual([report.findings, report.blocking], [[], []], 'the findings and blocking findings of the report', problems)
    expectEqual(report.checked > 200, true, `the report measures ${report.checked} values`, problems)

    ctx.contrast.ACCENT_MODES.forEach((mode) => {
      const graphics = measured.sections.filter((row) => row.mode === mode)
      const washes = measured.sectionWashes.filter((row) => row.mode === mode)
      const texts = measured.sectionText.filter((row) => row.mode === mode)
      const washTexts = measured.washText.filter((row) => row.mode === mode)
      const wanted = mode === 'off' ? [true, true, true, true, 1, 1, 1, 1] : [true, true, true, true, 9, 9, 9, 9]

      expectEqual([graphics.length > 0, washes.length > 0, texts.length > 0, washTexts.length > 0, new Set(graphics.map((row) => row.section)).size, new Set(washes.map((row) => row.section)).size, new Set(texts.map((row) => row.section)).size, new Set(washTexts.map((row) => row.section)).size], wanted, `${mode}: the sections measured (one neutral accent with the accents off, else the nine)`, problems)
      graphics.forEach((row) => {
        if (!row.pass) {
          problems.push(`${mode}: section ${row.section === null ? 'neutral' : row.section + 1} accent ${row.color} on ${row.surface} is ${row.ratio.toFixed(2)}:1 as a graphic`)
        }
      })
      washes.forEach((row) => {
        if (!row.pass) {
          problems.push(`${mode}: section ${row.section === null ? 'neutral' : row.section + 1} accent ${row.color} on its ${row.state} over the ${row.surfacePath.split('.')[1]} ${row.surface} is ${row.ratio.toFixed(2)}:1`)
        }
      })
      texts.forEach((row) => {
        if (!row.pass) {
          problems.push(`${mode}: section ${row.section === null ? 'neutral' : row.section + 1} text ${row.color} on ${row.surface} is ${row.ratio.toFixed(2)}:1`)
        }
      })
      washTexts.forEach((row) => {
        if (!row.pass) {
          problems.push(`${mode}: section ${row.section === null ? 'neutral' : row.section + 1} wash: ${row.ink} ${row.foreground} on its ${row.state} over the ${row.surfacePath.split('.')[1]} ${row.surface} is ${row.ratio.toFixed(2)}:1`)
        }
      })
      expectEqual(ctx.contrast.sectionTexts(appearance, mode).length, 9, `${mode}: nine text colours`, problems)
    })
    measured.listText.filter((row) => !row.pass).forEach((row) => {
      problems.push(`list: ${row.ink} on the ${row.state} over the card ${row.surface} (the overlay ${row.overlay} at ${row.opacity}) is ${row.ratio.toFixed(2)}:1`)
    })

    const rows = measured.rows.filter((row) => !row.pass)

    expectEqual(rows.map((row) => `${row.label || row.state}: ${row.ratio.toFixed(2)}`), [], 'the table row washes: every text colour of the preset, severity tones included, stays 4.5:1 on them', problems)

    return verdict(problems)
  }],

  ['the file of the preset round trips without a reference: the roles are the same, the origin is the built-in preset at its version, the file carries no reference, and the draft passes the contrast gate', async (ctx) => {
    const problems = []
    const appearance = telemagenta(ctx)
    const exported = ctx.appearance.exportAppearanceFile('telemagenta', 1000)

    expectEqual([exported.provenance.origin.kind, exported.provenance.origin.id, exported.provenance.origin.version, exported.mode, exported.base], ['built-in', 'telemagenta', appearance.version, 'light', 'telemagenta'], 'the origin', problems)
    expectEqual(exported.provenance.reference, undefined, 'the file carries no reference', problems)

    const imported = ctx.appearance.importAppearanceFile(JSON.stringify(exported))

    expectEqual(imported.ok, true, 'the file is read', problems)

    if (imported.ok) {
      const draft = imported.entry.appearance

      Object.keys(ctx.file.ROLES).forEach((group) => {
        Object.keys(ctx.file.ROLES[group]).forEach((role) => {
          const wanted = at(appearance, `${group}.${role}`)

          if (wanted !== undefined) {
            expectEqual(at(draft, `${group}.${role}`), wanted, `${group}.${role} after the round trip`, problems)
          }
        })
      })
      expectEqual([draft.file.defaults.length, draft.file.base.id], [0, 'telemagenta'], 'the draft fills nothing from a base and names the preset as its base', problems)
      expectEqual(imported.entry.report.findings, [], 'the findings of the draft', problems)
    }

    ctx.appearance.cancelPreview()

    return verdict(problems)
  }],

  ['the preset is previewed, kept and read back at start under each accent mode, and the accent mode is the one kept, not the preset\'s', async (ctx) => {
    const problems = []

    for (const mode of ['on', 'restrained', 'off']) {
      const fresh = await ctx.reload()
      const config = fakeConfig({})

      fresh.appearance.loadAppearance(config)
      fresh.appearance.applyAccents(config, mode)
      fresh.appearance.previewPreset('telemagenta')
      expectEqual([fresh.appearance.activeAppearance().id, fresh.appearance.isPreviewing(), fresh.appearance.accentMode(), config.data.appearance], ['telemagenta', true, mode, undefined], `${mode}: the preview`, problems)

      fresh.appearance.cancelPreview()
      expectEqual([fresh.appearance.activeAppearance().id, fresh.appearance.isPreviewing()], ['light', false], `${mode}: the cancelled preview`, problems)
      expectEqual(fresh.appearance.applyPreset(config, 'telemagenta'), true, `${mode}: kept`, problems)
      expectEqual([config.data.appearance, config.data.appearanceAccents, fresh.appearance.activeAppearance().key], ['telemagenta', mode, 'telemagenta@1'], `${mode}: the settings`, problems)

      const again = await ctx.reload()

      again.appearance.loadAppearance(fakeConfig(config.data))
      expectEqual([again.appearance.activeAppearance().id, again.appearance.appliedPresetId(), again.appearance.accentMode()], ['telemagenta', 'telemagenta', mode], `${mode}: after a restart`, problems)
      expectEqual(again.appearance.unsupportedPresetId(fakeConfig(config.data)), null, `${mode}: the stored id is supported`, problems)
    }

    return verdict(problems)
  }],
]

const CONTRAST = 'appearance-contrast.js'
const APPEARANCE = 'appearance.js'

const ACCENTS = ['#2874cf', '#c64414', '#165a2d', '#9d6900', '#6b3f2a', '#008300', '#4a3aa7', '#bd2d2c', '#00808e']
const sectionsOf = (neutral, accents) => `sections: { neutral: '${neutral}', accents: [${accents.map((color) => `'${color}'`).join(', ')}] }`
const categoricalOf = (accents) => `categorical: [${accents.map((color) => `'${color}'`).join(', ')}]`
const WITHOUT = (index, colour) => ACCENTS.map((accent, at) => (at === index ? colour : accent))

const MUTATIONS = [
  ['the primary as the chart gives RAL 4010, which is under 4.5:1 as text on the page', { file: APPEARANCE, from: "focus: { primary: '#b8286a'", to: "focus: { primary: '#cf3476'" }],
  ['a primary of another hue', { file: APPEARANCE, from: "focus: { primary: '#b8286a'", to: "focus: { primary: '#2874cf'" }],
  ['a hover wash of another hue', { file: APPEARANCE, from: "hover: 'rgba(184, 40, 106, .06)'", to: "hover: 'rgba(33, 150, 243, .06)'" }],
  ['a selected row wash of another hue', { file: APPEARANCE, from: "selected: 'rgba(184, 40, 106, .08)', differs", to: "selected: 'rgba(33, 150, 243, .08)', differs" }],
  ['the compared-row mark of another colour', { file: APPEARANCE, from: "differsMark: '#b8286a'", to: "differsMark: '#1e88e5'" }],
  ['a neutral section accent that is the primary, which a section colour never is', { file: APPEARANCE, from: sectionsOf('#a31f5c', ACCENTS), to: sectionsOf('#b8286a', ACCENTS) }],
  ['a neutral section accent that is not telemagenta', { file: APPEARANCE, from: sectionsOf('#a31f5c', ACCENTS), to: sectionsOf('#6a5446', ACCENTS) }],
  ['a white page, not cream', { file: APPEARANCE, from: "background: '#f6eedc'", to: "background: '#ffffff'" }],
  ['a grey page', { file: APPEARANCE, from: "background: '#f6eedc'", to: "background: '#e6e6e6'" }],
  ['a card the colour of the page', { file: APPEARANCE, from: "card: '#fffbf2'", to: "card: '#f6eedc'" }],
  ['a card darker than the page', { file: APPEARANCE, from: "card: '#fffbf2'", to: "card: '#efe5cf'" }],
  ['a rail the colour of the page', { file: APPEARANCE, from: "chrome: '#f3e9de'", to: "chrome: '#f6eedc'" }],
  ['a rail of a cool grey', { file: APPEARANCE, from: "chrome: '#f3e9de'", to: "chrome: '#e3e8ee'" }],
  ['a secondary colour that is not the ceiling pink', { file: APPEARANCE, from: "secondary: '#dcc3b8'", to: "secondary: '#b0bec5'" }],
  ['an accent that is not the wall\'s crimson', { file: APPEARANCE, from: "accent: '#8a0030'", to: "accent: '#0030ff'" }],
  ['a cold body ink', { file: APPEARANCE, from: "body: '#2a1a12'", to: "body: '#121a2a'" }],
  ['a body ink that is neutral black', { file: APPEARANCE, from: "body: '#2a1a12'", to: "body: '#212121'" }],
  ['a secondary ink too pale to read on the page', { file: APPEARANCE, from: "muted: '#6a5446'", to: "muted: '#b0a090'" }],
  ['a secondary ink of a cold grey', { file: APPEARANCE, from: "muted: '#6a5446'", to: "muted: '#616161'" }],
  ['a Vuetify text ink changed from Vuetify\'s own', { file: APPEARANCE, from: "text: 'rgba(0, 0, 0, 0.87)', textMuted: 'rgba(0, 0, 0, 0.6)', onTooltip: '#ffffff', onFill: '#ffffff', onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' },\n  focus: { primary: '#b8286a'", to: "text: '#2a1a12', textMuted: 'rgba(0, 0, 0, 0.6)', onTooltip: '#ffffff', onFill: '#ffffff', onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' },\n  focus: { primary: '#b8286a'" }],
  ['an on-colour ink that is black on the primary', { file: APPEARANCE, from: "onFill: '#ffffff', onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' },\n  focus: { primary: '#b8286a'", to: "onFill: '#ffffff', onColor: '#000000', onSnackbar: 'rgba(255, 255, 255, 0.87)' },\n  focus: { primary: '#b8286a'" }],
  ['a magenta needs-action severity', { file: APPEARANCE, from: "severity: { action: '#8f1111'", to: "severity: { action: '#c2185b'" }],
  ['a needs-action severity that merges with the attention amber under deuteranopia', { file: APPEARANCE, from: "severity: { action: '#8f1111'", to: "severity: { action: '#b71c1c'" }],
  ['an info severity that is the success green', { file: APPEARANCE, from: "info: '#0966b2', success: '#307133' }", to: "info: '#307133', success: '#307133' }" }],
  ['a pink chart slot', { file: APPEARANCE, from: categoricalOf(ACCENTS), to: categoricalOf(WITHOUT(4, '#c2185b')) }],
  ['a forest-green chart slot swapped back to the green that merges with the primary under deuteranopia', { file: APPEARANCE, from: categoricalOf(ACCENTS), to: categoricalOf(WITHOUT(2, '#14845d')) }],
  ['a section accent that is pink', { file: APPEARANCE, from: sectionsOf('#a31f5c', ACCENTS), to: sectionsOf('#a31f5c', WITHOUT(4, '#c2185b')) }],
  ['a repeated section accent', { file: APPEARANCE, from: sectionsOf('#a31f5c', ACCENTS), to: sectionsOf('#a31f5c', WITHOUT(8, ACCENTS[0])) }],
  ['a section accent the colour of the card', { file: APPEARANCE, from: sectionsOf('#a31f5c', ACCENTS), to: sectionsOf('#a31f5c', WITHOUT(8, '#fffbf2')) }],
  ['section accents that are no longer the chart slots', { file: APPEARANCE, from: sectionsOf('#a31f5c', ACCENTS), to: sectionsOf('#a31f5c', WITHOUT(7, '#b02b2a')) }],
  ['an active wash so strong that the accents do not read on it', { file: APPEARANCE, from: 'washes: { sectionSoft: 0.14, sectionTint: 0.08, statusSoft: 0.18 },\n}\n\n// Every preset by id', to: 'washes: { sectionSoft: 0.9, sectionTint: 0.08, statusSoft: 0.18 },\n}\n\n// Every preset by id' }],
  ['a planner tone that is under 4.5:1 as text on the page', { file: APPEARANCE, from: "mining: '#9f4e00'", to: "mining: '#d46b00'" }],
  ['the mode set to dark', { file: APPEARANCE, from: "name: 'Telemagenta',\n  version: 1,\n  mode: 'light',", to: "name: 'Telemagenta',\n  version: 1,\n  mode: 'dark'," }],
  ['a reference added to the preset', { file: APPEARANCE, from: "name: 'Telemagenta',\n  version: 1,\n  mode: 'light',", to: "name: 'Telemagenta',\n  version: 1,\n  mode: 'light',\n  reference: { title: 'x', summary: 'y' }," }],
  ['the version of the preset lowered', { file: APPEARANCE, from: "id: 'telemagenta',\n  name: 'Telemagenta',\n  version: 1,", to: "id: 'telemagenta',\n  name: 'Telemagenta',\n  version: 0," }],
  ['the name in the first person', { file: APPEARANCE, from: "name: 'Telemagenta',", to: "name: 'My Telemagenta'," }],
  ['an undefined member in the preset', { file: APPEARANCE, from: "  id: 'telemagenta',\n  name: 'Telemagenta',", to: "  id: 'telemagenta',\n  unset: undefined,\n  name: 'Telemagenta'," }],
  ['a preset that carries a function', { file: APPEARANCE, from: "  id: 'telemagenta',\n  name: 'Telemagenta',", to: "  id: 'telemagenta',\n  load: () => 0,\n  name: 'Telemagenta'," }],
  ['the preset left out of the list', { file: APPEARANCE, from: 'export const listAppearances = () => Object.keys(PRESETS).map((id) => resolveAppearance(id))', to: "export const listAppearances = () => Object.keys(PRESETS).filter((id) => id !== 'telemagenta').map((id) => resolveAppearance(id))" }],
  ['the preset listed before the others', { file: APPEARANCE, from: 'export const PRESETS = { [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [CRISTO.id]: CRISTO, [DEEPBLUE.id]: DEEPBLUE, [TELEMAGENTA.id]: TELEMAGENTA }', to: 'export const PRESETS = { [TELEMAGENTA.id]: TELEMAGENTA, [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [CRISTO.id]: CRISTO, [DEEPBLUE.id]: DEEPBLUE }' }],
  ['the text of a chosen list entry measured under Vuetify\'s strongest overlay', { file: CONTRAST, from: "const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : veil", to: "const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : VUETIFY_LIST_STATES[appearance.mode].pressed" }],
]

// The utilities as the checks load them with the fault planted: the text of the one module that changes, by name, and the others read from the folder.
const plantedSources = ({ file, from, to }) => ({ [file.replace(/\.js$/, '')]: patched(file, fs.readFileSync(path.join(utilitiesDirectory, file), 'utf8'), from, to) })

const runChecks = async (sources, first) => {
  const results = []
  let modules = first

  for (const [name, check] of CHECKS) {
    try {
      results.push([name, await check(modules ?? await load(sources))])
    } catch (error) {
      results.push([name, `threw: ${error.message}`])
    }

    modules = undefined
  }

  return results
}

// A planted fault is judged only when it applies exactly once, the source it leaves parses and the modules it leaves still load: a fault that breaks the syntax of a module (one the checks load or not) or whose anchor matches nothing makes the checks throw, and a thrown check counts as failed, so such a fault would be reported as caught without any check having looked at what it was meant to plant. It is reported as invalid instead, and fails the run.
const judge = async (fault) => {
  try {
    let sources
    let modules

    try {
      sources = plantedSources(fault)
      modules = await load(sources)
    } catch (error) {
      return { invalid: error.message }
    }

    return { failed: (await runChecks(sources, modules)).map(([, result], index) => [index + 1, result]).filter(([, result]) => result !== true).map(([index]) => index) }
  } catch (error) {
    return { error: error.message }
  }
}

// Faults the runner must report as invalid, and not as caught (the self-test of `judge`): a module that does not parse, a module outside the ones the checks load that does not parse, and an anchor that matches nothing.
const INVALID = [
  ['a module that does not parse', { file: APPEARANCE, from: 'export const PRESETS = {', to: 'export const PRESETS = ] {' }],
  ['a module that the checks do not load and that does not parse', { file: 'map-borders.js', from: 'context.font = type.font(NAME_SIZE)', to: 'context.font = ] type.font(NAME_SIZE)' }],
  ['an anchor that matches nothing', { file: APPEARANCE, from: 'export const PRESETS = {{{', to: 'export const PRESETS = {' }],
]

// Each fault is judged in a process of its own (`--fault <index>`), so that the faults run side by side (CHECK_JOBS) and each fresh copy of the modules is freed with its process.
const FAULTS = [...MUTATIONS, ...INVALID].map(([, fault]) => fault)

const judgeApart = async (index) => {
  try {
    return lastJson(await runChild(__filename, ['--fault', String(index)]))
  } catch (error) {
    return { error: error.message }
  }
}

const run = async () => {
  let failures = 0
  let checks = 0
  const tally = (ok) => {
    checks++

    if (!ok) {
      failures++
    }
  }

  console.log('Telemagenta preset')

  const verdicts = inParallel([...FAULTS.keys()], judgeApart)

  for (const [name, result] of await runChecks()) {
    tally(result === true)
    console.log(`${result === true ? 'PASS' : 'FAIL'}  ${name}${result === true ? '' : `  [${typeof result === 'string' ? result : 'false'}]`}`)
  }

  console.log('\nMutations: each must fail at least one check, and the checks it fails are listed by number')

  const judged = await verdicts

  for (const [index, [label]] of MUTATIONS.entries()) {
    const { failed, invalid, error } = judged[index]

    if (invalid !== undefined) {
      tally(false)
      console.log(`FAIL  invalid mutant: ${label}  [${invalid}]`)
    } else if (error !== undefined) {
      tally(false)
      console.log(`FAIL  mutation caught: ${label}  [${error}]`)
    } else {
      tally(failed.length > 0)
      console.log(`${failed.length ? 'PASS' : 'FAIL'}  mutation caught: ${label}  [${failed.length ? `fails check ${failed.join(', ')}` : 'every check still passes'}]`)
    }
  }

  for (const [index, [label]] of INVALID.entries()) {
    const unparsable = judged[MUTATIONS.length + index]

    tally(unparsable.invalid !== undefined)
    console.log(`${unparsable.invalid !== undefined ? 'PASS' : 'FAIL'}  runner: ${label} is reported as an invalid mutant and not as caught${unparsable.invalid !== undefined ? '' : `  [${JSON.stringify(unparsable)}]`}`)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

if (process.argv[2] === '--fault') {
  judge(FAULTS[Number(process.argv[3])]).then((verdict) => console.log(JSON.stringify(verdict)))
} else {
  run().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}
