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
