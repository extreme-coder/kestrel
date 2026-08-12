/**
 * External validation of the Gaussian wake model against Horns Rev 1 production data.
 *
 * This closes the gap `testing.md` has carried since the wake model landed: every assertion
 * in `wake.test.ts` is a shape or relationship, and the hand-computed values in it were
 * computed from the same formula the code implements, so a miscalibrated formula would
 * produce a miscalibrated expectation and the test would still pass.
 *
 * ## Compare like with like, or conclude nothing
 *
 * The widely quoted "second row makes about 60% of the first" is a *sector-averaged* figure,
 * and which sector it was averaged over changes the answer more than any model parameter
 * does. Gaumond et al. measured 64.7% farm efficiency over 270 +/- 2.5 degrees and 73.9%
 * over 270 +/- 15 degrees, from the same three years of data.
 *
 * The narrow sector is not the better test despite looking like the cleaner one. Jensen,
 * Larsen and Fuga all under-predict it by 21 percentage points, and the source attributes
 * that to wind-direction uncertainty in the dataset rather than to the models: a 10-minute
 * mean direction carries several degrees of error, so turbines binned into a 5-degree sector
 * spent much of the time in freer flow than the bin implies. Tuning a wake model to close
 * that gap would be fitting to a measurement artefact. The wide sector is the anchor; the
 * narrow one is reported to show the model sits in the same band as the published three.
 */

import { evaluateFarm } from '../wake.js'
import type { FarmTurbine } from '../wake.js'
import { getTurbineModel } from '../turbines.js'

/**
 * Horns Rev 1 as described by Gaumond et al.: 80 Vestas V80-2000 on a 7D parallelogram,
 * 8 rows (A north to H south) by 10 columns (1 west to 10 east), columns turned 7 degrees
 * off the north-south axis.
 *
 * The skew is reconstructed from the published description rather than from surveyed
 * coordinates. It makes no difference to the result: +7, -7 and a plain rectangle give the
 * same sector efficiency to three significant figures, because the sector average is
 * symmetric about the row axis.
 */
export const HORNS_REV = {
  turbineId: 'vestas-v80-2000',
  rows: 8,
  columns: 10,
  spacingD: 7,
  hubHeightM: 70,
  columnSkewDeg: 7,
  /** Ambient turbulence intensity measured at the site for westerly 8 m/s flow. */
  turbulenceIntensity: 0.07,
  freeStreamMs: 8,
  /**
   * Measured farm efficiency at 8 +/- 0.5 m/s, Gaumond et al. Table II, over three years
   * of production data (2005-2007) filtered for flow stationarity.
   */
  measuredEfficiency: { narrow: 0.647, wide: 0.739 },
  /** Published model deviations for the same two sectors, in efficiency percentage points. */
  publishedModelDeviationPp: {
    narrow: { jensen: -20.9, larsen: -20.9, fuga: -21.7 },
    wide: { jensen: 0.4, larsen: -0.1, fuga: -0.3 },
  },
  source:
    'Gaumond, Rethore, Ott, Pena, Bechmann and Hansen (2013), "Evaluation of the wind ' +
    'direction uncertainty and its impact on wake modeling at the Horns Rev offshore wind ' +
    'farm", Wind Energy, doi:10.1002/we.1625. Layout and turbulence intensity from sections ' +
    '2 and 3.1.2; efficiencies and model deviations from Table II.',
} as const

const ROW_LETTERS = 'ABCDEFGH'

/**
 * Build the array in a local metric frame, row A at the north edge.
 *
 * `columnSkewDeg` is overridable so the reconstruction can be tested for influence rather
 * than assumed harmless — it comes from a written description, not surveyed coordinates.
 */
export function hornsRevLayout(columnSkewDeg: number = HORNS_REV.columnSkewDeg): FarmTurbine[] {
  const model = getTurbineModel(HORNS_REV.turbineId)
  if (!model) throw new Error(`missing catalogue entry ${HORNS_REV.turbineId}`)
  const spacingM = HORNS_REV.spacingD * model.rotorDiameterM
  const skew = (columnSkewDeg * Math.PI) / 180
  const turbines: FarmTurbine[] = []
  for (let row = 0; row < HORNS_REV.rows; row++) {
    for (let column = 0; column < HORNS_REV.columns; column++) {
      turbines.push({
        id: `${ROW_LETTERS[row]}${column + 1}`,
        eastingM: column * spacingM + row * spacingM * Math.sin(skew),
        northingM: (HORNS_REV.rows - 1 - row) * spacingM * Math.cos(skew),
        hubHeightM: HORNS_REV.hubHeightM,
        model,
      })
    }
  }
  return turbines
}

export interface SectorResult {
  /** Half-width of the averaging sector, in degrees either side of 270. */
  halfWidthDeg: number
  /** Mean of the per-direction farm efficiencies across the sector. */
  modelled: number
  measured: number
  /** Modelled minus measured, in efficiency percentage points. */
  deviationPp: number
  /** Modelled wake loss as a fraction of the measured wake loss. */
  lossRecovered: number
  /** Mean farm power per column, normalised to the first column. */
  columnProfile: number[]
  directions: number
}

/**
 * Average farm efficiency over a direction sector centred on 270 degrees.
 *
 * Efficiency is farm power over the power the same turbines would make in undisturbed flow,
 * which is what "wind farm efficiency" means in the source. All turbines share a hub height,
 * so the shear exponent cancels out of the ratio and is left at its default.
 */
export function hornsRevSector(
  halfWidthDeg: number,
  stepDeg = 0.5,
  turbines: readonly FarmTurbine[] = hornsRevLayout(),
): SectorResult {
  if (!(halfWidthDeg >= 0) || !(stepDeg > 0)) {
    throw new RangeError('sector half-width must be non-negative and the step positive')
  }
  const columnTotals = new Array<number>(HORNS_REV.columns).fill(0)
  let efficiencySum = 0
  let directions = 0

  for (let offset = -halfWidthDeg; offset <= halfWidthDeg + 1e-9; offset += stepDeg) {
    const result = evaluateFarm(turbines, {
      freeStreamMs: HORNS_REV.freeStreamMs,
      bearingDeg: 270 + offset,
      referenceHeightM: HORNS_REV.hubHeightM,
      turbulenceIntensity: HORNS_REV.turbulenceIntensity,
    })
    efficiencySum += result.totalFreeStreamPowerKw > 0
      ? result.totalPowerKw / result.totalFreeStreamPowerKw
      : 0
    const powerById = new Map(result.turbines.map((t) => [t.turbineId, t.powerKw]))
    for (let column = 0; column < HORNS_REV.columns; column++) {
      let total = 0
      for (const letter of ROW_LETTERS) total += powerById.get(`${letter}${column + 1}`) ?? 0
      columnTotals[column] = columnTotals[column]! + total / HORNS_REV.rows
    }
    directions++
  }

  const modelled = efficiencySum / directions
  const measured = halfWidthDeg <= 5
    ? HORNS_REV.measuredEfficiency.narrow
    : HORNS_REV.measuredEfficiency.wide
  const first = columnTotals[0]!
  return {
    halfWidthDeg,
    modelled,
    measured,
    deviationPp: (modelled - measured) * 100,
    lossRecovered: (1 - modelled) / (1 - measured),
    columnProfile: columnTotals.map((total) => (first > 0 ? total / first : 0)),
    directions,
  }
}
