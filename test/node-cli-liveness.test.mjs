// Review Gate A P1-04: the daemon must stay alive on its own. The main
// heartbeat loop timer is ref'd; only the shutdown watchdog may unref.
// The store is pre-enrolled so the daemon genuinely enters the retrying
// state against an unreachable hub.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { writeNodeStore } from "../src/node/store.mjs";
import { generateNodeKeyPair } from "../src/registry/crypto.mjs";

test("dsh-orbit-node run stays alive and keeps retrying with an unreachable hub", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-node-liveness-"));
  const statePath = join(dir, "state.json");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const keys = generateNodeKeyPair();
  await writeNodeStore(statePath, {
    schema: 1,
    nodeId: "node_" + "ab".repeat(16),
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    hubBaseUrl: "http://127.0.0.1:9/", // nothing listens here
    state: "active",
    rotation: null,
    pendingEnrollment: null,
    pendingReenrollment: null,
    updatedAt: new Date().toISOString(),
  });

  const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: {
      ...process.env,
      DSH_ORBIT_HUB_URL: "http://127.0.0.1:9/",
      DSH_ORBIT_NODE_STATE: statePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  await new Promise((resolve) => setTimeout(resolve, 2600));
  // The daemon must NOT have exited: the heartbeat loop keeps the
  // process alive while it is retrying indefinitely.
  assert.equal(child.exitCode, null, `daemon exited early; stderr: ${stderr}`);
  assert.match(stderr, /retrying/);

  // Clean shutdown still works.
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
});