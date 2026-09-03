// Route Proxy & Eligibility Engine (RFC-0010 D1, D4, D5, D6, D7, D8, Stage 3).
// Handles deterministic public route authority dispatch, 5-condition eligibility
// evaluation, hop-by-hop ORBIT-ROUTE-V1 signing, request/response streaming,
// security header stripping, and host-only cookie isolation.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";
import { randomHex } from "./crypto.mjs";
import { computeRouteAuthority, isValidOriginFormTarget, validateRouteDomain } from "./protocol.mjs";
import { signRouteRequest } from "./route-auth.mjs";
import { extendDefaultCaCertificates } from "../tls-trust.mjs";

export { isValidOriginFormTarget };

const ROUTE_HOST_PATTERN = /^n-([0-9a-f]{32})\.(.+)$/i;

// Unified Host Authority Classification:
// Evaluates an incoming Host header against the configured routeDomain.
// Handles FQDN trailing-dot normalization (e.g. "dsh.example.com." -> "dsh.example.com").
// Returns one of:
// - { type: "node-route", nodeId, routeAuthority } (valid deterministic n-<32hex> node authority)
// - { type: "selector-apex", authority } (exact apex selector authority e.g. "dsh.example.com")
// - { type: "invalid-route-domain", reason } (any other host inside or targeting the routeDomain namespace)
// - { type: "unrelated", authority } (unrelated host e.g. "127.0.0.1", "localhost", "registration.example")
export function classifyHostAuthority(hostHeader, configuredRouteDomain) {
  if (typeof hostHeader !== "string" || !hostHeader) {
    return { type: "unrelated", authority: null };
  }

  const cleanHost = hostHeader.trim().toLowerCase();

  if (!configuredRouteDomain) {
    return { type: "unrelated", authority: cleanHost };
  }

  let cleanDomain;
  try {
    cleanDomain = validateRouteDomain(configuredRouteDomain);
  } catch {
    return { type: "unrelated", authority: cleanHost };
  }

  const domainParts = cleanDomain.split(":");
  const domainHostname = domainParts[0];
  const domainPort = domainParts.length === 2 ? domainParts[1] : null;

  // Generic bracketed IPv6 authorities (for example [::1]:5445) cannot
  // belong to the DNS route-domain namespace. Leave them to the existing
  // Registry ingress instead of misclassifying them as invalid node routes.
  if (cleanHost.startsWith("[")) {
    return { type: "unrelated", authority: cleanHost };
  }

  // Determine namespace membership before applying the strict Orbit DNS
  // authority grammar. This preserves unrelated legacy/private Host values,
  // while malformed values that still target the route domain fail closed.
  const firstColon = cleanHost.indexOf(":");
  const rawHostname = firstColon === -1 ? cleanHost : cleanHost.slice(0, firstColon);
  const trailingDots = rawHostname.match(/\.+$/)?.[0].length ?? 0;
  const namespaceHostname = rawHostname.replace(/\.+$/, "");
  const targetsApex = namespaceHostname === domainHostname;
  const targetsSubdomain = namespaceHostname.endsWith(`.${domainHostname}`);

  if (!targetsApex && !targetsSubdomain) {
    return { type: "unrelated", authority: cleanHost };
  }

  // One trailing dot is the normal FQDN spelling and is canonicalized away.
  // More than one trailing dot is malformed but still targets the route
  // namespace, so it must never fall through to Registry APIs.
  if (trailingDots > 1) {
    return { type: "invalid-route-domain", reason: "multiple-trailing-dots" };
  }

  const normalizedHost = cleanHost.replace(/\.(:\d+)?$/, "$1");
  if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(normalizedHost)) {
    return { type: "invalid-route-domain", reason: "malformed-authority-grammar" };
  }

  const parts = normalizedHost.split(":");
  const hostHostname = parts[0];
  const hostPort = parts.length === 2 ? parts[1] : null;

  // Check the canonicalized hostname against the configured route namespace.
  const isApex = hostHostname === domainHostname;
  const isSubdomain = hostHostname.endsWith(`.${domainHostname}`);

  // Exact port matching
  if (domainPort) {
    if (hostPort !== domainPort) {
      return { type: "invalid-route-domain", reason: "port-mismatch" };
    }
  } else {
    if (hostPort !== null) {
      return { type: "invalid-route-domain", reason: "unexpected-port" };
    }
  }

  // Exact apex: this is the selector authority
  if (isApex) {
    return { type: "selector-apex", authority: cleanDomain };
  }

  // Subdomain: check if it matches deterministic node authority
  const match = hostHostname.match(ROUTE_HOST_PATTERN);
  if (!match) {
    return { type: "invalid-route-domain", reason: "non-node-subdomain" };
  }

  const hex = match[1].toLowerCase();
  const domainPart = match[2];

  if (domainPart !== domainHostname) {
    return { type: "invalid-route-domain", reason: "domain-suffix-mismatch" };
  }

  const nodeId = `node_${hex}`;
  const routeAuthority = computeRouteAuthority(nodeId, configuredRouteDomain);
  return { type: "node-route", nodeId, routeAuthority };
}

// Legacy helper preserved for callers:
export function isRouteDomainHost(hostHeader, configuredRouteDomain) {
  const classification = classifyHostAuthority(hostHeader, configuredRouteDomain);
  return classification.type === "node-route" || classification.type === "selector-apex" || classification.type === "invalid-route-domain";
}

// Compute selector return link for unavailable 503 responses (RFC-0010 D1, D7)
export function getSelectorReturnUrl(configuredRouteDomain, trustedScheme = "https") {
  if (!configuredRouteDomain) return "/";
  const cleanDomain = validateRouteDomain(configuredRouteDomain);
  return `${trustedScheme}://${cleanDomain}/`;
}

// Parse incoming Host header into { nodeId, routeAuthority } against configured routeDomain.
// Returns { nodeId, routeAuthority } if valid, null otherwise.
export function parseRouteAuthority(hostHeader, configuredRouteDomain) {
  const classification = classifyHostAuthority(hostHeader, configuredRouteDomain);
  if (classification.type === "node-route") {
    return { nodeId: classification.nodeId, routeAuthority: classification.routeAuthority };
  }
  return null;
}

// Evaluate RFC-0010 5-condition eligibility:
// 1. node.state === active
// 2. operator-approved routeTarget exists
// 3. reachable === ok
// 4. per-node Hub route identity is active
// 5. web.routes is present and backed by fresh compatibility evidence
export function evaluateRouteEligibility(registry, nodeId) {
  const nodeRow = registry.getNodeRow(nodeId);
  if (!nodeRow || nodeRow.state !== "active") {
    return { eligible: false, reason: "node-not-active" };
  }

  const routeTarget = registry.getRouteTarget(nodeId);
  if (!routeTarget || !routeTarget.origin) {
    return { eligible: false, reason: "no-route-target" };
  }

  if (nodeRow.reachable !== "ok") {
    return { eligible: false, reason: `node-not-reachable: ${nodeRow.reachable}` };
  }

  const activeKey = registry.getActiveHubRouteKey(nodeId);
  if (!activeKey || activeKey.state !== "active") {
    return { eligible: false, reason: "no-active-hub-route-key" };
  }

  // web.routes presence & fresh compatibility evidence
  if (nodeRow.capabilities_stale === 1 || nodeRow.orbit_compatible === "stale" || nodeRow.orbit_compatible === "unknown") {
    return { eligible: false, reason: "compatibility-evidence-stale" };
  }

  let capabilities = [];
  try {
    capabilities = JSON.parse(nodeRow.capabilities);
  } catch {
    capabilities = [];
  }
  const hasWebRoutes = Array.isArray(capabilities) && capabilities.some((cap) => cap.name === "web.routes");
  if (!hasWebRoutes) {
    return { eligible: false, reason: "web-routes-capability-missing" };
  }

  return {
    eligible: true,
    snapshot: {
      nodeId,
      routeTargetOrigin: routeTarget.origin,
      activeKey,
    },
  };
}

// Cookie isolation (RFC-0010 D7): strip Domain=... attributes from Set-Cookie headers
// to make them strictly host-only to the public node authority
export function sanitizeSetCookieHeader(headerValue) {
  if (Array.isArray(headerValue)) {
    return headerValue.map(sanitizeSingleCookie);
  }
  if (typeof headerValue === "string") {
    return sanitizeSingleCookie(headerValue);
  }
  return headerValue;
}

function sanitizeSingleCookie(cookieStr) {
  // Split cookie attributes by semicolon
  const parts = cookieStr.split(";");
  const filtered = parts.filter((part) => {
    const trimmed = part.trim();
    return !trimmed.toLowerCase().startsWith("domain=");
  });
  return filtered.join(";");
}

// Strip management credentials and client-supplied route proof headers defensively
export function sanitizeClientHeaders(headers) {
  const out = {};
  for (const [key, val] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // Strip client-supplied route proofs
    if (lower.startsWith("x-orbit-route-")) continue;
    // Strip Hub management session cookies defensively
    if (lower === "cookie" && typeof val === "string") {
      const sanitizedCookies = val
        .split(";")
        .map((c) => c.trim())
        .filter((c) => !c.startsWith("dsh-orbit-hub-session="))
        .join("; ");
      if (sanitizedCookies) {
        out[key] = sanitizedCookies;
      }
      continue;
    }
    // Strip gateway assertion and principal headers
    if (lower === "x-dsh-authenticated-proxy" || lower === "x-dsh-operator-id" || lower === "x-csrf-token") {
      continue;
    }
    out[key] = val;
  }
  return out;
}

// Stream HTTP request to Node RouteIngress with ORBIT-ROUTE-V1
export function proxyHttpRequest({
  req,
  res,
  snapshot,
  routeAuthority,
  configuredRouteDomain = null,
  trustedScheme = "https",
  caCertificates = null,
  nowMs = Date.now(),
}) {
  const { nodeId, routeTargetOrigin, activeKey } = snapshot;

  // RFC-0010 D5: exact rawTarget without decode, re-encode, or query modification
  const rawTarget = req.url;
  if (!isValidOriginFormTarget(rawTarget)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { code: "invalid-target", message: "only origin-form request-target is supported" },
    }));
    return;
  }

  const method = req.method;

  const nonce = randomHex(16);
  const { headers: routeHeaders } = signRouteRequest({
    privateKeyHex: activeKey.private_key,
    keyId: activeKey.key_id,
    nodeId,
    routeAuthority,
    method,
    rawTarget,
    nowMs,
    nonce,
  });

  const sanitizedHeaders = sanitizeClientHeaders(req.headers);

  // Connection destination ALWAYS comes from operator-approved routeTargetOrigin.
  // rawTarget is never used to determine connection destination.
  let originUrl;
  try {
    originUrl = new URL(routeTargetOrigin);
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { code: "invalid-route-target", message: "persisted route target origin is invalid" },
    }));
    return;
  }

  const forwardHeaders = {
    ...sanitizedHeaders,
    ...routeHeaders,
    host: routeAuthority,
    "x-orbit-route-authority": routeAuthority,
  };

  const isHttps = originUrl.protocol === "https:";
  const clientMod = isHttps ? https : http;

  // The route target origin identifies where the Hub connects to the Node's route ingress.
  // Host header is set to routeAuthority, and servername is explicitly set to originUrl.hostname
  // so TLS verifies against the actual route target origin SAN.
  const reqOptions = {
    protocol: originUrl.protocol,
    hostname: originUrl.hostname,
    port: originUrl.port || (isHttps ? 443 : 80),
    path: rawTarget,
    method,
    headers: forwardHeaders,
    timeout: 30000,
  };

  if (isHttps) {
    reqOptions.servername = originUrl.hostname;
    if (caCertificates) {
      reqOptions.ca = extendDefaultCaCertificates(caCertificates);
    }
  }

  const upstreamReq = clientMod.request(reqOptions, (upstreamRes) => {
    // Sanitize response headers
    const responseHeaders = { ...upstreamRes.headers };
    if (responseHeaders["set-cookie"]) {
      responseHeaders["set-cookie"] = sanitizeSetCookieHeader(responseHeaders["set-cookie"]);
    }

    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      const selectorUrl = getSelectorReturnUrl(configuredRouteDomain, trustedScheme);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          code: "node-unavailable",
          message: "Selected node is unavailable",
          selectorUrl,
        },
      }));
    }
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("upstream request timeout"));
  });

  // Stream request body directly to upstream without buffering
  req.pipe(upstreamReq);
}
