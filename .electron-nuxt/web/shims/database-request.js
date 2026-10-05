// Calls the web-mode database middleware. It only answers requests carrying
// the per-run token that web.js puts in the page, which other sites can't read.

const token = () => {
  const meta = document.querySelector('meta[name="aurora-web-token"]')

  return meta ? meta.content : ''
}

export const databaseRequest = (route, options = {}) => fetch(`/__aurora-db${route}`, {
  ...options,
  headers: { ...options.headers, 'X-Aurora-Web-Token': token() },
})
