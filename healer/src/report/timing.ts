import type { Incident, IncidentState } from "@nightshift/shared";

export interface HealPhase {
  state: IncidentState;
  seconds: number;
}

export interface HealTiming {
  firstBadAt: string;
  detectSeconds: number;
  fixLiveSeconds: number | null;
  confirmedSeconds: number | null;
  humanWaitSeconds: number;
  phases: HealPhase[];
}

const TERMINAL: IncidentState[] = ["resolved", "escalated"];

function secondsBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 100) / 10);
}

// Measured from the first bad sample the detector saw, not from the fault itself: the
// healer cannot know when a fault started before its first symptom.
export function healTiming(incident: Incident): HealTiming {
  const sinces = incident.anomalies.map((anomaly) => anomaly.since).filter((since) => !Number.isNaN(Date.parse(since)));
  const firstBadAt = [incident.openedAt, ...sinces].reduce((earliest, at) =>
    Date.parse(at) < Date.parse(earliest) ? at : earliest,
  );

  const history = incident.stateHistory;
  const phases: HealPhase[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (TERMINAL.includes(entry.state)) break;
    const end = history[index + 1]?.at ?? incident.closedAt;
    if (!end) break;
    phases.push({ state: entry.state, seconds: secondsBetween(entry.at, end) });
  }

  const watching = history.find((entry) => entry.state === "watching");
  const humanWait = phases
    .filter((phase) => phase.state === "awaiting_approval")
    .reduce((total, phase) => total + phase.seconds, 0);

  return {
    firstBadAt,
    detectSeconds: secondsBetween(firstBadAt, incident.openedAt),
    fixLiveSeconds: watching ? secondsBetween(firstBadAt, watching.at) : null,
    confirmedSeconds: incident.closedAt ? secondsBetween(firstBadAt, incident.closedAt) : null,
    humanWaitSeconds: Math.round(humanWait * 10) / 10,
    phases,
  };
}
