import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const dockerfile = await readFile(new URL("../docker/Dockerfile", import.meta.url), "utf8");

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
