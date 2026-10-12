/*
  Loads the renderer's utilities into a Node check script.

  The utilities are ES modules in a package without "type": "module", which Node would reparse with a warning. Each loads from its own source as a data URL, its relative imports of other utilities replaced by the data URLs of those modules, so every utility loads once and they all share one rule registry (utilities/provenance.js). Only `from './name'` imports are rewritten: a utility that imports a package, a page or a Vite alias cannot load this way.
*/
const fs = require('fs')
const path = require('path')

const directory = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'utilities')

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

const moduleUrl = (name, urls) => {
  if (!urls.has(name)) {
    const source = fs.readFileSync(path.join(directory, `${name}.js`), 'utf8')

    urls.set(name, dataUrl(source.replace(/from '\.\/([\w-]+)'/g, (_match, dependency) => `from '${moduleUrl(dependency, urls)}'`)))
  }

  return urls.get(name)
}

// The named utilities, keyed by file name: loadUtilities(['logistics', 'provenance']) gives { logistics, provenance }.
const loadUtilities = async (names) => {
  const urls = new Map()
  const modules = {}

  for (const name of names) {
    modules[name] = await import(moduleUrl(name, urls))
  }

  return modules
}

module.exports = { loadUtilities }
