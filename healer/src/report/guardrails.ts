import type { Attempt, AttemptStatus, AuditEntry, Incident } from "@nightshift/shared";
import { healTiming } from "./timing.js";

export interface TimeToFix {
  count: number;
  medianSeconds: number | null;
  fastestSeconds: number | null;
  lastSeconds: number | null;
}

// What a blind "restart whatever is alerting" policy would have done that NightShift did not.
// Every count comes from recorded incidents, attempts and audit entries; nothing is estimated.
export interface GuardrailSavings {
  symptomRestartsAvoided: number;
  unprovenFixesBlocked: number;
  riskyFixesHeld: number;
  restartStormsStopped: number;
  badFixesRolledBack: number;
  timeToFix: TimeToFix;
}

export interface GuardrailInput {
  incidents: Incident[];
  attempts: Attempt[];
  suppressed: AuditEntry[];
}

const BEFORE_APPROVAL_GATE: AttemptStatus[] = ["rejected", "verified"];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

export function guardrailSavings({ incidents, attempts, suppressed }: GuardrailInput): GuardrailSavings {
  const healed = incidents
    .filter((incident) => incident.state === "resolved")
    .map((incident) => ({ openedAt: incident.openedAt, seconds: healTiming(incident).fixLiveSeconds }))
    .filter((entry): entry is { openedAt: string; seconds: number } => entry.seconds !== null)
    .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const seconds = healed.map((entry) => entry.seconds);

  return {
    symptomRestartsAvoided: incidents
      .filter((incident) => incident.rootCause !== null)
      .reduce((total, incident) => total + incident.symptoms.length, 0),
    unprovenFixesBlocked: attempts.filter((attempt) => attempt.status === "rejected").length,
    riskyFixesHeld: attempts.filter(
      (attempt) => attempt.risk !== "low" && !BEFORE_APPROVAL_GATE.includes(attempt.status),
    ).length,
    restartStormsStopped: new Set(
      suppressed.map((entry) => entry.incidentId).filter((id): id is string => id !== null),
    ).size,
    badFixesRolledBack: attempts.filter((attempt) => attempt.status === "rolled_back").length,
    timeToFix: {
      count: seconds.length,
      medianSeconds: median(seconds),
      fastestSeconds: seconds.length > 0 ? Math.min(...seconds) : null,
      lastSeconds: seconds.length > 0 ? seconds[seconds.length - 1] : null,
    },
  };
}
