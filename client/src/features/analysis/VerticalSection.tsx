import type { WakePathPoint } from "./analysis";
import { diameters, metres } from "./format";

/**
 * The wake centreline against the ground and the rotors it passes, in elevation.
 *
 * This is the honest hedge `docs/design/wireframes.md` fixes. If the height relation between
 * a plume and a rotor only reads in the 3D view, then a user on a screen reader, a slow
 * connection or a 2D fallback loses the finding entirely — and the finding is the product.
 *
 * It is also the 2D control condition step 15 compares 3D against. Building it as an
 * afterthought would make that comparison a strawman, so it carries the same numbers and the
 * same curved axis the scene draws.
 *
 * The drawing is `aria-hidden`; the sentence underneath states the same relation in words
 * and is visible to everyone rather than hidden behind a screen-reader-only class.
 */

const WIDTH = 320;
const HEIGHT = 150;
const PAD = { left: 30, right: 8, top: 10, bottom: 20 };

export interface SectionMarker {
  id: string;
  distanceM: number;
  hubElevationM: number;
}

/** Wake centreline elevation at a distance along the axis, linearly between samples. */
export function centrelineElevationAt(path: WakePathPoint[], distanceM: number): number | null {
  if (path.length === 0) return null;
  if (distanceM <= path[0]!.distance_m) return path[0]!.elevation_m;
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1]!;
    const current = path[index]!;
    if (distanceM <= current.distance_m) {
      const span = current.distance_m - previous.distance_m;
      const t = span > 0 ? (distanceM - previous.distance_m) / span : 0;
      return previous.elevation_m + (current.elevation_m - previous.elevation_m) * t;
    }
  }
  return path[path.length - 1]!.elevation_m;
}

export function VerticalSection({
  path,
  sourceId,
  rotorDiameterM,
  markers,
}: {
  path: WakePathPoint[];
  sourceId: string;
  rotorDiameterM: number;
  markers: SectionMarker[];
}) {
  if (path.length < 2) return null;
  const radius = rotorDiameterM / 2;

  // Show a little past the furthest rotor of interest rather than the whole traced axis:
  // the axis runs to the domain edge, and scaling to it would squeeze the overlap being
  // shown into a few pixels.
  const furthestMarker = markers.reduce((max, marker) => Math.max(max, marker.distanceM), 0);
  const maxDistanceM = furthestMarker > 0
    ? Math.min(furthestMarker * 1.3, path[path.length - 1]!.distance_m)
    : path[path.length - 1]!.distance_m;
  const visible = path.filter((point) => point.distance_m <= maxDistanceM);
  if (visible.length < 2) visible.push(path[1]!);

  const elevations = [
    ...visible.map((point) => point.elevation_m),
    ...visible.map((point) => point.ground_elevation_m),
    ...markers.map((marker) => marker.hubElevationM + radius),
    ...markers.map((marker) => marker.hubElevationM - radius),
  ];
  const lowM = Math.min(...elevations) - 15;
  const highM = Math.max(...elevations) + 15;

  const x = (distanceM: number) =>
    PAD.left + (distanceM / maxDistanceM) * (WIDTH - PAD.left - PAD.right);
  const y = (elevationM: number) =>
    HEIGHT - PAD.bottom - ((elevationM - lowM) / (highM - lowM)) * (HEIGHT - PAD.top - PAD.bottom);

  const ground = `${visible.map((point) => `${x(point.distance_m)},${y(point.ground_elevation_m)}`).join(" ")} ` +
    `${x(visible[visible.length - 1]!.distance_m)},${HEIGHT - PAD.bottom} ${x(0)},${HEIGHT - PAD.bottom}`;
  const centreline = visible
    .map((point) => `${x(point.distance_m)},${y(point.elevation_m)}`)
    .join(" ");
  const sourceHubM = visible[0]!.elevation_m;

  return (
    <figure className="section-inset">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" aria-hidden="true" focusable="false">
        <polygon points={ground} fill="rgba(140,160,130,0.22)" stroke="rgba(180,200,170,0.45)" strokeWidth="1" />
        <polyline points={centreline} fill="none" stroke="#c9f36b" strokeWidth="2" strokeDasharray="5 3" />
        <line x1={x(0)} y1={y(sourceHubM - radius)} x2={x(0)} y2={y(sourceHubM + radius)} stroke="#f4f7ef" strokeWidth="2.5" />
        {markers.map((marker) => (
          <g key={marker.id}>
            <line
              x1={x(marker.distanceM)}
              y1={y(marker.hubElevationM - radius)}
              x2={x(marker.distanceM)}
              y2={y(marker.hubElevationM + radius)}
              stroke="#f4f7ef"
              strokeWidth="2.5"
            />
            <text x={x(marker.distanceM)} y={y(marker.hubElevationM + radius) - 4} fill="#f4f7ef" fontSize="8" textAnchor="middle">
              {marker.id}
            </text>
          </g>
        ))}
        <text x={x(0)} y={HEIGHT - 6} fill="#8d9b94" fontSize="8" textAnchor="start">{sourceId}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} fill="#8d9b94" fontSize="8" textAnchor="end">
          {diameters(maxDistanceM / rotorDiameterM, 0)} downwind
        </text>
        <text x={4} y={y(highM - 15) + 3} fill="#8d9b94" fontSize="8">{metres(highM - 15)}</text>
        <text x={4} y={y(lowM + 15) + 3} fill="#8d9b94" fontSize="8">{metres(lowM + 15)}</text>
      </svg>
      <figcaption className="mt-2 text-[11px] leading-relaxed text-white/60">
        {describeSection(path, sourceId, rotorDiameterM, markers)}
      </figcaption>
    </figure>
  );
}

/** The same relation the drawing shows, in words. Exported so it can be tested directly. */
export function describeSection(
  path: WakePathPoint[],
  sourceId: string,
  rotorDiameterM: number,
  markers: SectionMarker[],
): string {
  const radius = rotorDiameterM / 2;
  const start = path[0];
  if (!start) return "";
  const rise = (path[path.length - 1]?.elevation_m ?? start.elevation_m) - start.elevation_m;
  const terrain = Math.abs(rise) < 5
    ? `The modelled axis stays level as it crosses the site.`
    : `The modelled axis ${rise > 0 ? "climbs" : "descends"} ${metres(Math.abs(rise))} as it crosses the site.`;

  if (markers.length === 0) {
    return `Section along ${sourceId}'s modelled wake axis, from hub height at ${metres(start.elevation_m)}. ${terrain}`;
  }
  const marker = markers[0]!;
  const centreline = centrelineElevationAt(path, marker.distanceM);
  if (centreline === null) return terrain;
  const offset = Math.abs(centreline - marker.hubElevationM);
  return (
    `At ${diameters(marker.distanceM / rotorDiameterM)} downwind the modelled wake centreline sits at ` +
    `${metres(centreline)}, and ${marker.id}'s rotor spans ${metres(marker.hubElevationM - radius)} to ` +
    `${metres(marker.hubElevationM + radius)} — the centreline passes ` +
    `${diameters(offset / rotorDiameterM, 2)} from the hub. ${terrain}`
  );
}
