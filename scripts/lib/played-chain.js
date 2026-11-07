// The played campaign as a read-only source for a check of the recorder: A, B and the two branches from B (C1 and C2) of scripts/lib/fixtures.js, read through the database object the recorder takes (`transaction` and `query`), so that the real recorder (src/renderer/utilities/history.js) settles each save into an installation held in memory and nothing is ever written to a save. B is the common ancestor of C1 and C2: their ledgers part at the first increment after B (432,000 s in C1, 86,400 s in C2), so recording A, B, C1 and then C2 is a fork of the campaign at B, and opening C2 after C1 (or C1 after C2) is what a player's rollback to B and a play on from there looks like. The recorder cuts that fork not at B or at the save that made it but at the last whole 64 increments the two ledgers share, before B (`partingOf`), so a check takes the cut from the registry the recorder leaves or from `partingOf`, never from the game time of a save. Needs bun (`bun:sqlite`).
const path = require('path')
const { Database } = require('bun:sqlite')
const { PLAYED, PLAYED_NEXT, PLAYED_C1, PLAYED_C2 } = require('./fixtures')

const root = path.resolve(__dirname, '..', '..')

// The four calibrated orbit-pair saves of the registry, by the letters the pair witness and docs/WORKFLOW.md name them with; the registry also holds D1 and its sibling, outside this chain.
const CHAIN = Object.freeze({ A: PLAYED, B: PLAYED_NEXT, C1: PLAYED_C1, C2: PLAYED_C2 })

const GAME = PLAYED.gameId
const RACE = PLAYED.raceId

const fileOf = (letter) => path.join(root, CHAIN[letter].file)

const handles = new Map()

const handleOf = (file) => {
  if (!handles.has(file)) {
    handles.set(file, new Database(file, { readonly: true, strict: true }))
  }

  return handles.get(file)
}

const held = new Map()

// A save is read only, so the rows a statement gives are the same each time it is run: the rows are kept by file, statement and parameters, and each caller gets rows of its own (a planted copy of a utility replays the chain and reads what the real one read).
const rowsOf = (file, sql, params = {}) => {
  const key = `${file}\n${sql}\n${JSON.stringify(params)}`

  if (!held.has(key)) {
    const statement = handleOf(file).query(sql)

    held.set(key, Object.keys(params).length ? statement.all(params) : statement.all())
  }

  return held.get(key).map((row) => ({ ...row }))
}

// The increments between two checkpoints of a campaign's ledger: the recorder cuts a fork down to a whole number of them.
const STEP = 64

// A save's ledger of the game, each increment as the recorder identifies it (its ID, its game time and, for the event archive and the pins, its length).
const ledgerOf = (letter) => rowsOf(fileOf(letter), `select IncrementID, GameTime, Length from FCT_Increments where GameID = ${GAME} order by IncrementID`)

// Where the ledgers of two saves part, worked here as the recorder tells ledgers apart (an increment is its ID and its game time, never its length) and cuts a fork (down to a whole 64 increments, at the game time of the last one kept): { common, n, t }.
const partingOf = (left, right) => {
  let common = 0

  while (common < Math.min(left.length, right.length) && left[common].IncrementID === right[common].IncrementID && left[common].GameTime === right[common].GameTime) {
    common++
  }

  const n = Math.floor(common / STEP) * STEP

  return { common, n, t: left[n - 1].GameTime }
}

// The database the recorder reads, as scripts/check-history-retention.js gives it: one transaction that is the connection, each statement logged on request and made to fail when `fails` says so.
const databaseOf = (letter, { log = null, fails = null } = {}) => ({
  transaction: (work) => work({ id: 'transaction' }),
  query: async (sql, { replacements = {} } = {}) => {
    if (log) {
      log.push(sql)
    }

    if (fails && fails(sql)) {
      throw new Error('disk I/O error')
    }

    return [rowsOf(fileOf(letter), sql, replacements)]
  },
})

// One pass of the recorder over a save of the chain, into the installation `inst` (its `io`, `now` and `newId`), the way the app records the save it has open.
const recordSave = (history, inst, letter, { log = null, fails = null, ...options } = {}) => history.recordHistory(databaseOf(letter, { log, fails }), { storage: inst.io, path: `C:/saves/${path.basename(CHAIN[letter].file)}`, now: inst.now, newId: inst.newId, ...options })

// An installation held in memory, as the recorder reads and writes it: its stores (registry, migration, settings and the files of the campaigns) each a JSON value read and written whole, `files` holding the values by store name, with the clock and the IDs the recorder is given.
const installation = () => {
  const files = new Map()
  let counter = 0
  let clock = 1000000
  const store = (name) => ({
    get store () {
      return files.has(name) ? JSON.parse(JSON.stringify(files.get(name))) : {}
    },
    set store (value) {
      files.set(name, JSON.parse(JSON.stringify(value)))
    },
    update (change) {
      this.store = change(this.store)

      return this.store
    },
  })

  return { files, newId: () => `c${++counter}`, now: () => ++clock, io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), file: (name) => store(`file:${name}`) } }
}

module.exports = { CHAIN, GAME, RACE, STEP, fileOf, rowsOf, ledgerOf, partingOf, databaseOf, recordSave, installation }
