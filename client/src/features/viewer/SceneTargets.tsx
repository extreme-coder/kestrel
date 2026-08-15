import { useMemo } from "react";
import type { AnalysisRecord } from "@/features/analysis/analysis";
import { rankedByLoss } from "@/features/analysis/analysis";
import { percent, speed } from "@/features/analysis/format";
import { projectSceneTurbines } from "@/features/spatial-field/project";
import type { SpatialFieldView, ViewportSize } from "@/features/spatial-field/project";
import { sceneCentre, sceneTurbines } from "@/features/site/SiteScene";
import type { SceneTerrain } from "@/features/site/SiteScene";

/**
 * The turbines in the scene, as controls.
 *
 * Everything drawn inside the canvas is invisible to the accessibility tree: three.js paints
 * pixels and produces no DOM, so before this the only keyboard route to a selection was the
 * ranked list in the side panel. `docs/design/wireframes.md` promises that a list row and a
 * machine in the scene are two presentations of one state and that **either** can set it. Half
 * of that promise was pointer-only.
 *
 * ## Why these ignore the pointer
 *
 * `pointer-events: none` on the whole layer. A mouse user already selects by clicking the
 * machine itself, through three.js's raycaster against the instanced mesh — the path the
 * headless test exercises. Letting an invisible button intercept those clicks would replace a
 * verified path with an unverified one and quietly retire the only test that proves the
 * picture is interactive. These are an additional input surface, not a replacement.
 *
 * ## Order
 *
 * Tab visits them worst-loss first, matching the ranked list, rather than in scene order.
 * Spatial order changes under every orbit, so a user learning "the third stop is the one I
 * want" would be re-learning it after each camera move.
 */
export function SceneTargets({
  record,
  terrain,
  view,
  size,
  selectedId,
  onSelect,
}: {
  record: AnalysisRecord | null;
  terrain: SceneTerrain | null;
  view: SpatialFieldView;
  size: ViewportSize;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const ranked = useMemo(() => (record ? rankedByLoss(record) : []), [record]);
  const targets = useMemo(() => {
    if (!record || !terrain) return new Map<string, { x: number; y: number; onScreen: boolean }>();
    const projected = projectSceneTurbines(
      sceneTurbines(record.turbines),
      sceneCentre(terrain),
      view,
      size,
    );
    return new Map(projected.map((target) => [target.id, target]));
  }, [record, terrain, view, size]);

  if (ranked.length === 0) return null;

  return (
    <ul className="scene-targets" aria-label="Turbines in the scene">
      {ranked.map((turbine, index) => {
        const target = targets.get(turbine.id);
        const selected = turbine.id === selectedId;
        return (
          <li key={turbine.id}>
            <button
              type="button"
              className={selected ? "scene-target is-selected" : "scene-target"}
              style={{ left: `${target?.x ?? 0}px`, top: `${target?.y ?? 0}px` }}
              aria-pressed={selected}
              data-turbine={turbine.id}
              onClick={() => onSelect(turbine.id)}
            >
              <span className="sr-only">
                {turbine.id}, number {index + 1} of {ranked.length} by wake loss.{" "}
                {percent(turbine.wake_loss_fraction)} lost, {speed(turbine.incoming_speed_ms)} at the rotor.
                {target && !target.onScreen ? " Outside the current view; rotate the scene to bring it into frame." : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
