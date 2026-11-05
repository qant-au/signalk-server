# Miami ICW: Short Run

|                  |                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**         | Saturday 16 March 2024, 10:00 to 14:00 EDT (14:00 to 18:00 UTC). AIS covers 13:00 to 19:00 UTC so traffic is already moving at the start.          |
| **Where**        | Rickenbacker Marina to Pier 66 Marina, Fort Lauderdale, berth to berth, along the Atlantic Intracoastal Waterway, 22.5 nm.                         |
| **Why this day** | A spring-break Saturday: heavy recreational traffic on the waterway, and a moderate 8 to 11 kn breeze.                                             |
| **Availability** | Everything is US government data in the public domain or under CC0, so AIS, weather and tides are included. Depth is fetched because it is 214 MB. |

## Route

**This route follows a real passage**: a vessel that ran it on the same day, from the
sample's own CC0 AIS.

`route.json`: Coquina (MMSI 367555210), a 20 m motor yacht, 22.5 nm berth to berth in 3 h 48
min as planned (22.7 nm, 3 h 52 min once adjusted for depth), including four bridge-opening
holds, at 3 kn in the marinas, 5.5 to 7.5 kn through the no-wake stretches and up to 15.5 kn
across open Biscayne Bay. Derived from a real 10 to 30 m vessel's passage in this sample's
AIS, with nothing that identifies it kept. See [the routes README](../../routes/README.md)
for how, and `npx ts-node simulator/tools/route.ts show miami-icw-2024-03-16` for the legs.

### Bridges

The four holds wait for bascule bridges over the Intracoastal Waterway, named in the
route's `bridges` list (and in `sample.json`'s `route.bridges`, which `derive` copies
in). Each was matched to its hold by position against OpenStreetMap's bridges; the
clearances are the closed vertical clearance at the centre of the span:

| Hold        | Bridge                                     | ICW mile | Closed clearance | The hold                  |
| ----------- | ------------------------------------------ | -------- | ---------------- | ------------------------- |
| waypoint 7  | 79th Street Causeway (JFK Causeway) bridge | 1084.6   | 25 ft, 7.6 m     | 2 min 21 s, 440 m south   |
| waypoint 9  | Broad Causeway (NE 123rd Street) bridge    | 1081.4   | 16 ft, 4.9 m     | 4 min 30 s, at the bridge |
| waypoint 18 | Hollywood Boulevard (State Route 820)      | 1072.2   | 25 ft, 7.6 m     | 9 min 50 s, 65 m north    |
| waypoint 20 | Dania Beach Boulevard (State Route A1A)    | 1069.4   | 22 ft, 6.7 m     | 17 min 17 s, 50 m north   |

- **Source:** U.S. Coast Pilot 4, chapter 12, Intracoastal Waterway (NOAA Office of Coast
  Survey, edition of 1 November 2026, read 4 November 2026):
  https://nauticalcharts.noaa.gov/publications/coast-pilot/files/cp4/CPB4_C12_WEB.pdf.
  Positions from OpenStreetMap, read the same day through the Overpass API.
- **Coquina clears three of them closed.** Her air height is 5.9 m, from the profile's
  length; only the Broad Causeway bridge, at 4.9 m, has to open for her. The source
  vessel waited at all four, so it was taller; the holds keep its timing, and the status
  line says where she would have cleared.
- **Two holds are just north of their bridges.** The source vessel ran the passage
  southward, so it waited on the north side; run northward, Coquina holds just past the
  Hollywood Boulevard and Dania Beach Boulevard bridges.

## Data

### AIS: `open/ais.csv`

75,593 position reports from 855 vessels (689 pleasure craft, 51 sailing, 26 passenger, 20
cargo), 25.68N to 26.16N and 80.30W to 80.00W, at the full reporting rate with real MMSIs
and names.

| Column                            | Meaning                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `mmsi`                            | MMSI                                                                                              |
| `base_date_time`                  | time of the report, UTC                                                                           |
| `lat`, `lon`                      | position, decimal degrees                                                                         |
| `sog`, `cog`, `heading`           | speed over ground (kn), course over ground (degrees), true heading (degrees, 511 = not available) |
| `vessel_name`, `imo`, `call_sign` | identity, as broadcast                                                                            |
| `vessel_type`, `status`, `cargo`  | AIS ship type, navigational status and cargo codes                                                |
| `length`, `width`, `draft`        | metres                                                                                            |
| `transceiver`                     | AIS class (A or B)                                                                                |

- **Source:** NOAA Office for Coastal Management and BOEM, Nationwide AIS 2024, daily file
  `ais-2024-03-16.parquet` from
  https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/ais2024/ais-2024-03-16.parquet
  (catalogue: https://www.fisheries.noaa.gov/inport/item/73064).
- **Licence:** CC0 1.0 (https://github.com/ocm-marinecadastre/ais-vessel-traffic).
- **How it was cut:** with DuckDB and its spatial extension:

  ```sql
  COPY (
    SELECT mmsi, base_date_time, ST_Y(geometry) lat, ST_X(geometry) lon, sog, cog, heading,
           vessel_name, imo, call_sign, vessel_type, status, length, width, draft, cargo,
           transceiver
    FROM 'ais-2024-03-16.parquet'
    WHERE ST_Y(geometry) BETWEEN 25.68 AND 26.16 AND ST_X(geometry) BETWEEN -80.30 AND -80.00
      AND base_date_time BETWEEN '2024-03-16 13:00:00' AND '2024-03-16 19:00:00'
    ORDER BY base_date_time
  ) TO 'ais.csv' (HEADER)
  ```

### Weather: `open/weather/ndbc-*.txt`

NOAA National Data Buoy Center standard meteorological data for the whole UTC day, in NDBC's
own text format (the two header lines name the columns and units): wind direction and speed,
gusts, waves where measured, pressure, air and water temperature.

| File                        | Station                                      |
| --------------------------- | -------------------------------------------- |
| `ndbc-vakf1-2024-03-16.txt` | VAKF1, Virginia Key (6-minute)               |
| `ndbc-pegf1-2024-03-16.txt` | PEGF1, Port Everglades (6-minute)            |
| `ndbc-41122-2024-03-16.txt` | 41122, Hollywood Beach wave buoy (30-minute) |

- **Source:** https://www.ndbc.noaa.gov/data/historical/stdmet/ (`<station>h2024.txt.gz`,
  cut to 16 March).
- **Used for:** the air temperature (VAKF1, PEGF1), the water temperature (VAKF1, 41122) and
  the waves (41122); see [the weather README](../../weather/README.md).
- **Licence:** US government work, public domain.

### Tides and Water Level: `open/weather/coops_*.csv`

NOAA CO-OPS 6-minute data for 16 and 17 March (UTC), metric, water levels relative to MLLW:
observed water level, tide predictions, wind and air pressure, for Virginia Key (8723214)
and Port Everglades (8722956).

- **Used for:** the wind, the pressure, the tide height and the water level on the depth
  grid. NAVD88, the depth grid's datum, is 0.614 m above MLLW at Virginia Key and 0.676 m at
  South Port Everglades (CO-OPS datums, epoch 1983 to 2001); see
  [the weather README](../../weather/README.md#the-tide-on-the-depth).

- **Source:** https://api.tidesandcurrents.noaa.gov/api/prod/datagetter, for example
  `?begin_date=20240316&end_date=20240317&station=8723214&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=csv`.
- **Licence:** US government work, public domain.

### Current: `open/weather/coops_{MIH0901,PEV0903}_currents_predictions_20240316.csv`

NOAA CO-OPS 6-minute current predictions for 16 and 17 March (UTC), knots, at two harmonic
current stations: Miami Harbor Entrance, at Government Cut (MIH0901, 25.76405 N 80.13394 W,
the 8 ft bin), and Port Everglades, 17th Street Bridge, on the ICW beside Pier 66 (PEV0903,
26.09973 N 80.1191 W, the 6 ft bin). Each row gives the speed along the channel's major
axis, flood positive and ebb negative, with the station's mean flood and ebb directions
(293° and 114° at Government Cut, 22° and 184° at the bridge).

- **Used for:** the current under the boat, blended between the two stations; see
  [sailing](../../sailing/README.md#the-current). The flood at Government Cut runs at up to
  1.7 kn on the afternoon of the passage.
- **Source:** https://api.tidesandcurrents.noaa.gov/api/prod/datagetter, for example
  `?product=currents_predictions&station=MIH0901&bin=9&begin_date=20240316&end_date=20240317&time_zone=gmt&units=english&interval=6&format=csv`,
  fetched on 4 November 2026.
- **Licence:** US government work, public domain.

### Depth: `cache/BlueTopo_*.tiff` (Fetched)

NOAA BlueTopo, the National Bathymetric Source compilation of hydrographic surveys: 27 tiles
at 4 m resolution covering the route, each a GeoTIFF with elevation, uncertainty and source
layers, plus its `.aux.xml` attribute table. Elevations are metres, positive up.

- **Fetch:** `npx ts-node simulator/tools/sample-data.ts fetch miami-icw-2024-03-16`.
  `sample.json` lists every tile with the SHA-256 published in NOAA's tile scheme.
- **Source:** https://github.com/noaa-ocs-hydrography/BlueTopo, tiles from the
  `noaa-ocs-nationalbathymetry-pds` bucket, chosen with the tile scheme
  `BlueTopo_Tile_Scheme_20261029_142421.gpkg` for 25.68N to 26.16N, 80.30W to 80.00W.
- **Licence:** CC0 1.0. NOAA asks that it not be used for navigation.

### Magnetic Variation: `magnetic-variation.json`

The magnetic variation over the route on the sample's date, about 7°W, as a grid every half
degree. The simulator reads between the grid points to send `navigation.headingMagnetic`,
`courseOverGroundMagnetic` and `magneticVariation` (see
[the vessels README](../../vessels/README.md#navigation)).

- **Source:** NOAA NCEI magnetic field calculator
  (https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml), International Geomagnetic
  Reference Field (DGRF2020) on 16 March 2024.
  `npx ts-node simulator/tools/magnetic-variation.ts miami-icw-2024-03-16` rewrites it.
- **Licence:** the IGRF is published by IAGA for free use; the calculator's output is US
  Government work.

## Attribution

AIS: NOAA Office for Coastal Management and BOEM, MarineCadastre.gov Nationwide AIS. Depth:
NOAA Office of Coast Survey, BlueTopo. Weather and tides: NOAA NDBC and NOAA CO-OPS.
Magnetic variation: NOAA NCEI magnetic field calculator, International Geomagnetic
Reference Field (IAGA). Bridge clearances: NOAA Office of Coast Survey, U.S. Coast Pilot 4;
bridge positions: OpenStreetMap contributors (ODbL).
