// Route Proxy & Eligibility Engine (RFC-0010 D1, D4, D5, D6, D7, D8, Stage 3).
// Handles deterministic public route authority dispatch, 5-condition eligibility
// evaluation, hop-by-hop ORBIT-ROUTE-V1 signing, request/response streaming,
// security header stripping, and host-only cookie isolation.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { randomHex } from "./crypto.mjs";
import { computeRouteAuthority, isValidOriginFormTarget, validateRouteDomain } from "./protocol.mjs";
import { signRouteRequest } from "./route-auth.mjs";
import { extendDefaultCaCertificates } from "../tls-trust.mjs";
import { isHtmlAccept, renderUnavailableHtml } from "./selector-view.mjs";

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

// Evaluate the existing RFC-0010 eligibility policy with an explicit
// transport choice. The returned snapshot is the only routing decision a
// flow may use: later registry/session changes affect new flows only.
export function evaluateRouteEligibility(
  registry,
  nodeId,
  { reverseSessions = null, reverseChannels = null } = {},
) {
  const nodeRow = registry.getNodeRow(nodeId);
  if (!nodeRow || nodeRow.state !== "active") {
    return { eligible: false, reason: "node-not-active" };
  }

  const routeMode = nodeRow.route_mode === "reverse" ? "reverse" : "direct";
  const routeTarget = registry.getRouteTarget(nodeId);
  // Take one current-session snapshot for all reverse decisions. Reading
  // presence, readiness, and sessionId through separate calls can otherwise
  // combine two generations during a takeover and bind a flow to the wrong
  // transport state.
  const reverseSessionInfo = routeMode === "reverse"
    ? (reverseSessions?.getSessionInfo(nodeId) ?? null)
    : null;
  const reverseState = routeMode === "reverse"
    ? {
        reversePresence: reverseSessionInfo ? "online" : "offline",
        reverseRouteReady: reverseSessionInfo?.routeReady === true,
      }
    : {};

  if (routeMode === "direct") {
    if (!routeTarget || !routeTarget.origin) {
      return { eligible: false, reason: "no-route-target" };
    }
    if (nodeRow.reachable !== "ok") {
      return { eligible: false, reason: `node-not-reachable: ${nodeRow.reachable}` };
    }
  } else {
    if (reverseState.reversePresence !== "online") {
      return { eligible: false, reason: "reverse-session-offline", routeMode, ...reverseState };
    }
    if (!reverseState.reverseRouteReady) {
      return { eligible: false, reason: "reverse-route-unreachable", routeMode, ...reverseState };
    }
    // D9 requires a non-destructive pool-availability predicate. This
    // checks that the current generation has a registered channel, not that
    // one is idle: a busy channel can still become available during the
    // bounded concrete-assignment wait, while zero channels is fail-closed.
    if (typeof reverseChannels?.hasChannelForSession !== "function" ||
        !reverseChannels.hasChannelForSession(nodeId, reverseSessionInfo.reverseSessionId)) {
      return {
        eligible: false,
        reason: "reverse-capacity",
        routeMode,
        ...reverseState,
      };
    }
  }

  const activeKey = registry.getActiveHubRouteKey(nodeId);
  if (!activeKey || activeKey.state !== "active") {
    return {
      eligible: false,
      reason: "no-active-hub-route-key",
      routeMode,
      ...(routeMode === "reverse" ? reverseState : {}),
    };
  }

  // web.routes presence & fresh compatibility evidence
  if (nodeRow.capabilities_stale === 1 || nodeRow.orbit_compatible === "stale" || nodeRow.orbit_compatible === "unknown") {
    return {
      eligible: false,
      reason: "compatibility-evidence-stale",
      routeMode,
      ...(routeMode === "reverse" ? reverseState : {}),
    };
  }

  let capabilities = [];
  try {
    capabilities = JSON.parse(nodeRow.capabilities);
  } catch {
    capabilities = [];
  }
  const hasWebRoutes = Array.isArray(capabilities) && capabilities.some((cap) => cap.name === "web.routes");
  if (!hasWebRoutes) {
    return {
      eligible: false,
      reason: "web-routes-capability-missing",
      routeMode,
      ...(routeMode === "reverse" ? reverseState : {}),
    };
  }

  const reverseSessionId = routeMode === "reverse" ? reverseSessionInfo?.reverseSessionId ?? null : null;
  return {
    eligible: true,
    routeMode,
    ...(routeMode === "reverse"
      ? reverseState
      : { reversePresence: reverseSessions?.getPresence(nodeId, routeMode) ?? "unknown", reverseRouteReady: null }),
    snapshot: {
      nodeId,
      routeMode,
      ...(routeMode === "direct" ? { routeTargetOrigin: routeTarget.origin } : { reverseSessionId }),
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
  if (typeof cookieStr !== "string") return cookieStr;
  // Split cookie attributes by semicolon; RFC 6265 §5.2 attribute parsing
  const parts = cookieStr.split(";");
  const filtered = parts.filter((part, index) => {
    if (index === 0) return true;
    const trimmed = part.trim();
    return !/^domain\s*(=|$)/i.test(trimmed);
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
    if (
      lower === "x-dsh-authenticated-proxy" ||
      lower === "x-dsh-operator-id" ||
      lower === "x-csrf-token" ||
      lower === "x-gateway-auth" ||
      lower === "x-gateway-secret"
    ) {
      continue;
    }
    out[key] = val;
  }
  return out;
}

// Reverse OPEN uses ordered header pairs so duplicate fields survive the
// transport. The public Host is selected from the deterministic authority,
// never from a browser-supplied value.
export function sanitizeClientHeaderPairs(rawHeaders, { websocket = false } = {}) {
  const pairs = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    const lower = String(name).toLowerCase();
    if (lower === "host") continue;
    if (lower.startsWith("x-orbit-route-")) continue;
    if (
      lower === "x-dsh-authenticated-proxy" ||
      lower === "x-dsh-operator-id" ||
      lower === "x-csrf-token" ||
      lower === "x-gateway-auth" ||
      lower === "x-gateway-secret"
    ) continue;
    if (lower === "cookie") {
      const sanitized = String(value)
        .split(";")
        .map((part) => part.trim())
        .filter((part) => !part.toLowerCase().startsWith("dsh-orbit-hub-session="))
        .join("; ");
      if (sanitized) pairs.push([name, sanitized]);
      continue;
    }
    if (!websocket && lower === "connection") continue;
    pairs.push([name, value]);
  }
  return pairs;
}

function routeProofFor({ snapshot, routeAuthority, method, rawTarget, nowMs }) {
  const nonce = randomHex(16);
  const { headers } = signRouteRequest({
    privateKeyHex: snapshot.activeKey.private_key,
    keyId: snapshot.activeKey.key_id,
    nodeId: snapshot.nodeId,
    routeAuthority,
    method,
    rawTarget,
    nowMs,
    nonce,
  });
  return {
    nodeId: snapshot.nodeId,
    keyId: headers["x-orbit-route-key"],
    timestamp: Number(headers["x-orbit-route-timestamp"]),
    nonce: headers["x-orbit-route-nonce"],
    signature: headers["x-orbit-route-signature"],
  };
}

function responseHeaderPairsToObject(pairs) {
  const headers = {};
  for (const entry of pairs ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [name, value] = entry;
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return headers;
}

function waitForResponseDrain(res) {
  if (res.destroyed || res.writableEnded) return Promise.reject(new Error("browser response closed"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      res.removeListener("error", onError);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new Error("browser response closed"));
    const onError = (error) => finish(error);
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

function streamReverseResponse(res, result) {
  const responseHeaders = responseHeaderPairsToObject(result.headers);
  res.writeHead(result.status, responseHeaders);
  let settled = false;
  const abort = () => {
    if (settled || res.writableEnded) return;
    settled = true;
    result.abort?.("browser-abort");
  };
  res.once("aborted", abort);
  res.once("close", abort);
  return (async () => {
    try {
      for await (const chunk of result.body) {
        if (settled) return;
        if (!res.write(chunk)) await waitForResponseDrain(res);
      }
      if (!settled) res.end();
      await result.finish?.();
    } catch (error) {
      result.abort?.("browser-abort");
      if (!res.writableEnded) res.destroy(error);
      try { await result.finish?.(); } catch {}
      throw error;
    } finally {
      settled = true;
      res.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  })();
}

// Stream one selected RFC-0010 HTTP flow over the existing reverse channel.
export async function proxyReverseHttpRequest({
  req,
  res,
  snapshot,
  routeAuthority,
  reverseChannels,
  configuredRouteDomain = null,
  trustedScheme = "https",
  nowMs = Date.now(),
}) {
  const rawTarget = req.url;
  if (!isValidOriginFormTarget(rawTarget)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid-target", message: "only origin-form request-target is supported" } }));
    return;
  }
  const method = req.method || "GET";
  const routeProof = routeProofFor({ snapshot, routeAuthority, method, rawTarget, nowMs });
  let rejectBrowserAbort;
  const browserAbort = new Promise((_, reject) => { rejectBrowserAbort = reject; });
  const abortBrowser = () => rejectBrowserAbort?.(new Error("browser-abort"));
  req.once("aborted", abortBrowser);
  res.once("close", abortBrowser);
  try {
    const result = await reverseChannels.executeReverseHttp(snapshot.nodeId, {
      sessionId: snapshot.reverseSessionId,
      method,
      rawTarget,
      routeAuthority,
      routeProof,
      headers: sanitizeClientHeaderPairs(req.rawHeaders ?? [], { websocket: false }),
      body: req,
      abortPromise: browserAbort,
    });
    await streamReverseResponse(res, result);
    req.removeListener("aborted", abortBrowser);
    req.removeListener("close", abortBrowser);
    res.removeListener("close", abortBrowser);
  } catch (error) {
    req.removeListener("aborted", abortBrowser);
    req.removeListener("close", abortBrowser);
    res.removeListener("close", abortBrowser);
    if (res.headersSent || res.writableEnded) return;
    const selectorUrl = getSelectorReturnUrl(configuredRouteDomain, trustedScheme);
    const status = error?.code === "reverse-capacity" ? 503 : 503;
    if (isHtmlAccept(req.headers?.accept)) {
      const html = renderUnavailableHtml({
        reasonMessage: error?.code === "reverse-capacity" ? "Selected reverse route has no available data channel" : "Reverse route is unavailable",
        routeAuthority,
        selectorUrl,
      });
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: error?.code ?? "node-unavailable", message: "Selected node is unavailable", selectorUrl } }));
  }
}

// Stream one selected RFC-0010 WebSocket flow over the existing reverse channel.
export async function proxyReverseWebSocketUpgrade({
  req,
  socket,
  head,
  snapshot,
  routeAuthority,
  reverseChannels,
  tracker = null,
  configuredRouteDomain = null,
  trustedScheme = "https",
  nowMs = Date.now(),
}) {
  const rawTarget = req.url;
  if (!isValidOriginFormTarget(rawTarget)) {
    sendSocketHttpError(socket, 400, "Bad Request", {}, { error: { code: "invalid-target", message: "only origin-form request-target is supported" } });
    return;
  }
  const method = req.method || "GET";
  const routeProof = routeProofFor({ snapshot, routeAuthority, method, rawTarget, nowMs });
  let releaseTracker = null;
  if (tracker) releaseTracker = tracker.track(snapshot.nodeId, socket);
  try {
    const result = await reverseChannels.executeReverseWebSocket(snapshot.nodeId, {
      sessionId: snapshot.reverseSessionId,
      socket,
      head,
      method,
      rawTarget,
      routeAuthority,
      routeProof,
      headers: sanitizeClientHeaderPairs(req.rawHeaders ?? [], { websocket: true }),
    });
    // A transparent non-101 response has no long-lived browser socket for the
    // tracker to observe reliably; release its slot once the response is sent.
    if (result?.status !== 101) releaseTracker?.();
  } catch (error) {
    releaseTracker?.();
    if (socket.destroyed || socket.writableEnded) return;
    const selectorUrl = getSelectorReturnUrl(configuredRouteDomain, trustedScheme);
    sendSocketHttpError(socket, error?.code === "reverse-capacity" ? 503 : 502, error?.code === "reverse-capacity" ? "Service Unavailable" : "Bad Gateway", {}, {
      error: { code: error?.code ?? "node-unavailable", message: "Selected node is unavailable", selectorUrl },
    });
  }
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
    if (!net.isIP(originUrl.hostname)) {
      reqOptions.servername = originUrl.hostname;
    }
    // Verify server identity against the target origin rather than the public route authority
    reqOptions.checkServerIdentity = (servername, cert) => {
      return tls.checkServerIdentity(originUrl.hostname, cert);
    };
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
      if (isHtmlAccept(req.headers?.accept)) {
        const html = renderUnavailableHtml({
          reasonMessage: "Route ingress or downstream DSH is unreachable",
          routeAuthority,
          selectorUrl,
        });
        res.writeHead(503, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
        });
        res.end(html);
        return;
      }
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

export const DEFAULT_HUB_WS_GLOBAL_LIMIT = 200;
export const DEFAULT_HUB_WS_PER_NODE_LIMIT = 50;
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10000;

export function sendSocketHttpError(socket, statusCode, statusText, headers = {}, bodyObj = null) {
  if (!socket || socket.destroyed || !socket.writable) return;
  const payload = bodyObj ? JSON.stringify(bodyObj) : "";
  const lines = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    "connection: close",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(payload)}`,
  ];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("", payload);
  try {
    socket.write(lines.join("\r\n"));
  } catch {}
  try {
    socket.end();
  } catch {}
}

export function formatHttpResponse(statusCode, statusText, headers) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusText}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        lines.push(`${key}: ${v}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("", "");
  return lines.join("\r\n");
}

export class HubWebSocketTracker {
  constructor({
    maxGlobal = DEFAULT_HUB_WS_GLOBAL_LIMIT,
    maxPerNode = DEFAULT_HUB_WS_PER_NODE_LIMIT,
  } = {}) {
    if (
      typeof maxGlobal !== "number" ||
      !Number.isInteger(maxGlobal) ||
      !Number.isFinite(maxGlobal) ||
      maxGlobal < 1 ||
      maxGlobal > 100000
    ) {
      throw new RangeError(`invalid maxGlobal limit: ${maxGlobal}; expected integer between 1 and 100000`);
    }
    if (
      typeof maxPerNode !== "number" ||
      !Number.isInteger(maxPerNode) ||
      !Number.isFinite(maxPerNode) ||
      maxPerNode < 1 ||
      maxPerNode > 10000
    ) {
      throw new RangeError(`invalid maxPerNode limit: ${maxPerNode}; expected integer between 1 and 10000`);
    }
    if (maxPerNode > maxGlobal) {
      throw new RangeError(`maxPerNode (${maxPerNode}) cannot exceed maxGlobal (${maxGlobal})`);
    }
    this.maxGlobal = maxGlobal;
    this.maxPerNode = maxPerNode;
    this.globalCount = 0;
    this.nodeCounts = new Map();
    this.activeSockets = new Set();
  }

  canAccept(nodeId) {
    if (this.globalCount >= this.maxGlobal) {
      return { allowed: false, reason: "global-limit-exceeded" };
    }
    const current = this.nodeCounts.get(nodeId) || 0;
    if (current >= this.maxPerNode) {
      return { allowed: false, reason: "per-node-limit-exceeded" };
    }
    return { allowed: true };
  }

  track(nodeId, clientSocket, upstreamSocket = null) {
    this.globalCount++;
    this.nodeCounts.set(nodeId, (this.nodeCounts.get(nodeId) || 0) + 1);
    this.activeSockets.add(clientSocket);
    if (upstreamSocket) {
      this.activeSockets.add(upstreamSocket);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.globalCount = Math.max(0, this.globalCount - 1);
      const cur = this.nodeCounts.get(nodeId) || 0;
      if (cur <= 1) {
        this.nodeCounts.delete(nodeId);
      } else {
        this.nodeCounts.set(nodeId, cur - 1);
      }
      this.activeSockets.delete(clientSocket);
      if (upstreamSocket) {
        this.activeSockets.delete(upstreamSocket);
      }
    };

    clientSocket.once("close", release);
    clientSocket.once("error", release);
    if (upstreamSocket) {
      upstreamSocket.once("close", release);
      upstreamSocket.once("error", release);
    }
    return release;
  }

  destroyAll() {
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    this.activeSockets.clear();
    this.nodeCounts.clear();
    this.globalCount = 0;
  }
}

// Transparently proxy WebSocket Upgrade to Node RouteIngress (RFC-0010, Stage 4)
export function proxyWebSocketUpgrade({
  req,
  socket,
  head,
  snapshot,
  routeAuthority,
  tracker = null,
  configuredRouteDomain = null,
  trustedScheme = "https",
  caCertificates = null,
  handshakeTimeoutMs = DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
  nowMs = Date.now(),
}) {
  const { nodeId, routeTargetOrigin, activeKey } = snapshot;

  // Track client socket immediately
  let releaseTracker = null;
  if (tracker) {
    releaseTracker = tracker.track(nodeId, socket);
  }

  const rawTarget = req.url;
  if (!isValidOriginFormTarget(rawTarget)) {
    if (releaseTracker) {
      try { releaseTracker(); } catch {}
    }
    sendSocketHttpError(socket, 400, "Bad Request", {}, {
      error: { code: "invalid-target", message: "only origin-form request-target is supported" },
    });
    return;
  }

  const method = req.method || "GET";
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

  let originUrl;
  try {
    originUrl = new URL(routeTargetOrigin);
  } catch {
    if (releaseTracker) {
      try { releaseTracker(); } catch {}
    }
    const selectorUrl = getSelectorReturnUrl(configuredRouteDomain, trustedScheme);
    sendSocketHttpError(socket, 503, "Service Unavailable", {}, {
      error: { code: "invalid-route-target", message: "persisted route target origin is invalid", selectorUrl },
    });
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

  const reqOptions = {
    protocol: originUrl.protocol,
    hostname: originUrl.hostname,
    port: originUrl.port || (isHttps ? 443 : 80),
    path: rawTarget,
    method,
    headers: forwardHeaders,
    timeout: handshakeTimeoutMs,
  };

  if (isHttps) {
    if (!net.isIP(originUrl.hostname)) {
      reqOptions.servername = originUrl.hostname;
    }
    // Verify server identity against the target origin rather than the public route authority
    reqOptions.checkServerIdentity = (servername, cert) => {
      return tls.checkServerIdentity(originUrl.hostname, cert);
    };
    if (caCertificates) {
      reqOptions.ca = extendDefaultCaCertificates(caCertificates);
    }
  }

  let upstreamReq;
  try {
    upstreamReq = clientMod.request(reqOptions);
  } catch (err) {
    if (releaseTracker) {
      try { releaseTracker(); } catch {}
    }
    const selectorUrl = getSelectorReturnUrl(configuredRouteDomain, trustedScheme);
    sendSocketHttpError(socket, 502, "Bad Gateway", {}, {
      error: { code: "bad-gateway", message: "failed to initiate upstream request", selectorUrl },
    });
    try { socket.end(); } catch {}
    return;
  }

  const onClientEarlyAbort = () => {
    try { upstreamReq.destroy(); } catch {}
  };
  socket.once("close", onClientEarlyAbort);
  socket.once("error", onClientEarlyAbort);

  upstreamReq.on("error", (err) => {
    socket.removeListener("close", onClientEarlyAbort);
    socket.removeListener("error", onClientEarlyAbort);
    const selectorUrl = getSelectorReturnUrl(configuredRouteDomain, trustedScheme);
    sendSocketHttpError(socket, 502, "Bad Gateway", {}, {
      error: { code: "bad-gateway", message: "upstream route target unavailable", selectorUrl },
    });
    try {
      socket.end();
    } catch {}
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("handshake timeout"));
  });

  // Handle successful 101 Switching Protocols
  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.removeListener("close", onClientEarlyAbort);
    socket.removeListener("error", onClientEarlyAbort);
    // Handshake successful: clear timeout and prevent idle timeout on both sockets
    upstreamReq.setTimeout(0);
    upstreamSocket.setTimeout(0);
    socket.setTimeout(0);

    if (tracker) {
      tracker.activeSockets.add(upstreamSocket);
      upstreamSocket.once("close", () => tracker.activeSockets.delete(upstreamSocket));
      upstreamSocket.once("error", () => tracker.activeSockets.delete(upstreamSocket));
    }

    // Sanitize response headers (Domain= stripped from Set-Cookie)
    const responseHeaders = { ...upstreamRes.headers };
    if (responseHeaders["set-cookie"]) {
      responseHeaders["set-cookie"] = sanitizeSetCookieHeader(responseHeaders["set-cookie"]);
    }

    // Write 101 Switching Protocols response to client
    const responseLineAndHeaders = formatHttpResponse(101, "Switching Protocols", responseHeaders);
    socket.write(responseLineAndHeaders);

    // Forward upstream head bytes if any
    if (upstreamHead && upstreamHead.length > 0) {
      socket.write(upstreamHead);
    }
    // Forward client head bytes if any
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    // Bidirectional byte streaming without inspection or buffering
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);

    const cleanup = () => {
      try {
        socket.destroy();
      } catch {}
      try {
        upstreamSocket.destroy();
      } catch {}
    };

    socket.on("error", cleanup);
    upstreamSocket.on("error", cleanup);
    socket.on("close", cleanup);
    upstreamSocket.on("close", cleanup);
    socket.on("end", () => {
      socket.destroy();
      upstreamSocket.destroy();
    });
    upstreamSocket.on("end", () => {
      socket.destroy();
      upstreamSocket.destroy();
    });
  });

  // Transparently pass non-101 responses (e.g. 401, 403, 500)
  upstreamReq.on("response", (upstreamRes) => {
    socket.removeListener("close", onClientEarlyAbort);
    socket.removeListener("error", onClientEarlyAbort);
    upstreamReq.setTimeout(0);
    const responseHeaders = { ...upstreamRes.headers };
    delete responseHeaders["transfer-encoding"];
    responseHeaders["connection"] = "close";
    if (responseHeaders["set-cookie"]) {
      responseHeaders["set-cookie"] = sanitizeSetCookieHeader(responseHeaders["set-cookie"]);
    }
    const responseLineAndHeaders = formatHttpResponse(
      upstreamRes.statusCode,
      upstreamRes.statusMessage || "Error",
      responseHeaders,
    );
    socket.write(responseLineAndHeaders);
    upstreamRes.pipe(socket);
  });

  upstreamReq.end();
}
