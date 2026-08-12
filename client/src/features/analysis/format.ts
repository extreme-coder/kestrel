/**
 * How precisely a modelled figure may be written down.
 *
 * Not a style preference. The wake model has been measured against one array and misses its
 * farm efficiency by 4.5 percentage points; the terrain model is anchored at one height on
 * one hill. Printing a loss to three decimals would assert a resolution neither has, and the
 * viewer's own trust-calibration measure counts users who read model output as fact.
 */

export function percent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function kilowatts(value: number): string {
  return `${Math.round(value).toLocaleString("en-GB")} kW`;
}

export function speed(value: number): string {
  return `${value.toFixed(1)} m/s`;
}

/** Rotor diameters, the length scale wakes are read in. */
export function diameters(value: number, digits = 1): string {
  return `${value.toFixed(digits)} D`;
}

export function metres(value: number): string {
  return `${Math.round(value)} m`;
}
