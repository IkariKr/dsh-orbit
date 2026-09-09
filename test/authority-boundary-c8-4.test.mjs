import assert from "node:assert/strict";
import test from "node:test";
import { validateHubConfig } from "../src/registry/config.mjs";
import { normalizeAuthority, validateManagementAuthority } from "../src/registry/protocol.mjs";
import { classifyHostAuthority } from "../src/registry/route-proxy.mjs";

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
