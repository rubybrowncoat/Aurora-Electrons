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

// Each unpacked package under `buildDir` (win-unpacked, linux-unpacked, mac/*.app) has it too.
const checkPackaged = (buildDir) => {
  const packages = []

  const visit = (folder) => {
    fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((entry) => {
      const file = path.join(folder, entry.name)

      if (entry.name === 'sqlite3' && path.basename(folder) === 'node_modules') {
        packages.push(file)
      } else if (entry.name !== 'icons') {
        visit(file)
      }
    })
  }

  visit(buildDir)

  if (!packages.length) {
    fail(`No package in ${buildDir} contains sqlite3.`)
  }

  packages.filter((folder) => !findBinaries(folder).length).forEach((folder) => fail(`${BINARY} is missing from the package at ${folder}, so the app could not open the save.`))

  return packages
}

module.exports = { checkInstalled, checkPackaged }
