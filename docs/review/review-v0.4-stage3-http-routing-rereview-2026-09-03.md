# DSH Orbit v0.4 Stage 3 Final Re-review

Date: 2026-09-03

## Verdict

**PASS — Stage 3 COMPLETE / ACCEPTED.**

Stage 4 remains not started and requires a separate construction instruction.

## Reviewed provenance

- Branch: `feat/v0.4-stage3-http-routing`
- Contractor remediation HEAD reviewed: `117a11d244034a4287b94c6e11ad42f0929e935d`
- Reviewer direct-fix commit: `b3f53e9e87bf28adceb3e5c65e5594a5f9d05f18`
- Stage 3 base: `c8362c3d3df63aae6ea9914c2584497b5d3aef32`

The contractor remediation correctly closed the previously blocking wildcard namespace, selector-apex, gateway-authentication, SSRF, exact-authority, active-key, and live HTTPS gateway findings. During final re-review one additional compatibility regression was found and fixed directly by the reviewer before acceptance.

## Final reviewer fix

### Generic Host compatibility / IPv6 loopback

`classifyHostAuthority()` previously applied the Orbit DNS authority grammar before deciding whether a Host belonged to the configured route domain. As a result, a legitimate bracketed IPv6 loopback Host such as `[::1]:5445` was classified as `invalid-route-domain` and intercepted with `404 route-not-found`, regressing the pre-existing Registry/browser loopback ingress.

The classifier now:

1. validates the configured route domain;
2. leaves bracketed IPv6 authorities outside the DNS route namespace as `unrelated`;
3. determines whether a DNS-like Host actually targets the configured route namespace before applying strict Orbit route authority grammar;
4. preserves unrelated legacy/private Host values such as `127.0.0.1:5445`, `localhost:5445`, and `[::1]:5445`;
5. treats malformed values that still target the route namespace as fail-closed `invalid-route-domain`.

### Multiple trailing dots

A second defense-in-depth gap was closed at the same boundary. Values such as:

- `foo.dsh.example.com..`
- `dsh.example.com..`
- `n-<32hex>.dsh.example.com..`

remain recognized as attempts to target the route namespace and are rejected fail closed rather than being reclassified as unrelated Registry traffic. A single legal FQDN trailing dot remains canonicalized as intended.

## Verification

### Stage 3 automated suite

`node --test test/stage3-http-routing.test.mjs`

- tests: 6
- pass: 6
- fail: 0

New regression assertions include:

- `[::1]:5445` -> `unrelated` and the ordinary Hub UI shell remains reachable;
- `127.0.0.1:5445` -> `unrelated`;
- `localhost:5445` -> `unrelated`;
- multi-trailing-dot route-domain Hosts -> `invalid-route-domain` / `404 route-not-found`.

### Stage 3 live HTTPS two-node evidence

`node --test test/stage3-live-two-node.test.mjs`

- tests: 1
- pass: 1
- fail: 0

The existing real child-process rehearsal remains green after the reviewer fix:

- authenticated wildcard HTTPS gateway;
- selector apex TLS/landing;
- foreign Host denial;
- static root/assets on Node A and Node B;
- host-only cookie response isolation;
- Node A fault isolation with no failover to B;
- Hub + Node A + Node B restart with no identity drift.

### Full repository gate

`npm run check`

- Public-tree validation: PASS
- tests: 341
- pass: 337
- fail: 0
- skipped: 4 environment-specific Windows/POSIX cases

`git diff --check`: PASS.

## Final findings

- P0: 0
- P1: 0
- blocking P2: 0
- non-blocking P3: 1

The remaining P3 is evidence-only: Stage 3 proves downstream `Set-Cookie Domain=` removal and therefore the host-only cookie contract, while a full browser/cookie-jar drill proving an A cookie is absent on sibling and selector requests remains appropriate for the already-planned Stage 6 cookie-leak drill. It does not block Stage 3 acceptance.

## Scope confirmation

Confirmed absent from Stage 3:

- WebSocket proxying;
- long-lived routed transport support;
- reverse connection / NAT traversal;
- automatic failover;
- multi-node session aggregation;
- fleet execution;
- DSH-private auth/session parsing;
- third-party plugin-specific routing logic.

**Stage 3 is COMPLETE / ACCEPTED. Stage 4 NOT STARTED.**
