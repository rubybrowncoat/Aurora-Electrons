/*
  Checks the shared in-process render of a compiled Vue 2 template (scripts/lib/vue-render.js): that a template compiles once for each text and reports its errors instead of throwing, that a render records every element and every interpolated text the template produces, that the tree it gives is walked in document order, that a scoped slot draws a row when it is called, that an attribute is read from the record, and that an override answers a name before the instance does.

  bun scripts/check-vue-render.js [--no-mutations] [--only=<id>,<id>] [--detail]

  Every fault is a rewrite of one function of scripts/lib/vue-render.js in a private copy under .check-runs. Only a named check that fails on an observed value credits it; a throw, a timeout, a missing marker or a nonzero child exit is an uncredited harness failure.
*/
const fs = require('fs')
const path = require('path')
const ROOT = process.env.VUE_RENDER_ROOT || path.resolve(__dirname, '..')
const { assert, runChecks, judged, caughtBy } = require(path.join(ROOT, 'scripts/lib/fault-credit'))
const { patched } = require(path.join(ROOT, 'scripts/lib/mutant-source'))
const { runChild } = require(path.join(ROOT, 'scripts/lib/check-pool'))
const { mutating, refusePlanting } = require(path.join(ROOT, 'scripts/lib/no-mutations'))
const { compiledTemplate, renderTree, treeOf, attrsOf } = require('./lib/vue-render')

const WORK = path.join(ROOT, '.check-runs')
const PREFIX = '@@vue-render '
const DETAIL = process.argv.includes('--detail')

const SPAN = '<template><div class="panel"><span>{{ name }}</span></div></template>'
const ATTRIBUTE = '<template><div class="panel"><span :data-name="name">x</span></div></template>'
const CHOSEN = '<template><div><span v-if="on">A</span><b v-else>B</b></div></template>'
const EACH = '<template><ul><li v-for="row in rows" :key="row">{{ row }}</li></ul></template>'
const TABLE = '<template><div class="panel"><v-data-table :items="rows"><template #item.name="{ item }"><span>{{ item.name }}</span></template></v-data-table></div></template>'
const BROKEN = '<template><div>{{ broken( }}</div></template>'

// The records a slot drew, whether it returns one or a list of them.
const drawnOf = (drawn) => (Array.isArray(drawn) ? drawn : [drawn]).filter((entry) => entry && typeof entry === 'object')
const tagsIn = (node) => treeOf(node).map((entry) => entry.tag)
const textIn = (node) => {
  if (Array.isArray(node)) {
    return node.map(textIn).join('')
  }

  return node && typeof node === 'object' ? textIn(node.children) : typeof node === 'string' ? node : ''
}

const CHECKS = [
  {
    id: 'compile',
    name: 'a template compiles once for each text, and a broken one reports its errors instead of throwing',
    run: () => {
      const first = compiledTemplate(SPAN)
      const second = compiledTemplate(SPAN)

      assert.equal(typeof first.code, 'string', 'the compile gave no code')
      assert.equal(first.errors.length, 0, 'a well-formed template reported errors')
      assert.ok(first === second, 'the same text compiled twice gave two results')
      assert.ok(compiledTemplate(BROKEN).errors.length > 0, 'a broken template reported no error')
    },
  },
  {
    id: 'tags',
    name: 'every element a template makes is recorded, the children before their parent',
    run: () => assert.deepEqual(renderTree(SPAN, { name: 'Ada' }).tags, ['span', 'div'], 'the elements made'),
  },
  {
    id: 'texts',
    name: 'every interpolated text is recorded as it is produced',
    run: () => assert.deepEqual(renderTree(SPAN, { name: 'Ada' }).texts, ['Ada'], 'the texts made'),
  },
  {
    id: 'tree',
    name: 'the render gives the tree of records a check reads, with the text inside the element that shows it',
    run: () => {
      const { tree } = renderTree(SPAN, { name: 'Ada' })

      assert.equal(tree.tag, 'div', 'the root tag')
      assert.equal(tree.children[0].tag, 'span', 'the child tag')
      assert.equal(textIn(tree.children[0]), 'Ada', 'the text of the child')
    },
  },
  {
    id: 'order',
    name: 'the walk gives every record in document order, a slot record and a branch included',
    run: () => {
      assert.deepEqual(tagsIn(renderTree(SPAN, { name: 'Ada' }).tree), ['div', 'span'], 'the order of the elements')

      const { tree } = renderTree(TABLE, { rows: [] })
      const table = treeOf(tree).find((node) => node.tag === 'v-data-table')
      const drawn = drawnOf(table.data.scopedSlots['item.name']({ item: { name: 'Zed' } }))

      assert.deepEqual(tagsIn(drawn), ['span'], 'the order of a drawn row')
    },
  },
  {
    id: 'vif',
    name: 'only the branch the data chooses is rendered',
    run: () => {
      assert.deepEqual(renderTree(CHOSEN, { on: true }).tags, ['span', 'div'], 'the branch taken when the test holds')
      assert.deepEqual(renderTree(CHOSEN, { on: false }).tags, ['b', 'div'], 'the branch taken when it does not')
    },
  },
  {
    id: 'vfor',
    name: 'a list renders one element for each of its entries',
    run: () => {
      const counted = (rows) => tagsIn(renderTree(EACH, { rows }).tree).filter((tag) => tag === 'li').length

      assert.equal(counted(['a', 'b', 'c']), 3, 'three entries')
      assert.equal(counted([]), 0, 'no entry')
    },
  },
  {
    id: 'slot',
    name: 'a scoped slot is a function of its table record, and calling it draws that row',
    run: () => {
      const { tree } = renderTree(TABLE, { rows: [{ name: 'Zed' }] })
      const table = treeOf(tree).find((node) => node.tag === 'v-data-table')
      const slot = table.data.scopedSlots['item.name']

      assert.equal(typeof slot, 'function', 'the slot of a row was not a function')
      assert.equal(textIn(drawnOf(slot({ item: { name: 'Zed' } }))), 'Zed', 'the text a drawn row shows')
    },
  },
  {
    id: 'attrs',
    name: 'an attribute bound on an element is read from its record, and an element without one gives none',
    run: () => {
      const { tree } = renderTree(ATTRIBUTE, { name: 'Ada' })
      const span = treeOf(tree).find((node) => node.tag === 'span')

      assert.equal(attrsOf(span)['data-name'], 'Ada', 'the bound attribute')
      assert.deepEqual(attrsOf(tree), {}, 'an element with no attribute')
    },
  },
  {
    id: 'errors',
    name: 'a broken template gives its compile errors from the render too, never a throw',
    run: () => {
      const { errors } = renderTree(BROKEN, {})

      assert.ok(errors.length > 0, 'the render reported no compile error')
    },
  },
  {
    id: 'overrides',
    name: 'an override answers a name before the instance does, and an absent one changes nothing',
    run: () => {
      const overridden = renderTree(SPAN, { name: 'instance' }, { name: 'override' })
      const plain = renderTree(SPAN, { name: 'instance' })

      assert.equal(textIn(overridden.tree.children[0]), 'override', 'the text of the overriding name')
      assert.equal(textIn(plain.tree.children[0]), 'instance', 'the text of the instance name')
    },
  },
]

// Each declaration names only the behavioral check that must reject the rewrite.
const FAULTS = [
  { key: 'no-cache', name: 'the same text compiles once and is not kept', file: 'vue-render.js', edits: [['if (compiled.has(componentText)) {', 'if (false) {']], fails: ['compile'] },
  { key: 'flat-tags', name: 'only the first element of a render is recorded', file: 'vue-render.js', edits: [['    tags.push(tag)', '    if (!tags.length) tags.push(tag)']], fails: ['tags'] },
  { key: 'no-texts', name: 'an interpolated text is not recorded', file: 'vue-render.js', edits: [['texts.push(String(value)); ', '']], fails: ['texts'] },
  { key: 'no-children', name: 'the walk stops at the first record of the tree', file: 'vue-render.js', edits: [['      visit(entry.children)', '      void entry.children']], fails: ['order'] },
  { key: 'no-loop', name: 'a list is rendered as itself instead of one element for each entry', file: 'vue-render.js', edits: [['_l: (list, each) => (list || []).map(each)', '_l: (list) => list || []']], fails: ['vfor'] },
  { key: 'no-slots', name: 'a scoped slot is dropped from its table record', file: 'vue-render.js', edits: [['_u: (slots) => Object.fromEntries(slots.map((slot) => [slot.key, slot.fn]))', '_u: () => ({})']], fails: ['slot'] },
  { key: 'attrs-empty', name: 'an element reports no attribute whatever is bound on it', file: 'vue-render.js', edits: [['const attrsOf = (node) => (node && node.data && node.data.attrs) || {}', 'const attrsOf = () => ({})']], fails: ['attrs'] },
  { key: 'drop-errors', name: 'the render hides the compile errors of a broken template', file: 'vue-render.js', edits: [['return { tags, texts, tree, errors }', 'return { tags, texts, tree, errors: [] }']], fails: ['errors'] },
  { key: 'ignore-overrides', name: 'an override is answered by the instance instead', file: 'vue-render.js', edits: [['(key in overrides ? overrides[key] : key in helpers ? helpers[key] : target[key])', '(key in helpers ? helpers[key] : target[key])']], fails: ['overrides'] },
]

const faultResults = async (fault) => {
  refusePlanting(fault.name)
  fs.mkdirSync(WORK, { recursive: true })

  const folder = fs.mkdtempSync(path.join(WORK, 'vue-render-'))
  const scripts = path.join(folder, 'scripts')

  if (!path.resolve(folder).startsWith(`${path.resolve(WORK)}${path.sep}`)) {
    throw new Error('the render fixture escaped its workspace')
  }

  try {
    fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true })
    fs.copyFileSync(__filename, path.join(scripts, 'check-vue-render.js'))

    const source = fs.readFileSync(path.join(__dirname, 'lib', 'vue-render.js'), 'utf8')
    const text = fault.edits.reduce((given, [from, to]) => patched(fault.file, given, from, to), source)

    fs.writeFileSync(path.join(scripts, 'lib', 'vue-render.js'), text)

    const run = await runChild(path.join(scripts, 'check-vue-render.js'), ['--no-mutations', `--only=${fault.fails.join(',')}`], { env: { VUE_RENDER_ROOT: ROOT }, limit: 30000 })
    const markers = run.stdout.split(/\r?\n/).filter((line) => line.startsWith(PREFIX))

    if (run.timedOut || markers.length !== 1 || ![0, 1].includes(run.code)) {
      throw new Error(`the render fault ${fault.key} gave no trustworthy results (code ${run.code}, timedOut ${run.timedOut}): ${run.stderr.slice(0, 500)}`)
    }

    return JSON.parse(markers[0].slice(PREFIX.length))
  } finally {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

const main = async () => {
  const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
  const wanted = CHECKS.filter(({ id }) => !only.length || only.includes(id))

  if (!wanted.length || only.some((id) => !CHECKS.some((check) => check.id === id))) {
    throw new Error(`unknown render case: ${only.join(',')}`)
  }

  const results = await runChecks(wanted, {})
  let total = results.length
  let failures = results.filter(({ ok }) => !ok).length

  results.forEach(({ id, name, ok, detail }) => console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${name}${detail ? `: ${detail}` : ''}`))

  if (mutating()) {
    for (const fault of FAULTS.filter(({ fails }) => !only.length || fails.every((id) => only.includes(id)))) {
      const observed = await faultResults(fault)
      const failed = judged(observed, fault.name)
      const credited = caughtBy(failed, fault.fails, { name: fault.name })

      if (!fault.fails.every((id) => observed.some((result) => result.id === id))) {
        throw new Error(`${fault.key} did not run its named check`)
      }

      total++
      failures += credited ? 0 : 1
      console.log(`${credited ? 'PASS' : 'FAIL'} fault ${fault.key}: ${fault.name}: ${failed.map(({ id, detail }) => DETAIL ? `${id}: ${detail}` : id).join('; ') || 'all named checks held'}`)
    }
  }

  console.log(`${PREFIX}${JSON.stringify(results)}`)
  console.log(`${total - failures} of ${total} checks passed`)
  process.exitCode = failures ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
