import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewerWorkspace } from "./ViewerWorkspace";
import type { ProvenanceRecord } from "@/features/provenance/provenance";

vi.mock("@/features/spatial-field/SpatialFieldViewport", () => ({
  SpatialFieldViewport: ({ view, bearingDeg, reducedMotion }: { view: { yaw: number; pitch: number; zoom: number }; bearingDeg: number; reducedMotion: boolean }) => (
    <div data-testid="spatial-field" data-yaw={view.yaw} data-pitch={view.pitch} data-zoom={view.zoom} data-bearing={bearingDeg} data-reduced-motion={reducedMotion} />
  ),
}));

const PROVENANCE: ProvenanceRecord = {
  model_version: "2026.08.1",
  validated_at: "2026-08-11",
  results: [
    {
      id: "terrain-base-flow",
      label: "Terrain flow",
      provenance: "computed",
      description: "Mass-consistent wind field over the terrain.",
      validation: "externally-anchored",
      anchor: {
        case: "Askervein Hill, run TU03-B",
        source: "Riso-R-1688(EN)",
        conditions: "210 degrees, near-neutral",
        metric: "Fractional speed-up at the hilltop mast",
        result: "Within 0.1% at 34 m above ground",
        limitations: ["The model does not reproduce lee-side deceleration."],
      },
    },
  ],
  scene: {
    site_id: "askervein-copernicus-glo30",
    site_name: "Askervein Hill, South Uist",
    terrain: { provenance: "measured", summary: "Copernicus DEM GLO-30." },
    layout: {
      provenance: "computed",
      status: "synthetic-demonstration",
      summary: "Four V112 turbines.",
      statement: "No wind farm exists at Askervein.",
    },
    validates: "The campaign validates terrain response, not the turbines.",
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROVENANCE), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    const panel = screen.getByRole("region", { name: "About this site" });
    expect(screen.getByText("Why Askervein Hill?")).toBeInTheDocument();
    expect(panel).toHaveTextContent("What the campaign checks");
    expect(panel).toHaveTextContent(/measured/i);
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
    const panel = screen.getByRole("region", { name: "Turbine information" });
    expect(panel).toHaveTextContent("Four V112 turbines");
    // Real terrain plus rendered turbines reads as a real wind farm. The panel has to deny it.
    expect(panel).toHaveTextContent(/no wind farm exists at askervein/i);
    expect(panel).toHaveTextContent(/demonstration layout/i);

    expect(screen.getByText("60 FPS target · 16.7 ms budget")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide performance" }));
    expect(screen.queryByText("60 FPS target · 16.7 ms budget")).not.toBeInTheDocument();
  });

  it("discloses what the model was checked against and where it fails", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);

    await user.click(screen.getByRole("button", { name: "Show model accuracy and limits" }));
    const disclosure = await screen.findByRole("region", { name: "Model accuracy and limits" });

    await waitFor(() => expect(disclosure).toHaveTextContent("Askervein Hill, run TU03-B"));
    // Source, conditions, metric, result and limitations all have to reach the user, not
    // only the report: an accuracy figure without its caveat is what this panel prevents.
    expect(disclosure).toHaveTextContent("Riso-R-1688(EN)");
    expect(disclosure).toHaveTextContent("210 degrees, near-neutral");
    expect(disclosure).toHaveTextContent("Fractional speed-up at the hilltop mast");
    expect(disclosure).toHaveTextContent("Within 0.1% at 34 m above ground");
    expect(disclosure).toHaveTextContent("does not reproduce lee-side deceleration");
    expect(disclosure).toHaveTextContent("No wind farm exists at Askervein.");
    expect(disclosure).toHaveTextContent("Computed");
  });

  it("says so when the validation record cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const user = userEvent.setup();
    render(<ViewerWorkspace />);

    await user.click(screen.getByRole("button", { name: "Show model accuracy and limits" }));
    const disclosure = screen.getByRole("region", { name: "Model accuracy and limits" });

    await waitFor(() => expect(disclosure).toHaveTextContent(/did not load/i));
    expect(disclosure).toHaveTextContent(/still model output, not measurement/i);
  });

  it("routes from the site panel to the accuracy record", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);

    await user.click(screen.getByRole("button", { name: "About this site" }));
    await user.click(screen.getByRole("button", { name: "View accuracy and limits" }));

    expect(screen.getByRole("region", { name: "Model accuracy and limits" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "About this site" })).not.toBeInTheDocument();
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
