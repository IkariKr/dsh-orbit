# Security model

DSH Orbit extends the DeepSeek Harness configuration plane to an authenticated reverse-proxy path. It does not make privileged DSH APIs generally remote-accessible.

## Trust boundary

A request is accepted by the compatibility layer only when all of the following are true:

1. the request host matches `DSH_PUBLIC_HOST`;
2. the upstream proxy reports HTTPS through `X-Forwarded-Proto`;
3. the proxy injects the configured `X-DSH-Orbit-Authenticated-Proxy` value;
4. a browser `Origin`, when present, matches the request host;
5. `Sec-Fetch-Site: cross-site` is rejected.

The proxy secret is read by DSH from a file mounted into the container. It must not be exposed to the browser or stored in the repository.

## Identity-aware access header

The Caddy example separates the two authentication paths by listener. Host-published `9443` is the local/LAN Basic Auth path, never treats `Cf-Access-Jwt-Assertion` as authentication, and strips any client-supplied copy before forwarding to DSH. Private `9444` is the identity-aware path and may treat that assertion as evidence only because the example Compose file does not publish `9444` to the host.

A trusted identity-aware connector such as a Cloudflare Tunnel sidecar may reach `9444` across the private container network boundary. Do not publish that listener to arbitrary local/LAN clients. If an additional LAN reverse proxy is used, it must still strip an incoming assertion header before forwarding; the Nginx example does this explicitly as defense in depth.

If an identity-aware listener is directly reachable by untrusted clients, use a proxy configuration that validates the identity token itself or establish another unforgeable transport boundary. A header name alone is never an authentication boundary.

## DSH service exposure

The DSH web service should listen only inside its container or private network. The example Compose file exposes only the gateway listener on host loopback.

Orbit starts `dsh web` with the upstream `--trusted-host "$DSH_PUBLIC_HOST"` option. This is host admission for DSH and plugin routes, not authentication. It allows authenticated reverse-proxy traffic carrying the public authority to reach routes that use DSH's browser-trust fence, including lazy-loaded plugin bundles. Authentication remains the responsibility of the gateway, and privileged settings RPCs still require the Orbit internal proxy secret.

Do not publish DSH port `3080` on a LAN or public interface.

## Local access

The example Caddy configuration exposes local Basic Auth on `9443`. Its credentials are mounted from files under `secrets/` and are not stored in `.env` or the repository. The local listener strips identity-provider assertion headers before the authenticated proxy hop reaches DSH, so a forged `Cf-Access-Jwt-Assertion` cannot influence the downstream identity path.

The local path and the private identity-aware path on `9444` both inject the same internal DSH Orbit proxy secret after their own authentication step.

## Fail-closed compatibility

The patcher uses exact source fragments for a tested DSH version. If an expected fragment is missing or duplicated, patching fails. Unknown DSH versions are rejected by the compatibility registry.

This behavior is intentional. A failed upgrade is safer than an upgrade that silently runs with a partially applied authorization change.

## Data and rollback

A DSH downgrade may not be safe after an upstream version migrates the persistent profile or settings data. Before production upgrades, snapshot the DSH data directory separately from the container image.

Image rollback and data rollback are distinct operations.
