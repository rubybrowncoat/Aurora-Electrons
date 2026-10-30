// Runs parts of a check script (a mutant, a save, the checks of the real sources) in processes of their own, side by side, and prints what each printed in the order of the parts, so the output reads as if the script had run them one after another.
// A part is the script run again with an argument that names it; it runs its checks with the script's own `check` and ends with `endSection(checks, failures)`, which hands its counts to the parent. The parent runs `runSections`, prints each part's lines in place with `printSection` and adds its counts to its own.
const { inParallel, runChild, jobs } = require('./check-pool')
const { quick } = require('./no-mutations')

const COUNTS = 'CHECK-SECTION-COUNTS '

// Ends a part's process: its counts are the last line it prints, with any `extra` figures the script keeps besides (a skipped save, say) for the parent to add up.
const endSection = (checks, failures, extra = {}) => {
  console.log(`${COUNTS}${JSON.stringify({ checks, failures, extra })}`)
  process.exit(0)
}

// Each of `sections` ({ args, weight }: the arguments that name the part and how long it runs, in any one unit) as a process of `script`, no more than `limit` at a time, the longest first so that no long one starts last. A quick run (scripts/lib/no-mutations.js) hands CHECK_NO_MUTATIONS=1 to every part, so that a part that plants a fault fails whatever arguments it was given. Resolves [{ output, checks, failures }] in the order of `sections`; a part that ends with no counts is an error naming how it ended, thrown once all have ended.
const runSections = async (script, sections, limit = jobs()) => {
  const order = sections.map((_section, index) => index).sort((a, b) => (sections[b].weight || 0) - (sections[a].weight || 0) || a - b)
  const done = new Array(sections.length)

  await inParallel(order, async (index) => {
    const { code, stdout, stderr } = await runChild(script, sections[index].args, { env: quick() ? { CHECK_NO_MUTATIONS: '1' } : {} })
    const lines = stdout.split('\n')
    const at = lines.findIndex((row) => row.startsWith(COUNTS))

    if (at === -1) {
      throw new Error(`The part ${sections[index].args.join(' ')} ended with status ${code} and printed no counts: ${(stderr || stdout).trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`)
    }

    done[index] = { output: lines.slice(0, at).join('\n').replace(/\n*$/, ''), ...JSON.parse(lines[at].slice(COUNTS.length)) }
  }, limit).then((results) => {
    const failed = results.find((result) => result instanceof Error)

    if (failed) {
      throw failed
    }
  })

  return done
}

// Prints a part's lines and returns its counts: { checks, failures, extra }.
const printSection = ({ output, checks, failures, extra }) => {
  if (output) {
    console.log(output)
  }

  return { checks, failures, extra }
}

module.exports = { endSection, runSections, printSection }
