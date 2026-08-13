/**
 * Search for a layout that makes the primary task non-trivial, by computed criteria.
 *
 *   npm run choose:test-scene --workspace server
 *
 * ## Why this script exists
 *
 * `docs/design/alternate-bearing.md` established that the shipped demonstration scene cannot
 * be used to test `RATIONALE.md`'s H1. In a 2 x 2 array one turbine accounts for effectively
 * 100% of the affected rotor's deficit, at every bearing in the common sector, sitting 8.0 D
 * straight upwind with the wake axis passing within 0.3 D of the hub. A plan view answers T2
 * instantly, which puts the 2D control condition at ceiling and makes the hypothesis
 * untestable rather than merely unsupported.
 *
 * The fix is a different scene, and choosing it by eye would be choosing the outcome of the
 * user study by eye. The criteria below are therefore mechanical, and the search reports what
 * each candidate scores rather than only its winner.
 *
 * ## The criteria
 *
 * A scene qualifies when, at its nominal bearing:
 *
 *   C1 **Ambiguity.** No single upstream turbine dominates the worst rotor's deficit. At
 *      least two contributors hold a material share, and the largest holds no more than
 *      `MAX_DOMINANT_SHARE`. This is what stops "which one is it" being answerable at a
 *      glance in any view.
 *   C2 **Partial overlap.** The dominant wake axis passes between `MIN_RADIAL_D` and
 *      `MAX_RADIAL_D` rotor diameters from the hub. Dead-centre overlap is the easy case;
 *      beyond about a diameter there is no interaction left to reason about.
 *   C3 **Terrain steering.** The dominant contributor's wake axis has been displaced
 *      laterally by at least `MIN_STEERING_D` diameters from the straight line its bearing
 *      would draw, by the time it reaches the affected rotor. This is the criterion the plan
 *      view cannot satisfy: it is the difference between reasoning about the wind and
 *      reasoning about a compass.
 *   C4 **Materiality.** The worst rotor loses at least `MIN_WORST_LOSS` of its output, so the
 *      finding is a finding rather than numerical noise.
 *
 * No network, no database. Around a minute.
 */

import { solveMassConsistentBaseFlow } from '../src/lib/baseFlow.js'
import type { BaseFlowField } from '../src/lib/baseFlow.js'
import { analyseTerrainFarm } from '../src/lib/farmAnalysis.js'
import type { FarmAnalysis } from '../src/lib/farmAnalysis.js'
import { generateGridLayout } from '../src/lib/layout.js'
import { buildWakeStreamlines } from '../src/lib/terrainWake.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { askerveinTerrainGrid } from '../src/lib/validation/askerveinTerrain.js'
import { ASKERVEIN_COMMON_SECTOR } from '../src/lib/askerveinRose.js'
import { windTravelVector } from '../src/lib/wake.js'
import { sectorBearings } from '../src/lib/windRose.js'

const MAX_DOMINANT_SHARE = 0.7
const MIN_SECOND_SHARE = 0.15
const MIN_RADIAL_D = 0.25
const MAX_RADIAL_D = 0.9
const MIN_STEERING_D = 0.25
const MIN_WORST_LOSS = 0.1

/**
 * V80-2000, and not the demonstration scene's V112.
 *
 * Two reasons, both about the study rather than about looks. Its 80 m rotor is the smallest
 * in the catalogue, so a twelve-turbine array fits inside the 2 km DEM with margin for the
 * wakes to develop — a V112 array at the same spacing in diameters runs off the hill. And it
 * is the one machine whose power curve *and* thrust coefficients are anchored against
 * published values, so the scene the hypothesis is tested on rests on the best-supported
 * physics available here.
 */
const TURBINE_ID = 'vestas-v80-2000'

const SPEED_MS = 10
const TURBULENCE_INTENSITY = 0.08
const REFERENCE_HEIGHT_M = 100
const SHEAR_EXPONENT = 1 / 7
const HUB_HEIGHT_M = 80
const TOP_ELEVATION_M = 500
const LEVELS = 8

/** Keep every turbine this far inside the domain, so its wake has room to be traced. */
const EDGE_MARGIN_M = 150

const model = getTurbineModel(TURBINE_ID)
if (!model) throw new Error(`unknown turbine: ${TURBINE_ID}`)
const terrain = askerveinTerrainGrid()
const domainEastingM = terrain.cellSizeEastingM * (terrain.columns - 1)
const domainNorthingM = terrain.cellSizeNorthingM * (terrain.rows - 1)

interface Candidate {
  rows: number
  columns: number
  crosswindSpacingD: number
  downwindSpacingD: number
  staggerFraction: number
  orientationBearingDeg: number
  originEastingM: number
  originNorthingM: number
}

interface Score {
  candidate: Candidate
  bearingDeg: number
  worstTurbineId: string
  worstLoss: number
  farmLoss: number
  dominantShare: number
  secondShare: number
  materialContributors: number
  radialD: number
  downwindD: number
  steeringD: number
  passes: boolean
}

function solve(bearingDeg: number): BaseFlowField {
  return solveMassConsistentBaseFlow({
    terrain,
    topElevationM: TOP_ELEVATION_M,
    levels: LEVELS,
    bearingDegrees: bearingDeg,
    referenceSpeedMs: SPEED_MS,
    referenceHeightM: REFERENCE_HEIGHT_M,
    shearExponent: SHEAR_EXPONENT,
    alphaHorizontalVerticalRatio: 1,
  })
}

function evaluate(field: BaseFlowField, bearingDeg: number, candidate: Candidate): Score | null {
  const layout = generateGridLayout({
    model: model!,
    rows: candidate.rows,
    columns: candidate.columns,
    crosswindSpacingD: candidate.crosswindSpacingD,
    downwindSpacingD: candidate.downwindSpacingD,
    prevailingBearingDeg: candidate.orientationBearingDeg,
    hubHeightM: HUB_HEIGHT_M,
    staggerFraction: candidate.staggerFraction,
    origin: { eastingM: candidate.originEastingM, northingM: candidate.originNorthingM },
  })

  for (const turbine of layout.turbines) {
    if (
      turbine.eastingM < EDGE_MARGIN_M ||
      turbine.eastingM > domainEastingM - EDGE_MARGIN_M ||
      turbine.northingM < EDGE_MARGIN_M ||
      turbine.northingM > domainNorthingM - EDGE_MARGIN_M
    ) {
      return null
    }
  }

  const streamlines = buildWakeStreamlines(field, layout.turbines)
  const analysis = analyseTerrainFarm(field, layout.turbines, streamlines, {
    bearingDeg,
    turbulenceIntensity: TURBULENCE_INTENSITY,
  })
  return scoreAnalysis(analysis, candidate, bearingDeg)
}

function scoreAnalysis(analysis: FarmAnalysis, candidate: Candidate, bearingDeg: number): Score | null {
  const worst = analysis.turbines.find((turbine) => turbine.turbineId === analysis.worstTurbineId)
  if (!worst || worst.contributors.length === 0) return null

  const shares = worst.contributors.map((contributor) => contributor.share).sort((a, b) => b - a)
  const dominant = worst.contributors[0]!
  const source = analysis.turbines.find((turbine) => turbine.turbineId === dominant.turbineId)
  if (!source) return null

  // Lateral displacement of the dominant contributor's axis from the straight line its
  // bearing would draw, at the arc distance where it passes the affected rotor.
  const travel = windTravelVector(bearingDeg)
  let deviationM = 0
  for (const point of source.wakePath) {
    if (point.distanceM < dominant.downwindM) continue
    const straightEast = source.eastingM + point.distanceM * travel.east
    const straightNorth = source.northingM + point.distanceM * travel.north
    deviationM = Math.hypot(point.eastingM - straightEast, point.northingM - straightNorth)
    break
  }

  const score: Score = {
    candidate,
    bearingDeg,
    worstTurbineId: worst.turbineId,
    worstLoss: worst.wakeLossFraction,
    farmLoss: analysis.wakeLossFraction,
    dominantShare: shares[0] ?? 0,
    secondShare: shares[1] ?? 0,
    materialContributors: shares.filter((share) => share >= MIN_SECOND_SHARE).length,
    radialD: dominant.radialD,
    downwindD: dominant.downwindD,
    steeringD: deviationM / model!.rotorDiameterM,
    passes: false,
  }

  score.passes =
    score.worstLoss >= MIN_WORST_LOSS &&
    score.dominantShare <= MAX_DOMINANT_SHARE &&
    score.materialContributors >= 2 &&
    score.radialD >= MIN_RADIAL_D &&
    score.radialD <= MAX_RADIAL_D &&
    score.steeringD >= MIN_STEERING_D

  return score
}

/** How well a passing candidate serves the study: ambiguity first, then steering. */
function quality(score: Score): number {
  return (
    (1 - score.dominantShare) * 2 +
    Math.min(score.steeringD, 1.5) +
    Math.min(score.worstLoss, 0.5)
  )
}

/**
 * Bearing resolution for the search, and the minimum gap between the two chosen bearings.
 *
 * 5 degrees is the resolution `docs/design/alternate-bearing.md` argues for and no finer, for
 * the same reason: the only anchor the wake model has is averaged over a plus or minus 15
 * degree sector. The 10 degree separation is a study requirement rather than a physical one —
 * `RATIONALE.md` runs both conditions on the same participant, and two bearings 5 degrees
 * apart would show them very nearly the same picture twice, which makes the second condition a
 * memory test instead of a task.
 */
const SEARCH_STEP_DEG = 5
const MIN_BEARING_SEPARATION_DEG = 10

const bearings = sectorBearings(ASKERVEIN_COMMON_SECTOR, SEARCH_STEP_DEG)
const candidates: Candidate[] = []
for (const rows of [3, 4]) {
  for (const columns of [3, 4]) {
    for (const crosswindSpacingD of [3.5, 4.5]) {
      for (const downwindSpacingD of [5, 6.5]) {
        for (const staggerFraction of [0, 0.35, 0.5]) {
          for (const originEastingM of [700, 900, 1100, 1300]) {
            for (const originNorthingM of [700, 900, 1100, 1300]) {
              candidates.push({
                rows,
                columns,
                crosswindSpacingD,
                downwindSpacingD,
                staggerFraction,
                // Oriented to the sector centre: a real array is built for its prevailing
                // wind, and one built square to the test bearing would be answering a
                // different question about geometry.
                orientationBearingDeg: ASKERVEIN_COMMON_SECTOR.centreDeg,
                originEastingM,
                originNorthingM,
              })
            }
          }
        }
      }
    }
  }
}

console.log(`Askervein testing-scenario search — ${model.name}`)
console.log(`${candidates.length} layouts x ${bearings.length} bearings in the common sector`)
console.log(
  `Criteria: worst loss >= ${MIN_WORST_LOSS}, dominant share <= ${MAX_DOMINANT_SHARE}, ` +
  `>= 2 contributors at >= ${MIN_SECOND_SHARE}, radial ${MIN_RADIAL_D}-${MAX_RADIAL_D} D, ` +
  `steering >= ${MIN_STEERING_D} D\n`,
)

const passing: Score[] = []
const all: Score[] = []
for (const bearingDeg of bearings) {
  const field = solve(bearingDeg)
  let passed = 0
  for (const candidate of candidates) {
    const score = evaluate(field, bearingDeg, candidate)
    if (!score) continue
    all.push(score)
    if (score.passes) {
      passing.push(score)
      passed++
    }
  }
  console.log(`  ${String(bearingDeg).padStart(3)} deg: ${passed} of ${candidates.length} pass`)
}

console.log(`\n${passing.length} passing (layout, bearing) pairs out of ${all.length} evaluated\n`)

if (passing.length === 0) {
  console.log('Nothing passed. The closest candidates on each criterion:')
  const report = (label: string, sorted: Score[]) => {
    const best = sorted[0]
    if (!best) return
    console.log(
      `  best ${label}: ${describe(best.candidate)} at ${best.bearingDeg} deg — ` +
      `loss ${(best.worstLoss * 100).toFixed(1)}%, share ${best.dominantShare.toFixed(2)}, ` +
      `radial ${best.radialD.toFixed(2)} D, steering ${best.steeringD.toFixed(2)} D`,
    )
  }
  report('ambiguity', [...all].sort((a, b) => a.dominantShare - b.dominantShare))
  report('steering', [...all].sort((a, b) => b.steeringD - a.steeringD))
  report('overlap', [...all].sort((a, b) => Math.abs(a.radialD - 0.5) - Math.abs(b.radialD - 0.5)))
  report('loss', [...all].sort((a, b) => b.worstLoss - a.worstLoss))
  process.exit(1)
}

passing.sort((a, b) => quality(b) - quality(a))

console.log('Best passing (layout, bearing) pairs:')
console.log('  bearing  layout                                          worst    loss   share  2nd   radial  steer')
for (const score of passing.slice(0, 10)) {
  console.log(
    `  ${String(score.bearingDeg).padStart(5)}    ${describe(score.candidate).padEnd(44)} ` +
    `${score.worstTurbineId.padEnd(8)} ${(score.worstLoss * 100).toFixed(1).padStart(5)}%  ` +
    `${score.dominantShare.toFixed(2)}  ${score.secondShare.toFixed(2)}  ` +
    `${score.radialD.toFixed(2).padStart(5)}   ${score.steeringD.toFixed(2)}`,
  )
}

/**
 * The study needs one layout that is hard at *two* bearings, not two layouts that are each
 * hard at one.
 *
 * `RATIONALE.md` runs both conditions within subject with a different bearing in each, so a
 * layout qualifying at only one bearing would force the second condition onto a scene where
 * T2 is obvious — handing the 2D control exactly the ceiling this search exists to avoid, and
 * quietly making the comparison unfair in the direction that flatters the hypothesis.
 */
const byLayout = new Map<string, Score[]>()
for (const score of passing) {
  const key = describe(score.candidate)
  const existing = byLayout.get(key)
  if (existing) existing.push(score)
  else byLayout.set(key, [score])
}

const pairs: { primary: Score; alternate: Score; quality: number }[] = []
for (const scores of byLayout.values()) {
  for (const primary of scores) {
    for (const alternate of scores) {
      const separation = Math.abs(primary.bearingDeg - alternate.bearingDeg)
      if (separation < MIN_BEARING_SEPARATION_DEG) continue
      if (primary.bearingDeg > alternate.bearingDeg) continue
      pairs.push({ primary, alternate, quality: quality(primary) + quality(alternate) })
    }
  }
}

if (pairs.length === 0) {
  console.log(
    `\nNo layout passes at two bearings at least ${MIN_BEARING_SEPARATION_DEG} degrees apart. ` +
    'The study needs two; widen the search or relax a criterion — but say which, and why, in ' +
    'docs/design/testing-scenario.md.',
  )
  process.exit(1)
}

pairs.sort((a, b) => b.quality - a.quality)
const best = pairs[0]!

console.log(`\n${pairs.length} layouts qualify at two separated bearings.`)
console.log(`\nChosen layout: ${describe(best.primary.candidate)}`)
console.log(`  turbine ${model.id}, hub ${HUB_HEIGHT_M} m, ${SPEED_MS} m/s, TI ${(TURBULENCE_INTENSITY * 100).toFixed(0)}%`)
for (const [label, score] of [['primary', best.primary], ['alternate', best.alternate]] as const) {
  console.log(
    `  ${label.padEnd(9)} ${String(score.bearingDeg).padStart(3)} deg — worst ${score.worstTurbineId}, ` +
    `loss ${(score.worstLoss * 100).toFixed(1)}%, farm ${(score.farmLoss * 100).toFixed(1)}%, ` +
    `dominant share ${score.dominantShare.toFixed(2)}, second ${score.secondShare.toFixed(2)}, ` +
    `${score.materialContributors} material causes, ${score.downwindD.toFixed(1)} D upwind, ` +
    `radial ${score.radialD.toFixed(2)} D, steering ${score.steeringD.toFixed(2)} D`,
  )
}
console.log(
  `  the worst turbine ${best.primary.worstTurbineId === best.alternate.worstTurbineId ? 'is the same' : 'changes'} ` +
  'between the two bearings',
)

/**
 * Emit the chosen layout as explicit coordinates.
 *
 * The study scene is frozen as positions rather than as generator parameters on purpose. A
 * scene defined by `rows`, `columns` and `staggerFraction` moves if `generateGridLayout` ever
 * changes how it centres or staggers an array — and it would move *after* participants had
 * been run against the old geometry, with nothing failing and the published numbers quietly
 * describing a farm nobody was shown.
 */
const chosenLayout = generateGridLayout({
  model,
  rows: best.primary.candidate.rows,
  columns: best.primary.candidate.columns,
  crosswindSpacingD: best.primary.candidate.crosswindSpacingD,
  downwindSpacingD: best.primary.candidate.downwindSpacingD,
  prevailingBearingDeg: best.primary.candidate.orientationBearingDeg,
  hubHeightM: HUB_HEIGHT_M,
  staggerFraction: best.primary.candidate.staggerFraction,
  origin: {
    eastingM: best.primary.candidate.originEastingM,
    northingM: best.primary.candidate.originNorthingM,
  },
})

console.log('\nScene layout.turbines (frozen coordinates, metres in the local frame):')
for (const turbine of chosenLayout.turbines) {
  console.log(
    `      { id: '${turbine.id}', easting_m: ${round(turbine.eastingM)}, ` +
    `northing_m: ${round(turbine.northingM)} },`,
  )
}

console.log('\nModelled wake losses are a floor, not an upper limit (D24).')

function round(value: number): number {
  // Decimetres. Finer than the DEM resolves and coarse enough that the file stays readable.
  return Math.round(value * 10) / 10
}

function describe(candidate: Candidate): string {
  return (
    `${candidate.rows}x${candidate.columns} ${candidate.crosswindSpacingD}Dx${candidate.downwindSpacingD}D ` +
    `stagger ${candidate.staggerFraction} at (${candidate.originEastingM},${candidate.originNorthingM})`
  )
}

function sameCandidate(a: Candidate, b: Candidate): boolean {
  return describe(a) === describe(b)
}
