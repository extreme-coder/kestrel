import { ANALYSIS_FIXTURE } from "./analysis.fixture";
import {
  describeAttribution,
  downstreamOf,
  emphasisPath,
  findTurbine,
  involvedTurbineIds,
  materialContributors,
  rankedByLoss,
} from "./analysis";
import { centrelineElevationAt, describeSection } from "./VerticalSection";

const record = ANALYSIS_FIXTURE;
const worst = findTurbine(record, "t-r2c1")!;
const unwaked = findTurbine(record, "t-r1c1")!;

describe("turbine ranking", () => {
  it("orders by wake loss, worst first — the answer form for T1", () => {
    expect(rankedByLoss(record).map((turbine) => turbine.id)).toEqual([
      "t-r2c1",
      "t-r2c2",
      "t-r1c1",
      "t-r1c2",
    ]);
    expect(rankedByLoss(record)[0]!.id).toBe(record.farm.worst_turbine_id);
  });

  it("breaks ties by id so a redraw cannot reshuffle the list", () => {
    const tied = { ...record, turbines: [...record.turbines].reverse() };
    expect(rankedByLoss(tied).slice(2).map((turbine) => turbine.id)).toEqual(["t-r1c1", "t-r1c2"]);
  });
});

describe("attribution", () => {
  it("drops contributors too small to name as a cause", () => {
    // A turbine standing beside another rather than behind it still registers a deficit of
    // order 1e-4. Listing it as a cause would be noise presented as a finding.
    expect(worst.contributors).toHaveLength(2);
    expect(materialContributors(worst).map((c) => c.turbine_id)).toEqual(["t-r1c1"]);
  });

  it("claims no cause at all when the loss is inside the model's own error", () => {
    expect(materialContributors(unwaked)).toEqual([]);
  });

  it("finds the turbines a machine is modelled to wake", () => {
    const downstream = downstreamOf(record, "t-r1c1");
    expect(downstream.map((effect) => effect.turbine.id)).toEqual(["t-r2c1"]);
    expect(downstream[0]!.contribution.attributed_loss_kw).toBeCloseTo(1532.8, 1);
    expect(downstreamOf(record, "t-r2c1")).toEqual([]);
  });

  it("attributes every claim to the model rather than stating it as fact", () => {
    // The trust-calibration measure in docs/design/primary-task.md counts users who state
    // model output as fact. A sentence written the other way is the interface causing it.
    const sentence = describeAttribution(record, worst);
    expect(sentence).toMatch(/^The model attributes/);
    expect(sentence).toContain("100% of t-r2c1's 1533 kW loss to t-r1c1");
    expect(sentence).toContain("8.0 D upwind");
    expect(sentence).toContain("0.20 D from the hub");
    expect(sentence).not.toMatch(/\bis taking\b|\bsteals\b/);
  });

  it("says what an unwaked turbine does instead of leaving the panel empty", () => {
    const sentence = describeAttribution(record, unwaked);
    expect(sentence).toContain("no upstream wake reaching t-r1c1 at 210°");
    expect(sentence).toContain("1533 kW at t-r2c1");
  });
});

describe("scene emphasis", () => {
  it("emphasises the axis arriving at a waked turbine", () => {
    expect(emphasisPath(record, "t-r2c1")).toBe(unwaked.wake_path);
  });

  it("falls back to the axis leaving an unwaked turbine", () => {
    expect(emphasisPath(record, "t-r1c1")).toBe(unwaked.wake_path);
    expect(emphasisPath(record, null)).toEqual([]);
  });

  it("counts the selection, its causes and its victims as involved", () => {
    expect(involvedTurbineIds(record, "t-r2c1")).toEqual(new Set(["t-r2c1", "t-r1c1"]));
    expect(involvedTurbineIds(record, "t-r1c1")).toEqual(new Set(["t-r1c1", "t-r2c1"]));
    expect(involvedTurbineIds(record, null).size).toBe(0);
  });
});

describe("vertical section", () => {
  it("interpolates the centreline between traced samples", () => {
    const path = unwaked.wake_path;
    expect(centrelineElevationAt(path, 0)).toBe(path[0]!.elevation_m);
    expect(centrelineElevationAt(path, 43.7)).toBeCloseTo(190.8, 1);
    expect(centrelineElevationAt(path, 1e6)).toBe(path[path.length - 1]!.elevation_m);
    expect(centrelineElevationAt([], 10)).toBeNull();
  });

  it("states the height relation in words, not only in the drawing", () => {
    // If the relation between plume and rotor only reads in the picture, a screen-reader
    // user loses the finding entirely — and the finding is the product.
    const text = describeSection(unwaked.wake_path, "t-r1c1", 112, [
      { id: "t-r2c1", distanceM: 896, hubElevationM: 190 },
    ]);
    expect(text).toContain("8.0 D downwind");
    expect(text).toContain("t-r2c1's rotor spans");
    expect(text).toMatch(/climbs \d+ m/);
  });
});
