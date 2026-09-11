# DSH Version Compatibility Policy

## Overview

Orbit releases are validated against a selected DSH compatibility baseline.

Orbit does not guarantee compatibility with every DSH release, development build, or release candidate.

Each Orbit release declares its supported DSH baseline and validated capabilities.

---

## Compatibility Status

| Status | Description |
| --- | --- |
| SUPPORTED | Validated through required tests and integration checks |
| LEGACY | May continue to work but is not actively validated |
| UNSUPPORTED | Not tested or incompatible |

Only `SUPPORTED` versions are covered by Orbit release guarantees.

The runtime enforcement point is `compatibilityProfiles` in
`src/compatibility.mjs`: a version that is absent from that map fails closed,
and `compatibilityFor()` reports the tested version list. A policy status only
means something when a matching profile entry exists, so the profile map and
this table must be updated together.

---

## Release Baseline Policy

Each Orbit minor release is bound to a specific DSH compatibility baseline.

Example:

```text
Orbit v0.4.x
    |
    +-- DSH 0.1.1-rc.2
```

A new Orbit minor release may adopt a newer DSH baseline.

Orbit does not follow every DSH release candidate automatically.

---

## Version Update Rules

### Patch Release

Patch releases (`x.y.Z`) keep the existing DSH compatibility baseline.

Allowed:

- Bug fixes
- Security fixes
- Documentation updates
- Internal improvements

Not allowed:

- Changing the supported DSH baseline

### Minor Release

Minor releases (`x.Y.0`) may update the DSH compatibility baseline.

A baseline change requires:

- Updated compatibility declaration
- DSH acceptance validation
- Capability verification
- Updated documentation

---

## Capability Binding

Compatibility is defined by both DSH version and validated capabilities.

Example:

```yaml
dsh:
  version: 0.1.1-rc.2

capabilities:
  - sessions.resume
  - settings.remote
  - web.routes
```

Version matching alone does not replace capability validation.

Capability names are defined by `CAPABILITY_EVIDENCE` in
`src/registry/capabilities.mjs`, and each name is only derived when every
listed compatibility-report check passes. `terminal.pty` and `agents.run` are
not claimable: no automated PTY or streaming runtime evidence exists, so they
are never part of a compatibility declaration.

---

## Release Candidate Policy

Orbit does not maintain compatibility with every DSH release candidate.

The adoption process is:

```text
DSH development release
        |
        v
Capability validation
        |
        v
Selected compatibility baseline
        |
        v
Orbit release adoption
```

A DSH release candidate becomes an Orbit baseline only after explicit selection and validation.

---

## Compatibility Declaration

Every Orbit release should declare:

- Supported DSH version
- DSH commit or package identifier when required
- Validated capabilities
- Compatibility status

Example:

```text
Orbit: v0.4.x

DSH:
0.1.1-rc.2

Status:
SUPPORTED
```

---

## Non-Goals

Orbit does not aim to:

- Support every DSH version simultaneously
- Automatically track the latest DSH releases
- Provide guarantees for unvalidated combinations

Compatibility is explicit and versioned.
