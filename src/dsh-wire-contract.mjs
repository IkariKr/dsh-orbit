// Wire vocabulary per reviewed connection patch generation.
//
// Upstream changed both the RPC vocabulary and the stream transport between
// generations: 0.1.1-rc.2 serves dotted endpoint names over two downlink-only
// WebSockets, while the BrowserAuth generation serves slash-separated Remote
// endpoints over one bidirectional mux and expects the request payload wrapped
// in an `args` field. Acceptance checks therefore select a contract by the
// reviewed patch generation recorded in `src/compatibility.mjs` — never by
// comparing version numbers, which would let an unreviewed release inherit a
// vocabulary that was never validated for it.

import { compatibilityFor } from "./compatibility.mjs";

export const RPC_PAYLOAD_STYLES = Object.freeze({
  /** The request body is the argument object itself. */
  bare: "bare",
  /** The request body is `{ args: <argument object> }` (Remote descriptors). */
  args: "args",
});

export const STREAM_SEMANTICS = Object.freeze({
  /** Downlink-only streams; a client frame is a protocol violation. */
  legacyDownlink: "legacy-downlink",
  /** One bidirectional multiplex; logical streams are opened explicitly. */
  remoteMux: "remote-mux",
});

export const WIRE_CONTRACTS = Object.freeze({
  "connection-v1": Object.freeze({
    rpc: Object.freeze({ separator: ".", payload: RPC_PAYLOAD_STYLES.bare }),
    stream: Object.freeze({
      paths: Object.freeze(["/api/events.mux", "/api/events.host"]),
      semantics: STREAM_SEMANTICS.legacyDownlink,
    }),
  }),
  "connection-browser-auth-v1": Object.freeze({
    rpc: Object.freeze({ separator: "/", payload: RPC_PAYLOAD_STYLES.args }),
    stream: Object.freeze({
      paths: Object.freeze(["/api/remote.mux"]),
      semantics: STREAM_SEMANTICS.remoteMux,
    }),
  }),
});

/**
 * The wire contract a version's reviewed generation speaks.
 * @param dshVersion - the exact candidate version.
 * @returns the frozen contract for that generation.
 */
export function wireContractFor(dshVersion) {
  const { connectionPatch } = compatibilityFor(dshVersion);
  const contract = WIRE_CONTRACTS[connectionPatch];
  if (contract === undefined) {
    throw new Error(`no reviewed wire contract for connection patch ${JSON.stringify(connectionPatch)}`);
  }
  return contract;
}

/**
 * The wire contract for an explicit generation, for callers that already
 * resolved one and for tests that exercise a generation no version selects yet.
 * @param connectionPatch - the reviewed generation name.
 * @returns the frozen contract for that generation.
 */
export function wireContractForGeneration(connectionPatch) {
  const contract = WIRE_CONTRACTS[connectionPatch];
  if (contract === undefined) {
    throw new Error(`no reviewed wire contract for connection patch ${JSON.stringify(connectionPatch)}`);
  }
  return contract;
}

/**
 * Join a Remote namespace and method into this generation's endpoint name.
 * @param contract - the wire contract in force.
 * @param namespace - Remote namespace, e.g. `settings`.
 * @param method - Remote method, e.g. `describe`.
 * @returns the endpoint name on the wire.
 */
export function rpcEndpoint(contract, namespace, method) {
  return `${namespace}${contract.rpc.separator}${method}`;
}

/**
 * Build the request body for one RPC call in this generation's shape.
 * @param contract - the wire contract in force.
 * @param endpoint - the endpoint name from `rpcEndpoint`.
 * @param args - the named argument object for that endpoint.
 * @returns the payload to serialize as the request body's `payload`.
 */
export function rpcPayload(contract, args) {
  return contract.rpc.payload === RPC_PAYLOAD_STYLES.args ? { args } : args;
}

/**
 * The stream path this generation actually serves, given an explicit override.
 * @param contract - the wire contract in force.
 * @param override - an operator-supplied path that must belong to the contract.
 * @returns the ordered candidate paths.
 */
export function streamPaths(contract, override = undefined) {
  if (override === undefined || override === "") return contract.stream.paths;
  if (!contract.stream.paths.includes(override)) {
    throw new Error(
      `${JSON.stringify(override)} is not a ${contract.stream.semantics} stream path; ` +
        `expected one of ${contract.stream.paths.join(", ")}`,
    );
  }
  return [override];
}
