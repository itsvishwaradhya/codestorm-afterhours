import { describe, expect, it } from "vitest";
import type { Attempt, Incident } from "@nightshift/shared";
import { rewordReceipt, type LlmProvider } from "../src/receipt/chain.js";
import { buildFacts } from "../src/receipt/facts.js";
import { draftReceipt } from "../src/receipt/template.js";
import { validateRewording } from "../src/receipt/validate.js";

const draft = "What broke: payments was running with a corrupt configuration.\nOutcome: fixed by Revert config. Duration: 12 seconds.";

describe("LLM rewording validation", () => {
  it("accepts a rewording that keeps the numbers and names", () => {
    const result = validateRewording(draft, "Payments was running with a corrupt configuration. Outcome: fixed by Revert config. Duration: 12 seconds.");
    expect(result.ok).toBe(true);
  });

  it("rejects a reply that introduces a number not in the facts", () => {
    const result = validateRewording(draft, "Payments failed for 30 seconds before the fix.");
    expect(result.ok).toBe(false);
  });

  it("rejects a reply that names a service not in the facts", () => {
    const result = validateRewording(draft, "Payments and inventory were both corrupt.");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty reply", () => {
    expect(validateRewording(draft, "   ").ok).toBe(false);
  });
});

describe("LLM provider chain", () => {
  const facts = buildFacts(incident(), []);

  function provider(id: string, reply: () => Promise<string>): LlmProvider {
    return { id, complete: () => reply() };
  }

  it("falls through to the next provider when one returns a rejected reply", async () => {
    const result = await rewordReceipt(facts, draft, [
      provider("groq", async () => "Payments failed for 99 seconds."),
      provider("gemini", async () => "Payments was running with a corrupt configuration. Duration: 12 seconds."),
    ], { perProviderMs: 1000, totalMs: 2000 });
    expect(result.wordedBy).toBe("gemini");
  });

  it("uses the template when every provider fails", async () => {
    const result = await rewordReceipt(facts, draft, [
      provider("groq", async () => {
        throw new Error("HTTP 429");
      }),
    ], { perProviderMs: 1000, totalMs: 2000 });
    expect(result).toEqual({ text: draft, wordedBy: "template" });
  });

  it("gives up on a hanging provider within the per-provider budget", async () => {
    const started = Date.now();
    const result = await rewordReceipt(facts, draft, [
      {
        id: "openrouter",
        complete: (_system, _user, signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    ], { perProviderMs: 50, totalMs: 500 });
    expect(result.wordedBy).toBe("template");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("uses the template without calling anything when there are no providers", async () => {
    const result = await rewordReceipt(facts, draft, [], { perProviderMs: 1000, totalMs: 2000 });
    expect(result.wordedBy).toBe("template");
  });
});

describe("template receipt", () => {
  it("names the cause, the symptoms, the fix tried, the numbers and the outcome", () => {
    const attempt: Attempt = {
      id: "attempt-1",
      incidentId: "incident-1",
      candidate: "revert_config",
      label: "Revert config to last known good",
      risk: "low",
      verdict: "promote",
      reasons: ["error rate 0.0% against baseline 6.0%"],
      baseline: { requests: 80, errorRate: 0.06, p95LatencyMs: 1 },
      candidateMetrics: { requests: 86, errorRate: 0, p95LatencyMs: 12 },
      sampleSize: 86,
      status: "kept",
      startedAt: "2026-10-30T06:35:11.900Z",
      endedAt: "2026-10-30T06:35:13.000Z",
      prodAfter: { requests: 40, errorRate: 0.025, p95LatencyMs: 9 },
      actionDowntimeMs: 0,
      impact: "helped",
      impactReasons: ["error rate 6.0% -> 2.5%"],
    };
    const text = draftReceipt(buildFacts(incident(), [attempt]));
    expect(text).toContain("payments");
    expect(text).toContain("orders");
    expect(text).toContain("Revert config to last known good");
    expect(text).toContain("Before the fix: error rate 6.0%");
    expect(text).toContain("After the fix (production): error rate 2.5%");
    expect(text).toContain("Did the action help: helped");
    expect(text).toContain("Outcome: fixed by Revert config to last known good");
  });

  it("does not report shadow numbers as the production result", () => {
    const attempt: Attempt = {
      id: "attempt-1",
      incidentId: "incident-1",
      candidate: "revert_config",
      label: "Revert config to last known good",
      risk: "low",
      verdict: "promote",
      reasons: [],
      baseline: { requests: 80, errorRate: 0.06, p95LatencyMs: 1 },
      candidateMetrics: { requests: 86, errorRate: 0, p95LatencyMs: 12 },
      sampleSize: 86,
      status: "kept",
      startedAt: "2026-10-30T06:35:11.900Z",
      endedAt: "2026-10-30T06:35:13.000Z",
    };
    expect(buildFacts(incident(), [attempt]).after).toBeNull();
  });

  it("says how fast it healed when a kept fix resolved the incident", () => {
    const healedIncident: Incident = {
      ...incident(),
      stateHistory: [
        { state: "detected", at: "2026-10-30T06:35:11.000Z" },
        { state: "verifying", at: "2026-10-30T06:35:13.000Z" },
        { state: "watching", at: "2026-10-30T06:35:20.000Z" },
        { state: "resolved", at: "2026-10-30T06:36:20.000Z" },
      ],
      anomalies: [{ service: "payments", kind: "unhealthy", value: 0, threshold: 1, since: "2026-10-30T06:35:09.000Z" }],
    };
    const text = draftReceipt(buildFacts(healedIncident, [keptAttempt()]));
    expect(text).toContain("Healed in 11 s from the first bad sample: detected in 2 s");
    expect(text).toContain("No human was paged.");
    expect(validateRewording(text, "Healed in 11 s; detected in 2 s, no human was paged.").ok).toBe(true);
  });

  it("does not claim a heal for an escalated incident", () => {
    const failed: Incident = {
      ...incident(),
      state: "escalated",
      stateHistory: [
        { state: "detected", at: "2026-10-30T06:35:11.000Z" },
        { state: "watching", at: "2026-10-30T06:35:20.000Z" },
        { state: "escalated", at: "2026-10-30T06:36:20.000Z" },
      ],
    };
    const text = draftReceipt(buildFacts(failed, [{ ...keptAttempt(), status: "rolled_back" }]));
    expect(text).not.toContain("Healed in");
    expect(text).not.toContain("No human was paged");
  });

  it("explains a gray failure and a recurrence", () => {
    const gray: Incident = {
      ...incident(),
      failure: "gray",
      anomalies: [{ service: "payments", kind: "gray", value: 0.2, threshold: 0.05, since: "2026-10-30T06:35:11.000Z" }],
      recurrenceOf: "abcdef12-0000",
    };
    const text = draftReceipt(buildFacts(gray, []));
    expect(text).toContain("payments kept passing its health check while 20.0% of requests failed or ran slow");
    expect(text).toContain("came back after an earlier fix (incident abcdef12)");
  });
});

function keptAttempt(): Attempt {
  return {
    id: "attempt-1",
    incidentId: "incident-1",
    candidate: "revert_config",
    label: "Revert config to last known good",
    risk: "low",
    verdict: "promote",
    reasons: [],
    baseline: { requests: 80, errorRate: 0.06, p95LatencyMs: 1 },
    candidateMetrics: { requests: 86, errorRate: 0, p95LatencyMs: 12 },
    sampleSize: 86,
    status: "kept",
    startedAt: "2026-10-30T06:35:13.000Z",
    endedAt: "2026-10-30T06:35:19.000Z",
  };
}

function incident(): Incident {
  return {
    id: "incident-1",
    state: "resolved",
    rootCause: "payments",
    symptoms: ["orders"],
    causes: [
      { service: "payments", explainedBy: null, reason: "payments is failing (unhealthy) and none of its dependencies are anomalous" },
      { service: "orders", explainedBy: "payments", reason: "orders is failing (error_rate), likely caused by payments" },
    ],
    anomalies: [
      { service: "payments", kind: "unhealthy", value: 0, threshold: 1, since: "2026-10-30T06:35:11.000Z" },
    ],
    failure: "bad_config",
    pendingApprovalId: null,
    stateHistory: [],
    openedAt: "2026-10-30T06:35:11.000Z",
    closedAt: "2026-10-30T06:35:23.000Z",
    outcome: "fixed by Revert config to last known good",
  };
}
