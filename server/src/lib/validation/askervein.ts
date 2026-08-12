/**
 * External validation of the terrain-responsive base flow against Askervein Hill.
 *
 * This is the terrain half of the scientific credibility gate. The point of it is stated
 * bluntly in `docs/VALIDATION.md`: a 43% power-curve error once survived the entire unit
 * suite because every test pinned the *shape* of a curve and none pinned its *level*. The
 * base-flow solver has the same exposure — every existing test in `baseFlow.test.ts` is an
 * invariant (mass conservation, linearity, flat-flow identity) and invariants cannot fail
 * on a field that steers the right way by the wrong amount.
 *
 * ## Why this case
 *
 * Askervein is the campaign the demonstration site was chosen for (D21 / ADR 0002), so the
 * terrain that gets validated is the terrain the viewer renders. Run TU03-B, 3 October 1983,
 * is the near-neutral 210 degree reference run used by most published model comparisons.
 *
 * ## The one number that must not be tuned
 *
 * `alphaHorizontalVerticalRatio` decides whether flow prefers to go over a ridge or around
 * it, and it is a genuine free parameter. Every run here uses the documented default of 1.
 * `askerveinSensitivity` exists to show what the parameter does, not to pick a value from
 * it: 0.5 would land the hilltop speed-up almost exactly on the measurement, and adopting
 * it would be fitting the model to the same point used to report its accuracy.
 */

import { extrapolateWindSpeed } from '../power.js'
import { solveMassConsistentBaseFlow } from '../baseFlow.js'
import type { BaseFlowField } from '../baseFlow.js'
import { sampleBaseFlow, sampleGroundElevation } from '../terrainWake.js'
import { askerveinSummit, askerveinTerrainGrid } from './askerveinTerrain.js'

/**
 * Askervein 83 run TU03-B, AES vertical Gill UVW anemometers 10 m above ground along
 * Line A, and AES cup anemometers on the RS and HT masts.
 *
 * Transcribed from Zhang, X. (2009), *CFD simulation of neutral ABL flows*, Riso-R-1688(EN),
 * Tables 4 and 5, which reproduces the campaign report's tabulation. Speeds are metres per
 * second. `distanceM` is signed along the wind direction through the summit: negative
 * upwind, positive in the lee.
 */
export const TU03B = {
  runId: 'TU03-B',
  date: '1983-10-03',
  bearingDeg: 210,
  /** Near-neutral stratification; this is why the run is the usual model reference. */
  stability: 'near-neutral',
  /** Reference speed at the upwind reference site RS, 10 m above ground. */
  referenceSpeedMs: 8.6,
  referenceHeightM: 10,
  /**
   * Power-law fit to the measured RS profile, u(z) = 5.927 z^0.17 (Riso-R-1688 eq. 48).
   * Used as the solver's inflow shear so the model and the measurement share a profile.
   */
  shearExponent: 0.17,
  /** Line A at 10 m above ground. */
  lineA: [
    { distanceM: -850, speedMs: 7.8 },
    { distanceM: -500, speedMs: 6.7 },
    { distanceM: -350, speedMs: 7.2 },
    { distanceM: -200, speedMs: 10.5 },
    { distanceM: -100, speedMs: 13.2 },
    { distanceM: 0, speedMs: 16.2 },
    { distanceM: 100, speedMs: 12.0 },
    { distanceM: 200, speedMs: 5.6 },
    { distanceM: 400, speedMs: 3.0 },
  ],
  /** Paired RS and HT cup-anemometer profiles. Each row gives one speed-up at one height. */
  summitProfile: [
    { heightM: 3, referenceMs: 7.10, summitMs: 15.71 },
    { heightM: 5, referenceMs: 7.86, summitMs: 16.38 },
    { heightM: 8, referenceMs: 8.44, summitMs: 16.30 },
    { heightM: 15, referenceMs: 9.35, summitMs: 16.63 },
    { heightM: 24, referenceMs: 10.19, summitMs: 16.15 },
    { heightM: 34, referenceMs: 10.84, summitMs: 15.77 },
  ],
  source:
    'Zhang (2009), CFD simulation of neutral ABL flows, Riso-R-1688(EN), Tables 4 and 5, ' +
    'reproducing Askervein 83 run TU03-B. Campaign reference: Taylor and Teunissen (1987), ' +
    'Boundary-Layer Meteorology 39, 15-39.',
} as const

/** Fractional speed-up: local speed over the undisturbed reference at the same height. */
export function fractionalSpeedUp(localMs: number, referenceMs: number): number {
  return localMs / referenceMs - 1
}

/** Measured hilltop speed-up at a height on the RS/HT mast pair, or null if not measured. */
export function measuredSummitSpeedUp(heightM: number): number | null {
  const row = TU03B.summitProfile.find((entry) => entry.heightM === heightM)
  return row ? fractionalSpeedUp(row.summitMs, row.referenceMs) : null
}

export interface AskerveinRunOptions {
  /** Flat lid on the solve domain. The viewer's Askervein request uses 500 m. */
  topElevationM?: number
  levels?: number
  /** Gauss precision ratio. Leave at the documented default unless probing sensitivity. */
  alphaHorizontalVerticalRatio?: number
}

export interface SpeedUpComparison {
  heightM: number
  modelled: number
  measured: number
  /** Signed relative error in the speed-up, (modelled - measured) / measured. */
  relativeError: number
}

export interface LineAComparison {
  distanceM: number
  modelled: number
  measured: number
}

export interface AskerveinResult {
  topElevationM: number
  levels: number
  alphaHorizontalVerticalRatio: number
  /** The solve's summit ground height, below the DEM peak because the solve is cell-centred. */
  modelSummitElevationM: number
  demSummitElevationM: number
  converged: boolean
  /** Hilltop speed-up at every height the RS/HT mast pair measured and the grid resolves. */
  summitProfile: SpeedUpComparison[]
  /** Line A at 10 m above ground, sampled along the wind direction through the summit. */
  lineA: LineAComparison[]
  solveMs: number
}

const DEFAULTS = { topElevationM: 500, levels: 32, alphaHorizontalVerticalRatio: 1 } as const

/**
 * Solve the Askervein base flow and compare it with TU03-B.
 *
 * Heights are above the *solver's* ground, and the model's reference is its own prescribed
 * inflow profile at the same height — the same normalisation the measurement uses against
 * RS. Because the projection is linear in speed, the resulting speed-up does not depend on
 * the inflow magnitude, only on its shear exponent.
 */
export function runAskerveinCase(options: AskerveinRunOptions = {}): AskerveinResult {
  const topElevationM = options.topElevationM ?? DEFAULTS.topElevationM
  const levels = options.levels ?? DEFAULTS.levels
  const ratio = options.alphaHorizontalVerticalRatio ?? DEFAULTS.alphaHorizontalVerticalRatio

  const terrain = askerveinTerrainGrid()
  const summit = askerveinSummit()
  const started = Date.now()
  const field = solveMassConsistentBaseFlow({
    terrain,
    topElevationM,
    levels,
    bearingDegrees: TU03B.bearingDeg,
    referenceSpeedMs: TU03B.referenceSpeedMs,
    referenceHeightM: TU03B.referenceHeightM,
    shearExponent: TU03B.shearExponent,
    alphaHorizontalVerticalRatio: ratio,
  })
  const solveMs = Date.now() - started

  const radians = (TU03B.bearingDeg * Math.PI) / 180
  const travel = { east: -Math.sin(radians), north: -Math.cos(radians) }

  /** Modelled speed-up at a horizontal position and a height above the solver's ground. */
  const modelledSpeedUp = (eastingM: number, northingM: number, heightM: number): number | null => {
    let ground: number
    try {
      ground = sampleGroundElevation(field, eastingM, northingM)
    } catch {
      return null
    }
    let velocity: { east: number; north: number; up: number }
    try {
      velocity = sampleBaseFlow(field, { eastingM, northingM, elevationM: ground + heightM })
    } catch {
      // Below the lowest layer centre, or outside the domain. Reported as a gap rather
      // than silently clamped: a clamped sample would compare two different heights.
      return null
    }
    const reference = extrapolateWindSpeed(
      TU03B.referenceSpeedMs,
      TU03B.referenceHeightM,
      heightM,
      TU03B.shearExponent,
    )
    return fractionalSpeedUp(Math.hypot(velocity.east, velocity.north, velocity.up), reference)
  }

  const summitProfile: SpeedUpComparison[] = []
  for (const row of TU03B.summitProfile) {
    const modelled = modelledSpeedUp(summit.eastingM, summit.northingM, row.heightM)
    if (modelled === null) continue
    const measured = fractionalSpeedUp(row.summitMs, row.referenceMs)
    summitProfile.push({
      heightM: row.heightM,
      modelled,
      measured,
      relativeError: (modelled - measured) / measured,
    })
  }

  const lineA: LineAComparison[] = []
  for (const station of TU03B.lineA) {
    const easting = summit.eastingM + travel.east * station.distanceM
    const northing = summit.northingM + travel.north * station.distanceM
    const modelled = modelledSpeedUp(easting, northing, TU03B.referenceHeightM)
    if (modelled === null) continue
    lineA.push({
      distanceM: station.distanceM,
      modelled,
      measured: fractionalSpeedUp(station.speedMs, TU03B.referenceSpeedMs),
    })
  }

  return {
    topElevationM,
    levels,
    alphaHorizontalVerticalRatio: ratio,
    modelSummitElevationM: summitGround(field, summit.eastingM, summit.northingM),
    demSummitElevationM: summit.elevationM,
    converged: field.diagnostics.converged,
    summitProfile,
    lineA,
    solveMs,
  }
}

function summitGround(field: BaseFlowField, eastingM: number, northingM: number): number {
  return sampleGroundElevation(field, eastingM, northingM)
}

/**
 * Hilltop speed-up as a function of the one free parameter, for the report's sensitivity
 * table. Deliberately not used to choose a value — see this module's header.
 */
export function askerveinSensitivity(
  ratios: readonly number[],
  heightM: number,
  options: AskerveinRunOptions = {},
): { ratio: number; modelled: number | null }[] {
  return ratios.map((ratio) => {
    const result = runAskerveinCase({ ...options, alphaHorizontalVerticalRatio: ratio })
    const row = result.summitProfile.find((entry) => entry.heightM === heightM)
    return { ratio, modelled: row?.modelled ?? null }
  })
}
