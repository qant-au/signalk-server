# Weather and Tides

What the boat's instruments show of the weather and the water comes from each sample's own
data, read at the boat's position and the scenario time: the true wind, the air pressure,
the air and water temperature, the humidity, the waves, the water level on the depth, and
the tidal or ocean current.
Where a sample has none of a quantity, the boat's systems model supplies it as it always
has, and the tide is not invented: a sample with no water level sends no tide.

Each sample lists its sources under `weather` in its `sample.json`; `sources.ts` reads
them, one parser per file format, and `environment.ts` interpolates between their stations
and between their times.

## What Each Sample Gives

| Quantity            | Miami ICW                                                                                    | Saronic Gulf                                                                | Manly to Hamilton Island                                                   |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Wind and gusts      | CO-OPS Virginia Key and South Port Everglades, 6-minute                                      | Open-Meteo ERA5, hourly, 5 points; the dataset's GFS fields when downloaded | Open-Meteo ECMWF IFS, hourly, 9 points                                     |
| Air pressure        | the same CO-OPS stations                                                                     | as the wind                                                                 | as the wind                                                                |
| Air temperature     | NDBC VAKF1 and PEGF1, 6-minute, 16 March only                                                | as the wind                                                                 | as the wind                                                                |
| Humidity            | none: no station reports a dew point                                                         | as the wind                                                                 | as the wind                                                                |
| Water temperature   | NDBC VAKF1 and the 41122 buoy                                                                | none: the model's own                                                       | the four wave buoys and Open-Meteo's sea surface temperature, 9 points     |
| Waves               | the 41122 buoy, significant height                                                           | none: the model's sea, from the wind                                        | the four wave buoys and Open-Meteo ECMWF WAM, 9 points                     |
| Water level (depth) | CO-OPS observations, the predictions where they run out                                      | none                                                                        | Open-Meteo's sea level, including the tide, 9 points                       |
| Tide height         | above MLLW, the next high and low water from the predictions                                 | none                                                                        | none: the sea level is above mean sea level, not a chart datum (see below) |
| Current             | CO-OPS current predictions at Government Cut and the 17th Street Bridge on the ICW, 6-minute | none: the model's own seeded current                                        | Open-Meteo's ocean current (MeteoFrance SMOC), 9 points                    |

The files, in each sample's `open/weather/` (the Saronic GFS in `restricted/`):

| Sample     | File                                                                     | Format       | Gives                                       |
| ---------- | ------------------------------------------------------------------------ | ------------ | ------------------------------------------- |
| Miami      | `coops_8723214_{wind,air_pressure,water_level,predictions}_20240316.csv` | CO-OPS CSV   | wind, gusts, pressure, tide, water level    |
| Miami      | `coops_8722956_…_20240316.csv`                                           | CO-OPS CSV   | the same                                    |
| Miami      | `coops_{MIH0901,PEV0903}_currents_predictions_20240316.csv`              | CO-OPS CSV   | current                                     |
| Miami      | `ndbc-vakf1-2024-03-16.txt`                                              | NDBC text    | air and water temperature                   |
| Miami      | `ndbc-pegf1-2024-03-16.txt`                                              | NDBC text    | air temperature                             |
| Miami      | `ndbc-41122-2024-03-16.txt`                                              | NDBC text    | water temperature, wave height              |
| Saronic    | `open-meteo-era5.json`                                                   | Open-Meteo   | wind, gusts, pressure, air, humidity        |
| Saronic    | `restricted/weather-gfs.csv` (when downloaded)                           | GFS CSV      | the same, 3-hourly at 45 grid points        |
| Queensland | `open-meteo-ecmwf-ifs.json`                                              | Open-Meteo   | wind, gusts, pressure, air, humidity        |
| Queensland | `open-meteo-ecmwf-wam.json`                                              | Open-Meteo   | wave height                                 |
| Queensland | `open-meteo-marine.json`                                                 | Open-Meteo   | sea level, sea surface temperature, current |
| Queensland | `buoys/{brisbane,mooloolaba,emu-park,mackay}-2026-08-20_24.csv`          | QLD buoy CSV | wave height, sea surface temperature        |

Queensland's `open-meteo-gfs.json` is left unread: the ECMWF IFS covers the same points, and
two models pooled would give their mean, which neither forecast.

## The Stations

| Station                                                | Position               | Source                                                                                      |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------- |
| CO-OPS 8723214, Virginia Key                           | 25.7314 N, 80.1618 W   | NOAA CO-OPS station metadata                                                                |
| CO-OPS 8722956, South Port Everglades                  | 26.0817 N, 80.1167 W   | NOAA CO-OPS station metadata                                                                |
| CO-OPS MIH0901, Miami Harbor Entrance (Government Cut) | 25.76405 N, 80.13394 W | NOAA CO-OPS current station metadata                                                        |
| CO-OPS PEV0903, Port Everglades 17th Street Bridge     | 26.09973 N, 80.1191 W  | NOAA CO-OPS current station metadata                                                        |
| NDBC VAKF1, Virginia Key                               | 25.731 N, 80.162 W     | NDBC station page (the same site as 8723214)                                                |
| NDBC PEGF1, Port Everglades                            | 26.086 N, 80.116 W     | NDBC station page (the same site as 8722956)                                                |
| NDBC 41122, Hollywood Beach                            | 26.001 N, 80.096 W     | NDBC station page                                                                           |
| Brisbane wave buoy                                     | 27.4895 S, 153.6332 E  | Queensland Government live wave data, the buoy's reported positions averaged, November 2026 |
| Mooloolaba wave buoy                                   | 26.5671 S, 153.1813 E  | the same                                                                                    |
| Emu Park wave buoy                                     | 23.3028 S, 151.0721 E  | the same                                                                                    |
| Mackay wave buoy                                       | 21.0358 S, 149.5479 E  | the same                                                                                    |

The Open-Meteo files carry their own grid points; the GFS file carries its grid.

## Interpolation

**In time**, each station's record is read linearly between the readings either side of
the moment. A station counts only inside its own record, and not across a gap in it of more
than four hours (a 3-hourly model is read across; a buoy that stopped for an afternoon is
not). Its weight fades over the first and last hour of its record, so a station whose
record starts or ends during a run, such as the Saronic GFS fields at 12:00 and 06:00 UTC,
hands over to the others without a step.

**In place**, the stations that count at that moment are combined by inverse distance
squared. The wind is combined as a vector, so two stations with the wind from either side
of north give north, not south. A boat within 100 m of a station reads that station alone.

**Past the edges in place**, beyond the stations' spread, the nearest station dominates, and
the value never runs past what any station measured: inverse distance weighting cannot
extrapolate.

**Past the edges in time**, where no station's record reaches, every station holds its
first or last reading, combined the same way: the weather carries on as it last was. The
next high and low water are given only while the predictions reach them; past the end of
the predictions the tide height holds and the next high and low are not sent. Where the data
stops, by sample, for the systems soak's day out, which runs from local midnight:

| Sample     | Data covers (UTC)                                                                       | A day out beyond it                                                           |
| ---------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Miami      | CO-OPS 16 March 00:00 to 17 March 23:54; NDBC 16 March only                             | after 16 March the air and water temperature hold their 23:54 readings        |
| Saronic    | ERA5 13 July 00:00 to 14 July 23:00; GFS 13 July 12:00 to 14 July 06:00                 | the day out starts at 22:26 on 12 July, holding ERA5's first hour until 00:00 |
| Queensland | Open-Meteo 20 August 00:00 to 24 August 23:00; buoys 19 August 14:00 to 24 August 13:30 | inside the data throughout                                                    |

## The Tide on the Depth

The depth under the boat is the grid's depth below its datum plus the water level above
that datum. The depth sounders read it, so `environment.depth.belowSurface`,
`belowTransducer` and `belowKeel` all follow the tide; the route planner keeps to the grid's
depth, which for Miami and the Saronic is near the least water.

| Sample     | Grid and its datum                            | Water level                                                                                                                                                         | How it is brought onto the grid                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miami      | NOAA BlueTopo, NAVD88                         | CO-OPS observed water level above MLLW at Virginia Key and South Port Everglades, 6-minute; the predictions where an observation is missing or the observations end | NAVD88 lies 0.614 m above MLLW at Virginia Key and 0.676 m at South Port Everglades (CO-OPS datums, epoch 1983 to 2001), so each station's level less its offset is the level above the grid's datum, combined between the two stations by distance |
| Saronic    | EMODnet DTM 2024, Lowest Astronomical Tide    | none in the sample                                                                                                                                                  | none: the depth is the grid's, at LAT, the least water a tide gives; the Saronic Gulf's tide is a few tens of centimetres                                                                                                                           |
| Queensland | Geoscience Australia GBR 30 m, mean sea level | Open-Meteo's sea level height above mean sea level (MeteoFrance SMOC, tides and the inverted barometer included), hourly at 9 points                                | added as it is: both are above mean sea level                                                                                                                                                                                                       |

**The tide height** is sent as the specification has it, above chart datum
(`environment.tide.heightNow`, `heightHigh` and `heightLow` in metres, `timeHigh` and
`timeLow`), every five sends with the other slow values. Only Miami has it: its CO-OPS
levels are above MLLW, the chart datum of US charts, and its predictions give the next high
and low water, found in the predictions combined between the two stations. Queensland's
sea level is above mean sea level and the sample has no chart datum to put it on, so it
moves the depth but is not sent as a tide height. Schema 1.8.2 defines `timeHigh` and
`timeLow` as bare strings, which no delta can carry (a delta's value is wrapped), so the
schema checks leave those two out.

On Miami's passage the tide rises from 0.26 m above MLLW leaving Rickenbacker Marina at
14:00 UTC to 0.74 m at Pier 66 at 18:00, so the water stands 0.36 m below the grid's datum
at the start and about level with it at the end: early on the boat has less water than the
grid shows, and the shallow water alarm comes sooner; its times are in
[the vessels README](../vessels/README.md#alarms). Alongside at Pier 66 that evening the
tide falls 0.67 m to its low near 00:24, and the depth under her falls with it.

`heightNow` is the observed level, and the next high and low water are the predictions, as
a tide gauge and a tide table give them. When the weather holds the water above the
predicted tide they disagree: on Miami's afternoon the observations run about 0.1 m above
the predictions, so the height now can stand above the next predicted high water.

## The Current

The current is read like the tide: each source a station, read in time and blended between
stations by inverse distance squared, as a vector like the wind, holding its first or last
reading past the edges of the data. It acts on the water: the route gives the course and
speed over the ground, and the current the heading she holds against it and her speed
through the water (see [sailing](../sailing/README.md#the-current)).

| Sample     | Current                                                                                                                                                             | Read as                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Miami      | CO-OPS predictions at Miami Harbor Entrance (Government Cut, MIH0901, 8 ft bin) and the 17th Street Bridge on the ICW (PEV0903, 6 ft bin), 16 and 17 March          | the speed along each station's major axis, flood positive: towards its mean flood direction, else its ebb |
| Queensland | Open-Meteo's `ocean_current_velocity` and `ocean_current_direction` (MeteoFrance SMOC), hourly at the 9 marine points, 20 to 24 August, in `open-meteo-marine.json` | km/h, towards the direction given                                                                         |
| Saronic    | none in the sample                                                                                                                                                  | the seeded current the model has always had: a tenth to four tenths of a knot, wandering slowly           |

## What the Wind Feeds

The sample's wind is the true wind, and the seed's gusts and shifts ride on it: a speed that
wanders by about 2 kn over twenty minutes and a direction that wanders by about 15° over an
hour, drawn from the run's seed, so a run repeats exactly for a seed and start. Without a
sample's wind the model's own seeded breeze, with its afternoon sea breeze, is used as
before. The true wind then feeds:

- **Sailing:** a sailing yacht sails, motor-sails or motors as her polar gives the leg's
  speed, all of it, some of it or too little, and sets the sails the true wind calls for;
  her speed is the route's (see [sailing](../sailing/README.md#sail-or-motor)).
- **Heel and leeway:** from the apparent wind's pressure and the sails she has set (see
  [sailing](../sailing/README.md#heel-and-leeway)).
- **The apparent wind:** from the true wind and her own motion over the ground, off her bow.
- **The wind turbine:** its output from the apparent wind.
- **The anchor swing:** she lies downwind on her chain, out to its reach in 20 kn or more.
- **The true wind alarm:** the zones on `environment.wind.speedTrue`.

The thrusters do not read the wind: they run in bursts coming alongside and leaving,
whatever it blows. A boat with no wind instrument sends no wind, and a frozen one keeps
sending what it showed, on the sample's wind as before.

**The waves.** The specification has no paths for waves or swell, so they are not sent.
Where the sample measures the significant wave height, it is the sea the boat moves in, in
place of the sea the model builds from the wind: roll, pitch and the helm's error off the
track grow with it, sheltered alongside and at anchor as before.

## Tests

`test/simulator-weather.ts`, in `npm test`, reads known values straight from the sample
files: a buoy's reading at its position and hour, Virginia Key's wind, pressure and tide at
12:00 UTC, a reading between two of a station's times, a point between two stations against
the inverse distance sum, the next high water against the predictions file, Queensland's
Mackay buoy and the Saronic ERA5 points. It checks the edges (the first and last readings
held, a station across a gap left out, the nearest station dominating far off, no high and
low water past the predictions), the predictions taken where an observation is missing, the
wind, air, water and tide sent in a run, the apparent wind against the true wind and her
motion, the depth under the keel following the water level, a frozen wind instrument and a
boat without one, the schema, and that a seeded run repeats. The
[systems soak](../soak/README.md#what-it-checks) runs every case on its sample's weather.
