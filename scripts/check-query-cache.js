/*
  Checks the query cache's memory accounting (utilities/query-cache.js): kept reads and kept results (`derive`) share one budget, estimated as a graph that counts each object once.

  node scripts/check-query-cache.js [<save.db> ...] [--laps <n>]

  Synthetic checks always run and each failure sets exit code 1: a nested, shared and cyclic result ends the estimate and counts each object once; the estimate stops once past its limit; reads and results evict one another under the one budget, the one used longest ago first; a result that settles after the save closed, after a write or after another call took its slot counts nothing; a rejected promise releases its entry; invalidation drops the reads a write touches and the results; every consumer of a read gets its own rows.

  A save given on the command line is opened read-only (nothing is written) and its largest FCT_ and DIM_ tables of at most 200,000 rows are read through the cache as a route of pages would, each table with a result worked out of the rows (an index by row), for --laps laps (default 3), then the 5 tables read last are visited again in reverse as a page opened again after a few others. The report gives, per lap, the entries the cache keeps, its estimate against the budget and the hit rate of that lap. It is a measure, not a pass or fail except for staying within the budget: the estimate is of what the cache owns, and the real heap is printed only for orientation (run with --expose-gc for it to follow a collection). A route over more than the budget holds reads each table once per lap and finds none of them kept, the least recently used going first; the revisit is what a page opened again finds. The pages' own reads are measured in the running app instead (docs/plans/backlog/evidence/AE-029-01.md).
*/
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')

const TABLES_TO_ROUTE = 14
const MAX_ROUTE_ROWS = 200000
const REVISITED = 5
const MIB = 1024 * 1024

let failures = 0

const check = (condition, message) => {
  if (!condition) {
    failures += 1
    console.error(`FAIL ${message}`)
  } else {
    console.log(`ok   ${message}`)
  }
}

const parseArguments = (argv) => {
  const options = { saves: [], laps: 3 }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--laps') {
      options.laps = Number(argv[++index])
    } else if (argv[index].startsWith('--')) {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    } else {
      options.saves.push(argv[index])
    }
  }

  if (!Number.isInteger(options.laps) || options.laps < 2) {
    console.error('--laps needs a whole number of at least 2')
    process.exit(2)
  }

  return options
}

// A database that answers raw reads from `rows(sql)` and records what reached it. Like Sequelize's, a raw read resolves to [rows, metadata].
const fakeDatabase = (rows, log) => ({
  query: (sql) => {
    log.push(sql)

    return typeof rows === 'function' ? rows(sql) : Promise.resolve([rows.map((row) => ({ ...row })), {}])
  },
})

const deferred = () => {
  const handle = {}

  handle.promise = new Promise((resolve, reject) => {
    handle.resolve = resolve
    handle.reject = reject
  })

  return handle
}

const settleAll = () => new Promise((resolve) => setImmediate(resolve))

// A read of `count` rows each holding a string of `length` characters: about count * length bytes by the estimate.
const bulk = (count, length) => Array.from({ length: count }, (_row, index) => ({ id: index, text: 'x'.repeat(length) }))

const syntheticChecks = async ({ estimateBytes, cacheQueries, derive, dropQueryCache, queryCacheStats, BUDGET_BYTES, ENTRY_BYTES }) => {
  const exact = (value) => estimateBytes(value, Infinity)

  // Estimation: terminates on cycles, counts each object once.
  const shared = { a: 1, b: 'text' }
  const holder = (items) => ({ items })

  check(exact([shared, shared, shared]) - exact([shared]) === 16, 'an object referenced three times is counted once, each further reference taking only its slot')
  check(exact(holder([shared, { inner: shared }])) === exact(holder([shared, { inner: {} }])) - 24, 'an object shared between branches is counted once however it is reached')

  const left = { name: 'left' }
  const right = { name: 'right', left }

  left.right = right
  left.self = left
  right.parent = left

  const cyclic = [left, right, { list: [left, right] }]

  cyclic.push(cyclic)
  check(Number.isFinite(exact(cyclic)) && exact(cyclic) > 0, 'a nested cyclic result ends the estimate')

  const before = exact(cyclic)

  left.again = left
  check(exact(cyclic) - before === 8, 'a reference back to an object already counted adds only its slot')

  const pair = { x: { y: 1 }, z: { y: 1 } }
  const withCycle = { x: { y: 1 }, z: { y: 1 } }

  withCycle.x.back = withCycle
  withCycle.z.back = withCycle
  check(exact(withCycle) - exact(pair) === 16, 'a cycle back to an object already counted adds only its slots')

  const buffer = new ArrayBuffer(1000)

  check(exact([new Uint8Array(buffer), new Uint8Array(buffer)]) - exact([new Uint8Array(buffer)]) === 8 + 64 + 8, 'two views of one buffer count the buffer once, the second taking its slot, its own header and the reference to the buffer')
  check(exact(new Map([['k', shared], ['j', shared]])) === 32 + 2 * (8 + 17 + 8) + exact(shared), 'a map counts its keys and values, an object held twice once')
  check(exact(new Set([shared])) === 32 + 8 + exact(shared), 'a set counts its members')

  const deep = {}
  let tip = deep

  for (let level = 0; level < 200000; level++) {
    tip.next = {}
    tip = tip.next
  }

  check(Number.isFinite(exact(deep)), 'a chain 200,000 objects deep is counted without recursion')

  const huge = bulk(50000, 1000)

  check(estimateBytes(huge) > ENTRY_BYTES && estimateBytes(huge) < 2 * ENTRY_BYTES, 'counting stops once past the entry cap, the estimate being over the cap')
  check(estimateBytes(huge, 1000) > 1000 && estimateBytes(huge, 1000) < 5000, 'counting stops once past a given limit')
  check(estimateBytes(null) === 0 && estimateBytes('ab') === 18 && estimateBytes(5) === 12, 'a value that is not an object takes a flat figure')

  const wideMap = new Map(Array.from({ length: 300000 }, (_value, index) => [index, { id: index }]))
  const wideSet = new Set(Array.from({ length: 300000 }, (_value, index) => ({ id: index })))
  const wideObject = Object.fromEntries(Array.from({ length: 300000 }, (_value, index) => [`key${index}`, { id: index }]))

  check(estimateBytes(wideMap, 1000) > 1000 && estimateBytes(wideMap, 1000) < 2000, 'a wide map stops counting its entries once past the limit')
  check(estimateBytes(wideSet, 1000) > 1000 && estimateBytes(wideSet, 1000) < 2000, 'a wide set stops counting its members once past the limit')
  check(estimateBytes(wideObject, 1000) > 1000 && estimateBytes(wideObject, 1000) < 2000, 'an object with many properties stops counting them once past the limit')

  // Accounting through the cache: reads and results under one budget, the one used longest ago first.
  {
    const log = []
    const database = cacheQueries(fakeDatabase(bulk(10, 1200000), log))
    const read = (name) => database.query(`SELECT ${name} FROM FCT_Ship`)

    await read('a')

    const afterRead = queryCacheStats(database)

    check(afterRead.reads.entries === 1 && afterRead.bytes > 10 * 1200000 && afterRead.bytes < 10 * 1200000 + 4096, `a read counts its rows (${(afterRead.bytes / MIB).toFixed(1)} MiB for 10 rows of 1.2 MB strings)`)

    const result = derive(database, 'slot.sync', [1], () => bulk(10, 1200000))
    const afterDerive = queryCacheStats(database)

    check(afterDerive.derived.entries === 1 && afterDerive.bytes === afterRead.bytes + afterDerive.derived.bytes && afterDerive.derived.bytes > 10 * 1200000, 'a result computed at once is counted with the reads')
    check(derive(database, 'slot.sync', [1], () => { throw new Error('computed again') }) === result, 'the same inputs get the kept result back')
    check(queryCacheStats(database).derived.hits === 1, 'the kept result counts as a hit')

    derive(database, 'slot.sync', [2], () => bulk(1, 1000))
    check(queryCacheStats(database).derived.entries === 1 && queryCacheStats(database).bytes < afterDerive.bytes, 'other inputs replace the slot and release what it counted')

    for (const name of ['b', 'c', 'd', 'e', 'f']) {
      await read(name)
    }

    const full = queryCacheStats(database)

    check(full.bytes <= BUDGET_BYTES && full.reads.entries < 6, `reads past the budget push out the ones used longest ago (${full.reads.entries} of 6 kept, ${(full.bytes / MIB).toFixed(1)} of ${BUDGET_BYTES / MIB} MiB)`)

    const before = log.length

    await read('f')
    check(log.length === before, 'the read used last is still kept')
    await read('a')
    check(log.length === before + 1, 'the read used longest ago was pushed out and reaches the database again')

    derive(database, 'slot.big', [1], () => bulk(12, 1200000))
    check(queryCacheStats(database).derived.entries === 1 && queryCacheStats(database).derived.bytes <= ENTRY_BYTES, 'a result takes its place among the reads')

    for (const name of ['g', 'h', 'i', 'j', 'k', 'l']) {
      await read(name)
    }

    check(queryCacheStats(database).bytes <= BUDGET_BYTES && queryCacheStats(database).derived.entries === 0, 'a result used longest ago is pushed out by newer reads under the same budget')

    const oversized = derive(database, 'slot.oversized', [1], () => bulk(40, 1200000))

    check(oversized.length === 40 && queryCacheStats(database).derived.entries === 0 && !(queryCacheStats(database).bytes > BUDGET_BYTES), 'a result over the entry cap is returned and not kept')

    dropQueryCache(database)
    check(queryCacheStats(database) === null, 'closing the save releases the cache')
  }

  // Non-array and sync graph results.
  {
    const database = cacheQueries(fakeDatabase([], []))
    const graph = { rows: bulk(5, 1000), index: new Map() }

    graph.rows.forEach((row) => graph.index.set(row.id, { row, graph }))
    derive(database, 'graph', [], () => graph)

    const bytes = queryCacheStats(database).derived.bytes

    check(bytes > 5 * 1000 && bytes < 5 * 1000 + 4096, `a cyclic object graph is counted once per object (${bytes} bytes for 5 rows of 1000 characters, the rows reached by the array and by the map)`)
    dropQueryCache(database)
  }

  // A kept result holds its inputs: result and inputs are one graph under the one cap.
  {
    const database = cacheQueries(fakeDatabase([], []))
    const small = derive(database, 'small-output', [new ArrayBuffer(32 * MIB)], () => 1)

    check(small === 1 && queryCacheStats(database).derived.entries === 0 && queryCacheStats(database).bytes === 0, 'a small result is not kept when the inputs the entry holds are over the entry cap')

    derive(database, 'held', [new ArrayBuffer(4 * MIB)], () => 1)

    const held = queryCacheStats(database).derived.bytes

    check(held > 4 * MIB && held < 4 * MIB + 4096, `the inputs of a kept result count in its entry (${held} bytes for a result of 1 and a 4 MiB input)`)

    const sharing = cacheQueries(fakeDatabase([], []))
    const rows = bulk(5, 100000)

    derive(sharing, 'shared', [rows], () => ({ rows }))

    const shared = queryCacheStats(sharing).derived.bytes

    check(shared > estimateBytes(rows, Infinity) && shared < estimateBytes(rows, Infinity) + 4096, `an object held by both the inputs and the result is counted once (${shared} bytes for rows of ${estimateBytes(rows, Infinity)})`)

    const later = cacheQueries(fakeDatabase([], []))
    const waiting = deferred()
    const waited = derive(later, 'later', [new ArrayBuffer(4 * MIB)], () => waiting.promise)

    check(queryCacheStats(later).bytes === 0, 'a result still waiting counts neither its result nor its inputs')
    waiting.resolve(1)
    await waited
    await settleAll()
    check(queryCacheStats(later).bytes > 4 * MIB, 'a settled promise counts the inputs it was asked with')

    const oversize = cacheQueries(fakeDatabase([], []))
    const oversizeWaiting = deferred()
    const oversizeResult = derive(oversize, 'oversize', [new ArrayBuffer(32 * MIB)], () => oversizeWaiting.promise)

    oversizeWaiting.resolve(1)
    await oversizeResult
    await settleAll()
    check(queryCacheStats(oversize).derived.entries === 0 && queryCacheStats(oversize).bytes === 0, 'a settled promise is not kept when its inputs are over the entry cap')
  }

  // A result's compute may call derive for its own slot: the entry that call kept is replaced and released.
  {
    const database = cacheQueries(fakeDatabase([], []))
    const accounted = () => {
      const stats = queryCacheStats(database)

      return stats.bytes === stats.reads.bytes + stats.derived.bytes
    }

    derive(database, 'slot', [1], () => {
      derive(database, 'slot', [1], () => bulk(2, 1000))

      return bulk(2, 1000)
    })

    const alone = cacheQueries(fakeDatabase([], []))

    derive(alone, 'slot', [1], () => bulk(2, 1000))
    check(queryCacheStats(database).derived.entries === 1 && accounted() && queryCacheStats(database).bytes === queryCacheStats(alone).bytes, `a same-slot call inside compute leaves one entry and one entry's bytes (${queryCacheStats(database).bytes} bytes against ${queryCacheStats(alone).bytes} for the slot alone)`)
    await database.query('UPDATE FCT_Ship SET Name = 1')
    check(accounted() && queryCacheStats(database).bytes === 0, 'after a write the bytes are those of the entries kept, none')
  }

  // Async results: late after close, after a write, after replacement; rejections.
  {
    const log = []
    const database = cacheQueries(fakeDatabase((sql) => (/^\s*(?:update|insert)/i.test(sql) ? Promise.resolve([[], {}]) : Promise.resolve([bulk(2, 100), {}])), log))
    const late = deferred()
    const promise = derive(database, 'late', [1], () => late.promise)

    check(queryCacheStats(database).derived.pending === 1 && queryCacheStats(database).bytes === 0, 'a result still waiting counts nothing')
    late.resolve(bulk(3, 100))
    await promise
    await settleAll()
    check(queryCacheStats(database).derived.entries === 1 && queryCacheStats(database).bytes > 300, 'a settled promise is counted by what it resolved to')
    check(derive(database, 'late', [1], () => { throw new Error('computed again') }) === promise, 'a settled promise is kept and handed back')

    const retired = deferred()
    const retiredPromise = derive(database, 'retired', [1], () => retired.promise)

    await database.query('UPDATE FCT_Ship SET Name = 1')
    retired.resolve(bulk(3, 100))
    await retiredPromise
    await settleAll()
    check(queryCacheStats(database).derived.entries === 0 && queryCacheStats(database).bytes === 0, 'a result that settles after a write counts nothing, the write having dropped the kept ones too')

    const replaced = deferred()
    const replacedPromise = derive(database, 'replaced', [1], () => replaced.promise)

    derive(database, 'replaced', [2], () => bulk(1, 10))

    const afterReplace = queryCacheStats(database).bytes

    replaced.resolve(bulk(3, 100))
    await replacedPromise
    await settleAll()
    check(queryCacheStats(database).bytes === afterReplace && queryCacheStats(database).derived.entries === 1, 'a result that settles after another call took its slot counts nothing')

    const rejected = deferred()
    const rejectedPromise = derive(database, 'rejected', [1], () => rejected.promise)

    check(queryCacheStats(database).derived.pending === 1, 'a result still waiting is pending')
    rejected.reject(new Error('failed'))
    await rejectedPromise.catch(() => null)
    await settleAll()
    check(queryCacheStats(database).derived.pending === 0 && queryCacheStats(database).derived.entries === 1, 'a rejected promise releases its entry')

    let computed = 0

    await derive(database, 'rejected', [1], () => {
      computed += 1

      return Promise.resolve(bulk(1, 10))
    })
    check(computed === 1, 'a rejected promise is computed again at the next call')

    const closing = deferred()
    const closingPromise = derive(database, 'closing', [1], () => closing.promise)

    dropQueryCache(database)
    closing.resolve(bulk(3, 100))
    await closingPromise
    await settleAll()
    check(queryCacheStats(database) === null, 'a result that settles after the save closed counts nothing and the cache stays released')

    const rowsLate = deferred()
    const lateDatabase = cacheQueries(fakeDatabase(() => rowsLate.promise, []))
    const lateRead = lateDatabase.query('SELECT * FROM FCT_Ship')

    dropQueryCache(lateDatabase)
    rowsLate.resolve([bulk(3, 100), {}])
    await lateRead
    check(queryCacheStats(lateDatabase) === null, 'a read that answers after the save closed is not kept')

    const failing = cacheQueries(fakeDatabase(() => Promise.reject(new Error('read failed')), []))

    await failing.query('SELECT * FROM FCT_Ship').catch(() => null)
    check(queryCacheStats(failing).reads.entries === 0 && queryCacheStats(failing).reads.pending === 0, 'a read that fails releases its entry')
    dropQueryCache(failing)
  }

  // Invalidation and copies.
  {
    const log = []
    const database = cacheQueries(fakeDatabase(() => Promise.resolve([bulk(3, 100), {}]), log))
    const first = await database.query('SELECT * FROM FCT_Ship')
    const second = await database.query('SELECT * FROM FCT_Ship')

    first[0][0].text = 'changed'
    first[0].push({ id: 99 })
    second[0].sort((a, b) => b.id - a.id)

    const third = await database.query('SELECT * FROM FCT_Ship')

    check(log.length === 1 && third[0].length === 3 && third[0][0].id === 0 && third[0][0].text.length === 100, 'every consumer gets its own rows, and the kept rows stay as read')
    check(first[0] !== second[0] && first[0][1] !== second[0][1], 'copies share no row')

    await database.query('SELECT * FROM FCT_Colony')
    derive(database, 'x', [], () => ({ rows: bulk(2, 10) }))

    const stats = queryCacheStats(database)

    await database.query('UPDATE FCT_Ship SET Name = 2')

    const after = queryCacheStats(database)

    check(stats.reads.entries === 2 && after.reads.entries === 1 && after.derived.entries === 0, 'a write drops the reads of its table and the kept results, and keeps other reads')
    check(after.bytes === after.reads.bytes, 'what remains is what the budget counts')

    const hits = after.reads.hits

    await database.query('SELECT * FROM FCT_Colony')
    check(queryCacheStats(database).reads.hits === hits + 1, 'a read of an untouched table is still a hit')
    dropQueryCache(database)
  }
}

const openReadOnly = (file) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(db)))
})

const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

const heapMiB = () => {
  if (global.gc) {
    global.gc()
  }

  return process.memoryUsage().heapUsed / MIB
}

// The route of pages over a real save: the largest tables of at most MAX_ROUTE_ROWS rows (a bigger one only waits on the database, and is over the entry cap besides), each read through the cache with a result worked out of the rows, lap after lap, then a revisit of the tables read last, in reverse, as a page opened again after a few others.
const routeCheck = async (utilities, file, laps) => {
  const { cacheQueries, derive, dropQueryCache, estimateBytes, queryCacheStats, BUDGET_BYTES, ENTRY_BYTES } = utilities
  const db = await openReadOnly(file)

  try {
    const names = (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'FCT\\_%' ESCAPE '\\' OR name LIKE 'DIM\\_%' ESCAPE '\\')")).map((row) => row.name)
    const counted = []

    for (const name of names) {
      counted.push({ name, rows: (await all(db, `SELECT COUNT(*) AS rows FROM ${name}`))[0].rows })
    }

    const route = counted.filter((table) => table.rows > 0 && table.rows <= MAX_ROUTE_ROWS).sort((a, b) => b.rows - a.rows).slice(0, TABLES_TO_ROUTE)
    const skipped = counted.filter((table) => table.rows > MAX_ROUTE_ROWS).map((table) => `${table.name} ${table.rows}`)
    const database = cacheQueries({ query: (sql) => all(db, sql).then((rows) => [rows, {}]) })

    console.log(`\n${file}: route of ${route.length} tables (${route.map((table) => `${table.name} ${table.rows}`).join(', ')}); not read, over ${MAX_ROUTE_ROWS} rows: ${skipped.length ? skipped.join(', ') : 'none'}`)

    const heapBefore = heapMiB()
    let previous = { hits: 0, misses: 0 }
    const over = []
    let slowest = { name: null, ms: 0 }

    const visit = async (table, lap) => {
      const [rows] = await database.query(`SELECT * FROM ${table.name}`)

      if (lap === 1) {
        const started = process.hrtime.bigint()
        const bytes = estimateBytes(rows)
        const ms = Number(process.hrtime.bigint() - started) / 1e6

        if (bytes > ENTRY_BYTES) {
          over.push(table.name)
        }

        if (ms > slowest.ms) {
          slowest = { name: table.name, ms }
        }
      }

      derive(database, `index.${table.name}`, [rows.length], () => new Map(rows.map((row, index) => [index, row])))
    }

    const report = (label) => {
      const stats = queryCacheStats(database)
      const hits = stats.reads.hits + stats.derived.hits
      const misses = stats.reads.misses + stats.derived.misses
      const lapHits = hits - previous.hits
      const lapAsked = lapHits + misses - previous.misses

      previous = { hits, misses }
      console.log(`${label}: reads kept ${stats.reads.entries} (${(stats.reads.bytes / MIB).toFixed(1)} MiB), results kept ${stats.derived.entries} (${(stats.derived.bytes / MIB).toFixed(1)} MiB), estimate ${(stats.bytes / MIB).toFixed(1)} of ${BUDGET_BYTES / MIB} MiB, hit rate ${(100 * lapHits / lapAsked).toFixed(0)}% (${lapHits} of ${lapAsked})`)
      check(stats.bytes <= BUDGET_BYTES, `${label}: the estimate stays within the budget`)
    }

    for (let lap = 1; lap <= laps; lap++) {
      for (const table of route) {
        await visit(table, lap)
      }

      report(`lap ${lap}`)
    }

    for (const table of route.slice(-REVISITED).reverse()) {
      await visit(table, 0)
    }

    report(`revisit of the last ${REVISITED} tables`)
    console.log(`tables over the entry cap (${ENTRY_BYTES / MIB} MiB), never kept: ${over.length ? over.join(', ') : 'none'}; the slowest estimate (stopping at the cap) took ${slowest.ms.toFixed(0)} ms (${slowest.name})`)
    console.log(`heap now ${heapMiB().toFixed(0)} MiB, ${heapBefore.toFixed(0)} MiB before the route (orientation only${global.gc ? '' : ', no --expose-gc'})`)
    dropQueryCache(database)
  } finally {
    db.close()
  }
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const { 'query-cache': utilities } = await loadUtilities(['query-cache'])

  await syntheticChecks(utilities)

  for (const save of options.saves) {
    await routeCheck(utilities, save, options.laps)
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
