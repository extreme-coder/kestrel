import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { openDatabase } from '../src/db/index.js'
import type { DB } from '../src/db/index.js'
import { AnnealingService } from '../src/lib/annealingService.js'
import { ProgressBus } from '../src/lib/events.js'
import type { FetchLike } from '../src/lib/openmeteo.js'
import { WindCache } from '../src/lib/windCache.js'
import { makeSeries, toArchiveJson } from './helpers/fakeWind.js'

/** Synthetic field with a maximum near 50.8 N, 0.2 W. */
function windAt(latitude: number, longitude: number): number {
  const d2 = (latitude - 50.8) ** 2 + (longitude + 0.2) ** 2
  return 5 + 8 * Math.exp(-d2 / 0.05)
}

const fieldFetch: FetchLike = async (input) => {
  const url = new URL(input)
  const latitude = Number(url.searchParams.get('latitude'))
  const longitude = Number(url.searchParams.get('longitude'))
  return new Response(
    JSON.stringify(
      toArchiveJson(
        makeSeries({
          hours: 48,
          windSpeed100m: windAt(latitude, longitude),
          latitude,
          longitude,
          temperatureC: 15,
          surfacePressurePa: 101325,
          relativeHumidity: 0,
        }),
      ),
    ),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const AREA_BODY = {
  session_id: 'sess-1',
  bounds: { min_lat: 50, max_lat: 51, min_lon: -1, max_lon: 0 },
  turbine: 'vestas-v112-3450',
  height: 100,
  iterations: 5,
  date_from: '2019-01-01',
  date_to: '2019-01-02',
  seed: 42,
}

const postJson = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** `app.request` returns Response | Promise<Response>; this normalises and types it. */
async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

interface WindResponse {
  turbine: string
  height: number
  date_from: string
  date_to: string
  hours: number
  mean_power_kw: number
  capacity_factor: number
  energy_kwh_per_month: number
  energy_kwh_per_year: number
  homes_powered: number
  monthly?: unknown[]
  resolved: { latitude: number; longitude: number; elevation_m: number }
}

describe('API', () => {
  let db: DB
  let app: Hono
  let annealing: AnnealingService
  let bus: ProgressBus

  const build = (fetchImpl: FetchLike = fieldFetch) => {
    const windCache = new WindCache({ db, fetchImpl, minIntervalMs: 0, sleep: async () => {} })
    bus = new ProgressBus()
    annealing = new AnnealingService({ db, windCache, bus })
    app = createApp({ db, windCache, annealing, bus, sseHeartbeatMs: 50 })
  }

  beforeEach(() => {
    db = openDatabase()
    build()
  })

  afterEach(() => {
    db.close()
  })

  describe('GET /api/health', () => {
    it('reports ok', async () => {
      const res = await app.request('/api/health')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'ok', pending_points: 0 })
    })
  })

  describe('GET /api/turbines', () => {
    it('returns the catalogue with specs', async () => {
      const res = await app.request('/api/turbines')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { turbines: Record<string, unknown>[] }
      expect(body.turbines.length).toBeGreaterThanOrEqual(13)

      const v112 = body.turbines.find((t) => t.id === 'vestas-v112-3450')
      expect(v112).toMatchObject({
        name: 'V112-3450',
        manufacturer: 'Vestas',
        rated_power_kw: 3450,
        rotor_diameter_m: 112,
      })
      expect(v112!.swept_area_m2).toBeCloseTo(9852.03, 1)
    })

    it('sets CORS headers so a browser client can call it', async () => {
      const res = await app.request('/api/turbines', { headers: { origin: 'https://example.com' } })
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })
  })

  describe('GET /api/wind', () => {
    const query = 'lat=50.8&lon=-0.2&height=100&turbine=vestas-v112-3450&date_from=2019-01-01&date_to=2019-01-02'

    it('returns a prediction with monthly breakdown', async () => {
      const res = await app.request(`/api/wind?${query}`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as Record<string, any>
      expect(body.turbine).toBe('vestas-v112-3450')
      expect(body.mean_power_kw).toBeGreaterThan(0)
      expect(body.capacity_factor).toBeGreaterThan(0)
      expect(body.capacity_factor).toBeLessThanOrEqual(1)
      expect(body.homes_powered).toBeGreaterThan(0)
      expect(body.monthly).toHaveLength(12)
      expect(body.hours).toBe(48)
      expect(body.resolved.latitude).toBeCloseTo(50.8, 6)
    })

    it('omits the monthly breakdown when mean=none', async () => {
      const res = await app.request(`/api/wind?${query}&mean=none`)
      expect((await res.json() as Record<string, unknown>).monthly).toBeUndefined()
    })

    it('keeps energy figures internally consistent', async () => {
      const body = await json<WindResponse>(app.request(`/api/wind?${query}`))
      expect(body.energy_kwh_per_month).toBeCloseTo(body.energy_kwh_per_year / 12, 3)
      expect(body.homes_powered).toBeCloseTo(body.energy_kwh_per_month / 886, 6)
    })

    it('predicts more power at the field maximum than away from it', async () => {
      const at = (lat: number, lon: number) =>
        json<WindResponse>(
          app.request(
            `/api/wind?lat=${lat}&lon=${lon}&turbine=vestas-v112-3450&date_from=2019-01-01&date_to=2019-01-02`,
          ),
        )

      const peak = await at(50.8, -0.2)
      const corner = await at(50.02, -0.98)
      expect(peak.mean_power_kw).toBeGreaterThan(corner.mean_power_kw)
    })

    it('honours the IEC density correction', async () => {
      const res = await app.request(`/api/wind?${query}&density=iec`)
      expect(res.status).toBe(200)
      expect((await res.json() as Record<string, number>).capacity_factor).toBeLessThanOrEqual(1)
    })

    it('defaults height and the date window', async () => {
      const res = await app.request('/api/wind?lat=50.8&lon=-0.2&turbine=vestas-v112-3450')
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.height).toBe(100)
      expect(body.date_from).toBe('2019-01-01')
      expect(body.date_to).toBe('2019-12-31')
    })

    it('rejects a missing or unknown turbine', async () => {
      expect((await app.request('/api/wind?lat=50&lon=0')).status).toBe(400)

      const unknown = await app.request('/api/wind?lat=50&lon=0&turbine=flying-spaghetti')
      expect(unknown.status).toBe(404)
      const body = (await unknown.json()) as Record<string, unknown>
      expect(body.error).toBe('unknown_turbine')
      expect(Array.isArray(body.available)).toBe(true)
    })

    it('rejects out-of-range coordinates', async () => {
      const res = await app.request('/api/wind?lat=200&lon=0&turbine=vestas-v112-3450')
      expect(res.status).toBe(400)
      expect((await res.json() as Record<string, unknown>).error).toBe('invalid_request')
    })

    it('rejects malformed and inverted date ranges', async () => {
      const malformed = await app.request(
        '/api/wind?lat=50&lon=0&turbine=vestas-v112-3450&date_from=01-01-2019',
      )
      expect(malformed.status).toBe(400)

      const inverted = await app.request(
        '/api/wind?lat=50&lon=0&turbine=vestas-v112-3450&date_from=2019-12-31&date_to=2019-01-01',
      )
      expect(inverted.status).toBe(400)
      expect((await inverted.json() as Record<string, string>).message).toMatch(/must not precede/)
    })

    it('rejects a range longer than the archive usefully serves', async () => {
      const res = await app.request(
        '/api/wind?lat=50&lon=0&turbine=vestas-v112-3450&date_from=2000-01-01&date_to=2019-12-31',
      )
      expect(res.status).toBe(400)
      expect((await res.json() as Record<string, string>).message).toMatch(/5 years/)
    })

    it('returns 502, not 500, when the upstream fails', async () => {
      build(async () => {
        throw new Error('upstream down')
      })
      const res = await app.request(`/api/wind?${query}`)
      expect(res.status).toBe(502)
      expect((await res.json() as Record<string, string>).error).toBe('wind_source_unavailable')
    })

    it('serves a repeat query from cache', async () => {
      const calls: string[] = []
      build(async (input) => {
        calls.push(input)
        return fieldFetch(input)
      })

      await app.request(`/api/wind?${query}`)
      await app.request(`/api/wind?${query}`)
      expect(calls).toHaveLength(1)

      const cache = (await (await app.request('/api/cache')).json()) as Record<string, number>
      expect(cache.entries).toBe(1)
      expect(cache.hits).toBe(1)
    })
  })

  describe('POST /api/area-requests', () => {
    it('creates a request and returns 201', async () => {
      const res = await app.request('/api/area-requests', postJson(AREA_BODY))
      expect(res.status).toBe(201)

      const body = (await res.json()) as Record<string, any>
      expect(body.id).toBeTruthy()
      expect(body.status).toBe('pending')
      expect(body.evaluated).toBe(0)
      expect(body.progress).toBe(0)
      expect(body.iterations).toBe(5)
      expect(body.best).toBeNull()
      expect(body.bounds).toEqual(AREA_BODY.bounds)
    })

    it('defaults iterations and the date window', async () => {
      const { iterations, date_from, date_to, ...rest } = AREA_BODY
      const res = await app.request('/api/area-requests', postJson(rest))
      const body = (await res.json()) as Record<string, unknown>
      expect(body.iterations).toBe(40)
      expect(body.date_from).toBe('2019-01-01')
    })

    it('rejects a non-JSON body', async () => {
      const res = await app.request('/api/area-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })

    it('rejects a missing session_id', async () => {
      const { session_id, ...rest } = AREA_BODY
      const res = await app.request('/api/area-requests', postJson(rest))
      expect(res.status).toBe(400)
      const body = (await res.json()) as { issues: { path: string }[] }
      expect(body.issues.some((i) => i.path === 'session_id')).toBe(true)
    })

    it('rejects a zero-area bounding box', async () => {
      const res = await app.request(
        '/api/area-requests',
        postJson({ ...AREA_BODY, bounds: { min_lat: 50, max_lat: 50, min_lon: -1, max_lon: 0 } }),
      )
      expect(res.status).toBe(400)
    })

    it('rejects an unknown turbine', async () => {
      const res = await app.request('/api/area-requests', postJson({ ...AREA_BODY, turbine: 'nope' }))
      expect(res.status).toBe(404)
    })

    it('caps iterations at the documented maximum', async () => {
      const res = await app.request('/api/area-requests', postJson({ ...AREA_BODY, iterations: 99999 }))
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/area-requests', () => {
    it('lists only the given session, newest first', async () => {
      const first = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      const second = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      await app.request('/api/area-requests', postJson({ ...AREA_BODY, session_id: 'other' }))

      const res = await app.request('/api/area-requests?session_id=sess-1')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { area_requests: { id: string }[] }
      expect(body.area_requests.map((r) => r.id)).toEqual([second.id, first.id])
    })

    it('requires a session_id', async () => {
      expect((await app.request('/api/area-requests')).status).toBe(400)
    })

    it('returns an empty list for an unknown session', async () => {
      const res = await app.request('/api/area-requests?session_id=ghost')
      expect((await res.json() as { area_requests: unknown[] }).area_requests).toEqual([])
    })
  })

  describe('GET /api/area-requests/:id', () => {
    it('reports progress as the worker advances', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }

      await annealing.tick()
      await annealing.tick()

      const body = await (await app.request(`/api/area-requests/${created.id}`)).json() as Record<string, any>
      expect(body.status).toBe('running')
      expect(body.evaluated).toBe(2)
      expect(body.progress).toBeCloseTo(0.4, 6)
      expect(body.best.capacity_factor).toBeGreaterThan(0)
      expect(body.temperature).toBeLessThan(2)
    })

    it('reaches complete and reports a best location inside the bounds', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      for (let i = 0; i < 5; i++) await annealing.tick()

      const body = await (await app.request(`/api/area-requests/${created.id}`)).json() as Record<string, any>
      expect(body.status).toBe('complete')
      expect(body.progress).toBe(1)
      expect(body.best.latitude).toBeGreaterThanOrEqual(50)
      expect(body.best.latitude).toBeLessThanOrEqual(51)
      expect(body.best.mean_power_kw).toBeGreaterThan(0)
    })

    it('404s for an unknown id', async () => {
      expect((await app.request('/api/area-requests/does-not-exist')).status).toBe(404)
    })
  })

  describe('GET /api/area-requests/:id/points', () => {
    it('exposes the walk, including acceptance and the best flag', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      for (let i = 0; i < 5; i++) await annealing.tick()

      const body = await (await app.request(`/api/area-requests/${created.id}/points`)).json() as {
        points: Record<string, any>[]
      }

      expect(body.points).toHaveLength(5)
      expect(body.points[0]!.seq).toBe(0)
      expect(body.points[0]!.accepted).toBe(true)
      expect(body.points.every((p) => p.status === 'evaluated')).toBe(true)
      expect(body.points.filter((p) => p.is_best)).toHaveLength(1)
      // Temperature falls monotonically across the walk.
      const temps = body.points.map((p) => p.temperature as number)
      expect([...temps].sort((a, b) => b - a)).toEqual(temps)
    })

    it('404s for an unknown id', async () => {
      expect((await app.request('/api/area-requests/nope/points')).status).toBe(404)
    })
  })

  describe('DELETE /api/area-requests/:id', () => {
    it('removes the request and its points', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }

      const res = await app.request(`/api/area-requests/${created.id}`, { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect((await app.request(`/api/area-requests/${created.id}`)).status).toBe(404)
      expect(annealing.pendingCount()).toBe(0)
    })

    it('404s when deleting twice', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      await app.request(`/api/area-requests/${created.id}`, { method: 'DELETE' })
      expect((await app.request(`/api/area-requests/${created.id}`, { method: 'DELETE' })).status).toBe(404)
    })
  })

  describe('GET /api/area-requests/:id/events (SSE)', () => {
    /** Read SSE frames until the stream closes, or the frame budget is hit. */
    async function readEvents(body: ReadableStream<Uint8Array>, budget = 50) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      const events: { event: string; data: Record<string, any> }[] = []
      let buffer = ''

      while (events.length < budget) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let split: number
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)

          const eventName = /^event:\s*(.*)$/m.exec(frame)?.[1]?.trim()
          const data = /^data:\s*(.*)$/m.exec(frame)?.[1]
          if (eventName && data) events.push({ event: eventName, data: JSON.parse(data) })
        }
      }
      reader.releaseLock()
      return events
    }

    it('streams progress and closes on completion', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }

      const res = await app.request(`/api/area-requests/${created.id}/events`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

      // Drive the worker once the stream is open.
      const driving = (async () => {
        for (let i = 0; i < 5; i++) await annealing.tick()
      })()

      const events = await readEvents(res.body!)
      await driving

      const progress = events.filter((e) => e.event === 'progress')
      // One immediate snapshot on connect, then one per evaluated point.
      expect(progress).toHaveLength(6)
      expect(progress[0]!.data.evaluated).toBe(0)
      expect(progress.at(-1)!.data.status).toBe('complete')
      expect(progress.at(-1)!.data.evaluated).toBe(5)
      expect(progress.at(-1)!.data.best.score).toBeGreaterThan(0)
    })

    it('sends the current state immediately to a late subscriber', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      for (let i = 0; i < 3; i++) await annealing.tick()

      const res = await app.request(`/api/area-requests/${created.id}/events`)
      const driving = (async () => {
        for (let i = 0; i < 2; i++) await annealing.tick()
      })()
      const events = await readEvents(res.body!)
      await driving

      // The first frame reflects work already done, not a zeroed state.
      expect(events[0]!.data.evaluated).toBe(3)
      expect(events.at(-1)!.data.status).toBe('complete')
    })

    it('closes immediately for an already-finished request', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      for (let i = 0; i < 5; i++) await annealing.tick()

      const res = await app.request(`/api/area-requests/${created.id}/events`)
      const events = await readEvents(res.body!)

      expect(events).toHaveLength(1)
      expect(events[0]!.data.status).toBe('complete')
    })

    it('404s for an unknown id', async () => {
      const res = await app.request('/api/area-requests/nope/events')
      expect(res.status).toBe(404)
    })

    it('unsubscribes when the client goes away', async () => {
      const created = await (await app.request('/api/area-requests', postJson(AREA_BODY))).json() as { id: string }
      const res = await app.request(`/api/area-requests/${created.id}/events`)

      const reader = res.body!.getReader()
      await reader.read()
      expect(bus.subscriberCount(created.id)).toBe(1)

      await reader.cancel()
      // Advance the worker so the stream loop notices the abort and unwinds.
      await annealing.tick()
      await annealing.tick()
      await new Promise((r) => setTimeout(r, 20))

      expect(bus.subscriberCount(created.id)).toBe(0)
    })
  })

  describe('unknown routes', () => {
    it('404s with a JSON body', async () => {
      const res = await app.request('/api/nonsense')
      expect(res.status).toBe(404)
      expect((await res.json() as Record<string, string>).error).toBe('not_found')
    })
  })
})
