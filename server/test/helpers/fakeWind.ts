import type { FetchLike, WindSample, WindSeries } from '../../src/lib/openmeteo.js'

/**
 * Builds a synthetic hourly series with a known mean, so tests can assert on physics
 * rather than on whatever ERA5 happened to record.
 */
export function makeSeries(options: {
  hours?: number
  /** Constant 100 m wind speed, or a function of hour index. */
  windSpeed100m?: number | ((hour: number) => number)
  windSpeed10m?: number | ((hour: number) => number)
  temperatureC?: number
  surfacePressurePa?: number
  relativeHumidity?: number
  startTime?: string
  latitude?: number
  longitude?: number
  elevationM?: number
}): WindSeries {
  const {
    hours = 24,
    windSpeed100m = 10,
    windSpeed10m,
    temperatureC = 15,
    surfacePressurePa = 101325,
    relativeHumidity = 0,
    startTime = '2019-01-01T00:00',
    latitude = 50.65,
    longitude = -0.32,
    elevationM = 0,
  } = options

  const start = new Date(`${startTime}:00Z`).getTime()
  const at = (v: number | ((h: number) => number), h: number) => (typeof v === 'function' ? v(h) : v)

  const samples: WindSample[] = []
  for (let h = 0; h < hours; h++) {
    const w100 = at(windSpeed100m, h)
    // Default the 10 m field to a 1/7-power-law profile consistent with the 100 m value.
    const w10 = windSpeed10m === undefined ? w100 * Math.pow(10 / 100, 1 / 7) : at(windSpeed10m, h)
    samples.push({
      time: new Date(start + h * 3600_000).toISOString().slice(0, 16),
      windSpeed10mMs: w10,
      windSpeed100mMs: w100,
      temperatureC,
      surfacePressurePa,
      relativeHumidity,
    })
  }

  return { latitude, longitude, elevationM, samples }
}

/** Shapes a WindSeries back into the raw Open-Meteo archive JSON. */
export function toArchiveJson(series: WindSeries): unknown {
  return {
    latitude: series.latitude,
    longitude: series.longitude,
    elevation: series.elevationM,
    hourly: {
      time: series.samples.map((s) => s.time),
      wind_speed_10m: series.samples.map((s) => s.windSpeed10mMs),
      wind_speed_100m: series.samples.map((s) => s.windSpeed100mMs),
      temperature_2m: series.samples.map((s) => s.temperatureC),
      surface_pressure: series.samples.map((s) => s.surfacePressurePa / 100),
      relative_humidity_2m: series.samples.map((s) => s.relativeHumidity * 100),
    },
  }
}

export interface StubFetch {
  fetch: FetchLike
  calls: string[]
}

/** A `fetch` stub that answers every archive request with the given series. */
export function stubFetch(
  respond: (url: URL) => unknown | Promise<unknown>,
  init: { status?: number } = {},
): StubFetch {
  const calls: string[] = []
  const impl: FetchLike = async (input) => {
    calls.push(input)
    const body = await respond(new URL(input))
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch: impl, calls }
}
