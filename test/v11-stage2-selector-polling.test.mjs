import assert from "node:assert/strict";
import test from "node:test";

// RFC-0018 Stage 2: selector periodic polling — silent refresh, failure
// degradation to the existing error banner, manual refresh retained, polling
// stopped on logout. The shipped app module is imported directly with stubbed
// DOM/fetch, so the tests exercise the shipped bytes.

function stubDom() {
  const elements = new Map();
  const make = (id) => {
    const el = {
      id,
      innerHTML: "",
      textContent: "",
      className: "",
      handlers: {},
      addEventListener(type, handler) {
        this.handlers[type] = handler;
      },
      appendChild(child) {
        this.children = this.children ?? [];
        this.children.push(child);
      },
    };
    elements.set(id, el);
    return el;
  };
  const documentStub = {
    addEventListener() {},
    // view-model rendering needs createElement; return a minimal record-only stub
    createElement(tag) {
      return {
        tagName: tag,
        className: "",
        innerHTML: "",
        children: [],
        setAttribute() {},
        addEventListener() {},
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
    getElementById: (id) => {
      if (!elements.has(id)) make(id);
      return elements.get(id);
    },
  };
  return { documentStub, elements };
}

function loadApp({ fetchImpl } = {}) {
  const calls = [];
  const { documentStub } = stubDom();
  // The globals are intentionally left installed for the duration of the
  // test (each loadApp overwrites them; node:test runs files in isolation).
  globalThis.document = documentStub;
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return fetchImpl(url, options);
  };
  const importPromise = import(`../ui/selector/app.mjs?polling-${Date.now()}-${Math.random()}`);
  return importPromise.then((module) => ({
    calls,
    document: documentStub,
    SelectorApp: module.SelectorApp,
    POLL_INTERVAL_MS: module.POLL_INTERVAL_MS,
  }));
}

const jsonResponse = (status, body = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });

const sessionOk = () => jsonResponse(200, { principal: "operator", csrfToken: "csrf-x" });
const nodesOk = (n = 1) =>
  jsonResponse(200, { nodes: Array.from({ length: n }, (_, i) => ({ nodeId: `node_${i}`, route: { eligible: true } })) });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("polling: initial fetch then silent periodic refresh without loading flicker", async () => {
  let nodeCalls = 0;
  let releaseFirstPoll;
  const firstPollPending = new Promise((resolve) => {
    releaseFirstPoll = resolve;
  });
  const { SelectorApp } = await loadApp({
    fetchImpl: (url) => {
      if (String(url).endsWith("/hub/selector/nodes")) {
        nodeCalls += 1;
        // Hold the first poll in flight so the silent-refresh semantics can
        // be asserted mid-flight: no loading banner may appear.
        return nodeCalls === 2 ? firstPollPending : nodesOk(2);
      }
      return sessionOk();
    },
  });
  const app = new SelectorApp({ pollIntervalMs: 10 });
  await app.init();
  assert.equal(nodeCalls, 1, "initial fetch");
  assert.equal(app.state.nodes.length, 2);

  // First poll goes in flight: the banner must NOT show a loading state.
  await sleep(25);
  assert.ok(nodeCalls >= 2, `expected periodic polls, got ${nodeCalls}`);
  assert.ok(!app.stateBannerEl.innerHTML.includes("banner loading"), "poll must be silent while in flight");
  assert.ok(!app.stateBannerEl.innerHTML.includes("banner error"));

  releaseFirstPoll(nodesOk(2));
  await sleep(30);
  assert.equal(app.state.nodes.length, 2);
  // Silent refresh: no loading banner, no error banner after successful polls.
  assert.ok(!app.stateBannerEl.innerHTML.includes("banner error"));
  app.stopPolling();
  const afterStop = nodeCalls;
  await sleep(30);
  assert.equal(nodeCalls, afterStop, "polling must stop after stopPolling()");
});

test("polling failure degrades to the existing error banner, then recovers", async () => {
  let fail = true;
  const { SelectorApp } = await loadApp({
    fetchImpl: (url) => {
      if (String(url).endsWith("/hub/selector/nodes")) {
        return fail ? Promise.reject(new Error("network down")) : nodesOk(1);
      }
      return sessionOk();
    },
  });
  const app = new SelectorApp({ pollIntervalMs: 10 });
  await app.init();
  // Initial fetchNodes fails: error banner shows via the existing path.
  assert.match(app.stateBannerEl.innerHTML, /network down/);

  await sleep(40);
  // Poll failures keep degrading to the banner...
  assert.match(app.stateBannerEl.innerHTML, /banner error/);
  fail = false;
  await sleep(40);
  // ...and a successful poll clears it and repopulates the list.
  assert.equal(app.state.nodes.length, 1);
  assert.equal(app.stateBannerEl.innerHTML, "");
  app.stopPolling();
});

test("manual refresh is retained alongside polling; logout stops the poll timer", async () => {
  let nodeCalls = 0;
  let logoutCalls = 0;
  const { SelectorApp } = await loadApp({
    fetchImpl: (url, options = {}) => {
      if (String(url).endsWith("/hub/selector/nodes")) {
        nodeCalls += 1;
        return nodesOk(1);
      }
      if (String(url).endsWith("/hub/session/logout")) {
        logoutCalls += 1;
        return jsonResponse(200, {});
      }
      return sessionOk();
    },
  });
  const app = new SelectorApp({ pollIntervalMs: 10 });
  await app.init();
  const manualCalls = nodeCalls;
  await app.fetchNodes();
  assert.equal(nodeCalls, manualCalls + 1, "manual refresh still fetches on demand");

  await sleep(30);
  assert.ok(nodeCalls > manualCalls + 1, "polling also runs");
  await app.handleLogout();
  assert.equal(logoutCalls, 1);
  const atLogout = nodeCalls;
  await sleep(30);
  assert.equal(nodeCalls, atLogout, "polling stopped after logout");
});
