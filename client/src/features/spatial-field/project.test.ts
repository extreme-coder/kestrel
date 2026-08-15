import { cameraPosition, projectSceneTurbines } from "./project";

const CENTRE = { eastingM: 1_000, northingM: 1_000 };
const SIZE = { width: 1_200, height: 800 };
const VIEW = { yaw: 0, pitch: 0, zoom: 1 };

/** One machine at the scene origin, at a hub height low enough to sit inside the frame. */
const AT_CENTRE = { id: "centre", eastingM: 1_000, northingM: 1_000, elevationM: 0, hubHeightM: 0 };

describe("SpatialField camera", () => {
  it("zooms by moving the camera toward the scene target", () => {
    const distance = (position: [number, number, number]) => Math.hypot(...position);
    expect(distance(cameraPosition({ yaw: 0, pitch: 0, zoom: 1 }))).toBeCloseTo(1_200);
    expect(distance(cameraPosition({ yaw: 0, pitch: 0, zoom: 1.2 }))).toBeCloseTo(1_000);
  });

  it("orbits around the scene without changing camera distance", () => {
    const first = cameraPosition({ yaw: 0, pitch: 0, zoom: 1 });
    const rotated = cameraPosition({ yaw: 90, pitch: 0, zoom: 1 });
    expect(Math.hypot(...rotated)).toBeCloseTo(Math.hypot(...first));
    expect(rotated[0]).toBeGreaterThan(1_000);
    expect(Math.abs(rotated[2])).toBeLessThan(0.001);
  });
});

describe("projecting turbines onto the viewport", () => {
  it("puts the scene target in the middle of the frame", () => {
    const [target] = projectSceneTurbines([AT_CENTRE], CENTRE, VIEW, SIZE);
    expect(target!.x).toBeCloseTo(SIZE.width / 2, 1);
    expect(target!.y).toBeCloseTo(SIZE.height / 2, 1);
    expect(target!.onScreen).toBe(true);
  });

  it("separates machines the way the camera sees them, and follows an orbit", () => {
    const east = { ...AT_CENTRE, id: "east", eastingM: 1_300 };
    const west = { ...AT_CENTRE, id: "west", eastingM: 700 };

    const [eastTarget, westTarget] = projectSceneTurbines([east, west], CENTRE, VIEW, SIZE);
    expect(eastTarget!.x).toBeGreaterThan(westTarget!.x);

    // Orbiting 180° swaps which one is on the left. If the overlay ever stops tracking the
    // camera this is the check that fails, rather than the rings quietly sliding off.
    const [spunEast, spunWest] = projectSceneTurbines([east, west], CENTRE, { ...VIEW, yaw: 180 }, SIZE);
    expect(spunEast!.x).toBeLessThan(spunWest!.x);
  });

  it("puts a taller hub higher up the frame", () => {
    const [ground] = projectSceneTurbines([AT_CENTRE], CENTRE, VIEW, SIZE);
    const [hub] = projectSceneTurbines([{ ...AT_CENTRE, hubHeightM: 100 }], CENTRE, VIEW, SIZE);
    expect(hub!.y).toBeLessThan(ground!.y);
  });

  it("reports the distance the camera is looking from, nearest first when sorted", () => {
    const near = { ...AT_CENTRE, id: "near", northingM: 1_600 };
    const far = { ...AT_CENTRE, id: "far", northingM: 400 };
    const [nearTarget, farTarget] = projectSceneTurbines([near, far], CENTRE, VIEW, SIZE);
    expect(nearTarget!.distanceM).toBeLessThan(farTarget!.distanceM);
  });

  /**
   * A hub behind the camera projects through the origin and reads as a plausible position in
   * front of the viewer. Marking it off-screen is what lets the overlay say "rotate to bring
   * this into frame" instead of putting a focus ring on empty sky.
   */
  it("marks a turbine behind the camera as off screen and keeps it inside the box", () => {
    const behind = { ...AT_CENTRE, id: "behind", northingM: 1_000 + 4_000 };
    const [target] = projectSceneTurbines([behind], CENTRE, VIEW, SIZE);
    expect(target!.onScreen).toBe(false);
    expect(target!.x).toBeGreaterThanOrEqual(0);
    expect(target!.x).toBeLessThanOrEqual(SIZE.width);
    expect(target!.y).toBeGreaterThanOrEqual(0);
    expect(target!.y).toBeLessThanOrEqual(SIZE.height);
  });

  it("survives a viewport that has not been measured yet", () => {
    const targets = projectSceneTurbines([AT_CENTRE], CENTRE, VIEW, { width: 0, height: 0 });
    expect(targets).toHaveLength(1);
    expect(Number.isFinite(targets[0]!.x)).toBe(true);
    expect(Number.isFinite(targets[0]!.y)).toBe(true);
  });
});
