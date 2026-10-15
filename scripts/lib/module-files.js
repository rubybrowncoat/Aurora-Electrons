/*
  Where the check scripts keep the modules they load from rewritten sources (scripts/lib/utilities.js, scripts/lib/page-loader.js).

  A module whose imports are rewritten to the locations of the modules it needs cannot be imported from a data URL without cost: each URL carries the whole source of its module, which holds the URLs of its imports, so a module's URL is as long as its whole graph and base64 grows it by a third at each level. The graph of the warning checks makes URLs of 22 MB, and parsing, decoding and compiling them was most of the time a check spent loading. A source whose URL would pass a size limit is written once, as a file named by the hash of its text, in a folder that belongs to the process and goes when it ends, and is imported from the URL of that file: the URL is short whatever the graph, and two sources that are the same text are the same file, so the same module, as two equal data URLs were. Shallow graphs keep data URLs, which cost less than creating the files.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')

// The appearance checks make URLs of up to about 0.5 MB, which load faster as data URLs than as the ~100 files each process would create; only the deeply nested graphs (the warning checks: megabytes) go to files. Measured under Bun, the deep graph loads in about 0.9 s with the limit between 0.5 MB and 1 MB and in 4-5 s at 2 MB.
const DATA_URL_LIMIT = 1000000
// A module that imports a file cannot itself be a data URL (Bun cannot resolve a file from one), so it is a file too.
const FILE_SCHEME = 'file:///'

let folder = null
const written = new Map()

const folderOfProcess = () => {
  if (folder === null) {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-modules-'))

    process.on('exit', () => {
      try {
        fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
      } catch (error) {
        process.stderr.write(`the folder of the loaded modules ${folder} was left: ${error.message}\n`)
      }
    })

    // An interrupt or a termination ends the process through `exit`, so the folder goes then too; a kill that cannot be caught leaves it in the temporary folder.
    ;['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => process.exit(1)))
  }

  return folder
}

// The URL of an ES module made of `source`: a data URL while it stays short, else a file written the first time its text is seen.
const urlOfSource = (source) => {
  if (!source.includes(FILE_SCHEME)) {
    const data = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    if (data.length <= DATA_URL_LIMIT) {
      return data
    }
  }

  const key = crypto.createHash('sha1').update(source).digest('hex')

  if (!written.has(key)) {
    const file = path.join(folderOfProcess(), `${key}.mjs`)

    fs.writeFileSync(file, source)
    written.set(key, pathToFileURL(file).href)
  }

  return written.get(key)
}

module.exports = { urlOfSource }
