// Stage 9 Smoke Qualification: the canonical E9 smokes against the real
// DeepSeek Harness 0.1.5-rc.2 process for the connection-browser-auth-v1
// generation.
//
// Where the bundle integration and process acceptance tests prove the patch
// semantics themselves, this acceptance proves the *production tooling* end to
// end: the four canonical smoke suites (scripts/smoke-*.mjs) run unmodified
// through a stand-in for the deployed admission chain — gateway Basic Auth +
// the node-local DSH compatibility adapter (RFC-0003/RFC-0010) — against the
// real patched `dsh web` process, and every suite must emit its stable
// Orbit-owned result line.
//
// Set DSH_015_ACCEPTANCE_ROOT to a built DSH 0.1.5-rc.2 checkout to run it;
// the acceptance patches the checkout's built connection bundle and restores it
// byte-for-byte in teardown (pinned digests re-verified), so no tracked file
// and no reviewed build artifact is modified.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchConnectionRootForGeneration, verifyConnectionRoot } from "../src/remote-settings-patch.mjs";
import { createCompatAdapterEmulator } from "./helpers/compat-adapter-emulator.mjs";
import {
  acquireDsh015AcceptanceLock,
  assertBuildArtifacts,
  assertDsh015Identity,
  assertPristineBundle,
  assertProfileLinksToBuiltBundle,
  builtConnectionRoot,
  readBundleBytes,
  releaseDsh015AcceptanceLock,
  resolveDsh015Checkout,
  restoreBundleBytes,
  startDshWeb,
} from "./helpers/dsh-015-acceptance-fixture.mjs";

const PUBLIC_HOST = "dsh.example.com";
const PROXY_SECRET = "test-orbit-proxy-secret";
const BASIC_USER = "orbit-qual";
const BASIC_PASSWORD = "test-orbit-qualification-password";
const GENERATION = "connection-browser-auth-v1";
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const dshRoot = resolveDsh015Checkout();
let session = null;

before(async () => {
  if (!dshRoot) return;
  const lockPath = await acquireDsh015AcceptanceLock(dshRoot);
  let boot = null;
  let pristine = null;
  let bundleDir = null;
  let emulator = null;
  let dshHome = null;
  try {
    const identity = assertDsh015Identity(dshRoot);

    dshHome = await mkdtemp(join(tmpdir(), "orbit-smoke-qual-home-"));
    const proxyAuthFile = join(dshHome, "orbit-proxy-secret");
    await writeFile(proxyAuthFile, PROXY_SECRET, "utf8");

    boot = await startDshWeb({ dshRoot, dshHome, trustedHosts: [PUBLIC_HOST] });
    await boot.stop();
    bundleDir = assertProfileLinksToBuiltBundle(dshHome, dshRoot);
    assertPristineBundle(bundleDir);
    pristine = readBundleBytes(bundleDir);

    const patch = await patchConnectionRootForGeneration({
      root: bundleDir,
      connectionPatch: GENERATION,
      publicHost: PUBLIC_HOST,
      proxyAuthFile,
    });
    assert.equal(patch.server, "patched");
    assert.equal(patch.client, "patched");
    await verifyConnectionRoot({
      root: bundleDir,
      publicHost: PUBLIC_HOST,
      proxyAuthFile,
      connectionPatch: GENERATION,
    });

    boot = await startDshWeb({ dshRoot, dshHome, trustedHosts: [PUBLIC_HOST] });
    emulator = createCompatAdapterEmulator({
      dshPort: boot.port,
      publicHost: PUBLIC_HOST,
      proxySecret: PROXY_SECRET,
      basicUser: BASIC_USER,
      basicPassword: BASIC_PASSWORD,
    });
    const emulatorPort = await emulator.listen();

    session = {
      ...identity,
      dshRoot,
      dshHome,
      bundleDir,
      pristine,
      boot,
      emulator,
      lockPath,
      endpoint: `http://127.0.0.1:${emulatorPort}`,
    };
  } catch (error) {
    // Best-effort teardown: a failed identity assertion must not leave the
    // acceptance environment patched or the lock held.
    await boot?.stop();
    await emulator?.close();
    if (bundleDir && pristine) {
      try {
        restoreBundleBytes(bundleDir, pristine);
      } catch {
        // Nothing further to do; the digest gate will catch a bad restore.
      }
    }
    if (dshHome) await rm(dshHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    // The lock is held only while the acceptance owns the bundle; on success
    // `after` releases it, on any failure it is released here unconditionally.
    if (!session) releaseDsh015AcceptanceLock(lockPath);
  }
});

after(async () => {
  if (!session) return;
  try {
    await session.boot.stop();
    await session.emulator.close();
    restoreBundleBytes(session.bundleDir, session.pristine);
    assertPristineBundle(session.bundleDir);
    assertBuildArtifacts(session.dshRoot);
    await rm(session.dshHome, { recursive: true, force: true });
  } finally {
    releaseDsh015AcceptanceLock(session.lockPath);
  }
});

function live(t) {
  if (!session) {
    t.skip("DSH_015_ACCEPTANCE_ROOT not configured; skipping the 0.1.5 smoke qualification");
    return null;
  }
  return session;
}

function runSmoke(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      env: {
        ...env,
        DSH_SMOKE_URL: session.endpoint,
        DSH_SMOKE_ORIGIN: `https://${PUBLIC_HOST}`,
        DSH_SMOKE_CONNECTION_PATCH: GENERATION,
        DSH_SMOKE_BASIC_USER: BASIC_USER,
        DSH_SMOKE_BASIC_PASSWORD: BASIC_PASSWORD,
        DSH_SMOKE_TIMEOUT_MS: "15000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("smoke-settings proves settingsRead and settingsNoopWrite on the real 0.1.5 process", async (t) => {
  if (!live(t)) return;
  const { code, stdout, stderr } = await runSmoke(fileURLToPath(new URL("../scripts/smoke-settings.mjs", import.meta.url)), {});
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^settingsRead: pass/m);
  assert.match(stdout, /^settingsNoopWrite: pass/m);
});

test("smoke-auth proves the authorization matrix on the real 0.1.5 process", async (t) => {
  if (!live(t)) return;
  const { code, stdout, stderr } = await runSmoke(fileURLToPath(new URL("../scripts/smoke-auth.mjs", import.meta.url)), {});
  assert.equal(code, 0, stderr);
  assert.match(stdout, new RegExp(`^authorizationSmoke: pass \\(${GENERATION}, 6/6 cases matched\\)$`, "m"));
});

function qualifyHeaders() {
  return {
    authorization: `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASSWORD}`).toString("base64")}`,
    origin: `https://${PUBLIC_HOST}`,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

async function createQualificationSession() {
  const created = await fetch(`${session.endpoint}/api/session/create`, {
    method: "POST",
    headers: qualifyHeaders(),
    body: JSON.stringify({
      type: "client-request",
      rpcId: `orbit-qual-session-create-${Date.now()}`,
      method: "session/create",
      payload: { args: { request: {} } },
    }),
  });
  assert.equal(created.status, 200, "the candidate must admit the session create");
  const createdBody = await created.json();
  const sessionId = createdBody?.result?.value?.sessionId;
  assert.ok(typeof sessionId === "string" && sessionId.length > 0, "session/create must return a sessionId");
  return sessionId;
}

test("smoke-session-resume re-selects a seeded recorded selection on a historical session", async (t) => {
  if (!live(t)) return;

  // Create the session through the deployed chain; it stands in for the
  // pre-upgrade session that the E9 evidence run takes from copied production
  // data. The smoke must recover the session's own recorded selection — never
  // the deployment-wide default — so the session is seeded with a known model
  // selection first and the smoke is required to re-select exactly that.
  const sessionId = await createQualificationSession();

  const seed = await fetch(`${session.endpoint}/api/session/modelCatalog`, {
    method: "POST",
    headers: qualifyHeaders(),
    body: JSON.stringify({
      type: "client-request",
      rpcId: "orbit-qual-catalog",
      method: "session/modelCatalog",
      payload: { args: {} },
    }),
  });
  assert.equal(seed.status, 200, "the candidate must admit the model catalog read");
  const catalog = (await seed.json())?.result?.value;
  const seededSelection = catalog?.default;
  assert.ok(seededSelection?.provider && seededSelection?.model, "the catalog must publish a default selection");

  const selected = await fetch(`${session.endpoint}/api/session/selectModel`, {
    method: "POST",
    headers: qualifyHeaders(),
    body: JSON.stringify({
      type: "client-request",
      rpcId: "orbit-qual-seed-selection",
      method: "session/selectModel",
      payload: { args: { request: { sessionId, ...seededSelection } } },
    }),
  });
  assert.equal(selected.status, 200, "seeding the known selection must succeed");

  const { code, stdout, stderr } = await runSmoke(
    fileURLToPath(new URL("../scripts/smoke-session-resume.mjs", import.meta.url)),
    { DSH_SMOKE_SESSION_ID: sessionId },
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /recorded selection: /, "the smoke must recover the session's recorded selection");
  assert.ok(
    !stdout.includes("model catalog default"),
    "the deployment-wide default must never stand in for the recorded selection",
  );
  assert.match(stdout, new RegExp(`recorded selection: ${seededSelection.provider}/${seededSelection.model}`));
  assert.match(stdout, /^sessionResume: pass \(existing session resumed on the candidate\)$/m);
});

test("smoke-session-resume fails a historical session with no recoverable selection", async (t) => {
  if (!live(t)) return;

  // A session without a recorded selection is the failure shape an upgrade or
  // migration produces when it loses session projections. The smoke must fail
  // it rather than launder it through the deployment-wide default.
  const sessionId = await createQualificationSession();
  const { code, stderr } = await runSmoke(
    fileURLToPath(new URL("../scripts/smoke-session-resume.mjs", import.meta.url)),
    { DSH_SMOKE_SESSION_ID: sessionId },
  );
  assert.notEqual(code, 0, "a selection-less historical session must fail the resume smoke");
  assert.match(stderr, /carries no recoverable model selection/);
});

test("smoke-websocket proves the remote.mux open -> ready handshake on the real process", async (t) => {
  if (!live(t)) return;
  const { code, stdout, stderr } = await runSmoke(fileURLToPath(new URL("../scripts/smoke-websocket.mjs", import.meta.url)), {});
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^webSocketTransport: pass/m);
  assert.match(stdout, /\$events open -> item ready/);
});

test("the legacy transport vocabulary fails closed against the BrowserAuth candidate", async (t) => {
  if (!live(t)) return;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/smoke-websocket.mjs", import.meta.url))], {
    cwd: REPO_ROOT,
    env: {
      DSH_SMOKE_URL: session.endpoint,
      DSH_SMOKE_ORIGIN: `https://${PUBLIC_HOST}`,
      DSH_SMOKE_CONNECTION_PATCH: "connection-v1",
      DSH_SMOKE_BASIC_USER: BASIC_USER,
      DSH_SMOKE_BASIC_PASSWORD: BASIC_PASSWORD,
      DSH_SMOKE_TIMEOUT_MS: "15000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await new Promise((resolve) => child.on("close", (c) => resolve([c, ""])));
  assert.notEqual(code, 0, "the legacy downlink vocabulary must not pass on the BrowserAuth generation");
  assert.match(stderr, /webSocketTransport: fail/);
});

test("every smoke fails closed when the generation is missing or unreviewed", async (t) => {
  if (!live(t)) return;
  for (const script of ["smoke-settings", "smoke-auth", "smoke-session-resume", "smoke-websocket"]) {
    for (const generation of ["", "connection-v99"]) {
      const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url))], {
        cwd: REPO_ROOT,
        env: {
          DSH_SMOKE_URL: session.endpoint,
          DSH_SMOKE_ORIGIN: `https://${PUBLIC_HOST}`,
          DSH_SMOKE_CONNECTION_PATCH: generation,
          DSH_SMOKE_BASIC_USER: BASIC_USER,
          DSH_SMOKE_BASIC_PASSWORD: BASIC_PASSWORD,
          DSH_SMOKE_SESSION_ID: "unused",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const [code] = await new Promise((resolve) => child.on("close", (c) => resolve([c, ""])));
      assert.equal(code, 2, `${script} with generation ${JSON.stringify(generation)} must fail closed: ${stderr}`);
      assert.ok(stderr.trim().length > 0, `${script} must explain the failure`);
    }
  }
});
