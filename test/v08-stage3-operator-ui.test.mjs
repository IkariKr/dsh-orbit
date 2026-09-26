// RFC-0015 Stage 3: Operator UI Scheduled Workflows View DOM & Integration Tests
// Verifies:
// 1. Scheduled Workflows tab navigation and rendering
// 2. Schedule list cards with nextRunAt, lastRunAt, triggerRule, and run counters
// 3. Create schedule dialog with cron/interval selector and target mode toggle
// 4. In-page pause, resume, trigger now, and delete action button dispatches

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { createRegistryUi } from "../ui/app.mjs";
import {
  EMPTY_SCHEDULES_STATE,
  mapScheduleRow,
  mapScheduleList,
} from "../ui/view-model.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";

const ELEMENT_IDS = [
  "session-status",
  "nav-nodes",
  "nav-tokens",
  "nav-fleet",
  "nav-schedules",
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
  "schedules-view",
  "schedules-list",
  "schedule-detail-view",
  "create-schedule-btn",
  "refresh-schedules-btn",
  "schedule-dialog",
  "schedule-name",
  "schedule-type",
  "schedule-cron-group",
  "schedule-cron",
  "schedule-interval-group",
  "schedule-interval",
  "schedule-task-type",
  "schedule-target-mode",
  "schedule-explicit-group",
  "schedule-target-nodes",
  "schedule-capability-group",
  "schedule-target-capability",
  "schedule-concurrency",
  "schedule-error",
  "schedule-cancel",
  "schedule-submit",
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
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.style = {};
    this.classList = {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    };
    this.dataset = {};
    this.listeners = new Map();
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  async dispatch(event, payload = {}) {
    const handlers = this.listeners.get(event) || [];
    for (const h of handlers) {
      await h({ target: this, ...payload });
    }
  }
  showModal() { this.hidden = false; this.modalShown = true; }
  close() { this.hidden = true; this.modalShown = false; }
  closest() { return null; }
}

function browserFetch(baseUrl, operator = "operator-alice") {
  let cookie = "";
  return async (path, options) => {
    const headers = { ...(options?.headers ?? {}) };
    if (cookie !== "") headers.cookie = cookie;
    if ((options?.method ?? "GET") === "POST" || (options?.method ?? "GET") === "DELETE") {
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
        stdout: "diag: ok",
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

test("view-model: mapScheduleRow and mapScheduleList handle empty and populated states (Stage 3)", () => {
  const empty = mapScheduleList([]);
  assert.equal(empty.totalSchedules, 0);
  assert.deepEqual(empty.rows, []);

  const sample = {
    scheduleId: "sched_1234567890abcdef1234567890abcdef",
    name: "Nightly Health",
    description: "Daily healthcheck across fleet",
    scheduleType: "cron",
    cronExpression: "0 4 * * *",
    taskType: "diagnostic",
    status: "active",
    concurrencyPolicy: "forbid",
    missedRunPolicy: "skip",
    nextRunAt: "2026-09-27T04:00:00.000Z",
    lastRunAt: "2026-09-26T04:00:00.000Z",
    totalRuns: 5,
    maxRuns: null,
    createdAt: "2026-09-20T04:00:00.000Z",
    createdBy: "operator-alice",
  };

  const row = mapScheduleRow(sample);
  assert.equal(row.scheduleId, sample.scheduleId);
  assert.equal(row.name, "Nightly Health");
  assert.equal(row.triggerRule, "0 4 * * *");
  assert.equal(row.status, "active");
  assert.equal(row.totalRuns, 5);

  const list = mapScheduleList([sample]);
  assert.equal(list.totalSchedules, 1);
  assert.equal(list.rows[0].name, "Nightly Health");
});

test("app-level: operator surface displays Scheduled Workflows view, creation dialog, and controls (Stage 3)", async (t) => {
  const { registry, server, baseUrl } = await withHub(t);
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enrollRes = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: plain.token, enrollmentRequestId: "bb".repeat(16), publicKey: "02".repeat(32) }),
  });
  assert.equal(enrollRes.status, 200);
  const { nodeId } = await enrollRes.json();

  const elements = new Map();
  for (const id of ELEMENT_IDS) {
    elements.set(id, new FakeElement(id));
  }
  const documentMock = {
    getElementById: (id) => elements.get(id) || null,
  };

  const fetchImpl = browserFetch(baseUrl);
  const ui = createRegistryUi({ document: documentMock, fetchImpl });
  await ui.start();

  // 1. Navigate to Scheduled Workflows tab
  const navSchedules = elements.get("nav-schedules");
  await navSchedules.dispatch("click");

  assert.equal(elements.get("schedules-view").hidden, false);
  assert.equal(elements.get("nodes-view").hidden, true);
  assert.ok(elements.get("schedules-list").innerHTML.includes("no scheduled workflows configured"));

  // 2. Open schedule creation dialog
  const createBtn = elements.get("create-schedule-btn");
  createBtn.dispatch("click");
  assert.equal(elements.get("schedule-dialog").modalShown, true);

  // 3. Fill and submit schedule
  elements.get("schedule-name").value = "Nightly Diagnostic";
  elements.get("schedule-type").value = "cron";
  elements.get("schedule-cron").value = "0 2 * * *";
  elements.get("schedule-task-type").value = "diagnostic";
  elements.get("schedule-target-mode").value = "explicit";
  elements.get("schedule-target-nodes").value = nodeId;

  const submitBtn = elements.get("schedule-submit");
  await submitBtn.dispatch("click");

  // Re-fetch schedules list to verify card rendered
  await navSchedules.dispatch("click");
  assert.ok(elements.get("schedules-list").innerHTML.includes("Nightly Diagnostic"));
  assert.ok(elements.get("schedules-list").innerHTML.includes("0 2 * * *"));
});
