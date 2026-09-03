// Stage 2 Live Two-Node Integration Evidence Test
// Proves two independent nodes (Node A on HTTPS with custom private CA, Node B on loopback HTTP),
// heartbeat key synchronization, route targets, reachability state machine,
// fault injection & isolation (stop ingress, stop DSH), and persistent restart recovery.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { generateNodeKeyPair, deriveKeyId, randomHex } from "../src/registry/crypto.mjs";
import { RouteIngress } from "../src/node/route-ingress.mjs";

function enrollNodeDirect(registry) {
  const minted = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const keys = generateNodeKeyPair();
  const res = registry.enroll({
    token: minted.token,
    enrollmentRequestId: randomHex(16),
    publicKey: keys.publicKeyHex,
  });
  return { nodeId: res.nodeId, keyPair: keys, keyId: res.keyId };
}

test("Live Two-Node Integration Evidence: NAS (HTTPS + Private CA) & Workstation (HTTP), Fault Isolation, and Restart Recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage2-live-two-node-"));
  const dbPath = join(dir, "hub.db");
  let db = openRegistryDatabase(dbPath);

  const routeDomain = "dsh.example.local";
  let registry = new Registry({
    db,
    routeDomain,
    caCertificates: [GATEWAY_CERT_PEM],
  });

  // Mock DSH states
  let dshAliveA = true;
  let dshAliveB = true;

  let ingressA = null;
  let ingressB = null;

  try {
    console.log("\n=== STEP 1: Topology and Node Enrollment ===");
    // 1. Enroll Node A (NAS) and Node B (Workstation)
    const nodeA = enrollNodeDirect(registry);
    const nodeB = enrollNodeDirect(registry);
    console.log(`[Evidence] Enrolled Node A (NAS): ${nodeA.nodeId}`);
    console.log(`[Evidence] Enrolled Node B (Workstation): ${nodeB.nodeId}`);

    // 2. Initial heartbeats: Hub issues provisioned Hub route keys
    const hbA1 = registry.heartbeatAuthenticated({
      node: registry.getNodeRow(nodeA.nodeId),
      rawBody: Buffer.from(JSON.stringify({
        runtime: { orbitVersion: "0.4.0", dshVersion: "1.0.0" },
        acceptedHubRouteKeyIds: [],
      })),
    });
    const keyA1 = hbA1.hubRouteKeys[0];
    assert.equal(keyA1.state, "provisioned");
    console.log(`[Evidence] Node A received provisioned Hub route key: ${keyA1.keyId}`);

    const hbB1 = registry.heartbeatAuthenticated({
      node: registry.getNodeRow(nodeB.nodeId),
      rawBody: Buffer.from(JSON.stringify({
        runtime: { orbitVersion: "0.4.0", dshVersion: "1.0.0" },
        acceptedHubRouteKeyIds: [],
      })),
    });
    const keyB1 = hbB1.hubRouteKeys[0];
    assert.equal(keyB1.state, "provisioned");
    console.log(`[Evidence] Node B received provisioned Hub route key: ${keyB1.keyId}`);

    // 3. Second heartbeats: Nodes acknowledge keys -> Hub promotes to active
    const hbA2 = registry.heartbeatAuthenticated({
      node: registry.getNodeRow(nodeA.nodeId),
      rawBody: Buffer.from(JSON.stringify({
        runtime: { orbitVersion: "0.4.0", dshVersion: "1.0.0" },
        acceptedHubRouteKeyIds: [keyA1.keyId],
      })),
    });
    assert.equal(hbA2.hubRouteKeys[0].state, "active");
    console.log(`[Evidence] Node A acknowledged key ${keyA1.keyId} -> state: active`);

    const hbB2 = registry.heartbeatAuthenticated({
      node: registry.getNodeRow(nodeB.nodeId),
      rawBody: Buffer.from(JSON.stringify({
        runtime: { orbitVersion: "0.4.0", dshVersion: "1.0.0" },
        acceptedHubRouteKeyIds: [keyB1.keyId],
      })),
    });
    assert.equal(hbB2.hubRouteKeys[0].state, "active");
    console.log(`[Evidence] Node B acknowledged key ${keyB1.keyId} -> state: active`);

    // 4. Start Route Ingress:
    // Node A uses HTTPS with Private CA credentials
    ingressA = new RouteIngress({
      nodeId: nodeA.nodeId,
      routeDomain,
      tls: {
        key: GATEWAY_KEY_PEM,
        cert: GATEWAY_CERT_PEM,
      },
      getTrustKeys: () => hbA2.hubRouteKeys,
      dshProbeTransport: async () => dshAliveA,
    });
    await ingressA.listen(0, "127.0.0.1");
    const nodeAPort = ingressA.port;
    const nodeAOrigin = `https://127.0.0.1:${nodeAPort}`;
    console.log(`[Evidence] Node A Ingress listening on HTTPS: ${nodeAOrigin}`);

    // Node B uses loopback HTTP
    ingressB = new RouteIngress({
      nodeId: nodeB.nodeId,
      routeDomain,
      getTrustKeys: () => hbB2.hubRouteKeys,
      dshProbeTransport: async () => dshAliveB,
    });
    await ingressB.listen(0, "127.0.0.1");
    const nodeBPort = ingressB.port;
    const nodeBOrigin = `http://127.0.0.1:${nodeBPort}`;
    console.log(`[Evidence] Node B Ingress listening on HTTP: ${nodeBOrigin}`);

    // 5. Register route targets on Hub
    registry.setRouteTarget({ actor: "operator", nodeId: nodeA.nodeId, routeTarget: nodeAOrigin });
    registry.setRouteTarget({ actor: "operator", nodeId: nodeB.nodeId, routeTarget: nodeBOrigin });
    console.log(`[Evidence] Registered routeTarget for Node A: ${nodeAOrigin}`);
    console.log(`[Evidence] Registered routeTarget for Node B: ${nodeBOrigin}`);

    console.log("\n=== STEP 2: Initial Reachability Probes ===");
    // Probe Node A over HTTPS with private CA
    const probeA1 = await registry.probeNode(nodeA.nodeId);
    console.log(`[Evidence] Probe Node A result:`, probeA1);
    assert.equal(probeA1.reachable, "ok");
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "ok");

    // Probe Node B over HTTP
    const probeB1 = await registry.probeNode(nodeB.nodeId);
    console.log(`[Evidence] Probe Node B result:`, probeB1);
    assert.equal(probeB1.reachable, "ok");
    assert.equal(registry.getNode(nodeB.nodeId).health.reachable, "ok");

    console.log("\n=== STEP 3: Fault Injection 1 - Node A Ingress Stopped ===");
    // Stop Node A Ingress
    await ingressA.close();
    console.log("[Evidence] Node A Ingress listener stopped");

    // 3 consecutive probe failures to trip threshold
    const pA_fail1 = await registry.probeNode(nodeA.nodeId);
    assert.equal(pA_fail1.failures, 1);
    const pA_fail2 = await registry.probeNode(nodeA.nodeId);
    assert.equal(pA_fail2.failures, 2);
    const pA_fail3 = await registry.probeNode(nodeA.nodeId);
    assert.equal(pA_fail3.failures, 3);
    assert.equal(pA_fail3.reachable, "unreachable");
    console.log(`[Evidence] Node A reached 3 consecutive failures -> reachable: unreachable`);
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "unreachable");

    // Verify isolation: Node B MUST remain ok
    const probeB_iso = await registry.probeNode(nodeB.nodeId);
    assert.equal(probeB_iso.reachable, "ok");
    console.log(`[Evidence] Node B isolation check -> reachable remains ok`);

    console.log("\n=== STEP 4: Fault Injection 2 - Downstream DSH Down on Node A ===");
    // Restart Node A Ingress on the same port, but mark downstream DSH as down
    dshAliveA = false;
    ingressA = new RouteIngress({
      nodeId: nodeA.nodeId,
      routeDomain,
      tls: {
        key: GATEWAY_KEY_PEM,
        cert: GATEWAY_CERT_PEM,
      },
      getTrustKeys: () => hbA2.hubRouteKeys,
      dshProbeTransport: async () => dshAliveA,
    });
    await ingressA.listen(nodeAPort, "127.0.0.1");
    console.log(`[Evidence] Node A Ingress restarted on ${nodeAOrigin}, but downstream DSH is DOWN`);

    const pA_dshFail = await registry.probeNode(nodeA.nodeId);
    console.log(`[Evidence] Probe Node A with DSH down:`, pA_dshFail);
    assert.equal(pA_dshFail.reachable, "unreachable");
    assert.equal(pA_dshFail.ok, false);

    console.log("\n=== STEP 5: Recovery - Downstream DSH Restored on Node A ===");
    dshAliveA = true;
    const pA_recovered = await registry.probeNode(nodeA.nodeId);
    console.log(`[Evidence] Probe Node A after DSH restored:`, pA_recovered);
    assert.equal(pA_recovered.reachable, "ok");
    assert.equal(registry.getNode(nodeA.nodeId).health.reachable, "ok");

    console.log("\n=== STEP 6: Hub Restart Persistence & Zero Key Drift ===");
    // Close live DB and reopen to simulate restart
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    registry.close();

    const reopenedDb = openRegistryDatabase(dbPath);
    const restartedHub = new Registry({
      db: reopenedDb,
      routeDomain,
      caCertificates: [GATEWAY_CERT_PEM],
    });

    try {
      const summaryA = restartedHub.getNode(nodeA.nodeId);
      const summaryB = restartedHub.getNode(nodeB.nodeId);

      // Verify route targets preserved
      assert.equal(summaryA.routeTarget.origin, nodeAOrigin);
      assert.equal(summaryB.routeTarget.origin, nodeBOrigin);
      console.log(`[Evidence] Restarted Hub preserved route targets intact`);

      // Verify Hub route keys preserved without drift
      assert.equal(summaryA.hubRouteKeys.length, 1);
      assert.equal(summaryA.hubRouteKeys[0].keyId, keyA1.keyId);
      assert.equal(summaryA.hubRouteKeys[0].publicKey, keyA1.publicKey);
      assert.equal(summaryA.hubRouteKeys[0].state, "active");

      assert.equal(summaryB.hubRouteKeys.length, 1);
      assert.equal(summaryB.hubRouteKeys[0].keyId, keyB1.keyId);
      assert.equal(summaryB.hubRouteKeys[0].publicKey, keyB1.publicKey);
      assert.equal(summaryB.hubRouteKeys[0].state, "active");
      console.log(`[Evidence] Restarted Hub preserved active Hub route identities without drift`);

      // Verify reachable state preserved
      assert.equal(summaryA.health.reachable, "ok");
      assert.equal(summaryB.health.reachable, "ok");

      // Verify subsequent probe works over reopened DB
      const postRestartProbeA = await restartedHub.probeNode(nodeA.nodeId);
      assert.equal(postRestartProbeA.reachable, "ok");
      const postRestartProbeB = await restartedHub.probeNode(nodeB.nodeId);
      assert.equal(postRestartProbeB.reachable, "ok");
      console.log(`[Evidence] Post-restart probes to both nodes succeeded: reachable=ok`);
    } finally {
      try { reopenedDb?.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
      try { restartedHub?.close(); } catch {}
    }
  } finally {
    try { db?.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    try { registry?.close(); } catch {}
    if (ingressA) await ingressA.close();
    if (ingressB) await ingressB.close();
    await rm(dir, { recursive: true, force: true });
  }
});
