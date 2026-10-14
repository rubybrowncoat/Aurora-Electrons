#!/usr/bin/env node
/*
  The section accents (src/renderer/utilities/appearance.js: `sections.accents`, `accentMode`, `applyAccents`; appearance-contrast.js: `sectionAccents`, `sectionColor`; navigation.js: the `accent` of each section), checked without a browser.

  It proves: the nine sections stay told apart by title, icon and position, and by an accent index of their own; the accent of a section comes from `sections.accents`, never from the chart palette, so a change of the chart colours leaves the sections as they are; the three modes (on, restrained, off) give the colours they say and the off mode leaves a neutral one; the mode is kept, adopted, imported, exported and kept by a reset like the other appearance settings; an appearance file carries the accents, refuses a list that repeats a colour, and takes the base's when it has none; the contrast gate measures every accent of every mode as a graphic (3:1) and the text colour of each as text (4.5:1) on every surface text sits on, so that a mix of two accents that each read cannot slip below the text minimum. Selection and focus are kept apart from the section colour: the wash of the active section is stronger than the hover wash and no section colour is the focus colour.

  What a browser shows (the rail, the tabs, the breadcrumb and the Settings control drawn in each mode, under each preset and size) is probed separately with Playwright; the wiring of `components/navigation/section-style.js` is covered there only, as it imports components.

  Run: node scripts/check-section-accents.js
*/
const fs = require('fs')
const os = require('os')
const path = require('path')

const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

let instance = 0

const NAMES = ['appearance-font', 'appearance', 'appearance-file', 'appearance-contrast', 'preferences', 'remembered-views', 'navigation']

// A fresh copy of the modules, so the state of one check never reaches another; `directory` is a copy of the utilities folder with a planted fault.
const load = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(NAMES, { directory, stubs: { vue: `export default { observable: (value) => value, set: (target, key, value) => { target[key] = value } }\n// instance ${instance++}` } })

  return { font: loaded['appearance-font'], appearance: loaded.appearance, file: loaded['appearance-file'], contrast: loaded['appearance-contrast'], preferences: loaded.preferences, views: loaded['remembered-views'], navigation: loaded.navigation, reload: () => load(directory) }
}

const fakeConfig = (initial = {}) => ({
  data: JSON.parse(JSON.stringify(initial)),
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
    this.writes.push({ via: 'store', keys: Object.keys(value).sort() })
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

const canonical = (value) => JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner))

const expectEqual = (actual, wanted, label, problems) => {
  if (canonical(actual) !== canonical(wanted)) {
    problems.push(`${label}: ${short(actual)}, wanted ${short(wanted)}`)
  }
}

const verdict = (problems) => (problems.length ? problems.join('; ') : true)

const channels = (color) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16))

// Halfway between two #rrggbb colours, worked out here and not by the code under check; a rounding either way is allowed.
const halfway = (color, neutral) => channels(color).map((value, index) => (value + channels(neutral)[index]) / 2)

const near = (color, wanted) => channels(color).every((value, index) => Math.abs(value - wanted[index]) <= 1)

const bundleOf = (values) => JSON.stringify({ format: 'aurora-electrons-preferences', version: 1, categories: { appearance: { app: values } } })

const SOURCE = { raceId: null }
const TARGET = { gameId: null, raceId: null }

const presets = (ctx) => ctx.appearance.listAppearances()

// The overlay of a tab over its surface as Vuetify draws it, read from its own theme files: a hovered active tab takes `activated` and a focused one `pressed`.
const vuetifyStates = (mode) => {
  const text = fs.readFileSync(path.join(root, 'node_modules', 'vuetify', 'src', 'styles', 'settings', `_${mode}.scss`), 'utf8')
  const block = /'states': \(([^)]*)\)/.exec(text)[1]
  const value = (name) => Number(new RegExp(`'${name}': ([0-9.]+)`).exec(block)[1])

  return { activated: value('activated'), pressed: value('pressed') }
}

// The backgrounds a section's text can sit on, worked out here from the surfaces and Vuetify's own files, and not by the code under check: each of the page, the card and the chrome, plain, under the hover wash, under the overlay of a hovered and of a focused active tab in the text colour itself; the card under each wash of a table row.
const fixed = new WeakMap()

const backgroundsOf = (ctx, appearance, color) => {
  const { parseColor, over } = ctx.contrast

  if (!fixed.has(appearance)) {
    const card = parseColor(appearance.surfaces.card)
    const surfaces = ['background', 'card', 'chrome'].map((name) => parseColor(appearance.surfaces[name]))

    fixed.set(appearance, { states: vuetifyStates(appearance.mode), surfaces, plain: surfaces.flatMap((surface) => [surface, over(parseColor(appearance.focus.hover), surface)]), rows: ['focus.hover', 'rows.selected', 'rows.differs', 'rows.stripe', 'rows.stripeSoft'].map((path) => over(parseColor(path.split('.').reduce((value, key) => value[key], appearance)), card)) })
  }

  const { states, surfaces, plain, rows } = fixed.get(appearance)
  const text = parseColor(color)

  return [...plain, ...rows, ...surfaces.flatMap((surface) => [over({ ...text, a: states.activated }, surface), over({ ...text, a: states.pressed }, surface)])]
}

const readsAsText = (ctx, appearance, color) => {
  const text = ctx.contrast.parseColor(color)

  return backgroundsOf(ctx, appearance, color).every((background) => ctx.contrast.ratio(text, background) >= 4.5)
}

// The first mix of a colour with the body ink, in 1/256 steps, that reads as text; the colour itself when it does.
const firstReading = (ctx, appearance, color) => {
  const { parseColor, over, hex } = ctx.contrast

  if (readsAsText(ctx, appearance, color)) {
    return color
  }

  const ink = over(parseColor(appearance.inks.body), parseColor(appearance.surfaces.card))

  for (let step = 1; step <= 256; step++) {
    const candidate = hex(over({ ...ink, a: step / 256 }, parseColor(color)))

    if (readsAsText(ctx, appearance, candidate)) {
      return candidate
    }
  }

  return hex(ink)
}

// The schema the Settings page builds, with or without the accents.
const schemaOf = (ctx, accents = { key: ctx.appearance.ACCENTS_KEY, values: ctx.appearance.ACCENT_MODES }) => ctx.preferences.buildSchema({ declarations: [], appearance: { key: 'appearance', ids: [...presets(ctx).map(({ id }) => id), ctx.appearance.NO_OVERRIDE], none: ctx.appearance.NO_OVERRIDE, baselines: ctx.appearance.BASELINE_POLICIES }, policy: { key: ctx.appearance.POLICY_KEY, values: ctx.appearance.POLICIES }, accents, font: { key: ctx.font.FONT_KEY, read: ctx.font.readFont }, separators: [','] })

const parseFile = (ctx, value) => ctx.file.parseAppearanceFile(typeof value === 'string' ? value : JSON.stringify(value), { builtIn: (id) => (Object.prototype.hasOwnProperty.call(ctx.appearance.PRESETS, id) ? ctx.appearance.resolveAppearance(id) : null), baselines: { light: 'light', dark: 'dark' } })

const CHECKS = [
  ['the nine sections have a title, an icon, a position and an accent index of their own, and every page belongs to one', async (ctx) => {
    const problems = []
    const { SECTIONS, PAGES } = ctx.navigation

    expectEqual(SECTIONS.length, 9, 'the sections', problems)

    ;['id', 'title', 'icon'].forEach((field) => {
      expectEqual(new Set(SECTIONS.map((section) => section[field])).size, SECTIONS.length, `distinct ${field}s`, problems)
    })
    expectEqual(SECTIONS.map(({ accent }) => accent).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'the accent indexes', problems)

    PAGES.forEach((page) => {
      if (page.section !== null && !SECTIONS.some((section) => section.id === page.section)) {
        problems.push(`the page ${page.route} names the section ${page.section}, which is none`)
      }
    })
    SECTIONS.forEach((section) => {
      if (!PAGES.some((page) => page.section === section.id && !page.hidden)) {
        problems.push(`the section ${section.id} has no page in the navigation`)
      }
    })

    presets(ctx).forEach((appearance) => {
      const { accents, neutral } = appearance.sections

      expectEqual([accents.length, new Set(accents.map((color) => color.toLowerCase())).size], [9, 9], `${appearance.id}: the accents and their distinct colours`, problems)

      if (!/^#[0-9a-f]{6}$/i.test(neutral)) {
        problems.push(`${appearance.id}: the neutral accent ${neutral} is no hex colour`)
      }
    })

    return verdict(problems)
  }],

  ['the on mode draws each section in its own accent, the restrained mode halfway to the neutral accent, the off mode in the neutral accent alone, and a place without a section in the neutral accent', async (ctx) => {
    const problems = []
    const { sectionAccents, sectionColor, ACCENT_MODES, DEFAULT_ACCENT_MODE } = ctx.contrast
    const { SECTIONS } = ctx.navigation

    expectEqual(ACCENT_MODES, ['on', 'restrained', 'off'], 'the modes', problems)
    expectEqual(DEFAULT_ACCENT_MODE, 'on', 'the default mode', problems)

    presets(ctx).forEach((appearance) => {
      const { accents, neutral } = appearance.sections

      expectEqual(sectionAccents(appearance, 'on'), accents, `${appearance.id}: on`, problems)
      expectEqual(sectionAccents(appearance), accents, `${appearance.id}: the default mode`, problems)
      expectEqual(sectionAccents(appearance, 'off'), accents.map(() => neutral), `${appearance.id}: off`, problems)

      const softened = sectionAccents(appearance, 'restrained')

      accents.forEach((color, index) => {
        if (!near(softened[index], halfway(color, neutral))) {
          problems.push(`${appearance.id}: restrained accent ${index} is ${softened[index]}, wanted halfway from ${color} to ${neutral}`)
        }
      })

      if (canonical(softened) === canonical(accents) || canonical(softened) === canonical(sectionAccents(appearance, 'off'))) {
        problems.push(`${appearance.id}: restrained is the same as on or off`)
      }

      if (new Set(softened.map((color) => color.toLowerCase())).size !== 9) {
        problems.push(`${appearance.id}: restrained leaves fewer than nine distinct colours`)
      }

      SECTIONS.forEach((section) => {
        ACCENT_MODES.forEach((mode) => {
          expectEqual(sectionColor(appearance, section, mode), sectionAccents(appearance, mode)[section.accent], `${appearance.id}: ${section.id} in ${mode}`, problems)
        })
      })

      expectEqual(sectionColor(appearance, null, 'on'), neutral, `${appearance.id}: no section in on`, problems)
      expectEqual(sectionColor(appearance, null, 'off'), neutral, `${appearance.id}: no section in off`, problems)
    })

    return verdict(problems)
  }],

  ['with the accents off the nine sections are still told apart by title, icon and position, which no mode touches', async (ctx) => {
    const problems = []
    const { SECTIONS } = ctx.navigation
    const before = SECTIONS.map(({ id, title, icon }) => [id, title, icon])

    presets(ctx).forEach((appearance) => {
      ctx.contrast.ACCENT_MODES.forEach((mode) => {
        const colors = SECTIONS.map((section) => ctx.contrast.sectionColor(appearance, section, mode))

        if (mode === 'off' && new Set(colors).size !== 1) {
          problems.push(`${appearance.id}: off gives ${new Set(colors).size} colours, wanted one`)
        }
      })
    })

    expectEqual(SECTIONS.map(({ id, title, icon }) => [id, title, icon]), before, 'the registry after the modes were drawn', problems)
    expectEqual(SECTIONS.map(({ id }) => id), ['command', 'economy', 'colonies', 'logistics', 'galaxy', 'exploration', 'empire', 'research', 'design'], 'the order of the sections', problems)
    expectEqual(new Set(SECTIONS.map((section) => `${section.title}|${section.icon}`)).size, 9, 'the pairs of title and icon', problems)

    return verdict(problems)
  }],

  ['the chart palette does not colour a section: other categorical colours leave every section colour as it was, other accents change them, and the two are never the one list', async (ctx) => {
    const problems = []
    const { SECTIONS } = ctx.navigation
    const { PRESETS, resolveAppearance } = ctx.appearance
    const ownAccents = [...PRESETS.solaris.sections.accents]

    // The built-in preset is changed before it is first resolved: its section accents are its own, not a copy of the chart colours it holds.
    PRESETS.solaris.charts.categorical.reverse()
    expectEqual(resolveAppearance('solaris').sections.accents, ownAccents, 'solaris after its chart colours were reversed', problems)

    presets(ctx).forEach((appearance) => {
      const other = { ...appearance, charts: { ...appearance.charts, categorical: [...appearance.charts.categorical].reverse().map((_color, index) => `#0${index}0${index}0${index}`) } }
      const moved = { ...appearance, sections: { ...appearance.sections, accents: [...appearance.sections.accents].reverse() } }

      ctx.contrast.ACCENT_MODES.forEach((mode) => {
        const wanted = SECTIONS.map((section) => ctx.contrast.sectionColor(appearance, section, mode))

        expectEqual(SECTIONS.map((section) => ctx.contrast.sectionColor(other, section, mode)), wanted, `${appearance.id}: ${mode} after other chart colours`, problems)

        if (mode !== 'off' && canonical(SECTIONS.map((section) => ctx.contrast.sectionColor(moved, section, mode))) === canonical(wanted)) {
          problems.push(`${appearance.id}: ${mode} did not follow other accents`)
        }
      })

      if (appearance.sections.accents === appearance.charts.categorical) {
        problems.push(`${appearance.id}: the accents are the list of the chart colours`)
      }
    })

    return verdict(problems)
  }],

  ['a file that changes only the chart colours keeps the accents of its base, and one that changes the accents keeps the chart colours', async (ctx) => {
    const problems = []
    const base = ctx.appearance.resolveAppearance('solaris')
    const exported = ctx.appearance.exportAppearanceFile('solaris', 1000)

    exported.roles.charts.categorical = [...exported.roles.charts.categorical].reverse()
    delete exported.roles.sections

    const charted = parseFile(ctx, exported)

    expectEqual(charted.ok, true, 'a file without accents is read', problems)

    if (charted.ok) {
      expectEqual(charted.roles.sections.accents, base.sections.accents, 'the accents of a file without any', problems)
      expectEqual(charted.roles.sections.neutral, base.sections.neutral, 'the neutral accent of a file without any', problems)
      expectEqual(charted.roles.charts.categorical, [...base.charts.categorical].reverse(), 'the chart colours of the file', problems)
      expectEqual(charted.defaults.filter(({ path }) => path.startsWith('sections.')).map(({ path }) => path).sort(), ['sections.accents', 'sections.neutral'], 'the roles taken from the base', problems)
    }

    const accented = ctx.appearance.exportAppearanceFile('solaris', 1000)

    accented.roles.sections.accents = [...accented.roles.sections.accents].reverse()

    const moved = parseFile(ctx, accented)

    expectEqual(moved.ok, true, 'a file with other accents is read', problems)

    if (moved.ok) {
      expectEqual(moved.roles.sections.accents, [...base.sections.accents].reverse(), 'the accents of the file', problems)
      expectEqual(moved.roles.charts.categorical, base.charts.categorical, 'the chart colours of a file that changes the accents', problems)
    }

    return verdict(problems)
  }],

  ['selection and focus stay apart from the section colour: the active wash is stronger than the hover wash, and no section colour in any mode is the focus colour', async (ctx) => {
    const problems = []

    presets(ctx).forEach((appearance) => {
      const { sectionSoft, sectionTint } = appearance.washes

      if (!(sectionSoft > sectionTint && sectionTint > 0)) {
        problems.push(`${appearance.id}: the active wash ${sectionSoft} is not stronger than the hover wash ${sectionTint}`)
      }

      ctx.contrast.ACCENT_MODES.forEach((mode) => {
        const colors = [...ctx.contrast.sectionAccents(appearance, mode), appearance.sections.neutral].map((color) => color.toLowerCase())

        if (colors.includes(appearance.focus.primary.toLowerCase())) {
          problems.push(`${appearance.id}: a section colour in ${mode} is the focus colour ${appearance.focus.primary}`)
        }
      })
    })

    return verdict(problems)
  }],

  ['the mode is kept with one write and drawn at once; a failed write or an unknown mode changes nothing', async (ctx) => {
    const problems = []
    const { applyAccents, accentMode } = ctx.appearance
    const config = fakeConfig({})

    expectEqual(accentMode(), 'on', 'the mode before any choice', problems)
    expectEqual(applyAccents(config, 'restrained'), true, 'the result of restrained', problems)
    expectEqual([accentMode(), config.data.appearanceAccents, config.writes], ['restrained', 'restrained', [{ via: 'set', keys: ['appearanceAccents'] }]], 'the mode, the setting and the writes after restrained', problems)

    config.failNext = true

    try {
      applyAccents(config, 'off')
      problems.push('a failed write did not throw')
    } catch (error) {
      expectEqual([accentMode(), config.data.appearanceAccents], ['restrained', 'restrained'], 'the mode and the setting after a failed write', problems)
    }

    const writes = config.writes.length

    expectEqual(applyAccents(config, 'loud'), false, 'the result of an unknown mode', problems)
    expectEqual(applyAccents(config, undefined), false, 'the result of no mode', problems)
    expectEqual([accentMode(), config.data.appearanceAccents, config.writes.length], ['restrained', 'restrained', writes], 'the mode, the setting and the writes after an unknown mode', problems)

    applyAccents(config, 'on')
    expectEqual([accentMode(), config.data.appearanceAccents], ['on', 'on'], 'the mode and the setting after on', problems)

    return verdict(problems)
  }],

  ['the kept mode is read at start, an invalid or absent one is on without a write, and the other appearance choices keep it', async (ctx) => {
    const problems = []

    for (const mode of ['restrained', 'off', 'on']) {
      const fresh = await ctx.reload()
      const config = fakeConfig({ appearanceAccents: mode })

      fresh.appearance.loadAppearance(config)
      expectEqual([fresh.appearance.accentMode(), config.writes], [mode, []], `the start with ${mode} kept`, problems)
    }

    for (const stored of [undefined, 'loud', 3, null, ['off'], 'OFF']) {
      const fresh = await ctx.reload()
      const config = fakeConfig(stored === undefined ? {} : { appearanceAccents: stored })

      fresh.appearance.loadAppearance(config)
      expectEqual([fresh.appearance.accentMode(), config.writes], ['on', []], `the start with ${short(stored)} kept`, problems)
    }

    const config = fakeConfig({})

    ctx.appearance.loadAppearance(config)
    ctx.appearance.applyAccents(config, 'off')
    ctx.appearance.applyPolicy(config, 'dark')
    ctx.appearance.applyPreset(config, 'solaris')
    ctx.appearance.removeCustom(config)
    ctx.appearance.applyPreset(config, 't2d')
    expectEqual([ctx.appearance.accentMode(), config.data.appearanceAccents], ['off', 'off'], 'the mode after the theme, a preset and a removal', problems)

    const again = await ctx.reload()

    again.appearance.loadAppearance(fakeConfig(config.data))
    expectEqual(again.appearance.accentMode(), 'off', 'the mode after a restart', problems)

    return verdict(problems)
  }],

  ['a change of the settings under the app (an import, an undo) is followed by the next adoption', async (ctx) => {
    const problems = []
    const { adoptAppearance, accentMode } = ctx.appearance

    adoptAppearance(fakeConfig({ appearanceAccents: 'off' }))
    expectEqual(accentMode(), 'off', 'the mode adopted', problems)
    adoptAppearance(fakeConfig({ appearanceAccents: 'restrained' }))
    expectEqual(accentMode(), 'restrained', 'the mode adopted again', problems)
    adoptAppearance(fakeConfig({}))
    expectEqual(accentMode(), 'on', 'the mode after the setting is gone', problems)

    return verdict(problems)
  }],

  ['the mode is a setting a reset of the views keeps, and a view is cleared beside it', async (ctx) => {
    const problems = []
    const { APPEARANCE_SETTINGS, ACCENTS_KEY } = ctx.appearance
    const store = { appearanceAccents: 'off', appearancePolicy: 'dark', someView: { sort: 'name' } }
    const cleared = ctx.views.withoutViews(store, [...APPEARANCE_SETTINGS, 'darkMode'])

    expectEqual(APPEARANCE_SETTINGS.includes(ACCENTS_KEY), true, 'the key among the appearance settings', problems)
    expectEqual(cleared, { appearanceAccents: 'off', appearancePolicy: 'dark' }, 'the settings after the reset', problems)

    return verdict(problems)
  }],

  ['the preferences carry the mode: exported, imported, undone, an explicit on clears a stored mode, and an invalid mode is refused', async (ctx) => {
    const problems = []
    const { buildExport, parseBundle, planImport, commitImport, undoImport } = ctx.preferences
    const schema = schemaOf(ctx)
    const exported = buildExport(schema, { appearanceAccents: 'off' }, SOURCE, ['appearance'])

    expectEqual(((exported.bundle.categories.appearance || {}).app || {}), { appearanceAccents: 'off' }, 'the export', problems)
    expectEqual(exported.skipped, [], 'the skipped values', problems)

    const parsed = parseBundle(JSON.stringify(exported.bundle), schema)

    expectEqual(parsed.errors || [], [], 'the import errors', problems)

    const store = { appearanceAccents: 'restrained' }
    const committed = commitImport(store, planImport({ store, entries: parsed.entries, source: SOURCE, target: TARGET, categories: ['appearance'] }), { target: TARGET, source: SOURCE })

    expectEqual(committed.store.appearanceAccents, 'off', 'the setting after the import', problems)
    expectEqual(undoImport(committed.store, committed.backup).store, store, 'the settings after the undo', problems)

    const on = parseBundle(bundleOf({ appearanceAccents: 'on' }), schema)

    expectEqual(on.errors || [], [], 'the errors of an explicit on', problems)
    expectEqual(commitImport(store, planImport({ store, entries: on.entries, source: SOURCE, target: TARGET, categories: ['appearance'] }), { target: TARGET, source: SOURCE }).store.appearanceAccents, 'on', 'the setting after an explicit on', problems)

    for (const value of ['loud', 3, null, true, ['off']]) {
      if (!(parseBundle(bundleOf({ appearanceAccents: value }), schema).errors || []).length) {
        problems.push(`${short(value)} was accepted`)
      }
    }

    const without = schemaOf(ctx, null)

    expectEqual([...without.keys()].filter((key) => key.endsWith(':appearanceAccents')), [], 'the fields of a schema without the accents', problems)
    expectEqual([...schema.keys()].filter((key) => key.endsWith(':appearanceAccents')), ['appearance:app:appearanceAccents'], 'the fields of a schema with them', problems)

    const declared = ctx.preferences.buildSchema({ declarations: [{ scope: 'app', key: 'appearanceAccents', default: null }], appearance: { key: 'appearance', ids: ['light'], none: 'theme', baselines: {} }, policy: { key: 'appearancePolicy', values: ctx.appearance.POLICIES }, accents: { key: 'appearanceAccents', values: ctx.appearance.ACCENT_MODES }, font: { key: ctx.font.FONT_KEY, read: ctx.font.readFont }, separators: [','] })

    expectEqual([...declared.keys()].filter((key) => key.endsWith(':appearanceAccents')), ['appearance:app:appearanceAccents'], 'the fields when a page declares the same key', problems)

    return verdict(problems)
  }],

  ['an appearance file carries the accents, and a list that repeats a colour or has the wrong length is refused', async (ctx) => {
    const problems = []

    for (const { id } of presets(ctx)) {
      const base = ctx.appearance.resolveAppearance(id)
      const exported = ctx.appearance.exportAppearanceFile(id, 1000)

      expectEqual(exported.roles.sections, base.sections, `${id}: the roles exported`, problems)

      const read = parseFile(ctx, exported)

      expectEqual(read.ok, true, `${id}: the file is read`, problems)

      if (read.ok) {
        expectEqual(read.roles.sections, base.sections, `${id}: the roles read`, problems)
      }
    }

    const make = (accents) => ({ ...ctx.appearance.exportAppearanceFile('light', 1000), roles: { sections: { accents } } })
    const accents = ctx.appearance.resolveAppearance('light').sections.accents
    const repeated = parseFile(ctx, make([...accents.slice(0, 8), accents[0]]))

    expectEqual([repeated.ok, repeated.errors.length, /section/.test(((repeated.errors || [])[0] || {}).message || '')], [false, 1, true], 'a repeated accent', problems)
    expectEqual(parseFile(ctx, make(accents.slice(0, 8))).ok, false, 'eight accents', problems)
    expectEqual(parseFile(ctx, make([...accents, '#123456'])).ok, false, 'ten accents', problems)
    expectEqual(parseFile(ctx, make([...accents.slice(0, 8), 'red'])).ok, false, 'a colour that is no hex', problems)
    expectEqual(parseFile(ctx, { ...ctx.appearance.exportAppearanceFile('light', 1000), roles: { sections: { accents, hue: '#123456' } } }).ok, false, 'a role the group has not', problems)

    return verdict(problems)
  }],

  ['the contrast of an accent is measured in every mode: nine on, nine restrained and the neutral one off, against each surface, and a failing one is reported with its label', async (ctx) => {
    const problems = []
    const { measureAppearance } = ctx.contrast

    presets(ctx).forEach((appearance) => {
      const rows = measureAppearance(appearance).sections
      const surfaces = new Set(rows.map((row) => row.surface))
      const per = (mode) => rows.filter((row) => row.mode === mode)

      expectEqual([per('on').length, per('restrained').length, per('off').length], [9 * surfaces.size, 9 * surfaces.size, surfaces.size], `${appearance.id}: the rows of each mode for ${surfaces.size} surfaces`, problems)
      expectEqual(rows.every((row) => row.minimum === 3 && Number.isFinite(row.ratio)), true, `${appearance.id}: a ratio and the 3:1 minimum on each row`, problems)
      expectEqual(rows.filter((row) => !row.pass).length, 0, `${appearance.id}: the rows under their minimum`, problems)
      expectEqual(per('off').every((row) => row.section === null), true, `${appearance.id}: the off rows name no section`, problems)
    })

    const light = ctx.appearance.resolveAppearance('light')
    const faint = { ...light, sections: { ...light.sections, accents: light.sections.accents.map((color, index) => (index === 4 ? light.surfaces.card : color)) } }
    const report = ctx.file.contrastReport(faint)

    expectEqual(report.findings.some(({ label }) => label === 'Section 5 accent (on)'), true, 'the finding of a faint accent', problems)

    const neutral = ctx.file.contrastReport({ ...light, sections: { ...light.sections, neutral: light.surfaces.card } })

    expectEqual(neutral.findings.some(({ label }) => label === 'Neutral section accent (accents off)'), true, 'the finding of a faint neutral accent', problems)
    expectEqual(ctx.file.contrastReport(light).findings.filter(({ label }) => /section/i.test(label)), [], 'the findings of the preset', problems)

    presets(ctx).forEach((appearance) => {
      const rows = measureAppearance(appearance).sectionText
      const per = (mode) => rows.filter((row) => row.mode === mode)

      expectEqual([per('on').length >= 9, per('restrained').length >= 9, per('off').length >= 1], [true, true, true], `${appearance.id}: the text rows of each mode`, problems)
      expectEqual(rows.every((row) => row.minimum === 4.5 && Number.isFinite(row.ratio)), true, `${appearance.id}: a ratio and the 4.5:1 minimum on each text row`, problems)
      expectEqual(rows.filter((row) => !row.pass).length, 0, `${appearance.id}: the text rows under their minimum`, problems)
      expectEqual(per('off').every((row) => row.section === null), true, `${appearance.id}: the off text rows name no section`, problems)
    })

    const unreadable = { ...light, inks: { ...light.inks, body: light.surfaces.card } }
    const text = ctx.file.contrastReport(unreadable)

    expectEqual(text.findings.some(({ label }) => label === 'Section 5 accent as text (on)'), true, 'the finding of text that cannot be made readable', problems)
    expectEqual(text.findings.some(({ label }) => label === 'Section 5 accent as text (restrained)'), true, 'the finding of restrained text that cannot be made readable', problems)

    return verdict(problems)
  }],

  ['the colour of a section as text reads at 4.5:1 on every background text sits on, in every mode of every preset; a colour that already reads is kept, and one that does not keeps its hue', async (ctx) => {
    const problems = []
    const { sectionAccents, sectionTexts, sectionText } = ctx.contrast
    const { SECTIONS } = ctx.navigation

    presets(ctx).forEach((appearance) => {
      ctx.contrast.ACCENT_MODES.forEach((mode) => {
        const colors = sectionAccents(appearance, mode)
        const texts = sectionTexts(appearance, mode)

        expectEqual(texts.length, 9, `${appearance.id}: ${mode}: the text colours`, problems)

        texts.forEach((text, index) => {
          if (!readsAsText(ctx, appearance, text)) {
            problems.push(`${appearance.id}: ${mode}: section ${index} text ${text} (from ${colors[index]}) does not read at 4.5:1`)
          }

          if (readsAsText(ctx, appearance, colors[index]) && text !== colors[index]) {
            problems.push(`${appearance.id}: ${mode}: section ${index} reads as ${colors[index]} and was changed to ${text}`)
          }

          // The first mix that reads is the one drawn, so no nearer step of the 256 reads and none is skipped.
          expectEqual(text, firstReading(ctx, appearance, colors[index]), `${appearance.id}: ${mode}: section ${index} text from ${colors[index]}`, problems)
        })

        SECTIONS.forEach((section) => {
          expectEqual(sectionText(appearance, section, mode), texts[section.accent], `${appearance.id}: ${section.id} in ${mode}`, problems)
        })
      })

      expectEqual(new Set(sectionTexts(appearance, 'off')).size, 1, `${appearance.id}: the off text colours`, problems)
      expectEqual(sectionText(appearance, null, 'on'), sectionTexts(appearance, 'off')[0], `${appearance.id}: no section`, problems)
    })

    // The monochrome preset's text stays grey: the mix with a grey ink adds no hue.
    expectEqual(sectionTexts(ctx.appearance.resolveAppearance('t2d'), 'on').every((text) => text.slice(1, 3) === text.slice(3, 5) && text.slice(3, 5) === text.slice(5, 7)), true, 't2d: the text colours are greys', problems)

    return verdict(problems)
  }],

  ['the overlays of a tab that the text colour is measured under are the ones of Vuetify itself, and the built-in Dark and Light text reads over a hovered and a focused active tab in every mode', async (ctx) => {
    const problems = []
    const { parseColor, over, ratio, sectionTexts, VUETIFY_TAB_STATES } = ctx.contrast

    ;['light', 'dark'].forEach((mode) => {
      expectEqual(VUETIFY_TAB_STATES[mode], vuetifyStates(mode), `the tab overlays of the ${mode} theme`, problems)
    })

    ;['light', 'dark'].forEach((id) => {
      const appearance = ctx.appearance.resolveAppearance(id)
      const states = vuetifyStates(appearance.mode)

      ctx.contrast.ACCENT_MODES.forEach((mode) => {
        sectionTexts(appearance, mode).forEach((text, index) => {
          ;['background', 'card', 'chrome'].forEach((name) => {
            const surface = parseColor(appearance.surfaces[name])

            ;['activated', 'pressed'].forEach((state) => {
              const value = ratio(parseColor(text), over({ ...parseColor(text), a: states[state] }, surface))

              if (value < 4.5) {
                problems.push(`${id}: ${mode}: section ${index} text ${text} on the ${name} under the ${state} overlay is ${value.toFixed(2)}:1`)
              }
            })
          })
        })
      })
    })

    return verdict(problems)
  }],

  ['a file whose accent and neutral accent each read as text but whose restrained mix does not still gets text that reads, and the mix is the colour that is made readable', async (ctx) => {
    const problems = []
    const dark = ctx.appearance.resolveAppearance('dark')
    const accents = [...dark.sections.accents]

    accents[2] = '#ff00ff'

    const custom = { ...dark, sections: { neutral: '#878787', accents } }
    const { sectionAccents, sectionTexts, parseColor, ratio } = ctx.contrast
    const card = parseColor(custom.surfaces.card)
    const on = sectionAccents(custom, 'on')[2]
    const soft = sectionAccents(custom, 'restrained')[2]
    const off = sectionAccents(custom, 'off')[2]

    expectEqual([ratio(parseColor(on), card) >= 4.5, ratio(parseColor(off), card) >= 4.5, ratio(parseColor(soft), card) < 4.5], [true, true, true], 'the raw colours: both ends read on the card and the mix does not', problems)

    ctx.contrast.ACCENT_MODES.forEach((mode) => {
      const text = sectionTexts(custom, mode)[2]

      expectEqual(readsAsText(ctx, custom, text), true, `${mode}: the text colour ${text}`, problems)
    })

    expectEqual(sectionTexts(custom, 'restrained')[2] !== soft, true, 'the restrained text colour is not the raw mix', problems)

    // A file with no section washes and a transparent hover wash is still drawn with Vuetify's overlay on an active tab: the text colour does not lean on a wash the file left out.
    const bare = { ...custom, washes: { ...custom.washes, sectionSoft: 0, sectionTint: 0 }, focus: { ...custom.focus, hover: 'rgba(0, 0, 0, 0)' } }

    ctx.contrast.ACCENT_MODES.forEach((mode) => {
      const text = sectionTexts(bare, mode)[2]

      expectEqual([readsAsText(ctx, bare, text), text === firstReading(ctx, bare, sectionAccents(bare, mode)[2])], [true, true], `${mode} without washes: the text colour ${text}`, problems)
    })

    // A table row can carry a strong wash of its own in a file; the text of a figure in it must read on it too.
    const washy = { ...bare, rows: { ...bare.rows, selected: 'rgba(230, 120, 230, 0.5)' } }

    ctx.contrast.ACCENT_MODES.forEach((mode) => {
      const text = sectionTexts(washy, mode)[2]

      expectEqual([readsAsText(ctx, washy, text), text === firstReading(ctx, washy, sectionAccents(washy, mode)[2])], [true, true], `${mode} over a strong row wash: the text colour ${text}`, problems)
    })

    const states = vuetifyStates('dark')
    const tab = (color, share) => ratio(parseColor(color), ctx.contrast.over({ ...parseColor(color), a: share }, card))

    expectEqual([tab(soft, states.activated) < 4.5, tab(sectionTexts(bare, 'restrained')[2], states.activated) >= 4.5, tab(sectionTexts(bare, 'restrained')[2], states.pressed) >= 4.5], [true, true, true], 'the raw mix fails over a hovered tab, the text colour reads over a hovered and a focused one', problems)
    expectEqual(ctx.file.contrastReport(custom).findings.filter(({ label }) => /section/i.test(label)), [], 'the findings of the file', problems)

    const exported = ctx.appearance.exportAppearanceFile('dark', 1000)

    exported.roles.sections = { neutral: '#878787', accents }

    const read = parseFile(ctx, exported)

    expectEqual(read.ok, true, 'the file is read', problems)

    if (read.ok) {
      expectEqual(read.roles.sections, { neutral: '#878787', accents }, 'the accents of the file', problems)
    }

    return verdict(problems)
  }],
]

const APPEARANCE = 'appearance.js'
const CONTRAST = 'appearance-contrast.js'
const FILE = 'appearance-file.js'

const MUTATIONS = [
  ['a section colour read from the chart palette', { file: CONTRAST, from: '(section ? sectionAccents(appearance, mode)[section.accent] :', to: '(section ? appearance.charts.categorical[section.accent] :' }],
  ['the accents of every mode read from the chart palette', { file: CONTRAST, from: 'const { accents, neutral } = appearance.sections', to: 'const { neutral } = appearance.sections\n  const accents = appearance.charts.categorical' }],
  ['accents that are a copy of the chart colours of the preset', { file: APPEARANCE, from: 'sections: { ...preset.sections, accents: [...preset.sections.accents] }', to: 'sections: { ...preset.sections, accents: [...preset.charts.categorical] }' }],
  ['the restrained mode that is the on mode', { file: CONTRAST, from: 'const RESTRAINT = 0.5', to: 'const RESTRAINT = 0' }],
  ['the restrained mode that is the neutral accent', { file: CONTRAST, from: 'const RESTRAINT = 0.5', to: 'const RESTRAINT = 1' }],
  ['the restrained mode that is the off mode', { file: CONTRAST, from: "  if (mode === 'restrained') {\n    if (!restrained.has(appearance)) {", to: "  if (mode === 'restrained') {\n    return accents.map(() => neutral)\n    if (!restrained.has(appearance)) {" }],
  ['the off mode that keeps the accents', { file: CONTRAST, from: "  if (mode === 'off') {\n    return accents.map(() => neutral)", to: "  if (mode === 'off') {\n    return accents" }],
  ['a place without a section that takes the first accent', { file: CONTRAST, from: ': appearance.sections.neutral)', to: ': sectionAccents(appearance, mode)[0])' }],
  ['a default mode that is restrained', { file: CONTRAST, from: "export const DEFAULT_ACCENT_MODE = 'on'", to: "export const DEFAULT_ACCENT_MODE = 'restrained'" }],
  ['the mode drawn before it is written', { file: APPEARANCE, from: '  config.set(ACCENTS_KEY, mode)\n  state.accents = mode', to: '  state.accents = mode\n  config.set(ACCENTS_KEY, mode)' }],
  ['the mode drawn but not written', { file: APPEARANCE, from: '  config.set(ACCENTS_KEY, mode)\n  state.accents = mode', to: '  state.accents = mode' }],
  ['the mode written but not drawn', { file: APPEARANCE, from: '  config.set(ACCENTS_KEY, mode)\n  state.accents = mode', to: '  config.set(ACCENTS_KEY, mode)' }],
  ['an unknown mode accepted', { file: APPEARANCE, from: '  if (!ACCENT_MODES.includes(mode)) {\n    return false\n  }\n\n  config.set(ACCENTS_KEY, mode)', to: '  config.set(ACCENTS_KEY, mode)' }],
  ['a stored mode not adopted', { file: APPEARANCE, from: 'state.accents = ACCENT_MODES.includes(accents) ? accents : DEFAULT_ACCENT_MODE', to: 'state.accents = DEFAULT_ACCENT_MODE' }],
  ['an invalid stored mode adopted', { file: APPEARANCE, from: 'state.accents = ACCENT_MODES.includes(accents) ? accents : DEFAULT_ACCENT_MODE', to: 'state.accents = accents || DEFAULT_ACCENT_MODE' }],
  ['the mode not among the settings a reset keeps', { file: APPEARANCE, from: 'FONT_KEY, POLICY_KEY, ACCENTS_KEY]', to: 'FONT_KEY, POLICY_KEY]' }],
  ['a mode that is dropped by a named appearance', { file: APPEARANCE, from: 'export const applyPreset = (config, id) => {', to: 'export const applyPreset = (config, id) => {\n  state.accents = DEFAULT_ACCENT_MODE' }],
  ['the preferences without the mode', { file: 'preferences.js', from: "  if (accents) {\n    add('appearance', 'app', accents.key,", to: "  if (false) {\n    add('appearance', 'app', accents.key," }],
  ['any mode imported', { file: 'preferences.js', from: "typeof value === 'string' && accents.values.includes(value) ? { ok: true, value }", to: "typeof value === 'string' ? { ok: true, value }" }],
  ['the mode treated as a view by the preferences', { file: 'preferences.js', from: ' && !(accents && key === accents.key)', to: '' }],
  ['the accents role missing from the file', { file: FILE, from: "sections: { neutral: 'hex', accents: 'list' }", to: "sections: { neutral: 'hex' }" }],
  ['the accents of a file read as chart colours', { file: FILE, from: "sections: { neutral: 'hex', accents: 'list' }", to: "sections: { neutral: 'hex', accents: 'hex' }" }],
  ['a repeated accent accepted', { file: FILE, from: '} else if (seen.has(color.toLowerCase())) {', to: '} else if (false) {' }],
  ['the accents left out of the contrast measurement', { file: CONTRAST, from: 'guard(measured.sections,', to: 'guard([],' }],
  ['the accents left out of the contrast report', { file: FILE, from: '    ...measured.sections.map((row) =>', to: '    ...[].map((row) =>' }],
  ['two sections sharing an accent', { file: 'navigation.js', from: "icon: 'mdi-pencil-ruler', accent: 8 }", to: "icon: 'mdi-pencil-ruler', accent: 0 }" }],
  ['two sections sharing an icon', { file: 'navigation.js', from: "icon: 'mdi-pencil-ruler', accent: 8 }", to: "icon: 'mdi-flask-outline', accent: 8 }" }],
  ['the text colour of a section left as the colour in force', { file: CONTRAST, from: 'read.set(color, readableSectionText(appearance, color))', to: 'read.set(color, color)' }],
  ['the text colour of every mode worked out from the on accents', { file: CONTRAST, from: 'kept[mode] = sectionAccents(appearance, mode).map((color) => {', to: "kept[mode] = sectionAccents(appearance, 'on').map((color) => {" }],
  ['the text colour worked out against plain surfaces only', { file: CONTRAST, from: "return [['plain', surface], ['hovered', over(parseColor(appearance.focus.hover), surface)], ['active tab hovered', over({ ...text, a: states.activated }, surface)], ['active tab focused', over({ ...text, a: states.pressed }, surface)]].map(", to: "return [['plain', surface]].map(" }],
  ['the text colour worked out against a plain card only', { file: CONTRAST, from: 'const surfaces = SURFACES.flatMap((surfacePath) => {', to: "const surfaces = ['surfaces.card'].flatMap((surfacePath) => {" }],
  ['the text colour nudged toward the card instead of the body ink', { file: CONTRAST, from: "const ink = over(parseColor(appearance.inks.body), solid(appearance, 'surfaces.card'))", to: "const ink = solid(appearance, 'surfaces.card')" }],
  ['the text colour of a section that is the body ink and no nearer mix', { file: CONTRAST, from: 'return hex(candidate)\n    }\n  }\n\n  return hex(ink)', to: 'return hex(ink)\n    }\n  }\n\n  return hex(ink)' }],
  ['the text colour of a section that skips the first mixes', { file: CONTRAST, from: 'for (let step = 1; step <= MIX_STEPS; step++) {', to: 'for (let step = 8; step <= MIX_STEPS; step += 8) {' }],
  ['the overlay measured lower than the drawn one', { file: CONTRAST, from: 'dark: { activated: 0.24, pressed: 0.32 } }', to: 'dark: { activated: 0.12, pressed: 0.32 } }' }],
  ['the overlay of a hovered tab measured at the light theme in the dark one', { file: CONTRAST, from: 'const states = VUETIFY_TAB_STATES[appearance.mode]', to: 'const states = VUETIFY_TAB_STATES.light' }],
  ['the focused state of a tab left out', { file: CONTRAST, from: ", ['active tab focused', over({ ...text, a: states.pressed }, surface)]", to: '' }],
  ['the overlay of a focused tab taken from the wash of a section', { file: CONTRAST, from: 'over({ ...text, a: states.pressed }, surface)', to: 'over({ ...text, a: appearance.washes.sectionSoft }, surface)' }],
  ['the rows of a table left out of the backdrops', { file: CONTRAST, from: 'return [...surfaces, ...rows].filter(', to: 'return [...surfaces].filter(' }],
  ['the text measured at the graphic minimum', { file: CONTRAST, from: 'surface: hex(background), surfacePath, minimum: TEXT }, () => ratio(parseColor(color), background))', to: 'surface: hex(background), surfacePath, minimum: GRAPHIC }, () => ratio(parseColor(color), background))' }],
  ['the text of the sections left out of the contrast measurement', { file: CONTRAST, from: 'guard(measured.sectionText,', to: 'guard([],' }],
  ['the text of the sections left out of the contrast report', { file: FILE, from: '    ...measured.sectionText.map((row) =>', to: '    ...[].map((row) =>' }],
  ['a hover wash as strong as the active one', { file: APPEARANCE, from: 'washes: { ...preset.washes }', to: 'washes: { ...preset.washes, sectionTint: preset.washes.sectionSoft }' }],
]

const mutatedCopy = ({ file, from, to }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-accents-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const text = fs.readFileSync(target, 'utf8')

  if (text.split(from).length !== 2) {
    throw new Error(`The mutation of ${file} does not apply exactly once: ${from}`)
  }

  fs.writeFileSync(target, text.replace(from, () => to))

  return directory
}

const runChecks = async (directory) => {
  const results = []

  for (const [name, check] of CHECKS) {
    try {
      results.push([name, await check(await load(directory))])
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

  console.log('Section accents')

  for (const [name, result] of await runChecks()) {
    tally(result === true)
    console.log(`${result === true ? 'PASS' : 'FAIL'}  ${name}${result === true ? '' : `  [${typeof result === 'string' ? result : 'false'}]`}`)
  }

  console.log('\nMutations: each must fail at least one check, and the checks it fails are listed by number')

  for (const [label, fault] of MUTATIONS) {
    let directory

    try {
      directory = mutatedCopy(fault)

      const failed = (await runChecks(directory)).map(([, result], index) => [index + 1, result]).filter(([, result]) => result !== true).map(([index]) => index)

      tally(failed.length > 0)
      console.log(`${failed.length ? 'PASS' : 'FAIL'}  mutation caught: ${label}  [${failed.length ? `fails check ${failed.join(', ')}` : 'every check still passes'}]`)
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
