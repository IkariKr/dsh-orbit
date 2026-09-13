import { readFile, writeFile } from "node:fs/promises";
import { compatibilityFor } from "./compatibility.mjs";

const SERVER_MARKER = 'const DSH_ORBIT_PROXY_HEADER = "x-dsh-orbit-authenticated-proxy";';
const LEGACY_SERVER_MARKER = 'const REMOTE_PROXY_AUTH_HEADER = "x-dsh-authenticated-proxy";';

// The node:crypto import is the byte-exact anchor for a bundle layout: DSH
// 0.1.1-rc.2 imports randomUUID, and 0.1.2-rc.1 replaced it with the hashing
// primitives. The runtime auth block needs readFileSync, so the patch injects
// that import after the anchor. Selection is by reviewed generation rather than
// by version, and a missing anchor fails closed instead of producing a silently
// unpatched client.
const CRYPTO_IMPORT_V1 = 'import { randomUUID } from "node:crypto";\n';
const CRYPTO_IMPORT_V2 = 'import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";\n';
const FS_IMPORT = 'import { readFileSync } from "node:fs";\n';

const TRUSTED_AUTHORITY_GATE =
  "\tif (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;\n";
const TRUST_FENCE_REJECTION = "\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n";
const BROWSER_AUTH_DELEGATE = "\t\treturn this.browserAuth.authorizeIndex(request, response);\n";

// Reviewed patch generations. `install` names the shape of the reviewed edit:
//
//   "fence"           Extend isTrustedApiRequest(), the only admission point on
//                     0.1.1-rc.2, so the Orbit proof also satisfies the fence.
//                     Native BrowserAuth does not exist in that generation.
//   "host-connection" Add a second authentication path inside
//                     HostConnectionService after the trust fence, and admit a
//                     tokenless index request. Native `?token=` exchange and
//                     cookie BrowserAuth keep their original behaviour.
//
// A generation with `install: null` records a reviewed bundle layout without an
// installable edit. connection-v2 is the 0.1.2+ layout discovered during the
// 0.1.2-rc.1 investigation, where the fence edit is known to be insufficient
// because BrowserAuth still rejects the request, so no version selects it.
//
// `requires` are byte-exact declarations the generated helper binds to. They
// turn a renamed upstream symbol into a patch-time failure instead of a runtime
// ReferenceError inside the authentication path.
const CONNECTION_GENERATIONS = Object.freeze({
  "connection-v1": Object.freeze({
    importAnchor: CRYPTO_IMPORT_V1,
    install: "fence",
    headerHelper: "header",
    resolveHost: false,
    requires: Object.freeze([]),
  }),
  "connection-v2": Object.freeze({
    importAnchor: CRYPTO_IMPORT_V2,
    install: null,
    headerHelper: "header$1",
    resolveHost: true,
    requires: Object.freeze([]),
  }),
  "connection-browser-auth-v1": Object.freeze({
    importAnchor: CRYPTO_IMPORT_V2,
    install: "host-connection",
    headerHelper: "header$1",
    resolveHost: true,
    requires: Object.freeze([
      "function header$1(headers, name) {",
      "function parseAuthority(authority) {",
      'const TOKEN_QUERY = "token";',
    ]),
  }),
});

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

export function validateHost(publicHost) {
  if (!publicHost || typeof publicHost !== "string") {
    throw new Error("DSH_PUBLIC_HOST is required");
  }
  if (publicHost.includes("://") || publicHost.includes("/") || /\s/.test(publicHost)) {
    throw new Error("DSH_PUBLIC_HOST must be a bare hostname");
  }
}

// The reviewed patch generation selected for a version, so a caller verifying a
// patched tree checks the same admission shape the patch installed.
export function connectionPatchFor(dshVersion) {
  return compatibilityFor(dshVersion).connectionPatch;
}

// The generated admission helper. It reuses the bundle's own authority parser
// and header reader so it never invents a second Host parser, and it validates
// the public host, the forwarded scheme, the shared Orbit secret, and the
// same-origin browser markers before admitting a request.
function orbitAuthBlock({ publicHost, proxyAuthFile, headerHelper, resolveHost }) {
  const header = (name) => `${headerHelper}(request.headers, ${name})`;
  const signature = resolveHost
    ? "function isDshOrbitAuthenticatedProxyRequest(request) {"
    : "function isDshOrbitAuthenticatedProxyRequest(request, hostUrl) {";
  const resolveLines = resolveHost
    ? `\tconst host = ${header('"host"')};\n` +
      "\tif (host === void 0) return false;\n" +
      "\tconst hostUrl = parseAuthority(host);\n" +
      "\tif (hostUrl === void 0) return false;\n"
    : "";

  return `
${SERVER_MARKER}
const DSH_ORBIT_PROXY_HOST = ${JSON.stringify(publicHost)};
const DSH_ORBIT_PROXY_PROTO = "https";
let dshOrbitProxySecret = "";
try {
\tdshOrbitProxySecret = readFileSync(${JSON.stringify(proxyAuthFile)}, "utf8").trim();
} catch {
\tdshOrbitProxySecret = "";
}
${signature}
\tif (dshOrbitProxySecret === "") return false;
${resolveLines}\tif (hostUrl.hostname !== DSH_ORBIT_PROXY_HOST) return false;
\tif (${header('"x-forwarded-proto"')} !== DSH_ORBIT_PROXY_PROTO) return false;
\tif (${header("DSH_ORBIT_PROXY_HEADER")} !== dshOrbitProxySecret) return false;
\tif (${header('"sec-fetch-site"')} === "cross-site") return false;
\tconst origin = ${header('"origin"')};
\tif (origin === void 0) return true;
\ttry {
\t\treturn new URL(origin).host === hostUrl.host;
\t} catch {
\t\treturn false;
\t}
}
`;
}

// Admit the Orbit proof as a second authentication path. It runs only after
// isTrustedApiRequest() has accepted the Host, so it cannot loosen the trust
// fence; a request that fails the fence still receives 403 before this runs.
function installHostConnectionPath(source) {
  source = replaceExactlyOnce(
    source,
    TRUST_FENCE_REJECTION,
    TRUST_FENCE_REJECTION +
      "\t\tif (isDshOrbitAuthenticatedProxyRequest(request)) return void 0;\n",
    "requestRejection trust fence",
  );

  // A request carrying the native `?token=` query keeps DSH's own exchange
  // (valid token, invalid token, multi-token, 303 + Set-Cookie, 401) untouched.
  // Orbit only adds a tokenless gateway path.
  source = replaceExactlyOnce(
    source,
    BROWSER_AUTH_DELEGATE,
    "\t\tconst url = new URL(request.url ?? \"/\", \"http://dsh.invalid\");\n" +
      "\t\tif (url.searchParams.getAll(TOKEN_QUERY).length === 0 && isDshOrbitAuthenticatedProxyRequest(request)) return true;\n" +
      BROWSER_AUTH_DELEGATE,
    "authorizeIndex BrowserAuth delegate",
  );

  return source;
}

function patchServer(source, { publicHost, proxyAuthFile, connectionPatch }) {
  if (source.includes(SERVER_MARKER)) {
    return { source, changed: false };
  }

  const authBlock = orbitAuthBlock({
    publicHost,
    proxyAuthFile,
    headerHelper: "header",
    resolveHost: false,
  });

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

  const generation = CONNECTION_GENERATIONS[connectionPatch];
  if (generation === undefined) {
    throw new Error(
      `DSH Orbit patch failed: unknown connection patch profile ${JSON.stringify(connectionPatch)}`,
    );
  }
  if (generation.install === null) {
    throw new Error(
      `DSH Orbit patch failed: connection patch profile ${JSON.stringify(connectionPatch)} ` +
        "records a reviewed bundle layout only and has no reviewed install shape",
    );
  }
  for (const required of generation.requires) {
    if (!source.includes(required)) {
      throw new Error(
        `DSH Orbit patch failed: missing ${JSON.stringify(required)} required by ${connectionPatch}`,
      );
    }
  }

  const generationAuthBlock = orbitAuthBlock({
    publicHost,
    proxyAuthFile,
    headerHelper: generation.headerHelper,
    resolveHost: generation.resolveHost,
  });

  source = replaceExactlyOnce(
    source,
    generation.importAnchor,
    generation.importAnchor + FS_IMPORT,
    "client-connection crypto import",
  );

  source = replaceExactlyOnce(
    source,
    "function isTrustedApiRequest(request, trustedHosts) {",
    `${generationAuthBlock}\nfunction isTrustedApiRequest(request, trustedHosts) {`,
    "isTrustedApiRequest declaration",
  );

  if (generation.install === "fence") {
    source = replaceExactlyOnce(
      source,
      TRUSTED_AUTHORITY_GATE,
      "\tif (isDshOrbitAuthenticatedProxyRequest(request, hostUrl)) return true;\n" + TRUSTED_AUTHORITY_GATE,
      "trusted authority gate",
    );
  } else {
    source = installHostConnectionPath(source);
  }

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

async function applyConnectionPatch({ root, connectionPatch, publicHost, proxyAuthFile }) {
  validateHost(publicHost);

  const serverPath = `${root}/index.js`;
  const clientPath = `${root}/client.js`;
  const [serverSource, clientSource] = await Promise.all([
    readFile(serverPath, "utf8"),
    readFile(clientPath, "utf8"),
  ]);

  const server = patchServer(serverSource, {
    publicHost,
    proxyAuthFile,
    connectionPatch,
  });
  const client = patchClient(clientSource, { publicHost });

  if (server.changed) await writeFile(serverPath, server.source, "utf8");
  if (client.changed) await writeFile(clientPath, client.source, "utf8");

  return {
    root,
    server: server.changed ? "patched" : "ok",
    client: client.changed ? "patched" : "ok",
  };
}

export async function patchConnectionRoot({ root, dshVersion, publicHost, proxyAuthFile }) {
  return applyConnectionPatch({
    root,
    connectionPatch: compatibilityFor(dshVersion).connectionPatch,
    publicHost,
    proxyAuthFile,
  });
}

// Patch one root for an explicit reviewed generation. Version-to-generation
// selection stays in compatibilityFor(), so this exists to exercise a
// generation on its real bundle before any DSH version is allowed to select it.
export async function patchConnectionRootForGeneration({ root, connectionPatch, publicHost, proxyAuthFile }) {
  return applyConnectionPatch({ root, connectionPatch, publicHost, proxyAuthFile });
}

export async function verifyConnectionRoot({ root, publicHost, connectionPatch }) {
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
  // When the generation is known, also prove the admission path is wired into
  // the expected decision points and that native BrowserAuth survives the edit.
  if (connectionPatch !== undefined) {
    const generation = CONNECTION_GENERATIONS[connectionPatch];
    if (generation === undefined) {
      problems.push(`unknown connection patch profile ${JSON.stringify(connectionPatch)}`);
    } else if (generation.install === "host-connection") {
      if (!server.includes("\t\tif (isDshOrbitAuthenticatedProxyRequest(request)) return void 0;\n")) {
        problems.push("requestRejection does not admit the authenticated proxy proof");
      }
      if (
        !server.includes(
          "url.searchParams.getAll(TOKEN_QUERY).length === 0 && isDshOrbitAuthenticatedProxyRequest(request)) return true;",
        )
      ) {
        problems.push("authorizeIndex does not admit the tokenless authenticated proxy proof");
      }
      if (!server.includes(BROWSER_AUTH_DELEGATE)) {
        problems.push("authorizeIndex no longer delegates to native BrowserAuth");
      }
      if (!server.includes("\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n")) {
        problems.push("requestRejection no longer enforces native BrowserAuth");
      }
    }
  }
  if (problems.length) {
    throw new Error(`DSH Orbit verification failed for ${root}: ${problems.join(", ")}`);
  }
  return { root, status: "ok" };
}
