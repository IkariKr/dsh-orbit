// v0.3 operator UI application (SOP Stage 5). Talks ONLY through the
// RFC-0007 browser management API: session bootstrap, CSRF header,
// explicit destructive confirmation (requestId), token plaintext shown
// exactly once. The UI never re-derives health or re-interprets
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
      banner.innerHTML = `<div class="banner empty">no enrollment tokens yet</div>`;
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

  function renderNodeRow(node) {
    const capabilities = node.health.capabilities
      .map((name) => `<span class="capability-chip">${escapeHtml(name)}</span>`)
      .join(" ");
    const evidence =
      node.health.capabilitiesStale && node.health.capabilityEvidence.length > 0
        ? `<div class="capability-evidence">withheld; evidence held: ${node.health.capabilityEvidence
            .map((name) => escapeHtml(name))
            .join(", ")}</div>`
        : "";
    const alerts = node.health.alertFlags.map((flag) => `<span class="alert-flag">alert: ${escapeHtml(flag)}</span>`).join(" ");
    const actions =
      node.state === "active"
        ? `<button class="danger" data-delete-id="${escapeHtml(node.nodeId)}">delete</button>`
        : "";
    return `<div class="panel node-row">
      <div>
        <div class="node-id">${escapeHtml(node.nodeId)}</div>
        <div class="node-meta">runtime ${escapeHtml(node.runtimeIdentity.dshVersion ?? "-")} rev ${escapeHtml(node.runtimeIdentity.orbitRevision ?? "-")} · lastSeen ${escapeHtml(node.health.lastSeen ?? "never")} (${escapeHtml(node.health.lastSeenSource ?? "-")})</div>
        ${alerts}
        ${evidence}
      </div>
      <div>
        ${renderBadges(node)}
        <div class="node-meta" style="margin-top:8px">${capabilities}</div>
        ${actions}
      </div>
    </div>`;
  }

  function renderNodes(view) {
    if (view.kind !== "nodes") return;
    $("nodes-view").innerHTML = `<div class="panel">${view.rows.map(renderNodeRow).join("")}</div>`;
  }

  function renderTokens(view) {
    if (view.kind !== "tokens") return;
    const rows = view.rows
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
    $("tokens-view").innerHTML = `<div class="panel">
      <button class="primary" id="mint-token">Mint enrollment token</button>
      <div id="mint-result"></div>
      <table><thead><tr><th>tokenId</th><th>purpose</th><th>bound node</th><th>status</th><th>created</th><th>expires</th><th>consumed</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
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
    $("nodes-view").innerHTML = `
      <button id="back-to-nodes">← back</button>
      <div class="panel"><h2>${escapeHtml(detail.nodeId)}</h2>
        <dl class="detail-grid">
          <dt>state</dt><dd>${escapeHtml(detail.state)}</dd>
          <dt>runtime identity</dt><dd>orbit ${escapeHtml(detail.runtimeIdentity.orbitVersion ?? "-")} rev ${escapeHtml(detail.runtimeIdentity.orbitRevision ?? "-")} · dsh ${escapeHtml(detail.runtimeIdentity.dshVersion ?? "-")} · profile ${escapeHtml(detail.runtimeIdentity.compatibilityProfile ?? "-")}</dd>
          <dt>lastSeen</dt><dd>${escapeHtml(detail.health.lastSeen ?? "-")} (${escapeHtml(detail.health.lastSeenSource ?? "-")})</dd>
          <dt>capabilities</dt><dd>${detail.health.capabilities.map((name) => `<span class="capability-chip">${escapeHtml(name)}</span>`).join(" ") || "-"}</dd>
          <dt>capability evidence</dt><dd class="capability-evidence">${detail.health.capabilityEvidence.map((name) => escapeHtml(name)).join(", ") || "-"}</dd>
          <dt>alerts</dt><dd>${detail.health.alertFlags.map((flag) => `<span class="alert-flag">${escapeHtml(flag)}</span>`).join(" ") || "-"}</dd>
        </dl>
        ${renderBadges(detail)}
      </div>
      ${reportBlock}
      <div class="panel"><h3>Events</h3>${events}</div>`;
  }

  async function loadNodes() {
    showBanner(LOADING_STATE);
    try {
      const body = await api("/hub/nodes");
      renderNodes(mapNodeList(body.nodes));
      $("tokens-view").hidden = false;
      showBanner({});
    } catch (error) {
      if (error.sessionRequired) {
        if (await refreshSession()) {
          return loadNodes();
        }
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
      $("nodes-view").hidden = false;
      showBanner({});
      $("mint-token").addEventListener("click", () => mintToken());
    } catch (error) {
      if (error.sessionRequired) {
        if (await refreshSession()) {
          return loadTokens();
        }
        showBanner(SESSION_REQUIRED_STATE);
      } else {
        showBanner({ message: `failed to load tokens: ${error.message}` });
      }
    }
  }

  async function mintToken() {
    const resultEl = $("mint-result");
    resultEl.innerHTML = `<div class="banner loading">minting&hellip;</div>`;
    try {
      const minted = await api("/hub/tokens", { method: "POST", body: { purpose: "enroll" } });
      const view = mapTokenMint(minted);
      // The plaintext appears exactly once; nothing stores it beyond
      // this render, and the list never returns it.
      resultEl.innerHTML = `<div class="plaintext-once">
        <strong>Copy this token now — it will never be shown again.</strong><br>
        <code>${escapeHtml(view.plaintextOnce)}</code>
      </div>`;
      await loadTokens();
    } catch (error) {
      resultEl.innerHTML = `<div class="banner error">mint failed: ${escapeHtml(error.message)}</div>`;
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
      showBanner({
        message: view.idempotentReplay
          ? `node ${nodeId} already deleted by this request (idempotent replay)`
          : `node ${nodeId} deleted (state ${view.state})`,
      });
      await loadNodes();
      await loadTokens();
    } catch (error) {
      showBanner({ message: `delete failed: ${error.message}` });
      await loadNodes();
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
    $("nodes-view").addEventListener("click", (event) => {
      const target = event.target;
      if (target.id === "back-to-nodes") {
        loadNodes();
        return;
      }
      if (target.dataset?.deleteId !== undefined) {
        const nodeId = target.dataset.deleteId;
        $("confirm-dialog-message").textContent = `Delete node ${nodeId}? Requiring a reason and a one-time requestId.`;
        $("confirm-reason").value = "";
        $("confirm-dialog").showModal();
        $("confirm-ok").onclick = () => deleteNode(nodeId);
        $("confirm-cancel").onclick = () => $("confirm-dialog").close();
        return;
      }
      const row = target.closest(".node-id");
      if (row) {
        loadNodeDetail(row.textContent.trim());
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