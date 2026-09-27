// QR Pairing Code & Session Bootstrap Engine (RFC-0016 D3).
// Manages ephemeral 6-digit dynamic pairing codes with <= 300s TTL and anti-replay single-use destruction.

import { randomInt, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export const PAIRING_CODE_PATTERN = /^\d{6}$/;
export const DEFAULT_PAIRING_TTL_MS = 300_000; // 5 minutes

export class PairingCodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairingCodeError";
    this.code = code;
  }
}

/**
 * Manages ephemeral pairing codes, single-use destruction, and verification rate-limiting.
 */
export class PairingCodeEngine extends EventEmitter {
  constructor({
    ttlMs = DEFAULT_PAIRING_TTL_MS,
    maxFailedAttempts = 5,
    lockDurationMs = 15 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.ttlMs = Math.max(10_000, Math.min(600_000, ttlMs));
    this.maxFailedAttempts = Math.max(1, maxFailedAttempts);
    this.lockDurationMs = Math.max(10_000, lockDurationMs);
    this.now = now;

    this.codes = new Map(); // code -> record
    this.tokens = new Map(); // pairingToken -> record
    this.ipAttempts = new Map(); // ip -> { failedAttempts, lockedUntil, lastAttemptAt }
  }

  /**
   * Generates a new 6-digit ephemeral pairing code.
   *
   * @param {object} params
   * @param {string} [params.operatorPrincipal='operator']
   * @param {string} params.hubBaseUrl - Verified TLS Hub URL
   * @returns {{ code: string, pairingToken: string, expiresAt: string, url: string }}
   */
  generateCode({ operatorPrincipal = "operator", hubBaseUrl }) {
    if (!hubBaseUrl || typeof hubBaseUrl !== "string") {
      throw new PairingCodeError("invalid-hub-url", "hubBaseUrl is required and must be a valid URL string");
    }

    const code = randomInt(100_000, 1_000_000).toString();
    const pairingToken = randomBytes(24).toString("hex");
    const nowMs = this.now();
    const expiresAtMs = nowMs + this.ttlMs;

    let targetUrl;
    try {
      targetUrl = new URL("/auth", hubBaseUrl);
      targetUrl.searchParams.set("token", code);
    } catch {
      throw new PairingCodeError("invalid-hub-url", `malformed hubBaseUrl: ${hubBaseUrl}`);
    }

    if (targetUrl.protocol !== "https:") {
      throw new PairingCodeError("insecure-scheme", "pairing URLs must use verified TLS (https://)");
    }

    const record = {
      code,
      pairingToken,
      operatorPrincipal: String(operatorPrincipal || "operator"),
      createdAt: nowMs,
      expiresAt: expiresAtMs,
    };

    this.codes.set(code, record);
    this.tokens.set(pairingToken, record);

    const timer = setTimeout(() => {
      this.codes.delete(code);
      this.tokens.delete(pairingToken);
    }, this.ttlMs + 1000);
    timer.unref?.();

    return {
      code,
      pairingToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      url: targetUrl.toString(),
    };
  }

  /**
   * Checks whether an IP address is currently locked out due to brute-force attempts.
   *
   * @param {string} ip
   * @returns {{ locked: boolean, remainingSeconds: number }}
   */
  checkIpLockout(ip) {
    if (!ip) return { locked: false, remainingSeconds: 0 };
    const stat = this.ipAttempts.get(ip);
    if (!stat) return { locked: false, remainingSeconds: 0 };

    const nowMs = this.now();
    if (stat.lockedUntil && stat.lockedUntil > nowMs) {
      const remainingSeconds = Math.ceil((stat.lockedUntil - nowMs) / 1000);
      return { locked: true, remainingSeconds };
    }

    if (nowMs - stat.lastAttemptAt > this.lockDurationMs || (stat.lockedUntil && stat.lockedUntil <= nowMs)) {
      this.ipAttempts.delete(ip);
    }

    return { locked: false, remainingSeconds: 0 };
  }

  /**
   * Verifies an ephemeral code, destroying it immediately to prevent replay.
   *
   * @param {string} inputCode - 6-digit code or pairingToken
   * @param {string} [clientIp] - Client IP for rate-limiting
   * @returns {{ valid: boolean, operatorPrincipal?: string, code?: string, message?: string }}
   */
  verifyCode(inputCode, clientIp = "") {
    // 1. Check IP lockout
    if (clientIp) {
      const lock = this.checkIpLockout(clientIp);
      if (lock.locked) {
        return {
          valid: false,
          code: "rate-limited",
          message: `IP temporarily locked due to repeated failures; retry in ${lock.remainingSeconds}s`,
        };
      }
    }

    const trimmed = String(inputCode || "").trim();
    if (!trimmed) {
      this.recordFailure(clientIp);
      return { valid: false, code: "code-not-found", message: "pairing code is required" };
    }

    // Lookup by 6-digit code or pairingToken
    const record = this.codes.get(trimmed) || this.tokens.get(trimmed);
    if (!record) {
      this.recordFailure(clientIp);
      return { valid: false, code: "code-not-found", message: "invalid or expired pairing code" };
    }

    // Single-use enforcement: destroy code immediately on first access attempt
    this.codes.delete(record.code);
    this.tokens.delete(record.pairingToken);

    // Expiration check
    if (this.now() > record.expiresAt) {
      this.recordFailure(clientIp);
      return { valid: false, code: "code-expired", message: "pairing code has expired" };
    }

    // Success resets failure count
    if (clientIp) {
      this.ipAttempts.delete(clientIp);
    }

    return {
      valid: true,
      operatorPrincipal: record.operatorPrincipal,
      code: "ok",
    };
  }

  /**
   * Records a failed verification attempt and enforces 429 lockout when threshold exceeded.
   */
  recordFailure(ip) {
    if (!ip) return;
    const nowMs = this.now();

    // Clean up stale IP records if map size exceeds 500
    if (this.ipAttempts.size > 500) {
      for (const [k, v] of this.ipAttempts.entries()) {
        if (nowMs - v.lastAttemptAt > this.lockDurationMs) {
          this.ipAttempts.delete(k);
        }
      }
    }

    const stat = this.ipAttempts.get(ip) || { failedAttempts: 0, lockedUntil: 0, lastAttemptAt: nowMs };
    // If last attempt was beyond lockDurationMs window and not locked, reset attempt count
    if (nowMs - stat.lastAttemptAt > this.lockDurationMs && !stat.lockedUntil) {
      stat.failedAttempts = 0;
    }

    stat.failedAttempts += 1;
    stat.lastAttemptAt = nowMs;

    if (stat.failedAttempts >= this.maxFailedAttempts) {
      stat.lockedUntil = nowMs + this.lockDurationMs;
    }
    this.ipAttempts.set(ip, stat);
  }

  /**
   * Broadcasts an SSE event to active desktop settings listeners.
   */
  broadcastEvent(type, data = {}) {
    this.emit("event", { type, ...data, timestamp: new Date(this.now()).toISOString() });
  }

  getActiveCodeCount() {
    return this.codes.size;
  }
}
