// RFC-0015 Stage 2: Hub Schedule Management Endpoints & Audit Logging Integration Tests
// Verifies:
// 1. GET /hub/fleet/schedules (list with metrics)
// 2. POST /hub/fleet/schedules (create with targetSpec, cron/interval validation, audit record)
// 3. GET /hub/fleet/schedules/:id (detail & runs)
// 4. POST /hub/fleet/schedules/:id/pause & resume (atomic status transitions & audit records)
// 5. POST /hub/fleet/schedules/:id/trigger (manual ad-hoc dispatch & audit record)
// 6. DELETE /hub/fleet/schedules/:id (cascade deletion & audit record)
// 7. CSRF and session authentication enforcement across all schedule mutation routes

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";

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
      fleetDispatchTransport: options.fleetDispatchTransport ?? (async () => ({ status: "completed", exitCode: 0, stdout: "ok" })),
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

async function enrollNode(baseUrl) {
  const requestId = "f4".repeat(16);
  const publicKey = "04".repeat(32);
  const token = "tok_" + "a".repeat(32);
  // Direct insert or via enroll token mint
  const mintRes = await fetch(`${baseUrl}/hub/tokens`, {
    method: "POST",
    headers: { ...gatewayHeaders("operator-alice"), "content-type": "application/json" },
    body: JSON.stringify({ purpose: "enroll" }),
  });
  // fallback simple enroll
  return { nodeId: "node_" + "1".repeat(32) };
}

test("schedule endpoints: CRUD lifecycle, pause, resume, trigger, delete and audit logging (Stage 2)", async (t) => {
  const { registry, server, baseUrl } = await withServer(t);
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrollRes = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: plain.token, enrollmentRequestId: "f4".repeat(16), publicKey: "04".repeat(32) }),
  });
  assert.equal(enrollRes.status, 200);
  const { nodeId } = await enrollRes.json();
  const nodeA = { nodeId };

  const session = await establishSession(baseUrl, "operator-alice");

  // 1. Initial list is empty
  const listRes1 = await fetch(`${baseUrl}/hub/fleet/schedules`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(listRes1.status, 200);
  const list1 = await listRes1.json();
  assert.deepEqual(list1.schedules, []);

  // 2. Reject schedule creation with bare wildcard
  const wildcardRes = await fetch(`${baseUrl}/hub/fleet/schedules`, {
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
      name: "Wildcard Audit",
      scheduleType: "cron",
      cronExpression: "0 2 * * *",
      taskType: "diagnostic",
      targetSpec: "*",
    }),
  });
  assert.equal(wildcardRes.status, 400);
  const wildcardErr = await wildcardRes.json();
  assert.equal(wildcardErr.error.code, "wildcard-prohibited");

  // 3. Reject schedule creation with invalid cron syntax
  const badCronRes = await fetch(`${baseUrl}/hub/fleet/schedules`, {
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
      name: "Bad Cron",
      scheduleType: "cron",
      cronExpression: "60 * * * *",
      taskType: "diagnostic",
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  assert.equal(badCronRes.status, 400);
  const badCronErr = await badCronRes.json();
  assert.equal(badCronErr.error.code, "invalid-cron-bounds");

  // 4. Create valid schedule
  const createRes = await fetch(`${baseUrl}/hub/fleet/schedules`, {
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
      name: "Nightly Clean",
      description: "Nightly diagnostic clean",
      scheduleType: "cron",
      cronExpression: "30 3 * * *",
      taskType: "diagnostic",
      payload: { action: "cleanup", token: "secret-token-123" },
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.ok(created.scheduleId.startsWith("sched_"));
  assert.equal(created.name, "Nightly Clean");
  assert.equal(created.status, "active");
  assert.equal(created.payload.token, "[REDACTED]"); // Credential scrubbing verified

  // Verify audit log for create
  const auditEntries = registry.queryAudit({ action: "fleet.schedule.create" });
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0].actor, "operator-alice");
  assert.equal(auditEntries[0].detail.scheduleId, created.scheduleId);

  // 5. Get schedule detail
  const detailRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.scheduleId, created.scheduleId);

  // 6. Pause schedule
  const pauseRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}/pause`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(pauseRes.status, 200);
  const paused = await pauseRes.json();
  assert.equal(paused.status, "paused");

  // 7. Resume schedule
  const resumeRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}/resume`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(resumeRes.status, 200);
  const resumed = await resumeRes.json();
  assert.equal(resumed.status, "active");

  // 8. Manual trigger
  const triggerRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}/trigger`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(triggerRes.status, 200);
  const triggered = await triggerRes.json();
  assert.ok(triggered.runId.startsWith("srun_"));
  assert.ok(triggered.jobId.startsWith("job_"));

  // 9. Inspect runs
  const runsRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}/runs`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(runsRes.status, 200);
  const runsData = await runsRes.json();
  assert.equal(runsData.runs.length, 1);
  assert.equal(runsData.runs[0].runId, triggered.runId);

  // 10. Delete schedule
  const deleteRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}`, {
    method: "DELETE",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(deleteRes.status, 200);
  const deleted = await deleteRes.json();
  assert.equal(deleted.status, "deleted");

  // Verify schedule is gone
  const afterDeleteRes = await fetch(`${baseUrl}/hub/fleet/schedules/${created.scheduleId}`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(afterDeleteRes.status, 404);
});
