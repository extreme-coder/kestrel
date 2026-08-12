import type { AnalysisRecord } from "./analysis";
import { rankedByLoss } from "./analysis";
import { kilowatts, percent, speed } from "./format";
import { QuantityTag } from "./QuantityTag";

/**
 * Wake loss per turbine, worst first — the answer form for T1.
 *
 * `docs/design/wireframes.md` fixes this as the answer to "which turbine loses the most",
 * and fixes that the 3D view is *not* scored on it. A sorted table beats a rendering at
 * reading off a maximum, and pretending otherwise would inflate the hypothesis
 * `RATIONALE.md` is trying to test honestly. The scene earns its place at attribution.
 *
 * Each row is a button because selection is one piece of state with two presentations: this
 * list and the turbines in the scene. Either can set it, which is what makes the emphasis in
 * the scene reachable without a pointer.
 */
export function TurbineRanking({
  record,
  selectedId,
  onSelect,
}: {
  record: AnalysisRecord;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const ranked = rankedByLoss(record);
  return (
    <section aria-label="Wake loss by turbine">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">Wake loss by turbine</p>
        <QuantityTag record={record} quantity="wake_loss_fraction" />
      </div>
      <ol className="mt-3 flex flex-col gap-1.5">
        {ranked.map((turbine, index) => {
          const selected = turbine.id === selectedId;
          return (
            <li key={turbine.id}>
              <button
                type="button"
                className={selected ? "turbine-row is-selected" : "turbine-row"}
                aria-pressed={selected}
                onClick={() => onSelect(turbine.id)}
              >
                <span className="turbine-row-rank" aria-hidden="true">{index + 1}</span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-medium">{turbine.id}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {speed(turbine.incoming_speed_ms)} in · {kilowatts(turbine.net_power_kw)} net
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-display text-lg leading-none tabular-nums">
                    {percent(turbine.wake_loss_fraction)}
                  </span>
                  <span className="block text-[11px] text-muted-foreground tabular-nums">
                    −{kilowatts(turbine.wake_loss_kw)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Farm wake loss</dt>
          <dd className="mt-0.5 font-display text-base tabular-nums">
            {percent(record.farm.farm_wake_loss_fraction)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Net output</dt>
          <dd className="mt-0.5 font-display text-base tabular-nums">
            {kilowatts(record.farm.total_net_power_kw)}
          </dd>
        </div>
      </dl>
      {/* The hedge is the server's string, not a local paraphrase: the model recovers about
          83% of Horns Rev's measured array loss, so every figure above is a floor. */}
      <p className="mt-3 text-[11px] leading-relaxed text-amber-200/70">
        {record.provenance.wake_loss_framing}
      </p>
    </section>
  );
}
