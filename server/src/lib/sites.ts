/**
 * Terrain a scene can refer to by name.
 *
 * A scene file names its terrain rather than carrying it. The Askervein grid is 1089
 * elevations; inlining it turns a scene a user can read and edit into a 20 kB wall of
 * numbers, and worse, it lets two scenes claim the same `site_id` while holding different
 * ground. The validation case, the demonstration scene and anything a user imports for this
 * site all resolve to one array, which is what keeps the campaign validating the terrain the
 * viewer actually draws.
 *
 * Inline grids stay legal — that is how someone brings their own hill — but they are
 * `provenance: 'computed'` unless the site is one of these.
 */

import { ASKERVEIN_COMMON_SECTOR, ASKERVEIN_ROSE_CELL, ASKERVEIN_WIND_ROSE } from './askerveinRose.js'
import type { CommonSector, WindRose } from './windRose.js'
import type { Provenance } from './provenance.js'
import type { TerrainGrid } from './terrain.js'
import {
  ASKERVEIN_GRID,
  ASKERVEIN_SITE_ID,
  askerveinTerrainGrid,
} from './validation/askerveinTerrain.js'

export interface BundledSite {
  id: string
  name: string
  /** Coordinate the DEM sample is centred on. */
  latitude: number
  longitude: number
  terrainProvenance: Provenance
  terrainSummary: string
  /** Recorded direction distribution, where one has been fetched for the site. */
  windRose?: WindRose
  commonSector?: CommonSector
  /** Cell ERA5 actually served, which is not the coordinate above. */
  roseCell?: { resolvedLatitude: number; resolvedLongitude: number; elevationM: number }
  grid: () => TerrainGrid
}

export const BUNDLED_SITES: readonly BundledSite[] = [
  {
    id: ASKERVEIN_SITE_ID,
    name: 'Askervein Hill, South Uist',
    latitude: ASKERVEIN_GRID.latitude,
    longitude: ASKERVEIN_GRID.longitude,
    terrainProvenance: 'measured',
    terrainSummary: 'Copernicus DEM GLO-30, 2 km square at 62.5 m, 33 x 33 nodes.',
    windRose: ASKERVEIN_WIND_ROSE,
    commonSector: ASKERVEIN_COMMON_SECTOR,
    roseCell: {
      resolvedLatitude: ASKERVEIN_ROSE_CELL.resolvedLatitude,
      resolvedLongitude: ASKERVEIN_ROSE_CELL.resolvedLongitude,
      elevationM: ASKERVEIN_ROSE_CELL.elevationM,
    },
    grid: askerveinTerrainGrid,
  },
]

export function getBundledSite(id: string): BundledSite | undefined {
  return BUNDLED_SITES.find((site) => site.id === id)
}

/** Ids a `terrain.site_id` may name, for the "did you mean" list in a validation error. */
export function bundledSiteIds(): string[] {
  return BUNDLED_SITES.map((site) => site.id)
}
