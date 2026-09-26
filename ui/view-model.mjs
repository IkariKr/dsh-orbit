// View-model for the v0.3 operator UI (SOP Stage 5). Pure mapping —
// no DOM, no network — so every health dimension is rendered
// explicitly and never flattened into a single Healthy/Unhealthy
// badge. Browser-safe ES module (also imported by tests).

export const LOADING_STATE = { kind: "loading" };
export const EMPTY_NODES_STATE = { kind: "empty-nodes" };
export const EMPTY_TOKENS_STATE = { kind: "empty-tokens" };
export const EMPTY_FLEET_JOBS_STATE = { kind: "empty-fleet-jobs" };
export const SESSION_REQUIRED_STATE = { kind: "session-required" };
export const BOOTSTRAP_ERROR_STATE = { kind: "bootstrap-error" };

export function mapApiError(body, fallback = "unexpected error") {
  const code = body?.error?.code;
  const message = body?.error?.message;
  if (typeof code === "string") return { code, message: typeof message === "string" ? message : fallback, fallback };
  return { code: "unknown", message: fallback, fallback };
}

// Client-generated delete requestId (RFC-0007 confirmation semantics):
// 32 lowercase hex; injectable rng for tests.
export function createDeleteRequestId(random) {
  const bytes = new Uint8Array(16);
  if (typeof random === "function") {
    for (let index = 0; index < 16; index += 1) bytes[index] = random();
  } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    throw new Error("no randomness source for the delete requestId");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Every health dimension appears independently; capabilityEvidence is
// shown separately from the active capability set.
export function healthBadges(node) {
  const health = node?.health ?? {};
  const identity = node?.runtimeIdentity ?? {};
  return [
    { dimension: "registryContact", value: health.registryContact ?? "unknown" },
    { dimension: "dshHealthy", value: health.dshHealthy ?? "unknown" },
    { dimension: "orbitCompatible", value: health.orbitCompatible ?? "unknown" },
    { dimension: "reachable", value: health.reachable ?? "unknown" },
    { dimension: "authenticated", value: health.authenticated ?? "unknown" },
    { dimension: "state", value: node?.state ?? "unknown" },
  ];
}

function mapReverseTransition(transition) {
  if (!transition || typeof transition !== "object") return null;
  return {
    at: transition.at ?? null,
    event: transition.event ?? null,
    routeReady: typeof transition.routeReady === "boolean" ? transition.routeReady : null,
    reason: transition.reason ?? null,
  };
}

export function mapNodeRow(node) {
  const health = node?.health ?? {};
  const runtime = node?.runtimeIdentity ?? {};
  return {
    nodeId: node?.nodeId ?? null,
    state: node?.state ?? "unknown",
    routeMode: node?.routeMode ?? "direct",
    activeFlows: typeof node?.activeFlows === "number" ? node.activeFlows : 0,
    targetScope: node?.nodeId
      ? {
          targetNodeId: node.nodeId,
          label: node.displayName
            ? `target: ${node.displayName} (${node.nodeId.slice(0, 13)}…)`
            : `target: ${node.nodeId.slice(0, 13)}…`,
        }
      : null,
    reversePresence: node?.reversePresence ?? null,
    reverseRouteReady: typeof node?.reverseRouteReady === "boolean" ? node.reverseRouteReady : null,
    reverseReason: node?.reverseReason ?? null,
    lastReverseTransition: mapReverseTransition(node?.lastReverseTransition),
    health: {
      registryContact: health.registryContact ?? "unknown",
      dshHealthy: health.dshHealthy ?? "unknown",
      orbitCompatible: health.orbitCompatible ?? "unknown",
      reachable: health.reachable ?? "unknown",
      authenticated: health.authenticated ?? "unknown",
      capabilitiesStale: health.capabilitiesStale === true,
      capabilities: Array.isArray(health.capabilities) ? health.capabilities.map((entry) => entry.name).sort() : [],
      capabilityEvidence: Array.isArray(health.capabilityEvidence) ? health.capabilityEvidence.map((entry) => entry.name).sort() : [],
      alertFlags: Array.isArray(health.alertFlags) ? health.alertFlags : [],
      lastSeen: health.lastSeen ?? null,
      lastSeenSource: health.lastSeenSource ?? null,
      lastHeartbeatAt: health.lastHeartbeatAt ?? null,
    },
    runtimeIdentity: {
      orbitVersion: runtime.orbitVersion ?? null,
      orbitRevision: runtime.orbitRevision ?? null,
      dshVersion: runtime.dshVersion ?? null,
      compatibilityProfile: runtime.compatibilityProfile ?? null,
    },
    routeTarget: node?.routeTarget
      ? {
          origin: node.routeTarget.origin ?? node.routeTarget.routeTargetOrigin ?? null,
          createdAt: node.routeTarget.createdAt ?? null,
          updatedAt: node.routeTarget.updatedAt ?? null,
        }
      : null,
    tombstonedAt: node?.tombstonedAt ?? null,
    tombstoneReason: node?.tombstoneReason ?? null,
  };
}

export function mapNodeList(nodes, activeSessions = null) {
  if (!Array.isArray(nodes)) return EMPTY_NODES_STATE;
  if (nodes.length === 0) return EMPTY_NODES_STATE;
  return {
    kind: "nodes",
    rows: nodes.map(mapNodeRow),
    activeSessions: activeSessions && typeof activeSessions === "object"
      ? {
          totalFlows: typeof activeSessions.totalFlows === "number" ? activeSessions.totalFlows : 0,
          distinctNodes: typeof activeSessions.distinctNodes === "number" ? activeSessions.distinctNodes : 0,
        }
      : null,
  };
}

export function mapOverview(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes.map(mapNodeRow) : [];
  const activeSessions = payload?.activeSessions;
  return {
    kind: "overview",
    nodes,
    activeSessions: activeSessions && typeof activeSessions === "object"
      ? {
          totalFlows: typeof activeSessions.totalFlows === "number" ? activeSessions.totalFlows : 0,
          distinctNodes: typeof activeSessions.distinctNodes === "number" ? activeSessions.distinctNodes : 0,
        }
      : null,
  };
}

export function mapNodeDetail(node) {
  const row = mapNodeRow(node);
  return {
    ...row,
    latestReport: node?.latestReport
      ? {
          uploadedAt: node.latestReport.uploadedAt ?? null,
          orbitVersion: node.latestReport.orbit?.version ?? null,
          orbitRevision: node.latestReport.orbit?.revision ?? null,
          dshVersion: node.latestReport.candidate?.dshVersion ?? null,
          compatibilityProfile: node.latestReport.candidate?.profile ?? null,
          compatibility: node.latestReport.compatibility ?? null,
        }
      : null,
    events: Array.isArray(node?.events)
      ? node.events.map((event) => ({
          at: event.at ?? null,
          dimension: event.dimension ?? null,
          from: event.from ?? null,
          to: event.to ?? null,
          source: event.source ?? null,
        }))
      : [],
  };
}

export function mapTokenRow(token) {
  return {
    tokenId: token?.tokenId ?? null,
    purpose: token?.purpose ?? null,
    boundNodeId: token?.boundNodeId ?? null,
    status: token?.status ?? null,
    createdAt: token?.createdAt ?? null,
    expiresAt: token?.expiresAt ?? null,
    consumedAt: token?.consumedAt ?? null,
  };
}

export function mapTokenList(tokens) {
  if (!Array.isArray(tokens)) return EMPTY_TOKENS_STATE;
  if (tokens.length === 0) return EMPTY_TOKENS_STATE;
  return { kind: "tokens", rows: tokens.map(mapTokenRow) };
}

// Token minting contract: the plaintext exists exactly once, in the
// mint response; the view-model never stores or re-renders it later.
export function mapTokenMint(minted) {
  return {
    tokenId: minted?.tokenId ?? null,
    plaintextOnce: typeof minted?.token === "string" ? minted.token : null,
    purpose: minted?.purpose ?? null,
    boundNodeId: minted?.boundNodeId ?? null,
    expiresAt: minted?.expiresAt ?? null,
  };
}

export function mapDeleteResult(result) {
  return {
    nodeId: result?.nodeId ?? null,
    state: result?.state ?? null,
    idempotentReplay: result?.idempotentReplay === true,
  };
}

const toNonNegativeInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function mapFleetJobRow(job) {
  const summary = job?.summary ?? {};
  const total = toNonNegativeInt(summary.totalTargets);
  const completed = toNonNegativeInt(summary.completed);
  const failed = toNonNegativeInt(summary.failed);
  const timeout = toNonNegativeInt(summary.timeout);
  const unreachable = toNonNegativeInt(summary.unreachable);
  const skipped = toNonNegativeInt(summary.skipped);
  const settled = completed + failed + timeout + unreachable + skipped;
  const status = job?.status ?? job?.state ?? "pending";
  const isCompleted = status === "completed";
  const progressPercent =
    total > 0
      ? Math.min(100, Math.max(0, Math.round((settled / total) * 100)))
      : isCompleted
        ? 100
        : 0;

  const finishedAt = job?.finishedAt ?? job?.completedAt ?? null;

  return {
    jobId: job?.jobId ?? null,
    taskType: job?.taskType ?? "diagnostic",
    status,
    state: status,
    createdAt: job?.createdAt ?? null,
    updatedAt: job?.updatedAt ?? null,
    startedAt: job?.startedAt ?? null,
    finishedAt,
    completedAt: finishedAt,
    totalTargets: total,
    completed,
    failed,
    timeout,
    unreachable,
    skipped,
    settled,
    progressPercent,
    targetSpec: job?.targetSpec ?? null,
  };
}

export function mapFleetJobList(jobs) {
  if (!Array.isArray(jobs)) return EMPTY_FLEET_JOBS_STATE;
  if (jobs.length === 0) return EMPTY_FLEET_JOBS_STATE;
  return {
    kind: "fleet-jobs",
    rows: jobs.map(mapFleetJobRow),
    totalJobs: jobs.length,
  };
}

export function mapFleetJobDetail(job) {
  const base = mapFleetJobRow(job);
  const results = job?.results && typeof job.results === "object" ? job.results : {};
  const nodeResults = Object.entries(results).map(([nodeId, res]) => ({
    nodeId,
    status: res?.status ?? "pending",
    exitCode: Number.isFinite(res?.exitCode) ? Math.floor(res.exitCode) : null,
    durationMs: Number.isFinite(res?.durationMs) && res.durationMs >= 0 ? Math.floor(res.durationMs) : null,
    startedAt: res?.startedAt ?? null,
    finishedAt: res?.finishedAt ?? res?.completedAt ?? null,
    completedAt: res?.finishedAt ?? res?.completedAt ?? null,
    stdout: typeof res?.stdout === "string" ? res.stdout : "",
    stderr: typeof res?.stderr === "string" ? res.stderr : "",
    error: res?.error ?? null,
  }));

  const timeoutMs =
    Number.isFinite(job?.timeoutMs) && job.timeoutMs > 0
      ? Math.floor(job.timeoutMs)
      : Number.isFinite(job?.payload?.timeoutMs) && job.payload.timeoutMs > 0
        ? Math.floor(job.payload.timeoutMs)
        : null;

  return {
    ...base,
    payload: job?.payload ?? null,
    timeoutMs,
    nodeResults,
  };
}

export const EMPTY_SCHEDULES_STATE = Object.freeze({
  kind: "fleet-schedules",
  rows: Object.freeze([]),
  totalSchedules: 0,
});

export function mapScheduleRow(schedule) {
  const scheduleId = typeof schedule?.scheduleId === "string" ? schedule.scheduleId : "";
  const name = typeof schedule?.name === "string" ? schedule.name : "Unnamed Schedule";
  const description = typeof schedule?.description === "string" ? schedule.description : "";
  const scheduleType = typeof schedule?.scheduleType === "string" ? schedule.scheduleType : "cron";
  const triggerRule =
    scheduleType === "cron"
      ? (typeof schedule?.cronExpression === "string" ? schedule.cronExpression : "* * * * *")
      : scheduleType === "interval"
        ? (Number.isFinite(schedule?.intervalMs) ? `every ${schedule.intervalMs}ms` : "interval")
        : "once";
  const taskType = typeof schedule?.taskType === "string" ? schedule.taskType : "diagnostic";
  const status = typeof schedule?.status === "string" ? schedule.status : "active";
  const concurrencyPolicy = typeof schedule?.concurrencyPolicy === "string" ? schedule.concurrencyPolicy : "forbid";
  const missedRunPolicy = typeof schedule?.missedRunPolicy === "string" ? schedule.missedRunPolicy : "skip";
  const nextRunAt = typeof schedule?.nextRunAt === "string" ? schedule.nextRunAt : "-";
  const lastRunAt = typeof schedule?.lastRunAt === "string" ? schedule.lastRunAt : "-";
  const totalRuns = toNonNegativeInt(schedule?.totalRuns);
  const maxRuns = Number.isFinite(schedule?.maxRuns) ? Math.floor(schedule.maxRuns) : null;
  const createdAt = typeof schedule?.createdAt === "string" ? schedule.createdAt : "";
  const createdBy = typeof schedule?.createdBy === "string" ? schedule.createdBy : "operator";

  return {
    scheduleId,
    name,
    description,
    scheduleType,
    triggerRule,
    taskType,
    status,
    concurrencyPolicy,
    missedRunPolicy,
    nextRunAt,
    lastRunAt,
    totalRuns,
    maxRuns,
    createdAt,
    createdBy,
    targetSpec: schedule?.targetSpec ?? null,
  };
}

export function mapScheduleList(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) return EMPTY_SCHEDULES_STATE;
  return {
    kind: "fleet-schedules",
    rows: schedules.map(mapScheduleRow),
    totalSchedules: schedules.length,
  };
}
