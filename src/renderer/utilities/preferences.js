// Moving preferences between empires, or installations, through a file: the versioned bundle, the allowlist it is built from, and the checks, preview, commit and undo of an import. Everything here is a pure function over plain JSON (the settings store as `config.store` returns it); Settings does the file and settings I/O.
//
// A bundle is `{ format, version, exportedAt, source: { gameId, raceId, gameName, raceName }, categories }`. `categories` holds only the categories chosen, each as `{ app?: { <key>: value }, race?: { <key>: value } }`. An `app` key is stored as it is; a `race` key is stored under `game.<GameID>.race.<RaceID>.` of the empire it was exported from, and travels without that prefix, so an import joins it to the prefix of the empire it is imported into. The source ids and names are there to tell the person which empire the file came from; they never decide where a key goes.
//
// The allowlist is the settings the app itself writes as preferences: the persisted-view fields (`mixins/persisted-view.js`, which keeps the registry of what every page and component declares, with the `normalise` and `valid` it restores them with), the colour preset, and the Display panel's two settings. Nothing outside it is exported, and a key outside it is rejected on import. Not supported, and so never exported or imported: see EXCLUDED.

export const FORMAT = 'aurora-electrons-preferences'
export const VERSION = 1
export const BACKUP_FORMAT = 'aurora-electrons-preferences-backup'

// The largest file an import reads. An export of everything an empire remembers is a few kilobytes.
export const MAX_BYTES = 1024 * 1024

export const CATEGORIES = [
  { id: 'appearance', title: 'Colour preset, typeface and text size', note: 'The preset, the typeface and the text size applied to every page. App-wide.' },
  { id: 'display', title: 'Number format and Computer-run empires', note: 'The thousands separator and whether Computer-run empires are listed. App-wide.' },
  { id: 'views', title: 'Remembered views', note: "Each page's options, filters, searches, views and each table's sort and rows per page: app-wide, or for the one empire where a value is about its own things." },
  { id: 'mapGroups', title: 'Galaxy Map pins and clusters', note: "The Galaxy Map's pinned systems and clusters of the empire. They name the systems of one campaign." },
]

// What is left out, and why. None of it can be selected: each is either kept elsewhere, kept per campaign row, or not stored by the app yet.
export const EXCLUDED = [
  { id: 'histories', title: 'Empire History', reason: 'Kept in files of its own, one per game; a record of a campaign, not a preference.' },
  { id: 'mutes', title: 'Warnings mutes and exclusions', reason: "Mutes, what each check listed at the last visit and the maintenance exclusions name one campaign's rows and ships; not supported." },
  { id: 'lastSeen', title: 'What was new at the last visit', reason: "The Game Log's last event seen belongs to one save; not supported." },
  { id: 'scenarios', title: 'Local scenarios', reason: 'The app stores none.' },
  { id: 'savePaths', title: 'Save paths', reason: 'Not kept in the settings: the save is found beside the app; never part of a bundle.' },
]

const MAP_GROUP_KEYS = ['mapPinned', 'mapGroups']
// Declared as views, but a suppression of warnings, so left out with the mutes.
const EXCLUDED_KEYS = ['maintenanceExclusions']
const DISPLAY_KEYS = ['spyNPR', 'selectedSeparator']

const UNSAFE_SEGMENTS = ['__proto__', 'constructor', 'prototype']
const SAFE_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/
const ID = /^\d+$/

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

const canonical = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }

  return value === undefined ? 'undefined' : JSON.stringify(value)
}

export const sameValue = (a, b) => canonical(a) === canonical(b)

const safePath = (path) => typeof path === 'string' && SAFE_PATH.test(path) && !path.split('.').some((part) => UNSAFE_SEGMENTS.includes(part))

const getPath = (object, path) => path.split('.').reduce((node, part) => (isObject(node) && has(node, part) ? node[part] : undefined), object)

const setPath = (object, path, value) => {
  const parts = path.split('.')
  const last = parts.pop()
  const parent = parts.reduce((node, part) => {
    if (!isObject(node[part])) {
      node[part] = {}
    }

    return node[part]
  }, object)

  parent[last] = value
}

const deletePath = (object, path) => {
  const parts = path.split('.')
  const last = parts.pop()
  const parent = parts.length ? getPath(object, parts.join('.')) : object

  if (isObject(parent)) {
    delete parent[last]
  }
}

// The path, if nothing but empty objects remain beneath it.
const pruneEmpty = (object, path) => {
  const node = getPath(object, path)

  if (isObject(node) && !Object.keys(node).length) {
    deletePath(object, path)
  }
}

const racePrefix = (gameId, raceId) => `game.${gameId}.race.${raceId}`

// A value as one short line, for the preview.
export const shorten = (value, length = 70) => {
  if (value === undefined) {
    return '(not set)'
  }

  const text = JSON.stringify(value)

  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

// What a declared field accepts: the type of its default (a null default takes any value), then `normalise` (undefined means the default, so the value is refused), then `valid`: the checks the page restores a stored value with. Every declaration of a key has to accept it, and the first one's normalised value is the one kept.
const checkDeclared = (declarations) => (value) => {
  if (value === undefined) {
    return { ok: false, reason: 'has no value' }
  }

  let kept

  for (const declaration of declarations) {
    const fallback = declaration.default

    if (fallback !== null && fallback !== undefined && kindOf(fallback) !== kindOf(value)) {
      return { ok: false, reason: `must be ${kindOf(fallback) === 'array' ? 'a list' : `of type ${kindOf(fallback)}`}, not ${kindOf(value)}` }
    }

    try {
      const normalised = declaration.normalise ? declaration.normalise(clone(value)) : clone(value)

      if (normalised === undefined) {
        return { ok: false, reason: 'is not a value the page accepts' }
      }

      if (declaration.valid && !declaration.valid(normalised)) {
        return { ok: false, reason: 'is not a value the page accepts' }
      }

      if (kept === undefined) {
        kept = clone(normalised)
      }
    } catch (error) {
      return { ok: false, reason: 'is not a value the page accepts' }
    }
  }

  return { ok: true, value: kept }
}

// The allowlist: a map of `<category>:<scope>:<key>` to `{ category, scope, key, check(value) }`, where `check` gives `{ ok: true, value }` (the value as it would be kept) or `{ ok: false, reason }`.
//   declarations: `declaredViews()` of mixins/persisted-view.js, once every page and component module is loaded.
//   appearance: `{ key, ids }`, the settings key of the colour preset and the ids of the presets this version has.
//   separators: the thousands separators the Display panel offers.
export const buildSchema = ({ declarations, appearance, font, separators }) => {
//   font: `{ key, read }`, the settings key of the typeface and text size and `readFont` of utilities/appearance-font.js, which says whether a value names a typeface and a text size this version offers.
  const fields = new Map()
  const add = (category, scope, key, check) => fields.set(`${category}:${scope}:${key}`, { category, scope, key, check })

  add('appearance', 'app', appearance.key, (value) => (typeof value === 'string' && appearance.ids.includes(value) ? { ok: true, value } : { ok: false, reason: 'is not a preset this version has' }))
  add('display', 'app', 'spyNPR', (value) => (typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'must be true or false' }))
  add('display', 'app', 'selectedSeparator', (value) => (separators.includes(value) ? { ok: true, value } : { ok: false, reason: `must be one of ${separators.join(', ')}` }))
  add('appearance', 'app', font.key, (value) => {
    const read = font.read(value)

    return read.ok ? { ok: true, value: read.font } : { ok: false, reason: 'is not a typeface and text size this version offers' }
  })

  const byKey = new Map()

  declarations.filter(({ key }) => !EXCLUDED_KEYS.includes(key) && !DISPLAY_KEYS.includes(key) && key !== appearance.key).forEach((declaration) => {
    const id = `${declaration.scope}:${declaration.key}`

    byKey.set(id, [...(byKey.get(id) || []), declaration])
  })

  byKey.forEach((list) => {
    const { key, scope } = list[0]

    add(MAP_GROUP_KEYS.includes(key) ? 'mapGroups' : 'views', scope, key, checkDeclared(list))
  })

  return fields
}

// Every field of a category, for the export.
const fieldsOf = (schema, category) => [...schema.values()].filter((field) => field.category === category)

// The empire's stored value of a field, and the key it lives under.
const storedKey = (field, { gameId, raceId }) => (field.scope === 'race' ? `${racePrefix(gameId, raceId)}.${field.key}` : field.key)

const knownIds = ({ gameId, raceId }) => ID.test(String(gameId)) && ID.test(String(raceId))

// The bundle for the chosen categories, from the stored settings of the empire `source` ({ gameId, raceId, gameName, raceName }). A stored value that its page would not restore is left out and listed in `skipped`. `keys` lists every key written (as stored, with the empire's prefix for the race ones). Without an empire (`source.raceId` null), the race keys are not exported.
export const buildExport = (schema, store, source, categories, now = new Date()) => {
  const out = {}
  const keys = []
  const skipped = []
  const withEmpire = knownIds(source)

  CATEGORIES.filter(({ id }) => categories.includes(id)).forEach(({ id }) => {
    fieldsOf(schema, id).filter((field) => field.scope === 'app' || withEmpire).forEach((field) => {
      const fullKey = storedKey(field, source)
      const stored = getPath(store, fullKey)

      if (stored === undefined) {
        return
      }

      const result = field.check(stored)

      if (!result.ok) {
        skipped.push({ key: field.key, scope: field.scope, reason: result.reason })

        return
      }

      out[id] = out[id] || {}
      out[id][field.scope] = out[id][field.scope] || {}
      out[id][field.scope][field.key] = result.value
      keys.push(fullKey)
    })
  })

  const bundle = {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    source: {
      gameId: withEmpire ? Number(source.gameId) : null,
      raceId: withEmpire ? Number(source.raceId) : null,
      gameName: source.gameName || null,
      raceName: source.raceName || null,
    },
    categories: out,
  }

  return { bundle, keys, skipped }
}

// A file name for an export: the empire's name, then the date.
export const exportName = (source, now = new Date()) => {
  const slug = String(source.raceName || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'

  return `aurora-electrons-preferences-${slug}-${now.toISOString().slice(0, 10)}.json`
}

const SOURCE_KEYS = ['gameId', 'raceId', 'gameName', 'raceName']
const BUNDLE_KEYS = ['format', 'version', 'exportedAt', 'source', 'categories']

const fieldName = (path) => (path.length > 90 ? `${path.slice(0, 89)}…` : path)

// Checks a file's text against the allowlist, changing nothing. `{ errors }` lists each fault by field name (an unknown key, a value no page accepts, a wrong format or version), and an empty list means `{ bundle, entries }`: the entries the bundle holds as `{ category, scope, key, value }`, every value as it would be kept.
export const parseBundle = (text, schema) => {
  const errors = []
  const fail = (field, message) => errors.push({ field: fieldName(field), message })

  if (typeof text !== 'string' || !text.trim()) {
    return { errors: [{ field: 'file', message: 'is empty' }] }
  }

  if (text.length > MAX_BYTES) {
    return { errors: [{ field: 'file', message: `is larger than ${MAX_BYTES / 1024} KiB` }] }
  }

  let bundle

  try {
    bundle = JSON.parse(text)
  } catch (error) {
    return { errors: [{ field: 'file', message: 'is not JSON' }] }
  }

  if (!isObject(bundle)) {
    return { errors: [{ field: 'file', message: 'does not hold an object' }] }
  }

  if (bundle.format !== FORMAT) {
    return { errors: [{ field: 'format', message: `must be "${FORMAT}"` }] }
  }

  if (bundle.version !== VERSION) {
    return { errors: [{ field: 'version', message: typeof bundle.version === 'number' && bundle.version > VERSION ? `${bundle.version} is newer than this version reads (${VERSION})` : `must be ${VERSION}` }] }
  }

  Object.keys(bundle).filter((key) => !BUNDLE_KEYS.includes(key)).forEach((key) => fail(key, 'is not a field of a bundle'))

  if (has(bundle, 'exportedAt') && (typeof bundle.exportedAt !== 'string' || Number.isNaN(Date.parse(bundle.exportedAt)))) {
    fail('exportedAt', 'must be a date')
  }

  if (has(bundle, 'source')) {
    const { source } = bundle

    if (isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (!SOURCE_KEYS.includes(key)) {
          fail(`source.${key}`, 'is not a field of the source')
        } else if (source[key] !== null && (key.endsWith('Id') ? !Number.isInteger(source[key]) || source[key] < 0 : typeof source[key] !== 'string')) {
          fail(`source.${key}`, key.endsWith('Id') ? 'must be a whole number or null' : 'must be text or null')
        }
      })
    } else {
      fail('source', 'must be an object')
    }
  }

  const entries = []

  if (!isObject(bundle.categories)) {
    fail('categories', 'must be an object')
  } else {
    Object.entries(bundle.categories).forEach(([category, parts]) => {
      if (!CATEGORIES.some(({ id }) => id === category)) {
        fail(`categories.${category}`, 'is not a category that can be imported')

        return
      }

      if (!isObject(parts)) {
        fail(`categories.${category}`, 'must be an object')

        return
      }

      Object.entries(parts).forEach(([scope, values]) => {
        if (scope !== 'app' && scope !== 'race') {
          fail(`categories.${category}.${scope}`, 'must be "app" or "race"')

          return
        }

        if (!isObject(values)) {
          fail(`categories.${category}.${scope}`, 'must be an object')

          return
        }

        Object.entries(values).forEach(([key, value]) => {
          const path = `categories.${category}.${scope}.${key}`
          const field = schema.get(`${category}:${scope}:${key}`)

          if (!field) {
            fail(path, 'is not a preference that can be imported')

            return
          }

          const result = field.check(value)

          if (result.ok) {
            entries.push({ category, scope, key, value: result.value })
          } else {
            fail(path, result.reason)
          }
        })
      })
    })
  }

  return errors.length ? { errors } : { bundle, entries }
}

const present = (value) => value !== null && value !== undefined && value !== ''

// How the bundle's source relates to the empire it is imported into. `confirm` is true for a source that cannot be told from the target's campaign: a bundle without ids (an older or hand-made one), ids that match a campaign of another name, or a name that matches under other ids. Aurora's ids repeat between saves and names are not unique, so only a match of both is called the same campaign.
export const assessIdentity = (source, target) => {
  const known = isObject(source) && present(source.gameId) && present(source.raceId)

  if (!known) {
    return { status: 'unknown', confirm: true, text: 'The file does not say which campaign and empire it came from, so it cannot be matched to this one.' }
  }

  const sameId = Number(source.gameId) === Number(target.gameId)
  const sameName = present(source.gameName) && present(target.gameName) && source.gameName === target.gameName

  if (sameId && sameName) {
    return { status: 'same', confirm: false, text: 'The file came from this campaign.' }
  }

  if (sameId) {
    return { status: 'ambiguous', confirm: true, text: `The file's campaign id matches this one, but its name ${present(source.gameName) ? `("${source.gameName}") differs from this campaign's` : 'is missing'}, so it may be another campaign that reuses the id.` }
  }

  if (sameName) {
    return { status: 'ambiguous', confirm: true, text: `The file's campaign has this campaign's name but another id (${source.gameId}, here ${target.gameId}), so it may be the same campaign in another save or a different one with the same name.` }
  }

  return { status: 'different', confirm: false, text: `The file came from another campaign${present(source.gameName) ? ` ("${source.gameName}")` : ''}. Values that name its systems, fleets, species or alien races stay as they are.` }
}

// The preview of an import of the parsed `entries` for the chosen `categories`, into the empire `target` ({ gameId, raceId, gameName, raceName }; ids null without one), over the stored settings `store`:
// - `changes`: each key that would be written, `{ category, scope, key, fullKey, old, value }` (`old` undefined for none). The commit writes these and nothing else.
// - `unchanged`: selected values the settings already hold.
// - `excluded`: EXCLUDED, then the categories in the file that are not selected.
// - `problems`: why nothing can be imported yet (race values without an empire, a stored value in the way).
// - `identity` and `needsConfirmation`: the source against the target, and whether a confirmation is required before the commit, which is only when race values are among the selection.
export const planImport = ({ store, entries, source, target, categories }) => {
  const selected = entries.filter(({ category }) => categories.includes(category))
  const withEmpire = knownIds(target)
  const problems = []
  const changes = []
  let unchanged = 0

  selected.forEach(({ category, scope, key, value }) => {
    if (scope === 'race' && !withEmpire) {
      return
    }

    const fullKey = scope === 'race' ? `${racePrefix(target.gameId, target.raceId)}.${key}` : key
    const parents = fullKey.split('.').slice(0, -1)
    const blocking = parents.map((_, index) => parents.slice(0, index + 1).join('.')).find((path) => getPath(store, path) !== undefined && !isObject(getPath(store, path)))
    const old = getPath(store, fullKey)

    if (blocking) {
      problems.push(`${fullKey}: the settings hold something other than a group at "${blocking}"`)
    } else if (sameValue(old, value)) {
      unchanged += 1
    } else {
      changes.push({ category, scope, key, fullKey, old: clone(old), value: clone(value) })
    }
  })

  const raceSelected = selected.filter(({ scope }) => scope === 'race')

  if (raceSelected.length && !withEmpire) {
    problems.push(`${raceSelected.length} empire value${raceSelected.length === 1 ? '' : 's'} selected, and no empire is picked to take them`)
  }

  const identity = assessIdentity(source, target)
  const notSelected = CATEGORIES.filter(({ id }) => entries.some(({ category }) => category === id) && !categories.includes(id)).map(({ id, title }) => ({ id, title, reason: 'In the file, not selected.' }))

  return { changes, unchanged, problems, identity, needsConfirmation: identity.confirm && raceSelected.length > 0, excluded: [...notSelected, ...EXCLUDED] }
}

// The settings after the plan's changes, and the backup that undoes them: `{ store, backup }`. `store` is a copy; the argument is not changed. The backup holds exactly the keys written, each with the value it replaced (`had` false when there was none) and the groups the import created, so an undo leaves nothing behind.
export const commitImport = (store, plan, { target, source, now = new Date() }) => {
  const next = clone(store)
  const entries = []
  const created = []

  plan.changes.forEach(({ fullKey, old, value }) => {
    const parts = fullKey.split('.').slice(0, -1)
    const missing = parts.map((_, index) => parts.slice(0, index + 1).join('.')).find((path) => getPath(next, path) === undefined)

    if (missing && !created.some((path) => missing === path || missing.startsWith(`${path}.`))) {
      created.push(missing)
    }

    entries.push({ key: fullKey, had: old !== undefined, old: clone(old) })
    setPath(next, fullKey, clone(value))
  })

  const backup = {
    format: BACKUP_FORMAT,
    version: VERSION,
    at: now.toISOString(),
    target: { gameId: target.gameId, raceId: target.raceId, gameName: target.gameName || null, raceName: target.raceName || null },
    source: isObject(source) ? { gameId: source.gameId ?? null, raceId: source.raceId ?? null, gameName: source.gameName ?? null, raceName: source.raceName ?? null } : null,
    entries,
    created,
  }

  return { store: next, backup }
}

// Whether a stored backup is one this version wrote and every key in it is a path the import could have written.
export const validBackup = (backup) => isObject(backup) && backup.format === BACKUP_FORMAT && backup.version === VERSION && Array.isArray(backup.entries) && Array.isArray(backup.created) && backup.entries.every((entry) => isObject(entry) && safePath(entry.key) && typeof entry.had === 'boolean') && backup.created.every(safePath)

// The settings with the backup's keys put back as they were: `{ store, restored }`. A key the import created is deleted, and so is each group it created that is empty again. Throws on a backup that fails `validBackup`.
export const undoImport = (store, backup) => {
  if (!validBackup(backup)) {
    throw new Error('The undo backup is damaged')
  }

  const next = clone(store)

  backup.entries.forEach(({ key, had, old }) => {
    if (had) {
      setPath(next, key, clone(old))
    } else {
      deletePath(next, key)
    }
  })

  backup.created.forEach((path) => {
    const touched = backup.entries.filter(({ key }) => key.startsWith(`${path}.`))

    // Deepest group first, so a group that only held another empty one goes too.
    const groups = new Set(touched.flatMap(({ key }) => {
      const parts = key.split('.').slice(0, -1)

      return parts.map((_, index) => parts.slice(0, index + 1).join('.')).filter((group) => group === path || group.startsWith(`${path}.`))
    }))

    ;[...groups].sort((a, b) => b.length - a.length).forEach((group) => pruneEmpty(next, group))
  })

  return { store: next, restored: backup.entries.length }
}

// The keys whose values differ between two stores, as full paths, for checking that a commit wrote what was previewed and an undo left nothing.
export const differingKeys = (before, after) => {
  const leaves = (value, prefix = '') => (isObject(value) && Object.keys(value).length ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, prefix ? `${prefix}.${key}` : key)) : [[prefix, value]])
  const left = new Map(leaves(before))
  const right = new Map(leaves(after))

  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => !sameValue(left.get(key), right.get(key))).sort()
}
