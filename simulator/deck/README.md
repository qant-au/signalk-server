# Deck Gear and Lights

What a boat does on deck that a display shows and a crew switches: the navigation lights,
the anchor windlass and its chain counter, an outboard's trim, fin stabilisers and the
radars. Each follows what the boat is doing and the sun, in the systems model's own fixed
steps (`deck.ts`), and its draw goes in the energy books with the other loads. The bridges
a route waits for are in the [routes README](../routes/README.md#bridges); what she says of
them is [below](#bridges).

## The Navigation Lights

`navigation.lights` takes the specification's values for what a yacht shows:

| She is                             | By day | At night   |
| ---------------------------------- | ------ | ---------- |
| alongside                          | `off`  | `off`      |
| at anchor                          | `off`  | `anchored` |
| under sail alone                   | `off`  | `sailing`  |
| motoring, or motor-sailing         | `off`  | `motoring` |
| holding under way for a bridge     | `off`  | `motoring` |
| lights failed (from dusk, a fault) | -      | `fault`    |

Night is from sunset to sunrise: the sun's upper limb below the horizon, an elevation
below -0.833° with refraction, by the same solar position the solar arrays and the air
temperature use (`systems/sun.ts`). The lights come on at sunset rather than at the end
of civil twilight, as the collision regulations require. Motor-sailing shows motoring
lights, as the rules treat a sailing vessel under power as a power-driven vessel, and as
`navigation.state` already reports it. `not-under-way` and the working lights
(`fishing`, `restricted manouverability` and the rest) are not shown: no profile here does
that work.

**Their draw** is 10 W plus 1.5 W a metre of length while they are lit (16 W on the 4 m
boat, 33 W on the 15 m yacht, 78 W on the 45 m), on the house bank, or on the 4 m boat's
one battery. It shows in that bank's `current` and in the books as `navigation lights`.

## The Lights Failure

`navLightsFailure` puts out the lights: `navigation.lights` goes to `fault`, and the boat
raises `notifications.navigation.lights` at `alarm`, `visual` and `sound`, "Navigation
lights failure: showing no lights". It can be raised **only from dusk**, while the sun is
down; by day the REST surface and the page refuse it ("navLightsFailure happens only from
dusk, while the sun is down") and the seed does not throw it. It clears on its own after 10
to 60 minutes, as the crew finds the fuse or the connection, or by hand; the lights come
back as they were. See the [faults README](../faults/README.md#navigation-lights-failure).

## The Chain and the Windlass

A boat of 8 m or more has an anchor windlass with a chain counter (`windlass` in the
profile, from length unless given). The chain follows the [anchor
model](../systems/anchor.ts): it pays out as she anchors, to a scope of five times the
depth plus the bow roller's height, and is heaved in at the windlass's pace before she
leaves, timed so the last of it, from the roller straight down to the anchor, is in as
the anchor breaks out.

- **The chain counter** is `navigation.anchor.rodeCounterLength`, metres of chain out,
  every second, 0 with the anchor up. That is the path the [anchor alarm
  plugin](https://github.com/sbender9/signalk-anchoralarm-plugin) reads a chain counter on
  (its `rodeCounterPath` setting, which defaults to it); the plugin then publishes its own
  `navigation.anchor.rodeLength`, so the simulator does not send that one. KIP (4.8.5)
  reads no anchor path; a numeric widget can be pointed at the counter.
- **The windlass** is a digital switch, `electrical.switches.windlass.state`, 1 while it
  pays out or heaves in and 0 otherwise, with `meta.displayName` "Windlass".
- **Its draw** comes in bursts on the house bank, as a thruster's does: 80 W a metre of
  length heaving in (1.2 kW on the 15 m yacht), 30 % of that paying out. The bank's
  values go every second while it runs, and the books carry it as `windlass`.
- **The 4 m boat has no windlass**: her crew hauls the anchor by hand, so she sends no
  switch and no chain counter.

## Outboard Trim

A profile whose engine has `"drive": "outboard"` (the 4 m boat) sends
`propulsion.<id>.drive.type` `outboard`, every five seconds, and
`propulsion.<id>.drive.trimState`, every second: 1 tilted right up and 0 right down.

- **Alongside, or at anchor**, it is tilted up, 1.
- **Leaving and coming in**, at low speed, it is down, 0.
- **At speed** it trims up, from 40 % of her top speed, to a cruising trim of 0.2 by 70 %
  (8 to 14 kn on the 4 m boat).

The trim motor moves it a tenth of its travel a second. Any other drive sends nothing.

## Stabilisers

The 34 m and 45 m motor yachts carry fin stabilisers (`stabilisers` in the profile:
`fins`, or `zeroSpeed` for fins that work at rest).

- **When they work**: under way above 6 kn, going off below 5 kn so they never chatter;
  and on the 45 m's zero-speed fins at anchor too. Never alongside.
- **The switch** is `electrical.switches.stabilisers.state`, 1 working and 0 off, with
  `meta.displayName` "Stabilisers".
- **What they do**: while on, they take two thirds of the sea's roll out of
  `navigation.attitude`. A sailing boat's heel is hers and is not touched; no sailing
  profile carries stabilisers.
- **Their draw** is their hydraulic pump, 0.2 kW a metre of length (6.8 kW on the 34 m,
  9 kW on the 45 m), an AC load on the generators, which run whenever these yachts are
  away from the berth. It shows in the generators' load and in the books' generator output.

## The Radars

Each radar the profile counts is a switch, `electrical.switches.<radarId>.state`, with
its display name in metadata: 1 transmitting under way (holding for a bridge included), 0
on standby alongside and at anchor. A boat under 9 m has none; 9 to 25 m have one,
`radar`; from 25 m two, `radarX` and `radarS`. Radar images stay outside the data model,
as the [vessels README](../vessels/README.md#what-has-no-standard-path) says.

## Bridges

A route may name the bridge each opening hold waits for, with its vertical clearance
closed ([routes README](../routes/README.md#bridges)). While she holds for one, the run
view's next point and the status line say which bridge and why, against her air height
(`design.airHeight`):

- "holding for the Broad Causeway bridge to open: 5.9 m air height against 4.9 m closed
  clearance", where she does not clear it closed;
- "holding at the 79th Street Causeway bridge, though she clears it closed: 5.9 m air
  height against 7.6 m closed clearance", where she does. The Miami route holds there
  because the real vessel its passage was taken from held there, and that vessel was
  taller.

## The Paths

| Path                                    | When                                                    | On which boats                 |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `navigation.lights`                     | every second                                            | every boat with a profile      |
| `navigation.anchor.rodeCounterLength`   | every second, 0 with the anchor up                      | with a windlass (8 m and over) |
| `electrical.switches.windlass.state`    | every second                                            | with a windlass                |
| `propulsion.<id>.drive.type`            | every five seconds                                      | an outboard (the 4 m boat)     |
| `propulsion.<id>.drive.trimState`       | every second                                            | an outboard                    |
| `electrical.switches.stabilisers.state` | every second                                            | the 34 m and 45 m motor yachts |
| `electrical.switches.<radarId>.state`   | every second                                            | each radar the profile counts  |
| `notifications.navigation.lights`       | while the lights have failed, and `normal` as it clears | any boat, from dusk            |

Each switch's `displayName` and a `description` go in the metadata sent when a run
starts. The lights are switches too, `navLights` and `anchorLight`, which this rule
drives; every switch here takes a PUT from a display, and is sent again on a switch bank
channel (see [switching](../switching/README.md)).

**The schema.** Signal K schema 1.8.2 takes `drive.trimState`. It has no place for the
rest, so the schema checks leave them out, as they do the sails inventory and the tide's
times: `navigation.lights` is in the schema, but its definition lacks the `$source` and
`meta` every value carries in the full model; `drive.type` is a bare enum no delta can
satisfy; and there is no `navigation.anchor.rodeCounterLength` or `electrical.switches`
at all. A test checks that each of these is still refused, so a newer schema that takes
one shows up.

## The Page, the Run View and the Status Line

- **The page** has a Deck card: the navigation lights and whether the sun is down, the
  chain out and the scope she lies to (over the depth and the bow roller's height: 5 to 1
  once it is all out), the windlass, the outboard's trim, the stabilisers, each radar
  transmitting or on standby, and the bridge she is holding for.
- **`GET /run`** carries the same under `deck` (`lights`, `night`, `chainM`, `scope`,
  `windlass`, `trim`, `stabilisers`, `radars` by name), and `nextPoint.bridge` (`name`,
  `closedClearanceM`, `airHeightM`, `clearsClosed`, `words`) while she holds for a
  bridge.
- **The status line** adds the lights at night ("lights: motoring"), the chain at anchor
  ("at anchor on 32 m of chain in 6.8 m") and the bridge at a hold.

## Tests

`test/simulator-deck.ts` runs on the controllable clock: the lights across a day and into
the night on a motor boat; a sailing boat out at dusk under sail, anchored overnight and
weighing by day; the 4 m boat at night; the fault taken only from dusk, with its alarm,
and refused by day; the chain counter and the windlass through an anchoring and a
weighing, and none on the 4 m boat; the trim through a departure, a fast passage and an
arrival; the stabilisers' cut in the roll and their AC load; the radar switches and their
names; the bridge words at each of Miami's holds; and the schema on every new path. The
systems soak checks the same on every profile's day (see the [soak
README](../soak/README.md)).
