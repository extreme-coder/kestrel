import { Canvas, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import { SpatialField } from "./SpatialField";
import { useVelocityField } from "./useVelocityField";

const ASH_PREVIEW_REQUEST = {
  terrain: {
    site_id: "askervein-preview",
    origin_easting_m: 0,
    origin_northing_m: 0,
    columns: 5,
    rows: 5,
    cell_size_easting_m: 500,
    cell_size_northing_m: 500,
    elevations_m: Array.from({ length: 25 }, (_, index) => {
      const x = (index % 5) - 2;
      const y = Math.floor(index / 5) - 2;
      return Math.round(116 * Math.exp(-(x * x + y * y * 1.8) / 2));
    }),
  },
  layout: { turbine: "vestas-v112-3450", rows: 1, columns: 1, hub_height_m: 100, origin_easting_m: 1000, origin_northing_m: 1000 },
  wind: { bearing_deg: 210, speed_ms: 10, turbulence_intensity: 0.08 },
  volume: { levels: 8, top_elevation_m: 500 },
};

export type SpatialFieldView = { yaw: number; pitch: number; zoom: number };

export function cameraPosition({ yaw, pitch, zoom }: SpatialFieldView): [number, number, number] {
  const radius = 1_200 / zoom;
  const azimuth = yaw * Math.PI / 180;
  const elevation = (20 + pitch) * Math.PI / 180;
  const horizontal = Math.cos(elevation) * radius;
  return [Math.sin(azimuth) * horizontal, Math.sin(elevation) * radius, Math.cos(azimuth) * horizontal];
}

function CameraRig({ view }: { view: SpatialFieldView }) {
  const camera = useThree((state) => state.camera);
  useLayoutEffect(() => {
    camera.position.set(...cameraPosition(view));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, view.pitch, view.yaw, view.zoom]);
  return null;
}

export function SpatialFieldViewport({ reducedMotion = false, view }: { reducedMotion?: boolean; view: SpatialFieldView }) {
  const request = useMemo(() => ASH_PREVIEW_REQUEST, []);
  const result = useVelocityField(request);
  if (result.status === "loading") return <div className="field-state" role="status">Computing velocity field…</div>;
  if (result.status === "error") return <div className="field-state field-error" role="alert">{result.error}. Start the Kestrel server and retry.</div>;
  return (
    <Canvas
      className="spatial-field-canvas"
      camera={{ position: [0, 420, 1150], fov: 48, near: 1, far: 5000 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      dpr={[1, 1.5]}
      fallback={<div className="field-state field-error" role="alert">WebGL 2 is required to display this field.</div>}
    >
      <CameraRig view={view} />
      <color attach="background" args={["#08100f"]} />
      <gridHelper args={[2000, 20, "#315147", "#163029"]} rotation={[0, 0, 0]} />
      <SpatialField field={result.field} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
