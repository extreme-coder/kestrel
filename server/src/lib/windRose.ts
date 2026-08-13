/**
 * Direction distribution at a site, and the sector a siting decision should be judged over.
 *
 * Everything upstream of this module answers "what happens at one bearing". That is the
 * wrong unit for a decision: `docs/design/alternate-bearing.md` found that a 5 degree change
 * nearly halves the demonstration farm's wake loss, so a single-bearing figure describes one
 * condition and not an expectation. A rose is what turns a set of per-bearing answers into
 * one annual answer, and it is also what the T3 bearing rule needs — "the site's common wind
 * sector" was assumed from the campaign until now, because the ERA5 client fetched speeds
 * and not directions.
 *
 * Pure: a `WindSeries` in, bins out. No database, no network, no clock.
 */

import type { WindSeries } from './openmeteo.js'
import { normaliseBearing } from './openmeteo.js'

/**
 * Default sector count.
 *
 * 12 sectors of 30 degrees, so each spans its centre plus or minus 15. That is not a round
 * number chosen for looks: plus or minus 15 degrees is the width of the only sector the wake
 * model has ever been anchored over (Horns Rev 1, D24), and over plus or minus 2.5 degrees
 * the same dataset moves measured farm efficiency by 9 points for reasons the source places
 * in the measurements rather than in any model. Binning finer than the anchor would report a
 * directional resolution nothing has established.
 */
export const DEFAULT_SECTOR_COUNT = 12

/**
 * Width of the speed bins inside each sector, m/s.
 *
 * A rose that recorded only a representative speed per direction would be cheaper and would
 * also be wrong in a way that hides itself. A power curve is flat above rated, so a sector
 * whose representative speed lands above rated reports **zero** wake loss — the deficit is
 * still there, the turbine is simply power-limited. Askervein's dominant sector has an
 * energy-equivalent speed of 13.1 m/s against the V112's 12.5 m/s rated, so exactly that
 * happened: weighting on one speed per sector reported 0.00% loss at 210 degrees, the bearing
 * the whole demonstration is built around.
 *
 * 1 m/s resolves the knee. Wider bins put the rated speed inside a bin and reintroduce the
 * same error in miniature, because the average of a curve is not the curve of an average.
 */
export const DEFAULT_SPEED_BIN_WIDTH_MS = 1

/** Highest speed binned. Above this ERA5 hours are vanishingly rare and past every cut-out. */
export const MAX_BINNED_SPEED_MS = 40

/** Which of the two reported ERA5 levels a rose is built from. */
export type RoseHeight = '10m' | '100m'

export interface WindRoseSpeedBin {
  fromMs: number
  toMs: number
  meanSpeedMs: number
  /** Cube-mean speed of the hours in this bin — the one that preserves their wind power. */
  energySpeedMs: number
  hours: number
  /**
   * Share of **all** hours in the rose, not of the sector.
   *
   * Joint rather than conditional so a weighted sum needs no division by a sector total, and
   * so a partial set of bins still carries its own weight honestly.
   */
  frequency: number
}

export interface WindRoseSector {
  /** 0-based, counting clockwise from the sector centred on north. */
  index: number
  /** Sector centre, degrees clockwise from north, meteorological "from" convention. */
  centreDeg: number
  /** Sector edges. `fromDeg` exceeds `toDeg` for the sector that straddles north. */
  fromDeg: number
  toDeg: number
  hours: number
  /** Share of all hours in this sector, in [0, 1]. */
  frequency: number
  /** Arithmetic mean speed of the hours in this sector, m/s. */
  meanSpeedMs: number
  /**
   * Speed carrying this sector's mean wind power density: the cube root of the mean cube.
   *
   * The right representative speed when one bearing has to stand in for a whole sector,
   * because it preserves the wind power available in it. The arithmetic mean does not — it
   * under-reads a gusty sector, and wake losses are largest where the energy is.
   */
  energySpeedMs: number
  /** Share of the site's total wind power density that arrives in this sector, in [0, 1]. */
  energyShare: number
  /**
   * How the sector's hours are distributed across speed, ascending. Empty bins are omitted.
   *
   * This is what makes a weighted loss meaningful rather than merely weighted — see
   * `DEFAULT_SPEED_BIN_WIDTH_MS`.
   */
  speedBins: WindRoseSpeedBin[]
}

export interface WindRose {
  /** Grid cell the series resolved to, carried through so a rose can be traced to its cell. */
  latitude: number
  longitude: number
  startDate: string
  endDate: string
  height: RoseHeight
  sectorWidthDeg: number
  speedBinWidthMs: number
  /** Hours that went into the rose, after ERA5 gaps were dropped. */
  hours: number
  meanSpeedMs: number
  sectors: WindRoseSector[]
  /** Index of the sector carrying the most wind power density, not the most hours. */
  dominantSectorIndex: number
}

export interface BuildWindRoseOptions {
  sectors?: number
  height?: RoseHeight
  speedBinWidthMs?: number
  /** Echoed into the rose so a stored one records the window it covers. */
  startDate?: string
  endDate?: string
}

/** The contiguous arc of sectors a siting decision is judged over. */
export interface CommonSector {
  fromDeg: number
  toDeg: number
  /** Sector indices in the arc, in clockwise order, wrapping through north if it does. */
  sectorIndices: number[]
  widthDeg: number
  /** Share of the site's wind power density inside the arc. */
  energyShare: number
  /** Share of the site's hours inside the arc. */
  frequency: number
  /** Centre of the arc, the single bearing that best represents it. */
  centreDeg: number
}

/**
 * Fraction of the site's wind energy the common sector has to contain.
 *
 * Half is a judgement, and the reason it is defensible is that the sector is used to bound a
 * *search* — which bearings are worth asking the T3 question at — rather than to weight a
 * result. Weighting uses the whole rose. A lower threshold would let a genuinely bimodal site
 * report one arc and hide the other; a much higher one degenerates toward "all directions",
 * which is not a sector at all.
 */
export const DEFAULT_SECTOR_COVERAGE = 0.5

function speedAt(sample: WindSeries['samples'][number], height: RoseHeight): number {
  return height === '10m' ? sample.windSpeed10mMs : sample.windSpeed100mMs
}

function directionAt(sample: WindSeries['samples'][number], height: RoseHeight): number {
  return height === '10m' ? sample.windDirection10mDeg : sample.windDirection100mDeg
}

/**
 * Bin an hourly series by wind direction.
 *
 * Defaults to the 100 m level because that is the closest reported height to a modern hub,
 * and direction veers with height — using the 10 m rose to choose a bearing for a 100 m rotor
 * would bias it by the Ekman turning across the layer between them.
 */
export function buildWindRose(series: WindSeries, options: BuildWindRoseOptions = {}): WindRose {
  const sectorCount = options.sectors ?? DEFAULT_SECTOR_COUNT
  const height = options.height ?? '100m'
  const speedBinWidthMs = options.speedBinWidthMs ?? DEFAULT_SPEED_BIN_WIDTH_MS

  if (!Number.isInteger(sectorCount) || sectorCount < 4 || sectorCount > 72) {
    throw new RangeError(`sectors must be an integer in [4, 72], got ${sectorCount}`)
  }
  if (!(speedBinWidthMs > 0 && speedBinWidthMs <= MAX_BINNED_SPEED_MS)) {
    throw new RangeError(`speedBinWidthMs must be in (0, ${MAX_BINNED_SPEED_MS}], got ${speedBinWidthMs}`)
  }
  if (series.samples.length === 0) {
    throw new RangeError('cannot build a wind rose from an empty series')
  }

  const width = 360 / sectorCount
  const binCount = Math.ceil(MAX_BINNED_SPEED_MS / speedBinWidthMs)
  const hours = new Array<number>(sectorCount).fill(0)
  const speedSums = new Array<number>(sectorCount).fill(0)
  const cubeSums = new Array<number>(sectorCount).fill(0)
  // Flat [sector][bin] accumulators — a matrix rather than nested arrays because the sparse
  // half of it is dropped on the way out anyway.
  const binHours = new Array<number>(sectorCount * binCount).fill(0)
  const binSpeedSums = new Array<number>(sectorCount * binCount).fill(0)
  const binCubeSums = new Array<number>(sectorCount * binCount).fill(0)

  let totalSpeed = 0
  let totalCube = 0

  for (const sample of series.samples) {
    const speed = speedAt(sample, height)
    // Offsetting by half a sector before flooring puts each bin's *centre* on its nominal
    // bearing. Without it a "north" sector would run 0-30 degrees and the rose would be
    // rotated half a bin against every published convention.
    const bearing = normaliseBearing(directionAt(sample, height) + width / 2)
    const index = Math.min(sectorCount - 1, Math.floor(bearing / width))
    const cube = speed ** 3

    hours[index]!++
    speedSums[index]! += speed
    cubeSums[index]! += cube
    totalSpeed += speed
    totalCube += cube

    const bin = Math.min(binCount - 1, Math.max(0, Math.floor(speed / speedBinWidthMs)))
    const cell = index * binCount + bin
    binHours[cell]!++
    binSpeedSums[cell]! += speed
    binCubeSums[cell]! += cube
  }

  const totalHours = series.samples.length
  const sectors: WindRoseSector[] = []
  for (let index = 0; index < sectorCount; index++) {
    const count = hours[index]!
    const centre = index * width

    const speedBins: WindRoseSpeedBin[] = []
    for (let bin = 0; bin < binCount; bin++) {
      const cell = index * binCount + bin
      const binCount_ = binHours[cell]!
      if (binCount_ === 0) continue
      speedBins.push({
        fromMs: bin * speedBinWidthMs,
        toMs: (bin + 1) * speedBinWidthMs,
        meanSpeedMs: binSpeedSums[cell]! / binCount_,
        energySpeedMs: (binCubeSums[cell]! / binCount_) ** (1 / 3),
        hours: binCount_,
        frequency: binCount_ / totalHours,
      })
    }

    sectors.push({
      index,
      centreDeg: centre,
      fromDeg: normaliseBearing(centre - width / 2),
      toDeg: normaliseBearing(centre + width / 2),
      hours: count,
      frequency: count / totalHours,
      meanSpeedMs: count > 0 ? speedSums[index]! / count : 0,
      energySpeedMs: count > 0 ? (cubeSums[index]! / count) ** (1 / 3) : 0,
      energyShare: totalCube > 0 ? cubeSums[index]! / totalCube : 0,
      speedBins,
    })
  }

  let dominantSectorIndex = 0
  for (const sector of sectors) {
    if (sector.energyShare > sectors[dominantSectorIndex]!.energyShare) dominantSectorIndex = sector.index
  }

  return {
    latitude: series.latitude,
    longitude: series.longitude,
    startDate: options.startDate ?? '',
    endDate: options.endDate ?? '',
    height,
    sectorWidthDeg: width,
    speedBinWidthMs,
    hours: totalHours,
    meanSpeedMs: totalSpeed / totalHours,
    sectors,
    dominantSectorIndex,
  }
}

/**
 * The narrowest contiguous arc of whole sectors carrying at least `coverage` of the energy.
 *
 * Energy rather than hours, deliberately. A sector that blows often and gently and a sector
 * that blows rarely and hard are not equally interesting to a siting decision, and wake
 * losses scale with the wind the array is actually working in. Ranking by hours would point
 * the T3 question at the calmest common direction.
 *
 * Ties on width break toward the higher energy share, then toward the lower start index, so
 * the result is deterministic for a symmetric rose rather than dependent on iteration order.
 */
export function commonSector(rose: WindRose, coverage: number = DEFAULT_SECTOR_COVERAGE): CommonSector {
  if (!(coverage > 0 && coverage <= 1)) {
    throw new RangeError(`coverage must be in (0, 1], got ${coverage}`)
  }
  const count = rose.sectors.length
  let best: { start: number; length: number; energy: number; frequency: number } | null = null

  for (let start = 0; start < count; start++) {
    let energy = 0
    let frequency = 0
    for (let length = 1; length <= count; length++) {
      const sector = rose.sectors[(start + length - 1) % count]!
      energy += sector.energyShare
      frequency += sector.frequency
      if (energy + 1e-12 < coverage) continue
      if (
        best === null ||
        length < best.length ||
        (length === best.length && energy > best.energy + 1e-12)
      ) {
        best = { start, length, energy, frequency }
      }
      break
    }
  }

  // Only reachable if every sector is empty, which `buildWindRose` already rejects.
  if (!best) throw new RangeError('no contiguous sector reaches the requested coverage')

  const sectorIndices = Array.from({ length: best.length }, (_, offset) => (best.start + offset) % count)
  const widthDeg = best.length * rose.sectorWidthDeg
  const fromDeg = normaliseBearing(best.start * rose.sectorWidthDeg - rose.sectorWidthDeg / 2)
  return {
    fromDeg,
    toDeg: normaliseBearing(fromDeg + widthDeg),
    sectorIndices,
    widthDeg,
    energyShare: best.energy,
    frequency: best.frequency,
    centreDeg: normaliseBearing(fromDeg + widthDeg / 2),
  }
}

/**
 * Every whole-degree bearing inside a common sector, at a given step.
 *
 * Walks from `fromDeg` so it crosses north correctly; a naive `for (b = from; b <= to; b++)`
 * produces an empty list for any sector that straddles 0.
 */
export function sectorBearings(sector: Pick<CommonSector, 'fromDeg' | 'widthDeg'>, stepDeg: number): number[] {
  if (!(stepDeg > 0)) throw new RangeError(`stepDeg must be positive, got ${stepDeg}`)
  const bearings: number[] = []
  for (let offset = 0; offset <= sector.widthDeg + 1e-9; offset += stepDeg) {
    bearings.push(normaliseBearing(sector.fromDeg + offset))
  }
  return bearings
}

/** snake_case projection for the JSON API and for stored rose fixtures. */
export function serialiseWindRose(rose: WindRose, sector: CommonSector) {
  return {
    latitude: rose.latitude,
    longitude: rose.longitude,
    start_date: rose.startDate,
    end_date: rose.endDate,
    height: rose.height,
    hours: rose.hours,
    sector_width_deg: rose.sectorWidthDeg,
    speed_bin_width_ms: rose.speedBinWidthMs,
    mean_speed_ms: rose.meanSpeedMs,
    dominant_sector_index: rose.dominantSectorIndex,
    sectors: rose.sectors.map((entry) => ({
      index: entry.index,
      centre_deg: entry.centreDeg,
      from_deg: entry.fromDeg,
      to_deg: entry.toDeg,
      hours: entry.hours,
      frequency: entry.frequency,
      mean_speed_ms: entry.meanSpeedMs,
      energy_speed_ms: entry.energySpeedMs,
      energy_share: entry.energyShare,
      speed_bins: entry.speedBins.map((bin) => ({
        from_ms: bin.fromMs,
        to_ms: bin.toMs,
        mean_speed_ms: bin.meanSpeedMs,
        energy_speed_ms: bin.energySpeedMs,
        hours: bin.hours,
        frequency: bin.frequency,
      })),
    })),
    common_sector: {
      from_deg: sector.fromDeg,
      to_deg: sector.toDeg,
      centre_deg: sector.centreDeg,
      width_deg: sector.widthDeg,
      energy_share: sector.energyShare,
      frequency: sector.frequency,
      sector_indices: [...sector.sectorIndices],
    },
  }
}
