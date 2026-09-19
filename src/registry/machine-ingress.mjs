import { createServer, request as upstreamRequest } from "node:http";

// RFC-0012 D2: the machine handler set is served on every machine ingress a
// persisted hubBaseUrl can reference. The server-reachable (private) listener
// keeps its RFC-0006 paths and additionally admits the v0.5 bootstrap and
// reverse surfaces with identical semantics; /api/v1/enroll remains
// server-reachability-only and never joins the public gateway projection.
export const MACHINE_INGRESS_PATHS = Object.freeze([
  "/api/v1/enroll",
  "/api/v1/pair",
  "/api/v1/heartbeat",
  "/api/v1/report-upload",
  "/api/v1/credential-rotate",
  "/api/v1/reenroll",
  "/api/v1/reverse/control",
  "/api/v1/reverse/channel",
]);

const MACHINE_INGRESS_PATH_SET = new Set(MACHINE_INGRESS_PATHS);

// Only the reverse surfaces are WebSocket upgrades on this listener; every
// other admitted path is an ordinary POST route (RFC-0006).
const REVERSE_UPGRADE_PATH_SET = new Set(["/api/v1/reverse/control", "/api/v1/reverse/channel"]);

function rejectSocket(socket, statusCode, reason, bodyObj) {
  if (!socket || socket.destroyed || !socket.writable) return;
  const payload = bodyObj ? JSON.stringify(bodyObj) : "";
  socket.end(
    `HTTP/1.1 ${statusCode} ${reason}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
  );
}

export function createMachineIngressServer({
  listenPort = 5446,
  listenHost = "0.0.0.0",
  upstream = "http://127.0.0.1:5445",
} = {}) {
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.protocol !== "http:") {
    throw new Error("machine ingress upstream must use http");
  }

  const server = createServer((request, response) => {
    // Match the raw request-target exactly. WHATWG URL parsing normalizes
    // dot segments, which would turn e.g. /api/v1/heartbeat/../enroll into
    // an allowed route and violate RFC-0006's no-path-canonicalization rule.
    const rawTarget = request.url ?? "/";
    if (rawTarget.includes("?")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "query-not-allowed", message: "query strings are not part of the registry protocol" } }));
      request.resume();
      return;
    }
    if (!MACHINE_INGRESS_PATH_SET.has(rawTarget)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "machine-ingress-denied", message: "private ingress accepts only exact fixed machine routes" } }));
      request.resume();
      return;
    }

    const proxy = upstreamRequest(
      `${upstreamUrl.origin}${rawTarget}`,
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    proxy.on("error", () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "machine-upstream-error", message: "private Hub upstream unavailable" } }));
    });
    request.pipe(proxy);
  });

  // RFC-0012 D2 (Stage 2): forward reverse control/channel WebSocket
  // upgrades to the Hub, which performs machine authentication and the
  // authoritative Origin rejection. The ingress additionally rejects any
  // Origin header itself before the upgrade leaves this listener.
  server.on("upgrade", (request, socket, head) => {
    const rawTarget = request.url ?? "/";
    if (rawTarget.includes("?") || !REVERSE_UPGRADE_PATH_SET.has(rawTarget)) {
      rejectSocket(socket, 403, "Forbidden", {
        error: { code: "machine-ingress-denied", message: "private ingress accepts only exact fixed reverse upgrade routes" },
      });
      return;
    }
    if (request.headers.origin !== undefined) {
      rejectSocket(socket, 403, "Forbidden", {
        error: { code: "origin-forbidden", message: "reverse machine upgrades must omit Origin" },
      });
      return;
    }

    const proxy = upstreamRequest(`${upstreamUrl.origin}${rawTarget}`, { method: "GET", headers: request.headers });
    proxy.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      // Relay the 101 and pipe both directions; the Hub owns everything
      // after the upgrade (Stage 3 session handling).
      const extra = upstreamHead && upstreamHead.length > 0 ? upstreamHead : head;
      socket.write(
        `HTTP/1.1 101 ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n` +
          Object.entries(upstreamResponse.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (extra && extra.length > 0) socket.write(extra);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const closeBoth = () => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on("error", closeBoth);
      socket.on("error", closeBoth);
      upstreamSocket.on("close", closeBoth);
      socket.on("close", closeBoth);
    });
    proxy.on("response", (upstreamResponse) => {
      // The Hub refused the upgrade (auth/Origin/capacity/fail-closed):
      // relay the plain HTTP rejection over the raw socket.
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = Object.entries(upstreamResponse.headers)
          .filter(([name]) => name.toLowerCase() !== "content-length" && name.toLowerCase() !== "connection")
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n");
        socket.end(
          `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? "Error"}\r\n` +
            `${headers}\r\nconnection: close\r\ncontent-length: ${body.length}\r\n\r\n` +
            body.toString("utf8"),
        );
      });
    });
    proxy.on("error", () => {
      rejectSocket(socket, 502, "Bad Gateway", {
        error: { code: "machine-upstream-error", message: "private Hub upstream unavailable" },
      });
    });
    if (head && head.length > 0) proxy.write(head);
    // The upgrade request carries no body: finish the client request so
    // the upstream sees a complete message instead of waiting forever.
    proxy.end();
  });

  return server;
}
