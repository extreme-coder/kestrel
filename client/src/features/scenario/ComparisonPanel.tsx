import { useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProvenanceTag } from "@/features/provenance/ProvenanceTag";
import { kilowatts, percent } from "@/features/analysis/format";
import type { ComparisonRecord, FieldRequest } from "./scenario";
import { bearingLabel, fetchComparison } from "./scenario";

/**
 * Percentage points, the unit a difference between two loss fractions is read in.
 *
 * Kept apart from `percent` deliberately: "16% loss" and "−9 points of loss" are different
 * claims, and writing the second as a percentage invites it to be read as the first.
 */
function points(delta: number, digits = 1): string {
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta * 100).toFixed(digits)} pp`;
}

function signedKilowatts(delta: number): string {
  return `${delta >= 0 ? "+" : "−"}${kilowatts(Math.abs(delta))}`;
}

/**
 * Which direction is good.
 *
 * More power is better; more loss is worse. The two deltas have opposite senses and no naming
 * convention fixes that, so each figure states its own direction in words rather than relying
 * on a colour the user has to learn.
 */
function verdict(delta: number, betterWhen: "higher" | "lower"): string {
  if (Math.abs(delta) < 1e-9) return "no change";
  const better = betterWhen === "higher" ? delta > 0 : delta < 0;
  return better ? "better" : "worse";
}

type ComparisonState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; record: ComparisonRecord }
  | { status: "error"; error: string };

/**
 * Pin a baseline, then read what changed.
 *
 * T3 asks whether the answer to "which turbine is worst, and why" survives another wind
 * direction. Step 10 could compute both bearings and could not put them side by side, so
 * answering it meant scrubbing the control and remembering — and a difference the user
 * reconstructs from memory is one the interface never has to be right about.
 */
export function ComparisonPanel({
  request,
  selectedId,
  onSelect,
}: {
  request: FieldRequest | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [baseline, setBaseline] = useState<FieldRequest | null>(null);
  const [state, setState] = useState<ComparisonState>({ status: "idle" });

  const candidateKey = request ? JSON.stringify(request) : "";
  const baselineKey = baseline ? JSON.stringify(baseline) : "";

  useEffect(() => {
    if (!baselineKey || !candidateKey) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchComparison(JSON.parse(baselineKey), JSON.parse(candidateKey), controller.signal)
      .then((record) => setState({ status: "ready", record }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Could not compare these scenes",
        });
      });
    return () => controller.abort();
  }, [baselineKey, candidateKey]);

  const unchanged = Boolean(baseline) && baselineKey === candidateKey;

  return (
    <section aria-label="Scenario comparison">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Comparison</p>
        <span title="Model output. A difference between two computed figures, backed by the same unanchored composition as each of them.">
          <ProvenanceTag provenance="computed" />
        </span>
      </div>

      {!baseline ? (
        <>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Pin the scene on screen, then change the bearing to see what moves.
          </p>
          <Button variant="outline" className="mt-3 w-full" onClick={() => setBaseline(request)} disabled={!request}>
            <Pin aria-hidden="true" className="size-3.5" /> Pin as baseline
          </Button>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              Baseline {baseline.wind.bearing_deg}° · {bearingLabel(baseline.wind.bearing_deg)}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline"
              onClick={() => setBaseline(null)}
            >
              <PinOff aria-hidden="true" className="size-3" /> Unpin
            </button>
          </div>

          {unchanged ? (
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground" role="status">
              The candidate is the baseline. Move the bearing to compare.
            </p>
          ) : null}

          {state.status === "loading" ? (
            <p className="mt-3 text-xs text-muted-foreground" role="status">
              Comparing…
            </p>
          ) : null}

          {state.status === "error" ? (
            <p className="mt-3 text-xs leading-relaxed text-amber-200/80" role="alert">
              {state.error}
            </p>
          ) : null}

          {state.status === "ready" && !unchanged ? (
            <ComparisonResult record={state.record} selectedId={selectedId} onSelect={onSelect} />
          ) : null}
        </>
      )}
    </section>
  );
}

function ComparisonResult({
  record,
  selectedId,
  onSelect,
}: {
  record: ComparisonRecord;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { farm } = record;
  return (
    <div className="mt-4">
      <p className="text-xs leading-relaxed text-white/80">
        {record.baseline.bearing_deg}° → {record.candidate.bearing_deg}°:{" "}
        <strong className="font-semibold">{signedKilowatts(farm.delta_total_net_power_kw)}</strong> across the farm,{" "}
        {verdict(farm.delta_total_net_power_kw, "higher")}. Wake loss{" "}
        {percent(farm.baseline_farm_wake_loss_fraction)} → {percent(farm.candidate_farm_wake_loss_fraction)} (
        {points(farm.delta_farm_wake_loss_fraction)}).
      </p>

      {/* The T3 answer in one sentence. "Nothing moved" is a real finding and has to be said
          as clearly as a change, or a stable ranking reads as a broken comparison. */}
      <p className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3 text-xs leading-relaxed">
        {farm.worst_turbine_changed ? (
          <>
            The worst turbine <strong className="font-semibold">changes</strong>: {farm.baseline_worst_turbine_id} at{" "}
            {record.baseline.bearing_deg}°, {farm.candidate_worst_turbine_id} at {record.candidate.bearing_deg}°.
          </>
        ) : (
          <>
            The worst turbine is <strong className="font-semibold">{farm.candidate_worst_turbine_id}</strong> at both
            bearings. The model's ranking holds across this change.
          </>
        )}
      </p>

      {record.only_in_baseline.length > 0 || record.only_in_candidate.length > 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200/80">
          {record.only_in_baseline.length + record.only_in_candidate.length} turbines exist in only one scene and are
          not differenced. Farm totals still describe each scene whole.
        </p>
      ) : null}

      <table className="mt-3 w-full text-[11px] tabular-nums">
        <caption className="sr-only">
          Per-turbine change from the baseline. Negative loss change is an improvement.
        </caption>
        <thead className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="pb-1 text-left font-semibold">Turbine</th>
            <th scope="col" className="pb-1 text-right font-semibold">Loss</th>
            <th scope="col" className="pb-1 text-right font-semibold">Change</th>
            <th scope="col" className="pb-1 text-right font-semibold">Net</th>
          </tr>
        </thead>
        <tbody>
          {record.turbines.map((delta) => (
            <tr
              key={delta.turbine_id}
              className={delta.turbine_id === selectedId ? "bg-white/10" : undefined}
            >
              <th scope="row" className="py-1 text-left font-normal">
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => onSelect(delta.turbine_id)}
                  aria-pressed={delta.turbine_id === selectedId}
                >
                  {delta.turbine_id}
                </button>
                {delta.dominant_contributor_changed ? (
                  <span className="ml-1 text-lime-300" title="The model's account of the cause changed">
                    ·
                  </span>
                ) : null}
              </th>
              <td className="py-1 text-right">{percent(delta.candidate_wake_loss_fraction)}</td>
              <td className="py-1 text-right">{points(delta.delta_wake_loss_fraction)}</td>
              <td className="py-1 text-right">{signedKilowatts(delta.delta_net_power_kw)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {record.provenance.wake_loss_framing} A difference between two modelled figures is no better anchored than
        either of them.
      </p>
    </div>
  );
}
