/**
 * Per-turbine numbers for the scene on screen.
 *
 * `POST /api/analysis` takes the same body as `POST /api/field`, so the figures here and the
 * volume the particles move through are read off one solve. That is the property the whole
 * feature depends on: a ranked list that disagreed with the picture would leave a user with
 * no way to tell which one was wrong.
 *
 * Nothing in this module rounds or phrases anything. Formatting lives with the components
 * that render it, and the wording rules live in `describeAttribution`.
 */

export interface WakeContributor {
  turbine_id: string;
  deficit: number;
  /** Share of the combined deficit, in [0, 1]. Shares over all contributors sum to 1. */
  share: number;
  attributed_loss_kw: number;
  downwind_m: number;
  /** Distance in source rotor diameters — the scale wakes recover over. */
  downwind_d: number;
  radial_m: number;
  radial_d: number;
}

export interface WakePathPoint {
  easting_m: number;
  northing_m: number;
  elevation_m: number;
  ground_elevation_m: number;
  distance_m: number;
}

export interface TurbineAnalysis {
  id: string;
  easting_m: number;
  northing_m: number;
  ground_elevation_m: number;
  hub_height_m: number;
  /** Hub-height speed in the terrain flow with no turbines present. */
  gross_speed_ms: number;
  incoming_speed_ms: number;
  deficit: number;
  thrust_coefficient: number;
  gross_power_kw: number;
  net_power_kw: number;
  wake_loss_kw: number;
  wake_loss_fraction: number;
  dominant_contributor_id: string | null;
  wake_path: WakePathPoint[];
  contributors: WakeContributor[];
}

export interface FarmTotals {
  total_gross_power_kw: number;
  total_net_power_kw: number;
  total_wake_loss_kw: number;
  farm_wake_loss_fraction: number;
  worst_turbine_id: string | null;
}

export interface AnalysisRecord {
  model_version: string;
  wind: { bearing_deg: number; speed_ms: number; reference_height_m: number; turbulence_intensity: number };
  layout: {
    turbine: string;
    turbine_name: string;
    rotor_diameter_m: number;
    rated_power_kw: number;
    orientation_bearing_deg: number;
    count: number;
  };
  turbines: TurbineAnalysis[];
  farm: FarmTotals;
  provenance: {
    model_version: string;
    result: string;
    /** The hedge every loss figure has to be read with. Server-owned so it cannot drift. */
    wake_loss_framing: string;
    /** Quantity name to the claim ids backing it. A field with no entry has no provenance. */
    quantities: Record<string, string[] | undefined>;
  };
}

export async function fetchAnalysis(
  request: unknown,
  signal?: AbortSignal,
  url = "/api/analysis",
): Promise<AnalysisRecord> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(`Analysis request failed (${response.status})`);
  return (await response.json()) as AnalysisRecord;
}

/**
 * Below this share, a contributor is not named as a cause.
 *
 * A turbine standing beside another rather than behind it still registers a deficit of
 * order 1e-6, and listing it as a cause of anything would be noise presented as a finding.
 */
export const MATERIAL_SHARE = 0.005;

/**
 * Below this loss fraction, no cause is claimed at all.
 *
 * Half a percent of a turbine's output is inside every error the model has been measured to
 * have. Naming a culprit for it would be attributing a number the model cannot resolve.
 */
export const MATERIAL_LOSS_FRACTION = 0.005;

/** Turbines ordered by wake loss, worst first. Ties break by id, so the order is stable. */
export function rankedByLoss(record: AnalysisRecord): TurbineAnalysis[] {
  return [...record.turbines].sort(
    (a, b) => b.wake_loss_fraction - a.wake_loss_fraction || a.id.localeCompare(b.id),
  );
}

export function findTurbine(record: AnalysisRecord, id: string | null): TurbineAnalysis | null {
  if (!id) return null;
  return record.turbines.find((turbine) => turbine.id === id) ?? null;
}

/** Contributors worth naming, largest first. */
export function materialContributors(turbine: TurbineAnalysis): WakeContributor[] {
  if (turbine.wake_loss_fraction < MATERIAL_LOSS_FRACTION) return [];
  return turbine.contributors.filter((contributor) => contributor.share >= MATERIAL_SHARE);
}

export interface DownstreamEffect {
  turbine: TurbineAnalysis;
  contribution: WakeContributor;
}

/** The turbines this one is modelled to wake, worst first. The other half of attribution. */
export function downstreamOf(record: AnalysisRecord, id: string): DownstreamEffect[] {
  const effects: DownstreamEffect[] = [];
  for (const turbine of record.turbines) {
    if (turbine.id === id) continue;
    const contribution = materialContributors(turbine).find((entry) => entry.turbine_id === id);
    if (contribution) effects.push({ turbine, contribution });
  }
  return effects.sort((a, b) => b.contribution.attributed_loss_kw - a.contribution.attributed_loss_kw);
}

/**
 * One sentence naming what the model says is causing a turbine's loss.
 *
 * Every phrasing here attributes the claim to the model. The interface must never say a
 * turbine *is* taking another's energy: the participant measure in
 * `docs/design/primary-task.md` counts the moments a user states model output as fact, and
 * a sentence written the other way is the interface causing exactly that.
 */
export function describeAttribution(record: AnalysisRecord, turbine: TurbineAnalysis): string {
  const bearing = Math.round(record.wind.bearing_deg);
  const contributors = materialContributors(turbine);
  const dominant = contributors[0];

  if (!dominant) {
    const downstream = downstreamOf(record, turbine.id);
    if (downstream.length > 0) {
      const worst = downstream[0]!;
      return (
        `The model finds no upstream wake reaching ${turbine.id} at ${bearing}°. ` +
        `Its own modelled wake accounts for ${Math.round(worst.contribution.attributed_loss_kw)} kW ` +
        `at ${worst.turbine.id}, ${worst.contribution.downwind_d.toFixed(1)} D downwind.`
      );
    }
    return `The model finds no wake interaction at ${turbine.id} at ${bearing}°.`;
  }

  const share = Math.round(dominant.share * 100);
  const others = contributors.length - 1;
  const rest = others > 0 ? `, with ${others} other contributor${others > 1 ? "s" : ""} below it` : "";
  return (
    `The model attributes ${share}% of ${turbine.id}'s ${Math.round(turbine.wake_loss_kw)} kW loss to ` +
    `${dominant.turbine_id}, ${dominant.downwind_d.toFixed(1)} D upwind, whose modelled wake centreline ` +
    `passes ${dominant.radial_d.toFixed(2)} D from the hub${rest}.`
  );
}

/** The wake axis to emphasise for a selection: the one arriving, or failing that, the one leaving. */
export function emphasisPath(record: AnalysisRecord, id: string | null): WakePathPoint[] {
  const turbine = findTurbine(record, id);
  if (!turbine) return [];
  const dominant = materialContributors(turbine)[0];
  const source = dominant ? findTurbine(record, dominant.turbine_id) : turbine;
  return source?.wake_path ?? [];
}

/** Turbine ids involved in a selection — the selected machine, its causes and its victims. */
export function involvedTurbineIds(record: AnalysisRecord, id: string | null): Set<string> {
  const turbine = findTurbine(record, id);
  if (!turbine) return new Set();
  const involved = new Set<string>([turbine.id]);
  for (const contributor of materialContributors(turbine)) involved.add(contributor.turbine_id);
  for (const effect of downstreamOf(record, turbine.id)) involved.add(effect.turbine.id);
  return involved;
}
