import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The @linxin666/dsh-ssh plugin deliberately fences its route family — host
// CRUD, exec, SFTP, tunnels, and the WebSocket PTY terminal upgrade — as
// loopback-only ("forbidden: loopback-only"). This patch extends that fence
// with the same authenticated-proxy admission the connection patch uses:
// a request that proves the exact public host, HTTPS forwarding, the
// gateway-injected internal secret, a non-cross-site fetch site, and a
// same-origin browser context is admitted even though its Host is not
// loopback. Loopback requests keep their original path, and every other
// request stays denied. The patch applies only to an exactly matching
// source layout of the pinned plugin version and fails closed on drift.

export const SSH_PLUGIN_DEFAULT_VERSION = "0.3.2";

export const SSH_PLUGIN_PROXY_HEADER = "x-dsh-orbit-authenticated-proxy";

export const SSH_PLUGIN_HELPER_ANCHOR = "function isLoopbackRequest(request) {";

export const SSH_PLUGIN_GATE_NEEDLE = "if (!isLoopbackRequest(req)) {";

export const SSH_PLUGIN_GATE_COUNT = 3;

export const SSH_PLUGIN_HELPER_MARKER = "isDshOrbitAuthenticatedProxyRequest";

function quote(value) {
  return JSON.stringify(value);
}

export function buildDshSshHelper({ publicHost, proxyAuthFile }) {
  return [
    `const DSH_ORBIT_SSH_PUBLIC_HOST = ${quote(publicHost)};`,
    `const DSH_ORBIT_SSH_PROXY_AUTH_FILE = ${quote(proxyAuthFile)};`,
    "let dshOrbitSshProxySecret = \"\";",
    "try {",
    "\tdshOrbitSshProxySecret = readFileSync(DSH_ORBIT_SSH_PROXY_AUTH_FILE, \"utf8\").trim();",
    "} catch {",
    "\tdshOrbitSshProxySecret = \"\";",
    "}",
    "function isDshOrbitAuthenticatedProxyRequest(request) {",
    "\tif (dshOrbitSshProxySecret === \"\") return false;",
    "\tconst host = request.headers.host;",
    "\tif (typeof host !== \"string\") return false;",
    "\tlet hostUrl;",
    "\ttry { hostUrl = new URL(\"http://\" + host); } catch { return false; }",
    "\tif (hostUrl.hostname !== DSH_ORBIT_SSH_PUBLIC_HOST) return false;",
    "\tif (request.headers[\"x-forwarded-proto\"] !== \"https\") return false;",
    `\tif (request.headers[${quote(SSH_PLUGIN_PROXY_HEADER)}] !== dshOrbitSshProxySecret) return false;`,
    "\tif (request.headers[\"sec-fetch-site\"] === \"cross-site\") return false;",
    "\tconst origin = request.headers.origin;",
    "\tif (origin === void 0) return true;",
    "\ttry { return new URL(origin).host === hostUrl.host; } catch { return false; }",
    "}",
  ].join("\n");
}

function replaceExactly(source, needle, replacement, label, expectedCount) {
  let count = 0;
  let cursor = 0;
  let next;
  while ((next = source.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor = next + needle.length;
  }
  if (count !== expectedCount) {
    throw new Error(
      `DSH Orbit dsh-ssh patch failed: expected ${label} exactly ${expectedCount} time(s), found ${count}`,
    );
  }
  return source.replaceAll(needle, replacement);
}

export async function readDshSshPluginVersion(pluginRoot) {
  const raw = await readFile(join(pluginRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`Unable to read the dsh-ssh plugin version from ${pluginRoot}`);
  }
  return parsed.version;
}

export async function patchDshSshPlugin({
  root,
  pluginVersion = SSH_PLUGIN_DEFAULT_VERSION,
  publicHost,
  proxyAuthFile,
}) {
  const version = await readDshSshPluginVersion(root);
  if (version !== pluginVersion) {
    throw new Error(
      `DSH Orbit dsh-ssh patch failed: installed plugin version ${JSON.stringify(version)}` +
        ` is not the pinned ${JSON.stringify(pluginVersion)}; review the compatibility before patching`,
    );
  }
  const indexPath = join(root, "lib", "index.js");
  const source = await readFile(indexPath, "utf8");

  if (source.includes(`function isDshOrbitAuthenticatedProxyRequest(request) {`)) {
    return { root, status: "ok", version };
  }

  const helper = buildDshSshHelper({ publicHost, proxyAuthFile });
  const injected = replaceExactly(
    source,
    SSH_PLUGIN_HELPER_ANCHOR,
    `${helper}\n${SSH_PLUGIN_HELPER_ANCHOR}`,
    SSH_PLUGIN_HELPER_ANCHOR,
    1,
  );
  const patched = replaceExactly(
    injected,
    SSH_PLUGIN_GATE_NEEDLE,
    `if (!isLoopbackRequest(req) && !isDshOrbitAuthenticatedProxyRequest(req)) {`,
    SSH_PLUGIN_GATE_NEEDLE,
    SSH_PLUGIN_GATE_COUNT,
  );

  await writeFile(indexPath, patched, "utf8");
  return { root, status: "patched", version };
}

export async function verifyDshSshPlugin({
  root,
  pluginVersion = SSH_PLUGIN_DEFAULT_VERSION,
  publicHost,
}) {
  const version = await readDshSshPluginVersion(root);
  if (version !== pluginVersion) {
    throw new Error(
      `DSH Orbit dsh-ssh verification failed: installed plugin version ${JSON.stringify(version)}` +
        ` is not the pinned ${JSON.stringify(pluginVersion)}`,
    );
  }
  const source = await readFile(join(root, "lib", "index.js"), "utf8");
  const problems = [];
  if (!source.includes(`function isDshOrbitAuthenticatedProxyRequest(request) {`)) {
    problems.push("authenticated proxy helper missing");
  }
  if (!source.includes(`const DSH_ORBIT_SSH_PUBLIC_HOST = ${quote(publicHost)};`)) {
    problems.push("public host mismatch");
  }
  if (!source.includes(`&& !isDshOrbitAuthenticatedProxyRequest(req)) {`)) {
    problems.push("terminal gate not admitted");
  }
  if (problems.length > 0) {
    throw new Error(`DSH Orbit dsh-ssh verification failed: ${problems.join(", ")}`);
  }
  return { root, status: "ok", version };
}