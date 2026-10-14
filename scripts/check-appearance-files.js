/*
  Checks the portable appearance file (src/renderer/utilities/appearance-file.js, and its use by appearance.js).

  node scripts/check-appearance-files.js

  It proves, without a browser: the table of roles is the roles of the five presets, each with the kind of value the presets use; every preset exports, reads back and exports again with its roles, name, mode, base, font and reference unchanged and no default used and no contrast finding; the three kinds of failure (an unsupported version, a malformed field, an unknown role) are told apart, a version failure comes alone, the unknown names `__proto__` and `constructor` are unknown, and the sizes are bounded (the text, each string, the failures kept); a partial file lists exactly the roles it left out with the base's value and says which base it used; a body ink the colour of the page, an unreadable text ink and an unsupported font are explained before anything is applied; a file that fails changes nothing, a draft writes nothing, Apply writes the document and the choice in one assignment of the store or not at all, and a fresh start reads the kept file back; a stored file that no longer passes is reported and left as it is; and the files the feature is made of name no game format. Then each of the mutations below, one fault planted in a copy of the sources, must make at least one check fail, so that the checks cannot pass by checking nothing. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { plantedCopy } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)
const IDS = ['light', 'dark', 'classic', 'solaris', 't2d']

let instance = 0

// The three modules in a copy of their own (`fresh` loads another from the same folder, for a start of the app after this one), so that each check starts with no draft, no kept file and the default preset applied. The stub of Vue differs by a comment, which gives appearance.js another source and so another module.
const load = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(['appearance', 'appearance-file', 'appearance-contrast'], { directory, stubs: { vue: `export default { observable: (value) => value, set: (target, key, value) => { target[key] = value }, delete: (target, key) => { delete target[key] } }\n// instance ${instance++}` } })

  return { appearance: loaded.appearance, file: loaded['appearance-file'], contrast: loaded['appearance-contrast'], fresh: () => load(directory) }
}

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 220 ? `${text.slice(0, 220)}…` : text
}

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected) || `${short(actual)} != ${short(expected)}`

const rolesOf = ({ file }, appearance) => Object.fromEntries(Object.entries(file.ROLES).map(([group, keys]) => [group, Object.fromEntries(Object.keys(keys).filter((key) => appearance[group][key] !== undefined).map((key) => [key, appearance[group][key]]))]))

const builtIn = ({ appearance }) => (id) => (Object.prototype.hasOwnProperty.call(appearance.PRESETS, id) ? appearance.resolveAppearance(id) : null)

const BASELINES = { light: 'light', dark: 'dark' }

const parse = (ctx, value) => ctx.file.parseAppearanceFile(typeof value === 'string' ? value : JSON.stringify(value), { builtIn: builtIn(ctx), baselines: BASELINES })

const document = (patch = {}) => ({ format: 'aurora-electrons-appearance', version: 1, name: 'Check', mode: 'dark', ...patch })

// A settings store that counts how it is written: `writes` lists each assignment of the store and each set, `failNext` makes the next write throw, as a full disk would.
const fakeConfig = (initial = {}) => {
  const config = {
    data: { ...initial },
    writes: [],
    failNext: false,
    get store() {
      return this.data
    },
    update(change) {
      this.store = change(JSON.parse(JSON.stringify(this.data)))
    },
    set store(value) {
      this.writes.push({ via: 'store', keys: Object.keys(value) })

      if (this.failNext) {
        this.failNext = false
        throw new Error('the disk is full')
      }

      this.data = JSON.parse(JSON.stringify(value))
    },
    get(key) {
      return this.data[key]
    },
    set(key, value) {
      this.writes.push({ via: 'set', keys: [key] })

      if (this.failNext) {
        this.failNext = false
        throw new Error('the disk is full')
      }

      this.data = { ...this.data, [key]: JSON.parse(JSON.stringify(value)) }
    },
  }

  return config
}

const kindsOf = (result) => [...new Set(result.errors.map((error) => error.kind))].join()

const fieldsOf = (result) => result.errors.map((error) => `${error.kind}:${error.field}`)

const SCANNED = ['src/renderer/utilities/appearance-file.js', 'src/renderer/utilities/appearance-contrast.js', 'src/renderer/utilities/appearance.js', 'src/renderer/pages/settings.vue', 'src/renderer/components/settings/AppearanceFile.vue']

const CHECKS = [
  ['the roles of the table are the roles of the five presets, each with the kind of value the presets use', (ctx) => {
    const { ROLES, ROLE_PATHS } = ctx.file
    const meta = ['id', 'name', 'version', 'key', 'mode', 'reference', 'file']
    const leaves = new Set()
    const values = {}

    for (const id of IDS) {
      const resolved = ctx.appearance.resolveAppearance(id)

      Object.keys(resolved).filter((key) => !meta.includes(key)).forEach((group) => {
        if (!ROLES[group]) {
          leaves.add(`${group}.*`)
        }

        Object.entries(resolved[group]).forEach(([key, value]) => {
          const role = `${group}.${key}`

          leaves.add(role)
          ;(values[role] = values[role] || []).push(value)
        })
      })
    }

    const missing = [...leaves].filter((leaf) => !ROLE_PATHS.includes(leaf))
    const unused = ROLE_PATHS.filter((role) => !leaves.has(role))

    if (missing.length || unused.length) {
      return `not in the table: ${missing.join(', ')}; in the table, in no preset: ${unused.join(', ')}`
    }

    const hexOnly = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    const wrong = ROLE_PATHS.filter((role) => {
      const [group, key] = role.split('.')
      const kind = ROLES[group][key]
      const list = values[role]

      if (kind === 'hex') {
        return !list.every(hexOnly)
      }

      if (kind === 'color') {
        return list.every(hexOnly)
      }

      if (kind === 'alpha') {
        return !list.every((value) => typeof value === 'number')
      }

      if (kind === 'list') {
        return !list.every((value) => Array.isArray(value) && value.length === 9 && value.every(hexOnly))
      }

      return kind !== 'line'
    })

    return wrong.length ? `a kind that the presets do not use: ${wrong.join(', ')}` : true
  }],

  ['every preset exports and reads back with its roles, name, mode, base, font and reference, no default and no contrast finding, and exports again the same', (ctx) => {
    for (const id of IDS) {
      const original = ctx.appearance.resolveAppearance(id)
      const exported = ctx.appearance.exportAppearanceFile(id, NOW)
      const result = ctx.appearance.importAppearanceFile(JSON.stringify(exported))

      if (!result.ok) {
        return `${id}: ${short(result.errors[0])}`
      }

      const read = result.entry.appearance
      const reference = original.reference ? { title: original.reference.title, source: Object.fromEntries(['name', 'author', 'repository', 'revision', 'revisionDate', 'license'].map((key) => [key, original.reference.source[key]])) } : undefined
      const problems = [
        same(rolesOf(ctx, read), rolesOf(ctx, original)),
        same([read.name, read.mode, read.file.base, read.file.font, read.file.defaults.length], [original.name, original.mode, { id, explicit: true }, { family: 'Roboto', explicit: true, supported: true, choice: 'roboto' }, 0]),
        same(read.file.provenance.reference, reference),
        same(read.file.provenance.origin, { kind: 'built-in', id, name: original.name, version: original.version }),
        same(result.entry.report.findings.length, 0),
      ].filter((problem) => problem !== true)

      if (problems.length) {
        return `${id}: ${problems.join('; ')}`
      }

      const again = ctx.appearance.exportAppearanceFile('custom-draft', NOW + 1000)
      const differences = [
        same(again.roles, exported.roles),
        same([again.name, again.mode, again.base, again.font, again.provenance.reference], [exported.name, exported.mode, exported.base, exported.font, exported.provenance.reference]),
        same(again.provenance.origin.kind, 'imported'),
      ].filter((problem) => problem !== true)

      if (differences.length) {
        return `${id}, exported again: ${differences.join('; ')}`
      }

      ctx.appearance.cancelPreview()
    }

    return true
  }],

  ['the preset roles and the supported appearance values are in the file, with provenance naming the app, the time and the origin', (ctx) => {
    const exported = ctx.appearance.exportAppearanceFile('solaris', NOW)

    return same([exported.format, exported.version, exported.provenance.app, exported.provenance.exportedAt, exported.provenance.origin.kind, Object.keys(exported.roles).length, exported.roles.charts.categorical.length], ['aurora-electrons-appearance', 1, 'Aurora Electrons', '2026-10-13T12:00:00.000Z', 'built-in', 15, 9])
  }],

  ['a version other than 1 is the one failure of kind version, however much else is wrong', (ctx) => {
    for (const version of [2, 0, '1', 1.5, null, 99, [1], {}]) {
      const result = parse(ctx, document({ version, name: 5, roles: { surfaces: { background: 'red' }, nope: {} } }))

      if (result.ok || result.errors.length !== 1 || result.errors[0].kind !== 'version' || result.errors[0].field !== 'version') {
        return `version ${short(version)}: ${short(result.errors)}`
      }
    }

    const missing = document()

    delete missing.version

    const result = parse(ctx, missing)

    if (result.ok || result.errors.length !== 1 || result.errors[0].kind !== 'version') {
      return `no version: ${short(result.errors)}`
    }

    const newer = parse(ctx, document({ version: 2 }))

    return /newer/.test(newer.errors[0].message) && !/newer/.test(parse(ctx, document({ version: 0 })).errors[0].message) ? true : 'the message does not tell a newer version from an unreadable one'
  }],

  ['a file of another format, text that is not JSON and a value that is not an object are failures of the file and not roles', (ctx) => {
    const cases = [['{"format":"other","version":1}', 'field:format'], ['{"version":1}', 'field:format'], ['not json', 'field:file'], ['', 'field:file'], ['[]', 'field:file'], ['null', 'field:file'], ['42', 'field:file'], ['"text"', 'field:file']]

    for (const [text, expected] of cases) {
      const result = parse(ctx, text)

      if (result.ok || same(fieldsOf(result), [expected]) !== true) {
        return `${short(text)}: ${short(fieldsOf(result))}`
      }
    }

    return true
  }],

  ['a malformed member is a failure of kind field on the path of the member, and nothing else is said about it', (ctx) => {
    const categorical = ctx.appearance.resolveAppearance('dark').charts.categorical
    const duplicate = [...categorical]

    duplicate[3] = categorical[1].toUpperCase()

    const cases = [
      ['a colour name', { roles: { surfaces: { background: 'red' } } }, 'roles.surfaces.background'],
      ['a url', { roles: { surfaces: { background: 'url(https://example.test/a.png)' } } }, 'roles.surfaces.background'],
      ['a script url', { roles: { surfaces: { track: 'url(javascript:alert(1))' } } }, 'roles.surfaces.track'],
      ['a variable', { roles: { inks: { body: 'var(--x)' } } }, 'roles.inks.body'],
      ['a short hex', { roles: { inks: { body: '#fff' } } }, 'roles.inks.body'],
      ['a hex with an alpha where only a plain colour is read', { roles: { inks: { body: '#ffffff80' } } }, 'roles.inks.body'],
      ['a number as a colour', { roles: { inks: { body: 123 } } }, 'roles.inks.body'],
      ['null as a colour', { roles: { inks: { body: null } } }, 'roles.inks.body'],
      ['a channel above 255', { roles: { surfaces: { track: 'rgb(300, 0, 0)' } } }, 'roles.surfaces.track'],
      ['an alpha above 1', { roles: { surfaces: { track: 'rgba(0, 0, 0, 2)' } } }, 'roles.surfaces.track'],
      ['a function that is not a colour', { roles: { surfaces: { track: 'calc(1 + 1)' } } }, 'roles.surfaces.track'],
      ['a colour that is too long', { roles: { surfaces: { track: `rgba(0, 0, 0, ${'0'.repeat(80)})` } } }, 'roles.surfaces.track'],
      ['a wash above 1', { roles: { washes: { sectionSoft: 1.5 } } }, 'roles.washes.sectionSoft'],
      ['a wash below 0', { roles: { washes: { sectionSoft: -0.1 } } }, 'roles.washes.sectionSoft'],
      ['a wash that is text', { roles: { washes: { sectionSoft: '0.5' } } }, 'roles.washes.sectionSoft'],
      ['eight categorical colours', { roles: { charts: { categorical: categorical.slice(0, 8) } } }, 'roles.charts.categorical'],
      ['ten categorical colours', { roles: { charts: { categorical: [...categorical, '#123456'] } } }, 'roles.charts.categorical'],
      ['a categorical colour that is not a colour', { roles: { charts: { categorical: categorical.map((color, slot) => (slot === 4 ? 'blue' : color)) } } }, 'roles.charts.categorical[4]'],
      ['a categorical colour repeated in another case', { roles: { charts: { categorical: duplicate } } }, 'roles.charts.categorical[3]'],
      ['a link line that is not underline', { roles: { focus: { linkLine: 'wavy' } } }, 'roles.focus.linkLine'],
      ['a role group that is not an object', { roles: { surfaces: 'x' } }, 'roles.surfaces'],
      ['roles that are not an object', { roles: [] }, 'roles'],
      ['a name that is too long', { name: 'n'.repeat(61) }, 'name'],
      ['an empty name', { name: '  ' }, 'name'],
      ['a name that is a number', { name: 5 }, 'name'],
      ['a name with a control character', { name: 'a\u0007b' }, 'name'],
      ['a description that is too long', { description: 'd'.repeat(281) }, 'description'],
      ['an author that is too long', { author: 'a'.repeat(81) }, 'author'],
      ['a mode that is neither', { mode: 'sepia' }, 'mode'],
      ['no mode', { mode: undefined }, 'mode'],
      ['no name', { name: undefined }, 'name'],
      ['a member the format does not have', { css: 'body { color: red }' }, 'css'],
      ['a script member', { onload: 'alert(1)' }, 'onload'],
      ['a font family with CSS in it', { font: { family: 'Roboto; src: url(x)' } }, 'font.family'],
      ['a font that is not an object', { font: 'Roboto' }, 'font'],
      ['a font without a family', { font: {} }, 'font.family'],
      ['a font member the format does not have', { font: { family: 'Roboto', url: 'https://example.test/x.woff' } }, 'font.url'],
      ['a font family that is too long', { font: { family: 'F'.repeat(61) } }, 'font.family'],
      ['a provenance member the format does not have', { provenance: { script: 'x' } }, 'provenance.script'],
      ['a provenance that is not an object', { provenance: [] }, 'provenance'],
      ['an origin kind that is neither', { provenance: { origin: { kind: 'other' } } }, 'provenance.origin.kind'],
      ['an origin version that is not whole', { provenance: { origin: { version: 1.5 } } }, 'provenance.origin.version'],
      ['an app name that is too long', { provenance: { app: 'a'.repeat(61) } }, 'provenance.app'],
      ['a reference source that is a number', { provenance: { reference: { source: { name: 5 } } } }, 'provenance.reference.source.name'],
      ['a base that is no built-in', { base: 'nope' }, 'base'],
      ['a base that names a prototype member', { base: '__proto__' }, 'base'],
      ['a base of the other mode', { base: 'light', mode: 'dark' }, 'base'],
      ['a base that is not text', { base: 7 }, 'base'],
    ]

    for (const [label, patch, field] of cases) {
      const value = document(patch)

      Object.keys(value).forEach((key) => value[key] === undefined && delete value[key])

      const result = parse(ctx, value)

      if (result.ok || kindsOf(result) !== 'field' || !result.errors.some((error) => error.field === field)) {
        return `${label}: ${result.ok ? 'accepted' : short(fieldsOf(result))}`
      }

      if (result.errors.some((error) => !error.message)) {
        return `${label}: a failure without a message`
      }
    }

    return true
  }],

  ['a group or a role this app has no such role for is a failure of kind role, __proto__ and constructor included, and it is told from a malformed member in the same file', (ctx) => {
    const cases = [
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"nope":{}}}', ['role:roles.nope']],
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"surfaces":{"glow":"#000000"}}}', ['role:roles.surfaces.glow']],
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"__proto__":{"x":"#000000"}}}', ['role:roles.__proto__']],
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"surfaces":{"__proto__":"#000000"}}}', ['role:roles.surfaces.__proto__']],
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"constructor":{"x":"#000000"}}}', ['role:roles.constructor']],
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"surfaces":{"toString":"#000000"}}}', ['role:roles.surfaces.toString']],
      ['{"format":"aurora-electrons-appearance","version":1,"name":"a","mode":"dark","roles":{"surfaces":{"glow":"#000000","card":"nope"}}}', ['role:roles.surfaces.glow', 'field:roles.surfaces.card']],
    ]

    for (const [text, expected] of cases) {
      const result = parse(ctx, text)

      if (result.ok || same(fieldsOf(result), expected) !== true) {
        return `${text.slice(70)}: ${result.ok ? 'accepted' : short(fieldsOf(result))}`
      }
    }

    return true
  }],

  ['the sizes are bounded: the text, and the failures kept', (ctx) => {
    const oversize = parse(ctx, 'x'.repeat(ctx.file.MAX_BYTES + 1))

    if (oversize.ok || same(fieldsOf(oversize), ['field:file']) !== true || !/limit/.test(oversize.errors[0].message)) {
      return `oversize: ${short(oversize.errors)}`
    }

    const padded = JSON.stringify(document({ description: ' '.repeat(100) })).padEnd(ctx.file.MAX_BYTES + 1, ' ')

    if (parse(ctx, padded).ok) {
      return 'a file over the size limit read'
    }

    const unknown = {}

    for (let index = 0; index < 150; index++) {
      unknown[`glow${index}`] = '#000000'
    }

    const many = parse(ctx, document({ roles: { surfaces: unknown } }))

    return many.ok || many.errors.length !== ctx.file.MAX_ERRORS || many.omitted !== 50 ? `many failures: ${many.errors && many.errors.length} kept, ${many.omitted} left out` : true
  }],

  ['a partial file lists the roles it left out with the base\'s values, and which base it used', (ctx) => {
    const paths = ctx.file.ROLE_PATHS
    const dark = ctx.appearance.resolveAppearance('dark')
    const classic = ctx.appearance.resolveAppearance('classic')
    const t2d = ctx.appearance.resolveAppearance('t2d')
    const get = (resolved, role) => resolved[role.split('.')[0]][role.split('.')[1]]

    const partial = parse(ctx, document({ roles: { surfaces: { card: '#101010' }, washes: { sectionSoft: 0.3 } } }))

    if (!partial.ok) {
      return short(partial.errors)
    }

    const expectedLeft = paths.filter((role) => role !== 'surfaces.card' && role !== 'washes.sectionSoft' && role !== 'focus.linkLine')

    if (same(partial.defaults.map((entry) => entry.path), expectedLeft) !== true || !partial.defaults.every((entry) => same(entry.value, get(dark, entry.path)) === true)) {
      return `defaults of a dark file: ${partial.defaults.length} of ${expectedLeft.length}`
    }

    if (same(partial.base, { id: 'dark', explicit: false }) !== true || partial.roles.surfaces.card !== '#101010' || partial.roles.washes.sectionSoft !== 0.3) {
      return `base ${short(partial.base)}, card ${partial.roles.surfaces.card}`
    }

    const light = parse(ctx, document({ mode: 'light' }))

    if (!light.ok || light.base.id !== 'light' || light.defaults.length !== paths.length - 1) {
      return `a light file with no roles: ${short(light.base)}, ${light.defaults && light.defaults.length} defaults`
    }

    const based = parse(ctx, document({ base: 'classic', roles: { inks: { body: '#eeeeee' } } }))

    if (!based.ok || same(based.base, { id: 'classic', explicit: true }) !== true || !based.defaults.every((entry) => same(entry.value, get(classic, entry.path)) === true) || based.roles.surfaces.card !== classic.surfaces.card) {
      return `a file on the base classic: ${short(based.base)}`
    }

    const linked = parse(ctx, document({ base: 't2d' }))

    if (!linked.ok || !linked.defaults.some((entry) => entry.path === 'focus.linkLine' && entry.value === 'underline') || linked.roles.focus.linkLine !== t2d.focus.linkLine) {
      return 'the link line of the base t2d is not carried as a default'
    }

    const draft = ctx.appearance.importAppearanceFile(JSON.stringify(document({ roles: { surfaces: { card: '#101010' } } })))

    return draft.ok && draft.entry.appearance.file.defaults.length === paths.length - 2 && draft.entry.appearance.file.base.explicit === false && same(rolesOf(ctx, draft.entry.appearance).inks, rolesOf(ctx, dark).inks) === true ? true : 'the draft does not list its defaults'
  }],

  ['a body ink the colour of the page, an ink under 4.5:1 and an unsupported font are explained, and the first blocks Apply', (ctx) => {
    const dark = ctx.appearance.resolveAppearance('dark')
    const bad = ctx.appearance.importAppearanceFile(JSON.stringify(document({ roles: { inks: { body: dark.surfaces.background } } })))

    if (!bad.ok || !bad.entry.report.findings.some((finding) => /^Body text/.test(finding.label)) || bad.entry.report.blocking.length !== 1 || !/Body text on the page background/.test(bad.entry.report.blocking[0].label)) {
      return `a body ink the colour of the page: ${short(bad.entry && bad.entry.report.blocking)}`
    }

    const low = ctx.appearance.importAppearanceFile(JSON.stringify(document({ roles: { inks: { body: '#707070' } } })))

    if (!low.ok || !low.entry.report.findings.some((finding) => /^Body text/.test(finding.label) && finding.ratio < 4.5 && finding.ratio >= 3) || low.entry.report.blocking.length !== 0) {
      return `an ink at about 3.8:1: ${short(low.entry && low.entry.report.findings.map((finding) => [finding.label, finding.ratio]))}`
    }

    const faint = ctx.appearance.importAppearanceFile(JSON.stringify(document({ roles: { inks: { text: 'rgba(255, 255, 255, 0.05)' } } })))

    if (!faint.ok || faint.entry.report.blocking.length !== 1 || !/Vuetify text/.test(faint.entry.report.blocking[0].label)) {
      return 'a text ink that is nearly transparent does not block'
    }

    const font = parse(ctx, document({ font: { family: 'Comic Sans MS' } }))
    const roboto = parse(ctx, document({ font: { family: 'Roboto' } }))
    const condensed = parse(ctx, document({ font: { family: 'roboto condensed' } }))
    const verdana = parse(ctx, document({ font: { family: 'Verdana' } }))
    const none = parse(ctx, document())

    if (!font.ok || font.font.supported || font.font.choice !== null || !/Comic Sans MS/.test(ctx.file.fontNotice(font.font) || '') || ctx.file.fontNotice(roboto.font) !== null || ctx.file.fontNotice(none.font) !== null || none.font.explicit) {
      return 'the font notice'
    }

    if (!condensed.ok || condensed.font.choice !== 'roboto-condensed' || !verdana.ok || verdana.font.choice !== 'verdana' || ctx.file.fontNotice(condensed.font) !== null || ctx.file.fontNotice(verdana.font) !== null) {
      return `a family named like one of the choices: ${short([condensed.font, verdana.font])}`
    }

    ctx.appearance.importAppearanceFile(JSON.stringify(document({ font: { family: 'Comic Sans MS' } })))

    const kept = ctx.appearance.exportAppearanceFile('custom-draft', NOW)

    return kept.font.family === 'Comic Sans MS' ? true : `the family is not kept: ${short(kept.font)}`
  }],

  ['the inks drawn on the toolbar and snackbar fills are measured on the fills, and a baseline keeps its own', (ctx) => {
    const named = (patch) => {
      const result = ctx.appearance.importAppearanceFile(JSON.stringify(document(patch)))

      ctx.appearance.cancelPreview()

      return result.ok ? result.entry.report : null
    }
    const labels = (report) => report.findings.map((finding) => finding.label)
    const unreadable = named({ base: 't2d', roles: { inks: { onColor: '#ffffff' } } })
    const transparent = named({ base: 't2d', roles: { inks: { onSnackbar: 'rgba(0, 0, 0, 0)' } } })
    const both = named({ base: 't2d', roles: { inks: { onColor: '#ffffff', onSnackbar: 'rgba(0, 0, 0, 0)' } } })
    const yellow = named({ roles: { focus: { primary: '#ffeb3b' } } })

    if (!unreadable || !labels(unreadable).some((label) => /^toolbar title on the primary fill/.test(label)) || !labels(unreadable).some((label) => /^toolbar icon on the success fill/.test(label))) {
      return `an on-colour ink of white on the t2d fills: ${short(unreadable && labels(unreadable))}`
    }

    if (!transparent || !labels(transparent).some((label) => /^snackbar message on the primary fill/.test(label)) || labels(transparent).some((label) => /^snackbar text button/.test(label)) || transparent.findings.some((finding) => !/^snackbar message/.test(finding.label))) {
      return `a transparent snackbar ink flags the message alone: ${short(transparent && labels(transparent))}`
    }

    if (!labels(unreadable).some((label) => /^snackbar text button on the (primary|success|error|warning|info) fill/.test(label)) || labels(unreadable).some((label) => /^snackbar message/.test(label))) {
      return `the snackbar text button is drawn with the on-colour ink and the message is not: ${short(labels(unreadable))}`
    }

    if (!both || both.findings.length <= unreadable.findings.length || both.blocking.length !== 0) {
      return `both inks together: ${short(both && both.findings.length)}`
    }

    if (!yellow || !labels(yellow).some((label) => /^toolbar title on the primary fill/.test(label))) {
      return `Dark's white on a yellow primary fill: ${short(yellow && labels(yellow))}`
    }

    const quiet = named({ roles: { inks: { onSnackbar: 'rgba(0, 0, 0, 0)' } } })

    if (!quiet || !labels(quiet).some((label) => /^snackbar message on the primary fill/.test(label)) || labels(quiet).some((label) => /^toolbar/.test(label))) {
      return `a transparent snackbar ink beside Dark's own toolbar ink: ${short(quiet && labels(quiet))}`
    }

    const own = named({})
    const light = named({ mode: 'light' })

    return own && light && own.findings.length === 0 && light.findings.length === 0 ? true : `a file with no roles: dark ${own && own.findings.length}, light ${light && light.findings.length} findings`
  }],

  ['a file that fails changes nothing, a draft writes nothing, and Apply writes the document and the choice in one assignment', (ctx) => {
    const { appearance } = ctx
    const config = fakeConfig()

    appearance.loadAppearance(config)

    const before = () => short([appearance.appliedPresetId(), appearance.activeAppearance().key, appearance.isPreviewing(), config.data, config.writes.length, appearance.importedAppearances().draft && appearance.importedAppearances().draft.appearance.key, appearance.importedAppearances().custom && appearance.importedAppearances().custom.appearance.key])
    const idle = before()

    const bad = appearance.importAppearanceFile(JSON.stringify(document({ version: 3 })))

    if (bad.ok || before() !== idle) {
      return `a failed import changed something: ${idle} -> ${before()}`
    }

    const good = appearance.importAppearanceFile(JSON.stringify(document({ name: 'First' })))

    if (!good.ok || appearance.activeAppearance().id !== 'custom-draft' || !appearance.isPreviewing() || appearance.appliedPresetId() !== 'light' || config.writes.length !== 0 || config.data.appearanceCustom !== undefined) {
      return `a draft: ${appearance.activeAppearance().id}, ${config.writes.length} writes`
    }

    const held = before()

    if (appearance.importAppearanceFile('{"broken"').ok || appearance.importAppearanceFile(JSON.stringify(document({ roles: { nope: {} } }))).ok || before() !== held) {
      return 'a failed import after a good one changed the draft'
    }

    if (!appearance.applyPreset(config, 'custom-draft') || config.writes.length !== 1 || config.writes[0].via !== 'store' || !config.writes[0].keys.includes('appearance') || !config.writes[0].keys.includes('appearanceCustom')) {
      return `Apply wrote ${short(config.writes)}`
    }

    if (config.get('appearance') !== 'custom' || same(config.get('appearanceCustom'), good.entry.parsed.document) !== true || appearance.appliedPresetId() !== 'custom' || appearance.activeAppearance().name !== 'First' || appearance.importedAppearances().draft !== null || appearance.isPreviewing()) {
      return `after Apply: ${short(config.data.appearance)}, ${appearance.appliedPresetId()}`
    }

    const keptKey = appearance.importedAppearances().custom.appearance.key

    appearance.importAppearanceFile(JSON.stringify(document({ name: 'Second' })))
    config.failNext = true

    let threw = false

    try {
      appearance.applyPreset(config, 'custom-draft')
    } catch (error) {
      threw = true
    }

    if (!threw || appearance.appliedPresetId() !== 'custom' || appearance.importedAppearances().custom.appearance.key !== keptKey || appearance.importedAppearances().draft === null || config.data.appearanceCustom.name !== 'First' || appearance.activeAppearance().id !== 'custom-draft') {
      return `a write that throws: threw ${threw}, kept ${appearance.importedAppearances().custom.appearance.name}, stored ${config.data.appearanceCustom.name}`
    }

    appearance.cancelPreview()

    if (appearance.importedAppearances().draft !== null || appearance.activeAppearance().name !== 'First' || appearance.isPreviewing()) {
      return 'cancel does not drop the draft'
    }

    return same(appearance.listAppearances().map((entry) => entry.id), IDS)
  }],

  ['a fresh start reads the kept file back through the parser, and a stored file that does not pass is reported and left as it is', async (ctx) => {
    const config = fakeConfig()

    ctx.appearance.loadAppearance(config)
    ctx.appearance.importAppearanceFile(JSON.stringify(document({ name: 'Kept', mode: 'light', roles: { surfaces: { chrome: '#f0f0f0' } } })))
    ctx.appearance.applyPreset(config, 'custom-draft')

    const first = ctx.appearance.activeAppearance()
    const fresh = await ctx.fresh()

    fresh.appearance.loadAppearance(config)

    const second = fresh.appearance.activeAppearance()

    if (fresh.appearance.appliedPresetId() !== 'custom' || second.name !== 'Kept' || second.surfaces.chrome !== '#f0f0f0' || same(rolesOf(fresh, second), rolesOf(ctx, first)) !== true || fresh.appearance.importedAppearances().custom === null || config.writes.length !== 1) {
      return `restored ${fresh.appearance.appliedPresetId()} ${second.name}, ${config.writes.length} writes`
    }

    const builtInChosen = fakeConfig({ ...config.data, appearance: 'dark' })
    const other = await ctx.fresh()

    other.appearance.loadAppearance(builtInChosen)

    if (other.appearance.appliedPresetId() !== 'dark' || other.appearance.importedAppearances().custom === null) {
      return 'the kept file is not there beside a built-in one that is chosen'
    }

    const damaged = fakeConfig({ appearance: 'custom', appearanceCustom: { ...config.data.appearanceCustom, version: 2 } })
    const bad = await ctx.fresh()

    bad.appearance.loadAppearance(damaged)

    const problem = bad.appearance.importedAppearances().problem

    if (bad.appearance.appliedPresetId() !== 'light' || bad.appearance.importedAppearances().custom !== null || !problem || problem.errors[0].kind !== 'version' || damaged.writes.length !== 0 || damaged.data.appearance !== 'custom' || damaged.data.appearanceCustom.version !== 2 || bad.appearance.unsupportedPresetId(damaged) !== 'custom') {
      return `a damaged file: ${bad.appearance.appliedPresetId()}, ${short(problem)}, ${damaged.writes.length} writes`
    }

    const removed = await ctx.fresh()
    const kept = fakeConfig({ ...config.data })

    removed.appearance.loadAppearance(kept)

    if (!removed.appearance.removeCustom(kept) || kept.writes.length !== 1 || kept.data.appearanceCustom !== undefined || kept.data.appearance !== 'theme' || kept.data.appearancePolicy !== 'light' || removed.appearance.appliedPresetId() !== 'light' || removed.appearance.importedAppearances().custom !== null || removed.appearance.activeAppearance().id !== 'light') {
      return `removing the kept file: ${short(kept.data.appearance)} ${short(kept.data.appearancePolicy)}, ${kept.writes.length} writes`
    }

    return true
  }],

  ['the file name names the app\'s own format and no game format, whatever the name of the appearance', (ctx) => {
    const name = ctx.file.appearanceFileName('Aurora Classic')

    if (name !== 'aurora-electrons-appearance-aurora-classic.json' || /xml/i.test(name)) {
      return `the file name ${name}`
    }

    return ctx.file.appearanceFileName('../..\\x: y') !== 'aurora-electrons-appearance-x-y.json' || ctx.file.appearanceFileName('') !== 'aurora-electrons-appearance-custom.json' ? 'the file name of a name with path characters or none' : true
  }],
]

// The files of the feature: none claims a game format or names a source that is not to be named. Read once, not in the mutated copies.
const scanSources = () => {
  const found = SCANNED.flatMap((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')

    return [/xml/i].filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`)
  })

  return found.length ? found.join('; ') : true
}

const runChecks = async (directory) => {
  const results = []

  for (const [name, test] of CHECKS) {
    let result

    try {
      result = await test(await load(directory))
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

// A copy of the utilities folder in the temp folder in which `file` has `from` replaced by `to`.
const mutatedCopy = (file, from, to) => plantedCopy(utilitiesDirectory, 'ae-appearance-mutant-', file, from, to)

const FILE = 'appearance-file.js'
const APPEARANCE = 'appearance.js'

const MUTATIONS = [
  ['an unsupported version accepted', FILE, 'if (data.version !== FILE_VERSION) {', 'if (false) {'],
  ['a version failure returned with the other failures', FILE, '\n\n    return failed()\n  }\n\n  Object.keys(data).forEach((key) => {', '\n  }\n\n  Object.keys(data).forEach((key) => {'],
  ['a role missing from the table', FILE, '  habitability: { band: \'hex\' },', '  habitability: {},'],
  ['any text taken for a colour', FILE, 'const HEX = /^#[0-9a-f]{6}$/i', 'const HEX = /^.*$/i'],
  ['a wash outside 0 to 1 accepted', FILE, 'value >= 0 && value <= 1 ? null', 'true ? null'],
  ['a categorical list of any length', FILE, '|| value.length !== CATEGORICAL_SLOTS', ''],
  ['a repeated categorical colour accepted', FILE, '} else if (seen.has(color.toLowerCase())) {', '} else if (false) {'],
  ['unknown roles ignored', FILE, 'if (!hasOwn(ROLES[group], key)) {', 'if (false) {'],
  ['unknown top-level members accepted', FILE, 'if (!TOP_LEVEL.includes(key)) {', 'if (false) {'],
  ['names of the prototype taken for roles', FILE, 'const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)', 'const hasOwn = (object, key) => key in object'],
  ['the size of the text not bounded', FILE, 'if (text.length > MAX_BYTES) {', 'if (false) {'],
  ['a base of the other mode accepted', FILE, '} else if (document.mode && baseAppearance.mode !== document.mode) {', '} else if (false) {'],
  ['the baseline of the mode not the default base', FILE, ': baselines[document.mode]', ": 'light'"],
  // eslint-disable-next-line no-template-curly-in-string
  ['omitted roles not reported', FILE, 'defaults.push({ path: `${group}.${key}`, value: copyRole(base[group][key]) })', 'void 0'],
  ['the contrast check finds nothing', FILE, 'const findings = labelled.filter((row) => !row.pass)', 'const findings = labelled.filter((row) => false)'],
  ['an unreadable body ink not blocking', FILE, 'return value < BLOCKING_MINIMUM ?', 'return false ?'],
  ['an unsupported font not explained', FILE, 'export const fontNotice = (font) => (font.supported ? null :', 'export const fontNotice = (font) => (true ? null :'],
  ['the font family not kept on export', FILE, 'font: { family: imported && imported.font.explicit ? imported.font.family : typeface },', 'font: { family: typeface },'],
  ['a font name not resolved through the choices', 'appearance-font.js', 'family.id === wanted || family.name.toLowerCase() === wanted', 'family.id === wanted'],
  ['the reference dropped on export', FILE, '...(reference ? { reference: JSON.parse(JSON.stringify(reference)) } : {}),', ''],
  ['the toolbar and snackbar inks not measured on the fills', FILE, '    ...measured.named,\n', ''],
  ['a baseline exemption that covers every ink', 'appearance-contrast.js', 'appearance.inks[token] === baseline.inks[token] && COLOUR_FILLS', 'COLOUR_FILLS'],
  ['the fills of the baseline not compared', 'appearance-contrast.js', 'COLOUR_FILLS.every(([, path]) => String(at(appearance, path)).toLowerCase() === String(at(baseline, path)).toLowerCase())', 'true'],
  ['the snackbar text button measured with the snackbar message ink', 'appearance-contrast.js', 'snackbarButton: appearance.inks.onColor })', 'snackbarButton: appearance.inks.onSnackbar })'],
  ['Apply writes the document and the choice apart', APPEARANCE, 'config.update((store) => ({ ...store, [CUSTOM_KEY]: entry.parsed.document, [APPEARANCE_KEY]: CUSTOM_ID }))', 'config.set(CUSTOM_KEY, entry.parsed.document)\n    config.set(APPEARANCE_KEY, CUSTOM_ID)'],
  ['the state changed before the write that can fail', APPEARANCE, '    config.update((store) => ({ ...store, [CUSTOM_KEY]: entry.parsed.document, [APPEARANCE_KEY]: CUSTOM_ID }))\n    imported.custom = register(CUSTOM_ID, entry.parsed)', '    imported.custom = register(CUSTOM_ID, entry.parsed)\n    config.update((store) => ({ ...store, [CUSTOM_KEY]: entry.parsed.document, [APPEARANCE_KEY]: CUSTOM_ID }))'],
  ['a failed import dropping the draft', APPEARANCE, '  if (!parsed.ok) {\n    return parsed', '  if (!parsed.ok) {\n    imported.draft = null\n\n    return parsed'],
  ['a cancelled preview keeping the draft', APPEARANCE, '  imported.draft = null\n  state.id = state.applied', '  state.id = state.applied'],
  ['a stored file that fails not reported', APPEARANCE, 'imported.problem = parsed && !parsed.ok ? { errors: parsed.errors, omitted: parsed.omitted } : null', 'imported.problem = null'],
  ['the kept file not read back at start', APPEARANCE, 'imported.custom = parsed && parsed.ok ? register(CUSTOM_ID, parsed) : null', 'imported.custom = null'],
]

// A planted fault is judged only when it applies exactly once, the source it leaves parses and the modules it leaves still load: a fault that breaks the syntax of a module (one the checks load or not) or whose anchor matches nothing makes the checks throw, and a thrown check counts as failed, so such a fault would be reported as caught without any check having looked at what it was meant to plant. It is reported as invalid instead, and fails the run.
const judge = async ([, file, from, to]) => {
  let directory

  try {
    try {
      directory = mutatedCopy(file, from, to)
      await load(directory)
    } catch (error) {
      return { invalid: error.message }
    }

    return { failed: (await runChecks(directory)).filter(([, result]) => result !== true).length }
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
  ['a module that does not parse', APPEARANCE, 'export const PRESETS = {', 'export const PRESETS = ] {'],
  ['a module that the checks do not load and that does not parse', 'map-borders.js', 'context.font = type.font(NAME_SIZE)', 'context.font = ] type.font(NAME_SIZE)'],
  ['an anchor that matches nothing', APPEARANCE, 'export const PRESETS = {{{', 'export const PRESETS = {'],
]

const run = async () => {
  let failures = 0
  let checks = 0
  const tally = (ok) => {
    checks++

    if (!ok) {
      failures++
    }
  }

  console.log('Appearance files')

  for (const [name, result] of await runChecks()) {
    tally(result === true)
    console.log(`${result === true ? 'PASS' : 'FAIL'}  ${name}${result === true ? '' : `  [${typeof result === 'string' ? result : 'false'}]`}`)
  }

  const scanned = scanSources()

  tally(scanned === true)
  console.log(`${scanned === true ? 'PASS' : 'FAIL'}  the files of the feature claim no game format and name no source that is not to be named${scanned === true ? '' : `  [${scanned}]`}`)

  console.log('\nMutations: each must fail at least one check')

  for (const fault of MUTATIONS) {
    const { failed, invalid, error } = await judge(fault)
    const [label] = fault

    if (invalid !== undefined) {
      tally(false)
      console.log(`FAIL  invalid mutant: ${label}  [${invalid}]`)
    } else if (error !== undefined) {
      tally(false)
      console.log(`FAIL  mutation caught: ${label}  [${error}]`)
    } else {
      tally(failed > 0)
      console.log(`${failed ? 'PASS' : 'FAIL'}  mutation caught: ${label}  [${failed ? `${failed} checks fail` : 'every check still passes'}]`)
    }
  }

  for (const entry of INVALID) {
    const [label] = entry
    const unparsable = await judge(entry)

    tally(unparsable.invalid !== undefined)
    console.log(`${unparsable.invalid !== undefined ? 'PASS' : 'FAIL'}  runner: ${label} is reported as an invalid mutant and not as caught${unparsable.invalid !== undefined ? '' : `  [${JSON.stringify(unparsable)}]`}`)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
