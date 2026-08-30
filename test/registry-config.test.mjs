// Batch D acceptance (P2-05): hub listener and trusted-scheme
// configuration fails closed at preflight time.

import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackListen, validateHubConfig } from "../src/registry/config.mjs";

test("loopback listen addresses are accepted without an explicit public mode", () => {
  assert.equal(isLoopbackListen("127.0.0.1"), true);
  assert.equal(isLoopbackListen("::1"), true);
  assert.equal(isLoopbackListen("localhost"), true);
  assert.equal(isLoopbackListen("0.0.0.0"), false);
  assert.equal(isLoopbackListen("198.51.100.7"), false);
  assert.deepEqual(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "http", publicListener: false }), []);
});

test("a non-loopback plain-HTTP bind refuses startup without the explicit trusted mode", () => {
  const errors = validateHubConfig({ listen: "0.0.0.0", trustedExternalScheme: "http", publicListener: false });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not loopback/);
  assert.match(errors[0], /DSH_ORBIT_HUB_PUBLIC_LISTENER=1/);
  assert.deepEqual(validateHubConfig({ listen: "0.0.0.0", trustedExternalScheme: "http", publicListener: true }), []);
});

test("the trusted external scheme must be http or https", () => {
  assert.match(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "ftp", publicListener: false })[0], /TRUSTED_SCHEME/);
  assert.deepEqual(validateHubConfig({ listen: "127.0.0.1", trustedExternalScheme: "https", publicListener: false }), []);
});

test("a missing listener value fails closed", () => {
  const errors = validateHubConfig({ listen: "", trustedExternalScheme: "http", publicListener: false });
  assert.equal(errors.length, 1);
});