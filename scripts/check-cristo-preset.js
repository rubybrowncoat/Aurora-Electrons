#!/usr/bin/env node
/*
  The Cristo inspired preset (src/renderer/utilities/appearance.js: `CRISTO`; credits.js: the `cristo-theme` entry), checked without a browser.

  It proves: the preset names the inspected revision of the community theme it adapts, its lineage (a Solaris theme base and a second theme's two colours) and the licence position (no grant for the colours the Cristo and DeepBlue authors added, none claimed); the colour values the theme's source inventoried are the ones the preset maps, each to the roles it says; the planet green, which is 2.02:1 on the page, is replaced by a lighter one of the same hue that is 3:1 or more on every surface and the sky, and the replacement and the original are both on the record; the orbit colour is the preset's own and neither of the two values the source and the compiled patch disagree on; nothing but colour values is taken (no icon, event-colour file, compiled file, screenshot or font file in the tree, no entry that ships a file, no patch library among the dependencies, the preset plain data); the event-colour compatibility is stated apart from the theme identity (its own object, never in the roles, the exported file or the colour groups); the credits entry carries the revision, the retained notice, the reuse kind and the compatibility; the wording keeps off the names the repository does not use and off the first person; the readability matrix (every measurement of the contrast gate, in the three accent modes) passes; the file of the preset round trips with its provenance; and the preset is previewed, kept, restarted and combined with each accent mode.

  What a browser shows (the preset card, the reference panel with its compatibility note, the credits row and the rail, tabs and breadcrumb in each accent mode, at three sizes) is probed separately with Playwright; the run is recorded in docs/plans/backlog/evidence/AE-003-02.md. The full gate (the compiled stylesheet, the colour-vision simulation, the map menu) is scripts/check-contrast.js --preset cristo.

  Run: node scripts/check-cristo-preset.js
*/
const fs = require('fs')
const path = require('path')

const { loadUtilities } = require('./lib/utilities')
const { plantedCopy } = require('./lib/mutant-source')
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

// A fresh copy of the modules, so the state of one check never reaches another; `directory` is a copy of the utilities folder with a planted fault.
const load = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(NAMES, { directory, stubs: stubs(instance++) })

  return { font: loaded['appearance-font'], appearance: loaded.appearance, file: loaded['appearance-file'], contrast: loaded['appearance-contrast'], credits: loaded.credits, reload: () => load(directory) }
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

const luminanceOf = (color) => {
  const [r, g, b] = rgb(color).map((channel) => {
    const value = channel / 255

    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })

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

// The colour values the community theme's source holds, as inventoried at the revision (docs/plans/backlog/evidence/AE-003-01.md), and the roles of the preset each maps to.
const REVISION = '4b30899b984c1dd1bb75d2bd7c17a994a1227bdb'
const SOLARIS_REVISION = '83aa53017754216367851620b4457284db654c15'
const INVENTORY = [
  ['Window and map background', '#0d1729', ['surfaces.background', 'space.background']],
  ['Text', '#f0f0c8', ['inks.body', 'inks.text', 'inks.onTooltip']],
  ['Map text', '#eed8a4', ['space.label']],
  ['Button fill', '#171a27', ['surfaces.card', 'surfaces.chrome']],
  ['Active button border (derived)', '#41486d', ['surfaces.border', 'charts.axis']],
]
const PLANET = '#005700'
const ORBIT_VALUES = ['#beffbe', '#ffffff']
const SURFACE_PATHS = ['surfaces.background', 'surfaces.card', 'surfaces.chrome', 'space.background']

const cristo = (ctx) => ctx.appearance.resolveAppearance('cristo')

const entryOf = (ctx) => ctx.credits.CREDITS.find((credit) => credit.id === 'cristo-theme')

// Every string of a value, notices excluded where the caller removed them.
const strings = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])

// The paths of what is not plain data (a function, an undefined member, a symbol) in a value.
const notData = (value, where = 'preset') => (value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => notData(inner, `${where}.${key}`)) : ['string', 'number', 'boolean'].includes(typeof value) || value === null ? [] : [`${where} is ${typeof value}`])

const FORBIDDEN = /AuroraPatch|Aurora Patch|ThemeCreator|Harmony/i
const FIRST_OR_SECOND_PERSON = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i

const walk = (directory, found = []) => {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const target = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      walk(target, found)
    } else {
      found.push(target)
    }
  })

  return found
}

const CHECKS = [
  ['the preset is registered after the other adaptations, is dark, is versioned, and names the revision of the community theme it was read at, with its lineage and the licence position', async (ctx) => {
    const problems = []
    const ids = ctx.appearance.listAppearances().map(({ id }) => id)
    const appearance = cristo(ctx)

    expectEqual(ids, ['light', 'dark', 'classic', 'solaris', 't2d', 'cristo', 'deepblue'], 'the presets in order', problems)
    expectEqual([appearance.id, appearance.name, appearance.mode, appearance.key], ['cristo', 'Cristo inspired', 'dark', 'cristo@1'], 'the identity', problems)
    expectEqual(Number.isInteger(appearance.version) && appearance.version >= 1, true, 'the version is a positive integer', problems)

    const { source } = appearance.reference

    expectEqual([source.revision, source.repository, source.revisionDate], [REVISION, 'https://github.com/CountCristo/Cristotheme', '2026-06-15'], 'the inspected revision', problems)
    expectEqual(/^[0-9a-f]{40}$/.test(source.revision) && source.revision !== SOLARIS_REVISION, true, 'a full revision of its own, not the Solaris one', problems)
    expectEqual(['CountCristo', 'Simas Toleikis', 'Jorgen_CAB'].map((name) => source.author.includes(name)), [true, true, true], 'the author and both lineage authors named', problems)
    expectEqual([/no license/i.test(source.license), /no grant/i.test(source.license), /MIT/.test(source.license), /^MIT License$/.test(source.license)], [true, true, true, false], 'the licence says none is stated, no grant covers the added colours, and the retained notice is the MIT one', problems)
    expectEqual([/last changed/i.test(source.inspected), /nothing was run/i.test(source.inspected)], [true, true], 'what was inspected and how', problems)
    expectEqual(/no source code, image, icon, font, event-colour file or compiled file/i.test(source.copied), true, 'what was not copied', problems)

    const solaris = ctx.appearance.resolveAppearance('solaris')

    expectEqual(solaris.reference.source.revision, SOLARIS_REVISION, 'the Solaris preset keeps its own revision', problems)

    return verdict(problems)
  }],

  ['every inventoried colour value is in the preset at the roles it maps to, and the reference lists each with its original value', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)

    INVENTORY.forEach(([role, value, paths]) => {
      const listed = appearance.reference.roles.find((entry) => entry.role === role)

      expectEqual(listed && listed.value.toLowerCase(), value, `the reference role ${role}`, problems)
      paths.forEach((dotted) => {
        expectEqual(String(at(appearance, dotted)).toLowerCase(), value, `${dotted} for ${role}`, problems)
      })
    })

    return verdict(problems)
  }],

  ['the planet green is lighter in the preset, of the same hue and 3:1 or more on every surface and the sky where the original is under 3:1, and the original, the replacement and the reason are on the record', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)
    const substitute = appearance.survey.done

    SURFACE_PATHS.forEach((dotted) => {
      const surface = at(appearance, dotted)

      expectEqual(contrastOf(PLANET, surface) < 3, true, `the original on ${dotted} is under 3:1 (${contrastOf(PLANET, surface).toFixed(2)})`, problems)

      if (contrastOf(substitute, surface) < 3) {
        problems.push(`the replacement ${substitute} on ${dotted} is ${contrastOf(substitute, surface).toFixed(2)}:1, under 3:1`)
      }
    })
    expectEqual(substitute.toLowerCase() !== PLANET, true, 'the replacement is not the original', problems)
    expectEqual(Math.abs(hueOf(substitute) - hueOf(PLANET)) <= 5, true, `the hue of the replacement ${substitute} is that of the original`, problems)
    expectEqual(luminanceOf(substitute) > luminanceOf(PLANET), true, 'the replacement is lighter', problems)

    const listed = appearance.reference.roles.find((entry) => entry.role === 'Planet fill')

    expectEqual([listed && listed.value.toLowerCase(), listed && listed.maps.toLowerCase().includes(substitute.toLowerCase()), listed && /2\.02:1/.test(listed.maps)], [PLANET, true, true], 'the reference role Planet fill', problems)
    expectEqual(appearance.reference.modifications.some((line) => /planet green/i.test(line) && /contrast/i.test(line)), true, 'the modifications say why', problems)
    expectEqual(/planet green/i.test(entryOf(ctx).modifications) && /lighter green/i.test(entryOf(ctx).modifications), true, 'the credits entry says it too', problems)

    return verdict(problems)
  }],

  ['the orbit colour is the preset\'s own: neither value the source and the compiled patch disagree on, not the planet colour, 3:1 or more on the sky, and the reference says it is not taken', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)
    const orbit = appearance.space.bodyOrbit.toLowerCase()

    expectEqual(ORBIT_VALUES.includes(orbit), false, `the orbit ${orbit} is neither disputed value`, problems)
    expectEqual([orbit === appearance.survey.done.toLowerCase(), orbit === appearance.space.label.toLowerCase()], [false, false], 'the orbit is neither the planet colour nor the label colour', problems)

    if (contrastOf(orbit, appearance.space.background) < 3) {
      problems.push(`the orbit ${orbit} on the sky is ${contrastOf(orbit, appearance.space.background).toFixed(2)}:1, under 3:1`)
    }

    const listed = appearance.reference.roles.find((entry) => entry.role === 'Orbit line')

    expectEqual([listed && /^not taken$/i.test(listed.value), listed && ORBIT_VALUES.every((value) => listed.maps.toLowerCase().includes(value))], [true, true], 'the reference role Orbit line records both disputed values and that neither is taken', problems)

    appearance.reference.roles.forEach((entry) => {
      if (entry.role !== 'Orbit line' && ORBIT_VALUES.includes(entry.value.toLowerCase())) {
        problems.push(`the role ${entry.role} lists a disputed orbit value as its own`)
      }
    })

    return verdict(problems)
  }],

  ['nothing but colour values is taken: no icon, event-colour file, compiled file, screenshot or font in the tree, no entry that ships a file, no patch library among the dependencies, and the preset is plain data', async (ctx) => {
    const problems = []
    const names = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))].map((file) => path.relative(root, file).replace(/\\/g, '/'))

    names.filter((name) => /\.(dll|exe|csv)$/i.test(name) || /mycolors|cristo.*\.(png|jpe?g|gif|ttf|otf|woff2?)$/i.test(name) || /(^|\/)Icon_[^/]*\.png$/i.test(name)).forEach((name) => {
      problems.push(`${name} is a file the preset does not take`)
    })
    expectEqual(fs.readdirSync(path.join(utilitiesDirectory, 'notices')).filter((name) => !name.endsWith('.txt')), [], 'the notices are text files', problems)

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })

    expectEqual(dependencies.filter((name) => /aurorapatch|harmony|themecreator|cristo/i.test(name)), [], 'dependencies that load a patch or a theme', problems)

    const entry = entryOf(ctx)

    expectEqual(entry && [entry.reuse.kind, entry.kind], ['Visual inspiration', 'Colour reference'], 'the credits entry ships nothing', problems)
    expectEqual(ctx.credits.CREDITS.filter((credit) => credit.reuse.kind === 'Bundled files').map(({ id }) => id), ['roboto', 'mdi'], 'the entries that ship files', problems)

    const appearance = cristo(ctx)
    expectEqual(notData(ctx.appearance.PRESETS.cristo), [], 'the members of the preset that are not plain data', problems)
    expectEqual(appearance.reference.source.copied.toLowerCase().includes('icon') && appearance.reference.source.copied.toLowerCase().includes('font'), true, 'the reference says icons and fonts are not used', problems)

    return verdict(problems)
  }],

  ['the wording keeps off the names the repository does not use and off the first and second person, in the preset\'s reference, the credits entry and the exported file', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)
    const entry = entryOf(ctx)
    const exported = JSON.stringify(ctx.appearance.exportAppearanceFile('cristo', 1000))
    const { notices, ...prose } = entry
    const texts = [...strings(appearance.reference), ...strings(prose), exported]

    texts.forEach((text) => {
      const forbidden = FORBIDDEN.exec(text)
      const person = FIRST_OR_SECOND_PERSON.exec(text)

      if (forbidden) {
        problems.push(`"${forbidden[0]}" in ${short(text)}`)
      }

      if (person) {
        problems.push(`the word "${person[0]}" in ${short(text)}`)
      }
    })
    expectEqual(notices.every((item) => !FORBIDDEN.test(item.title)), true, 'the notice titles', problems)

    return verdict(problems)
  }],

  ['the event-colour compatibility is stated apart from the theme identity: its own object, never a role, a colour group or part of the exported file, and no colour group maps events', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)
    const { compatibility, roles, source } = appearance.reference

    expectEqual(compatibility && [compatibility.title, compatibility.status], ['Event-colour compatibility', 'Not included'], 'the compatibility object', problems)
    expectEqual(compatibility && /not part of this preset/i.test(compatibility.text) && /save/i.test(compatibility.text), true, 'it says the file is not part of the preset and that the save supplies the colours', problems)
    expectEqual([roles.filter((entry) => /event/i.test(`${entry.role} ${entry.value}`)).length, /event-colour file/i.test(source.copied)], [0, true], 'no reference role is an event colour, and the source says the file is not copied', problems)
    expectEqual(Object.keys(ctx.file.ROLES).filter((group) => /event|alert/i.test(group)), [], 'no colour group of the file format maps events', problems)
    expectEqual(Object.keys(appearance).filter((key) => /event|alert/i.test(key)), [], 'no colour group of the appearance maps events', problems)

    const exported = ctx.appearance.exportAppearanceFile('cristo', 1000)

    expectEqual(JSON.stringify(exported).includes('Event-colour compatibility') || 'compatibility' in exported.provenance.reference, false, 'the identity the file carries holds no compatibility', problems)
    expectEqual(ctx.appearance.resolveAppearance('solaris').reference.compatibility, undefined, 'the presets without a compatibility note have none', problems)

    return verdict(problems)
  }],

  ['the credits entry carries the inspected revision and its link, the retained Solaris notice, the visual-inspiration reuse and the same compatibility statement', async (ctx) => {
    const problems = []
    const entry = entryOf(ctx)

    if (!entry) {
      return 'there is no credits entry with the id cristo-theme'
    }

    expectEqual([entry.name, entry.author, entry.kind], ['Cristotheme', cristo(ctx).reference.source.author, 'Colour reference'], 'the name, author and kind', problems)
    expectEqual([entry.source.label.includes(REVISION.slice(0, 7)), entry.source.href], [true, `https://github.com/CountCristo/Cristotheme/tree/${REVISION}`], 'the source', problems)
    expectEqual(entry.license.href, `https://github.com/CountCristo/Cristotheme/blob/${REVISION}/CristoTheme/LICENSE`, 'the licence link', problems)
    expectEqual([/no license/i.test(entry.license.label), /no grant/i.test(entry.license.label), /no license covers/i.test(entry.modifications), /none is claimed/i.test(entry.modifications)], [true, true, true, true], 'the caveat in the entry', problems)
    expectEqual(entry.notices.map((item) => item.text), [NOTICE], 'the notice is the Solaris theme\'s MIT License as retained in the repository', problems)
    expectEqual(/MIT License/.test(NOTICE) && /Simas Toleikis/.test(NOTICE), true, 'the notice file is the MIT License of the Solaris author', problems)
    expectEqual(entry.reuse.detail, cristo(ctx).reference.source.copied, 'the reuse detail is the preset\'s own statement', problems)
    expectEqual(entry.compatibility, cristo(ctx).reference.compatibility, 'the compatibility statement is the preset\'s own', problems)
    expectEqual(ctx.credits.CREDITS.filter((credit) => credit.compatibility).map(({ id }) => id), ['cristo-theme'], 'only this entry has a compatibility note', problems)
    expectEqual(new Set(ctx.credits.CREDITS.map(({ id }) => id)).size, ctx.credits.CREDITS.length, 'the entries have distinct ids', problems)
    expectEqual(ctx.credits.CREDITS.find(({ id }) => id === 'solaris-theme').source.href.includes(SOLARIS_REVISION), true, 'the Solaris entry keeps its revision', problems)

    return verdict(problems)
  }],

  ['the readability matrix passes in the on, restrained and off accent modes: every measurement of the contrast report, the nine accents and the neutral one as graphics (on the bare surfaces, on their own active and hover washes, on the icon plates over them, in a hovered table row and under the overlay of a list entry) and as text, the page\'s text on those washes, and the report has no blocking finding', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)
    const baseline = ctx.appearance.resolveAppearance('dark')
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

      const written = ctx.contrast.sectionTexts(appearance, mode)

      expectEqual(written.length, 9, `${mode}: nine text colours`, problems)
    })

    const counts = measured.washText.filter((row) => row.ink === 'count of available technologies')
    const rawCount = appearance.charts.categorical[2]
    const readableCount = ctx.contrast.readableWashText(appearance, rawCount)

    expectEqual([counts.length > 0, counts.every((row) => row.pass), counts.every((row) => row.foreground === readableCount), readableCount !== rawCount], [true, true, true, true], `the count of the research fields (the status colour ${rawCount}, which reads under 4.5:1 on a wash of this preset) is drawn in ${readableCount} and reads on every wash`, problems)
    expectEqual(measured.listText.map((row) => `${row.state}: ${row.ink}`).length, 6, 'the text of a list entry is measured in three states with two inks each', problems)
    measured.listText.filter((row) => !row.pass).forEach((row) => {
      problems.push(`list: ${row.ink} on the ${row.state} over the card ${row.surface} (the overlay ${row.overlay} at ${row.opacity}) is ${row.ratio.toFixed(2)}:1`)
    })

    const bars = measured.graphics.filter(({ label }) => label.startsWith('Chosen list entry bar'))

    expectEqual([bars.length, bars.every((row) => row.pass)], [2, true], 'the bar of a chosen list entry is measured under the overlay of the text ink and of the focus colour and reads at 3:1', problems)

    const { accents } = appearance.sections

    expectEqual(new Set(accents.map((color) => color.toLowerCase())).size, 9, 'the nine accents are distinct', problems)
    expectEqual([appearance.surfaces.card.toLowerCase() === appearance.surfaces.background.toLowerCase(), contrastOf(appearance.surfaces.border, appearance.surfaces.background) >= 2], [false, true], 'the card is a colour of its own against the page and its outline stands off the page', problems)

    return verdict(problems)
  }],

  ['the file of the preset round trips with its provenance: the roles are the same, the origin is the built-in preset at its version, the reference carries the revision, and the draft passes the contrast gate', async (ctx) => {
    const problems = []
    const appearance = cristo(ctx)
    const exported = ctx.appearance.exportAppearanceFile('cristo', 1000)

    expectEqual([exported.provenance.origin.kind, exported.provenance.origin.id, exported.provenance.origin.version, exported.mode], ['built-in', 'cristo', appearance.version, 'dark'], 'the origin', problems)
    expectEqual([exported.provenance.reference.source.revision, exported.provenance.reference.source.repository, exported.provenance.reference.title], [REVISION, 'https://github.com/CountCristo/Cristotheme', appearance.reference.title], 'the reference carried by the file', problems)
    expectEqual(exported.provenance.reference.source.license, appearance.reference.source.license, 'the licence position carried by the file', problems)

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
      expectEqual([draft.file.provenance.reference.source.revision, draft.file.defaults.length], [REVISION, 0], 'the draft keeps the revision and fills nothing from a base', problems)
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
      fresh.appearance.previewPreset('cristo')
      expectEqual([fresh.appearance.activeAppearance().id, fresh.appearance.isPreviewing(), fresh.appearance.accentMode(), config.data.appearance], ['cristo', true, mode, undefined], `${mode}: the preview`, problems)

      fresh.appearance.cancelPreview()
      expectEqual([fresh.appearance.activeAppearance().id, fresh.appearance.isPreviewing()], ['light', false], `${mode}: the cancelled preview`, problems)
      expectEqual(fresh.appearance.applyPreset(config, 'cristo'), true, `${mode}: kept`, problems)
      expectEqual([config.data.appearance, config.data.appearanceAccents, fresh.appearance.activeAppearance().key], ['cristo', mode, 'cristo@1'], `${mode}: the settings`, problems)

      const again = await ctx.reload()

      again.appearance.loadAppearance(fakeConfig(config.data))
      expectEqual([again.appearance.activeAppearance().id, again.appearance.appliedPresetId(), again.appearance.accentMode()], ['cristo', 'cristo', mode], `${mode}: after a restart`, problems)
      expectEqual(again.appearance.unsupportedPresetId(fakeConfig(config.data)), null, `${mode}: the stored id is supported`, problems)
    }

    return verdict(problems)
  }],
]

const CONTRAST = 'appearance-contrast.js'
const APPEARANCE = 'appearance.js'
const FILE = 'appearance-file.js'
const CREDITS = 'credits.js'

const MUTATIONS = [
  ['the planet green kept as the reference gives it', { file: APPEARANCE, from: "survey: { done: '#008a00' }", to: "survey: { done: '#005700' }" }],
  ['a planet green lightened to another hue', { file: APPEARANCE, from: "survey: { done: '#008a00' }", to: "survey: { done: '#8a008a' }" }],
  ['a planet green still under 3:1 on the card', { file: APPEARANCE, from: "survey: { done: '#008a00' }", to: "survey: { done: '#006400' }" }],
  ['the orbit the source gives', { file: APPEARANCE, from: "bodyOrbit: '#b1b9cc'", to: "bodyOrbit: '#beffbe'" }],
  ['the orbit the compiled patch draws', { file: APPEARANCE, from: "bodyOrbit: '#b1b9cc'", to: "bodyOrbit: '#ffffff'" }],
  ['an orbit the colour of the sky', { file: APPEARANCE, from: "bodyOrbit: '#b1b9cc'", to: "bodyOrbit: '#0d1729'" }],
  ['an orbit that is the planet colour', { file: APPEARANCE, from: "bodyOrbit: '#b1b9cc'", to: "bodyOrbit: '#008a00'" }],
  ['the window colour of another theme', { file: APPEARANCE, from: "surfaces: { background: '#0d1729', chrome: '#171a27'", to: "surfaces: { background: '#0c0c0c', chrome: '#171a27'" }],
  ['the map text left as the body ink', { file: APPEARANCE, from: "label: '#eed8a4', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#b1b9cc'", to: "label: '#f0f0c8', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#b1b9cc'" }],
  ['the text colour changed', { file: APPEARANCE, from: "inks: { body: '#f0f0c8', muted: '#bdbd9f', text: '#f0f0c8'", to: "inks: { body: '#f0f0c0', muted: '#bdbd9f', text: '#f0f0c8'" }],
  ['the border not the derived one', { file: APPEARANCE, from: "card: '#171a27', border: '#41486d'", to: "card: '#171a27', border: '#2f3449'" }],
  ['a card the colour of the page', { file: APPEARANCE, from: "chrome: '#171a27', card: '#171a27', border: '#41486d'", to: "chrome: '#171a27', card: '#0d1729', border: '#41486d'" }],
  ['a secondary ink the colour of the card', { file: APPEARANCE, from: "muted: '#bdbd9f', text: '#f0f0c8', textMuted: '#bdbd9f'", to: "muted: '#171a27', text: '#f0f0c8', textMuted: '#bdbd9f'" }],
  ['a neutral accent the colour of the card', { file: APPEARANCE, from: "sections: { neutral: '#a3acc8'", to: "sections: { neutral: '#171a27'" }],
  ['a section accent the colour of the card', { file: APPEARANCE, from: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00', '#9085e9', '#e66767', '#2ec4d6'] }", to: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00', '#9085e9', '#e66767', '#171a27'] }" }],
  ['a repeated section accent', { file: APPEARANCE, from: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00', '#9085e9', '#e66767', '#2ec4d6'] }", to: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00', '#9085e9', '#e66767', '#3987e5'] }" }],
  ['the Research accent that reads on the surfaces and not on its own active wash', { file: APPEARANCE, from: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00',", to: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#008300'," }],
  ['the Research accent that reads on each wash alone and not on the two layered', { file: APPEARANCE, from: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00',", to: "sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#008d00'," }],
  ['an on-colour ink that is white on the light fills', { file: APPEARANCE, from: "onFill: '#0d1729', onColor: '#0d1729', onSnackbar: '#0d1729' },\n  focus: { primary: '#8fb0ff'", to: "onFill: '#0d1729', onColor: '#ffffff', onSnackbar: '#ffffff' },\n  focus: { primary: '#8fb0ff'" }],
  ['the Solaris revision in place of the inspected one', { file: APPEARANCE, from: "revision: '4b30899b984c1dd1bb75d2bd7c17a994a1227bdb'", to: "revision: '83aa53017754216367851620b4457284db654c15'" }],
  ['a licence claimed for every colour', { file: APPEARANCE, from: "license: 'No license of its own; it keeps the Solaris theme\\'s MIT License, and no grant covers the colours added by Cristotheme or DeepBlue'", to: "license: 'MIT License'" }],
  ['the lineage authors dropped', { file: APPEARANCE, from: "author: 'CountCristo, after the Solaris theme of Simas Toleikis and the DeepBlue theme of Jorgen_CAB'", to: "author: 'CountCristo'" }],
  ['the compatibility status turned into included', { file: APPEARANCE, from: "status: 'Not included'", to: "status: 'Included'" }],
  ['the compatibility note left out of the reference', { file: APPEARANCE, from: '    compatibility: {', to: '    compatible: {' }],
  ['an undefined member in the preset', { file: APPEARANCE, from: "  id: 'cristo',\n  name: 'Cristo inspired',", to: "  id: 'cristo',\n  unset: undefined,\n  name: 'Cristo inspired'," }],
  ['a patch library named in the preset text', { file: APPEARANCE, from: 'so the preset takes neither. It does not say which Aurora version it was drawn for.', to: 'so the preset takes neither. It is applied with AuroraPatch and does not say which Aurora version it was drawn for.' }],
  ['the first person in the preset text', { file: APPEARANCE, from: 'the owner of this app accepted that no explicit grant covers them', to: 'we accepted that no explicit grant covers them' }],
  ['the version of the preset lowered', { file: APPEARANCE, from: "id: 'cristo',\n  name: 'Cristo inspired',\n  version: 1,", to: "id: 'cristo',\n  name: 'Cristo inspired',\n  version: 0," }],
  ['the preset left out of the list', { file: APPEARANCE, from: 'export const listAppearances = () => Object.keys(PRESETS).map((id) => resolveAppearance(id))', to: "export const listAppearances = () => Object.keys(PRESETS).filter((id) => id !== 'cristo').map((id) => resolveAppearance(id))" }],
  ['the preset listed before the others', { file: APPEARANCE, from: 'export const PRESETS = { [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [CRISTO.id]: CRISTO, [DEEPBLUE.id]: DEEPBLUE }', to: 'export const PRESETS = { [CRISTO.id]: CRISTO, [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [DEEPBLUE.id]: DEEPBLUE }' }],
  ['a preset that carries a function', { file: APPEARANCE, from: "  id: 'cristo',\n  name: 'Cristo inspired',", to: "  id: 'cristo',\n  load: () => 0,\n  name: 'Cristo inspired'," }],
  ['the credits notice dropped', { file: CREDITS, from: "notices: [{ title: 'MIT License (Solaris theme, kept in Cristotheme)', text: solarisLicense }],", to: 'notices: [],' }],
  ['the credits entry that ships files', { file: CREDITS, from: "reuse: { kind: 'Visual inspiration', detail: CRISTO.copied },\n    compatibility", to: "reuse: { kind: 'Bundled files', detail: CRISTO.copied },\n    compatibility" }],
  ['the credits entry without the compatibility statement', { file: CREDITS, from: '    compatibility: CRISTO_COMPATIBILITY,\n', to: '' }],
  ['the credits entry linked to the Solaris licence', { file: CREDITS, from: '`$' + '{CRISTO.repository}/blob/$' + '{CRISTO.revision}/CristoTheme/LICENSE`', to: '`$' + '{CRISTO.repository}/blob/$' + '{CRISTO.revision}/LICENSE`' }],
  ['the credits entry without the caveat', { file: CREDITS, from: ' No license covers the colours that Cristotheme and DeepBlue added to the Solaris theme, and none is claimed:', to: ' The notice is' }],
  ['the revision left out of the file', { file: FILE, from: "revision: ['text', LIMITS.source], revisionDate:", to: 'revisionDate:' }],
  ['an event colour group in the file format', { file: FILE, from: "washes: { sectionSoft: 'alpha', sectionTint: 'alpha', statusSoft: 'alpha' },\n}", to: "washes: { sectionSoft: 'alpha', sectionTint: 'alpha', statusSoft: 'alpha' },\n  events: { alert: 'hex' },\n}" }],
  ['the count of the research fields drawn in the status colour itself', { file: CONTRAST, from: 'kept.set(color, readableMix(appearance, color, (candidate) => backdrops.every((background) => ratio(candidate, background) >= TEXT)))', to: 'kept.set(color, color)' }],
  ['the text of a chosen list entry measured under Vuetify\'s strongest overlay', { file: CONTRAST, from: "const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : veil", to: "const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : VUETIFY_LIST_STATES[appearance.mode].pressed" }],
  ['the bar of a chosen list entry left out of the contrast measurement', { file: CONTRAST, from: 'LIST_BAR_OVERLAYS.forEach(([name, overlayPath]) => {', to: ';[].forEach(([name, overlayPath]) => {' }],
]

const mutatedCopy = ({ file, from, to }) => plantedCopy(utilitiesDirectory, 'ae-cristo-mutant-', file, from, to)

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

// A planted fault is judged only when it applies exactly once, the source it leaves parses and the modules it leaves still load: a fault that breaks the syntax of a module (one the checks load or not) or whose anchor matches nothing makes the checks throw, and a thrown check counts as failed, so such a fault would be reported as caught without any check having looked at what it was meant to plant. It is reported as invalid instead, and fails the run.
const judge = async (fault) => {
  let directory

  try {
    try {
      directory = mutatedCopy(fault)
      await load(directory)
    } catch (error) {
      return { invalid: error.message }
    }

    return { failed: (await runChecks(directory)).map(([, result], index) => [index + 1, result]).filter(([, result]) => result !== true).map(([index]) => index) }
  } catch (error) {
    return { error: error.message }
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
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

  console.log('Cristo inspired preset')

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
