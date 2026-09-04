// Pure Presentation and View-Model functions for Endpoint Selector UI
// Operates on server-provided selector read model; never calculates route eligibility.

export function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>'"]/g, (tag) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[tag] || tag));
}

export function renderLoadingState() {
  return '<div class="banner loading" role="status">Loading registered endpoints&hellip;</div>';
}

export function renderEmptyState() {
  return '<div class="banner empty" role="status">No endpoints currently registered in Orbit Hub.</div>';
}

export function formatErrorMessage(msg) {
  if (!msg) return "An unexpected error occurred while loading endpoints.";
  return `Failed to load endpoints: ${msg}`;
}

export function formatBadge(dimension, value) {
  const safeDim = escapeHtml(dimension);
  const safeVal = escapeHtml(value || "unknown");
  const cls = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return `<span class="badge ${cls}" title="${safeDim}: ${safeVal}"><span class="dimension">${safeDim}</span>${safeVal}</span>`;
}

export function createSelectorRowElement(node) {
  const card = document.createElement("article");
  card.className = `selector-card ${node.route?.eligible ? "eligible" : "ineligible"}`;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-label", `Endpoint ${node.nodeId}`);

  const safeNodeId = escapeHtml(node.nodeId);
  const dshVer = escapeHtml(node.runtimeIdentity?.dshVersion || "unknown");
  const orbitVer = escapeHtml(node.runtimeIdentity?.orbitVersion || "unknown");

  const contactBadge = formatBadge("contact", node.health?.registryContact);
  const reachBadge = formatBadge("reach", node.health?.reachable);
  const compatBadge = formatBadge("compat", node.health?.orbitCompatible);

  const hasWebRoutes = (node.health?.capabilities || []).some((c) => c.name === "web.routes");
  const webRoutesVal = node.health?.capabilitiesStale
    ? "stale"
    : (hasWebRoutes ? "pass" : "missing");
  const webRoutesBadge = formatBadge("web.routes", webRoutesVal);

  let actionHtml = "";
  if (node.route?.eligible && node.route?.openUrl) {
    const safeUrl = escapeHtml(node.route.openUrl);
    actionHtml = `<a href="${safeUrl}" class="open-button" aria-label="Open endpoint ${safeNodeId}">Open</a>`;
  } else {
    const reasonText = escapeHtml(node.route?.reason || "Unavailable");
    actionHtml = `
      <span class="unavailable-reason" role="status" aria-label="Status: ${reasonText}">${reasonText}</span>
      <button type="button" class="disabled-button" disabled aria-disabled="true">Unavailable</button>
    `;
  }

  card.innerHTML = `
    <div class="card-header">
      <span class="node-title">${safeNodeId}</span>
      <div class="node-meta">
        <span>DSH: <strong>${dshVer}</strong></span>
        <span>Orbit: <strong>${orbitVer}</strong></span>
      </div>
    </div>
    <div class="dimension-badges">
      ${contactBadge}
      ${reachBadge}
      ${compatBadge}
      ${webRoutesBadge}
    </div>
    <div class="card-footer">
      ${actionHtml}
    </div>
  `;

  return card;
}
