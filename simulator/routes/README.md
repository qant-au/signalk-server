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
    "lengthM": 15,
    "typeCode": 36
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

| Field                      | Meaning                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `departure`                | when the boat leaves the first waypoint, UTC                                                                                                                                                |
| `vessel`                   | the own boat: 10 to 30 m, with the AIS type code it would broadcast                                                                                                                         |
| `waypoints[].speedKn`      | speed on the leg **leaving** this waypoint. Speed belongs to the leg, not the boat, so marinas, channels and no-wake zones stay slow and open water stays fast. The last waypoint has none. |
| `waypoints[].holdS`        | seconds to wait at this waypoint before leaving (a bridge opening)                                                                                                                          |
| `waypoints[].name`, `note` | for people reading the route; optional                                                                                                                                                      |

`routes/route.ts` turns a route into timed legs (`routeLegs`) and gives the boat's position,
speed and course at any moment (`positionAt`), holding at waypoints and stopping at the end.
Positions are interpolated along each leg.

```shell
npx ts-node simulator/tools/route.ts show <sample>     # legs, distances, speeds, arrival times
```

## The Three Routes

| Sample                   | Route                                                                                                                                                                                                                   | Distance | Time                                             | Speeds                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Miami ICW                | Biscayne Bay off Brickell to Port Everglades by the Intracoastal Waterway; 20 m motor yacht; departs 10:00 EDT                                                                                                          | 21.6 nm  | 3 h 11 min, including four bridge holds (34 min) | 5.5 to 7.5 kn in the no-wake stretches, up to 15.5 kn across open Biscayne Bay                                                      |
| Saronic Gulf             | Zea Marina, west of Aegina and Angistri, past Methana and Poros, round Cape Skyli to Hydra, and back east of Aegina; 15 m sailing yacht; departs 14:00 EEST                                                             | 97.4 nm  | 19 h 57 min                                      | 3 kn in the marina, 5 kn under sail by day, 4.5 kn at night, 5.5 kn in the morning breeze                                           |
| Manly to Hamilton Island | Moreton Bay and the North West Channel, outside Fraser Island and round Breaksea Spit, then coastal past Bustard Head, the Keppels and the Percy Isles to the Whitsundays; 15 m motor-sailer; departs Friday 06:00 AEST | 565.6 nm | 67 h 40 min, arriving about 01:40 AEST on Monday | 4 kn leaving Manly, 7 kn in the Manly channel, 8.5 kn on passage, 6 kn among the Whitsunday islands, 3 to 4 kn into Hamilton Island |

## How They Were Made

**Miami: derived from a real passage.** The sample's AIS is CC0, so the route comes from a
vessel that actually ran it: the only 10 to 30 m vessel in that day's data that went between
Biscayne Bay and Port Everglades by the inside route rather than the ocean. It ran it
southbound in the afternoon; the route runs it northbound. Its track is simplified to 75 m,
each leg's speed is the median speed it made on that leg, and every stop of 2 minutes or more
(waiting for a bridge to open) becomes a hold. The selection is set out in the `route`
section of the sample's `sample.json`, and the route is regenerated with:

```shell
npx ts-node simulator/tools/route.ts derive miami-icw-2024-03-16
```

Nothing that identifies the source vessel is kept: the route holds positions, speeds and holds
only, and a test checks every route file for identifiers.

**Saronic Gulf and Queensland: hand-written.** Their AIS licences (CC BY-NC-SA and CC BY-NC)
do not allow derived works to be shared, so their routes are not traced from those tracks.
They are written from charted headlands, channels, islands and harbours, with leg speeds
chosen for the waters each leg crosses and, for the Saronic Gulf, for that night's light wind.

**Checked against depth.** Every leg of the two hand-written routes was sampled every 0.05 nm
against the sample's depth data (the Great Barrier Reef 30 m model; EMODnet DTM 2024) and moved
until no leg crosses land. The only points shallower than 3 m are the marinas at the ends
(Manly Boat Harbour and its approach, Zea Marina), whose dredged channels are narrower than the
grids can show. That check was run with a local script; a depth reader in the simulator itself
comes with the depth work, and will make it repeatable here.

## Next

- Depth along each leg, and a check that fails a route which crosses water too shallow for its
  vessel.
- Speeds tuned against wind, sea state and the vessel's polar, rather than fixed per leg.
- The simulator engine, publishing the boat's position, speed and course from `positionAt`, and
  the AIS targets it hears along the way.
