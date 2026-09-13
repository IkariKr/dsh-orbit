# DSH Version Compatibility Policy

**Current selected shipping baseline:** Orbit `v0.4.1` → DeepSeek Harness
`0.1.5-rc.2`.

**Qualification status:** pending release compatibility evidence. `0.1.5-rc.2` is
the selected shipping baseline, not yet a published `SUPPORTED` version — see
[Baseline Selection and Release Qualification](#baseline-selection-and-release-qualification).

`0.1.1-rc.2` is retained as `LEGACY`: it is the historical `v0.4.0` baseline.
The machine-readable form is `compatibilityProfiles` in
`src/compatibility.mjs`, and the release attestation records the upstream commit
SHA and artifact digests for the shipping baseline.

Related: [Overview](dsh-orbit-overview.md) · [Compatibility](compatibility.md) ·
[Comparison](comparison.md).

## Overview

Orbit releases are validated against a selected DSH compatibility baseline.

Orbit does not guarantee compatibility with every DSH release, development build, or release candidate.

Each Orbit release declares its supported DSH baseline and validated capabilities.

---

## Compatibility Status

| Status | Description |
| --- | --- |
| SUPPORTED | Validated through required tests and integration checks |
| LEGACY | Previously validated baseline retained and regression-checked for upgrade continuity, but not the shipping baseline and not covered by the current release's baseline guarantee |
| UNSUPPORTED | Not tested or incompatible |

Only `SUPPORTED` versions are covered by Orbit release guarantees.

The runtime enforcement point is `compatibilityProfiles` in
`src/compatibility.mjs`: a version that is absent from that map fails closed,
and `compatibilityFor()` reports the accepted version list. A policy status only
means something when a matching profile entry exists, so the profile map and
this table must be updated together.

Each profile carries the policy status in its `status` field:

| `status` | Meaning |
| --- | --- |
| `tested` | The shipping baseline. One Orbit release selects exactly one. |
| `legacy` | A previously validated baseline kept for existing deployments. |

A `legacy` entry stays capability-granted: a node on that version keeps the
capabilities its compatibility report earns, so an upgrade does not silently
disable a working deployment. A release does keep a regression check on that
path — the legacy generation's real-process acceptance stays in the suite — but
it does not requalify the version or claim it as the shipping baseline, so
`legacy` never appears in a release guarantee. Withdrawing a version is a
deliberate policy change, not a side effect of adding a baseline — it removes
the entry instead, which is what makes `deriveCapabilities()` return nothing
for it.

---

## Baseline Selection and Release Qualification

Selecting a baseline and qualifying it are separate steps, and this policy keeps
them apart:

```text
Stage 9   transport and authentication compatibility proven
C9        shipping baseline selected
E9        full release compatibility qualification
Release   SUPPORTED claim published
```

A release declares its selected baseline as soon as the reviewed profile exists,
because the runtime must recognize the exact profile before the qualification run
can execute against it. Until that run passes every required check in the
compatibility policy — including settings reads and writes, the authorization
smoke, and the existing-session resume check — the baseline is documented as
*selected*, never as `SUPPORTED`. Publication of the support claim is the last
step, not the first.

---

## Release Baseline Policy

Each Orbit release is bound to a specific DSH compatibility baseline. A minor
release may adopt a new one; a patch release may do so only as an explicit
compatibility refresh, defined under [Version Update Rules](#patch-release).

Example:

```text
Orbit v0.4.0-rc.1
    |
    +-- DSH 0.1.1-rc.2        historical, now LEGACY

Orbit v0.4.1
    |
    +-- DSH 0.1.5-rc.2        selected shipping baseline (qualification pending)
```

A new Orbit minor release may adopt a newer DSH baseline, and a patch release
may do so as a compatibility refresh. The previous baseline moves to `legacy`
rather than disappearing, so the earlier release's evidence and the previous
generation's regression coverage stay reproducible.

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
- A compatibility refresh (see below), when explicitly scoped as one

Not allowed:

- Changing the supported DSH baseline other than through a compatibility refresh

#### Compatibility Refresh Patch Release

A patch release may adopt a new DSH shipping baseline only when the release is
explicitly scoped as a compatibility refresh and:

- introduces no new Orbit product feature or schema contract;
- completes the required real-DSH compatibility acceptance;
- preserves or explicitly withdraws prior legacy compatibility;
- records the new pinned upstream identity and evidence.

The prior baseline moves to `legacy` under this policy, so an existing
deployment on it keeps working instead of going dark on upgrade. A compatibility
refresh is a baseline change and nothing else: if the work needs new product
surface, it is a minor release, not a refresh.

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
  version: 0.1.5-rc.2

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
Orbit: v0.4.1

DSH:
0.1.5-rc.2

Status:
qualification pending

Retained:
0.1.1-rc.2 (LEGACY)
```

---

## Non-Goals

Orbit does not aim to:

- Support every DSH version simultaneously
- Automatically track the latest DSH releases
- Provide guarantees for unvalidated combinations

Compatibility is explicit and versioned.
