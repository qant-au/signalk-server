# AIS Reception Model

The AIS in every sample is what a shore network collected: dozens of well-placed receivers,
merged. A boat hears far less. Its own antenna is a few metres above the water, and each
target is heard only while it is within radio range of that antenna, which depends on how
high both antennas are and how much power the target transmits. Without this model the
simulator would put every target in the source on the server at once, from a hundred miles
away.

`reception.ts` holds the model. `targets.ts` reads each sample's AIS file into one shape, using
the `ais` mapping in its `sample.json`. Both are pure functions with tests
(`test/simulator-ais.ts`); nothing runs them on a route yet.

## How a Report Is Judged

1. **Estimate the target's station** from what the source gives: AIS class, transmit power
   and antenna height.
2. **Work out the range** between that station and our receiver.
3. **Decide whether each report gets through**, with a probability that falls away around the
   range.
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
  at these distances: received power `= P x (h_target x h_receiver)^2 / d^4`. Solving for the
  distance at which it falls to the receiver's sensitivity (-107 dBm by default, the figure
  AIS receiver standards require) gives the range. A 6 dB allowance for antenna, cable and
  connector losses comes off the transmitted power.

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

That matches the ranges usually quoted (Class A about 20 to 30 nm between ships, Class B about
5 to 10 nm), allowing for those figures assuming ships' antennas at both ends.

### 3. Each Report

The chance that one report arrives is a logistic curve centred on the range, with a width of
8% of it, scaled by a 2% loss for slot collisions and interference that happens even close
in. Half the reports arrive at the range itself, about 90% at 80% of it and about 7% at 120%,
so a target at the edge flickers in and out the way real ones do rather than vanishing at a
line.

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
less than 3 minutes, so one missed report from a fast ship does not drop it. That is 3 minutes
for anything under way and 9 minutes for a moored Class A ship.

**This is deliberately not left to the server.** Signal K Server removes a vessel only when it
has had no update for `pruneContextsMinutes` (default 60), checked once a minute
(`src/index.ts`, `pruneContexts` in `src/deltacache.ts`). That is housekeeping, not radio: no
boat's receiver keeps a target for an hour after its last report. The simulator therefore
stops sending a target as soon as it is lost, and drops it from the server's model and delta
cache there and then, so `vessels.*` holds exactly the targets in range and the plugin's
count agrees with it. A target heard again comes back as a new one, its static data with
its first report, as when it was first heard. Stopping the plugin drops every target it was
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

## Checked Against the Samples

`simulator/tools/ais-coverage.ts` counts the targets in a sample around one place and moment,
and how many the model says a boat there would hear:

```shell
npx ts-node simulator/tools/ais-coverage.ts <sample> <lat> <lon> <ISO time> [antenna m]
```

| Sample, Place and Time                                    | Receiver | In the Source        | Heard on Board    |
| --------------------------------------------------------- | -------- | -------------------- | ----------------- |
| Miami, off Haulover Inlet, 16 March 2024 16:00 UTC        | 4 m      | 633 (A 219, B 414)   | 205 (A 123, B 82) |
| Saronic Gulf, mid-gulf, 13 July 2018 20:00 UTC            | 15 m     | 186 (A 59, B 127)    | 19 (A 17, B 2)    |
| Queensland, 30 nm off Bundaberg, 21 August 2026 12:00 UTC | 15 m     | 1,077 (A 197, B 880) | 1 (B 1)           |

The Queensland case shows why this matters most there: AMSA's coastal network sees more than a
thousand craft along the coast at once, and a boat 30 nm offshore at night hears almost none
of them.

## Not Modelled Yet

- **Land.** Islands and headlands block VHF; the model treats every path as open sea. The depth
  data can supply a coastline once routes exist.
- **Ducting.** Warm, still conditions sometimes carry AIS far past the horizon. The model never
  does.
- **Congestion.** Busy waters lose more reports to slot collisions than the flat 2% here.
- **Antenna heights** are estimates from type and length; sources do not record them.

All of the constants are named at the top of `reception.ts`, so any of these can be tuned
without changing the shape of the model.
