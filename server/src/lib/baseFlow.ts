/**
 * Mass-consistent terrain-following wind field (ADR 0001).
 *
 * The projection is finite-volume rather than a pointwise finite-difference solve.  Its
 * primary unknowns are face volume fluxes, which makes the two properties the particle
 * renderer relies on explicit: each cell conserves mass and the terrain face has zero
 * flux. Cell-centred velocity vectors are reconstructed from those conservative fluxes.
 */

import { extrapolateWindSpeed } from './power.js'
import { sampleTerrain, validateTerrainGrid } from './terrain.js'
import type { TerrainGrid } from './terrain.js'

/** Isotropic neutral default; site calibration should override this from measured flow. */
export const DEFAULT_ALPHA_HORIZONTAL_VERTICAL_RATIO = 1

export interface BaseFlowOptions {
  terrain: TerrainGrid
  /** Flat top of the model domain, in the DEM vertical datum. */
  topElevationM: number
  /** Number of finite-volume layers between terrain and the domain top. */
  levels: number
  /** Meteorological bearing: direction the wind comes from, clockwise from north. */
  bearingDegrees: number
  referenceSpeedMs?: number
  referenceHeightM?: number
  shearExponent?: number
  /** Gauss precision ratio αH/αV. Larger values make horizontal adjustment costlier. */
  alphaHorizontalVerticalRatio?: number
  tolerance?: number
  maxIterations?: number
}

export interface BaseFlowDiagnostics {
  converged: boolean
  iterations: number
  initialMaxCellImbalanceM3s: number
  maxCellImbalanceM3s: number
  maxRelativeCellImbalance: number
}

export interface BaseFlowField {
  siteId: string
  columns: number
  rows: number
  levels: number
  originEastingM: number
  originNorthingM: number
  cellSizeEastingM: number
  cellSizeNorthingM: number
  topElevationM: number
  /** Cell-centre terrain elevations, row-major. */
  groundElevationsM: Float64Array
  /** Cell-centred east, north and up components, level-major then row-major. */
  eastMs: Float64Array
  northMs: Float64Array
  upMs: Float64Array
  diagnostics: BaseFlowDiagnostics
}

interface Geometry {
  nx: number
  ny: number
  nz: number
  count: number
  dx: number
  dy: number
  ground: Float64Array
  height: Float64Array
  slopeX: Float64Array
  slopeY: Float64Array
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`)
}

function cellIndex(g: Geometry, x: number, y: number, z: number): number {
  return (z * g.ny + y) * g.nx + x
}

function horizontalIndex(g: Geometry, x: number, y: number): number {
  return y * g.nx + x
}

function makeGeometry(options: BaseFlowOptions): Geometry {
  const { terrain } = options
  validateTerrainGrid(terrain)
  finite(options.topElevationM, 'topElevationM')
  if (!Number.isInteger(options.levels) || options.levels < 1) {
    throw new RangeError(`levels must be a positive integer, got ${options.levels}`)
  }

  const nx = terrain.columns - 1
  const ny = terrain.rows - 1
  const ground = new Float64Array(nx * ny)
  const height = new Float64Array(nx * ny)
  const slopeX = new Float64Array(nx * ny)
  const slopeY = new Float64Array(nx * ny)
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const sample = sampleTerrain(terrain, {
        eastingM: terrain.originEastingM + (x + 0.5) * terrain.cellSizeEastingM,
        northingM: terrain.originNorthingM + (y + 0.5) * terrain.cellSizeNorthingM,
      })
      const h = horizontalIndex({ nx } as Geometry, x, y)
      ground[h] = sample.elevationM
      height[h] = options.topElevationM - sample.elevationM
      slopeX[h] = sample.east
      slopeY[h] = sample.north
      if (height[h]! <= 0) {
        throw new RangeError(`topElevationM must be above every terrain cell (cell ${x},${y})`)
      }
    }
  }
  return {
    nx,
    ny,
    nz: options.levels,
    count: nx * ny * options.levels,
    dx: terrain.cellSizeEastingM,
    dy: terrain.cellSizeNorthingM,
    ground,
    height,
    slopeX,
    slopeY,
  }
}

/** Solve the anisotropic projection and return a conservative terrain-following field. */
export function solveMassConsistentBaseFlow(options: BaseFlowOptions): BaseFlowField {
  const g = makeGeometry(options)
  const speed = options.referenceSpeedMs ?? 1
  const referenceHeight = options.referenceHeightM ?? 100
  const shear = options.shearExponent ?? 1 / 7
  const ratio = options.alphaHorizontalVerticalRatio ?? DEFAULT_ALPHA_HORIZONTAL_VERTICAL_RATIO
  const tolerance = options.tolerance ?? 1e-8
  const maxIterations = options.maxIterations ?? Math.max(200, g.count * 4)
  finite(speed, 'referenceSpeedMs')
  finite(referenceHeight, 'referenceHeightM')
  finite(shear, 'shearExponent')
  finite(ratio, 'alphaHorizontalVerticalRatio')
  if (speed < 0 || referenceHeight <= 0 || ratio <= 0 || tolerance <= 0 || maxIterations < 1) {
    throw new RangeError('speed must be non-negative and solver scales/limits must be positive')
  }

  // Meteorological "from" bearing converted to a mathematical downwind unit vector.
  const radians = (options.bearingDegrees * Math.PI) / 180
  finite(radians, 'bearingDegrees')
  const directionEast = -Math.sin(radians)
  const directionNorth = -Math.cos(radians)
  const kHorizontal = 1 / (ratio * ratio)
  const kVertical = 1

  // Face arrays: x has nx+1 faces, y has ny+1, sigma has nz+1.
  const fx = new Float64Array((g.nx + 1) * g.ny * g.nz)
  const fy = new Float64Array(g.nx * (g.ny + 1) * g.nz)
  const fs = new Float64Array(g.nx * g.ny * (g.nz + 1))
  const xFace = (x: number, y: number, z: number) => (z * g.ny + y) * (g.nx + 1) + x
  const yFace = (x: number, y: number, z: number) => (z * (g.ny + 1) + y) * g.nx + x
  const sFace = (x: number, y: number, z: number) => (z * g.ny + y) * g.nx + x

  const layerSpeed = (z: number, h: number): number => {
    const agl = ((z + 0.5) / g.nz) * h
    return extrapolateWindSpeed(speed, referenceHeight, Math.max(agl, 1e-6), shear)
  }
  for (let z = 0; z < g.nz; z++) {
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x <= g.nx; x++) {
        const left = horizontalIndex(g, Math.max(0, x - 1), y)
        const right = horizontalIndex(g, Math.min(g.nx - 1, x), y)
        const h = (g.height[left]! + g.height[right]!) / 2
        fx[xFace(x, y, z)] = directionEast * layerSpeed(z, h) * (g.dy * h) / g.nz
      }
    }
    for (let y = 0; y <= g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        const south = horizontalIndex(g, x, Math.max(0, y - 1))
        const north = horizontalIndex(g, x, Math.min(g.ny - 1, y))
        const h = (g.height[south]! + g.height[north]!) / 2
        fy[yFace(x, y, z)] = directionNorth * layerSpeed(z, h) * (g.dx * h) / g.nz
      }
    }
  }
  // Contravariant flux through sigma surfaces. Ground is solid; the flat top has zero.
  for (let z = 1; z < g.nz; z++) {
    const sigma = z / g.nz
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        const h = horizontalIndex(g, x, y)
        const u = directionEast * layerSpeed(Math.min(z, g.nz - 1), g.height[h]!)
        const v = directionNorth * layerSpeed(Math.min(z, g.nz - 1), g.height[h]!)
        fs[sFace(x, y, z)] = -(1 - sigma) * (u * g.slopeX[h]! + v * g.slopeY[h]!) * g.dx * g.dy
      }
    }
  }

  const divergence = (out: Float64Array): number => {
    let maximum = 0
    for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
      const value = fx[xFace(x + 1, y, z)]! - fx[xFace(x, y, z)]!
        + fy[yFace(x, y + 1, z)]! - fy[yFace(x, y, z)]!
        + fs[sFace(x, y, z + 1)]! - fs[sFace(x, y, z)]!
      out[cellIndex(g, x, y, z)] = value
      maximum = Math.max(maximum, Math.abs(value))
    }
    return maximum
  }
  const initialDivergence = new Float64Array(g.count)
  const initialMaximum = divergence(initialDivergence)

  // Matrix-free SPD pressure operator. Inflow and cross-flow boundaries retain their
  // prescribed flux; outflow pressure is pinned to zero so a compatible solution exists.
  const conductanceX = (x: number, y: number): number => {
    const left = horizontalIndex(g, Math.max(0, x - 1), y)
    const right = horizontalIndex(g, Math.min(g.nx - 1, x), y)
    const area = g.dy * (g.height[left]! + g.height[right]!) / (2 * g.nz)
    return kHorizontal * area / g.dx
  }
  const conductanceY = (x: number, y: number): number => {
    const south = horizontalIndex(g, x, Math.max(0, y - 1))
    const north = horizontalIndex(g, x, Math.min(g.ny - 1, y))
    const area = g.dx * (g.height[south]! + g.height[north]!) / (2 * g.nz)
    return kHorizontal * area / g.dy
  }
  const conductanceS = (x: number, y: number): number => {
    const h = horizontalIndex(g, x, y)
    const sx = g.slopeX[h]!
    const sy = g.slopeY[h]!
    return (g.dx * g.dy * g.nz / g.height[h]!) * (kVertical + kHorizontal * (sx * sx + sy * sy))
  }
  const apply = (p: Float64Array, out: Float64Array): void => {
    out.fill(0)
    for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
      const i = cellIndex(g, x, y, z)
      let value = 0
      const connect = (j: number, c: number) => { value += c * (p[i]! - p[j]!) }
      if (x > 0) connect(cellIndex(g, x - 1, y, z), conductanceX(x, y))
      else if (directionEast < 0) value += conductanceX(0, y) * p[i]!
      if (x + 1 < g.nx) connect(cellIndex(g, x + 1, y, z), conductanceX(x + 1, y))
      else if (directionEast > 0) value += conductanceX(g.nx, y) * p[i]!
      if (y > 0) connect(cellIndex(g, x, y - 1, z), conductanceY(x, y))
      else if (directionNorth < 0) value += conductanceY(x, 0) * p[i]!
      if (y + 1 < g.ny) connect(cellIndex(g, x, y + 1, z), conductanceY(x, y + 1))
      else if (directionNorth > 0) value += conductanceY(x, g.ny) * p[i]!
      if (z > 0) connect(cellIndex(g, x, y, z - 1), conductanceS(x, y))
      if (z + 1 < g.nz) connect(cellIndex(g, x, y, z + 1), conductanceS(x, y))
      out[i] = value
    }
  }

  const pressure = new Float64Array(g.count)
  const residual = Float64Array.from(initialDivergence, value => -value)
  const search = residual.slice()
  const applied = new Float64Array(g.count)
  let rr = residual.reduce((sum, value) => sum + value * value, 0)
  const target = Math.max(tolerance * tolerance * rr, Number.EPSILON)
  let iterations = 0
  while (rr > target && iterations < maxIterations) {
    apply(search, applied)
    const denominator = search.reduce((sum, value, i) => sum + value * applied[i]!, 0)
    if (!(denominator > 0)) break
    const step = rr / denominator
    for (let i = 0; i < g.count; i++) {
      pressure[i] = pressure[i]! + step * search[i]!
      residual[i] = residual[i]! - step * applied[i]!
    }
    const next = residual.reduce((sum, value) => sum + value * value, 0)
    const beta = next / rr
    for (let i = 0; i < g.count; i++) search[i] = residual[i]! + beta * search[i]!
    rr = next
    iterations++
  }

  // Apply -K grad(phi) to face fluxes, including pressure-zero outflow faces.
  for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) {
    for (let x = 1; x < g.nx; x++) {
      const face = xFace(x, y, z)
      fx[face] = fx[face]! + conductanceX(x, y) * (pressure[cellIndex(g, x - 1, y, z)]! - pressure[cellIndex(g, x, y, z)]!)
    }
    const west = xFace(0, y, z)
    const east = xFace(g.nx, y, z)
    if (directionEast < 0) fx[west] = fx[west]! - conductanceX(0, y) * pressure[cellIndex(g, 0, y, z)]!
    if (directionEast > 0) fx[east] = fx[east]! + conductanceX(g.nx, y) * pressure[cellIndex(g, g.nx - 1, y, z)]!
  }
  for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    for (let y = 1; y < g.ny; y++) {
      const face = yFace(x, y, z)
      fy[face] = fy[face]! + conductanceY(x, y) * (pressure[cellIndex(g, x, y - 1, z)]! - pressure[cellIndex(g, x, y, z)]!)
    }
    const south = yFace(x, 0, z)
    const north = yFace(x, g.ny, z)
    if (directionNorth < 0) fy[south] = fy[south]! - conductanceY(x, 0) * pressure[cellIndex(g, x, 0, z)]!
    if (directionNorth > 0) fy[north] = fy[north]! + conductanceY(x, g.ny) * pressure[cellIndex(g, x, g.ny - 1, z)]!
  }
  for (let z = 1; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    const face = sFace(x, y, z)
    fs[face] = fs[face]! + conductanceS(x, y) * (pressure[cellIndex(g, x, y, z - 1)]! - pressure[cellIndex(g, x, y, z)]!)
  }

  const finalDivergence = new Float64Array(g.count)
  const finalMaximum = divergence(finalDivergence)
  let fluxScale = 0
  for (const value of fx) fluxScale = Math.max(fluxScale, Math.abs(value))
  for (const value of fy) fluxScale = Math.max(fluxScale, Math.abs(value))
  for (const value of fs) fluxScale = Math.max(fluxScale, Math.abs(value))

  const east = new Float64Array(g.count)
  const north = new Float64Array(g.count)
  const up = new Float64Array(g.count)
  for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    const i = cellIndex(g, x, y, z)
    const h = horizontalIndex(g, x, y)
    const areaX = g.dy * g.height[h]! / g.nz
    const areaY = g.dx * g.height[h]! / g.nz
    east[i] = (fx[xFace(x, y, z)]! + fx[xFace(x + 1, y, z)]!) / (2 * areaX)
    north[i] = (fy[yFace(x, y, z)]! + fy[yFace(x, y + 1, z)]!) / (2 * areaY)
    const sigma = (z + 0.5) / g.nz
    const contravariant = (fs[sFace(x, y, z)]! + fs[sFace(x, y, z + 1)]!) / (2 * g.dx * g.dy)
    up[i] = contravariant + (1 - sigma) * (east[i]! * g.slopeX[h]! + north[i]! * g.slopeY[h]!)
  }

  return {
    siteId: options.terrain.siteId,
    columns: g.nx,
    rows: g.ny,
    levels: g.nz,
    originEastingM: options.terrain.originEastingM + g.dx / 2,
    originNorthingM: options.terrain.originNorthingM + g.dy / 2,
    cellSizeEastingM: g.dx,
    cellSizeNorthingM: g.dy,
    topElevationM: options.topElevationM,
    groundElevationsM: g.ground,
    eastMs: east,
    northMs: north,
    upMs: up,
    diagnostics: {
      converged: rr <= target,
      iterations,
      initialMaxCellImbalanceM3s: initialMaximum,
      maxCellImbalanceM3s: finalMaximum,
      maxRelativeCellImbalance: fluxScale === 0 ? 0 : finalMaximum / fluxScale,
    },
  }
}
