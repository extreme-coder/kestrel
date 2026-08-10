import { ASKERVEIN_FIELD_REQUEST, ASKERVEIN_TERRAIN } from "./askervein";

describe("Askervein measured terrain", () => {
  it("decodes one elevation for every grid point and preserves the measured relief", () => {
    expect(ASKERVEIN_TERRAIN.elevationsM).toHaveLength(33 * 33);
    expect(Math.min(...ASKERVEIN_TERRAIN.elevationsM)).toBeCloseTo(0.5, 1);
    expect(Math.max(...ASKERVEIN_TERRAIN.elevationsM)).toBeCloseTo(122.9, 1);
  });

  it("uses the same terrain grid for the velocity-field request", () => {
    expect(ASKERVEIN_FIELD_REQUEST.terrain.elevations_m).toBe(ASKERVEIN_TERRAIN.elevationsM);
    expect(ASKERVEIN_FIELD_REQUEST.terrain.site_id).toContain("copernicus-glo30");
    expect(ASKERVEIN_FIELD_REQUEST.layout.rows * ASKERVEIN_FIELD_REQUEST.layout.columns).toBe(4);
  });
});

