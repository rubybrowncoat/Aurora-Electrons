// Runs a Node script that uses Vite: `node scripts/run-vite.js <script> [args]`, the script relative to the project.
//
// Vite can't build or serve a project whose path contains '#': it cuts module ids at the '#' like a URL's fragment,
// so modules come out empty and its dev client never loads. A checkout under Aurora's own "Aurora C#" folder has
// one. There, the script runs from a directory junction in the temp folder that leads back to the project, and Node
// keeps the junction's paths instead of resolving them (--preserve-symlinks), so neither the project's files nor
// Vite's own see the '#'. The Vite configs set resolve.preserveSymlinks for the same reason.
require('./check-engines')

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')

const readLink = (link) => {
  try {
    return fs.readlinkSync(link)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

// The junction to the project, created or repointed as needed.
const junction = () => {
  const hash = crypto.createHash('sha1').update(PROJECT_ROOT).digest('hex').slice(0, 8)
  const link = path.join(os.tmpdir(), `aurora-electrons-${hash}`)

  if (link.includes('#')) {
    throw new Error(`The project path (${PROJECT_ROOT}) and the temp folder (${os.tmpdir()}) both contain '#', which Vite cannot handle. Move the project to a path without one.`)
  }

  const target = readLink(link)

  if (target !== null && path.resolve(target) === PROJECT_ROOT) {
    return link
  }

  if (target !== null) {
    fs.unlinkSync(link)
  }

  // 'junction' needs no admin rights on Windows; other systems ignore the type and make a plain symlink.
  fs.symlinkSync(PROJECT_ROOT, link, 'junction')

  return link
}

const [script, ...args] = process.argv.slice(2)
const root = PROJECT_ROOT.includes('#') ? junction() : PROJECT_ROOT
const flags = root === PROJECT_ROOT ? [] : ['--preserve-symlinks', '--preserve-symlinks-main']

// electron-vite looks for its config and package.json in the working directory, and starts Electron there in dev.
spawn(process.execPath, [...flags, path.join(root, script), ...args], { cwd: root, stdio: 'inherit' })
  .on('exit', (code) => process.exit(code ?? 1))
