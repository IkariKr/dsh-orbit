# User experience documentation

This directory records user-facing flows and product references for DSH Orbit. It
covers operator UI, device and node visibility, selector behavior, responsive and
mobile use, and user-visible errors.

These documents are not substitutes for the formal contracts:

- [Registry operator UI contract](../registry-ui.md) defines the current v0.3
  browser UI behavior and its automated walkthrough;
- [RFC 0011: Browser node selection](../rfc/0011-browser-node-selection.md)
  defines the v0.4 selector and route behavior;
- [Roadmap](../roadmap.md) defines milestone scope and explicit exclusions;
- architecture, security, RFC, ADR, and release-attestation documents remain the
  authority for implementation, trust boundaries, and release status.

## Documents

- [External reference: `dsh-remote-mobile`](dsh-remote-mobile.md) — project
  overview, device visibility and QR pairing observations, safe Orbit borrowing
  boundaries, and staged implementation recommendations.

## UX principles for Orbit

- Keep the current target visible. A browser or mobile client must make the
  selected node and its authority apparent.
- Prefer explicit actions over hidden retargeting. A failed node must not silently
  become another node, and multi-node actions must have an explicit target scope.
- Show independent state dimensions instead of flattening health into one badge.
- Make enrollment, session revocation, and route availability understandable and
  reversible where possible.
- Treat mobile layout and touch behavior as client experience concerns; do not
  weaken authentication, Origin/CSRF checks, TLS verification, cookie isolation,
  or machine-ingress boundaries to improve convenience.
