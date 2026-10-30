import type {
  Attempt,
  AuditEntry,
  FaultType,
  Incident,
  Receipt,
  ServiceRecord,
  Snapshot,
} from "@nightshift/shared";

export interface CapStatus {
  used: number;
  max: number;
  windowMinutes: number;
  remaining: number;
}

export interface HealthState {
  services: ServiceRecord[];
  snapshots: Snapshot[];
  activeIncident: Incident | null;
  pendingApprovals: string[];
  cap: CapStatus;
}

export type IncidentDetail = Incident & { attempts: Attempt[] };

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
  receipt: async (incidentId: string): Promise<Receipt | null> => {
    const response = await fetch(`/api/receipts/${incidentId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`receipt request failed with ${response.status}`);
    return (await response.json()) as Receipt;
  },
  chaos: (service: string, fault: FaultType | null) => request("POST", "/api/chaos", { service, fault }),
  decide: (attemptId: string, decision: "approve" | "reject") =>
    request("POST", `/api/approvals/${attemptId}`, { decision }),
};
