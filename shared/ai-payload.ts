export const ROOT_METRICS = ["currentCashCents", "spentThisMonthCents", "remainingIncomeCents", "remainingExpensesCents", "protectedReservesCents", "projectedMonthEndCents", "availableToSpendCents"] as const;
export const PROJECTION_METRICS = ["expectedIncomeCents", "committedExpensesCents", "protectedReservesCents", "projectedMonthEndCents", "availableToSpendCents"] as const;
export type RootMetric = typeof ROOT_METRICS[number];
export type ProjectionMetric = typeof PROJECTION_METRICS[number];

function fail(): never { throw new Error("Invalid redacted AI payload"); }

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail();
  }
  return value as Record<string, unknown>;
}

function validMonth(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Shared egress boundary: preserve exact approved bytes, reject rather than strip. */
export function serializeRedactedSnapshot(value: unknown): string {
  const header = record(value, ["schemaVersion", "currency", "asOfMonth"], ["valueOrigin", ...ROOT_METRICS, "projectionMonths"]);
  const edited = header.schemaVersion === 2;
  if ((!edited && header.schemaVersion !== 1) || header.currency !== "EUR" || !validMonth(header.asOfMonth)) fail();
  const snapshot = edited
    ? record(value, ["schemaVersion", "valueOrigin", "currency", "asOfMonth"], [...ROOT_METRICS, "projectionMonths"])
    : record(value, ["schemaVersion", "currency", "asOfMonth", ...ROOT_METRICS, "projectionMonths"]);
  if (edited && snapshot.valueOrigin !== "user_edited") fail();
  for (const key of ROOT_METRICS) if ((!edited || Object.hasOwn(snapshot, key)) && !Number.isSafeInteger(snapshot[key])) fail();
  if (Object.hasOwn(snapshot, "projectionMonths")) {
    const months = snapshot.projectionMonths;
    if (!Array.isArray(months) || Object.getPrototypeOf(months) !== Array.prototype || months.length > 120) fail();
    const keys = Reflect.ownKeys(months);
    if (keys.length !== months.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= months.length))) fail();
    for (let index = 0; index < months.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(months, String(index));
      if (!descriptor || !("value" in descriptor)) fail();
      const projection = edited ? record(descriptor.value, ["month"], PROJECTION_METRICS) : record(descriptor.value, ["month", ...PROJECTION_METRICS]);
      if (!validMonth(projection.month)) fail();
      for (const key of PROJECTION_METRICS) if ((!edited || Object.hasOwn(projection, key)) && !Number.isSafeInteger(projection[key])) fail();
    }
  }
  return JSON.stringify(snapshot);
}
