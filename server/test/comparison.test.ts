import { describe, expect, it } from 'vitest'

import { compareFarms } from '../src/lib/comparison.js'
import type { FarmAnalysis, TurbineAnalysis } from '../src/lib/farmAnalysis.js'

/** A turbine analysis with only the fields the comparison reads, so intent stays visible. */
function turbine(overrides: Partial<TurbineAnalysis> & { turbineId: string }): TurbineAnalysis {
  return {
    eastingM: 0,
    northingM: 0,
    groundElevationM: 0,
    hubHeightM: 100,
    grossSpeedMs: 10,
    incomingSpeedMs: 10,
    deficit: 0,
    thrustCoefficient: 0.8,
    netPowerKw: 1000,
    grossPowerKw: 1000,
    wakeLossKw: 0,
    wakeLossFraction: 0,
    contributors: [],
    dominantContributorId: null,
    wakePath: [],
    ...overrides,
  }
}

function farm(turbines: TurbineAnalysis[]): FarmAnalysis {
  const totalGrossPowerKw = turbines.reduce((sum, entry) => sum + entry.grossPowerKw, 0)
  const totalNetPowerKw = turbines.reduce((sum, entry) => sum + entry.netPowerKw, 0)
  const totalWakeLossKw = totalGrossPowerKw - totalNetPowerKw
  const worst = [...turbines].sort((a, b) => b.wakeLossFraction - a.wakeLossFraction)[0]
  return {
    turbines,
    totalNetPowerKw,
    totalGrossPowerKw,
    totalWakeLossKw,
    wakeLossFraction: totalGrossPowerKw > 0 ? totalWakeLossKw / totalGrossPowerKw : 0,
    worstTurbineId: worst?.turbineId ?? null,
    operatingCt: new Map(),
  }
}

describe('compareFarms', () => {
  const baseline = farm([
    turbine({ turbineId: 'a', netPowerKw: 1000, grossPowerKw: 1000 }),
    turbine({
      turbineId: 'b',
      netPowerKw: 600,
      grossPowerKw: 1000,
      wakeLossKw: 400,
      wakeLossFraction: 0.4,
      incomingSpeedMs: 8,
      dominantContributorId: 'a',
    }),
  ])

  it('differences every turbine as candidate minus baseline', () => {
    const candidate = farm([
      turbine({ turbineId: 'a', netPowerKw: 1000, grossPowerKw: 1000 }),
      turbine({
        turbineId: 'b',
        netPowerKw: 800,
        grossPowerKw: 1000,
        wakeLossKw: 200,
        wakeLossFraction: 0.2,
        incomingSpeedMs: 9,
        dominantContributorId: 'a',
      }),
    ])
    const result = compareFarms(baseline, candidate)
    const b = result.turbines.find((delta) => delta.turbineId === 'b')!

    expect(b.deltaNetPowerKw).toBe(200)
    expect(b.deltaWakeLossFraction).toBeCloseTo(-0.2, 12)
    expect(b.deltaIncomingSpeedMs).toBe(1)
    // The two have opposite senses: more power is better, more loss is worse. Anything that
    // renders these has to label the direction rather than colour it.
    expect(b.deltaNetPowerKw).toBeGreaterThan(0)
    expect(b.deltaWakeLossFraction).toBeLessThan(0)
    expect(result.deltaTotalNetPowerKw).toBe(200)
  })

  it('answers T3 with worstTurbineChanged', () => {
    const same = compareFarms(baseline, baseline)
    expect(same.worstTurbineChanged).toBe(false)
    expect(same.deltaTotalNetPowerKw).toBe(0)

    const swapped = farm([
      turbine({
        turbineId: 'a',
        netPowerKw: 500,
        grossPowerKw: 1000,
        wakeLossKw: 500,
        wakeLossFraction: 0.5,
        dominantContributorId: 'b',
      }),
      turbine({ turbineId: 'b', netPowerKw: 1000, grossPowerKw: 1000 }),
    ])
    expect(compareFarms(baseline, swapped).worstTurbineChanged).toBe(true)
  })

  it('reports unmatched turbines instead of dropping them', () => {
    // Comparing a 2-turbine layout with a 3-turbine one is a legitimate thing to want. A farm
    // total that silently ignored the extra machine would be the most confidently wrong number
    // in the application.
    const bigger = farm([
      turbine({ turbineId: 'a' }),
      turbine({ turbineId: 'b', netPowerKw: 700, grossPowerKw: 1000, wakeLossKw: 300, wakeLossFraction: 0.3 }),
      turbine({ turbineId: 'c' }),
    ])
    const result = compareFarms(baseline, bigger)
    expect(result.turbines.map((delta) => delta.turbineId).sort()).toEqual(['a', 'b'])
    expect(result.onlyInCandidate).toEqual(['c'])
    expect(result.onlyInBaseline).toEqual([])
    // Farm totals still describe each side whole, so the delta is honest about being between
    // two differently sized farms rather than between the matched subset.
    expect(result.candidateTotalGrossPowerKw).toBe(3000)
    expect(result.baselineTotalGrossPowerKw).toBe(2000)
  })

  it('does not claim the cause changed for a turbine that loses nothing', () => {
    // D28. A turbine standing beside another still registers a deficit of order 1e-6, so the
    // raw dominant contributor flips between null and a neighbour as the wind moves while the
    // loss stays at 0.00%. Reporting that as "the cause changed" would be the single most
    // misleading thing this endpoint could say, because it is the T3 question.
    const before = farm([
      turbine({ turbineId: 'a', wakeLossFraction: 0, dominantContributorId: null }),
      turbine({ turbineId: 'b', wakeLossFraction: 0.4, netPowerKw: 600, wakeLossKw: 400, dominantContributorId: 'a' }),
    ])
    const after = farm([
      turbine({ turbineId: 'a', wakeLossFraction: 1e-6, dominantContributorId: 'b' }),
      turbine({ turbineId: 'b', wakeLossFraction: 0.4, netPowerKw: 600, wakeLossKw: 400, dominantContributorId: 'a' }),
    ])
    const result = compareFarms(before, after)
    const a = result.turbines.find((delta) => delta.turbineId === 'a')!
    expect(a.dominantContributorChanged).toBe(false)
    expect(a.candidateDominantContributorId).toBeNull()
  })

  it('still reports a real change of cause', () => {
    const after = farm([
      turbine({ turbineId: 'a', wakeLossFraction: 0.3, netPowerKw: 700, wakeLossKw: 300, dominantContributorId: 'b' }),
      turbine({ turbineId: 'b', wakeLossFraction: 0.4, netPowerKw: 600, wakeLossKw: 400, dominantContributorId: 'a' }),
    ])
    const a = compareFarms(baseline, after).turbines.find((delta) => delta.turbineId === 'a')!
    expect(a.dominantContributorChanged).toBe(true)
    expect(a.candidateDominantContributorId).toBe('b')
  })

  it('names the largest mover by absolute change', () => {
    const candidate = farm([
      turbine({ turbineId: 'a', netPowerKw: 950, grossPowerKw: 1000, wakeLossKw: 50, wakeLossFraction: 0.05 }),
      turbine({ turbineId: 'b', netPowerKw: 900, grossPowerKw: 1000, wakeLossKw: 100, wakeLossFraction: 0.1 }),
    ])
    // b moved +300, a moved -50. Largest by magnitude, not by sign.
    expect(compareFarms(baseline, candidate).largestMoverId).toBe('b')
  })

  it('ranks rows by the candidate loss, worst first', () => {
    const candidate = farm([
      turbine({ turbineId: 'a', netPowerKw: 100, grossPowerKw: 1000, wakeLossKw: 900, wakeLossFraction: 0.9 }),
      turbine({ turbineId: 'b', netPowerKw: 900, grossPowerKw: 1000, wakeLossKw: 100, wakeLossFraction: 0.1 }),
    ])
    expect(compareFarms(baseline, candidate).turbines.map((delta) => delta.turbineId)).toEqual(['a', 'b'])
  })
})
