import * as Sentry from '@sentry/electron/main'

import { version } from '../../package.json'

// Production builds (`bun run build`) report to Sentry; `bun run dev`, web mode and the smoke test build in other modes and send nothing. This process sends for the whole app: its own errors, native crashes of every process and the renderer's errors (src/renderer/main.js, over the IPC src/preload/index.js sets up). Each carries the release, the version the About page shows, so a report says which version it came from; unpackaged runs report as the development environment. Reports wait on disk while offline.
if (import.meta.env.MODE === 'production') {
  Sentry.init({
    dsn: 'https://8e243eff808fce8ae2da2b27f6eb4ff5@o237971.ingest.us.sentry.io/4510024176893952',
    release: `aurora-electrons@${version}`,
  })
}
