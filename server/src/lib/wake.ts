/**
 * Turbine wake modelling — the Bastankhah–Porté-Agel Gaussian wake with Katić
 * sum-of-squares superposition.
 *
 * This is the physics the viewer exists to show. Everything else in the API predicts a
 * single isolated turbine (see D14); wake interaction between turbines is this module's
 * subject, and `POST /api/field` samples it onto a grid to produce the 3D velocity volume
 * the client advects particles through.
 *
 * Chain, per sample point:
 *   1. rotate into the wind frame — downwind / crosswind / height
 *   2. for each upstream turbine, evaluate its Gaussian velocity deficit at that point
 *   3. combine the deficits by sum of squares
 *   4. apply the combined deficit to the sheared free-stream speed
 *
 * ## What this model does not do
 *
 * - **No terrain steering.** The deficit is purely streamwise; the velocity vector is
 *   always parallel to the free-stream direction. Real flow accelerates over ridges and
 *   separates in their lee. Bastankhah is a flat-terrain model and adding terrain
 *   response is a separate piece of work, not a parameter of this one.
 * - **No wake deflection.** Yaw misalignment steers a wake sideways; every turbine here
 *   is assumed to face the wind.
 * - **No ground reflection.** A rigorous treatment mirrors the wake in the ground plane
 *   to enforce zero flux through it. Omitted — it matters most for low hub heights and
 *   large rotors, and it would obscure the single-wake analytical tests.
 * - **No wake-added turbulence.** Turbulence intensity is an input, not a field. A
 *   downstream turbine sits in more turbulent air than the ambient value implies, which
 *   makes its own wake recover faster than modelled here.
 *
 * All four are documented deviations rather than oversights; the first is the one that
 * matters most for the viewer's story.
 */

import type { TurbineModel } from './turbines.js'
import { extrapolateWindSpeed, powerCurveOutputKw, thrustCoefficient } from './power.js'

/** A turbine placed in a farm, in a local metric frame. */
export interface FarmTurbine {
  id: string
  /** Metres east of the layout origin. */
  eastingM: number
  /** Metres north of the layout origin. */
  northingM: number
  hubHeightM: number
  model: TurbineModel
}

export interface WakeConditions {
  /** Free-stream wind speed at `referenceHeightM`, m/s. */
  freeStreamMs: number
  /**
   * Meteorological bearing the wind blows *from*, in degrees. 0 = from the north,
   * 90 = from the east. This is the convention the rest of the API uses.
   */
  bearingDeg: number
  /** Height at which `freeStreamMs` applies. Defaults to the mean farm hub height. */
  referenceHeightM?: number
  /**
   * Ambient turbulence intensity in [0, 1]. Drives the wake recovery rate; a windy,
   * unstable site recovers faster. Defaults to `DEFAULT_TURBULENCE_INTENSITY`.
   */
  turbulenceIntensity?: number
  /** Power-law exponent for the vertical profile. Defaults to 1/7. */
  shearExponent?: number
}

/**
 * Ambient turbulence intensity when the caller doesn't supply one.
 *
 * 0.10 is a reasonable inland default. Offshore sits nearer 0.06 and rough or complex
 * terrain runs 0.15+. This value materially changes wake losses — it is the single knob
 * that decides how fast wakes recover — so it should be supplied per site rather than
 * left to this default wherever the data exists.
 */
export const DEFAULT_TURBULENCE_INTENSITY = 0.1

/**
 * Wake growth rate k* as a function of ambient turbulence intensity.
 *
 * The linear fit from Niayifar & Porté-Agel (2016), calibrated against large-eddy
 * simulation of the Horns Rev layout. Replaces the older practice of hard-coding
 * k* = 0.075 onshore / 0.04 offshore, which is the same relation evaluated at two
 * particular turbulence intensities and then frozen.
 */
export function wakeGrowthRate(turbulenceIntensity: number): number {
  const i = Math.min(Math.max(turbulenceIntensity, 0), 1)
  return 0.3837 * i + 0.003678
}

/**
 * The near-wake width offset ε, in rotor diameters.
 *
 * Bastankhah's similarity solution extrapolates the far-wake Gaussian back to x = 0,
 * where it must match the rotor's own expansion rather than collapsing to zero width.
 * ε = 0.2√β, with β the ratio of near-wake to rotor area from momentum theory. For a
 * typical Ct = 0.8 this lands at ε ≈ 0.254.
 */
export function nearWakeOffset(ct: number): number {
  const clamped = Math.min(Math.max(ct, 0), 0.999)
  const root = Math.sqrt(1 - clamped)
  const beta = (0.5 * (1 + root)) / root
  return 0.2 * Math.sqrt(beta)
}

/**
 * Gaussian wake width σ at a downstream distance, in metres.
 *
 * σ/D grows linearly with downstream distance: σ/D = k*·(x/D) + ε.
 */
export function wakeWidthM(
  downwindM: number,
  rotorDiameterM: number,
  ct: number,
  growthRate: number,
): number {
  const xOverD = downwindM / rotorDiameterM
  return (growthRate * xOverD + nearWakeOffset(ct)) * rotorDiameterM
}

/**
 * Peak (centreline) velocity deficit as a fraction of free stream, at a given wake width.
 *
 * From momentum conservation across the Gaussian profile:
 *   ΔU/U = 1 − √(1 − Ct / (8(σ/D)²))
 *
 * The radicand goes negative close behind the rotor, where the assumed Gaussian is too
 * narrow to carry the rotor's momentum deficit. That is the model leaving its domain of
 * validity, not a physical stagnation — but clamping to a full 100% deficit is the
 * conventional and conservative handling, and the near wake (x ≲ 2D) should not be read
 * quantitatively either way.
 */
export function centrelineDeficitFraction(ct: number, sigmaOverD: number): number {
  if (sigmaOverD <= 0) return 1
  const radicand = 1 - ct / (8 * sigmaOverD * sigmaOverD)
  if (radicand <= 0) return 1
  return 1 - Math.sqrt(radicand)
}

/**
 * Velocity deficit fraction cast by one turbine at one point.
 *
 * `downwindM` is distance along the wind direction, `radialM` the distance from the wake
 * axis (crosswind and vertical combined — the profile is axisymmetric). Returns 0
 * upstream of the rotor: this model has no induction zone, so the flow ahead of a
 * turbine is undisturbed.
 */
export function singleWakeDeficit(
  downwindM: number,
  radialM: number,
  rotorDiameterM: number,
  ct: number,
  growthRate: number,
): number {
  if (!(downwindM > 0) || ct <= 0 || rotorDiameterM <= 0) return 0

  const sigmaM = wakeWidthM(downwindM, rotorDiameterM, ct, growthRate)
  if (!(sigmaM > 0)) return 0

  const peak = centrelineDeficitFraction(ct, sigmaM / rotorDiameterM)
  const gaussian = Math.exp(-0.5 * (radialM / sigmaM) ** 2)
  return peak * gaussian
}

/**
 * Katić sum-of-squares superposition of overlapping wakes.
 *
 * Combining as √(Σδᵢ²) rather than Σδᵢ is what keeps a point deep inside several wakes
 * from being driven to a nonsensical negative velocity — linear summation of three 40%
 * deficits would claim 120%. Sum-of-squares also has the right physical reading: kinetic
 * energy deficits add, and velocity deficit enters energy quadratically.
 */
export function combineDeficits(deficits: readonly number[]): number {
  let sumSquares = 0
  for (const d of deficits) {
    if (d > 0) sumSquares += d * d
  }
  return Math.min(Math.sqrt(sumSquares), 1)
}

/**
 * Unit vector the wind *travels* along, in (east, north), from a meteorological bearing.
 *
 * Bearing is the direction the wind comes from, so travel is the reverse: a 0° (northerly)
 * wind travels toward the south, giving (0, −1).
 */
export function windTravelVector(bearingDeg: number): { east: number; north: number } {
  const rad = (bearingDeg * Math.PI) / 180
  return { east: -Math.sin(rad), north: -Math.cos(rad) }
}

/** A point in the local farm frame. Height is above ground, not above hub. */
export interface FieldPoint {
  eastingM: number
  northingM: number
  heightM: number
}

/** One upstream turbine's share of the deficit at a sample point. */
export interface WakeContribution {
  turbineId: string
  /** Deficit fraction this turbine alone would cause here. */
  deficit: number
}

export interface WakeSample {
  /** Waked wind speed at the point, m/s. */
  speedMs: number
  /** Free-stream speed at this height with no turbines present, m/s. */
  freeStreamMs: number
  /** Combined deficit as a fraction of the local free stream, in [0, 1]. */
  deficit: number
  /** Velocity vector in (east, north, up), m/s. Always streamwise — see module header. */
  velocity: { east: number; north: number; up: number }
  /** Per-turbine breakdown, descending by deficit. Only non-zero contributors. */
  contributions: WakeContribution[]
}

interface ResolvedConditions {
  freeStreamMs: number
  bearingDeg: number
  referenceHeightM: number
  turbulenceIntensity: number
  shearExponent: number
  growthRate: number
  travel: { east: number; north: number }
}

function resolveConditions(
  turbines: readonly FarmTurbine[],
  conditions: WakeConditions,
): ResolvedConditions {
  const meanHub =
    turbines.length > 0
      ? turbines.reduce((sum, t) => sum + t.hubHeightM, 0) / turbines.length
      : 100
  const turbulenceIntensity = conditions.turbulenceIntensity ?? DEFAULT_TURBULENCE_INTENSITY

  return {
    freeStreamMs: conditions.freeStreamMs,
    bearingDeg: conditions.bearingDeg,
    referenceHeightM: conditions.referenceHeightM ?? meanHub,
    turbulenceIntensity,
    shearExponent: conditions.shearExponent ?? 1 / 7,
    growthRate: wakeGrowthRate(turbulenceIntensity),
    travel: windTravelVector(conditions.bearingDeg),
  }
}

/**
 * Free-stream speed at a height, with no turbines present.
 *
 * Wake deficits are applied as a fraction of *this*, not of the reference speed, so a
 * wake sampled near the ground is a deficit on already-slower air.
 */
function freeStreamAtHeight(heightM: number, c: ResolvedConditions): number {
  if (heightM <= 0) return 0
  return extrapolateWindSpeed(c.freeStreamMs, c.referenceHeightM, heightM, c.shearExponent)
}

/**
 * Project a point into the wind frame relative to a turbine.
 *
 * `downwind` is positive downstream of the turbine; `crosswind` is the horizontal offset
 * from the wake axis. The perpendicular is the travel vector rotated a quarter turn, so
 * the sign of `crosswind` is consistent but arbitrary — only its magnitude is used.
 */
function projectToWindFrame(
  point: FieldPoint,
  turbine: FarmTurbine,
  travel: { east: number; north: number },
): { downwindM: number; crosswindM: number } {
  const de = point.eastingM - turbine.eastingM
  const dn = point.northingM - turbine.northingM
  return {
    downwindM: de * travel.east + dn * travel.north,
    crosswindM: de * -travel.north + dn * travel.east,
  }
}

/**
 * Sample the waked flow at an arbitrary point.
 *
 * `operatingCt` supplies each turbine's thrust coefficient. It is a parameter rather than
 * something computed here because a turbine's Ct depends on the speed *it* sees, which
 * depends on the wakes upstream of it — resolving that is `evaluateFarm`'s job, and this
 * function must not re-derive it from the free stream or deep-array wakes come out too
 * shallow.
 */
export function sampleWakeField(
  point: FieldPoint,
  turbines: readonly FarmTurbine[],
  conditions: WakeConditions,
  operatingCt: ReadonlyMap<string, number>,
): WakeSample {
  const c = resolveConditions(turbines, conditions)
  const freeStream = freeStreamAtHeight(point.heightM, c)

  const contributions: WakeContribution[] = []
  for (const turbine of turbines) {
    const ct = operatingCt.get(turbine.id) ?? 0
    if (ct <= 0) continue

    const { downwindM, crosswindM } = projectToWindFrame(point, turbine, c.travel)
    if (!(downwindM > 0)) continue

    const dz = point.heightM - turbine.hubHeightM
    const radialM = Math.hypot(crosswindM, dz)
    const deficit = singleWakeDeficit(
      downwindM,
      radialM,
      turbine.model.rotorDiameterM,
      ct,
      c.growthRate,
    )
    if (deficit > 0) contributions.push({ turbineId: turbine.id, deficit })
  }

  contributions.sort((a, b) => b.deficit - a.deficit)
  const deficit = combineDeficits(contributions.map((x) => x.deficit))
  const speedMs = freeStream * (1 - deficit)

  return {
    speedMs,
    freeStreamMs: freeStream,
    deficit,
    velocity: {
      east: c.travel.east * speedMs,
      north: c.travel.north * speedMs,
      up: 0,
    },
    contributions,
  }
}

export interface TurbineResult {
  turbineId: string
  /** Hub-height wind speed after upstream wakes, m/s. */
  effectiveSpeedMs: number
  /** Hub-height speed with no other turbines present, m/s. */
  freeStreamMs: number
  /** Combined deficit at the rotor, as a fraction of free stream. */
  deficit: number
  /** Thrust coefficient at the effective speed — this turbine's own wake strength. */
  thrustCoefficient: number
  /** Power at the effective speed, kW, at reference air density. */
  powerKw: number
  /** Power this turbine would make with no upstream wakes, kW. */
  freeStreamPowerKw: number
  /**
   * The upstream turbine responsible for the largest share of this turbine's deficit,
   * or null if it is unwaked. This is what answers "which turbine is stealing whose
   * energy" without making the client re-derive it.
   */
  dominantWakeSource: string | null
  contributions: WakeContribution[]
}

export interface FarmResult {
  turbines: TurbineResult[]
  totalPowerKw: number
  /** Total power if every turbine saw undisturbed flow, kW. */
  totalFreeStreamPowerKw: number
  /** Farm wake loss as a fraction of the unwaked total, in [0, 1]. */
  wakeLossFraction: number
}

/**
 * Evaluate every turbine in a farm under one set of wind conditions.
 *
 * Turbines are processed **strictly upstream-first**. This ordering is not an
 * optimization, it is the correctness requirement: a turbine's Ct depends on the speed it
 * actually sees, and its wake depth depends on that Ct. Evaluating out of order would use
 * a free-stream Ct for an already-waked machine and overstate the wake it casts on
 * everything behind it. Sorting by the downwind coordinate makes the dependency acyclic —
 * a turbine can only be waked by one strictly upstream of it.
 */
export function evaluateFarm(
  turbines: readonly FarmTurbine[],
  conditions: WakeConditions,
): FarmResult {
  const c = resolveConditions(turbines, conditions)

  const ordered = [...turbines].sort((a, b) => {
    const da = a.eastingM * c.travel.east + a.northingM * c.travel.north
    const db = b.eastingM * c.travel.east + b.northingM * c.travel.north
    return da - db
  })

  const operatingCt = new Map<string, number>()
  const results: TurbineResult[] = []

  for (const turbine of ordered) {
    const point: FieldPoint = {
      eastingM: turbine.eastingM,
      northingM: turbine.northingM,
      heightM: turbine.hubHeightM,
    }
    // Only turbines already resolved are in `operatingCt`, so this sees exactly the
    // upstream set — the sort is what makes that equivalent to "everything upstream".
    const sample = sampleWakeField(point, ordered, conditions, operatingCt)

    const ct = thrustCoefficient(turbine.model, sample.speedMs)
    operatingCt.set(turbine.id, ct)

    results.push({
      turbineId: turbine.id,
      effectiveSpeedMs: sample.speedMs,
      freeStreamMs: sample.freeStreamMs,
      deficit: sample.deficit,
      thrustCoefficient: ct,
      powerKw: powerCurveOutputKw(turbine.model, sample.speedMs),
      freeStreamPowerKw: powerCurveOutputKw(turbine.model, sample.freeStreamMs),
      dominantWakeSource: sample.contributions[0]?.turbineId ?? null,
      contributions: sample.contributions,
    })
  }

  const totalPowerKw = results.reduce((sum, r) => sum + r.powerKw, 0)
  const totalFreeStreamPowerKw = results.reduce((sum, r) => sum + r.freeStreamPowerKw, 0)

  return {
    turbines: results,
    totalPowerKw,
    totalFreeStreamPowerKw,
    wakeLossFraction:
      totalFreeStreamPowerKw > 0 ? 1 - totalPowerKw / totalFreeStreamPowerKw : 0,
  }
}

/**
 * Thrust coefficients for a farm under given conditions, ready to pass to
 * `sampleWakeField`.
 *
 * Sampling a whole grid means calling `sampleWakeField` thousands of times against the
 * same operating state; resolving that state once here keeps the per-sample cost to the
 * geometry alone.
 */
export function operatingThrustCoefficients(
  turbines: readonly FarmTurbine[],
  conditions: WakeConditions,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of evaluateFarm(turbines, conditions).turbines) {
    map.set(r.turbineId, r.thrustCoefficient)
  }
  return map
}
