import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionCap } from "../src/remediate/cap.js";
import { ApprovalGate } from "../src/remediate/approvals.js";

describe("action cap", () => {
  it("allows up to the maximum inside the window and frees capacity afterwards", () => {
    let now = 0;
    const cap = new ActionCap(2, 1000, () => now);
    expect(cap.available()).toBe(true);
    cap.record();
    cap.record();
    expect(cap.available()).toBe(false);
    now = 1001;
    expect(cap.available()).toBe(true);
    expect(cap.status().used).toBe(0);
  });
});

describe("approval gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the decision made through the API", async () => {
    const gate = new ApprovalGate(60_000);
    const request = gate.request("attempt-1");
    expect(gate.pending()).toEqual(["attempt-1"]);
    expect(gate.decide("attempt-1", "approve")).toBe(true);
    await expect(request).resolves.toBe("approve");
    expect(gate.pending()).toEqual([]);
  });

  it("refuses decisions for unknown approvals", () => {
    const gate = new ApprovalGate(60_000);
    expect(gate.decide("missing", "reject")).toBe(false);
  });

  it("times out when nobody decides", async () => {
    vi.useFakeTimers();
    const gate = new ApprovalGate(15 * 60_000);
    const request = gate.request("attempt-2");
    vi.advanceTimersByTime(15 * 60_000);
    await expect(request).resolves.toBe("timeout");
  });
});
