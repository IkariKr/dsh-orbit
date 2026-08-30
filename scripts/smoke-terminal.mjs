import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import process from "node:process";

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

function upgradeHeaders() {
  return {
    connection: "upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": Buffer.from(randomUUID().replaceAll("-", "")).toString("base64"),
  };
}

function probe(headers) {
  return new Promise((resolve) => {
    const target = new URL(
      "/api/dsh-ssh/terminal?alias=orbit-acceptance&cols=80&rows=24",
      baseUrl,
    );
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(
      target,
      { method: "GET", headers: { ...upgradeHeaders(), ...headers } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode;
          if (status >= 500) {
            resolve({ outcome: "error", detail: `HTTP ${status} server error` });
            return;
          }
          if (status === 400) {
            resolve({ outcome: "allowed", detail: "HTTP 400 after gate admission" });
            return;
          }
          if (status === 401 || status === 403) {
            resolve({ outcome: "denied", detail: `HTTP ${status}` });
            return;
          }
          resolve({ outcome: "denied", detail: `HTTP ${status}` });
        });
      },
    );
    // a WS admission answers 101, which Node surfaces through 'upgrade'
    // rather than 'response'
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ outcome: "allowed", detail: "HTTP 101 upgrade admitted" });
    });
    request.on("error", (error) => {
      resolve({ outcome: "error", detail: redact(error?.cause?.code ?? error?.message ?? error) });
    });
    request.end();
  });
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
    name: "authenticated same-origin terminal upgrade",
    expect: "allowed",
    headers: {
      authorization: basicAuth(validCredentials),
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "unauthenticated terminal upgrade",
    expect: "denied",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "invalid Basic credentials on terminal upgrade",
    expect: "denied",
    headers: {
      authorization: basicAuth(invalidCredentials),
      origin,
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "unexpected Origin on terminal upgrade",
    expect: "denied",
    headers: {
      authorization: basicAuth(validCredentials),
      origin: "https://orbit-terminal-smoke-invalid.example.com",
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "Sec-Fetch-Site: cross-site on terminal upgrade",
    expect: "denied",
    headers: {
      authorization: basicAuth(validCredentials),
      origin,
      "sec-fetch-site": "cross-site",
    },
  },
  {
    name: "forged Cf-Access-Jwt-Assertion on terminal upgrade",
    expect: "denied",
    headers: {
      "cf-access-jwt-assertion": "orbit-terminal-smoke-forged-assertion",
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
  console.error(`terminal smoke: FAIL (${failures} of ${cases.length} cases mismatched)`);
  process.exitCode = 1;
} else {
  console.log(`terminal smoke: PASS (${cases.length}/${cases.length} cases matched)`);
}