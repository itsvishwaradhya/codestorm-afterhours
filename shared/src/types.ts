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
}
