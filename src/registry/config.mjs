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

export function validateWebSocketConfig({ maxWsGlobal, maxWsPerNode, wsHandshakeTimeoutMs } = {}) {
  const errors = [];
  if (maxWsGlobal !== undefined) {
    if (typeof maxWsGlobal !== "number" || !Number.isInteger(maxWsGlobal) || !Number.isFinite(maxWsGlobal) || maxWsGlobal < 1 || maxWsGlobal > 100000) {
      errors.push(`DSH_ORBIT_HUB_WS_GLOBAL_LIMIT must be an integer between 1 and 100000 (got ${maxWsGlobal})`);
    }
  }
  if (maxWsPerNode !== undefined) {
    if (typeof maxWsPerNode !== "number" || !Number.isInteger(maxWsPerNode) || !Number.isFinite(maxWsPerNode) || maxWsPerNode < 1 || maxWsPerNode > 10000) {
      errors.push(`DSH_ORBIT_HUB_WS_PER_NODE_LIMIT must be an integer between 1 and 10000 (got ${maxWsPerNode})`);
    }
  }
  if (
    maxWsGlobal !== undefined &&
    maxWsPerNode !== undefined &&
    Number.isInteger(maxWsGlobal) &&
    Number.isInteger(maxWsPerNode) &&
    maxWsPerNode > maxWsGlobal
  ) {
    errors.push(`DSH_ORBIT_HUB_WS_PER_NODE_LIMIT (${maxWsPerNode}) cannot exceed DSH_ORBIT_HUB_WS_GLOBAL_LIMIT (${maxWsGlobal})`);
  }
  if (wsHandshakeTimeoutMs !== undefined) {
    if (typeof wsHandshakeTimeoutMs !== "number" || !Number.isInteger(wsHandshakeTimeoutMs) || !Number.isFinite(wsHandshakeTimeoutMs) || wsHandshakeTimeoutMs < 100 || wsHandshakeTimeoutMs > 120000) {
      errors.push(`DSH_ORBIT_HUB_WS_HANDSHAKE_TIMEOUT_MS must be an integer between 100 and 120000 (got ${wsHandshakeTimeoutMs})`);
    }
  }
  return errors;
}

// Returns a list of human-readable configuration errors (empty when the
// configuration is acceptable for startup).
export function validateHubConfig({ listen, trustedExternalScheme, maxWsGlobal, maxWsPerNode, wsHandshakeTimeoutMs }) {
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
  errors.push(...validateWebSocketConfig({ maxWsGlobal, maxWsPerNode, wsHandshakeTimeoutMs }));
  return errors;
}