import ReactThreeTestRenderer from "@react-three/test-renderer";
import { BufferGeometry, InstancedBufferGeometry, Material, ShaderMaterial, Texture, WebGLRenderTarget, type LineSegments } from "three";
import { DEFAULT_DENSITY_FLOOR, SpatialField } from "./SpatialField";
import type { VelocityField } from "./field";

const field: VelocityField = {
  columns: 2,
  rows: 2,
  levels: 2,
  originEastingM: 0,
  originNorthingM: 0,
  cellSizeEastingM: 100,
  cellSizeNorthingM: 100,
  topElevationM: 200,
  velocityScaleMs: 10,
  texels: new Uint8Array(32).fill(128),
};

describe("SpatialField scene", () => {
  it("assembles one instanced trail draw call for every particle", async () => {
    const renderer = await ReactThreeTestRenderer.create(<SpatialField field={field} particleCount={17} paused />);
    const graph = renderer.toGraph();
    expect(graph).toEqual([expect.objectContaining({ type: "LineSegments" })]);
    const instance = renderer.getInstance() as LineSegments;
    expect((instance.geometry as InstancedBufferGeometry).instanceCount).toBe(17);
    await renderer.unmount();
  });

  /**
   * Redundant encoding, checked at the seam a test can reach.
   *
   * The density itself happens on the GPU and no unit test here has one. What is checkable is
   * that the trail material carries the floor, that it is a *floor* rather than a cutoff, and
   * that changing it does not tear down the particle system — which would be the tempting
   * implementation and would drop every trail on screen.
   */
  it("carries the speed-to-density floor as a uniform the slow flow cannot fall below", async () => {
    const renderer = await ReactThreeTestRenderer.create(<SpatialField field={field} particleCount={9} paused />);
    const material = (renderer.getInstance() as LineSegments).material as ShaderMaterial;
    expect(material.uniforms.densityFloor?.value).toBe(DEFAULT_DENSITY_FLOOR);
    expect(DEFAULT_DENSITY_FLOOR).toBeGreaterThan(0);
    expect(material.vertexShader).toMatch(/mix\(densityFloor, 1\.0, pow\(speedHint, DENSITY_GAMMA\)\)/);
    // The curve has to bend, not just rise. A histogram of the demonstration volume puts 47%
    // of cells at the top of the scale and none below half, so a linear ramp spends its range
    // on speeds the field never takes and barely separates a wake from the free stream.
    const gamma = Number(/#define DENSITY_GAMMA ([\d.]+)/.exec(material.vertexShader)?.[1]);
    expect(gamma).toBeGreaterThan(1);
    // Colour still carries speed as well. Density is the redundant channel, not a replacement:
    // dropping the hue would trade one single-channel encoding for another.
    expect(material.fragmentShader).toMatch(/viridis\(speedHint\)/);

    await renderer.update(<SpatialField field={field} particleCount={9} paused densityFloor={0.5} />);
    expect((renderer.getInstance() as LineSegments).material).toBe(material);
    expect(material.uniforms.densityFloor?.value).toBe(0.5);
    await renderer.unmount();
  });

  it("explicitly disposes textures, targets, geometry, and materials on unmount", async () => {
    const textureDispose = vi.spyOn(Texture.prototype, "dispose");
    const targetDispose = vi.spyOn(WebGLRenderTarget.prototype, "dispose");
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(Material.prototype, "dispose");
    const renderer = await ReactThreeTestRenderer.create(<SpatialField field={field} particleCount={4} paused />);
    await renderer.unmount();
    expect(textureDispose).toHaveBeenCalled();
    expect(targetDispose).toHaveBeenCalledTimes(2);
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
