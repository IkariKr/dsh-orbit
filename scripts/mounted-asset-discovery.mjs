// Mounted static-asset discovery for the two-node drill.
//
// The served index must be probed for a real UI asset instead of a pinned
// build-hash constant: the hashed filename changes with every upstream build.
// Upstream also changes the base between baselines — the legacy build emits
// absolute "/assets/…" references while the 0.1.5 build emits relative
// "./assets/…" references (the web process inserts `<base href="/">` at serve
// time and never rewrites the text) — so discovery must accept both shapes and
// normalize to the absolute route path before fetching.

const ASSET_REFERENCE_PATTERN = /(?:src|href)=["']((?:\.?\/)assets\/[A-Za-z0-9._/-]+\.(?:css|js))["']/;

/**
 * Discover one real static asset reference from a served index document.
 * @param html - the index HTML as served through the route.
 * @param label - node label for the failure message.
 * @returns the normalized absolute asset path, e.g. "/assets/index-Ab12Cd34.js".
 */
export function discoverMountedAssetPath(html, label) {
  const match = String(html).match(ASSET_REFERENCE_PATTERN);
  if (!match) {
    throw new Error(`mounted static asset discovery failed on ${label}: no assets reference in the served index`);
  }
  return match[1].replace(/^\.\//, "/");
}
