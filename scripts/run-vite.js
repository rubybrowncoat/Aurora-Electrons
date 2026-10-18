// Runs a Node script that uses Vite: `node scripts/run-vite.js <script> [args]`, the script relative to the project.
//
// Vite can't build or serve a project whose path contains '#': it cuts module ids at the '#' like a URL's fragment, so modules come out empty and its dev client never loads. A checkout under Aurora's own "Aurora C#" folder has one. There, the script runs from a directory junction in the temp folder that leads back to the project (scripts/lib/safe-root.js), and Node keeps the junction's paths instead of resolving them (--preserve-symlinks), so neither the project's files nor Vite's own see the '#'. The Vite configs set resolve.preserveSymlinks for the same reason.
require('./check-engines')

const path = require('path')
const { spawn } = require('child_process')
const { safeRoot } = require('./lib/safe-root')

const PROJECT_ROOT = path.resolve(__dirname, '..')

const [script, ...args] = process.argv.slice(2)
const root = safeRoot(PROJECT_ROOT)
const flags = root === PROJECT_ROOT ? [] : ['--preserve-symlinks', '--preserve-symlinks-main']

// electron-vite looks for its config and package.json in the working directory, and starts Electron there in dev.
spawn(process.execPath, [...flags, path.join(root, script), ...args], { cwd: root, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1))
