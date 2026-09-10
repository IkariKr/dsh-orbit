import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { validateHubConfig } from "../src/registry/config.mjs";
import { normalizeAuthority, parseOriginAuthority, validateManagementAuthority } from "../src/registry/protocol.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { classifyHostAuthority } from "../src/registry/route-proxy.mjs";
import { createTestRegistry, createTestServer } from "./helpers/registry-fixture.mjs";

test("C8.4 authority grammar preserves explicit ports and rejects unsafe forms", () => {
  assert.equal(normalizeAuthority("REGISTRATION.Example:8443"), "registration.example:8443");
  assert.equal(normalizeAuthority("registration.example."), "registration.example");
  for (const value of ["https://registration.example", "registration.example/path", "registration.example?a=1", "user@registration.example", " registration.example", "registration..example", "registration.example:0", "registration.example:65536", "[::1]:8443"]) {
    assert.throws(() => normalizeAuthority(value), /authority|malformed|invalid|empty/);
  }
});

test("C8.4 management authority is outside the complete route namespace", () => {
  assert.equal(validateManagementAuthority("registration.example:8443", "dsh.example:8443"), "registration.example:8443");
  for (const value of ["dsh.example:8443", "admin.dsh.example:8443", "n-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dsh.example:8443"]) {
    assert.throws(() => validateManagementAuthority(value, "dsh.example:8443"), /routeDomain namespace/);
  }
  assert.match(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https", managementAuthority: "dsh.example:8443", routeDomain: "dsh.example:8443" }).join("\n"), /MANAGEMENT_AUTHORITY/);
});

test("C8.4 browser authority classifier has explicit management, selector, node, and unknown classes", () => {
  const route = "dsh.example:8443";
  assert.equal(classifyHostAuthority("registration.example:8443", route, "registration.example:8443").type, "management");
  assert.equal(classifyHostAuthority(route, route, "registration.example:8443").type, "selector-apex");
  assert.equal(classifyHostAuthority(`n-${"a".repeat(32)}.${route}`, route, "registration.example:8443").type, "node-route");
  assert.equal(classifyHostAuthority("unknown.example:8443", route, "registration.example:8443").type, "unrelated");
});

test("C8.4 raw Origin parser rejects implicit equivalence and unsupported authority forms", () => {
  assert.deepEqual(parseOriginAuthority("https://registration.example"), {
    scheme: "https",
    authority: "registration.example",
  });
  assert.deepEqual(parseOriginAuthority("https://registration.example:8443"), {
    scheme: "https",
    authority: "registration.example:8443",
  });
  assert.deepEqual(parseOriginAuthority("https://registration.example:443"), {
    scheme: "https",
    authority: "registration.example:443",
  });
  for (const value of [
    "https://bücher.example",
    "https://[::1]:8443",
    "https://user:pass@registration.example",
    "https://registration.example/path",
    "https://registration.example?query=1",
    "https://registration.example#fragment",
  ]) {
    assert.throws(() => parseOriginAuthority(value), /Origin|authority|malformed/);
  }
});

function requestWithHeaders(baseUrl, { path = "/api/v1/enroll", method = "POST", headers = {}, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("C8.4 browser authorities never enter the private machine API", async (t) => {
  const registry = createTestRegistry({ routeDomain: "dsh.example" });
  const server = await createTestServer(registry, {
    gatewayAssertionSecret: "authority-test-secret",
    operatorPrincipal: { mode: "single", principal: "operator" },
    managementAuthority: "registration.example",
  });
  t.after(async () => {
    await server.close();
    registry.close();
  });

  const management = await requestWithHeaders(server.baseUrl, {
    headers: { host: server.managementAuthority },
  });
  assert.equal(management.status, 404);
  assert.equal(management.body.error.code, "machine-ingress-private");

  const selector = await requestWithHeaders(server.baseUrl, {
    headers: { host: "dsh.example" },
  });
  assert.equal(selector.status, 404);
  assert.equal(selector.body.error.code, "machine-ingress-private");

  const node = await requestWithHeaders(server.baseUrl, {
    headers: { host: `n-${"a".repeat(32)}.dsh.example` },
  });
  assert.equal(node.status, 404);
  assert.equal(node.body.error.code, "machine-ingress-private");

  const privateIngress = await requestWithHeaders(server.baseUrl, {
    headers: { host: "registry-hub:5446" },
    body: JSON.stringify({ token: "ff".repeat(16), enrollmentRequestId: "aa".repeat(16), publicKey: "01".repeat(32) }),
  });
  assert.equal(privateIngress.status, 401);
  assert.equal(privateIngress.body.error.code, "unknown-token");
});

test("C8.4 createHubServer rejects default-port and IDNA Origin equivalence", async (t) => {
  const registry = createTestRegistry({ routeDomain: "dsh.example" });
  const { server } = createHubServer({
    registry,
    options: {
      gatewayAssertionSecret: "origin-test-secret",
      operatorPrincipal: { mode: "single", principal: "operator" },
      trustedExternalScheme: "https",
      managementAuthority: "registration.example",
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });

  const request = (origin) => requestWithHeaders(baseUrl, {
    path: "/hub/session",
    headers: {
      host: "registration.example",
      origin,
      "x-dsh-authenticated-proxy": "origin-test-secret",
      "x-dsh-operator-id": "operator",
      "sec-fetch-site": "same-origin",
    },
  });

  const valid = await request("https://registration.example");
  assert.equal(valid.status, 200);

  const defaultPort = await request("https://registration.example:443");
  assert.equal(defaultPort.status, 403);
  assert.equal(defaultPort.body.error.code, "origin-denied");

  const idna = await request("https://bücher.example");
  assert.equal(idna.status, 403);
  assert.equal(idna.body.error.code, "origin-denied");
});
