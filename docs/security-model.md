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

The Caddy example treats `Cf-Access-Jwt-Assertion` as evidence that the request arrived through the dedicated Cloudflare Access path. This is only safe when clients cannot reach that Caddy path while preserving an arbitrary copy of the same header.

For deployments that also expose a local or LAN reverse proxy, the local proxy must strip the incoming assertion header before forwarding. The Nginx example does this explicitly.

If the gateway is directly reachable by untrusted clients, use a proxy configuration that validates the identity token itself or place the gateway behind a network boundary where only the identity-aware connector can reach it.

## DSH service exposure

The DSH web service should listen only inside its container or private network. The example Compose file exposes only the gateway listener on host loopback.

Do not publish DSH port `3080` on a LAN or public interface.

## Local access

The example Caddy configuration supports a separate local Basic Auth path. Its credentials are mounted from files under `secrets/` and are not stored in `.env` or the repository.

The local path and the identity-aware path both inject the same internal DSH Orbit proxy secret after their own authentication step.

## Fail-closed compatibility

The patcher uses exact source fragments for a tested DSH version. If an expected fragment is missing or duplicated, patching fails. Unknown DSH versions are rejected by the compatibility registry.

This behavior is intentional. A failed upgrade is safer than an upgrade that silently runs with a partially applied authorization change.

## Data and rollback

A DSH downgrade may not be safe after an upstream version migrates the persistent profile or settings data. Before production upgrades, snapshot the DSH data directory separately from the container image.

Image rollback and data rollback are distinct operations.
