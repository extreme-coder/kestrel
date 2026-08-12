import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ProvenanceTag } from "./ProvenanceTag";
import type { ProvenanceState } from "./useProvenance";
import { VALIDATION_LABEL } from "./provenance";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className="text-xs leading-relaxed text-white/70">{value}</dd>
    </div>
  );
}

/**
 * What the model has been checked against, and what it gets wrong.
 *
 * Ordered anchored-first so the strongest claims read first, but the limitations sit inside
 * each claim rather than in a footnote: an accuracy figure without its caveat is the thing
 * this panel exists to stop.
 */
export function ModelDisclosure({ state, onClose }: { state: ProvenanceState; onClose: () => void }) {
  return (
    <section className="model-disclosure" aria-label="Model accuracy and limits">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow text-lime-300">Accuracy</p>
          <h2 className="mt-2 font-display text-xl">What this model has been checked against</h2>
        </div>
        <Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close model accuracy and limits">
          <X className="size-4" />
        </Button>
      </div>

      {state.status === "loading" ? (
        <p className="mt-4 text-sm text-white/70">Loading the validation record…</p>
      ) : null}

      {state.status === "error" ? (
        <div className="mt-4">
          <p className="text-sm leading-relaxed text-white/70">
            The validation record did not load. {state.error}. Everything on screen is still model output,
            not measurement. Reload the page to try again.
          </p>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <>
          <p className="mt-3 text-sm leading-relaxed text-white/70">{state.record.scene.validates}</p>
          <p className="mt-2 text-sm leading-relaxed text-white/70">{state.record.scene.layout.statement}</p>

          <Separator className="my-4" />

          <ul className="flex flex-col gap-5">
            {state.record.results.map((claim) => (
              <li key={claim.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{claim.label}</h3>
                  <ProvenanceTag provenance={claim.provenance} />
                  <span className="text-[10px] text-muted-foreground">{VALIDATION_LABEL[claim.validation]}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-white/70">{claim.description}</p>

                {claim.note ? <p className="mt-2 text-xs leading-relaxed text-white/60">{claim.note}</p> : null}

                {claim.anchor ? (
                  <dl className="mt-2">
                    <Row label="Case" value={claim.anchor.case} />
                    <Row label="Source" value={claim.anchor.source} />
                    <Row label="Conditions" value={claim.anchor.conditions} />
                    <Row label="Metric" value={claim.anchor.metric} />
                    <Row label="Result" value={claim.anchor.result} />
                    <div className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-3">
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Limits</dt>
                      <dd>
                        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-white/70">
                          {claim.anchor.limitations.map((limitation) => (
                            <li key={limitation}>{limitation}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>

          <Separator className="my-4" />
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Model {state.record.model_version} · anchors last re-derived {state.record.validated_at}
          </p>
        </>
      ) : null}
    </section>
  );
}
