import { createServer, request as upstreamRequest } from "node:http";

export const MACHINE_INGRESS_PATHS = Object.freeze([
  "/api/v1/enroll",
  "/api/v1/heartbeat",
  "/api/v1/report-upload",
  "/api/v1/credential-rotate",
  "/api/v1/reenroll",
]);

const MACHINE_INGRESS_PATH_SET = new Set(MACHINE_INGRESS_PATHS);

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

  return server;
}
