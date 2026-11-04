/**
 * The simulator's page in the Admin UI (Webapps, Signal K Simulator): the run, the boat's
 * systems, the targets in range and the faults on board, with the same controls as the
 * plugin's REST surface, which it uses, and the autopilot, which it drives through the
 * server's Autopilot API as any autopilot display would.
 *
 * It is an embedded webapp: the Admin UI loads this file as a module federation
 * container and renders its `./AppPanel` inside its own frame, so the page takes the Admin
 * UI's React and its Bootstrap styles rather than bringing its own. Written as a plain
 * script against the React the Admin UI puts on `window`, it needs no bundler: the
 * plugin's own `tsc` build is the whole build.
 */
type ReactModule = typeof import('react')
type El = import('react').ReactNode

interface Fault {
  id: string
  kind: string
  target: string
  title: string
  by: string
  phase: string
  course: string
  raisedMs: number
  clearsMs?: number
  clearedMs?: number
}

interface Available {
  kind: string
  title: string
  description: string
  targets: string[]
}

interface RunView {
  sample: string
  route: string
  boat: { name?: string; mmsi?: string; description: string }
  clock: {
    time?: string
    timeMultiplier: number
    paused: boolean
    departure: string
    arrival: string
    minutesIntoRoute?: number
    routeMinutes: number
  }
  position?: {
    latitude: number
    longitude: number
    sogKn: number
    cogDeg: number
    state: string
  }
  nextPoint?: { index: number; of: number; bridge?: { words: string } }
  deck?: {
    lights: string
    night: boolean
    chainM: number
    scope?: number
    windlass?: boolean
    trim: Record<string, number>
    stabilisers?: boolean
    radars: Record<string, boolean>
  }
  anchor?: {
    latitude: number
    longitude: number
    depthM: number
    maxRadiusM: number
    currentRadiusM: number
    watchRadiusM: number
  }
  depthM?: number
  systems?: {
    enginesRunning: number
    generatorsRunning: number
    sailing: boolean
    houseStateOfCharge?: number
    fuelL: number
    freshWaterLevel?: number
  }
  traffic: {
    shown: boolean
    inRange: number
    targets: {
      mmsi?: string
      name?: string
      distanceNm: number
      sogKn: number
      cogDeg?: number
      closestApproach?: { distanceM: number; timeToS: number }
    }[]
  }
  faults: Fault[]
  alarms: { path: string; state: string; message: string }[]
  water?: {
    currentKn: number
    currentSetDeg: number
    currentFrom: 'sample' | 'seeded'
    speedThroughWaterKn: number
    leewayDeg: number
  }
  sails?: {
    propulsion: 'sailing' | 'motor-sailing' | 'motoring' | null
    set: string[]
    activeAreaM2: number
    totalAreaM2: number
    polar?: { speedKn: number; ratio: number }
  }
  weather?: {
    windKn: number
    windDeg: number
    pressureHpa: number
    airC: number
    waterC: number
    humidity?: number
    tideM?: number
  }
  autopilot?: {
    state: string
    mode: string
    engaged: boolean
    modes: string[]
    target: { headingDeg?: number; awaDeg?: number; rudderDeg?: number }
    routeTargetDeg?: number
    onRoute: boolean
    rejoin?: { latitude: number; longitude: number; distanceM: number }
    behindRouteMinutes?: number
    refusal?: string
    alarms: { path: string; value: { state: string; message: string } }[]
  }
}

;(() => {
  const host = window as unknown as {
    __SK_REACT__: ReactModule
    signalk_simulator?: unknown
  }
  // the Admin UI puts its React on window as it starts, after this script has run, so
  // the page is built on it when the Admin UI first asks for it
  function panel(React: ReactModule): () => El {
    const h = React.createElement
    const API = '/plugins/signalk-simulator'
    const POLL_MS = 2000
    const MULTIPLIERS = [1, 2, 5, 10, 20, 24, 30, 60, 120, 300]
    const TARGETS_SHOWN = 15
    /** a time to the closest approach as minutes and seconds */
    const minSec = (s: number) =>
      `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

    async function call<T>(
      method: string,
      path: string,
      body?: unknown
    ): Promise<T> {
      // the server's own APIs by their full path, the plugin's under its own
      const res = await fetch(
        path.startsWith('/signalk/') ? path : API + path,
        {
          method,
          credentials: 'include',
          headers:
            body === undefined
              ? undefined
              : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        }
      )
      const json = await res.json()
      if (!res.ok)
        throw new Error(json?.error ?? json?.message ?? `${res.status}`)
      return json as T
    }

    const time = (iso?: string | number) =>
      iso === undefined
        ? ''
        : new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z'

    const card = (title: string, ...body: El[]) =>
      h(
        'div',
        { className: 'card mb-3' },
        h('div', { className: 'card-header' }, h('strong', null, title)),
        h('div', { className: 'card-body' }, ...body)
      )

    const facts = (rows: [string, El][]) =>
      h(
        'table',
        { className: 'table table-sm mb-0' },
        h(
          'tbody',
          null,
          ...rows
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) =>
              h(
                'tr',
                { key: k },
                h('th', { scope: 'row', style: { width: '40%' } }, k),
                h('td', null, v)
              )
            )
        )
      )

    function AppPanel(): El {
      const [run, setRun] = React.useState<RunView>()
      const [available, setAvailable] = React.useState<Available[]>([])
      const [error, setError] = React.useState<string>()
      const [kind, setKind] = React.useState('')
      const [target, setTarget] = React.useState('')
      const [minutes, setMinutes] = React.useState('')
      const [pilotTarget, setPilotTarget] = React.useState('')

      // what can be raised changes with what the boat is doing: a dragging anchor only
      // at anchor, so it is read again with the run
      const refresh = React.useCallback(() => {
        Promise.all([
          call<RunView>('GET', '/run'),
          call<{ available: Available[] }>('GET', '/faults')
        ])
          .then(([r, f]) => {
            setRun(r)
            setAvailable(f.available)
            setError(undefined)
          })
          .catch((e: Error) => setError(e.message))
      }, [])

      React.useEffect(() => {
        const chosen = available.find((a) => a.kind === kind)
        if (chosen && chosen.targets.includes(target)) return
        setKind(chosen?.kind ?? available[0]?.kind ?? '')
        setTarget((chosen ?? available[0])?.targets[0] ?? '')
      }, [available, kind, target])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const act = (method: string, path: string, body?: unknown) =>
        call(method, path, body)
          .then(refresh)
          .catch((e: Error) => setError(e.message))

      if (!run) {
        return h(
          'div',
          { className: 'card' },
          h('div', { className: 'card-body' }, error ?? 'Loading the run')
        )
      }
      const c = run.clock
      const chosen = available.find((a) => a.kind === kind)

      const clock = card(
        'Run',
        facts([
          [
            'Boat',
            `${run.boat.name ?? ''} ${run.boat.mmsi ? `(${run.boat.mmsi})` : ''}`.trim()
          ],
          ['Profile', run.boat.description],
          ['Sample', `${run.sample}: ${run.route}`],
          ['Scenario time', time(c.time)],
          [
            'Along the route',
            c.minutesIntoRoute === undefined
              ? undefined
              : `${c.minutesIntoRoute} of ${c.routeMinutes} minutes`
          ],
          [
            'Clock',
            h(
              'span',
              null,
              `x${c.timeMultiplier} `,
              c.paused
                ? h(
                    'span',
                    { className: 'badge bg-warning text-dark' },
                    'Paused'
                  )
                : h('span', { className: 'badge bg-success' }, 'Running')
            )
          ]
        ]),
        h(
          'div',
          { className: 'd-flex flex-wrap gap-2 align-items-center mt-3' },
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-primary',
              onClick: () => act('PUT', '/run', { paused: !c.paused })
            },
            c.paused ? 'Resume' : 'Pause'
          ),
          h(
            'select',
            {
              className: 'form-select form-select-sm w-auto',
              'aria-label': 'Time multiplier',
              value: String(c.timeMultiplier),
              onChange: (e: { target: { value: string } }) =>
                act('PUT', '/run', { timeMultiplier: Number(e.target.value) })
            },
            ...[...new Set([...MULTIPLIERS, c.timeMultiplier])]
              .sort((a, b) => a - b)
              .map((m) => h('option', { key: m, value: String(m) }, `x${m}`))
          ),
          h('input', {
            className: 'form-control form-control-sm',
            style: { width: '11rem' },
            type: 'number',
            min: 0,
            max: c.routeMinutes,
            placeholder: 'Minutes into route',
            'aria-label': 'Minutes into route',
            value: minutes,
            onChange: (e: { target: { value: string } }) =>
              setMinutes(e.target.value)
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-primary',
              disabled: minutes === '',
              onClick: () =>
                act('PUT', '/run', { minutesIntoRoute: Number(minutes) })
            },
            'Jump'
          )
        )
      )

      const p = run.position
      const where = card(
        'Where the Boat Is',
        facts([
          [
            'Position',
            p && `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`
          ],
          ['State', p?.state],
          ['Speed and course over ground', p && `${p.sogKn} kn, ${p.cogDeg}°`],
          [
            'Next route point',
            run.nextPoint && `${run.nextPoint.index} of ${run.nextPoint.of}`
          ],
          [
            'Anchor',
            run.anchor &&
              `${run.anchor.latitude.toFixed(5)}, ${run.anchor.longitude.toFixed(5)}, in ${run.anchor.depthM} m`
          ],
          [
            'From the anchor',
            run.anchor &&
              `${run.anchor.currentRadiusM} m, swinging in ${run.anchor.maxRadiusM} m, watch ${run.anchor.watchRadiusM} m`
          ],
          ['Depth', run.depthM === undefined ? undefined : `${run.depthM} m`],
          [
            'Wind',
            run.weather &&
              `${run.weather.windKn} kn from ${run.weather.windDeg}°`
          ],
          ['Pressure', run.weather && `${run.weather.pressureHpa} hPa`],
          [
            'Air and water',
            run.weather && `${run.weather.airC} °C, ${run.weather.waterC} °C`
          ],
          [
            'Humidity',
            run.weather?.humidity === undefined
              ? undefined
              : `${Math.round(run.weather.humidity * 100)} %`
          ],
          [
            'Tide',
            run.weather?.tideM === undefined
              ? undefined
              : `${run.weather.tideM} m above chart datum`
          ],
          [
            'Current',
            run.water &&
              `${run.water.currentKn} kn setting ${run.water.currentSetDeg}°${run.water.currentFrom === 'seeded' ? ' (seeded: the sample has none)' : ''}`
          ],
          [
            'Speed through the water',
            run.water && `${run.water.speedThroughWaterKn} kn`
          ],
          ['Leeway', run.water && `${run.water.leewayDeg}°`],
          [
            'Sails',
            run.sails &&
              [
                run.sails.propulsion === 'sailing'
                  ? 'under sail'
                  : run.sails.propulsion === 'motor-sailing'
                    ? 'motor-sailing'
                    : run.sails.propulsion === 'motoring'
                      ? 'motoring, sails down'
                      : 'sails stowed',
                run.sails.set.length
                  ? `${run.sails.set.join(', ')} (${run.sails.activeAreaM2} of ${run.sails.totalAreaM2} m²)`
                  : '',
                run.sails.polar
                  ? `polar ${run.sails.polar.speedKn} kn, ${Math.round(run.sails.polar.ratio * 100)} % of it`
                  : ''
              ]
                .filter(Boolean)
                .join('; ')
          ]
        ])
      )

      const s = run.systems
      const systems =
        s &&
        card(
          'Systems',
          facts([
            ['Engines running', s.enginesRunning],
            ['Generators running', s.generatorsRunning],
            ['Under sail', s.sailing ? 'yes' : 'no'],
            [
              'House bank',
              s.houseStateOfCharge === undefined
                ? undefined
                : `${Math.round(s.houseStateOfCharge * 100)} %`
            ],
            ['Fuel', `${s.fuelL} l`],
            [
              'Fresh water',
              s.freshWaterLevel === undefined
                ? undefined
                : `${Math.round(s.freshWaterLevel * 100)} %`
            ]
          ])
        )

      const d = run.deck
      const onOff = (on: boolean | undefined, yes: string, no: string) =>
        on === undefined ? undefined : on ? yes : no
      const trims = Object.entries(d?.trim ?? {})
      const radars = Object.entries(d?.radars ?? {})
      const deck =
        d &&
        card(
          'Deck',
          facts([
            [
              'Navigation lights',
              `${d.lights}${d.night ? ', sun down' : ', by day'}`
            ],
            [
              'Chain out',
              d.chainM > 0
                ? `${d.chainM} m${d.scope ? `, a scope of ${d.scope} to 1` : ''}`
                : d.windlass === undefined
                  ? undefined
                  : 'none, the anchor is up'
            ],
            ['Windlass', onOff(d.windlass, 'running', 'off')],
            [
              'Outboard trim',
              trims.length
                ? trims
                    .map(([, t]) =>
                      t >= 0.99 ? 'tilted up' : `${Math.round(t * 100)} % up`
                    )
                    .join(', ')
                : undefined
            ],
            ['Stabilisers', onOff(d.stabilisers, 'working', 'off')],
            [
              'Radars',
              radars.length
                ? radars
                    .map(
                      ([id, on]) => `${id} ${on ? 'transmitting' : 'standby'}`
                    )
                    .join(', ')
                : undefined
            ],
            ['Bridge', run.nextPoint?.bridge?.words]
          ])
        )

      const faults = card(
        'Faults',
        run.faults.length
          ? h(
              'table',
              { className: 'table table-sm' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ...['Fault', 'On', 'Raised', 'Clears', 'Course', ''].map(
                    (t) => h('th', { key: t }, t)
                  )
                )
              ),
              h(
                'tbody',
                null,
                ...run.faults.map((f) =>
                  h(
                    'tr',
                    { key: f.id },
                    h(
                      'td',
                      null,
                      f.title,
                      ' ',
                      h(
                        'span',
                        { className: 'badge bg-secondary' },
                        f.by === 'seed' ? 'seed' : 'by hand'
                      )
                    ),
                    h('td', null, f.target),
                    h('td', null, time(f.raisedMs)),
                    h(
                      'td',
                      null,
                      f.phase === 'clearing'
                        ? 'clearing'
                        : f.clearsMs
                          ? time(f.clearsMs)
                          : 'by hand'
                    ),
                    h('td', null, f.course),
                    h(
                      'td',
                      null,
                      f.phase === 'developing' &&
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'btn btn-sm btn-outline-danger',
                            onClick: () =>
                              act(
                                'DELETE',
                                `/faults/${encodeURIComponent(f.kind)}/${encodeURIComponent(f.target)}`
                              )
                          },
                          'Clear'
                        )
                    )
                  )
                )
              )
            )
          : h('p', null, 'None on board.'),
        h(
          'div',
          { className: 'd-flex flex-wrap gap-2 align-items-center' },
          h(
            'select',
            {
              className: 'form-select form-select-sm w-auto',
              'aria-label': 'Fault',
              value: kind,
              onChange: (e: { target: { value: string } }) => {
                setKind(e.target.value)
                setTarget(
                  available.find((a) => a.kind === e.target.value)
                    ?.targets[0] ?? ''
                )
              }
            },
            ...available.map((a) =>
              h('option', { key: a.kind, value: a.kind }, a.title)
            )
          ),
          h(
            'select',
            {
              className: 'form-select form-select-sm w-auto',
              'aria-label': 'On',
              value: target,
              onChange: (e: { target: { value: string } }) =>
                setTarget(e.target.value)
            },
            ...(chosen?.targets ?? []).map((t) =>
              h('option', { key: t, value: t }, t)
            )
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-warning',
              disabled: !kind,
              onClick: () => act('POST', '/faults', { kind, target })
            },
            'Raise'
          )
        ),
        chosen &&
          h(
            'p',
            { className: 'text-muted small mt-2 mb-0' },
            chosen.description
          )
      )

      const t = run.traffic
      const traffic = card(
        'Targets in Range',
        t.shown
          ? h(
              'div',
              null,
              h('p', null, `${t.inRange} heard`),
              t.targets.length > 0 &&
                h(
                  'table',
                  { className: 'table table-sm mb-0' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      ...[
                        'Name',
                        'MMSI',
                        'Distance',
                        'Speed',
                        'CPA',
                        'TCPA'
                      ].map((x) => h('th', { key: x }, x))
                    )
                  ),
                  h(
                    'tbody',
                    null,
                    ...t.targets
                      .slice(0, TARGETS_SHOWN)
                      .map((x, i) =>
                        h(
                          'tr',
                          { key: x.mmsi ?? i },
                          h('td', null, x.name ?? ''),
                          h('td', null, x.mmsi ?? ''),
                          h('td', null, `${x.distanceNm} nm`),
                          h('td', null, `${x.sogKn} kn`),
                          h(
                            'td',
                            null,
                            x.closestApproach
                              ? `${x.closestApproach.distanceM} m`
                              : ''
                          ),
                          h(
                            'td',
                            null,
                            x.closestApproach
                              ? minSec(x.closestApproach.timeToS)
                              : ''
                          )
                        )
                      )
                  )
                )
            )
          : 'Traffic is off in the plugin settings.'
      )

      // the autopilot, through the server's Autopilot API, as KIP and Freeboard drive it
      const AP = '/signalk/v2/api/vessels/self/autopilots/_default'
      const ap = run.autopilot
      const button = (
        label: string,
        method: string,
        path: string,
        body?: unknown,
        enabled = true
      ) =>
        h(
          'button',
          {
            key: label,
            type: 'button',
            className: 'btn btn-sm btn-outline-primary',
            disabled: !enabled,
            onClick: () => act(method, AP + path, body)
          },
          label
        )
      const deg = (x: number) =>
        String(Math.round(((x % 360) + 360) % 360)).padStart(3, '0')
      const pilotCard =
        ap &&
        card(
          'Autopilot',
          facts([
            ['State', ap.engaged ? `${ap.state}, engaged` : ap.state],
            ['Mode', ap.mode],
            [
              'Target',
              ap.target.headingDeg !== undefined
                ? `heading ${deg(ap.target.headingDeg)}°`
                : ap.target.awaDeg !== undefined
                  ? `apparent wind ${Math.abs(Math.round(ap.target.awaDeg))}° ${ap.target.awaDeg < 0 ? 'to port' : 'to starboard'}`
                  : ap.target.rudderDeg !== undefined
                    ? `rudder ${Math.abs(Math.round(ap.target.rudderDeg))}° ${ap.target.rudderDeg < 0 ? 'to port' : 'to starboard'}`
                    : ap.routeTargetDeg !== undefined
                      ? `the route, ${deg(ap.routeTargetDeg)}°`
                      : ''
            ],
            [
              'The route',
              ap.onRoute
                ? ap.behindRouteMinutes
                  ? `on it, ${ap.behindRouteMinutes} min behind its timing`
                  : 'on it'
                : ap.rejoin
                  ? `rejoining it ${(ap.rejoin.distanceM / 1852).toFixed(2)} nm ahead`
                  : 'off it'
            ],
            ['Cannot engage', ap.refusal],
            [
              'Alarms',
              ap.alarms
                .map((a) => `${a.value.message} (${a.value.state})`)
                .join(', ')
            ]
          ]),
          h(
            'div',
            { className: 'd-flex flex-wrap gap-2 mt-2' },
            button('Engage', 'POST', '/engage', undefined, !ap.refusal),
            button('Standby', 'POST', '/disengage'),
            ...ap.modes.map((m) =>
              button(
                m[0].toUpperCase() + m.slice(1),
                'PUT',
                '/mode',
                { value: m },
                m !== ap.mode
              )
            )
          ),
          h(
            'div',
            { className: 'd-flex flex-wrap gap-2 mt-2' },
            ...[-10, -1, 1, 10].map((d) =>
              button(
                `${d > 0 ? '+' : ''}${d}°`,
                'PUT',
                '/target/adjust',
                { value: d, units: 'deg' },
                ap.mode === 'compass' || ap.mode === 'wind'
              )
            ),
            h('input', {
              key: 'target',
              className: 'form-control form-control-sm w-auto',
              type: 'number',
              placeholder: 'target °',
              'aria-label': 'Target',
              value: pilotTarget,
              onChange: (e: { target: { value: string } }) =>
                setPilotTarget(e.target.value)
            }),
            button(
              'Set target',
              'PUT',
              '/target',
              { value: Number(pilotTarget), units: 'deg' },
              pilotTarget !== '' &&
                (ap.mode === 'compass' || ap.mode === 'wind')
            )
          ),
          h(
            'div',
            { className: 'd-flex flex-wrap gap-2 mt-2' },
            ...(ap.modes.includes('wind')
              ? [
                  button(
                    'Tack to port',
                    'POST',
                    '/tack/port',
                    undefined,
                    ap.mode === 'wind'
                  ),
                  button(
                    'Tack to starboard',
                    'POST',
                    '/tack/starboard',
                    undefined,
                    ap.mode === 'wind'
                  ),
                  button(
                    'Gybe to port',
                    'POST',
                    '/gybe/port',
                    undefined,
                    ap.mode === 'wind'
                  ),
                  button(
                    'Gybe to starboard',
                    'POST',
                    '/gybe/starboard',
                    undefined,
                    ap.mode === 'wind'
                  )
                ]
              : []),
            button(
              'Dodge 10° port',
              'PUT',
              '/dodge',
              { value: -10, units: 'deg' },
              ap.engaged
            ),
            button(
              'Dodge 10° starboard',
              'PUT',
              '/dodge',
              { value: 10, units: 'deg' },
              ap.engaged
            ),
            button(
              'End dodge',
              'DELETE',
              '/dodge',
              undefined,
              ap.mode === 'dodge'
            )
          )
        )

      return h(
        'div',
        { className: 'animated fadeIn' },
        error && h('div', { className: 'alert alert-danger' }, error),
        h(
          'div',
          { className: 'row' },
          h(
            'div',
            { className: 'col-lg-6' },
            clock,
            where,
            pilotCard,
            systems,
            deck
          ),
          h('div', { className: 'col-lg-6' }, faults, traffic)
        )
      )
    }

    return AppPanel
  }

  let built: (() => El) | undefined
  const appPanel = () => {
    built ??= panel(host.__SK_REACT__)
    return { default: built }
  }
  host.signalk_simulator = {
    init: () => undefined,
    get: (module: string) =>
      Promise.resolve(module === './AppPanel' ? appPanel : undefined)
  }
})()
