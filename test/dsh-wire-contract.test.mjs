// The wire vocabulary must follow the reviewed connection generation, never a
// version comparison, and it must stay complete: a generation that needs an
// acceptance check but has no contract would silently skip that check.

import assert from "node:assert/strict";
import test from "node:test";

import { compatibilityProfiles } from "../src/compatibility.mjs";
import {
  RPC_PAYLOAD_STYLES,
  STREAM_SEMANTICS,
  WIRE_CONTRACTS,
  rpcEndpoint,
  rpcPayload,
  streamPaths,
  wireContractFor,
  wireContractForGeneration,
} from "../src/dsh-wire-contract.mjs";

test("every installable generation declares a wire contract", () => {
  // connection-v2 records a bundle layout with no install shape, so it has no
  // wire contract; every generation a version can actually select must have one.
  for (const [version, profile] of Object.entries(compatibilityProfiles)) {
    assert.ok(
      WIRE_CONTRACTS[profile.connectionPatch],
      `${version} selects ${profile.connectionPatch}, which has no reviewed wire contract`,
    );
  }
  assert.deepEqual(Object.keys(WIRE_CONTRACTS).sort(), [
    "connection-browser-auth-v1",
    "connection-v1",
  ]);
});

test("the legacy generation keeps its dotted vocabulary and downlink streams", () => {
  const contract = wireContractFor("0.1.1-rc.2");
  assert.equal(contract.rpc.separator, ".");
  assert.equal(contract.rpc.payload, RPC_PAYLOAD_STYLES.bare);
  assert.equal(contract.stream.semantics, STREAM_SEMANTICS.legacyDownlink);
  assert.deepEqual(contract.stream.paths, ["/api/events.mux", "/api/events.host"]);

  assert.equal(rpcEndpoint(contract, "settings", "describe"), "settings.describe");
  assert.deepEqual(rpcPayload(contract, { sessionId: "s" }), { sessionId: "s" });
});

test("the BrowserAuth generation uses slash endpoints and an args-wrapped payload", () => {
  const contract = wireContractFor("0.1.5-rc.2");
  assert.equal(contract.rpc.separator, "/");
  assert.equal(contract.rpc.payload, RPC_PAYLOAD_STYLES.args);
  assert.equal(contract.stream.semantics, STREAM_SEMANTICS.remoteMux);
  assert.deepEqual(contract.stream.paths, ["/api/remote.mux"]);

  assert.equal(rpcEndpoint(contract, "settings", "describe"), "settings/describe");
  assert.equal(rpcEndpoint(contract, "session", "selectModel"), "session/selectModel");
  // Measured against the real process: the payload must carry exactly one
  // plain-object args field, so a bare body is rejected by the gateway.
  assert.deepEqual(rpcPayload(contract, { ns: "x" }), { args: { ns: "x" } });
  assert.deepEqual(rpcPayload(contract, {}), { args: {} });
});

test("a stream path override must belong to the generation", () => {
  const legacy = wireContractForGeneration("connection-v1");
  const modern = wireContractForGeneration("connection-browser-auth-v1");

  assert.deepEqual(streamPaths(modern), ["/api/remote.mux"]);
  assert.deepEqual(streamPaths(modern, "/api/remote.mux"), ["/api/remote.mux"]);
  assert.deepEqual(streamPaths(legacy, "/api/events.host"), ["/api/events.host"]);

  // A path from the other generation must be refused rather than probed, so a
  // misconfigured run cannot report a verdict for a transport it never used.
  assert.throws(() => streamPaths(modern, "/api/events.mux"), /is not a remote-mux stream path/);
  assert.throws(() => streamPaths(legacy, "/api/remote.mux"), /is not a legacy-downlink stream path/);
});

test("an unreviewed generation fails closed", () => {
  assert.throws(() => wireContractForGeneration("connection-v9"), /no reviewed wire contract/);
  assert.throws(() => wireContractForGeneration("connection-v2"), /no reviewed wire contract/);
  assert.throws(() => wireContractFor("9.9.9"), /Unsupported DeepSeek Harness version/);
});
