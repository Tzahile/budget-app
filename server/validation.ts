import { assertDateOnly } from "../shared/finance.ts";

export class ValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function uuidField(value: string, key = "id"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${key} must be a UUID`);
  }
  return value;
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("A JSON object is required");
  return value as Record<string, unknown>;
}

export function stringField(body: Record<string, unknown>, key: string, max = 120): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${key} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new ValidationError(`${key} is too long`);
  return normalized;
}

export function exactStringField(body: Record<string, unknown>, key: string, max = 120): string {
  const value = body[key];
  if (typeof value !== "string" || !value) throw new ValidationError(`${key} is required`);
  if (value.length > max) throw new ValidationError(`${key} is too long`);
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string, max = 500): string | null {
  const value = body[key];
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new ValidationError(`${key} is invalid`);
  return value.trim();
}

export function enumField<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ValidationError(`${key} is invalid`);
  return value as T;
}

export function centsField(body: Record<string, unknown>, key = "amountCents", allowZero = false): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new ValidationError(`${key} must be a safe integer number of cents${allowZero ? "" : " greater than zero"}`);
  }
  return value as number;
}

export function signedCentsField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value)) throw new ValidationError(`${key} must be a safe integer number of cents`);
  return value as number;
}

export function integerField(body: Record<string, unknown>, key: string, min = 1): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new ValidationError(`${key} is invalid`);
  return value as number;
}

export function dateField(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key, 10);
  try {
    assertDateOnly(value);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : `${key} is invalid`);
  }
  return value;
}

export function booleanField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new ValidationError(`${key} is invalid`);
  return value;
}
