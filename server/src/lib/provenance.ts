/**
 * Where every number Kestrel shows came from, and what has actually been checked.
 *
 * The viewer is being built to answer "which turbine is stealing whose energy", and it
 * answers with precise figures. Precision is not accuracy: a wake loss of 18.4% renders
 * exactly as confidently whether the model has been compared with a measurement or not.
 * This module is the record that keeps those apart, and it is deliberately a single source
 * for the API, the client disclosure and `docs/VALIDATION.md` so the three cannot disagree.
 *
 * Recorded results are findings, not live computations — a report states what was measured
 * on a date. `test/validation.test.ts` re-derives each one and fails if the model has moved
 * away from the recorded value, which is what stops this file becoming a historical claim
 * about code that has since changed.
 */

/**
 * Bumped whenever a change moves the numbers the physics produces. Recorded alongside every
 * result so a saved figure can be traced to the model that produced it.
 */
export const PHYSICS_MODEL_VERSION = '2026.08.2'

/** Date the anchors below were last re-derived. */
export const VALIDATION_DATE = '2026-08-12'

/**
 * How a value came to exist.
 *
 * - `measured` — an instrument reading or a published measurement, carried through unchanged.
 * - `derived` — a documented standard calculation over measured inputs, not Kestrel physics.
 *   A reanalysis product, a shear exponent fitted from two levels, a thrust coefficient read
 *   off a parametric fallback.
 * - `computed` — output of a Kestrel model. Everything the viewer draws is this.
 */
export type Provenance = 'measured' | 'derived' | 'computed'

/**
 * How far the claim has been checked.
 *
 * - `externally-anchored` — compared against a published measurement, with an error metric.
 * - `internally-tested` — invariants and relationships only. Shape assertions cannot catch a
 *   calibration error; a 43% power-curve bias once passed every one of them.
 * - `unvalidated` — neither.
 */
export type ValidationState = 'externally-anchored' | 'internally-tested' | 'unvalidated'

export interface ExternalAnchor {
  /** The measurement campaign or dataset. */
  case: string
  source: string
  /** The conditions the comparison was made under. */
  conditions: string
  /** What was compared, and how the error is defined. */
  metric: string
  /** The finding, in the metric's own terms. */
  result: string
  /** What the anchor does not establish. Surfaced to the user, not just to the report. */
  limitations: readonly string[]
}

export interface ResultClaim {
  id: string
  /** Short label for a provenance chip beside a number. */
  label: string
  provenance: Provenance
  description: string
  validation: ValidationState
  anchor?: ExternalAnchor
  /** Why the claim is not externally anchored. Required when it is not. */
  note?: string
}

export const RESULT_CLAIMS: readonly ResultClaim[] = [
  {
    id: 'terrain-elevation',
    label: 'Terrain',
    provenance: 'measured',
    description: 'Ground elevations under the scene, from the Copernicus DEM GLO-30 product.',
    validation: 'externally-anchored',
    anchor: {
      case: 'Askervein Hill summit elevation',
      source:
        'Copernicus DEM GLO-30 tile Copernicus_DSM_COG_10_N57_00_W008_00_DEM (AWS Open Data). ' +
        'Published summit elevation from Zhang (2009), Riso-R-1688(EN) section 4.1.',
      conditions: '33 x 33 nodes at 62.5 m over a 2 km square centred on the summit.',
      metric: 'Highest DEM node against the published HT mast elevation.',
      result: '122.9 m against a published 123.79 m, 0.7% low.',
      limitations: [
        'GLO-30 is a surface model, so vegetation and structures sit in the elevations.',
        'Published summit elevations disagree between sources (116 m, 123.79 m, 126 m above sea level) depending on whether relief or absolute height is meant.',
        'At 62.5 m spacing the solver resolves the summit at 118.1 m, below the DEM peak, because it works on cell centres.',
      ],
    },
  },
  {
    id: 'terrain-base-flow',
    label: 'Terrain flow',
    provenance: 'computed',
    description:
      'Mass-consistent wind field over the terrain, before turbine wakes. Sets the speed and ' +
      'direction at every point in the volume.',
    validation: 'externally-anchored',
    anchor: {
      case: 'Askervein Hill, run TU03-B',
      source:
        'Zhang (2009), CFD simulation of neutral ABL flows, Riso-R-1688(EN), Tables 4 and 5, ' +
        'reproducing Askervein 83 run TU03-B. Campaign reference: Taylor and Teunissen (1987), ' +
        'Boundary-Layer Meteorology 39, 15-39.',
      conditions:
        '210 degrees, near-neutral, 8.6 m/s at 10 m with shear exponent 0.17 fitted to the ' +
        'measured reference-site profile. 32 levels to a 500 m lid, alphaH/alphaV left at the ' +
        'documented default of 1.',
      metric:
        'Fractional speed-up at the hilltop mast, modelled against measured, at each height ' +
        'the mast pair recorded and the grid resolves.',
      result:
        'Within 0.1% at 34 m above ground. The error grows toward the surface: -14.5% at 24 m, ' +
        '-28.7% at 15 m, -32.0% at 8 m.',
      limitations: [
        'Nothing anchors the model above 34 m. The turbines sit at 100 m hub height, outside the measured range.',
        'The model does not reproduce lee-side deceleration. At 400 m downwind of the summit it recovers 13% of the measured slowdown, because a mass-consistent field has no momentum equation and cannot separate.',
        'Near-surface speed-up is under-predicted by up to a third. Do not read wind speeds close to the ground as measurements.',
        'One site, one run, one direction. Neither stability nor a second terrain type has been tested.',
        'The 500 m lid raises the modelled speed-up; a 1000 m lid gives 0.400 rather than 0.455 at 34 m.',
        'The measured values are transcribed from a report reproducing the campaign tables, not from the campaign report itself. Two internal consistency checks pass, but a transcription error upstream would carry through.',
      ],
    },
  },
  {
    id: 'wake-deficit',
    label: 'Wake loss',
    provenance: 'computed',
    description:
      'Velocity deficit behind each turbine and the power lost to it, from the ' +
      'Bastankhah-Porte-Agel Gaussian wake with Katic sum-of-squares superposition.',
    validation: 'externally-anchored',
    anchor: {
      case: 'Horns Rev 1, 8 +/- 0.5 m/s',
      source:
        'Gaumond, Rethore, Ott, Pena, Bechmann and Hansen (2013), "Evaluation of the wind ' +
        'direction uncertainty and its impact on wake modeling at the Horns Rev offshore wind ' +
        'farm", Wind Energy, doi:10.1002/we.1625, Table II.',
      conditions:
        '80 Vestas V80-2000 on a 7D parallelogram, hub 70 m, ambient turbulence intensity 7% ' +
        'as measured at the site. Farm efficiency averaged over 270 +/- 15 degrees in 0.5 degree steps.',
      metric: 'Farm efficiency, modelled against three years of production data.',
      result:
        '78.4% against a measured 73.9%, +4.5 percentage points. The model accounts for 82.9% ' +
        'of the measured array loss.',
      limitations: [
        'The model under-reads array loss by about a sixth. Reported wake losses are a floor, not a bound.',
        'Offshore, flat, one wind speed. Horns Rev says nothing about wakes over terrain, which is the case the viewer actually shows.',
        'The narrow 270 +/- 2.5 degree sector is not usable as an anchor. Kestrel deviates -18.9 points there, alongside published deviations of -20.9 (Jensen), -20.9 (Larsen) and -21.7 (Fuga); the source attributes the gap to wind-direction uncertainty in the dataset rather than to the models.',
        'Turbulence intensity is the dominant free input. 6% would halve the wide-sector error; 7% is used because it is the measured site value.',
        'No wake-added turbulence, no wake deflection under yaw, no ground reflection.',
      ],
    },
  },
  {
    id: 'hub-wind-speed',
    label: 'Rotor wind speed',
    provenance: 'computed',
    description:
      'Wind speed arriving at a rotor: the terrain flow at that hub position, reduced by the ' +
      'wakes of every turbine upwind of it.',
    validation: 'unvalidated',
    note:
      'Both halves are anchored and their combination is not. Askervein validates the terrain ' +
      'flow but has no turbines; Horns Rev validates the wakes but has no hill. Nothing ' +
      'published combines a resolved hill with an instrumented array, so wakes over terrain ' +
      'are unchecked. The terrain half is anchored only to 34 m above ground, and these rotors ' +
      'sit at 100 m.',
  },
  {
    id: 'wake-attribution',
    label: 'Attribution',
    provenance: 'computed',
    description:
      'Which upstream turbines account for a rotor\'s wake loss, and in what proportion. Shares ' +
      'split the combined deficit by the same sum-of-squares weighting used to superpose it.',
    validation: 'unvalidated',
    note:
      'Wakes do not combine linearly, so the share of a loss owed to one turbine among several ' +
      'has no unique definition; this split is the one consistent with how the deficits were ' +
      'combined, not a measurement. The ranking inherits every limitation of the wake and ' +
      'terrain models underneath it, and no measurement campaign anchors attribution over ' +
      'terrain. Treat the order as the model\'s account of the scene, not as an observed cause.',
  },
  {
    id: 'turbine-power',
    label: 'Power',
    provenance: 'computed',
    description:
      'Electrical power at a given wind speed, from a two-region parametric curve: constant ' +
      'power coefficient until the generator saturates, then flat at rated.',
    validation: 'externally-anchored',
    anchor: {
      case: 'Vestas V80-2000 manufacturer power curve',
      source: 'Published V80-2000 curve; comparison in docs/VALIDATION.md and test/power.test.ts.',
      conditions: 'Point-by-point across the operating range at reference air density.',
      metric: 'Absolute error against the published curve.',
      result: 'Mean absolute error under 7%, no single point off by more than 16%.',
      limitations: [
        'No model in the catalogue carries a measured power curve; every one uses the parametric fallback.',
        'Constant power coefficient ignores pitch roll-off near rated, which runs about 5% high there.',
      ],
    },
  },
  {
    id: 'thrust-coefficient',
    label: 'Thrust',
    provenance: 'derived',
    description:
      'Thrust coefficient at the speed each turbine sees. Sets how deep a wake that turbine ' +
      'casts, and is derived from a parametric fallback because no datasheet supplies it.',
    validation: 'externally-anchored',
    anchor: {
      case: 'Vestas V80-2000 published thrust coefficients',
      source: 'Published V80-2000 values; comparison in test/power.test.ts.',
      conditions: 'Above and below rated wind speed.',
      metric: 'Thrust coefficient against published values.',
      result: 'About 0.30 at 15 m/s and 0.08 at 25 m/s, matching the published curve.',
      limitations: [
        'Anchored on one turbine. Every other model in the catalogue uses the same parametric shape without an independent check.',
      ],
    },
  },
  {
    id: 'farm-layout-geometry',
    label: 'Layout',
    provenance: 'computed',
    description: 'Turbine positions in a synthesized wind-aligned grid at conventional spacing.',
    validation: 'externally-anchored',
    anchor: {
      case: 'Horns Rev 1 footprint',
      source: 'Published 560 m spacing and roughly 5 km by 3.8 km footprint; test/layout.test.ts.',
      conditions: 'Same turbine count, spacing and orientation as the real array.',
      metric: 'Reproduced footprint area.',
      result: 'Within 1.2% on area.',
      limitations: [
        'Anchors the spacing convention only. It says nothing about the wake physics computed on top of the geometry.',
      ],
    },
  },
  {
    id: 'wind-time-series',
    label: 'Wind data',
    provenance: 'derived',
    description: 'Hourly wind speeds and directions from the ERA5 reanalysis, via Open-Meteo.',
    validation: 'internally-tested',
    note:
      'ERA5 is a reanalysis rather than a measurement, on a roughly 25 km grid. It resolves ' +
      'synoptic weather, not local topographic acceleration, which makes it the dominant error ' +
      'term at any complex-terrain site. Parsing and caching are tested; the values are not ' +
      'compared against a mast.',
  },
  {
    id: 'wind-rose',
    label: 'Wind rose',
    provenance: 'derived',
    description:
      'How often, and with how much energy, the wind arrives from each direction. Binned from ' +
      'the hourly ERA5 direction record at the reported 100 m level.',
    validation: 'internally-tested',
    note:
      'Inherits everything that qualifies the ERA5 series it is binned from: a reanalysis on a ' +
      'roughly 25 km grid, not a mast. The direction distribution is the synoptic one, which is ' +
      'what a rose is for, but it carries no local terrain channelling — the cell serving ' +
      'Askervein is 8 km away and 67 m above sea level, and the hill is not in it. Binning, ' +
      'sector arithmetic and the energy weighting are tested; the distribution itself has not ' +
      'been compared against a measured rose.',
  },
  {
    id: 'annual-wake-loss',
    label: 'Expected annual loss',
    provenance: 'computed',
    description:
      'Wake loss expected over a year, weighting each direction sector by the share of wind ' +
      'energy that arrives in it.',
    validation: 'unvalidated',
    note:
      'Two approximations sit on top of every limitation the single-bearing loss already has. ' +
      'Each sector is evaluated at one bearing and one speed, so within-sector variation is ' +
      'lost — and the demonstration layout moves 9 percentage points across 5 degrees, which is ' +
      'far finer than the 30 degree bins. The representative speed preserves the sector\'s mean ' +
      'wind power density, which is not the same as integrating the power curve over the speed ' +
      'distribution inside it. Read this as an expectation over directions, not as annual energy.',
  },
  {
    id: 'scenario-delta',
    label: 'Comparison',
    provenance: 'computed',
    description:
      'The difference between a pinned baseline scene and a candidate, per turbine and for the ' +
      'farm total.',
    validation: 'unvalidated',
    note:
      'A difference between two model outputs, so it cancels nothing: both sides carry the same ' +
      'unanchored composition of wakes over terrain, and a delta is no better anchored than the ' +
      'two figures it subtracts. It is more trustworthy than either absolute figure only in the ' +
      'narrow sense that shared bias partly cancels, and that has not been quantified because ' +
      'there is no measurement to quantify it against.',
  },
  {
    id: 'capacity-factor',
    label: 'Capacity factor',
    provenance: 'computed',
    description: 'Annual capacity factor for a single turbine at a point.',
    validation: 'externally-anchored',
    anchor: {
      case: 'North Sea and Baltic offshore capacity factors',
      source: 'docs/VALIDATION.md, ten offshore farms against ERA5 2019.',
      conditions: 'Gross output converted to net with standard planning losses of 0.838.',
      metric: 'Net capacity factor against the established 0.32 to 0.55 band.',
      result: 'Mean 0.426, with 9 of 10 sites inside the band.',
      limitations: [
        'One year. Inter-annual North Sea variability is roughly plus or minus 5%.',
        'A band is not a reference value. This bounds the prediction rather than measuring its error.',
        'The science-fair report the original was validated against cannot be used as ground truth: its reference column is mislabelled by a factor of 1000 and several rows imply capacity factors above 1.',
      ],
    },
  },
] as const

/**
 * The sentence that has to travel with every wake-loss figure.
 *
 * The model recovers 82.9% of Horns Rev's measured array loss (D24), so a loss reported here
 * is a floor. It lives as one exported string because the server, the client panel and
 * `docs/VALIDATION.md` all have to say the same thing, and three copies of a hedge is two
 * copies that can quietly stop matching the anchor.
 */
export const WAKE_LOSS_FRAMING =
  'Modelled wake losses are a floor, not an upper limit. Against Horns Rev 1 this model ' +
  'accounted for 83% of the measured array loss, so real losses are likely larger.'

/**
 * Which claims back each quantity `POST /api/analysis` reports. ADR 0004.
 *
 * A reported quantity absent from this map is a bug rather than an unlabelled default, and
 * `test/validation.test.ts` enforces both directions: every key resolves to real claims, and
 * every field in the response has a key.
 */
export const ANALYSIS_QUANTITY_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  ground_elevation_m: ['terrain-elevation'],
  easting_m: ['farm-layout-geometry'],
  northing_m: ['farm-layout-geometry'],
  hub_height_m: ['farm-layout-geometry'],
  gross_speed_ms: ['terrain-base-flow'],
  incoming_speed_ms: ['hub-wind-speed'],
  deficit: ['wake-deficit', 'hub-wind-speed'],
  thrust_coefficient: ['thrust-coefficient'],
  gross_power_kw: ['turbine-power', 'terrain-base-flow'],
  net_power_kw: ['turbine-power', 'hub-wind-speed'],
  wake_loss_kw: ['wake-deficit', 'turbine-power'],
  wake_loss_fraction: ['wake-deficit'],
  contributors: ['wake-attribution'],
  dominant_contributor_id: ['wake-attribution'],
  wake_path: ['terrain-base-flow'],
  total_gross_power_kw: ['turbine-power', 'terrain-base-flow'],
  total_net_power_kw: ['turbine-power', 'hub-wind-speed'],
  total_wake_loss_kw: ['wake-deficit', 'turbine-power'],
  farm_wake_loss_fraction: ['wake-deficit'],
  worst_turbine_id: ['wake-deficit'],
} as const

/** Which claims back each quantity `GET /api/wind-rose` reports. */
export const WIND_ROSE_QUANTITY_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  hours: ['wind-time-series'],
  frequency: ['wind-rose'],
  mean_speed_ms: ['wind-time-series'],
  energy_speed_ms: ['wind-rose', 'wind-time-series'],
  energy_share: ['wind-rose'],
  common_sector: ['wind-rose'],
  dominant_sector_index: ['wind-rose'],
} as const

/** Which claims back each quantity `POST /api/annual` reports. */
export const ANNUAL_QUANTITY_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  turbine_id: ['farm-layout-geometry'],
  sector_weight: ['wind-rose'],
  sector_bearing_deg: ['wind-rose'],
  weighted_wake_loss_fraction: ['annual-wake-loss'],
  weighted_gross_power_kw: ['annual-wake-loss', 'turbine-power'],
  weighted_net_power_kw: ['annual-wake-loss', 'turbine-power'],
  weighted_wake_loss_kw: ['annual-wake-loss', 'wake-deficit'],
  wake_loss_fraction: ['wake-deficit'],
  gross_power_kw: ['turbine-power', 'terrain-base-flow'],
  net_power_kw: ['turbine-power', 'hub-wind-speed'],
  // The worst condition is a different quantity from the expected one, and the split is the
  // whole reason this endpoint exists: a rare severe wake and an annual expectation are not
  // the same claim and must not share a label.
  worst_turbine_id: ['annual-wake-loss'],
  worst_sector_bearing_deg: ['annual-wake-loss', 'wind-rose'],
  worst_sector_speed_ms: ['wind-rose', 'wind-time-series'],
  worst_sector_wake_loss_kw: ['wake-deficit', 'turbine-power'],
  worst_sector_wake_loss_fraction: ['wake-deficit'],
  worst_sector_frequency: ['wind-rose'],
} as const

/** Which claims back each quantity `POST /api/comparison` reports. */
export const COMPARISON_QUANTITY_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  // The bare names cover the `baseline_` and `candidate_` renderings of the same quantity;
  // the `delta_` entries are separate because a difference carries its own claim.
  net_power_kw: ['turbine-power', 'hub-wind-speed'],
  gross_power_kw: ['turbine-power', 'terrain-base-flow'],
  wake_loss_kw: ['wake-deficit', 'turbine-power'],
  wake_loss_fraction: ['wake-deficit'],
  incoming_speed_ms: ['hub-wind-speed'],
  dominant_contributor_id: ['wake-attribution'],
  dominant_contributor_changed: ['scenario-delta', 'wake-attribution'],
  total_net_power_kw: ['turbine-power', 'hub-wind-speed'],
  total_gross_power_kw: ['turbine-power', 'terrain-base-flow'],
  total_wake_loss_kw: ['wake-deficit', 'turbine-power'],
  farm_wake_loss_fraction: ['wake-deficit'],
  worst_turbine_id: ['wake-deficit'],
  largest_mover_id: ['scenario-delta'],
  delta_net_power_kw: ['scenario-delta', 'turbine-power'],
  delta_gross_power_kw: ['scenario-delta', 'turbine-power'],
  delta_wake_loss_kw: ['scenario-delta', 'wake-deficit'],
  delta_wake_loss_fraction: ['scenario-delta', 'wake-deficit'],
  delta_incoming_speed_ms: ['scenario-delta', 'hub-wind-speed'],
  delta_total_net_power_kw: ['scenario-delta', 'turbine-power'],
  delta_total_gross_power_kw: ['scenario-delta', 'turbine-power'],
  delta_total_wake_loss_kw: ['scenario-delta', 'wake-deficit'],
  delta_farm_wake_loss_fraction: ['scenario-delta', 'wake-deficit'],
  worst_turbine_changed: ['scenario-delta', 'wake-attribution'],
  matched_turbine_ids: ['farm-layout-geometry'],
} as const

/**
 * Every quantity map, so a test can enforce the ADR 0004 rule across all of them at once
 * rather than being extended by hand each time an endpoint is added — which is exactly the
 * kind of upkeep that gets forgotten and leaves a figure rendered with no provenance.
 */
export const QUANTITY_CLAIM_MAPS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  analysis: ANALYSIS_QUANTITY_CLAIMS,
  wind_rose: WIND_ROSE_QUANTITY_CLAIMS,
  annual: ANNUAL_QUANTITY_CLAIMS,
  comparison: COMPARISON_QUANTITY_CLAIMS,
} as const

/**
 * The Askervein scene the viewer ships with.
 *
 * The terrain is measured and the campaign validates the flow over it. The turbines are
 * invented. Those two facts have to travel together, because a rendered turbine on real
 * terrain reads as a real wind farm and there is no wind farm at Askervein.
 */
export const DEMONSTRATION_SCENE = {
  siteId: 'askervein-copernicus-glo30',
  siteName: 'Askervein Hill, South Uist',
  terrain: {
    provenance: 'measured' as Provenance,
    summary: 'Copernicus DEM GLO-30, 2 km square at 62.5 m.',
  },
  layout: {
    provenance: 'computed' as Provenance,
    status: 'synthetic-demonstration',
    summary: 'Four V112 turbines placed on a synthesized grid.',
    statement:
      'No wind farm exists at Askervein. The four turbines are a demonstration layout, and ' +
      'their output figures describe that invented layout, not the site.',
  },
  validates:
    'The 1982-83 Askervein campaign validates how this model steers wind over the hill. It ' +
    'says nothing about the turbines placed on it.',
} as const

/** Every limitation across anchored claims, deduplicated, for the client disclosure. */
export function collectedLimitations(): string[] {
  const seen = new Set<string>()
  for (const claim of RESULT_CLAIMS) {
    for (const limitation of claim.anchor?.limitations ?? []) seen.add(limitation)
  }
  return [...seen]
}

export function getResultClaim(id: string): ResultClaim | undefined {
  return RESULT_CLAIMS.find((claim) => claim.id === id)
}

/** snake_case projection for the JSON API. */
export function serialiseProvenance() {
  return {
    model_version: PHYSICS_MODEL_VERSION,
    validated_at: VALIDATION_DATE,
    results: RESULT_CLAIMS.map((claim) => ({
      id: claim.id,
      label: claim.label,
      provenance: claim.provenance,
      description: claim.description,
      validation: claim.validation,
      note: claim.note,
      anchor: claim.anchor
        ? {
            case: claim.anchor.case,
            source: claim.anchor.source,
            conditions: claim.anchor.conditions,
            metric: claim.anchor.metric,
            result: claim.anchor.result,
            limitations: [...claim.anchor.limitations],
          }
        : undefined,
    })),
    scene: {
      site_id: DEMONSTRATION_SCENE.siteId,
      site_name: DEMONSTRATION_SCENE.siteName,
      terrain: { ...DEMONSTRATION_SCENE.terrain },
      layout: { ...DEMONSTRATION_SCENE.layout },
      validates: DEMONSTRATION_SCENE.validates,
    },
  }
}
