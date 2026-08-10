import { describe, expect, it } from 'vitest'

import type { BaseFlowField } from '../src/lib/baseFlow.js'
import {
  buildWakeStreamlines,
  integrateStreamline,
  sampleBaseFlow,
  sampleTerrainWakeField,
} from '../src/lib/terrainWake.js'
import type { FarmTurbine } from '../src/lib/wake.js'
import { getTurbineModel } from '../src/lib/turbines.js'

function uniformField(east: number, north = 0, up = 0): BaseFlowField {
  const count = 4 * 3 * 3
  return {
    siteId: 'synthetic', columns: 4, rows: 3, levels: 3,
    originEastingM: 0, originNorthingM: 0,
    cellSizeEastingM: 100, cellSizeNorthingM: 100, topElevationM: 300,
    groundElevationsM: new Float64Array(12),
    eastMs: new Float64Array(count).fill(east),
    northMs: new Float64Array(count).fill(north),
    upMs: new Float64Array(count).fill(up),
    diagnostics: {
      converged: true, iterations: 0, initialMaxCellImbalanceM3s: 0,
      maxCellImbalanceM3s: 0, maxRelativeCellImbalance: 0,
    },
  }
}

const model = getTurbineModel('vestas-v80-2000')!
function turbine(id: string, eastingM: number, northingM = 100): FarmTurbine {
  return { id, eastingM, northingM, hubHeightM: 100, model }
}

describe('terrain-responsive wake composition', () => {
  it('trilinearly samples the cell-centred base field and rejects its unsampled faces', () => {
    const field = uniformField(8, 2, 1)
    expect(sampleBaseFlow(field, { eastingM: 150, northingM: 100, elevationM: 150 }))
      .toEqual({ east: 8, north: 2, up: 1 })
    expect(() => sampleBaseFlow(field, { eastingM: 150, northingM: 100, elevationM: 0 }))
      .toThrow(RangeError)
  })

  it('supports a one-cell, one-layer solver domain', () => {
    const field = uniformField(6)
    field.columns = 1
    field.rows = 1
    field.levels = 1
    field.groundElevationsM = new Float64Array([20])
    field.eastMs = new Float64Array([6])
    field.northMs = new Float64Array([0])
    field.upMs = new Float64Array([0])
    expect(sampleBaseFlow(field, { eastingM: 0, northingM: 0, elevationM: 160 }))
      .toEqual({ east: 6, north: 0, up: 0 })
  })

  it('integrates a uniform field downstream at a fixed spatial step', () => {
    const points = integrateStreamline(
      uniformField(8),
      { eastingM: 50, northingM: 100, elevationM: 100 },
      { stepM: 50, maxDistanceM: 150 },
    )
    expect(points).toHaveLength(4)
    expect(points.map(point => point.eastingM)).toEqual([50, 100, 150, 200])
    for (const point of points) expect(point.northingM).toBeCloseTo(100, 12)
  })

  it('uses the integrated streamline, not the meteorological straight-line axis', () => {
    const field = uniformField(8, 4)
    const farm = [turbine('t1', 50, 50)]
    const lines = buildWakeStreamlines(field, farm, { stepM: 25, maxDistanceM: 200 })
    const point = { eastingM: 210, northingM: 130, elevationM: 100 }
    const sample = sampleTerrainWakeField(field, point, farm, new Map([['t1', 0.8]]), lines)
    expect(sample.deficit).toBeGreaterThan(0.1)
    expect(sample.velocity.north / sample.velocity.east).toBeCloseTo(0.5, 10)
    expect(sample.speedMs).toBeCloseTo(sample.baseSpeedMs * (1 - sample.deficit), 12)
  })

  it('does not apply the wake upstream of the rotor', () => {
    const field = uniformField(10)
    const farm = [turbine('t1', 100)]
    const lines = buildWakeStreamlines(field, farm, { stepM: 25, maxDistanceM: 150 })
    const sample = sampleTerrainWakeField(
      field,
      { eastingM: 50, northingM: 100, elevationM: 100 },
      farm,
      new Map([['t1', 0.8]]),
      lines,
    )
    expect(sample.deficit).toBe(0)
    expect(sample.velocity.east).toBe(10)
  })

  it('combines overlapping curved wakes with a per-turbine breakdown', () => {
    const field = uniformField(10)
    const farm = [turbine('a', 50, 90), turbine('b', 50, 110)]
    const lines = buildWakeStreamlines(field, farm, { stepM: 25, maxDistanceM: 250 })
    const sample = sampleTerrainWakeField(
      field,
      { eastingM: 250, northingM: 100, elevationM: 100 },
      farm,
      new Map([['a', 0.8], ['b', 0.8]]),
      lines,
    )
    expect(sample.contributions.map(contribution => contribution.turbineId).sort()).toEqual(['a', 'b'])
    expect(sample.deficit).toBeCloseTo(Math.min(Math.hypot(
      sample.contributions[0]!.deficit,
      sample.contributions[1]!.deficit,
    ), 1), 12)
  })
})
