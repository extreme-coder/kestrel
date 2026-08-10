import ReactThreeTestRenderer from "@react-three/test-renderer";
import { BufferGeometry, InstancedBufferGeometry, Material, Texture, WebGLRenderTarget, type LineSegments } from "three";
import { SpatialField } from "./SpatialField";
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
