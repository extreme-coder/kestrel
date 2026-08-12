import type { AnalysisRecord, TurbineAnalysis, WakePathPoint } from "./analysis";

/**
 * Test-only fixture: the shipped Askervein demonstration scene at its baseline bearing.
 *
 * The figures are the ones `npm run choose:bearing --workspace server` prints and
 * `docs/design/alternate-bearing.md` records, so a component test that formats them wrong is
 * visible against a real result rather than against invented round numbers.
 */

function path(eastingM: number, northingM: number): WakePathPoint[] {
  return Array.from({ length: 12 }, (_, index) => ({
    easting_m: eastingM - index * 43.7,
    northing_m: northingM - index * 75.7,
    elevation_m: 190 + index * 1.6,
    ground_elevation_m: 90 + index * 1.4,
    distance_m: index * 87.4,
  }));
}

function turbine(overrides: Partial<TurbineAnalysis> & { id: string }): TurbineAnalysis {
  return {
    easting_m: 1000,
    northing_m: 1000,
    ground_elevation_m: 90,
    hub_height_m: 100,
    gross_speed_ms: 10,
    incoming_speed_ms: 10,
    deficit: 0,
    thrust_coefficient: 0.8,
    gross_power_kw: 2400,
    net_power_kw: 2400,
    wake_loss_kw: 0,
    wake_loss_fraction: 0,
    dominant_contributor_id: null,
    wake_path: path(1000, 1000),
    contributors: [],
    ...overrides,
  };
}

export const ANALYSIS_FIXTURE: AnalysisRecord = {
  model_version: "2026.08.2",
  wind: { bearing_deg: 210, speed_ms: 10, reference_height_m: 100, turbulence_intensity: 0.08 },
  layout: {
    turbine: "vestas-v112-3450",
    turbine_name: "V112-3450",
    rotor_diameter_m: 112,
    rated_power_kw: 3450,
    orientation_bearing_deg: 210,
    count: 4,
  },
  turbines: [
    turbine({
      id: "t-r1c1",
      easting_m: 776,
      northing_m: 1224,
      gross_speed_ms: 9.53,
      incoming_speed_ms: 9.53,
      gross_power_kw: 2353,
      net_power_kw: 2353,
      wake_path: path(776, 1224),
    }),
    turbine({
      id: "t-r1c2",
      easting_m: 1224,
      northing_m: 1224,
      gross_speed_ms: 9.97,
      incoming_speed_ms: 9.97,
      gross_power_kw: 2691,
      net_power_kw: 2691,
      wake_path: path(1224, 1224),
    }),
    turbine({
      id: "t-r2c1",
      easting_m: 776,
      northing_m: 776,
      gross_speed_ms: 10.74,
      incoming_speed_ms: 8.77,
      deficit: 0.1834,
      gross_power_kw: 3362,
      net_power_kw: 1829,
      wake_loss_kw: 1533,
      wake_loss_fraction: 0.4559,
      dominant_contributor_id: "t-r1c1",
      wake_path: path(776, 776),
      contributors: [
        { turbine_id: "t-r1c1", deficit: 0.1834, share: 0.9999, attributed_loss_kw: 1532.8, downwind_m: 896, downwind_d: 8.0, radial_m: 22.4, radial_d: 0.2 },
        { turbine_id: "t-r1c2", deficit: 0.0001, share: 0.0001, attributed_loss_kw: 0.2, downwind_m: 930, downwind_d: 8.3, radial_m: 702, radial_d: 6.27 },
      ],
    }),
    turbine({
      id: "t-r2c2",
      easting_m: 1224,
      northing_m: 776,
      gross_speed_ms: 10.73,
      incoming_speed_ms: 8.88,
      deficit: 0.1724,
      gross_power_kw: 3357,
      net_power_kw: 1902,
      wake_loss_kw: 1455,
      wake_loss_fraction: 0.4334,
      dominant_contributor_id: "t-r1c2",
      wake_path: path(1224, 776),
      contributors: [
        { turbine_id: "t-r1c2", deficit: 0.1724, share: 0.9998, attributed_loss_kw: 1454.7, downwind_m: 896, downwind_d: 8.0, radial_m: 30.2, radial_d: 0.27 },
      ],
    }),
  ],
  farm: {
    total_gross_power_kw: 11763,
    total_net_power_kw: 8775,
    total_wake_loss_kw: 2988,
    farm_wake_loss_fraction: 0.254,
    worst_turbine_id: "t-r2c1",
  },
  provenance: {
    model_version: "2026.08.2",
    result: "computed",
    wake_loss_framing:
      "Modelled wake losses are a floor, not an upper limit. Against Horns Rev 1 this model accounted for 83% of the measured array loss, so real losses are likely larger.",
    quantities: {
      gross_speed_ms: ["terrain-base-flow"],
      incoming_speed_ms: ["hub-wind-speed"],
      gross_power_kw: ["turbine-power", "terrain-base-flow"],
      net_power_kw: ["turbine-power", "hub-wind-speed"],
      wake_loss_kw: ["wake-deficit", "turbine-power"],
      wake_loss_fraction: ["wake-deficit"],
      contributors: ["wake-attribution"],
      dominant_contributor_id: ["wake-attribution"],
      wake_path: ["terrain-base-flow"],
      farm_wake_loss_fraction: ["wake-deficit"],
    },
  },
};
