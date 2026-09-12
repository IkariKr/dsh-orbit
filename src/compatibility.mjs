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
// knowledge attached (the connection-v2 import anchor) but are deliberately not
// baselines, so nothing about them may be claimed as supported until a real
// runtime acceptance passes.
//
// 0.1.2-rc.1 opened the BrowserAuth + /api/remote.mux transport generation: the
// legacy two downlink-only WebSockets (/api/events.mux, /api/events.host) are
// gone and replaced by one multiplexed /api/remote.mux, and an authenticated
// browser session (or an accepted proxy proof) is now required ahead of
// endpoint dispatch. The previous Orbit acceptance still targeted the legacy
// contract, so it failed for a generation-level reason, not a transport defect.
// The version stays investigation-only until that authentication and transport
// contract is validated; 0.1.5-rc.2 shares the same generation and is the
// compatibility candidate.
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
