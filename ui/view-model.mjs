// View-model for the v0.3 operator UI (SOP Stage 5). Pure mapping —
// no DOM, no network — so every health dimension is rendered
// explicitly and never flattened into a single Healthy/Unhealthy
// badge. Browser-safe ES module (also imported by tests).

export const LOADING_STATE = { kind: "loading" };
export const EMPTY_NODES_STATE = { kind: "empty-nodes" };
export const EMPTY_TOKENS_STATE = { kind: "empty-tokens" };
export const SESSION_REQUIRED_STATE = { kind: "session-required" };
export const BOOTSTRAP_ERROR_STATE = { kind: "bootstrap-error" };

export function mapApiError(body, fallback = "unexpected error") {
  const code = body?.error?.code;
  const message = body?.error?.message;
  if (typeof code === "string") return { code, message: typeof message === "string" ? message : fallback, fallback };
  return { code: "unknown", message: fallback, fallback };
}

// Client-generated delete requestId (RFC-0007 confirmation semantics):
// 32 lowercase hex; injectable rng for tests.
export function createDeleteRequestId(random) {
  const bytes = new Uint8Array(16);
  if (typeof random === "function") {
    for (let index = 0; index < 16; index += 1) bytes[index] = random();
  } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    throw new Error("no randomness source for the delete requestId");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Every health dimension appears independently; capabilityEvidence is
// shown separately from the active capability set.
export function healthBadges(node) {
  const health = node?.health ?? {};
  const identity = node?.runtimeIdentity ?? {};
  return [
    { dimension: "registryContact", value: health.registryContact ?? "unknown" },
    { dimension: "dshHealthy", value: health.dshHealthy ?? "unknown" },
    { dimension: "orbitCompatible", value: health.orbitCompatible ?? "unknown" },
    { dimension: "reachable", value: health.reachable ?? "unknown" },
    { dimension: "authenticated", value: health.authenticated ?? "unknown" },
    { dimension: "state", value: node?.state ?? "unknown" },
  ];
}

export function mapNodeRow(node) {
  const health = node?.health ?? {};
  const runtime = node?.runtimeIdentity ?? {};
  return {
    nodeId: node?.nodeId ?? null,
    state: node?.state ?? "unknown",
    health: {
      registryContact: health.registryContact ?? "unknown",
      dshHealthy: health.dshHealthy ?? "unknown",
      orbitCompatible: health.orbitCompatible ?? "unknown",
      reachable: health.reachable ?? "unknown",
      authenticated: health.authenticated ?? "unknown",
      capabilitiesStale: health.capabilitiesStale === true,
      capabilities: Array.isArray(health.capabilities) ? health.capabilities.map((entry) => entry.name).sort() : [],
      capabilityEvidence: Array.isArray(health.capabilityEvidence) ? health.capabilityEvidence.map((entry) => entry.name).sort() : [],
      alertFlags: Array.isArray(health.alertFlags) ? health.alertFlags : [],
      lastSeen: health.lastSeen ?? null,
      lastSeenSource: health.lastSeenSource ?? null,
    },
    runtimeIdentity: {
      orbitVersion: runtime.orbitVersion ?? null,
      orbitRevision: runtime.orbitRevision ?? null,
      dshVersion: runtime.dshVersion ?? null,
      compatibilityProfile: runtime.compatibilityProfile ?? null,
    },
    tombstonedAt: node?.tombstonedAt ?? null,
    tombstoneReason: node?.tombstoneReason ?? null,
  };
}

export function mapNodeList(nodes) {
  if (!Array.isArray(nodes)) return EMPTY_NODES_STATE;
  if (nodes.length === 0) return EMPTY_NODES_STATE;
  return { kind: "nodes", rows: nodes.map(mapNodeRow) };
}

export function mapNodeDetail(node) {
  const row = mapNodeRow(node);
  return {
    ...row,
    latestReport: node?.latestReport
      ? {
          uploadedAt: node.latestReport.uploadedAt ?? null,
          orbitVersion: node.latestReport.orbit?.version ?? null,
          orbitRevision: node.latestReport.orbit?.revision ?? null,
          dshVersion: node.latestReport.candidate?.dshVersion ?? null,
          compatibilityProfile: node.latestReport.candidate?.profile ?? null,
          compatibility: node.latestReport.compatibility ?? null,
        }
      : null,
    events: Array.isArray(node?.events)
      ? node.events.map((event) => ({
          at: event.at ?? null,
          dimension: event.dimension ?? null,
          from: event.from ?? null,
          to: event.to ?? null,
          source: event.source ?? null,
        }))
      : [],
  };
}

export function mapTokenRow(token) {
  return {
    tokenId: token?.tokenId ?? null,
    purpose: token?.purpose ?? null,
    boundNodeId: token?.boundNodeId ?? null,
    status: token?.status ?? null,
    createdAt: token?.createdAt ?? null,
    expiresAt: token?.expiresAt ?? null,
    consumedAt: token?.consumedAt ?? null,
  };
}

export function mapTokenList(tokens) {
  if (!Array.isArray(tokens)) return EMPTY_TOKENS_STATE;
  if (tokens.length === 0) return EMPTY_TOKENS_STATE;
  return { kind: "tokens", rows: tokens.map(mapTokenRow) };
}

// Token minting contract: the plaintext exists exactly once, in the
// mint response; the view-model never stores or re-renders it later.
export function mapTokenMint(minted) {
  return {
    tokenId: minted?.tokenId ?? null,
    plaintextOnce: typeof minted?.token === "string" ? minted.token : null,
    purpose: minted?.purpose ?? null,
    boundNodeId: minted?.boundNodeId ?? null,
    expiresAt: minted?.expiresAt ?? null,
  };
}

export function mapDeleteResult(result) {
  return {
    nodeId: result?.nodeId ?? null,
    state: result?.state ?? null,
    idempotentReplay: result?.idempotentReplay === true,
  };
}