/**
 * Turns an hourly wind series into the numbers the original app displayed: mean wind
 * speed, mean power, monthly breakdowns, and homes powered.
 *
 * Units are stated explicitly on every field. The science-fair report labels its
 * validation figures "kWh/month" at magnitudes that only make sense as MWh/month, and
 * that ambiguity is the single easiest way to be wrong by a factor of a thousand.
 */

import type { DensityCorrection } from './power.js'
import {
  airDensity,
  densityCorrectedPowerKw,
  extrapolateWindSpeed,
  shearExponent,
} from './power.js'
import type { WindSample, WindSeries } from './openmeteo.js'
import type { TurbineModel } from './turbines.js'

/** Monthly consumption of an average home, per the report. */
export const HOME_KWH_PER_MONTH = 886

/** Height of Open-Meteo's lower and upper wind fields, in metres. */
const LOWER_HEIGHT_M = 10
const UPPER_HEIGHT_M = 100

/** Mean days per Gregorian month, averaged over the 400-year cycle for February. */
const DAYS_IN_MONTH = [31, 28.2425, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Hours in a mean Gregorian year (365.2425 × 24). */
export const HOURS_PER_YEAR = 8765.82

export interface MonthlyStat {
  /** Calendar month, 1–12. */
  month: number
  meanWindSpeedMs: number
  meanPowerKw: number
  /** Energy an average instance of this month would yield, kWh. */
  energyKwh: number
  /** Hours of source data behind this month. */
  hours: number
}

export interface PredictionOptions {
  hubHeightM: number
  densityCorrection?: DensityCorrection
}

export interface Prediction {
  latitude: number
  longitude: number
  elevationM: number
  turbineId: string
  hubHeightM: number
  /** Mean wind speed at hub height, m/s. */
  meanWindSpeedMs: number
  /** Mean wind speed as reported at 100 m, m/s — useful for sanity-checking shear. */
  meanWindSpeed100mMs: number
  meanShearExponent: number
  meanAirDensityKgM3: number
  /** Mean electrical power output, kW. */
  meanPowerKw: number
  /** Mean power as a fraction of rated power, 0–1. */
  capacityFactor: number
  /** Energy in a mean month, kWh. */
  energyKwhPerMonth: number
  /** Energy in a mean year, kWh. */
  energyKwhPerYear: number
  /** Homes this turbine could supply, at 886 kWh/month each. */
  homesPowered: number
  monthly: MonthlyStat[]
  /** Hours of source data behind the prediction. */
  hours: number
}

/** Power output for a single hour, in kW, with the full physics chain applied. */
export function samplePowerKw(
  sample: WindSample,
  model: TurbineModel,
  hubHeightM: number,
  method: DensityCorrection = 'linear',
): { powerKw: number; hubWindSpeedMs: number; alpha: number; rho: number } {
  const alpha = shearExponent(
    sample.windSpeed10mMs,
    LOWER_HEIGHT_M,
    sample.windSpeed100mMs,
    UPPER_HEIGHT_M,
  )

  // Extrapolate from 100 m rather than 10 m: it is the closer of the two to any modern
  // hub height, so any error in α is multiplied by a smaller height ratio.
  const hubWindSpeedMs = extrapolateWindSpeed(
    sample.windSpeed100mMs,
    UPPER_HEIGHT_M,
    hubHeightM,
    alpha,
  )

  const rho = airDensity({
    pressurePa: sample.surfacePressurePa,
    temperatureC: sample.temperatureC,
    relativeHumidity: sample.relativeHumidity,
  })

  return {
    powerKw: densityCorrectedPowerKw(model, hubWindSpeedMs, rho, method),
    hubWindSpeedMs,
    alpha,
    rho,
  }
}

export function predict(
  series: WindSeries,
  model: TurbineModel,
  options: PredictionOptions,
): Prediction {
  const { hubHeightM, densityCorrection = 'linear' } = options

  const buckets = Array.from({ length: 12 }, () => ({
    speedSum: 0,
    powerSum: 0,
    hours: 0,
  }))

  let speedSum = 0
  let speed100Sum = 0
  let powerSum = 0
  let alphaSum = 0
  let rhoSum = 0

  for (const sample of series.samples) {
    const { powerKw, hubWindSpeedMs, alpha, rho } = samplePowerKw(
      sample,
      model,
      hubHeightM,
      densityCorrection,
    )

    speedSum += hubWindSpeedMs
    speed100Sum += sample.windSpeed100mMs
    powerSum += powerKw
    alphaSum += alpha
    rhoSum += rho

    // Timestamps are "YYYY-MM-DDTHH:MM"; slicing beats constructing a Date per hour.
    const month = Number(sample.time.slice(5, 7))
    const bucket = buckets[month - 1]
    if (bucket) {
      bucket.speedSum += hubWindSpeedMs
      bucket.powerSum += powerKw
      bucket.hours++
    }
  }

  const hours = series.samples.length
  if (hours === 0) {
    throw new RangeError('cannot predict from an empty wind series')
  }

  const meanPowerKw = powerSum / hours

  const monthly: MonthlyStat[] = buckets.map((bucket, index) => {
    const monthHours = 24 * (DAYS_IN_MONTH[index] ?? 30)
    const meanPower = bucket.hours > 0 ? bucket.powerSum / bucket.hours : 0
    return {
      month: index + 1,
      meanWindSpeedMs: bucket.hours > 0 ? bucket.speedSum / bucket.hours : 0,
      meanPowerKw: meanPower,
      energyKwh: meanPower * monthHours,
      hours: bucket.hours,
    }
  })

  const energyKwhPerYear = meanPowerKw * HOURS_PER_YEAR
  const energyKwhPerMonth = energyKwhPerYear / 12

  return {
    latitude: series.latitude,
    longitude: series.longitude,
    elevationM: series.elevationM,
    turbineId: model.id,
    hubHeightM,
    meanWindSpeedMs: speedSum / hours,
    meanWindSpeed100mMs: speed100Sum / hours,
    meanShearExponent: alphaSum / hours,
    meanAirDensityKgM3: rhoSum / hours,
    meanPowerKw,
    capacityFactor: meanPowerKw / model.ratedPowerKw,
    energyKwhPerMonth,
    energyKwhPerYear,
    homesPowered: energyKwhPerMonth / HOME_KWH_PER_MONTH,
    monthly,
    hours,
  }
}
