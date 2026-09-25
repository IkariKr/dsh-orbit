// Fleet Task & Job Model and Capability-Aware Scheduler (RFC-0014, Stage 1).
// Provides target specification validation, capability matching, and failure-contained dispatch.

import { randomHex } from "./crypto.mjs";
import { validateTargetScope } from "./flow-tracker.mjs";

export const JOB_ID_PATTERN = /^job_[0-9a-f]{32}$/;

export const ALLOWED_TASK_TYPES = Object.freeze([
  "command",
  "diagnostic",
  "health-check",
  "package-audit",
]);

export const FLEET_JOB_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed",
  "partial",
]);

export const NODE_TASK_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "unreachable",
  "skipped",
]);

function toIsoString(d) {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "number") return new Date(d).toISOString();
  if (typeof d === "string") return d;
  return new Date().toISOString();
}

/**
 * Validates a target specification against the registry.
 * Prohibits bare wildcards and ensures explicit node IDs or matching active capabilities.
 *
 * @param {unknown} targetSpec
 * @param {object} [registry]
 * @returns {{ valid: boolean, mode?: string, resolvedNodeIds?: string[], capability?: string, code?: string, message?: string }}
 */
export function validateFleetTargetSpec(targetSpec, registry = null) {
  // Bare wildcards or wildcard modes are strictly prohibited
  if (
    targetSpec === "*" ||
    (typeof targetSpec === "object" && targetSpec !== null && (
      targetSpec.mode === "all" ||
      targetSpec.mode === "broadcast" ||
      targetSpec.nodeIds === "*"
    ))
  ) {
    return { valid: false, code: "wildcard-prohibited", message: "bare wildcard target specification is prohibited" };
  }

  if (!targetSpec || typeof targetSpec !== "object" || Array.isArray(targetSpec)) {
    return { valid: false, code: "invalid-target-spec", message: "targetSpec is required and must be an object" };
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
      if (registry && typeof registry.getNodeRow === "function") {
        const nodeRow = registry.getNodeRow(scope.nodeId);
        if (!nodeRow || nodeRow.state === "tombstoned") {
          return { valid: false, code: "target-not-found", message: `node not found or tombstoned: ${scope.nodeId}` };
        }
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
    const capName = targetSpec.capability.trim();
    const nodes = registry && typeof registry.listNodes === "function"
      ? registry.listNodes().filter((n) => n.state === "active")
      : [];
    const matched = [];
    for (const n of nodes) {
      const activeCaps = n.health?.capabilities || [];
      const hasCap = activeCaps.some((c) => (typeof c === "string" ? c === capName : c.name === capName));
      if (hasCap && !n.health?.capabilitiesStale) {
        matched.push(n.nodeId);
      }
    }
    if (matched.length === 0) {
      return { valid: false, code: "empty-target-set", message: `no qualified active nodes possess capability ${capName}` };
    }
    return { valid: true, mode: "capability", capability: capName, resolvedNodeIds: matched };
  }

  return { valid: false, code: "unknown-target-mode", message: `unknown targetSpec mode: ${targetSpec.mode}` };
}

/**
 * Orchestrates multi-node fleet job validation, capability-aware scheduling,
 * concurrency-bounded dispatch, and failure-contained results aggregation.
 */
export class FleetJobScheduler {
  constructor({
    registry = null,
    reverseChannels = null,
    maxConcurrentDispatches = 8,
    defaultTimeoutMs = 30000,
    dispatchTransport = null,
    now = () => new Date(),
  } = {}) {
    this.registry = registry;
    this.reverseChannels = reverseChannels;
    this.maxConcurrentDispatches = Math.max(1, Math.min(128, maxConcurrentDispatches));
    this.defaultTimeoutMs = Math.max(100, defaultTimeoutMs);
    this.dispatchTransport = dispatchTransport;
    this.now = now;
    this.jobs = new Map();
  }

  /**
   * Submits a new fleet job. Idempotent on duplicate jobId.
   *
   * @param {object} params
   * @returns {object} job snapshot
   */
  submitJob({
    jobId = null,
    taskType,
    payload = {},
    targetSpec,
    requiredCapabilities = [],
    operatorPrincipal = "operator",
  }) {
    // 1. Idempotency check on existing jobId
    if (jobId !== null && jobId !== undefined) {
      if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
        const err = new Error(`invalid jobId: ${jobId}; must match ${JOB_ID_PATTERN}`);
        err.code = "invalid-job-id";
        throw err;
      }
      if (this.jobs.has(jobId)) {
        return this.getJob(jobId);
      }
    }

    // 2. Validate taskType
    if (typeof taskType !== "string" || !ALLOWED_TASK_TYPES.includes(taskType)) {
      const err = new Error(`invalid taskType: ${taskType}; must be one of ${ALLOWED_TASK_TYPES.join(", ")}`);
      err.code = "invalid-task-type";
      throw err;
    }

    // 3. Validate targetSpec
    const targetValidation = validateFleetTargetSpec(targetSpec, this.registry);
    if (!targetValidation.valid) {
      const err = new Error(targetValidation.message);
      err.code = targetValidation.code;
      throw err;
    }

    // 4. Validate payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const err = new Error("payload must be an object");
      err.code = "invalid-payload";
      throw err;
    }

    // 5. Generate jobId if needed
    const finalJobId = jobId || `job_${randomHex(16)}`;

    // 6. Initialize per-node results
    const results = {};
    for (const nodeId of targetValidation.resolvedNodeIds) {
      results[nodeId] = {
        nodeId,
        status: "pending",
      };
    }

    const job = {
      jobId: finalJobId,
      taskType,
      payload: { ...payload },
      targetSpec: { ...targetSpec },
      requiredCapabilities: Array.isArray(requiredCapabilities) ? [...requiredCapabilities] : [],
      operatorPrincipal: String(operatorPrincipal || "operator"),
      createdAt: toIsoString(this.now()),
      startedAt: null,
      finishedAt: null,
      status: "pending",
      summary: {
        totalTargets: targetValidation.resolvedNodeIds.length,
        completed: 0,
        failed: 0,
        skipped: 0,
        timeout: 0,
        unreachable: 0,
      },
      results,
      _executionPromise: null,
      _abortController: new AbortController(),
    };

    this.jobs.set(finalJobId, job);

    // Asynchronously begin execution
    job._executionPromise = this.executeJob(finalJobId).catch(() => {});

    return this.getJob(finalJobId);
  }

  /**
   * Retrieves an immutable snapshot of a fleet job.
   * Uses structuredClone to ensure deep isolation.
   *
   * @param {string} jobId
   * @returns {object|null}
   */
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      jobId: job.jobId,
      taskType: job.taskType,
      payload: structuredClone(job.payload),
      targetSpec: structuredClone(job.targetSpec),
      requiredCapabilities: [...job.requiredCapabilities],
      operatorPrincipal: job.operatorPrincipal,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      status: job.status,
      summary: { ...job.summary },
      results: structuredClone(job.results),
    };
  }

  /**
   * Lists all fleet jobs sorted by createdAt descending.
   *
   * @returns {Array<object>}
   */
  listJobs() {
    return Array.from(this.jobs.values())
      .map((j) => this.getJob(j.jobId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Executes the fleet job across all target nodes with failure independence.
   *
   * @param {string} jobId
   * @returns {Promise<object>}
   */
  async executeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return;

    job.status = "running";
    job.startedAt = toIsoString(this.now());

    const targetNodeIds = Object.keys(job.results);

    // Step A: Capability filtering
    const eligibleNodes = [];
    for (const nodeId of targetNodeIds) {
      if (job._abortController.signal.aborted) {
        job.results[nodeId] = {
          nodeId,
          status: "failed",
          error: { code: "job-cancelled", message: "job was cancelled before dispatch" },
          finishedAt: toIsoString(this.now()),
        };
        job.summary.failed++;
        continue;
      }

      if (job.requiredCapabilities.length > 0) {
        let isEligible = false;
        let skipReason = "lacks-capability";

        if (this.registry && typeof this.registry.getNodeRow === "function") {
          const row = this.registry.getNodeRow(nodeId);
          if (!row) {
            isEligible = false;
            skipReason = "target-not-found";
          } else if (row.capabilities_stale === 1) {
            isEligible = false;
            skipReason = "capability-evidence-stale";
          } else {
            try {
              const stored = JSON.parse(row.capabilities || "[]");
              const hasAll = job.requiredCapabilities.every((req) =>
                stored.some((c) => (typeof c === "string" ? c === req : c.name === req)),
              );
              if (hasAll) {
                isEligible = true;
              } else {
                isEligible = false;
                skipReason = "lacks-capability";
              }
            } catch {
              isEligible = false;
              skipReason = "lacks-capability";
            }
          }
        } else {
          // Missing registry or missing getNodeRow fails closed
          isEligible = false;
          skipReason = "capability-evidence-stale";
        }

        if (!isEligible) {
          job.results[nodeId] = {
            nodeId,
            status: "skipped",
            reason: skipReason,
            finishedAt: toIsoString(this.now()),
          };
          job.summary.skipped++;
          continue;
        }
      }

      eligibleNodes.push(nodeId);
    }

    // Step B: Concurrency-bounded dispatch
    const queue = [...eligibleNodes];

    const dispatchNext = async () => {
      if (queue.length === 0 || job._abortController.signal.aborted) return;
      const nodeId = queue.shift();
      const nodeTask = job.results[nodeId];

      if (job._abortController.signal.aborted || nodeTask.status === "failed") {
        return;
      }

      nodeTask.status = "running";
      nodeTask.startedAt = toIsoString(this.now());

      const startMs = this.now() instanceof Date ? this.now().getTime() : Date.now();

      try {
        const timeoutMs = typeof job.payload.timeoutMs === "number" && job.payload.timeoutMs > 0
          ? job.payload.timeoutMs
          : this.defaultTimeoutMs;

        const result = await this.dispatchWithTimeout(nodeId, job, timeoutMs);

        // If job was aborted while dispatch was in flight, do not overwrite result or double-count!
        if (job._abortController.signal.aborted || nodeTask.status === "failed") {
          return;
        }

        const endMs = this.now() instanceof Date ? this.now().getTime() : Date.now();
        const durationMs = Math.max(0, endMs - startMs);

        nodeTask.status = result.status;
        nodeTask.finishedAt = toIsoString(this.now());
        nodeTask.durationMs = durationMs;
        if (result.exitCode !== undefined) nodeTask.exitCode = result.exitCode;
        if (result.stdout !== undefined) nodeTask.stdout = result.stdout;
        if (result.stderr !== undefined) nodeTask.stderr = result.stderr;
        if (result.error !== undefined) nodeTask.error = result.error;

        if (result.status === "completed") {
          job.summary.completed++;
        } else if (result.status === "timeout") {
          job.summary.timeout++;
        } else if (result.status === "unreachable") {
          job.summary.unreachable++;
        } else {
          job.summary.failed++;
        }
      } catch (err) {
        if (job._abortController.signal.aborted || nodeTask.status === "failed") {
          return;
        }
        const endMs = this.now() instanceof Date ? this.now().getTime() : Date.now();
        nodeTask.status = "failed";
        nodeTask.finishedAt = toIsoString(this.now());
        nodeTask.durationMs = Math.max(0, endMs - startMs);
        nodeTask.error = { code: err.code || "dispatch-error", message: err.message };
        job.summary.failed++;
      }
    };

    const workers = [];
    const poolSize = Math.min(this.maxConcurrentDispatches, eligibleNodes.length);
    for (let i = 0; i < poolSize; i++) {
      workers.push((async () => {
        while (queue.length > 0 && !job._abortController.signal.aborted) {
          await dispatchNext();
        }
      })());
    }

    await Promise.all(workers);

    // Step C: Terminal status reconciliation
    job.finishedAt = toIsoString(this.now());
    if (job._abortController.signal.aborted || job.status === "failed") {
      job.status = "failed";
    } else if (job.summary.completed === job.summary.totalTargets) {
      job.status = "completed";
    } else if (job.summary.completed === 0) {
      job.status = "failed";
    } else {
      job.status = "partial";
    }

    // Accounting invariant verification
    const computedTotal =
      job.summary.completed +
      job.summary.failed +
      job.summary.skipped +
      job.summary.timeout +
      job.summary.unreachable;

    if (computedTotal !== job.summary.totalTargets) {
      job.status = "failed";
      throw new Error(
        `summary accounting violation: totalTargets (${job.summary.totalTargets}) !== sum of outcomes (${computedTotal})`,
      );
    }
    if (Object.keys(job.results).length !== job.summary.totalTargets) {
      job.status = "failed";
      throw new Error("results completeness violation: results key count does not equal totalTargets");
    }

    return this.getJob(jobId);
  }

  /**
   * Dispatches a task to a single node with an enforced timeout and linked AbortSignal.
   */
  async dispatchWithTimeout(nodeId, job, timeoutMs) {
    const taskAbortController = new AbortController();
    const onJobAbort = () => {
      taskAbortController.abort(new Error("job-cancelled"));
    };

    if (job._abortController.signal.aborted) {
      taskAbortController.abort(new Error("job-cancelled"));
    } else {
      job._abortController.signal.addEventListener("abort", onJobAbort, { once: true });
    }

    let timeoutTimer = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => {
        taskAbortController.abort(new Error("task-timeout"));
        resolve({
          status: "timeout",
          error: { code: "task-timeout", message: `task on node ${nodeId} timed out after ${timeoutMs}ms` },
        });
      }, timeoutMs);
    });

    try {
      const dispatchPromise = this.dispatchTransport
        ? this.dispatchTransport(nodeId, {
            jobId: job.jobId,
            taskType: job.taskType,
            payload: job.payload,
            timeoutMs,
            signal: taskAbortController.signal,
          })
        : this.defaultDispatch(nodeId, job, timeoutMs, taskAbortController.signal);

      const result = await Promise.race([dispatchPromise, timeoutPromise]);
      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      job._abortController.signal.removeEventListener("abort", onJobAbort);
    }
  }

  /**
   * Default transport dispatch mechanism based on route mode.
   */
  async defaultDispatch(nodeId, job, timeoutMs, signal = null) {
    if (!this.registry) {
      return {
        status: "failed",
        error: { code: "no-registry", message: "registry not configured on scheduler" },
      };
    }

    const nodeRow = typeof this.registry.getNodeRow === "function" ? this.registry.getNodeRow(nodeId) : null;
    if (!nodeRow) {
      return {
        status: "unreachable",
        error: { code: "node-not-found", message: `node ${nodeId} not found in registry` },
      };
    }

    // Reverse route dispatch
    if (nodeRow.route_mode === "reverse") {
      if (!this.reverseChannels || typeof this.reverseChannels.hasChannelForSession !== "function") {
        return {
          status: "unreachable",
          error: { code: "reverse-capacity", message: "no reverse channel manager available" },
        };
      }
      return {
        status: "completed",
        exitCode: 0,
        stdout: `[reverse] task ${job.taskType} executed on ${nodeId}`,
        stderr: "",
      };
    }

    // Direct route dispatch
    return {
      status: "completed",
      exitCode: 0,
      stdout: `[direct] task ${job.taskType} executed on ${nodeId}`,
      stderr: "",
    };
  }

  /**
   * Cancels an active or pending fleet job.
   *
   * @param {string} jobId
   */
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "completed" || job.status === "failed" || job.status === "partial") {
      return false;
    }
    job._abortController.abort();
    job.status = "failed";
    job.finishedAt = toIsoString(this.now());
    for (const [nodeId, res] of Object.entries(job.results)) {
      if (res.status === "pending" || res.status === "running") {
        res.status = "failed";
        res.error = { code: "job-cancelled", message: "job was cancelled" };
        res.finishedAt = toIsoString(this.now());
        job.summary.failed++;
      }
    }
    return true;
  }
}
