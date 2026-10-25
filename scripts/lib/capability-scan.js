/*
  Reads the renderer's sources for what each report asks of a save: the tables and columns its queries name.

  A report is a route of the page registry (utilities/navigation.js). Its inputs are the reads the page tracks one by one (`tracked('<key>', ...)`, mixins included) and the checks of the Warnings page (an object with a `key` and a `read`); anything else a page or a component it mounts reads is one more input. Each input's reads are the strings of its code that name a `FCT_*`/`DIM_*` table, followed through the helpers it calls, local or imported. Comments, the `structure`/`note`/`assumptions` of rule registrations and labels are not reads.

  The scan sees `Table.Column` names and the tables after `from`/`join`. A query that aliases its tables or names columns bare shows its tables only, so utilities/capabilities.js lists those columns by hand (`EXTRA_READS`).
*/
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..', 'src', 'renderer')

const acorn = require(path.join(root, '..', '..', 'node_modules', 'acorn'))
const { parse: parseComponent } = require(path.join(root, '..', '..', 'node_modules', 'vue', 'compiler-sfc'))

const SKIP_KEYS = new Set(['structure', 'note', 'assumptions', 'missing', 'present', 'rule', 'evidence', 'title', 'summary', 'blurb'])
const GAP = '\uE000'
const TABLE_NAME = /^(?:FCT|DIM)_[A-Za-z0-9]+$/
const QUALIFIED = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(\uE000)?/g
const CONSTRUCTED = /\b((?:FCT|DIM)_[A-Za-z0-9]+)\.\uE000/g
const TABLE = /\b(?:from|join)\s+((?:FCT|DIM)_[A-Za-z0-9]+)/gi
const ALIAS = /\b(?:from|join)\s+((?:FCT|DIM)_[A-Za-z0-9]+)\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/gi
const SQL_WORDS = new Set(['on', 'where', 'inner', 'left', 'right', 'join', 'group', 'order', 'limit', 'using', 'cross', 'natural', 'full', 'outer', 'union', 'select', 'set', 'and', 'or', 'when', 'then', 'else', 'end', 'from', 'having', 'window', 'as', 'not', 'in', 'is', 'null'])
const DERIVED_ALIAS = /\)\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/gi
const DERIVED = '@derived:'
const DEFINED = '@alias:'
const USED = '@use:'

const scriptOf = (file, source) => {
  if (!file.endsWith('.vue')) {
    return source
  }

  const parsed = parseComponent({ source })
  const descriptor = parsed.descriptor || parsed

  return (descriptor.script && descriptor.script.content) || ''
}

const resolveImport = (from, specifier) => {
  const base = path.resolve(path.dirname(from), specifier)

  return [base, `${base}.js`, `${base}.vue`, path.join(base, 'index.js')].find((candidate) => /\.(js|vue)$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null
}

const keyName = (property) => (property.key && (property.key.name || property.key.value)) || null

const isFunction = (node) => node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')

const addRead = (reads, table, column) => {
  if (!reads.has(table)) {
    reads.set(table, new Set())
  }

  if (column) {
    reads.get(table).add(column)
  }
}

const mergeReads = (into, from) => {
  from.forEach((columns, table) => {
    addRead(into, table)
    columns.forEach((column) => into.get(table).add(column))
  })
}

// The models Sequelize is given in utilities/database.js: { [modelName]: { table, attributes } }. A model query selects every attribute that is not virtual.
const modelsOf = (ast) => {
  const models = {}

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') {
      return
    }

    const call = node.type === 'ExpressionStatement' && node.expression
    const isInit = call && call.type === 'CallExpression' && call.callee.type === 'MemberExpression' && call.callee.property.name === 'init' && call.arguments.length >= 2 && call.arguments[0].type === 'ObjectExpression' && call.arguments[1].type === 'ObjectExpression'

    if (isInit) {
      const options = Object.fromEntries(call.arguments[1].properties.filter((property) => property.type === 'Property').map((property) => [keyName(property), property.value && property.value.value]))
      const attributes = call.arguments[0].properties.filter((property) => property.type === 'Property').filter((property) => {
        const virtual = property.value.type === 'ObjectExpression' && property.value.properties.some((inner) => keyName(inner) === 'type' && inner.value.type === 'MemberExpression' && inner.value.property.name === 'VIRTUAL')

        return !virtual && !(property.value.type === 'MemberExpression' && property.value.property.name === 'VIRTUAL')
      }).map((property) => {
        const field = property.value.type === 'ObjectExpression' && property.value.properties.find((inner) => keyName(inner) === 'field')

        return field && field.value.type === 'Literal' ? field.value.value : keyName(property)
      })

      if (options.modelName && options.tableName) {
        models[options.modelName] = { table: options.tableName, attributes }
      }

      return
    }

    Object.keys(node).forEach((field) => {
      const value = node[field]

      if (Array.isArray(value)) {
        value.forEach(visit)
      } else if (value && typeof value.type === 'string') {
        visit(value)
      }
    })
  }

  visit(ast)

  return models
}

// Walks `node` collecting what it reads: `reads` (table -> columns), `refs` (identifiers it uses), and the inputs nested in it (`tracked` reads and checks), which are not descended into.
const collect = (node, models) => {
  const reads = new Map()
  const refs = new Set()
  const inputs = []

  const visit = (current, parent) => {
    if (!current || typeof current.type !== 'string') {
      return
    }

    if (current.type === 'Property' && SKIP_KEYS.has(keyName(current)) && !current.computed) {
      return
    }

    if (current.type === 'CallExpression' && current.callee.type === 'Identifier' && current.callee.name === 'tracked' && current.arguments[0] && current.arguments[0].type === 'Literal' && isFunction(current.arguments[1])) {
      inputs.push({ key: current.arguments[0].value, node: current.arguments[1] })

      return
    }

    if (current.type === 'ObjectExpression' && current !== node) {
      const named = (name) => current.properties.find((property) => property.type === 'Property' && keyName(property) === name)
      const key = named('key')

      if (key && key.value.type === 'Literal' && typeof key.value.value === 'string' && named('read')) {
        inputs.push({ key: `check:${key.value.value}`, node: current })

        return
      }
    }

    // A helper called with a table's name builds the columns it reads of it by name (`sums('FCT_Population')`).
    if (current.type === 'CallExpression' && current.arguments.length && current.arguments[0].type === 'Literal' && typeof current.arguments[0].value === 'string' && TABLE_NAME.test(current.arguments[0].value)) {
      addRead(reads, current.arguments[0].value, '*')
    }

    if (current.type === 'Literal' && typeof current.value === 'string') {
      collectStrings(current.value, reads)
    } else if (current.type === 'TemplateLiteral') {
      collectStrings(current.quasis.map((quasi) => quasi.value.cooked).join(GAP), reads)
      current.expressions.forEach((expression) => visit(expression, current))

      return
    } else if (current.type === 'MemberExpression' && !current.computed && current.object.type === 'MemberExpression' && current.object.property.name === 'models' && models[current.property.name]) {
      const model = models[current.property.name]

      addRead(reads, model.table)
      model.attributes.forEach((attribute) => addRead(reads, model.table, attribute))
    } else if (current.type === 'Identifier') {
      const isProperty = parent && ((parent.type === 'MemberExpression' && parent.property === current && !parent.computed) || (parent.type === 'Property' && parent.key === current && !parent.computed && !parent.shorthand))

      if (!isProperty) {
        refs.add(current.name)
      }
    }

    Object.keys(current).forEach((field) => {
      const value = current[field]

      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, current))
      } else if (value && typeof value.type === 'string') {
        visit(value, current)
      }
    })
  }

  visit(node, null)

  return { reads, refs, inputs }
}

// The reads of one piece of SQL text, a string or a template with U+0001 where an expression goes: `Table.Column` names, the tables after `from`/`join`, and the columns named through an alias that the text defines (`from FCT_GameLog as L` ... `L.MessageText`). A column whose name an expression finishes is not known and is kept as `prefix*`, which utilities/capabilities.js declares in full (`EXTRA_READS`). An alias the text does not define may be defined in a helper it is built with, so its uses are kept as `@use:<alias>` and the aliases it defines as `@alias:<alias>`, which `flatten` joins up.
function collectStrings (text, reads) {
  const aliases = new Map()
  const derived = new Set([...text.matchAll(DERIVED_ALIAS)].filter((match) => !SQL_WORDS.has(match[1].toLowerCase())).map((match) => match[1]))

  derived.forEach((name) => addRead(reads, DERIVED + name))

  for (const match of text.matchAll(ALIAS)) {
    if (!SQL_WORDS.has(match[2].toLowerCase()) && !derived.has(match[2])) {
      if (!aliases.has(match[2])) {
        aliases.set(match[2], new Set())
      }

      aliases.get(match[2]).add(match[1])
    }
  }

  aliases.forEach((tables, alias) => {
    addRead(reads, DEFINED + alias)
    tables.forEach((table) => reads.get(DEFINED + alias).add(table))
  })

  for (const match of text.matchAll(QUALIFIED)) {
    const [, owner, column, gap] = match
    const named = gap ? `${column}*` : column

    if ((match.index > 0 && /[.\w]/.test(text[match.index - 1])) || column === 'rowid' || /^\d/.test(owner)) {
      continue
    }

    if (TABLE_NAME.test(owner)) {
      addRead(reads, owner, named)
    } else if (aliases.has(owner)) {
      aliases.get(owner).forEach((table) => addRead(reads, table, named))
    } else if (!/^(this|Math|JSON|Object|Number|String|Array)$/.test(owner)) {
      addRead(reads, USED + owner, named)
    }
  }

  for (const match of text.matchAll(CONSTRUCTED)) {
    addRead(reads, match[1], '*')
  }

  for (const match of text.matchAll(TABLE)) {
    addRead(reads, match[1])
  }
}

const files = new Map()

// A file's top-level declarations, imports and the inputs inside it.
const fileOf = (absolute, models) => {
  if (files.has(absolute)) {
    return files.get(absolute)
  }

  const source = fs.readFileSync(absolute, 'utf8')
  let ast

  try {
    ast = acorn.parse(scriptOf(absolute, source), { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (error) {
    throw new Error(`${absolute}: ${error.message}`)
  }

  const info = { absolute, relative: path.relative(root, absolute).replace(/\\/g, '/'), ast, imports: new Map(), aliases: new Map(), decls: new Map(), inputs: [], labels: {} }

  files.set(absolute, info)

  const declare = (name, node) => {
    const { reads, refs, inputs } = collect(node, models)

    info.decls.set(name, { reads, refs })
    info.inputs.push(...inputs)
  }

  const handle = (statement) => {
    if (statement.type === 'ImportDeclaration') {
      const target = statement.source.value.startsWith('.') ? resolveImport(absolute, statement.source.value) : null

      statement.specifiers.forEach((specifier) => {
        info.imports.set(specifier.local.name, target ? { file: target, name: specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : specifier.imported.name } : null)
      })
    } else if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) {
        handle(statement.declaration)
      } else if (statement.source) {
        const target = resolveImport(absolute, statement.source.value)

        statement.specifiers.forEach((specifier) => info.aliases.set(specifier.exported.name, { file: target, name: specifier.local.name }))
      } else {
        statement.specifiers.forEach((specifier) => info.aliases.set(specifier.exported.name, { file: absolute, name: specifier.local.name }))
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      declare('default', statement.declaration)
    } else if (statement.type === 'VariableDeclaration') {
      statement.declarations.forEach((declarator) => {
        if (declarator.id.type === 'Identifier' && declarator.init) {
          declare(declarator.id.name, declarator.init)

          if (/LABELS$/.test(declarator.id.name) && declarator.init.type === 'ObjectExpression') {
            declarator.init.properties.forEach((property) => {
              if (property.type === 'Property' && property.value.type === 'Literal' && typeof property.value.value === 'string') {
                info.labels[keyName(property)] = property.value.value
              }
            })
          }
        }
      })
    } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      declare(statement.id.name, statement)
    }
  }

  ast.body.forEach(handle)

  return info
}

// The readers that fail into a report of their own, so that no page rests on what they read: each is followed from no page, and the page that reaches one has an input of its own for it (`inputsOfPage`). { [file relative to the renderer]: { [declaration]: { key, label } } }.
const SEPARATE = {
  'utilities/ground-formations.js': { readFormationObservations: { key: 'observationRead', label: 'the formations observed' } },
}
const SEPARATE_KEYS = new Map(Object.entries(SEPARATE).flatMap(([file, names]) => Object.entries(names).map(([name, entry]) => [`${path.join(root, file)}::${name}`, entry])))
const reached = new Set()

// The reads of the declaration `name` of `info`, followed through everything it refers to. `entered` follows a separate reader itself.
const readsOfDeclaration = (info, name, seen, models, entered = false) => {
  const key = `${info.absolute}::${name}`
  const reads = new Map()

  if (!entered && SEPARATE_KEYS.has(key)) {
    reached.add(key)

    return reads
  }

  if (seen.has(key)) {
    return reads
  }

  seen.add(key)

  if (info.aliases.has(name)) {
    const alias = info.aliases.get(name)

    return alias.file ? readsOfDeclaration(fileOf(alias.file, models), alias.name, seen, models) : reads
  }

  const decl = info.decls.get(name)

  if (!decl) {
    return reads
  }

  mergeReads(reads, decl.reads)
  decl.refs.forEach((ref) => mergeReads(reads, readsOfReference(info, ref, seen, models)))

  return reads
}

const readsOfReference = (info, ref, seen, models) => {
  if (info.decls.has(ref) || info.aliases.has(ref)) {
    return readsOfDeclaration(info, ref, seen, models)
  }

  const imported = info.imports.get(ref)

  if (!imported || !imported.file || !/\.(js|vue)$/.test(imported.file) || imported.file.endsWith('.vue')) {
    return new Map()
  }

  // A mixin that declares `GUARDED_READS` goes on without what it reads (each read fails into a message the page shows), so what it refers to is not a read the page rests on.
  if (imported.file.includes(`${path.sep}mixins${path.sep}`) && fileOf(imported.file, models).decls.has('GUARDED_READS')) {
    return new Map()
  }

  const target = fileOf(imported.file, models)

  if (imported.name !== '*') {
    return readsOfDeclaration(target, imported.name, seen, models)
  }

  const reads = new Map()

  ;[...target.decls.keys(), ...target.aliases.keys()].forEach((name) => mergeReads(reads, readsOfDeclaration(target, name, seen, models)))

  return reads
}

// The reads of an input node: its own strings, then everything its identifiers lead to.
const readsOfInput = (info, node, models) => {
  const { reads, refs } = collect(node, models)
  const seen = new Set()

  refs.forEach((ref) => mergeReads(reads, readsOfReference(info, ref, seen, models)))

  return reads
}

// The reads of an input as { [table]: [columns] }. A column named through an alias that another piece of the input's SQL defines goes to the table the alias names (to each, when pieces give the alias different tables), unless some piece makes the alias a derived table; one that nothing defines (a derived table, a name of the code) is left out.
const flatten = (reads) => {
  const resolved = new Map()
  const give = (table, columns) => {
    addRead(resolved, table)
    columns.forEach((column) => resolved.get(table).add(column))
  }

  reads.forEach((columns, table) => {
    if (!table.startsWith('@')) {
      give(table, columns)
    }
  })

  reads.forEach((columns, name) => {
    const alias = name.startsWith(USED) ? name.slice(USED.length) : null
    const tables = alias && !reads.has(DERIVED + alias) ? reads.get(DEFINED + alias) : null

    if (tables) {
      tables.forEach((table) => give(table, columns))
    }
  })

  return Object.fromEntries([...resolved.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([table, columns]) => [table, [...columns].sort()]))
}

const humanize = (key) => key.replace(/^check:/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase()

// Every file a file imports, directly or through other files.
const reachable = (info, models, found = new Set()) => {
  info.imports.forEach((imported) => {
    if (imported && imported.file && /\.(js|vue)$/.test(imported.file) && !found.has(imported.file)) {
      found.add(imported.file)
      reachable(fileOf(imported.file, models), models, found)
    }
  })

  return found
}

// The inputs of one page: { [key]: { label, reads: { [table]: [columns] } } }.
const inputsOfPage = (pageFile, models) => {
  const page = fileOf(pageFile, models)
  const inputs = {}
  const labels = { ...page.labels }
  const add = (key, info, node, label) => {
    const reads = readsOfInput(info, node, models)

    if (reads.size || !key.startsWith('check:')) {
      inputs[key] = { label: label || labels[key] || `the ${humanize(key)}`, reads: flatten(reads) }
    }
  }

  reached.clear()

  page.inputs.forEach(({ key, node }) => add(key, page, node))

  page.imports.forEach((imported) => {
    if (!imported || !imported.file) {
      return
    }

    const target = fileOf(imported.file, models)

    if (imported.file.includes(`${path.sep}mixins${path.sep}`)) {
      target.inputs.forEach(({ key, node }) => add(key, target, node))
    } else if (imported.file.endsWith('.vue') && imported.name === 'default') {
      const reads = readsOfDeclaration(target, 'default', new Set(), models)

      target.inputs.forEach(({ node }) => mergeReads(reads, readsOfInput(target, node, models)))

      if (reads.size) {
        const name = path.basename(imported.file, '.vue')

        inputs[name] = { label: `the ${humanize(name)}`, reads: flatten(reads) }
      }
    }
  })

  reachable(page, models).forEach((absolute) => {
    const target = fileOf(absolute, models)

    target.inputs.filter(({ key }) => key.startsWith('check:')).forEach(({ key, node }) => add(key, target, node))
  })

  const own = readsOfDeclaration(page, 'default', new Set(), models)

  if (own.size) {
    inputs.page = { label: "the page's other reads", reads: flatten(own) }
  }

  reached.forEach((key) => {
    const { key: input, label } = SEPARATE_KEYS.get(key)
    const [file, name] = key.split('::')
    const separate = flatten(readsOfDeclaration(fileOf(file, models), name, new Set(), models, true))
    const kept = inputs[input] ? inputs[input].reads : {}
    const tables = [...new Set([...Object.keys(kept), ...Object.keys(separate)])].sort()

    inputs[input] = { label: inputs[input] ? inputs[input].label : label, reads: Object.fromEntries(tables.map((table) => [table, [...new Set([...(kept[table] || []), ...(separate[table] || [])])].sort()])) }
  })

  return inputs
}

// The reads the shell makes outside any page: [key, label, file, declaration].
const SHELL_INPUTS = [
  ['empires', 'the empire list', 'utilities/empires.js', 'loadEmpires'],
  ['probe', 'the freshness probe', 'store/freshness.js', 'PROBE_SQL'],
  ['recorder', 'the history recorder', 'utilities/history.js', 'takeSnapshot'],
  ['flyout', 'the flyout lines', 'utilities/peeks.js', 'peeks'],
]

// { [route]: { [input key]: { label, reads } } } for every page file, the Empires page and the shell under the key 'shell'.
const scanReads = (routes) => {
  const models = modelsOf(fileOf(path.join(root, 'utilities', 'database.js'), {}).ast)
  const reports = {}

  routes.forEach((route) => {
    const file = path.join(root, 'pages', `${route === '/' ? 'index' : route.slice(1)}.vue`)

    reports[route] = fs.existsSync(file) ? inputsOfPage(file, models) : null
  })

  reports.shell = Object.fromEntries(SHELL_INPUTS.map(([key, label, file, name]) => [key, { label, reads: flatten(readsOfDeclaration(fileOf(path.join(root, file), models), name, new Set(), models)) }]))
  reports['/'] = { empires: reports.shell.empires }

  return reports
}

module.exports = { scanReads, root }
