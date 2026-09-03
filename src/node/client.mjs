// Node Registry Client (SOP Stage 2-4; Review Gate A remediation).
//
// Persisted states: unenrolled / active / revoked (RFC-0005 D1/D5).
// Runtime: retrying (hub unavailable, backoff active). The client
// follows the SOP uncertain-output principle: every identity-changing
// operation persists its intent BEFORE the request, so Hub commit +
// lost response + restart is always reconcilable by exact replay or
// commit detection. 401 revoked NEVER re-enrolls automatically.

import http from "node:http";
import https from "node:https";
import { HeartbeatBackoff } from "./backoff.mjs";
import { deriveKeyId, generateNodeKeyPair, randomHex, sha256Hex, signSigningString } from "../registry/crypto.mjs";
import { buildSigningString, MACHINE_V1_LABEL, REENROLL_V1_LABEL } from "../registry/protocol.mjs";
import { validateHubRouteKeySet } from "../registry/hub-route-keys.mjs";
import { extendDefaultCaCertificates } from "../tls-trust.mjs";
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

// Unified revocation classification (Gate A P1-07, round-2 P1-04):
// ONLY revoked/key-revoked prove the Hub revoked this identity and may
// persist REVOKED. unknown-key is a credential-mismatch runtime error
// (authentication denied, NOT a tombstone) and never persists REVOKED;
// pending-rotation probes interpret unknown-key separately.
const REVOCATION_CODES = new Set(["revoked", "key-revoked"]);

export function isCredentialRevocation(body) {
  return REVOCATION_CODES.has(body?.error?.code);
}

export function isTrustedTransport(hubBaseUrl) {
  try {
    const url = new URL(hubBaseUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      return url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    }
    return false;
  } catch {
    return false;
  }
}

export function defaultNodeMachineFetch(
  urlStr,
  { method = "POST", headers = {}, body = null, caCertificates = null, timeoutMs = 10000 } = {},
) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const reqOptions = {
      method,
      headers,
      timeout: timeoutMs,
    };
    if (isHttps && caCertificates) {
      reqOptions.ca = extendDefaultCaCertificates(caCertificates);
    }
    const req = client.request(url, reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          url: urlStr,
          text: async () => text,
          json: async () => {
            try {
              return JSON.parse(text);
            } catch {
              return {};
            }
          },
        });
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy(new Error("machine request timeout"));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
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
    caCertificates = null,
    onRevoked = null,
    routeIngress = null,
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
    this.caCertificates = caCertificates;
    this.onRevoked = onRevoked;
    this.routeIngress = routeIngress;
    this.backoff = new HeartbeatBackoff({ now: () => this.now().getTime() });
    // Report retries get their OWN backoff: report outcomes must never
    // change the heartbeat schedule (round-2 P1-02).
    this.reportBackoff = new HeartbeatBackoff({ now: () => this.now().getTime() });
    this.recentEvents = [];
    this.lastHeartbeatAt = null;
    this.lastReportAt = null;
    this.lastContactAt = null;
    this.lastError = null;
    this.runtimeState = "idle";
    this.pendingKeyAck = false;
    // Normal cadence clock, independent of the failure backoff (P1-05):
    // a successful heartbeat schedules the next one at now + cadence;
    // failures schedule retries through backoff.
    this.nextHeartbeatAt = 0;
    this.store = store;
    this.storePath = storePath;
    this.enforceBinding();
  }

  // Hub binding (P1-06, round-2 P1-01): store.hubBaseUrl is part of the
  // identity, and so is the binding of a persisted pending enrollment.
  // Runtime configuration that differs from either fails closed instead
  // of silently talking to another Hub.
  enforceBinding() {
    if (this.store.state === "unenrolled") {
      const pending = this.store.pendingEnrollment;
      if (pending && typeof pending.hubBaseUrl === "string" && pending.hubBaseUrl !== "") {
        if (pending.hubBaseUrl !== this.baseHubUrl) {
          throw new Error(
            `pending enrollment is bound to ${pending.hubBaseUrl} but the runtime configuration targets ${this.baseHubUrl}; refusing to replay enrollment against another Hub`,
          );
        }
      }
      return;
    }
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
    // Commit order: the disk write is authoritative. The candidate is
    // only published to this.store AFTER writeNodeStore() succeeds, so
    // a validation/write/rename failure leaves BOTH memory and disk at
    // the previous committed state — and a retried identity-changing
    // operation re-persists its pending intent before any network
    // request.
    const candidate = { ...this.store, ...next, updatedAt: this.now().toISOString() };
    await writeNodeStore(this.storePath, candidate);
    this.store = candidate;
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
        hubBaseUrl: this.baseHubUrl,
        generatedAt: this.now().toISOString(),
      };
      await this.persist({ ...this.store, pendingEnrollment: pending });
    }
    this.enforceBinding(); // the pending binding and runtime config must agree
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
        hubRouteKeys: null,
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

  async callFetch(url, options = {}) {
    if (this.fetchImpl === globalThis.fetch) {
      return defaultNodeMachineFetch(url, {
        ...options,
        caCertificates: this.caCertificates,
      });
    }
    return this.fetchImpl(url, {
      ...options,
      redirect: "manual",
    });
  }

  // Plain JSON transport with the injected fetch (used by enrollment).
  async transport(path, { body, headers = {} }) {
    let response;
    const targetUrl = `${this.baseHubUrl.replace(/\/$/, "")}${path}`;
    try {
      response = await this.callFetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: Buffer.from(JSON.stringify(body)),
      });
    } catch (error) {
      return { status: 0, body: { error: { code: "network", message: error.message } } };
    }

    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, body: { error: { code: "redirect-denied", message: "redirects are forbidden" } } };
    }

    if (response.url) {
      try {
        const respUrl = new URL(response.url);
        const expectedUrl = new URL(this.baseHubUrl);
        if (respUrl.origin !== expectedUrl.origin) {
          return { status: 401, body: { error: { code: "authority-mismatch", message: "response URL origin does not match hubBaseUrl" } } };
        }
      } catch {}
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
    if (this.pendingKeyAck) {
      this.pendingKeyAck = false;
      this.nextHeartbeatAt = this.now().getTime() + 500;
      return;
    }
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
    const acceptedHubRouteKeyIds = (this.store.hubRouteKeys ?? []).map((k) => k.keyId);
    const result = await this.signedRequest({
      path: HEARTBEAT_PATH,
      nodeId: this.store.nodeId,
      keyId,
      keyHex,
      body: { runtime: identity, acceptedHubRouteKeyIds },
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

      if (result.body.hubRouteKeys !== undefined) {
        if (!isTrustedTransport(this.baseHubUrl)) {
          this.recordEvent("hub-route-keys-rejected", { reason: "untrusted-transport", hubBaseUrl: this.baseHubUrl });
        } else {
          const validation = validateHubRouteKeySet(result.body.hubRouteKeys, this.now());
          if (!validation.valid) {
            this.recordEvent("hub-route-keys-rejected", { reason: validation.reason });
          } else {
            const currentJson = JSON.stringify(this.store.hubRouteKeys ?? null);
            const incomingJson = JSON.stringify(validation.keys);
            if (currentJson !== incomingJson) {
              await this.persist({ ...this.store, hubRouteKeys: validation.keys });
              this.recordEvent("hub-route-keys-updated", { keyIds: validation.keys.map((k) => k.keyId) });
              this.pendingKeyAck = true;
            }
          }
        }
      }

      return { state: "active", attempted: true, ok: true };
    }
    if (result.status === 401 && isCredentialRevocation(result.body)) {
      if (persistOnRevoked) {
        await this.persist({ ...this.store, state: "revoked" });
      }
      this.runtimeState = "revoked";
      this.lastError = wireError(result.status, result.body);
      this.recordEvent("revoked", { code: result.body?.error?.code, message: result.body?.error?.message });
      if (this.onRevoked) {
        try { this.onRevoked(); } catch {}
      }
      if (this.routeIngress) {
        try { this.routeIngress.disable(); } catch {}
      }
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
      // Report outcomes use the REPORT backoff: they must never change
      // the heartbeat schedule (round-2 P1-02).
      this.reportBackoff.recordSuccess();
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
      if (this.onRevoked) {
        try { this.onRevoked(); } catch {}
      }
      if (this.routeIngress) {
        try { this.routeIngress.disable(); } catch {}
      }
      throw new Error(`report upload denied: ${this.lastError.code} (${this.lastError.message})`);
    }
    const { code, message } = wireError(result.status, result.body);
    this.reportBackoff.recordFailure();
    this.recordEvent("report-failed", { code, message });
    throw new Error(`report upload denied: ${code} (${message})`);
  }

  requireActive() {
    if (this.store.state !== "active") {
      throw new Error(`operation requires an active node (state is ${this.store.state})`);
    }
  }

  getHubRouteKeys() {
    return this.store.hubRouteKeys ?? [];
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
    // promote locally. If the new key is unknown (401 unknown-key is
    // authentication-denied, not a tombstone) and the old key still
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
      if (newProbe.state === "revoked") {
        // The old identity was deleted while the rotate was in flight.
        await this.persist({ ...this.store, state: "revoked" });
        this.runtimeState = "revoked";
        return { state: "revoked", attempted: true, ok: false, error: newProbe.error };
      }
      if (newProbe.state === "retrying") {
        // Hub answered but rejected the pending key: not committed. Does
        // the old key still work?
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

    // Possession-proof signer selection (round-2 P1-03): when a rotation
    // was in flight at deletion time, the tombstone retains the LATEST
    // key — which may be the pending new key B (rotate committed) or the
    // old key A (rotate never committed). Both secrets exist locally, so
    // the proof tries B first and falls back to A ONLY on
    // possession-proof-failed, which by the frozen RFC consumes nothing.
    // Both attempts share the same persisted requestId + target key.
    const signerCandidates = [];
    const rotation = this.store.rotation;
    if (rotation !== null && rotation.overlapUntil === null && typeof rotation.newPrivateKeyHex === "string") {
      signerCandidates.push({ keyId: rotation.newKeyId, keyHex: rotation.newPrivateKeyHex, reason: "pending-new" });
    }
    signerCandidates.push({ keyId: deriveKeyId(this.store.publicKeyHex), keyHex: this.store.privateKeyHex, reason: "current" });

    let response;
    let signerUsed = "";
    for (const signer of signerCandidates) {
      const signature = signSigningString(
        signer.keyHex,
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
      try {
        response = await this.callFetch(`${this.baseHubUrl.replace(/\/$/, "")}${REENROLL_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-orbit-node": this.store.nodeId,
            "x-orbit-timestamp": timestamp,
            "x-orbit-nonce": nonce,
            "x-orbit-key": signer.keyId,
            "x-orbit-signature": signature,
          },
          body: rawBody,
        });
      } catch (error) {
        this.recordEvent("reenroll-failed", { code: "network", message: error.message });
        throw new Error(`re-enrollment outcome unknown (network failure): retry with the same re-enrollment token (${error.message})`);
      }
      if (response.status >= 300 && response.status < 400) {
        throw new Error("re-enrollment denied: redirect-denied (redirects are forbidden)");
      }
      const probed = typeof response.json === "function" ? await response.json().catch(() => ({})) : {};
      const probedStatus = response.status ?? 0;
      if (probedStatus === 200) {
        response = { status: probedStatus, json: async () => probed };
        signerUsed = signer.reason;
        break;
      }
      if (probedStatus === 401 && (probed?.error?.code === "possession-proof-failed" || probed?.error?.code === "key-revoked") && signer.reason === "pending-new") {
        // The Hub rejects a possession proof whose keyId is not the
        // tombstone-retained historical key (key-revoked, checked before
        // the signature) or whose signature does not verify
        // (possession-proof-failed). Per the frozen RFC nothing was
        // consumed, so the next candidate (the current main key) tries
        // the SAME request with the SAME intent.
        this.recordEvent("reenroll-proof-fallback", { to: "current", code: probed?.error?.code });
        continue;
      }
      response = { status: probedStatus, json: async () => probed };
      signerUsed = signer.reason;
      break;
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
      // P1-3: Clear deleted-era Hub route keys immediately upon reenrollment!
      await this.persist({
        ...this.store,
        publicKeyHex: pending.publicKeyHex,
        privateKeyHex: pending.privateKeyHex,
        hubRouteKeys: null,
        state: "active",
        rotation: null,
        pendingReenrollment: null,
      });
      if (this.routeIngress) {
        try { this.routeIngress.enable(); } catch {}
      }
      this.runtimeState = "running";
      this.recordEvent("reenrolled", { nodeId: body.nodeId, keyId: body.keyId, proofSigner: signerUsed });
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
      const response = await this.callFetch(`${this.baseHubUrl.replace(/\/$/, "")}/`, { method: "GET" });
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