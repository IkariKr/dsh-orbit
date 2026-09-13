// Node-local DSH compatibility adapter contract (RFC-0003, RFC-0010).
//
// The adapter — never RouteIngress, never the Hub, never a client — presents
// the DSH compatibility proof. These tests bind that claim to its named code
// and configuration sources so a regression cannot silently move secret
// ownership into the wrong layer.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ADAPTER = new URL("../proxy/dsh-compat-adapter.Caddyfile", import.meta.url);
const DRILL_CADDY = new URL("../docker-registry/dsh-drill.Caddyfile", import.meta.url);
const BROWSER_GATEWAY = new URL("../proxy/Caddyfile.example", import.meta.url);
const ROUTE_PROXY = new URL("../src/registry/route-proxy.mjs", import.meta.url);
const ROUTE_INGRESS = new URL("../src/node/route-ingress.mjs", import.meta.url);
const COMPOSE_EXAMPLE = new URL("../docker/compose.example.yaml", import.meta.url);

const PROOF_INJECTION = /header_up\s+X-DSH-Orbit-Authenticated-Proxy\s+\{\$DSH_PROXY_AUTH\}/;

async function read(url) {
  return readFile(url, "utf8");
}

test("the canonical adapter config carries the complete proof-injection contract", async () => {
  const source = await read(ADAPTER);
  assert.match(source, PROOF_INJECTION, "the adapter must inject the node's proof");
  assert.match(source, /header_up\s+Host\s+\{\$DSH_PUBLIC_HOST\}/, "the adapter must present DSH's public host");
  assert.match(source, /header_up\s+Origin\s+https:\/\/\{\$DSH_PUBLIC_HOST\}/, "the adapter must present the expected Origin authority");
  assert.match(source, /header_up\s+X-Forwarded-Proto\s+https/, "the adapter must fix the forwarded protocol");
  assert.match(source, /reverse_proxy\s+127\.0\.0\.1:3080/, "the adapter shares the DSH container network namespace");
  // The same secret file feeds DSH (DSH_PROXY_AUTH_FILE) and the adapter
  // (DSH_PROXY_AUTH): one secret configuration, no second credential store.
  assert.match(source, /dsh_proxy_auth secret DSH reads through DSH_PROXY_AUTH_FILE/);
});

test("the mounted drill adapter keeps the same injection contract", async () => {
  const source = await read(DRILL_CADDY);
  const adapterBlock = source.slice(source.indexOf(":3081"), source.indexOf("https://:9443"));
  assert.ok(adapterBlock.length > 0, "the drill adapter must keep its private :3081 block");
  assert.match(adapterBlock, PROOF_INJECTION);
  assert.match(adapterBlock, /header_up\s+Host\s+\{\$DSH_PUBLIC_HOST\}/);
  assert.match(adapterBlock, /header_up\s+Origin\s+https:\/\/\{\$DSH_PUBLIC_HOST\}/);
  assert.match(adapterBlock, /header_up\s+X-Forwarded-Proto\s+https/);
});

test("the browser gateway example applies the same proof-injection contract", async () => {
  const source = await read(BROWSER_GATEWAY);
  const injections = source.match(new RegExp(PROOF_INJECTION, "g")) ?? [];
  assert.ok(injections.length >= 2, "both gateway paths (access-provider and basic auth) must inject the proof");
  assert.match(source, /header_up\s+Host\s+\{\$DSH_PUBLIC_HOST\}/);
  assert.match(source, /header_up\s+X-Forwarded-Proto\s+https/);
});

test("the Hub and the Node route ingress strip client-supplied DSH proofs and hold no secret", async () => {
  for (const url of [ROUTE_PROXY, ROUTE_INGRESS]) {
    const source = await read(url);
    assert.match(
      source,
      /"x-dsh-orbit-authenticated-proxy"/,
      `${url.pathname} must strip the client-supplied Orbit proof header`,
    );
    assert.match(source, /"x-dsh-authenticated-proxy"/, `${url.pathname} must strip the gateway assertion header`);
    assert.doesNotMatch(
      source,
      /DSH_PROXY_AUTH/,
      `${url.pathname} must not read the DSH proxy secret: injection belongs to the adapter`,
    );
  }
});

test("one secret configuration feeds DSH and the adapter", async () => {
  const compose = await read(COMPOSE_EXAMPLE);
  assert.match(compose, /DSH_PROXY_AUTH_FILE:\s*\/run\/secrets\/dsh_proxy_auth/, "DSH reads the secret from the file");
  assert.match(
    compose,
    /export DSH_PROXY_AUTH="\$\$\(cat \/run\/secrets\/dsh_proxy_auth\)"/,
    "the adapter receives the same secret value, not a second credential",
  );
});
