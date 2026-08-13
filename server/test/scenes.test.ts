import { describe, expect, it } from 'vitest'

import { solveMassConsistentBaseFlow } from '../src/lib/baseFlow.js'
import { analyseTerrainFarm } from '../src/lib/farmAnalysis.js'
import type { FarmAnalysis } from '../src/lib/farmAnalysis.js'
import {
  ASKERVEIN_DEMONSTRATION_SCENE,
  ASKERVEIN_TESTING_SCENE,
  BUNDLED_SCENES,
  SceneResolutionError,
  TESTING_SCENE_BEARINGS_DEG,
  sceneToFieldRequest,
  sceneWindConditions,
} from '../src/lib/scenes.js'
import { BUNDLED_SITES, getBundledSite } from '../src/lib/sites.js'
import { buildWakeStreamlines } from '../src/lib/terrainWake.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { windTravelVector } from '../src/lib/wake.js'
import { FieldRequestSchema, SCENE_FORMAT_VERSION, SceneSchema } from '../src/schemas.js'
import type { SceneBody } from '../src/schemas.js'

describe('bundled scenes', () => {
  it('every bundled scene passes the schema a user-supplied file has to pass', () => {
    // Bundled and imported scenes have to go through one gate. A bundled scene that could not
    // survive its own validator is a format with two definitions, and the second one is the
    // undocumented one.
    for (const scene of BUNDLED_SCENES) {
      const parsed = SceneSchema.safeParse(scene)
      expect(parsed.success, `${scene.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('every bundled scene lowers onto a field request the physics endpoints accept', () => {
    for (const scene of BUNDLED_SCENES) {
      const parsed = FieldRequestSchema.safeParse(sceneToFieldRequest(scene))
      expect(parsed.success, `${scene.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('names a real turbine and a real site', () => {
    for (const scene of BUNDLED_SCENES) {
      expect(getTurbineModel(scene.layout.turbine), scene.id).toBeDefined()
      if (!('elevations_m' in scene.terrain)) {
        expect(getBundledSite(scene.terrain.site_id), scene.id).toBeDefined()
      }
    }
  })

  it('states its format version', () => {
    for (const scene of BUNDLED_SCENES) expect(scene.kestrel_scene).toBe(SCENE_FORMAT_VERSION)
  })

  it('says where its terrain and its turbines came from', () => {
    // The terrain is measured and the turbines are invented. Rendered together they read as a
    // wind farm, and there is no wind farm at Askervein.
    for (const scene of BUNDLED_SCENES) {
      expect(scene.provenance?.terrain, scene.id).toMatch(/measured/i)
      expect(scene.provenance?.layout, scene.id).toMatch(/invented/i)
    }
  })
})

describe('sceneToFieldRequest', () => {
  it('resolves terrain named by site id into the site\'s own grid', () => {
    const request = sceneToFieldRequest(ASKERVEIN_DEMONSTRATION_SCENE)
    const site = getBundledSite('askervein-copernicus-glo30')!
    const grid = site.grid()
    expect(request.terrain.columns).toBe(grid.columns)
    expect(request.terrain.elevations_m).toHaveLength(grid.columns * grid.rows)
    expect(request.terrain.elevations_m).toEqual([...grid.elevationsM])
  })

  it('carries an inline grid through unchanged', () => {
    const scene: SceneBody = SceneSchema.parse({
      ...ASKERVEIN_DEMONSTRATION_SCENE,
      terrain: {
        site_id: 'somebody-elses-hill',
        columns: 3,
        rows: 3,
        cell_size_easting_m: 100,
        cell_size_northing_m: 100,
        elevations_m: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      },
    })
    const request = sceneToFieldRequest(scene)
    expect(request.terrain.site_id).toBe('somebody-elses-hill')
    expect(request.terrain.elevations_m).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('refuses an unknown site with the list of ones that exist', () => {
    // The one failure zod cannot catch: a site id is a well-formed string whether or not
    // anything answers to it. The error has to be actionable rather than a 400 about types.
    const scene: SceneBody = { ...ASKERVEIN_DEMONSTRATION_SCENE, terrain: { site_id: 'ben-nevis' } }
    expect(() => sceneToFieldRequest(scene)).toThrow(SceneResolutionError)
    try {
      sceneToFieldRequest(scene)
    } catch (error) {
      expect((error as SceneResolutionError).path).toBe('terrain.site_id')
      expect((error as SceneResolutionError).available).toContain('askervein-copernicus-glo30')
    }
  })
})

describe('scene wind conditions', () => {
  it('expands a rose into direction-and-speed cells, not directions', () => {
    // A power curve is flat above rated, so one representative speed per direction reports
    // zero wake loss for every sector averaging above it. Askervein's dominant sector has an
    // energy speed of 13.1 m/s against the V112's 12.5 m/s rated, and that version reported
    // 0.00% loss at 210 degrees.
    const conditions = sceneWindConditions(ASKERVEIN_DEMONSTRATION_SCENE)!
    expect(conditions.length).toBeGreaterThan(200)
    const bearings = new Set(conditions.map((condition) => condition.bearingDeg))
    expect(bearings.size).toBe(12)
    const at210 = conditions.filter((condition) => condition.bearingDeg === 210)
    expect(at210.length).toBeGreaterThan(10)
    // Below rated and above rated both present in the dominant sector, which is the whole
    // reason the histogram is needed.
    expect(at210.some((condition) => condition.speedMs < 12.5)).toBe(true)
    expect(at210.some((condition) => condition.speedMs > 12.5)).toBe(true)
  })

  it('closes to the year', () => {
    const conditions = sceneWindConditions(ASKERVEIN_DEMONSTRATION_SCENE)!
    const total = conditions.reduce((sum, condition) => sum + condition.frequency, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('falls back to the site rose when the scene carries none', () => {
    expect(ASKERVEIN_TESTING_SCENE.wind_rose).toBeUndefined()
    expect(sceneWindConditions(ASKERVEIN_TESTING_SCENE)).not.toBeNull()
  })

  it('returns null rather than inventing a rose for an unknown site', () => {
    // A weighted figure over somebody else's directional climate is worse than no figure: it
    // looks like an annual expectation and is an expectation for a different place.
    const scene: SceneBody = { ...ASKERVEIN_TESTING_SCENE, terrain: { site_id: 'nowhere' } }
    expect(sceneWindConditions(scene)).toBeNull()
  })
})

describe('bundled sites', () => {
  it('records the resolved ERA5 cell alongside the requested coordinate', () => {
    for (const site of BUNDLED_SITES) {
      if (!site.windRose) continue
      expect(site.roseCell).toBeDefined()
      // Open-Meteo snaps to its grid. The rose describes a cell some kilometres from the hill,
      // and saying so is the difference between a reanalysis and a measurement at the site.
      expect(site.roseCell!.resolvedLatitude).not.toBe(site.latitude)
    }
  })
})

/**
 * The step 15 scenario, pinned against the criteria it was chosen by.
 *
 * `docs/design/testing-scenario.md` records these numbers, and the study design rests on them:
 * if a physics change makes T2 easy again, this suite has to fail rather than the study
 * quietly losing the property it was built to have. That failure already happened once in the
 * other direction — the demonstration scene was trivial from step 2 to step 10, and nothing
 * caught it because every bearing looked plausible.
 */
describe('the user-testing scenario', () => {
  const model = getTurbineModel(ASKERVEIN_TESTING_SCENE.layout.turbine)!
  const request = sceneToFieldRequest(ASKERVEIN_TESTING_SCENE)
  const turbines = ASKERVEIN_TESTING_SCENE.layout.turbines!.map((turbine) => ({
    id: turbine.id,
    eastingM: turbine.easting_m,
    northingM: turbine.northing_m,
    hubHeightM: turbine.hub_height_m ?? ASKERVEIN_TESTING_SCENE.layout.hub_height_m,
    model,
  }))

  function analyse(bearingDeg: number): FarmAnalysis {
    const field = solveMassConsistentBaseFlow({
      terrain: {
        siteId: request.terrain.site_id,
        originEastingM: request.terrain.origin_easting_m,
        originNorthingM: request.terrain.origin_northing_m,
        columns: request.terrain.columns,
        rows: request.terrain.rows,
        cellSizeEastingM: request.terrain.cell_size_easting_m,
        cellSizeNorthingM: request.terrain.cell_size_northing_m,
        elevationsM: request.terrain.elevations_m,
      },
      topElevationM: request.volume.top_elevation_m,
      levels: request.volume.levels,
      bearingDegrees: bearingDeg,
      referenceSpeedMs: request.wind.speed_ms,
      referenceHeightM: request.wind.reference_height_m,
      shearExponent: request.wind.shear_exponent,
      alphaHorizontalVerticalRatio: request.alpha_horizontal_vertical_ratio,
    })
    const streamlines = buildWakeStreamlines(field, turbines)
    return analyseTerrainFarm(field, turbines, streamlines, {
      bearingDeg,
      turbulenceIntensity: request.wind.turbulence_intensity,
    })
  }

  const cases = [
    { label: 'primary', bearingDeg: TESTING_SCENE_BEARINGS_DEG.primary, worstTurbineId: 't-r4c4' },
    { label: 'alternate', bearingDeg: TESTING_SCENE_BEARINGS_DEG.alternate, worstTurbineId: 't-r4c1' },
  ] as const

  const analyses = new Map(cases.map((entry) => [entry.bearingDeg, analyse(entry.bearingDeg)]))

  it('places sixteen turbines by explicit coordinate, not by generator parameters', () => {
    // Frozen on purpose: a scene defined by rows and stagger would move if generateGridLayout
    // ever changed how it centres an array — after participants had been run on the old
    // geometry, with nothing failing.
    expect(ASKERVEIN_TESTING_SCENE.layout.turbines).toHaveLength(16)
    expect(new Set(turbines.map((turbine) => turbine.id)).size).toBe(16)
  })

  for (const entry of cases) {
    describe(`at ${entry.bearingDeg} degrees (${entry.label})`, () => {
      const analysis = analyses.get(entry.bearingDeg)!
      const worst = analysis.turbines.find((turbine) => turbine.turbineId === analysis.worstTurbineId)!

      it('C4: the worst rotor loses enough for the finding to be real', () => {
        expect(analysis.worstTurbineId).toBe(entry.worstTurbineId)
        expect(worst.wakeLossFraction).toBeGreaterThan(0.1)
      })

      it('C1: more than one plausible culprit sits upwind', () => {
        // The demonstration scene fails exactly here — one cause at effectively 1.00.
        const shares = worst.contributors.map((contributor) => contributor.share)
        expect(shares[0]).toBeLessThanOrEqual(0.7)
        expect(shares.filter((share) => share >= 0.15).length).toBeGreaterThanOrEqual(2)
      })

      it('C2: the dominant wake overlaps the rotor partially, not squarely', () => {
        const radialD = worst.contributors[0]!.radialD
        expect(radialD).toBeGreaterThanOrEqual(0.25)
        expect(radialD).toBeLessThanOrEqual(0.9)
      })

      it('C3: terrain pushes the plume off the straight-line bearing', () => {
        // The criterion a plan view cannot satisfy. This is the size of the error made by
        // drawing a straight line upwind from the affected rotor with a ruler.
        const dominant = worst.contributors[0]!
        const source = analysis.turbines.find((turbine) => turbine.turbineId === dominant.turbineId)!
        const travel = windTravelVector(entry.bearingDeg)
        const point = source.wakePath.find((entry_) => entry_.distanceM >= dominant.downwindM)
        expect(point).toBeDefined()
        const deviationM = Math.hypot(
          point!.eastingM - (source.eastingM + point!.distanceM * travel.east),
          point!.northingM - (source.northingM + point!.distanceM * travel.north),
        )
        expect(deviationM / model.rotorDiameterM).toBeGreaterThanOrEqual(0.25)
      })
    })
  }

  it('changes its answer between the two study bearings', () => {
    // T3 needs a substantive answer in this scene rather than "nothing moved", and the two
    // conditions have to differ or the second run is a memory test.
    const [primary, alternate] = cases
    expect(analyses.get(primary.bearingDeg)!.worstTurbineId).not.toBe(
      analyses.get(alternate.bearingDeg)!.worstTurbineId,
    )
  })

  it('is measurably harder than the scene the viewer opens with', () => {
    // The comparison that justifies having two scenes at all. In the 2 x 2 demonstration one
    // turbine holds effectively the whole deficit; here the largest share is well under that.
    const worst = analyses.get(TESTING_SCENE_BEARINGS_DEG.primary)!
    const worstTurbine = worst.turbines.find((turbine) => turbine.turbineId === worst.worstTurbineId)!
    expect(worstTurbine.contributors[0]!.share).toBeLessThan(0.9)
    // And the top two turbines are close enough that T1 is a discrimination, not a glance.
    const ranked = [...worst.turbines].sort((a, b) => b.wakeLossFraction - a.wakeLossFraction)
    expect(ranked[0]!.wakeLossFraction - ranked[1]!.wakeLossFraction).toBeLessThan(0.05)
  })
})
