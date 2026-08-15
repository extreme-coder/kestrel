import { act, renderHook } from "@testing-library/react";
import { readMotionPreference, useComfortPreferences, writeMotionPreference } from "./preferences";

/** A controllable `prefers-reduced-motion` so the system half can be moved under the hook. */
function stubMediaQuery(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    set(matches: boolean) {
      query.matches = matches;
      act(() => listeners.forEach((listener) => listener()));
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("comfort preferences", () => {
  it("follows the operating system until the user chooses", () => {
    const media = stubMediaQuery(false);
    const { result } = renderHook(() => useComfortPreferences());

    expect(result.current.motion).toBe("system");
    expect(result.current.reducedMotion).toBe(false);

    // A vestibular user who turns reduced motion on mid-session expects the particles to
    // stop, not to have to reload.
    media.set(true);
    expect(result.current.reducedMotion).toBe(true);
  });

  it("keeps an explicit choice even when the system disagrees", () => {
    const media = stubMediaQuery(true);
    const { result } = renderHook(() => useComfortPreferences());
    expect(result.current.reducedMotion).toBe(true);

    act(() => result.current.setMotion("full"));
    expect(result.current.reducedMotion).toBe(false);

    media.set(false);
    media.set(true);
    expect(result.current.reducedMotion).toBe(false);
    expect(result.current.systemPrefersReduced).toBe(true);
  });

  it("survives a reload", () => {
    stubMediaQuery(false);
    const first = renderHook(() => useComfortPreferences());
    act(() => first.result.current.setMotion("reduce"));
    first.unmount();

    const second = renderHook(() => useComfortPreferences());
    expect(second.result.current.motion).toBe("reduce");
    expect(second.result.current.reducedMotion).toBe(true);
  });

  it("unsubscribes from the media query on unmount", () => {
    const media = stubMediaQuery(false);
    const { unmount } = renderHook(() => useComfortPreferences());
    expect(media.listenerCount).toBe(1);
    unmount();
    expect(media.listenerCount).toBe(0);
  });

  it("falls back to following the system when storage is unusable", () => {
    stubMediaQuery(false);
    window.localStorage.setItem("kestrel.comfort.v1", "not json");
    expect(readMotionPreference()).toBe("system");

    window.localStorage.setItem("kestrel.comfort.v1", JSON.stringify({ motion: "sideways" }));
    expect(readMotionPreference()).toBe("system");

    writeMotionPreference("reduce");
    expect(readMotionPreference()).toBe("reduce");
  });
});
