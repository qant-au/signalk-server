# Soak Tests

There are two soaks here, and they answer different questions:

|              | [Rig Soak](#rig-soak)                                                   | [Systems Soak](#systems-soak)                                                                                      |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Question     | does **the server** keep up with a run?                                 | do **the simulated boats** stay believable over days?                                                              |
| Clock        | real time: one scenario second per real second                          | the simulator's controllable clock, 60 scenario seconds per tick; a day of scenario time in about 25 seconds       |
| Runs against | a running server (the [test rig](../rig/README.md)), over its WebSocket | nothing: the simulator's own code, in the test process                                                             |
| Covers       | the own boat's navigation data on one sample route                      | every vessel profile and every system on board, for a day each, and the motor-sailer's three-day passage           |
| Checks       | sends succeed, positions read back, response time, server memory        | every value in a band for its kind, no gaps, schema-valid deltas, and the systems behaving as they should together |
| Command      | `npx ts-node simulator/tools/soak.ts <sample>`                          | `npm run test:simulator-soak`                                                                                      |
| Takes        | as long as you ask it to run                                            | about five minutes                                                                                                 |
| Run it       | after a change to how the plugin or the server handles deltas           | after a change to a vessel profile or the systems model                                                            |

Neither is part of `npm test`. The fast systems tests (`test/simulator-systems.ts`, a few
seconds) run there and check one of each shape; the systems soak runs the same model for
days and checks everything it sends.

## Rig Soak

A rig soak sails a sample's route on the [test rig](../rig/README.md) and checks that the
server keeps up for the length of the run. It runs in **real time only** (one scenario
second per real second) and drives **the own boat only**. AIS traffic, faster-than-real
time and full-route runs come next.

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
2. Sends the boat's name, length and AIS ship type once.
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
npm run test:simulator-soak                          # every case, about five minutes
SOAK_CASES=motor-sailer npm run test:simulator-soak  # only the cases whose name contains this
```

### The Cases

| Case                             | Profiles                                                                                                    | Where and when                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A day out, 24 hours              | all but the motor-sailer, each at a sample's berth: Miami, the Saronic Gulf or Manly, on that sample's date | by local solar time: the night at anchor, out at 07:30, cruising at 60% of top speed, a lunch stop at anchor from 11:30 to 14:30, cruising back, alongside from 18:00. It covers anchor, harbour speed, cruising and shore power in one day |
| The Miami route, 24 hours        | `motor-yacht-20m`                                                                                           | the sample's real passage, from local midnight: alongside, the passage through the bridges, alongside again                                                                                                                                 |
| The Saronic route, 24 hours      | `sailing-yacht-15m`                                                                                         | the sample's overnight passage under sail, from two hours before it leaves                                                                                                                                                                  |
| The Queensland passage, 72 hours | `motor-sailer-15m`                                                                                          | Manly to Hamilton Island, from two hours before it leaves: three days under way                                                                                                                                                             |

The sounders read a synthetic seabed that rises and falls, so the soak needs no depth
download.

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

At the end it prints a table of what each case did: deltas validated, generator starts,
water made, pump-outs, the lowest house state of charge, and the fuel left.

### What It Found

Over its first runs the soak found these. Each was fixed at its cause; none by widening a
band:

| Found                                                                                       | Cause                                                                                                              | Fix                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 4 m boat's depth sounder was below its keel (transducer 0.5 m, draft 0.3 m)             | the default transducer depth was a fixed 0.5 m                                                                     | the default is now 80% of the draft, at most 0.5 m                                                                                                                       |
| The motor-sailer's port tank ran dry 15 hours into its passage with the starboard tank full | an engine drew from its own tank until it was empty                                                                | below 15% a storage tank is changed for the fullest one, as a crew changes tanks                                                                                         |
| Then both tanks ran dry 30 hours in, on a 68-hour passage                                   | the profile could not make the passage: a 150 kW engine at 8.5 kn burns about 23 l/h against 800 l of fuel         | the profile is now 110 kW (150 HP) with 2 × 900 l, as a passage-making motor-sailer carries; boats start with their storage tanks 85 to 98% full                         |
| One of the 45 m yacht's two solar arrays gave nothing in daylight                           | the first array on a bank took all the bank wanted                                                                 | arrays on one bank share it in proportion to what each could give                                                                                                        |
| Air conditioning load stopped following the temperature on a 33 °C Saronic afternoon        | the load reached its maximum at 30 °C                                                                              | it rises from 22 °C to its maximum at 36 °C                                                                                                                              |
| The hybrid catamaran's charger carried 360 A (1 C) into its propulsion bank                 | it cruised at 9.6 kn on electric alone, emptied the bank in an hour, then ran on the generator through the charger | electric alone only up to 20% of the motor's rating (about 7 kn) and above 40% charge, so the diesel takes over first; chargers are rated at the bank's full charge rate |
| The hybrid's diesels reported 450 V as their alternator voltage                             | the alternator voltage was read from the engine's own bank, the propulsion bank for a hybrid                       | a hybrid's diesel has a low-voltage alternator like any other, charging the start or house bank                                                                          |
| The catamaran's solar gave nothing on a morning under diesel                                | the house bank's loads were carried by the alternator before the converter from the propulsion bank was offered    | the house hangs off the propulsion bus ahead of any alternator                                                                                                           |
| Wind angles of −3.142, just outside −π                                                      | rounding to three decimals                                                                                         | angles are kept inside −π to π after rounding                                                                                                                            |

Three failures were the soak's own: its gap check started from a slow delta, it expected
the Miami passage (alongside most of the day, where the dock fills the tanks) to make water,
and it compared solar output, which is sent in whole watts, with the sun to a millionth of
a watt.

The soak also needed behaviour the model did not have: lying at anchor (a waypoint may now
be marked `anchor`), a water maker, generators that run for meals at anchor and for the
water maker, fresh water from the dock and the pump-out station at a berth, and grey water
going overboard away from a berth.

### Runs So Far

2 November 2026: 14 checks passing in 5 minutes, 60,504 deltas validated. Generator starts
count each time one more generator is running.

| Case                                         | Hours | Deltas | Generator starts | Water made | Pump-outs | Lowest house charge | Fuel left      |
| -------------------------------------------- | ----- | ------ | ---------------- | ---------- | --------- | ------------------- | -------------- |
| `boat-4m` day out                            | 24    | 4,322  | none fitted      | none       | none      | no house bank       | 63% (from 95%) |
| `electric-launch-7m` day out                 | 24    | 4,322  | none fitted      | none       | none      | propulsion only     | no fuel        |
| `hybrid-catamaran-60ft` day out              | 24    | 4,322  | 3                | 389 l      | 3         | 92%                 | 89% (from 97%) |
| `motor-yacht-20m` day out                    | 24    | 4,322  | 2                | 267 l      | 2         | 72%                 | 64% (from 88%) |
| `motor-yacht-34m` day out                    | 24    | 4,322  | 1                | 1,376 l    | 2         | 92%                 | 85% (from 88%) |
| `motor-yacht-45m` day out                    | 24    | 4,322  | 2                | 2,171 l    | 0         | 92%                 | 89% (from 91%) |
| `sailing-yacht-15m` day out                  | 24    | 4,322  | 5                | 282 l      | 4         | 47%                 | 96% (from 97%) |
| `sailing-yacht-9m` day out                   | 24    | 4,322  | none fitted      | none       | 1         | 58%                 | 94% (from 95%) |
| `yacht-12m` day out                          | 24    | 4,322  | 5                | 209 l      | 3         | 85%                 | 79% (from 97%) |
| `motor-yacht-20m` on the Miami route         | 24    | 4,322  | 0                | none       | 2         | 92%                 | 86% (from 88%) |
| `sailing-yacht-15m` on the Saronic route     | 24    | 4,322  | 2                | 212 l      | 3         | 58%                 | 93% (from 97%) |
| `motor-sailer-15m` on the Queensland passage | 72    | 12,962 | 6                | 632 l      | 5         | 92%                 | 33% (from 97%) |

The 20 m yacht on the Miami route is alongside for all but four hours of the day, so shore
power and the dock carry it and its generator and water maker have nothing to do; its
day-out case runs both. The 45 m yacht's holding tanks (2 × 2,000 l grey, 2 × 1,500 l black)
do not fill far enough in a day to need emptying.
