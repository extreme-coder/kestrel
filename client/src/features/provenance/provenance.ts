/**
 * The client half of the provenance contract (ADR 0004).
 *
 * The viewer renders a computed velocity field at a real place, next to real terrain, with
 * figures given to a decimal. Nothing about that presentation distinguishes a model from a
 * measurement, so the distinction has to be stated in words. This module carries it.
 */

export type Provenance = "measured" | "derived" | "computed";

export type ValidationState = "externally-anchored" | "internally-tested" | "unvalidated";

export interface ExternalAnchor {
  case: string;
  source: string;
  conditions: string;
  metric: string;
  result: string;
  limitations: string[];
}

export interface ResultClaim {
  id: string;
  label: string;
  provenance: Provenance;
  description: string;
  validation: ValidationState;
  note?: string;
  anchor?: ExternalAnchor;
}

export interface SceneProvenance {
  site_id: string;
  site_name: string;
  terrain: { provenance: Provenance; summary: string };
  layout: { provenance: Provenance; status: string; summary: string; statement: string };
  validates: string;
}

export interface ProvenanceRecord {
  model_version: string;
  validated_at: string;
  results: ResultClaim[];
  scene: SceneProvenance;
}

/** Short user-facing word for each provenance kind. Stable labels, not rotating synonyms. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  measured: "Measured",
  derived: "Derived",
  computed: "Computed",
};

export const PROVENANCE_MEANING: Record<Provenance, string> = {
  measured: "An instrument reading or published measurement, carried through unchanged.",
  derived: "A standard calculation over measured inputs.",
  computed: "Output of Kestrel's wind model.",
};

export const VALIDATION_LABEL: Record<ValidationState, string> = {
  "externally-anchored": "Checked against measurements",
  "internally-tested": "Not checked against measurements",
  unvalidated: "Not validated",
};

export async function fetchProvenance(
  signal?: AbortSignal,
  url = "/api/provenance",
): Promise<ProvenanceRecord> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Provenance request failed (${response.status})`);
  return (await response.json()) as ProvenanceRecord;
}
