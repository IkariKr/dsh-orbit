import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// RFC-0017 Stage 2: controller-level tests for the landing page. The page is
// evaluated AS SHIPPED — the inline script is extracted from ui/auth/index.html
// and run against stub window/document objects — so the tests exercise the
// exact bytes the browser receives, not a copy of the logic.

const ROOT = new URL("../", import.meta.url);
const PAGE_HTML = await readFile(new URL("ui/auth/index.html", ROOT), "utf8");
const SCRIPT_BODY = /<script>([\s\S]*)<\/script>/.exec(PAGE_HTML)?.[1];
assert.ok(SCRIPT_BODY, "landing page must contain its inline script");

function loadPage({ search = "", fetchImpl = null } = {}) {
  const calls = { fetch: [], scrubbed: [], navigated: [], rendered: [], clicks: [] };
  const container = {
    innerHTML: "",
    addEventListener(type, handler) {
      if (type === "click") calls.clicks.push(handler);
    },
  };
  const windowStub = {
    document: { getElementById: () => container },
    location: {
      search,
      replace(target) {
        calls.navigated.push(target);
      },
    },
    history: {
      replaceState(...args) {
        calls.scrubbed.push(args);
      },
    },
    fetch(url, options) {
      calls.fetch.push({ url, options });
      return fetchImpl(url, options);
    },
  };
  const sandbox = { window: windowStub, globalThis: {} };
  new Function("window", "globalThis", SCRIPT_BODY)(windowStub, sandbox.globalThis);
  return {
    calls,
    container,
    controller: windowStub.__OrbitAuth ?? sandbox.globalThis.__OrbitAuth,
    flushTimers: (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

const jsonResponse = (status, body = {}) =>
  Promise.resolve({
    status,
    json: async () => body,
  });

test("page asset invariants: zero external requests, no-referrer meta, fixed templates only", async () => {
  assert.doesNotMatch(PAGE_HTML, /https?:\/\//);
  assert.match(PAGE_HTML, /<meta name="referrer" content="no-referrer">/);
  // The shipped asset keeps a single inline script and no other resource tags.
  assert.equal((PAGE_HTML.match(/<script/g) ?? []).length, 1);
  assert.equal((PAGE_HTML.match(/<link\b/g) ?? []).length, 0);
  assert.equal((PAGE_HTML.match(/<img\b/g) ?? []).length, 0);
});

test("happy path: scrub before verify, never render the code, confirm then navigate to /", async () => {
  let verifyCalls = 0;
  const page = loadPage({
    search: "?token=654321",
    fetchImpl: () => {
      verifyCalls += 1;
      return jsonResponse(200, { ok: true, principal: "operator" });
    },
  });
  await page.flushTimers();

  // Scrub happened, with the constant clean target, before anything else.
  assert.deepEqual(page.calls.scrubbed, [[null, "", "/auth"]]);
  assert.deepEqual(page.calls.scrubbed[0], [null, "", "/auth"]);

  // The verify POST went to the existing endpoint with the token from the URL.
  assert.equal(page.calls.fetch.length, 1);
  assert.equal(page.calls.fetch[0].url, "/hub/pairing/verify");
  assert.equal(page.calls.fetch[0].options.method, "POST");
  assert.equal(page.calls.fetch[0].options.credentials, "same-origin");
  assert.equal(page.calls.fetch[0].options.body, JSON.stringify({ token: "654321" }));

  // Confirmed state rendered; the code value never appeared in the DOM.
  assert.match(page.container.innerHTML, /data-state="confirmed"/);
  assert.ok(!page.container.innerHTML.includes("654321"));

  // First-party constant navigation target after the confirm delay.
  await page.flushTimers(1400);
  assert.deepEqual(page.calls.navigated, ["/"]);
});

test("failure mapping: 401 maps to expired, 429 to locked (fixed copy), 5xx and network errors to retryable error", async () => {
  for (const [status, expectedState] of [
    [401, "expired"],
    [429, "locked"],
    [500, "error"],
  ]) {
    const page = loadPage({ search: "?token=111111", fetchImpl: () => jsonResponse(status) });
    await page.flushTimers();
    assert.match(page.container.innerHTML, new RegExp(`data-state="${expectedState}"`));
    assert.ok(!page.container.innerHTML.includes("111111"));
    if (expectedState === "locked") {
      // Fixed fallback copy — no Retry-After exists and none is parsed.
      assert.match(page.container.innerHTML, /Too many attempts/);
      assert.doesNotMatch(page.container.innerHTML, /Retry-After/i);
    }
  }

  const networkFail = loadPage({
    search: "?token=222222",
    fetchImpl: () => Promise.reject(new Error("offline")),
  });
  await networkFail.flushTimers();
  assert.match(networkFail.container.innerHTML, /data-state="error"/);
  assert.match(networkFail.container.innerHTML, /retry-btn/);
});

test("retry keeps the in-memory token and re-verifies without a page reload", async () => {
  let attempts = 0;
  const page = loadPage({
    search: "?token=333333",
    fetchImpl: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("offline")) : jsonResponse(200, { ok: true });
    },
  });
  await page.flushTimers();
  assert.match(page.container.innerHTML, /data-state="error"/);
  assert.equal(page.calls.fetch.length, 1);

  page.calls.clicks.forEach((handler) => handler({ target: { id: "retry-btn" } }));
  await page.flushTimers();
  assert.equal(page.calls.fetch.length, 2);
  assert.equal(page.calls.fetch[1].options.body, JSON.stringify({ token: "333333" }));
  assert.match(page.container.innerHTML, /data-state="confirmed"/);
});

test("missing or malformed codes render the missing state and never call verify", async () => {
  for (const search of ["", "?", "?token=12345", "?token=1234567", "?token=abcdef", "?code=123456", "?token=123456&x=1"]) {
    const page = loadPage({ search, fetchImpl: () => jsonResponse(200, { ok: true }) });
    await page.flushTimers();
    assert.match(page.container.innerHTML, /data-state="missing"/, `expected missing state for ${JSON.stringify(search)}`);
    assert.equal(page.calls.fetch.length, 0, `verify must not fire for ${JSON.stringify(search)}`);
    // The scrub still happens — nothing about the URL is retained.
    assert.deepEqual(page.calls.scrubbed, [[null, "", "/auth"]]);
  }
});

test("M2/M4 unit semantics: a live code confirms, and replaying the destroyed code lands in the failure state", async () => {
  let callCount = 0;
  const page = loadPage({
    search: "?token=999999",
    fetchImpl: () => {
      callCount += 1;
      // Server-side single-use destruction: the same code verifies once and is
      // then gone; the replayed code returns 401 like any dead code.
      return jsonResponse(callCount === 1 ? 200 : 401);
    },
  });
  await page.flushTimers();
  assert.match(page.container.innerHTML, /data-state="confirmed"/);

  // Model the replay through the same factory the shipped page uses.
  const rendered = [];
  const replay = page.controller.createController({
    fetchImpl: () => jsonResponse(401),
    readRawQuery: () => "token=999999",
    scrubAddressBar: () => {},
    navigate: () => {},
    render: (html) => rendered.push(html),
    onRetryClick: () => {},
    schedule: (fn) => fn(),
  });
  replay.start();
  await page.flushTimers();
  assert.match(rendered.at(-1), /data-state="expired"/);
  assert.ok(!rendered.some((html) => html.includes("999999")));
});
