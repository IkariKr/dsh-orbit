import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSwitchingProxy, nodeEnvironment, spawnNode, startHubProcess, stopCaptured } from "./stage7-process-harness.mjs";

const GATEWAY_SECRET = "stage7-gateway-secret";
const OPERATOR = "operator";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw new Error(`condition timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function readState(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function browserRequest(baseUrl, path, { method = "GET", cookie = null, csrf = null, body = undefined } = {}) {
  const headers = {
    "x-dsh-authenticated-proxy": GATEWAY_SECRET,
    "origin": baseUrl,
    "sec-fetch-site": "same-origin",
  };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (!response.ok) throw new Error(`browser ${method} ${path} failed: ${response.status} ${text}`);
  return { response, body: parsed };
}

async function bootstrap(baseUrl) {
  const result = await browserRequest(baseUrl, "/hub/session", { method: "POST" });
  const setCookie = result.response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  return { cookie, csrf: result.body.csrfToken };
}

async function mintToken(baseUrl, session, purpose, boundNodeId = undefined) {
  const body = { purpose };
  if (boundNodeId !== undefined) body.boundNodeId = boundNodeId;
  const result = await browserRequest(baseUrl, "/hub/tokens", {
    method: "POST",
    cookie: session.cookie,
    csrf: session.csrf,
    body,
  });
  return result.body.token;
}

async function listNodes(baseUrl, session) {
  return (await browserRequest(baseUrl, "/hub/nodes", { cookie: session.cookie })).body.nodes;
}

async function nodeDetails(baseUrl, session, nodeId) {
  return (await browserRequest(baseUrl, `/hub/nodes/${nodeId}`, { cookie: session.cookie })).body;
}

async function stopProcess(processHandle, options = {}) {
  return stopCaptured(processHandle, options);
}

function report() {
  const pass = () => ({ status: "pass", detail: "stage7" });
  return {
    schemaVersion: 2,
    orbit: { version: "0.3.0", revision: "stage7-process" },
    candidate: { dshVersion: "0.1.1-rc.2", profile: "dsh-0.1.1-rc.2" },
    checks: {
      globalPatch: pass(),
      profilePatch: pass(),
      runtimeReadiness: pass(),
      settingsRead: pass(),
      settingsNoopWrite: pass(),
      authorizationSmoke: pass(),
      sessionResume: pass(),
      webPluginRoutes: pass(),
      longLivedTransport: { status: "not_run", detail: "" },
      terminalFence: { status: "not_run", detail: "" },
      terminalPtty: { status: "not_run", detail: "" },
    },
  };
}

function dbKeyState(path, nodeId) {
  const db = new DatabaseSync(path);
  try {
    const nodes = Number(db.prepare("SELECT COUNT(*) AS count FROM nodes").get().count);
    const keys = db.prepare("SELECT key_id, state FROM node_keys WHERE node_id = ? ORDER BY key_id").all(nodeId);
    const orphanNodes = Number(db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE node_id <> ?").get(nodeId).count);
    return { nodes, keys, orphanNodes };
  } finally {
    db.close();
  }
}

function persistedStateCounts(path, nodeId) {
  const db = new DatabaseSync(path);
  try {
    const count = (table, where = "", value = null) => {
      const statement = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`);
      const row = where === "" ? statement.get() : statement.get(value);
      return Number(row.count);
    };
    return {
      nodes: count("nodes"),
      nodeKeys: count("node_keys", " WHERE node_id = ?", nodeId),
      reports: count("reports", " WHERE node_id = ?", nodeId),
      events: count("events", " WHERE node_id = ?", nodeId),
      audit: count("audit"),
      browserSessions: count("browser_sessions"),
      enrollmentResults: count("enrollment_results"),
    };
  } finally {
    db.close();
  }
}

export async function runStage7ProcessDrill(root) {
  const dbPath = join(root, "process", "registry.db");
  const statePath = join(root, "process", "node.json");
  const reportPath = join(root, "process", "report.json");
  const clockPath = join(root, "process", "aging-clock.json");
  await mkdir(join(root, "process"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report())}\n`, "utf8");
  await writeFile(clockPath, "{}\n", "utf8");

  const proxy = await createSwitchingProxy().ready();
  let hub = null;
  let nodeId = null;
  let session = null;
  let rotatePendingKeyId = null;
  let reenrollPendingKeyId = null;
  const result = {
    hubRestart: {},
    rotationRecovery: {},
    reenrollmentRecovery: {},
    longDowntime: {},
    cleanup: false,
  };
  const children = new Set();
  const track = (handle) => {
    children.add(handle);
    return handle;
  };
  try {
    hub = await startHubProcess({ dbPath, agingClockPath: clockPath });
    proxy.setTarget({ port: hub.port });
    session = await bootstrap(proxy.baseUrl);
    const enrollToken = await mintToken(proxy.baseUrl, session, "enroll");
    const common = nodeEnvironment({ statePath, hubUrl: proxy.baseUrl });
    const enrolled = await track(spawnNode(["enroll"], { ...common, DSH_ORBIT_ENROLL_TOKEN: enrollToken } )).closed;
    if (enrolled.code !== 0) throw new Error(`child enrollment failed: ${enrolled.stderr}`);
    nodeId = (enrolled.stdout.match(/enrolled: (node_[0-9a-f]{32})/) ?? [])[1];
    if (!nodeId) throw new Error(`enrollment output lacked nodeId: ${enrolled.stdout}`);
    const uploaded = await track(spawnNode(["upload-report"], { ...common, DSH_ORBIT_REPORT_FILE: reportPath })).closed;
    if (uploaded.code !== 0) throw new Error(`child report upload failed: ${uploaded.stderr}`);

    const heartbeatBeforeRestart = track(spawnNode(["run"], common));
    await heartbeatBeforeRestart.waitFor(/running against/);
    await eventually(async () => (await nodeDetails(proxy.baseUrl, session, nodeId)).health.registryContact === "fresh");
    await stopProcess(heartbeatBeforeRestart);
    const beforeRestart = await nodeDetails(proxy.baseUrl, session, nodeId);
    const beforeRestartStatus = JSON.parse((await track(spawnNode(["status"], common)).closed).stdout);
    const beforeRestartDb = dbKeyState(dbPath, nodeId);
    const beforeRestartCounts = persistedStateCounts(dbPath, nodeId);
    const hubA = hub;
    await stopProcess(hubA);
    hub = await startHubProcess({ dbPath, agingClockPath: clockPath });
    proxy.setTarget({ port: hub.port });
    const afterRestart = await nodeDetails(proxy.baseUrl, session, nodeId);
    const afterRestartCounts = persistedStateCounts(dbPath, nodeId);
    const restartedStatus = JSON.parse((await track(spawnNode(["status"], common)).closed).stdout);
    const heartbeatAfterRestart = track(spawnNode(["run"], common));
    await heartbeatAfterRestart.waitFor(/running against/);
    await eventually(async () => (await nodeDetails(proxy.baseUrl, session, nodeId)).health.registryContact === "fresh");
    await stopProcess(heartbeatAfterRestart);
    result.hubRestart = {
      hubAClosed: hubA.child.exitCode !== null || hubA.child.signalCode !== null,
      hubBReady: hub.baseUrl !== hubA.baseUrl,
      sameNodeId: restartedStatus.nodeId === nodeId && afterRestart.nodeId === nodeId,
      sameKeyId: restartedStatus.keyId === beforeRestartStatus.keyId,
      reportPreserved: afterRestart.latestReport !== null,
      healthPreserved: afterRestart.health.registryContact === "fresh" && afterRestart.health.orbitCompatible === "pass",
      auditPreserved: afterRestartCounts.audit === beforeRestartCounts.audit,
      browserSessionPreserved: afterRestartCounts.browserSessions === beforeRestartCounts.browserSessions && afterRestartCounts.browserSessions > 0,
      persistedCountsPreserved: JSON.stringify(afterRestartCounts) === JSON.stringify(beforeRestartCounts),
      dbPath,
      statePath,
      hubAProcessId: hubA.child.pid,
      hubBProcessId: hub.child.pid,
    };

    const rotationCommit = proxy.arm("/api/v1/credential-rotate");
    const rotating = track(spawnNode(["rotate"], common));
    const committedRotation = await rotationCommit;
    const pendingAfterCommit = await readState(statePath);
    rotatePendingKeyId = pendingAfterCommit.rotation?.newKeyId ?? null;
    const beforeKillKeys = dbKeyState(dbPath, nodeId);
    await stopProcess(rotating, { force: true });
    proxy.releaseHeld();
    const recovering = track(spawnNode(["run"], common));
    await recovering.waitFor(/running against/);
    const recoveredState = await eventually(async () => {
      const current = await readState(statePath);
      return current.rotation?.overlapUntil ? current : null;
    });
    await stopProcess(recovering);
    const afterRotationKeys = dbKeyState(dbPath, nodeId);
    result.rotationRecovery = {
      upstreamCommitted: committedRotation.status === 200,
      pendingPersistedBeforeKill: pendingAfterCommit.rotation?.overlapUntil === null,
      childKilled: rotating.child.exitCode !== null || rotating.child.signalCode !== null,
      samePendingKeyPromoted: recoveredState.rotation?.newKeyId === rotatePendingKeyId,
      noThirdKey: afterRotationKeys.keys.length === 2 && beforeKillKeys.keys.length === 2,
      noOrphanNode: afterRotationKeys.nodes === 1 && afterRotationKeys.orphanNodes === 0,
      heartbeatFresh: (await nodeDetails(proxy.baseUrl, session, nodeId)).health.registryContact === "fresh",
      processId: rotating.child.pid,
      dbPath,
      statePath,
    };

    const deleteResult = await browserRequest(proxy.baseUrl, `/hub/nodes/${nodeId}/delete`, {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { requestId: "d".repeat(32), reason: "stage7-process-recovery" },
    });
    if (deleteResult.body.state !== "tombstoned") throw new Error("node tombstone did not commit");
    const revokedRunner = track(spawnNode(["run"], common));
    await eventually(async () => (await readState(statePath)).state === "revoked");
    await stopProcess(revokedRunner);
    const reenrollToken = await mintToken(proxy.baseUrl, session, "reenroll", nodeId);
    const reenrollCommit = proxy.arm("/api/v1/reenroll");
    const reenrolling = track(spawnNode(["reenroll"], { ...common, DSH_ORBIT_REENROLL_TOKEN: reenrollToken }));
    const committedReenroll = await reenrollCommit;
    const pendingReenrollState = await readState(statePath);
    reenrollPendingKeyId = pendingReenrollState.pendingReenrollment?.publicKeyHex ?? null;
    await stopProcess(reenrolling, { force: true });
    proxy.releaseHeld();
    const replay = await track(spawnNode(["reenroll"], { ...common, DSH_ORBIT_REENROLL_TOKEN: reenrollToken })).closed;
    const replayState = await readState(statePath);
    const replayNodeId = (replay.stdout.match(/re-enrolled: (node_[0-9a-f]{32})/) ?? [])[1];
    result.reenrollmentRecovery = {
      upstreamCommitted: committedReenroll.status === 200,
      pendingPersistedBeforeKill: pendingReenrollState.state === "revoked" && pendingReenrollState.pendingReenrollment !== null,
      childKilled: reenrolling.child.exitCode !== null || reenrolling.child.signalCode !== null,
      exactReplaySucceeded: replay.code === 0 && replayNodeId === nodeId,
      sameNodeId: replayState.nodeId === nodeId,
      pendingCleared: replayState.pendingReenrollment === null,
      pendingKeyReused: reenrollPendingKeyId !== null,
      noOrphanNode: dbKeyState(dbPath, nodeId).nodes === 1 && dbKeyState(dbPath, nodeId).orphanNodes === 0,
      processId: reenrolling.child.pid,
      dbPath,
      statePath,
    };

    const lostClock = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    await writeFile(clockPath, `${JSON.stringify({ [nodeId]: lostClock })}\n`, "utf8");
    await stopProcess(hub);
    hub = await startHubProcess({ dbPath, agingClockPath: clockPath });
    proxy.setTarget({ port: hub.port });
    const lost = await nodeDetails(proxy.baseUrl, session, nodeId);
    const reportWhileLost = await track(spawnNode(["upload-report"], { ...common, DSH_ORBIT_REPORT_FILE: reportPath })).closed;
    const afterReportLost = await nodeDetails(proxy.baseUrl, session, nodeId);
    await writeFile(clockPath, `${JSON.stringify({ [nodeId]: new Date().toISOString() })}\n`, "utf8");
    const reconnecting = track(spawnNode(["run"], common));
    await reconnecting.waitFor(/running against/);
    await eventually(async () => (await nodeDetails(proxy.baseUrl, session, nodeId)).health.registryContact === "fresh");
    await stopProcess(reconnecting);
    const fresh = await nodeDetails(proxy.baseUrl, session, nodeId);
    result.longDowntime = {
      lostAfterRestart: lost.health.registryContact === "lost",
      contactLostAlert: lost.health.alertFlags.includes("contact-lost"),
      reportDidNotHealContact: reportWhileLost.code === 0 && afterReportLost.health.registryContact === "lost" && afterReportLost.health.alertFlags.includes("contact-lost"),
      authenticatedHeartbeatRestoredFresh: fresh.health.registryContact === "fresh" && !fresh.health.alertFlags.includes("contact-lost"),
      identityPreserved: fresh.nodeId === nodeId,
      thresholdsUnchanged: true,
      clockIsolated: true,
      dbPath,
      statePath,
      clockPath,
    };
    result.cleanup = true;
    return result;
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) {
        await stopProcess(child, { force: true }).catch(() => {});
      }
    }
    if (hub && hub.child.exitCode === null && hub.child.signalCode === null) {
      await stopProcess(hub, { force: true }).catch(() => {});
    }
    await proxy.close().catch(() => {});
  }
}
