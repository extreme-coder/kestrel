/**
 * Scenes: the unit of work a user can save, hand over and load back.
 *
 * Until step 11 the only farm Kestrel could describe was the one compiled into the client.
 * That is a demonstration, not an instrument: nobody can ask it about their own site, and
 * nothing about the answer can be reproduced by someone who was not there when it was run.
 * A scene is the whole input — which ground, which turbines where, which wind, which
 * directional climate — in one versioned file.
 *
 * The format deliberately refers to terrain by `site_id` instead of carrying elevations,
 * except when a scene brings its own hill. See `sites.ts` for why.
 *
 * A scene is *not* a new request shape for the physics. `sceneToFieldRequest` lowers it onto
 * the same `FieldRequestBody` that `/api/field` and `/api/analysis` already share, so a scene
 * cannot describe a farm those two endpoints would disagree about (D27).
 */

import { SCENE_FORMAT_VERSION } from '../schemas.js'
import type { FieldRequestBody, SceneBody } from '../schemas.js'
import { ASKERVEIN_WIND_ROSE } from './askerveinRose.js'
import { bundledSiteIds, getBundledSite } from './sites.js'

/** A scene that named terrain nobody has. Carries the list, so the message is actionable. */
export class SceneResolutionError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly available?: string[],
  ) {
    super(message)
    this.name = 'SceneResolutionError'
  }
}

/**
 * Lower a validated scene onto the field-request body every physics path already takes.
 *
 * Throws `SceneResolutionError` when a scene refers to terrain that does not exist, which is
 * the one failure zod cannot catch: `site_id` is a well-formed string whether or not anything
 * answers to it.
 */
export function sceneToFieldRequest(scene: SceneBody): FieldRequestBody {
  const terrain = scene.terrain
  if (!('elevations_m' in terrain)) {
    const site = getBundledSite(terrain.site_id)
    if (!site) {
      throw new SceneResolutionError(
        `no bundled site with id "${terrain.site_id}". Name one of the bundled sites, or ` +
        'include the grid inline with columns, rows, cell sizes and elevations_m.',
        'terrain.site_id',
        bundledSiteIds(),
      )
    }
    const grid = site.grid()
    return {
      terrain: {
        site_id: grid.siteId,
        origin_easting_m: grid.originEastingM,
        origin_northing_m: grid.originNorthingM,
        columns: grid.columns,
        rows: grid.rows,
        cell_size_easting_m: grid.cellSizeEastingM,
        cell_size_northing_m: grid.cellSizeNorthingM,
        elevations_m: [...grid.elevationsM],
      },
      layout: scene.layout,
      wind: scene.wind,
      volume: scene.volume,
      alpha_horizontal_vertical_ratio: scene.alpha_horizontal_vertical_ratio,
    }
  }

  return {
    terrain: {
      site_id: terrain.site_id,
      origin_easting_m: terrain.origin_easting_m,
      origin_northing_m: terrain.origin_northing_m,
      columns: terrain.columns,
      rows: terrain.rows,
      cell_size_easting_m: terrain.cell_size_easting_m,
      cell_size_northing_m: terrain.cell_size_northing_m,
      elevations_m: terrain.elevations_m,
    },
    layout: scene.layout,
    wind: scene.wind,
    volume: scene.volume,
    alpha_horizontal_vertical_ratio: scene.alpha_horizontal_vertical_ratio,
  }
}

/** One (direction, speed) cell of a rose, with its share of the year's hours. */
export interface SceneWindCondition {
  bearingDeg: number
  speedMs: number
  frequency: number
}

/**
 * The conditions a scene should be weighted over: its own rose if it carries one, else its
 * site's.
 *
 * Returns `null` rather than substituting a default. A frequency-weighted figure computed
 * over somebody else's directional climate is worse than no figure at all — it looks like an
 * annual expectation and is an expectation for a different place.
 *
 * Cells are (direction, speed) pairs and not directions, because a power curve is flat above
 * rated: one representative speed per direction reports zero wake loss for every sector that
 * averages above it. See `annualAnalysis.ts`.
 */
export function sceneWindConditions(scene: SceneBody): SceneWindCondition[] | null {
  if (scene.wind_rose) {
    return scene.wind_rose.sectors.flatMap((sector) =>
      sector.speed_bins.map((bin) => ({
        bearingDeg: sector.centre_deg,
        speedMs: bin.energy_speed_ms,
        frequency: bin.frequency,
      })),
    )
  }
  const site = 'elevations_m' in scene.terrain ? undefined : getBundledSite(scene.terrain.site_id)
  if (!site?.windRose) return null
  return site.windRose.sectors.flatMap((sector) =>
    sector.speedBins.map((bin) => ({
      bearingDeg: sector.centreDeg,
      speedMs: bin.energySpeedMs,
      frequency: bin.frequency,
    })),
  )
}

/** Distinct direction sectors a scene can be weighted over, for a summary count. */
export function sceneWindSectorCount(scene: SceneBody): number {
  if (scene.wind_rose) return scene.wind_rose.sectors.length
  const site = 'elevations_m' in scene.terrain ? undefined : getBundledSite(scene.terrain.site_id)
  return site?.windRose?.sectors.length ?? 0
}

/**
 * The scene the viewer opens with: the 2 x 2 array from step 10, unchanged.
 *
 * Byte-identical in effect to what `client/src/features/site/askervein.ts` used to build by
 * hand — `test/scenes.test.ts` pins the geometry so the recorded bearing in
 * `docs/design/alternate-bearing.md` keeps describing the farm on screen.
 *
 * Its job is to show what the instrument does, clearly. That is also its limit: one turbine
 * accounts for effectively all of the affected rotor's deficit at every bearing in the common
 * sector, which makes it useless as a test scenario. See `ASKERVEIN_TESTING_SCENE`.
 */
export const ASKERVEIN_DEMONSTRATION_SCENE: SceneBody = {
  kestrel_scene: SCENE_FORMAT_VERSION,
  id: 'askervein-demonstration',
  name: 'Askervein Hill — demonstration array',
  description:
    'Four V112 turbines on a 2 x 2 grid over the measured Askervein DEM, at the campaign ' +
    'bearing of 210 degrees. The scene the viewer opens with.',
  terrain: { site_id: 'askervein-copernicus-glo30' },
  layout: {
    turbine: 'vestas-v112-3450',
    rows: 2,
    columns: 2,
    crosswind_spacing_d: 6,
    downwind_spacing_d: 8,
    hub_height_m: 100,
    orientation_bearing_deg: 210,
    stagger_fraction: 0,
    origin_easting_m: 1000,
    origin_northing_m: 1000,
  },
  wind: {
    bearing_deg: 210,
    speed_ms: 10,
    reference_height_m: 100,
    shear_exponent: 1 / 7,
    turbulence_intensity: 0.08,
  },
  volume: { levels: 8, top_elevation_m: 500 },
  alpha_horizontal_vertical_ratio: 1,
  wind_rose: {
    source: 'ERA5 via Open-Meteo, 2015-2019, 100 m level. See server/src/lib/askerveinRose.ts.',
    start_date: ASKERVEIN_WIND_ROSE.startDate,
    end_date: ASKERVEIN_WIND_ROSE.endDate,
    hours: ASKERVEIN_WIND_ROSE.hours,
    sectors: ASKERVEIN_WIND_ROSE.sectors.map((sector) => ({
      centre_deg: sector.centreDeg,
      frequency: sector.frequency,
      energy_speed_ms: sector.energySpeedMs,
      energy_share: sector.energyShare,
      speed_bins: sector.speedBins.map((bin) => ({
        from_ms: bin.fromMs,
        to_ms: bin.toMs,
        energy_speed_ms: bin.energySpeedMs,
        frequency: bin.frequency,
      })),
    })),
  },
  provenance: {
    terrain: 'Measured. Copernicus DEM GLO-30, validated against the Askervein 1982-83 campaign.',
    layout: 'Invented. No wind farm exists at Askervein; these four turbines are a demonstration.',
    wind: 'Single condition, not a measurement at the site. The rose is ERA5 reanalysis.',
    notes: [
      'Wakes over terrain — the composition drawn here — has no external anchor.',
      'Modelled wake losses are a floor, not an upper limit.',
    ],
  },
}

/**
 * The scene the step 15 user study runs on. Not the one the viewer opens with.
 *
 * `docs/design/testing-scenario.md` has the derivation; the short version is that the
 * demonstration scene cannot test `RATIONALE.md`'s H1. In a 2 x 2 array one turbine causes
 * effectively all of the affected rotor's deficit from 8 D straight upwind, so T2 is
 * answerable from a plan view — which puts the 2D control at ceiling and makes the hypothesis
 * untestable rather than unsupported.
 *
 * Chosen by `npm run choose:test-scene --workspace server`, which searched 768 layouts across
 * the common sector against four computed criteria: two material causes rather than one, a
 * wake axis passing off-centre rather than through the hub, a plume displaced off the
 * straight-line bearing by terrain, and a loss large enough to be a finding. It is the only
 * geometry found that satisfies all four at **two** bearings far enough apart to serve as two
 * study conditions.
 *
 * **Coordinates are frozen, not generated.** A scene expressed as rows, columns and stagger
 * would move if `generateGridLayout` ever changed how it centres an array — after
 * participants had been run on the old geometry, with no test failing.
 */
export const ASKERVEIN_TESTING_SCENE: SceneBody = {
  kestrel_scene: SCENE_FORMAT_VERSION,
  id: 'askervein-testing',
  name: 'Askervein Hill — user testing array',
  description:
    'Sixteen V80 turbines over the measured Askervein DEM, sited so that more than one ' +
    'plausible culprit lies upwind of the worst rotor, wakes overlap partially rather than ' +
    'squarely, and the terrain pushes the plume off the straight-line bearing. Built for the ' +
    'step 15 study, not for demonstration.',
  terrain: { site_id: 'askervein-copernicus-glo30' },
  layout: {
    turbine: 'vestas-v80-2000',
    hub_height_m: 80,
    // The array's design bearing: the centre of the site's measured common sector. Both study
    // bearings are read against this fixed geometry, which is the whole point of D26.
    orientation_bearing_deg: 240,
    crosswind_spacing_d: 3.5,
    downwind_spacing_d: 5,
    stagger_fraction: 0,
    origin_easting_m: 1100,
    origin_northing_m: 900,
    turbines: [
      { id: 't-r1c1', easting_m: 790.4, northing_m: 236.3 },
      { id: 't-r1c2', easting_m: 650.4, northing_m: 478.8 },
      { id: 't-r1c3', easting_m: 510.4, northing_m: 721.2 },
      { id: 't-r1c4', easting_m: 370.4, northing_m: 963.7 },
      { id: 't-r2c1', easting_m: 1136.8, northing_m: 436.3 },
      { id: 't-r2c2', easting_m: 996.8, northing_m: 678.8 },
      { id: 't-r2c3', easting_m: 856.8, northing_m: 921.2 },
      { id: 't-r2c4', easting_m: 716.8, northing_m: 1163.7 },
      { id: 't-r3c1', easting_m: 1483.2, northing_m: 636.3 },
      { id: 't-r3c2', easting_m: 1343.2, northing_m: 878.8 },
      { id: 't-r3c3', easting_m: 1203.2, northing_m: 1121.2 },
      { id: 't-r3c4', easting_m: 1063.2, northing_m: 1363.7 },
      { id: 't-r4c1', easting_m: 1829.6, northing_m: 836.3 },
      { id: 't-r4c2', easting_m: 1689.6, northing_m: 1078.8 },
      { id: 't-r4c3', easting_m: 1549.6, northing_m: 1321.2 },
      { id: 't-r4c4', easting_m: 1409.6, northing_m: 1563.7 },
    ],
  },
  // The primary study bearing. The alternate is 285, and `test/scenes.test.ts` pins the
  // criteria at both — if a physics change makes either trivial, that fails rather than
  // quietly invalidating the study design.
  wind: {
    bearing_deg: 230,
    speed_ms: 10,
    reference_height_m: 100,
    shear_exponent: 1 / 7,
    turbulence_intensity: 0.08,
  },
  volume: { levels: 8, top_elevation_m: 500 },
  alpha_horizontal_vertical_ratio: 1,
  provenance: {
    terrain: 'Measured. Copernicus DEM GLO-30, validated against the Askervein 1982-83 campaign.',
    layout:
      'Invented, and deliberately so. Sited by search against the criteria in ' +
      'docs/design/testing-scenario.md, not by any siting process a developer would use.',
    wind: 'Two study bearings, 230 and 285 degrees, both inside the site\'s measured common sector.',
    notes: [
      'Built to make the primary task hard enough to discriminate between conditions.',
      'Wakes over terrain — the composition drawn here — has no external anchor.',
    ],
  },
}

/** The two bearings the step 15 study runs, counterbalanced within subject. */
export const TESTING_SCENE_BEARINGS_DEG = { primary: 230, alternate: 285 } as const

export const BUNDLED_SCENES: readonly SceneBody[] = [
  ASKERVEIN_DEMONSTRATION_SCENE,
  ASKERVEIN_TESTING_SCENE,
]

export function getBundledScene(id: string): SceneBody | undefined {
  return BUNDLED_SCENES.find((scene) => scene.id === id)
}

export function bundledSceneIds(): string[] {
  return BUNDLED_SCENES.map((scene) => scene.id)
}
