import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const dockerfile = await readFile(new URL("../docker/Dockerfile", import.meta.url), "utf8");
const startScript = await readFile(new URL("../docker/start.sh", import.meta.url), "utf8");
const terminalRepair = await readFile(new URL("../bin/dsh-orbit-ensure-node-pty", import.meta.url), "utf8");

test("container user has an interactive shell for terminal plugins", () => {
  assert.match(
    dockerfile,
    /adduser[^\n]*-s \/bin\/bash[^\n]*dsh/,
    "the dsh account must not use Alpine's /sbin/nologin default",
  );
  assert.match(
    dockerfile,
    /ENV SHELL=\/bin\/bash/,
    "terminal plugins should resolve an interactive shell from SHELL",
  );
});

test("container can self-repair node-pty for sidebar terminals", () => {
  assert.match(dockerfile, /\bbuild-base\b/);
  assert.match(dockerfile, /\blinux-headers\b/);
  assert.match(dockerfile, /dsh-orbit-ensure-node-pty/);
  assert.match(startScript, /TERMINAL_RUNTIME_REPAIR/);
  assert.match(startScript, /\"\$TERMINAL_RUNTIME_REPAIR\"/);
  assert.match(terminalRepair, /require\('node-pty'\)/);
  assert.match(terminalRepair, /node-gyp\.js/);
  assert.match(terminalRepair, /rebuild --nodedir=\/usr\/local/);
});
