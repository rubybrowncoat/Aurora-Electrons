/* Import-free discovery of the source anchors a landing can invalidate. No subject module or replacement callback runs here. */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Worker } = require('worker_threads')
const acorn = require('acorn')

// The arguments a suite cannot run without, as check-all.js's own registry gives them: a printed command that omits one aborts instead of checking.
const SUITE_ARGS = [['check-design-rules.js', ['--fixtures']]]

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const unknown = (reason, node = null) => ({ unknown: reason, line: node && node.loc ? node.loc.start.line : null })
const isUnknown = (value) => Boolean(value && value.unknown)
const walk = (node, visit, parent = null) => {
  if (!node || typeof node !== 'object') {
    return
  }
  visit(node, parent)
  Object.entries(node).filter(([key]) => key !== 'loc').forEach(([, value]) => Array.isArray(value) ? value.forEach((item) => walk(item, visit, node)) : value && typeof value === 'object' ? walk(value, visit, node) : null)
}
const property = (node, key) => node && node.type === 'ObjectExpression' ? node.properties.find((entry) => entry.type === 'Property' && (entry.key.name || entry.key.value) === key) : null
const parse = (source) => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
const normalize = (file) => file.replace(/\\/g, '/').replace(/^\.\//, '')
const LOADERS = new Set(['loadUtilities', 'loadPage', 'loadModule', 'loadModules'])
const NODE_BUILTINS = new Set(require('module').builtinModules.map((name) => name.replace(/^node:/, '')))

// The interpreter reads only inert declaration data. Its lambdas are AST records, never JavaScript functions; their bodies may build data through the same restricted operations only.
const declarations = (source, file, root, files = []) => {
  const ast = parse(source)
  const mutableNames = new Set()
  const storageMutations = new Set()
  const aliases = []
  const references = []
  const projections = []
  const bindingsByValue = []
  const opaqueAliases = new Set()
  const opaqueStoredAliases = new Set()
  const nestedMutations = new Set()
  const mutationFunctions = new Set()
  const opaqueMutationFunctions = new Set()
  const mutationNamespaces = new Set(['Object', 'Reflect'])
  const handledMutationUses = new WeakSet()
  const uncertainMutationUses = new Set()
  const mutationOrigins = []
  const opaqueBindings = []
  const noteMutation = (reason, ...nodes) => { uncertainMutationUses.add(reason); mutationOrigins.push({ reason, nodes: nodes.filter(Boolean) }) }
  const entries = []
  const utilityMethods = new Set(['assign', 'defineProperty', 'defineProperties', 'set'])
  const receiverMethods = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'add', 'set', 'delete', 'clear'])
  const roots = (node) => {
    if (!node) return []
    if (node.type === 'Identifier') return [node.name]
    if (node.type === 'MemberExpression') return roots(node.object)
    if (node.type === 'ObjectPattern') return node.properties.flatMap((entry) => roots(entry.value || entry.argument))
    if (node.type === 'ArrayPattern') return node.elements.flatMap(roots)
    if (node.type === 'AssignmentPattern' || node.type === 'RestElement') return roots(node.left || node.argument)
    return []
  }
  const mutate = (node, nested = node?.type === 'MemberExpression') => roots(node).forEach((name) => { mutableNames.add(name); storageMutations.add(name); if (nested) nestedMutations.add(name) })
  const shadowedNatives = new Set()
  const primitiveNames = new Set()
  const unknownBindings = new Set()
  const literalArrays = new Map()
  const bindingCounts = new Map()
  const writtenRoots = new Set()
  const primitive = (node) => node && ((node.type === 'Literal' && !node.regex) || ['TemplateLiteral', 'BinaryExpression', 'UnaryExpression'].includes(node.type))
  walk(ast, (node) => {
    const patterns = node.type === 'VariableDeclarator' ? [node.id] : /^(?:Function|ArrowFunction)/.test(node.type || '') ? [node.id, ...(node.params || [])] : node.type === 'ClassDeclaration' ? [node.id] : node.type === 'ImportDeclaration' ? node.specifiers.map((member) => member.local) : node.type === 'AssignmentExpression' ? [node.left] : []
    patterns.flatMap(roots).forEach((name) => shadowedNatives.add(name))
    patterns.flatMap(roots).forEach((name) => bindingCounts.set(name, (bindingCounts.get(name) || 0) + 1))
    const target = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null
    const value = node.type === 'VariableDeclarator' ? node.init : node.right
    for (const name of patterns.flatMap(roots)) (target?.type === 'Identifier' && primitive(value) ? primitiveNames : unknownBindings).add(name)
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'ArrayExpression' && node.init.elements.every(primitive)) {
      if (literalArrays.has(node.id.name)) unknownBindings.add(node.id.name)
      literalArrays.set(node.id.name, node.init)
    }
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') roots(node.left || node.argument).forEach((name) => writtenRoots.add(name))
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && (receiverMethods.has(node.callee.computed ? node.callee.property.value : node.callee.property.name) || node.callee.computed)) roots(node.callee.object).forEach((name) => writtenRoots.add(name))
    if (node.type === 'CallExpression') node.arguments.flatMap(roots).forEach((name) => writtenRoots.add(name))
  })
  for (const name of unknownBindings) primitiveNames.delete(name)
  const aliasRoots = (node) => {
    if (!node) return { names: [], opaque: false }
    if (node.type === 'Identifier') return { names: primitiveNames.has(node.name) ? [] : [node.name], opaque: false }
    if (node.type === 'AwaitExpression') return aliasRoots(node.argument)
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.callee.name) && !shadowedNatives.has(node.callee.name)) {
      const values = node.arguments.map(aliasRoots)
      return { names: values.flatMap((value) => value.names), opaque: values.some((value) => value.opaque), container: true }
    }
    if (node.type === 'MemberExpression') {
      const value = aliasRoots(node.object)
      const opaqueMember = !mutationNamespaces.has(node.object.name) || !utilityMethods.has(memberName(node))
      return { names: value.names, opaque: value.opaque || opaqueMember, projection: true }
    }
    let parts
    if (node.type === 'ConditionalExpression') parts = [node.consequent, node.alternate]
    else if (node.type === 'LogicalExpression') parts = [node.left, node.right]
    else if (node.type === 'SequenceExpression') parts = node.expressions
    else if (node.type === 'AssignmentExpression' && node.operator === '=') parts = [node.right]
    else if (node.type === 'ObjectExpression') parts = node.properties.map((entry) => entry.value || entry.argument)
    else if (node.type === 'ArrayExpression') parts = node.elements
    if (parts) {
      const values = parts.map(aliasRoots)
      return { names: values.flatMap((value) => value.names), opaque: values.some((value) => value.opaque), container: ['ObjectExpression', 'ArrayExpression'].includes(node.type) || values.every((value) => value.container) }
    }
    return { names: [], opaque: !['Literal', 'TemplateLiteral', 'BinaryExpression', 'UnaryExpression', 'ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(node.type) }
  }
  const memberName = (node) => node.computed ? node.property.value : node.property.name
  const recordAlias = (target, value) => {
    if (!value) return
    const names = roots(target)
    const origin = aliasRoots(value)
    // A fresh container holds references; it is not the same object as its values.
    // Likewise, storing a field does not mutate the object being stored.
    const container = target.type === 'MemberExpression' || origin.container
    ;(container ? references : origin.projection ? projections : aliases).push([names, origin.names])
    if (origin.opaque) {
      names.forEach((name) => (container ? opaqueStoredAliases : opaqueAliases).add(name))
      opaqueBindings.push({ target, value })
    }
    if (target.type === 'Identifier' && value.type === 'MemberExpression' && origin.opaque && !LOADERS.has(memberName(value))) opaqueMutationFunctions.add(target.name)
    bindingsByValue.push({ target, value })
  }
  walk(ast, (node, parent) => {
    entries.push({ node, parent })
    if (node.type === 'VariableDeclarator') recordAlias(node.id, node.init)
    if (node.type === 'AssignmentExpression' && node.operator === '=') recordAlias(node.left, node.right)
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      const target = node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left
      const literal = node.right.type === 'Identifier' && bindingCounts.get(node.right.name) === 1 && !writtenRoots.has(node.right.name) ? literalArrays.get(node.right.name) : node.right
      if (literal?.type === 'ArrayExpression' && node.type === 'ForOfStatement') literal.elements.forEach((value) => recordAlias(target, value))
      else { roots(target).forEach((name) => opaqueAliases.add(name)); projections.push([roots(target), roots(node.right)]); opaqueBindings.push({ target, value: node.right }) }
      if (node.left.type !== 'VariableDeclaration' || node.left.kind === 'var') roots(target).forEach((name) => mutableNames.add(name))
    }
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
      const target = node.left || node.argument
      roots(target).forEach((name) => mutableNames.add(name))
      if (target?.type === 'MemberExpression') mutate(target, target.object.type === 'MemberExpression')
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return
    const member = node.callee.computed ? node.callee.property.value : node.callee.property.name
    if (node.callee.computed && typeof member !== 'string') mutate(node.callee.object)
    if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'add', 'set', 'delete', 'clear'].includes(member)) mutate(node.callee.object)
    if (['Object', 'Reflect'].includes(node.callee.object.name) && ['assign', 'defineProperty', 'defineProperties', 'set'].includes(member)) mutate(node.arguments[0])
  })
  for (let changed = true; changed;) {
    changed = false
    for (const { target, value } of bindingsByValue) {
      if (target.type === 'ObjectPattern' && value.type === 'Identifier' && mutationNamespaces.has(value.name)) {
        for (const member of target.properties) {
          const name = member.computed ? member.key?.value : member.key?.name || member.key?.value
          if (!utilityMethods.has(name) || member.value?.type !== 'Identifier') { noteMutation(source.slice(target.start, target.end), target); continue }
          handledMutationUses.add(member.key)
          handledMutationUses.add(member.value)
          if (!mutationFunctions.has(member.value.name)) { mutationFunctions.add(member.value.name); changed = true }
        }
      }
      if (target.type !== 'Identifier') continue
      if (value.type === 'Identifier' && mutationNamespaces.has(value.name) && !mutationNamespaces.has(target.name)) { mutationNamespaces.add(target.name); changed = true }
      if (value.type === 'Identifier' && opaqueMutationFunctions.has(value.name) && !opaqueMutationFunctions.has(target.name)) { opaqueMutationFunctions.add(target.name); handledMutationUses.add(value); changed = true }
      const method = value.type === 'MemberExpression' && mutationNamespaces.has(value.object.name) && utilityMethods.has(memberName(value))
      if (method || (value.type === 'Identifier' && mutationFunctions.has(value.name))) {
        handledMutationUses.add(value)
        if (!mutationFunctions.has(target.name)) { mutationFunctions.add(target.name); changed = true }
      }
    }
  }
  for (const { node } of entries) {
    if (node.type !== 'CallExpression') continue
    if (node.callee.type === 'Identifier' && mutationFunctions.has(node.callee.name)) {
      handledMutationUses.add(node.callee)
      if (!node.arguments.length || node.arguments[0].type === 'SpreadElement') noteMutation(source.slice(node.start, node.end), node)
      mutate(node.arguments[0])
    } else if (node.callee.type === 'Identifier' && opaqueMutationFunctions.has(node.callee.name)) {
      handledMutationUses.add(node.callee)
      noteMutation('opaque mutation callable ' + source.slice(node.start, node.end), node)
    } else if (node.callee.type === 'MemberExpression' && mutationNamespaces.has(node.callee.object.name) && !['Object', 'Reflect'].includes(node.callee.object.name) && utilityMethods.has(memberName(node.callee))) {
      handledMutationUses.add(node.callee)
      mutate(node.arguments[0])
    }
  }
  for (const { node, parent } of entries) {
    if (handledMutationUses.has(node)) continue
    if (node.type === 'MemberExpression') {
      const member = memberName(node)
      const utility = mutationNamespaces.has(node.object.name) && (utilityMethods.has(member) || (node.computed && typeof member !== 'string'))
      if (!utility && !receiverMethods.has(member)) continue
      if (parent?.type === 'CallExpression' && parent.callee === node && typeof member === 'string' && (!utility || mutationNamespaces.has(node.object.name))) continue
      noteMutation(source.slice(node.start, node.end), node)
    } else if (node.type === 'Identifier' && mutationFunctions.has(node.name)) {
      if ((parent?.type === 'VariableDeclarator' && parent.id === node) || (parent?.type === 'AssignmentExpression' && parent.left === node)) continue
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) continue
      if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) continue
      noteMutation(source.slice(parent?.start ?? node.start, parent?.end ?? node.end), node)
    }
  }
  for (let changed = true; changed;) {
    changed = false
    const mark = (name, nested = false) => {
      if (!storageMutations.has(name)) { storageMutations.add(name); mutableNames.add(name); changed = true }
      if (nested && !nestedMutations.has(name)) { nestedMutations.add(name); changed = true }
    }
    for (const [left, right] of aliases) {
      const names = [...left, ...right]
      if (!names.some((name) => storageMutations.has(name))) continue
      for (const name of names) mark(name, names.some((one) => nestedMutations.has(one)))
    }
    for (const [targets, containers] of projections) if (targets.some((name) => storageMutations.has(name))) for (const name of containers) mark(name, true)
    for (const [containers, children] of references) if (containers.some((name) => nestedMutations.has(name))) for (const name of children) mark(name, true)
  }
  for (const name of opaqueAliases) if (storageMutations.has(name)) noteMutation('unresolved mutable alias ' + name, ...opaqueBindings.filter(({ target }) => roots(target).includes(name)).map(({ target }) => target))
  for (const name of opaqueStoredAliases) if (nestedMutations.has(name)) noteMutation('unresolved mutable member alias ' + name, ...opaqueBindings.filter(({ target }) => roots(target).includes(name)).map(({ target }) => target))
  const bindings = new Map()
  const cache = new Map()
  const origins = new WeakMap()
  const fieldOrigins = new WeakMap()
  const readonlyParameterScopes = new WeakMap()
  const active = new Set()
  let budget = 100000
  const closure = (node, scope) => ({ lambda: node, scope })
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const entry of statement.declarations) {
        if (entry.id.type === 'Identifier') {
          bindings.set(entry.id.name, entry.init)
        } else if (entry.id.type === 'ObjectPattern') {
          for (const member of entry.id.properties) {
            if (member.type === 'Property' && member.value.type === 'Identifier') bindings.set(member.value.name, { type: 'MemberExpression', object: entry.init, property: { type: 'Literal', value: member.key.name || member.key.value }, computed: true, loc: entry.loc })
          }
        }
      }
    } else if (statement.type === 'FunctionDeclaration') {
      bindings.set(statement.id.name, statement)
    }
  }
  const bind = (pattern, value, scope) => {
    if (pattern.type === 'Identifier') {
      scope[pattern.name] = value
    } else if (pattern.type === 'ArrayPattern' && Array.isArray(value)) {
      pattern.elements.forEach((entry, index) => entry && bind(entry, value[index], scope))
    } else if (pattern.type === 'ObjectPattern' && value && typeof value === 'object') {
      pattern.properties.forEach((entry) => entry.type === 'Property' && bind(entry.value, value[entry.key.name || entry.key.value], scope))
    } else if (pattern.type === 'AssignmentPattern') {
      bind(pattern.left, value === undefined ? evaluate(pattern.right, scope) : value, scope)
    } else if (pattern.type === 'RestElement') {
      bind(pattern.argument, value, scope)
    }
  }
  const invokeData = (lambda, args) => {
    if (!lambda || !lambda.lambda) {
      return unknown('not an inert data lambda')
    }
    const scope = { ...lambda.scope }
    lambda.lambda.params.forEach((parameter, index) => bind(parameter, parameter.type === 'RestElement' ? args.slice(index) : args[index], scope))
    const body = lambda.lambda.body
    // A single native path operation cannot write its parameters. Other functions'
    // identically-spelled locals must not poison this inert factory's arguments.
    // The evaluator below still checks the actual path namespace and every argument.
    if (body.type === 'CallExpression' && body.callee.type === 'MemberExpression' && !body.callee.computed && body.callee.object.name === 'path' && ['join', 'resolve', 'dirname', 'basename', 'relative', 'normalize'].includes(body.callee.property.name)) readonlyParameterScopes.set(scope, new Set(lambda.lambda.params.flatMap(roots)))
    if (body.type !== 'BlockStatement') {
      return evaluate(body, scope)
    }
    for (const statement of body.body) {
      if (statement.type === 'VariableDeclaration') {
        for (const entry of statement.declarations) {
          const value = evaluate(entry.init, scope)
          if (isUnknown(value)) return value
          bind(entry.id, value, scope)
        }
      } else if (statement.type === 'ReturnStatement') {
        return evaluate(statement.argument, scope)
      } else {
        return unknown('procedural lambda body', statement)
      }
    }
    return unknown('data lambda without a return', body)
  }
  const valueOf = (name) => {
    if (mutableNames.has(name)) return unknown('dependency binding can be mutated: ' + name)
    if (cache.has(name)) {
      return cache.get(name)
    }
    if (!bindings.has(name) || active.has(name)) {
      return unknown(`unresolved binding ${name}`)
    }
    active.add(name)
    const result = evaluate(bindings.get(name), {})
    active.delete(name)
    cache.set(name, result)
    return result
  }
  const evaluate = (node, scope = {}) => {
    if (!node || --budget < 0) {
      return unknown(node ? 'declaration budget exceeded' : 'absent declaration', node)
    }
    if (node.type === 'Literal') {
      return node.regex ? { regex: node.regex.pattern, flags: node.regex.flags } : node.value
    }
    if (node.type === 'Identifier') {
      if (mutableNames.has(node.name) && !readonlyParameterScopes.get(scope)?.has(node.name)) return unknown('dependency binding can be mutated: ' + node.name, node)
      if (node.name === 'process') return { platform: process.platform }
      return own(scope, node.name) ? scope[node.name] : node.name === '__filename' ? path.join(root, file) : node.name === '__dirname' ? path.dirname(path.join(root, file)) : node.name === 'undefined' ? undefined : valueOf(node.name)
    }
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') {
      return closure(node, scope)
    }
    if (node.type === 'TemplateLiteral') {
      const values = node.expressions.map((entry) => evaluate(entry, scope))
      return values.some((entry) => isUnknown(entry) || (entry && typeof entry === 'object')) ? unknown('dynamic template', node) : node.quasis.map((part, index) => part.value.cooked + (index < values.length ? values[index] : '')).join('')
    }
    if (node.type === 'ArrayExpression') {
      const result = []
      for (const entry of node.elements) {
        const value = entry && evaluate(entry.type === 'SpreadElement' ? entry.argument : entry, scope)
        if (entry && entry.type === 'SpreadElement') {
          const spread = value && Array.isArray(value.set) ? [...new Set(value.set)] : value
          if (!Array.isArray(spread)) {
            return unknown('unresolved array spread', entry)
          }
          result.push(...spread)
        } else {
          result.push(value)
        }
      }
      origins.set(result, node)
      return result.length > 4096 ? unknown('declaration expansion exceeds 4096 entries', node) : result
    }
    if (node.type === 'ObjectExpression') {
      if (node.properties.some((entry) => entry.type === 'Property' && entry.kind !== 'init')) return unknown('accessor declaration', node)
      const result = {}
      const members = new Map()
      for (const entry of node.properties) {
        if (entry.type === 'SpreadElement') {
          const value = evaluate(entry.argument, scope)
          if (isUnknown(value) || !value || typeof value !== 'object') {
            return unknown('unresolved object spread', entry)
          }
          Object.assign(result, value)
          for (const [key, origin] of fieldOrigins.get(value) || []) members.set(key, origin)
        } else {
          const key = entry.computed ? evaluate(entry.key, scope) : entry.key.name || entry.key.value
          if (typeof key !== 'string' && typeof key !== 'number') {
            return unknown('dynamic object key', entry)
          }
          result[key] = evaluate(entry.value, scope)
          members.set(key, entry)
        }
      }
      origins.set(result, node)
      fieldOrigins.set(result, members)
      return result
    }
    if (node.type === 'MemberExpression') {
      const object = evaluate(node.object, scope)
      const key = node.computed ? evaluate(node.property, scope) : node.property.name
      return object && !isUnknown(object) && (Array.isArray(object) || typeof object === 'string' || Object.getPrototypeOf(object) === Object.prototype) ? own(Object(object), key) ? object[key] : undefined : unknown('dynamic member', node)
    }
    if (node.type === 'ConditionalExpression') {
      const condition = evaluate(node.test, scope)
      return isUnknown(condition) ? unknown('dynamic condition', node) : evaluate(condition ? node.consequent : node.alternate, scope)
    }
    if (node.type === 'UnaryExpression') {
      const value = evaluate(node.argument, scope)
      return isUnknown(value) ? value : node.operator === '!' ? !value : node.operator === '-' && typeof value === 'number' ? -value : unknown('unsupported unary expression', node)
    }
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const left = evaluate(node.left, scope)
      const right = evaluate(node.right, scope)
      if (isUnknown(left) || isUnknown(right)) {
        return unknown('dynamic operator', node)
      }
      if (node.operator === '+' && ['string', 'number'].includes(typeof left) && ['string', 'number'].includes(typeof right)) return left + right
      if (node.operator === '/' && typeof left === 'number' && typeof right === 'number') return left / right
      if (node.operator === '===') return left === right
      if (node.operator === '!==') return left !== right
      if (node.operator === '&&') return left && right
      if (node.operator === '||') return left || right
      if (node.operator === '>') return left > right
      if (node.operator === '<') return left < right
      return unknown('unsupported data operator', node)
    }
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
      if (bindings.has(node.callee.name) || own(scope, node.callee.name)) return unknown('shadowed constructor', node)
      const args = node.arguments.map((entry) => evaluate(entry, scope))
      if (node.callee.name === 'RegExp' && typeof args[0] === 'string' && (args[1] === undefined || typeof args[1] === 'string')) return { regex: args[0], flags: args[1] || '' }
      if (node.callee.name === 'Set' && Array.isArray(args[0])) return { set: args[0] }
      return unknown('unsupported constructor', node)
    }
    if (node.type === 'CallExpression') {
      const args = node.arguments.flatMap((entry) => entry.type === 'SpreadElement' ? evaluate(entry.argument, scope) : [evaluate(entry, scope)])
      if (node.callee.type === 'Identifier' && ['patched', 'plantedPatch'].includes(node.callee.name)) return { file: args[0], from: args[2], to: args[3], count: 1 }
      if (node.callee.type === 'Identifier' && bindings.has(node.callee.name) && valueOf(node.callee.name)?.lambda?.body?.type === 'ObjectExpression') return invokeData(valueOf(node.callee.name), args)
      if (node.callee.type === 'Identifier' && node.callee.name === 'swap' && bindings.get('swap')?.params?.[0]?.name === 'name') return { name: args[0], file: args[1], from: args[2], to: args[3], fails: args[4] }
      if (node.callee.type === 'Identifier' && ['swap', 'replacing', 'replaceOnce'].includes(node.callee.name) && (typeof args[0] === 'string' || (args[0] && args[0].regex))) return { patches: [{ from: args[0], to: args[1], count: typeof args[2] === 'number' ? args[2] : 1 }] }
      if (node.callee.type === 'Identifier' && ['inRenderer', 'edit', 'fleetEdit', 'bareEdit', 'present', 'summaryEdit', 'cellMark'].includes(node.callee.name) && bindings.has(node.callee.name)) return invokeData(valueOf(node.callee.name), args)
      if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
        const receiver = node.callee.object
        const name = node.callee.property.name
        if (receiver.type === 'Identifier' && ['Object', 'Array', 'Math'].includes(receiver.name) && (bindings.has(receiver.name) || own(scope, receiver.name))) return unknown('shadowed intrinsic', node)
        if (receiver.type === 'Identifier' && ['path', 'fs'].includes(receiver.name)) {
          const imported = bindings.get(receiver.name)
          if (own(scope, receiver.name) || imported?.type !== 'CallExpression' || imported.callee.name !== 'require' || ![receiver.name, 'node:' + receiver.name].includes(imported.arguments[0]?.value)) return unknown('unresolved module namespace', node)
        }
        if (receiver.type === 'Identifier' && receiver.name === 'fs' && name === 'existsSync' && typeof args[0] === 'string' && files.length) {
          const relative = normalize(path.relative(root, args[0]))
          if (files.includes(relative) || files.some((file) => file.startsWith(relative + '/'))) return true
          return /^(?:src|scripts)\/.*\.(?:js|mjs|vue|json|css|styl|scss|html|ts|md|py|ps1|sh|txt|yml|yaml|svg)$/.test(relative) ? false : unknown('existence outside the source snapshot', node)
        }
        if (receiver.type === 'Identifier' && receiver.name === 'Math' && name === 'floor' && typeof args[0] === 'number') return Math.floor(args[0])
        if (receiver.type === 'Identifier' && receiver.name === 'path' && ['join', 'resolve', 'dirname', 'basename', 'relative', 'normalize'].includes(name) && args.every((entry) => typeof entry === 'string')) return path[name](...args)
        if (receiver.type === 'Identifier' && receiver.name === 'Object' && ['entries', 'values', 'keys', 'fromEntries'].includes(name) && args[0] && !isUnknown(args[0]) && !args[0].lambda) return name === 'fromEntries' && Array.isArray(args[0]) ? Object.fromEntries(args[0]) : name === 'entries' ? Object.entries(args[0]) : name === 'values' ? Object.values(args[0]) : Object.keys(args[0])
        if (receiver.type === 'Identifier' && receiver.name === 'Array' && name === 'from' && args[0] && Number.isInteger(args[0].length) && args[0].length >= 0 && args[0].length <= 4096) return Array.from({ length: args[0].length }, (_, index) => args[1] ? invokeData(args[1], [undefined, index]) : undefined)
        const object = evaluate(receiver, scope)
        if (Array.isArray(object) && ['map', 'flatMap', 'filter'].includes(name)) {
          const transformed = object.map((entry, index) => invokeData(args[0], [entry, index]))
          if (transformed.some(isUnknown)) return unknown(`unresolved ${name}`, node)
          return name === 'filter' ? object.filter((_entry, index) => transformed[index]) : name === 'flatMap' ? transformed.flat() : transformed
        }
        if (object && Array.isArray(object.set) && name === 'has') return object.set.includes(args[0])
        if (Array.isArray(object) && name === 'concat') return object.concat(...args)
        if (Array.isArray(object) && name === 'includes') return object.includes(args[0])
        if (Array.isArray(object) && name === 'slice' && args.every((entry) => typeof entry === 'number')) return object.slice(...args)
      }
      return unknown('call is not inert declaration data', node)
    }
    return unknown(`unsupported AST ${node.type}`, node)
  }
  return { ast, source, file, root, bindings, mutableNames, mutationUncertainty: [...uncertainMutationUses], mutationOrigins, opaqueBindings, valueOf, evaluate, invokeData, originOf: (value, field = null) => value && typeof value === 'object' ? field ? fieldOrigins.get(value)?.get(field) : origins.get(value) : null }
}

// Backward value provenance is separate from declaration evaluation: an opaque runtime
// object is harmless unless its identity can carry dependency data to an import/loader.
// Bindings are lexical, not spellings shared by unrelated functions. No callback runs.
const sinkProvenance = (data, inputs) => {
  const bindingNames = (node) => {
    if (!node) return []
    if (node.type === 'Identifier') return [node.name]
    if (node.type === 'MemberExpression') return bindingNames(node.object)
    if (node.type === 'ObjectPattern') return node.properties.flatMap((part) => bindingNames(part.value || part.argument))
    if (node.type === 'ArrayPattern') return node.elements.flatMap(bindingNames)
    return bindingNames(node.left || node.argument)
  }
  const literalName = (node) => !node || node.type === 'Literal' || (node.type === 'TemplateLiteral' && !node.expressions.length) || (node.type === 'ArrayExpression' && node.elements.every(literalName))
  if (inputs.every(({ expression }) => literalName(expression))) return {
    uncertainty: [],
    reaches: () => false,
    irrelevant: data.opaqueBindings.flatMap(({ target }) => bindingNames(target).map((binding) => ({ binding, line: target.loc.start.line, reason: 'analysed-but-irrelevant binding: no value path reaches a dependency sink' }))),
  }
  const nodes = []
  const parents = new WeakMap()
  const scopes = new WeakMap()
  const byPosition = new Map()
  const declarationsByNode = new WeakMap()
  const values = new Map()
  const parameterValues = new Map()
  const scalarParameters = new Set()
  const links = new Map()
  const identities = new Map()
  const functions = new WeakMap()
  const constructors = new Map(['Map', 'Set', 'WeakMap', 'WeakSet'].map((name) => [name, { name }]))
  const globals = new Map([...constructors, ...['Object', 'Array', 'Math', 'JSON', 'Reflect'].map((name) => [name, { name }])])
  const isFunction = (node) => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)
  walk(data.ast, (node, parent) => {
    if (!node.type) return
    nodes.push(node)
    parents.set(node, parent)
    byPosition.set(`${node.start}:${node.end}:${node.type}`, node)
    const enclosing = parent && scopes.get(parent)
    scopes.set(node, node.type === 'Program' || isFunction(node) || ['BlockStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'CatchClause'].includes(node.type) ? { node, parent: enclosing, bindings: new Map() } : enclosing)
  })
  const edge = (from, to) => {
    if (!from || !to) return
    if (!links.has(from)) links.set(from, new Set())
    links.get(from).add(to)
  }
  const define = (pattern, scope, value = null) => {
    if (!pattern) return
    if (pattern.type === 'Identifier') {
      if (!scope.bindings.has(pattern.name)) scope.bindings.set(pattern.name, { name: pattern.name, scope, node: pattern })
      const binding = scope.bindings.get(pattern.name)
      declarationsByNode.set(pattern, binding)
      if (!values.has(binding)) values.set(binding, [])
      if (value) { values.get(binding).push(value); edge(binding, value) }
    } else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((part) => define(part.value || part.argument, scope, value))
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((part) => define(part, scope, value))
    else if (pattern.type === 'RestElement' || pattern.type === 'AssignmentPattern') define(pattern.argument || pattern.left, scope, value || pattern.right)
  }
  for (const node of nodes) {
    let scope = scopes.get(node)
    if (node.type === 'VariableDeclarator') {
      if (parents.get(node).kind === 'var') while (scope.parent && !isFunction(scope.node)) scope = scope.parent
      define(node.id, scope, node.init)
    } else if (isFunction(node)) {
      if (node.id) define(node.id, node.type === 'FunctionDeclaration' ? scope.parent : scope, node)
      node.params.forEach((parameter) => define(parameter, scope))
    } else if (node.type === 'ImportDeclaration') node.specifiers.forEach((part) => define(part.local, scope))
    else if (node.type === 'CatchClause') define(node.param, scope)
    else if (node.type === 'ClassDeclaration' && node.id) define(node.id, scope, node)
  }
  const bindingOf = (node) => {
    if (declarationsByNode.has(node)) return declarationsByNode.get(node)
    for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.bindings.has(node.name)) return scope.bindings.get(node.name)
    return null
  }
  const nativeReference = (node) => node?.type === 'Identifier' && !bindingOf(node) ? globals.get(node.name) : null
  const nativeConstructor = (node) => node?.type === 'Identifier' && !bindingOf(node) && !data.mutableNames.has(node.name) ? constructors.get(node.name) : null
  const nativeNamespace = (node, seen = new Set()) => {
    if (node?.type !== 'Identifier' || seen.has(node) || seen.size >= 32) return false
    const binding = bindingOf(node)
    if (!binding) return !data.mutableNames.has(node.name) && ['Object', 'Array', 'Math', 'JSON', 'Reflect'].includes(node.name) ? node.name : false
    if (data.mutableNames.has(binding.name)) return false
    const initializers = values.get(binding) || []
    if (initializers.length !== 1) return false
    const value = initializers[0]
    if (value.type === 'Identifier') return nativeNamespace(value, new Set([...seen, node]))
    const name = typeof value.arguments?.[0]?.value === 'string' ? value.arguments[0].value.replace(/^node:/, '') : null
    return value.type === 'CallExpression' && value.callee.name === 'require' && !bindingOf(value.callee) && NODE_BUILTINS.has(name) ? name : false
  }
  const nativeScalar = (node) => node.type === 'MemberExpression' && nativeNamespace(node.object) === 'path' && ['sep', 'delimiter'].includes(node.computed ? node.property.value : node.property.name)
  const memberValue = (node) => {
    let object = node.object
    const seen = new Set()
    while (object && ['Identifier', 'CallExpression'].includes(object.type) && !seen.has(object) && seen.size < 32) {
      seen.add(object)
      const initializers = object.type === 'Identifier' ? [...(values.get(bindingOf(object)) || []), ...(parameterValues.get(bindingOf(object)) || [])] : localFunctions(object.callee).flatMap(children)
      object = initializers.length === 1 ? initializers[0] : null
    }
    const key = node.computed ? node.property.type === 'Literal' ? node.property.value : null : node.property.name
    if (key === null || !object) return null
    if (object.type === 'ArrayExpression' && Number.isInteger(Number(key)) && !object.elements.some((part) => part?.type === 'SpreadElement')) return object.elements[Number(key)] || null
    if (object.type !== 'ObjectExpression' || object.properties.some((part) => part.type !== 'Property' || part.computed || part.kind !== 'init')) return null
    const members = object.properties.filter((part) => (part.key.name || part.key.value) === key)
    return members.length === 1 ? members[0].value : null
  }
  const children = (node) => {
    if (isFunction(node)) {
      if (functions.has(node)) return functions.get(node)
      const returned = []
      const visit = (part) => {
        if (!part || typeof part !== 'object' || (part !== node && isFunction(part))) return
        if (part.type === 'ReturnStatement') { if (part.argument) returned.push(part.argument); return }
        for (const [key, value] of Object.entries(part)) if (key !== 'loc') (Array.isArray(value) ? value : [value]).forEach(visit)
      }
      if (node.body.type !== 'BlockStatement') returned.push(node.body)
      else visit(node.body)
      functions.set(node, returned)
      return returned
    }
    if (nativeScalar(node)) return []
    if (node.type === 'MemberExpression') return memberValue(node) ? [memberValue(node)] : [node.object, ...(node.computed ? [node.property] : [])]
    if (node.type === 'Property') return [node.value, ...(node.computed ? [node.key] : [])]
    if (node.type === 'AssignmentExpression' && node.operator === '=') return [node.right]
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (sinkCalls.has(node)) return []
      if (handledIterations.has(node)) return [node.callee.object, ...localFunctions(node.arguments[0]).flatMap(children)]
      const visible = localFunctions(node.callee)
      return visible.length ? visible.flatMap(children) : [...node.arguments, ...(node.callee.type === 'MemberExpression' && !nativeNamespace(node.callee.object) ? [node.callee.object] : [])]
    }
    return Object.entries(node).filter(([key]) => !['loc', 'id', 'params', 'key'].includes(key)).flatMap(([, value]) => (Array.isArray(value) ? value : [value]).filter((part) => part && typeof part === 'object' && part.type))
  }
  let resolutionOverflow = false
  const localFunctions = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return []
    if (seen.size >= 64) { resolutionOverflow = true; return [] }
    const next = new Set([...seen, node])
    if (isFunction(node)) return [node]
    if (node.type === 'Identifier') return [...(values.get(bindingOf(node)) || []), ...(parameterValues.get(bindingOf(node)) || [])].flatMap((value) => localFunctions(value, next))
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return node.body.body.filter((part) => part.kind === 'constructor').map((part) => part.value)
    return []
  }
  const actual = (node) => node && byPosition.get(`${node.start}:${node.end}:${node.type}`)
  const sinkCalls = new Set(inputs.map(({ at }) => actual(at)))
  let budget = 200000
  const references = (node, seen = new Set()) => {
    if (!node || seen.has(node) || --budget < 0) return []
    const next = new Set([...seen, node])
    if (node.type === 'Identifier') return [bindingOf(node)].filter(Boolean)
    if (isFunction(node)) return []
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (sinkCalls.has(node)) return []
      return [...node.arguments.flatMap((argument) => references(argument, next)), ...localFunctions(node.callee).flatMap((fn) => children(fn).flatMap((value) => references(value, next)))]
    }
    // Object methods/accessors may return a shared value even though the enclosing
    // object is fresh. Keep that identity edge; do not execute the accessor.
    return children(node).flatMap((part) => isFunction(part) ? children(part).flatMap((value) => references(value, next)) : references(part, next))
  }
  const roots = (node) => {
    if (!node) return []
    if (node.type === 'Identifier') return [bindingOf(node) || nativeReference(node)].filter(Boolean)
    if (node.type === 'MemberExpression') return roots(node.object)
    if (node.type === 'ObjectPattern') return node.properties.flatMap((part) => roots(part.value || part.argument))
    if (node.type === 'ArrayPattern') return node.elements.flatMap(roots)
    return roots(node.left || node.argument)
  }
  const primitiveExpression = (node, active) => {
    if (!node) return true
    if ((node.type === 'Literal' && !node.regex) || ['TemplateLiteral', 'BinaryExpression', 'UnaryExpression'].includes(node.type) || nativeScalar(node) || nativeScalarResult(node)) return true
    if (node.type === 'Identifier') return !bindingOf(node) && ['__filename', '__dirname', 'undefined'].includes(node.name) ? true : primitiveBinding(bindingOf(node), active)
    const member = node.type === 'MemberExpression' && memberValue(node)
    return member ? primitiveExpression(member, active) : false
  }
  const primitiveBinding = (binding, active = new Set()) => {
    if (!binding || active.has(binding)) return false
    if (scalarParameters.has(binding)) return true
    const initializers = [...(values.get(binding) || []), ...(parameterValues.get(binding) || [])]
    if (initializers.length && initializers.every((value) => primitiveExpression(value, new Set([...active, binding])))) return true
    if (!binding.scope || binding.scope.parent) return false
    const value = data.valueOf(binding.name)
    return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
  }
  const identityOrigins = (node, seen = new Set()) => {
    if (!node || seen.has(node) || --budget < 0) return []
    const next = new Set([...seen, node])
    if (nativeScalar(node) || nativeScalarResult(node)) return []
    if (node.type === 'Identifier') return [bindingOf(node) || nativeReference(node)].filter(Boolean)
    if (['ObjectExpression', 'ArrayExpression'].includes(node.type)) return [node]
    if (node.type === 'MemberExpression') return memberValue(node) ? identityOrigins(memberValue(node), next) : roots(node.object)
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (sinkCalls.has(node)) return []
      if (freshNativeResult(node)) return [node]
      const visible = localFunctions(node.callee)
      return visible.length ? visible.flatMap((fn) => children(fn).flatMap((value) => identityOrigins(value, next))) : node.arguments.flatMap((argument) => identityOrigins(argument, next))
    }
    if (['Literal', 'TemplateLiteral', 'BinaryExpression', 'UnaryExpression'].includes(node.type) || isFunction(node)) return []
    return containedChildren(node).flatMap((part) => identityOrigins(part, next))
  }
  const alias = (target, value) => {
    for (const binding of roots(target)) {
      edge(binding, value)
      if (target.type === 'MemberExpression' || primitiveBinding(binding)) continue
      for (const origin of identityOrigins(value)) if (!primitiveBinding(origin)) {
        if (!identities.has(binding)) identities.set(binding, new Set())
        if (!identities.has(origin)) identities.set(origin, new Set())
        identities.get(binding).add(origin)
        identities.get(origin).add(binding)
      }
    }
  }
  const writes = new Set()
  const mutations = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'add', 'set', 'delete', 'clear'])
  const memberName = (node) => node.computed ? node.property.value : node.property.name
  const markWrite = (target) => {
    for (const value of [target, ...roots(target), ...identityOrigins(target), ...(target?.type === 'MemberExpression' ? identityOrigins(target.object) : [])].filter(Boolean)) writes.add(value)
  }
  const forward = (parameter, argument) => {
    for (const binding of roots(parameter)) {
      if (!parameterValues.has(binding)) parameterValues.set(binding, [])
      if (argument) parameterValues.get(binding).push(argument)
    }
    alias(parameter, argument)
  }
  const arrayElements = (expression, active = new Set()) => {
    if (!expression || active.has(expression) || active.size >= 32) return null
    const next = new Set([...active, expression])
    let choices
    if (expression.type === 'ArrayExpression') choices = expression.elements.map((part) => !part ? null : part.type === 'SpreadElement' ? arrayElements(part.argument, next) : [part])
    else if (expression.type === 'ConditionalExpression') choices = [expression.consequent, expression.alternate].map((part) => arrayElements(part, next))
    else if (expression.type === 'NewExpression' && nativeConstructor(expression.callee)?.name === 'Set') choices = [arrayElements(expression.arguments[0], next)]
    else if (expression.type === 'Identifier') choices = [...(values.get(bindingOf(expression)) || []), ...(parameterValues.get(bindingOf(expression)) || [])].map((value) => arrayElements(value, next))
    else if (handledIterations.has(expression)) {
      const method = memberName(expression.callee)
      if (method === 'map') return localFunctions(expression.arguments[0]).flatMap(children)
      if (method === 'flatMap') {
        const returned = localFunctions(expression.arguments[0]).flatMap(children)
        return returned.flatMap((value) => arrayElements(value, next) || [value])
      }
      if (method === 'filter') return arrayElements(expression.callee.object, next)
      return null
    }
    else return null
    return (choices.length || expression.type === 'ArrayExpression') && choices.every(Boolean) && choices.reduce((count, choice) => count + choice.length, 0) <= 4096 ? choices.flat() : null
  }
  const nativeCollection = (node) => {
    if (node.type !== 'NewExpression' || nativeConstructor(node.callee)?.name !== 'Set') return false
    const elements = arrayElements(node.arguments[0])
    return elements && elements.every((element) => primitiveExpression(element, new Set()))
  }
  const handledIterations = new Set()
  const knownSequence = (node, active = new Set(), arraysOnly = false) => {
    if (!node || active.has(node) || active.size >= 32) return false
    const next = new Set([...active, node])
    if (node.type === 'ArrayExpression' || (!arraysOnly && (node.type === 'TemplateLiteral' || (node.type === 'Literal' && typeof node.value === 'string')))) return true
    if (node.type === 'Identifier') {
      if (data.mutableNames.has(node.name)) return false
      const initializers = [...(values.get(bindingOf(node)) || []), ...(parameterValues.get(bindingOf(node)) || [])]
      return initializers.length > 0 && initializers.every((value) => knownSequence(value, next, arraysOnly))
    }
    return handledIterations.has(node) && ['map', 'flatMap', 'filter'].includes(memberName(node.callee))
  }
  const nativeStringify = (node) => node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && nativeNamespace(node.callee.object) === 'JSON' && memberName(node.callee) === 'stringify' && node.arguments.length <= 3 && (!node.arguments[1] || (node.arguments[1].type === 'Literal' && node.arguments[1].value === null)) && (!node.arguments[2] || (node.arguments[2].type === 'Literal' && ['number', 'string'].includes(typeof node.arguments[2].value)))
  const nativeScalarResult = (node) => {
    if (nativeStringify(node)) return true
    if (node.type === 'MemberExpression' && memberName(node) === 'length' && knownSequence(node.object)) return true
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return false
    return memberName(node.callee) === 'join' && !data.mutableNames.has('Array') && knownSequence(node.callee.object, new Set(), true)
  }
  const freshNativeResult = (node) => (handledIterations.has(node) && ['map', 'flatMap', 'filter'].includes(memberName(node.callee))) || (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && nativeNamespace(node.callee.object) === 'Object' && ['keys', 'values', 'entries', 'fromEntries'].includes(memberName(node.callee)))
  // Containment is not value derivation: copied keys, conditions and source arrays
  // cannot be recovered as pointers from the resulting object or scalar.
  const containedChildren = (node) => {
    if (node.type === 'Property') return [node.value]
    if (node.type === 'MemberExpression') return memberValue(node) ? [memberValue(node)] : [node.object]
    if (node.type === 'AssignmentExpression' && node.operator === '=') return [node.right]
    if (node.type === 'ConditionalExpression') return [node.consequent, node.alternate]
    if (node.type === 'SequenceExpression') return node.expressions.slice(-1)
    if (handledIterations.has(node)) {
      const method = memberName(node.callee)
      if (['map', 'flatMap', 'filter'].includes(method)) return arrayElements(node) || [node.callee.object]
      if (method === 'find') return arrayElements(node.callee.object) || [node.callee.object]
      return []
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && nativeNamespace(node.callee.object) === 'Object' && memberName(node.callee) === 'fromEntries') {
      const entries = arrayElements(node.arguments[0])
      const pairs = entries?.map((entry) => arrayElements(entry))
      if (pairs?.every(Boolean)) return pairs.flatMap((pair) => pair.slice(1, 2))
    }
    return children(node)
  }
  const opaqueEvaluation = nodes.some((node) => ['CallExpression', 'NewExpression'].includes(node.type) && ['eval', 'Function'].includes(node.callee.name) && !bindingOf(node.callee))
  const callbackThis = new WeakMap()
  const usesThis = (fn) => {
    if (!callbackThis.has(fn)) { let found = false; walk(fn.body, (node) => { if (node.type === 'ThisExpression') found = true }); callbackThis.set(fn, found) }
    return callbackThis.get(fn)
  }
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator') alias(node.id, node.init)
    if (node.type === 'AssignmentExpression') alias(node.left, node.right)
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) markWrite(node.left || node.argument)
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') alias(node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left, node.right)
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') continue
    if (node.callee.type === 'MemberExpression' && (mutations.has(memberName(node.callee)) || (node.callee.computed && typeof memberName(node.callee) !== 'string'))) markWrite(node.callee.object)
    if (node.callee.type === 'MemberExpression' && !node.callee.computed && ['Object', 'Reflect'].includes(node.callee.object.name) && !bindingOf(node.callee.object) && ['assign', 'defineProperty', 'defineProperties', 'set'].includes(memberName(node.callee))) markWrite(node.arguments[0])
    for (const fn of localFunctions(node.callee)) fn.params.forEach((parameter, index) => forward(parameter, parameter.type === 'RestElement' ? { type: 'ArrayExpression', elements: node.arguments.slice(index) } : node.arguments[index]))
    if (node.callee.type !== 'MemberExpression' || node.callee.computed || !['map', 'flatMap', 'filter', 'forEach', 'every', 'some', 'find', 'findIndex'].includes(memberName(node.callee))) continue
    const elements = arrayElements(node.callee.object)
    const callbacks = localFunctions(node.arguments[0])
    if (!elements || !callbacks.length || opaqueEvaluation || data.mutableNames.has('Array') || node.arguments.length !== 1 || callbacks.some((fn) => usesThis(fn) || fn.params.some((parameter) => parameter.type === 'RestElement'))) continue
    handledIterations.add(node)
    for (const fn of callbacks) {
      if (fn.params[0]) {
        elements.forEach((element) => forward(fn.params[0], element))
      }
      if (fn.params[1]) roots(fn.params[1]).forEach((binding) => scalarParameters.add(binding))
      if (fn.params[2]) forward(fn.params[2], node.callee.object)
    }
  }
  const tainted = new Set()
  const pending = inputs.map(({ expression }) => actual(expression)).filter(Boolean)
  const identityTaint = new Set()
  const identityPending = []
  const stored = new Set()
  while (pending.length) {
    const node = pending.pop()
    if (tainted.has(node)) continue
    tainted.add(node)
    if (node.type === 'Identifier') pending.push(...[bindingOf(node)].filter(Boolean))
    identityPending.push(node)
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee.type === 'MemberExpression' && nativeNamespace(node.callee.object)) identityPending.push(...roots(node.callee.object))
    if (node.type === 'NewExpression' && nativeConstructor(node.callee)) identityPending.push(nativeConstructor(node.callee))
    if (handledIterations.has(node)) identityPending.push(globals.get('Array'))
    if (node.type === 'MemberExpression') for (const binding of roots(node.object)) {
      if (binding.scope && !binding.scope.parent && (values.get(binding) || []).some((value) => ['ObjectExpression', 'ArrayExpression'].includes(value.type))) stored.add(binding)
      identityPending.push(binding)
    }
    pending.push(...(links.get(node) || []), ...(node.type ? children(node) : []))
  }
  while (identityPending.length) {
    const node = identityPending.pop()
    if (identityTaint.has(node)) continue
    identityTaint.add(node)
    identityPending.push(...(identities.get(node) || []))
  }
  const carriesDependency = (node) => tainted.has(node) || identityTaint.has(node)
  // Once a name lives in module storage, an unresolved mutable alias can hide a
  // write through that storage from another function. Retain the old barrier there.
  const storageBarrier = stored.size > 0
  const relevant = ({ reason, nodes: origins }) => budget < 0 || storageBarrier || origins.some((node) => carriesDependency(node) || (/^unresolved mutable (?:member )?alias /.test(reason) ? roots(node) : references(node)).some(carriesDependency))
  const escapeCache = new WeakMap()
  const escapeReferences = (expression) => {
    if (!expression || budget < 0) return []
    const start = expression.type === 'Identifier' ? bindingOf(expression) || expression : expression
    if (escapeCache.has(start)) return escapeCache.get(start)
    const pending = [start]
    const seen = new Set()
    const found = new Set()
    while (pending.length && --budget >= 0) {
      const node = pending.pop()
      if (seen.has(node)) continue
      seen.add(node)
      if (escapeCache.has(node)) { escapeCache.get(node).forEach((value) => found.add(value)); continue }
      if (node.type ? primitiveExpression(node, new Set()) : primitiveBinding(node)) continue
      if (node.type === 'SpreadElement') {
        const elements = arrayElements(node.argument)
        if (elements) { pending.push(...elements); continue }
      }
      if (carriesDependency(node)) found.add(node)
      const related = [...(links.get(node) || []), ...(identities.get(node) || []), ...(node.type === 'Identifier' ? [bindingOf(node) || nativeReference(node)].filter(Boolean) : []), ...(node.type ? containedChildren(node) : [])]
      pending.push(...related)
    }
    const result = [...found]
    if (budget >= 0) {
      escapeCache.set(start, result)
      if (!result.length) seen.forEach((node) => escapeCache.set(node, result))
    }
    return result
  }
  const uncertainty = data.mutationOrigins.filter(relevant).map(({ reason }) => reason)
  for (const binding of writes) if (escapeReferences(binding).length) uncertainty.push('dependency-tainted binding can be mutated: ' + (binding.name || 'stored value'))
  for (const node of nodes) {
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !roots(node.left).length && escapeReferences(node.right).length) uncertainty.push('dependency-tainted value escapes through unresolved object storage at line ' + node.loc.start.line)
    if (!['CallExpression', 'NewExpression'].includes(node.type) || sinkCalls.has(node) || localFunctions(node.callee).length || nativeCollection(node) || handledIterations.has(node)) continue
    const callee = node.callee
    const native = nativeStringify(node) || (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && !bindingOf(callee.object) && !data.mutableNames.has(callee.object.name) && ((callee.object.name === 'Object' && ['entries', 'values', 'keys', 'fromEntries'].includes(memberName(callee))) || (callee.object.name === 'Array' && memberName(callee) === 'isArray') || (callee.object.name === 'Math' && memberName(callee) === 'floor')))
    const inertReceiver = callee.type === 'MemberExpression' && !callee.computed && (mutations.has(memberName(callee)) || ['concat', 'includes', 'slice', 'join', 'indexOf'].includes(memberName(callee)))
    const escaped = [...node.arguments.flatMap((argument) => escapeReferences(argument)), ...(callee.type === 'MemberExpression' && !native && !inertReceiver && !nativeNamespace(callee.object) ? roots(callee.object) : [])].filter((binding) => carriesDependency(binding) && !(binding.type ? primitiveExpression(binding, new Set()) : primitiveBinding(binding)))
    if (!native && escaped.length) uncertainty.push('dependency-tainted value escapes to an unresolved call at line ' + node.loc.start.line + ': ' + [...new Set(escaped.map((binding) => binding.name || 'stored value'))].join(', '))
  }
  if (storageBarrier && uncertainty.length) uncertainty.push('module-level dependency storage has unresolved alias provenance: ' + [...stored].map((binding) => binding.name).join(', '))
  if (budget < 0 || resolutionOverflow) uncertainty.push('dependency provenance expansion exceeded its bound')
  const irrelevant = data.opaqueBindings.flatMap(({ target }) => roots(target).filter((binding) => !carriesDependency(binding) && !storageBarrier && budget >= 0 && !resolutionOverflow).map((binding) => ({
    binding: binding.name, line: target.loc.start.line, reason: 'analysed-but-irrelevant binding: no value path reaches a dependency sink',
  })))
  return { uncertainty: [...new Set(uncertainty)], irrelevant, reaches: (node) => carriesDependency(actual(node)) }
}

const repoFiles = (root) => {
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = normalize(path.join(directory, entry.name))
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(relative)
      else if (entry.isFile() && /\.(?:js|mjs|vue|json|css|styl|scss|html|ts|md|py|ps1|sh|txt|yml|yaml|svg)$/.test(entry.name)) found.push(relative)
    }
  }
  for (const directory of ['src', 'scripts']) {
    if (fs.existsSync(path.join(root, directory))) visit(directory)
  }
  for (const file of ['package.json', 'bun.lock']) { if (fs.existsSync(path.join(root, file))) found.push(file) }
  return found.sort()
}

// Regexes are source data too. A malformed or expensive pattern never stalls discovery or becomes a valid anchor.
const matches = (text, anchor, milliseconds = 1000) => {
  if (typeof anchor.from === 'string') {
    if (!anchor.from.length) return Promise.resolve({ error: 'empty anchor' })
    return Promise.resolve({ count: text.split(anchor.from).length - 1 })
  }
  if (!anchor.from || typeof anchor.from.regex !== 'string') return Promise.resolve({ deferred: true })
  return new Promise((resolve) => {
    const worker = new Worker("const { parentPort, workerData } = require('worker_threads'); try { const r = new RegExp(workerData.pattern, workerData.flags.replace(/g/g, '') + 'g'); let n = 0; for (const m of workerData.text.matchAll(r)) { if (++n > 4096 || !m[0].length) throw Error('unbounded or empty regex anchor') } parentPort.postMessage({ count: n }) } catch (e) { parentPort.postMessage({ error: e.message }) }", { eval: true, workerData: { text, pattern: anchor.from.regex, flags: anchor.from.flags || '' } })
    const finish = (result) => { clearTimeout(timer); worker.terminate(); resolve(result) }
    worker.once('message', finish)
    worker.once('error', (error) => finish({ error: error.message }))
    const timer = setTimeout(() => finish({ error: 'regex validation exceeded its bound' }), milliseconds)
  })
}

const canonical = (value) => JSON.stringify(value)
const seal = (plan) => ({ ...plan, digest: hash(canonical(plan)) })
const checkSeal = (plan) => {
  const { digest, ...body } = plan
  if (digest !== hash(canonical(body))) throw new Error('the dependency plan was changed or has no valid digest')
}

// Frozen audited loaders produce generated module URLs from caller source domains. A source
// change invalidates this bounded contract and needs review; it cannot bless new dynamic imports.
const DOMAIN_IMPORT_CONTRACTS = {
  'scripts/lib/utilities.js': {
    sha256: 'f3026034ab19ada93c053371cc79b43bf5d8c88cc62d12e5828cdbd6bb0e7cc6',
    callerLoads: ['loadUtilities'],
    dependencies: ['scripts/lib/module-files.js'],
    reason: 'audited utility URL caches implement the public caller module/source domain',
    expressions: {
      'moduleUrl(path.posix.normalize(name), urls, stubs, read, sources, urlOfSource)': [],
    },
  },
  'scripts/lib/page-loader.js': {
    sha256: ['d3e64494c957b916f13075a914079401a5f3e269d5978a1cf1a9348c4d527bcc', '8e4f08df57ad018e7a93083027f33d5ffcda285504233e41f7c76bdebc2cb36f'],
    callerLoads: ['loadPage', 'loadModule', 'loadModules'],
    dependencies: ['scripts/lib/module-files.js'],
    reason: 'audited page URL caches implement the public caller module/source domain',
    expressions: {
      'moduleUrl(path.posix.normalize(name), context)': [],
    },
  },
  'scripts/lib/page-server.js': {
    sha256: 'c6fe0b8cd37bc043362b884c53cb8398c0aae6ee11076cc1375d74fb3b76462d',
    expressions: {
      "pathToFileURL(path.join(base, 'scripts', 'renderer-config.mjs')).href": [
        'scripts/renderer-config.mjs',
      ],
    },
  },
  'scripts/check-browser-observe.js': {
    sha256: 'd57ebac22a73bbda0c7f95769ce6107f07f90cc8a17387395b8ae15c0b1845ea',
    expressions: {
      file: [
        'scripts/lib/browser-observe.js',
      ],
    },
  },
  'scripts/check-fault-credit.js': {
    sha256: 'b23b90079b6b4241a80d6a8aca5031ae936c55df3f94a4be0270d34f1c89ae66',
    expressions: {
      "path.join(folder, 'fault-credit.js')": [
        'scripts/lib/fault-credit.js',
      ],
      "path.join(folder, 'browser-observe.js')": [
        'scripts/lib/browser-observe.js',
      ],
      "path.join(folder, 'mutant-source.js')": [
        'scripts/lib/mutant-source.js',
      ],
    },
  },
  'scripts/check-no-mutations.js': {
    sha256: 'e1c05da332f09f2d2fb6d0f24ed59aa06bfe433119d1cc55fd3f5190dbf07b3c',
    expressions: {
      "path.join(directory, 'no-mutations.js')": [
        'scripts/lib/no-mutations.js',
      ],
      "path.join(directory, 'mutant-source.js')": [
        'scripts/lib/mutant-source.js',
      ],
    },
  },
  'scripts/check-loader-isolation.js': {
    sha256: ['bf2a99d843725bb4620e3dd99ac15e698c1b8e2cc942d43904b2b795d2b3d561', '4d60a716532e9b386787e594f0604aecd6b25c148d6d3190fe1d9e16499eb865', '62f3cebb5e8b59d5c082882477658507f92e12d059873d6b8f722d0e387c0b70'],
    expressions: {
      "path.join(ROOT, 'scripts/lib/fault-credit')": [
        'scripts/lib/fault-credit.js',
      ],
      "path.join(ROOT, 'scripts/lib/mutant-source')": [
        'scripts/lib/mutant-source.js',
      ],
      "path.join(ROOT, 'scripts/lib/check-pool')": [
        'scripts/lib/check-pool.js',
      ],
      "path.join(ROOT, 'scripts/lib/no-mutations')": [
        'scripts/lib/no-mutations.js',
      ],
      root: [],
    },
  },
  // Both reviewed versions execute the copied runner/fixture in a VM. Their require
  // callbacks are supplied only to those factories; copied helpers remain executable edges.
  'scripts/check-suite-runner.js': {
    sha256: ['6f477c9cb8a1bcefaa032261dc7746ca5c4d95ba29a2274e171b454f76d72cdc', 'bfd6995d5c10499a36c7e628188b6b3e76b40310b27d5692648872c3d88345ae'],
    reason: 'audited VM callback closure executes the runner, its fixture and copied helpers',
    expressions: {
      name: ['scripts/lib/suite-runner.js', 'scripts/lib/suite-runner-fixture.js', 'scripts/lib/check-pool.js', 'scripts/lib/browser-observe.js'],
    },
  },
  'scripts/check-transpiler-cache.js': {
    sha256: '6cb15fe956efe4627bbfcd871cfa7bec427505ebd9f8b2345360fe94eafb3cc1',
    expressions: {
      root: [],
    },
  },
  'scripts/check-map-hierarchy.js': {
    sha256: '5615b27634c86714b8c2f93285937116a580788e66d4cd7b645fd9e9106f53fe',
    expressions: {
      'dataUrl(unique(PERSISTED_VIEW))': [
        'src/renderer/mixins/persisted-view.js',
      ],
    },
  },
  'scripts/check-save-switching.js': {
    sha256: ['893378d6fefb7285faf8aefdd6cba0074e5c847877e29fbec411d9323acbda07', '1a28d38106b0520784c20115ff0178e2714c20f17488d58f81a4d735d7dedaed'],
    expressions: {
      'dataUrl(source)': [
        'scripts/web/shims/chokidar.js',
      ],
    },
  },
  'scripts/check-typography.js': {
    sha256: '40b28ab33c6b5b0fa37f74e58a166c845b8457ec17c96e6ac97c807711753fbe',
    expressions: {
      url: [
        'src/renderer/utilities/appearance-font.js',
      ],
    },
  },
  'scripts/check-planner-links.js': {
    sha256: '97df1e526872154ed410421cfd71d9d0cba578ada90cb270b2d87b4c611da200',
    expressions: {
      "path.join(root, 'node_modules', 'vue', 'compiler-sfc')": [],
    },
  },
  'scripts/check-sensor-modes.js': {
    sha256: 'b0f51a02b55c99404b657b6d6ff9f9b0abfa133a5c30f8e6de009992abdd6b78',
    expressions: {
      "path.join(root, 'node_modules', 'vue', 'compiler-sfc')": [],
    },
  },
}
const importContractMatches = (contract, source) => {
  const accepted = Array.isArray(contract?.sha256) ? contract.sha256 : [contract?.sha256]
  return accepted.includes(hash(source.replace(/\r\n/g, '\n')))
}
const auditedImportTargets = (contract, source, expression) => {
  if (!importContractMatches(contract, source) || !own(contract.expressions, expression)) return null
  return contract.expressions[expression]
}

// Imports/loaders execute their targets; source/fixture reads are terminal edges. Reading a
// planted check's text does NOT import that check's helpers, even if its descriptor quotes require().
const dependencyGraph = (sources, root = '.', knownFiles = Object.keys(sources), availableSources = sources) => {
  const graph = new Map()
  const reads = new Map()
  const unresolved = []
  const contracts = []
  const analysedBindings = []
  const names = new Set(knownFiles)
  const resolve = (target) => [target, ...['.js', '.mjs', '.vue', '.json', '.ts', '/index.js'].map((suffix) => target + suffix)].find((entry) => names.has(entry))
  for (const [file, text] of Object.entries(sources)) {
    if (!/\.(?:js|mjs|vue|ts)$/.test(file) || file.endsWith('.d.ts')) continue
    let tree
    let data
    let script = text
    try {
      if (file.endsWith('.vue')) {
        const parsed = require('vue/compiler-sfc').parse({ source: text })
        const component = parsed.descriptor || parsed
        script = [component.script?.content, component.scriptSetup?.content].filter(Boolean).join('\n')
      }
      tree = parse(script)
    } catch {
      unresolved.push({ file, line: 1, reason: 'dependency source syntax could not be parsed' })
      continue
    }
    const edges = new Set()
    const terminal = new Set()
    const helperContract = DOMAIN_IMPORT_CONTRACTS[file]
    if (helperContract?.callerLoads && importContractMatches(helperContract, text)) {
      // These exact programs load caller-selected renderer sources, not cache values as
      // independent module names. Public calls below own those edges, including their
      // recursive source imports and overrides. Keep the helper's own static dependencies.
      for (const target of helperContract.dependencies) {
        const exact = resolve(target)
        if (exact) edges.add(exact)
        else unresolved.push({ file, line: 1, reason: 'audited loader helper dependency is missing', target })
      }
      for (const metadata of ['package.json', 'bun.lock']) if (names.has(metadata)) edges.add(metadata)
      for (const expression of Object.keys(helperContract.expressions)) contracts.push({ file, line: script.slice(0, script.indexOf(expression)).split('\n').length, expression, targets: [], callerLoads: helperContract.callerLoads, sourceHash: hash(text.replace(/\r\n/g, '\n')), reason: helperContract.reason })
      graph.set(file, edges)
      reads.set(file, terminal)
      continue
    }
    const dependencyInputs = []
    const mutableDependencyIssues = []
    const localScopes = []
    const nodes = []
    const parents = new WeakMap()
    walk(tree, (node, parent) => { nodes.push(node); parents.set(node, parent) })
    for (const scope of nodes) {
      if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'ForOfStatement'].includes(scope.type)) continue
      const identifiers = new Set()
      const take = (pattern) => {
        if (!pattern) return
        if (pattern.type === 'Identifier') identifiers.add(pattern.name)
        else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((entry) => take(entry.value || entry.argument))
        else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(take)
        else if (pattern.type === 'AssignmentPattern') take(pattern.left)
        else if (pattern.type === 'RestElement') take(pattern.argument)
      }
      ;(scope.params || []).forEach(take)
      if (scope.type === 'ForOfStatement' && scope.left.type === 'VariableDeclaration') scope.left.declarations.forEach((entry) => take(entry.id))
      if (scope.type === 'BlockStatement') scope.body.filter((part) => part.type === 'VariableDeclaration').forEach((part) => part.declarations.forEach((entry) => take(entry.id)))
      else walk(scope.body, (part) => { if (part.type === 'VariableDeclaration' && part.kind === 'var') part.declarations.forEach((entry) => take(entry.id)) })
      if (identifiers.size) localScopes.push({ scope, identifiers })
    }
    const variablesByName = new Map()
    const blocks = localScopes.filter(({ scope }) => ['BlockStatement', 'ForOfStatement'].includes(scope.type)).sort((a, b) => b.scope.start - a.scope.start)
    const copiedSources = []
    for (const node of nodes) {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const scope = blocks.find(({ scope }) => scope.start <= node.start && scope.end >= node.end)?.scope || tree
        if (!variablesByName.has(node.id.name)) variablesByName.set(node.id.name, [])
        variablesByName.get(node.id.name).push({ entry: node, scope })
      }
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || !['writeFileSync', 'copyFileSync'].includes(node.callee.property.name)) continue
      const destination = node.arguments[node.callee.property.name === 'copyFileSync' ? 1 : 0]
      if (destination?.type !== 'CallExpression' || destination.callee.property?.name !== 'join') continue
      const tail = destination.arguments.filter((part) => part.type === 'Literal' && typeof part.value === 'string').map((part) => part.value).join('/')
      copiedSources.push({ tail, call: node })
    }
    const valueAt = (expression, at, scoped = true, injected = {}) => {
      if (!expression) return unknown('missing loader argument')
      if (expression.type === 'Literal') return expression.value
      try {
        data ||= declarations(script, file, root, knownFiles)
        const references = new Set()
        walk(expression, (part) => { if (part.type === 'Identifier') references.add(part.name) })
        const containing = localScopes.filter(({ scope }) => scope.start <= at.start && scope.end >= at.end).sort((a, b) => a.scope.start - b.scope.start || b.scope.end - a.scope.end)
        if (scoped && containing.some(({ identifiers }) => [...identifiers].some((name) => references.has(name)))) return unknown('local import binding has no inert scope')
        const environment = { ...injected }
        if (!scoped) {
          for (const { scope, identifiers } of containing) {
            for (const name of identifiers) if (!own(injected, name)) environment[name] = unknown('unresolved local loader binding ' + name)
            if (scope.type !== 'BlockStatement') continue
            for (const statement of scope.body) {
              if (statement.start >= at.start || statement.type !== 'VariableDeclaration') continue
              for (const entry of statement.declarations) if (entry.id.type === 'Identifier') environment[entry.id.name] = data.evaluate(entry.init, environment)
            }
          }
        }
        return data.evaluate(expression, environment)
      } catch { return unknown('unparsed dependency expression') }
    }
    // Follow finite named parameter forwarding without running a function. Unknown
    // callers, recursion and an expansion limit remain unknown; literal callers are unioned.
    let resolutionBudget = 4096
    let branchIdentity = 0
    const possibleValues = (expression, at, active = new Set()) => {
      if (--resolutionBudget < 0) return [unknown('loader resolution budget exceeded')]
      if (expression?.type === 'ConditionalExpression') return [...possibleValues(expression.consequent, at, active), ...possibleValues(expression.alternate, at, active)]
      const value = valueAt(expression, at, false)
      if (expression?.type === 'Identifier' && data?.mutableNames.has(expression.name)) return [unknown('dependency binding can be mutated: ' + expression.name)]
      if (!isUnknown(value) && !(Array.isArray(value) && value.some(isUnknown))) return [value]
      if (!expression || active.size >= 16) return [unknown('loader parameter resolution exceeded its bound')]
      const key = `${expression.start}:${at.start}:${expression.discoveryBranch || 0}`
      if (active.has(key)) return [unknown('recursive loader parameter')]
      const next = new Set([...active, key])
      if (expression.type === 'Identifier' && !localScopes.some(({ scope }) => scope.params && scope.start <= at.start && scope.end >= at.end && scope.params.some((parameter) => (parameter.type === 'AssignmentPattern' ? parameter.left : parameter).name === expression.name))) {
        const init = initializerAt(expression.name, at)
        if (init && init !== expression) return possibleValues(init, at, next)
      }
      let conditional = null
      walk(expression, (part) => { if (!conditional && part.type === 'ConditionalExpression') conditional = part })
      if (conditional) {
        const replace = (node, branch) => {
          if (node === conditional) return branch
          if (!node || typeof node !== 'object') return node
          if (Array.isArray(node)) return node.map((part) => replace(part, branch))
          return Object.fromEntries(Object.entries(node).map(([name, value]) => [name, name === 'loc' ? value : replace(value, branch)]))
        }
        const choices = [conditional.consequent, conditional.alternate].flatMap((branch) => possibleValues({ ...replace(expression, branch), discoveryBranch: ++branchIdentity }, at, next))
        return choices.length <= 256 ? choices : [unknown('conditional loader domain exceeds 256 alternatives')]
      }
      const references = new Set()
      walk(expression, (part) => { if (part.type === 'Identifier') references.add(part.name) })
      let environments = [{}]
      let resolved = false
      for (const name of references) {
        const loopValues = []
        walk(tree, (loop) => {
          if (loop.type !== 'ForOfStatement' || loop.start > at.start || loop.end < at.end || loop.left.type !== 'VariableDeclaration') return
          const pattern = loop.left.declarations[0].id
          const take = (binding, given) => {
            if (!binding) return
            if (binding.type === 'Identifier') { if (binding.name === name) loopValues.push(given); return }
            if (binding.type === 'AssignmentPattern') { take(binding.left, given === undefined ? valueAt(binding.right, at, false) : given); return }
            if (binding.type === 'ArrayPattern') binding.elements.forEach((part, index) => take(part, isUnknown(given) ? given : given?.[index]))
            if (binding.type === 'ObjectPattern') binding.properties.forEach((part) => take(part.value, isUnknown(given) ? given : given?.[part.key.name || part.key.value]))
          }
          for (const rows of possibleValues(loop.right, loop, next)) {
            if (Array.isArray(rows)) rows.forEach((row) => take(pattern, row))
            else take(pattern, unknown('unresolved loader iteration domain'))
          }
        })
        if (loopValues.length) {
          resolved = true
          if (environments.length * loopValues.length > 256) return [unknown('loader iteration domain exceeds 256 alternatives')]
          environments = environments.flatMap((environment) => loopValues.map((choice) => ({ ...environment, [name]: choice })))
          continue
        }
        const containing = localScopes.filter(({ scope }) => scope.params && scope.start <= at.start && scope.end >= at.end).sort((a, b) => b.scope.start - a.scope.start)
        const owner = containing.find(({ scope }) => scope.params.some((parameter) => (parameter.type === 'AssignmentPattern' ? parameter.left : parameter).name === name))?.scope
        if (!owner) continue
        const index = owner.params.findIndex((parameter) => (parameter.type === 'AssignmentPattern' ? parameter.left : parameter).name === name)
        let ownerName = owner.id?.name
        if (!ownerName) walk(tree, (entry) => { if (entry.type === 'VariableDeclarator' && entry.init === owner && entry.id.type === 'Identifier') ownerName = entry.id.name })
        if (!ownerName) continue
        const values = []
        walk(tree, (call) => {
          if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== ownerName) return
          const argument = call.arguments[index] || (owner.params[index].type === 'AssignmentPattern' ? owner.params[index].right : null)
          values.push(...possibleValues(argument, call, next))
        })
        if (!values.length) values.push(unknown('loader parameter has no statically named caller'))
        resolved = true
        if (environments.length * values.length > 256) return [unknown('loader caller domain exceeds 256 alternatives')]
        environments = environments.flatMap((environment) => values.map((choice) => ({ ...environment, [name]: choice })))
      }
      return resolved ? environments.map((environment) => valueAt(expression, at, false, environment)) : [value]
    }
    const initializerAt = (name, at) => {
      let found = data?.bindings.get(name)
      let closest = -1
      for (const { entry, scope } of variablesByName.get(name) || []) {
        if (entry.start < at.start && scope.start <= at.start && scope.end >= at.end && scope.start >= closest) { found = entry.init; closest = scope.start }
      }
      return found
    }
    const originFiles = (expression, at, active = new Set()) => {
      if (!expression || active.has(expression) || active.size > 64) return []
      const next = new Set([...active, expression])
      const value = valueAt(expression, at, false)
      if (typeof value === 'string' && value.length < 512 && !/[\r\n]/.test(value)) {
        const relative = normalize(path.isAbsolute(value) ? path.relative(root, value) : value)
        const candidates = [relative, 'src/renderer/' + relative, 'src/renderer/utilities/' + relative]
        const exact = candidates.map(resolve).find(Boolean)
        if (exact) return [exact]
        if (/\.(?:vue|js|mjs|json)$/.test(relative) && !relative.startsWith('../')) return knownFiles.filter((candidate) => candidate.endsWith('/' + relative))
      }
      if (expression.type === 'Identifier') return originFiles(initializerAt(expression.name, at), at, next)
      if (expression.type === 'ConditionalExpression') return [...originFiles(expression.consequent, at, next), ...originFiles(expression.alternate, at, next)]
      if (expression.type === 'CallExpression') {
        const propertyName = expression.callee.type === 'MemberExpression' ? expression.callee.property.name : null
        if (['readFileSync', 'readFile'].includes(propertyName)) return originFiles(expression.arguments[0], at, next)
        if (propertyName === 'join' && expression.callee.object.name === 'path') return literalSuffixTargets(expression, at)
        // Text transformations keep their receiver's origin, never that of replacement text.
        if (['replace', 'replaceAll', 'split', 'join', 'slice', 'substring', 'toString'].includes(propertyName)) return originFiles(expression.callee.object, at, next)
        return expression.arguments.flatMap((argument) => originFiles(argument, at, next))
      }
      if (expression.type === 'MemberExpression') {
        const key = expression.computed ? valueAt(expression.property, at, false) : expression.property.name
        const container = expression.object.type === 'Identifier' ? initializerAt(expression.object.name, at) : expression.object
        const member = property(container, key)
        return member ? originFiles(member.value, at, next) : originFiles(expression.property, at, next)
      }
      return []
    }
    const optionsNode = (expression, at) => expression?.type === 'Identifier' ? initializerAt(expression.name, at) : expression
    const sourceNode = (options, name, at) => {
      const sources = property(optionsNode(options, at), 'sources')?.value
      return property(optionsNode(sources, at), name)?.value
    }
    const copyOriginCache = new Map()
    const copiedOrigins = (name) => {
      if (!copyOriginCache.has(name)) copyOriginCache.set(name, [...new Set(copiedSources.filter(({ tail }) => tail.endsWith(name)).flatMap(({ call }) => originFiles(call.arguments[call.callee.property.name === 'copyFileSync' ? 0 : 1], call)))])
      return copyOriginCache.get(name)
    }
    const add = (target, node, into = edges) => {
      const exact = resolve(normalize(target))
      if (exact) {
        into.add(exact)
        if (!(exact in availableSources)) unresolved.push({ file, target: exact, line: node.loc.start.line, reason: 'imported source was removed from candidate' })
      } else {
        into.add(normalize(target))
        unresolved.push({ file, target: normalize(target), line: node.loc.start.line, reason: 'declared local import source is absent from snapshot' })
      }
    }
    const literalSuffixTargets = (expression, at) => {
      const origin = expression?.type === 'Identifier' ? initializerAt(expression.name, at) : expression
      if (origin?.type !== 'CallExpression' || origin.callee.type !== 'MemberExpression' || origin.callee.object.name !== 'path' || !['join', 'resolve'].includes(origin.callee.property.name)) return []
      const namespace = data?.bindings.get('path')
      if (namespace?.callee?.name !== 'require' || !['path', 'node:path'].includes(namespace.arguments[0]?.value) || localScopes.some(({ scope, identifiers }) => scope.start <= at.start && scope.end >= at.end && identifiers.has('path'))) return []
      const parts = []
      for (let index = origin.arguments.length - 1; index >= 0; index--) {
        const value = valueAt(origin.arguments[index], at, false)
        if (typeof value !== 'string') break
        parts.unshift(value)
      }
      if (!parts.length) return []
      const suffix = normalize(path.join(...parts)).replace(/^(?:\.\.\/)+/, '')
      const endings = [suffix, ...['.js', '.mjs', '.vue', '.json', '.ts', '/index.js'].map((extension) => suffix + extension)]
      return knownFiles.filter((candidate) => endings.some((ending) => candidate === ending || candidate.endsWith('/' + ending)))
    }
    const pureDataUrlTargets = (expression, at) => {
      if (expression?.type !== 'CallExpression' || expression.callee.type !== 'Identifier' || expression.arguments.length !== 1) return []
      const encoder = initializerAt(expression.callee.name, at)
      const parameter = encoder?.params?.[0]
      let body = encoder?.body
      if (body?.type === 'BlockStatement' && body.body.length === 1 && body.body[0].type === 'ReturnStatement') body = body.body[0].argument
      const encoded = body?.type === 'TemplateLiteral' ? body.expressions[0] : null
      const from = encoded?.callee?.object
      const validDataUrl = encoder?.params?.length === 1 && parameter?.type === 'Identifier' && parameter.name !== 'Buffer' && body?.type === 'TemplateLiteral' && body.quasis.length === 2 && body.quasis[0].value.cooked === 'data:text/javascript;base64,' && body.quasis[1].value.cooked === '' && encoded?.type === 'CallExpression' && encoded.arguments.length === 1 && encoded.arguments[0].value === 'base64' && !encoded.callee.computed && encoded.callee.property?.name === 'toString' && from?.type === 'CallExpression' && from.arguments.length === 1 && from.arguments[0].name === parameter.name && !from.callee.computed && from.callee.object?.name === 'Buffer' && from.callee.property?.name === 'from' && !data?.bindings.has('Buffer') && !localScopes.some(({ scope, identifiers }) => scope.start <= at.start && scope.end >= at.end && (identifiers.has('Buffer') || (scope.params && identifiers.has(expression.callee.name))))
      const rawSource = (part, active = new Set()) => {
        if (!part || active.has(part) || active.size >= 16) return false
        if (part.type === 'Identifier') {
          if (localScopes.some(({ scope, identifiers }) => scope.params && scope.start <= at.start && scope.end >= at.end && identifiers.has(part.name))) return false
          if (nodes.some((node) => (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') && (node.left || node.argument)?.name === part.name)) return false
          const init = initializerAt(part.name, at)
          return rawSource(init, new Set([...active, part]))
        }
        if (part.type !== 'CallExpression' || part.callee.type !== 'MemberExpression' || part.callee.computed || part.callee.property.name !== 'readFileSync' || part.callee.object.type !== 'Identifier') return false
        if (!['utf8', 'utf-8'].includes(valueAt(part.arguments[1], at, false))) return false
        const namespace = initializerAt(part.callee.object.name, at)
        return namespace?.callee?.name === 'require' && ['fs', 'node:fs'].includes(namespace.arguments[0]?.value) && !localScopes.some(({ scope, identifiers }) => scope.params && scope.start <= at.start && scope.end >= at.end && identifiers.has(part.callee.object.name))
      }
      // A physical origin alone cannot prove the imports of arbitrarily transformed text.
      if (!validDataUrl || !rawSource(expression.arguments[0])) return []
      return originFiles(expression.arguments[0], at)
    }
    const loaderAliases = new Map()
    const loaderNamespaces = new Set()
    const indirectRequires = new Set(['require'])
    const handledCallbacks = new WeakSet()
    const handledLoaderCallbacks = new WeakSet()
    const requireFactories = new Set(['createRequire'])
    walk(tree, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init?.type === 'CallExpression' && node.init.callee.name === 'require' && /^(?:node:)?module$/.test(node.init.arguments[0]?.value || '')) {
        for (const member of node.id.properties) {
          if (member.key?.name === 'createRequire' && member.value?.type === 'Identifier') requireFactories.add(member.value.name)
        }
      }
    })
    let pageServerCaller = false
    walk(tree, (node) => {
      if (node.type === 'ImportDeclaration' && /(?:^|\/)(?:utilities|page-loader)(?:\.js)?$/.test(node.source.value)) {
        for (const member of node.specifiers) {
          if (member.type === 'ImportNamespaceSpecifier') loaderNamespaces.add(member.local.name)
          else if (LOADERS.has(member.imported?.name)) { loaderAliases.set(member.local.name, member.imported.name); handledLoaderCallbacks.add(member.local); handledLoaderCallbacks.add(member.imported) }
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression' && (requireFactories.has(node.init.callee.name) || node.init.callee.property?.name === 'createRequire')) indirectRequires.add(node.id.name)
      if (node.type === 'CallExpression' && node.callee.name === 'require' && /(?:^|\/)page-server(?:\.js)?$/.test(node.arguments[0]?.value || '')) pageServerCaller = true
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'MemberExpression' && LOADERS.has(node.init.property.name)) loaderAliases.set(node.id.name, node.init.property.name)
      if (node.type !== 'VariableDeclarator' || node.init?.type !== 'CallExpression' || node.init.callee.name !== 'require' || !/(?:^|\/)(?:utilities|page-loader)(?:\.js)?$/.test(node.init.arguments[0]?.value || '')) return
      if (node.id.type === 'Identifier') loaderNamespaces.add(node.id.name)
      if (node.id.type === 'ObjectPattern') {
        for (const member of node.id.properties) {
          if (member.type === 'Property' && LOADERS.has(member.key.name)) { loaderAliases.set(member.value.name, member.key.name); handledLoaderCallbacks.add(member.key); handledLoaderCallbacks.add(member.value) }
        }
      }
    })
    for (let changed = true; changed;) {
      changed = false
      for (const node of nodes) {
        const target = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' && node.operator === '=' ? node.left : null
        const value = node.type === 'VariableDeclarator' ? node.init : node.right
        if (target?.type === 'Identifier' && value?.type === 'Identifier' && loaderAliases.has(value.name)) {
          handledLoaderCallbacks.add(value)
          if (!loaderAliases.has(target.name)) { loaderAliases.set(target.name, loaderAliases.get(value.name)); changed = true }
        }
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || node.init?.type !== 'Identifier' || !indirectRequires.has(node.init.name)) continue
        handledCallbacks.add(node.init)
        if (!indirectRequires.has(node.id.name)) { indirectRequires.add(node.id.name); changed = true }
      }
    }
    walk(tree, (node) => {
      // Only path-valued AST expressions count, not substrings of mutation/rewrite strings.
      if (node.type === 'Literal' && typeof node.value === 'string' && (/^(?:src|scripts|fixtures|saves|artifacts)\//.test(node.value) || node.value === 'AuroraDB.db') && !/[\r\n]/.test(node.value)) terminal.add(normalize(node.value))
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && ['join', 'resolve'].includes(node.callee.property.name)) {
        const value = valueAt(node, node)
        if (typeof value === 'string' && path.isAbsolute(value)) {
          const relative = normalize(path.relative(root, value))
          if (/^(?:src|scripts|fixtures|saves|artifacts)\//.test(relative) || relative === 'AuroraDB.db') terminal.add(relative)
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'MetaProperty' && node.callee.object.meta.name === 'import' && (node.callee.computed ? node.callee.property.value : node.callee.property.name) === 'glob') {
        const options = node.arguments[1]
        const eager = property(options, 'eager')
        if (options && (options.type !== 'ObjectExpression' || options.properties.some((entry) => entry.type !== 'Property' || entry.computed || entry.kind !== 'init') || (eager && (eager.value.type !== 'Literal' || typeof eager.value.value !== 'boolean')))) {
          unresolved.push({ file, line: node.loc.start.line, reason: 'Vite glob eagerness is unresolved', expression: script.slice(node.start, node.end) })
          return
        }
        // Lazy route factories are reached through the browser check's mounted subjects.
        // Eager store modules execute when the app shell starts, before any route visit.
        if (!eager?.value.value) return
        const patterns = node.arguments[0]?.type === 'ArrayExpression' ? node.arguments[0].elements : [node.arguments[0]]
        for (const pattern of patterns) {
          if (pattern?.type !== 'Literal' || typeof pattern.value !== 'string' || !/^(?:\.{1,2}\/|\/|~\/|@\/)[\w./*-]+$/.test(pattern.value) || pattern.value.includes('**')) {
            unresolved.push({ file, line: node.loc.start.line, reason: 'eager Vite glob has no supported literal target domain', expression: script.slice(node.start, node.end) })
            continue
          }
          const target = pattern.value.startsWith('/') ? 'src/renderer' + pattern.value : /^[~@]\//.test(pattern.value) ? 'src/renderer/' + pattern.value.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(file), pattern.value))
          if (target.startsWith('../')) {
            unresolved.push({ file, line: node.loc.start.line, reason: 'eager Vite glob escapes the source snapshot', expression: script.slice(node.start, node.end) })
            continue
          }
          const matching = new RegExp('^' + target.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$', process.platform === 'win32' ? 'i' : '')
          knownFiles.filter((candidate) => matching.test(candidate)).forEach((candidate) => add(candidate, node))
        }
        return
      }
      const declaredSource = node.type === 'ImportDeclaration' || node.type?.startsWith('Export')
      let dependencyCall = false
      let requireSource = null
      if (node.type === 'CallExpression') {
        const callee = node.callee
        if (callee.type === 'Identifier' && indirectRequires.has(callee.name)) {
          handledCallbacks.add(callee)
          dependencyCall = true
          requireSource = node.arguments[0]
          if (node.arguments.length !== 1) unresolved.push({ file, line: node.loc.start.line, reason: 'unsupported require source form' })
        } else if (callee.type === 'MemberExpression') {
          const member = callee.computed ? callee.property.value : callee.property.name
          if (indirectRequires.has(callee.object.name)) {
            handledCallbacks.add(callee.object)
            dependencyCall = true
            if (member === 'call' && node.arguments.length === 2) requireSource = node.arguments[1]
            else if (member === 'apply' && node.arguments.length === 2 && node.arguments[1].type === 'ArrayExpression' && node.arguments[1].elements.length === 1) requireSource = node.arguments[1].elements[0]
            else if (member === 'resolve' && node.arguments.length === 1) requireSource = node.arguments[0]
            else unresolved.push({ file, line: node.loc.start.line, reason: 'unsupported require callback member invocation', expression: script.slice(node.start, node.end) })
          } else if ((callee.object.name === 'module' && member === 'require') || member === 'ssrLoadModule') {
            dependencyCall = true
            requireSource = node.arguments[0]
          }
        }
      }
      const specifier = declaredSource ? node.source : node.type === 'ImportExpression' ? node.source : requireSource
      if (dependencyCall && (!specifier || specifier.type === 'SpreadElement')) unresolved.push({ file, line: node.loc.start.line, reason: 'unsupported require source form' })
      if (specifier) {
        const auditedTargets = auditedImportTargets(DOMAIN_IMPORT_CONTRACTS[file], text, script.slice(specifier.start, specifier.end))
        if (auditedTargets !== null) {
          contracts.push({ file, line: node.loc.start.line, expression: script.slice(specifier.start, specifier.end), targets: auditedTargets, sourceHash: hash(text.replace(/\r\n/g, '\n')), reason: DOMAIN_IMPORT_CONTRACTS[file].reason })
          auditedTargets.forEach((target) => add(target, node))
          return
        }
        const value = valueAt(specifier, node)
        const mutableInputs = []
        walk(specifier, (part) => { if (part.type === 'Identifier' && data?.mutableNames.has(part.name)) mutableInputs.push(part) })
        const resolvingPackage = node.type === 'CallExpression' && node.callee.object?.name === 'require' && node.callee.property?.name === 'resolve'
        if (typeof value !== 'string' && resolvingPackage) {
          const choices = possibleValues(specifier, node)
          if (choices.length && choices.every((choice) => typeof choice === 'string' && !choice.startsWith('.') && !path.isAbsolute(choice) && !/^[~@]\//.test(choice) && !/^[a-z][\w+.-]*:/i.test(choice))) {
            const targets = ['package.json', 'bun.lock'].filter((metadata) => names.has(metadata))
            targets.forEach((target) => edges.add(target))
            contracts.push({ file, line: node.loc.start.line, targets, specifiers: choices, reason: 'finite package-resolution callers depend on dependency metadata' })
            return
          }
        }
        const suffixTargets = typeof value === 'string' ? [] : literalSuffixTargets(specifier, node)
        const encodedTargets = node.type === 'ImportExpression' ? pureDataUrlTargets(specifier, node) : []
        if (mutableInputs.length) mutableDependencyIssues.push({ inputs: mutableInputs, bounded: suffixTargets.length > 0 || encodedTargets.length > 0, issue: { file, line: node.loc.start.line, reason: 'dependency expression uses a mutable binding', expression: script.slice(node.start, node.end) } })
        // These contracts already include every possible physical dependency;
        // uncertainty in their prefixes/encoders cannot narrow that closed domain.
        if (!suffixTargets.length && !encodedTargets.length) dependencyInputs.push({ expression: specifier, at: node })
        if (typeof value === 'string') {
          if (!path.isAbsolute(value) && /^[a-z][\w+.-]*:/i.test(value) && !/^(?:node|bun):/.test(value)) { unresolved.push({ file, line: node.loc.start.line, reason: 'unsupported import URL source' }); return }
          const clean = value.replace(/\?(?:raw|url)$/, '')
          const target = /^\/(?:utilities|mixins|components|pages)\//.test(clean) ? 'src/renderer' + clean : path.isAbsolute(clean) ? normalize(path.relative(root, clean)) : clean.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), clean)) : /^[~@]\//.test(clean) ? 'src/renderer/' + clean.slice(2) : null
          if (target && !target.startsWith('node_modules/')) add(target, node)
          else for (const metadata of ['package.json', 'bun.lock']) if (names.has(metadata)) edges.add(metadata)
        } else if (suffixTargets.length) {
          suffixTargets.forEach((target) => add(target, node))
          contracts.push({ file, line: node.loc.start.line, targets: suffixTargets, reason: 'widening computed import prefix to every repository path with its literal suffix' })
        } else if (encodedTargets.length) {
          encodedTargets.forEach((target) => add(target, node))
          contracts.push({ file, line: node.loc.start.line, targets: encodedTargets, reason: 'data URL import retains its statically read source origin' })
        } else unresolved.push({ file, line: node.loc.start.line, reason: 'computed import has no audited target domain' + (isUnknown(value) ? ': ' + value.unknown : ''), expression: script.slice(node.start, node.end) })
      }
      if (node.type !== 'CallExpression') return
      if (pageServerCaller && (node.callee.name === 'startPageServer' || (node.callee.type === 'MemberExpression' && (node.callee.computed ? node.callee.property.value : node.callee.property.name) === 'startPageServer'))) {
        const options = valueAt(node.arguments[0], node, false)
        if (isUnknown(options) || (options && own(options, 'root') && (typeof options.root !== 'string' || path.resolve(options.root) !== path.resolve(root)))) unresolved.push({ file, line: node.loc.start.line, reason: 'browser app root override has no audited source domain', expression: script.slice(node.start, node.end) })
        const entry = 'src/renderer/index.html'
        add(entry, node, terminal)
        const html = availableSources[entry]
        const scripts = typeof html === 'string' ? [...html.matchAll(/<script\b([^>]*)>/gi)] : []
        if (!scripts.length) unresolved.push({ file, line: node.loc.start.line, reason: 'browser app entry script domain is missing', target: entry })
        for (const script of scripts) {
          const source = /(?:^|\s)src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i.exec(script[1])
          const specifier = source && (source[1] || source[2] || source[3])
          if (!specifier || /[?#&]/.test(specifier) || /^[a-z][\w+.-]*:/i.test(specifier)) {
            unresolved.push({ file, line: node.loc.start.line, reason: 'browser app entry script has no supported local source', target: entry })
            continue
          }
          const target = specifier.startsWith('/') ? 'src/renderer' + specifier : path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier))
          add(target, node)
        }
        data ||= declarations(script, file, root, knownFiles)
        const subjects = [...data.bindings.keys()].filter((name) => !/(?:FAULT|MUTANT|MUTATION|BENIGN|REWRITE)/.test(name)).flatMap((name) => {
          const value = data.valueOf(name)
          return typeof value === 'string' ? [value] : ['FILES', 'FILE'].includes(name) && value && !isUnknown(value) ? Object.values(value).filter((part) => typeof part === 'string') : []
        })
        for (const subject of subjects) {
          const target = normalize(path.isAbsolute(subject) ? path.relative(root, subject) : subject)
          if (target.startsWith('src/renderer/') && target.endsWith('.vue') && names.has(target)) edges.add(target)
        }
      }
      const called = node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' && (loaderNamespaces.has(node.callee.object.name) || LOADERS.has(node.callee.property.name)) ? node.callee.property.name : null
      const localMultiWrapper = called === 'loadModules' && (data ||= declarations(script, file, root, knownFiles)).valueOf(called)?.lambda
      const loader = loaderAliases.get(called) || (LOADERS.has(called) && !localMultiWrapper ? called : null)
      if (!loader) return
      dependencyInputs.push({ expression: node.arguments[0], at: node })
      // Only module-name values enter this closure. Directory suffixes, source
      // origins and parsed virtual source imports keep their existing contracts.
      if (node.callee.type === 'Identifier') {
        handledLoaderCallbacks.add(node.callee)
        data ||= declarations(script, file, root, knownFiles)
        if (data.mutableNames.has(called)) unresolved.push({ file, line: node.loc.start.line, reason: 'loader callback can be mutated; target domain is unresolved', expression: script.slice(node.start, node.end) })
      }
      const values = possibleValues(node.arguments[0], node)
      const modules = values.flatMap((value) => loader === 'loadUtilities' || loader === 'loadModules' ? Array.isArray(value) ? value : [unknown('module names are not an array')] : [value])
      if (!modules.length || modules.some((name) => typeof name !== 'string')) {
        unresolved.push({ file, line: node.loc.start.line, reason: `unknown ${loader} call; target domain is unresolved`, expression: script.slice(node.start, node.end) })
        if (!modules.some((name) => typeof name === 'string')) return
      }
      let directory = loader === 'loadUtilities' ? path.join(root, 'src/renderer/utilities') : path.join(root, 'src/renderer')
      const options = valueAt(node.arguments[1], node, false)
      const hasDirectory = options && !isUnknown(options) && own(options, 'directory')
      const base = hasDirectory ? options.directory : directory
      const directoryKnown = typeof base === 'string' && !normalize(path.relative(root, base)).startsWith('../')
      if (directoryKnown) directory = base
      const virtual = {}
      for (const record of [options?.sources, options?.modules]) {
        for (const [name, source] of Object.entries(record && !isUnknown(record) ? record : {})) {
          if (typeof source !== 'string') continue
          const suffix = /^(?:pages|components)\//.test(name) ? '.vue' : '.js'
          virtual[normalize(path.relative(root, path.resolve(directory, name + suffix)))] = record === options?.modules && suffix === '.vue' ? `<script>${source}</script>` : source
        }
      }
      // Pure in-memory fixtures are source too; parse their imports instead of pretending
      // they are missing disk files. Page-loader's absent .vue imports are literal stubs.
      for (const [virtualFile, source] of Object.entries(virtual)) {
        for (const match of source.matchAll(/from\s+['"](\.[^'"]+\.vue)['"]/g)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(virtualFile), match[1]))
          if (!names.has(target) && !own(virtual, target)) virtual[target] = ''
        }
      }
      if (Object.keys(virtual).length) {
        const generated = dependencyGraph(virtual, root, [...knownFiles, ...Object.keys(virtual)], { ...availableSources, ...virtual })
        for (const [target, dependencies] of generated.graph) graph.set(target, new Set([...(graph.get(target) || []), ...dependencies]))
        unresolved.push(...generated.unresolved)
      }
      for (const name of modules) {
        if (typeof name !== 'string') continue
        const suffix = loader === 'loadUtilities' || !/^(?:pages|components)\//.test(name) ? '.js' : '.vue'
        const relativeName = name + suffix
        const origins = [...originFiles(sourceNode(node.arguments[1], name, node), node), ...copiedOrigins(relativeName)]
        if (origins.length) {
          origins.forEach((origin) => add(origin, node))
          if (origins.length > 1) contracts.push({ file, line: node.loc.start.line, targets: origins, reason: 'widening copied/source-override origin to every statically named source' })
          continue
        }
        const target = normalize(path.relative(root, path.resolve(directory, name + suffix)))
        if (directoryKnown && resolve(target)) { add(target, node); continue }
        if (own(virtual, target)) { edges.add(target); continue }
        // A rewritten temporary tree can have any repository origin, but the complete
        // literal module suffix still bounds its possible origins. Include ALL matches.
        const ending = path.posix.normalize(name + suffix).replace(/^(?:\.\.\/)+/, '')
        const candidates = knownFiles.filter((candidate) => candidate === ending || candidate.endsWith('/' + ending))
        if (candidates.length) {
          candidates.forEach((candidate) => add(candidate, node))
          contracts.push({ file, line: node.loc.start.line, expression: script.slice(node.start, node.end), targets: candidates, reason: 'widening loader directory to every repository module with the named suffix' })
        } else add(target, node)
      }
    })
    for (const node of nodes) {
      if (node.type !== 'Identifier' || !loaderAliases.has(node.name) || handledLoaderCallbacks.has(node)) continue
      const parent = parents.get(node)
      if ((parent?.type === 'VariableDeclarator' && parent.id === node) || (parent?.type === 'AssignmentExpression' && parent.left === node)) continue
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) continue
      if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) continue
      unresolved.push({ file, line: node.loc.start.line, reason: 'unsupported use of loader callback may hide dependency sources', expression: script.slice(parent?.start ?? node.start, parent?.end ?? node.end) })
    }
    for (const node of nodes) {
      if (node.type !== 'Identifier' || !indirectRequires.has(node.name) || handledCallbacks.has(node)) continue
      const parent = parents.get(node)
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) continue
      if ((parent?.type === 'VariableDeclarator' && parent.id === node) || (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) continue
      if (parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && ['main', 'cache', 'extensions'].includes(parent.property.name)) continue
      unresolved.push({ file, line: node.loc.start.line, reason: 'unsupported use of require callback may hide dependency sources', expression: script.slice(parent?.start ?? node.start, parent?.end ?? node.end) })
    }
    data ||= declarations(script, file, root, knownFiles)
    const provenance = sinkProvenance(data, dependencyInputs)
    unresolved.push(...mutableDependencyIssues.filter((entry) => entry.bounded || entry.inputs.some(provenance.reaches)).map(({ issue }) => issue))
    if (provenance.uncertainty.length) unresolved.push({ file, line: 1, reason: 'mutation alias chain or mutation-method use is unresolved', expression: provenance.uncertainty.join('; ') })
    analysedBindings.push(...provenance.irrelevant.filter(({ binding }) => !loaderAliases.has(binding) && !indirectRequires.has(binding)).map((binding) => ({ file, ...binding })))
    graph.set(file, edges)
    reads.set(file, terminal)
  }
  return { graph, reads, unresolved, contracts, analysedBindings }
}

const planChanges = async ({ root, sources, baseline = sources, changed, identity = { mode: 'explicit-paths' }, regexLimit = 1000, createdAt = new Date().toISOString() }) => {
  const { catalogSuite, commandsFor } = require('./affected-checks-adapters')
  const paths = [...new Set(changed.map(normalize))].sort()
  if (paths.some((file) => file.startsWith('../') || path.isAbsolute(file) || /^[a-z]:\//i.test(file))) throw new Error('changed paths must be repository relative')
  const files = Object.keys(sources).sort()
  // The baseline adapter receives the union target list. Without deletions that is
  // exactly the candidate list, so identical suite text needs only one catalog parse.
  const sameTargets = Object.keys(baseline).every((file) => own(sources, file))
  const suites = [...new Set([...files, ...Object.keys(baseline)].filter((file) => /^scripts\/check-[^/]+\.js$/.test(file) && file !== 'scripts/check-all.js'))].sort()
  const validationCache = new Map()
  const selections = []
  const blockers = []
  const certificate = []
  const knownFiles = [...new Set([...files, ...Object.keys(baseline)])]
  const { graph, reads, unresolved, contracts, analysedBindings } = dependencyGraph(sources, root, knownFiles)
  const priorSources = Object.fromEntries(Object.entries(baseline).filter(([file, text]) => sources[file] !== text))
  const prior = dependencyGraph(priorSources, root, knownFiles, baseline)
  const priorGraph = prior.graph
  unresolved.push(...prior.unresolved.filter((issue) => !unresolved.some((current) => current.file === issue.file && current.line === issue.line && current.reason === issue.reason)))
  for (const [file, edges] of priorGraph) graph.set(file, new Set([...(graph.get(file) || []), ...edges]))
  for (const [file, edges] of prior.reads) reads.set(file, new Set([...(reads.get(file) || []), ...edges]))
  const reachable = (start, target, seen = new Set()) => {
    if (start === target) return true
    if (seen.has(start)) return false
    seen.add(start)
    return [...(graph.get(start) || [])].some((file) => reachable(file, target, seen))
  }
  const reachesChanged = (start, seen = new Set()) => {
    if (seen.has(start)) return false
    seen.add(start)
    return paths.includes(start) || [...(graph.get(start) || [])].some((file) => reachesChanged(file, seen))
  }
  const catalogsBySuite = new Map(suites.map((suite) => {
    const current = sources[suite] === undefined ? null : catalogSuite(sources[suite], suite, root, files)
    const before = baseline[suite] === undefined ? null : sameTargets && baseline[suite] === sources[suite] ? current : catalogSuite(baseline[suite], suite, root, knownFiles)
    return [suite, { current, catalogs: current === before ? [current].filter(Boolean) : [current, before].filter(Boolean) }]
  }))
  const mapped = (suite, target, seen = new Set()) => {
    if (suite === target || reads.get(suite)?.has(target)) return true
    if (seen.has(suite)) return false
    seen.add(suite)
    return [...(graph.get(suite) || [])].some((dependency) => mapped(dependency, target, seen))
  }
  const readsChanged = (suite, seen = new Set()) => {
    if (seen.has(suite)) return false
    seen.add(suite)
    return paths.some((file) => reads.get(suite)?.has(file)) || [...(graph.get(suite) || [])].some((dependency) => readsChanged(dependency, seen))
  }
  const widenings = paths.filter((file) => file.startsWith('src/') && !suites.some((suite) => mapped(suite, file) || catalogsBySuite.get(suite).catalogs.some((catalog) => catalog.domain.includes(file)))).map((file) => ({ file, reason: 'unmapped source path; selecting every check rather than assuming no consumer' }))
  const iteration = identity.mode === 'working-tree'
  for (const suite of suites) {
    const { current, catalogs } = catalogsBySuite.get(suite)
    const direct = catalogs.flatMap((catalog) => catalog.variants.flatMap((variant) => variant.anchors.filter((anchor) => paths.includes(anchor.file)).map((anchor) => ({ key: variant.key, file: anchor.file, reason: 'source anchor' }))))
    const domain = catalogs.flatMap((catalog) => catalog.domain).some((file) => paths.includes(file)) || readsChanged(suite)
    const helper = reachesChanged(suite)
    const importIssues = unresolved.filter((issue) => reachable(suite, issue.file))
    const importUncertainty = importIssues.length > 0 && paths.length > 0
    const unknownScope = paths.length > 0 && (catalogs.some((catalog) => catalog.unknownDomain) || importUncertainty || widenings.length > 0)
    certificate.push({ suite, coverage: current ? current.coverage : 'removed', domain: current ? current.domain : [], unknowns: current ? current.unknowns : ['suite removed'], proof: current ? current.proof : null, sourceHash: current ? hash(sources[suite]) : null, selected: Boolean(direct.length || domain || helper || unknownScope) })
    if (!direct.length && !domain && !helper && !unknownScope) continue
    if (!current) {
      blockers.push({ suite, reason: 'a baseline dependent suite was removed' })
      continue
    }
    const wanted = direct.length && !helper ? current.variants.filter((variant) => variant.head || direct.some((reason) => reason.key === variant.key) || variant.anchors.some((anchor) => paths.includes(anchor.file))) : current.variants
    const catalogUncertainty = current.unknownDomain || current.coverage === 'unknown' || current.unknowns.length || !wanted.length
    const fallback = Boolean(importUncertainty || catalogUncertainty || widenings.length)
    const reasons = [...direct, ...paths.filter((file) => mapped(suite, file)).map((file) => ({ file, reason: suite === file ? 'changed check script' : 'import, loader or named source/fixture read reaches changed file' })), ...widenings]
    if (domain && !direct.length) reasons.push({ reason: 'changed direct source/descriptor target (terminal read, not an imported module)' })
    if (importUncertainty) reasons.push(...importIssues.map((issue) => ({ ...issue, reason: `widening to complete suite: ${issue.reason}` })))
    if (catalogUncertainty) reasons.push({ reason: `widening to complete suite: focused variant adapter is incomplete (${current.unknowns.length} catalog issues)`, issues: current.unknowns })
    reasons.push(...[...contracts, ...prior.contracts].filter((contract) => contract.reason && reachable(suite, contract.file)).map((contract) => ({ file: contract.file, line: contract.line, reason: contract.reason, targets: contract.targets })))
    if (!iteration && importUncertainty) blockers.push(...importIssues.map((issue) => ({ suite, ...issue })))
    if (!iteration && catalogUncertainty) blockers.push({ suite, reason: current.unknowns.join('; ') || 'dependent variant catalog unresolved' })
    const invalid = []
    for (const variant of wanted) {
      for (const anchor of variant.anchors) {
        if (iteration && (fallback || !paths.includes(anchor.file))) continue
        const text = sources[anchor.file]
        if (text === undefined) {
          invalid.push({ key: variant.key, file: anchor.file, reason: 'anchor source is absent' })
          continue
        }
        const validationKey = canonical([anchor.file, anchor.from])
        if (!validationCache.has(validationKey)) validationCache.set(validationKey, matches(text.replace(/\r\n/g, '\n'), anchor, regexLimit))
        const checked = await validationCache.get(validationKey)
        if (checked.error || (!checked.deferred && (anchor.first ? checked.count < 1 : checked.count !== anchor.count))) invalid.push({ key: variant.key, file: anchor.file, line: anchor.line, reason: checked.error || `anchor has ${checked.count} matches; expected ${anchor.first ? 'at least one' : anchor.count}` })
      }
    }
    blockers.push(...invalid.map((problem) => ({ suite, ...problem })))
    const deepCommands = fallback ? [{ args: [], keys: ['*'], fallback: 'complete default suite; uncertainty cannot remove checks' }] : commandsFor(current, wanted)
    const fastCommands = [{ args: [...(SUITE_ARGS.find(([match]) => suite.endsWith(match))?.[1] || []), '--no-mutations'], keys: ['head'] }]
    const commands = iteration && identity.depth !== 'deep' ? fastCommands : deepCommands
    if (!commands.length) blockers.push({ suite, reason: 'no proven selector for selected variants' })
    selections.push({ suite, family: fallback ? 'full' : current.family, keys: fallback ? ['*'] : wanted.map((variant) => variant.key), reasons, commands, fastCommands, deepCommands, defaultKeys: current.defaultKeys, timingWitnesses: current.timingWitnesses, partWitnesses: current.partWitnesses, expectedExtra: fallback ? null : current.expectedExtra, witnesses: fallback ? null : current.witnesses, sourceHash: hash(sources[suite]) })
  }
  const fingerprints = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)).map(([file, text]) => [file, hash(text)]))
  return seal({ version: 2, createdAt, identity, changed: paths, status: blockers.length ? 'blocked' : 'ready-for-runs', selections, blockers, widenings, suiteCount: suites.length, certificate, unresolvedImports: unresolved, importContracts: [...contracts, ...prior.contracts], analysedBindings: [...analysedBindings, ...prior.analysedBindings.map((binding) => ({ ...binding, baseline: true }))], fingerprints })
}

const verifyEvidence = (plan, records, fingerprints) => {
  checkSeal(plan)
  if (plan.status !== 'ready-for-runs') throw new Error('the dependency plan is blocked')
  if (canonical(plan.fingerprints) !== canonical(fingerprints)) throw new Error('the candidate or its check/helper sources changed after planning')
  const required = plan.selections.flatMap((selection) => selection.commands.map((command) => ({ ...command, suite: selection.suite, sourceHash: selection.sourceHash })))
  for (const command of required) {
    const record = records.find((entry) => entry.suite === command.suite && (canonical(entry.args) === canonical(command.args) || entry.completeDefault === true))
    if (!record || record.code !== 0 || record.timedOut || record.harness || record.sourceHash !== command.sourceHash) throw new Error(`missing or unsuccessful exact run: ${command.suite} ${command.args.join(' ')}`)
    if (!Array.isArray(record.keys) || command.keys.some((key) => !record.keys.includes(key))) throw new Error(`missing variant execution witness: ${command.suite}`)
  }
  return { passed: true, commands: required.length, variants: required.reduce((total, command) => total + command.keys.length, 0), digest: plan.digest }
}

module.exports = { hash, own, unknown, isUnknown, walk, property, parse, normalize, declarations, repoFiles, matches, seal, checkSeal, dependencyGraph, planChanges, verifyEvidence, importContractMatches, auditedImportTargets }
