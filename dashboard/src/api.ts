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
  dir?: boolean;
}

export interface AppLog {
  source: "app" | "shell" | "clone" | "nightshift";
  line: string;
  stream: "stdout" | "stderr" | "system";
  at: string;
}

export interface AppWindow {
  requests: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  reachable: boolean;
}

export interface AppIncident {
  id: string;
  phase: "detected" | "verifying" | "promoting" | "watching" | "resolved" | "escalated";
  openedAt: string;
  closedAt: string | null;
  trigger: AppWindow;
  changedFiles: string[];
  injection: AppInjection | null;
  candidates: {
    id: "restart" | "rollback";
    label: string;
    verdict: "promote" | "reject";
    requests: number;
    errorRate: number;
    p95Ms: number;
  }[];
  outcome: string | null;
  receipt: string | null;
}

export interface AppState {
  running: boolean;
  command: string | null;
  pid: number | null;
  proxyPort: number;
  routes: string[];
  health: AppWindow;
  incident: AppIncident | null;
  hasSnapshot: boolean;
}

export type BugKind = "null_deref" | "bad_parse" | "error_response" | "intermittent" | "process_crash";

export interface AppInjection {
  file: string;
  route: string;
  kind: BugKind | null;
  description: string;
  injectedBy: string;
}

export interface InjectOptions {
  targets: { file: string; route: string }[];
  kinds: { id: BugKind; label: string; effect: string }[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AppResponse {
  status: number;
  ms: number;
  contentType: string | null;
  body: string;
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
  app: {
    reset: () => request("POST", "/api/app/reset"),
    upload: (path: string, content: string) => request("POST", "/api/app/files", { path, content }),
    uploaded: () => request<WorkspaceFile[]>("POST", "/api/app/uploaded"),
    tree: () => request<WorkspaceFile[]>("GET", "/api/app/tree"),
    file: (path: string) => request<{ path: string; content: string }>("GET", `/api/app/file?path=${encodeURIComponent(path)}`),
    exec: (command: string) => request("POST", "/api/app/exec", { command }),
    save: (path: string, content: string) => request("POST", "/api/app/files", { path, content }),
    mkdir: (path: string) => request<WorkspaceFile[]>("POST", "/api/app/mkdir", { path }),
    remove: (path: string) => request<WorkspaceFile[]>("POST", "/api/app/delete", { path }),
    rename: (from: string, to: string) => request<WorkspaceFile[]>("POST", "/api/app/rename", { from, to }),
    stop: () => request("POST", "/api/app/stop"),
    injectOptions: () => request<InjectOptions>("GET", "/api/app/inject-options"),
    inject: (choice: { route?: string; kind?: BugKind } = {}) => request<AppInjection | null>("POST", "/api/app/inject", choice),
    state: () => request<AppState>("GET", "/api/app/state"),
    goodFile: (path: string) =>
      request<{ path: string; content: string }>("GET", `/api/app/good-file?path=${encodeURIComponent(path)}`),
    request: (method: HttpMethod, path: string, body?: string) =>
      request<AppResponse>("POST", "/api/app/request", { method, path, body: body || undefined }),
    downloadUrl: "/api/app/download",
  },
};
