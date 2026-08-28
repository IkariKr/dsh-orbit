# Architecture

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

Nodes should advertise capabilities rather than requiring every device to run the same DSH version. Version information remains useful for compatibility diagnostics, but feature availability should converge on capability negotiation.

See `docs/roadmap.md` for the staged plan.
