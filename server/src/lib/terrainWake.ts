/**
 * Compose Gaussian turbine wakes with a terrain-responsive base flow.
 *
 * `wake.ts` deliberately remains the flat-terrain analytical model. This module is the
 * sampler seam: it follows the solved velocity field, uses those streamlines as curved
 * wake axes, and applies the existing Gaussian/Katic deficit functions to the local
 * base-flow vector.
 */

import type { BaseFlowField } from './baseFlow.js'
import {
  DEFAULT_TURBULENCE_INTENSITY,
  combineDeficits,
  singleWakeDeficit,
  wakeGrowthRate,
} from './wake.js'
import type { FarmTurbine, WakeContribution } from './wake.js'

export interface FlowPoint {
  eastingM: number
  northingM: number
  /** Absolute elevation in the base field's vertical datum. */
  elevationM: number
}

export interface FlowVector {
  east: number
  north: number
  up: number
}

export interface StreamlineOptions {
  /** Spatial RK4 step. Defaults to half the smallest horizontal cell size. */
  stepM?: number
  /** Maximum traced distance. Defaults to the horizontal domain diagonal. */
  maxDistanceM?: number
  /** Stop where the base-flow speed falls below this value. */
  minimumSpeedMs?: number
}

export interface Streamline {
  turbineId: string
  points: FlowPoint[]
  /** Cumulative arc length corresponding to `points`. */
  distanceM: number[]
}

/**
 * One upstream turbine's share of the deficit, with the geometry that produced it.
 *
 * The distances are carried because attribution has to be checkable against the scene: "it
 * is 6.2 rotor diameters upwind and its plume passes 14 m from the hub" is a statement a
 * user can verify by looking, and a bare deficit fraction is not.
 */
export interface TerrainWakeContribution extends WakeContribution {
  /** Distance along the curved wake axis from the source rotor, metres. */
  downwindM: number
  /** Perpendicular distance from that axis, metres. */
  radialM: number
}

export interface TerrainWakeSample {
  speedMs: number
  baseSpeedMs: number
  deficit: number
  velocity: FlowVector
  contributions: TerrainWakeContribution[]
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`)
}

function horizontalIndex(field: BaseFlowField, x: number, y: number): number {
  return y * field.columns + x
}

function fieldIndex(field: BaseFlowField, x: number, y: number, z: number): number {
  return (z * field.rows + y) * field.columns + x
}

function axisCoordinate(value: number, origin: number, spacing: number, count: number): number {
  const coordinate = (value - origin) / spacing
  if (coordinate < 0 || coordinate > count - 1) return Number.NaN
  return coordinate
}

function interpolationPair(coordinate: number, count: number): [number, number, number] {
  if (count === 1) return [0, 0, 0]
  const low = Math.min(Math.floor(coordinate), count - 2)
  return [low, low + 1, coordinate - low]
}

function groundElevation(field: BaseFlowField, eastingM: number, northingM: number): number | null {
  const gx = axisCoordinate(eastingM, field.originEastingM, field.cellSizeEastingM, field.columns)
  const gy = axisCoordinate(northingM, field.originNorthingM, field.cellSizeNorthingM, field.rows)
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null
  const [x0, x1, tx] = interpolationPair(gx, field.columns)
  const [y0, y1, ty] = interpolationPair(gy, field.rows)
  const south = field.groundElevationsM[horizontalIndex(field, x0, y0)]! * (1 - tx)
    + field.groundElevationsM[horizontalIndex(field, x1, y0)]! * tx
  const north = field.groundElevationsM[horizontalIndex(field, x0, y1)]! * (1 - tx)
    + field.groundElevationsM[horizontalIndex(field, x1, y1)]! * tx
  return south * (1 - ty) + north * ty
}

function sampleOrNull(field: BaseFlowField, point: FlowPoint): FlowVector | null {
  const gx = axisCoordinate(point.eastingM, field.originEastingM, field.cellSizeEastingM, field.columns)
  const gy = axisCoordinate(point.northingM, field.originNorthingM, field.cellSizeNorthingM, field.rows)
  const ground = groundElevation(field, point.eastingM, point.northingM)
  if (!Number.isFinite(gx) || !Number.isFinite(gy) || ground === null) return null

  // Solver values sit at terrain-following layer centres, not at the ground/top faces.
  const sigma = (point.elevationM - ground) / (field.topElevationM - ground)
  const rawGz = sigma * field.levels - 0.5
  // A cell centre reconstructed as `ground + fraction * (top - ground)` can land a few
  // ulps beyond the last layer when real DEM elevations are decimal values. Keep actual
  // ground/top faces out, but snap mathematically valid layer centres to the domain.
  const tolerance = 1e-9
  if (rawGz < -tolerance || rawGz > field.levels - 1 + tolerance) return null
  const gz = Math.max(0, Math.min(field.levels - 1, rawGz))
  const [x0, x1, tx] = interpolationPair(gx, field.columns)
  const [y0, y1, ty] = interpolationPair(gy, field.rows)
  const [z0, z1, tz] = interpolationPair(gz, field.levels)

  const component = (values: Float64Array): number => {
    const layer = (z: number): number => {
      const south = values[fieldIndex(field, x0, y0, z)]! * (1 - tx)
        + values[fieldIndex(field, x1, y0, z)]! * tx
      const north = values[fieldIndex(field, x0, y1, z)]! * (1 - tx)
        + values[fieldIndex(field, x1, y1, z)]! * tx
      return south * (1 - ty) + north * ty
    }
    return layer(z0) * (1 - tz) + layer(z1) * tz
  }
  return { east: component(field.eastMs), north: component(field.northMs), up: component(field.upMs) }
}

/**
 * The solver's own ground elevation under a horizontal position.
 *
 * Consumers that want a height *above ground* need this, and they must not substitute the
 * DEM's node elevations: the solve runs on cell centres, so its summit sits a few metres
 * below the DEM's peak node. Mixing the two silently shifts the sampled height, which is
 * exactly the error that makes a hilltop speed-up comparison meaningless.
 */
export function sampleGroundElevation(field: BaseFlowField, eastingM: number, northingM: number): number {
  finite(eastingM, 'eastingM')
  finite(northingM, 'northingM')
  const ground = groundElevation(field, eastingM, northingM)
  if (ground === null) throw new RangeError('point lies outside the cell-centred base-flow domain')
  return ground
}

/** Trilinearly sample a cell-centred terrain-following base-flow field. */
export function sampleBaseFlow(field: BaseFlowField, point: FlowPoint): FlowVector {
  finite(point.eastingM, 'eastingM')
  finite(point.northingM, 'northingM')
  finite(point.elevationM, 'elevationM')
  const velocity = sampleOrNull(field, point)
  if (!velocity) throw new RangeError('point lies outside the cell-centred base-flow domain')
  return velocity
}

function direction(field: BaseFlowField, point: FlowPoint, minimumSpeedMs: number): FlowVector | null {
  const velocity = sampleOrNull(field, point)
  if (!velocity) return null
  const speed = Math.hypot(velocity.east, velocity.north, velocity.up)
  if (speed < minimumSpeedMs) return null
  return { east: velocity.east / speed, north: velocity.north / speed, up: velocity.up / speed }
}

function offset(point: FlowPoint, vector: FlowVector, scale: number): FlowPoint {
  return {
    eastingM: point.eastingM + vector.east * scale,
    northingM: point.northingM + vector.north * scale,
    elevationM: point.elevationM + vector.up * scale,
  }
}

/** Integrate a downstream streamline with a fourth-order Runge-Kutta spatial step. */
export function integrateStreamline(
  field: BaseFlowField,
  seed: FlowPoint,
  options: StreamlineOptions = {},
): FlowPoint[] {
  const step = options.stepM ?? Math.min(field.cellSizeEastingM, field.cellSizeNorthingM) / 2
  const width = field.cellSizeEastingM * Math.max(0, field.columns - 1)
  const depth = field.cellSizeNorthingM * Math.max(0, field.rows - 1)
  const maxDistance = options.maxDistanceM ?? Math.hypot(width, depth)
  const minimumSpeed = options.minimumSpeedMs ?? 1e-6
  finite(step, 'stepM')
  finite(maxDistance, 'maxDistanceM')
  finite(minimumSpeed, 'minimumSpeedMs')
  if (step <= 0 || maxDistance < 0 || minimumSpeed < 0) {
    throw new RangeError('streamline step must be positive and limits must be non-negative')
  }
  if (!sampleOrNull(field, seed)) throw new RangeError('streamline seed lies outside the base-flow domain')

  const points: FlowPoint[] = [{ ...seed }]
  let current = seed
  for (let travelled = 0; travelled + step <= maxDistance + 1e-9; travelled += step) {
    const k1 = direction(field, current, minimumSpeed)
    if (!k1) break
    const k2 = direction(field, offset(current, k1, step / 2), minimumSpeed)
    if (!k2) break
    const k3 = direction(field, offset(current, k2, step / 2), minimumSpeed)
    if (!k3) break
    const k4 = direction(field, offset(current, k3, step), minimumSpeed)
    if (!k4) break
    const average = {
      east: (k1.east + 2 * k2.east + 2 * k3.east + k4.east) / 6,
      north: (k1.north + 2 * k2.north + 2 * k3.north + k4.north) / 6,
      up: (k1.up + 2 * k2.up + 2 * k3.up + k4.up) / 6,
    }
    const next = offset(current, average, step)
    if (!sampleOrNull(field, next)) break
    points.push(next)
    current = next
  }
  return points
}

/** Trace and cache one curved wake axis per turbine for repeated volume sampling. */
export function buildWakeStreamlines(
  field: BaseFlowField,
  turbines: readonly FarmTurbine[],
  options: StreamlineOptions = {},
): Map<string, Streamline> {
  const result = new Map<string, Streamline>()
  for (const turbine of turbines) {
    const ground = groundElevation(field, turbine.eastingM, turbine.northingM)
    if (ground === null) throw new RangeError(`turbine ${turbine.id} lies outside the base-flow domain`)
    const points = integrateStreamline(field, {
      eastingM: turbine.eastingM,
      northingM: turbine.northingM,
      elevationM: ground + turbine.hubHeightM,
    }, options)
    const distanceM = [0]
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      distanceM.push(distanceM[i - 1]! + Math.hypot(
        b.eastingM - a.eastingM,
        b.northingM - a.northingM,
        b.elevationM - a.elevationM,
      ))
    }
    result.set(turbine.id, { turbineId: turbine.id, points, distanceM })
  }
  return result
}

function closestAxisPoint(point: FlowPoint, line: Streamline): { downwindM: number; radialM: number } | null {
  let best: { downwindM: number; radialM: number } | null = null
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1]!
    const b = line.points[i]!
    const dx = b.eastingM - a.eastingM
    const dy = b.northingM - a.northingM
    const dz = b.elevationM - a.elevationM
    const lengthSquared = dx * dx + dy * dy + dz * dz
    if (lengthSquared === 0) continue
    const t = Math.min(1, Math.max(0, (
      (point.eastingM - a.eastingM) * dx
      + (point.northingM - a.northingM) * dy
      + (point.elevationM - a.elevationM) * dz
    ) / lengthSquared))
    const radialM = Math.hypot(
      point.eastingM - (a.eastingM + t * dx),
      point.northingM - (a.northingM + t * dy),
      point.elevationM - (a.elevationM + t * dz),
    )
    const downwindM = line.distanceM[i - 1]! + t * Math.sqrt(lengthSquared)
    if (!best || radialM < best.radialM) best = { downwindM, radialM }
  }
  return best
}

/** Apply curved-axis turbine wakes to the local terrain-responsive velocity vector. */
export function sampleTerrainWakeField(
  field: BaseFlowField,
  point: FlowPoint,
  turbines: readonly FarmTurbine[],
  operatingCt: ReadonlyMap<string, number>,
  streamlines: ReadonlyMap<string, Streamline>,
  turbulenceIntensity = DEFAULT_TURBULENCE_INTENSITY,
): TerrainWakeSample {
  const base = sampleBaseFlow(field, point)
  const baseSpeedMs = Math.hypot(base.east, base.north, base.up)
  const growthRate = wakeGrowthRate(turbulenceIntensity)
  const contributions: TerrainWakeContribution[] = []
  for (const turbine of turbines) {
    const ct = operatingCt.get(turbine.id) ?? 0
    const line = streamlines.get(turbine.id)
    if (ct <= 0 || !line) continue
    const relative = closestAxisPoint(point, line)
    if (!relative || relative.downwindM <= 0) continue
    const deficit = singleWakeDeficit(
      relative.downwindM,
      relative.radialM,
      turbine.model.rotorDiameterM,
      ct,
      growthRate,
    )
    if (deficit > 0) {
      contributions.push({
        turbineId: turbine.id,
        deficit,
        downwindM: relative.downwindM,
        radialM: relative.radialM,
      })
    }
  }
  contributions.sort((a, b) => b.deficit - a.deficit)
  const deficit = combineDeficits(contributions.map(contribution => contribution.deficit))
  const scale = 1 - deficit
  return {
    speedMs: baseSpeedMs * scale,
    baseSpeedMs,
    deficit,
    velocity: { east: base.east * scale, north: base.north * scale, up: base.up * scale },
    contributions,
  }
}
