// Round-2 P2 (production listener fails closed): the machine surface
// (enrollment tokens, signatures) must never ride a public plain-HTTP
// bind, so non-loopback listens are refused unconditionally in v0.3.

import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackListen, validateHubConfig } from "../src/registry/config.mjs";

test("loopback listen addresses are accepted", () => {
  assert.equal(isLoopbackListen("127.0.0.1"), true);
  assert.equal(isLoopbackListen("::1"), true);
  assert.equal(isLoopbackListen("localhost"), true);
  assert.equal(isLoopbackListen("0.0.0.0"), false);
  assert.equal(isLoopbackListen("198.51.100.7"), false);
  assert.deepEqual(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "http" }), []);
});

test("any non-loopback bind refuses startup with no escape hatch", () => {
  const errors = validateHubConfig({ listen: "0.0.0.0", trustedExternalScheme: "http" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not loopback/);
  assert.match(errors[0], /refused/);
  // There is deliberately no override that re-allows a public bind.
  const again = validateHubConfig({ listen: "198.51.100.7", trustedExternalScheme: "https" });
  assert.equal(again.length, 1);
});

test("the trusted external scheme must be http or https", () => {
  assert.match(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "ftp" })[0], /TRUSTED_SCHEME/);
  assert.deepEqual(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https" }), []);
});

test("a missing listener value fails closed", () => {
  const errors = validateHubConfig({ listen: "", trustedExternalScheme: "http" });
  assert.equal(errors.length, 1);
});