// DeepSeek Harness (DSH) Native Cordis Plugin Entry (RFC-0016 D1, Stage 1).
// Provides native plugin discovery, lifecycle hooks, and DSH Settings persistence.

import { OrbitSettingsStore, bindDshSettings, ORBIT_SETTINGS_NAMESPACE } from "./settings.mjs";

/** Cordis Plugin Name Identifier */
export const name = "dsh-orbit";

/** Cordis Dependency Injection: declare webServer and settings services */
export const inject = ["webServer", "settings"];

/**
 * Cordis plugin lifecycle mount entrypoint.
 *
 * @param {object} ctx - Cordis application context
 * @param {object} [config] - Initial plugin options
 */
export function apply(ctx, config = {}) {
  // 1. Initialize Orbit settings store
  const store = new OrbitSettingsStore(config);

  // 2. Bind to DSH native Settings service (persisting to ~/.dsh/settings.yaml)
  bindDshSettings(ctx, store);

  // 3. Mount local DSH Node health/status endpoint if webServer service is present
  if (ctx.webServer && typeof ctx.webServer.register === "function") {
    ctx.webServer.register({
      method: "GET",
      path: "/api/orbit/node-status",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        res.end(
          JSON.stringify({
            status: "ok",
            plugin: name,
            namespace: ORBIT_SETTINGS_NAMESPACE,
            options: store.getOptions(),
          }),
        );
      },
    });
  }

  // Record store on context for testing and inspection
  if (typeof ctx.provide === "function") {
    ctx.provide(name, { store });
  } else {
    try {
      ctx[name] = { store };
    } catch {}
  }

  ctx.logger?.info?.(`[dsh-orbit] DSH native plugin initialized (namespace: ${ORBIT_SETTINGS_NAMESPACE})`);
}

export { OrbitSettingsStore, bindDshSettings, ORBIT_SETTINGS_NAMESPACE };
