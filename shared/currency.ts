/** Currency is stored explicitly; no exchange-rate or minor-unit conversion is implied. */
export const DEFAULT_CURRENCY = "EUR";

export class CurrencyError extends Error {
  readonly status = 422;
  constructor(message: string) { super(message); this.name = "CurrencyError"; }
}

export function assertCurrencyCode(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new CurrencyError("Currency must be a three-letter uppercase code");
  }
}

/** The current web product accepts EUR only. Reject, never relabel, other money. */
export function assertSupportedCurrency(value: unknown): asserts value is typeof DEFAULT_CURRENCY {
  assertCurrencyCode(value);
  if (value !== DEFAULT_CURRENCY) throw new CurrencyError("Only EUR is supported; currency conversion is unavailable");
}

/** All operands must have the requested denomination, including zero amounts. */
export function assertSameCurrency(items: readonly { currency: string }[], currency = DEFAULT_CURRENCY): void {
  assertCurrencyCode(currency);
  for (const item of items) {
    assertCurrencyCode(item.currency);
    if (item.currency !== currency) throw new CurrencyError("Mixed-currency calculations are unsupported; no conversion was performed");
  }
}
