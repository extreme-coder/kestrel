import { render, screen } from "@testing-library/react";
import { AnnualPanel } from "./AnnualPanel";
import type { AnnualRecord } from "./scenario";

const RECORD: AnnualRecord = {
  scene: { id: "askervein-demonstration", name: "Askervein" },
  turbines: [],
  farm: {
    weighted_net_power_kw: 9500,
    weighted_wake_loss_fraction: 0.0382,
    worst_turbine_id: "t-r2c1",
    worst_sector_bearing_deg: 300,
    worst_sector_speed_ms: 10.5,
    worst_sector_wake_loss_kw: 3607,
    worst_sector_wake_loss_fraction: 0.2688,
    worst_sector_frequency: 0.0056,
  },
  sectors: [
    { sector_bearing_deg: 210, sector_weight: 0.143, wake_loss_fraction: 0.0857, conditions: 32 },
    { sector_bearing_deg: 300, sector_weight: 0.085, wake_loss_fraction: 0.157, conditions: 27 },
  ],
  sectors_evaluated: 12,
  conditions_evaluated: 327,
  frequency_covered: 1,
  provenance: { wake_loss_framing: "Modelled wake losses are a floor, not an upper limit." },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnnualPanel", () => {
  it("shows the expected loss and the worst condition at equal weight", async () => {
    // Showing either alone misleads in a different direction: the first makes a sharp
    // directional wake look benign, the second makes every farm look ruinous.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RECORD), { status: 200 })));
    render(<AnnualPanel scene={{ id: "s" }} />);

    expect(await screen.findByText("3.8%")).toBeInTheDocument();
    expect(screen.getByText("26.9%")).toBeInTheDocument();
    expect(screen.getByText(/0.6% of hours/)).toBeInTheDocument();
  });

  it("says in words that a rare severe wake is not an annual expectation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RECORD), { status: 200 })));
    render(<AnnualPanel scene={{ id: "s" }} />);

    const section = await screen.findByRole("region", { name: "Expected annual loss" });
    expect(section).toHaveTextContent(/different claims/i);
    expect(section).toHaveTextContent("3,607 kW");
    expect(section).toHaveTextContent("300° (North-west)");
  });

  it("states the resolution it does not have", async () => {
    // Each cell is one bearing at one speed, and this farm moves several points of loss
    // across 5 degrees — far finer than a 30 degree bin.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RECORD), { status: 200 })));
    render(<AnnualPanel scene={{ id: "s" }} />);

    const section = await screen.findByRole("region", { name: "Expected annual loss" });
    expect(section).toHaveTextContent("327 direction-and-speed cells");
    expect(section).toHaveTextContent(/variation inside a 30° sector is not resolved/i);
    expect(section).toHaveTextContent(/floor, not an upper limit/i);
  });

  it("explains a scene that cannot be weighted rather than showing nothing", async () => {
    // A scene with no rose genuinely cannot be weighted. Substituting a uniform one would
    // return a number that looks annual and describes nowhere.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "no_wind_rose", message: "this scene has no wind rose" }), {
          status: 422,
        }),
      ),
    );
    render(<AnnualPanel scene={{ id: "s" }} />);
    expect(await screen.findByText(/this scene has no wind rose/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a real failure as an alert", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    render(<AnnualPanel scene={{ id: "s" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not|failed/i);
  });
});
