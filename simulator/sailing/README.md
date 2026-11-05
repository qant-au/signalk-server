# Sailing and the Current

How the boat moves through the water rather than over the ground: the tidal or ocean current
under her, and, on a sailing boat, her sails, her polar, the leeway she makes, and whether
she sails, motor-sails or motors. `polar.ts` reads a polar; `sailing.ts` keeps the sail
plan; the systems model (`simulator/systems`) uses both in its two-second steps, and the
navigation turns them into headings and speeds.

## The Current

The current acts on the water, not the track. The route gives her course and speed over the
ground; the current gives the heading she holds against it and her speed through the water.
Off the route (the autopilot's compass, wind and dodge modes), she is sailed by dead
reckoning on her heading and speed through the water, and the current sets her as it runs.

The current comes from the sample's files the way the tide does: each source a station, read
in time between its readings and blended between stations by inverse distance squared, as a
vector, holding the first or last reading past the edges of the data (see
[weather](../weather/README.md#interpolation)).

| Sample     | Current                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miami      | CO-OPS current predictions, 6-minute, at Miami Harbor Entrance (Government Cut, MIH0901, 8 ft bin) and Port Everglades 17th Street Bridge on the ICW (PEV0903, 6 ft bin): the flood and ebb along each station's major axis |
| Queensland | Open-Meteo's ocean current (MeteoFrance SMOC), hourly at the 9 marine points, in the marine file beside the sea level                                                                                                       |
| Saronic    | none in the sample: a seeded current, a tenth to four tenths of a knot, setting in a seeded direction and wandering slowly about both                                                                                       |

A CO-OPS prediction gives the speed along the channel's major axis, positive on the flood
and negative on the ebb, with each station's mean flood and ebb direction; the simulator
reads it as running towards the flood direction at the flood speed, or the ebb direction at
the ebb speed. Open-Meteo gives the speed in km/h and the direction the current runs
towards. On Miami's passage the flood at Government Cut runs at up to 1.7 kn setting 293°
between 15:00 and 17:00 UTC, blended with the 17th Street Bridge's much weaker current
further north.

`environment.current` carries the current as the specification has it: `drift` in m/s,
`setTrue` (the direction it runs towards) and `setMagnetic` where the sample has the
magnetic variation, every five seconds. The course provider keeps its own values:
`velocityMadeGoodToWaypoint` is left to it.

## The Sails

A sailing profile lists its sails under `sails`, each with an id (the key under
`sails.inventory`), a name, a type, an area, and the true wind it is set in. A reef is an
entry of the main's type with the area the reef leaves. Of each type, the largest entry
whose wind range takes the true wind is set: full sail to a fresh breeze (Beaufort 5, to 21
kn), reefed above it, and nothing she cannot carry.

| Profile             | Sail                     | Type  | Area  | True wind   |
| ------------------- | ------------------------ | ----- | ----- | ----------- |
| `sailing-yacht-15m` | `main`, Main             | main  | 62 m² | 0 to 21 kn  |
|                     | `mainReef1`, first reef  | main  | 47 m² | 18 to 27 kn |
|                     | `mainReef2`, second reef | main  | 33 m² | 24 to 34 kn |
|                     | `genoa`, Genoa           | genoa | 70 m² | 0 to 27 kn  |
| `sailing-yacht-9m`  | `main`, Main             | main  | 21 m² | 0 to 21 kn  |
|                     | `jib`, Jib               | jib   | 17 m² | 0 to 30 kn  |

So the 15 m yacht carries her main and genoa to 21 kn, the first reef and the genoa to 27
kn, and the second reef alone to 34 kn; the 9 m yacht, with no reef, carries her jib alone
above 21 kn. `sails.area.total` is the full sail plan (the largest of each type: 132 m² and
38 m²) and `sails.area.active` the area set, nothing alongside, at anchor or under power.

## The Polars

Each sailing profile carries a polar: her speed through the water, knots, at each true wind
speed (columns) and true wind angle (rows), in `polar` in the profile's file. It is read
linearly between its points; below its lightest wind the speed falls in proportion to
nothing in a calm, above its strongest it holds, and inside its closest angle (30°) the
sails do not draw and it gives nothing.

`sailing-yacht-15m`, a 15 m cruising yacht with a hull speed near 9 kn:

| TWA \ TWS | 4   | 6   | 8   | 10  | 12  | 16  | 20  | 25   |
| --------- | --- | --- | --- | --- | --- | --- | --- | ---- |
| 30°       | 1.6 | 2.6 | 3.4 | 4.0 | 4.4 | 4.8 | 4.9 | 4.8  |
| 38°       | 2.6 | 3.9 | 5.0 | 5.8 | 6.3 | 6.8 | 7.0 | 6.9  |
| 45°       | 3.1 | 4.5 | 5.7 | 6.5 | 7.0 | 7.5 | 7.7 | 7.6  |
| 52°       | 3.5 | 5.0 | 6.2 | 7.0 | 7.4 | 7.9 | 8.1 | 8.0  |
| 60°       | 3.8 | 5.4 | 6.6 | 7.3 | 7.7 | 8.2 | 8.4 | 8.4  |
| 75°       | 4.0 | 5.7 | 6.9 | 7.6 | 8.0 | 8.5 | 8.8 | 8.9  |
| 90°       | 4.1 | 5.8 | 7.0 | 7.7 | 8.1 | 8.7 | 9.1 | 9.3  |
| 110°      | 4.0 | 5.7 | 6.9 | 7.7 | 8.2 | 8.9 | 9.4 | 9.8  |
| 120°      | 3.8 | 5.5 | 6.7 | 7.5 | 8.1 | 8.9 | 9.6 | 10.1 |
| 135°      | 3.4 | 5.0 | 6.3 | 7.1 | 7.7 | 8.6 | 9.4 | 10.2 |
| 150°      | 2.9 | 4.4 | 5.6 | 6.5 | 7.2 | 8.1 | 8.9 | 9.8  |
| 165°      | 2.6 | 3.9 | 5.1 | 6.0 | 6.7 | 7.6 | 8.4 | 9.2  |
| 180°      | 2.4 | 3.6 | 4.8 | 5.7 | 6.4 | 7.3 | 8.1 | 8.9  |

`sailing-yacht-9m`, a 9 m cruising yacht with a hull speed near 6.5 kn:

| TWA \ TWS | 4   | 6   | 8   | 10  | 12  | 16  | 20  | 25  |
| --------- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30°       | 1.2 | 2.0 | 2.6 | 3.0 | 3.3 | 3.5 | 3.5 | 3.4 |
| 38°       | 2.0 | 3.0 | 3.8 | 4.4 | 4.7 | 5.0 | 5.1 | 5.0 |
| 45°       | 2.4 | 3.5 | 4.4 | 4.9 | 5.2 | 5.5 | 5.6 | 5.5 |
| 52°       | 2.7 | 3.9 | 4.7 | 5.2 | 5.5 | 5.8 | 5.9 | 5.8 |
| 60°       | 2.9 | 4.1 | 5.0 | 5.5 | 5.8 | 6.0 | 6.1 | 6.1 |
| 75°       | 3.1 | 4.4 | 5.2 | 5.7 | 6.0 | 6.3 | 6.4 | 6.4 |
| 90°       | 3.2 | 4.5 | 5.3 | 5.8 | 6.1 | 6.4 | 6.6 | 6.7 |
| 110°      | 3.1 | 4.4 | 5.3 | 5.8 | 6.1 | 6.5 | 6.8 | 7.0 |
| 120°      | 3.0 | 4.2 | 5.1 | 5.7 | 6.0 | 6.5 | 6.9 | 7.2 |
| 135°      | 2.7 | 3.9 | 4.8 | 5.4 | 5.8 | 6.3 | 6.7 | 7.1 |
| 150°      | 2.3 | 3.4 | 4.3 | 5.0 | 5.4 | 5.9 | 6.3 | 6.8 |
| 165°      | 2.0 | 3.0 | 3.9 | 4.6 | 5.1 | 5.6 | 6.0 | 6.5 |
| 180°      | 1.9 | 2.8 | 3.7 | 4.4 | 4.9 | 5.4 | 5.8 | 6.3 |

From the table, at each true wind speed: the **beat angle**, the angle from 30° to 90° that
makes the most towards the wind (speed × cos angle), with its speed and velocity made good;
and the **gybe angle**, the angle from 90° to 180° that makes the most away from it. For the
15 m yacht the beat is 45° in 6 kn of wind, 42.5° in 10 kn and 39.5° in 16 kn, and the gybe
155.5° in 6 kn to 171.5° in 16 kn: she points higher as the breeze freshens, and runs deep,
as a cruiser does.

## Sail or Motor

On each leg she needs a speed through the water: the route's speed over the ground less the
current. Her polar gives what the sails make at the true wind's angle to her track through
the water:

- **Under sail** when the polar gives the leg's speed or near it (85 % of it or more): the
  sails set, the engine stopped, `navigation.state` `sailing`.
- **Motor-sailing** when it gives some of it (50 % to 85 %): the sails set and the engine
  running, which makes up the speed the sails do not give; `navigation.state` is
  `motoring`, as the collision regulations count a vessel under sail and power.
- **Motoring** otherwise, the sails down: in a calm, dead to windward, below 1.5 kn through
  the water, and within 300 m of a stop (a berth, an anchorage, a hold), coming or going.

She gets under way under power, and a change waits until it has been wanted for five
minutes, as a crew would, so a gust or a lull does not start and stop the engine. Stopping,
and handing the sails coming in to a stop, are done at once. The engine's power, when it
runs, goes with the leg's speed cubed less the polar's speed cubed (the propeller law), so
motor-sailing burns less than motoring.

On the Saronic, with the sample as downloaded (ERA5 and the dataset's GFS grid together),
the passage leaving Zea at 14:00 local is under sail or motor-sailing through the
afternoon's 4 to 7 kn northerly, motors through the calm near 16:00 local, and motors the
next morning's legs, which run dead to windward. The 10 kn sea breeze ERA5 shows off Piraeus
at 14:00 to 15:00 UTC is not in the pooled wind: the GFS grid's 45 points outweigh ERA5's 5
and give 4 to 5 kn from the north-east there, so the boat does not see it.

## Heel and Leeway

**Heel** follows the sails she has set, motor-sailing too: it grows with the apparent wind's
pressure (its speed squared) and the area of sail set as a share of the full plan, so a reef
takes some of it off; it is hardest from close-hauled to abeam and least running, up to 20°.
With the sails down she does not heel; the sea still rolls her.

**Leeway** grows with the heel and falls with the square of her speed through the water: 10
× heel / speed² degrees (the speed taken at 2 kn or more), up to 10°. A 14° heel at 6 kn
gives about 4°. Under power, with no sails set, she makes none. Leeway is positive when she
slides to starboard, with the wind on her port side, as her heel is: the helm holds her
heading up to windward of her track through the water by as much, so off the route the
pilot's dead reckoning moves her along her heading plus her leeway.

`navigation.speedThroughWaterLongitudinal` and `speedThroughWaterTransverse` (positive to
starboard) are her speed through the water along and across her heading, and
`navigation.leewayAngle` and `performance.leeway` the leeway in radians.

## The Paths

Sent every second on a sailing boat with a wind instrument; a motor boat sends none of the
performance or sails paths.

| Path                                     | Value                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `performance.polarSpeed`                 | the polar's speed at the true wind speed and her true wind angle                                                   |
| `performance.polarSpeedRatio`            | her speed through the water over the polar's; 0 where the polar gives less than a knot                             |
| `performance.velocityMadeGood`           | her speed towards the wind: speed through the water × cos true wind angle, negative running                        |
| `performance.beatAngle`                  | the polar's beat angle at the true wind speed, radians                                                             |
| `performance.beatAngleTargetSpeed`       | the polar's speed on it                                                                                            |
| `performance.beatAngleVelocityMadeGood`  | what she makes to windward on it                                                                                   |
| `performance.gybeAngle`                  | the polar's gybe angle                                                                                             |
| `performance.gybeAngleTargetSpeed`       | the polar's speed on it                                                                                            |
| `performance.gybeAngleVelocityMadeGood`  | what she makes on it, negative: to leeward, as `velocityMadeGood` is signed                                        |
| `performance.targetAngle`, `targetSpeed` | the beat's while the wind is forward of the beam, the gybe's abaft it                                              |
| `performance.tackTrue`, `tackMagnetic`   | her heading on the other tack (or gybe) at the same angle to the wind: twice the wind's direction less her heading |
| `performance.leeway`                     | her leeway                                                                                                         |
| `sails.inventory.<id>`                   | each sail: `name`, `type`, `active`, `area`, `minimumWind`, `maximumWind`, every five seconds                      |
| `sails.area.total`, `sails.area.active`  | the full sail plan and the area set, every five seconds                                                            |

Schema 1.x defines each `sails.inventory` entry as a bare object rather than a value, which
no delta can carry, so the schema checks leave those paths out, as they do the tide's times.

## Wind Mode and the Polar

The autopilot's wind mode ([the autopilot](../autopilot/README.md)) uses the polar:

- **The beat.** A target apparent wind angle inside the beat (the apparent angle of the
  polar's beat at the true wind and her speed) is held at the beat, and the `wind` alarm
  says why: "Inside the beat angle: holding 28° apparent, the polar's beat of 41° true at 12
  kn" (at 6 kn through the water). The held target then follows the beat as the wind changes
  it; a target set outside the beat clears the alarm. Steering, a target the crew set is
  held at the beat only once the beat has moved 3° outside it.
- **Tack and gybe** come out on the polar's angle on her other side: a tack on the beat, a
  gybe on the gybe angle, each then followed as the wind changes it.
- **A calm.** Under 3 kn of true wind, wind mode, a tack and a gybe are refused ("cannot
  steer to the wind: 1.2 kn of true wind is too little to steer by, under 3 kn"), and
  already in wind mode she holds her heading until the wind fills in, rather than chasing a
  true wind direction that wanders in a near calm.

## The Run View, Status Line and Page

The run view (`GET /plugins/signalk-simulator/run`) carries `water` (the current's speed and
set and whether it is the sample's or seeded, her speed through the water, her leeway) and,
on a sailing boat, `sails` (how she makes her way, the sails set, their area and the full
plan's, and the polar's numbers: speed, ratio, velocity made good, beat and gybe angles and
speeds, target angle and speed, the heading on the other tack). The status line adds "under
sail, main and genoa, 6.2 kn through the water", "motor-sailing, main and genoa, 5.8 kn
through the water" or "motoring, 6.0 kn through the water" under way, and "current 0.8 kn
setting 170°". The page's Where the Boat Is card gains the current, the speed through the
water and the leeway, and on a sailing boat a Sails row with the sails set, their area, and
the polar speed and ratio.

## Tests

`test/simulator-sailing.ts` checks the polar at its points, between them, past its edges and
inside its closest angle; the beat and gybe angles against every angle; each sailing
profile's inventory and which sails are set at each wind; the sail or motor decision,
getting under way under power and the five-minute wait; a light morning motored and a sea
breeze sailed across a day built on the Saronic's; the heading and speed through the water
against a known current; the leeway's sign either side; the polar paths at three points of
sail; the sails set only under way; no performance or sails paths from a motor boat; the
schema; and the pilot's wind mode against the beat, its tack and gybe onto the polar, and
the calm refusal. `test/simulator-weather.ts` checks each current format read and blended.
The [systems soak](../soak/README.md#what-it-checks) checks every new value in its band, the
speed through the water against the speed over the ground less the current, the sails set
only on a sailing boat and only under way, and the Saronic passage's afternoon and morning.
