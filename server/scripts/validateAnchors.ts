/**
 * Re-run the two external anchors behind `docs/VALIDATION.md`.
 *
 *   npm run validate:anchors --workspace server
 *
 * No network and no database: both cases are pure functions over committed reference data,
 * so this reproduces byte-identically on any machine. The Askervein solve dominates the
 * runtime at roughly five seconds; Horns Rev is milliseconds.
 */

import {
  HORNS_REV,
  TU03B,
  askerveinSensitivity,
  askerveinSummit,
  hornsRevSector,
  runAskerveinCase,
} from '../src/lib/validation/index.js'

const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const signed = (value: number, digits = 3) => (value >= 0 ? '+' : '') + value.toFixed(digits)

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`)
}

heading('Terrain response — Askervein Hill, run TU03-B')
console.log(TU03B.source)
console.log(
  `conditions: ${TU03B.bearingDeg} deg, ${TU03B.referenceSpeedMs} m/s at ${TU03B.referenceHeightM} m, ` +
    `shear alpha ${TU03B.shearExponent}, ${TU03B.stability}`,
)

const askervein = runAskerveinCase()
console.log(
  `solve: ${askervein.levels} levels to ${askervein.topElevationM} m, alphaH/alphaV = ` +
    `${askervein.alphaHorizontalVerticalRatio}, converged=${askervein.converged}, ${askervein.solveMs} ms`,
)
console.log(
  `summit: DEM node ${askervein.demSummitElevationM.toFixed(1)} m, solver cell centres ` +
    `${askervein.modelSummitElevationM.toFixed(1)} m (published HT 123.79 m)`,
)

console.log('\nhilltop fractional speed-up against the RS/HT mast pair')
console.log('  height   measured   modelled   rel. error')
for (const row of askervein.summitProfile) {
  console.log(
    `  ${String(row.heightM).padStart(4)} m     ${row.measured.toFixed(3)}      ${row.modelled.toFixed(3)}      ` +
      `${signed(row.relativeError * 100, 1)}%`,
  )
}

console.log('\nLine A at 10 m above ground, along the wind direction through the summit')
console.log('  distance   measured   modelled')
for (const row of askervein.lineA) {
  console.log(
    `  ${String(row.distanceM).padStart(5)} m     ${signed(row.measured)}     ${signed(row.modelled)}`,
  )
}

const lee = askervein.lineA.find((row) => row.distanceM === 400)
if (lee) {
  console.log(
    `\nlee side at +400 m: the model reproduces ${pct(lee.modelled / lee.measured)} of the measured ` +
      'deceleration. A mass-consistent field has no momentum equation, so it cannot separate.',
  )
}

heading('Sensitivity — reported, not used to choose a value')
const ANCHOR_HEIGHT_M = 34
console.log(`hilltop speed-up at ${ANCHOR_HEIGHT_M} m versus the free parameter alphaH/alphaV`)
for (const row of askerveinSensitivity([0.5, 1, 2], ANCHOR_HEIGHT_M)) {
  console.log(`  ${row.ratio.toFixed(2)}   ${row.modelled === null ? 'unresolved' : row.modelled.toFixed(3)}`)
}
console.log('domain lid')
for (const topElevationM of [500, 1000]) {
  const run = runAskerveinCase({ topElevationM })
  const row = run.summitProfile.find((entry) => entry.heightM === ANCHOR_HEIGHT_M)
  console.log(`  ${topElevationM} m   ${row ? row.modelled.toFixed(3) : 'unresolved'}`)
}
console.log('vertical resolution')
for (const levels of [16, 24, 32, 48]) {
  const run = runAskerveinCase({ levels })
  const row = run.summitProfile.find((entry) => entry.heightM === ANCHOR_HEIGHT_M)
  console.log(`  ${String(levels).padStart(2)} levels   ${row ? row.modelled.toFixed(4) : 'unresolved'}`)
}

heading('Wake losses — Horns Rev 1, 8 +/- 0.5 m/s')
console.log(HORNS_REV.source)
console.log(
  `conditions: ${HORNS_REV.rows} x ${HORNS_REV.columns} V80-2000 at ${HORNS_REV.spacingD}D, hub ` +
    `${HORNS_REV.hubHeightM} m, ambient TI ${pct(HORNS_REV.turbulenceIntensity)}`,
)

for (const halfWidthDeg of [15, 2.5]) {
  const sector = hornsRevSector(halfWidthDeg)
  const published = halfWidthDeg > 5
    ? HORNS_REV.publishedModelDeviationPp.wide
    : HORNS_REV.publishedModelDeviationPp.narrow
  console.log(
    `\n270 +/- ${halfWidthDeg} deg  (${sector.directions} directions)\n` +
      `  measured  ${pct(sector.measured)}\n` +
      `  Kestrel   ${pct(sector.modelled)}   ${signed(sector.deviationPp, 1)} pp   ` +
      `(modelled loss is ${pct(sector.lossRecovered)} of the measured loss)\n` +
      `  published Jensen ${signed(published.jensen, 1)} pp, Larsen ${signed(published.larsen, 1)} pp, ` +
      `Fuga ${signed(published.fuga, 1)} pp`,
  )
  console.log('  column-normalised power: ' + sector.columnProfile.map((v) => v.toFixed(2)).join(' '))
}

heading('Summary')
const anchorRow = askervein.summitProfile.find((row) => row.heightM === ANCHOR_HEIGHT_M)
const wide = hornsRevSector(15)
console.log(
  `terrain: hilltop speed-up at ${ANCHOR_HEIGHT_M} m is ${signed((anchorRow?.relativeError ?? 0) * 100, 2)}% ` +
    'against TU03-B; error grows toward the surface and the lee side is not reproduced.',
)
console.log(
  `wake: farm efficiency over 270 +/- 15 deg is ${signed(wide.deviationPp, 1)} pp against Horns Rev 1; ` +
    `the model under-reads array loss by ${pct(1 - wide.lossRecovered)}.`,
)
console.log(`summit position: ${JSON.stringify(askerveinSummit())}`)
