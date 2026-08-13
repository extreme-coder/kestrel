import type { DB } from '../db/index.js'
import type { FetchLike, FetchWindOptions, WindSeries } from './openmeteo.js'
import { SERIES_SCHEMA_VERSION, fetchWindSeries } from './openmeteo.js'

/**
 * Cached, throttled access to the wind source.
 *
 * Throttling is not politeness — it is the constraint the original architecture was
 * built around. The report describes the upstream as throttled, with "a certain amount
 * of time necessary between each API call, and calls cannot be made simultaneously",
 * which is precisely why optimization was made asynchronous and point-by-point.
 *
 * Three layers keep upstream traffic down:
 *   1. a persistent SQLite cache, so a restarted process keeps its history
 *   2. in-flight deduplication, so concurrent callers for one cell share a single fetch
 *   3. a minimum interval between calls, serialised through a promise chain
 */

export interface WindCacheOptions {
  db: DB
  fetchImpl?: FetchLike
  /** How long a cached series stays fresh. ERA5 is a reanalysis of the past, so this
   *  can be long — the underlying data does not change. Defaults to 30 days. */
  ttlMs?: number
  /** Minimum spacing between upstream calls. Defaults to 250 ms (~4 req/s). */
  minIntervalMs?: number
  /** Injectable clock, for tests. */
  now?: () => number
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface CacheStats {
  hits: number
  misses: number
  upstreamCalls: number
  deduped: number
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Coordinate precision used for cache keys, in decimal places.
 *
 * ERA5 resolves to roughly 25 km, and Open-Meteo snaps any request to its grid, so
 * requests within a couple of hundred metres of each other return byte-identical data.
 * Two decimal places (~1.1 km) is far finer than the underlying grid while still giving
 * the annealing walk frequent cache hits as it takes small steps.
 */
const KEY_PRECISION = 2

export function cacheKey(options: {
  latitude: number
  longitude: number
  startDate: string
  endDate: string
}): string {
  const lat = options.latitude.toFixed(KEY_PRECISION)
  const lon = options.longitude.toFixed(KEY_PRECISION)
  // The schema version leads, so a row written under an older `WindSample` shape can never
  // be read back as the current one. A 30-day TTL is long enough that a warm cache would
  // otherwise keep serving series that predate a new field for a month.
  return `v${SERIES_SCHEMA_VERSION}:${lat}:${lon}:${options.startDate}:${options.endDate}`
}

export class WindCache {
  private readonly db: DB
  private readonly fetchImpl: FetchLike
  private readonly ttlMs: number
  private readonly minIntervalMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  private readonly inFlight = new Map<string, Promise<WindSeries>>()
  private queue: Promise<unknown> = Promise.resolve()
  /** -Infinity so the first call never waits out an interval it did not use. */
  private lastCallAt = Number.NEGATIVE_INFINITY

  readonly stats: CacheStats = { hits: 0, misses: 0, upstreamCalls: 0, deduped: 0 }

  constructor(options: WindCacheOptions) {
    this.db = options.db
    this.fetchImpl = options.fetchImpl ?? fetch
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.minIntervalMs = options.minIntervalMs ?? 250
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Read a series from cache without touching the network. */
  peek(options: FetchWindOptions): WindSeries | undefined {
    const key = cacheKey(options)
    const row = this.db
      .prepare<[string], { payload: string; fetched_at: number }>(
        'SELECT payload, fetched_at FROM wind_cache WHERE key = ?',
      )
      .get(key)

    if (!row) return undefined
    if (this.now() - row.fetched_at > this.ttlMs) return undefined

    try {
      return JSON.parse(row.payload) as WindSeries
    } catch {
      // Corrupt row; treat as a miss and let it be overwritten.
      return undefined
    }
  }

  async getSeries(options: FetchWindOptions): Promise<WindSeries> {
    const cached = this.peek(options)
    if (cached) {
      this.stats.hits++
      return cached
    }

    const key = cacheKey(options)

    const existing = this.inFlight.get(key)
    if (existing) {
      this.stats.deduped++
      return existing
    }

    this.stats.misses++
    const pending = this.fetchThrottled(options)
      .then((series) => {
        this.store(key, options, series)
        return series
      })
      .finally(() => {
        this.inFlight.delete(key)
      })

    this.inFlight.set(key, pending)
    return pending
  }

  /**
   * Serialise upstream calls through a single chain, spacing them by `minIntervalMs`.
   * Every caller queues behind the previous one, so calls are never simultaneous.
   */
  private fetchThrottled(options: FetchWindOptions): Promise<WindSeries> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastCallAt)
      if (wait > 0) await this.sleep(wait)
      this.lastCallAt = this.now()
      this.stats.upstreamCalls++
      return fetchWindSeries(options, this.fetchImpl)
    })

    // Keep the chain alive even when a call rejects, otherwise one upstream failure
    // would poison every subsequent request.
    this.queue = run.catch(() => undefined)
    return run
  }

  private store(key: string, options: FetchWindOptions, series: WindSeries): void {
    this.db
      .prepare(
        `INSERT INTO wind_cache (key, latitude, longitude, start_date, end_date, payload, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(
        key,
        options.latitude,
        options.longitude,
        options.startDate,
        options.endDate,
        JSON.stringify(series),
        this.now(),
      )
  }

  /** Drop entries older than the TTL. Returns the number removed. */
  prune(): number {
    const cutoff = this.now() - this.ttlMs
    return this.db.prepare('DELETE FROM wind_cache WHERE fetched_at < ?').run(cutoff).changes
  }
}
