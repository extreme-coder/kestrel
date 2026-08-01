import { describe, expect, it } from 'vitest'

import { HOME_KWH_PER_MONTH, HOURS_PER_YEAR, predict, samplePowerKw } from '../src/lib/prediction.js'
import { REFERENCE_AIR_DENSITY, powerCurveOutputKw } from '../src/lib/power.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { makeSeries } from './helpers/fakeWind.js'

const v112 = getTurbineModel('vestas-v112-3450')!

/**
 * Standard-atmosphere conditions, so the density correction is ~1.0.
 *
 * Not *exactly* 1.0: REFERENCE_AIR_DENSITY is the published datasheet constant 1.225,
 * whereas deriving density from 101325 Pa at 15 °C with R=287.058 gives 1.224988. The
 * 1.8e-5 relative gap is physically meaningless but shows up in strict comparisons, so
 * assertions against curve values use relative tolerance.
 */
const STANDARD = { temperatureC: 15, surfacePressurePa: 101325, relativeHumidity: 0 }

/** Assert `actual` is within `fraction` (relative) of `expected`. */
function toBeWithinFraction(actual: number, expected: number, fraction: number) {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(fraction)
}

describe('samplePowerKw', () => {
  it('leaves wind speed untouched when hub height equals the reference height', () => {
    const series = makeSeries({ hours: 1, windSpeed100m: 10, ...STANDARD })
    const result = samplePowerKw(series.samples[0]!, v112, 100)

    expect(result.alpha).toBeCloseTo(1 / 7, 6)
    expect(result.hubWindSpeedMs).toBeCloseTo(10, 6)
    expect(result.rho).toBeCloseTo(REFERENCE_AIR_DENSITY, 3)
    toBeWithinFraction(result.powerKw, powerCurveOutputKw(v112, 10), 1e-4)
  })

  it('raises hub wind speed above 100 m and lowers it below', () => {
    const series = makeSeries({ hours: 1, windSpeed100m: 10, ...STANDARD })
    const sample = series.samples[0]!

    expect(samplePowerKw(sample, v112, 150).hubWindSpeedMs).toBeGreaterThan(10)
    expect(samplePowerKw(sample, v112, 60).hubWindSpeedMs).toBeLessThan(10)
    // 1/7 power law: 10 · 1.5^(1/7) ≈ 10.596 m/s
    expect(samplePowerKw(sample, v112, 150).hubWindSpeedMs).toBeCloseTo(10.596, 3)
  })

  it('produces more power in cold dense air than in warm thin air', () => {
    const cold = makeSeries({ hours: 1, windSpeed100m: 9, temperatureC: -5, relativeHumidity: 0 })
    const warm = makeSeries({ hours: 1, windSpeed100m: 9, temperatureC: 30, relativeHumidity: 0 })

    const coldPower = samplePowerKw(cold.samples[0]!, v112, 100).powerKw
    const warmPower = samplePowerKw(warm.samples[0]!, v112, 100).powerKw
    expect(coldPower).toBeGreaterThan(warmPower)
  })
})

describe('predict', () => {
  it('computes power, capacity factor and energy consistently', () => {
    const series = makeSeries({ hours: 240, windSpeed100m: 10, ...STANDARD })
    const p = predict(series, v112, { hubHeightM: 100 })

    const expectedKw = powerCurveOutputKw(v112, 10)
    expect(p.meanWindSpeedMs).toBeCloseTo(10, 4)
    toBeWithinFraction(p.meanPowerKw, expectedKw, 1e-4)
    toBeWithinFraction(p.capacityFactor, expectedKw / 3450, 1e-4)

    // Energy figures must be internally consistent, not independently computed.
    expect(p.energyKwhPerYear).toBeCloseTo(p.meanPowerKw * HOURS_PER_YEAR, 3)
    expect(p.energyKwhPerMonth).toBeCloseTo(p.energyKwhPerYear / 12, 3)
    expect(p.homesPowered).toBeCloseTo(p.energyKwhPerMonth / HOME_KWH_PER_MONTH, 6)
  })

  it('reports a capacity factor in [0,1] across a realistic speed range', () => {
    for (const wind of [4, 6, 8, 10, 12, 15, 20]) {
      const p = predict(makeSeries({ hours: 24, windSpeed100m: wind, ...STANDARD }), v112, {
        hubHeightM: 100,
      })
      expect(p.capacityFactor, `${wind} m/s`).toBeGreaterThanOrEqual(0)
      expect(p.capacityFactor, `${wind} m/s`).toBeLessThanOrEqual(1)
    }
  })

  it('yields zero output in dead calm and in a storm above cut-out', () => {
    const calm = predict(makeSeries({ hours: 24, windSpeed100m: 1, ...STANDARD }), v112, {
      hubHeightM: 100,
    })
    expect(calm.meanPowerKw).toBe(0)
    expect(calm.homesPowered).toBe(0)

    const storm = predict(makeSeries({ hours: 24, windSpeed100m: 30, ...STANDARD }), v112, {
      hubHeightM: 100,
    })
    expect(storm.meanPowerKw).toBe(0)
  })

  it('separates months into their own buckets', () => {
    // 31 days of January at 8 m/s, then 28 days of February at 12 m/s.
    const january = makeSeries({
      hours: 31 * 24,
      windSpeed100m: 8,
      startTime: '2019-01-01T00:00',
      ...STANDARD,
    })
    const february = makeSeries({
      hours: 28 * 24,
      windSpeed100m: 12,
      startTime: '2019-02-01T00:00',
      ...STANDARD,
    })
    const series = { ...january, samples: [...january.samples, ...february.samples] }

    const p = predict(series, v112, { hubHeightM: 100 })
    const jan = p.monthly[0]!
    const feb = p.monthly[1]!

    expect(jan.month).toBe(1)
    expect(jan.hours).toBe(31 * 24)
    expect(jan.meanWindSpeedMs).toBeCloseTo(8, 4)
    expect(feb.hours).toBe(28 * 24)
    expect(feb.meanWindSpeedMs).toBeCloseTo(12, 4)
    expect(feb.meanPowerKw).toBeGreaterThan(jan.meanPowerKw)

    // January is longer than February, so equal power would still mean more energy.
    expect(jan.energyKwh).toBeCloseTo(jan.meanPowerKw * 31 * 24, 3)
  })

  it('always returns twelve months, zeroed where there is no data', () => {
    const p = predict(makeSeries({ hours: 24, startTime: '2019-03-01T00:00', ...STANDARD }), v112, {
      hubHeightM: 100,
    })

    expect(p.monthly).toHaveLength(12)
    expect(p.monthly.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(p.monthly[2]!.hours).toBe(24)
    expect(p.monthly[0]!.hours).toBe(0)
    expect(p.monthly[0]!.energyKwh).toBe(0)
  })

  it('weights the annual mean by the hours actually observed', () => {
    // Half the hours calm, half at 10 m/s: the mean must land halfway, not at 10.
    const series = makeSeries({
      hours: 200,
      windSpeed100m: (h) => (h < 100 ? 0.5 : 10),
      ...STANDARD,
    })
    const p = predict(series, v112, { hubHeightM: 100 })
    toBeWithinFraction(p.meanPowerKw, powerCurveOutputKw(v112, 10) / 2, 1e-4)
  })

  it('rejects an empty series rather than dividing by zero', () => {
    const empty = { ...makeSeries({ hours: 1 }), samples: [] }
    expect(() => predict(empty, v112, { hubHeightM: 100 })).toThrow(RangeError)
  })

  it('carries the resolved grid cell through, not the requested point', () => {
    const series = makeSeries({ hours: 24, latitude: 50.65, longitude: -0.32, elevationM: 7 })
    const p = predict(series, v112, { hubHeightM: 100 })
    expect(p.latitude).toBe(50.65)
    expect(p.longitude).toBe(-0.32)
    expect(p.elevationM).toBe(7)
  })

  it('honours the IEC density correction when asked', () => {
    const dense = makeSeries({ hours: 24, windSpeed100m: 12.5, temperatureC: -10, ...{ surfacePressurePa: 103000, relativeHumidity: 0 } })
    const linear = predict(dense, v112, { hubHeightM: 100, densityCorrection: 'linear' })
    const iec = predict(dense, v112, { hubHeightM: 100, densityCorrection: 'iec' })

    // At rated speed in dense air, only the linear method exceeds nameplate.
    expect(linear.meanPowerKw).toBeGreaterThan(3450)
    expect(iec.meanPowerKw).toBeCloseTo(3450, 6)
    expect(iec.capacityFactor).toBeLessThanOrEqual(1)
  })
})
