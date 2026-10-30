import type { Attempt, FailureType, Incident, IncidentState, ServiceName } from "@nightshift/shared";
import type { FixCandidate } from "../fix/catalog.js";
import type { ProductionState } from "../fix/steps.js";
import type { ApprovalGate } from "./approvals.js";
import type { ActionCap } from "./cap.js";

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
  applyToProduction: (incident: Incident, candidate: FixCandidate) => Promise<void>;
  watch: (service: ServiceName, preFixErrorRate: number) => Promise<"ok" | "regressed">;
  approvals: ApprovalGate;
  cap: ActionCap;
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
    incident.failure = plan.failure;
    if (!plan.failure) {
      return this.escalate(incident, "failure type not recognized, human needed");
    }
    if (plan.candidates.length === 0) {
      return this.escalate(incident, `no allowed fix for ${plan.failure}, human needed`);
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
      attempt.status = "applied";
      await this.deps.saveAttempt(attempt);
      await this.transition(incident, "promoting", candidate.label);
      await this.deps.applyToProduction(incident, candidate);
      await this.deps.audit("action.applied", incident, {
        attemptId: attempt.id,
        candidate: candidate.id,
        note: `applied ${candidate.label}`,
      });

      await this.transition(incident, "watching", `watching production after ${candidate.label}`);
      const result = await this.deps.watch(service, attempt.baseline.errorRate);
      if (result === "ok") {
        attempt.status = "kept";
        await this.deps.saveAttempt(attempt);
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
