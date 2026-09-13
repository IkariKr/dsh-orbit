// Regression for the mounted static-asset discovery: the drill must find the
// real UI asset a served index references on every supported baseline shape,
// not just one upstream build's absolute paths.

import assert from "node:assert/strict";
import test from "node:test";
import { discoverMountedAssetPath } from "../scripts/mounted-asset-discovery.mjs";

// The real 0.1.5-rc.2 dist index shape: relative "./assets/…" references with
// crossorigin attributes (the web process serves them with `<base href="/">`
// inserted and never rewrites the text).
const DSH_015_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>DSH Local Build</title>
    <script type="module" crossorigin src="./assets/index-BKQ_L1z6.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/vendor-BNsW4eBh.css">
    <link rel="stylesheet" crossorigin href="./assets/index-DPX2bQLO.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

// The legacy 0.1.1-rc.2 dist index shape: absolute "/assets/…" references.
const DSH_011_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <title>DSH Local Build</title>
    <link rel="stylesheet" href="/assets/index-C6eRlFa6.css" />
  </head>
  <body><div id="root"></div></body>
</html>`;

test("discovers and normalizes the real 0.1.5 relative asset references", () => {
  const path = discoverMountedAssetPath(DSH_015_INDEX, "A");
  assert.equal(path, "/assets/index-BKQ_L1z6.js", "relative ./assets references must normalize to absolute route paths");
});

test("discovers the legacy absolute asset reference", () => {
  const path = discoverMountedAssetPath(DSH_011_INDEX, "B");
  assert.equal(path, "/assets/index-C6eRlFa6.css");
});

test("accepts single-quoted asset references", () => {
  const path = discoverMountedAssetPath(`<script src='./assets/index-Xy9zW1.js'></script>`, "A");
  assert.equal(path, "/assets/index-Xy9zW1.js");
});

test("fails closed when the served index references no bundled asset", () => {
  assert.throws(
    () => discoverMountedAssetPath("<html><body>no assets here</body></html>", "A"),
    /mounted static asset discovery failed on A/,
  );
});
