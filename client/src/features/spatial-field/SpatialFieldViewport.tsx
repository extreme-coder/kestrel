import { Canvas, useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
import { SpatialField } from "./SpatialField";
import { useVelocityField } from "./useVelocityField";
import { SCENE_CAMERA, cameraPosition } from "./project";
import type { SpatialFieldView } from "./project";
import type { AnalysisState } from "@/features/analysis/useAnalysis";
import { emphasisPath, involvedTurbineIds } from "@/features/analysis/analysis";
import { SiteScene } from "@/features/site/SiteScene";
import type { SceneTerrain } from "@/features/site/SiteScene";

export { cameraPosition };
export type { SpatialFieldView };

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
  terrain,
}: {
  request: unknown;
  analysis: AnalysisState;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  reducedMotion?: boolean;
  view: SpatialFieldView;
  terrain?: SceneTerrain;
}) {
  const result = useVelocityField(request);
  if (result.status === "loading") return <div className="field-state" role="status">Computing velocity field…</div>;
  if (result.status === "error") return <div className="field-state field-error" role="alert">{result.error}. Start the Kestrel server and retry.</div>;
  const record = analysis.status === "ready" ? analysis.record : null;
  return (
    <Canvas
      className="spatial-field-canvas"
      camera={{ position: cameraPosition(view), ...SCENE_CAMERA }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      dpr={[1, 1.5]}
      // No `role="alert"` here. R3F renders this as children of the `<canvas>` element —
      // HTML's own fallback-content slot — which browsers expose to assistive technology even
      // when the canvas is drawing perfectly well. As an alert it announced "WebGL 2 is
      // required" on every successful load, which is both false and assertive. Plain text is
      // still read by anyone whose browser genuinely cannot render the canvas.
      fallback={<p className="field-state field-error">WebGL 2 is required to display this field.</p>}
    >
      <CameraRig view={view} />
      <color attach="background" args={["#08100f"]} />
      <SiteScene
        turbines={record?.turbines ?? []}
        selectedId={selectedId}
        involvedIds={record ? involvedTurbineIds(record, selectedId) : undefined}
        emphasisPath={record ? emphasisPath(record, selectedId) : []}
        onSelect={onSelect}
        {...(terrain ? { terrain } : {})}
        {...(record ? { rotorDiameterM: record.layout.rotor_diameter_m } : {})}
      />
      <SpatialField field={result.field} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
