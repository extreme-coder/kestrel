import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'

import type { DB } from './db/index.js'
import type { AnnealingService, AreaRequestRow } from './lib/annealingService.js'
import type { ProgressBus, ProgressEvent } from './lib/events.js'
import { FieldService } from './lib/field.js'
import { WindSourceError } from './lib/openmeteo.js'
import { predict } from './lib/prediction.js'
import {
  ANALYSIS_QUANTITY_CLAIMS,
  PHYSICS_MODEL_VERSION,
  WAKE_LOSS_FRAMING,
  getResultClaim,
  serialiseProvenance,
} from './lib/provenance.js'
import { TURBINE_MODELS, getTurbineModel, sweptAreaM2 } from './lib/turbines.js'
import type { TurbineModel } from './lib/turbines.js'
import type { WindCache } from './lib/windCache.js'
import {
  CreateAreaRequestSchema,
  FieldRequestSchema,
  ListAreaRequestsSchema,
  WindQuerySchema,
  validateDateRange,
} from './schemas.js'
import type { FieldRequestBody } from './schemas.js'

export interface AppDeps {
  db: DB
  windCache: WindCache
  annealing: AnnealingService
  bus: ProgressBus
  corsOrigin?: string
  sseHeartbeatMs?: number
}

/** Public shape of an optimization request, with snake_case DB rows flattened out. */
function serialiseRequest(row: AreaRequestRow) {
  return {
    id: row.id,
    session_id: row.session_id,
    status: row.status,
    bounds: {
      min_lat: row.min_lat,
      max_lat: row.max_lat,
      min_lon: row.min_lon,
      max_lon: row.max_lon,
    },
    turbine: row.turbine_id,
    height: row.hub_height_m,
    date_from: row.start_date,
    date_to: row.end_date,
    iterations: row.iterations,
    evaluated: row.evaluated,
    progress: row.iterations > 0 ? row.evaluated / row.iterations : 0,
    temperature: row.temperature,
    best:
      row.best_lat !== null && row.best_lon !== null
        ? {
            latitude: row.best_lat,
            longitude: row.best_lon,
            capacity_factor: row.best_score,
            mean_power_kw: row.best_power_kw,
          }
        : null,
    error: row.error,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  }
}

export function createApp(deps: AppDeps): Hono {
  const { db, windCache, annealing, bus } = deps
  const heartbeatMs = deps.sseHeartbeatMs ?? 15_000
  const fields = new FieldService(db)

  const app = new Hono()

  app.use('*', cors({ origin: deps.corsOrigin ?? '*' }))

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    if (error instanceof WindSourceError) {
      // 502: we are fine, the upstream is not. Distinguishing this from a 500 matters
      // for the client, which can retry an upstream failure but not a bug here.
      return c.json({ error: 'wind_source_unavailable', message: error.message }, 502)
    }
    if (error instanceof RangeError) {
      return c.json({ error: 'invalid_request', message: error.message }, 400)
    }
    console.error('[kestrel] unhandled error', error)
    return c.json({ error: 'internal_error', message: 'unexpected server error' }, 500)
  })

  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      pending_points: annealing.pendingCount(),
      cache: windCache.stats,
    }),
  )

  /** The turbine catalogue, equivalent to the original's `GET turbines`. */
  app.get('/api/turbines', (c) =>
    c.json({
      turbines: TURBINE_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        manufacturer: model.manufacturer,
        rated_power_kw: model.ratedPowerKw,
        rotor_diameter_m: model.rotorDiameterM,
        swept_area_m2: Math.round(sweptAreaM2(model) * 100) / 100,
        cut_in_ms: model.cutInMs,
        rated_ms: model.ratedMs,
        cut_out_ms: model.cutOutMs,
        /** False for every model today; see the note in turbines.ts. */
        has_measured_curve: Boolean(model.curve && model.curve.length > 0),
      })),
    }),
  )

  /**
   * Where the numbers come from and what has been checked against a measurement.
   *
   * Separate from the results themselves because it is static per deploy, so the client can
   * fetch it once and cache it, and because `/api/field` returns binary and cannot carry it.
   */
  app.get('/api/provenance', (c) => c.json(serialiseProvenance()))

  app.post('/api/field', async (c) => {
    const scene = await readSceneRequest(c)
    if ('response' in scene) return scene.response
    const { input, model } = scene
    const result = fields.build(input, model)
    // The body is a velocity volume, so provenance travels in headers. A client that renders
    // this field without labelling it is presenting model output as observation; the two
    // claims below name what the volume actually is. Full record at GET /api/provenance.
    const baseFlow = getResultClaim('terrain-base-flow')
    const wake = getResultClaim('wake-deficit')
    return new Response(result.payload, {
      headers: {
        'content-type': 'application/vnd.kestrel.field',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-kestrel-cache': result.cacheHit ? 'hit' : 'miss',
        'x-kestrel-model-version': PHYSICS_MODEL_VERSION,
        'x-kestrel-provenance': 'computed',
        'x-kestrel-validation': `terrain-base-flow=${baseFlow?.validation};wake-deficit=${wake?.validation}`,
      },
    })
  })

  /**
   * Per-turbine numbers for the same scene `/api/field` draws.
   *
   * It takes the identical body deliberately: one request object describes one scene, and a
   * viewer that could send subtly different bodies to the two endpoints would show a picture
   * of one farm beside a table about another. The volume and these figures are read off a
   * single solve — see `FieldService.resolveScene`.
   */
  app.post('/api/analysis', async (c) => {
    const scene = await readSceneRequest(c)
    if ('response' in scene) return scene.response
    const { input, model } = scene
    const { analysis } = fields.analyse(input, model)

    return c.json({
      model_version: PHYSICS_MODEL_VERSION,
      wind: {
        bearing_deg: input.wind.bearing_deg,
        speed_ms: input.wind.speed_ms,
        reference_height_m: input.wind.reference_height_m,
        turbulence_intensity: input.wind.turbulence_intensity,
      },
      layout: {
        turbine: model.id,
        turbine_name: model.name,
        rotor_diameter_m: model.rotorDiameterM,
        rated_power_kw: model.ratedPowerKw,
        // Echoed because it is the difference between "the wind turned" and "the farm
        // turned", and a client comparing two bearings has to be able to tell.
        orientation_bearing_deg: input.layout.orientation_bearing_deg ?? input.wind.bearing_deg,
        count: analysis.turbines.length,
      },
      turbines: analysis.turbines.map((turbine) => ({
        id: turbine.turbineId,
        easting_m: turbine.eastingM,
        northing_m: turbine.northingM,
        ground_elevation_m: turbine.groundElevationM,
        hub_height_m: turbine.hubHeightM,
        gross_speed_ms: turbine.grossSpeedMs,
        incoming_speed_ms: turbine.incomingSpeedMs,
        deficit: turbine.deficit,
        thrust_coefficient: turbine.thrustCoefficient,
        gross_power_kw: turbine.grossPowerKw,
        net_power_kw: turbine.netPowerKw,
        wake_loss_kw: turbine.wakeLossKw,
        wake_loss_fraction: turbine.wakeLossFraction,
        dominant_contributor_id: turbine.dominantContributorId,
        wake_path: turbine.wakePath.map((point) => ({
          easting_m: point.eastingM,
          northing_m: point.northingM,
          elevation_m: point.elevationM,
          ground_elevation_m: point.groundElevationM,
          distance_m: point.distanceM,
        })),
        contributors: turbine.contributors.map((contributor) => ({
          turbine_id: contributor.turbineId,
          deficit: contributor.deficit,
          share: contributor.share,
          attributed_loss_kw: contributor.attributedLossKw,
          downwind_m: contributor.downwindM,
          downwind_d: contributor.downwindD,
          radial_m: contributor.radialM,
          radial_d: contributor.radialD,
        })),
      })),
      farm: {
        total_gross_power_kw: analysis.totalGrossPowerKw,
        total_net_power_kw: analysis.totalNetPowerKw,
        total_wake_loss_kw: analysis.totalWakeLossKw,
        farm_wake_loss_fraction: analysis.wakeLossFraction,
        worst_turbine_id: analysis.worstTurbineId,
      },
      // Every figure above is model output over a composition nothing has measured. The map
      // names the claim behind each one so a client can label the number it is about to
      // render, and the framing sentence is the hedge D24 requires to travel with a loss.
      provenance: {
        model_version: PHYSICS_MODEL_VERSION,
        result: 'computed',
        wake_loss_framing: WAKE_LOSS_FRAMING,
        quantities: ANALYSIS_QUANTITY_CLAIMS,
      },
    })
  })

  /**
   * Point prediction. Mirrors the original
   * `wind/?lat=&lon=&height=&turbine=&date_from=&date_to=&mean=month`.
   */
  app.get('/api/wind', async (c) => {
    const parsed = WindQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', issues: parsed.error.issues.map(formatIssue) },
        400,
      )
    }
    const query = parsed.data

    const dateError = validateDateRange(query.date_from, query.date_to)
    if (dateError) return c.json({ error: 'invalid_request', message: dateError }, 400)

    const model = getTurbineModel(query.turbine)
    if (!model) {
      return c.json(
        {
          error: 'unknown_turbine',
          message: `no such turbine model: ${query.turbine}`,
          available: TURBINE_MODELS.map((m) => m.id),
        },
        404,
      )
    }

    const series = await windCache.getSeries({
      latitude: query.lat,
      longitude: query.lon,
      startDate: query.date_from,
      endDate: query.date_to,
    })

    const prediction = predict(series, model, {
      hubHeightM: query.height,
      densityCorrection: query.density,
    })

    return c.json({
      requested: { latitude: query.lat, longitude: query.lon },
      resolved: {
        latitude: prediction.latitude,
        longitude: prediction.longitude,
        elevation_m: prediction.elevationM,
      },
      turbine: model.id,
      height: query.height,
      date_from: query.date_from,
      date_to: query.date_to,
      hours: prediction.hours,
      mean_wind_speed_ms: prediction.meanWindSpeedMs,
      mean_wind_speed_100m_ms: prediction.meanWindSpeed100mMs,
      mean_shear_exponent: prediction.meanShearExponent,
      mean_air_density_kg_m3: prediction.meanAirDensityKgM3,
      mean_power_kw: prediction.meanPowerKw,
      capacity_factor: prediction.capacityFactor,
      energy_kwh_per_month: prediction.energyKwhPerMonth,
      energy_kwh_per_year: prediction.energyKwhPerYear,
      homes_powered: prediction.homesPowered,
      monthly: query.mean === 'month' ? prediction.monthly : undefined,
      // Model output over reanalysis input, not an observation at this coordinate. The
      // client must not present these as measured; GET /api/provenance carries the detail.
      provenance: {
        model_version: PHYSICS_MODEL_VERSION,
        result: 'computed',
        inputs: { wind: 'derived', turbine_power: 'computed' },
        validation: getResultClaim('capacity-factor')?.validation,
      },
    })
  })

  /** Start an optimization. Equivalent to the original's `POST area-requests`. */
  app.post('/api/area-requests', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'body must be JSON' }, 400)
    }

    const parsed = CreateAreaRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', issues: parsed.error.issues.map(formatIssue) },
        400,
      )
    }
    const input = parsed.data

    const dateError = validateDateRange(input.date_from, input.date_to)
    if (dateError) return c.json({ error: 'invalid_request', message: dateError }, 400)

    if (!getTurbineModel(input.turbine)) {
      return c.json({ error: 'unknown_turbine', message: `no such turbine: ${input.turbine}` }, 404)
    }

    const request = annealing.create({
      sessionId: input.session_id,
      bounds: {
        minLat: input.bounds.min_lat,
        maxLat: input.bounds.max_lat,
        minLon: input.bounds.min_lon,
        maxLon: input.bounds.max_lon,
      },
      turbineId: input.turbine,
      hubHeightM: input.height,
      startDate: input.date_from,
      endDate: input.date_to,
      iterations: input.iterations,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    })

    return c.json(serialiseRequest(request), 201)
  })

  app.get('/api/area-requests', (c) => {
    const parsed = ListAreaRequestsSchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', issues: parsed.error.issues.map(formatIssue) },
        400,
      )
    }
    const rows = annealing.list(parsed.data.session_id, parsed.data.limit)
    return c.json({ area_requests: rows.map(serialiseRequest) })
  })

  app.get('/api/area-requests/:id', (c) => {
    const request = annealing.get(c.req.param('id'))
    if (!request) return c.json({ error: 'not_found' }, 404)
    return c.json(serialiseRequest(request))
  })

  /** Every candidate the walk has considered — the data behind Fig. 2 in the report. */
  app.get('/api/area-requests/:id/points', (c) => {
    const id = c.req.param('id')
    if (!annealing.get(id)) return c.json({ error: 'not_found' }, 404)

    return c.json({
      points: annealing.points(id).map((p) => ({
        seq: p.seq,
        latitude: p.latitude,
        longitude: p.longitude,
        status: p.status,
        capacity_factor: p.score,
        mean_power_kw: p.power_kw,
        temperature: p.temperature,
        accepted: p.accepted === null ? null : p.accepted === 1,
        is_best: p.is_best === 1,
        error: p.error,
      })),
    })
  })

  app.delete('/api/area-requests/:id', (c) => {
    if (!annealing.delete(c.req.param('id'))) return c.json({ error: 'not_found' }, 404)
    return c.body(null, 204)
  })

  /**
   * Progress stream, replacing the original's socket.io `progress` channel.
   *
   * Emits the current state immediately on connect — a client that subscribes late
   * still learns where the optimization got to — then one event per evaluated point,
   * and closes once the request reaches a terminal state.
   */
  app.get('/api/area-requests/:id/events', (c) => {
    const id = c.req.param('id')
    const request = annealing.get(id)
    if (!request) return c.json({ error: 'not_found' }, 404)

    return streamSSE(c, async (stream) => {
      const queue: ProgressEvent[] = []
      let wake: (() => void) | null = null

      const unsubscribe = bus.subscribe(id, (event) => {
        queue.push(event)
        wake?.()
        wake = null
      })

      const send = async (event: ProgressEvent) => {
        await stream.writeSSE({ event: 'progress', data: JSON.stringify(event) })
      }

      try {
        const current = annealing.get(id)
        if (!current) return

        await send({
          requestId: current.id,
          status: current.status,
          evaluated: current.evaluated,
          iterations: current.iterations,
          temperature: current.temperature,
          best:
            current.best_lat !== null && current.best_lon !== null
              ? {
                  latitude: current.best_lat,
                  longitude: current.best_lon,
                  score: current.best_score ?? 0,
                  powerKw: current.best_power_kw ?? 0,
                }
              : undefined,
          error: current.error ?? undefined,
        })

        if (current.status === 'complete' || current.status === 'failed') return

        while (!stream.aborted) {
          while (queue.length > 0) {
            const event = queue.shift()!
            await send(event)
            if (event.status === 'complete' || event.status === 'failed') return
          }

          // Wait for the next event, or emit a comment to keep the connection warm.
          let timer: ReturnType<typeof setTimeout> | undefined
          await new Promise<void>((resolve) => {
            wake = resolve
            timer = setTimeout(resolve, heartbeatMs)
          })
          if (timer) clearTimeout(timer)
          if (queue.length === 0 && !stream.aborted) {
            await stream.writeSSE({ event: 'heartbeat', data: '{}' })
          }
        }
      } finally {
        unsubscribe()
      }
    })
  })

  /** Cache statistics, handy when demonstrating that throttling is actually working. */
  app.get('/api/cache', (c) => {
    const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM wind_cache').get()
    return c.json({ entries: row?.n ?? 0, ...windCache.stats })
  })

  return app
}

function formatIssue(issue: { path: (string | number)[]; message: string }) {
  return { path: issue.path.join('.'), message: issue.message }
}

/**
 * Parse a scene request body and resolve its turbine, or produce the error response.
 *
 * Shared by `/api/field` and `/api/analysis` so the two cannot drift into accepting
 * different bodies — they describe the same scene and are meant to be sent the same one.
 */
async function readSceneRequest(
  c: Context,
): Promise<{ input: FieldRequestBody; model: TurbineModel } | { response: Response }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { response: c.json({ error: 'invalid_request', message: 'body must be JSON' }, 400) }
  }
  const parsed = FieldRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      response: c.json({ error: 'invalid_request', issues: parsed.error.issues.map(formatIssue) }, 400),
    }
  }
  const model = getTurbineModel(parsed.data.layout.turbine)
  if (!model) {
    return {
      response: c.json(
        { error: 'unknown_turbine', message: `no such turbine: ${parsed.data.layout.turbine}` },
        404,
      ),
    }
  }
  return { input: parsed.data, model }
}
