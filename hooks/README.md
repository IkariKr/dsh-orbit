# Runtime hooks

This directory is reserved for optional downstream runtime hooks.

DSH Orbit runs supported files in lexical order before each DSH Web start:

- `*.mjs` and `*.js` with Node.js;
- `*.sh` with `/bin/sh`.

Hooks run inside the DSH container and inherit its environment. A non-zero exit stops startup. Keep hooks small, deterministic, and free of credentials.

Site-specific deployments should normally mount their own hook directory at `/opt/dsh-orbit/hooks:ro` rather than commit private deployment logic here.
