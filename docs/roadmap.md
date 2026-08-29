# Roadmap

The roadmap is staged so that deployment safety remains independent from later fleet features.

## 0.1: secure remote deployment

- authenticated reverse-proxy access to the DSH configuration plane;
- Docker deployment example;
- Caddy and local Nginx boundary examples;
- explicit compatibility registry;
- build-time and profile-runtime patch verification.

## 0.2: upgrade guard

Shipped in `v0.2.0`:

- candidate build command;
- automated authenticated and negative-auth smoke tests;
- data snapshot hooks;
- compatibility report generation;
- CI checks for newly released DSH versions without automatic production promotion.

## 0.3: node identity and registry

- stable node identity;
- node metadata and health;
- DSH and Orbit version reporting;
- capability advertisement;
- revocable per-node credentials.

## 0.4: endpoint selector

- one web entry point for multiple registered DSH nodes;
- explicit active-node selection;
- routing of HTTP, WebSocket, and session traffic to the selected node;
- node status and capability display.

## 0.5: reverse-connected nodes

- outbound node-to-hub connection for devices behind NAT or restrictive networks;
- pairing and device authorization;
- reconnect and presence handling without requiring a public endpoint per device.

## 0.6: multi-node sessions

- concurrent connections to multiple selected nodes;
- clear target scope in the UI;
- per-node session isolation;
- no implicit broadcast execution.

## 0.7: fleet workflows

- explicit tasks targeting selected nodes;
- capability-aware scheduling;
- aggregated results;
- auditability of target selection and execution scope.

## Design constraints

The Hub should remain a control plane. DSH remains the execution runtime on each node.

Fleet features should prefer capability negotiation over version-specific UI branches. Operations that can execute commands or mutate settings across multiple nodes must require an explicit target scope.
