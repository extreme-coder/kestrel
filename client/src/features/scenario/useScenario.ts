import { useCallback, useEffect, useMemo, useState } from "react";
import type { FieldRequest, Scene, SceneCatalogue, SceneIssue } from "./scenario";
import { SceneRejected, fetchScene, fetchSceneCatalogue, importSceneFile, validateScene } from "./scenario";

export type ScenarioState =
  | { status: "loading" }
  | { status: "ready"; scene: Scene; request: FieldRequest; sceneId: string; sourceName: string }
  | { status: "error"; error: string; issues: SceneIssue[]; available?: string[] };

export interface Scenario {
  state: ScenarioState;
  catalogue: SceneCatalogue | null;
  /** Bearing the viewer is currently asking about, which is scene wind bearing plus scrubbing. */
  bearing: number;
  setBearing: (bearing: number) => void;
  /** The field request with the current bearing applied — what the picture and table are read off. */
  request: FieldRequest | null;
  loadBundled: (id: string) => void;
  importFile: (file: File) => void;
  /** Non-blocking notice, e.g. an import that failed while a good scene is still on screen. */
  notice: { message: string; issues: SceneIssue[] } | null;
  dismissNotice: () => void;
}

export const DEFAULT_SCENE_ID = "askervein-demonstration";

/**
 * Own the scene the viewer is showing.
 *
 * The bundled scene loads through exactly the same path as an imported one: fetched, then
 * used as the single source for terrain, layout and wind. Keeping a compiled-in fast path for
 * the default would mean the import path was only exercised when a user tried it.
 *
 * A failed import leaves the working scene on screen and reports the failure beside it. The
 * alternative — replacing a good scene with an error state — loses the user's context to
 * punish them for opening the wrong file.
 */
export function useScenario(initialSceneId = DEFAULT_SCENE_ID): Scenario {
  const [state, setState] = useState<ScenarioState>({ status: "loading" });
  const [catalogue, setCatalogue] = useState<SceneCatalogue | null>(null);
  const [bearing, setBearing] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ message: string; issues: SceneIssue[] } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchSceneCatalogue(controller.signal)
      .then(setCatalogue)
      .catch(() => {
        // The catalogue only drives the scene picker. Losing it must not stop the scene that
        // is already on screen from working.
      });
    return () => controller.abort();
  }, []);

  const adopt = useCallback((scene: Scene, request: FieldRequest, sceneId: string, sourceName: string) => {
    setState({ status: "ready", scene, request, sceneId, sourceName });
    setBearing(request.wind.bearing_deg);
    setNotice(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchScene(initialSceneId, controller.signal)
      .then((loaded) => adopt(loaded.scene, loaded.field_request, initialSceneId, "bundled"))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Could not load the scene",
          issues: [],
        });
      });
    return () => controller.abort();
  }, [initialSceneId, adopt]);

  const loadBundled = useCallback(
    (id: string) => {
      setState({ status: "loading" });
      fetchScene(id)
        .then((loaded) => adopt(loaded.scene, loaded.field_request, id, "bundled"))
        .catch((error: unknown) => {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : "Could not load the scene",
            issues: [],
          });
        });
    },
    [adopt],
  );

  const importFile = useCallback(
    (file: File) => {
      importSceneFile(file)
        .then((validation) => {
          const id = typeof validation.scene.id === "string" ? validation.scene.id : file.name;
          adopt(validation.scene, validation.field_request, id, file.name);
        })
        .catch((error: unknown) => {
          if (error instanceof SceneRejected) {
            setNotice({
              message: error.available?.length
                ? `${error.message} Available: ${error.available.join(", ")}.`
                : error.message,
              issues: error.issues,
            });
            return;
          }
          setNotice({
            message: error instanceof Error ? error.message : "Could not read that file",
            issues: [],
          });
        });
    },
    [adopt],
  );

  const request = useMemo<FieldRequest | null>(() => {
    if (state.status !== "ready") return null;
    if (bearing === null || bearing === state.request.wind.bearing_deg) return state.request;
    // A new immutable request per bearing, exactly as before: the volume and the numbers are
    // keyed on it, so they invalidate together and cannot describe different winds.
    return { ...state.request, wind: { ...state.request.wind, bearing_deg: bearing } };
  }, [state, bearing]);

  return {
    state,
    catalogue,
    bearing: bearing ?? 0,
    setBearing,
    request,
    loadBundled,
    importFile,
    notice,
    dismissNotice: () => setNotice(null),
  };
}

/** Re-exported so callers can validate a scene without importing the transport module. */
export { validateScene };
