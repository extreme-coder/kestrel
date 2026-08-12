/**
 * Copernicus DEM GLO-30 elevations for Askervein Hill (ADR 0002), packed as little-endian
 * decimetres so the array can live in source rather than in a build artefact.
 *
 * This is a byte-for-byte copy of the asset the viewer renders
 * (`client/src/features/site/askervein.ts`). The copy exists because the validation case
 * and the demonstration scene must be the same terrain — if they drift, the site stops
 * validating what it displays. `test/validation.test.ts` asserts the two stay identical.
 *
 * Source tile: `Copernicus_DSM_COG_10_N57_00_W008_00_DEM` (AWS Open Data, 2021 release).
 * Attribution: produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus
 * Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA.
 */
export const ASKERVEIN_ELEVATIONS_BASE64 = [
  "IwAjACkAMwA6AEIAUwBHAC0ARABVAGoAaQBiAFgAWgBfAGoAagBoAF4AVQBVAFUAVQBVAGUAgQB4AIEAnQDGAOAAIgAjADEAPQBB",
  "ADUALQAtAE0AVQBdAGwAbABeAGsAZABjAGYAagBoAGUAdQB6AIEAhwCDAHsAWgBaAIkAwwDQAMsAJwAxADkAOwA8AC0ASwA2AD8A",
  "RABkAHkAaQBrAHQAawB1AGkAaAB0AHkAcAB6AIAAfwBoAGgAWgBaAH0AigCzALgAMAAzADcAPAA/AEsATQBSAEoAWABXAGwAZAB0",
  "AGsAZABnAG8AeABuAG0AgACCAHIAaAB6AIsApwC3AMcAzADXANcANQAxADgAOwA4AEoAUQBGAEwAZABZAFgAWQBiAFoAXABpAHsA",
  "cQBuAGgAbwB9AG0AeQCkAL8A0ADYAO8A+QAIARoBKwAyADsARABCAD8ASQBGAEgATQBVAFEAVgBVAFwAYwBiAFoAaABmAGcAcgBv",
  "AIsAqgDjAAQBCQEdATcBSgFCAWEBKAAnADgAQQBGAFAATQBNAEkARQBSAFUAXwBXAFoAXgBgAF0AXwBnAGQAbQCWALwA6gBQAWEB",
  "YwF7AagBmwGbAY8BMAApAEAARwBNAFMATgBTAEwASABXAGYAcgBlAFwAXgBaAFUAXQBNAFoAkwC/APkAUgG+Ad4B7gESAigCCwLU",
  "AdYBOwAtAE8ASgBJAEgARQBNAFsAVABfAGUAYwBXAE8AWgBVAEcARgBuAJAAxQD8AHIBwwElAk0CjQKyAo4CYwJjAk4COAAtADwA",
  "QQBGAD8AQQBKAFkAUwBaAFwAVABMAF0AXgBAAE4AaQCbANAAJgFlAeABRAKsAusCLQMkA/cC8gLHArICLgAyAEkAPwBHAEgAUwBT",
  "AFQARABhAGQAUABbAF4APgBKAG8AogDxAC0BrQH7AW8CtAJWA4EDkgN4A00DQgP9ArQCOgA6AEAARwBPAEsAWwBVAFMAVABaAFMA",
  "SQA2ADQAZAB3ALEA3wA6AX0BGQKFAgADTAPBA+MD8QPhA4sDXgP+Ap8CNQA4AD4ARgBLAE8ASwBCAFQAYABJADoAJgAvAFYAggCj",
  "APYAOgGQAdoBhwLuApgD1gMTBEcEKAT1A6ADaQPNAnACQABGAEkAUAA/AEAANwA4ADUAMwAxADEAPABbAIEAoADcAEoBmQETAnQC",
  "+AJwA/EDKwREBFYEIQTsA4QDLwOXAi0CTwBCAEYATAA5ADYAIwAgAAUABQAyAEYAhgCgAK4ABQFBAboBDAKPAuYCgQPSAykEagSC",
  "BF4E/wO1AzMDuQI6Av0BQwBKAEcAOQAxADcABQAFABMAJQBaAIgAwQD2AD0BmQHjAWICmQImA5MDGgReBIsEsQSDBCgEtQNeA7kC",
  "aQIDAs8BRgBBADkANwA3ACwABQAFACUAQgBNAGQAHQFnAbwBPQKOAvQCUwP6AzYEgwSnBLIEpwQrBMwDNgPlAnoCMwLEAZoBNgA5",
  "ADkANgATAAUABQAFADcAZACdAGIANAHwAT4CtAIBA7ADFAR9BKcEtgSaBGMEBgSRAyUDtAJuAiUC1AGbAYUBNQAwADkAPQAsAAUA",
  "BQAFAFoAcQDWABsB5QE+An0CJwOQAycEggTLBM0EdAQ9BMEDgAP1ApMCLwLYAboBkwFtAWMBJAA7ACgAIAAFAAUABQAFAFQAhAD/",
  "AHgBAwJNAsECigMRBIYEtgSkBG4EIQTxAzED8AJPAgICsAGAAWkBRAFBAT8BOABDADMAKAAFAAUALQAwAFgAdgDqAD8B5gFlAuIC",
  "kwPPA0UEeQRHBBwEwwNKA8ICdQLQAZoBWAE/ASEBHAEuAS8BRgA+ADoAVwBQADYARABFAFUAZgCEABYB1gFZAr4CAwNQA/ADEgTY",
  "A54DOQPMAlYCBgK5AW8B/gD0APsACAEiASABNAA7AF0AVwA/AEcAPgBPAGYAZgBtAKsAiAHyATgChQIGA3MDWQMyAwUDjAJMAgQC",
  "wAF5AVEB1wDSAOYACgEFAQsBPQBIAFQAVwBDAEYAbgBfAGIAWgBLAG0A9QCAAcEBOwKIAr0CrQKRAl0CDwLkAaABbwE0AQwBwwC8",
  "AOEA6ADuAPcAUwBgAF4AaQBlAFMAcgBpAF4ASwBLAIIA9QAWATcBvQHaAQACCAIGAtYBpAGJAVQBLAH6ANAAqwC1AM8A3ADmAOUA",
  "agBdAGgAcwBoAGgAYQBkAEsASwBmAKYA5gDxAPYASwFUAYYBgAF4AVUBRwEnAREBEQHQAKYAnQC7ANAA2QDgAPEAcgBxAHIAZwBk",
  "AF8AXgBZAHgAbQCHAKgAvgC/AMwA6gD6ABYBIAEaAQUBDAH2ANMAyQCnAIcAqAC/AMcA0QDhAPIAagBrAGoAZgBiAGIAbgBhAGgA",
  "bACLAKQAoQC5ALwAzwDbANAA0gDeAOkA3wDOAKAAmwCQAIQAqACsAMQAywDgAPQAbQBxAG4AbABrAHMAgQB4AHcAcwCGAIsAlACl",
  "ALIAswCxALQAtgDNAMgAwQC3AJYAkQBuAHcAmAC1ALsAvwDhAAEBZwBiAHAAeQCLAI0AkwCQAIgAlgCGAI0AkgCYAKkApQClAKkA",
  "rADBALwArwCsAIMAbwB2AJQAlwCpAMsA0wDpACQBYQBtAIgAjQCJAI8AmwCbAJAAkQCVAJEAkgCWAJkApACsALAArACwAKcAqQCW",
  "AGEAXgCRAI8AuQDJANgA+ABPAYYBbABzAH0AggCSAJ0AnQCqAJwAnACZAJYAoACbAK0AmwCpALgAtAClALYAowB7AFQAgwCLAJEA",
  "0QDcABwBagG9ARkCdAB4AIQAhACfALMApQCwAK4AqgCwAKQAoACgAKgArwCuAKgAqwC2ALIAfwBsAH4AfQCIAJUA5wAzAaAB2wFG",
  "AngC",
].join('')

import type { TerrainGrid } from '../terrain.js'

/** Stable site id shared by the validation case and the demonstration scene. */
export const ASKERVEIN_SITE_ID = 'askervein-copernicus-glo30'

/** 2 km square, 33 x 33 nodes at 62.5 m, centred on the published summit coordinate. */
export const ASKERVEIN_GRID = {
  latitude: 57.1879528,
  longitude: -7.3791861,
  columns: 33,
  rows: 33,
  cellSizeM: 62.5,
} as const

/** Published summit elevation, Taylor and Teunissen (1987): 116 m of relief, 126 m ASL. */
export const ASKERVEIN_PUBLISHED_SUMMIT_M = 116

export function decodeAskerveinElevations(): number[] {
  const bytes = Buffer.from(ASKERVEIN_ELEVATIONS_BASE64, 'base64')
  const out: number[] = []
  for (let i = 0; i < bytes.byteLength / 2; i++) out.push(bytes.readUInt16LE(i * 2) / 10)
  return out
}

/**
 * The DEM as a solver input, in a local metric frame whose origin is the south-west node.
 * Both the validation run and `POST /api/field` see the same numbers.
 */
export function askerveinTerrainGrid(): TerrainGrid {
  return {
    siteId: ASKERVEIN_SITE_ID,
    originEastingM: 0,
    originNorthingM: 0,
    columns: ASKERVEIN_GRID.columns,
    rows: ASKERVEIN_GRID.rows,
    cellSizeEastingM: ASKERVEIN_GRID.cellSizeM,
    cellSizeNorthingM: ASKERVEIN_GRID.cellSizeM,
    elevationsM: decodeAskerveinElevations(),
  }
}

/** Local-frame position of the DEM's highest node, which is the campaign's HT mast site. */
export function askerveinSummit(): { eastingM: number; northingM: number; elevationM: number } {
  const elevations = decodeAskerveinElevations()
  let best = 0
  for (let i = 1; i < elevations.length; i++) if (elevations[i]! > elevations[best]!) best = i
  return {
    eastingM: (best % ASKERVEIN_GRID.columns) * ASKERVEIN_GRID.cellSizeM,
    northingM: Math.floor(best / ASKERVEIN_GRID.columns) * ASKERVEIN_GRID.cellSizeM,
    elevationM: elevations[best]!,
  }
}
