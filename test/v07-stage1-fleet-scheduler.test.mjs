import assert from "node:assert/strict";
import test from "node:test";
import {
  FleetJobScheduler,
  validateFleetTargetSpec,
  JOB_ID_PATTERN,
  ALLOWED_TASK_TYPES,
  FLEET_JOB_STATUSES,
  NODE_TASK_STATUSES,
} from "../src/registry/fleet-scheduler.mjs";

const NODE_A = "node_0123456789abcdef0123456789abcdef";
const NODE_B = "node_fedcba9876543210fedcba9876543210";
const NODE_C = "node_11112222333344445555666677778888";
const NODE_TOMBSTONED = "node_deaddeaddeaddeaddeaddeaddeaddead";

function createMockRegistry({ nodes = [], nodeRows = {} } = {}) {
  return {
    listNodes() {
      return [...nodes];
    },
    getNodeRow(nodeId) {
      return nodeRows[nodeId] || null;
    },
  };
}

test("validateFleetTargetSpec rejects bare wildcards and broadcast modes (field 4)", () => {
  const wildcardCases = [
    "*",
    { mode: "all" },
    { mode: "broadcast" },
    { mode: "explicit", nodeIds: "*" },
    { mode: "all", nodeIds: [NODE_A] },
    { mode: "broadcast", capability: "diagnostic" },
  ];

  for (const tc of wildcardCases) {
    const result = validateFleetTargetSpec(tc);
    assert.equal(result.valid, false);
    assert.equal(result.code, "wildcard-prohibited");
    assert.match(result.message, /bare wildcard/i);
  }
});

test("validateFleetTargetSpec rejects invalid target specifications (field 3)", () => {
  const invalidCases = [
    null,
    undefined,
    123,
    "not-an-object",
    [],
  ];

  for (const tc of invalidCases) {
    const result = validateFleetTargetSpec(tc);
    assert.equal(result.valid, false);
    assert.equal(result.code, "invalid-target-spec");
  }

  // Unknown target mode
  const unknownMode = validateFleetTargetSpec({ mode: "unknown-mode" });
  assert.equal(unknownMode.valid, false);
  assert.equal(unknownMode.code, "unknown-target-mode");

  // Empty explicit target set
  for (const empty of [[], null, undefined, ""]) {
    const res = validateFleetTargetSpec({ mode: "explicit", nodeIds: empty });
    assert.equal(res.valid, false);
    assert.equal(res.code, "empty-target-set");
  }
});

test("validateFleetTargetSpec validates and deduplicates explicit node list (field 2)", () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: { node_id: NODE_A, state: "active" },
      [NODE_B]: { node_id: NODE_B, state: "active" },
      [NODE_TOMBSTONED]: { node_id: NODE_TOMBSTONED, state: "tombstoned" },
    },
  });

  // Valid with duplicates
  const res = validateFleetTargetSpec(
    { mode: "explicit", nodeIds: [NODE_A, NODE_B, NODE_A, NODE_B] },
    mockRegistry,
  );
  assert.equal(res.valid, true);
  assert.equal(res.mode, "explicit");
  assert.deepEqual(res.resolvedNodeIds, [NODE_A, NODE_B]);

  // Invalid node ID
  const invalidNode = validateFleetTargetSpec(
    { mode: "explicit", nodeIds: [NODE_A, "invalid_id"] },
    mockRegistry,
  );
  assert.equal(invalidNode.valid, false);
  assert.equal(invalidNode.code, "invalid-target-node");

  // Tombstoned node rejected
  const tombstoned = validateFleetTargetSpec(
    { mode: "explicit", nodeIds: [NODE_A, NODE_TOMBSTONED] },
    mockRegistry,
  );
  assert.equal(tombstoned.valid, false);
  assert.equal(tombstoned.code, "target-not-found");
});

test("validateFleetTargetSpec validates capability mode and fresh evidence matching (field 5, 6)", () => {
  const mockRegistry = createMockRegistry({
    nodes: [
      {
        nodeId: NODE_A,
        state: "active",
        health: {
          capabilities: [{ name: "diagnostic", version: 1 }],
          capabilitiesStale: false,
        },
      },
      {
        nodeId: NODE_B,
        state: "active",
        health: {
          capabilities: [{ name: "command", version: 1 }],
          capabilitiesStale: false,
        },
      },
      {
        nodeId: NODE_C,
        state: "active",
        health: {
          capabilities: [], // stale withheld
          capabilitiesStale: true,
        },
      },
    ],
  });

  // Empty capability string
  const emptyCap = validateFleetTargetSpec({ mode: "capability", capability: "" }, mockRegistry);
  assert.equal(emptyCap.valid, false);
  assert.equal(emptyCap.code, "invalid-capability-spec");

  // Matching capability
  const matched = validateFleetTargetSpec({ mode: "capability", capability: "diagnostic" }, mockRegistry);
  assert.equal(matched.valid, true);
  assert.equal(matched.mode, "capability");
  assert.equal(matched.capability, "diagnostic");
  assert.deepEqual(matched.resolvedNodeIds, [NODE_A]);

  // Stale node is excluded (field 6)
  const staleMatch = validateFleetTargetSpec({ mode: "capability", capability: "stale-cap" }, mockRegistry);
  assert.equal(staleMatch.valid, false);
  assert.equal(staleMatch.code, "empty-target-set");

  // No active nodes match capability
  const noMatch = validateFleetTargetSpec({ mode: "capability", capability: "non-existent" }, mockRegistry);
  assert.equal(noMatch.valid, false);
  assert.equal(noMatch.code, "empty-target-set");
});

test("FleetJobScheduler submission, duplicate idempotency, and observability (field 1, 11)", async () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: { node_id: NODE_A, state: "active" },
      [NODE_B]: { node_id: NODE_B, state: "active" },
    },
  });

  const scheduler = new FleetJobScheduler({
    registry: mockRegistry,
    dispatchTransport: async (nodeId, task) => {
      return { status: "completed", exitCode: 0, stdout: `ok from ${nodeId}` };
    },
  });

  const fixedJobId = "job_0123456789abcdef0123456789abcdef";

  // First submission
  const job1 = scheduler.submitJob({
    jobId: fixedJobId,
    taskType: "diagnostic",
    payload: { check: "memory" },
    targetSpec: { mode: "explicit", nodeIds: [NODE_A, NODE_B] },
    operatorPrincipal: "admin@orbit.internal",
  });

  assert.equal(job1.jobId, fixedJobId);
  assert.equal(job1.taskType, "diagnostic");
  assert.equal(job1.summary.totalTargets, 2);
  assert.equal(job1.operatorPrincipal, "admin@orbit.internal");

  // Second duplicate submission with identical jobId returns same job idempotently (field 11)
  const job2 = scheduler.submitJob({
    jobId: fixedJobId,
    taskType: "diagnostic",
    payload: { check: "memory" },
    targetSpec: { mode: "explicit", nodeIds: [NODE_A, NODE_B] },
  });

  assert.equal(job2.jobId, fixedJobId);
  assert.deepEqual(job2.summary, job1.summary);

  // Wait for execution to settle
  await scheduler.jobs.get(fixedJobId)._executionPromise;

  const finishedJob = scheduler.getJob(fixedJobId);
  assert.equal(finishedJob.status, "completed");
  assert.equal(finishedJob.summary.completed, 2);
  assert.equal(finishedJob.summary.totalTargets, 2);
  assert.equal(finishedJob.results[NODE_A].status, "completed");
  assert.equal(finishedJob.results[NODE_B].status, "completed");

  // Observability: listJobs returns array with state and summary (field 1)
  const allJobs = scheduler.listJobs();
  assert.equal(allJobs.length, 1);
  assert.equal(allJobs[0].jobId, fixedJobId);
  assert.equal(allJobs[0].status, "completed");
});

test("FleetJobScheduler capability-aware filtering skips nodes with stale or missing evidence (field 5, 6)", async () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: {
        node_id: NODE_A,
        state: "active",
        capabilities: JSON.stringify([{ name: "package-audit", version: 1 }]),
        capabilities_stale: 0,
      },
      [NODE_B]: {
        node_id: NODE_B,
        state: "active",
        capabilities: JSON.stringify([{ name: "diagnostic", version: 1 }]),
        capabilities_stale: 0, // lacks package-audit
      },
      [NODE_C]: {
        node_id: NODE_C,
        state: "active",
        capabilities: JSON.stringify([{ name: "package-audit", version: 1 }]),
        capabilities_stale: 1, // stale evidence
      },
    },
  });

  const executedNodes = [];
  const scheduler = new FleetJobScheduler({
    registry: mockRegistry,
    dispatchTransport: async (nodeId, task) => {
      executedNodes.push(nodeId);
      return { status: "completed", exitCode: 0, stdout: `audit ok on ${nodeId}` };
    },
  });

  const job = scheduler.submitJob({
    taskType: "package-audit",
    targetSpec: { mode: "explicit", nodeIds: [NODE_A, NODE_B, NODE_C] },
    requiredCapabilities: ["package-audit"],
  });

  await scheduler.jobs.get(job.jobId)._executionPromise;

  const result = scheduler.getJob(job.jobId);
  assert.equal(result.status, "partial");
  assert.equal(result.summary.totalTargets, 3);
  assert.equal(result.summary.completed, 1);
  assert.equal(result.summary.skipped, 2);

  // Only Node A was actually dispatched
  assert.deepEqual(executedNodes, [NODE_A]);
  assert.equal(result.results[NODE_A].status, "completed");

  // Node B skipped due to lacks-capability
  assert.equal(result.results[NODE_B].status, "skipped");
  assert.equal(result.results[NODE_B].reason, "lacks-capability");

  // Node C skipped due to capability-evidence-stale
  assert.equal(result.results[NODE_C].status, "skipped");
  assert.equal(result.results[NODE_C].reason, "capability-evidence-stale");
});

test("FleetJobScheduler single node timeout containment and complete results accounting (field 7, 9, 28)", async () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: { node_id: NODE_A, state: "active" },
      [NODE_B]: { node_id: NODE_B, state: "active" },
    },
  });

  const scheduler = new FleetJobScheduler({
    registry: mockRegistry,
    defaultTimeoutMs: 50, // fast timeout for test
    dispatchTransport: async (nodeId, task) => {
      if (nodeId === NODE_A) {
        // Slow node: simulates delay exceeding timeout
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: "completed", exitCode: 0 };
      }
      // Fast node B
      return { status: "completed", exitCode: 0, stdout: "node B success" };
    },
  });

  const job = scheduler.submitJob({
    taskType: "command",
    payload: { cmd: "uptime", timeoutMs: 50 },
    targetSpec: { mode: "explicit", nodeIds: [NODE_A, NODE_B] },
  });

  await scheduler.jobs.get(job.jobId)._executionPromise;

  const finalJob = scheduler.getJob(job.jobId);

  // Field 9: Node A timeout containment does not block Node B
  assert.equal(finalJob.status, "partial");
  assert.equal(finalJob.summary.totalTargets, 2);
  assert.equal(finalJob.summary.completed, 1);
  assert.equal(finalJob.summary.timeout, 1);

  assert.equal(finalJob.results[NODE_B].status, "completed");
  assert.equal(finalJob.results[NODE_B].stdout, "node B success");

  assert.equal(finalJob.results[NODE_A].status, "timeout");
  assert.equal(finalJob.results[NODE_A].error.code, "task-timeout");

  // Field 7: Completeness guarantee — every node has an explicit record
  assert.equal(Object.keys(finalJob.results).length, 2);
  assert.ok(finalJob.results[NODE_A]);
  assert.ok(finalJob.results[NODE_B]);

  // Field 28: No implicit broadcast — strictly bounded to targets A and B
  assert.deepEqual(Object.keys(finalJob.results).sort(), [NODE_A, NODE_B].sort());

  // Invariant reconciliation check
  const total =
    finalJob.summary.completed +
    finalJob.summary.failed +
    finalJob.summary.skipped +
    finalJob.summary.timeout +
    finalJob.summary.unreachable;
  assert.equal(total, finalJob.summary.totalTargets);
});

test("FleetJobScheduler failure independence when Node A errors (field 17)", async () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: { node_id: NODE_A, state: "active" },
      [NODE_B]: { node_id: NODE_B, state: "active" },
    },
  });

  const scheduler = new FleetJobScheduler({
    registry: mockRegistry,
    dispatchTransport: async (nodeId, task) => {
      if (nodeId === NODE_A) {
        return { status: "failed", exitCode: 1, stderr: "crash on A" };
      }
      return { status: "completed", exitCode: 0, stdout: "B completed" };
    },
  });

  const job = scheduler.submitJob({
    taskType: "command",
    targetSpec: { mode: "explicit", nodeIds: [NODE_A, NODE_B] },
  });

  await scheduler.jobs.get(job.jobId)._executionPromise;

  const result = scheduler.getJob(job.jobId);
  assert.equal(result.status, "partial");
  assert.equal(result.summary.completed, 1);
  assert.equal(result.summary.failed, 1);

  assert.equal(result.results[NODE_A].status, "failed");
  assert.equal(result.results[NODE_A].exitCode, 1);
  assert.equal(result.results[NODE_A].stderr, "crash on A");

  assert.equal(result.results[NODE_B].status, "completed");
  assert.equal(result.results[NODE_B].exitCode, 0);
  assert.equal(result.results[NODE_B].stdout, "B completed");
});

test("FleetJobScheduler cancellation aborts in-flight tasks cleanly and preserves accounting invariant (field 26)", async () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: { node_id: NODE_A, state: "active" },
    },
  });

  let transportSignalAborted = false;

  const scheduler = new FleetJobScheduler({
    registry: mockRegistry,
    dispatchTransport: async (nodeId, task) => {
      task.signal.addEventListener("abort", () => {
        transportSignalAborted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { status: "completed", exitCode: 0 };
    },
  });

  const job = scheduler.submitJob({
    taskType: "command",
    targetSpec: { mode: "explicit", nodeIds: [NODE_A] },
  });

  // Cancel immediately while dispatch is in flight
  scheduler.cancelJob(job.jobId);

  // Snapshot immediately after cancellation
  const immediateSnapshot = scheduler.getJob(job.jobId);
  assert.equal(immediateSnapshot.status, "failed");
  assert.equal(immediateSnapshot.results[NODE_A].status, "failed");
  assert.equal(immediateSnapshot.results[NODE_A].error.code, "job-cancelled");

  // Await the underlying execution promise to ensure post-settlement does not resurrect completed state
  await scheduler.jobs.get(job.jobId)._executionPromise;

  const settledSnapshot = scheduler.getJob(job.jobId);
  assert.equal(settledSnapshot.status, "failed");
  assert.equal(settledSnapshot.summary.totalTargets, 1);
  assert.equal(settledSnapshot.summary.failed, 1);
  assert.equal(settledSnapshot.summary.completed, 0);

  // Node remains failed and does not resurrect
  assert.equal(settledSnapshot.results[NODE_A].status, "failed");
  assert.equal(settledSnapshot.results[NODE_A].error.code, "job-cancelled");

  // Transport signal received the abort
  assert.equal(transportSignalAborted, true);

  // Accounting invariant holds
  const computedTotal =
    settledSnapshot.summary.completed +
    settledSnapshot.summary.failed +
    settledSnapshot.summary.skipped +
    settledSnapshot.summary.timeout +
    settledSnapshot.summary.unreachable;
  assert.equal(computedTotal, settledSnapshot.summary.totalTargets);
});

test("FleetJobScheduler snapshots are deep clones and mutate-isolated (field 1)", () => {
  const mockRegistry = createMockRegistry({
    nodeRows: {
      [NODE_A]: { node_id: NODE_A, state: "active" },
    },
  });

  const scheduler = new FleetJobScheduler({ registry: mockRegistry });
  const job = scheduler.submitJob({
    taskType: "diagnostic",
    payload: { nested: { count: 42 } },
    targetSpec: { mode: "explicit", nodeIds: [NODE_A] },
  });

  const snap = scheduler.getJob(job.jobId);
  // Mutate nested fields on the snapshot
  snap.payload.nested.count = 999;
  snap.targetSpec.nodeIds.length = 0;
  snap.results[NODE_A].status = "mutated";

  // Re-read from scheduler: internal state must be completely untouched
  const fresh = scheduler.getJob(job.jobId);
  assert.equal(fresh.payload.nested.count, 42);
  assert.deepEqual(fresh.targetSpec.nodeIds, [NODE_A]);
  assert.notEqual(fresh.results[NODE_A].status, "mutated");
});

test("FleetJobScheduler capability filtering fails closed when registry row is missing", async () => {
  const mockRegistry = createMockRegistry({
    nodes: [{ nodeId: NODE_A, state: "active", health: { capabilities: [{ name: "audit", version: 1 }], capabilitiesStale: false } }],
    nodeRows: {
      // NODE_A intentionally missing from nodeRows (e.g. deleted/unavailable after target validation)
    },
  });

  let dispatched = false;
  const scheduler = new FleetJobScheduler({
    registry: mockRegistry,
    dispatchTransport: async () => {
      dispatched = true;
      return { status: "completed", exitCode: 0 };
    },
  });

  const job = scheduler.submitJob({
    taskType: "package-audit",
    targetSpec: { mode: "capability", capability: "audit" },
    requiredCapabilities: ["audit"],
  });

  await scheduler.jobs.get(job.jobId)._executionPromise;

  const res = scheduler.getJob(job.jobId);
  // Node must NOT be dispatched (fails closed)
  assert.equal(dispatched, false);
  assert.equal(res.summary.skipped, 1);
  assert.equal(res.summary.completed, 0);
  assert.equal(res.results[NODE_A].status, "skipped");
  assert.equal(res.results[NODE_A].reason, "target-not-found");
});

test("FleetJobScheduler rejects non-serializable payload upfront without ghost tasks or list poisoning", () => {
  const mockRegistry = createMockRegistry({
    nodeRows: { [NODE_A]: { node_id: NODE_A, state: "active" } },
  });

  const scheduler = new FleetJobScheduler({ registry: mockRegistry });

  // Payload containing a function or circular reference
  const circular = {};
  circular.self = circular;

  const uncloneablePayloads = [
    { fn: () => {} },
    { sym: Symbol("foo") },
    circular,
  ];

  for (const badPayload of uncloneablePayloads) {
    assert.throws(
      () => {
        scheduler.submitJob({
          taskType: "command",
          payload: badPayload,
          targetSpec: { mode: "explicit", nodeIds: [NODE_A] },
        });
      },
      (err) => err.code === "invalid-payload",
    );
  }

  // Ensure no ghost tasks were registered and listJobs() is healthy
  assert.equal(scheduler.listJobs().length, 0);
  assert.equal(scheduler.jobs.size, 0);
});

test("FleetJobScheduler capability filtering fails closed when registry lacks getNodeRow or is null", async () => {
  // Case A: Registry lacks getNodeRow
  const registryWithoutGetNodeRow = {
    listNodes: () => [{ nodeId: NODE_A, state: "active", health: { capabilities: [{ name: "diag", version: 1 }], capabilitiesStale: false } }],
  };

  const schedulerA = new FleetJobScheduler({
    registry: registryWithoutGetNodeRow,
    dispatchTransport: async () => ({ status: "completed" }),
  });

  const jobA = schedulerA.submitJob({
    taskType: "diagnostic",
    targetSpec: { mode: "capability", capability: "diag" },
    requiredCapabilities: ["diag"],
  });

  await schedulerA.jobs.get(jobA.jobId)._executionPromise;
  const resA = schedulerA.getJob(jobA.jobId);
  assert.equal(resA.summary.skipped, 1);
  assert.equal(resA.results[NODE_A].status, "skipped");
  assert.equal(resA.results[NODE_A].reason, "capability-evidence-stale");

  // Case B: Registry is completely null on scheduler
  const schedulerB = new FleetJobScheduler({
    registry: null,
    dispatchTransport: async () => ({ status: "completed" }),
  });

  const jobB = schedulerB.submitJob({
    taskType: "diagnostic",
    targetSpec: { mode: "explicit", nodeIds: [NODE_A] },
    requiredCapabilities: ["diag"],
  });

  await schedulerB.jobs.get(jobB.jobId)._executionPromise;
  const resB = schedulerB.getJob(jobB.jobId);
  assert.equal(resB.summary.skipped, 1);
  assert.equal(resB.results[NODE_A].status, "skipped");
  assert.equal(resB.results[NODE_A].reason, "capability-evidence-stale");
});