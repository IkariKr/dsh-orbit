// Zero-dependency standard 5-field cron parser and interval scheduler helper (RFC-0015 D2)
// Evaluates 5-field cron syntax: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-7, 0/7=Sun)
// All timestamps are strictly UTC ISO-8601 to eliminate timezone ambiguity.

export class ScheduleParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScheduleParseError";
    this.code = code;
  }
}

/**
 * Parses a single cron field and returns a sorted Set of matched integer values.
 */
function parseCronField(fieldStr, min, max, allowSunday7 = false) {
  if (typeof fieldStr !== "string" || fieldStr.trim() === "") {
    throw new ScheduleParseError("invalid-cron-field", `empty cron field`);
  }
  const str = fieldStr.trim();
  const values = new Set();

  const parts = str.split(",");
  for (const part of parts) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    // Step: */15 or 10-30/5
    const stepParts = part.split("/");
    if (stepParts.length > 2) {
      throw new ScheduleParseError("invalid-cron-step", `invalid step expression: ${part}`);
    }
    const rangePart = stepParts[0];
    let step = 1;
    if (stepParts.length === 2) {
      step = Number(stepParts[1]);
      if (!Number.isInteger(step) || step <= 0) {
        throw new ScheduleParseError("invalid-cron-step", `step must be a positive integer: ${stepParts[1]}`);
      }
    }

    let rangeStart = min;
    let rangeEnd = max;

    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length > 2 || bounds.some((b) => b.trim() === "")) {
        throw new ScheduleParseError("invalid-cron-range", `invalid range expression: ${rangePart}`);
      }
      if (bounds.length === 2) {
        rangeStart = Number(bounds[0]);
        rangeEnd = Number(bounds[1]);
      } else {
        rangeStart = Number(bounds[0]);
        rangeEnd = stepParts.length === 2 ? max : rangeStart;
      }

      if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) {
        throw new ScheduleParseError("invalid-cron-number", `cron field values must be integers: ${rangePart}`);
      }
    }

    if (rangeStart < min || rangeEnd > (allowSunday7 ? max + 1 : max) || rangeStart > rangeEnd) {
      throw new ScheduleParseError(
        "invalid-cron-bounds",
        `cron values out of bounds [${min}, ${max}]: ${rangePart}`,
      );
    }

    for (let val = rangeStart; val <= rangeEnd; val += step) {
      let v = val;
      if (allowSunday7 && v === 7) v = 0; // standard 7 is Sunday (0)
      if (v >= min && v <= max) {
        values.add(v);
      }
    }
  }

  if (values.size === 0) {
    throw new ScheduleParseError("invalid-cron-field", `no valid values parsed for field: ${fieldStr}`);
  }

  return values;
}

/**
 * Validates a 5-field cron expression string and returns parsed field sets.
 */
export function parseCronExpression(cronStr) {
  if (typeof cronStr !== "string") {
    throw new ScheduleParseError("invalid-cron-expression", "cron expression must be a string");
  }
  const trimmed = cronStr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleParseError(
      "invalid-cron-fields-count",
      `cron expression must contain exactly 5 whitespace-separated fields, got ${fields.length}`,
    );
  }

  const [minStr, hourStr, domStr, monthStr, dowStr] = fields;

  const minutes = parseCronField(minStr, 0, 59);
  const hours = parseCronField(hourStr, 0, 23);
  const doms = parseCronField(domStr, 1, 31);
  const months = parseCronField(monthStr, 1, 12);
  const dows = parseCronField(dowStr, 0, 6, true);

  return {
    raw: trimmed,
    minutes,
    hours,
    doms,
    months,
    dows,
  };
}

/**
 * Calculates the next UTC occurrence timestamp strictly greater than `fromDate`.
 * Search window bounded to 5 years (prevent infinite loops on impossible dates like Feb 30).
 */
export function getNextCronOccurrence(parsedCron, fromDate = new Date()) {
  const startMs = fromDate instanceof Date ? fromDate.getTime() : new Date(fromDate).getTime();
  if (isNaN(startMs)) {
    throw new ScheduleParseError("invalid-date", "invalid fromDate for cron calculation");
  }

  // Advance by 1 minute to ensure nextRunAt is strictly greater than fromDate
  const current = new Date(startMs);
  current.setUTCSeconds(0, 0);
  current.setUTCMinutes(current.getUTCMinutes() + 1);

  const maxSearchYear = current.getUTCFullYear() + 5;

  while (current.getUTCFullYear() <= maxSearchYear) {
    const month = current.getUTCMonth() + 1; // 1-12
    if (!parsedCron.months.has(month)) {
      current.setUTCMonth(current.getUTCMonth() + 1, 1);
      current.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = current.getUTCDate(); // 1-31
    const dow = current.getUTCDay(); // 0-6

    if (!parsedCron.doms.has(dom) || !parsedCron.dows.has(dow)) {
      current.setUTCDate(current.getUTCDate() + 1);
      current.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hour = current.getUTCHours(); // 0-23
    if (!parsedCron.hours.has(hour)) {
      current.setUTCHours(current.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = current.getUTCMinutes(); // 0-59
    if (!parsedCron.minutes.has(minute)) {
      current.setUTCMinutes(current.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return current.toISOString();
  }

  throw new ScheduleParseError("cron-unreachable", `no valid cron execution found within 5-year window`);
}

/**
 * Calculates next occurrence for interval-based schedule.
 */
export function getNextIntervalOccurrence(intervalMs, fromDate = new Date()) {
  const startMs = fromDate instanceof Date ? fromDate.getTime() : new Date(fromDate).getTime();
  if (isNaN(startMs)) {
    throw new ScheduleParseError("invalid-date", "invalid fromDate for interval calculation");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new ScheduleParseError("invalid-interval", "intervalMs must be an integer >= 1000");
  }
  return new Date(startMs + intervalMs).toISOString();
}

/**
 * Evaluates next run timestamp based on schedule definition.
 */
export function calculateNextRunAt(schedule, fromDate = new Date()) {
  if (schedule.scheduleType === "cron") {
    const parsed = parseCronExpression(schedule.cronExpression);
    return getNextCronOccurrence(parsed, fromDate);
  }
  if (schedule.scheduleType === "interval") {
    return getNextIntervalOccurrence(schedule.intervalMs, fromDate);
  }
  if (schedule.scheduleType === "once") {
    // If once, return null or fixed nextRunAt if not yet dispatched
    return null;
  }
  throw new ScheduleParseError("invalid-schedule-type", `unknown scheduleType: ${schedule.scheduleType}`);
}
