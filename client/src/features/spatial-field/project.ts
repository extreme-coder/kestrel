import { PerspectiveCamera, Vector3 } from "three";

export type SpatialFieldView = { yaw: number; pitch: number; zoom: number };

/**
 * The one description of the scene camera.
 *
 * Shared by the `<Canvas>` that draws the field and by the projection below, because the
 * moment they are two descriptions the focus ring drifts away from the turbine it is
 * supposed to be ringing — silently, and worse the further the user orbits.
 */
export const SCENE_CAMERA = { fov: 48, near: 1, far: 5_000 } as const;

export function cameraPosition({ yaw, pitch, zoom }: SpatialFieldView): [number, number, number] {
  const radius = 1_200 / zoom;
  const azimuth = yaw * Math.PI / 180;
  const elevation = (20 + pitch) * Math.PI / 180;
  const horizontal = Math.cos(elevation) * radius;
  return [Math.sin(azimuth) * horizontal, Math.sin(elevation) * radius, Math.cos(azimuth) * horizontal];
}

/** The minimum a projection needs: where the hub is, in the scene's metric frame. */
export interface ProjectableTurbine {
  id: string;
  eastingM: number;
  northingM: number;
  elevationM: number;
  hubHeightM: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ScreenTarget {
  id: string;
  /** Pixels from the left of the viewport box, clamped into it. */
  x: number;
  /** Pixels from the top of the viewport box, clamped into it. */
  y: number;
  /** Metres from the camera, so nearer machines can be drawn over further ones. */
  distanceM: number;
  /** False when the hub is behind the camera or outside the frame — the position is clamped. */
  onScreen: boolean;
}

/**
 * Where each turbine's hub lands on screen.
 *
 * This exists so the machines in the scene can be Tab stops. Everything drawn inside the
 * canvas is invisible to the accessibility tree — three.js has no DOM for a turbine — so an
 * overlay of real buttons is what gives a keyboard or screen-reader user the selection path
 * that a pointer already has. That means the overlay has to sit where the picture does.
 *
 * Off-frame targets are kept and clamped rather than dropped. Dropping them would mean a
 * machine disappearing from the Tab order because the camera moved, which is a worse failure
 * than a control at the edge of the frame: the user would have to guess that rotating the
 * view is what brings a turbine back.
 */
export function projectSceneTurbines(
  turbines: readonly ProjectableTurbine[],
  centre: { eastingM: number; northingM: number },
  view: SpatialFieldView,
  size: ViewportSize,
): ScreenTarget[] {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const camera = new PerspectiveCamera(SCENE_CAMERA.fov, width / height, SCENE_CAMERA.near, SCENE_CAMERA.far);
  camera.position.set(...cameraPosition(view));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const point = new Vector3();
  return turbines.map((turbine) => {
    point.set(
      turbine.eastingM - centre.eastingM,
      turbine.elevationM + turbine.hubHeightM,
      turbine.northingM - centre.northingM,
    );
    const distanceM = point.distanceTo(camera.position);
    point.project(camera);
    // Behind the camera, `project` mirrors the point through the origin — a hub directly
    // behind the viewer would otherwise report a plausible position in front of them.
    const behind = point.z > 1;
    const x = ((point.x + 1) / 2) * width;
    const y = ((1 - point.y) / 2) * height;
    return {
      id: turbine.id,
      x: Math.min(width, Math.max(0, behind ? width - x : x)),
      y: Math.min(height, Math.max(0, behind ? height - y : y)),
      distanceM,
      onScreen: !behind && x >= 0 && x <= width && y >= 0 && y <= height,
    };
  });
}
