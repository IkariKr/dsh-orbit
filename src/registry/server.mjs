// HTTP transport for the v0.3 registry: the machine API (RFC-0006) and
// the browser management API (RFC-0007) on one listener. Transport-level
// protections live here (query-string ban, body limits, rate limits,
// gateway admission, sessions/CSRF/origin, 5xx-never-allowed); all
// protocol decisions stay in registry.mjs.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { sha256Hex } from "./crypto.mjs";
import { BODY_LIMIT_KIB, BODY_LIMIT_REPORT, RATE_LIMITS } from "./protocol.mjs";
import { DeniedError } from "./registry.mjs";

const MACHINE_ROUTES = new Set([
  "/api/v1/enroll",
  "/api/v1/heartbeat",
  "/api/v1/report-upload",
  "/api/v1/credential-rotate",
  "/api/v1/reenroll",
]);

const SESSION_COOKIE = "dsh-orbit-hub-session";
const CSRF_HEADER = "x-csrf-token";
const ASSERTION_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// In-memory sliding-window limiter; bounds abuse and never affects
// protocol state (RFC-0006 rate-limit defaults are fixed values).
class SlidingWindowLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.windows = new Map();
  }

  allow(key, limit, windowMs) {
    const at = this.now();
    let entries = this.windows.get(key);
    if (!entries) {
      entries = [];
      this.windows.set(key, entries);
    }
    while (entries.length > 0 && entries[0] <= at - windowMs) entries.shift();
    if (entries.length >= limit) return false;
    entries.push(at);
    if (this.windows.size > 10_000) {
      for (const [k, list] of this.windows) {
        if (list.length === 0 || list[list.length - 1] <= at - 3600_000) this.windows.delete(k);
      }
    }
    return true;
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendError(response, error) {
  if (error instanceof DeniedError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  console.error(`registry api: internal error: ${error.stack ?? error}`);
  sendJson(response, 500, { error: { code: "internal-error", message: "internal error" } });
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    request.on("data", (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        // Keep draining so the 413 response can be delivered instead of
        // closing the socket mid-request; the overflow is reported at end.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (overflowed) {
        reject(new DeniedError(413, "body-too-large", `request body exceeds ${limit} bytes`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => reject(error));
  });
}

function parseBody(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new DeniedError(400, "bad-json", "request body must be valid JSON");
  }
}

function parseCookies(request) {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header === "") return new Map();
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function machineField(request, name) {
  const value = request.headers[name];
  if (typeof value !== "string" || value === "") {
    throw new DeniedError(400, "bad-request", `missing machine header ${name}`);
  }
  return value;
}

export function createHubServer({ registry, options = {} }) {
  const {
    gatewayAssertionSecret = null,
    operatorPrincipal = null,
    lanBoundaryOnly = false,
    // RFC-0007 origin check compares scheme as well as host. The Hub
    // sits behind the deployment gateway; it cannot infer the external
    // scheme from the socket (plain http from the gateway) and must not
    // trust client-supplied X-Forwarded-Proto. The operator pins the
    // trusted external scheme explicitly (P1-09).
    trustedExternalScheme = "http",
  } = options;
  if (trustedExternalScheme !== "http" && trustedExternalScheme !== "https") {
    throw new Error(`trustedExternalScheme must be http or https (got ${JSON.stringify(trustedExternalScheme)})`);
  }
  const limiter = new SlidingWindowLimiter();

  // Stage 5: the operator UI shell (pure static assets; the API stays
  // fully behind the RFC-0007 protections). Public by design — these
  // files hold no data and no secrets.
  const UI_ROOT = new URL("../../ui/", import.meta.url);
  const UI_ASSETS = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
    ["/view-model.mjs", ["view-model.mjs", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ]);

  const server = createServer((request, response) => {
    // Query strings are excluded from the v0.3 protocol by construction.
    let url;
    try {
      url = new URL(request.url ?? "/", "http://registry.local");
    } catch {
      return sendJson(response, 400, { error: { code: "bad-request", message: "malformed request URL" } });
    }
    if (url.searchParams.size > 0) {
      return sendJson(response, 400, { error: { code: "query-not-allowed", message: "query strings are not part of the registry protocol" } });
    }
    const path = url.pathname;

    if (request.method === "GET" && UI_ASSETS.has(path)) {
      const [fileName, contentType] = UI_ASSETS.get(path);
      readFile(new URL(fileName, UI_ROOT))
        .then((content) => {
          response.writeHead(200, { "content-type": contentType, "content-length": content.length });
          response.end(content);
        })
        .catch(() => sendJson(response, 404, { error: { code: "not-found", message: "UI asset missing" } }));
      return;
    }

    if (MACHINE_ROUTES.has(path)) {
      handleMachineRequest(request, response, path).catch((error) => sendError(response, error));
      return;
    }
    if (path.startsWith("/hub")) {
      handleBrowserRequest(request, response, path).catch((error) => sendError(response, error));
      return;
    }
    sendJson(response, 404, { error: { code: "not-found", message: "no such route" } });
  });

  async function handleMachineRequest(request, response, path) {
    if (request.method !== "POST") {
      return sendJson(response, 405, { error: { code: "method-not-allowed", message: "machine routes accept POST only" } });
    }
    const remote = request.socket.remoteAddress ?? "unknown";
    if (!limiter.allow(`machine-ip:${remote}`, RATE_LIMITS.perIpPerMinute, 60_000)) {
      return sendJson(response, 429, {
        error: { code: "rate-limited", message: "per-IP machine rate limit exceeded" },
      },
      { "retry-after": "60" });
    }
    const bodyLimit = path === "/api/v1/report-upload" ? BODY_LIMIT_REPORT : BODY_LIMIT_KIB;
    const rawBody = await readBody(request, bodyLimit);

    if (path === "/api/v1/enroll") {
      const body = parseBody(rawBody);
      const plaintextToken = typeof body.token === "string" ? body.token : "";
      if (!limiter.allow(`enroll-attempt:${sha256Hex(plaintextToken)}`, RATE_LIMITS.enrollmentAttemptsPerToken, 3600_000)) {
        return sendJson(response, 429, { error: { code: "rate-limited", message: "enrollment attempts per token exceeded" } });
      }
      const result = registry.enroll({ token: plaintextToken, enrollmentRequestId: body.enrollmentRequestId, publicKey: body.publicKey });
      return sendJson(response, 200, result);
    }

    const headers = {
      node: machineField(request, "x-orbit-node"),
      timestamp: machineField(request, "x-orbit-timestamp"),
      nonce: machineField(request, "x-orbit-nonce"),
      key: machineField(request, "x-orbit-key"),
      signature: machineField(request, "x-orbit-signature"),
    };
    const bodyHash = sha256Hex(rawBody);

    if (path === "/api/v1/reenroll") {
      const body = parseBody(rawBody);
      const plaintextToken = typeof body.reenrollmentToken === "string" ? body.reenrollmentToken : "";
      if (!limiter.allow(`reenroll-attempt:${sha256Hex(plaintextToken)}`, RATE_LIMITS.reenrollAttemptsPerToken, 3600_000)) {
        return sendJson(response, 429, { error: { code: "rate-limited", message: "re-enrollment attempts per token exceeded" } });
      }
      const result = registry.reenroll({
        token: plaintextToken,
        reenrollmentRequestId: body.reenrollmentRequestId,
        newPublicKey: body.newPublicKey,
        nodeId: headers.node,
        keyId: headers.key,
        method: request.method,
        path,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        bodyHash,
        signature: headers.signature,
      });
      return sendJson(response, 200, result);
    }
    if (path === "/api/v1/heartbeat") {
      // Protocol-level rate limiting runs AFTER machine authentication
      // (including the transactional nonce reservation): a legitimately
      // signed request that trips the limit has still consumed its
      // nonce, and its replay is denied (RFC-0006 / P1-06). Unauthenticated
      // garbage is bounded earlier by the per-IP guard.
      const auth = registry.authenticateMachine({ nodeId: headers.node, keyId: headers.key, method: request.method, path, timestamp: headers.timestamp, nonce: headers.nonce, bodyHash, signature: headers.signature });
      if (
        !limiter.allow(`heartbeat:${auth.node.node_id}`, RATE_LIMITS.heartbeat.burst, 1000) ||
        !limiter.allow(`heartbeat-60:${auth.node.node_id}`, 60 / RATE_LIMITS.heartbeat.perSecond, 60_000)
      ) {
        return sendJson(response, 429, { error: { code: "rate-limited", message: "heartbeat rate limit exceeded" } }, { "retry-after": "1" });
      }
      const result = registry.heartbeatAuthenticated({ node: auth.node, rawBody });
      return sendJson(response, 200, result);
    }
    if (path === "/api/v1/report-upload") {
      const auth = registry.authenticateMachine({ nodeId: headers.node, keyId: headers.key, method: request.method, path, timestamp: headers.timestamp, nonce: headers.nonce, bodyHash, signature: headers.signature });
      if (!limiter.allow(`report:${auth.node.node_id}`, RATE_LIMITS.reportUpload.perMinute, 60_000)) {
        return sendJson(response, 429, { error: { code: "rate-limited", message: "report upload rate limit exceeded" } }, { "retry-after": "60" });
      }
      const result = registry.uploadReportAuthenticated({ node: auth.node, rawBody });
      return sendJson(response, 200, result);
    }
    const auth = registry.authenticateMachine({ nodeId: headers.node, keyId: headers.key, method: request.method, path, timestamp: headers.timestamp, nonce: headers.nonce, bodyHash, signature: headers.signature });
    const result = registry.rotateCredentialAuthenticated({ node: auth.node, key: auth.key, rawBody });
    return sendJson(response, 200, result);
  }

  // ------------------------------------------------------------------
  // Browser management surface (RFC-0007).
  //
  // Gateway admission proof and operator identity are separate: the
  // assertion proves the gateway authenticated the request; the
  // operator principal is a gateway-injected opaque value (or the
  // declared single principal). Client-supplied principal headers are
  // stripped before admission; client IP is never a credential.

  function admitBrowserRequest(request) {
    const injectedPrincipal = request.headers[PRINCIPAL_HEADER];
    delete request.headers[PRINCIPAL_HEADER];

    const assertion = request.headers[ASSERTION_HEADER];
    let gatewayAdmitted = false;
    if (typeof assertion === "string" && assertion !== "") {
      if (gatewayAssertionSecret === null || assertion !== gatewayAssertionSecret) {
        throw new DeniedError(401, "gateway-denied", "gateway assertion mismatch");
      }
      gatewayAdmitted = true;
    } else if (lanBoundaryOnly && isLoopback(request.socket.remoteAddress ?? "")) {
      gatewayAdmitted = true;
    }
    if (!gatewayAdmitted) {
      throw new DeniedError(401, "gateway-denied", "request was not admitted by the gateway");
    }
    if (!operatorPrincipal) {
      throw new DeniedError(401, "no-principal", "no operator principal mode configured");
    }
    if (operatorPrincipal.mode === "single") {
      return operatorPrincipal.principal;
    }
    if (typeof injectedPrincipal !== "string" || injectedPrincipal === "") {
      throw new DeniedError(401, "no-principal", "gateway did not inject an operator principal");
    }
    return injectedPrincipal;
  }

  // RFC-0007 browser trust, split so the session bootstrap shares the
  // origin/Sec-Fetch-Site checks even though it has no session yet
  // (P1-10).
  function checkOriginAndFetchSite(request) {
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin !== "") {
      let originUrl;
      try {
        originUrl = new URL(origin);
      } catch {
        throw new DeniedError(403, "origin-denied", "malformed Origin header");
      }
      // Host AND scheme must match the trusted external scheme
      // (RFC-0007; P1-09). X-Forwarded-Proto is never trusted.
      if (originUrl.protocol !== `${trustedExternalScheme}:` || originUrl.host !== request.headers.host) {
        throw new DeniedError(403, "origin-denied", "Origin does not match the trusted scheme and host");
      }
    }
    const site = request.headers["sec-fetch-site"];
    if (site === "cross-site") {
      throw new DeniedError(403, "cross-site-denied", "cross-site management requests are denied");
    }
  }

  function validateSessionOnly(request) {
    const sessionId = parseCookies(request).get(SESSION_COOKIE);
    const session = registry.validateSession(sessionId);
    if (!session) {
      throw new DeniedError(401, "no-session", "no valid management session");
    }
    return session;
  }

  function requireCsrf(request, session) {
    const provided = request.headers[CSRF_HEADER];
    if (typeof provided !== "string" || provided === "" || session === null || provided !== session.csrfToken) {
      throw new DeniedError(403, "csrf-denied", "state-changing requests require the session CSRF token");
    }
  }

  async function handleBrowserRequest(request, response, path) {
    const principal = admitBrowserRequest(request);
    // Origin/Sec-Fetch-Site apply to every management request,
    // including the gateway-admitted session bootstrap (P1-10).
    checkOriginAndFetchSite(request);

    if (request.method === "POST" && (path === "/hub/session" || path === "/hub/session/")) {
      if (!limiter.allow(`session:${request.socket.remoteAddress ?? "?"}`, 30, 60_000)) {
        return sendJson(response, 429, { error: { code: "rate-limited", message: "too many session bootstraps" } });
      }
      const session = registry.bootstrapSession({ principal });
      const cookie = [
        `${SESSION_COOKIE}=${session.sessionId}`,
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/hub",
        `Max-Age=${Math.floor(12 * 60 * 60)}`,
      ].join("; ");
      response.setHeader("set-cookie", cookie);
      return sendJson(response, 200, { principal, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    }

    const session = validateSessionOnly(request);

    if (path === "/hub/session" || path === "/hub/session/") {
      return sendJson(response, 200, { principal: session.operatorPrincipal, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    }
    if (path === "/hub/session/logout" || path === "/hub/session/logout/") {
      requireCsrf(request, session);
      registry.endSession({ sessionId: session.sessionId, actor: session.operatorPrincipal });
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET") {
      if (path === "/hub/nodes" || path === "/hub/nodes/") {
        return sendJson(response, 200, { nodes: registry.listNodes() });
      }
      const nodeMatch = path.match(/^\/hub\/nodes\/([^/]+)\/?$/);
      if (nodeMatch) {
        return sendJson(response, 200, registry.getNode(decodeURIComponent(nodeMatch[1])));
      }
      if (path === "/hub/tokens" || path === "/hub/tokens/") {
        return sendJson(response, 200, { tokens: registry.listTokens() });
      }
      return sendJson(response, 404, { error: { code: "not-found", message: "no such management route" } });
    }

    requireCsrf(request, session);

    if (path === "/hub/tokens" || path === "/hub/tokens/") {
      if (request.method === "POST") {
        if (!limiter.allow(`token-mint:${session.operatorPrincipal}`, RATE_LIMITS.tokenMintingPerHour, 3600_000)) {
          return sendJson(response, 429, { error: { code: "rate-limited", message: "token minting rate limit exceeded" } });
        }
        const body = parseBody(await readBody(request, BODY_LIMIT_KIB));
        const minted = registry.mintEnrollmentToken({
          actor: session.operatorPrincipal,
          purpose: body.purpose,
          boundNodeId: body.boundNodeId ?? null,
          ttlSeconds: body.ttlSeconds,
        });
        return sendJson(response, 200, minted);
      }
      return sendJson(response, 405, { error: { code: "method-not-allowed", message: "expected GET or POST" } });
    }

    const nodeMatch = path.match(/^\/hub\/nodes\/([^/]+)\/(delete|reenroll)\/?$/);
    if (nodeMatch) {
      // /delete and /reenroll are strictly POST (RFC-0007 surface);
      // any other method is 405, never executed.
      if (request.method !== "POST") {
        return sendJson(response, 405, { error: { code: "method-not-allowed", message: "delete/reenroll accept POST only" } });
      }
      const nodeId = decodeURIComponent(nodeMatch[1]);
      if (nodeMatch[2] === "delete") {
        const body = parseBody(await readBody(request, BODY_LIMIT_KIB));
        // Destructive deletes carry a client requestId for confirmation
        // and idempotent replay semantics (RFC-0007 / P1-07); a missing
        // requestId is denied.
        return sendJson(response, 200, registry.deleteNode({ actor: session.operatorPrincipal, nodeId, requestId: body.requestId, reason: body.reason }));
      }
      const minted = registry.mintEnrollmentToken({
        actor: session.operatorPrincipal,
        purpose: "reenroll",
        boundNodeId: nodeId,
      });
      return sendJson(response, 200, minted);
    }

    return sendJson(response, 404, { error: { code: "not-found", message: "no such management route" } });
  }

  return { server };
}