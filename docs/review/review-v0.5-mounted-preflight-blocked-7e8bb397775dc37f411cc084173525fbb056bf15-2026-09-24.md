# DSH Orbit v0.5 Successor Mounted Preflight — Blocked Before Start

Date: 2026-09-24
Classification: preflight-only record; NOT formal mounted evidence

## Candidate and authorization

- Frozen candidate: `7e8bb397775dc37f411cc084173525fbb056bf15`
- Candidate Gate C: GO for this exact SHA, recorded in `review-v0.5-gate-c-successor-7e8bb397775dc37f411cc084173525fbb056bf15-2026-09-24.md`.
- D8 architecture ratification: recorded in `review-v0.5-d8-readiness-ratification-7e8bb397775dc37f411cc084173525fbb056bf15-2026-09-24.md`.
- This record does not claim Stage 8 ran or that any mounted field passed.

## Attempt

Ran the external runner's read-only command:

```text
node runner.mjs --preflight
```

Observed output:

```json
{
  "status": "PREFLIGHT_PASS",
  "formalRunStatus": "BLOCKED_BEFORE_START",
  "blockers": [
    "streamingUploadReverse requires an unapproved DSH-side observer",
    "channelAbortCleanup requires a controlled slow receiver that is not in the approved overlay",
    "noCredentialLeak requires an authorized DSH-side header observer",
    "successful-run cleanup and authentic reverse session/channel provenance need end-to-end validation"
  ],
  "unimplementedMountedFields": [
    "streamingUploadReverse",
    "channelAbortCleanup",
    "noCredentialLeak"
  ],
  "candidateSha": "405c2ac6258b5a0d669431a169f9c196b2a01e49",
  "runId": "9fc50fc2-222c-41e0-aab2-5ef183c3c081",
  "writes": []
}
```

The preflight's candidate SHA is the old frozen `405c2ac` candidate, not the authorized successor `7e8bb397…`. The runner and Compose overlay are pinned to old SHA-specific images and runtime identity. The overlay does not configure `DSH_ORBIT_NODE_DSH_READINESS_TARGET` for Node B. The runner also explicitly blocks the three mounted fields above and has not established successful-run cleanup/provenance end to end.

External runner source hashes at inspection time:

- `runner.mjs`: `11664cab0be246b53bef962a9baa5e1f1c140b0b06fddc414def393541927e52`
- `compose/formal.overlay.yaml`: `5c5dc45a9526370c41b02836c5f22d4dd45b916e2e0261c95623749c23a60cc5`
- `package.mjs`: `2239de2487860e1e8f48c4b9d2ecdaf5c7327860153b39f568fadb224942d6c1`

## Disposition and hygiene

- Formal run: **NOT STARTED**.
- Mounted evidence writes: **none** (`writes=[]`).
- D14 mounted-required fields: **33 NOT_EXECUTED**.
- Seven-artifact set: **NOT CREATED**.
- Compose startup: **not invoked by preflight**.
- Run-owned containers/volumes: none observed after preflight; cleanup was not needed.
- Frozen product/harness and external runner files: not modified by this preflight.

A `PREFLIGHT_PASS` label is only a read-only configuration check; the authoritative disposition is `BLOCKED_BEFORE_START`. Do not use the preflight run ID or output as mounted PASS evidence. The external mounted runner must be replaced by an independently reviewed, successor-SHA-bound capable path without modifying the frozen candidate harness, or the mounted requirement remains blocked. No tag/release, production promotion, or DNS cutover is authorized.
