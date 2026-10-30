// Answers a save's repeated reads from memory. The app opens a save afresh each time Aurora writes it, so until then the same read gives the same rows, unless the app writes to a table it reads (the Galaxy Map saving positions). Pages read again each time they open, and several read the same things, so a page opened again, or a read another page has already made, skips the database and the queue of reads waiting on it.
//
// Each consumer gets its own copy of the rows: pages sort, extend and observe what they read, and the kept rows must stay as the database gave them. `derive` is the other half: a result worked out from those reads is kept too, and handed back as it is. Kept reads and kept results are one list under one budget, the one used longest ago going first.

// What the kept results of one save may take, as estimated by `estimateBytes`. Past it, the entries used longest ago go.
export const BUDGET_BYTES = 64 * 1024 * 1024
// An entry bigger than this is never kept, so one huge read or result can't push out everything else.
export const ENTRY_BYTES = 16 * 1024 * 1024

const caches = new WeakMap()

const TABLES = /\b(?:FCT|DIM)_\w+/gi
const READ = /^\s*(?:select|with)\b/i
// A statement that changes the save, at its start or after a `with`. Anything else that isn't a read (transaction control, settings) changes no table and passes straight through.
const WRITE = /^\s*(?:insert|update|delete|replace|create|drop|alter)\b|\b(?:insert|replace)\s+into\b|\bupdate\s+\S+\s+set\b|\bdelete\s+from\b/i
// A kept result's key starts with this, which a read's key (a statement) never does.
const DERIVED = '\u0001'
// What an entry takes beyond its rows or result: the entry itself, and the key it is kept under.
const ENTRY_OVERHEAD = 64

const tablesOf = (sql) => [...new Set((sql.match(TABLES) || []).map((table) => table.toLowerCase()))]

// Only a plain read is kept. A read inside a transaction belongs to that transaction, and a Sequelize model read (its options name the model) returns instances, not rows.
const keyOf = (sql, options) => {
  if (typeof sql !== 'string' || !READ.test(sql) || WRITE.test(sql)) {
    return null
  }

  const { replacements, ...rest } = options || {}

  if (Object.keys(rest).length) {
    return null
  }

  return replacements === undefined ? sql : `${sql}\u0000${JSON.stringify(replacements)}`
}

// The heap a value that isn't an object takes, roughly. A reference to an object takes only its slot, counted by the holder.
const primitiveBytes = (value) => {
  switch (typeof value) {
    case 'string':
      return 16 + value.length
    case 'number':
      return 12
    case 'bigint':
    case 'symbol':
      return 16
    case 'function':
      return 32
    default:
      return 0
  }
}

// The heap a value takes, roughly, counting every object it reaches once however many references reach it, and each of its own properties, array items, map entries and set members. A cycle ends where it comes back to an object already counted. Counting stops once the total passes `limit` and returns what it has by then, which is over `limit`; with no limit given it stops at the cap of one entry, the only size the cache must tell. What isn't an object, a string's characters aside, takes a flat figure, and an object reached through several kept entries is counted in each, so the sum over the entries may be more than the heap but not less.
export const estimateBytes = (value, limit = ENTRY_BYTES) => {
  if (value === null || typeof value !== 'object') {
    return primitiveBytes(value)
  }

  const seen = new Set([value])
  const pending = [value]
  let bytes = 0

  // What a reference takes: its slot, and the primitive when it is one; an object not met before is queued and counted when its turn comes.
  const take = (child) => {
    if (child !== null && typeof child === 'object') {
      if (!seen.has(child)) {
        seen.add(child)
        pending.push(child)
      }

      return 8
    }

    return 8 + primitiveBytes(child)
  }

  while (pending.length && bytes <= limit) {
    const object = pending.pop()

    if (Array.isArray(object)) {
      bytes += 16

      for (let index = 0; index < object.length && bytes <= limit; index++) {
        bytes += take(object[index])
      }
    } else if (ArrayBuffer.isView(object)) {
      bytes += 64 + take(object.buffer)
    } else if (object instanceof ArrayBuffer) {
      bytes += 32 + object.byteLength
    } else if (object instanceof Map) {
      bytes += 32

      for (const [key, item] of object) {
        bytes += take(key) + take(item)

        if (bytes > limit) {
          break
        }
      }
    } else if (object instanceof Set) {
      bytes += 32

      for (const item of object) {
        bytes += take(item)

        if (bytes > limit) {
          break
        }
      }
    } else if (object instanceof Date) {
      bytes += 32
    } else {
      bytes += 24

      for (const name in object) {
        if (Object.prototype.hasOwnProperty.call(object, name)) {
          bytes += take(object[name])

          if (bytes > limit) {
            break
          }
        }
      }
    }
  }

  return bytes
}

const isRows = (result) => Array.isArray(result) && Array.isArray(result[0])

const copyOf = (result) => {
  if (!isRows(result)) {
    return result
  }

  const copy = result.slice()

  copy[0] = result[0].map((row) => ({ ...row }))

  return copy
}

// A kept read that a write to one of its tables overtook may have seen either side of the write. A kept result is worked out from reads, so any write overtakes it.
const overtaken = (cache, entry) => (entry.derived ? entry.started < cache.writes : entry.started < cache.cleared || entry.tables.some((table) => (cache.written.get(table) || 0) > entry.started))

// Lets go of `entry` and what it counted, if it is still the one kept under `key`.
const release = (cache, key, entry) => {
  if (cache.entries.get(key) === entry) {
    cache.entries.delete(key)
    cache.bytes -= entry.bytes
  }
}

// An entry just answered is the one used last. The entries used longest ago go first, until the rest fit the budget; one still waiting for its result counts nothing and stays.
const retain = (cache, key, entry) => {
  entry.settled = true
  cache.bytes += entry.bytes
  cache.entries.delete(key)
  cache.entries.set(key, entry)

  for (const [oldestKey, oldest] of cache.entries) {
    if (cache.bytes <= BUDGET_BYTES) {
      break
    }

    if (oldest.settled) {
      release(cache, oldestKey, oldest)
    }
  }
}

// Counts what a settled entry holds and keeps it, unless it is over the cap of one entry, or the cache was closed or the entry retired (replaced, overtaken by a write) while it waited: a result that comes late counts nothing. A kept result holds its `inputs` too, so the result and the inputs are one graph, an object in both counted once.
const settle = (cache, key, entry, held) => {
  if (cache.closed || cache.entries.get(key) !== entry || overtaken(cache, entry)) {
    release(cache, key, entry)

    return false
  }

  const bytes = estimateBytes(entry.derived ? [held, entry.inputs] : held) + key.length * 2 + ENTRY_OVERHEAD

  if (bytes > ENTRY_BYTES) {
    release(cache, key, entry)

    return false
  }

  entry.bytes = bytes
  retain(cache, key, entry)

  return true
}

// Keeps `entry` under `key` in place of what is there: a kept result's `compute()` may call `derive` for its own slot, and the entry that call kept is replaced, and uncounted, here.
const publish = (cache, key, entry) => {
  const current = cache.entries.get(key)

  if (current) {
    release(cache, key, current)
  }

  cache.entries.set(key, entry)
}

// Keeps `database`'s reads from now on, and drops those that read a table it writes to. Returns `database`.
export const cacheQueries = (database) => {
  const query = database.query
  // Entries by key, in the order they were last used: reads by their SQL, results kept by `derive` by their slot. `writes` counts writes; `written` has the count at each table's last write, and `cleared` the count at the last write whose tables aren't known, which counts for every table. The rest counts how often a read or a result was found kept.
  const cache = { entries: new Map(), bytes: 0, writes: 0, written: new Map(), cleared: 0, committing: new WeakMap(), closed: false, readHits: 0, readMisses: 0, deriveHits: 0, deriveMisses: 0 }

  const forget = (tables) => {
    cache.writes += 1

    if (tables.length) {
      tables.forEach((table) => cache.written.set(table, cache.writes))
    } else {
      cache.cleared = cache.writes
    }

    cache.entries.forEach((entry, key) => {
      if (overtaken(cache, entry)) {
        release(cache, key, entry)
      }
    })
  }

  // A write in a transaction counts again when the transaction commits: until then, the other connection still reads what was there before. Without a transaction (or in web mode, where one is a pass-through), the write commits itself.
  const write = (sql, options) => {
    const tables = tablesOf(sql)
    const transaction = options && options.transaction

    if (transaction && typeof transaction.afterCommit === 'function') {
      if (!cache.committing.has(transaction)) {
        const committed = new Set()

        cache.committing.set(transaction, committed)
        transaction.afterCommit(() => forget([...committed]))
      }

      tables.forEach((table) => cache.committing.get(transaction).add(table))
    }

    forget(tables)

    return query(sql, options).finally(() => forget(tables))
  }

  // The caller that starts a read gets the result itself when it isn't kept; everyone else gets a copy.
  const read = (key, sql, options) => {
    const known = cache.entries.get(key)

    if (known) {
      cache.readHits += 1

      if (known.settled) {
        cache.entries.delete(key)
        cache.entries.set(key, known)
      }

      return known.promise.then(copyOf)
    }

    cache.readMisses += 1

    const entry = { derived: false, tables: tablesOf(sql), started: cache.writes, bytes: 0, settled: false, promise: null }

    entry.promise = query(sql, options).then((result) => {
      // The result array and the statement metadata beside the rows are not the cache's to count: the rows are what it keeps.
      if (!isRows(result)) {
        release(cache, key, entry)
      } else {
        settle(cache, key, entry, result[0])
      }

      return result
    }, (error) => {
      release(cache, key, entry)

      throw error
    })

    cache.entries.set(key, entry)

    return entry.promise.then((result) => (entry.settled ? copyOf(result) : result))
  }

  caches.set(database, cache)

  // Not enumerable, like the query guard's: the store's state holds the database, and Vue would observe it.
  Object.defineProperty(database, 'query', {
    configurable: true,
    writable: true,
    value: (sql, options) => {
      const key = cache.closed || (options && options.transaction) ? null : keyOf(sql, options)

      if (key !== null) {
        return read(key, sql, options)
      }

      return typeof sql === 'string' && WRITE.test(sql) ? write(sql, options) : query(sql, options)
    },
  })

  return database
}

const sameInputs = (a, b) => a.length === b.length && a.every((input, index) => Object.is(input, b[index]))

// What `compute()` works out from reads of `database`, kept in `slot` until a write to the save, or until `inputs` (compared one by one, by identity) differ, so a page opened again with the save unchanged gets it back at once instead of working it out again. Everyone who asks gets the very same result, so it must be treated as read-only. `slot` holds one result, the latest asked for, and it counts in the same budget as the reads: a result is estimated as a graph (a promise's once it settles), is not kept when it is over `ENTRY_BYTES`, and a promise that rejects, or settles after the save closed or a write or another call retired its slot, is not kept. A save without a cache works it out every time.
export const derive = (database, slot, inputs, compute) => {
  const cache = database && caches.get(database)

  if (!cache || cache.closed) {
    return compute()
  }

  const key = `${DERIVED}${slot}`
  const known = cache.entries.get(key)

  if (known) {
    if (sameInputs(known.inputs, inputs)) {
      cache.deriveHits += 1

      if (known.settled) {
        cache.entries.delete(key)
        cache.entries.set(key, known)
      }

      return known.result
    }

    release(cache, key, known)
  }

  cache.deriveMisses += 1

  const started = cache.writes
  const result = compute()
  const entry = { derived: true, inputs, started, bytes: 0, settled: false, result }

  if (result && typeof result.then === 'function') {
    publish(cache, key, entry)

    result.then((value) => {
      try {
        settle(cache, key, entry, value)
      } catch (error) {
        release(cache, key, entry)
      }
    }, () => release(cache, key, entry))

    return result
  }

  publish(cache, key, entry)

  try {
    settle(cache, key, entry, result)
  } catch (error) {
    release(cache, key, entry)
  }

  return result
}

// What the kept entries of `database` hold and how often a read or a result was found kept since the save opened, for measuring the budget: null when the save has no cache. `bytes` is the estimate the budget counts; `pending` entries wait for a result and count nothing yet.
export const queryCacheStats = (database) => {
  const cache = database && caches.get(database)

  if (!cache) {
    return null
  }

  const kinds = { reads: { entries: 0, pending: 0, bytes: 0, hits: cache.readHits, misses: cache.readMisses }, derived: { entries: 0, pending: 0, bytes: 0, hits: cache.deriveHits, misses: cache.deriveMisses } }

  cache.entries.forEach((entry) => {
    const kind = entry.derived ? kinds.derived : kinds.reads

    if (entry.settled) {
      kind.entries += 1
      kind.bytes += entry.bytes
    } else {
      kind.pending += 1
    }
  })

  return { budget: BUDGET_BYTES, bytes: cache.bytes, ...kinds }
}

// Lets go of everything kept for `database`, a save the app has replaced, and keeps nothing more for it.
export const dropQueryCache = (database) => {
  const cache = database && caches.get(database)

  if (cache) {
    cache.closed = true
    cache.entries.clear()
    cache.bytes = 0
    caches.delete(database)
  }
}
