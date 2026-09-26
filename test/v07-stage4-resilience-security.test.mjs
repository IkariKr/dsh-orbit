// RFC-0014 Stage 4: Outage Containment, Target Disconnection & Negative Security
// Verifies:
// 1. Target node crash / error during execution marks target failed while peers complete (field 17)
// 2. Reverse node disconnect / capacity / payload limits handling (field 18)
// 3. Zero cross-node credential leakage across payloads, logs, and audit (field 27)
// 4. Concurrent fleet job execution without race conditions or cross-job contamination (field 12)
// 5. Complete results accounting invariant maintained under all failure topologies (field 7, 28)

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { FleetJobScheduler } from "../src/registry/fleet-scheduler.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const CSRF_HEADER = "x-csrf-token";

function gatewayHeaders(operator = "operator-alice") {
  return {
    [GATEWAY_HEADER]: ASSERTION,
    [PRINCIPAL_HEADER]: operator,
  };
}

function parseCookies(res) {
  const header = res.headers.get("set-cookie");
  if (!header) return new Map();
  const cookies = new Map();
  for (const item of header.split(",")) {
    const part = item.split(";")[0].trim();
    const idx = part.indexOf("=");
    if (idx > 0) {
      cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }
  return cookies;
}

async function withServer(t, options = {}) {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });
  const { server } = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: ASSERTION,
      operatorPrincipal: { mode: "inject" },
      fleetDispatchTransport: options.fleetDispatchTransport ?? null,
      fleetMaxConcurrentDispatches: options.fleetMaxConcurrentDispatches ?? 8,
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  server.baseUrl = baseUrl;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });
  return { registry, server, baseUrl };
}

async function establishSession(baseUrl, operator = "operator-alice") {
  const res = await fetch(`${baseUrl}/hub/session`, {
    method: "POST",
    headers: {
      ...gatewayHeaders(operator),
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const cookies = parseCookies(res);
  const cookie = `dsh-orbit-hub-session=${cookies.get("dsh-orbit-hub-session")}`;
  return { cookie, csrfToken: body.csrfToken, principal: body.principal };
}

async function enrollNode(baseUrl, registry, { routeMode = "direct" } = {}) {
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const requestId = "f4".repeat(16);
  const publicKey = "04".repeat(32);
  const res = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: plain.token, enrollmentRequestId: requestId, publicKey }),
  });
  assert.equal(res.status, 200);
  const { nodeId } = await res.json();
  if (routeMode !== "direct") {
    registry.db.prepare("UPDATE nodes SET route_mode = ? WHERE node_id = ?").run(routeMode, nodeId);
  }
  return { nodeId, routeMode };
}

// -----------------------------------------------------------------------------
// Test 1: Target Node Crash / Outage During Execution (Field 17)
// -----------------------------------------------------------------------------

test("outage containment: target node crash during execution marks target failed while peers complete (field 17)", async (t) => {
  let crashedNodeId = null;
  const { registry, server, baseUrl } = await withServer(t, {
    fleetDispatchTransport: async (nodeId, task) => {
      if (nodeId === crashedNodeId) {
        // Simulate sudden process crash / connection reset
        const err = new Error("ECONNRESET: target node daemon crashed abruptly");
        err.code = "ECONNRESET";
        throw err;
      }
      return {
        status: "completed",
        exitCode: 0,
        stdout: `peer node ${nodeId} finished diagnostic successfully`,
        stderr: "",
      };
    },
  });

  const nodeA = await enrollNode(baseUrl, registry);
  const nodeB = await enrollNode(baseUrl, registry);
  const nodeC = await enrollNode(baseUrl, registry);
  crashedNodeId = nodeB.nodeId;

  const session = await establishSession(baseUrl, "operator-alice");

  const submitRes = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskType: "diagnostic",
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId, nodeB.nodeId, nodeC.nodeId] },
    }),
  });

  assert.equal(submitRes.status, 201);
  const submitted = await submitRes.json();
  const jobEntry = server.fleetScheduler.jobs.get(submitted.jobId);
  await jobEntry._executionPromise;

  const getRes = await fetch(`${baseUrl}/hub/fleet/jobs/${submitted.jobId}`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(getRes.status, 200);
  const job = await getRes.json();

  // Outage containment: job status is partial (not total failure)
  assert.equal(job.status, "partial");
  assert.equal(job.summary.totalTargets, 3);
  assert.equal(job.summary.completed, 2);
  assert.equal(job.summary.failed, 1);
  assert.equal(job.summary.timeout, 0);
  assert.equal(job.summary.unreachable, 0);
  assert.equal(job.summary.skipped, 0);

  // Crashed node results recorded with exact error
  const resB = job.results[nodeB.nodeId];
  assert.equal(resB.status, "failed");
  assert.equal(resB.error.code, "ECONNRESET");
  assert.ok(resB.error.message.includes("crashed"));

  // Peer nodes A and C completed normally
  const resA = job.results[nodeA.nodeId];
  assert.equal(resA.status, "completed");
  assert.equal(resA.exitCode, 0);
  assert.ok(resA.stdout.includes(nodeA.nodeId));

  const resC = job.results[nodeC.nodeId];
  assert.equal(resC.status, "completed");
  assert.equal(resC.exitCode, 0);
  assert.ok(resC.stdout.includes(nodeC.nodeId));

  // Accounting invariant verification
  const sum = job.summary.completed + job.summary.failed + job.summary.skipped + job.summary.timeout + job.summary.unreachable;
  assert.equal(sum, job.summary.totalTargets);
  assert.equal(Object.keys(job.results).length, job.summary.totalTargets);
});

// -----------------------------------------------------------------------------
// Test 2: Reverse Node Disconnect, Capacity & Payload Limits (Field 18)
// -----------------------------------------------------------------------------

test("reverse node outage: disconnect, capacity wait, and payload size bounds (field 18)", async (t) => {
  const db = openRegistryDatabase(":memory:");
  const registry = new Registry({ db });

  const idDirectOk = "node_" + "11".repeat(16);
  const idReverseOk = "node_" + "22".repeat(16);
  const idReverseOffline = "node_" + "33".repeat(16);
  const idReverseUnready = "node_" + "44".repeat(16);
  const idReverseNoCapacity = "node_" + "55".repeat(16);

  // Mock reverse sessions and channels manager
  const reverseSessions = {
    getSessionInfo: (nodeId) => {
      if (nodeId === idReverseOffline) return null;
      if (nodeId === idReverseUnready) return { reverseSessionId: "rs_unready", routeReady: false };
      return { reverseSessionId: `rs_${nodeId}`, routeReady: true };
    },
  };

  const reverseChannels = {
    hasChannelForSession: (nodeId, sessionId) => {
      if (nodeId === idReverseNoCapacity) return false;
      return true;
    },
  };

  const scheduler = new FleetJobScheduler({
    registry,
    reverseSessions,
    reverseChannels,
    now: () => new Date(),
  });

  // Setup nodes in registry
  const registerNode = (nodeId, routeMode) => {
    registry.db.prepare(
      "INSERT INTO nodes (node_id, state, minted_at, route_mode, reachable, capabilities, capabilities_stale) VALUES (?, 'active', '2026-09-26T00:00:00.000Z', ?, 'ok', '[]', 0)",
    ).run(nodeId, routeMode);
  };

  registerNode(idDirectOk, "direct");
  registerNode(idReverseOk, "reverse");
  registerNode(idReverseOffline, "reverse");
  registerNode(idReverseUnready, "reverse");
  registerNode(idReverseNoCapacity, "reverse");

  // Case A: Disconnected reverse session marks unreachable without cascading
  const job1 = scheduler.submitJob({
    taskType: "diagnostic",
    targetSpec: {
      mode: "explicit",
      nodeIds: [idDirectOk, idReverseOk, idReverseOffline, idReverseUnready, idReverseNoCapacity],
    },
  });

  await scheduler.jobs.get(job1.jobId)._executionPromise;
  const result1 = scheduler.getJob(job1.jobId);

  assert.equal(result1.status, "partial");
  assert.equal(result1.summary.totalTargets, 5);
  assert.equal(result1.summary.completed, 2); // direct_ok + reverse_ok
  assert.equal(result1.summary.unreachable, 3); // offline, unready, no_capacity
  assert.equal(result1.summary.failed, 0);

  assert.equal(result1.results[idReverseOffline].status, "unreachable");
  assert.equal(result1.results[idReverseOffline].error.code, "reverse-session-offline");

  assert.equal(result1.results[idReverseUnready].status, "unreachable");
  assert.equal(result1.results[idReverseUnready].error.code, "reverse-route-unreachable");

  assert.equal(result1.results[idReverseNoCapacity].status, "unreachable");
  assert.equal(result1.results[idReverseNoCapacity].error.code, "reverse-capacity");

  assert.equal(result1.results[idDirectOk].status, "completed");
  assert.equal(result1.results[idReverseOk].status, "completed");

  // Case B: Reverse payload exceeding 32 KiB limit fails closed with payload-too-large
  const largePayload = {
    data: "A".repeat(33 * 1024), // 33 KiB > 32 KiB
  };

  const job2 = scheduler.submitJob({
    taskType: "command",
    targetSpec: { mode: "explicit", nodeIds: [idDirectOk, idReverseOk] },
    payload: largePayload,
  });

  await scheduler.jobs.get(job2.jobId)._executionPromise;
  const result2 = scheduler.getJob(job2.jobId);

  // Direct node succeeds, reverse node fails closed with payload-too-large
  assert.equal(result2.status, "partial");
  assert.equal(result2.results[idDirectOk].status, "completed");
  assert.equal(result2.results[idReverseOk].status, "failed");
  assert.equal(result2.results[idReverseOk].error.code, "payload-too-large");

  registry.close();
});

// -----------------------------------------------------------------------------
// Test 3: Zero Cross-Node Credential Leakage (Field 27)
// -----------------------------------------------------------------------------

test("zero credential leakage: cross-node payload isolation and log scrubbing (field 27)", async (t) => {
  const interceptedDispatches = [];
  let nodeAId = null;

  const { registry, server, baseUrl } = await withServer(t, {
    fleetDispatchTransport: async (nodeId, task) => {
      interceptedDispatches.push({ nodeId, taskPayload: JSON.parse(JSON.stringify(task.payload)) });
      if (nodeId === nodeAId) {
        return {
          status: "completed",
          exitCode: 0,
          stdout: "node01: DB_PASSWORD=test_pw_123 GITHUB_TOKEN=test_ghp_tok",
          stderr: "Authorization: Basic dXNlcjpwdw==",
        };
      }
      return {
        status: "completed",
        exitCode: 0,
        stdout: "node02: AWS_SECRET_ACCESS_KEY=test_key_node2 token=test_tok_2",
        stderr: "curl -u admin:mypassword https://internal",
      };
    },
  });

  const nodeA = await enrollNode(baseUrl, registry);
  const nodeB = await enrollNode(baseUrl, registry);
  nodeAId = nodeA.nodeId;
  const session = await establishSession(baseUrl, "operator-alice");

  const sensitivePayload = {
    command: "check-credentials",
    sharedApiKey: "sk-live-TOPSECRET",
    dbPassword: "rootpassword123",
    nested: {
      rawHeader: "Authorization: Bearer secret_bearer_token",
      authHeader: "Authorization: Bearer secret_bearer_token",
      sessionKey: "session_key_secret_val",
    },
    regularData: "audit-ok",
  };

  const submitRes = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskType: "command",
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId, nodeB.nodeId] },
      payload: sensitivePayload,
    }),
  });

  assert.equal(submitRes.status, 201);
  const submitted = await submitRes.json();
  await server.fleetScheduler.jobs.get(submitted.jobId)._executionPromise;

  // Verify that transport received the raw payload without in-transit cross-corruption
  assert.equal(interceptedDispatches.length, 2);
  assert.equal(interceptedDispatches[0].taskPayload.sharedApiKey, "sk-live-TOPSECRET");
  assert.equal(interceptedDispatches[1].taskPayload.sharedApiKey, "sk-live-TOPSECRET");

  // Read job via HTTP API by another operator (operator-bob)
  const sessionBob = await establishSession(baseUrl, "operator-bob");
  const getRes = await fetch(`${baseUrl}/hub/fleet/jobs/${submitted.jobId}`, {
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie: sessionBob.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });

  assert.equal(getRes.status, 200);
  const job = await getRes.json();

  // 1. Payload credentials are fully redacted
  assert.equal(job.payload.sharedApiKey, "[REDACTED]");
  assert.equal(job.payload.dbPassword, "[REDACTED]");
  assert.equal(job.payload.nested.rawHeader, "Authorization: Bearer [REDACTED_TOKEN]");
  assert.equal(job.payload.nested.authHeader, "[REDACTED]");
  assert.equal(job.payload.nested.sessionKey, "[REDACTED]");
  assert.equal(job.payload.regularData, "audit-ok");

  // 2. Node output logs (stdout/stderr) are scrubbed for both nodes
  const resA = job.results[nodeA.nodeId];
  assert.ok(resA.stdout.includes("[REDACTED]"));
  assert.ok(!resA.stdout.includes("test_pw_123"));
  assert.ok(!resA.stdout.includes("test_ghp_tok"));
  assert.ok(resA.stderr.includes("[REDACTED_AUTH]"));

  const resB = job.results[nodeB.nodeId];
  assert.ok(resB.stdout.includes("[REDACTED]"));
  assert.ok(!resB.stdout.includes("test_key_node2"));
  assert.ok(resB.stderr.includes("curl -u admin:[REDACTED]"));

  // 3. Hub Audit log does not record unscrubbed credentials
  const auditRes = await fetch(`${baseUrl}/hub/fleet/jobs/${submitted.jobId}/audit`, {
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie: sessionBob.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(auditRes.status, 200);
  const auditBody = await auditRes.json();
  const rawAuditStr = JSON.stringify(auditBody);
  assert.ok(!rawAuditStr.includes("sk-live-TOPSECRET"));
  assert.ok(!rawAuditStr.includes("rootpassword123"));
  assert.ok(!rawAuditStr.includes("secret_pw_123"));
});

// -----------------------------------------------------------------------------
// Test 4: Concurrent Fleet Job Execution (Field 12)
// -----------------------------------------------------------------------------

test("concurrency: multiple concurrent fleet jobs execute without cross-job interference (field 12)", async (t) => {
  const activeDispatches = new Map();
  let maxConcurrentObserved = 0;

  const { registry, server, baseUrl } = await withServer(t, {
    fleetMaxConcurrentDispatches: 16,
    fleetDispatchTransport: async (nodeId, task) => {
      const key = `${task.jobId}:${nodeId}`;
      activeDispatches.set(key, Date.now());
      maxConcurrentObserved = Math.max(maxConcurrentObserved, activeDispatches.size);

      // Sleep a small jitter to force concurrent overlap
      await new Promise((r) => setTimeout(r, 20));

      activeDispatches.delete(key);
      return {
        status: "completed",
        exitCode: 0,
        stdout: `task ${task.taskType} completed on ${nodeId}`,
        stderr: "",
      };
    },
  });

  const node1 = await enrollNode(baseUrl, registry);
  const node2 = await enrollNode(baseUrl, registry);
  const node3 = await enrollNode(baseUrl, registry);
  const node4 = await enrollNode(baseUrl, registry);

  const session = await establishSession(baseUrl, "operator-alice");

  // Submit 4 concurrent fleet jobs with overlapping node targets
  const submitJob = async (taskType, nodeIds) => {
    const res = await fetch(`${baseUrl}/hub/fleet/jobs`, {
      method: "POST",
      headers: {
        ...gatewayHeaders("operator-alice"),
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        taskType,
        targetSpec: { mode: "explicit", nodeIds },
      }),
    });
    assert.equal(res.status, 201);
    return await res.json();
  };

  const [job1, job2, job3] = await Promise.all([
    submitJob("diagnostic", [node1.nodeId, node2.nodeId]),
    submitJob("health-check", [node2.nodeId, node3.nodeId]),
    submitJob("command", [node1.nodeId, node3.nodeId, node4.nodeId]),
  ]);

  // Await all job executions
  await Promise.all([
    server.fleetScheduler.jobs.get(job1.jobId)._executionPromise,
    server.fleetScheduler.jobs.get(job2.jobId)._executionPromise,
    server.fleetScheduler.jobs.get(job3.jobId)._executionPromise,
  ]);

  // Verify concurrent dispatches occurred
  assert.ok(maxConcurrentObserved >= 2, `expected concurrent dispatches >= 2, observed ${maxConcurrentObserved}`);

  // Fetch final status of each job
  const getJob = async (jobId) => {
    const res = await fetch(`${baseUrl}/hub/fleet/jobs/${jobId}`, {
      headers: {
        ...gatewayHeaders("operator-alice"),
        cookie: session.cookie,
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(res.status, 200);
    return await res.json();
  };

  const [res1, res2, res3] = await Promise.all([
    getJob(job1.jobId),
    getJob(job2.jobId),
    getJob(job3.jobId),
  ]);

  // Check job 1: 2 targets completed
  assert.equal(res1.status, "completed");
  assert.equal(res1.summary.totalTargets, 2);
  assert.equal(res1.summary.completed, 2);
  assert.equal(res1.summary.failed, 0);

  // Check job 2: 2 targets completed
  assert.equal(res2.status, "completed");
  assert.equal(res2.summary.totalTargets, 2);
  assert.equal(res2.summary.completed, 2);
  assert.equal(res2.summary.failed, 0);

  // Check job 3: 3 targets completed
  assert.equal(res3.status, "completed");
  assert.equal(res3.summary.totalTargets, 3);
  assert.equal(res3.summary.completed, 3);
  assert.equal(res3.summary.failed, 0);

  // Check cancellation isolation: cancelling Job A while Job B runs does not affect Job B
  let unblockJobB = null;
  const jobBPromise = new Promise((resolve) => {
    unblockJobB = resolve;
  });

  server.fleetScheduler.dispatchTransport = async (nodeId, task, signal) => {
    if (task.jobId.startsWith("job_cancel_target")) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve({ status: "failed", error: { code: "aborted", message: "cancelled" } });
        });
      });
    }
    await jobBPromise;
    return { status: "completed", exitCode: 0, stdout: "ok", stderr: "" };
  };

  const jobA = await submitJob("diagnostic", [node1.nodeId]);
  const jobB = await submitJob("diagnostic", [node2.nodeId]);

  // Cancel Job A
  const cancelRes = await fetch(`${baseUrl}/hub/fleet/jobs/${jobA.jobId}/cancel`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(cancelRes.status, 200);

  // Unblock Job B
  unblockJobB();
  await server.fleetScheduler.jobs.get(jobB.jobId)._executionPromise;

  const resA = await getJob(jobA.jobId);
  const resFinalB = await getJob(jobB.jobId);

  assert.equal(resA.status, "failed"); // Cancelled
  assert.equal(resFinalB.status, "completed"); // Remained unaffected and completed
  assert.equal(resFinalB.summary.completed, 1);
});
