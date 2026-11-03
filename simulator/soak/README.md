# Soak Tests

There are two soaks and a busy run here, and they answer different questions:

|              | [Rig Soak](#rig-soak)                                                   | [Systems Soak](#systems-soak)                                                                                                                           | [Busy Run](#busy-run)                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question     | does **the server** keep up with a run?                                 | do **the simulated boats** stay believable over days?                                                                                                   | does **the server** keep up with the plugin at x24, traffic on, and a crowd of clients?                                                                 |
| Clock        | real time: one scenario second per real second                          | the simulator's controllable clock, 60 scenario seconds per tick; a day of scenario time in about 25 seconds                                            | x24: a day of scenario time in an hour                                                                                                                  |
| Runs against | a running server (the [test rig](../rig/README.md)), over its WebSocket | nothing: the simulator's own code, in the test process                                                                                                  | a server of its own, started from this checkout with the plugin                                                                                         |
| Covers       | the own boat's navigation data on one sample route                      | every vessel profile and every system on board, for a day each, and the motor-sailer's and the hybrid catamaran's three-day passages                    | the plugin on one sample with its AIS traffic, 10 WebSocket subscribers to the full stream and 3 REST readers of the vessels tree                       |
| Checks       | sends succeed, positions read back, response time, server memory        | every value in a band for its kind, no gaps, schema-valid deltas, the systems behaving as they should together, and every bank's energy books balancing | the scenario clock against wall time, every delta reaching every subscriber, event loop lag, memory levelling off, and Admin UI and REST response times |
| Command      | `npx ts-node simulator/tools/soak.ts <sample>`                          | `npm run test:simulator-soak`                                                                                                                           | `bin/simulator-busy <sample>`                                                                                                                           |
| Takes        | as long as you ask it to run                                            | about eight minutes                                                                                                                                     | an hour for a day, and up to 12 minutes more to settle                                                                                                  |
| Run it       | after a change to how the plugin or the server handles deltas           | after a change to a vessel profile or the systems model                                                                                                 | after a change to the plugin's traffic, its send path or the server's delta fanout                                                                      |

None is part of `npm test`. The fast systems tests (`test/simulator-systems.ts`, a few
seconds) run there and check one of each shape; the systems soak runs the same model for
days and checks everything it sends.

## Rig Soak

A rig soak sails a sample's route on the [test rig](../rig/README.md) and checks that the
server keeps up for the length of the run. It runs in **real time only** (one scenario
second per real second) and drives **the own boat only**. AIS traffic and faster than real
time are the [busy run](#busy-run)'s; full-route runs come next.

### Running One

Start the rig and **disable the simulator plugin** first (Admin UI, Server, Plugin Config),
or the plugin and the soak run will both be sailing the own boat. Then:

```shell
npx ts-node simulator/tools/soak.ts <sample> [--minutes N] [--start-at N] [--url URL] [--container NAME]
```

| Option        | Default               | Meaning                                                                             |
| ------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `--minutes`   | 10                    | how long to run; stops early if the route ends                                      |
| `--start-at`  | 0                     | start this many minutes into the route (`--start-at 600` is ten hours out of Manly) |
| `--url`       | http://127.0.0.1:4770 | the server under test                                                               |
| `--container` | signalk-sim-rig       | the container to sample the server's memory from                                    |

For example, half an hour into the Miami run:

```shell
npx ts-node simulator/tools/soak.ts miami-icw-2024-03-16 --minutes 30 --start-at 30
```

### What It Does

1. Publishes the route to the server's Resources API, so Freeboard draws it.
2. Sends the boat's identity once: its name, MMSI and dimensions, the same the plugin
   sends (see [the vessels README](../vessels/README.md#identity)).
3. Every second, works out where the boat is on its route at that moment of the scenario and
   sends its position, speed over ground, course and heading, and the scenario time, as one
   Signal K delta over the server's WebSocket stream. Deltas carry the wall-clock time they
   are sent, so plugins that check data age treat them as live; the scenario's time goes in
   `navigation.datetime`, where a GNSS receiver puts it.
4. Every 10 seconds, reads the position back over HTTP and checks it is within 1 m of one of
   the last few positions sent, times the read, and samples the server container's memory.

### What It Reports

The console shows a summary; the full run, with every check, is written as JSON to
`simulator/soak/reports/` (ignored by git). The run **fails** (exit code 1) if any send fails,
the position read back is wrong or the server does not answer, or the route cannot be
published. Memory is reported (first, last and peak) but not yet judged: how much growth over
a long run counts as a leak is for the full-route soak tests to decide.

### Runs So Far

| Run                                            | Result                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Miami, 2 min from 30 min into the route        | passed: 120 deltas, 12 checks, read-back error 0.00 m, no reconnects                               |
| Queensland, 4 min from 10 hours into the route | passed: 240 deltas, 24 checks, read-back error 0.00 m, no reconnects; server memory 226 to 245 MiB |

## Systems Soak

The systems soak (`systems.soak.ts`) runs every [vessel profile](../vessels/README.md)
through days of scenario time with the plugin's own `Simulation`, ticked on the
controllable clock at 60 scenario seconds per tick, so 24 hours takes about 25 seconds,
most of it schema validation, rather than a day. It uses seed 1, so a failure repeats exactly.

```shell
npm run test:simulator-soak                          # every case, about eight minutes
SOAK_CASES=motor-sailer npm run test:simulator-soak  # only the cases whose name contains this
```

### The Cases

| Case                             | Profiles                                                                                                    | Where and when                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A day out, 24 hours              | all but the motor-sailer, each at a sample's berth: Miami, the Saronic Gulf or Manly, on that sample's date | by local solar time: the night at anchor, out at 07:30, cruising at 60% of top speed, a lunch stop at anchor from 11:30 to 14:30, cruising back, alongside from 18:00. It covers anchor, harbour speed, cruising and shore power in one day |
| The Miami route, 24 hours        | `motor-yacht-20m`                                                                                           | the sample's real passage, from local midnight: alongside, the passage through the bridges, alongside again                                                                                                                                 |
| The Saronic route, 24 hours      | `sailing-yacht-15m`                                                                                         | the sample's overnight passage under sail, from two hours before it leaves                                                                                                                                                                  |
| The Queensland passage, 72 hours | `motor-sailer-15m`                                                                                          | Manly to Hamilton Island, from two hours before it leaves: three days under way                                                                                                                                                             |
| The Queensland passage, 72 hours | `hybrid-catamaran-60ft`                                                                                     | the same passage, sailed by the hybrid catamaran on its passage rules: on its motors out of Manly and into Hamilton Island, on its diesels charging the bank between                                                                        |

The sounders read a synthetic seabed that rises and falls, so the soak needs no depth
download. No [faults](../faults/README.md) are thrown: the soak checks the systems as
they should be, and a failing cell, for one, is meant to unbalance the energy books it
checks. The faults have their own tests, which run every one through its course.

### What It Checks

- **Every delta** the run produces (60,504 in all) validates
  against `@signalk/signalk-schema` 1.8.2, envelope and full model.
- **Every value stays in a band for its kind**: state of charge 0 to 100%, tank levels 0
  to 100% and volumes within capacity, coolant, oil and exhaust temperatures, oil pressure,
  revolutions within the engine's or generator's maximum, AC voltage and frequency, battery
  voltage for the bank's nominal, inside temperatures for living spaces, engine rooms,
  fridges and freezers, wind, depth, air and water. A path with no band, a NaN, a missing
  value or a string where a number belongs fails the run.
- **Nothing goes missing**: every value present at the start is present at every tick,
  apart from those that only exist some of the time (time remaining while discharging,
  chargers while charging, shore power while alongside, charging modes).
- **Counters behave**: run hours never go back; solar yield resets only at local midnight.
- **Nothing drifts away**: house and propulsion banks stay above 15%, start banks above
  80%, and no fuel tank runs dry.
- **Generators** start and stop on their own, run at least 15 minutes once started (unless
  the boat comes alongside, where shore power takes over), and start no more than 12 times
  a day.
- **Solar** is zero at night, producing whenever the sun is above 15°, never more than the
  sun gives at its elevation at the sample's latitude and date, and follows the sun while
  the bank still takes charge. With a full bank and nothing drawing, a controller backs
  off, as a real one does.
- **Air conditioning** load follows the outside temperature (rank correlation above 0.9)
  wherever there is AC power for it, and is zero where there is none.
- **Fresh water** use follows the day (the morning rate at least three times the night's),
  the water maker refills the tanks faster than they are used while it runs, and a boat with
  a water maker never falls below half full.
- **Grey and black water** tanks fill with use, are pumped out before they overflow, and
  black water only goes out well offshore (at 5 kn or more) or at a berth's pump-out station.
- **The wind turbine** charges in proportion to the apparent wind (rank correlation above
  0.9) and is still below 3 m/s.
- **The navigational state** is `moored`, `anchored`, `sailing` or `motoring` at every
  tick and agrees with the engines: stopped and out of gear in the first three, something
  in gear under `motoring`. Every case motors at some point, and the sailing yachts sail.
- **The energy books balance** for every bank of every case, to 1 %: everything delivered
  in at its terminals (solar, wind, alternators, drive regeneration, the shore and generator
  chargers, the DC-DC converter) equals everything drawn out (house loads, fridges, the
  inverter, electric drives, the converter's draw on a propulsion bank, a start bank's
  standby) plus the change in stored energy plus the loss in the bank's resistance. The
  stored energy is worked out on its own, from the state of charge at the start and the end
  and the open-circuit voltage integrated between them, not from the flows. Charge past full
  or past empty is counted apart, and is zero.
- **The fuel balances**: what left the tanks equals what the engines and generators burned
  at their fuel rates, and the `fuel.rate` values sent, each held until the next tick and
  integrated, come to the same within 1 % (checked where a case burns more than a litre).
- **Generators** turn no more than 38 % of their fuel's energy (diesel at 9.94 kWh a litre)
  into electricity, the best a marine diesel set manages.
- **The thrusters run only berthing**: every boat with a bow thruster runs it coming
  alongside at the end of its case; at every tick a thruster is running the boat is
  motoring within three boat lengths of the berth it is leaving or coming to, and its run
  time grows only between ticks near one; an electric thruster's hardest burst shows on its
  bank's current at 50 to 110 % of its draw (the rest from the alternators), and a hydraulic
  one draws no bank.
- **The hybrid runs as a hybrid**: on its motors alone below its electric speed while the
  bank is above its ceiling, on both diesels above it, the bank charging from them on
  passage, its generator starting only below its charge floor, and solar carrying its hotel
  load whenever the sun is above 30°.
- **The notifications** a case raises are the ones its day should, and nothing else: with
  no fault on board, only a tank running low or a holding tank filling, a bank run down,
  and shallow water may raise one. Each notification matches its zone: a raised one
  carries a zone's state and message for the value its path had just sent (within the
  zone's margin, as a held alarm may be), with method `["visual"]` for a warning and
  `["visual", "sound"]` for an alarm, and a `normal` one comes with the value out of
  every zone or no longer sent. Across the cases at least one tank's alarm is raised. The
  run ends with a table of every notification raised, case by case: the path, how many
  times, its states, its message and when it first came.
- **The heading** stays on the course over the ground, off it only by what a knot of
  current across the track and a few degrees of yaw allow, and the speed through the
  water differs from the speed over the ground by at most a knot.

At the end it prints a table of what each case did: deltas validated, generator starts,
water made, pump-outs, the lowest house state of charge, and the fuel left. Each case also
prints its energy books, bank by bank, and its fuel and generator efficiency.

### What It Found

Over its first runs the soak found these. Each was fixed at its cause; none by widening a
band:

| Found                                                                                                                                              | Cause                                                                                                                                           | Fix                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 4 m boat's depth sounder was below its keel (transducer 0.5 m, draft 0.3 m)                                                                    | the default transducer depth was a fixed 0.5 m                                                                                                  | the default is now 80% of the draft, at most 0.5 m                                                                                                                       |
| The motor-sailer's port tank ran dry 15 hours into its passage with the starboard tank full                                                        | an engine drew from its own tank until it was empty                                                                                             | below 15% a storage tank is changed for the fullest one, as a crew changes tanks                                                                                         |
| Then both tanks ran dry 30 hours in, on a 68-hour passage                                                                                          | the profile could not make the passage: a 150 kW engine at 8.5 kn burns about 23 l/h against 800 l of fuel                                      | the profile is now 110 kW (150 HP) with 2 × 900 l, as a passage-making motor-sailer carries; boats start with their storage tanks 85 to 98% full                         |
| One of the 45 m yacht's two solar arrays gave nothing in daylight                                                                                  | the first array on a bank took all the bank wanted                                                                                              | arrays on one bank share it in proportion to what each could give                                                                                                        |
| Air conditioning load stopped following the temperature on a 33 °C Saronic afternoon                                                               | the load reached its maximum at 30 °C                                                                                                           | it rises from 22 °C to its maximum at 36 °C                                                                                                                              |
| The hybrid catamaran's charger carried 360 A (1 C) into its propulsion bank                                                                        | it cruised at 9.6 kn on electric alone, emptied the bank in an hour, then ran on the generator through the charger                              | electric alone only up to 20% of the motor's rating (about 7 kn) and above 40% charge, so the diesel takes over first; chargers are rated at the bank's full charge rate |
| The hybrid's diesels reported 450 V as their alternator voltage                                                                                    | the alternator voltage was read from the engine's own bank, the propulsion bank for a hybrid                                                    | a hybrid's diesel has a low-voltage alternator like any other, charging the start or house bank                                                                          |
| The catamaran's solar gave nothing on a morning under diesel                                                                                       | the house bank's loads were carried by the alternator before the converter from the propulsion bank was offered                                 | the house hangs off the propulsion bus ahead of any alternator                                                                                                           |
| Wind angles of −3.142, just outside −π                                                                                                             | rounding to three decimals                                                                                                                      | angles are kept inside −π to π after rounding                                                                                                                            |
| A 6 kW generator turned 40 % of its fuel's energy into electricity (124.5 MJ out against 117.5 MJ allowed at 38 %), on the energy books' first run | generators burned fuel at the main engines' 0.25 l per kWh, which at full load is 40 % of diesel's energy: more than a small marine set manages | generators now burn 0.3 l per kWh of electricity at full load, a third of the fuel's energy; over the soak they run at 24 to 34 %                                        |

Three failures were the soak's own: its gap check started from a slow delta, it expected
the Miami passage (alongside most of the day, where the dock fills the tanks) to make water,
and it compared solar output, which is sent in whole watts, with the sun to a millionth of
a watt.

The soak also needed behaviour the model did not have: lying at anchor (a waypoint may now
be marked `anchor`), a water maker, generators that run for meals at anchor and for the
water maker, fresh water from the dock and the pump-out station at a berth, and grey water
going overboard away from a berth.

### Runs So Far

2 November 2026: 19 checks passing in 8 minutes, 73,466 deltas validated, every bank's books
balancing to 0.000 %. A thruster runs in each manoeuvre for as long as the boat takes to
cross its three boat lengths at the leg's speed: seconds on the day out's 6 kn harbour legs,
half a minute at Miami's 3 kn. Generator starts count each time one more generator is running.

| Case                                              | Hours | Deltas | Generator starts | Water made | Pump-outs | Lowest house charge | Thrusters run        | Fuel left      |
| ------------------------------------------------- | ----- | ------ | ---------------- | ---------- | --------- | ------------------- | -------------------- | -------------- |
| `boat-4m` day out                                 | 24    | 4,322  | none fitted      | none       | none      | no house bank       | none fitted          | 63% (from 95%) |
| `electric-launch-7m` day out                      | 24    | 4,322  | none fitted      | none       | none      | propulsion only     | none fitted          | no fuel        |
| `hybrid-catamaran-60ft` day out                   | 24    | 4,322  | 0                | 389 l      | 3         | 92%                 | none fitted          | 91% (from 97%) |
| `motor-yacht-20m` day out                         | 24    | 4,322  | 2                | 267 l      | 2         | 72%                 | bow 6 s, stern 8 s   | 64% (from 88%) |
| `motor-yacht-34m` day out                         | 24    | 4,322  | 1                | 1,376 l    | 2         | 92%                 | bow 18 s, stern 20 s | 85% (from 88%) |
| `motor-yacht-45m` day out                         | 24    | 4,322  | 2                | 2,171 l    | 0         | 92%                 | bow 20 s, stern 22 s | 89% (from 91%) |
| `sailing-yacht-15m` day out                       | 24    | 4,322  | 5                | 282 l      | 4         | 39%                 | bow 14 s             | 95% (from 97%) |
| `sailing-yacht-9m` day out                        | 24    | 4,322  | none fitted      | none       | 1         | 54%                 | none fitted          | 94% (from 95%) |
| `yacht-12m` day out                               | 24    | 4,322  | 5                | 209 l      | 3         | 85%                 | bow 6 s              | 78% (from 97%) |
| `motor-yacht-20m` on the Miami route              | 24    | 4,322  | 0                | none       | 2         | 92%                 | bow 36 s, stern 26 s | 86% (from 88%) |
| `sailing-yacht-15m` on the Saronic route          | 24    | 4,322  | 2                | 212 l      | 3         | 54%                 | bow 26 s             | 93% (from 97%) |
| `motor-sailer-15m` on the Queensland passage      | 72    | 12,962 | 6                | 632 l      | 5         | 92%                 | bow 28 s             | 33% (from 97%) |
| `hybrid-catamaran-60ft` on the Queensland passage | 72    | 12,962 | 0                | 1,286 l    | 6         | 92%                 | none fitted          | 54% (from 97%) |

The 20 m yacht on the Miami route is alongside for all but four hours of the day, so shore
power and the dock carry it and its generator and water maker have nothing to do; its
day-out case runs both. The 45 m yacht's holding tanks (2 × 2,000 l grey, 2 × 1,500 l black)
do not fill far enough in a day to need emptying. The hybrid catamaran's generator never
starts: by day its sun carries its hotel load, on passage its diesels keep the bank full,
and its 140 kWh bank never falls to its 30 % floor (the fast tests start the generator on a
smaller bank).

## Busy Run

The busy run drives the server hard and reports whether it keeps up. It starts a server
from this checkout with the plugin on a chosen sample, traffic on, at x24, puts a crowd of
clients on it, and measures as it goes. It is a tool, not a test, and is not part of
`npm test`.

### Running One

```shell
bin/simulator-busy <sample> [--hours N] [--multiplier N] [--subscribers N] [--readers N] [--start-at N] [--port N]
```

| Option          | Default | Meaning                                                                    |
| --------------- | ------- | -------------------------------------------------------------------------- |
| `--hours`       | 24      | scenario hours to run                                                      |
| `--multiplier`  | 24      | scenario seconds per real second                                           |
| `--subscribers` | 10      | WebSocket clients subscribed to the full stream                            |
| `--readers`     | 3       | REST clients reading `/signalk/v1/api/vessels`, each once a second         |
| `--start-at`    | 0       | start this many minutes into the route                                     |
| `--port`        | 3100    | the server's HTTP port; the next two take its NMEA 0183 and TCP stream out |

It builds the plugin first. The server runs from `.simulator-busy/` in the checkout
(ignored by git), made fresh on every run, and listens on localhost only; its log and the
run's report go to `simulator/soak/reports/`.

The samples' AIS data covers only part of a day, so a day-long run has traffic for that
part only: Miami from its 14:00 departure to 19:00 UTC, five hours; the Saronic Gulf from
11:00 to 07:00 the next morning, twenty hours; Queensland for the whole day. Use
`--start-at` and `--hours` to run inside the busy part.

### What It Does

1. Starts the server with the plugin disabled, opens the subscribers and starts the
   readers, and waits for the server to go quiet, so the counts start at a known point.
2. Enables the plugin through the Admin UI's plugin config, as a user would.
3. Once a minute of wall time, samples the server process from inside (event loop lag,
   heap after a garbage collection, resident memory, CPU), times the Admin UI's plugin list
   and the vessels tree, and prints a row.
4. At the end, disables the plugin, waits for the subscribers to go quiet for two of the
   server's 5-second statistics intervals (up to 12 minutes, the AIS status plugin's lost
   and remove marks), and compares the counts.

Each row shows:

| Column         | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| scenario time  | the own boat's `navigation.datetime` at the end of the minute                         |
| behind s       | how far the scenario clock fell behind wall time × the multiplier, at worst           |
| own gap s      | the longest wait between two of the own boat's deltas, in wall seconds                |
| server/s       | deltas a second the server handled, from its own statistics                           |
| subscribers/s  | deltas a second each subscriber received, lowest to highest                           |
| lag p99/max ms | the server's event loop delay                                                         |
| heap/rss MiB   | the server's heap after a garbage collection, and its resident memory                 |
| cpu            | the server's share of one core                                                        |
| targets        | AIS targets in range in the plugin's status, and vessels in the tree besides the boat |
| plugins ms     | the Admin UI's plugin list (`/skServer/plugins`)                                      |
| tree ms        | the vessels tree (`/signalk/v1/api/vessels`)                                          |
| readers ms     | the slowest of the readers' requests in the minute                                    |

### When It Fails

The run **fails** (exit code 1) if:

- the scenario clock falls more than 60 s behind wall time × the multiplier;
- any subscriber receives fewer or more deltas than the server handled, has deltas merged
  by the server's backpressure, or is disconnected;
- memory grows without levelling off: the heap's mean over the last quarter of the run is
  more than 10 MiB and 10 % above its mean over the third;
- any answer takes longer than a second, or any request fails.

### Counting Deltas

The server counts a delta as it arrives, before its input handlers, and a handler that drops
a delta drops it after it is counted. The simulator plugin is one: it holds back the AIS
status plugin's marks for targets it has dropped (see
[the AIS README](../ais/README.md#5-losing-a-target)). So a subscriber receives the server's
count less the deltas held back, which the plugin writes to the server log as it stops, and
that is what each subscriber is held to, exactly. The server's statistics come every 5 s,
which is why the counts are taken only once the server is quiet.

### Runs So Far

3 November 2026, on an Apple M3 Ultra (32 cores, 256 GiB) under macOS 27.0.1 with Node
v26.12.1: each sample for a day of scenario time from its departure at x24, traffic on, 10
subscribers and 3 readers. All three passed, and every subscriber received every delta the
server sent.

| Sample       | Deltas Handled | Held Back | Each Subscriber Received | Peak Deltas a Second | Targets in Range, Peak | Event Loop p99, Max | Heap           | Server CPU, Mean and Peak | Slowest Plugin List, Vessels Tree |
| ------------ | -------------- | --------- | ------------------------ | -------------------- | ---------------------- | ------------------- | -------------- | ------------------------- | --------------------------------- |
| Miami        | 110,914        | 28,468    | 82,446                   | 122                  | 508                    | 21 ms, 576 ms       | 178 to 180 MiB | 3 %, 10 %                 | 9 ms, 572 ms                      |
| Saronic Gulf | 84,946         | 20,754    | 64,192                   | 50                   | 209                    | 13 ms, 74 ms        | 259 to 261 MiB | 2 %, 8 %                  | 12 ms, 53 ms                      |
| Queensland   | 59,903         | 13,549    | 46,354                   | 54                   | 234                    | 15 ms, 291 ms       | 188 MiB        | 2 %, 9 %                  | 8 ms, 289 ms                      |

The status count of targets in range agreed with the vessels tree in every minute of every
run, none of the 32,286 reader requests failed, and the own boat never went more than a
second between deltas. The resident memory peaked at 458 to 477 MiB and the heap did not
grow.

**The server did not give out.** At its busiest, Miami's afternoon with 508 targets in range,
it handled 122 deltas a second for 10 subscribers on 10 % of one core, with the event loop's
99th percentile at 21 ms and the slowest answer 103 ms. So there is no limit to report from
this machine: no sample at x24 comes near one, and the busy run would need more
subscribers, more readers or a faster clock to find it. A Raspberry Pi, the server's usual
hardware, has not been tried.

**The one slow moment is the plugin's, at start.** Loading a sample's scenario (its route, the
depth checks of every leg and the AIS tracks) blocks the server's event loop for 74 to 576
ms, once, as the plugin starts; that is the event loop maximum and the slowest tree read in
the table, all in the first minute. It is under the one-second limit and is not repeated.

**The clock column of these runs includes up to one tick of measurement phase.** They printed
how far the clock was behind at the moment each minute row was printed, against a delta up
to a second old, which reads as up to 24 s at x24 (the figures were at most 24 s, 24 s and
16 s). Separately measured, the plugin's own scenario time stays within 2 s of wall time ×
24, the systems model's 2-second step, and reaches clients within a millisecond. The run now
counts lag between deltas only past the tick.

**Losing a target is where the busy run found a fault.** Its first full run on Miami showed the
plugin's count of targets in range parting from the tree after nine minutes, and the tree
filling with bare vessels, each with nothing but an MMSI and an AIS status. The server's AIS
status plugin was marking targets the simulator had already dropped, on its own wall-clock
timers, and each mark brought the vessel back. The plugin now holds those marks back (see
[the AIS README](../ais/README.md#5-losing-a-target)); the held-back column counts them, and
the subscribers are held to the server's count less them.
