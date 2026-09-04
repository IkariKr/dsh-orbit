// Server-side Selector Read Model (RFC-0010, RFC-0011, Stage 5 Guide)
// Projects Registry state into a sanitized read model for the browser Endpoint Selector.
// Authoritatively derives route eligibility via evaluateRouteEligibility() and computes
// deterministic openUrl; strips all private credentials, internal targets, and raw reports.

import { computeRouteAuthority } from "./protocol.mjs";
import { evaluateRouteEligibility } from "./route-proxy.mjs";

export const SELECTOR_REASON_MAP = Object.freeze({
  "node-not-active": {
    code: "node-inactive",
    message: "Node is not active",
  },
  "no-route-target": {
    code: "no-route-target",
    message: "Route target is not configured",
  },
  "node-not-reachable: unknown": {
    code: "route-reachability-unverified",
    message: "Route reachability is not verified yet",
  },
  "node-not-reachable: unreachable": {
    code: "route-unreachable",
    message: "Route ingress or downstream DSH is unreachable",
  },
  "no-active-hub-route-key": {
    code: "hub-route-identity-unavailable",
    message: "Hub route identity is not active",
  },
  "compatibility-evidence-stale": {
    code: "compatibility-evidence-stale",
    message: "Compatibility evidence is stale",
  },
  "web-routes-capability-missing": {
    code: "web-routes-unavailable",
    message: "Web routing compatibility evidence is unavailable",
  },
});

export function mapEligibilityReason(serverReason) {
  if (!serverReason) return { code: null, message: null };
  if (SELECTOR_REASON_MAP[serverReason]) {
    return SELECTOR_REASON_MAP[serverReason];
  }
  if (serverReason.startsWith("node-not-reachable:")) {
    return {
      code: "route-unreachable",
      message: "Route ingress or downstream DSH is unreachable",
    };
  }
  return {
    code: "unavailable",
    message: "Node is currently unavailable for routing",
  };
}

export function buildSelectorNodeRow(registry, nodeRow, { routeDomain, trustedScheme = "https" } = {}) {
  const nodeId = nodeRow.node_id;
  const eligibility = evaluateRouteEligibility(registry, nodeId);

  let capabilities = [];
  try {
    capabilities = JSON.parse(nodeRow.capabilities ?? "[]");
  } catch {
    capabilities = [];
  }

  const { code: reasonCode, message: reason } = eligibility.eligible
    ? { code: null, message: null }
    : mapEligibilityReason(eligibility.reason);

  const openUrl = eligibility.eligible && routeDomain
    ? `${trustedScheme}://${computeRouteAuthority(nodeId, routeDomain)}/`
    : null;

  return {
    nodeId,
    state: nodeRow.state,
    runtimeIdentity: {
      orbitVersion: nodeRow.orbit_version || null,
      orbitRevision: nodeRow.orbit_revision || null,
      dshVersion: nodeRow.dsh_version || null,
      compatibilityProfile: nodeRow.compatibility_profile || null,
    },
    health: {
      registryContact: nodeRow.registry_contact,
      reachable: nodeRow.reachable,
      orbitCompatible: nodeRow.orbit_compatible,
      capabilities: capabilities.map((c) => ({ name: c.name, version: c.version })),
      capabilitiesStale: Boolean(nodeRow.capabilities_stale),
      lastSeen: nodeRow.last_seen || null,
      lastSeenSource: nodeRow.last_seen_source || null,
    },
    route: {
      eligible: eligibility.eligible,
      reasonCode,
      reason,
      openUrl,
    },
  };
}

export function isHtmlAccept(acceptHeader) {
  if (typeof acceptHeader !== "string") return false;
  const lower = acceptHeader.toLowerCase();
  if (!lower.includes("text/html")) return false;
  if (!lower.includes("application/json")) return true;
  return lower.indexOf("text/html") < lower.indexOf("application/json");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderUnavailableHtml({ reasonMessage = "Selected node is unavailable", routeAuthority = "", selectorUrl = "/" } = {}) {
  const safeReason = escapeHtml(reasonMessage);
  const safeAuthority = escapeHtml(routeAuthority);
  const safeSelectorUrl = escapeHtml(selectorUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Endpoint Unavailable - DSH Orbit</title>
  <style>
    body { margin: 0; background: #101418; color: #e6edf3; font: 14px/1.5 system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a2027; border: 1px solid #33404d; border-radius: 8px; padding: 24px 28px; max-width: 480px; width: 100%; margin: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    h1 { font-size: 18px; margin: 0 0 12px 0; color: #f85149; }
    p { margin: 0 0 16px 0; color: #9aa7b4; }
    .meta { font-family: monospace; font-size: 13px; color: #e6edf3; background: #212a33; padding: 6px 10px; border-radius: 4px; margin-bottom: 20px; word-break: break-all; }
    a.btn { display: inline-block; background: #2ea043; color: #fff; text-decoration: none; padding: 8px 18px; border-radius: 6px; font-weight: 600; font-size: 13px; }
    a.btn:hover { background: #2c973f; }
  </style>
</head>
<body>
  <div class="card" role="alert">
    <h1>Selected Endpoint Unavailable</h1>
    <p>${safeReason}</p>
    ${safeAuthority ? `<div class="meta">${safeAuthority}</div>` : ""}
    <a href="${safeSelectorUrl}" class="btn">Return to Endpoint Selector</a>
  </div>
</body>
</html>`;
}

export function buildSelectorReadModel(registry, { routeDomain, trustedScheme = "https" } = {}) {
  const nodes = registry.db
    .prepare("SELECT * FROM nodes ORDER BY minted_at ASC, node_id ASC")
    .all();

  return {
    nodes: nodes.map((nodeRow) =>
      buildSelectorNodeRow(registry, nodeRow, { routeDomain, trustedScheme }),
    ),
  };
}
