export const compatibilityProfiles = Object.freeze({
  "0.1.1-rc.2": Object.freeze({
    connectionPatch: "connection-v1",
    status: "tested",
  }),
});

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
