import { randomUUID } from "node:crypto";
import process from "node:process";
import { rpcEndpoint, rpcPayload, wireContractForGeneration } from "../src/dsh-wire-contract.mjs";

const baseUrl = process.env.DSH_SMOKE_URL;
const sessionId = process.env.DSH_SMOKE_SESSION_ID;

if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}
if (!sessionId) {
  console.error("DSH_SMOKE_SESSION_ID is required");
  process.exit(2);
}

// The smoke must be told which reviewed connection generation the candidate
// speaks; the endpoints and payload shapes follow from that generation's wire
// contract — never from a version comparison. The semantic goal is identical
// for both generations: a session created before the upgrade must resolve on
// the candidate, and its current model selection must be re-selectable through
// a safe, side-effect-free operation.
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
  const rpcId = `orbit-resume-smoke-${randomUUID()}`;
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
    const message = body.result?.error?.message || "RPC failed";
    const error = new Error(`${endpoint}: ${message}`);
    error.rpcCode = body.result?.error?.code;
    throw error;
  }
  return body.result.value;
}

function formatSelection(selection) {
  return `${selection.provider}/${selection.model}${
    selection.reasoningEffort ? `, reasoning=${selection.reasoningEffort}` : ""
  }`;
}

try {
  if (generation === "connection-v1") {
    const models = await rpc("session", "models", { sessionId });
    const current = models?.current;
    if (!current?.provider || !current?.model) {
      throw new Error("session models: current model selection is incomplete");
    }

    console.log(`session.models: ok (${formatSelection(current)})`);

    const selection = { sessionId, provider: current.provider, model: current.model };
    if (current.reasoningEffort) selection.reasoningEffort = current.reasoningEffort;

    await rpc("session", "selectModel", selection);
    console.log("session.selectModel: ok (existing-session resume)");
  } else {
    // The BrowserAuth generation exposes the session surface as Remotes. The
    // pre-upgrade session must appear in the candidate's own session listing —
    // that is the resolve step — and its recorded selection is re-selected
    // through session/selectModel, which forces the session to load without
    // changing the model choice or prompting any business side effect. There is
    // deliberately no fallback to the deployment-wide model catalog: a
    // historical session whose recorded selection cannot be recovered is
    // exactly the upgrade-continuity failure this smoke exists to catch, and
    // selecting the global default would launder it into a pass.
    const list = await rpc("session", "list", { _request: {} });
    const item = list?.items?.find((entry) => entry.sessionId === sessionId);
    if (!item) {
      throw new Error(
        `session list: pre-upgrade session ${JSON.stringify(sessionId)} was not resolvable on the candidate`,
      );
    }

    const selection =
      item.projections?.values?.modelSelection?.next
      ?? item.projections?.values?.modelSelection?.lastUsed;
    if (!selection?.provider || !selection?.model) {
      throw new Error(
        `session list: pre-upgrade session ${JSON.stringify(sessionId)} carries no recoverable model selection; ` +
          "existing-session continuity cannot be verified against the deployment-wide default",
      );
    }

    console.log(`session list: ok (${sessionId.slice(0, 8)}…, recorded selection: ${formatSelection(selection)})`);

    const request = { sessionId, provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort) request.reasoningEffort = selection.reasoningEffort;

    const selected = await rpc("session", "selectModel", { request });
    const applied = selected?.selected;
    if (applied?.provider !== selection.provider || applied?.model !== selection.model) {
      throw new Error(
        `session selectModel: candidate reported ${formatSelection(applied ?? {})} instead of ${formatSelection(selection)}`,
      );
    }
  }

  console.log("sessionResume: pass (existing session resumed on the candidate)");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("resume failed for session") &&
    message.includes("refusing to compose an unscoped context")
  ) {
    console.error(
      `Existing-session resume compatibility failure: ${message}`,
    );
    process.exit(1);
  }
  console.error(message);
  process.exit(1);
}
