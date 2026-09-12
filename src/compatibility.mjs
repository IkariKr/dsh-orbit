// Reviewed DSH compatibility profiles.
//
// Each profile is exact-match and names the byte-exact patch generation that
// was reviewed for it. A version is only supported when it appears here with a
// reviewed connection patch; the runtime patch and capability derivation never
// key off version comparisons, so a new upstream release cannot inherit trust
// from a version number alone. One Orbit release selects one shipping baseline.
export const compatibilityProfiles = Object.freeze({
  "0.1.1-rc.2": Object.freeze({
    connectionPatch: "connection-v1",
    status: "tested",
  }),
});

// Investigated without being adopted. These versions have reviewed patch
// knowledge attached (see the connection-v2 import anchor) but are deliberately
// not baselines, so nothing about them may be claimed as supported until a real
// runtime acceptance passes. 0.1.2-rc.1 reached the WebSocket contract and
// failed it, and the same bundle generation continues upstream, so it is kept
// as a reference point for the 0.1.5 investigation rather than as a target.
export const INVESTIGATION_ONLY_DSH_VERSIONS = Object.freeze(["0.1.2-rc.1"]);

export function compatibilityFor(version) {
  const profile = compatibilityProfiles[version];
  if (!profile) {
    const supported = Object.keys(compatibilityProfiles).join(", ");
    throw new Error(
      `Unsupported DeepSeek Harness version ${JSON.stringify(version)}. ` +
        `Tested versions: ${supported || "none"}.`,
    );
  }
  return profile;
}
