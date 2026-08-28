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
4. negative authorization tests pass;
5. the DSH web UI and long-lived transport remain functional.

Unknown versions are rejected by `src/compatibility.mjs`.

## Source-layout changes

When upstream code changes, add a new compatibility profile rather than broadening an old exact matcher. This keeps older supported versions deterministic and makes the security review of each upstream change explicit.

## Upstream support takes precedence

If a future DSH release provides an official authenticated remote configuration plane, DSH Orbit should use that capability instead of patching the same behavior.
