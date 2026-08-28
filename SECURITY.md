# Security Policy

DSH Orbit changes the trust boundary around privileged DeepSeek Harness APIs. Treat authentication and proxy changes as security-sensitive.

## Supported versions

Security fixes are provided for the current release line. Compatibility with a DeepSeek Harness version is documented in `docs/compatibility.md`; an unlisted upstream version should be treated as unsupported until tested.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities that expose authentication bypasses, secrets, remote command execution paths, or privileged DSH APIs.

Use GitHub's private vulnerability reporting feature when it is available for this repository. Include:

- affected DSH Orbit version;
- affected DeepSeek Harness version;
- deployment topology;
- minimal reproduction steps;
- expected and observed authorization behavior.

## Deployment assumptions

A supported deployment must keep the DSH service off public interfaces and place it behind an authenticated gateway. Proxy-injected authentication headers and shared secrets must not be accepted from arbitrary client-controlled paths.

See `docs/security-model.md` for the complete trust model.
