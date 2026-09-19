# Verification TLS Trust Policy

Status: **NORMATIVE**

This policy applies to all automated, drill, mounted, browser, and release-
qualification verification performed by DSH Orbit.

## Principle

Verification must preserve real TLS trust validation without mutating the host
operating system's persistent Root trust stores.

The goal is not to remove CA validation. The goal is to make trust **run-scoped,
process-scoped, and disposable** so unattended verification never requires an
OS trust prompt and never leaves a machine-wide or user-wide trust anchor
behind.

## Required rules

1. **OS Root trust-store mutation is forbidden.**
   Verification tooling must not install, delete, or otherwise mutate temporary
   drill/test CA certificates in Windows System Root, Windows CurrentUser Root,
   macOS System/Login keychains, or equivalent host-wide trust stores.

2. **Insecure TLS bypasses are forbidden.**
   Verification must not use mechanisms such as:
   - `accept_insecure_certs = true`;
   - `--ignore-certificate-errors`;
   - `rejectUnauthorized = false`;
   - disabling hostname/SAN verification;
   - replacing an HTTPS acceptance path with HTTP only to avoid certificate
     validation.

3. **Node/CLI/HTTP clients must use an explicit run-scoped CA bundle.**
   A verification run may generate a temporary CA and leaf certificate, but
   clients must trust that CA through an explicit per-run CA path or process-
   local TLS context.

4. **Firefox/Selenium must use a runner-owned temporary browser profile.**
   When Firefox must trust a private verification CA, the CA must be imported
   only into that temporary profile's NSS certificate database. The browser
   profile must be owned by the current run and deleted after the run. The
   runner uses Mozilla NSS `certutil`; on Windows, set `DSH_ORBIT_NSS_CERTUTIL`
   to the NSS executable when it is not available on `PATH`. Windows' built-in
   `certutil.exe` is not an acceptable substitute because it operates on OS
   certificate stores rather than the runner-owned Firefox profile database.

5. **Browser trust must remain strict.**
   The temporary-profile trust must still enforce certificate chain validation,
   hostname/SAN validation, expiry, and the expected authority. Unknown CA,
   wrong SAN, wrong hostname, and mismatched certificate cases must fail closed.

6. **No interactive certificate installation is allowed.**
   Verification must not depend on a Windows trust prompt, certificate UI, or
   operator confirmation to install a CA. If Mozilla NSS `certutil` or another
   approved profile-local trust mechanism is unavailable, or if a required test
   cannot be executed without persistent OS Root-store mutation, that test must
   report `BLOCKED` and stop. It must not weaken TLS to continue.

7. **Trust material is run-owned residue.**
   Temporary CA private keys, leaf private keys, certificates, browser profiles,
   NSS databases, checkpoints, and related logs must be deleted by bounded
   run-owned cleanup. Cleanup must not recursively delete unrelated repository
   or operator data.

8. **Cleanup failures fail closed.**
   A run must not be recorded as successful when its required trust/residue
   cleanup fails. Evidence generation and release qualification must stop until
   cleanup is complete or the run is explicitly classified as failed.

9. **Preexisting host trust must not be modified.**
   Verification may inspect host trust for diagnostics, but it must never remove
   or alter a preexisting certificate or trust anchor.

10. **Evidence must record the trust mode.**
    Mounted/browser evidence must state that TLS verification was enabled and
    identify the run-scoped CA/leaf fingerprints or equivalent bindings without
    embedding private key material.

## Browser implementation pattern

The preferred browser flow is:

```text
generate run-scoped CA + leaf
        ↓
create runner-owned temporary Firefox profile
        ↓
import CA into that profile's NSS DB only
        ↓
run Selenium with strict TLS verification
        ↓
verify positive and negative TLS cases
        ↓
close Firefox/geckodriver
        ↓
delete temporary profile + run-scoped trust material
```

The following flow is prohibited:

```text
generate temporary CA
        ↓
install into OS CurrentUser/System Root
        ↓
run browser verification
        ↓
delete OS Root certificate afterwards
```

Even precise-thumbprint cleanup does not make persistent OS Root mutation the
preferred or accepted verification model because it can trigger interactive
prompts and temporarily broadens host trust outside the runner-owned process
boundary.

## Release-gate consequence

A verification result is not eligible for mounted/release PASS when it:

- requires persistent OS Root-store mutation;
- bypasses TLS verification;
- leaves run-owned trust or browser-profile residue;
- cannot prove negative unknown-CA / wrong-SAN behavior;
- reports cleanup failure or ambiguous trust ownership.

In those cases the run remains fail-closed and must be reported as
`BLOCKED` or `FAIL`, never upgraded to PASS by prose or manual interpretation.

## Scope boundary

This policy governs verification infrastructure only. It does not change Orbit
production TLS semantics, gateway trust rules, node identity, route authority,
or compatibility policy. Any production security-semantic change still requires
its normal architecture/security review.
