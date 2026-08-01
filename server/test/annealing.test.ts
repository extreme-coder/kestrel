import { describe, expect, it } from 'vitest'

import {
  INITIAL_TEMPERATURE,
  acceptanceProbability,
  gaussian,
  isInsideBounds,
  mulberry32,
  proposeNeighbour,
  randomPoint,
  reflect,
  temperatureAt,
} from '../src/lib/annealing.js'

const BOUNDS = { minLat: 50, maxLat: 51, minLon: -1, maxLon: 0 }

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) expect(a()).toBe(b())
  })

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('stays in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 10_000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is roughly uniform', () => {
    const rng = mulberry32(99)
    const buckets = new Array(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i++) buckets[Math.floor(rng() * 10)]++
    for (const count of buckets) expect(Math.abs(count - n / 10) / (n / 10)).toBeLessThan(0.05)
  })
})

describe('gaussian', () => {
  it('has approximately zero mean and unit variance', () => {
    const rng = mulberry32(5)
    const n = 50_000
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const g = gaussian(rng)
      sum += g
      sumSq += g * g
    }
    const mean = sum / n
    const variance = sumSq / n - mean * mean
    expect(Math.abs(mean)).toBeLessThan(0.02)
    expect(variance).toBeGreaterThan(0.95)
    expect(variance).toBeLessThan(1.05)
  })
})

describe('temperatureAt', () => {
  it('starts at the initial temperature and reaches zero at the end', () => {
    expect(temperatureAt(0, 100)).toBeCloseTo(INITIAL_TEMPERATURE, 9)
    expect(temperatureAt(100, 100)).toBe(0)
  })

  it('decreases monotonically', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let k = 0; k <= 50; k++) {
      const t = temperatureAt(k, 50)
      expect(t).toBeLessThanOrEqual(previous)
      previous = t
    }
  })

  it('is halfway down at the halfway point', () => {
    expect(temperatureAt(50, 100)).toBeCloseTo(INITIAL_TEMPERATURE / 2, 9)
  })

  it('never returns a negative temperature', () => {
    expect(temperatureAt(150, 100)).toBe(0)
    expect(temperatureAt(1, 0)).toBe(0)
  })
})

describe('acceptanceProbability', () => {
  it('always accepts an improvement', () => {
    expect(acceptanceProbability(0.4, 0.5, 2)).toBe(1)
    expect(acceptanceProbability(0.4, 0.5, 0)).toBe(1)
    expect(acceptanceProbability(0.4, 0.4, 0.001)).toBe(1)
  })

  it('accepts a worse location readily while hot', () => {
    // 10 capacity-factor points worse, at the starting temperature.
    expect(acceptanceProbability(0.5, 0.4, 2)).toBeCloseTo(Math.exp(-0.05), 9)
    expect(acceptanceProbability(0.5, 0.4, 2)).toBeGreaterThan(0.9)
  })

  it('becomes greedy as it cools', () => {
    const hot = acceptanceProbability(0.5, 0.4, 2)
    const warm = acceptanceProbability(0.5, 0.4, 0.5)
    const cold = acceptanceProbability(0.5, 0.4, 0.02)
    expect(hot).toBeGreaterThan(warm)
    expect(warm).toBeGreaterThan(cold)
    expect(cold).toBeLessThan(0.01)
  })

  it('refuses any downhill move at zero temperature', () => {
    expect(acceptanceProbability(0.5, 0.4, 0)).toBe(0)
    expect(acceptanceProbability(0.5, 0.4999, 0)).toBe(0)
  })

  it('punishes bigger drops harder at the same temperature', () => {
    expect(acceptanceProbability(0.5, 0.45, 1)).toBeGreaterThan(
      acceptanceProbability(0.5, 0.2, 1),
    )
  })
})

describe('reflect', () => {
  it('leaves values inside the range alone', () => {
    expect(reflect(5, 0, 10)).toBe(5)
    expect(reflect(0, 0, 10)).toBe(0)
    expect(reflect(10, 0, 10)).toBe(10)
  })

  it('mirrors an overshoot back inside', () => {
    expect(reflect(12, 0, 10)).toBeCloseTo(8, 9)
    expect(reflect(-3, 0, 10)).toBeCloseTo(3, 9)
  })

  it('handles repeated reflection without escaping', () => {
    for (const v of [-100, -37.5, 123.4, 1e6, -1e6]) {
      const r = reflect(v, 0, 10)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(10)
    }
  })

  it('collapses a degenerate range to its single value', () => {
    expect(reflect(5, 3, 3)).toBe(3)
  })

  it('does not pile values up on the boundary the way clamping would', () => {
    // Feed a spread of overshoots; a clamp would map them all to exactly 10.
    const results = [10.5, 11, 12, 13, 14].map((v) => reflect(v, 0, 10))
    expect(new Set(results).size).toBe(results.length)
    expect(results.every((r) => r < 10)).toBe(true)
  })
})

describe('randomPoint', () => {
  it('always lands inside the bounds', () => {
    const rng = mulberry32(3)
    for (let i = 0; i < 1000; i++) {
      expect(isInsideBounds(randomPoint(BOUNDS, rng), BOUNDS)).toBe(true)
    }
  })

  it('is reproducible for a seed', () => {
    expect(randomPoint(BOUNDS, mulberry32(11))).toEqual(randomPoint(BOUNDS, mulberry32(11)))
  })
})

describe('proposeNeighbour', () => {
  const centre = { latitude: 50.5, longitude: -0.5 }

  it('never proposes a point outside the bounds', () => {
    const rng = mulberry32(13)
    for (let i = 0; i < 2000; i++) {
      const t = (i % 21) / 10 // sweep the whole temperature range
      const next = proposeNeighbour(centre, BOUNDS, t, rng)
      expect(isInsideBounds(next, BOUNDS), `escaped at T=${t}`).toBe(true)
    }
  })

  it('takes larger steps while hot than when cold', () => {
    const meanStep = (temperature: number) => {
      const rng = mulberry32(17)
      let total = 0
      const n = 2000
      for (let i = 0; i < n; i++) {
        const next = proposeNeighbour(centre, BOUNDS, temperature, rng)
        total += Math.hypot(next.latitude - centre.latitude, next.longitude - centre.longitude)
      }
      return total / n
    }

    expect(meanStep(INITIAL_TEMPERATURE)).toBeGreaterThan(meanStep(0.2) * 2)
  })

  it('still moves at zero temperature, so the walk can refine locally', () => {
    const rng = mulberry32(19)
    const next = proposeNeighbour(centre, BOUNDS, 0, rng)
    expect(next).not.toEqual(centre)
    expect(isInsideBounds(next, BOUNDS)).toBe(true)
  })

  it('is reproducible for a seed', () => {
    expect(proposeNeighbour(centre, BOUNDS, 1, mulberry32(23))).toEqual(
      proposeNeighbour(centre, BOUNDS, 1, mulberry32(23)),
    )
  })
})

describe('annealing beats hill climbing on a deceptive landscape', () => {
  /**
   * The report's stated reason for choosing annealing is that hill climbing "may not
   * find the global maximum but instead get stuck in a local maximum". This asserts that
   * claim actually holds for this implementation, on a landscape with a broad decoy peak
   * near the start and a taller global peak far from it.
   */
  const score = (p: { latitude: number; longitude: number }) => {
    const decoy = 0.45 * Math.exp(-(((p.latitude - 50.2) ** 2 + (p.longitude + 0.8) ** 2) / 0.02))
    const global = 0.62 * Math.exp(-(((p.latitude - 50.85) ** 2 + (p.longitude + 0.15) ** 2) / 0.004))
    return decoy + global
  }

  const walk = (seed: number, iterations: number, greedy: boolean) => {
    const rng = mulberry32(seed)
    let current = { latitude: 50.2, longitude: -0.8 } // start on the decoy
    let currentScore = score(current)
    let best = current
    let bestScore = currentScore

    for (let k = 0; k < iterations; k++) {
      const temperature = greedy ? 0 : temperatureAt(k, iterations)
      const candidate = proposeNeighbour(current, BOUNDS, temperature, rng)
      const candidateScore = score(candidate)
      if (rng() < acceptanceProbability(currentScore, candidateScore, temperature)) {
        current = candidate
        currentScore = candidateScore
      }
      if (candidateScore > bestScore) {
        best = candidate
        bestScore = candidateScore
      }
    }
    return bestScore
  }

  it('finds the taller peak more often than a greedy walk does', () => {
    const trials = 40
    const iterations = 150
    let annealWins = 0
    let greedyWins = 0

    for (let seed = 1; seed <= trials; seed++) {
      // The global peak is 0.62; the decoy tops out at 0.45.
      if (walk(seed, iterations, false) > 0.5) annealWins++
      if (walk(seed, iterations, true) > 0.5) greedyWins++
    }

    expect(annealWins).toBeGreaterThan(greedyWins)
  })
})
