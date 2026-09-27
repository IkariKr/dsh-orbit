// RFC-0016 Stage 1: DSH Native Cordis Plugin Packaging & Settings Persistence Tests
// Verifies:
// 1. Cordis plugin packaging manifest (package.json, cordis.patch.yml, exports) (M36 Field 33)
// 2. Plugin module lifecycle apply(ctx) and service injection (M36 Field 33)
// 3. Local node status endpoint registration on ctx.webServer (M36 Field 33)
// 4. DSH Settings service integration (read, watch, mutate ~/.dsh/settings.yaml namespace) (M36 Field 34)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  name,
  inject,
  apply,
  OrbitSettingsStore,
  bindDshSettings,
  ORBIT_SETTINGS_NAMESPACE,
} from "../src/plugin/index.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

test("plugin packaging: package.json declares Cordis manifest, exports, and keywords (field 33)", async () => {
  const pkgText = await read("package.json");
  const pkg = JSON.parse(pkgText);

  assert.equal(pkg.name, "dsh-orbit");
  assert.ok(pkg.keywords.includes("dsh"));
  assert.ok(pkg.keywords.includes("dsh-plugin"));
  assert.ok(pkg.keywords.includes("cordis-plugin"));
  assert.equal(pkg.exports["."], "./src/plugin/index.mjs");
  assert.equal(pkg.exports["./cordis.patch.yml"], "./cordis.patch.yml");

  assert.ok(pkg.dsh?.bundle?.patch);
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(pkg.dsh?.client?.inject);
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));

  const patchText = await read("cordis.patch.yml");
  assert.match(patchText, /id:\s*orbit/);
  assert.match(patchText, /name:\s*['"]?dsh-orbit['"]?/);
});

test("plugin lifecycle: apply(ctx) registers plugin and mounts local probe on webServer (field 33)", async () => {
  assert.equal(name, "dsh-orbit");
  assert.deepEqual(inject, ["webServer", "settings"]);

  const registeredRoutes = [];
  const mockWebServer = {
    register: (route) => registeredRoutes.push(route),
  };

  const mockCtx = {
    webServer: mockWebServer,
    get: (svc) => (svc === "webServer" ? mockWebServer : null),
  };

  apply(mockCtx, { allowTailscaleDirect: true });

  assert.ok(mockCtx["dsh-orbit"]);
  assert.equal(mockCtx["dsh-orbit"].store.getOptions().allowTailscaleDirect, true);
  assert.equal(registeredRoutes.length, 1);
  assert.equal(registeredRoutes[0].method, "GET");
  assert.equal(registeredRoutes[0].path, "/api/orbit/node-status");

  // Exercise the route handler
  let responseStatus = 0;
  let responseHeaders = {};
  let responseBody = "";

  const mockRes = {
    writeHead: (status, headers) => {
      responseStatus = status;
      responseHeaders = headers;
    },
    end: (chunk) => {
      responseBody = chunk;
    },
  };

  await registeredRoutes[0].handler({}, mockRes);
  assert.equal(responseStatus, 200);
  assert.equal(responseHeaders["Content-Type"], "application/json; charset=utf-8");
  const data = JSON.parse(responseBody);
  assert.equal(data.status, "ok");
  assert.equal(data.plugin, "dsh-orbit");
  assert.equal(data.namespace, ORBIT_SETTINGS_NAMESPACE);
  assert.equal(data.options.allowTailscaleDirect, true);
});

test("settings persistence: binds to DSH settings service, watches changes, and mutates namespace (field 34)", () => {
  const store = new OrbitSettingsStore({ qrCodeTtlSeconds: 300 });

  let registeredNamespace = null;
  let registeredOptions = null;
  let watchCallback = null;
  const mutations = [];

  const mockScope = {
    get: () => ({ qrCodeTtlSeconds: 240, allowLanDirect: true }),
    watch: (fn) => { watchCallback = fn; },
  };

  const mockSettingsService = {
    register: (ns, schema, opts) => {
      registeredNamespace = ns;
      registeredOptions = opts;
      return mockScope;
    },
    mutate: (ns, ops) => {
      mutations.push({ ns, ops });
    },
  };

  const mockCtx = {
    get: (svc) => (svc === "settings" ? mockSettingsService : null),
  };

  const scope = bindDshSettings(mockCtx, store);
  assert.ok(scope);
  assert.equal(registeredNamespace, "dsh-orbit");
  assert.equal(registeredOptions.base.qrCodeTtlSeconds, 300);

  // 1. Initial synchronization from mockScope.get()
  assert.equal(store.getOptions().qrCodeTtlSeconds, 240);
  assert.equal(store.getOptions().allowLanDirect, true);

  // 2. External watch notification
  mockScope.get = () => ({ qrCodeTtlSeconds: 180, allowLanDirect: false });
  watchCallback();
  assert.equal(store.getOptions().qrCodeTtlSeconds, 180);
  assert.equal(store.getOptions().allowLanDirect, false);

  // 3. Local update writes back to settingsService.mutate
  store.updateOptions({ allowTailscaleDirect: true });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].ns, "dsh-orbit");
  assert.deepEqual(mutations[0].ops, [
    { op: "set", path: ["allowTailscaleDirect"], value: true },
  ]);
});

test("settings store: handles standalone mode when DSH settings service is unavailable", () => {
  const store = new OrbitSettingsStore();
  const emptyCtx = { get: () => null };

  const scope = bindDshSettings(emptyCtx, store);
  assert.equal(scope, null);

  // Store functions reliably in standalone fallback
  let notified = false;
  store.subscribe((opts) => {
    if (opts.maxFailedAttempts === 10) notified = true;
  });

  store.updateOptions({ maxFailedAttempts: 10 });
  assert.equal(store.getOptions().maxFailedAttempts, 10);
  assert.equal(notified, true);
});
