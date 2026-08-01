/**
 * Simulated annealing, as the pure functions the worker composes.
 *
 * The report chose annealing over brute force (too expensive) and hill climbing (gets
 * stuck in local maxima), and describes a temperature "which ranges from 0-2 and
 * decreases as the operation progresses", with new locations accepted according to a
 * probability function of the two wind speeds and that temperature.
 *
 * Everything here is deterministic given a seed, which is what makes the worker
 * testable: the same request replays the same walk every time.
 */

export interface Bounds {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export interface Point {
  latitude: number
  longitude: number
}

/** Starting temperature, per the report's stated 0–2 range. */
export const INITIAL_TEMPERATURE = 2

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Seeded rather than `Math.random()` so an optimization run is reproducible: the same
 * request id always walks the same path, which makes failures debuggable and lets the
 * tests assert on exact sequences.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal sample via Box-Muller. */
export function gaussian(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Temperature after `evaluated` of `total` iterations: a linear ramp from
 * INITIAL_TEMPERATURE down to 0.
 *
 * Linear rather than geometric because the schedule has to reach true zero by the last
 * iteration — the run must end greedy, or the reported "best" location can be one the
 * walk wandered away from at the end.
 */
export function temperatureAt(
  evaluated: number,
  total: number,
  initial: number = INITIAL_TEMPERATURE,
): number {
  if (total <= 0) return 0
  const remaining = 1 - evaluated / total
  return Math.max(0, initial * remaining)
}

/**
 * Probability of moving to a candidate location.
 *
 * Scores are capacity factors in [0, 1], which is what makes a bare exp(Δ/T) meaningful:
 * a raw power figure in kW would put Δ in the hundreds and saturate the exponential.
 *
 * An improvement is always taken. A worse location is taken with probability exp(Δ/T),
 * so early on (T=2) a 10-point capacity-factor drop is accepted ~95% of the time, and by
 * the end (T→0) it is never accepted.
 */
export function acceptanceProbability(
  currentScore: number,
  candidateScore: number,
  temperature: number,
): number {
  if (candidateScore >= currentScore) return 1
  if (temperature <= 0) return 0
  return Math.exp((candidateScore - currentScore) / temperature)
}

/**
 * Fold a value back inside [min, max] by reflecting off the edges.
 *
 * Clamping would be simpler but biases the walk: every proposal that overshoots piles up
 * exactly on the boundary, so the search spends disproportionate time on the edges of
 * the selected area.
 */
export function reflect(value: number, min: number, max: number): number {
  if (max <= min) return min
  const span = max - min
  const period = 2 * span
  let offset = (value - min) % period
  if (offset < 0) offset += period
  return min + (offset <= span ? offset : period - offset)
}

/** Uniformly random point inside the bounds — used to seed the walk. */
export function randomPoint(bounds: Bounds, rng: () => number): Point {
  return {
    latitude: bounds.minLat + rng() * (bounds.maxLat - bounds.minLat),
    longitude: bounds.minLon + rng() * (bounds.maxLon - bounds.minLon),
  }
}

/**
 * Propose a neighbour of `current`, taking bigger steps while hot.
 *
 * Step size scales with temperature so the walk explores the whole area early and
 * refines locally once it has cooled — the exploration/exploitation trade-off that makes
 * annealing beat hill climbing.
 */
export function proposeNeighbour(
  current: Point,
  bounds: Bounds,
  temperature: number,
  rng: () => number,
  initial: number = INITIAL_TEMPERATURE,
): Point {
  const heat = initial > 0 ? Math.min(Math.max(temperature / initial, 0), 1) : 0
  // 8% of the span when cold, 40% when hot.
  const scale = 0.08 + 0.32 * heat

  const latSpan = bounds.maxLat - bounds.minLat
  const lonSpan = bounds.maxLon - bounds.minLon

  return {
    latitude: reflect(current.latitude + gaussian(rng) * latSpan * scale, bounds.minLat, bounds.maxLat),
    longitude: reflect(
      current.longitude + gaussian(rng) * lonSpan * scale,
      bounds.minLon,
      bounds.maxLon,
    ),
  }
}

export function isInsideBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.latitude >= bounds.minLat &&
    point.latitude <= bounds.maxLat &&
    point.longitude >= bounds.minLon &&
    point.longitude <= bounds.maxLon
  )
}
