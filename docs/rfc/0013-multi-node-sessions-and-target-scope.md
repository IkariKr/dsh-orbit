# RFC 0013: Multi-node sessions and target scoping for v0.6

Status: **Proposed for v0.6 architecture review. Product construction is blocked until the Stage 0 / Gate A review records GO.**

Depends on: RFC-0001 node identity, RFC-0003 node authentication, RFC-0005 enrollment and registry persistence, RFC-0006 machine API, RFC-0007 browser management API, RFC-0008 per-node Hub service identity, RFC-0009 capability/health semantics, RFC-0010 node endpoint/routing, RFC-0011 browser node selection, RFC-0012 reverse-connected nodes, and authorization `V06-CONSTRUCTION-20260925-A1`.

---

## 1. Goal

v0.6 builds on the unified direct/reverse node foundation of v0.4 and v0.5 to enable **concurrent multi-node browser sessions** with **explicit target scoping**.

In v0.4/v0.5, multiple nodes could be registered and individual nodes could be accessed via distinct deterministic route authorities (`n-<nodeId>.<routeDomain>`). However, operator workflows frequently require simultaneous interaction with distinct nodes (e.g., workstation and NAS, or primary and backup nodes) within the same operator environment.

v0.6 formalizes the architecture for concurrent multi-node operations while maintaining strict isolation invariants:

```text
Browser / Operator UI
   |
   +---- Session 1 (Target: Node A, direct)  ---> https://n-nodeA.dsh-orbit.test:8547/ ---> Node A (direct)
   |
   +---- Session 2 (Target: Node B, reverse) ---> https://n-nodeB.dsh-orbit.test:8547/ ---> Hub Reverse Pool ---> Node B
   |
   v
Hub Management API & Devices/Nodes View (Read model tracking active sessions, flow counts, node presence)
```

The design deliberately maintains the core principles:
- **Zero implicit broadcast**: every command and flow targets exactly one node.
- **Strict per-node session and cookie isolation**: host-only cookies and cryptographic route proofs remain node-specific.
- **Zero silent failover**: an outage on one node never redirects to or affects another node.
- **Independent transport capacity**: concurrent loads across nodes do not share or starve connection pools.

---

## 2. Decision summary

1. **D1: Route Authority & Host-Only Cookie Isolation Preserved**
   The browser access model continues to use deterministic RFC-0010 route authorities (`https://n-<nodeId>.<routeDomain>/`). Host-only cookies remain isolated by standard web origin security boundaries. No wildcard shared cookies or cross-node token leaks are permitted.
2. **D2: Explicit Single-Node Target Scope in all UI & API Interactions**
   Every routed HTTP request, WebSocket channel, and operator command must name exactly one `nodeId`. There is no "all-nodes", "default cluster", or implicit multi-cast execution in v0.6. Batch or scheduled fleet workflows belong strictly to v0.7.
3. **D3: First-Class Devices and Nodes Operator View**
   The authenticated Hub management surface (`/` and `/hub/*`) exposes a first-class **Devices and Nodes** view displaying:
   - All enrolled nodes, their `routeMode` (`direct` | `reverse`), reachability, presence, and active browser flow counts.
   - Real-time connection status tracking without page reload.
   - Dedicated launch/open actions binding explicitly to the target node's route authority.
4. **D4: Resource Isolation Across Concurrent Nodes**
   The Hub route proxy maintains independent routing lifecycles for distinct nodes. Reverse channel pools (RFC-0012 D5) are partitioned per node; high concurrency or a stalled channel on Node B cannot exhaust or delay data channels on Node A.
5. **D5: Failure Containment & Outage Independence**
   If Node A fails, restarts, or loses reachability, active sessions and WebSocket streams to Node B continue completely uninterrupted. Node reachability status updates in the Hub read model do not tear down healthy peer connections.
6. **D6: Acceptance Matrix for v0.6 (24 Canonical Fields)**
   A dedicated multi-node session acceptance matrix is mechanically enforced across automated qualification and mounted live runs.

---

## 3. Detailed Technical Design

### D1: Route authority and session isolation

Each node's deterministic route authority remains:

```text
https://n-<nodeId>.<routeDomain>:<port>/
```

- **Origin Isolation**: Node A (`n-<nodeA>...`) and Node B (`n-<nodeB>...`) are separate origins. The browser's native Same-Origin Policy enforces cookie jar, LocalStorage, SessionStorage, and Cache isolation.
- **Route Signing**: Each request routed through the Hub continues to carry an `ORBIT-ROUTE-V1` proof signed with that specific node's Hub route identity (`RFC-0008` / `RFC-0010`). A proof generated for Node A is cryptographically invalid for Node B.

### D2: Explicit target scope and broadcast prohibition

The UI and Hub API enforce explicit targeting:

```typescript
interface ScopedNodeAction {
  targetNodeId: string; // Mandatory 32-hex node ID; wildcards or arrays are rejected
  action: "open" | "status" | "disconnect" | "refresh";
}
```

- Any request missing `targetNodeId`, or specifying `"all"`, `""`, or multiple IDs is rejected with `HTTP 400 Bad Request` (`code: "invalid-target-scope"`).
- Terminal plugins, settings mutations, or diagnostic commands run strictly within the context of the selected node.
- The UI must visually indicate the active target node with its truncated ID (e.g. `target: node_012345678…`), formatting `target: <displayName> (<truncatedId>)` if an extended read model provides an optional `displayName`.

### D3: Devices and Nodes read model & UI

The Hub management API extends the existing read model (`GET /hub/nodes`) with per-node `activeFlows` and introduces an authenticated overview endpoint (`GET /hub/overview`) with real-time session observability (human-assigned `displayName` alias management is deferred to v0.7 fleet inventory; in v0.6 canonical node IDs are used):

```json
{
  "nodes": [
    {
      "nodeId": "node_06827d59b9d6511f05883387f431fbba",
      "routeMode": "direct",
      "reachable": "ok",
      "activeFlows": 2,
      "routeAuthority": "n-06827d59b9d6511f05883387f431fbba.dsh-orbit.test:8547"
    },
    {
      "nodeId": "node_62e2f94672739bc519887316c7bc3455",
      "routeMode": "reverse",
      "reachable": "ok",
      "reversePresence": "online",
      "activeFlows": 1,
      "routeAuthority": "n-62e2f94672739bc519887316c7bc3455.dsh-orbit.test:8547"
    }
  ],
  "activeSessions": {
    "totalFlows": 3,
    "distinctNodes": 2
  }
}
```

### D4: Concurrent proxying & resource limits

The Hub proxy layer tracks active flows with per-node metrics:

```typescript
class MultiNodeFlowTracker {
  private activeFlowsByNode: Map<string, Set<string>> = new Map();

  trackFlow(nodeId: string, flowId: string): () => void {
    let set = this.activeFlowsByNode.get(nodeId);
    if (!set) {
      set = new Set();
      this.activeFlowsByNode.set(nodeId, set);
    }
    set.add(flowId);
    return () => {
      set.delete(flowId);
      if (set.size === 0) this.activeFlowsByNode.delete(nodeId);
    };
  }

  getActiveFlowCount(nodeId: string): number {
    return this.activeFlowsByNode.get(nodeId)?.size ?? 0;
  }
}
```

- Hub-side reverse channels (`ReverseChannelManager`, `src/registry/reverse-channel.mjs`) are strictly partitioned per node ID (`this.channels = new Map()`).
- Channel allocation waiters in `ReverseChannelManager` are scoped to `(nodeId, sessionId)` and cannot queue behind or interfere with other nodes.

### D5: Failure independence

When Node A experiences an outage:
1. Hub marks Node A `reachable = "down"` or `reversePresence = "offline"`.
2. Existing or new flows to Node A fail closed with `503 Service Unavailable` (`node-not-reachable` or `reverse-session-offline`).
3. Node B's state, channels, and flows remain `online` and `200 OK`.
4. No fallback or cross-routing between Node A and Node B is ever attempted.

---

## 4. Acceptance Matrix (RFC-0013 M24 Matrix)

The v0.6 acceptance matrix defines 24 canonical fields:

| # | Field | Scope | Description |
|---|-------|-------|-------------|
| 1 | `multiNodeListObservability` | automated | Hub read model exposes all registered nodes with active flow counts |
| 2 | `explicitTargetScopeRequired` | automated | Actions and route dispatches without explicit single nodeId fail closed |
| 3 | `targetScopeWildcardDenied` | automated | Requests targeting "all", "*", or multiple node IDs are rejected with 400 |
| 4 | `concurrentHttpRootDirectAndReverse` | mounted | Simultaneous HTTP GET `/` on direct Node A and reverse Node B succeed |
| 5 | `concurrentStaticAssetsDirectAndReverse` | mounted | Concurrent static asset downloads across Node A and Node B return intact |
| 6 | `concurrentStreamingUploads` | mounted | Concurrent streamed uploads to Node A and Node B complete without data corruption |
| 7 | `concurrentWebSocketUpgrade` | mounted | Simultaneous WebSocket upgrades to Node A and Node B succeed independently |
| 8 | `concurrentWebSocketPingPong` | mounted | Independent concurrent Ping/Pong exchanges on Node A and Node B |
| 9 | `concurrentLargePayloadTransfer` | mounted | Concurrent large payloads (≥512 KiB) across nodes without channel blocking |
| 10 | `cookieJarIsolationConcurrent` | mounted | Cookies set on Node A authority never leak or appear in Node B requests |
| 11 | `originIsolationLocalStorage` | mounted | Origin boundaries prevent cross-node DOM storage access |
| 12 | `nodeAOutageNoImpactOnNodeB` | mounted | Node A container crash leaves concurrent Node B WebSocket and HTTP flows healthy |
| 13 | `nodeBOutageNoImpactOnNodeA` | mounted | Node B reverse connection tear-down leaves Node A direct flows healthy |
| 14 | `nodeARestartRecovery` | mounted | Restarting Node A restores its flows without interrupting Node B |
| 15 | `nodeBRestartRecovery` | mounted | Restarting Node B restores reverse control/data channels without interrupting Node A |
| 16 | `reverseChannelPoolIndependence` | mounted | Channel exhaustion on Node B returns 503 capacity without delaying Node A |
| 17 | `routeProofWrongNodeCrossDenied` | automated | Cryptographic proof signed for Node A is rejected when submitted to Node B |
| 18 | `noSilentCrossNodeFailover` | mounted | Outage on Node A route authority returns 503 and never routes to Node B |
| 19 | `hubRestartRestoresAllNodes` | mounted | Hub restart cleanly recovers Node A reachability and re-establishes Node B reverse |
| 20 | `multiNodeFlowTrackerAccurate` | automated | Hub flow tracker accurately reflects active/idle counts across concurrent requests |
| 21 | `multiNodeCredentialRotation` | mounted | Rotating Node A credentials while Node B is active preserves both nodes |
| 22 | `deleteNodeAKeepsNodeB` | mounted | Deleting Node A closes only Node A flows; Node B remains active and routable |
| 23 | `operatorUiTargetScopeIndication` | automated | Hub UI DOM model explicitly indicates active target node in selector views |
| 24 | `noImplicitBroadcastExecution` | automated | Execution commands enforce single-node destination and refuse broadcast |

---

## 5. Security & Boundary Guarantees

1. **Host-Only Cookies**: Node authorities reside on distinct FQDNs under `.dsh-orbit.test` (or production wildcard domain). Cookies default to host-only without Domain attributes.
2. **Hop-by-Hop Authentication**: `ORBIT-ROUTE-V1` tokens bind specifically to `(nodeId, timestamp, nonce, authority)`. Cross-node replay is cryptographically impossible.
3. **No General Tunnel**: No generic proxying or multi-hop routing is permitted.
4. **Zero Fleet Broadcast**: Fleet-wide command execution is explicitly forbidden in v0.6.
