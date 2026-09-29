import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { createRegistryUi } from "../ui/app.mjs";
import { mapSessionList, mapSessionRow } from "../ui/view-model.mjs";
import { createSelectorRowElement, formatTargetHint } from "../ui/selector/view-model.mjs";

// RFC-0018 Stage 1: mechanical coverage for the presentation contracts —
// selector target-scope indication (A11), flow-indicator wording honesty
// (A12), responsive breakpoints (A15), and the management Devices & Nodes
// section (hint-only rendering, activeCount, two-step revoke).

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const ASSERTION = "gateway-held-assertion-secret";

const NODE_FIXTURE = {
  nodeId: "node_11112222333344445555666677778888",
  state: "active",
  runtimeIdentity: { dshVersion: "0.1.1-rc.2", orbitVersion: "0.4.0" },
  health: {
    registryContact: "fresh",
    reachable: "ok",
    orbitCompatible: "pass",
    capabilities: [{ name: "web.routes", version: 1 }],
    capabilitiesStale: false,
  },
  route: {
    eligible: true,
    routeMode: "direct",
    reversePresence: "unknown",
    activeFlows: 2,
    reasonCode: null,
    reason: null,
    openUrl: "https://n-11112222333344445555666677778888.dsh.example/",
  },
};

function withMockDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        attributes: {},
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        innerHTML: "",
      };
    },
  };
  try {
    return fn();
  } finally {
    globalThis.document = previous;
  }
}

// ---------------------------------------------------------------------
// A11: explicit target scope before navigation (selector view-model)

test("A11: every selector card renders the explicit target authority line", () => {
  withMockDocument(() => {
    const eligibleCard = createSelectorRowElement(NODE_FIXTURE).innerHTML;
    // target: n-<first 8>… per the RFC-0013 D2 truncation convention.
    assert.match(eligibleCard, /target: <strong>n-11112222…<\/strong>/);
    assert.match(eligibleCard, /data-target-line/);

    const ineligibleCard = createSelectorRowElement({
      ...NODE_FIXTURE,
      route: { ...NODE_FIXTURE.route, eligible: false, openUrl: null, reason: "Node is not active", reasonCode: "node-inactive" },
    }).innerHTML;
    // The target line renders even when the route is ineligible — the
    // target authority is explicit before navigation, in both states.
    assert.match(ineligibleCard, /target: <strong>n-11112222…<\/strong>/);
    assert.match(ineligibleCard, /Node is not active/);
  });
});

test("A11: the Open control's accessible target equals the server-provided openUrl", () => {
  withMockDocument(() => {
    const card = createSelectorRowElement(NODE_FIXTURE);
    const openAnchor = /<a href="([^"]+)" class="open-button" aria-label="([^"]*)"/.exec(card.innerHTML);
    assert.ok(openAnchor, "eligible card must carry the Open control");
    // Navigation source: exactly the server-computed openUrl — the UI never
    // derives URLs itself.
    assert.equal(openAnchor[1], NODE_FIXTURE.route.openUrl);
    // The accessible text carries the full deterministic authority.
    assert.ok(openAnchor[2].includes(NODE_FIXTURE.route.openUrl), `aria-label must contain the openUrl: ${openAnchor[2]}`);
    assert.match(openAnchor[2], /^Open endpoint node_11112222333344445555666677778888 — navigates to target authority /);
  });
});

test("A11: formatTargetHint truncates canonical node IDs and never invents URLs", () => {
  assert.equal(formatTargetHint("node_11112222333344445555666677778888"), "n-11112222…");
  assert.equal(formatTargetHint("node_"), "node_".slice(0, 13) + "…");
  assert.equal(formatTargetHint("weird-id"), "weird-id…");
  assert.equal(formatTargetHint(undefined), "");
  assert.equal(formatTargetHint(42), "");
});

// ---------------------------------------------------------------------
// A12: flow-indicator wording honesty (string contract on the view-model)

test("A12: the flow indicator states hub-routed semantics and never claims DSH login/session visibility", () => {
  withMockDocument(() => {
    const card = createSelectorRowElement(NODE_FIXTURE).innerHTML;

    // The label uses the honest hub-side wording…
    assert.match(card, /active hub-routed flows: <strong>2<\/strong>/);
    assert.match(card, /data-flows-indicator/);
    // …and the card never claims node-local DSH login/session visibility.
    assert.doesNotMatch(card, /log(?:ged)?[\s-]?in/i);
    assert.doesNotMatch(card, /DSH\s+(login|session)/i);

    // A missing or malformed count degrades to 0, never to a claim.
    const degraded = createSelectorRowElement({
      ...NODE_FIXTURE,
      route: { ...NODE_FIXTURE.route, activeFlows: undefined },
    }).innerHTML;
    assert.match(degraded, /active hub-routed flows: <strong>0<\/strong>/);
  });
});

test("A12: the selector view-model source carries the honest wording contract", async () => {
  const raw = await read("ui/selector/view-model.mjs");
  // Strip line comments: the contract governs renderable strings, and the
  // module's comments legitimately EXPLAIN the DSH-blindness rule.
  const source = raw.replace(/\/\/[^\n]*/g, "");
  assert.match(source, /active hub-routed flows/);
  assert.doesNotMatch(source, /logged[\s-]?in|DSH\s+(login|session)/i);
});

// ---------------------------------------------------------------------
// A15: responsive breakpoints present, dependency-free (selector CSS)

test("A15: ui/selector/styles.css defines @media breakpoints and touch-target rules without external URLs", async () => {
  const css = await read("ui/selector/styles.css");
  // Defined breakpoints (RFC-0018 D6: e.g. ≤640px and ≤900px).
  const mediaBlocks = [...css.matchAll(/@media[^{]+\{/g)].map((m) => m[0]);
  assert.ok(mediaBlocks.length >= 2, "at least two breakpoints must be defined");
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  // Touch-target sizing for the controls.
  assert.match(css, /min-height: 44px/);
  // No horizontal overflow by design: narrow viewports stack the cards.
  assert.match(css, /flex-direction: column/);
  // Dependency-free: no external fonts, URLs, or @import in the stylesheet.
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /https?:\/\//);
});

test("A15: the selector page keeps its viewport meta and no new asset root was added", async () => {
  const html = await read("ui/selector/index.html");
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  // Evolve-don't-add (RFC-0018 D5): the shell still serves exactly the
  // five selector assets through the existing asset map keys, and no
  // third asset root exists.
  const serverSource = await read("src/registry/server.mjs");
  const selectorMap = /const SELECTOR_UI_ASSETS = new Map\(\[[\s\S]*?\]\);/.exec(serverSource)[0];
  assert.equal((selectorMap.match(/^\s*\["/gm) ?? []).length, 5, "the selector asset map must keep exactly five entries");
  assert.match(selectorMap, /"index\.html"/);
  assert.match(selectorMap, /"app\.mjs"/);
  assert.match(selectorMap, /"view-model\.mjs"/);
  assert.match(selectorMap, /"styles\.css"/);
  assert.doesNotMatch(serverSource, /ui\/devices/);
  assert.equal((serverSource.match(/new URL\("\.\.\/\.\.\/ui\//g) ?? []).length, 3, "exactly the management, selector, and auth UI roots exist");
});

// ---------------------------------------------------------------------
// Management Devices & Nodes section (view-model + real-hub app flow)

test("mapSessionRow derives last activity from the 30-minute idle window and flags revoked rows", () => {
  const row = mapSessionRow({
    sessionId: `sess_${"a".repeat(48)}`,
    sessionIdHint: `sess_${"a".repeat(8)}`,
    operatorPrincipal: "admin",
    createdAt: "2026-09-29T10:00:00.000Z",
    expiresAt: "2026-09-29T22:00:00.000Z",
    idleUntil: "2026-09-29T10:30:00.000Z",
    revokedAt: null,
  });
  assert.equal(row.lastActivity, "2026-09-29T10:00:00.000Z");
  assert.equal(row.revoked, false);

  const revoked = mapSessionRow({ sessionId: `sess_${"b".repeat(48)}`, idleUntil: "2026-09-29T10:30:00.000Z", revokedAt: "2026-09-29T11:00:00.000Z" });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.lastActivity, "2026-09-29T10:00:00.000Z");

  const degraded = mapSessionRow({ idleUntil: "not-a-date" });
  assert.equal(degraded.lastActivity, null);
  assert.equal(degraded.revoked, false);
});

test("mapSessionList keeps the counts and never invents rows", () => {
  const empty = mapSessionList({ sessions: [], activeCount: 0, total: 0 });
  assert.equal(empty.kind, "sessions");
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.activeCount, 0);

  const listed = mapSessionList({
    sessions: [{ sessionId: `sess_${"c".repeat(48)}`, idleUntil: "2026-09-29T10:30:00.000Z", revokedAt: null }],
    activeCount: 1,
    total: 3,
  });
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.activeCount, 1);
  assert.equal(listed.total, 3);

  const garbage = mapSessionList(null);
  assert.equal(garbage.rows.length, 0);
});

// Minimal DOM shim: only the elements the devices flow touches. All
// unknown ids resolve to null exactly like the browser would for a
// missing node, and the app guards every access with ?.
const ELEMENT_IDS = [
  "session-status",
  "nav-nodes",
  "nav-devices",
  "nav-tokens",
  "nav-fleet",
  "nav-schedules",
  "nav-logout",
  "state-banner",
  "nodes-view",
  "nodes-list",
  "node-detail-view",
  "devices-view",
  "devices-summary",
  "devices-sessions-list",
  "devices-nodes-list",
  "refresh-devices-btn",
  "tokens-view",
  "fleet-view",
  "schedules-view",
  "fleet-jobs-list",
  "fleet-job-detail-view",
  "mint-token",
  "mint-pair-token",
];

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this.classList = {
      names: new Set(),
      add: (name) => this.classList.names.add(name),
      remove: (name) => this.classList.names.delete(name),
    };
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
}

class FakeDom {
  constructor() {
    this.elements = new Map(ELEMENT_IDS.map((id) => [id, new FakeElement(id)]));
  }
  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

function browserFetch(baseUrl) {
  let cookie = "";
  return async (path, options) => {
    const headers = { ...(options?.headers ?? {}) };
    if (cookie !== "") headers.cookie = cookie;
    if ((options?.method ?? "GET") === "POST") {
      headers.origin = baseUrl;
      headers["sec-fetch-site"] = "same-origin";
    }
    headers[GATEWAY_HEADER] = ASSERTION;
    headers[PRINCIPAL_HEADER] = "operator";
    const response = await fetch(baseUrl + path, { method: options?.method ?? "GET", headers, body: options?.body });
    const setCookie = response.headers.get("set-cookie");
    if (typeof setCookie === "string" && setCookie !== "") {
      cookie = setCookie.split(";")[0];
    }
    return response;
  };
}

async function withHub(t) {
  const registry = new Registry({ db: openRegistryDatabase(":memory:") });
  const { server } = createHubServer({
    registry,
    options: { gatewayAssertionSecret: ASSERTION, operatorPrincipal: { mode: "inject" } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    registry.close();
  });
  return { registry, baseUrl };
}

test("Devices & Nodes: the section lists sessions with hint-only rendering, activeCount, and a two-step revoke that isolates the target", async (t) => {
  const { registry, baseUrl } = await withHub(t);
  const dom = new FakeDom();
  const ui = createRegistryUi({ document: dom, fetchImpl: browserFetch(baseUrl) });
  await ui.start();

  // A second operator session to revoke (the UI session is the caller).
  const other = registry.bootstrapSession({ principal: "operator" });

  await dom.getElementById("nav-devices").listeners.click({ target: dom.getElementById("nav-devices") });

  // The section opened and rendered both views in one screen.
  assert.equal(dom.getElementById("devices-view").hidden, false);
  assert.equal(dom.getElementById("nodes-view").hidden, true);
  const summary = dom.getElementById("devices-summary").innerHTML;
  assert.match(summary, /Operator sessions:/);
  assert.match(summary, /2 active · 2 stored/);
  // Indicator honesty in the management copy too.
  assert.match(summary, /cannot identify devices/);
  assert.match(summary, /cannot see node-local DSH logins/);

  const sessionsHtml = dom.getElementById("devices-sessions-list").innerHTML;
  // A11/A4 sibling contract: the table renders ONLY the hint…
  const hint = other.sessionId.slice(0, 13);
  assert.match(sessionsHtml, new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // …never the full session id of any session (the caller's id is the
  // cookie value; both are 53 chars and both must be absent).
  assert.equal(sessionsHtml.includes(other.sessionId), false, "the full target session id must not enter the DOM");
  assert.match(sessionsHtml, /data-revoke-hint/);
  assert.match(sessionsHtml, /<button class="danger"[^>]*>revoke<\/button>/);
  assert.doesNotMatch(sessionsHtml, /<button class="danger[^"]*"[^>]*data-revoke-hint="[^"]*"[^>]*>confirm revoke\?<\/button>/);

  // Two-step revoke: the first click only arms the row.
  const list = dom.getElementById("devices-sessions-list");
  await list.listeners.click({ target: { dataset: { revokeHint: hint } } });
  assert.match(list.innerHTML, /confirm revoke\?/);

  // Clicking another hint re-arms; the second click on the armed hint revokes.
  await list.listeners.click({ target: { dataset: { revokeHint: hint } } });

  // The revocation took effect on the hub…
  const check = await fetch(`${baseUrl}/hub/session`, {
    headers: { cookie: `dsh-orbit-hub-session=${other.sessionId}`, [GATEWAY_HEADER]: ASSERTION, [PRINCIPAL_HEADER]: "operator" },
  });
  assert.equal(check.status, 401);
  const revokedRow = (await registry.listSessions()).sessions.find((row) => row.sessionId === other.sessionId);
  assert.ok(revokedRow.revokedAt !== null);

  // …and the refreshed table shows the revoked status without an action.
  assert.match(list.innerHTML, /<span class="badge revoked">revoked<\/span>/);
  assert.match(list.innerHTML, /<span class="dim">—<\/span>/);
  assert.doesNotMatch(list.innerHTML, /confirm revoke\?/);
  assert.match(dom.getElementById("state-banner").innerHTML, new RegExp(`session ${hint} revoked`));
  // The caller's own (still-active) session keeps its revoke control.
  assert.match(list.innerHTML, /<button class="danger" data-revoke-hint="[^"]+">revoke<\/button>/);
  void ui;
});

test("Devices & Nodes: the revoke fails closed when a hint resolves to no unique active session", async (t) => {
  const { registry, baseUrl } = await withHub(t);
  const dom = new FakeDom();
  const ui = createRegistryUi({ document: dom, fetchImpl: browserFetch(baseUrl) });
  await ui.start();

  await dom.getElementById("nav-devices").listeners.click({ target: dom.getElementById("nav-devices") });
  const list = dom.getElementById("devices-sessions-list");

  // A hint that matches no active row resolves to zero sessions: the
  // mutation must never fire and the operator gets an explicit banner.
  const unknownHint = "sess_deadbeef";
  await list.listeners.click({ target: { dataset: { revokeHint: unknownHint } } });
  await list.listeners.click({ target: { dataset: { revokeHint: unknownHint } } });
  assert.match(dom.getElementById("state-banner").innerHTML, /not uniquely identifiable/);

  // Nothing was revoked.
  const rows = (await registry.listSessions()).sessions;
  assert.equal(rows.some((row) => row.revokedAt !== null), false);
  // The caller's session is still valid.
  const callerRow = rows.find((row) => row.revokedAt === null);
  const check = await fetch(`${baseUrl}/hub/session`, {
    headers: {
      cookie: `dsh-orbit-hub-session=${callerRow.sessionId}`,
      [GATEWAY_HEADER]: ASSERTION,
      [PRINCIPAL_HEADER]: "operator",
    },
  });
  assert.equal(check.status, 200);
});
