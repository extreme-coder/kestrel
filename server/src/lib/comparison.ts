/**
 * Baseline against candidate: what changes when the layout or the wind does.
 *
 * T3 asks whether the answer to "which turbine is worst, and why" survives another wind
 * direction. Step 10 could compute both bearings and could not put them side by side, so
 * answering it meant scrubbing the control and remembering. Remembering is not an analysis
 * tool, and a difference the user reconstructs from memory is one the interface never has to
 * be right about.
 *
 * Pure: two solved analyses in, deltas out. No database, no solve.
 *
 * ## Signs
 *
 * Every delta is `candidate - baseline`. So a negative `deltaNetPowerKw` means the candidate
 * makes less power, and a negative `deltaWakeLossFraction` means it loses proportionally less
 * — which is an improvement. The two have opposite senses and no naming convention fixes
 * that, so anything that renders these has to label the direction rather than colour it.
 */

import { MATERIAL_LOSS_FRACTION } from './farmAnalysis.js'
import type { FarmAnalysis, TurbineAnalysis } from './farmAnalysis.js'

export interface TurbineDelta {
  turbineId: string
  baselineNetPowerKw: number
  candidateNetPowerKw: number
  deltaNetPowerKw: number
  baselineGrossPowerKw: number
  candidateGrossPowerKw: number
  deltaGrossPowerKw: number
  baselineWakeLossKw: number
  candidateWakeLossKw: number
  deltaWakeLossKw: number
  baselineWakeLossFraction: number
  candidateWakeLossFraction: number
  /** In fraction units, not percentage points. Multiply by 100 to display. */
  deltaWakeLossFraction: number
  baselineIncomingSpeedMs: number
  candidateIncomingSpeedMs: number
  deltaIncomingSpeedMs: number
  baselineDominantContributorId: string | null
  candidateDominantContributorId: string | null
  /** True when the model changed its account of *why* this turbine loses what it loses. */
  dominantContributorChanged: boolean
}

export interface FarmComparison {
  /** One row per turbine present in both scenes, worst candidate loss first. */
  turbines: TurbineDelta[]
  /**
   * Ids present in one scene and not the other.
   *
   * Reported rather than dropped. Comparing a 4-turbine layout with a 12-turbine one is a
   * legitimate thing to want, and a farm total that silently ignored eight machines would be
   * the most confidently wrong number in the application.
   */
  onlyInBaseline: string[]
  onlyInCandidate: string[]
  baselineTotalNetPowerKw: number
  candidateTotalNetPowerKw: number
  deltaTotalNetPowerKw: number
  baselineTotalGrossPowerKw: number
  candidateTotalGrossPowerKw: number
  deltaTotalGrossPowerKw: number
  baselineTotalWakeLossKw: number
  candidateTotalWakeLossKw: number
  deltaTotalWakeLossKw: number
  baselineFarmWakeLossFraction: number
  candidateFarmWakeLossFraction: number
  deltaFarmWakeLossFraction: number
  baselineWorstTurbineId: string | null
  candidateWorstTurbineId: string | null
  /** The T3 answer in one boolean: did the finding survive the change? */
  worstTurbineChanged: boolean
  /** Turbine whose net power moved most, either way. Null when nothing matched. */
  largestMoverId: string | null
}

function byId(analysis: FarmAnalysis): Map<string, TurbineAnalysis> {
  return new Map(analysis.turbines.map((turbine) => [turbine.turbineId, turbine]))
}

/**
 * The dominant contributor, or null when there is no loss worth explaining (D28).
 *
 * Without this, an unwaked turbine reports "the cause changed" every time the wind moves —
 * the raw field flips between null and whichever neighbour registered a 1e-6 deficit, while
 * the turbine's loss stays at 0.00%. That is the single most misleading thing this endpoint
 * could say, because "did the model's account of the cause change" is the T3 question.
 */
function materialDominantContributor(turbine: TurbineAnalysis): string | null {
  return turbine.wakeLossFraction < MATERIAL_LOSS_FRACTION ? null : turbine.dominantContributorId
}

/**
 * Match two solved farms by turbine id and difference them.
 *
 * Matching on id rather than on position is deliberate. Position matching would need a
 * tolerance, and a tolerance turns "I moved this turbine 80 m" into either "a turbine
 * vanished and another appeared" or "nothing moved", depending on a constant nobody chose.
 * Ids are stable across a bearing change, which is the comparison this is built for, and a
 * layout edit that renames turbines is honestly reported as a different set of machines.
 */
export function compareFarms(baseline: FarmAnalysis, candidate: FarmAnalysis): FarmComparison {
  const baselineById = byId(baseline)
  const candidateById = byId(candidate)

  const turbines: TurbineDelta[] = []
  for (const [id, before] of baselineById) {
    const after = candidateById.get(id)
    if (!after) continue
    const baselineCause = materialDominantContributor(before)
    const candidateCause = materialDominantContributor(after)
    turbines.push({
      turbineId: id,
      baselineNetPowerKw: before.netPowerKw,
      candidateNetPowerKw: after.netPowerKw,
      deltaNetPowerKw: after.netPowerKw - before.netPowerKw,
      baselineGrossPowerKw: before.grossPowerKw,
      candidateGrossPowerKw: after.grossPowerKw,
      deltaGrossPowerKw: after.grossPowerKw - before.grossPowerKw,
      baselineWakeLossKw: before.wakeLossKw,
      candidateWakeLossKw: after.wakeLossKw,
      deltaWakeLossKw: after.wakeLossKw - before.wakeLossKw,
      baselineWakeLossFraction: before.wakeLossFraction,
      candidateWakeLossFraction: after.wakeLossFraction,
      deltaWakeLossFraction: after.wakeLossFraction - before.wakeLossFraction,
      baselineIncomingSpeedMs: before.incomingSpeedMs,
      candidateIncomingSpeedMs: after.incomingSpeedMs,
      deltaIncomingSpeedMs: after.incomingSpeedMs - before.incomingSpeedMs,
      baselineDominantContributorId: baselineCause,
      candidateDominantContributorId: candidateCause,
      dominantContributorChanged: baselineCause !== candidateCause,
    })
  }

  turbines.sort(
    (a, b) =>
      b.candidateWakeLossFraction - a.candidateWakeLossFraction || a.turbineId.localeCompare(b.turbineId),
  )

  const onlyInBaseline = [...baselineById.keys()].filter((id) => !candidateById.has(id))
  const onlyInCandidate = [...candidateById.keys()].filter((id) => !baselineById.has(id))

  let largestMoverId: string | null = null
  let largestMove = -1
  for (const delta of turbines) {
    const moved = Math.abs(delta.deltaNetPowerKw)
    if (moved > largestMove) {
      largestMove = moved
      largestMoverId = delta.turbineId
    }
  }

  return {
    turbines,
    onlyInBaseline,
    onlyInCandidate,
    baselineTotalNetPowerKw: baseline.totalNetPowerKw,
    candidateTotalNetPowerKw: candidate.totalNetPowerKw,
    deltaTotalNetPowerKw: candidate.totalNetPowerKw - baseline.totalNetPowerKw,
    baselineTotalGrossPowerKw: baseline.totalGrossPowerKw,
    candidateTotalGrossPowerKw: candidate.totalGrossPowerKw,
    deltaTotalGrossPowerKw: candidate.totalGrossPowerKw - baseline.totalGrossPowerKw,
    baselineTotalWakeLossKw: baseline.totalWakeLossKw,
    candidateTotalWakeLossKw: candidate.totalWakeLossKw,
    deltaTotalWakeLossKw: candidate.totalWakeLossKw - baseline.totalWakeLossKw,
    baselineFarmWakeLossFraction: baseline.wakeLossFraction,
    candidateFarmWakeLossFraction: candidate.wakeLossFraction,
    deltaFarmWakeLossFraction: candidate.wakeLossFraction - baseline.wakeLossFraction,
    baselineWorstTurbineId: baseline.worstTurbineId,
    candidateWorstTurbineId: candidate.worstTurbineId,
    worstTurbineChanged: baseline.worstTurbineId !== candidate.worstTurbineId,
    largestMoverId,
  }
}
