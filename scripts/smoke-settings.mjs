import process from "node:process";
import { randomUUID } from "node:crypto";
import { rpcEndpoint, rpcPayload, wireContractForGeneration } from "../src/dsh-wire-contract.mjs";

const baseUrl = process.env.DSH_SMOKE_URL;
if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}

// The smoke must be told which reviewed connection generation the candidate
// speaks. Endpoint names and payload shapes follow from that generation's wire
// contract — never from a version comparison, which would let an unreviewed
// release inherit a vocabulary that was never validated for it.
const generation = process.env.DSH_SMOKE_CONNECTION_PATCH;
if (!generation) {
  console.error(
    "DSH_SMOKE_CONNECTION_PATCH is required: set it to the candidate's reviewed connection patch generation " +
      "(connection-v1 or connection-browser-auth-v1)",
  );
  process.exit(2);
}
let contract;
try {
  contract = wireContractForGeneration(generation);
} catch (error) {
  console.error(error.message);
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

async function rpc(namespace, method, args) {
  const endpoint = rpcEndpoint(contract, namespace, method);
  const rpcId = `orbit-smoke-${randomUUID()}`;
  const response = await fetch(new URL(`/api/${endpoint}`, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: endpoint,
      payload: rpcPayload(contract, args),
    }),
  });
  if (!response.ok) {
    throw new Error(`${endpoint}: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId mismatch`);
  if (!body.result?.ok) {
    throw new Error(`${endpoint}: ${body.result?.error?.message || "RPC failed"}`);
  }
  return body.result.value;
}

const view = await rpc("settings", "describe", {});
if (!view?.writable) throw new Error("settings describe: settings provider is not writable");
if (!Array.isArray(view.namespaces) || view.namespaces.length === 0) {
  throw new Error("settings describe: no settings namespaces returned");
}

const requestedNamespace = process.env.DSH_SMOKE_NAMESPACE;
const namespace = requestedNamespace
  ? view.namespaces.find((entry) => entry.ns === requestedNamespace)
  : view.namespaces[0];
if (!namespace) {
  throw new Error(`settings namespace ${JSON.stringify(requestedNamespace)} was not found`);
}

console.log(`settingsRead: pass (describe returned ${view.namespaces.length} namespaces)`);

await rpc("settings", "mutate", {
  ns: namespace.ns,
  ops: [],
  expectedRevision: namespace.revision,
});

console.log(`settingsNoopWrite: pass (no-op mutate on ${namespace.ns} accepted)`);
