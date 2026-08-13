/**
 * Per-turbine analysis of the flow the viewer actually draws.
 *
 * `wake.ts`'s `evaluateFarm` answers the same question on a flat plane with a uniform free
 * stream. This module answers it over the terrain-responsive base flow, with wakes carried
 * along curved streamlines — the exact composition `POST /api/field` samples onto its
 * volume. That agreement is the point. A ranked loss table derived from the flat model
 * beside a picture derived from the terrain model would disagree about which turbine is
 * worst, and a user cannot tell which one is lying.
 *
 * ## What "gross" means here
 *
 * Gross power is the power a turbine would make **in this terrain flow with no other
 * turbines present**, not the power it would make in a uniform free stream. Terrain
 * speed-up therefore lands in gross, and the wake loss fraction isolates the wakes alone.
 * Two turbines at different points on the hill legitimately have different gross figures,
 * and reading that difference as a wake effect would be the obvious way to get attribution
 * wrong.
 *
 * ## What this is not
 *
 * - **Not annual energy.** One bearing, one speed, reference air density. Frequency
 *   weighting over a wind rose is step 11's job, and until it exists a loss figure here is
 *   the loss in this condition, not an expectation.
 * - **Not validated as a composition.** Terrain flow is anchored at Askervein, wakes at
 *   Horns Rev, and nothing anchors wakes over terrain — Askervein has no turbines and Horns
 *   Rev has no hill. See `provenance.ts`.
 * - **Not an upper bound on loss.** The wake model recovers about 83% of Horns Rev's
 *   measured array loss, so these figures are a floor. Anything that presents them must say
 *   so.
 */

import type { BaseFlowField } from './baseFlow.js'
import { sampleGroundElevation, sampleTerrainWakeField } from './terrainWake.js'
import type { Streamline, TerrainWakeContribution } from './terrainWake.js'
import { powerCurveOutputKw, thrustCoefficient } from './power.js'
import { DEFAULT_TURBULENCE_INTENSITY, windTravelVector } from './wake.js'
import type { FarmTurbine } from './wake.js'

/**
 * Below this loss fraction, no cause is claimed for a turbine at all (D28).
 *
 * Half a percent of a rotor's output is inside every error this model has been measured to
 * have, so naming a culprit for it attributes a number the model cannot resolve. Turbines
 * standing side by side still register deficits of order 1e-6 against each other, and the raw
 * contributor list will happily rank one of them as the dominant cause of a turbine losing
 * 0.00%.
 *
 * Exported because the same threshold has to hold wherever a *causal claim* is made — the
 * client's attribution sentence and the comparison's "the cause changed" flag — and three
 * copies of a constant is two that can quietly stop matching.
 * `client/src/features/analysis/analysis.ts` carries the browser-side copy;
 * `test/farmAnalysis.test.ts` pins them equal.
 */
export const MATERIAL_LOSS_FRACTION = 0.005

/** One upstream turbine's contribution to a rotor's deficit, with its share of the loss. */
export interface WakeContributor {
  turbineId: string
  /** Deficit this turbine alone would cause at the rotor, as a fraction of the local flow. */
  deficit: number
  /**
   * Its share of the combined deficit, in [0, 1], by the same sum-of-squares weighting the
   * superposition uses: δᵢ² / Σδⱼ². Shares over all contributors sum to 1.
   *
   * This is an attribution, not a measurement. Wakes do not combine linearly, so "how much
   * of the loss is this turbine's fault" has no unique answer; splitting by the squares is
   * the split consistent with how the deficits were combined in the first place.
   */
  share: number
  /** Share of the rotor's lost power attributed to this turbine, kW. */
  attributedLossKw: number
  /** Distance along the curved wake axis from the source rotor, metres. */
  downwindM: number
  /** Distance in source rotor diameters — the length scale wakes recover over. */
  downwindD: number
  /** Perpendicular distance from that axis to the hub, metres. */
  radialM: number
  /** Perpendicular distance in source rotor diameters. */
  radialD: number
}

/** One sample on a turbine's curved wake axis. */
export interface WakePathPoint {
  eastingM: number
  northingM: number
  /** Absolute elevation of the wake centreline. */
  elevationM: number
  /** Ground under that point, so a section can show the plume against the hill. */
  groundElevationM: number
  /** Arc length from the source rotor, metres. Kept because decimation loses it otherwise. */
  distanceM: number
}

/**
 * Points kept when a traced streamline is sent to a client.
 *
 * The tracer steps at half a cell, which over a 2 km domain is a few hundred points per
 * turbine — far more than either the drawn tube or the section inset can resolve, and enough
 * to dominate the response.
 */
const WAKE_PATH_POINTS = 48

export interface TurbineAnalysis {
  turbineId: string
  eastingM: number
  northingM: number
  /** Ground elevation under the tower, from the solver's own cell-centred terrain. */
  groundElevationM: number
  hubHeightM: number
  /** Hub-height speed in the terrain flow with no turbines present, m/s. */
  grossSpeedMs: number
  /** Hub-height speed after upstream wakes, m/s. */
  incomingSpeedMs: number
  /** Combined deficit at the rotor as a fraction of the local terrain flow, in [0, 1]. */
  deficit: number
  /** Thrust coefficient at the incoming speed — how deep a wake this turbine casts. */
  thrustCoefficient: number
  /** Power at the incoming speed, kW, at reference air density. */
  netPowerKw: number
  /** Power at the wake-free terrain speed, kW, at reference air density. */
  grossPowerKw: number
  /** Power lost to upstream wakes, kW. */
  wakeLossKw: number
  /** Lost power as a fraction of gross, in [0, 1]. Zero when gross power is zero. */
  wakeLossFraction: number
  /** Descending by deficit. Empty when the turbine is unwaked. */
  contributors: WakeContributor[]
  /** The largest single contributor, or null when unwaked. The answer T2 is scored against. */
  dominantContributorId: string | null
  /**
   * This turbine's own wake axis, downstream from its rotor.
   *
   * Sent to the client because the axis *curves*: drawing a straight line along the bearing
   * instead would contradict the field the same response describes, and the vertical section
   * that carries this finding to a screen reader would show a wake that never climbs the
   * hill.
   */
  wakePath: WakePathPoint[]
}

export interface FarmAnalysis {
  /** Ordered most-upwind first, which is also the order they were resolved in. */
  turbines: TurbineAnalysis[]
  totalNetPowerKw: number
  totalGrossPowerKw: number
  /** Farm loss as a fraction of the wake-free total, in [0, 1]. */
  wakeLossFraction: number
  totalWakeLossKw: number
  /** The turbine with the highest `wakeLossFraction`, or null for an empty farm. The answer T1 is scored against. */
  worstTurbineId: string | null
  /** Thrust coefficients keyed by turbine id, for sampling the volume with. */
  operatingCt: Map<string, number>
}

export interface FarmAnalysisOptions {
  bearingDeg: number
  turbulenceIntensity?: number
}

function shareOfDeficit(contribution: TerrainWakeContribution, sumOfSquares: number): number {
  if (!(sumOfSquares > 0)) return 0
  return (contribution.deficit * contribution.deficit) / sumOfSquares
}

/** Decimate a traced axis to a drawable polyline, always keeping both ends. */
function decimatePath(field: BaseFlowField, line: Streamline | undefined): WakePathPoint[] {
  if (!line || line.points.length === 0) return []
  const stride = Math.max(1, Math.ceil(line.points.length / WAKE_PATH_POINTS))
  const kept: WakePathPoint[] = []
  for (let i = 0; i < line.points.length; i += stride) kept.push(pathPoint(field, line, i))
  const last = line.points.length - 1
  if (last % stride !== 0) kept.push(pathPoint(field, line, last))
  return kept
}

function pathPoint(field: BaseFlowField, line: Streamline, index: number): WakePathPoint {
  const point = line.points[index]!
  return {
    eastingM: point.eastingM,
    northingM: point.northingM,
    elevationM: point.elevationM,
    groundElevationM: sampleGroundElevation(field, point.eastingM, point.northingM),
    distanceM: line.distanceM[index]!,
  }
}

/**
 * Evaluate every turbine against a solved base flow and its wake streamlines.
 *
 * Turbines are resolved **strictly upwind-first**, for the same reason `evaluateFarm` does
 * it: a turbine's thrust coefficient depends on the speed it actually sees, and its wake
 * depth depends on that coefficient. Only turbines already resolved appear in the operating
 * map, so each sample sees exactly the upstream set.
 *
 * The order comes from projection onto the free-stream travel direction rather than from
 * the curved streamlines. A mass-consistent field has no momentum equation and so cannot
 * recirculate (ADR 0001) — flow crosses the domain monotonically along the bearing — which
 * makes the straight-line projection an ordering that agrees with the streamlines while
 * staying trivially acyclic.
 */
export function analyseTerrainFarm(
  field: BaseFlowField,
  turbines: readonly FarmTurbine[],
  streamlines: ReadonlyMap<string, Streamline>,
  options: FarmAnalysisOptions,
): FarmAnalysis {
  const turbulenceIntensity = options.turbulenceIntensity ?? DEFAULT_TURBULENCE_INTENSITY
  const travel = windTravelVector(options.bearingDeg)
  const ordered = [...turbines].sort(
    (a, b) =>
      a.eastingM * travel.east +
      a.northingM * travel.north -
      (b.eastingM * travel.east + b.northingM * travel.north),
  )

  const operatingCt = new Map<string, number>()
  const results: TurbineAnalysis[] = []

  for (const turbine of ordered) {
    const groundElevationM = sampleGroundElevation(field, turbine.eastingM, turbine.northingM)
    const point = {
      eastingM: turbine.eastingM,
      northingM: turbine.northingM,
      elevationM: groundElevationM + turbine.hubHeightM,
    }
    const sample = sampleTerrainWakeField(
      field,
      point,
      ordered,
      operatingCt,
      streamlines,
      turbulenceIntensity,
    )

    const ct = thrustCoefficient(turbine.model, sample.speedMs)
    operatingCt.set(turbine.id, ct)

    const grossPowerKw = powerCurveOutputKw(turbine.model, sample.baseSpeedMs)
    const netPowerKw = powerCurveOutputKw(turbine.model, sample.speedMs)
    // Clamped because the power curve is flat above rated: a waked turbine still at rated
    // speed loses nothing, and floating-point noise must not report a negative loss.
    const wakeLossKw = Math.max(0, grossPowerKw - netPowerKw)
    const sumOfSquares = sample.contributions.reduce((sum, c) => sum + c.deficit * c.deficit, 0)

    results.push({
      turbineId: turbine.id,
      eastingM: turbine.eastingM,
      northingM: turbine.northingM,
      groundElevationM,
      hubHeightM: turbine.hubHeightM,
      grossSpeedMs: sample.baseSpeedMs,
      incomingSpeedMs: sample.speedMs,
      deficit: sample.deficit,
      thrustCoefficient: ct,
      netPowerKw,
      grossPowerKw,
      wakeLossKw,
      wakeLossFraction: grossPowerKw > 0 ? wakeLossKw / grossPowerKw : 0,
      contributors: sample.contributions.map((contribution) => {
        const share = shareOfDeficit(contribution, sumOfSquares)
        const source = ordered.find((t) => t.id === contribution.turbineId)!
        return {
          turbineId: contribution.turbineId,
          deficit: contribution.deficit,
          share,
          attributedLossKw: share * wakeLossKw,
          downwindM: contribution.downwindM,
          downwindD: contribution.downwindM / source.model.rotorDiameterM,
          radialM: contribution.radialM,
          radialD: contribution.radialM / source.model.rotorDiameterM,
        }
      }),
      dominantContributorId: sample.contributions[0]?.turbineId ?? null,
      wakePath: decimatePath(field, streamlines.get(turbine.id)),
    })
  }

  const totalNetPowerKw = results.reduce((sum, r) => sum + r.netPowerKw, 0)
  const totalGrossPowerKw = results.reduce((sum, r) => sum + r.grossPowerKw, 0)
  const worst = results.reduce<TurbineAnalysis | null>(
    (best, current) => (best === null || current.wakeLossFraction > best.wakeLossFraction ? current : best),
    null,
  )

  return {
    turbines: results,
    totalNetPowerKw,
    totalGrossPowerKw,
    totalWakeLossKw: Math.max(0, totalGrossPowerKw - totalNetPowerKw),
    wakeLossFraction: totalGrossPowerKw > 0 ? 1 - totalNetPowerKw / totalGrossPowerKw : 0,
    worstTurbineId: worst?.turbineId ?? null,
    operatingCt,
  }
}
