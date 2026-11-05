# Saronic Gulf: Overnight

|                    |                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**           | Friday 13 July 2018 14:00 to Saturday 14 July 10:00 EEST (11:00 to 07:00 UTC), 20 hours.                                                                                                                                           |
| **Where**          | A loop out of Zea Marina, Piraeus: west of Aegina and Angistri, past Methana and Poros, round Cape Skyli to Hydra, and back east of Aegina. It stays inside the gulf because the AIS comes from a single receiver beside the port. |
| **Why this night** | Peak ferry season, with a night wind averaging 7 kn and gusting to 15 kn.                                                                                                                                                          |
| **Availability**   | Depth and weather are included. The AIS, and the weather that ships with it, have to be downloaded by the user: see [Getting the AIS](#getting-the-ais).                                                                           |

## Route

**This route is hand-written, not a recorded track.** The sample's AIS is licensed CC
BY-NC-SA, so a route traced from it could not be shared here; it is a plausible passage
along charted waters instead.

`route.json`: Meltemi (MMSI 239555210), a 15 m sailing yacht, 98.8 nm from a berth in Zea
Marina back to the same berth in 19 h 48 min as planned (99.2 nm, 19 h 54 min once adjusted
for depth), at 3 kn in the marina and 6 kn under sail, with an evening at anchor in Skala
bay on Angistri from 17:58 to 20:28 EEST (see
[Anchorage](../../routes/README.md#anchorage)). Hand-written from charted features and
checked against the EMODnet depth grid; not derived from the AIS, whose licence does not
allow it. See [the routes README](../../routes/README.md).

## Data

### Depth: `open/depth/emodnet-dtm2024-saronic.nc`

EMODnet Digital Bathymetry (DTM 2024) for 37.20N to 38.05N, 22.90E to 24.10E, NetCDF, at
1/16 arc-minute (about 115 m). The `elevation` variable is metres relative to Lowest
Astronomical Tide, negative below the surface. This is the coarsest depth of the three
samples; no finer openly licensed survey of the gulf was found.

- **Source:** EMODnet ERDDAP,
  https://erddap.emodnet.eu/erddap/griddap/bathymetry_dtm_2024.nc?elevation%5B(37.20):1:(38.05)%5D%5B(22.90):1:(24.10)%5D
- **Licence:** CC BY 4.0.

### Weather: `open/weather/open-meteo-era5.json`

Hourly wind speed (kn), direction and gusts, pressure, temperature, humidity, cloud and
precipitation for 13 and 14 July 2018 (UTC) at five points along the gulf, in Open-Meteo's
JSON format (one object per point).

- **Source:** Open-Meteo historical weather API (ERA5 reanalysis),
  https://archive-api.open-meteo.com/v1/archive?latitude=37.93,37.75,37.52,37.35,37.6&longitude=23.65,23.45,23.45,23.4,23.0&start_date=2018-07-13&end_date=2018-07-14&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,relative_humidity_2m,cloud_cover,precipitation&wind_speed_unit=kn&timezone=GMT
- **Licence:** Open-Meteo's data is CC BY 4.0. The ERA5 data underneath is Copernicus
  Climate Change Service information, used under the Copernicus licence, which allows
  redistribution with attribution.
- **Not available:** Open-Meteo's marine archive has no wave data for the gulf in 2018.
- **Used for:** the wind, the pressure, the air temperature and the humidity; the dataset's
  own GFS fields join them when they have been downloaded. The sample has no water
  temperature, waves or water level, so the depth is the grid's, at LAT, and no tide is
  sent. See [the weather README](../../weather/README.md).
- **No current:** neither source gives a current, and Open-Meteo's marine archive returns no
  ocean current for the gulf in July 2018 (every hour empty, checked 4 November 2026), so
  the boat sails on the model's own seeded current, a tenth to four tenths of a knot (see
  [sailing](../../sailing/README.md#the-current)).

### AIS and Dataset Weather: `restricted/` (Downloaded by the User)

| File                         | Contents                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restricted/ais.csv`         | 385,418 reports from 359 vessels: `timestamp` (Unix ms, UTC), `vessel_id` (a hash; no MMSI or name), `lon`, `lat`, `heading`, `speed` (kn), `course`                                  |
| `restricted/vessels.csv`     | the dataset's vessel list: `vessel_id`, `country`, `shiptype` (AIS type code)                                                                                                         |
| `restricted/weather-gfs.csv` | NOAA GFS fields the dataset ships for the area, 3-hourly at 45 grid points: temperature (K), pressure (Pa), humidity, gusts and wind (m/s), wind direction, visibility, precipitation |

### Magnetic Variation: `magnetic-variation.json`

The magnetic variation over the route on the sample's date, 4.4 to 4.6°E, as a grid every
half degree. The simulator reads between the grid points to send
`navigation.headingMagnetic`, `courseOverGroundMagnetic` and `magneticVariation` (see [the
vessels README](../../vessels/README.md#navigation)).

- **Source:** NOAA NCEI magnetic field calculator
  (https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml), International Geomagnetic
  Reference Field (DGRF2015) on 13 July 2018.
  `npx ts-node simulator/tools/magnetic-variation.ts saronic-gulf-2018-07-13` rewrites it.
- **Licence:** the IGRF is published by IAGA for free use; the calculator's output is US
  Government work.

## Getting the AIS

**Why it is not included.** The dataset's record on Zenodo states CC BY 4.0, but the README
inside each of its data archives states **CC BY-NC-SA 4.0** (non-commercial, share-alike).
Until the authors confirm which applies, it is treated as the stricter licence, which cannot
be redistributed inside an Apache 2.0 project. Each user downloads it and accepts its terms
themselves.

1. Open the dataset's Zenodo record: https://zenodo.org/records/6323416 ("The Piraeus AIS
   Dataset for Large-scale Maritime Data Analytics").
2. Download these three files into `simulator/downloads/`:
   - `unipi_ais_dynamic_2018.zip` (1.7 GB)
   - `ais_static.zip` (255 KB)
   - `noaa_weather.zip` (6.8 MB)
3. Run:

   ```shell
   npx ts-node simulator/tools/sample-data.ts prepare saronic-gulf-2018-07-13
   ```

   It reads `unipi_ais_dynamic_jul2018.csv` straight from the archive and keeps the reports
   between 2018-07-13 11:00 and 2018-07-14 07:00 UTC, copies the vessel list, and cuts the
   July 2018 weather table to the same window. It takes a few seconds and needs about 50 MB.

## Attribution

AIS and dataset weather: Tritsarolis, A., Kontoulis, Y. and Theodoridis, Y., "The Piraeus
AIS dataset for large-scale maritime data analytics", Data in Brief 40 (2022) 107782,
https://doi.org/10.1016/j.dib.2021.107782, data at https://zenodo.org/records/6323416.
Depth: EMODnet Bathymetry Consortium, EMODnet Digital Bathymetry (DTM 2024). Weather:
Weather data by Open-Meteo.com (https://open-meteo.com/), contains modified Copernicus
Climate Change Service information 2018. Magnetic variation: NOAA NCEI magnetic field
calculator, International Geomagnetic Reference Field (IAGA).
