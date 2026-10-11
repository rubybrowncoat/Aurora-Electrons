// Answers a save's repeated reads from memory. The app opens a save afresh each time Aurora writes it, so until then
// the same read gives the same rows, unless the app writes to a table it reads (the Galaxy Map saving positions).
// Pages read again each time they open, and several read the same things, so a page opened again, or a read another
// page has already made, skips the database and the queue of reads waiting on it.
//
// Each consumer gets its own copy of the rows: pages sort, extend and observe what they read, and the kept rows must
// stay as the database gave them.

// What the kept results of one save may take, as estimated by `estimateBytes`. Past it, the reads used longest ago go.
export const BUDGET_BYTES = 64 * 1024 * 1024
// A read bigger than this is never kept, so one huge read can't push out everything else.
export const ENTRY_BYTES = 16 * 1024 * 1024

const caches = new WeakMap()

const TABLES = /\b(?:FCT|DIM)_\w+/gi
const READ = /^\s*(?:select|with)\b/i
// A statement that changes the save, at its start or after a `with`. Anything else that isn't a read (transaction
// control, settings) changes no table and passes straight through.
const WRITE = /^\s*(?:insert|update|delete|replace|create|drop|alter)\b|\b(?:insert|replace)\s+into\b|\bupdate\s+\S+\s+set\b|\bdelete\s+from\b/i

const tablesOf = (sql) => [...new Set((sql.match(TABLES) || []).map((table) => table.toLowerCase()))]

// Only a plain read is kept. A read inside a transaction belongs to that transaction, and a Sequelize model read (its
// options name the model) returns instances, not rows.
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

// The heap a value takes, roughly.
const valueBytes = (value) => {
  if (typeof value === 'string') {
    return 16 + value.length
  }

  if (typeof value === 'number') {
    return 12
  }

  if (value && typeof value === 'object') {
    return 64 + (value.byteLength || 0)
  }

  return 0
}

// The heap rows take, roughly, from up to 32 of them spread over the result.
export const estimateBytes = (rows) => {
  if (!rows.length) {
    return 64
  }

  const step = Math.max(1, Math.floor(rows.length / 32))
  let sampled = 0
  let bytes = 0

  for (let index = 0; index < rows.length; index += step) {
    bytes += 24

    Object.values(rows[index]).forEach((value) => {
      bytes += 8 + valueBytes(value)
    })

    sampled += 1
  }

  return 64 + Math.ceil((bytes / sampled) * rows.length) + rows.length * 8
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

// Keeps `database`'s reads from now on, and drops those that read a table it writes to. Returns `database`.
export const cacheQueries = (database) => {
  const query = database.query
  // Reads by key, in the order they were last used. `writes` counts writes; `written` has the count at each table's
  // last write, and `cleared` the count at the last write whose tables aren't known, which counts for every table.
  const cache = { entries: new Map(), bytes: 0, writes: 0, written: new Map(), cleared: 0, committing: new WeakMap(), closed: false }

  const remove = (key, entry) => {
    if (cache.entries.get(key) === entry) {
      cache.entries.delete(key)
      cache.bytes -= entry.bytes
    }
  }

  // A read that a write to one of its tables overtook isn't kept: it may have seen either side of the write.
  const overtaken = (entry) => entry.started < cache.cleared || entry.tables.some((table) => (cache.written.get(table) || 0) > entry.started)

  const forget = (tables) => {
    cache.writes += 1

    if (tables.length) {
      tables.forEach((table) => cache.written.set(table, cache.writes))
    } else {
      cache.cleared = cache.writes
    }

    cache.entries.forEach((entry, key) => {
      if (overtaken(entry)) {
        remove(key, entry)
      }
    })
  }

  // A read just answered is the one used last. The ones used longest ago go first, until the rest fit the budget.
  const keep = (key, entry) => {
    entry.settled = true
    cache.bytes += entry.bytes
    cache.entries.delete(key)
    cache.entries.set(key, entry)

    for (const [oldestKey, oldest] of cache.entries) {
      if (cache.bytes <= BUDGET_BYTES) {
        break
      }

      if (oldest.settled) {
        remove(oldestKey, oldest)
      }
    }
  }

  // A write in a transaction counts again when the transaction commits: until then, the other connection still reads
  // what was there before. Without a transaction (or in web mode, where one is a pass-through), the write commits itself.
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
      if (known.settled) {
        cache.entries.delete(key)
        cache.entries.set(key, known)
      }

      return known.promise.then(copyOf)
    }

    const entry = { tables: tablesOf(sql), started: cache.writes, bytes: 0, settled: false, promise: null }

    entry.promise = query(sql, options).then((result) => {
      if (cache.closed || cache.entries.get(key) !== entry || overtaken(entry) || !isRows(result)) {
        remove(key, entry)

        return result
      }

      const bytes = estimateBytes(result[0]) + key.length * 2

      if (bytes > ENTRY_BYTES) {
        remove(key, entry)
      } else {
        entry.bytes = bytes
        keep(key, entry)
      }

      return result
    }, (error) => {
      remove(key, entry)

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
