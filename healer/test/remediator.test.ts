import { describe, expect, it } from "vitest";
import type { Attempt, Incident, IncidentState } from "@nightshift/shared";
import {
  APPLY_STALE_SNAPSHOT,
  REVERT_CONFIG,
  RESET_DEFAULTS,
  RESTART,
  type FixCandidate,
} from "../src/fix/catalog.js";
import { ApprovalGate } from "../src/remediate/approvals.js";
import { ActionCap } from "../src/remediate/cap.js";
import { Remediator, type RemediatorDeps } from "../src/remediate/remediator.js";
import { watchService } from "../src/remediate/watch.js";

type Verdict = Attempt["verdict"];

function incident(): Incident {
  return {
    id: "incident-1",
    state: "diagnosed",
    rootCause: "payments",
    symptoms: ["orders"],
    causes: [],
    anomalies: [
      { service: "payments", kind: "unhealthy", value: 0, threshold: 1, since: "2026-10-30T10:00:00.000Z" },
    ],
    failure: null,
    pendingApprovalId: null,
    stateHistory: [{ state: "diagnosed", at: "2026-10-30T10:00:00.000Z" }],
    openedAt: "2026-10-30T10:00:00.000Z",
    closedAt: null,
    outcome: null,
  };
}

interface Harness {
  deps: RemediatorDeps;
  applied: string[];
  restored: string[];
  states: IncidentState[];
  audits: string[];
  gate: ApprovalGate;
  clock: { now: number };
}

function harness(options: {
  verdicts: Partial<Record<string, Verdict>>;
  watch?: "ok" | "regressed";
  approvalTimeoutMs?: number;
  cap?: ActionCap;
  clock?: { now: number };
  candidates?: FixCandidate[];
}): Harness {
  const applied: string[] = [];
  const restored: string[] = [];
  const states: IncidentState[] = [];
  const audits: string[] = [];
  const clock = options.clock ?? { now: 0 };
  const gate = new ApprovalGate(options.approvalTimeoutMs ?? 60_000);
  const cap = options.cap ?? new ActionCap(3, 600_000, () => clock.now);

  const deps: RemediatorDeps = {
    plan: () => ({ failure: "bad_config", candidates: options.candidates ?? [REVERT_CONFIG, APPLY_STALE_SNAPSHOT, RESET_DEFAULTS] }),
    verify: async (_incident, candidate) => ({
      id: `attempt-${candidate.id}`,
      incidentId: "incident-1",
      candidate: candidate.id,
      label: candidate.label,
      risk: candidate.risk,
      verdict: options.verdicts[candidate.id] ?? "reject",
      reasons: [],
      baseline: { requests: 100, errorRate: 0.5, p95LatencyMs: 20 },
      candidateMetrics: { requests: 100, errorRate: 0, p95LatencyMs: 10 },
      sampleSize: 100,
      status: "verified",
      startedAt: "2026-10-30T10:00:00.000Z",
      endedAt: "2026-10-30T10:00:01.000Z",
    }),
    saveAttempt: async () => {},
    captureState: async () => ({ activeFault: "bad_config", configMode: "corrupt" }),
    restoreState: async (_service, state) => {
      restored.push(state.configMode);
    },
    applyToProduction: async (_incident, candidate) => {
      applied.push(candidate.id);
    },
    watch: async () => options.watch ?? "ok",
    approvals: gate,
    cap,
    persist: async (current) => {
      states.push(current.state);
    },
    audit: async (action) => {
      audits.push(action);
    },
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => new Date(clock.now),
    capacityPollMs: 1000,
    capacityWaitMs: 900_000,
  };
  return { deps, applied, restored, states, audits, gate, clock };
}

async function waitForPending(gate: ApprovalGate): Promise<string> {
  while (gate.pending().length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return gate.pending()[0];
}

describe("remediator", () => {
  it("applies the first promoted low-risk fix and resolves when it holds", async () => {
    const h = harness({ verdicts: { revert_config: "promote" } });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(h.applied).toEqual(["revert_config"]);
    expect(current.state).toBe("resolved");
    expect(current.outcome).toMatch(/fixed by/);
  });

  it("never applies the decoy even when verification says promote", async () => {
    const h = harness({ verdicts: { revert_config: "reject", apply_stale_snapshot: "promote", reset_defaults: "reject" } });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(h.applied).toEqual([]);
    expect(current.state).toBe("escalated");
  });

  it("waits for approval on a medium-risk fix and applies it when approved", async () => {
    const h = harness({ verdicts: { revert_config: "reject", apply_stale_snapshot: "reject", reset_defaults: "promote" } });
    const current = incident();
    const run = new Remediator(h.deps).run(current);
    const id = await waitForPending(h.gate);
    expect(current.state).toBe("awaiting_approval");
    expect(h.gate.decide(id, "approve")).toBe(true);
    await run;
    expect(h.applied).toEqual(["reset_defaults"]);
    expect(current.state).toBe("resolved");
  });

  it("does not apply a medium-risk fix that was declined", async () => {
    const h = harness({ verdicts: { reset_defaults: "promote" }, candidates: [RESET_DEFAULTS] });
    const current = incident();
    const run = new Remediator(h.deps).run(current);
    const id = await waitForPending(h.gate);
    h.gate.decide(id, "reject");
    await run;
    expect(h.applied).toEqual([]);
    expect(current.state).toBe("escalated");
  });

  it("escalates when approval times out", async () => {
    const h = harness({
      verdicts: { reset_defaults: "promote" },
      candidates: [RESET_DEFAULTS],
      approvalTimeoutMs: 10,
    });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(h.applied).toEqual([]);
    expect(current.outcome).toMatch(/timed out/);
  });

  it("queues a fix while the action cap is full and applies it when capacity frees", async () => {
    const clock = { now: 0 };
    const cap = new ActionCap(1, 600_000, () => clock.now);
    cap.record();
    const h = harness({ verdicts: { revert_config: "promote" }, cap, clock });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(current.stateHistory.map((entry) => entry.state)).toContain("rate_limited");
    expect(h.applied).toEqual(["revert_config"]);
    expect(current.state).toBe("resolved");
  });

  it("rolls back and escalates when the watch shows a regression", async () => {
    const h = harness({ verdicts: { revert_config: "promote" }, watch: "regressed" });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(h.applied).toEqual(["revert_config"]);
    expect(h.restored).toEqual(["corrupt"]);
    expect(current.state).toBe("escalated");
    expect(current.outcome).toMatch(/rolled back/);
  });

  it("escalates when no candidate is verified", async () => {
    const h = harness({ verdicts: {} });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(h.applied).toEqual([]);
    expect(current.outcome).toMatch(/no candidate fix was verified/);
  });

  it("escalates immediately when the failure is not recognized", async () => {
    const h = harness({ verdicts: {} });
    h.deps.plan = () => ({ failure: null, candidates: [] });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(current.state).toBe("escalated");
    expect(current.outcome).toMatch(/not recognized/);
  });

  it("uses the restart candidate for crashes without touching configuration", async () => {
    const h = harness({ verdicts: { restart: "promote" }, candidates: [RESTART] });
    h.deps.plan = () => ({ failure: "crash", candidates: [RESTART] });
    const current = incident();
    await new Remediator(h.deps).run(current);
    expect(h.applied).toEqual(["restart"]);
    expect(current.state).toBe("resolved");
  });
});

describe("watch", () => {
  const options = {
    preFixErrorRate: 0.5,
    durationMs: 10_000,
    intervalMs: 1000,
    minRequests: 5,
    minErrorRate: 0.05,
    consecutive: 3,
  };

  it("reports ok when production stays healthy", async () => {
    const reads = [
      { requests: 0, errors: 0, healthy: true },
      { requests: 20, errors: 0, healthy: true },
      { requests: 40, errors: 1, healthy: true },
    ];
    let index = 0;
    const result = await watchService({
      ...options,
      readTotals: async () => reads[Math.min(index++, reads.length - 1)],
      sleep: async () => {},
    });
    expect(result).toBe("ok");
  });

  it("reports regressed after consecutive bad checks", async () => {
    let requests = 0;
    let errors = 0;
    const result = await watchService({
      ...options,
      readTotals: async () => {
        requests += 10;
        errors += 8;
        return { requests, errors, healthy: true };
      },
      sleep: async () => {},
    });
    expect(result).toBe("regressed");
  });

  it("reports regressed when the service stops answering", async () => {
    const result = await watchService({
      ...options,
      readTotals: async () => null,
      sleep: async () => {},
    });
    expect(result).toBe("regressed");
  });
});
