import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  patchConnectionRoot,
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

  await verifyConnectionRoot({ root, publicHost: "dsh.example.com" });

  const second = await patchConnectionRoot(options);
  assert.equal(second.server, "ok");
  assert.equal(second.client, "ok");
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
  await verifyConnectionRoot({ root, publicHost: "legacy.example.com" });
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
