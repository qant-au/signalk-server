# Own-Boat Routes

Each sample has a `route.json`: the passage the simulated boat makes. These are baseline
routes, a starting point for the simulator. Depth, speed and timing will be tuned once the
simulator runs them.

## Format

```json
{
  "name": "Saronic Gulf overnight loop from Piraeus",
  "departure": "2018-07-13T11:00:00Z",
  "vessel": {
    "description": "15 m sailing yacht",
    "profile": "sailing-yacht-15m"
  },
  "source": "how the waypoints were made",
  "waypoints": [
    {
      "name": "Zea Marina, Piraeus",
      "lat": 37.9335,
      "lon": 23.6505,
      "speedKn": 3,
      "note": "marina, dead slow"
    },
    {
      "name": "Zea Marina entrance",
      "lat": 37.92,
      "lon": 23.655,
      "speedKn": 5
    },
    { "name": "Zea Marina, Piraeus", "lat": 37.9335, "lon": 23.6505 }
  ]
}
```

| Field                        | Meaning                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `departure`                  | when the boat leaves the first waypoint, UTC                                                                                                                                                                                                                                                                       |
| `vessel`                     | the own boat: 10 to 30 m. `profile` names its [vessel profile](../vessels/README.md), which gives its length, draft and AIS type code and everything on board; a route without one gives `lengthM`, `draftM` and `typeCode` itself                                                                                 |
| `vessel.name`, `vessel.mmsi` | the own boat's name, and its MMSI: nine digits beginning with its flag's MID (366 or 367 for the US, 237 to 241 for Greece, 503 for Australia). Each sample's boat is invented, and no vessel in the sample's AIS shares its MMSI. The plugin sends both unless the server's own vessel settings already give them |
| `waypoints[].speedKn`        | speed on the leg **leaving** this waypoint. Speed belongs to the leg, not the boat, so marinas, channels and no-wake zones stay slow and open water stays fast. The last waypoint has none.                                                                                                                        |
| `waypoints[].holdS`          | seconds to wait at this waypoint before leaving (a bridge opening)                                                                                                                                                                                                                                                 |
| `waypoints[].anchor`         | the boat lies at anchor here (engines off, no shore power) while it holds, before it leaves a first waypoint or after it reaches a last one; without it a hold is under way and a route's ends are berths                                                                                                          |
| `waypoints[].name`, `note`   | for people reading the route; optional                                                                                                                                                                                                                                                                             |

`routes/route.ts` turns a route into timed legs (`routeLegs`) and gives the boat's position,
speed and course at any moment (`positionAt`), holding at waypoints and stopping at the end.
Positions are interpolated along each leg, and at a waypoint the boat passes without
stopping it swings onto the next leg on an arc tangent to both, at a rate of turn that
suits its length and speed; the arc joins each leg where the boat on the straight legs
would be, so the legs' timings stand ([details](../vessels/README.md#navigation)). Leg
speeds are speeds over the ground; the boat's speed through the water differs from them by
the current.

```shell
npx ts-node simulator/tools/route.ts show <sample>     # legs, distances, speeds, arrival times
npx ts-node simulator/tools/route.ts turns <sample>    # the arcs at waypoints against the depth: clear, tightened or not clear
```

## The Three Routes

| Sample                   | Route                                                                                                                                                                                                                                                                                 | Distance         | Time                                                     | Speeds                                                                                                                                     | Source                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Miami ICW                | Rickenbacker Marina berth, west along the causeway, up Biscayne Bay and the Intracoastal Waterway to a berth in Pier 66 Marina, Fort Lauderdale; 20 m motor yacht, 1.5 m draft; departs 10:00 EDT                                                                                     | 22.5 nm planned  | 3 h 48 min planned, including four bridge holds (34 min) | 3 kn in the marinas, 5.5 to 7.5 kn in the no-wake stretches, up to 15.5 kn across open Biscayne Bay                                        | **A real passage**, from the sample's own CC0 AIS; only the berths are added |
| Saronic Gulf             | A berth in Zea Marina, west of Aegina to an anchorage in Skala bay on Angistri for the evening, then west of Angistri, past Methana and Poros, round Cape Skyli to Hydra, and back east of Aegina to the same berth; 15 m sailing yacht, 2.2 m draft; departs 14:00 EEST              | 98.8 nm planned  | 19 h 48 min planned, including 2 h 30 min at anchor      | 3 kn in the marina and in and out of the anchorage, 6 kn under sail                                                                        | **Hand-written**, because the AIS licence does not allow derived works       |
| Manly to Hamilton Island | A berth in Manly Boat Harbour, Moreton Bay and the North West Channel, outside Fraser Island and round Breaksea Spit, then coastal past Bustard Head, the Keppels and the Percy Isles to a berth in Hamilton Island marina; 15 m motor-sailer, 1.8 m draft; departs Friday 06:00 AEST | 566.1 nm planned | 68 h 04 min planned, arriving about 02:00 AEST on Monday | 3 kn leaving Manly, 7 kn in the Manly channel, 8.5 kn on passage, 6 kn among the Whitsunday islands, 2 to 4 kn into Hamilton Island marina | **Hand-written**, because the AIS licence does not allow derived works       |

## How They Were Made

**Every route runs berth to berth.** Each starts and ends at a berth inside a marina, at 2 to
3 kn. Berth positions come from OpenStreetMap marina outlines; the way from each berth to open
water is found against the depth grid when a run starts (see
[Depth and Route Adjustment](#depth-and-route-adjustment)).

> [!NOTE]
> **Only the Miami route follows a real vessel's track.** The Saronic Gulf and Queensland
> routes are hand-written on purpose: their AIS is licensed non-commercial (CC BY-NC-SA and
> CC BY-NC), and a route traced from it would be a derived work that cannot be shared under
> this repository's licence. They are plausible passages along charted waters, not recorded
> ones. If a CC0 or CC BY source of AIS for either area turns up, the same `derive` tool can
> replace them with real passages.

**Miami: derived from a real passage.** The sample's AIS is CC0, so the route comes from a
vessel that actually ran it: the only 10 to 30 m vessel in that day's data that went between
Biscayne Bay and Port Everglades by the inside route rather than the ocean. It ran it
southbound in the afternoon; the route runs it northbound. Its track is simplified to 75 m,
each leg's speed is the median speed it made on that leg, and every stop of 2 minutes or more
(waiting for a bridge to open) becomes a hold. The selection is set out in the `route`
section of the sample's `sample.json`, together with the berths at each end (`fromBerth` and
`toBerth`), and the route is regenerated with:

```shell
npx ts-node simulator/tools/route.ts derive miami-icw-2024-03-16
```

Nothing that identifies the source vessel is kept: the route holds positions, speeds and holds
only, and a test checks every route file for identifiers.

**Saronic Gulf and Queensland: hand-written.** Their AIS licences (CC BY-NC-SA and CC BY-NC)
do not allow derived works to be shared, so their routes are not traced from those tracks.
They are written from charted headlands, channels, islands and harbours, with leg speeds
chosen for the waters each leg crosses and, for the Saronic Gulf, the time the anchorage
leaves inside the sample's AIS.

## Anchorage

A waypoint marked `anchor` with a `holdS` is an anchorage: the boat comes in on the leg
before it, stops at the waypoint, and lets go her anchor there, lies to it for the hold,
then weighs and carries on. The Saronic route has one.

**Skala bay, Angistri.** The bay off Skala, the harbour village on the north-east coast of
Angistri, across the channel from Aegina: a sandy bay that cruising yachts anchor in, open
to the north, 1.2 nm off the passage west of Aegina. The anchor goes down at 37.7200 N,
23.3560 E, in 6.8 m on the EMODnet grid, and the water all round, out past where she
swings, is 5 to 7 m. The boat leaves the passage at West of Aegina, slows to 3 kn into the
bay and anchors at **14:58 UTC (17:58 EEST)**. She lies there two and a half hours, through
the evening meal, and weighs at **17:28 UTC (20:28 EEST)**, before sunset, motoring out at 3
kn round the north of Angistri onto the passage. The rest of the route was retimed to fit
the stay inside the sample's AIS, which runs from 11:00 to 07:00 UTC and was left as it is:
the legs under sail go at 6 kn rather than 4.5 to 6, and she is alongside again at 06:54 UTC.

**Anchoring.** She lets go at the waypoint and falls back as the chain pays out, at three
tenths of a metre a second, to a scope of five times the depth plus the height of her bow
roller (8 % of her length): 40 m of chain in Skala bay's 6.8 m. She lies downwind of the
anchor, her bow to it, nearer it in a light air, with the chain's weight on the bottom,
and out to its full reach in 20 kn or more. On that line she sheers from side to side,
15° either way over four to five minutes for a 15 m boat, as yachts do on a chain, though
on a long scope never across the wind at more than half a knot, and the line wanders with
the wind. Whatever the chain, the windlass or a drag does, she moves at no more than
0.45 m a second. So her position, heading and the wind over the deck move as a boat at
anchor moves: her speed over the ground is what the swing gives, a few tenths of a knot,
and her speed through the water as little. Five minutes before she leaves, the crew
swings her onto her
course, and then heaves in at the windlass's 0.3 m a second, timed so the anchor breaks out
as she gets under way (the last two minutes in Skala bay), bringing her up to it; she then
makes back to the track from where the anchor lay over the next minute or two.

**What is sent**, as the anchor alarm plugin sends it, so Freeboard's anchor display needs
nothing new:

| Path                              | Value                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `navigation.state`                | `anchored` from letting go to weighing, which is also the own boat's AIS navigational status, at anchor                                                                                                |
| `navigation.anchor.position`      | where the anchor went down, with `altitude` the depth there, negative (as the plugin gives it)                                                                                                         |
| `navigation.anchor.maxRadius`     | the radius she swings in on the scope paid out: the chain's reach along the bottom, √(chain² − (depth + bow)²), plus her GNSS antenna's distance aft of the bow (half her length): 46.7 m in Skala bay |
| `navigation.anchor.currentRadius` | her antenna's distance from the anchor, every second                                                                                                                                                   |
| all three                         | `null` once, when the anchor is weighed, as the plugin clears them                                                                                                                                     |

The engines stop when she anchors and start as she weighs; the house loads run on the bank,
solar charges by day on a boat that has it, the wind turbine with the wind, and the
generator runs when the profile's rules call for it (at the evening meal in Skala bay). The
tanks and banks go on as a day at anchor does. Nothing of coming alongside fires: no bow
thruster, no shore power. The anchor watch and a dragging anchor are in
[the vessels README](../vessels/README.md#alarms) and
[the faults README](../faults/README.md#anchor-dragging).

**The Course API.** The active route holds through the stay. The anchorage is reached as
she anchors, so the next point is the one after it, and stays that point, unchanged, until
she weighs and makes for it; her swing never carries her across the point she is making
for. While she lies at anchor the course provider's speed made good to it and the time to
go and arrival it gives (`navigation.course.calcValues.velocityMadeGood`, `timeToGo`,
`estimatedTimeOfArrival`, `route.timeToGo`, `route.estimatedTimeOfArrival`, `targetSpeed`
and `performance.velocityMadeGoodToWaypoint`) go out as `null`, as for a boat not making for
it: worked from her swing they would have her arriving some hours on. Distance and bearing
to the next point, true wherever she lies, go out as they are.

## Depth and Route Adjustment

**Datums.** Each grid gives depth below its own datum: Miami's BlueTopo below NAVD88, the
Saronic's EMODnet DTM below Lowest Astronomical Tide, Queensland's GBR 30 m below mean sea
level. The route is planned and adjusted against the grid's depth alone; what the boat's
sounders then read adds the sample's water level above the grid's datum, where the sample
has one, so they follow the tide. How each sample's water level is brought onto its grid's
datum is in [the weather README](../weather/README.md#the-tide-on-the-depth).

`route.json` is the **planned** route. The simulator sails an **adjusted** one, worked out
each time a run starts (`routes/adjust.ts`):

1. Every leg is sampled every half grid cell against the sample's depth grid
   (`depth.sources` in `sample.json`).
2. A point is safe when the water there is at least the boat's draft (`vessel.draftM` in the
   route) plus the minimum depth under the keel (a plugin setting, 1 m by default).
3. Any stretch of a leg that is not safe is re-routed by an A* search over grid cells around
   that stretch alone, checking each step between cells as well as the cells. The path is
   then straightened into as few legs as stay in safe water, and the new waypoints keep the
   leg's speed. The check is repeated until every leg is clear.
4. The adjusted route is published to the server's Resources API, so the chart shows what the
   boat actually sails.

**The marina legs are found the same way.** Each route names only its berths; the way from a
berth to open water is the router's, against the grid. This replaced hand-placed marina
waypoints, which sat on charted land in places (the first Miami route crossed the
Rickenbacker Causeway on its way out of the marina).

**Harbours.** A berth is in water shallower than a passage needs, and the coarser grids
cannot see a marina basin or a dredged channel at all. Within `harbourRadiusM` of each berth,
any surveyed water counts as safe, and, where the grid cannot resolve the harbour
(`harbourNoDataIsWater`), so does anywhere it has no data. Charted dry land never does.

| Sample                   | Grid                          | Cell  | Harbour radius | No data in harbour                         | Adjusted Route                      |
| ------------------------ | ----------------------------- | ----- | -------------- | ------------------------------------------ | ----------------------------------- |
| Miami ICW                | NOAA BlueTopo, 4 m            | 10 m  | 250 m          | land (the 4 m survey resolves the marinas) | 22.7 nm, 3 h 52 min; 10 legs moved  |
| Saronic Gulf             | EMODnet DTM 2024, about 115 m | 116 m | 1,000 m        | water (the grid cannot resolve Zea Marina) | 99.2 nm, 19 h 54 min; 2 legs moved  |
| Manly to Hamilton Island | Great Barrier Reef, 30 m      | 33 m  | 3,500 m        | water (covers Manly's dredged channel)     | 566.4 nm, 68 h 09 min; 4 legs moved |

Figures are for a minimum depth under the keel of 1 m; a larger setting moves more legs.

## Next

- Tides: depths are relative to each grid's datum, with no tide applied.
- Speeds tuned against wind, sea state and the vessel's polar, rather than fixed per leg.
