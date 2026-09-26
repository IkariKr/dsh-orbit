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

test("audit endpoints redact sensitive session tokens and prevent cross-principal session hijack (P0)", async (t) => {
  const { server } = await withServer(t);
  const baseUrl = server.baseUrl;

  const sessionAlice = await establishSession(baseUrl, "operator-alice");
  const sessionBob = await establishSession(baseUrl, "operator-bob");

  // Bob queries audit logs
  const auditRes = await fetch(`${baseUrl}/hub/audit`, {
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie: sessionBob.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  assert.ok(auditData.audit.length > 0);

  // All session IDs, tokens, secrets must be redacted
  for (const entry of auditData.audit) {
    if (entry.detail) {
      if ("sessionId" in entry.detail) {
        assert.equal(entry.detail.sessionId, "[REDACTED]");
      }
      if ("session_id" in entry.detail) {
        assert.equal(entry.detail.session_id, "[REDACTED]");
      }
      if ("csrfToken" in entry.detail) {
        assert.equal(entry.detail.csrfToken, "[REDACTED]");
      }
    }
  }

  // If Bob attempts to use Alice's session cookie under Bob's admitted identity, reject with 403
  const hijackAttempt = await fetch(`${baseUrl}/hub/session`, {
    headers: {
      ...gatewayHeaders("operator-bob"),
      cookie: sessionAlice.cookie, // Alice's cookie
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(hijackAttempt.status, 403);
  const hijackBody = await hijackAttempt.json();
  assert.equal(hijackBody.error.code, "principal-mismatch");
});

test("fleet job payload and node output credential scrubbing (P1)", async (t) => {
  const { registry, server } = await withServer(t, {
    fleetDispatchTransport: async () => ({
      status: "completed",
      exitCode: 0,
      stdout:
        "starting\nkey=SECRETKEYVAL\nKEY: secretval2\nauthorization=xyzsecret\nAuthorization: token test_ghp_tok\nAuthorization: ApiKey sk-test-key\nAuthorization: secret123\nDB_PASSWORD=pw123\nGITHUB_TOKEN=ghp_abc\nACCESS_TOKEN=xyz\nAPI_TOKEN=abc123def\nAuthorization: Basic dXNlcjpwdw==\nfinished\nbasic authentication failed for user johnsmith\nbypass=1\ncompass=1",
      stderr: "token=test-zzz999\nclient_secret=test-s3cr3t\ncurl -u user:mypassword https://api.example.com\nKEY=anothersecret",
    }),
  });
  const baseUrl = server.baseUrl;

  const nodeA = await enrollNode(baseUrl, registry);
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
      payload: {
        apiKey: "sk-live-SUPERSECRET123",
        password: "hunter2password",
        secretConfig: "confidential",
        regularField: "hello-world",
        envLine: "API_TOKEN=abc123def",
        dbLine: "DB_PASSWORD=pw123",
        ghLine: "GITHUB_TOKEN=\"ghp_abc\"",
        awsLine: "AWS_SECRET_ACCESS_KEY='secret_key_abc'",
        clientLine: "client_secret=s3cr3t",
        authHeader: "Bearer eyJhbGciOi...",
        rawHeader: "Authorization: Basic dXNlcjpwdw==",
        curlCmd: "curl -u admin:mypassword https://internal",
        note: "password=hunter2",
        url: "postgres://user:pw@host/db",
        sessionId: "sess_abcdef0123456789abcdef0123456789",
        key: "K",
        auth: "A",
        "x-api-key": "X",
        credential: "C",
        keyLine: "key=SECRETKEYVAL",
        keyColon: "key: SECRETKEYVAL",
        keyLower: "key=val",
        customAuthSetting: "authorization=xyzsecret",
        customScheme1: "Authorization: token test_ghp_tok",
        customScheme2: "Authorization: ApiKey sk-test-key",
        customScheme3: "Authorization: secret123",
        authEq: "authorization=xyzsecret",
        sessionKey: "session_key_val",
        sessionValue: "session_val",
        sessionData: "session_dat",
        sessionBlob: "session_blb",
        sessionNonce: "session_nnc",
        bypassField: "bypass=1",
        compassField: "compass=1",
        basicLog: "basic authentication failed for user johnsmith",
        monkey: "banana",
        keyId: "key_123456",
        author: "alice",
        routeAuthority: "n-nodeA.example",
        sessionCount: 2,
      },
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  assert.equal(submitRes.status, 201);
  const submitted = await submitRes.json();
  assert.equal(submitted.payload.apiKey, "[REDACTED]");
  assert.equal(submitted.payload.password, "[REDACTED]");
  assert.equal(submitted.payload.secretConfig, "[REDACTED]");
  assert.equal(submitted.payload.regularField, "hello-world");
  assert.equal(submitted.payload.envLine, "API_TOKEN=[REDACTED]");
  assert.equal(submitted.payload.dbLine, "DB_PASSWORD=[REDACTED]");
  assert.equal(submitted.payload.ghLine, "GITHUB_TOKEN=[REDACTED]");
  assert.equal(submitted.payload.awsLine, "AWS_SECRET_ACCESS_KEY=[REDACTED]");
  assert.equal(submitted.payload.clientLine, "client_secret=[REDACTED]");
  assert.equal(submitted.payload.authHeader, "[REDACTED]");
  assert.equal(submitted.payload.rawHeader, "Authorization: Basic [REDACTED_AUTH]");
  assert.equal(submitted.payload.curlCmd, "curl -u admin:[REDACTED] https://internal");
  assert.equal(submitted.payload.note, "password=[REDACTED]");
  assert.equal(submitted.payload.url, "postgres://user:[REDACTED]@host/db");
  assert.equal(submitted.payload.sessionId, "[REDACTED]");
  assert.equal(submitted.payload.key, "[REDACTED]");
  assert.equal(submitted.payload.auth, "[REDACTED]");
  assert.equal(submitted.payload["x-api-key"], "[REDACTED]");
  assert.equal(submitted.payload.credential, "[REDACTED]");
  assert.equal(submitted.payload.keyLine, "key=[REDACTED]");
  assert.equal(submitted.payload.keyColon, "key: [REDACTED]");
  assert.equal(submitted.payload.keyLower, "key=[REDACTED]");
  assert.equal(submitted.payload.customAuthSetting, "authorization=[REDACTED]");
  assert.equal(submitted.payload.customScheme1, "Authorization: [REDACTED]");
  assert.equal(submitted.payload.customScheme2, "Authorization: [REDACTED]");
  assert.equal(submitted.payload.customScheme3, "Authorization: [REDACTED]");
  assert.equal(submitted.payload.authEq, "[REDACTED]");
  assert.equal(submitted.payload.sessionKey, "[REDACTED]");
  assert.equal(submitted.payload.sessionValue, "[REDACTED]");
  assert.equal(submitted.payload.sessionData, "[REDACTED]");
  assert.equal(submitted.payload.sessionBlob, "[REDACTED]");
  assert.equal(submitted.payload.sessionNonce, "[REDACTED]");
  assert.equal(submitted.payload.bypassField, "bypass=1");
  assert.equal(submitted.payload.compassField, "compass=1");
  assert.equal(submitted.payload.basicLog, "basic authentication failed for user johnsmith");
  assert.equal(submitted.payload.monkey, "banana");
  assert.equal(submitted.payload.keyId, "key_123456");
  assert.equal(submitted.payload.author, "alice");
  assert.equal(submitted.payload.routeAuthority, "n-nodeA.example");
  assert.equal(submitted.payload.sessionCount, 2);

  // Wait for settlement
  await server.fleetScheduler.jobs.get(submitted.jobId)._executionPromise;

  // Verify via GET /hub/fleet/jobs/:jobId by operator-bob
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
  const getBody = await getRes.json();
  assert.equal(getBody.payload.apiKey, "[REDACTED]");
  assert.equal(getBody.payload.password, "[REDACTED]");
  assert.equal(getBody.payload.envLine, "API_TOKEN=[REDACTED]");
  assert.equal(getBody.payload.dbLine, "DB_PASSWORD=[REDACTED]");
  assert.equal(getBody.payload.keyLine, "key=[REDACTED]");
  assert.equal(getBody.payload.keyColon, "key: [REDACTED]");
  assert.equal(getBody.payload.keyLower, "key=[REDACTED]");
  assert.equal(getBody.payload.customAuthSetting, "authorization=[REDACTED]");
  assert.equal(getBody.payload.customScheme1, "Authorization: [REDACTED]");
  assert.equal(getBody.payload.customScheme2, "Authorization: [REDACTED]");
  assert.equal(getBody.payload.customScheme3, "Authorization: [REDACTED]");
  assert.equal(getBody.payload.authEq, "[REDACTED]");
  assert.equal(getBody.payload.sessionKey, "[REDACTED]");
  assert.equal(getBody.payload.sessionValue, "[REDACTED]");
  assert.equal(getBody.payload.sessionData, "[REDACTED]");
  assert.equal(getBody.payload.sessionBlob, "[REDACTED]");
  assert.equal(getBody.payload.sessionNonce, "[REDACTED]");
  assert.equal(getBody.payload.bypassField, "bypass=1");
  assert.equal(getBody.payload.compassField, "compass=1");
  assert.equal(getBody.payload.basicLog, "basic authentication failed for user johnsmith");
  assert.equal(getBody.payload.monkey, "banana");
  assert.equal(getBody.payload.keyId, "key_123456");
  assert.equal(getBody.payload.author, "alice");
  assert.equal(getBody.payload.routeAuthority, "n-nodeA.example");
  assert.equal(getBody.payload.sessionCount, 2);

  // Output logs (stdout/stderr) scrubbing verification
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("DB_PASSWORD=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("GITHUB_TOKEN=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("ACCESS_TOKEN=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("API_TOKEN=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("Authorization: Basic [REDACTED_AUTH]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("key=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("KEY: [REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("authorization=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("Authorization: [REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("basic authentication failed for user johnsmith"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("bypass=1"));
  assert.ok(getBody.results[nodeA.nodeId].stdout.includes("compass=1"));
  assert.ok(getBody.results[nodeA.nodeId].stderr.includes("token=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stderr.includes("client_secret=[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stderr.includes("curl -u user:[REDACTED]"));
  assert.ok(getBody.results[nodeA.nodeId].stderr.includes("KEY=[REDACTED]"));
});

test("audit detail redacts arrays and non-fleet URLs reject malformed percent encoding with 400 (P3)", async (t) => {
  const { registry, server } = await withServer(t);
  const baseUrl = server.baseUrl;
  const session = await establishSession(baseUrl, "operator-alice");

  // Record audit entry with nested array of credential objects
  registry.recordAudit("operator-alice", "custom.action", {
    items: [{ token: "LEAK-TOKEN" }, { secret: "LEAK-SECRET" }],
    nested: { arr: [{ password: "LEAK-PW" }] },
    benign: { monkey: "hockey", keyId: "kid123", author: "alice", routeAuthority: "n-node.orbit.internal", sessionCount: 3 },
  });

  const auditRes = await fetch(`${baseUrl}/hub/audit`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  const auditData = await auditRes.json();
  const customEntry = auditData.audit.find((e) => e.action === "custom.action");
  assert.ok(customEntry);
  assert.equal(customEntry.detail.items[0].token, "[REDACTED]");
  assert.equal(customEntry.detail.items[1].secret, "[REDACTED]");
  assert.equal(customEntry.detail.nested.arr[0].password, "[REDACTED]");
  assert.equal(customEntry.detail.benign.monkey, "hockey");
  assert.equal(customEntry.detail.benign.keyId, "kid123");
  assert.equal(customEntry.detail.benign.author, "alice");
  assert.equal(customEntry.detail.benign.routeAuthority, "n-node.orbit.internal");
  assert.equal(customEntry.detail.benign.sessionCount, 3);

  // Non-fleet routes with %ZZ malformed percent encoding return 400 bad-request, never 500
  const malformedRoutes = [
    { method: "GET", path: "/hub/nodes/%ZZ" },
    { method: "GET", path: "/hub/nodes/%ZZ/route-target" },
    { method: "PUT", path: "/hub/nodes/%ZZ/route-mode", body: { routeMode: "direct" } },
    { method: "PUT", path: "/hub/nodes/%ZZ/route-target", body: { routeTarget: "http://127.0.0.1:8080" } },
    { method: "POST", path: "/hub/nodes/%ZZ/delete", body: { requestId: "req123" } },
    { method: "POST", path: "/hub/nodes/%ZZ/reenroll", body: {} },
  ];

  for (const r of malformedRoutes) {
    const res = await fetch(`${baseUrl}${r.path}`, {
      method: r.method,
      headers: {
        ...gatewayHeaders("operator-alice"),
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        ...(r.body ? { "content-type": "application/json" } : {}),
      },
      ...(r.body ? { body: JSON.stringify(r.body) } : {}),
    });
    assert.equal(res.status, 400, `expected 400 on ${r.method} ${r.path}, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error.code, "bad-request");
  }
});

test("malformed audit query returns 400 bad-request, never 500 (P2)", async (t) => {
  const { server } = await withServer(t);
  const baseUrl = server.baseUrl;
  const session = await establishSession(baseUrl, "operator-alice");

  const malformedQueries = [
    { jobId: {} },
    { jobId: ["array"] },
    { action: {} },
    { since: 123 },
    { until: [] },
    { limit: 10.5 },
    { limit: -5 },
  ];

  for (const badQuery of malformedQueries) {
    const res = await fetch(`${baseUrl}/hub/audit/query`, {
      method: "POST",
      headers: {
        ...gatewayHeaders("operator-alice"),
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(badQuery),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "bad-request");
  }
});

test("cancel on terminal job returns 409 conflict, and replay of duplicate jobId avoids duplicate create audit (P2)", async (t) => {
  const { registry, server } = await withServer(t);
  const baseUrl = server.baseUrl;

  const nodeA = await enrollNode(baseUrl, registry);
  const session = await establishSession(baseUrl, "operator-alice");

  const fixedJobId = "job_11112222333344445555666677778888";

  // First submit
  const res1 = await fetch(`${baseUrl}/hub/fleet/jobs`, {
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
      jobId: fixedJobId,
      taskType: "diagnostic",
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  assert.equal(res1.status, 201);

  // Wait for settlement
  await server.fleetScheduler.jobs.get(fixedJobId)._executionPromise;

  // Re-submit identical jobId (replay): returns 200, does not duplicate create audit
  const res2 = await fetch(`${baseUrl}/hub/fleet/jobs`, {
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
      jobId: fixedJobId,
      taskType: "diagnostic",
      targetSpec: { mode: "explicit", nodeIds: [nodeA.nodeId] },
    }),
  });
  assert.equal(res2.status, 200);

  // Audit query: exactly 1 create audit row exists
  const auditRes = await fetch(`${baseUrl}/hub/fleet/jobs/${fixedJobId}/audit`, {
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  const creates = auditData.audit.filter((a) => a.action === "fleet.job.create");
  assert.equal(creates.length, 1);

  // Attempt cancel on already-terminal job -> 409 conflict
  const cancelRes = await fetch(`${baseUrl}/hub/fleet/jobs/${fixedJobId}/cancel`, {
    method: "POST",
    headers: {
      ...gatewayHeaders("operator-alice"),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(cancelRes.status, 409);
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.error.code, "job-already-terminal");
  assert.equal(cancelBody.status, "completed");
});
