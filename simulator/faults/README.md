# Faults

Things that go wrong on a real boat, which a display, an alarm plugin or a crew should see.
Each fault comes on, develops at the rate it would, and clears when it would clear (a crew
clearing a blocked intake, a receiver regaining its fix) or when cleared by hand. The paths
carry the fault the way a real sensor would: the value goes wrong, not a label. Where the
boat's own alarm panel would sound, the plugin raises the specification's notification for
that path, `notifications.<path>`, with its state and method, and sends it again as
`normal` when it clears, so the server's notification manager, an alarm plugin and the
Admin UI see it come and go. A value that goes out of its [zones](#alarms) is judged by the
boat's alarm panel from those zones, as on a normal day; a fault raises only what no zone
can know.

Faults are raised and cleared by hand through the plugin's
[REST surface or its page](../plugin/README.md#controlling-the-run), or thrown by the seed
at a rate you set (none by default). They need the boat's systems, so a route without a
vessel profile has none.

## The Faults

The target is what a fault happens to. Unless given one, a fault is raised on the first
target the boat has. Durations are scenario time; where a fault clears on its own, the seed
picks its length within the range when it is raised.

| Fault                                             | Target                                   | Clears on Its Own                                       | Notifications                                                                                |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`engineOverheat`](#engine-overheating)           | a main engine with a combustion engine   | after 20 to 40 minutes, then cools                      | `propulsion.<id>.coolantTemperature` warn, then alarm; `propulsion.<id>.oilPressure` alarm   |
| [`generatorNoStart`](#generator-fails-to-start)   | a generator                              | after 30 to 60 minutes                                  | `propulsion.<id>.state` alarm, once a start has failed                                       |
| [`batteryCellFailure`](#battery-cell-failing)     | a battery bank                           | no                                                      | `electrical.batteries.<id>.voltage` warn, then alarm                                         |
| [`chargerFailure`](#charger-drops-out)            | a house or propulsion bank's charger     | after 20 to 45 minutes                                  | `electrical.chargers.<bank>.chargingMode` warn, while it should be charging                  |
| [`alternatorFailure`](#alternator-drops-out)      | a main engine's alternator               | no                                                      | `propulsion.<id>.alternatorVoltage` warn, while the engine runs                              |
| [`bilgeFlooding`](#bilge-flooding)                | `bilge`                                  | the leak is stopped after 15 to 30 minutes, then pumped | `electrical.switches.bilgeHighWater.state` alarm; `electrical.switches.bilgePump.state` warn |
| [`fuelGaugeStuck`](#fuel-gauge-stuck)             | a fuel tank                              | no                                                      | none                                                                                         |
| [`depthSounderSilent`](#depth-sounder-silent)     | a depth sounder                          | after 5 to 15 minutes                                   | `environment.depth.belowTransducer` warn, when no sounder is sending                         |
| [`gnssLost`](#gnss-fix-lost)                      | `gnss`                                   | after 2 to 8 minutes, then reacquires                   | `navigation.position` alarm, until the fix is back                                           |
| [`windInstrumentFrozen`](#wind-instrument-frozen) | `wind`, on a boat with a wind instrument | no                                                      | none                                                                                         |
| [`staleSensor`](#stale-sensor-value)              | a path (see below)                       | after 10 to 20 minutes                                  | none                                                                                         |

A **warn** goes out with method `["visual"]`, an **alarm** with `["visual", "sound"]`, and
a cleared notification as `normal` with no method, keeping its message. Faults with no
notification are those a panel cannot notice: a stuck gauge, a frozen instrument and a
stale value all keep sending believable numbers, which is the point of testing them.

## Alarms

The alarms on the coolant, the oil pressure and a bank's voltage come from those values'
zones, the same zones the boat sends in its metadata and a display colours its gauges by
(see [the vessels README](../vessels/README.md#alarms)): the boat's alarm panel raises
them whenever a value is in a zone, fault or no fault, and holds each until the value is
back out of its zone by the zone's margin (2 °C, 0.3 bar, 0.2 V per 12 V). A profile that
gives its own zones for a path moves that alarm with them. The thresholds below are the
defaults.

The rest a fault raises itself, since no zone can know them: a generator that would not
start, a charger tripped, an alternator not charging, the bilge, a silent sounder and a
lost fix. A silent sounder never raises the shallow water alarm: no depth is not shallow
depth, and a shallow alarm already raised clears once the sounder has been quiet for a few
seconds.

### Engine Overheating

A blocked raw-water intake (weed, a plastic bag). While the engine runs, its coolant keeps
0.1 °C a second of heat it would have shed, against its normal cooling, so it climbs about
6 °C a minute at first and settles near 120 °C if run on. Above 100 °C the oil thins and
its pressure falls, by up to 85 % at 120 °C. A stopped engine does not heat.

- **Paths:** `propulsion.<id>.coolantTemperature`, `oilTemperature` follows the engine's
  load as before, `oilPressure` falls.
- **Notifications:** from the zones: `notifications.propulsion.<id>.coolantTemperature`
  warn at 95 °C ("coolant temperature high") and alarm at 100 °C ("overheating");
  `notifications.propulsion.<id>.oilPressure` alarm below 1 bar while the engine runs.
- **Clears:** when the crew clears the intake, the coolant cools back towards its running
  temperature over a few minutes; the alarms step down and go to `normal` as it passes
  back out of each zone by the margin (the alarm to a warning below 98 °C, `normal` below
  93 °C), and the fault is gone below 90 °C.

### Generator Fails to Start

The next time the generator is wanted, it cranks and does not start: its state stays
`stopped`, and the AC load or the bank it would have carried or charged is not. A
generator already running is not stopped by it.

- **Paths:** `propulsion.<id>.state` stays `stopped`; its AC output stays dead; the bank it
  charges goes on discharging.
- **Notifications:** `notifications.propulsion.<id>.state` alarm, "failed to start", from
  the first start asked of it.
- **Clears:** the generator starts the next time it is wanted, and the alarm clears.

### Battery Cell Failing

A cell in the bank fails over an hour. As it goes, the bank loses that cell's voltage
(2.1 V for lead-acid, 3.3 V for lithium iron phosphate), half its capacity and most of its
ability to carry current (its resistance rises to five times), so its state of charge falls
faster than its load accounts for (two and a half times as fast at anchor overnight), and
its voltage sags under load. A charger or alternator holds the voltage at its set point
while it charges, so the sag shows when the bank discharges.

- **Paths:** `electrical.batteries.<id>.voltage`, `current`, `capacity.stateOfCharge`,
  `capacity.timeRemaining`.
- **Notifications:** from the zones: `notifications.electrical.batteries.<id>.voltage` warn
  ("voltage low") and alarm ("voltage very low") below the bank's bands: for lead-acid
  11.8 V and 11.0 V, for lithium 12.0 V and 11.6 V, per 12 V of the bank's nominal voltage.
  As the bank runs down faster, its state of charge raises its own "charge low" in time.
- **Clears:** by hand only, as replacing the cell; the bank is whole again at once. While a
  cell is failing, the bank's energy books (which the systems soak checks) do not balance,
  because the bank holds less than its profile says.

### Charger Drops Out

A bank's AC charger trips. Whenever it should be charging (on shore power, or with a
generator running that charges the bank) it gives nothing, and the bank discharges.

- **Paths:** `electrical.chargers.<bank>.current` is 0 and `chargingMode` is `other`: the
  specification has no fault state for a charger, and `other` is the one it gives for a
  state that is none of the others.
- **Notifications:** `notifications.electrical.chargers.<bank>.chargingMode` warn, "charger
  not charging".
- **Clears:** when it is reset; it charges again at once.

### Alternator Drops Out

An engine's alternator stops charging, as with a broken belt. The engine runs on; the bank
its alternator charged (the start bank, or the house bank where there is none) is not
charged by it.

- **Paths:** the bank's `current` and `stateOfCharge`; `propulsion.<id>.alternatorVoltage`
  reads the bank's voltage, no longer lifted by charging.
- **Notifications:** `notifications.propulsion.<id>.alternatorVoltage` warn, "alternator
  not charging", while the engine runs, as a charge warning light shows.
- **Clears:** by hand only, as fitting a new belt.

### Bilge Flooding

Water coming in faster than the bilge pump clears it, as from a failed hose or stern gland.
The bilge sump holds about 2 × L^1.5 litres for a boat of L metres (179 l at 20 m), and the
pump moves 1,000 + 150 × L litres an hour (4,000 l/h at 20 m), drawing 0.05 W per litre an
hour from the house bank (200 W at 20 m). The leak builds over five minutes to 1.3 times
what the pump can move, so the pump runs and the water rises. Its float switch starts the
pump at 30 % of the sump and stops it at 5 %; a high water switch closes at 80 %.

- **Paths:** the specification has no bilge, so the bilge goes out as the switches a
  switch bank reports, 1 closed and 0 open: `electrical.switches.bilgePump.state` and
  `electrical.switches.bilgeHighWater.state`. They are sent while the bilge has a fault or
  water to clear, and once more as they open. The pump's draw shows in the house bank's
  `current`. These paths are not in the Signal K schema, so a strict validator reports them.
- **Notifications:** `notifications.electrical.switches.bilgeHighWater.state` alarm, "Bilge
  high water"; `notifications.electrical.switches.bilgePump.state` warn, "Bilge pump running
  continuously", once it has run two minutes without stopping.
- **Clears:** when the leak is found and stopped, the pump clears the water; the
  notifications clear as the switches open, and the fault is gone when the pump stops.

### Fuel Gauge Stuck

A fuel tank's sender sticks: `tanks.fuel.<id>.currentLevel` and `currentVolume` keep the
values they had while the engines and generators go on using the fuel. No notification,
since nothing on board can tell. Clears by hand only, when the gauge reads true again.

### Depth Sounder Silent

A depth sounder stops sending (aeration in a following sea, a loose transducer lead), and
comes back. Its updates, which carry its own source, simply stop; another sounder on the
boat goes on.

- **Paths:** `environment.depth.*` from that sounder's source.
- **Notifications:** `notifications.environment.depth.belowTransducer` warn, "No depth:
  sounder not sending", only when no sounder on the boat is sending, as a display with
  another sounder still has depth. Never the shallow water alarm (see [Alarms](#alarms)).
- **Clears:** it sends again.

### GNSS Fix Lost

The receiver loses its fix. Position, speed and course over ground, `navigation.datetime`
and the dilutions stop, as a receiver without a fix stops sending them; the server keeps
the last position it had, with its old timestamp. `gnss.methodQuality` goes to `no GPS` and
`gnss.satellites` to 2, the satellites still tracked. Heading, speed through the water and
everything else carry on.

- **Notifications:** `notifications.navigation.position` alarm, "GNSS fix lost".
- **Clears:** reacquiring takes a minute. For 20 seconds the receiver tracks more satellites
  (3, then 4) with no fix yet; at 20 seconds it fixes on 4, position and the rest come back
  with `GNSS Fix`, and the alarm goes to `normal`; over the next 40 seconds the satellites
  come in one at a time to the receiver's usual count, the dilution falling with them.

### Wind Instrument Frozen

The masthead unit stops turning: `environment.wind.*` keep the values they had, sent on
time as before. No notification. Clears by hand only.

### Stale Sensor Value

A gateway keeps sending a sensor value from its cache: the value read when the fault came
on, in an update of its own carrying the time it was read, every time the path is sent. A
plugin that checks the age of what it reads sees an old value; one that does not, a
plausible one. The targets are `environment.outside.temperature`,
`environment.outside.pressure`, `environment.water.temperature`, each bank's
`electrical.batteries.<id>.voltage` and each combustion engine's
`propulsion.<id>.coolantTemperature`. No notification.

## Raising and Clearing

By REST (full reference in the [plugin README](../plugin/README.md#controlling-the-run)):

```shell
SIM=http://localhost:3000/plugins/signalk-simulator
curl $SIM/faults                                   # what this boat can have, and what is on
curl -X POST $SIM/faults -H 'Content-Type: application/json' \
  -d '{"kind":"engineOverheat","target":"port"}'   # raise one
curl -X DELETE $SIM/faults/engineOverheat/port     # clear it by hand
```

Or on the plugin's page in the Admin UI (Webapps, Signal K Simulator), which lists the
faults on board with their course and has **Raise** and **Clear** buttons. A fault cleared
by hand winds down as it would (an engine still has to cool); while it does, it shows as
`clearing` and cannot be raised again. One already developing cannot be raised twice.

## From the Seed

The plugin setting **Faults a day** (`faultsPerDay`, default 0) has the seed throw faults
on its own: on average that many per day of scenario time, at random intervals, each a
random fault on a random target not already faulty. The same seed, start and setting throw
the same faults at the same scenario times, at any time multiplier. Faults raised by hand
come on top.

## Persistence and Time

Faults are saved with the run every ten seconds and resume with it, mid-course: a fault
developing carries on developing, one winding down carries on winding down, and after a
restart every notification still raised is sent again, for a server that no longer has it
(the alarm panel saves what it has raised alongside the faults).
A fault's course runs in the systems model's own two-second steps of scenario time, so it
tells the same story at any time multiplier. Jumping forward along the route runs every
fault through to the new time, as if the boat had sailed it; jumping back starts the
systems afresh at the earlier time, and the faults with them.

## Tests

`test/simulator-faults.ts`, in `npm test`, raises every fault on a boat that has its target
and checks its course, its paths and its notifications, the run resuming mid-fault, the
seed's faults and that everything sent validates against the Signal K schema (the bilge
switches aside). `test/simulator-control.ts` checks the REST surface.
