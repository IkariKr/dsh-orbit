import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  patchConnectionRoot,
  patchConnectionRootForGeneration,
  verifyConnectionRoot,
} from "../src/remote-settings-patch.mjs";

const SERVER_SOURCE = `import { randomUUID } from "node:crypto";

function header(headers, name) {
\treturn headers[name];
}
function parseAuthority(value) {
\treturn new URL(\`http://\${value}\`);
}
function isLoopbackHostname(hostname) {
\treturn hostname === "localhost" || hostname === "[::1]";
}
function isTrustedAuthority() {
\treturn false;
}
function isTrustedApiRequest(request, trustedHosts) {
\tconst host = header(request.headers, "host");
\tif (host === void 0) return false;
\tconst hostUrl = parseAuthority(host);
\tif (hostUrl === void 0) return false;
\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
\tif (header(request.headers, "sec-fetch-site") === "cross-site") return false;
\treturn true;
}
`;

const CLIENT_SOURCE = `function isLoopbackHostname(hostname) {
\tif (hostname === "localhost" || hostname === "[::1]") return true;
\treturn false;
}
`;

// 0.1.2-rc.1 rebuilt this bundle: randomUUID is gone and the node:crypto import
// changed. That single line is the only anchor difference between the reviewed
// connection-v1 and connection-v2 generations.
const SERVER_SOURCE_V2 = SERVER_SOURCE.replace(
  'import { randomUUID } from "node:crypto";',
  'import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";',
);

// Shape of the real 0.1.5-rc.2 client-connection bundle at the reviewed edit
// points: header$1 + parseAuthority in the api-request-trust region, a
// BrowserAuth with its own `?token=` exchange and cookie check, and the
// HostConnectionService methods that decide admission.
const BROWSER_AUTH_SERVER_SOURCE = `import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function header$1(headers, name) {
\tif (headers instanceof Headers) return headers.get(name) ?? void 0;
\tconst value = headers[name];
\treturn typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
\ttry {
\t\treturn new URL(\`http://\${authority}\`);
\t} catch {
\t\treturn;
\t}
}
function isLoopbackHostname(hostname) {
\treturn hostname === "localhost" || hostname === "[::1]";
}
function isTrustedAuthority(hostUrl, trustedHosts) {
\treturn trustedHosts.includes(hostUrl.host);
}
function isTrustedApiRequest(request, trustedHosts) {
\tconst host = header$1(request.headers, "host");
\tif (host === void 0) return false;
\tconst hostUrl = parseAuthority(host);
\tif (hostUrl === void 0) return false;
\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
\tif (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
\tconst origin = header$1(request.headers, "origin");
\tif (origin === void 0) return true;
\ttry {
\t\treturn new URL(origin).host === hostUrl.host;
\t} catch {
\t\treturn false;
\t}
}
const TOKEN_QUERY = "token";
class BrowserAuth {
\tconstructor({ launchToken, nativeCookie }) {
\t\tthis.launchToken = launchToken;
\t\tthis.nativeCookie = nativeCookie;
\t\tthis.indexCalls = [];
\t}
\tisAuthenticated(request) {
\t\treturn header$1(request.headers, "cookie") === this.nativeCookie;
\t}
\tauthorizeIndex(request, response) {
\t\tconst url = new URL(request.url ?? "/", "http://dsh.invalid");
\t\tconst tokens = url.searchParams.getAll(TOKEN_QUERY);
\t\tthis.indexCalls.push(tokens.length > 0 ? "token" : "cookie");
\t\tif (tokens.length > 0) {
\t\t\tif (tokens.join("") === this.launchToken) {
\t\t\t\tresponse.writeHead(303, { "set-cookie": "native=1" });
\t\t\t\treturn false;
\t\t\t}
\t\t\tresponse.writeHead(401, {});
\t\t\treturn false;
\t\t}
\t\tif (this.isAuthenticated(request)) return true;
\t\tresponse.writeHead(401, {});
\t\treturn false;
\t}
}
class HostConnectionService {
\tconstructor({ trustedHosts, browserAuth }) {
\t\tthis.trustedHosts = trustedHosts;
\t\tthis.browserAuth = browserAuth;
\t}
\trequestRejection(request) {
\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;
\t}
\tauthorizeIndex(request, response) {
\t\treturn this.browserAuth.authorizeIndex(request, response);
\t}
}
export { BrowserAuth, HostConnectionService };
`;

const PROXY_SECRET = "test-orbit-proxy-secret";
const LAUNCH_SESSION = "launch-session";
let importCounter = 0;

// Load the patched fixture as a real module so the generated admission helper
// runs for real instead of being pattern-matched in the patched text.
async function loadPatchedServer(root) {
  const serverPath = join(root, "index.js");
  await writeFile(
    serverPath,
    (await readFile(serverPath, "utf8")) + "\nexport { isDshOrbitAuthenticatedProxyRequest };\n",
    "utf8",
  );
  importCounter += 1;
  const url = `${pathToFileURL(serverPath).href}?v=${importCounter}`;
  return import(url);
}

async function browserAuthFixture({ proxySecret = PROXY_SECRET } = {}) {
  const root = await fixture({ serverSource: BROWSER_AUTH_SERVER_SOURCE });
  const proxyAuthFile = join(root, "proxy-auth");
  await writeFile(proxyAuthFile, proxySecret, "utf8");
  return { root, proxyAuthFile };
}

function request(headers, url = "/") {
  return { url, headers };
}

function runtimeFor(module, { trustedHosts = ["dsh.example.com"], launchToken = LAUNCH_SESSION, nativeCookie = "native=1" } = {}) {
  const auth = new module.BrowserAuth({ launchToken, nativeCookie });
  const service = new module.HostConnectionService({ trustedHosts, browserAuth: auth });
  return { module, auth, service };
}

const ORBIT_PROOF = {
  host: "dsh.example.com",
  "x-forwarded-proto": "https",
  "x-dsh-orbit-authenticated-proxy": PROXY_SECRET,
};

const LEGACY_SERVER_SOURCE = `import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

function header(headers, name) {
\treturn headers[name];
}
function parseAuthority(value) {
\treturn new URL(\`http://\${value}\`);
}
function isLoopbackHostname(hostname) {
\treturn hostname === "localhost" || hostname === "[::1]";
}
function isTrustedAuthority() {
\treturn false;
}
const REMOTE_PROXY_AUTH_HEADER = "x-dsh-authenticated-proxy";
const REMOTE_PROXY_AUTH_HOST = "legacy.example.com";
const REMOTE_PROXY_AUTH_PROTO = "https";
let remoteProxyAuthValue = "";
try {
\tremoteProxyAuthValue = readFileSync("/run/secrets/dsh_proxy_auth", "utf8").trim();
} catch {
\tremoteProxyAuthValue = "";
}
function isAuthenticatedReverseProxyRequest(request, hostUrl) {
\tif (remoteProxyAuthValue === "") return false;
\tif (hostUrl.hostname !== REMOTE_PROXY_AUTH_HOST) return false;
\tif (header(request.headers, "x-forwarded-proto") !== REMOTE_PROXY_AUTH_PROTO) return false;
\tif (header(request.headers, REMOTE_PROXY_AUTH_HEADER) !== remoteProxyAuthValue) return false;
\tif (header(request.headers, "sec-fetch-site") === "cross-site") return false;
\tconst origin = header(request.headers, "origin");
\tif (origin === void 0) return true;
\ttry {
\t\treturn new URL(origin).host === hostUrl.host;
\t} catch {
\t\treturn false;
\t}
}

function isTrustedApiRequest(request, trustedHosts) {
\tconst host = header(request.headers, "host");
\tif (host === void 0) return false;
\tconst hostUrl = parseAuthority(host);
\tif (hostUrl === void 0) return false;
\tif (isAuthenticatedReverseProxyRequest(request, hostUrl)) return true;
\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
\tif (header(request.headers, "sec-fetch-site") === "cross-site") return false;
\treturn true;
}
`;

const LEGACY_CLIENT_SOURCE = `function isLoopbackHostname(hostname) {
\tif (hostname === "localhost" || hostname === "[::1]" || hostname === "legacy.example.com") return true;
\treturn false;
}
`;

async function fixture({ clientSource = CLIENT_SOURCE, serverSource = SERVER_SOURCE } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-orbit-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.js"), serverSource, "utf8");
  await writeFile(join(root, "client.js"), clientSource, "utf8");
  return root;
}

test("patches and verifies a supported client-connection root", async () => {
  const root = await fixture();
  const options = {
    root,
    dshVersion: "0.1.1-rc.2",
    publicHost: "dsh.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
  };

  const first = await patchConnectionRoot(options);
  assert.equal(first.server, "patched");
  assert.equal(first.client, "patched");

  const server = await readFile(join(root, "index.js"), "utf8");
  const client = await readFile(join(root, "client.js"), "utf8");
  assert.match(server, /DSH_ORBIT_PROXY_HOST = "dsh\.example\.com"/);
  assert.match(server, /x-dsh-orbit-authenticated-proxy/);
  assert.match(server, /isDshOrbitAuthenticatedProxyRequest/);
  assert.match(client, /hostname === "dsh\.example\.com"/);

  await verifyConnectionRoot({
    root,
    publicHost: "dsh.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    connectionPatch: "connection-v1",
  });

  const second = await patchConnectionRoot(options);
  assert.equal(second.server, "ok");
  assert.equal(second.client, "ok");
});

test("keeps the reviewed 0.1.2+ bundle anchor available for the investigation", async () => {
  // 0.1.2-rc.1 is INVESTIGATION_ONLY, not a baseline, but the byte-exact anchor
  // discovered for its bundle generation is reviewed knowledge that the 0.1.5
  // investigation depends on, so losing it would silently discard the finding.
  const source = await readFile(new URL("../src/remote-settings-patch.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /'import \{ createHash, createHmac, randomBytes, timingSafeEqual \} from "node:crypto";\\n'/,
  );
  // connection-v2 stays a known generation: it fails for having no reviewed
  // install shape, not for being unrecognized. That distinction is what keeps
  // the layout knowledge intact while forbidding an install.
  const { root, proxyAuthFile } = await browserAuthFixture();
  await assert.rejects(
    patchConnectionRootForGeneration({
      root,
      connectionPatch: "connection-v2",
      publicHost: "dsh.example.com",
      proxyAuthFile,
    }),
    /has no reviewed install shape/,
  );
});

test("refuses to patch an investigation-only version", async () => {
  const root = await fixture({ serverSource: SERVER_SOURCE_V2 });
  await assert.rejects(
    () =>
      patchConnectionRoot({
        root,
        dshVersion: "0.1.2-rc.1",
        publicHost: "dsh.example.com",
        proxyAuthFile: "/run/secrets/dsh_proxy_auth",
      }),
    /Unsupported DeepSeek Harness version/,
  );
});

test("migrates the pre-Orbit authenticated proxy patch", async () => {
  const root = await fixture({
    serverSource: LEGACY_SERVER_SOURCE,
    clientSource: LEGACY_CLIENT_SOURCE,
  });

  const result = await patchConnectionRoot({
    root,
    dshVersion: "0.1.1-rc.2",
    publicHost: "legacy.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
  });

  assert.equal(result.server, "patched");
  assert.equal(result.client, "ok");

  const server = await readFile(join(root, "index.js"), "utf8");
  assert.match(server, /DSH_ORBIT_PROXY_HEADER/);
  assert.match(server, /x-dsh-orbit-authenticated-proxy/);
  assert.doesNotMatch(server, /REMOTE_PROXY_AUTH_HEADER/);
  assert.doesNotMatch(server, /isAuthenticatedReverseProxyRequest/);
  await verifyConnectionRoot({
    root,
    publicHost: "legacy.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    connectionPatch: "connection-v1",
  });
});

test("rejects an unsupported upstream version", async () => {
  const root = await fixture();
  await assert.rejects(
    patchConnectionRoot({
      root,
      dshVersion: "9.9.9",
      publicHost: "dsh.example.com",
      proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    }),
    /Unsupported DeepSeek Harness version/,
  );

  assert.equal(await readFile(join(root, "index.js"), "utf8"), SERVER_SOURCE);
  assert.equal(await readFile(join(root, "client.js"), "utf8"), CLIENT_SOURCE);
});

test("fails closed when the expected client source shape changes", async () => {
  const root = await fixture({
    clientSource: "function isLoopbackHostname(hostname) { return hostname === 'localhost'; }\n",
  });

  await assert.rejects(
    patchConnectionRoot({
      root,
      dshVersion: "0.1.1-rc.2",
      publicHost: "dsh.example.com",
      proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    }),
    /missing loopback hostname check/,
  );

  assert.equal(await readFile(join(root, "index.js"), "utf8"), SERVER_SOURCE);
});

test("rejects a URL where a bare public hostname is required", async () => {
  const root = await fixture();
  await assert.rejects(
    patchConnectionRoot({
      root,
      dshVersion: "0.1.1-rc.2",
      publicHost: "https://dsh.example.com",
      proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    }),
    /bare hostname/,
  );
});

test("fails closed when an expected fragment appears more than once", async () => {
  const duplicatedGate = SERVER_SOURCE.replace(
    "\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;\n",
    "\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;\n\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;\n",
  );
  assert.notEqual(duplicatedGate, SERVER_SOURCE);
  const serverRoot = await fixture({ serverSource: duplicatedGate });
  await assert.rejects(
    patchConnectionRoot({
      root: serverRoot,
      dshVersion: "0.1.1-rc.2",
      publicHost: "dsh.example.com",
      proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    }),
    /trusted authority gate is not unique/,
  );
  assert.equal(await readFile(join(serverRoot, "index.js"), "utf8"), duplicatedGate);

  const duplicatedClient = CLIENT_SOURCE.replace(
    '\tif (hostname === "localhost" || hostname === "[::1]") return true;\n',
    '\tif (hostname === "localhost" || hostname === "[::1]") return true;\n\tif (hostname === "localhost" || hostname === "[::1]") return true;\n',
  );
  assert.notEqual(duplicatedClient, CLIENT_SOURCE);
  const clientRoot = await fixture({ clientSource: duplicatedClient });
  await assert.rejects(
    patchConnectionRoot({
      root: clientRoot,
      dshVersion: "0.1.1-rc.2",
      publicHost: "dsh.example.com",
      proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    }),
    /loopback hostname check is not unique/,
  );
});

// ---------------------------------------------------------------------------
// connection-browser-auth-v1: the HostConnectionService generation.
//
// The generation is exercised on its own reviewed bundle shape, without being
// selected by any DSH version, so the admission path can be reviewed before a
// baseline is promoted to it.
// ---------------------------------------------------------------------------

async function patchBrowserAuthGeneration({ proxySecret = PROXY_SECRET } = {}) {
  const { root, proxyAuthFile } = await browserAuthFixture({ proxySecret });
  const result = await patchConnectionRootForGeneration({
    root,
    connectionPatch: "connection-browser-auth-v1",
    publicHost: "dsh.example.com",
    proxyAuthFile,
  });
  assert.equal(result.server, "patched");
  return { root, proxyAuthFile, server: await readFile(join(root, "index.js"), "utf8") };
}

test("adds a second authentication path without removing native BrowserAuth", async () => {
  const { root, proxyAuthFile, server } = await patchBrowserAuthGeneration();

  // The trust fence still runs first, the proof is consulted second, and native
  // cookie authentication still decides the remaining requests.
  assert.match(
    server,
    /\trequestRejection\(request\) \{\n\t\tif \(!isTrustedApiRequest\(request, this\.trustedHosts\)\) return 403;\n\t\tif \(isDshOrbitAuthenticatedProxyRequest\(request\)\) return void 0;\n\t\treturn this\.browserAuth\.isAuthenticated\(request\) \? void 0 : 401;\n\t\}/,
  );
  assert.match(
    server,
    /\tauthorizeIndex\(request, response\) \{\n\t\tconst url = new URL\(request\.url \?\? "\/", "http:\/\/dsh\.invalid"\);\n\t\tif \(url\.searchParams\.getAll\(TOKEN_QUERY\)\.length === 0 && isDshOrbitAuthenticatedProxyRequest\(request\)\) return true;\n\t\treturn this\.browserAuth\.authorizeIndex\(request, response\);\n\t\}/,
  );

  // The generated helper binds to the reviewed generation's own symbols.
  assert.match(server, /function isDshOrbitAuthenticatedProxyRequest\(request\) \{/);
  assert.match(server, /const host = header\$1\(request\.headers, "host"\);/);
  assert.match(server, /const hostUrl = parseAuthority\(host\);/);
  assert.doesNotMatch(server, /isDshOrbitAuthenticatedProxyRequest\(request, hostUrl\)/);

  // Native BrowserAuth is untouched: no rewrite of its token exchange.
  assert.match(server, /if \(tokens\.length > 0\) \{/);
  assert.match(server, /tokens\.join\(""\) === this\.launchToken/);

  await verifyConnectionRoot({
    root,
    publicHost: "dsh.example.com",
    proxyAuthFile,
    connectionPatch: "connection-browser-auth-v1",
  });

  const again = await patchConnectionRootForGeneration({
    root,
    connectionPatch: "connection-browser-auth-v1",
    publicHost: "dsh.example.com",
    proxyAuthFile,
  });
  assert.equal(again.server, "ok");
});

test("keeps the trust fence ahead of the Orbit proof on /api requests", async () => {
  const { root } = await patchBrowserAuthGeneration();
  const module = await loadPatchedServer(root);
  const { service } = runtimeFor(module);

  // A valid Orbit proof on an untrusted Host is still forbidden: the fence is
  // not bypassable by the added authentication path.
  assert.equal(service.requestRejection(request({ ...ORBIT_PROOF, host: "evil.example.com" })), 403);
  // A loopback Host passes the fence, but the proof only authorizes the
  // configured public host, so native BrowserAuth still decides.
  assert.equal(service.requestRejection(request({ ...ORBIT_PROOF, host: "localhost:3080" })), 401);

  // Trusted Host + valid proof is admitted without any browser cookie.
  assert.equal(service.requestRejection(request({ ...ORBIT_PROOF })), undefined);

  // Trusted Host + native cookie is admitted exactly as before (this is the
  // authority-bound native BrowserAuth path the patch must not break).
  assert.equal(service.requestRejection(request({ host: "dsh.example.com", cookie: "native=1" })), undefined);

  // Trusted Host, no proof, no cookie: unchanged 401.
  assert.equal(service.requestRejection(request({ host: "dsh.example.com" })), 401);
});

test("refuses an Orbit proof that is missing, stale, or cross-origin", async () => {
  const { root } = await patchBrowserAuthGeneration();
  const module = await loadPatchedServer(root);
  const isProof = module.isDshOrbitAuthenticatedProxyRequest;
  const proof = { ...ORBIT_PROOF };

  assert.equal(isProof(request(proof)), true);
  // Host with a port still matches the configured bare public hostname.
  assert.equal(isProof(request({ ...proof, host: "dsh.example.com:8443" })), true);
  // Origin, when present, must equal the Host.
  assert.equal(isProof(request({ ...proof, origin: "https://dsh.example.com" })), true);
  assert.equal(isProof(request({ ...proof, origin: "https://evil.example.com" })), false);

  assert.equal(isProof(request({ ...proof, host: undefined })), false);
  assert.equal(isProof(request({ ...proof, host: "other.example.com" })), false);
  assert.equal(isProof(request({ ...proof, "x-forwarded-proto": "http" })), false);
  assert.equal(isProof(request({ ...proof, "x-forwarded-proto": undefined })), false);
  assert.equal(isProof(request({ ...proof, "x-dsh-orbit-authenticated-proxy": "wrong" })), false);
  assert.equal(isProof(request({ ...proof, "x-dsh-orbit-authenticated-proxy": undefined })), false);
  assert.equal(isProof(request({ ...proof, "sec-fetch-site": "cross-site" })), false);
  assert.equal(isProof(request({ ...proof, host: "not a host" })), false);
});

test("refuses every proof when no Orbit proxy secret is provisioned", async () => {
  const { root } = await patchBrowserAuthGeneration({ proxySecret: "" });
  const module = await loadPatchedServer(root);
  assert.equal(module.isDshOrbitAuthenticatedProxyRequest(request({ ...ORBIT_PROOF })), false);

  const { service } = runtimeFor(module);
  assert.equal(service.requestRejection(request({ ...ORBIT_PROOF })), 401);
});

test("routes token requests to native BrowserAuth and only admits tokenless proofs", async () => {
  const { root } = await patchBrowserAuthGeneration();
  const module = await loadPatchedServer(root);
  const { service, auth } = runtimeFor(module);

  const write = (status) => ({ writeHead: (code) => { status.code = code; }, end: () => {} });
  const status = {};

  // A valid native token exchange keeps DSH's own 303 + Set-Cookie.
  assert.equal(
    service.authorizeIndex({ url: `/?token=${LAUNCH_SESSION}`, headers: { ...ORBIT_PROOF } }, write(status)),
    false,
  );
  assert.equal(status.code, 303);
  assert.deepEqual(auth.indexCalls, ["token"]);

  // The regression this design exists to prevent: an invalid native token must
  // still be rejected even when the Orbit proof is valid.
  auth.indexCalls.length = 0;
  assert.equal(service.authorizeIndex({ url: "/?token=wrong", headers: { ...ORBIT_PROOF } }, write(status)), false);
  assert.equal(status.code, 401);
  assert.deepEqual(auth.indexCalls, ["token"]);

  // A tokenless request with a valid proof is served without touching native
  // BrowserAuth at all.
  auth.indexCalls.length = 0;
  assert.equal(service.authorizeIndex({ url: "/", headers: { ...ORBIT_PROOF } }, write(status)), true);
  assert.deepEqual(auth.indexCalls, []);

  // A tokenless request without a proof falls through to the native cookie
  // check, which still rejects an unauthenticated browser.
  auth.indexCalls.length = 0;
  assert.equal(service.authorizeIndex({ url: "/", headers: { host: "dsh.example.com" } }, write(status)), false);
  assert.equal(status.code, 401);
  assert.deepEqual(auth.indexCalls, ["cookie"]);

  // A tokenless request carrying a native cookie keeps working through native
  // BrowserAuth on the trusted authority.
  auth.indexCalls.length = 0;
  assert.equal(
    service.authorizeIndex({ url: "/", headers: { host: "dsh.example.com", cookie: "native=1" } }, write(status)),
    true,
  );
  assert.deepEqual(auth.indexCalls, ["cookie"]);

  // A proof on a foreign Host is not a gateway path either; native BrowserAuth
  // still owns the decision and rejects the unauthenticated request.
  assert.equal(service.authorizeIndex({ url: "/", headers: { ...ORBIT_PROOF, host: "evil.example.com" } }, write(status)), false);
  assert.equal(status.code, 401);
});

test("fails closed when the reviewed generation's symbols are missing", async () => {
  const cases = [
    {
      label: "header$1",
      server: BROWSER_AUTH_SERVER_SOURCE.replace("function header$1(headers, name) {", "function readHeader(headers, name) {"),
    },
    {
      label: "parseAuthority",
      server: BROWSER_AUTH_SERVER_SOURCE.replace("function parseAuthority(authority) {", "function toAuthority(authority) {"),
    },
    {
      label: "TOKEN_QUERY",
      server: BROWSER_AUTH_SERVER_SOURCE.replace('const TOKEN_QUERY = "token";', 'const TOKEN_QUERY_NAME = "token";'),
    },
  ];

  for (const { label, server } of cases) {
    assert.notEqual(server, BROWSER_AUTH_SERVER_SOURCE);
    const root = await fixture({ serverSource: server });
    const proxyAuthFile = join(root, "proxy-auth");
    await writeFile(proxyAuthFile, PROXY_SECRET, "utf8");
    await assert.rejects(
      patchConnectionRootForGeneration({
        root,
        connectionPatch: "connection-browser-auth-v1",
        publicHost: "dsh.example.com",
        proxyAuthFile,
      }),
      new RegExp(`required by connection-browser-auth-v1`),
      `${label} must fail the patch`,
    );
    assert.equal(await readFile(join(root, "index.js"), "utf8"), server);
    assert.equal(await readFile(join(root, "client.js"), "utf8"), CLIENT_SOURCE);
  }
});

test("fails closed when the HostConnectionService decision points move", async () => {
  const movedFence = BROWSER_AUTH_SERVER_SOURCE.replace(
    "\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n",
    "\t\tif (isTrustedApiRequest(request, this.trustedHosts) === false) return 403;\n",
  );
  assert.notEqual(movedFence, BROWSER_AUTH_SERVER_SOURCE);
  const fenceRoot = await fixture({ serverSource: movedFence });
  const fenceAuth = join(fenceRoot, "proxy-auth");
  await writeFile(fenceAuth, PROXY_SECRET, "utf8");
  await assert.rejects(
    patchConnectionRootForGeneration({
      root: fenceRoot,
      connectionPatch: "connection-browser-auth-v1",
      publicHost: "dsh.example.com",
      proxyAuthFile: fenceAuth,
    }),
    /missing requestRejection trust fence/,
  );
  assert.equal(await readFile(join(fenceRoot, "index.js"), "utf8"), movedFence);

  const movedDelegate = BROWSER_AUTH_SERVER_SOURCE.replace(
    "\t\treturn this.browserAuth.authorizeIndex(request, response);\n",
    "\t\treturn this.browserAuth.authorizeIndex(request, response); // native\n",
  );
  assert.notEqual(movedDelegate, BROWSER_AUTH_SERVER_SOURCE);
  const delegateRoot = await fixture({ serverSource: movedDelegate });
  const delegateAuth = join(delegateRoot, "proxy-auth");
  await writeFile(delegateAuth, PROXY_SECRET, "utf8");
  await assert.rejects(
    patchConnectionRootForGeneration({
      root: delegateRoot,
      connectionPatch: "connection-browser-auth-v1",
      publicHost: "dsh.example.com",
      proxyAuthFile: delegateAuth,
    }),
    /missing authorizeIndex BrowserAuth delegate/,
  );
  assert.equal(await readFile(join(delegateRoot, "index.js"), "utf8"), movedDelegate);
});

test("does not install a generation that only records a bundle layout", async () => {
  const { root, proxyAuthFile } = await browserAuthFixture();
  await assert.rejects(
    patchConnectionRootForGeneration({
      root,
      connectionPatch: "connection-v2",
      publicHost: "dsh.example.com",
      proxyAuthFile,
    }),
    /has no reviewed install shape/,
  );
  assert.equal(await readFile(join(root, "index.js"), "utf8"), BROWSER_AUTH_SERVER_SOURCE);
});

test("verification rejects a tree patched for a different generation", async () => {
  // A connection-v1 tree carries the fence-shape helper, so verifying it as the
  // HostConnectionService generation must fail instead of reporting ok.
  const root = await fixture();
  await patchConnectionRoot({
    root,
    dshVersion: "0.1.1-rc.2",
    publicHost: "dsh.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
  });
  await assert.rejects(
    verifyConnectionRoot({
      root,
      publicHost: "dsh.example.com",
      proxyAuthFile: "/run/secrets/dsh_proxy_auth",
      connectionPatch: "connection-browser-auth-v1",
    }),
    /requestRejection does not admit the authenticated proxy proof/,
  );
});

test("requires every reviewed declaration exactly once", async () => {
  const duplicated = BROWSER_AUTH_SERVER_SOURCE.replace(
    "function header$1(headers, name) {",
    "function header$1(headers, name) {\n\treturn undefined;\n}\nfunction header$1(headers, name) {",
  );
  assert.notEqual(duplicated, BROWSER_AUTH_SERVER_SOURCE);
  const root = await fixture({ serverSource: duplicated });
  const proxyAuthFile = join(root, "proxy-auth");
  await writeFile(proxyAuthFile, PROXY_SECRET, "utf8");
  await assert.rejects(
    patchConnectionRootForGeneration({
      root,
      connectionPatch: "connection-browser-auth-v1",
      publicHost: "dsh.example.com",
      proxyAuthFile,
    }),
    /required by connection-browser-auth-v1 is not unique/,
  );
  assert.equal(await readFile(join(root, "index.js"), "utf8"), duplicated);
});

// ---------------------------------------------------------------------------
// Verification must prove the security semantics, not the marker.
//
// `--check` is the release and runtime verification gate, so a tree whose
// admission helper lost a predicate must not verify. Each case below patches a
// fixture, tampers one reviewed element, and expects verifyConnectionRoot() to
// refuse the result.
// ---------------------------------------------------------------------------

const VERIFY_OPTIONS = { publicHost: "dsh.example.com", connectionPatch: "connection-browser-auth-v1" };

async function expectVerificationFailure(label, tamper, expected) {
  const { root, proxyAuthFile } = await patchBrowserAuthGeneration();
  const serverPath = join(root, "index.js");
  const patched = await readFile(serverPath, "utf8");
  const tampered = tamper(patched);
  assert.notEqual(tampered, patched, `${label}: tamper must change the patched tree`);
  await writeFile(serverPath, tampered, "utf8");
  await assert.rejects(
    verifyConnectionRoot({ root, ...VERIFY_OPTIONS, proxyAuthFile }),
    expected,
    `${label}: verification must refuse the tampered tree`,
  );
}

test("verification rejects an admission helper that lost its security predicates", async () => {
  const removals = [
    ["proxy secret", "\tif (dshOrbitProxySecret === \"\") return false;\n"],
    ["x-forwarded-proto", '\tif (header$1(request.headers, "x-forwarded-proto") !== DSH_ORBIT_PROXY_PROTO) return false;\n'],
    ["shared secret", "\tif (header$1(request.headers, DSH_ORBIT_PROXY_HEADER) !== dshOrbitProxySecret) return false;\n"],
    ["cross-site rejection", '\tif (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;\n'],
    ["origin fence", '\tconst origin = header$1(request.headers, "origin");\n\tif (origin === void 0) return true;\n'],
    ["origin comparison", '\t\treturn new URL(origin).host === hostUrl.host;\n'],
    ["public host check", "\tif (hostUrl.hostname !== DSH_ORBIT_PROXY_HOST) return false;\n"],
    ["authority parse", "\tconst hostUrl = parseAuthority(host);\n\tif (hostUrl === void 0) return false;\n"],
    ["host header read", '\tconst host = header$1(request.headers, "host");\n\tif (host === void 0) return false;\n'],
  ];

  for (const [label, needle] of removals) {
    await expectVerificationFailure(label, (source) => source.replace(needle, ""), /Orbit admission helper mismatch/);
  }
});

test("verification rejects a helper replaced by a permissive stub", async () => {
  await expectVerificationFailure(
    "permissive stub",
    (source) =>
      source.replace(
        "function isDshOrbitAuthenticatedProxyRequest(request) {",
        "function isDshOrbitAuthenticatedProxyRequest(request) {\n\treturn true;\n}\nfunction unusedOriginal(request) {",
      ),
    /Orbit admission helper mismatch/,
  );
});

test("verification rejects a second helper declaration that would win at runtime", async () => {
  // A later declaration of the same name shadows the reviewed one even though
  // the reviewed helper is still byte-identical in the file.
  await expectVerificationFailure(
    "duplicate declaration",
    (source) =>
      source +
      "\nfunction isDshOrbitAuthenticatedProxyRequest(request) {\n\treturn true;\n}\n",
    /Orbit admission helper is referenced 4 times, expected 3/,
  );
});

test("verification rejects a mismatched public host or proxy auth file", async () => {
  const { root, proxyAuthFile } = await patchBrowserAuthGeneration();

  await assert.rejects(
    verifyConnectionRoot({ root, ...VERIFY_OPTIONS, publicHost: "other.example.com", proxyAuthFile }),
    /Orbit admission helper mismatch/,
  );
  await assert.rejects(
    verifyConnectionRoot({ root, ...VERIFY_OPTIONS, proxyAuthFile: join(root, "other-proxy-auth") }),
    /Orbit admission helper mismatch/,
  );
  // The unmodified tree still verifies, so the failures above are caused by the
  // mismatch and not by the tree being unverifiable.
  await verifyConnectionRoot({ root, ...VERIFY_OPTIONS, proxyAuthFile });
});

test("verification requires the generation and the proxy auth file", async () => {
  const { root, proxyAuthFile } = await patchBrowserAuthGeneration();

  await assert.rejects(
    verifyConnectionRoot({ root, publicHost: "dsh.example.com", proxyAuthFile }),
    /connectionPatch is required/,
  );
  await assert.rejects(
    verifyConnectionRoot({ root, ...VERIFY_OPTIONS, proxyAuthFile: "" }),
    /proxyAuthFile is required/,
  );
  await assert.rejects(
    verifyConnectionRoot({ root, publicHost: "dsh.example.com", proxyAuthFile, connectionPatch: "connection-nope" }),
    /unknown connection patch profile/,
  );
});

test("verification rejects a tampered fence generation", async () => {
  // The released baseline uses the fence generation, so it gets the same
  // exact-semantics treatment as the new one.
  const root = await fixture();
  await patchConnectionRoot({
    root,
    dshVersion: "0.1.1-rc.2",
    publicHost: "dsh.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
  });
  const fenceOptions = {
    publicHost: "dsh.example.com",
    proxyAuthFile: "/run/secrets/dsh_proxy_auth",
    connectionPatch: "connection-v1",
  };
  await verifyConnectionRoot({ root, ...fenceOptions });

  const serverPath = join(root, "index.js");
  const tampered = (await readFile(serverPath, "utf8")).replace(
    "\tif (isDshOrbitAuthenticatedProxyRequest(request, hostUrl)) return true;\n",
    "",
  );
  await writeFile(serverPath, tampered, "utf8");
  await assert.rejects(
    verifyConnectionRoot({ root, ...fenceOptions }),
    /Orbit admission helper mismatch|isTrustedApiRequest does not admit the authenticated proxy proof/,
  );
});
