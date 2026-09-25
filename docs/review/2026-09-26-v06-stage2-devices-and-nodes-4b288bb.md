# DSH Orbit v0.6 Stage 2 Gate 2 Code Review

- Date: 2026-09-26
- Gate: Gate 2 Review (Stage 2 — Hub Read Model & Devices and Nodes View)
- Decision: **PASS WITH NON-BLOCKING FINDINGS** (P0 = 0, P1 = 0, P2 = 1, P3 = 2)
- Reviewed HEAD: `4b288bb13041bccc2208317a25bd158d9e69ec47`
- Branch: `chore/v0.6-stage2-devices-and-nodes`
- Parent / upstream baseline: `e884131` (Stage 1 Gate 1 PASS), descending from accepted v0.5 closure `bfcc541d84f3fc5fb3bb14fa54100276e41816ba`
- Worktree: clean (`git status --porcelain` empty); `git diff --check` clean
- Controlling documents:
  - `docs/rfc/0013-multi-node-sessions-and-target-scope.md` (D3, D4, matrix fields 1 / 20 / 23)
  - `docs/sop/v0.6-multi-node-sessions-multistage-sop.md` (Stage 2)
  - `docs/release-attestations/v0.6-construction-authorization-2026-09-25.json` (`V06-CONSTRUCTION-20260925-A1`)
  - `docs/ux/README.md`, `docs/ux/dsh-remote-mobile.md` (Devices and Nodes UX reference)
  - `docs/registry-ui.md` (v0.3 UI rendering contract)

## Review Scope

Stage 2 product delta `e884131..4b288bb` (two commits `bba8e7d`, `4b288bb`):

- `ui/view-model.mjs` — `mapNodeRow` (`activeFlows`, `targetScope`), `mapNodeList(nodes, activeSessions)`, new `mapOverview`.
- `ui/app.mjs` — `loadNodes` dual fetch (`/hub/nodes` + `/hub/overview`), `#overview-summary` aggregate card, `.target-scope-chip`, `.route-observability` `activeFlows`, `scopedOpenNode` / `scopedRefreshNode` via `POST /hub/actions/node`, error banner + 401 `sessionRequired` re-handshake retry, `window.open(..., "noopener,noreferrer")`.
- `ui/styles.css` — `.overview-panel`, `.target-scope-chip`, `button.secondary`.
- `test/v06-stage2-devices-and-nodes.test.mjs` — 7 unit/integration tests.

Server-side endpoints `GET /hub/overview` and `POST /hub/actions/node` were authored in Stage 1 (`3519f71`, `928c466`) and re-verified here as the read-model/action dependency of Stage 2. They are not re-litigated as Stage 2 deltas.

## Findings

### [P2] `/hub/overview` read model omits `displayName`; RFC-0013 D3 display-name indication is unreachable in production

`src/registry/server.mjs:944` (`managementNodeSummary`), `ui/view-model.mjs:66`, `test/v06-stage2-devices-and-nodes.test.mjs:109`

RFC-0013 D3 states the read model must expose `displayName` (see the documented payload at `docs/rfc/0013-multi-node-sessions-and-target-scope.md:93,101`) and that "the UI must visually indicate the active target node with its display name and truncated ID" (`:82`).

The implemented read model never emits `displayName`: `managementNodeSummary` spreads `registry.toNodeSummary(row)` (`src/registry/registry.mjs:1409`), which has no `displayName`/`display_name` field, and the `nodes` table has no such column (`src/registry/sqlite.mjs:315`). A repo-wide search shows the only `displayName` producers are the RFC example and the test's synthetic object.

Consequence: `mapNodeRow`'s `node.displayName ? ... : ...` branch (`ui/view-model.mjs:69`) is always false in production, so the chip label is always `target: <13-char id>…`. The display-name formatting is asserted only against a hand-built object (`test/...:109-113`), giving false confidence that D3's display-name requirement is satisfied end-to-end. Impact is limited (the truncated-ID fallback is functional and does still identify the target), and the gap is consistent with the pre-existing, accepted v0.4/v0.5 selector behavior (`buildSelectorNodeRow` also omits a display name), so it does not block Gate 2.

Minimal fix direction: either surface a `displayName` in the management read model (requires a registry/schema decision, likely out of v0.6 scope), or record the display-name capability as an explicit deferred limitation in RFC-0013/SOP and drop the synthetic-only assertion so the test reflects reality.

### [P3] `loadNodes` fetches two byte-identical endpoints per load, and the `nodesBody.activeSessions` fallback is dead code

`ui/app.mjs:271`, `ui/view-model.mjs:125`, `src/registry/server.mjs:708`

`GET /hub/nodes` and `GET /hub/overview` resolve to the *same* handler branch (`src/registry/server.mjs:708`) and return identical payloads (`nodes` + `activeSessions`). `loadNodes` issues both in parallel via `Promise.all` (`ui/app.mjs:271-274`), so every node-list load runs `managementNodeList()` twice (per-node DB reads plus reverse-eligibility evaluation) for identical data. Since `mapOverview` always returns a non-null `activeSessions` object with `{0,0}` defaults (`ui/view-model.mjs:131-134`), the `overview?.activeSessions ?? nodesBody.activeSessions` fallback (`ui/app.mjs:276`) can never reach `nodesBody.activeSessions`; a malformed `/hub/overview` body would silently render `0 flows across 0 nodes` instead of the correct counts already present in the `/hub/nodes` response. No functional regression today (payloads are identical), but it is redundant work and a latent masking path.

Minimal fix direction: fetch `/hub/overview` alone (it carries `nodes` + `activeSessions`), or make `mapOverview` return `activeSessions: null` when the payload lacks the summary so the existing fallback is live.

### [P3] App-level tests never exercise the `/hub/overview` success path through `app.mjs`

`test/v06-stage2-devices-and-nodes.test.mjs:135` (and the other app-level cases)

The app-level fake `fetchImpl` handlers stub only `/hub/session` and `/hub/nodes`; `/hub/overview` falls through to the default `404` and is swallowed by `.catch(() => null)` (`ui/app.mjs:273`). Verified empirically: with the test's exact fake fetch the app still renders `#overview-summary`, but it does so through the `nodesBody.activeSessions` fallback, not through `mapOverview`. The D3 summary card is therefore covered only by (a) a synthetic `mapOverview` unit test and (b) a server-only integration test; the `app.mjs` → `/hub/overview` → `mapOverview` path is not tested end-to-end.

Minimal fix direction: add `/hub/overview` to one app-level fake fetch (or drive one case through a real Hub as `test/ui-dom.test.mjs` does) and assert the summary reflects the overview response.

## Verification

Executed (all read-only):

- `git status --porcelain` → empty; `git diff --check` → clean.
- `node --test test/v06-stage2-devices-and-nodes.test.mjs` → 7/7 pass.
- `node --test` (full suite) → 526 tests, 520 pass, 0 fail, 6 skipped.
- `node scripts/check-public-tree.mjs` → passed.
- Manual probes:
  - `mapOverview({nodes:[]})` → `activeSessions {totalFlows:0, distinctNodes:0}` (always truthy; confirms P3 dead-fallback).
  - Instrumented `createRegistryUi` run against the test's fake fetch → requested endpoints `['/hub/session','/hub/nodes','/hub/overview']`, `#overview-summary` present via fallback (confirms P3).
  - `mapNodeRow(managementNodeSummary-shaped row)` → `targetScope.label = "target: node_aaaaaaaa…"`, no `displayName` field (confirms P2).
  - Real Firefox (WebDriver BiDi) probe of an `await`-then-`window.open` handler: the popup still opened (transient user activation survives the async gap), so the async `window.open` in `scopedOpenNode` is not a popup-blocking defect.

Reviewed but not executed: mounted/live browser and two-node runs (Stage 3+/Gate B/C scope; explicitly out of Gate 2).

## Residual Risks

- Persistent `sessionRequired` with a *successful* re-bootstrap would recurse unboundedly in `scopedOpenNode`/`scopedRefreshNode` (`ui/app.mjs:430-432`, `447-449`). This mirrors the pre-existing `loadNodes`/`loadTokens` pattern and needs a cookie/session misconfiguration to trigger, so it is not a Stage 2 regression; a retry-depth guard would harden it.
- The `open` scoped action returns a route URL for any existing node without an eligibility gate (`src/registry/server.mjs:776-782`), unlike the selector's `openUrl` (`src/registry/selector-view.mjs:96`). For an active-but-unreachable node this opens a tab that the route proxy then fails closed with 503, which is consistent with RFC-0013 D5; verified by code inspection only.
- The opened URL omits any non-default port (`${trustedExternalScheme}://${routeAuthority}/`), matching the accepted selector `openUrl` behavior; not introduced by Stage 2.
- The `#overview-summary` card is not rendered when there are zero nodes (`mapNodeList` returns `EMPTY_NODES_STATE`, `ui/view-model.mjs:111-112`), so `0 enrolled · 0 flows` is never shown.

## Gate

**PASS WITH NON-BLOCKING FINDINGS** (P0 = 0, P1 = 0; the P2 is a documented requirement/coverage deviation with a working fallback and does not block Gate 2).

Mapping to the requested verdict vocabulary: equivalent to **PASS** with non-blocking findings; not **REVISE** (no blocking P0/P1), not **BLOCK**.

## Review Report

`D:/App/01_Ai/CodeX/dsh-orbit-v05-formal-candidate/docs/review/2026-09-26-v06-stage2-devices-and-nodes-4b288bb.md`
