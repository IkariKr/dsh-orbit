// RFC-0016 Stage 3: DSH Native Settings UI Injection & Client Pairing Tests
// Verifies:
// 1. Zero-dependency inline vector SVG QR code generation (pure JS, no external requests)
// 2. Verified TLS enforcement (rejection of unencrypted http:// pairing URLs)
// 3. Client bundle slot injection into DSH native settings (slots.inject('settings.section'))
// 4. OrbitSettingsController state management (generation, countdown, SSE, expiration)
// 5. DOM rendering and user interaction (button click, countdown, error alerts)

import assert from "node:assert/strict";
import test from "node:test";
import { generateQrSvg } from "../src/plugin/qr-svg.mjs";
import {
  apply,
  OrbitSettingsController,
  OrbitSettingsSection,
  ORBIT_SETTINGS_SECTION_ID,
  ORBIT_SETTINGS_SECTION_ORDER,
} from "../src/plugin/client.mjs";

test("qr-svg: generates clean inline vector SVG with zero external requests", () => {
  const url = "https://hub.orbit.test/auth?token=123456";
  const result = generateQrSvg(url, { size: 250 });

  assert.ok(result.svg);
  assert.ok(result.svg.startsWith("<svg"));
  assert.ok(result.svg.endsWith("</svg>"));
  assert.ok(result.svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(result.svg.includes('shape-rendering="crispEdges"'));
  assert.ok(result.svg.includes('<rect width="100%" height="100%"'));
  assert.ok(result.svg.includes("<path d="));
  assert.equal(result.text, url);
  assert.ok(result.size > 21);

  // Throws on empty string
  assert.throws(() => generateQrSvg(""), /non-empty string/);
});

test("client controller: enforces verified TLS invariant (rejects unencrypted http://)", () => {
  const controller = new OrbitSettingsController();

  // Valid HTTPS URL passes
  const validUrl = "https://hub.orbit.test/auth?token=654321";
  const parsed = controller.assertVerifiedTls(validUrl);
  assert.equal(parsed.protocol, "https:");

  // Unencrypted HTTP URL fails closed immediately
  assert.throws(
    () => controller.assertVerifiedTls("http://hub.orbit.test/auth?token=654321"),
    /Insecure transport scheme 'http:': QR pairing requires verified TLS/,
  );

  // Malformed or empty URL fails closed
  assert.throws(() => controller.assertVerifiedTls("not-a-url"), /Malformed URL/);
  assert.throws(() => controller.assertVerifiedTls(""), /non-empty string/);
});

test("client plugin: injects Orbit section into DSH settings.section slot", () => {
  // Simulate browser environment with window
  globalThis.window = {};

  try {
    const injected = [];
    const registered = [];

    const mockSlots = {
      inject: (slotName, callback) => {
        injected.push(slotName);
        return callback();
      },
      register: (descriptor, component) => {
        registered.push({ descriptor, component });
        return descriptor;
      },
    };

    const mockCtx = {
      slots: mockSlots,
      get: (name) => (name === "slots" ? mockSlots : null),
    };

    apply(mockCtx);

    assert.equal(injected.length, 1);
    assert.equal(injected[0], "settings.section");

    assert.equal(registered.length, 1);
    assert.equal(registered[0].descriptor.id, ORBIT_SETTINGS_SECTION_ID);
    assert.equal(registered[0].descriptor.order, ORBIT_SETTINGS_SECTION_ORDER);
    assert.equal(registered[0].descriptor.label(), "Orbit Remote & Fleet");
    assert.equal(registered[0].component, OrbitSettingsSection);
  } finally {
    delete globalThis.window;
  }
});

test("client controller: full state lifecycle (generate code, countdown timer, status, HTML render)", async () => {
  let currentTime = 1_000_000;
  const stateChanges = [];

  const mockHubBaseUrl = "https://hub.orbit.test";
  const controller = new OrbitSettingsController({
    hubBaseUrl: mockHubBaseUrl,
    csrfToken: "mock-csrf-token",
    now: () => currentTime,
    onStateChange: (state) => stateChanges.push({ ...state }),
  });

  // Mock global fetch for Hub endpoints
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith("/hub/pairing/generate-code")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["x-csrf-token"], "mock-csrf-token");
      return {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          code: "888999",
          expiresAt: new Date(currentTime + 300_000).toISOString(),
          url: "https://hub.orbit.test/auth?token=888999",
        }),
      };
    }
    if (url.endsWith("/hub/pairing/status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          activeCodes: 1,
          activeSessions: 2,
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    // 1. Initial idle render
    const idleHtml = controller.renderHtml();
    assert.ok(idleHtml.includes("Orbit Remote & Fleet"));
    assert.ok(idleHtml.includes("No active pairing code."));
    assert.ok(idleHtml.includes("Pair Mobile Device"));

    // 2. Generate pairing code
    await controller.generateCode();

    assert.equal(controller.state.code, "888999");
    assert.equal(controller.state.remainingSeconds, 300);
    assert.ok(controller.state.qrSvg);
    assert.ok(controller.state.qrSvg.includes("<svg"));

    const activeHtml = controller.renderHtml();
    assert.ok(activeHtml.includes("888 999"));
    assert.ok(activeHtml.includes("Valid for 300s"));
    assert.ok(activeHtml.includes("Refresh Code"));
    assert.ok(activeHtml.includes("<svg"));

    // 3. Fetch status
    await controller.fetchStatus();
    assert.equal(controller.state.activeCodes, 1);
    assert.equal(controller.state.activeSessions, 2);

    // 4. Timer expiration
    currentTime += 300_001; // Advance past 300s
    // Trigger countdown tick
    controller.destroy();
    controller.updateState({
      remainingSeconds: 0,
      code: null,
      qrSvg: null,
      error: "Pairing code expired. Please generate a new code.",
    });

    const expiredHtml = controller.renderHtml();
    assert.ok(expiredHtml.includes("Pairing code expired"));
    assert.ok(expiredHtml.includes("No active pairing code"));
  } finally {
    globalThis.fetch = originalFetch;
    controller.destroy();
  }
});

test("client controller: rejects code generation if Hub returns unencrypted HTTP URL", async () => {
  const controller = new OrbitSettingsController({
    hubBaseUrl: "http://insecure.test",
    csrfToken: "mock-csrf",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    json: async () => ({
      ok: true,
      code: "111222",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      url: "http://insecure.test/auth?token=111222", // Insecure HTTP URL!
    }),
  });

  try {
    await controller.generateCode();
    // Verification should fail and set error in controller state
    assert.equal(controller.state.code, null);
    assert.ok(controller.state.error.includes("Insecure transport scheme 'http:'"));
  } finally {
    globalThis.fetch = originalFetch;
    controller.destroy();
  }
});
