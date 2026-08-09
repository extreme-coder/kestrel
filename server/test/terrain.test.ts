import { describe, expect, it } from 'vitest'

import {
  sampleTerrain,
  terrainFollowingSigma,
  terrainNormal,
  validateTerrainGrid,
} from '../src/lib/terrain.js'
import type { TerrainGrid } from '../src/lib/terrain.js'

const plane: TerrainGrid = {
  siteId: 'test-plane',
  originEastingM: 100,
  originNorthingM: 200,
  columns: 3,
  rows: 3,
  cellSizeEastingM: 10,
  cellSizeNorthingM: 20,
  // h = 50 + 0.2(x - 100) - 0.1(y - 200)
  elevationsM: [50, 52, 54, 48, 50, 52, 46, 48, 50],
}

describe('terrain grid validation', () => {
  it('accepts a complete finite regular grid', () => {
    expect(() => validateTerrainGrid(plane)).not.toThrow()
  })

  it('rejects malformed dimensions, spacing, and elevation buffers', () => {
    expect(() => validateTerrainGrid({ ...plane, columns: 1 })).toThrow(RangeError)
    expect(() => validateTerrainGrid({ ...plane, cellSizeNorthingM: 0 })).toThrow(RangeError)
    expect(() => validateTerrainGrid({ ...plane, elevationsM: [1, 2] })).toThrow(RangeError)
    expect(() => validateTerrainGrid({ ...plane, elevationsM: [...plane.elevationsM, NaN] })).toThrow(
      RangeError,
    )
  })
})

describe('terrain sampling', () => {
  it('reproduces a planar DEM and its exact gradient between nodes', () => {
    const sample = sampleTerrain(plane, { eastingM: 107.5, northingM: 225 })
    expect(sample.elevationM).toBeCloseTo(49, 12)
    expect(sample.east).toBeCloseTo(0.2, 12)
    expect(sample.north).toBeCloseTo(-0.1, 12)
  })

  it('samples all four outer corners, including the final cell boundary', () => {
    expect(sampleTerrain(plane, { eastingM: 100, northingM: 200 }).elevationM).toBe(50)
    expect(sampleTerrain(plane, { eastingM: 120, northingM: 200 }).elevationM).toBe(54)
    expect(sampleTerrain(plane, { eastingM: 100, northingM: 240 }).elevationM).toBe(46)
    expect(sampleTerrain(plane, { eastingM: 120, northingM: 240 }).elevationM).toBe(50)
  })

  it('rejects points outside the DEM instead of inventing a flat edge', () => {
    expect(() => sampleTerrain(plane, { eastingM: 99.999, northingM: 220 })).toThrow(RangeError)
    expect(() => sampleTerrain(plane, { eastingM: 110, northingM: 241 })).toThrow(RangeError)
  })

  it('returns a normalized outward surface normal', () => {
    const normal = terrainNormal(plane, { eastingM: 110, northingM: 220 })
    expect(Math.hypot(normal.east, normal.north, normal.up)).toBeCloseTo(1, 12)
    expect(normal.east / normal.up).toBeCloseTo(-0.2, 12)
    expect(normal.north / normal.up).toBeCloseTo(0.1, 12)
  })
})

describe('terrain-following coordinate', () => {
  it('maps local ground to zero, domain top to one, and the midpoint to one half', () => {
    const horizontal = { eastingM: 110, northingM: 220 }
    const groundM = sampleTerrain(plane, horizontal).elevationM
    const topM = 150
    expect(terrainFollowingSigma(plane, { ...horizontal, elevationM: groundM }, topM)).toBe(0)
    expect(terrainFollowingSigma(plane, { ...horizontal, elevationM: topM }, topM)).toBe(1)
    expect(
      terrainFollowingSigma(plane, { ...horizontal, elevationM: (groundM + topM) / 2 }, topM),
    ).toBeCloseTo(0.5, 12)
  })

  it('rejects an invalid domain top and samples below ground or above the top', () => {
    const horizontal = { eastingM: 110, northingM: 220 }
    const groundM = sampleTerrain(plane, horizontal).elevationM
    expect(() => terrainFollowingSigma(plane, { ...horizontal, elevationM: groundM }, groundM)).toThrow(
      RangeError,
    )
    expect(() => terrainFollowingSigma(plane, { ...horizontal, elevationM: groundM - 1 }, 150)).toThrow(
      RangeError,
    )
    expect(() => terrainFollowingSigma(plane, { ...horizontal, elevationM: 151 }, 150)).toThrow(
      RangeError,
    )
  })
})
