import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { patchDshSshPlugin } from "../../src/plugin-patch-dsh-ssh.mjs";

export const FENCE_PUBLIC_HOST = "dsh.example.com";

export function sshPluginFixtureSource() {
  return [
    'import { randomUUID } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { Client } from "ssh2";',
    "",
    "function isLoopbackRequest(request) {",
    "\tif (!isLoopbackAddress(request.socket.remoteAddress)) return false;",
    "\tconst host = request.headers.host;",
    "\tif (typeof host !== \"string\") return false;",
    "\tlet hostUrl;",
    "\ttry {",
    "\t\thostUrl = new URL(\"http://\" + host);",
    "\t} catch {",
    "\t\treturn false;",
    "\t}",
    "\tif (!isLoopbackHostname(hostUrl.hostname)) return false;",
    "\tif (request.headers[\"sec-fetch-site\"] === \"cross-site\") return false;",
    "\tconst origin = request.headers.origin;",
    "\tif (origin === void 0) return true;",
    "\ttry {",
    "\t\treturn new URL(origin).host === hostUrl.host;",
    "\t} catch {",
    "\t\treturn false;",
    "\t}",
    "}",
    "",
    "const guard = (req, res, method) => {",
    "\tif (!isLoopbackRequest(req)) {",
    '\t\twriteJson(res, 403, { error: "forbidden: loopback-only" });',
    "\t\treturn false;",
    "\t}",
    "\treturn true;",
    "};",
    "",
    "async function hostsRoute(req, res) {",
    "\tif (!isLoopbackRequest(req)) {",
    '\t\twriteJson(res, 403, { error: "forbidden: loopback-only" });',
    "\t\treturn;",
    "\t}",
    "}",
    "",
    "const upgrade = {",
    "\thandler: (req, socket, head) => {",
    "\t\tif (!isLoopbackRequest(req)) {",
    '\t\t\tsocket.write("HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n");',
    "\t\t\tsocket.destroy();",
    "\t\t\treturn;",
    "\t\t}",
    "\t},",
    "};",
    "",
  ].join("\n");
}

/**
 * Creates a plugin fixture rooted at dir, patches it with the fence helper,
 * and returns an importable module URL plus the proxy secret value.
 */
export async function createPatchedFenceModule(dir) {
  const fenceSecret = "orbit-proxy-" + "value";
  await mkdir(join(dir, "plugins", "@linxin666", "dsh-ssh", "lib"), { recursive: true });
  await writeFile(
    join(dir, "plugins", "@linxin666", "dsh-ssh", "package.json"),
    JSON.stringify({ name: "@linxin666/dsh-ssh", version: "0.3.2" }, null, 2),
    "utf8",
  );
  await writeFile(join(dir, "secret.txt"), fenceSecret, "utf8");
  const pluginRoot = join(dir, "plugins", "@linxin666", "dsh-ssh");
  await writeFile(join(pluginRoot, "lib", "index.js"), sshPluginFixtureSource(), "utf8");
  await patchDshSshPlugin({
    root: pluginRoot,
    publicHost: FENCE_PUBLIC_HOST,
    proxyAuthFile: join(dir, "secret.txt"),
  });
  let patched = await readFile(join(pluginRoot, "lib", "index.js"), "utf8");
  patched = patched.replace('import { Client } from "ssh2";\n', "");
  const modulePath = join(dir, "fence.mjs");
  await writeFile(modulePath, patched + "\nexport { isDshOrbitAuthenticatedProxyRequest };\n", "utf8");
  return { moduleUrl: pathToFileURL(modulePath).href, secret: fenceSecret };
}

export async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "orbit-ssh-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}