/**
 * The wind-to-power physics, reimplemented from the Windsim science-fair report.
 *
 * Chain, per hourly sample:
 *   1. extrapolate the reanalysis wind speed from its measurement height to hub height
 *   2. compute local air density from pressure, temperature and humidity
 *   3. read power off the turbine's power curve at hub-height wind speed
 *   4. correct that power for the difference between local and reference air density
 */

import type { TurbineModel } from './turbines.js'
import { sweptAreaM2 } from './turbines.js'

/**
 * ISO 2533 standard sea-level air density (15 °C, 101325 Pa). Power curves are
 * published against this value.
 *
 * The report states the reference density as `1000 kg/m^3`. That is a typo — 1000 kg/m³
 * is the density of water, and the accompanying correction formula only makes sense
 * against the standard atmosphere. 1.225 is the intended value.
 */
export const REFERENCE_AIR_DENSITY = 1.225

/** Specific gas constant for dry air, J/(kg·K). */
const R_DRY_AIR = 287.058
/** Specific gas constant for water vapour, J/(kg·K). */
const R_WATER_VAPOUR = 461.495

export interface AirDensityInput {
  pressurePa: number
  temperatureC: number
  /** Relative humidity in [0, 1]. Omit for a dry-air approximation. */
  relativeHumidity?: number
}

/**
 * Saturation vapour pressure in Pa via the Tetens/Magnus approximation.
 * Accurate to well under 1% over the range of temperatures a wind farm sees.
 */
export function saturationVapourPressurePa(temperatureC: number): number {
  return 610.94 * Math.exp((17.625 * temperatureC) / (temperatureC + 243.04))
}

/**
 * Moist air density in kg/m³. Humid air is *less* dense than dry air at the same
 * pressure and temperature, because a water molecule is lighter than the N₂/O₂ it
 * displaces — so ignoring humidity biases power predictions slightly high.
 */
export function airDensity({
  pressurePa,
  temperatureC,
  relativeHumidity,
}: AirDensityInput): number {
  const tempK = temperatureC + 273.15
  if (tempK <= 0) throw new RangeError(`temperature below absolute zero: ${temperatureC} °C`)

  if (relativeHumidity === undefined) {
    return pressurePa / (R_DRY_AIR * tempK)
  }

  const rh = Math.min(Math.max(relativeHumidity, 0), 1)
  const vapourPa = rh * saturationVapourPressurePa(temperatureC)
  const dryPa = pressurePa - vapourPa
  return dryPa / (R_DRY_AIR * tempK) + vapourPa / (R_WATER_VAPOUR * tempK)
}

/**
 * Wind shear exponent α of the power law v(h) = v_ref · (h / h_ref)^α, fitted from two
 * measured heights.
 *
 * Deriving α from the data beats assuming the textbook 1/7 ≈ 0.143: real α ranges from
 * about 0.10 offshore to 0.25+ over rough terrain, and hub-height speed enters power
 * roughly cubically, so the assumption is expensive.
 *
 * Returns a value clamped to [0, 0.6]; degenerate inputs (calm, zero height ratio)
 * fall back to 1/7.
 */
export function shearExponent(
  speedLowMs: number,
  heightLowM: number,
  speedHighMs: number,
  heightHighM: number,
): number {
  const DEFAULT = 1 / 7
  if (speedLowMs <= 0.1 || speedHighMs <= 0.1) return DEFAULT
  if (heightLowM <= 0 || heightHighM <= 0 || heightLowM === heightHighM) return DEFAULT

  const alpha = Math.log(speedHighMs / speedLowMs) / Math.log(heightHighM / heightLowM)
  if (!Number.isFinite(alpha)) return DEFAULT
  return Math.min(Math.max(alpha, 0), 0.6)
}

/** Apply the power law to move a wind speed from one height to another. */
export function extrapolateWindSpeed(
  speedMs: number,
  fromHeightM: number,
  toHeightM: number,
  alpha: number,
): number {
  if (fromHeightM <= 0 || toHeightM <= 0) return speedMs
  return speedMs * Math.pow(toHeightM / fromHeightM, alpha)
}

/** Linear interpolation over an ascending [speed, power] table. */
export function interpolateCurve(
  curve: ReadonlyArray<readonly [number, number]>,
  windSpeedMs: number,
): number {
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (!first || !last) return 0
  if (windSpeedMs <= first[0]) return first[1]
  if (windSpeedMs >= last[0]) return last[1]

  for (let i = 1; i < curve.length; i++) {
    const lo = curve[i - 1]
    const hi = curve[i]
    if (!lo || !hi) break
    if (windSpeedMs <= hi[0]) {
      const span = hi[0] - lo[0]
      if (span <= 0) return hi[1]
      const t = (windSpeedMs - lo[0]) / span
      return lo[1] + t * (hi[1] - lo[1])
    }
  }
  return last[1]
}

/**
 * Peak power coefficient of a modern three-bladed rotor.
 *
 * Betz caps extraction at 16/27 ≈ 0.593; real machines reach 0.44–0.50 once blade drag,
 * tip losses and drivetrain efficiency are accounted for. 0.45 is the standard
 * assumption for utility-scale turbines and is what a datasheet curve implies through
 * the mid-range.
 */
export const DEFAULT_POWER_COEFFICIENT = 0.45

/**
 * Wind speed at which constant-Cp extraction first reaches rated power — the knee
 * between Region 2 (tracking maximum Cp) and Region 3 (pitching to hold rated).
 *
 * Derived rather than read off the datasheet, because a datasheet's "rated wind speed"
 * is where the curve *finishes* arriving at nameplate, not where it starts levelling.
 * The Vestas V80-2000 is listed at 16 m/s but is already at 91% of rated by 12 m/s.
 */
export function ratedTransitionSpeedMs(model: TurbineModel): number {
  const cp = model.powerCoefficient ?? DEFAULT_POWER_COEFFICIENT
  const denominator = cp * 0.5 * REFERENCE_AIR_DENSITY * sweptAreaM2(model)
  if (denominator <= 0) return model.ratedMs
  return Math.cbrt((model.ratedPowerKw * 1000) / denominator)
}

/**
 * Power in kW at a given hub-height wind speed, at reference air density.
 *
 * Uses the model's measured `curve` when present. Otherwise falls back to the standard
 * two-region parametric model:
 *
 *   Region 2 — the rotor tracks its maximum power coefficient, so output follows
 *              P = Cp · ½ρAv³ and rises cubically with wind speed.
 *   Region 3 — the generator is saturated; the blades pitch to shed the surplus and
 *              output holds flat at rated up to cut-out.
 *
 * An earlier version ramped cubically from cut-in all the way to the *datasheet* rated
 * speed. That is a materially different curve, and a much worse one: for a V80-2000 it
 * implies Cp = 0.15 at 9 m/s against a real ≈0.44, and it underpredicted output at ten
 * real offshore farms by 43% on average. See docs/VALIDATION.md.
 */
export function powerCurveOutputKw(model: TurbineModel, windSpeedMs: number): number {
  if (!Number.isFinite(windSpeedMs) || windSpeedMs < model.cutInMs) return 0
  if (windSpeedMs > model.cutOutMs) return 0

  if (model.curve && model.curve.length > 0) {
    return Math.max(0, interpolateCurve(model.curve, windSpeedMs))
  }

  const cp = model.powerCoefficient ?? DEFAULT_POWER_COEFFICIENT
  const aerodynamicKw =
    (cp * 0.5 * REFERENCE_AIR_DENSITY * sweptAreaM2(model) * windSpeedMs ** 3) / 1000

  return Math.min(model.ratedPowerKw, aerodynamicKw)
}

export type DensityCorrection = 'linear' | 'iec'

/**
 * Power curve output corrected for local air density.
 *
 * - `linear` (default) scales power by ρ/ρ_ref. This is what the report specifies, and
 *   is exact in the region where the turbine is extracting all it can from the wind.
 * - `iec` follows IEC 61400-12-1 and instead corrects the *wind speed* by
 *   (ρ/ρ_ref)^(1/3) before reading the curve. For a pitch-regulated turbine this is the
 *   more defensible method, because it does not scale the flat rated region — a turbine
 *   at rated power stays at rated power in dense air, it does not exceed its generator.
 */
export function densityCorrectedPowerKw(
  model: TurbineModel,
  windSpeedMs: number,
  airDensityKgM3: number,
  method: DensityCorrection = 'linear',
): number {
  const ratio = airDensityKgM3 / REFERENCE_AIR_DENSITY
  if (!Number.isFinite(ratio) || ratio <= 0) return powerCurveOutputKw(model, windSpeedMs)

  if (method === 'iec') {
    return powerCurveOutputKw(model, windSpeedMs * Math.cbrt(ratio))
  }
  return powerCurveOutputKw(model, windSpeedMs) * ratio
}

/**
 * Theoretical power in the wind through the rotor disc, P = ½ρAV³, in kW.
 *
 * This is the textbook formula the report opens with. It is not what the turbine
 * produces — Betz caps extraction at 16/27 ≈ 59.3% and real machines reach 45–50% —
 * but it bounds the power curve and is useful as a sanity check.
 */
export function windPowerDensityKw(
  model: TurbineModel,
  windSpeedMs: number,
  airDensityKgM3: number = REFERENCE_AIR_DENSITY,
): number {
  return (0.5 * airDensityKgM3 * sweptAreaM2(model) * windSpeedMs ** 3) / 1000
}

/** Betz limit: the maximum fraction of wind power any rotor can extract. */
export const BETZ_LIMIT = 16 / 27

/**
 * Thrust coefficient in Region 2, where the rotor tracks maximum power extraction.
 *
 * This is an *empirical* value. The tempting derivation — actuator-disc momentum theory,
 * where Cp = 4a(1-a)² and Ct = 4a(1-a) — is wrong here, and wrong in a direction that
 * matters: Cp = 0.45 solves to a ≈ 0.159 and therefore Ct ≈ 0.53, against a measured
 * ≈0.8 for real utility-scale machines.
 *
 * The reason is that `DEFAULT_POWER_COEFFICIENT` is an *electrical* Cp. Drivetrain
 * losses, blade drag and tip losses all destroy power without removing any additional
 * momentum from the flow, so inverting them through momentum theory under-reads the
 * thrust. Anchor the level empirically instead; momentum theory is still trusted for the
 * *shape* above rated, where it is only being asked how induction must change.
 */
export const DEFAULT_REGION2_THRUST_COEFFICIENT = 0.8

/**
 * Rotor thrust coefficient Ct at a given hub-height wind speed.
 *
 * Ct is the wake model's driving input: it sets the fraction of axial momentum the rotor
 * removes, and hence the depth of the velocity deficit downstream. It is *not* a power
 * quantity, but it lives here because it is a property of the machine — the wake model
 * consumes it, it doesn't own it.
 *
 * Uses the model's measured `thrustCurve` when present. Otherwise a two-region fallback
 * mirroring `powerCurveOutputKw`:
 *
 *   Region 2 — constant at `DEFAULT_REGION2_THRUST_COEFFICIENT`. Real machines are close
 *              to flat here, dipping only near cut-in.
 *   Region 3 — decays as (v_knee / v)³. Momentum theory gives the exponent: holding
 *              power constant in P = 2ρAv³·a(1-a)² requires a(1-a)² ∝ v⁻³, and for the
 *              small induction factors above rated, Ct = 4a(1-a) ≈ 4a ∝ v⁻³. Physically,
 *              the blades pitch to shed load, so thrust falls rather than holding.
 *
 * Outside [cut-in, cut-out] the rotor is parked or feathered and extracts no momentum, so
 * Ct is 0. (A parked rotor does have real parasitic drag; it casts no meaningful wake and
 * the turbine behind it is generating nothing either way.)
 *
 * The v⁻³ decay tracks published curves well — for a V80-2000 it gives Ct ≈ 0.34 at
 * 15 m/s and ≈0.07 at 25 m/s, against measured ≈0.30 and ≈0.08. A constant-thrust
 * (v⁻²) assumption would read ≈0.45 at 15 m/s, ~50% high.
 */
export function thrustCoefficient(model: TurbineModel, windSpeedMs: number): number {
  if (!Number.isFinite(windSpeedMs)) return 0
  if (windSpeedMs < model.cutInMs || windSpeedMs > model.cutOutMs) return 0

  if (model.thrustCurve && model.thrustCurve.length > 0) {
    return Math.min(Math.max(interpolateCurve(model.thrustCurve, windSpeedMs), 0), 1)
  }

  const kneeMs = ratedTransitionSpeedMs(model)
  if (!(kneeMs > 0) || windSpeedMs <= kneeMs) {
    return DEFAULT_REGION2_THRUST_COEFFICIENT
  }
  return DEFAULT_REGION2_THRUST_COEFFICIENT * (kneeMs / windSpeedMs) ** 3
}
