import { useRef } from "react";
import { AlertTriangle, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Scenario } from "./useScenario";

/**
 * Choose the scene, or bring one.
 *
 * The bundled list and the file import produce the same thing by the same route, so the
 * import path is exercised every time the app starts rather than only when someone tries it.
 *
 * A rejected import is reported here, beside the control that caused it, with one line per
 * problem path. The working scene stays on screen: replacing it with an error state would
 * take away the user's context as a penalty for opening the wrong file.
 */
export function ScenarioPicker({ scenario }: { scenario: Scenario }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const { catalogue, state, notice } = scenario;
  const currentId = state.status === "ready" ? state.sceneId : null;
  const imported = state.status === "ready" && state.sourceName !== "bundled";

  return (
    <div>
      <div className="flex items-center justify-between">
        {/* The label, rather than a paragraph beside a screen-reader-only one that said
            something else. The select is not "bundled scene" once a file has been opened. */}
        <label className="eyebrow" htmlFor="scene-select">Scene</label>
        {imported ? (
          <span className="text-[10px] uppercase tracking-[0.14em] text-lime-300">Imported</span>
        ) : null}
      </div>

      <select
        id="scene-select"
        className="mt-3 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
        aria-describedby="scene-description"
        value={imported ? "" : currentId ?? ""}
        onChange={(event) => scenario.loadBundled(event.currentTarget.value)}
        disabled={!catalogue}
      >
        {imported ? <option value="">{state.sourceName}</option> : null}
        {(catalogue?.scenes ?? []).map((scene) => (
          <option key={scene.id} value={scene.id}>
            {scene.name} · {scene.turbine_count} turbines
          </option>
        ))}
      </select>

      <p id="scene-description" className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {state.status === "ready"
          ? catalogue?.scenes.find((scene) => scene.id === state.sceneId)?.description ??
            "Loaded from a file on this computer. Nothing was uploaded."
          : "Choose a bundled scene, or open a scene file from this computer."}
      </p>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) scenario.importFile(file);
          // Reset so the same file can be re-imported after being edited on disk.
          event.currentTarget.value = "";
          // The browser's file dialog takes focus and hands it back to a hidden input with
          // `tabIndex={-1}`, so the next Tab starts from the top of the document. Put it back
          // on the control that opened the dialog, which is also where the notice appears.
          openButton.current?.focus();
        }}
      />
      <Button
        ref={openButton}
        variant="outline"
        className="mt-3 w-full"
        onClick={() => fileInput.current?.click()}
      >
        <FileUp aria-hidden="true" className="size-3.5" /> Open scene file
      </Button>

      {notice ? (
        <div className="mt-3 rounded-lg border border-amber-300/30 bg-amber-300/5 p-3" role="alert">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-amber-100">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{notice.message}</span>
          </p>
          {notice.issues.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-amber-100/80">
              {notice.issues.slice(0, 6).map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <code className="text-amber-200">{issue.path || "(root)"}</code> — {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-[11px] text-amber-100/70">
            The scene on screen has not changed.{" "}
            <button type="button" className="rounded px-2 py-1.5 underline" onClick={scenario.dismissNotice}>
              Dismiss
            </button>
          </p>
        </div>
      ) : null}
    </div>
  );
}
