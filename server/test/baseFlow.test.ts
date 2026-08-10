import { describe, expect, it } from 'vitest'

import { solveMassConsistentBaseFlow } from '../src/lib/baseFlow.js'
import type { TerrainGrid } from '../src/lib/terrain.js'

function terrain(elevationsM: number[]): TerrainGrid {
  return {
    siteId: 'synthetic',
    originEastingM: 0,
    originNorthingM: 0,
    columns: 5,
    rows: 4,
    cellSizeEastingM: 100,
    cellSizeNorthingM: 100,
    elevationsM,
  }
}

describe('mass-consistent base flow', () => {
  it('leaves a horizontally uniform flow over flat terrain unchanged', () => {
    const field = solveMassConsistentBaseFlow({
      terrain: terrain(Array(20).fill(0)),
      topElevationM: 300,
      levels: 3,
      bearingDegrees: 270,
      referenceSpeedMs: 8,
      shearExponent: 0,
    })
    expect(field.diagnostics.converged).toBe(true)
    expect(field.diagnostics.maxCellImbalanceM3s).toBeLessThan(1e-9)
    for (const value of field.eastMs) expect(value).toBeCloseTo(8, 10)
    for (const value of field.northMs) expect(value).toBeCloseTo(0, 10)
    for (const value of field.upMs) expect(value).toBeCloseTo(0, 10)
  })

  it('projects ridge-draped flow to finite-volume mass conservation', () => {
    const elevations = Array.from({ length: 4 }, (_, y) =>
      Array.from({ length: 5 }, (_, x) => 80 * Math.exp(-((x - 2) ** 2) / 1.5) + y * 2),
    ).flat()
    const field = solveMassConsistentBaseFlow({
      terrain: terrain(elevations),
      topElevationM: 400,
      levels: 5,
      bearingDegrees: 270,
      referenceSpeedMs: 10,
      shearExponent: 0.15,
      tolerance: 1e-10,
    })
    expect(field.diagnostics.converged).toBe(true)
    expect(field.diagnostics.initialMaxCellImbalanceM3s).toBeGreaterThan(1)
    expect(field.diagnostics.maxRelativeCellImbalance).toBeLessThan(1e-8)
    expect([...field.upMs].some(value => Math.abs(value) > 0.01)).toBe(true)
    for (const component of [...field.eastMs, ...field.northMs, ...field.upMs]) {
      expect(Number.isFinite(component)).toBe(true)
    }
  })

  it('is linear in reference wind speed', () => {
    const ridge = terrain(Array.from({ length: 20 }, (_, i) => (i % 5 === 2 ? 50 : 0)))
    const common = { terrain: ridge, topElevationM: 300, levels: 4, bearingDegrees: 270 }
    const unit = solveMassConsistentBaseFlow({ ...common, referenceSpeedMs: 1 })
    const scaled = solveMassConsistentBaseFlow({ ...common, referenceSpeedMs: 7 })
    for (let i = 0; i < unit.eastMs.length; i++) {
      expect(scaled.eastMs[i]).toBeCloseTo(7 * unit.eastMs[i]!, 8)
      expect(scaled.northMs[i]).toBeCloseTo(7 * unit.northMs[i]!, 8)
      expect(scaled.upMs[i]).toBeCloseTo(7 * unit.upMs[i]!, 8)
    }
  })

  it('rejects invalid domains and solver parameters', () => {
    const flat = terrain(Array(20).fill(10))
    expect(() => solveMassConsistentBaseFlow({ terrain: flat, topElevationM: 10, levels: 2, bearingDegrees: 0 })).toThrow(RangeError)
    expect(() => solveMassConsistentBaseFlow({ terrain: flat, topElevationM: 100, levels: 0, bearingDegrees: 0 })).toThrow(RangeError)
    expect(() => solveMassConsistentBaseFlow({ terrain: flat, topElevationM: 100, levels: 2, bearingDegrees: 0, alphaHorizontalVerticalRatio: 0 })).toThrow(RangeError)
  })
})
