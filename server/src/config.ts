export interface Config {
  port: number
  /** SQLite file, or ':memory:' for an ephemeral database. */
  databasePath: string
  /** How often the annealing worker evaluates one point. */
  workerIntervalMs: number
  /** Minimum spacing between upstream wind API calls. */
  minUpstreamIntervalMs: number
  cacheTtlMs: number
  /** Allowed CORS origin; '*' by default so the viewer can be served from anywhere. */
  corsOrigin: string
  /** SSE keep-alive interval, to stop intermediaries closing an idle stream. */
  sseHeartbeatMs: number
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8787),
    databasePath: env.DATABASE_PATH ?? 'data/kestrel.sqlite',
    // One evaluation per second by default: well inside Open-Meteo's limits, and fast
    // enough that a 40-iteration optimization finishes inside a minute.
    workerIntervalMs: int(env.WORKER_INTERVAL_MS, 1000),
    minUpstreamIntervalMs: int(env.MIN_UPSTREAM_INTERVAL_MS, 250),
    cacheTtlMs: int(env.CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    corsOrigin: env.CORS_ORIGIN ?? '*',
    sseHeartbeatMs: int(env.SSE_HEARTBEAT_MS, 15_000),
  }
}
