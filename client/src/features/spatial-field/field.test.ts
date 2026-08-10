import { createFieldTexture, KFLD_HEADER_BYTES, parseVelocityField } from "./field";

function makeField() {
  const bytes = new Uint8Array(KFLD_HEADER_BYTES + 2 * 2 * 2 * 4);
  bytes.set(new TextEncoder().encode("KFLD"));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, KFLD_HEADER_BYTES, true);
  view.setUint16(8, 2, true);
  view.setUint16(10, 2, true);
  view.setUint16(12, 2, true);
  view.setFloat64(16, 12, true);
  view.setFloat64(24, 34, true);
  view.setFloat32(32, 5, true);
  view.setFloat32(36, 6, true);
  view.setFloat32(40, 100, true);
  view.setFloat32(44, 14, true);
  bytes.fill(128, KFLD_HEADER_BYTES);
  return bytes;
}

describe("KFLD client", () => {
  it("parses the server binary contract without copying header bytes into the texture", () => {
    const field = parseVelocityField(makeField().buffer);
    expect(field).toMatchObject({ columns: 2, rows: 2, levels: 2, originEastingM: 12, originNorthingM: 34, velocityScaleMs: 14 });
    expect(field.texels).toHaveLength(32);
    expect([...field.texels]).toEqual(Array(32).fill(128));
  });

  it.each([
    ["bad magic", (bytes: Uint8Array) => bytes.fill(0, 0, 4), /magic/],
    ["new version", (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(4, 2, true), /version 2/],
    ["truncated payload", (bytes: Uint8Array) => bytes.subarray(0, bytes.length - 1), /length/],
  ])("rejects %s", (_, mutate, message) => {
    const bytes = makeField();
    const changed = mutate(bytes) ?? bytes;
    expect(() => parseVelocityField(changed.buffer.slice(changed.byteOffset, changed.byteOffset + changed.byteLength))).toThrow(message);
  });

  it("configures a filtered 3D texture and allows explicit disposal", () => {
    const texture = createFieldTexture(parseVelocityField(makeField().buffer));
    const dispose = vi.spyOn(texture, "dispose");
    expect(texture.image).toMatchObject({ width: 2, height: 2, depth: 2 });
    expect(texture.generateMipmaps).toBe(false);
    texture.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

