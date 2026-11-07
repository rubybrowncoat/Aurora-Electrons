/*
  Checks the civilian shipping-line payout explanation (src/renderer/utilities/civilian-tariff.js) and its use by the Finances and Transport pages.

  node scripts/check-civilian-tariffs.js [--no-mutations] [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>]

  --no-mutations runs the checks of the real sources alone: no fault is planted.

  The synthetic checks need no save. They prove: the fares of every category at the published rates (colonist, passenger, trade good, cargo point) equal the quantity times the published rate times the distance in billion km, with the expected figures written out by hand; a route in km is converted to billion km before it is priced; the rates are the published ones and not the ones they replaced; the fare is never halved, and a receipt is that fare less the race's shipping-line tax, halved once for a computer-run empire (75 at 25 % pays a player's line 56.25 and a computer-run empire's 28.125), with a tax rate outside a share of 0 to 1 or a race kind that is not known giving no figure; an unsupported or unknown game version, a category with no published rate, and a quantity or distance that is not a number of 0 or more give an unavailable result that names what is missing, never 0; an extra per-system tariff field changes nothing; the civilian uses of the wealth log are the expected ones, each on its side; no net cost is given while any civilian use is not placed against a payout, whatever amounts are logged, and a fully placed table gives the logged payout uses less the taxes; the figures read as text; both pages feed the save's formula version, the saved tax rate and the saved race kind to the rules, run on a player's race and a computer-run empire (the worked estimate and the Transport note are evaluated from the pages' own source), the worked estimate and the Transport note take a tax read only once it has settled for the race and the copy of the save now open, so a reread in flight, a race or save switch, or a failed reread gives its own words and no amount rather than a previous read's receipt, the Finances panel shows the fare and the receipt apart, each on its one-way loaded basis, and the new panel carries a summary; and the new text speaks in no first or second person. Then each of the mutations below, one fault planted in a copy of the sources, must make at least one check fail, so that the checks cannot pass by checking nothing.

  With a save (by default the migrated 3.1 fixture of scripts/lib/fixtures.js; one that is not there is reported as not run) it also reads the wealth use table and the race's wealth log: every civilian use is in the save's table with the table's name and side, every use of the save whose name mentions shipping, passenger, civilian or tariff is a civilian use or an acknowledged exclusion, the civilian rows of the ledger the Finances page builds equal the amounts summed straight from the log, and the net cost is unavailable. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { assert, runChecks, judged, caughtBy } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { fixtureTriple, playedTriple } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pagesDirectory = path.join(root, 'src', 'renderer', 'pages')
const MODULES = ['civilian-tariff', 'shipping-runway', 'provenance', 'finances', 'math']
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

const UNSUPPORTED = [null, undefined, '', ' ', '2.8.0', '3.20.0', '3.0.0', '3.1.0', '4.0.0', '1.9.0', 'x']

const missingText = (result) => result.inputs.missing.join(' | ')

// The checks that need no save, over the modules `m` ({ tariff, provenance, finances }): [[name, () => true or a message]]. Run on the real modules and again on each mutated copy, where one at least must fail.
const synthetic = ({ tariff, provenance, finances }) => {
  const all = []
  const add = (name, run) => all.push([name, run])
  const { CATEGORIES, CIVILIAN_USES, billionKm, rateOf, payoutEstimate, receiptEstimate, receiptOf, payoutRows, describeTariffVersion, treasuryMapping, civilianCategories, netCostResult, amountText } = tariff
  const { valueOrNull, isAvailable, getRule, ruleSupports } = provenance
  const noValue = (result) => !isAvailable(result) && result.value === null
  const estimate = (extra) => payoutEstimate({ version: '3.2.x', category: 'tradeGood', quantity: 10, billionKm: 20, ...extra })
  const receipt = (extra) => receiptEstimate({ version: '3.2.x', category: 'tradeGood', quantity: 10, billionKm: 20, taxRate: 0, npr: false, ...extra })

  add('colonist: 2000 colonists over 12 billion km at 0.00015 pay 3.6', () => close(valueOrNull(estimate({ category: 'colonist', quantity: 2000, billionKm: 12 })), 3.6) || `${valueOrNull(estimate({ category: 'colonist', quantity: 2000, billionKm: 12 }))}`)
  add('passenger: 500 passengers over 5 billion km at 0.006 pay 15', () => close(valueOrNull(estimate({ category: 'passenger', quantity: 500, billionKm: 5 })), 15))
  add('trade good: 10 trade goods over 20 billion km at 0.375 pay 75', () => close(valueOrNull(estimate()), 75))
  add('cargo point: 25000 cargo points over 4 billion km at 0.00015 pay 15', () => close(valueOrNull(estimate({ category: 'cargoPoint', quantity: 25000, billionKm: 4 })), 15))
  add('one trade good over half a billion km pays 0.1875', () => close(valueOrNull(estimate({ quantity: 1, billionKm: 0.5 })), 0.1875))
  add('the rates are the published ones for every category', () => Object.entries(PUBLISHED).every(([id, rate]) => valueOrNull(rateOf('3.2.x', id)) === rate) || JSON.stringify(Object.keys(PUBLISHED).map((id) => valueOrNull(rateOf('3.2.x', id)))))
  add('the rates are not the 2.6 ones: each is 50% above', () => Object.entries(SIX).every(([id, rate]) => close(valueOrNull(rateOf('3.2.x', id)) / rate, 1.5)))
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
  add('3.2.0, 3.2.1 and 3.2.x all give the rate', () => ['3.2.0', '3.2.1', '3.2.x', '3.2'].every((version) => valueOrNull(rateOf(version, 'tradeGood')) === 0.375 && close(valueOrNull(estimate({ version })), 75)))
  add('a route of 12.5e9 km is 12.5 billion km, 1e9 km is 1, 0 km is 0', () => billionKm(12.5e9) === 12.5 && billionKm(1e9) === 1 && billionKm(0) === 0)
  add('a distance that is not a number has no billion km', () => billionKm(null) === null && billionKm(undefined) === null && billionKm(NaN) === null && billionKm(Infinity) === null)
  add('one unit over a measured route of 12.5e9 km pays the rate times 12.5 in every priced category', () => {
    const rows = payoutRows({ version: '3.2.x', km: 12.5e9, taxRate: 0, npr: false })

    return Object.entries(PUBLISHED).every(([id, rate]) => close(valueOrNull(rows.find((row) => row.category.id === id).fare), rate * 12.5)) || 'a row is wrong'
  })
  add('the rows list every category once, the unpriced ones as unavailable', () => {
    const rows = payoutRows({ version: '3.2.x', km: 12.5e9, taxRate: 0, npr: false })

    return rows.length === CATEGORIES.length && new Set(rows.map((row) => row.category.id)).size === rows.length && noValue(rows.find((row) => row.category.id === 'fuel').receipt) && rows.filter((row) => isAvailable(row.receipt)).length === 4
  })
  add('the rows carry the fare and the receipt apart: a quarter off for the tax, then half for a computer-run empire', () => {
    const player = payoutRows({ version: '3.2.x', km: 12.5e9, taxRate: 0.25, npr: false })
    const computer = payoutRows({ version: '3.2.x', km: 12.5e9, taxRate: 0.25, npr: true })
    const row = (rows, id) => rows.find((item) => item.category.id === id)

    return Object.keys(PUBLISHED).every((id) => close(valueOrNull(row(player, id).receipt), valueOrNull(row(player, id).fare) * 0.75) && close(valueOrNull(row(computer, id).receipt) * 2, valueOrNull(row(player, id).receipt))) || 'a row is wrong'
  })
  add('the rows without a race kind or a tax rate are unavailable, the fares still there', () => {
    const rows = payoutRows({ version: '3.2.x', km: 12.5e9 })

    return rows.filter((row) => isAvailable(row.fare)).length === 4 && rows.filter((row) => isAvailable(row.receipt)).length === 0
  })
  add('a result is estimated, never confirmed, names its rule, its units and its assumptions', () => {
    const result = estimate()

    return result.status === 'estimated' && result.rule.id === 'civilianTariff.payout' && result.units === 'wealth' && result.assumptions.length > 0 && result.inputs.present.length > 0 && rateOf('3.2.x', 'colonist').status === 'estimated'
  })
  add('a zero quantity or distance is a known 0 fare and receipt, not unavailable', () => valueOrNull(estimate({ quantity: 0 })) === 0 && isAvailable(estimate({ quantity: 0 })) && valueOrNull(estimate({ billionKm: 0 })) === 0 && valueOrNull(receipt({ quantity: 0 })) === 0 && valueOrNull(receipt({ billionKm: 0 })) === 0)

  add('the fare is never halved: the same figure for either kind of race and whatever else is passed', () => close(valueOrNull(estimate({ npr: true })), 75) && close(valueOrNull(estimate({ npr: false })), 75) && close(valueOrNull(estimate({ modifier: 0.5, taxRate: 0.25 })), 75))
  add('receipt: a player\'s line is paid the fare less the race\'s tax: 75 less 25 % is 56.25', () => close(valueOrNull(receipt({ taxRate: 0.25 })), 56.25) || `${valueOrNull(receipt({ taxRate: 0.25 }))}`)
  add('receipt: a computer-run empire\'s line is paid half of what is left after the tax: 75 at 25 % is 28.125, the halving applied once', () => close(valueOrNull(receipt({ taxRate: 0.25, npr: true })), 28.125) || `${valueOrNull(receipt({ taxRate: 0.25, npr: true }))}`)
  add('receipt: no tax leaves the whole fare to the line, and a tax of 100 % leaves nothing, a known 0', () => close(valueOrNull(receipt({ taxRate: 0 })), 75) && valueOrNull(receipt({ taxRate: 1 })) === 0 && isAvailable(receipt({ taxRate: 1 })))
  add('receipt: a computer-run empire over 2000 colonists of 12 billion km at 0.00015 and 25 % is paid 1.35', () => close(valueOrNull(receipt({ category: 'colonist', quantity: 2000, billionKm: 12, taxRate: 0.25, npr: true })), 1.35))
  add('receipt: the pure receipt of 100 at 20 % is 80 for a player and 40 for a computer-run empire, never 20', () => receiptOf(100, { taxRate: 0.2 }) === 80 && receiptOf(100, { taxRate: 0.2, modifier: 0.5 }) === 40 && close(receiptOf(100, { taxRate: 0.2, modifier: 0.5 }), 100 * 0.8 * 0.5))
  add('receipt: every priced category gives the fare less the tax and the halving', () => Object.entries(PUBLISHED).every(([id, rate]) => close(valueOrNull(receipt({ category: id, quantity: 8000, billionKm: 3, taxRate: 0.2, npr: true })), 8000 * rate * 3 * 0.8 * 0.5)) || Object.keys(PUBLISHED).map((id) => `${id}:${valueOrNull(receipt({ category: id, quantity: 8000, billionKm: 3, taxRate: 0.2, npr: true }))}`).join(' '))
  add('receipt: a race kind that is not true or false gives no figure and names the kind as missing', () => [undefined, null, 'true', 'false', 1, 0, ''].every((npr) => noValue(receipt({ npr })) && /player's or computer-run/.test(missingText(receipt({ npr })))) && noValue(receipt({ quantity: 0, npr: undefined })))
  add('receipt: a tax rate that is not a share of 0 to 1 gives no figure and names the rate as missing', () => [undefined, null, NaN, -0.1, 1.1, '0.25', Infinity].every((taxRate) => noValue(receipt({ taxRate })) && /shipping-line tax rate/.test(missingText(receipt({ taxRate })))))
  add('receipt: an unsupported version, fuel or a missing distance gives no receipt either, whatever the tax', () => noValue(receipt({ version: '2.6.0', taxRate: 0.2 })) && noValue(receipt({ version: null, taxRate: 0.2 })) && noValue(receipt({ category: 'fuel', taxRate: 0.2 })) && noValue(receipt({ billionKm: null, taxRate: 0.2 })))
  add('receipt: a result is estimated, names the receipt rule, its units and its assumptions, and names the modifier it applied', () => {
    const result = receipt({ taxRate: 0.25, npr: true })

    return result.status === 'estimated' && result.rule.id === 'civilianTariff.receipt' && result.units === 'wealth' && result.assumptions.length > 0 && result.inputs.present.some((text) => /0\.5/.test(text)) && !receipt({ taxRate: 0.25 }).inputs.present.some((text) => /0\.5/.test(text)) && /0\.5/.test(getRule('civilianTariff.receipt').note)
  })
  add('the published rates are the same for either kind of race: only the receipt is halved', () => ['colonist', 'passenger', 'tradeGood', 'cargoPoint'].every((id) => valueOrNull(rateOf('3.2.x', id)) === PUBLISHED[id]))

  add('the rules are registered with the stated line\'s version', () => ['civilianTariff.rates', 'civilianTariff.payout', 'civilianTariff.receipt', 'civilianTariff.netCost'].every((id) => getRule(id) && getRule(id).versions.length === 1 && getRule(id).versions[0] === '3.2.x'))
  add('the fifteen shipping rules of the two families list the stated line\'s version and no other', () => {
    const ids = ['civilianTariff.rates', 'civilianTariff.payout', 'civilianTariff.receipt', 'civilianTariff.netCost', 'shippingRunway.taxRate', 'shippingRunway.windowTax', 'shippingRunway.raceKind', 'shippingRunway.assumption', 'shippingRunway.windowFlow', 'shippingRunway.contractFlow', 'shippingRunway.planLine', 'shippingRunway.scenarioNet', 'shippingRunway.exhaustion', 'shippingRunway.breakEven', 'shippingRunway.windowSpread']

    return ids.filter((id) => !getRule(id) || getRule(id).versions.length !== 1 || getRule(id).versions[0] !== '3.2.x').length === 0 ? true : ids.filter((id) => !getRule(id) || getRule(id).versions.length !== 1 || getRule(id).versions[0] !== '3.2.x').join(', ')
  })
  add('the rules hold for the stated line\'s releases and for no other version', () => ['3.2.0', '3.2.1', '3.2.x'].every((version) => ruleSupports('civilianTariff.rates', version) === true) && UNSUPPORTED.filter((version) => version !== ' ' && version !== '').every((version) => ruleSupports('civilianTariff.rates', version) !== true))

  UNSUPPORTED.forEach((version) => {
    add(`unsupported game version ${JSON.stringify(version)}: no rate, no estimate, no row figure, each naming the version as missing`, () => {
      const results = [rateOf(version, 'tradeGood'), estimate({ version }), receipt({ version }), ...payoutRows({ version, km: 12.5e9, taxRate: 0.2, npr: false }).flatMap((row) => [row.rate, row.fare, row.receipt])]

      return results.every((result) => noValue(result) && result.status === 'unavailable' && /game version/.test(missingText(result))) || results.map((result) => `${result.value}`).join(',')
    })
  })
  add('an unsupported version has no figure even for a zero quantity', () => noValue(estimate({ version: '2.6.0', quantity: 0 })) && noValue(estimate({ version: null, quantity: 1, billionKm: 0 })) && noValue(receipt({ version: '2.6.0', quantity: 0 })))
  add('the version text says rates are published for a supported version and none for another', () => !/No payout rates/.test(describeTariffVersion('3.2.x')) && !/No payout rates/.test(describeTariffVersion('3.2.1')) && /No payout rates/.test(describeTariffVersion(null)) && /No payout rates/.test(describeTariffVersion('2.6.0')))

  add('fuel has no published rate: unavailable and naming fuel, never 0', () => {
    const rate = rateOf('3.2.x', 'fuel')
    const result = estimate({ category: 'fuel', quantity: 1000, billionKm: 5 })

    if (process.argv.includes('--detail')) {
      console.log('VALUE fuel rate and payout:', JSON.stringify([rate.value, result.value]))
    }
    return (noValue(rate) && noValue(result) && /fuel/.test(missingText(rate)) && /fuel/.test(missingText(result)) && result.value !== 0) || `fuel rate ${rate.value}, payout ${result.value}; expected both unavailable`
  })
  add('an unknown category has no rate and no estimate', () => [undefined, null, '', 'bogus', 'perSystem'].every((category) => noValue(rateOf('3.2.x', category)) && noValue(estimate({ category }))))
  add('a quantity that is not a number of 0 or more is unavailable and named', () => [null, undefined, NaN, -1, Infinity, '5'].every((quantity) => noValue(estimate({ quantity })) && /quantity/.test(missingText(estimate({ quantity })))))
  add('a distance that is not a number of 0 or more is unavailable and named', () => [null, undefined, NaN, -0.5, Infinity, '5'].every((distance) => noValue(estimate({ billionKm: distance })) && /distance/.test(missingText(estimate({ billionKm: distance })))))
  add('both missing: both are named', () => /quantity/.test(missingText(estimate({ quantity: null, billionKm: null }))) && /distance/.test(missingText(estimate({ quantity: null, billionKm: null }))))
  add('a per-system tariff field changes nothing: the figure is the published rate whatever else is passed', () => {
    const extras = { systemTariff: 9, tariff: 9, perSystem: 9, system: 3, SystemID: 3, rate: 9, tariffRate: 9 }
    const plain = valueOrNull(estimate())

    return valueOrNull(estimate(extras)) === plain && valueOrNull(rateOf('3.2.x', 'tradeGood', extras)) === 0.375 && valueOrNull(payoutRows({ version: '3.2.x', km: 12.5e9, taxRate: 0, npr: false, ...extras }).find((row) => row.category.id === 'tradeGood').fare) === 0.375 * 12.5
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
  const FULL = { 29: 'other', 32: 'tax', 34: 'tax', 42: 'payout', 43: 'tax', 44: 'payout', 46: 'other', 47: 'other' }
  const TOTALS = { 29: 9999, 32: 100, 34: 50, 42: 250, 43: 25, 44: 1000, 46: 777, 47: 5 }

  add('the shipped mapping is incomplete, with every use unplaced', () => {
    const mapping = treasuryMapping()

    return mapping.complete === false && mapping.unplaced.length === CIVILIAN_USES.length
  })
  add('incomplete mapping: no net cost whatever the logged amounts, naming the missing link', () => {
    const result = netCostResult({ version: '3.2.x', mapping: treasuryMapping(), totals: TOTALS })

    return noValue(result) && result.value !== 0 && /link between shipping-line payouts and the logged treasury uses/.test(missingText(result)) && /8 of 8/.test(missingText(result))
  })
  add('a mapping missing one use is incomplete: no net cost', () => {
    const mapping = treasuryMapping(placed({ ...FULL, 46: undefined }))

    return mapping.complete === false && mapping.unplaced.length === 1 && noValue(netCostResult({ version: '3.2.x', mapping, totals: TOTALS }))
  })
  add('a mapping with no use that carries the payout is incomplete: no net cost', () => {
    const mapping = treasuryMapping(placed({ ...FULL, 42: 'other', 44: 'other' }))

    return mapping.complete === false && noValue(netCostResult({ version: '3.2.x', mapping, totals: TOTALS }))
  })
  add('an empty table and an unknown role are incomplete', () => !treasuryMapping([]).complete && !treasuryMapping(placed({ ...FULL, 44: 'maybe' })).complete)
  add('a fully placed mapping gives the logged payout uses less the taxes: 1250 - 175 = 1075, the fuel sale income left out', () => {
    const mapping = treasuryMapping(placed(FULL))
    const result = netCostResult({ version: '3.2.x', mapping, totals: TOTALS })

    return (mapping.complete && close(valueOrNull(result), 1075) && result.status === 'estimated' && result.rule.id === 'civilianTariff.netCost') || `${valueOrNull(result)}`
  })
  add('a fully placed mapping counts a use with nothing logged as 0', () => {
    const value = valueOrNull(netCostResult({ version: '3.2.x', mapping: treasuryMapping(placed(FULL)), totals: { 44: 1000 } }))

    if (process.argv.includes('--detail')) {
      console.log('VALUE net cost for absent totals:', value)
    }
    return close(value, 1000) || `net cost ${value}; expected 1000`
  })
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

    return totals[44] === 500 && totals[32] === 20 && noValue(netCostResult({ version: '3.2.x', mapping: treasuryMapping(), totals }))
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

// The labels of the failed reads, as `utilities/load-tracking.js` joins them for the load state.
const joinLabels = (labels) => (labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] || '')

// The methods of an object-literal body (the page's own source, as it is written between two markers) compiled with the names it uses from its imports.
const compileMethods = (source, names, values) => vm.compileFunction(`return ({${source}})`, names)(...values)

const attempt = (test) => test()

// The pages' wiring, on the text of the pages: [[name, held]]. Each statement must hold of the real pages and fail of a page with one gate cut out.
const wiring = ({ finances, information, utility, tariff, provenance, math }) => {
  const heading = finances.indexOf('<span>Civilian shipping-line payouts')
  const panel = between(finances.slice(finances.lastIndexOf('<v-card', heading)), '<v-card', '</v-card>')
  const summary = (/\bdata-summary="([^"]*)"/.exec(panel) || [])[1]
  if (process.argv.includes('--detail')) {
    console.log('VALUE civilian panel summary:', JSON.stringify(summary))
  }
  const noteSource = between(information, 'payoutNote() {', 'problems() {')
  const taxStateSource = between(information, 'shippingTaxState() {', 'payoutNote() {')
  const estimateSource = between(finances, '    fare() {', '    // The ledger\'s civilian uses')
  const financeStateSource = between(finances, 'shippingTaxState() {', 'ledger() {')
  const limitationSource = between(finances, '    limitationText(result) {', '    money(value) {')
  // The page's own list of optional reads and the label it words a failure of the tax read with.
  const optionalKeys = (((/const OPTIONAL_INPUTS = \[([^\]]*)\]/.exec(finances) || [])[1] || '').match(/'[^']*'/g) || []).map((text) => text.slice(1, -1))
  const taxLabel = (/\n {2}shippingTax: '([^']*)'/.exec(finances) || [])[1] || ''
  const all = []
  const add = (name, held) => all.push([name, typeof held === 'function' ? attempt(held) : held])

  add('Finances: the panel has a data-summary and a head titled for civilian shipping-line payouts', (summary === 'Estimate civilian shipping-line payouts using rates per unit carried and per billion km.' && /^<v-card class="panel"[^>]*>\s*<div class="panel-head">\s*<span>Civilian shipping-line payouts/.test(panel)) || `panel summary ${JSON.stringify(summary)}; expected the civilian shipping-line payout summary`)
  add('Finances: the rates, the fare, the receipt and the net cost take the save\'s formula version', /rateOf\(this\.saveRules, category\.id\)/.test(finances) && /payoutEstimate\(\{ version: this\.saveRules,/.test(finances) && /receiptEstimate\(\{ version: this\.saveRules,/.test(finances) && /netCostResult\(\{ version: this\.saveRules,/.test(finances))
  add('Finances: the formula version is read from the save\'s schema, with the columns that are not there named', /formulaVersion: \{\s*get: tracked\('formulaVersion', async function \(\) \{[\s\S]{0,200}?return await loadFormulaResult\(this\.database\)/.test(finances) && /formulaVersion: 'the save\\'s schema'/.test(finances) && /const missing = this\.formulaVersion && this\.formulaVersion\.inputs \? this\.formulaVersion\.inputs\.missing : \[\]/.test(finances))
  add('Finances: the rate table gives way to a statement of the missing read where the rates are unavailable', /<v-simple-table v-if="!tariffGap" dense class="tariff-table">/.test(panel) && /<div v-else class="caption text--secondary">\{\{ tariffGap \}\}<\/div>/.test(panel))
  add('Finances: the statement is null where the save states the game rules and names every missing read where it does not', () => attempt(() => {
    const gapSource = between(finances, '    saveRules() {', '    // Each category\'s published rate')
    const methods = compileMethods(gapSource, ['ruleSupports', 'valueOrNull', 'describeTariffVersion'], [provenance.ruleSupports, provenance.valueOrNull, tariff.describeTariffVersion])
    const gapOf = (formulaVersion) => methods.tariffGap.call({ formulaVersion, get saveRules() { return provenance.valueOrNull(this.formulaVersion) } })
    const stated = { value: '3.2.x', status: 'assumed', inputs: { present: [], missing: [] } }
    const lacking = (missing) => ({ value: null, status: 'unavailable', inputs: { present: [], missing } })
    const none = gapOf(stated)
    const two = gapOf(lacking(['the Lost Colonies of FCT Game', 'the Ship Senior CO of FCT Ship']))
    const one = gapOf(lacking(['the Alien Artifacts of FCT Population']))

    return (none === null && /No payout rates are listed/.test(two) && two.includes('the Lost Colonies of FCT Game') && two.includes('the Ship Senior CO of FCT Ship') && / are not in it\.$/.test(two) && / is not in it\.$/.test(one) && /Alien Artifacts/.test(one)) || `${none} | ${two} | ${one}`
  }))
  add('Finances: the net cost is asked of the mapping the module ships, not of a mapping the page builds', /const TARIFF_MAPPING = treasuryMapping\(\)/.test(finances) && /mapping: TARIFF_MAPPING/.test(finances))
  add('Finances: the net cost line shows a dash and the limitation while it is unavailable', /netCost\.value === null \? '—' : signed\(netCost\.value\)/.test(panel) && /netCost\.value === null \? limitationText\(netCost\)/.test(panel))
  add('Finances: the fare and the receipt are shown apart, each with its mark, and an unavailable receipt shows why it is unavailable, not a figure', /Fare at the published rates, before the race's shipping-line tax: <span class="font-weight-medium">\{\{ amountText\(fare\.value\) \}\}<\/span><provenance-mark :result="fare"/.test(panel) && /Paid to the line: <span class="font-weight-medium">\{\{ amountText\(estimate\.value\) \}\}<\/span><provenance-mark :result="estimate"/.test(panel) && /estimate\.value === null \? estimateLimitation : estimateBasis/.test(panel) && /amountText\(estimate\.value\)/.test(panel))
  add('Finances: the race\'s logged spending is shown apart from the civilian uses', /Logged spending of the race, every use/.test(panel) && /civilian spending uses above/.test(panel))
  add('Finances: the panel names the one-way loaded distance in billion km and the rate by category', /One-way loaded distance, billion km/.test(panel) && /One-way loaded distance in billion km/.test(panel) && /per billion km/.test(panel) && /Rate by category, per unit carried and per billion km travelled/.test(panel))
  add('Finances: no game version is written into the page\'s tariff calls', !/version: '2\.|rateOf\('2\./.test(finances))
  add('Finances: the tax read is tagged with the race, the game and the copy of the save it was read for, and its state gives the value only for the one shown', /return \{ GameID, RaceID, generation, value: await loadShippingTax\(this\.database, \{ GameID, RaceID \}\) \}/.test(finances) && /const generation = this\.\$store\.state\.freshness\.generation/.test(financeStateSource) && /const read = this\.loadErrors\.shippingTax/.test(financeStateSource) && /typeof read === 'string'/.test(financeStateSource) && /const current = held && held\.GameID === this\.GameID && held\.RaceID === this\.RaceID && held\.generation === generation/.test(financeStateSource) && /read === null && current \?/.test(financeStateSource))
  add('Finances: the worked estimate takes the tax rate and the race kind only from the state, never from the read directly', !/this\.shippingTax\b/.test(estimateSource) && (estimateSource.match(/const shippingTax = this\.shippingTaxState\.value/g) || []).length === 2 && /Reading the race.*shipping-line tax, so no amount paid to the line is estimated yet\./.test(estimateSource) && /could not be read/.test(estimateSource) && /the save does not hold/.test(estimateSource))
  add('Transport: the payout note prices the measured route in billion km with the save\'s formula version, the saved tax and the saved race kind', /payoutRows\(\{ version, km, taxRate, npr \}\)/.test(noteSource) && /rowsAt\(shortest\)/.test(noteSource) && /rowsAt\(longest\)/.test(noteSource) && /const taxRate = shippingTax \? shippingTax\.rate : null/.test(noteSource) && /const npr = shippingTax \? shippingTax\.npr : null/.test(noteSource) && /formulaVersion: version/.test(noteSource))
  add('Transport: the note reads the race\'s shipping-line tax from the save, tagged with the race, the game and the copy it was read for', /shippingTax: \{\s*get: tracked\('shippingTax', async function \(\) \{[\s\S]{0,300}?loadShippingTax\(this\.database, \{ GameID, RaceID \}\)/.test(information) && /return \{ GameID, RaceID, generation, value:/.test(information) && /const generation = this\.\$store\.state\.freshness\.generation/.test(taxStateSource) && /const read = this\.loadErrors\.shippingTax/.test(taxStateSource) && /could not be read/.test(noteSource))
  add('Transport: a tax read made for another race, game or copy of the save is never taken for the one shown, and its reread is waited for', /const current = held && held\.GameID === this\.GameID && held\.RaceID === this\.RaceID && held\.generation === generation/.test(taxStateSource) && /read === null && current \?/.test(taxStateSource))
  add('neither page takes the race kind from the selection store: the saved kind is the one used', !/RaceNPR/.test(finances) && !/RaceNPR/.test(information) && /shippingTax\.npr/.test(finances) && /shippingTax\.npr/.test(noteSource))
  add('Transport: the note says no payout is estimated for a version without rates and for no route', /game version has no published payout rates/.test(noteSource) && /no shipping line ship has a route to the destination/.test(noteSource))
  add('Transport: the note is a panel foot carrying a provenance mark of its result', /<div v-if="payoutNote" class="panel-foot caption text--secondary">[^\n]*<provenance-mark :result="payoutNote\.result" label \/>[^\n]*\{\{ payoutNote\.text \}\}/.test(information))
  add('Transport: the note says the payout goes to the shipping line and claims no cost to the race', /goes to the shipping line/.test(noteSource) && /no cost to the race is claimed/.test(noteSource))
  add('Transport: no game version is written into the note\'s tariff calls', !/version: '2\./.test(noteSource))
  add('the new text speaks in no first or second person', !FIRST_OR_SECOND_PERSON.test(utility) && !FIRST_OR_SECOND_PERSON.test(panel) && !FIRST_OR_SECOND_PERSON.test(noteSource) && !FIRST_OR_SECOND_PERSON.test(estimateSource))

  const NO_TAX = { rate: 0, missing: '', npr: false }
  const NO_RATE = { rate: null, missing: 'the race\'s shipping line tax', npr: null }
  const TAXED = { rate: 0.25, missing: '', npr: false }
  const TAXED_COMPUTER = { rate: 0.25, missing: '', npr: true }

  // The Finances page's tax state from its own source: `held` is the tagged read the plugin keeps ({ GameID, RaceID, generation, value }), and `fields` may move the race, the copy of the save or the read's state.
  const financeStateOf = (held, fields = {}) => {
    const methods = compileMethods(financeStateSource, ['OPTIONAL_INPUTS', 'INPUT_LABELS', 'joinLabels'], [optionalKeys, { shippingTax: taxLabel }, joinLabels])

    return methods.shippingTaxState.call({ loadErrors: { shippingTax: null }, shippingTax: held, ...RACE, $store: { state: { freshness: { generation: RACE.generation } } }, ...fields })
  }

  // The Finances page's worked payout: the receipt, the fare, the basis and the words of the limitation, on a state made from the read the plugin keeps unless `fields` gives one.
  const estimateOf = (shippingTax, fields = {}) => {
    const methods = compileMethods(estimateSource, ['receiptEstimate', 'payoutEstimate', 'typed'], [tariff.receiptEstimate, tariff.payoutEstimate, typed])
    const limits = compileMethods(limitationSource, [], [])
    const context = {
      saveRules: '3.2.x',
      tariffCategory: 'tradeGood',
      tariffQuantity: '10',
      tariffDistance: '20',
      shippingTax: heldOf(shippingTax),
      shippingTaxState: financeStateOf(heldOf(shippingTax), fields),
      limitationText: limits.limitationText,
      ...fields,
      get fare() { return methods.fare.call(this) },
      get estimate() { return methods.estimate.call(this) },
    }

    return { result: methods.estimate.call(context), fare: methods.fare.call(context), basis: methods.estimateBasis.call(context), note: methods.estimateLimitation.call(context) }
  }

  const noteOf = (shippingTax, fields) => {
    const methods = compileMethods(noteSource, ['payoutRows', 'isAvailable', 'describeTariffVersion'], [tariff.payoutRows, provenance.isAvailable, tariff.describeTariffVersion])
    const context = { destination: { key: 'place' }, CivilianShippingLinesActive: true, formulaVersion: '3.2.x', civilianRuns: [{ status: 'ok', km: 1.3e9 }], shippingTaxState: { loading: false, failed: false, error: '', value: shippingTax }, amountText: (value) => tariff.amountText(value), amountRange: (low, high) => math.rangeText(low, high, { format: (value) => math.rangeFigure(tariff.amountText(value), { negative: value < 0 }) }), distance: (km) => `${km / 1e9} bn km`, distanceRange: (low, high) => math.rangeText(low, high, { format: (km) => math.rangeFigure(math.countText(km / 1e9, 2), { magnitude: 'bn', unit: ' km' }) }), ...fields }

    return methods.payoutNote.call(context)
  }

  // The tax read the plugin keeps, tagged with the race, the game and the copy of the save it was read for, and the state `shippingTaxState` makes of it: `held` is { GameID, RaceID, generation, value }.
  const RACE = { GameID: 141, RaceID: 784, generation: 7 }
  const heldOf = (value, fields) => ({ ...RACE, value, ...fields })
  const taxStateOf = (held, fields) => {
    const methods = compileMethods(taxStateSource, [], [])

    return methods.shippingTaxState.call({ loadErrors: { shippingTax: null }, shippingTax: held, ...RACE, $store: { state: { freshness: { generation: RACE.generation } } }, ...fields })
  }

  const noFigure = (result) => !provenance.isAvailable(result)

  add('Finances, player: 10 trade goods over 20 billion km are a fare of 75, and with no tax the line is paid all of it, on the one-way loaded basis', () => attempt(() => {
    const { result, fare, basis } = estimateOf(NO_TAX)

    return (close(provenance.valueOrNull(fare), 75) && close(provenance.valueOrNull(result), 75) && /one-way loaded route distance in billion km, with every unit carried the whole leg/.test(basis) && !/computer-run/.test(basis)) || `${provenance.valueOrNull(result)} ${provenance.valueOrNull(fare)} ${basis}`
  }))
  add('Finances, player: a tax of 25 % leaves the line 56.25 of the 75 fare, and the basis says the tax comes out of the whole fare', () => attempt(() => {
    const { result, fare, basis } = estimateOf(TAXED)

    return (close(provenance.valueOrNull(fare), 75) && close(provenance.valueOrNull(result), 56.25) && /less that tax/.test(basis) && /whole fare/.test(basis)) || `${provenance.valueOrNull(result)} ${basis}`
  }))
  add('Finances, computer-run empire: the same tax and fare leave 28.125, and the basis names the halving once', () => attempt(() => {
    const { result, basis } = estimateOf(TAXED_COMPUTER)

    return (close(provenance.valueOrNull(result), 28.125) && /half of what is left/.test(basis) && /whole fare/.test(basis)) || `${provenance.valueOrNull(result)} ${basis}`
  }))
  add('Finances: a save without the tax rate or the race kind gives no receipt, naming what is missing, while the fare keeps its figure', () => attempt(() => {
    const { result, fare, note } = estimateOf(NO_RATE)

    return (close(provenance.valueOrNull(fare), 75) && noFigure(result) && /shipping-line tax rate/.test(result.inputs.missing.join(' ')) && note === 'No amount paid to the line is estimated: the save does not hold the race\'s shipping-line tax rate and whether the race is a player\'s or computer-run.') || `${provenance.valueOrNull(result)} ${provenance.valueOrNull(fare)} ${note}`
  }))
  add('Finances: an unsupported version gives no fare and no receipt to a player or a computer-run empire, and the page names the missing rates', () => [NO_TAX, TAXED_COMPUTER].every((tax) => ['2.6.0', null].every((saveRules) => {
    const { result, fare, note } = estimateOf(tax, { saveRules })

    return noFigure(result) && noFigure(fare) && provenance.valueOrNull(result) === null && note === 'Not estimated: needs the civilian payout rates for the save\'s game version.'
  })))
  add('Finances: a field left empty gives no fare and no receipt, for a player and a computer-run empire', () => [NO_TAX, TAXED_COMPUTER].every((tax) => noFigure(estimateOf(tax, { tariffQuantity: '' }).result) && noFigure(estimateOf(tax, { tariffDistance: '' }).result) && noFigure(estimateOf(tax, { tariffQuantity: '' }).fare)))
  add('Finances: a race switch while the tax reread is pending gives no receipt and the words of the pending read, not the previous race\'s', () => attempt(() => {
    const state = financeStateOf(heldOf(TAXED), { loadErrors: { shippingTax: undefined }, RaceID: RACE.RaceID + 1 })
    const { result, note } = estimateOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && noFigure(result) && note === 'Reading the race\'s shipping-line tax, so no amount paid to the line is estimated yet.') || `${provenance.valueOrNull(result)} ${note}`
  }))
  add('Finances: a reread in flight for the race now shown gives no receipt, not the receipt of the value read before it', () => attempt(() => {
    const state = financeStateOf(heldOf(TAXED), { loadErrors: { shippingTax: undefined } })
    const { result, note } = estimateOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && noFigure(result) && /^Reading the race's shipping-line tax/.test(note)) || `${provenance.valueOrNull(result)} ${note}`
  }))
  add('Finances: a race switch before the tax reread starts gives no receipt, not the previous race\'s', () => attempt(() => {
    const state = financeStateOf(heldOf(TAXED), { RaceID: RACE.RaceID + 1 })
    const { result, note } = estimateOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && noFigure(result) && /^Reading the race's shipping-line tax/.test(note)) || `${provenance.valueOrNull(result)} ${note}`
  }))
  add('Finances: another copy of the save with the same game and race gives no receipt until the tax is read again', () => attempt(() => {
    const state = financeStateOf(heldOf(TAXED), { $store: { state: { freshness: { generation: RACE.generation + 1 } } } })
    const { result, note } = estimateOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && noFigure(result) && /^Reading the race's shipping-line tax/.test(note)) || `${provenance.valueOrNull(result)} ${note}`
  }))
  add('Finances: a failed reread after a successful one names the failure and gives no receipt, not the old one', () => attempt(() => {
    const state = financeStateOf(heldOf(TAXED), { loadErrors: { shippingTax: 'locked' } })
    const { result, note } = estimateOf(TAXED, { shippingTaxState: state })

    return (state.failed !== '' && state.error === 'locked' && state.value === null && noFigure(result) && note === 'No amount paid to the line is estimated: the race\'s shipping-line tax could not be read (locked).') || `${provenance.valueOrNull(result)} ${note}`
  }))
  add('Finances: a successful reread for the race now shown gives the receipt of the value it read', () => attempt(() => {
    const state = financeStateOf(heldOf(TAXED_COMPUTER))
    const { result, basis, note } = estimateOf(TAXED_COMPUTER, { shippingTaxState: state })

    return (!state.loading && state.failed === '' && state.value === TAXED_COMPUTER && close(provenance.valueOrNull(result), 28.125) && /half of what is left/.test(basis) && !/Reading|could not be read|does not hold/.test(note)) || `${provenance.valueOrNull(result)} ${note}`
  }))
  add('Transport, player: with no tax set the note gives the fare as what the line is paid over a 1.3 bn km route', () => attempt(() => {
    const note = noteOf(NO_TAX)

    return (note && /Colonist 0\.00015 a unit per billion km, 0\.000195 a unit over the route/.test(note.text) && /Passenger 0\.006 a unit per billion km, 0\.0078 a unit over the route/.test(note.text) && /no shipping-line tax set/.test(note.text) && !/computer-run/.test(note.text) && close(provenance.valueOrNull(note.result), 0.000195)) || (note ? note.text : 'no note')
  }))
  add('Transport, player: with a tax of 25 % the note gives the receipt, the fare less the tax, and names the tax', () => attempt(() => {
    const note = noteOf(TAXED)
    const paid = tariff.amountText(0.00015 * 1.3 * 0.75)

    return (note && /shipping-line tax of 25 % taken out of the fare/.test(note.text) && note.text.includes(`, ${paid} a unit over the route`) && /as the fare less that tax/.test(note.text) && close(provenance.valueOrNull(note.result), 0.00015 * 1.3 * 0.75)) || (note ? note.text : 'no note')
  }))
  add('Transport, computer-run empire: the receipt is halved once after the tax, and the note names the halving', () => attempt(() => {
    const note = noteOf(TAXED_COMPUTER)
    const paid = tariff.amountText(0.00015 * 1.3 * 0.75 * 0.5)

    return (note && note.text.includes(paid) && /paid half of what is left/.test(note.text) && /as the fare less that tax, halved/.test(note.text) && close(provenance.valueOrNull(note.result), 0.00015 * 1.3 * 0.75 * 0.5)) || (note ? note.text : 'no note')
  }))
  add('Transport, computer-run empire over routes of two lengths: the low and the high receipts are both halved after the tax', () => attempt(() => {
    const note = noteOf(TAXED_COMPUTER, { civilianRuns: [{ status: 'ok', km: 1e9 }, { status: 'ok', km: 3e9 }] })
    const low = tariff.amountText(0.00015 * 0.75 * 0.5)
    const high = tariff.amountText(0.00015 * 3 * 0.75 * 0.5)

    return (note && note.text.includes(`${low}–${high}`)) || (note ? note.text : 'no note')
  }))
  add('Transport: an unread tax gives no amount paid to the line, naming what is missing, and a pending or failed read says so', () => attempt(() => {
    const noRate = { rate: null, missing: 'the race\'s shipping line tax', npr: null }
    const missing = noteOf(noRate, { shippingTaxState: taxStateOf(heldOf(noRate)) })
    const failed = noteOf(TAXED, { shippingTaxState: taxStateOf(heldOf(TAXED), { loadErrors: { shippingTax: 'locked' } }) })
    const loading = noteOf(TAXED, { shippingTaxState: taxStateOf(heldOf(TAXED), { loadErrors: { shippingTax: undefined } }) })

    return (missing && /does not hold the race's shipping-line tax rate/.test(missing.text) && noFigure(missing.result) && failed && /could not be read \(locked\)/.test(failed.text) && noFigure(failed.result) && loading && /^Reading the race's shipping-line tax/.test(loading.text) && noFigure(loading.result)) || [missing ? missing.text : 'no note', failed ? failed.text : 'no note', loading ? loading.text : 'no note'].join(' | ')
  }))
  add('Transport: a race switch while the tax reread is pending gives no amount, not the previous race\'s receipt', () => attempt(() => {
    const state = taxStateOf(heldOf(TAXED), { loadErrors: { shippingTax: undefined }, RaceID: RACE.RaceID + 1 })
    const note = noteOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && note && /^Reading the race's shipping-line tax/.test(note.text) && noFigure(note.result)) || (note ? note.text : 'no note')
  }))
  add('Transport: a reread in flight for the race now shown gives no amount, not the receipt of the value read before it', () => attempt(() => {
    const state = taxStateOf(heldOf(TAXED), { loadErrors: { shippingTax: undefined } })
    const note = noteOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && note && /^Reading the race's shipping-line tax/.test(note.text) && noFigure(note.result)) || (note ? note.text : 'no note')
  }))
  add('Transport: a race switch before the tax reread starts gives no amount, not the previous race\'s receipt', () => attempt(() => {
    const state = taxStateOf(heldOf(TAXED), { RaceID: RACE.RaceID + 1 })
    const note = noteOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && note && /^Reading the race's shipping-line tax/.test(note.text) && noFigure(note.result)) || (note ? note.text : 'no note')
  }))
  add('Transport: another copy of the save with the same game and race gives no amount until the tax is read again', () => attempt(() => {
    const state = taxStateOf(heldOf(TAXED), { $store: { state: { freshness: { generation: RACE.generation + 1 } } } })
    const note = noteOf(TAXED, { shippingTaxState: state })

    return (state.loading && state.value === null && note && /^Reading the race's shipping-line tax/.test(note.text) && noFigure(note.result)) || (note ? note.text : 'no note')
  }))
  add('Transport: a failed reread after a successful one names the failure and gives no amount, not the old receipt', () => attempt(() => {
    const state = taxStateOf(heldOf(TAXED), { loadErrors: { shippingTax: 'locked' } })
    const note = noteOf(TAXED, { shippingTaxState: state })

    return (state.failed && state.error === 'locked' && state.value === null && note && /could not be read \(locked\)/.test(note.text) && noFigure(note.result)) || (note ? note.text : 'no note')
  }))
  add('Transport: a successful reread for the race now shown gives the receipt of the value it read', () => attempt(() => {
    const state = taxStateOf(heldOf(TAXED_COMPUTER))
    const note = noteOf(TAXED_COMPUTER, { shippingTaxState: state })
    const paid = tariff.amountText(0.00015 * 1.3 * 0.75 * 0.5)

    return (!state.loading && !state.failed && state.value === TAXED_COMPUTER && note && note.text.includes(paid) && /paid half of what is left/.test(note.text) && close(provenance.valueOrNull(note.result), 0.00015 * 1.3 * 0.75 * 0.5)) || (note ? note.text : 'no note')
  }))
  add('Transport: an unsupported version or no route gives the limitation and no figure, for a player and a computer-run empire', () => attempt(() => [NO_TAX, TAXED_COMPUTER].every((tax) => {
    const version = noteOf(tax, { formulaVersion: '2.6.0' })
    const route = noteOf(tax, { civilianRuns: [{ status: 'noroute', km: 5e9 }] })

    return /game version has no published payout rates/.test(version.text) && noFigure(version.result) && /no shipping line ship has a route/.test(route.text) && noFigure(route.result)
  })))
  add('Transport: no note while shipping lines are off or no destination is picked', () => attempt(() => noteOf(NO_TAX, { CivilianShippingLinesActive: false }) === null && noteOf(TAXED_COMPUTER, { destination: null }) === null))

  return all
}

// A copy of the utilities folder in the temp folder in which `file` has the first occurrence of `from` replaced by `to`.
const mutatedCopy = (file, from, to) => {
  refusePlanting(`${file}: ${from}`)

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

// TFIN-03 catalog audit: utility/page indices and mapped checks are unchanged; replacements do not prove retired operators.
// [utility:21] Old: "an unknown rate falls through to a figure"; new: "an unknown rate is estimated as zero".
// Removing the original null-rate guard sends null to ofRule at civilian-tariff.js:88, which throws before a figure returns.
// Replacement class: an unpublished rate becomes a finite zero estimate. Original null-input guard-removal class currently has no credited fault.
// [utility:40] Old: "a use with nothing logged is not counted as 0"; new: "an absent shipping total is estimated as one".
// Removing the original absent-total default produces NaN, rejected at civilian-tariff.js:129-131 before net cost returns.
// Replacement class: missing usage becomes one unit and a wrong finite net cost. Original NaN-producing guard-removal class currently has no credited fault.

const MUTATIONS = [
  ['the colonist rate is the 2.6 one', 'unit: \'colonist\', rate: 0.00015', 'unit: \'colonist\', rate: 0.0001', ['colonist: 2000']],
  ['the passenger rate is the 2.6 one', 'unit: \'passenger\', rate: 0.006', 'unit: \'passenger\', rate: 0.004', ['passenger: 500']],
  ['the trade good rate is the 2.6 one', 'unit: \'trade good\', rate: 0.375', 'unit: \'trade good\', rate: 0.25', ['trade good: 10']],
  ['the cargo point rate is the 2.6 one', 'unit: \'cargo point\', rate: 0.00015', 'unit: \'cargo point\', rate: 0.0001', ['cargo point: 25000']],
  ['fuel is given a rate nothing publishes', 'unit: \'litre\', rate: null', 'unit: \'litre\', rate: 0.00015', ['fuel has no published rate']],
  ['the distance is converted with a million, not a billion', 'KM_PER_BILLION = 1e9', 'KM_PER_BILLION = 1e6', ['a route of 12.5e9 km']],
  ['a route in km is priced as billion km without conversion', 'fare: payoutEstimate({ version, category: category.id, quantity: 1, billionKm: billionKm(km) })', 'fare: payoutEstimate({ version, category: category.id, quantity: 1, billionKm: km })', ['one unit over a measured route']],
  ['the receipt is priced with the distance unconverted too', 'receipt: receiptEstimate({ version, category: category.id, quantity: 1, billionKm: billionKm(km), taxRate, npr })', 'receipt: receiptEstimate({ version, category: category.id, quantity: 1, billionKm: km, taxRate, npr })', ['the rows carry the fare and the receipt apart']],
  ['the computer-run modifier is 1, as for a player', 'NPR_PAYOUT_MODIFIER = 0.5', 'NPR_PAYOUT_MODIFIER = 1', ['receipt: a computer-run empire\'s line is paid half']],
  ['the computer-run modifier is the 1.5 of 2.6', 'NPR_PAYOUT_MODIFIER = 0.5', 'NPR_PAYOUT_MODIFIER = 1.5', ['receipt: a computer-run empire\'s line is paid half']],
  ['the computer-run modifier is 0.75, the effective figure rather than the one set', 'NPR_PAYOUT_MODIFIER = 0.5', 'NPR_PAYOUT_MODIFIER = 0.75', ['receipt: a computer-run empire\'s line is paid half']],
  ['the modifier is never applied', 'modifier: npr ? NPR_PAYOUT_MODIFIER : 1', 'modifier: 1', ['receipt: a computer-run empire\'s line is paid half']],
  ['the modifier is applied to a player and not to a computer-run empire', 'modifier: npr ? NPR_PAYOUT_MODIFIER : 1', 'modifier: npr ? 1 : NPR_PAYOUT_MODIFIER', ['receipt: no tax leaves the whole fare']],
  ['the modifier is applied to both kinds of race', 'modifier: npr ? NPR_PAYOUT_MODIFIER : 1', 'modifier: NPR_PAYOUT_MODIFIER', ['receipt: no tax leaves the whole fare']],
  ['the receipt is the fare, the tax never taken out', 'export const receiptOf = (fare, { taxRate, modifier = 1 }) => fare * (1 - taxRate) * modifier', 'export const receiptOf = (fare, { taxRate, modifier = 1 }) => fare * modifier', ['receipt: a player\'s line is paid the fare less']],
  ['the tax is taken out twice', 'fare * (1 - taxRate) * modifier', 'fare * (1 - taxRate) * (1 - taxRate) * modifier', ['receipt: a player\'s line is paid the fare less']],
  ['the halving is applied twice for a computer-run empire', 'modifier: npr ? NPR_PAYOUT_MODIFIER : 1', 'modifier: npr ? NPR_PAYOUT_MODIFIER * NPR_PAYOUT_MODIFIER : 1', ['receipt: a computer-run empire\'s line is paid half']],
  ['an unknown race kind is priced as a player\'s', 'typeof npr === \'boolean\' ? [] :', 'true ? [] :', ['receipt: a race kind that is not true or false']],
  ['the rows leave the race kind out of the receipt', 'billionKm: billionKm(km), taxRate, npr })', 'billionKm: billionKm(km), taxRate, npr: false })', ['the rows carry the fare and the receipt apart']],
  ['the result no longer names the modifier it applied', 'npr ? \'the published computer-run modifier of 0.5\' : \'a player\\\'s race, paid all of the fare left after the tax\'', '\'the published rate\'', ['receipt: a result is estimated']],
  ['the rates themselves are halved for a computer-run empire', 'value: category.rate, inputs', 'value: category.rate * 0.5, inputs', ['the rates are the published ones']],
  ['the payout rows price two units', 'quantity: 1, billionKm', 'quantity: 2, billionKm', ['one unit over a measured route']],
  ['the rates are given to every game version', 'if (ruleSupports(\'civilianTariff.rates\', version) !== true) {', 'if (false) {', ['unsupported game version null']],
  ['the rules hold for any 3.x version', 'const TARIFF_VERSIONS = [\'3.2.x\']', 'const TARIFF_VERSIONS = [\'3.x\']', ['the rules are registered with the stated line\'s version']],
  ['the rules hold for another line as well', 'const TARIFF_VERSIONS = [\'3.2.x\']', 'const TARIFF_VERSIONS = [\'3.2.x\', \'3.0.x\']', ['the rules are registered with the stated line\'s version']],
  ['an unknown rate is estimated as zero', 'if (!category || category.rate === null) {', "if (category && category.rate === null) {\n    return ofRule({ rule: 'civilianTariff.rates', value: 0, inputs: { present: ['an assumed rate'] } })\n  }\n\n  if (!category || category.rate === null) {", ['fuel has no published rate']],
  ['an unavailable rate no longer stops the estimate', 'if (!isAvailable(rate)) {', 'if (false) {', ['unsupported game version null']],
  ['the quantity is not checked', 'finite(quantity) && quantity >= 0', 'true', ['a quantity that is not a number']],
  ['a negative quantity is allowed', 'finite(quantity) && quantity >= 0', 'finite(quantity)', ['a quantity that is not a number']],
  ['the distance is not checked', 'finite(distance) && distance >= 0', 'true', ['a distance that is not a number of 0']],
  ['the payout adds the distance instead of multiplying', 'quantity * rate.value * distance', 'quantity * rate.value + distance', ['trade good: 10']],
  ['the payout leaves the quantity out', 'quantity * rate.value * distance', 'rate.value * distance', ['trade good: 10']],
  ['the rate is called confirmed', 'verification: \'estimated\',\n  structure: [\'the published payout rates by category\']', 'verification: \'confirmed\',\n  structure: [\'the published payout rates by category\']', ['a result is estimated']],
  ['the payout rule is called confirmed', 'verification: \'estimated\',\n  structure: [\'civilianTariff.rates\', \'the route distance\']', 'verification: \'confirmed\',\n  structure: [\'civilianTariff.rates\', \'the route distance\']', ['a result is estimated']],
  ['the payout rule drops its assumptions', 'assumptions: [\'every unit is carried the whole distance\', \'the distance is the route travelled loaded\'],', '', ['a result is estimated']],
  ['the receipt is called confirmed', "verification: 'estimated',\n  structure: ['civilianTariff.payout', 'the race\\'s shipping-line tax', 'the race\\'s kind']", "verification: 'confirmed',\n  structure: ['civilianTariff.payout', 'the race\\'s shipping-line tax', 'the race\\'s kind']", ['receipt: a result is estimated']],
  ['the receipt rule drops its assumption', "assumptions: ['the shipping-line tax rate set now held for the trip'],", '', ['receipt: a result is estimated']],
  ['a receipt tax rate above 1 is accepted', 'finite(taxRate) && taxRate >= 0 && taxRate <= 1', 'finite(taxRate) && taxRate >= 0', ['receipt: a tax rate that is not a share']],
  ['a negative receipt tax rate is a tax rate', 'finite(taxRate) && taxRate >= 0 && taxRate <= 1', 'finite(taxRate) && taxRate <= 1', ['receipt: a tax rate that is not a share']],
  ['a mapping is always complete', 'complete: !unplaced.length && uses.some((use) => use.role === \'payout\')', 'complete: true', ['a mapping missing one use']],
  ['a mapping needs no use that carries the payout', 'uses.some((use) => use.role === \'payout\')', 'true', ['a mapping with no use that carries the payout']],
  ['a mapping ignores an unplaced use', '!unplaced.length &&', 'true &&', ['a mapping missing one use']],
  ['an unknown role counts as placed', 'const unplaced = uses.filter((use) => !ROLES.includes(use.role))', 'const unplaced = uses.filter((use) => use.role === undefined)', ['an empty table and an unknown role']],
  ['every shipped use starts as a payout', 'Object.freeze({ ...use, role: null })', 'Object.freeze({ ...use, role: \'payout\' })', ['the shipped table places no use against a payout']],
  ['the net cost no longer waits for a complete mapping', '} else if (!mapping.complete) {', '} else if (false) {', ['incomplete mapping: no net cost']],
  ['the net cost holds for every version', 'if (ruleSupports(\'civilianTariff.netCost\', version) !== true) {', 'if (false) {', ['a fully placed mapping still gives no net cost']],
  ['the net cost adds the taxes', 'sum(\'payout\') - sum(\'tax\')', 'sum(\'payout\') + sum(\'tax\')', ['a fully placed mapping gives the logged payout']],
  ['the net cost leaves the taxes out', 'sum(\'payout\') - sum(\'tax\')', 'sum(\'payout\')', ['a fully placed mapping gives the logged payout']],
  ['an absent shipping total is estimated as one', '(totals[use.id] || 0)', '(totals[use.id] || 1)', ['a fully placed mapping counts a use with nothing logged']],
  ['the Civilian Contracts use is missing', '  { id: 44, label: \'Civilian Contracts\', side: \'spending\' },\n', '', ['the civilian uses are the expected ids']],
  ['a tax use is on the spending side', '{ id: 32, label: \'Tax on Shipping Trade Goods\', side: \'income\' }', '{ id: 32, label: \'Tax on Shipping Trade Goods\', side: \'spending\' }', ['the civilian uses are the expected ids']],
  ['civilian mining is counted as a shipping use', '  { id: 47, label: \'Tax on Civilian Fuel\', side: \'income\' },\n', '  { id: 47, label: \'Tax on Civilian Fuel\', side: \'income\' },\n  { id: 35, label: \'Tax on Civilian Mining\', side: \'income\' },\n', ['the civilian uses are the expected ids']],
  ['the civilian categories take the uses of the ledger in the ledger\'s order and keep the others', 'uses.map((use) => categories.find((category) => category.id === use.id)).filter(Boolean)', 'categories', ['the ledger the Finances page builds lists']],
  ['a small figure is rounded to a whole number', 'Number(value.toPrecision(4)).toFixed(12)', 'Math.round(value).toFixed(12)', ['figures read as text:']],
  ['the separator is dropped from a large figure', 'countText(value, 0, separator)', 'countText(value, 0)', ['figures read as text:']],
  ['the version text claims rates for any version', "ruleSupports('civilianTariff.rates', version) === true ? 'Published payout rates'", "ruleSupports('civilianTariff.rates', version) !== true ? 'Published payout rates'", ['the version text says rates']],
]

const PAGE_MUTATIONS = [
  ['Finances feeds a fixed version of the line to the estimate', 'finances', 'payoutEstimate({ version: this.saveRules,', 'payoutEstimate({ version: \'3.2.0\',', ['Finances: an unsupported version gives no fare']],
  ['Finances reads the rates for a fixed version of the line', 'finances', 'rateOf(this.saveRules, category.id)', 'rateOf(\'3.2.0\', category.id)', ['Finances: the rates, the fare, the receipt and the net cost take']],
  ['Finances asks the net cost for a fixed version of the line', 'finances', 'netCostResult({ version: this.saveRules,', 'netCostResult({ version: \'3.2.0\',', ['Finances: the rates, the fare, the receipt and the net cost take']],
  ['Finances builds its own complete mapping', 'finances', 'const TARIFF_MAPPING = treasuryMapping()', 'const TARIFF_MAPPING = { complete: true, uses: [], unplaced: [] }', ['Finances: the net cost is asked of the mapping']],
  ['Finances loses the summary of the panel', 'finances', 'data-summary="Estimate civilian shipping-line payouts', 'data-x="Estimate civilian shipping-line payouts', ['Finances: the panel has a data-summary']],
  ['Finances shows a net cost figure while it is unavailable', 'finances', 'netCost.value === null ? \'—\' : signed(netCost.value)', 'signed(netCost.value)', ['Finances: the net cost line shows a dash']],
  ['Finances stops reading the schema version', 'finances', 'return await loadFormulaResult(this.database)', 'return { value: \'3.2.x\', status: \'assumed\', inputs: { present: [], missing: [] } }', ['Finances: the formula version is read']],
  ['Finances lists the rate table while the rates are unavailable', 'finances', 'v-if="!tariffGap"', 'v-if="true"', ['Finances: the rate table gives way']],
  // eslint-disable-next-line no-template-curly-in-string
  ['Finances states the gap without naming the read', 'finances', 'and ${missing.join(\', \')} ${missing.length === 1 ? \'is\' : \'are\'} not in it', 'and the schema is incomplete', ['Finances: the statement is null']],
  ['Finances speaks to the reader', 'finances', 'Units carried times the rate times the one-way', 'Your units carried times the rate times the one-way', ['the new text speaks in no first or second person']],
  ['Transport prices the route for a fixed version of another line', 'information', 'payoutRows({ version, km, taxRate, npr })', 'payoutRows({ version: \'3.0.x\', km, taxRate, npr })', ['Transport: the payout note prices the measured route']],
  ['Finances leaves the saved tax out of the receipt', 'finances', 'taxRate: shippingTax ? shippingTax.rate : null', 'taxRate: 0', ['Finances, player: a tax of 25 %']],
  ['Finances reads the race kind as always a player\'s', 'finances', 'npr: shippingTax ? shippingTax.npr : null', 'npr: false', ['Finances, computer-run empire']],
  ['Finances takes the tax and kind from the read directly, not from the state settled for the race shown', 'finances', 'const shippingTax = this.shippingTaxState.value', 'const shippingTax = this.shippingTax && this.shippingTax.value', ['Finances: a race switch before the tax reread starts', 'Finances: another copy of the save with the same game and race', 'Finances: a failed reread after a successful one']],
  ['Finances keeps the previous race\'s tax through the switch', 'finances', 'const current = held && held.GameID === this.GameID && held.RaceID === this.RaceID && held.generation === generation', 'const current = !!held', ['Finances: a race switch before the tax reread starts', 'Finances: another copy of the save with the same game and race']],
  ['Finances shows the receipt where the fare belongs', 'finances', 'amountText(fare.value)', 'amountText(estimate.value)', ['Finances: the fare and the receipt are shown apart']],
  ['Finances loses the halving note of a computer-run empire', 'finances', 'paid half of what is left', 'paid the rest', ['Finances, computer-run empire']],
  ['Finances calls the fare the line\'s receipt', 'finances', 'receipt is the fare less that tax', 'receipt is the whole fare', ['Finances, player: a tax of 25 %']],
  ['Finances loses the one-way loaded label of the distance field', 'finances', 'label="One-way loaded distance, billion km"', 'label="Distance, billion km"', ['Finances: the panel names the one-way loaded distance']],
  ['Finances loses the one-way loaded aria label of the distance field', 'finances', 'aria-label="One-way loaded distance in billion km"', 'aria-label="Distance in billion km"', ['Finances: the panel names the one-way loaded distance']],
  ['Finances loses the one-way loaded basis of the estimate', 'finances', 'one-way loaded route distance in billion km, with every unit carried the whole leg', 'route distance in billion km', ['Finances, player:']],
  ['Finances no longer says the units are carried the whole leg', 'finances', ', with every unit carried the whole leg', '', ['Finances, player:']],
  ['Transport leaves the saved tax out of the note', 'information', 'const taxRate = shippingTax ? shippingTax.rate : null', 'const taxRate = 0', ['Transport, player: with a tax of 25 %']],
  ['Transport leaves the saved race kind out of the note', 'information', 'const npr = shippingTax ? shippingTax.npr : null', 'const npr = false', ['Transport, computer-run empire: the receipt is halved']],
  ['Transport shows the fare as what the line is paid', 'information', 'const low = row.receipt.value', 'const low = row.fare.value', ['Transport, player: with a tax of 25 %']],
  ['Transport falls back on the selection flag for the race kind', 'information', 'const npr = shippingTax ? shippingTax.npr : null', 'const npr = !!this.RaceNPR', ['neither page takes the race kind']],
  ['Transport ignores a failed tax read', 'information', 'typeof read === \'string\'', 'false', ['Transport: an unread tax']],
  ['Transport keeps the previous race\'s tax through the switch', 'information', 'const current = held && held.GameID === this.GameID && held.RaceID === this.RaceID && held.generation === generation', 'const current = !!held', ['Transport: a race switch before the tax reread starts', 'Transport: another copy of the save with the same game and race']],
  ['Transport keeps the previous receipt while the tax reread is in flight', 'information', 'read === null && current ?', 'current ?', ['Transport: a reread in flight for the race now shown']],
  ['Transport leaves out the limitation for a version without rates', 'information', 'game version has no published payout rates', 'game version has rates', ['Transport: the note says no payout is estimated']],
  ['Transport drops the provenance mark of the note', 'information', '<provenance-mark :result="payoutNote.result" label />', '', ['Transport: the note is a panel foot']],
  ['Transport claims the payout as the race\'s cost', 'information', 'no cost to the race is claimed', 'it is the race\'s cost', ['Transport: the note says the payout goes']],
]

// Credit only the declared checks' returned values; an exception while obtaining the values cannot enter this path.
const caughtValues = async (results, fails, name) => {
  const named = results.filter(([statement]) => fails.some((start) => statement.startsWith(start)))
  const absent = fails.filter((start) => !named.some(([statement]) => statement.startsWith(start)))

  if (absent.length) {
    throw new Error(`${name}: no check begins ${absent.join('; ')}`)
  }

  const failed = judged(await runChecks(named.map(([id, held]) => ({ id, name: id, run: () => assert.ok(held === true, typeof held === 'string' ? held : `${id} returned ${held}`) })), {}), name)

  if (process.argv.includes('--detail')) {
    failed.forEach(({ id, detail }) => console.log(`CAUGHT ${name} by ${id}: ${detail}`))
  }

  return fails.every((start) => caughtBy(failed, named.filter(([id]) => id.startsWith(start)).map(([id]) => id), { name }))
}

const parseArguments = (argv) => {
  const options = { saves: [] }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options.saves.push([argv[index].slice(2), [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]])
      index += 3
    } else if (argv[index].startsWith('--only=')) {
      options.only = argv[index].slice('--only='.length).split('|').filter(Boolean)
    } else if (argv[index] === '--no-mutations' || argv[index] === '--detail') {
      continue
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return { ...options, saves: options.saves.length ? options.saves : [['fixture', fixtureTriple()]] }
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
      close: () => new Promise((resolve) => raw.close(() => resolve())),
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
  const net = tariff.netCostResult({ version: '3.2.x', mapping: tariff.treasuryMapping(), totals })

  check(`${label}: the net cost is unavailable on the logged amounts`, !provenance.isAvailable(net) && valueOrNull(net) === null)

  rows.forEach((row) => console.log(`  ${row.id} ${row.label} (${row.income ? 'income' : 'spending'}): ${row.total} in the last year`))

  database.close()
}

// ---------- the planted tariff case ----------

// The planted figures, worked by hand from the published rates: a trip of 20 000 cargo points over 4 billion km is charged 20 000 * 0.00015 * 4 = 12 at the published rate; the race takes its tax of 25 % (3) and pays the line the other 9, or half of that (4.5) for a computer-run empire. The log books the receipt under Civilian Contracts, the tax under the shipping tax use, and 100 of income from a civilian fuel sale under the fuel use, which is not a shipping tax. The yearly figures are the logged amounts scaled to a year by the window's coverage, the scaling the Finances ledger applies to every use.
const PLANTED = Object.freeze({ rate: 0.00015, quantity: 20000, billionKm: 4, fare: 12, tax: 0.25, receipt: 9, nprReceipt: 4.5, taxAmount: 3, fuel: 100 })

const runRaw = (raw, sql, replacements = []) => new Promise((resolve, reject) => raw.run(sql, replacements, (error) => (error ? reject(error) : resolve())))

// A copy of the save with the planted case written into one race: its shipping-line tax set to 25 % and its kind set by `npr`, one Civilian Contracts row with the receipt of a 12 fare, one tax row with the 3 taken from it, and one civilian fuel sale row of 100, all at the save's game time.
const plantCase = async (file, GameID, RaceID, npr) => {
  const source = path.resolve(root, file)
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-tariff-planted-')), path.basename(file))
  const receipt = npr ? PLANTED.nprReceipt : PLANTED.receipt

  fs.copyFileSync(source, copy)

  const sqlite3 = require('sqlite3')
  const raw = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(copy, (error) => (error ? reject(error) : resolve(database)))
  })

  try {
    const [game] = (await new Promise((resolve, reject) => raw.all(`select GameTime from FCT_Game where GameID = ${Number(GameID)}`, (error, rows) => (error ? reject(error) : resolve(rows)))))
    await runRaw(raw, `update FCT_Race set ShippingLineTax = ${PLANTED.tax}, NPR = ${npr ? 1 : 0} where GameID = ${Number(GameID)} and RaceID = ${Number(RaceID)}`)
    await runRaw(raw, `insert into FCT_WealthData (GameID, RaceID, UseID, TimeUsed, Amount) values (${Number(GameID)}, ${Number(RaceID)}, 44, ${game.GameTime}, ${receipt})`)
    await runRaw(raw, `insert into FCT_WealthData (GameID, RaceID, UseID, TimeUsed, Amount) values (${Number(GameID)}, ${Number(RaceID)}, 32, ${game.GameTime}, ${PLANTED.taxAmount})`)
    await runRaw(raw, `insert into FCT_WealthData (GameID, RaceID, UseID, TimeUsed, Amount) values (${Number(GameID)}, ${Number(RaceID)}, 47, ${game.GameTime}, ${PLANTED.fuel})`)
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }

  return copy
}

// Whether the save holds a shipping line of the game, and the wealth use table the case rests on: a save without them gets the case reported as not run.
const caseHolds = async (database, GameID) => {
  const [line] = await database.query(`select count(*) as lines from FCT_ShippingLines where GameID = ${Number(GameID)}`)
  const uses = await database.query('select WealthUseID, Description, Income from DIM_WealthUse where WealthUseID in (32, 44, 47)')

  return { lines: line ? line.lines : 0, uses: uses.length === 3 }
}

const plantedRuns = async (label, copy, [, GameID, RaceID], npr, { tariff, provenance, finances, runway }) => {
  const { valueOrNull } = provenance
  const planted = await openSave(copy)
  const receipt = npr ? PLANTED.nprReceipt : PLANTED.receipt
  const kind = npr ? 0.5 : 1

  try {
    const [game] = await planted.query('select GameTime, StartYear from FCT_Game where GameID = ?', [GameID])
    const [race] = await planted.query('select WealthPoints, AnnualWealth, ShippingLineTax, NPR from FCT_Race where GameID = ? and RaceID = ?', [GameID, RaceID])
    const wealth = await planted.query('select FCT_WealthData.UseID, coalesce(DIM_WealthUse.Description, \'Unknown (\' || FCT_WealthData.UseID || \')\') as Description, DIM_WealthUse.Income as Income, DIM_WealthUse.DisplayOrder, FCT_WealthData.TimeUsed, sum(FCT_WealthData.Amount) as Amount from FCT_WealthData left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID where FCT_WealthData.GameID = ? and FCT_WealthData.RaceID = ? group by FCT_WealthData.UseID, FCT_WealthData.TimeUsed', [GameID, RaceID])
    const ledger = finances.buildLedger({ treasury: { ...race, ...game }, wealth, windowDays: 365 })
    const scale = valueOrNull(ledger.coverage) === null ? null : 365 / valueOrNull(ledger.coverage)
    const flows = runway.civilianFlows(ledger)
    const tax = { rate: race.ShippingLineTax, missing: '', npr: race.NPR !== 0 }
    const inputs = { horizon: 25, futureTax: '25', pauseYears: '', governmentCost: '', planStart: '0', lines: [{ category: 'cargoPoint', quantity: String(PLANTED.quantity), distance: String(PLANTED.billionKm), perYear: '1' }] }
    const built = runway.buildScenarios({ ledger, version: '3.2.x', npr: race.NPR !== 0, tax, inputs })
    const before = `${label}${npr ? ' (computer-run)' : ' (player)'}`

    check(`${before}: the planted tax rate and race kind are read as stored, 25 % and ${npr ? 'computer-run' : 'a player'}`, race.ShippingLineTax === PLANTED.tax && (race.NPR !== 0) === npr ? true : `${race.ShippingLineTax} ${race.NPR}`)
    check(`${before}: the logged receipt and tax are the two amounts written, ${receipt} and ${PLANTED.taxAmount}, scaled to a year by the window`, scale !== null && close(valueOrNull(flows.contracts), receipt * scale) && close(valueOrNull(flows.contractTax), PLANTED.taxAmount * scale) ? true : `${valueOrNull(flows.contracts)} ${valueOrNull(flows.contractTax)} at ${scale}`)
    check(`${before}: the logged fuel sale of ${PLANTED.fuel} is its own income, no part of the ${PLANTED.taxAmount} of shipping tax`, scale !== null && close(valueOrNull(flows.fuel), PLANTED.fuel * scale) && close(valueOrNull(flows.taxes), PLANTED.taxAmount * scale) ? true : `fuel ${valueOrNull(flows.fuel)}, taxes ${valueOrNull(flows.taxes)} at ${scale}`)
    check(`${before}: a fare of ${PLANTED.fare} at the published cargo-point rate over 4 billion km is priced ${PLANTED.fare}`, close(valueOrNull(tariff.payoutEstimate({ version: '3.2.x', category: 'cargoPoint', quantity: PLANTED.quantity, billionKm: PLANTED.billionKm })), PLANTED.fare) && close(valueOrNull(tariff.rateOf('3.2.x', 'cargoPoint')), PLANTED.rate))
    check(`${before}: the receipt estimate of that fare at 25 % is ${receipt}`, close(valueOrNull(tariff.receiptEstimate({ version: '3.2.x', category: 'cargoPoint', quantity: PLANTED.quantity, billionKm: PLANTED.billionKm, taxRate: PLANTED.tax, npr })), receipt) ? true : `${valueOrNull(tariff.receiptEstimate({ version: '3.2.x', category: 'cargoPoint', quantity: PLANTED.quantity, billionKm: PLANTED.billionKm, taxRate: PLANTED.tax, npr }))}`)
    check(`${before}: the window's receipt and tax invert to the fare, ${PLANTED.fare} a year for every year of the window`, close(valueOrNull(built.pieces.gross), PLANTED.fare * scale) ? true : `${valueOrNull(built.pieces.gross)} against ${PLANTED.fare * scale}`)
    check(`${before}: the tax paired with that fare is a quarter of it (3), and the break-even is the receipt less it (${receipt - PLANTED.taxAmount})`, close(valueOrNull(built.pieces.pairedTax), PLANTED.taxAmount * scale) && close(valueOrNull(built.breakEven), (receipt - PLANTED.taxAmount) * scale) ? true : `${valueOrNull(built.pieces.pairedTax)} ${valueOrNull(built.breakEven)}`)
    check(`${before}: one new contract a year is the fare's tax less the receipt: 12 * 0.25 - 12 * ${kind} * 0.75 = ${PLANTED.fare * PLANTED.tax - PLANTED.fare * kind * (1 - PLANTED.tax)}`, close(valueOrNull(built.effect), PLANTED.fare * PLANTED.tax - PLANTED.fare * kind * (1 - PLANTED.tax)) ? true : `${valueOrNull(built.effect)}`)
  } finally {
    await planted.close()
  }
}

const plantedCase = async (label, [file, GameID, RaceID], mods) => {
  const database = await openSave(file)

  if (!database) {
    console.log(`SKIP  the planted case: ${file} is not there`)

    return
  }

  const holds = await caseHolds(database, GameID)

  database.close()

  if (!holds.lines || !holds.uses) {
    console.log(`SKIP  the planted case: ${file} holds ${holds.lines} shipping lines and ${holds.uses ? 'the' : 'no'} Civilian Contracts, tax and fuel uses`)

    return
  }

  console.log(`\n${label} save, planted tariff case: ${file} (game ${GameID}, race ${RaceID})`)

  const copies = [await plantCase(file, GameID, RaceID, false), await plantCase(file, GameID, RaceID, true)]

  try {
    await plantedRuns(label, copies[0], [file, GameID, RaceID], false, mods)
    await plantedRuns(label, copies[1], [file, GameID, RaceID], true, mods)
  } finally {
    copies.forEach((copy) => {
      fs.unlinkSync(copy)
      fs.rmdirSync(path.dirname(copy))
    })
  }
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const utilities = await loadUtilities(MODULES)
  const mods = { tariff: utilities['civilian-tariff'], provenance: utilities.provenance, finances: utilities.finances, runway: utilities['shipping-runway'], math: utilities.math }

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
  const pages = { finances: fs.readFileSync(path.join(pagesDirectory, 'finances.vue'), 'utf8'), information: fs.readFileSync(path.join(pagesDirectory, 'information.vue'), 'utf8'), utility, tariff: mods.tariff, provenance: mods.provenance, math: mods.math }

  for (const [name, held] of wiring(pages)) {
    check(name, held === true)
  }

  if (mutating()) {
    console.log('\nMutations: each must fail at least one check')

    for (const [label, from, to, fails] of MUTATIONS.filter(([name]) => !options.only || options.only.some((text) => name.includes(text)))) {
      let directory

      try {
        directory = mutatedCopy(FILE, from, to)

        const mutant = await loadUtilities(MODULES, { directory })
        const results = synthetic({ tariff: mutant['civilian-tariff'], provenance: mutant.provenance, finances: mutant.finances }).filter(([name]) => fails.some((prefix) => name.startsWith(prefix))).map(([name, test]) => [name, test()])
        const caught = await caughtValues(results, fails, label)

        check(`mutation caught: ${label}`, caught ? true : 'the named checks still pass', fails.join('; '))
      } catch (error) {
        check(`mutation caught: ${label}`, error.message)
      } finally {
        if (directory) {
          fs.rmSync(directory, { recursive: true, force: true })
        }
      }
    }

    for (const [label, page, from, to, fails] of PAGE_MUTATIONS.filter(([name]) => !options.only || options.only.some((text) => name.includes(text)))) {
      refusePlanting(label)
      const source = pages[page]

      if (!source.includes(from)) {
        check(`mutation caught: ${label}`, `the mutation does not apply: ${from}`)

        continue
      }

      try {
        const results = wiring({ ...pages, [page]: source.replace(from, () => to) })
        const caught = await caughtValues(results, fails, label)

        check(`mutation caught: ${label}`, caught ? true : 'the named checks still pass', fails.join('; '))
      } catch (error) {
        check(`mutation caught: ${label}`, error.message)
      }
    }
  }

  for (const [label, triple] of options.saves) {
    await compareSave(label, triple, mods)
  }

  for (const [label, triple] of options.saves) {
    await plantedCase(label, triple, mods)
  }

  if (options.saves.length === 1 && options.saves[0][0] === 'fixture') {
    await plantedCase('played', playedTriple(), mods)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
