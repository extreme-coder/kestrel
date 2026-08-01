import { serve } from '@hono/node-server'

import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db/index.js'
import { AnnealingService, startWorker } from './lib/annealingService.js'
import { ProgressBus } from './lib/events.js'
import { WindCache } from './lib/windCache.js'

const config = loadConfig()

const db = openDatabase(config.databasePath)
const bus = new ProgressBus()
const windCache = new WindCache({
  db,
  ttlMs: config.cacheTtlMs,
  minIntervalMs: config.minUpstreamIntervalMs,
})
const annealing = new AnnealingService({ db, windCache, bus })

const app = createApp({
  db,
  windCache,
  annealing,
  bus,
  corsOrigin: config.corsOrigin,
  sseHeartbeatMs: config.sseHeartbeatMs,
})

const worker = startWorker(annealing, config.workerIntervalMs)

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[kestrel] listening on http://localhost:${info.port}`)
  console.log(`[kestrel] database ${config.databasePath}`)
  console.log(`[kestrel] annealing worker every ${config.workerIntervalMs} ms`)
})

function shutdown(signal: string) {
  console.log(`[kestrel] ${signal} received, shutting down`)
  worker.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
