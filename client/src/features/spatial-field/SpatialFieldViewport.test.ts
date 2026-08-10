import { cameraPosition } from "./SpatialFieldViewport";

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
