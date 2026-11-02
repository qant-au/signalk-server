# Signal K Simulator Plugin

The simulator as a Signal K Server plugin. It sails a sample scenario on the server it runs
in: the own boat on its route, the depth under it, and the AIS traffic it would hear. The
[test rig](../rig/README.md) builds and enables it; its settings are in the Admin UI under
**Server, Plugin Config, Signal K Simulator**.

## Settings

| Setting                                | Default   | What It Does                                                                    |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------- |
| Sample                                 | Miami ICW | which sample to sail (any folder under `simulator/samples` with a `route.json`) |
| Time multiplier                        | 1         | scenario seconds per real second: 1, 2, 5, 10, 20, 30, 60, 120 or 300           |
| Minimum depth under keel               | 1 m       | the route is moved out of water shallower than the boat's draft plus this       |
| Show traffic                           | on        | send the AIS targets the boat would hear                                        |
| Seed                                   | 1         | seed for the boat's systems: the same seed and start repeat a run exactly       |
| Own AIS antenna height                 | 10 m      | the height of the boat's AIS antenna, which sets how far it hears               |
| Start this many minutes into the route | 0         | where a new run starts                                                          |
| Resume where the last run reached      | on        | carry on from the saved scenario time                                           |

Saving the settings restarts the plugin, as with any plugin. With **resume** on, the run
carries on from the scenario time it had reached, so changing the time multiplier mid-run
speeds up or slows down the same passage rather than starting again. The scenario time is
saved every ten seconds in the plugin's data directory. Change the sample, or turn resume
off, to start from the beginning (or from **Start this many minutes into the route**).

The status line on the plugin page shows the scenario time, the multiplier, the boat's
speed, the depth under it, how many AIS targets it currently hears, and anything that
limits the run (a leg that could not be cleared of shallow water, or AIS not available on
this machine).

## What It Does

**Route and depth.** At start the plugin loads the sample's route and checks every leg
against the sample's depth grid, every half grid cell. Any stretch that crosses land, or
water shallower than the boat's draft plus the minimum depth under the keel, is re-routed
with a grid search around that stretch alone, and the new path is straightened into as few
legs as stay in safe water. The adjusted route is published to the Resources API, so
Freeboard shows the passage the boat actually sails.

Marinas are the exception. Berths sit in water shallower than a passage needs, and the
coarser grids cannot see a marina basin or a dredged channel at all, so each sample sets a
harbour radius around its berths: inside it any surveyed water counts, and where the grid
cannot resolve the harbour, so does anywhere it has no data. Charted dry land never does.
Details are in [the routes README](../routes/README.md#depth-and-route-adjustment).

**Own boat.** Every second the plugin sends the boat's position, speed and course over
ground, heading, the scenario time (`navigation.datetime`), and the depth under it from the
grid: `environment.depth.belowSurface` and `environment.depth.belowKeel` (below surface less
the draft). Depths are relative to the grid's datum (mean sea level, lowest astronomical tide
or the survey datum); tides are not applied yet.

**Systems.** When the sample's route names a vessel profile, the boat also sends its
engines, generators, batteries, chargers, solar and wind charging, tanks, wind and the
spaces inside, and each of its depth sounders reports the depth under its own place on the
hull, in place of the single grid depth. Names for every unit go out as metadata when the
run starts. The status line adds how many engines and generators are running. Details, and
the systems that have no standard path, are in [the vessels README](../vessels/README.md).

**Traffic.** Each AIS target in the sample is interpolated along its source track and
transmits at the real rate for its class and speed. Each transmission reaches the boat only
if the [reception model](../ais/README.md) says it gets through at that distance. Targets
are sent with position, speed, course and heading, and every six minutes with their name,
MMSI, length, ship type and AIS class. A target not heard for long enough is lost and is no
longer sent. Sources that do not publish MMSIs (Piraeus, AMSA) get a stable `urn:mrn:signalk:uuid`
identity, never an invented MMSI.

## Building

The rig image builds it, and `bin/simulator` builds it and starts this server with it
enabled on the Miami sample. That script runs the server from its own configuration
directory, `.simulator/` in the checkout (ignored by git), with a fresh copy of
`settings/simulator.json` on every start, because the server writes its defaults back into
the settings file it runs with. The plugin's settings and saved scenario time persist there
between runs; delete `.simulator/` to start over. To build the plugin by hand:

```shell
npx tsc -p simulator/plugin      # writes simulator/plugin/dist
```

The plugin uses only Node's own modules. It finds the samples next to its source
(`simulator/samples`), or wherever `SIGNALK_SIMULATOR_SAMPLES` points, and the vessel
profiles beside them (`simulator/vessels`).
