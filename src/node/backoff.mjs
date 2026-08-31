// Heartbeat failure backoff (SOP Stage 3): exponential backoff with
// jitter, capped, reset on success. Deterministic for tests (now and
// random injectable).

export const BACKOFF_INITIAL_MS = 1000;
export const BACKOFF_MAX_MS = 60 * 1000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_JITTER_RATIO = 0.2; // +/- 20%

export class HeartbeatBackoff {
  constructor({ now = () => Date.now(), random = Math.random, initialMs = BACKOFF_INITIAL_MS, maxMs = BACKOFF_MAX_MS } = {}) {
    this.now = now;
    this.random = random;
    this.initialMs = initialMs;
    this.maxMs = maxMs;
    this.attempt = 0;
    this.nextAttemptAt = 0;
    this.lastDelayMs = 0;
  }

  // Records a failure and returns the delay for the NEXT attempt.
  recordFailure() {
    const base = Math.min(this.initialMs * BACKOFF_FACTOR ** this.attempt, this.maxMs);
    const jitter = (this.random() * 2 - 1) * BACKOFF_JITTER_RATIO * base;
    const delay = Math.max(0, Math.round(base + jitter));
    this.attempt += 1;
    this.lastDelayMs = delay;
    this.nextAttemptAt = this.now() + delay;
    return delay;
  }

  recordSuccess() {
    this.attempt = 0;
    this.nextAttemptAt = 0;
    this.lastDelayMs = 0;
  }

  // The attempt is due when the backoff window has elapsed.
  due(nowMs = this.now()) {
    return nowMs >= this.nextAttemptAt;
  }
}