import { expect } from 'chai'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  distanceNm,
  estimateStation,
  isReportReceived,
  lostAfterSeconds,
  powerLimitedRangeNm,
  radioHorizonNm,
  receptionProbability,
  receptionRangeNm,
  reportDraw,
  reportingIntervalSeconds
} from '../simulator/ais/reception'
import {
  parseCsvLine,
  parseTime,
  readAisReports
} from '../simulator/ais/targets'

const SERVER_PRUNE_SECONDS = 60 * 60

describe('simulator AIS reception', () => {
  describe('stations', () => {
    it('takes the AIS class from the source when it is stated', () => {
      expect(
        estimateStation({ transceiver: 'A', typeCode: 37, lengthM: 15 })
          .aisClass
      ).to.equal('A')
      expect(
        estimateStation({ transceiver: 'b', typeCode: 70, lengthM: 200 })
          .aisClass
      ).to.equal('B')
    })

    it('infers Class A for ships and larger workboats, Class B for yachts', () => {
      expect(
        estimateStation({ typeText: 'Cargo ship - All', lengthM: 229 })
      ).to.include({ aisClass: 'A', txPowerW: 12.5 })
      expect(
        estimateStation({ typeText: 'Tug', lengthM: 25 }).aisClass
      ).to.equal('A')
      expect(
        estimateStation({ typeText: 'Fishing', lengthM: 12 }).aisClass
      ).to.equal('B')
      expect(estimateStation({ typeText: 'Sailing', lengthM: 12 })).to.include({
        aisClass: 'B',
        txPowerW: 2
      })
      expect(estimateStation({ typeCode: 37 }).aisClass).to.equal('B')
      expect(estimateStation({}).aisClass).to.equal('B')
    })

    it('puts bigger vessels and masthead antennas higher', () => {
      const ship = estimateStation({
        typeCode: 70,
        lengthM: 229
      }).antennaHeightM
      const smallShip = estimateStation({
        typeCode: 70,
        lengthM: 60
      }).antennaHeightM
      const yacht = estimateStation({
        typeCode: 36,
        lengthM: 12
      }).antennaHeightM
      const runabout = estimateStation({
        typeCode: 37,
        lengthM: 6
      }).antennaHeightM
      expect(ship).to.be.greaterThan(smallShip)
      expect(yacht).to.be.greaterThan(runabout)
      expect(runabout).to.be.within(3, 5)
    })
  })

  describe('range', () => {
    it('computes the radio horizon with 4/3 Earth refraction', () => {
      expect(radioHorizonNm(10, 10)).to.be.closeTo(14.1, 0.1)
      expect(radioHorizonNm(25, 0)).to.be.closeTo(11.15, 0.01)
    })

    it('gives a 2 W transmitter less reach than 12.5 W at the same heights', () => {
      expect(powerLimitedRangeNm(2, 5, 10)).to.be.lessThan(
        powerLimitedRangeNm(12.5, 5, 10)
      )
    })

    it('lands in the published bands: Class A ships about 15-25 nm, Class B yachts about 5-10 nm', () => {
      const masthead = { antennaHeightM: 15 }
      const ship = receptionRangeNm(
        estimateStation({ typeText: 'Cargo ship - All', lengthM: 229 }),
        masthead
      )
      const yacht = receptionRangeNm(
        estimateStation({ typeText: 'Pleasure craft', lengthM: 12 }),
        masthead
      )
      expect(ship).to.be.within(15, 25)
      expect(yacht).to.be.within(5, 11)
      expect(ship).to.be.greaterThan(yacht)
    })

    it('fades reception around the range instead of cutting it off', () => {
      expect(receptionProbability(0, 10)).to.be.closeTo(0.98, 0.001)
      expect(receptionProbability(8, 10)).to.be.within(0.85, 0.95)
      expect(receptionProbability(10, 10)).to.be.closeTo(0.49, 0.01)
      expect(receptionProbability(12, 10)).to.be.within(0.05, 0.12)
      expect(receptionProbability(20, 10)).to.be.lessThan(0.001)
    })

    it('measures great-circle distance in nautical miles', () => {
      expect(distanceNm(0, 0, 1, 0)).to.be.closeTo(60.04, 0.05)
      expect(distanceNm(-27.45, 153.19, -27.45, 153.19)).to.equal(0)
    })
  })

  describe('reports', () => {
    it('follows the ITU-R M.1371 reporting intervals', () => {
      expect(reportingIntervalSeconds('A', 0.2, 5)).to.equal(180)
      expect(reportingIntervalSeconds('A', 0.2)).to.equal(180)
      expect(reportingIntervalSeconds('A', 4, 1)).to.equal(10)
      expect(reportingIntervalSeconds('A', 12)).to.equal(10)
      expect(reportingIntervalSeconds('A', 18)).to.equal(6)
      expect(reportingIntervalSeconds('A', 30)).to.equal(2)
      expect(reportingIntervalSeconds('B', 1)).to.equal(180)
      expect(reportingIntervalSeconds('B', 7)).to.equal(30)
    })

    it('loses every target well before the server prunes it', () => {
      for (const interval of [2, 6, 10, 30, 180]) {
        const lost = lostAfterSeconds(interval)
        expect(lost).to.be.at.least(180)
        expect(lost).to.be.at.most(SERVER_PRUNE_SECONDS / 4)
      }
      expect(lostAfterSeconds(180)).to.equal(540)
    })

    it('draws the same outcome for the same report every time', () => {
      expect(reportDraw('503123456', 1000)).to.equal(
        reportDraw('503123456', 1000)
      )
      expect(reportDraw('503123456', 1000)).to.not.equal(
        reportDraw('503123456', 2000)
      )
      const draws = Array.from({ length: 10000 }, (_, i) => reportDraw('x', i))
      const mean = draws.reduce((a, b) => a + b) / draws.length
      expect(mean).to.be.closeTo(0.5, 0.02)
      expect(Math.min(...draws)).to.be.at.least(0)
      expect(Math.max(...draws)).to.be.lessThan(1)
    })

    it('receives about the share of reports the probability says', () => {
      let heard = 0
      const trials = 5000
      for (let i = 0; i < trials; i++) {
        if (isReportReceived('target', i * 10000, 10, 10)) heard++
      }
      expect(heard / trials).to.be.closeTo(receptionProbability(10, 10), 0.03)
    })
  })

  describe('source files', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'sk-ais-'))
    })
    afterEach(async () => rm(dir, { recursive: true, force: true }))

    it('parses quoted CSV fields and both time formats', () => {
      expect(parseCsvLine('1,"SEA, WITCH","say ""hi""",')).to.deep.equal([
        '1',
        'SEA, WITCH',
        'say "hi"',
        ''
      ])
      expect(parseTime('2024-03-16 14:00:00', 'iso-utc')).to.equal(
        Date.UTC(2024, 2, 16, 14)
      )
      expect(parseTime('2026-08-21T01:00:00.000Z', 'iso-utc')).to.equal(
        Date.UTC(2026, 7, 21, 1)
      )
      expect(parseTime('1531479600000', 'epoch-ms')).to.equal(1531479600000)
    })

    it('maps a source file onto reports, joining vessel types from a second file', async () => {
      writeFileSync(
        path.join(dir, 'ais.csv'),
        'timestamp,vessel_id,lon,lat,speed\n1000,v1,23.6,37.9,5.5\n2000,v2,23.5,37.8,\n'
      )
      writeFileSync(
        path.join(dir, 'vessels.csv'),
        'vessel_id,country,shiptype\nv1,Greece,70.0\n'
      )
      const reports = []
      for await (const r of readAisReports(dir, {
        file: 'ais.csv',
        idColumn: 'vessel_id',
        timeColumn: 'timestamp',
        timeFormat: 'epoch-ms',
        latColumn: 'lat',
        lonColumn: 'lon',
        sogColumn: 'speed',
        vessels: {
          file: 'vessels.csv',
          idColumn: 'vessel_id',
          typeCodeColumn: 'shiptype'
        }
      })) {
        reports.push(r)
      }
      expect(reports).to.have.length(2)
      expect(reports[0]).to.deep.include({
        id: 'v1',
        timeMs: 1000,
        lat: 37.9,
        lon: 23.6,
        sogKn: 5.5
      })
      expect(reports[0].target.typeCode).to.equal(70)
      expect(reports[1].sogKn).to.equal(0)
      expect(reports[1].target.typeCode).to.equal(undefined)
    })
  })
})
