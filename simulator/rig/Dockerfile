# The simulator test rig: Signal K Server built from this checkout, with Freeboard for
# watching a route on a chart. Build from the repository root:
#
#   docker compose -f simulator/rig/docker-compose.yml up --build
#
# The server is this fork's own code, not a published release, so the rig always tests
# what is in the working tree. Its configuration is baked in and starts fresh on every run.
# The simulator plugin (simulator/plugin) is built and installed, and enabled by default.

# Tag: node:24-bookworm · Refreshed: 2026-11-02
FROM node:24-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413

ARG FREEBOARD_VERSION=3.4.1
# Sends the AIS targets in vessels.* out as NMEA 0183 VDM sentences, and the own boat as VDO.
ARG VESSELS_TO_AIS_VERSION=2.1.1

USER node
WORKDIR /home/node/signalk

COPY --chown=node:node . .
RUN npm install --no-audit --no-fund \
  && npm run build:workspaces \
  && npm run build \
  && npx tsc -p simulator/plugin \
  && npx tsc -p simulator/plugin/webapp

# Webapps install into the server's configuration directory, the way the App Store does.
WORKDIR /home/node/rig
COPY --chown=node:node simulator/rig/config/ ./
RUN npm install --no-audit --no-fund "@signalk/freeboard-sk@${FREEBOARD_VERSION}" \
  "signalk-vessels-to-ais@${VESSELS_TO_AIS_VERSION}" \
  && npm install --no-audit --no-fund /home/node/signalk/simulator/plugin

EXPOSE 3000
CMD ["node", "/home/node/signalk/bin/signalk-server", "-c", "/home/node/rig"]
