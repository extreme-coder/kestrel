import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "kestrel.primary-task.seen";

/** Whether the task statement has already been acknowledged on this device. */
export function hasSeenPrimaryTask(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private browsing and blocked storage both throw. Showing the statement again is the
    // harmless failure; suppressing it because storage is unavailable is not.
    return false;
  }
}

export function rememberPrimaryTask(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* nothing to do: the card simply reappears next session */
  }
}

/**
 * The task, stated on first load.
 *
 * Copy is fixed in `docs/design/primary-task.md` and written to the project copy rules: name
 * the task, do not sell it, do not narrate the controls. The heading is the task itself
 * rather than a welcome, the supporting line carries the two conditions the user cannot yet
 * see, and Skip is visible because a returning user should not have to sit through an
 * introduction.
 *
 * No accuracy claim appears here. Provenance belongs beside the numbers it qualifies, where
 * it can be checked — not in an introduction where it cannot.
 */
export function PrimaryTaskCard({
  turbineCount,
  bearingDeg,
  onDismiss,
}: {
  turbineCount: number;
  bearingDeg: number;
  onDismiss: () => void;
}) {
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    start.current?.focus();
  }, []);

  const dismiss = () => {
    rememberPrimaryTask();
    onDismiss();
  };

  return (
    <div
      className="primary-task"
      role="dialog"
      aria-modal="false"
      aria-labelledby="primary-task-heading"
      onKeyDown={(event) => {
        if (event.key === "Escape") dismiss();
      }}
    >
      <h2 id="primary-task-heading" className="font-display text-2xl leading-tight tracking-tight">
        Find the turbine losing the most energy to wakes
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-white/70">
        {turbineCount} turbines, wind from {Math.round(bearingDeg)}°. Select a turbine to see its wake loss
        and what is causing it. Then change the bearing to check whether the answer holds.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button ref={start} onClick={dismiss}>Start</Button>
        <Button variant="ghost" onClick={dismiss}>Skip</Button>
      </div>
    </div>
  );
}
