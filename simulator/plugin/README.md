# Signal K Simulator Plugin

The simulator as a Signal K Server plugin. It sails a sample scenario on the server it runs
in: the own boat on its route with its systems and their [faults](../faults/README.md), the
depth under it, and the AIS traffic it would hear. The [test rig](../rig/README.md) builds
and enables it; its settings are in the Admin UI under **Server, Plugin Config, Signal K
Simulator**, and the run itself can be watched and steered on its page or through its REST
surface ([Controlling the Run](#controlling-the-run)).

## Settings

| Setting                                   | Default   | What It Does                                                                                                                         |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sample                                    | Miami ICW | which sample to sail (any folder under `simulator/samples` with a `route.json`)                                                      |
| Time multiplier                           | 1         | scenario seconds per real second: 1, 2, 5, 10, 20, 24, 30, 60, 120 or 300                                                            |
| Minimum depth under keel                  | 1 m       | the route is moved out of water shallower than the boat's draft plus this                                                            |
| Shallow water alarm                       | 1.5 m     | the depth sounder's shallow alarm: raised below this depth under the keel, cleared 0.3 m deeper                                      |
| Collision alarm: closest approach         | 15 m      | a moving target whose closest approach comes inside this, within the time below, raises a warning, and an alarm within half the time |
| Collision alarm: time to closest approach | 1 min     | the time limit for the collision alarm                                                                                               |
| Show traffic                              | on        | send the AIS targets the boat would hear                                                                                             |
| Seed                                      | 1         | seed for the boat's systems: the same seed and start repeat a run exactly                                                            |
| Faults a day                              | 0         | faults the seed throws on its own, on average, per day of scenario time                                                              |
| Own AIS antenna height                    | 10 m      | the height of the boat's AIS antenna, which sets how far it hears                                                                    |
| Start this many minutes into the route    | 0         | where a new run starts                                                                                                               |
| Resume where the last run reached         | on        | carry on from the saved scenario time and the boat's systems                                                                         |

Saving the settings restarts the plugin, as with any plugin, and so does restarting the
server. With **resume** on, the run carries on where it had reached: the scenario time,
and the boat's systems with it, faults included (tank levels, every bank's state of
charge, engine and generator run hours, solar yield today, which generators are running,
the fuel transfer and the water maker, and the seeded streams behind every drift), so a
boat two days into a passage comes back two days into it, and the run carries on exactly
as if it had never stopped. Changing the time multiplier mid-run therefore speeds up or
slows down the same passage rather than starting again, and engine hours keep counting in
scenario time. Both are saved every ten seconds in the plugin's data directory, in
`state.json`, which records the sample, vessel profile and seed the systems belong to.
Change the sample to start the route from the beginning (or from **Start this many minutes
into the route**) with fresh systems; turn resume off to do the same on the current sample.
A different seed, or a route that now names a different profile, keeps the scenario time
and starts the systems fresh. A saved file that cannot be read, or whose systems no longer
fit the profile (a unit added or removed, an older format), is ignored with a message in
the server log, and the run starts fresh rather than failing.

The status line on the plugin page shows whether the run is under way, paused or arrived,
the scenario time, the multiplier, the boat's speed, the depth under it, how many AIS
targets it currently hears, the faults on board, the alarms on board with their state,
the collision alarms among them ("alarms: Shallow water (alarm), LUCY GOOSE: closest
approach alarm (alarm)"), and anything that limits the run (a leg that could not be
cleared of shallow water, or AIS not available on this machine).

**Shallow water alarm** is the depth sounder's own alarm, raised as
`notifications.environment.depth.belowKeel` when the depth under the keel is below it and
cleared once the water is 0.3 m deeper. It is separate from the **minimum depth under
keel**, which only moves the route, so a passage kept a metre off the bottom can still
sound it, as a real one does. The default, 1.5 m, throws it a few times on the Miami
sample's passage; where is in [the vessels README](../vessels/README.md#alarms), with the
zones every other alarm comes from.

**Faults a day** has the seed throw faults on its own at that average rate, each a random
fault on a random target, the same ones at the same times for the same seed and start.
At 0 (the default) there are none but those raised by hand. What each fault does is in
[the faults README](../faults/README.md).

## Controlling the Run

A tester can script a scenario without the plugin's settings: the plugin serves a REST
surface under its own path, `/plugins/signalk-simulator`, and a page in the Admin UI that
uses it.

| Method and Path                  | What It Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /run`                       | the run: sample and route, the boat, the clock (scenario time, multiplier, paused, departure and arrival, minutes into the route), position and state, next route point, depth, the systems' headline state, the targets in range (100 of them, in the order of a plotter's danger list: those inside the collision alarm's limits soonest first, then the other closing ones by closest approach, then the rest by range), each with its closest approach and the time to it while it is closing, the faults on board, and the alarms on board |
| `PUT /run`                       | changes the run and answers with it: any of `paused` (true or false), `timeMultiplier` (above 0, up to 3600), and one of `time` (ISO 8601) or `minutesIntoRoute`, to jump along the route                                                                                                                                                                                                                                                                                                                                                       |
| `GET /faults`                    | `available`: each fault this boat can have, with its title, description, targets and how long it lasts; `active`: the faults on board                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /faults`                   | raises a fault, `{"kind": ..., "target": ...}`; the target defaults to the first the boat has. Answers 201 with the fault                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DELETE /faults/<kind>/<target>` | clears a fault by hand; it winds down as it would                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

A fault on board carries its `id` (`kind:target`), `title`, whether it was raised `by`
hand or the seed, when it was raised (`raisedMs`), when it clears on its own (`clearsMs`)
or was cleared (`clearedMs`, `clearedBy`), its `phase` (`developing`, or `clearing` while
its effects wind down) and its `course` in a few words ("coolant 110 °C, oil 1.5 bar").
A request the run cannot meet answers 400 with `{"error": ...}` (an unknown fault or
target, one already on, a time outside the route), and 503 while the plugin is loading.

**Pausing** holds the scenario clock where it is: the boat keeps sending the same moment,
as if time had stopped. **The multiplier** changes from the scenario time reached,
so the passage speeds up or slows down without starting again. Both last until the plugin
restarts; set the multiplier in the settings to keep it. **Jumping** forward runs the
systems and faults through every step to the new time, as if the boat had sailed it, and
the receiver hears the traffic afresh from there; jumping back starts the run again at the
earlier time with fresh systems and faults, keeping the clock's multiplier and pause. A
jump must land between departure and arrival.

```shell
SIM=http://localhost:3000/plugins/signalk-simulator
JSON='Content-Type: application/json'

curl $SIM/run                                                  # where the run is
curl -X PUT $SIM/run -H "$JSON" -d '{"paused":true}'           # pause
curl -X PUT $SIM/run -H "$JSON" -d '{"paused":false,"timeMultiplier":60}'
curl -X PUT $SIM/run -H "$JSON" -d '{"minutesIntoRoute":90}'   # jump along the route
curl -X PUT $SIM/run -H "$JSON" -d '{"time":"2024-03-16T17:00:00Z"}'

curl $SIM/faults                                               # available and active
curl -X POST $SIM/faults -H "$JSON" -d '{"kind":"gnssLost"}'   # lose the fix
curl -X DELETE $SIM/faults/gnssLost/gnss                       # and regain it
```

A scenario script is then a sequence of these: jump to the stretch of interest, raise a
fault, let it run at a known multiplier, read what an alarm plugin made of it from the
server's own notifications API (`GET /signalk/v2/api/notifications`), clear it.

Reading is open to read-only users and the controls to read/write users, where the server's
security is on; with security off, as on the rig, anyone who can reach the server can.

**The page.** The plugin is also an embedded webapp: **Webapps, Signal K Simulator** in the
Admin UI opens it inside the Admin UI's own frame (at `/admin/#/e/signalk-simulator`). It
shows the run (the boat, the scenario time and how far along the route, the multiplier and
whether it is paused), where the boat is, the systems' headline state, the faults on board
with their course, and the targets in range, refreshed every two seconds: Targets in Range
lists them as a plotter's danger list does: first the targets whose closest approach (CPA)
is inside the collision alarm's limits, soonest first; then the other closing targets, by
how close they come, nearest first; then those not closing, by range. Each closing target
shows its CPA and the time to it (TCPA, minutes and seconds). Ranking every closing target
by time alone would put a boat passing 3.9 km off in a minute above one passing 339 m off
in two. Its
buttons are the same controls as the REST surface: pause and resume, the multiplier, a jump
to a number of minutes into the route, and raising and clearing faults. It is built on the
Admin UI's own React and styles, so it needs nothing beyond the plugin's own build.

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
`navigation.courseGreatCircle` and `navigation.courseRhumbline`) and follows the passage:
next and previous point, the active route's `href` and `pointIndex`, and, from the course
provider plugin the server ships with, bearing and distance to the next point, cross track
error, time to go and arrival time. The next point moves on in the tick the boat passes
it: halfway round the arc at a waypoint it turns through, as it comes abeam of it, or as it
leaves a hold or an anchor stop, which stays the next point while the boat lies there. The
point index is always the route model's own leg. Changing the sample, or starting with
resume off, sets the new route's course before the new position goes out, so no display
sees the old destination with the new position. At the end of the route the course is
cleared, as an arrival clears it. Freeboard and any course plugin see the same passage the
boat sails.

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
line's "AIS targets in range" is the number of targets in `vessels.*` at that moment. The
server's AIS status plugin would bring a dropped target back with its `lost` and `remove`
marks, so the plugin holds back deltas from other sources for a dropped target, and the
status line counts them ("deltas for lost targets held back"). A target heard again comes
back. Sources that do not publish MMSIs (Piraeus, AMSA) get a
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
the settings file it runs with. The plugin's settings and saved run (scenario time, systems
and faults) persist there between runs; delete `.simulator/` to start over. To build the
plugin by hand:

```shell
npx tsc -p simulator/plugin          # writes simulator/plugin/dist
npx tsc -p simulator/plugin/webapp   # writes simulator/plugin/public, the page
```

To see whether the server keeps up with the plugin at x24 with its traffic and a crowd of
clients, run the [busy run](../soak/README.md#busy-run), `bin/simulator-busy <sample>`; the
two soaks beside it test the server in real time and the simulated boats over days.

The plugin uses only Node's own modules. It finds the samples next to its source
(`simulator/samples`), or wherever `SIGNALK_SIMULATOR_SAMPLES` points, and the vessel
profiles beside them (`simulator/vessels`).
