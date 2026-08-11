import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewerWorkspace } from "./ViewerWorkspace";

vi.mock("@/features/spatial-field/SpatialFieldViewport", () => ({
  SpatialFieldViewport: ({ view, bearingDeg, reducedMotion }: { view: { yaw: number; pitch: number; zoom: number }; bearingDeg: number; reducedMotion: boolean }) => (
    <div data-testid="spatial-field" data-yaw={view.yaw} data-pitch={view.pitch} data-zoom={view.zoom} data-bearing={bearingDeg} data-reduced-motion={reducedMotion} />
  ),
}));

describe("ViewerWorkspace", () => {
  it("exposes the viewer landmarks and current field conditions", () => {
    render(<ViewerWorkspace />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /three-dimensional wind field/i })).toBeInTheDocument();
    expect(screen.getByText("Askervein Hill")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /wind bearing/i })).toHaveValue("210");
    expect(screen.getByTestId("spatial-field")).toBeInTheDocument();
  });

  it("toggles the mobile control panel", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);
    const toggle = screen.getByRole("button", { name: /field controls/i });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Close controls");
  });

  it("opens the site explanation", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);

    await user.click(screen.getByRole("button", { name: "About this site" }));

    expect(screen.getByRole("region", { name: "About this site" })).toBeInTheDocument();
    expect(screen.getByText("Why Askervein Hill?")).toBeInTheDocument();
    expect(screen.getByText("Why one site?")).toBeInTheDocument();
  });

  it("sends bearing and comfort changes to the field", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);
    const field = screen.getByTestId("spatial-field");

    fireEvent.change(screen.getByRole("slider", { name: /wind bearing/i }), { target: { value: "225" } });
    expect(screen.getByText("225°")).toBeInTheDocument();
    expect(field).toHaveAttribute("data-bearing", "225");

    await user.click(screen.getByRole("button", { name: "Open viewer settings" }));
    await user.click(screen.getByRole("checkbox", { name: "Reduce particle motion" }));
    expect(field).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.getByRole("button", { name: "Resume particles" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows turbine details and toggles the performance overlay", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);

    await user.click(screen.getByRole("button", { name: "Show turbine information" }));
    expect(screen.getByRole("region", { name: "Turbine information" })).toHaveTextContent("Four V112 turbines");

    expect(screen.getByText("60 FPS target · 16.7 ms budget")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide performance" }));
    expect(screen.queryByText("60 FPS target · 16.7 ms budget")).not.toBeInTheDocument();
  });

  it("rotates and zooms the scene with keyboard controls", () => {
    render(<ViewerWorkspace />);
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const field = screen.getByTestId("spatial-field");

    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "+" });

    expect(field).toHaveAttribute("data-yaw", "2");
    expect(field).toHaveAttribute("data-zoom", "1.08");
  });

  it("rotates on drag and zooms on wheel", () => {
    render(<ViewerWorkspace />);
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const field = screen.getByTestId("spatial-field");
    Object.defineProperty(viewport, "setPointerCapture", { value: () => undefined });

    const pointerEvent = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        clientX: { value: x },
        clientY: { value: y },
      });
      fireEvent(viewport, event);
    };

    pointerEvent("pointerdown", 100, 100);
    pointerEvent("pointermove", 150, 120);
    pointerEvent("pointerup", 150, 120);
    // R3F owns the nested canvas in production, so exercise the capture path from a
    // descendant rather than dispatching directly on the viewport.
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    fireEvent(field, wheel);

    expect(field).toHaveAttribute("data-yaw", "4");
    expect(field).toHaveAttribute("data-pitch", "-1");
    expect(field).toHaveAttribute("data-zoom", "1.1");
    expect(wheel.defaultPrevented).toBe(true);
  });
});
