import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  formatBadge,
  formatErrorMessage,
  renderEmptyState,
  renderLoadingState,
  createSelectorRowElement,
} from "../ui/selector/view-model.mjs";

test("Selector UI view-model: escapeHtml properly neutralizes malicious characters", () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("foo & bar ' baz"), "foo &amp; bar &#39; baz");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("Selector UI view-model: formatBadge renders sanitized badges", () => {
  const badge = formatBadge("reach", "ok");
  assert.ok(badge.includes('class="badge ok"'));
  assert.ok(badge.includes('<span class="dimension">reach</span>ok'));

  const unknownBadge = formatBadge("contact", null);
  assert.ok(unknownBadge.includes('class="badge unknown"'));
  assert.ok(unknownBadge.includes("unknown"));
});

test("Selector UI view-model: render loading and empty states", () => {
  const loading = renderLoadingState();
  assert.ok(loading.includes("Loading registered endpoints"));
  assert.ok(loading.includes('role="status"'));

  const empty = renderEmptyState();
  assert.ok(empty.includes("No endpoints currently registered in Orbit Hub"));
  assert.ok(empty.includes('role="status"'));
});

test("Selector UI view-model: createSelectorRowElement renders eligible row with Open anchor", () => {
  const node = {
    nodeId: "node_11112222333344445555666677778888",
    state: "active",
    runtimeIdentity: {
      dshVersion: "0.1.1-rc.2",
      orbitVersion: "0.4.0",
    },
    health: {
      registryContact: "fresh",
      reachable: "ok",
      orbitCompatible: "pass",
      capabilities: [{ name: "web.routes", version: 1 }],
      capabilitiesStale: false,
    },
    route: {
      eligible: true,
      reasonCode: null,
      reason: null,
      openUrl: "https://n-11112222333344445555666677778888.stage5-test.example/",
    },
  };

  // Mock DOM minimal document
  globalThis.document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        attributes: {},
        setAttribute(k, v) { this.attributes[k] = v; },
        innerHTML: "",
      };
    },
  };

  const el = createSelectorRowElement(node);
  assert.ok(el.className.includes("eligible"));
  assert.ok(el.innerHTML.includes('href="https://n-11112222333344445555666677778888.stage5-test.example/"'));
  assert.ok(el.innerHTML.includes('class="open-button"'));
  assert.ok(el.innerHTML.includes("node_11112222333344445555666677778888"));
  assert.ok(el.innerHTML.includes('data-state="active"'));
  assert.ok(el.innerHTML.includes("0.1.1-rc.2"));
});

test("Selector UI view-model: createSelectorRowElement renders ineligible row with reason and disabled button", () => {
  const node = {
    nodeId: "node_99998888777766665555444433332222",
    state: "active",
    runtimeIdentity: {
      dshVersion: "0.1.1-rc.2",
      orbitVersion: "0.4.0",
    },
    health: {
      registryContact: "fresh",
      reachable: "unreachable",
      orbitCompatible: "pass",
      capabilities: [{ name: "web.routes", version: 1 }],
      capabilitiesStale: false,
    },
    route: {
      eligible: false,
      reasonCode: "route-unreachable",
      reason: "Route ingress or downstream DSH is unreachable",
      openUrl: null,
    },
  };

  const el = createSelectorRowElement(node);
  assert.ok(el.className.includes("ineligible"));
  assert.ok(!el.innerHTML.includes('class="open-button"'));
  assert.ok(el.innerHTML.includes('class="disabled-button"'));
  assert.ok(el.innerHTML.includes("Route ingress or downstream DSH is unreachable"));
  assert.ok(el.innerHTML.includes('data-state="active"'));
});

test("Selector UI view-model: createSelectorRowElement renders tombstoned node with explicit state and unavailable controls", () => {
  const node = {
    nodeId: "node_aaaa0000bbbb1111cccc2222dddd3333",
    state: "tombstoned",
    runtimeIdentity: {
      dshVersion: "0.1.1-rc.2",
      orbitVersion: "0.4.0",
    },
    health: {
      registryContact: "stale",
      reachable: "unreachable",
      orbitCompatible: "pass",
      capabilities: [],
      capabilitiesStale: true,
    },
    route: {
      eligible: false,
      reasonCode: "node-inactive",
      reason: "Node is not active",
      openUrl: null,
    },
  };

  const el = createSelectorRowElement(node);
  assert.ok(el.className.includes("ineligible"));
  assert.ok(el.innerHTML.includes('data-state="tombstoned"'));
  assert.ok(el.innerHTML.includes(">tombstoned</span>"));
  assert.ok(el.innerHTML.includes('class="disabled-button"'));
  assert.ok(el.innerHTML.includes("Node is not active"));
});
