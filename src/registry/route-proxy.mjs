// Route Proxy & Eligibility Engine (RFC-0010 D1, D4, D5, D6, D7, D8, Stage 3).
// Handles deterministic public route authority dispatch, 5-condition eligibility
// evaluation, hop-by-hop ORBIT-ROUTE-V1 signing, request/response streaming,
// security header stripping, and host-only cookie isolation.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";
import { randomHex } from "./crypto.mjs";
import { computeRouteAuthority, validateRouteDomain } from "./protocol.mjs";
import { signRouteRequest } from "./route-auth.mjs";
import { extendDefaultCaCertificates } from "../tls-trust.mjs";

const ROUTE_HOST_PATTERN = /^n-([0-9a-f]{32})\.(.+)$/i;

// Parse incoming Host header into { nodeId, routeAuthority } against configured routeDomain
export function parseRouteAuthority(hostHeader, configuredRouteDomain) {
  if (typeof hostHeader !== "string" || !hostHeader) return null;
  const cleanHost = hostHeader.trim().toLowerCase();
  // Strip port if present for domain matching, but preserve port in authority if original carried it
  const hostWithoutPort = cleanHost.replace(/:\d+$/, "");
  const cleanDomain = validateRouteDomain(configuredRouteDomain);
  const domainWithoutPort = cleanDomain.replace(/:\d+$/, "");

  const match = hostWithoutPort.match(ROUTE_HOST_PATTERN);
  if (!match) return null;

  const hex = match[1].toLowerCase();
  const domainPart = match[2];

  if (domainPart !== domainWithoutPort) {
    return null;
  }

  const nodeId = `node_${hex}`;
  const routeAuthority = computeRouteAuthority(nodeId, configuredRouteDomain);
  return { nodeId, routeAuthority };
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
  if (!activeKey || (activeKey.state !== "active" && activeKey.state !== "rotating")) {
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
  caCertificates = null,
  nowMs = Date.now(),
}) {
  const { nodeId, routeTargetOrigin, activeKey } = snapshot;

  // RFC-0010 D5: exact rawTarget without decode, re-encode, or query modification
  const rawTarget = req.url;
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
  const targetUrl = new URL(rawTarget, routeTargetOrigin);

  const forwardHeaders = {
    ...sanitizedHeaders,
    ...routeHeaders,
    host: routeAuthority,
    "x-orbit-route-authority": routeAuthority,
  };

  const isHttps = targetUrl.protocol === "https:";
  const clientMod = isHttps ? https : http;

  // The route target origin identifies where the Hub connects to the Node's route ingress.
  // When forwardHeaders.host is set to routeAuthority (the public browser-facing Host),
  // Node.js TLS verification will by default check the certificate SAN against headers.host unless servername is explicit.
  // Explicitly set servername to targetUrl.hostname so TLS verifies against the actual route target host/SAN.
  const reqOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: rawTarget,
    method,
    headers: forwardHeaders,
    timeout: 30000,
  };

  if (isHttps) {
    reqOptions.servername = targetUrl.hostname;
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
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { code: "node-unavailable", message: "Selected node is unavailable" },
      }));
    }
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("upstream request timeout"));
  });

  // Stream request body directly to upstream without buffering
  req.pipe(upstreamReq);
}
