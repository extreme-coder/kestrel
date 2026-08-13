import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../src/db/index.js'
import type { DB } from '../src/db/index.js'
import {
  SERIES_SCHEMA_VERSION,
  WindSourceError,
  buildArchiveUrl,
  fetchWindSeries,
  parseArchiveResponse,
} from '../src/lib/openmeteo.js'
import { WindCache, cacheKey } from '../src/lib/windCache.js'
import { makeSeries, stubFetch, toArchiveJson } from './helpers/fakeWind.js'

const RANGE = { startDate: '2019-01-01', endDate: '2019-12-31' }

describe('archive URL', () => {
  it('requests every field the physics chain needs, in m/s', () => {
    const url = new URL(buildArchiveUrl({ latitude: 50.6, longitude: -0.3, ...RANGE }))
    const hourly = url.searchParams.get('hourly')?.split(',') ?? []

    expect(hourly).toContain('wind_speed_10m')
    expect(hourly).toContain('wind_speed_100m')
    // Directions are what make a wind rose possible; without them the "common sector" a
    // bearing choice rests on can only be assumed. See docs/design/alternate-bearing.md.
    expect(hourly).toContain('wind_direction_10m')
    expect(hourly).toContain('wind_direction_100m')
    expect(hourly).toContain('temperature_2m')
    expect(hourly).toContain('surface_pressure')
    expect(hourly).toContain('relative_humidity_2m')
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms')
    expect(url.searchParams.get('start_date')).toBe('2019-01-01')
    expect(url.searchParams.get('end_date')).toBe('2019-12-31')
  })
})

describe('parseArchiveResponse', () => {
  it('converts units into the internal representation', () => {
    const parsed = parseArchiveResponse({
      latitude: 50.65,
      longitude: -0.32,
      elevation: 12,
      hourly: {
        time: ['2019-01-01T00:00'],
        wind_speed_10m: [6],
        wind_speed_100m: [9],
        wind_direction_10m: [200],
        wind_direction_100m: [210],
        temperature_2m: [10],
        surface_pressure: [1013.25],
        relative_humidity_2m: [80],
      },
    })

    expect(parsed.elevationM).toBe(12)
    expect(parsed.samples).toHaveLength(1)
    // hPa becomes Pa, percent becomes a fraction.
    expect(parsed.samples[0]!.surfacePressurePa).toBeCloseTo(101325, 6)
    expect(parsed.samples[0]!.relativeHumidity).toBeCloseTo(0.8, 9)
    // Degrees are carried through unchanged: ERA5's meteorological "from" convention is
    // already the one the wake, layout and field-request code use.
    expect(parsed.samples[0]!.windDirection10mDeg).toBe(200)
    expect(parsed.samples[0]!.windDirection100mDeg).toBe(210)
  })

  it('folds a 360 degree bearing onto 0 so due north is one bin, not two', () => {
    const parsed = parseArchiveResponse({
      latitude: 1,
      longitude: 2,
      hourly: {
        time: ['2019-01-01T00:00'],
        wind_speed_10m: [6],
        wind_speed_100m: [9],
        wind_direction_10m: [360],
        wind_direction_100m: [360],
        temperature_2m: [10],
        surface_pressure: [1013],
        relative_humidity_2m: [80],
      },
    })
    expect(parsed.samples[0]!.windDirection100mDeg).toBe(0)
  })

  it('drops an hour that has a speed but no direction', () => {
    // The two are one measurement in polar form — ERA5 stores u and v — so an hour like this
    // should not exist. If one does, substituting a bearing would put a fabricated direction
    // into the rose as though it had been recorded.
    const parsed = parseArchiveResponse({
      latitude: 1,
      longitude: 2,
      hourly: {
        time: ['2019-01-01T00:00', '2019-01-01T01:00'],
        wind_speed_10m: [6, 6],
        wind_speed_100m: [9, 9],
        wind_direction_10m: [210, 210],
        wind_direction_100m: [210, null],
        temperature_2m: [10, 10],
        surface_pressure: [1013, 1013],
        relative_humidity_2m: [80, 80],
      },
    })
    expect(parsed.samples).toHaveLength(1)
  })

  it('drops hours with missing fields rather than imputing them', () => {
    const parsed = parseArchiveResponse({
      latitude: 1,
      longitude: 2,
      elevation: 0,
      hourly: {
        time: ['2019-01-01T00:00', '2019-01-01T01:00', '2019-01-01T02:00'],
        wind_speed_10m: [6, null, 6],
        wind_speed_100m: [9, 9, 9],
        wind_direction_10m: [210, 210, 210],
        wind_direction_100m: [210, 210, 210],
        temperature_2m: [10, 10, 10],
        surface_pressure: [1013, 1013, 1013],
        relative_humidity_2m: [80, 80, 80],
      },
    })
    expect(parsed.samples).toHaveLength(2)
  })

  it('defaults only humidity when it alone is missing', () => {
    const parsed = parseArchiveResponse({
      latitude: 1,
      longitude: 2,
      hourly: {
        time: ['2019-01-01T00:00'],
        wind_speed_10m: [6],
        wind_speed_100m: [9],
        wind_direction_10m: [210],
        wind_direction_100m: [210],
        temperature_2m: [10],
        surface_pressure: [1013],
        relative_humidity_2m: [null],
      },
    })
    expect(parsed.samples).toHaveLength(1)
    expect(parsed.samples[0]!.relativeHumidity).toBeCloseTo(0.8, 9)
  })

  it('surfaces upstream errors', () => {
    expect(() => parseArchiveResponse({ error: true, reason: 'out of range' })).toThrow(
      /out of range/,
    )
  })

  it('rejects a response with no hourly block or no usable rows', () => {
    expect(() => parseArchiveResponse({})).toThrow(WindSourceError)
    expect(() =>
      parseArchiveResponse({ hourly: { time: ['2019-01-01T00:00'], wind_speed_10m: [null] } }),
    ).toThrow(/no usable hourly samples/)
  })
})

describe('fetchWindSeries', () => {
  it('parses a successful response', async () => {
    const series = makeSeries({ hours: 3 })
    const stub = stubFetch(() => toArchiveJson(series))
    const result = await fetchWindSeries({ latitude: 50.6, longitude: -0.3, ...RANGE }, stub.fetch)
    expect(result.samples).toHaveLength(3)
  })

  it('reports the upstream reason on a non-OK status', async () => {
    const impl = async () =>
      new Response(JSON.stringify({ error: true, reason: 'Date is out of range' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    await expect(
      fetchWindSeries({ latitude: 0, longitude: 0, ...RANGE }, impl),
    ).rejects.toThrow(/Date is out of range/)
  })

  it('wraps network failures', async () => {
    const impl = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(
      fetchWindSeries({ latitude: 0, longitude: 0, ...RANGE }, impl),
    ).rejects.toThrow(/Could not reach Open-Meteo/)
  })
})

describe('WindCache', () => {
  let db: DB

  beforeEach(() => {
    db = openDatabase()
  })

  afterEach(() => {
    db.close()
  })

  const makeCache = (respond: () => unknown, overrides = {}) => {
    const stub = stubFetch(respond)
    const cache = new WindCache({
      db,
      fetchImpl: stub.fetch,
      minIntervalMs: 0,
      sleep: async () => {},
      ...overrides,
    })
    return { cache, stub }
  }

  it('builds keys that ignore sub-grid coordinate noise', () => {
    // ERA5 is a ~25 km grid; 50.6612 and 50.6588 are the same cell.
    expect(cacheKey({ latitude: 50.6612, longitude: -0.279, ...RANGE })).toBe(
      cacheKey({ latitude: 50.6588, longitude: -0.2812, ...RANGE }),
    )
    expect(cacheKey({ latitude: 50.66, longitude: -0.28, ...RANGE })).not.toBe(
      cacheKey({ latitude: 51.66, longitude: -0.28, ...RANGE }),
    )
    expect(cacheKey({ latitude: 50.66, longitude: -0.28, ...RANGE })).not.toBe(
      cacheKey({ latitude: 50.66, longitude: -0.28, startDate: '2018-01-01', endDate: '2018-12-31' }),
    )
  })

  it('leads the key with the series schema version', () => {
    // A stored series is JSON with a fixed shape and a 30-day TTL. When directions were added
    // at step 11, every row already in the cache lacked them — and a wind rose built from one
    // of those would have come out empty rather than obviously broken. A shape change has to
    // invalidate its own rows, the same way a physics change invalidates a cached volume.
    expect(cacheKey({ latitude: 50.66, longitude: -0.28, ...RANGE })).toBe(
      `v${SERIES_SCHEMA_VERSION}:50.66:-0.28:2019-01-01:2019-12-31`,
    )
  })

  it('serves a second identical request from cache', async () => {
    const { cache, stub } = makeCache(() => toArchiveJson(makeSeries({ hours: 2 })))
    const options = { latitude: 50.66, longitude: -0.28, ...RANGE }

    await cache.getSeries(options)
    await cache.getSeries(options)

    expect(stub.calls).toHaveLength(1)
    expect(cache.stats.hits).toBe(1)
    expect(cache.stats.misses).toBe(1)
  })

  it('survives a process restart, because the cache is on disk not in memory', async () => {
    const { cache, stub } = makeCache(() => toArchiveJson(makeSeries({ hours: 2 })))
    const options = { latitude: 50.66, longitude: -0.28, ...RANGE }
    await cache.getSeries(options)

    // A fresh cache object over the same database stands in for a restarted process.
    const { cache: reborn, stub: stub2 } = makeCache(() => toArchiveJson(makeSeries({ hours: 2 })))
    const series = await reborn.getSeries(options)

    expect(series.samples).toHaveLength(2)
    expect(stub.calls).toHaveLength(1)
    expect(stub2.calls).toHaveLength(0)
  })

  it('collapses concurrent requests for one cell into a single upstream call', async () => {
    const { cache, stub } = makeCache(() => toArchiveJson(makeSeries({ hours: 2 })))
    const options = { latitude: 50.66, longitude: -0.28, ...RANGE }

    const results = await Promise.all([
      cache.getSeries(options),
      cache.getSeries(options),
      cache.getSeries(options),
    ])

    expect(stub.calls).toHaveLength(1)
    expect(cache.stats.deduped).toBe(2)
    for (const r of results) expect(r.samples).toHaveLength(2)
  })

  it('never issues upstream calls simultaneously', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const impl = async (input: string) => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      const url = new URL(input)
      return new Response(
        JSON.stringify(
          toArchiveJson(makeSeries({ latitude: Number(url.searchParams.get('latitude')) })),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const cache = new WindCache({ db, fetchImpl: impl, minIntervalMs: 0, sleep: async () => {} })
    await Promise.all(
      [50.1, 50.2, 50.3, 50.4].map((latitude) =>
        cache.getSeries({ latitude, longitude: -0.28, ...RANGE }),
      ),
    )

    expect(maxConcurrent).toBe(1)
    expect(cache.stats.upstreamCalls).toBe(4)
  })

  it('waits the configured interval between distinct upstream calls', async () => {
    const slept: number[] = []
    let clock = 0
    const stub = stubFetch(() => toArchiveJson(makeSeries({ hours: 1 })))
    const cache = new WindCache({
      db,
      fetchImpl: stub.fetch,
      minIntervalMs: 250,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })

    await cache.getSeries({ latitude: 50.1, longitude: 0, ...RANGE })
    await cache.getSeries({ latitude: 50.2, longitude: 0, ...RANGE })

    // The second call had to wait out the remainder of the interval.
    expect(slept).toEqual([250])
  })

  it('keeps serving later callers after one upstream call fails', async () => {
    let call = 0
    const impl = async () => {
      call++
      if (call === 1) throw new Error('upstream exploded')
      return new Response(JSON.stringify(toArchiveJson(makeSeries({ hours: 1 }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const cache = new WindCache({ db, fetchImpl: impl, minIntervalMs: 0, sleep: async () => {} })

    await expect(cache.getSeries({ latitude: 50.1, longitude: 0, ...RANGE })).rejects.toThrow()
    await expect(cache.getSeries({ latitude: 50.2, longitude: 0, ...RANGE })).resolves.toBeDefined()
  })

  it('does not cache a failed fetch', async () => {
    let call = 0
    const impl = async () => {
      call++
      if (call === 1) throw new Error('transient')
      return new Response(JSON.stringify(toArchiveJson(makeSeries({ hours: 1 }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const cache = new WindCache({ db, fetchImpl: impl, minIntervalMs: 0, sleep: async () => {} })
    const options = { latitude: 50.1, longitude: 0, ...RANGE }

    await expect(cache.getSeries(options)).rejects.toThrow()
    await expect(cache.getSeries(options)).resolves.toBeDefined()
    expect(call).toBe(2)
  })

  it('treats entries past their TTL as misses', async () => {
    let clock = 1_000_000
    const stub = stubFetch(() => toArchiveJson(makeSeries({ hours: 1 })))
    const cache = new WindCache({
      db,
      fetchImpl: stub.fetch,
      minIntervalMs: 0,
      ttlMs: 1000,
      now: () => clock,
      sleep: async () => {},
    })
    const options = { latitude: 50.1, longitude: 0, ...RANGE }

    await cache.getSeries(options)
    expect(cache.peek(options)).toBeDefined()

    clock += 5000
    expect(cache.peek(options)).toBeUndefined()
    await cache.getSeries(options)
    expect(stub.calls).toHaveLength(2)
  })

  it('prunes stale rows', async () => {
    let clock = 1_000_000
    const stub = stubFetch(() => toArchiveJson(makeSeries({ hours: 1 })))
    const cache = new WindCache({
      db,
      fetchImpl: stub.fetch,
      minIntervalMs: 0,
      ttlMs: 1000,
      now: () => clock,
      sleep: async () => {},
    })

    await cache.getSeries({ latitude: 50.1, longitude: 0, ...RANGE })
    clock += 5000
    expect(cache.prune()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM wind_cache').get()).toEqual({ n: 0 })
  })
})
