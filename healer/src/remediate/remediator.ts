import type {
  Attempt,
  FailureType,
  Incident,
  IncidentState,
  ServiceName,
  WindowMetrics,
} from "@nightshift/shared";
import type { FixCandidate } from "../fix/catalog.js";
import type { ProductionState } from "../fix/steps.js";
import type { ApprovalGate } from "./approvals.js";
import type { ActionCap } from "./cap.js";
import type { RemediationGuard } from "./guard.js";
import { assessImpact, type ImpactRules } from "./impact.js";

export interface RemediationPlan {
  failure: FailureType | null;
  candidates: FixCandidate[];
}

export interface RemediatorDeps {
  plan: (incident: Incident) => RemediationPlan;
  verify: (incident: Incident, candidate: FixCandidate) => Promise<Attempt>;
  saveAttempt: (attempt: Attempt) => Promise<void>;
  captureState: (service: ServiceName) => Promise<ProductionState | null>;
  restoreState: (service: ServiceName, state: ProductionState) => Promise<void>;
  // Resolves to the downtime the action caused in ms, when it causes any.
  applyToProduction: (incident: Incident, candidate: FixCandidate) => Promise<number | void>;
  watch: (service: ServiceName, baseline: WindowMetrics) => Promise<"ok" | "regressed">;
  readWindow: (service: ServiceName) => Promise<WindowMetrics | null>;
  reviseAttempt: (attemptId: string, patch: Pick<Attempt, "impact" | "impactReasons">) => Promise<void>;
  stillFailing: (service: ServiceName) => boolean;
  approvals: ApprovalGate;
  cap: ActionCap;
  guard: RemediationGuard;
  impactRules: ImpactRules;
  persist: (incident: Incident) => Promise<void>;
  audit: (action: string, incident: Incident, details: Record<string, unknown>) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  capacityPollMs: number;
  capacityWaitMs: number;
}

const TERMINAL: IncidentState[] = ["resolved", "escalated"];

export function isTerminal(state: IncidentState): boolean {
  return TERMINAL.includes(state);
}

export class Remediator {
  private busy = false;

  constructor(private readonly deps: RemediatorDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  async run(incident: Incident): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.execute(incident);
    } catch (error) {
      await this.escalate(incident, `remediation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async execute(incident: Incident): Promise<void> {
    const service = incident.rootCause;
    if (!service) {
      return this.escalate(incident, "no root cause identified");
    }

    const plan = this.deps.plan(incident);
    const failure = plan.failure;
    incident.failure = failure;
    if (!failure) {
      return this.escalate(incident, "failure type not recognized, human needed");
    }
    if (plan.candidates.length === 0) {
      return this.escalate(incident, `no allowed fix for ${failure}, human needed`);
    }

    await this.linkRecurrence(incident, service, failure);
    const gate = await this.passGuard(incident, service, failure);
    if (gate.kind === "cleared") {
      return this.resolve(incident, "fault cleared while cooling down; no action was needed");
    }
    if (gate.kind === "blocked") {
      return this.escalate(incident, `circuit breaker open: ${gate.reason}, human needed`);
    }

    await this.transition(incident, "verifying", `${plan.candidates.length} candidate fix(es) for ${plan.failure}`);

    for (const candidate of plan.candidates) {
      const attempt = await this.deps.verify(incident, candidate);
      await this.deps.saveAttempt(attempt);
      await this.deps.audit("shadow.verdict", incident, {
        attemptId: attempt.id,
        candidate: candidate.id,
        verdict: attempt.verdict,
        reasons: attempt.reasons,
        note: `${candidate.label}: ${attempt.verdict}`,
      });

      if (attempt.verdict !== "promote") {
        attempt.status = "rejected";
        await this.deps.saveAttempt(attempt);
        continue;
      }
      if (!candidate.productionAllowed) {
        attempt.status = "rejected";
        attempt.reasons = [...attempt.reasons, "not allowed in production"];
        await this.deps.saveAttempt(attempt);
        continue;
      }

      if (candidate.risk !== "low") {
        const decision = await this.awaitApproval(incident, attempt);
        if (decision === "timed_out") {
          return this.escalate(incident, `approval for ${candidate.label} timed out`);
        }
        if (decision === "declined") {
          continue;
        }
      }

      if (!(await this.waitForCapacity(incident))) {
        return this.escalate(incident, "action cap reached and no capacity became available");
      }

      const preState = await this.deps.captureState(service);
      this.deps.cap.record();
      this.deps.guard.recordAction(service, failure);
      attempt.status = "applied";
      await this.deps.saveAttempt(attempt);
      await this.transition(incident, "promoting", candidate.label);
      const downtimeMs = (await this.deps.applyToProduction(incident, candidate)) ?? 0;
      await this.deps.audit("action.applied", incident, {
        attemptId: attempt.id,
        candidate: candidate.id,
        downtimeMs,
        note: `applied ${candidate.label}`,
      });

      await this.transition(incident, "watching", `watching production after ${candidate.label}`);
      const result = await this.deps.watch(service, attempt.baseline);
      await this.recordImpact(incident, attempt, service, downtimeMs);
      if (result === "ok") {
        attempt.status = "kept";
        await this.deps.saveAttempt(attempt);
        this.deps.guard.recordResolution(service, { incidentId: incident.id, attemptId: attempt.id, failure });
        return this.resolve(incident, `fixed by ${candidate.label}`);
      }

      if (preState) {
        await this.deps.restoreState(service, preState);
      }
      attempt.status = "rolled_back";
      await this.deps.saveAttempt(attempt);
      await this.deps.audit("action.rolled_back", incident, {
        attemptId: attempt.id,
        candidate: candidate.id,
        note: `rolled back ${candidate.label}`,
      });
      return this.escalate(incident, `${candidate.label} made production worse; rolled back, human needed`);
    }

    return this.escalate(incident, "no candidate fix was verified, human needed");
  }

  // Production before vs after, so every automatic action is on record as helped, no effect or hurt.
  private async recordImpact(
    incident: Incident,
    attempt: Attempt,
    service: ServiceName,
    downtimeMs: number,
  ): Promise<void> {
    const after = await this.deps.readWindow(service);
    const assessment = assessImpact(attempt.baseline, after, downtimeMs, this.deps.impactRules);
    attempt.prodAfter = after;
    attempt.actionDowntimeMs = downtimeMs;
    attempt.impact = assessment.impact;
    attempt.impactReasons = assessment.reasons;
    await this.deps.saveAttempt(attempt);
    await this.deps.audit("action.impact", incident, {
      attemptId: attempt.id,
      impact: assessment.impact,
      before: attempt.baseline,
      after,
      downtimeMs,
      note: `${attempt.label}: ${assessment.impact.replace(/_/g, " ")} (${assessment.reasons.join("; ")})`,
    });
  }

  // The same failure is back on a service we "fixed" moments ago: link the incidents and
  // downgrade the earlier fix to temporary, so the record does not overstate what it did.
  private async linkRecurrence(incident: Incident, service: ServiceName, failure: FailureType): Promise<void> {
    const previous = this.deps.guard.lastResolution(service, failure);
    if (!previous || previous.incidentId === incident.id) return;
    const seconds = Math.max(0, Math.round((this.deps.now().getTime() - previous.at) / 1000));
    incident.recurrenceOf = previous.incidentId;
    incident.recurrenceCount = previous.count;
    const reason = `${failure.replace(/_/g, " ")} returned on ${service} ${seconds} s later (incident ${incident.id.slice(0, 8)}); the fix only masked it`;
    await this.deps.reviseAttempt(previous.attemptId, { impact: "temporary", impactReasons: [reason] });
    await this.deps.audit("action.impact_revised", incident, {
      attemptId: previous.attemptId,
      previousIncidentId: previous.incidentId,
      impact: "temporary",
      recurrence: previous.count,
      note: reason,
    });
    await this.deps.persist(incident);
  }

  private async passGuard(
    incident: Incident,
    service: ServiceName,
    failure: FailureType,
  ): Promise<{ kind: "ok" } | { kind: "cleared" } | { kind: "blocked"; reason: string }> {
    let decision = this.deps.guard.check(service, failure);
    if (decision.allowed) return { kind: "ok" };

    if (decision.kind === "cooldown") {
      await this.deps.audit("action.suppressed", incident, {
        service,
        guard: "cooldown",
        waitMs: decision.waitMs,
        note: decision.reason,
      });
      await this.transition(incident, "suppressed", decision.reason);
      while (!decision.allowed && decision.kind === "cooldown") {
        await this.deps.sleep(this.deps.capacityPollMs);
        decision = this.deps.guard.check(service, failure);
      }
      if (decision.allowed) {
        // Waiting out the cooldown is often enough: a blip that heals itself needs no restart.
        return this.deps.stillFailing(service) ? { kind: "ok" } : { kind: "cleared" };
      }
    }

    await this.deps.audit("action.suppressed", incident, { service, guard: "breaker", note: decision.reason });
    if (incident.state !== "suppressed") {
      await this.transition(incident, "suppressed", decision.reason);
    }
    return { kind: "blocked", reason: decision.reason };
  }

  private async awaitApproval(
    incident: Incident,
    attempt: Attempt,
  ): Promise<"approved" | "declined" | "timed_out"> {
    attempt.status = "awaiting_approval";
    await this.deps.saveAttempt(attempt);
    incident.pendingApprovalId = attempt.id;
    await this.transition(incident, "awaiting_approval", `${attempt.label} needs approval`);

    const decision = await this.deps.approvals.request(attempt.id);
    incident.pendingApprovalId = null;

    const outcome = decision === "approve" ? "approved" : decision === "reject" ? "declined" : "timed_out";
    attempt.status = outcome === "approved" ? "approved" : outcome === "declined" ? "declined" : "timed_out";
    await this.deps.saveAttempt(attempt);
    await this.deps.audit("approval.decided", incident, {
      attemptId: attempt.id,
      decision,
      note: `${attempt.label}: ${decision}`,
    });
    return outcome;
  }

  private async waitForCapacity(incident: Incident): Promise<boolean> {
    if (this.deps.cap.available()) return true;
    await this.transition(incident, "rate_limited", "action cap reached, waiting for capacity");
    let waited = 0;
    while (!this.deps.cap.available()) {
      if (waited >= this.deps.capacityWaitMs) return false;
      await this.deps.sleep(this.deps.capacityPollMs);
      waited += this.deps.capacityPollMs;
    }
    return true;
  }

  private async transition(incident: Incident, state: IncidentState, note: string): Promise<void> {
    incident.state = state;
    incident.stateHistory.push({ state, at: this.deps.now().toISOString() });
    await this.deps.audit(`incident.${state}`, incident, { note });
    await this.deps.persist(incident);
  }

  private async resolve(incident: Incident, outcome: string): Promise<void> {
    await this.finish(incident, "resolved", outcome);
  }

  private async escalate(incident: Incident, outcome: string): Promise<void> {
    await this.finish(incident, "escalated", `escalated: ${outcome}`);
  }

  private async finish(incident: Incident, state: IncidentState, outcome: string): Promise<void> {
    const at = this.deps.now().toISOString();
    incident.state = state;
    incident.outcome = outcome;
    incident.closedAt = at;
    incident.pendingApprovalId = null;
    incident.stateHistory.push({ state, at });
    await this.deps.audit(`incident.${state}`, incident, { note: outcome, outcome });
    await this.deps.persist(incident);
  }
}
