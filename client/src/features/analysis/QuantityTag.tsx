import { ProvenanceTag } from "@/features/provenance/ProvenanceTag";
import type { AnalysisRecord } from "./analysis";

/**
 * The provenance chip that travels with one reported quantity.
 *
 * It reads the claim ids the server attached to that quantity rather than hard-coding a
 * label here, so a figure whose backing claim is removed loses its chip instead of keeping a
 * stale one. Everything the analysis reports is model output, hence the fixed `computed`
 * kind; what varies is which anchored claim stands behind it, and that goes in the title.
 */
export function QuantityTag({ record, quantity }: { record: AnalysisRecord; quantity: string }) {
  const claims = record.provenance.quantities[quantity];
  if (!claims || claims.length === 0) return null;
  return (
    <span title={`Model output. Backed by: ${claims.join(", ")}.`}>
      <ProvenanceTag provenance="computed" />
    </span>
  );
}
