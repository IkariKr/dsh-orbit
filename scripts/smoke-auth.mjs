import process from "node:process";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.DSH_SMOKE_URL;
const user = process.env.DSH_SMOKE_BASIC_USER;
const basicPassword = process.env.DSH_SMOKE_BASIC_PASSWORD;

if (!baseUrl) {
  console.error("DSH_SMOKE_URL is required, for example https://dsh.example.com");
  process.exit(2);
}
if (!user || !basicPassword) {
  console.error(
    "DSH_SMOKE_BASIC_USER and DSH_SMOKE_BASIC_PASSWORD are required: the positive control and the credential cases use the gateway's local Basic Auth path",
  );
  process.exit(2);
}

const invalidPassword = `${basicPassword}-orbit-smoke-invalid`;
const validCredentials = `${user}:${basicPassword}`;
const invalidCredentials = `${user}:${invalidPassword}`;

function redact(value) {
  let text = String(value);
  for (const secret of [
    basicPassword,
    invalidPassword,
    validCredentials,
    invalidCredentials,
    Buffer.from(validCredentials).toString("base64"),
    Buffer.from(invalidCredentials).toString("base64"),
  ]) {
    text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

function basicAuth(credentials) {
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function probe(headers) {
  const rpcId = `orbit-auth-smoke-${randomUUID()}`;
  let response;
  try {
    response = await fetch(new URL("/api/settings.describe", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close", ...headers },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: "settings.describe",
        payload: {},
      }),
    });
  } catch (error) {
    return { outcome: "error", detail: redact(error?.cause?.code ?? error?.message ?? error) };
  }
  if (response.status >= 500) {
    await response.text().catch(() => "");
    return { outcome: "error", detail: `HTTP ${response.status} server error` };
  }
  if (response.status !== 200) {
    await response.text().catch(() => "");
    return { outcome: "denied", detail: `HTTP ${response.status}` };
  }
  const body = await response.json().catch(() => null);
  if (body?.result?.ok === true) {
    return { outcome: "allowed", detail: "HTTP 200 with ok result" };
  }
  const message = body?.result?.error?.message;
  return {
    outcome: "denied",
    detail: message ? `RPC error: ${redact(message)}` : `HTTP 200 without ok result`,
  };
}

const originOverride = process.env.DSH_SMOKE_ORIGIN;
let origin;
if (originOverride) {
  try {
    origin = new URL(originOverride).origin;
  } catch {
    origin = "null";
  }
  if (origin === "null") {
    console.error("DSH_SMOKE_ORIGIN must be an absolute origin, for example https://dsh.example.com");
    process.exit(2);
  }
} else {
  origin = new URL(baseUrl).origin;
}

const cases = [
  {
    name: "authenticated same-origin settings.describe",
    expect: "allowed",
    headers: {
      authorization: basicAuth(validCredentials),
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "unauthenticated privileged RPC",
    expect: "denied",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "invalid Basic credentials",
    expect: "denied",
    headers: {
      authorization: basicAuth(invalidCredentials),
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "unexpected Origin",
    expect: "denied",
    headers: {
      authorization: basicAuth(validCredentials),
      origin: "https://orbit-auth-smoke-invalid.example.com",
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "Sec-Fetch-Site: cross-site",
    expect: "denied",
    headers: {
      authorization: basicAuth(validCredentials),
      origin,
      "sec-fetch-site": "cross-site",
    },
  },
  {
    name: "forged Cf-Access-Jwt-Assertion",
    expect: "denied",
    headers: {
      "cf-access-jwt-assertion": "orbit-auth-smoke-forged-assertion",
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
];

let failures = 0;
for (const testCase of cases) {
  const { outcome, detail } = await probe(testCase.headers);
  if (outcome === testCase.expect) {
    console.log(`PASS ${testCase.expect}: ${testCase.name} (${detail})`);
  } else if (outcome === "error") {
    failures += 1;
    console.error(`FAIL ${testCase.name}: request error, expected ${testCase.expect} (${detail})`);
  } else {
    failures += 1;
    console.error(`FAIL ${testCase.name}: expected ${testCase.expect}, got ${outcome} (${detail})`);
  }
}

if (failures > 0) {
  console.error(`authorization smoke: FAIL (${failures} of ${cases.length} cases mismatched)`);
  process.exitCode = 1;
} else {
  console.log(`authorization smoke: PASS (${cases.length}/${cases.length} cases matched)`);
}
