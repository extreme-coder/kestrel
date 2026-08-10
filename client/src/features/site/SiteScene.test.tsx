import ReactThreeTestRenderer from "@react-three/test-renderer";
import { BufferGeometry, Material, type Group, type InstancedMesh, type Mesh } from "three";
import { SiteScene, turbinePositions } from "./SiteScene";

describe("Askervein site scene", () => {
  it("builds measured terrain, lighting, and four turbines in three instanced draw calls", async () => {
    const renderer = await ReactThreeTestRenderer.create(<SiteScene />);
    const root = renderer.getInstance() as Group;
    const terrain = root.getObjectByName("copernicus-terrain") as Mesh;
    const turbines = root.getObjectByName("instanced-turbines") as Group;
    expect(terrain.geometry.getAttribute("position").count).toBe(33 * 33);
    expect(turbines.children).toHaveLength(3);
    for (const child of turbines.children as InstancedMesh[]) expect(child.count).toBe(4);
    expect(root.children.filter((child) => child.type.endsWith("Light"))).toHaveLength(3);
    await renderer.unmount();
  });

  it("keeps every turbine inside the sampled domain and on measured ground", () => {
    for (const turbine of turbinePositions()) {
      expect(turbine.eastingM).toBeGreaterThanOrEqual(0);
      expect(turbine.eastingM).toBeLessThanOrEqual(2000);
      expect(turbine.northingM).toBeGreaterThanOrEqual(0);
      expect(turbine.northingM).toBeLessThanOrEqual(2000);
      expect(turbine.elevationM).toBeGreaterThan(0);
    }
  });

  it("disposes generated geometries and materials on unmount", async () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(Material.prototype, "dispose");
    const renderer = await ReactThreeTestRenderer.create(<SiteScene />);
    await renderer.unmount();
    expect(geometryDispose).toHaveBeenCalledTimes(4);
    expect(materialDispose).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });
});

