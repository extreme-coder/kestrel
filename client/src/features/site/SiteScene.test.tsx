import ReactThreeTestRenderer from "@react-three/test-renderer";
import { BufferGeometry, Color, Material, type Group, type InstancedMesh, type Mesh } from "three";
import type { TurbineAnalysis, WakePathPoint } from "@/features/analysis/analysis";
import { SiteScene, sceneTurbines } from "./SiteScene";

function turbine(id: string, eastingM: number, northingM: number): TurbineAnalysis {
  return {
    id,
    easting_m: eastingM,
    northing_m: northingM,
    ground_elevation_m: 90,
    hub_height_m: 100,
    gross_speed_ms: 10,
    incoming_speed_ms: 9,
    deficit: 0.1,
    thrust_coefficient: 0.8,
    gross_power_kw: 2400,
    net_power_kw: 1800,
    wake_loss_kw: 600,
    wake_loss_fraction: 0.25,
    dominant_contributor_id: null,
    wake_path: [],
    contributors: [],
  };
}

const TURBINES = [turbine("t-r1c1", 900, 1100), turbine("t-r1c2", 1100, 1100), turbine("t-r2c1", 900, 900), turbine("t-r2c2", 1100, 900)];

const PATH: WakePathPoint[] = Array.from({ length: 6 }, (_, index) => ({
  easting_m: 900 + index * 60,
  northing_m: 1100 - index * 60,
  elevation_m: 190 + index * 2,
  ground_elevation_m: 90 + index,
  distance_m: index * 85,
}));

describe("Askervein site scene", () => {
  it("builds measured terrain, lighting, and four turbines in three instanced draw calls", async () => {
    const renderer = await ReactThreeTestRenderer.create(<SiteScene turbines={TURBINES} />);
    const root = renderer.getInstance() as Group;
    const terrain = root.getObjectByName("copernicus-terrain") as Mesh;
    const turbines = root.getObjectByName("instanced-turbines") as Group;
    expect(terrain.geometry.getAttribute("position").count).toBe(33 * 33);
    expect(turbines.children).toHaveLength(3);
    for (const child of turbines.children as InstancedMesh[]) expect(child.count).toBe(4);
    expect(root.children.filter((child) => child.type.endsWith("Light"))).toHaveLength(3);
    await renderer.unmount();
  });

  it("places turbines where the solver put them rather than re-deriving the layout", () => {
    // The scene reads positions out of the analysis response. Deriving them a second time
    // here is how a picture and a table come to describe different farms.
    expect(sceneTurbines(TURBINES)).toEqual([
      { id: "t-r1c1", eastingM: 900, northingM: 1100, elevationM: 90 },
      { id: "t-r1c2", eastingM: 1100, northingM: 1100, elevationM: 90 },
      { id: "t-r2c1", eastingM: 900, northingM: 900, elevationM: 90 },
      { id: "t-r2c2", eastingM: 1100, northingM: 900, elevationM: 90 },
    ]);
  });

  it("emphasises the selection and dims the uninvolved, without hiding anything", async () => {
    // Emphasis, never filtering: removing the other turbines would remove the context that
    // makes the highlighted path legible.
    const renderer = await ReactThreeTestRenderer.create(
      <SiteScene turbines={TURBINES} selectedId="t-r2c1" involvedIds={new Set(["t-r2c1", "t-r1c1"])} />,
    );
    const towers = (renderer.getInstance() as Group).getObjectByName("instanced-turbines")!.children[0] as InstancedMesh;
    expect(towers.count).toBe(4);

    const colorAt = (index: number) => {
      const color = new Color();
      towers.getColorAt(index, color);
      return color;
    };
    const selected = colorAt(2);
    const involved = colorAt(0);
    const dimmed = colorAt(1);
    expect(selected.r).toBeGreaterThan(involved.r);
    expect(involved.r).toBeGreaterThan(dimmed.r);
    await renderer.unmount();
  });

  it("draws the emphasised wake axis as a curved tube", async () => {
    const renderer = await ReactThreeTestRenderer.create(<SiteScene turbines={TURBINES} emphasisPath={PATH} />);
    const path = (renderer.getInstance() as Group).getObjectByName("wake-path") as Mesh;
    expect(path).toBeDefined();
    expect(path.geometry.getAttribute("position").count).toBeGreaterThan(0);
    await renderer.unmount();
  });

  it("draws no wake tube when nothing is selected", async () => {
    const renderer = await ReactThreeTestRenderer.create(<SiteScene turbines={TURBINES} />);
    expect((renderer.getInstance() as Group).getObjectByName("wake-path")).toBeUndefined();
    await renderer.unmount();
  });

  it("disposes generated geometries and materials on unmount", async () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(Material.prototype, "dispose");
    const renderer = await ReactThreeTestRenderer.create(<SiteScene turbines={TURBINES} emphasisPath={PATH} />);
    await renderer.unmount();
    // Terrain, tower, nacelle, rotor, wake tube.
    expect(geometryDispose).toHaveBeenCalledTimes(5);
    // Terrain, tower, rotor/nacelle shared, wake tube.
    expect(materialDispose).toHaveBeenCalledTimes(4);
    vi.restoreAllMocks();
  });
});
