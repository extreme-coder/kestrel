import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { AnalysisRecord, TurbineAnalysis } from "./analysis";
import { describeAttribution, downstreamOf, findTurbine, materialContributors } from "./analysis";
import { diameters, kilowatts, percent, speed } from "./format";
import { QuantityTag } from "./QuantityTag";
import { VerticalSection } from "./VerticalSection";
import type { SectionMarker } from "./VerticalSection";

function Figure({ label, value, quantity, record }: {
  label: string;
  value: string;
  quantity: string;
  record: AnalysisRecord;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
        <QuantityTag record={record} quantity={quantity} />
      </dt>
      <dd className="mt-1 font-display text-xl tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}

/**
 * What the model says is causing one turbine's loss — the interface half of T2.
 *
 * The contributor breakdown is the answer key: `docs/design/primary-task.md` has the
 * participant name a cause *before* this is revealed. Everything here is therefore written
 * as the model's account, never as an observation, and the shares are labelled as a split of
 * the deficit rather than as separate measurable losses, because superposed wakes do not
 * decompose uniquely.
 */
export function TurbineDetail({
  record,
  turbine,
  onSelect,
  onClear,
}: {
  record: AnalysisRecord;
  turbine: TurbineAnalysis;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const contributors = materialContributors(turbine);
  const downstream = downstreamOf(record, turbine.id);
  const dominant = contributors[0];
  const source = dominant ? findTurbine(record, dominant.turbine_id) : turbine;

  // With an incoming wake, the section shows the plume arriving at this rotor. Without one,
  // it shows this turbine's own plume and the rotors it reaches — the same picture, read
  // from the other end.
  const markers: SectionMarker[] = dominant
    ? [{ id: turbine.id, distanceM: dominant.downwind_m, hubElevationM: turbine.ground_elevation_m + turbine.hub_height_m }]
    : downstream.map((effect) => ({
        id: effect.turbine.id,
        distanceM: effect.contribution.downwind_m,
        hubElevationM: effect.turbine.ground_elevation_m + effect.turbine.hub_height_m,
      }));

  return (
    <section aria-label={`Analysis for turbine ${turbine.id}`}>
      <Button variant="ghost" className="-ml-2 h-8 px-2 text-xs" onClick={onClear}>
        <ArrowLeft aria-hidden="true" className="size-3.5" /> All turbines
      </Button>
      <h2 className="mt-2 font-display text-2xl tracking-tight">{turbine.id}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {record.layout.turbine_name} · hub {turbine.hub_height_m} m · ground{" "}
        {Math.round(turbine.ground_elevation_m)} m
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4">
        <Figure record={record} quantity="incoming_speed_ms" label="Wind at rotor" value={speed(turbine.incoming_speed_ms)} />
        <Figure record={record} quantity="wake_loss_fraction" label="Wake loss" value={percent(turbine.wake_loss_fraction)} />
        <Figure record={record} quantity="net_power_kw" label="Net power" value={kilowatts(turbine.net_power_kw)} />
        <Figure record={record} quantity="wake_loss_kw" label="Lost to wakes" value={kilowatts(turbine.wake_loss_kw)} />
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Without upstream wakes the model gives {speed(turbine.gross_speed_ms)} and{" "}
        {kilowatts(turbine.gross_power_kw)} here.
      </p>

      <Separator className="my-5" />

      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">What the model attributes it to</p>
        <QuantityTag record={record} quantity="contributors" />
      </div>
      <p className="mt-2 text-sm leading-relaxed text-white/80">{describeAttribution(record, turbine)}</p>

      {contributors.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Upstream contributors">
          {contributors.map((contributor) => (
            <li key={contributor.turbine_id}>
              <button type="button" className="contributor-row" onClick={() => onSelect(contributor.turbine_id)}>
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{contributor.turbine_id}</span>
                  <span className="tabular-nums">{percent(contributor.share, 0)} of the deficit</span>
                </span>
                <span
                  className="contributor-bar"
                  style={{ "--share": `${Math.max(2, contributor.share * 100)}%` } as React.CSSProperties}
                  aria-hidden="true"
                />
                <span className="text-[11px] text-muted-foreground">
                  {diameters(contributor.downwind_d)} upwind · wake centre {diameters(contributor.radial_d, 2)} from the
                  hub · {kilowatts(contributor.attributed_loss_kw)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {downstream.length > 0 ? (
        <div className="mt-5">
          <p className="eyebrow">Turbines this one is modelled to wake</p>
          <ul className="mt-2 flex flex-col gap-1.5" aria-label="Downstream turbines affected">
            {downstream.map((effect) => (
              <li key={effect.turbine.id}>
                <button type="button" className="contributor-row" onClick={() => onSelect(effect.turbine.id)}>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{effect.turbine.id}</span>
                    <span className="tabular-nums">{kilowatts(effect.contribution.attributed_loss_kw)}</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {diameters(effect.contribution.downwind_d)} downwind ·{" "}
                    {percent(effect.contribution.share, 0)} of that turbine&rsquo;s deficit
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {source && source.wake_path.length > 1 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-2">
            <p className="eyebrow">Wake height against the rotor</p>
            <QuantityTag record={record} quantity="wake_path" />
          </div>
          <VerticalSection
            path={source.wake_path}
            sourceId={source.id}
            rotorDiameterM={record.layout.rotor_diameter_m}
            markers={markers}
          />
        </div>
      ) : null}

      <p className="mt-4 text-[11px] leading-relaxed text-amber-200/70">
        {record.provenance.wake_loss_framing}
      </p>
    </section>
  );
}
