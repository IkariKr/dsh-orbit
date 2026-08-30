# Architecture

**Orbit understands DSH, not the DSH plugin ecosystem.**

DSH Orbit is designed as a layer around DeepSeek Harness rather than a fork of it.

## Current components

### Upstream runtime

DeepSeek Harness remains the runtime that owns agents, settings, plugins, workspaces, and local execution.

### Compatibility layer

The compatibility patch adjusts the DSH browser trust check and privileged API trust check for one explicitly configured, authenticated reverse-proxy origin.

The patch is applied in two places because a DSH web profile can contain its own copy of `@deepseek-ai/dsh-client-connection`:

- the globally installed package during image build;
- the profile-local package before the externally reachable web process is marked ready.

### Gateway

The gateway authenticates the user and injects an internal secret that is not available to the browser. The DSH compatibility layer requires that secret in addition to host, protocol, and same-origin checks.

### Upgrade guard

Compatibility is tied to explicit upstream versions. Candidate builds fail when the expected DSH source layout changes.

## Fresh-profile bootstrap

On a new data directory, DSH may need to create and install its web profile before the profile-local client package exists.

The example entrypoint handles this without exposing the bootstrap process:

1. start DSH internally;
2. wait for the profile-local client package;
3. stop the bootstrap process;
4. apply the runtime patch;
5. restart DSH;
6. verify the global and profile-local patches;
7. mark the container healthy;
8. allow the gateway container to start.

## Third-party plugin boundary

DSH Orbit supports and integrates with DeepSeek Harness itself. Orbit core does not patch, fork, version-pin, adapt, or maintain compatibility logic for third-party DSH plugins.

Expectations:

- Issues in DSH core may be located, reproduced, reported upstream, and — when the fix is general enough — contributed as a pull request. Orbit may keep a minimal, version-pinned, fail-closed temporary DSH compatibility patch only while upstream converges, with explicit exit conditions.
- Issues in third-party plugins are outside Orbit's responsibility: Orbit does not fix, patch, fork, report, or track them, and Orbit does not know or depend on any plugin's package name, version, install path, source layout, or private API. Whether a third-party plugin supports remote access, headless operation, trusted proxies, persistence, or anything else is the plugin author's and the operator's responsibility.
- Orbit may expose generic infrastructure primitives that third-party plugins can choose to support — the authenticated reverse-proxy trust boundary, public-host admission, generic runtime hooks, generic capability discovery, the upgrade/rollback guard, compatibility evidence, and future fleet routing and node management. These primitives must not contain conditionals on specific third-party plugins.

Prohibited in Orbit core:

- `if plugin == <name>` branches;
- third-party package names as knobs, paths, or assumptions;
- plugin version pins;
- third-party `node_modules` paths;
- third-party source matchers;
- third-party bundle patches;
- plugin-specific smoke suites.

Existing plugin-specific compatibility code (the `@linxin666/dsh-ssh` terminal fence patch and related configuration, smoke, and tests) is treated as legacy third-party compatibility debt: it is freeze-only, marked as such in the code, and removed once DSH itself provides a sufficiently generic trusted-client / authenticated-proxy capability. See `docs/third-party-debt.md`.

## Planned fleet architecture

The fleet work is intentionally separate from the DSH runtime.

```text
                    Browser
                       |
                  Orbit Hub
                 /    |    \
                /     |     \
          Orbit Node  Node  Node
              |        |     |
             DSH      DSH   DSH
```

The planned Hub is a control plane. It should manage identity, discovery, routing, health, capabilities, and session selection. Agent execution remains on each DSH node.

Capabilities are **Hub-derived, evidence-backed feature assertions** rather than requiring every device to run the same DSH version. Version information remains useful for compatibility diagnostics, but feature availability converges on Hub-side capability derivation from each node's latest compatibility report (see `docs/rfc/0009-capability-contract-and-health.md`); nodes never advertise capabilities.

See `docs/roadmap.md` for the staged plan.
