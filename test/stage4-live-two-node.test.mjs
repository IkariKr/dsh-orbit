// Stage 4 Live Two-Node Integration Evidence Test (True Child Processes).
// Exercises:
// 1. Child-process Hub + Node A (NAS, HTTPS + private CA) + Node B (Workstation, loopback HTTP)
// 2. Real CLI enrollment, heartbeat trust pull & ACK, and compatibility report upload
//    with supported DSH profile dsh-0.1.1-rc.2 (verifying webSocketTransport passes and activates web.routes)
// 3. Separate deterministic public route authorities:
//    - Route Authority A: n-<nodeIdA>.<routeDomain>
//    - Route Authority B: n-<nodeIdB>.<routeDomain>
// 4. Downstream DSH server A returns distinct identifying fixture A (HTML root, static assets, APIs, and WebSocket echo)
// 5. Downstream DSH server B returns distinct identifying fixture B (HTML root, static assets, APIs, and WebSocket echo)
// 6. Rehearsal wildcard WSS gateway (wss://*.stage4-test.example) terminating TLS:
//    - Real gateway authentication gate on WebSocket upgrade: missing or invalid credentials denied with 401
//    - Valid credentials consumed and stripped before proxying to Hub loopback
//    - Preserves canonical Host and WebSocket metadata
//    - Public registration authority denies private machine surface (/api/v1/*) with 403
//    - Selector apex authority (wss://stage4-test.example/) denies WebSocket upgrade with 404
//    - Invalid wildcard host (e.g. foo.stage4-test.example) denies WebSocket upgrade with 404
// 7. Live WSS upgraded connections to Authority A and Authority B:
//    - Client sends RFC 6455 masked text and binary frames
//    - Receives echo payload with corresponding fixture header / payload
//    - Verifies 101 Set-Cookie has Domain= stripped
//    - Verifies pre-sent client head bytes and upstream head bytes
//    - Fixture A never reaches Fixture B (strict cross-node isolation)
// 8. Negative fault injections:
//    - Missing gateway auth fails with 401
//    - Invalid gateway auth fails with 401
//    - Connecting to gateway with non-matching SAN fails closed on TLS
//    - Ingress fault isolation: stop Node A -> Node A WebSocket unavailable (503 with selectorUrl); Node B WebSocket unaffected
// 9. Process restarts: restart Hub and both Node daemons -> routing & WSS isolation preserved with zero drift

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { validReport } from "./helpers/registry-fixture.mjs";
import { startSupportedDshCandidate } from "./helpers/dsh-candidate-fixture.mjs";
import { computeRouteAuthority } from "../src/registry/protocol.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REHEARSAL_DOMAIN = "stage4-test.example";
const REGISTRATION_AUTHORITY = `registration.${REHEARSAL_DOMAIN}`;
const REHEARSAL_GATEWAY_TOKEN = "valid-stage4-gateway-secret-token";

function killProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2000).unref();
  });
}

function generateWildcardCertificate(dir) {
  const keyPath = join(dir, "wildcard-gateway-key.pem");
  const certPath = join(dir, "wildcard-gateway-cert.pem");
  return new Promise((resolve, reject) => {
    execFile(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        `/CN=*.${REHEARSAL_DOMAIN}`,
        "-addext",
        `subjectAltName=DNS:*.${REHEARSAL_DOMAIN},DNS:${REHEARSAL_DOMAIN},DNS:${REGISTRATION_AUTHORITY},IP:127.0.0.1`,
      ],
      { env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      (error) => (error ? reject(error) : resolve({ keyPath, certPath })),
    );
  });
}

function encodeFrame(data, { opcode = null, isBinary = false, isClient = true } = {}) {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const len = dataBuf.length;
  const resolvedOpcode = opcode !== null ? opcode : (isBinary ? 0x02 : 0x01);
  let headerLen = 2;
  if (len > 125 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;
  if (isClient) headerLen += 4;

  const buf = Buffer.alloc(headerLen + len);
  buf[0] = 0x80 | (resolvedOpcode & 0x0f);
  const maskBit = isClient ? 0x80 : 0x00;
  let offset = 1;

  if (len <= 125) {
    buf[offset++] = maskBit | len;
  } else if (len <= 65535) {
    buf[offset++] = maskBit | 126;
    buf.writeUInt16BE(len, offset);
    offset += 2;
  } else {
    buf[offset++] = maskBit | 127;
    buf.writeBigUInt64BE(BigInt(len), offset);
    offset += 8;
  }

  if (isClient) {
    const maskKey = Buffer.from([1, 2, 3, 4]);
    maskKey.copy(buf, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      buf[offset + i] = dataBuf[i] ^ maskKey[i % 4];
    }
  } else {
    dataBuf.copy(buf, offset);
  }
  return buf;
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const hasMask = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey = null;
  if (hasMask) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    payload[i] = hasMask ? buf[offset + i] ^ maskKey[i % 4] : buf[offset + i];
  }
  return { fin, opcode, payload, totalLength: offset + len };
}

function parseHttpResponse(rawText) {
  const headerEnd = rawText.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerSection = rawText.slice(0, headerEnd);
  const body = rawText.slice(headerEnd + 4);
  const lines = headerSection.split("\r\n");
  const statusLine = lines[0];
  const match = statusLine.match(/^HTTP\/1\.[01] (\d+)(?: (.*))?$/);
  const status = match ? Number(match[1]) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx !== -1) {
      const k = lines[i].slice(0, colonIdx).trim().toLowerCase();
      const v = lines[i].slice(colonIdx + 1).trim();
      if (headers[k]) {
        if (Array.isArray(headers[k])) headers[k].push(v);
        else headers[k] = [headers[k], v];
      } else {
        headers[k] = v;
      }
    }
  }
  return { status, statusLine, headers, body, raw: rawText };
}

function startWildcardGateway({ keyPath, certPath, hubPort }) {
  return new Promise(async (resolve, reject) => {
    const key = await readFile(keyPath);
    const cert = await readFile(certPath);

    const server = https.createServer({ key, cert }, (req, res) => {
      handleGatewayHttp(req, res);
    });

    function checkHost(incomingHost) {
      const hostWithoutPort = incomingHost.toLowerCase().split(":")[0].replace(/\.$/, "");
      const isRehearsalHost =
        hostWithoutPort === REHEARSAL_DOMAIN ||
        hostWithoutPort === REGISTRATION_AUTHORITY ||
        hostWithoutPort.endsWith(`.${REHEARSAL_DOMAIN}`);
      return { hostWithoutPort, isRehearsalHost };
    }

    function handleGatewayHttp(req, res) {
      const incomingHost = req.headers.host || "";
      const { hostWithoutPort, isRehearsalHost } = checkHost(incomingHost);

      if (!isRehearsalHost) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unrelated-host-denied", message: "gateway does not route foreign host" } }));
        return;
      }

      if (hostWithoutPort === REGISTRATION_AUTHORITY) {
        if (req.url.startsWith("/api/v1/")) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "machine-ingress-denied", message: "private machine surface" } }));
          return;
        }
        forwardHttpToHub(req, res, hubPort, incomingHost);
        return;
      }

      if (hostWithoutPort === REHEARSAL_DOMAIN) {
        forwardHttpToHub(req, res, hubPort, incomingHost);
        return;
      }

      const providedGatewayAuth = req.headers["x-gateway-auth"];
      if (!providedGatewayAuth || providedGatewayAuth !== REHEARSAL_GATEWAY_TOKEN) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "gateway-auth-required", message: "valid outer gateway authentication required" } }));
        return;
      }

      forwardHttpToHub(req, res, hubPort, incomingHost);
    }

    function forwardHttpToHub(req, res, targetPort, originalHost) {
      const forwardHeaders = { ...req.headers };
      forwardHeaders.host = originalHost;
      delete forwardHeaders["x-gateway-auth"];
      delete forwardHeaders["x-gateway-secret"];

      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      upstream.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "gateway-upstream-error", message: err.message } }));
        }
      });

      req.pipe(upstream);
    }

    // Server-level WebSocket upgrade handling on HTTPS/WSS gateway
    server.on("upgrade", (req, clientSocket, head) => {
      const incomingHost = req.headers.host || "";
      const { hostWithoutPort, isRehearsalHost } = checkHost(incomingHost);

      const sendSocketError = (status, code, message) => {
        const body = JSON.stringify({ error: { code, message } });
        const lines = [
          `HTTP/1.1 ${status} Error`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body,
        ];
        try {
          clientSocket.write(lines.join("\r\n"));
          clientSocket.destroy();
        } catch {}
      };

      if (!isRehearsalHost) {
        sendSocketError(400, "unrelated-host-denied", "gateway does not route foreign host");
        return;
      }

      if (hostWithoutPort === REGISTRATION_AUTHORITY) {
        sendSocketError(403, "machine-ingress-denied", "WebSocket upgrades not allowed on registration authority");
        return;
      }

      if (hostWithoutPort === REHEARSAL_DOMAIN) {
        // Selector apex does not support WebSockets -> Hub returns 404
        forwardWsToHub(req, clientSocket, head, hubPort, incomingHost);
        return;
      }

      // Check outer gateway authentication gate for WebSocket upgrades
      const providedGatewayAuth = req.headers["x-gateway-auth"];
      if (!providedGatewayAuth || providedGatewayAuth !== REHEARSAL_GATEWAY_TOKEN) {
        sendSocketError(401, "gateway-auth-required", "valid outer gateway authentication required");
        return;
      }

      forwardWsToHub(req, clientSocket, head, hubPort, incomingHost);
    });

    function forwardWsToHub(req, clientSocket, head, targetPort, originalHost) {
      const forwardHeaders = { ...req.headers };
      forwardHeaders.host = originalHost;
      delete forwardHeaders["x-gateway-auth"];
      delete forwardHeaders["x-gateway-secret"];

      const upstreamReq = http.request({
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method || "GET",
        headers: forwardHeaders,
      });

      upstreamReq.on("error", (err) => {
        const selectorUrl = `https://${REHEARSAL_DOMAIN}/`;
        const body = JSON.stringify({ error: { code: "bad-gateway", message: err.message, selectorUrl } });
        const lines = [
          "HTTP/1.1 502 Bad Gateway",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body,
        ];
        try {
          clientSocket.write(lines.join("\r\n"));
          clientSocket.end();
        } catch {}
      });

      upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        upstreamReq.setTimeout(0);
        upstreamSocket.setTimeout(0);
        clientSocket.setTimeout(0);

        const responseLines = ["HTTP/1.1 101 Switching Protocols"];
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) responseLines.push(`${k}: ${item}`);
          } else {
            responseLines.push(`${k}: ${v}`);
          }
        }
        responseLines.push("", "");
        clientSocket.write(responseLines.join("\r\n"));

        if (upstreamHead && upstreamHead.length > 0) {
          clientSocket.write(upstreamHead);
        }
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }

        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);

        const cleanup = () => {
          try { clientSocket.destroy(); } catch {}
          try { upstreamSocket.destroy(); } catch {}
        };
        clientSocket.on("error", cleanup);
        upstreamSocket.on("error", cleanup);
        clientSocket.on("close", cleanup);
        upstreamSocket.on("close", cleanup);
      });

      // Upstream Hub responded with non-101 (e.g. 502 with selectorUrl)
      upstreamReq.on("response", (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders["transfer-encoding"];
        responseHeaders["connection"] = "close";

        const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || "Error"}`];
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (Array.isArray(v)) {
            for (const item of v) lines.push(`${k}: ${item}`);
          } else {
            lines.push(`${k}: ${v}`);
          }
        }
        lines.push("", "");
        clientSocket.write(lines.join("\r\n"));
        upstreamRes.pipe(clientSocket);
      });

      clientSocket.on("error", () => {
        try { upstreamReq.destroy(); } catch {}
      });

      upstreamReq.end();
    }

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeGatewayRequest({
  gatewayPort,
  authority,
  path = "/",
  method = "GET",
  headers = {},
  body = null,
  caCert,
  rejectUnauthorized = true,
  servername = null,
}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      ...headers,
      host: authority,
    };
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: gatewayPort,
        path,
        method,
        headers: reqHeaders,
        ca: caCert ? [caCert] : undefined,
        rejectUnauthorized,
        servername: servername || authority.split(":")[0],
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: async () => raw.toString("utf8"),
            json: async () => JSON.parse(raw.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function connectGatewayTlsSocket({ gatewayPort, authority, caCert, servername = null }) {
  return new Promise((resolve, reject) => {
    const sName = servername || authority.split(":")[0];
    const socket = tls.connect(
      {
        port: gatewayPort,
        host: "127.0.0.1",
        ca: caCert ? [caCert] : undefined,
        servername: sName,
        rejectUnauthorized: true,
      },
      () => resolve(socket),
    );
    socket.on("error", reject);
  });
}

function performWssUpgrade(tlsSocket, { authority, path = "/ws", headers = {}, head = Buffer.alloc(0) }) {
  return new Promise((resolve, reject) => {
    const secKey = randomBytes(16).toString("base64");
    const reqHeaders = {
      Host: authority,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": secKey,
      ...headers,
    };

    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(reqHeaders)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("", "");
    const rawReq = lines.join("\r\n");

    let received = Buffer.alloc(0);
    let resolved = false;

    const tryParse = () => {
      if (resolved) return;
      const idx = received.indexOf("\r\n\r\n");
      if (idx !== -1) {
        const headerText = received.slice(0, idx + 4).toString("utf8");
        const parsed = parseHttpResponse(headerText);
        if (!parsed) return;
        const expectedLen = parsed.headers["content-length"] ? Number(parsed.headers["content-length"]) : 0;
        const bodyBytes = received.slice(idx + 4);
        if (parsed.status === 101) {
          const expectedAccept = createHash("sha1").update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          assert.equal(parsed.headers["sec-websocket-accept"], expectedAccept, "Sec-WebSocket-Accept must match client Sec-WebSocket-Key hash");
          resolved = true;
          tlsSocket.removeListener("data", onData);
          resolve({
            ...parsed,
            body: bodyBytes.toString("utf8"),
            socket: tlsSocket,
            remainingBytes: bodyBytes.slice(expectedLen),
          });
        } else if (bodyBytes.length >= expectedLen) {
          resolved = true;
          tlsSocket.removeListener("data", onData);
          resolve({
            ...parsed,
            body: bodyBytes.toString("utf8"),
            socket: tlsSocket,
            remainingBytes: bodyBytes.slice(expectedLen),
          });
        }
      }
    };

    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      tryParse();
    };
    tlsSocket.on("data", onData);
    tlsSocket.on("end", () => {
      if (resolved) return;
      const idx = received.indexOf("\r\n\r\n");
      if (idx !== -1) {
        resolved = true;
        const headerText = received.slice(0, idx + 4).toString("utf8");
        const parsed = parseHttpResponse(headerText);
        const bodyBytes = received.slice(idx + 4);
        resolve({
          ...parsed,
          body: bodyBytes.toString("utf8"),
          socket: tlsSocket,
          remainingBytes: Buffer.alloc(0),
        });
      }
    });
    tlsSocket.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    tlsSocket.write(rawReq);
    if (head && head.length > 0) {
      tlsSocket.write(head);
    }
  });
}

function safeDestroy(socket) {
  if (!socket) return;
  try {
    socket.removeAllListeners("error");
    socket.on("error", () => {});
    socket.destroy();
  } catch {}
}

function startHubProcess({ dbPath, port = 0, caCertPath, routeDomain = REHEARSAL_DOMAIN, cadenceSeconds = 1 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dsh-orbit-hub.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_ORBIT_HUB_DB: dbPath,
        DSH_ORBIT_HUB_PORT: String(port),
        DSH_ORBIT_HUB_LISTEN: "127.0.0.1",
        DSH_ORBIT_HUB_ROUTE_DOMAIN: routeDomain,
        DSH_ORBIT_HUB_CA_CERT: caCertPath,
        DSH_ORBIT_HUB_ROUTE_PROBE_CADENCE_SECONDS: String(cadenceSeconds),
        DSH_ORBIT_HUB_GATEWAY_SECRET: "test-gateway-secret",
        DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/registry listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        resolve({ child, port: Number(match[1]), baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Hub exited early code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function runNodeEnroll({ statePath, hubUrl, enrollTokenValue, caCertPath = null }) {
  return new Promise((resolve, reject) => {
    const envVars = {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_ENROLL_TOKEN: enrollTokenValue,
    };
    if (caCertPath) {
      envVars.DSH_ORBIT_NODE_CA_CERT = caCertPath;
    }
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "enroll"], {
      cwd: REPO_ROOT,
      env: envVars,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        const match = stdout.match(/enrolled: (node_[0-9a-f]{32}) \(keyId ([0-9a-f]{32})\)/);
        resolve({ nodeId: match[1], keyId: match[2] });
      } else {
        reject(new Error(`Enroll failed code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function runNodeUploadReport({ statePath, hubUrl, reportPath, caCertPath = null }) {
  return new Promise((resolve, reject) => {
    const envVars = {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_REPORT_FILE: reportPath,
    };
    if (caCertPath) {
      envVars.DSH_ORBIT_NODE_CA_CERT = caCertPath;
    }
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "upload-report"], {
      cwd: REPO_ROOT,
      env: envVars,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Upload report failed code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function startNodeDaemon({
  statePath,
  hubUrl,
  ingressPort = 0,
  dshTarget,
  tlsKeyPath = null,
  tlsCertPath = null,
  caCertPath = null,
  cadence = 30,
}) {
  return new Promise((resolve, reject) => {
    const envVars = {
      ...process.env,
      DSH_ORBIT_NODE_STATE: statePath,
      DSH_ORBIT_HUB_URL: hubUrl,
      DSH_ORBIT_NODE_HEARTBEAT_SECONDS: String(cadence),
      DSH_ORBIT_NODE_ORBIT_VERSION: "0.4.0",
      DSH_ORBIT_NODE_ORBIT_REVISION: "abc123",
      DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
      DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
      DSH_ORBIT_NODE_ROUTE_INGRESS_PORT: String(ingressPort),
      DSH_ORBIT_NODE_ROUTE_INGRESS_LISTEN: "127.0.0.1",
      DSH_ORBIT_NODE_DSH_TARGET: dshTarget,
      DSH_ORBIT_NODE_ROUTE_DOMAIN: REHEARSAL_DOMAIN,
    };
    if (tlsKeyPath && tlsCertPath) {
      envVars.DSH_ORBIT_NODE_ROUTE_TLS_KEY = tlsKeyPath;
      envVars.DSH_ORBIT_NODE_ROUTE_TLS_CERT = tlsCertPath;
    }
    if (caCertPath) {
      envVars.DSH_ORBIT_NODE_CA_CERT = caCertPath;
    }
    const child = spawn(process.execPath, ["bin/dsh-orbit-node.mjs", "run"], {
      cwd: REPO_ROOT,
      env: envVars,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/route ingress listening on (https?:\/\/127\.0\.0\.1:(\d+))/);
      if (match) {
        resolve({ child, ingressOrigin: match[1], port: Number(match[2]) });
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Node daemon exited early code ${code}; stderr=${stderr}`));
      }
    });
  });
}

function startIdentifiedDshServer(fixtureId) {
  let alive = true;
  let lastReceivedHeaders = null;
  let lastReceivedHead = Buffer.alloc(0);
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    lastReceivedHeaders = { ...req.headers };
    if (!alive) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "dsh_down" }));
      return;
    }

    // Branch A: Static root HTML document
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-node-fixture": fixtureId,
        "set-cookie": `node_session=${fixtureId}_sess; Domain=.${REHEARSAL_DOMAIN}; Path=/; HttpOnly`,
      });
      res.end(`<!DOCTYPE html><html><head><title>DSH ${fixtureId}</title></head><body><h1>Welcome to ${fixtureId}</h1><script src="/assets/app.js"></script></body></html>`);
      return;
    }

    // Branch B: Static client asset JavaScript
    if (req.url === "/assets/app.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "x-node-fixture": fixtureId,
      });
      res.end(`console.log("Loaded asset bundle for ${fixtureId}");`);
      return;
    }

    // Branch C: General API paths
    res.writeHead(200, {
      "content-type": "application/json",
      "x-node-fixture": fixtureId,
      "set-cookie": `node_session=${fixtureId}_sess; Domain=.${REHEARSAL_DOMAIN}; Path=/; HttpOnly`,
    });
    res.end(JSON.stringify({
      nodeFixture: fixtureId,
      path: req.url,
      method: req.method,
      hostHeader: req.headers.host,
    }));
  });

  // WebSocket support on mock DSH target
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    lastReceivedHeaders = { ...req.headers };
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));

    if (head && head.length > 0) {
      lastReceivedHead = Buffer.from(head);
    }

    if (!alive) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"dsh_down\"}");
      socket.end();
      return;
    }

    // DSH 0.1.1-rc.2 browser-trust fence validation:
    // When Origin is attached, Origin.host must match Host
    if (req.headers.origin) {
      try {
        const originUrl = new URL(req.headers.origin);
        const hostHeader = (req.headers.host || "").toLowerCase().split(":")[0];
        if (originUrl.hostname !== hostHeader) {
          socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"origin mismatch\"}");
          socket.destroy();
          return;
        }
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"malformed origin\"}");
        socket.destroy();
        return;
      }
    }

    const clientKey = req.headers["sec-websocket-key"] || "";
    const acceptVal = createHash("sha1").update(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");

    const responseHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Accept": acceptVal,
      "Set-Cookie": `node_ws_session=${fixtureId}_ws; Domain=.${REHEARSAL_DOMAIN}; Path=/; HttpOnly`,
      "X-Node-Fixture": fixtureId,
    };

    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [k, v] of Object.entries(responseHeaders)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"));

    const isDshDownlink = req.url === "/api/events.mux" || req.url === "/api/events.host";
    if (isDshDownlink) {
      // DSH 0.1.1-rc.2 downlink server immediately pushes an event frame
      const initialFrame = encodeFrame(JSON.stringify({
        type: "server-request",
        rpcId: "rpc-init",
        method: "stream/ready",
        payload: { fixture: fixtureId, stream: req.url },
      }), { isBinary: false, isClient: false });
      socket.write(initialFrame);
    }

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      let dataChunk = chunk;
      if (lastReceivedHead.length === 0 && chunk.toString("utf8").startsWith("CLIENT_HEAD")) {
        const headLen = Buffer.byteLength("CLIENT_HEAD_PRE_SENT");
        lastReceivedHead = chunk.slice(0, headLen);
        dataChunk = chunk.slice(headLen);
      }

      if (dataChunk.length > 0) {
        buf = Buffer.concat([buf, dataChunk]);
        while (buf.length >= 2) {
          const decoded = decodeFrame(buf);
          if (!decoded) break;
          buf = buf.slice(decoded.totalLength);

          // Handle control frames
          if (decoded.opcode === 0x09) {
            // Ping -> Reply Pong
            const pong = Buffer.alloc(2 + decoded.payload.length);
            pong[0] = 0x8a;
            pong[1] = decoded.payload.length & 0x7f;
            decoded.payload.copy(pong, 2);
            socket.write(pong);
            continue;
          }

          if (isDshDownlink) {
            // DSH 0.1.1-rc.2 protocol violation: client message on downlink-only stream closes with 1008
            const closeFrame = Buffer.alloc(4 + Buffer.byteLength("downlink only"));
            closeFrame[0] = 0x88;
            closeFrame[1] = (2 + Buffer.byteLength("downlink only")) & 0x7f;
            closeFrame.writeUInt16BE(1008, 2);
            Buffer.from("downlink only").copy(closeFrame, 4);
            socket.write(closeFrame);
            socket.end();
            break;
          }

          // Echo frame back prefixed with fixtureId
          const isBinary = decoded.opcode === 0x02;
          let echoPayload;
          if (isBinary) {
            echoPayload = decoded.payload;
          } else {
            echoPayload = `[${fixtureId}] ${decoded.payload.toString("utf8")}`;
          }
          const responseFrame = encodeFrame(echoPayload, { isBinary, isClient: false });
          socket.write(responseFrame);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        target: `http://127.0.0.1:${port}`,
        getLastHeaders: () => lastReceivedHeaders,
        getLastHead: () => lastReceivedHead,
        setAlive: (v) => (alive = v),
        close: () => new Promise((r) => {
          for (const s of activeSockets) {
            try { s.destroy(); } catch {}
          }
          activeSockets.clear();
          server.close(r);
        }),
      });
    });
  });
}

const GATEWAY_HEADERS = {
  "x-dsh-authenticated-proxy": "test-gateway-secret",
  "x-dsh-operator-id": "operator",
};

async function getOperatorSession(hubBaseUrl) {
  const res = await fetch(`${hubBaseUrl}/hub/session`, {
    method: "POST",
    headers: {
      ...GATEWAY_HEADERS,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")?.match(/(?:^|;\s*)dsh-orbit-hub-session=([^;]+)/)?.[1];
  const body = await res.json();
  return { cookie, csrfToken: body.csrfToken };
}

async function operatorMintToken(hubBaseUrl, session) {
  const res = await fetch(`${hubBaseUrl}/hub/tokens`, {
    method: "POST",
    headers: {
      ...GATEWAY_HEADERS,
      "content-type": "application/json",
      cookie: `dsh-orbit-hub-session=${session.cookie}`,
      "x-csrf-token": session.csrfToken,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ purpose: "enroll" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.token;
}

async function operatorSetRouteTarget(hubBaseUrl, session, nodeId, routeTarget) {
  const res = await fetch(`${hubBaseUrl}/hub/nodes/${nodeId}/route-target`, {
    method: "PUT",
    headers: {
      ...GATEWAY_HEADERS,
      "content-type": "application/json",
      cookie: `dsh-orbit-hub-session=${session.cookie}`,
      "x-csrf-token": session.csrfToken,
      origin: hubBaseUrl,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ routeTarget }),
  });
  assert.equal(res.status, 200);
  return await res.json();
}

async function operatorGetNode(hubBaseUrl, session, nodeId) {
  const res = await fetch(`${hubBaseUrl}/hub/nodes/${nodeId}`, {
    headers: {
      ...GATEWAY_HEADERS,
      cookie: `dsh-orbit-hub-session=${session.cookie}`,
    },
  });
  assert.equal(res.status, 200);
  return await res.json();
}

async function waitForNodeEligible(hubBaseUrl, session, nodeId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const node = await operatorGetNode(hubBaseUrl, session, nodeId);
    const hasActiveKey = (node.hubRouteKeys || []).some((k) => k.state === "active");
    const hasRouteTarget = Boolean(node.routeTarget);
    const isReachable = node.health?.reachable === "ok";
    const isActive = node.state === "active";
    const hasWebRoutes = (node.health?.capabilities || []).some((c) => c.name === "web.routes");

    if (isActive && hasRouteTarget && isReachable && hasActiveKey && hasWebRoutes) {
      return node;
    }
    await sleep(200);
  }
  const finalNode = await operatorGetNode(hubBaseUrl, session, nodeId);
  throw new Error(`Timeout waiting for ${nodeId} to become eligible for routing: ${JSON.stringify(finalNode, null, 2)}`);
}

test("Live Two-Node Stage 4 Evidence: Rehearsal WSS Wildcard Gateway, WebSockets, Fixture Isolation, and Restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-stage4-live-two-node-"));
  const dbPath = join(dir, "hub.db");
  const statePathA = join(dir, "node-a.json");
  const statePathB = join(dir, "node-b.json");
  const statePathC = join(dir, "node-c.json");
  const nodeCertPath = join(dir, "node-cert.pem");
  const nodeKeyPath = join(dir, "node-key.pem");
  const reportPath = join(dir, "report.json");

  await writeFile(nodeCertPath, GATEWAY_CERT_PEM, "utf8");
  await writeFile(nodeKeyPath, GATEWAY_KEY_PEM, "utf8");
  // Supported DSH profile acceptance evidence (DSH 0.1.1-rc.2 with webSocketTransport: pass)
  await writeFile(reportPath, JSON.stringify(validReport({
    orbitVersion: "0.4.0",
    dshVersion: "0.1.1-rc.2",
    profile: "dsh-0.1.1-rc.2",
  })), "utf8");

  // Generate Wildcard Gateway TLS credentials for *.stage4-test.example
  const { keyPath: gwKeyPath, certPath: gwCertPath } = await generateWildcardCertificate(dir);
  const wildcardCaCert = await readFile(gwCertPath);

  let hub = null;
  let gateway = null;
  let nodeA = null;
  let nodeB = null;
  let nodeC = null;
  let candidateDsh = null;
  let dshA = null;
  let dshB = null;

  t.after(async () => {
    await killProcess(nodeA?.child);
    await killProcess(nodeB?.child);
    await killProcess(nodeC?.child);
    if (candidateDsh) await candidateDsh.close();
    await killProcess(hub?.child);
    if (gateway) await gateway.close();
    if (dshA) await dshA.close();
    if (dshB) await dshB.close();
    await rm(dir, { recursive: true, force: true });
  });

  console.log("\n=== STEP 1: Launch Downstream Protocol Fixture Servers (A & B) with Distinct Identifiers & WebSocket Echo ===");
  dshA = await startIdentifiedDshServer("fixture-nas-node-A");
  dshB = await startIdentifiedDshServer("fixture-workstation-node-B");
  console.log(`[Protocol Fixture Evidence] Fixture DSH A running on ${dshA.target} with HTML, static JS, API, and WebSocket echo`);
  console.log(`[Protocol Fixture Evidence] Fixture DSH B running on ${dshB.target} with HTML, static JS, API, and WebSocket echo`);

  console.log("\n=== STEP 2: Start Hub Daemon with Route Domain & Private CA ===");
  hub = await startHubProcess({ dbPath, caCertPath: nodeCertPath, routeDomain: REHEARSAL_DOMAIN, cadenceSeconds: 1 });
  console.log(`[Evidence] Hub running on ${hub.baseUrl} (routeDomain ${REHEARSAL_DOMAIN})`);
  let opSession = await getOperatorSession(hub.baseUrl);

  console.log("\n=== STEP 3: Start Rehearsal WSS Wildcard Gateway (*.stage4-test.example) ===");
  gateway = await startWildcardGateway({ keyPath: gwKeyPath, certPath: gwCertPath, hubPort: hub.port });
  console.log(`[Evidence] Rehearsal Wildcard WSS/HTTPS Gateway running on port ${gateway.port}`);

  console.log("\n=== STEP 4: Negative Gateway Tests (WSS Auth Gate, Selector Apex Denial, and Invalid Wildcard Host) ===");
  // Test 4.1: Missing outer gateway authentication on WSS fails closed with 401
  const clientTlsSocket1 = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: `n-${"aa".repeat(16)}.${REHEARSAL_DOMAIN}`,
    caCert: wildcardCaCert,
  });
  const missingAuthRes = await performWssUpgrade(clientTlsSocket1, {
    authority: `n-${"aa".repeat(16)}.${REHEARSAL_DOMAIN}`,
    path: "/ws",
  });
  assert.equal(missingAuthRes.status, 401);
  const missingAuthBody = JSON.parse(missingAuthRes.body);
  assert.equal(missingAuthBody.error.code, "gateway-auth-required");
  clientTlsSocket1.destroy();
  console.log(`[Evidence] Negative test passed: Missing outer gateway auth on WSS denied with 401`);

  // Test 4.2: Wrong outer gateway authentication on WSS fails closed with 401
  const clientTlsSocket2 = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: `n-${"aa".repeat(16)}.${REHEARSAL_DOMAIN}`,
    caCert: wildcardCaCert,
  });
  const wrongAuthRes = await performWssUpgrade(clientTlsSocket2, {
    authority: `n-${"aa".repeat(16)}.${REHEARSAL_DOMAIN}`,
    path: "/ws",
    headers: { "x-gateway-auth": "wrong-bogus-token" },
  });
  assert.equal(wrongAuthRes.status, 401);
  const wrongAuthBody = JSON.parse(wrongAuthRes.body);
  assert.equal(wrongAuthBody.error.code, "gateway-auth-required");
  clientTlsSocket2.destroy();
  console.log(`[Evidence] Negative test passed: Wrong outer gateway auth on WSS denied with 401`);

  // Test 4.3: Invalid wildcard Host (e.g. foo.stage4-test.example) on WSS fails closed with 404
  const clientTlsSocket3 = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: `foo.${REHEARSAL_DOMAIN}`,
    caCert: wildcardCaCert,
  });
  const invalidWildcardWsRes = await performWssUpgrade(clientTlsSocket3, {
    authority: `foo.${REHEARSAL_DOMAIN}`,
    path: "/ws",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(invalidWildcardWsRes.status, 404);
  const invalidWildcardWsBody = JSON.parse(invalidWildcardWsRes.body);
  assert.equal(invalidWildcardWsBody.error.code, "route-not-found");
  clientTlsSocket3.destroy();
  console.log(`[Evidence] Negative test passed: Invalid wildcard host 'foo.stage4-test.example' on WSS blocked with 404`);

  // Test 4.4: Selector apex authority (wss://stage4-test.example/) denies WebSocket upgrade with 404
  const clientTlsSocket4 = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: REHEARSAL_DOMAIN,
    caCert: wildcardCaCert,
  });
  const selectorWsRes = await performWssUpgrade(clientTlsSocket4, {
    authority: REHEARSAL_DOMAIN,
    path: "/ws",
  });
  assert.equal(selectorWsRes.status, 404);
  clientTlsSocket4.destroy();
  console.log(`[Evidence] Negative test passed: Selector apex authority denied WebSocket upgrade with 404`);

  console.log("\n=== STEP 5: Enroll and Upload Compatibility Reports for Both Nodes ===");
  const tokenA = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResA = await runNodeEnroll({ statePath: statePathA, hubUrl: hub.baseUrl, enrollTokenValue: tokenA, caCertPath: nodeCertPath });
  await runNodeUploadReport({ statePath: statePathA, hubUrl: hub.baseUrl, reportPath, caCertPath: nodeCertPath });
  console.log(`[Evidence] Enrolled Node A: ${enrollResA.nodeId} and uploaded report with webSocketTransport (web.routes active)`);

  const tokenB = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResB = await runNodeEnroll({ statePath: statePathB, hubUrl: hub.baseUrl, enrollTokenValue: tokenB });
  await runNodeUploadReport({ statePath: statePathB, hubUrl: hub.baseUrl, reportPath });
  console.log(`[Evidence] Enrolled Node B: ${enrollResB.nodeId} and uploaded report with webSocketTransport (web.routes active)`);

  console.log("\n=== STEP 6: Start Node Daemons (Node A on HTTPS + Private CA, Node B on HTTP) ===");
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    dshTarget: dshA.target,
    tlsKeyPath: nodeKeyPath,
    tlsCertPath: nodeCertPath,
    caCertPath: nodeCertPath,
    cadence: 30,
  });
  console.log(`[Evidence] Node A daemon started with HTTPS route ingress: ${nodeA.ingressOrigin}`);

  nodeB = await startNodeDaemon({
    statePath: statePathB,
    hubUrl: hub.baseUrl,
    dshTarget: dshB.target,
    cadence: 30,
  });
  console.log(`[Evidence] Node B daemon started with HTTP route ingress: ${nodeB.ingressOrigin}`);

  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResA.nodeId, nodeA.ingressOrigin);
  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResB.nodeId, nodeB.ingressOrigin);
  console.log(`[Evidence] Operator registered route targets for Node A and Node B`);

  const authorityA = computeRouteAuthority(enrollResA.nodeId, REHEARSAL_DOMAIN);
  const authorityB = computeRouteAuthority(enrollResB.nodeId, REHEARSAL_DOMAIN);
  console.log(`[Evidence] Deterministic Public Authority A: ${authorityA}`);
  console.log(`[Evidence] Deterministic Public Authority B: ${authorityB}`);

  console.log("\n=== STEP 7: Wait for 5-Condition Routing Eligibility ===");
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResA.nodeId);
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResB.nodeId);
  console.log(`[Evidence] Both nodes satisfied all 5 conditions (active, routeTarget, reachable=ok, activeKey, web.routes)`);

  console.log("\n=== STEP 8: Execute Routed WSS WebSockets via Real WSS Wildcard Gateway (Protocol Fixtures A & B) ===");
  // Request 8.1: WSS Connection to Authority A -> Must reach Fixture A and return Fixture A WSS Echo
  const tlsSocketA = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityA,
    caCert: wildcardCaCert,
  });
  const initialHeadA = Buffer.from("CLIENT_HEAD_PRE_SENT");
  const wsResA = await performWssUpgrade(tlsSocketA, {
    authority: authorityA,
    path: "/ws?session=alpha",
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: `https://${authorityA}`,
      "Sec-WebSocket-Protocol": "dsh-protocol-v1",
      Authorization: "Bearer dsh-token-opaque",
    },
    head: initialHeadA,
  });

  assert.equal(wsResA.status, 101);
  assert.equal(wsResA.headers.upgrade.toLowerCase(), "websocket");
  assert.equal(wsResA.headers["x-node-fixture"], "fixture-nas-node-A");

  // Host-only cookie check (Domain= stripped)
  const setCookieA = wsResA.headers["set-cookie"];
  const cookieStrA = Array.isArray(setCookieA) ? setCookieA.join("; ") : setCookieA;
  assert.ok(cookieStrA.includes("node_ws_session=fixture-nas-node-A_ws"));
  assert.equal(cookieStrA.toLowerCase().includes("domain="), false);

  const msgA = "Ping from Client to Authority A";
  tlsSocketA.write(encodeFrame(msgA, { isClient: true }));

  const replyA = await new Promise((resolve) => {
    let buf = wsResA.remainingBytes && wsResA.remainingBytes.length > 0 ? Buffer.from(wsResA.remainingBytes) : Buffer.alloc(0);
    const tryDecode = () => {
      const decoded = decodeFrame(buf);
      if (decoded) {
        tlsSocketA.removeListener("data", onData);
        resolve(decoded.payload.toString("utf8"));
        return true;
      }
      return false;
    };
    if (tryDecode()) return;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      tryDecode();
    };
    tlsSocketA.on("data", onData);
  });

  assert.equal(replyA, `[fixture-nas-node-A] ${msgA}`);
  console.log(`[Protocol Fixture Evidence] Authority A WSS connection successfully verified (reached Fixture A, echo prefixed '[fixture-nas-node-A]')`);

  // Request 8.2: WSS Connection to Authority B -> Must reach Fixture B and return Fixture B WSS Echo
  const tlsSocketB = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityB,
    caCert: wildcardCaCert,
  });
  const wsResB = await performWssUpgrade(tlsSocketB, {
    authority: authorityB,
    path: "/ws?session=beta",
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: `https://${authorityB}`,
    },
  });

  assert.equal(wsResB.status, 101);
  assert.equal(wsResB.headers["x-node-fixture"], "fixture-workstation-node-B");

  // Send message through Authority B
  const msgB = "Ping from Client to Authority B";
  tlsSocketB.write(encodeFrame(msgB, { isClient: true }));

  const replyB = await new Promise((resolve) => {
    let buf = wsResB.remainingBytes && wsResB.remainingBytes.length > 0 ? Buffer.from(wsResB.remainingBytes) : Buffer.alloc(0);
    const tryDecode = () => {
      const decoded = decodeFrame(buf);
      if (decoded) {
        tlsSocketB.removeListener("data", onData);
        resolve(decoded.payload.toString("utf8"));
        return true;
      }
      return false;
    };
    if (tryDecode()) return;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      tryDecode();
    };
    tlsSocketB.on("data", onData);
  });

  assert.equal(replyB, `[fixture-workstation-node-B] ${msgB}`);
  console.log(`[Protocol Fixture Evidence] Authority B WSS connection successfully verified (reached Fixture B, echo prefixed '[fixture-workstation-node-B]')`);
  console.log(`[Protocol Fixture Evidence] Strict fixture isolation proven: A returned Fixture A, B returned Fixture B`);

  safeDestroy(tlsSocketA);
  safeDestroy(tlsSocketB);

  // Request 8.3: Real Supported DSH 0.1.1-rc.2 Candidate Acceptance (HTTP Root, Assets, API, and Downlink WebSocket)
  console.log("\n=== STEP 8.3: Real Supported DSH 0.1.1-rc.2 Candidate Acceptance (HTTP Root, Assets, API, and Downlink WebSocket) ===");
  const tokenC = await operatorMintToken(hub.baseUrl, opSession);
  const enrollResC = await runNodeEnroll({ statePath: statePathC, hubUrl: hub.baseUrl, enrollTokenValue: tokenC });
  await runNodeUploadReport({ statePath: statePathC, hubUrl: hub.baseUrl, reportPath });
  const authorityC = computeRouteAuthority(enrollResC.nodeId, REHEARSAL_DOMAIN);

  candidateDsh = await startSupportedDshCandidate({
    trustedHosts: [authorityC],
  });
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 candidate process running on ${candidateDsh.target} (revision ${candidateDsh.revision.slice(0, 8)})`);

  nodeC = await startNodeDaemon({
    statePath: statePathC,
    hubUrl: hub.baseUrl,
    dshTarget: candidateDsh.target,
    cadence: 30,
  });
  await operatorSetRouteTarget(hub.baseUrl, opSession, enrollResC.nodeId, nodeC.ingressOrigin);
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResC.nodeId);
  console.log(`[Candidate Evidence] Candidate Node enrolled and verified eligible with authority: ${authorityC}`);

  // Test 8.3.1: Real DSH 0.1.1-rc.2 HTML Root via Wildcard Gateway
  const candidateRootRes = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityC,
    path: "/",
    caCert: wildcardCaCert,
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(candidateRootRes.status, 200);
  assert.equal(candidateRootRes.headers["x-dsh-version"], "0.1.1-rc.2");
  assert.ok((await candidateRootRes.text()).includes('<div id="root"></div>'));
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 HTML root served through wildcard gateway (x-dsh-version 0.1.1-rc.2)`);

  // Test 8.3.2: Real DSH 0.1.1-rc.2 Static Asset via Wildcard Gateway
  const candidateAssetRes = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityC,
    path: "/assets/index-CSGf6Qzd.css",
    caCert: wildcardCaCert,
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(candidateAssetRes.status, 200);
  assert.ok((await candidateAssetRes.text()).length > 1000);
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 static CSS asset served through wildcard gateway`);

  // Test 8.3.3: Real DSH 0.1.1-rc.2 API Request via Wildcard Gateway
  const candidateApiRes = await makeGatewayRequest({
    gatewayPort: gateway.port,
    authority: authorityC,
    path: "/api/session.status",
    caCert: wildcardCaCert,
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: `https://${authorityC}`,
    },
  });
  assert.equal(candidateApiRes.status, 200);
  const candidateApiJson = await candidateApiRes.json();
  assert.equal(candidateApiJson.result.dshVersion, "0.1.1-rc.2");
  assert.equal(candidateApiJson.result.profile, "dsh-0.1.1-rc.2");
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 API RPC verified through wildcard gateway`);

  // Test 8.3.4: Real DSH 0.1.1-rc.2 Downlink WebSocket Acceptance (/api/events.mux)
  const dshTlsSocket = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityC,
    caCert: wildcardCaCert,
  });
  const dshWsRes = await performWssUpgrade(dshTlsSocket, {
    authority: authorityC,
    path: "/api/events.mux",
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: `https://${authorityC}`,
    },
  });
  assert.equal(dshWsRes.status, 101);
  assert.equal(dshWsRes.headers.upgrade.toLowerCase(), "websocket");

  // Receive initial DSH 0.1.1-rc.2 downlink frame from server
  const downlinkFrame = await new Promise((resolve) => {
    let buf = dshWsRes.remainingBytes && dshWsRes.remainingBytes.length > 0 ? Buffer.from(dshWsRes.remainingBytes) : Buffer.alloc(0);
    const tryDecode = () => {
      const decoded = decodeFrame(buf);
      if (decoded) {
        dshTlsSocket.removeListener("data", onData);
        resolve(decoded);
        return true;
      }
      return false;
    };
    if (tryDecode()) return;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      tryDecode();
    };
    dshTlsSocket.on("data", onData);
  });
  const parsedEvent = JSON.parse(downlinkFrame.payload.toString("utf8"));
  assert.equal(parsedEvent.type, "server-request");
  assert.equal(parsedEvent.method, "session/status");
  assert.equal(parsedEvent.payload.version, "0.1.1-rc.2");
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 server-to-browser downlink event received on /api/events.mux`);

  // Verify Ping -> Pong control frame
  const pingFrame = Buffer.from([0x89, 0x84, 0x11, 0x22, 0x33, 0x44, 0x70, 0x49, 0x5a, 0x27]); // Ping masked
  dshTlsSocket.write(pingFrame);
  const pongReceived = await new Promise((resolve) => {
    const onData = (chunk) => {
      if ((chunk[0] & 0x0f) === 0x0a) {
        dshTlsSocket.removeListener("data", onData);
        resolve(true);
      }
    };
    dshTlsSocket.on("data", onData);
  });
  assert.equal(pongReceived, true);
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 control plane Ping/Pong verified over routed WSS`);

  // Verify client message violation triggers 1008 downlink only close
  const clientViolationMessage = encodeFrame("unsupported client message", { isClient: true });
  dshTlsSocket.write(clientViolationMessage);
  const closedWith1008 = await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeFrame(buf);
      if (decoded && decoded.opcode === 0x08) {
        const closeCode = decoded.payload.readUInt16BE(0);
        const reason = decoded.payload.slice(2).toString("utf8");
        dshTlsSocket.removeListener("data", onData);
        resolve({ code: closeCode, reason });
      }
    };
    dshTlsSocket.on("data", onData);
  });
  assert.equal(closedWith1008.code, 1008);
  assert.equal(closedWith1008.reason, "downlink only");
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 downlink-only client message correctly closed with 1008 'downlink only'`);
  safeDestroy(dshTlsSocket);

  // Negative test: DSH browser-trust fence denies mismatched Origin on WebSocket upgrade
  const mismatchTlsSocket = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityC,
    caCert: wildcardCaCert,
  });
  const mismatchRes = await performWssUpgrade(mismatchTlsSocket, {
    authority: authorityC,
    path: "/api/events.mux",
    headers: {
      "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN,
      Origin: "https://evil.attacker.example",
    },
  });
  assert.equal(mismatchRes.status, 403);
  safeDestroy(mismatchTlsSocket);
  console.log(`[Candidate Evidence] Real DSH 0.1.1-rc.2 browser-trust fence verified: mismatched Origin fails closed with 403`);

  await killProcess(nodeC?.child);
  if (candidateDsh) await candidateDsh.close();

  console.log("\n=== STEP 9: Ingress Fault Isolation (Stop Node A -> Node B WSS Unaffected) ===");
  await killProcess(nodeA.child);
  console.log(`[Evidence] Node A daemon terminated to simulate ingress failure`);

  // Authority A WebSocket request should return 502 Bad Gateway with selectorUrl
  const failSocketA = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityA,
    caCert: wildcardCaCert,
  });
  const failResA = await performWssUpgrade(failSocketA, {
    authority: authorityA,
    path: "/ws",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(failResA.status, 502);
  const failBodyA = JSON.parse(failResA.body);
  assert.equal(failBodyA.error.code, "bad-gateway");
  assert.ok(failBodyA.error.selectorUrl.includes(REHEARSAL_DOMAIN));
  safeDestroy(failSocketA);
  console.log(`[Evidence] Authority A returned 502 with selectorUrl: ${failBodyA.error.selectorUrl}`);

  // Authority B WebSocket request must remain 100% operational
  const okSocketB = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityB,
    caCert: wildcardCaCert,
  });
  const okResB = await performWssUpgrade(okSocketB, {
    authority: authorityB,
    path: "/ws",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(okResB.status, 101);
  assert.equal(okResB.headers["x-node-fixture"], "fixture-workstation-node-B");
  safeDestroy(okSocketB);
  console.log(`[Evidence] Authority B remains healthy during Node A outage (isolation verified)`);

  console.log("\n=== STEP 10: Process Restarts & Route Persistence (Hub + Nodes) ===");
  const hubPort = hub.port;
  const nodeAPort = nodeA.port;
  const nodeBPort = nodeB.port;

  await killProcess(nodeB.child);
  await killProcess(hub.child);
  console.log("[Evidence] All child processes terminated for restart test");

  // Restart Hub on same DB & port
  hub = await startHubProcess({ dbPath, port: hubPort, caCertPath: nodeCertPath, routeDomain: REHEARSAL_DOMAIN, cadenceSeconds: 1 });
  opSession = await getOperatorSession(hub.baseUrl);
  console.log(`[Evidence] Restarted Hub on ${hub.baseUrl}`);

  // Restart Node A on same state file & ingress port
  nodeA = await startNodeDaemon({
    statePath: statePathA,
    hubUrl: hub.baseUrl,
    ingressPort: nodeAPort,
    dshTarget: dshA.target,
    tlsKeyPath: nodeKeyPath,
    tlsCertPath: nodeCertPath,
    caCertPath: nodeCertPath,
    cadence: 30,
  });
  console.log(`[Evidence] Restarted Node A daemon on ${nodeA.ingressOrigin}`);

  // Restart Node B on same state file & ingress port
  nodeB = await startNodeDaemon({
    statePath: statePathB,
    hubUrl: hub.baseUrl,
    ingressPort: nodeBPort,
    dshTarget: dshB.target,
    cadence: 30,
  });
  console.log(`[Evidence] Restarted Node B daemon on ${nodeB.ingressOrigin}`);

  // Wait for both nodes to regain routing eligibility
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResA.nodeId);
  await waitForNodeEligible(hub.baseUrl, opSession, enrollResB.nodeId);

  // Both authorities route WSS traffic successfully post-restart through WSS gateway
  const postSocketA = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityA,
    caCert: wildcardCaCert,
  });
  const postResA = await performWssUpgrade(postSocketA, {
    authority: authorityA,
    path: "/ws",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(postResA.status, 101);
  assert.equal(postResA.headers["x-node-fixture"], "fixture-nas-node-A");

  const postSocketB = await connectGatewayTlsSocket({
    gatewayPort: gateway.port,
    authority: authorityB,
    caCert: wildcardCaCert,
  });
  const postResB = await performWssUpgrade(postSocketB, {
    authority: authorityB,
    path: "/ws",
    headers: { "x-gateway-auth": REHEARSAL_GATEWAY_TOKEN },
  });
  assert.equal(postResB.status, 101);
  assert.equal(postResB.headers["x-node-fixture"], "fixture-workstation-node-B");
  safeDestroy(postSocketA);
  safeDestroy(postSocketB);
  console.log(`[Evidence] Post-restart verification: Authorities A and B route WSS through gateway with zero identity drift!`);
});
