export const SERVICE_NAMES = ["orders", "payments", "inventory"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const SERVICE_PORTS: Record<ServiceName, number> = {
  orders: 4001,
  payments: 4002,
  inventory: 4003,
};

export const SERVICE_DEPENDENCIES: Record<ServiceName, readonly ServiceName[]> = {
  orders: ["payments", "inventory"],
  payments: [],
  inventory: [],
};

export const FAULT_TYPES = ["crash", "slow", "memory_leak", "bad_config"] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

export interface ServiceMetrics {
  windowSeconds: number;
  requests: number;
  errors: number;
  errorRate: number;
  p95LatencyMs: number;
  memoryMb: number;
}

export interface ServiceStatus {
  name: ServiceName;
  pid: number;
  startedAt: string;
  activeFault: FaultType | null;
  config: { mode: "ok" | "corrupt" };
  healthy: boolean;
  metrics: ServiceMetrics;
  totals: { requests: number; errors: number };
}

export interface ServiceRecord {
  name: ServiceName;
  port: number;
  dependencies: ServiceName[];
  allowedFixTypes: string[];
}

export const ANOMALY_KINDS = ["unreachable", "unhealthy", "error_rate", "latency", "memory"] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export interface Anomaly {
  service: ServiceName;
  kind: AnomalyKind;
  value: number;
  threshold: number;
  since: string;
}

export type FailureType = "crash" | "slow" | "memory_leak" | "bad_config";

export interface Snapshot {
  service: ServiceName;
  at: string;
  reachable: boolean;
  healthy: boolean;
  errorRate: number;
  p95LatencyMs: number;
  memoryMb: number;
  requests: number;
  activeFault: FaultType | null;
  configMode: "ok" | "corrupt" | "unknown";
}

export type IncidentState =
  | "detected"
  | "diagnosed"
  | "verifying"
  | "awaiting_approval"
  | "rate_limited"
  | "promoting"
  | "watching"
  | "resolved"
  | "escalated";

export interface RankedCause {
  service: ServiceName;
  explainedBy: ServiceName | null;
  reason: string;
}

export interface Incident {
  id: string;
  state: IncidentState;
  rootCause: ServiceName | null;
  symptoms: ServiceName[];
  causes: RankedCause[];
  anomalies: Anomaly[];
  failure: FailureType | null;
  pendingApprovalId: string | null;
  stateHistory: { state: IncidentState; at: string }[];
  openedAt: string;
  closedAt: string | null;
  outcome: string | null;
}

export type Risk = "low" | "medium" | "high";

export interface WindowMetrics {
  requests: number;
  errorRate: number;
  p95LatencyMs: number;
}

export type AttemptStatus =
  | "rejected"
  | "verified"
  | "awaiting_approval"
  | "approved"
  | "declined"
  | "timed_out"
  | "applied"
  | "kept"
  | "rolled_back";

export interface Attempt {
  id: string;
  incidentId: string;
  candidate: string;
  label: string;
  risk: Risk;
  verdict: "promote" | "reject" | "insufficient evidence";
  reasons: string[];
  baseline: WindowMetrics;
  candidateMetrics: WindowMetrics;
  sampleSize: number;
  status: AttemptStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface Receipt {
  incidentId: string;
  text: string;
  draftText: string;
  wordedBy: string;
  facts: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  trigger: string;
  incidentId: string | null;
  details: Record<string, unknown>;
}
