import type { AnalysisRecord } from "@/features/analysis/analysis";
import { findTurbine, materialContributors, rankedByLoss } from "@/features/analysis/analysis";
import { diameters, percent } from "@/features/analysis/format";
import { bearingLabel } from "@/features/scenario/scenario";

/**
 * The viewport, in words.
 *
 * A canvas is one element with no children as far as an assistive technology is concerned, so
 * without this a screen-reader user is told there is a three-dimensional wind field and
 * nothing whatever about it. The ranked list already carries the numbers; what is missing is
 * *what the picture shows* — how many machines, which way the wind is coming from, what the
 * emphasis is currently doing, and whether anything is moving.
 *
 * It is deliberately a description and not a conclusion. Every causal statement in this
 * application is worded in one place, `describeAttribution`, and is attributed to the model;
 * a second place that phrases causes would eventually phrase one differently.
 */
export function describeScene({
  record,
  selectedId,
  bearingDeg,
  reducedMotion,
}: {
  record: AnalysisRecord | null;
  selectedId: string | null;
  bearingDeg: number;
  reducedMotion: boolean;
}): string {
  const motion = reducedMotion
    ? "Particle motion is paused, so the field is shown as a still snapshot."
    : "Particles drift along the modelled flow.";
  const encoding = "Faster air is drawn brighter and more densely, slower air darker and sparser.";

  if (!record) {
    return `A three-dimensional view of the site, from the south-east by default. ${motion} ${encoding} Turbine figures are not available yet.`;
  }

  const ranked = rankedByLoss(record);
  const worst = ranked[0];
  const bearing = Math.round(bearingDeg);
  const opening =
    `A three-dimensional view of ${record.layout.count} ${record.layout.turbine_name} turbines on measured terrain, ` +
    `with wind from ${bearing} degrees, ${bearingLabel(bearing).toLowerCase()}. ` +
    `The layout stays fixed at ${record.layout.orientation_bearing_deg} degrees while the wind turns.`;

  const selected = findTurbine(record, selectedId);
  if (!selected) {
    const ranking = worst
      ? ` The model ranks ${worst.id} worst, losing ${percent(worst.wake_loss_fraction)} to wakes.`
      : "";
    return `${opening} ${motion} ${encoding}${ranking} No turbine is selected; every figure in this view is also in the ranked list beside it.`;
  }

  const dominant = materialContributors(selected)[0];
  const emphasis = dominant
    ? ` ${selected.id} is selected. Its towers are drawn brightest, the machines the model involves in its loss are drawn ` +
      `next brightest, and a tube follows the modelled wake from ${dominant.turbine_id}, ` +
      `${diameters(dominant.downwind_d)} upwind. Nothing is hidden.`
    : ` ${selected.id} is selected and drawn brightest. The model finds no material wake reaching it, so no wake path is drawn.`;

  return `${opening} ${motion} ${encoding}${emphasis}`;
}
