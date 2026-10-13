/*
  Checks the civilian shipping-line payout explanation (src/renderer/utilities/civilian-tariff.js) and its use by the Finances and Transport pages.

  node scripts/check-civilian-tariffs.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>]

  The synthetic checks need no save. They prove: the worked 2.7 estimates of every category (colonist, passenger, trade good, cargo point) equal the quantity times the published rate times the distance in billion km, with the expected figures written out by hand; a route in km is converted to billion km before it is priced; the rates are the 2.7 ones and not the 2.6 ones; a player's race is paid the published rate and a computer-run empire half of it (the published modifier of 0.5), and a race kind that is not known gives no figure; an unsupported or unknown game version, a category with no published rate, and a quantity or distance that is not a number of 0 or more give an unavailable result that names what is missing, never 0; an extra per-system tariff field changes nothing; the civilian uses of the wealth log are the expected ones, each on its side; no net cost is given while any civilian use is not placed against a payout, whatever amounts are logged, and a fully placed table gives the logged payout uses less the taxes; the figures read as text; both pages feed the save's formula version and the selected race's kind to the rules, run on a player's race and a computer-run empire (the worked estimate and the Transport note are evaluated from the pages' own source), the Finances estimate names its one-way loaded route basis, and the new panel carries a summary; and the new text speaks in no first or second person. Then each of the mutations below, one fault planted in a copy of the sources, must make at least one check fail, so that the checks cannot pass by checking nothing.

  With a save (by default the repository's modded save, AuroraDB.db game 140 race 784, and the stock 2.7.1 save one folder up, game 138 race 785; one that is not there is reported as not run) it also reads the wealth use table and the race's wealth log: every civilian use is in the save's table with the table's name and side, every use of the save whose name mentions shipping, passenger, civilian or tariff is a civilian use or an acknowledged exclusion, the civilian rows of the ledger the Finances page builds equal the amounts summed straight from the log, and the net cost is unavailable. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pagesDirectory = path.join(root, 'src', 'renderer', 'pages')
const MODULES = ['civilian-tariff', 'provenance', 'finances']
const FILE = 'civilian-tariff.js'

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const close = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected))

// The rates as the published notes state them, written out apart from the module, and the 2.6 rates they replaced (a third less).
const PUBLISHED = { colonist: 0.00015, passenger: 0.006, tradeGood: 0.375, cargoPoint: 0.00015 }
const SIX = { colonist: 0.0001, passenger: 0.004, tradeGood: 0.25, cargoPoint: 0.0001 }

// What the wealth log holds on civilian shipping, by DIM_WealthUse id: name and side.
const EXPECTED_USES = {
  29: ['Purchase of Civilian Ships', 'spending'],
  32: ['Tax on Shipping Trade Goods', 'income'],
  34: ['Tax on Shipping Colonists', 'income'],
  42: ['Shipping Line Subsidy', 'spending'],
  43: ['Tax on Passenger Liners', 'income'],
  44: ['Civilian Contracts', 'spending'],
  46: ['Purchase of Civilian Fuel', 'spending'],
  47: ['Tax on Civilian Fuel', 'income'],
}

// Uses whose names touch civilian shipping and are acknowledged as no shipping-line payout: civilian mining and its mineral purchases, and the tariff income use, which is not read as a source of any payout rate.
const EXCLUDED_USES = [10, 35, 36]

const UNSUPPORTED = [null, undefined, '', ' ', '2.6.0', '2.6.x', '2.8.0', '2.70.0', '3.0.0', '1.9.0', 'x']

const missingText = (result) => result.inputs.missing.join(' | ')

// The checks that need no save, over the modules `m` ({ tariff, provenance, finances }): [[name, () => true or a message]]. Run on the real modules and again on each mutated copy, where one at least must fail.
const synthetic = ({ tariff, provenance, finances }) => {
  const all = []
  const add = (name, run) => all.push([name, run])
  const { CATEGORIES, CIVILIAN_USES, billionKm, rateOf, payoutEstimate, payoutRows, describeTariffVersion, treasuryMapping, civilianCategories, netCostResult, amountText } = tariff
  const { valueOrNull, isAvailable, getRule, ruleSupports } = provenance
  const noValue = (result) => !isAvailable(result) && result.value === null
  const estimate = (extra) => payoutEstimate({ version: '2.7.x', category: 'tradeGood', quantity: 10, billionKm: 20, npr: false, ...extra })

  add('colonist: 2000 colonists over 12 billion km at 0.00015 pay 3.6', () => close(valueOrNull(estimate({ category: 'colonist', quantity: 2000, billionKm: 12 })), 3.6) || `${valueOrNull(estimate({ category: 'colonist', quantity: 2000, billionKm: 12 }))}`)
  add('passenger: 500 passengers over 5 billion km at 0.006 pay 15', () => close(valueOrNull(estimate({ category: 'passenger', quantity: 500, billionKm: 5 })), 15))
  add('trade good: 10 trade goods over 20 billion km at 0.375 pay 75', () => close(valueOrNull(estimate()), 75))
  add('cargo point: 25000 cargo points over 4 billion km at 0.00015 pay 15', () => close(valueOrNull(estimate({ category: 'cargoPoint', quantity: 25000, billionKm: 4 })), 15))
  add('one trade good over half a billion km pays 0.1875', () => close(valueOrNull(estimate({ quantity: 1, billionKm: 0.5 })), 0.1875))
  add('the rates are the published 2.7 ones for every category', () => Object.entries(PUBLISHED).every(([id, rate]) => valueOrNull(rateOf('2.7.x', id)) === rate) || JSON.stringify(Object.keys(PUBLISHED).map((id) => valueOrNull(rateOf('2.7.x', id)))))
  add('the rates are not the 2.6 ones: each is 50% above', () => Object.entries(SIX).every(([id, rate]) => close(valueOrNull(rateOf('2.7.x', id)) / rate, 1.5)))
  add('a payout is the quantity times the rate times the distance, over 500 pseudo-random cases', () => {
    let seed = 7

    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296

      return seed / 4294967296
    }

    for (let index = 0; index < 500; index++) {
      const id = Object.keys(PUBLISHED)[Math.floor(next() * 4)]
      const quantity = Math.floor(next() * 100000)
      const distance = next() * 80

      if (!close(valueOrNull(estimate({ category: id, quantity, billionKm: distance })), quantity * PUBLISHED[id] * distance)) {
        return `${id} ${quantity} ${distance}`
      }
    }

    return true
  })
  add('2.7.0, 2.7.1 and 2.7.x all give the rate', () => ['2.7.0', '2.7.1', '2.7.x', '2.7'].every((version) => valueOrNull(rateOf(version, 'tradeGood')) === 0.375 && close(valueOrNull(estimate({ version })), 75)))
  add('a route of 12.5e9 km is 12.5 billion km, 1e9 km is 1, 0 km is 0', () => billionKm(12.5e9) === 12.5 && billionKm(1e9) === 1 && billionKm(0) === 0)
  add('a distance that is not a number has no billion km', () => billionKm(null) === null && billionKm(undefined) === null && billionKm(NaN) === null && billionKm(Infinity) === null)
  add('one unit over a measured route of 12.5e9 km pays the rate times 12.5 in every priced category', () => {
    const rows = payoutRows({ version: '2.7.x', km: 12.5e9, npr: false })

    return Object.entries(PUBLISHED).every(([id, rate]) => close(valueOrNull(rows.find((row) => row.category.id === id).payout), rate * 12.5)) || 'a row is wrong'
  })
  add('the rows list every category once, the unpriced ones as unavailable', () => {
    const rows = payoutRows({ version: '2.7.x', km: 12.5e9, npr: false })

    return rows.length === CATEGORIES.length && new Set(rows.map((row) => row.category.id)).size === rows.length && noValue(rows.find((row) => row.category.id === 'fuel').payout) && rows.filter((row) => isAvailable(row.payout)).length === 4
  })
  add('a result is estimated, never confirmed, names its rule, its units and its assumptions', () => {
    const result = estimate()

    return result.status === 'estimated' && result.rule.id === 'civilianTariff.payout' && result.units === 'wealth' && result.assumptions.length > 0 && result.inputs.present.length > 0 && rateOf('2.7.x', 'colonist').status === 'estimated'
  })
  add('a zero quantity or distance is a known 0 payout, not unavailable', () => valueOrNull(estimate({ quantity: 0 })) === 0 && isAvailable(estimate({ quantity: 0 })) && valueOrNull(estimate({ billionKm: 0 })) === 0 && isAvailable(estimate({ billionKm: 0 })))

  add('a player\'s race is paid the published rate and a computer-run empire half of it, in every priced category', () => Object.entries(PUBLISHED).every(([id, rate]) => close(valueOrNull(estimate({ category: id, quantity: 8000, billionKm: 3, npr: false })), 8000 * rate * 3) && close(valueOrNull(estimate({ category: id, quantity: 8000, billionKm: 3, npr: true })), 8000 * rate * 3 * 0.5)))
  add('computer-run worked figures: 2000 colonists over 12 billion km pay 1.8, 500 passengers over 5 billion km 7.5, 10 trade goods over 20 billion km 37.5, 25000 cargo points over 4 billion km 7.5', () => close(valueOrNull(estimate({ category: 'colonist', quantity: 2000, billionKm: 12, npr: true })), 1.8) && close(valueOrNull(estimate({ category: 'passenger', quantity: 500, billionKm: 5, npr: true })), 7.5) && close(valueOrNull(estimate({ npr: true })), 37.5) && close(valueOrNull(estimate({ category: 'cargoPoint', quantity: 25000, billionKm: 4, npr: true })), 7.5))
  add('the published rates are the same for either kind of race: only the payout is halved', () => ['colonist', 'passenger', 'tradeGood', 'cargoPoint'].every((id) => valueOrNull(rateOf('2.7.x', id)) === PUBLISHED[id]))
  add('a race kind that is not true or false gives no figure and names the kind as missing', () => [undefined, null, 'true', 'false', 1, 0, ''].every((npr) => noValue(estimate({ npr })) && /player's or computer-run/.test(missingText(estimate({ npr })))) && noValue(estimate({ quantity: 0, npr: undefined })))
  add('a computer-run empire still has no figure for an unsupported version, for fuel or for a distance that is missing', () => noValue(estimate({ version: '2.6.0', npr: true })) && noValue(estimate({ version: null, npr: true })) && noValue(estimate({ category: 'fuel', npr: true })) && noValue(estimate({ billionKm: null, npr: true })))
  add('the rows for a computer-run empire are half those of a player, and without a race kind they are unavailable', () => {
    const player = payoutRows({ version: '2.7.x', km: 12.5e9, npr: false })
    const computer = payoutRows({ version: '2.7.x', km: 12.5e9, npr: true })
    const unknown = payoutRows({ version: '2.7.x', km: 12.5e9 })

    return Object.keys(PUBLISHED).every((id) => close(valueOrNull(computer.find((row) => row.category.id === id).payout) * 2, valueOrNull(player.find((row) => row.category.id === id).payout)) && !isAvailable(unknown.find((row) => row.category.id === id).payout)) || 'a row is wrong'
  })
  add('a computer-run result names the modifier it applied and a player\'s result does not; the payout rule states it', () => estimate({ npr: true }).inputs.present.some((text) => /0\.5/.test(text)) && !estimate({ npr: false }).inputs.present.some((text) => /0\.5/.test(text)) && /0\.5/.test(getRule('civilianTariff.payout').note))

  add('the rules are registered with the 2.7 versions', () => ['civilianTariff.rates', 'civilianTariff.payout', 'civilianTariff.netCost'].every((id) => getRule(id) && getRule(id).versions.length === 1 && getRule(id).versions[0] === '2.7.x'))
  add('the rules hold for 2.7 releases and for no other version', () => ['2.7.0', '2.7.1', '2.7.x'].every((version) => ruleSupports('civilianTariff.rates', version) === true) && UNSUPPORTED.filter((version) => version !== ' ' && version !== '').every((version) => ruleSupports('civilianTariff.rates', version) !== true))

  UNSUPPORTED.forEach((version) => {
    add(`unsupported game version ${JSON.stringify(version)}: no rate, no estimate, no row figure, each naming the version as missing`, () => {
      const results = [rateOf(version, 'tradeGood'), estimate({ version }), ...payoutRows({ version, km: 12.5e9, npr: false }).flatMap((row) => [row.rate, row.payout])]

      return results.every((result) => noValue(result) && result.status === 'unavailable' && /game version/.test(missingText(result))) || results.map((result) => `${result.value}`).join(',')
    })
  })
  add('an unsupported version has no figure even for a zero quantity', () => noValue(estimate({ version: '2.6.0', quantity: 0 })) && noValue(estimate({ version: null, quantity: 1, billionKm: 0 })))
  add('the version text says rates are published for 2.7 and none for another version', () => /2\.7/.test(describeTariffVersion('2.7.x')) && /2\.7/.test(describeTariffVersion('2.7.1')) && !/2\.7/.test(describeTariffVersion(null)) && /No payout rates/.test(describeTariffVersion(null)) && /No payout rates/.test(describeTariffVersion('2.6.0')))

  add('fuel has no published rate: unavailable and naming fuel, never 0', () => {
    const rate = rateOf('2.7.x', 'fuel')
    const result = estimate({ category: 'fuel', quantity: 1000, billionKm: 5 })

    return noValue(rate) && noValue(result) && /fuel/.test(missingText(rate)) && /fuel/.test(missingText(result)) && result.value !== 0
  })
  add('an unknown category has no rate and no estimate', () => [undefined, null, '', 'bogus', 'perSystem'].every((category) => noValue(rateOf('2.7.x', category)) && noValue(estimate({ category }))))
  add('a quantity that is not a number of 0 or more is unavailable and named', () => [null, undefined, NaN, -1, Infinity, '5'].every((quantity) => noValue(estimate({ quantity })) && /quantity/.test(missingText(estimate({ quantity })))))
  add('a distance that is not a number of 0 or more is unavailable and named', () => [null, undefined, NaN, -0.5, Infinity, '5'].every((distance) => noValue(estimate({ billionKm: distance })) && /distance/.test(missingText(estimate({ billionKm: distance })))))
  add('both missing: both are named', () => /quantity/.test(missingText(estimate({ quantity: null, billionKm: null }))) && /distance/.test(missingText(estimate({ quantity: null, billionKm: null }))))
  add('a per-system tariff field changes nothing: the figure is the published rate whatever else is passed', () => {
    const extras = { systemTariff: 9, tariff: 9, perSystem: 9, system: 3, SystemID: 3, rate: 9, tariffRate: 9 }
    const plain = valueOrNull(estimate())

    return valueOrNull(estimate(extras)) === plain && valueOrNull(rateOf('2.7.x', 'tradeGood', extras)) === 0.375 && valueOrNull(payoutRows({ version: '2.7.x', km: 12.5e9, npr: false, ...extras }).find((row) => row.category.id === 'tradeGood').payout) === 0.375 * 12.5
  })
  add('the table lists the four published categories with a rate and fuel without one; ids are unique', () => {
    const priced = CATEGORIES.filter((category) => category.rate !== null)

    return CATEGORIES.length === 5 && new Set(CATEGORIES.map((category) => category.id)).size === 5 && priced.map((category) => category.id).sort().join() === Object.keys(PUBLISHED).sort().join() && priced.every((category) => Number.isFinite(category.rate) && category.rate > 0) && CATEGORIES.find((category) => category.id === 'fuel').rate === null
  })

  add('the civilian uses are the expected ids, names and sides', () => {
    const got = Object.fromEntries(CIVILIAN_USES.map((use) => [use.id, [use.label, use.side]]))

    return (JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(EXPECTED_USES).sort()) && Object.entries(EXPECTED_USES).every(([id, [label, side]]) => got[id] && got[id][0] === label && got[id][1] === side)) || JSON.stringify(got)
  })
  add('the shipped table places no use against a payout, and is read-only', () => CIVILIAN_USES.every((use) => use.role === null && Object.isFrozen(use)) && Object.isFrozen(CIVILIAN_USES))

  const placed = (roles) => CIVILIAN_USES.map((use) => ({ ...use, role: roles[use.id] === undefined ? null : roles[use.id] }))
  const FULL = { 29: 'other', 32: 'tax', 34: 'tax', 42: 'payout', 43: 'tax', 44: 'payout', 46: 'other', 47: 'tax' }
  const TOTALS = { 29: 9999, 32: 100, 34: 50, 42: 250, 43: 25, 44: 1000, 46: 777, 47: 5 }

  add('the shipped mapping is incomplete, with every use unplaced', () => {
    const mapping = treasuryMapping()

    return mapping.complete === false && mapping.unplaced.length === CIVILIAN_USES.length
  })
  add('incomplete mapping: no net cost whatever the logged amounts, naming the missing link', () => {
    const result = netCostResult({ version: '2.7.x', mapping: treasuryMapping(), totals: TOTALS })

    return noValue(result) && result.value !== 0 && /link between shipping-line payouts and the logged treasury uses/.test(missingText(result)) && /8 of 8/.test(missingText(result))
  })
  add('a mapping missing one use is incomplete: no net cost', () => {
    const mapping = treasuryMapping(placed({ ...FULL, 46: undefined }))

    return mapping.complete === false && mapping.unplaced.length === 1 && noValue(netCostResult({ version: '2.7.x', mapping, totals: TOTALS }))
  })
  add('a mapping with no use that carries the payout is incomplete: no net cost', () => {
    const mapping = treasuryMapping(placed({ ...FULL, 42: 'other', 44: 'other' }))

    return mapping.complete === false && noValue(netCostResult({ version: '2.7.x', mapping, totals: TOTALS }))
  })
  add('an empty table and an unknown role are incomplete', () => !treasuryMapping([]).complete && !treasuryMapping(placed({ ...FULL, 44: 'maybe' })).complete)
  add('a fully placed mapping gives the logged payout uses less the taxes: 1250 - 180 = 1070, estimated', () => {
    const mapping = treasuryMapping(placed(FULL))
    const result = netCostResult({ version: '2.7.x', mapping, totals: TOTALS })

    return (mapping.complete && close(valueOrNull(result), 1070) && result.status === 'estimated' && result.rule.id === 'civilianTariff.netCost') || `${valueOrNull(result)}`
  })
  add('a fully placed mapping counts a use with nothing logged as 0', () => close(valueOrNull(netCostResult({ version: '2.7.x', mapping: treasuryMapping(placed(FULL)), totals: { 44: 1000 } })), 1000))
  add('a fully placed mapping still gives no net cost for an unsupported version', () => ['2.6.0', null, '3.0.0'].every((version) => noValue(netCostResult({ version, mapping: treasuryMapping(placed(FULL)), totals: TOTALS }))))

  add('the ledger the Finances page builds lists the civilian uses of its categories, in the table order, and leaves the others out', () => {
    const gameTime = 100 * 86400
    const wealth = [[44, 'Civilian Contracts', 0, 40], [32, 'Tax on Shipping Trade Goods', 1, 10], [5, 'Shipbuilding', 0, 5], [11, 'Worker Taxes', 1, 2], [29, 'Purchase of Civilian Ships', 0, 7]].flatMap(([UseID, Description, Income, DisplayOrder]) => [{ UseID, Description, Income, DisplayOrder, TimeUsed: gameTime - 86400, Amount: 100 + UseID }, { UseID, Description, Income, DisplayOrder, TimeUsed: gameTime, Amount: 50 }])
    const ledger = finances.buildLedger({ treasury: { WealthPoints: 1000, AnnualWealth: 1, GameTime: gameTime, StartYear: 2000 }, wealth, windowDays: 30 })
    const rows = civilianCategories(ledger.categories)

    return (rows.map((row) => row.id).join() === '29,32,44' && rows.find((row) => row.id === 44).total === 144 + 50 - 0 && !rows.some((row) => row.id === 5 || row.id === 11)) || rows.map((row) => `${row.id}:${row.total}`).join()
  })
  add('the ledger totals feed the net cost the page asks for, and it stays unavailable', () => {
    const gameTime = 100 * 86400
    const wealth = [{ UseID: 44, Description: 'Civilian Contracts', Income: 0, DisplayOrder: 35.9, TimeUsed: gameTime, Amount: 500 }, { UseID: 32, Description: 'Tax on Shipping Trade Goods', Income: 1, DisplayOrder: 32, TimeUsed: gameTime, Amount: 20 }]
    const ledger = finances.buildLedger({ treasury: { WealthPoints: 1000, AnnualWealth: 1, GameTime: gameTime, StartYear: 2000 }, wealth, windowDays: 30 })
    const totals = Object.fromEntries(ledger.categories.map((category) => [category.id, category.total]))

    return totals[44] === 500 && totals[32] === 20 && noValue(netCostResult({ version: '2.7.x', mapping: treasuryMapping(), totals }))
  })

  add('figures read as text: 0.00015, 0.375, 3.6, 15 and 0 stay exact, four significant digits below a thousand, a thousand and more take the separator, an unknown one is a dash', () => (amountText(0.00015) === '0.00015' && amountText(0.375) === '0.375' && amountText(3.6) === '3.6' && amountText(15) === '15' && amountText(4.6875) === '4.688' && amountText(0) === '0' && amountText(0.000001875) === '0.000001875' && amountText(12345.6, '\'') === '12\'346' && amountText(1234.5, ',') === '1,235' && amountText(null) === '—' && amountText(NaN) === '—') || [0.00015, 4.6875, 0.000001875, 12345.6].map((value) => amountText(value)).join(' '))

  return all
}

const readSource = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const between = (text, from, to) => {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)

  if (start < 0 || end < 0) {
    throw new Error(`The page text has no section from ${from} to ${to}`)
  }

  return text.slice(start, end)
}

const FIRST_OR_SECOND_PERSON = /\b(?:I|me|my|mine|you|your|yours|we|our|ours)\b/i

// A number typed in a field, as the Finances page reads one.
const typed = (text) => (text === '' || text === null || text === undefined || !Number.isFinite(Number(text)) ? null : Number(text))

// The methods of an object-literal body (the page's own source, as it is written between two markers) compiled with the names it uses from its imports.
const compileMethods = (source, names, values) => vm.compileFunction(`return ({${source}})`, names)(...values)

const attempt = (test) => {
  try {
    return test()
  } catch (error) {
    return `threw ${error.message}`
  }
}

// The pages' wiring, on the text of the pages: [[name, held]]. Each statement must hold of the real pages and fail of a page with one gate cut out.
const wiring = ({ finances, information, utility, tariff, provenance }) => {
  const panel = between(finances, '<v-card class="panel" data-summary="What a civilian shipping line', '</v-card>')
  const noteSource = between(information, 'payoutNote() {', 'problems() {')
  const estimateSource = between(finances, '    estimate() {', '    // The ledger\'s civilian uses')
  const all = []
  const add = (name, held) => all.push([name, typeof held === 'function' ? attempt(held) : held])

  add('Finances: the panel has a data-summary and a head titled for civilian shipping-line payouts', /^<v-card class="panel" data-summary="[^"]{40,}" elevation="1">\s*<div class="panel-head">\s*<span>Civilian shipping-line payouts/.test(panel))
  add('Finances: the rates, the worked estimate and the net cost take the save\'s formula version', /rateOf\(this\.formulaVersion, category\.id\)/.test(finances) && /payoutEstimate\(\{ version: this\.formulaVersion,/.test(finances) && /netCostResult\(\{ version: this\.formulaVersion,/.test(finances))
  add('Finances: the formula version is read from the save\'s schema', /formulaVersion: \{\s*get: tracked\('formulaVersion', async function \(\) \{[\s\S]{0,200}?return await loadFormulaVersion\(this\.database\)/.test(finances) && /formulaVersion: 'the save\\'s schema'/.test(finances))
  add('Finances: the net cost is asked of the mapping the module ships, not of a mapping the page builds', /const TARIFF_MAPPING = treasuryMapping\(\)/.test(finances) && /mapping: TARIFF_MAPPING/.test(finances))
  add('Finances: the net cost line shows a dash and the limitation while it is unavailable', /netCost\.value === null \? '—' : signed\(netCost\.value\)/.test(panel) && /netCost\.value === null \? limitationText\(netCost\)/.test(panel))
  add('Finances: an unavailable estimate shows its limitation, not a figure', /estimate\.value === null \? limitationText\(estimate\)/.test(panel) && /amountText\(estimate\.value\)/.test(panel))
  add('Finances: the race\'s logged spending is shown apart from the civilian uses', /Logged spending of the race, every use/.test(panel) && /civilian spending uses above/.test(panel))
  add('Finances: the panel names the one-way loaded distance in billion km and the rate by category', /One-way loaded distance, billion km/.test(panel) && /One-way loaded distance in billion km/.test(panel) && /per billion km/.test(panel) && /Rate by category, per unit carried and per billion km travelled/.test(panel))
  add('Finances: no game version is written into the page\'s tariff calls', !/version: '2\.|rateOf\('2\./.test(finances))
  add('Transport: the payout note prices the measured route in billion km with the save\'s formula version and the race\'s kind', /payoutRows\(\{ version, km: shortest, npr \}\)/.test(noteSource) && /payoutRows\(\{ version, km: longest, npr \}\)/.test(noteSource) && /payoutRows\(\{ version, km: null, npr \}\)/.test(noteSource) && /const npr = this\.RaceNPR/.test(noteSource) && /formulaVersion: version/.test(noteSource))
  add('both pages read the selected race\'s kind from the store, and the worked estimate passes it on', /\.\.\.mapState\(\['RaceNPR'\]\)/.test(finances) && /\.\.\.mapState\(\['RaceNPR'\]\)/.test(information) && /npr: this\.RaceNPR/.test(estimateSource))
  add('Transport: the note says no payout is estimated for a version without rates and for no route', /game version has no published payout rates/.test(noteSource) && /no shipping line ship has a route to the destination/.test(noteSource))
  add('Transport: the note is a panel foot carrying a provenance mark of its result', /<div v-if="payoutNote" class="panel-foot caption text--secondary">[^\n]*<provenance-mark :result="payoutNote\.result" label \/>[^\n]*\{\{ payoutNote\.text \}\}/.test(information))
  add('Transport: the note says the payout goes to the shipping line and claims no cost to the race', /goes to the shipping line/.test(noteSource) && /no cost to the race is claimed/.test(noteSource))
  add('Transport: no game version is written into the note\'s tariff calls', !/version: '2\./.test(noteSource))
  add('the new text speaks in no first or second person', !FIRST_OR_SECOND_PERSON.test(utility) && !FIRST_OR_SECOND_PERSON.test(panel) && !FIRST_OR_SECOND_PERSON.test(noteSource) && !FIRST_OR_SECOND_PERSON.test(estimateSource))

  const estimateOf = (RaceNPR, fields) => {
    const methods = compileMethods(estimateSource, ['payoutEstimate', 'typed'], [tariff.payoutEstimate, typed])
    const context = { formulaVersion: '2.7.x', tariffCategory: 'tradeGood', tariffQuantity: '10', tariffDistance: '20', RaceNPR, ...fields }

    return { result: methods.estimate.call(context), basis: methods.estimateBasis.call(context) }
  }

  const noteOf = (RaceNPR, fields) => {
    const methods = compileMethods(noteSource, ['payoutRows', 'isAvailable', 'describeTariffVersion'], [tariff.payoutRows, provenance.isAvailable, tariff.describeTariffVersion])
    const context = { destination: { key: 'place' }, CivilianShippingLinesActive: true, formulaVersion: '2.7.x', civilianRuns: [{ status: 'ok', km: 1.3e9 }], RaceNPR, amountText: (value) => tariff.amountText(value), distance: (km) => `${km / 1e9} bn km`, ...fields }

    return methods.payoutNote.call(context)
  }

  const noFigure = (result) => !provenance.isAvailable(result)

  add('Finances, player: 10 trade goods over 20 billion km pay the published 75, with the one-way loaded basis and no computer-run halving', () => attempt(() => {
    const { result, basis } = estimateOf(false)

    return (close(provenance.valueOrNull(result), 75) && /one-way loaded route distance in billion km, with every unit carried the whole leg/.test(basis) && !/computer-run/.test(basis)) || `${provenance.valueOrNull(result)} ${basis}`
  }))
  add('Finances, computer-run empire: the same estimate pays half, 37.5, and the basis names the halving', () => attempt(() => {
    const { result, basis } = estimateOf(true)

    return (close(provenance.valueOrNull(result), 37.5) && /times 0\.5 for a computer-run empire/.test(basis) && /one-way loaded route distance/.test(basis)) || `${provenance.valueOrNull(result)} ${basis}`
  }))
  add('Finances: an unsupported version gives no figure to a player or a computer-run empire', () => [false, true].every((kind) => ['2.6.0', null].every((formulaVersion) => noFigure(estimateOf(kind, { formulaVersion }).result) && provenance.valueOrNull(estimateOf(kind, { formulaVersion }).result) === null)))
  add('Finances: a field left empty gives no figure, for a player and a computer-run empire', () => [false, true].every((kind) => noFigure(estimateOf(kind, { tariffQuantity: '' }).result) && noFigure(estimateOf(kind, { tariffDistance: '' }).result)))
  add('Transport, player: the note gives the published figure over a 1.3 bn km route and no computer-run halving', () => attempt(() => {
    const note = noteOf(false)

    return (note && /Colonist 0\.00015 a unit per billion km, 0\.000195 a unit over the route/.test(note.text) && /Passenger 0\.006 a unit per billion km, 0\.0078 a unit over the route/.test(note.text) && !/computer-run/.test(note.text) && close(provenance.valueOrNull(note.result), 0.000195)) || (note ? note.text : 'no note')
  }))
  add('Transport, computer-run empire: the note gives half the figure, names the halving and carries the halved result', () => attempt(() => {
    const note = noteOf(true)

    return (note && /Colonist 0\.00015 a unit per billion km, 0\.0000975 a unit over the route/.test(note.text) && /Passenger 0\.006 a unit per billion km, 0\.0039 a unit over the route/.test(note.text) && /computer-run empire paid half/.test(note.text) && close(provenance.valueOrNull(note.result), 0.0000975)) || (note ? note.text : 'no note')
  }))
  add('Transport, computer-run empire over routes of two lengths: the low and the high figure are both halved', () => attempt(() => {
    const note = noteOf(true, { civilianRuns: [{ status: 'ok', km: 1e9 }, { status: 'ok', km: 3e9 }] })

    return (note && /Colonist 0\.00015 a unit per billion km, 0\.000075 to 0\.000225 a unit over the route/.test(note.text)) || (note ? note.text : 'no note')
  }))
  add('Transport: an unsupported version or no route gives the limitation and no figure, for a player and a computer-run empire', () => attempt(() => [false, true].every((kind) => {
    const version = noteOf(kind, { formulaVersion: '2.6.0' })
    const route = noteOf(kind, { civilianRuns: [{ status: 'noroute', km: 5e9 }] })

    return /game version has no published payout rates/.test(version.text) && noFigure(version.result) && /no shipping line ship has a route/.test(route.text) && noFigure(route.result)
  })))
  add('Transport: no note while shipping lines are off or no destination is picked', () => attempt(() => noteOf(false, { CivilianShippingLinesActive: false }) === null && noteOf(true, { destination: null }) === null))

  return all
}

// A copy of the utilities folder in the temp folder in which `file` has the first occurrence of `from` replaced by `to`.
const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-tariff-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')
  const at = source.indexOf(from)

  if (at < 0) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation of ${file} does not apply: ${from}`)
  }

  fs.writeFileSync(target, source.slice(0, at) + to + source.slice(at + from.length))

  return directory
}

const MUTATIONS = [
  ['the colonist rate is the 2.6 one', 'unit: \'colonist\', rate: 0.00015', 'unit: \'colonist\', rate: 0.0001'],
  ['the passenger rate is the 2.6 one', 'unit: \'passenger\', rate: 0.006', 'unit: \'passenger\', rate: 0.004'],
  ['the trade good rate is the 2.6 one', 'unit: \'trade good\', rate: 0.375', 'unit: \'trade good\', rate: 0.25'],
  ['the cargo point rate is the 2.6 one', 'unit: \'cargo point\', rate: 0.00015', 'unit: \'cargo point\', rate: 0.0001'],
  ['fuel is given a rate nothing publishes', 'unit: \'litre\', rate: null', 'unit: \'litre\', rate: 0.00015'],
  ['the distance is converted with a million, not a billion', 'KM_PER_BILLION = 1e9', 'KM_PER_BILLION = 1e6'],
  ['a route in km is priced as billion km without conversion', 'billionKm: billionKm(km), npr })', 'billionKm: km, npr })'],
  ['the computer-run modifier is 1, as for a player', 'NPR_PAYOUT_MODIFIER = 0.5', 'NPR_PAYOUT_MODIFIER = 1'],
  ['the computer-run modifier is the 1.5 of 2.6', 'NPR_PAYOUT_MODIFIER = 0.5', 'NPR_PAYOUT_MODIFIER = 1.5'],
  ['the computer-run modifier is 0.75, the effective figure rather than the one set', 'NPR_PAYOUT_MODIFIER = 0.5', 'NPR_PAYOUT_MODIFIER = 0.75'],
  ['the modifier is never applied', '(npr ? NPR_PAYOUT_MODIFIER : 1)', '1'],
  ['the modifier is applied to a player and not to a computer-run empire', '(npr ? NPR_PAYOUT_MODIFIER : 1)', '(npr ? 1 : NPR_PAYOUT_MODIFIER)'],
  ['the modifier is applied to both kinds of race', '(npr ? NPR_PAYOUT_MODIFIER : 1)', 'NPR_PAYOUT_MODIFIER'],
  ['an unknown race kind is priced as a player\'s', 'typeof npr === \'boolean\' ? [] :', 'true ? [] :'],
  ['the rows leave the race kind out of the estimate', 'billionKm: billionKm(km), npr })', 'billionKm: billionKm(km), npr: false })'],
  ['the result no longer names the modifier it applied', 'npr ? \'the published computer-run modifier of 0.5\' : \'a player\\\'s race, paid the published rate\'', '\'the published rate\''],
  ['the rates themselves are halved for a computer-run empire', 'value: category.rate, inputs', 'value: category.rate * 0.5, inputs'],
  ['the payout rows price two units', 'quantity: 1, billionKm', 'quantity: 2, billionKm'],
  ['the rates are given to every game version', 'if (ruleSupports(\'civilianTariff.rates\', version) !== true) {', 'if (false) {'],
  ['the rules hold for any 2.x version', 'const TARIFF_VERSIONS = [\'2.7.x\']', 'const TARIFF_VERSIONS = [\'2.x\']'],
  ['the rules hold for 2.6 as well', 'const TARIFF_VERSIONS = [\'2.7.x\']', 'const TARIFF_VERSIONS = [\'2.7.x\', \'2.6.x\']'],
  ['an unknown rate falls through to a figure', 'if (!category || category.rate === null) {', 'if (!category) {'],
  ['an unavailable rate no longer stops the estimate', 'if (!isAvailable(rate)) {', 'if (false) {'],
  ['the quantity is not checked', 'finite(quantity) && quantity >= 0', 'true'],
  ['a negative quantity is allowed', 'finite(quantity) && quantity >= 0', 'finite(quantity)'],
  ['the distance is not checked', 'finite(distance) && distance >= 0', 'true'],
  ['the payout adds the distance instead of multiplying', 'quantity * rate.value * distance', 'quantity * rate.value + distance'],
  ['the payout leaves the quantity out', 'quantity * rate.value * distance', 'rate.value * distance'],
  ['the rate is called confirmed', 'verification: \'estimated\',\n  structure: [\'the published payout rates by category\']', 'verification: \'confirmed\',\n  structure: [\'the published payout rates by category\']'],
  ['the payout rule is called confirmed', 'verification: \'estimated\',\n  structure: [\'civilianTariff.rates\', \'the route distance\']', 'verification: \'confirmed\',\n  structure: [\'civilianTariff.rates\', \'the route distance\']'],
  ['the payout rule drops its assumptions', 'assumptions: [\'every unit is carried the whole distance\', \'the distance is the route travelled loaded\'],', ''],
  ['a mapping is always complete', 'complete: !unplaced.length && uses.some((use) => use.role === \'payout\')', 'complete: true'],
  ['a mapping needs no use that carries the payout', 'uses.some((use) => use.role === \'payout\')', 'true'],
  ['a mapping ignores an unplaced use', '!unplaced.length &&', 'true &&'],
  ['an unknown role counts as placed', 'const unplaced = uses.filter((use) => !ROLES.includes(use.role))', 'const unplaced = uses.filter((use) => use.role === undefined)'],
  ['every shipped use starts as a payout', 'Object.freeze({ ...use, role: null })', 'Object.freeze({ ...use, role: \'payout\' })'],
  ['the net cost no longer waits for a complete mapping', '} else if (!mapping.complete) {', '} else if (false) {'],
  ['the net cost holds for every version', 'if (ruleSupports(\'civilianTariff.netCost\', version) !== true) {', 'if (false) {'],
  ['the net cost adds the taxes', 'sum(\'payout\') - sum(\'tax\')', 'sum(\'payout\') + sum(\'tax\')'],
  ['the net cost leaves the taxes out', 'sum(\'payout\') - sum(\'tax\')', 'sum(\'payout\')'],
  ['a use with nothing logged is not counted as 0', '(totals[use.id] || 0)', 'totals[use.id]'],
  ['the Civilian Contracts use is missing', '  { id: 44, label: \'Civilian Contracts\', side: \'spending\' },\n', ''],
  ['a tax use is on the spending side', '{ id: 32, label: \'Tax on Shipping Trade Goods\', side: \'income\' }', '{ id: 32, label: \'Tax on Shipping Trade Goods\', side: \'spending\' }'],
  ['civilian mining is counted as a shipping use', '  { id: 47, label: \'Tax on Civilian Fuel\', side: \'income\' },\n', '  { id: 47, label: \'Tax on Civilian Fuel\', side: \'income\' },\n  { id: 35, label: \'Tax on Civilian Mining\', side: \'income\' },\n'],
  ['the civilian categories take the uses of the ledger in the ledger\'s order and keep the others', 'uses.map((use) => categories.find((category) => category.id === use.id)).filter(Boolean)', 'categories'],
  ['a small figure is rounded to a whole number', 'Number(value.toPrecision(4)).toFixed(12)', 'Math.round(value).toFixed(12)'],
  ['the separator is dropped from a large figure', 'countText(value, 0, separator)', 'countText(value, 0)'],
  ['the version text claims rates for any version', 'ruleSupports(\'civilianTariff.rates\', version) === true ? `Payout rates', 'ruleSupports(\'civilianTariff.rates\', version) !== true ? `Payout rates'],
]

const PAGE_MUTATIONS = [
  ['Finances feeds a fixed 2.7 version to the estimate', 'finances', 'payoutEstimate({ version: this.formulaVersion,', 'payoutEstimate({ version: \'2.7.x\','],
  ['Finances reads the rates for a fixed 2.7 version', 'finances', 'rateOf(this.formulaVersion, category.id)', 'rateOf(\'2.7.x\', category.id)'],
  ['Finances asks the net cost for a fixed 2.7 version', 'finances', 'netCostResult({ version: this.formulaVersion,', 'netCostResult({ version: \'2.7.x\','],
  ['Finances builds its own complete mapping', 'finances', 'const TARIFF_MAPPING = treasuryMapping()', 'const TARIFF_MAPPING = { complete: true, uses: [], unplaced: [] }'],
  ['Finances loses the summary of the panel', 'finances', 'data-summary="What a civilian shipping line', 'data-x="What a civilian shipping line'],
  ['Finances shows a net cost figure while it is unavailable', 'finances', 'netCost.value === null ? \'—\' : signed(netCost.value)', 'signed(netCost.value)'],
  ['Finances stops reading the schema version', 'finances', 'return await loadFormulaVersion(this.database)', 'return \'2.7.x\''],
  ['Finances speaks to the reader', 'finances', 'Units carried times the rate times the one-way', 'Your units carried times the rate times the one-way'],
  ['Transport prices the route for a fixed 2.7 version', 'information', 'payoutRows({ version, km: shortest, npr })', 'payoutRows({ version: \'2.7.x\', km: shortest, npr })'],
  ['Finances prices the estimate for a player\'s race only', 'finances', 'billionKm: typed(this.tariffDistance), npr: this.RaceNPR })', 'billionKm: typed(this.tariffDistance), npr: false })'],
  ['Finances prices the estimate for a computer-run empire only', 'finances', 'billionKm: typed(this.tariffDistance), npr: this.RaceNPR })', 'billionKm: typed(this.tariffDistance), npr: true })'],
  ['Finances gives the estimate no race kind', 'finances', 'billionKm: typed(this.tariffDistance), npr: this.RaceNPR })', 'billionKm: typed(this.tariffDistance) })'],
  ['Finances stops reading the race kind from the store', 'finances', '    ...mapState([\'RaceNPR\']),\n', ''],
  ['Finances loses the one-way loaded label of the distance field', 'finances', 'label="One-way loaded distance, billion km"', 'label="Distance, billion km"'],
  ['Finances loses the one-way loaded aria label of the distance field', 'finances', 'aria-label="One-way loaded distance in billion km"', 'aria-label="Distance in billion km"'],
  ['Finances loses the one-way loaded basis of the estimate', 'finances', 'one-way loaded route distance in billion km, with every unit carried the whole leg', 'route distance in billion km'],
  ['Finances no longer says the units are carried the whole leg', 'finances', ', with every unit carried the whole leg', ''],
  ['Finances loses the halving note of a computer-run empire', 'finances', ', times 0.5 for a computer-run empire', ''],
  ['Transport stops reading the race kind from the store', 'information', '    ...mapState([\'RaceNPR\']),\n', ''],
  ['Transport prices the nearest route for a player\'s race only', 'information', 'payoutRows({ version, km: shortest, npr })', 'payoutRows({ version, km: shortest, npr: false })'],
  ['Transport prices the longest route for a player\'s race only', 'information', 'payoutRows({ version, km: longest, npr })', 'payoutRows({ version, km: longest, npr: false })'],
  ['Transport prices the nearest route for a computer-run empire only', 'information', 'payoutRows({ version, km: shortest, npr })', 'payoutRows({ version, km: shortest, npr: true })'],
  ['Transport leaves the race kind out of the nearest route', 'information', 'payoutRows({ version, km: shortest, npr })', 'payoutRows({ version, km: shortest })'],
  // eslint-disable-next-line no-template-curly-in-string
  ['Transport leaves the halving out of the note', 'information', '${npr ? \', with a computer-run empire paid half\' : \'\'}', ''],
  ['Transport reads the race kind as always a player\'s', 'information', 'const npr = this.RaceNPR', 'const npr = false'],
  ['Transport leaves out the limitation for a version without rates', 'information', 'game version has no published payout rates', 'game version has rates'],
  ['Transport drops the provenance mark of the note', 'information', '<provenance-mark :result="payoutNote.result" label />', ''],
  ['Transport claims the payout as the race\'s cost', 'information', 'no cost to the race is claimed', 'it is the race\'s cost'],
]

const failedChecks = (modules) => synthetic(modules).filter(([, test]) => {
  try {
    return test() !== true
  } catch (error) {
    return true
  }
})

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['../AuroraDB_271_skoormit_saved.db', 138, 785] }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const allRows = (raw, sql, replacements) => new Promise((resolve, reject) => {
  raw.all(sql, replacements, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({
      query: (sql, replacements = []) => allRows(raw, sql, replacements),
      close: () => raw.close(),
    })
  })
})

const compareSave = async (label, [file, GameID, RaceID], { tariff, provenance, finances }) => {
  console.log(`\n${label} save: ${file} (game ${GameID}, race ${RaceID})`)

  const database = await openSave(file)

  if (!database) {
    console.log(`SKIP  ${file} is not there`)

    return
  }

  const { valueOrNull } = provenance
  const uses = await database.query('select WealthUseID, Description, Income from DIM_WealthUse')
  const byId = Object.fromEntries(uses.map((use) => [use.WealthUseID, use]))
  const wrong = Object.entries(EXPECTED_USES).filter(([id, [description, side]]) => !byId[id] || byId[id].Description.trim() !== description || (byId[id].Income === 1 ? 'income' : 'spending') !== side).map(([id]) => id)

  check(`${label}: every civilian use is in the save's wealth use table with the table's name and side`, wrong.length === 0 ? true : `wrong or missing: ${wrong.join(', ')}`, `${Object.keys(EXPECTED_USES).length} uses`)

  const touching = uses.filter((use) => /shipping|passenger|civilian|tariff/i.test(use.Description) && !EXPECTED_USES[use.WealthUseID] && !EXCLUDED_USES.includes(use.WealthUseID))

  check(`${label}: every use whose name mentions shipping, passenger, civilian or tariff is a civilian use or an acknowledged exclusion`, touching.length === 0 ? true : `unplaced: ${touching.map((use) => `${use.WealthUseID} ${use.Description}`).join('; ')}`, `exclusions ${EXCLUDED_USES.join(', ')}`)

  const [game] = await database.query('select GameTime, StartYear from FCT_Game where GameID = ?', [GameID])
  const [race] = await database.query('select WealthPoints, AnnualWealth from FCT_Race where GameID = ? and RaceID = ?', [GameID, RaceID])
  const wealth = await database.query('select FCT_WealthData.UseID, coalesce(DIM_WealthUse.Description, \'Unknown (\' || FCT_WealthData.UseID || \')\') as Description, DIM_WealthUse.Income as Income, DIM_WealthUse.DisplayOrder, FCT_WealthData.TimeUsed, sum(FCT_WealthData.Amount) as Amount from FCT_WealthData left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID where FCT_WealthData.GameID = ? and FCT_WealthData.RaceID = ? group by FCT_WealthData.UseID, FCT_WealthData.TimeUsed', [GameID, RaceID])

  check(`${label}: the race has a wealth log to read`, wealth.length > 0, `${wealth.length} rows`)

  const ledger = finances.buildLedger({ treasury: { ...race, ...game }, wealth, windowDays: 365 })
  const rows = tariff.civilianCategories(ledger.categories)
  const windowStart = game.GameTime - 365 * 86400
  const direct = {}

  wealth.filter((row) => row.TimeUsed > windowStart).forEach((row) => {
    direct[row.UseID] = (direct[row.UseID] || 0) + row.Amount
  })

  const differing = rows.filter((row) => !tariff.CIVILIAN_USES.some((use) => use.id === row.id) || Math.abs(row.total - (direct[row.id] || 0)) > 1e-6 * Math.max(1, Math.abs(row.total)))
  const uncovered = tariff.CIVILIAN_USES.filter((use) => (direct[use.id] || 0) !== 0 && !rows.some((row) => row.id === use.id))

  check(`${label}: the civilian rows of the ledger equal the amounts summed straight from the log, and no logged civilian use is missing from them`, differing.length === 0 && uncovered.length === 0 ? true : `differ: ${differing.map((row) => row.id).join(', ')}; missing: ${uncovered.map((use) => use.id).join(', ')}`, `${rows.length} civilian uses logged in the last year`)

  const totals = Object.fromEntries(ledger.categories.map((category) => [category.id, category.total]))
  const net = tariff.netCostResult({ version: '2.7.x', mapping: tariff.treasuryMapping(), totals })

  check(`${label}: the net cost is unavailable on the logged amounts`, !provenance.isAvailable(net) && valueOrNull(net) === null)

  rows.forEach((row) => console.log(`  ${row.id} ${row.label} (${row.income ? 'income' : 'spending'}): ${row.total} in the last year`))

  database.close()
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const utilities = await loadUtilities(MODULES)
  const mods = { tariff: utilities['civilian-tariff'], provenance: utilities.provenance, finances: utilities.finances }

  console.log('Synthetic checks')

  for (const [name, test] of synthetic(mods)) {
    let result

    try {
      result = test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    check(name, result)
  }

  console.log('\nPages')

  const utility = readSource('src/renderer/utilities/civilian-tariff.js')
  const pages = { finances: fs.readFileSync(path.join(pagesDirectory, 'finances.vue'), 'utf8'), information: fs.readFileSync(path.join(pagesDirectory, 'information.vue'), 'utf8'), utility, tariff: mods.tariff, provenance: mods.provenance }

  for (const [name, held] of wiring(pages)) {
    check(name, held === true)
  }

  console.log('\nMutations: each must fail at least one check')

  for (const [label, from, to] of MUTATIONS) {
    let directory

    try {
      directory = mutatedCopy(FILE, from, to)

      let failed = []

      try {
        const mutant = await loadUtilities(MODULES, { directory })

        failed = failedChecks({ tariff: mutant['civilian-tariff'], provenance: mutant.provenance, finances: mutant.finances })
      } catch (error) {
        failed = [[`does not load: ${error.message}`]]
      }

      check(`mutation caught: ${label}`, failed.length > 0 ? true : 'every check still passes', `${failed.length} checks fail`)
    } catch (error) {
      check(`mutation caught: ${label}`, error.message)
    } finally {
      if (directory) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }

  for (const [label, page, from, to] of PAGE_MUTATIONS) {
    const source = pages[page]

    if (!source.includes(from)) {
      check(`mutation caught: ${label}`, `the mutation does not apply: ${from}`)

      continue
    }

    let failed

    try {
      failed = wiring({ ...pages, [page]: source.replace(from, () => to) }).filter(([, held]) => held !== true)
    } catch (error) {
      failed = [[`the page no longer reads: ${error.message}`]]
    }

    check(`mutation caught: ${label}`, failed.length > 0 ? true : 'every check still passes', `${failed.length} checks fail`)
  }

  await compareSave('modded', options.modded, mods)
  await compareSave('stock', options.stock, mods)

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
