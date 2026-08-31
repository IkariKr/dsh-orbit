# Registry operator UI (v0.3, SOP Stage 5)

The operator surface is a static shell served by the Hub (`GET /` →
`ui/index.html`, plus `/app.mjs`, `/view-model.mjs`, `/styles.css`). It
talks ONLY through the RFC-0007 browser management API; the shell files
contain no data and no secrets. The view-model (`ui/view-model.mjs`) maps
every hub response dimension explicitly — the UI **never** flattens health
into a single Healthy/Unhealthy badge.

## Rendering contract (what the UI shows, verbatim from the Hub)

Per node, six independent badges: `registryContact`, `dshHealthy`,
`orbitCompatible`, `reachable`, `authenticated`, `state`. Capabilities are
shown as:

- the ACTIVE set (empty while evidence is stale), and
- `capabilityEvidence` (the last derived set, labeled "withheld" when the
  active set is empty).

Alert flags (`contact-lost`) render as explicit alerts. Runtime identity,
`lastSeen`(+source), tombstone state, the latest compatibility report and
the event history are shown on the node detail view. Unknown values render
as `unknown` — nothing is ever guessed.

## Operator workflows

- **Session**: opening the page bootstraps a management session through the
  gateway-admitted path; the operator principal comes from the gateway.
- **Delete**: requires the confirmation dialog → reason → a client-generated
  `requestId`; the result is displayed explicitly, including the idempotent
  replay case ("already deleted by this request").
- **Tokens**: minting shows the plaintext **exactly once** with a warning;
  the token list is history with explicit status (`active`/`expired`/
  `consumed`) and never re-exposes the plaintext.
- **Reenroll**: the tombstone-bound re-enrollment token mint follows the
  delete flow (node must be tombstoned).
- **Logout**: terminates the session server-side.

## Automated walkthrough

`test/ui-browser-flow.test.mjs` drives the full operator flow through a
real Hub (session bootstrap → CSRF → delete with requestId → explicit
result → idempotent replay → token mint/list → reenroll mint → logout),
rendering every step through the same view-model the UI uses.
`test/ui-view-model.test.mjs` pins the per-dimension mapping. A manual
browser walkthrough against a deployed Hub is part of Stage 6's live
evidence (see the deployment SOP).