import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const ACCEPTED_V04_CLOSURE = "9891ab858a9c953a211978580910efcc2158bcd7";

const REVERSE_MATRIX_FIELDS = [
  "pairTokenMinted",
  "pairTokenDigestOnly",
  "pairFreshNodeSuccess",
  "pairReplayIdempotent",
  "pairDifferentContentDenied",
  "pairWrongPurposeDenied",
  "pairExpiredDenied",
  "pairLostKeyCreatesNewNodeId",
  "existingNodeReverseConnectsWithoutRepair",
  "publicMachineIngressAuthenticated",
  "machineWrongSignatureDenied",
  "machineNonceReplayDenied",
  "machineStaleTimestampDenied",
  "reverseTlsUnknownCaDenied",
  "reverseTlsWrongSanDenied",
  "reverseControlOnline",
  "duplicateControlDeterministicTakeover",
  "controlReconnectAfterNetworkLoss",
  "hubRestartReconnect",
  "nodeRestartReconnect",
  "reversePresenceIndependentOfRegistryContact",
  "reverseDshLossUnreachable",
  "reverseDshRecoveryReachable",
  "dataChannelPoolBounded",
  "httpRootReverse",
  "staticAssetReverse",
  "streamingUploadReverse",
  "websocketUpgradeReverse",
  "websocketPingPongReverse",
  "websocketLargePayloadReverse",
  "cookieIsolationReverse",
  "routeProofWrongNodeDenied",
  "routeProofReplayDenied",
  "channelAbortCleanup",
  "noCredentialLeak",
  "nodeAOutageIsolation",
  "nodeBHealthyDuringAOutage",
  "noImplicitDirectFallback",
  "noImplicitReverseFallback",
  "explicitRouteModeSwitch",
  "directModeRegression",
  "credentialRotationReconnect",
  "deleteClosesReverseSession",
  "reenrollFreshHubRouteIdentity",
  "deletedBookmarkFailClosed",
  "hubRestartNoPhantomReverseSession",
  "backupRestoreNoLiveReverseSession",
  "selectorReverseEligibility",
];

test("v0.5 construction design package is anchored to the accepted v0.4 closure", async () => {
  const [authorizationText, roadmap, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.5-construction-authorization-2026-09-19.json"),
    read("docs/roadmap.md"),
    read("docs/rfc/0012-reverse-connected-nodes.md"),
    read("docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationText);

  assert.equal(authorization.authorizationId, "V05-CONSTRUCTION-20260919-A1");
  assert.equal(authorization.acceptedV04Closure, ACCEPTED_V04_CLOSURE);
  assert.equal(authorization.constructionLineage.mustDescendFromAcceptedV04Closure, true);
  assert.match(authorization.objective, /reverse-connected nodes/);
  assert.match(authorization.evidenceRequirements.reverseConnectionMatrixRequired, /mechanically enforced/);

  assert.match(roadmap, /rfc\/0012-reverse-connected-nodes\.md/);
  assert.match(roadmap, /sop\/v0\.5-reverse-connected-nodes-multistage-sop\.md/);
  assert.match(roadmap, /Gate A Architecture Review GO/);

  assert.match(rfc, /Product construction is blocked until the Stage 0 \/ Gate A review records GO/);
  assert.match(rfc, /routeMode = direct \| reverse/);
  assert.match(rfc, /One authenticated reverse \*\*control connection\*\* exists per node/i);
  assert.match(rfc, /bounded pool of authenticated reverse \*\*data channels\*\*/i);
  assert.match(rfc, /Each data channel carries at most one browser flow at a time/i);
  assert.match(rfc, /never silently fail over/i);
  assert.match(rfc, /POST \/api\/v1\/pair/);
  assert.match(rfc, /GET  \/api\/v1\/reverse\/control/);
  assert.match(rfc, /GET  \/api\/v1\/reverse\/channel/);

  assert.match(sop, new RegExp(ACCEPTED_V04_CLOSURE));
  assert.match(sop, /Gate A — Architecture Review/);
  assert.match(sop, /Gate B — Reverse transport\/security review/);
  assert.match(sop, /Gate C — Candidate Review/);
  assert.match(sop, /accepted Stage 0 design SHA becomes the v0\.5 construction design baseline/);
  assert.match(sop, /Do not start Stage 1 from an earlier authorization-only commit/);
  assert.match(sop, /test\/evidence\/v05\//);
  assert.match(sop, /evidence-only closure/i);
});

test("RFC-0012 freezes the exact 48-field reverse acceptance matrix", async () => {
  const rfc = await read("docs/rfc/0012-reverse-connected-nodes.md");
  const actual = [...rfc.matchAll(/^\|\s*\d+\s*\|\s*\`([A-Za-z0-9]+)\`\s*\|/gm)].map((match) => match[1]);

  assert.equal(REVERSE_MATRIX_FIELDS.length, 48);
  assert.equal(new Set(REVERSE_MATRIX_FIELDS).size, 48);
  assert.deepEqual(actual, REVERSE_MATRIX_FIELDS);
});

test("v0.5 scope remains reverse-connection-only and preserves v0.4 routing boundaries", async () => {
  const [authorizationText, rfc, sop] = await Promise.all([
    read("docs/release-attestations/v0.5-construction-authorization-2026-09-19.json"),
    read("docs/rfc/0012-reverse-connected-nodes.md"),
    read("docs/sop/v0.5-reverse-connected-nodes-multistage-sop.md"),
  ]);
  const authorization = JSON.parse(authorizationText);

  for (const forbidden of [
    "a new route authority system beyond RFC-0010",
    "a new selector system beyond RFC-0011",
    "unrelated UI refactor",
    "unrelated runtime refactor",
    "multi-node sessions and fleet workflows (0.6/0.7)",
  ]) {
    assert.ok(authorization.scopeFreeze.outOfScope.includes(forbidden));
  }

  assert.match(rfc, /public browser model does not change/i);
  assert.match(rfc, /same RFC-0010 browser route/i);
  assert.match(rfc, /does not build a generic tunnel/i);
  assert.match(rfc, /no automatic or priority-based selection/i);
  assert.match(rfc, /per-node RFC-0008 Hub route identity/i, "RFC-0008-derived per-node identity language must remain represented");
  assert.match(sop, /Do not clone RFC-0010 routing policy into a “reverse router”/);
  assert.match(sop, /no general tunnel/i);
});
