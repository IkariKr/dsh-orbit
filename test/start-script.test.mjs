import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const startScript = await readFile(new URL("../docker/start.sh", import.meta.url), "utf8");

test("starts DSH with the public host admitted through the upstream trusted-host fence", () => {
  assert.match(
    startScript,
    /web --no-open --trusted-host "\$DSH_PUBLIC_HOST"/,
    "DSH_PUBLIC_HOST must be passed to dsh web --trusted-host so authenticated reverse-proxy requests can reach plugin routes such as lazy-loaded UI bundles",
  );
});
