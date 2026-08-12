import { describe, expect, it } from 'vitest'

import type { BaseFlowField } from '../src/lib/baseFlow.js'
import { solveMassConsistentBaseFlow } from '../src/lib/baseFlow.js'
import { analyseTerrainFarm } from '../src/lib/farmAnalysis.js'
import { generateGridLayout } from '../src/lib/layout.js'
import { buildWakeStreamlines } from '../src/lib/terrainWake.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { askerveinTerrainGrid } from '../src/lib/validation/askerveinTerrain.js'
import { evaluateFarm } from '../src/lib/wake.js'
import type { FarmTurbine } from '../src/lib/wake.js'

const model = getTurbineModel('vestas-v112-3450')!

/** A flat, uniform easterly-travelling field: the case `wake.ts` already has an answer for. */
function uniformField(speedMs: number, columns = 41, rows = 9): BaseFlowField {
  const levels = 6
  const count = columns * rows * levels
  return {
    siteId: 'synthetic',
    columns,
    rows,
    levels,
    originEastingM: 0,
    originNorthingM: 0,
    cellSizeEastingM: 100,
    cellSizeNorthingM: 100,
    topElevationM: 600,
    groundElevationsM: new Float64Array(columns * rows),
    eastMs: new Float64Array(count).fill(speedMs),
    northMs: new Float64Array(count).fill(0),
    upMs: new Float64Array(count).fill(0),
    diagnostics: {
      converged: true,
      iterations: 0,
      initialMaxCellImbalanceM3s: 0,
      maxCellImbalanceM3s: 0,
      maxRelativeCellImbalance: 0,
    },
  }
}

function turbine(id: string, eastingM: number, northingM: number): FarmTurbine {
  return { id, eastingM, northingM, hubHeightM: 100, model }
}

function analyse(field: BaseFlowField, turbines: FarmTurbine[], bearingDeg: number) {
  const streamlines = buildWakeStreamlines(field, turbines)
  return analyseTerrainFarm(field, turbines, streamlines, { bearingDeg, turbulenceIntensity: 0.08 })
}

describe('terrain-aware farm analysis', () => {
  // 270 deg is a westerly, so the wind travels east and easting is the downwind axis.
  const westerly = 270

  it('leaves an isolated turbine unwaked, with net equal to gross', () => {
    const analysis = analyse(uniformField(9), [turbine('solo', 500, 400)], westerly)
    const [solo] = analysis.turbines
    expect(solo!.contributors).toEqual([])
    expect(solo!.dominantContributorId).toBeNull()
    expect(solo!.wakeLossFraction).toBe(0)
    expect(solo!.netPowerKw).toBeCloseTo(solo!.grossPowerKw, 9)
    expect(analysis.worstTurbineId).toBe('solo')
  })

  it('reproduces the flat-terrain model when the field is flat and uniform', () => {
    // The two implementations share the deficit functions but nothing else: this one walks
    // curved streamlines through an interpolated volume, `evaluateFarm` projects onto a
    // straight wind vector. On a uniform field they must agree, and if they ever stop, the
    // picture and the table have started describing different farms.
    const turbines = [turbine('a', 500, 400), turbine('b', 1300, 400), turbine('c', 2100, 400)]
    const field = uniformField(9)
    const terrainResult = analyse(field, turbines, westerly)
    const flatResult = evaluateFarm(turbines, {
      freeStreamMs: 9,
      bearingDeg: westerly,
      referenceHeightM: 100,
      turbulenceIntensity: 0.08,
    })

    for (const expected of flatResult.turbines) {
      const actual = terrainResult.turbines.find((t) => t.turbineId === expected.turbineId)!
      expect(actual.incomingSpeedMs, expected.turbineId).toBeCloseTo(expected.effectiveSpeedMs, 2)
      expect(actual.netPowerKw, expected.turbineId).toBeCloseTo(expected.powerKw, 0)
      expect(actual.dominantContributorId, expected.turbineId).toBe(expected.dominantWakeSource)
    }
    expect(terrainResult.wakeLossFraction).toBeCloseTo(flatResult.wakeLossFraction, 3)
  })

  it('resolves turbines upwind-first so a waked machine casts a weaker wake', () => {
    // The correctness requirement, not an optimization. A turbine's thrust coefficient
    // depends on the speed it sees; resolving out of order would use a free-stream Ct for an
    // already-waked machine and overstate every wake behind it.
    const turbines = [turbine('a', 500, 400), turbine('b', 1300, 400), turbine('c', 2100, 400)]
    // Above the parametric curve's knee, where Ct actually varies with speed. Below it the
    // fallback is flat at 0.8 and the ordering has nothing to bite on.
    const analysis = analyse(uniformField(16), turbines, westerly)
    expect(analysis.turbines.map((t) => t.turbineId)).toEqual(['a', 'b', 'c'])

    const [first, second] = analysis.turbines
    expect(second!.incomingSpeedMs).toBeLessThan(first!.incomingSpeedMs)
    expect(second!.thrustCoefficient).toBeGreaterThan(first!.thrustCoefficient)
    // Submitting them backwards must not change any answer.
    const reversed = analyse(uniformField(16), [...turbines].reverse(), westerly)
    expect(reversed.turbines.map((t) => t.turbineId)).toEqual(['a', 'b', 'c'])
    expect(reversed.turbines[2]!.wakeLossFraction).toBeCloseTo(analysis.turbines[2]!.wakeLossFraction, 9)
  })

  it('attributes shares that sum to one and rank the nearest full overlap first', () => {
    const turbines = [
      turbine('direct', 500, 400),
      turbine('offset', 500, 700),
      turbine('target', 1300, 400),
    ]
    const analysis = analyse(uniformField(9), turbines, westerly)
    const target = analysis.turbines.find((t) => t.turbineId === 'target')!

    expect(target.contributors.length).toBeGreaterThanOrEqual(1)
    expect(target.dominantContributorId).toBe('direct')
    expect(target.contributors[0]!.share).toBeGreaterThan(0.9)
    const shares = target.contributors.reduce((sum, c) => sum + c.share, 0)
    expect(shares).toBeCloseTo(1, 9)
    const attributed = target.contributors.reduce((sum, c) => sum + c.attributedLossKw, 0)
    expect(attributed).toBeCloseTo(target.wakeLossKw, 6)

    // The geometry has to be checkable against the scene: 800 m at 112 m rotor is 7.1 D
    // straight downwind, and the wake axis passes through the hub.
    expect(target.contributors[0]!.downwindD).toBeCloseTo(800 / 112, 1)
    expect(target.contributors[0]!.radialM).toBeLessThan(1)
  })

  it('reports gross power in the local terrain flow, not in a uniform free stream', () => {
    // Terrain speed-up belongs in gross, so wake loss isolates the wakes. Reading a
    // hilltop turbine's larger gross figure as a wake effect is the obvious way to get
    // attribution wrong, and this is what keeps the two apart.
    const terrain = askerveinTerrainGrid()
    const field = solveMassConsistentBaseFlow({
      terrain,
      topElevationM: 500,
      levels: 8,
      bearingDegrees: 210,
      referenceSpeedMs: 10,
      referenceHeightM: 100,
      shearExponent: 1 / 7,
      alphaHorizontalVerticalRatio: 1,
    })
    const layout = generateGridLayout({
      model,
      rows: 2,
      columns: 2,
      crosswindSpacingD: 6,
      downwindSpacingD: 8,
      prevailingBearingDeg: 210,
      hubHeightM: 100,
      origin: { eastingM: 1000, northingM: 1000 },
    })
    const analysis = analyse(field, layout.turbines, 210)

    const grossSpeeds = analysis.turbines.map((t) => t.grossSpeedMs)
    expect(Math.max(...grossSpeeds) - Math.min(...grossSpeeds)).toBeGreaterThan(0.5)
    for (const t of analysis.turbines) {
      if (t.contributors.length === 0) expect(t.incomingSpeedMs).toBeCloseTo(t.grossSpeedMs, 9)
      expect(t.groundElevationM).toBeGreaterThan(0)
    }
  })

  it('holds the recorded baseline for the shipped demonstration scene', () => {
    // The figures docs/design/alternate-bearing.md publishes and the client renders. Pinned
    // so a physics change has to update the document rather than silently contradict it.
    const terrain = askerveinTerrainGrid()
    const field = solveMassConsistentBaseFlow({
      terrain,
      topElevationM: 500,
      levels: 8,
      bearingDegrees: 210,
      referenceSpeedMs: 10,
      referenceHeightM: 100,
      shearExponent: 1 / 7,
      alphaHorizontalVerticalRatio: 1,
    })
    const layout = generateGridLayout({
      model,
      rows: 2,
      columns: 2,
      crosswindSpacingD: 6,
      downwindSpacingD: 8,
      prevailingBearingDeg: 210,
      hubHeightM: 100,
      origin: { eastingM: 1000, northingM: 1000 },
    })
    const analysis = analyse(field, layout.turbines, 210)

    expect(analysis.worstTurbineId).toBe('t-r2c1')
    const worst = analysis.turbines.find((t) => t.turbineId === 't-r2c1')!
    expect(worst.wakeLossFraction).toBeCloseTo(0.4559, 3)
    expect(worst.dominantContributorId).toBe('t-r1c1')
    expect(analysis.wakeLossFraction).toBeCloseTo(0.254, 2)

    const ranked = [...analysis.turbines].sort((a, b) => b.wakeLossFraction - a.wakeLossFraction)
    expect(ranked.map((t) => t.turbineId).slice(0, 2)).toEqual(['t-r2c1', 't-r2c2'])
  })

  it('reorders the top two at the alternate bearing, which is why 215 was chosen', () => {
    // docs/design/alternate-bearing.md. If this stops holding, T3 has no answer in the
    // shipped scene and the recorded bearing has to be re-derived: npm run choose:bearing.
    const terrain = askerveinTerrainGrid()
    const layout = generateGridLayout({
      model,
      rows: 2,
      columns: 2,
      crosswindSpacingD: 6,
      downwindSpacingD: 8,
      // Fixed at the design bearing while the wind turns — the whole point of D26. A layout
      // that rotates with the wind presents the same geometry at every bearing.
      prevailingBearingDeg: 210,
      hubHeightM: 100,
      origin: { eastingM: 1000, northingM: 1000 },
    })
    const field = solveMassConsistentBaseFlow({
      terrain,
      topElevationM: 500,
      levels: 8,
      bearingDegrees: 215,
      referenceSpeedMs: 10,
      referenceHeightM: 100,
      shearExponent: 1 / 7,
      alphaHorizontalVerticalRatio: 1,
    })
    const analysis = analyse(field, layout.turbines, 215)
    expect(analysis.worstTurbineId).toBe('t-r2c2')
    expect(analysis.turbines.find((t) => t.turbineId === 't-r2c2')!.wakeLossFraction).toBeCloseTo(0.393, 2)
    expect(analysis.wakeLossFraction).toBeLessThan(0.254)
  })

  it('carries a curved wake axis that climbs with the terrain', () => {
    // A straight line along the bearing would contradict the field the same response
    // describes, and the section inset that carries this to a screen reader would show a
    // plume that never rises over the hill.
    const terrain = askerveinTerrainGrid()
    const field = solveMassConsistentBaseFlow({
      terrain,
      topElevationM: 500,
      levels: 8,
      bearingDegrees: 210,
      referenceSpeedMs: 10,
      referenceHeightM: 100,
      shearExponent: 1 / 7,
      alphaHorizontalVerticalRatio: 1,
    })
    const layout = generateGridLayout({
      model,
      rows: 2,
      columns: 2,
      crosswindSpacingD: 6,
      downwindSpacingD: 8,
      prevailingBearingDeg: 210,
      hubHeightM: 100,
      origin: { eastingM: 1000, northingM: 1000 },
    })
    const analysis = analyse(field, layout.turbines, 210)
    const source = analysis.turbines.find((t) => t.turbineId === 't-r1c1')!

    expect(source.wakePath.length).toBeGreaterThan(4)
    expect(source.wakePath.length).toBeLessThanOrEqual(49)
    expect(source.wakePath[0]!.distanceM).toBe(0)
    expect(source.wakePath[0]!.eastingM).toBeCloseTo(source.eastingM, 6)
    expect(source.wakePath[0]!.elevationM).toBeCloseTo(source.groundElevationM + source.hubHeightM, 6)

    const distances = source.wakePath.map((p) => p.distanceM)
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
    for (const point of source.wakePath) {
      expect(point.elevationM).toBeGreaterThan(point.groundElevationM)
    }
    const elevations = source.wakePath.map((p) => p.elevationM)
    expect(Math.max(...elevations) - Math.min(...elevations)).toBeGreaterThan(1)
  })

  it('returns a zeroed farm rather than dividing by zero when there are no turbines', () => {
    const analysis = analyse(uniformField(9), [], 270)
    expect(analysis.turbines).toEqual([])
    expect(analysis.wakeLossFraction).toBe(0)
    expect(analysis.worstTurbineId).toBeNull()
  })
})
