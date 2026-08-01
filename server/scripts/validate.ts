/**
 * Validates the rebuilt prediction pipeline against live ERA5 data.
 *
 *   npm run validate --workspace server            # linear density correction
 *   npm run validate --workspace server -- iec     # IEC 61400-12-1 correction
 *
 * The science-fair report placed a turbine at ten real offshore wind farms, matched hub
 * height and model, and compared predicted output against recorded actuals, reporting a
 * mean error of 1.265%. This runs the same experiment so the claim can be checked.
 *
 * Two things about the report's reference column have to be said plainly, because they
 * determine what this script can and cannot conclude:
 *
 *   1. It is labelled kWh/month at magnitudes that can only be MWh/month. A V112-3450
 *      producing 1459 kWh/month would sit at a 0.06% capacity factor.
 *   2. Read as MWh/month, several rows are physically impossible. Nysted's 2062.35
 *      against a 2300 kW machine implies a capacity factor of 1.23 — more energy than
 *      the generator can produce with the wind blowing at rated speed every hour of the
 *      month. Horns Rev 1 implies 0.74, roughly double the farm's real output.
 *
 * So the report's column is not ground truth, and tuning a model to match it would be
 * fitting to bad data. This script therefore reports the comparison for completeness but
 * judges the model against what is actually checkable: whether predicted capacity
 * factors land in the well-established band for North Sea and Baltic offshore wind once
 * standard array losses are applied.
 */

import { openDatabase } from '../src/db/index.js'
import { predict } from '../src/lib/prediction.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { WindCache } from '../src/lib/windCache.js'
import type { DensityCorrection } from '../src/lib/power.js'

interface Farm {
  name: string
  latitude: number
  longitude: number
  hubHeightM: number
  turbineId: string
  /** Report's recorded output per turbine, read as MWh/month. */
  reportedMwhPerMonth: number
  note?: string
}

const FARMS: Farm[] = [
  { name: 'Rampion', latitude: 50.661, longitude: -0.279, hubHeightM: 84, turbineId: 'vestas-v112-3450', reportedMwhPerMonth: 1459.84 },
  { name: 'London Array', latitude: 51.626, longitude: 1.496, hubHeightM: 87, turbineId: 'siemens-swt-3.6-107', reportedMwhPerMonth: 1347.06 },
  { name: 'Race Bank', latitude: 53.276, longitude: 0.841, hubHeightM: 110, turbineId: 'vestas-v117-3450', reportedMwhPerMonth: 1733.06, note: 'report entered V117-3450 for a SWT-6.0-154 farm' },
  { name: 'Hornsea One', latitude: 53.88, longitude: 2.07, hubHeightM: 100, turbineId: 'siemens-swt-3.0-101', reportedMwhPerMonth: 1746.9, note: 'report entered SWT-3.0-101 for a SWT-7.0-154 farm' },
  { name: 'Robin Rigg', latitude: 54.756, longitude: -3.71, hubHeightM: 80, turbineId: 'vestas-v90-3000', reportedMwhPerMonth: 1061.69 },
  { name: 'Barrow', latitude: 53.982, longitude: -3.283, hubHeightM: 75, turbineId: 'vestas-v90-3000', reportedMwhPerMonth: 1310.29 },
  { name: 'Nysted', latitude: 54.549, longitude: 11.714, hubHeightM: 69, turbineId: 'bonus-b82-2300', reportedMwhPerMonth: 2062.35, note: 'reference implies CF 1.23 — impossible' },
  { name: 'Rodsand II', latitude: 54.558, longitude: 11.531, hubHeightM: 69, turbineId: 'siemens-swt-2.3-93', reportedMwhPerMonth: 824.48 },
  { name: 'Horns Rev 1', latitude: 55.486, longitude: 7.84, hubHeightM: 70, turbineId: 'vestas-v80-2000', reportedMwhPerMonth: 1079.2, note: 'reference implies CF 0.74 — ~2x the farm’s real output' },
  { name: 'Horns Rev 2', latitude: 55.6, longitude: 7.582, hubHeightM: 68, turbineId: 'siemens-swt-2.3-93', reportedMwhPerMonth: 838.76 },
]

const START_DATE = '2019-01-01'
const END_DATE = '2019-12-31'
const HOURS_PER_MONTH = 8765.82 / 12

/**
 * Gross-to-net loss factors for a large offshore array. The API predicts a single
 * isolated, perfectly available turbine; a real farm loses output to the wake of its own
 * neighbours, to downtime, and to the export cable.
 *
 * These are standard industry planning values, not measurements from these farms.
 */
const LOSSES = {
  wake: 0.1,
  availability: 0.03,
  electrical: 0.02,
  other: 0.02,
}
const NET_FACTOR =
  (1 - LOSSES.wake) * (1 - LOSSES.availability) * (1 - LOSSES.electrical) * (1 - LOSSES.other)

/** Established band for net capacity factor at North Sea / Baltic offshore sites. */
const PLAUSIBLE_NET_CF = { min: 0.32, max: 0.55 }

interface Row {
  farm: Farm
  grossCf: number
  netCf: number
  meanWindSpeedMs: number
  shear: number
  predictedMwhPerMonth: number
  errorVsReportPct: number
  reportImpliedCf: number
}

async function run(method: DensityCorrection): Promise<Row[]> {
  const db = openDatabase('data/validation.sqlite')
  const cache = new WindCache({ db, minIntervalMs: 400 })
  const rows: Row[] = []

  for (const farm of FARMS) {
    const model = getTurbineModel(farm.turbineId)
    if (!model) throw new Error(`unknown turbine ${farm.turbineId}`)

    const series = await cache.getSeries({
      latitude: farm.latitude,
      longitude: farm.longitude,
      startDate: START_DATE,
      endDate: END_DATE,
    })

    const prediction = predict(series, model, {
      hubHeightM: farm.hubHeightM,
      densityCorrection: method,
    })

    const predictedMwhPerMonth = (prediction.meanPowerKw * HOURS_PER_MONTH) / 1000
    const reportImpliedCf =
      (farm.reportedMwhPerMonth * 1000) / (model.ratedPowerKw * HOURS_PER_MONTH)

    rows.push({
      farm,
      grossCf: prediction.capacityFactor,
      netCf: prediction.capacityFactor * NET_FACTOR,
      meanWindSpeedMs: prediction.meanWindSpeedMs,
      shear: prediction.meanShearExponent,
      predictedMwhPerMonth,
      errorVsReportPct:
        ((predictedMwhPerMonth - farm.reportedMwhPerMonth) / farm.reportedMwhPerMonth) * 100,
      reportImpliedCf,
    })
  }

  db.close()
  return rows
}

const pad = (v: string, w: number, right = false) => (right ? v.padStart(w) : v.padEnd(w))

function report(rows: Row[], method: DensityCorrection): void {
  console.log(`\nERA5 ${START_DATE} .. ${END_DATE}   density correction: ${method}`)
  console.log(
    `Gross-to-net factor ${NET_FACTOR.toFixed(3)} ` +
      `(wake ${LOSSES.wake * 100}%, availability ${LOSSES.availability * 100}%, ` +
      `electrical ${LOSSES.electrical * 100}%, other ${LOSSES.other * 100}%)\n`,
  )

  console.log(
    [
      pad('Farm', 14),
      pad('Turbine', 20),
      pad('Hub', 5, true),
      pad('Wind', 6, true),
      pad('shear', 6, true),
      pad('gross', 6, true),
      pad('net CF', 7, true),
      pad('plaus?', 7, true),
      pad('report CF', 10, true),
    ].join(' '),
  )
  console.log('-'.repeat(90))

  let plausibleCount = 0
  let impossibleReferences = 0

  for (const row of rows) {
    const plausible = row.netCf >= PLAUSIBLE_NET_CF.min && row.netCf <= PLAUSIBLE_NET_CF.max
    if (plausible) plausibleCount++
    if (row.reportImpliedCf > 1) impossibleReferences++

    console.log(
      [
        pad(row.farm.name, 14),
        pad(row.farm.turbineId, 20),
        pad(`${row.farm.hubHeightM}m`, 5, true),
        pad(row.meanWindSpeedMs.toFixed(2), 6, true),
        pad(row.shear.toFixed(3), 6, true),
        pad(row.grossCf.toFixed(3), 6, true),
        pad(row.netCf.toFixed(3), 7, true),
        pad(plausible ? 'yes' : 'NO', 7, true),
        pad(row.reportImpliedCf.toFixed(2) + (row.reportImpliedCf > 1 ? ' !' : ''), 10, true),
      ].join(' '),
    )
  }

  console.log('-'.repeat(90))

  const meanNet = rows.reduce((s, r) => s + r.netCf, 0) / rows.length
  const meanGross = rows.reduce((s, r) => s + r.grossCf, 0) / rows.length
  const absErrors = rows.map((r) => Math.abs(r.errorVsReportPct))
  const meanErr = absErrors.reduce((a, b) => a + b, 0) / absErrors.length

  console.log(`Mean gross capacity factor:            ${meanGross.toFixed(3)}`)
  console.log(`Mean net capacity factor:              ${meanNet.toFixed(3)}`)
  console.log(
    `Net CF inside the ${PLAUSIBLE_NET_CF.min}–${PLAUSIBLE_NET_CF.max} offshore band:  ` +
      `${plausibleCount}/${rows.length}`,
  )
  console.log(`\nAgainst the report's reference column:`)
  console.log(`  Mean absolute error:                 ${meanErr.toFixed(1)}%`)
  console.log(`  Report's claimed mean error:         1.265%`)
  console.log(
    `  Reference rows implying CF > 1:      ${impossibleReferences}/${rows.length} (physically impossible)`,
  )

  for (const row of rows.filter((r) => r.farm.note)) {
    console.log(`  - ${row.farm.name}: ${row.farm.note}`)
  }
}

const method = (process.argv[2] as DensityCorrection) ?? 'linear'
report(await run(method), method)
