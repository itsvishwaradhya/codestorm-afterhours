import type {
  Attempt,
  AuditEntry,
  FaultType,
  GrayFault,
  Impact,
  Incident,
  Receipt,
  ServiceName,
  ServiceRecord,
  Snapshot,
} from "@nightshift/shared";

export interface LogLine {
  service: ServiceName;
  stream: "stdout" | "stderr" | "supervisor";
  line: string;
  at: string;
}

export interface WorkspaceFile {
  path: string;
  size: number;
}

export interface CapStatus {
  used: number;
  max: number;
  windowMinutes: number;
  remaining: number;
}

export interface GuardStatus {
  service: string;
  cooldownRemainingMs: number;
  breaker: "closed" | "open" | "half_open";
  breakerRemainingMs: number;
  breakerReason: string | null;
  recentActions: number;
}

export interface ImpactSummary {
  counts: Record<Impact, number>;
  recent: Attempt[];
}

export interface HealthState {
  services: ServiceRecord[];
  snapshots: Snapshot[];
  activeIncident: Incident | null;
  pendingApprovals: string[];
  cap: CapStatus;
  guard: GuardStatus[];
}

export interface HealTiming {
  firstBadAt: string;
  detectSeconds: number;
  fixLiveSeconds: number | null;
  confirmedSeconds: number | null;
  humanWaitSeconds: number;
  phases: { state: Incident["state"]; seconds: number }[];
}

export interface Scorecard {
  symptomRestartsAvoided: number;
  unprovenFixesBlocked: number;
  riskyFixesHeld: number;
  restartStormsStopped: number;
  badFixesRolledBack: number;
  timeToFix: {
    count: number;
    medianSeconds: number | null;
    fastestSeconds: number | null;
    lastSeconds: number | null;
  };
}

export type IncidentDetail = Incident & { attempts: Attempt[]; timing: HealTiming };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  state: () => request<HealthState>("GET", "/api/state"),
  incidents: () => request<Incident[]>("GET", "/api/incidents"),
  incident: (id: string) => request<IncidentDetail>("GET", `/api/incidents/${id}`),
  audit: () => request<AuditEntry[]>("GET", "/api/audit"),
  impact: () => request<ImpactSummary>("GET", "/api/impact"),
  scorecard: () => request<Scorecard>("GET", "/api/scorecard"),
  resetGuard: (service: string) => request("POST", `/api/guard/${service}/reset`),
  receipt: async (incidentId: string): Promise<Receipt | null> => {
    const response = await fetch(`/api/receipts/${incidentId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`receipt request failed with ${response.status}`);
    return (await response.json()) as Receipt;
  },
  chaos: (service: string, fault: FaultType | null, gray?: Partial<GrayFault>) =>
    request("POST", "/api/chaos", { service, fault, ...gray }),
  decide: (attemptId: string, decision: "approve" | "reject") =>
    request("POST", `/api/approvals/${attemptId}`, { decision }),
  logs: () => request<LogLine[]>("GET", "/api/logs"),
  workspaceTree: () => request<WorkspaceFile[]>("GET", "/api/workspace/tree"),
  workspaceFile: (path: string) =>
    request<{ path: string; content: string }>("GET", `/api/workspace/file?path=${encodeURIComponent(path)}`),
};
