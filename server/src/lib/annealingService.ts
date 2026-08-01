/**
 * The distributed optimization worker.
 *
 * This is the piece the report's Fig. 4 describes, and the reason the original scaled:
 * rather than looping over candidate locations inside one request handler, every
 * candidate is a row in `annealing_points`, and a worker evaluates exactly one per tick.
 *
 * Three properties fall out of that shape, all of which the report calls for:
 *   - the throttled upstream is never called concurrently, because a tick is one call
 *   - many optimization requests interleave fairly, because ticks pull the oldest
 *     pending point across all requests rather than draining one request at a time
 *   - a restart resumes mid-optimization, because progress lives in the database
 */

import { randomUUID } from 'node:crypto'

import type { DB } from '../db/index.js'
import type { Bounds, Point } from './annealing.js'
import {
  INITIAL_TEMPERATURE,
  acceptanceProbability,
  mulberry32,
  proposeNeighbour,
  randomPoint,
  temperatureAt,
} from './annealing.js'
import type { ProgressBus, ProgressEvent } from './events.js'
import { predict } from './prediction.js'
import { getTurbineModel } from './turbines.js'
import type { WindCache } from './windCache.js'

export type RequestStatus = 'pending' | 'running' | 'complete' | 'failed'
export type PointStatus = 'pending' | 'evaluated' | 'failed'

export interface CreateAreaRequestInput {
  sessionId: string
  bounds: Bounds
  turbineId: string
  hubHeightM: number
  startDate: string
  endDate: string
  iterations: number
  seed?: number
}

export interface AreaRequestRow {
  id: string
  session_id: string
  status: RequestStatus
  min_lat: number
  max_lat: number
  min_lon: number
  max_lon: number
  turbine_id: string
  hub_height_m: number
  start_date: string
  end_date: string
  iterations: number
  evaluated: number
  seed: number
  temperature: number
  current_lat: number | null
  current_lon: number | null
  current_score: number | null
  best_lat: number | null
  best_lon: number | null
  best_score: number | null
  best_power_kw: number | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface AnnealingPointRow {
  id: number
  request_id: string
  seq: number
  latitude: number
  longitude: number
  status: PointStatus
  score: number | null
  power_kw: number | null
  temperature: number
  accepted: number | null
  is_best: number
  error: string | null
  created_at: number
  evaluated_at: number | null
}

export interface TickResult {
  requestId: string
  seq: number
  latitude: number
  longitude: number
  score: number | null
  powerKw: number | null
  accepted: boolean
  isBest: boolean
  status: RequestStatus
  error?: string
}

export interface AnnealingServiceOptions {
  db: DB
  windCache: WindCache
  bus?: ProgressBus
  now?: () => number
  /** Injectable id factory, for deterministic tests. */
  newId?: () => string
  /**
   * Consecutive upstream failures on one request before it is abandoned. Transient
   * network errors should not kill a long optimization, but a bad bounding box that
   * fails every point should not retry forever either.
   */
  maxConsecutiveFailures?: number
}

const MAX_ITERATIONS = 500

export class AnnealingService {
  private readonly db: DB
  private readonly windCache: WindCache
  private readonly bus: ProgressBus | undefined
  private readonly now: () => number
  private readonly newId: () => string
  private readonly maxConsecutiveFailures: number
  private readonly failureStreak = new Map<string, number>()

  constructor(options: AnnealingServiceOptions) {
    this.db = options.db
    this.windCache = options.windCache
    this.bus = options.bus
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5
  }

  create(input: CreateAreaRequestInput): AreaRequestRow {
    const model = getTurbineModel(input.turbineId)
    if (!model) throw new RangeError(`unknown turbine model: ${input.turbineId}`)

    const bounds = normaliseBounds(input.bounds)
    const iterations = Math.min(Math.max(Math.round(input.iterations), 1), MAX_ITERATIONS)
    const id = this.newId()
    const seed = input.seed ?? Math.floor(Math.random() * 0xffffffff)
    const timestamp = this.now()

    this.db
      .prepare(
        `INSERT INTO area_requests (
           id, session_id, status, min_lat, max_lat, min_lon, max_lon,
           turbine_id, hub_height_m, start_date, end_date, iterations, evaluated,
           seed, temperature, created_at, updated_at
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        bounds.minLat,
        bounds.maxLat,
        bounds.minLon,
        bounds.maxLon,
        input.turbineId,
        input.hubHeightM,
        input.startDate,
        input.endDate,
        iterations,
        seed,
        INITIAL_TEMPERATURE,
        timestamp,
        timestamp,
      )

    // Seed the walk. The first point is drawn uniformly rather than from the centre, so
    // repeated runs over one area explore genuinely different starts.
    const start = randomPoint(bounds, mulberry32(seed))
    this.insertPoint(id, 0, start, INITIAL_TEMPERATURE)

    return this.get(id)!
  }

  get(id: string): AreaRequestRow | undefined {
    return this.db
      .prepare<[string], AreaRequestRow>('SELECT * FROM area_requests WHERE id = ?')
      .get(id)
  }

  list(sessionId: string, limit = 50): AreaRequestRow[] {
    return this.db
      .prepare<[string, number], AreaRequestRow>(
        'SELECT * FROM area_requests WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(sessionId, limit)
  }

  points(requestId: string): AnnealingPointRow[] {
    return this.db
      .prepare<[string], AnnealingPointRow>(
        'SELECT * FROM annealing_points WHERE request_id = ? ORDER BY seq',
      )
      .all(requestId)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM area_requests WHERE id = ?').run(id).changes > 0
  }

  pendingCount(): number {
    const row = this.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM annealing_points WHERE status = 'pending'")
      .get()
    return row?.n ?? 0
  }

  /**
   * Evaluate exactly one pending point, anywhere in the queue.
   *
   * Returns null when there is nothing to do. Ordering by `id` gives FIFO across all
   * requests, which is what makes concurrent optimizations share the upstream fairly
   * instead of the first one starving the rest.
   */
  async tick(): Promise<TickResult | null> {
    const point = this.db
      .prepare<[], AnnealingPointRow>(
        "SELECT * FROM annealing_points WHERE status = 'pending' ORDER BY id LIMIT 1",
      )
      .get()
    if (!point) return null

    const request = this.get(point.request_id)
    if (!request) {
      // Orphaned by a deleted request; drop it.
      this.db.prepare('DELETE FROM annealing_points WHERE id = ?').run(point.id)
      return null
    }

    if (request.status === 'pending') {
      this.db
        .prepare("UPDATE area_requests SET status = 'running', updated_at = ? WHERE id = ?")
        .run(this.now(), request.id)
      request.status = 'running'
    }

    const evaluation = await this.evaluate(request, point)

    if (!evaluation.ok) {
      return this.handleFailure(request, point, evaluation.error)
    }

    this.failureStreak.delete(request.id)
    return this.advance(request, point, evaluation.score, evaluation.powerKw)
  }

  private async evaluate(
    request: AreaRequestRow,
    point: AnnealingPointRow,
  ): Promise<{ ok: true; score: number; powerKw: number } | { ok: false; error: string }> {
    const model = getTurbineModel(request.turbine_id)
    if (!model) return { ok: false, error: `unknown turbine model: ${request.turbine_id}` }

    try {
      const series = await this.windCache.getSeries({
        latitude: point.latitude,
        longitude: point.longitude,
        startDate: request.start_date,
        endDate: request.end_date,
      })
      const prediction = predict(series, model, { hubHeightM: request.hub_height_m })
      // Capacity factor, not raw kW: it is bounded in [0,1], which is what makes the
      // exp(Δ/T) acceptance rule behave the same way for a 2 MW and a 7 MW machine.
      return { ok: true, score: prediction.capacityFactor, powerKw: prediction.meanPowerKw }
    } catch (cause) {
      return { ok: false, error: (cause as Error).message }
    }
  }

  private handleFailure(
    request: AreaRequestRow,
    point: AnnealingPointRow,
    error: string,
  ): TickResult {
    const timestamp = this.now()
    this.db
      .prepare("UPDATE annealing_points SET status = 'failed', error = ?, evaluated_at = ? WHERE id = ?")
      .run(error, timestamp, point.id)

    const streak = (this.failureStreak.get(request.id) ?? 0) + 1
    this.failureStreak.set(request.id, streak)

    if (streak >= this.maxConsecutiveFailures) {
      this.db
        .prepare("UPDATE area_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(error, timestamp, request.id)
      this.failureStreak.delete(request.id)

      const result: TickResult = {
        requestId: request.id,
        seq: point.seq,
        latitude: point.latitude,
        longitude: point.longitude,
        score: null,
        powerKw: null,
        accepted: false,
        isBest: false,
        status: 'failed',
        error,
      }
      this.emit(request.id, result)
      return result
    }

    // Retry the same location on a later tick, under a fresh sequence number, so a
    // transient upstream blip does not consume one of the request's iterations.
    const retryFrom: Point = { latitude: point.latitude, longitude: point.longitude }
    this.insertPoint(request.id, this.nextSeq(request.id), retryFrom, request.temperature)

    const result: TickResult = {
      requestId: request.id,
      seq: point.seq,
      latitude: point.latitude,
      longitude: point.longitude,
      score: null,
      powerKw: null,
      accepted: false,
      isBest: false,
      status: request.status,
      error,
    }
    this.emit(request.id, result)
    return result
  }

  private advance(
    request: AreaRequestRow,
    point: AnnealingPointRow,
    score: number,
    powerKw: number,
  ): TickResult {
    const timestamp = this.now()

    // One RNG per (seed, seq) so a tick's outcome never depends on how many other
    // requests happened to interleave with it.
    const rng = mulberry32(request.seed + point.seq * 0x9e3779b9)

    const isFirst = request.current_score === null
    const probability = isFirst
      ? 1
      : acceptanceProbability(request.current_score!, score, request.temperature)
    const accepted = isFirst || rng() < probability

    const isBest = request.best_score === null || score > request.best_score

    this.db
      .prepare(
        `UPDATE annealing_points
            SET status = 'evaluated', score = ?, power_kw = ?, accepted = ?, evaluated_at = ?
          WHERE id = ?`,
      )
      .run(score, powerKw, accepted ? 1 : 0, timestamp, point.id)

    if (isBest) {
      this.db
        .prepare('UPDATE annealing_points SET is_best = 0 WHERE request_id = ? AND is_best = 1')
        .run(request.id)
      this.db.prepare('UPDATE annealing_points SET is_best = 1 WHERE id = ?').run(point.id)
    }

    const evaluated = request.evaluated + 1
    const temperature = temperatureAt(evaluated, request.iterations)
    const done = evaluated >= request.iterations

    const currentLat = accepted ? point.latitude : request.current_lat
    const currentLon = accepted ? point.longitude : request.current_lon
    const currentScore = accepted ? score : request.current_score

    this.db
      .prepare(
        `UPDATE area_requests
            SET evaluated = ?, temperature = ?, status = ?,
                current_lat = ?, current_lon = ?, current_score = ?,
                best_lat = ?, best_lon = ?, best_score = ?, best_power_kw = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        evaluated,
        temperature,
        done ? 'complete' : 'running',
        currentLat,
        currentLon,
        currentScore,
        isBest ? point.latitude : request.best_lat,
        isBest ? point.longitude : request.best_lon,
        isBest ? score : request.best_score,
        isBest ? powerKw : request.best_power_kw,
        timestamp,
        request.id,
      )

    if (!done) {
      const from: Point = {
        latitude: currentLat ?? point.latitude,
        longitude: currentLon ?? point.longitude,
      }
      const bounds: Bounds = {
        minLat: request.min_lat,
        maxLat: request.max_lat,
        minLon: request.min_lon,
        maxLon: request.max_lon,
      }
      const next = proposeNeighbour(from, bounds, temperature, rng)
      this.insertPoint(request.id, this.nextSeq(request.id), next, temperature)
    }

    const result: TickResult = {
      requestId: request.id,
      seq: point.seq,
      latitude: point.latitude,
      longitude: point.longitude,
      score,
      powerKw,
      accepted,
      isBest,
      status: done ? 'complete' : 'running',
    }
    this.emit(request.id, result)
    return result
  }

  private nextSeq(requestId: string): number {
    const row = this.db
      .prepare<[string], { next: number }>(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM annealing_points WHERE request_id = ?',
      )
      .get(requestId)
    return row?.next ?? 0
  }

  private insertPoint(requestId: string, seq: number, point: Point, temperature: number): void {
    this.db
      .prepare(
        `INSERT INTO annealing_points
           (request_id, seq, latitude, longitude, status, temperature, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(requestId, seq, point.latitude, point.longitude, temperature, this.now())
  }

  private emit(requestId: string, result: TickResult): void {
    if (!this.bus) return
    const request = this.get(requestId)
    if (!request) return

    const event: ProgressEvent = {
      requestId,
      status: request.status,
      evaluated: request.evaluated,
      iterations: request.iterations,
      temperature: request.temperature,
      best:
        request.best_lat !== null && request.best_lon !== null
          ? {
              latitude: request.best_lat,
              longitude: request.best_lon,
              score: request.best_score ?? 0,
              powerKw: request.best_power_kw ?? 0,
            }
          : undefined,
      last: {
        latitude: result.latitude,
        longitude: result.longitude,
        score: result.score,
        accepted: result.accepted,
      },
      error: result.error,
    }
    this.bus.publish(event)
  }
}

function normaliseBounds(bounds: Bounds): Bounds {
  return {
    minLat: Math.min(bounds.minLat, bounds.maxLat),
    maxLat: Math.max(bounds.minLat, bounds.maxLat),
    minLon: Math.min(bounds.minLon, bounds.maxLon),
    maxLon: Math.max(bounds.minLon, bounds.maxLon),
  }
}

/**
 * Drive `tick()` on an interval until stopped. Overlapping runs are suppressed, so a
 * slow upstream call cannot cause two ticks to race.
 */
export function startWorker(
  service: AnnealingService,
  intervalMs: number,
): { stop: () => void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void service
      .tick()
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }, intervalMs)

  // Do not hold the process open just to poll an empty queue.
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
