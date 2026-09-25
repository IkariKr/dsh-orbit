# RFC 0014: Fleet workflows and capability-aware scheduling for v0.7

Status: **Proposed for v0.7 architecture review. Product construction is blocked until the Stage 0 / Gate A review records GO.**

Depends on: RFC-0001 node identity, RFC-0005 enrollment and registry persistence, RFC-0006 machine API, RFC-0007 browser management API, RFC-0008 per-node Hub route identity, RFC-0009 capability/health semantics, RFC-0010 node endpoint/routing, RFC-0011 browser node selection, RFC-0012 reverse-connected nodes, RFC-0013 multi-node sessions and target scoping, and authorization `V07-CONSTRUCTION-20260926-A1`.

---

## 1. Goal

v0.7 extends DSH Orbit from interactive multi-node sessions (v0.6) to **fleet workflows and capability-aware task scheduling**.

In v0.6, operators interact concurrently with multiple discrete nodes via dedicated browser sessions with explicit single-node target scoping. However, operational administration across a cluster requires:
1. Dispatching explicit tasks targeting selected nodes (e.g. diagnostics, health checks, configuration audits, or maintenance scripts);
2. Capability-aware scheduling: tasks requiring specific runtime capabilities (such as terminal execution, routing presence, or specific extensions) are dispatched only to qualified nodes possessing fresh, verified capability attestations;
3. Aggregated result collection: structured summaries capturing exit codes, output digests, durations, and error details per node without silent drops;
4. Strong auditability: recording operator principal, target selection, execution timeline, and outcome hashes in durable SQLite storage.

```text
Operator UI / Management API
   |
   | POST /hub/fleet/jobs { taskType: "diagnostic", targetSpec: ["node_A", "node_B"], requiredCapabilities: ["web.routes"] }
   v
Hub Control Plane: FleetJobScheduler
   |-- 1. Validate explicit target scope (no bare wildcards)
   |-- 2. Match required capabilities against verified node health
   |-- 3. Record audit log entry (operator, job parameters, timestamp)
   |-- 4. Dispatch tasks across isolated direct / reverse channels
   |
   +---- Dispatch to Node A (direct transport, ORBIT-ROUTE-V1) ----> Node A Result
   |
   +---- Dispatch to Node B (reverse data channel)                ----> Node B Result
   |
   v
Aggregate Results Collector & Durable History (GET /hub/fleet/jobs/:jobId)
```

Core safety principles:
- **No unbound broadcast**: tasks must explicitly specify target node IDs or a capability-filtered query; bare wildcards (`"*"`, `"all"`, `"broadcast"`) fail closed with `HTTP 400 Bad Request`.
- **Capability-aware eligibility**: nodes with stale, withheld, or missing capability evidence are excluded from dispatch with explicit reason codes (`"lacks-capability"` or `"capability-evidence-stale"`).
- **Execution failure independence**: failure or timeout on Node A never aborts or corrupts concurrent execution on Node B.
- **Zero credential leakage**: task dispatch payloads to Node A contain zero keys, tokens, or route proofs for Node B.

---

## 2. Decision Summary

1. **D1: Fleet Task & Job Model (`FleetJob`)**
   A fleet job encapsulates a batch operation dispatched across one or more nodes. It tracks lifecycle states (`pending`, `running`, `completed`, `failed`, `partial`), task parameters, required capabilities, per-node execution status, and aggregated metrics.
2. **D2: Explicit Multi-Node Target Resolution & Scope Validation**
   Target specifications must be an explicit list of 32-hex node IDs (`["node_..."]`) or a capability selector (`{ selector: "capability", capability: "..." }`). Empty target sets, unregistered nodes, or bare wildcards fail closed with `HTTP 400 Bad Request` (`code: "invalid-target-spec"`).
3. **D3: Capability-Aware Scheduling (`FleetJobScheduler`)**
   The scheduler inspects the Hub's authoritative capability registry (`RFC-0009`). Nodes lacking requested capabilities or whose evidence is stale (`capabilities_stale == 1`) are rejected or marked `skipped` according to the job's scheduling policy.
4. **D4: Aggregated Results Collection & Complete Per-Node Accounting**
   Results from all targeted nodes are aggregated into a single structured response. Every node in the resolved target set has an explicit record (`completed`, `failed`, `timeout`, `unreachable`, or `skipped`). No target node is silently dropped.
5. **D5: Durable Audit Trail & Operator Accountability**
   Fleet jobs, target resolutions, execution parameters, and result summaries are recorded in the Hub's SQLite audit log with the initiating operator principal and timestamp.
6. **D6: Acceptance Matrix for v0.7 (M28 Matrix - 28 Canonical Fields)**
   A dedicated 28-field acceptance matrix is mechanically enforced across automated qualification (9 fields) and live mounted drill runs (19 fields).

---

## 3. Detailed Technical Design

### D1: Fleet Job & Task Data Model

A Fleet Job is represented by a durable entity:

```typescript
type FleetJobStatus = "pending" | "running" | "completed" | "failed" | "partial";

type NodeTaskStatus = "pending" | "running" | "completed" | "failed" | "timeout" | "unreachable" | "skipped";

interface NodeTaskResult {
  nodeId: string;
  status: NodeTaskStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

interface FleetJob {
  jobId: string; // "job_" + 32-hex
  taskType: "command" | "diagnostic" | "health-check" | "package-audit";
  payload: Record<string, unknown>;
  targetSpec: {
    mode: "explicit" | "capability";
    nodeIds?: string[];
    capability?: string;
  };
  requiredCapabilities: string[];
  operatorPrincipal: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: FleetJobStatus;
  summary: {
    totalTargets: number;
    completed: number;
    failed: number;
    skipped: number;
    timeout: number;
  };
  results: Record<string, NodeTaskResult>; // nodeId -> result
}
```

### D2: Target Scope Validation & Resolution

The Hub management API endpoint `POST /hub/fleet/jobs` validates target specifications:

```typescript
export function validateFleetTargetSpec(targetSpec, registry) {
  if (!targetSpec || typeof targetSpec !== "object") {
    return { valid: false, code: "invalid-target-spec", message: "targetSpec is required and must be an object" };
  }

  // Bare wildcards are denied
  if (targetSpec === "*" || targetSpec.mode === "all" || targetSpec.mode === "broadcast" || targetSpec.nodeIds === "*") {
    return { valid: false, code: "wildcard-prohibited", message: "bare wildcard target specification is prohibited" };
  }

  if (targetSpec.mode === "explicit") {
    if (!Array.isArray(targetSpec.nodeIds) || targetSpec.nodeIds.length === 0) {
      return { valid: false, code: "empty-target-set", message: "explicit targetSpec requires non-empty nodeIds array" };
    }
    const cleanNodeIds = [];
    const seen = new Set();
    for (const raw of targetSpec.nodeIds) {
      const scope = validateTargetScope(raw);
      if (!scope.valid) {
        return { valid: false, code: "invalid-target-node", message: `invalid target node: ${raw}` };
      }
      const nodeRow = registry.getNodeRow(scope.nodeId);
      if (!nodeRow || nodeRow.state === "tombstoned") {
        return { valid: false, code: "target-not-found", message: `node not found or tombstoned: ${scope.nodeId}` };
      }
      if (!seen.has(scope.nodeId)) {
        seen.add(scope.nodeId);
        cleanNodeIds.push(scope.nodeId);
      }
    }
    return { valid: true, mode: "explicit", resolvedNodeIds: cleanNodeIds };
  }

  if (targetSpec.mode === "capability") {
    if (typeof targetSpec.capability !== "string" || targetSpec.capability.trim() === "") {
      return { valid: false, code: "invalid-capability-spec", message: "capability mode requires non-empty capability string" };
    }
    const nodes = registry.listNodes().filter((n) => n.state === "active");
    const matched = [];
    for (const n of nodes) {
      const storedCaps = JSON.parse(n.capabilities || "[]");
      const hasCap = storedCaps.some((c) => c.name === targetSpec.capability);
      if (hasCap && n.capabilities_stale === 0) {
        matched.push(n.node_id);
      }
    }
    if (matched.length === 0) {
      return { valid: false, code: "empty-target-set", message: `no qualified active nodes possess capability ${targetSpec.capability}` };
    }
    return { valid: true, mode: "capability", capability: targetSpec.capability, resolvedNodeIds: matched };
  }

  return { valid: false, code: "unknown-target-mode", message: `unknown targetSpec mode: ${targetSpec.mode}` };
}
```

### D3: Capability-Aware Scheduling

The `FleetJobScheduler` orchestrates task execution:
1. **Node Eligibility Check**:
   - `nodeRow.state === "active"`;
   - Reachability: `routeMode === "direct" && reachable === "ok"`, or `routeMode === "reverse" && reverseRouteReady === true`;
   - Capabilities check: node must have all `requiredCapabilities` attested with `capabilities_stale === 0`.
2. **Dispatch & Concurrency**:
   - Tasks are dispatched concurrently up to `maxConcurrentDispatches` (default: 8);
   - Direct nodes are dispatched via HTTP POST to the node's internal task runner or RouteIngress;
   - Reverse nodes are dispatched over dedicated reverse channels using a structured task frame (`mode: "task"`);
3. **Timeout & Failure Containment**:
   - Each node task has an individual timeout (default: 30 seconds);
   - If Node A times out, Node A is marked `status: "timeout"` and its channel is aborted;
   - Concurrent tasks on Node B continue without interruption or shared timeout coupling.

### D4: Aggregated Results Collection

The Hub maintains live progress:
- `GET /hub/fleet/jobs`: Lists recent jobs with summary statistics;
- `GET /hub/fleet/jobs/:jobId`: Returns full details including per-node outputs, exit codes, and timestamps;
- Completeness guarantee: `Object.keys(results).length === summary.totalTargets`.

### D5: Auditability & Security Logging

Every fleet job execution writes to SQLite `audit_log`:
- `action`: `"fleet.job.create"`, `"fleet.job.complete"`, `"fleet.job.abort"`;
- `actor`: `operatorPrincipal`;
- `metadata`: includes `jobId`, `taskType`, `targetSpec`, `resolvedNodeCount`, and summary metrics;
- Zero credential leakage: task payloads and output logs scrub tokens, private keys, and session cookies.

---

## 4. Acceptance Matrix (RFC-0014 M28 Matrix)

The v0.7 acceptance matrix defines 28 canonical fields:

| # | Field | Scope | Description |
|---|-------|-------|-------------|
| 1 | `fleetJobListObservability` | automated | Hub read model exposes fleet jobs list with state, targets, and summaries |
| 2 | `fleetJobTargetSpecExplicitList` | automated | Explicit array of 32-hex node IDs validated and deduplicated |
| 3 | `fleetJobTargetSpecEmptyRejected` | automated | Empty target specifications rejected with HTTP 400 empty-target-set |
| 4 | `fleetJobWildcardWithoutFilterDenied` | automated | Bare wildcards ("*", "all", broadcast) rejected with HTTP 400 wildcard-prohibited |
| 5 | `capabilityAwareSchedulingMatching` | automated | Tasks scheduled only to nodes matching required verified capabilities |
| 6 | `capabilityAwareSchedulingStaleSkipped` | automated | Nodes with stale capability evidence are excluded from task dispatch |
| 7 | `fleetJobAggregatedResultsComplete` | automated | Results contain explicit entries for all target nodes without silent drop |
| 8 | `fleetJobAuditLogRecorded` | automated | Job creation, targets, and completion recorded in Hub SQLite audit log |
| 9 | `fleetJobSingleNodeTimeoutContainment` | automated | Single slow or timed-out node does not block or delay peer task completions |
| 10 | `operatorUiFleetWorkflowsView` | automated | Operator surface displays Fleet Workflows view and job triggers |
| 11 | `fleetJobDuplicateIdempotent` | automated | Duplicate jobId submissions handled safely without duplicate execution |
| 12 | `concurrentFleetJobExecution` | mounted | Multiple fleet jobs execute concurrently across the cluster without locking |
| 13 | `fleetTaskExecutionDirectNode` | mounted | Fleet task dispatches and executes on direct Node A |
| 14 | `fleetTaskExecutionReverseNode` | mounted | Fleet task dispatches and executes on reverse Node B |
| 15 | `concurrentTaskDispatchDirectAndReverse` | mounted | Simultaneous task dispatch across direct Node A and reverse Node B |
| 16 | `fleetTaskResultAggregationDirectAndReverse` | mounted | Aggregated results collect outputs from direct Node A and reverse Node B |
| 17 | `targetNodeOutageDuringJobExecution` | mounted | Node A crash during fleet job marks Node A failed while Node B completes |
| 18 | `reverseNodeDisconnectDuringJobExecution` | mounted | Node B reverse disconnect marks Node B unreachable while Node A completes |
| 19 | `fleetJobLargeOutputAggregation` | mounted | Multi-node tasks returning large outputs (>64 KiB) aggregated without truncation |
| 20 | `fleetJobStreamingProgressEvents` | mounted | Real-time progress updates reflect incremental per-node task completions |
| 21 | `capabilityMismatchNodeFiltered` | mounted | Node lacking requested capability omitted from execution in mixed cluster |
| 22 | `tombstonedNodeTargetRejected` | mounted | Job targeting a tombstoned node rejected fail-closed before execution |
| 23 | `hubRestartPendingJobReconciliation` | mounted | Hub restart reconciles in-flight fleet jobs cleanly without orphan state |
| 24 | `nodeRestartDuringFleetJob` | mounted | Node restarting during fleet task reports node-restarted error |
| 25 | `auditLogQueryFiltering` | automated | Audit log queries by jobId, operator, or time range return complete history |
| 26 | `fleetJobCancellation` | mounted | In-flight job cancellation aborts active child tasks on nodes cleanly |
| 27 | `zeroCrossNodeCredentialLeakInJob` | mounted | Task dispatch to Node A carries zero credentials, tokens, or proofs for Node B |
| 28 | `noImplicitBroadcastExecution` | automated | Fleet execution strictly bounded to resolved targets without cluster broadcast |
