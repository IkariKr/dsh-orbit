// v0.5 Stage 4 Live Evidence: a real reverse node daemon (child process,
// routeMode=reverse, pool wired through the CLI) serves DSH root, static
// asset, API response, and a streaming upload over the bounded channel
// pool, and a multi-request burst reuses the pool. The Hub runs in-process
// so the test drives the same executeReverseHttp path the route transport
// adapter will use in Stage 5; the node side is fully spawned and passes
// through verified TLS.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";
import { randomHex } from "../src/registry/crypto.mjs";
import { signRouteRequest } from "../src/registry/route-auth.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function killProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2000).unref();
  });
}

function runNodeCommand({ command, statePath, hubUrl, caCertPath, extraEnv = {}, successPattern }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", command], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_NODE_STATE: statePath,
        DSH_ORBIT_HUB_URL: hubUrl,
        DSH_ORBIT_NODE_CA_CERT: caCertPath,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, match: successPattern ? stdout.match(successPattern) : [] });
      else reject(new Error(`node ${command} failed code ${code}; stderr=${stderr} stdout=${stdout}`));
    });
  });
}

function startNodeDaemon({ statePath, hubUrl, caCertPath, dshTarget }) {
  const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_NODE_CA_CERT: caCertPath,
      DSH_ORBIT_NODE_HEARTBEAT_SECONDS: "30",
      DSH_ORBIT_NODE_ROUTE_INGRESS_DISABLED: "1",
      DSH_ORBIT_NODE_ROUTE_DOMAIN: "dsh.example.local",
      DSH_ORBIT_NODE_DSH_TARGET: dshTarget,
      DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  return { child, stdout: () => stdout };
}

// Rehearsal public gateway with the WebSocket upgrade relay.
function startRehearsalGateway({ certPem, keyPem }) {
  let hubUrl = null;
  const PUBLIC_POST_PATHS = new Set(["/api/v1/pair", "/api/v1/heartbeat", "/api/v1/report-upload", "/api/v1/credential-rotate", "/api/v1/reenroll"]);
  const PUBLIC_GET_PATHS = new Set(["/api/v1/reverse/control", "/api/v1/reverse/channel"]);
  const server = https.createServer({ cert: certPem, key: keyPem }, (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    const headers = { ...request.headers };
    delete headers.cookie;
    delete headers.origin;
    delete headers["x-dsh-authenticated-proxy"];
    delete headers["x-dsh-operator-id"];
    const upstream = http.request(hubUrl + path, { method: request.method, headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: "hub unavailable" } }));
    });
    request.pipe(upstream);
  });
  server.on("upgrade", (request, clientSocket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (!PUBLIC_GET_PATHS.has(path) || request.headers.origin !== undefined) {
      clientSocket.destroy();
      return;
    }
    const headers = { ...request.headers };
    delete headers.cookie;
    delete headers["x-dsh-authenticated-proxy"];
    delete headers["x-dsh-operator-id"];
    const upstream = http.request(hubUrl + path, { method: "GET", headers });
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const relayHeaders = Object.entries(upstreamResponse.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      clientSocket.write(`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${relayHeaders}\r\n\r\n`);
      if (head && head.length > 0) clientSocket.write(head);
      if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const closeBoth = () => {
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on("error", closeBoth);
      clientSocket.on("error", closeBoth);
      upstreamSocket.on("close", closeBoth);
      clientSocket.on("close", closeBoth);
    });
    upstream.on("error", () => clientSocket.destroy());
    if (head && head.length > 0) upstream.write(head);
    upstream.end();
  });
  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    get port() {
      return server.address().port;
    },
    set upstream(url) {
      hubUrl = url;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function startMockDsh() {
  const recorded = [];
  let handler = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      recorded.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (handler) return handler(request, response, body);
      if (request.url === "/api/data") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>dsh-root</body></html>");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    recorded,
    setHandler: (fn) => (handler = fn),
    target: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function waitFor(predicate, { timeoutMs = 15000, stepMs = 50, label }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label ?? "condition"}`));
      setTimeout(check, stepMs);
    };
    check();
  });
}

async function* iterableOf(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collectBody(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test("Live v0.5 Stage 4 evidence: a spawned reverse node serves DSH root, static asset, API response, streaming upload, and a concurrent burst over the bounded channel pool", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-v05-stage4-live-"));
  const statePath = join(dir, "node-state.json");
  const certPath = join(dir, "gateway-cert.pem");
  const keyPath = join(dir, "gateway-key.pem");
  await writeFile(certPath, GATEWAY_CERT_PEM, "utf8");
  await writeFile(keyPath, GATEWAY_KEY_PEM, "utf8");

  const registry = new Registry({
    db: openRegistryDatabase(":memory:"),
    routeDomain: "dsh.example.local",
    // Set after the gateway port is known; paired nodes receive this as
    // their canonical public hubBaseUrl (RFC-0012 D2/D3.3).
    pairingHubBaseUrl: null,
  });
  const hub = createHubServer({ registry, options: {} });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const hubBaseUrl = `http://127.0.0.1:${hub.server.address().port}`;

  const gateway = startRehearsalGateway({ certPem: GATEWAY_CERT_PEM, keyPem: GATEWAY_KEY_PEM });
  await gateway.listen();
  gateway.upstream = hubBaseUrl;
  const publicBaseUrl = `https://127.0.0.1:${gateway.port}`;
  registry.pairingHubBaseUrl = `${publicBaseUrl}/`;

  const dsh = await startMockDsh();
  let daemon = null;
  t.after(async () => {
    await killProcess(daemon?.child);
    await gateway.close();
    await dsh.close();
    await new Promise((resolve) => {
      hub.server.closeAllConnections?.();
      hub.server.close(resolve);
    });
    registry.close();
    await rm(dir, { recursive: true, force: true });
  });

  console.log("\n=== STEP 1: Pair a fresh reverse node through the public machine ingress ===");
  const pairToken = registry.mintEnrollmentToken({ actor: "operator", purpose: "pair" });
  const { match: pairMatch } = await runNodeCommand({
    command: "pair",
    statePath,
    hubUrl: publicBaseUrl,
    caCertPath: certPath,
    extraEnv: { DSH_ORBIT_PAIR_TOKEN: pairToken.token },
    successPattern: /paired: (node_[0-9a-f]{32}) \(keyId ([0-9a-f]{32}), routeMode reverse\)/,
  });
  const nodeId = pairMatch[1];
  console.log(`[Evidence] Paired ${nodeId} over verified TLS through the public ingress`);

  console.log("\n=== STEP 2: The node daemon brings the control session and channel pool online ===");
  daemon = startNodeDaemon({ statePath, hubUrl: publicBaseUrl, caCertPath: certPath, dshTarget: dsh.target });
  await waitFor(() => hub.reverseSessions.getSessionInfo(nodeId) !== null, { label: "ready control session" });
  await waitFor(() => hub.reverseChannels.idleChannels(nodeId).length >= 1, { label: "idle pooled channels" });
  // Flow proofs verify against the node's RFC-0008 trust set, which syncs
  // over the heartbeat response: wait for it before driving flows.
  await waitFor(async () => {
    const store = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
    return Array.isArray(store.hubRouteKeys) && store.hubRouteKeys.some((key) => key.state === "active");
  }, { label: "node store holds an ACTIVE RFC-0008 route key" });
  console.log(`[Evidence] Control session ready with ${hub.reverseChannels.idleChannels(nodeId).length} idle pooled channels (bounded pool)`);

  const routeAuthority = computeRouteAuthority(nodeId, "dsh.example.local");
  const hubRouteKey = registry.db
    .prepare("SELECT key_id AS keyId, private_key AS privateKeyHex FROM hub_route_keys WHERE node_id = ? AND state != 'revoked' LIMIT 1")
    .get(nodeId);
  const buildRouteProof = (method, rawTarget) => {
    const signed = signRouteRequest({
      privateKeyHex: hubRouteKey.privateKeyHex,
      keyId: hubRouteKey.keyId,
      nodeId,
      routeAuthority,
      method,
      rawTarget,
      nonce: randomHex(16),
    });
    return {
      nodeId,
      keyId: signed.headers["x-orbit-route-key"],
      timestamp: signed.headers["x-orbit-route-timestamp"],
      nonce: signed.headers["x-orbit-route-nonce"],
      signature: signed.headers["x-orbit-route-signature"],
    };
  };

  console.log("\n=== STEP 3: DSH root and API response through the reverse channels ===");
  try {
    await waitFor(() => daemon.stdout().includes("channel-open"), { label: "channel-open events" });
  } catch (error) {
    console.error(`[Diagnostic] daemon: ${JSON.stringify(daemon.stdout())}`);
    throw error;
  }
  let root;
  try {
    root = await hub.reverseChannels.executeReverseHttp(nodeId, {
      method: "GET",
      rawTarget: "/",
      routeAuthority,
      routeProof: buildRouteProof("GET", "/"),
    });
  } catch (error) {
    console.error(`[Diagnostic] daemon: ${JSON.stringify(daemon.stdout())}`);
    throw error;
  }
  assert.equal(root.status, 200);
  assert.match((await collectBody(root.body)).toString("utf8"), /dsh-root/);
  await root.finish();
  console.log("[Evidence] root ok");

  let api = await hub.reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/api/data",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/api/data"),
  });
  assert.equal(api.status, 200);
  assert.equal(JSON.parse((await collectBody(api.body)).toString("utf8")).ok, true);
  await api.finish();
  console.log("[Evidence] DSH root and API response served through the bounded channel pool");

  console.log("\n=== STEP 4: Static asset and streaming upload ===");
  dsh.setHandler((request, response, body) => {
    if (request.url === "/assets/app.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("console.log('dsh static asset');");
      return;
    }
    if (request.url === "/upload") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ received: body.length }));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });

  let asset = await hub.reverseChannels.executeReverseHttp(nodeId, {
    method: "GET",
    rawTarget: "/assets/app.js",
    routeAuthority,
    routeProof: buildRouteProof("GET", "/assets/app.js"),
  });
  assert.equal(asset.status, 200);
  assert.match((await collectBody(asset.body)).toString("utf8"), /dsh static asset/);
  await asset.finish();

  const uploadChunk = Buffer.alloc(64 * 1024, 0x66);
  let upload = await hub.reverseChannels.executeReverseHttp(nodeId, {
    method: "POST",
    rawTarget: "/upload",
    routeAuthority,
    routeProof: buildRouteProof("POST", "/upload"),
    headers: [["content-type", "application/octet-stream"]],
    body: iterableOf([uploadChunk, uploadChunk, uploadChunk, uploadChunk]),
  });
  assert.equal(upload.status, 200);
  assert.equal(JSON.parse((await collectBody(upload.body)).toString("utf8")).received, uploadChunk.length * 4);
  await upload.finish();
  console.log("[Evidence] Static asset served; 256 KiB streamed upload delivered intact");

  console.log("\n=== STEP 5: Multi-request burst reuses the pool (concurrent flows on distinct channels) ===");
  let burst;
  try {
    burst = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        hub.reverseChannels
          .executeReverseHttp(nodeId, {
            method: "GET",
            rawTarget: `/burst-${i}`,
            routeAuthority,
            routeProof: buildRouteProof("GET", `/burst-${i}`),
          })
          .then(async (result) => {
            const body = (await collectBody(result.body)).toString("utf8");
            await result.finish();
            return { channel: result.channel.id, body };
          }),
      ),
    );
  } catch (error) {
    console.error(`[Diagnostic] daemon: ${JSON.stringify(daemon.stdout())}`);
    throw error;
  }
  assert.equal(burst.length, 4);
  assert.equal(new Set(burst.map((flow) => flow.channel)).size, 4, "concurrent flows must ride distinct channels (1 channel = 1 flow)");
  console.log(`[Evidence] Burst of 4 concurrent flows completed on ${new Set(burst.map((f) => f.channel)).size} distinct channels; pool recovered to ${hub.reverseChannels.idleChannels(nodeId).length} idle`);

  console.log("\n=== v0.5 Stage 4 live evidence complete ===");
});
