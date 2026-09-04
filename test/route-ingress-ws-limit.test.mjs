import assert from "node:assert/strict";
import test from "node:test";
import { RouteIngress } from "../src/node/route-ingress.mjs";

test("RouteIngress WebSocket connection limit configuration and env parsing", async () => {
  const originalEnv = process.env.DSH_ORBIT_NODE_WS_LIMIT;

  try {
    // 1. Unset env -> default 50
    delete process.env.DSH_ORBIT_NODE_WS_LIMIT;
    const ingressDefault = new RouteIngress({
      nodeId: () => "node_test",
      routeDomain: "test.example",
      dshTarget: "http://127.0.0.1:3000",
    });
    assert.equal(ingressDefault.wsTracker.maxConnections, 50);

    // 2. Empty string env ("") -> default 50
    process.env.DSH_ORBIT_NODE_WS_LIMIT = "";
    const ingressEmptyEnv = new RouteIngress({
      nodeId: () => "node_test",
      routeDomain: "test.example",
      dshTarget: "http://127.0.0.1:3000",
    });
    assert.equal(ingressEmptyEnv.wsTracker.maxConnections, 50);

    // 3. Valid integer string ("1") -> 1
    process.env.DSH_ORBIT_NODE_WS_LIMIT = "1";
    const ingressMin = new RouteIngress({
      nodeId: () => "node_test",
      routeDomain: "test.example",
      dshTarget: "http://127.0.0.1:3000",
    });
    assert.equal(ingressMin.wsTracker.maxConnections, 1);

    // 4. Valid integer string ("10000") -> 10000
    process.env.DSH_ORBIT_NODE_WS_LIMIT = "10000";
    const ingressMax = new RouteIngress({
      nodeId: () => "node_test",
      routeDomain: "test.example",
      dshTarget: "http://127.0.0.1:3000",
    });
    assert.equal(ingressMax.wsTracker.maxConnections, 10000);

    // 5. Invalid values fail closed with RangeError
    const invalidEnvValues = ["0", "-1", "NaN", "10001", "3.14", "not-a-number", " "];
    for (const invalid of invalidEnvValues) {
      process.env.DSH_ORBIT_NODE_WS_LIMIT = invalid;
      assert.throws(
        () =>
          new RouteIngress({
            nodeId: () => "node_test",
            routeDomain: "test.example",
            dshTarget: "http://127.0.0.1:3000",
          }),
        RangeError,
        `Expected RangeError for DSH_ORBIT_NODE_WS_LIMIT='${invalid}'`,
      );
    }

    // 6. Direct options parameter takes precedence over env
    process.env.DSH_ORBIT_NODE_WS_LIMIT = "100";
    const ingressOptionPrecedence = new RouteIngress({
      nodeId: () => "node_test",
      routeDomain: "test.example",
      dshTarget: "http://127.0.0.1:3000",
      maxWsConnections: 25,
    });
    assert.equal(ingressOptionPrecedence.wsTracker.maxConnections, 25);

    // 7. Invalid direct options parameter fails closed
    delete process.env.DSH_ORBIT_NODE_WS_LIMIT;
    const invalidOptions = [0, -1, 10001, NaN, 1.5, null];
    for (const opt of invalidOptions) {
      if (opt === null) {
        // null falls back to default 50
        const ingressNull = new RouteIngress({
          nodeId: () => "node_test",
          routeDomain: "test.example",
          dshTarget: "http://127.0.0.1:3000",
          maxWsConnections: null,
        });
        assert.equal(ingressNull.wsTracker.maxConnections, 50);
      } else {
        assert.throws(
          () =>
            new RouteIngress({
              nodeId: () => "node_test",
              routeDomain: "test.example",
              dshTarget: "http://127.0.0.1:3000",
              maxWsConnections: opt,
            }),
          RangeError,
          `Expected RangeError for maxWsConnections=${opt}`,
        );
      }
    }
  } finally {
    if (originalEnv !== undefined) {
      process.env.DSH_ORBIT_NODE_WS_LIMIT = originalEnv;
    } else {
      delete process.env.DSH_ORBIT_NODE_WS_LIMIT;
    }
  }
});
