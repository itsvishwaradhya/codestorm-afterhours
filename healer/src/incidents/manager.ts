import { randomUUID } from "node:crypto";
import type { Anomaly, AuditEntry, Incident, ServiceName } from "@nightshift/shared";
import { config } from "../config.js";
import { diagnose } from "../diagnose/graph.js";

type AuditInput = Omit<AuditEntry, "id" | "at">;

export interface IncidentManagerOptions {
  saveIncident: (incident: Incident) => Promise<void>;
  audit: (entry: AuditInput) => Promise<void>;
  publish: (channel: string, payload: unknown) => void;
  dependencies: () => Record<ServiceName, ServiceName[]>;
}

export class IncidentManager {
  private active: Incident | null = null;
  private clearTicks = 0;

  constructor(private readonly options: IncidentManagerOptions) {}

  current(): Incident | null {
    return this.active;
  }

  async observe(anomalies: Anomaly[], now: Date): Promise<void> {
    const at = now.toISOString();

    if (anomalies.length === 0) {
      if (this.active) {
        this.clearTicks += 1;
        if (this.clearTicks >= config.clearTicksToClose) {
          await this.close(at);
        }
      }
      return;
    }

    this.clearTicks = 0;
    if (!this.active) {
      this.active = {
        id: randomUUID(),
        state: "detected",
        rootCause: null,
        symptoms: [],
        causes: [],
        anomalies: [],
        stateHistory: [{ state: "detected", at }],
        openedAt: at,
        closedAt: null,
        outcome: null,
      };
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
    incident.anomalies = anomalies;
    incident.rootCause = diagnosis.rootCause;
    incident.symptoms = diagnosis.symptoms;
    incident.causes = diagnosis.causes;

    if (incident.state === "detected") {
      incident.state = "diagnosed";
      incident.stateHistory.push({ state: "diagnosed", at });
      await this.options.audit({
        actor: "healer",
        action: "incident.diagnosed",
        trigger: `root cause: ${diagnosis.rootCause}`,
        incidentId: incident.id,
        details: { rootCause: diagnosis.rootCause, symptoms: diagnosis.symptoms },
      });
    }

    await this.persist(incident);
  }

  private async close(at: string): Promise<void> {
    const incident = this.active;
    if (!incident) return;
    incident.state = "closed";
    incident.closedAt = at;
    incident.outcome = "anomalies cleared without remediation";
    incident.stateHistory.push({ state: "closed", at });
    await this.persist(incident);
    await this.options.audit({
      actor: "healer",
      action: "incident.closed",
      trigger: "anomalies cleared",
      incidentId: incident.id,
      details: { outcome: incident.outcome },
    });
    this.active = null;
    this.clearTicks = 0;
  }

  private async persist(incident: Incident): Promise<void> {
    await this.options.saveIncident(incident);
    this.options.publish("incident", incident);
  }
}
