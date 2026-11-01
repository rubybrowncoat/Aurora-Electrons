// The render of a compiled Vue 2 template, without a browser. The component's own template is compiled to the render function Vue would call, and that function runs with the mounted instance as its scope: every element it creates becomes a record { tag, data, children }, every interpolated text is recorded as it is produced, and a scoped slot stays a function of its table's record, to be called with a row, so a table's rows are read the way the page draws them. An element the page does not register stays a plain record, so what a check reads here is its tag, its bound attrs and its text, never what Vuetify makes of them: CSS and layout visibility, detached menu and dialog content, focus and keyboard, and errors raised only by the real Vue runtime are not visible this way and belong to the browser runner.
//
// Compiling is the expensive part and its result depends only on the text, so the compiled code and the render function made from it are kept, one per distinct template: a suite that renders the same component in twenty states compiles it once. The render function keeps nothing between calls, as every record it makes comes from the helpers of the call that makes it.
//
// const { renderTree, treeOf, attrsOf } = require('./lib/vue-render')
// const { tree, texts, errors } = renderTree(componentText, vm)          // vm: the mounted instance
// const table = treeOf(tree).find((node) => node.tag === 'v-data-table')
// const rows = table.data.scopedSlots['item.name']({ item: row })

const nodeVm = require('vm')
const compiler = require('vue/compiler-sfc')

const compiled = new Map()
const renderers = new Map()

// The template source of the component, compiled as Vue's own build compiles a single file component. The whole result is kept: a check reads `code`, `ast` or `errors` from it, and reads `errors` instead of catching a throw when a template is broken.
const compiledTemplate = (componentText) => {
  if (compiled.has(componentText)) {
    return compiled.get(componentText)
  }

  const parsed = compiler.parse({ source: componentText })
  const descriptor = parsed.descriptor || parsed
  const result = compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' })

  compiled.set(componentText, result)

  return result
}

// The render function of that code.
const renderOf = (componentText) => {
  const { code } = compiledTemplate(componentText)

  if (!renderers.has(code)) {
    renderers.set(code, nodeVm.runInNewContext(`${code.replace(/export \{[^}]*\}\s*$/, '')}\nrender`, {}))
  }

  return renderers.get(code)
}

// What the template renders for that instance: the elements in the order they are made, every interpolated text, and the tree they form. `overrides` answers a name before the instance does, for a state the instance cannot be set to.
const renderTree = (componentText, instance, overrides = {}) => {
  const { errors } = compiledTemplate(componentText)
  const render = renderOf(componentText)
  const tags = []
  const texts = []
  const make = (tag, data, children) => {
    const hasData = !Array.isArray(data)

    tags.push(tag)

    return { tag, data: (hasData ? data : null) || {}, children: (hasData ? children : data) || [] }
  }
  const helpers = { _self: { _c: make }, _l: (list, each) => (list || []).map(each), _v: (text) => text, _s: (value) => { texts.push(String(value)); return String(value) }, _e: () => null, _u: (slots) => Object.fromEntries(slots.map((slot) => [slot.key, slot.fn])), _m: () => null }
  const tree = render.call(new Proxy(instance, { get: (target, key) => (key in overrides ? overrides[key] : key in helpers ? helpers[key] : target[key]) }))

  return { tags, texts, tree, errors }
}

// Every element record in document order, the branches of a v-if chain and the children of a slot included.
const treeOf = (node) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit)
    } else if (entry && typeof entry === 'object') {
      found.push(entry)
      visit(entry.children)
    }
  }

  visit(node)

  return found
}

// The attributes bound on an element record.
const attrsOf = (node) => (node && node.data && node.data.attrs) || {}

module.exports = { compiledTemplate, renderOf, renderTree, treeOf, attrsOf }
