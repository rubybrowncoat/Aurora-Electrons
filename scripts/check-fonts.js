#!/usr/bin/env node
/*
  The typeface and text size choice (src/renderer/utilities/appearance-font.js), checked without a browser.

  It proves: the families offered are a bounded, licensed list (a bundled one has its face declared by the package that ships it, with the licence the app credits; a system one is only named), the text sizes are a short ascending list around 100 %, a choice that names neither is refused, a family that is not available falls back to the bundled one for every role together and says so, the choice is previewed, kept, cancelled, reset and read back at start without a write unless it is kept (and a failed write changes nothing), a saved value that names no choice is not loaded and not overwritten, an appearance file's font resolves through the same choices, and each renderer (the DOM stylesheet, Chart.js, the canvas map, the Pixi sky, the Galaxy Map's graph, its borders and PNG, the research graph) takes its family and size from the roles and waits for the faces before it measures. Each of the planted faults has to fail at least one check.

  What a browser shows (the computed face and size of real elements, the canvas text, the loaded faces) is probed separately with Playwright; the run is recorded in docs/plans/backlog/evidence/AE-016-01.md.

  Run: node scripts/check-fonts.js
*/
const fs = require('fs')
const os = require('os')
const path = require('path')

const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

let instance = 0

const load = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(['appearance-font', 'appearance', 'appearance-file'], { directory, stubs: { vue: `export default { observable: (value) => value, set: (target, key, value) => { target[key] = value } }\n// instance ${instance++}` } })

  return { font: loaded['appearance-font'], appearance: loaded.appearance, file: loaded['appearance-file'] }
}

const fakeConfig = (initial = {}) => ({
  data: { ...initial },
  writes: [],
  failNext: false,
  fail() {
    if (this.failNext) {
      this.failNext = false
      throw new Error('the disk is full')
    }
  },
  get store() {
    return this.data
  },
  update(change) {
    this.store = change(JSON.parse(JSON.stringify(this.data)))
  },
  set store(value) {
    this.writes.push({ via: 'store', keys: Object.keys(value) })
    this.fail()
    this.data = JSON.parse(JSON.stringify(value))
  },
  get(key) {
    return this.data[key]
  },
  set(key, value) {
    this.writes.push({ via: 'set', keys: [key] })
    this.fail()
    this.data = { ...this.data, [key]: JSON.parse(JSON.stringify(value)) }
  },
  delete(key) {
    this.writes.push({ via: 'delete', keys: [key] })
    this.fail()

    const rest = { ...this.data }

    delete rest[key]
    this.data = rest
  },
})

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// What a source file says, with a planted fault applied when the run is of a mutant: `patch` is { [relative path]: [from, to] }, and `directory` the copy of the utilities folder a fault in a utility was planted in.
const source = (relative, { patch = {}, directory } = {}) => {
  const inUtilities = directory && relative.startsWith('src/renderer/utilities/')
  const text = fs.readFileSync(inUtilities ? path.join(directory, path.basename(relative)) : path.join(root, relative), 'utf8')

  if (!patch[relative]) {
    return text
  }

  const [from, to] = patch[relative]

  if (text.split(from).length !== 2) {
    throw new Error(`The mutation of ${relative} does not apply exactly once: ${from}`)
  }

  return text.replace(from, () => to)
}

const code = (text) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line)).join('\n')

const RENDERERS = ['src/renderer/components/charts/ChartCanvas.vue', 'src/renderer/components/exploration/SystemMap.vue', 'src/renderer/components/SystemView.vue', 'src/renderer/pages/map.vue', 'src/renderer/components/research/PathView.vue', 'src/renderer/utilities/map-borders.js']

const CHECKS = [
  ['the families offered are a bounded list: each is named, has a family list of names only and a licence, a bundled one has a face, and Roboto is the bundled fallback', async (ctx) => {
    const { FONT_FAMILIES, FALLBACK } = ctx.font
    const ids = FONT_FAMILIES.map((family) => family.id)
    const problems = []

    if (new Set(ids).size !== ids.length || ids.length < 3 || ids.length > 8) {
      problems.push(`the ids: ${ids.join()}`)
    }

    FONT_FAMILIES.forEach((family) => {
      const lists = [family.stack, family.numeric]

      if (!family.name || !family.licence || !family.origin || !family.sample || !['bundled', 'system'].includes(family.source)) {
        problems.push(`${family.id}: incomplete`)
      }

      if (lists.some((list) => /[;{}\\]|url\(|@import|expression/i.test(list) || list.length > 200)) {
        problems.push(`${family.id}: a family list that is not only names`)
      }

      if (family.source === 'bundled' && (!family.face || family.licence !== 'Apache License 2.0')) {
        problems.push(`${family.id}: a bundled face needs its declared name and a recorded licence`)
      }

      if (family.source === 'system' && family.licence !== 'Not bundled') {
        problems.push(`${family.id}: a system face is named and not shipped`)
      }
    })

    const fallback = FONT_FAMILIES.find((family) => family.id === FALLBACK)

    if (!fallback || fallback.source !== 'bundled') {
      problems.push('the fallback is not a bundled face')
    }

    return problems.length ? problems.join('; ') : true
  }],

  ['each bundled face is declared by the package that ships it, in the weights the app loads, under the licence the app credits', async (ctx) => {
    const { FONT_FAMILIES } = ctx.font
    const base = path.join(root, 'node_modules', 'roboto-fontface')
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
    const licence = fs.readFileSync(path.join(base, 'LICENSE'), 'utf8')
    const sheets = { Roboto: 'css/roboto/roboto-fontface.css', 'Roboto-Condensed': 'css/roboto-condensed/roboto-condensed-fontface.css' }
    const problems = []

    if (manifest.license !== 'Apache-2.0' || !/Apache License\s+Version 2\.0/.test(licence)) {
      problems.push('the package is not Apache-2.0')
    }

    FONT_FAMILIES.filter((family) => family.source === 'bundled').forEach((family) => {
      const sheet = sheets[family.face] && fs.readFileSync(path.join(base, sheets[family.face]), 'utf8')

      if (!sheet || !new RegExp(`font-family:\\s*["']${family.face}["']`).test(sheet)) {
        problems.push(`${family.name}: no declaration of the face ${family.face}`)
        return
      }

      // Roboto Condensed has no 500; a request for it is met by its 400, the face medium text is drawn in there.
      ;(family.face === 'Roboto' ? [400, 500, 700] : [400, 700]).forEach((weight) => {
        if (!new RegExp(`font-family:\\s*["']${family.face}["'];[^}]*font-weight:\\s*${weight};[^}]*font-style:\\s*normal`).test(sheet)) {
          problems.push(`${family.name}: no normal face at ${weight}`)
        }
      })

      const files = [...sheet.matchAll(/url\(["']\.\.\/\.\.\/(fonts\/[^"']+\.woff2)["']\)/g)].map((match) => match[1])

      if (!files.length || files.some((file) => !fs.existsSync(path.join(base, file)))) {
        problems.push(`${family.name}: a declared file is missing`)
      }
    })

    const plugin = fs.readFileSync(path.join(root, 'src/renderer/plugins/vuetify.js'), 'utf8')
    const credits = fs.readFileSync(path.join(root, 'src/renderer/utilities/credits.js'), 'utf8')

    if (!plugin.includes('roboto-fontface/css/roboto/roboto-fontface.css') || !plugin.includes('roboto-fontface/css/roboto-condensed/roboto-condensed-fontface.css')) {
      problems.push('the plugin does not import both bundled faces')
    }

    if (!/Roboto Condensed/.test(credits) || !/Apache License 2\.0/.test(credits)) {
      problems.push('About does not credit Roboto Condensed under its licence')
    }

    return problems.length ? problems.join('; ') : true
  }],

  ['the text sizes are a short ascending list that holds 100 % and stays between 90 % and 125 %', async (ctx) => {
    const { FONT_SCALES, DEFAULT_FONT } = ctx.font

    return FONT_SCALES.length >= 3 && FONT_SCALES.length <= 6 && FONT_SCALES.every((scale, index) => index === 0 || scale > FONT_SCALES[index - 1]) && FONT_SCALES.includes(1) && DEFAULT_FONT.scale === 1 && FONT_SCALES[0] >= 0.9 && FONT_SCALES[FONT_SCALES.length - 1] <= 1.25 ? true : `the sizes: ${short(FONT_SCALES)}`
  }],

  ['a record is read only when it names a family and a text size of the lists', async (ctx) => {
    const { readFont } = ctx.font
    const refused = [null, 'roboto', [], {}, { family: 'roboto' }, { scale: 1 }, { family: 'comic', scale: 1 }, { family: 'roboto', scale: 3 }, { family: 'roboto', scale: '1' }, { family: 'Roboto; src: url(x)', scale: 1 }, { family: 'roboto', scale: 0 }].filter((value) => readFont(value).ok)
    const ok = readFont({ family: 'verdana', scale: 1.1, extra: 1 })

    return refused.length === 0 && ok.ok && short(ok.font) === short({ family: 'verdana', scale: 1.1 }) ? true : `accepted ${short(refused)}; read ${short(ok)}`
  }],

  ['a family that is not available gives way to Roboto for every role together, and the effective choice is explained', async (ctx) => {
    const { resolveFont, FONT_FAMILIES, familyOf } = ctx.font
    const roboto = familyOf('roboto')
    const roles = ['body', 'numeric', 'chart', 'map', 'svg']
    const problems = []

    FONT_FAMILIES.forEach((family) => {
      const all = resolveFont({ family: family.id, scale: 1 }, () => true)
      const none = resolveFont({ family: family.id, scale: 1 }, (id) => id === 'roboto')
      const unknown = resolveFont({ family: family.id, scale: 1 }, () => null)

      if (all.family !== family.id || all.fellBack || roles.some((role) => !all[role]) || all.body !== family.stack || all.chart !== all.body || all.map !== all.body || all.svg !== all.body || all.numeric !== family.numeric || !all.explanation) {
        problems.push(`${family.id}: available`)
      }

      if (unknown.fellBack || unknown.family !== family.id) {
        problems.push(`${family.id}: a family not looked up yet is taken as available`)
      }

      if (family.id === 'roboto') {
        if (none.fellBack || none.family !== 'roboto') {
          problems.push('roboto: the fallback gives way to itself')
        }

        return
      }

      const hidden = resolveFont({ family: family.id, scale: 1 }, (id) => id !== family.id)

      if (!hidden.fellBack || hidden.family !== 'roboto' || hidden.requested !== family.id || roles.slice(0, 1).concat(roles.slice(2)).some((role) => hidden[role] !== roboto.stack) || hidden.numeric !== roboto.numeric || !hidden.explanation.includes(family.name) || !/not (loaded|installed)/.test(hidden.explanation) || !hidden.explanation.includes('Roboto')) {
        problems.push(`${family.id}: missing -> ${short(hidden)}`)
      }
    })

    const unknownId = resolveFont({ family: 'comic-sans', scale: 1 })

    if (unknownId.family !== 'roboto') {
      problems.push('an unknown id is not Roboto')
    }

    return problems.length ? problems.join('; ') : true
  }],

  ['the text size scales every size a renderer asks for, 100 % leaving it as it is', async (ctx) => {
    const { resolveFont, FONT_SCALES } = ctx.font
    const wrong = FONT_SCALES.filter((scale) => {
      const { size } = resolveFont({ family: 'roboto', scale })

      return size(12) !== Math.round(12 * scale * 100) / 100 || size(0) !== 0 || (scale === 1 && size(11) !== 11)
    })

    return wrong.length ? `sizes that do not scale: ${wrong.join()}` : true
  }],

  ['a choice is previewed, kept with one write, cancelled, reset and read back at start; the default is kept by removing the record', async (ctx) => {
    const { font } = ctx
    const config = fakeConfig()

    font.loadFont(config)

    if (JSON.stringify(font.fontInForce()) !== JSON.stringify({ family: 'roboto', scale: 1 }) || font.isFontPreviewing() || font.fontProblem() !== null || config.writes.length) {
      return `the start: ${short(font.fontInForce())}, ${config.writes.length} writes`
    }

    font.previewFont({ family: 'verdana', scale: 1.25 })
    font.previewFont({ family: 'nope', scale: 7 })

    if (font.fontInForce().family !== 'verdana' || font.fontInForce().scale !== 1.25 || !font.isFontPreviewing() || config.writes.length || font.appliedFont().family !== 'roboto') {
      return `the preview: ${short(font.fontInForce())}, ${config.writes.length} writes, applied ${short(font.appliedFont())}`
    }

    font.cancelFontPreview()

    if (font.isFontPreviewing() || font.fontInForce().family !== 'roboto' || config.writes.length) {
      return 'a cancel did not return to the applied choice'
    }

    font.previewFont({ family: 'roboto-condensed', scale: 1.1 })
    config.failNext = true

    try {
      font.applyFont(config)
      return 'a failed write did not throw'
    } catch {
      if (font.appliedFont().family !== 'roboto' || font.appliedFont().scale !== 1 || !font.isFontPreviewing() || config.data.appearanceFont !== undefined) {
        return `a failed write changed the applied choice: ${short(font.appliedFont())}`
      }
    }

    font.applyFont(config)

    if (JSON.stringify(config.data.appearanceFont) !== JSON.stringify({ family: 'roboto-condensed', scale: 1.1 }) || font.isFontPreviewing() || config.writes.length !== 2 || font.appliedFont().family !== 'roboto-condensed') {
      return `the kept choice: ${short(config.data)}, ${config.writes.length} writes`
    }

    const restart = await load(ctx.directory)

    restart.font.loadFont(config)

    if (JSON.stringify(restart.font.fontInForce()) !== JSON.stringify({ family: 'roboto-condensed', scale: 1.1 }) || JSON.stringify(restart.font.appliedFont()) !== JSON.stringify({ family: 'roboto-condensed', scale: 1.1 })) {
      return `a start with the choice kept: ${short(restart.font.fontInForce())}`
    }

    restart.appearance.loadAppearance(fakeConfig({ appearanceFont: { family: 'verdana', scale: 0.9 } }))

    if (restart.font.fontInForce().family !== 'verdana') {
      return 'loadAppearance does not read the typeface'
    }

    config.failNext = true

    try {
      font.resetFont(config)
      return 'a failed reset did not throw'
    } catch {
      if (font.fontInForce().family !== 'roboto-condensed' || font.fontInForce().scale !== 1.1 || font.appliedFont().family !== 'roboto-condensed' || JSON.stringify(config.data.appearanceFont) !== JSON.stringify({ family: 'roboto-condensed', scale: 1.1 })) {
        return `a failed reset changed the choice: in force ${short(font.fontInForce())}, applied ${short(font.appliedFont())}, kept ${short(config.data.appearanceFont)}`
      }
    }

    font.resetFont(config)

    if (config.data.appearanceFont !== undefined || font.fontInForce().family !== 'roboto' || font.fontInForce().scale !== 1 || font.isFontPreviewing()) {
      return `a reset: ${short(config.data)}`
    }

    font.previewFont({ family: 'roboto', scale: 1 })
    font.applyFont(config)

    return config.data.appearanceFont === undefined ? true : 'the default is kept as a record'
  }],

  ['a saved value that names no choice is not loaded, leaves the default in force, is reported and is not overwritten until a choice is applied', async (ctx) => {
    const { font } = ctx
    const bad = { family: 'comic-sans', scale: 1 }
    const config = fakeConfig({ appearanceFont: bad, other: 1 })

    font.loadFont(config)

    if (font.fontInForce().family !== 'roboto' || font.fontInForce().scale !== 1 || !/comic-sans/.test(font.fontProblem() || '') || JSON.stringify(config.data.appearanceFont) !== JSON.stringify(bad) || config.writes.length) {
      return `an unusable record: ${short(font.fontInForce())}, ${short(font.fontProblem())}, ${config.writes.length} writes`
    }

    font.previewFont({ scale: 1.1 })
    font.applyFont(config)

    return font.fontProblem() === null && JSON.stringify(config.data.appearanceFont) === JSON.stringify({ family: 'roboto', scale: 1.1 }) ? true : `the record after Apply: ${short(config.data.appearanceFont)}`
  }],

  ['an appearance file names a typeface through the same choices, a file never changes the typeface, and an export carries the typeface in force', async (ctx) => {
    const { font, appearance, file } = ctx
    const text = (family) => JSON.stringify(file.buildAppearanceFile(appearance.resolveAppearance('dark'), { now: 0, typeface: family }))
    const named = ['Roboto Condensed', 'roboto condensed', 'roboto-condensed', 'Verdana', 'System UI', 'MONOSPACE']
    const resolved = named.map((family) => font.familyByName(family) && font.familyByName(family).id)

    if (resolved.join() !== 'roboto-condensed,roboto-condensed,roboto-condensed,verdana,system,monospace' || font.familyByName('Comic Sans MS') !== null || font.familyByName('') !== null) {
      return `names: ${resolved.join()}`
    }

    const config = fakeConfig()

    font.loadFont(config)
    appearance.loadAppearance(config)

    const read = appearance.importAppearanceFile(text('Verdana'))

    if (!read.ok || read.entry.appearance.file.font.choice !== 'verdana' || !read.entry.appearance.file.font.supported || font.fontInForce().family !== 'roboto') {
      return `a file naming Verdana: ${short(read.ok ? read.entry.appearance.file.font : read.errors)}`
    }

    appearance.cancelPreview()
    font.previewFont({ family: 'roboto-condensed' })
    font.applyFont(config)

    const exported = appearance.exportAppearanceFile('dark', 0)

    if (exported.font.family !== 'Roboto Condensed') {
      return `an export under the applied typeface: ${short(exported.font)}`
    }

    const own = appearance.importAppearanceFile(text('Verdana'))

    appearance.applyPreset(config, 'custom-draft')

    const kept = appearance.exportAppearanceFile('custom', 0)

    return own.ok && kept.font.family === 'Verdana' ? true : `an imported file's own font on export: ${short(kept && kept.font)}`
  }],

  ['no renderer writes a family of its own', async (ctx) => {
    const problems = []
    const sources = Object.fromEntries(RENDERERS.map((file) => [file, source(file, ctx)]))

    RENDERERS.forEach((file) => {
      const hard = code(sources[file]).match(/\b(Roboto|Helvetica|Arial|sans-serif|monospace)\b/)

      if (hard) {
        problems.push(`${path.basename(file)} names ${hard[0]}`)
      }
    })

    return problems.length ? problems.join('; ') : true
  }],

  ['the root carries the typeface, the numeric family and the text size', async (ctx) => {
    const { font } = ctx
    const problems = []

    const style = font.fontStyle(font.fontRoles({ family: 'roboto-condensed', scale: 1.25 }))

    if (style['--ae-font'] !== font.familyOf('roboto-condensed').stack || style['--ae-font-scale'] !== '1.25' || style['font-size'] !== '20px' || style['--ae-mono'] !== font.familyOf('roboto-condensed').numeric) {
      problems.push(`the root properties: ${short(style)}`)
    }

    return problems.length ? problems.join('; ') : true
  }],

  ['every text size of the stylesheets follows the text size: none is a fixed number of pixels', async (ctx) => {
    const base = path.join(root, 'src', 'renderer')
    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))
    const files = walk(base).map((file) => path.relative(base, file).replace(/\\/g, '/')).filter((file) => /\.(vue|scss|css)$/.test(file))
    const fixed = (file) => code(source(`src/renderer/${file}`, ctx)).split('\n').filter((line) => /font-size:\s*[\d.]+px/.test(line))
    const problems = []

    files.forEach((file) => {
      const lines = fixed(file)

      if (lines.length) {
        problems.push(`${file}: ${lines[0].trim()}`)
      }
    })

    return problems.length ? problems.slice(0, 6).join('; ') + (problems.length > 6 ? `; and ${problems.length - 6} more` : '') : true
  }],

  ['the preferences carry the typeface and text size: exported, checked by the same read as the saved record and imported', async (ctx) => {
    const loaded = await loadUtilities(['appearance-font', 'preferences'], { directory: ctx.directory || utilitiesDirectory, stubs: { vue: `export default { observable: (value) => value, set: (target, key, value) => { target[key] = value } }\n// instance ${instance++}` } })
    const { readFont, FONT_KEY } = loaded['appearance-font']
    const { buildSchema, buildExport, parseBundle } = loaded.preferences
    const schema = buildSchema({ declarations: [], appearance: { key: 'appearance', ids: ['light', 'dark'] }, font: { key: FONT_KEY, read: readFont }, separators: [','] })
    const record = { family: 'verdana', scale: 1.25 }
    const problems = []
    const exported = buildExport(schema, { appearance: 'dark', [FONT_KEY]: record }, { raceId: null }, ['appearance'])

    if (JSON.stringify(((exported.bundle.categories.appearance || {}).app || {})[FONT_KEY]) !== JSON.stringify(record) || !exported.keys.includes(FONT_KEY) || exported.skipped.length) {
      problems.push(`the export: ${short(exported.bundle.categories)}, skipped ${short(exported.skipped)}`)
    }

    const parsed = parseBundle(JSON.stringify(exported.bundle), schema)

    if ((parsed.errors || []).length || !parsed.entries.some((entry) => entry.key === FONT_KEY && JSON.stringify(entry.value) === JSON.stringify(record))) {
      problems.push(`the import: ${short(parsed.errors)}`)
    }

    const damaged = (value) => parseBundle(JSON.stringify({ format: 'aurora-electrons-preferences', version: 1, categories: { appearance: { app: { [FONT_KEY]: value } } } }), schema)

    const refused = (value) => (damaged(value).errors || []).length > 0

    if (!refused({ family: 'comic-sans', scale: 1 }) || !refused({ family: 'verdana', scale: 7 }) || !refused('verdana') || refused({ family: 'roboto', scale: 1 })) {
      problems.push('a value that is no choice is imported, or a choice is refused')
    }

    if (buildExport(schema, { [FONT_KEY]: { family: 'comic-sans', scale: 1 } }, { raceId: null }, ['appearance']).skipped.length !== 1) {
      problems.push('a stored record that names no choice is exported')
    }

    return problems.length ? problems.join('; ') : true
  }],
]

const FONT = 'appearance-font.js'

// A fault in the utilities (`FONT`, or the borders file) is planted in a copy of the folder; a fault in a renderer's source is planted in what the check reads.
const MUTATIONS = [
  ['a family that is not there kept instead of falling back', { file: FONT, from: 'const fellBack = requested.id !== FALLBACK && isAvailable(requested.id) === false', to: 'const fellBack = false' }],
  ['a fallback that is not Roboto', { file: FONT, from: 'const effective = fellBack ? familyOf(FALLBACK) : requested', to: "const effective = fellBack ? familyOf('system') : requested" }],
  ['the chart role left on the requested family', { file: FONT, from: 'body: effective.stack, numeric: effective.numeric, chart: effective.stack, map: effective.stack, svg: effective.stack', to: 'body: effective.stack, numeric: effective.numeric, chart: requested.stack, map: effective.stack, svg: effective.stack' }],
  ['a size that is not scaled', { file: FONT, from: 'const scaled = (px) => Math.round(px * scale * 100) / 100', to: 'const scaled = (px) => px' }],
  ['the sizes not bounded', { file: FONT, from: 'export const FONT_SCALES = Object.freeze([0.9, 1, 1.1, 1.25])', to: 'export const FONT_SCALES = Object.freeze([0.5, 1, 1.1, 1.25, 3])' }],
  ['any size accepted from a record', { file: FONT, from: 'if (!FONT_SCALES.includes(value.scale)) {', to: 'if (false) {' }],
  ['any family accepted from a record', { file: FONT, from: 'if (!familyOf(value.family)) {', to: 'if (false) {' }],
  ['a preview that accepts a value that is no choice', { file: FONT, from: "if (hasOwn(patch, 'scale') && FONT_SCALES.includes(patch.scale)) {", to: "if (hasOwn(patch, 'scale')) {" }],
  ['the applied choice changed before the write', { file: FONT, from: 'const keep = (config, { family, scale }) => {\n  if (family === DEFAULT_FONT.family', to: 'const keep = (config, { family, scale }) => {\n  state.appliedFamily = family\n  state.appliedScale = scale\n\n  if (family === DEFAULT_FONT.family' }],
  ['a reset that changes the choice in force before its write', { file: FONT, from: 'export const resetFont = (config) => keep(config, DEFAULT_FONT)', to: 'export const resetFont = (config) => {\n  state.family = DEFAULT_FONT.family\n  state.scale = DEFAULT_FONT.scale\n  keep(config, DEFAULT_FONT)\n}' }],
  ['the default kept as a record', { file: FONT, from: '    config.delete(FONT_KEY)\n  } else {', to: '    config.set(FONT_KEY, { family, scale })\n  } else {' }],
  ['a cancel that keeps the preview', { file: FONT, from: '  state.family = state.appliedFamily\n  state.scale = state.appliedScale\n  syncRoot()\n}', to: '  syncRoot()\n}' }],
  ['a reset that does not return to the default', { file: FONT, from: 'export const resetFont = (config) => keep(config, DEFAULT_FONT)', to: 'export const resetFont = (config) => applyFont(config)' }],
  ['the saved choice not read at start', { file: FONT, from: '  state.family = font.family\n  state.scale = font.scale\n  state.appliedFamily = font.family', to: '  state.appliedFamily = font.family' }],
  ['an unusable record replaced without a word', { file: FONT, from: 'state.problem = read.ok ? null : read.problem\n  probeSystemFaces()', to: 'state.problem = null\n  probeSystemFaces()' }],
  ['a loaded typeface that never reaches the settings read at start', { file: 'appearance.js', from: 'export const loadAppearance = (config) => {\n  loadFont(config)\n', to: 'export const loadAppearance = (config) => {\n' }],
  // eslint-disable-next-line no-template-curly-in-string
  ['the root properties without the text size', { file: FONT, from: "'--ae-font-scale': String(roles.scale), 'font-size': `${16 * roles.scale}px`", to: "'--ae-font-scale': '1', 'font-size': '16px'" }],
  ['a file naming a typeface by its display name not resolved', { file: FONT, from: 'family.id === wanted || family.name.toLowerCase() === wanted', to: 'family.id === wanted' }],
  ['an export that ignores the typeface in force', { file: 'appearance.js', from: 'typeface: familyOf(appliedFont().family).name })', to: '})' }],
  ['the borders\' own font', { file: 'map-borders.js', from: 'context.font = type.font(NAME_SIZE)', to: "context.font = '14px Roboto, sans-serif'" }],
  ['a family written in the chart', { patch: { 'src/renderer/components/charts/ChartCanvas.vue': ['const text = { family, size: size(12) }', "const text = { family: 'Roboto, sans-serif', size: size(12) }"] } }],
  ['the canvas map\'s own label font', { patch: { 'src/renderer/components/exploration/SystemMap.vue': ['return this.typeface.font(LABEL_SIZE)', "return '11px Roboto, sans-serif'"] } }],
  ['the Pixi sky\'s own family', { patch: { 'src/renderer/components/SystemView.vue': ['fontFamily: type.family,\n    fontSize: type.size(12),', "fontFamily: 'Arial',\n    fontSize: type.size(12),"] } }],
  ['the Galaxy Map\'s own graph font', { patch: { 'src/renderer/pages/map.vue': ["'font-family': this.typeface.family,", "'font-family': 'Roboto, sans-serif',"] } }],
  ['the Galaxy Map\'s glyph text in a family of its own', { patch: { 'src/renderer/pages/map.vue': ['family: this.roles.svg, scale: this.roles.scale', "family: 'Arial', scale: this.roles.scale"] } }],
  ['the research graph\'s own family', { patch: { 'src/renderer/components/research/PathView.vue': ["'font-family': this.typeface.family,", "'font-family': 'Roboto, sans-serif',"] } }],
  ['the typeface left out of the preferences', { file: 'preferences.js', from: "  add('appearance', 'app', font.key, (value) => {\n    const read = font.read(value)\n\n    return read.ok ? { ok: true, value: read.font } : { ok: false, reason: 'is not a typeface and text size this version offers' }\n  })\n", to: '' }],
  ['any typeface record imported', { file: 'preferences.js', from: "return read.ok ? { ok: true, value: read.font } : { ok: false, reason: 'is not a typeface and text size this version offers' }", to: 'return { ok: true, value }' }],
  ['a fixed pixel text size in the layout', { patch: { 'src/renderer/layouts/default.vue': ['.rail__label {\n  font-size: calc(11px * var(--ae-font-scale));', '.rail__label {\n  font-size: 11px;'] } }],
]

const mutatedCopy = ({ file, from, to }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fonts-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const text = fs.readFileSync(target, 'utf8')

  if (text.split(from).length !== 2) {
    throw new Error(`The mutation of ${file} does not apply exactly once: ${from}`)
  }

  fs.writeFileSync(target, text.replace(from, () => to))

  return directory
}

const runChecks = async ({ directory, patch = {} } = {}) => {
  const results = []

  for (const [name, check] of CHECKS) {
    const ctx = { ...(await load(directory)), patch, directory }

    try {
      results.push([name, await check(ctx)])
    } catch (error) {
      results.push([name, `threw: ${error.message}`])
    }
  }

  return results
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

  console.log('Typeface and text size')

  for (const [name, result] of await runChecks()) {
    tally(result === true)
    console.log(`${result === true ? 'PASS' : 'FAIL'}  ${name}${result === true ? '' : `  [${typeof result === 'string' ? result : 'false'}]`}`)
  }

  console.log('\nMutations: each must fail at least one check')

  for (const [label, fault] of MUTATIONS) {
    let directory

    try {
      directory = fault.file ? mutatedCopy(fault) : undefined

      const failed = (await runChecks({ directory, patch: fault.patch })).filter(([, result]) => result !== true)

      tally(failed.length > 0)
      console.log(`${failed.length ? 'PASS' : 'FAIL'}  mutation caught: ${label}  [${failed.length ? `${failed.length} checks fail` : 'every check still passes'}]`)
    } catch (error) {
      tally(false)
      console.log(`FAIL  mutation caught: ${label}  [${error.message}]`)
    } finally {
      if (directory) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
