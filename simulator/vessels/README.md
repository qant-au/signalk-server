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

| Profile                 | Boat                                                                     | Engines                                                              | Generators | Banks                                      | Charging                                     | Tanks (fuel, fresh, grey, black) | Sounders | Radars | Inside zones | Used by                  |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------- | ------------------------------------------ | -------------------------------------------- | -------------------------------- | -------- | ------ | ------------ | ------------------------ |
| `motor-yacht-45m`       | 45 m motor yacht, 2.6 m draft, 380 t                                     | 2 diesel, 1500 kW each                                               | 2 × 99 kW  | house 24 V 2000 Ah, start 24 V 400 Ah      | 2 solar arrays                               | 4 + 2 day tanks, 2, 2, 2         | 2        | 2      | 13           |                          |
| `motor-yacht-34m`       | 34 m motor yacht, 2.1 m draft                                            | 2 diesel (from length)                                               | 2 × 65 kW  | house and start (from length)              |                                              | 4, 2, 2, 2                       | 2        | 2      | 5            |                          |
| `motor-yacht-20m`       | 20 m motor yacht, 1.5 m draft, 60 Hz 120 V                               | 2 diesel, 735 kW each                                                | 1 × 22 kW  | house and start (from length)              |                                              | 4, 2, 1, 1                       | 1        | 1      | 5            | Miami ICW                |
| `sailing-yacht-15m`     | 15 m sailing yacht, 2.2 m draft                                          | 1 diesel, 80 kW                                                      | 1 × 6 kW   | house 12 V 600 Ah, start 12 V 100 Ah       | 400 W wind turbine                           | 2, 2, 1, 1                       | 1        | 1      | 5            | Saronic Gulf             |
| `motor-sailer-15m`      | 15 m motor-sailer, 1.8 m draft                                           | 1 diesel, 110 kW (150 HP)                                            | 1 × 8 kW   | house and start (from length)              | 800 W solar                                  | 2 × 900 l, 2, 1, 1               | 1        | 1      | 5            | Manly to Hamilton Island |
| `yacht-12m`             | 12 m motor yacht, everything from length                                 | 2 diesel                                                             | 1          | house and start                            |                                              | 2, 1, 1, 1                       | 1        | 1      | 5            |                          |
| `sailing-yacht-9m`      | 9 m sailing yacht, 1.6 m draft                                           | 1 diesel, 15 kW                                                      | none       | house and start (from length)              |                                              | 1, 1, 0, 1                       | 1        | 1      | 3            |                          |
| `electric-launch-7m`    | 7 m electric launch                                                      | 1 electric motor, 10 kW                                              | none       | propulsion 48 V 400 Ah                     |                                              | none                             | 1        | 0      | 0            |                          |
| `boat-4m`               | 4 m boat                                                                 | 1 petrol outboard, 15 kW                                             | none       | 12 V 50 Ah                                 |                                              | 1 × 25 l, no water tanks         | 1        | 0      | 0            |                          |
| `hybrid-catamaran-60ft` | 60 ft hybrid solar catamaran, modelled on the Xquisite Sixty Solar Power | 2 hybrid: 261 kW (350 HP) diesel + 130 kW inline electric drive each | 1 × 180 kW | propulsion 400 V 350 Ah, house 24 V 800 Ah | 8 kW solar (2 × 4 kW) on the propulsion bank | 2 × 1700 l, 2 × 500 l, 1, 1      | 2        | 1      | 5            |                          |

The hybrid catamaran's length (18.5 m), beam (8.1 m), draft (1.2 m), light displacement
(about 38 t), engines, generator, solar (8 kW), fuel (3,400 l) and fresh water (1,000 l)
follow the Xquisite Sixty Solar Power. Its propulsion bank (400 V, 350 Ah, about 140 kWh)
and house bank are **assumptions**: the builder's published figures do not give them.

## Counts and Defaults

A profile file needs only `id`, `name` and `lengthM`. Anything it leaves out is filled in
from the length, and anything it gives is used as it is:

| What                 | Default                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engines              | two diesels from 10 m (port and starboard), one below; total power about 0.9 × L² kW                                                                                                      |
| Generators           | one from 10 m, none below                                                                                                                                                                 |
| Banks                | house and start; 12 V under 12 m, 24 V from 12 m; house about 10 × L^1.5 Ah                                                                                                               |
| Fuel tanks           | 1 under 10 m, 2 under 20 m, 4 from 20 m                                                                                                                                                   |
| Fresh water tanks    | none under 6 m, 1 under 15 m, 2 from 15 m                                                                                                                                                 |
| Grey and black tanks | grey from 10 m, black from 8 m; 1 each under 25 m, 2 each from 25 m                                                                                                                       |
| Tank capacities      | totals by length: fuel about 0.019 × L^3.93 l, fresh water 0.28 × L^2.86 l, grey a quarter of the fresh water (at least 40 l), black 0.15 of it (at least 45 l), shared between the tanks |
| Water maker          | from 12 m, 5 l an hour per metre of length (75 l/h at 15 m, 225 l/h at 45 m)                                                                                                              |
| Sounders             | one, on the centreline, 80% of the draft below the waterline and at most 0.5 m                                                                                                            |
| Radars               | none under 9 m, one under 25 m, an X-band and an S-band from 25 m                                                                                                                         |
| Wind instrument      | from 7 m                                                                                                                                                                                  |
| Inside zones         | saloon and fridge from 6 m; a cabin from 9 m; engine room and freezer from 12 m                                                                                                           |

**The most a profile can have** is 8 fuel tanks, 4 fresh water tanks, 2 grey and 2 black.
These are limits, not defaults: a profile with more is refused when it loads.

Main engines and generators are told apart by id. A generator's id is `generator1`,
`generator2` and so on; a main engine may not use that form, and a profile that mixes them
up is refused.

## What the Boat Sends

Every value is on a path from the Signal K specification, in SI units. Engine and wind
data go every second; electrical, tanks and the spaces inside every five seconds, as a
real gateway sends slow-changing data less often.

| System             | Paths                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main engines       | `propulsion.<id>.state`, `revolutions`, `engineLoad`, `runTime`, `coolantTemperature`, `oilTemperature`, `oilPressure`, `exhaustTemperature`, `fuel.rate`, `alternatorVoltage`, `transmission.gear`; an electric motor sends `temperature` in place of the coolant, oil, exhaust and fuel values                   |
| Generators         | `propulsion.generator<n>.state`, `revolutions`, `engineLoad`, `runTime`, `coolantTemperature`, `oilPressure`, `fuel.rate`; and `electrical.ac.generator<n>.phase.<single, or A, B and C>.lineNeutralVoltage`, `lineLineVoltage` (three phase), `frequency`, `current`, `realPower`, `apparentPower`, `powerFactor` |
| Shore power        | `electrical.ac.shore.phase.…`, at a berth, while it carries a load or a charger                                                                                                                                                                                                                                    |
| Batteries          | `electrical.batteries.<id>.voltage`, `current` (positive charging), `temperature`, `capacity.stateOfCharge`, `capacity.stateOfHealth`, `capacity.timeRemaining` (while discharging)                                                                                                                                |
| Chargers           | `electrical.chargers.<bank>.voltage`, `current`, `chargingMode`, while a generator or shore power charges the bank                                                                                                                                                                                                 |
| Solar              | `electrical.solar.<id>.controllerMode`, `panelVoltage`, `panelCurrent`, `panelPower`, `yieldToday`, `voltage`, `current`, `chargingMode`                                                                                                                                                                           |
| Wind turbine       | `electrical.alternators.<id>.revolutions`, `voltage`, `current`, `chargingMode`                                                                                                                                                                                                                                    |
| Tanks              | `tanks.<fuel, freshWater, wasteWater or blackWater>.<id>.capacity`, `currentLevel`, `currentVolume`                                                                                                                                                                                                                |
| Depth sounders     | `environment.depth.belowSurface`, `belowTransducer`, `belowKeel`, `surfaceToTransducer`, `transducerToKeel`, one update per sounder with its own source; `sensors.<id>.fromCenter`                                                                                                                                 |
| Wind               | `environment.wind.speedTrue`, `directionTrue`, `angleTrueWater`, `speedApparent`, `angleApparent`                                                                                                                                                                                                                  |
| Inside and outside | `environment.inside.<zone>.temperature`, `relativeHumidity`; `environment.outside.temperature`, `pressure`; `environment.water.temperature`                                                                                                                                                                        |
| Log                | `navigation.speedThroughWater`                                                                                                                                                                                                                                                                                     |

**Names.** When a run starts the plugin sends metadata with a `displayName` (and the
`description` the specification requires) for every engine, generator and its AC output,
battery bank, solar array, wind turbine, tank, inside zone and depth sounder
(`propulsion.port` is "Port main engine", `tanks.fuel.dayTankStarboard` is "Starboard day
tank", `sensors.portSounder` is "Port depth sounder"), so a display can tell port from
starboard.

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

## How the Systems Relate

The model moves in fixed two-second steps of scenario time, whatever the time multiplier,
so a run at x300 is the same run as at x1.

- **Engines** follow the boat's speed through the water: revolutions between idle and
  maximum with the share of top speed, power with its cube (the propeller law), fuel at
  about 0.25 l per kWh for diesel (0.35 for petrol) plus an idle allowance. Coolant, oil and
  exhaust warm towards running temperatures and cool when the engine stops. The engines are
  stopped alongside a berth, at anchor, and on a sailing yacht under sail (above 3.5 kn with
  at least 6 kn of wind), and idle at bridge holds. A route marks a waypoint `anchor` where
  the boat lies at anchor rather than holding under way.
- **Hybrid drives** run on the electric motor alone at harbour speeds (up to 20% of its
  rating, about 7 kn on the catamaran) while the propulsion bank is above 40%; the diesel is
  then stopped and its revolutions read 0. Above that the diesel runs, its alternator charges
  the low-voltage bank like any diesel's, and while the propulsion bank is below 90% the
  inline drive charges it.
- **Electric drives** draw their bank for the power the speed needs.
- **Generators** on boats from 24 m carry the hotel load whenever the boat is away from the
  berth, starting a second one when the first would be over 80% and stopping it when the
  rest would be under 60%. On smaller boats a generator runs when its bank runs low (until it
  is charged), at anchor at meal times for cooking and hot water, and while the water maker
  needs it; the air conditioning runs while it does. Once started a generator runs at least
  15 minutes. Alongside, shore power carries the load.
- **The water maker** runs away from the berth when the fresh water falls below 85% and
  stops at 98%, on generator power (0.025 kWh a litre). Alongside, the tanks are filled from
  the dock instead.
- **The hotel load** grows with the boat's size, follows the day (lower at night, higher at
  meal times) and adds air conditioning in proportion to the outside temperature, from nothing at 22 °C to
  its most at 36 °C.
- **Batteries** discharge into the house loads, the fridges' compressors, an inverter and
  any electric drive, and charge from their sources in the order a real system ends up
  drawing on them: solar and wind first, then the DC-DC converter from a propulsion bank
  (which carries the house on a hybrid or electric boat), then engine alternators and drive
  regeneration, then AC chargers, each giving only what the loads and the bank's charge
  acceptance still want. Chargers are rated at the bank's full charge rate. Voltage follows
  the state of charge and the current through the bank's resistance.
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

## What Has No Standard Path

Some systems on board have no path in the specification. The model keeps their effect on
the values that do have paths, and sends nothing of its own for them. With a proposal
for each:

| System                                         | What the model does now                                                                                                  | Proposal                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hybrid drive mode (electric, diesel, charging) | shows as the diesel's `state` and the propulsion bank's `current`                                                        | propose `propulsion.<id>.drive.mode` (`electric`, `diesel`, `boost`, `charging`) to the specification, beside the existing `drive.type`                               |
| Electric motor power and temperature           | power shows as the bank's discharge; an electric-only drive sends its motor temperature as `propulsion.<id>.temperature` | propose `propulsion.<id>.motor.power`, `motor.temperature` and `motor.revolutions` for the motor of a hybrid, where `revolutions` must stay the diesel's              |
| Shaft speed while a hybrid runs electrically   | not sent (`revolutions` is the engine's, 0 while the diesel is stopped)                                                  | covered by `motor.revolutions` above                                                                                                                                  |
| Fuel transfer pump                             | moves fuel between tanks, seen in their levels                                                                           | `electrical.switches.<id>.state` with `meta.displayName`, as a digital switching system reports a pump                                                                |
| Air conditioning setpoints and mode            | living zones go to their setpoint while it runs                                                                          | the specification has no climate control group; `environment.inside.<zone>.temperature` with `meta.zones` ranges covers alarms, and a setpoint would want a proposal  |
| Water maker                                    | its water shows in the tank levels and its power in the generator's load                                                 | `electrical.switches.<id>.state` for the unit, as for the transfer pump; output and salinity would want a proposal                                                    |
| DC-DC converter                                | carries the house bank from the propulsion bank, seen in both banks' currents                                            | the specification has no converter group; `electrical.chargers.<id>` with `chargerRole` comes closest, but a charger is AC-fed                                        |
| Inverter                                       | its draw shows as the house bank's discharge                                                                             | `electrical.inverters.<id>` exists; it is left out until a profile carries an inverter                                                                                |
| Radars                                         | counted, silent                                                                                                          | radar images belong outside the data model, in a radar API or a plugin of its own                                                                                     |
| Sounder identity                               | one source per sounder, `sensors.<id>` with a display name and `fromCenter`                                              | `fromCenter` is positive to starboard in this server's path metadata and positive to port in schema 1.8.2; the model follows the server, and the two want reconciling |
| Wind turbine                                   | `electrical.alternators.<id>`, as the specification describes alternators as mechanically driven charging devices        | nothing further needed                                                                                                                                                |
| Fridges and freezers                           | inside zones (`environment.inside.galleyFridge`), as the specification's own `refrigerator` and `freezer` zones are      | nothing further needed                                                                                                                                                |

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
