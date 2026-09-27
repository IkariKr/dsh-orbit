// DSH Orbit Settings Service Persistence Seam (RFC-0016 D2).
// Binds plugin configuration to ~/.dsh/settings.yaml under the 'dsh-orbit' namespace.

export const ORBIT_SETTINGS_NAMESPACE = "dsh-orbit";

export const DEFAULT_ORBIT_SETTINGS = Object.freeze({
  enabled: true,
  allowTailscaleDirect: false,
  allowLanDirect: false,
  qrCodeTtlSeconds: 300,
  maxFailedAttempts: 5,
  lockDurationMinutes: 15,
});

/**
 * Manages configuration state and synchronization with DSH Settings service.
 */
export class OrbitSettingsStore {
  constructor(initialOptions = {}) {
    this.options = { ...DEFAULT_ORBIT_SETTINGS, ...initialOptions };
    this.mutator = null;
    this.listeners = new Set();
  }

  getOptions() {
    return { ...this.options };
  }

  updateOptions(updates = {}, notifyMutator = true) {
    if (!updates || typeof updates !== "object") return;
    this.options = { ...this.options, ...updates };

    if (notifyMutator && typeof this.mutator === "function") {
      try {
        this.mutator(updates);
      } catch {}
    }

    for (const listener of this.listeners) {
      try {
        listener(this.getOptions());
      } catch {}
    }
  }

  setSettingsMutator(mutator) {
    this.mutator = typeof mutator === "function" ? mutator : null;
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Binds OrbitSettingsStore to the DSH settings service if available in Cordis context.
 *
 * @param {object} ctx - Cordis application context
 * @param {OrbitSettingsStore} store - Orbit settings store instance
 * @returns {object|null} - Bound settings scope or null
 */
export function bindDshSettings(ctx, store) {
  try {
    const settingsService = typeof ctx?.get === "function" ? ctx.get("settings") : ctx?.settings;
    if (!settingsService?.register) {
      return null;
    }

    const scope = settingsService.register(ORBIT_SETTINGS_NAMESPACE, undefined, {
      base: store.getOptions(),
    });

    if (scope) {
      // 1. Initial read: synchronize state from ~/.dsh/settings.yaml
      const initialVal = scope.get?.();
      if (initialVal && typeof initialVal === "object") {
        store.updateOptions(initialVal, false);
      }

      // 2. Watch external mutations: re-read when file or other plugins change it
      scope.watch?.(() => {
        const updated = scope.get?.();
        if (updated && typeof updated === "object") {
          store.updateOptions(updated, false);
        }
      });

      // 3. Reverse writeback hook: when Orbit modifies options, mutate ~/.dsh/settings.yaml
      store.setSettingsMutator((patch) => {
        try {
          const ops = Object.entries(patch).map(([field, value]) => ({
            op: "set",
            path: [field],
            value,
          }));
          settingsService.mutate?.(ORBIT_SETTINGS_NAMESPACE, ops);
        } catch (err) {
          ctx.logger?.warn?.(`[dsh-orbit] Failed to mutate settings namespace: ${err.message}`);
        }
      });

      return scope;
    }
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-orbit] Error binding DSH settings service: ${err.message}`);
  }
  return null;
}
