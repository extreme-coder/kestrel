import { renderHook, waitFor } from "@testing-library/react";
import { KFLD_HEADER_BYTES } from "./field";
import { useVelocityField } from "./useVelocityField";

function responseBytes() {
  const bytes = new Uint8Array(KFLD_HEADER_BYTES + 4);
  bytes.set(new TextEncoder().encode("KFLD"));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true); view.setUint16(6, 64, true);
  view.setUint16(8, 1, true); view.setUint16(10, 1, true); view.setUint16(12, 1, true);
  view.setFloat32(32, 1, true); view.setFloat32(36, 1, true); view.setFloat32(40, 1, true); view.setFloat32(44, 10, true);
  return bytes;
}

describe("useVelocityField", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the request and parses the returned volume", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBytes(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = { wind: { speed_ms: 10 } };
    const { result } = renderHook(() => useVelocityField(request));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith("/api/field", expect.objectContaining({ method: "POST", body: JSON.stringify(request) }));
  });

  it("exposes an actionable HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const { result } = renderHook(() => useVelocityField({}));
    await waitFor(() => expect(result.current).toMatchObject({ status: "error", error: "Field request failed (503)" }));
  });
});
