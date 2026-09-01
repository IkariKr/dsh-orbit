# Downstream production deployment

A production deployment should keep DSH Orbit source code separate from site-specific state.

Recommended layout:

```text
/opt/dsh-orbit/                 # Git checkout of this repository
/srv/dsh-production/            # downstream deployment state
  docker-compose.yml
  data/
  workspace/
  caddy/
  hooks/
  secrets/
```

The downstream Compose file can build the DSH service directly from the checked-out DSH Orbit repository while keeping volumes, proxy configuration, certificates, and secrets in the deployment directory:

```yaml
services:
  dsh:
    build:
      context: ../dsh-orbit
      dockerfile: docker/Dockerfile
      args:
        DSH_VERSION: ${DSH_VERSION}
        DSH_PUBLIC_HOST: ${DSH_PUBLIC_HOST}
    image: dsh-orbit:${DSH_VERSION}-production
    environment:
      DSH_HOME: /data/dsh-home
      HOME: /data/dsh-home
      DSH_PUBLIC_HOST: ${DSH_PUBLIC_HOST}
      DSH_PROXY_AUTH_FILE: /run/secrets/dsh_proxy_auth
      DSH_PROFILE_ROOT: /data/dsh-home/profiles/web
      DSH_ORBIT_HOOK_DIR: /opt/dsh-orbit/hooks
    volumes:
      - ./data:/data:rw
      - ./workspace:/workspace:rw
      - ./secrets/dsh_proxy_auth:/run/secrets/dsh_proxy_auth:ro
      - ./hooks:/opt/dsh-orbit/hooks:ro
```

Before the first start, prepare bind-mounted directories on the host. The long-lived DSH process runs as UID/GID `10001:10001`, while the Caddy process runs as `1000:1000`; the container entrypoints do not run as root to repair host ownership. Create the directories and grant only the required service ownership, for example:

```sh
install -d -m 0750 -o 10001 -g 10001 ./data ./workspace
install -d -m 0750 -o 1000 -g 1000 ./caddy-data ./caddy-config
```

If an existing deployment already contains files, review and correct ownership before recreating the containers. Do not add a root long-lived service as a workaround; any one-shot initialization must be separately scoped, bounded, and completed before the non-root service starts.

This arrangement has three properties:

1. the public Git repository remains free of deployment credentials and machine-specific configuration;
2. production can be updated by checking out a known DSH Orbit commit or tag and rebuilding;
3. local compatibility work can be tested in the source checkout before it is promoted to production.

## Pin the source revision

Production should record the exact DSH Orbit commit used for each deployment. Prefer a release tag once one exists. During active development, a commit SHA is an acceptable pin.

Do not make production depend on an unrecorded moving `main` checkout.

## Downstream hooks

Deployment-specific compatibility code belongs in the downstream hook directory. DSH Orbit executes supported hooks in lexical order before each DSH Web start.

Typical uses include temporary plugin compatibility fixes that are not appropriate for the upstream DSH Orbit repository.

A hook failure stops startup. This behavior is intentional: a compatibility hook that no longer matches should be reviewed before the new runtime is exposed.

## Upgrade procedure

For each upgrade:

1. update the DSH Orbit checkout to a reviewed commit or tag;
2. record the previous source commit and image tag;
3. snapshot the DSH data directory;
4. build the new image without replacing the running container;
5. run unit and compatibility checks;
6. recreate the DSH and gateway containers;
7. run authenticated read/write smoke tests and negative-auth tests;
8. keep the previous image and data snapshot until the deployment is accepted.

Steps 2 through 5 can be run as one fail-closed command with the candidate upgrade runner (`npm run upgrade -- candidate`), which snapshots production, builds without replacing the last known-good image, starts the candidate against copied data on an isolated endpoint, runs the smoke suites, and produces a compatibility report. See the README for the required environment.

See [Upgrade guide](upgrade.md) for the compatibility checks that should gate a DSH version change, and [Snapshot and rollback](snapshot-rollback.md) for the snapshot contract used before promotion.
