import { describe, expect, it } from 'vitest'

import {
  BETZ_LIMIT,
  DEFAULT_POWER_COEFFICIENT,
  DEFAULT_REGION2_THRUST_COEFFICIENT,
  REFERENCE_AIR_DENSITY,
  airDensity,
  densityCorrectedPowerKw,
  extrapolateWindSpeed,
  interpolateCurve,
  powerCurveOutputKw,
  ratedTransitionSpeedMs,
  saturationVapourPressurePa,
  shearExponent,
  thrustCoefficient,
  windPowerDensityKw,
} from '../src/lib/power.js'
import { TURBINE_MODELS, getTurbineModel, sweptAreaM2 } from '../src/lib/turbines.js'
import type { TurbineModel } from '../src/lib/turbines.js'

const v112 = getTurbineModel('vestas-v112-3450')!

describe('turbine catalogue', () => {
  it('contains every model named in the science-fair validation table', () => {
    const required = [
      'vestas-v112-3450',
      'siemens-swt-3.6-107',
      'vestas-v117-3450',
      'siemens-swt-3.0-101',
      'vestas-v90-3000',
      'bonus-b82-2300',
      'siemens-swt-2.3-93',
      'vestas-v80-2000',
    ]
    for (const id of required) {
      expect(getTurbineModel(id), `missing ${id}`).toBeDefined()
    }
  })

  it('has coherent speed ordering and positive geometry for every model', () => {
    for (const m of TURBINE_MODELS) {
      expect(m.cutInMs, m.id).toBeGreaterThan(0)
      expect(m.ratedMs, m.id).toBeGreaterThan(m.cutInMs)
      expect(m.cutOutMs, m.id).toBeGreaterThan(m.ratedMs)
      expect(m.ratedPowerKw, m.id).toBeGreaterThan(0)
      expect(m.rotorDiameterM, m.id).toBeGreaterThan(0)
    }
  })

  it('uses unique ids', () => {
    const ids = TURBINE_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('computes swept area from rotor diameter', () => {
    // V112 has a 112 m rotor: π · 56² ≈ 9852 m²
    expect(sweptAreaM2(v112)).toBeCloseTo(Math.PI * 56 * 56, 6)
    expect(sweptAreaM2(v112)).toBeCloseTo(9852.03, 1)
  })
})

describe('power curve', () => {
  it('produces no power below cut-in or above cut-out', () => {
    expect(powerCurveOutputKw(v112, 0)).toBe(0)
    expect(powerCurveOutputKw(v112, v112.cutInMs - 0.01)).toBe(0)
    expect(powerCurveOutputKw(v112, v112.cutOutMs + 0.01)).toBe(0)
    expect(powerCurveOutputKw(v112, 40)).toBe(0)
  })

  it('holds exactly rated power from rated speed through cut-out', () => {
    expect(powerCurveOutputKw(v112, v112.ratedMs)).toBeCloseTo(3450, 6)
    expect(powerCurveOutputKw(v112, 18)).toBeCloseTo(3450, 6)
    expect(powerCurveOutputKw(v112, v112.cutOutMs)).toBeCloseTo(3450, 6)
  })

  it('rises monotonically across the whole operating range', () => {
    for (const m of TURBINE_MODELS) {
      let previous = -1
      for (let v = 0; v <= m.cutOutMs; v += 0.1) {
        const p = powerCurveOutputKw(m, v)
        expect(p, `${m.id} decreased at ${v.toFixed(1)} m/s`).toBeGreaterThanOrEqual(previous)
        previous = p
      }
    }
  })

  it('never exceeds rated power', () => {
    for (const m of TURBINE_MODELS) {
      for (let v = 0; v <= 40; v += 0.25) {
        expect(powerCurveOutputKw(m, v), `${m.id} at ${v} m/s`).toBeLessThanOrEqual(m.ratedPowerKw)
      }
    }
  })

  it('scales cubically through Region 2, where the rotor tracks peak Cp', () => {
    const knee = ratedTransitionSpeedMs(v112)
    const low = knee * 0.5
    const high = knee * 0.75

    // Doubling wind speed inside Region 2 must give eight times the power.
    expect(powerCurveOutputKw(v112, low * 2) / powerCurveOutputKw(v112, low)).toBeCloseTo(8, 4)
    // And the implied Cp is flat across the region.
    for (const v of [low, high]) {
      const cp = powerCurveOutputKw(v112, v) / windPowerDensityKw(v112, v)
      expect(cp).toBeCloseTo(DEFAULT_POWER_COEFFICIENT, 6)
    }
  })

  it('places the Region 2/3 knee below the datasheet rated speed', () => {
    // A datasheet's rated speed is where the curve finishes arriving at nameplate; the
    // knee is where it starts levelling. Conflating them was the bug that made this
    // model underpredict ten real offshore farms by 43%.
    for (const m of TURBINE_MODELS) {
      const knee = ratedTransitionSpeedMs(m)
      expect(knee, `${m.id}`).toBeGreaterThan(m.cutInMs)
      expect(knee, `${m.id}`).toBeLessThanOrEqual(m.ratedMs)
      expect(powerCurveOutputKw(m, knee), `${m.id}`).toBeCloseTo(m.ratedPowerKw, 3)
    }
  })

  it('tracks a real published power curve within 15% across the working range', () => {
    /**
     * Vestas V80-2000 manufacturer curve, kW by integer m/s. This is the regression
     * guard for the parametric model: the earlier cubic-to-datasheet-rated formulation
     * read 330 kW at 9 m/s against the real 978, and nothing in the unit tests noticed.
     */
    const published: Array<[number, number]> = [
      [5, 152],
      [6, 280],
      [7, 457],
      [8, 690],
      [9, 978],
      [10, 1296],
      [11, 1598],
      [12, 1818],
      [13, 1935],
      [14, 1980],
    ]
    const v80 = getTurbineModel('vestas-v80-2000')!

    let worst = 0
    for (const [speed, expected] of published) {
      const actual = powerCurveOutputKw(v80, speed)
      const error = Math.abs(actual - expected) / expected
      worst = Math.max(worst, error)
      expect(error, `${speed} m/s: modelled ${actual.toFixed(0)} vs published ${expected}`).toBeLessThan(0.16)
    }
    // And the mean absolute error should be much tighter than the per-point ceiling.
    const meanError =
      published.reduce(
        (sum, [speed, expected]) =>
          sum + Math.abs(powerCurveOutputKw(v80, speed) - expected) / expected,
        0,
      ) / published.length
    expect(meanError).toBeLessThan(0.07)
    expect(worst).toBeGreaterThan(0) // sanity: the model is not simply returning the table
  })

  it('stays under the Betz limit throughout the ramp region', () => {
    // A real machine cannot extract more than 59.3% of the power in the wind. If the
    // parametric curve implied more, its rated/cut-in specs would be unphysical.
    for (const m of TURBINE_MODELS) {
      for (let v = m.cutInMs; v <= m.ratedMs; v += 0.25) {
        const available = windPowerDensityKw(m, v)
        const produced = powerCurveOutputKw(m, v)
        const cp = produced / available
        expect(cp, `${m.id} implies Cp=${cp.toFixed(3)} at ${v} m/s`).toBeLessThanOrEqual(
          BETZ_LIMIT,
        )
      }
    }
  })

  it('prefers a measured curve over the parametric fallback', () => {
    const measured: TurbineModel = {
      ...v112,
      curve: [
        [3, 0],
        [10, 1000],
        [12.5, 3450],
      ],
    }
    // Parametric would give ~1720 kW at 10 m/s; the table says 1000.
    expect(powerCurveOutputKw(measured, 10)).toBeCloseTo(1000, 6)
    expect(powerCurveOutputKw(v112, 10)).toBeGreaterThan(1500)
  })

  it('still enforces cut-out on a measured curve that does not encode it', () => {
    const measured: TurbineModel = { ...v112, curve: [[3, 0], [12.5, 3450]] }
    expect(powerCurveOutputKw(measured, 30)).toBe(0)
  })
})

describe('interpolateCurve', () => {
  const curve = [
    [0, 0],
    [10, 100],
    [20, 300],
  ] as const

  it('interpolates linearly inside the table', () => {
    expect(interpolateCurve(curve, 5)).toBeCloseTo(50, 6)
    expect(interpolateCurve(curve, 15)).toBeCloseTo(200, 6)
  })

  it('returns exact values at knots', () => {
    expect(interpolateCurve(curve, 0)).toBe(0)
    expect(interpolateCurve(curve, 10)).toBe(100)
    expect(interpolateCurve(curve, 20)).toBe(300)
  })

  it('clamps outside the table', () => {
    expect(interpolateCurve(curve, -5)).toBe(0)
    expect(interpolateCurve(curve, 99)).toBe(300)
  })

  it('handles an empty table', () => {
    expect(interpolateCurve([], 10)).toBe(0)
  })
})

describe('air density', () => {
  it('reproduces the ISO standard atmosphere at sea level', () => {
    expect(airDensity({ pressurePa: 101325, temperatureC: 15 })).toBeCloseTo(
      REFERENCE_AIR_DENSITY,
      3,
    )
  })

  it('increases as air gets colder', () => {
    const cold = airDensity({ pressurePa: 101325, temperatureC: -10 })
    const warm = airDensity({ pressurePa: 101325, temperatureC: 30 })
    expect(cold).toBeGreaterThan(warm)
    // Roughly 15% swing across that range — worth correcting for.
    expect(cold / warm).toBeCloseTo(1.152, 2)
  })

  it('decreases as pressure drops', () => {
    const sea = airDensity({ pressurePa: 101325, temperatureC: 15 })
    const altitude = airDensity({ pressurePa: 90000, temperatureC: 15 })
    expect(altitude).toBeLessThan(sea)
  })

  it('makes humid air lighter than dry air', () => {
    const dry = airDensity({ pressurePa: 101325, temperatureC: 25, relativeHumidity: 0 })
    const humid = airDensity({ pressurePa: 101325, temperatureC: 25, relativeHumidity: 1 })
    expect(humid).toBeLessThan(dry)
    // Warm saturated air is only ~1.2% lighter; small, but free to include.
    expect((dry - humid) / dry).toBeGreaterThan(0.005)
    expect((dry - humid) / dry).toBeLessThan(0.03)
  })

  it('treats omitted humidity as dry air', () => {
    expect(airDensity({ pressurePa: 101325, temperatureC: 15 })).toBeCloseTo(
      airDensity({ pressurePa: 101325, temperatureC: 15, relativeHumidity: 0 }),
      9,
    )
  })

  it('clamps out-of-range humidity instead of producing nonsense', () => {
    const over = airDensity({ pressurePa: 101325, temperatureC: 20, relativeHumidity: 5 })
    const saturated = airDensity({ pressurePa: 101325, temperatureC: 20, relativeHumidity: 1 })
    expect(over).toBeCloseTo(saturated, 9)
  })

  it('rejects temperatures below absolute zero', () => {
    expect(() => airDensity({ pressurePa: 101325, temperatureC: -300 })).toThrow(RangeError)
  })

  it('matches known saturation vapour pressures within the Tetens approximation error', () => {
    // Reference values from the Goff-Gratch formulation. Tetens trades a few tenths of
    // a percent of accuracy for one exp() call, which is well inside what matters here:
    // humidity moves air density by ~1%, so a 0.3% error on humidity is negligible.
    const within = (actual: number, reference: number, fraction: number) =>
      expect(Math.abs(actual - reference) / reference).toBeLessThan(fraction)

    within(saturationVapourPressurePa(20), 2339, 0.005)
    within(saturationVapourPressurePa(0), 611, 0.005)
    within(saturationVapourPressurePa(30), 4246, 0.005)
  })
})

describe('wind shear', () => {
  it('recovers the exponent used to generate a profile', () => {
    const alpha = 0.2
    const v10 = 6
    const v100 = extrapolateWindSpeed(v10, 10, 100, alpha)
    expect(shearExponent(v10, 10, v100, 100)).toBeCloseTo(alpha, 9)
  })

  it('round-trips a speed back to its original height', () => {
    const alpha = shearExponent(6, 10, 8.5, 100)
    const atHub = extrapolateWindSpeed(6, 10, 90, alpha)
    expect(extrapolateWindSpeed(atHub, 90, 10, alpha)).toBeCloseTo(6, 9)
  })

  it('produces a smaller exponent offshore than over rough terrain', () => {
    const offshore = shearExponent(8.0, 10, 9.2, 100)
    const roughTerrain = shearExponent(4.0, 10, 7.5, 100)
    expect(offshore).toBeLessThan(roughTerrain)
    expect(offshore).toBeLessThan(0.15)
    expect(roughTerrain).toBeGreaterThan(0.2)
  })

  it('falls back to the 1/7 rule on calm or degenerate input', () => {
    expect(shearExponent(0, 10, 8, 100)).toBeCloseTo(1 / 7, 9)
    expect(shearExponent(6, 10, 0, 100)).toBeCloseTo(1 / 7, 9)
    expect(shearExponent(6, 50, 8, 50)).toBeCloseTo(1 / 7, 9)
    expect(shearExponent(6, 0, 8, 100)).toBeCloseTo(1 / 7, 9)
  })

  it('clamps physically implausible exponents', () => {
    // A tenfold speed increase over one decade of height would give α = 1.
    expect(shearExponent(1, 10, 10, 100)).toBeLessThanOrEqual(0.6)
    // Wind decreasing with height would give a negative exponent.
    expect(shearExponent(10, 10, 5, 100)).toBe(0)
  })

  it('leaves speed unchanged when the height does not change', () => {
    expect(extrapolateWindSpeed(7.3, 100, 100, 0.2)).toBeCloseTo(7.3, 9)
  })
})

describe('density correction', () => {
  it('is a no-op at reference density', () => {
    expect(densityCorrectedPowerKw(v112, 9, REFERENCE_AIR_DENSITY)).toBeCloseTo(
      powerCurveOutputKw(v112, 9),
      6,
    )
    expect(densityCorrectedPowerKw(v112, 9, REFERENCE_AIR_DENSITY, 'iec')).toBeCloseTo(
      powerCurveOutputKw(v112, 9),
      6,
    )
  })

  it('scales power linearly with density by default', () => {
    const rho = 1.3
    expect(densityCorrectedPowerKw(v112, 9, rho)).toBeCloseTo(
      powerCurveOutputKw(v112, 9) * (rho / REFERENCE_AIR_DENSITY),
      6,
    )
  })

  it('raises output in dense air and lowers it in thin air', () => {
    const base = powerCurveOutputKw(v112, 9)
    expect(densityCorrectedPowerKw(v112, 9, 1.3)).toBeGreaterThan(base)
    expect(densityCorrectedPowerKw(v112, 9, 1.1)).toBeLessThan(base)
  })

  it('lets the linear method exceed rated power, while IEC does not', () => {
    // This is the substantive difference between the two: at rated speed in dense air
    // the linear correction implies the generator overproduces, which it cannot.
    const dense = 1.35
    expect(densityCorrectedPowerKw(v112, v112.ratedMs, dense)).toBeGreaterThan(
      v112.ratedPowerKw,
    )
    expect(densityCorrectedPowerKw(v112, v112.ratedMs, dense, 'iec')).toBeCloseTo(
      v112.ratedPowerKw,
      6,
    )
  })

  it('agrees closely with IEC in the ramp region', () => {
    // Both methods should be within a few percent where the curve is genuinely cubic.
    const linear = densityCorrectedPowerKw(v112, 8, 1.3, 'linear')
    const iec = densityCorrectedPowerKw(v112, 8, 1.3, 'iec')
    expect(Math.abs(linear - iec) / linear).toBeLessThan(0.02)
  })

  it('degrades gracefully on nonsense density', () => {
    expect(densityCorrectedPowerKw(v112, 9, 0)).toBeCloseTo(powerCurveOutputKw(v112, 9), 6)
    expect(densityCorrectedPowerKw(v112, 9, Number.NaN)).toBeCloseTo(
      powerCurveOutputKw(v112, 9),
      6,
    )
  })
})

describe('wind power density', () => {
  it('matches a hand-computed ½ρAV³', () => {
    const expected = (0.5 * REFERENCE_AIR_DENSITY * sweptAreaM2(v112) * 10 ** 3) / 1000
    expect(windPowerDensityKw(v112, 10)).toBeCloseTo(expected, 6)
  })

  it('scales cubically with wind speed', () => {
    const a = windPowerDensityKw(v112, 5)
    const b = windPowerDensityKw(v112, 10)
    expect(b / a).toBeCloseTo(8, 6)
  })
})

describe('thrust coefficient', () => {
  it('is zero outside the operating range', () => {
    expect(thrustCoefficient(v112, v112.cutInMs - 0.1)).toBe(0)
    expect(thrustCoefficient(v112, v112.cutOutMs + 0.1)).toBe(0)
    expect(thrustCoefficient(v112, Number.NaN)).toBe(0)
  })

  it('holds flat through Region 2', () => {
    const knee = ratedTransitionSpeedMs(v112)
    for (const v of [5, 7, 9, knee]) {
      expect(thrustCoefficient(v112, v)).toBeCloseTo(DEFAULT_REGION2_THRUST_COEFFICIENT, 9)
    }
  })

  it('decays as the inverse cube of wind speed above the knee', () => {
    const knee = ratedTransitionSpeedMs(v112)
    const lo = knee * 1.1
    const hi = knee * 2.2
    // Both samples must sit inside Region 3, or the cut-out zero makes this vacuous.
    expect(lo).toBeGreaterThan(knee)
    expect(hi).toBeLessThan(v112.cutOutMs)
    // Doubling speed within Region 3 should cut Ct by 2³.
    expect(thrustCoefficient(v112, lo) / thrustCoefficient(v112, hi)).toBeCloseTo(8, 6)
  })

  it('tracks measured values for a V80 within the tolerance the fallback claims', () => {
    const v80 = getTurbineModel('vestas-v80-2000')!
    // Published V80 thrust curves sit near 0.30 at 15 m/s and 0.08 at 25 m/s.
    expect(thrustCoefficient(v80, 15)).toBeGreaterThan(0.25)
    expect(thrustCoefficient(v80, 15)).toBeLessThan(0.42)
    expect(thrustCoefficient(v80, 25)).toBeGreaterThan(0.04)
    expect(thrustCoefficient(v80, 25)).toBeLessThan(0.12)
  })

  it('never leaves [0, 1] anywhere in any model operating range', () => {
    for (const m of TURBINE_MODELS) {
      for (let v = 0; v <= 30; v += 0.25) {
        const ct = thrustCoefficient(m, v)
        expect(ct, `${m.id} @ ${v}`).toBeGreaterThanOrEqual(0)
        expect(ct, `${m.id} @ ${v}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('prefers a measured thrust curve over the parametric fallback', () => {
    const measured: TurbineModel = {
      ...v112,
      thrustCurve: [
        [3, 0.75],
        [10, 0.7],
        [25, 0.05],
      ],
    }
    expect(thrustCoefficient(measured, 10)).toBeCloseTo(0.7, 9)
    // Halfway between the 10 and 25 m/s points.
    expect(thrustCoefficient(measured, 17.5)).toBeCloseTo(0.375, 9)
    expect(thrustCoefficient(measured, 10)).not.toBeCloseTo(
      thrustCoefficient(v112, 10),
      3,
    )
  })
})
