// A suite for scripts/check-suite-runner.js, run from a copy of the layout: variants that pass, fail, hang, spin, crash, throw and end late, a control over a state the reset after each variant puts back, and sets for resuming a run, for workers that keep dying, for a worker whose reset and close fail, for variants that say their steps and stall, for a setup that waits for a child, for a group of faults planted together (`groups`, `groups-control`) and for groups the runner refuses (`declared`). `--set=<name>` picks the set (`all`, `control`, `late`, `closing`, `resume`, `deaths`, `steps`, `prepared`, `groups`, `groups-control`, `declared`). FAKE_GROUP_HANG=<key> makes the run that holds that member of the group hang, FAKE_GROUP picks the declaration the set `declared` refuses. FAKE_LEAKY leaves the state planted after a variant, FAKE_SETUP_FAIL fails the setup of every worker, FAKE_RESET_FAIL=<key> fails the reset after that variant, FAKE_CLOSE_SLOW=<key> makes the close of the worker whose queue starts with that variant take 10 s, FAKE_CLOSE_FAIL fails every close after 2 s, FAKE_BETWEEN=<seconds> sets the `between` deadline (15 s, as the setup's, when not given), FAKE_EXTRA adds a variant to the set `resume`, FAKE_CHILD=<ms> is how long the child of the set `prepared` waits, FAKE_LIMIT=<ms> is its limit and FAKE_LAZY has the first variant of a worker of that set wait for the child instead of its setup. The suite reads saves/input.db (its inputs). Each variant notes its key and the process it runs in, as it starts, in ledger.txt at the root of the layout. The setup and the reset read the variants they are handed by the keys the suite gave them, as a suite's setup reads what to start from them, and fail on any other key. `--sleep=<ms>` runs the fixture as that child: it waits that long, says so and ends.
const fs = require('fs')
const path = require('path')
const { runSuite, runnerArgs, step, CONTROL_KEY } = require('./suite-runner')
const { observe } = require('./browser-observe')
const { runChild } = require('./check-pool')

const LEDGER = path.join(__dirname, '..', '..', 'ledger.txt')
const set = (runnerArgs().rest.find((argument) => argument.startsWith('--set=')) || '--set=all').slice('--set='.length)
const state = { planted: false, beats: 0, first: null }
let checks = 0
let failures = 0

const check = (key, ok) => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${key}`)
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A promise that never settles, with a timer that keeps the process alive, as a wait that never ends does.
const never = () => new Promise(() => { setInterval(() => { state.beats++ }, 1000) })
// A browser that is only enough of one for `observe` of scripts/lib/browser-observe.js: its page hears nothing and waits.
const FAKE_BROWSER = { newContext: async () => ({ newPage: async () => ({ on: () => {}, waitForTimeout: pause }), close: async () => {} }) }
const variant = (key, run, extra = {}) => ({ key, name: `variant ${key}`, pool: 'suite', deadline: 3, run: async () => { fs.appendFileSync(LEDGER, `${key} ${process.pid}\n`); await run() }, ...extra })
const passing = (key, ms = 0) => variant(key, async () => { await pause(ms); check(key, true) })
const crashing = (key) => variant(key, async () => { process.exit(9) })
const head = () => variant('head', async () => check('head', !state.planted), { head: true })
const fault = () => variant('fault', async () => {
  state.planted = true
  check('fault', true)
})
// The child of the set `prepared`, waited for once in a worker under a limit of 8 s (FAKE_LIMIT ms when given), as a suite waits for what more than one of its variants reads (the cases of the optional reads of scripts/check-specialist-deployments.js, each in a child): the setup waits for it, or with FAKE_LAZY the first variant that needs it.
let child = null
const childOnce = async () => {
  if (!child) {
    step('the child of the setup')
    child = await runChild(__filename, [`--sleep=${Number(process.env.FAKE_CHILD) || 0}`], { limit: Number(process.env.FAKE_LIMIT) || 8000 })
  }

  return child
}
// A variant that reads the child: it passes when the child ended well, and otherwise fails and prints the last line the child left on stderr, and whether the child had said that it slept (a child that ended well as it was being ended at its limit).
const prepared = (key) => variant(key, async () => {
  const seen = await childOnce()
  const ok = seen.code === 0 && seen.stdout.includes('slept')

  check(key, ok)

  if (!ok) {
    console.log(`  ${seen.stderr.trim().split('\n').pop()}${seen.stdout.includes('slept') ? ' (it had said that it slept)' : ''}`)
  }
})

const MEMBERS = () => ['a', 'b', 'c'].map((key) => ({ key, name: `member ${key}`, fails: [`check-${key}`] }))
const group = (key, members = MEMBERS()) => ({
  key,
  name: `group ${key}`,
  pool: 'suite',
  deadline: 3,
  members,
  run: async (handed) => {
    fs.appendFileSync(LEDGER, `${key}:${handed.map((member) => member.key).join('+')} ${process.pid}\n`)

    if (handed.some((member) => member.key === process.env.FAKE_GROUP_HANG)) {
      await never()
    }

    handed.forEach((member) => check(member.key, true))
  },
})
const BAD = {
  overlap: [{ key: 'a', name: 'member a', fails: ['shared'] }, { key: 'b', name: 'member b', fails: ['shared', 'other'] }],
  lone: [{ key: 'a', name: 'member a', fails: ['check-a'] }],
  'twin-key': [{ key: 'a', name: 'member a', fails: ['check-a'] }, { key: 'a', name: 'member b', fails: ['check-b'] }],
  'twin-name': [{ key: 'a', name: 'member a', fails: ['check-a'] }, { key: 'b', name: 'member a', fails: ['check-b'] }],
  mixed: [{ key: 'a', name: 'member a', fails: ['check-a'] }, { key: 'b', name: 'member b', fails: [] }],
  slash: [{ key: 'a/b', name: 'member a', fails: ['check-a'] }, { key: 'b', name: 'member b', fails: ['check-b'] }],
  nameless: [{ key: 'a', name: 'member a', fails: ['check-a'] }, { key: 'b', fails: ['check-b'] }],
  unlisted: [{ key: 'a', name: 'member a', fails: ['check-a'] }, { key: 'b', name: 'member b' }],
}

const SETS = {
  all: () => [
    head(),
    passing('pass'),
    variant('fail', async () => check('fail', false)),
    variant('hang', never),
    passing('after-hang'),
    // A loop that never yields: only a process outside it can end it.
    variant('spin', async () => { while (Date.now() > 0) { state.beats++ } }),
    passing('after-spin'),
    variant('throw', async () => { throw new Error('a defect of the harness planted') }),
    passing('after-throw'),
    crashing('crash'),
    passing('after-crash'),
    fault(),
  ],
  control: () => [head(), fault()],
  // A variant that ends half a second after its deadline of 1 s.
  late: () => [{ ...passing('late', 1500), deadline: 1 }, passing('after-late')],
  closing: () => [passing('x1'), passing('x2')],
  // r4 takes 4 s, so that a run ended once r3 has printed is ended in it even on a loaded machine.
  resume: () => [passing('r1'), passing('r2'), passing('r3'), { ...passing('r4', 4000), deadline: 10 }, passing('r5'), passing('r6'), ...(process.env.FAKE_EXTRA ? [passing('r7')] : [])],
  // The first worker finishes a variant before it crashes; the three after it crash before finishing one.
  deaths: () => [passing('ok'), ...['c1', 'c2', 'c3', 'c4'].map(crashing), passing('d5')],
  // Variants that say their steps (`step` of scripts/lib/suite-runner.js, and `observe` of scripts/lib/browser-observe.js for its work) and stall. The setup of each worker says a step of its own, so `quiet-stall`, the first of its worker, stalls with a step said before it began and none of its own; `stepped` says its steps and passes; `parallel-stall` runs two observations side by side, of which one stalls and the other ends; `closed`, the last of the set, says a step and passes, and its worker's close is the one FAKE_CLOSE_SLOW names.
  steps: () => [
    variant('quiet-stall', never),
    variant('stepped', async () => { step('opening the app'); step('reading the page'); check('stepped', true) }),
    variant('stalled', async () => { step('opening the app'); step('picking the game'); await never() }),
    passing('after-stall'),
    variant('observed-stall', () => observe(FAKE_BROWSER, async ({ step: say }) => { say('reading the fake page'); await never() })),
    variant('parallel-stall', () => Promise.all([observe(FAKE_BROWSER, async ({ step: say }) => { say('waiting for the stalled observation'); await never() }), observe(FAKE_BROWSER, async ({ step: say }) => { say('reading the quick page'); await pause(200) })])),
    variant('closed', async () => { step('reading the page'); check('closed', true) }),
  ],
  prepared: () => [prepared('p1'), prepared('p2'), prepared('p3')],
  // A group of three faults, planted together by one run of its own (the ledger notes the members it was handed, `g:a+b+c` or `g:b` alone), whose members pass a check of their own: FAKE_GROUP_HANG=<key> makes the run that holds that member hang.
  groups: () => [head(), group('g')],
  'groups-control': () => [head(), group('g')],
  // A declaration the runner refuses, by FAKE_GROUP.
  declared: () => (process.env.FAKE_GROUP === 'twin-group' ? [group('bad', [{ key: 'a', name: 'member a', fails: ['check-a'] }, { key: 'b', name: 'member b', fails: ['check-b'] }]), group('bad', [{ key: 'c', name: 'member c', fails: ['check-c'] }, { key: 'd', name: 'member d', fails: ['check-d'] }])] : [group('bad', BAD[process.env.FAKE_GROUP])]),
}
const VARIANTS = SETS[set]()
const KNOWN = new Set([CONTROL_KEY, ...VARIANTS.flatMap(({ key, members = [] }) => [key, ...members.map((member) => `${key}/${member.key}`)])])
const known = (target, what) => {
  if (!KNOWN.has(target.key)) {
    throw new Error(`${what} was handed a variant the suite does not have: ${target.key}`)
  }
}

const main = async () => {
  const sleep = process.argv.find((argument) => argument.startsWith('--sleep='))

  if (sleep) {
    await pause(Number(sleep.slice('--sleep='.length)))
    console.log('slept')
    process.exit(0)
  }

  // Outside a worker of the runner a step says nothing: scripts/check-suite-runner.js reads that no marker reaches the output.
  step('outside a worker')

  const totals = await runSuite({
    script: __filename,
    inputs: ['saves/input.db'],
    variants: VARIANTS,
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      queue.forEach((target) => known(target, 'the setup'))
      state.first = queue[0].key
      step('starting the page server')

      if (process.env.FAKE_SETUP_FAIL) {
        throw new Error('a setup planted to fail')
      }

      if (set === 'prepared' && !process.env.FAKE_LAZY) {
        await childOnce()
      }
    },
    afterEach: async (target) => {
      known(target, 'the reset')

      if (process.env.FAKE_RESET_FAIL === target.key) {
        throw new Error('a reset planted to fail')
      }

      if (!process.env.FAKE_LEAKY) {
        state.planted = false
      }
    },
    close: async () => {
      if (process.env.FAKE_CLOSE_SLOW === state.first) {
        await pause(10000)
      }

      if (process.env.FAKE_CLOSE_FAIL) {
        await pause(2000)
        throw new Error('a close planted to fail')
      }
    },
    control: ['all', 'control'].includes(set) ? { fault: 'fault', head: 'head' } : set === 'groups-control' ? { fault: 'g', head: 'head' } : null,
    deadline: 3,
    setup: 15,
    between: Number(process.env.FAKE_BETWEEN) || 15,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  console.log(`HARNESS ${JSON.stringify(totals.harness)}`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
