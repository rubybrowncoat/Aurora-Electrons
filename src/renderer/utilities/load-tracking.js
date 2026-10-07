// Read-failure tracking for pages whose panels must never show a guess (zero stock, an empty
// list) while a read is loading or has failed. The page keeps `loadErrors: {}` in its data.

// Wraps an async-computed getter so each read's state lands in `loadErrors[key]`: undefined
// until the first read settles and again while a re-read is in flight, null once it succeeds,
// the message while it fails (the plugin's own status isn't reactive under Vue 2). Only a null
// counts as loaded, so a page never mixes a fresh read with the stale value the plugin keeps
// until the new promise settles. A re-read of a failed read keeps its message, so the alert
// stays up until the retry settles instead of flickering off. A failure still rejects, so the
// plugin keeps the last value. The getter runs synchronously up to its first await, so its
// dependencies are still tracked; only the latest read counts. A host without `loadErrors` (a
// mixin's other users) is left alone.
export const tracked = (key, get) => function () {
  const requests = (this.loadRequests = this.loadRequests || {})
  const request = (requests[key] = (requests[key] || 0) + 1)
  let settled = false
  const latest = () => request === requests[key] && this.loadErrors

  // Deferred to a microtask: touching `loadErrors` inside the getter would make it one of the
  // getter's own dependencies, and the write below would re-run the read.
  Promise.resolve().then(() => {
    if (!settled && latest() && this.loadErrors[key] === null) {
      this.$set(this.loadErrors, key, undefined)
    }
  })

  const settle = (error) => {
    settled = true

    if (latest()) {
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

// Every key's latest read has settled successfully: none is in flight or failed.
export const allLoaded = (loadErrors, keys) => keys.every((key) => loadErrors[key] === null)
