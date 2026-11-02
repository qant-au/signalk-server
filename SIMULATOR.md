# Signal K Simulator (This Fork)

This repository is a **deliberately maintained parallel fork** of
[SignalK/signalk-server](https://github.com/SignalK/signalk-server). It is not an abandoned
copy. It is kept in step with the main codebase through regular updates from upstream, and it
adds one thing on top: a **fully functional simulator for Signal K**.

The aim is to test systems, events, alarms and plugins against realistic conditions without
being on a vessel, and without depending on recorded logs from someone else's boat. Recorded
logs are not available to everyone, and they cannot be steered: you cannot ask a log to put a
ship on a collision course, drop a device off the NMEA 2000 bus or run the house bank flat.

The work is intended to be offered upstream as a pull request once it is ready. Until then it
is run as a separate project, so it can move at its own pace without asking the main project
to carry unfinished work.

## How the Fork Is Kept in Step

- `upstream` is the official Signal K Server repository, used for fetching only. Nothing is
  pushed or proposed from this fork until the simulator is ready to offer.
- Upstream changes are brought in regularly. The simulator is kept to its own files at the
  edges of the codebase, so those updates stay cheap and the server itself behaves exactly as
  upstream does.
- Everything outside the simulator is upstream's code, documentation and licence, unchanged.
  For the server itself, read the [main README](README.md) and the
  [official documentation](https://demo.signalk.org/documentation/).

## The Simulator Already in Signal K Server

Signal K Server has carried the start of a simulator since 2017. It is scaffolding for a
planned feature that was never built out, and this fork builds on it rather than replacing
or competing with it.

| Piece                                                                    | What It Is                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/simulator`                                                          | A start script, added in March 2017 ("add a very simple simulator") and last changed in June 2017. It installs the simulator plugin, writes a default plugin configuration, and starts the server with `settings/simulator.json`. It is not one of the commands the npm package installs, so it only runs from a source checkout. |
| `settings/simulator.json`                                                | Server settings for a vessel named "s/y Simulator", with a single data connection that uses the null provider. That provider produces no data: everything the server sees comes from the plugin.                                                                                                                                  |
| [`@signalk/simulatorplugin`](https://github.com/SignalK/simulatorplugin) | The plugin the script installs, version 0.0.1, last changed in June 2017. Each configured path gets a value that ramps between a minimum and a maximum. The default configuration simulates one path, speed over ground between 0 and 10 knots. It knows nothing about position, other vessels, depth, weather or time.           |

Separately, the server can **replay recorded logs**: the `--sample-nmea0183-data` and
`--sample-n2k-data` options and the `bin/*-from-file` scripts play files from `samples/` (a
few short logs from particular boats). Replay is useful, but it is fixed. It cannot be
steered, it covers only the boats and places that were recorded, and it carries no scenario
of its own.

**Why this fork exists, given the above:**

- **It is not a reproduction of anything that works today.** The existing simulator
  generates one oscillating number. A repeatable test scenario with recorded traffic, depth,
  weather, alarms and injected failures does not exist in the project.
- **It is not an alternative.** It extends the planned feature, using the same plugin
  approach and the same "start the server with simulator settings" entry point, so the
  original intent is kept rather than replaced.
- **It is not replay.** Scenarios are built from openly licensed source data and driven in
  simulated time, so they can be paused, sped up and given events. Recorded logs remain the
  right tool for reproducing a specific boat's data.

## Related Work

Checked against every issue and pull request in Signal K Server, and the wider SignalK
organisation, on 2 November 2026:

- **[#3243](https://github.com/SignalK/signalk-server/issues/3243) and
  [#3252](https://github.com/SignalK/signalk-server/pull/3252), the new demo showcase (open).**
  This is a live demonstration for latest.signalk.org: a simulated sailing boat on a route in
  the Dutch Wadden Sea, live AIS from Open Waters, an emulated autopilot and radar, built from
  existing plugins. It shows visitors what a Signal K boat looks like. This fork is aimed at
  testing instead: fixed, repeatable scenarios in several regions, with time control and
  injected events, so that a plugin can be run against the same conditions again and again.
  The two complement each other: the plugins the showcase runs (collision alerts, tides,
  underkeel and others) are exactly the kind of plugin these scenarios exist to test.
- **[`signalk-sailboat-simulator`](https://www.npmjs.com/package/signalk-sailboat-simulator)**
  (third party) is a motion simulator: it works out how the boat moves from autopilot
  output, weather and an active route, which have to be fed to it. This fork is a data
  simulator: it produces the data a boat's instruments and receivers would put on the server
  (own position, depth, wind and weather, AIS targets) from scenario source data. The data
  simulator is this fork's own work. The sailboat simulator can run alongside it to move the
  own boat, fed by the scenario's weather and route.
- Log replay issues (for example #313, #415 and #3043) concern playing back recorded files,
  which this fork does not change.

## Current Status

**Early stage: design and test data. No new simulator code has been written in this fork
yet; the existing scaffolding above is unchanged.**

| Area             | Status                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Test Rig         | A local Signal K Server built from this fork, running on its own the way it runs on a boat.                                               |
| Scenario Data    | Sources chosen and licences checked for the three samples below. The data has been collected for review and is not in the repository yet. |
| Simulator Engine | Not started. Planned: scenario playback into the server as ordinary Signal K deltas, with time control and injected events.               |
| Plugin Testing   | Not started. See "Testing With Existing Plugins" below.                                                                                   |

## The Three Samples

By design there are three samples. Two ship their data so anyone can run them straight away.
The third does not ship its data, because the source does not allow redistribution, and it
shows how a scenario works when the user has to fetch the data themselves.

| Sample                       | Where and When                                                                                             | Length         | Data                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Short Run, US**            | Miami Beach to Port Everglades along the Intracoastal Waterway, Saturday 16 March 2024, 10:00 to 14:00 EDT | About 4 hours  | **Included.** AIS, depth and weather from US government sources (public domain / CC0).                                                                                                                                                                                                   |
| **Overnight, Mediterranean** | Saronic Gulf from Piraeus, Greece, Friday 13 July 2018 14:00 to Saturday 10:00 EEST                        | 20 hours       | **Planned to be included**, subject to a licence point being confirmed with the data's authors. Attribution will be listed in a NOTICE file.                                                                                                                                             |
| **Long Passage, Australia**  | Manly (Brisbane) to Hamilton Island, Queensland, departing Friday 21 August 2026 06:00 AEST at 8.5 knots   | About 64 hours | **Not included.** The AIS source is licensed for non-commercial use only and cannot be redistributed. The sample ships instructions and a script that prepares the data once the user has downloaded it from the source. Depth and weather come from openly licensed Australian sources. |

Each sample combines:

- **AIS traffic**, so collision avoidance, CPA/TCPA alarms and target lists have real ships to
  work with;
- **depth**, from the most detailed open survey data available for the area rather than a
  coarse global grid, so depth alarms and shallow-water warnings are meaningful;
- **weather and sea state**, wind, pressure, temperature, waves and (where available) tides,
  timed to match the traffic.

None of the data is for navigation. It is used to make a simulation
realistic, nothing more.

## Testing With Existing Plugins

The simulator feeds a normal Signal K Server through the normal data path, so installed
plugins and webapps see the same deltas they would see from real instruments. That is the
point: a plugin is tested as it will run on a boat, not against a mock.

Planned test areas include:

- **Notifications and Alarms:** anchor drag, depth, wind and battery thresholds, and how
  `notifications.*` are raised, escalated and cleared.
- **AIS:** target handling, collision warnings, and many targets at once (the long passage
  carries over two thousand vessels).
- **Lost and Returning Data:** sources going quiet and coming back, devices faulting, and
  values out of range.
- **Long Running:** memory and stability over a multi-day passage rather than a short test.

Results and any issues found in third-party plugins will be reported to their authors, not
fixed in this fork.

## Two New Plugins Built Against the Simulator

The simulator is also the test bed for two open-source projects, each getting a Signal K
plugin.

- **[Axonometra](https://github.com/qant-au/axonometra):** a 3D planning engine for vessel and
  building plans. For boats it draws the vessel itself (hull, decks and equipment) and shows
  live state on the plan: tank levels, battery charge, propulsion and rudder, and the boat's
  attitude. Its Signal K plugin will read those values straight from the server.
- **[Reticulyne](https://github.com/qant-au/reticulyne):** an editor for diagrams of connected
  systems. Its catalogue covers NMEA 2000 (backbone, drops, terminators, power insertion,
  chartplotters, sensors and gateways) as well as IT networks. Its Signal K plugin will draw a
  boat's NMEA 2000 network from live data and show devices dropping off, coming back and
  faulting.

Both plugins will live in their own repositories. This fork only provides the simulated boat
they are tested against.

## Licence

The Signal K Server code in this repository remains under the
[Apache License, Version 2.0](LICENSE), as upstream.

**The simulator work added by this fork is Copyright © 2026 Adam Burgess**, licensed under the
same Apache License, Version 2.0. If the simulator is accepted into Signal K Server as a pull
request, it is contributed under the project's licence on the same terms as any other
contribution (Apache License 2.0, section 5), and its copyright line will follow the main
project's conventions.

Third-party data used by the samples keeps its own licence and attribution, listed with each
sample.
