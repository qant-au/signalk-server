# Soak Tests

A soak test sails a sample's route on the [test rig](../rig/README.md) and checks that the
server keeps up for the length of the run. This is the starting point for the simulator: it
runs in **real time only** (one scenario second per real second) and drives **the own boat
only**. AIS traffic, faster-than-real time and full-route runs come next.

## Running One

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

## What It Does

1. Publishes the route to the server's Resources API, so Freeboard draws it.
2. Sends the boat's name, length and AIS ship type once.
3. Every second, works out where the boat is on its route at that moment of the scenario and
   sends its position, speed over ground, course and heading, and the scenario time, as one
   Signal K delta over the server's WebSocket stream. Deltas carry the wall-clock time they
   are sent, so plugins that check data age treat them as live; the scenario's time goes in
   `navigation.datetime`, where a GNSS receiver puts it.
4. Every 10 seconds, reads the position back over HTTP and checks it is within 1 m of one of
   the last few positions sent, times the read, and samples the server container's memory.

## What It Reports

The console shows a summary; the full run, with every check, is written as JSON to
`simulator/soak/reports/` (ignored by git). The run **fails** (exit code 1) if any send fails,
the position read back is wrong or the server does not answer, or the route cannot be
published. Memory is reported (first, last and peak) but not yet judged: how much growth over
a long run counts as a leak is for the full-route soak tests to decide.

## Runs So Far

| Run                                            | Result                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Miami, 2 min from 30 min into the route        | passed: 120 deltas, 12 checks, read-back error 0.00 m, no reconnects                               |
| Queensland, 4 min from 10 hours into the route | passed: 240 deltas, 24 checks, read-back error 0.00 m, no reconnects; server memory 226 to 245 MiB |
