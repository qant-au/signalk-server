# Test Rig

A Signal K Server built from this checkout, in a container, with
[Freeboard](https://github.com/SignalK/freeboard-sk) for watching a route on a chart. Every
simulator test runs against it, so anyone can stand up the same environment from the
repository alone.

## Start and Stop

From the repository root, with Docker running:

```shell
docker compose -f simulator/rig/docker-compose.yml up -d --build   # build this checkout and start
docker compose -f simulator/rig/docker-compose.yml down            # stop and remove
```

| What            | Where                                        |
| --------------- | -------------------------------------------- |
| Freeboard       | http://127.0.0.1:4770/@signalk/freeboard-sk/ |
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
- **Freeboard** is installed into the server's configuration directory at a pinned version
  (`FREEBOARD_VERSION` in the `Dockerfile`), the way the App Store installs a webapp.
- **Configuration** (`config/`) is baked into the image: no data connections, no security.
  It starts fresh every time the container is created, so one run cannot leak into the next.
- `Dockerfile.dockerignore` sets the build context for this image only. The repository's
  `.dockerignore` belongs to the release image, which installs packed tarballs and so leaves
  out `packages/`; the rig builds from source and needs it.

## Watching a Route

Start a soak run (see [the soak README](../soak/README.md)) and open Freeboard. The run
publishes the sample's route as a Resources API route, so Freeboard can show the planned
passage, and the own boat moves along it as the run goes.

- **Show the route:** Freeboard lists published routes but does not draw them until they are
  ticked. Open the menu, then Routes, and tick the sample's route.
- **Follow the boat:** http://127.0.0.1:4770/@signalk/freeboard-sk/?zoom=10&movemap=1&northup=1
  opens zoomed in and keeps the boat centred.
- **Clear the trail between samples:** right-click the map and choose "Clear vessel trail".
  Freeboard keeps the boat's trail in the browser, not on the server, so restarting the rig
  does not clear it, and switching samples leaves a line across the world from the old
  position to the new one.
- **Restart the rig between samples** (`down`, then `up`) as well, so the server starts
  with no data from the previous run.
