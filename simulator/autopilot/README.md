# Autopilot

The boat's autopilot, driven through the server's own [Autopilot
API](../../docs/develop/rest-api/autopilot_api.md): the plugin registers as an [autopilot
provider](../../docs/develop/plugins/autopilot_provider_plugins.md) with one device,
`simulator`, so it is the default pilot at
`/signalk/v2/api/vessels/self/autopilots/_default`, and any display that drives a pilot
through the API (KIP's autopilot widget, Freeboard's autopilot controls) drives this one
with no other plugin. `pilot.ts` is the pilot; the plugin's `index.ts` registers it.

## The Provider and the Profiles

A boat of 7 m or more carries an autopilot (`autopilot` in her
[profile](../vessels/README.md#the-profiles), from her length unless the profile says);
the 4 m boat has none, registers nothing, and is hand steered: the helm follows the route.

| Boat                                  | States        | Modes                | Actions                                                    |
| ------------------------------------- | ------------- | -------------------- | ---------------------------------------------------------- |
| A motor boat                          | standby, auto | route, compass       | dodge, course to the current point, course to the next one |
| A sailing boat with a wind instrument | standby, auto | route, compass, wind | the same, and tack and gybe, in wind mode                  |

Every provider method is implemented: `getData`, `getState`, `setState`, `getMode`,
`setMode`, `getTarget`, `setTarget`, `adjustTarget`, `engage`, `disengage`,
`courseCurrentPoint`, `courseNextPoint`, `tack`, `gybe` and `dodge`. What a boat cannot do,
or cannot do now, is refused with a 400 and a message that says why: wind mode on a motor
boat, a tack outside wind mode, a target in route mode (the route sets it). Each change of
state, mode or target, and each alarm, goes to the API's `autopilotUpdate`, which sends the
`steering.autopilot.*` deltas. The server lists a device, and picks its default, only once
the device has sent something, so the pilot sends its state, mode and target as they stand
when a run starts and again after a restart: `GET /autopilots` lists `simulator` as the
default, and the `steering.autopilot` paths are set, before anyone engages it.

## What the Boat Does in Each State

- **Standby.** The helm steers the route: the route follower is the helm.
- **Auto, route mode.** The pilot steers the active route: the same route follower, holding
  the track to within a few metres, turning on its arcs at the waypoints, stopping at the
  holds. The pilot is that follower, not a second one; what it adds are the autopilot's
  alarms, and its target, the course the route has her steer.
- **Auto, compass mode.** She holds the target heading she was given and leaves the route:
  set to compass mode, the target is her heading then. The pilot turns her onto a new target
  at the rate her length and speed allow, about five lengths of turning radius.
- **Auto, wind mode.** She holds the target apparent wind angle (positive to starboard, as
  the specification signs it), her heading following the wind's shifts: the pilot steers for
  the heading that, with the true wind and her speed, puts the apparent wind nearest the
  target. Where none does (in a light air her own speed brings the apparent wind ahead of a
  wide target) she holds the heading that comes nearest rather than turning in search of it,
  and the `wind` alarm says so. Her [polar](../sailing/README.md#wind-mode-and-the-polar)
  keeps her outside the beat: a target inside the polar's beat angle is held at the beat,
  the `wind` alarm saying why. A tack or a gybe turns her through the wind onto the polar's
  angle on her other side (the beat for a tack, the gybe angle for a gybe), the way she is
  told, until the wind is on her other side: a tack to port needs the wind on the port bow,
  a gybe to port the wind on the starboard quarter. Under 3 kn of true wind, wind mode, a
  tack and a gybe are refused, and in wind mode she holds her heading until the wind fills
  in.
- **Dodge.** The rudder is put over by the dodge's angle (positive to starboard, at most
  20°) for as long as it is held, turning her as that rudder would at her speed; the mode is
  `dodge`. Ending it returns her to the mode she was in: compass and wind to their targets,
  route to the route.

Off the route (compass, wind or dodge), she is sailed by dead reckoning: on the heading the
pilot holds and the leeway she makes, at the speed she had on the route, set by the
current, and the route's own
timing stands still. Engaging at the berth or at anchor is refused ("she is alongside her
berth: get under way first", "she is at anchor: weigh first"); the run view and the page
show the refusal, and arriving alongside or anchoring stands the pilot by.

## Leaving and Rejoining the Route

Put back to route mode, or to standby (the helm then rejoins), she steers for the nearest
point of the route ahead of where she left it, 30 seconds of the route further on, so she
joins at an angle rather than square on. On reaching it she is on the route again and its
timing carries on from that point: she is behind the clock by the time she spent off it,
and every hold, anchorage and arrival comes that much later. The run view gives where she
is relative to the route: on it, and how many minutes behind its timing, or rejoining it
and how far ahead the point is. **Course to the current point** engages route mode and,
off the route, makes for the route's next point; **course to the next point** skips it,
steering straight for the point after.

## The Alarms

The pilot raises the API's own alarms, through `autopilotUpdate`, which the server sends as
`notifications.steering.autopilot.<alarm>` under the `simulator` source and holds in the
notifications API.

| Alarm             | When                                                                                                                                                                                                            | State and method                            | Cleared                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `waypointAdvance` | in route mode, 30 seconds before the turn at a waypoint, or the stop at it                                                                                                                                      | alert, sound                                | 30 seconds on, or replaced by the next one            |
| `waypointArrival` | in route mode, abeam of a waypoint halfway round its turn, or on stopping there                                                                                                                                 | alert, sound                                | 30 seconds on                                         |
| `routeComplete`   | in route mode, on arriving at the route's last point                                                                                                                                                            | alert, sound                                | two minutes on                                        |
| `xte`             | in route mode, past 100 m off the track: re-engaged off it, rejoining it                                                                                                                                        | warn, visual and sound                      | back within 80 m                                      |
| `heading`         | in compass mode, more than 20° off the target and not closing on it for 30 seconds, a minute after any change of target; and a pilot fault (below)                                                              | warn, visual and sound; alarm for the fault | within 10°; or the fault cleared                      |
| `wind`            | in wind mode, the apparent wind more than 20° off the target and not closing for 30 seconds, a minute after any change and never through a tack or gybe; and a target inside the polar's beat, held at the beat | warn, visual and sound                      | within 10°; held at the beat, a target set outside it |

Each waypoint's advance and arrival are raised once. On the route the pilot holds the track
to within a few metres, well inside the cross track limit, so `xte` comes only from
re-engaging route mode off the route, and `heading` and `wind` only when something stops her
answering the pilot.

## The Fault

`autopilotFailure` ([the faults README](../faults/README.md#autopilot-failure)), under way
only: the pilot drops out to standby with the `heading` alarm, "Autopilot failure: dropped
out to standby, the helm has her", and the helm takes her back to the route. While it is on,
engaging is refused; cleared, by hand or after 10 to 30 minutes, the alarm goes as `normal`
and the pilot can be engaged again.

## The Paths

| Path                                          | From                     | Value                                                           |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `steering.autopilot.state`                    | the Autopilot API        | `standby` or `auto`                                             |
| `steering.autopilot.mode`                     | the Autopilot API        | `route`, `compass`, `wind` or `dodge`                           |
| `steering.autopilot.target`                   | the Autopilot API        | the target in radians: the heading, or the apparent wind angle  |
| `steering.autopilot.engaged`                  | the Autopilot API        | true in auto                                                    |
| `steering.autopilot.defaultPilot`             | the Autopilot API        | `simulator`                                                     |
| `steering.autopilot.target.headingTrue`       | the simulator, each tick | in route and compass modes, the same target                     |
| `steering.autopilot.target.headingMagnetic`   | the simulator, each tick | the same, less the sample's magnetic variation                  |
| `steering.autopilot.target.windAngleApparent` | the simulator, each tick | in wind mode, the same target                                   |
| `steering.rudderAngle`                        | the simulator            | the rudder the turn needs, the dodge's rudder while one is held |
| `notifications.steering.autopilot.<alarm>`    | the Autopilot API        | the alarms above                                                |

The specification's `steering.autopilot.target.*` and the API's target agree: the API's is
sent whenever it changes, and, in route mode where the route turns it, each time it has
turned half a degree. The specification lists `state` values of its own (`auto` and
`standby` among them) and gives `mode` other values than the API's (`powersave`, `normal`,
`accurate`); the API's values are what the server sends, and the schema checks validate the
simulator's own deltas.

## The Page and REST

The plugin's page has an **Autopilot** card: the state, mode and target, whether she is on
the route, any refusal and the pilot's alarms, and the controls, which go through the
Autopilot API at `/signalk/v2/api/vessels/self/autopilots/_default` exactly as KIP's would:
**Engage** and **Standby**, a button per mode, the target adjusted by 1° and 10° either
way or set to a number of degrees, **Tack** and **Gybe** to port and to starboard on a
sailing boat, and **Dodge** 10° to port or starboard and **End dodge**. The run view
(`GET /plugins/signalk-simulator/run`) carries the same under `autopilot`, and the status
line says "on autopilot, route", "on autopilot, holding 045°", "on autopilot, wind 40° to
port" or "on autopilot, dodging 10° to starboard", and "rejoining the route 0.35 nm ahead"
or "off the route" when she is.

## Tests

`test/simulator-autopilot.ts` checks the provider's data for a motor and a sailing profile
and the 4 m boat's none, each state change and the refusals, the arrival standing the pilot
by, compass mode holding its target within a degree once settled, adjusting the target, wind
mode following a 30° shift, a tack through the wind, the state announced as it stands, a
dodge and its rudder, leaving and rejoining the route with the cross track alarm, a restart
off the route, each waypoint's alarms raised once at the right moment on the Miami route
with the route complete at its end, the heading and wind alarms, the fault, and the schema;
`test/simulator-sailing.ts` checks wind mode against the polar's beat, its tack and gybe
onto the polar's angles, and the calm refusal. The [systems
soak](../soak/README.md#what-it-checks) sails every passage on the pilot in route mode and
every day out by the helm.
