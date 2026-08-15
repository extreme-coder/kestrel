import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewerWorkspace } from "./ViewerWorkspace";
import { ANALYSIS_FIXTURE } from "@/features/analysis/analysis.fixture";
import type { ProvenanceRecord } from "@/features/provenance/provenance";

vi.mock("@/features/spatial-field/SpatialFieldViewport", () => ({
  SpatialFieldViewport: ({ view, request, reducedMotion, selectedId, onSelect }: { view: { yaw: number; pitch: number; zoom: number }; request: { wind: { bearing_deg: number } }; reducedMotion: boolean; selectedId: string | null; onSelect: (id: string) => void }) => (
    <div
      data-testid="spatial-field"
      data-yaw={view.yaw}
      data-pitch={view.pitch}
      data-zoom={view.zoom}
      data-bearing={request.wind.bearing_deg}
      data-reduced-motion={reducedMotion}
      data-selected={selectedId ?? ""}
    >
      {/* Stands in for a turbine in the scene: selection is one piece of state, and the
          scene is one of its two presentations. */}
      <button type="button" onClick={() => onSelect("t-r2c2")}>scene turbine t-r2c2</button>
    </div>
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

/**
 * The scene the workspace loads on mount.
 *
 * Small on purpose — a 3 x 3 grid rather than Askervein's 33 x 33 — because these tests are
 * about the workspace wiring, not the DEM. The shape is what matters: since step 11 the
 * viewer has no compiled-in farm, and everything it draws comes from here.
 */
const SCENE = {
  kestrel_scene: 1,
  id: "askervein-demonstration",
  name: "Askervein Hill — demonstration array",
  terrain: { site_id: "askervein-copernicus-glo30" },
  layout: { turbine: "vestas-v112-3450", rows: 2, columns: 2, orientation_bearing_deg: 210 },
  wind: { bearing_deg: 210, speed_ms: 10, turbulence_intensity: 0.08 },
  volume: { levels: 8, top_elevation_m: 500 },
};

const FIELD_REQUEST = {
  terrain: {
    site_id: "askervein-copernicus-glo30",
    columns: 3,
    rows: 3,
    cell_size_easting_m: 500,
    cell_size_northing_m: 500,
    elevations_m: [0, 10, 0, 10, 60, 10, 0, 10, 0],
  },
  layout: { turbine: "vestas-v112-3450", rows: 2, columns: 2, orientation_bearing_deg: 210 },
  wind: { bearing_deg: 210, speed_ms: 10, turbulence_intensity: 0.08 },
  volume: { levels: 8, top_elevation_m: 500 },
};

const CATALOGUE = {
  scene_format_version: 1,
  scenes: [
    {
      id: "askervein-demonstration",
      name: "Askervein Hill — demonstration array",
      description: "Four V112 turbines.",
      site_id: "askervein-copernicus-glo30",
      turbine: "vestas-v112-3450",
      turbine_count: 4,
      bearing_deg: 210,
      has_wind_rose: true,
    },
  ],
  sites: [],
};

const ANNUAL = {
  scene: { id: "askervein-demonstration", name: "Askervein" },
  turbines: [],
  farm: {
    weighted_net_power_kw: 9000,
    weighted_wake_loss_fraction: 0.038,
    worst_turbine_id: "t-r2c1",
    worst_sector_bearing_deg: 300,
    worst_sector_speed_ms: 10.5,
    worst_sector_wake_loss_kw: 3607,
    worst_sector_wake_loss_fraction: 0.269,
    worst_sector_frequency: 0.0056,
  },
  sectors: [{ sector_bearing_deg: 210, sector_weight: 0.14, wake_loss_fraction: 0.086, conditions: 32 }],
  sectors_evaluated: 12,
  conditions_evaluated: 327,
  frequency_covered: 1,
  provenance: { wake_loss_framing: "Modelled wake losses are a floor, not an upper limit." },
};

/** Route by endpoint. The workspace loads a scene, a provenance record, and an analysis. */
function stubEndpoints(
  overrides: {
    analysis?: () => Response;
    provenance?: () => Response;
    scene?: () => Response;
    annual?: () => Response;
    comparison?: () => Response;
  } = {},
) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/analysis")) {
      return overrides.analysis?.() ?? new Response(JSON.stringify(ANALYSIS_FIXTURE), { status: 200 });
    }
    if (url.includes("/api/annual")) {
      return overrides.annual?.() ?? new Response(JSON.stringify(ANNUAL), { status: 200 });
    }
    if (url.includes("/api/comparison")) {
      return overrides.comparison?.() ?? new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes("/api/scenes/")) {
      return (
        overrides.scene?.() ??
        new Response(JSON.stringify({ scene: SCENE, field_request: FIELD_REQUEST }), { status: 200 })
      );
    }
    if (url.includes("/api/scenes")) {
      return new Response(JSON.stringify(CATALOGUE), { status: 200 });
    }
    return overrides.provenance?.() ?? new Response(JSON.stringify(PROVENANCE), { status: 200 });
  }));
}

/** The scene arrives over HTTP, so nothing in the viewport exists until it resolves. */
async function renderReady() {
  const result = render(<ViewerWorkspace />);
  await screen.findByTestId("spatial-field");
  return result;
}

beforeEach(() => {
  window.localStorage.clear();
  stubEndpoints();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ViewerWorkspace", () => {
  it("exposes the viewer landmarks and current field conditions", async () => {
    await renderReady();
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
    await renderReady();
    const field = screen.getByTestId("spatial-field");

    fireEvent.change(screen.getByRole("slider", { name: /wind bearing/i }), { target: { value: "225" } });
    expect(screen.getByText("225°")).toBeInTheDocument();
    expect(field).toHaveAttribute("data-bearing", "225");

    await user.click(screen.getByRole("button", { name: "Open viewer settings" }));
    await user.click(screen.getByRole("radio", { name: /freeze the particles/i }));
    expect(field).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.getByRole("button", { name: "Resume particles" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Viewer settings" })).toHaveTextContent(/still snapshot/i);
  });

  it("remembers the comfort choice for the next session", async () => {
    const user = userEvent.setup();
    const { unmount } = await renderReady();

    await user.click(screen.getByRole("button", { name: "Open viewer settings" }));
    await user.click(screen.getByRole("radio", { name: /freeze the particles/i }));
    unmount();

    await renderReady();
    expect(screen.getByTestId("spatial-field")).toHaveAttribute("data-reduced-motion", "true");
    expect(screen.getByRole("button", { name: "Resume particles" })).toBeInTheDocument();
  });

  it("shows turbine details and toggles the performance overlay", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);

    await user.click(screen.getByRole("button", { name: "Show turbine information" }));
    const panel = screen.getByRole("region", { name: "Turbine information" });
    expect(panel).toHaveTextContent("4 V112-3450 turbines");
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

  it("states the task on first load and does not repeat it once acknowledged", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ViewerWorkspace />);

    const card = await screen.findByRole("dialog", { name: /find the turbine losing the most energy/i });
    expect(card).toHaveTextContent(/4 turbines, wind from 210°/);
    expect(card).toHaveTextContent(/change the bearing to check whether the answer holds/i);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    render(<ViewerWorkspace />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ranks turbines by wake loss and says the losses are a floor", async () => {
    render(<ViewerWorkspace />);
    const ranking = await screen.findByRole("region", { name: "Wake loss by turbine" });

    const rows = within(ranking).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("t-r2c1");
    expect(rows[0]).toHaveTextContent("45.6%");
    expect(rows[0]).toHaveTextContent("1,829 kW net");
    expect(rows[3]).toHaveTextContent("t-r1c2");
    expect(ranking).toHaveTextContent("25.4%");
    // D24: the model recovers about 83% of Horns Rev's measured array loss.
    expect(ranking).toHaveTextContent(/floor, not an upper limit/i);
  });

  it("attributes a selected turbine's loss to an upstream cause", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);
    const ranking = await screen.findByRole("region", { name: "Wake loss by turbine" });

    await user.click(within(ranking).getAllByRole("button")[0]!);
    const detail = screen.getByRole("region", { name: "Analysis for turbine t-r2c1" });

    // Rounded to one decimal: the wake model misses Horns Rev's farm efficiency by 4.5
    // points, so a second decimal would assert a resolution it has never been shown to have.
    expect(detail).toHaveTextContent("8.8 m/s");
    expect(detail).toHaveTextContent(/The model attributes 100% of t-r2c1's 1533 kW loss to t-r1c1/);
    expect(within(detail).getByLabelText("Upstream contributors")).toHaveTextContent("8.0 D upwind");
    // The section carries the height relation in words as well as in the drawing.
    expect(detail).toHaveTextContent(/wake centreline sits at/i);
    expect(detail).toHaveTextContent(/rotor spans/i);

    await user.click(within(detail).getByRole("button", { name: /all turbines/i }));
    expect(screen.getByRole("region", { name: "Wake loss by turbine" })).toBeInTheDocument();
  });

  it("shares one selection between the list and the scene", async () => {
    const user = userEvent.setup();
    await renderReady();
    await screen.findByRole("region", { name: "Wake loss by turbine" });

    await user.click(screen.getByRole("button", { name: /scene turbine t-r2c2/i }));
    expect(screen.getByRole("region", { name: "Analysis for turbine t-r2c2" })).toBeInTheDocument();
    expect(screen.getByTestId("spatial-field")).toHaveAttribute("data-selected", "t-r2c2");

    const detail = screen.getByRole("region", { name: "Analysis for turbine t-r2c2" });
    await user.click(within(detail).getByRole("button", { name: /t-r1c2/ }));
    expect(screen.getByRole("region", { name: "Analysis for turbine t-r1c2" })).toBeInTheDocument();
  });

  it("labels every reported figure with where it came from", async () => {
    const user = userEvent.setup();
    render(<ViewerWorkspace />);
    const ranking = await screen.findByRole("region", { name: "Wake loss by turbine" });
    expect(within(ranking).getAllByTitle(/backed by: wake-deficit/i).length).toBeGreaterThan(0);

    await user.click(within(ranking).getAllByRole("button")[0]!);
    const detail = screen.getByRole("region", { name: "Analysis for turbine t-r2c1" });
    expect(within(detail).getByTitle(/backed by: hub-wind-speed/i)).toBeInTheDocument();
    expect(within(detail).getByTitle(/backed by: wake-attribution/i)).toBeInTheDocument();
  });

  it("says so when the turbine figures cannot be computed", async () => {
    // Keeping the previous bearing's numbers on screen beside a newly drawn field would be
    // worse than showing none.
    stubEndpoints({ analysis: () => new Response("no", { status: 500 }) });
    await renderReady();
    // Scoped to the analysis panel: the comparison and annual panels have their own alerts,
    // and this test is about the ranked list refusing to show stale figures.
    const alert = await within(screen.getByRole("complementary", { name: /wind field controls/i }))
      .findByText(/figures are unavailable for this bearing/i);
    expect(alert).toHaveTextContent(/Analysis request failed \(500\)/);
  });

  it("says the layout does not turn with the wind", async () => {
    render(<ViewerWorkspace />);
    await screen.findByRole("region", { name: "Wake loss by turbine" });
    expect(screen.getByText(/layout stays fixed at 210°/i)).toBeInTheDocument();
  });

  it("rotates and zooms the scene with keyboard controls", async () => {
    await renderReady();
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const field = screen.getByTestId("spatial-field");

    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "+" });

    expect(field).toHaveAttribute("data-yaw", "2");
    expect(field).toHaveAttribute("data-zoom", "1.08");
  });

  /**
   * The gap step 12 opened with: selection in the scene was pointer-only, because three.js
   * paints pixels and produces no accessibility tree. These four cover the layer that fixes
   * it — that the machines are focusable, that they say which machine they are, that they set
   * the same selection the list does, and that the picture itself has a description.
   */
  it("makes every turbine in the scene a focus stop, worst loss first", async () => {
    await renderReady();
    const targets = within(await screen.findByRole("list", { name: "Turbines in the scene" })).getAllByRole("button");

    expect(targets).toHaveLength(4);
    expect(targets[0]).toHaveAccessibleName(/t-r2c1, number 1 of 4 by wake loss/i);
    expect(targets[0]).toHaveAccessibleName(/45\.6% lost, 8\.8 m\/s at the rotor/i);
    expect(targets[3]).toHaveAccessibleName(/number 4 of 4/i);
  });

  it("selects from the scene by keyboard, and marks what is selected", async () => {
    const user = userEvent.setup();
    await renderReady();
    const targets = within(await screen.findByRole("list", { name: "Turbines in the scene" })).getAllByRole("button");

    targets[0]!.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("region", { name: "Analysis for turbine t-r2c1" })).toBeInTheDocument();
    expect(screen.getByTestId("spatial-field")).toHaveAttribute("data-selected", "t-r2c1");
    expect(targets[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("describes what the viewport shows, and re-describes it when the selection changes", async () => {
    const user = userEvent.setup();
    await renderReady();
    await screen.findByRole("region", { name: "Wake loss by turbine" });
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const summary = document.getElementById("scene-summary")!;

    expect(viewport).toHaveAttribute("aria-describedby", "scene-summary");
    expect(summary).toHaveTextContent(/4 V112-3450 turbines on measured terrain/i);
    expect(summary).toHaveTextContent(/wind from 210 degrees, south-west/i);
    expect(summary).toHaveTextContent(/brighter and more densely/i);
    expect(summary).toHaveTextContent(/ranks t-r2c1 worst/i);

    await user.click(screen.getByRole("button", { name: /scene turbine t-r2c2/i }));
    expect(summary).toHaveTextContent(/t-r2c2 is selected/i);
    expect(summary).toHaveTextContent(/tube follows the modelled wake from t-r1c2/i);
    expect(summary).toHaveTextContent(/nothing is hidden/i);
  });

  it("states the field is a still snapshot when motion is reduced", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByRole("button", { name: "Pause particles" }));
    expect(document.getElementById("scene-summary")).toHaveTextContent(/particle motion is paused/i);
  });

  /**
   * Opening a panel used to leave focus on the button that opened it, so the next Tab went
   * past the panel rather than into it, and closing left focus on the document body.
   */
  it("moves focus into a panel and hands it back on Escape", async () => {
    const user = userEvent.setup();
    await renderReady();
    const trigger = screen.getByRole("button", { name: "About this site" });

    await user.click(trigger);
    const panel = screen.getByRole("region", { name: "About this site" });
    expect(panel).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "About this site" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows one floating panel at a time", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByRole("button", { name: "About this site" }));
    await user.click(screen.getByRole("button", { name: "Show turbine information" }));

    expect(screen.getByRole("region", { name: "Turbine information" })).toBeInTheDocument();
    // They occupy the same corner. Two open at once put one silently under the other.
    expect(screen.queryByRole("region", { name: "About this site" })).not.toBeInTheDocument();
  });

  it("publishes the keyboard controls and the scene description together", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.click(screen.getByRole("button", { name: "View description and keyboard controls" }));
    const panel = screen.getByRole("region", { name: "View description and keyboard controls" });

    expect(panel).toHaveTextContent(/Rotate the view/i);
    expect(panel).toHaveTextContent(/Reset the view to where it started/i);
    expect(panel).toHaveTextContent(/clear the selected turbine/i);
    // The description is shown, not only spoken: prose nobody can see is prose nobody
    // notices has gone stale.
    expect(panel).toHaveTextContent(/4 V112-3450 turbines on measured terrain/i);
    expect(panel).toHaveTextContent(/needs a pointer or a headset/i);
  });

  it("resets the view from the keyboard", async () => {
    await renderReady();
    const viewport = screen.getByRole("region", { name: /three-dimensional wind field/i });
    const field = screen.getByTestId("spatial-field");

    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "+" });
    expect(field).toHaveAttribute("data-yaw", "2");

    fireEvent.keyDown(viewport, { key: "0" });
    expect(field).toHaveAttribute("data-yaw", "0");
    expect(field).toHaveAttribute("data-zoom", "1");
  });

  it("does not offer an immersive view it cannot enter", async () => {
    await renderReady();
    const immersive = screen.getByRole("button", { name: /enter immersive view/i });
    // An enabled control that does nothing is worse than an honest disabled one: a keyboard
    // user gets no feedback at all and cannot tell the difference from a broken app.
    expect(immersive).toBeDisabled();
    expect(screen.getByText(/every part of the analysis works here without a headset/i)).toBeInTheDocument();
  });

  it("rotates on drag and zooms on wheel", async () => {
    await renderReady();
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
