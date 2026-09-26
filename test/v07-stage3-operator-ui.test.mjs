// RFC-0014 M28 Acceptance Matrix Field 10: operatorUiFleetWorkflowsView (Stage 3).
// Tests operator UI Fleet Workflows view, job trigger dialog, progress indicators,
// aggregated summary view, and detail inspect / cancel flows.

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { createRegistryUi } from "../ui/app.mjs";
import {
  EMPTY_FLEET_JOBS_STATE,
  mapFleetJobRow,
  mapFleetJobList,
  mapFleetJobDetail,
} from "../ui/view-model.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";

const ELEMENT_IDS = [
  "session-status",
  "nav-nodes",
  "nav-tokens",
  "nav-fleet",
  "nav-logout",
  "state-banner",
  "nodes-list",
  "reenroll-result",
  "node-detail-view",
  "tokens-view",
  "nodes-view",
  "fleet-view",
  "fleet-jobs-list",
  "fleet-job-detail-view",
  "trigger-fleet-job-btn",
  "refresh-fleet-jobs-btn",
  "fleet-job-dialog",
  "fleet-job-task-type",
  "fleet-job-target-mode",
  "fleet-job-explicit-group",
  "fleet-job-target-nodes",
  "fleet-job-capability-group",
  "fleet-job-target-capability",
  "fleet-job-timeout",
  "fleet-job-payload",
  "fleet-job-error",
  "fleet-job-cancel",
  "fleet-job-submit",
  "mint-token",
  "mint-result",
  "mint-pair-token",
  "pair-mint-result",
  "token-table-body",
  "confirm-dialog",
  "confirm-dialog-message",
  "confirm-reason",
  "confirm-cancel",
  "confirm-ok",
  "route-target-input",
  "route-target-error",
  "route-mode-input",
];

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.dataset = {};
    this.listeners = {};
    this.opened = false;
    this.style = {};
    this.classList = {
      names: new Set(),
      add: (name) => this.classList.names.add(name),
      remove: (name) => this.classList.names.delete(name),
      contains: (name) => this.classList.names.has(name),
    };
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  showModal() {
    this.opened = true;
  }
  close() {
    this.opened = false;
  }
  closest(selector) {
    if (selector === ".job-id" && this.classList.contains("job-id")) {
      return this;
    }
    return null;
  }
}

class FakeDom {
  constructor() {
    this.elements = new Map(ELEMENT_IDS.map((id) => [id, new FakeElement(id)]));
  }
  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

function browserFetch(baseUrl, operator = "operator-alice") {
  let cookie = "";
  return async (path, options) => {
    const headers = { ...(options?.headers ?? {}) };
    if (cookie !== "") headers.cookie = cookie;
    if ((options?.method ?? "GET") === "POST") {
      headers.origin = baseUrl;
      headers["sec-fetch-site"] = "same-origin";
    }
    headers[GATEWAY_HEADER] = ASSERTION;
    headers[PRINCIPAL_HEADER] = operator;
    const response = await fetch(baseUrl + path, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body,
    });
    const setCookie = response.headers.get("set-cookie");
    if (typeof setCookie === "string" && setCookie !== "") {
      cookie = setCookie.split(";")[0];
    }
    return response;
  };
}

async function withHub(t, options = {}) {
  const registry = new Registry({ db: openRegistryDatabase(":memory:") });
  const { server } = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: ASSERTION,
      operatorPrincipal: { mode: "inject" },
      fleetDispatchTransport: options.fleetDispatchTransport ?? (async () => ({
        status: "completed",
        exitCode: 0,
        stdout: "diag: ok\nall services nominal",
        stderr: "",
      })),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });
  return { registry, server, baseUrl };
}

async function enrollRawNode(baseUrl, registry) {
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const response = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: plain.token,
      enrollmentRequestId: "aa".repeat(16),
      publicKey: "01".repeat(32),
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).nodeId;
}

async function click(element, eventData = {}) {
  const fn = element.listeners.click;
  if (fn) await fn({ target: element, ...eventData });
}

// -----------------------------------------------------------------------------
// View-Model Unit Tests
// -----------------------------------------------------------------------------

test("view-model: mapFleetJobRow computes progress percentage and maps all metrics accurately", () => {
  const job = {
    jobId: "job_12345678",
    taskType: "diagnostic",
    state: "running",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:01.000Z",
    startedAt: "2026-09-26T00:00:00.500Z",
    completedAt: null,
    summary: {
      totalTargets: 10,
      completed: 4,
      failed: 1,
      timeout: 1,
      unreachable: 1,
      skipped: 1,
      pending: 1,
      running: 1,
    },
    targetSpec: { mode: "explicit", nodeIds: ["node_1"] },
  };

  const row = mapFleetJobRow(job);
  assert.equal(row.jobId, "job_12345678");
  assert.equal(row.taskType, "diagnostic");
  assert.equal(row.state, "running");
  assert.equal(row.totalTargets, 10);
  assert.equal(row.completed, 4);
  assert.equal(row.failed, 1);
  assert.equal(row.timeout, 1);
  assert.equal(row.unreachable, 1);
  assert.equal(row.skipped, 1);
  assert.equal(row.settled, 8); // 4 + 1 + 1 + 1 + 1 = 8
  assert.equal(row.progressPercent, 80); // 8 / 10 = 80%

  // Edge cases
  assert.equal(mapFleetJobRow({ summary: { totalTargets: 0 }, state: "completed" }).progressPercent, 100);
  assert.equal(mapFleetJobRow({ summary: { totalTargets: 0 }, state: "pending" }).progressPercent, 0);
  assert.equal(mapFleetJobRow(null).jobId, null);
});

test("view-model: mapFleetJobList handles empty, malformed, and populated lists", () => {
  assert.deepEqual(mapFleetJobList([]), EMPTY_FLEET_JOBS_STATE);
  assert.deepEqual(mapFleetJobList(null), EMPTY_FLEET_JOBS_STATE);
  assert.deepEqual(mapFleetJobList("not-array"), EMPTY_FLEET_JOBS_STATE);

  const populated = mapFleetJobList([
    { jobId: "j1", taskType: "diagnostic", summary: { totalTargets: 2, completed: 2 } },
    { jobId: "j2", taskType: "maintenance", summary: { totalTargets: 5, completed: 1 } },
  ]);
  assert.equal(populated.kind, "fleet-jobs");
  assert.equal(populated.totalJobs, 2);
  assert.equal(populated.rows.length, 2);
  assert.equal(populated.rows[0].jobId, "j1");
  assert.equal(populated.rows[0].progressPercent, 100);
  assert.equal(populated.rows[1].jobId, "j2");
  assert.equal(populated.rows[1].progressPercent, 20);
});

test("view-model: mapFleetJobDetail maps results dictionary into structured array with logs and metrics", () => {
  const detail = mapFleetJobDetail({
    jobId: "job_xyz",
    taskType: "diagnostic",
    state: "partial",
    payload: { action: "ping" },
    timeoutMs: 15000,
    summary: { totalTargets: 2, completed: 1, failed: 1 },
    results: {
      node_alpha: {
        status: "completed",
        exitCode: 0,
        durationMs: 42,
        stdout: "ok",
        stderr: "",
      },
      node_beta: {
        status: "failed",
        exitCode: 1,
        durationMs: 99,
        stdout: "",
        stderr: "connection reset",
        error: "ECONNRESET",
      },
    },
  });

  assert.equal(detail.jobId, "job_xyz");
  assert.equal(detail.state, "partial");
  assert.deepEqual(detail.payload, { action: "ping" });
  assert.equal(detail.timeoutMs, 15000);
  assert.equal(detail.nodeResults.length, 2);

  const alpha = detail.nodeResults.find((r) => r.nodeId === "node_alpha");
  assert.ok(alpha);
  assert.equal(alpha.status, "completed");
  assert.equal(alpha.exitCode, 0);
  assert.equal(alpha.durationMs, 42);
  assert.equal(alpha.stdout, "ok");

  const beta = detail.nodeResults.find((r) => r.nodeId === "node_beta");
  assert.ok(beta);
  assert.equal(beta.status, "failed");
  assert.equal(beta.exitCode, 1);
  assert.equal(beta.stderr, "connection reset");
  assert.equal(beta.error, "ECONNRESET");
});

// -----------------------------------------------------------------------------
// DOM & Application Integration Tests (M28 Field 10)
// -----------------------------------------------------------------------------

test("app-level: operator surface displays Fleet Workflows view and job triggers (field 10)", async (t) => {
  const { registry, server, baseUrl } = await withHub(t);
  const dom = new FakeDom();
  const fetchImpl = browserFetch(baseUrl, "operator-alice");
  const ui = createRegistryUi({ document: dom, fetchImpl });
  await ui.start();

  // Verify session connected
  assert.equal(dom.getElementById("session-status").textContent, "operator: operator-alice");

  // Enroll two test nodes
  const nodeA = await enrollRawNode(baseUrl, registry);
  const nodeB = await enrollRawNode(baseUrl, registry);

  // 1. Navigate to Fleet Workflows view
  const navFleet = dom.getElementById("nav-fleet");
  await click(navFleet);

  assert.ok(navFleet.classList.contains("active"));
  assert.ok(!dom.getElementById("nav-nodes").classList.contains("active"));
  assert.equal(dom.getElementById("nodes-view").hidden, true);
  assert.equal(dom.getElementById("fleet-view").hidden, false);
  assert.equal(dom.getElementById("fleet-jobs-list").hidden, false);

  // Initially empty
  assert.ok(dom.getElementById("fleet-jobs-list").innerHTML.includes("no fleet jobs submitted yet"));

  // 2. Open Trigger Fleet Job dialog
  const triggerBtn = dom.getElementById("trigger-fleet-job-btn");
  await click(triggerBtn);

  const dialog = dom.getElementById("fleet-job-dialog");
  assert.equal(dialog.opened, true);

  // 3. Test Form Validation: Explicit mode with empty node list
  dom.getElementById("fleet-job-task-type").value = "diagnostic";
  dom.getElementById("fleet-job-target-mode").value = "explicit";
  dom.getElementById("fleet-job-target-nodes").value = "";
  const submitBtn = dom.getElementById("fleet-job-submit");
  await click(submitBtn);

  const errorEl = dom.getElementById("fleet-job-error");
  assert.equal(errorEl.style.display, "block");
  assert.ok(errorEl.textContent.includes("explicit mode requires at least one node ID"));
  assert.equal(dialog.opened, true); // Still open

  // 4. Test Form Validation: Invalid JSON payload
  dom.getElementById("fleet-job-target-nodes").value = `${nodeA}, ${nodeB}`;
  dom.getElementById("fleet-job-payload").value = "{ invalid json !!! }";
  await click(submitBtn);
  assert.ok(errorEl.textContent.includes("invalid JSON payload"));
  assert.equal(dialog.opened, true);

  // 5. Submit valid Fleet Job
  dom.getElementById("fleet-job-payload").value = JSON.stringify({ check: "system-health" });
  await click(submitBtn);

  assert.equal(dialog.opened, false);
  assert.ok(dom.getElementById("state-banner").innerHTML.includes("submitted"));

  // Wait for fleet execution to settle on the server
  const jobs = Array.from(server.fleetScheduler.jobs.values());
  assert.equal(jobs.length, 1);
  await jobs[0]._executionPromise;

  // Refresh fleet jobs list
  const refreshBtn = dom.getElementById("refresh-fleet-jobs-btn");
  await click(refreshBtn);

  const jobsListHtml = dom.getElementById("fleet-jobs-list").innerHTML;
  assert.ok(jobsListHtml.includes(jobs[0].jobId));
  assert.ok(jobsListHtml.includes("diagnostic"));
  assert.ok(jobsListHtml.includes("completed"));
  assert.ok(jobsListHtml.includes("100%"));

  // 6. View Fleet Job Details
  const jobsListEl = dom.getElementById("fleet-jobs-list");
  // Simulate clicking on the "view details" button
  await jobsListEl.listeners.click({
    target: { dataset: { viewJobId: jobs[0].jobId } },
  });

  assert.equal(dom.getElementById("fleet-jobs-list").hidden, true);
  const detailViewEl = dom.getElementById("fleet-job-detail-view");
  assert.equal(detailViewEl.hidden, false);
  assert.ok(detailViewEl.innerHTML.includes(`Fleet Job: ${jobs[0].jobId}`));
  assert.ok(detailViewEl.innerHTML.includes("diag: ok"));
  assert.ok(detailViewEl.innerHTML.includes("all services nominal"));
  assert.ok(detailViewEl.innerHTML.includes(nodeA));
  assert.ok(detailViewEl.innerHTML.includes(nodeB));

  // 7. Back button navigation from detail view
  await detailViewEl.listeners.click({
    target: { id: "back-to-fleet-jobs" },
  });

  assert.equal(dom.getElementById("fleet-job-detail-view").hidden, true);
  assert.equal(dom.getElementById("fleet-jobs-list").hidden, false);
});

test("app-level: job cancellation via UI invokes cancellation endpoint and updates view", async (t) => {
  let finishTask = null;
  const taskPromise = new Promise((resolve) => {
    finishTask = resolve;
  });

  const { registry, server, baseUrl } = await withHub(t, {
    fleetDispatchTransport: async (_nodeId, { signal }) => {
      signal?.addEventListener("abort", () => {
        setImmediate(() => finishTask({ status: "failed", error: "aborted" }));
      });
      return await taskPromise;
    },
  });

  const nodeA = await enrollRawNode(baseUrl, registry);

  const dom = new FakeDom();
  const fetchImpl = browserFetch(baseUrl, "operator-alice");
  const ui = createRegistryUi({ document: dom, fetchImpl });
  await ui.start();

  // Trigger an in-flight job via UI
  await click(dom.getElementById("nav-fleet"));
  await click(dom.getElementById("trigger-fleet-job-btn"));
  dom.getElementById("fleet-job-task-type").value = "diagnostic";
  dom.getElementById("fleet-job-target-mode").value = "explicit";
  dom.getElementById("fleet-job-target-nodes").value = nodeA;
  dom.getElementById("fleet-job-timeout").value = "60000";
  await click(dom.getElementById("fleet-job-submit"));

  const jobs = Array.from(server.fleetScheduler.jobs.values());
  assert.equal(jobs.length, 1);
  const jobId = jobs[0].jobId;
  assert.ok(dom.getElementById("fleet-jobs-list").innerHTML.includes(jobId));

  // Cancel job via list button
  const jobsListEl = dom.getElementById("fleet-jobs-list");
  await jobsListEl.listeners.click({
    target: { dataset: { cancelJobId: jobId } },
  });

  assert.ok(dom.getElementById("state-banner").innerHTML.includes("cancellation requested"));
  assert.equal(server.fleetScheduler.jobs.get(jobId).status, "failed");

  // Unblock hung dispatch transport
  finishTask?.({ status: "failed", error: "aborted" });
});
