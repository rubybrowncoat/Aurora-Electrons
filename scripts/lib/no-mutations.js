/*
  A quick run (`--no-mutations`) runs the head checks of a script and plants no fault. This module answers whether the run is one, and refuses a planting in it, so that a script that plants faults and ignores the flag fails instead of silently running its faults.

  `scripts/check-all.js --quick` passes `--no-mutations` to the scripts that name it and sets CHECK_NO_MUTATIONS=1 in the environment of every script. A script that plants faults asks `mutating()` before it starts any; the planting helpers (`plantedPatch` and `plantedCopy` of scripts/lib/mutant-source.js, and the helper of a script that plants a fault another way) call `refusePlanting`, which throws in a quick run. `patched` does not refuse, because a head check rewrites a source as well (an anchor check, a configuration of the subject).
*/
const quick = () => process.argv.includes('--no-mutations') || process.env.CHECK_NO_MUTATIONS === '1'

const mutating = () => !quick()

// Throws, naming `what` (the file, the fault or the label), when this is a quick run.
const refusePlanting = (what) => {
  if (quick()) {
    throw new Error(`a fault is planted in a quick run (--no-mutations or CHECK_NO_MUTATIONS=1): ${what}. A script that plants faults must skip them when mutating() is false.`)
  }
}

module.exports = { quick, mutating, refusePlanting }
