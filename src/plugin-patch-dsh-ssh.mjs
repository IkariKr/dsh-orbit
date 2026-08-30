import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// LEGACY THIRD-PARTY COMPATIBILITY DEBT (ADR-0001): freeze-only, no new features.
// This module patches a third-party plugin and will be removed once DSH provides a
// generic trusted-client / authenticated-proxy capability. Do not extend it.
//
// The @linxin666/dsh-ssh plugin deliberately fences its route family — host
// CRUD, exec, SFTP, tunnels, and the WebSocket PTY terminal upgrade — as
// loopback-only ("forbidden: loopback-only"). This patch extends that fence
// with the same authenticated-proxy admission the connection patch uses:
// a request that proves the exact public host, HTTPS forwarding, the
// gateway-injected internal secret, a non-cross-site fetch site, and a
// same-origin browser context is admitted even though its Host is not
// loopback. Loopback requests keep their original path, and every other
// request stays denied. The patch applies only to an exactly matching
// source layout of the pinned plugin version and fails closed on drift;
// the verifier rejects any missing, duplicated, or tampered fragment.

export const SSH_PLUGIN_DEFAULT_VERSION = "0.3.2";

export const SSH_PLUGIN_PROXY_HEADER = "x-dsh-orbit-authenticated-proxy";

export const SSH_PLUGIN_HELPER_ANCHOR = "function isLoopbackRequest(request) {";

export const SSH_PLUGIN_GATE_NEEDLE = "if (!isLoopbackRequest(req)) {";

export const SSH_PLUGIN_PATCHED_GATE_NEEDLE =
  "if (!isLoopbackRequest(req) && !isDshOrbitAuthenticatedProxyRequest(req)) {";

export const SSH_PLUGIN_HELPER_MARKER = "isDshOrbitAuthenticatedProxyRequest";

export const SSH_PLUGIN_GATE_COUNT = 3;

export const SSH_PLUGIN_HELPER_SIGNATURE = "function isDshOrbitAuthenticatedProxyRequest(request) {";

function quote(value) {
  return JSON.stringify(value);
}

function countOccurrences(source, needle) {
  let count = 0;
  let cursor = 0;
  let next;
  while ((next = source.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor = next + needle.length;
  }
  return count;
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

/**
 * Exact structural verification of an already-patched bundle. Returns a list
 * of problems; an empty list means the layout matches the configured
 * patch exactly: one helper, exactly three patched gates, zero unpatched
 * gates, and the embedded host/auth-file constants match this run.
 */
export function verifyPatchedLayout(source, { publicHost, proxyAuthFile }) {
  const problems = [];
  // The whole helper — constants plus every security predicate — must appear
  // exactly once, byte for byte. Any change to a predicate (HTTPS, secret,
  // cross-site, origin, host) or to any other line fails closed, not just
  // structural counts.
  const expectedHelper = buildDshSshHelper({ publicHost, proxyAuthFile });
  const helperBlockCount = countOccurrences(source, expectedHelper);
  if (helperBlockCount !== 1) {
    problems.push(
      `authenticated proxy helper block must appear exactly once, found ${helperBlockCount}` +
        " (any change to the helper body is a tamper)",
    );
  }
  const helperCount = countOccurrences(source, SSH_PLUGIN_HELPER_SIGNATURE);
  if (helperCount !== 1) {
    problems.push(`authenticated proxy helper signature must appear exactly once, found ${helperCount}`);
  }
  const patchedGates = countOccurrences(source, SSH_PLUGIN_PATCHED_GATE_NEEDLE);
  if (patchedGates !== SSH_PLUGIN_GATE_COUNT) {
    problems.push(
      `patched terminal gates must appear exactly ${SSH_PLUGIN_GATE_COUNT} times, found ${patchedGates}`,
    );
  }
  const unpatchedGates = countOccurrences(source, SSH_PLUGIN_GATE_NEEDLE);
  if (unpatchedGates !== 0) {
    problems.push(`unpatched terminal gates must not remain, found ${unpatchedGates}`);
  }
  if (!source.includes(`const DSH_ORBIT_SSH_PUBLIC_HOST = ${quote(publicHost)};`)) {
    problems.push("public host mismatch");
  }
  if (!source.includes(`const DSH_ORBIT_SSH_PROXY_AUTH_FILE = ${quote(proxyAuthFile)};`)) {
    problems.push("proxy auth file mismatch");
  }
  return problems;
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

  if (source.includes(SSH_PLUGIN_HELPER_MARKER)) {
    // Idempotent path: the bundle claims to be patched — verify the whole
    // layout instead of trusting the marker, then report the verification
    const problems = verifyPatchedLayout(source, { publicHost, proxyAuthFile });
    if (problems.length > 0) {
      throw new Error(`DSH Orbit dsh-ssh verification failed: ${problems.join("; ")}`);
    }
    return { root, status: "ok", version };
  }

  const helper = buildDshSshHelper({ publicHost, proxyAuthFile });
  const anchorCount = countOccurrences(source, SSH_PLUGIN_HELPER_ANCHOR);
  if (anchorCount !== 1) {
    throw new Error(
      `DSH Orbit dsh-ssh patch failed: expected ${SSH_PLUGIN_HELPER_ANCHOR} exactly 1 time(s), found ${anchorCount}`,
    );
  }
  const gateCount = countOccurrences(source, SSH_PLUGIN_GATE_NEEDLE);
  if (gateCount !== SSH_PLUGIN_GATE_COUNT) {
    throw new Error(
      `DSH Orbit dsh-ssh patch failed: expected ${SSH_PLUGIN_GATE_NEEDLE} exactly ${SSH_PLUGIN_GATE_COUNT} time(s), found ${gateCount}`,
    );
  }
  const injected = source.replaceAll(
    SSH_PLUGIN_HELPER_ANCHOR,
    `${helper}\n${SSH_PLUGIN_HELPER_ANCHOR}`,
  );
  const patched = injected.replaceAll(
    SSH_PLUGIN_GATE_NEEDLE,
    SSH_PLUGIN_PATCHED_GATE_NEEDLE,
  );

  const problems = verifyPatchedLayout(patched, { publicHost, proxyAuthFile });
  if (problems.length > 0) {
    throw new Error(`DSH Orbit dsh-ssh patch failed: ${problems.join("; ")}`);
  }
  await writeFile(indexPath, patched, "utf8");
  return { root, status: "patched", version };
}

export async function verifyDshSshPlugin({
  root,
  pluginVersion = SSH_PLUGIN_DEFAULT_VERSION,
  publicHost,
  proxyAuthFile,
}) {
  const version = await readDshSshPluginVersion(root);
  if (version !== pluginVersion) {
    throw new Error(
      `DSH Orbit dsh-ssh verification failed: installed plugin version ${JSON.stringify(version)}` +
        ` is not the pinned ${JSON.stringify(pluginVersion)}`,
    );
  }
  const source = await readFile(join(root, "lib", "index.js"), "utf8");
  const problems = verifyPatchedLayout(source, { publicHost, proxyAuthFile });
  if (problems.length > 0) {
    throw new Error(`DSH Orbit dsh-ssh verification failed: ${problems.join("; ")}`);
  }
  return { root, status: "ok", version };
}