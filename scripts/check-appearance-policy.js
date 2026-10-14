#!/usr/bin/env node
/*
  The theme policy (src/renderer/utilities/appearance.js: `appearancePolicy`, `applyPolicy`, `adoptAppearance`, `followSystem`, `nativeThemeSource`, `quickSwitch`), checked without a browser.

  It proves: the policy (Light, Dark or System) is kept apart from a named appearance (Classic, Solaris, T2D, the imported one) that replaces the theme; the older settings (`darkMode`, a baseline id under `appearance`) migrate once and keep their meaning; an operating system change updates only the System policy (a pinned policy, a named appearance and an open preview stay where they are, and nothing is written); a restart reads the policy and the named appearance back; the lamp in the app bar always applies the opposite of the mode drawn as an explicit policy and says what it replaces; the native theme source is asked for what keeps the system's own scheme visible under System; one observer follows the system at a time and removes its listener; the preferences carry the policy and the explicit `theme` value that ends a named appearance, and an older bundle still imports; a reset of the remembered views keeps the policy; and the preview, apply, cancel and reset of the presets keep their rules (a failed write changes nothing).

  What a browser shows (a live colour scheme change drawing the charts, the maps and Vuetify, the lamp, the Theme control) is probed separately with Playwright, and the main process's `theme:source` handler needs Electron; the runs are recorded in docs/plans/backlog/evidence/AE-017-01.md.

  Run: node scripts/check-appearance-policy.js
*/
const fs = require('fs')
const os = require('os')
const path = require('path')

const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

let instance = 0

const NAMES = ['appearance-font', 'appearance', 'appearance-file', 'preferences', 'remembered-views']

// A fresh copy of the modules, so the state of one check never reaches another; `directory` is a copy of the utilities folder with a planted fault.
const load = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(NAMES, { directory, stubs: { vue: `export default { observable: (value) => value, set: (target, key, value) => { target[key] = value } }\n// instance ${instance++}` } })

  return { font: loaded['appearance-font'], appearance: loaded.appearance, preferences: loaded.preferences, views: loaded['remembered-views'], reload: () => load(directory) }
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

// A MediaQueryList of the colour scheme query: `flip` is the system changing, and the counts are what the observer did to it.
const fakeMedia = (dark) => ({
  matches: dark,
  listeners: new Set(),
  added: 0,
  removed: 0,
  addEventListener(type, listener) {
    if (type === 'change') {
      this.added++
      this.listeners.add(listener)
    }
  },
  removeEventListener(type, listener) {
    if (type === 'change') {
      this.removed++
      this.listeners.delete(listener)
    }
  },
  flip(next) {
    this.matches = next
    ;[...this.listeners].forEach((listener) => listener({ matches: next }))
  },
})

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// What an app start does (layouts/default.vue): follow the system first, then read the settings.
const start = (ctx, stored, { dark = false } = {}) => {
  const config = fakeConfig(stored)
  const media = fakeMedia(dark)
  const follower = ctx.appearance.followSystem(media)

  ctx.appearance.loadAppearance(config)

  return { config, media, follower }
}

// What the layout does after a change of the native theme source, with Electron's behaviour: a source other than `system` makes the colour scheme query report that mode (`os.dark` is the system's own scheme, which the query then does not show), and `system` makes it report the system's, which the main process also answers.
const syncNative = (ctx, { media }, os) => ctx.appearance.requestNativeTheme((source) => {
  media.flip(source === 'system' ? os.dark : source === 'dark')

  return { dark: os.dark }
})

// A request of the native theme whose answer is held until `reply(answer)` is called: the page's `ipcRenderer.invoke` with a main process that is slow to answer.
const slowNative = (ctx) => {
  let reply
  const done = ctx.appearance.requestNativeTheme(() => new Promise((resolve) => {
    reply = resolve
  }))

  return { done, reply: (answer) => { reply(answer); return done } }
}

// The schema the Settings page builds for the theme, with the older form of a baseline id mapped to its policy.
const themeSchema = (ctx, declarations = []) => ctx.preferences.buildSchema({ declarations, appearance: { key: 'appearance', ids: [...ctx.appearance.listAppearances().map(({ id }) => id), ctx.appearance.NO_OVERRIDE], none: ctx.appearance.NO_OVERRIDE, baselines: ctx.appearance.BASELINE_POLICIES }, policy: { key: ctx.appearance.POLICY_KEY, values: ctx.appearance.POLICIES }, font: { key: ctx.font.FONT_KEY, read: ctx.font.readFont }, separators: [','] })

const bundleOf = (values) => JSON.stringify({ format: 'aurora-electrons-preferences', version: 1, categories: { appearance: { app: values } } })

// What is drawn and kept now.
const seen = (ctx) => {
  const a = ctx.appearance

  return { drawn: a.activeAppearance().id, applied: a.appliedPresetId(), policy: a.appearancePolicy(), override: a.appearanceOverride(), previewing: a.isPreviewing() }
}

// Compares what is seen with what is wanted (only the keys the wanted object names) and adds a problem for each difference.
const expectSeen = (ctx, wanted, label, problems) => {
  const actual = seen(ctx)

  Object.keys(wanted).forEach((key) => {
    if (JSON.stringify(actual[key]) !== JSON.stringify(wanted[key])) {
      problems.push(`${label}: ${key} is ${short(actual[key])}, wanted ${short(wanted[key])}`)
    }
  })
}

// The same with the keys of every object in alphabetical order, so the order a write puts them in does not matter.
const canonical = (value) => JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner))

const expectEqual = (actual, wanted, label, problems) => {
  if (canonical(actual) !== canonical(wanted)) {
    problems.push(`${label}: ${short(actual)}, wanted ${short(wanted)}`)
  }
}

const verdict = (problems) => (problems.length ? problems.join('; ') : true)

// The named appearances, one of each mode, so a check does not hard-code which preset is dark.
const named = (ctx) => {
  const ids = ctx.appearance.listAppearances().filter(({ id }) => !['light', 'dark'].includes(id))
  const light = ids.find(({ mode }) => mode === 'light')
  const dark = ids.find(({ mode }) => mode === 'dark')

  return { light, dark, ids }
}

const POLICY_VALUES = ['light', 'dark', 'system']

const CHECKS = [
  ['a settings file with nothing starts on the Light policy, with no named appearance and no write', async (ctx) => {
    const problems = []
    const { config } = start(ctx, {})

    expectSeen(ctx, { drawn: 'light', applied: 'light', policy: 'light', override: null, previewing: false }, 'empty settings', problems)
    expectEqual(config.writes, [], 'writes', problems)

    return verdict(problems)
  }],

  ['the older boolean darkMode becomes the policy once, is kept in the file and is not read again once a policy is there', async (ctx) => {
    const problems = []

    for (const [dark, mode] of [[true, 'dark'], [false, 'light']]) {
      const { config } = start(ctx, { darkMode: dark })

      expectSeen(ctx, { drawn: mode, policy: mode, override: null }, `darkMode ${dark}`, problems)
      expectEqual(config.data, { darkMode: dark, appearancePolicy: mode, appearance: 'theme' }, `the file after darkMode ${dark}`, problems)
      expectEqual(config.writes.length, 1, `writes after darkMode ${dark}`, problems)

      const again = start(ctx, config.data)

      expectEqual(again.config.writes, [], `writes at the next start after darkMode ${dark}`, problems)
      expectSeen(ctx, { drawn: mode, policy: mode }, `the next start after darkMode ${dark}`, problems)
    }

    const kept = start(ctx, { darkMode: true, appearancePolicy: 'light' })

    expectSeen(ctx, { policy: 'light', drawn: 'light' }, 'darkMode beside a policy', problems)
    expectEqual(kept.config.writes, [], 'writes for darkMode beside a policy', problems)

    const odd = start(ctx, { darkMode: 'yes' })

    expectSeen(ctx, { policy: 'light' }, 'a darkMode that is no boolean', problems)
    expectEqual(odd.config.writes, [], 'writes for a darkMode that is no boolean', problems)

    return verdict(problems)
  }],

  ['a baseline id under appearance (the form before the policy) becomes the policy, replaces a stored policy and is written back once', async (ctx) => {
    const problems = []

    for (const [id, stored, mode] of [['dark', undefined, 'dark'], ['light', undefined, 'light'], ['dark', 'light', 'dark'], ['light', 'system', 'light'], ['dark', 'system', 'dark']]) {
      const settings = { appearance: id, ...(stored ? { appearancePolicy: stored } : {}) }
      const { config } = start(ctx, settings)

      expectSeen(ctx, { drawn: mode, policy: mode, override: null }, `appearance ${id} with policy ${stored}`, problems)
      expectEqual(config.data, { appearance: 'theme', appearancePolicy: mode }, `the file after appearance ${id} with policy ${stored}`, problems)
      expectEqual(config.writes.length, 1, `writes after appearance ${id} with policy ${stored}`, problems)
    }

    const both = start(ctx, { appearance: 'light', darkMode: true })

    expectSeen(ctx, { policy: 'light', drawn: 'light' }, 'appearance light beside darkMode true', problems)
    expectEqual(both.config.data.darkMode, true, 'darkMode kept in the file', problems)

    return verdict(problems)
  }],

  ['a named appearance without a policy takes its own mode as the policy with no write; a stored policy is kept; an unknown id and an invalid policy are left alone', async (ctx) => {
    const problems = []
    const { light, dark } = named(ctx)

    for (const preset of [light, dark].filter(Boolean)) {
      const { config } = start(ctx, { appearance: preset.id })

      expectSeen(ctx, { override: preset.id, policy: preset.mode, drawn: preset.id }, `${preset.id} alone`, problems)
      expectEqual(config.writes, [], `writes for ${preset.id} alone`, problems)

      const withPolicy = start(ctx, { appearance: preset.id, appearancePolicy: 'system' }, { dark: preset.mode === 'light' })

      expectSeen(ctx, { override: preset.id, policy: 'system', drawn: preset.id }, `${preset.id} with System`, problems)
      expectEqual(withPolicy.config.writes, [], `writes for ${preset.id} with System`, problems)
    }

    const unknown = start(ctx, { appearance: 'from-the-future', appearancePolicy: 'dark' })

    expectSeen(ctx, { override: null, policy: 'dark', drawn: 'dark' }, 'an unknown id', problems)
    expectEqual(unknown.config.writes, [], 'writes for an unknown id', problems)
    expectEqual(ctx.appearance.unsupportedPresetId(unknown.config), 'from-the-future', 'the unsupported id', problems)

    const invalid = start(ctx, { appearancePolicy: 'auto' })

    expectSeen(ctx, { policy: 'light', drawn: 'light' }, 'an invalid policy', problems)
    expectEqual(invalid.config.writes, [], 'writes for an invalid policy', problems)
    expectEqual(invalid.config.data, { appearancePolicy: 'auto' }, 'the invalid policy left in the file', problems)

    return verdict(problems)
  }],

  ['a stored policy is read at start: Dark and System draw what they say', async (ctx) => {
    const problems = []

    start(ctx, { appearancePolicy: 'dark', appearance: 'theme' })
    expectSeen(ctx, { policy: 'dark', drawn: 'dark', override: null }, 'Dark', problems)

    start(ctx, { appearancePolicy: 'system' }, { dark: true })
    expectSeen(ctx, { policy: 'system', drawn: 'dark' }, 'System, system dark', problems)

    start(ctx, { appearancePolicy: 'system' }, { dark: false })
    expectSeen(ctx, { policy: 'system', drawn: 'light' }, 'System, system light', problems)

    return verdict(problems)
  }],

  ['a system change under the System policy redraws the baseline of the new scheme, keeps the policy and writes nothing', async (ctx) => {
    const problems = []
    const { config, media } = start(ctx, { appearancePolicy: 'system', appearance: 'theme' }, { dark: false })

    expectSeen(ctx, { drawn: 'light' }, 'system light', problems)
    media.flip(true)
    expectSeen(ctx, { drawn: 'dark', applied: 'dark', policy: 'system', override: null, previewing: false }, 'after the flip to dark', problems)
    expectEqual(ctx.appearance.systemMode(), 'dark', 'the observed scheme', problems)
    media.flip(false)
    expectSeen(ctx, { drawn: 'light', applied: 'light', policy: 'system' }, 'after the flip to light', problems)
    expectEqual(config.writes, [], 'writes during the flips', problems)
    expectEqual(config.data, { appearancePolicy: 'system', appearance: 'theme' }, 'the file after the flips', problems)

    return verdict(problems)
  }],

  ['a system change leaves a pinned policy and a named appearance selected and writes nothing', async (ctx) => {
    const problems = []

    for (const policy of ['light', 'dark']) {
      const { config, media, follower } = start(ctx, { appearancePolicy: policy, appearance: 'theme' }, { dark: false })

      media.flip(true)
      media.flip(false)
      media.flip(true)
      follower.refresh(false)
      follower.refresh(true)
      expectSeen(ctx, { drawn: policy, policy, override: null }, `pinned ${policy}`, problems)
      expectEqual(config.writes, [], `writes under ${policy}`, problems)
    }

    const { ids } = named(ctx)

    for (const preset of ids) {
      for (const policy of POLICY_VALUES) {
        const { config, media, follower } = start(ctx, { appearance: preset.id, appearancePolicy: policy }, { dark: false })

        media.flip(true)
        media.flip(false)
        media.flip(true)
        follower.refresh(false)
        follower.refresh(true)
        expectSeen(ctx, { drawn: preset.id, applied: preset.id, override: preset.id, policy }, `${preset.id} over ${policy} after the flips`, problems)
        expectEqual(config.writes, [], `writes under ${preset.id} over ${policy}`, problems)
        expectEqual(config.data.appearance, preset.id, `the file's appearance under ${preset.id} over ${policy}`, problems)
      }
    }

    return verdict(problems)
  }],

  ['under a named appearance the System policy is kept and takes over once the appearance ends', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const { config, media } = start(ctx, { appearancePolicy: 'system', appearance: dark.id }, { dark: false })

    expectSeen(ctx, { drawn: dark.id, policy: 'system' }, 'the named appearance over System', problems)
    const os = { dark: false }
    const handle = { media, follower: ctx.appearance.followSystem(media) }

    await syncNative(ctx, handle, os)
    os.dark = true
    ctx.appearance.applyPolicy(config, 'system')
    expectSeen(ctx, { drawn: 'light', override: null, policy: 'system' }, 'System chosen again before the native source is answered (the scheme last read)', problems)
    await syncNative(ctx, handle, os)
    expectSeen(ctx, { drawn: 'dark', override: null, policy: 'system' }, 'System chosen again while the system is dark', problems)
    media.flip(false)
    expectSeen(ctx, { drawn: 'light' }, 'the system back to light', problems)

    return verdict(problems)
  }],

  ['a preview stays across a system change and a cancel lands on what the new scheme applies', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const { config, media } = start(ctx, { appearancePolicy: 'system' }, { dark: false })

    ctx.appearance.previewPreset(dark.id)
    expectEqual(config.writes, [], 'writes by a preview', problems)
    expectSeen(ctx, { drawn: dark.id, applied: 'light', previewing: true }, 'the preview', problems)
    media.flip(true)
    expectSeen(ctx, { drawn: dark.id, applied: 'dark', previewing: true, policy: 'system' }, 'the preview after the flip', problems)
    ctx.appearance.cancelPreview()
    expectSeen(ctx, { drawn: 'dark', applied: 'dark', previewing: false }, 'after the cancel', problems)

    return verdict(problems)
  }],

  ['a preview of a baseline stays a preview when the system reaches it: Apply and Cancel are still there at the transition, and a round trip of the system changes nothing', async (ctx) => {
    const problems = []

    for (const [os, preview, reached] of [[false, 'dark', true], [true, 'light', false]]) {
      const other = os ? 'dark' : 'light'
      const { config, media } = start(ctx, { appearancePolicy: 'system' }, { dark: os })

      ctx.appearance.previewPreset(preview)
      expectSeen(ctx, { drawn: preview, applied: other, previewing: true }, `the ${preview} preview under System, system ${other}`, problems)
      media.flip(reached)
      expectSeen(ctx, { drawn: preview, applied: preview, previewing: true, policy: 'system' }, `the ${preview} preview once the system is ${preview}`, problems)
      media.flip(os)
      expectSeen(ctx, { drawn: preview, applied: other, previewing: true }, `the ${preview} preview after the system came back`, problems)
      media.flip(reached)
      ctx.appearance.cancelPreview()
      expectSeen(ctx, { drawn: preview, applied: preview, previewing: false }, `a cancel at the transition (${preview})`, problems)
      media.flip(os)
      expectSeen(ctx, { drawn: other, applied: other, previewing: false }, `the system after the cancel (${preview})`, problems)

      ctx.appearance.previewPreset(preview)
      media.flip(reached)
      config.writes.length = 0
      expectEqual(ctx.appearance.applyPreset(config, preview), true, `Apply at the transition (${preview})`, problems)
      expectSeen(ctx, { drawn: preview, applied: preview, previewing: false, policy: preview, override: null }, `after Apply at the transition (${preview})`, problems)
      expectEqual(config.data, { appearancePolicy: preview, appearance: 'theme' }, `the file after Apply at the transition (${preview})`, problems)
      media.flip(os)
      expectSeen(ctx, { drawn: preview, applied: preview, previewing: false }, `the system after Apply (${preview})`, problems)
    }

    const { config, media } = start(ctx, { appearancePolicy: 'system' }, { dark: false })

    ctx.appearance.previewPreset('light')
    expectSeen(ctx, { previewing: false, drawn: 'light' }, 'the preset already applied is no preview', problems)
    ctx.appearance.previewPreset('dark')
    ctx.appearance.previewPreset('light')
    expectSeen(ctx, { previewing: false, drawn: 'light' }, 'a preview put back on the applied preset', problems)

    const { dark } = named(ctx)

    ctx.appearance.previewPreset(dark.id)
    media.flip(true)
    media.flip(false)
    expectSeen(ctx, { previewing: true, drawn: dark.id }, 'a named preview across a round trip', problems)
    ctx.appearance.cancelPreview()
    ctx.appearance.importAppearanceFile(JSON.stringify(ctx.appearance.exportAppearanceFile('solaris')))
    media.flip(true)
    expectSeen(ctx, { previewing: true, drawn: 'custom-draft' }, 'a file preview across a change', problems)
    ctx.appearance.cancelPreview()
    expectSeen(ctx, { previewing: false, drawn: 'dark' }, 'a cancel of the file preview', problems)
    expectEqual(config.writes, [], 'writes by the previews', problems)

    return verdict(problems)
  }],

  ['a restart reads the policy and the named appearance back, the imported one included', async (ctx) => {
    const problems = []
    const first = start(ctx, {}, { dark: false })
    const { ids } = named(ctx)

    ctx.appearance.applyPolicy(first.config, 'system')

    const second = await ctx.reload()

    let again = start(second, first.config.data, { dark: true })

    expectSeen(second, { policy: 'system', drawn: 'dark', override: null }, 'System after a restart', problems)
    expectEqual(again.config.writes, [], 'writes at the restart', problems)

    ctx.appearance.applyPreset(first.config, ids[0].id)

    const third = await ctx.reload()

    again = start(third, first.config.data, { dark: true })
    expectSeen(third, { policy: 'system', override: ids[0].id, drawn: ids[0].id }, `${ids[0].id} over System after a restart`, problems)

    const file = JSON.stringify(ctx.appearance.exportAppearanceFile('solaris'))
    const imported = ctx.appearance.importAppearanceFile(file)

    if (!imported.ok) {
      problems.push(`the file of a preset is not imported: ${short(imported.errors)}`)

      return verdict(problems)
    }

    ctx.appearance.applyPreset(first.config, 'custom-draft')
    expectSeen(ctx, { override: 'custom', drawn: 'custom', policy: 'system' }, 'the imported appearance kept', problems)

    const fourth = await ctx.reload()

    start(fourth, first.config.data, { dark: false })
    expectSeen(fourth, { override: 'custom', drawn: 'custom', policy: 'system' }, 'the imported appearance after a restart', problems)
    ctx.appearance.removeCustom(first.config)
    expectSeen(ctx, { override: null, policy: 'system' }, 'the imported appearance removed', problems)
    expectEqual(first.config.data.appearance, 'theme', 'the file after the removal', problems)
    expectEqual(first.config.data.appearancePolicy, 'system', 'the policy after the removal', problems)

    return verdict(problems)
  }],

  ['removing the imported appearance keeps the policy in force, which is the mode of the file when none was kept', async (ctx) => {
    const problems = []
    const first = start(ctx, {})

    ctx.appearance.importAppearanceFile(JSON.stringify(ctx.appearance.exportAppearanceFile('solaris')))
    ctx.appearance.applyPreset(first.config, 'custom-draft')

    const mode = ctx.appearance.activeAppearance().mode

    ctx.appearance.removeCustom(first.config)
    expectSeen(ctx, { override: null, policy: mode, drawn: mode }, 'the appearance removed with no policy kept', problems)
    expectEqual(first.config.data.appearancePolicy, mode, 'the policy written', problems)

    return verdict(problems)
  }],

  ['the lamp applies the opposite of the mode drawn as an explicit policy and says what it replaces', async (ctx) => {
    const problems = []
    const { ids } = named(ctx)
    const cases = [
      ['Light', { appearancePolicy: 'light' }, false, 'dark', null],
      ['Dark', { appearancePolicy: 'dark' }, false, 'light', null],
      ['System, system dark', { appearancePolicy: 'system' }, true, 'light', 'System'],
      ['System, system light', { appearancePolicy: 'system' }, false, 'dark', 'System'],
      ...ids.map((preset) => [preset.id, { appearance: preset.id, appearancePolicy: 'dark' }, false, preset.mode === 'dark' ? 'light' : 'dark', preset.name]),
    ]

    for (const [label, stored, dark, mode, replaces] of cases) {
      const { config, media } = start(ctx, stored, { dark })

      expectEqual(ctx.appearance.quickSwitch(), { mode, replaces }, `the lamp under ${label}`, problems)
      ctx.appearance.applyPolicy(config, ctx.appearance.quickSwitch().mode)
      expectSeen(ctx, { policy: mode, override: null, drawn: mode, previewing: false }, `after the lamp under ${label}`, problems)
      expectEqual(config.data.appearance, 'theme', `the file's appearance after the lamp under ${label}`, problems)
      expectEqual(config.data.appearancePolicy, mode, `the file's policy after the lamp under ${label}`, problems)
      media.flip(!dark)
      expectSeen(ctx, { drawn: mode, policy: mode }, `a system change after the lamp under ${label}`, problems)
      expectEqual(ctx.appearance.quickSwitch(), { mode: mode === 'dark' ? 'light' : 'dark', replaces: null }, `the lamp after the lamp under ${label}`, problems)
    }

    return verdict(problems)
  }],

  ['applyPolicy keeps a policy and ends the named appearance in one write, refuses an unknown policy and a failed write changes nothing', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const { config } = start(ctx, { appearance: dark.id, appearancePolicy: 'light' })

    config.writes.length = 0

    if (ctx.appearance.applyPolicy(config, 'auto') !== false || config.writes.length) {
      problems.push('an unknown policy is applied or written')
    }

    config.failNext = true

    try {
      ctx.appearance.applyPolicy(config, 'system')
      problems.push('a failed write did not throw')
    } catch (error) {
      expectSeen(ctx, { policy: 'light', override: dark.id, drawn: dark.id }, 'state after a failed write', problems)
      expectEqual(config.data, { appearance: dark.id, appearancePolicy: 'light' }, 'file after a failed write', problems)
    }

    config.writes.length = 0
    expectEqual(ctx.appearance.applyPolicy(config, 'system'), true, 'the result', problems)
    expectEqual(config.writes, [{ via: 'store', keys: ['appearance', 'appearancePolicy'] }], 'the writes', problems)
    expectEqual(config.data, { appearance: 'theme', appearancePolicy: 'system' }, 'the file', problems)

    return verdict(problems)
  }],

  ['a baseline id applied as a preset is a policy, and a named one replaces the theme with the policy kept; a failed write changes nothing; a preview writes nothing', async (ctx) => {
    const problems = []
    const { ids, dark } = named(ctx)
    const other = ids.find(({ id }) => id !== dark.id)
    const { config } = start(ctx, { appearancePolicy: 'system' }, { dark: false })

    config.writes.length = 0
    ctx.appearance.previewPreset('dark')
    ctx.appearance.previewPreset(dark.id)
    expectEqual(config.writes, [], 'writes by previews', problems)
    expectSeen(ctx, { drawn: dark.id, applied: 'light', previewing: true }, 'the preview', problems)
    ctx.appearance.cancelPreview()
    expectSeen(ctx, { drawn: 'light', previewing: false }, 'the cancel', problems)

    ctx.appearance.previewPreset(dark.id)
    expectSeen(ctx, { previewing: true, drawn: dark.id }, 'the named preset previewed', problems)
    config.writes.length = 0
    ctx.appearance.applyPreset(config, dark.id)
    expectEqual(config.writes, [{ via: 'set', keys: ['appearance'] }], 'writes by a named preset', problems)
    expectSeen(ctx, { override: dark.id, policy: 'system', drawn: dark.id, applied: dark.id, previewing: false }, 'the named preset', problems)

    config.writes.length = 0
    config.failNext = true

    try {
      ctx.appearance.applyPreset(config, other.id)
      problems.push('a failed write did not throw')
    } catch (error) {
      expectSeen(ctx, { override: dark.id, drawn: dark.id }, 'state after a failed write of a named preset', problems)
    }

    config.writes.length = 0
    ctx.appearance.applyPreset(config, 'light')
    expectSeen(ctx, { override: null, policy: 'light', drawn: 'light' }, 'the Light preset', problems)
    expectEqual(config.writes, [{ via: 'store', keys: ['appearance', 'appearancePolicy'] }], 'writes by the Light preset', problems)
    expectEqual(config.data, { appearance: 'theme', appearancePolicy: 'light' }, 'the file after the Light preset', problems)
    expectEqual(ctx.appearance.applyPreset(config, 'nothing'), false, 'an unknown preset', problems)

    return verdict(problems)
  }],

  ['settings changed under the app (an import, an undo) are adopted: the policy and the named appearance follow and a preview ends', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const { config } = start(ctx, { appearancePolicy: 'light' })

    ctx.appearance.previewPreset(dark.id)
    config.data = { appearancePolicy: 'dark', appearance: 'theme' }
    ctx.appearance.adoptAppearance(config)
    expectSeen(ctx, { policy: 'dark', drawn: 'dark', previewing: false, override: null }, 'a policy imported', problems)
    config.data = { appearancePolicy: 'dark', appearance: dark.id }
    ctx.appearance.adoptAppearance(config)
    expectSeen(ctx, { policy: 'dark', drawn: dark.id, override: dark.id }, 'a named appearance imported', problems)
    config.data = { appearancePolicy: 'dark', appearance: 'theme' }
    ctx.appearance.adoptAppearance(config)
    expectSeen(ctx, { override: null, drawn: 'dark' }, 'the theme value imported', problems)

    return verdict(problems)
  }],

  ['one observer follows the system at a time: it reads at start and on change, a second start ends the first and stop removes the listener', async (ctx) => {
    const problems = []
    const { followSystem, systemMode } = ctx.appearance

    ctx.appearance.applyPolicy(fakeConfig(), 'system')

    const first = fakeMedia(true)
    const handle = followSystem(first)

    expectEqual([systemMode(), first.added, first.listeners.size], ['dark', 1, 1], 'a start', problems)
    first.flip(false)
    expectEqual(systemMode(), 'light', 'a change', problems)
    handle.refresh(true)
    expectEqual(systemMode(), 'dark', 'a refresh with an answer', problems)
    first.matches = false
    handle.refresh()
    expectEqual(systemMode(), 'light', 'a refresh from the query', problems)

    const second = fakeMedia(true)
    const next = followSystem(second)

    expectEqual([first.listeners.size, first.removed, second.listeners.size], [0, 1, 1], 'a second start', problems)
    first.flip(false)
    expectEqual(systemMode(), 'dark', 'a change of the first query after the second start', problems)
    handle.stop()
    expectEqual(second.listeners.size, 1, 'a stale stop', problems)

    const third = fakeMedia(false)

    followSystem(third)
    expectEqual([second.listeners.size, third.listeners.size], [0, 1], 'a start after a stale stop', problems)
    next.stop()

    const last = followSystem(fakeMedia(false))

    last.stop()
    last.stop()

    const media = fakeMedia(false)
    const stopped = followSystem(media)

    stopped.stop()
    expectEqual(media.listeners.size, 0, 'the listener after stop', problems)
    media.flip(true)
    expectEqual(systemMode(), 'light', 'a change after stop', problems)

    return verdict(problems)
  }],

  ['the native theme source is the mode of the named appearance in force, else the pinned policy, else System, and a preview does not change it', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const { appearance } = ctx

    for (const [label, stored, os, wanted] of [
      ['Light', { appearancePolicy: 'light' }, true, 'light'],
      ['Dark', { appearancePolicy: 'dark' }, false, 'dark'],
      ['System, system dark', { appearancePolicy: 'system' }, true, 'system'],
      ['System, system light', { appearancePolicy: 'system' }, false, 'system'],
      [`${dark.id} over Light`, { appearancePolicy: 'light', appearance: dark.id }, false, 'dark'],
      [`${dark.id} over System`, { appearancePolicy: 'system', appearance: dark.id }, false, dark.mode],
      [`${dark.id} over Dark`, { appearancePolicy: 'dark', appearance: dark.id }, false, dark.mode],
    ]) {
      start(ctx, stored, { dark: os })
      expectEqual(appearance.nativeThemeSource(), wanted, `the source under ${label}`, problems)
      appearance.previewPreset(stored.appearance === dark.id || stored.appearancePolicy === 'dark' ? 'light' : dark.id)
      expectEqual(appearance.nativeThemeSource(), wanted, `the source under ${label} with a preview open`, problems)
    }

    return verdict(problems)
  }],

  ['a named appearance asks the native theme for its own mode and the observer keeps the last scheme of the system through it; when it ends, System is asked for again and the scheme is read anew', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const os = { dark: false }
    const run = start(ctx, { appearancePolicy: 'system', appearance: dark.id }, { dark: false })

    expectEqual(await syncNative(ctx, run, os), dark.mode, 'the source under the named appearance', problems)
    expectEqual(ctx.appearance.systemMode(), 'light', 'the scheme the observer holds while the query shows the mode asked for', problems)
    os.dark = true
    ctx.appearance.applyPolicy(run.config, 'dark')
    expectEqual(await syncNative(ctx, run, os), 'dark', 'the source under the pinned Dark policy', problems)
    expectEqual(ctx.appearance.systemMode(), 'light', 'the scheme the observer holds under a pinned policy', problems)
    ctx.appearance.applyPolicy(run.config, 'system')
    expectSeen(ctx, { drawn: 'light', policy: 'system' }, 'System chosen again before the source is answered', problems)
    expectEqual(await syncNative(ctx, run, os), 'system', 'the source once System is chosen again', problems)
    expectSeen(ctx, { drawn: 'dark', policy: 'system' }, 'System drawn from the scheme of the system itself', problems)
    expectEqual(ctx.appearance.systemMode(), 'dark', 'the scheme read anew', problems)
    ctx.appearance.applyPreset(run.config, dark.id)
    await syncNative(ctx, run, os)
    os.dark = false
    ctx.appearance.applyPolicy(run.config, 'system')
    await syncNative(ctx, run, os)
    expectSeen(ctx, { drawn: 'light' }, 'the scheme of the system after a second named appearance', problems)

    return verdict(problems)
  }],

  ['a reply of the main process that a newer observation or request has overtaken is dropped; the latest one is used', async (ctx) => {
    const problems = []
    const { media } = start(ctx, { appearancePolicy: 'system' }, { dark: false })

    // The system is read light and asked about; it turns dark (a media change) before the older reply says light.
    const older = slowNative(ctx)

    media.flip(true)
    expectSeen(ctx, { drawn: 'dark' }, 'the newer change drew dark', problems)
    await older.reply({ dark: false })
    expectSeen(ctx, { drawn: 'dark' }, 'the older reply after a newer change', problems)
    expectEqual(ctx.appearance.systemMode(), 'dark', 'the scheme after the older reply', problems)

    // A reply with nothing newer is used.
    const current = slowNative(ctx)

    await current.reply({ dark: false })
    expectEqual(ctx.appearance.systemMode(), 'light', 'a reply with nothing newer, read from its answer', problems)

    // A request overtaken by a newer one and by a change of what is asked for.
    const run = start(ctx, { appearancePolicy: 'system' }, { dark: false })
    const first = slowNative(ctx)

    ctx.appearance.applyPolicy(run.config, 'dark')

    const second = slowNative(ctx)

    ctx.appearance.applyPolicy(run.config, 'system')

    const third = slowNative(ctx)

    await first.reply({ dark: true })
    expectSeen(ctx, { drawn: 'light', policy: 'system' }, 'an older request answered while a newer one is open', problems)
    await second.reply({ dark: true })
    expectSeen(ctx, { drawn: 'light' }, 'a reply to a source no longer wanted', problems)
    await third.reply({ dark: true })
    expectSeen(ctx, { drawn: 'dark' }, 'the latest reply', problems)

    // The choice changed to a pinned one while the reply was on its way, and nothing asked again.
    const pinned = start(ctx, { appearancePolicy: 'system' }, { dark: false })
    const late = slowNative(ctx)

    ctx.appearance.applyPolicy(pinned.config, 'dark')
    await late.reply({ dark: true })
    expectEqual(ctx.appearance.systemMode(), 'light', 'a reply after the choice became a pinned one', problems)
    pinned.media.flip(true)
    expectEqual(ctx.appearance.systemMode(), 'light', 'a change the pinned choice ignores', problems)

    // No answer (web mode): the scheme is read from the query.
    const web = start(ctx, { appearancePolicy: 'system' }, { dark: false })

    web.media.matches = true
    await ctx.appearance.requestNativeTheme(() => null)
    expectSeen(ctx, { drawn: 'dark' }, 'no answer, read from the query', problems)

    return verdict(problems)
  }],

  ['removing the imported appearance ends a preview of it and keeps a preview of another preset and the draft of a file', async (ctx) => {
    const problems = []
    const { dark } = named(ctx)
    const keep = (config) => {
      ctx.appearance.importAppearanceFile(JSON.stringify(ctx.appearance.exportAppearanceFile('solaris')))
      ctx.appearance.applyPreset(config, 'custom-draft')
      ctx.appearance.applyPolicy(config, 'system')
    }

    // The imported appearance kept but not applied, System on a dark system, its card previewed, then removed.
    const one = start(ctx, { appearancePolicy: 'system' }, { dark: true })

    keep(one.config)
    one.config.writes.length = 0
    ctx.appearance.previewPreset('custom')
    expectSeen(ctx, { drawn: 'custom', previewing: true, applied: 'dark' }, 'the imported appearance previewed', problems)
    expectEqual(ctx.appearance.removeCustom(one.config), true, 'the removal', problems)
    expectSeen(ctx, { drawn: 'dark', applied: 'dark', previewing: false, policy: 'system', override: null }, 'a preview of the removed appearance', problems)
    one.media.flip(false)
    expectSeen(ctx, { drawn: 'light', previewing: false }, 'the system after the removal', problems)

    // A preview of another preset stays.
    const two = start(ctx, { appearancePolicy: 'system' }, { dark: true })

    keep(two.config)
    ctx.appearance.previewPreset(dark.id)
    ctx.appearance.removeCustom(two.config)
    expectSeen(ctx, { drawn: dark.id, previewing: true, applied: 'dark' }, 'a preview of another preset', problems)
    two.media.flip(false)
    expectSeen(ctx, { drawn: dark.id, previewing: true, applied: 'light' }, 'that preview across a system change', problems)

    // The draft of a file just read stays.
    const three = start(ctx, { appearancePolicy: 'system' }, { dark: true })

    keep(three.config)
    ctx.appearance.importAppearanceFile(JSON.stringify(ctx.appearance.exportAppearanceFile('solaris')))
    ctx.appearance.removeCustom(three.config)
    expectSeen(ctx, { drawn: 'custom-draft', previewing: true }, 'the draft of a file', problems)
    ctx.appearance.cancelPreview()
    expectSeen(ctx, { drawn: 'dark', previewing: false }, 'the draft cancelled', problems)

    // The applied one removed with no preview.
    const four = start(ctx, { appearancePolicy: 'system' }, { dark: true })

    keep(four.config)
    ctx.appearance.applyPreset(four.config, 'custom')
    expectSeen(ctx, { drawn: 'custom', override: 'custom' }, 'the imported appearance applied', problems)
    ctx.appearance.removeCustom(four.config)
    expectSeen(ctx, { drawn: 'dark', override: null, previewing: false, policy: 'system' }, 'the applied appearance removed', problems)

    return verdict(problems)
  }],

  ['the preferences carry the policy and the value that ends a named appearance: exported, imported, undone, and an invalid or older value is read the same way', async (ctx) => {
    const problems = []
    const { buildExport, parseBundle, planImport, commitImport, undoImport } = ctx.preferences
    const { dark } = named(ctx)
    const declared = [{ scope: 'app', key: ctx.appearance.POLICY_KEY, default: null }, { scope: 'app', key: 'appearance', default: null }]
    const schema = themeSchema(ctx, declared)
    const source = { raceId: null }
    const target = { gameId: null, raceId: null }
    const exported = buildExport(schema, { appearance: 'theme', appearancePolicy: 'system' }, source, ['appearance'])
    const app = (exported.bundle.categories.appearance || {}).app || {}

    expectEqual(app, { appearance: 'theme', appearancePolicy: 'system' }, 'the export', problems)
    expectEqual(exported.skipped, [], 'the skipped values', problems)
    expectEqual([...schema.keys()].filter((key) => key.endsWith(':appearancePolicy') || key.endsWith(':appearance')).sort(), ['appearance:app:appearance', 'appearance:app:appearancePolicy'], 'the fields of the theme when a page declares the same keys', problems)

    const parsed = parseBundle(JSON.stringify(exported.bundle), schema)

    expectEqual(parsed.errors || [], [], 'the import errors', problems)

    // The target holds a named appearance over the Light policy; the import ends it and sets System, as the Settings page then adopts.
    const store = { appearance: dark.id, appearancePolicy: 'light' }
    const plan = planImport({ store, entries: parsed.entries, source, target, categories: ['appearance'] })
    const committed = commitImport(store, plan, { target, source })

    expectEqual(committed.store, { appearance: 'theme', appearancePolicy: 'system' }, 'the settings after the import', problems)

    const config = fakeConfig(committed.store)

    ctx.appearance.followSystem(fakeMedia(true))
    ctx.appearance.adoptAppearance(config)
    expectSeen(ctx, { override: null, policy: 'system', drawn: 'dark' }, 'the import adopted', problems)

    const undone = undoImport(committed.store, committed.backup).store

    expectEqual(undone, store, 'the settings after the undo', problems)
    ctx.appearance.adoptAppearance(fakeConfig(undone))
    expectSeen(ctx, { override: dark.id, policy: 'light', drawn: dark.id }, 'the undo adopted', problems)

    const bundle = bundleOf

    if (!(parseBundle(bundle({ appearancePolicy: 'auto' }), schema).errors || []).length) {
      problems.push('an invalid policy is imported')
    }

    if (!(parseBundle(bundle({ appearance: 'nothing' }), schema).errors || []).length) {
      problems.push('an unknown appearance is imported')
    }

    const older = parseBundle(bundle({ appearance: 'dark' }), schema)

    expectEqual(older.errors || [], [], 'a bundle from before the policy', problems)

    const olderStore = commitImport({ appearancePolicy: 'light' }, planImport({ store: { appearancePolicy: 'light' }, entries: older.entries, source, target, categories: ['appearance'] }), { target, source }).store

    expectEqual(olderStore, { appearance: 'theme', appearancePolicy: 'dark' }, 'the settings after a bundle from before the policy', problems)
    ctx.appearance.adoptAppearance(fakeConfig(olderStore))
    expectSeen(ctx, { policy: 'dark', drawn: 'dark', override: null }, 'a bundle from before the policy adopted', problems)

    const policyOnly = parseBundle(bundle({ appearancePolicy: 'dark' }), schema)
    const keeps = commitImport({ appearance: dark.id }, planImport({ store: { appearance: dark.id }, entries: policyOnly.entries, source, target, categories: ['appearance'] }), { target, source }).store

    ctx.appearance.adoptAppearance(fakeConfig(keeps))
    expectSeen(ctx, { override: dark.id, policy: 'dark' }, 'a policy alone imported over a named appearance', problems)

    return verdict(problems)
  }],

  ['a preferences file from before the policy names both settings when it is imported, so its plan and its backup cover them and the undo restores the theme, from System and from Light', async (ctx) => {
    const problems = []
    const { buildExport, parseBundle, planImport, commitImport, undoImport } = ctx.preferences
    const { dark } = named(ctx)
    const schema = themeSchema(ctx)
    const source = { raceId: null }
    const target = { gameId: null, raceId: null }

    for (const [label, before, file, wanted] of [
      ['System', { appearancePolicy: 'system', appearance: 'theme' }, { appearance: 'dark' }, { appearancePolicy: 'dark', appearance: 'theme' }],
      ['Light', { appearancePolicy: 'light', appearance: 'theme' }, { appearance: 'dark' }, { appearancePolicy: 'dark', appearance: 'theme' }],
      ['System with no appearance stored', { appearancePolicy: 'system' }, { appearance: 'light' }, { appearancePolicy: 'light', appearance: 'theme' }],
      ['an empty file', {}, { appearance: 'dark' }, { appearancePolicy: 'dark', appearance: 'theme' }],
      ['a named appearance over System', { appearancePolicy: 'system', appearance: dark.id }, { appearance: 'light' }, { appearancePolicy: 'light', appearance: 'theme' }],
      ['System, the file holding another policy', { appearancePolicy: 'system', appearance: 'theme' }, { appearance: 'dark', appearancePolicy: 'light' }, { appearancePolicy: 'dark', appearance: 'theme' }],
      ['System, the policy before the older form in the file', { appearancePolicy: 'system', appearance: 'theme' }, { appearancePolicy: 'light', appearance: 'dark' }, { appearancePolicy: 'dark', appearance: 'theme' }],
    ]) {
      const parsed = parseBundle(bundleOf(file), schema)

      expectEqual(parsed.errors || [], [], `${label}: the errors of the older file`, problems)

      const keys = (parsed.entries || []).map(({ key }) => key).sort()

      expectEqual(keys, ['appearance', 'appearancePolicy'], `${label}: the settings the older file names`, problems)

      const plan = planImport({ store: before, entries: parsed.entries || [], source, target, categories: ['appearance'] })
      const committed = commitImport(before, plan, { target, source })

      expectEqual(committed.store, { ...before, ...wanted }, `${label}: the settings after the import`, problems)
      expectEqual(committed.backup.entries.map(({ key }) => key).sort(), plan.changes.map(({ key }) => key).sort(), `${label}: the backup covers what changed`, problems)

      const config = fakeConfig(committed.store)

      ctx.appearance.followSystem(fakeMedia(false))
      ctx.appearance.adoptAppearance(config)
      expectEqual(config.writes, [], `${label}: writes when the import is adopted`, problems)
      expectSeen(ctx, { policy: wanted.appearancePolicy, override: null, drawn: wanted.appearancePolicy }, `${label}: the import adopted`, problems)

      const undone = undoImport(committed.store, committed.backup).store
      const after = fakeConfig(undone)

      expectEqual(undone, before, `${label}: the settings after the undo`, problems)
      ctx.appearance.adoptAppearance(after)
      expectEqual(after.writes, [], `${label}: writes when the undo is adopted`, problems)
      expectEqual(ctx.appearance.appearancePolicy(), before.appearancePolicy || (before.appearance === dark.id ? 'dark' : 'light'), `${label}: the policy after the undo`, problems)
      expectEqual(ctx.appearance.appearanceOverride(), before.appearance === dark.id ? dark.id : null, `${label}: the named appearance after the undo`, problems)
    }

    const exported = buildExport(schema, { appearance: 'dark' }, source, ['appearance'])
    const again = parseBundle(JSON.stringify(exported.bundle), schema)

    expectEqual((again.entries || []).map(({ key, value }) => [key, value]).sort(), [['appearance', 'theme'], ['appearancePolicy', 'dark']], 'the older form exported and imported again', problems)

    return verdict(problems)
  }],

  ['a reset of the remembered views keeps the policy beside the other appearance settings', async (ctx) => {
    const problems = []
    const store = { appearance: 'theme', appearancePolicy: 'system', appearanceCustom: { a: 1 }, spyNPR: true, someView: { open: true } }
    const next = ctx.views.withoutViews(store, [...ctx.appearance.APPEARANCE_SETTINGS, 'spyNPR'])

    expectEqual(next, { appearance: 'theme', appearancePolicy: 'system', appearanceCustom: { a: 1 }, spyNPR: true }, 'the settings after a reset', problems)
    expectEqual(ctx.appearance.APPEARANCE_SETTINGS.includes(ctx.appearance.POLICY_KEY), true, 'the policy among the appearance settings', problems)

    return verdict(problems)
  }],
]

const APPEARANCE = 'appearance.js'

// A fault in a utility is planted in a copy of the folder.
const MUTATIONS = [
  ['a system change ends the named appearance', { file: APPEARANCE, from: "state.system = dark ? 'dark' : 'light'\n    settle()", to: "state.system = dark ? 'dark' : 'light'\n    state.override = null\n    settle()" }],
  ['a system change ends the preview', { file: APPEARANCE, from: '  if (!state.previewing) {\n    state.id = state.applied\n  }', to: '  state.id = state.applied' }],
  ['a preview that is only a difference from the applied preset', { file: APPEARANCE, from: 'export const isPreviewing = () => state.previewing', to: 'export const isPreviewing = () => state.id !== state.applied' }],
  ['a preview ended once the system reaches it', { file: APPEARANCE, from: '  state.applied = keptId()\n\n  if (!state.previewing) {', to: '  state.applied = keptId()\n\n  if (state.id === state.applied) {\n    state.previewing = false\n  }\n\n  if (!state.previewing) {' }],
  ['a preview of the applied preset counted as one', { file: APPEARANCE, from: 'state.previewing = id !== state.applied', to: 'state.previewing = true' }],
  ['a cancel that leaves the preview open', { file: APPEARANCE, from: 'state.previewing = false\n  imported.draft = null', to: 'imported.draft = null' }],
  ['a kept policy that leaves the preview open', { file: APPEARANCE, from: '  state.override = null\n  state.previewing = false\n  settle()', to: '  state.override = null\n  settle()' }],
  ['a kept named appearance that leaves the preview open', { file: APPEARANCE, from: '  state.policy = storedPolicy(config) || resolveAppearance(id).mode\n  state.previewing = false', to: '  state.policy = storedPolicy(config) || resolveAppearance(id).mode' }],
  ['a file preview that is not one', { file: APPEARANCE, from: '  state.id = DRAFT_ID\n  state.previewing = true', to: '  state.id = DRAFT_ID' }],
  ['System drawn as Light', { file: APPEARANCE, from: 'BASELINE_BY_MODE[state.policy === SYSTEM ? state.system : state.policy]', to: "BASELINE_BY_MODE[state.policy === SYSTEM ? 'light' : state.policy]" }],
  ['a system change that pins the policy it resolved', { file: APPEARANCE, from: "state.system = dark ? 'dark' : 'light'\n    settle()", to: "state.system = dark ? 'dark' : 'light'\n    if (state.policy === SYSTEM) {\n      state.policy = state.system\n    }\n    settle()" }],
  ['a stored darkMode mapped the wrong way round', { file: APPEARANCE, from: "policy = legacy ? 'dark' : 'light'", to: "policy = legacy ? 'light' : 'dark'" }],
  ['a stored darkMode read beside a policy', { file: APPEARANCE, from: 'if (policy === null && typeof legacy', to: 'if (typeof legacy' }],
  ['a baseline id under appearance not taken as the policy', { file: APPEARANCE, from: '    policy = stored\n    migrate = true', to: '    migrate = true' }],
  ['the migration written at every start', { file: APPEARANCE, from: '  if (migrate) {\n    try {', to: '  if (true) {\n    try {' }],
  ['the migration never written', { file: APPEARANCE, from: '  if (migrate) {\n    try {', to: '  if (false) {\n    try {' }],
  ['a named appearance without a policy taking the default policy', { file: APPEARANCE, from: 'policy = policy || resolveAppearance(stored).mode', to: 'policy = policy || DEFAULT_POLICY' }],
  ['a policy that is no value accepted', { file: APPEARANCE, from: 'return POLICIES.includes(policy) ? policy : null', to: 'return policy || null' }],
  ['the stored policy not read at start', { file: APPEARANCE, from: 'let policy = storedPolicy(config)', to: 'let policy = null' }],
  ['the policy not written', { file: APPEARANCE, from: 'config.update((store) => ({ ...store, [POLICY_KEY]: policy, [APPEARANCE_KEY]: NO_OVERRIDE }))\n  state.policy = policy', to: 'config.update((store) => ({ ...store, [APPEARANCE_KEY]: NO_OVERRIDE }))\n  state.policy = policy' }],
  ['a policy that keeps the named appearance', { file: APPEARANCE, from: '  state.policy = policy\n  state.override = null', to: '  state.policy = policy' }],
  ['the state changed before the write of a policy', { file: APPEARANCE, from: '  config.update((store) => ({ ...store, [POLICY_KEY]: policy, [APPEARANCE_KEY]: NO_OVERRIDE }))\n  state.policy = policy', to: '  state.policy = policy\n  config.update((store) => ({ ...store, [POLICY_KEY]: policy, [APPEARANCE_KEY]: NO_OVERRIDE }))' }],
  ['a named appearance that drops the policy', { file: APPEARANCE, from: '  state.override = id\n  state.policy = storedPolicy(config) || resolveAppearance(id).mode', to: '  state.override = id\n  state.policy = resolveAppearance(id).mode' }],
  ['a removed imported appearance that falls back to Light', { file: APPEARANCE, from: '[APPEARANCE_KEY]: NO_OVERRIDE, [POLICY_KEY]: policy }', to: "[APPEARANCE_KEY]: NO_OVERRIDE, [POLICY_KEY]: 'light' }" }],
  ['the listener not removed by stop', { file: APPEARANCE, from: "      media.removeEventListener('change', onChange)\n\n", to: '' }],
  ['a second observer that leaves the first', { file: APPEARANCE, from: '  if (following) {\n    following.stop()\n  }', to: '  if (false) {\n    following.stop()\n  }' }],
  ['a stale stop that forgets the observer now running', { file: APPEARANCE, from: '      if (following === handle) {', to: '      if (true) {' }],
  ['a refresh that ignores what the caller knows', { file: APPEARANCE, from: 'const read = (dark = media.matches) => {', to: 'const read = (ignored, dark = media.matches) => {' }],
  ['the native source left to the system under a named appearance', { file: APPEARANCE, from: '(state.override ? resolveAppearance(state.override).mode : state.policy)', to: '(state.policy === SYSTEM ? SYSTEM : state.override ? resolveAppearance(state.override).mode : state.policy)' }],
  ['the native source forced to what the system is under System', { file: APPEARANCE, from: '(state.override ? resolveAppearance(state.override).mode : state.policy)', to: '(state.override ? resolveAppearance(state.override).mode : state.policy === SYSTEM ? state.system : state.policy)' }],
  ['the observer reading the scheme the app asked for', { file: APPEARANCE, from: '    if (nativeThemeSource() === SYSTEM) {\n      read(event.matches)\n    }', to: '    read(event.matches)' }],
  ['the native source following a preview', { file: APPEARANCE, from: '(state.override ? resolveAppearance(state.override).mode : state.policy)', to: '(state.override ? resolveAppearance(state.id).mode : state.policy)' }],
  ['the native source following a preview under a pinned policy', { file: APPEARANCE, from: '(state.override ? resolveAppearance(state.override).mode : state.policy)', to: '(state.override ? resolveAppearance(state.override).mode : state.policy === SYSTEM ? state.policy : resolveAppearance(state.id).mode)' }],
  ['a lamp that does not say what it replaces', { file: APPEARANCE, from: "replaces: state.override ? resolveAppearance(state.override).name : state.policy === SYSTEM ? 'System' : null", to: 'replaces: null' }],
  ['a lamp that switches the system scheme instead of the mode drawn', { file: APPEARANCE, from: "mode: activeAppearance().mode === 'dark' ? 'light' : 'dark'", to: "mode: state.policy === SYSTEM && state.system === 'dark' ? 'dark' : activeAppearance().mode === 'dark' ? 'light' : 'dark'" }],
  ['the preferences without the policy', { file: 'preferences.js', from: "  add('appearance', 'app', policy.key, (value) => (typeof value === 'string' && policy.values.includes(value) ? { ok: true, value } : { ok: false, reason: `must be one of $" + "{policy.values.join(', ')}` }))\n", to: '' }],
  ['any policy imported', { file: 'preferences.js', from: "typeof value === 'string' && policy.values.includes(value) ? { ok: true, value }", to: "typeof value === 'string' ? { ok: true, value }" }],
  ['the policy treated as a view by the preferences', { file: 'preferences.js', from: ' && key !== appearance.key && key !== policy.key)', to: ' && key !== appearance.key)' }],
  ['an older baseline id imported without the policy', { file: 'preferences.js', from: 'also: { [policy.key]: appearance.baselines[value] } }', to: 'also: {} }' }],
  ['an older baseline id imported as it is', { file: 'preferences.js', from: 'appearance.baselines && has(appearance.baselines, value) ?', to: 'false ?' }],
  ['an older baseline id imported under the policy of the other mode', { file: APPEARANCE, from: 'map(([mode, id]) => [id, mode]))', to: "map(([mode, id]) => [id, mode === 'dark' ? 'light' : 'dark']))" }],
  ['a policy of the file kept beside the older form', { file: 'preferences.js', from: '    if (at >= 0) {\n      entries.splice(at, 1)\n    }\n', to: '' }],
  ['the older form kept under the key after the import', { file: 'preferences.js', from: 'value: older ? older.value : result.value', to: 'value: result.value' }],
  ['a removed appearance that stays previewed', { file: APPEARANCE, from: '  if (state.id === CUSTOM_ID) {\n    state.previewing = false\n  }\n\n', to: '' }],
  ['a removal that ends every preview', { file: APPEARANCE, from: '  if (state.id === CUSTOM_ID) {\n    state.previewing = false\n  }', to: '  state.previewing = false' }],
  ['a removal that ends the preview of a file draft', { file: APPEARANCE, from: '  if (state.id === CUSTOM_ID) {\n    state.previewing = false\n  }', to: '  if (state.id === CUSTOM_ID || state.id === DRAFT_ID) {\n    state.previewing = false\n    imported.draft = null\n  }' }],
  ['a native reply used after a newer observation', { file: APPEARANCE, from: ' && observations === seen) {', to: ') {' }],
  ['a native reply used after a newer request', { file: APPEARANCE, from: 'following && request === nativeRequests && nativeThemeSource()', to: 'following && nativeThemeSource()' }],
  ['a native reply used for a source no longer wanted', { file: APPEARANCE, from: ' && nativeThemeSource() === SYSTEM && observations === seen', to: ' && observations === seen' }],
  ['the observations never counted', { file: APPEARANCE, from: '    observations++\n', to: '' }],
  ['no answer left unread', { file: APPEARANCE, from: 'following.refresh(answer && typeof answer.dark === \'boolean\' ? answer.dark : undefined)', to: 'following.refresh(answer.dark)' }],
  ['the policy not among the settings a reset keeps', { file: APPEARANCE, from: 'export const APPEARANCE_SETTINGS = [APPEARANCE_KEY, CUSTOM_KEY, FONT_KEY, POLICY_KEY]', to: 'export const APPEARANCE_SETTINGS = [APPEARANCE_KEY, CUSTOM_KEY, FONT_KEY]' }],
]

const mutatedCopy = ({ file, from, to }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-policy-mutant-'))

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

  console.log('Theme policy')

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
