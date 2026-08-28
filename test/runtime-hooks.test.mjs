import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listRuntimeHooks } from "../src/runtime-hooks.mjs";

test("lists supported runtime hooks in lexical order", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-orbit-hooks-"));
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "20-market.mjs"), "", "utf8"),
    writeFile(join(root, "10-env.sh"), "", "utf8"),
    writeFile(join(root, "30-helper.js"), "", "utf8"),
    writeFile(join(root, "README.md"), "", "utf8"),
  ]);

  const hooks = await listRuntimeHooks(root);
  assert.deepEqual(
    hooks.map((hook) => hook.name),
    ["10-env.sh", "20-market.mjs", "30-helper.js"],
  );
  assert.deepEqual(
    hooks.map((hook) => hook.runner),
    ["sh", "node", "node"],
  );
});

test("returns an empty list when the hook directory does not exist", async () => {
  const root = join(tmpdir(), `dsh-orbit-hooks-missing-${Date.now()}`);
  assert.deepEqual(await listRuntimeHooks(root), []);
});
