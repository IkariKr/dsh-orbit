# RFC 0016: DSH Native Plugin Integration and QR Pairing Bootstrap for v0.9

Status: **Proposed for v0.9 architecture review. Product construction is blocked until the Stage 0 / Gate A review records GO.**

Depends on: RFC-0001 node identity, RFC-0005 enrollment and registry persistence, RFC-0006 machine API, RFC-0007 browser management API, RFC-0008 per-node Hub route identity, RFC-0009 capability/health semantics, RFC-0010 node endpoint/routing, RFC-0011 browser node selection, RFC-0012 reverse-connected nodes, RFC-0013 multi-node sessions and target scoping, RFC-0014 fleet workflows and scheduling, RFC-0015 scheduled workflows, and authorization `V09-CONSTRUCTION-20260927-A1`.

---

## 1. Goal

v0.9 extends DSH Orbit's control plane and node integration, introducing **native DSH Cordis plugin packaging, DSH Settings service integration, ephemeral QR code pairing bootstrap, and real-time device connection lifecycle management**.

While Orbit v0.1 through v0.8 established enterprise-grade control plane routing, reverse tunnels, multi-node sessions, fleet workflows, and scheduled automation, integrating Orbit directly into the host DSH desktop environment requires:
1. **DSH Native Cordis Packaging**: packaging Orbit's node-side agent as a compliant Cordis plugin that DSH's loader discovers, activates via standard `apply(ctx)` lifecycle hooks, and manages without modifying DSH core code;
2. **DSH Settings Service Binding**: storing and synchronizing plugin options under the official `dsh-orbit` namespace in `~/.dsh/settings.yaml` using DSH's reactive `settings` service (reading, watching, and mutating configuration);
3. **Frictionless QR Code Pairing Bootstrap**: generating a 6-digit ephemeral dynamic pairing code (5-minute TTL) rendered as a zero-dependency, inline vector `<svg>` in the desktop UI, allowing mobile or secondary browser clients to scan and authenticate without copying complex tokens or URLs;
4. **Desktop Settings UI Slot Injection**: embedding an "Orbit Remote & Fleet" section directly inside DSH's native Settings modal via `slots.inject('settings.section')`, displaying network addresses, active pairing codes, and a live device/node visibility list;
5. **Real-Time SSE Event Delivery**: streaming instantaneous `device-connected`, `node-paired`, and `session-revoked` events to active desktop settings sessions via Server-Sent Events, eliminating manual page reloads.

```text
  [Desktop DSH Settings Window]               [Orbit Hub / Registry]             [Mobile / Remote Browser]
               │                                       │                                     │
 1. User opens "Orbit Remote & Fleet"                  │                                     │
    POST /hub/pairing/generate-code ──────────────────>│                                     │
               │                                  Generate 6-digit code                      │
               │                                  + 300s TTL in memory                       │
               │<───────────────────────────────── Return { code, expiresAt, httpsUrl }      │
 2. Render inline vector <svg> QR                      │                                     │
    (URL: https://<hub-domain>/auth?token=849201)      │                                     │
               │                                       │                                     │
               │                                       │    3. Scan QR / Navigate            │
               │                                       │<────────────────────────────────────│
               │                                       │    Serve TLS Auth Page              │
               │                                       │    (Auto-fills 6-digit token)       │
               │                                       │────────────────────────────────────>│
               │                                       │                                     │
               │                                       │    4. Submit Auth (Over TLS)        │
               │                                       │       POST /hub/pairing/verify      │
               │                                       │<────────────────────────────────────│
               │                                       │ Single-use destroy code             │
               │                                       │ Mint operator session & HttpOnly    │
               │                                       │────────────────────────────────────>│
               │                                       │                                     │
               │  5. SSE Push: device-connected        │                                 Redirect to /
               │<──────────────────────────────────────│                                     │
 6. Toast alert & live table update                    │                                     │
```

### Core Architecture and Security Invariants:
- **Strict Identity Separation**: scanning a QR code authorizes an **Operator Session** (`sessionToken`), NOT a DSH machine node. Machine nodes maintain stable Ed25519 cryptographic keypairs (`nodeId`) per RFC-0001/RFC-0012.
- **Prohibition of Virtual Loopback**: external requests must never have their `Host`, `Origin`, `Sec-Fetch-Site`, or `remoteAddress` headers spoofed or rewritten to `127.0.0.1`. Real authority routing must be preserved through Orbit's verified gateway.
- **Strict Transport Security (Verified TLS Invariant)**: all pairing exchanges, QR links, and session verifications must operate over verified TLS (`https://...`). Plain HTTP with client-side RSA padding cannot substitute for TLS and is strictly barred across networks.
- **Disposable Single-Use Pairing Codes**: pairing codes are 6-digit random integers with a maximum TTL of 300 seconds, destroyed immediately upon verification attempt to prevent replay attacks.
- **DSH Clean Seam**: configuration persists strictly through DSH's official `settings` service (`~/.dsh/settings.yaml`), and UI attaches strictly through official `slots.inject('settings.section')`. Zero monkey-patching of DSH core authentication or internal services.

---

## 2. Decision Summary

1. **D1: Cordis Plugin Packaging & Metadata Standard**
   The node-side plugin conforms to DSH Cordis standards with `package.json` declaring keywords `["dsh", "dsh-plugin", "cordis-plugin"]`, `cordis.patch.yml` declaring entry insertion, and exporting `.` and `./client`.
2. **D2: DSH Settings Service Persistence (`dsh-orbit` namespace)**
   Uses `ctx.get('settings').register('dsh-orbit', ...)` to bind plugin options to `~/.dsh/settings.yaml`, supporting reactive initial load, external watch synchronization, and atomic mutations.
3. **D3: Ephemeral QR Pairing Protocol & Single-Use Verification**
   Hub engine generates cryptographically random 6-digit codes (`100000..999999`) with 300s TTL. Verification destroys the code instantly, enforces 5-attempt/15-minute IP lockout, and issues an authenticated operator session.
4. **D4: DSH Desktop Settings UI Slot Injection & Zero-Network SVG Rendering**
   Injects into `slots.inject('settings.section')` with label "Orbit Remote & Fleet", rendering an inline vector `<svg>` generated purely in client-side JS without third-party APIs. Encodes strictly verified TLS URLs.
5. **D5: Server-Sent Events (SSE) Live Notification Pipeline**
   `GET /hub/pairing/events` streams instant `device-connected`, `node-paired`, and `session-revoked` events to desktop settings sessions.
6. **D6: Acceptance Matrix for v0.9 (M36 Matrix - 36 Canonical Fields)**
   Extends RFC-0015 M32 (32 fields) by adding 4 canonical plugin and QR fields: 17 automated fields + 19 mounted fields = 36 total canonical fields.

---

## 3. Detailed Technical Design

### D1: Cordis Plugin Packaging & Module Exports

The node integration package exposes both server-side Cordis lifecycle hooks and client-side UI bundles:

#### `package.json` Excerpt
```json
{
  "name": "dsh-orbit",
  "version": "0.9.0-rc.1",
  "type": "module",
  "main": "src/plugin/index.mjs",
  "exports": {
    ".": "./src/plugin/index.mjs",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings"
      ],
      "platform": "web"
    }
  },
  "keywords": [
    "dsh",
    "dsh-plugin",
    "cordis-plugin",
    "orbit"
  ]
}
```

#### `cordis.patch.yml`
```yaml
- insert:
    - id: orbit
      name: 'dsh-orbit'
```

#### Server Lifecycle (`src/plugin/index.mjs`)
```javascript
export const name = "dsh-orbit";
export const inject = ["webServer", "settings"];

export function apply(ctx, config = {}) {
  // 1. Bind DSH Settings service under dsh-orbit namespace
  bindDshSettings(ctx, config);

  // 2. Register local node probe route on DSH Node webServer
  if (ctx.webServer && typeof ctx.webServer.register === "function") {
    ctx.webServer.register({
      method: "GET",
      path: "/api/orbit/node-status",
      handler: async (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok", nodeIntegration: "active" }));
      },
    });
  }
}
```

---

### D2: DSH Settings Service Persistence (`~/.dsh/settings.yaml`)

Configuration is stored under `~/.dsh/settings.yaml` without requiring a private database or ad-hoc config files:

```javascript
export const ORBIT_SETTINGS_NAMESPACE = "dsh-orbit";

export function bindDshSettings(ctx, store) {
  try {
    const settingsService = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
    if (!settingsService?.register) return;

    const scope = settingsService.register(ORBIT_SETTINGS_NAMESPACE, undefined, {
      base: store.getOptions(),
    });

    if (scope) {
      const initial = scope.get?.();
      if (initial && typeof initial === "object") {
        store.updateOptions(initial, false);
      }
      scope.watch?.(() => {
        const updated = scope.get?.();
        if (updated && typeof updated === "object") {
          store.updateOptions(updated, false);
        }
      });
      store.setSettingsMutator?.((patch) => {
        const ops = Object.entries(patch).map(([field, value]) => ({
          op: "set",
          path: [field],
          value,
        }));
        settingsService.mutate?.(ORBIT_SETTINGS_NAMESPACE, ops);
      });
    }
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-orbit] Failed to bind settings service: ${err.message}`);
  }
}
```

---

### D3: Ephemeral QR Pairing Protocol & Hub Verification

#### Ephemeral Code Manager (`src/registry/pairing-code.mjs`)
- **Code Format**: 6-digit random integer formatted as a string (`100000` to `999999`).
- **Cryptographic Randomness**: Generated via `node:crypto` `randomInt`.
- **TTL**: Exactly 300,000ms (5 minutes).
- **Destruction**: Immediately deleted upon verification attempt (whether success or fail) to prevent replay.

```javascript
import { randomInt, randomBytes } from "node:crypto";

export class PairingCodeManager {
  constructor({ ttlMs = 300000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.codes = new Map();
  }

  generateCode({ operatorPrincipal = "operator", hubBaseUrl }) {
    const code = randomInt(100000, 1000000).toString();
    const pairingToken = randomBytes(24).toString("hex");
    const now = this.now();
    const expiresAt = now + this.ttlMs;

    const record = { code, pairingToken, operatorPrincipal, createdAt: now, expiresAt };
    this.codes.set(code, record);
    this.codes.set(pairingToken, record);

    const timer = setTimeout(() => {
      this.codes.delete(code);
      this.codes.delete(pairingToken);
    }, this.ttlMs + 1000);
    timer.unref?.();

    const targetUrl = new URL("/auth", hubBaseUrl);
    targetUrl.searchParams.set("token", code);

    return { code, expiresAt, url: targetUrl.toString() };
  }

  verifyCode(inputCode) {
    const trimmed = String(inputCode || "").trim();
    const record = this.codes.get(trimmed);
    if (!record) return { valid: false, code: "code-not-found" };

    // Immediately consume code
    this.codes.delete(record.code);
    this.codes.delete(record.pairingToken);

    if (this.now() > record.expiresAt) {
      return { valid: false, code: "code-expired" };
    }

    return { valid: true, operatorPrincipal: record.operatorPrincipal };
  }
}
```

#### Hub Endpoints (`src/registry/server.mjs`)
1. `POST /hub/pairing/generate-code`:
   - Requires valid operator session (`assertSession`).
   - Calls `pairingCodeManager.generateCode(...)`.
   - Returns `{ success: true, code, expiresAt, url }`.
2. `POST /hub/pairing/verify`:
   - Publicly accessible over verified TLS (`https://...`).
   - Rate-limited: 5 failed attempts per client IP triggers a 15-minute 429 lockout.
   - On success: consumes code, issues authenticated browser session, sets HttpOnly Cookie, and emits `device-connected` SSE event.
3. `GET /hub/pairing/status`:
   - Returns active pairing manager state, Hub verified TLS hostname, and active sessions count.
4. `GET /hub/pairing/events`:
   - Streams SSE events (`Content-Type: text/event-stream`).

---

### D4: DSH Desktop Settings UI Slot Injection & Client Bundle

The client bundle (`src/plugin/client.mjs`, compiled to `lib/client.js` via esbuild) hooks into DSH's settings slot:

```javascript
export function apply(ctx) {
  if (typeof window === "undefined") return;
  const slots = (ctx && typeof ctx.get === "function") ? ctx.get("slots") : ctx.slots;

  if (slots && typeof slots.inject === "function") {
    slots.inject("settings.section", function() {
      return slots.register({
        name: "settings.section",
        id: "orbit-fleet",
        order: 140,
        label: () => "Orbit Remote & Fleet",
      }, OrbitSettingsSection);
    });
  }
}
```

#### Zero-Dependency Inline SVG QR Generator
- Embeds a pure JS QR-8bit matrix generator calculating Reed-Solomon polynomial error correction.
- Emits raw `<svg viewBox="..." xmlns="http://www.w3.org/2000/svg">` elements directly into the React DOM.
- Never contacts external CDNs or online QR rendering endpoints.

---

### D5: Server-Sent Events (SSE) Live Pipeline

The desktop settings UI establishes an `EventSource('/hub/pairing/events')`:
```javascript
const sse = new EventSource('/hub/pairing/events');
sse.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'device-connected') {
    showToast(`Device paired: ${data.deviceName}`);
    reloadSessionsList();
  } else if (data.type === 'session-revoked') {
    reloadSessionsList();
  }
};
```
Every 25 seconds, the Hub emits a `: ping\n\n` heartbeat comment to prevent proxy timeouts.

---

### D6: Acceptance Matrix for v0.9 (M36 Matrix - 36 Canonical Fields)

The M36 matrix extends RFC-0015 M32 (32 fields) by adding 4 dedicated fields:

| Index | Field Identifier | Scope | Verification Standard |
|:---:|:---|:---:|:---|
| 1–32 | *(Inherited RFC-0015 M32 Baseline)* | *Mixed* | Inherits complete M32 baseline (15 automated + 17 mounted fields). |
| **33** | `dshPluginCordisRegistration` | **automated** | Plugin declares Cordis manifest (`package.json`, `cordis.patch.yml`), successfully registers via `apply(ctx)`, and exposes registered endpoints. |
| **34** | `dshSettingsNamespacePersistence` | **automated** | Options are read, watched, and mutated via DSH `settings` service under `~/.dsh/settings.yaml` namespace `dsh-orbit`. |
| **35** | `dshNativeSettingsSlotInjection` | **mounted** | DSH desktop settings UI renders "Orbit" section via `slots.inject('settings.section')` with live status. |
| **36** | `qrPairingBootstrapAndExchange` | **mounted** | Ephemeral 6-digit code generates inline SVG QR, mobile browser scans over verified TLS, verifies, establishing session with SSE update. |

**Partitioning**:
- **17 Automated Fields**: Fields 1–11, 25, 28, 29, 30, 33, 34.
- **19 Mounted Fields**: Fields 12–24, 26, 27, 31, 32, 35, 36.
- **Total**: 36 canonical fields.

---

## 4. Security Considerations & Threat Model

1. **Brute-Force & Denial-of-Service Defense**:
   - 6-digit space has $1,000,000$ combinations.
   - At 5 attempts per 15 minutes, brute-forcing has a probability of $5 \times 10^{-6}$ per lockout window.
   - 5-minute TTL guarantees that after 300 seconds, the target space collapses to zero.
2. **Replay Attack Containment**:
   - Verification immediately executes atomic deletion of the code record from memory prior to issuing the session token. Replay attempts receive `HTTP 401 code-not-found`.
3. **No Credential Exposure in QR Payload**:
   - QR encodes only the ephemeral single-use 6-digit code.
   - Never encodes master session cookies, Node private keys, Hub private keys, or long-lived bearer tokens.
4. **Transport Security Invariant**:
   - QR links must resolve to `https://`. Insecure `http://` links across untrusted Wi-Fi or public networks are strictly prohibited.

---

## 5. Stop-Work Matrix

| Symptom | Severity | Required Action |
|:---|:---:|:---|
| Request Host/Origin rewritten to 127.0.0.1 (virtual loopback) | Blocker | **STOP**. Prohibit virtual loopback washing; enforce genuine authority boundaries. |
| Browser session conflated with DSH node machine identity | Critical | **STOP**. Enforce strict separation between operator sessions and node identities. |
| Unencrypted HTTP used across public/external network | Critical | **STOP**. Require verified TLS (`https://`) for all remote transport and QR links. |
| Pairing code valid for > 5 minutes or reusable | Critical | **STOP**. Enforce single-use disposable codes with <= 300s TTL. |
| Sensitive credentials (private keys, passwords) embedded in QR | Blocker | **STOP**. Redact credentials; embed only ephemeral single-use bootstrap tokens. |
| DSH private DOM components scraped or patched | Blocker | **STOP**. Use official `slots.inject` extension points only. |
| DSH core files or backend services monkey-patched/hijacked | Blocker | **STOP**. Do not monkey-patch DSH connection, browserAuth, or internal services. |
| Mounted field claimed PASS during Stage 5 qualification | Blocker | **STOP**. Keep NOT_EXECUTED; qualify automated fields only during Gate C. |
| Product fix required after candidate freeze | Critical | **STOP**. Unfreeze; mint new candidate and execute fresh candidate-bound evidence. |
| Unclean worktree, credential residue, or dangling test processes | Blocker | **STOP**. Clean worktree and purge all runtime residue before review submission. |
| Non-zero P0, P1, or P2 finding during review | Blocker | **STOP**. Remediate, re-test, and re-review until PASS. |
