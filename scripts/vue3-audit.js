#!/usr/bin/env node
// Counts the Vue 2 and Vuetify 2 constructs a Vue 3 + Vuetify 4 cutover has to change, so the cutover can be tracked rather than estimated. The count must go down before the cutover and must reach zero for the constructs Vuetify 4 removed.
//
// node scripts/vue3-audit.js [--json] [--top <n>]
//
// Each row is one construct, how many sites the tree holds and which files hold most of them. A construct is counted by its text in the source: a site the count misses is a site the cutover will find by hand, so the list is deliberately literal. Nothing here decides whether a construct is correct; it is the inventory the cutover works from (owner, 2026-11-01, stack-feasibility report section 5).

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(ROOT, 'src', 'renderer')
const EXTENSIONS = new Set(['.vue', '.js', '.ts'])

// The constructs, in the order the cutover meets them: Vue's own API first, then Vuetify's components and props, then the state layer.
const CONSTRUCTS = [
  { key: 'sync', label: 'the .sync modifier', pattern: /\.sync\b/g, must: true, note: 'v-model:prop' },
  { key: 'native', label: 'the .native modifier', pattern: /\.native\b/g, must: true, note: 'removed in Vue 3: props and emits' },
  { key: 'set', label: '$set', pattern: /\$set\(/g, must: false, note: 'not needed with proxies' },
  { key: 'destroy', label: 'beforeDestroy or destroyed', pattern: /beforeDestroy\b|\bdestroyed\s*\(/g, must: true, note: 'beforeUnmount and unmounted' },
  { key: 'vuevue', label: '__vue__', pattern: /__vue__/g, must: true, note: 'no instance handle on the element' },
  { key: 'asyncComputed', label: 'asyncComputed blocks', pattern: /asyncComputed/g, must: false, note: 'vue-async-computed 4 declares vue 3' },
  { key: 'dataTable', label: '<v-data-table>', pattern: /<v-data-table/g, must: true, note: 'headers and slots change' },
  { key: 'simpleTable', label: '<v-simple-table>', pattern: /<v-simple-table/g, must: true, note: 'v-table in Vuetify 4' },
  { key: 'headers', label: 'header objects written { text: … value:', pattern: /\{\s*text:\s*['"][^}]{0,160}?\bvalue:\s*['"]/g, must: true, note: '{ title, key }' },
  { key: 'itemText', label: 'the item-text prop', pattern: /item-text/g, must: true, note: 'item-title' },
  { key: 'activator', label: 'activator slots', pattern: /#activator|v-slot:activator/g, must: true, note: '{ props } instead of { on }' },
  { key: 'mapGetters', label: 'mapGetters', pattern: /mapGetters/g, must: true, note: 'Pinia: mapState and mapActions' },
  { key: 'vuex', label: 'Vuex usage', pattern: /from ['"]vuex['"]/g, must: true, note: 'Pinia, or Vuex 4 first' },
]

const filesUnder = (folder) => {
  const found = []

  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name)

    if (entry.isDirectory()) {
      found.push(...filesUnder(full))
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full)
    }
  }

  return found
}

const countIn = (text, pattern) => {
  const matches = text.match(pattern)

  return matches ? matches.length : 0
}

const main = () => {
  const asJson = process.argv.includes('--json')
  const topAt = process.argv.indexOf('--top')
  const top = topAt > 0 ? Number(process.argv[topAt + 1]) : 5
  const files = filesUnder(SOURCE)
  const texts = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))
  const rows = CONSTRUCTS.map((construct) => {
    const perFile = [...texts.entries()].map(([file, text]) => ({ file: path.relative(ROOT, file).split(path.sep).join('/'), count: countIn(text, construct.pattern) })).filter((one) => one.count > 0).sort((left, right) => right.count - left.count)

    return { ...construct, pattern: undefined, total: perFile.reduce((sum, one) => sum + one.count, 0), files: perFile.length, worst: perFile.slice(0, top) }
  })
  const total = rows.reduce((sum, row) => sum + row.total, 0)

  if (asJson) {
    console.log(JSON.stringify({ files: files.length, total, rows }, null, 2))

    return
  }

  console.log(`Vue 2 and Vuetify 2 constructs in ${files.length} files under src/renderer: ${total} sites\n`)
  console.log(`${'construct'.padEnd(34)} ${'sites'.padStart(6)} ${'files'.padStart(6)}  ${'must reach zero'.padStart(14)}  note`)

  for (const row of rows.sort((left, right) => right.total - left.total)) {
    console.log(`${row.label.padEnd(34)} ${String(row.total).padStart(6)} ${String(row.files).padStart(6)}  ${String(row.must ? 'yes' : 'no').padStart(14)}  ${row.note}`)
  }

  console.log('\nThe files that hold most of each:')

  for (const row of rows.filter((one) => one.total > 0).sort((left, right) => right.total - left.total)) {
    console.log(`\n  ${row.label} (${row.total})`)

    for (const worst of row.worst) {
      console.log(`    ${String(worst.count).padStart(4)}  ${worst.file}`)
    }
  }

  console.log('\nThe cutover is done when every construct marked "must reach zero" reads 0, and the others are rerun once more to confirm they were removed and not hidden.')
}

main()
