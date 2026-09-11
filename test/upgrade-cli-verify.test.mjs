import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GATEWAY_CERT_PEM, GATEWAY_KEY_PEM } from "./fixtures/gateway-identity.mjs";
import { createPatchedFenceModule, FENCE_PUBLIC_HOST } from "./helpers/ssh-fence-fixture.mjs";
import {
  COMPATIBILITY_OUTCOMES,
  PROMOTION_OUTCOMES,
} from "../src/compatibility-report.mjs";
import { runVerifyWorkflow } from "../src/upgrade-runner.mjs";

const BIN = fileURLToPath(new URL("../bin/dsh-orbit-upgrade.mjs", import.meta.url));
const PLUGIN_ASSET = "/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=abc123";
const ORBIT_REVISION = "832301fddcbb8b1f4bec88c90534a572a4420515";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-verify-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixtureConfig(workdir, port, overrides = {}) {
  return {
    dshVersion: "0.1.1-rc.2",
    orbitRevision: ORBIT_REVISION,
    orbitVersion: "0.2.0-snapshot",
    baselineImage: "dsh-orbit:0.1.1-rc.2-production.4",
    baselineOrbitRevision: "1e835dd3f45b95c57340a0285988c9c5dceadc7d",
    baselineDshVersion: "0.1.1-rc.2",
    candidateImage: "dsh-orbit:0.1.1-rc.2",
    candidateDataRoot: join(workdir, "candidate-data"),
    candidateWorkspaceRoot: join(workdir, "candidate-workspace"),
    candidateHostPort: port,
    productionDataRoot: join(workdir, "production-data"),
    candidateEndpoint: `https://127.0.0.1:${port}`,
    publicHost: "dsh.example.com",
    basicUser: "admin",
    basicPassword: "orbit-verify-value",
    smokeOrigin: null,
    sessionId: "session-historical",
    sshPatchEnabled: true,
    snapshotHook: "/opt/dsh-orbit/hooks/snapshot.sh",
    snapshotTimeoutSeconds: 900,
    gatewayService: "caddy",
    gatewayCertTarget: "/run/certs/fullchain.pem",
    gatewayKeyTarget: "/run/certs/privkey.pem",
    project: "dsh-orbit-candidate",
    composeFile: join(workdir, "compose.candidate.yaml"),
    workdir,
    ...overrides,
  };
}

function resolvedCompose(config, merged) {
  const gatewayVolumes = [
    { source: "/srv/certs/fullchain.pem", target: config.gatewayCertTarget },
    { source: "/srv/certs/privkey.pem", target: config.gatewayKeyTarget },
  ];
  if (merged) {
    gatewayVolumes[0].source = `${config.workdir}/gateway-identity-cert.pem`;
    gatewayVolumes[1].source = `${config.workdir}/gateway-identity-key.pem`;
  }
  return {
    name: config.project,
    services: {
      dsh: merged
        ? {
            image: config.candidateImage,
            user: "10001:10001",
            volumes: [
              { source: config.candidateDataRoot, target: "/data" },
              { source: config.candidateWorkspaceRoot, target: "/workspace" },
            ],
            ports: [{ target: 9443, published: String(config.candidateHostPort), host_ip: "127.0.0.1" }],
            environment: { DSH_ORBIT_CANDIDATE_TOKEN: "abc123def4567890" },
          }
        : { image: config.candidateImage, volumes: [], ports: [], environment: {} },
      [config.gatewayService]: { user: "1000:1000", volumes: gatewayVolumes },
    },
  };
}

function respond(res, rpcId, result, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

// Local HTTPS gateway stand-in presenting the per-run self-signed certificate.
// Without the per-run CA propagation under test, every TLS client here fails.
async function startGateway(config, fence, fenceSecret) {
  const server = https.createServer(
    { cert: GATEWAY_CERT_PEM, key: GATEWAY_KEY_PEM },
    async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/plugins/"))) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body><script src="${PLUGIN_ASSET}"></script></body></html>`);
        return;
      }
      if (req.method !== "POST" && req.method !== "GET") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const expectedAuthorization = `Basic ${Buffer.from(`${config.basicUser}:${config.basicPassword}`).toString("base64")}`;
      if (req.url?.startsWith("/api/dsh-ssh/terminal")) {
        if (req.headers.authorization !== expectedAuthorization) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        // gateway simulation: rewrite the authority, inject the internal
        // proxy secret, then let the patched terminal fence decide
        const fenceRequest = {
          headers: {
            host: FENCE_PUBLIC_HOST,
            "x-forwarded-proto": "https",
            "x-dsh-orbit-authenticated-proxy": fenceSecret,
            "sec-fetch-site": req.headers["sec-fetch-site"],
            origin: req.headers.origin,
          },
        };
        if (fence.isDshOrbitAuthenticatedProxyRequest(fenceRequest)) {
          res.writeHead(101, { connection: "upgrade", upgrade: "websocket" });
          res.end();
          return;
        }
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden: loopback-only or untrusted proxy" }));
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/api/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const body = await readBody(req);
      if (req.headers.authorization !== expectedAuthorization) {
        respond(res, body.rpcId, { ok: false, error: { code: "E", message: "unauthorized" } }, 401);
        return;
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        respond(res, body.rpcId, { ok: false, error: { code: "E", message: "cross-site" } }, 403);
        return;
      }
      const expectedOrigin = `https://${FENCE_PUBLIC_HOST}`;
      if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
        respond(res, body.rpcId, { ok: false, error: { code: "E", message: "origin" } }, 403);
        return;
      }
      if (body.method === "settings.describe") {
        respond(res, body.rpcId, {
          ok: true,
          value: {
            writable: true,
            namespaces: [{ ns: "agent-default-model", revision: "r1" }],
          },
        });
        return;
      }
      if (body.method === "session.models") {
        respond(res, body.rpcId, {
          ok: true,
          value: { current: { provider: "gateway", model: "orbit-test-model" } },
        });
        return;
      }
      respond(res, body.rpcId, { ok: true, value: {} });
    },
  );
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/dsh-ssh/terminal")) {
      const expectedAuthorization = `Basic ${Buffer.from(`${config.basicUser}:${config.basicPassword}`).toString("base64")}`;
      if (req.headers.authorization !== expectedAuthorization) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"unauthorized\"}");
        socket.destroy();
        return;
      }
      const fenceRequest = {
        headers: {
          host: FENCE_PUBLIC_HOST,
          "x-forwarded-proto": "https",
          "x-dsh-orbit-authenticated-proxy": fenceSecret,
          "sec-fetch-site": req.headers["sec-fetch-site"],
          origin: req.headers.origin,
        },
      };
      if (!fence.isDshOrbitAuthenticatedProxyRequest(fenceRequest)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"forbidden\"}");
        socket.destroy();
        return;
      }
    }
    const key = req.headers["sec-websocket-key"] || "";
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (chunk) => {
      // If client sent Ping frame (opcode 0x09), reply Pong (opcode 0x0a) with matching payload (RFC 6455)
      const opcode = chunk[0] & 0x0f;
      if (opcode === 0x09) {
        const payloadLen = chunk[1] & 0x7f;
        let payload = Buffer.alloc(0);
        if (chunk[1] & 0x80) {
          const mask = chunk.slice(2, 6);
          payload = Buffer.alloc(payloadLen);
          for (let i = 0; i < payloadLen; i++) payload[i] = chunk[6 + i] ^ mask[i % 4];
        } else {
          payload = chunk.slice(2, 2 + payloadLen);
        }
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      } else {
        socket.write(chunk);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  return new Promise((resolve) => server.once("listening", () => resolve({ server, port: server.address().port })));
}

function fakeRunCommand(config, events) {
  return async (file, args, options = {}) => {
    if (file === process.execPath && args[0]?.includes("smoke-")) {
      const name = args[0].split(/[\/]/).pop().replace(".mjs", "");
      events.push(`command:${name}`);
      const { spawn } = await import("node:child_process");
      const child = spawn(file, args, {
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve) => child.once("close", resolve));
      return { code, stdout, stderr };
    }
    if (file === "docker") {
      if (args.includes("config")) {
        const merged = args.includes(`${config.workdir}/compose.override.yaml`);
        events.push(merged ? "command:config" : "command:config-base");
        return { code: 0, stdout: JSON.stringify(resolvedCompose(config, merged)), stderr: "" };
      }
      if (args.includes("printenv")) {
        events.push("command:token");
        const override = await readFile(`${config.workdir}/compose.override.yaml`, "utf8");
        const candidateToken = override.match(/DSH_ORBIT_CANDIDATE_TOKEN: "?([0-9a-f]+)"?/)[1];
        return { code: 0, stdout: `${candidateToken}\n`, stderr: "" };
      }
      if (args.includes("--check")) {
        events.push("command:patch");
        return {
          code: 0,
          stdout:
            "DSH upstream: 0.1.1-rc.2\n/srv/global/lib: ok/ok\n/srv/profile/lib: ok\n",
          stderr: "",
        };
      }
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
}

test("verify propagates the per-run CA to the runner checks and the smoke suites", async () => {
  await withTempDir(async (baseDir) => {
    const workdir = join(baseDir, "run");
    await mkdir(workdir, { recursive: true });
    for (const dir of ["candidate-data", "candidate-workspace", "production-data"]) {
      await mkdir(join(workdir, dir), { recursive: true });
    }
    const { fence, fenceSecret } = await (async () => {
      const created = await createPatchedFenceModule(workdir);
      return { fence: await import(created.moduleUrl), fenceSecret: created.secret };
    })();
    const { server, port } = await startGateway(fixtureConfig(workdir, 0), fence, fenceSecret);
    try {
      const config = fixtureConfig(workdir, port, { smokeOrigin: `https://${FENCE_PUBLIC_HOST}` });
      await writeFile(
        `${workdir}/compose.override.yaml`,
        `services:\n  dsh:\n    environment:\n      DSH_ORBIT_CANDIDATE_TOKEN: "abc123def4567890"\n`,
        "utf8",
      );
      await writeFile(`${workdir}/gateway-identity-cert.pem`, GATEWAY_CERT_PEM, "utf8");

      const events = [];
      const result = await runVerifyWorkflow({
        config,
        runCommand: fakeRunCommand(config, events),
      });

      assert.equal(result.compatible, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.banner, "VERIFICATION PASSED - PROMOTION READINESS NOT EVALUATED");
      assert.equal(result.report.promotionReadiness.outcome, PROMOTION_OUTCOMES.notEvaluated);
      assert.equal(result.report.compatibility.outcome, COMPATIBILITY_OUTCOMES.pass);
      assert.match(
        result.report.checks.runtimeReadiness.detail,
        /GET \/ with authenticated gateway headers -> HTTP 200/,
      );
      assert.match(result.report.checks.authorizationSmoke.detail, /6\/6 authorization cases matched/);
      assert.equal(result.report.checks.terminalFence.status, "pass");
      assert.equal(result.report.checks.terminalPtty.status, "not_run");
      assert.match(result.report.checks.sessionResume.detail, /existing session resumed/);
      assert.equal(events.includes("command:config-base"), true);
      assert.equal(events.includes("command:config"), true);
    } finally {
      server.close();
    }
  });
});

test("verify rejects a root gateway even when the candidate run already exists", async () => {
  await withTempDir(async (baseDir) => {
    const workdir = join(baseDir, "run");
    await mkdir(workdir, { recursive: true });
    for (const dir of ["candidate-data", "candidate-workspace", "production-data"]) {
      await mkdir(join(workdir, dir), { recursive: true });
    }
    const config = fixtureConfig(workdir, 18444);
    await writeFile(
      `${workdir}/compose.override.yaml`,
      `services:\n  dsh:\n    environment:\n      DSH_ORBIT_CANDIDATE_TOKEN: "abc123def4567890"\n`,
      "utf8",
    );
    await writeFile(`${workdir}/gateway-identity-cert.pem`, GATEWAY_CERT_PEM, "utf8");
    await writeFile(`${workdir}/gateway-identity-key.pem`, GATEWAY_KEY_PEM, "utf8");
    const runCommand = async (file, args) => {
      if (file === "docker" && args.includes("config")) {
        const merged = args.includes(`${workdir}/compose.override.yaml`);
        const resolved = resolvedCompose(config, merged);
        if (merged) resolved.services.caddy.user = "00:1000";
        return { code: 0, stdout: JSON.stringify(resolved), stderr: "" };
      }
      if (file === "docker" && args.includes("printenv")) return { code: 0, stdout: "abc123def4567890\n", stderr: "" };
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    };
    await assert.rejects(
      runVerifyWorkflow({ config, runCommand }),
      (error) => /caddy service must use an explicit non-root uid:gid/.test(error.message),
    );
  });
});

test("verify fails closed without a prior candidate run in the workdir", async () => {
  await withTempDir(async (baseDir) => {
    const workdir = join(baseDir, "run");
    await mkdir(workdir, { recursive: true });
    for (const dir of ["candidate-data", "candidate-workspace", "production-data"]) {
      await mkdir(join(workdir, dir), { recursive: true });
    }
    const config = fixtureConfig(workdir, 18444);

    await assert.rejects(
      runVerifyWorkflow({ config, runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }) }),
      (error) => /no candidate override found/.test(error.message),
    );
  });
});

test("verify preflight failures name the blocking configuration", async () => {
  await withTempDir(async (baseDir) => {
    const workdir = join(baseDir, "run");
    await mkdir(join(workdir), { recursive: true });
    for (const dir of ["candidate-data", "candidate-workspace", "production-data"]) {
      await mkdir(join(workdir, dir), { recursive: true });
    }
    const config = fixtureConfig(workdir, 18444, { dshVersion: "9.9.9-future" });

    await assert.rejects(
      runVerifyWorkflow({ config, runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }) }),
      (error) => /compatibility-profile/.test(error.message),
    );
  });
});

test("the verify CLI reports promotion readiness as not evaluated", async () => {
  await withTempDir(async (baseDir) => {
    const workdir = join(baseDir, "run");
    await mkdir(workdir, { recursive: true });
    for (const dir of ["candidate-data", "candidate-workspace", "production-data"]) {
      await mkdir(join(workdir, dir), { recursive: true });
    }
    // an empty workdir: the CLI fails closed with exit code 2 before any check
    const env = {
      ...process.env,
      DSH_VERSION: "0.1.1-rc.2",
      DSH_PUBLIC_HOST: "dsh.example.com",
      DSH_CANDIDATE_ORBIT_REVISION: ORBIT_REVISION,
      DSH_BASELINE_IMAGE: "dsh-orbit:0.1.1-rc.2-production.4",
      DSH_BASELINE_ORBIT_REVISION: "1e835dd3f45b95c57340a0285988c9c5dceadc7d",
      DSH_BASELINE_DSH_VERSION: "0.1.1-rc.2",
      DSH_CANDIDATE_IMAGE: "dsh-orbit:0.1.1-rc.2",
      DSH_CANDIDATE_DATA_ROOT: join(workdir, "candidate-data"),
      DSH_CANDIDATE_WORKSPACE_ROOT: join(workdir, "candidate-workspace"),
      DSH_UPGRADE_HOST_PORT: "18444",
      DSH_DATA_ROOT: join(workdir, "production-data"),
      DSH_SMOKE_URL: "https://127.0.0.1:18444",
      DSH_SMOKE_BASIC_USER: "admin",
      DSH_SMOKE_BASIC_PASSWORD: "orbit-verify-value",
      DSH_SMOKE_SESSION_ID: "session-historical",
      DSH_SNAPSHOT_HOOK: "/opt/dsh-orbit/hooks/snapshot.sh",
      DSH_UPGRADE_WORKDIR: workdir,
    };
    const child = spawn(process.execPath, [BIN, "verify"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");
    assert.equal(code, 2);
    assert.match(stderr, /no candidate override found/);
  });
});
