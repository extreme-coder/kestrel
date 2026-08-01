/**
 * Turbine catalogue.
 *
 * These are the models the original Windsim shipped, recovered from the science-fair
 * report's validation table and the Windsim README. Each entry carries published
 * nameplate specifications — rated power, rotor diameter, and the cut-in / rated /
 * cut-out wind speeds.
 *
 * IMPORTANT, and stated plainly because it affects how results should be read:
 * the `curve` field is empty for every model below. The original drew tabulated power
 * curves from windatlas.xyz, which sourced them from manufacturer documentation. That
 * source is gone, so `powerCurveOutputKw` falls back to a *parametric* curve derived
 * from the specs (see `power.ts`). It reproduces the correct shape — cubic ramp between
 * cut-in and rated, flat to cut-out — but it is a model, not a transcription.
 *
 * To restore manufacturer fidelity for a model, fill in `curve` with measured
 * [windSpeed m/s, power kW] pairs; it takes precedence over the parametric fallback and
 * needs no other code change.
 */

export interface TurbineModel {
  /** Stable slug used in API requests. */
  id: string
  name: string
  manufacturer: string
  ratedPowerKw: number
  rotorDiameterM: number
  /** Below this wind speed the rotor does not turn. */
  cutInMs: number
  /** At and above this speed the turbine holds rated power. */
  ratedMs: number
  /** Above this speed the turbine feathers and shuts down for survival. */
  cutOutMs: number
  /**
   * Peak power coefficient, if this machine departs from the 0.45 default. Older or
   * stall-regulated designs sit lower; large modern direct-drive rotors sit higher.
   */
  powerCoefficient?: number
  /**
   * Measured power curve as [windSpeed m/s, power kW] pairs, ascending by speed.
   * When present, takes precedence over the parametric model.
   */
  curve?: ReadonlyArray<readonly [number, number]>
}

export const TURBINE_MODELS: readonly TurbineModel[] = [
  {
    id: 'vestas-v80-2000',
    name: 'V80-2000',
    manufacturer: 'Vestas',
    ratedPowerKw: 2000,
    rotorDiameterM: 80,
    cutInMs: 4,
    ratedMs: 16,
    cutOutMs: 25,
  },
  {
    id: 'vestas-v90-3000',
    name: 'V90-3000',
    manufacturer: 'Vestas',
    ratedPowerKw: 3000,
    rotorDiameterM: 90,
    cutInMs: 4,
    ratedMs: 15,
    cutOutMs: 25,
  },
  {
    id: 'vestas-v105-3450',
    name: 'V105-3450',
    manufacturer: 'Vestas',
    ratedPowerKw: 3450,
    rotorDiameterM: 105,
    cutInMs: 3,
    ratedMs: 12.5,
    cutOutMs: 25,
  },
  {
    id: 'vestas-v110-2000',
    name: 'V110-2000',
    manufacturer: 'Vestas',
    ratedPowerKw: 2000,
    rotorDiameterM: 110,
    cutInMs: 3,
    ratedMs: 11.5,
    cutOutMs: 20,
  },
  {
    id: 'vestas-v112-3450',
    name: 'V112-3450',
    manufacturer: 'Vestas',
    ratedPowerKw: 3450,
    rotorDiameterM: 112,
    cutInMs: 3,
    ratedMs: 12.5,
    cutOutMs: 25,
  },
  {
    id: 'vestas-v117-3450',
    name: 'V117-3450',
    manufacturer: 'Vestas',
    ratedPowerKw: 3450,
    rotorDiameterM: 117,
    cutInMs: 3,
    ratedMs: 12,
    cutOutMs: 25,
  },
  {
    id: 'vestas-v126-3450',
    name: 'V126-3450',
    manufacturer: 'Vestas',
    ratedPowerKw: 3450,
    rotorDiameterM: 126,
    cutInMs: 3,
    ratedMs: 11.5,
    cutOutMs: 22.5,
  },
  {
    id: 'siemens-swt-2.3-93',
    name: 'SWT-2.3-93',
    manufacturer: 'Siemens',
    ratedPowerKw: 2300,
    rotorDiameterM: 93,
    cutInMs: 4,
    ratedMs: 13,
    cutOutMs: 25,
  },
  {
    id: 'siemens-swt-3.0-101',
    name: 'SWT-3.0-101',
    manufacturer: 'Siemens',
    ratedPowerKw: 3000,
    rotorDiameterM: 101,
    cutInMs: 3,
    ratedMs: 12,
    cutOutMs: 25,
  },
  {
    id: 'siemens-swt-3.6-107',
    name: 'SWT-3.6-107',
    manufacturer: 'Siemens',
    ratedPowerKw: 3600,
    rotorDiameterM: 107,
    cutInMs: 3.5,
    ratedMs: 13.5,
    cutOutMs: 25,
  },
  {
    id: 'siemens-swt-6.0-154',
    name: 'SWT-6.0-154',
    manufacturer: 'Siemens',
    ratedPowerKw: 6000,
    rotorDiameterM: 154,
    cutInMs: 3.5,
    ratedMs: 13,
    cutOutMs: 25,
  },
  {
    id: 'siemens-swt-7.0-154',
    name: 'SWT-7.0-154',
    manufacturer: 'Siemens',
    ratedPowerKw: 7000,
    rotorDiameterM: 154,
    cutInMs: 3.5,
    ratedMs: 13,
    cutOutMs: 25,
  },
  {
    id: 'bonus-b82-2300',
    name: 'B82-2300',
    manufacturer: 'Bonus',
    ratedPowerKw: 2300,
    rotorDiameterM: 82,
    cutInMs: 4,
    ratedMs: 14,
    cutOutMs: 25,
  },
]

const BY_ID = new Map(TURBINE_MODELS.map((m) => [m.id, m]))

export function getTurbineModel(id: string): TurbineModel | undefined {
  return BY_ID.get(id)
}

/** Swept area of the rotor in m², the `A` in P = ½ρAV³. */
export function sweptAreaM2(model: TurbineModel): number {
  const r = model.rotorDiameterM / 2
  return Math.PI * r * r
}
