import { z } from 'zod'

/** ISO calendar date, YYYY-MM-DD. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'not a real date')

const latitude = z.coerce.number().min(-90).max(90)
const longitude = z.coerce.number().min(-180).max(180)

/**
 * Default window, matching the original Windsim client, which requested
 * `date_from=2019-01-01&date_to=2019-12-31`. A whole year is the right default: wind is
 * strongly seasonal, so a shorter window biases the annual mean.
 */
export const DEFAULT_START_DATE = '2019-01-01'
export const DEFAULT_END_DATE = '2019-12-31'

/**
 * Query for a point prediction. Parameter names deliberately match the original API's
 * `wind/?lat=&lon=&height=&date_from=&date_to=&turbine=&mean=month`.
 */
export const WindQuerySchema = z.object({
  lat: latitude,
  lon: longitude,
  height: z.coerce.number().min(1).max(300).default(100),
  turbine: z.string().min(1),
  date_from: isoDate.default(DEFAULT_START_DATE),
  date_to: isoDate.default(DEFAULT_END_DATE),
  mean: z.enum(['month', 'none']).default('month'),
  density: z.enum(['linear', 'iec']).default('linear'),
})

export type WindQuery = z.infer<typeof WindQuerySchema>

/**
 * Query for a direction distribution at a point.
 *
 * Shares the date defaults with every other endpoint so a rose and a prediction describe the
 * same window unless the caller says otherwise. The recorded Askervein rose deliberately does
 * not use these defaults — a climatology wants five years, and that is the script's business
 * rather than a default that would make every ad-hoc request fetch five years of hours.
 */
export const WindRoseQuerySchema = z.object({
  lat: latitude,
  lon: longitude,
  date_from: isoDate.default(DEFAULT_START_DATE),
  date_to: isoDate.default(DEFAULT_END_DATE),
  sectors: z.coerce.number().int().min(4).max(72).default(12),
  height: z.enum(['10m', '100m']).default('100m'),
  /** Share of wind energy the reported common sector must contain. */
  coverage: z.coerce.number().gt(0).max(1).default(0.5),
})

export const BoundsSchema = z
  .object({
    min_lat: latitude,
    max_lat: latitude,
    min_lon: longitude,
    max_lon: longitude,
  })
  .refine((b) => b.min_lat !== b.max_lat && b.min_lon !== b.max_lon, {
    message: 'bounds must enclose a non-zero area',
  })

export const CreateAreaRequestSchema = z.object({
  session_id: z.string().min(1).max(128),
  bounds: BoundsSchema,
  turbine: z.string().min(1),
  height: z.coerce.number().min(1).max(300).default(100),
  iterations: z.coerce.number().int().min(1).max(500).default(40),
  date_from: isoDate.default(DEFAULT_START_DATE),
  date_to: isoDate.default(DEFAULT_END_DATE),
  seed: z.coerce.number().int().optional(),
})

export type CreateAreaRequestBody = z.infer<typeof CreateAreaRequestSchema>

export const ListAreaRequestsSchema = z.object({
  session_id: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const finiteNumber = z.number().finite()

export const FieldRequestSchema = z.object({
  terrain: z.object({
    site_id: z.string().min(1).max(128),
    origin_easting_m: finiteNumber,
    origin_northing_m: finiteNumber,
    columns: z.number().int().min(2).max(257),
    rows: z.number().int().min(2).max(257),
    cell_size_easting_m: z.number().positive().finite(),
    cell_size_northing_m: z.number().positive().finite(),
    elevations_m: z.array(finiteNumber).max(257 * 257),
  }),
  layout: z.object({
    turbine: z.string().min(1),
    /**
     * Grid size. Optional only because `turbines` may place the array explicitly instead;
     * the refinement below requires one of the two.
     */
    rows: z.number().int().min(1).max(20).optional(),
    columns: z.number().int().min(1).max(20).optional(),
    /**
     * Explicit turbine positions in the local metric frame, as an alternative to the grid.
     *
     * A generated grid is a farm nobody chose. Real layouts follow ground, roads and lease
     * boundaries, and the interesting attribution cases — several plausible culprits upwind,
     * partial rotor overlap — are exactly the ones a rectangle cannot express. A scene that
     * carries coordinates is also the only kind a user can meaningfully edit.
     */
    turbines: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          easting_m: finiteNumber,
          northing_m: finiteNumber,
          hub_height_m: z.number().positive().max(300).optional(),
        }),
      )
      .min(1)
      .max(100)
      .optional(),
    /**
     * Bearing the array is *built* against, independent of the wind blowing now.
     *
     * Omitting it orients the grid to the current wind, which is what a layout generator
     * wants and what a viewer must never do: a farm that rotates with the wind presents
     * identical geometry at every bearing, so per-turbine wake losses never reorder and
     * "does this finding hold at another direction" has no answer. A scene that scrubs
     * bearing has to pin this to its design bearing (D26).
     *
     * Explicit coordinates are already fixed in the ground, so this only labels them.
     */
    orientation_bearing_deg: finiteNumber.optional(),
    crosswind_spacing_d: z.number().positive().finite().default(6),
    downwind_spacing_d: z.number().positive().finite().default(8),
    hub_height_m: z.number().positive().max(300).default(100),
    stagger_fraction: finiteNumber.default(0),
    origin_easting_m: finiteNumber.default(0),
    origin_northing_m: finiteNumber.default(0),
  }),
  wind: z.object({
    bearing_deg: finiteNumber,
    speed_ms: z.number().nonnegative().finite(),
    reference_height_m: z.number().positive().finite().default(100),
    shear_exponent: z.number().min(0).max(1).finite().default(1 / 7),
    turbulence_intensity: z.number().positive().max(1).finite().default(0.1),
  }),
  volume: z.object({
    levels: z.number().int().min(1).max(128).default(16),
    top_elevation_m: finiteNumber,
  }),
  alpha_horizontal_vertical_ratio: z.number().positive().finite().default(1),
}).superRefine((value, context) => {
  if (value.terrain.elevations_m.length !== value.terrain.columns * value.terrain.rows) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terrain', 'elevations_m'],
      message: `must contain ${value.terrain.columns * value.terrain.rows} values`,
    })
  }
  if ((value.terrain.columns - 1) * (value.terrain.rows - 1) * value.volume.levels > 250_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['volume'], message: 'volume must not exceed 250000 cells' })
  }
  const { rows, columns, turbines } = value.layout
  if (turbines) {
    const seen = new Set<string>()
    for (const [index, turbine] of turbines.entries()) {
      if (seen.has(turbine.id)) {
        // Ids are how every result refers to a turbine — the ranking, the attribution, the
        // scene selection and the comparison's matching. Two turbines sharing one would make
        // the answer to "which turbine is worst" ambiguous rather than wrong-looking.
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'turbines', index, 'id'],
          message: `duplicate turbine id "${turbine.id}"`,
        })
      }
      seen.add(turbine.id)
    }
  } else if (rows === undefined || columns === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['layout'],
      message: 'supply either layout.turbines, or both layout.rows and layout.columns',
    })
  } else if (rows * columns > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['layout'], message: 'layout must not exceed 100 turbines' })
  }
})

export type FieldRequestBody = z.infer<typeof FieldRequestSchema>

/**
 * Version of the scene file format. ADR 0005.
 *
 * A whole number that a file must state. Not "optional, assume 1": a scene is the one artefact
 * here meant to outlive the session that made it and to be handed to someone else, and a file
 * with no version is one that cannot be rejected cleanly when the format moves.
 */
export const SCENE_FORMAT_VERSION = 1

/** Terrain either names a bundled site or carries its own grid. Never both silently. */
const SceneTerrainSchema = z.union([
  z.object({ site_id: z.string().min(1).max(128) }).strict(),
  z.object({
    site_id: z.string().min(1).max(128),
    origin_easting_m: finiteNumber.default(0),
    origin_northing_m: finiteNumber.default(0),
    columns: z.number().int().min(2).max(257),
    rows: z.number().int().min(2).max(257),
    cell_size_easting_m: z.number().positive().finite(),
    cell_size_northing_m: z.number().positive().finite(),
    elevations_m: z.array(finiteNumber).max(257 * 257),
  }),
])

/**
 * A wind rose carried inside a scene, so an imported file can state its own directional
 * climate rather than borrowing whichever site the viewer last looked at.
 *
 * Only the fields the weighting reads are required. A rose fetched from `GET /api/wind-rose`
 * can be pasted in whole and the extra keys are ignored.
 *
 * `speed_bins` is required rather than optional, and that is a deliberate cost imposed on
 * anyone writing a scene by hand. A rose with only a representative speed per direction
 * cannot produce an honest expected loss: the power curve is flat above rated, so any sector
 * averaging above rated reports zero wake loss. Making the speed distribution optional would
 * make the broken answer the easy one.
 */
const SceneWindRoseSchema = z.object({
  source: z.string().min(1).max(256).optional(),
  start_date: isoDate.optional(),
  end_date: isoDate.optional(),
  hours: z.number().int().nonnegative().optional(),
  sectors: z
    .array(
      z.object({
        centre_deg: finiteNumber,
        frequency: z.number().min(0).max(1),
        /** Speed that carries the sector's mean wind power density. */
        energy_speed_ms: z.number().positive().finite(),
        energy_share: z.number().min(0).max(1).optional(),
        speed_bins: z
          .array(
            z.object({
              /** Speed carrying the bin's mean wind power density. */
              energy_speed_ms: z.number().nonnegative().finite(),
              /** Share of the whole year's hours in this (direction, speed) cell. */
              frequency: z.number().min(0).max(1),
              from_ms: z.number().nonnegative().finite().optional(),
              to_ms: z.number().nonnegative().finite().optional(),
            }),
          )
          .min(1)
          .max(64),
      }),
    )
    .min(1)
    .max(72),
})

export const SceneSchema = z
  .object({
    kestrel_scene: z.literal(SCENE_FORMAT_VERSION),
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    description: z.string().max(2000).optional(),
    terrain: SceneTerrainSchema,
    layout: FieldRequestSchema.innerType().shape.layout,
    wind: FieldRequestSchema.innerType().shape.wind,
    volume: FieldRequestSchema.innerType().shape.volume,
    alpha_horizontal_vertical_ratio: z.number().positive().finite().default(1),
    wind_rose: SceneWindRoseSchema.optional(),
    /**
     * What the scene's author claims about where it came from. Free text on purpose: it is
     * read by a person deciding whether to trust the picture, and a fixed vocabulary would
     * invite a scene to be labelled `measured` by choosing an enum value.
     */
    provenance: z
      .object({
        terrain: z.string().max(500).optional(),
        layout: z.string().max(500).optional(),
        wind: z.string().max(500).optional(),
        notes: z.array(z.string().max(500)).max(20).optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if ('elevations_m' in value.terrain) {
      const expected = value.terrain.columns * value.terrain.rows
      if (value.terrain.elevations_m.length !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['terrain', 'elevations_m'],
          message: `must contain ${expected} values for a ${value.terrain.columns} x ${value.terrain.rows} grid, got ${value.terrain.elevations_m.length}`,
        })
      }
    }
    const { rows, columns, turbines } = value.layout
    if (!turbines && (rows === undefined || columns === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout'],
        message: 'supply either layout.turbines, or both layout.rows and layout.columns',
      })
    }
    if (value.wind_rose) {
      const total = value.wind_rose.sectors.reduce((sum, sector) => sum + sector.frequency, 0)
      // A rose whose frequencies do not close is not a distribution, and every weighted figure
      // computed from it would be quietly scaled by whatever the sum happened to be.
      if (Math.abs(total - 1) > 0.02) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['wind_rose', 'sectors'],
          message: `sector frequencies must sum to 1 within 0.02, got ${total.toFixed(4)}`,
        })
      }
      for (const [index, sector] of value.wind_rose.sectors.entries()) {
        const binned = sector.speed_bins.reduce((sum, bin) => sum + bin.frequency, 0)
        // Speed bins are joint frequencies, so a sector's bins must account for that
        // sector's own share of the year. If they do not, the weighting silently
        // redistributes the difference across the directions that did add up.
        if (Math.abs(binned - sector.frequency) > 0.005) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['wind_rose', 'sectors', index, 'speed_bins'],
            message:
              `speed bin frequencies must sum to the sector frequency ${sector.frequency.toFixed(4)} ` +
              `within 0.005, got ${binned.toFixed(4)}`,
          })
        }
      }
    }
  })

export type SceneBody = z.infer<typeof SceneSchema>

/**
 * Two complete scenes to difference.
 *
 * Both sides in full, rather than a baseline and a patch. A patch is smaller and cannot
 * answer "what were the two things being compared", which is the only context that makes a
 * delta readable — and a client that built the candidate by mutating the baseline in place
 * would produce a comparison of a scene with itself without either side looking wrong.
 */
export const ComparisonRequestSchema = z.object({
  baseline: FieldRequestSchema,
  candidate: FieldRequestSchema,
})

export type ComparisonRequestBody = z.infer<typeof ComparisonRequestSchema>

/** Reject a range that is inverted or longer than the archive usefully serves. */
export function validateDateRange(from: string, to: string): string | null {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (end < start) return 'date_to must not precede date_from'

  const years = (end - start) / (365.25 * 24 * 3600 * 1000)
  if (years > 5) return 'date range must not exceed 5 years'

  // ERA5 lags real time by about five days; asking beyond that returns empty hours.
  const latest = Date.now() - 5 * 24 * 3600 * 1000
  if (start > latest) return 'date_from is beyond the end of the ERA5 archive'

  return null
}
