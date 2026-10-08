// Web mode stand-in for the parts of `sequelize` pages import directly.
// Sequelize's operators are `Symbol.for(<name>)`, so these round-trip through
// the database middleware unchanged.

import QueryTypes from 'sequelize/lib/query-types'

export const Op = new Proxy({}, {
  get: (_target, name) => (typeof name === 'string' ? Symbol.for(name) : undefined),
})

export { QueryTypes }
