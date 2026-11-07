/* Catalog adapters read declaration ASTs; neither a check script nor its replacement functions are imported. */
const path = require('path')
const { declarations, unknown, isUnknown, walk, normalize, property } = require('./affected-checks')

const catalogSuite = (source, suite, root, files) => {
  let data
  try { data = declarations(source, suite, root, files) } catch (error) { return { suite, variants: [], domain: [], unknownDomain: true, coverage: 'unknown', unknowns: [error.message] } }
  const get = data.valueOf
  const fileMap = data.bindings.has('FILES') ? get('FILES') : get('FILE')
  const knownMap = fileMap && !isUnknown(fileMap) && typeof fileMap === 'object' ? { ...fileMap } : {}
  // A loader can name the same target under a local mutation alias.
  walk(data.ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.name !== 'loadPage' || node.arguments[0]?.type !== 'Literal' || node.arguments[1]?.type !== 'ObjectExpression') return
    const mutate = node.arguments[1].properties.find((entry) => entry.key?.name === 'mutate')?.value
    if (mutate?.type === 'CallExpression' && mutate.callee.name === 'mutate' && mutate.arguments[0]?.type === 'Literal') knownMap[mutate.arguments[0].value] = 'src/renderer/' + node.arguments[0].value + '.vue'
  })
  if (path.posix.basename(suite) === 'check-world-tags.js' && typeof get('mixinFile') === 'string' && source.includes("target === 'mixin'")) knownMap.mixin = get('mixinFile')
  const implicitTargets = new Set()
  const targets = (value, seen = new Set()) => {
    if (Array.isArray(value)) return value.every((entry) => typeof entry === 'string' && targets(entry).length) ? [...new Set(value.flatMap((entry) => targets(entry)))] : []
    if (value === null || value === undefined) return [...implicitTargets]
    if (typeof value !== 'string') return []
    if (ownMap(value) && !seen.has(value)) {
      seen.add(value)
      return targets(knownMap[value], seen)
    }
    const relative = normalize(path.isAbsolute(value) ? path.relative(root, value) : value)
    if (relative.startsWith('../')) {
      const bases = ['RENDERER', 'renderer', 'rendererDirectory', 'utilitiesDirectory'].map(get).filter((entry) => typeof entry === 'string')
      return [...new Set(bases.map((base) => normalize(path.relative(root, path.join(base, value)))).filter((file) => files.includes(file)))]
    }
    if (files.includes(relative)) return [relative]
    for (const candidate of [relative + '.js', relative + '.vue', 'src/renderer/' + relative + '.js', 'src/renderer/' + relative + '.vue']) { if (files.includes(candidate)) return [candidate] }
    if (files.includes('src/renderer/' + relative)) return ['src/renderer/' + relative]
    if (files.includes('src/renderer/utilities/' + relative)) return ['src/renderer/utilities/' + relative]
    if (files.includes('src/renderer/utilities/' + relative + '.js')) return ['src/renderer/utilities/' + relative + '.js']
    return /\.(?:vue|js|mjs|json)$/.test(relative) ? files.filter((file) => path.posix.basename(file) === path.posix.basename(relative)) : []
  }
  const ownMap = (key) => Object.prototype.hasOwnProperty.call(knownMap, key)
  // Named source constants bound descriptors which rewrite an already-read source
  // without repeating its file name. Never recurse into replacement/prose strings.
  for (const name of data.bindings.keys()) {
    if (/(?:FAULT|MUTANT|MUTATION|BENIGN|REWRITE)/.test(name)) continue
    const value = get(name)
    if (typeof value !== 'string') continue
    const resolved = targets(value)
    if (!resolved.length) continue
    for (const alias of [name, name.toLowerCase(), name.replace(/(?:_FILE|File)$/, '').toLowerCase()]) if (!ownMap(alias)) knownMap[alias] = value
    resolved.forEach((file) => implicitTargets.add(file))
  }
  const patternTarget = (value) => typeof value === 'string' && value.length < 512 && !/[\r\n]/.test(value)
  const explicitPath = (value) => typeof value === 'string' && /(?:^|[\\/])[^\\/\r\n]+\.(?:js|mjs|vue|json)$/.test(value) && !/[ \t]/.test(value)
  const unsupportedChanges = new Set()
  const changes = (value) => {
    if (value === undefined) return []
    if (value && value.patches) return value.patches
    // Accept only a source parameter threaded through complete patch-factory applications.
    // Harvesting recognizable calls from an arbitrary body can silently omit another edit.
    const refuse = () => {
      unsupportedChanges.add('unsupported rewrite callback; complete source transformation is unresolved')
      return [{ from: unknown('unsupported rewrite callback'), count: 1 }]
    }
    if (!value || !value.lambda || value.lambda.params.length !== 1 || value.lambda.params[0].type !== 'Identifier') return refuse()
    const parameter = value.lambda.params[0].name
    let body = value.lambda.body
    if (body.type === 'BlockStatement') {
      if (body.body.length !== 1 || body.body[0].type !== 'ReturnStatement') return refuse()
      body = body.body[0].argument
    }
    const read = (node) => {
      if (node?.type === 'Identifier' && node.name === parameter) return []
      if (node?.type !== 'CallExpression' || node.arguments.length !== 1 || node.callee.type !== 'CallExpression' || node.callee.callee.type !== 'Identifier' || !['swap', 'replacing', 'replaceOnce'].includes(node.callee.callee.name)) return null
      const inner = read(node.arguments[0])
      const patch = data.evaluate(node.callee, value.scope)
      return inner && patch && Array.isArray(patch.patches) ? [...inner, ...patch.patches] : null
    }
    const result = read(body)
    return result && result.length ? result : refuse()
  }
  const unresolvedTargets = []
  const anchorRecords = (entry, inherited = null) => {
    if (!entry || isUnknown(entry)) return []
    if (Array.isArray(entry)) {
      if (entry.length >= 4 && typeof entry[0] === 'string' && patternTarget(entry[3]) && targets(entry[3]).length && (typeof entry[1] === 'string' || entry[1]?.regex)) return targets(entry[3]).map((file) => ({ file, from: entry[1], count: 1 }))
      if (entry.length >= 4 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && (targets(entry[1]).length || explicitPath(entry[1])) && (typeof entry[2] === 'string' || (entry[2] && entry[2].regex))) return targets(entry[1]).map((file) => ({ file, from: entry[2], count: 1 }))
      if (entry.length === 3 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && targets(entry[0]).length) return targets(entry[0]).map((file) => ({ file, from: entry[1], count: 1 }))
      if (entry.length === 2 && typeof entry[0] === 'string' && ((entry[1] && entry[1].patches) || (entry[1] && entry[1].lambda))) return targets(entry[0]).flatMap((file) => changes(entry[1]).map((patch) => ({ file, ...patch })))
      return entry.flatMap((value) => anchorRecords(value, inherited))
    }
    if (entry.lambda) return []
    if (typeof entry === 'object') {
      const target = entry.files === undefined ? entry.file === undefined ? entry.target === undefined ? inherited : entry.target : entry.file : entry.files
      const from = entry.find === undefined ? entry.from === undefined ? entry.at : entry.from : entry.find
      if (target !== null && target !== undefined && (from !== undefined || entry.change) && !targets(target).length) unresolvedTargets.push('unresolved anchor target ' + (typeof target === 'string' ? target : target.unknown || 'expression'))
      const direct = from !== undefined ? targets(target).map((file) => ({ file, from, count: typeof entry.count === 'number' ? entry.count : 1, first: Boolean(entry.first) })) : []
      const patched = targets(target).flatMap((file) => changes(entry.change).map((patch) => ({ file, ...patch })))
      const edits = Array.isArray(entry.edits) ? targets(target).flatMap((file) => entry.edits.filter(Array.isArray).map(([from]) => ({ file, from, count: 1 }))) : []
      return [...direct, ...patched, ...edits, ...Object.entries(entry).filter(([key]) => !['file', 'target', 'from', 'find', 'at', 'to', 'replace', 'change', 'edits', 'scope'].includes(key)).flatMap(([, value]) => anchorRecords(value, target))]
    }
    return []
  }
  // Every external anchor producer records the original descriptor input here. Raw recursion
  // stays private; family completeness is decided only after all these inputs are audited.
  const ingestions = []
  const harvest = (value, location) => {
    const records = anchorRecords(value)
    ingestions.push({ value, location, anchors: records.length })
    return records
  }
  const arrays = new Map()
  const unresolved = []
  const containsEdit = (value) => {
    if (!value || isUnknown(value) || value.lambda) return false
    if (Array.isArray(value)) return value.some(containsEdit)
    if (typeof value !== 'object') return false
    return (('file' in value || 'target' in value) && ['find', 'from', 'at', 'change', 'edits'].some((key) => key in value)) || Object.values(value).some(containsEdit)
  }
  for (const name of data.bindings.keys()) {
    const named = /(?:FAULTS|MUTATIONS|MUTANTS|BENIGN|REWRITES)$/.test(name)
    const value = get(name)
    if (Array.isArray(value) && (named || containsEdit(value))) arrays.set(name, value)
    else if (named && isUnknown(value)) unresolved.push(name)
  }
  // Imported planting names may be aliased. An unresolved direct target must not disappear merely because it has no named registry.
  const sinks = new Map()
  const localTargets = []
  const aliasTargets = []
  const directPlantAnchors = []
  walk(data.ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern' || node.init?.type !== 'CallExpression' || node.init.callee.name !== 'require') return
    if (!source.slice(node.init.start, node.init.end).includes('mutant-source')) return
    for (const entry of node.id.properties) {
      if (entry.type === 'Property' && ['patched', 'plantedPatch', 'plantedCopy', 'plantedGroup', 'patchedGroup'].includes(entry.key.name) && entry.value.type === 'Identifier') sinks.set(entry.value.name, entry.key.name)
    }
  })
  walk(data.ast, (node) => {
    if (node.type !== 'CallExpression' || !sinks.has(node.callee.name) || !node.arguments[0]) return
    const kind = sinks.get(node.callee.name)
    if (['plantedGroup', 'patchedGroup'].includes(kind)) {
      const members = data.evaluate(node.arguments[1])
      if (Array.isArray(members)) directPlantAnchors.push(...harvest(members, `plant:${node.loc.start.line}`))
      return
    }
    const argument = node.arguments[kind === 'plantedCopy' ? 2 : 0]
    if (!argument) return
    const target = data.evaluate(argument)
    if (!isUnknown(target)) {
      const resolved = targets(target)
      aliasTargets.push(...resolved)
      const from = data.evaluate(node.arguments[kind === 'plantedCopy' ? 3 : 2])
      if (resolved.length && (typeof from === 'string' || from?.regex)) directPlantAnchors.push(...resolved.map((file) => ({ file, from, count: 1, line: node.loc.start.line })))
      return
    }
    if (source.slice(argument.start, argument.end).includes('process.env')) { unresolvedTargets.push('environment-selected planting target'); return }
    const references = new Set()
    walk(argument, (part) => { if (part.type === 'Identifier') references.add(part.name) })
    let parameter = false
    walk(data.ast, (scope) => {
      if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scope.type) || node.start < scope.start || node.end > scope.end) return
      scope.params.forEach((pattern) => walk(pattern, (part) => { if (part.type === 'Identifier' && references.has(part.name)) parameter = true }))
    })
    if (parameter) { localTargets.push('parameter data'); return }
    let initializer = null
    let local = false
    walk(data.ast, (scope) => {
      if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scope.type) || node.start < scope.start || node.end > scope.end) return
      walk(scope.body, (entry) => {
        if (entry.type === 'VariableDeclarator' && entry.id.type === 'Identifier' && references.has(entry.id.name) && entry.start < node.start) { initializer = entry.init; local = true }
        if (entry.type === 'VariableDeclarator' && entry.id.type !== 'Identifier' && entry.start < node.start) walk(entry.id, (part) => { if (part.type === 'Identifier' && references.has(part.name)) local = true })
      })
    })
    walk(data.ast, (scope) => {
      if (scope.type !== 'ForOfStatement' || node.start < scope.start || node.end > scope.end || scope.left.type !== 'VariableDeclaration') return
      walk(scope.left, (part) => { if (part.type === 'Identifier' && references.has(part.name)) { local = true; initializer = scope.right } })
    })
    const expression = source.slice((initializer || argument).start, (initializer || argument).end)
    if (expression.includes('process.env')) { unresolvedTargets.push('environment-selected planting target'); return }
    const suffixes = []
    walk(initializer || argument, (part) => { if (part.type === 'Literal' && typeof part.value === 'string') suffixes.push(...targets(part.value)) })
    if (suffixes.length) aliasTargets.push(...suffixes)
    else if (local) localTargets.push(argument.name || 'local source')
    else unresolvedTargets.push('unresolved aliased planting target ' + (argument.name || expression))
  })
  const allAnchors = [...directPlantAnchors, ...[...arrays].flatMap(([name, entries]) => harvest(entries, name))]
  const domain = new Set([...allAnchors.map((anchor) => anchor.file), ...aliasTargets])
  for (const value of Object.values(knownMap)) targets(value).forEach((file) => domain.add(file))
  if (!domain.size) localTargets.forEach((name) => unresolvedTargets.push('unbounded local planting target ' + name))
  const variants = []
  let family = null
  const add = (key, edits = [], extra = {}) => variants.push({ key, anchors: harvest(edits, `variant:${key}`), ...extra })
  const basename = path.posix.basename(suite)
  if (basename === 'check-route-position.js') {
    family = 'only-keys'
    add('head', [], { head: true, timingWitness: 'head' })
    const faults = get('FAULTS')
    const benign = get('BENIGN')
    const combined = get('COMBINED')
    const composed = get('COMPOSED')
    const standalone = get('STANDALONE')
    if ([faults, benign, combined].every(Array.isArray) && composed && Array.isArray(composed.set) && standalone && Array.isArray(standalone.set)) {
      faults.forEach((fault, index) => {
        add(`fault:${index}`, fault, { timingWitness: `planted fault ${fault[0]}` })
        if (composed.set.includes(index)) add(`composed:${index}`, [...combined, fault], { timingWitness: `planted fault ${fault[0]}, on the sources with every benign edit` })
      })
      benign.filter((edit) => standalone.set.includes(edit.id)).forEach((edit) => add(edit.id, edit, { timingWitness: `benign edit kept: ${edit.label}` }))
      add('benign:all', combined, { timingWitness: 'every benign edit applied: every check stays green' })
    } else unresolved.push('route-position execution registry')
  } else if (['check-route-time.js', 'check-safe-routes.js'].includes(basename)) {
    family = 'part'
    add('head', [], { head: true })
    const mutants = get('MUTANTS')
    const composed = get('COMPOSED')
    const benign = get('BENIGN')
    if ([mutants, composed, benign].every(Array.isArray)) {
      mutants.forEach((edit) => add(edit.id, edit, { witness: `${edit.benign ? 'benign edit kept' : 'mutation caught'}: ${edit.name}` }))
      composed.forEach((edit) => add(edit.id, [...benign, edit], { witness: `mutation caught on the stacked benign edits: ${edit.name}` }))
      add('stacked', benign, { witness: basename === 'check-safe-routes.js' ? 'benign edits: all of them together keep every fixture check green' : 'benign edits: all of them together keep every check green' })
    } else unresolved.push('route-time execution registry')
  } else if (basename === 'check-route-signatures.js') {
    family = 'runner'
    for (const key of ['head', 'page', 'page-desires', 'page-refresh']) add(key, [], { head: true })
    for (const [name, prefix] of [['MUTATIONS', 'mutant'], ['BENIGN', 'benign']]) {
      const entries = get(name)
      if (!Array.isArray(entries)) unresolved.push(name)
      else entries.forEach((edit, index) => add(`${prefix}:${index}`, edit))
    }
    add('benign:together', get('BENIGN'))
    const faults = get('BROWSER_MUTATIONS')
    const benign = get('BROWSER_BENIGN')
    if (Array.isArray(faults) && Array.isArray(benign)) {
      faults.forEach((edit, index) => { if (!edit.group) add(`page-fault:${index}`, edit) })
      for (const group of new Set(faults.filter((edit) => edit.group).map((edit) => edit.group))) add(`page-group:${group}`, faults.filter((edit) => edit.group === group))
      for (const reads of new Set(benign.map((edit) => edit.reads))) add(`page-benign:${reads}`, benign.filter((edit) => edit.reads === reads))
    } else unresolved.push('route-signatures browser registries')
  } else if (data.bindings.has('variantsOf') && /require\(['"]\.\/lib\/suite-runner['"]\)/.test(source)) {
    family = 'runner'
    const entry = get('variantsOf')
    const declared = data.invokeData(entry, entry?.lambda?.params?.[0]?.name === 'options' ? [{ mutations: true, saves: false }, true, true] : [true, true, entry?.lambda?.params?.[2]?.name !== 'explicitSelection'])
    if (Array.isArray(declared) && declared.every((entry) => entry && typeof entry.key === 'string')) {
      for (const variant of declared) {
        const edits = []
        const run = variant.run
        if (run !== undefined && (!variant.head || run?.lambda?.type !== 'FunctionDeclaration')) {
          let body = run?.lambda?.body
          if (body?.type === 'BlockStatement' && body.body.length === 1 && ['ReturnStatement', 'ExpressionStatement'].includes(body.body[0].type)) body = body.body[0].argument || body.body[0].expression
          const emptyHead = variant.head && body?.type === 'BlockStatement' && body.body.length === 0
          if (!emptyHead && (body?.type !== 'CallExpression' || body.callee.type !== 'Identifier' || (!variant.head && !body.arguments.length))) {
            unresolved.push(`variant ${variant.key} has unsupported run behavior at line ${run?.lambda?.loc.start.line || data.originOf(variant)?.loc.start.line || 'unknown'}`)
          } else if (!emptyHead) {
            body.arguments.forEach((argument) => edits.push(data.evaluate(argument, run.scope)))
          }
        }
        const indexed = /^(module-fault|module-benign|fault|benign|mutant|lacking-fault|lacking-benign|page-fault):(\d+)$/.exec(variant.key)
        if (indexed) {
          const names = { 'module-fault': ['MODULE_FAULTS'], 'module-benign': ['MODULE_BENIGN'], fault: ['FAULTS', 'PAGE_FAULTS'], benign: ['BENIGN', 'PAGE_BENIGN'], mutant: ['MUTATIONS', 'MUTANTS'], 'lacking-fault': ['LACKING_FAULTS'], 'lacking-benign': ['LACKING_BENIGN'], 'page-fault': ['BROWSER_MUTATIONS', 'PAGE_FAULTS'] }[indexed[1]]
          const registry = names.map(get).find(Array.isArray)
          if (registry && registry[Number(indexed[2])]) edits.push(registry[Number(indexed[2])])
        }
        if (/composite|together|stacked|all$/.test(variant.key)) edits.push(...(variant.key === 'benign:composite-a' && !isUnknown(get('PAGE_COMPOSITE_A')) ? [get('PAGE_COMPOSITE_A')] : [...arrays].filter(([name]) => /BENIGN|REWRITE/.test(name)).map(([, entries]) => entries)))
        if (variant.members) edits.push(variant.members)
        add(variant.key, edits, { head: Boolean(variant.head) })
        if (!variant.head && !variants.at(-1).anchors.length) unresolved.push(`variant ${variant.key} has no accounted descriptor source effect at line ${data.originOf(variant)?.loc.start.line || 'unknown'}`)
      }
    } else unresolved.push('variantsOf cannot be read as inert data')
  }
  if (!family) {
    // These older families run their whole declared fault/rewrite catalogs by default. No guessed focused selector is emitted.
    const faults = get('FAULTS')
    const benign = get('BENIGN')
    const completeDefault = ['check-fleet-profile.js', 'check-handling-bonuses.js', 'check-elapsed-time-pages.js'].includes(basename)
    if (completeDefault && allAnchors.length && !unresolved.length && Array.isArray(faults) && Array.isArray(benign)) {
      family = 'full'
      add('*', [...arrays.values()])
    }
  }
  // A family adapter may claim completeness only for this closed descriptor grammar.
  // Unrecognized fields are not presumed to be metadata or presumed to have no source effect.
  const descriptorIssues = new Set()
  const accounting = { descriptors: 0, accounted: 0 }
  const audited = new WeakSet()
  const metadata = new Set(['name', 'label', 'id', 'fails', 'benign', 'alone', 'group', 'reads'])
  const effects = new Set(['file', 'target', 'find', 'from', 'at', 'to', 'replace', 'change', 'edits', 'count', 'first'])
  const pattern = (value) => typeof value === 'string' || Boolean(value && typeof value.regex === 'string')
  const inertMetadata = (value) => value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every(inertMetadata))
  const issue = (entry, location, reason, field = null) => {
    const origin = data.originOf(entry)
    const member = field ? data.originOf(entry, field) || property(origin, field) : null
    const line = member?.loc.start.line || entry?.[field]?.lambda?.loc.start.line || entry?.lambda?.loc.start.line || entry?.line || origin?.loc.start.line || data.bindings.get(location.split('[')[0])?.loc?.start.line
    descriptorIssues.add(`${location}${field ? '.' + field : ''}${line ? ' at line ' + line : ''}: ${reason}`)
  }
  const audit = (entry, location, inherited = null) => {
    if (Array.isArray(entry)) {
      let target
      let from
      if (entry.length >= 4 && typeof entry[0] === 'string' && patternTarget(entry[3]) && targets(entry[3]).length && pattern(entry[1])) {
        target = entry[3]; from = entry[1]
      } else if (entry.length >= 4 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && (targets(entry[1]).length || explicitPath(entry[1])) && pattern(entry[2])) {
        target = entry[1]; from = entry[2]
        if (entry.length > 5 || (entry.length === 5 && !inertMetadata(entry[4]))) issue(entry, location, 'unsupported tuple fields')
      } else if (entry.length === 3 && typeof entry[0] === 'string' && pattern(entry[1]) && targets(entry[0]).length) {
        target = entry[0]; from = entry[1]
      } else if (entry.length === 2 && typeof entry[0] === 'string' && (entry[1]?.patches || entry[1]?.lambda)) {
        target = entry[0]
        const patches = changes(entry[1])
        if (!patches.length || patches.some((patch) => !pattern(patch.from))) issue(entry, location, 'unresolved tuple source transformation')
      } else {
        entry.forEach((value, index) => audit(value, `${location}[${index}]`, inherited))
        return
      }
      if (audited.has(entry)) return
      audited.add(entry)
      accounting.descriptors++
      if (!targets(target).length) { issue(entry, location, 'unresolved tuple target'); unresolvedTargets.push(location + ': unresolved tuple target') } else if (from === undefined && !(entry[1]?.patches || entry[1]?.lambda)) issue(entry, location, 'unaccounted tuple source effect')
      else accounting.accounted++
      return
    }
    if (entry && typeof entry === 'object') {
      if (audited.has(entry)) return
      audited.add(entry)
    }
    accounting.descriptors++
    if (!entry || typeof entry !== 'object' || isUnknown(entry) || entry.lambda) { issue(entry, location, 'unsupported descriptor form'); return }
    const target = entry.files === undefined ? entry.file === undefined ? entry.target === undefined ? inherited : entry.target : entry.file : entry.files
    const fields = ['find', 'from', 'at'].filter((key) => entry[key] !== undefined)
    let accounted = false
    for (const [key, value] of Object.entries(entry)) {
      if (!effects.has(key) && !metadata.has(key)) issue(entry, location, 'unknown descriptor field or source effect', key)
      else if (metadata.has(key) && !inertMetadata(value)) issue(entry, location, 'metadata must be inert; unknown function or source effect', key)
    }
    if (entry.count !== undefined && (!Number.isInteger(entry.count) || entry.count < 1)) issue(entry, location, 'unsupported anchor count', 'count')
    if (entry.first !== undefined && typeof entry.first !== 'boolean') issue(entry, location, 'unsupported first-match selector', 'first')
    if (!fields.length && (entry.to !== undefined || entry.replace !== undefined)) issue(entry, location, 'replacement behavior has no source anchor')
    if (fields.length) {
      if (fields.length !== 1 || !pattern(entry[fields[0]])) issue(entry, location, 'ambiguous or unresolved source anchor')
      else accounted = true
    }
    if (entry.change !== undefined) {
      const patches = changes(entry.change)
      if (!patches.length || patches.some((patch) => !pattern(patch.from))) issue(entry, location, 'unresolved complete source transformation', 'change')
      else accounted = true
    }
    if (entry.edits !== undefined) {
      if (!Array.isArray(entry.edits) || !entry.edits.length || entry.edits.some((pair) => !Array.isArray(pair) || pair.length !== 2 || !pattern(pair[0]))) issue(entry, location, 'unsupported edit tuple', 'edits')
      else accounted = true
    }
    if (!accounted) issue(entry, location, 'descriptor has no accounted source effect')
    if (!targets(target).length) { issue(entry, location, 'unresolved descriptor target'); unresolvedTargets.push(location + ': unresolved descriptor target') }
    if (accounted && targets(target).length) accounting.accounted++
  }
  if (family) for (const { value, location } of ingestions) audit(value, location)
  for (const variant of variants) variant.anchors.forEach((anchor) => domain.add(anchor.file))
  const unknowns = [...new Set([...unresolvedTargets, ...unsupportedChanges, ...descriptorIssues])].concat(unresolved.map((name) => `unresolved catalog ${name}`))
  if (!family && domain.size) unknowns.push('target domain known but no audited execution adapter')
  const unknownDomain = unresolvedTargets.length > 0 || (!domain.size && unknowns.length > 0)
  const expectedExtra = family === 'full' && basename !== 'check-elapsed-time-pages.js' ? 2 * get('FAULTS').length + (basename === 'check-fleet-profile.js' ? get('BENIGN').length + get('BENIGN').slice(1, -1).length + 1 : get('BENIGN').length + 2) : null
  const witnesses = family === 'full' && basename === 'check-elapsed-time-pages.js' ? { faults: get('FAULTS').map((entry) => entry.name), benign: get('BENIGN').map((entry) => entry.name) } : null
  return { suite, family, variants, defaultKeys: variants.map((entry) => entry.key), timingWitnesses: Object.fromEntries(variants.filter((entry) => entry.timingWitness).map((entry) => [entry.key, entry.timingWitness])), partWitnesses: Object.fromEntries(variants.filter((entry) => entry.witness).map((entry) => [entry.key, entry.witness])), expectedExtra, witnesses, domain: [...domain].sort(), coverage: family && !unknowns.length ? 'complete' : domain.size ? 'bounded-domain' : unknownDomain ? 'unknown' : 'no-source-anchors-observed', unknownDomain, unknowns, proof: { descriptorAccounting: { ...accounting, unresolved: [...descriptorIssues], ingestionOrigins: ingestions.map(({ location, anchors }) => ({ location, anchors })) }, registries: [...arrays.keys()], plantingAliases: [...sinks], localTargets, anchorRecords: allAnchors.length } }
}

const commandsFor = (catalog, variants) => {
  const keys = [...new Set(variants.map((variant) => variant.key))]
  if (catalog.family === 'only-keys') return [{ args: [`--only=${keys.filter((key) => key !== 'head').join('|')}`, '--detail'], keys }]
  if (catalog.family === 'runner') return [{ args: ['--detail', `--variants=${keys.join(',')}`], keys }]
  if (catalog.family === 'part') return keys.map((key) => ({ args: ['--part', key], keys: [key] }))
  if (catalog.family === 'full') return [...(catalog.expectedExtra === null ? [] : [{ args: ['--no-mutations'], keys: ['head'] }]), { args: [], keys: ['*'], fallback: 'audited whole default catalog; full completion must include its fault/rewrite work' }]
  return []
}

module.exports = { catalogSuite, commandsFor }
