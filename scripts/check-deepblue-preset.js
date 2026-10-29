#!/usr/bin/env node
/*
  The DeepBlue inspired preset (src/renderer/utilities/appearance.js: `DEEPBLUE`; credits.js: the `deepblue-theme` entry), checked without a browser.

  It proves: the preset names the archive of the community theme it adapts (identified by its SHA-256, the only version statement the theme has), its lineage (a Solaris theme base) and the licence position (no grant for the colours the DeepBlue author added, none claimed); the colour values the archive inventoried are the ones the preset maps, each to the roles it says, and the toolbar tint is carried by the rail, footer and cards in its own hue; the planet green, which is 2.10:1 on the page, is replaced by a lighter one of the same hue that is 3:1 or more on every surface and the sky, and the replacement and the original are both on the record; the orbit line is the one the sources agree on, and the map text is the archive's, with the other distribution's value recorded and not used; the preview differs from the Solaris preview where the source says it does (the window, text, map text, button fill, orbit, rail and cards, each by at least the least distance, and fewer than half of the file format's colours the same); the colours Cristotheme took from this theme are shared and the rest are not; nothing but colour values is taken (no icon, event-colour file, compiled file, archive, screenshot or font file in the tree, no entry that ships a file, no patch library among the dependencies, the preset plain data); the credits entry carries the archive hash, the retained notice, the reuse kind and the caveat, and reads like the Cristo entry; the wording keeps off the names the repository does not use, off the first and second person and off gendered pronouns; the readability matrix (every measurement of the contrast gate, in the three accent modes) passes; the file of the preset round trips with its provenance; and the preset is previewed, kept, restarted and combined with each accent mode.

  What a browser shows (the preset card, the reference panel, the credits row and the rail, tabs and breadcrumb in each accent mode, at three sizes) is probed separately with Playwright; the run is recorded in docs/plans/backlog/evidence/AE-008-02.md. The full gate (the compiled stylesheet, the colour-vision simulation, the map menu) is scripts/check-contrast.js --preset deepblue.

  Run: node scripts/check-deepblue-preset.js
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
// The colour values the DeepBlue theme's archive holds, as inventoried at its pinned revision (docs/plans/backlog/evidence/AE-008-01.md), and the roles of the preset each maps to.
const REVISION = '6e2ad38bf75a2b4b17cd9af57ba031b44ee30a5f222465befad693175c7a6614'
const CRISTO_REVISION = '4b30899b984c1dd1bb75d2bd7c17a994a1227bdb'
const SOLARIS_REVISION = '83aa53017754216367851620b4457284db654c15'
const THREAD = 'https://aurora2.pentarch.org/index.php?topic=12593.0'
const INVENTORY = [
  ['Window and map background', '#0d1729', ['surfaces.background', 'space.background']],
  ['Text', '#e8e4a8', ['inks.body', 'inks.text', 'inks.onTooltip']],
  ['Button fill', '#46435a', ['surfaces.track', 'focus.secondary']],
  ['Map text', '#eed8a4', ['space.label']],
  ['Orbit line', '#969696', ['space.bodyOrbit']],
  ['Active button border (derived)', '#6c688c', ['surfaces.border', 'charts.axis']],
]
const TINT = '#2b2937'
const TINT_PATHS = ['surfaces.chrome', 'surfaces.card']
const PLANET = '#005a00'
const SURFACE_PATHS = ['surfaces.background', 'surfaces.card', 'surfaces.chrome', 'space.background']

// How far the preset's pairs are from the Solaris preset's, as the distance in CIELAB (CIE 1976), and the least each must be; the source-backed differences of docs/plans/backlog/evidence/AE-008-01.md.
const DIFFERENCES = [
  ['the window colour', 'surfaces.background', 'surfaces.background', 10],
  ['the text colour', 'inks.body', 'inks.body', 20],
  ['the map text', 'space.label', 'space.label', 20],
  ['the button fill against the Solaris button fill', 'surfaces.track', 'surfaces.card', 15],
  ['the orbit line', 'space.bodyOrbit', 'space.bodyOrbit', 6],
  ['the rail and footer', 'surfaces.chrome', 'surfaces.chrome', 4],
  ['the cards', 'surfaces.card', 'surfaces.card', 4],
]

const deepblue = (ctx) => ctx.appearance.resolveAppearance('deepblue')

const entryOf = (ctx) => ctx.credits.CREDITS.find((credit) => credit.id === 'deepblue-theme')

// Every string of a value, notices excluded where the caller removed them.
const strings = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])

// The paths of what is not plain data (a function, an undefined member, a symbol) in a value.
const notData = (value, where = 'preset') => (value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => notData(inner, `${where}.${key}`)) : ['string', 'number', 'boolean'].includes(typeof value) || value === null ? [] : [`${where} is ${typeof value}`])

const FORBIDDEN = /AuroraPatch|Aurora Patch|ThemeCreator|Harmony/i
const FIRST_OR_SECOND_PERSON = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i
const GENDERED = /\b(he|him|his|she|her|hers)\b/i

// The distance of two colours in CIELAB (CIE 1976), worked out here from the hex digits.
const labOf = (color) => {
  const [r, g, b] = rgb(color).map((channel) => {
    const value = channel / 255

    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const curve = (value) => (value > 216 / 24389 ? Math.cbrt(value) : ((24389 / 27) * value + 16) / 116)
  const x = curve((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047)
  const y = curve(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = curve((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

const distanceOf = (a, b) => {
  const [first, second] = [labOf(a), labOf(b)]

  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
}

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

// Every colour the file format maps, as `group.role`, with the preset's value, hex digits only.
const colourPaths = (ctx, appearance) => Object.keys(ctx.file.ROLES).flatMap((group) => Object.keys(ctx.file.ROLES[group]).map((role) => `${group}.${role}`)).filter((dotted) => /^#[0-9a-f]{6}$/i.test(String(at(appearance, dotted))))

const CHECKS = [
  ['the preset is registered after the other adaptations, is dark, is versioned, and names the archive of the community theme it was read at, with its lineage and the licence position', async (ctx) => {
    const problems = []
    const ids = ctx.appearance.listAppearances().map(({ id }) => id)
    const appearance = deepblue(ctx)

    expectEqual(ids, ['light', 'dark', 'classic', 'solaris', 't2d', 'cristo', 'deepblue', 'browncoats-bunk'], 'the presets in order', problems)
    expectEqual([appearance.id, appearance.name, appearance.mode, appearance.key], ['deepblue', 'DeepBlue inspired', 'dark', 'deepblue@1'], 'the identity', problems)
    expectEqual(Number.isInteger(appearance.version) && appearance.version >= 1, true, 'the version is a positive integer', problems)

    const { source } = appearance.reference

    expectEqual([source.revision, source.repository, source.revisionDate], [REVISION, THREAD, '2021-06-02'], 'the pinned archive', problems)
    expectEqual(/^[0-9a-f]{64}$/.test(source.revision), true, 'the revision is the full SHA-256 of the archive', problems)
    expectEqual(['Jorgen_CAB', 'Simas Toleikis'].map((name) => source.author.includes(name)), [true, true], 'the author and the lineage author named', problems)
    expectEqual([/no license/i.test(source.license), /no grant/i.test(source.license), /MIT/.test(source.license), /^MIT License$/.test(source.license)], [true, true, true, false], 'the licence says none is stated, no grant covers the added colours, and the retained notice is the MIT one', problems)
    expectEqual([/archive/i.test(source.inspected), /1\.3\.0\.0/.test(source.inspected), /nothing was run/i.test(source.inspected)], [true, true, true], 'what was inspected and how', problems)
    expectEqual(/no source code, image, icon, font, event-colour file or compiled file/i.test(source.copied), true, 'what was not copied', problems)
    expectEqual([/#E7C77C/i.test(source.note), /#EED8A4/i.test(source.note)], [true, true], 'the note records the map text the two distributions disagree on', problems)

    expectEqual(ctx.appearance.resolveAppearance('solaris').reference.source.revision, SOLARIS_REVISION, 'the Solaris preset keeps its own revision', problems)
    expectEqual(ctx.appearance.resolveAppearance('cristo').reference.source.revision, CRISTO_REVISION, 'the Cristo preset keeps its own revision', problems)

    return verdict(problems)
  }],

  ['every inventoried colour value is in the preset at the roles it maps to, the reference lists each with its original value, and the toolbar tint is carried by the rail, footer and cards in its own hue', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)

    INVENTORY.forEach(([role, value, paths]) => {
      const listed = appearance.reference.roles.find((entry) => entry.role === role)

      expectEqual(listed && listed.value.toLowerCase(), value, `the reference role ${role}`, problems)
      paths.forEach((dotted) => {
        expectEqual(String(at(appearance, dotted)).toLowerCase(), value, `${dotted} for ${role}`, problems)
      })
    })

    const tint = appearance.reference.roles.find((entry) => entry.role === 'Toolbar tint')

    expectEqual(tint && tint.value.toLowerCase(), TINT, 'the reference role Toolbar tint', problems)
    TINT_PATHS.forEach((dotted) => {
      const value = at(appearance, dotted)

      expectEqual(Math.abs(hueOf(value) - hueOf(TINT)) <= 10 && distanceOf(value, TINT) <= 4 && luminanceOf(value) <= luminanceOf(TINT), true, `${dotted} ${value} is the toolbar tint ${TINT}, a little darker and of its hue`, problems)
    })
    expectEqual(appearance.reference.roles.length, INVENTORY.length + 2, 'the reference lists the inventoried roles, the tint and the planet fill, and no more', problems)

    return verdict(problems)
  }],

  ['the planet green is lighter in the preset, of the same hue and 3:1 or more on every surface and the sky where the original is under 3:1, and the original, the replacement and the reason are on the record', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)
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

    expectEqual([listed && listed.value.toLowerCase(), listed && listed.maps.toLowerCase().includes(substitute.toLowerCase()), listed && /2\.10:1/.test(listed.maps)], [PLANET, true, true], 'the reference role Planet fill', problems)
    expectEqual(appearance.reference.modifications.some((line) => /planet green/i.test(line) && /contrast/i.test(line)), true, 'the modifications say why', problems)
    expectEqual(/planet green/i.test(entryOf(ctx).modifications) && /lighter green/i.test(entryOf(ctx).modifications), true, 'the credits entry says it too', problems)

    return verdict(problems)
  }],

  ['the orbit line is the one the archive, the screenshot and the compiled patch agree on, 3:1 or more on the sky and none of the preset\'s other colours, and the map text is the archive\'s, with the disagreeing value recorded and not used', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)
    const orbit = appearance.space.bodyOrbit.toLowerCase()

    if (contrastOf(orbit, appearance.space.background) < 3) {
      problems.push(`the orbit ${orbit} on the sky is ${contrastOf(orbit, appearance.space.background).toFixed(2)}:1, under 3:1`)
    }

    expectEqual([orbit === appearance.survey.done.toLowerCase(), orbit === appearance.space.label.toLowerCase(), orbit === appearance.space.background.toLowerCase()], [false, false, false], 'the orbit is neither the planet colour, the label colour nor the sky', problems)
    expectEqual([appearance.space.label.toLowerCase(), JSON.stringify(strings(appearance)).toLowerCase().includes('#e7c77c')], ['#eed8a4', true], 'the map text is the archive\'s and the other distribution\'s value is only mentioned', problems)
    expectEqual(Object.keys(appearance).filter((group) => group !== 'reference' && JSON.stringify(appearance[group]).toLowerCase().includes('#e7c77c')), [], 'the other distribution\'s map text is in no colour group', problems)

    return verdict(problems)
  }],

  ['the preview differs from the Solaris preview where the source says it does: the window, the text, the map text, the button fill, the orbit and the rail and the cards each at least the least distance, and fewer than half of the file format\'s colours are the same', async (ctx) => {
    const problems = []
    const fresh = await ctx.reload()

    fresh.appearance.previewPreset('solaris')

    const solaris = JSON.parse(JSON.stringify(fresh.appearance.activeAppearance()))

    fresh.appearance.previewPreset('deepblue')

    const preview = JSON.parse(JSON.stringify(fresh.appearance.activeAppearance()))

    expectEqual([solaris.id, preview.id], ['solaris', 'deepblue'], 'the two previews', problems)
    DIFFERENCES.forEach(([label, ours, theirs, least]) => {
      const distance = distanceOf(at(preview, ours), at(solaris, theirs))

      if (distance < least) {
        problems.push(`${label}: ${at(preview, ours)} is ${distance.toFixed(1)} from the Solaris ${at(solaris, theirs)}, under ${least}`)
      }
    })
    expectEqual(Math.abs(contrastOf(preview.surfaces.track, preview.surfaces.background) - contrastOf(solaris.surfaces.card, solaris.surfaces.background)) >= 0.5, true, 'the button fill stands off the page by its own ratio, not the Solaris one', problems)

    const paths = colourPaths(ctx, preview)
    const same = paths.filter((dotted) => String(at(preview, dotted)).toLowerCase() === String(at(solaris, dotted)).toLowerCase())

    expectEqual(paths.length > 40, true, `the colours compared (${paths.length})`, problems)
    expectEqual(same.length < paths.length / 2, true, `the share of colours the same as Solaris's: ${same.length} of ${paths.length}`, problems)
    expectEqual(canonical(preview.surfaces) === canonical(solaris.surfaces) || canonical(preview.space) === canonical(solaris.space) || canonical(preview.inks) === canonical(solaris.inks), false, 'no colour group is the Solaris group', problems)
    expectEqual(deepblue(ctx).reference.title !== ctx.appearance.resolveAppearance('solaris').reference.title && deepblue(ctx).name !== 'Solaris inspired', true, 'the preview has its own title and name', problems)

    fresh.appearance.cancelPreview()

    return verdict(problems)
  }],

  ['the lineage is honest: the window and the map text are the ones Cristotheme took from this theme, and the text, the button fill, the orbit and the surfaces are not Cristotheme\'s', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)
    const cristo = ctx.appearance.resolveAppearance('cristo')

    expectEqual([appearance.surfaces.background === cristo.surfaces.background, appearance.space.label === cristo.space.label], [true, true], 'the shared window and map text', problems)
    expectEqual([appearance.inks.body === cristo.inks.body, appearance.surfaces.card === cristo.surfaces.card, appearance.surfaces.track === cristo.surfaces.track, appearance.space.bodyOrbit === cristo.space.bodyOrbit], [false, false, false, false], 'the text, the cards, the button fill and the orbit differ', problems)
    expectEqual(/DeepBlue/.test(cristo.reference.source.author) && /Cristotheme/.test(appearance.reference.source.note), true, 'each preset names the other\'s link', problems)

    return verdict(problems)
  }],

  ['nothing but colour values is taken: no icon, event-colour file, compiled file, archive, screenshot or font in the tree, no entry that ships a file, no patch library among the dependencies, and the preset is plain data', async (ctx) => {
    const problems = []
    const names = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))].map((file) => path.relative(root, file).replace(/\\/g, '/'))

    names.filter((name) => /\.(dll|exe|csv|zip|7z|rar)$/i.test(name) || /deepblue.*\.(png|jpe?g|gif|ttf|otf|woff2?)$/i.test(name) || /(^|\/)Icon_[^/]*\.png$/i.test(name)).forEach((name) => {
      problems.push(`${name} is a file the preset does not take`)
    })
    expectEqual(fs.readdirSync(path.join(utilitiesDirectory, 'notices')).filter((name) => !name.endsWith('.txt')), [], 'the notices are text files', problems)
    expectEqual(fs.readdirSync(path.join(utilitiesDirectory, 'notices')).filter((name) => /deepblue/i.test(name)), [], 'the retained notice is the Solaris one, with no copy of its own', problems)

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })

    expectEqual(dependencies.filter((name) => /aurorapatch|harmony|themecreator|deepblue|cristo/i.test(name)), [], 'dependencies that load a patch or a theme', problems)

    const entry = entryOf(ctx)

    expectEqual(entry && [entry.reuse.kind, entry.kind], ['Visual inspiration', 'Colour reference'], 'the credits entry ships nothing', problems)
    expectEqual(ctx.credits.CREDITS.filter((credit) => credit.reuse.kind === 'Bundled files').map(({ id }) => id), ['roboto', 'mdi'], 'the entries that ship files', problems)
    expectEqual(notData(ctx.appearance.PRESETS.deepblue), [], 'the members of the preset that are not plain data', problems)
    expectEqual(deepblue(ctx).reference.source.copied.toLowerCase().includes('icon') && deepblue(ctx).reference.source.copied.toLowerCase().includes('font'), true, 'the reference says icons and fonts are not used', problems)
    expectEqual(deepblue(ctx).reference.compatibility, undefined, 'the theme has no event-colour file, so the reference has no compatibility note', problems)

    return verdict(problems)
  }],

  ['the wording keeps off the names the repository does not use, off the first and second person and off gendered pronouns, in the preset\'s reference, the credits entry and the exported file', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)
    const entry = entryOf(ctx)
    const exported = JSON.stringify(ctx.appearance.exportAppearanceFile('deepblue', 1000))
    const { notices, ...prose } = entry
    const texts = [...strings(appearance.reference), ...strings(prose), exported]

    texts.forEach((text) => {
      const forbidden = FORBIDDEN.exec(text)
      const person = FIRST_OR_SECOND_PERSON.exec(text) || GENDERED.exec(text)

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

  ['the credits entry carries the archive and its link, the retained Solaris notice, the visual-inspiration reuse and the caveat, and the Cristo and DeepBlue entries read alike', async (ctx) => {
    const problems = []
    const entry = entryOf(ctx)

    if (!entry) {
      return 'there is no credits entry with the id deepblue-theme'
    }

    const cristoEntry = ctx.credits.CREDITS.find((credit) => credit.id === 'cristo-theme')

    expectEqual([entry.name, entry.author, entry.kind], ['DeepBlue theme', deepblue(ctx).reference.source.author, 'Colour reference'], 'the name, author and kind', problems)
    expectEqual([entry.source.label.includes(REVISION.slice(0, 7)), entry.source.label.includes('2021-06-02'), /^https:\/\/web\.archive\.org\/web\/\d{14}\/http:\/\/aurora2\.pentarch\.org\/index\.php\?topic=12593\.0$/.test(entry.source.href)], [true, true, true], 'the source', problems)
    expectEqual(entry.license.href, `https://github.com/CountCristo/Cristotheme/blob/${CRISTO_REVISION}/Unaltered%20base%20files/Deepblue/Resource/LICENSE`, 'the licence link', problems)
    expectEqual([/no license/i.test(entry.license.label), /no grant/i.test(entry.license.label), /no license covers/i.test(entry.modifications), /none is claimed/i.test(entry.modifications)], [true, true, true, true], 'the caveat in the entry', problems)
    expectEqual(entry.notices.map((item) => item.text), [NOTICE], 'the notice is the Solaris theme\'s MIT License as the archive keeps it', problems)
    expectEqual(/MIT License/.test(NOTICE) && /Simas Toleikis/.test(NOTICE), true, 'the notice file is the MIT License of the Solaris author', problems)
    expectEqual(entry.reuse.detail, deepblue(ctx).reference.source.copied, 'the reuse detail is the preset\'s own statement', problems)
    expectEqual(entry.compatibility, undefined, 'the entry has no compatibility note', problems)
    expectEqual(ctx.credits.CREDITS.filter((credit) => credit.compatibility).map(({ id }) => id), ['cristo-theme'], 'only the Cristo entry has a compatibility note', problems)
    expectEqual(new Set(ctx.credits.CREDITS.map(({ id }) => id)).size, ctx.credits.CREDITS.length, 'the entries have distinct ids', problems)
    expectEqual(ctx.credits.CREDITS.find(({ id }) => id === 'solaris-theme').source.href.includes(SOLARIS_REVISION), true, 'the Solaris entry keeps its revision', problems)
    expectEqual([entry.license.label.startsWith('No license of its own; it keeps the Solaris theme\'s MIT License'), cristoEntry.license.label.startsWith('No license of its own; it keeps the Solaris theme\'s MIT License')], [true, true], 'both licence labels keep the same position', problems)
    expectEqual(ctx.credits.CREDITS.findIndex(({ id }) => id === 'solaris-theme') < ctx.credits.CREDITS.findIndex(({ id }) => id === 'deepblue-theme') && ctx.credits.CREDITS.findIndex(({ id }) => id === 'deepblue-theme') < ctx.credits.CREDITS.findIndex(({ id }) => id === 'cristo-theme'), true, 'the entry stands after the Solaris theme it is built on and before the Cristo theme that reuses it', problems)

    return verdict(problems)
  }],

  ['the readability matrix passes in the on, restrained and off accent modes: every measurement of the contrast report, the nine accents and the neutral one as graphics (on the bare surfaces, on their own active and hover washes, on the icon plates over them, in a hovered table row and under the overlay of a list entry) and as text, the page\'s text on those washes, and the report has no blocking finding', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)
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
    const readableCount = ctx.contrast.readableWashText(appearance, appearance.charts.categorical[2])

    expectEqual([counts.length > 0, counts.every((row) => row.pass), counts.every((row) => row.foreground === readableCount)], [true, true, true], `the count of the research fields is drawn in ${readableCount} and reads on every wash`, problems)
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

  ['the file of the preset round trips with its provenance: the roles are the same, the origin is the built-in preset at its version, the reference carries the archive hash, and the draft passes the contrast gate', async (ctx) => {
    const problems = []
    const appearance = deepblue(ctx)
    const exported = ctx.appearance.exportAppearanceFile('deepblue', 1000)

    expectEqual([exported.provenance.origin.kind, exported.provenance.origin.id, exported.provenance.origin.version, exported.mode], ['built-in', 'deepblue', appearance.version, 'dark'], 'the origin', problems)
    expectEqual([exported.provenance.reference.source.revision, exported.provenance.reference.source.repository, exported.provenance.reference.title], [REVISION, THREAD, appearance.reference.title], 'the reference carried by the file', problems)
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
      fresh.appearance.previewPreset('deepblue')
      expectEqual([fresh.appearance.activeAppearance().id, fresh.appearance.isPreviewing(), fresh.appearance.accentMode(), config.data.appearance], ['deepblue', true, mode, undefined], `${mode}: the preview`, problems)

      fresh.appearance.cancelPreview()
      expectEqual([fresh.appearance.activeAppearance().id, fresh.appearance.isPreviewing()], ['light', false], `${mode}: the cancelled preview`, problems)
      expectEqual(fresh.appearance.applyPreset(config, 'deepblue'), true, `${mode}: kept`, problems)
      expectEqual([config.data.appearance, config.data.appearanceAccents, fresh.appearance.activeAppearance().key], ['deepblue', mode, 'deepblue@1'], `${mode}: the settings`, problems)

      const again = await ctx.reload()

      again.appearance.loadAppearance(fakeConfig(config.data))
      expectEqual([again.appearance.activeAppearance().id, again.appearance.appliedPresetId(), again.appearance.accentMode()], ['deepblue', 'deepblue', mode], `${mode}: after a restart`, problems)
      expectEqual(again.appearance.unsupportedPresetId(fakeConfig(config.data)), null, `${mode}: the stored id is supported`, problems)
    }

    return verdict(problems)
  }],
]

const CONTRAST = 'appearance-contrast.js'
const APPEARANCE = 'appearance.js'
const FILE = 'appearance-file.js'
const CREDITS = 'credits.js'

const ACCENTS = ['#6fa8ff', '#ff9a66', '#3fd0a0', '#e6b422', '#ff8fb8', '#7fd13b', '#b6a6ff', '#ff8585', '#4fd8e8']
const sectionsOf = (neutral, accents) => `sections: { neutral: '${neutral}', accents: [${accents.map((color) => `'${color}'`).join(', ')}] }`
const SOLARIS_LICENCE_CLAIM = "license: 'MIT License'"

const MUTATIONS = [
  ['the planet green kept as the reference gives it', { file: APPEARANCE, from: "survey: { done: '#008f00' }", to: "survey: { done: '#005a00' }" }],
  ['a planet green lightened to another hue', { file: APPEARANCE, from: "survey: { done: '#008f00' }", to: "survey: { done: '#8f008f' }" }],
  ['a planet green still under 3:1 on the card', { file: APPEARANCE, from: "survey: { done: '#008f00' }", to: "survey: { done: '#006400' }" }],
  ['the orbit of the Solaris preset', { file: APPEARANCE, from: "bodyOrbit: '#969696'", to: "bodyOrbit: '#808080'" }],
  ['an orbit the colour of the sky', { file: APPEARANCE, from: "bodyOrbit: '#969696'", to: "bodyOrbit: '#0d1729'" }],
  ['an orbit that is the planet colour', { file: APPEARANCE, from: "bodyOrbit: '#969696'", to: "bodyOrbit: '#008f00'" }],
  ['the window colour of the Solaris preset', { file: APPEARANCE, from: "surfaces: { background: '#0d1729', chrome: '#282632'", to: "surfaces: { background: '#0c0c0c', chrome: '#282632'" }],
  ['the map text of the other distribution', { file: APPEARANCE, from: "label: '#eed8a4', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#969696'", to: "label: '#e7c77c', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#969696'" }],
  ['the map text left as the Solaris text', { file: APPEARANCE, from: "label: '#eed8a4', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#969696'", to: "label: '#d2d2d2', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#969696'" }],
  ['the text colour of the Solaris preset', { file: APPEARANCE, from: "inks: { body: '#e8e4a8', muted: '#cfcb9a', text: '#e8e4a8'", to: "inks: { body: '#d2d2d2', muted: '#cfcb9a', text: '#e8e4a8'" }],
  ['the text colour changed', { file: APPEARANCE, from: "inks: { body: '#e8e4a8', muted: '#cfcb9a', text: '#e8e4a8'", to: "inks: { body: '#e8e4a0', muted: '#cfcb9a', text: '#e8e4a8'" }],
  ['the button fill of the Solaris preset', { file: APPEARANCE, from: "track: '#46435a', trackSoft", to: "track: '#171a27', trackSoft" }],
  ['the secondary colour of the Solaris preset', { file: APPEARANCE, from: "secondary: '#46435a'", to: "secondary: '#2b3045'" }],
  ['the border not the derived one', { file: APPEARANCE, from: "card: '#262431', border: '#6c688c'", to: "card: '#262431', border: '#2f3449'" }],
  ['a rail and cards that are the Solaris surfaces', { file: APPEARANCE, from: "chrome: '#282632', card: '#262431'", to: "chrome: '#171a27', card: '#171a27'" }],
  ['a card the colour of the page', { file: APPEARANCE, from: "chrome: '#282632', card: '#262431'", to: "chrome: '#282632', card: '#0d1729'" }],
  ['a rail and cards far lighter than the toolbar tint', { file: APPEARANCE, from: "chrome: '#282632', card: '#262431'", to: "chrome: '#46435a', card: '#46435a'" }],
  ['a secondary ink the colour of the card', { file: APPEARANCE, from: "muted: '#cfcb9a', text: '#e8e4a8', textMuted: '#cfcb9a'", to: "muted: '#262431', text: '#e8e4a8', textMuted: '#cfcb9a'" }],
  ['a neutral accent the colour of the card', { file: APPEARANCE, from: sectionsOf('#b4b2cf', ACCENTS), to: sectionsOf('#262431', ACCENTS) }],
  ['a section accent the colour of the card', { file: APPEARANCE, from: sectionsOf('#b4b2cf', ACCENTS), to: sectionsOf('#b4b2cf', [...ACCENTS.slice(0, 8), '#262431']) }],
  ['a repeated section accent', { file: APPEARANCE, from: sectionsOf('#b4b2cf', ACCENTS), to: sectionsOf('#b4b2cf', [...ACCENTS.slice(0, 8), ACCENTS[0]]) }],
  ['an active wash so strong that the accents do not read on it', { file: APPEARANCE, from: 'washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },\n}\n\nconst DARK = {', to: 'washes: { sectionSoft: 0.9, sectionTint: 0.12, statusSoft: 0.28 },\n}\n\nconst DARK = {' }],
  ['a Research accent that reads on each wash alone and not on the icon plate over the active entry', { file: APPEARANCE, from: sectionsOf('#b4b2cf', ACCENTS), to: sectionsOf('#b4b2cf', ACCENTS.map((color, index) => (index === 5 ? '#5d9f25' : color))) }],
  ['an on-colour ink that is white on the light fills', { file: APPEARANCE, from: "onFill: '#0d1729', onColor: '#0d1729', onSnackbar: '#0d1729' },\n  focus: { primary: '#b8a9ff'", to: "onFill: '#0d1729', onColor: '#ffffff', onSnackbar: '#ffffff' },\n  focus: { primary: '#b8a9ff'" }],
  ['the Cristo revision in place of the archive hash', { file: APPEARANCE, from: "revision: '6e2ad38bf75a2b4b17cd9af57ba031b44ee30a5f222465befad693175c7a6614'", to: "revision: '4b30899b984c1dd1bb75d2bd7c17a994a1227bdb'" }],
  ['a licence claimed for every colour', { file: APPEARANCE, from: "license: 'No license of its own; it keeps the Solaris theme\\'s MIT License, and no grant covers the colours added by DeepBlue'", to: SOLARIS_LICENCE_CLAIM }],
  ['the lineage author dropped', { file: APPEARANCE, from: "author: 'Jorgen_CAB, after the Solaris theme of Simas Toleikis'", to: "author: 'Jorgen_CAB'" }],
  ['an event-colour compatibility note on the reference', { file: APPEARANCE, from: "    title: 'Deep navy with violet-grey plates',", to: "    title: 'Deep navy with violet-grey plates',\n    compatibility: { title: 'Event-colour compatibility', status: 'Not included', text: 'x' }," }],
  ['an undefined member in the preset', { file: APPEARANCE, from: "  id: 'deepblue',\n  name: 'DeepBlue inspired',", to: "  id: 'deepblue',\n  unset: undefined,\n  name: 'DeepBlue inspired'," }],
  ['a preset that carries a function', { file: APPEARANCE, from: "  id: 'deepblue',\n  name: 'DeepBlue inspired',", to: "  id: 'deepblue',\n  load: () => 0,\n  name: 'DeepBlue inspired'," }],
  ['a patch library named in the preset text', { file: APPEARANCE, from: 'The thread no longer answers at its own address', to: 'It is applied with AuroraPatch. The thread no longer answers at its own address' }],
  ['the first person in the preset text', { file: APPEARANCE, from: "the app's owner accepted that no explicit grant covers them", to: 'we accepted that no explicit grant covers them' }],
  ['a gendered pronoun for the author in the preset text', { file: APPEARANCE, from: 'The author states no license for the colours chosen', to: 'The author states no license for his colours' }],
  ['the version of the preset lowered', { file: APPEARANCE, from: "id: 'deepblue',\n  name: 'DeepBlue inspired',\n  version: 1,", to: "id: 'deepblue',\n  name: 'DeepBlue inspired',\n  version: 0," }],
  ['the preset left out of the list', { file: APPEARANCE, from: 'export const listAppearances = () => Object.keys(PRESETS).map((id) => resolveAppearance(id))', to: "export const listAppearances = () => Object.keys(PRESETS).filter((id) => id !== 'deepblue').map((id) => resolveAppearance(id))" }],
  ['the preset listed before the others', { file: APPEARANCE, from: 'export const PRESETS = { [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [CRISTO.id]: CRISTO, [DEEPBLUE.id]: DEEPBLUE, [BROWNCOATS_BUNK.id]: BROWNCOATS_BUNK }', to: 'export const PRESETS = { [DEEPBLUE.id]: DEEPBLUE, [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [CRISTO.id]: CRISTO, [BROWNCOATS_BUNK.id]: BROWNCOATS_BUNK }' }],
  ['the credits notice dropped', { file: CREDITS, from: "notices: [{ title: 'MIT License (Solaris theme, kept in the DeepBlue theme)', text: solarisLicense }],", to: 'notices: [],' }],
  ['the credits entry that ships files', { file: CREDITS, from: 'reuse: { kind: \'Visual inspiration\', detail: DEEPBLUE.copied },', to: 'reuse: { kind: \'Bundled files\', detail: DEEPBLUE.copied },' }],
  ['the credits entry with an event-colour compatibility note', { file: CREDITS, from: 'reuse: { kind: \'Visual inspiration\', detail: DEEPBLUE.copied },', to: 'reuse: { kind: \'Visual inspiration\', detail: DEEPBLUE.copied },\n    compatibility: CRISTO_COMPATIBILITY,' }],
  ['the credits entry linked to a licence of another folder', { file: CREDITS, from: 'Unaltered%20base%20files/Deepblue/Resource/LICENSE', to: 'Unaltered%20base%20files/SolarisTheme/LICENSE' }],
  ['the credits entry showing the Cristo revision', { file: CREDITS, from: '`DeepBlue theme archive $' + '{DEEPBLUE.revision.slice(0, 7)}', to: '`DeepBlue theme archive $' + '{CRISTO.revision.slice(0, 7)}' }],
  ['the credits entry without the caveat', { file: CREDITS, from: ' No license covers the colours that DeepBlue added to the Solaris theme, and none is claimed: the notice is the one the archive keeps.', to: ' The notice is the one the archive keeps.' }],
  ['the credits entry under another id', { file: CREDITS, from: "id: 'deepblue-theme',", to: "id: 'deepblue'," }],
  ['the revision left out of the file', { file: FILE, from: "revision: ['text', LIMITS.source], revisionDate:", to: 'revisionDate:' }],
  ['the text of a chosen list entry measured under Vuetify\'s strongest overlay', { file: CONTRAST, from: "const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : veil", to: "const opacity = overlay === 'hover' ? LIST_VEIL[appearance.mode] : VUETIFY_LIST_STATES[appearance.mode].pressed" }],
  ['the bar of a chosen list entry left out of the contrast measurement', { file: CONTRAST, from: 'LIST_BAR_OVERLAYS.forEach(([name, overlayPath]) => {', to: ';[].forEach(([name, overlayPath]) => {' }],
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

  console.log('DeepBlue inspired preset')

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
