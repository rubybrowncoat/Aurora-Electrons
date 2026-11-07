/*
  A scratch copy of the repository (a patch probe, a base tree for a check run), made and removed so that no delete can follow a link out of it.

  bun scripts/lib/scratch-tree.js create <dir> <sha>
  bun scripts/lib/scratch-tree.js remove <dir>

  create: refuses when <dir> exists; extracts `git archive <sha>` of the repository of the current directory into <dir>, links `saves`, `artifacts` and `node_modules` of that repository's root into it as directory junctions (a name the root lacks is skipped) and copies `AuroraDB.db` when the root has one. A failure after the folder was made removes it again the way `remove` does.
  remove: refuses <dir> when a reparse point is above it (every folder from its parent up to the root of the drive is tested without following one) or when the path the disk gives it is another (a device prefix, a short name or a link led to it), so that a folder entered through a link to `saves/` or `artifacts/` is never taken for a plain tree. Then it walks <dir> without following links, unlinks every reparse point (a junction or a symbolic link; `rmdir` without `/s` takes the link and never its target), walks again and refuses while a reparse point is left, and only then deletes the tree. A recursive delete on Windows follows a junction into its target: one `git worktree remove --force` on a tree that linked `artifacts/` and `node_modules/` deleted the owner's artifact sets and half of node_modules (2026-11-06). The delete `fs.rmSync` makes below is the only recursive delete a script of this repository may make, and only after the second walk found no link.

  Exit codes: 0 done; 1 a failure or a wrong command line; 2 a refusal (<dir> exists, <dir> is not a plain directory, a reparse point is above it or was left, the path the disk gives it is another, its real path cannot be read). A link is unlinked through `cmd /c rmdir` on Windows (the command interpreter named by ComSpec) and through `fs.unlink` elsewhere. A link to a file is unlinked through `fs.unlink`, which removes the link and never the file.
*/
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

// The directories of the repository's root that a scratch tree shares instead of copying.
const LINKED = ['saves', 'artifacts', 'node_modules']
const DATABASE = 'AuroraDB.db'

// A refusal: the command was understood and declined, and nothing was changed (or, for `remove`, nothing was deleted).
class Refusal extends Error {}

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })

const git = (root, args) => {
  const result = run('git', ['-C', root, ...args])

  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error ? result.error.message : (result.stderr || '').trim()}`)
  }

  return result.stdout.trim()
}

// The root of the repository that holds `from`, as an absolute path in the platform's own form.
const repositoryRoot = (from = process.cwd()) => path.resolve(git(from, ['rev-parse', '--show-toplevel']))

const lstat = (target) => {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

// Whether `target` is a reparse point. Bun and Node both report a junction, a symbolic link and a mount point as a symbolic link; `readlink` confirms a directory that the first test passed (it answers EINVAL for a plain one), and an answer other than EINVAL counts as a link, so a doubt makes `remove` refuse rather than descend.
const isLink = (target) => {
  const stat = lstat(target)

  if (stat === null) {
    return false
  }

  if (stat.isSymbolicLink()) {
    return true
  }

  if (!stat.isDirectory()) {
    return false
  }

  try {
    fs.readlinkSync(target)

    return true
  } catch (error) {
    return error.code !== 'EINVAL'
  }
}

// Every link under `root`, found without following any: the walk lists a link and does not enter it.
const findLinks = (root) => {
  const links = []
  const pending = [root]

  while (pending.length) {
    const directory = pending.pop()

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)

      if (isLink(entryPath)) {
        links.push(entryPath)
      } else if (entry.isDirectory()) {
        pending.push(entryPath)
      }
    }
  }

  return links
}

const shell = () => process.env.ComSpec || 'cmd.exe'

// A directory junction at `link` to `source` (no administrator rights are needed for a junction).
const makeLink = (link, source) => {
  if (process.platform === 'win32') {
    const result = run(shell(), ['/d', '/c', 'mklink', '/J', link, source])

    if (result.error || result.status !== 0) {
      throw new Error(`mklink /J ${link} ${source} failed: ${result.error ? result.error.message : `${result.stdout}${result.stderr}`.trim()}`)
    }
  } else {
    fs.symlinkSync(source, link, 'dir')
  }

  if (!isLink(link)) {
    throw new Error(`${link} is not a link after it was made`)
  }
}

const followsToDirectory = (link) => {
  try {
    return fs.statSync(link).isDirectory()
  } catch (error) {
    return null
  }
}

// Removes the link `link` and nothing it points to; never throws, since `remove` walks again and refuses over any link that is still there. `rmdir` without /s and `fs.unlink` both take the link alone, and `rmdir` refuses a plain directory that holds anything.
const unlinkLink = (link) => {
  if (process.platform === 'win32' && followsToDirectory(link) !== false) {
    run(shell(), ['/d', '/c', 'rmdir', link])

    return
  }

  try {
    fs.unlinkSync(link)
  } catch (error) {
    // Left in place: the second walk of `remove` names it.
  }
}

const describeLink = (link) => {
  try {
    return fs.readlinkSync(link)
  } catch (error) {
    return '(unreadable)'
  }
}

// The reparse point above `target`, or null: every folder from its parent up to the root of the drive, each tested without following one. An ancestor this process cannot read is left to the real path test of `remove`, which refuses an alias of it anyway.
const linkAbove = (target) => {
  for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
    try {
      if (isLink(parent)) {
        return parent
      }
    } catch (error) {
      // Readable or not, the path the disk gives the tree is compared next.
    }

    if (path.dirname(parent) === parent) {
      return null
    }
  }
}

// The path the disk gives `target`, with the case, the long names and the drive of the folders it really has. It differs from the path given when a link, a short name, a device prefix or a substituted drive led to the tree, and a delete there could reach outside it. A path that cannot be read is a refusal rather than a guess.
const realPath = (target) => {
  try {
    return fs.realpathSync.native(target)
  } catch (error) {
    throw new Refusal(`${target} has no real path this process can read (${error.code || error.message}), so nothing was changed`)
  }
}

// Whether the two paths name the same folder: Windows keeps no case, and both come from `path.resolve` or from the disk, so both use the separator of the platform.
const samePath = (one, other) => (process.platform === 'win32' ? one.toLowerCase() === other.toLowerCase() : one === other)

// Unlinks every link under `dir`, then deletes `dir`; refuses, deleting nothing, while any link is left. `unlink` is the step that takes one link away (a parameter so that a check can hand it one that fails). Returns { unlinked, deleted }.
const removeTree = (dir, { unlink = unlinkLink, say = () => {} } = {}) => {
  const tree = path.resolve(dir)
  const stat = lstat(tree)

  if (stat === null) {
    throw new Error(`${tree} does not exist`)
  }

  if (isLink(tree)) {
    throw new Refusal(`${tree} is itself a link to ${describeLink(tree)}: it is not a scratch tree, and nothing was changed`)
  }

  if (!stat.isDirectory()) {
    throw new Refusal(`${tree} is not a directory`)
  }

  if (path.parse(tree).root === tree) {
    throw new Refusal(`${tree} is the root of a drive`)
  }

  const above = linkAbove(tree)

  if (above) {
    throw new Refusal(`${tree} lies under the reparse point ${above} (it points to ${describeLink(above)}), and a delete there would reach outside the tree: nothing was changed`)
  }

  const real = realPath(tree)

  if (!samePath(real, tree)) {
    throw new Refusal(`${tree} is really ${real}, so a link, a short name of the disk or a device prefix led to it and a delete there would reach outside the tree: nothing was changed`)
  }

  const unlinked = []

  for (const link of findLinks(tree)) {
    const pointed = describeLink(link)

    unlink(link)

    if (!isLink(link)) {
      unlinked.push(link)
      say(`unlinked ${link} (it pointed to ${pointed})`)
    }
  }

  const left = findLinks(tree)

  if (left.length) {
    throw new Refusal(`${left.length} reparse point${left.length === 1 ? '' : 's'} left under ${tree}, so nothing was deleted: ${left.join('; ')}`)
  }

  fs.rmSync(tree, { recursive: true, maxRetries: 3, retryDelay: 100 })
  say(`deleted ${tree}`)

  return { unlinked, deleted: tree }
}

// `git archive` of `sha` unpacked into `target`, through a pipe so that no archive file or drive-lettered path reaches tar.
const extract = (root, sha, target) => new Promise((resolve, reject) => {
  const archive = spawn('git', ['-C', root, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const unpack = spawn('tar', ['-xf', '-'], { cwd: target, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  const errors = { archive: '', unpack: '' }
  const codes = {}
  let settled = false

  const finish = () => {
    if (settled || codes.archive === undefined || codes.unpack === undefined) {
      return
    }

    settled = true

    if (codes.archive === 0 && codes.unpack === 0) {
      resolve()
    } else {
      reject(new Error(`git archive ${sha} | tar -x failed (git ${codes.archive}, tar ${codes.unpack}): ${`${errors.archive}${errors.unpack}`.trim()}`))
    }
  }

  const watch = (name, child) => {
    child.stderr.setEncoding('utf8').on('data', (text) => { errors[name] += text })
    child.on('error', (error) => {
      errors[name] += error.message
      codes[name] = -1
      finish()
    })
    child.on('close', (code) => {
      codes[name] = code === null ? -1 : code
      finish()
    })
  }

  watch('archive', archive)
  watch('unpack', unpack)
  unpack.stdin.on('error', () => {})
  archive.stdout.pipe(unpack.stdin)
})

// A scratch tree of `sha` at `dir`, linked to the saves, artifacts and node_modules of `root`.
const createTree = async (dir, sha, { root = repositoryRoot(), say = () => {} } = {}) => {
  const tree = path.resolve(dir)

  if (lstat(tree) !== null) {
    throw new Refusal(`${tree} exists: a scratch tree is made only in a new folder`)
  }

  if (sha.startsWith('-')) {
    throw new Error(`${sha} is not a commit or tree`)
  }

  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`])
  } catch (error) {
    throw new Error(`${sha} is not a commit or tree of ${root}`)
  }

  fs.mkdirSync(tree, { recursive: true })

  try {
    await extract(root, sha, tree)
    say(`extracted ${sha} of ${root} into ${tree}`)

    for (const name of LINKED) {
      const source = path.join(root, name)
      const link = path.join(tree, name)

      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        say(`skipped ${name}: ${source} is not a directory`)
      } else if (lstat(link) !== null) {
        throw new Error(`${link} exists in the archive of ${sha}`)
      } else {
        makeLink(link, source)
        say(`linked ${link} to ${source}`)
      }
    }

    const database = path.join(root, DATABASE)

    if (fs.existsSync(database)) {
      fs.copyFileSync(database, path.join(tree, DATABASE))
      say(`copied ${database}`)
    }
  } catch (error) {
    try {
      removeTree(tree, { say })
    } catch (cleanup) {
      throw new Error(`${error.message}; the partial tree could not be removed either: ${cleanup.message}`)
    }

    throw error
  }

  return { tree }
}

const USAGE = 'usage: bun scripts/lib/scratch-tree.js create <dir> <sha> | remove <dir>'

const main = async (argv) => {
  const [command, dir, sha, ...rest] = argv

  try {
    if (command === 'create' && dir && sha && !rest.length) {
      await createTree(dir, sha, { say: console.log })
    } else if (command === 'remove' && dir && sha === undefined) {
      removeTree(dir, { say: console.log })
    } else {
      console.error(USAGE)

      return 1
    }
  } catch (error) {
    console.error(error instanceof Refusal ? `refused: ${error.message}` : `failed: ${error.message}`)

    return error instanceof Refusal ? 2 : 1
  }

  return 0
}

module.exports = { Refusal, repositoryRoot, isLink, findLinks, makeLink, unlinkLink, removeTree, createTree }

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
