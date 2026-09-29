// DSH Orbit Endpoint Selector UI application
// Consumes server-side selector read model from /hub/selector/nodes.
// Does NOT recompute route eligibility; renders server-authoritative openUrl and reason.

import {
  createSelectorRowElement,
  formatErrorMessage,
  renderEmptyState,
  renderLoadingState,
} from "./view-model.mjs";

// RFC-0018 D5 refresh model: periodic polling with the manual refresh
// retained. Polls are silent (no loading flicker); a failed poll degrades to
// the existing error banner. No push/SSE channel is introduced.
const POLL_INTERVAL_MS = 30_000;

class SelectorApp {
  constructor({ pollIntervalMs = POLL_INTERVAL_MS } = {}) {
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimer = null;
    this.pollInFlight = false;
    this.session = null;
    this.state = {
      loading: true,
      nodes: [],
      error: null,
      authError: null,
    };
    this.lastNodesJson = null;

    this.sessionStatusEl = document.getElementById("session-status");
    this.stateBannerEl = document.getElementById("state-banner");
    this.nodesListEl = document.getElementById("nodes-list");
    this.refreshBtn = document.getElementById("nav-refresh");
    this.logoutBtn = document.getElementById("nav-logout");

    this.refreshBtn?.addEventListener("click", () => this.fetchNodes());
    this.logoutBtn?.addEventListener("click", () => this.handleLogout());
  }

  async init() {
    try {
      await this.ensureSession();
      await this.fetchNodes();
      this.startPolling();
    } catch (err) {
      this.renderAuthError(err.message);
    }
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollNodes();
    }, this.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // Silent refresh: never shows the loading banner; a failure degrades to
  // the existing error banner (Retry affordance included, same as the
  // manual path). Overlapping polls are dropped, and an unchanged node list
  // is not re-rendered so keyboard focus survives idle polls.
  async pollNodes() {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const res = await fetch("/hub/selector/nodes", {
        headers: { "sec-fetch-site": "same-origin" },
      });
      if (res.status === 401 || res.status === 403) {
        this.state.error = "Session expired — click Refresh to re-authenticate.";
        this.renderErrorBanner(this.state.error, { withRetry: false });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.state.error = body?.error?.message || `Refresh failed (${res.status})`;
        this.renderErrorBanner(this.state.error, { withRetry: true });
        return;
      }
      const data = await res.json();
      const nextNodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const nextJson = JSON.stringify(nextNodes);
      this.state.nodes = nextNodes;
      this.state.error = null;
      if (nextJson === this.lastNodesJson) {
        // Unchanged data: clear a stale error banner without rebuilding the
        // list, so keyboard focus and scroll position survive idle polls.
        if (this.stateBannerEl && this.stateBannerEl.innerHTML !== "") {
          this.stateBannerEl.innerHTML = "";
        }
        return;
      }
      this.lastNodesJson = nextJson;
      this.render();
    } catch (err) {
      this.state.error = err.message;
      this.renderErrorBanner(err.message, { withRetry: true });
    } finally {
      this.pollInFlight = false;
    }
  }

  // Single shared error-banner renderer: the manual path renders it with a
  // Retry button; poll failures reuse the identical contract.
  renderErrorBanner(message, { withRetry = true } = {}) {
    if (!this.stateBannerEl) return;
    const retry = withRetry
      ? `<button type="button" class="retry-button" id="retry-btn">Retry</button>`
      : "";
    this.stateBannerEl.innerHTML = `
      <div class="banner error" role="alert">
        ${escapeHtml(formatErrorMessage(message))}
        ${retry}
      </div>
    `;
    if (withRetry) {
      document.getElementById("retry-btn")?.addEventListener("click", () => this.fetchNodes());
    }
  }

  async ensureSession() {
    this.updateSessionStatus("connecting...", "loading");
    // Try GET /hub/session to check existing session cookie
    let res = await fetch("/hub/session", {
      method: "GET",
      headers: { "sec-fetch-site": "same-origin" },
    });

    // If no active session, bootstrap session
    if (!res.ok) {
      res = await fetch("/hub/session", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Session bootstrap failed (${res.status})`);
    }

    this.session = await res.json();
    this.updateSessionStatus(`operator: ${this.session.principal}`, "ok");
  }

  async handleLogout() {
    this.stopPolling();
    if (!this.session?.csrfToken) return;
    try {
      await fetch("/hub/session/logout", {
        method: "POST",
        headers: {
          "sec-fetch-site": "same-origin",
          "x-csrf-token": this.session.csrfToken,
        },
      });
    } catch {}
    this.session = null;
    this.updateSessionStatus("logged out", "bad");
    this.renderAuthError("Session ended. Please reload or authenticate.");
  }

  updateSessionStatus(text, statusClass) {
    if (!this.sessionStatusEl) return;
    this.sessionStatusEl.textContent = text;
    this.sessionStatusEl.className = `session-status ${statusClass}`;
  }

  renderAuthError(message) {
    this.state.loading = false;
    this.state.authError = message;
    if (this.stateBannerEl) {
      this.stateBannerEl.innerHTML = `<div class="banner auth-error" role="alert">Authentication error: ${escapeHtml(message)}</div>`;
    }
    if (this.nodesListEl) {
      this.nodesListEl.innerHTML = "";
    }
  }

  async fetchNodes() {
    this.state.loading = true;
    this.state.error = null;
    if (this.stateBannerEl) {
      this.stateBannerEl.innerHTML = renderLoadingState();
    }

    try {
      const res = await fetch("/hub/selector/nodes", {
        headers: { "sec-fetch-site": "same-origin" },
      });

      if (res.status === 401 || res.status === 403) {
        // Try to re-bootstrap session once
        await this.ensureSession();
        return this.fetchNodes();
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Failed to load nodes (${res.status})`);
      }

      const data = await res.json();
      this.state.loading = false;
      this.state.nodes = Array.isArray(data?.nodes) ? data.nodes : [];
      this.lastNodesJson = JSON.stringify(this.state.nodes);
      this.render();
    } catch (err) {
      this.state.loading = false;
      this.state.error = err.message;
      this.renderErrorBanner(err.message, { withRetry: true });
      if (this.nodesListEl) {
        this.nodesListEl.innerHTML = "";
      }
    }
  }

  render() {
    if (this.stateBannerEl) {
      this.stateBannerEl.innerHTML = "";
    }

    if (!this.nodesListEl) return;
    this.nodesListEl.innerHTML = "";

    if (this.state.nodes.length === 0) {
      this.nodesListEl.innerHTML = renderEmptyState();
      return;
    }

    for (const node of this.state.nodes) {
      const card = createSelectorRowElement(node);
      this.nodesListEl.appendChild(card);
    }
  }
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>'"]/g, (tag) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[tag] || tag));
}

export { SelectorApp, POLL_INTERVAL_MS };

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const app = new SelectorApp();
    app.init();
  });
}
