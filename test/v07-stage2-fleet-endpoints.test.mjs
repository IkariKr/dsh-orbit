import assert from "node:assert/strict";
import test from "node:test";
import {
  createTestRegistry,
  createTestServer,
  enrollNode,
} from "./helpers/registry-fixture.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const CSRF_HEADER = "x-csrf-token";

const NODE_A = "node_0123456789abcdef0123456789abcdef";
const NODE_B = "node_fedcba9876543210fedcba9876543210";

async function withServer(t, options = {}) {
  const registry = createTestRegistry();
  const server = await createTestServer(registry, {
    gatewayAssertionSecret: ASSERTION,
    operatorPrincipal: { mode: "inject" },
    ...options,
  });
  t.after(async () => {
    await server.close();
    registry.close();
  });
  return { registry, server };
}

function gatewayHeaders(operator = "operator-alice", extra = {}) {
  return { [GATEWAY_HEADER]: ASSERTION, [PRINCIPAL_HEADER]: operator, ...extra };
}

async function establishSession(baseUrl, operator = "operator-alice") {
  const response = await fetch(`${baseUrl}/hub/session`, {
    method: "POST",
    headers: { ...gatewayHeaders(operator), origin: baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/(?:^|;\s*)dsh-orbit-hub-session=([^;]+)/);
  const cookie = match ? `dsh-orbit-hub-session=${match[1]}` : "";
  const body = await response.json();
  return { cookie, csrfToken: body.csrfToken, principal: body.principal };
}

test("fleet endpoints enforce authentication and CSRF protections", async (t) => {
  const { server } = await withServer(t);
  const baseUrl = server.baseUrl;

  // 1. Unauthenticated GET /hub/fleet/jobs -> 401
  const unauthGet = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    headers: { ...gatewayHeaders() },
  });
  assert.equal(unauthGet.status, 401);
  const unauthGetBody = await unauthGet.json();
  assert.equal(unauthGetBody.error.code, "no-session");

  // 2. Unauthenticated POST /hub/fleet/jobs -> 401
  const unauthPost = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ taskType: "diagnostic", targetSpec: { mode: "explicit", nodeIds: [NODE_A] } }),
  });
  assert.equal(unauthPost.status, 401);

  // 3. Authenticated session without CSRF token -> 403 csrf-denied
  const { cookie } = await establishSession(baseUrl);
  const noCsrfPost = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders(),
      cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ taskType: "diagnostic", targetSpec: { mode: "explicit", nodeIds: [NODE_A] } }),
  });
  assert.equal(noCsrfPost.status, 403);
  const noCsrfBody = await noCsrfPost.json();
  assert.equal(noCsrfBody.error.code, "csrf-denied");
});

test("job creation, execution, and listing endpoints (fields 1, 7, 8)", async (t) => {
  const { registry, server } = await withServer(t);
  const baseUrl = server.baseUrl;

  // Enroll two nodes into registry
  const nodeA = await enrollNode(baseUrl, registry);
  const nodeB = await enrollNode(baseUrl, registry);

  const { cookie, csrfToken } = await establishSession(baseUrl, "operator-alice");

  // Submit job via POST /hub/fleet/jobs
  const submitRes = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie,
      [CSRF_HEADER]: csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskType: "diagnostic",
      payload: { test: "stage2-ping" },
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId, nodeB.nodeId] },
    }),
  });

  assert.equal(submitRes.status, 201);
  const submittedJob = await submitRes.json();
  assert.ok(submittedJob.jobId);
  assert.equal(submittedJob.taskType, "diagnostic");
  assert.equal(submittedJob.summary.totalTargets, 2);
  assert.equal(submittedJob.operatorPrincipal, "operator-alice");

  // Wait for execution to settle
  await server.fleetScheduler.jobs.get(submittedJob.jobId)._executionPromise;

  // Retrieve job details via GET /hub/fleet/jobs/:jobId
  const detailRes = await fetch(`${baseUrl}/hub/fleet/jobs/${submittedJob.jobId}`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(detailRes.status, 200);
  const jobDetail = await detailRes.json();
  assert.equal(jobDetail.status, "completed");
  assert.equal(jobDetail.summary.completed, 2);
  assert.equal(Object.keys(jobDetail.results).length, 2);
  assert.equal(jobDetail.results[nodeA.nodeId].status, "completed");
  assert.equal(jobDetail.results[nodeB.nodeId].status, "completed");

  // List jobs via GET /hub/fleet/jobs
  const listRes = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.ok(Array.isArray(listBody.jobs));
  assert.equal(listBody.jobs.length, 1);
  assert.equal(listBody.jobs[0].jobId, submittedJob.jobId);
  assert.equal(listBody.jobs[0].status, "completed");

  // 404 on unknown job
  const unknownRes = await fetch(`${baseUrl}/hub/fleet/jobs/job_ffffffffffffffffffffffffffffffff`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(unknownRes.status, 404);
  const unknownBody = await unknownRes.json();
  assert.equal(unknownBody.error.code, "not-found");
});

test("job cancellation and audit recording (field 8, 26)", async (t) => {
  const { registry, server } = await withServer(t, {
    fleetDispatchTransport: async () => {
      // Simulate slow in-flight task
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { status: "completed", exitCode: 0 };
    },
  });
  const baseUrl = server.baseUrl;

  const nodeA = await enrollNode(baseUrl, registry);

  const { cookie, csrfToken } = await establishSession(baseUrl, "operator-bob");

  // Submit job
  const submitRes = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie,
      [CSRF_HEADER]: csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskType: "command",
      payload: { cmd: "sleep 10" },
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  assert.equal(submitRes.status, 201);
  const job = await submitRes.json();

  // Cancel job via POST /hub/fleet/jobs/:jobId/cancel
  const cancelRes = await fetch(`${baseUrl}/hub/fleet/jobs/${job.jobId}/cancel`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie,
      [CSRF_HEADER]: csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(cancelRes.status, 200);
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.ok, true);
  assert.equal(cancelBody.status, "failed");

  // Check cancellation state
  const jobDetail = server.fleetScheduler.getJob(job.jobId);
  assert.equal(jobDetail.status, "failed");
  assert.equal(jobDetail.results[nodeA.nodeId].status, "failed");
  assert.equal(jobDetail.results[nodeA.nodeId].error.code, "job-cancelled");
});

test("audit log recording and query filtering (field 8, 25)", async (t) => {
  const { registry, server } = await withServer(t);
  const baseUrl = server.baseUrl;

  const nodeA = await enrollNode(baseUrl, registry);
  const nodeB = await enrollNode(baseUrl, registry);

  // Session 1: Alice creates Job 1
  const sessionAlice = await establishSession(baseUrl, "operator-alice");
  const job1Res = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: sessionAlice.cookie,
      [CSRF_HEADER]: sessionAlice.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskType: "diagnostic",
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  const job1 = await job1Res.json();
  await server.fleetScheduler.jobs.get(job1.jobId)._executionPromise;

  // Session 2: Bob creates Job 2
  const sessionBob = await establishSession(baseUrl, "operator-bob");
  const job2Res = await fetch(`${baseUrl}/hub/fleet/jobs`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie: sessionBob.cookie,
      [CSRF_HEADER]: sessionBob.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskType: "command",
      targetSpec: { mode: "explicit", nodeIds: [nodeB.nodeId] },
    }),
  });
  const job2 = await job2Res.json();
  await server.fleetScheduler.jobs.get(job2.jobId)._executionPromise;

  // 1. Query audit log by jobId (field 25)
  const auditJob1Res = await fetch(`${baseUrl}/hub/fleet/jobs/${job1.jobId}/audit`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: sessionAlice.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(auditJob1Res.status, 200);
  const auditJob1 = await auditJob1Res.json();
  assert.ok(auditJob1.audit.length >= 2); // create and complete
  assert.equal(auditJob1.jobId, job1.jobId);
  for (const entry of auditJob1.audit) {
    assert.equal(entry.detail.jobId, job1.jobId);
  }

  // 2. Query audit log by operator via POST /hub/audit/query
  const auditQueryRes = await fetch(`${baseUrl}/hub/audit/query`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: sessionAlice.cookie,
      [CSRF_HEADER]: sessionAlice.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ operator: "operator-alice" }),
  });
  assert.equal(auditQueryRes.status, 200);
  const aliceAudit = await auditQueryRes.json();
  assert.ok(aliceAudit.audit.length > 0);
  for (const entry of aliceAudit.audit) {
    assert.equal(entry.actor, "operator-alice");
  }

  // 3. Query all recent audit logs via GET /hub/audit
  const allAuditRes = await fetch(`${baseUrl}/hub/audit`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: sessionAlice.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(allAuditRes.status, 200);
  const allAudit = await allAuditRes.json();
  assert.ok(allAudit.audit.length >= 4); // sessions + jobs
});
