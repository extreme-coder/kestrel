import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { openDatabase } from '../src/db/index.js'
import type { DB } from '../src/db/index.js'
import { AnnealingService } from '../src/lib/annealingService.js'
import { ProgressBus } from '../src/lib/events.js'
import type { FetchLike } from '../src/lib/openmeteo.js'
import { PHYSICS_MODEL_VERSION } from '../src/lib/provenance.js'
import { WindCache } from '../src/lib/windCache.js'
import { SCENE_FORMAT_VERSION } from '../src/schemas.js'
import { makeSeries, toArchiveJson } from './helpers/fakeWind.js'

/** Concrete shape rather than `Record`, which `noUncheckedIndexedAccess` makes unusable. */
interface ProvenanceResponse {
  model_version: string
  validated_at: string
  results: {
    id: string
    provenance: string
    validation: string
    anchor?: { source: string; conditions: string; metric: string; result: string; limitations: string[] }
  }[]
  scene: {
    terrain: { provenance: string }
    layout: { provenance: string; status: string; statement: string }
  }
}

interface AnalysisResponse {
  layout: { orientation_bearing_deg: number; count: number }
  turbines: {
    id: string
    easting_m: number
    northing_m: number
    gross_speed_ms: number
    incoming_speed_ms: number
    wake_loss_fraction: number
    dominant_contributor_id: string | null
    contributors: { turbine_id: string; share: number; downwind_d: number }[]
  }[]
  farm: {
    total_gross_power_kw: number
    total_net_power_kw: number
    total_wake_loss_kw: number
    farm_wake_loss_fraction: number
    worst_turbine_id: string | null
  }
  provenance: {
    model_version: string
    result: string
    wake_loss_framing: string
    quantities: Record<string, string[] | undefined>
  }
}

interface SceneListResponse {
  scene_format_version: number
  scenes: { id: string; turbine_count: number; has_wind_rose: boolean }[]
  sites: { id: string; has_wind_rose: boolean }[]
}

interface SceneResponse {
  scene: { kestrel_scene: number; wind_rose?: unknown; layout: unknown; terrain: unknown }
  field_request: {
    terrain: { elevations_m: number[] }
    layout: { orientation_bearing_deg?: number }
  }
}

interface ValidateResponse {
  valid: boolean
  summary: {
    turbine_count: number
    terrain_source: string
    wind_rose_sectors: number
    wind_rose_conditions: number
  }
}

interface ComparisonResponse {
  baseline: { bearing_deg: number }
  candidate: { bearing_deg: number }
  turbines: { turbine_id: string; delta_net_power_kw: number }[]
  farm: {
    baseline_farm_wake_loss_fraction: number
    candidate_farm_wake_loss_fraction: number
    delta_total_net_power_kw: number
    worst_turbine_changed: boolean
  }
  matched_turbine_ids: string[]
  only_in_baseline: string[]
  provenance: { wake_loss_framing: string; quantities: Record<string, string[] | undefined> }
}

interface AnnualResponse {
  layout: { orientation_bearing_deg: number }
  turbines: Record<string, unknown>[]
  farm: {
    weighted_wake_loss_fraction: number
    worst_sector_wake_loss_fraction: number
    worst_sector_wake_loss_kw: number
    worst_sector_frequency: number
  }
  sectors: { sector_bearing_deg: number; wake_loss_fraction: number; conditions: number }[]
  sectors_evaluated: number
  conditions_evaluated: number
  frequency_covered: number
  provenance: { quantities: Record<string, string[] | undefined> }
}

interface WindRoseResponse {
  sector_width_deg: number
  sectors: {
    centre_deg: number
    from_deg: number
    frequency: number
    speed_bins: { frequency: number }[]
  }[]
  common_sector: { centre_deg: number }
  provenance: { result: string; quantities: Record<string, string[] | undefined> }
}

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

  describe('POST /api/field', () => {
    const body = {
      terrain: { site_id: 'flat', origin_easting_m: 0, origin_northing_m: 0, columns: 5, rows: 5, cell_size_easting_m: 500, cell_size_northing_m: 500, elevations_m: Array(25).fill(0) },
      layout: { turbine: 'vestas-v112-3450', rows: 1, columns: 1, hub_height_m: 100, origin_easting_m: 1000, origin_northing_m: 1000 },
      wind: { bearing_deg: 270, speed_ms: 10 },
      volume: { levels: 4, top_elevation_m: 500 },
    }

    it('returns and caches a KFLD binary volume', async () => {
      const first = await app.request('/api/field', postJson(body))
      expect(first.status).toBe(200)
      expect(first.headers.get('content-type')).toBe('application/vnd.kestrel.field')
      expect(first.headers.get('x-kestrel-cache')).toBe('miss')
      expect(new TextDecoder().decode((await first.arrayBuffer()).slice(0, 4))).toBe('KFLD')
      const second = await app.request('/api/field', postJson(body))
      expect(second.headers.get('x-kestrel-cache')).toBe('hit')
    })

    it('validates JSON, turbine ids, and terrain dimensions', async () => {
      expect((await app.request('/api/field', { method: 'POST', body: 'x' })).status).toBe(400)
      expect((await app.request('/api/field', postJson({ ...body, layout: { ...body.layout, turbine: 'nope' } }))).status).toBe(404)
      expect((await app.request('/api/field', postJson({ ...body, terrain: { ...body.terrain, elevations_m: [0] } }))).status).toBe(400)
    })

    it('labels the volume as model output', async () => {
      // The body is binary, so provenance has to travel in headers. A client that renders
      // this without labelling it presents a computation as an observation.
      const res = await app.request('/api/field', postJson(body))
      expect(res.headers.get('x-kestrel-provenance')).toBe('computed')
      expect(res.headers.get('x-kestrel-model-version')).toBe(PHYSICS_MODEL_VERSION)
      expect(res.headers.get('x-kestrel-validation')).toContain('terrain-base-flow=externally-anchored')
      expect(res.headers.get('x-kestrel-validation')).toContain('wake-deficit=externally-anchored')
    })
  })

  describe('POST /api/analysis', () => {
    /** Two turbines, one 8 D directly behind the other at a westerly. */
    const body = {
      terrain: { site_id: 'flat', origin_easting_m: 0, origin_northing_m: 0, columns: 9, rows: 5, cell_size_easting_m: 500, cell_size_northing_m: 500, elevations_m: Array(45).fill(0) },
      layout: { turbine: 'vestas-v112-3450', rows: 2, columns: 1, downwind_spacing_d: 8, hub_height_m: 100, orientation_bearing_deg: 270, origin_easting_m: 2000, origin_northing_m: 1000 },
      wind: { bearing_deg: 270, speed_ms: 9, turbulence_intensity: 0.08 },
      volume: { levels: 6, top_elevation_m: 600 },
    }

    it('reports per-turbine losses and ranks the upstream cause of each', async () => {
      const res = await app.request('/api/analysis', postJson(body))
      expect(res.status).toBe(200)
      const result = (await res.json()) as AnalysisResponse

      expect(result.turbines).toHaveLength(2)
      const [upwind, downwind] = result.turbines
      expect(upwind!.contributors).toEqual([])
      expect(upwind!.wake_loss_fraction).toBe(0)
      expect(downwind!.wake_loss_fraction).toBeGreaterThan(0.1)
      expect(downwind!.incoming_speed_ms).toBeLessThan(downwind!.gross_speed_ms)
      expect(downwind!.dominant_contributor_id).toBe(upwind!.id)
      expect(downwind!.contributors[0]!.share).toBeCloseTo(1, 3)

      expect(result.farm.worst_turbine_id).toBe(downwind!.id)
      expect(result.farm.total_net_power_kw).toBeLessThan(result.farm.total_gross_power_kw)
      expect(result.farm.farm_wake_loss_fraction).toBeGreaterThan(0)
    })

    it('takes the same body as /api/field, so the two describe one scene', async () => {
      expect((await app.request('/api/field', postJson(body))).status).toBe(200)
      expect((await app.request('/api/analysis', { method: 'POST', body: 'x' })).status).toBe(400)
      expect((await app.request('/api/analysis', postJson({ ...body, layout: { ...body.layout, turbine: 'nope' } }))).status).toBe(404)
      expect((await app.request('/api/analysis', postJson({ ...body, terrain: { ...body.terrain, elevations_m: [0] } }))).status).toBe(400)
    })

    it('keeps the layout still when only the wind turns', async () => {
      // D26. A farm that rotates with the wind shows identical geometry at every bearing, so
      // no wake relation ever changes and T3 has nothing to answer.
      const turned = { ...body, wind: { ...body.wind, bearing_deg: 240 } }
      const before = (await (await app.request('/api/analysis', postJson(body))).json()) as AnalysisResponse
      const after = (await (await app.request('/api/analysis', postJson(turned))).json()) as AnalysisResponse

      expect(after.layout.orientation_bearing_deg).toBe(270)
      expect(after.turbines.map((t) => [t.easting_m, t.northing_m]))
        .toEqual(before.turbines.map((t) => [t.easting_m, t.northing_m]))
      expect(after.farm.farm_wake_loss_fraction).toBeLessThan(before.farm.farm_wake_loss_fraction)
    })

    it('names the claim behind every quantity it reports', async () => {
      // ADR 0004 / D25: a reported quantity with no claim is a bug, not a default. The
      // client attaches a provenance chip from this map, so an unlisted field renders bare.
      const result = (await (await app.request('/api/analysis', postJson(body))).json()) as AnalysisResponse
      expect(result.provenance.result).toBe('computed')
      expect(result.provenance.model_version).toBe(PHYSICS_MODEL_VERSION)
      expect(result.provenance.wake_loss_framing).toContain('floor')

      const quantities = result.provenance.quantities
      for (const key of Object.keys(result.turbines[0]!)) {
        if (key === 'id') continue
        expect(quantities[key], `turbine field ${key}`).toBeDefined()
      }
      for (const key of Object.keys(result.farm)) {
        expect(quantities[key], `farm field ${key}`).toBeDefined()
      }
    })
  })

  describe('GET /api/scenes', () => {
    it('lists the bundled scenes and the sites they can name', async () => {
      const result = await json<SceneListResponse>(app.request('/api/scenes'))
      expect(result.scene_format_version).toBe(SCENE_FORMAT_VERSION)
      expect(result.scenes.map((scene) => scene.id)).toContain('askervein-demonstration')
      expect(result.scenes.map((scene) => scene.id)).toContain('askervein-testing')
      expect(result.sites.map((site) => site.id)).toContain('askervein-copernicus-glo30')
      // Terrain payloads are deliberately absent here: the list is for choosing, and a
      // thousand elevations per scene would make it the largest response in the API.
      expect(JSON.stringify(result).length).toBeLessThan(4000)
    })

    it('serves one scene with the field request it lowers onto', async () => {
      const result = await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))
      expect(result.scene.kestrel_scene).toBe(SCENE_FORMAT_VERSION)
      expect(result.field_request.terrain.elevations_m).toHaveLength(33 * 33)
      expect(result.field_request.layout.orientation_bearing_deg).toBe(210)
    })

    it('404s an unknown scene with the ids that exist', async () => {
      const res = await app.request('/api/scenes/not-a-scene')
      expect(res.status).toBe(404)
      const body = (await res.json()) as { available: string[] }
      expect(body.available).toContain('askervein-demonstration')
    })
  })

  describe('POST /api/scenes/validate', () => {
    let scene: Record<string, unknown>

    beforeEach(async () => {
      scene = (await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))).scene as unknown as Record<string, unknown>
    })

    it('accepts a bundled scene and reports what it describes', async () => {
      const result = await json<ValidateResponse>(app.request('/api/scenes/validate', postJson(scene)))
      expect(result.valid).toBe(true)
      expect(result.summary.turbine_count).toBe(4)
      expect(result.summary.terrain_source).toBe('bundled-site')
      expect(result.summary.wind_rose_sectors).toBe(12)
      expect(result.summary.wind_rose_conditions).toBeGreaterThan(200)
    })

    it('rejects a file that is not JSON, with a message about the file', async () => {
      const res = await app.request('/api/scenes/validate', { method: 'POST', body: 'not json' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe('invalid_scene')
      expect(body.message).toMatch(/not valid JSON/i)
    })

    it('names the path of every problem rather than failing on the first', async () => {
      // The point of validating before any field request: a bad import has to fail as a list
      // of paths the user can act on, not as a 400 from a physics endpoint about a body they
      // never wrote.
      const res = await app.request(
        '/api/scenes/validate',
        postJson({ ...scene, kestrel_scene: 99, wind: { bearing_deg: 'south', speed_ms: -4 } }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { issues: { path: string; message: string }[] }
      const paths = body.issues.map((issue) => issue.path)
      expect(paths).toContain('kestrel_scene')
      expect(paths.some((path) => path.startsWith('wind.'))).toBe(true)
    })

    it('rejects an unknown site with the list of sites that exist', async () => {
      const res = await app.request(
        '/api/scenes/validate',
        postJson({ ...scene, terrain: { site_id: 'ben-nevis' } }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { message: string; available: string[] }
      expect(body.message).toMatch(/bundled site/i)
      expect(body.available).toContain('askervein-copernicus-glo30')
    })

    it('rejects an unknown turbine with the catalogue', async () => {
      const res = await app.request(
        '/api/scenes/validate',
        postJson({ ...scene, layout: { ...(scene.layout as object), turbine: 'acme-1' } }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { available: string[] }
      expect(body.available).toContain('vestas-v112-3450')
    })

    it('rejects a wind rose whose frequencies do not close', async () => {
      // A rose that does not sum to 1 is not a distribution, and every weighted figure from it
      // would be silently scaled by whatever the sum happened to be.
      const rose = scene.wind_rose as { sectors: { frequency: number }[] }
      const broken = { ...rose, sectors: rose.sectors.map((sector) => ({ ...sector, frequency: sector.frequency / 2 })) }
      const res = await app.request('/api/scenes/validate', postJson({ ...scene, wind_rose: broken }))
      expect(res.status).toBe(400)
      const body = (await res.json()) as { issues: { path: string; message: string }[] }
      expect(body.issues.some((issue) => /sum to 1/.test(issue.message))).toBe(true)
    })

    it('accepts explicit turbine coordinates and rejects duplicate ids', async () => {
      const explicit = {
        ...scene,
        layout: {
          turbine: 'vestas-v112-3450',
          hub_height_m: 100,
          orientation_bearing_deg: 210,
          turbines: [
            { id: 'a', easting_m: 900, northing_m: 900 },
            { id: 'b', easting_m: 1400, northing_m: 1400 },
          ],
        },
      }
      const ok = await json<ValidateResponse>(app.request('/api/scenes/validate', postJson(explicit)))
      expect(ok.valid).toBe(true)
      expect(ok.summary.turbine_count).toBe(2)

      const duplicated = {
        ...explicit,
        layout: {
          ...explicit.layout,
          turbines: [
            { id: 'a', easting_m: 900, northing_m: 900 },
            { id: 'a', easting_m: 1400, northing_m: 1400 },
          ],
        },
      }
      const res = await app.request('/api/scenes/validate', postJson(duplicated))
      expect(res.status).toBe(400)
    })

    it('rejects a layout that is neither a grid nor a list of coordinates', async () => {
      const res = await app.request(
        '/api/scenes/validate',
        postJson({ ...scene, layout: { turbine: 'vestas-v112-3450', hub_height_m: 100 } }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { issues: { message: string }[] }
      expect(body.issues.some((issue) => /layout.turbines/.test(issue.message))).toBe(true)
    })
  })

  describe('POST /api/comparison', () => {
    const side = (bearingDeg: number) => ({
      terrain: { site_id: 'flat', origin_easting_m: 0, origin_northing_m: 0, columns: 9, rows: 9, cell_size_easting_m: 400, cell_size_northing_m: 400, elevations_m: Array(81).fill(0) },
      layout: { turbine: 'vestas-v112-3450', rows: 2, columns: 1, downwind_spacing_d: 8, hub_height_m: 100, orientation_bearing_deg: 270, origin_easting_m: 1600, origin_northing_m: 1600 },
      wind: { bearing_deg: bearingDeg, speed_ms: 9, turbulence_intensity: 0.08 },
      volume: { levels: 4, top_elevation_m: 600 },
    })

    it('differences two scenes and names what changed', async () => {
      const result = await json<ComparisonResponse>(
        app.request('/api/comparison', postJson({ baseline: side(270), candidate: side(180) })),
      )
      expect(result.baseline.bearing_deg).toBe(270)
      expect(result.candidate.bearing_deg).toBe(180)
      expect(result.matched_turbine_ids).toHaveLength(2)
      expect(result.only_in_baseline).toEqual([])
      // At 270 the array is in line and wakes; at 180 it is broadside and does not.
      expect(result.farm.baseline_farm_wake_loss_fraction).toBeGreaterThan(0.1)
      expect(result.farm.candidate_farm_wake_loss_fraction).toBeLessThan(0.01)
      expect(result.farm.delta_total_net_power_kw).toBeGreaterThan(0)
    })

    it('reports zero deltas when both sides are the same scene', async () => {
      const result = await json<ComparisonResponse>(
        app.request('/api/comparison', postJson({ baseline: side(270), candidate: side(270) })),
      )
      expect(result.farm.delta_total_net_power_kw).toBe(0)
      expect(result.farm.worst_turbine_changed).toBe(false)
      for (const delta of result.turbines) expect(delta.delta_net_power_kw).toBe(0)
    })

    it('names the claim behind every quantity it reports', async () => {
      const result = await json<ComparisonResponse>(
        app.request('/api/comparison', postJson({ baseline: side(270), candidate: side(180) })),
      )
      expect(result.provenance.wake_loss_framing).toContain('floor')
      // `baseline_x`, `candidate_x` and `delta_x` are three renderings of one quantity, so the
      // map may name the bare quantity — but every rendered field must resolve to something.
      const claimFor = (key: string) =>
        result.provenance.quantities[key] ??
        result.provenance.quantities[key.replace(/^(baseline|candidate|delta)_/, '')]
      for (const key of Object.keys(result.turbines[0]!)) {
        if (key === 'turbine_id') continue
        expect(claimFor(key), `comparison turbine field ${key}`).toBeDefined()
      }
      for (const key of Object.keys(result.farm)) {
        expect(claimFor(key), `comparison farm field ${key}`).toBeDefined()
      }
    })

    it('rejects a body missing a side, or naming a turbine that does not exist', async () => {
      expect((await app.request('/api/comparison', postJson({ baseline: side(270) }))).status).toBe(400)
      expect((await app.request('/api/comparison', { method: 'POST', body: 'x' })).status).toBe(400)
      const unknown = { ...side(270), layout: { ...side(270).layout, turbine: 'acme-1' } }
      expect(
        (await app.request('/api/comparison', postJson({ baseline: side(270), candidate: unknown }))).status,
      ).toBe(404)
    })
  })

  /**
   * These run against the real bundled rose, so each one is twelve mass-consistent solves on
   * a fresh in-memory database — the cache that makes this cheap in production is empty in
   * every `beforeEach`. That is 2-4 seconds idle and more on a loaded machine, comfortably
   * past vitest's 5 s default, so the budget is stated rather than left to be discovered as a
   * flake. Weighting a cheaper synthetic rose instead would stop testing the thing that
   * matters: that the shipped scene's dominant sector is not silently zeroed.
   */
  describe('POST /api/annual', { timeout: 45_000 }, () => {
    it('weights the whole rose and separates expected from worst', async () => {
      const scene = (await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))).scene
      const result = await json<AnnualResponse>(app.request('/api/annual', postJson(scene)))

      expect(result.frequency_covered).toBeCloseTo(1, 6)
      expect(result.sectors_evaluated).toBe(12)
      expect(result.conditions_evaluated).toBeGreaterThan(200)

      // The distinction the endpoint exists for. A rare severe condition must not be reported
      // as an annual expectation, and an annual expectation must not hide a severe condition.
      expect(result.farm.weighted_wake_loss_fraction).toBeGreaterThan(0)
      expect(result.farm.worst_sector_wake_loss_fraction).toBeGreaterThan(
        result.farm.weighted_wake_loss_fraction,
      )
      expect(result.farm.worst_sector_frequency).toBeLessThan(0.2)
      expect(result.farm.worst_sector_wake_loss_kw).toBeGreaterThan(0)
    })

    it('does not zero the dominant sector because its average speed is above rated', async () => {
      // The bug this endpoint was rebuilt to fix. Askervein's dominant sector has an
      // energy-equivalent speed of 13.1 m/s against the V112's 12.5 m/s rated, so weighting on
      // one speed per direction reported 0.00% loss at 210 degrees — the bearing the whole
      // demonstration is built around.
      const scene = (await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))).scene
      const result = await json<AnnualResponse>(app.request('/api/annual', postJson(scene)))
      const dominant = result.sectors.find((sector) => sector.sector_bearing_deg === 210)!
      expect(dominant.wake_loss_fraction).toBeGreaterThan(0.01)
      expect(dominant.conditions).toBeGreaterThan(10)
    })

    it('pins the array while it sweeps bearings', async () => {
      // D26 in its most invisible form: sweep direction without pinning orientation and the
      // farm rotates with the wind, so every sector returns identical geometry and the
      // "expected" loss is the single-bearing loss wearing a hat.
      const scene = (await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))).scene
      const result = await json<AnnualResponse>(app.request('/api/annual', postJson(scene)))
      expect(result.layout.orientation_bearing_deg).toBe(210)
      const losses = new Set(result.sectors.map((sector) => sector.wake_loss_fraction.toFixed(6)))
      expect(losses.size).toBeGreaterThan(1)
    })

    it('refuses rather than inventing a rose it does not have', async () => {
      const scene = (await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))).scene
      const homeless = { ...scene, wind_rose: undefined, terrain: { site_id: 'somewhere', columns: 3, rows: 3, cell_size_easting_m: 200, cell_size_northing_m: 200, elevations_m: [0, 0, 0, 0, 0, 0, 0, 0, 0] } }
      const res = await app.request('/api/annual', postJson(homeless))
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe('no_wind_rose')
      expect(body.message).toMatch(/wind-rose/)
    })

    it('names the claim behind every quantity it reports', async () => {
      const scene = (await json<SceneResponse>(app.request('/api/scenes/askervein-demonstration'))).scene
      const result = await json<AnnualResponse>(app.request('/api/annual', postJson(scene)))
      for (const key of Object.keys(result.turbines[0]!)) {
        expect(result.provenance.quantities[key], `turbine field ${key}`).toBeDefined()
      }
      for (const key of Object.keys(result.farm)) {
        expect(result.provenance.quantities[key], `farm field ${key}`).toBeDefined()
      }
    })
  })

  describe('GET /api/wind-rose', () => {
    it('bins direction into sectors centred on their nominal bearing', async () => {
      const result = await json<WindRoseResponse>(
        app.request('/api/wind-rose?lat=50.8&lon=-0.2&date_from=2019-01-01&date_to=2019-01-02'),
      )
      expect(result.sectors).toHaveLength(12)
      expect(result.sector_width_deg).toBe(30)
      expect(result.sectors[0]!.centre_deg).toBe(0)
      expect(result.sectors[0]!.from_deg).toBe(345)
      // The stub series blows steadily from 270.
      expect(result.sectors[9]!.centre_deg).toBe(270)
      expect(result.sectors[9]!.frequency).toBeCloseTo(1, 6)
      expect(result.common_sector.centre_deg).toBe(270)
    })

    it('carries speed bins, which is what makes weighting possible', async () => {
      const result = await json<WindRoseResponse>(app.request('/api/wind-rose?lat=50.8&lon=-0.2'))
      const dominant = result.sectors[9]!
      expect(dominant.speed_bins.length).toBeGreaterThan(0)
      const binned = dominant.speed_bins.reduce((sum, bin) => sum + bin.frequency, 0)
      expect(binned).toBeCloseTo(dominant.frequency, 6)
    })

    it('validates its query and its date range', async () => {
      expect((await app.request('/api/wind-rose?lon=-0.2')).status).toBe(400)
      expect((await app.request('/api/wind-rose?lat=50.8&lon=-0.2&sectors=3')).status).toBe(400)
      expect(
        (await app.request('/api/wind-rose?lat=50.8&lon=-0.2&date_from=2019-12-31&date_to=2019-01-01')).status,
      ).toBe(400)
    })

    it('names the claim behind every quantity it reports', async () => {
      const result = await json<WindRoseResponse>(app.request('/api/wind-rose?lat=50.8&lon=-0.2'))
      expect(result.provenance.result).toBe('derived')
      for (const key of ['frequency', 'energy_speed_ms', 'energy_share', 'common_sector']) {
        expect(result.provenance.quantities[key], key).toBeDefined()
      }
    })
  })

  describe('GET /api/provenance', () => {
    it('records where every result comes from and what has been checked', async () => {
      const res = await app.request('/api/provenance')
      expect(res.status).toBe(200)
      const body = (await res.json()) as ProvenanceResponse
      expect(body.model_version).toBe(PHYSICS_MODEL_VERSION)
      expect(body.results.length).toBeGreaterThan(0)

      for (const result of body.results) {
        expect(['measured', 'derived', 'computed']).toContain(result.provenance)
        expect(['externally-anchored', 'internally-tested', 'unvalidated']).toContain(result.validation)
      }

      const wake = body.results.find((result) => result.id === 'wake-deficit')
      expect(wake?.anchor?.source).toContain('10.1002/we.1625')
      expect(wake?.anchor?.limitations.length).toBeGreaterThan(0)
    })

    it('separates the measured terrain from the invented turbines on it', async () => {
      const body = (await (await app.request('/api/provenance')).json()) as ProvenanceResponse
      expect(body.scene.terrain.provenance).toBe('measured')
      expect(body.scene.layout.status).toBe('synthetic-demonstration')
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
