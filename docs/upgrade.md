# Upgrade guide

DeepSeek Harness is evolving quickly. Treat every upstream version change as a candidate deployment until its compatibility and data behavior have been verified.

## Recommended workflow

### 1. Keep the current production image

Use immutable versioned image tags. Do not overwrite the last known-good image tag during an upgrade.

Example naming:

```text
dsh-orbit:0.1.1-rc.2-orbit.1
dsh-orbit:0.1.2-orbit.1
```

### 2. Snapshot persistent data

Back up the DSH data directory before starting the candidate against production data.

Prefer testing with a copy of the data first. Upstream migrations can make image rollback insufficient on their own.

### 3. Add upstream compatibility intentionally

Update the DSH version only after reviewing the installed `dsh-client-connection` source shape.

If the existing patch still applies exactly, add the new version to `src/compatibility.mjs` and add a test case. If the source changed, implement a separate compatibility profile rather than weakening the existing matcher.

### 4. Build a candidate image

```sh
DSH_VERSION=<candidate> \
DSH_PUBLIC_HOST=dsh.example.com \
docker compose -f docker/compose.example.yaml build
```

The image build must fail if the global compatibility patch does not match.

### 5. Start with copied data

Run the candidate against a copied DSH data directory and use a non-production gateway port or isolated host.

The container is considered ready only after the profile-local patch has been applied and verified.

### 6. Run smoke tests

At minimum verify:

- the DSH web UI loads;
- `settings.describe` succeeds through the authenticated gateway;
- the response reports a writable settings provider when expected;
- a no-op `settings.mutate` succeeds on a safe namespace;
- at least one session created before the upgrade can be resumed and can re-select its current model;
- a request without the internal proxy secret is rejected;
- a cross-site request is rejected;
- a local proxy cannot spoof an identity-provider assertion header;
- WebSocket and long-running agent traffic still work.

For the existing-session check, run against copied candidate data rather than production data:

```sh
DSH_SMOKE_URL=https://candidate.example.com \
DSH_SMOKE_SESSION_ID=session-... \
npm run smoke:session
```

The smoke test reads the session's current model and re-selects that same model. This exercises the cold-resume path without intentionally changing the model choice. Use a session that predates the candidate DSH version; a newly created session does not validate upgrade compatibility.

### 7. Promote and verify again

After the candidate passes, snapshot production data, switch the image tag, and repeat the smoke tests on the production path.

## Rollback

If the new process fails before changing persistent data, switch back to the last known-good image.

If the upstream version changed or migrated persistent data, restore both:

1. the previous image tag;
2. the data snapshot taken immediately before promotion.

Do not assume a previous DSH binary can read data written by a newer release.

## Removing compatibility patches

When upstream DSH introduces an authenticated remote-administration mechanism with equivalent security properties, prefer it and retire the corresponding DSH Orbit patch. The desired end state is less patching over time, not a growing permanent fork.
