import type { Provenance } from "./provenance";
import { PROVENANCE_LABEL, PROVENANCE_MEANING } from "./provenance";

const TONE: Record<Provenance, string> = {
  measured: "border-sky-300/30 text-sky-200",
  derived: "border-amber-300/30 text-amber-200",
  computed: "border-lime-300/30 text-lime-200",
};

/**
 * Inline label saying where a number came from.
 *
 * The word carries the meaning; colour only reinforces it, so the label survives a
 * greyscale screenshot and a screen reader alike.
 */
export function ProvenanceTag({ provenance }: { provenance: Provenance }) {
  return (
    <span
      // 10px rather than 9. These chips are the one label that must never be skipped — a
      // figure that leaves the screen without its provenance is the failure the whole feature
      // exists to prevent — and 9px of letter-spaced uppercase is the first thing to become
      // unreadable when a page is zoomed or a screen is small.
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${TONE[provenance]}`}
      title={PROVENANCE_MEANING[provenance]}
    >
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}
