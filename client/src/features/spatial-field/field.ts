import {
  Data3DTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
} from "three";

export const KFLD_HEADER_BYTES = 64;

export type VelocityField = {
  columns: number;
  rows: number;
  levels: number;
  originEastingM: number;
  originNorthingM: number;
  cellSizeEastingM: number;
  cellSizeNorthingM: number;
  topElevationM: number;
  velocityScaleMs: number;
  texels: Uint8Array;
};

export function parseVelocityField(buffer: ArrayBuffer): VelocityField {
  if (buffer.byteLength < KFLD_HEADER_BYTES) throw new Error("KFLD payload is shorter than its header");
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "KFLD") throw new Error("Invalid KFLD magic");
  const view = new DataView(buffer);
  const version = view.getUint16(4, true);
  const headerBytes = view.getUint16(6, true);
  if (version !== 1) throw new Error(`Unsupported KFLD version ${version}`);
  if (headerBytes !== KFLD_HEADER_BYTES) throw new Error(`Unsupported KFLD header length ${headerBytes}`);

  const columns = view.getUint16(8, true);
  const rows = view.getUint16(10, true);
  const levels = view.getUint16(12, true);
  if (columns < 1 || rows < 1 || levels < 1) throw new Error("KFLD dimensions must be positive");
  const texelBytes = columns * rows * levels * 4;
  if (buffer.byteLength !== headerBytes + texelBytes) {
    throw new Error(`KFLD payload length does not match ${columns} x ${rows} x ${levels}`);
  }
  const velocityScaleMs = view.getFloat32(44, true);
  if (!Number.isFinite(velocityScaleMs) || velocityScaleMs <= 0) throw new Error("KFLD velocity scale must be positive");

  return {
    columns,
    rows,
    levels,
    originEastingM: view.getFloat64(16, true),
    originNorthingM: view.getFloat64(24, true),
    cellSizeEastingM: view.getFloat32(32, true),
    cellSizeNorthingM: view.getFloat32(36, true),
    topElevationM: view.getFloat32(40, true),
    velocityScaleMs,
    texels: bytes.slice(headerBytes),
  };
}

export function createFieldTexture(field: VelocityField): Data3DTexture {
  const texture = new Data3DTexture(field.texels, field.columns, field.rows, field.levels);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

