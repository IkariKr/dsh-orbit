// Hub deployment configuration validation (P2-05, round-2 P2): the hub
// is a plain http listener by design; TLS termination belongs to the
// deployment gateway. The machine surface (enrollment tokens, Ed25519
// signatures) must never ride a public plain-HTTP bind, so a non-loopback
// listen is refused unconditionally in v0.3 — there is no production
// escape hatch.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackListen(host) {
  return LOOPBACK_HOSTS.has(host);
}

// Returns a list of human-readable configuration errors (empty when the
// configuration is acceptable for startup).
export function validateHubConfig({ listen, trustedExternalScheme }) {
  const errors = [];
  if (typeof listen !== "string" || listen === "") {
    errors.push("DSH_ORBIT_HUB_LISTEN must be a hostname or address");
  } else if (!isLoopbackListen(listen)) {
    errors.push(
      `listener ${listen} is not loopback and is refused: the registry machine surface requires a private TLS-terminated backend boundary in v0.3`,
    );
  }
  if (trustedExternalScheme !== "http" && trustedExternalScheme !== "https") {
    errors.push(`DSH_ORBIT_HUB_TRUSTED_SCHEME must be http or https (got ${JSON.stringify(trustedExternalScheme)})`);
  }
  return errors;
}