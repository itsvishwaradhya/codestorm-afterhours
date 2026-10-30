import { describe, expect, it } from "vitest";
import type { Attempt, AttemptStatus, AuditEntry, Incident, IncidentState, Risk } from "@nightshift/shared";
import { guardrailSavings } from "../src/report/guardrails.js";

const T0 = Date.parse("2026-10-30T06:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function healed(id: string, start: number, fixLiveAfter: number, symptoms: Incident["symptoms"] = []): Incident {
  return {
    id,
    state: "resolved",
    rootCause: "payments",
    symptoms,
    causes: [],
    anomalies: [{ service: "payments", kind: "unreachable", value: 0, threshold: 1, since: at(start) }],
    failure: "crash",
    pendingApprovalId: null,
    stateHistory: (
      [
        ["detected", start],
        ["verifying", start + 1],
        ["watching", start + fixLiveAfter],
        ["resolved", start + fixLiveAfter + 60],
      ] as [IncidentState, number][]
    ).map(([state, seconds]) => ({ state, at: at(seconds) })),
    openedAt: at(start),
    closedAt: at(start + fixLiveAfter + 60),
    outcome: "fixed by Restart process",
  };
}

function escalated(id: string, symptoms: Incident["symptoms"]): Incident {
  return { ...healed(id, 0, 10, symptoms), state: "escalated", stateHistory: [], rootCause: "payments" };
}

function attempt(status: AttemptStatus, risk: Risk = "low"): Attempt {
  return {
    id: `${status}-${risk}`,
    incidentId: "incident-1",
    candidate: "restart",
    label: "Restart process",
    risk,
    verdict: status === "rejected" ? "reject" : "promote",
    reasons: [],
    baseline: { requests: 50, errorRate: 0.5, p95LatencyMs: 10 },
    candidateMetrics: { requests: 50, errorRate: 0, p95LatencyMs: 10 },
    sampleSize: 50,
    status,
    startedAt: at(0),
    endedAt: at(1),
  };
}

function suppressed(incidentId: string | null): AuditEntry {
  return { id: `audit-${incidentId}`, at: at(0), actor: "healer", action: "action.suppressed", trigger: "", incidentId, details: {} };
}

describe("guardrail savings", () => {
  it("is all zero with no history", () => {
    expect(guardrailSavings({ incidents: [], attempts: [], suppressed: [] })).toEqual({
      symptomRestartsAvoided: 0,
      unprovenFixesBlocked: 0,
      riskyFixesHeld: 0,
      restartStormsStopped: 0,
      badFixesRolledBack: 0,
      timeToFix: { count: 0, medianSeconds: null, fastestSeconds: null, lastSeconds: null },
    });
  });

  it("counts symptom services a blind restart would have hit", () => {
    const result = guardrailSavings({
      incidents: [healed("a", 0, 10, ["orders"]), escalated("b", ["orders", "inventory"]), { ...escalated("c", ["orders"]), rootCause: null }],
      attempts: [],
      suppressed: [],
    });
    expect(result.symptomRestartsAvoided).toBe(3);
  });

  it("counts blocked, held and rolled-back fixes", () => {
    const result = guardrailSavings({
      incidents: [],
      attempts: [
        attempt("rejected"),
        attempt("rejected"),
        attempt("verified", "medium"),
        attempt("rejected", "medium"),
        attempt("awaiting_approval", "medium"),
        attempt("kept", "medium"),
        attempt("declined", "high"),
        attempt("kept"),
        attempt("rolled_back"),
      ],
      suppressed: [],
    });
    expect(result.unprovenFixesBlocked).toBe(3);
    expect(result.riskyFixesHeld).toBe(3);
    expect(result.badFixesRolledBack).toBe(1);
  });

  it("counts each incident with suppressed actions once", () => {
    const result = guardrailSavings({
      incidents: [],
      attempts: [],
      suppressed: [suppressed("a"), suppressed("a"), suppressed("b"), suppressed(null)],
    });
    expect(result.restartStormsStopped).toBe(2);
  });

  it("reports median, fastest and most recent time to fix", () => {
    const odd = guardrailSavings({
      incidents: [healed("c", 200, 30), healed("a", 0, 12), healed("b", 100, 20), escalated("d", [])],
      attempts: [],
      suppressed: [],
    });
    expect(odd.timeToFix).toEqual({ count: 3, medianSeconds: 20, fastestSeconds: 12, lastSeconds: 30 });

    const even = guardrailSavings({ incidents: [healed("a", 0, 12), healed("b", 100, 15)], attempts: [], suppressed: [] });
    expect(even.timeToFix.medianSeconds).toBe(13.5);
  });
});
