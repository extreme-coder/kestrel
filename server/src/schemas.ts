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
    rows: z.number().int().min(1).max(20),
    columns: z.number().int().min(1).max(20),
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
  if (value.layout.rows * value.layout.columns > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['layout'], message: 'layout must not exceed 100 turbines' })
  }
})

export type FieldRequestBody = z.infer<typeof FieldRequestSchema>

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
