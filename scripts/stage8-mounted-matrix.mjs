// Harness-only canonical mounted acceptance matrix for Stage 8.
// Product runtime must not import this module.

export const REQUIRED_MOUNTED_MATRIX_FIELDS = Object.freeze([
  "routeTargetsConfiguredAB",
  "routeTargetsPersisted",
  "eligibilityAB",
  "selectorListsAB",
  "selectorOpenA",
  "selectorOpenB",
  "httpRootA",
  "httpRootB",
  "staticAssetA",
  "staticAssetB",
  "websocketUpgradeA",
  "websocketUpgradeB",
  "websocketPingPongA",
  "websocketPingPongB",
  "cookieIsolation",
  "nodeContextIsolation",
  "gatewayRestartRecovery",
  "hubRestartRecovery",
  "nodeAFailClosedOutage",
  "nodeBHealthyDuringAOutage",
  "dshLossAndRecovery",
  "bookmarkFailClosed",
  "sameNodeIdReenroll",
  "freshHubRouteIdentity",
  "deleteBookmarkAndReenroll",
]);

export function emptyMountedMatrix() {
  return Object.fromEntries(REQUIRED_MOUNTED_MATRIX_FIELDS.map((field) => [field, "NOT_EXECUTED"]));
}

export function assertMountedMatrixShape(matrix, { requirePass = false } = {}) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("mounted requiredMatrix must be an object");
  }
  const actual = Object.keys(matrix).sort();
  const expected = [...REQUIRED_MOUNTED_MATRIX_FIELDS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`mounted requiredMatrix fields mismatch: expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
  for (const field of REQUIRED_MOUNTED_MATRIX_FIELDS) {
    if (typeof matrix[field] !== "string") throw new Error(`mounted requiredMatrix.${field} must be a string`);
    if (requirePass && matrix[field] !== "PASS") {
      throw new Error(`mounted requiredMatrix.${field} must be PASS, got ${JSON.stringify(matrix[field])}`);
    }
  }
  return true;
}
