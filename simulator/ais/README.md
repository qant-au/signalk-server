# AIS Reception Model

The AIS in every sample is what a shore network collected: dozens of well-placed receivers,
merged. A boat hears far less. Its own antenna is a few metres above the water, and each
target is heard only while it is within radio range of that antenna, which depends on how
high both antennas are and how much power the target transmits. Without this model the
simulator would put every target in the source on the server at once, from a hundred miles
away.

`reception.ts` holds the model. `targets.ts` reads each sample's AIS file into one shape,
using the `ais` mapping in its `sample.json`. The plugin's traffic
(`simulator/engine/traffic.ts`) uses both on every run; `test/simulator-ais.ts` tests them.

## How a Report Is Judged

1. **Estimate the target's station** from what the source gives: AIS class, transmit power
   and antenna height.
2. **Work out the range** between that station and our receiver.
3. **Decide whether each report gets through**, with a probability that falls away around
   the range.
4. **Time the reports** at the rate the target would really transmit.
5. **Lose the target** when it has not been heard for long enough.

### 1. The Target's Station

| Source Gives                                       | Used For                                                       |
| -------------------------------------------------- | -------------------------------------------------------------- |
| AIS class (NOAA's `transceiver`)                   | taken as stated                                                |
| ship type code (NOAA, Piraeus) or type text (AMSA) | the category below, and the class when it is not stated        |
| length                                             | the antenna height, and Class A for workboats of 20 m and over |

| Category                                                           | Class (if not stated) | Antenna Height                                                        |
| ------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------- |
| Ships: cargo, tanker, passenger, 50 m and over                     | A                     | 0.1 x length + 10 m, between 12 and 45 m (25 m if no length)          |
| Workboats: tugs, pilots, fishing, SAR, smaller passenger and cargo | A from 20 m, else B   | 0.25 x length + 4 m, between 6 and 20 m (10 m)                        |
| Sailing yachts                                                     | B                     | at the masthead: 1.2 x length, between 6 and 30 m (14 m)              |
| Pleasure craft                                                     | B                     | a whip above the deck: 0.2 x length + 2.5 m, between 3 and 10 m (4 m) |
| Unknown                                                            | B                     | 0.2 x length + 3 m, between 3 and 20 m (4 m)                          |

Class A transmits at 12.5 W. Class B is taken as a "CS" unit at 2 W, which nearly every
recreational fit is.

### 2. Range

The range is the shorter of two limits.

- **The radio horizon** over a smooth sea, with the standard 4/3 Earth-radius refraction:
  `d (nm) = 2.23 x (sqrt(h_target) + sqrt(h_receiver))`, heights in metres.
- **The power limit**, from the two-ray ground-reflection model that applies over open water
  at these distances: received power `= P x (h_target x h_receiver)^2 / d^4`. Solving for
  the distance at which it falls to the receiver's sensitivity (-107 dBm by default, the
  figure AIS receiver standards require) gives the range. A 6 dB allowance for antenna,
  cable and connector losses comes off the transmitted power.

Height dominates for ships: their range is set by the horizon. Power dominates for small
craft: a 2 W Class B on a low antenna fades out before it reaches the horizon. With these
defaults:

| Target              | Class | Antenna | Range to a 15 m Masthead | Range to a 4 m Motor Boat |
| ------------------- | ----- | ------- | ------------------------ | ------------------------- |
| Cargo ship, 229 m   | A     | 32.9 m  | 21.4 nm                  | 17.3 nm                   |
| Tanker, 80 m        | A     | 18.0 m  | 18.1 nm                  | 13.9 nm                   |
| Ferry, 40 m         | A     | 14.0 m  | 17.0 nm                  | 12.8 nm                   |
| Tug, 25 m           | A     | 10.3 m  | 15.8 nm                  | 11.6 nm                   |
| Fishing boat, 15 m  | B     | 7.8 m   | 13.0 nm                  | 6.7 nm                    |
| Sailing yacht, 12 m | B     | 14.4 m  | 17.1 nm                  | 9.2 nm                    |
| Motor cruiser, 12 m | B     | 4.9 m   | 10.4 nm                  | 5.4 nm                    |
| Runabout, 6 m       | B     | 3.7 m   | 9.0 nm                   | 4.7 nm                    |

That matches the ranges usually quoted (Class A about 20 to 30 nm between ships, Class B
about 5 to 10 nm), allowing for those figures assuming ships' antennas at both ends.

### 3. Each Report

The chance that one report arrives is a logistic curve centred on the range, with a width of
8% of it, scaled by a 2% loss for slot collisions and interference that happens even close
in. Half the reports arrive at the range itself, about 90% at 80% of it and about 7% at
120%, so a target at the edge flickers in and out the way real ones do rather than vanishing
at a line.

The draw for each report is a hash of the target and the report time, not a random number,
so a scenario run twice hears exactly the same reports.

### 4. Reporting Rate

Real transmissions come at the rates in ITU-R M.1371. Sources are thinner than that (AMSA
keeps one report per vessel per hour), so the simulator places reports along each target's
track at these intervals and judges each one.

| Class  | Condition                         | Interval |
| ------ | --------------------------------- | -------- |
| A      | at anchor or moored, 3 kn or less | 3 min    |
| A      | up to 14 kn                       | 10 s     |
| A      | up to 14 kn, changing course      | 3 1/3 s  |
| A      | 14 to 23 kn                       | 6 s      |
| A      | 14 to 23 kn, changing course      | 2 s      |
| A      | over 23 kn                        | 2 s      |
| B (CS) | 2 kn or less                      | 3 min    |
| B (CS) | over 2 kn                         | 30 s     |

The navigational status comes from the source where it has one (NOAA's `status`); where it
has none, a Class A target under 0.5 kn is treated as moored. A target is changing course
when its rate of turn, or failing that its course between the source reports either side,
changes by more than 5 degrees a minute. Each station's static and voyage data (message 5
for Class A, 24 for Class B) goes every six minutes.

### 5. Losing a Target

A receiver treats a target as lost once it has missed three expected reports, and never in
less than 3 minutes, so one missed report from a fast ship does not drop it. That is 3
minutes for anything under way and 9 minutes for a moored Class A ship.

**This is deliberately not left to the server.** Signal K Server removes a vessel only when
it has had no update for `pruneContextsMinutes` (default 60), checked once a minute
(`src/index.ts`, `pruneContexts` in `src/deltacache.ts`). That is housekeeping, not radio:
no boat's receiver keeps a target for an hour after its last report. The simulator therefore
stops sending a target as soon as it is lost, and drops it from the server's model and delta
cache there and then, so `vessels.*` holds exactly the targets in range and the plugin's
count agrees with it. A target heard again comes back as a new one, its static data with its
first report, as when it was first heard. Stopping the plugin drops every target it was
sending.

The server's own AIS status plugin (`sk-ais-status-plugin`, on by default) keeps its own
watch on each target, on wall-clock timers: it marks a target `lost` six minutes after its
last position and `remove` three minutes later. Each mark is a delta for the target, and
would put a target the simulator had already dropped back into `vessels.*`, with nothing
but its MMSI and that status, until the server's hour-long prune. So the plugin holds back
any delta from another source for a target it has dropped, until the boat hears it again,
and its status says how many it has held back. While a target is heard the status plugin
works as it would with a real receiver, and its `unconfirmed` and `confirmed` marks go
through. Once the simulator plugin is stopped nothing holds them back, and the status
plugin's marks for the targets it was tracking bring them back as bare entries for the
server to prune.

## What Each Target Carries

Each target goes to the server the way a real AIS receiver puts it there, in the shapes the
server's own AIS parser gives (`@signalk/nmea0183-signalk`), with only what the sample's
source records. Nothing is made up to fill a gap: a field the source does not have is
absent.

| When              | Path                                                                                                                       | From                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Every report      | `navigation.position`, `speedOverGround`, `courseOverGroundTrue`                                                           | the source track, interpolated                                                                                                          |
| Every report      | `navigation.headingTrue`, `navigation.rateOfTurn`                                                                          | where the source has them (heading 511, not available, is left out)                                                                     |
| Every report      | `navigation.state`                                                                                                         | the source's AIS navigational status, mapped below                                                                                      |
| Every report      | `sensors.ais.class`                                                                                                        | A or B, as every AIS message carries by its type                                                                                        |
| Every six minutes | `name`, `mmsi`, `communication.callsignVhf`, `registrations.imo` (`IMO nnnnnnn`)                                           | the source's records; anonymised sources (Piraeus, AMSA) have none of these, and get a stable `urn:mrn:signalk:uuid` instead of an MMSI |
| Every six minutes | `design.aisShipType` (`id` and the specification's `name`), `design.length.overall`, `design.beam`, `design.draft.current` | the source's records; a ship type given only in words (AMSA) is left out rather than guessed into a code                                |
| Every six minutes | `navigation.destination.commonName`, `navigation.destination.eta`                                                          | where the source has them (none of the three samples does)                                                                              |

The navigational status maps to `navigation.state` as the specification names it: 0
`motoring` (under way using engine), 1 `anchored`, 2 `not under command`, 3 `restricted
manouverability`, 4 `constrained by draft`, 5 `moored`, 6 `aground`, 7 `fishing`, 8
`sailing`, 9 and 10 the reserved high-speed craft and wing-in-ground values, 11 to 14
`Reserved for future use-11` to `-14`, and 15 `not defined (example)`. For 0 to 8 these are
the values the server's own AIS parser gives; for 9 to 15 it gives names the specification
does not list, so these keep to the specification.

What each sample's source has:

| Sample       | Source  | Status | Heading | Name, call sign, IMO | Ship type | Length | Beam, draught |
| ------------ | ------- | ------ | ------- | -------------------- | --------- | ------ | ------------- |
| Miami        | NOAA    | yes    | yes     | yes                  | code      | yes    | yes           |
| Saronic Gulf | Piraeus | no     | yes     | no (anonymised)      | code      | no     | no            |
| Queensland   | AMSA    | no     | no      | no (anonymised)      | in words  | yes    | yes           |

## Collision Avoidance

The plugin works out each target's closest point of approach (CPA) and the time to it
(TCPA) as a plotter does, every second, for every target in range: from the own boat's
position, course and speed as she sends them, and the target's from its latest report,
carried on along its course at its speed to the moment of the own boat's position.

**The geometry.** Over the few miles AIS reaches, the sea is flat enough to work on, so
both boats go onto a plane about the own boat, in metres east and north. With the target
at `r` from the own boat and moving at `w` relative to her, the time to the closest
approach is `t = -(r · w) / |w|²`, and the closest approach is `|r + w t|`. A target is
closing while `t` is positive. One drawing away, or keeping station with the own boat,
has no closest approach. A target with no course over the ground is taken as still, so a
boat lying at a berth is closed on by the own boat's own speed. `simulator/ais/collision.ts`
holds it, and `test/simulator-collision.ts` checks it against a target crossing ahead at
right angles, one overtaking, one on a reciprocal course and one stopped.

**What is sent.** On the target, where the specification puts it, under the simulator's
source: `navigation.closestApproach` with `distance` (metres) and `timeTo` (seconds), only
while the target is closing. It goes with each of the target's reports, and every second in
between while the target is inside twice the collision alarm's limits, so a display sees a
close one count down. Once a target is no longer closing, `navigation.closestApproach` is
sent once as `null`, so a display drops it.

**The alarm.** A target whose closest approach comes inside the plugin's **Collision alarm:
closest approach** (15 m by default) within its **time to closest approach** (1 minute)
raises a warning, and an alarm once the time is under half that (30 seconds), as
`notifications.navigation.closestApproach` in the target's own context, the way the AIS
target prioritizer plugin names its own, so Freeboard and anything else that reads those
needs nothing new. The message names the target, by its name or its MMSI ("LUCY GOOSE:
closest approach warning"), with method `["visual"]` for a warning and `["visual",
"sound"]` for an alarm. A raised one holds until the approach is back out by a quarter of
the distance or 15 seconds of the time, and goes as `normal`, with no method, once that
margin is passed, the target is past and drawing away, or the receiver loses it; a lost
target's clear goes out before the target is dropped, and nothing is raised for it while
it is. A target making less than a knot, or reporting itself moored or at anchor, raises
no alarm, as a plotter's target filters keep a waterway lined with berths quiet; it still
carries its closest approach.

**Where Miami throws it.** The Miami sample, sailed from its departure at seed 1 with the
defaults, throws it in eight places, for eleven targets moving through the waterway:

| Time              | Where                                  | Leg | Target               | Raised           |
| ----------------- | -------------------------------------- | --- | -------------------- | ---------------- |
| 14:29:25-14:30:15 | Biscayne Bay, 25.767 N 80.183 W        | 7   | ISLA MARIE           | warn, alarm      |
| 16:13:55-16:14:05 | 25.976 N 80.123 W                      | 32  | T/T REBEL            | alarm            |
| 16:31:40-16:33:30 | at a bridge hold, 26.013 N 80.118 W    | 38  | AQUARIUS, MISS MINKS | warn, alarm      |
| 16:47:55-16:48:50 | 26.031 N 80.117 W                      | 40  | EMOTIONAL RESCUE II  | warn, alarm      |
| 16:54:45-16:55:50 | near Dania Beach, 26.046 N 80.116 W    | 44  | LUCY GOOSE           | warn, then alarm |
| 16:59:35-16:59:45 | 26.054 N 80.115 W                      | 47  | NEW TRAILS           | alarm            |
| 17:03:55-17:04:50 | 26.054 N 80.115 W                      | 47  | WOLFPACK             | warn, alarm      |
| 17:45:55-17:47:25 | approaching Pier 66, 26.097 N 80.118 W | 50  | CADILLA, CARRIE B    | warn, alarm      |

Most of these are within ten metres. The route follows a real vessel's passage south run
the other way, so it keeps to the side of the channel that southbound boats use, and meets
them head on; wider limits only add more of the same rather than the boats passing at a
channel's ordinary 20 to 40 metres. The times shift by seconds with another start or seed.

## Checked Against the Samples

`simulator/tools/ais-coverage.ts` counts the targets in a sample around one place and
moment, and how many the model says a boat there would hear:

```shell
npx ts-node simulator/tools/ais-coverage.ts <sample> <lat> <lon> <ISO time> [antenna m]
```

| Sample, Place and Time                                    | Receiver | In the Source        | Heard on Board    |
| --------------------------------------------------------- | -------- | -------------------- | ----------------- |
| Miami, off Haulover Inlet, 16 March 2024 16:00 UTC        | 4 m      | 633 (A 219, B 414)   | 205 (A 123, B 82) |
| Saronic Gulf, mid-gulf, 13 July 2018 20:00 UTC            | 15 m     | 186 (A 59, B 127)    | 19 (A 17, B 2)    |
| Queensland, 30 nm off Bundaberg, 21 August 2026 12:00 UTC | 15 m     | 1,077 (A 197, B 880) | 1 (B 1)           |

The Queensland case shows why this matters most there: AMSA's coastal network sees more than
a thousand craft along the coast at once, and a boat 30 nm offshore at night hears almost
none of them.

## Not Modelled

- **Land.** Islands and headlands block VHF; the model treats every path as open sea, though
  the depth grid the routes are adjusted against could supply a coastline.
- **Ducting.** Warm, still conditions sometimes carry AIS far past the horizon. The model
  never does.
- **Congestion.** Busy waters lose more reports to slot collisions than the flat 2% here.
- **Antenna heights** are estimates from type and length; sources do not record them.

All of the constants are named at the top of `reception.ts`, so any of these can be tuned
without changing the shape of the model.
