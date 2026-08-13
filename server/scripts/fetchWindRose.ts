/**
 * Fetch the ERA5 direction record for a site and write the recorded wind rose.
 *
 *   npm run fetch:rose --workspace server
 *
 * This is the one step in the chain that needs the network, so it is a script that writes a
 * source file rather than something the server, the tests or `choose:bearing` do at runtime.
 * The rose is a climatology: it changes when the window changes, not between runs, and the
 * bearing it justifies is written into a document. Refetching it on every test run would make
 * a documented decision depend on an upstream service being reachable.
 *
 * Rerun it when the window or the site changes, and commit the regenerated file.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { fetchWindSeries } from '../src/lib/openmeteo.js'
import { ASKERVEIN_GRID, ASKERVEIN_SITE_ID } from '../src/lib/validation/askerveinTerrain.js'
import { DEFAULT_SECTOR_COUNT, buildWindRose, commonSector } from '../src/lib/windRose.js'

/**
 * Five whole years rather than the project's usual single 2019.
 *
 * A rose is a climatology and one year of it is not: North Sea inter-annual variability is
 * around 5% on speed and larger on the direction split, and this rose fixes a sector that a
 * documented bearing choice rests on. Five years is also the ceiling `validateDateRange`
 * enforces elsewhere, so it stays inside the range the rest of the system will accept.
 */
const START_DATE = '2015-01-01'
const END_DATE = '2019-12-31'

const site = {
  id: ASKERVEIN_SITE_ID,
  name: 'Askervein Hill, South Uist',
  latitude: ASKERVEIN_GRID.latitude,
  longitude: ASKERVEIN_GRID.longitude,
}

const outputPath = fileURLToPath(new URL('../src/lib/askerveinRose.ts', import.meta.url))

console.log(`Fetching ERA5 ${START_DATE}..${END_DATE} at ${site.latitude}, ${site.longitude}`)
const series = await fetchWindSeries({
  latitude: site.latitude,
  longitude: site.longitude,
  startDate: START_DATE,
  endDate: END_DATE,
})
console.log(`  resolved cell ${series.latitude}, ${series.longitude} at ${series.elevationM} m`)
console.log(`  ${series.samples.length} usable hours\n`)

const rose = buildWindRose(series, {
  sectors: DEFAULT_SECTOR_COUNT,
  height: '100m',
  startDate: START_DATE,
  endDate: END_DATE,
})
const sector = commonSector(rose)

console.log(`Wind rose at 100 m, ${rose.sectorWidthDeg} degree sectors`)
console.log('  centre   hours    freq   mean m/s  energy m/s   energy share')
for (const entry of rose.sectors) {
  console.log(
    `  ${String(entry.centreDeg).padStart(5)}   ${String(entry.hours).padStart(6)}  ` +
    `${(entry.frequency * 100).toFixed(1).padStart(5)}%  ${entry.meanSpeedMs.toFixed(2).padStart(8)}  ` +
    `${entry.energySpeedMs.toFixed(2).padStart(9)}   ${(entry.energyShare * 100).toFixed(1).padStart(11)}%`,
  )
}
console.log(`\n  mean speed ${rose.meanSpeedMs.toFixed(2)} m/s`)
console.log(`  dominant sector ${rose.sectors[rose.dominantSectorIndex]!.centreDeg} degrees by energy`)
console.log(
  `  common sector ${sector.fromDeg}-${sector.toDeg} degrees (width ${sector.widthDeg}, centre ${sector.centreDeg}), ` +
  `${(sector.energyShare * 100).toFixed(1)}% of energy and ${(sector.frequency * 100).toFixed(1)}% of hours`,
)

/**
 * Format the rose as source.
 *
 * Hand-rolled rather than `JSON.stringify(rose, null, 2)` because the speed histogram turns
 * that into 2800 lines of one-number-per-line, and a generated file nobody can skim is a
 * generated file nobody checks. One line per speed bin keeps the whole rose readable in a
 * diff, which matters: refreshing it moves a documented bearing.
 */
function formatRose(): string {
  const sectors = rose.sectors.map((sector) => {
    const bins = sector.speedBins
      .map(
        (bin) =>
          `      { fromMs: ${bin.fromMs}, toMs: ${bin.toMs}, meanSpeedMs: ${bin.meanSpeedMs}, ` +
          `energySpeedMs: ${bin.energySpeedMs}, hours: ${bin.hours}, frequency: ${bin.frequency} },`,
      )
      .join('\n')
    return `  {
    index: ${sector.index},
    centreDeg: ${sector.centreDeg},
    fromDeg: ${sector.fromDeg},
    toDeg: ${sector.toDeg},
    hours: ${sector.hours},
    frequency: ${sector.frequency},
    meanSpeedMs: ${sector.meanSpeedMs},
    energySpeedMs: ${sector.energySpeedMs},
    energyShare: ${sector.energyShare},
    speedBins: [
${bins}
    ],
  },`
  })

  return `{
  latitude: ${rose.latitude},
  longitude: ${rose.longitude},
  startDate: '${rose.startDate}',
  endDate: '${rose.endDate}',
  height: '${rose.height}',
  sectorWidthDeg: ${rose.sectorWidthDeg},
  speedBinWidthMs: ${rose.speedBinWidthMs},
  hours: ${rose.hours},
  meanSpeedMs: ${rose.meanSpeedMs},
  dominantSectorIndex: ${rose.dominantSectorIndex},
  sectors: [
${sectors.join('\n')}
  ],
}`
}

const generated = `/**
 * Recorded ERA5 wind rose for ${site.name}.
 *
 * **Generated. Do not edit by hand** — rerun \`npm run fetch:rose --workspace server\`.
 *
 * Source: ERA5 reanalysis via Open-Meteo, hourly ${START_DATE} to ${END_DATE}, at the 100 m
 * level because that is the reported height closest to hub. Requested at the published
 * Askervein summit coordinate; ERA5 snapped it to the grid cell recorded below.
 *
 * ERA5 is a roughly 25 km reanalysis. It resolves the synoptic direction distribution, which
 * is what a rose is for, and it does not resolve the hill — the local flow over Askervein
 * comes from the base-flow solve, not from here.
 */

import type { CommonSector, WindRose } from './windRose.js'

/** The cell Open-Meteo resolved, which is not the coordinate that was asked for. */
export const ASKERVEIN_ROSE_CELL = {
  requestedLatitude: ${site.latitude},
  requestedLongitude: ${site.longitude},
  resolvedLatitude: ${series.latitude},
  resolvedLongitude: ${series.longitude},
  elevationM: ${series.elevationM},
} as const

export const ASKERVEIN_WIND_ROSE: WindRose = ${formatRose()}

/**
 * The arc carrying half the site's wind energy, as \`commonSector\` derives it.
 *
 * Recorded rather than recomputed at import so the value a document quotes cannot change
 * because a default moved. \`test/windRose.test.ts\` re-derives it from the rose above and
 * fails if the two disagree.
 */
export const ASKERVEIN_COMMON_SECTOR: CommonSector = ${JSON.stringify(sector, null, 2)}
`

writeFileSync(outputPath, generated)
console.log(`\nWrote ${outputPath}`)
