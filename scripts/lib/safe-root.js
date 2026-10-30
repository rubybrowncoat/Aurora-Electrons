// The directory Vite runs from: the project itself, or, when its path contains '#', a directory junction to it in the temp folder (Vite cuts module ids at the '#' like a URL's fragment, so modules come out empty and its dev client never loads; a checkout under Aurora's own "Aurora C#" folder has one). Shared by scripts/run-vite.js (which also starts Node with --preserve-symlinks so the junction's paths are kept) and scripts/lib/page-server.js.
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

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

// The junction to `projectRoot`, created or repointed as needed.
const junction = (projectRoot) => {
  const hash = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 8)
  const link = path.join(os.tmpdir(), `aurora-electrons-${hash}`)

  if (link.includes('#')) {
    throw new Error(`The project path (${projectRoot}) and the temp folder (${os.tmpdir()}) both contain '#', which Vite cannot handle. Move the project to a path without one.`)
  }

  const target = readLink(link)

  if (target !== null && path.resolve(target) === projectRoot) {
    return link
  }

  if (target !== null) {
    fs.unlinkSync(link)
  }

  // 'junction' needs no admin rights on Windows; other systems ignore the type and make a plain symlink.
  fs.symlinkSync(projectRoot, link, 'junction')

  return link
}

const safeRoot = (projectRoot) => (projectRoot.includes('#') ? junction(projectRoot) : projectRoot)

module.exports = { safeRoot }
