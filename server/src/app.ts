import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'

import type { DB } from './db/index.js'
import type { AnnealingService, AreaRequestRow } from './lib/annealingService.js'
import type { ProgressBus, ProgressEvent } from './lib/events.js'
import { weightConditions } from './lib/annualAnalysis.js'
import { compareFarms } from './lib/comparison.js'
import { FieldService } from './lib/field.js'
import { WindSourceError } from './lib/openmeteo.js'
import { predict } from './lib/prediction.js'
import {
  ANALYSIS_QUANTITY_CLAIMS,
  ANNUAL_QUANTITY_CLAIMS,
  COMPARISON_QUANTITY_CLAIMS,
  PHYSICS_MODEL_VERSION,
  WAKE_LOSS_FRAMING,
  WIND_ROSE_QUANTITY_CLAIMS,
  getResultClaim,
  serialiseProvenance,
} from './lib/provenance.js'
import {
  BUNDLED_SCENES,
  SceneResolutionError,
  bundledSceneIds,
  getBundledScene,
  sceneToFieldRequest,
  sceneWindConditions,
  sceneWindSectorCount,
} from './lib/scenes.js'
import { BUNDLED_SITES } from './lib/sites.js'
import { TURBINE_MODELS, getTurbineModel, sweptAreaM2 } from './lib/turbines.js'
import type { TurbineModel } from './lib/turbines.js'
import type { WindCache } from './lib/windCache.js'
import { buildWindRose, commonSector, serialiseWindRose } from './lib/windRose.js'
import {
  ComparisonRequestSchema,
  CreateAreaRequestSchema,
  FieldRequestSchema,
  ListAreaRequestsSchema,
  SCENE_FORMAT_VERSION,
  SceneSchema,
  WindQuerySchema,
  WindRoseQuerySchema,
  validateDateRange,
} from './schemas.js'
import type { FieldRequestBody, SceneBody } from './schemas.js'

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
   * A pinned baseline against one candidate.
   *
   * Takes two complete field requests rather than a base plus a patch. A patch would be
   * smaller and would also make it possible to send a difference nobody can reconstruct: the
   * response has to be able to say what both sides *were*, because "the worst turbine changed"
   * is only meaningful next to the two scenes it changed between.
   */
  app.post('/api/comparison', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'body must be JSON' }, 400)
    }
    const parsed = ComparisonRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', issues: parsed.error.issues.map(formatIssue) }, 400)
    }

    const baselineModel = getTurbineModel(parsed.data.baseline.layout.turbine)
    const candidateModel = getTurbineModel(parsed.data.candidate.layout.turbine)
    if (!baselineModel || !candidateModel) {
      const missing = !baselineModel ? parsed.data.baseline.layout.turbine : parsed.data.candidate.layout.turbine
      return c.json({ error: 'unknown_turbine', message: `no such turbine: ${missing}` }, 404)
    }

    const baseline = fields.analyse(parsed.data.baseline, baselineModel)
    const candidate = fields.analyse(parsed.data.candidate, candidateModel)
    const comparison = compareFarms(baseline.analysis, candidate.analysis)

    return c.json({
      model_version: PHYSICS_MODEL_VERSION,
      baseline: describeSide(parsed.data.baseline, baselineModel, baseline.analysis.turbines.length),
      candidate: describeSide(parsed.data.candidate, candidateModel, candidate.analysis.turbines.length),
      turbines: comparison.turbines.map((delta) => ({
        turbine_id: delta.turbineId,
        baseline_net_power_kw: delta.baselineNetPowerKw,
        candidate_net_power_kw: delta.candidateNetPowerKw,
        delta_net_power_kw: delta.deltaNetPowerKw,
        baseline_gross_power_kw: delta.baselineGrossPowerKw,
        candidate_gross_power_kw: delta.candidateGrossPowerKw,
        delta_gross_power_kw: delta.deltaGrossPowerKw,
        baseline_wake_loss_kw: delta.baselineWakeLossKw,
        candidate_wake_loss_kw: delta.candidateWakeLossKw,
        delta_wake_loss_kw: delta.deltaWakeLossKw,
        baseline_wake_loss_fraction: delta.baselineWakeLossFraction,
        candidate_wake_loss_fraction: delta.candidateWakeLossFraction,
        delta_wake_loss_fraction: delta.deltaWakeLossFraction,
        baseline_incoming_speed_ms: delta.baselineIncomingSpeedMs,
        candidate_incoming_speed_ms: delta.candidateIncomingSpeedMs,
        delta_incoming_speed_ms: delta.deltaIncomingSpeedMs,
        baseline_dominant_contributor_id: delta.baselineDominantContributorId,
        candidate_dominant_contributor_id: delta.candidateDominantContributorId,
        dominant_contributor_changed: delta.dominantContributorChanged,
      })),
      farm: {
        baseline_total_net_power_kw: comparison.baselineTotalNetPowerKw,
        candidate_total_net_power_kw: comparison.candidateTotalNetPowerKw,
        delta_total_net_power_kw: comparison.deltaTotalNetPowerKw,
        baseline_total_gross_power_kw: comparison.baselineTotalGrossPowerKw,
        candidate_total_gross_power_kw: comparison.candidateTotalGrossPowerKw,
        delta_total_gross_power_kw: comparison.deltaTotalGrossPowerKw,
        baseline_total_wake_loss_kw: comparison.baselineTotalWakeLossKw,
        candidate_total_wake_loss_kw: comparison.candidateTotalWakeLossKw,
        delta_total_wake_loss_kw: comparison.deltaTotalWakeLossKw,
        baseline_farm_wake_loss_fraction: comparison.baselineFarmWakeLossFraction,
        candidate_farm_wake_loss_fraction: comparison.candidateFarmWakeLossFraction,
        delta_farm_wake_loss_fraction: comparison.deltaFarmWakeLossFraction,
        baseline_worst_turbine_id: comparison.baselineWorstTurbineId,
        candidate_worst_turbine_id: comparison.candidateWorstTurbineId,
        worst_turbine_changed: comparison.worstTurbineChanged,
        largest_mover_id: comparison.largestMoverId,
      },
      matched_turbine_ids: comparison.turbines.map((delta) => delta.turbineId),
      only_in_baseline: comparison.onlyInBaseline,
      only_in_candidate: comparison.onlyInCandidate,
      provenance: {
        model_version: PHYSICS_MODEL_VERSION,
        result: 'computed',
        wake_loss_framing: WAKE_LOSS_FRAMING,
        quantities: COMPARISON_QUANTITY_CLAIMS,
      },
    })
  })

  /**
   * Expected loss over a year, weighted by how often the wind blows from each direction.
   *
   * Takes a scene rather than a field request, because this is the one question that cannot
   * be asked of a field request: it needs the site's directional climate, and only a scene
   * carries one.
   */
  app.post('/api/annual', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'body must be JSON' }, 400)
    }
    const parsed = SceneSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_scene', issues: parsed.error.issues.map(formatIssue) }, 400)
    }
    const scene = parsed.data

    const model = getTurbineModel(scene.layout.turbine)
    if (!model) {
      return c.json({ error: 'unknown_turbine', message: `no such turbine: ${scene.layout.turbine}` }, 404)
    }

    const conditions = sceneWindConditions(scene)
    if (!conditions) {
      // Refusing is the point. A weighted figure needs a rose, and inventing a uniform one
      // would return a number that looks annual and describes nowhere.
      return c.json(
        {
          error: 'no_wind_rose',
          message:
            'this scene has no wind rose and its site has no recorded one, so an expected annual ' +
            'loss cannot be computed. Add a wind_rose to the scene, or fetch one from GET /api/wind-rose.',
        },
        422,
      )
    }
    if (conditions.length > MAX_ANNUAL_CONDITIONS) {
      return c.json(
        {
          error: 'invalid_scene',
          message:
            `at most ${MAX_ANNUAL_CONDITIONS} direction-and-speed cells can be weighted in one ` +
            `request, got ${conditions.length}. Use wider speed bins or fewer sectors.`,
        },
        400,
      )
    }

    let base: FieldRequestBody
    try {
      base = sceneToFieldRequest(scene)
    } catch (error) {
      if (error instanceof SceneResolutionError) {
        return c.json({ error: 'invalid_scene', message: error.message, available: error.available }, 400)
      }
      throw error
    }

    // D26, and this is where that bug would be most invisible: sweeping bearings without
    // pinning the array's orientation rotates the farm with every sector, so all twelve come
    // back identical and the "expected" loss is just the single-bearing loss wearing a hat.
    const orientationBearingDeg = base.layout.orientation_bearing_deg ?? base.wind.bearing_deg
    const pinned: FieldRequestBody = {
      ...base,
      layout: { ...base.layout, orientation_bearing_deg: orientationBearingDeg },
    }

    const analyses = fields.analyseConditions(pinned, model, conditions)
    const annual = weightConditions(
      conditions.map((condition, index) => ({
        bearingDeg: condition.bearingDeg,
        speedMs: condition.speedMs,
        frequency: condition.frequency,
        analysis: analyses[index]!,
      })),
    )

    return c.json({
      model_version: PHYSICS_MODEL_VERSION,
      scene: { id: scene.id, name: scene.name },
      layout: {
        turbine: model.id,
        turbine_name: model.name,
        count: annual.turbines.length,
        orientation_bearing_deg: orientationBearingDeg,
      },
      turbines: annual.turbines.map((turbine) => ({
        turbine_id: turbine.turbineId,
        weighted_gross_power_kw: turbine.weightedGrossPowerKw,
        weighted_net_power_kw: turbine.weightedNetPowerKw,
        weighted_wake_loss_kw: turbine.weightedWakeLossKw,
        weighted_wake_loss_fraction: turbine.weightedWakeLossFraction,
        worst_sector_bearing_deg: turbine.worst.bearingDeg,
        worst_sector_speed_ms: turbine.worst.speedMs,
        worst_sector_wake_loss_kw: turbine.worst.wakeLossKw,
        worst_sector_wake_loss_fraction: turbine.worst.wakeLossFraction,
        worst_sector_frequency: turbine.worst.frequency,
      })),
      farm: {
        weighted_gross_power_kw: annual.weightedGrossPowerKw,
        weighted_net_power_kw: annual.weightedNetPowerKw,
        weighted_wake_loss_kw: annual.weightedWakeLossKw,
        weighted_wake_loss_fraction: annual.weightedWakeLossFraction,
        worst_turbine_id: annual.worstTurbineId,
        worst_sector_bearing_deg: annual.worst.bearingDeg,
        worst_sector_speed_ms: annual.worst.speedMs,
        worst_sector_wake_loss_kw: annual.worst.wakeLossKw,
        worst_sector_wake_loss_fraction: annual.worst.wakeLossFraction,
        worst_sector_frequency: annual.worst.frequency,
      },
      sectors_evaluated: annual.directions.length,
      conditions_evaluated: annual.conditionsEvaluated,
      frequency_covered: annual.frequencyCovered,
      // Rolled up per direction rather than per condition: a rose is what the interface
      // draws, and a few hundred (direction, speed) rows is a table nobody reads.
      sectors: annual.directions.map((direction) => ({
        sector_bearing_deg: direction.bearingDeg,
        sector_weight: direction.frequency,
        wake_loss_fraction: direction.wakeLossFraction,
        gross_power_kw: direction.weightedGrossPowerKw,
        net_power_kw: direction.weightedNetPowerKw,
        conditions: direction.conditions,
      })),
      provenance: {
        model_version: PHYSICS_MODEL_VERSION,
        result: 'computed',
        wake_loss_framing: WAKE_LOSS_FRAMING,
        quantities: ANNUAL_QUANTITY_CLAIMS,
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

  /** Scenes that ship with the app, without their terrain payloads. */
  app.get('/api/scenes', (c) =>
    c.json({
      scene_format_version: SCENE_FORMAT_VERSION,
      scenes: BUNDLED_SCENES.map((scene) => ({
        id: scene.id,
        name: scene.name,
        description: scene.description,
        site_id: scene.terrain.site_id,
        turbine: scene.layout.turbine,
        turbine_count: sceneTurbineCount(scene),
        bearing_deg: scene.wind.bearing_deg,
        has_wind_rose: sceneWindSectorCount(scene) > 0,
      })),
      sites: BUNDLED_SITES.map((site) => ({
        id: site.id,
        name: site.name,
        latitude: site.latitude,
        longitude: site.longitude,
        terrain_provenance: site.terrainProvenance,
        terrain_summary: site.terrainSummary,
        has_wind_rose: Boolean(site.windRose),
      })),
    }),
  )

  /** One bundled scene, as the JSON a user could save, edit and load back. */
  app.get('/api/scenes/:id', (c) => {
    const scene = getBundledScene(c.req.param('id'))
    if (!scene) {
      return c.json({ error: 'not_found', message: 'no such scene', available: bundledSceneIds() }, 404)
    }
    return c.json({ scene, field_request: sceneToFieldRequest(scene) })
  })

  /**
   * Validate a scene and lower it onto a field request.
   *
   * The client sends a file here *before* it asks for a field, so a bad import fails as a
   * list of paths and messages rather than as a 400 from a physics endpoint about a body the
   * user never wrote. It is also the reason the format has one implementation: a second
   * validator in the browser would be a second opinion about what a valid scene is.
   */
  app.post('/api/scenes/validate', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: 'invalid_scene', message: 'that file is not valid JSON', issues: [] },
        400,
      )
    }

    const parsed = SceneSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_scene',
          message: 'that scene could not be loaded',
          issues: parsed.error.issues.map(formatIssue),
        },
        400,
      )
    }

    const scene = parsed.data
    const model = getTurbineModel(scene.layout.turbine)
    if (!model) {
      return c.json(
        {
          error: 'invalid_scene',
          message: `no such turbine: ${scene.layout.turbine}`,
          issues: [{ path: 'layout.turbine', message: `unknown turbine id "${scene.layout.turbine}"` }],
          available: TURBINE_MODELS.map((m) => m.id),
        },
        400,
      )
    }

    let fieldRequest: FieldRequestBody
    try {
      fieldRequest = sceneToFieldRequest(scene)
    } catch (error) {
      if (error instanceof SceneResolutionError) {
        return c.json(
          {
            error: 'invalid_scene',
            message: error.message,
            issues: [{ path: error.path, message: error.message }],
            available: error.available,
          },
          400,
        )
      }
      throw error
    }

    // The scene passed its own schema; it can still describe a farm the physics endpoints
    // would reject, and finding that out here is the whole point of validating first.
    const lowered = FieldRequestSchema.safeParse(fieldRequest)
    if (!lowered.success) {
      return c.json(
        {
          error: 'invalid_scene',
          message: 'that scene is well-formed but describes a field this server cannot solve',
          issues: lowered.error.issues.map(formatIssue),
        },
        400,
      )
    }

    return c.json({
      valid: true,
      scene,
      field_request: lowered.data,
      summary: {
        site_id: scene.terrain.site_id,
        terrain_source: 'elevations_m' in scene.terrain ? 'inline' : 'bundled-site',
        turbine: model.id,
        turbine_name: model.name,
        turbine_count: sceneTurbineCount(scene),
        bearing_deg: scene.wind.bearing_deg,
        speed_ms: scene.wind.speed_ms,
        // Named rather than implied: a scene with no rose cannot be weighted, and the
        // interface has to say that instead of quietly showing a single-bearing figure where
        // an annual one belongs.
        wind_rose_sectors: sceneWindSectorCount(scene),
        wind_rose_conditions: sceneWindConditions(scene)?.length ?? 0,
      },
    })
  })

  /**
   * Direction distribution at a point, and the sector a siting decision should be judged over.
   *
   * Every other result in this API answers "what happens at one bearing", which
   * `docs/design/alternate-bearing.md` showed is not a siting finding: the demonstration farm
   * moves 9 percentage points of wake loss across 5 degrees. This is the endpoint that says how
   * often each of those bearings actually blows.
   */
  app.get('/api/wind-rose', async (c) => {
    const parsed = WindRoseQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', issues: parsed.error.issues.map(formatIssue) }, 400)
    }
    const query = parsed.data

    const dateError = validateDateRange(query.date_from, query.date_to)
    if (dateError) return c.json({ error: 'invalid_request', message: dateError }, 400)

    const series = await windCache.getSeries({
      latitude: query.lat,
      longitude: query.lon,
      startDate: query.date_from,
      endDate: query.date_to,
    })

    const rose = buildWindRose(series, {
      sectors: query.sectors,
      height: query.height,
      startDate: query.date_from,
      endDate: query.date_to,
    })

    return c.json({
      requested: { latitude: query.lat, longitude: query.lon },
      ...serialiseWindRose(rose, commonSector(rose, query.coverage)),
      coverage: query.coverage,
      provenance: {
        model_version: PHYSICS_MODEL_VERSION,
        result: 'derived',
        quantities: WIND_ROSE_QUANTITY_CLAIMS,
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

/** Turbines a scene places, whichever of the two ways it places them. */
function sceneTurbineCount(scene: SceneBody): number {
  return scene.layout.turbines?.length ?? (scene.layout.rows ?? 0) * (scene.layout.columns ?? 0)
}

/**
 * Ceiling on sectors weighted in one request.
 *
 * Each sector is a separate base-flow solve on a cold cache. 36 is 10 degree bins, which is
 * already finer than the plus or minus 15 degree width of the only anchor the wake model has,
 * so this bounds the request without bounding anything the model can actually resolve.
 */
const MAX_ANNUAL_CONDITIONS = 600

/** What a comparison side *was*, so a delta can be read without the request beside it. */
function describeSide(input: FieldRequestBody, model: TurbineModel, count: number) {
  return {
    site_id: input.terrain.site_id,
    turbine: model.id,
    turbine_name: model.name,
    turbine_count: count,
    bearing_deg: input.wind.bearing_deg,
    speed_ms: input.wind.speed_ms,
    turbulence_intensity: input.wind.turbulence_intensity,
    orientation_bearing_deg: input.layout.orientation_bearing_deg ?? input.wind.bearing_deg,
    placement: input.layout.turbines ? 'explicit' : 'grid',
  }
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
