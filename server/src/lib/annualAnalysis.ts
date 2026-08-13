/**
 * What the farm loses over a year, rather than at one bearing.
 *
 * Every figure the analysis produced before this described a single condition, and
 * `docs/design/alternate-bearing.md` measured how badly that generalises: the demonstration
 * array loses 25.4% at 210 degrees, 16.2% at 215, 12.5% at 205 and 1.4% at 200. Reading any
 * one of those as "the farm's wake loss" is reading a 5 degree coincidence as a siting
 * finding.
 *
 * Weighting separates two things a single number conflates:
 *
 *   - the **expected** loss, which is what a siting decision trades against cost, and
 *   - the **worst** condition's loss, which is what a rare severe wake looks like, and which
 *     matters for loads and complaints even when it barely moves the annual figure.
 *
 * Both are reported, per turbine and for the farm. A tool showing only the first would make a
 * sharp directional wake look benign; one showing only the second would make every farm look
 * ruinous.
 *
 * ## Why conditions, and not sectors
 *
 * The obvious design — one evaluation per direction sector, at the sector's representative
 * speed — is wrong in a way that hides itself, and it was built and measured before being
 * replaced. A power curve is flat above rated, so a turbine in a wake at 13 m/s still makes
 * rated power and reports **no loss at all**. Askervein's dominant sector has an
 * energy-equivalent speed of 13.1 m/s against the V112's 12.5 m/s rated, so that version
 * reported 0.00% wake loss at 210 degrees — the bearing the entire demonstration is built
 * around — and an expected annual loss of 4.19% that was mostly an artefact of which side of
 * rated each sector's average happened to land on.
 *
 * A condition is therefore a (direction, speed) pair, and the rose supplies both. The cost is
 * bounded because the expensive part, the base-flow solve, depends only on direction: the
 * caller solves once per bearing and sweeps speeds against it.
 *
 * Pure: solved per-condition analyses in, weighted results out.
 */

import type { FarmAnalysis } from './farmAnalysis.js'

export interface ConditionEvaluation {
  /** Direction sector centre this condition sits in. */
  bearingDeg: number
  /** Speed it was evaluated at. */
  speedMs: number
  /** Share of the year's hours in this (direction, speed) cell. */
  frequency: number
  analysis: FarmAnalysis
}

/**
 * The single worst condition for some turbine or farm, and how often it occurs.
 *
 * "Worst" is the condition losing the most **power**, not the highest loss *fraction*, and
 * that choice was made after the fraction version was built and run. A power curve is zero
 * below cut-in, so a rotor making 60 kW at 3.6 m/s whose wake pushes it under 3 m/s reports a
 * 100% loss. Every turbine's worst condition came back as exactly 100.00%, at 3.5 m/s, in
 * directions carrying under half a percent of the year — arithmetically true, useless as an
 * answer to "where does this farm hurt", and the same mistake as calling a turbine with a
 * 1e-6 deficit a cause (D28).
 *
 * Ranking by kilowatts cannot be dominated by either edge: near cut-in there is nothing to
 * lose, and above rated there is no loss to have. The fraction is still reported, beside the
 * power, because it is the right way to *express* a loss once the right condition is chosen.
 */
export interface WorstCondition {
  bearingDeg: number
  speedMs: number
  /** Power lost in this condition, kW. What "worst" is ranked on. */
  wakeLossKw: number
  wakeLossFraction: number
  frequency: number
}

export interface TurbineAnnual {
  turbineId: string
  /** Frequency-weighted gross power, kW. */
  weightedGrossPowerKw: number
  weightedNetPowerKw: number
  weightedWakeLossKw: number
  /**
   * Expected loss as a share of expected gross.
   *
   * The ratio of the two weighted totals, **not** the weighted mean of the per-condition
   * fractions. Those differ, and only the first is an energy statement: a condition that
   * blows 2% of the year at 4 m/s can lose 90% of a rotor's output and cost the farm almost
   * nothing, because there was almost nothing there to lose.
   */
  weightedWakeLossFraction: number
  worst: WorstCondition
}

export interface DirectionRollup {
  bearingDeg: number
  /** Share of the year's hours from this direction, summed over its speed bins. */
  frequency: number
  /** Expected loss within this direction alone, energy-weighted across its speeds. */
  wakeLossFraction: number
  weightedGrossPowerKw: number
  weightedNetPowerKw: number
  /** Speed bins evaluated in this direction. */
  conditions: number
}

export interface AnnualAnalysis {
  turbines: TurbineAnnual[]
  weightedGrossPowerKw: number
  weightedNetPowerKw: number
  weightedWakeLossKw: number
  weightedWakeLossFraction: number
  /** Turbine with the highest expected loss share, which need not be the worst at any bearing. */
  worstTurbineId: string | null
  /** The single worst (direction, speed) cell for the farm. */
  worst: WorstCondition
  /** Per-direction totals, for a rose the interface can draw losses on. */
  directions: DirectionRollup[]
  conditionsEvaluated: number
  /**
   * Share of the rose's hours the evaluated conditions cover, before normalisation.
   *
   * 1 for a whole rose. Below 1 when the caller evaluated a subset, and reported because a
   * weighted figure over 40% of the year is not an annual expectation however it is labelled.
   */
  frequencyCovered: number
}

/**
 * Weight per-condition farm analyses by how often each condition occurs.
 *
 * Frequencies are normalised over the conditions supplied, so a partial rose still produces a
 * proportioned answer rather than one scaled down by the missing hours — and
 * `frequencyCovered` records how much of the year was actually covered, so a caller can
 * refuse to call it annual.
 */
export function weightConditions(evaluations: ConditionEvaluation[]): AnnualAnalysis {
  if (evaluations.length === 0) throw new RangeError('cannot weight an empty set of conditions')

  const covered = evaluations.reduce((sum, condition) => sum + condition.frequency, 0)
  if (!(covered > 0)) throw new RangeError('condition frequencies must sum to more than zero')

  const grossById = new Map<string, number>()
  const netById = new Map<string, number>()
  const lossById = new Map<string, number>()
  const worstById = new Map<string, WorstCondition>()
  const directions = new Map<number, DirectionRollup>()

  let weightedGross = 0
  let weightedNet = 0
  let weightedLoss = 0
  let worst: WorstCondition = {
    bearingDeg: evaluations[0]!.bearingDeg,
    speedMs: evaluations[0]!.speedMs,
    wakeLossKw: -1,
    wakeLossFraction: 0,
    frequency: 0,
  }

  for (const condition of evaluations) {
    const weight = condition.frequency / covered
    const { analysis } = condition

    weightedGross += weight * analysis.totalGrossPowerKw
    weightedNet += weight * analysis.totalNetPowerKw
    weightedLoss += weight * analysis.totalWakeLossKw

    if (analysis.totalWakeLossKw > worst.wakeLossKw) {
      worst = {
        bearingDeg: condition.bearingDeg,
        speedMs: condition.speedMs,
        wakeLossKw: analysis.totalWakeLossKw,
        wakeLossFraction: analysis.wakeLossFraction,
        frequency: condition.frequency,
      }
    }

    const rollup = directions.get(condition.bearingDeg) ?? {
      bearingDeg: condition.bearingDeg,
      frequency: 0,
      wakeLossFraction: 0,
      weightedGrossPowerKw: 0,
      weightedNetPowerKw: 0,
      conditions: 0,
    }
    rollup.frequency += condition.frequency
    // Accumulated with the *unnormalised* frequency: the rollup is a ratio within its own
    // direction, so the denominator has to be that direction's own weight and not the year's.
    rollup.weightedGrossPowerKw += condition.frequency * analysis.totalGrossPowerKw
    rollup.weightedNetPowerKw += condition.frequency * analysis.totalNetPowerKw
    rollup.conditions++
    directions.set(condition.bearingDeg, rollup)

    for (const turbine of analysis.turbines) {
      const id = turbine.turbineId
      grossById.set(id, (grossById.get(id) ?? 0) + weight * turbine.grossPowerKw)
      netById.set(id, (netById.get(id) ?? 0) + weight * turbine.netPowerKw)
      lossById.set(id, (lossById.get(id) ?? 0) + weight * turbine.wakeLossKw)
      const current = worstById.get(id)
      if (!current || turbine.wakeLossKw > current.wakeLossKw) {
        worstById.set(id, {
          bearingDeg: condition.bearingDeg,
          speedMs: condition.speedMs,
          wakeLossKw: turbine.wakeLossKw,
          wakeLossFraction: turbine.wakeLossFraction,
          frequency: condition.frequency,
        })
      }
    }
  }

  const turbines: TurbineAnnual[] = [...grossById.keys()].map((id) => {
    const gross = grossById.get(id) ?? 0
    return {
      turbineId: id,
      weightedGrossPowerKw: gross,
      weightedNetPowerKw: netById.get(id) ?? 0,
      weightedWakeLossKw: lossById.get(id) ?? 0,
      weightedWakeLossFraction: gross > 0 ? (lossById.get(id) ?? 0) / gross : 0,
      worst:
        worstById.get(id) ??
        { bearingDeg: 0, speedMs: 0, wakeLossKw: 0, wakeLossFraction: 0, frequency: 0 },
    }
  })

  turbines.sort(
    (a, b) =>
      b.weightedWakeLossFraction - a.weightedWakeLossFraction || a.turbineId.localeCompare(b.turbineId),
  )

  const rollups = [...directions.values()]
    .map((rollup) => ({
      ...rollup,
      wakeLossFraction:
        rollup.weightedGrossPowerKw > 0
          ? (rollup.weightedGrossPowerKw - rollup.weightedNetPowerKw) / rollup.weightedGrossPowerKw
          : 0,
      // Normalise the power figures the same way the farm totals are, so a direction's
      // contribution is readable next to the farm's expected output rather than being an
      // unnormalised accumulator.
      weightedGrossPowerKw: rollup.weightedGrossPowerKw / covered,
      weightedNetPowerKw: rollup.weightedNetPowerKw / covered,
    }))
    .sort((a, b) => a.bearingDeg - b.bearingDeg)

  return {
    turbines,
    weightedGrossPowerKw: weightedGross,
    weightedNetPowerKw: weightedNet,
    weightedWakeLossKw: weightedLoss,
    weightedWakeLossFraction: weightedGross > 0 ? weightedLoss / weightedGross : 0,
    worstTurbineId: turbines[0]?.turbineId ?? null,
    worst: { ...worst, wakeLossKw: Math.max(0, worst.wakeLossKw) },
    directions: rollups,
    conditionsEvaluated: evaluations.length,
    frequencyCovered: covered,
  }
}
