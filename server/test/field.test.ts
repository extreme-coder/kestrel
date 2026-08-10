import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../src/db/index.js'
import type { DB } from '../src/db/index.js'
import { FIELD_HEADER_BYTES, FieldService, encodeVelocityField } from '../src/lib/field.js'
import { getTurbineModel } from '../src/lib/turbines.js'
import { FieldRequestSchema } from '../src/schemas.js'
import type { FieldRequestBody } from '../src/schemas.js'

const request = {
  terrain: {
    site_id: 'flat-test', origin_easting_m: 0, origin_northing_m: 0,
    columns: 5, rows: 5, cell_size_easting_m: 500, cell_size_northing_m: 500,
    elevations_m: Array(25).fill(0) as number[],
  },
  layout: { turbine: 'vestas-v112-3450', rows: 1, columns: 1, hub_height_m: 100, origin_easting_m: 1000, origin_northing_m: 1000 },
  wind: { bearing_deg: 270, speed_ms: 10 },
  volume: { levels: 4, top_elevation_m: 500 },
}

describe('velocity field volume', () => {
  let db: DB
  beforeEach(() => { db = openDatabase() })
  afterEach(() => { db.close() })

  it('writes the documented KFLD header and RGBA8 texels', () => {
    const payload = encodeVelocityField({
      siteId: 'x', columns: 1, rows: 1, levels: 1,
      originEastingM: 12, originNorthingM: 34, cellSizeEastingM: 5,
      cellSizeNorthingM: 6, topElevationM: 100, groundElevationsM: new Float64Array([0]),
      eastMs: new Float64Array([0]), northMs: new Float64Array([0]), upMs: new Float64Array([0]),
      diagnostics: { converged: true, iterations: 0, initialMaxCellImbalanceM3s: 0, maxCellImbalanceM3s: 0, maxRelativeCellImbalance: 0 },
    }, new Float64Array([-10, 0, 10]))
    const view = new DataView(payload.buffer)
    expect(new TextDecoder().decode(payload.slice(0, 4))).toBe('KFLD')
    expect(view.getUint16(4, true)).toBe(1)
    expect(view.getUint16(6, true)).toBe(FIELD_HEADER_BYTES)
    expect([...payload.slice(FIELD_HEADER_BYTES)]).toEqual([0, 128, 255, 255])
  })

  it('builds a volume, reuses exact results, and caches base flow independently of speed', () => {
    const service = new FieldService(db, () => 123)
    const model = getTurbineModel('vestas-v112-3450')!
    const parsed = FieldRequestSchema.parse(request)
    const first = service.build(parsed, model)
    expect(first.cacheHit).toBe(false)
    expect(first.payload).toHaveLength(FIELD_HEADER_BYTES + 4 * 4 * 4 * 4)
    expect(service.build(parsed, model).cacheHit).toBe(true)

    service.build(FieldRequestSchema.parse({ ...request, wind: { ...request.wind, speed_ms: 12 } }), model)
    expect(db.prepare('SELECT COUNT(*) AS n FROM base_flow_cache').get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM field_cache').get()).toMatchObject({ n: 2 })
  })

  it('rejects a terrain elevation array with the wrong dimensions', () => {
    const service = new FieldService(db)
    const parsed = { ...FieldRequestSchema.parse(request), terrain: { ...FieldRequestSchema.parse(request).terrain, elevations_m: [0] } } as FieldRequestBody
    expect(() => service.build(parsed, getTurbineModel('vestas-v112-3450')!)).toThrow(/must contain 25/)
  })
})
