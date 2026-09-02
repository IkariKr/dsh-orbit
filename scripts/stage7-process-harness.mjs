import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HUB_SCRIPT = fileURLToPath(new URL("../bin/dsh-orbit-hub.mjs", import.meta.url));
const NODE_SCRIPT = fileURLToPath(new URL("../bin/dsh-orbit-node.mjs", import.meta.url));

function timeoutPromise(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function spawnCaptured(script, args, { env = {}, cwd = REPO_ROOT } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  async function waitFor(pattern, timeoutMs = 15_000) {
    const matcher = typeof pattern === "function" ? pattern : (text) => pattern.test(text);
    if (matcher(stdout)) return stdout;
    return timeoutPromise(
      new Promise((resolve) => {
        const check = () => {
          if (matcher(stdout)) {
            child.stdout.off("data", check);
            resolve(stdout);
          }
        };
        child.stdout.on("data", check);
        closed.then(() => {
          child.stdout.off("data", check);
          if (matcher(stdout)) resolve(stdout);
        });
      }),
      timeoutMs,
      `child process timed out waiting for output; stdout=${stdout} stderr=${stderr}`,
    );
  }
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    closed,
    waitFor,
  };
}

export async function stopCaptured(processHandle, { force = false, timeoutMs = 5_000 } = {}) {
  const { child, closed } = processHandle;
  if (child.exitCode !== null || child.signalCode !== null) return closed;
  if (process.platform === "win32" && force) {
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]).catch(() => {});
  } else {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
  try {
    return await timeoutPromise(closed, timeoutMs, `child process ${child.pid} did not close`);
  } catch (error) {
    if (!force) return stopCaptured(processHandle, { force: true, timeoutMs });
    throw error;
  }
}

export async function startHubProcess({ dbPath, agingClockPath = null, port = "0" } = {}) {
  const env = {
    DSH_ORBIT_HUB_DB: dbPath,
    DSH_ORBIT_HUB_PORT: String(port),
    DSH_ORBIT_HUB_LISTEN: "127.0.0.1",
    DSH_ORBIT_HUB_GATEWAY_SECRET: "stage7-gateway-secret",
    DSH_ORBIT_HUB_OPERATOR_PRINCIPAL: "operator",
  };
  if (agingClockPath !== null) {
    env.DSH_ORBIT_HUB_DRILL_AGING = "1";
    env.DSH_ORBIT_HUB_DRILL_AGING_CLOCK = agingClockPath;
  }
  const processHandle = spawnCaptured(HUB_SCRIPT, [], { env });
  const output = await processHandle.waitFor(/registry listening on http:\/\/127\.0\.0\.1:(\d+)/, 15_000);
  const match = output.match(/registry listening on http:\/\/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`Hub readiness output did not include a port: ${output}`);
  return { ...processHandle, port: Number(match[1]), baseUrl: `http://127.0.0.1:${match[1]}/` };
}

export function createSwitchingProxy() {
  let target = null;
  let armed = null;
  const held = new Set();
  const server = createServer((incoming, outgoing) => {
    const selected = target;
    if (selected === null) {
      incoming.resume();
      outgoing.writeHead(502, { "content-type": "application/json", "content-length": "19" });
      outgoing.end('{"error":"upstream"}');
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: selected.port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        const gate = armed !== null && incoming.method === "POST" && incoming.url === armed.path ? armed : null;
        if (gate === null) {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
          return;
        }
        armed = null;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          held.add(outgoing);
          outgoing.once("close", () => held.delete(outgoing));
          gate.resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
        response.on("error", gate.reject);
      },
    );
    upstream.on("error", () => {
      if (armed !== null && incoming.url === armed.path) {
        const gate = armed;
        armed = null;
        gate.reject(new Error(`proxy upstream failed for ${incoming.url}`));
      }
      outgoing.destroy();
    });
    incoming.pipe(upstream);
  });
  const listening = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    async ready() {
      await listening;
      return this;
    },
    get port() {
      return server.address().port;
    },
    get baseUrl() {
      return `http://127.0.0.1:${server.address().port}/`;
    },
    setTarget(next) {
      target = next;
    },
    arm(path) {
      if (armed !== null) throw new Error(`proxy already has an armed response for ${armed.path}`);
      let resolve;
      let reject;
      const committed = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      armed = { path, resolve, reject };
      return committed;
    },
    releaseHeld() {
      for (const response of held) response.destroy();
      held.clear();
    },
    async close() {
      this.releaseHeld();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function nodeEnvironment({ statePath, hubUrl, extra = {} }) {
  return {
    DSH_ORBIT_NODE_STATE: statePath,
    DSH_ORBIT_HUB_URL: hubUrl,
    DSH_ORBIT_NODE_HEARTBEAT_SECONDS: "30",
    DSH_ORBIT_NODE_ORBIT_VERSION: "0.3.0",
    DSH_ORBIT_NODE_ORBIT_REVISION: "stage7-process",
    DSH_ORBIT_NODE_DSH_VERSION: "0.1.1-rc.2",
    DSH_ORBIT_NODE_DSH_PROFILE: "dsh-0.1.1-rc.2",
    ...extra,
  };
}

export function spawnNode(args, env) {
  return spawnCaptured(NODE_SCRIPT, args, { env });
}
