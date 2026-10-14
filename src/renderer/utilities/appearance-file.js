import { measureAppearance, over, parseColor, ratio } from './appearance-contrast'
import { FALLBACK, FONT_FAMILIES, familyByName, familyOf } from './appearance-font'

// The Electrons appearance file: the app's own data-only exchange format for the colours of an appearance (utilities/appearance.js). It is not an Aurora game file and no part of the game reads or writes it. One JSON object, no CSS, no URLs, no expressions, nothing that is run; `parseAppearanceFile` accepts only the members listed here and builds a new object from the values it has checked, so nothing of the text itself reaches a style or a script.
//
// Version 1 holds:
// - `format` (always 'aurora-electrons-appearance'), `version` (always 1), `name` and `mode` ('light' or 'dark', the base theme of Vuetify's own components): required.
// - `description` and `author`: optional text.
// - `base`: optional id of a built-in preset whose values fill every role the file leaves out; the baseline preset of the mode when absent. A base takes the mode of the file.
// - `font`: optional, `{ family }`. The family is looked up among the typefaces the app offers (FONT_FAMILIES of utilities/appearance-font.js, by name); one that is not offered is kept and reported, not drawn. Reading a file never changes the typeface in force.
// - `provenance`: optional, where the values came from (`app`, `exportedAt`, `origin` and the `reference` an adapted preset carries), written on export and shown on import.
// - `roles`: optional, the colours, nested like a resolved appearance (ROLES lists every group and key). Each role is optional; one the file leaves out takes the base's value and is reported as a default.
//
// A failure is `{ kind, field, message }` and the kind says what is wrong: `version` (the file is of a version this app does not read; it is returned alone, because nothing else in such a file can be trusted), `field` (a member that is missing, not of its type, out of range, too long, or not part of the format at all; structural faults of the text, not JSON, not an object, too large, wrong `format`, are fields too) or `role` (a group or key under `roles` that the app has no such role for).
//
// Sizes are bounded: the text (MAX_BYTES), each string (LIMITS), the colour lists and the failures kept (MAX_ERRORS); more failures are only counted.

export const FILE_FORMAT = 'aurora-electrons-appearance'
export const FILE_VERSION = 1
export const MAX_BYTES = 64 * 1024
export const MAX_ERRORS = 100
export const LIMITS = { name: 60, description: 280, author: 80, family: 60, app: 60, exportedAt: 40, id: 40, title: 120, source: 200 }
export const MODES = ['light', 'dark']
export const LINK_LINES = ['underline']
export const ORIGIN_KINDS = ['built-in', 'imported']
export const KIND_LABELS = { version: 'Unsupported version', field: 'Malformed field', role: 'Unknown role' }

// The kind of value a role takes: `hex` is `#rrggbb` (a colour the renderers use in full, or Vuetify's theme takes), `color` is `#rrggbb`, `#rrggbbaa` or `rgb()`/`rgba()` with whole channels of 0 to 255 and an alpha of 0 to 1 (a wash or an ink Vuetify mixes), `alpha` is a number from 0 to 1, `list` is the nine categorical slots (each `#rrggbb`, none repeated), `line` is the text decoration of a link.
export const ROLES = {
  surfaces: { background: 'hex', chrome: 'hex', card: 'hex', border: 'hex', track: 'color', trackSoft: 'color', rule: 'color' },
  inks: { body: 'hex', muted: 'hex', text: 'color', textMuted: 'color', onTooltip: 'hex', onFill: 'hex', onColor: 'hex', onSnackbar: 'color' },
  focus: { primary: 'hex', hover: 'color', secondary: 'hex', accent: 'hex', linkLine: 'line' },
  rows: { selected: 'color', differs: 'color', differsMark: 'hex', differsDot: 'color', stripe: 'color', stripeSoft: 'color' },
  severity: { action: 'hex', attention: 'hex', info: 'hex', success: 'hex' },
  contacts: { hostile: 'hex', unknown: 'hex', neutral: 'hex', friendly: 'hex', allied: 'hex', civilian: 'hex' },
  survey: { done: 'hex', left: 'hex', ground: 'hex', unexplored: 'hex', geological: 'hex', gravitational: 'hex', both: 'hex' },
  habitability: { band: 'hex' },
  accessibility: { good: 'hex', fair: 'hex', poor: 'hex' },
  status: { shortfall: 'hex', inactive: 'hex' },
  plan: { mining: 'hex', terraformFree: 'hex', terraformPartial: 'hex', terraformCheaper: 'hex', cheap: 'hex', moderate: 'hex', costly: 'hex', severe: 'hex', insufficient: 'hex', rich: 'hex', cmc: 'hex', unsurveyed: 'hex', selected: 'hex' },
  charts: { axis: 'hex', tooltip: 'color', categorical: 'list' },
  sections: { neutral: 'hex', accents: 'list' },
  space: { background: 'hex', label: 'hex', labelShadow: 'color', bodyOrbit: 'hex', jumpUnexplored: 'hex', jumpExplored: 'hex' },
  washes: { sectionSoft: 'alpha', sectionTint: 'alpha', statusSoft: 'alpha' },
}

// A role that a file may leave out and that the base may not have either (only a preset that needs it carries it).
const OPTIONAL_ROLES = ['focus.linkLine']
export const CATEGORICAL_SLOTS = 9
const HEX = /^#[0-9a-f]{6}$/i
const HEX_ALPHA = /^#[0-9a-f]{8}$/i
const FUNCTIONAL = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i
const FAMILY = /^[A-Za-z0-9 -]+$/
const hasControl = (value) => [...value].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f)
const TOP_LEVEL = ['format', 'version', 'name', 'description', 'author', 'mode', 'base', 'font', 'provenance', 'roles']

const SOURCE_SHAPE = { name: ['text', LIMITS.source], author: ['text', LIMITS.source], repository: ['text', LIMITS.source], revision: ['text', LIMITS.source], revisionDate: ['text', LIMITS.source], license: ['text', LIMITS.source] }
const PROVENANCE_SHAPE = {
  app: ['text', LIMITS.app],
  exportedAt: ['text', LIMITS.exportedAt],
  origin: { kind: ['enum', ORIGIN_KINDS], id: ['text', LIMITS.id], name: ['text', LIMITS.name], version: ['integer'] },
  reference: { title: ['text', LIMITS.title], source: SOURCE_SHAPE },
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const shown = (value) => (typeof value === 'string' ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value) : typeof value === 'number' || typeof value === 'boolean' || value === null ? String(value) : Array.isArray(value) ? 'a list' : 'an object')

const textProblem = (value, maximum) => {
  if (typeof value !== 'string') {
    return `must be text, not ${shown(value)}`
  }

  if (!value.trim()) {
    return 'must not be empty'
  }

  if (value.length > maximum) {
    return `is ${value.length} characters long; the limit is ${maximum}`
  }

  return hasControl(value) ? 'must not hold control characters' : null
}

const channelsFit = (match) => match.slice(1, 4).every((channel) => Number(channel) <= 255) && (match[4] === undefined || Number(match[4]) <= 1)

const colorProblem = (value, kind) => {
  if (typeof value !== 'string') {
    return `must be a colour written as text, not ${shown(value)}`
  }

  if (value.length > 40) {
    return `is ${value.length} characters long; a colour is not longer than 40`
  }

  if (HEX.test(value)) {
    return null
  }

  if (kind === 'hex') {
    return `${shown(value)} is not a #rrggbb colour`
  }

  const functional = FUNCTIONAL.exec(value)

  if (HEX_ALPHA.test(value) || (functional && channelsFit(functional))) {
    return null
  }

  return functional ? `${shown(value)} has a channel above 255 or an alpha above 1` : `${shown(value)} is not #rrggbb, #rrggbbaa, rgb() or rgba() with whole channels and an alpha of 0 to 1`
}

const roleProblem = (value, kind) => {
  if (kind === 'alpha') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? null : `must be a number from 0 to 1, not ${shown(value)}`
  }

  if (kind === 'line') {
    return LINK_LINES.includes(value) ? null : `must be one of ${LINK_LINES.map((line) => `"${line}"`).join(', ')}, not ${shown(value)}`
  }

  return colorProblem(value, kind)
}

// Checks a nested optional-member shape and returns a fresh object of the values that passed (a failure is reported through `fail` with the full path).
const checkShape = (value, schema, field, fail) => {
  if (!isPlain(value)) {
    fail('field', field, `must be an object, not ${shown(value)}`)

    return undefined
  }

  const out = {}

  Object.keys(value).forEach((key) => {
    if (!hasOwn(schema, key)) {
      fail('field', `${field}.${key.slice(0, 40)}`, 'is not a member of this object in version 1 of the format')

      return
    }

    const rule = schema[key]

    if (!Array.isArray(rule)) {
      const inner = checkShape(value[key], rule, `${field}.${key}`, fail)

      if (inner !== undefined) {
        out[key] = inner
      }

      return
    }

    const [type, limit] = rule
    const problem = type === 'text' ? textProblem(value[key], limit) : type === 'enum' ? (limit.includes(value[key]) ? null : `must be one of ${limit.map((item) => `"${item}"`).join(', ')}, not ${shown(value[key])}`) : Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 9999 ? null : `must be a whole number from 0 to 9999, not ${shown(value[key])}`

    if (problem) {
      fail('field', `${field}.${key}`, problem)
    } else {
      out[key] = value[key]
    }
  })

  return out
}

const rolePaths = () => Object.entries(ROLES).flatMap(([group, keys]) => Object.keys(keys).map((key) => `${group}.${key}`))

export const ROLE_PATHS = rolePaths()

const copyRole = (value) => (Array.isArray(value) ? [...value] : value)

// Reads the text of an appearance file. `builtIn(id)` gives the resolved built-in preset of an id or null, and `baselines` the id of the baseline preset of each mode. Gives `{ ok: false, errors, omitted }` (the failures, at most MAX_ERRORS of them, and how many more there were) or `{ ok: true, document, name, mode, description, author, base, font, provenance, roles, defaults }` where `document` is what the file said (kept as it is, and what is stored), `roles` every role, nested like a resolved appearance, the supplied ones as written and the others from the base, `defaults` the `{ path, value }` of each role the base filled in, `base` is `{ id, explicit }` and `font` is `{ family, explicit, supported }`. A damaged file changes nothing: the result is a new object and the arguments are only read.
export const parseAppearanceFile = (text, { builtIn, baselines }) => {
  const errors = []
  let omitted = 0
  const fail = (kind, field, message) => {
    if (errors.length < MAX_ERRORS) {
      errors.push({ kind, field, message })
    } else {
      omitted++
    }
  }
  const failed = () => ({ ok: false, errors, omitted })

  if (typeof text !== 'string') {
    fail('field', 'file', 'could not be read as text')

    return failed()
  }

  if (text.length > MAX_BYTES) {
    fail('field', 'file', `is ${text.length} characters long; the limit is ${MAX_BYTES}`)

    return failed()
  }

  let data

  try {
    data = JSON.parse(text)
  } catch (error) {
    fail('field', 'file', `is not valid JSON (${String(error.message).slice(0, 120)})`)

    return failed()
  }

  if (!isPlain(data)) {
    fail('field', 'file', `must be one JSON object, not ${shown(data)}`)

    return failed()
  }

  if (data.format !== FILE_FORMAT) {
    fail('field', 'format', `must be "${FILE_FORMAT}", not ${shown(data.format)}; this is not an Electrons appearance file`)

    return failed()
  }

  if (data.version !== FILE_VERSION) {
    fail('version', 'version', typeof data.version === 'number' && data.version > FILE_VERSION ? `${shown(data.version)} was written by a newer version of Aurora Electrons; this one reads version ${FILE_VERSION} only` : `${shown(data.version)} is not a version this app reads; it reads version ${FILE_VERSION} only`)

    return failed()
  }

  Object.keys(data).forEach((key) => {
    if (!TOP_LEVEL.includes(key)) {
      fail('field', key.slice(0, 40), 'is not a member of version 1 of the format')
    }
  })

  const document = { format: FILE_FORMAT, version: FILE_VERSION }
  const readText = (key, maximum, required) => {
    if (!hasOwn(data, key)) {
      if (required) {
        fail('field', key, 'is required')
      }

      return
    }

    const problem = textProblem(data[key], maximum)

    if (problem) {
      fail('field', key, problem)
    } else {
      document[key] = data[key]
    }
  }

  readText('name', LIMITS.name, true)
  readText('description', LIMITS.description, false)
  readText('author', LIMITS.author, false)

  if (!hasOwn(data, 'mode')) {
    fail('field', 'mode', 'is required')
  } else if (!MODES.includes(data.mode)) {
    fail('field', 'mode', `must be "light" or "dark", not ${shown(data.mode)}`)
  } else {
    document.mode = data.mode
  }

  let baseAppearance = null

  if (hasOwn(data, 'base')) {
    baseAppearance = typeof data.base === 'string' ? builtIn(data.base) : null

    if (!baseAppearance) {
      fail('field', 'base', `must be the id of a built-in appearance, not ${shown(data.base)}`)
    } else if (document.mode && baseAppearance.mode !== document.mode) {
      fail('field', 'base', `is a ${baseAppearance.mode} appearance, and the file's mode is ${document.mode}`)
    } else {
      document.base = data.base
    }
  }

  let font = null

  if (hasOwn(data, 'font')) {
    if (!isPlain(data.font)) {
      fail('field', 'font', `must be an object, not ${shown(data.font)}`)
    } else {
      Object.keys(data.font).filter((key) => key !== 'family').forEach((key) => fail('field', `font.${key.slice(0, 40)}`, 'is not a member of the font object in version 1 of the format'))

      if (!hasOwn(data.font, 'family')) {
        fail('field', 'font.family', 'is required')
      } else if (typeof data.font.family !== 'string' || !data.font.family.trim() || data.font.family.length > LIMITS.family || !FAMILY.test(data.font.family)) {
        fail('field', 'font.family', typeof data.font.family === 'string' && data.font.family.length > LIMITS.family ? `is ${data.font.family.length} characters long; the limit is ${LIMITS.family}` : `must be a font family name of letters, digits, spaces and hyphens, not ${shown(data.font.family)}`)
      } else {
        font = { family: data.font.family }
        document.font = { family: data.font.family }
      }
    }
  }

  if (hasOwn(data, 'provenance')) {
    const provenance = checkShape(data.provenance, PROVENANCE_SHAPE, 'provenance', fail)

    if (provenance !== undefined) {
      document.provenance = provenance
    }
  }

  const supplied = {}

  if (hasOwn(data, 'roles')) {
    if (!isPlain(data.roles)) {
      fail('field', 'roles', `must be an object, not ${shown(data.roles)}`)
    } else {
      Object.keys(data.roles).forEach((group) => {
        if (!hasOwn(ROLES, group)) {
          fail('role', `roles.${group.slice(0, 40)}`, 'is not a role group this app has')

          return
        }

        if (!isPlain(data.roles[group])) {
          fail('field', `roles.${group}`, `must be an object, not ${shown(data.roles[group])}`)

          return
        }

        supplied[group] = {}

        Object.keys(data.roles[group]).forEach((key) => {
          const field = `roles.${group}.${key.slice(0, 40)}`

          if (!hasOwn(ROLES[group], key)) {
            fail('role', field, `is not a role of the ${group} group`)

            return
          }

          const value = data.roles[group][key]

          if (ROLES[group][key] === 'list') {
            if (!Array.isArray(value) || value.length !== CATEGORICAL_SLOTS) {
              fail('field', field, `must be a list of ${CATEGORICAL_SLOTS} colours, not ${Array.isArray(value) ? `${value.length}` : shown(value)}`)

              return
            }

            const seen = new Map()
            let sound = true

            value.forEach((color, slot) => {
              const problem = colorProblem(color, 'hex')

              if (problem) {
                sound = false
                fail('field', `${field}[${slot}]`, problem)
              } else if (seen.has(color.toLowerCase())) {
                sound = false
                fail('field', `${field}[${slot}]`, group === 'sections' ? `repeats section ${seen.get(color.toLowerCase())}; the sections' accents are told apart by colour, so no two may share one` : `repeats slot ${seen.get(color.toLowerCase())}; a series is told which slot it is by its colour, so no two slots may share one`)
              } else {
                seen.set(color.toLowerCase(), slot)
              }
            })

            if (sound) {
              supplied[group][key] = [...value]
            }

            return
          }

          const problem = roleProblem(value, ROLES[group][key])

          if (problem) {
            fail('field', field, problem)
          } else {
            supplied[group][key] = value
          }
        })
      })
    }
  }

  if (errors.length) {
    return failed()
  }

  const baseId = baseAppearance ? baseAppearance.id : baselines[document.mode]
  const base = baseAppearance || builtIn(baseId)
  const roles = {}
  const defaults = []

  Object.entries(ROLES).forEach(([group, keys]) => {
    roles[group] = {}

    Object.keys(keys).forEach((key) => {
      if (supplied[group] && hasOwn(supplied[group], key)) {
        roles[group][key] = copyRole(supplied[group][key])
      } else if (base[group][key] !== undefined) {
        roles[group][key] = copyRole(base[group][key])
        defaults.push({ path: `${group}.${key}`, value: copyRole(base[group][key]) })
      } else if (!OPTIONAL_ROLES.includes(`${group}.${key}`)) {
        fail('field', `roles.${group}.${key}`, `has no value in the file and none in the base ${baseId}`)
      }
    })
  })

  if (errors.length) {
    return failed()
  }

  const keptRoles = Object.fromEntries(Object.entries(supplied).filter(([, group]) => Object.keys(group).length))

  if (hasOwn(data, 'roles')) {
    document.roles = keptRoles
  }

  const family = font ? font.family : familyOf(FALLBACK).name
  const offered = font ? familyByName(font.family) : null

  return {
    ok: true,
    document,
    name: document.name,
    mode: document.mode,
    description: document.description || '',
    author: document.author || '',
    base: { id: baseId, explicit: Boolean(baseAppearance) },
    font: { family, explicit: Boolean(font), supported: !font || Boolean(offered), choice: offered ? offered.id : null },
    provenance: document.provenance || null,
    roles,
    defaults,
  }
}

// What an unsupported font family means for the app, as a sentence for the person applying the file, or null for a family the app offers.
export const fontNotice = (font) => (font.supported ? null : `The file names the font family "${font.family}", which is not one of the typefaces offered (${FONT_FAMILIES.map((family) => family.name).join(', ')}). The app does not load fonts from a file, so the family is kept in the file and not drawn, and the typeface in force does not change.`)

// The contrast of a resolved appearance, measured with the tables scripts/check-contrast.js uses (utilities/appearance-contrast.js): `findings` are the measurements under their minimum (`{ label, foreground, surface, ratio, minimum }`), `blocking` the page's ink and Vuetify's text ink on the page background when under 3:1, which no one can read, and `checked` how many were measured. What needs the compiled stylesheet, the colour-vision simulation or the map's menu is left to that script.
export const BLOCKING_MINIMUM = 3

export const contrastReport = (appearance, { baseline = null } = {}) => {
  const measured = measureAppearance(appearance, { baseline })
  const labelled = [
    ...measured.text,
    ...measured.graphics,
    ...measured.rows,
    ...measured.disabled,
    ...measured.named,
    ...measured.fills.map((row) => ({ ...row, label: `Text on the ${row.label} fill` })),
    ...measured.categorical.map((row) => ({ ...row, label: `Chart slot ${row.slot + 1}` })),
    ...measured.sections.map((row) => ({ ...row, label: row.section === null ? 'Neutral section accent (accents off)' : `Section ${row.section + 1} accent (${row.mode})` })),
    ...measured.sectionWashes.map((row) => ({ ...row, label: row.section === null ? `Neutral section accent on its ${row.state} (accents off)` : `Section ${row.section + 1} accent on its ${row.state} (${row.mode})` })),
    ...measured.washText.map((row) => ({ ...row, label: row.section === null ? `${row.ink} on the neutral section accent's ${row.state} (accents off)` : `${row.ink} on section ${row.section + 1}'s ${row.state} (${row.mode})` })),
    ...measured.listText.map((row) => ({ ...row, label: `${row.ink} on the ${row.state} of a list` })),
    ...measured.sectionText.map((row) => ({ ...row, label: row.section === null ? 'Neutral section accent as text (accents off)' : `Section ${row.section + 1} accent as text (${row.mode})` })),
  ]
  const findings = labelled.filter((row) => !row.pass).map(({ label, foreground, color, surface, ratio: value, minimum }) => ({ label, foreground: foreground ?? color, surface, ratio: value, minimum }))
  const page = parseColor(appearance.surfaces.background)
  const blocking = [['Body text', 'inks.body'], ['Vuetify text', 'inks.text']].flatMap(([label, path]) => {
    const [group, key] = path.split('.')
    const ink = over(parseColor(appearance[group][key]), page)
    const value = ratio(ink, page)

    return value < BLOCKING_MINIMUM ? [{ label: `${label} on the page background`, foreground: appearance[group][key], surface: appearance.surfaces.background, ratio: value, minimum: BLOCKING_MINIMUM }] : []
  })

  return { checked: labelled.length, findings, blocking }
}

// The file name an exported appearance is saved under; it names the app's own format and no game.
export const appearanceFileName = (name) => `aurora-electrons-appearance-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom'}.json`

// The file of a resolved appearance, a built-in preset or an imported one (`appearance.file`): every role it has, its metadata and its provenance. `now` is the time of the export and `typeface` the name of the typeface in force, which the file names unless the appearance was imported from a file that named one. Exporting a file that was imported gives the roles as they are in force, defaults included, and carries its base, description, author, font and reference; the origin and the time are the export's own. The result is a new object.
export const buildAppearanceFile = (appearance, { now = Date.now(), typeface = familyOf(FALLBACK).name } = {}) => {
  const imported = appearance.file
  const roles = {}

  Object.entries(ROLES).forEach(([group, keys]) => {
    roles[group] = {}

    Object.keys(keys).forEach((key) => {
      if (appearance[group][key] !== undefined) {
        roles[group][key] = copyRole(appearance[group][key])
      }
    })
  })

  const own = appearance.reference ? { title: appearance.reference.title, source: Object.fromEntries(Object.keys(SOURCE_SHAPE).map((key) => [key, appearance.reference.source[key]])) } : null
  const reference = imported ? (imported.provenance && imported.provenance.reference) || null : own

  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    name: appearance.name,
    ...(imported && imported.description ? { description: imported.description } : {}),
    ...(imported && imported.author ? { author: imported.author } : {}),
    mode: appearance.mode,
    base: imported ? imported.base.id : appearance.id,
    font: { family: imported && imported.font.explicit ? imported.font.family : typeface },
    provenance: {
      app: 'Aurora Electrons',
      exportedAt: new Date(now).toISOString(),
      origin: imported ? { kind: 'imported', id: appearance.id, name: appearance.name, version: FILE_VERSION } : { kind: 'built-in', id: appearance.id, name: appearance.name, version: appearance.version },
      ...(reference ? { reference: JSON.parse(JSON.stringify(reference)) } : {}),
    },
    roles,
  }
}
