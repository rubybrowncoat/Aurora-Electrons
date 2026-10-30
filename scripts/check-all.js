/*
  Runs every check script (scripts/check-*.js) and prints one line per script with its time and its last summary line, the slowest first, then exits 1 when any failed.

  node scripts/check-all.js [--jobs=N] [--scripts=N] [--browser] [--only=name,name] [--quick]

  --jobs=N is the budget of workers for the whole run (default: the physical cores, half the logical processors, scripts/lib/check-pool.js); --scripts=N runs N scripts side by side (default 3, never more than the budget) and gives each an equal share of the budget through CHECK_JOBS, which its mutant pool reads, so the run never starts more workers than the budget. Both take a positive whole number. --quick runs the head checks only: it passes --no-mutations to the scripts that name it (a script that plants no fault takes no such flag, and one that does not know the flag stops on it) and sets CHECK_NO_MUTATIONS=1 for every script, so that a script that plants faults and does not name the flag fails at its first planting (scripts/lib/no-mutations.js, scripts/check-no-mutations.js). --browser also runs check-typography.js, which needs the web mode running (`bun run web`; BASE_URL says where when it is not http://127.0.0.1:9080). --only runs the named scripts (without the check- prefix or .js).

  Left out: check-engines.js (the install hook that refuses a package manager other than bun), check-harvesters.js (a report on one save, given on its command line). check-design-rules.js runs its --fixtures mode, which needs no save. check-save-switching.js and check-peeks.js run after the others, alone and with the whole budget (the cases of the first wait on watchers and timers within fixed limits, the second times its reads against a budget in wall time).
*/
const fs = require('fs')
const path = require('path')
const { cores, inParallel, runChild } = require('./lib/check-pool')

const SKIPPED = new Set(['check-engines.js', 'check-harvesters.js'])
const BROWSER = new Set(['check-typography.js'])
// Scripts whose cases wait on watchers and timers within fixed limits, or time their work against a budget in wall time: they run after the others, one at a time with the whole budget, because a machine saturated by the other scripts' mutants can starve those waits past their limits and stretch those timings several times over (check-peeks: 36 ms where it measures 4.6 ms alone).
const ALONE = new Set(['check-save-switching.js', 'check-peeks.js'])
// The slowest scripts start first, so the longest one does not begin last and run on alone.
const FIRST = ['check-event-archive.js', 'check-section-accents.js', 'check-history-backup.js', 'check-map-hierarchy.js', 'check-warning-snoozes.js', 'check-legacy-consumption.js']
const ARGS = { 'check-design-rules.js': ['--fixtures'] }

const option = (name) => {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`))

  return found ? found.slice(name.length + 3) : null
}

const count = (name, fallback) => {
  const text = option(name)
  const value = Number(text)

  if (text === null) {
    return fallback
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} takes a positive whole number, not ${text}`)
  }

  return value
}

const main = async () => {
  const only = option('only') ? new Set(option('only').split(',').map((name) => `check-${name.trim()}.js`)) : null
  const quick = process.argv.includes('--quick')
  const browser = process.argv.includes('--browser')
  const budget = count('jobs', cores())
  const side = Math.min(count('scripts', 3), budget)
  const scripts = fs.readdirSync(__dirname).filter((name) => /^check-.+\.js$/.test(name) && name !== 'check-all.js' && !SKIPPED.has(name) && (browser || !BROWSER.has(name)) && (!only || only.has(name))).sort((a, b) => (FIRST.includes(a) ? FIRST.indexOf(a) : FIRST.length) - (FIRST.includes(b) ? FIRST.indexOf(b) : FIRST.length) || a.localeCompare(b))
  const jobs = String(Math.floor(budget / side))
  const started = Date.now()

  const run = async (name, cap) => {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8')
    const args = [...(ARGS[name] || []), ...(quick && source.includes('--no-mutations') ? ['--no-mutations'] : [])]
    const begun = Date.now()
    const { code, stdout, stderr } = await runChild(path.join(__dirname, name), args, { env: { CHECK_JOBS: cap, ...(quick ? { CHECK_NO_MUTATIONS: '1' } : {}) } })
    const lines = `${stdout}\n${stderr}`.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const summary = lines.filter((line) => /\bchecks?\b.*\b(passed|ok|failed)\b|\bpassed\b/i.test(line)).pop() || lines.pop() || ''
    const result = { name, seconds: (Date.now() - begun) / 1000, code, summary }

    console.log(`${code === 0 ? 'ok  ' : 'FAIL'}  ${result.seconds.toFixed(1).padStart(7)} s  ${name}  ${summary.slice(0, 140)}`)

    if (code !== 0) {
      console.log(lines.filter((line) => /^FAIL|^\s*FAIL|Error/.test(line)).slice(0, 10).map((line) => `        ${line.slice(0, 200)}`).join('\n'))
    }

    return result
  }

  const results = await inParallel(scripts.filter((name) => !ALONE.has(name)), (name) => run(name, jobs), side)

  for (const name of scripts.filter((name) => ALONE.has(name))) {
    results.push(await run(name, String(budget)))
  }

  const done = results.filter((result) => !(result instanceof Error))
  const failed = done.filter((result) => result.code !== 0)

  console.log(`\n${done.length - failed.length} of ${scripts.length} scripts passed in ${((Date.now() - started) / 1000).toFixed(1)} s (${side} side by side, ${jobs} jobs each, ${process.release.name === 'node' && !process.versions.bun ? `node ${process.versions.node}` : `bun ${process.versions.bun}`})`)
  console.log('slowest:')
  done.sort((a, b) => b.seconds - a.seconds).slice(0, 10).forEach((result) => console.log(`  ${result.seconds.toFixed(1).padStart(7)} s  ${result.name}`))
  results.filter((result) => result instanceof Error).forEach((error) => console.log(`FAIL  ${error.message}`))
  process.exit(failed.length || done.length !== scripts.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
