import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, ROOT), "utf8");

const FROZEN_CANDIDATE = "d359a90165ad7bfeeee76d0dd47c2e5212ae6414";
const PINNED_DSH = "fb2c4b9e698e30edb738bca4cf0618587db7d203";
const QUALIFICATION_SESSION = "session-763ddc3d-1bdf-4f15-9d2b-da3fc57da53d";
const SNAPSHOT_SHA256 = "5ac6d4aa2dcd6beb176ad20249bddc67d5489ddb05f5a163f7800f1aa8a05d49";
const REPORT_SHA256 = "4da0f0c5b2797cab3a43e8450c81f61d1dd9f1536c00115aa3d84f83a6eeb4bb";
const EVIDENCE_SHA256 = "d5dd4aac9063c9a299b40695076e6a64261ea6f96ffca0b8506c7a0cb9416ad6";

// E9 publication is deliberately records-only: the executable that passed the
// qualification remains the independently reviewed frozen candidate above.
test("E9 publication binds the SUPPORTED claim to the frozen executable and evidence", async () => {
  const [readme, compatibility, policy, attestation] = await Promise.all([
    text("README.md"),
    text("docs/compatibility.md"),
    text("docs/dsh-version-policy.md"),
    text("docs/release-attestations/v0.4.1-e9-qualification.md"),
  ]);

  assert.match(readme, /0\.1\.5-rc\.2.*SUPPORTED/is);
  assert.doesNotMatch(readme, /0\.1\.5-rc\.2[^\n]*qualification pending/i);

  assert.match(compatibility, /\| `0\.1\.5-rc\.2` \| `v0\.4\.1` .*\| `SUPPORTED` \|/);
  assert.match(policy, /Qualification status:\*\* complete/i);
  assert.match(policy, /0\.1\.5-rc\.2\s+SUPPORTED shipping baseline/);

  for (const value of [
    FROZEN_CANDIDATE,
    PINNED_DSH,
    QUALIFICATION_SESSION,
    SNAPSHOT_SHA256,
    REPORT_SHA256,
    EVIDENCE_SHA256,
  ]) {
    assert.match(attestation, new RegExp(value), `attestation must bind ${value}`);
  }
  assert.match(attestation, /FINAL REVIEW: PASS - FREEZE APPROVED/);
  assert.match(attestation, /candidate.*PASS/is);
  assert.match(attestation, /verify.*PASS/is);
  assert.match(attestation, /not.*production.*promotion/is);
});
