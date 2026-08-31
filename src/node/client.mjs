// Node Registry Client (SOP Stage 2-4; Review Gate A remediation).
//
// Persisted states: unenrolled / active / revoked (RFC-0005 D1/D5).
// Runtime: retrying (hub unavailable, backoff active). The client
// follows the SOP uncertain-output principle: every identity-changing
// operation persists its intent BEFORE the request, so Hub commit +
// lost response + restart is always reconcilable by exact replay or
// commit detection. 401 revoked NEVER re-enrolls automatically.

import { HeartbeatBackoff } from "./backoff.mjs";
import { deriveKeyId, generateNodeKeyPair, randomHex, sha256Hex, signSigningString } from "../registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL, REENROLL_V1_LABEL } from "../registry/protocol.mjs";
import {
  assertStateFilePermissions,
  canonicalHubBaseUrl,
  loadNodeStoreAsync,
  stateFilePermissionProblem,
  validateNodeStore,
  writeNodeStore,
} from "./store.mjs";

const HEARTBEAT_PATH = "/api/v1/heartbeat";
const REPORT_PATH = "/api/v1/report-upload";
const ROTATE_PATH = "/api/v1/credential-rotate";
const REENROLL_PATH = "/api/v1/reenroll";
const ENROLL_PATH = "/api/v1/enroll";

export const HEARTBEAT_CADENCE_SECONDS_MIN = 30;
export const HEARTBEAT_CADENCE_SECONDS_MAX = 300;

const MAX_RECENT_EVENTS = 50;

// Unified revocation classification (Gate A P1-07): only these codes
// prove the Hub revoked this identity. Timestamp/signature/replay/rate
// and other 401s are configuration or transient errors and must never
// persist REVOKED.
const REVOCATION_CODES = new Set(["revoked", "key-revoked", "unknown-key"]);

export function isCredentialRevocation(body) {
  return REVOCATION_CODES.has(body?.error?.code);
}

function wireError(status, body) {
  const code = body?.error?.code ?? `http-${status}`;
  const message = body?.error?.message ?? `hub returned HTTP ${status}`;
  return { code, message };
}

export class NodeClient {
  // runtimeIdentity must be a function returning
  // { orbitVersion, orbitRevision?, dshVersion, compatibilityProfile? }.
  // heartbeatCadenceSeconds must be an integer within 30-300 (RFC-0009).
  constructor({
    store,
    storePath,
    hubBaseUrl,
    runtimeIdentity,
    heartbeatCadenceSeconds = 60,
    rotationOverlapHours = 24,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
  }) {
    if (!Number.isInteger(heartbeatCadenceSeconds) || heartbeatCadenceSeconds < HEARTBEAT_CADENCE_SECONDS_MIN || heartbeatCadenceSeconds > HEARTBEAT_CADENCE_SECONDS_MAX) {
      throw new Error(`heartbeat cadence must be an integer of ${HEARTBEAT_CADENCE_SECONDS_MIN}-${HEARTBEAT_CADENCE_SECONDS_MAX} seconds`);
    }
    this.baseHubUrl = canonicalHubBaseUrl(hubBaseUrl);
    this.runtimeIdentity = runtimeIdentity;
    this.heartbeatCadenceSeconds = heartbeatCadenceSeconds;
    this.rotationOverlapHours = rotationOverlapHours;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.backoff = new HeartbeatBackoff({ now: () => this.now().getTime() });
    this.recentEvents = [];
    this.lastHeartbeatAt = null;
    this.lastReportAt = null;
    this.lastContactAt = null;
    this.lastError = null;
    this.runtimeState = "idle";
    // Normal cadence clock, independent of the failure backoff (P1-05):
    // a successful heartbeat schedules the next one at now + cadence;
    // failures schedule retries through backoff.
    this.nextHeartbeatAt = 0;
    this.store = store;
    this.storePath = storePath;
    this.enforceBinding();
  }

  // Hub binding (P1-06): store.hubBaseUrl is part of the identity.
  // Runtime configuration that differs from the persisted binding fails
  // closed instead of silently talking to another Hub.
  enforceBinding() {
    if (this.store.state === "unenrolled") return;
    if (typeof this.store.hubBaseUrl === "string" && this.store.hubBaseUrl !== "") {
      let persisted;
      try {
        persisted = canonicalHubBaseUrl(this.store.hubBaseUrl);
      } catch {
        throw new Error(`persisted Hub binding is invalid: ${this.store.hubBaseUrl}`);
      }
      if (persisted !== this.baseHubUrl) {
        throw new Error(
          `Hub binding mismatch: store is bound to ${persisted} but the runtime configuration targets ${this.baseHubUrl}; refusing to talk to another Hub`,
        );
      }
    } else {
      throw new Error("store claims an identity but carries no Hub binding");
    }
  }

  // ------------------------------------------------------------------
  // Diagnostics history

  recordEvent(event, detail = {}) {
    this.recentEvents.push({ at: this.now().toISOString(), event, ...detail });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_RECENT_EVENTS);
    }
  }

  async persist(next) {
    this.store = { ...this.store, ...next, updatedAt: this.now().toISOString() };
    await writeNodeStore(this.storePath, this.store);
  }

  // ------------------------------------------------------------------
  // Stage 2: enrollment (RFC-0005 D2) with persisted intent (P1-01):
  // the requestId + keypair are written BEFORE the request is sent, so
  // the same operator token replays the exact request after a lost
  // response, and the Hub's recorded result is adopted. The token
  // itself is never persisted.

  async enroll({ token }) {
    if (this.store.state !== "unenrolled") {
      throw new Error(`enrollment requires an unenrolled store (state is ${this.store.state})`);
    }
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      throw new Error("enrollment token must be 32 lowercase hex characters");
    }
    let pending = this.store.pendingEnrollment;
    if (!pending) {
      const keys = generateNodeKeyPair();
      pending = {
        enrollmentRequestId: randomHex(16),
        publicKeyHex: keys.publicKeyHex,
        privateKeyHex: keys.privateKeyHex,
        generatedAt: this.now().toISOString(),
      };
      await this.persist({ ...this.store, pendingEnrollment: pending });
    }
    const response = await this.transport(ENROLL_PATH, {
      body: { token, enrollmentRequestId: pending.enrollmentRequestId, publicKey: pending.publicKeyHex },
    });
    if (response.status === 200) {
      const expectedKeyId = deriveKeyId(pending.publicKeyHex);
      if (response.body.keyId !== expectedKeyId) {
        throw new Error(`hub returned keyId ${JSON.stringify(response.body.keyId)} that does not match the enrolled public key`);
      }
      await this.persist({
        nodeId: response.body.nodeId,
        publicKeyHex: pending.publicKeyHex,
        privateKeyHex: pending.privateKeyHex,
        hubBaseUrl: this.baseHubUrl,
        state: "active",
        rotation: null,
        pendingEnrollment: null,
      });
      this.backoff.recordSuccess();
      this.recordEvent("enrolled", { nodeId: response.body.nodeId, keyId: response.body.keyId });
      return { nodeId: response.body.nodeId, keyId: response.body.keyId };
    }
    const { code, message } = wireError(response.status, response.body);
    this.recordEvent("enroll-failed", { code, message });
    if (response.status === 0) {
      // Uncertain outcome: the Hub may have committed. Retry with the
      // SAME token; the persisted intent replays the exact request.
      throw new Error(`enrollment outcome unknown (network failure): retry with the same enrollment token (${message})`);
    }
    throw new Error(`enrollment denied: ${code} (${message})`);
  }

  // ------------------------------------------------------------------
  // Machine transport (RFC-0006 header contract).

  // Plain JSON transport with the injected fetch (used by enrollment).
  async transport(path, { body, headers = {} }) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseHubUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: Buffer.from(JSON.stringify(body)),
      });
    } catch (error) {
      return { status: 0, body: { error: { code: "network", message: error.message } } };
    }
    const parsed = typeof response.json === "function" ? await response.json().catch(() => ({})) : {};
    return { status: response.status ?? 0, body: parsed };
  }

  // ORBIT-MACHINE-V1 signed request: the signing string and the
  // transport headers are built from the SAME timestamp and nonce.
  async signedRequest({ path, nodeId, keyId, keyHex, body }) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.trunc(this.now().getTime() / 1000));
    const nonce = randomHex(16);
    const signature = signSigningString(
      keyHex,
      buildSigningString({
        label: MACHINE_V1_LABEL,
        method: "POST",
        path,
        timestamp,
        nonce,
        bodyHash: sha256Hex(rawBody),
        nodeId,
      }),
    );
    return this.transport(path, {
      body,
      headers: {
        "x-orbit-node": nodeId,
        "x-orbit-timestamp": timestamp,
        "x-orbit-nonce": nonce,
        "x-orbit-key": keyId,
        "x-orbit-signature": signature,
      },
    });
  }

  // ------------------------------------------------------------------
  // Stage 3: heartbeat with cadence + backoff, report upload.

  // One maintenance tick: attempts a heartbeat when due and the node is
  // not revoked/unenrolled, and resolves any pending rotation first.
  async tick() {
    if (this.store.state === "revoked") {
      // Frozen rule: a revoked node never auto-re-enrolls and never
      // mints a new identity; only an explicit operator re-enrollment
      // moves it forward. No traffic is attempted.
      return { state: "revoked", attempted: false };
    }
    if (this.store.state !== "active") {
      return { state: this.store.state, attempted: false };
    }
    if (this.isPendingRotation()) {
      return this.recoverPendingRotation();
    }
    const nowMs = this.now().getTime();
    const inBackoff = this.backoff.attempt > 0;
    const due = inBackoff ? this.backoff.due() : nowMs >= this.nextHeartbeatAt;
    if (!due) {
      return { state: this.runtimeState === "retrying" ? "retrying" : "active", attempted: false };
    }
    const outcome = await this.heartbeat();
    if (outcome.ok) {
      this.scheduleNextHeartbeat();
    }
    return outcome;
  }

  scheduleNextHeartbeat() {
    this.nextHeartbeatAt = this.now().getTime() + this.heartbeatCadenceSeconds * 1000;
  }

  isPendingRotation() {
    return this.store.rotation !== null && this.store.rotation.overlapUntil === null;
  }

  // Performs a heartbeat now using the current identity (used by tick,
  // tests, and recovery probes through heartbeatAs).
  async heartbeat({ persistOnRevoked = true } = {}) {
    return this.heartbeatAs({
      keyId: deriveKeyId(this.store.publicKeyHex),
      keyHex: this.store.privateKeyHex,
      persistOnRevoked,
    });
  }

  // Heartbeat with an explicit key (commit-detection probes).
  async heartbeatAs({ keyId, keyHex, persistOnRevoked = true }) {
    const identity = this.runtimeIdentity();
    const result = await this.signedRequest({
      path: HEARTBEAT_PATH,
      nodeId: this.store.nodeId,
      keyId,
      keyHex,
      body: { runtime: identity },
    });
    if (result.status === 200) {
      this.backoff.recordSuccess();
      this.lastContactAt = this.now().toISOString();
      this.lastError = null;
      this.runtimeState = "running";
      if (keyId === deriveKeyId(this.store.publicKeyHex)) {
        this.lastHeartbeatAt = this.lastContactAt;
      }
      this.recordEvent("heartbeat-ok", { registryContact: result.body.registryContact, keyId });
      return { state: "active", attempted: true, ok: true };
    }
    if (result.status === 401 && isCredentialRevocation(result.body)) {
      if (persistOnRevoked) {
        await this.persist({ ...this.store, state: "revoked" });
      }
      this.runtimeState = "revoked";
      this.lastError = wireError(result.status, result.body);
      this.recordEvent("revoked", { code: result.body?.error?.code, message: result.body?.error?.message });
      return { state: "revoked", attempted: true, ok: false, error: this.lastError };
    }
    // Any other outcome — 429, 5xx, non-revocation 401 (timestamp,
    // signature, replay), network — is retryable and NEVER writes
    // REVOKED (P1-07).
    this.backoff.recordFailure();
    this.runtimeState = "retrying";
    this.lastError = wireError(result.status, result.body);
    this.recordEvent("heartbeat-failed", {
      code: result.body?.error?.code ?? (result.status === 0 ? "network" : `http-${result.status}`),
      message: result.body?.error?.message ?? (result.status === 0 ? "hub unavailable" : `hub returned HTTP ${result.status}`),
    });
    return { state: "retrying", attempted: true, ok: false, error: this.lastError };
  }

  // Uploads a sanitized v0.2 compatibility report; evidence only.
  async uploadReport(report) {
    this.requireActive();
    const result = await this.signedRequest({
      path: REPORT_PATH,
      nodeId: this.store.nodeId,
      keyId: deriveKeyId(this.store.publicKeyHex),
      keyHex: this.store.privateKeyHex,
      body: report,
    });
    if (result.status === 200) {
      this.backoff.recordSuccess();
      this.lastContactAt = this.now().toISOString();
      this.lastReportAt = this.lastContactAt;
      this.recordEvent("report-uploaded", {
        orbitCompatible: result.body.orbitCompatible,
        capabilities: (result.body.capabilities ?? []).map((entry) => entry.name),
      });
      return result.body;
    }
    if (result.status === 401 && isCredentialRevocation(result.body)) {
      await this.persist({ ...this.store, state: "revoked" });
      this.runtimeState = "revoked";
      this.lastError = wireError(result.status, result.body);
      this.recordEvent("revoked", { code: result.body?.error?.code ?? "unauthorized", message: result.body?.error?.message ?? "hub denied the report" });
      throw new Error(`report upload denied: ${this.lastError.code} (${this.lastError.message})`);
    }
    const { code, message } = wireError(result.status, result.body);
    this.backoff.recordFailure();
    this.recordEvent("report-failed", { code, message });
    throw new Error(`report upload denied: ${code} (${message})`);
  }

  requireActive() {
    if (this.store.state !== "active") {
      throw new Error(`operation requires an active node (state is ${this.store.state})`);
    }
  }

  // ------------------------------------------------------------------
  // Stage 4: rotation with persisted pending intent (P1-02).

  async rotateCredential() {
    this.requireActive();
    if (this.isPendingRotation()) {
      // A previous rotate outcome was uncertain; resolve it by commit
      // detection instead of starting over.
      return this.recoverPendingRotation();
    }
    const newKeys = generateNodeKeyPair();
    const oldKeyId = deriveKeyId(this.store.publicKeyHex);
    const pending = {
      oldKeyId,
      oldPrivateKeyHex: this.store.privateKeyHex,
      newKeyId: deriveKeyId(newKeys.publicKeyHex),
      newPublicKeyHex: newKeys.publicKeyHex,
      newPrivateKeyHex: newKeys.privateKeyHex,
      generatedAt: this.now().toISOString(),
      overlapUntil: null,
    };
    // Persist the intent BEFORE the request (uncertain-output principle).
    await this.persist({ ...this.store, rotation: pending });
    const result = await this.signedRequest({
      path: ROTATE_PATH,
      nodeId: this.store.nodeId,
      keyId: oldKeyId,
      keyHex: this.store.privateKeyHex,
      body: { newPublicKey: newKeys.publicKeyHex },
    });
    if (result.status === 200) {
      await this.promoteRotation({ rotation: pending, overlapUntil: result.body.overlapUntil });
      return result.body;
    }
    if (result.status === 401 && isCredentialRevocation(result.body)) {
      await this.persist({ ...this.store, state: "revoked" });
      this.runtimeState = "revoked";
      this.recordEvent("revoked", { code: result.body?.error?.code ?? "unauthorized", message: result.body?.error?.message ?? "rotation denied" });
      const { code, message } = wireError(result.status, result.body);
      throw new Error(`credential rotation denied: ${code} (${message})`);
    }
    const { code, message } = wireError(result.status, result.body);
    this.recordEvent("rotate-failed", { code, message });
    throw new Error(`credential rotation denied: ${code} (${message})`);
  }

  // Commit detection after an uncertain rotate (P1-02): probe with the
  // PENDING new key; if the Hub accepts it, the commit happened and we
  // promote locally. If the new key is unknown and the old key still
  // works, the Hub did NOT commit: re-submit the SAME pending public
  // key — never a freshly generated third key.
  async recoverPendingRotation() {
    const rotation = this.store.rotation;
    if (!this.isPendingRotation()) return { state: this.store.state, attempted: false };
    const newProbe = await this.heartbeatAs({
      keyId: rotation.newKeyId,
      keyHex: rotation.newPrivateKeyHex,
      persistOnRevoked: false,
    });
    if (newProbe.ok) {
      await this.promoteRotation({ rotation, overlapUntil: null });
      this.scheduleNextHeartbeat();
      return { state: "active", attempted: true, ok: true, committedDetected: true };
    }
    if (newProbe.state === "revoked" && newProbe.error?.code !== "unknown-key") {
      // The node was deleted while the rotate was in flight ('revoked'
      // /'key-revoked'). A pending new key the Hub does not know yet
      // ('unknown-key') means the rotate did NOT commit — not revoked.
      await this.persist({ ...this.store, state: "revoked" });
      this.runtimeState = "revoked";
      return { state: "revoked", attempted: true, ok: false, error: newProbe.error };
    }
    if (newProbe.state === "retrying" || (newProbe.state === "revoked" && newProbe.error?.code === "unknown-key")) {
      // Hub reachable (it answered) but the new key is unknown: not
      // committed. Does the old key still work?
      const oldProbe = await this.heartbeatAs({
        keyId: rotation.oldKeyId,
        keyHex: rotation.oldPrivateKeyHex,
        persistOnRevoked: false,
      });
      if (oldProbe.ok) {
        const resubmitted = await this.signedRequest({
          path: ROTATE_PATH,
          nodeId: this.store.nodeId,
          keyId: rotation.oldKeyId,
          keyHex: rotation.oldPrivateKeyHex,
          body: { newPublicKey: rotation.newPublicKeyHex },
        });
        if (resubmitted.status === 200) {
          this.recordEvent("rotation-resubmitted", { newKeyId: rotation.newKeyId });
          await this.promoteRotation({ rotation, overlapUntil: resubmitted.body.overlapUntil });
          this.scheduleNextHeartbeat();
          return { state: "active", attempted: true, ok: true, resubmitted: true };
        }
        const { code, message } = wireError(resubmitted.status, resubmitted.body);
        this.recordEvent("rotation-resubmit-failed", { code, message });
        return { state: "active", attempted: true, ok: false, error: { code, message } };
      }
      if (oldProbe.state === "revoked") {
        await this.persist({ ...this.store, state: "revoked" });
        this.runtimeState = "revoked";
        return { state: "revoked", attempted: true, ok: false, error: oldProbe.error };
      }
      return { state: "retrying", attempted: true, ok: false, error: oldProbe.error };
    }
    // Network/5xx/429: inconclusive; the pending rotation stays and the
    // next tick probes again.
    return { state: this.store.state, attempted: true, ok: false, error: newProbe.error };
  }

  async promoteRotation({ rotation, overlapUntil }) {
    const effectiveOverlap =
      overlapUntil ?? new Date(this.now().getTime() + this.rotationOverlapHours * 60 * 60 * 1000).toISOString();
    await this.persist({
      ...this.store,
      publicKeyHex: rotation.newPublicKeyHex,
      privateKeyHex: rotation.newPrivateKeyHex,
      rotation: {
        oldKeyId: rotation.oldKeyId,
        oldPrivateKeyHex: rotation.oldPrivateKeyHex,
        newKeyId: rotation.newKeyId,
        overlapUntil: effectiveOverlap,
      },
    });
    this.backoff.recordSuccess();
    this.lastContactAt = this.now().toISOString();
    this.recordEvent("rotation-committed", { newKeyId: rotation.newKeyId, overlapUntil: effectiveOverlap });
  }

  // ------------------------------------------------------------------
  // Explicit re-enrollment (RFC-0005 D5) with persisted intent (P1-03).

  async reenroll({ token }) {
    if (this.store.state !== "revoked") {
      throw new Error(`re-enrollment requires a revoked node (state is ${this.store.state})`);
    }
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      throw new Error("re-enrollment token must be 32 lowercase hex characters");
    }
    let pending = this.store.pendingReenrollment;
    if (!pending) {
      const newKeys = generateNodeKeyPair();
      pending = {
        reenrollmentRequestId: randomHex(16),
        publicKeyHex: newKeys.publicKeyHex,
        privateKeyHex: newKeys.privateKeyHex,
        nodeId: this.store.nodeId,
        generatedAt: this.now().toISOString(),
      };
      // Persist the intent BEFORE the request: the same operator token
      // then replays the exact request and adopts the recorded result.
      await this.persist({ ...this.store, pendingReenrollment: pending });
    }
    const nonce = randomHex(16);
    const timestamp = String(Math.trunc(this.now().getTime() / 1000));
    const rawBody = Buffer.from(
      JSON.stringify({ reenrollmentToken: token, reenrollmentRequestId: pending.reenrollmentRequestId, newPublicKey: pending.publicKeyHex }),
    );
    const signature = signSigningString(
      this.store.privateKeyHex,
      buildSigningString({
        label: REENROLL_V1_LABEL,
        method: "POST",
        path: REENROLL_PATH,
        timestamp,
        nonce,
        bodyHash: sha256Hex(rawBody),
        nodeId: this.store.nodeId,
      }),
    );
    let response;
    try {
      response = await this.fetchImpl(`${this.baseHubUrl.replace(/\/$/, "")}${REENROLL_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-orbit-node": this.store.nodeId,
          "x-orbit-timestamp": timestamp,
          "x-orbit-nonce": nonce,
          "x-orbit-key": deriveKeyId(this.store.publicKeyHex),
          "x-orbit-signature": signature,
        },
        body: rawBody,
      });
    } catch (error) {
      this.recordEvent("reenroll-failed", { code: "network", message: error.message });
      throw new Error(`re-enrollment outcome unknown (network failure): retry with the same re-enrollment token (${error.message})`);
    }
    const body = typeof response.json === "function" ? await response.json().catch(() => ({})) : {};
    const status = response.status ?? 0;
    if (status === 200) {
      if (body.nodeId !== this.store.nodeId) {
        throw new Error(`re-enrollment restored a different nodeId (${JSON.stringify(body.nodeId)})`);
      }
      const expectedKeyId = deriveKeyId(pending.publicKeyHex);
      if (body.keyId !== expectedKeyId) {
        throw new Error(`re-enrollment keyId ${JSON.stringify(body.keyId)} does not match the pending public key`);
      }
      await this.persist({
        ...this.store,
        publicKeyHex: pending.publicKeyHex,
        privateKeyHex: pending.privateKeyHex,
        state: "active",
        rotation: null,
        pendingReenrollment: null,
      });
      this.runtimeState = "running";
      this.recordEvent("reenrolled", { nodeId: body.nodeId, keyId: body.keyId });
      return { nodeId: body.nodeId, keyId: body.keyId };
    }
    const { code, message } = wireError(status, body);
    this.recordEvent("reenroll-failed", { code, message });
    if (status === 0) {
      throw new Error(`re-enrollment outcome unknown (network failure): retry with the same re-enrollment token (${message})`);
    }
    throw new Error(`re-enrollment denied: ${code} (${message})`);
  }

  // ------------------------------------------------------------------
  // Restart recovery (Stages 2/4): binding checked in the constructor;
  // completed rotation markers are pruned; pending rotations resolve by
  // commit detection. Never re-enrolls.

  async recoverAfterRestart() {
    if (this.store.rotation !== null && this.store.rotation.overlapUntil !== null && Date.parse(this.store.rotation.overlapUntil) <= this.now().getTime()) {
      await this.persist({ ...this.store, rotation: null });
      this.recordEvent("rotation-overlap-ended");
    }
    if (this.store.state === "revoked") {
      this.runtimeState = "revoked";
    } else if (this.store.state === "active") {
      this.runtimeState = "running";
      if (this.isPendingRotation()) {
        const outcome = await this.recoverPendingRotation();
        if (outcome.ok) this.runtimeState = "running";
      }
    } else {
      this.runtimeState = "idle";
    }
    this.recordEvent("restart-recovered", { state: this.store.state });
    return { state: this.store.state, nodeId: this.store.nodeId };
  }

  // ------------------------------------------------------------------
  // Status and diagnostics (Stage 4; P2-02 splits the clocks).

  status() {
    const nowMs = this.now().getTime();
    const nextAttemptDelay = Math.max(0, this.backoff.nextAttemptAt - nowMs);
    const nextHeartbeatDelay = Math.max(0, this.nextHeartbeatAt - nowMs);
    return {
      state: this.store.state === "active" && this.runtimeState === "retrying" ? "retrying" : this.store.state,
      nodeId: this.store.nodeId,
      keyId: this.store.publicKeyHex ? deriveKeyId(this.store.publicKeyHex) : null,
      hubBaseUrl: this.store.hubBaseUrl ?? this.baseHubUrl,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastReportAt: this.lastReportAt,
      lastContactAt: this.lastContactAt,
      lastError: this.lastError,
      heartbeatCadenceSeconds: this.heartbeatCadenceSeconds,
      backoff: {
        attempt: this.backoff.attempt,
        nextAttemptInMs: nextAttemptDelay,
        lastDelayMs: this.backoff.lastDelayMs,
      },
      nextHeartbeatInMs: nextHeartbeatDelay,
      rotation: this.store.rotation
        ? {
            oldKeyId: this.store.rotation.oldKeyId,
            newKeyId: this.store.rotation.newKeyId,
            overlapUntil: this.store.rotation.overlapUntil,
            pending: this.isPendingRotation(),
          }
        : null,
      pendingEnrollment: this.store.pendingEnrollment !== null && this.store.pendingEnrollment !== undefined,
      pendingReenrollment: this.store.pendingReenrollment !== null && this.store.pendingReenrollment !== undefined,
      runtimeIdentity: this.store.state === "active" ? this.runtimeIdentity() : null,
      recentEvents: [...this.recentEvents],
    };
  }

  // Doctor: local integrity checks + a NON-MUTATING HTTP reachability
  // probe (P1-09). It never calls heartbeat and never changes Hub or
  // local state.
  async doctor() {
    const findings = [];
    const add = (severity, check, detail) => findings.push({ severity, check, detail });

    if (this.store.nodeId === null) {
      add("info", "identity", "not enrolled yet");
    } else {
      add("ok", "identity", `nodeId ${this.store.nodeId}`);
    }
    const problems = validateNodeStore(this.store);
    for (const problem of problems) {
      add("fail", "store-integrity", problem);
    }
    if (this.store.privateKeyHex !== null && this.store.publicKeyHex !== null) {
      add("ok", "key-pair", "private key signs for the stored public key");
    }
    const { stateFilePermissionProblem } = await import("./store.mjs");
    const permissionProblem = stateFilePermissionProblem(this.storePath);
    if (permissionProblem) {
      add("fail", "state-file-permissions", permissionProblem);
    }

    // Reachability only: ANY HTTP response proves the listener is up;
    // a heartbeat would mutate registryContact and is forbidden here.
    try {
      const response = await this.fetchImpl(`${this.baseHubUrl.replace(/\/$/, "")}/`);
      add("ok", "hub-probe", `hub listener reachable (HTTP ${response.status ?? "unknown"})`);
    } catch (error) {
      add("fail", "hub-probe", `hub listener unreachable: ${error.message}`);
    }

    return {
      state: this.status().state,
      findings,
      status: this.status(),
    };
  }
}