import { useEffect, useState, type RefObject } from "react";

/**
 * The measured box of an element, in CSS pixels.
 *
 * Needed because the turbine overlay has to line up with a canvas whose size comes from CSS,
 * not from a prop. `ResizeObserver` is the correct instrument — the viewport changes size when
 * the mobile panel opens, when the window resizes, and when the browser chrome collapses on a
 * phone, and only one of those is a window resize event.
 *
 * Falls back to measuring on window resize where `ResizeObserver` is missing, which is jsdom
 * rather than any browser this app supports.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
