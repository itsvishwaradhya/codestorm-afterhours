import { describe, expect, it } from "vitest";
import { MASKED, maskDeep, maskHeaders } from "@nightshift/shared";

describe("capture masking", () => {
  it("replaces sensitive string fields with the placeholder", () => {
    const masked = maskDeep({ cardNumber: "4242 4242 4242 4242", email: "a@example.test", item: "keyboard" });
    expect(masked).toEqual({ cardNumber: MASKED, email: MASKED, item: "keyboard" });
  });

  it("keeps the JSON type of sensitive numeric and boolean fields", () => {
    const masked = maskDeep({ cvv: 123, token: true, quantity: 2 }) as Record<string, unknown>;
    expect(typeof masked.cvv).toBe("number");
    expect(typeof masked.token).toBe("boolean");
    expect(masked.quantity).toBe(2);
  });

  it("masks sensitive fields inside nested objects and arrays", () => {
    const masked = maskDeep({ payer: { password: "hunter2" }, cards: [{ cardNumber: "4111" }] });
    expect(masked).toEqual({ payer: { password: MASKED }, cards: [{ cardNumber: MASKED }] });
  });

  it("masks sensitive headers and keeps the rest", () => {
    const headers = maskHeaders({ authorization: "Bearer abc", cookie: "session=1", "content-type": "application/json" });
    expect(headers).toEqual({ authorization: MASKED, cookie: MASKED, "content-type": "application/json" });
  });
});
