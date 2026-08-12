import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import type { TurbineAnalysis, WakePathPoint } from "@/features/analysis/analysis";
import { ASKERVEIN_LAYOUT, ASKERVEIN_TERRAIN } from "./askervein";

/**
 * Scene origin in site coordinates: the terrain mesh is centred on it, so everything drawn
 * has its easting and northing shifted by this much.
 */
const SCENE_CENTRE_M = 1000;

export interface SceneTurbine {
  id: string;
  eastingM: number;
  northingM: number;
  elevationM: number;
}

/** Positions come from the solver's own layout, so the picture cannot drift from the numbers. */
export function sceneTurbines(turbines: readonly TurbineAnalysis[]): SceneTurbine[] {
  return turbines.map((turbine) => ({
    id: turbine.id,
    eastingM: turbine.easting_m,
    northingM: turbine.northing_m,
    elevationM: turbine.ground_elevation_m,
  }));
}

/**
 * How strongly a turbine is drawn.
 *
 * Emphasis, never filtering. `docs/design/wireframes.md` fixes this: dimming the uninvolved
 * machines keeps the full field as context, and hiding them would remove exactly the context
 * that makes the highlighted path legible.
 *
 * Colour is not used to mean anything here — viridis carries wind speed alone, and a second
 * colour meaning would break the legend and the colourblind-safe encoding at once. These are
 * brightness steps on one neutral hue.
 */
const EMPHASIS = {
  selected: new Color("#ffffff"),
  involved: new Color("#d8e0da"),
  context: new Color("#8f9a93"),
  dimmed: new Color("#4d5651"),
};

function emphasisColor(id: string, selectedId: string | null, involved: ReadonlySet<string>): Color {
  if (!selectedId) return EMPHASIS.context;
  if (id === selectedId) return EMPHASIS.selected;
  return involved.has(id) ? EMPHASIS.involved : EMPHASIS.dimmed;
}

function Turbines({
  turbines,
  selectedId,
  involvedIds,
  onSelect,
}: {
  turbines: SceneTurbine[];
  selectedId: string | null;
  involvedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const towers = useRef<InstancedMesh>(null), nacelles = useRef<InstancedMesh>(null), rotors = useRef<InstancedMesh>(null);
  const resources = useMemo(() => ({
    towerGeometry: new CylinderGeometry(2.5, 6, ASKERVEIN_LAYOUT.hubHeightM, 10),
    nacelleGeometry: new BoxGeometry(22, 7, 7),
    rotorGeometry: (() => {
      const geometry = new BufferGeometry();
      const vertices: number[] = [];
      const radius = ASKERVEIN_LAYOUT.rotorDiameterM / 2;
      for (let blade = 0; blade < 3; blade++) {
        const angle = blade * Math.PI * 2 / 3;
        const along = { x: Math.cos(angle), y: Math.sin(angle) };
        const across = { x: -along.y, y: along.x };
        for (const [distance, width] of [[6, 4], [6, -4], [radius, 0.7]] as const) {
          vertices.push(along.x * distance + across.x * width, along.y * distance + across.y * width, 0);
        }
      }
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
      geometry.computeVertexNormals();
      return geometry;
    })(),
    towerMaterial: new MeshStandardMaterial({ color: "#dbe4df", roughness: 0.65 }),
    rotorMaterial: new MeshStandardMaterial({ color: "#f4f7f5", roughness: 0.45, side: DoubleSide }),
  }), []);

  useLayoutEffect(() => {
    const matrix = new Matrix4();
    turbines.forEach((position, index) => {
      const x = position.eastingM - SCENE_CENTRE_M, z = position.northingM - SCENE_CENTRE_M;
      towers.current!.setMatrixAt(index, matrix.makeTranslation(x, position.elevationM + ASKERVEIN_LAYOUT.hubHeightM / 2, z));
      nacelles.current!.setMatrixAt(index, matrix.makeTranslation(x, position.elevationM + ASKERVEIN_LAYOUT.hubHeightM, z));
      rotors.current!.setMatrixAt(index, matrix.makeTranslation(x, position.elevationM + ASKERVEIN_LAYOUT.hubHeightM, z - 4));
    });
    [towers, nacelles, rotors].forEach((ref) => { if (ref.current) ref.current.instanceMatrix.needsUpdate = true; });
  }, [turbines]);

  // Per-instance colour keeps the whole array in three draw calls while still letting one
  // machine stand out — the alternative is a separate mesh for the selection.
  useLayoutEffect(() => {
    turbines.forEach((position, index) => {
      const color = emphasisColor(position.id, selectedId, involvedIds);
      [towers, nacelles, rotors].forEach((ref) => ref.current?.setColorAt(index, color));
    });
    [towers, nacelles, rotors].forEach((ref) => { if (ref.current?.instanceColor) ref.current.instanceColor.needsUpdate = true; });
  }, [turbines, selectedId, involvedIds]);

  useEffect(() => () => {
    resources.towerGeometry.dispose(); resources.nacelleGeometry.dispose(); resources.rotorGeometry.dispose();
    resources.towerMaterial.dispose(); resources.rotorMaterial.dispose();
  }, [resources]);

  const select = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const id = event.instanceId !== undefined ? turbines[event.instanceId]?.id : undefined;
    if (id) onSelect(id);
  };

  const count = turbines.length;
  if (count === 0) return null;
  return <group name="instanced-turbines">
    <instancedMesh ref={towers} args={[resources.towerGeometry, resources.towerMaterial, count]} onClick={select} />
    <instancedMesh ref={nacelles} args={[resources.nacelleGeometry, resources.rotorMaterial, count]} onClick={select} />
    <instancedMesh ref={rotors} args={[resources.rotorGeometry, resources.rotorMaterial, count]} onClick={select} />
  </group>;
}

/**
 * The selected turbine's wake axis, drawn as a tube.
 *
 * A tube rather than a line because `LineBasicMaterial.linewidth` is ignored by every WebGL
 * implementation that matters, and the emphasis this fixes is a *thicker* path. The points
 * are the server's traced streamline, so the drawn axis curves with the terrain exactly as
 * the sampled field does.
 */
function WakePath({ path }: { path: WakePathPoint[] }) {
  const geometry = useMemo(() => {
    if (path.length < 2) return null;
    const curve = new CatmullRomCurve3(
      path.map((point) => new Vector3(point.easting_m - SCENE_CENTRE_M, point.elevation_m, point.northing_m - SCENE_CENTRE_M)),
    );
    return new TubeGeometry(curve, Math.min(96, path.length * 2), 7, 6, false);
  }, [path]);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: "#c9f36b", emissive: "#5c7a26", roughness: 0.6, transparent: true, opacity: 0.55 }),
    [],
  );
  useEffect(() => () => { geometry?.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);
  if (!geometry) return null;
  return <mesh name="wake-path" geometry={geometry} material={material} />;
}

export function SiteScene({
  turbines = [],
  selectedId = null,
  involvedIds,
  emphasisPath = [],
  onSelect = () => {},
}: {
  turbines?: TurbineAnalysis[];
  selectedId?: string | null;
  involvedIds?: ReadonlySet<string>;
  emphasisPath?: WakePathPoint[];
  onSelect?: (id: string) => void;
}) {
  const resources = useMemo(() => {
    const geometry = new PlaneGeometry(2000, 2000, ASKERVEIN_TERRAIN.columns - 1, ASKERVEIN_TERRAIN.rows - 1);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute("position") as BufferAttribute;
    const colors = new Float32Array(positions.count * 3);
    for (let index = 0; index < positions.count; index++) {
      const elevation = ASKERVEIN_TERRAIN.elevationsM[index]!;
      positions.setY(index, elevation);
      const color = new Color(elevation < 8 ? "#446d63" : "#667b50").lerp(new Color("#9c9a72"), Math.max(0, (elevation - 20) / 110));
      color.toArray(colors, index * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3)); geometry.computeVertexNormals();
    return { geometry, material: new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }) };
  }, []);
  useEffect(() => () => { resources.geometry.dispose(); resources.material.dispose(); }, [resources]);
  const placed = useMemo(() => sceneTurbines(turbines), [turbines]);
  const involved = involvedIds ?? new Set<string>();
  return <group name="askervein-site">
    <ambientLight intensity={0.55} />
    <directionalLight position={[-700, 1200, 450]} intensity={2.2} color="#fff4d6" />
    <hemisphereLight args={["#b9d4d8", "#1d3026", 0.8]} />
    <mesh name="copernicus-terrain" geometry={resources.geometry} material={resources.material} receiveShadow />
    <WakePath path={emphasisPath} />
    <Turbines turbines={placed} selectedId={selectedId} involvedIds={involved} onSelect={onSelect} />
  </group>;
}
