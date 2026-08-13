import { useEffect, useState } from "react";
import { ProvenanceTag } from "@/features/provenance/ProvenanceTag";
import { kilowatts, percent, speed } from "@/features/analysis/format";
import type { AnnualRecord, Scene } from "./scenario";
import { SceneRejected, bearingLabel, fetchAnnual } from "./scenario";

type AnnualState =
  | { status: "loading" }
  | { status: "ready"; record: AnnualRecord }
  | { status: "unavailable"; message: string }
  | { status: "error"; error: string };

/**
 * Expected loss over a year, against the worst single condition.
 *
 * Every other figure in this panel describes one bearing at one speed, and
 * `docs/design/alternate-bearing.md` measured how badly that generalises — the demonstration
 * array's wake loss nearly halves across five degrees. Two numbers are needed, not one:
 *
 *   - what the farm gives up in an average year, which is what a siting decision trades
 *     against cost, and
 *   - the worst condition it ever sees, which matters for loads and complaints even when it
 *     barely moves the annual figure.
 *
 * They are shown together, at the same size, because showing either alone misleads in a
 * different direction.
 */
export function AnnualPanel({ scene }: { scene: Scene | null }) {
  const [state, setState] = useState<AnnualState>({ status: "loading" });
  const sceneKey = scene ? JSON.stringify(scene) : "";

  useEffect(() => {
    if (!sceneKey) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchAnnual(JSON.parse(sceneKey), controller.signal)
      .then((record) => setState({ status: "ready", record }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof SceneRejected) {
          // Not an error state. A scene with no wind rose genuinely cannot be weighted, and
          // saying so is more useful than an empty panel or, far worse, a uniform rose.
          setState({ status: "unavailable", message: error.message });
          return;
        }
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Could not compute the expected annual loss",
        });
      });
    return () => controller.abort();
  }, [sceneKey]);

  return (
    <section aria-label="Expected annual loss">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Over a year</p>
        <span title="Model output, weighted by an ERA5 reanalysis wind rose. Unvalidated: an average of unanchored figures is an unanchored figure.">
          <ProvenanceTag provenance="computed" />
        </span>
      </div>

      {state.status === "loading" ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          Weighting every direction and speed…
        </p>
      ) : null}

      {state.status === "unavailable" ? (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground" role="status">
          {state.message}
        </p>
      ) : null}

      {state.status === "error" ? (
        <p className="mt-3 text-xs leading-relaxed text-amber-200/80" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.status === "ready" ? <AnnualResult record={state.record} /> : null}
    </section>
  );
}

function AnnualResult({ record }: { record: AnnualRecord }) {
  const { farm } = record;
  return (
    <div className="mt-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Expected loss</dt>
          <dd className="mt-1 font-display text-2xl tracking-tight">{percent(farm.weighted_wake_loss_fraction)}</dd>
          <dd className="mt-1 text-[10px] text-muted-foreground">weighted over the year</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Worst condition</dt>
          <dd className="mt-1 font-display text-2xl tracking-tight">{percent(farm.worst_sector_wake_loss_fraction)}</dd>
          <dd className="mt-1 text-[10px] text-muted-foreground">
            {percent(farm.worst_sector_frequency, 1)} of hours
          </dd>
        </div>
      </dl>

      {/* The distinction this panel exists for, stated rather than left to be inferred from
          two numbers sitting near each other. */}
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        The farm gives up {percent(farm.weighted_wake_loss_fraction)} of its output in an average year. Its worst
        condition — {farm.worst_sector_bearing_deg}° ({bearingLabel(farm.worst_sector_bearing_deg)}) at{" "}
        {speed(farm.worst_sector_speed_ms)} — costs {kilowatts(farm.worst_sector_wake_loss_kw)}, but blows only{" "}
        {percent(farm.worst_sector_frequency, 1)} of the time. A rare severe wake and an annual expectation are
        different claims.
      </p>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {record.sectors_evaluated} directions × {record.conditions_evaluated} direction-and-speed cells, from an ERA5
        reanalysis rose. Each cell is one bearing at one speed, so variation inside a 30° sector is not resolved —
        and this farm moves several points of loss across 5°.
      </p>

      <ol className="mt-4 space-y-1" aria-label="Wake loss by wind direction">
        {record.sectors.map((sector) => (
          <li key={sector.sector_bearing_deg} className="flex items-center gap-2 text-[11px] tabular-nums">
            <span className="w-10 shrink-0 text-right text-muted-foreground">{sector.sector_bearing_deg}°</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full bg-lime-300/70"
                style={{ width: `${Math.min(100, sector.wake_loss_fraction * 200)}%` }}
              />
            </span>
            <span className="w-11 shrink-0 text-right">{percent(sector.wake_loss_fraction)}</span>
            <span className="w-10 shrink-0 text-right text-muted-foreground">
              {percent(sector.sector_weight, 0)}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Loss from each direction, and how much of the year blows from it.
      </p>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{record.provenance.wake_loss_framing}</p>
    </div>
  );
}
