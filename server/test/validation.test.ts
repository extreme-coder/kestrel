import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ASKERVEIN_ELEVATIONS_BASE64,
  HORNS_REV,
  TU03B,
  askerveinSummit,
  decodeAskerveinElevations,
  hornsRevLayout,
  hornsRevSector,
  measuredSummitSpeedUp,
  runAskerveinCase,
} from '../src/lib/validation/index.js'
import {
  ANALYSIS_QUANTITY_CLAIMS,
  RESULT_CLAIMS,
  WAKE_LOSS_FRAMING,
  collectedLimitations,
  serialiseProvenance,
} from '../src/lib/provenance.js'

/**
 * The external anchors. Every other physics test in this suite asserts a shape or a
 * relationship, and shape assertions cannot catch a calibration error — a 43% power-curve
 * bias once passed all of them. These are the tests that pin a *level* against a number
 * nobody on this project produced.
 */

const ANCHOR_HEIGHT_M = 34

describe('Askervein Hill — terrain response', () => {
  // 24 levels is the cheapest solve that resolves both the 34 m anchor and the 10 m Line A
  // stations over the hill, at about 2.5 s. The anchor barely moves with resolution:
  // 16/24/32/48 levels give 0.4550/0.4537/0.4550/0.4552. One solve serves the whole block.
  const result = runAskerveinCase({ levels: 24 })

  it('reproduces the measured hilltop speed-up at the top of the measured range', () => {
    const measured = measuredSummitSpeedUp(ANCHOR_HEIGHT_M)
    expect(measured).not.toBeNull()
    const modelled = result.summitProfile.find((row) => row.heightM === ANCHOR_HEIGHT_M)
    expect(modelled).toBeDefined()
    // Recorded finding: within 0.1%. The band is wide enough to survive solver numerics and
    // narrow enough that a recalibration of the base flow has to update docs/VALIDATION.md.
    expect(Math.abs(modelled!.relativeError)).toBeLessThan(0.1)
    expect(modelled!.modelled).toBeGreaterThan(0.41)
    expect(modelled!.modelled).toBeLessThan(0.50)
  })

  it('under-predicts speed-up nearer the ground, by more the lower it goes', () => {
    // Not a defect being pinned for its own sake. It is the documented consequence of a
    // model with no inner-layer physics, and the reason the client tells users not to read
    // near-surface speeds as measurements. If it ever stops holding, the disclosure is wrong.
    const byHeight = [...result.summitProfile].sort((a, b) => a.heightM - b.heightM)
    expect(byHeight.length).toBeGreaterThanOrEqual(3)
    for (const row of byHeight) expect(row.modelled).toBeLessThan(row.measured + 0.02)

    const lowest = byHeight[0]!
    const highest = byHeight[byHeight.length - 1]!
    expect(Math.abs(lowest.relativeError)).toBeGreaterThan(Math.abs(highest.relativeError))
  })

  it('does not reproduce lee-side deceleration', () => {
    const lee = result.lineA.find((row) => row.distanceM === 400)
    expect(lee).toBeDefined()
    // Measured -0.651, modelled about -0.084. A mass-consistent field has no momentum
    // equation, so separation cannot appear. This bounds which sites are honest to render.
    expect(lee!.measured).toBeLessThan(-0.6)
    expect(lee!.modelled / lee!.measured).toBeLessThan(0.25)
  })

  it('places the summit where the campaign put the hilltop mast', () => {
    const summit = askerveinSummit()
    // Published HT elevation 123.79 m; GLO-30's peak node lands 0.7% low.
    expect(summit.elevationM).toBeGreaterThan(120)
    expect(summit.elevationM).toBeLessThan(126)
    // The solve works on cell centres, so its summit sits below the DEM peak. Sampling a
    // height above ground against the wrong one of these silently shifts the comparison.
    expect(result.modelSummitElevationM).toBeLessThan(result.demSummitElevationM)
    expect(result.demSummitElevationM - result.modelSummitElevationM).toBeLessThan(10)
  })

  it('converges', () => {
    expect(result.converged).toBe(true)
  })
})

describe('the validation terrain is the terrain the viewer renders', () => {
  it('matches the client asset byte for byte', () => {
    // Askervein's whole value is that the validated terrain and the displayed terrain are
    // the same. Two copies of the elevations exist because the workspaces do not share a
    // module; this is what stops them drifting apart silently.
    const clientSource = readFileSync(
      fileURLToPath(new URL('../../client/src/features/site/askervein.ts', import.meta.url)),
      'utf8',
    )
    const literal = /"([A-Za-z0-9+/=]{100,})"/.exec(clientSource)
    expect(literal).not.toBeNull()
    expect(literal![1]).toBe(ASKERVEIN_ELEVATIONS_BASE64)
  })

  it('decodes to a full grid with plausible relief', () => {
    const elevations = decodeAskerveinElevations()
    expect(elevations).toHaveLength(33 * 33)
    expect(Math.min(...elevations)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...elevations)).toBeCloseTo(122.9, 5)
  })
})

describe('Horns Rev 1 — wake losses', () => {
  it('builds the published array', () => {
    const layout = hornsRevLayout()
    expect(layout).toHaveLength(80)
    const spacing = HORNS_REV.spacingD * layout[0]!.model.rotorDiameterM
    expect(spacing).toBeCloseTo(560, 9)
    // Parallelogram sides, not the bounding box: 9 x 560 m by 7 x 560 m.
    const eastings = layout.map((t) => t.eastingM)
    const northings = layout.map((t) => t.northingM)
    expect(Math.max(...northings) - Math.min(...northings)).toBeCloseTo(7 * spacing * Math.cos((7 * Math.PI) / 180), 6)
    expect(Math.max(...eastings) - Math.min(...eastings)).toBeGreaterThan(9 * spacing)
  })

  it('matches measured farm efficiency over the wide sector', () => {
    const sector = hornsRevSector(15)
    expect(sector.measured).toBe(HORNS_REV.measuredEfficiency.wide)
    // Recorded finding: 78.4% against a measured 73.9%, +4.5 points.
    expect(sector.modelled).toBeGreaterThan(0.75)
    expect(sector.modelled).toBeLessThan(0.82)
    expect(sector.deviationPp).toBeGreaterThan(0)
    expect(sector.deviationPp).toBeLessThan(8)
  })

  it('under-reads array loss rather than over-reading it', () => {
    // The direction of the error is what the client disclosure claims, so it is pinned
    // separately from the magnitude: reported wake losses are a floor.
    const sector = hornsRevSector(15)
    expect(sector.lossRecovered).toBeLessThan(1)
    expect(sector.lossRecovered).toBeGreaterThan(0.7)
  })

  it('sits with the published models on the narrow sector, which is not an anchor', () => {
    // Jensen -20.9, Larsen -20.9 and Fuga -21.7 points; the source attributes the gap to
    // wind-direction uncertainty in the dataset. A model that matched 64.7% here would be
    // fitted to a measurement artefact, so this asserts company, not accuracy.
    const sector = hornsRevSector(2.5)
    const published = Object.values(HORNS_REV.publishedModelDeviationPp.narrow)
    const worst = Math.min(...published)
    expect(sector.deviationPp).toBeLessThan(-10)
    expect(sector.deviationPp).toBeGreaterThan(worst - 5)
  })

  it('is insensitive to the reconstructed parallelogram skew', () => {
    // The skew is inferred from a description rather than surveyed coordinates, so the
    // anchor would be worth little if the result depended on it. Mirroring it, or dropping
    // it for a plain rectangle, must not move the answer.
    const asBuilt = hornsRevSector(15).modelled
    for (const skewDeg of [-HORNS_REV.columnSkewDeg, 0]) {
      expect(hornsRevSector(15, 0.5, hornsRevLayout(skewDeg)).modelled).toBeCloseTo(asBuilt, 3)
    }
  })

  it('has converged in the sector quadrature', () => {
    // Halving the step must not move the efficiency by more than a tenth of a point,
    // otherwise the +4.5 point deviation is partly a discretisation artefact.
    expect(hornsRevSector(15, 0.25).modelled).toBeCloseTo(hornsRevSector(15).modelled, 2)
  })

  it('uses the site turbulence intensity, not the one that fits best', () => {
    expect(HORNS_REV.turbulenceIntensity).toBe(0.07)
  })
})

describe('provenance record', () => {
  it('gives every claim a provenance and a validation state', () => {
    expect(RESULT_CLAIMS.length).toBeGreaterThan(0)
    for (const claim of RESULT_CLAIMS) {
      expect(['measured', 'derived', 'computed']).toContain(claim.provenance)
      expect(['externally-anchored', 'internally-tested', 'unvalidated']).toContain(claim.validation)
      expect(claim.label.length).toBeGreaterThan(0)
      expect(claim.description.length).toBeGreaterThan(0)
    }
  })

  it('makes every externally-anchored claim carry source, conditions, metric, result and limitations', () => {
    const anchored = RESULT_CLAIMS.filter((claim) => claim.validation === 'externally-anchored')
    expect(anchored.length).toBeGreaterThanOrEqual(2)
    for (const claim of anchored) {
      expect(claim.anchor, claim.id).toBeDefined()
      expect(claim.anchor!.source.length).toBeGreaterThan(0)
      expect(claim.anchor!.conditions.length).toBeGreaterThan(0)
      expect(claim.anchor!.metric.length).toBeGreaterThan(0)
      expect(claim.anchor!.result.length).toBeGreaterThan(0)
      expect(claim.anchor!.limitations.length, claim.id).toBeGreaterThan(0)
    }
  })

  it('explains every claim that is not externally anchored', () => {
    for (const claim of RESULT_CLAIMS) {
      if (claim.validation === 'externally-anchored') continue
      expect(claim.note, claim.id).toBeTruthy()
      expect(claim.anchor, claim.id).toBeUndefined()
    }
  })

  it('anchors the two claims the viewer draws', () => {
    for (const id of ['terrain-base-flow', 'wake-deficit']) {
      const claim = RESULT_CLAIMS.find((entry) => entry.id === id)
      expect(claim?.validation, id).toBe('externally-anchored')
      expect(claim?.provenance, id).toBe('computed')
    }
  })

  it('resolves every quantity the analysis reports to a real claim', () => {
    // ADR 0004 / D25. The client picks a chip per rendered number out of this map, so a
    // dangling id would silently render a figure with no provenance at all.
    const ids = new Set(RESULT_CLAIMS.map((claim) => claim.id))
    for (const [quantity, claims] of Object.entries(ANALYSIS_QUANTITY_CLAIMS)) {
      expect(claims.length, quantity).toBeGreaterThan(0)
      for (const id of claims) expect(ids.has(id), `${quantity} -> ${id}`).toBe(true)
    }
  })

  it('refuses to call the composition the viewer draws validated', () => {
    // Askervein has no turbines and Horns Rev has no hill. Two anchored layers do not make
    // an anchored product, and the quantities built on top of both have to say so.
    for (const id of ['hub-wind-speed', 'wake-attribution']) {
      const claim = RESULT_CLAIMS.find((entry) => entry.id === id)
      expect(claim?.validation, id).toBe('unvalidated')
      expect(claim?.provenance, id).toBe('computed')
      expect(claim?.note, id).toMatch(/anchor|hill|terrain/i)
    }
  })

  it('carries the floor-not-a-bound framing wake losses have to be read with', () => {
    // D24: the model recovers 82.9% of Horns Rev's measured array loss. One exported string
    // so the server, the client and docs/VALIDATION.md cannot drift apart on the hedge.
    expect(WAKE_LOSS_FRAMING).toMatch(/floor/i)
    expect(WAKE_LOSS_FRAMING).toMatch(/not an upper limit/i)
    expect(WAKE_LOSS_FRAMING).toMatch(/83%/)
  })

  it('states that the demonstration turbines are not a real farm', () => {
    const scene = serialiseProvenance().scene
    expect(scene.terrain.provenance).toBe('measured')
    expect(scene.layout.provenance).toBe('computed')
    expect(scene.layout.status).toBe('synthetic-demonstration')
    expect(scene.layout.statement).toMatch(/no wind farm exists at askervein/i)
  })

  it('collects limitations for the client disclosure without duplicates', () => {
    const limitations = collectedLimitations()
    expect(limitations.length).toBeGreaterThan(5)
    expect(new Set(limitations).size).toBe(limitations.length)
  })

  it('cites the source the measured data was transcribed from', () => {
    expect(TU03B.source).toMatch(/Riso-R-1688/)
    expect(HORNS_REV.source).toMatch(/10\.1002\/we\.1625/)
  })
})
