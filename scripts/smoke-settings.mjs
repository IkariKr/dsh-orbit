import process from "node:process";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.DSH_SMOKE_URL;
if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}

const headers = { "content-type": "application/json" };
if (process.env.DSH_SMOKE_BASIC_USER && process.env.DSH_SMOKE_BASIC_PASSWORD) {
  headers.authorization =
    "Basic " +
    Buffer.from(
      `${process.env.DSH_SMOKE_BASIC_USER}:${process.env.DSH_SMOKE_BASIC_PASSWORD}`,
    ).toString("base64");
}

async function rpc(method, payload) {
  const rpcId = `orbit-smoke-${randomUUID()}`;
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method,
      payload,
    }),
  });
  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.rpcId !== rpcId) throw new Error(`${method}: rpcId mismatch`);
  if (!body.result?.ok) {
    throw new Error(`${method}: ${body.result?.error?.message || "RPC failed"}`);
  }
  return body.result.value;
}

const view = await rpc("settings.describe", {});
if (!view?.writable) throw new Error("settings.describe: settings provider is not writable");
if (!Array.isArray(view.namespaces) || view.namespaces.length === 0) {
  throw new Error("settings.describe: no settings namespaces returned");
}

const requestedNamespace = process.env.DSH_SMOKE_NAMESPACE;
const namespace = requestedNamespace
  ? view.namespaces.find((entry) => entry.ns === requestedNamespace)
  : view.namespaces[0];
if (!namespace) {
  throw new Error(`settings namespace ${JSON.stringify(requestedNamespace)} was not found`);
}

await rpc("settings.mutate", {
  ns: namespace.ns,
  ops: [],
  expectedRevision: namespace.revision,
});

console.log(`settings.describe: ok (${view.namespaces.length} namespaces)`);
console.log(`settings.mutate: ok (${namespace.ns}, no-op)`);
