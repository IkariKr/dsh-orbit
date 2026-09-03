// Gate B: real app/DOM-level tests — the browser application logic
// runs against a REAL hub through a minimal DOM shim and a browser-like
// fetch (cookies + Origin + Sec-Fetch-Site), instead of testing only
// the view-model plus hand-written fetches.

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { createRegistryUi } from "../ui/app.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";

const ELEMENT_IDS = [
  "session-status",
  "nav-nodes",
  "nav-tokens",
  "nav-logout",
  "state-banner",
  "nodes-list",
  "reenroll-result",
  "node-detail-view",
  "tokens-view",
  "nodes-view",
  "mint-token",
  "mint-result",
  "token-table-body",
  "confirm-dialog",
  "confirm-dialog-message",
  "confirm-reason",
  "confirm-cancel",
  "confirm-ok",
  "route-target-input",
  "route-target-error",
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
    this.opened = false;
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
  showModal() {
    this.opened = true;
  }
  close() {
    this.opened = false;
  }
  closest() {
    return null; // detail-click navigation is not exercised in DOM tests
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

// Models the browser -> gateway -> hub path: the gateway (here and in
// Caddy) authenticates first, then strips and injects the internal
// assertion + principal; the browser's own Cookie/Origin/Sec-Fetch-Site
// pass through untouched.
function browserFetch(baseUrl) {
  let cookie = "";
  return async (path, options) => {
    const headers = { ...(options?.headers ?? {}) };
    if (cookie !== "") headers.cookie = cookie;
    if ((options?.method ?? "GET") === "POST") {
      // A same-origin browser POST carries these; the hub's RFC-0007
      // trust checks depend on them reaching it.
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

async function enrollRawNode(baseUrl, registry) {
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const response = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: plain.token, enrollmentRequestId: "aa".repeat(16), publicKey: "01".repeat(32) }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).nodeId;
}

async function click(element) {
  const fn = element.listeners.click;
  if (fn) await fn({ target: element });
}

test("app-level: empty states render, the first token IS mintable with zero tokens, plaintext survives the list refresh", async (t) => {
  const { registry, baseUrl } = await withHub(t);
  const dom = new FakeDom();
  const ui = createRegistryUi({ document: dom, fetchImpl: browserFetch(baseUrl) });
  await ui.start();

  // Empty nodes state.
  assert.match(dom.getElementById("state-banner").innerHTML, /no nodes registered yet/);

  // Open the tokens view with ZERO tokens: mint must be possible.
  await click(dom.getElementById("nav-tokens"));
  assert.match(dom.getElementById("state-banner").innerHTML, /mint the first one/);
  assert.match(dom.getElementById("token-table-body").innerHTML, /no enrollment tokens yet/);
  assert.ok(dom.getElementById("mint-token"), "mint button must exist with zero tokens");

  // Mint: plaintext appears exactly once and is NOT wiped by the
  // follow-up list refresh.
  await click(dom.getElementById("mint-token"));
  const resultHtml = dom.getElementById("mint-result").innerHTML;
  assert.match(resultHtml, /Copy this token now/);
  const plaintext = resultHtml.match(/data-plaintext-once>([0-9a-f]+)</)?.[1];
  assert.match(plaintext ?? "", /^[0-9a-f]{32}$/);
  void plaintext;
  assert.match(dom.getElementById("token-table-body").innerHTML, /etok_/, "the list now carries the minted token row");
  // The plaintext block must still be there after the refresh.
  assert.match(dom.getElementById("mint-result").innerHTML, /data-plaintext-once>/);
  // /hub/tokens never returns the plaintext (contract) — this UI holds
  // it only in the once-block.
  assert.equal(dom.getElementById("token-table-body").innerHTML.includes(plaintext), false, "the list must never contain the plaintext");
});

async function openDialog(dom, nodeId) {
  const handler = dom.getElementById("nodes-list").listeners.click;
  await handler({ target: { dataset: { deleteId: nodeId }, closest: () => null } });
}

test("app-level: delete confirmation flow and tombstoned-node reenroll token flow", async (t) => {
  const { registry, baseUrl } = await withHub(t);
  const nodeId = await enrollRawNode(baseUrl, registry);
  const dom = new FakeDom();
  const ui = createRegistryUi({ document: dom, fetchImpl: browserFetch(baseUrl) });
  await ui.start();

  // Node list renders the active row with a delete action; every
  // dimension badge is present verbatim.
  const listHtml = dom.getElementById("nodes-list").innerHTML;
  assert.match(listHtml, new RegExp(nodeId));
  for (const dimension of ["registryContact", "dshHealthy", "orbitCompatible", "reachable", "authenticated", "state"]) {
    assert.match(listHtml, new RegExp(dimension), `${dimension} badge must render`);
  }

  // Delete flow: click delete -> confirm dialog opens -> confirm.
  // The app wires one listener on #nodes-list; emulate the browser by
  // dispatching a click whose target carries data-delete-id.
  await openDialog(dom, nodeId);
  assert.equal(dom.getElementById("confirm-dialog").opened, true, "the confirmation dialog must open");
  dom.getElementById("confirm-reason").value = "retired";
  await dom.getElementById("confirm-ok").onclick();
  assert.match(dom.getElementById("state-banner").innerHTML, /deleted/);
  const tombstonedHtml = dom.getElementById("nodes-list").innerHTML;
  assert.match(tombstonedHtml, /mint re-enrollment token/, "a tombstoned node must offer the reenroll action");

  // Reenroll token flow: click the reenroll button -> plaintext once.
  await dom.getElementById("nodes-list").listeners.click({ target: { dataset: { reenrollId: nodeId }, closest: () => null } });
  const reenrollHtml = dom.getElementById("reenroll-result").innerHTML;
  assert.match(reenrollHtml, /Re-enrollment token for/);
  assert.match(reenrollHtml, /data-plaintext-once>/);
});

test("app-level: node detail can set, report validation error, and remove route target through the UI", async (t) => {
  const { registry, baseUrl } = await withHub(t);
  const nodeId = await enrollRawNode(baseUrl, registry);
  const dom = new FakeDom();
  const ui = createRegistryUi({ document: dom, fetchImpl: browserFetch(baseUrl) });
  await ui.start();

  // Emulate clicking on the node row to view detail
  await dom.getElementById("nodes-list").listeners.click({
    target: {
      dataset: {},
      closest: (selector) => (selector === ".node-id" ? { textContent: nodeId } : null),
    },
  });

  const detailHtml = dom.getElementById("node-detail-view").innerHTML;
  assert.match(detailHtml, /Route Target/);
  assert.match(detailHtml, /current target/);

  // 1. Enter invalid target -> validation error displayed
  dom.getElementById("route-target-input").value = "http://remote-insecure";
  await dom.getElementById("node-detail-view").listeners.click({
    target: { id: "save-route-target", dataset: { nodeId } },
  });
  assert.match(dom.getElementById("route-target-error").textContent, /validation error/);

  // 2. Enter valid target -> saved and detail refreshed
  dom.getElementById("route-target-input").value = "https://nas.example:8443";
  await dom.getElementById("node-detail-view").listeners.click({
    target: { id: "save-route-target", dataset: { nodeId } },
  });
  assert.equal(registry.getRouteTarget(nodeId).origin, "https://nas.example:8443");

  // 3. Remove target -> removed
  await dom.getElementById("node-detail-view").listeners.click({
    target: { id: "remove-route-target", dataset: { nodeId } },
  });
  assert.equal(registry.getRouteTarget(nodeId), null);
});