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

// The sources with a group of edits made together: `members` is [{ name, file, find, to }], `file` the key of the text in `texts` (`label(file)` is the file name the source is parsed as, the key itself when not given). Each `find` occurs exactly once in the text as it is, no two members of one file replace overlapping text (so one never changes the anchor of another, and the order they are made in is of no matter), and every changed source still parses. Members of different files never meet. `texts` is returned with the changed sources replaced.
const patchedGroup = (texts, members, label = (file) => file) => {
  const edits = new Map()

  for (const member of members) {
    const text = texts[member.file]

    if (typeof text !== 'string') {
      throw new TypeError(`The member "${member.name}" of the group names ${member.file}, which is no source of the group`)
    }

    const count = text.split(member.find).length - 1

    if (count !== 1) {
      throw new Error(`The anchor of the member "${member.name}" of the group does not apply exactly once in ${label(member.file)} (${count} matches): ${member.find}`)
    }

    const start = text.indexOf(member.find)
    const end = start + member.find.length
    const taken = edits.get(member.file) || []
    const meets = taken.find((other) => start < other.end && other.start < end)

    if (meets) {
      throw new Error(`The members "${meets.name}" and "${member.name}" of the group touch the same text of ${label(member.file)}: members of one file need different anchors`)
    }

    edits.set(member.file, [...taken, { start, end, to: member.to, name: member.name }])
  }

  const result = { ...texts }

  for (const [file, list] of edits) {
    result[file] = [...list].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.to}${text.slice(edit.end)}`, texts[file])
    assertParses(label(file), result[file])
  }

  return result
}

// `patchedGroup` for a group of faults: it throws in a quick run, as `plantedPatch` does.
const plantedGroup = (texts, members, label) => {
  refusePlanting(members.map((member) => member.name).join('; '))

  return patchedGroup(texts, members, label)
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

module.exports = { assertParses, patched, patchedGroup, plantedPatch, plantedGroup, plantedCopy }
