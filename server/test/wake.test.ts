import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TURBULENCE_INTENSITY,
  centrelineDeficitFraction,
  combineDeficits,
  evaluateFarm,
  nearWakeOffset,
  operatingThrustCoefficients,
  sampleWakeField,
  singleWakeDeficit,
  wakeGrowthRate,
  wakeWidthM,
  windTravelVector,
} from '../src/lib/wake.js'
import type { FarmTurbine, WakeConditions } from '../src/lib/wake.js'
import { getTurbineModel } from '../src/lib/turbines.js'

const v112 = getTurbineModel('vestas-v112-3450')!
const D = v112.rotorDiameterM // 112 m
const HUB = 84

/** Wind from the west, so it travels due east and easting is the downwind axis. */
const WESTERLY: WakeConditions = { freeStreamMs: 10, bearingDeg: 270 }

function turbine(id: string, eastingM: number, northingM = 0): FarmTurbine {
  return { id, eastingM, northingM, hubHeightM: HUB, model: v112 }
}

describe('wake growth rate', () => {
  it('follows the Niayifar & Porté-Agel linear fit', () => {
    expect(wakeGrowthRate(0.1)).toBeCloseTo(0.3837 * 0.1 + 0.003678, 12)
    expect(wakeGrowthRate(0.06)).toBeCloseTo(0.0267, 4)
  })

  it('grows monotonically with turbulence — rougher air recovers wakes faster', () => {
    expect(wakeGrowthRate(0.15)).toBeGreaterThan(wakeGrowthRate(0.06))
  })

  it('stays positive at zero turbulence and clamps nonsense input', () => {
    expect(wakeGrowthRate(0)).toBeGreaterThan(0)
    expect(wakeGrowthRate(-1)).toBe(wakeGrowthRate(0))
    expect(wakeGrowthRate(5)).toBe(wakeGrowthRate(1))
  })
})

describe('near-wake offset', () => {
  it('matches the hand-computed 0.2√β at Ct = 0.8', () => {
    // β = 0.5(1+√0.2)/√0.2 = 1.618034, so ε = 0.2√1.618034 = 0.2544039.
    expect(nearWakeOffset(0.8)).toBeCloseTo(0.2544039, 6)
  })

  it('is 0.2 for a rotor that extracts no momentum', () => {
    expect(nearWakeOffset(0)).toBeCloseTo(0.2, 9)
  })

  it('widens as thrust increases', () => {
    expect(nearWakeOffset(0.9)).toBeGreaterThan(nearWakeOffset(0.5))
  })
})

describe('wake width', () => {
  it('is the linear expansion σ/D = k·(x/D) + ε', () => {
    const k = wakeGrowthRate(DEFAULT_TURBULENCE_INTENSITY)
    const expected = (k * 7 + nearWakeOffset(0.8)) * D
    expect(wakeWidthM(7 * D, D, 0.8, k)).toBeCloseTo(expected, 9)
  })

  it('grows with downstream distance', () => {
    const k = wakeGrowthRate(0.1)
    expect(wakeWidthM(10 * D, D, 0.8, k)).toBeGreaterThan(wakeWidthM(3 * D, D, 0.8, k))
  })
})

describe('centreline deficit', () => {
  it('matches the hand-computed momentum balance at 7D', () => {
    // k(I=0.1) = 0.042048 → σ/D = 0.042048·7 + 0.2544039 = 0.5487399
    // 1 − √(1 − 0.8/(8·0.5487399²)) = 0.182748
    const k = wakeGrowthRate(0.1)
    const sigmaOverD = k * 7 + nearWakeOffset(0.8)
    expect(centrelineDeficitFraction(0.8, sigmaOverD)).toBeCloseTo(0.182748, 5)
  })

  it('is zero when the rotor removes no momentum', () => {
    expect(centrelineDeficitFraction(0, 0.5)).toBeCloseTo(0, 12)
  })

  it('clamps to full deficit where the Gaussian is too narrow to carry the momentum', () => {
    // Radicand goes negative for small σ — the model outside its domain, not stagnation.
    expect(centrelineDeficitFraction(0.8, 0.05)).toBe(1)
    expect(centrelineDeficitFraction(0.8, 0)).toBe(1)
  })

  it('recovers monotonically as the wake widens', () => {
    const wide = centrelineDeficitFraction(0.8, 0.9)
    const narrow = centrelineDeficitFraction(0.8, 0.45)
    expect(wide).toBeLessThan(narrow)
  })
})

describe('single wake deficit', () => {
  const k = wakeGrowthRate(DEFAULT_TURBULENCE_INTENSITY)

  it('is zero upstream of the rotor — the model has no induction zone', () => {
    expect(singleWakeDeficit(-3 * D, 0, D, 0.8, k)).toBe(0)
    expect(singleWakeDeficit(0, 0, D, 0.8, k)).toBe(0)
  })

  it('is symmetric about the wake axis', () => {
    const left = singleWakeDeficit(5 * D, -40, D, 0.8, k)
    const right = singleWakeDeficit(5 * D, 40, D, 0.8, k)
    expect(left).toBeCloseTo(right, 12)
  })

  it('peaks on the centreline and falls off radially', () => {
    const axis = singleWakeDeficit(5 * D, 0, D, 0.8, k)
    const off = singleWakeDeficit(5 * D, 60, D, 0.8, k)
    const far = singleWakeDeficit(5 * D, 200, D, 0.8, k)
    expect(axis).toBeGreaterThan(off)
    expect(off).toBeGreaterThan(far)
  })

  it('recovers with downstream distance', () => {
    const near = singleWakeDeficit(4 * D, 0, D, 0.8, k)
    const mid = singleWakeDeficit(8 * D, 0, D, 0.8, k)
    const far = singleWakeDeficit(16 * D, 0, D, 0.8, k)
    expect(near).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
  })

  it('produces a deeper wake for a higher thrust coefficient', () => {
    expect(singleWakeDeficit(6 * D, 0, D, 0.85, k)).toBeGreaterThan(
      singleWakeDeficit(6 * D, 0, D, 0.5, k),
    )
  })

  it('casts no wake when the rotor is parked', () => {
    expect(singleWakeDeficit(6 * D, 0, D, 0, k)).toBe(0)
  })

  it('stays within [0, 1] across a wide sweep', () => {
    for (let x = 0.5; x <= 30; x += 0.5) {
      for (let r = 0; r <= 300; r += 25) {
        const d = singleWakeDeficit(x * D, r, D, 0.85, k)
        expect(d, `x=${x}D r=${r}`).toBeGreaterThanOrEqual(0)
        expect(d, `x=${x}D r=${r}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('deficit superposition', () => {
  it('combines by sum of squares', () => {
    expect(combineDeficits([0.3, 0.4])).toBeCloseTo(0.5, 12)
  })

  it('is order independent', () => {
    const a = combineDeficits([0.1, 0.35, 0.22])
    const b = combineDeficits([0.22, 0.1, 0.35])
    expect(a).toBeCloseTo(b, 12)
  })

  it('stays below the linear sum — the reason for sum-of-squares', () => {
    const deficits = [0.4, 0.4, 0.4]
    const linear = deficits.reduce((s, d) => s + d, 0)
    expect(linear).toBeGreaterThan(1)
    expect(combineDeficits(deficits)).toBeLessThan(1)
  })

  it('never exceeds a total blockage of 1', () => {
    expect(combineDeficits([0.9, 0.9, 0.9, 0.9])).toBe(1)
  })

  it('ignores empty and non-positive contributions', () => {
    expect(combineDeficits([])).toBe(0)
    expect(combineDeficits([0, -0.2])).toBe(0)
  })
})

describe('wind travel vector', () => {
  it('reverses the meteorological bearing', () => {
    const north = windTravelVector(0)
    expect(north.east).toBeCloseTo(0, 12)
    expect(north.north).toBeCloseTo(-1, 12)

    const east = windTravelVector(90)
    expect(east.east).toBeCloseTo(-1, 12)
    expect(east.north).toBeCloseTo(0, 12)

    const west = windTravelVector(270)
    expect(west.east).toBeCloseTo(1, 12)
    expect(west.north).toBeCloseTo(0, 12)
  })

  it('is a unit vector at every bearing', () => {
    for (let b = 0; b < 360; b += 15) {
      const v = windTravelVector(b)
      expect(Math.hypot(v.east, v.north), `bearing ${b}`).toBeCloseTo(1, 12)
    }
  })
})

describe('sampling the field', () => {
  const farm = [turbine('a', 0)]
  const ct = operatingThrustCoefficients(farm, WESTERLY)

  it('returns undisturbed free stream upstream of the farm', () => {
    const s = sampleWakeField(
      { eastingM: -5 * D, northingM: 0, heightM: HUB },
      farm,
      WESTERLY,
      ct,
    )
    expect(s.deficit).toBe(0)
    expect(s.speedMs).toBeCloseTo(10, 9)
    expect(s.contributions).toHaveLength(0)
  })

  it('slows the flow directly downstream', () => {
    const s = sampleWakeField(
      { eastingM: 7 * D, northingM: 0, heightM: HUB },
      farm,
      WESTERLY,
      ct,
    )
    expect(s.deficit).toBeGreaterThan(0.15)
    expect(s.speedMs).toBeLessThan(10)
    expect(s.contributions[0]?.turbineId).toBe('a')
  })

  it('applies wind shear to the free stream', () => {
    const low = sampleWakeField(
      { eastingM: -5 * D, northingM: 0, heightM: 40 },
      farm,
      WESTERLY,
      ct,
    )
    const high = sampleWakeField(
      { eastingM: -5 * D, northingM: 0, heightM: 150 },
      farm,
      WESTERLY,
      ct,
    )
    expect(low.freeStreamMs).toBeLessThan(10)
    expect(high.freeStreamMs).toBeGreaterThan(10)
  })

  it('points the velocity vector along the wind and keeps it streamwise', () => {
    const s = sampleWakeField(
      { eastingM: 3 * D, northingM: 0, heightM: HUB },
      farm,
      WESTERLY,
      ct,
    )
    // Westerly travels due east.
    expect(s.velocity.east).toBeCloseTo(s.speedMs, 9)
    expect(s.velocity.north).toBeCloseTo(0, 9)
    expect(s.velocity.up).toBe(0)
  })

  it('sorts contributions by depth so the dominant source is first', () => {
    const two = [turbine('near', 0), turbine('far', -10 * D)]
    const cts = operatingThrustCoefficients(two, WESTERLY)
    const s = sampleWakeField(
      { eastingM: 3 * D, northingM: 0, heightM: HUB },
      two,
      WESTERLY,
      cts,
    )
    expect(s.contributions).toHaveLength(2)
    expect(s.contributions[0]!.turbineId).toBe('near')
    expect(s.contributions[0]!.deficit).toBeGreaterThan(s.contributions[1]!.deficit)
  })
})

describe('evaluating a farm', () => {
  it('wakes the downstream turbine and leaves the upstream one clean', () => {
    const farm = [turbine('up', 0), turbine('down', 7 * D)]
    const { turbines } = evaluateFarm(farm, WESTERLY)
    const up = turbines.find((t) => t.turbineId === 'up')!
    const down = turbines.find((t) => t.turbineId === 'down')!

    expect(up.deficit).toBe(0)
    expect(up.effectiveSpeedMs).toBeCloseTo(10, 9)
    expect(down.deficit).toBeCloseTo(0.182748, 4)
    expect(down.effectiveSpeedMs).toBeLessThan(up.effectiveSpeedMs)
    expect(down.powerKw).toBeLessThan(up.powerKw)
  })

  it('names the turbine responsible for the loss', () => {
    const farm = [turbine('up', 0), turbine('down', 7 * D)]
    const { turbines } = evaluateFarm(farm, WESTERLY)
    expect(turbines.find((t) => t.turbineId === 'down')!.dominantWakeSource).toBe('up')
    expect(turbines.find((t) => t.turbineId === 'up')!.dominantWakeSource).toBeNull()
  })

  it('is independent of the order turbines are supplied in', () => {
    const forward = [turbine('a', 0), turbine('b', 5 * D), turbine('c', 10 * D)]
    const reversed = [...forward].reverse()

    const byId = (r: ReturnType<typeof evaluateFarm>) =>
      Object.fromEntries(r.turbines.map((t) => [t.turbineId, t.effectiveSpeedMs]))

    expect(byId(evaluateFarm(reversed, WESTERLY))).toEqual(
      byId(evaluateFarm(forward, WESTERLY)),
    )
  })

  it('compounds down a row, with each machine slower than the one ahead', () => {
    const row = [0, 5, 10, 15].map((i) => turbine(`t${i}`, i * D))
    const { turbines } = evaluateFarm(row, WESTERLY)
    const speeds = ['t0', 't5', 't10', 't15'].map(
      (id) => turbines.find((t) => t.turbineId === id)!.effectiveSpeedMs,
    )
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!, `turbine ${i}`).toBeLessThan(speeds[i - 1]!)
    }
  })

  it('uses waked thrust for downstream machines, not free-stream thrust', () => {
    // A turbine slowed below its knee stays in Region 2, so Ct holds at 0.8; push the
    // free stream well above the knee and the upstream machine must read lower.
    const farm = [turbine('up', 0), turbine('down', 5 * D)]
    const { turbines } = evaluateFarm(farm, { ...WESTERLY, freeStreamMs: 16 })
    const up = turbines.find((t) => t.turbineId === 'up')!
    const down = turbines.find((t) => t.turbineId === 'down')!
    expect(up.thrustCoefficient).toBeLessThan(0.8)
    expect(down.thrustCoefficient).toBeGreaterThan(up.thrustCoefficient)
  })

  it('leaves a crosswind row unwaked', () => {
    const row = [turbine('a', 0, 0), turbine('b', 0, 5 * D), turbine('c', 0, 10 * D)]
    const { turbines, wakeLossFraction } = evaluateFarm(row, WESTERLY)
    for (const t of turbines) expect(t.deficit, t.turbineId).toBeCloseTo(0, 9)
    expect(wakeLossFraction).toBeCloseTo(0, 9)
  })

  it('swaps which turbine is waked when the wind reverses', () => {
    const farm = [turbine('west', 0), turbine('east', 7 * D)]

    const fromWest = evaluateFarm(farm, { freeStreamMs: 10, bearingDeg: 270 })
    expect(fromWest.turbines.find((t) => t.turbineId === 'east')!.deficit).toBeGreaterThan(0)
    expect(fromWest.turbines.find((t) => t.turbineId === 'west')!.deficit).toBe(0)

    const fromEast = evaluateFarm(farm, { freeStreamMs: 10, bearingDeg: 90 })
    expect(fromEast.turbines.find((t) => t.turbineId === 'west')!.deficit).toBeGreaterThan(0)
    expect(fromEast.turbines.find((t) => t.turbineId === 'east')!.deficit).toBe(0)
  })

  it('recovers more of the farm in turbulent air', () => {
    const row = [0, 5, 10].map((i) => turbine(`t${i}`, i * D))
    const calm = evaluateFarm(row, { ...WESTERLY, turbulenceIntensity: 0.05 })
    const rough = evaluateFarm(row, { ...WESTERLY, turbulenceIntensity: 0.2 })
    expect(rough.wakeLossFraction).toBeLessThan(calm.wakeLossFraction)
  })

  it('loses less to wakes as spacing widens', () => {
    const tight = evaluateFarm([turbine('a', 0), turbine('b', 4 * D)], WESTERLY)
    const loose = evaluateFarm([turbine('a', 0), turbine('b', 12 * D)], WESTERLY)
    expect(loose.wakeLossFraction).toBeLessThan(tight.wakeLossFraction)
  })

  it('reports a wake loss fraction in [0, 1] and consistent totals', () => {
    const row = [0, 4, 8, 12].map((i) => turbine(`t${i}`, i * D))
    const r = evaluateFarm(row, WESTERLY)
    expect(r.wakeLossFraction).toBeGreaterThan(0)
    expect(r.wakeLossFraction).toBeLessThan(1)
    expect(r.totalPowerKw).toBeCloseTo(
      r.turbines.reduce((s, t) => s + t.powerKw, 0),
      9,
    )
    expect(r.totalPowerKw).toBeLessThan(r.totalFreeStreamPowerKw)
  })

  it('handles an empty farm without dividing by zero', () => {
    const r = evaluateFarm([], WESTERLY)
    expect(r.turbines).toHaveLength(0)
    expect(r.totalPowerKw).toBe(0)
    expect(r.wakeLossFraction).toBe(0)
  })

  it('casts no wake when the whole farm is below cut-in', () => {
    const farm = [turbine('a', 0), turbine('b', 5 * D)]
    const r = evaluateFarm(farm, { ...WESTERLY, freeStreamMs: 2 })
    for (const t of r.turbines) {
      expect(t.thrustCoefficient).toBe(0)
      expect(t.deficit).toBe(0)
      expect(t.powerKw).toBe(0)
    }
    expect(r.wakeLossFraction).toBe(0)
  })
})
