/*
  Loads the renderer's utilities into a Node check script.

  The utilities are ES modules in a package without "type": "module", which Node would reparse with a warning. Each loads from its own source as a file of the process (scripts/lib/module-files.js), its relative imports of other utilities replaced by the URLs of those modules, so every utility loads once and they all share one rule registry (utilities/provenance.js). Only `from './name'` and `from '../name'` imports are rewritten, resolved from the importing file's folder, so a module in a subfolder is named by its path ('warnings/common'): a utility that imports a page or a Vite alias cannot load this way.

  A utility that imports a package loads only when the caller stubs that package: `stubs` maps a package specifier to the source of an ES module that stands in for it, and each `from '<specifier>'` becomes the URL of that source. The stub replaces the package for every utility loaded in the call, so it holds only what the check needs of it.
*/
const fs = require('fs')
const path = require('path')

const directory = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'utilities')

const { urlOfSource } = require('./module-files')

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const moduleUrl = (name, urls, stubs, read, sources) => {
  if (!urls.has(name)) {
    const source = sources[name] !== undefined ? sources[name] : read(name)
    const relative = source.replace(/from '(\.\.?\/[\w\-/]+)'/g, (_match, specifier) => `from '${moduleUrl(path.posix.join(path.posix.dirname(name), specifier), urls, stubs, read, sources)}'`)
    const stubbed = Object.entries(stubs).reduce((text, [specifier, stub]) => text.replace(new RegExp(`from '${escaped(specifier)}'`, 'g'), `from '${urlOfSource(stub)}'`), relative)

    urls.set(name, urlOfSource(stubbed))
  }

  return urls.get(name)
}

// The named utilities, keyed by file name: loadUtilities(['logistics', 'provenance']) gives { logistics, provenance }. `options.directory` loads from another copy of the utilities folder (a check that mutates one); `options.sources` is { [name]: source text } for modules whose text is given instead of read from the folder (a check that plants a fault in one module reads the others from the real folder, with no copy of it); `options.stubs` is { [package specifier]: module source } for the packages those utilities import; `options.texts` is a Map the caller keeps from call to call, so each file of the folder is read once: give it only where the files do not change between the calls.
const loadUtilities = async (names, { stubs = {}, directory: base = directory, sources = {}, texts = new Map() } = {}) => {
  const urls = new Map()
  const modules = {}
  const read = (name) => {
    const file = path.join(base, `${name}.js`)

    if (!texts.has(file)) {
      texts.set(file, fs.readFileSync(file, 'utf8'))
    }

    return texts.get(file)
  }

  for (const name of names) {
    modules[name] = await import(moduleUrl(name, urls, stubs, read, sources))
  }

  return modules
}

module.exports = { loadUtilities }
