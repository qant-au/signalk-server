# Manly to Hamilton Island: Long Passage

|                     |                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**            | Depart Manly (Brisbane) Friday 21 August 2026 06:00 AEST (20 August 20:00 UTC) at 8.5 kn on passage; 566.1 nm in about 68 hours, arriving about 02:00 AEST on Monday 24 August. AIS covers 20 August 18:00 to 24 August 00:00 UTC.                             |
| **Where**           | About 566 nm up the Queensland coast: out of Moreton Bay by the North West Channel, outside Fraser Island and round Breaksea Spit, coastal past Bustard Head, Gladstone, the Keppel Islands and the Percy Isles, then into the Whitsundays to Hamilton Island. |
| **Why this window** | South-easterly 8 to 16 kn on the quarter, after the stronger trades of 15 to 20 August eased.                                                                                                                                                                  |
| **Availability**    | Weather, waves and wave buoys are included. Depth is fetched (3.8 GB). The AIS has to be downloaded by the user: see [Getting the AIS](#getting-the-ais).                                                                                                      |

## Route

**This route is hand-written, not a recorded track.** The sample's AIS is licensed CC BY-NC (AMSA), so a route traced from it could not be shared here; it is a plausible passage along charted waters instead.

`route.json`: Coral Passage (MMSI 503555210), a 15 m motor-sailer, 566.1 nm from a berth in Manly Boat Harbour to a berth in Hamilton Island marina in 68 h 04 min as planned (566.4 nm, 68 h 09 min once adjusted for depth), at 3 kn leaving Manly, 7 kn in the Manly channel, 8.5 kn on passage, 6 kn among the Whitsunday islands and 2 to 4 kn into Hamilton Island marina. Hand-written from charted features and checked against the Great Barrier Reef 30 m depth model; not derived from the AIS, whose licence does not allow it. See [the routes README](../../routes/README.md).

## Data

### Weather: `open/weather/open-meteo-*.json`

Hourly data for 20 to 24 August 2026 (UTC) at nine points along the route, in Open-Meteo's
JSON format (one object per point, in route order from Moreton Bay to the Whitsundays).

| File                        | Contents                                                                                    | Model and Licence          |
| --------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| `open-meteo-gfs.json`       | wind speed (kn), direction and gusts, pressure, temperature, humidity, cloud, precipitation | NOAA GFS, public domain    |
| `open-meteo-ecmwf-ifs.json` | the same variables                                                                          | ECMWF IFS 0.25°, CC BY 4.0 |
| `open-meteo-ecmwf-wam.json` | wave height, direction and period, swell, ocean current speed and direction, sea level      | ECMWF WAM 0.25°, CC BY 4.0 |

- **Source:** Open-Meteo historical forecast and marine APIs, for example
  https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=-27.35,-26.6,-25.5,-24.7,-24.0,-23.3,-22.4,-21.4,-20.4&longitude=153.25,153.25,153.35,153.35,152.3,151.4,150.6,149.6,148.95&start_date=2026-08-20&end_date=2026-08-24&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,relative_humidity_2m,cloud_cover,precipitation&models=gfs_seamless&wind_speed_unit=kn&timezone=GMT
  (`models=ecmwf_ifs025` for the second file;
  https://marine-api.open-meteo.com/v1/marine with `models=ecmwf_wam025` for the third).
- **Licence:** Open-Meteo's data is CC BY 4.0, and each model's own licence is listed above.

### Wave Buoys: `open/weather/buoys/*.csv`

Queensland Government Coastal Data System wave buoys, 30-minute records, 20 to 24 August
2026: `Date/Time (AEST)`, `Hs` and `Hmax` (m), `Tz` and `Tp` (s), peak direction (degrees),
sea surface temperature (°C). Stations: Brisbane, Mooloolaba, Emu Park and Mackay.

- **Source:** Queensland Government open data, for example
  https://www.data.qld.gov.au/dataset/coastal-data-system-waves-mackay (the 2026 "Wave data"
  resource, cut to the window).
- **Licence:** CC BY 4.0.

### Depth: `cache/Great_Barrier_Reef_*_2020_30m_MSL_cog.tif` (fetched)

Geoscience Australia's high-resolution depth model for the Great Barrier Reef, 30 m, 2020,
as Cloud Optimised GeoTIFFs in metres relative to mean sea level. The route needs two of its
four grids: **D** (23S to 29S, 150E to 156E: Brisbane to Gladstone) and **C** (18S to 24S,
148E to 154E: Gladstone to the Whitsundays).

- **Fetch:** `npx ts-node simulator/tools/sample-data.ts fetch manly-hamilton-island-2026-08-21`
  downloads the 3.8 GB archive once (checked against its SHA-256) and extracts grids C and D.
- **Source:** Beaman, R.J. and Geoscience Australia, http://pid.geoscience.gov.au/dataset/ga/115066,
  archive at
  https://files.ausseabed.gov.au/survey/Great%20Barrier%20Reef%20Bathymetry%202020%2030m.zip
- **Licence:** CC BY 4.0. Not to be used for navigation.

### AIS: `restricted/ais.csv` (downloaded by the user)

93,610 positions from 2,255 vessels between 19.8S and 28.0S, 148.4E and 154.0E.

| Column                            | Meaning                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `craft_id`                        | a stable number per vessel; AMSA removes MMSI, IMO, name and callsign   |
| `utc`                             | time of the report, ISO 8601 UTC                                        |
| `lat`, `lon`                      | position, decimal degrees                                               |
| `sog_kn`, `cog_deg`               | speed over ground (kn), course over ground (degrees)                    |
| `type`                            | vessel type as text, for example "Cargo ship - All" or "Pleasure craft" |
| `length_m`, `beam_m`, `draught_m` | dimensions (0 when not reported)                                        |

**One position per vessel per hour.** AMSA thins the data to a minimum of 60 minutes between
reports from the same vessel, so the simulator interpolates between them. Ships move smoothly
but do not show real manoeuvres.

### Magnetic Variation: `magnetic-variation.json`

The magnetic variation over the route on the sample's date, 7.9 to 11.5°E, as a grid every half
degree. The simulator reads between the grid points to send `navigation.headingMagnetic`,
`courseOverGroundMagnetic` and `magneticVariation` (see
[the vessels README](../../vessels/README.md#navigation)).

- **Source:** NOAA NCEI magnetic field calculator
  (https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml), International Geomagnetic
  Reference Field (IGRF2025) on 20 August 2026.
  `npx ts-node simulator/tools/magnetic-variation.ts manly-hamilton-island-2026-08-21` rewrites it.
- **Licence:** the IGRF is published by IAGA for free use; the calculator's output is US
  Government work.

## Getting the AIS

**Why it is not included.** The data is published by the Australian Maritime Safety Authority
(AMSA) under **Creative Commons Attribution-NonCommercial 3.0 Australia**, which allows
non-commercial use with credit to AMSA but cannot be redistributed inside an Apache 2.0
project. AMSA's terms of use also ask that its website is not linked to without its written
consent, so this page names the page to visit rather than linking to it.

1. Search for **Spatial@AMSA**, AMSA's spatial data site, and open **Digital Data**, then
   **Vessel Traffic Data**.
2. Download **August 2026**. You receive `Vessel Traffic Data August 2026.zip` (about
   137 MB), which holds the Shapefile (`cts_srr_08_2026_pt.zip`) and its metadata PDF.
3. Put the ZIP, unopened and with its name unchanged, in `simulator/downloads/`.
4. Run:

   ```shell
   npx ts-node simulator/tools/sample-data.ts prepare manly-hamilton-island-2026-08-21
   ```

   It reads the Shapefile's table straight from the archive (no GIS software needed), keeps
   the reports inside the window and the area above, and writes `restricted/ais.csv`. It
   takes a few seconds.

Use of the result must stay non-commercial, crediting AMSA, as its licence requires.

**Notes on the source file.** AMSA's metadata PDF describes the timestamp as 12-hour with
AM/PM, but the file holds 24-hour UTC times, sometimes with fractional seconds and sometimes
followed by a stray AM or PM that does not change the hour; the tool handles all three.
The table's column names also differ from the PDF (`craft_id, longitude, latitude, course,
speed, type, length, beam, draught, timestamp`, and no `subtype`).

## Attribution

AIS: Australian Maritime Safety Authority, Craft Tracking System, August 2026, CC BY-NC 3.0
AU, downloaded by the user and not distributed with this software. Depth: Beaman, R.J. and
Geoscience Australia, High-resolution depth model for the Great Barrier Reef, 30 m (2020),
CC BY 4.0. Wave buoys: State of Queensland (Department of the Environment, Tourism, Science
and Innovation), Coastal Data System, CC BY 4.0. Weather: Weather data by Open-Meteo.com
(https://open-meteo.com/); NOAA GFS; ECMWF IFS and WAM, CC BY 4.0.
Magnetic variation: NOAA NCEI magnetic field calculator, International Geomagnetic
Reference Field (IAGA).
