// Read-failure tracking for pages whose panels must never show a guess (zero stock, an empty
// list) while a read is loading or has failed. The page keeps `loadErrors: {}` in its data.

// Wraps an async-computed getter so each read's outcome lands in `loadErrors[key]`: null once
// it succeeds, the message while it fails (the plugin's own status isn't reactive under Vue 2).
// A failure still rejects, so the plugin keeps the last value. The getter runs synchronously up
// to its first await, so its dependencies are still tracked; only the latest read counts. A host
// without `loadErrors` (a mixin's other users) is left alone.
export const tracked = (key, get) => function () {
  const requests = (this.loadRequests = this.loadRequests || {})
  const request = (requests[key] = (requests[key] || 0) + 1)
  const settle = (error) => {
    if (request === requests[key] && this.loadErrors) {
      this.$set(this.loadErrors, key, error)
    }
  }

  return get.call(this).then((value) => {
    settle(null)

    return value
  }, (error) => {
    settle((error && error.message) || String(error))

    throw error
  })
}

// "a, b and c" from the labels of the failed reads.
export const joinLabels = (labels) => (labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] || '')

// Every key has been read successfully at least once since its last failure.
export const allLoaded = (loadErrors, keys) => keys.every((key) => loadErrors[key] === null)
