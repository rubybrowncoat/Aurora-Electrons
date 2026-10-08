// `bun run build`: electron-vite builds out/, then electron-builder packages it into build/. Arguments go to
// electron-builder (`bun run build --linux`); builder.config.js is its config unless one is given.
require('./check-engines')

const path = require('path')
const { spawnSync } = require('child_process')

const { checkInstalled, checkPackaged } = require('./check-native')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(PROJECT_ROOT, 'build')

const run = (args) => {
  const { status } = spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, stdio: 'inherit' })

  if (status !== 0) {
    process.exit(status ?? 1)
  }
}

const builderArguments = () => {
  const args = process.argv.slice(2)

  return args.includes('--config') || args.includes('-c') ? args : [...args, '--config', 'builder.config.js']
}

checkInstalled(PROJECT_ROOT)

run([path.join(__dirname, 'run-vite.js'), 'node_modules/electron-vite/bin/electron-vite.js', 'build'])
run([require.resolve('electron-builder/cli.js'), ...builderArguments()])

checkPackaged(BUILD_DIR).forEach((folder) => console.log(`sqlite3 binary present in ${folder}`))
