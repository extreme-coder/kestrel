import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CROSSWIND_SPACING_D,
  DEFAULT_DOWNWIND_SPACING_D,
  DEFAULT_PREVAILING_BEARING_DEG,
  generateGridLayout,
  layoutBounds,
} from '../src/lib/layout.js'
import { evaluateFarm, windTravelVector } from '../src/lib/wake.js'
import type { FarmTurbine } from '../src/lib/wake.js'
import { getTurbineModel } from '../src/lib/turbines.js'

const v112 = getTurbineModel('vestas-v112-3450')!
const v80 = getTurbineModel('vestas-v80-2000')!
const D = v112.rotorDiameterM // 112 m

/** Project a turbine into the wind frame — the frame `wake.ts` resolves deficits in. */
function windFrame(t: FarmTurbine, bearingDeg: number): { downwindM: number; crosswindM: number } {
  const travel = windTravelVector(bearingDeg)
  return {
    downwindM: t.eastingM * travel.east + t.northingM * travel.north,
    crosswindM: t.eastingM * -travel.north + t.northingM * travel.east,
  }
}

/** Every turbine-to-turbine distance, ascending. A rotation-invariant fingerprint. */
function pairwiseDistances(turbines: readonly FarmTurbine[]): number[] {
  const out: number[] = []
  for (let i = 0; i < turbines.length; i++) {
    for (let j = i + 1; j < turbines.length; j++) {
      const a = turbines[i]!
      const b = turbines[j]!
      out.push(Math.hypot(a.eastingM - b.eastingM, a.northingM - b.northingM))
    }
  }
  return out.sort((x, y) => x - y)
}

function centroid(turbines: readonly FarmTurbine[]): { eastingM: number; northingM: number } {
  const n = turbines.length
  return {
    eastingM: turbines.reduce((s, t) => s + t.eastingM, 0) / n,
    northingM: turbines.reduce((s, t) => s + t.northingM, 0) / n,
  }
}

describe('default spacing', () => {
  it('sits inside the conventional 5–7 D crosswind / 7–10 D downwind ranges', () => {
    expect(DEFAULT_CROSSWIND_SPACING_D).toBeGreaterThanOrEqual(5)
    expect(DEFAULT_CROSSWIND_SPACING_D).toBeLessThanOrEqual(7)
    expect(DEFAULT_DOWNWIND_SPACING_D).toBeGreaterThanOrEqual(7)
    expect(DEFAULT_DOWNWIND_SPACING_D).toBeLessThanOrEqual(10)
  })

  it('spends more distance along the wind than across it — the whole point', () => {
    expect(DEFAULT_DOWNWIND_SPACING_D).toBeGreaterThan(DEFAULT_CROSSWIND_SPACING_D)
  })
})

describe('grid layout', () => {
  it('places rows × columns turbines with unique, position-encoded ids', () => {
    const { turbines } = generateGridLayout({ model: v112, rows: 4, columns: 3 })
    expect(turbines).toHaveLength(12)
    expect(new Set(turbines.map((t) => t.id)).size).toBe(12)
    expect(turbines[0]!.id).toBe('t-r1c1')
    expect(turbines.at(-1)!.id).toBe('t-r4c3')
  })

  it('zero-pads ids per axis so they sort lexically in a large array', () => {
    const { turbines } = generateGridLayout({ model: v112, rows: 10, columns: 8 })
    expect(turbines[0]!.id).toBe('t-r01c1')
    expect(turbines.at(-1)!.id).toBe('t-r10c8')
    const sorted = [...turbines].map((t) => t.id).sort()
    expect(sorted).toEqual(turbines.map((t) => t.id))
  })

  it('honours an id prefix', () => {
    const { turbines } = generateGridLayout({ model: v112, rows: 1, columns: 2, idPrefix: 'hr' })
    expect(turbines.map((t) => t.id)).toEqual(['hr-r1c1', 'hr-r1c2'])
  })

  it('emits the most upwind row first', () => {
    const { turbines } = generateGridLayout({ model: v112, rows: 5, columns: 2 })
    const downwind = turbines.map((t) => windFrame(t, DEFAULT_PREVAILING_BEARING_DEG).downwindM)
    for (let i = 1; i < downwind.length; i++) {
      expect(downwind[i]!, `turbine ${i}`).toBeGreaterThanOrEqual(downwind[i - 1]! - 1e-9)
    }
  })

  it('spaces turbines by the requested multiples of the rotor diameter', () => {
    const layout = generateGridLayout({
      model: v112,
      rows: 3,
      columns: 3,
      crosswindSpacingD: 6,
      downwindSpacingD: 8,
    })
    expect(layout.crosswindSpacingM).toBeCloseTo(6 * D, 9)
    expect(layout.downwindSpacingM).toBeCloseTo(8 * D, 9)

    const frames = layout.turbines.map((t) => windFrame(t, layout.prevailingBearingDeg))
    // Neighbours within a row are one crosswind spacing apart at the same downwind station.
    expect(frames[1]!.crosswindM - frames[0]!.crosswindM).toBeCloseTo(6 * D, 6)
    expect(frames[1]!.downwindM).toBeCloseTo(frames[0]!.downwindM, 6)
    // The turbine one row back is one downwind spacing away on the same wake axis.
    expect(frames[3]!.downwindM - frames[0]!.downwindM).toBeCloseTo(8 * D, 6)
    expect(frames[3]!.crosswindM).toBeCloseTo(frames[0]!.crosswindM, 6)
  })

  it('lays rows across the wind — one downwind station per row', () => {
    const layout = generateGridLayout({ model: v112, rows: 3, columns: 4, prevailingBearingDeg: 215 })
    for (let row = 0; row < 3; row++) {
      const stations = layout.turbines
        .slice(row * 4, row * 4 + 4)
        .map((t) => windFrame(t, 215).downwindM)
      for (const s of stations) expect(s).toBeCloseTo(stations[0]!, 6)
    }
  })

  it('centres the array on the origin', () => {
    const c = centroid(generateGridLayout({ model: v112, rows: 4, columns: 6 }).turbines)
    expect(c.eastingM).toBeCloseTo(0, 6)
    expect(c.northingM).toBeCloseTo(0, 6)
  })

  it('translates with the origin without changing shape', () => {
    const at0 = generateGridLayout({ model: v112, rows: 3, columns: 3 })
    const moved = generateGridLayout({
      model: v112,
      rows: 3,
      columns: 3,
      origin: { eastingM: 5000, northingM: -2500 },
    })
    const c = centroid(moved.turbines)
    expect(c.eastingM).toBeCloseTo(5000, 6)
    expect(c.northingM).toBeCloseTo(-2500, 6)
    const a = pairwiseDistances(at0.turbines)
    const b = pairwiseDistances(moved.turbines)
    for (let i = 0; i < a.length; i++) expect(b[i]!).toBeCloseTo(a[i]!, 6)
  })

  it('rotates rigidly with the prevailing bearing', () => {
    const west = generateGridLayout({ model: v112, rows: 3, columns: 3, prevailingBearingDeg: 270 })
    const skew = generateGridLayout({ model: v112, rows: 3, columns: 3, prevailingBearingDeg: 200 })

    // Same farm, different heading: every internal distance is preserved.
    const a = pairwiseDistances(west.turbines)
    const b = pairwiseDistances(skew.turbines)
    for (let i = 0; i < a.length; i++) expect(b[i]!).toBeCloseTo(a[i]!, 6)

    // A westerly travels due east, so easting is the downwind axis and rows are N–S.
    expect(west.turbines[0]!.northingM).not.toBeCloseTo(west.turbines[1]!.northingM, 3)
    expect(west.turbines[0]!.eastingM).toBeCloseTo(west.turbines[1]!.eastingM, 6)
    // Rotating the heading moves turbines off that axis.
    expect(skew.turbines[0]!.eastingM).not.toBeCloseTo(west.turbines[0]!.eastingM, 3)
  })

  it('runs the array southward for a northerly, matching the bearing convention', () => {
    // A 0° wind blows from the north and travels south, so downwind is −northing.
    const layout = generateGridLayout({ model: v112, rows: 2, columns: 1, prevailingBearingDeg: 0 })
    const [first, second] = layout.turbines
    expect(second!.northingM).toBeLessThan(first!.northingM)
    expect(first!.northingM - second!.northingM).toBeCloseTo(DEFAULT_DOWNWIND_SPACING_D * D, 6)
  })

  it('staggers alternate rows by half the crosswind spacing at fraction 0.5', () => {
    const layout = generateGridLayout({
      model: v112,
      rows: 4,
      columns: 3,
      crosswindSpacingD: 6,
      staggerFraction: 0.5,
    })
    const cross = layout.turbines.map((t) => windFrame(t, layout.prevailingBearingDeg).crosswindM)
    expect(cross[3]! - cross[0]!).toBeCloseTo(0.5 * 6 * D, 6)
    // Row 3 realigns with row 1 — a half-spacing stagger has period two.
    expect(cross[6]!).toBeCloseTo(cross[0]!, 6)
  })

  it('keeps a staggered array centred on the origin', () => {
    const c = centroid(
      generateGridLayout({ model: v112, rows: 4, columns: 4, staggerFraction: 0.5 }).turbines,
    )
    expect(c.eastingM).toBeCloseTo(0, 6)
    expect(c.northingM).toBeCloseTo(0, 6)
  })

  it('defaults hub height to the rotor diameter and honours an override', () => {
    const dflt = generateGridLayout({ model: v112, rows: 1, columns: 1 })
    expect(dflt.turbines[0]!.hubHeightM).toBe(D)

    const offshore = generateGridLayout({ model: v80, rows: 1, columns: 1, hubHeightM: 70 })
    expect(offshore.turbines[0]!.hubHeightM).toBe(70)
  })

  it('carries the model through to every turbine', () => {
    const { turbines } = generateGridLayout({ model: v80, rows: 2, columns: 2 })
    for (const t of turbines) expect(t.model).toBe(v80)
  })

  it('puts a single turbine exactly on the origin', () => {
    const { turbines } = generateGridLayout({
      model: v112,
      rows: 1,
      columns: 1,
      origin: { eastingM: 120, northingM: -40 },
    })
    expect(turbines).toHaveLength(1)
    expect(turbines[0]!.eastingM).toBeCloseTo(120, 9)
    expect(turbines[0]!.northingM).toBeCloseTo(-40, 9)
  })

  it('rejects nonsense specs rather than emitting a degenerate farm', () => {
    const base = { model: v112, rows: 2, columns: 2 }
    expect(() => generateGridLayout({ ...base, rows: 0 })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, columns: -1 })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, rows: 2.5 })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, crosswindSpacingD: 0 })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, downwindSpacingD: -8 })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, hubHeightM: 0 })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, prevailingBearingDeg: NaN })).toThrow(RangeError)
    expect(() => generateGridLayout({ ...base, staggerFraction: Infinity })).toThrow(RangeError)
    expect(() =>
      generateGridLayout({ ...base, origin: { eastingM: NaN, northingM: 0 } }),
    ).toThrow(RangeError)
  })
})

describe('layout bounds', () => {
  it('spans (n − 1) spacings on each axis', () => {
    const { bounds } = generateGridLayout({
      model: v112,
      rows: 5,
      columns: 4,
      crosswindSpacingD: 6,
      downwindSpacingD: 8,
    })
    // Westerly default: easting is downwind (5 rows), northing is crosswind (4 columns).
    expect(bounds.eastingSpanM).toBeCloseTo(4 * 8 * D, 6)
    expect(bounds.northingSpanM).toBeCloseTo(3 * 6 * D, 6)
    expect(bounds.centreEastingM).toBeCloseTo(0, 6)
    expect(bounds.centreNorthingM).toBeCloseTo(0, 6)
    expect(bounds.maxRotorDiameterM).toBe(D)
    expect(bounds.minHubHeightM).toBe(D)
    expect(bounds.maxHubHeightM).toBe(D)
  })

  it('pads by the margin in rotor diameters, leaving hub heights alone', () => {
    const { turbines } = generateGridLayout({ model: v112, rows: 3, columns: 3 })
    const tight = layoutBounds(turbines)
    const padded = layoutBounds(turbines, { marginD: 10 })

    expect(padded.minEastingM).toBeCloseTo(tight.minEastingM - 10 * D, 6)
    expect(padded.maxEastingM).toBeCloseTo(tight.maxEastingM + 10 * D, 6)
    expect(padded.eastingSpanM).toBeCloseTo(tight.eastingSpanM + 20 * D, 6)
    expect(padded.northingSpanM).toBeCloseTo(tight.northingSpanM + 20 * D, 6)
    expect(padded.maxHubHeightM).toBe(tight.maxHubHeightM)
  })

  it('scales the margin by the largest rotor present', () => {
    const mixed: FarmTurbine[] = [
      { id: 'small', eastingM: 0, northingM: 0, hubHeightM: 80, model: v80 },
      { id: 'large', eastingM: 1000, northingM: 0, hubHeightM: 112, model: v112 },
    ]
    const b = layoutBounds(mixed, { marginD: 1 })
    expect(b.maxRotorDiameterM).toBe(D)
    expect(b.minEastingM).toBeCloseTo(-D, 6)
    expect(b.minHubHeightM).toBe(80)
    expect(b.maxHubHeightM).toBe(112)
  })

  it('returns a zeroed box for an empty layout rather than ±Infinity', () => {
    const b = layoutBounds([], { marginD: 10 })
    expect(b.eastingSpanM).toBe(0)
    expect(b.northingSpanM).toBe(0)
    expect(b.maxRotorDiameterM).toBe(0)
    for (const v of Object.values(b)) expect(Number.isFinite(v)).toBe(true)
  })

  it('rejects a negative margin', () => {
    expect(() => layoutBounds([], { marginD: -1 })).toThrow(RangeError)
  })
})

describe('the Horns Rev anchor', () => {
  // An external check on the *spacing convention*, not on the wake physics: Horns Rev 1 is
  // 80 V80-2000 machines on a 10 × 8 grid at 7 D (560 m), occupying about 20 km² measuring
  // roughly 5 km × 3.8 km, on 70 m towers. If this generator's notion of "conventional
  // spacing" is right, feeding it those counts must reproduce that published footprint —
  // and it does, to within about 3% on either axis. (The real array is slightly skewed
  // rather than rectangular, which is what the residual is.)
  const hornsRev = generateGridLayout({
    model: v80,
    rows: 10,
    columns: 8,
    crosswindSpacingD: 7,
    downwindSpacingD: 7,
    hubHeightM: 70,
  })

  it('reproduces the published 560 m spacing', () => {
    expect(hornsRev.turbines).toHaveLength(80)
    expect(hornsRev.crosswindSpacingM).toBeCloseTo(560, 9)
    expect(hornsRev.downwindSpacingM).toBeCloseTo(560, 9)
  })

  it('reproduces the published ~5 km × 3.8 km footprint', () => {
    expect(Math.abs(hornsRev.bounds.eastingSpanM / 5000 - 1)).toBeLessThan(0.05)
    expect(Math.abs(hornsRev.bounds.northingSpanM / 3800 - 1)).toBeLessThan(0.05)
  })

  it('reproduces the published ~20 km² area', () => {
    const areaKm2 = (hornsRev.bounds.eastingSpanM * hornsRev.bounds.northingSpanM) / 1e6
    expect(Math.abs(areaKm2 / 20 - 1)).toBeLessThan(0.05)
  })
})

describe('a synthesized layout under the wake model', () => {
  const layout = generateGridLayout({ model: v112, rows: 5, columns: 5 })
  const prevailing = { freeStreamMs: 10, bearingDeg: layout.prevailingBearingDeg }

  it('leaves the upwind row clean and wakes everything behind it', () => {
    const { turbines } = evaluateFarm(layout.turbines, prevailing)
    const byId = new Map(turbines.map((t) => [t.turbineId, t]))

    for (let c = 1; c <= 5; c++) {
      expect(byId.get(`t-r1c${c}`)!.deficit, `front row c${c}`).toBeCloseTo(0, 9)
    }
    for (let r = 2; r <= 5; r++) {
      expect(byId.get(`t-r${r}c3`)!.deficit, `row ${r}`).toBeGreaterThan(0)
    }
  })

  it('names an upwind neighbour in the same column as the dominant wake source', () => {
    const { turbines } = evaluateFarm(layout.turbines, prevailing)
    const waked = turbines.find((t) => t.turbineId === 't-r3c3')!
    expect(waked.dominantWakeSource).toBe('t-r2c3')
  })

  it('loses less at the bearing it was laid out for than across it', () => {
    // The array spends 8 D along the prevailing wind and 6 D across it, so turning the
    // wind a quarter turn puts the tighter spacing on the wake axis. This is the entire
    // justification for orienting the grid to the wind, and it is a relationship the
    // layout must produce rather than a number to pin.
    const along = evaluateFarm(layout.turbines, prevailing).wakeLossFraction
    const across = evaluateFarm(layout.turbines, {
      ...prevailing,
      bearingDeg: layout.prevailingBearingDeg + 90,
    }).wakeLossFraction
    expect(along).toBeLessThan(across)
  })

  it('loses less when alternate rows are staggered out of the wakes ahead', () => {
    const staggered = generateGridLayout({ model: v112, rows: 5, columns: 5, staggerFraction: 0.5 })
    const aligned = evaluateFarm(layout.turbines, prevailing).wakeLossFraction
    const offset = evaluateFarm(staggered.turbines, prevailing).wakeLossFraction
    expect(offset).toBeLessThan(aligned)
  })

  it('produces a farm loss in a plausible band for a fully-aligned array', () => {
    // 15–45% for every machine directly shadowed at 8 D, 10 m/s, I = 0.1. This is a
    // sanity band, not a validated figure: single-bearing losses in a perfectly aligned
    // array are far deeper than the annual all-directions numbers farms publish, and the
    // wake model still has no external calibration (see the wiki's testing node).
    const loss = evaluateFarm(layout.turbines, prevailing).wakeLossFraction
    expect(loss).toBeGreaterThan(0.15)
    expect(loss).toBeLessThan(0.45)
  })

  it('recovers more of the farm as the array is spread out', () => {
    const spread = generateGridLayout({
      model: v112,
      rows: 5,
      columns: 5,
      crosswindSpacingD: 7,
      downwindSpacingD: 10,
    })
    const tight = generateGridLayout({
      model: v112,
      rows: 5,
      columns: 5,
      crosswindSpacingD: 5,
      downwindSpacingD: 7,
    })
    expect(evaluateFarm(spread.turbines, prevailing).wakeLossFraction).toBeLessThan(
      evaluateFarm(tight.turbines, prevailing).wakeLossFraction,
    )
  })
})
