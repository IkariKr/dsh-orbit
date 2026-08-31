// Node Registry Client (SOP Stage 2-4): local identity, enrollment,
// heartbeat/report lifecycle, rotation, revocation handling, explicit
// re-enrollment, restart recovery, doctor/status.
//
// Persisted states: unenrolled / active / revoked (RFC-0005 D1/D5).
// Runtime states: retrying (hub unavailable, backoff active) and
// rotating (transient, with a persisted rotation marker for restart
// recovery). 401 revoked NEVER re-enrolls automatically and NEVER mints
// a new nodeId; recovery is explicit re-enrollment by the operator.

import { HeartbeatBackoff } from "./backoff.mjs";
import { deriveKeyId, generateNodeKeyPair, randomHex, sha256Hex, signSigningString, verifySigningString } from "../registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL, REENROLL_V1_LABEL } from "../registry/protocol.mjs";
import { loadNodeStoreAsync, validateNodeStore, writeNodeStore } from "./store.mjs";

const HEARTBEAT_PATH = "/api/v1/heartbeat";
const REPORT_PATH = "/api/v1/report-upload";
const ROTATE_PATH = "/api/v1/credential-rotate";
const REENROLL_PATH = "/api/v1/reenroll";
const ENROLL_PATH = "/api/v1/enroll";

const MAX_RECENT_EVENTS = 50;

function wireError(status, body) {
  const code = body?.error?.code ?? `http-${status}`;
  const message = body?.error?.message ?? `hub returned HTTP ${status}`;
  return { code, message };
}

export class NodeClient {
  // runtimeIdentity must be a function returning
  // { orbitVersion, orbitRevision?, dshVersion, compatibilityProfile? }.
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
    this.store = store;
    this.storePath = storePath;
    this.hubBaseUrl = hubBaseUrl;
    this.runtimeIdentity = runtimeIdentity;
    this.heartbeatCadenceSeconds = heartbeatCadenceSeconds;
    this.rotationOverlapHours = rotationOverlapHours;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.backoff = new HeartbeatBackoff({ now: () => this.now().getTime() });
    this.recentEvents = [];
    this.lastContactAt = null;
    this.lastError = null;
    this.runtimeState = "idle"; // idle | retrying | rotating | running
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
  // Stage 2: enrollment (RFC-0005 D2; digest-only token on the Hub,
  // plaintext provided by the operator exactly once).

  async enroll({ token }) {
    if (this.store.state !== "unenrolled") {
      throw new Error(`enrollment requires an unenrolled store (state is ${this.store.state})`);
    }
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      throw new Error("enrollment token must be 32 lowercase hex characters");
    }
    const keys = generateNodeKeyPair();
    const enrollmentRequestId = randomHex(16);
    const response = await this.fetchImpl(`${this.hubBaseUrl}${ENROLL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, enrollmentRequestId, publicKey: keys.publicKeyHex }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status !== 200) {
      const { code, message } = wireError(response.status, body);
      this.recordEvent("enroll-failed", { code, message });
      throw new Error(`enrollment denied: ${code} (${message})`);
    }
    await this.persist({
      nodeId: body.nodeId,
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      hubBaseUrl: this.hubBaseUrl,
      state: "active",
      rotation: null,
    });
    this.backoff.recordSuccess();
    this.recordEvent("enrolled", { nodeId: body.nodeId, keyId: body.keyId });
    return { nodeId: body.nodeId, keyId: body.keyId };
  }

  // ------------------------------------------------------------------
  // Signed machine request helper (RFC-0006 transport headers).

  async signedRequest({ path, nodeId, keyId, keyHex, body }) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.trunc(this.now().getTime() / 1000));
    const nonce = randomHex(16);
    const signingString = buildSigningString({
      label: MACHINE_V1_LABEL,
      method: "POST",
      path,
      timestamp,
      nonce,
      bodyHash: sha256Hex(rawBody),
      nodeId,
    });
    const signature = signSigningString(keyHex, signingString);
    let response;
    try {
      response = await this.fetchImpl(`${this.hubBaseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-orbit-node": nodeId,
          "x-orbit-timestamp": timestamp,
          "x-orbit-nonce": nonce,
          "x-orbit-key": keyId,
          "x-orbit-signature": signature,
        },
        body: rawBody,
      });
    } catch (error) {
      // Transport failure (hub unavailable): the caller treats this as
      // a retryable backoff event, never as a protocol decision.
      return { status: 0, body: { error: { code: "network", message: error.message } } };
    }
    const parsed = await response.json().catch(() => ({}));
    return { status: response.status, body: parsed };
  }

  // ------------------------------------------------------------------
  // Stage 3: heartbeat with backoff (RFC-0006 route; registryContact
  // only) and report upload (compatibility evidence only).

  // One maintenance tick: attempts a heartbeat when due and the node is
  // not revoked. Returns the tick outcome.
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
    if (!this.backoff.due(this.now().getTime())) {
      return { state: this.runtimeState === "retrying" ? "retrying" : "active", attempted: false };
    }
    const outcome = await this.heartbeat();
    return outcome;
  }

  // Performs a heartbeat now (used by tick, doctor, and tests).
  // persistOnRevoked=false is for doctor probes, which never write.
  async heartbeat({ persistOnRevoked = true } = {}) {
    const identity = this.runtimeIdentity();
    const result = await this.signedRequest({
      path: HEARTBEAT_PATH,
      nodeId: this.store.nodeId,
      keyId: deriveKeyId(this.store.publicKeyHex),
      keyHex: this.store.privateKeyHex,
      body: { runtime: identity },
    });
    if (result.status === 200) {
      this.backoff.recordSuccess();
      this.lastContactAt = this.now().toISOString();
      this.lastError = null;
      this.runtimeState = "running";
      this.recordEvent("heartbeat-ok", { registryContact: result.body.registryContact });
      return { state: "active", attempted: true, ok: true };
    }
    if (result.status === 401 && (result.body?.error?.code === "revoked" || result.body?.error?.code === "key-revoked" || result.body?.error?.code === "unknown-key")) {
      if (persistOnRevoked) {
        await this.persist({ ...this.store, state: "revoked" });
      }
      this.runtimeState = "revoked";
      this.lastError = wireError(result.status, result.body);
      this.recordEvent("revoked", { code: result.body?.error?.code, message: result.body?.error?.message });
      return { state: "revoked", attempted: true, ok: false, error: this.lastError };
    }
    if (result.status === 401) {
      // Signature/timestamp/nonce problems are configuration bugs, not
      // unavailability; back off as a fail-closed error.
      this.backoff.recordFailure();
      this.runtimeState = "retrying";
      this.lastError = wireError(result.status, result.body);
      this.recordEvent("heartbeat-denied", { code: result.body?.error?.code, message: result.body?.error?.message });
      return { state: "retrying", attempted: true, ok: false, error: this.lastError };
    }
    // Network failure, 429, 5xx: the hub is unreachable or limiting;
    // retry with backoff, stay ACTIVE/RETRYING.
    this.backoff.recordFailure();
    this.runtimeState = "retrying";
    this.lastError = wireError(result.status, result.body);
    this.recordEvent("heartbeat-failed", { code: result.body?.error?.code ?? "network", message: result.body?.error?.message ?? "hub unavailable" });
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
      this.recordEvent("report-uploaded", {
        orbitCompatible: result.body.orbitCompatible,
        capabilities: (result.body.capabilities ?? []).map((entry) => entry.name),
      });
      return result.body;
    }
    if (result.status === 401) {
      await this.persist({ ...this.store, state: "revoked" });
      this.runtimeState = "revoked";
      this.lastError = wireError(result.status, result.body);
      this.recordEvent("revoked", { code: result.body?.error?.code ?? "unauthorized", message: result.body?.error?.message ?? "hub denied the report" });
    }
    const { code, message } = wireError(result.status, result.body);
    this.recordEvent("report-failed", { code, message });
    throw new Error(`report upload denied: ${code} (${message})`);
  }

  requireActive() {
    if (this.store.state !== "active") {
      throw new Error(`operation requires an active node (state is ${this.store.state})`);
    }
  }

  // ------------------------------------------------------------------
  // Stage 4: credential rotation (RFC-0006; signed by the OLD key,
  // bounded overlap) and explicit re-enrollment (RFC-0005 D5,
  // ORBIT-REENROLL-V1 possession proof with the ORIGINAL key).

  async rotateCredential() {
    this.requireActive();
    const newKeys = generateNodeKeyPair();
    const oldKeyId = deriveKeyId(this.store.publicKeyHex);
    const result = await this.signedRequest({
      path: ROTATE_PATH,
      nodeId: this.store.nodeId,
      keyId: oldKeyId,
      keyHex: this.store.privateKeyHex,
      body: { newPublicKey: newKeys.publicKeyHex },
    });
    if (result.status !== 200) {
      if (result.status === 401) {
        await this.persist({ ...this.store, state: "revoked" });
        this.runtimeState = "revoked";
        this.recordEvent("revoked", { code: result.body?.error?.code ?? "unauthorized", message: result.body?.error?.message ?? "rotation denied" });
      }
      const { code, message } = wireError(result.status, result.body);
      this.recordEvent("rotate-failed", { code, message });
      throw new Error(`credential rotation denied: ${code} (${message})`);
    }
    const overlapUntil = result.body.overlapUntil;
    await this.persist({
      ...this.store,
      publicKeyHex: newKeys.publicKeyHex,
      privateKeyHex: newKeys.privateKeyHex,
      rotation: {
        oldKeyId,
        oldPrivateKeyHex: this.store.privateKeyHex,
        newKeyId: result.body.newKeyId,
        overlapUntil,
      },
    });
    this.recordEvent("rotated", { oldKeyId, newKeyId: result.body.newKeyId, overlapUntil });
    return result.body;
  }

  // Explicit re-enrollment (operator-minted token bound to the
  // tombstoned nodeId). Requires REVOKED state; the possession proof is
  // signed with the CURRENT (original) private key; the post-restore
  // identity uses a fresh keypair. Same nodeId is restored.
  async reenroll({ token }) {
    if (this.store.state !== "revoked") {
      throw new Error(`re-enrollment requires a revoked node (state is ${this.store.state})`);
    }
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      throw new Error("re-enrollment token must be 32 lowercase hex characters");
    }
    const newKeys = generateNodeKeyPair();
    const reenrollmentRequestId = randomHex(16);
    const rawBody = Buffer.from(
      JSON.stringify({ reenrollmentToken: token, reenrollmentRequestId, newPublicKey: newKeys.publicKeyHex }),
    );
    const timestamp = String(Math.trunc(this.now().getTime() / 1000));
    const nonce = randomHex(16);
    const signingString = buildSigningString({
      label: REENROLL_V1_LABEL,
      method: "POST",
      path: REENROLL_PATH,
      timestamp,
      nonce,
      bodyHash: sha256Hex(rawBody),
      nodeId: this.store.nodeId,
    });
    const signature = signSigningString(this.store.privateKeyHex, signingString);
    const response = await this.fetchImpl(`${this.hubBaseUrl}${REENROLL_PATH}`, {
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
    const body = await response.json().catch(() => ({}));
    if (response.status !== 200) {
      const { code, message } = wireError(response.status, body);
      this.recordEvent("reenroll-failed", { code, message });
      throw new Error(`re-enrollment denied: ${code} (${message})`);
    }
    if (body.nodeId !== this.store.nodeId) {
      // Frozen identity rule: re-enrollment must restore the SAME
      // nodeId; anything else is a protocol violation.
      throw new Error(`re-enrollment restored a different nodeId (${JSON.stringify(body.nodeId)})`);
    }
    await this.persist({
      ...this.store,
      publicKeyHex: newKeys.publicKeyHex,
      privateKeyHex: newKeys.privateKeyHex,
      state: "active",
      rotation: null,
    });
    this.runtimeState = "running";
    this.recordEvent("reenrolled", { nodeId: body.nodeId, keyId: body.keyId });
    return { nodeId: body.nodeId, keyId: body.keyId };
  }

  // ------------------------------------------------------------------
  // Restart recovery (Stages 2/4): after loading the store, drop a
  // rotation marker whose overlap has fully elapsed, and stay in the
  // persisted state. Never re-enrolls.

  async recoverAfterRestart() {
    if (this.store.rotation !== null && Date.parse(this.store.rotation.overlapUntil) <= this.now().getTime()) {
      await this.persist({ ...this.store, rotation: null });
      this.recordEvent("rotation-overlap-ended");
    }
    if (this.store.state === "revoked") {
      this.runtimeState = "revoked";
    } else if (this.store.state === "active") {
      this.runtimeState = "running";
    } else {
      this.runtimeState = "idle";
    }
    this.recordEvent("restart-recovered", { state: this.store.state });
    return { state: this.store.state, nodeId: this.store.nodeId };
  }

  // ------------------------------------------------------------------
  // Status and diagnostics (Stage 4).

  status() {
    const nowMs = this.now().getTime();
    const nextAttemptDelay = Math.max(0, this.backoff.nextAttemptAt - nowMs);
    return {
      state: this.store.state === "active" && this.runtimeState === "retrying" ? "retrying" : this.store.state,
      nodeId: this.store.nodeId,
      keyId: this.store.publicKeyHex ? deriveKeyId(this.store.publicKeyHex) : null,
      hubBaseUrl: this.store.hubBaseUrl ?? this.hubBaseUrl,
      lastContactAt: this.lastContactAt,
      lastHeartbeatAt: this.lastContactAt,
      lastError: this.lastError,
      heartbeatCadenceSeconds: this.heartbeatCadenceSeconds,
      backoff: {
        attempt: this.backoff.attempt,
        nextAttemptInMs: nextAttemptDelay,
        lastDelayMs: this.backoff.lastDelayMs,
      },
      rotation: this.store.rotation
        ? {
            oldKeyId: this.store.rotation.oldKeyId,
            newKeyId: this.store.rotation.newKeyId,
            overlapUntil: this.store.rotation.overlapUntil,
          }
        : null,
      runtimeIdentity: this.store.state === "active" ? this.runtimeIdentity() : null,
      recentEvents: [...this.recentEvents],
    };
  }

  // Doctor: integrity checks + one live probe; never mutates state.
  async doctor() {
    const findings = [];
    const add = (severity, check, detail) => findings.push({ severity, check, detail });

    // Local store integrity
    if (this.store.nodeId === null) {
      add("info", "identity", "not enrolled yet");
    } else {
      add("ok", "identity", `nodeId ${this.store.nodeId}`);
    }
    const problems = validateNodeStore(this.store);
    for (const problem of problems) {
      add("fail", "store-integrity", problem);
    }
    if (this.store.privateKeyHex !== null) {
      add("ok", "private-key", "PKCS8 hex present and well-formed");
    }
    if (this.store.nodeId !== null && this.store.publicKeyHex !== null) {
      try {
        const probe = buildSigningString({
          label: MACHINE_V1_LABEL,
          method: "POST",
          path: HEARTBEAT_PATH,
          timestamp: "0",
          nonce: "0".repeat(32),
          bodyHash: sha256Hex(Buffer.from("{}")),
          nodeId: this.store.nodeId,
        });
        const testSignature = signSigningString(this.store.privateKeyHex, probe);
        add(
          verifySigningString(this.store.publicKeyHex, probe, testSignature) ? "ok" : "fail",
          "key-pair",
          "private key signs for the stored public key",
        );
      } catch (error) {
        add("fail", "key-pair", error.message);
      }
    }

    // Live hub probe (never changes state)
    if (this.store.state === "active" || this.store.state === "revoked") {
      try {
        const outcome = await this.heartbeat({ persistOnRevoked: false });
        if (outcome.ok) {
          add("ok", "hub-probe", `hub accepts credentials (${outcome.state})`);
        } else if (outcome.state === "revoked") {
          add("fail", "hub-probe", `hub revoked this identity: ${outcome.error?.message}`);
        } else {
          add("warn", "hub-probe", `hub unreachable or limiting: ${outcome.error?.message}`);
        }
      } catch (error) {
        add("fail", "hub-probe", error.message);
      }
    } else {
      add("info", "hub-probe", "no identity to probe");
    }

    return {
      state: this.status().state,
      findings,
      status: this.status(),
    };
  }
}