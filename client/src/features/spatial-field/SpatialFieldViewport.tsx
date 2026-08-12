import { Canvas, useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
import { SpatialField } from "./SpatialField";
import { useVelocityField } from "./useVelocityField";
import type { AnalysisState } from "@/features/analysis/useAnalysis";
import { emphasisPath, involvedTurbineIds } from "@/features/analysis/analysis";
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

/**
 * The scene: terrain, turbines, and the advected velocity volume.
 *
 * The field request is passed in rather than built here because the same request produces
 * the numbers in the panel. One request object per scene is what stops the picture and the
 * table from describing different farms.
 */
export function SpatialFieldViewport({
  request,
  analysis,
  selectedId = null,
  onSelect = () => {},
  reducedMotion = false,
  view,
}: {
  request: unknown;
  analysis: AnalysisState;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  reducedMotion?: boolean;
  view: SpatialFieldView;
}) {
  const result = useVelocityField(request);
  if (result.status === "loading") return <div className="field-state" role="status">Computing velocity field…</div>;
  if (result.status === "error") return <div className="field-state field-error" role="alert">{result.error}. Start the Kestrel server and retry.</div>;
  const record = analysis.status === "ready" ? analysis.record : null;
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
      <SiteScene
        turbines={record?.turbines ?? []}
        selectedId={selectedId}
        involvedIds={record ? involvedTurbineIds(record, selectedId) : undefined}
        emphasisPath={record ? emphasisPath(record, selectedId) : []}
        onSelect={onSelect}
      />
      <SpatialField field={result.field} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
