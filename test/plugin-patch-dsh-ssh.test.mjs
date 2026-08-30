import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  patchDshSshPlugin,
  verifyDshSshPlugin,
} from "../src/plugin-patch-dsh-ssh.mjs";
import {
  createPatchedFenceModule,
  withTempDir,
  FENCE_PUBLIC_HOST,
  sshPluginFixtureSource,
} from "./helpers/ssh-fence-fixture.mjs";

async function writePluginFixture({ dir, source, version = "0.3.2", secretValue = undefined }) {
  const pluginRoot = join(dir, "plugins", "@linxin666", "dsh-ssh");
  await mkdir(join(pluginRoot, "lib"), { recursive: true });
  await writeFile(
    join(pluginRoot, "package.json"),
    JSON.stringify({ name: "@linxin666/dsh-ssh", version }, null, 2),
    "utf8",
  );
  await writeFile(join(pluginRoot, "lib", "index.js"), source, "utf8");
  let secretFile = null;
  if (secretValue !== undefined) {
    secretFile = join(dir, "secret.txt");
    await writeFile(secretFile, secretValue, "utf8");
  }
  return { pluginRoot, secretFile };
}

function requireSource(gateCount) {
  const gate = "\tif (!isLoopbackRequest(req)) {";
  const lines = [
    'import { randomUUID } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    "",
    "function isLoopbackRequest(request) {",
    "\tconst host = request.headers.host;",
    "\tif (typeof host !== \"string\") return false;",
    "\treturn true;",
    "}",
    "",
    "const guard = (req, res) => {",
    gate,
    '\t\twriteJson(res, 403, { error: "forbidden: loopback-only" });',
    "\t\treturn false;",
    "},",
    "",
    "async function extra() {",
    gate,
    '\t\twriteJson(res, 403, { error: "forbidden: loopback-only" });',
    "\t\treturn;",
    "}",
    "",
  ];
  for (let i = 2; i < gateCount; i += 1) {
    lines.push("async function extra" + i + "() {", gate, "}");
  }
  return lines.join("\n");
}

test("applies the authenticated-proxy admission to all three gates and keeps loopback first", async () => {
  await withTempDir(async (dir) => {
    const { moduleUrl, secret } = await createPatchedFenceModule(dir);
    const patched = await readFile(
      join(dir, "plugins", "@linxin666", "dsh-ssh", "lib", "index.js"),
      "utf8",
    );

    assert.equal(
      patched.split("function isDshOrbitAuthenticatedProxyRequest(request) {").length - 1,
      1,
      "helper must be injected exactly once",
    );
    const admitted = patched.match(/&& !isDshOrbitAuthenticatedProxyRequest\(req\)\) \{/g) ?? [];
    assert.equal(admitted.length, 3, "all three gates must be admitted");
    assert.ok(
      patched.includes("!isLoopbackRequest(req) && !isDshOrbitAuthenticatedProxyRequest(req)"),
      "loopback remains the first condition",
    );
    assert.ok(
      patched.includes(`const DSH_ORBIT_SSH_PUBLIC_HOST = ${JSON.stringify(FENCE_PUBLIC_HOST)};`),
    );

    await verifyDshSshPlugin({
      root: join(dir, "plugins", "@linxin666", "dsh-ssh"),
      publicHost: FENCE_PUBLIC_HOST,
    });

    const fence = await import(moduleUrl);
    const trusted = {
      host: FENCE_PUBLIC_HOST,
      "x-forwarded-proto": "https",
      "x-dsh-orbit-authenticated-proxy": secret,
      "sec-fetch-site": "same-origin",
      origin: `https://${FENCE_PUBLIC_HOST}`,
    };
    assert.equal(fence.isDshOrbitAuthenticatedProxyRequest({ headers: trusted }), true);
    assert.equal(
      fence.isDshOrbitAuthenticatedProxyRequest({ headers: { ...trusted, origin: undefined } }),
      true,
      "a request without an Origin header stays allowed like the settings gate",
    );
    assert.equal(
      fence.isDshOrbitAuthenticatedProxyRequest({ headers: { ...trusted, host: "other.example.com" } }),
      false,
    );
    assert.equal(
      fence.isDshOrbitAuthenticatedProxyRequest({ headers: { ...trusted, "x-forwarded-proto": "http" } }),
      false,
    );
    assert.equal(
      fence.isDshOrbitAuthenticatedProxyRequest({
        headers: { ...trusted, "x-dsh-orbit-authenticated-proxy": "orbit-wrong-" + "value" },
      }),
      false,
    );
    assert.equal(
      fence.isDshOrbitAuthenticatedProxyRequest({ headers: { ...trusted, "sec-fetch-site": "cross-site" } }),
      false,
    );
    assert.equal(
      fence.isDshOrbitAuthenticatedProxyRequest({ headers: { ...trusted, origin: "https://evil.example.com" } }),
      false,
    );
    assert.equal(fence.isDshOrbitAuthenticatedProxyRequest({ headers: {} }), false);
  });
});

test("rejects an unpatched plugin at verification time", async () => {
  await withTempDir(async (dir) => {
    const { pluginRoot } = await writePluginFixture({ dir, source: requireSource(3) });
    await assert.rejects(
      verifyDshSshPlugin({ root: pluginRoot, publicHost: FENCE_PUBLIC_HOST }),
      /authenticated proxy helper missing/,
    );
  });
});

test("rejects unsupported plugin versions", async () => {
  await withTempDir(async (dir) => {
    const { pluginRoot, secretFile } = await writePluginFixture({
      dir,
      source: requireSource(3),
      version: "0.9.9-future",
      secretValue: "orbit-proxy-" + "value",
    });
    await assert.rejects(
      patchDshSshPlugin({ root: pluginRoot, publicHost: FENCE_PUBLIC_HOST, proxyAuthFile: secretFile }),
      /is not the pinned "0\.3\.2"/,
    );
  });
});

test("fails closed when an expected fragment is missing or duplicated", async () => {
  await withTempDir(async (dir) => {
    const { pluginRoot, secretFile } = await writePluginFixture({
      dir,
      source: requireSource(3).replace(
        "function isLoopbackRequest(request) {",
        "function isRequestAllowed(request) {",
      ),
      secretValue: "orbit-proxy-" + "value",
    });
    await assert.rejects(
      patchDshSshPlugin({ root: pluginRoot, publicHost: FENCE_PUBLIC_HOST, proxyAuthFile: secretFile }),
      /expected function isLoopbackRequest\(request\) \{ exactly 1 time\(s\), found 0/,
    );

    const { pluginRoot: dupRoot } = await writePluginFixture({
      dir,
      source: requireSource(3).replace(
        "function isLoopbackRequest(request) {",
        "function isLoopbackRequest(request) {\nfunction isLoopbackRequest(request) {",
      ),
      secretValue: "orbit-proxy-" + "value",
    });
    await assert.rejects(
      patchDshSshPlugin({ root: dupRoot, publicHost: FENCE_PUBLIC_HOST, proxyAuthFile: secretFile }),
      /expected function isLoopbackRequest\(request\) \{ exactly 1 time\(s\), found 2/,
    );

    const { pluginRoot: twoRoot } = await writePluginFixture({
      dir,
      source: requireSource(2),
      secretValue: "orbit-proxy-" + "value",
    });
    await assert.rejects(
      patchDshSshPlugin({ root: twoRoot, publicHost: FENCE_PUBLIC_HOST, proxyAuthFile: secretFile }),
      /expected if \(!isLoopbackRequest\(req\)\) \{ exactly 3 time\(s\), found 2/,
    );
  });
});

test("the fixture source itself carries exactly three gates", () => {
  const matches = sshPluginFixtureSource().match(/if \(!isLoopbackRequest\(req\)\) \{/g) ?? [];
  assert.equal(matches.length, 3);
});