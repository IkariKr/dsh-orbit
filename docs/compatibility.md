# Compatibility

DSH Orbit only claims compatibility with DeepSeek Harness versions that have been tested against the patcher and deployment contract.

| DeepSeek Harness | DSH Orbit | Remote settings | Profile-local patch | Status |
| --- | --- | --- | --- | --- |
| `0.1.1-rc.2` | `0.1.0` | Supported | Required and verified | Tested |

## Compatibility policy

An upstream version is not supported merely because it builds.

A version becomes supported when:

1. its source layout matches a reviewed compatibility profile;
2. the patcher applies and verifies both required client-connection copies;
3. authenticated settings reads and writes pass;
4. at least one session created before the upgrade passes an existing-session resume smoke test;
5. negative authorization tests pass;
6. the DSH web UI and long-lived transport remain functional.

Unknown versions are rejected by `src/compatibility.mjs`.

## Existing-session compatibility

DSH sessions are persistent runtime state, not just transcripts. An upstream or profile-runtime change can leave historical sessions readable on disk while failing when the agent is reconstructed.

One known failure mode is:

```text
agent-presets: refusing to compose an unscoped context
```

This can appear when a session created under one DSH runtime is resumed after package-resolution or scope semantics change. A successful build and a healthy web process do not detect it. Candidate validation therefore includes `scripts/smoke-session-resume.mjs` against a pre-upgrade session stored in copied data.

## Source-layout changes

When upstream code changes, add a new compatibility profile rather than broadening an old exact matcher. This keeps older supported versions deterministic and makes the security review of each upstream change explicit.

## Upstream support takes precedence

If a future DSH release provides an official authenticated remote configuration plane, DSH Orbit should use that capability instead of patching the same behavior.
