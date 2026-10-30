// The error a web-mode call throws, from the body the database middleware answered with (scripts/web/database-middleware.js `errorBody`). The `code` and the Sequelize `name` of the error the server met travel with its message, so the page words a database error and shows a file error as it is, as the app does.
export const webError = (route, body) => {
  const error = new Error(`[web] ${route}: ${body && body.error}`)

  if (body && body.code !== undefined && body.code !== null) {
    error.code = body.code
  }

  if (body && typeof body.name === 'string' && body.name.startsWith('Sequelize')) {
    error.name = body.name
  }

  return error
}
