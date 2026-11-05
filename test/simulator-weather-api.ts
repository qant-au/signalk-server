import { expect } from 'chai'
import path from 'path'
import { Environment, loadEnvironment } from '../simulator/weather/environment'
import { SampleWeather, STRONG_WIND_KN } from '../simulator/weather/provider'
import { Station } from '../simulator/weather/sources'
import { localDayStart, sunTimes } from '../simulator/systems/sun'

const SAMPLES = path.join(__dirname, '..', 'simulator', 'samples')
const HOUR = 3600_000
const KN = 1852 / 3600
const RAD = Math.PI / 180

const SAMPLE_CASES = [
  {
    id: 'miami-icw-2024-03-16',
    at: { latitude: 25.77, longitude: -80.18 },
    nowMs: Date.parse('2024-03-16T14:23:30Z')
  },
  {
    id: 'saronic-gulf-2018-07-13',
    at: { latitude: 37.85, longitude: 23.6 },
    nowMs: Date.parse('2018-07-13T09:41:00Z')
  },
  {
    id: 'manly-hamilton-island-2026-08-21',
    at: { latitude: -24.5, longitude: 152.9 },
    nowMs: Date.parse('2026-08-21T06:10:00Z')
  }
]

const ms = (iso: string) => Date.parse(iso)

describe('Simulator Weather API', () => {
  for (const c of SAMPLE_CASES) {
    describe(c.id, () => {
      const env = loadEnvironment(path.join(SAMPLES, c.id))!
      const span = env.span()!
      const w = new SampleWeather(env, () => c.nowMs, c.id)

      it('observes at the scenario time and on each hour before it, newest first, as the records have it', () => {
        const obs = w.getObservations(c.at)
        expect(obs[0].date).to.equal(new Date(c.nowMs).toISOString())
        expect(obs[1].date).to.equal(
          new Date(Math.floor(c.nowMs / HOUR) * HOUR).toISOString()
        )
        for (let i = 2; i < obs.length; i++) {
          expect(ms(obs[i - 1].date) - ms(obs[i].date)).to.equal(HOUR)
        }
        expect(obs.every((o) => o.type === 'observation')).to.equal(true)
        expect(ms(obs.at(-1)!.date)).to.be.at.least(span.startMs)
        // what the sample has at that place and time, in SI
        const at = env.at(c.at.latitude, c.at.longitude, c.nowMs)
        expect(obs[0].outside!.temperature).to.be.closeTo(
          at.airC! + 273.15,
          0.01
        )
        expect(obs[0].outside!.pressure).to.be.closeTo(at.pressurePa!, 1)
        expect(obs[0].wind!.speedTrue).to.be.closeTo(at.windKn! * KN, 0.01)
        expect(obs[0].wind!.directionTrue).to.be.closeTo(
          at.windDeg! * RAD,
          0.001
        )
      })

      it('honours maxCount and startDate on observations', () => {
        expect(w.getObservations(c.at, { maxCount: 3 })).to.have.length(3)
        const day = new Date(c.nowMs).toISOString().slice(0, 10)
        const today = w.getObservations(c.at, { startDate: day })
        expect(today.every((o) => o.date.slice(0, 10) === day)).to.equal(true)
        expect(today.at(-1)!.date).to.equal(
          new Date(Math.max(span.startMs, ms(`${day}T00:00:00Z`))).toISOString()
        )
      })

      it('forecasts on each hour ahead to the end of the records, oldest first', () => {
        const points = w.getForecasts(c.at, 'point')
        expect(ms(points[0].date)).to.equal(
          Math.floor(c.nowMs / HOUR) * HOUR + HOUR
        )
        for (let i = 1; i < points.length; i++) {
          expect(ms(points[i].date) - ms(points[i - 1].date)).to.equal(HOUR)
        }
        expect(ms(points.at(-1)!.date)).to.be.at.most(span.endMs)
        expect(span.endMs - ms(points.at(-1)!.date)).to.be.below(HOUR)
        expect(points.every((p) => p.type === 'point')).to.equal(true)
        expect(w.getForecasts(c.at, 'point', { maxCount: 4 })).to.have.length(4)
        // a later start date starts there
        const tomorrow = new Date(c.nowMs + 86400_000)
          .toISOString()
          .slice(0, 10)
        const later = w.getForecasts(c.at, 'point', { startDate: tomorrow })
        expect(later[0].date).to.equal(`${tomorrow}T00:00:00.000Z`)
      })

      it('forecasts a day at a time, one a local day, with its lowest and highest temperature, its wind and the sun', () => {
        const days = w.getForecasts(c.at, 'daily')
        expect(days[0].date).to.equal(
          new Date(localDayStart(c.nowMs, c.at.longitude)).toISOString()
        )
        for (let i = 1; i < days.length; i++) {
          expect(ms(days[i].date) - ms(days[i - 1].date)).to.equal(24 * HOUR)
        }
        expect(ms(days.at(-1)!.date)).to.be.at.most(span.endMs)
        for (const d of days) {
          expect(d.type).to.equal('daily')
          expect(d.outside!.minTemperature).to.be.at.most(
            d.outside!.maxTemperature!
          )
          expect(d.wind!.speedTrue).to.be.a('number')
          expect(ms(d.sun!.sunrise!)).to.be.below(ms(d.sun!.sunset!))
        }
        expect(w.getForecasts(c.at, 'daily', { maxCount: 1 })).to.have.length(1)
      })

      it('warns of nothing where the record never has the wind at 22 knots for an hour', () => {
        expect(w.getWarnings(c.at)).to.deep.equal([])
      })

      it('answers a position far outside the sample as the instruments read it there: from the stations it has', () => {
        const far = {
          latitude: c.at.latitude + 10,
          longitude: c.at.longitude + 10
        }
        const obs = w.getObservations(far, { maxCount: 1 })[0]
        const at = env.at(far.latitude, far.longitude, c.nowMs)
        expect(obs.outside!.temperature).to.be.closeTo(at.airC! + 273.15, 0.01)
        expect(obs.wind!.speedTrue).to.be.closeTo(at.windKn! * KN, 0.01)
      })

      it('observes nothing before the records begin, and forecasts nothing past their end', () => {
        const before = new SampleWeather(env, () => span.startMs - HOUR, c.id)
        expect(before.getObservations(c.at)).to.deep.equal([])
        const after = new SampleWeather(env, () => span.endMs + 1, c.id)
        expect(after.getForecasts(c.at, 'point')).to.deep.equal([])
        expect(after.getForecasts(c.at, 'daily')).to.deep.equal([])
      })
    })
  }

  it('gives sunrise and sunset as the almanac has them', () => {
    // Miami, 16 March 2024: sunrise 07:20, sunset 19:22 EDT
    const day = localDayStart(Date.parse('2024-03-16T12:00:00Z'), -80.19)
    const { sunriseMs, sunsetMs } = sunTimes(day, 25.77, -80.19)
    expect(
      Math.abs(sunriseMs! - Date.parse('2024-03-16T11:20:00Z'))
    ).to.be.below(3 * 60_000)
    expect(
      Math.abs(sunsetMs! - Date.parse('2024-03-16T23:22:00Z'))
    ).to.be.below(3 * 60_000)
  })

  it('warns of strong wind where the record ahead has it at 22 knots or more for an hour or more, and not for less', () => {
    const t0 = Date.parse('2024-03-16T00:00:00Z')
    // from the north: 10 kn, then 25 to 28 kn for 90 minutes, 10, then 30 kn for 40 minutes
    const knots = [10, 10, 25, 28, 26, 25, 10, 10, 30, 30, 10, 10]
    const times = knots.map((_, i) => t0 + i * 30 * 60_000)
    const station: Station = {
      id: 's',
      name: 's',
      lat: 25,
      lon: -80,
      series: {
        windE: { ms: times, v: knots.map(() => 0) },
        windN: { ms: times, v: knots }
      }
    }
    const env = new Environment([station])
    const w = new SampleWeather(env, () => t0, 'a-sample')
    const warnings = w.getWarnings({ latitude: 25, longitude: -80 })
    expect(warnings).to.have.length(1)
    const [warning] = warnings
    expect(warning.source).to.equal('a-sample')
    expect(warning.type).to.equal('Warning')
    // looked at every ten minutes: 25 kn at the hour, 20 kn at 2 h 40 as it drops back
    expect(ms(warning.startTime)).to.equal(t0 + 60 * 60_000)
    expect(ms(warning.endTime)).to.equal(t0 + 150 * 60_000)
    expect(warning.details).to.match(/22 kn or more, up to 28 kn/)
    expect(STRONG_WIND_KN).to.equal(22)
    // once she is past the first, the second is too short
    const later = new SampleWeather(env, () => t0 + 3.5 * HOUR, 'a-sample')
    expect(later.getWarnings({ latitude: 25, longitude: -80 })).to.deep.equal(
      []
    )
  })

  it('answers nothing for a sample without weather', () => {
    const w = new SampleWeather(undefined, () => 0, 'none')
    const at = { latitude: 0, longitude: 0 }
    expect(w.getObservations(at)).to.deep.equal([])
    expect(w.getForecasts(at, 'point')).to.deep.equal([])
    expect(w.getWarnings(at)).to.deep.equal([])
    expect(w.forecastToMs).to.equal(undefined)
  })
})
