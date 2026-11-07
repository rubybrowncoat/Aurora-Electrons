/*
  Checks scripts/lib/scratch-tree.js, the one way a scratch copy of the repository is made and removed (AGENTS.md, "Scratch trees"): `remove` leaves what a junction in the tree points to whole, and `create` makes the tree and its links.

  bun scripts/check-scratch-tree.js [--no-mutations] [mutant:<N> ...]

  Everything runs on temporary targets made here (two folders with sentinel files, a small git repository with `saves/`, `artifacts/`, `node_modules/` and `AuroraDB.db`), never on the real `saves/` or `artifacts/`; the helper runs as a process of its own (`bun scripts/lib/scratch-tree.js ...`) and every temporary tree is removed through the helper, never by a recursive delete of this script's own.
  - remove: a tree with real files and junctions to both targets at its top, a tree with junctions one and two levels deep, a tree whose junctions cannot be unlinked (the command interpreter that unlinks one is made absent through ComSpec; the helper must refuse, delete nothing, and finish once the unlink works), a folder reached through a junction above it, a path the disk gives another name (a device prefix, a Windows case), a link given as the tree itself, a plain file and a missing folder;
  - create: the archive of a revision is extracted, `saves`, `artifacts` and `node_modules` are junctions to the root's folders, `AuroraDB.db` is copied, `remove` of that tree leaves the root's folders whole; an existing folder is refused and left as it was, an unknown revision leaves no folder.
  Each planted fault rewrites the helper in a copy and must fail the cases it names. The faults that let a delete reach a junction (the unlink step skipped, the second walk skipped, the walk that stops at the top) run against throwaway targets in the temporary folder, and a fault that deletes through a junction is seen as the targets' sentinels missing. The guard above the tree and the test of the real path refuse the same folder, so the fault that drops the walk is caught by the refusal that names the junction (the real path test refuses the same path with another message, and the target is whole either way), and the fault that drops the real path test by the device prefix, where no ancestor is a link. `mutant:<N>` runs only the fault of that number. The third case cannot be made with a link that refuses `rmdir` without administrator rights, so the unlink is made impossible by the absent interpreter instead (a Windows case; elsewhere a symbolic link cannot fail to unlink and the case is skipped). The device prefix is a Windows spelling of a path, and no alias of a plain folder without a link was found elsewhere, so that case is skipped too.

  Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const assert = require('./lib/bounded-assert')
const { runChild } = require('./lib/check-pool')
const { mutating: mayPlant, refusePlanting } = require('./lib/no-mutations')
const { patched } = require('./lib/mutant-source')
const helper = require('./lib/scratch-tree')

const HELPER = path.join(__dirname, 'lib', 'scratch-tree.js')
const SENTINELS = {
  'a/sentinel.txt': 'sentinel of target a',
  'a/inner/deep.txt': 'deep file of target a',
  'b/sentinel.txt': 'sentinel of target b',
  'b/second.txt': 'second file of target b',
}
const ROOT_FILES = {
  'saves/one.db': 'a save',
  'artifacts/set/a.txt': 'an artifact',
  'node_modules/pkg/index.js': 'a module',
  'AuroraDB.db': 'the database',
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const absent = (target) => {
  try {
    fs.lstatSync(target)

    return false
  } catch (error) {
    return true
  }
}

// Every file under `root` (a folder of plain files, no link in it, and no folder named in `skip`) as { relative name: text }; a missing folder holds nothing.
const state = (root, skip = []) => {
  const found = {}
  const pending = [root]

  while (pending.length) {
    const directory = pending.pop()

    if (!fs.existsSync(directory)) {
      continue
    }

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory() && !skip.includes(entry.name)) {
        pending.push(entryPath)
      } else if (!entry.isDirectory()) {
        found[path.relative(root, entryPath).split(path.sep).join('/')] = fs.readFileSync(entryPath, 'utf8')
      }
    }
  }

  return found
}

// The files of `before` that `after` no longer holds as they were.
const lost = (before, after) => Object.keys(before).filter((name) => after[name] !== before[name])

const assertWhole = (before, after, what) => assert.deepStrictEqual(lost(before, after), [], `these files of ${what} were deleted or changed: the delete went through a link`)

// A temporary folder for `work`, removed through the helper afterwards: its junctions are unlinked first, so that a fault that leaves one cannot take its target with it.
const withBase = async (work) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-scratch-tree-'))

  try {
    return await work(base)
  } finally {
    helper.removeTree(base)
  }
}

// A junction at `link` to `target`, refused unless both are inside `base`: a planted fault must only ever be able to reach throwaway files.
const link = (base, linkPath, target) => {
  assert.ok(linkPath.startsWith(base + path.sep) && target.startsWith(base + path.sep), `${linkPath} -> ${target} leaves ${base}`)
  helper.makeLink(linkPath, target)
}

// The two targets with their sentinels, and a scratch tree with real files; `plant(scratch, targets)` adds the junctions.
const fixture = (base, plant) => {
  const targets = path.join(base, 'targets')
  const scratch = path.join(base, 'scratch')

  Object.entries(SENTINELS).forEach(([name, text]) => write(path.join(targets, name), text))
  write(path.join(scratch, 'keep.txt'), 'a real file of the scratch tree')
  write(path.join(scratch, 'src', 'code.js'), 'a real file in a folder')
  plant(scratch, targets, base)

  return { targets, scratch }
}

const remove = (helperPath, dir, env = {}) => runChild(helperPath, ['remove', dir], { env })

const commandInterpreter = () => Object.keys(process.env).find((name) => name.toLowerCase() === 'comspec') || 'ComSpec'

// A small repository with a tracked file, and the folders of the root that a scratch tree links. Its line endings are kept as written (the owner's global setting converts them), and its git commands print nothing.
const makeRepo = (base) => {
  const repo = path.join(base, 'repo')
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  write(path.join(repo, 'package.json'), '{"name":"root"}\n')
  write(path.join(repo, 'src', 'app.js'), 'module.exports = 1\n')
  write(path.join(repo, '.gitignore'), 'saves/\nartifacts/\nnode_modules/\nAuroraDB.db\n')
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('add', '-A')
  git('-c', 'user.name=check', '-c', 'user.email=check@example.invalid', 'commit', '-q', '-m', 'base')
  Object.entries(ROOT_FILES).forEach(([name, text]) => write(path.join(repo, name), text))

  return repo
}

// `create` of the helper in the current folder `repo` (the root is the repository of the current directory, and a child starts in the current directory).
const create = async (helperPath, repo, dir, sha) => {
  const here = process.cwd()

  process.chdir(repo)

  try {
    return await runChild(helperPath, ['create', dir, sha])
  } finally {
    process.chdir(here)
  }
}

const same = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()

const CASES = [
  ['remove unlinks the junctions at the top of a tree, deletes the tree and leaves both targets whole', (helperPath) => withBase(async (base) => {
    const { targets, scratch } = fixture(base, (s, t, b) => {
      link(b, path.join(s, 'link-a'), path.join(t, 'a'))
      link(b, path.join(s, 'link-b'), path.join(t, 'b'))
    })
    const before = state(targets)
    const { code, stdout, stderr } = await remove(helperPath, scratch)

    assertWhole(before, state(targets), 'the targets')
    assert.strictEqual(code, 0, `remove ended with ${code}: ${stderr.trim()}`)
    assert.ok(absent(scratch), 'the scratch tree is still there')
    assert.ok(stdout.includes(`unlinked ${path.join(scratch, 'link-a')}`) && stdout.includes(`unlinked ${path.join(scratch, 'link-b')}`), `it does not say what it unlinked: ${stdout.trim()}`)
    assert.ok(stdout.includes(`deleted ${scratch}`), `it does not say what it deleted: ${stdout.trim()}`)
  })],
  ['remove finds junctions one and two levels deep', (helperPath) => withBase(async (base) => {
    const { targets, scratch } = fixture(base, (s, t, b) => {
      fs.mkdirSync(path.join(s, 'one', 'two'), { recursive: true })
      link(b, path.join(s, 'one', 'link-b'), path.join(t, 'b'))
      link(b, path.join(s, 'one', 'two', 'link-a'), path.join(t, 'a'))
    })
    const before = state(targets)
    const { code, stderr } = await remove(helperPath, scratch)

    assertWhole(before, state(targets), 'the targets')
    assert.strictEqual(code, 0, `remove ended with ${code}: ${stderr.trim()}`)
    assert.ok(absent(scratch), 'the scratch tree is still there')
  })],
  ['remove refuses while a junction cannot be unlinked, deletes nothing, and finishes once it can', (helperPath) => withBase(async (base) => {
    if (process.platform !== 'win32') {
      return
    }

    const { targets, scratch } = fixture(base, (s, t, b) => {
      fs.mkdirSync(path.join(s, 'one'), { recursive: true })
      link(b, path.join(s, 'link-a'), path.join(t, 'a'))
      link(b, path.join(s, 'one', 'link-b'), path.join(t, 'b'))
    })
    const before = state(targets)
    const refused = await remove(helperPath, scratch, { [commandInterpreter()]: path.join(base, 'no-such-interpreter.exe') })

    assertWhole(before, state(targets), 'the targets')
    assert.strictEqual(refused.code, 2, `remove ended with ${refused.code} instead of refusing: ${refused.stderr.trim()}`)
    assert.ok(refused.stderr.includes('reparse point') && refused.stderr.includes(path.join(scratch, 'link-a')), `the refusal does not name the junction: ${refused.stderr.trim()}`)
    assert.ok(!refused.stdout.includes('deleted'), `it says it deleted: ${refused.stdout.trim()}`)
    assert.strictEqual(fs.readFileSync(path.join(scratch, 'keep.txt'), 'utf8'), 'a real file of the scratch tree', 'the tree lost a real file')
    assert.ok(helper.isLink(path.join(scratch, 'link-a')), 'the junction is gone')

    const finished = await remove(helperPath, scratch)

    assertWhole(before, state(targets), 'the targets')
    assert.strictEqual(finished.code, 0, `the second remove ended with ${finished.code}: ${finished.stderr.trim()}`)
    assert.ok(absent(scratch), 'the scratch tree is still there after the second remove')
  })],
  ['remove refuses a folder reached through a junction above it, and what it points to is whole', (helperPath) => withBase(async (base) => {
    const target = path.join(base, 'target')
    const linkPath = path.join(base, 'link')
    const reached = path.join(linkPath, 'nested')

    write(path.join(target, 'nested', 'sentinel.txt'), 'the sentinel of the target')
    link(base, linkPath, target)

    const before = state(target)
    const { code, stdout, stderr } = await remove(helperPath, reached)

    assertWhole(before, state(target), 'the target')
    assert.strictEqual(code, 2, `remove ended with ${code} instead of refusing: ${stderr.trim()}`)
    assert.ok(stderr.includes(`lies under the reparse point ${linkPath}`), `the refusal does not name the junction above the tree: ${stderr.trim()}`)
    assert.ok(!stdout.includes('deleted'), `it says it deleted: ${stdout.trim()}`)
    assert.strictEqual(fs.readFileSync(path.join(target, 'nested', 'sentinel.txt'), 'utf8'), 'the sentinel of the target', 'the sentinel of the target is gone')
    assert.ok(helper.isLink(linkPath), 'the junction above the tree was unlinked')
    assert.ok(fs.existsSync(reached), 'the folder reached through the junction is gone')
  })],
  ['remove refuses a path the disk gives another name, as a device prefix makes it', (helperPath) => withBase(async (base) => {
    if (process.platform !== 'win32') {
      return
    }

    const tree = path.join(base, 'tree')
    const given = `\\\\?\\${path.resolve(tree)}`

    write(path.join(tree, 'inner', 'sentinel.txt'), 'the sentinel of the tree')

    const real = fs.realpathSync.native(tree)

    assert.notStrictEqual(real.toLowerCase(), given.toLowerCase(), `${given} is not an alias of ${real}, so the case would prove nothing`)

    const before = state(tree)
    const { code, stdout, stderr } = await remove(helperPath, given)

    assertWhole(before, state(tree), 'the tree')
    assert.strictEqual(code, 2, `remove ended with ${code} instead of refusing: ${stderr.trim()}`)
    assert.ok(stderr.includes(`is really ${real}`), `the refusal does not name the path the disk gives it: ${stderr.trim()}`)
    assert.ok(!stdout.includes('deleted'), `it says it deleted: ${stdout.trim()}`)
    assert.strictEqual(fs.readFileSync(path.join(tree, 'inner', 'sentinel.txt'), 'utf8'), 'the sentinel of the tree', 'the sentinel of the tree is gone')
  })],
  ['remove refuses a link as the tree itself, a file, and says a missing folder is missing', (helperPath) => withBase(async (base) => {
    const { targets } = fixture(base, () => {})
    const asTree = path.join(base, 'as-tree')
    const file = path.join(base, 'plain.txt')

    link(base, asTree, path.join(targets, 'a'))
    write(file, 'a plain file')

    const before = state(targets)
    const linked = await remove(helperPath, asTree)
    const filed = await remove(helperPath, file)
    const missing = await remove(helperPath, path.join(base, 'missing'))

    assertWhole(before, state(targets), 'the targets')
    assert.strictEqual(linked.code, 2, `a link as the tree ended with ${linked.code}: ${linked.stderr.trim()}`)
    assert.ok(helper.isLink(asTree), 'the link given as the tree was unlinked')
    assert.strictEqual(filed.code, 2, `a file ended with ${filed.code}: ${filed.stderr.trim()}`)
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'a plain file', 'the file was changed')
    assert.strictEqual(missing.code, 1, `a missing folder ended with ${missing.code}: ${missing.stderr.trim()}`)
  })],
  ['create extracts the archive, links saves, artifacts and node_modules, copies AuroraDB.db, and remove leaves the root whole', (helperPath) => withBase(async (base) => {
    const repo = makeRepo(base)
    const scratch = path.join(base, 'scratch', 'tree')
    const before = state(repo, ['.git'])
    const { code, stdout, stderr } = await create(helperPath, repo, scratch, 'HEAD')

    assert.strictEqual(code, 0, `create ended with ${code}: ${stderr.trim()}`)
    assert.strictEqual(fs.readFileSync(path.join(scratch, 'package.json'), 'utf8'), '{"name":"root"}\n', 'a tracked file is not extracted')
    assert.strictEqual(fs.readFileSync(path.join(scratch, 'src', 'app.js'), 'utf8'), 'module.exports = 1\n', 'a tracked file of a folder is not extracted')

    for (const name of ['saves', 'artifacts', 'node_modules']) {
      assert.ok(helper.isLink(path.join(scratch, name)), `${name} is not a link`)
      assert.ok(same(path.join(scratch, name), path.join(repo, name)), `${name} does not point to the folder of the root`)
      assert.ok(stdout.includes(`linked ${path.join(scratch, name)}`), `it does not say it linked ${name}: ${stdout.trim()}`)
    }

    assert.strictEqual(fs.readFileSync(path.join(scratch, 'AuroraDB.db'), 'utf8'), 'the database', 'AuroraDB.db is not copied')
    assert.ok(!helper.isLink(path.join(scratch, 'AuroraDB.db')), 'AuroraDB.db is a link and not a copy')
    assert.deepStrictEqual(state(repo, ['.git']), before, 'creating the tree changed the root')

    const removed = await remove(helperPath, scratch)

    assertWhole(before, state(repo, ['.git']), 'the root')
    assert.strictEqual(removed.code, 0, `remove of the created tree ended with ${removed.code}: ${removed.stderr.trim()}`)
    assert.ok(absent(scratch), 'the created tree is still there after remove')
  })],
  ['create refuses an existing folder and leaves it as it was, and an unknown revision leaves no folder', (helperPath) => withBase(async (base) => {
    const repo = makeRepo(base)
    const scratch = path.join(base, 'first')
    const unknown = path.join(base, 'unknown')
    const before = state(repo, ['.git'])
    const made = await create(helperPath, repo, scratch, 'HEAD')

    assert.strictEqual(made.code, 0, `create ended with ${made.code}: ${made.stderr.trim()}`)

    const again = await create(helperPath, repo, scratch, 'HEAD')
    const nothing = await create(helperPath, repo, unknown, '0123456789abcdef0123456789abcdef01234567')

    assertWhole(before, state(repo, ['.git']), 'the root')
    assert.strictEqual(again.code, 2, `create into an existing folder ended with ${again.code}: ${again.stderr.trim()}`)
    assert.ok(helper.isLink(path.join(scratch, 'saves')) && fs.existsSync(path.join(scratch, 'package.json')), 'the existing tree was changed')
    assert.strictEqual(nothing.code, 1, `create of an unknown revision ended with ${nothing.code}: ${nothing.stderr.trim()}`)
    assert.ok(absent(unknown), 'an unknown revision left a folder')

    const removed = await remove(helperPath, scratch)

    assertWhole(before, state(repo, ['.git']), 'the root')
    assert.strictEqual(removed.code, 0, `remove ended with ${removed.code}: ${removed.stderr.trim()}`)
  })],
]

// A delete that follows a junction into its target, as the delete of `git worktree remove --force` did on 2026-11-06 (`fs.rmSync` of Bun does not follow one, so a fault of the guards would show nothing through it): the last step of `remove` made by this rewrite empties a folder through every link it meets and then takes the link itself away. With the guards of the helper intact no link reaches it, so the rewrite passes every case; with a guard faulted, a link reaches it and the target's sentinels go.
const FOLLOWING = ['fs.rmSync(tree, { recursive: true, maxRetries: 3, retryDelay: 100 })', '((emptyInto) => { emptyInto(tree); fs.rmdirSync(tree) })(function emptyInto(directory) { for (const name of fs.readdirSync(directory)) { const entryPath = path.join(directory, name); if (fs.statSync(entryPath).isDirectory()) { emptyInto(entryPath); fs.rmdirSync(entryPath) } else { fs.unlinkSync(entryPath) } } })']

// [label, [[from, to], ...] applied to the helper (each `from` exactly once), the names the cases it must fail begin with (none: a rewrite that every case must pass)]
const MUTATIONS = [
  ['equivalent: the final delete follows junctions, so the guards alone keep the targets whole', [FOLLOWING], []],
  ['the unlink step is skipped', [FOLLOWING, ['\n    unlink(link)\n', '\n']], ['remove unlinks', 'remove finds', 'create extracts']],
  ['the second walk is skipped', [FOLLOWING, ['  const left = findLinks(tree)\n', '  const left = []\n']], ['remove refuses while']],
  ['the unlink step and the second walk are both skipped (a plain recursive delete)', [FOLLOWING, ['\n    unlink(link)\n', '\n'], ['  const left = findLinks(tree)\n', '  const left = []\n']], ['remove unlinks', 'remove finds', 'remove refuses while']],
  ['the walk does not enter a folder', [FOLLOWING, ['} else if (entry.isDirectory()) {', '} else if (false) {']], ['remove finds']],
  ['a link given as the tree is accepted (neither guard refuses it)', [FOLLOWING, ['  if (isLink(tree)) {\n    throw new Refusal(', '  if (false) {\n    throw new Refusal('], ['  if (!stat.isDirectory()) {\n    throw new Refusal(', '  if (false) {\n    throw new Refusal(']], ['remove refuses a link']],
  ['the ancestor walk above the tree is dropped (the real path test refuses the same folder, so the refusal no longer names the junction)', [['  const above = linkAbove(tree)\n\n  if (above) {\n', '  const above = linkAbove(tree)\n\n  if (false) {\n']], ['remove refuses a folder reached through']],
  ['the real path of the tree is not compared with the disk', [['  if (!samePath(real, tree)) {\n', '  if (false) {\n']], ['remove refuses a path the disk gives']],
  ['a file given as the tree is accepted', [['  if (!stat.isDirectory()) {\n    throw new Refusal(', '  if (false) {\n    throw new Refusal(']], ['remove refuses a link']],
  ['an existing folder is accepted by create', [['  if (lstat(tree) !== null) {\n    throw new Refusal(', '  if (false) {\n    throw new Refusal(']], ['create refuses']],
  ['create links the saves to the artifacts of the root', [['const source = path.join(root, name)', "const source = path.join(root, name === 'saves' ? 'artifacts' : name)"]], ['create extracts']],
  ['create skips node_modules', [["const LINKED = ['saves', 'artifacts', 'node_modules']", "const LINKED = ['saves', 'artifacts']"]], ['create extracts']],
  ['create does not copy AuroraDB.db', [['    if (fs.existsSync(database)) {', '    if (false) {']], ['create extracts']],
  ['create extracts nothing', [["'archive', '--format=tar', sha]", "'archive', '--format=tar', sha, '--', 'nothing-here']"]], ['create extracts']],
]

// Runs each of `names` (the cases whose names begin with them) against the helper at `helperPath`: { name, error } for every one that failed.
const failures = async (helperPath, names) => {
  const selected = CASES.filter(([name]) => names.some((start) => name.startsWith(start)))
  const results = []

  for (const [name, run] of selected) {
    try {
      await run(helperPath)
    } catch (error) {
      results.push({ name, error: String(error.message).split('\n').slice(0, 3).join(' | ') })
    }
  }

  return { ran: selected.map(([name]) => name), failed: results }
}

// The helper with the edits of one fault made, in a folder of its own inside the temporary folder.
const plantedCopy = (base, edits) => {
  const text = edits.reduce((source, [from, to]) => patched(HELPER, source, from, to), fs.readFileSync(HELPER, 'utf8'))
  const copy = path.join(base, 'copy', 'scratch-tree.js')

  write(copy, text)

  return copy
}

const main = async () => {
  const wanted = process.argv.filter((argument) => /^mutant:\d+$/.test(argument)).map((argument) => Number(argument.slice('mutant:'.length)))
  let checks = 0
  let failed = 0
  const report = (ok, name, detail = '') => {
    checks++
    failed += ok ? 0 : 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  }

  if (!wanted.length) {
    for (const [name, run] of CASES) {
      try {
        await run(HELPER)
        report(true, name)
      } catch (error) {
        report(false, name, String(error.message).split('\n').slice(0, 3).join(' | '))
      }
    }
  }

  if (mayPlant() || wanted.length) {
    console.log('\nMutations: each must fail the cases it names')

    for (const [index, [name, edits, fails]] of MUTATIONS.entries()) {
      if (wanted.length && !wanted.includes(index)) {
        continue
      }

      refusePlanting(name)

      try {
        const outcome = await withBase(async (base) => failures(plantedCopy(base, edits), fails.length ? fails : ['']))
        const missed = fails.filter((start) => !outcome.failed.some(({ name: caseName }) => caseName.startsWith(start)))
        const unran = fails.filter((start) => !outcome.ran.some((caseName) => caseName.startsWith(start)))
        const summary = outcome.failed.map(({ name: caseName, error }) => `${caseName.slice(0, 40)}: ${error}`).join(' // ').slice(0, 300)

        if (!fails.length) {
          report(!outcome.failed.length, `mutant:${index} passes: ${name}`, summary)
        } else {
          report(!missed.length && !unran.length, `mutant:${index} caught: ${name}`, unran.length ? `no case begins ${unran.join('; ')}` : missed.length ? `these cases still pass: ${missed.join('; ')}` : summary)
        }
      } catch (error) {
        report(false, `mutant:${index} ${fails.length ? 'caught' : 'passes'}: ${name}`, error.message)
      }
    }
  }

  console.log(`\n${checks - failed} of ${checks} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
