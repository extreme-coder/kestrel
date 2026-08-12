import { renderHook, waitFor } from "@testing-library/react";
import { useProvenance } from "./useProvenance";
import type { ProvenanceRecord } from "./provenance";

const RECORD: ProvenanceRecord = {
  model_version: "2026.08.1",
  validated_at: "2026-08-11",
  results: [
    {
      id: "wake-deficit",
      label: "Wake loss",
      provenance: "computed",
      description: "Velocity deficit behind each turbine.",
      validation: "externally-anchored",
      anchor: {
        case: "Horns Rev 1",
        source: "doi:10.1002/we.1625",
        conditions: "8 m/s, 270 +/- 15 degrees",
        metric: "Farm efficiency",
        result: "78.4% against 73.9%",
        limitations: ["Under-reads array loss by about a sixth."],
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

describe("useProvenance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the validation record", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RECORD), { status: 200 })));
    const { result } = renderHook(() => useProvenance());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.record?.model_version).toBe("2026.08.1");
    expect(result.current.record?.scene.layout.status).toBe("synthetic-demonstration");
  });

  it("reports a failure rather than hiding it", async () => {
    // A silently missing disclosure leaves the figures on screen unqualified, which is
    // worse than showing none of it, so the error state has to be reachable by the UI.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { result } = renderHook(() => useProvenance());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatch(/503/);
  });
});
