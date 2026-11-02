# Signal K Simulator (this fork)

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

## How the fork is kept in step

- `upstream` is the official Signal K Server repository, used for fetching only. Nothing is
  pushed or proposed from this fork until the simulator is ready to offer.
- Upstream changes are brought in regularly. The simulator is kept to its own files at the
  edges of the codebase, so those updates stay cheap and the server itself behaves exactly as
  upstream does.
- Everything outside the simulator is upstream's code, documentation and licence, unchanged.
  For the server itself, read the [main README](README.md) and the
  [official documentation](https://demo.signalk.org/documentation/).

## Current status

**Early stage: design and test data. There is no simulator code in this fork yet.**

| Area             | Status                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test rig         | A local Signal K Server built from this fork, with no Home Assistant or other host in the path: the server on its own, the way it runs on a boat. |
| Scenario data    | Sources chosen and licences checked for the three samples below. The data has been collected for review and is not in the repository yet.         |
| Simulator engine | Not started. Planned: scenario playback into the server as ordinary Signal K deltas, with time control and injected events.                       |
| Plugin testing   | Not started. See "Testing with existing plugins" below.                                                                                           |

## The three samples

By design there are three samples. Two ship their data so anyone can run them straight away.
The third does not ship its data, because the source does not allow redistribution, and it
shows how a scenario works when the user has to fetch the data themselves.

| Sample                       | Where and when                                                                                             | Length         | Data                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Short run, US**            | Miami Beach to Port Everglades along the Intracoastal Waterway, Saturday 16 March 2024, 10:00 to 14:00 EDT | About 4 hours  | **Included.** AIS, depth and weather from US government sources (public domain / CC0).                                                                                                                                                                                                   |
| **Overnight, Mediterranean** | Saronic Gulf from Piraeus, Greece, Friday 13 July 2018 14:00 to Saturday 10:00 EEST                        | 20 hours       | **Planned to be included**, subject to a licence point being confirmed with the data's authors. Attribution will be listed in a NOTICE file.                                                                                                                                             |
| **Long passage, Australia**  | Manly (Brisbane) to Hamilton Island, Queensland, departing Friday 21 August 2026 06:00 AEST at 8.5 knots   | About 64 hours | **Not included.** The AIS source is licensed for non-commercial use only and cannot be redistributed. The sample ships instructions and a script that prepares the data once the user has downloaded it from the source. Depth and weather come from openly licensed Australian sources. |

Each sample combines:

- **AIS traffic**, so collision avoidance, CPA/TCPA alarms and target lists have real ships to
  work with;
- **depth**, from the most detailed open survey data available for the area rather than a
  coarse global grid, so depth alarms and shallow-water warnings are meaningful;
- **weather and sea state**, wind, pressure, temperature, waves and (where available) tides,
  timed to match the traffic.

None of the data is for navigation. It is used to make a simulation
realistic, nothing more.

## Testing with existing plugins

The simulator feeds a normal Signal K Server through the normal data path, so installed
plugins and webapps see the same deltas they would see from real instruments. That is the
point: a plugin is tested as it will run on a boat, not against a mock.

Planned test areas include:

- **Notifications and alarms:** anchor drag, depth, wind and battery thresholds, and how
  `notifications.*` are raised, escalated and cleared.
- **AIS:** target handling, collision warnings, and many targets at once (the long passage
  carries over two thousand vessels).
- **Lost and returning data:** sources going quiet and coming back, devices faulting, and
  values out of range.
- **Long running:** memory and stability over a multi-day passage rather than a short test.

Results and any issues found in third-party plugins will be reported to their authors, not
fixed in this fork.

## Two new plugins built against the simulator

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
