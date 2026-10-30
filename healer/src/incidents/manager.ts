import { randomUUID } from "node:crypto";
import type { Anomaly, AuditEntry, Incident, ServiceName } from "@nightshift/shared";
import { config } from "../config.js";
import { diagnose } from "../diagnose/graph.js";
import { isTerminal } from "../remediate/remediator.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

export interface IncidentManagerOptions {
  persist: (incident: Incident) => Promise<void>;
  audit: (entry: AuditInput) => Promise<void>;
  dependencies: () => Record<ServiceName, ServiceName[]>;
  startRemediation: (incident: Incident) => void;
  isRemediating: () => boolean;
}

export class IncidentManager {
  private active: Incident | null = null;
  private clearTicks = 0;
  private stableTicks = 0;
  private remediationStarted = false;

  constructor(private readonly options: IncidentManagerOptions) {}

  current(): Incident | null {
    return this.active;
  }

  reset(): void {
    this.active = null;
    this.clearTicks = 0;
    this.stableTicks = 0;
    this.remediationStarted = false;
  }

  async observe(anomalies: Anomaly[], now: Date): Promise<void> {
    const at = now.toISOString();

    if (anomalies.length === 0) {
      await this.onClear(at);
      return;
    }

    this.clearTicks = 0;
    if (this.active && isTerminal(this.active.state)) return;

    if (!this.active) {
      this.active = {
        id: randomUUID(),
        state: "detected",
        rootCause: null,
        symptoms: [],
        causes: [],
        anomalies: [],
        failure: null,
        pendingApprovalId: null,
        stateHistory: [{ state: "detected", at }],
        openedAt: at,
        closedAt: null,
        outcome: null,
      };
      this.stableTicks = 0;
      this.remediationStarted = false;
      await this.options.audit({
        actor: "healer",
        action: "incident.detected",
        trigger: anomalies.map((anomaly) => `${anomaly.service}:${anomaly.kind}`).join(", "),
        incidentId: this.active.id,
        details: {},
      });
    }

    const incident = this.active;
    const diagnosis = diagnose(anomalies, this.options.dependencies());
    if (!this.remediationStarted) {
      incident.anomalies = anomalies;
    }

    if (incident.state === "detected") {
      incident.state = "diagnosed";
      incident.stateHistory.push({ state: "diagnosed", at });
      this.applyDiagnosis(incident, diagnosis);
      this.stableTicks = 1;
      await this.options.audit({
        actor: "healer",
        action: "incident.diagnosed",
        trigger: `root cause: ${diagnosis.rootCause}`,
        incidentId: incident.id,
        details: { rootCause: diagnosis.rootCause, symptoms: diagnosis.symptoms },
      });
    } else if (incident.state === "diagnosed" && !this.remediationStarted) {
      if (diagnosis.rootCause === incident.rootCause) {
        this.stableTicks += 1;
      } else {
        this.stableTicks = 1;
        this.applyDiagnosis(incident, diagnosis);
      }
    }

    await this.options.persist(incident);

    if (incident.state === "diagnosed" && !this.remediationStarted && this.stableTicks >= config.diagnosisStableTicks) {
      this.remediationStarted = true;
      this.options.startRemediation(incident);
    }
  }

  private applyDiagnosis(
    incident: Incident,
    diagnosis: { rootCause: ServiceName | null; symptoms: ServiceName[]; causes: Incident["causes"] },
  ): void {
    incident.rootCause = diagnosis.rootCause;
    incident.symptoms = diagnosis.symptoms;
    incident.causes = diagnosis.causes;
  }

  private async onClear(at: string): Promise<void> {
    if (!this.active) return;
    this.clearTicks += 1;
    if (this.clearTicks < config.clearTicksToClose) return;

    const incident = this.active;
    if (isTerminal(incident.state)) {
      this.active = null;
      this.clearTicks = 0;
      return;
    }
    if (this.options.isRemediating()) return;

    incident.state = "resolved";
    incident.closedAt = at;
    incident.outcome = "anomalies cleared without remediation";
    incident.stateHistory.push({ state: "resolved", at });
    await this.options.persist(incident);
    await this.options.audit({
      actor: "healer",
      action: "incident.resolved",
      trigger: "anomalies cleared",
      incidentId: incident.id,
      details: { outcome: incident.outcome },
    });
    this.active = null;
    this.clearTicks = 0;
  }
}
