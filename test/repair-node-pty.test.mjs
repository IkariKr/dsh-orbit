import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../scripts/repair-node-pty.sh", import.meta.url), "utf8");

test("manual node-pty repair reuses the Orbit image repair command", () => {
  assert.match(script, /dsh-orbit-ensure-node-pty/);
  assert.match(script, /DSH_ORBIT_IMAGE/);
  assert.match(script, /DSH_DATA_DIR/);
  assert.doesNotMatch(script, /apk add/);
  assert.doesNotMatch(script, /pnpm install/);
});

test("manual node-pty repair is profile and uid scoped", () => {
  assert.match(script, /DSH_PROFILE_ROOT/);
  assert.match(script, /DSH_UID/);
  assert.match(script, /DSH_GID/);
  assert.match(script, /--user/);
});
