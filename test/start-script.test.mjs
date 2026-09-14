import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const startScript = await readFile(new URL("../docker/start.sh", import.meta.url), "utf8");

test("starts DSH with the public host admitted through the upstream trusted-host fence", () => {
  assert.match(
    startScript,
    /web --no-open --trusted-host "\$DSH_PUBLIC_HOST"/,
    "DSH_PUBLIC_HOST must be passed to dsh web --trusted-host so authenticated reverse-proxy requests can reach plugin routes such as lazy-loaded UI bundles",
  );
});

test("defaults the profile connection bundle to DSH's shared profile workspace", () => {
  assert.match(
    startScript,
    /PROFILE_CONNECTION_ROOT="\$\{DSH_PROFILE_CONNECTION_ROOT:-\$\{DSH_HOME:-\/data\/dsh-home\}\/profiles\/node_modules\/@deepseek-ai\/dsh-client-connection\/lib\}"/,
    "DSH installs profile packages under $DSH_HOME/profiles/node_modules; deriving the bundle from profiles/web leaves copied historical profiles stuck in bootstrap",
  );
});

test("fresh-profile bootstrap waits for DSH to finish booting before it is stopped for patching", () => {
  assert.match(
    startScript,
    /if \[ ! -f "\$PROFILE_CONNECTION_ROOT\/index\.js" \].*?start_dsh.*?wait_for_profile.*?wait_for_web.*?stop_dsh.*?fi/s,
    "profile package files can appear before DSH releases profiles/node_modules.lock; bootstrap must wait for the web service before terminating the first process",
  );
});

test("waits for the web service through the shared probe, not an unauthenticated 2xx", () => {
  assert.match(
    startScript,
    /WEB_READY="\/usr\/local\/bin\/dsh-orbit-web-ready"/,
    "the container must probe readiness with the same helper its healthcheck uses",
  );
  assert.match(startScript, /if "\$WEB_READY"; then/);
  // Native BrowserAuth answers every unauthenticated request with 401 while the
  // web server is healthy, so a tokenless 2xx probe never observes readiness and
  // would fail the container start on a healthy server.
  assert.doesNotMatch(
    startScript,
    /wget -q -O \/dev\/null http:\/\/127\.0\.0\.1:3080/,
    "the readiness wait must not require an unauthenticated 2xx from the DSH web index",
  );
});
