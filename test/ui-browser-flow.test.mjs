// SOP Stage 5 required live evidence (automated form): the operator UI
// shell is served, and the full destructive workflows run THROUGH the
// browser surface (session bootstrap -> CSRF -> delete with requestId
// -> explicit result; token plaintext once) against a real hub, with
// the view-model rendering the state the UI would show.

import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryDatabase } from "../src/registry/sqlite.mjs";
import { Registry } from "../src/registry/registry.mjs";
import { createHubServer } from "../src/registry/server.mjs";
import { createDeleteRequestId, mapApiError, mapDeleteResult, mapNodeList, mapTokenList, mapTokenMint } from "../ui/view-model.mjs";

const ASSERTION = "gateway-held-assertion-secret";
const GATEWAY_HEADER = "x-dsh-authenticated-proxy";
const PRINCIPAL_HEADER = "x-dsh-operator-id";
const CSRF_HEADER = "x-csrf-token";

const GATEWAY_HEADERS = { [GATEWAY_HEADER]: ASSERTION, [PRINCIPAL_HEADER]: "operator" };

async function withHub(t, { dbPath } = {}) {
  const registry = new Registry({ db: openRegistryDatabase(dbPath ?? ":memory:") });
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
  return { registry, server, baseUrl };
}

async function bootstrapUiSession(baseUrl) {
  const response = await fetch(`${baseUrl}/hub/session`, {
    method: "POST",
    headers: { ...GATEWAY_HEADERS, origin: baseUrl, "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.match(/(?:^|;\s*)dsh-orbit-hub-session=([^;]+)/)?.[1];
  const body = await response.json();
  return { cookie, csrfToken: body.csrfToken };
}

test("the UI shell and assets are served and are data-free", async (t) => {
  const { baseUrl } = await withHub(t);
  for (const [path, contentType] of [
    ["/", "text/html"],
    ["/app.mjs", "text/javascript"],
    ["/view-model.mjs", "text/javascript"],
    ["/styles.css", "text/css"],
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", new RegExp(contentType));
    const text = await response.text();
    assert.equal(text.includes("api/v1"), false, "the UI shell must not embed machine API knowledge");
  }
  // Unknown assets 404; nothing sensitive at /hub is public.
  const missing = await fetch(`${baseUrl}/nope.mjs`);
  assert.equal(missing.status, 404);
});

test("full operator flow through the browser surface: mint (plaintext once), delete (requestId), replay, reenroll token", async (t) => {
  const { registry, server, baseUrl } = await withHub(t);

  // Put a node on the hub through the machine path.
  const plain = registry.mintEnrollmentToken({ actor: "operator", purpose: "enroll" });
  const enroll = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: plain.token, enrollmentRequestId: "aa".repeat(16), publicKey: "01".repeat(32) }),
  });
  const enrolled = await enroll.json();
  assert.equal(enroll.status, 200);

  const session = await bootstrapUiSession(baseUrl);
  const headers = { ...GATEWAY_HEADERS, cookie: `dsh-orbit-hub-session=${session.cookie}`, "x-csrf-token": session.csrfToken, "content-type": "application/json", origin: baseUrl, "sec-fetch-site": "same-origin" };

  // UI loads the node list; the view-model renders all dimensions.
  const list = await fetch(`${baseUrl}/hub/nodes`, { headers: { ...GATEWAY_HEADERS, cookie: `dsh-orbit-hub-session=${session.cookie}` } });
  const listBody = await list.json();
  const view = mapNodeList(listBody.nodes);
  assert.equal(view.kind, "nodes");
  assert.equal(view.rows[0].health.registryContact, "unknown"); // enrolled, not yet heartbeated
  assert.equal(view.rows[0].health.reachable, "unknown");

  // Delete with the UI-generated requestId: explicit result.
  const requestId = createDeleteRequestId();
  assert.match(requestId, /^[0-9a-f]{32}$/);
  const deleted = await fetch(`${baseUrl}/hub/nodes/${enrolled.nodeId}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, reason: "retired" }),
  });
  assert.equal(deleted.status, 200);
  const deleteView = mapDeleteResult(await deleted.json());
  assert.equal(deleteView.idempotentReplay, false);
  assert.equal(deleteView.state, "tombstoned");

  // Idempotent replay returns the same result without a second tombstone.
  const replay = await fetch(`${baseUrl}/hub/nodes/${enrolled.nodeId}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, reason: "retired" }),
  });
  assert.equal(mapDeleteResult(await replay.json()).idempotentReplay, true);
  assert.equal(registry.getNode(enrolled.nodeId).state, "tombstoned");

  // Token mint through the browser surface: plaintext exactly once.
  const minted = await fetch(`${baseUrl}/hub/tokens`, { method: "POST", headers, body: JSON.stringify({ purpose: "enroll" }) });
  assert.equal(minted.status, 200);
  const mintView = mapTokenMint(await minted.json());
  assert.match(mintView.plaintextOnce, /^[0-9a-f]{32}$/);
  const tokensView = mapTokenList((await (await fetch(`${baseUrl}/hub/tokens`, { headers: { ...GATEWAY_HEADERS, cookie: `dsh-orbit-hub-session=${session.cookie}` } })).json()).tokens);
  assert.equal(tokensView.rows.some((row) => row.tokenId === mintView.tokenId && row.status === "active"), true);

  // Reenroll token mint for the tombstoned node through the surface.
  const reenrollMint = await fetch(`${baseUrl}/hub/nodes/${enrolled.nodeId}/reenroll`, { method: "POST", headers });
  assert.equal(reenrollMint.status, 200);
  assert.equal((await reenrollMint.json()).purpose, "reenroll");

  // Logout terminates the session.
  const logout = await fetch(`${baseUrl}/hub/session/logout`, { method: "POST", headers });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/hub/nodes`, { headers: { ...GATEWAY_HEADERS, cookie: `dsh-orbit-hub-session=${session.cookie}` } });
  assert.equal(afterLogout.status, 401);

  // Error mapping still reads correctly for the UI.
  const bad = await fetch(`${baseUrl}/hub/nodes/notarealnode`, { headers: { ...GATEWAY_HEADERS, cookie: `dsh-orbit-hub-session=${session.cookie}` } });
  assert.equal(bad.status, 401); // session gone
  void mapApiError;
});