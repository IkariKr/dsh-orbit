// DeepSeek Harness (DSH) Native Desktop Client UI Bundle (RFC-0016 D4, Stage 3).
// Injects the "Orbit Remote & Fleet" settings section into DSH's native settings
// using official extension point `slots.inject('settings.section')`.
//
// Strictly enforces verified TLS (https://) for remote QR pairing URLs.
// Generates inline vector SVG QR codes with zero external network requests.

import { generateQrSvg } from "./qr-svg.mjs";

export const ORBIT_SETTINGS_SECTION_ID = "orbit-fleet";
export const ORBIT_SETTINGS_SECTION_ORDER = 140;

/**
 * Controller and state manager for the Orbit Settings Section.
 * Encapsulates pairing code generation, countdown timers, SSE streaming,
 * and verified TLS assertion.
 */
export class OrbitSettingsController {
  constructor(options = {}) {
    this.hubBaseUrl = options.hubBaseUrl || "";
    this.csrfToken = options.csrfToken || "";
    this.sessionCookie = options.sessionCookie || "";
    this.onStateChange = options.onStateChange || (() => {});
    this.now = options.now || (() => Date.now());

    this.state = {
      loading: false,
      error: null,
      code: null,
      url: null,
      expiresAt: null,
      remainingSeconds: 0,
      qrSvg: null,
      activeCodes: 0,
      activeSessions: 0,
      eventsConnected: false,
      devices: [],
    };

    this.timer = null;
    this.eventSource = null;
  }

  /**
   * Asserts that a URL uses verified TLS (https://).
   * Refuses unencrypted http:// schemes per RFC-0016 stop-work invariants.
   */
  assertVerifiedTls(urlStr) {
    if (!urlStr || typeof urlStr !== "string") {
      throw new Error("URL must be a non-empty string");
    }
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new Error(`Malformed URL: ${urlStr}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`Insecure transport scheme '${parsed.protocol}': QR pairing requires verified TLS (https://)`);
    }
    return parsed;
  }

  updateState(partial) {
    this.state = { ...this.state, ...partial };
    this.onStateChange(this.state);
  }

  /**
   * Generates a new 6-digit pairing code from the Hub.
   */
  async generateCode() {
    this.updateState({ loading: true, error: null });
    try {
      const endpoint = `${this.hubBaseUrl}/hub/pairing/generate-code`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": this.csrfToken,
        },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message || `Failed to generate code (HTTP ${res.status})`);
      }

      const data = await res.json();
      // Enforce verified TLS invariant
      this.assertVerifiedTls(data.url);

      const qrResult = generateQrSvg(data.url, { size: 220 });
      const expiresAtMs = Date.parse(data.expiresAt);
      const remainingSeconds = Math.max(0, Math.floor((expiresAtMs - this.now()) / 1000));

      this.updateState({
        loading: false,
        code: data.code,
        url: data.url,
        expiresAt: data.expiresAt,
        remainingSeconds,
        qrSvg: qrResult.svg,
        error: null,
      });

      this.startCountdown(expiresAtMs);
    } catch (err) {
      this.updateState({
        loading: false,
        error: err.message,
      });
    }
  }

  startCountdown(expiresAtMs) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAtMs - this.now()) / 1000));
      if (remaining <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        this.updateState({
          remainingSeconds: 0,
          code: null,
          url: null,
          qrSvg: null,
          error: "Pairing code expired. Please generate a new code.",
        });
      } else {
        this.updateState({ remainingSeconds: remaining });
      }
    }, 1000);
  }

  /**
   * Fetches status of active codes and sessions from Hub.
   */
  async fetchStatus() {
    try {
      const res = await fetch(`${this.hubBaseUrl}/hub/pairing/status`, {
        headers: {
          "x-csrf-token": this.csrfToken,
        },
      });
      if (res.ok) {
        const data = await res.json();
        this.updateState({
          activeCodes: data.activeCodes ?? 0,
          activeSessions: data.activeSessions ?? 0,
        });
      }
    } catch (err) {
      // Non-blocking background status fetch
    }
  }

  /**
   * Subscribes to Hub real-time SSE stream.
   */
  subscribeEvents() {
    if (this.eventSource) return;
    try {
      const streamUrl = `${this.hubBaseUrl}/hub/pairing/events`;
      const EventSourceClass = typeof window !== "undefined" ? window.EventSource : globalThis.EventSource;
      if (!EventSourceClass) return;

      this.eventSource = new EventSourceClass(streamUrl);
      this.eventSource.onopen = () => {
        this.updateState({ eventsConnected: true });
      };

      this.eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.event === "device-connected") {
            // A mobile client successfully verified the pairing code!
            // Clear current code and refresh status
            if (this.timer) {
              clearInterval(this.timer);
              this.timer = null;
            }
            this.updateState({
              code: null,
              url: null,
              qrSvg: null,
              remainingSeconds: 0,
            });
            this.fetchStatus();
          }
        } catch {}
      };

      this.eventSource.onerror = () => {
        this.updateState({ eventsConnected: false });
      };
    } catch {}
  }

  /**
   * Renders HTML markup for the Settings Section card.
   */
  renderHtml() {
    const { loading, error, code, remainingSeconds, qrSvg, activeCodes, activeSessions } = this.state;

    return `
<div class="orbit-settings-section" id="orbit-settings-container">
  <div class="orbit-header">
    <h3>Orbit Remote & Fleet</h3>
    <span class="orbit-badge">v0.9</span>
  </div>
  
  <div class="orbit-status-bar">
    <span>Active Codes: <strong>${activeCodes}</strong></span>
    <span>Active Sessions: <strong>${activeSessions}</strong></span>
  </div>

  ${error ? `<div class="orbit-error-alert">${escapeHtml(error)}</div>` : ""}

  <div class="orbit-pairing-card">
    <h4>Mobile Quick Pair</h4>
    <p>Scan with Orbit Mobile to authorize an operator session.</p>

    ${
      code
        ? `
      <div class="orbit-code-display">
        <span class="orbit-code-digits">${code.slice(0, 3)} ${code.slice(3)}</span>
        <span class="orbit-countdown">Valid for ${remainingSeconds}s</span>
      </div>
      <div class="orbit-qr-container">
        ${qrSvg || ""}
      </div>
    `
        : `
      <div class="orbit-idle-display">
        <p>No active pairing code.</p>
      </div>
    `
    }

    <div class="orbit-actions">
      <button class="orbit-btn-primary" id="orbit-btn-generate" ${loading ? "disabled" : ""}>
        ${loading ? "Generating..." : code ? "Refresh Code" : "Pair Mobile Device"}
      </button>
    </div>
  </div>
</div>
`.trim();
  }

  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * UI Component descriptor for DSH settings.section slot.
 */
export const OrbitSettingsSection = {
  name: "OrbitSettingsSection",
  Controller: OrbitSettingsController,
  render(container, options = {}) {
    const controller = new OrbitSettingsController({
      ...options,
      onStateChange: () => {
        if (container) {
          container.innerHTML = controller.renderHtml();
          attachEventListeners(container, controller);
        }
      },
    });

    if (container) {
      container.innerHTML = controller.renderHtml();
      attachEventListeners(container, controller);
    }

    return controller;
  },
};

function attachEventListeners(container, controller) {
  const btn = container.querySelector("#orbit-btn-generate");
  if (btn) {
    btn.onclick = () => controller.generateCode();
  }
}

/**
 * DSH Client Plugin Entrypoint.
 * Injects into `slots.inject('settings.section')`.
 *
 * @param {object} ctx - DSH client context
 */
export function apply(ctx) {
  if (typeof window === "undefined" && typeof globalThis.window === "undefined") {
    // SSR / Node safe guard
    return;
  }

  const slots = ctx && typeof ctx.get === "function" ? ctx.get("slots") : ctx?.slots;

  if (slots && typeof slots.inject === "function") {
    slots.inject("settings.section", function () {
      if (typeof slots.register === "function") {
        return slots.register(
          {
            name: "settings.section",
            id: ORBIT_SETTINGS_SECTION_ID,
            order: ORBIT_SETTINGS_SECTION_ORDER,
            label: () => "Orbit Remote & Fleet",
          },
          OrbitSettingsSection,
        );
      }
    });
  }
}

export { generateQrSvg };
