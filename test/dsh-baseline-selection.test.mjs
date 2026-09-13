// Baseline selection contract for the promoted DSH compatibility profile.
//
// `compatibilityProfiles` is simultaneously the release's baseline declaration
// and the runtime gate `deriveCapabilities()` consults, so adding a baseline is
// a release-level act. These assertions pin the promotion itself: exactly one
// shipping baseline, named explicitly, with a reviewed patch generation that
// exists in the patch module.

import assert from "node:assert/strict";
import test from "node:test";

import { compatibilityFor, compatibilityProfiles } from "../src/compatibility.mjs";
import { deriveCapabilities } from "../src/registry/capabilities.mjs";
import { connectionPatchFor } from "../src/remote-settings-patch.mjs";

const SHIPPING_BASELINE = "0.1.5-rc.2";
const HISTORICAL_BASELINE = "0.1.1-rc.2";

test("exactly one profile is the shipping baseline", () => {
  const shipping = Object.entries(compatibilityProfiles)
    .filter(([, profile]) => profile.status === "tested")
    .map(([version]) => version);
  assert.deepEqual(
    shipping,
    [SHIPPING_BASELINE],
    "one Orbit release selects exactly one shipping baseline",
  );
});

test("the shipping baseline names the reviewed BrowserAuth patch generation", () => {
  assert.deepEqual(compatibilityProfiles[SHIPPING_BASELINE], {
    connectionPatch: "connection-browser-auth-v1",
    status: "tested",
  });
  assert.equal(connectionPatchFor(SHIPPING_BASELINE), "connection-browser-auth-v1");
});

test("the historical baseline is retained as legacy, not claimed", () => {
  assert.deepEqual(compatibilityProfiles[HISTORICAL_BASELINE], {
    connectionPatch: "connection-v1",
    status: "legacy",
  });
  // Retained means still selectable for patch and upgrade flows, so an existing
  // deployment on it keeps working across the baseline change.
  assert.equal(connectionPatchFor(HISTORICAL_BASELINE), "connection-v1");
});

test("every profile declares a known status", () => {
  const statuses = new Set(["tested", "legacy"]);
  for (const [version, profile] of Object.entries(compatibilityProfiles)) {
    assert.ok(statuses.has(profile.status), `${version} declares unknown status ${JSON.stringify(profile.status)}`);
  }
});

test("the shipping baseline earns web.routes from a passing report", () => {
  const passingWebChecks = {
    runtimeReadiness: { status: "pass" },
    webPluginRoutes: { status: "pass" },
    webSocketTransport: { status: "pass" },
  };
  const names = (version) =>
    deriveCapabilities({ candidate: { dshVersion: version }, checks: passingWebChecks }).map((c) => c.name);

  assert.ok(
    names(SHIPPING_BASELINE).includes("web.routes"),
    "the promoted baseline must be capability-granted, or the promotion changes nothing at runtime",
  );
  // The other half of the design decision: retaining 0.1.1-rc.2 as legacy is
  // specifically meant to keep an existing deployment working across the
  // baseline change, so the contract must lock the capability in directly
  // rather than only asserting that its patch generation still resolves.
  assert.ok(
    names(HISTORICAL_BASELINE).includes("web.routes"),
    "a retained legacy baseline must stay capability-granted across the promotion",
  );
  // An investigated-but-unadopted version stays ineligible even with perfect
  // evidence, which is the whole point of keeping it out of the profile map.
  assert.deepEqual(names("0.1.2-rc.1"), []);
});

test("compatibilityFor fails closed for a version with no reviewed profile", () => {
  for (const version of ["0.1.2-rc.1", "0.1.5-rc.1", "9.9.9", ""]) {
    assert.throws(() => compatibilityFor(version), /Unsupported DeepSeek Harness version/);
  }
});
