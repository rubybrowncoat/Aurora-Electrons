/*
  Loads the renderer's utilities into a Node check script.

  The utilities are ES modules in a package without "type": "module", which Node would reparse with a warning. Each loads from its own source as a data URL, its relative imports of other utilities replaced by the data URLs of those modules, so every utility loads once and they all share one rule registry (utilities/provenance.js). Only `from './name'` and `from '../name'` imports are rewritten, resolved from the importing file's folder, so a module in a subfolder is named by its path ('warnings/common'): a utility that imports a page or a Vite alias cannot load this way.

  A utility that imports a package loads only when the caller stubs that package: `stubs` maps a package specifier to the source of an ES module that stands in for it, and each `from '<specifier>'` becomes a data URL of that source. The stub replaces the package for every utility loaded in the call, so it holds only what the check needs of it.
*/
const fs = require('fs')
const path = require('path')

const directory = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'utilities')

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const moduleUrl = (name, urls, stubs, base) => {
  if (!urls.has(name)) {
    const source = fs.readFileSync(path.join(base, `${name}.js`), 'utf8')
    const relative = source.replace(/from '(\.\.?\/[\w\-/]+)'/g, (_match, specifier) => `from '${moduleUrl(path.posix.join(path.posix.dirname(name), specifier), urls, stubs, base)}'`)
    const stubbed = Object.entries(stubs).reduce((text, [specifier, stub]) => text.replace(new RegExp(`from '${escaped(specifier)}'`, 'g'), `from '${dataUrl(stub)}'`), relative)

    urls.set(name, dataUrl(stubbed))
  }

  return urls.get(name)
}

// The named utilities, keyed by file name: loadUtilities(['logistics', 'provenance']) gives { logistics, provenance }. `options.directory` loads from another copy of the utilities folder (a check that mutates one); `options.stubs` is { [package specifier]: module source } for the packages those utilities import.
const loadUtilities = async (names, { stubs = {}, directory: base = directory } = {}) => {
  const urls = new Map()
  const modules = {}

  for (const name of names) {
    modules[name] = await import(moduleUrl(name, urls, stubs, base))
  }

  return modules
}

module.exports = { loadUtilities }
