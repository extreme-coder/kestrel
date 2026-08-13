import { describe, expect, it } from 'vitest'

import { weightConditions } from '../src/lib/annualAnalysis.js'
import type { ConditionEvaluation } from '../src/lib/annualAnalysis.js'
import type { FarmAnalysis, TurbineAnalysis } from '../src/lib/farmAnalysis.js'

function turbine(id: string, grossPowerKw: number, netPowerKw: number): TurbineAnalysis {
  return {
    turbineId: id,
    eastingM: 0,
    northingM: 0,
    groundElevationM: 0,
    hubHeightM: 100,
    grossSpeedMs: 10,
    incomingSpeedMs: 10,
    deficit: 0,
    thrustCoefficient: 0.8,
    netPowerKw,
    grossPowerKw,
    wakeLossKw: grossPowerKw - netPowerKw,
    wakeLossFraction: grossPowerKw > 0 ? (grossPowerKw - netPowerKw) / grossPowerKw : 0,
    contributors: [],
    dominantContributorId: null,
    wakePath: [],
  }
}

function farm(turbines: TurbineAnalysis[]): FarmAnalysis {
  const totalGrossPowerKw = turbines.reduce((sum, entry) => sum + entry.grossPowerKw, 0)
  const totalNetPowerKw = turbines.reduce((sum, entry) => sum + entry.netPowerKw, 0)
  const totalWakeLossKw = totalGrossPowerKw - totalNetPowerKw
  return {
    turbines,
    totalNetPowerKw,
    totalGrossPowerKw,
    totalWakeLossKw,
    wakeLossFraction: totalGrossPowerKw > 0 ? totalWakeLossKw / totalGrossPowerKw : 0,
    worstTurbineId: turbines[0]?.turbineId ?? null,
    operatingCt: new Map(),
  }
}

function condition(
  bearingDeg: number,
  speedMs: number,
  frequency: number,
  grossPowerKw: number,
  netPowerKw: number,
): ConditionEvaluation {
  return { bearingDeg, speedMs, frequency, analysis: farm([turbine('t1', grossPowerKw, netPowerKw)]) }
}

describe('weightConditions', () => {
  it('weights by frequency rather than averaging the conditions', () => {
    // 90% of the year lossless, 10% losing half. Expected loss is 5%, not the 25% a plain
    // mean of the two conditions would give.
    const annual = weightConditions([
      condition(210, 10, 0.9, 1000, 1000),
      condition(270, 10, 0.1, 1000, 500),
    ])
    expect(annual.weightedWakeLossFraction).toBeCloseTo(0.05, 12)
    expect(annual.weightedGrossPowerKw).toBeCloseTo(1000, 12)
    expect(annual.weightedNetPowerKw).toBeCloseTo(950, 12)
  })

  it('takes the ratio of weighted totals, not the weighted mean of the fractions', () => {
    // A calm condition that loses almost everything costs the farm almost nothing, because
    // there was almost nothing there to lose. The two definitions differ sharply here: the
    // mean of fractions gives 0.5 * 0.9 + 0.5 * 0.0 = 45%, the energy ratio gives 8.3%.
    const annual = weightConditions([
      condition(210, 4, 0.5, 100, 10),
      condition(210, 12, 0.5, 1000, 1000),
    ])
    expect(annual.weightedWakeLossFraction).toBeCloseTo(90 / 1100, 12)
    expect(annual.weightedWakeLossFraction).toBeLessThan(0.1)
  })

  it('normalises a partial rose and reports how much of the year it covered', () => {
    const annual = weightConditions([
      condition(210, 10, 0.3, 1000, 900),
      condition(270, 10, 0.1, 1000, 500),
    ])
    // Normalised: 0.75 and 0.25 of the evaluated hours, so the ratio is unaffected by the
    // missing 60% — but the caller is told, because this is not an annual expectation.
    expect(annual.frequencyCovered).toBeCloseTo(0.4, 12)
    expect(annual.weightedNetPowerKw).toBeCloseTo(0.75 * 900 + 0.25 * 500, 12)
  })

  it('ranks the worst condition by power lost, not by loss fraction', () => {
    // The reason this is not ranked on fraction: a rotor making 60 kW just above cut-in whose
    // wake pushes it under cut-in reports a 100% loss. Arithmetically true, useless as an
    // answer to "where does this farm hurt", and it dominated every turbine's worst condition
    // when this was first built. Ranking on kilowatts cannot be won by an edge case with
    // nothing at stake.
    const annual = weightConditions([
      condition(30, 3.5, 0.01, 60, 0),
      condition(210, 11, 0.05, 3000, 1500),
    ])
    expect(annual.worst.bearingDeg).toBe(210)
    expect(annual.worst.speedMs).toBe(11)
    expect(annual.worst.wakeLossKw).toBe(1500)
    expect(annual.worst.wakeLossFraction).toBeCloseTo(0.5, 12)
    // Still reported, because a fraction is the right way to express a loss once the right
    // condition has been chosen.
    expect(annual.worst.frequency).toBe(0.05)
  })

  it('separates the expected loss from the worst one', () => {
    // The distinction this module exists for: a rare severe wake and an annual expectation
    // are different claims and must not share a label.
    const annual = weightConditions([
      condition(210, 10, 0.98, 1000, 1000),
      condition(300, 10, 0.02, 1000, 400),
    ])
    expect(annual.weightedWakeLossFraction).toBeCloseTo(0.012, 12)
    expect(annual.worst.wakeLossFraction).toBeCloseTo(0.6, 12)
    expect(annual.worst.frequency).toBe(0.02)
  })

  it('rolls conditions up per direction with each direction as its own denominator', () => {
    const annual = weightConditions([
      condition(210, 6, 0.2, 500, 400),
      condition(210, 12, 0.2, 2000, 1800),
      condition(270, 10, 0.6, 1000, 1000),
    ])
    const south = annual.directions.find((entry) => entry.bearingDeg === 210)!
    expect(south.conditions).toBe(2)
    expect(south.frequency).toBeCloseTo(0.4, 12)
    // Within 210 alone: (0.2*500 + 0.2*2000) gross, (0.2*400 + 0.2*1800) net → 300/2500.
    expect(south.wakeLossFraction).toBeCloseTo(300 / 2500, 12)
    expect(annual.directions.map((entry) => entry.bearingDeg)).toEqual([210, 270])
  })

  it('tracks each turbine separately', () => {
    const evaluations: ConditionEvaluation[] = [
      {
        bearingDeg: 210,
        speedMs: 10,
        frequency: 0.5,
        analysis: farm([turbine('a', 1000, 1000), turbine('b', 1000, 600)]),
      },
      {
        bearingDeg: 270,
        speedMs: 10,
        frequency: 0.5,
        analysis: farm([turbine('a', 1000, 800), turbine('b', 1000, 1000)]),
      },
    ]
    const annual = weightConditions(evaluations)
    const a = annual.turbines.find((entry) => entry.turbineId === 'a')!
    const b = annual.turbines.find((entry) => entry.turbineId === 'b')!
    expect(a.weightedWakeLossFraction).toBeCloseTo(0.1, 12)
    expect(b.weightedWakeLossFraction).toBeCloseTo(0.2, 12)
    // Sorted worst expected loss first, which is what the ranked list reads.
    expect(annual.worstTurbineId).toBe('b')
    expect(b.worst.bearingDeg).toBe(210)
    expect(a.worst.bearingDeg).toBe(270)
  })

  it('rejects an empty or zero-frequency set', () => {
    expect(() => weightConditions([])).toThrow(RangeError)
    expect(() => weightConditions([condition(210, 10, 0, 1000, 900)])).toThrow(RangeError)
  })
})
