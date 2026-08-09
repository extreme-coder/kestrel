/**
 * Regular-grid terrain geometry for the mass-consistent base-flow solver (ADR 0001).
 *
 * The grid lives in the same local metric frame as farm layouts and wake samples. DEM
 * acquisition and reprojection belong at the boundary; this module deliberately only
 * handles metres so the numerical solver has no geospatial-library dependency.
 */

export interface TerrainGrid {
  /** Stable site/cache identifier, for example `askervein-hill`. */
  siteId: string
  /** Location of the south-west grid node in the local metric frame. */
  originEastingM: number
  originNorthingM: number
  /** Number of grid nodes along each horizontal axis. Both must be at least two. */
  columns: number
  rows: number
  /** Uniform node spacing. */
  cellSizeEastingM: number
  cellSizeNorthingM: number
  /** Row-major elevations in metres above the DEM's vertical datum. */
  elevationsM: readonly number[]
}

export interface TerrainPoint {
  eastingM: number
  northingM: number
}

export interface TerrainGradient {
  /** dh/dx, metres of rise per metre east. */
  east: number
  /** dh/dy, metres of rise per metre north. */
  north: number
}

export interface TerrainSample extends TerrainGradient {
  elevationM: number
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`)
}

/** Validate a DEM once at ingestion rather than rediscovering malformed data in a solve. */
export function validateTerrainGrid(grid: TerrainGrid): void {
  if (grid.siteId.length === 0) throw new RangeError('siteId must not be empty')
  if (!Number.isInteger(grid.columns) || grid.columns < 2) {
    throw new RangeError(`columns must be an integer of at least 2, got ${grid.columns}`)
  }
  if (!Number.isInteger(grid.rows) || grid.rows < 2) {
    throw new RangeError(`rows must be an integer of at least 2, got ${grid.rows}`)
  }
  requireFinite(grid.originEastingM, 'originEastingM')
  requireFinite(grid.originNorthingM, 'originNorthingM')
  requireFinite(grid.cellSizeEastingM, 'cellSizeEastingM')
  requireFinite(grid.cellSizeNorthingM, 'cellSizeNorthingM')
  if (grid.cellSizeEastingM <= 0 || grid.cellSizeNorthingM <= 0) {
    throw new RangeError('cell sizes must be positive')
  }
  if (grid.elevationsM.length !== grid.columns * grid.rows) {
    throw new RangeError(
      `elevationsM must contain ${grid.columns * grid.rows} values, got ${grid.elevationsM.length}`,
    )
  }
  for (const elevation of grid.elevationsM) requireFinite(elevation, 'elevation')
}

function node(grid: TerrainGrid, column: number, row: number): number {
  return grid.elevationsM[row * grid.columns + column]!
}

/**
 * Bilinearly sample terrain height and its analytic in-cell gradient.
 *
 * The point must lie inside the DEM. Silent clamping would turn a missing DEM margin into
 * a flat vertical skirt, which the particle field could misleadingly render as physics.
 */
export function sampleTerrain(grid: TerrainGrid, point: TerrainPoint): TerrainSample {
  validateTerrainGrid(grid)
  requireFinite(point.eastingM, 'eastingM')
  requireFinite(point.northingM, 'northingM')

  const x = (point.eastingM - grid.originEastingM) / grid.cellSizeEastingM
  const y = (point.northingM - grid.originNorthingM) / grid.cellSizeNorthingM
  const maxX = grid.columns - 1
  const maxY = grid.rows - 1
  if (x < 0 || x > maxX || y < 0 || y > maxY) {
    throw new RangeError(`point (${point.eastingM}, ${point.northingM}) lies outside terrain grid`)
  }

  // At the north/east boundary, use the final cell with a fractional coordinate of one.
  const column = Math.min(Math.floor(x), grid.columns - 2)
  const row = Math.min(Math.floor(y), grid.rows - 2)
  const tx = x - column
  const ty = y - row
  const h00 = node(grid, column, row)
  const h10 = node(grid, column + 1, row)
  const h01 = node(grid, column, row + 1)
  const h11 = node(grid, column + 1, row + 1)

  const south = h00 + tx * (h10 - h00)
  const north = h01 + tx * (h11 - h01)
  return {
    elevationM: south + ty * (north - south),
    east: ((1 - ty) * (h10 - h00) + ty * (h11 - h01)) / grid.cellSizeEastingM,
    north: ((1 - tx) * (h01 - h00) + tx * (h11 - h10)) / grid.cellSizeNorthingM,
  }
}

/** Unit normal to z = h(x,y), oriented out of the ground. */
export function terrainNormal(grid: TerrainGrid, point: TerrainPoint): {
  east: number
  north: number
  up: number
} {
  const gradient = sampleTerrain(grid, point)
  const length = Math.hypot(gradient.east, gradient.north, 1)
  return { east: -gradient.east / length, north: -gradient.north / length, up: 1 / length }
}

/**
 * Map an absolute elevation into the solver's terrain-following vertical coordinate.
 * Returns 0 on the ground and 1 at the flat domain top; values outside [0,1] are rejected.
 */
export function terrainFollowingSigma(
  grid: TerrainGrid,
  point: TerrainPoint & { elevationM: number },
  topElevationM: number,
): number {
  requireFinite(point.elevationM, 'elevationM')
  requireFinite(topElevationM, 'topElevationM')
  const groundM = sampleTerrain(grid, point).elevationM
  if (topElevationM <= groundM) {
    throw new RangeError(`topElevationM (${topElevationM}) must be above terrain (${groundM})`)
  }
  const sigma = (point.elevationM - groundM) / (topElevationM - groundM)
  if (sigma < 0 || sigma > 1) {
    throw new RangeError(`elevationM maps outside the terrain-following domain: sigma=${sigma}`)
  }
  return sigma
}
