import { readFile, writeFile } from "node:fs/promises";
import { compatibilityFor } from "./compatibility.mjs";

const SERVER_MARKER = 'const DSH_ORBIT_PROXY_HEADER = "x-dsh-orbit-authenticated-proxy";';
const LEGACY_SERVER_MARKER = 'const REMOTE_PROXY_AUTH_HEADER = "x-dsh-authenticated-proxy";';

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) {
    throw new Error(`DSH Orbit patch failed: missing ${label}`);
  }
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`DSH Orbit patch failed: ${label} is not unique`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function validateHost(publicHost) {
  if (!publicHost || typeof publicHost !== "string") {
    throw new Error("DSH_PUBLIC_HOST is required");
  }
  if (publicHost.includes("://") || publicHost.includes("/") || /\s/.test(publicHost)) {
    throw new Error("DSH_PUBLIC_HOST must be a bare hostname");
  }
}

function patchServer(source, { publicHost, proxyAuthFile }) {
  if (source.includes(SERVER_MARKER)) {
    return { source, changed: false };
  }

  const authBlock = `
${SERVER_MARKER}
const DSH_ORBIT_PROXY_HOST = ${JSON.stringify(publicHost)};
const DSH_ORBIT_PROXY_PROTO = "https";
let dshOrbitProxySecret = "";
try {
\tdshOrbitProxySecret = readFileSync(${JSON.stringify(proxyAuthFile)}, "utf8").trim();
} catch {
\tdshOrbitProxySecret = "";
}
function isDshOrbitAuthenticatedProxyRequest(request, hostUrl) {
\tif (dshOrbitProxySecret === "") return false;
\tif (hostUrl.hostname !== DSH_ORBIT_PROXY_HOST) return false;
\tif (header(request.headers, "x-forwarded-proto") !== DSH_ORBIT_PROXY_PROTO) return false;
\tif (header(request.headers, DSH_ORBIT_PROXY_HEADER) !== dshOrbitProxySecret) return false;
\tif (header(request.headers, "sec-fetch-site") === "cross-site") return false;
\tconst origin = header(request.headers, "origin");
\tif (origin === void 0) return true;
\ttry {
\t\treturn new URL(origin).host === hostUrl.host;
\t} catch {
\t\treturn false;
\t}
}
`;

  if (source.includes(LEGACY_SERVER_MARKER)) {
    const trustedDeclaration = "function isTrustedApiRequest(request, trustedHosts) {";
    const legacyStart = source.indexOf(LEGACY_SERVER_MARKER);
    const trustedStart = source.indexOf(trustedDeclaration, legacyStart);
    if (trustedStart < 0) {
      throw new Error("DSH Orbit patch failed: legacy proxy block is missing isTrustedApiRequest");
    }
    if (source.indexOf(LEGACY_SERVER_MARKER, legacyStart + LEGACY_SERVER_MARKER.length) >= 0) {
      throw new Error("DSH Orbit patch failed: legacy proxy marker is not unique");
    }
    source = source.slice(0, legacyStart) + authBlock + "\n" + source.slice(trustedStart);
    source = replaceExactlyOnce(
      source,
      "\tif (isAuthenticatedReverseProxyRequest(request, hostUrl)) return true;\n",
      "\tif (isDshOrbitAuthenticatedProxyRequest(request, hostUrl)) return true;\n",
      "legacy authenticated proxy gate",
    );
    return { source, changed: true };
  }

  source = replaceExactlyOnce(
    source,
    'import { randomUUID } from "node:crypto";\n',
    'import { randomUUID } from "node:crypto";\nimport { readFileSync } from "node:fs";\n',
    "client-connection crypto import",
  );

  source = replaceExactlyOnce(
    source,
    "function isTrustedApiRequest(request, trustedHosts) {",
    `${authBlock}\nfunction isTrustedApiRequest(request, trustedHosts) {`,
    "isTrustedApiRequest declaration",
  );

  source = replaceExactlyOnce(
    source,
    "\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;\n",
    "\tif (isDshOrbitAuthenticatedProxyRequest(request, hostUrl)) return true;\n\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;\n",
    "trusted authority gate",
  );

  return { source, changed: true };
}

function patchClient(source, { publicHost }) {
  const hostNeedle = `hostname === ${JSON.stringify(publicHost)}`;
  if (source.includes(hostNeedle)) {
    return { source, changed: false };
  }

  const needle = 'if (hostname === "localhost" || hostname === "[::1]") return true;';
  const replacement = `if (hostname === "localhost" || hostname === "[::1]" || hostname === ${JSON.stringify(publicHost)}) return true;`;
  source = replaceExactlyOnce(source, needle, replacement, "loopback hostname check");
  return { source, changed: true };
}

export async function readDshVersion(packageJsonPath) {
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.version || typeof parsed.version !== "string") {
    throw new Error(`Unable to read DSH version from ${packageJsonPath}`);
  }
  return parsed.version;
}

export async function patchConnectionRoot({
  root,
  dshVersion,
  publicHost,
  proxyAuthFile,
}) {
  validateHost(publicHost);
  compatibilityFor(dshVersion);

  const serverPath = `${root}/index.js`;
  const clientPath = `${root}/client.js`;
  const [serverSource, clientSource] = await Promise.all([
    readFile(serverPath, "utf8"),
    readFile(clientPath, "utf8"),
  ]);

  const server = patchServer(serverSource, { publicHost, proxyAuthFile });
  const client = patchClient(clientSource, { publicHost });

  if (server.changed) await writeFile(serverPath, server.source, "utf8");
  if (client.changed) await writeFile(clientPath, client.source, "utf8");

  return {
    root,
    server: server.changed ? "patched" : "ok",
    client: client.changed ? "patched" : "ok",
  };
}

export async function verifyConnectionRoot({ root, publicHost }) {
  validateHost(publicHost);
  const [server, client] = await Promise.all([
    readFile(`${root}/index.js`, "utf8"),
    readFile(`${root}/client.js`, "utf8"),
  ]);

  const problems = [];
  if (!server.includes(SERVER_MARKER)) problems.push("server proxy marker missing");
  if (!server.includes(`const DSH_ORBIT_PROXY_HOST = ${JSON.stringify(publicHost)};`)) {
    problems.push("server public host mismatch");
  }
  if (!client.includes(`hostname === ${JSON.stringify(publicHost)}`)) {
    problems.push("client public host missing");
  }
  if (problems.length) {
    throw new Error(`DSH Orbit verification failed for ${root}: ${problems.join(", ")}`);
  }
  return { root, status: "ok" };
}
