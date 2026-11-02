# Miami ICW: Short Run

|                  |                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**         | Saturday 16 March 2024, 10:00 to 14:00 EDT (14:00 to 18:00 UTC). AIS covers 13:00 to 19:00 UTC so traffic is already moving at the start.          |
| **Where**        | Biscayne Bay off Brickell to Port Everglades along the Atlantic Intracoastal Waterway, 21.6 nm.                                                    |
| **Why this day** | A spring-break Saturday: heavy recreational traffic on the waterway, and a moderate 8 to 11 kn breeze.                                             |
| **Availability** | Everything is US government data in the public domain or under CC0, so AIS, weather and tides are included. Depth is fetched because it is 214 MB. |

## Route

`route.json`: a 20 m motor yacht, 21.6 nm in 3 h 11 min including four bridge-opening holds, at 5.5 to 7.5 kn through the no-wake stretches and up to 15.5 kn across open Biscayne Bay. Derived from a real 10 to 30 m vessel's passage in this sample's AIS, with nothing that identifies it kept. See [the routes README](../../routes/README.md) for how, and `npx ts-node simulator/tools/route.ts show miami-icw-2024-03-16` for the legs.

## Data

### AIS: `open/ais.csv`

75,593 position reports from 855 vessels (689 pleasure craft, 51 sailing, 26 passenger, 20
cargo), 25.68N to 26.16N and 80.30W to 80.00W, at the full reporting rate with real MMSIs and
names.

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
- **Licence:** US government work, public domain.

### Tides and Water Level: `open/weather/coops_*.csv`

NOAA CO-OPS 6-minute data for 16 and 17 March (UTC), metric, water levels relative to MLLW:
observed water level, tide predictions, wind and air pressure, for Virginia Key (8723214)
and Port Everglades (8722956).

- **Source:** https://api.tidesandcurrents.noaa.gov/api/prod/datagetter, for example
  `?begin_date=20240316&end_date=20240317&station=8723214&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=csv`.
- **Licence:** US government work, public domain.

### Depth: `cache/BlueTopo_*.tiff` (fetched)

NOAA BlueTopo, the National Bathymetric Source compilation of hydrographic surveys: 27 tiles
at 4 m resolution covering the route, each a GeoTIFF with elevation, uncertainty and source
layers, plus its `.aux.xml` attribute table. Elevations are metres, positive up.

- **Fetch:** `npx ts-node simulator/tools/sample-data.ts fetch miami-icw-2024-03-16`.
  `sample.json` lists every tile with the SHA-256 published in NOAA's tile scheme.
- **Source:** https://github.com/noaa-ocs-hydrography/BlueTopo, tiles from the
  `noaa-ocs-nationalbathymetry-pds` bucket, chosen with the tile scheme
  `BlueTopo_Tile_Scheme_20261029_142421.gpkg` for 25.68N to 26.16N, 80.30W to 80.00W.
- **Licence:** CC0 1.0. NOAA asks that it not be used for navigation.

## Attribution

AIS: NOAA Office for Coastal Management and BOEM, MarineCadastre.gov Nationwide AIS. Depth:
NOAA Office of Coast Survey, BlueTopo. Weather and tides: NOAA NDBC and NOAA CO-OPS.
