import { describe, expect, it } from "vitest";
import { centsField, dateField, exactStringField, objectBody, uuidField, ValidationError } from "../server/validation.ts";

describe("request validation errors", () => {
  it.each([
    () => objectBody(null),
    () => centsField({ amountCents: 0 }),
    () => centsField({ amountCents: 1.5 }),
    () => dateField({ date: "2026-02-30" }, "date"),
    () => uuidField("------------------------------------"),
    () => exactStringField({}, "confirmation"),
    () => exactStringField({ confirmation: 123 }, "confirmation"),
    () => exactStringField({ confirmation: "REMOVE_DEMO_DATA" }, "confirmation", 4),
  ])("uses an actionable HTTP 400 error", (validate) => {
    expect(validate).toThrow(ValidationError);
    try {
      validate();
    } catch (error) {
      expect((error as ValidationError).status).toBe(400);
      expect((error as Error).message.length).toBeGreaterThan(0);
    }
  });
});
