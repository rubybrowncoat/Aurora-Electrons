// Deals the mutants of a check script to the child processes that run them. A child that runs one mutant pays its start, its requires and the load of every unchanged module for that one mutant; a child that runs several in turn pays them once, and each mutant in it runs as it always did, one after another in a process. The chunks are dealt round robin so a slow kind of mutant (the page ones) is spread over the children, and there are three for each place of the pool, so a slow chunk does not leave the other places idle.
const { jobs } = require('./check-pool')

// The lists of indexes 0..count-1 each child runs, in the order of the indexes.
const chunksOf = (count, parts = Math.max(1, Math.min(count, jobs() * 3))) => Array.from({ length: Math.min(parts, count) }, (_part, part) => Array.from({ length: Math.ceil((count - part) / parts) }, (_item, place) => part + place * parts))

// What each mutant gave, by its index, from what each chunk gave (the list of the results of its mutants in order, or the error of the child): a mutant of a chunk that failed has the error of its child.
const spread = (chunks, outcomes) => {
  const byIndex = []

  chunks.forEach((list, at) => list.forEach((index, place) => { byIndex[index] = outcomes[at] instanceof Error ? outcomes[at] : outcomes[at][place] }))

  return byIndex
}

module.exports = { chunksOf, spread }
