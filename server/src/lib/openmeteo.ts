/**
 * Wind data source.
 *
 * Replaces windatlas.xyz, which the original Windsim depended on and which is no longer
 * available. Open-Meteo's ERA5 archive is a strict improvement for this use:
 *
 *   - no API key, and CORS-enabled, so the browser could call it directly if we wanted
 *   - global land and ocean coverage, which fixes the original's documented limitation
 *     that "data is only available for points near the coast"
 *   - hourly reanalysis back to 1940, so predictions are reproducible rather than
 *     dependent on whatever the upstream happened to hold that day
 *
 * ERA5 is a ~25 km reanalysis, so it resolves synoptic weather rather than local
 * topographic acceleration. That is the dominant error term in any prediction made here.
 */

export interface WindSample {
  /** ISO-8601 local-to-UTC timestamp, hourly. */
  time: string
  windSpeed10mMs: number
  windSpeed100mMs: number
  temperatureC: number
  surfacePressurePa: number
  /** Relative humidity in [0, 1]. */
  relativeHumidity: number
}

export interface WindSeries {
  /** Grid cell centre Open-Meteo actually resolved, which differs from what was asked. */
  latitude: number
  longitude: number
  elevationM: number
  samples: WindSample[]
}

export interface FetchWindOptions {
  latitude: number
  longitude: number
  /** Inclusive ISO date, YYYY-MM-DD. */
  startDate: string
  /** Inclusive ISO date, YYYY-MM-DD. */
  endDate: string
  signal?: AbortSignal
}

export const OPEN_METEO_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'

const HOURLY_FIELDS = [
  'wind_speed_10m',
  'wind_speed_100m',
  'temperature_2m',
  'surface_pressure',
  'relative_humidity_2m',
] as const

export class WindSourceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'WindSourceError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function buildArchiveUrl(options: FetchWindOptions): string {
  const url = new URL(OPEN_METEO_ARCHIVE_URL)
  url.searchParams.set('latitude', String(options.latitude))
  url.searchParams.set('longitude', String(options.longitude))
  url.searchParams.set('start_date', options.startDate)
  url.searchParams.set('end_date', options.endDate)
  url.searchParams.set('hourly', HOURLY_FIELDS.join(','))
  // Ask for m/s directly rather than converting from km/h, so rounding happens once.
  url.searchParams.set('wind_speed_unit', 'ms')
  return url.toString()
}

interface ArchiveResponse {
  latitude?: number
  longitude?: number
  elevation?: number
  error?: boolean
  reason?: string
  hourly?: {
    time?: string[]
    wind_speed_10m?: (number | null)[]
    wind_speed_100m?: (number | null)[]
    temperature_2m?: (number | null)[]
    surface_pressure?: (number | null)[]
    relative_humidity_2m?: (number | null)[]
  }
}

/** Parse an archive response body into a WindSeries, dropping hours with gaps. */
export function parseArchiveResponse(body: unknown): WindSeries {
  const data = body as ArchiveResponse

  if (data?.error) {
    throw new WindSourceError(`Open-Meteo rejected the request: ${data.reason ?? 'unknown'}`)
  }

  const hourly = data?.hourly
  const times = hourly?.time
  if (!hourly || !Array.isArray(times)) {
    throw new WindSourceError('Open-Meteo response contained no hourly series')
  }

  const samples: WindSample[] = []
  for (let i = 0; i < times.length; i++) {
    const time = times[i]
    const w10 = hourly.wind_speed_10m?.[i]
    const w100 = hourly.wind_speed_100m?.[i]
    const temp = hourly.temperature_2m?.[i]
    const pressureHpa = hourly.surface_pressure?.[i]
    const humidityPct = hourly.relative_humidity_2m?.[i]

    // ERA5 has occasional nulls. Skip the hour rather than imputing — a wind farm's
    // output is dominated by the tail of the distribution, and invented values there
    // would quietly bias the annual mean.
    if (
      typeof time !== 'string' ||
      typeof w10 !== 'number' ||
      typeof w100 !== 'number' ||
      typeof temp !== 'number' ||
      typeof pressureHpa !== 'number'
    ) {
      continue
    }

    samples.push({
      time,
      windSpeed10mMs: w10,
      windSpeed100mMs: w100,
      temperatureC: temp,
      surfacePressurePa: pressureHpa * 100,
      relativeHumidity: typeof humidityPct === 'number' ? humidityPct / 100 : 0.8,
    })
  }

  if (samples.length === 0) {
    throw new WindSourceError('Open-Meteo returned no usable hourly samples')
  }

  return {
    latitude: typeof data.latitude === 'number' ? data.latitude : Number.NaN,
    longitude: typeof data.longitude === 'number' ? data.longitude : Number.NaN,
    elevationM: typeof data.elevation === 'number' ? data.elevation : 0,
    samples,
  }
}

/** Fetch an hourly wind series from the ERA5 archive. */
export async function fetchWindSeries(
  options: FetchWindOptions,
  fetchImpl: FetchLike = fetch,
): Promise<WindSeries> {
  const url = buildArchiveUrl(options)

  let response: Response
  try {
    response = await fetchImpl(url, {
      signal: options.signal as RequestInit['signal'],
      headers: { accept: 'application/json' },
    })
  } catch (cause) {
    throw new WindSourceError(`Could not reach Open-Meteo: ${(cause as Error).message}`)
  }

  if (!response.ok) {
    let reason = response.statusText
    try {
      const body = (await response.json()) as ArchiveResponse
      if (body?.reason) reason = body.reason
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new WindSourceError(`Open-Meteo returned ${response.status}: ${reason}`, response.status)
  }

  return parseArchiveResponse(await response.json())
}
