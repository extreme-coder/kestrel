import { describe, expect, it } from 'vitest'

import { ASKERVEIN_COMMON_SECTOR, ASKERVEIN_WIND_ROSE } from '../src/lib/askerveinRose.js'
import {
  DEFAULT_SECTOR_COUNT,
  buildWindRose,
  commonSector,
  sectorBearings,
  serialiseWindRose,
} from '../src/lib/windRose.js'
import { makeSeries } from './helpers/fakeWind.js'

describe('buildWindRose', () => {
  it('centres each sector on its nominal bearing', () => {
    // The bin named "north" has to span 345-15, not 0-30. Getting this wrong rotates the
    // whole rose half a bin against every published convention, which is invisible in a
    // polar plot and wrong in every sector-averaged number read off it.
    const rose = buildWindRose(makeSeries({ hours: 4, windDirection100m: (h) => [350, 5, 200, 215][h]! }))
    const north = rose.sectors[0]!
    expect(north.centreDeg).toBe(0)
    expect(north.fromDeg).toBe(345)
    expect(north.toDeg).toBe(15)
    expect(north.hours).toBe(2)
    expect(rose.sectors[7]!.centreDeg).toBe(210)
    expect(rose.sectors[7]!.hours).toBe(2)
  })

  it('puts every hour in exactly one sector', () => {
    const rose = buildWindRose(makeSeries({ hours: 360, windDirection100m: (h) => h }))
    expect(rose.sectors.reduce((sum, sector) => sum + sector.hours, 0)).toBe(360)
    expect(rose.sectors.reduce((sum, sector) => sum + sector.frequency, 0)).toBeCloseTo(1, 12)
    expect(rose.sectors.reduce((sum, sector) => sum + sector.energyShare, 0)).toBeCloseTo(1, 12)
  })

  it('reports an energy speed that preserves the sector wind power density', () => {
    // Two hours at 5 and 15 m/s: the arithmetic mean is 10, but the wind power available is
    // the mean of the cubes. Using the arithmetic mean would under-read this sector's energy
    // by more than a factor of two, and wake losses are largest where the energy is.
    const rose = buildWindRose(makeSeries({ hours: 2, windSpeed100m: (h) => (h === 0 ? 5 : 15), windDirection100m: 210 }))
    const sector = rose.sectors[7]!
    expect(sector.meanSpeedMs).toBeCloseTo(10, 12)
    expect(sector.energySpeedMs).toBeCloseTo(((125 + 3375) / 2) ** (1 / 3), 12)
    expect(sector.energySpeedMs).toBeGreaterThan(sector.meanSpeedMs)
  })

  it('ranks the dominant sector by energy rather than by hours', () => {
    // 6 gentle hours from the north against 2 strong hours from the south-west. Hours say
    // north; energy says south-west, and a siting decision cares about the second.
    const rose = buildWindRose(
      makeSeries({
        hours: 8,
        windDirection100m: (h) => (h < 6 ? 0 : 210),
        windSpeed100m: (h) => (h < 6 ? 3 : 20),
      }),
    )
    expect(rose.sectors[0]!.hours).toBeGreaterThan(rose.sectors[7]!.hours)
    expect(rose.dominantSectorIndex).toBe(7)
  })

  it('reads the 100 m level by default and the 10 m level on request', () => {
    // Direction veers with height. Choosing a bearing for a 100 m rotor off the 10 m rose
    // would bias it by the turning across the layer between them.
    const series = makeSeries({ hours: 2, windDirection100m: 210, windDirection10m: 180 })
    expect(buildWindRose(series).sectors[7]!.hours).toBe(2)
    expect(buildWindRose(series, { height: '10m' }).sectors[6]!.hours).toBe(2)
  })

  it('rejects an empty series and an unusable sector count', () => {
    expect(() => buildWindRose({ latitude: 0, longitude: 0, elevationM: 0, samples: [] })).toThrow(RangeError)
    expect(() => buildWindRose(makeSeries({ hours: 1 }), { sectors: 3 })).toThrow(RangeError)
    expect(() => buildWindRose(makeSeries({ hours: 1 }), { sectors: 12.5 })).toThrow(RangeError)
  })
})

describe('commonSector', () => {
  it('takes the narrowest arc reaching the coverage threshold', () => {
    const rose = buildWindRose(
      makeSeries({ hours: 12, windDirection100m: (h) => (h < 8 ? 210 : h * 30) }),
    )
    const sector = commonSector(rose, 0.5)
    expect(sector.widthDeg).toBe(30)
    expect(sector.sectorIndices).toEqual([7])
    expect(sector.centreDeg).toBe(210)
    expect(sector.fromDeg).toBe(195)
    expect(sector.toDeg).toBe(225)
  })

  it('wraps an arc through north instead of splitting it', () => {
    // A northerly site's common sector straddles 0. An implementation that only walks
    // upward from index 0 reports two separate arcs and picks the smaller half.
    const rose = buildWindRose(
      makeSeries({ hours: 10, windDirection100m: (h) => (h < 5 ? 350 : h < 9 ? 20 : 180) }),
    )
    const sector = commonSector(rose, 0.5)
    expect(sector.sectorIndices).toEqual([0])
    expect(sector.fromDeg).toBe(345)
    expect(sector.toDeg).toBe(15)
  })

  it('widens until the coverage is met', () => {
    const rose = buildWindRose(
      makeSeries({ hours: 12, windDirection100m: (h) => [180, 180, 210, 210, 210, 240, 240, 0, 30, 60, 90, 120][h]! }),
    )
    const half = commonSector(rose, 0.5)
    const nearlyAll = commonSector(rose, 0.95)
    expect(half.widthDeg).toBeLessThan(nearlyAll.widthDeg)
    expect(half.energyShare).toBeGreaterThanOrEqual(0.5)
    expect(nearlyAll.energyShare).toBeGreaterThanOrEqual(0.95)
  })

  it('returns the whole rose when coverage is 1', () => {
    const rose = buildWindRose(makeSeries({ hours: 24, windDirection100m: (h) => h * 15 }))
    expect(commonSector(rose, 1).widthDeg).toBe(360)
  })

  it('rejects a coverage outside (0, 1]', () => {
    const rose = buildWindRose(makeSeries({ hours: 4 }))
    expect(() => commonSector(rose, 0)).toThrow(RangeError)
    expect(() => commonSector(rose, 1.5)).toThrow(RangeError)
  })
})

describe('sectorBearings', () => {
  it('walks from the start edge so an arc crossing north is not empty', () => {
    // `for (b = fromDeg; b <= toDeg; b++)` yields nothing at all when fromDeg is 345 and
    // toDeg is 15, and the bearing search would silently examine no candidates.
    expect(sectorBearings({ fromDeg: 345, widthDeg: 30 }, 10)).toEqual([345, 355, 5, 15])
  })

  it('covers the Askervein sector at the documented 5 degree step', () => {
    const bearings = sectorBearings(ASKERVEIN_COMMON_SECTOR, 5)
    expect(bearings).toHaveLength(19)
    expect(bearings[0]).toBe(195)
    expect(bearings.at(-1)).toBe(285)
    expect(bearings).toContain(210)
    expect(bearings).toContain(215)
  })

  it('rejects a non-positive step', () => {
    expect(() => sectorBearings({ fromDeg: 0, widthDeg: 90 }, 0)).toThrow(RangeError)
  })
})

describe('the recorded Askervein rose', () => {
  it('re-derives the sector the alternate bearing was chosen inside', () => {
    // The generated file records both the rose and the sector. If `commonSector`'s definition
    // moves, `docs/design/alternate-bearing.md` is quoting an arc the code no longer produces,
    // and the bearing in it stops being reproducible.
    expect(commonSector(ASKERVEIN_WIND_ROSE)).toEqual(ASKERVEIN_COMMON_SECTOR)
  })

  it('matches the sector and dominant direction the document quotes', () => {
    expect(ASKERVEIN_COMMON_SECTOR.fromDeg).toBe(195)
    expect(ASKERVEIN_COMMON_SECTOR.toDeg).toBe(285)
    expect(ASKERVEIN_WIND_ROSE.sectors[ASKERVEIN_WIND_ROSE.dominantSectorIndex]!.centreDeg).toBe(210)
  })

  it('covers the baseline and alternate bearings the primary task uses', () => {
    // If a refreshed rose ever moved the sector off 210 or 215, T3 would be asking about a
    // bearing the site does not commonly see, and the task would need rewriting rather than
    // the number quietly updating.
    const bearings = sectorBearings(ASKERVEIN_COMMON_SECTOR, 5)
    expect(bearings).toContain(210)
    expect(bearings).toContain(215)
  })

  it('is a full five years of hours, not one', () => {
    // A one-year rose is not a climatology, and this one fixes a documented sector.
    expect(ASKERVEIN_WIND_ROSE.hours).toBeGreaterThan(43_000)
    expect(ASKERVEIN_WIND_ROSE.startDate).toBe('2015-01-01')
    expect(ASKERVEIN_WIND_ROSE.endDate).toBe('2019-12-31')
    expect(ASKERVEIN_WIND_ROSE.sectors).toHaveLength(DEFAULT_SECTOR_COUNT)
  })

  it('records the resolved ERA5 cell rather than the requested coordinate', () => {
    // Open-Meteo snaps to its grid. The rose describes a cell about 8 km from the hill, and
    // saying so is the difference between a reanalysis and a measurement at the site.
    expect(ASKERVEIN_WIND_ROSE.latitude).not.toBe(57.1879528)
  })
})

describe('serialiseWindRose', () => {
  it('projects to snake_case with the sector attached', () => {
    const rose = buildWindRose(makeSeries({ hours: 4, windDirection100m: 210 }), {
      startDate: '2019-01-01',
      endDate: '2019-12-31',
    })
    const payload = serialiseWindRose(rose, commonSector(rose))
    expect(payload.sector_width_deg).toBe(30)
    expect(payload.start_date).toBe('2019-01-01')
    expect(payload.sectors[7]!.centre_deg).toBe(210)
    expect(payload.common_sector.centre_deg).toBe(210)
  })
})
