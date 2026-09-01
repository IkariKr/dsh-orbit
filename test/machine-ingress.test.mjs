import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMachineIngressServer } from "../src/registry/machine-ingress.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function request(port, path, { method = "GET", headers = {}, body = "" } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  }).then(async (response) => ({
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }));
}

function rawRequest(port, path, { method = "POST", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== "") req.write(body);
    req.end();
  });
}

test("private machine ingress denies browser paths and query strings before upstream", async (t) => {
  let upstreamHits = 0;
  const upstream = createServer((_request, response) => {
    upstreamHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const ingress = createMachineIngressServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const ingressPort = await listen(ingress);
  t.after(async () => {
    await close(ingress);
    await close(upstream);
  });

  const browser = await request(ingressPort, "/hub/nodes");
  assert.equal(browser.status, 403);
  assert.equal(JSON.parse(browser.body).error.code, "machine-ingress-denied");

  const unknownMachineRoute = await request(ingressPort, "/api/v1/unknown", { method: "POST", body: "{}" });
  assert.equal(unknownMachineRoute.status, 403);
  assert.equal(JSON.parse(unknownMachineRoute.body).error.code, "machine-ingress-denied");

  const query = await request(ingressPort, "/api/v1/heartbeat?debug=1", { method: "POST", body: "{}" });
  assert.equal(query.status, 400);
  assert.equal(JSON.parse(query.body).error.code, "query-not-allowed");

  const dotSegment = await rawRequest(ingressPort, "/api/v1/heartbeat/../enroll", { method: "POST", body: "{}" });
  assert.equal(dotSegment.status, 403);
  assert.equal(JSON.parse(dotSegment.body).error.code, "machine-ingress-denied");

  const encodedPath = await request(ingressPort, "/api/v1/%68eartbeat", { method: "POST", body: "{}" });
  assert.equal(encodedPath.status, 403);
  assert.equal(JSON.parse(encodedPath.body).error.code, "machine-ingress-denied");
  assert.equal(upstreamHits, 0);
});

test("private machine ingress forwards only /api/v1 paths without changing method, body, or headers", async (t) => {
  const seen = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
      response.end(JSON.stringify({ accepted: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  const ingress = createMachineIngressServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const ingressPort = await listen(ingress);
  t.after(async () => {
    await close(ingress);
    await close(upstream);
  });

  const response = await request(ingressPort, "/api/v1/report-upload", {
    method: "POST",
    headers: { "content-type": "application/json", "x-orbit-node": "node_test" },
    body: '{"hello":"world"}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.deepEqual(seen.map(({ method, url, body }) => ({ method, url, body })), [
    { method: "POST", url: "/api/v1/report-upload", body: '{"hello":"world"}' },
  ]);
  assert.equal(seen[0].headers["x-orbit-node"], "node_test");
});

test("private machine ingress fails closed when the Hub upstream is unavailable", async (t) => {
  const upstream = createServer(() => {});
  const upstreamPort = await listen(upstream);
  await close(upstream);
  const ingress = createMachineIngressServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const ingressPort = await listen(ingress);
  t.after(() => close(ingress));

  const response = await request(ingressPort, "/api/v1/heartbeat", { method: "POST", body: "{}" });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).error.code, "machine-upstream-error");
});

test("drill compose keeps machine ingress private and DSH services non-root", async () => {
  const compose = await readFile(new URL("../docker-registry/drill.compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /machine-ingress:\n[\s\S]*?network_mode: "service:registry-hub"/);
  assert.doesNotMatch(compose, /5446:\s*5446/);
  assert.match(compose, /dsh-a:\n[\s\S]*?user: "10001:10001"/);
  assert.match(compose, /dsh-b:\n[\s\S]*?user: "10001:10001"/);
  assert.match(compose, /dsh-a-init:[\s\S]*?user: "0"/);
  assert.match(compose, /dsh-b-init:[\s\S]*?user: "0"/);
});
