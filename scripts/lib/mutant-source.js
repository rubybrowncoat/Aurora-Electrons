/*
  What a check of the checks does with a planted fault before it judges one: the source it changes must still parse, and the text it replaces must be there exactly once. A fault that breaks the syntax of a module or a component, or whose anchor no longer matches, makes the checks throw or leaves the source as it was, and a thrown check counts as failed, so such a fault would be reported as caught without any check having looked at what it was meant to plant. Each runner reports it as an invalid mutant instead, and fails the run.

  A `.vue` file is checked through its script block (read with vue/compiler-sfc); its template and style are not parsed, only their anchors are matched.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')

const acorn = require('acorn')

const { refusePlanting } = require('./no-mutations')

// vue/compiler-sfc takes tens of milliseconds to load and only a component needs it, so it loads on the first `.vue` file.
const scriptOf = (file, text) => {
  if (!file.endsWith('.vue')) {
    return text
  }

  const parsed = require('vue/compiler-sfc').parse({ source: text })
  const descriptor = parsed.descriptor || parsed

  return [descriptor.script, descriptor.scriptSetup].map((block) => (block && block.content) || '').join('\n')
}

// Throws unless the source parses: a module as an ES module, a component by its script block; any other file is not parsed.
const assertParses = (file, text) => {
  if (!/\.(js|vue)$/.test(file)) {
    return
  }

  try {
    acorn.parse(scriptOf(file, text), { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (error) {
    throw new Error(`${file} does not parse: ${error.message}`)
  }
}

// The source with `from` replaced by `to`, where `from` occurs exactly once and the result still parses.
const patched = (file, text, from, to) => {
  const count = text.split(from).length - 1

  if (count !== 1) {
    throw new Error(`The mutation of ${file} does not apply exactly once (${count} matches): ${from}`)
  }

  const result = text.replace(from, () => to)

  assertParses(file, result)

  return result
}

// `patched` for a fault: it throws in a quick run (--no-mutations, scripts/lib/no-mutations.js), so a script that plants faults and ignores the flag fails. `patched` itself also serves the rewrites of a head check, which a quick run keeps.
const plantedPatch = (file, text, from, to) => {
  refusePlanting(`${file}: ${from}`)

  return patched(file, text, from, to)
}

// A temporary copy of `directory` with `from` replaced by `to` in `file`, made only when the fault is valid, so an invalid one leaves nothing behind. A fault, so it throws in a quick run as `plantedPatch` does.
const plantedCopy = (directory, prefix, file, from, to) => {
  refusePlanting(`${file}: ${from}`)

  const result = patched(file, fs.readFileSync(path.join(directory, file), 'utf8'), from, to)
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

  fs.cpSync(directory, copy, { recursive: true })
  fs.writeFileSync(path.join(copy, file), result)

  return copy
}

module.exports = { assertParses, patched, plantedPatch, plantedCopy }
