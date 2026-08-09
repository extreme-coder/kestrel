/**
 * Farm layout synthesis.
 *
 * No real layout survived the Windsim loss (see D1), and the API's own annealer is the
 * natural source of one eventually. Until then a layout is *synthesized* from a spec
 * (D18), which is better than a fixture in one specific way: layout becomes a
 * **parameter**. The viewer's direction scrubber and its "which turbine is stealing whose
 * energy" task both want to vary spacing and array depth, and a hard-coded array of
 * coordinates cannot be varied.
 *
 * The output is `FarmTurbine[]` in the same local metric frame `wake.ts` consumes —
 * metres east and north of an origin — so a layout drops straight into `evaluateFarm` and
 * into `POST /api/field`'s grid sampling.
 *
 * ## The grid is oriented to the wind, not to north
 *
 * Real farms are laid out against the prevailing wind: rows run *across* it so that each
 * row shadows as few machines as possible, and the generous spacing is spent along the
 * wind direction where wakes actually travel. Hence the two spacings are named
 * `crosswind` and `downwind` rather than `x` and `y`, and the whole grid rotates with
 * `prevailingBearingDeg`.
 *
 * Conventional spacing — the ranges D18 quotes — is **5–7 D crosswind, 7–10 D downwind**,
 * where D is the rotor diameter. That asymmetry *is* the wake model's conclusion applied
 * to siting: a wake recovers with downstream distance, so distance along the wind buys
 * more energy than distance across it, while land or seabed area costs the same either
 * way. Spacing outside those ranges is allowed — tests want tight arrays to make wakes
 * obvious — but the defaults sit inside them.
 *
 * ## What this does not do
 *
 * - **No terrain.** Turbines sit at hub height above a flat plane; there is no ground
 *   elevation in `FarmTurbine` yet. Real siting follows ridges, and the DEM terrain of
 *   D17 will make that visible. When elevation lands, it belongs here as well as in the
 *   scene, because a ridge-following layout is not a rotated grid.
 * - **No exclusion zones, no boundary polygon.** A real site is a permit boundary with
 *   holes in it. This generates a full rectangular array.
 * - **No optimization.** The annealer is the optimizer; this is a plausible starting
 *   layout, not a good one.
 */

import type { FarmTurbine } from './wake.js'
import { windTravelVector } from './wake.js'
import type { TurbineModel } from './turbines.js'

/**
 * Default crosswind spacing, in rotor diameters — mid-range of the conventional 5–7 D.
 */
export const DEFAULT_CROSSWIND_SPACING_D = 6

/**
 * Default downwind spacing, in rotor diameters — mid-range of the conventional 7–10 D.
 */
export const DEFAULT_DOWNWIND_SPACING_D = 8

/**
 * Default prevailing bearing: 270°, a westerly.
 *
 * Chosen because it makes easting the downwind axis, which keeps hand-checked geometry
 * readable, and because it is the prevailing direction over most of the North Sea and
 * north-west Europe — where the turbine catalogue's machines were actually installed.
 * Override it per site once one is chosen.
 */
export const DEFAULT_PREVAILING_BEARING_DEG = 270

export interface GridLayoutSpec {
  /** Every turbine in the array is this model. Real farms are near-always single-model. */
  model: TurbineModel
  /** Rows counted *along* the wind: how deep the array is. Must be a positive integer. */
  rows: number
  /** Turbines per row, counted *across* the wind. Must be a positive integer. */
  columns: number
  /** Spacing across the wind, in rotor diameters. Defaults to 6 D. */
  crosswindSpacingD?: number
  /** Spacing along the wind, in rotor diameters. Defaults to 8 D. */
  downwindSpacingD?: number
  /**
   * Meteorological bearing the prevailing wind blows *from*, in degrees — the same
   * convention as `WakeConditions.bearingDeg`. The array is rotated so its rows lie
   * across this direction. Defaults to 270 (westerly).
   */
  prevailingBearingDeg?: number
  /**
   * Hub height for every turbine, metres above ground.
   *
   * Defaults to the rotor diameter, a standard onshore rule of thumb that lands inside
   * the manufacturer's real options for the catalogue's modern machines (the V112-3450
   * ships at 84/94/119 m for D = 112). Offshore towers are relatively shorter — Horns Rev
   * runs 70 m on an 80 m rotor — so supply this explicitly once a site is chosen.
   */
  hubHeightM?: number
  /**
   * Offset alternate rows across the wind, as a fraction of the crosswind spacing.
   *
   * 0 (the default) gives a plain rectangular grid, where every machine in a row shadows
   * the one directly behind it at the prevailing bearing — the deepest-wake case, and the
   * clearest one to look at. 0.5 offsets alternate rows by half a spacing so a wake lands
   * *between* the two machines behind it, which is closer to how large offshore arrays
   * are actually skewed. The offset is applied symmetrically (±¼ of the spacing about
   * each row's own centre) so the array stays centred on the origin.
   */
  staggerFraction?: number
  /**
   * Layout origin in the local metric frame. The array is centred on it, so the origin is
   * a natural camera target and makes the sampled field volume symmetric. Defaults to
   * (0, 0).
   */
  origin?: { eastingM: number; northingM: number }
  /** Prefix for generated turbine ids. Defaults to `'t'`. */
  idPrefix?: string
}

/** Axis-aligned extent of a layout, plus the length scales a field volume needs. */
export interface LayoutBounds {
  minEastingM: number
  maxEastingM: number
  minNorthingM: number
  maxNorthingM: number
  eastingSpanM: number
  northingSpanM: number
  centreEastingM: number
  centreNorthingM: number
  /** Hub-height range. Not affected by `marginD` — vertical extent is the sampler's call. */
  minHubHeightM: number
  maxHubHeightM: number
  /** Largest rotor diameter present: the natural length scale for margins and grid steps. */
  maxRotorDiameterM: number
}

export interface FarmLayout {
  /** Ordered most-upwind row first at the prevailing bearing, then across each row. */
  turbines: FarmTurbine[]
  rows: number
  columns: number
  /** Resolved spacings in metres — what the HUD should display alongside the D figures. */
  crosswindSpacingM: number
  downwindSpacingM: number
  prevailingBearingDeg: number
  bounds: LayoutBounds
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`)
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`)
  }
}

/**
 * Generate a wind-aligned rectangular array.
 *
 * Ids encode the grid position — `t-r02c05` — rather than a running index. The viewer's
 * central task is naming which turbine wakes which, and "r02c05 is shadowed by r01c05" is
 * legible in a way that "t14 is shadowed by t9" is not.
 */
export function generateGridLayout(spec: GridLayoutSpec): FarmLayout {
  const {
    model,
    rows,
    columns,
    crosswindSpacingD = DEFAULT_CROSSWIND_SPACING_D,
    downwindSpacingD = DEFAULT_DOWNWIND_SPACING_D,
    prevailingBearingDeg = DEFAULT_PREVAILING_BEARING_DEG,
    hubHeightM = model.rotorDiameterM,
    staggerFraction = 0,
    origin = { eastingM: 0, northingM: 0 },
    idPrefix = 't',
  } = spec

  requirePositiveInteger(rows, 'rows')
  requirePositiveInteger(columns, 'columns')
  requirePositiveFinite(crosswindSpacingD, 'crosswindSpacingD')
  requirePositiveFinite(downwindSpacingD, 'downwindSpacingD')
  requirePositiveFinite(hubHeightM, 'hubHeightM')
  requirePositiveFinite(model.rotorDiameterM, 'model.rotorDiameterM')
  if (!Number.isFinite(prevailingBearingDeg)) {
    throw new RangeError(`prevailingBearingDeg must be finite, got ${prevailingBearingDeg}`)
  }
  if (!Number.isFinite(staggerFraction)) {
    throw new RangeError(`staggerFraction must be finite, got ${staggerFraction}`)
  }
  if (!Number.isFinite(origin.eastingM) || !Number.isFinite(origin.northingM)) {
    throw new RangeError('origin must have finite eastingM and northingM')
  }

  const crosswindSpacingM = crosswindSpacingD * model.rotorDiameterM
  const downwindSpacingM = downwindSpacingD * model.rotorDiameterM

  // The downwind axis is the direction the wind travels; the crosswind axis is that
  // rotated a quarter turn, matching `wake.ts`'s wind frame exactly. Reusing
  // `windTravelVector` rather than re-deriving the bearing convention here is deliberate:
  // two independent implementations of "which way does a 270° wind blow" is a bug waiting
  // to happen, and a sign error would show up as a layout that wakes itself sideways.
  const downwind = windTravelVector(prevailingBearingDeg)
  const crosswind = { east: -downwind.north, north: downwind.east }

  const rowDigits = String(rows).length
  const columnDigits = String(columns).length
  const pad = (n: number, width: number) => String(n).padStart(width, '0')

  const turbines: FarmTurbine[] = []
  for (let row = 0; row < rows; row++) {
    // ±¼ spacing about the row's own centre, so the array centroid stays on the origin.
    const stagger = ((row % 2) - 0.5) * staggerFraction * crosswindSpacingM
    const downwindOffsetM = (row - (rows - 1) / 2) * downwindSpacingM

    for (let column = 0; column < columns; column++) {
      const crosswindOffsetM = (column - (columns - 1) / 2) * crosswindSpacingM + stagger

      turbines.push({
        id: `${idPrefix}-r${pad(row + 1, rowDigits)}c${pad(column + 1, columnDigits)}`,
        eastingM:
          origin.eastingM +
          downwindOffsetM * downwind.east +
          crosswindOffsetM * crosswind.east,
        northingM:
          origin.northingM +
          downwindOffsetM * downwind.north +
          crosswindOffsetM * crosswind.north,
        hubHeightM,
        model,
      })
    }
  }

  return {
    turbines,
    rows,
    columns,
    crosswindSpacingM,
    downwindSpacingM,
    prevailingBearingDeg,
    bounds: layoutBounds(turbines),
  }
}

/**
 * Axis-aligned bounds of a set of turbines, optionally padded.
 *
 * `POST /api/field` needs this to size its sample volume, and the padding is why the
 * option exists: a volume clipped to the turbines themselves cuts off exactly the wakes
 * it was built to show. Margin is expressed in rotor diameters because that is the length
 * scale wakes recover over — 10 D is a reasonable default for a downstream margin.
 *
 * Returns a zeroed box for an empty layout rather than ±Infinity, so a caller that sizes
 * a grid from it degrades to an empty volume instead of allocating one.
 */
export function layoutBounds(
  turbines: readonly FarmTurbine[],
  options: { marginD?: number } = {},
): LayoutBounds {
  const { marginD = 0 } = options
  if (!Number.isFinite(marginD) || marginD < 0) {
    throw new RangeError(`marginD must be a non-negative finite number, got ${marginD}`)
  }

  if (turbines.length === 0) {
    return {
      minEastingM: 0,
      maxEastingM: 0,
      minNorthingM: 0,
      maxNorthingM: 0,
      eastingSpanM: 0,
      northingSpanM: 0,
      centreEastingM: 0,
      centreNorthingM: 0,
      minHubHeightM: 0,
      maxHubHeightM: 0,
      maxRotorDiameterM: 0,
    }
  }

  let minEastingM = Infinity
  let maxEastingM = -Infinity
  let minNorthingM = Infinity
  let maxNorthingM = -Infinity
  let minHubHeightM = Infinity
  let maxHubHeightM = -Infinity
  let maxRotorDiameterM = 0

  for (const t of turbines) {
    minEastingM = Math.min(minEastingM, t.eastingM)
    maxEastingM = Math.max(maxEastingM, t.eastingM)
    minNorthingM = Math.min(minNorthingM, t.northingM)
    maxNorthingM = Math.max(maxNorthingM, t.northingM)
    minHubHeightM = Math.min(minHubHeightM, t.hubHeightM)
    maxHubHeightM = Math.max(maxHubHeightM, t.hubHeightM)
    maxRotorDiameterM = Math.max(maxRotorDiameterM, t.model.rotorDiameterM)
  }

  const margin = marginD * maxRotorDiameterM
  minEastingM -= margin
  maxEastingM += margin
  minNorthingM -= margin
  maxNorthingM += margin

  return {
    minEastingM,
    maxEastingM,
    minNorthingM,
    maxNorthingM,
    eastingSpanM: maxEastingM - minEastingM,
    northingSpanM: maxNorthingM - minNorthingM,
    centreEastingM: (minEastingM + maxEastingM) / 2,
    centreNorthingM: (minNorthingM + maxNorthingM) / 2,
    minHubHeightM,
    maxHubHeightM,
    maxRotorDiameterM,
  }
}
