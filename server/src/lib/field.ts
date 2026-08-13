import { createHash } from 'node:crypto'

import type { DB } from '../db/index.js'
import type { FieldRequestBody } from '../schemas.js'
import { solveMassConsistentBaseFlow } from './baseFlow.js'
import type { BaseFlowField } from './baseFlow.js'
import { analyseTerrainFarm } from './farmAnalysis.js'
import type { FarmAnalysis } from './farmAnalysis.js'
import { generateGridLayout } from './layout.js'
import { PHYSICS_MODEL_VERSION } from './provenance.js'
import { buildWakeStreamlines, sampleTerrainWakeField } from './terrainWake.js'
import type { Streamline } from './terrainWake.js'
import type { TerrainGrid } from './terrain.js'
import type { TurbineModel } from './turbines.js'
import type { FarmTurbine } from './wake.js'

const MAGIC = 'KFLD'
export const FIELD_HEADER_BYTES = 64

interface StoredBaseFlow extends Omit<BaseFlowField, 'groundElevationsM' | 'eastMs' | 'northMs' | 'upMs'> {
  groundElevationsM: number[]
  eastMs: number[]
  northMs: number[]
  upMs: number[]
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function restore(stored: StoredBaseFlow): BaseFlowField {
  return {
    ...stored,
    groundElevationsM: Float64Array.from(stored.groundElevationsM),
    eastMs: Float64Array.from(stored.eastMs),
    northMs: Float64Array.from(stored.northMs),
    upMs: Float64Array.from(stored.upMs),
  }
}

function store(field: BaseFlowField): StoredBaseFlow {
  return {
    ...field,
    groundElevationsM: [...field.groundElevationsM],
    eastMs: [...field.eastMs],
    northMs: [...field.northMs],
    upMs: [...field.upMs],
  }
}

/** KFLD v1: a fixed little-endian header followed by level-major RGBA8 velocity texels. */
export function encodeVelocityField(field: BaseFlowField, velocities: Float64Array): Uint8Array {
  const count = field.columns * field.rows * field.levels
  if (velocities.length !== count * 3) throw new RangeError('velocity component count does not match field dimensions')
  let scale = 0
  for (const value of velocities) scale = Math.max(scale, Math.abs(value))
  scale = Math.max(scale, Number.EPSILON)

  const output = new Uint8Array(FIELD_HEADER_BYTES + count * 4)
  output.set(new TextEncoder().encode(MAGIC), 0)
  const view = new DataView(output.buffer)
  view.setUint16(4, 1, true)
  view.setUint16(6, FIELD_HEADER_BYTES, true)
  view.setUint16(8, field.columns, true)
  view.setUint16(10, field.rows, true)
  view.setUint16(12, field.levels, true)
  view.setFloat64(16, field.originEastingM, true)
  view.setFloat64(24, field.originNorthingM, true)
  view.setFloat32(32, field.cellSizeEastingM, true)
  view.setFloat32(36, field.cellSizeNorthingM, true)
  view.setFloat32(40, field.topElevationM, true)
  view.setFloat32(44, scale, true)
  for (let i = 0; i < count; i++) {
    const target = FIELD_HEADER_BYTES + i * 4
    for (let component = 0; component < 3; component++) {
      const normalized = velocities[i * 3 + component]! / scale
      output[target + component] = Math.round((Math.max(-1, Math.min(1, normalized)) * 0.5 + 0.5) * 255)
    }
    output[target + 3] = 255
  }
  return output
}

/**
 * Place the array: explicit coordinates when the scene supplies them, a generated grid
 * otherwise.
 *
 * Both paths produce the same `FarmTurbine[]`, so nothing downstream — wakes, streamlines,
 * analysis, the volume — can tell which one it came from. That is the point: an imported
 * layout has to be as much of a first-class farm as a generated one, or the interesting
 * cases stay unreachable.
 */
function resolveTurbines(input: FieldRequestBody, model: TurbineModel): FarmTurbine[] {
  const explicit = input.layout.turbines
  if (explicit) {
    return explicit.map((turbine) => ({
      id: turbine.id,
      eastingM: turbine.easting_m,
      northingM: turbine.northing_m,
      hubHeightM: turbine.hub_height_m ?? input.layout.hub_height_m,
      model,
    }))
  }
  if (input.layout.rows === undefined || input.layout.columns === undefined) {
    throw new RangeError('layout requires either turbines, or both rows and columns')
  }
  return generateGridLayout({
    model,
    rows: input.layout.rows,
    columns: input.layout.columns,
    crosswindSpacingD: input.layout.crosswind_spacing_d,
    downwindSpacingD: input.layout.downwind_spacing_d,
    // Falling back to the wind bearing keeps a bare layout request behaving as a layout
    // generator should. A scene that lets the user change direction must send this, or
    // the array rotates with the wind and no wake relation ever changes (D26).
    prevailingBearingDeg: input.layout.orientation_bearing_deg ?? input.wind.bearing_deg,
    hubHeightM: input.layout.hub_height_m,
    staggerFraction: input.layout.stagger_fraction,
    origin: { eastingM: input.layout.origin_easting_m, northingM: input.layout.origin_northing_m },
  }).turbines
}

/** The solved scene both the volume and the per-turbine numbers are read off. */
export interface ResolvedScene {
  field: BaseFlowField
  turbines: FarmTurbine[]
  streamlines: Map<string, Streamline>
  analysis: FarmAnalysis
}

export class FieldService {
  constructor(private readonly db: DB, private readonly now: () => number = Date.now) {}

  build(input: FieldRequestBody, model: TurbineModel): { payload: Uint8Array; cacheHit: boolean } {
    // Include resolved catalogue physics and the model version, not only the request JSON:
    // changing a rotor, a Ct curve or the composition itself must invalidate an old volume
    // even when the client submits a byte-identical body.
    const fieldKey = digest({ input, model, version: PHYSICS_MODEL_VERSION })
    const cached = this.db.prepare<[string], { payload: Buffer }>('SELECT payload FROM field_cache WHERE key = ?').get(fieldKey)
    if (cached) return { payload: new Uint8Array(cached.payload), cacheHit: true }

    const { field, turbines, streamlines, analysis } = this.resolveScene(input, model)
    const velocities = new Float64Array(field.columns * field.rows * field.levels * 3)
    let cursor = 0
    for (let z = 0; z < field.levels; z++) for (let y = 0; y < field.rows; y++) for (let x = 0; x < field.columns; x++) {
      const ground = field.groundElevationsM[y * field.columns + x]!
      const sample = sampleTerrainWakeField(field, {
        eastingM: field.originEastingM + x * field.cellSizeEastingM,
        northingM: field.originNorthingM + y * field.cellSizeNorthingM,
        elevationM: ground + ((z + 0.5) / field.levels) * (field.topElevationM - ground),
      }, turbines, analysis.operatingCt, streamlines, input.wind.turbulence_intensity)
      velocities[cursor++] = sample.velocity.east
      velocities[cursor++] = sample.velocity.north
      velocities[cursor++] = sample.velocity.up
    }
    const payload = encodeVelocityField(field, velocities)
    this.db.prepare('INSERT INTO field_cache (key, payload, created_at) VALUES (?, ?, ?)')
      .run(fieldKey, Buffer.from(payload), this.now())
    return { payload, cacheHit: false }
  }

  /**
   * Per-turbine metrics for the same scene the volume is drawn from.
   *
   * Deliberately not cached: it reuses the expensive cached base-flow solve and then costs
   * one wake sample per turbine, so a cache would store more than it saves.
   */
  analyse(input: FieldRequestBody, model: TurbineModel): { analysis: FarmAnalysis; turbines: FarmTurbine[] } {
    const { turbines, analysis } = this.resolveScene(input, model)
    return { analysis, turbines }
  }

  /**
   * Analyse one scene across many (bearing, speed) conditions.
   *
   * A wind rose asks for hundreds of these — twelve directions times a speed histogram — and
   * running them through `analyse` one at a time would repeat the expensive part hundreds of
   * times over. Two facts make that avoidable:
   *
   *   - the projection solve is **linear in speed**, so one unit solve per bearing serves
   *     every speed in it, which `resolveScene` already relies on for its cache; and
   *   - a streamline is integrated along the *normalised* velocity, so scaling the field
   *     leaves the traced wake axes bit-for-bit identical. They are traced once per bearing.
   *
   * What remains per condition is the wake evaluation itself, which is the part that actually
   * differs. Conditions are grouped by bearing rather than assumed sorted, so a caller can
   * hand them over in rose order.
   */
  analyseConditions(
    input: FieldRequestBody,
    model: TurbineModel,
    conditions: readonly { bearingDeg: number; speedMs: number }[],
  ): FarmAnalysis[] {
    const byBearing = new Map<number, number[]>()
    conditions.forEach((condition, index) => {
      const existing = byBearing.get(condition.bearingDeg)
      if (existing) existing.push(index)
      else byBearing.set(condition.bearingDeg, [index])
    })

    const results = new Array<FarmAnalysis>(conditions.length)
    const turbines = resolveTurbines(input, model)

    for (const [bearingDeg, indices] of byBearing) {
      const unitField = this.unitBaseFlow({ ...input, wind: { ...input.wind, bearing_deg: bearingDeg } })
      // Traced on the unit field: direction is what a streamline follows, and the unit field
      // has the same directions as any scaling of it.
      const streamlines = buildWakeStreamlines(unitField, turbines)
      for (const index of indices) {
        const speed = conditions[index]!.speedMs
        results[index] = analyseTerrainFarm(scaleField(unitField, speed), turbines, streamlines, {
          bearingDeg,
          turbulenceIntensity: input.wind.turbulence_intensity,
        })
      }
    }

    return results
  }

  /**
   * Solve the base flow, place the layout, trace the wake axes, and resolve the operating
   * state — everything `POST /api/field` and `POST /api/analysis` must agree about.
   *
   * The thrust coefficients come from the terrain-aware analysis rather than from `wake.ts`'s
   * flat-plane `evaluateFarm`, so the wake depths drawn in the volume are the ones the
   * reported numbers describe. Resolving them twice, two ways, is how a picture and a table
   * come to disagree about which turbine is worst.
   */
  private resolveScene(input: FieldRequestBody, model: TurbineModel): ResolvedScene {
    const field = scaleField(this.unitBaseFlow(input), input.wind.speed_ms)
    const turbines = resolveTurbines(input, model)
    const streamlines = buildWakeStreamlines(field, turbines)
    const analysis = analyseTerrainFarm(field, turbines, streamlines, {
      bearingDeg: input.wind.bearing_deg,
      turbulenceIntensity: input.wind.turbulence_intensity,
    })
    return { field, turbines, streamlines, analysis }
  }

  /**
   * The mass-consistent solve at unit reference speed, from cache when it is there.
   *
   * Speed is deliberately absent from the key: the projection is linear, so one solve serves
   * every speed at that bearing. That is what makes both the viewer's speed control and the
   * annual sweep's speed histogram cheap.
   */
  private unitBaseFlow(input: FieldRequestBody): BaseFlowField {
    if (input.terrain.elevations_m.length !== input.terrain.columns * input.terrain.rows) {
      throw new RangeError(`elevations_m must contain ${input.terrain.columns * input.terrain.rows} values`)
    }

    const terrain: TerrainGrid = {
      siteId: input.terrain.site_id,
      originEastingM: input.terrain.origin_easting_m,
      originNorthingM: input.terrain.origin_northing_m,
      columns: input.terrain.columns,
      rows: input.terrain.rows,
      cellSizeEastingM: input.terrain.cell_size_easting_m,
      cellSizeNorthingM: input.terrain.cell_size_northing_m,
      elevationsM: input.terrain.elevations_m,
    }
    // Speed is deliberately absent: the projection is linear, so this cache is reusable
    // while the viewer scrubs wind speed.
    const baseSpec = {
      terrain: input.terrain,
      bearing_deg: input.wind.bearing_deg,
      reference_height_m: input.wind.reference_height_m,
      shear_exponent: input.wind.shear_exponent,
      levels: input.volume.levels,
      top_elevation_m: input.volume.top_elevation_m,
      alpha_horizontal_vertical_ratio: input.alpha_horizontal_vertical_ratio,
      version: PHYSICS_MODEL_VERSION,
    }
    const baseKey = digest(baseSpec)
    const baseRow = this.db.prepare<[string], { payload: string }>('SELECT payload FROM base_flow_cache WHERE key = ?').get(baseKey)
    let unitField: BaseFlowField
    if (baseRow) unitField = restore(JSON.parse(baseRow.payload) as StoredBaseFlow)
    else {
      unitField = solveMassConsistentBaseFlow({
        terrain,
        topElevationM: input.volume.top_elevation_m,
        levels: input.volume.levels,
        bearingDegrees: input.wind.bearing_deg,
        referenceSpeedMs: 1,
        referenceHeightM: input.wind.reference_height_m,
        shearExponent: input.wind.shear_exponent,
        alphaHorizontalVerticalRatio: input.alpha_horizontal_vertical_ratio,
      })
      this.db.prepare('INSERT INTO base_flow_cache (key, payload, created_at) VALUES (?, ?, ?)')
        .run(baseKey, JSON.stringify(store(unitField)), this.now())
    }
    return unitField
  }
}

/** Scale a unit-speed solve to a real speed. Linear, which is the whole reason it is cached. */
function scaleField(unitField: BaseFlowField, speedMs: number): BaseFlowField {
  return {
    ...unitField,
    eastMs: Float64Array.from(unitField.eastMs, (value) => value * speedMs),
    northMs: Float64Array.from(unitField.northMs, (value) => value * speedMs),
    upMs: Float64Array.from(unitField.upMs, (value) => value * speedMs),
  }
}
