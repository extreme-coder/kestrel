import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, InstancedMesh, Matrix4, MeshStandardMaterial, PlaneGeometry } from "three";
import { ASKERVEIN_LAYOUT, ASKERVEIN_TERRAIN } from "./askervein";

function groundAt(eastingM: number, northingM: number) {
  const x = Math.max(0, Math.min(ASKERVEIN_TERRAIN.columns - 1, eastingM / ASKERVEIN_TERRAIN.cellSizeM));
  const y = Math.max(0, Math.min(ASKERVEIN_TERRAIN.rows - 1, northingM / ASKERVEIN_TERRAIN.cellSizeM));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, ASKERVEIN_TERRAIN.columns - 1), y1 = Math.min(y0 + 1, ASKERVEIN_TERRAIN.rows - 1);
  const at = (column: number, row: number) => ASKERVEIN_TERRAIN.elevationsM[row * ASKERVEIN_TERRAIN.columns + column]!;
  const lower = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (x - x0);
  const upper = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (x - x0);
  return lower + (upper - lower) * (y - y0);
}

export function turbinePositions() {
  const travel = { east: -Math.sin(ASKERVEIN_LAYOUT.bearingDeg * Math.PI / 180), north: -Math.cos(ASKERVEIN_LAYOUT.bearingDeg * Math.PI / 180) };
  const cross = { east: -travel.north, north: travel.east };
  const downwindSpacing = ASKERVEIN_LAYOUT.downwindSpacingD * ASKERVEIN_LAYOUT.rotorDiameterM;
  const crosswindSpacing = ASKERVEIN_LAYOUT.crosswindSpacingD * ASKERVEIN_LAYOUT.rotorDiameterM;
  return Array.from({ length: ASKERVEIN_LAYOUT.rows * ASKERVEIN_LAYOUT.columns }, (_, index) => {
    const row = Math.floor(index / ASKERVEIN_LAYOUT.columns), column = index % ASKERVEIN_LAYOUT.columns;
    const downwind = (row - (ASKERVEIN_LAYOUT.rows - 1) / 2) * downwindSpacing;
    const crosswind = (column - (ASKERVEIN_LAYOUT.columns - 1) / 2) * crosswindSpacing;
    const eastingM = 1000 + downwind * travel.east + crosswind * cross.east;
    const northingM = 1000 + downwind * travel.north + crosswind * cross.north;
    return { eastingM, northingM, elevationM: groundAt(eastingM, northingM) };
  });
}

function Turbines() {
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
  const positions = useMemo(turbinePositions, []);
  useLayoutEffect(() => {
    const matrix = new Matrix4();
    positions.forEach((position, index) => {
      const x = position.eastingM - 1000, z = position.northingM - 1000;
      towers.current!.setMatrixAt(index, matrix.makeTranslation(x, position.elevationM + ASKERVEIN_LAYOUT.hubHeightM / 2, z));
      nacelles.current!.setMatrixAt(index, matrix.makeTranslation(x, position.elevationM + ASKERVEIN_LAYOUT.hubHeightM, z));
      rotors.current!.setMatrixAt(index, matrix.makeTranslation(x, position.elevationM + ASKERVEIN_LAYOUT.hubHeightM, z - 4));
    });
    [towers, nacelles, rotors].forEach((ref) => { if (ref.current) ref.current.instanceMatrix.needsUpdate = true; });
  }, [positions]);
  useEffect(() => () => {
    resources.towerGeometry.dispose(); resources.nacelleGeometry.dispose(); resources.rotorGeometry.dispose();
    resources.towerMaterial.dispose(); resources.rotorMaterial.dispose();
  }, [resources]);
  const count = positions.length;
  return <group name="instanced-turbines">
    <instancedMesh ref={towers} args={[resources.towerGeometry, resources.towerMaterial, count]} />
    <instancedMesh ref={nacelles} args={[resources.nacelleGeometry, resources.rotorMaterial, count]} />
    <instancedMesh ref={rotors} args={[resources.rotorGeometry, resources.rotorMaterial, count]} />
  </group>;
}

export function SiteScene() {
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
  return <group name="askervein-site">
    <ambientLight intensity={0.55} />
    <directionalLight position={[-700, 1200, 450]} intensity={2.2} color="#fff4d6" />
    <hemisphereLight args={["#b9d4d8", "#1d3026", 0.8]} />
    <mesh name="copernicus-terrain" geometry={resources.geometry} material={resources.material} receiveShadow />
    <Turbines />
  </group>;
}
