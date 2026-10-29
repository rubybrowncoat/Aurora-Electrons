/*
  Checks the name a file of the app's exports is given from the empire's name (src/renderer/utilities/file-slug.js), and the preferences export that names its file with it (utilities/preferences.js `exportName`; the command structure's exports are checked by check-hierarchy-export.js): an accented letter is its plain letter, so "Ærø Étoile Empire" is saved as `aero-etoile-empire` and not `r-toile-empire`, every other character a hyphen, a name with nothing of the Latin alphabet left gives the file the caller's fallback, and a long name is cut to 60 characters at a word, so that a browser does not cancel the download of a file whose name is too long.

  bun scripts/check-file-slug.js [--no-mutations] [mutant:<N> ...]

  The texts are written out here by hand. Each planted fault rewrites one line of a copy of the helper or of the preferences module and must make a check fail; `mutant:<N>` runs only the fault of that number. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')

const utilities = path.resolve(__dirname, '..', 'src', 'renderer', 'utilities')
const FILES = { 'file-slug': path.join(utilities, 'file-slug.js'), preferences: path.join(utilities, 'preferences.js') }
const DAY = new Date('2026-10-29T12:00:00Z')

const CHECKS = [
  ['an accented letter is its plain letter, and a letter that no decomposition reduces is spelled out', ({ slug }) => {
    assert.equal(slug.fileSlug('Ærø Étoile Empire'), 'aero-etoile-empire')
    assert.equal(slug.fileSlug('Straße Łódź Þing Œuvre'), 'strasse-lodz-thing-oeuvre')
    assert.equal(slug.fileSlug('ÜNÏCÕDÉ ĐÀO'), 'unicode-dao')
  }],
  ['every other run of characters is one hyphen, none at either end, and a name with no Latin letter or digit gives nothing', ({ slug }) => {
    assert.equal(slug.fileSlug('  A:/B\\C<>|?*  Empire 2  '), 'a-b-c-empire-2')
    assert.equal(slug.fileSlug('***'), '')
    assert.equal(slug.fileSlug('帝国'), '')
    assert.equal(slug.fileSlug(null), '')
  }],
  ['the preferences export is named for the empire in plain letters, and for the app when nothing of the name is left', ({ preferences }) => {
    assert.equal(preferences.exportName({ raceName: 'Ærø Étoile Empire' }, DAY), 'aurora-electrons-preferences-aero-etoile-empire-2026-10-29.json')
    assert.equal(preferences.exportName({ raceName: '帝国' }, DAY), 'aurora-electrons-preferences-app-2026-10-29.json')
    assert.equal(preferences.exportName({}, DAY), 'aurora-electrons-preferences-app-2026-10-29.json')
  }],
  ['a long name is cut to 60 characters at the last hyphen that fits (a single word at 60), counted after the letters are spelled out, and the preferences file keeps its date and extension', ({ slug, preferences }) => {
    assert.equal(slug.fileSlug('Æ'.repeat(200)), 'ae'.repeat(30))
    assert.equal(slug.fileSlug(`Ærø ${'Æ'.repeat(40)}`), 'aero')
    assert.equal(slug.fileSlug('The Most Serene and Everlasting Imperial Commonwealth of the'), 'the-most-serene-and-everlasting-imperial-commonwealth-of-the')
    assert.equal(slug.fileSlug('The Most Serene and Everlasting Imperial Commonwealth of the Seven Radiant Suns'), 'the-most-serene-and-everlasting-imperial-commonwealth-of-the')
    assert.equal(slug.fileSlug('The Most Serene and Everlasting Imperial Commonwealth of Radiance'), 'the-most-serene-and-everlasting-imperial-commonwealth-of')
    assert.equal(slug.fileSlug('A'.repeat(240)), 'a'.repeat(60))
    assert.equal(preferences.exportName({ raceName: 'Empire '.repeat(40) }, DAY), 'aurora-electrons-preferences-empire-empire-empire-empire-empire-empire-empire-empire-2026-10-29.json')
  }],
]

// The planted faults: the file, the text to find (exactly once) and what replaces it. Each must make a check fail.
const MUTATIONS = [
  ['an accented letter is dropped', 'file-slug', '.normalize(\'NFKD\').replace(/[\\u0300-\\u036F]/g, \'\')', ''],
  ['a letter no decomposition reduces is dropped', 'file-slug', '.replace(/[æøœßđðłþı]/g, (letter) => LETTERS[letter])', ''],
  ['a letter no decomposition reduces is spelled as the first of the list', 'file-slug', '(letter) => LETTERS[letter]', '() => \'ae\''],
  ['a hyphen is left at either end', 'file-slug', '.replace(/^-+|-+$/g, \'\')', ''],
  ['the preferences file keeps its own slug, which drops accented letters', 'preferences', 'const slug = fileSlug(source.raceName) || \'app\'', 'const slug = String(source.raceName || \'app\').toLowerCase().replace(/[^a-z0-9]+/g, \'-\').replace(/^-+|-+$/g, \'\') || \'app\''],
  ['the preferences file has no fallback', 'preferences', 'fileSlug(source.raceName) || \'app\'', 'fileSlug(source.raceName)'],
  ['a long name is not cut', 'file-slug', 'if (slug.length <= SLUG_LIMIT) {', 'if (true) {'],
  ['a long name is cut in the middle of a word', 'file-slug', 'slug.slice(0, end > 0 ? end : SLUG_LIMIT)', 'slug.slice(0, SLUG_LIMIT)'],
  ['a long name loses the whole word that ends at the limit', 'file-slug', 'slug.lastIndexOf(\'-\', SLUG_LIMIT)', 'slug.lastIndexOf(\'-\', SLUG_LIMIT - 1)'],
]

const modulesOf = async (sources = {}) => {
  const loaded = await loadUtilities(['file-slug', 'preferences'], { sources })

  return { slug: loaded['file-slug'], preferences: loaded.preferences }
}

const failures = (mods) => CHECKS.filter(([, test]) => {
  try {
    test(mods)

    return false
  } catch (error) {
    return true
  }
}).map(([name]) => name)

const main = async () => {
  const texts = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]))
  const wanted = process.argv.filter((argument) => /^mutant:\d+$/.test(argument)).map((argument) => Number(argument.slice('mutant:'.length)))
  const mutating = !process.argv.includes('--no-mutations')
  let checks = 0
  let failed = 0
  const report = (ok, name, detail = '') => {
    checks++
    failed += ok ? 0 : 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  }

  if (!wanted.length) {
    const mods = await modulesOf()

    for (const [name, test] of CHECKS) {
      try {
        test(mods)
        report(true, name)
      } catch (error) {
        report(false, name, error.message.split('\n').slice(0, 3).join(' | '))
      }
    }
  }

  if (mutating || wanted.length) {
    console.log('\nMutations: each must fail at least one check')

    for (const [index, [name, file, from, to]] of MUTATIONS.entries()) {
      if (wanted.length && !wanted.includes(index)) {
        continue
      }

      try {
        const broken = failures(await modulesOf({ [file]: patched(FILES[file], texts[file], from, to) }))

        report(broken.length > 0, `mutant:${index} caught: ${name}`, broken.length ? `${broken.length} checks fail` : 'every check still passes')
      } catch (error) {
        report(false, `mutant:${index} caught: ${name}`, error.message)
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
