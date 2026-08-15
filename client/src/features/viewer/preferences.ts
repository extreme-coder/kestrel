import { useCallback, useEffect, useState } from "react";

/**
 * Comfort preferences, remembered across sessions.
 *
 * `docs/design/wireframes.md` fixes this: "a user who sets reduced motion in the browser must
 * not have it silently reset on entering XR. The settings are one store with two
 * presentations, the same pattern as selection." Step 13 adds the second presentation; this
 * module is the store, so XR inherits the preference rather than re-deriving it.
 *
 * Three states, not two. `system` is distinct from an explicit choice that happens to agree
 * with the system: a user who has never touched the control should keep following
 * `prefers-reduced-motion` if they change it in the OS, and a user who *has* chosen must not
 * have that overridden. Collapsing the two into a boolean loses which one is which.
 */
export type MotionPreference = "system" | "reduce" | "full";

export interface ComfortPreferences {
  /** Whether particle advection is frozen right now, whatever the reason. */
  reducedMotion: boolean;
  /** What the user chose, as opposed to what is in force. */
  motion: MotionPreference;
  setMotion: (motion: MotionPreference) => void;
  /** What the operating system is asking for, shown so `system` is not a mystery setting. */
  systemPrefersReduced: boolean;
}

const STORAGE_KEY = "kestrel.comfort.v1";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function isMotionPreference(value: unknown): value is MotionPreference {
  return value === "system" || value === "reduce" || value === "full";
}

/** Stored choice, or `system` when nothing is stored, storage is blocked, or the row is junk. */
export function readMotionPreference(): MotionPreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return "system";
    const parsed: unknown = JSON.parse(raw);
    const motion = (parsed as { motion?: unknown } | null)?.motion;
    return isMotionPreference(motion) ? motion : "system";
  } catch {
    // Private browsing throws on read, and a hand-edited row can be anything. Following the
    // system is the safe answer in both cases: it is what a first-time visitor gets.
    return "system";
  }
}

export function writeMotionPreference(motion: MotionPreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ motion }));
  } catch {
    /* the preference still applies for this session; it just will not survive a reload */
  }
}

function matchesReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/**
 * Resolve the preference in force, following the system live while the user has not chosen.
 *
 * The subscription matters: a vestibular user who turns reduced motion on mid-session, in the
 * OS, expects the particles to stop. Reading the query once at mount would leave them moving
 * until a reload.
 */
export function useComfortPreferences(): ComfortPreferences {
  const [motion, setMotionState] = useState<MotionPreference>(readMotionPreference);
  const [systemPrefersReduced, setSystemPrefersReduced] = useState(matchesReducedMotion);

  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return;
    const update = () => setSystemPrefersReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const setMotion = useCallback((next: MotionPreference) => {
    setMotionState(next);
    writeMotionPreference(next);
  }, []);

  return {
    reducedMotion: motion === "system" ? systemPrefersReduced : motion === "reduce",
    motion,
    setMotion,
    systemPrefersReduced,
  };
}
