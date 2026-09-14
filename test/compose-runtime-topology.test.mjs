// Runtime semantics of the product compose topology, proven against a real
// Docker daemon. `docker compose config` resolves YAML but cannot catch the
// container-runtime conflict this suite exists to guard: a service that joins
// another container's network namespace (network_mode: service:*) is refused
// by the daemon if it declares its own port publishing. The product compose
// therefore keeps every host publication on the namespace owner (dsh) and the
// shared sidecars (gateway, compatibility adapter) publish nothing.
//
// Skipped cleanly when no Docker daemon is reachable, so the standard suite
// stays self-contained.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

const COMPOSE_BASE = `
services:
  owner:
    image: busybox:stable
    command: ["sleep", "60"]
    ports:
      - "127.0.0.1:PORT_PLACEHOLDER:9999"
  sidecar:
    image: busybox:stable
    command: ["sleep", "60"]
    network_mode: "service:owner"
`;

const COMPOSE_BROKEN = `
services:
  owner:
    image: busybox:stable
    command: ["sleep", "60"]
  sidecar:
    image: busybox:stable
    command: ["sleep", "60"]
    network_mode: "service:owner"
    ports:
      - "127.0.0.1:PORT_PLACEHOLDER:9999"
`;

function compose(dir, file, args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync("docker", ["compose", "-f", join(dir, file), ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    if (expectFailure) throw new Error(`expected docker compose to refuse the topology; stdout: ${stdout}`);
    return stdout;
  } catch (error) {
    if (expectFailure) return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw error;
  }
}

async function withComposeProject(body) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-compose-topology-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  await writeFile(join(dir, "good.yaml"), COMPOSE_BASE.replaceAll("PORT_PLACEHOLDER", String(port)));
  await writeFile(join(dir, "broken.yaml"), COMPOSE_BROKEN.replaceAll("PORT_PLACEHOLDER", String(port)));
  try {
    await body(dir, port);
  } finally {
    try {
      execFileSync("docker", ["compose", "-f", join(dir, "good.yaml"), "down", "--timeout", "1"], { stdio: "ignore", timeout: 60000 });
    } catch {
      // The project may never have started; cleanup is best-effort.
    }
    // Docker on Windows can still hold a handle on the project directory for a
    // moment after `compose down`, which surfaces as EBUSY on rmdir. Retry so a
    // teardown race cannot fail an otherwise passing topology check; any other
    // error, or a directory that stays locked, is still reported.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt >= 9 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

test("the shared-namespace sidecar pattern starts against a real daemon", async (t) => {
  if (!dockerAvailable()) {
    t.skip("no reachable Docker daemon; skipping compose runtime topology check");
    return;
  }
  await withComposeProject(async (dir) => {
    compose(dir, "good.yaml", ["up", "-d"]);
    const ps = compose(dir, "good.yaml", ["ps", "--services", "--status", "running"]);
    assert.match(ps, /owner/, "the namespace owner must be running");
    assert.match(ps, /sidecar/, "the sidecar sharing the namespace must be running");
  });
});

test("a namespace-sharing sidecar that publishes ports is refused by the daemon", async (t) => {
  if (!dockerAvailable()) {
    t.skip("no reachable Docker daemon; skipping compose runtime topology check");
    return;
  }
  await withComposeProject(async (dir) => {
    const output = compose(dir, "broken.yaml", ["up", "-d"], { expectFailure: true });
    assert.match(
      String(output),
      /conflicting options: port publishing and the container type network mode/i,
      "the daemon must refuse the exact conflict the product compose must never contain",
    );
  });
});
