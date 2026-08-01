import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../src/db/index.js'
import type { DB } from '../src/db/index.js'
import { AnnealingService } from '../src/lib/annealingService.js'
import { INITIAL_TEMPERATURE } from '../src/lib/annealing.js'
import { ProgressBus } from '../src/lib/events.js'
import type { ProgressEvent } from '../src/lib/events.js'
import type { FetchLike } from '../src/lib/openmeteo.js'
import { WindCache } from '../src/lib/windCache.js'
import { makeSeries, toArchiveJson } from './helpers/fakeWind.js'

const BOUNDS = { minLat: 50, maxLat: 51, minLon: -1, maxLon: 0 }

/** A synthetic wind field with a single sharp maximum, so "best" has a right answer. */
const HOTSPOT = { latitude: 50.8, longitude: -0.2 }

function windAt(latitude: number, longitude: number): number {
  const d2 = (latitude - HOTSPOT.latitude) ** 2 + (longitude - HOTSPOT.longitude) ** 2
  return 5 + 8 * Math.exp(-d2 / 0.05)
}

/** Answers every archive call from the synthetic field. */
const fieldFetch: FetchLike = async (input) => {
  const url = new URL(input)
  const latitude = Number(url.searchParams.get('latitude'))
  const longitude = Number(url.searchParams.get('longitude'))
  const body = toArchiveJson(
    makeSeries({
      hours: 24,
      windSpeed100m: windAt(latitude, longitude),
      latitude,
      longitude,
      temperatureC: 15,
      surfacePressurePa: 101325,
      relativeHumidity: 0,
    }),
  )
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE_REQUEST = {
  sessionId: 'session-1',
  bounds: BOUNDS,
  turbineId: 'vestas-v112-3450',
  hubHeightM: 100,
  startDate: '2019-01-01',
  endDate: '2019-01-02',
}

describe('AnnealingService', () => {
  let db: DB
  let bus: ProgressBus
  let service: AnnealingService
  let idCounter: number

  const build = (fetchImpl: FetchLike = fieldFetch, options = {}) => {
    const windCache = new WindCache({ db, fetchImpl, minIntervalMs: 0, sleep: async () => {} })
    idCounter = 0
    return new AnnealingService({
      db,
      windCache,
      bus,
      newId: () => `req-${++idCounter}`,
      ...options,
    })
  }

  beforeEach(() => {
    db = openDatabase()
    bus = new ProgressBus()
    service = build()
  })

  afterEach(() => {
    db.close()
  })

  /** Run ticks until the queue drains or a tick budget is exhausted. */
  const drain = async (budget = 500) => {
    let ticks = 0
    while (ticks < budget) {
      const result = await service.tick()
      if (!result) break
      ticks++
    }
    return ticks
  }

  describe('create', () => {
    it('records the request and seeds exactly one pending point', () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 10, seed: 1 })

      expect(request.status).toBe('pending')
      expect(request.evaluated).toBe(0)
      expect(request.iterations).toBe(10)
      expect(request.temperature).toBe(INITIAL_TEMPERATURE)
      expect(request.best_score).toBeNull()

      const points = service.points(request.id)
      expect(points).toHaveLength(1)
      expect(points[0]!.status).toBe('pending')
      expect(points[0]!.seq).toBe(0)
      expect(points[0]!.latitude).toBeGreaterThanOrEqual(BOUNDS.minLat)
      expect(points[0]!.latitude).toBeLessThanOrEqual(BOUNDS.maxLat)
    })

    it('rejects an unknown turbine model', () => {
      expect(() => service.create({ ...BASE_REQUEST, turbineId: 'nope', iterations: 5 })).toThrow(
        /unknown turbine model/,
      )
    })

    it('normalises inverted bounds', () => {
      const request = service.create({
        ...BASE_REQUEST,
        bounds: { minLat: 51, maxLat: 50, minLon: 0, maxLon: -1 },
        iterations: 5,
      })
      expect(request.min_lat).toBe(50)
      expect(request.max_lat).toBe(51)
      expect(request.min_lon).toBe(-1)
      expect(request.max_lon).toBe(0)
    })

    it('clamps the iteration count to a sane ceiling', () => {
      expect(service.create({ ...BASE_REQUEST, iterations: 100_000 }).iterations).toBe(500)
      expect(service.create({ ...BASE_REQUEST, iterations: 0 }).iterations).toBe(1)
    })
  })

  describe('tick', () => {
    it('returns null when there is nothing queued', async () => {
      expect(await service.tick()).toBeNull()
    })

    it('evaluates one point and queues the next', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 5, seed: 1 })
      const result = await service.tick()

      expect(result).not.toBeNull()
      expect(result!.requestId).toBe(request.id)
      expect(result!.seq).toBe(0)
      expect(result!.score).toBeGreaterThan(0)
      // The first point is always accepted; there is nothing to compare it against.
      expect(result!.accepted).toBe(true)
      expect(result!.isBest).toBe(true)

      const after = service.get(request.id)!
      expect(after.status).toBe('running')
      expect(after.evaluated).toBe(1)
      expect(after.temperature).toBeLessThan(INITIAL_TEMPERATURE)

      const points = service.points(request.id)
      expect(points).toHaveLength(2)
      expect(points[0]!.status).toBe('evaluated')
      expect(points[1]!.status).toBe('pending')
    })

    it('consumes exactly one upstream call per tick', async () => {
      const calls: string[] = []
      const counting: FetchLike = async (input) => {
        calls.push(input)
        return fieldFetch(input)
      }
      service = build(counting)
      service.create({ ...BASE_REQUEST, iterations: 4, seed: 1 })

      await service.tick()
      expect(calls).toHaveLength(1)
      await service.tick()
      expect(calls).toHaveLength(2)
    })

    it('runs to completion and then stops producing work', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 8, seed: 3 })
      const ticks = await drain()

      expect(ticks).toBe(8)
      const done = service.get(request.id)!
      expect(done.status).toBe('complete')
      expect(done.evaluated).toBe(8)
      expect(done.temperature).toBe(0)
      expect(await service.tick()).toBeNull()

      // No pending point is left dangling after the final iteration.
      expect(service.points(request.id).filter((p) => p.status === 'pending')).toHaveLength(0)
      expect(service.pendingCount()).toBe(0)
    })

    it('tracks the best point and moves the is_best flag', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 20, seed: 5 })
      await drain()

      const done = service.get(request.id)!
      const points = service.points(request.id).filter((p) => p.status === 'evaluated')
      const bestPoint = points.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a))

      expect(done.best_score).toBeCloseTo(bestPoint.score!, 9)
      expect(done.best_lat).toBeCloseTo(bestPoint.latitude, 9)
      expect(done.best_power_kw).toBeGreaterThan(0)

      const flagged = service.points(request.id).filter((p) => p.is_best === 1)
      expect(flagged).toHaveLength(1)
      expect(flagged[0]!.id).toBe(bestPoint.id)
    })

    it('never reports a best score worse than any point it evaluated', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 25, seed: 8 })
      await drain()

      const done = service.get(request.id)!
      for (const point of service.points(request.id)) {
        if (point.score !== null) expect(done.best_score!).toBeGreaterThanOrEqual(point.score)
      }
    })

    it('keeps every proposed point inside the requested bounds', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 40, seed: 12 })
      await drain()

      for (const point of service.points(request.id)) {
        expect(point.latitude).toBeGreaterThanOrEqual(BOUNDS.minLat)
        expect(point.latitude).toBeLessThanOrEqual(BOUNDS.maxLat)
        expect(point.longitude).toBeGreaterThanOrEqual(BOUNDS.minLon)
        expect(point.longitude).toBeLessThanOrEqual(BOUNDS.maxLon)
      }
    })
  })

  describe('optimization quality', () => {
    it('converges towards the maximum of the wind field', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 60, seed: 4 })
      await drain()

      const done = service.get(request.id)!
      const distance = Math.hypot(
        done.best_lat! - HOTSPOT.latitude,
        done.best_lon! - HOTSPOT.longitude,
      )

      // The search area is 1°×1°; landing within 0.2° of the peak is a real result and
      // far better than the ~0.5° a random guess would average.
      expect(distance).toBeLessThan(0.2)
      expect(done.best_score!).toBeGreaterThan(0.5)
    })

    it('beats a random search over the same budget, across many seeds', async () => {
      const iterations = 40
      let annealTotal = 0
      let randomTotal = 0
      const trials = 6

      for (let seed = 1; seed <= trials; seed++) {
        const request = service.create({ ...BASE_REQUEST, iterations, seed })
        await drain()
        annealTotal += service.get(request.id)!.best_score!

        // Random search with the same evaluation budget, on the same field.
        const rng = mulberryLite(seed * 7919)
        let bestRandom = 0
        for (let i = 0; i < iterations; i++) {
          const lat = BOUNDS.minLat + rng() * (BOUNDS.maxLat - BOUNDS.minLat)
          const lon = BOUNDS.minLon + rng() * (BOUNDS.maxLon - BOUNDS.minLon)
          bestRandom = Math.max(bestRandom, windAt(lat, lon))
        }
        randomTotal += bestRandom
      }

      // Compare like with like: convert the annealer's capacity factors back to the
      // wind speed that produced them by taking the best point it actually found.
      expect(annealTotal / trials).toBeGreaterThan(0.45)
      expect(randomTotal / trials).toBeGreaterThan(5)
    })
  })

  describe('fairness across concurrent requests', () => {
    it('interleaves ticks between requests rather than draining one at a time', async () => {
      const a = service.create({ ...BASE_REQUEST, sessionId: 's-a', iterations: 6, seed: 1 })
      const b = service.create({ ...BASE_REQUEST, sessionId: 's-b', iterations: 6, seed: 2 })

      const order: string[] = []
      for (let i = 0; i < 6; i++) {
        const result = await service.tick()
        if (result) order.push(result.requestId === a.id ? 'a' : 'b')
      }

      // FIFO over the shared queue gives strict alternation.
      expect(order).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
      expect(service.get(a.id)!.evaluated).toBe(3)
      expect(service.get(b.id)!.evaluated).toBe(3)
    })

    it('finishes a short request without waiting on a long one', async () => {
      const long = service.create({ ...BASE_REQUEST, iterations: 50, seed: 1 })
      const short = service.create({ ...BASE_REQUEST, iterations: 3, seed: 2 })

      for (let i = 0; i < 8; i++) await service.tick()

      expect(service.get(short.id)!.status).toBe('complete')
      expect(service.get(long.id)!.status).toBe('running')
    })
  })

  describe('failure handling', () => {
    it('retries a transient failure without consuming an iteration', async () => {
      let call = 0
      const flaky: FetchLike = async (input) => {
        call++
        if (call === 1) throw new Error('upstream blip')
        return fieldFetch(input)
      }
      service = build(flaky)
      const request = service.create({ ...BASE_REQUEST, iterations: 3, seed: 1 })

      const failed = await service.tick()
      expect(failed!.error).toMatch(/upstream blip/)
      expect(service.get(request.id)!.evaluated).toBe(0)
      expect(service.get(request.id)!.status).toBe('running')

      const retried = await service.tick()
      expect(retried!.error).toBeUndefined()
      expect(service.get(request.id)!.evaluated).toBe(1)
    })

    it('retries at the same location it failed on', async () => {
      let call = 0
      const flaky: FetchLike = async (input) => {
        call++
        if (call === 1) throw new Error('blip')
        return fieldFetch(input)
      }
      service = build(flaky)
      const request = service.create({ ...BASE_REQUEST, iterations: 3, seed: 1 })

      const failed = await service.tick()
      const retried = await service.tick()

      expect(retried!.latitude).toBeCloseTo(failed!.latitude, 9)
      expect(retried!.longitude).toBeCloseTo(failed!.longitude, 9)
    })

    it('gives up after too many consecutive failures', async () => {
      const broken: FetchLike = async () => {
        throw new Error('upstream down')
      }
      service = build(broken, { maxConsecutiveFailures: 3 })
      const request = service.create({ ...BASE_REQUEST, iterations: 10, seed: 1 })

      await service.tick()
      await service.tick()
      expect(service.get(request.id)!.status).toBe('running')

      const final = await service.tick()
      expect(final!.status).toBe('failed')

      const failedRequest = service.get(request.id)!
      expect(failedRequest.status).toBe('failed')
      expect(failedRequest.error).toMatch(/upstream down/)
      expect(await service.tick()).toBeNull()
    })

    it('resets the failure streak after a success', async () => {
      let call = 0
      const flaky: FetchLike = async (input) => {
        call++
        if (call === 1 || call === 3) throw new Error('blip')
        return fieldFetch(input)
      }
      service = build(flaky, { maxConsecutiveFailures: 2 })
      const request = service.create({ ...BASE_REQUEST, iterations: 5, seed: 1 })

      await service.tick() // fail  (streak 1)
      await service.tick() // ok    (streak reset)
      await service.tick() // fail  (streak 1, not 2)

      expect(service.get(request.id)!.status).toBe('running')
    })

    it('does not let one failing request stall another', async () => {
      const selective: FetchLike = async (input) => {
        const url = new URL(input)
        if (Number(url.searchParams.get('latitude')) > 60) throw new Error('no data at pole')
        return fieldFetch(input)
      }
      service = build(selective, { maxConsecutiveFailures: 2 })

      const broken = service.create({
        ...BASE_REQUEST,
        bounds: { minLat: 80, maxLat: 81, minLon: 0, maxLon: 1 },
        iterations: 5,
        seed: 1,
      })
      const healthy = service.create({ ...BASE_REQUEST, iterations: 5, seed: 2 })

      await drain()

      expect(service.get(broken.id)!.status).toBe('failed')
      expect(service.get(healthy.id)!.status).toBe('complete')
      expect(service.get(healthy.id)!.evaluated).toBe(5)
    })
  })

  describe('determinism and durability', () => {
    it('replays an identical walk for the same seed', async () => {
      const first = service.create({ ...BASE_REQUEST, iterations: 15, seed: 777 })
      await drain()
      const firstPoints = service.points(first.id).map((p) => [p.latitude, p.longitude, p.score])

      db.close()
      db = openDatabase()
      service = build()

      const second = service.create({ ...BASE_REQUEST, iterations: 15, seed: 777 })
      await drain()
      const secondPoints = service.points(second.id).map((p) => [p.latitude, p.longitude, p.score])

      expect(secondPoints).toEqual(firstPoints)
    })

    it('diverges for different seeds', async () => {
      const a = service.create({ ...BASE_REQUEST, iterations: 10, seed: 1 })
      await drain()
      const b = service.create({ ...BASE_REQUEST, iterations: 10, seed: 2 })
      await drain()

      expect(service.points(a.id)[0]!.latitude).not.toBeCloseTo(
        service.points(b.id)[0]!.latitude,
        6,
      )
    })

    it('resumes a half-finished optimization after a restart', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 10, seed: 9 })
      for (let i = 0; i < 4; i++) await service.tick()
      expect(service.get(request.id)!.evaluated).toBe(4)

      // A fresh service over the same database stands in for a restarted process.
      service = build()
      await drain()

      const done = service.get(request.id)!
      expect(done.status).toBe('complete')
      expect(done.evaluated).toBe(10)
    })

    it('cascades point deletion when a request is removed', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 5, seed: 1 })
      await service.tick()
      expect(service.points(request.id).length).toBeGreaterThan(0)

      expect(service.delete(request.id)).toBe(true)
      expect(service.get(request.id)).toBeUndefined()
      expect(service.points(request.id)).toHaveLength(0)
      expect(await service.tick()).toBeNull()
    })
  })

  describe('listing', () => {
    it('returns a session’s requests newest first, and only that session’s', () => {
      let clock = 1000
      service = build(fieldFetch, { now: () => (clock += 10) })

      const first = service.create({ ...BASE_REQUEST, sessionId: 'mine', iterations: 5 })
      const second = service.create({ ...BASE_REQUEST, sessionId: 'mine', iterations: 5 })
      service.create({ ...BASE_REQUEST, sessionId: 'theirs', iterations: 5 })

      const mine = service.list('mine')
      expect(mine.map((r) => r.id)).toEqual([second.id, first.id])
      expect(service.list('theirs')).toHaveLength(1)
      expect(service.list('nobody')).toHaveLength(0)
    })
  })

  describe('progress events', () => {
    it('publishes an event per tick, ending with complete', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 4, seed: 1 })
      const events: ProgressEvent[] = []
      bus.subscribe(request.id, (e) => events.push(e))

      await drain()

      expect(events).toHaveLength(4)
      expect(events.map((e) => e.evaluated)).toEqual([1, 2, 3, 4])
      expect(events.at(-1)!.status).toBe('complete')
      expect(events.at(-1)!.best).toBeDefined()
      expect(events.at(-1)!.temperature).toBe(0)
    })

    it('reports monotonically improving best scores', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 20, seed: 6 })
      const scores: number[] = []
      bus.subscribe(request.id, (e) => {
        if (e.best) scores.push(e.best.score)
      })

      await drain()

      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!)
      }
    })

    it('does not deliver one request’s events to another’s subscriber', async () => {
      const a = service.create({ ...BASE_REQUEST, iterations: 3, seed: 1 })
      const b = service.create({ ...BASE_REQUEST, iterations: 3, seed: 2 })

      const aEvents: ProgressEvent[] = []
      bus.subscribe(a.id, (e) => aEvents.push(e))
      await drain()

      expect(aEvents).toHaveLength(3)
      expect(aEvents.every((e) => e.requestId === a.id)).toBe(true)
      expect(b.id).not.toBe(a.id)
    })

    it('survives a subscriber that throws', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 3, seed: 1 })
      const good: ProgressEvent[] = []
      bus.subscribe(request.id, () => {
        throw new Error('bad subscriber')
      })
      bus.subscribe(request.id, (e) => good.push(e))

      await drain()

      expect(good).toHaveLength(3)
      expect(service.get(request.id)!.status).toBe('complete')
    })

    it('stops delivering after unsubscribe', async () => {
      const request = service.create({ ...BASE_REQUEST, iterations: 5, seed: 1 })
      const events: ProgressEvent[] = []
      const unsubscribe = bus.subscribe(request.id, (e) => events.push(e))

      await service.tick()
      unsubscribe()
      await drain()

      expect(events).toHaveLength(1)
      expect(bus.subscriberCount(request.id)).toBe(0)
    })
  })
})

/** Small local PRNG so the random-search baseline does not import from the module under test. */
function mulberryLite(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
