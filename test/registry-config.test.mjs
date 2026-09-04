// Round-2 P2 (production listener fails closed): the machine surface
// (enrollment tokens, signatures) must never ride a public plain-HTTP
// bind, so non-loopback listens are refused unconditionally in v0.3.

import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackListen, validateHubConfig, validateWebSocketConfig } from "../src/registry/config.mjs";
import { HubWebSocketTracker } from "../src/registry/route-proxy.mjs";
import { IngressWebSocketTracker } from "../src/node/route-ingress.mjs";

test("loopback listen addresses are accepted", () => {
  assert.equal(isLoopbackListen("127.0.0.1"), true);
  assert.equal(isLoopbackListen("::1"), true);
  assert.equal(isLoopbackListen("localhost"), true);
  assert.equal(isLoopbackListen("0.0.0.0"), false);
  assert.equal(isLoopbackListen("198.51.100.7"), false);
  assert.deepEqual(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "http" }), []);
});

test("any non-loopback bind refuses startup with no escape hatch", () => {
  const errors = validateHubConfig({ listen: "0.0.0.0", trustedExternalScheme: "http" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not loopback/);
  assert.match(errors[0], /refused/);
  // There is deliberately no override that re-allows a public bind.
  const again = validateHubConfig({ listen: "198.51.100.7", trustedExternalScheme: "https" });
  assert.equal(again.length, 1);
});

test("the trusted external scheme must be http or https", () => {
  assert.match(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "ftp" })[0], /TRUSTED_SCHEME/);
  assert.deepEqual(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https" }), []);
});

test("a missing listener value fails closed", () => {
  const errors = validateHubConfig({ listen: "", trustedExternalScheme: "http" });
  assert.equal(errors.length, 1);
});

test("validateWebSocketConfig accepts bounded valid settings", () => {
  assert.deepEqual(
    validateWebSocketConfig({
      maxWsGlobal: 500,
      maxWsPerNode: 100,
      wsHandshakeTimeoutMs: 15000,
    }),
    [],
  );
  assert.deepEqual(validateWebSocketConfig({}), []);
});

test("validateWebSocketConfig rejects 0, negative, NaN, Infinity, non-integer, and out-of-range values", () => {
  // 0 / negative
  assert.match(validateWebSocketConfig({ maxWsGlobal: 0 })[0], /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(validateWebSocketConfig({ maxWsPerNode: -1 })[0], /DSH_ORBIT_HUB_WS_PER_NODE_LIMIT/);
  assert.match(validateWebSocketConfig({ wsHandshakeTimeoutMs: 0 })[0], /DSH_ORBIT_HUB_WS_HANDSHAKE_TIMEOUT_MS/);

  // NaN / Infinity / non-integer
  assert.match(validateWebSocketConfig({ maxWsGlobal: Number.NaN })[0], /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(validateWebSocketConfig({ maxWsGlobal: Infinity })[0], /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(validateWebSocketConfig({ maxWsGlobal: 10.5 })[0], /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(validateWebSocketConfig({ wsHandshakeTimeoutMs: Number.NaN })[0], /DSH_ORBIT_HUB_WS_HANDSHAKE_TIMEOUT_MS/);

  // Exceeds upper limit or below lower limit
  assert.match(validateWebSocketConfig({ maxWsGlobal: 100001 })[0], /DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
  assert.match(validateWebSocketConfig({ maxWsPerNode: 10001 })[0], /DSH_ORBIT_HUB_WS_PER_NODE_LIMIT/);
  assert.match(validateWebSocketConfig({ wsHandshakeTimeoutMs: 50 })[0], /DSH_ORBIT_HUB_WS_HANDSHAKE_TIMEOUT_MS/);
  assert.match(validateWebSocketConfig({ wsHandshakeTimeoutMs: 120001 })[0], /DSH_ORBIT_HUB_WS_HANDSHAKE_TIMEOUT_MS/);

  // maxWsPerNode > maxWsGlobal
  const perNodeExceeds = validateWebSocketConfig({ maxWsGlobal: 50, maxWsPerNode: 100 });
  assert.equal(perNodeExceeds.length, 1);
  assert.match(perNodeExceeds[0], /cannot exceed DSH_ORBIT_HUB_WS_GLOBAL_LIMIT/);
});

test("HubWebSocketTracker and IngressWebSocketTracker throw RangeError on invalid bounds", () => {
  assert.throws(() => new HubWebSocketTracker({ maxGlobal: 0 }), RangeError);
  assert.throws(() => new HubWebSocketTracker({ maxGlobal: -5 }), RangeError);
  assert.throws(() => new HubWebSocketTracker({ maxGlobal: 100001 }), RangeError);
  assert.throws(() => new HubWebSocketTracker({ maxPerNode: 0 }), RangeError);
  assert.throws(() => new HubWebSocketTracker({ maxPerNode: 10001 }), RangeError);
  assert.throws(() => new HubWebSocketTracker({ maxGlobal: 10, maxPerNode: 20 }), RangeError);

  assert.throws(() => new IngressWebSocketTracker({ maxConnections: 0 }), RangeError);
  assert.throws(() => new IngressWebSocketTracker({ maxConnections: -1 }), RangeError);
  assert.throws(() => new IngressWebSocketTracker({ maxConnections: 10001 }), RangeError);
  assert.throws(() => new IngressWebSocketTracker({ maxConnections: Number.NaN }), RangeError);
});