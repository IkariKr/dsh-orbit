// Reviewed DSH compatibility profiles.
//
// Each profile is exact-match and names the byte-exact patch generation that
// was reviewed for it. A version is only accepted when it appears here with a
// reviewed connection patch; the runtime patch and capability derivation never
// key off version comparisons, so a new upstream release cannot inherit trust
// from a version number alone.
//
// `status` records what this Orbit release claims for the version:
//
//   "tested"  The shipping baseline. One Orbit release selects exactly one, and
//             it is the version the release guarantees are written against.
//   "legacy"  A previously validated baseline, retained so existing deployments
//             stay capability-granted and so the prior release's evidence stays
//             reproducible. It may keep working, but this release neither
//             validates it nor claims it.
//
// v0.4.1 ships 0.1.5-rc.2. 0.1.1-rc.2 stays as the historical v0.4.0 baseline.
export const compatibilityProfiles = Object.freeze({
  "0.1.5-rc.2": Object.freeze({
    connectionPatch: "connection-browser-auth-v1",
    status: "tested",
  }),
  "0.1.1-rc.2": Object.freeze({
    connectionPatch: "connection-v1",
    status: "legacy",
  }),
});

// Investigated without being adopted. These versions have reviewed patch
// knowledge attached (the connection-v2 import anchor) but are deliberately not
// baselines, so nothing about them may be claimed as supported until a real
// runtime acceptance passes.
//
// 0.1.2-rc.1 introduced the BrowserAuth + /api/remote.mux transport generation.
// The legacy two downlink-only WebSockets (/api/events.mux, /api/events.host)
// are gone, replaced by one multiplexed /api/remote.mux, and native traffic
// must pass an authenticated browser session ahead of endpoint dispatch.
// Extending the api-request-trust fence alone is insufficient on this
// generation because BrowserAuth still rejects the request, so Orbit admits its
// authenticated proxy through a second authentication path
// (connection-browser-auth-v1) reviewed on the real 0.1.5-rc.2 process.
// 0.1.2-rc.1 itself was never accepted at runtime and stays investigation-only;
// 0.1.5-rc.2 shares the generation and now carries that validated patch as the
// v0.4.1 shipping baseline.
export const INVESTIGATION_ONLY_DSH_VERSIONS = Object.freeze(["0.1.2-rc.1"]);

export function compatibilityFor(version) {
  const profile = compatibilityProfiles[version];
  if (!profile) {
    const accepted = Object.keys(compatibilityProfiles).join(", ");
    throw new Error(
      `Unsupported DeepSeek Harness version ${JSON.stringify(version)}. ` +
        `Accepted versions: ${accepted || "none"}.`,
    );
  }
  return profile;
}
