// Stage 9 Bundle Integration: DeepSeek Harness 0.1.5-rc.2 upstream build artifact integration.
//
// Scope: this test proves the reviewed patch, the BrowserAuth class, and the
// RemoteStreamMuxServer class against the genuine 0.1.5-rc.2 build artifacts it
// imports. It is NOT process end-to-end evidence: it never boots `dsh web`, and
// the mux is mounted on a server this test creates. The real-process evidence
// lives in stage9-real-015-process-acceptance.test.mjs, which is the acceptance
// the Final Gate reads.
//
// Validates:
// 1. Genuine DSH 0.1.5-rc.2 package layout & symbols
// 2. Exact application and verification of connection-browser-auth-v1 patch
// 3. Authentication matrix (fence 403 vs BrowserAuth 401 vs Orbit proxy admission)
// 4. /api/remote.mux application layer behaviour (upgrade, Ping/Pong, duplex streaming, cancellation, violation close)

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { patchConnectionRootForGeneration, verifyConnectionRoot } from "../src/remote-settings-patch.mjs";
import { assertDsh015Identity, resolveDsh015Checkout } from "./helpers/dsh-015-acceptance-fixture.mjs";

test("Stage 9 Bundle Integration: DeepSeek Harness 0.1.5-rc.2 build artifacts", async (t) => {
  const dshRoot = resolveDsh015Checkout();
  if (!dshRoot) {
    t.skip("DSH_015_ACCEPTANCE_ROOT not configured; skipping the 0.1.5-rc.2 bundle integration test");
    return;
  }

  assertDsh015Identity(dshRoot);

  const dshRealLib = join(dshRoot, "packages/client/connection/lib");
  assert.ok(existsSync(join(dshRealLib, "index.js")), "connection/lib/index.js must exist");

  // The bundle imports workspace packages (@deepseek-ai/schemastery and
  // friends), so the staged copy has to resolve from inside the checkout. It is
  // a fresh untracked directory removed in finally; no tracked file is touched.
  const tmpDir = await mkdtemp(join(dshRoot, "packages/client/connection", ".stage9-test-"));

  try {
    await cp(dshRealLib, tmpDir, { recursive: true });
    const proxySecret = "orbit-secret-stage9-acceptance-2026";
    const proxyAuthFile = join(tmpDir, "proxy-auth");
    await writeFile(proxyAuthFile, proxySecret, "utf8");

    // 1. Verify Patching
    const patchResult = await patchConnectionRootForGeneration({
      root: tmpDir,
      connectionPatch: "connection-browser-auth-v1",
      publicHost: "dsh.example.com",
      proxyAuthFile,
    });
    assert.equal(patchResult.server, "patched");
    assert.equal(patchResult.client, "patched");

    const verifyResult = await verifyConnectionRoot({
      root: tmpDir,
      publicHost: "dsh.example.com",
      proxyAuthFile,
      connectionPatch: "connection-browser-auth-v1",
    });
    assert.equal(verifyResult.status, "ok");

    // 2. 13-Item Authentication Matrix
    const serverPath = join(tmpDir, "index.js");
    const serverSource = await readFile(serverPath, "utf8");
    await writeFile(
      serverPath,
      serverSource + "\nexport { BrowserAuth, isDshOrbitAuthenticatedProxyRequest };\n",
      "utf8"
    );

    const connModule = await import(pathToFileURL(serverPath).href);
    const { BrowserAuth, HostConnectionService, isDshOrbitAuthenticatedProxyRequest } = connModule;

    const authSecret = randomBytes(32);
    const owner = {};
    const auth = new BrowserAuth(owner, authSecret, 1);
    const launchToken = auth.launchToken;

    const mockCtx = {
      root: owner,
      reflect: { provide: () => {} },
      on: () => {},
    };
    const OTHER_HOST = "other.example.com";
    const connectionService = new HostConnectionService(mockCtx, ["dsh.example.com", OTHER_HOST], auth);

    const VALID_PROOF = {
      host: "dsh.example.com",
      "x-forwarded-proto": "https",
      "x-dsh-orbit-authenticated-proxy": proxySecret,
      "sec-fetch-site": "same-origin",
      origin: "https://dsh.example.com",
    };

    function req(headers, url = "/", method = "GET") {
      return { url, headers, method };
    }

    function createRes() {
      const state = { code: null, headers: null, ended: false };
      return {
        writeHead(code, headers) { state.code = code; state.headers = headers; },
        end() { state.ended = true; },
        state,
      };
    }

    // Acquire native session cookie via token exchange
    const resTokenExchange = createRes();
    const tokenExchangeRet = connectionService.authorizeIndex(req({ host: "dsh.example.com" }, "/?token=" + launchToken), resTokenExchange);
    assert.equal(tokenExchangeRet, false);
    assert.equal(resTokenExchange.state.code, 303);
    const nativeCookie = resTokenExchange.state.headers["set-cookie"].match(/^([^;]+)/)[1];

    // Case 1: Positive Orbit API
    assert.equal(connectionService.requestRejection(req(VALID_PROOF, "/api/settings.describe", "POST")), undefined);

    // Case 2: Positive Orbit Index (tokenless)
    const res2 = createRes();
    assert.equal(connectionService.authorizeIndex(req(VALID_PROOF, "/"), res2), true);
    assert.equal(res2.state.code, null);

    // Case 3: Positive Native Token Exchange (303)
    const res3 = createRes();
    assert.equal(connectionService.authorizeIndex(req(VALID_PROOF, "/?token=" + launchToken), res3), false);
    assert.equal(res3.state.code, 303);

    // Case 4: Positive Native Cookie on API
    assert.equal(connectionService.requestRejection(req({ host: "dsh.example.com", cookie: nativeCookie }, "/api/settings.describe", "POST")), undefined);

    // Case 5: Negative Untrusted Host API (Fence 403)
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, host: "evil.example.com" }, "/api/settings.describe", "POST")), 403);

    // Case 6: Negative Loopback Host without Cookie (401)
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, host: "localhost:3080", origin: undefined }, "/api/settings.describe", "POST")), 401);

    // Case 7: Negative Unauthenticated API (401)
    assert.equal(connectionService.requestRejection(req({ host: "dsh.example.com" }, "/api/settings.describe", "POST")), 401);

    // Case 8: Negative Unauthenticated Index (401)
    const res8 = createRes();
    assert.equal(connectionService.authorizeIndex(req({ host: "dsh.example.com" }, "/"), res8), false);
    assert.equal(res8.state.code, 401);

    // Case 9: Negative Invalid Native Token (401)
    const res9 = createRes();
    assert.equal(connectionService.authorizeIndex(req(VALID_PROOF, "/?token=invalid"), res9), false);
    assert.equal(res9.state.code, 401);

    // Case 10: Negative Cross-Origin Origin (Fence 403)
    assert.equal(isDshOrbitAuthenticatedProxyRequest(req({ ...VALID_PROOF, origin: "https://evil.example.com" })), false);
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, origin: "https://evil.example.com" }, "/api/settings.describe", "POST")), 403);

    // Case 11: Negative Sec-Fetch-Site: cross-site (Fence 403)
    assert.equal(isDshOrbitAuthenticatedProxyRequest(req({ ...VALID_PROOF, "sec-fetch-site": "cross-site" })), false);
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, "sec-fetch-site": "cross-site" }, "/api/settings.describe", "POST")), 403);

    // Case 12: Negative Invalid Proxy Secret (401)
    assert.equal(isDshOrbitAuthenticatedProxyRequest(req({ ...VALID_PROOF, "x-dsh-orbit-authenticated-proxy": "bad-secret" })), false);
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, "x-dsh-orbit-authenticated-proxy": "bad-secret" }, "/api/settings.describe", "POST")), 401);

    // Case 12b: Negative Missing Proxy Secret (401)
    const missingSecret = { ...VALID_PROOF };
    delete missingSecret["x-dsh-orbit-authenticated-proxy"];
    assert.equal(isDshOrbitAuthenticatedProxyRequest(req(missingSecret)), false);
    assert.equal(connectionService.requestRejection(req(missingSecret, "/api/settings.describe", "POST")), 401);

    // Case 13: Negative Insecure Scheme (401)
    assert.equal(isDshOrbitAuthenticatedProxyRequest(req({ ...VALID_PROOF, "x-forwarded-proto": "http" })), false);
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, "x-forwarded-proto": "http" }, "/api/settings.describe", "POST")), 401);

    // Case 13b: Negative Missing Forwarded Proto (401)
    const missingProto = { ...VALID_PROOF };
    delete missingProto["x-forwarded-proto"];
    assert.equal(isDshOrbitAuthenticatedProxyRequest(req(missingProto)), false);
    assert.equal(connectionService.requestRejection(req(missingProto, "/api/settings.describe", "POST")), 401);

    // Case 14: Positive Native Cookie on the trusted authority (the patch must
    // not damage native remote-authority authentication).
    assert.equal(connectionService.requestRejection(req({ host: "dsh.example.com", cookie: nativeCookie }, "/api/settings.describe", "POST")), undefined);

    // Case 15: Negative Authority-Bound Cookie Reuse (401). The same authority
    // passes the trust fence, so only the cookie's authority binding rejects it.
    assert.equal(connectionService.requestRejection(req({ host: OTHER_HOST, cookie: nativeCookie }, "/api/settings.describe", "POST")), 401);

    // Case 16: Negative Untrusted Host with a Valid Proof (Fence 403). The proof
    // must never satisfy the fence.
    assert.equal(connectionService.requestRejection(req({ ...VALID_PROOF, host: "evil.example.com" }, "/api/settings.describe", "POST")), 403);

    // 3. /api/remote.mux Application-Layer Acceptance
    const wsModule = await import("file:///" + join(dshRoot, "node_modules/.pnpm/ws@8.21.0/node_modules/ws/wrapper.mjs").replace(/\\/g, "/"));
    const WebSocket = wsModule.default;

    const gatewayLibPath = join(dshRoot, "packages/api/gateway/lib/index.js");
    const gatewaySource = await readFile(gatewayLibPath, "utf8");
    const gwTmpPath = join(dshRoot, "packages/api/gateway/lib/.stage9-gw-export.js");
    await writeFile(
      gwTmpPath,
      gatewaySource + "\nexport { RemoteStreamMuxServer, rejectRemoteStreamUpgrade, REMOTE_STREAM_MUX_PATH };\n",
      "utf8"
    );
    let gwModule;
    try {
      gwModule = await import(pathToFileURL(gwTmpPath).href);
    } finally {
      await rm(gwTmpPath, { force: true });
    }
    const { RemoteStreamMuxServer, rejectRemoteStreamUpgrade, REMOTE_STREAM_MUX_PATH } = gwModule;
    assert.equal(REMOTE_STREAM_MUX_PATH, "/api/remote.mux");

    let streamCancelled = false;
    async function* testStream(endpoint, payload, signal) {
      if (endpoint === "items.stream") {
        yield { seq: 1, text: "alpha" };
        yield { seq: 2, text: "beta" };
        yield { seq: 3, text: "gamma" };
        return;
      }
      if (endpoint === "infinite.stream") {
        signal.addEventListener("abort", () => { streamCancelled = true; });
        let i = 0;
        while (!signal.aborted) {
          yield { count: ++i };
          await new Promise((r) => setTimeout(r, 40));
        }
        return;
      }
      throw new Error(`unknown endpoint ${endpoint}`);
    }

    const mux = new RemoteStreamMuxServer(testStream, (err) => ({ name: err?.name, message: err?.message }), 1000);
    const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });

    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith(REMOTE_STREAM_MUX_PATH)) {
        const rejection = connectionService.requestRejection(req);
        if (rejection !== void 0) {
          rejectRemoteStreamUpgrade(socket, rejection);
          return;
        }
        mux.handleUpgrade(req, socket, head);
        return;
      }
      socket.destroy();
    });

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const serverPort = httpServer.address().port;
    const baseUrl = `http://127.0.0.1:${serverPort}`;

    // S1: Unauthenticated -> 401
    const s1 = await new Promise((resolve) => {
      const reqW = http.request(`${baseUrl}/api/remote.mux`, {
        headers: {
          host: "dsh.example.com",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      });
      reqW.on("response", (res) => resolve(res.statusCode));
      reqW.end();
    });
    assert.equal(s1, 401);

    // S2: Untrusted host -> 403
    const s2 = await new Promise((resolve) => {
      const reqW = http.request(`${baseUrl}/api/remote.mux`, {
        headers: {
          ...VALID_PROOF,
          host: "evil.example.com",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      });
      reqW.on("response", (res) => resolve(res.statusCode));
      reqW.end();
    });
    assert.equal(s2, 403);

    // S3: Orbit proxy proof -> 101 + valid accept
    const secKey = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const s3 = await new Promise((resolve) => {
      const reqW = http.request(`${baseUrl}/api/remote.mux`, {
        headers: {
          ...VALID_PROOF,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": secKey,
        },
      });
      reqW.on("upgrade", (res, socket) => {
        const accept = res.headers["sec-websocket-accept"];
        socket.destroy();
        resolve({ status: res.statusCode, validAccept: accept === expectedAccept });
      });
      reqW.end();
    });
    assert.equal(s3.status, 101);
    assert.equal(s3.validAccept, true);

    // S4: Native cookie -> 101
    const s4 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/remote.mux`, {
        headers: { host: "dsh.example.com", cookie: nativeCookie },
      });
      ws.on("open", () => { ws.close(); resolve(true); });
      ws.on("error", () => resolve(false));
    });
    assert.equal(s4, true);

    // S5: Ping/Pong frame roundtrip
    const s5 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/remote.mux`, { headers: VALID_PROOF });
      ws.on("open", () => ws.ping("test-ping"));
      ws.on("pong", (d) => {
        const ok = d.toString() === "test-ping";
        ws.close();
        resolve(ok);
      });
    });
    assert.equal(s5, true);

    // S6: Logical Stream delivery
    const s6 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/remote.mux`, { headers: VALID_PROOF });
      const items = [];
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "open", streamId: "st1", endpoint: "items.stream", payload: {} }));
      });
      ws.on("message", (m) => {
        const parsed = JSON.parse(m.toString());
        if (parsed.type === "item") items.push(parsed.value);
        if (parsed.type === "end") { ws.close(); resolve(items); }
      });
    });
    assert.deepEqual(s6, [{ seq: 1, text: "alpha" }, { seq: 2, text: "beta" }, { seq: 3, text: "gamma" }]);

    // S7: Stream cancellation propagation
    const s7 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/remote.mux`, { headers: VALID_PROOF });
      let first = false;
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "open", streamId: "st-cancel", endpoint: "infinite.stream", payload: {} }));
      });
      ws.on("message", (m) => {
        const parsed = JSON.parse(m.toString());
        if (parsed.type === "item" && !first) {
          first = true;
          ws.send(JSON.stringify({ type: "cancel", streamId: "st-cancel" }));
          setTimeout(() => { ws.close(); resolve(streamCancelled); }, 100);
        }
      });
    });
    assert.equal(s7, true);

    // S8: Binary frame -> 1003 close
    const s8 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/remote.mux`, { headers: VALID_PROOF });
      ws.on("open", () => ws.send(Buffer.from([1, 2, 3])));
      ws.on("close", (code) => resolve(code));
    });
    assert.equal(s8, 1003);

    // S9: Clean close -> 1000
    const s9 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/remote.mux`, { headers: VALID_PROOF });
      ws.on("open", () => ws.close(1000));
      ws.on("close", (code) => resolve(code));
    });
    assert.equal(s9, 1000);

    await mux.close();
    await new Promise((r) => httpServer.close(r));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
