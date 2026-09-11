# ADR-0002: Ingress Authority Boundary

Status: **Accepted for C8.4 construction (2026-09-09); implementation and new freeze required**

Related contracts: RFC-0007, RFC-0010, RFC-0011, Stage 8 release closure

## Context

DSH Orbit exposes multiple browser-facing surfaces through an authenticated outer gateway while keeping the Hub listener private/loopback-only.

During v0.4 Stage 8 mounted evidence work, a Host/Origin mismatch exposed a real boundary gap. The mounted browser observed an external Origin equivalent to:

```text
https://127.0.0.1:8443
```

while the Hub received an authority equivalent to:

```text
127.0.0.1
```

The Hub correctly failed closed because the Origin and request authority no longer matched. This failure must not be repaired by weakening Origin checks, trusting `X-Forwarded-Host`, or adding Caddy-specific behavior.

The deeper issue is narrower than a general Public Origin redesign.

Orbit already has an established route-authority model for the Selector and deterministic Node routes:

```text
trustedExternalScheme
routeDomain
```

with existing implementation for:

- Selector apex classification;
- deterministic `n-<nodeId>.<routeDomain>` authorities;
- exact route-domain port matching;
- malformed route-domain rejection;
- Node lookup and fail-closed route eligibility.

That model does not need to be replaced for this issue.

The actual missing boundary is the Hub management authority. Today an authority unrelated to the configured route namespace can fall through to the management surface. Orbit therefore lacks an explicit rule for which request authority is allowed to reach management.

## Decision

Orbit will make the Hub management authority explicit and will classify every browser-facing request into one of three allowed authority classes:

1. Management authority;
2. Selector authority;
3. deterministic Node route authority.

Anything else fails closed.

The existing route-domain model remains in place. This ADR does not replace `routeDomain` with a new Public Origin hierarchy and does not introduce a second routing model.

The three authority classes below apply to **browser-facing HTTP and browser WebSocket traffic only**. The RFC-0006 machine API is a separate private ingress plane. Machine requests are admitted by the existing private transport boundary and machine-signature validation; they are not admitted by `managementAuthority`, the Selector authority, or a Node browser authority. A public gateway MUST NOT expose `/api/v1/*`.

Conceptually, Orbit configuration becomes:

```text
trustedExternalScheme
managementAuthority
routeDomain
```

For example:

```text
trustedExternalScheme = https
managementAuthority   = registration.example.com
routeDomain           = dsh.example.com
```

A mounted drill may use:

```text
trustedExternalScheme = https
managementAuthority   = 127.0.0.1:8443
routeDomain           = dsh-orbit.test:8443
```

`managementAuthority` MUST be distinct from the route-domain namespace. It MUST NOT equal the route apex and MUST NOT be a member of that namespace, including a deterministic Node authority or another route-domain subdomain. If a deployment intentionally has no browser management surface, it may omit the management authority only when management HTTP is disabled; a browser management surface with a missing or malformed management authority fails closed at startup. Exact environment-variable naming is an implementation detail to be decided during construction review.

## 1. Authority classes

### 1.1 Management authority

Only the explicitly configured management authority may expose the Hub management surface.

Conceptually:

```text
Host == managementAuthority
    -> management UI / allowed /hub/* surface
```

An unrelated authority must never fall through to management.

### 1.2 Selector authority

The existing route apex remains the Selector authority:

```text
Host == routeDomain
    -> Selector surface only
```

The Selector authority must not expose general Hub management mutation APIs or the private machine API.

The Selector may expose only the RFC-0011 selector surface: selector UI assets, selector session bootstrap/verification as required by RFC-0007, and `GET /hub/selector/nodes`. It must not expose general node/token/route-target mutation APIs. A selector session is scoped to the Selector authority and is not a management-authority session.

### 1.3 Node route authority

Node authorities continue to use the existing RFC-0010 deterministic form:

```text
n-<32 lowercase hex>.<routeDomain>
```

A syntactically valid Node authority is not sufficient for routing. The corresponding Node must exist and pass the existing fail-closed route-eligibility contract.

This ADR does not modify the current RFC-0010 eligibility model.

## 2. Authority classification is fail closed

The Hub browser-facing authority classifier should behave conceptually as:

```text
request authority
    |
    +-- exact managementAuthority
    |      -> management surface only
    |
    +-- exact routeDomain apex
    |      -> Selector surface only
    |
    +-- exact n-<nodeId>.<routeDomain>
    |      -> existing Node route path
    |
    +-- anything else
           -> deny
```

The current implicit behavior:

```text
unrelated Host -> management surface
```

is removed.

This is the primary product change authorized by this ADR.

## 3. Request authority is input, not trust

The request authority received by Orbit is untrusted input.

Orbit configuration defines what authorities are accepted. A request header does not define Orbit's public identity merely because it reached the Hub.

Therefore:

```text
request authority
    -> normalize using the existing authority rules
    -> classify against managementAuthority / routeDomain
    -> allow only the matching surface
    -> otherwise deny
```

The implementation should reuse or minimally extend the existing route-authority validation machinery rather than introduce a parallel Origin framework.

At minimum, management-authority validation must preserve the properties already important to Orbit routing:

- DNS hostname comparison is case-insensitive;
- when a port is explicitly configured, it remains part of the authority and must be matched exactly;
- malformed authorities fail closed;
- an authority cannot silently become a different surface;
- scheme, path, query, fragment, userinfo, whitespace, and malformed port forms are rejected;
- one normal trailing-dot form may be normalized consistently with the existing route-domain rules;
- unsupported IPv6, IDNA/Unicode, and default-port equivalence forms are rejected rather than guessed.

The implementation MUST produce one canonical authority for classification and Origin comparison. The sequence is: parse the received Host authority, normalize it using the accepted grammar, classify it against the configured management authority or route namespace, and compare a present Origin's scheme and canonical authority with that already validated request authority. Raw Host text and forwarded headers are never used as an authority oracle.

This ADR does not introduce new default-port equivalence, IDNA behavior, HTTP/2 listener semantics, or a general-purpose URL canonicalization subsystem.

## 4. Gateway contract

The gateway is a deployment adapter, not an authority oracle.

Orbit does not need to know whether the deployment uses Caddy, Nginx, Envoy, Traefik, Cloudflare Tunnel, or another reverse proxy.

The gateway contract is intentionally small:

1. The Hub must receive a request authority that satisfies Orbit's configured authority policy.
2. Dynamic Node authorities and any explicitly configured ports must not be lost or replaced by internal service names.
3. Client-controlled forwarded headers must not become a way to redefine authority.
4. Client-supplied internal authentication/principal headers must still be stripped before trusted gateway values are injected.

Orbit does not define proxy-brand-specific normalization behavior. The result presented to Orbit either passes Orbit's authority validation or it does not.

## 5. Forwarded headers are not authority inputs

The following headers do not participate in authority or Origin trust decisions:

```text
X-Forwarded-Host
X-Forwarded-Proto
Forwarded
```

They may be stripped, ignored, or retained only as non-authoritative diagnostic metadata.

A conflicting client-supplied `X-Forwarded-Host` must never relax Host validation. Existing fail-closed conflict handling may remain as defense in depth, but the forwarded value is never a source of truth.

This ADR does not introduce an authenticated canonical-authority header protocol.

## 6. Gateway authentication and authority validation remain independent

`X-DSH-Authenticated-Proxy` proves only that a request passed through a gateway that possesses the configured internal assertion secret.

It does not prove that:

- the request authority is valid;
- the request belongs to the management surface;
- the Origin is valid;
- the session is valid;
- CSRF requirements are satisfied;
- a Node route is eligible.

For management traffic, the admission chain remains conjunctive:

```text
gateway admitted
AND
validated request authority == configured managementAuthority
AND
existing Origin policy passes
AND
valid operator principal/session
AND
valid CSRF when required
```

No successful check substitutes for another. A valid gateway assertion never authorizes an unrelated Host, and a valid authority never substitutes for gateway authentication.

## 7. Origin policy remains narrowly scoped

This ADR does not redesign RFC-0007 Origin semantics.

For the management surface, the existing rule remains:

- if `Origin` is present, its scheme and authority must match the trusted external scheme and the already validated management authority;
- `Sec-Fetch-Site: cross-site` remains denied;
- existing session and CSRF rules remain unchanged.

This ADR does **not** newly require an `Origin` header on every unsafe management request. If that hardening is desired later, it requires a separate review because it changes browser-management protocol semantics.

Selector behavior remains governed by RFC-0011.

Node-routed DSH traffic remains governed by RFC-0010 and must not inherit Hub management Origin rules. Orbit continues to treat DSH as an opaque downstream runtime.

## 8. Existing route-domain model remains authoritative

The following existing concepts remain valid:

```text
DSH_ORBIT_HUB_TRUSTED_SCHEME
DSH_ORBIT_HUB_ROUTE_DOMAIN
```

The route-domain implementation continues to own:

- Selector apex authority;
- deterministic Node authority derivation;
- route namespace validation;
- route-domain port matching;
- malformed route-domain rejection;
- Node mapping and route eligibility.

This ADR does not rename `routeDomain`, replace it with a full `routeApexPublicOrigin`, or require a migration to a second public-origin configuration model.

The only new product concept required by this decision is an explicit management authority.

## 9. Security properties

This decision provides the following properties:

1. An authenticated gateway request cannot reach management through an arbitrary Host value.
2. Management, Selector, and Node route traffic have explicit authority boundaries.
3. Unknown or unrelated authorities fail closed.
4. Forwarded headers cannot redefine Orbit authority.
5. A valid gateway assertion cannot convert an invalid authority into a management request.
6. Existing deterministic Node routing and five-condition eligibility remain unchanged.
7. Non-default route and management ports remain significant when explicitly configured.
8. Orbit remains independent of proxy brands.
9. DSH remains opaque behind the Node routing boundary.

## 10. Non-goals

This decision does not add:

- a new Public Origin hierarchy;
- replacement of `routeDomain`;
- dynamic public Origin discovery;
- proxy-brand-specific runtime behavior;
- trust in `X-Forwarded-*` or `Forwarded`;
- a new authenticated canonical-authority header protocol;
- mandatory Origin on all unsafe management requests;
- a general-purpose Origin/URL canonicalization framework;
- new default-port equivalence semantics;
- IDNA/Unicode hostname expansion;
- native HTTP/2 Hub listener support;
- path-prefix node routing;
- reverse tunnels, NAT traversal, or v0.5 connectivity behavior;
- any relaxation of RFC-0010 route eligibility or cookie isolation.

## 11. Relationship to the current C8.3 issue

The Stage 8 issue exposed two separate facts:

1. the mounted gateway adapter did not reliably deliver the complete authority required by the existing Host/Origin contract;
2. Orbit currently lacks an explicit management-authority boundary, so unrelated authorities can fall through to management.

The first is a mounted adapter defect.

The second is the product gap addressed by this ADR.

The correct response is not to add a Caddy special case and not to weaken Hub Origin validation.

The current release line remains:

```text
C8.3 = FROZEN
Final Evidence = BLOCKED
E8.5 = NOT CREATED
```

C8.3 must not be edited in place to make mounted evidence pass.

If this ADR is accepted, implementation must occur in a new construction candidate, followed by a new freeze point and fresh mounted evidence.

## 12. Bounded construction after approval

Approval of this ADR should authorize only the minimum work required to close this boundary.

### Configuration

- add one explicit management-authority configuration value;
- reject malformed management authority at startup;
- preserve explicitly configured non-default management port.

### Authority classification

- exact management authority reaches only management surface;
- exact route apex reaches only Selector surface;
- deterministic Node authority continues through the existing Node route path;
- unrelated authority fails closed;
- management authority cannot route Node traffic;
- Selector authority cannot expose management mutation or machine APIs;
- management authority and the complete route namespace are disjoint;
- RFC-0006 `/api/v1/*` remains on the private machine ingress plane and is not classified as browser authority;
- browser WebSocket upgrades are allowed only on eligible Node authorities; management and Selector authorities reject them;
- missing or malformed management authority fails closed when browser management is enabled.

### Existing Node route behavior

- unknown Node authority fails closed;
- deleted/tombstoned Node fails closed;
- ineligible Node fails closed;
- eligible Node routes normally;
- existing RFC-0010 identity and eligibility semantics remain unchanged.

### Browser security

- valid management request succeeds under the existing gateway/session/CSRF/Origin rules;
- wrong management Host fails;
- wrong Origin scheme/authority fails when Origin is present;
- cross-site management request fails;
- no new Origin-presence requirement is introduced by this ADR.

### Gateway adapter

- mounted gateway delivers the configured management authority; when an explicit port is present, it is preserved as part of the authority;
- mounted Node routes preserve the complete deterministic Node authority;
- client `X-Forwarded-Host` / `X-Forwarded-Proto` cannot alter Orbit classification;
- no product code branches on proxy brand;
- the adapter is tested by its externally observed Host/Origin behavior, not by a proxy-specific implementation assumption.

### Fresh evidence

- freeze a new executable candidate before the mounted run;
- bind Stage 8 artifacts to that exact candidate;
- generate final mounted evidence only after the revised authority boundary passes;
- keep evidence-only closure commits free of product/runtime changes.

## Consequences

### Positive

- closes the unrelated-Host-to-management fallback;
- preserves the already accepted v0.4 route architecture;
- keeps the change small enough for release-closure review;
- keeps Orbit independent of specific reverse proxies;
- avoids creating a second authority/origin model beside the existing route-domain implementation.

### Cost

- one new management-authority configuration value is required;
- Hub authority classification and related tests must be updated;
- mounted gateway configuration must demonstrate correct authority delivery;
- a new candidate and fresh evidence are required because C8.3 is frozen.

## Final principle

> **Orbit owns the policy that maps accepted request authorities to its Management, Selector, and Node surfaces. The gateway only delivers requests to that boundary; any authority not explicitly accepted by Orbit fails closed.**
