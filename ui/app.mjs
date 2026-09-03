// v0.3 operator UI application (SOP Stage 5 + Gate B closure). Talks
// ONLY through the RFC-0007 browser management API: session bootstrap,
// CSRF header, explicit destructive confirmation (requestId),
// token plaintext shown exactly once and retained until the user
// leaves/closes the view, tombstoned nodes offer the re-enrollment
// token mint. The UI never re-derives health or re-interprets
// destructive semantics.

import {
  BOOTSTRAP_ERROR_STATE,
  EMPTY_NODES_STATE,
  EMPTY_TOKENS_STATE,
  LOADING_STATE,
  SESSION_REQUIRED_STATE,
  createDeleteRequestId,
  mapApiError,
  mapDeleteResult,
  mapNodeDetail,
  mapNodeList,
  mapTokenList,
  mapTokenMint,
} from "./view-model.mjs";

const SESSION_ERRORS = new Set(["gateway-denied", "no-principal", "no-session"]);

export function createRegistryUi({ document, fetchImpl }) {
  let csrfToken = null;
  let sessionPrincipal = null;

  function $(id) {
    return document.getElementById(id);
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = { "content-type": "application/json" };
    if (csrfToken !== null && method !== "GET") headers["x-csrf-token"] = csrfToken;
    const response = await fetchImpl(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (response.status === 401 && SESSION_ERRORS.has(parsed?.error?.code)) {
      throw Object.assign(new Error("session required"), { sessionRequired: true });
    }
    if (!response.ok) {
      throw Object.assign(new Error(mapApiError(parsed).message), { code: parsed?.error?.code, status: response.status });
    }
    return parsed;
  }

  async function bootstrap() {
    const session = await api("/hub/session", { method: "POST" });
    csrfToken = session.csrfToken;
    sessionPrincipal = session.principal;
    return session;
  }

  async function refreshSession() {
    try {
      csrfToken = null;
      await bootstrap();
      return true;
    } catch {
      return false;
    }
  }

  function showBanner(state) {
    const banner = $("state-banner");
    if (state.kind === "loading") {
      banner.innerHTML = `<div class="banner loading">loading&hellip;</div>`;
    } else if (state.kind === "empty-nodes") {
      banner.innerHTML = `<div class="banner empty">no nodes registered yet</div>`;
    } else if (state.kind === "empty-tokens") {
      banner.innerHTML = `<div class="banner empty">no enrollment tokens yet — mint the first one below</div>`;
    } else if (state.kind === "session-required") {
      banner.innerHTML = `<div class="banner">session required; retrying&hellip;</div>`;
    } else if (state.kind === "bootstrap-error") {
      banner.innerHTML = `<div class="banner error">cannot start a management session: ${escapeHtml(state.message)}</div>`;
    } else if (state.message !== undefined) {
      banner.innerHTML = `<div class="banner error">${escapeHtml(state.message)}</div>`;
    } else {
      banner.innerHTML = "";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function badgeClass(dimension, value) {
    return `badge ${String(value).toLowerCase().replaceAll(" ", "-")}`;
  }

  function renderBadges(node) {
    const badges = [
      ["registryContact", node.health.registryContact],
      ["dshHealthy", node.health.dshHealthy],
      ["orbitCompatible", node.health.orbitCompatible],
      ["reachable", node.health.reachable],
      ["authenticated", node.health.authenticated],
      ["state", node.state],
    ];
    return `<div class="dimension-badges">${badges
      .map(
        ([dimension, value]) =>
          `<span class="${badgeClass(dimension, value)}"><span class="dimension">${dimension}</span>${escapeHtml(value)}</span>`,
      )
      .join("")}</div>`;
  }

  function renderCapabilities(node) {
    const capabilities = node.health.capabilities
      .map((name) => `<span class="capability-chip">${escapeHtml(name)}</span>`)
      .join(" ");
    const evidence =
      node.health.capabilitiesStale && node.health.capabilityEvidence.length > 0
        ? `<div class="capability-evidence">withheld; evidence held: ${node.health.capabilityEvidence
            .map((name) => escapeHtml(name))
            .join(", ")}</div>`
        : "";
    return `${capabilities}${evidence}`;
  }

  function renderNodeRow(node) {
    const alerts = node.health.alertFlags.map((flag) => `<span class="alert-flag">alert: ${escapeHtml(flag)}</span>`).join(" ");
    let actions = "";
    if (node.state === "active") {
      actions = `<button class="danger" data-delete-id="${escapeHtml(node.nodeId)}">delete</button>`;
    } else if (node.state === "tombstoned") {
      actions = `<button class="primary" data-reenroll-id="${escapeHtml(node.nodeId)}">mint re-enrollment token</button>`;
    }
    return `<div class="panel node-row">
      <div>
        <div class="node-id">${escapeHtml(node.nodeId)}</div>
        <div class="node-meta">runtime ${escapeHtml(node.runtimeIdentity.dshVersion ?? "-")} rev ${escapeHtml(node.runtimeIdentity.orbitRevision ?? "-")} · lastSeen ${escapeHtml(node.health.lastSeen ?? "never")} (${escapeHtml(node.health.lastSeenSource ?? "-")}) · lastHeartbeat ${escapeHtml(node.health.lastHeartbeatAt ?? "never")}</div>
        ${alerts}
      </div>
      <div>
        ${renderBadges(node)}
        <div class="node-meta" style="margin-top:8px">${renderCapabilities(node)}</div>
        ${actions}
      </div>
    </div>`;
  }

  function renderNodes(view) {
    const list = $("nodes-list");
    if (view.kind !== "nodes" || view.rows.length === 0) {
      list.innerHTML = `<div class="panel"><div class="banner empty">no nodes registered yet</div></div>`;
      return;
    }
    list.innerHTML = view.rows.map(renderNodeRow).join("");
  }

  function renderTokenRows(rows) {
    if (rows.length === 0) {
      return `<tr><td colspan="7"><div class="banner empty">no enrollment tokens yet — mint the first one above</div></td></tr>`;
    }
    return rows
      .map(
        (token) => `<tr>
          <td>${escapeHtml(token.tokenId)}</td>
          <td>${escapeHtml(token.purpose)}</td>
          <td>${escapeHtml(token.boundNodeId ?? "-")}</td>
          <td><span class="${badgeClass("status", token.status)}">${escapeHtml(token.status)}</span></td>
          <td>${escapeHtml(token.createdAt ?? "-")}</td>
          <td>${escapeHtml(token.expiresAt ?? "-")}</td>
          <td>${escapeHtml(token.consumedAt ?? "-")}</td>
        </tr>`,
      )
      .join("");
  }

  // The mint action and its result live OUTSIDE the re-rendered table:
  // a list refresh NEVER wipes the plaintext-once block (Gate B).
  function renderTokens(view) {
    const table = $("token-table-body");
    table.innerHTML = renderTokenRows(view.kind === "tokens" ? view.rows : []);
  }

  function renderDetail(node) {
    const detail = mapNodeDetail(node);
    const report = detail.latestReport;
    const reportBlock = report
      ? `<div class="panel"><h3>Latest compatibility report</h3>
         <dl class="detail-grid">
           <dt>uploaded</dt><dd>${escapeHtml(report.uploadedAt ?? "-")}</dd>
           <dt>orbit</dt><dd>${escapeHtml(report.orbitVersion ?? "-")} rev ${escapeHtml(report.orbitRevision ?? "-")}</dd>
           <dt>candidate</dt><dd>${escapeHtml(report.dshVersion ?? "-")} (${escapeHtml(report.compatibilityProfile ?? "-")})</dd>
           <dt>compatibility</dt><dd>${escapeHtml(report.compatibility ?? "-")}</dd>
         </dl></div>`
      : `<div class="panel"><h3>Latest compatibility report</h3><div class="banner empty">no report uploaded yet</div></div>`;
    const events =
      detail.events.length === 0
        ? `<div class="banner empty">no events recorded yet</div>`
        : `<div class="events-list">${detail.events
            .map(
              (event) =>
                `<div><span>${escapeHtml(event.at ?? "-")}</span><span class="dim">${escapeHtml(event.dimension ?? "-")}</span><span>${escapeHtml(event.from ?? "")} → ${escapeHtml(event.to ?? "")} (${escapeHtml(event.source ?? "")})</span></div>`,
            )
            .join("")}</div>`;
    const detailView = $("node-detail-view");
    detailView.innerHTML = `
      <button id="back-to-nodes">← back</button>
      <div class="panel"><h2>${escapeHtml(detail.nodeId)}</h2>
        <dl class="detail-grid">
          <dt>state</dt><dd>${escapeHtml(detail.state)}</dd>
          <dt>runtime identity</dt><dd>orbit ${escapeHtml(detail.runtimeIdentity.orbitVersion ?? "-")} rev ${escapeHtml(detail.runtimeIdentity.orbitRevision ?? "-")} · dsh ${escapeHtml(detail.runtimeIdentity.dshVersion ?? "-")} · profile ${escapeHtml(detail.runtimeIdentity.compatibilityProfile ?? "-")}</dd>
          <dt>lastSeen</dt><dd>${escapeHtml(detail.health.lastSeen ?? "-")} (${escapeHtml(detail.health.lastSeenSource ?? "-")})</dd>
          <dt>lastHeartbeat</dt><dd>${escapeHtml(detail.health.lastHeartbeatAt ?? "-")}</dd>
          <dt>capabilities</dt><dd>${detail.health.capabilities.map((name) => `<span class="capability-chip">${escapeHtml(name)}</span>`).join(" ") || "-"}</dd>
          <dt>capability evidence</dt><dd class="capability-evidence">${detail.health.capabilityEvidence.map((name) => escapeHtml(name)).join(", ") || "-"}</dd>
          <dt>alerts</dt><dd>${detail.health.alertFlags.map((flag) => `<span class="alert-flag">${escapeHtml(flag)}</span>`).join(" ") || "-"}</dd>
        </dl>
        ${renderBadges(detail)}
      </div>
      <div class="panel">
        <h3>Route Target</h3>
        <dl class="detail-grid">
          <dt>current target</dt><dd id="current-route-target">${escapeHtml(detail.routeTarget?.origin ?? "none")}</dd>
        </dl>
        ${detail.state === "tombstoned"
          ? `<div class="banner empty" style="margin-top:12px">read-only (node is tombstoned)</div>`
          : `<div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
          <input id="route-target-input" type="text" placeholder="https://nas.example" value="${escapeHtml(detail.routeTarget?.origin ?? "")}" style="flex:1; max-width:320px;">
          <button id="save-route-target" class="primary" type="button" data-node-id="${escapeHtml(detail.nodeId)}">save</button>
          ${detail.routeTarget ? `<button id="remove-route-target" class="danger" type="button" data-node-id="${escapeHtml(detail.nodeId)}">remove</button>` : ""}
        </div>
        <div id="route-target-error" class="banner error" style="margin-top:8px; display:none;"></div>`}
      </div>
      ${reportBlock}
      <div class="panel"><h3>Events</h3>${events}</div>`;
  }

  async function loadNodes() {
    showBanner(LOADING_STATE);
    try {
      const body = await api("/hub/nodes");
      renderNodes(mapNodeList(body.nodes));
      showBanner(body.nodes.length === 0 ? EMPTY_NODES_STATE : {});
    } catch (error) {
      if (error.sessionRequired) {
        if (await refreshSession()) return loadNodes();
        showBanner(SESSION_REQUIRED_STATE);
      } else {
        showBanner({ message: `failed to load nodes: ${error.message}` });
      }
    }
  }

  async function loadTokens() {
    showBanner(LOADING_STATE);
    try {
      const body = await api("/hub/tokens");
      renderTokens(mapTokenList(body.tokens));
      showBanner(body.tokens.length === 0 ? EMPTY_TOKENS_STATE : {});
    } catch (error) {
      if (error.sessionRequired) {
        if (await refreshSession()) return loadTokens();
        showBanner(SESSION_REQUIRED_STATE);
      } else {
        showBanner({ message: `failed to load tokens: ${error.message}` });
      }
    }
  }

  async function mintEnrollmentToken() {
    const resultEl = $("mint-result");
    resultEl.innerHTML = `<div class="banner loading">minting&hellip;</div>`;
    try {
      const minted = await api("/hub/tokens", { method: "POST", body: { purpose: "enroll" } });
      const view = mapTokenMint(minted);
      // Plaintext exactly once; it stays visible until the user leaves
      // the view — the list refresh below never touches this element.
      resultEl.innerHTML = `<div class="plaintext-once">
        <strong>Copy this token now — it will never be shown again.</strong><br>
        <code data-plaintext-once>${escapeHtml(view.plaintextOnce)}</code>
      </div>`;
      await loadTokens();
    } catch (error) {
      resultEl.innerHTML = `<div class="banner error">mint failed: ${escapeHtml(error.message)}</div>`;
    }
  }

  async function mintReenrollToken(nodeId) {
    const resultEl = $("reenroll-result");
    resultEl.innerHTML = `<div class="banner loading">minting&hellip;</div>`;
    try {
      const minted = await api(`/hub/nodes/${nodeId}/reenroll`, { method: "POST" });
      const view = mapTokenMint(minted);
      resultEl.innerHTML = `<div class="plaintext-once">
        <strong>Re-enrollment token for ${escapeHtml(nodeId)} — copy now, shown once.</strong><br>
        <code data-plaintext-once>${escapeHtml(view.plaintextOnce)}</code>
      </div>`;
    } catch (error) {
      resultEl.innerHTML = `<div class="banner error">re-enrollment token mint failed: ${escapeHtml(error.message)}</div>`;
    }
  }

  async function deleteNode(nodeId) {
    const reason = $("confirm-reason").value.trim();
    if (reason === "") return;
    const requestId = createDeleteRequestId();
    const dialog = $("confirm-dialog");
    dialog.close();
    try {
      const result = await api(`/hub/nodes/${nodeId}/delete`, { method: "POST", body: { requestId, reason } });
      const view = mapDeleteResult(result);
      // Refresh FIRST so the result banner is not clobbered by the
      // refresh's own loading banner.
      await loadNodes();
      await loadTokens();
      showBanner({
        message: view.idempotentReplay
          ? `node ${nodeId} already deleted by this request (idempotent replay)`
          : `node ${nodeId} deleted (state ${view.state})`,
      });
    } catch (error) {
      showBanner({ message: `delete failed: ${error.message}` });
      await loadNodes();
    }
  }

  async function saveRouteTarget(nodeId) {
    const input = $("route-target-input");
    const errorEl = $("route-target-error");
    if (errorEl) {
      errorEl.style.display = "none";
      errorEl.textContent = "";
    }
    const routeTarget = input ? input.value.trim() : "";
    try {
      await api(`/hub/nodes/${nodeId}/route-target`, {
        method: "PUT",
        body: { routeTarget },
      });
      await loadNodeDetail(nodeId);
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = `validation error: ${error.message}`;
        errorEl.style.display = "block";
      }
    }
  }

  async function removeRouteTarget(nodeId) {
    const errorEl = $("route-target-error");
    if (errorEl) {
      errorEl.style.display = "none";
      errorEl.textContent = "";
    }
    try {
      await api(`/hub/nodes/${nodeId}/route-target`, { method: "DELETE" });
      await loadNodeDetail(nodeId);
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = `validation error: ${error.message}`;
        errorEl.style.display = "block";
      }
    }
  }

  function wireActions() {
    $("nav-nodes").addEventListener("click", async () => {
      $("nav-nodes").classList.add("active");
      $("nav-tokens").classList.remove("active");
      $("tokens-view").hidden = true;
      $("nodes-view").hidden = false;
      await loadNodes();
    });
    $("nav-tokens").addEventListener("click", async () => {
      $("nav-tokens").classList.add("active");
      $("nav-nodes").classList.remove("active");
      $("nodes-view").hidden = true;
      $("tokens-view").hidden = false;
      await loadTokens();
    });
    $("mint-token").addEventListener("click", () => mintEnrollmentToken());
    $("nodes-list").addEventListener("click", async (event) => {
      const target = event.target;
      if (target.dataset?.deleteId !== undefined) {
        const nodeId = target.dataset.deleteId;
        $("confirm-dialog-message").textContent = `Delete node ${nodeId}? Requiring a reason and a one-time requestId.`;
        $("confirm-reason").value = "";
        $("confirm-dialog").showModal();
        $("confirm-ok").onclick = () => deleteNode(nodeId);
        $("confirm-cancel").onclick = () => $("confirm-dialog").close();
        return;
      }
      if (target.dataset?.reenrollId !== undefined) {
        await mintReenrollToken(target.dataset.reenrollId);
        return;
      }
      const row = target.closest(".node-id");
      if (row) await loadNodeDetail(row.textContent.trim());
    });
    $("node-detail-view").addEventListener("click", async (event) => {
      if (event.target.id === "back-to-nodes") await loadNodes();
      if (event.target.id === "save-route-target") {
        const nodeId = event.target.dataset?.nodeId;
        if (nodeId) await saveRouteTarget(nodeId);
      }
      if (event.target.id === "remove-route-target") {
        const nodeId = event.target.dataset?.nodeId;
        if (nodeId) await removeRouteTarget(nodeId);
      }
    });
    $("nav-logout").addEventListener("click", async () => {
      try {
        await api("/hub/session/logout", { method: "POST" });
      } finally {
        csrfToken = null;
        sessionPrincipal = null;
        $("session-status").textContent = "logged out";
        window.location.reload();
      }
    });
  }

  async function loadNodeDetail(nodeId) {
    showBanner(LOADING_STATE);
    try {
      const body = await api(`/hub/nodes/${nodeId}`);
      $("nodes-list").innerHTML = "";
      $("node-detail-view").hidden = false;
      renderDetail(body);
      showBanner({});
    } catch (error) {
      showBanner({ message: `failed to load node: ${error.message}` });
    }
  }

  async function start() {
    if (!document || !document.getElementById) return; // import-safe (tests)
    wireActions();
    $("session-status").textContent = "connecting&hellip;";
    try {
      const session = await bootstrap();
      $("session-status").textContent = `operator: ${session.principal}`;
      $("session-status").classList.add("ok");
      $("nodes-view").hidden = false;
      await loadNodes();
    } catch (error) {
      if (error.sessionRequired) {
        showBanner(SESSION_REQUIRED_STATE);
      } else {
        showBanner(BOOTSTRAP_ERROR_STATE);
      }
      $("session-status").textContent = "no session";
      $("session-status").classList.add("bad");
    }
  }

  return { start };
}

if (typeof document !== "undefined") {
  createRegistryUi({ document, fetchImpl: globalThis.fetch }).start();
}