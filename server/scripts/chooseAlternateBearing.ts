/**
 * Fix the alternate bearing for the primary task, by the rule in
 * `docs/design/primary-task.md`, applied to computed output.
 *
 *   npm run choose:bearing --workspace server
 *
 * The rule is deliberately mechanical, because choosing this bearing by eye would be
 * choosing the answer to T3 by eye. It is encoded here rather than applied by hand so that
 * changing the demonstration layout, the site or the physics re-derives it instead of
 * silently invalidating a number written into a document.
 *
 * Result and reasoning: `docs/design/alternate-bearing.md`. No network, no database.
 */

import { solveMassConsistentBaseFlow } from '../src/lib/baseFlow.js'
import { analyseTerrainFarm } from '../src/lib/farmAnalysis.js'
import type { FarmAnalysis } from '../src/lib/farmAnalysis.js'
import { generateGridLayout } from '../src/lib/layout.js'
import { buildWakeStreamlines } from '../src/lib/terrainWake.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { askerveinTerrainGrid } from '../src/lib/validation/askerveinTerrain.js'

/**
 * The demonstration scene, exactly as `client/src/features/site/askervein.ts` sends it.
 *
 * If these drift the recorded bearing describes a farm the user is not looking at.
 */
const SCENE = {
  turbineId: 'vestas-v112-3450',
  rows: 2,
  columns: 2,
  crosswindSpacingD: 6,
  downwindSpacingD: 8,
  hubHeightM: 100,
  orientationBearingDeg: 210,
  originEastingM: 1000,
  originNorthingM: 1000,
  speedMs: 10,
  turbulenceIntensity: 0.08,
  referenceHeightM: 100,
  shearExponent: 1 / 7,
  topElevationM: 500,
  levels: 8,
} as const

/** The baseline bearing: the design bearing of the layout, and Askervein run TU03-B's. */
const BASELINE_DEG = 210

/**
 * The site's common wind sector — south-westerly.
 *
 * **Provisional.** The rule asks for the sector from the wind rose that step 11's frequency
 * weighting requires, and that rose does not exist yet: the ERA5 client fetches speeds but
 * not directions. Until it does, the sector is the campaign's own: Askervein was sited and
 * run for south-westerly flow, and the Outer Hebrides' prevailing direction is the reason
 * TU03-B is a 210 degree case. Step 11 must re-run this script against the real rose.
 */
const SECTOR = { fromDeg: 180, toDeg: 270 } as const

/**
 * Bearing resolution, in degrees.
 *
 * Not arbitrary, and not the 1 degree the interface control can express. The only external
 * anchor the wake model has is Horns Rev averaged over a 15 degree sector; over a 2.5 degree
 * sector the same dataset moves the measured farm efficiency by 9 points, and the source
 * attributes that to wind-direction uncertainty in the measurements rather than to the
 * models (D24). Distinguishing bearings more finely than this would be reading a precision
 * the model has never been shown to have.
 */
const STEP_DEG = 5

const model = getTurbineModel(SCENE.turbineId)
if (!model) throw new Error(`unknown turbine: ${SCENE.turbineId}`)
const terrain = askerveinTerrainGrid()

function analyse(bearingDeg: number): FarmAnalysis {
  const field = solveMassConsistentBaseFlow({
    terrain,
    topElevationM: SCENE.topElevationM,
    levels: SCENE.levels,
    bearingDegrees: bearingDeg,
    referenceSpeedMs: SCENE.speedMs,
    referenceHeightM: SCENE.referenceHeightM,
    shearExponent: SCENE.shearExponent,
    alphaHorizontalVerticalRatio: 1,
  })
  const layout = generateGridLayout({
    model: model!,
    rows: SCENE.rows,
    columns: SCENE.columns,
    crosswindSpacingD: SCENE.crosswindSpacingD,
    downwindSpacingD: SCENE.downwindSpacingD,
    prevailingBearingDeg: SCENE.orientationBearingDeg,
    hubHeightM: SCENE.hubHeightM,
    origin: { eastingM: SCENE.originEastingM, northingM: SCENE.originNorthingM },
  })
  const streamlines = buildWakeStreamlines(field, layout.turbines)
  return analyseTerrainFarm(field, layout.turbines, streamlines, {
    bearingDeg,
    turbulenceIntensity: SCENE.turbulenceIntensity,
  })
}

/** Turbine ids ordered by wake loss, worst first. Ties break by id so the order is stable. */
function ranking(analysis: FarmAnalysis): string[] {
  return [...analysis.turbines]
    .sort((a, b) => b.wakeLossFraction - a.wakeLossFraction || a.turbineId.localeCompare(b.turbineId))
    .map((turbine) => turbine.turbineId)
}

function lossFraction(analysis: FarmAnalysis, turbineId: string): number {
  return analysis.turbines.find((turbine) => turbine.turbineId === turbineId)?.wakeLossFraction ?? 0
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

const baseline = analyse(BASELINE_DEG)
const baselineOrder = ranking(baseline)
const baselineTopTwo = baselineOrder.slice(0, 2)

const candidates: number[] = []
for (let bearing: number = SECTOR.fromDeg; bearing <= SECTOR.toDeg; bearing += STEP_DEG) {
  if (bearing !== BASELINE_DEG) candidates.push(bearing)
}
// Rule 2 asks for the *smallest* change that reorders, so walk outward from the baseline.
candidates.sort((a, b) => Math.abs(a - BASELINE_DEG) - Math.abs(b - BASELINE_DEG) || a - b)

console.log(`Askervein demonstration layout — ${SCENE.rows}x${SCENE.columns} ${model.name}`)
console.log(`Layout orientation ${SCENE.orientationBearingDeg} deg, wind ${SCENE.speedMs} m/s, TI ${(SCENE.turbulenceIntensity * 100).toFixed(0)}%`)
console.log(`Sector ${SECTOR.fromDeg}-${SECTOR.toDeg} deg at ${STEP_DEG} deg steps (provisional; see the script header)\n`)

console.log(`Baseline ${BASELINE_DEG} deg`)
for (const turbine of [...baseline.turbines].sort((a, b) => b.wakeLossFraction - a.wakeLossFraction)) {
  const dominant = turbine.dominantContributorId ?? '-'
  console.log(
    `  ${turbine.turbineId}  loss ${percent(turbine.wakeLossFraction).padStart(7)}  ` +
    `${turbine.wakeLossKw.toFixed(0).padStart(5)} kW  net ${turbine.netPowerKw.toFixed(0).padStart(5)} kW  ` +
    `incoming ${turbine.incomingSpeedMs.toFixed(2)} m/s  dominant cause ${dominant}`,
  )
}
console.log(`  farm loss ${percent(baseline.wakeLossFraction)}, top two ${baselineTopTwo.join(' > ')}\n`)

console.log(`Candidates, nearest first`)
console.log(`  bearing   delta   top two                    farm loss   reorders`)
let chosen: { bearingDeg: number; analysis: FarmAnalysis; rule: 2 | 3 } | null = null
const rows: { bearingDeg: number; analysis: FarmAnalysis; reorders: boolean }[] = []
for (const bearing of candidates) {
  const analysis = analyse(bearing)
  const topTwo = ranking(analysis).slice(0, 2)
  const reorders = topTwo[0] !== baselineTopTwo[0] || topTwo[1] !== baselineTopTwo[1]
  rows.push({ bearingDeg: bearing, analysis, reorders })
  console.log(
    `  ${String(bearing).padStart(5)} deg  ${String(bearing - BASELINE_DEG).padStart(5)}   ` +
    `${topTwo.join(' > ').padEnd(25)}  ${percent(analysis.wakeLossFraction).padStart(9)}   ${reorders ? 'yes' : 'no'}`,
  )
  if (reorders && !chosen) chosen = { bearingDeg: bearing, analysis, rule: 2 }
}

if (!chosen) {
  // Rule 3: no reorder anywhere in the sector. "The answer does not change" is a real T3
  // answer, so the task stays answerable — but the interface has to say so explicitly.
  const worst = baselineTopTwo[0]!
  const baselineWorstLoss = lossFraction(baseline, worst)
  const furthest = rows.reduce((best, row) =>
    Math.abs(lossFraction(row.analysis, worst) - baselineWorstLoss) >
    Math.abs(lossFraction(best.analysis, worst) - baselineWorstLoss)
      ? row
      : best,
  )
  chosen = { bearingDeg: furthest.bearingDeg, analysis: furthest.analysis, rule: 3 }
}

const alternate = chosen
console.log(`\nAlternate bearing: ${alternate.bearingDeg} deg (rule ${alternate.rule})`)
if (alternate.rule === 3) {
  console.log('  No bearing in the sector reorders the top two. The ranking is stable across the')
  console.log('  common sector, and the interface must state that — it is itself a valid T3 answer.')
}
for (const turbine of [...alternate.analysis.turbines].sort((a, b) => b.wakeLossFraction - a.wakeLossFraction)) {
  const before = lossFraction(baseline, turbine.turbineId)
  const delta = (turbine.wakeLossFraction - before) * 100
  console.log(
    `  ${turbine.turbineId}  loss ${percent(turbine.wakeLossFraction).padStart(7)}  ` +
    `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pp)  dominant cause ${turbine.dominantContributorId ?? '-'}`,
  )
}
console.log(
  `  farm loss ${percent(alternate.analysis.wakeLossFraction)} ` +
  `(${((alternate.analysis.wakeLossFraction - baseline.wakeLossFraction) * 100).toFixed(2)} pp)`,
)
console.log('\nModelled wake losses are a floor, not an upper limit (D24).')
