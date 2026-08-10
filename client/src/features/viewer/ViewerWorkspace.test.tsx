import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewerWorkspace } from "./ViewerWorkspace";

describe("ViewerWorkspace", () => {
  it("exposes the viewer landmarks and current field conditions", () => {
    render(<ViewerWorkspace />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /three-dimensional wind field/i })).toBeInTheDocument();
    expect(screen.getByText("Askervein Hill")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /wind bearing/i })).toHaveValue("210");
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

  it("rotates and zooms the scene with keyboard controls", () => {
    render(<ViewerWorkspace />);
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const world = screen.getByTestId("scene-world");

    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "+" });

    expect(world).toHaveStyle({ "--yaw": "2deg", "--zoom": "1.08" });
  });

  it("rotates on drag and zooms on wheel", () => {
    render(<ViewerWorkspace />);
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const world = screen.getByTestId("scene-world");
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
    fireEvent.wheel(viewport, { deltaY: -100 });

    expect(world).toHaveStyle({ "--yaw": "4deg", "--pitch": "-1px", "--zoom": "1.1" });
  });
});
