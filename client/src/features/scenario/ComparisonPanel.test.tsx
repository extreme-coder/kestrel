import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComparisonPanel } from "./ComparisonPanel";
import type { ComparisonRecord, FieldRequest } from "./scenario";

const REQUEST = {
  terrain: {
    site_id: "askervein",
    columns: 3,
    rows: 3,
    cell_size_easting_m: 500,
    cell_size_northing_m: 500,
    elevations_m: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  layout: {},
  wind: { bearing_deg: 210, speed_ms: 10 },
  volume: {},
} satisfies FieldRequest;

const CANDIDATE: FieldRequest = { ...REQUEST, wind: { ...REQUEST.wind, bearing_deg: 215 } };

function record(overrides: Partial<ComparisonRecord["farm"]> = {}): ComparisonRecord {
  return {
    baseline: { bearing_deg: 210, speed_ms: 10, turbine_name: "V112", turbine_count: 4, orientation_bearing_deg: 210 },
    candidate: { bearing_deg: 215, speed_ms: 10, turbine_name: "V112", turbine_count: 4, orientation_bearing_deg: 210 },
    turbines: [
      {
        turbine_id: "t-r2c2",
        baseline_net_power_kw: 1902,
        candidate_net_power_kw: 2095,
        delta_net_power_kw: 193,
        baseline_wake_loss_fraction: 0.4334,
        candidate_wake_loss_fraction: 0.3928,
        delta_wake_loss_fraction: -0.0406,
        baseline_incoming_speed_ms: 8.88,
        candidate_incoming_speed_ms: 9.1,
        delta_incoming_speed_ms: 0.22,
        baseline_dominant_contributor_id: "t-r1c2",
        candidate_dominant_contributor_id: "t-r1c2",
        dominant_contributor_changed: false,
      },
    ],
    farm: {
      baseline_total_net_power_kw: 8776,
      candidate_total_net_power_kw: 9929,
      delta_total_net_power_kw: 1153,
      baseline_farm_wake_loss_fraction: 0.254,
      candidate_farm_wake_loss_fraction: 0.1623,
      delta_farm_wake_loss_fraction: -0.0917,
      baseline_worst_turbine_id: "t-r2c1",
      candidate_worst_turbine_id: "t-r2c2",
      worst_turbine_changed: true,
      largest_mover_id: "t-r2c1",
      ...overrides,
    },
    only_in_baseline: [],
    only_in_candidate: [],
    provenance: { wake_loss_framing: "Modelled wake losses are a floor, not an upper limit." },
  };
}

function stub(payload: ComparisonRecord) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ComparisonPanel", () => {
  it("does nothing until a baseline is pinned", () => {
    stub(record());
    render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /pin as baseline/i })).toBeInTheDocument();
    expect(screen.getByText(/pin the scene on screen/i)).toBeInTheDocument();
  });

  it("says the candidate is the baseline until something changes", async () => {
    stub(record());
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    expect(await screen.findByText(/the candidate is the baseline/i)).toBeInTheDocument();
  });

  it("answers T3 in a sentence when the worst turbine changes", async () => {
    stub(record());
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={CANDIDATE} selectedId={null} onSelect={() => {}} />);

    const section = screen.getByRole("region", { name: "Scenario comparison" });
    expect(await within(section).findByText(/the worst turbine/i)).toBeInTheDocument();
    expect(section).toHaveTextContent(/changes/);
    expect(section).toHaveTextContent("t-r2c1");
    expect(section).toHaveTextContent("t-r2c2");
  });

  it("says so just as plainly when nothing moved", async () => {
    // "The answer does not change" is a real T3 finding. Reported quietly, a stable ranking
    // reads as a broken comparison.
    stub(record({ worst_turbine_changed: false, candidate_worst_turbine_id: "t-r2c1" }));
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={CANDIDATE} selectedId={null} onSelect={() => {}} />);

    const section = screen.getByRole("region", { name: "Scenario comparison" });
    expect(await within(section).findByText(/ranking holds across this change/i)).toBeInTheDocument();
  });

  it("labels the direction of each change rather than relying on colour", async () => {
    // Net power and wake loss have opposite senses: more power is better, more loss is worse.
    // No naming convention fixes that, so the words have to.
    stub(record());
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={CANDIDATE} selectedId={null} onSelect={() => {}} />);

    const section = screen.getByRole("region", { name: "Scenario comparison" });
    await within(section).findByText(/across the farm/);
    expect(section).toHaveTextContent("+1,153 kW across the farm, better");
    // Percentage points, not percent: "16% loss" and "−9 points of loss" are different claims.
    expect(section).toHaveTextContent("−9.2 pp");
  });

  it("keeps the floor-not-a-bound framing on a difference too", async () => {
    stub(record());
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={CANDIDATE} selectedId={null} onSelect={() => {}} />);

    const section = screen.getByRole("region", { name: "Scenario comparison" });
    expect(await within(section).findByText(/floor, not an upper limit/i)).toBeInTheDocument();
    expect(section).toHaveTextContent(/no better anchored than either of them/i);
  });

  it("reports turbines present in only one scene instead of dropping them", async () => {
    const payload = record();
    payload.only_in_candidate = ["t-r3c1", "t-r3c2"];
    stub(payload);
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={CANDIDATE} selectedId={null} onSelect={() => {}} />);

    expect(await screen.findByText(/2 turbines exist in only one scene/i)).toBeInTheDocument();
  });

  it("shares the selection with the rest of the workspace", async () => {
    stub(record());
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ComparisonPanel request={REQUEST} selectedId={null} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /pin as baseline/i }));
    rerender(<ComparisonPanel request={CANDIDATE} selectedId={null} onSelect={onSelect} />);

    await user.click(await screen.findByRole("button", { name: "t-r2c2" }));
    expect(onSelect).toHaveBeenCalledWith("t-r2c2");
  });
});
