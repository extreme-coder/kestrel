import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * A panel that floats over the scene and behaves itself.
 *
 * Three things, all of which were missing when each panel was a bare `<section>`:
 *
 *   - **Focus moves in on open.** Otherwise a keyboard user presses the button, the panel
 *     appears somewhere else on screen, and focus is still on the button — so the next Tab
 *     goes to whatever follows the button rather than into the thing they just opened.
 *   - **Escape closes it.** The close button is the last control in reading order, which is
 *     the wrong place to have to reach for to undo an accident.
 *   - **The container itself is the focus target**, not the first control inside it, so a
 *     screen reader starts at the panel's heading rather than halfway down it.
 *
 * Returning focus to the trigger is the caller's job: only the caller knows which button
 * opened this, and the trigger has to still exist when focus goes back to it.
 */
export function OverlayPanel({
  label,
  className,
  onClose,
  children,
}: {
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const container = useRef<HTMLElement>(null);

  useEffect(() => {
    container.current?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // Stopped here so the viewport's own Escape handler does not also clear the selection:
    // closing a panel and losing the turbine you were reading about are different intents.
    event.stopPropagation();
    event.preventDefault();
    onClose();
  };

  return (
    <section ref={container} className={className} aria-label={label} tabIndex={-1} onKeyDown={handleKeyDown}>
      {children}
    </section>
  );
}
