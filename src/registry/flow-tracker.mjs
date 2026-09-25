// Multi-Node Flow Tracker and Target Scope Enforcement (RFC-0013 D2, D4, Stage 1).
// Provides per-node active flow accounting and strict single-node target scope validation.

import { randomHex } from "./crypto.mjs";
import { NODE_ID_PATTERN } from "./protocol.mjs";

export const ALLOWED_SCOPED_ACTIONS = Object.freeze(["open", "status", "disconnect", "refresh"]);

/**
 * Validates that targetNodeId represents an explicit, single, well-formed node ID.
 * Wildcards, empty targets, arrays, or non-hex identifiers are strictly rejected.
 *
 * @param {unknown} targetNodeId
 * @returns {{ valid: boolean, nodeId?: string, code?: string, message?: string }}
 */
export function validateTargetScope(targetNodeId) {
  if (targetNodeId === null || targetNodeId === undefined) {
    return { valid: false, code: "invalid-target-scope", message: "targetNodeId is required" };
  }

  if (typeof targetNodeId !== "string") {
    return {
      valid: false,
      code: "invalid-target-scope",
      message: "targetNodeId must be a single string; arrays and multi-targets are denied",
    };
  }

  const trimmed = targetNodeId.trim();
  if (trimmed === "") {
    return { valid: false, code: "invalid-target-scope", message: "targetNodeId must not be empty" };
  }

  // Reject wildcards, broadcasts, and multi-node tokens
  const lower = trimmed.toLowerCase();
  if (
    lower === "*" ||
    lower === "all" ||
    lower === "any" ||
    lower === "broadcast" ||
    lower === "cluster" ||
    trimmed.includes(",") ||
    trimmed.includes(" ") ||
    trimmed.includes(";")
  ) {
    return {
      valid: false,
      code: "invalid-target-scope",
      message: "wildcard or broadcast target scope is denied; target must specify exactly one node",
    };
  }

  const normalized = trimmed.startsWith("node_") ? trimmed : `node_${trimmed}`;
  if (!NODE_ID_PATTERN.test(normalized)) {
    return {
      valid: false,
      code: "invalid-target-scope",
      message: `targetNodeId must be a valid 32-hex lowercase node ID: ${JSON.stringify(targetNodeId)}`,
    };
  }

  return { valid: true, nodeId: normalized };
}

/**
 * Asserts that targetNodeId is valid; throws an Error with code "invalid-target-scope" and statusCode 400 otherwise.
 *
 * @param {unknown} targetNodeId
 * @returns {string} normalized nodeId
 */
export function assertValidTargetScope(targetNodeId) {
  const result = validateTargetScope(targetNodeId);
  if (!result.valid) {
    const error = new Error(result.message);
    error.code = result.code;
    error.statusCode = 400;
    throw error;
  }
  return result.nodeId;
}

/**
 * Validates a scoped action payload { targetNodeId, action }.
 *
 * @param {unknown} payload
 * @returns {{ valid: boolean, nodeId?: string, action?: string, code?: string, message?: string }}
 */
export function validateScopedAction(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, code: "bad-request", message: "action payload must be an object" };
  }

  const targetResult = validateTargetScope(payload.targetNodeId);
  if (!targetResult.valid) {
    return targetResult;
  }

  const { action } = payload;
  if (typeof action !== "string" || !action.trim()) {
    return { valid: false, code: "invalid-action", message: "action is required" };
  }

  const cleanAction = action.trim().toLowerCase();
  if (!ALLOWED_SCOPED_ACTIONS.includes(cleanAction)) {
    return {
      valid: false,
      code: "invalid-action",
      message: `action must be one of [${ALLOWED_SCOPED_ACTIONS.join(", ")}]; got ${JSON.stringify(action)}`,
    };
  }

  return { valid: true, nodeId: targetResult.nodeId, action: cleanAction };
}

/**
 * In-memory tracker for active concurrent browser flows per node.
 * Thread-safe for Node.js event loop concurrency; ensures flow tracking
 * accounting cannot corrupt across concurrent requests.
 */
export class MultiNodeFlowTracker {
  constructor({ maxFlowsPerNode = Infinity, maxTotalFlows = Infinity } = {}) {
    this.maxFlowsPerNode = maxFlowsPerNode;
    this.maxTotalFlows = maxTotalFlows;
    this.activeFlowsByNode = new Map(); // nodeId -> Set<flowId>
    this.flowToNode = new Map(); // flowId -> nodeId
  }

  /**
   * Begins tracking a flow on nodeId.
   *
   * @param {string} targetNodeId - target node identifier
   * @param {string|null} [explicitFlowId=null] - optional flow ID; generated if omitted
   * @returns {() => void} idempotent endFlow callback
   */
  trackFlow(targetNodeId, explicitFlowId = null) {
    const nodeId = assertValidTargetScope(targetNodeId);

    const totalActive = this.flowToNode.size;
    if (totalActive >= this.maxTotalFlows) {
      const error = new Error(`total flow capacity exceeded: ${totalActive} >= ${this.maxTotalFlows}`);
      error.code = "flow-capacity-exceeded";
      error.statusCode = 503;
      throw error;
    }

    let nodeSet = this.activeFlowsByNode.get(nodeId);
    if (!nodeSet) {
      nodeSet = new Set();
      this.activeFlowsByNode.set(nodeId, nodeSet);
    }

    if (nodeSet.size >= this.maxFlowsPerNode) {
      const error = new Error(`node flow capacity exceeded for ${nodeId}: ${nodeSet.size} >= ${this.maxFlowsPerNode}`);
      error.code = "node-flow-capacity-exceeded";
      error.statusCode = 503;
      throw error;
    }

    const flowId = explicitFlowId ?? `flow_${randomHex(16)}`;
    nodeSet.add(flowId);
    this.flowToNode.set(flowId, nodeId);

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.endFlow(flowId);
    };
  }

  /**
   * Explicitly ends a flow by flowId. Idempotent.
   *
   * @param {string} flowId
   */
  endFlow(flowId) {
    const nodeId = this.flowToNode.get(flowId);
    if (!nodeId) return;

    this.flowToNode.delete(flowId);
    const nodeSet = this.activeFlowsByNode.get(nodeId);
    if (nodeSet) {
      nodeSet.delete(flowId);
      if (nodeSet.size === 0) {
        this.activeFlowsByNode.delete(nodeId);
      }
    }
  }

  /**
   * Returns active flow count for a node.
   *
   * @param {string} targetNodeId
   * @returns {number}
   */
  getActiveFlowCount(targetNodeId) {
    try {
      const nodeId = assertValidTargetScope(targetNodeId);
      return this.activeFlowsByNode.get(nodeId)?.size ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Returns total active flow count across all nodes.
   *
   * @returns {number}
   */
  getTotalActiveFlowCount() {
    return this.flowToNode.size;
  }

  /**
   * Returns number of distinct nodes with active flows > 0.
   *
   * @returns {number}
   */
  getActiveNodeCount() {
    return this.activeFlowsByNode.size;
  }

  /**
   * Returns array of nodeIds currently having active flows.
   *
   * @returns {string[]}
   */
  getActiveNodeIds() {
    return [...this.activeFlowsByNode.keys()];
  }

  /**
   * Returns a snapshot of current flow tracking.
   *
   * @returns {{ totalFlows: number, distinctNodes: number, nodes: Record<string, number> }}
   */
  getSnapshot() {
    const nodes = {};
    for (const [nodeId, set] of this.activeFlowsByNode.entries()) {
      nodes[nodeId] = set.size;
    }
    return {
      totalFlows: this.flowToNode.size,
      distinctNodes: this.activeFlowsByNode.size,
      nodes,
    };
  }

  /**
   * Resets all tracked flows.
   */
  clear() {
    this.activeFlowsByNode.clear();
    this.flowToNode.clear();
  }
}
