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

| Field                      | Meaning                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `departure`                | when the boat leaves the first waypoint, UTC                                                                                                                                                                                       |
| `vessel`                   | the own boat: 10 to 30 m. `profile` names its [vessel profile](../vessels/README.md), which gives its length, draft and AIS type code and everything on board; a route without one gives `lengthM`, `draftM` and `typeCode` itself |
| `waypoints[].speedKn`      | speed on the leg **leaving** this waypoint. Speed belongs to the leg, not the boat, so marinas, channels and no-wake zones stay slow and open water stays fast. The last waypoint has none.                                        |
| `waypoints[].holdS`        | seconds to wait at this waypoint before leaving (a bridge opening)                                                                                                                                                                 |
| `waypoints[].anchor`       | the boat lies at anchor here (engines off, no shore power) while it holds, before it leaves a first waypoint or after it reaches a last one; without it a hold is under way and a route's ends are berths                          |
| `waypoints[].name`, `note` | for people reading the route; optional                                                                                                                                                                                             |

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
```

## The Three Routes

| Sample                   | Route                                                                                                                                                                                                                                                                                 | Distance         | Time                                                     | Speeds                                                                                                                                     | Source                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Miami ICW                | Rickenbacker Marina berth, west along the causeway, up Biscayne Bay and the Intracoastal Waterway to a berth in Pier 66 Marina, Fort Lauderdale; 20 m motor yacht, 1.5 m draft; departs 10:00 EDT                                                                                     | 22.5 nm planned  | 3 h 48 min planned, including four bridge holds (34 min) | 3 kn in the marinas, 5.5 to 7.5 kn in the no-wake stretches, up to 15.5 kn across open Biscayne Bay                                        | **A real passage**, from the sample's own CC0 AIS; only the berths are added |
| Saronic Gulf             | A berth in Zea Marina, west of Aegina and Angistri, past Methana and Poros, round Cape Skyli to Hydra, and back east of Aegina to the same berth; 15 m sailing yacht, 2.2 m draft; departs 14:00 EEST                                                                                 | 97.7 nm planned  | 19 h 57 min planned                                      | 3 kn in the marina, 5 kn under sail by day, 4.5 kn at night, 5.5 to 6 kn in the morning breeze                                             | **Hand-written**, because the AIS licence does not allow derived works       |
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
chosen for the waters each leg crosses and, for the Saronic Gulf, for that night's light wind.

## Depth and Route Adjustment

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

| Sample                   | Grid                                                                                                                                                                                                  | Cell            | Harbour radius      | No data in harbour                                                                             | Adjusted Route                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Miami ICW                | NOAA BlueTopo, 4 m                                                                                                                                                                                    | 10 m            | 250 m               | land (the 4 m survey resolves the marinas)                                                     | 22.7 nm, 3 h 52 min; 10 legs moved                                     |
| Saronic Gulf             | A berth in Zea Marina, west of Aegina and Angistri, past Methana and Poros, round Cape Skyli to Hydra, and back east of Aegina to the same berth; 15 m sailing yacht, 2.2 m draft; departs 14:00 EEST | 97.7 nm planned | 19 h 57 min planned | 3 kn in the marina, 5 kn under sail by day, 4.5 kn at night, 5.5 to 6 kn in the morning breeze | **Hand-written**, because the AIS licence does not allow derived works |
| Manly to Hamilton Island | Great Barrier Reef, 30 m                                                                                                                                                                              | 33 m            | 3,500 m             | water (covers Manly's dredged channel)                                                         | 566.4 nm, 68 h 09 min; 4 legs moved                                    |

Figures are for a minimum depth under the keel of 1 m; a larger setting moves more legs.

## Next

- Tides: depths are relative to each grid's datum, with no tide applied.
- Speeds tuned against wind, sea state and the vessel's polar, rather than fixed per leg.
