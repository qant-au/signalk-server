# Simulator Samples and Data Tools

This folder holds the sample scenarios for the Signal K simulator and the tools that fetch and
prepare their data. The simulator itself is described in [SIMULATOR.md](../SIMULATOR.md).

## Layout

```
simulator/
  README.md                 this file
  tools/                    TypeScript tools: fetch and prepare data, routes, AIS coverage
  ais/                      the AIS reception model (what a boat would actually hear)
  routes/                   own-boat routes: format, timing and position along the way
  downloads/                (git-ignored) files the user downloads from licensed sources
  samples/<sample>/
    README.md               the sample: when, where, every dataset, its source and licence
    sample.json             what the tools fetch and prepare, and how its AIS columns map
    route.json              the own boat's passage (see routes/README.md)
    open/                   openly licensed data, committed to the repository
    cache/                  (git-ignored) large open files, fetched by the tools
    restricted/             (git-ignored) data prepared from a licensed download
```

## The Three Samples

| Sample                                                                         | Window                                                | Data Availability                                                                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Miami ICW](samples/miami-icw-2024-03-16/README.md)                            | Sat 16 March 2024, 10:00 to 14:00 EDT                 | AIS, weather and tides **included**. Depth **fetched** (4 m NOAA BlueTopo, 214 MB).                                                                       |
| [Saronic Gulf](samples/saronic-gulf-2018-07-13/README.md)                      | Fri 13 July 2018 14:00 to Sat 10:00 EEST              | Depth and weather **included**. AIS and the dataset's own weather **downloaded by the user** (licence below).                                             |
| [Manly to Hamilton Island](samples/manly-hamilton-island-2026-08-21/README.md) | Departs Fri 21 August 2026 06:00 AEST, about 68 hours | Weather, waves and wave buoys **included**. Depth **fetched** (Great Barrier Reef 30 m, 3.8 GB). AIS **downloaded by the user** (non-commercial licence). |

**Included** means the files are in `open/` and need nothing further. **Fetched** means the
source is openly licensed but too large to commit; one command downloads it. **Downloaded by
the user** means the source does not allow redistribution, so each user downloads it from the
publisher and runs one command to prepare it.

## Getting the Data

Requires Node 22 or later and a checkout of this repository with `npm install` done.

```shell
# open data too large for the repository (checksummed where the publisher gives one)
npx ts-node simulator/tools/sample-data.ts fetch miami-icw-2024-03-16
npx ts-node simulator/tools/sample-data.ts fetch manly-hamilton-island-2026-08-21

# licensed data: download it first, as the sample's README describes, into simulator/downloads/
npx ts-node simulator/tools/sample-data.ts prepare saronic-gulf-2018-07-13
npx ts-node simulator/tools/sample-data.ts prepare manly-hamilton-island-2026-08-21
```

Both commands are safe to run again. `fetch` skips files it already has. The tools need no
GIS software: they read the publishers' ZIP archives and Shapefile tables directly.

## Licensing

The simulator work is Copyright © 2026 Adam Burgess, under the Apache License 2.0 like the
rest of this repository. **Each dataset keeps its own licence**, stated in its sample's
README with the attribution it requires. Only data whose licence allows redistribution is
committed. Data under a non-commercial or share-alike licence is never committed, and the
ignore rules keep `downloads/`, `cache/` and `restricted/` out of git.

None of this data is for navigation.
