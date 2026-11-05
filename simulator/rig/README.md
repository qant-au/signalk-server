# Test Rig

A Signal K Server built from this checkout, in a container, with
[Freeboard](https://github.com/SignalK/freeboard-sk) for watching a route on a chart. The
rig soak runs against it, and anyone can stand up the same environment from the repository
alone.

## Start and Stop

From the repository root, with Docker running:

```shell
docker compose -f simulator/rig/docker-compose.yml up -d --build   # build this checkout and start
docker compose -f simulator/rig/docker-compose.yml down            # stop and remove
```

| What            | Where                                        |
| --------------- | -------------------------------------------- |
| Freeboard       | http://127.0.0.1:4770/@signalk/freeboard-sk/ |
| KIP             | http://127.0.0.1:4770/@mxtommy/kip/          |
| Admin UI        | http://127.0.0.1:4770/                       |
| Signal K REST   | http://127.0.0.1:4770/signalk/v1/api/        |
| Signal K stream | ws://127.0.0.1:4770/signalk/v1/stream        |

Port 4770 is bound to loopback only. The rig has **no security configured**: any client
that can reach it can write data to it, which is how the simulator feeds it, and why it must
not be exposed beyond the machine running it.

## What Is In It

- **The server** is this repository's own source (`npm install`, then the workspace and
  server builds), not a published release, so the rig tests what is in the working tree.
  Rebuild with `--build` after changing the code.
- **Node** is `node:24-bookworm`, pinned by digest in the `Dockerfile`.
- **The simulator plugin** (`simulator/plugin`) is built and installed, and enabled by
  default: the rig starts sailing the Miami sample as soon as it is up. Its settings are in
  the Admin UI under Apps & Plugins, Configuration, Signal K Simulator, and its page, with
  the run's controls and faults, under Webapps, Signal K Simulator; see [the plugin
  README](../plugin/README.md).
- **The samples** are mounted from `simulator/samples`, so the depth grids fetched and the
  licensed AIS prepared on this machine are available to the plugin without being in the
  image.
- **Freeboard** is installed into the server's configuration directory at a pinned version
  (`FREEBOARD_VERSION` in the `Dockerfile`), the way the App Store installs a webapp. KIP
  comes with the server itself.
- **Two plugins a boat would run** are installed the same way, each pinned in the
  `Dockerfile` and enabled by its file in `config/plugin-config-data/`:
  `signalk-vessels-to-ais`, which sends the targets out as NMEA 0183 (see [A Chart
  Plotter](#a-chart-plotter)), and `signalk-anchoralarm-plugin`, the anchor watch, set to
  take the anchor from the simulator's chain counter (`navigation.anchor.rodeCounterLength`,
  rode length activation, the counter as the alarm radius, a 1.2 m bow).
- **Configuration** (`config/`) is baked into the image: no data connections, no security.
  It starts fresh every time the container is created, so one run cannot leak into the next.
- `Dockerfile.dockerignore` sets the build context for this image only. The repository's
  `.dockerignore` belongs to the release image, which installs packed tarballs and so leaves
  out `packages/`; the rig builds from source and needs it.

## Watching a Route

Open Freeboard. The simulator plugin publishes the sample's route as a Resources API route,
with the waypoints, notes and dead slow regions along it, so Freeboard can show the planned
passage, and the own boat moves along it as the run goes. A
[rig soak](../soak/README.md#rig-soak) does the same with the plugin disabled.

- **Show the route:** Freeboard lists published routes but does not draw them until they are
  ticked. Click the orange layers button on the left ("Routes, Waypoints, Notes, etc."),
  then Routes, and tick the sample's route.
- **Follow the boat:**
  http://127.0.0.1:4770/@signalk/freeboard-sk/?zoom=10&movemap=1&northup=1 opens zoomed in
  and keeps the boat centred.
- **Clear the trail between samples:** right-click the map and choose "Clear vessel trail".
  Freeboard keeps the boat's trail in the browser, not on the server, so restarting the rig
  does not clear it, and switching samples leaves a line across the world from the old
  position to the new one.
- **Restart the rig between samples** (`down`, then `up`) as well, so the server starts with
  no data from the previous run.

## A Chart Plotter

The rig sends NMEA 0183 over TCP on **127.0.0.1:4772** (the server's port 10110 inside the
container): the own boat as `$..RMC`, `$..HDT` and `$..VTG` once a second (the server's own
`signalk-to-nmea0183` converter), and every AIS target in range as `!AIVDM` with the own
boat as `!AIVDO`, once a minute (`signalk-vessels-to-ais`, installed in the image). Point
a chart plotter or navigation program that takes NMEA 0183 over TCP at that address: in
OpenCPN, Options, Connections, Add Connection, Network, TCP, address 127.0.0.1, port 4772,
receive. The port is bound to loopback, like the rest of the rig; a plotter on another
machine needs it forwarded deliberately, and the rig has no security.

## A Walk Through It

What the rig showed on 5 November 2026, built from scratch (`docker compose build
--no-cache`, 3 minutes) and used through a headless browser and REST, Miami at x24 unless
said otherwise:

- **Freeboard under way:** the chart north-up on the boat, her icon with its course line,
  the blue route up the Intracoastal Waterway with its points, and the targets as AIS icons
  with their names and course vectors, dense at the marinas. Over five minutes the vessels
  tree went 332, 367, 450, 483, 519, 471, each one more than the plugin's targets in range,
  as targets came into range and were lost. Freeboard asks the server for a track and for
  symbol, plotter-extension and info layers it does not have (`/signalk/v2/api/tracks/_`
  400, `/signalk/v1/api/self/track` and three resource types 404) and draws no trail from
  them; that is Freeboard looking for plugins the rig does not carry.
- **The route and the resources:** the layers panel lists the route (ticked and drawn as the
  active course), the 8 waypoints, the 4 notes at the bridges and the 2 dead slow regions
  with their descriptions, the same names and counts the Resources API gives.
- **The autopilot from Freeboard:** the autopilot button opens the console headed "Autopilot
  simulator"; engaging it went to the server's Autopilot API (`POST
.../autopilots/_default/engage` 200), the console showed auto, route and the target 2.0°,
  the API's `_default` showed engaged in route mode at the same target, and disengaging
  put it back on standby.
- **KIP:** its dashboard unlocked, a numeric widget on `navigation.speedOverGround` showed
  7.5 kn as REST did, and a switch panel on `electrical.switches.deckLights.state` (with
  "use numeric path" ticked, since the simulator sends 0 and 1) threw the deck lights on
  and off: the value changed 0, 1, 0 with `$source` simulator, the PUT travelling over KIP's
  WebSocket, and the same PUT by HTTP answered 200 and read back the same.
- **The history provider:** `/signalk/v2/api/history/_providers` names `signalk-simulator`
  the default beside KIP's, and the History API gave the boat's speed over the last ten
  minutes at a minute's resolution.
- **The anchor watch:** on the Saronic sample from 230 minutes in, she anchored in Skala bay
  four minutes later with 40 m of chain out; the anchor alarm plugin, set to its rode counter
  automation, took the anchor from the simulator's `navigation.anchor.rodeCounterLength`
  and sent its own `navigation.anchor.position`, `maxRadius` 39.2 m (the chain less the
  depth and bow), `rodeLength` and `currentRadius` 33 m with `$source` anchoralarm, and
  `notifications.navigation.anchor` at `normal`, "Anchor Alarm - Normal"; Freeboard at zoom
  18 drew the green anchor circle with the boat lying inside it.
- **Every PUT and POST answered 200**; the only responses of 400 or more were Freeboard's
  probes above.
