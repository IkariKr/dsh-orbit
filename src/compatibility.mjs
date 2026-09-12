// Reviewed DSH compatibility profiles.
//
// Each profile is exact-match and names the byte-exact patch generation that
// was reviewed for it. A version is only supported when it appears here with a
// reviewed connection patch; the runtime patch and capability derivation never
// key off version comparisons, so a new upstream release cannot inherit trust
// from a version number alone.
export const compatibilityProfiles = Object.freeze({
  "0.1.2-rc.1": Object.freeze({
    connectionPatch: "connection-v2",
    status: "tested",
  }),
  "0.1.1-rc.2": Object.freeze({
    connectionPatch: "connection-v1",
    status: "legacy",
  }),
});

// Still accepted for existing deployments, whose patch and evidence are
// unchanged, but no longer the shipping baseline. Kept explicit so that
// dropping a version is a reviewed decision instead of a silent side effect.
export const LEGACY_SUPPORTED_DSH_VERSIONS = Object.freeze(["0.1.1-rc.2"]);

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
