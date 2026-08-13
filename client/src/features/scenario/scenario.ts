/**
 * Scenes: choosing what the viewer is looking at, and comparing two of them.
 *
 * Until step 11 the viewer could only describe the farm compiled into it. A scene is the whole
 * input — which ground, which turbines where, which wind, which directional climate — as one
 * versioned file that can be saved, edited and handed over.
 *
 * **Validation happens on the server, and there is no second validator here.** A browser-side
 * copy of the rules would be a second opinion about what a valid scene is, and the two would
 * disagree on the day one of them was updated. `POST /api/scenes/validate` is called before
 * any field request, so a bad import fails as a list of paths the user can act on rather than
 * as a 400 from a physics endpoint about a body they never wrote.
 */

export interface SceneSummary {
  id: string;
  name: string;
  description?: string;
  site_id: string;
  turbine: string;
  turbine_count: number;
  bearing_deg: number;
  has_wind_rose: boolean;
}

export interface SiteSummary {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  terrain_provenance: string;
  terrain_summary: string;
  has_wind_rose: boolean;
}

export interface SceneCatalogue {
  scene_format_version: number;
  scenes: SceneSummary[];
  sites: SiteSummary[];
}

/** The scene file itself. Deliberately opaque here — the server owns its shape. */
export type Scene = Record<string, unknown>;

export interface FieldRequest {
  terrain: {
    site_id: string;
    columns: number;
    rows: number;
    cell_size_easting_m: number;
    cell_size_northing_m: number;
    elevations_m: number[];
  };
  layout: Record<string, unknown>;
  wind: { bearing_deg: number; speed_ms: number; [key: string]: unknown };
  volume: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadedScene {
  scene: Scene;
  field_request: FieldRequest;
}

export interface SceneIssue {
  path: string;
  message: string;
}

export interface SceneValidation {
  valid: true;
  scene: Scene;
  field_request: FieldRequest;
  summary: {
    site_id: string;
    terrain_source: string;
    turbine: string;
    turbine_name: string;
    turbine_count: number;
    bearing_deg: number;
    speed_ms: number;
    wind_rose_sectors: number;
    wind_rose_conditions: number;
  };
}

/** A rejected scene, carrying everything needed to tell the user what to fix. */
export class SceneRejected extends Error {
  constructor(
    message: string,
    readonly issues: SceneIssue[] = [],
    readonly available?: string[],
  ) {
    super(message);
    this.name = "SceneRejected";
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return (await response.json()) as T;
}

export function fetchSceneCatalogue(signal?: AbortSignal, url = "/api/scenes"): Promise<SceneCatalogue> {
  return getJson<SceneCatalogue>(url, signal);
}

export function fetchScene(id: string, signal?: AbortSignal, base = "/api/scenes"): Promise<LoadedScene> {
  return getJson<LoadedScene>(`${base}/${encodeURIComponent(id)}`, signal);
}

/**
 * Validate a scene and lower it onto a field request.
 *
 * Throws `SceneRejected` with per-path issues on a 400, so the caller can list them rather
 * than showing one message about a file with several problems.
 */
export async function validateScene(
  scene: unknown,
  signal?: AbortSignal,
  url = "/api/scenes/validate",
): Promise<SceneValidation> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(scene),
  });
  if (response.ok) return (await response.json()) as SceneValidation;

  let body: { message?: string; issues?: SceneIssue[]; available?: string[] } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON error body; the status line is all there is.
  }
  throw new SceneRejected(
    body.message ?? `That scene could not be loaded (${response.status}).`,
    body.issues ?? [],
    body.available,
  );
}

/** Read a user-supplied file and validate it. Parse errors are reported as scene errors. */
export async function importSceneFile(file: File, signal?: AbortSignal): Promise<SceneValidation> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Caught here rather than sent onward: a JSON syntax error is about the file, and saying
    // "line 14" beats a round trip that can only report "not valid JSON".
    throw new SceneRejected(
      `${file.name} is not valid JSON. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
  return validateScene(parsed, signal);
}

export interface TurbineDelta {
  turbine_id: string;
  baseline_net_power_kw: number;
  candidate_net_power_kw: number;
  delta_net_power_kw: number;
  baseline_wake_loss_fraction: number;
  candidate_wake_loss_fraction: number;
  delta_wake_loss_fraction: number;
  baseline_incoming_speed_ms: number;
  candidate_incoming_speed_ms: number;
  delta_incoming_speed_ms: number;
  baseline_dominant_contributor_id: string | null;
  candidate_dominant_contributor_id: string | null;
  dominant_contributor_changed: boolean;
}

export interface ComparisonSide {
  bearing_deg: number;
  speed_ms: number;
  turbine_name: string;
  turbine_count: number;
  orientation_bearing_deg: number;
}

export interface ComparisonRecord {
  baseline: ComparisonSide;
  candidate: ComparisonSide;
  turbines: TurbineDelta[];
  farm: {
    baseline_total_net_power_kw: number;
    candidate_total_net_power_kw: number;
    delta_total_net_power_kw: number;
    baseline_farm_wake_loss_fraction: number;
    candidate_farm_wake_loss_fraction: number;
    delta_farm_wake_loss_fraction: number;
    baseline_worst_turbine_id: string | null;
    candidate_worst_turbine_id: string | null;
    worst_turbine_changed: boolean;
    largest_mover_id: string | null;
  };
  only_in_baseline: string[];
  only_in_candidate: string[];
  provenance: { wake_loss_framing: string };
}

export async function fetchComparison(
  baseline: unknown,
  candidate: unknown,
  signal?: AbortSignal,
  url = "/api/comparison",
): Promise<ComparisonRecord> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ baseline, candidate }),
  });
  if (!response.ok) throw new Error(`Comparison failed (${response.status}).`);
  return (await response.json()) as ComparisonRecord;
}

export interface AnnualRecord {
  scene: { id: string; name: string };
  turbines: {
    turbine_id: string;
    weighted_wake_loss_fraction: number;
    weighted_net_power_kw: number;
    worst_sector_bearing_deg: number;
    worst_sector_speed_ms: number;
    worst_sector_wake_loss_kw: number;
    worst_sector_wake_loss_fraction: number;
    worst_sector_frequency: number;
  }[];
  farm: {
    weighted_net_power_kw: number;
    weighted_wake_loss_fraction: number;
    worst_turbine_id: string | null;
    worst_sector_bearing_deg: number;
    worst_sector_speed_ms: number;
    worst_sector_wake_loss_kw: number;
    worst_sector_wake_loss_fraction: number;
    worst_sector_frequency: number;
  };
  sectors: {
    sector_bearing_deg: number;
    sector_weight: number;
    wake_loss_fraction: number;
    conditions: number;
  }[];
  sectors_evaluated: number;
  conditions_evaluated: number;
  frequency_covered: number;
  provenance: { wake_loss_framing: string };
}

/** Distinguishes a rare severe wake from an expected annual loss. Needs a scene, not a request. */
export async function fetchAnnual(
  scene: unknown,
  signal?: AbortSignal,
  url = "/api/annual",
): Promise<AnnualRecord> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(scene),
  });
  if (response.status === 422) {
    const body = (await response.json()) as { message?: string };
    throw new SceneRejected(body.message ?? "This scene has no wind rose.");
  }
  if (!response.ok) throw new Error(`Expected annual loss failed (${response.status}).`);
  return (await response.json()) as AnnualRecord;
}

/** Compass label for a bearing, matching the wording used beside the bearing control. */
export function bearingLabel(bearing: number): string {
  const labels = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"];
  return labels[Math.round(bearing / 45) % labels.length]!;
}
