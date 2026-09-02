# DSH 0.1.2-alpha.5 compatibility reconnaissance

Status: **complete; unsupported; no promotion authorized**

This reconnaissance evaluates whether DSH Orbit `0.3.0` should begin claiming or implementing compatibility with DeepSeek Harness `0.1.2-alpha.5`. It is deliberately narrower than a compatibility acceptance run: no compatibility profile is added, production data is not touched, and no production promotion is attempted.

## Reviewed identities

- Orbit baseline: `46482481c0436f6171bbd02acae19274894c75e2` (`v0.3.0-rc.1` tag target).
- Current supported DSH: `0.1.1-rc.2`.
- Candidate DSH package: `@deepseek-ai/dsh@0.1.2-alpha.5`.
  - npm shasum: `54768e9e5a757721e123fd2a2196723a26e5c610`.
  - npm integrity: `sha512-MrD2rPhmjz+8Phs+d9lD9xL1qswCYjcSHMd96fF8NTdDm7FRRsU5QhLDR0x6U4JwGxEvee1pccuvbZY6NyEQhA==`.
- Candidate client connection package: `@deepseek-ai/dsh-client-connection@0.1.2-alpha.5`.
  - npm shasum: `f222ab1307c8d832f82117012a44bd482e48c0a0`.
  - npm integrity: `sha512-g80LVXFyCZMGlvE3Ki1XWRDoekHcHDYKEREj/ruIIyLweswxal9g4Y/KSGHvz16S+zghHjTPoWmFuzVJtPtlvA==`.
- Upstream `master` at review time: `49a606bc5b5934603f22a26957a07dc799ab0291`, the merge that synchronized `0.1.2-alpha.5` to `master`.

Third-party DSH plugin compatibility is intentionally not part of this review, consistent with ADR-0001.

## Method

The reconnaissance used the existing Orbit compatibility registry and upstream watcher, inspected the exact published npm artifacts for `dsh`, `dsh-web-app`, `dsh-client-connection`, and the client packages that consume `isLoopback`, and ran the current Orbit source matcher against an extracted alpha.5 `dsh-client-connection` artifact with only the version gate bypassed. The bypass was used only to isolate source-layout behavior; it did not add or imply a compatibility profile.

A full Orbit Docker build was attempted twice. Dependency installation did not finish within the 300-second execution window, so those timeouts are recorded as environment/runtime cost and are **not** treated as compatibility failures. The deterministic patch and authentication findings below already block the current candidate workflow before a support claim would be possible.

## Findings

### 1. Orbit correctly rejects alpha.5 today

The upstream watcher classifies `0.1.2-alpha.5` as `unknown`; the only registered compatibility profile remains `0.1.1-rc.2`. A direct `compatibilityFor("0.1.2-alpha.5")` call fails with:

```text
Unsupported DeepSeek Harness version "0.1.2-alpha.5". Tested versions: 0.1.1-rc.2.
```

This fail-closed behavior is correct and must remain in place until a later acceptance run passes.

### 2. The current server compatibility patch no longer matches the published client-connection artifact

Orbit's `remote-settings-patch.mjs` expects the `0.1.1-rc.2` bundle to import `randomUUID` from `node:crypto`. Alpha.5 instead imports `createHash`, `createHmac`, `randomBytes`, and `timingSafeEqual` for its new browser-session implementation.

Running the current patch logic against the exact alpha.5 `client-connection/lib` artifact, while temporarily supplying the already-supported `0.1.1-rc.2` profile only to isolate matcher behavior, fails before writing anything:

```text
DSH Orbit patch failed: missing client-connection crypto import
```

This is a genuine source-layout mismatch, not merely a missing version-table row.

### 3. Repairing the old matcher would still be semantically wrong

The more important change is upstream authentication. In `0.1.1-rc.2`, the request path primarily applied the Host/Origin trust fence. Orbit extended that fence with its gateway-held authenticated-proxy assertion.

In `0.1.2-alpha.5`, `dsh-client-connection` adds `BrowserAuth` and applies it uniformly after the Host/Origin fence:

```text
requestRejection(request):
  trust fence fails -> 403
  browser session missing/invalid -> 401
  otherwise -> dispatch
```

The browser session is established by exchanging a per-process launch token for an authority-bound signed cookie. The same authentication protects Host RPC, exact Fetch routes, and the Remote WebSocket surface.

Therefore, even if Orbit changed only the old import anchor and successfully reinserted `isDshOrbitAuthenticatedProxyRequest()` into `isTrustedApiRequest()`, the gateway assertion would satisfy only the trust fence. It would **not** satisfy `BrowserAuth`. Current Orbit authorization smokes send gateway Basic Auth or access-provider proof but no DSH browser cookie, so the alpha.5 Host API would still return 401 before business dispatch.

The old server patch should not be mechanically ported.

### 4. Upstream now owns more of the behavior Orbit previously patched

Alpha.5 still accepts `dsh web --no-open --trusted-host <authority>`. Its published Web application explicitly documents:

- a carrier-wide Host/Origin trust fence;
- `--trusted-host` for additional served authorities;
- a process launch token exchanged for a signed browser-session cookie;
- one authentication requirement for every Host API method and WebSocket stream;
- loopback-only binding for the shipped Web command.

Orbit already runs DSH on loopback and gives Caddy the same network namespace, so the loopback bind remains compatible with Orbit's private-backend topology. `--trusted-host "$DSH_PUBLIC_HOST"` also remains a valid way to admit the public reverse-proxy authority at the Host/Origin layer.

This is positive upstream convergence. A future Orbit integration should reuse these native mechanisms instead of recreating them in a DSH source patch.

### 5. Current Orbit readiness semantics are incompatible with alpha.5 authentication

`docker/start.sh` waits for DSH with an anonymous request:

```sh
wget -q -O /dev/null http://127.0.0.1:3080
```

The Compose healthcheck repeats the same anonymous root request after `/tmp/dsh-orbit-ready` appears.

Alpha.5's root/index authorization requires either the process launch token exchange or a valid signed browser cookie. An unauthenticated root request receives 401. Therefore the current Orbit readiness loop can treat a healthy alpha.5 Web process as not ready and eventually time out.

A future integration needs a readiness signal that does not assume anonymous HTTP 200. Options should be evaluated against upstream behavior rather than introducing an authentication bypass; for example, process/listener readiness or an expected-authentication response can be distinguished from transport failure.

### 6. The current gateway has no DSH browser-session bootstrap path

Orbit's public Caddy flow authenticates the caller (access-provider assertion or local Basic Auth), rewrites the Host to `DSH_PUBLIC_HOST`, and injects the Orbit internal proxy secret before forwarding to DSH.

That is enough for the Orbit patch on `0.1.1-rc.2`, but alpha.5 requires a DSH browser session as well. The current gateway neither possesses nor exchanges the DSH process launch token and does not mint a DSH cookie. A user reaching the normal public URL would therefore reach DSH without the new application credential.

The main design task for any 0.1.2 integration is consequently **authenticated gateway -> DSH browser-session bootstrap**, not another Host allowlist patch. Prefer an upstream generic authenticated-client/session-bootstrap primitive if DSH adopts one. A downstream experiment may evaluate the existing launch-token exchange, but it must not expose the launch token to unauthenticated clients or create a second durable authority model.

### 7. The old client `publicHost => isLoopback` patch should not be carried forward

The alpha.5 client still computes `isLoopback` from the actual page/transport. Orbit's old client patch adds the configured public host to the loopback predicate so remote pages receive loopback-only behavior.

In alpha.5, that boolean is now used by materially different consumers:

- `dsh-client-ui-settings` chooses Host persistence only when `ctx.remote.$host.isLoopback` is true;
- `dsh-client-ui-settings-general` exposes the file-backed settings-document controller only on loopback;
- `dsh-client-ui-deliverables` allows Host path opening only when `isLoopback` is true and the Host opener is available.

Treating every authenticated reverse-proxy authority as loopback would therefore conflate low-risk persistence with genuinely host-local actions. Upstream Discussion #5430 independently identifies the same coarse-grained `isLoopback` problem and proposes a narrower server-issued capability/session grant.

Orbit should not patch alpha.5 by pretending the public host is loopback. The desired long-term replacement is a narrow authenticated-client capability while truly host-local actions remain loopback-only.

### 8. Existing deep compatibility gates remain unevaluated

Because the current patch/authentication/readiness seam is already blocked, this reconnaissance does not claim results for:

- authenticated settings read/write through the new DSH session model;
- pre-upgrade session resume;
- long-lived transport and reconnect behavior;
- copied-profile startup and package-resolution behavior;
- terminal behavior;
- promotion readiness.

Those checks become meaningful only after a research integration can start alpha.5 without weakening its authentication model. No skipped gate is treated as passing evidence.

## Compatibility classification

| Area | Reconnaissance result |
| --- | --- |
| Orbit compatibility registry | **BLOCKED as designed** — alpha.5 is unknown |
| DSH Web CLI (`web --no-open --trusted-host`) | **Promising / present upstream** |
| Host/Origin trust | **Native upstream capability now stronger** |
| DSH browser authentication | **New mandatory integration requirement** |
| Orbit server source patch | **FAILS exact matcher; should be retired rather than mechanically ported** |
| Orbit client public-host-as-loopback patch | **Do not port; semantics are now too broad** |
| Orbit anonymous root readiness | **Incompatible with alpha.5 401 authentication behavior** |
| Current gateway authorization smoke | **Cannot pass without DSH browser-session bootstrap** |
| Existing-session / long-lived transport / full candidate | **Not evaluated** |
| Formal support | **NO** |
| Production promotion | **NOT AUTHORIZED** |

## Recommended next step

Keep `0.1.1-rc.2` as Orbit's only supported DSH version. Do not add `0.1.2-alpha.5` to `src/compatibility.mjs` and do not broaden the old source matcher.

The next compatibility branch should be deletion-first and should remain research-only until upstream authentication stabilizes:

1. Define or adopt a generic authenticated-gateway -> DSH browser-session bootstrap. Prefer an upstream primitive; track the capability-grant direction discussed in upstream Discussion #5430.
2. Remove the old server authenticated-proxy bypass from the alpha.5 experiment instead of adapting its source matcher.
3. Do not classify the public reverse-proxy host as loopback. Keep host-local operations local and consume a narrower upstream capability if/when available.
4. Replace the anonymous-200 readiness assumption with a signal compatible with DSH authentication.
5. Update Orbit smoke clients to establish and carry the DSH session cookie after gateway authentication, while preserving negative tests for unauthenticated, wrong-origin, and cross-site requests.
6. Only then run the full Upgrade Guard candidate workflow against copied production data, including existing-session resume and long-lived transport checks.
7. Add a formal compatibility profile only after that evidence passes.

## Decision

`0.1.2-alpha.5` is **not compatible with the current Orbit 0.3 integration and remains unsupported**. The result is nevertheless encouraging: upstream has absorbed significant parts of the trust and browser-authentication problem that Orbit previously patched. The likely migration is smaller in the long term if Orbit deletes its legacy trust patches and integrates with upstream session/capability primitives instead of teaching the old patches about the new source layout.
