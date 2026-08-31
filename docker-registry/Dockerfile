# v0.3 Registry Hub image (SOP Stage 6). Pinned base, zero runtime
# dependencies: the image carries the Orbit Hub code (bin/src/ui) and
# nothing else.

FROM node:22.14.0-bookworm-slim

# The hub has no npm dependencies; a lockfile-free copy is the build.
WORKDIR /opt/dsh-orbit
COPY bin/ bin/
COPY src/ src/
COPY ui/ ui/
COPY package.json .

ENV DSH_ORBIT_HUB_DB=/data/orbit/registry.db
ENV DSH_ORBIT_HUB_PORT=5445
ENV DSH_ORBIT_HUB_LISTEN=127.0.0.1

EXPOSE 5445

ENTRYPOINT ["node", "/opt/dsh-orbit/bin/dsh-orbit-hub.mjs"]