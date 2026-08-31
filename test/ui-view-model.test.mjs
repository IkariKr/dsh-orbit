// SOP Stage 5 required tests: the view-model renders EVERY health
// dimension explicitly (no Healthy/Unhealthy flattening), destructive
// flows carry the fixed confirmation contract, and token plaintext is
// exactly-once.

import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_NODES_STATE,
  EMPTY_TOKENS_STATE,
  createDeleteRequestId,
  healthBadges,
  mapApiError,
  mapDeleteResult,
  mapNodeDetail,
  mapNodeList,
  mapNodeRow,
  mapTokenList,
  mapTokenMint,
} from "../ui/view-model.mjs";

function sampleNode(overrides = {}) {
  return {
    nodeId: "node_" + "ab".repeat(16),
    state: "active",
    health: {
      registryContact: "fresh",
      dshHealthy: "ok",
      orbitCompatible: "pass",
      reachable: "unknown",
      authenticated: "ok",
      capabilitiesStale: false,
      capabilities: [
        { name: "sessions.resume", version: 1 },
        { name: "settings.remote", version: 1 },
      ],
      capabilityEvidence: [
        { name: "sessions.resume", version: 1 },
        { name: "settings.remote", version: 1 },
      ],
      alertFlags: [],
      lastSeen: "2026-08-31T00:00:00.000Z",
      lastSeenSource: "heartbeat",
    },
    runtimeIdentity: {
      orbitVersion: "0.3.0",
      orbitRevision: "abc123",
      dshVersion: "0.1.1-rc.2",
      compatibilityProfile: "dsh-0.1.1-rc.2",
    },
    ...overrides,
  };
}

test("every health dimension appears independently in the badge set", () => {
  const badges = healthBadges(sampleNode());
  const dimensions = badges.map((badge) => badge.dimension).sort();
  assert.deepEqual(dimensions, ["authenticated", "dshHealthy", "orbitCompatible", "reachable", "registryContact", "state"]);
  assert.deepEqual(
    badges.map((badge) => badge.value),
    ["fresh", "ok", "pass", "unknown", "ok", "active"],
  );
});

test("withheld capabilities are shown as an empty ACTIVE set with evidence separate", () => {
  const row = mapNodeRow(
    sampleNode({
      health: {
        registryContact: "fresh",
        dshHealthy: "unknown",
        orbitCompatible: "stale",
        reachable: "unknown",
        authenticated: "ok",
        capabilitiesStale: true,
        capabilities: [],
        capabilityEvidence: [
          { name: "sessions.resume", version: 1 },
          { name: "settings.remote", version: 1 },
          { name: "web.routes", version: 1 },
        ],
        alertFlags: [],
        lastSeen: "t",
        lastSeenSource: "heartbeat",
      },
    }),
  );
  assert.deepEqual(row.health.capabilities, []);
  assert.deepEqual(row.health.capabilityEvidence, ["sessions.resume", "settings.remote", "web.routes"]);
  assert.equal(row.health.capabilitiesStale, true);
});

test("lost/stale/fail/degraded values map one-to-one without flattening", () => {
  const row = mapNodeRow(
    sampleNode({
      state: "tombstoned",
      tombstoneReason: "retired",
      health: {
        registryContact: "lost",
        dshHealthy: "degraded",
        orbitCompatible: "fail",
        reachable: "unknown",
        authenticated: "revoked",
        capabilitiesStale: true,
        capabilities: [],
        capabilityEvidence: [],
        alertFlags: ["contact-lost"],
        lastSeen: null,
        lastSeenSource: null,
      },
    }),
  );
  assert.equal(row.health.registryContact, "lost");
  assert.equal(row.health.dshHealthy, "degraded");
  assert.equal(row.health.orbitCompatible, "fail");
  assert.equal(row.health.reachable, "unknown");
  assert.equal(row.state, "tombstoned");
  assert.deepEqual(row.health.alertFlags, ["contact-lost"]);
});

test("node detail carries the latest report and the event history verbatim", () => {
  const detail = mapNodeDetail({
    ...sampleNode(),
    latestReport: {
      uploadedAt: "2026-08-31T01:00:00.000Z",
      orbit: { version: "0.3.0", revision: "abc123" },
      candidate: { dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" },
      compatibility: "pass",
    },
    events: [
      { at: "t1", dimension: "registry_contact", from: "unknown", to: "fresh", source: "heartbeat" },
      { at: "t2", dimension: "orbit_compatible", from: "pass", to: "stale", source: "heartbeat" },
    ],
  });
  assert.equal(detail.latestReport.compatibility, "pass");
  assert.equal(detail.events.length, 2);
  assert.equal(detail.events[1].to, "stale");
  assert.equal(detail.latestReport.orbitRevision, "abc123");
});

test("empty and malformed lists yield explicit empty states, never fake rows", () => {
  assert.equal(mapNodeList([]).kind, EMPTY_NODES_STATE.kind);
  assert.equal(mapNodeList(null).kind, EMPTY_NODES_STATE.kind);
  assert.equal(mapTokenList([]).kind, EMPTY_TOKENS_STATE.kind);
});

test("token rows carry explicit status; the mint view keeps the plaintext exactly once", () => {
  const rows = mapTokenList([
    { tokenId: "etok_a", purpose: "enroll", boundNodeId: null, status: "active", createdAt: "t", expiresAt: "t2", consumedAt: null },
    { tokenId: "etok_b", purpose: "reenroll", boundNodeId: "node_x", status: "consumed", createdAt: "t", expiresAt: "t2", consumedAt: "t3" },
  ]);
  assert.deepEqual(rows.rows.map((row) => row.status), ["active", "consumed"]);
  const minted = mapTokenMint({ tokenId: "etok_c", token: "ab".repeat(16), purpose: "enroll", boundNodeId: null, expiresAt: "t" });
  assert.equal(minted.plaintextOnce, "ab".repeat(16));
  // Nothing in the token list or any later state ever carries it.
  assert.equal(Object.hasOwn(rows.rows[0], "plaintextOnce"), false);
});

test("delete mapping surfaces the explicit result and idempotent replay flag", () => {
  assert.equal(mapDeleteResult({ nodeId: "n", state: "tombstoned", idempotentReplay: false }).idempotentReplay, false);
  assert.equal(mapDeleteResult({ nodeId: "n", state: "tombstoned", idempotentReplay: true }).idempotentReplay, true);
});

test("client-generated delete requestId is 32 lowercase hex and stable across calls", () => {
  const rng = () => 0xab;
  const first = createDeleteRequestId(rng);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(first, createDeleteRequestId(rng));
  assert.notEqual(createDeleteRequestId(rng), createDeleteRequestId(() => 0xcd));
});

test("api errors map to readable surfaces without losing the code", () => {
  const mapped = mapApiError({ error: { code: "request-id-reused", message: "requestId was already used" } });
  assert.equal(mapped.code, "request-id-reused");
  assert.equal(mapped.message, "requestId was already used");
  const fallback = mapApiError({});
  assert.equal(fallback.code, "unknown");
});