/*
  Loads a page of the renderer (a .vue file) into a Node check script, and runs its component options against a pseudo instance.

  The page's <script> is read with vue/compiler-sfc and loaded the way scripts/lib/utilities.js loads a utility: from its source as a file of the process (scripts/lib/module-files.js), its relative imports of utilities and mixins replaced by the URLs of those modules (loaded from source in turn), so the page runs the real utilities and mixins. What a page imports only to render stands in as a small stub module: every .vue component is `export default {}`, `vuex` reads the store the instance is given, and the mixins and helpers that need the app around them (persisted-view, deep-link, load-state, the chart theme, the appearance) are stubbed in MODULE_STUBS. `options.stubs` is { [package specifier]: module source } for the packages the utilities import, as for `loadUtilities`; `options.modules` is { [module name]: module source } and replaces a module by name ('mixins/persisted-view'), a real one with null.

  `options.mutate(text)` rewrites the page's script text before it loads: a check of the checks cuts one gate out of the page and expects a page check to fail (`replacing`).

  `instantiate(options, { $store, database, GameID, RaceID, data })` is not Vue: the options of the page and of its mixins are merged, `computed` is evaluated on each read with `this` as the instance, methods are bound to it, and the async reads (`asyncComputed.<name>.get`) run on request, `await vm.runAsync('researches')`, with the value they return kept as the property. `data` sets properties (the value an async read would have, or a data field). The store's getters are `$store.getters`, the getters `database`, `GameID` and `RaceID` are the arguments of the same name unless the store has them, and `$store.state` and `$store.dispatch` are as given.
*/
const fs = require('fs')
const path = require('path')

const rendererDirectory = path.resolve(__dirname, '..', '..', 'src', 'renderer')

const { urlOfSource } = require('./module-files')

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const VUE_STUB = 'export default {}'

// What a page imports from the packages, besides what the utilities need (the caller's `stubs`).
const PACKAGE_STUBS = {
  vuex: `
    const pairs = (list) => (Array.isArray(list) ? list.map((name) => [name, name]) : Object.entries(list))
    const space = (state, namespace) => (namespace ? state[namespace] : state)
    export const mapGetters = (list) => Object.fromEntries(pairs(list).map(([key, name]) => [key, function () { return this.$store.getters[name] }]))
    export const mapState = (namespace, list) => (typeof namespace === 'string' ? Object.fromEntries(pairs(list).map(([key, name]) => [key, function () { return space(this.$store.state, namespace)[name] }])) : Object.fromEntries(pairs(namespace).map(([key, name]) => [key, function () { return this.$store.state[name] }])))
    export const mapActions = (list) => Object.fromEntries(pairs(list).map(([key, name]) => [key, function (...args) { return this.$store.dispatch(name, ...args) }]))
  `,
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
}

// Modules that need the app around them, by name from the renderer folder. The persisted view declares each field as data with its default; the helpers it takes describe a field and need nothing else.
const MODULE_STUBS = {
  'mixins/persisted-view': `
    export const oneOf = (values) => (value) => values.includes(value)
    export const tableView = (key, defaults) => ({ key, default: defaults })
    export default (fields) => ({ data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) })
  `,
  'mixins/deep-link': 'export default {}',
  'mixins/load-state': 'export default () => ({})',
  'components/charts/theme': 'export const chartTheme = () => ({ categorical: [], ink: \'\', inkMuted: \'\' }); export const withAlpha = (color) => color; export const chartFont = () => ({ family: \'Test\', size: (px) => px, font: (px, weight = 400) => weight + \' \' + px + \'px Test\' }); export const seriesIdentity = () => ({ dash: [] })',
  'utilities/appearance': 'export const activeAppearance = () => ({})',
  'utilities/appearance-font': 'export const whenFontsReady = () => Promise.resolve()',
}

const pageScript = (text) => require(path.join(rendererDirectory, '..', '..', 'node_modules', 'vue', 'compiler-sfc')).parse({ source: text }).script.content

const moduleUrl = (name, context) => {
  const { urls, directory, stubs, modules, mutate, sources, texts } = context

  if (!urls.has(name)) {
    if (modules[name] !== undefined && modules[name] !== null) {
      urls.set(name, urlOfSource(modules[name]))

      return urls.get(name)
    }

    const isPage = name.startsWith('pages/') || name.startsWith('components/')
    const file = path.join(directory, `${name}${isPage ? '.vue' : '.js'}`)

    if (sources[name] === undefined && !texts.has(file)) {
      texts.set(file, fs.readFileSync(file, 'utf8'))
    }

    const text = sources[name] !== undefined ? sources[name] : texts.get(file)
    const source = isPage ? pageScript(text) : text
    const mutated = isPage && mutate ? mutate(source) : source
    const components = mutated.replace(/from '([^']+\.vue)'/g, () => `from '${urlOfSource(VUE_STUB)}'`)
    const relative = components.replace(/from '(\.\.?\/[\w\-/.]+)'/g, (_match, specifier) => `from '${moduleUrl(path.posix.join(path.posix.dirname(name), specifier), context)}'`)
    const stubbed = Object.entries({ ...PACKAGE_STUBS, ...stubs }).reduce((result, [specifier, stub]) => result.replace(new RegExp(`from '${escaped(specifier)}'`, 'g'), `from '${urlOfSource(stub)}'`), relative)

    urls.set(name, urlOfSource(stubbed))
  }

  return urls.get(name)
}

// The component options of a page, 'pages/lagrange'. `sources` is { [module name]: source text } for modules (or the page itself, as the text of its .vue file) whose text is given instead of read from the folder, for a check that plants a fault in one of them; `texts` is a Map the caller keeps from call to call, so each file is read once: give it only where the files do not change between the calls.
const loadPage = async (name, { directory = rendererDirectory, stubs = {}, modules = {}, mutate = null, sources = {}, texts = new Map() } = {}) => {
  const context = { urls: new Map(), directory, stubs, modules: { ...MODULE_STUBS, ...modules }, mutate, sources, texts }

  return (await import(moduleUrl(name, context))).default
}

// A `mutate` that replaces `from` by `to` in the script text, and fails when `from` is not there: a mutation that does not apply is an error.
const replacing = (from, to) => (text) => {
  if (!text.includes(from)) {
    throw new Error(`The mutation of the page does not apply: ${from}`)
  }

  return text.replace(from, () => to)
}

const flatten = (options) => [...(options.mixins || []).flatMap(flatten), options]

const merged = (parts, key) => Object.assign({}, ...parts.map((part) => part[key] || {}))

const instantiate = (options, { $store, database = null, GameID = null, RaceID = null, data = {}, nested = false }) => {
  const parts = flatten(options)
  const computed = merged(parts, 'computed')
  const methods = merged(parts, 'methods')
  const asyncComputed = merged(parts, 'asyncComputed')
  const state = {}
  const held = new Map()
  let depth = 0
  const getters = new Proxy({}, { get: (_target, key) => (key in $store.getters ? $store.getters[key] : ({ database, GameID, RaceID, config: { get: (_name, fallback) => fallback } })[key]), has: (_target, key) => key in $store.getters })
  const store = { getters, state: $store.state || {}, dispatch: (...args) => $store.dispatch(...args) }
  const own = {
    $store: store,
    $set: (target, key, value) => { target[key] = value; held.clear() },
    $nextTick: (callback) => callback && callback(),
    $emit: () => {},
    runAsync: async (name) => {
      state[name] = await asyncComputed[name].get.call(vm)
      held.clear()

      return state[name]
    },
  }

  // With `nested`, a computed read while another computed is being evaluated keeps its value until the outermost one returns (as Vue's cached computed does within one render); any assignment drops what is kept. A read from outside is always evaluated.
  const evaluate = (key) => {
    if (!nested) {
      return computed[key].call(vm)
    }

    if (depth > 0 && held.has(key)) {
      return held.get(key)
    }

    depth++

    try {
      const value = computed[key].call(vm)

      if (depth > 1) {
        held.set(key, value)
      }

      return value
    } finally {
      if (--depth === 0) {
        held.clear()
      }
    }
  }

  const vm = new Proxy({}, {
    get: (_target, key) => (typeof key === 'symbol' ? undefined : key in own ? own[key] : key in state ? state[key] : key in computed ? evaluate(key) : key in methods ? methods[key].bind(vm) : undefined),
    set: (_target, key, value) => { state[key] = value; held.clear(); return true },
    has: (_target, key) => key in own || key in state || key in computed || key in methods,
  })

  Object.entries(asyncComputed).forEach(([name, read]) => { state[name] = typeof read.default === 'function' ? read.default.call(vm) : read.default })
  parts.forEach((part) => part.beforeCreate && part.beforeCreate.call(vm))
  parts.forEach((part) => part.data && Object.assign(state, part.data.call(vm)))
  Object.assign(state, data)

  return vm
}

module.exports = { loadPage, replacing, instantiate }
