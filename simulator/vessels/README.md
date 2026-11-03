# Vessel Profiles and Boat Systems

A vessel profile says what is on board: engines, generators, batteries, chargers, tanks,
depth sounders, radars, wind instruments and the spaces inside. The systems model
(`simulator/systems`) runs every one of them alongside the route, so the own boat sends the
data a large, busy boat sends, not just its position and depth.

Each profile is one JSON file here, read by `profile.ts`. A sample's `route.json` names the
profile it sails:

```json
"vessel": { "description": "20 m motor yacht", "profile": "motor-yacht-20m" }
```

The profile then supplies the boat's length, draft and AIS ship type. A route without a
profile still gives `lengthM`, `draftM` and `typeCode` itself, as before, and sails without
systems.

## The Profiles

| Profile                 | Boat                                                                     | Engines                                                                                                                     | Generators | Banks                                      | Charging                                                                                                               | Tanks (fuel, fresh, grey, black) | Sounders | Radars | Inside zones | Used by                         |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------- | ------ | ------------ | ------------------------------- |
| `motor-yacht-45m`       | 45 m motor yacht, 2.6 m draft, 380 t                                     | 2 diesel, 1500 kW each; bow and stern thrusters, hydraulic, 71 kW each                                                      | 2 × 99 kW  | house 24 V 2000 Ah, start 24 V 400 Ah      | 2 solar arrays                                                                                                         | 4 + 2 day tanks, 2, 2, 2         | 2        | 2      | 13           |                                 |
| `motor-yacht-34m`       | 34 m motor yacht, 2.1 m draft                                            | 2 diesel (from length); bow and stern thrusters, hydraulic, 40.5 kW each (from length)                                      | 2 × 65 kW  | house and start (from length)              |                                                                                                                        | 4, 2, 2, 2                       | 2        | 2      | 5            |                                 |
| `motor-yacht-20m`       | 20 m motor yacht, 1.5 m draft, 60 Hz 120 V                               | 2 diesel, 735 kW each; bow and stern thrusters, electric, 14 kW each (from length)                                          | 1 × 22 kW  | house and start (from length)              |                                                                                                                        | 4, 2, 1, 1                       | 1        | 1      | 5            | Miami ICW                       |
| `sailing-yacht-15m`     | 15 m sailing yacht, 2.2 m draft                                          | 1 diesel, 80 kW; bow thruster, electric, 8 kW (from length)                                                                 | 1 × 6 kW   | house 12 V 600 Ah, start 12 V 100 Ah       | 400 W wind turbine                                                                                                     | 2, 2, 1, 1                       | 1        | 1      | 5            | Saronic Gulf                    |
| `motor-sailer-15m`      | 15 m motor-sailer, 1.8 m draft                                           | 1 diesel, 110 kW (150 HP); bow thruster, electric, 8 kW (from length)                                                       | 1 × 8 kW   | house and start (from length)              | 800 W solar                                                                                                            | 2 × 900 l, 2, 1, 1               | 1        | 1      | 5            | Manly to Hamilton Island        |
| `yacht-12m`             | 12 m motor yacht, everything from length                                 | 2 diesel; bow thruster, electric, 5 kW (from length)                                                                        | 1          | house and start                            |                                                                                                                        | 2, 1, 1, 1                       | 1        | 1      | 5            |                                 |
| `sailing-yacht-9m`      | 9 m sailing yacht, 1.6 m draft                                           | 1 diesel, 15 kW                                                                                                             | none       | house and start (from length)              |                                                                                                                        | 1, 1, 0, 1                       | 1        | 1      | 3            |                                 |
| `electric-launch-7m`    | 7 m electric launch                                                      | 1 electric motor, 10 kW                                                                                                     | none       | propulsion 48 V 400 Ah                     |                                                                                                                        | none                             | 1        | 0      | 0            |                                 |
| `boat-4m`               | 4 m boat                                                                 | 1 petrol outboard, 15 kW                                                                                                    | none       | 12 V 50 Ah                                 |                                                                                                                        | 1 × 25 l, no water tanks         | 1        | 0      | 0            |                                 |
| `hybrid-catamaran-60ft` | 60 ft hybrid solar catamaran, modelled on the Xquisite Sixty Solar Power | 2 hybrid: 261 kW (350 HP) diesel + 130 kW inline electric drive each; no thrusters: it berths on its two engines, far apart | 1 × 180 kW | propulsion 400 V 350 Ah, house 24 V 800 Ah | 8 kW solar (2 × 4 kW) on the propulsion bank; hotel 2 kW; electric to 7 kn, diesels in below 30 %, electric above 80 % | 2 × 1700 l, 2 × 500 l, 1, 1      | 2        | 1      | 5            | Manly to Hamilton Island (soak) |

The hybrid catamaran's length (18.5 m), beam (8.1 m), draft (1.2 m), light displacement
(about 38 t), engines, generator, solar (8 kW), fuel (3,400 l) and fresh water (1,000 l)
follow the Xquisite Sixty Solar Power. Its propulsion bank (400 V, 350 Ah, about 140 kWh)
and house bank are **assumptions**: the builder's published figures do not give them, and
so are its 2 kW hotel load and its passage rules, set to read the way the builder describes
the boat running: on its motors in harbour, on its diesels at passage speed, and on its sun
at anchor.

## Identity

The plugin tells the server who the boat is and how big, so Freeboard, the AIS plugins
and anything drawing the boat can name and size it. The name and MMSI come from the
sample's `route.json`; the dimensions from the profile.

| Path                                 | From                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `name`, `mmsi`                       | the route's `vessel.name` and `vessel.mmsi`                                                                              |
| `design.length.overall`              | `lengthM`                                                                                                                |
| `design.beam`                        | `beamM`                                                                                                                  |
| `design.draft.current`, `.maximum`   | `draftM`, and `maxDraftM` where the profile gives one (a lifting keel or centreboard); no default                        |
| `design.airHeight`                   | `airHeightM`; from length unless given: 1.45 × L + 1 m for a sailing yacht's masthead, 0.22 × L + 1.5 m for a motor boat |
| `design.displacement`                | `displacementT`, in kg                                                                                                   |
| `design.aisShipType`                 | `typeCode`, with the specification's name for it                                                                         |
| `sensors.ais.fromBow`, `.fromCenter` | `aisAntenna`; from length unless given: 55 % of the length aft of the bow, on the centreline                             |
| `sensors.ais.class`                  | `aisClass`; from length unless given: A from 24 m, as larger yachts carry, B below                                       |

**The server's own settings win.** Before sending, the plugin reads what the owner has
already said about the boat: the server's base deltas, which is where the Admin UI's vessel
page (Server, Settings, Vessel) keeps the name, MMSI and dimensions, and a name or MMSI in
a `vessel` block of settings.json. Anything given there is left alone, and the status line
says what the plugin set or sent and what it left. Someone running the simulator beside
their own boat's configuration never finds their boat renamed or resized. This server has
not read settings.json's `vessel` block itself since November 2020 (it reads only the base
deltas), so a name there shows nowhere; the plugin still treats it as the owner's word.

**How the values get there.** The server keeps six of these fields for its own vessel
settings: the name, MMSI, `design.length`, `design.beam`, `design.draft` and
`design.aisShipType`. Its self-data filter (`src/staticDataFilter.ts`) drops them from any
delta that does not come from those settings, so no plugin can send them as itself. The
plugin therefore puts them into the server's vessel settings in memory, for each one the
owner has not set, and sends them as the server sends its own, with the source `defaults`.
It never saves them, and takes them back when it stops or changes sample (where they are
still what it put there). The rest, `design.airHeight`, `design.displacement` and the AIS
antenna position, it sends as itself, with the source `simulator` and metadata naming each.
All of it goes once at every start, so changing the sample replaces it. One thing to know:
while the simulator runs, the Admin UI's vessel page shows the values it set, and saving
that page then keeps them as the owner's.

**One vessel everywhere.** The AIS traffic drops any report under the boat's own MMSI, so
the own boat never appears as a target of itself, and the rig soak and the systems soak send
and validate under the same identity.

## Counts and Defaults

A profile file needs only `id`, `name` and `lengthM`. Anything it leaves out is filled in
from the length, and anything it gives is used as it is:

| What                   | Default                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engines                | two diesels from 10 m (port and starboard), one below; total power about 0.9 × L² kW                                                                                                                                                   |
| Thrusters              | none under 12 m; a bow thruster from 12 m, a stern thruster too from 18 m; electric on the house bank below 30 m, hydraulic off the first main engine from 30 m; about 0.035 × L² kW each (5 kW at 12 m, 14 kW at 20 m, 71 kW at 45 m) |
| Generators             | one from 10 m, none below                                                                                                                                                                                                              |
| Banks                  | house and start; 12 V under 12 m, 24 V from 12 m; house about 10 × L^1.5 Ah                                                                                                                                                            |
| Fuel tanks             | 1 under 10 m, 2 under 20 m, 4 from 20 m                                                                                                                                                                                                |
| Fresh water tanks      | none under 6 m, 1 under 15 m, 2 from 15 m                                                                                                                                                                                              |
| Grey and black tanks   | grey from 10 m, black from 8 m; 1 each under 25 m, 2 each from 25 m                                                                                                                                                                    |
| Tank capacities        | totals by length: fuel about 0.019 × L^3.93 l, fresh water 0.28 × L^2.86 l, grey a quarter of the fresh water (at least 40 l), black 0.15 of it (at least 45 l), shared between the tanks                                              |
| Water maker            | from 12 m, 5 l an hour per metre of length (75 l/h at 15 m, 225 l/h at 45 m)                                                                                                                                                           |
| Hotel load (`hotelKw`) | 0.012 × L^2.2 kW through the waking day, fitted to 7 kW at 18 m and 50 kW at 45 m on motor yachts with air conditioning                                                                                                                |
| Hybrid rules           | see [Hybrid Rules](#hybrid-rules), for a profile with a hybrid drive                                                                                                                                                                   |
| Sounders               | one, on the centreline, 80% of the draft below the waterline and at most 0.5 m                                                                                                                                                         |
| Radars                 | none under 9 m, one under 25 m, an X-band and an S-band from 25 m                                                                                                                                                                      |
| Wind instrument        | from 7 m                                                                                                                                                                                                                               |
| Inside zones           | saloon and fridge from 6 m; a cabin from 9 m; engine room and freezer from 12 m                                                                                                                                                        |
| Air height             | 1.45 × L + 1 m under sail, 0.22 × L + 1.5 m under power                                                                                                                                                                                |
| AIS antenna            | 55 % of the length aft of the bow, on the centreline                                                                                                                                                                                   |
| AIS class              | A from 24 m, B below                                                                                                                                                                                                                   |

**The most a profile can have** is 8 fuel tanks, 4 fresh water tanks, 2 grey and 2 black.
These are limits, not defaults: a profile with more is refused when it loads.

## Hybrid Rules

A profile with a hybrid drive carries its passage rules in a `hybrid` block. Each figure
can be left out, and gets the default shown:

| Field                      | What it does                                                                                                                                                     | Default                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `electricBelowKn`          | at or below this speed over the ground the drives run on their electric motors alone, the diesels stopped                                                        | the speed at which the propeller takes a fifth of the motors' rating (the propeller law), to the nearest half knot |
| `dieselBelowSoc`           | below this state of charge of the propulsion bank the diesels take over at any speed and charge the bank, and a generator charging that bank starts              | 0.4                                                                                                                |
| `electricAboveSoc`         | the diesels hand back to the motors, and the generator stops, once the bank is above this                                                                        | 0.6                                                                                                                |
| `chargeWhileDiesel`        | while the diesels run, each inline drive runs as a generator off its diesel, charging the bank with up to a quarter of its rating, as much as the bank will take | `true`                                                                                                             |
| `generatorChargesAtAnchor` | the generator may charge the propulsion bank while the boat lies at anchor; with `false` it never starts there, and the bank carries the night alone             | `true`                                                                                                             |

A hybrid's hotel load runs on its propulsion bank through the inverter, as an all-electric
boat's does, so its generator starts only for the bank: never for meals or the water maker,
which run from the bank too. The catamaran sets `hotelKw` to 2 kW; the length formula, fitted
to motor yachts with air conditioning, would give it 7.4 kW.

Main engines and generators are told apart by id. A generator's id is `generator1`,
`generator2` and so on; a main engine may not use that form, and a profile that mixes them
up is refused.

## What the Boat Sends

Every value is on a path from the Signal K specification, in SI units, except the bilge
switches a flooding fault sends, for which the specification has no path. Engine, wind
and navigation data go every second; electrical, tanks and the spaces inside every five
seconds, as a real gateway sends slow-changing data less often.

| System             | Paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main engines       | `propulsion.<id>.state`, `revolutions`, `engineLoad`, `runTime`, `coolantTemperature`, `oilTemperature`, `oilPressure`, `exhaustTemperature`, `fuel.rate`, `alternatorVoltage`, `transmission.gear`; an electric motor sends `temperature` in place of the coolant, oil, exhaust and fuel values                                                                                                                                                                                                                             |
| Generators         | `propulsion.generator<n>.state`, `revolutions`, `engineLoad`, `runTime`, `coolantTemperature`, `oilPressure`, `fuel.rate`; and `electrical.ac.generator<n>.phase.<single, or A, B and C>.lineNeutralVoltage`, `lineLineVoltage` (three phase), `frequency`, `current`, `realPower`, `apparentPower`, `powerFactor`                                                                                                                                                                                                           |
| Thrusters          | `propulsion.bowThruster` and `propulsion.sternThruster`: `state`, `engineLoad` (the share of rated power), `runTime`, each with metadata naming it a thruster and not a main engine; an electric thruster's draw shows in its bank's `current`                                                                                                                                                                                                                                                                               |
| Shore power        | `electrical.ac.shore.phase.…`, at a berth, while it carries a load or a charger                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Batteries          | `electrical.batteries.<id>.voltage`, `current` (positive charging), `temperature`, `capacity.stateOfCharge`, `capacity.stateOfHealth`, `capacity.timeRemaining` (while discharging)                                                                                                                                                                                                                                                                                                                                          |
| Chargers           | `electrical.chargers.<bank>.voltage`, `current`, `chargingMode`, while a generator or shore power charges the bank, or would but for a [tripped charger](../faults/README.md#charger-drops-out) (`chargingMode` `other`, no current)                                                                                                                                                                                                                                                                                         |
| Solar              | `electrical.solar.<id>.controllerMode`, `panelVoltage`, `panelCurrent`, `panelPower`, `yieldToday`, `voltage`, `current`, `chargingMode`                                                                                                                                                                                                                                                                                                                                                                                     |
| Wind turbine       | `electrical.alternators.<id>.revolutions`, `voltage`, `current`, `chargingMode`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tanks              | `tanks.<fuel, freshWater, wasteWater or blackWater>.<id>.capacity`, `currentLevel`, `currentVolume`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depth sounders     | `environment.depth.belowSurface`, `belowTransducer`, `belowKeel`, `surfaceToTransducer`, `transducerToKeel`, one update per sounder with its own source; `sensors.<id>.fromCenter`                                                                                                                                                                                                                                                                                                                                           |
| Wind               | `environment.wind.speedTrue`, `directionTrue`, `angleTrueWater`, `speedApparent`, `angleApparent`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Inside and outside | `environment.inside.<zone>.temperature`, `relativeHumidity`; `environment.outside.temperature`, `pressure`; `environment.water.temperature`                                                                                                                                                                                                                                                                                                                                                                                  |
| Identity           | name and `mmsi` (at the vessel's root), `design.length` (`overall`), `design.beam`, `design.draft` (`current`, and `maximum` where the profile gives one), `design.airHeight`, `design.displacement`, `design.aisShipType`, `sensors.ais.fromBow`, `fromCenter` and `class`, once at the start; see [Identity](#identity)                                                                                                                                                                                                    |
| Navigation state   | `navigation.state`: `moored`, `anchored`, `sailing` or `motoring`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Heading and course | `navigation.headingTrue`, `headingMagnetic`, `magneticVariation`, `courseOverGroundTrue`, `courseOverGroundMagnetic`                                                                                                                                                                                                                                                                                                                                                                                                         |
| Speed and logs     | `navigation.speedThroughWater`, `speedOverGround`, `log`, `trip.log`, `trip.lastReset`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Turning            | `navigation.rateOfTurn` (positive to starboard), `steering.rudderAngle` (positive to starboard)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Attitude           | `navigation.attitude` with `roll` (positive to starboard) and `pitch` (positive bow up)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GNSS               | `navigation.position`, `datetime`, `gnss.type`, `gnss.methodQuality`, `gnss.satellites`, `gnss.horizontalDilution`, `gnss.positionDilution`                                                                                                                                                                                                                                                                                                                                                                                  |
| Bilge              | only while the bilge has a [flooding fault](../faults/README.md#bilge-flooding) or water to clear: `electrical.switches.bilgePump.state` and `electrical.switches.bilgeHighWater.state`, 1 closed and 0 open; the specification has no bilge                                                                                                                                                                                                                                                                                 |
| Notifications      | `notifications.<path>`, each with `state` (`warn`, `alarm`, or `normal` once it clears), `method` and `message`, from the boat's own alarm panel: every value with [zones](#alarms) in one of them, and what a [fault](../faults/README.md#the-faults) raises that no zone can know (`propulsion.<id>.alternatorVoltage`, a generator's `state` when it will not start, `electrical.chargers.<bank>.chargingMode`, the bilge switches, `environment.depth.belowTransducer` and `navigation.position`); see [Alarms](#alarms) |

**Names.** When a run starts the plugin sends metadata with a `displayName` (and the
`description` the specification requires) for every engine, generator and its AC output,
battery bank, solar array, wind turbine, tank, inside zone and depth sounder
(`propulsion.port` is "Port main engine", `tanks.fuel.dayTankStarboard` is "Starboard day
tank", `sensors.portSounder` is "Port depth sounder"), so a display can tell port from
starboard. The values a panel watches carry their alarm zones in the same metadata; see
[Alarms](#alarms).

**Depth sounders.** The specification has one set of depth paths, not one per sounder, so
each sounder sends them under its own source: `simulator.portSounder` and
`simulator.starboardSounder`, which the server keeps apart and source priorities can choose
between. This is how two sounders arrive from an NMEA 2000 network. Each reads the depth
grid at its own place under the hull (its offset from the centreline, across the boat's
heading), so on a sloping bottom they disagree the way real ones do. With a profile, the
sounders replace the single grid depth a route without one sends.

**Radars** are counted in the profile and send nothing: radar data does not go through the
Signal K data model.

**Inside zones** go under `environment.inside.<zone>`, named by the zone's id
(`saloon`, `galleyFridge`, `engineRoom`). Free zone names need **Signal K schema 1.1.0 or
later**; schema 1.0.x allows only `mainCabin`, `engineRoom`, `refrigerator`, `freezer` and
`heating` there. The tests validate against schema 1.8.2.

## Alarms

Every value the boat sends that an alarm panel would watch carries the specification's
zones in its metadata: a list of bands, each with a `lower` and `upper` bound (either may be
open), a `state` and a `message`. A display colours its gauge by them, and the plugin's alarm
panel (`simulator/alarms`) raises `notifications.<path>` from the same zones, so the gauge,
the notification and the profile always agree.

**What carries zones.** The bands below are the defaults, by the kind of thing and its
size, in the units shown; on the wire they are in SI units, as the values are.

| Path                                               | Warning                                                                     | Alarm                                     | Margin         |
| -------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- | -------------- |
| `propulsion.<id>.coolantTemperature`               | 95 °C and over                                                              | 100 °C and over                           | 2 °C           |
| `propulsion.<id>.oilPressure`                      |                                                                             | under 1 bar, while the engine runs        | 0.3 bar        |
| `propulsion.<id>.exhaustTemperature`               | 550 °C and over (full load runs near 500 °C)                                | 600 °C and over                           | 10 °C          |
| `electrical.batteries.<id>.voltage`, lithium       | under 12.0 V or 14.6 V and over, per 12 V                                   | under 11.6 V or 15.0 V and over, per 12 V | 0.2 V per 12 V |
| `electrical.batteries.<id>.voltage`, lead-acid     | under 11.8 V or 15.0 V and over, per 12 V                                   | under 11.0 V or 15.5 V and over, per 12 V | 0.2 V per 12 V |
| `electrical.batteries.<id>.capacity.stateOfCharge` | under 20 % (lithium), 40 % (lead-acid)                                      | under 10 % (lithium), 30 % (lead-acid)    | 2 %            |
| `tanks.fuel.<id>.currentLevel`                     | under 12 %                                                                  | under 5 %                                 | 2 %            |
| `tanks.freshWater.<id>.currentLevel`               | under 20 %                                                                  | under 10 %                                | 2 %            |
| `tanks.wasteWater` and `blackWater` levels         | 80 % and over                                                               | 95 % and over                             | 2 %            |
| `environment.depth.belowKeel`                      |                                                                             | under the shallow water setting           | 0.3 m          |
| `environment.wind.speedTrue`                       | the length in metres plus 10 kn, 20 to 35 kn                                | 10 kn above the warning                   | 2 kn           |
| `environment.inside.<zone>.temperature`            | 38 °C living, 60 °C engine room, setpoint plus 4 °C fridge and 6 °C freezer | 45 °C, 70 °C, plus 7 °C and plus 10 °C    | 1 °C           |
| `environment.inside.<zone>.relativeHumidity`       | 80 % and over, living spaces only                                           |                                           | 3 %            |

Main engines and generators both carry the coolant and oil pressure bands; the exhaust is
a main engine's. The battery bands scale with the bank's nominal voltage, so a 24 V lithium
bank warns under 24.0 V and a 400 V propulsion bank under 400 V. The shallow water depth is
the plugin's setting (see [the plugin README](../plugin/README.md#settings)).

**Where the bands come from.** A profile gives its own bands in `alarmZones`, by path,
where the boat's thresholds differ from the defaults; the zones it gives replace the
default ones for that path, and the margin stays the default's. A path the boat has no
alarm on, or a zone with no bound, its bounds the wrong way round or a state the
specification does not have, is refused when the profile loads:

```json
"alarmZones": {
  "propulsion.port.coolantTemperature": [
    { "lower": 365.15, "upper": 371.15, "state": "warn", "message": "Port engine running hot" },
    { "lower": 371.15, "state": "alarm", "message": "Port engine overheating" }
  ]
}
```

**How the panel raises them.** It reads each value as it goes out. A value in a zone
raises that zone's notification, with its `state`, its `message` and the method the state
calls for (`["visual"]` for a warning, `["visual", "sound"]` for an alarm); a value moving
into a worse zone raises that one. A raised alarm holds until the value is back out of its
zone by the margin, as a real panel's does, so a value wandering about an edge does not
flicker it, and then goes as one notification with `state: normal`. Two rules a panel
keeps that a zone cannot say: oil pressure is watched only while its engine runs, since a
stopped engine reads none, and a value that has stopped coming in is no longer read, so a
silent sounder gives no depth, not shallow depth. The notifications raised are saved with
the run and sent again when it resumes.

**The boat raises on its own,** with no fault, what its day brings: a fuel or water tank
running low, a grey or black water tank filling before it is pumped out, a bank run down,
and shallow water, and, from the AIS targets it hears, a target coming too close (see
[Collision Avoidance](../ais/README.md#collision-avoidance), raised in the target's own
context). The [systems soak](../soak/README.md#what-it-checks) checks that a day out raises
the first four and nothing else; it sails without traffic. What no zone can know, a fault
raises itself: a generator that will not start, a charger tripped, an alternator not
charging, the bilge filling, a silent sounder, a lost fix (see
[the faults](../faults/README.md#alarms)).

**Anchor watch.** While the anchor is down the boat watches her distance from it, as the
anchor alarm plugin does. Past the watch radius it raises `notifications.navigation.anchor`
as that plugin raises it: `state: emergency`, method `["visual", "sound"]`, message
`Anchor Alarm - Emergency`. It holds until she is back inside the radius by 5 m, or the
anchor is weighed, and then goes as `normal`, method `[]`, as every other alarm clears
here. The radius is the plugin's `Anchor watch radius` setting; at 0, its default, it is
the radius her scope gives (`navigation.anchor.maxRadius`) plus 10 m, so her swing never
reaches it. Only a dragging anchor takes her past it: the `anchorDragging`
[fault](../faults/README.md#the-faults), which the seed throws only at anchor and which can
be raised by hand at anchor and nowhere else. How she anchors and swings is in
[the routes README](../routes/README.md#anchorage).

**One notification per path.** The server raises a notification itself from any zones in
a path's metadata (`src/zones.ts`), at a zone's edge, with no margin, and for an engine's
oil pressure whether it runs or not. So the metadata also carries `zonesNotifiedBy:
"simulator"`, naming the source that raises the path's notifications, and the server raises
none of its own for a path that has it: each watched path has one notification, the
panel's, under `simulator`, and the path's value is the panel's through the margin. That
field is this fork's (`MetaValue.zonesNotifiedBy` in `@signalk/server-api`); the
specification does not have it, so the tests take it out before checking a delta against the
schema. The metadata also carries the panel's method for each state (`warnMethod`,
`alarmMethod`, `alertMethod`, `emergencyMethod`).

**Shallow water.** The depth sounder's shallow alarm is raised on
`notifications.environment.depth.belowKeel` below the plugin's `Shallow water alarm`
setting, 1.5 m under the keel by default, and cleared 0.3 m deeper. It is a separate
setting from the route planner's minimum depth (1 m by default), so the passage the
planner keeps out of the shallowest water can still throw it. The Miami sample, sailed
from its departure at seed 1, throws it leaving Rickenbacker Marina and on the way out to
the bay (14:00 to 14:25, down to 0.3 m in the marina, which the planner's minimum does not
cover), then on the passage itself: in Biscayne Bay at 14:45 (25.797 N, 80.180 W, leg 12,
down to 1.15 m), in north Biscayne Bay at 15:29 and from 15:30 to 15:33 (25.895 N,
80.137 W, leg 22, down to 1.27 m), behind Sunny Isles Beach at 15:52 (25.937 N, 80.131 W,
leg 28, 1.44 m) and in the waterway near Dania Beach at 16:54 (26.045 N, 80.116 W, leg 44,
1.05 m). The times shift by seconds with a different start or seed, which moves the boat a
little across her track.

## Generators

**A generator is two things in Signal K: an engine and an AC source.** Its engine goes
under `propulsion`, with an id of the form `generator1` and a `displayName` in its
metadata, beside the main engines. That is where an engine gateway puts it: NMEA 2000
engine PGNs (127488, 127489) carry no difference between a propulsion engine and a
generator's, so `n2k-signalk` maps both to `propulsion.<instance>`, and the boat's own
metadata names them. Its output goes under `electrical.ac.generator1`, which is where an AC
monitor (`n2k-signalk`'s mapping of PGNs 65013 to 65030) puts generator voltage, current,
frequency and power.

The two halves are tied together: the AC load sets the engine's `engineLoad` and its fuel
rate, the fuel comes out of the tank the profile names, the governor holds speed with a
little droop under load, and the AC frequency follows the engine's speed. The run hours
count only while it runs. Main engines and generator engines never share an id, so
anything reading `propulsion` can tell them apart by id or by the display name, and the
tests check the counts of each separately.

## Navigation

The navigation values are worked out with the systems, in the same steps, so they agree
with what the engines are doing and with each other.

- **State** follows where the boat is and what drives it: `moored` alongside a berth,
  before departure and after arrival; `anchored` at a waypoint marked `anchor`; `sailing`
  when a sailing yacht is under sail; `motoring` otherwise, holds at a bridge included. The
  engines are stopped and out of gear in the first three and running in gear in the last
  (a hybrid in its electric mode is in gear with its diesel stopped), so a reader never
  sees a moored boat in gear or a sailing boat under power.
- **Current and heading.** The route is the track over the ground, and its leg speeds are
  speeds over the ground. A small current runs under the boat, a tenth to four tenths of a
  knot, setting in a direction and wandering slowly about both, seeded per run. The helm
  holds the track against it, so `headingTrue` is the course over the ground turned by the
  angle that cancels the current, `speedThroughWater` is the boat's speed through the
  moving water, and the two speeds differ by the current. A sea puts a slow wander of a
  degree or two on the heading, more on a small boat. Alongside, the lines hold the boat on
  the berth's heading and nothing moves past the log. At anchor she lies to her chain, bow
  to the anchor, swinging to the wind; through the water and over the ground she moves
  only as her swing moves her, a few tenths of a knot (see
  [Anchorage](../routes/README.md#anchorage)). Holding under way at a bridge, she lies head
  to the current, which runs past the log. In the last five minutes before she leaves, the
  crew swings her onto the course she leaves on. A heading never changes faster than the
  boat can swing: its turning rate under way, or when stopped a pivot of three quarters
  of a degree a second on the largest boats up to three on the smallest.
- **Magnetic variation** comes from the International Geomagnetic Reference Field on the
  sample's date, as a grid over its area in the sample's `magnetic-variation.json`
  (`npx ts-node simulator/tools/magnetic-variation.ts <sample>` writes it, from NOAA's
  calculator), read between the grid points. `headingMagnetic` and
  `courseOverGroundMagnetic` are the true values less the variation, positive east as the
  specification has it. A sample without the file sends no magnetic values.
- **Turns.** A boat swings through a waypoint it passes without stopping, on an arc tangent
  to both legs. It turns at the rate its length and speed allow, about five lengths of
  turning radius and never faster than five degrees a second, or faster where a short leg
  leaves no room. The arc joins each leg where the boat on the straight legs would be at
  that moment, so the legs keep their timings, and the boat slows a little round it. An arc
  that would cut a corner over shallow water or land is tightened until it stays clear
  (see [the plugin README](../plugin/README.md#what-it-does)). Between the arcs the boat
  sails the great circle between the waypoints, the line the Course API measures from. The
  position, `courseOverGroundTrue`, `speedOverGround` and `rateOfTurn` all come from the
  same arc. The rudder does the work: `steering.rudderAngle` is in proportion to the rate of
  turn times the boat's length over its speed through the water, up to 35 degrees, so a
  steady turn holds a steady angle, and the helm's small corrections show in it as the
  heading wanders. It is central alongside and when there is no way on.
- **Course.** The server's Course API holds the route the boat sails as its active route
  (see [the plugin README](../plugin/README.md#what-it-does)), and the course provider
  works its values out from the position the boat sends, so they follow from the model
  rather than being sent by it. The helm holds the track to within a few metres: about 1.5
  m of steering error, plus 4 m for each knot of current and 2 m for each metre of sea,
  wandering slowly to either side and settling away when the boat stops. The position is
  that far off the route's line, so `navigation.course.calcValues.crossTrackError` stays
  small on a leg, and is positive with the boat to starboard of the track, as the
  specification signs it. Through a turn the arc cuts inside the corner, by up to the
  turning radius times (1 - cos(half the turn)) abeam of the waypoint: 12 to 25 m for a
  20 m boat turning 60 to 90 degrees, on the side the boat turns to. `bearingTrackTrue` is
  the course the track runs; `courseOverGroundTrue` is the boat's own course along it; the
  heading differs from both by the angle the helm holds against the current. The bearing
  and distance to the next point, time to go and arrival time all follow from the position
  and the speed over the ground.
- **Attitude.** The sea is worked out from the wind, fetch-limited as a coastal sea is,
  and sheltered alongside and at anchor. Roll grows with the sea and falls with the beam;
  pitch grows with the sea and falls with the length; both wander irregularly with the
  boat's own periods. A sailing yacht heels to leeward under sail, up to 20 degrees with a
  fresh breeze across it, and a motor boat trims bow up a little with speed.
- **Logs.** `navigation.log` counts the distance through the water from a seeded total
  of a few thousand miles. `navigation.trip.log` counts it from `trip.lastReset`, which is
  the run's start or the last time the boat left a berth.
- **GNSS.** The fix is a combined GPS and GLONASS fix. The satellites in use wander slowly
  between 5 and 16, one at a time, and the horizontal dilution follows them: lower with
  more satellites, with a little jitter of its own. The position dilution is about 1.7
  times the horizontal.

## How the Systems Relate

The model moves in fixed two-second steps of scenario time, whatever the time multiplier,
so a run at x300 is the same run as at x1. Everything the boat sends, its position and
scenario time included, is the state at the model's latest step, so the same scenario time
carries the same values at any multiplier; a faster clock only skips steps between sends.

- **Engines** follow the boat's speed through the water: revolutions between idle and
  maximum with the share of top speed, power with its cube (the propeller law), fuel at
  about 0.25 l per kWh for diesel (0.35 for petrol) plus an idle allowance; a generator
  burns 0.3 l per kWh of electricity at full load, a third of the fuel's energy, and a
  quarter of that at no load. Coolant, oil and
  exhaust warm towards running temperatures and cool when the engine stops. The engines are
  stopped alongside a berth, at anchor, and on a sailing yacht under sail (above 3.5 kn with
  at least 6 kn of wind), and idle at bridge holds. A route marks a waypoint `anchor` where
  the boat lies at anchor rather than holding under way.
- **Hybrid drives** follow the profile's [hybrid rules](#hybrid-rules): on the electric
  motors alone up to `electricBelowKn`, the diesel stopped and its revolutions reading 0;
  on the diesels above it, the alternator charging the low-voltage bank like any diesel's and
  the inline drives charging the propulsion bank as far as it will take. Below
  `dieselBelowSoc` the diesels take over at any speed until the bank is past
  `electricAboveSoc`. On the Queensland passage the catamaran leaves Manly on its motors,
  runs the passage on its diesels with the bank charged to full within the first hour, and
  comes into Hamilton Island on its motors again.
- **Electric drives** draw their bank for the power the speed needs.
- **Thrusters** run only in the berthing manoeuvres: within three boat lengths of the berth
  the boat is leaving, on its first leg, and of the berth it is coming to, on its last. They
  run in bursts of 2 to 8 seconds at half to full power, with pauses of 4 to 20 seconds,
  from their own seeded stream, and never at anchor, at a hold or under way beyond the berth.
  An electric thruster draws its bank through an 85 % efficient motor: a 14 kW bow thruster
  pulls up to about 16 kW, some 600 A from a 24 V bank in a full burst, which the energy books
  carry as `thrusters`. A hydraulic thruster draws no bank: its pump is driven off a main
  engine, through 70 % hydraulics, so it runs only while that engine runs, which carries its
  load and burns its fuel. Each running engine has one alternator, shared through a charge
  splitter between the house and start banks, giving at most 150 A at their voltage, half
  of it at idle and all of it flat out, as a real one does; so a burst at manoeuvring
  revolutions shows on the bank rather than vanishing into the alternators.
- **Generators** on boats from 24 m carry the hotel load whenever the boat is away from the
  berth, starting a second one when the first would be over 80% and stopping it when the
  rest would be under 60%. On smaller boats a generator runs when its bank runs low (until it
  is charged), at anchor at meal times for cooking and hot water, and while the water maker
  needs it; the air conditioning runs while it does. A hybrid's generator runs only to
  charge its propulsion bank, below `dieselBelowSoc` until past `electricAboveSoc`, and at
  anchor only if `generatorChargesAtAnchor`. Once started a generator runs at least 15
  minutes. Alongside, shore power carries the load.
- **The water maker** runs away from the berth when the fresh water falls below 85% and
  stops at 98%, on generator power (0.025 kWh a litre). Alongside, the tanks are filled from
  the dock instead.
- **The hotel load** is the profile's `hotelKw` (from the boat's size unless it says),
  follows the day (lower at night, higher at meal times) and adds air conditioning in
  proportion to the outside temperature, from nothing at 22 °C to its most at 36 °C.
- **Batteries** discharge into the house loads, the fridges' compressors, an inverter and
  any electric drive, and charge from their sources in the order a real system ends up
  drawing on them: solar and wind first, then the DC-DC converter from a propulsion bank
  (which carries the house on a hybrid or electric boat), then engine alternators and drive
  regeneration, then AC chargers, each giving only what the loads and the bank's charge
  acceptance still want. Chargers are rated at the bank's full charge rate. Each step the
  bank takes the current that delivers the net power at its terminals through its
  resistance, from its open-circuit voltage, so what goes in is what is stored plus what the
  resistance turns to heat; the voltage a monitor reads is that terminal voltage, held at
  absorption by a charger and wandering a little. Every flow is kept in each bank's energy
  books, which the [systems soak](../soak/README.md) balances.
- **Solar** follows the sun's elevation at the boat's position and time, through slowly
  passing cloud; arrays on one bank share what it takes. With a full bank and little load
  the controller backs off, as a real one does. A **wind turbine** follows the apparent
  wind.
- **Tanks**: engines and generators draw from the tanks the profile names, changing to the
  fullest tank when theirs is below 15%; a transfer pump tops the day tanks up from the
  fullest storage tank. Boats start with their storage tanks 85 to 98% full. Fresh water
  goes with the people aboard and the time of day (twice the average in the morning, a
  fifth of it at night), grey water takes most of it, and black water fills with use.
  Holding tanks are emptied at a berth's pump-out station above 50%; away from a berth grey
  water goes overboard above 85%, and black water only well offshore, which a boat making
  5 kn or more stands for here. Levels slosh a little while the boat moves.
- **Inside**: living spaces go to their setpoint while the air conditioning runs and towards
  the outside temperature (plus the sun) when it does not; the engine room heats with the
  engines; fridges and freezers cycle their compressors in a band around the setpoint.
- **Weather**: air and water temperature from latitude, season and time of day; wind with a
  daily sea breeze; apparent wind from the true wind and the boat's own motion.

Every drift comes from the run's **seed** (a plugin setting), one stream per system, so
the same seed, sample and start time give exactly the same data, and another seed gives a
different but equally plausible run.

## What Persists

The plugin saves the systems with the scenario time, and restores them when it resumes
(see [the plugin README](../plugin/README.md#settings)). Everything the model carries
from one step to the next is saved: each tank's volume; each bank's state of charge,
health, voltage, current and temperature; each engine's and generator's run hours,
whether it is running, its temperatures and, for a generator, how long it has been
running and whether it was started to charge its bank; each solar array's yield today;
the inside spaces and their compressors; the weather; the fuel transfer pump and the
water maker; the holding tanks being pumped out; the heading, logs, trip, attitude and
GNSS; each thruster's burst, pause and run hours and where its stream has reached; and
every drift with the state of its seeded stream. A resumed run is the same run: two hours,
a restart and two more hours give exactly the values an unbroken four-hour run gives at
the same seed, for every profile.
The saved systems name their profile and seed, and are used only when both still match.

## What Has No Standard Path

Some systems on board have no path in the specification. The model keeps their effect on
the values that do have paths, and sends nothing of its own for them. With a proposal
for each:

| System                                         | What the model does now                                                                                                  | Proposal                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thruster power and current                     | power shows as `engineLoad`, the share of rated power; an electric thruster's current shows in its bank's `current`      | propose `propulsion.<id>.power` and, for an electric drive, `propulsion.<id>.current`, beside `engineLoad`; `drive.type` could gain `tunnelThruster`. `propulsion.<id>.label` is a plain string in the schema, not a value a delta can carry, so the name goes in metadata |
| Hybrid drive mode (electric, diesel, charging) | shows as the diesel's `state` and the propulsion bank's `current`                                                        | propose `propulsion.<id>.drive.mode` (`electric`, `diesel`, `boost`, `charging`) to the specification, beside the existing `drive.type`                                                                                                                                    |
| Electric motor power and temperature           | power shows as the bank's discharge; an electric-only drive sends its motor temperature as `propulsion.<id>.temperature` | propose `propulsion.<id>.motor.power`, `motor.temperature` and `motor.revolutions` for the motor of a hybrid, where `revolutions` must stay the diesel's                                                                                                                   |
| Shaft speed while a hybrid runs electrically   | not sent (`revolutions` is the engine's, 0 while the diesel is stopped)                                                  | covered by `motor.revolutions` above                                                                                                                                                                                                                                       |
| Fuel transfer pump                             | moves fuel between tanks, seen in their levels                                                                           | `electrical.switches.<id>.state` with `meta.displayName`, as a digital switching system reports a pump                                                                                                                                                                     |
| Air conditioning setpoints and mode            | living zones go to their setpoint while it runs                                                                          | the specification has no climate control group; `environment.inside.<zone>.temperature` with `meta.zones` ranges covers alarms, and a setpoint would want a proposal                                                                                                       |
| Water maker                                    | its water shows in the tank levels and its power in the generator's load                                                 | `electrical.switches.<id>.state` for the unit, as for the transfer pump; output and salinity would want a proposal                                                                                                                                                         |
| DC-DC converter                                | carries the house bank from the propulsion bank, seen in both banks' currents                                            | the specification has no converter group; `electrical.chargers.<id>` with `chargerRole` comes closest, but a charger is AC-fed                                                                                                                                             |
| Inverter                                       | its draw shows as the house bank's discharge                                                                             | `electrical.inverters.<id>` exists; it is left out until a profile carries an inverter                                                                                                                                                                                     |
| Radars                                         | counted, silent                                                                                                          | radar images belong outside the data model, in a radar API or a plugin of its own                                                                                                                                                                                          |
| Sounder identity                               | one source per sounder, `sensors.<id>` with a display name and `fromCenter`                                              | `fromCenter` is positive to starboard in this server's path metadata and positive to port in schema 1.8.2; the model follows the server, and the two want reconciling                                                                                                      |
| Wind turbine                                   | `electrical.alternators.<id>`, as the specification describes alternators as mechanically driven charging devices        | nothing further needed                                                                                                                                                                                                                                                     |
| Fridges and freezers                           | inside zones (`environment.inside.galleyFridge`), as the specification's own `refrigerator` and `freezer` zones are      | nothing further needed                                                                                                                                                                                                                                                     |

## Adding a Profile

Write `<id>.json` here with at least `id`, `name` and `lengthM`, and set it as a sample's
`vessel.profile`. The tests load every file in this folder, validate every delta it
produces against the Signal K schema, and check the counts against the profile:

```shell
npx mocha test/simulator-systems.ts
```

Then run the [systems soak](../soak/README.md#systems-soak), which sails every profile
for a day of scenario time and checks that nothing drifts, runs dry or goes out of band:

```shell
npm run test:simulator-soak
```
