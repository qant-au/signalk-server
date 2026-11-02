# Signal K Simulator Plugin

The simulator as a Signal K Server plugin. It sails a sample scenario on the server it runs
in: the own boat on its route, the depth under it, and the AIS traffic it would hear. The
[test rig](../rig/README.md) builds and enables it; its settings are in the Admin UI under
**Server, Plugin Config, Signal K Simulator**.

## Settings

| Setting                                | Default   | What It Does                                                                    |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------- |
| Sample                                 | Miami ICW | which sample to sail (any folder under `simulator/samples` with a `route.json`) |
| Time multiplier                        | 1         | scenario seconds per real second: 1, 2, 5, 10, 20, 24, 30, 60, 120 or 300       |
| Minimum depth under keel               | 1 m       | the route is moved out of water shallower than the boat's draft plus this       |
| Show traffic                           | on        | send the AIS targets the boat would hear                                        |
| Seed                                   | 1         | seed for the boat's systems: the same seed and start repeat a run exactly       |
| Own AIS antenna height                 | 10 m      | the height of the boat's AIS antenna, which sets how far it hears               |
| Start this many minutes into the route | 0         | where a new run starts                                                          |
| Resume where the last run reached      | on        | carry on from the saved scenario time and the boat's systems                    |

Saving the settings restarts the plugin, as with any plugin, and so does restarting the
server. With **resume** on, the run carries on where it had reached: the scenario time,
and the boat's systems with it (tank levels, every bank's state of charge, engine and
generator run hours, solar yield today, which generators are running, the fuel transfer
and the water maker, and the seeded streams behind every drift), so a boat two days into
a passage comes back two days into it, and the run carries on exactly as if it had never
stopped. Changing the time multiplier mid-run therefore speeds up or slows down the same
passage rather than starting again, and engine hours keep counting in scenario time. Both
are saved every ten seconds in the plugin's data directory, in `state.json`, which records
the sample, vessel profile and seed the systems belong to. Change the sample to start the
route from the beginning (or from **Start this many minutes into the route**) with fresh
systems; turn resume off to do the same on the current sample. A different seed, or a
route that now names a different profile, keeps the scenario time and starts the systems
fresh. A saved file that cannot be read, or whose systems no longer fit the profile (a
unit added or removed, an older format), is ignored with a message in the server log,
and the run starts fresh rather than failing.

The status line on the plugin page shows the scenario time, the multiplier, the boat's
speed, the depth under it, how many AIS targets it currently hears, and anything that
limits the run (a leg that could not be cleared of shallow water, or AIS not available on
this machine).

## What It Does

**Route and depth.** At start the plugin loads the sample's route and checks every leg
against the sample's depth grid, every half grid cell. Any stretch that crosses land, or
water shallower than the boat's draft plus the minimum depth under the keel, is re-routed
with a grid search around that stretch alone, and the new path is straightened into as few
legs as stay in safe water. The arcs the boat turns on at waypoints are checked against
the same depth, every five metres, and an arc that would cut a corner over shallow water
or land is tightened until it stays clear; the status line counts them
(`npx ts-node simulator/tools/route.ts turns <sample>` lists them). The adjusted route is
published to the Resources API, so Freeboard shows the passage the boat actually sails.

**Course.** The published route is then made the server's active route through the Course
API, before the boat's first position goes out, at the point the boat is heading for: the
end of its first leg at the start of a run, or wherever a resumed run has reached. So
`navigation.course.*` comes from the server (in the version 1 stream and tree, under
`navigation.courseGreatCircle` and `navigation.courseRhumbline`) and follows the passage: next and previous
point, the active route's `href` and `pointIndex`, and, from the course provider plugin
the server ships with, bearing and distance to the next point, cross track error, time to
go and arrival time. The next point moves on in the tick the boat passes it: halfway round
the arc at a waypoint it turns through, as it comes abeam of it, or as it leaves a hold or
an anchor stop, which stays the next point while the boat lies there. The point index is
always the route model's own leg. Changing the sample, or starting with resume off, sets
the new route's course before the new position goes out, so no display sees the old
destination with the new position. At the end of the route the course is cleared, as an
arrival clears it. Freeboard and any course plugin see the same passage the boat sails.

Marinas are the exception. Berths sit in water shallower than a passage needs, and the
coarser grids cannot see a marina basin or a dredged channel at all, so each sample sets a
harbour radius around its berths: inside it any surveyed water counts, and where the grid
cannot resolve the harbour, so does anywhere it has no data. Charted dry land never does.
Details are in [the routes README](../routes/README.md#depth-and-route-adjustment).

**Identity.** At start the plugin tells the server who the boat is: the name and MMSI
the sample's route gives it (Coquina, 367555210, at Miami; Meltemi, 239555210, in the
Saronic Gulf; Coral Passage, 503555210, in Queensland) and its dimensions from its profile:
length, beam, draft, air height, displacement, AIS ship type and class, and where its AIS
antenna is.
The name, MMSI, length, beam, draft and ship type are fields the server keeps for its own
vessel settings and accepts from nowhere else, so the plugin sets them there, in memory and
never saved, and takes them back when it stops; the rest it sends as itself. Anything the
server's own vessel settings already give (the Admin UI's vessel page, or a name or MMSI in
settings.json) is left alone, and the status line says what was set, sent and left. Details
are in [the vessels README](../vessels/README.md#identity).

**Own boat.** Every second the plugin sends the boat's position, speed and course over
ground and the scenario time (`navigation.datetime`). The boat swings through each waypoint
it passes on an arc at a rate of turn that suits its length and speed, so position, course
and speed agree through the turn. A route without a vessel profile also sends a heading
equal to the course, and the depth under the boat from the grid:
`environment.depth.belowSurface` and `environment.depth.belowKeel` (below surface less the
draft). Depths are relative to the grid's datum (mean sea level, lowest astronomical tide
or the survey datum); tides are not applied yet.

**Navigation.** With a profile, the boat sends what a navigation suite sends around the
position: its navigational state (moored, anchored, sailing or motoring, always in step with
the engines), heading true and magnetic with the magnetic variation for the sample's area
and date, course over ground magnetic, speed through the water against the speed over
ground with a small current, rate of turn and rudder angle, roll and pitch from the boat's
size and the sea, the total and trip logs counting through the water, and a GNSS fix with
its satellites and dilution. Paths and reasoning are in
[the vessels README](../vessels/README.md#navigation). Each send is the state at the
systems model's latest two-second step, position and scenario time included, so the same
scenario time carries the same values at any time multiplier; a faster clock only sends
fewer of them.

**Systems.** When the sample's route names a vessel profile, the boat also sends its
engines, generators, batteries, chargers, solar and wind charging, tanks, wind and the
spaces inside, and each of its depth sounders reports the depth under its own place on the
hull, in place of the single grid depth. Names for every unit go out as metadata when the
run starts. The status line adds how many engines and generators are running. Details, and
the systems that have no standard path, are in [the vessels README](../vessels/README.md).

**Traffic.** Each AIS target in the sample is interpolated along its source track and
transmits at the real rate for its class, speed, status and turning. Each transmission
reaches the boat only if the [reception model](../ais/README.md) says it gets through at
that distance. With every report a target carries its position, course and speed over
ground, heading, rate of turn and navigational state where the source has them, and its AIS
class; every six minutes its name, MMSI, call sign, IMO number, ship type, length, beam,
draught, destination and ETA where the source has them. What the source lacks is left out.
The [AIS README](../ais/README.md#what-each-target-carries) has the whole list. A target not
heard for long enough is lost: the plugin stops sending it and drops it from the server
there and then, rather than leaving it for the server's hour-long prune, so the status
line's "AIS targets in range" is the number of targets in `vessels.*` at that moment. A
target heard again comes back. Sources that do not publish MMSIs (Piraeus, AMSA) get a
stable `urn:mrn:signalk:uuid` identity, never an invented MMSI.

**NMEA 0183 out.** The server sends NMEA 0183 on its TCP port (10110, `NMEA0183PORT`) from
whatever its converters put on its `nmea0183out` event. Two plugins do it:

- **The own boat**: the server's own `@signalk/signalk-to-nmea0183` (Convert Signal K to
  NMEA0183), with RMC, HDT and VTG enabled, once a second each. `bin/simulator` and the rig
  configure it so (`settings/simulator-nmea0183.json`).
- **The AIS targets**: [`signalk-vessels-to-ais`](https://github.com/KEGustafsson/signalk-vessels-to-ais)
  (MIT), which turns the targets in `vessels.*` into `!AIVDM` sentences (messages 3 and 5 for
  Class A, 18 and 24 for Class B) and the own boat into `!AIVDO`, once a minute, out
  to 100 km. The rig installs it (2.1.1) and enables it. For `bin/simulator`, install it into
  the run directory once and restart:

  ```shell
  npm install --prefix .simulator signalk-vessels-to-ais@2.1.1
  ```

  and enable it on the plugin page (Other vessels data to AIS NMEA0183) with the defaults:
  every 1 minute, own data on, 100 km.

The server's other NMEA 0183 output, UDP, is the separate `@signalk/udp-nmea-plugin`, which
sends the same `nmea0183out` event to a UDP address and port; enable it and give it the
plotter's address. The [rig README](../rig/README.md#a-chart-plotter) says how to point a
chart plotter at the rig.

## Building

The rig image builds it, and `bin/simulator` builds it and starts this server with it
enabled on the Miami sample. That script runs the server from its own configuration
directory, `.simulator/` in the checkout (ignored by git), with a fresh copy of
`settings/simulator.json` on every start, because the server writes its defaults back into
the settings file it runs with. The plugin's settings and saved run (scenario time and systems)
persist there between runs; delete `.simulator/` to start over. To build the plugin by hand:

```shell
npx tsc -p simulator/plugin      # writes simulator/plugin/dist
```

The plugin uses only Node's own modules. It finds the samples next to its source
(`simulator/samples`), or wherever `SIGNALK_SIMULATOR_SAMPLES` points, and the vessel
profiles beside them (`simulator/vessels`).
