/*
  Checks what the wheel does over the map of Route Finder, Survey Progress, Lagrange Points and Minerals (src/renderer/components/exploration/SystemMap.vue), without a save: a wheel turned to zoom out of a map that is already fully zoomed out is left to scroll the page, and every other wheel zooms the map and is kept from scrolling the page. A wheel the page would scroll must not be swallowed, and one that zooms must not also scroll.

  The component's `wheel` runs on a pseudo instance (scripts/lib/page-loader.js) with a view at a given zoom and events that count their `preventDefault`, and the compiled template is read for how the canvas takes the wheel.

  Each planted fault (a copy of the component with one change, loaded in place of it) must fail the statements it names. Prints `N of N checks passed`; a statement that fails, a fault that no named statement catches and a fault whose anchor does not match set exit code 1. `--no-mutations` skips the faults. `--only=text|text` selects faults by name or by their stable `fault:N` key; the head still runs every statement.
*/
const fs = require('fs')
const path = require('path')
const compiler = require('vue/compiler-sfc')
const assert = require('./lib/bounded-assert')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { inParallel } = require('./lib/check-pool')

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'components', 'exploration', 'SystemMap.vue')
const ORIGINAL = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')
const STORE = { getters: {}, state: {}, dispatch: async () => {} }
// What the map draws with is not under test: the theme and its fonts stand in as plain values.
const THEME = 'export const chartTheme = () => ({}); export const mapFont = () => ({ font: () => "11px Test" })'

const CHECKS = []
const check = (name, run) => CHECKS.push({ name, run })

// A map at `zoom` with `pending` of the zoom of earlier wheel events of the frame, given a wheel of `deltaY`: whether the page is kept from scrolling and the zoom factor the map holds for the frame.
const wheelOn = async (text, { zoom, pending = 1, deltaY }) => {
  const page = await loadPage('components/exploration/SystemMap', { sources: { 'components/exploration/SystemMap': text }, modules: { 'components/charts/theme': THEME } })
  const calls = { prevented: 0, framed: 0 }
  const vm = instantiate(page, { $store: STORE, data: { view: { x: 0, y: 0, zoom }, wheelFactor: pending, wheelAt: null, pointer: () => ({ x: 1, y: 1 }), queueFrame: () => { calls.framed += 1 } } })

  vm.wheel({ deltaY, deltaX: 0, deltaMode: 0, shiftKey: false, preventDefault: () => { calls.prevented += 1 } })

  return { prevented: calls.prevented > 0, framed: calls.framed > 0, factor: vm.wheelFactor }
}

const OUT = 120
const IN = -120

check('full-zoom-out', async (text) => {
  const out = await wheelOn(text, { zoom: 1, deltaY: OUT })

  assert.equal(out.prevented, false, 'a wheel turned to zoom out of a fully zoomed-out map is left to scroll the page')
  assert.equal(out.framed, false, 'and the map takes nothing from it')
  assert.equal(out.factor, 1)
})

check('zoom-in-from-fit', async (text) => {
  const into = await wheelOn(text, { zoom: 1, deltaY: IN })

  assert.equal(into.prevented, true, 'a wheel turned to zoom in on a fully zoomed-out map zooms and does not scroll the page')
  assert.ok(into.framed && into.factor > 1, 'the map holds the zoom in for the frame')
})

check('zoom-out-while-zoomed-in', async (text) => {
  const out = await wheelOn(text, { zoom: 2, deltaY: OUT })

  assert.equal(out.prevented, true, 'a wheel that can still zoom out zooms and does not scroll the page')
  assert.ok(out.framed && out.factor < 1, 'the map holds the zoom out for the frame')
})

check('zoom-of-the-frame', async (text) => {
  const into = await wheelOn(text, { zoom: 1, pending: 2, deltaY: OUT })

  assert.equal(into.prevented, true, 'a map that the events of this frame have zoomed in can still zoom out, so the wheel is kept from the page')
  assert.ok(into.factor < 2, 'and the zoom out is added to theirs')
})

check('wheel-listener', async (text) => {
  const parsed = compiler.parse({ source: text })
  const template = (parsed.descriptor || parsed).template.content
  const canvas = []
  const walk = (node) => {
    if (node.tag === 'canvas') {
      canvas.push(node)
    }

    ;(node.children || []).filter((child) => child.type === 1).forEach(walk)
  }

  walk(compiler.compileTemplate({ source: template, filename: 'SystemMap.vue', id: 'SystemMap.vue' }).ast)

  assert.equal(canvas.length, 1, 'the map has one canvas')
  assert.equal(canvas[0].events.wheel.value, 'wheel', 'the canvas takes the wheel in the component')
  assert.ok(!canvas[0].events.wheel.modifiers || !canvas[0].events.wheel.modifiers.prevent, 'and does not swallow every wheel before the component has looked at it')
})

const WHEEL_TEST = 'if (factor < 1 && this.view.zoom * this.wheelFactor <= 1) {'

// [name, from, to, the statements that must fail]
const FAULTS = [
  ['a wheel at full zoom-out is kept from the page', WHEEL_TEST, 'if (false) {', ['full-zoom-out']],
  ['a wheel that zooms in is left to the page', WHEEL_TEST, 'if (factor > 1 && this.view.zoom * this.wheelFactor <= 1) {', ['full-zoom-out', 'zoom-in-from-fit']],
  ['a wheel that zooms out is left to the page at any zoom', WHEEL_TEST, 'if (factor < 1) {', ['zoom-out-while-zoomed-in', 'zoom-of-the-frame']],
  ['a wheel that zooms out of a map zoomed in by the frame is left to the page', WHEEL_TEST, 'if (factor < 1 && this.view.zoom <= 1) {', ['zoom-of-the-frame']],
  ['the zoom of the wheel does not keep the page still', '      event.preventDefault()\n', '', ['zoom-in-from-fit', 'zoom-out-while-zoomed-in']],
  ['the canvas takes no wheel of its own', '@wheel="wheel"', '@wheel.prevent="wheel"', ['wheel-listener']],
]

const run = async (text) => {
  const failures = []

  for (const { name, run: body } of CHECKS) {
    try {
      await body(text)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 4).join('\n  ')}`

const main = async () => {
  const mutate = !process.argv.includes('--no-mutations')
  const only = process.argv.find((argument) => argument.startsWith('--only='))
  const selected = only ? only.slice('--only='.length).split('|').filter(Boolean) : []
  const keep = (key, label) => !only || selected.some((text) => key === text || label.includes(text))
  const failures = await run(ORIGINAL)
  let total = CHECKS.length
  let passed = total - failures.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutate) {
    const known = new Set(CHECKS.map(({ name }) => name))

    FAULTS.forEach(([label, , , fails]) => fails.forEach((name) => assert.ok(known.has(name), `${label}: no check named ${name}`)))

    const covered = new Set(FAULTS.flatMap(([, , , fails]) => fails))

    CHECKS.forEach(({ name }) => assert.ok(covered.has(name), `${name}: no planted fault names this check`))

    const attempts = FAULTS.map((fault, index) => [index, ...fault]).filter(([index, label]) => keep(`fault:${index}`, label))
    const outcomes = await inParallel(attempts, async ([, label, from, to, fails]) => {
      const planted = patched(FILE, ORIGINAL, from, to)
      const found = await run(planted)
      const missed = fails.filter((name) => !found.some((failure) => failure.name === name && failure.error instanceof assert.AssertionError))

      return { label, missed }
    })

    outcomes.forEach((outcome, index) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault ${attempts[index][1]}: ${outcome.message}`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)
  process.exit(passed === total ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
