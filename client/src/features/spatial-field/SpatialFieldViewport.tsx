import { Canvas, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import { SpatialField } from "./SpatialField";
import { useVelocityField } from "./useVelocityField";
import { ASKERVEIN_FIELD_REQUEST } from "@/features/site/askervein";
import { SiteScene } from "@/features/site/SiteScene";

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

export function SpatialFieldViewport({
  bearingDeg = ASKERVEIN_FIELD_REQUEST.wind.bearing_deg,
  reducedMotion = false,
  view,
}: {
  bearingDeg?: number;
  reducedMotion?: boolean;
  view: SpatialFieldView;
}) {
  const request = useMemo(() => ({
    ...ASKERVEIN_FIELD_REQUEST,
    wind: { ...ASKERVEIN_FIELD_REQUEST.wind, bearing_deg: bearingDeg },
  }), [bearingDeg]);
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
      <SiteScene />
      <SpatialField field={result.field} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
