/*
  The app reads the save through sqlite3's native binary, which has to ship inside the package.
  Without it the database never opens. A tool that replaces the file while a process has it loaded
  (npm, node-gyp or electron-builder's rebuild, through node-tar) leaves it missing, renamed to
  node_sqlite3.node.DELETE.<hash>, and nothing about the build says so. These checks make the build
  say so: one before anything is built, one on every package it produced.
 */
const fs = require('fs')
const path = require('path')

const BINARY = 'node_sqlite3.node'

// Every sqlite3 binary under `root`, the folders it holds them in being lib/binding/<platform>.
const findBinaries = (root, found = []) => {
  fs.readdirSync(root, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(root, entry.name)

    if (entry.isDirectory()) {
      findBinaries(file, found)
    } else if (entry.name === BINARY) {
      found.push(file)
    }
  })

  return found
}

const fail = (message) => {
  throw new Error(`${message}\n\tRestore it with: (cd node_modules/sqlite3 && ../.bin/node-pre-gyp install --fallback-to-build=false)`)
}

// node_modules/sqlite3 has its binary, before packaging copies it.
const checkInstalled = (projectRoot) => {
  const binding = path.join(projectRoot, 'node_modules', 'sqlite3', 'lib', 'binding')

  if (!fs.existsSync(binding) || !findBinaries(binding).length) {
    fail(`${BINARY} is missing from ${binding}, so the packaged app could not open the save.`)
  }
}

const subfolders = (folder) => fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(folder, entry.name)) : []

// The package outputs electron-builder leaves under `buildDir`: win-unpacked, linux-unpacked and their per-arch
// variants at the top level, and the .app bundles inside mac, mac-arm64, mac-universal and mas*. Each is paired with
// the folder its app files live in.
const findPackages = (buildDir) => {
  const unpacked = subfolders(buildDir).filter((folder) => path.basename(folder).endsWith('-unpacked')).map((folder) => ({ folder, resources: path.join(folder, 'resources') }))
  const bundles = subfolders(buildDir)
    .filter((folder) => /^(mac|mas)/.test(path.basename(folder)))
    .flatMap(subfolders)
    .filter((folder) => folder.endsWith('.app'))
    .map((folder) => ({ folder, resources: path.join(folder, 'Contents', 'Resources') }))

  return [...unpacked, ...bundles]
}

// Every package under `buildDir` has sqlite3 with its binary, in the unpacked app folder or, with an asar, beside it.
const checkPackaged = (buildDir) => {
  const packages = findPackages(buildDir)

  if (!packages.length) {
    fail(`No package found in ${buildDir}: expected *-unpacked folders or mac*/*.app bundles.`)
  }

  return packages.flatMap(({ folder, resources }) => {
    const modules = ['app', 'app.asar.unpacked'].map((name) => path.join(resources, name, 'node_modules', 'sqlite3')).filter((candidate) => fs.existsSync(candidate))

    if (!modules.length) {
      fail(`The package at ${folder} has no sqlite3 folder, so the app could not open the save.`)
    }

    modules.filter((candidate) => !findBinaries(candidate).length).forEach((candidate) => fail(`${BINARY} is missing from the package at ${candidate}, so the app could not open the save.`))

    return modules
  })
}

module.exports = { checkInstalled, checkPackaged }
