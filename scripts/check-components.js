/*
  Checks the shared component contract (src/renderer/utilities/design-data.js) against saves, read-only.

  node scripts/check-components.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>] [--pair <a.db> <b.db> <GameID> <RaceID>]

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784), the stock 2.7.1 save one folder up (AuroraDB_271_skoormit_saved.db, game 138, race 785) and the pair of 2.6 saves in the repository root that share game 138 and race 779 but are different campaigns (AuroraDB_260_1.db, AuroraDB_260_3.db); a save that is not there is reported as not run.

  It proves, on real rows and on synthetic manual components: the fixed-part and own-component loaders return the rows an independent query gives (the race's research through FCT_RaceTech TechID = SDComponentID, stock rows of game 0 included, fixed parts not researched left out) with every stored figure carried over, and loadStockTanks still returns what the old tank query returned; imported and manual additive components give equal basic totals and keep different provenance; a figure the save lacks stays unknown and cannot satisfy a constraint; components of other races, saves or revisions are not combined silently; and a size converts between HS and MSP only for the family the component declares. Any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const FIXED_TYPES = [2, 3, 31, 47, 48]
const MINERALS = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const FLAG_COLUMNS = { military: 'MilitarySystem', shippingLine: 'ShippingLineSystem', noMaintFailure: 'NoMaintFailure', singleSystemOnly: 'SingleSystemOnly', shipyardRepairOnly: 'ShipyardRepairOnly' }
const OLD_TANKS_SQL = 'select FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.ComponentValue from FCT_ShipDesignComponents inner join FCT_RaceTech on FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID and FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID where FCT_ShipDesignComponents.GameID = 0 and FCT_ShipDesignComponents.ComponentTypeID = 3 order by FCT_ShipDesignComponents.Size desc'

let failures = 0
let checks = 0

// The files that hold the open modded save's campaign: the first is a byte-identical copy, the others earlier points of the same campaign (the same game and race, fewer increments).
const REVISION_FILES = ['AuroraDB_271_massively_modded.db', 'AuroraDB_270_spookyerol_constructs.db', 'AuroraDB_270_spookyerol_advanced_tn.db']

const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const parseArguments = (argv) => {
  const defaults = {
    stock: { file: '../AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
    modded: { file: 'AuroraDB.db', game: 140, race: 784 },
    pair: { files: ['AuroraDB_260_1.db', 'AuroraDB_260_3.db'], game: 138, race: 779 },
  }
  const options = { ...defaults }

  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]

    if (name === '--stock' || name === '--modded') {
      options[name.slice(2)] = { file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) }
    } else if (name === '--pair') {
      options.pair = { files: [argv[++index], argv[++index]], game: Number(argv[++index]), race: Number(argv[++index]) }
    } else {
      fail(`Unknown option ${name}`)
    }
  }

  return options
}

// A read-only stand-in for the app's database object: `query(sql, { replacements })` resolves to [rows], as Sequelize's raw query does. `rewrite(sql, rows)` lets a check alter what a query returns, to stand in for a save with a missing figure.
const openSave = (file, rewrite = null) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)
    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)
      return
    }

    resolve({
      file: path.basename(resolved),
      query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
        const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
        const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

        raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rewrite ? rewrite(sql, rows) : rows])))
      }),
      close: () => raw.close(),
    })
  })
})

const sameValues = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const resultValues = (totals) => Object.fromEntries(Object.entries(totals.results).map(([name, result]) => [name, result.value]))

const resultStatuses = (totals) => Object.fromEntries(Object.entries(totals.results).map(([name, result]) => [name, result.status]))

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const utilities = await loadUtilities(['design-data', 'design-rules', 'provenance'])
  const data = utilities['design-data']
  const { packTanks } = utilities['design-rules']
  const { STATUS, exportFields, isAvailable, passes, ruleSupports } = utilities.provenance

  const checkSave = async (label, { file, game, race }) => {
    const database = await openSave(file)

    if (!database) {
      console.log(`SKIP  ${label}: ${file} is not there`)
      return null
    }

    console.log(`\n== ${label}: ${database.file}, game ${game}, race ${race} ==`)
    const context = { GameID: game, RaceID: race }
    const source = await data.loadComponentSource(database, context)
    const [[gameRow]] = await database.query('select GameTime from FCT_Game where GameID = :GameID', { replacements: { GameID: game } })
    const [ledger] = (await database.query('select count(*) as n, max(IncrementID) as tip from FCT_Increments where GameID = :GameID', { replacements: { GameID: game } }))[0]
    const [tip] = (await database.query('select GameTime from FCT_Increments where IncrementID = :Tip', { replacements: { Tip: ledger.tip } }))[0]
    const shaped = (await database.query("select count(*) as n from pragma_table_info('FCT_Game') where name = 'AllowCMC'"))[0][0].n > 0

    check('source: ids, formula version and revision match independent queries', source.gameId === game && source.raceId === race && (source.formulaVersion === '2.7.x') === shaped && source.revision.gameTime === gameRow.GameTime && source.revision.increments === ledger.n && source.revision.tipIncrementId === ledger.tip && source.revision.tipGameTime === tip.GameTime && /^[0-9a-f]{32,}$/.test(source.revision.ledgerDigest) && /^[0-9a-f]{32,}$/.test(source.componentState), `formula ${source.formulaVersion}, ${source.revision.increments} increments, ${source.fingerprint ? source.fingerprint.length : 0} anchor systems, ledger ${source.revision.ledgerDigest.slice(0, 8)}, components ${source.componentState.slice(0, 8)}`)

    const eligibleSql = (types, scope) => `select SDComponentID from FCT_ShipDesignComponents where ${scope === 'stock' ? 'GameID = 0' : 'GameID in (0, :GameID)'}${types ? ` and ComponentTypeID in (${types.join(', ')})` : ''} and SDComponentID in (select TechID from FCT_RaceTech where GameID = :GameID and RaceID = :RaceID) order by SDComponentID`
    const idsOf = async (sql) => (await database.query(sql, { replacements: { GameID: game, RaceID: race } }))[0].map((row) => row.SDComponentID)

    // fixed parts
    const fixed = await data.loadFixedParts(database, context, { source })
    const fixedExpected = await idsOf(eligibleSql(FIXED_TYPES, 'stock'))
    const baseline = (await database.query(`select count(*) as n from FCT_ShipDesignComponents where GameID = 0 and ComponentTypeID in (${FIXED_TYPES.join(', ')})`))[0][0].n

    check('loadFixedParts returns exactly the stock fixed parts the race has researched', sameValues(fixed.map((c) => c.id).sort((a, b) => a - b), fixedExpected) && fixed.every((c) => c.stock === true && FIXED_TYPES.includes(c.type.id)), `${fixed.length} of ${baseline} baseline fixed parts`)

    const rawRows = (await database.query(`select * from FCT_ShipDesignComponents where SDComponentID in (${fixedExpected.join(', ')})`))[0]
    const byId = new Map(fixed.map((c) => [c.id, c]))
    const mismatches = []

    rawRows.forEach((row) => {
      const c = byId.get(row.SDComponentID)
      const type = data.COMPONENT_TYPES[row.ComponentTypeID]
      const typed = type ? type.quantities.every((q) => c.quantities[q.name] === row[q.column]) : true

      if (!(c.name === row.Name && c.size.family === 'hs' && c.size.value === row.Size && c.cost === row.Cost && c.crew === row.Crew && c.htk === row.HTK && c.powerDemand === row.PowerRequirement && MINERALS.every((m) => c.minerals[m] === row[m]) && Object.entries(FLAG_COLUMNS).every(([flag, column]) => c.flags[flag] === Boolean(row[column])) && typed && c.type.id === row.ComponentTypeID)) {
        mismatches.push(row.SDComponentID)
      }
    })
    check('every stored figure of a fixed part is carried over unchanged (size, cost, crew, HTK, power, minerals, flags, typed value)', mismatches.length === 0, mismatches.length ? `differs: ${mismatches.join(', ')}` : `${rawRows.length} rows`)

    // old stock tank loader
    const oldTanks = (await database.query(OLD_TANKS_SQL, { replacements: context }))[0].map((row) => ({ id: row.SDComponentID, name: row.Name, sizeHS: row.Size, litres: row.ComponentValue, cost: row.Cost, crew: row.Crew, htk: row.HTK }))
    const stockTanks = await data.loadStockTanks(database, context)

    check('loadStockTanks keeps the old tank query result and shape', sameValues([...stockTanks].sort((a, b) => a.id - b.id), [...oldTanks].sort((a, b) => a.id - b.id)) && stockTanks.every((tank, index) => index === 0 || tank.sizeHS <= stockTanks[index - 1].sizeHS) && Object.keys(stockTanks[0]).sort().join() === 'cost,crew,htk,id,litres,name,sizeHS', `${stockTanks.length} tanks, largest ${stockTanks[0].sizeHS} HS`)

    // fuel tanks for the packing benchmark
    const tanks = await data.loadFuelTanks(database, context, { source })
    const stockOnly = await data.loadFuelTanks(database, context, { scope: 'stock', source })
    const tankSets = tanks.map((tank) => `${tank.id}:${tank.sizeHS}/${tank.litres}/${tank.cost}`).sort()

    check('loadFuelTanks gives id, size HS, litres and cost for the whole catalogue, each tied to its component', tanks.length === stockTanks.length && tanks.every((tank) => Number.isFinite(tank.sizeHS) && Number.isFinite(tank.litres) && Number.isFinite(tank.cost) && tank.component.id === tank.id && tank.component.source.origin === 'imported') && sameValues(tankSets, [...oldTanks].map((tank) => `${tank.id}:${tank.sizeHS}/${tank.litres}/${tank.cost}`).sort()) && stockOnly.length === tanks.filter((tank) => tank.stock).length, tanks.map((tank) => `${tank.litres}L`).reverse().join(' '))

    const packed = packTanks({ litres: 1234567, tanks })

    check('the loaded tanks feed packTanks', packed.litres >= 1234567 && packed.picks.length > 0, `${packed.sizeHS} HS, ${packed.cost} BP for 1,234,567 L`)

    // own components
    const own = await data.loadOwnComponents(database, context, { source })
    const ownExpected = await idsOf(eligibleSql(null, 'any'))
    const gameRows = own.filter((c) => c.stock === false).length
    const engines = await data.loadOwnComponents(database, context, { types: [1], source })
    const oldEngines = await data.loadRaceEngines(database, context)

    check('loadOwnComponents returns every component the race has researched, stock rows of game 0 and its own game\'s rows', sameValues(own.map((c) => c.id).sort((a, b) => a - b), ownExpected), `${own.length} components, ${own.length - gameRows} stock, ${gameRows} of the game`)
    check('the engines read through the contract are the engines the old engine loader returns, with the same power', sameValues(engines.map((c) => c.id).sort((a, b) => a - b), oldEngines.map((engine) => engine.id).sort((a, b) => a - b)) && engines.every((c) => c.quantities.enginePower === oldEngines.find((engine) => engine.id === c.id).power), `${engines.length} engines`)
    check('every loaded component is imported, bound to the save, the race and the formula version, and carries its tech reference', own.every((c) => c.source.origin === 'imported' && c.source.gameId === game && c.source.raceId === race && c.source.formulaVersion === source.formulaVersion && c.source.openId === source.openId && c.tech.id === c.id && typeof c.tech.obsolete === 'boolean' && Object.isFrozen(c) && Object.isFrozen(c.source)))

    const expectedStatus = ruleSupports('component.imported', source.formulaVersion) === true ? STATUS.CONFIRMED : STATUS.ESTIMATED

    check('an imported figure is confirmed for a 2.7-shaped save and estimated otherwise', own.every((c) => data.quantityOf(c, 'cost').status === expectedStatus && data.quantityOf(c, 'sizeHS').status === expectedStatus), expectedStatus)

    const narrowed = await data.loadFixedParts(database, context, { types: [2], source })

    check('loadFixedParts accepts a subset of the fixed types and rejects a designed one', narrowed.every((c) => c.type.id === 2) && (await data.loadFixedParts(database, context, { types: [1] }).then(() => false, () => true)), `${narrowed.length} crew quarters`)

    return { database, context, source, fixed, tanks, own }
  }

  const checkUnknown = async (label, { file, game, race }) => {
    const sensors = await openSave(file, (sql, rows) => (sql.includes('from FCT_RaceTech t inner join FCT_ShipDesignComponents c') ? rows.map((row) => ({ ...row, MaxSensorRange: null, PowerRequirement: null, MilitarySystem: null })) : rows))
    const plain = await openSave(file)
    const context = { GameID: game, RaceID: race }
    const find = async (database) => {
      const active = await data.loadOwnComponents(database, context, { types: [24] })

      return active.length ? active[0] : (await data.loadOwnComponents(database, context))[0]
    }
    const known = await find(plain)
    const unknown = await find(sensors)
    const gap = await data.loadOwnComponents(sensors, context, { types: [3] })

    console.log(`\n== ${label}: a missing sensor range, power demand and classification flag (${known.name}) ==`)
    check('read from the save, the sensor range, power demand and flag are known', isAvailable(data.quantityOf(known, 'sensorRange')) && isAvailable(data.quantityOf(known, 'powerDemand')) && isAvailable(data.flagOf(known, 'military')) && data.meetsQuantity(known, 'sensorRange', { min: 0 }) === true && data.meetsFlag(known, 'military', known.flags.military) === true, `range ${data.quantityOf(known, 'sensorRange').value}`)
    check('with those figures missing, each result is unavailable (value null, the input named), never 0', [data.quantityOf(unknown, 'sensorRange'), data.quantityOf(unknown, 'powerDemand'), data.flagOf(unknown, 'military')].every((result) => result.status === STATUS.UNAVAILABLE && result.value === null && result.inputs.missing.length === 1 && result.inputs.missing[0].includes(unknown.name)), data.quantityOf(unknown, 'sensorRange').inputs.missing[0])
    check('a missing figure cannot satisfy its constraint, even one a stored 0 would satisfy', data.meetsQuantity(unknown, 'sensorRange', { min: 0 }) === null && data.meetsQuantity(unknown, 'powerDemand', { max: 1e12 }) === null && data.meetsFlag(unknown, 'military', true) === null && data.meetsFlag(unknown, 'military', false) === null && !passes(data.meetsQuantity(unknown, 'sensorRange', { min: 0 })) && !passes(data.meetsFlag(unknown, 'military', false)))

    const totals = data.componentTotals([{ component: gap[0], count: 2 }])

    check('a total with an unknown term is unavailable and names it, while a total of known terms stands', totals.results.powerDemand.status === STATUS.UNAVAILABLE && totals.results.powerDemand.value === null && totals.results.powerDemand.inputs.missing[0].includes(gap[0].name) && totals.results.sizeHS.value === 2 * gap[0].size.value && totals.results.cost.status !== STATUS.UNAVAILABLE)

    const manual = data.manualComponent({ id: 'manual-bare', name: 'Bare placeholder', sizeHS: 1 })
    const bare = data.componentTotals([{ component: manual, count: 1 }])

    check('a manual component with only a size leaves cost, crew, power and minerals unknown (not 0)', ['cost', 'crew', 'powerDemand', 'minerals'].every((name) => bare.results[name].status === STATUS.UNAVAILABLE && bare.results[name].value === null) && bare.results.sizeHS.value === 1)
    check('a manual component cannot answer a sensor range, a fuel capacity or a hit-to-kill: unsupported, so it cannot satisfy a constraint', ['sensorRange', 'fuelLitres', 'htk', 'enginePower'].every((name) => data.quantityOf(manual, name).status === STATUS.UNAVAILABLE && data.meetsQuantity(manual, name, { min: 0 }) === null) && !manual.capabilities.includes('sensorRange') && data.meetsFlag(manual, 'military') === null)

    plain.close()
    sensors.close()
  }

  const checkEquivalence = async (label, saved) => {
    const { source, tanks, database, context } = saved
    const tank = tanks.find((candidate) => candidate.sizeHS === 1) || tanks[0]
    const imported = tank.component
    const specification = { id: 'manual-twin', name: `${imported.name} (manual)`, typeId: imported.type.id, sizeHS: imported.size.value, cost: imported.cost, crew: imported.crew, powerDemand: imported.powerDemand, minerals: imported.minerals, flags: { military: imported.flags.military } }
    const twin = data.manualComponent(specification)
    const pinnedTwin = data.manualComponent(specification, source)
    const importedTotals = data.componentTotals([{ component: imported, count: 3 }])
    const twinTotals = data.componentTotals([{ component: twin, count: 3 }])
    const mixed = data.componentTotals([{ component: imported, count: 2 }, { component: twin, count: 1 }])
    const pinned = data.componentTotals([{ component: imported, count: 2 }, { component: pinnedTwin, count: 1 }])

    console.log(`\n== ${label}: imported ${imported.name} (${imported.id}) against a manual twin ==`)
    check('equal basic totals for the imported and the manual component', sameValues(resultValues(importedTotals), resultValues(twinTotals)) && Object.values(importedTotals.results).every((result) => isAvailable(result)), `3 x ${imported.size.value} HS = ${importedTotals.results.sizeHS.value} HS, ${importedTotals.results.tons.value} t, ${importedTotals.results.cost.value} BP`)
    check('their provenance differs: origin on the terms, status and assumptions on the totals', importedTotals.components[0].origin === 'imported' && twinTotals.components[0].origin === 'manual' && Object.values(resultStatuses(importedTotals)).every((status) => status === (source.formulaVersion ? STATUS.CONFIRMED : STATUS.ESTIMATED)) && Object.values(resultStatuses(twinTotals)).every((status) => status === STATUS.ASSUMED) && twinTotals.results.cost.assumptions.some((text) => text.includes('entered by the player')) && !importedTotals.results.cost.assumptions.some((text) => text.includes('entered by the player')), `${importedTotals.results.cost.status} against ${twinTotals.results.cost.status}`)
    check('imported and manual figures differ in provenance on one component record too', imported.source.origin === 'imported' && twin.source.origin === 'manual' && twin.source.pinned === false && imported.source.pinned === true && imported.stock === true && twin.stock === null && twin.tech === null && imported.tech.id === imported.id)
    check('a set of both sums the same figures and takes the weakest status (assumed)', mixed.results.sizeHS.value === 3 * imported.size.value && mixed.results.cost.value === importedTotals.results.cost.value && mixed.results.cost.status === STATUS.ASSUMED && mixed.components.map((term) => term.origin).join() === 'imported,manual' && mixed.conflicts.length === 0)
    check('a manual part pinned to the same save and race combines; its provenance still reads manual', pinned.conflicts.length === 0 && pinned.results.sizeHS.value === 3 * imported.size.value && pinned.components[1].origin === 'manual' && pinned.components[1].raceId === imported.source.raceId)

    const other = data.manualComponent(specification, { ...source, raceId: source.raceId + 1000 })
    const refused = data.componentTotals([{ component: imported, count: 1 }, { component: other, count: 1 }])

    check('a manual part pinned to another race is refused', refused.conflicts.length === 1 && refused.conflicts[0].reason === 'other-race' && refused.results.sizeHS.status === STATUS.UNAVAILABLE && refused.results.sizeHS.value === null)

    const hs = data.manualComponent({ id: 'family-hs', sizeHS: 2, cost: 1 })
    const msp = data.manualComponent({ id: 'family-msp', sizeMSP: 40, cost: 1 })
    const undeclared = data.manualComponent({ id: 'family-none', cost: 1 })
    const read = (component, name) => data.quantityOf(component, name)

    console.log(`\n== ${label}: HS and MSP families ==`)
    check('an HS component answers in HS and tons and never in MSP', read(hs, 'sizeHS').value === 2 && read(hs, 'tons').value === 2 * 50 && read(hs, 'sizeMSP').status === STATUS.UNAVAILABLE && read(hs, 'sizeMSP').inputs.missing[0].includes('not converted'))
    check('an MSP component converts at 20 MSP to the hull space, only for its declared family, and says so', read(msp, 'sizeMSP').value === 40 && read(msp, 'sizeHS').value === 40 / data.MSP_PER_HS && read(msp, 'sizeHS').value === 2 && read(msp, 'tons').value === 100 && read(msp, 'sizeHS').assumptions.some((text) => text.includes('MSP')) && read(msp, 'sizeMSP').assumptions.every((text) => !text.includes('counted at')), `${data.MSP_PER_HS} MSP per HS`)
    check('an equal HS and MSP component add up in HS, and the imported HS tank never reads as MSP', data.componentTotals([{ component: hs, count: 1 }, { component: msp, count: 1 }]).results.sizeHS.value === 4 && read(imported, 'sizeMSP').status === STATUS.UNAVAILABLE)
    check('a component with no declared family has no size in any unit, and a size in both families is refused', ['sizeHS', 'sizeMSP', 'tons'].every((name) => read(undeclared, name).status === STATUS.UNAVAILABLE) && (() => { try { data.manualComponent({ id: 'both', sizeHS: 1, sizeMSP: 20 }); return false } catch (error) { return true } })())

    // recomputed component: strength follows the named rule
    const recomputed = data.recomputedComponent({ id: 'engine-hypothetical', name: 'Hypothetical engine', typeId: 1, sizeHS: 4, cost: 10, crew: 4, quantities: { enginePower: 20 } }, { rule: 'design.engineDesign', source })

    check('a recomputed component takes the verification of the design rule it names and carries the typed figure', read(recomputed, 'enginePower').value === 20 && read(recomputed, 'enginePower').status === utilities.provenance.getRule('design.engineDesign').verification && read(recomputed, 'enginePower').assumptions.some((text) => text.includes('design.engineDesign')) && recomputed.source.origin === 'recomputed' && read(recomputed, 'powerDemand').status === STATUS.UNAVAILABLE)
    check('a recomputed component of this race and save combines with the imported ones', data.componentTotals([{ component: imported, count: 1 }, { component: recomputed, count: 1 }]).conflicts.length === 0)

    return { database, context }
  }

  const checkRaces = async (label, saved) => {
    const { database, source, fixed } = saved
    const others = (await database.query('select RaceID from FCT_Race where GameID = :GameID and RaceID != :RaceID order by RaceID', { replacements: { GameID: source.gameId, RaceID: source.raceId } }))[0].map((row) => row.RaceID)
    let neighbour = null

    for (const raceId of others) {
      const parts = await data.loadFixedParts(database, { GameID: source.gameId, RaceID: raceId }, { types: [3] })

      if (parts.length) {
        neighbour = { raceId, tank: parts[0] }
        break
      }
    }

    console.log(`\n== ${label}: another race of the same save ==`)

    const baseline = (await database.query(`select count(*) as n from FCT_ShipDesignComponents where GameID = 0 and ComponentTypeID in (${FIXED_TYPES.join(', ')})`))[0][0].n
    const sizes = []
    let agree = true

    for (const raceId of [source.raceId, ...others]) {
      const parts = await data.loadFixedParts(database, { GameID: source.gameId, RaceID: raceId })
      const expected = (await database.query(`select SDComponentID from FCT_ShipDesignComponents where GameID = 0 and ComponentTypeID in (${FIXED_TYPES.join(', ')}) and SDComponentID in (select TechID from FCT_RaceTech where GameID = :GameID and RaceID = :RaceID) order by SDComponentID`, { replacements: { GameID: source.gameId, RaceID: raceId } }))[0].map((row) => row.SDComponentID)

      agree = agree && sameValues(parts.map((part) => part.id).sort((a, b) => a - b), expected) && parts.every((part) => part.source.raceId === raceId)
      sizes.push(parts.length)
    }

    check('every race of the game gets exactly the fixed parts it has researched (race research scopes the read)', agree, `${Math.min(...sizes)} to ${Math.max(...sizes)} of ${baseline} baseline fixed parts over ${sizes.length} races`)

    if (!neighbour) {
      console.log('SKIP  no other race holds a fuel tank')
      return
    }

    const mine = fixed.find((part) => part.id === neighbour.tank.id)

    if (!mine) {
      console.log(`SKIP  race ${neighbour.raceId}'s tank ${neighbour.tank.id} is not one of this race's`)
      return
    }

    const crossed = data.componentTotals([{ component: mine, count: 1 }, { component: neighbour.tank, count: 1 }])

    check(`the same component id (${mine.id}) of races ${source.raceId} and ${neighbour.raceId} is not combined`, mine.id === neighbour.tank.id && crossed.conflicts.length === 1 && crossed.conflicts[0].reason === 'other-race' && Object.values(crossed.results).every((result) => result.status === STATUS.UNAVAILABLE && result.value === null) && crossed.results.sizeHS.inputs.missing[0].includes('different races'), crossed.results.sizeHS.inputs.missing[0])
    check('the same race and component twice is one set and sums', data.componentTotals([{ component: mine, count: 1 }, { component: mine, count: 1 }]).results.sizeHS.value === 2 * mine.size.value)
  }

  const checkReopen = async (label, { file, game, race }, saved) => {
    const second = await openSave(file)
    const context = { GameID: game, RaceID: race }
    const again = (await data.loadFixedParts(second, context, { types: [3] }))[0]
    const first = saved.fixed.find((part) => part.id === again.id)
    const bumped = await openSave(file, (sql, rows) => (sql.includes('count(*) as Increments') ? rows.map((row) => ({ ...row, Increments: row.Increments + 1 })) : rows))
    const later = (await data.loadFixedParts(bumped, context, { types: [3] }))[0]

    console.log(`\n== ${label}: the same save opened again, and at another point ==`)
    check('another opened copy of the same save and race is shown to be the same save (fingerprint and revision) and combines', first.source.openId !== again.source.openId && data.compareSources(first.source, again.source) === 'same' && data.componentTotals([{ component: first, count: 1 }, { component: again, count: 1 }]).conflicts.length === 0, `${first.source.fingerprint.length} anchor systems`)
    check('the same save at another revision is not combined silently', data.compareSources(first.source, later.source) === 'other-revision' && data.componentTotals([{ component: first, count: 1 }, { component: later, count: 1 }]).conflicts[0].reason === 'other-revision')

    const campaigned = data.manualComponent({ id: 'campaign', sizeHS: 1 }, { ...first.source, campaignId: 'campaign-a', branchId: 'main' })
    const other = data.manualComponent({ id: 'campaign', sizeHS: 1 }, { ...first.source, campaignId: 'campaign-b', branchId: 'main' })

    check('components of different campaigns are not combined even when the save looks alike', data.compareSources(campaigned.source, other.source) === 'other-save')
    second.close()
    bumped.close()
  }

  const COMPONENT_READ = 'from FCT_RaceTech t inner join FCT_ShipDesignComponents c'
  const refused = (promise) => promise.then(() => false, () => true)

  const checkReview = async (label, saved, { file }) => {
    const { database, context, source, own, tanks } = saved
    const original = own.find((component) => component.type.id === 3)

    console.log(`\n== ${label}: missile engine size, revision evidence, source binding, set order, recomputed rules ==`)

    // a missile engine stores its size in MSP
    const missileEngines = own.filter((component) => component.type.id === 56)
    const rows = new Map()

    for (const engine of missileEngines) {
      rows.set(engine.id, (await database.query('select Size, ComponentValue from FCT_ShipDesignComponents where SDComponentID = :id', { replacements: { id: engine.id } }))[0][0])
    }

    const near = (a, b) => Math.abs(a - b) < 1e-9

    check('every missile engine (type 56) declares its size in MSP and converts at 20 MSP to the hull space and 2.5 t to the MSP', missileEngines.length > 0 && missileEngines.every((engine) => engine.size.family === 'msp' && engine.size.value === rows.get(engine.id).Size && data.quantityOf(engine, 'sizeMSP').value === rows.get(engine.id).Size && near(data.quantityOf(engine, 'sizeHS').value, rows.get(engine.id).Size / 20) && near(data.quantityOf(engine, 'tons').value, rows.get(engine.id).Size * 2.5) && data.quantityOf(engine, 'enginePower').value === rows.get(engine.id).ComponentValue), `${missileEngines.length} engines, ${missileEngines.map((engine) => `${engine.id}: ${engine.size.value} MSP = ${data.quantityOf(engine, 'tons').value} t`).join('; ')}`)
    check('the other component types stay in hull spaces', own.filter((component) => component.type.id !== 56).every((component) => component.size.family === 'hs') && tanks.every((tank) => Number.isFinite(tank.sizeHS)))

    if (missileEngines.some((engine) => engine.id === 500725)) {
      const engine = missileEngines.find((candidate) => candidate.id === 500725)
      const total = data.componentTotals([{ component: engine, count: 4 }])

      check('missile engine 500725 (Size 0.1) is 0.1 MSP, 0.005 HS and 0.25 t, not 5 t', engine.size.value === 0.1 && near(data.quantityOf(engine, 'sizeHS').value, 0.005) && near(data.quantityOf(engine, 'tons').value, 0.25) && near(total.results.tons.value, 1) && near(total.results.sizeHS.value, 0.02), `${data.quantityOf(engine, 'tons').value} t each`)
    }

    // the revision is evidence of the ledger and the component rows, not of the count and tip alone
    const ledgerEdited = await openSave(file, (sql, result) => (sql.includes('group_concat(Pair') ? result.map((row) => {
      const pairs = row.Ledger.split(',')
      const middle = Math.floor(pairs.length / 2)
      const [id, time] = pairs[middle].split(':')

      pairs[middle] = `${id}:${Number(time) - 30}`

      return { ...row, Ledger: pairs.join(',') }
    }) : result))
    const middleEdited = (await data.loadOwnComponents(ledgerEdited, context, { types: [3] }))[0]
    const sharedFields = ['gameTime', 'increments', 'tipIncrementId', 'tipGameTime'].every((field) => middleEdited.source.revision[field] === original.source.revision[field])
    const middleTotals = data.componentTotals([{ component: original, count: 1 }, { component: middleEdited, count: 1 }])

    check('a ledger that differs only in the middle (same game time, count, tip and tip time) is another revision, not the same save', sharedFields && middleEdited.source.revision.ledgerDigest !== original.source.revision.ledgerDigest && data.compareSources(original.source, middleEdited.source) === 'other-revision' && middleTotals.conflicts[0].reason === 'other-revision' && middleTotals.results.sizeHS.value === null)

    const firstOther = (sql, result) => (sql.includes(COMPONENT_READ) ? result.map((row, index) => (index === result.findIndex((candidate) => candidate.ComponentTypeID !== 3) ? { ...row, Cost: row.Cost + 1 } : row)) : result)
    const otherEdited = await openSave(file, firstOther)
    const tankEdited = await openSave(file, (sql, result) => (sql.includes(COMPONENT_READ) ? result.map((row) => (row.SDComponentID === original.id ? { ...row, Cost: row.Cost + 1 } : row)) : result))
    const fromOther = (await data.loadOwnComponents(otherEdited, context, { types: [3] })).find((component) => component.id === original.id)
    const fromTank = (await data.loadOwnComponents(tankEdited, context, { types: [3] })).find((component) => component.id === original.id)

    check('one opened save with a component row edited and the game time unmoved is not the same save, whether the edit is to the part combined or to another part', fromOther.cost === original.cost && fromTank.cost === original.cost + 1 && ['gameTime', 'increments', 'tipIncrementId', 'tipGameTime', 'ledgerDigest'].every((field) => fromOther.source.revision[field] === original.source.revision[field]) && fromOther.source.componentState !== original.source.componentState && data.compareSources(original.source, fromOther.source) === 'other-revision' && data.compareSources(original.source, fromTank.source) === 'other-revision' && data.componentTotals([{ component: original, count: 1 }, { component: fromOther, count: 1 }]).results.cost.value === null)

    const blind = (change) => data.manualComponent({ id: 'blind', sizeHS: 1 }, { ...source, openId: -2, ...change })

    check('missing evidence is unknown, never the same save', [blind({ componentState: null }), blind({ revision: { ...source.revision, ledgerDigest: null } }), blind({ revision: null })].every((part) => data.compareSources(source, part.source) === 'unknown-save') && data.compareSources(source, blind({}).source) === 'same')

    // a source belongs to the opened copy it was read from
    const reloaded = await openSave(file)
    const stale = await Promise.all([refused(data.loadOwnComponents(reloaded, context, { source })), refused(data.loadFuelTanks(reloaded, context, { source })), refused(data.loadFixedParts(reloaded, context, { source }))])
    const fresh = await data.loadComponentSource(reloaded, context)

    check('a source read from one opened save is refused for another opened copy, and a new one is accepted', stale.every(Boolean) && (await data.loadFuelTanks(reloaded, context, { source: fresh })).length === tanks.length && (await data.loadFuelTanks(database, context, { source })).length === tanks.length)

    // the verdict on a set does not depend on its order
    const campaigned = (id, campaignId) => data.manualComponent({ id, sizeHS: 1, cost: 1 }, { ...source, campaignId })
    const [unassigned, a, b] = [campaigned('unassigned', null), campaigned('a', 'campaign-a'), campaigned('b', 'campaign-b')]
    const verdicts = [[unassigned, a, b], [unassigned, b, a], [a, unassigned, b], [a, b, unassigned], [b, unassigned, a], [b, a, unassigned]].map((order) => data.componentTotals(order.map((component) => ({ component, count: 1 }))))

    check('a set holding an unassigned part and two campaigns is refused in every order, naming the two campaigns', verdicts.every((totals) => totals.conflicts.length === 1 && [totals.conflicts[0].a.id, totals.conflicts[0].b.id].sort().join() === 'a,b' && totals.conflicts[0].reason === 'other-save' && totals.results.sizeHS.status === STATUS.UNAVAILABLE) && data.componentTotals([unassigned, a].map((component) => ({ component, count: 1 }))).conflicts.length === 0, `${verdicts.length} orders`)

    // a recomputed figure keeps its rule
    const rule = utilities.provenance.getRule('design.selfJumpDrive')
    const drive = data.recomputedComponent({ id: 'drive-hypothetical', name: 'Hypothetical drive', typeId: 16, sizeHS: 10, cost: 5, quantities: { jumpCapacityHS: 200 } }, { rule: 'design.selfJumpDrive', source })
    const figure = data.quantityOf(drive, 'jumpCapacityHS')
    const exported = exportFields(figure)
    const missing = data.quantityOf(drive, 'htk')
    const totalCost = data.componentTotals([{ component: drive, count: 1 }]).results.cost

    check('a recomputed figure is enveloped under the named design rule, with its versions, note and standing assumptions, and they reach an export', rule.assumptions.length >= 2 && figure.rule.id === 'design.selfJumpDrive' && sameValues(figure.rule.versions, rule.versions) && figure.rule.note === rule.note && figure.status === rule.verification && rule.assumptions.every((text) => figure.assumptions.includes(text) && exported.assumptions.includes(text) && totalCost.assumptions.includes(text)) && exported.rule === 'design.selfJumpDrive' && exported.versions === rule.versions.join(', ') && drive.source.origin === 'recomputed' && missing.status === STATUS.UNAVAILABLE && missing.rule.id === 'design.selfJumpDrive', `${rule.assumptions.length} assumptions`)

    reloaded.close()
    ledgerEdited.close()
    otherEdited.close()
    tankEdited.close()
  }

  const checkTemplate = async (label, { file }, game, race) => {
    const first = await openSave(file)
    const second = await openSave(file)
    const context = { GameID: game, RaceID: race }
    const a = (await data.loadFixedParts(first, context, { types: [3] }))[0]
    const b = (await data.loadFixedParts(second, context, { types: [3] }))[0]

    console.log(`\n== ${label}: a template game (too few systems to tell campaigns apart) ==`)

    if (!a) {
      console.log('SKIP  the template race holds no fuel tank')
      return
    }

    check('two opened copies of a game with too few systems are not shown to be one save, so they do not combine', a.source.fingerprint.length < 8 && data.compareSources(a.source, b.source) === 'unknown-save' && data.componentTotals([{ component: a, count: 1 }, { component: b, count: 1 }]).conflicts[0].reason === 'unknown-save', `${a.source.fingerprint.length} anchor systems`)
    check('one opened copy of that game is the same save', data.compareSources(a.source, (await data.loadFixedParts(first, context, { types: [3] }))[0].source) === 'same')
    first.close()
    second.close()
  }

  const checkCrossSave = async (label, a, b) => {
    const mine = a.fixed.find((part) => b.fixed.some((other) => other.id === part.id && other.type.id === part.type.id))
    const theirs = b.fixed.find((part) => mine && part.id === mine.id)

    console.log(`\n== ${label} ==`)

    if (!mine) {
      console.log('SKIP  the saves share no fixed part id')
      return
    }

    const crossed = data.componentTotals([{ component: mine, count: 1 }, { component: theirs, count: 1 }])

    check(`component ${mine.id} (${mine.name}) of ${a.database.file} game ${a.source.gameId} race ${a.source.raceId} and of ${b.database.file} game ${b.source.gameId} race ${b.source.raceId} is not combined`, mine.id === theirs.id && ['other-race', 'other-save'].includes(crossed.conflicts[0].reason) && crossed.results.cost.status === STATUS.UNAVAILABLE, crossed.conflicts[0] ? crossed.results.cost.inputs.missing[0] : '')
  }

  const checkRevisions = async (saved, { game, race }) => {
    const context = { GameID: game, RaceID: race }
    const mine = saved.fixed.find((part) => part.id === 600) || saved.fixed.find((part) => part.type.id === 3)
    const rows = []

    console.log('\n== the same campaign in other files: byte-identical copy and earlier revisions ==')

    for (const file of REVISION_FILES) {
      const database = await openSave(file)

      if (!database) {
        console.log(`SKIP  ${file} is not there`)
        continue
      }

      const part = (await data.loadFixedParts(database, context, { types: [3] })).find((candidate) => candidate.id === mine.id)

      rows.push({ file, part, relation: data.compareSources(mine.source, part.source), shared: data.relateFingerprints(mine.source.fingerprint, part.source.fingerprint), totals: data.componentTotals([{ component: mine, count: 1 }, { component: part, count: 1 }]) })
      database.close()
    }

    rows.forEach(({ file, part, relation, shared, totals }) => {
      const identical = file === REVISION_FILES[0]

      check(`${file}: component ${part.id} is ${identical ? 'combined' : 'refused'} with the open save's (fingerprints ${shared}, sources ${relation}, ${part.source.revision.increments} against ${mine.source.revision.increments} increments)`, identical ? relation === 'same' && totals.conflicts.length === 0 : relation === 'other-revision' && totals.conflicts[0].reason === 'other-revision' && totals.results.sizeHS.value === null)
    })

    const altered = { ...mine.source, fingerprint: mine.source.fingerprint.map((system, index) => (index === 3 ? { ...system, Stars: system.Stars + 1 } : system)), openId: -1 }
    const forged = data.manualComponent({ id: 'forged', sizeHS: 1 }, altered)

    check('a source whose shared systems differ in one row is another save', data.relateFingerprints(mine.source.fingerprint, altered.fingerprint) === 'different' && data.compareSources(mine.source, forged.source) === 'other-save' && data.componentTotals([{ component: mine, count: 1 }, { component: forged, count: 1 }]).conflicts[0].reason === 'other-save')
  }

  const checkPair = async ({ files, game, race }) => {
    const [first, second] = await Promise.all(files.map((file) => openSave(file)))

    console.log('\n== a real pair: same GameID and RaceID, different campaigns ==')

    if (!first || !second) {
      console.log(`SKIP  ${files.join(' and ')} is not there`)
      return
    }

    const context = { GameID: game, RaceID: race }
    const a = (await data.loadFixedParts(first, context, { types: [3] }))[0]
    const b = (await data.loadFixedParts(second, context, { types: [3] }))[0]
    const crossed = data.componentTotals([{ component: a, count: 1 }, { component: b, count: 1 }])

    check(`${first.file} and ${second.file}, both game ${game} race ${race}, give component ${a.id} twice that is not combined`, a.id === b.id && a.source.gameId === b.source.gameId && a.source.raceId === b.source.raceId && ['other-save', 'unknown-save'].includes(data.compareSources(a.source, b.source)) && crossed.results.sizeHS.status === STATUS.UNAVAILABLE && crossed.results.sizeHS.value === null && crossed.conflicts.length === 1, `${data.relateFingerprints(a.source.fingerprint, b.source.fingerprint)} by fingerprint: ${crossed.results.sizeHS.inputs.missing[0]}`)
    check('a save that is not 2.7-shaped reads as estimated, not confirmed', a.source.formulaVersion === null && data.quantityOf(a, 'cost').status === STATUS.ESTIMATED && data.quantityOf(a, 'cost').assumptions.some((text) => text.includes('not verified')))
    first.close()
    second.close()
  }

  const modded = await checkSave('modded save', options.modded)
  const stock = await checkSave('stock save', options.stock)

  for (const [label, saved, spec] of [['modded save', modded, options.modded], ['stock save', stock, options.stock]]) {
    if (saved) {
      await checkUnknown(label, spec)
      await checkEquivalence(label, saved)
      await checkRaces(label, saved)
      await checkReopen(label, spec, saved)
      await checkReview(label, saved, spec)
    }
  }

  if (stock) {
    await checkTemplate('stock save', options.stock, 137, 775)
  }

  if (modded && stock) {
    await checkCrossSave('same component id in two different saves', modded, stock)
  }

  if (modded) {
    await checkRevisions(modded, options.modded)
  }

  await checkPair(options.pair)

  if (modded && stock) {
    console.log('\n== catalogues for the tank package benchmark ==')
    const describe = (saved) => saved.tanks.map((tank) => `${tank.id} ${tank.name}: ${tank.sizeHS} HS, ${tank.litres} L, ${tank.cost} BP${tank.stock ? '' : ' (game row)'}`)

    console.log(`${modded.database.file}\n  ${describe(modded).join('\n  ')}`)
    console.log(`${stock.database.file}\n  ${describe(stock).join('\n  ')}`)
    check('the modded catalogue holds the stock tanks and the modified rows the stock one lacks', modded.tanks.length > stock.tanks.length && stock.tanks.every((tank) => modded.tanks.some((other) => other.id === tank.id && other.litres === tank.litres)), `${modded.tanks.length} against ${stock.tanks.length} tanks`)
  }

  ;[modded, stock].forEach((saved) => saved && saved.database.close())

  console.log(`\n${checks} checks, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
