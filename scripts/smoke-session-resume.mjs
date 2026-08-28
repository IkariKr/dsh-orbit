import { randomUUID } from "node:crypto";
import process from "node:process";

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

const headers = { "content-type": "application/json" };
if (process.env.DSH_SMOKE_BASIC_USER && process.env.DSH_SMOKE_BASIC_PASSWORD) {
  headers.authorization =
    "Basic " +
    Buffer.from(
      `${process.env.DSH_SMOKE_BASIC_USER}:${process.env.DSH_SMOKE_BASIC_PASSWORD}`,
    ).toString("base64");
}

async function rpc(method, payload) {
  const rpcId = `orbit-resume-smoke-${randomUUID()}`;
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
    const message = body.result?.error?.message || "RPC failed";
    const error = new Error(`${method}: ${message}`);
    error.rpcCode = body.result?.error?.code;
    throw error;
  }
  return body.result.value;
}

try {
  const models = await rpc("session.models", { sessionId });
  const current = models?.current;
  if (!current?.provider || !current?.model) {
    throw new Error("session.models: current model selection is incomplete");
  }

  console.log(
    `session.models: ok (${current.provider}/${current.model}${
      current.reasoningEffort ? `, reasoning=${current.reasoningEffort}` : ""
    })`,
  );

  const selection = {
    sessionId,
    provider: current.provider,
    model: current.model,
  };
  if (current.reasoningEffort) selection.reasoningEffort = current.reasoningEffort;

  await rpc("session.selectModel", selection);
  console.log("session.selectModel: ok (existing-session resume)");
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
